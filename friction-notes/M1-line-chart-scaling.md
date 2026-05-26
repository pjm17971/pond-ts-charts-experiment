# M1 — Single-column line chart scaling 100k → 1M → 10M

**Date:** 2026-05-26
**pond-ts version:** post-#152 (spike accessors), installed locally
from `/Users/peter.murphy/Code/pond/packages/core` because
`pond-ts@0.17.1` on npm doesn't yet have `series.column()` /
`series.keyColumn()`.

## Workload

Real interactive React + Canvas line chart. Drag-to-pan + scroll-to-zoom.
Per-pixel min/max downsampling when `visible > cssWidth` so the canvas
draw call doesn't explode on N=1M+ series. Stats overlay shows build
time, last + median render time, FPS, visible row count.

Run locally:
```bash
npm install
npm run dev
# open http://localhost:5173
```

## API path

Three pond-ts calls do all the work:

```ts
// 1. Build once per N (useMemo).
const series = new TimeSeries({ name: 'M1', schema: SCHEMA, rows });

// 2. Extract typed arrays once. Kind/storage dispatch happens here.
const valueCol = series.column('value');
if (!valueCol || valueCol.kind !== 'number' || valueCol.storage !== 'packed') {
  throw new Error(`expected packed Float64; got ${valueCol?.kind}/${valueCol?.storage}`);
}
const xs: Float64Array = series.keyColumn().begin;
const ys: Float64Array = valueCol.values;

// 3. Per frame: find visible window via bisect, slice typed arrays.
const startIdx = series.bisect(new Time(viewport.start));
const endIdx = series.bisect(new Time(viewport.end));
const visXs = xs.subarray(startIdx, endIdx);
const visYs = ys.subarray(startIdx, endIdx);
```

That's the whole pond-ts surface used. Everything else is Canvas /
React / pointer-event work.

## What worked

- **Typed-array access pattern is exactly right.** `series.column(name).values`
  + `series.keyColumn().begin` is what a chart adapter wants. No
  surprise; matches Arrow / Polars idioms.

- **Zero-copy subarray slicing for zoom is real.** `xs.subarray(start, end)` +
  `ys.subarray(start, end)` give the chart a view of the visible window
  without copying. At N=10M with a 1%-zoom (100k visible), the per-frame
  data-layer work is 0.067 ms — way under the 16.7 ms 60-fps budget.

- **Lazy `series.events` materialization is the right default.** The
  chart never touches `.events`. Build cost is dominated by validation
  + column construction, not Event allocation.

- **The pre-existing `series.bisect()` is the right primitive for
  range queries.** Two bisects per frame to find `[startIdx, endIdx)`
  — clean shape.

- **Build cost is acceptable up to 1M.** At 1M, build = 89 ms — well
  under "first-paint feels instant" (~100 ms). At 10M, build = 1.12 s
  and demands a loading spinner.

## Friction

### F1. Kind/storage dispatch is awkward at the entry point

The first thing the chart does after `series.column(name)` is narrow
on `kind` + `storage`:

```ts
const valueCol = series.column('value');
if (!valueCol || valueCol.kind !== 'number' || valueCol.storage !== 'packed') {
  throw new Error(...);
}
```

