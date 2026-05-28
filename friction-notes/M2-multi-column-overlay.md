# M2 — Multi-column overlay

**Date:** 2026-05-27
**pond-ts version:** post-#162 (column-API steps 8a–8d +
`col.bin(W, reducer, { out })` from #161 + inline bin minMax walk
from #162), installed locally from `file:../pond/packages/core`.

## Milestones in this note

- **M2.0** — initial three-line overlay. Surfaced MF1–MF4.
- **M2.1** — adopted `col.bin(W, 'minMax', { out })` from pond-ts
  #161 after MF2's allocation-churn finding. Re-benched. The
  measured win was smaller than the original MF2 projection
  (2–7% rather than "most of the 2× gap"); honest re-bench
  reframed MF2 around the real hot path.
- **M2.2** — derived shared Y extent from the bin's `{lo, hi}`
  output instead of three separate `slice.minMax()` walks. **The
  load-bearing chart-side win**: replaces three O(N) walks with
  three O(W) post-passes over `Float64Array(1024)`. Combined with
  the pond-ts #162 substrate optimization, the chart now sustains
  60fps at N=10M with three lines — measured 16.6 ms at the data
  layer, comfortably under the 16.67 ms budget.

## Workload

Three numeric columns (`cpu` / `mem` / `io`) sharing one time key,
synthetic system-load percentages. Three differently-colored lines
on one canvas with a **shared Y axis**, pan + zoom, hover readout
showing the timestamp + values for all three columns at the
cursor.

The headline question per
[CLAUDE.md](https://github.com/pjm17971/pond-ts-charts-experiment/blob/main/CLAUDE.md):
"does the substrate's alignment-by-construction (all columns
indexed by the same key) actually buy the chart adapter what it
needs?"

Source: `src/charts/M2MultiColumnChart.tsx`.

Run:

```bash
npm run dev     # interactive chart
node scripts/bench-M2.mjs   # Node-side per-frame bench
```

## What worked

- **Schema-narrowed `column(name)` × 3 is clean.** The chart
  iterates a `COLUMNS` config array and calls
  `series.column(cfg.name)` for each; each return value is
  `Float64Column | ChunkedFloat64Column` typed-narrowed by the
  schema. No instanceof, no kind check, no undefined check. The
  N=3 pattern is just three N=1 calls and the boilerplate
  scales linearly with how many columns you have (which is what
  the CLAUDE.md asked about).

- **Alignment-by-construction _does_ buy the shared X axis for
  free.** All three columns return slices with the same length
  for the same `[startIdx, endIdx)` window — by substrate
  invariant. The chart never needs to align indices across
  columns; `bisect` once, slice each column with the result, the
  X axis is shared. The render loop iterates rows in lockstep
  across columns trivially.

- **`keys.at(idx)` for hover is column-API-clean.** Step 8d
  closed M1.2's NF4; the hover useMemo reads the timestamp via
  `seriesData.keys.at(idx)` the same shape it reads each value
  via `seriesData.valueCols[c].at(idx)`. The chart adapter's
  `(col, idx) => value` mental model holds across both axes and
  all columns.

- **The slice + bin + minMax chain composes cleanly per
  column.** Each line's render loop is the M1.1 idiom with the
  column name swapped in:

  ```ts
  const slice = col.slice(startIdx, endIdx);
  const { lo, hi } = slice.bin(cssWidth, 'minMax');
  // ... canvas draw with lo[px] / hi[px]
  ```

  The chart just runs this three times in a `for` loop. The
  per-column pattern is identical to M1's single-column pattern;
  the chart adapter's mental model didn't have to grow.

## Friction

### MF1. Shared Y extent across columns is hand-rolled

The chart wants ONE Y scale shared across all three lines (the
natural "three lines on one chart" pattern). pond-ts gives us
`col.minMax()` per column — the chart adapter assembles its own
shared extent:

