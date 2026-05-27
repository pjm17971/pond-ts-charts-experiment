# M2 — Multi-column overlay

**Date:** 2026-05-27
**pond-ts version:** post-#159 (column-API steps 8a–8d), installed
locally from `file:../pond/packages/core`. The local pond-ts main
sits ahead of the published `0.17.1`; M2's code paths exercise the
full schema-narrowed `column(name)` + `keyColumn().at(i)` surface.

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

### MF2. Three `bin('minMax')` calls allocate six Float64Arrays per frame

The render loop runs `slice.bin(cssWidth, 'minMax')` three times.
Each call allocates a fresh `{ lo: Float64Array(W), hi:
Float64Array(W) }` pair. At W=1024 and 60fps, that's 6 ×
8KB Float64Arrays per frame = ~48KB/frame = ~3MB/sec of allocation
churn.

The chart can't reuse buffers across calls because `bin()` always
returns fresh arrays. Browsers handle this rate well (V8 nursery
GC is fast), but the allocation **does** show up in the bench: see
the columnar-vs-fused comparison below where the fused lower bound
uses pre-allocated buffers and is ~2× faster across all scales.

Library-actionable (the **headline of M2**): a fused
multi-column bin entry point. Two shapes worth considering:

- **`series.multiBin(cols: string[], W: number, reducer): {
  [name]: BinOutput<R> }`** — one walk, one allocation per
  channel. The cleanest API for the chart use case.
- **`col.bin(cssWidth, 'minMax', { out: { lo, hi } })`** — the
  pre-allocated-output flavor (NF2 carry-forward from M1.1).
  Cheaper to land, doesn't fuse the multi-column walk but does
  retire the per-frame allocation.

The first is more aggressive; the second is what M1's NF2
already had on the carry-forward list. M2's measured 2× overhead
makes either land worth doing once the chart actually starts
falling out of frame budget.

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

Two paths:

- **columnar** — what M2's actual render loop does. Three
  `col.slice()` + three `col.minMax()` + three `col.bin('minMax')`
  per frame.
- **fused** — the theoretical floor. One pass over each column's
  raw `Float64Array` with pre-allocated bin output buffers. Skips
  the slice abstraction, the bin reducer dispatch, AND the per-
  frame allocations. The chart adapter can't write this today —
  it's what `series.multiBin` would unlock.

| Workload (full-window) | columnar | fused | overhead |
| --- | ---: | ---: | ---: |
| N=100k | 0.51 ms | 0.23 ms | **+126%** |
| N=1M | 3.56 ms | 2.07 ms | **+72%** |
| N=10M | 33.5 ms | 18.0 ms | **+86%** |

1%-zoom (columnar, no per-pixel downsample needed at N=100k):

| | columnar |
| --- | ---: |
| N=100k | 0.006 ms |
| N=1M | 0.138 ms |
| N=10M | 0.489 ms |

**Frame-budget translation at 60 fps (16.67 ms):**

- **N=10M full-window: columnar 33.5 ms** — **above budget** by
  2×. Browser-side this is the panned-all-the-way-out case
  where the chart's rendering N=10M rows on a 1024-pixel canvas
  with three lines. The fused lower bound (18 ms) is also above
  budget; some of this is fundamental (you have to walk 30M
  floats no matter what). But the gap between columnar and
  fused is ~16ms — exactly one frame of budget. **Worth
  optimizing.**
- N=1M full-window: columnar 3.6 ms — 5× headroom. Comfortable.
- All 1%-zoom cases: < 0.5 ms — interactive zoom is essentially
  free at the data layer.

The **multi-column overhead** is the clear M2 finding: pond-ts
gives the chart a clean per-column composition idiom, but
composing N=3 has measurable cost that fusing wouldn't.

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

In priority order — what to file as PRs against pond-ts:

1. **`series.multiBin(cols: string[], W: number, reducer):
   { [name]: BinOutput<R> }`** — fused multi-column per-pixel
   binning. Headline of M2: closes the ~2× columnar overhead vs
   a fused walk + retires the per-frame allocation count.
   Lands behind a measured chart-side friction signal.
2. **`series.multiMinMax(cols: string[]): [number, number] |
   undefined`** — shared Y extent in one cross-column walk. Less
   load-bearing than #1 but the shape clusters with it.
3. **`col.bin(W, reducer, { out })`** — pre-allocated bin output
   buffer. NF2 carry-forward from M1.1; M2's allocation count
   makes it more concrete (6 Float64Arrays/frame). Cheaper to
   land than #1, doesn't fuse the multi-column walk but does
   retire the per-frame allocation.
4. **`col.toFloat64Array(): Float64Array`** — closes MF4 / F1 /
   NF3. Three storage checks across columns collapse to three
   one-liners with this. Substrate has `materializeChunkedFloat64`
   already; just needs a public method.
5. **`series.bisectBegin(ts: number): number`** — F3 unchanged
   from M1.0. Two bisects per frame + N per hover; the per-frame
   case is the load-bearing one.
6. **Doc: per-row reads.** Mention that `series.rows[idx]`
   handles the "row at idx" pattern for tooltip-style consumers
   when per-column composition feels heavy. MF3 closes itself
   with a doc nudge.
7. **`TimeSeries.fromTrustedColumns(...)`** — F5 unchanged from
   M1.0. Producer-side.
8. **Doc: NaN empty-bin convention** — NF1 unchanged from M1.1.

Items #1 / #3 are the multi-column-overhead carry-forward; #2 /
#4 / #6 are shape consolidation; #5 / #7 / #8 are unchanged from
prior milestones.

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
