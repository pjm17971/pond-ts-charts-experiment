# M2 — Multi-column overlay

**Date:** 2026-05-27
**pond-ts version:** post-#161 (column-API steps 8a–8d +
`col.bin(W, reducer, { out })` follow-up), installed locally from
`file:../pond/packages/core`.

## Milestones in this note

- **M2.0** — initial three-line overlay. Surfaced MF1–MF4.
- **M2.1** — adopted `col.bin(W, 'minMax', { out })` from pond-ts
  #161 after MF2's allocation-churn finding. Re-benched. The
  measured win was smaller than the original MF2 projection
  (2–7% rather than "most of the 2× gap"); honest re-bench
  reframed MF2 around the real hot path (per-bin `sliceByRange`
  + reducer dispatch inside `bin()`, ~180k allocations/sec at 3
  cols × 60fps × W=1024 bins). Documented inline below.

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

**Status:** `{ out }` shipped (closes the small allocation-churn
component, ~2-7% measured). The headline optimization moves to
substrate-level `bin` impl tuning rather than API additions —
matches the project preference for keeping the public surface
small.

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

### MF4. Per-column storage check × N

Same residual storage-check friction as M1.1's F1, just multiplied
by the column count:

```ts
const valueCols = COLUMNS.map((cfg) => {
  const col = series.column(cfg.name);
  if (col.storage !== 'packed') throw ...
  return col;
});
```

Three columns → three storage checks. Closes on the same library-
actionable as F1's carry-forward: `col.toFloat64Array(): Float64Array`
(identity-on-packed, gather-on-chunked) would let the chart write
`COLUMNS.map((cfg) => series.column(cfg.name).toFloat64Array())`
with no per-column check.

## Bench numbers (Node-side)

`node scripts/bench-M2.mjs`. Median of 30 repeats, 3 warm-up.

Three paths:

- **columnar** — M2.0's original render loop. Three `col.slice()`
  + three `col.minMax()` + three `col.bin('minMax')` per frame.
  Per-frame allocates 6 × Float64Array(W) for the bin outputs +
  three view objects from slice + ~3 × W view objects internally
  inside `bin()` (one per bin).
- **columnar+out** — M2.1 (after pond-ts #161). Same shape but
  passes pre-allocated `{ lo, hi }` buffers via
  `col.bin(W, 'minMax', { out })`. Retires the 6 typed-array
  allocations per frame. The 3 × W internal view objects per
  call are still there (substrate-level, not API-exposed).
- **fused** — theoretical floor. One pass over each column's raw
  `Float64Array` with pre-allocated bin output buffers AND no
  intermediate view objects per bin. The chart adapter can't
  write this today — it's what an inlined-`bin` substrate change
  would unlock.

| Workload (full-window) | columnar | columnar+out | fused |
| --- | ---: | ---: | ---: |
| N=100k | 0.52 ms (+120%) | 0.49 ms (+107%) | 0.24 ms |
| N=1M | 3.67 ms (+95%) | 3.62 ms (+92%) | 1.88 ms |
| N=10M | 35.3 ms (+98%) | 32.6 ms (+83%) | 17.8 ms |

`{ out }` win vs bare `columnar` (across full-window):
**2 – 7%**. Small. Retires the allocation churn but most of the
overhead is elsewhere.

1%-zoom (columnar, no per-pixel downsample needed at N=100k):

| | columnar |
| --- | ---: |
| N=100k | 0.003 ms |
| N=1M | 0.142 ms |
| N=10M | 0.477 ms |

**Frame-budget translation at 60 fps (16.67 ms):**

- **N=10M full-window: columnar+out still 32.6 ms** — above
  budget by 2×. The pre-allocated output buffer didn't move the
  needle here; the bulk of the cost is per-bin overhead inside
  `bin()`'s impl. Substrate inlining (carry-forward #1) is what
  closes this.
- N=1M full-window: 3.6 ms — 5× headroom. Comfortable either
  way.
- All 1%-zoom cases: < 0.5 ms — interactive zoom is essentially
  free at the data layer.

The **honest M2 finding after re-bench**: composition cost is
real and the headline lives in the substrate's per-bin work, not
the per-frame output allocation. `{ out }` was a real (small) win
and the right shape for the API; the headline optimization is
substrate-level and doesn't require any public-surface change.

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

In priority order — refreshed after M2.1's bench told us where
the cost actually lives.

1. **Substrate: inline `bin()`'s per-bin walk in pond-ts.** Each
   `col.bin(W, reducer)` call internally allocates W view objects
   via `sliceByRange` + dispatches through `resolveReducer` per
   bin — ~180k allocations/sec at 3 cols × 60fps × W=1024. The
   M2.1 re-bench (after `{ out }` shipped) shows this is where
   the remaining ~2× gap vs the fused floor lives, not in the
   bin output allocation. **Substrate-only**, no public API
   change. Headline of M2 post-bench.
2. **`col.toFloat64Array(): Float64Array`** — closes MF4 / F1 /
   NF3. Three storage checks across columns collapse to three
   one-liners with this. Substrate has `materializeChunkedFloat64`
   already; just needs a public method.
3. **`series.bisectBegin(ts: number): number`** — F3 unchanged
   from M1.0. Two bisects per frame + N per hover; the per-frame
   case is the load-bearing one.
4. **`series.multiMinMax(cols: string[]): [number, number] |
   undefined`** — shared Y extent in one cross-column walk (MF1).
   Friction is shape-level; the chart workaround is six lines so
   the perf cost is small. Land only if M3 / M5 hits a use case
   that elevates it.
5. **Doc: per-row reads.** Mention that `series.rows[idx]`
   handles the "row at idx" pattern for tooltip-style consumers
   when per-column composition feels heavy. MF3 closes itself
   with a doc nudge.
6. **`TimeSeries.fromTrustedColumns(...)`** — F5 unchanged from
   M1.0. Producer-side.
7. **Doc: NaN empty-bin convention** — NF1 unchanged from M1.1.

**Retired in this note's history:**

- **MF2 (pre-allocated bin output)** — `col.bin(W, reducer,
  { out })` shipped in pond-ts
  [#161](https://github.com/pjm17971/pond-ts/pull/161). M2.1
  adopted it. Measured win on full-window: 2–7% across N=100k →
  10M. Smaller than the original MF2 framing implied; the bigger
  cost is per-bin allocations inside the substrate (now #1
  above).

The project's preferred direction has been "keep the public
surface small, optimize the substrate" — item #1 fits that
preference exactly. Item #4 (`multiBin`) was an earlier candidate
but is no longer the right shape now that we know where the cost
actually lives.

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