```ts
let yMin = Infinity;
let yMax = -Infinity;
for (const slice of slices) {
  const extent = slice.minMax();
  if (!extent) continue;
  if (extent[0] < yMin) yMin = extent[0];
  if (extent[1] > yMax) yMax = extent[1];
}
```

Three method calls (each walks the slice's buffer + dispatches
through the reducer) plus an O(N=cols) reduction. The chart code
is six lines; not catastrophic, but it's **the second time a
shared-axis assembly shows up** (the first being M1's Y extent
loop before `minMax()` shipped). A chart library that wraps
pond-ts will write this helper on day one.

Library-actionable: `series.multiMinMax(cols: string[]): [number,
number] | undefined` — one cross-column walk producing the shared
extent. Same shape question as MF2 / MF3 below — they cluster
around "the chart wants cross-column primitives, the library gives
per-column primitives."

### MF2. Three `bin('minMax')` calls per frame — **partially closed; surfaces a different hot path**

**M2.0 (original):** The render loop runs `slice.bin(cssWidth,
'minMax')` three times. Each call allocates a fresh `{ lo, hi }`
pair. At W=1024 and 60fps, that's 6 × 8KB Float64Arrays per
frame = ~3MB/sec of allocation churn. The bench measured ~2×
overhead vs a fused lower bound, with the friction note
projecting that retiring the allocation alone would close most
of the gap.