Three guards just to confirm "yes I can read `.values`." Pond-ts
itself knows the schema declared `'value'` is `kind: 'number'`. The
chart had to declare it again at the call site. This is the
"kind/storage dispatch boilerplate" pond-ts already noted as
friction item #1 in
[`chart-spike-friction.md`](https://github.com/pjm17971/pond-ts/blob/main/docs/notes/chart-spike-friction.md);
this implementation validates it cold.

**Library-actionable**: a `series.numberValues(name): Float64Array | undefined`
helper would eliminate three guards per access. Same for the other
kinds. The narrowing is genuinely value-adding *internally* (it lets
reducers narrow to the column variant) but it's noise at the chart
adapter boundary.

### F2. `Column` / `KeyColumn` types aren't re-exported from `pond-ts`

Validates friction item #7 from the pond-ts spike notes cold. A typed
call site like

```ts
const xs: Float64Array = series.keyColumn().begin;
```

works fine because `.begin` is a structural property of all
`KeyColumn` variants. But if I wanted

```ts
const col: Column | undefined = series.column('value');
```

I'd have to reach into internal paths to import `Column`. In M1 I
used `ReturnType<typeof series.column>` or just elided the type
annotation. Neither is wrong but both are friction signs.

**Library-actionable**: step 8 should re-export `Column` and
`KeyColumn` from the top-level. Or introduce a narrower
chart-extraction wrapper type.

### F3. `bisect` allocates a `Time` per probe — but the bigger issue is the wrapper itself

The spike notes flagged that `bisect` does `new Time(key)` per call
(per [`time-series.ts:3777`](https://github.com/pjm17971/pond-ts/blob/main/packages/core/src/batch/time-series.ts) area).
At 60 fps × 2 bisects per frame × log₂(10M) ≈ 24 probes per bisect,
that's ~3k `Time` allocations/sec on pan. The chart didn't hit a
measurable perf cliff from this; V8 nursery GC handles it.

The bigger issue is the **wrapper itself**: the chart already has
the visible window as **raw numbers** (`viewport.start` /
`viewport.end` are ms timestamps from the typed-array `begin` buffer).
But `bisect` takes a `KeyLike`, requiring `new Time(t)`:

```ts
const startIdx = series.bisect(new Time(viewport.start));
```

The chart re-wraps a number into a `Time` so pond-ts can re-extract
the number inside `bisect` for the comparison. That's not a perf
problem — it's an API ergonomics one. The chart, having reached the
typed-array layer, is now back at the row-API class boundary just to
do a binary search.

**Library-actionable**: `series.bisectBegin(timestamp: number): number`
or `series.window(t0: number, t1: number): { start: number; end: number }`
— both would let the chart stay on the number plane after reaching
typed-array access.

### F4. The kind/storage check at extraction can't statically narrow `.values`

This compiles:

```ts
const valueCol = series.column('value');
if (valueCol?.kind === 'number' && valueCol.storage === 'packed') {
  const v = valueCol.values; // ✅ TypeScript narrows to Float64Column
}
```

But the `Column` union has 8 variants (4 kinds × 2 storages). For
chart code handling boolean / string / array columns too, the
narrowing chain becomes a switch statement with 8 cases — and each
case has to repeat the storage check. Friction item #1's helper
methods are the right shape.

### F5. The build cost at N=10M is a real spinner moment

| N | Build cost | First-paint feel |
| --- | ---: | --- |
| 100k | 13.8 ms | Instant |
| 1M | 89 ms | "Just fast enough" |
| 10M | 1.12 s | Need a spinner |

The 10M build is dominated by the column-native intake walk + row
validation. Both are O(N) and can't be cheaper without skipping
validation entirely (which the row-API guarantees pond gives up).

**Library-actionable**: investigate whether `TimeSeries.fromTrustedColumns(...)`
(or equivalent) could let a producer skip validation when the
columnar buffers are already known-good. For chart consumers
loading Arrow / Parquet / typed-array-shaped JSON, the validation
pass is pure overhead. Currently this exists at the substrate via
`ColumnarStore.fromTrustedStore` but isn't exposed at the
`TimeSeries` boundary.

### F6. Subarray views work, but the chart still has to compute Y extent every frame

Per the chart loop:

```ts
let lo = visYs[0]!;
let hi = lo;
for (let i = 1; i < visYs.length; i += 1) {
  const v = visYs[i]!;
  if (v < lo) lo = v;
  if (v > hi) hi = v;
}
```

This is the chart's per-frame work. It's fast (0.6 ms for 1M points,
5.7 ms for 10M) but it's also exactly what `series.column('value').reduce('min')`
+ `.reduce('max')` would compute — which post-Phase 4.7 step 3 is a
~0.5 ms operation via `reduceColumn`.

The chart can't easily use that today because pond-ts's `reduce`
operates on the whole series, not a subarray view. To use the
reducers, the chart would have to either (a) construct a new
TimeSeries from the subarray (full validation pass — not viable per
frame), or (b) call `min.reduceColumn` directly on a Float64Column
representing the slice (but the chart has a subarray, not a column).

**Library-actionable**: expose a range-aware reducer entry point.
`reducer.reduceColumnRange(col, start, end)` is the natural shape,
matching the chart's slice pattern. This is Phase B/C work per step 3's
PR description but the chart use case validates the demand.

## Bench numbers (Node-side)

`node scripts/bench-M1.mjs`. Median of 30 repeats, after 3 warm-up.

| Workload | N=100k | N=1M | N=10M |
| --- | ---: | ---: | ---: |
| Build (one-time) | 13.8 ms | 89 ms | **1.12 s** |
| Per-frame, full window | 0.11 ms | 0.60 ms | 5.74 ms |
| Per-frame, 1% zoom window | 0.017 ms | 0.018 ms | 0.067 ms |

**Frame-budget translation:**
- N=1M full window: **28 frames per 60-fps budget**. Plenty of headroom.
- N=10M full window: 2.9 frames per 60-fps budget. Pan stutter likely
  if Canvas draw + Y-extent compute both run per frame; downsampling +
  caching Y-extent across pan-only events would recover headroom.
- 1% zoom at any scale: **245+ frames per budget**. Interactive zoom
  is essentially free at the data layer.

Browser perf is TBD — needs the user to actually open the dev server
and measure. Node numbers are a strong predictor for the data-layer
cost; Canvas draw cost adds on top.

## Library-actionable items (for pond-ts PRs)

In priority order — what to file as PRs against pond-ts:

1. **Cut a release with the spike accessors.** The spike merged in
   `pond-ts` main as PR #152 but the published `0.17.1` doesn't have
   them. External consumers can't try the chart-extraction path
   without a local install. Cut `0.18.0` (or `0.17.2`) before
   inviting other consumers to validate.

2. **`series.bisectBegin(ts: number): number`.** Number-in,
   number-out. Lets chart adapters stay on the raw-number plane
   after reaching typed-array access. (F3.)

3. **`series.numberValues(name): Float64Array | undefined`** (and
   siblings for boolean / string / array). Three guards collapse
   to one method call at the chart entry point. (F1, F4.)

4. **Re-export `Column` / `KeyColumn` from `pond-ts` top-level.**
   Or introduce a chart-extraction wrapper type. (F2.)

5. **`reducer.reduceColumnRange(col, start, end)`** (or
   equivalent). The chart wants Y extent over a subarray; pond-ts's
   step 3 fast path is the right tool, just needs range scope. (F6.)

6. **Trusted-columns intake at the `TimeSeries` boundary.**
   `TimeSeries.fromTrustedColumns(schema, keys, columns)` for
   producers (Arrow / Parquet loaders) that have validated columnar
   data already. Skips the row-validation pass. (F5.)

Items 1, 2, 4 are quick. Items 3, 5 are step 8 helpers. Item 6 is
its own design discussion.

## What this experiment doesn't yet cover

This is M1 — single-column line chart. Future milestones:

- **M2 multi-column overlay** — three lines sharing an X axis.
- **M3 chunked-column rendering** — `concatSorted` output through
  the chart.
- **M4 range slicing for zoom** — explicit perf test of the
  subarray-views-on-100M scale. (M1 already does this in-flight at
  10M; M4 stresses it.)
- **M5 interval-keyed heatmap** — non-point chart shape.

Each will surface its own friction. M1 confirms the substrate
access pattern is sound; later milestones validate the broader
API surface.