**M2.1 (pond-ts #161 shipped + chart adopted):** `col.bin(W,
reducer, { out })` lets the chart pre-allocate per-column
`{ lo, hi }` buffers once and reuse them every frame. The
chart-experiment commit adopted the option immediately.

**Honest re-bench:**

| Workload (full-window) | M2.0 columnar | M2.1 columnar+out | fused | out's win |
| --- | ---: | ---: | ---: | ---: |
| N=100k | 0.522 ms | 0.490 ms | 0.237 ms | -6% |
| N=1M | 3.673 ms | 3.617 ms | 1.882 ms | -2% |
| N=10M | 35.3 ms | 32.6 ms | 17.8 ms | -7% |

The win is **real but small** — 2-7%, not the "most of the 2×
gap" the original MF2 projection implied. The pre-allocated
output buffer retires the allocation churn it was supposed to
retire; the friction note's own intuition about how much of the
total cost was driven by that allocation was wrong.

**Where the rest of the gap actually lives.** Looking at
pond-ts's `bin()` impl: each call's inner loop runs `bins` (W=1024)
iterations, and each iteration does `sliceByRange` (allocates a
Float64Column view) + `reduceColumn` (dispatch through
`resolveReducer`). So one `bin(1024, 'minMax')` call really
allocates ~1024 view objects internally, not 2 typed arrays. For
3 columns at 60fps that's ~180k internal allocations/sec —
dwarfing the 6 typed-array allocations that `{ out }` retired.

This is **substrate-level**, not API-level. The right
optimization is an inlined per-bin walk inside `bin()` that
operates directly on the underlying buffer + offsets without
constructing intermediate view objects. The public API
(`col.bin(W, reducer)`) is unchanged.

**Library-actionable (updated post-bench):**

- **Inline `bin()`'s per-bin walk in pond-ts** — skip the per-bin
  `sliceByRange` + reducer-dispatch construction. Operate
  directly on `(this.values, start, end)` inline. Substrate-only
  change, no API surface change. Likely closes most of the
  remaining ~2× gap. This is the load-bearing optimization the
  M2 bench actually surfaces; the original MF2 framing was
  partial.

**M2.2 finale.** Substrate inline-minMax landed in pond-ts #162;
the chart side then closed MF2 fully by deriving the shared Y
extent from the bin output rather than from three separate
`slice.minMax()` calls. The bin's `{lo, hi}` arrays already
contain the per-pixel min/max of every defined value in the
visible window, so the global Y extent is `min(lo)` and `max(hi)`
across all columns — an O(W) post-pass over `Float64Array(1024)`
per column instead of an O(N) walk over millions of rows. With 3
columns at N=10M that's three 1024-element loops replacing three
10M-element walks: **roughly 10,000× fewer reads** for the Y-
extent computation.

**Status:** Closed. The cumulative wins land the chart's per-frame
data-layer work under the 60fps budget at N=10M:

| Workload | M2.0 columnar | M2.1 +out | M2.2 +out+yfrombins | fused floor |
| --- | ---: | ---: | ---: | ---: |
| N=100k | 0.54 ms | 0.54 ms | **0.32 ms** (-41%) | 0.26 ms |
| N=1M | 3.63 ms | 3.38 ms | **1.79 ms** (-51%) | 2.12 ms |
| N=10M | 32.2 ms | 32.1 ms | **16.6 ms** (-48%) | 17.7 ms |

The chart-side path now **beats** the "fused theoretical floor"
that this note originally projected as the win ceiling — because
that floor was a bench harness's inline JS walk, while pond-ts
#162 inlined the same work into substrate code that V8 specializes
better. Two architecturally-separate optimizations (substrate
`bin` walk + chart-side Y-from-bins) compose multiplicatively for
the headline result.

### MF3. Hover does three `col.at(idx)` calls for one row

The hover readout shows timestamp + three values. The chart code:

```ts
const time = seriesData.keys.at(idx);
const values = seriesData.valueCols.map((col) => col.at(idx));
```

Four constant-time reads. Microsecond-scale per hover. **Not a
perf problem** — but the shape question is the same as MF1 / MF2:
the chart wants "all column values at row `idx`," pond-ts gives
"one column's value at row `idx`."

This is the per-row mirror of the per-frame multi-column friction.
The library-actionable shape would be a row-shaped reader, e.g.
`series.rowAt(idx)` returning the full record. Pond-ts already has
`series.rows[i]` for this — but it's the row-API path (returns the
declared row shape with kind-typed columns), and it allocates one
row object per call. For a 60fps hover that's fine. The shape is
there; the chart just chose to compose per-column reads to stay in
the columnar idiom.

Status: **arguably not friction** — `series.rows[idx]` already
exists and works. Worth a heads-up in the column-API docs that
"per-row reads for tooltips use `series.rows[idx]`; per-column
reads for hot paths use `col.at(idx)`."

### MF4. Per-column storage check × N — **fully retired**

M2.0 had this awkward pattern:

```ts
const valueCols = COLUMNS.map((cfg) => {
  const col = series.column(cfg.name);
  if (col.storage !== 'packed') throw ...
  return col;
});
```

Three columns → three storage checks.

**Status:** Closed by pond-ts PR #165's `col.toFloat64Array()`.
M2's per-column extraction now reads:

```ts
const valueCols = COLUMNS.map((cfg) => series.column(cfg.name));
```

No per-column storage check. Anywhere the chart wants a raw
`Float64Array` (1:1 path, Y-extent walk over slice), it calls
`slice.toFloat64Array()` — storage-agnostic, length-bounded.
Closes MF4 and the chart side of F1 / NF3.

## Bench numbers (Node-side)

`node scripts/bench-M2.mjs`. Median of 30 repeats, 3 warm-up.

Four paths, each layering on the previous:

- **columnar** — M2.0's original render loop. Three `col.slice()`
  + three `col.minMax()` + three `col.bin('minMax')` per frame.
  Per-frame allocates 6 × Float64Array(W) for the bin outputs +
  three view objects from slice + ~3 × W view objects internally
  inside `bin()` (one per bin).
- **+out** — M2.1 (after pond-ts #161). Adds `{ out }`: pre-
  allocated `{ lo, hi }` buffers passed via `col.bin(W, 'minMax',
  { out })`. Retires the 6 typed-array allocations per frame.
- **+out+yfrombins** — M2.2 (this milestone, after pond-ts #162's
  inline minMax walk landed). Drops the three `slice.minMax()`
  calls; derives Y extent from the bin's `{lo, hi}` output. Three
  O(W) post-passes (~1024 reads each) replace three O(N) walks
  (millions of reads each). This is what M2's chart actually runs.
- **fused** — theoretical floor. The bench harness's inline JS
  walk: one pass over each column's raw `Float64Array`, computing
  bin AND Y in the same loop. Pre-allocated outputs, no view
  objects. Used to be the projected ceiling for the chart's win;
  M2.2 now beats it (see the note below the table).

| Workload (full-window) | columnar | +out | +out+yfrombins | fused |
| --- | ---: | ---: | ---: | ---: |
| N=100k | 0.54 ms (+105%) | 0.54 ms (+107%) | **0.32 ms (+21%)** | 0.26 ms |
| N=1M | 3.63 ms (+71%) | 3.38 ms (+59%) | **1.79 ms (-16%)** | 2.12 ms |
| N=10M | 32.2 ms (+82%) | 32.1 ms (+81%) | **16.6 ms (-6%)** | 17.7 ms |

(`+%` is overhead vs the fused floor at that N.)

**yfrombins vs columnar — the M2.2 headline:** -41% (N=100k), -51%
(N=1M), -48% (N=10M). Roughly halves the per-frame work across
all scales. The 1.5×-better-than-fused-floor result at N=1M /
N=10M comes from pond-ts #162's inline-minMax substrate
optimization, which V8 specializes better than the bench
harness's JS-level inline walk.

1%-zoom (any path, no per-pixel downsample needed at N=100k):

| | columnar |
| --- | ---: |
| N=100k | 0.008 ms |
| N=1M | 0.053 ms |
| N=10M | 0.399 ms |

**Frame-budget translation at 60 fps (16.67 ms):**

- **N=10M full-window: M2.2 path 16.6 ms** — comfortably under
  budget, leaving headroom for canvas draw + axis labels. M2.0
  was 2× over budget at 32 ms.
- N=1M full-window: 1.8 ms — 9× headroom. Free.
- All 1%-zoom cases: < 0.5 ms — interactive zoom is essentially
  free at the data layer.

The **M2 outcome after the full friction loop**: composition cost
was real and the headline win came from two architecturally-
distinct changes that compose multiplicatively. Substrate side
(pond-ts #162) tuned the per-bin work; chart side (M2.2) skipped
redundant Y-extent walks by reusing the bin output. The chart now
sustains 60fps at N=10M with three lines — the workload that
motivated the experiment in the first place.

## Validating "alignment-by-construction"

The CLAUDE.md question for M2: does substrate alignment-by-
construction buy the chart adapter what it needs?

**Verdict:** Yes for the X-axis story; partially for the Y-axis
story.

- **X axis (shared key):** Free win. One `bisect` → indices apply
  to every column. One `keyColumn()` access works for all
  columns. The chart never has to align indices across columns,
  and slices stay zero-copy on the shared key buffer (8d's
  trusted-slice). Validates the substrate's identity.

- **Y axis (shared scale):** Mostly the chart's problem. The
  substrate gives per-column reductions; the chart assembles
  cross-column extent itself. The library could ship a multi-
  column primitive (MF1), but the workaround is six lines of
  composition over `col.minMax()`.

- **Per-pixel downsampling:** Per-column with overhead (MF2). The
  composition idiom is clean but the cost is 2× a fused walk.

- **Hover/tooltip:** Per-column reads work but expose the same
  "chart wants row, library gives columns" tension as MF1 / MF2.
  Mitigated by `series.rows[idx]` existing for the row-API case.

The substrate's alignment-by-construction promise is real for
the *structural* part of the chart (where data lives, how it's
indexed, what windows mean). Cross-column *reductions* are still
the chart adapter's responsibility — and that's where M2 surfaces
new library-actionable shape.

## Library-actionable items (carry-forward)

In priority order — refreshed after M2.3 closed MF4 / F1 / NF3.

1. **`series.bisectBegin(ts: number): number`** — F3 unchanged
   from M1.0. Two bisects per frame + N per hover; the per-frame
   case is the load-bearing one. Now the lone remaining
   ergonomic friction item at the chart hot path.
2. **MF1: shared Y extent across columns is hand-rolled.**
   Status downgraded: M2.2 showed the chart can compute Y from
   bin output in 6 lines and gets the 60fps win as a bonus. A
   `series.multiMinMax(cols)` library primitive is no longer
   load-bearing — the friction is "shape-level" not "perf-level."
   Keep on the list as a "consolidation candidate" only.
3. **Doc: per-row reads.** Mention that `series.rows[idx]`
   handles the "row at idx" pattern for tooltip-style consumers
   when per-column composition feels heavy. MF3 closes itself
   with a doc nudge.
4. **`TimeSeries.fromTrustedColumns(...)`** — F5 unchanged from
   M1.0. Producer-side.
5. **Doc: NaN empty-bin convention** — NF1 unchanged from M1.1.

**Retired since M2.0:**

- **MF4 / F1 / NF3 (per-column storage check)** — closed by
  pond-ts [#165](https://github.com/pjm17971/pond-ts/pull/165)'s
  `col.toFloat64Array()` storage-agnostic gather. Chart's M2.3
  commit adopted it across extraction + 1:1 walk paths in
  M1LineChart, M2MultiColumnChart, bench-M1.mjs, bench-M2.mjs.
  Zero storage checks in the chart anymore.

**Retired in this note's history:**

- **MF2 (per-frame bin overhead)** — closed by two architecturally-
  distinct changes that compose multiplicatively:
  - `col.bin(W, reducer, { out })` shipped in pond-ts
    [#161](https://github.com/pjm17971/pond-ts/pull/161); M2.1
    adopted it. Measured win on full-window: 2–7%. The pre-
    allocated output buffer was the right shape but smaller win
    than the original MF2 framing implied.
  - Substrate `bin('minMax')` inline walk shipped in pond-ts
    [#162](https://github.com/pjm17971/pond-ts/pull/162). 9-23%
    win at the substrate level depending on workload.
  - M2.2 chart cycle: derive Y from bin's `{lo, hi}` output
    rather than three separate `slice.minMax()` walks. The
    chart-side win that closes the chart's per-frame budget at
    N=10M. Cumulative chart-side win across all three changes:
    -41 to -51% per-frame work depending on N. **Chart now
    sustains 60fps at N=10M with three lines.**

The project's "keep the public surface small, optimize the
substrate" preference held up across the whole MF2 loop: ONE small
API addition (`{ out }` parameter on an existing method) plus ONE
substrate-internal optimization plus a chart-side reorganization.
No new top-level methods. The original M2 carry-forward had
`series.multiBin` and `series.multiMinMax` as the headline
candidates; neither needed to ship.

## What this experiment didn't cover

- **Independent Y scales per line.** Some real workloads need
  per-line normalization. M2 forced a shared scale to surface the
  cross-column reduction friction; a per-line-Y variant would
  surface different shapes (per-column extent caching, axis
  labeling).
- **Chunked columns.** M2's data is row-built → always packed.
  M3's job to validate the chart against `ChunkedFloat64Column`
  output from `concatSorted`.
- **More than three columns.** N=3 is the smallest interesting
  number. A 10-column or 100-column overlay (e.g. dashboard
  small-multiples) would stress the per-column allocation cost
  much harder.
- **Streaming.** M2 is batch — build once, render. The streaming
  pattern (LiveSeries → chart) is a separate milestone.

M2 confirms the alignment-by-construction promise for the X axis
and identifies cross-column reductions as the load-bearing
follow-up area. Carry-forward feeds pond-ts's next wave.
