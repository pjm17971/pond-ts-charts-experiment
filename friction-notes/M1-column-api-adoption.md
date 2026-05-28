# M1.1 — Column-API adoption

**Date:** 2026-05-27
**pond-ts version:** post-#156 (Phase 4.7 step 8c), installed
locally from `/Users/peter.murphy/Code/pond/packages/core`.
Re-runs against `pond-ts@0.18.0` once that publishes.

## What's in this note

- M1.1 (commit
  [`e89eca1`](https://github.com/pjm17971/pond-ts-charts-experiment/commit/e89eca1))
  — the original "rewrite from spike accessors to the column-
  centric idiom" pass. Friction items F1–F6 status, new items
  NF1–NF3.
- M1.2 (commit
  [`5603173`](https://github.com/pjm17971/pond-ts-charts-experiment/commit/5603173))
  — added a below-canvas hover-value readout to exercise
  `col.at(i)`. Surfaced NF4 (`KeyColumn.at` gap) and confirmed
  `col.at` works cleanly for the value side.
- M1.3 (this commit) — adopted `keyColumn().at(i)` from pond-ts
  step 8d (PR
  [pond-ts#159](https://github.com/pjm17971/pond-ts/pull/159)) and
  retired NF4.

## Why this addendum exists

[`M1-line-chart-scaling.md`](./M1-line-chart-scaling.md) shipped
the baseline chart on the **spike accessor** API (PR #152) — three
calls did the work, six friction items got named. Step 8 of the
columnar substrate plan was supposed to retire those items by
exposing a column-centric public API. This note records what
actually retired, what survived, and what new friction emerged
once the chart was rewritten against the new API.

The chart's git history holds the literal before/after — commit
[`b814cbb`](https://github.com/pjm17971/pond-ts-charts-experiment/commit/b814cbb)
is the spike version; HEAD is the column-centric version.

## What landed in pond-ts (the API the chart now uses)

| Step | What | Status |
| --- | --- | --- |
| 8a (#154) | Public type re-exports — `Float64Column`, `ChunkedFloat64Column`, etc. | Shipped |
| 8b (#155) | Method surface on the column union, schema-narrowed `column(name)` | Shipped |
| 8c (#156) | `col.bin(W, reducer)` — chart's per-pixel downsampler primitive | Shipped |
| 8d | `KeyColumn.at` / `.slice` | Pending |
| 8e | _This_ — M1 adopts new API | _This note_ |

## Friction items: status update

### F1. Kind/storage dispatch — **fully retired**

The spike version:

```ts
const valueCol = series.column('value');
if (!valueCol || valueCol.kind !== 'number' || valueCol.storage !== 'packed') {
  throw new Error(`expected packed Float64; got ${valueCol?.kind}/${valueCol?.storage}`);
}
```

Three runtime guards just to access `.values`. The new version:

```ts
const valueCol = series.column('value');
if (valueCol.storage !== 'packed') {
  throw new Error(`M1 expected a packed Float64 column; got storage=${valueCol.storage}`);
}
```

The `kind !== 'number'` check is gone — `series.column('value')` is
now schema-narrowed via RFC §7.2 to `Float64Column |
ChunkedFloat64Column`. TypeScript knows the kind because the schema
declared it. Typos and key-column names fail to compile (the wide
overload was deliberately not exposed).

The `| undefined` check is gone — the schema-narrowed return type
never includes `undefined`.

**Status (M1.4 update):** Fully retired. pond-ts PR #165 shipped
`col.toFloat64Array()` — storage-agnostic gather (identity-on-
packed, gather-on-chunked, length-bounded). The chart now reads
the raw `Float64Array` via:

```ts
const valueCol = series.column('value');
const ys: Float64Array = valueCol.toFloat64Array();
```

Zero guards. Works uniformly for packed and chunked. Closes F1
fully — and folds NF3 in (which was the "1:1 path still wants
raw `.values`" sibling-of-F1 finding).

### F2. Type re-exports — **fully retired**

Step 8a re-exports `Column`, `KeyColumn`, all per-kind classes
(`Float64Column`, `BooleanColumn`, `StringColumn`, `ArrayColumn`),
their chunked variants, and the key-column variants. The chart
imports them by name now:

```ts
import { Time, TimeSeries } from 'pond-ts';
// No reaching into 'pond-ts/columnar' internals.
```

For M1 the type-annotation friction was minor (`Float64Array`
worked structurally), but the re-export is what future milestones
(M3 chunked-column rendering) will need to type their adapters.

### F3. `bisect` allocates a `Time` per probe — **fully retired**

The original framing claimed the chart "re-wraps a number into a
`Time` so pond-ts can re-extract the number inside `bisect`." That
was half-right:

- `series.bisect(key)` accepts a `KeyLike`, and `KeyLike` includes
  `TimestampInput = number | Date`. So the chart can — and now
  does — write `series.bisect(viewport.start)` directly. The
  spike-era chart's `new Time(viewport.start)` wrap was
  **redundant**, not forced by the API.
- Internally, `bisect` still routes through `toKey()`, which
  allocates a `Time` for raw number / Date inputs. So one `Time`
  allocation per `bisect` call still happens — but it happens
  whether the caller wrapped or not. The chart's redundant outer
  wrap was just doubling that single internal alloc into two.

**M1.4 close**: dropped the redundant `new Time(...)` wraps from
M1 / M2 chart code + the M1 / M2 benches. The internal
`toKey()`-allocates-Time path remains as substrate behavior —
never a measured perf cliff (V8 nursery handles 120 allocs/sec
fine), and the original carry-forward (`bisectBegin(ts: number):
number`) was deferred as "no justification for new API surface."

**Status**: closed by chart-side cleanup + honest re-read of the
existing pond-ts API. No library change.

### F4. Narrowing-chain switch with 8 cases — **mostly retired**

The original concern was a chart adapter handling four kinds
(`number`, `boolean`, `string`, `array`) × two storages (`packed`,
`chunked`) → 8-case switch. Schema-narrowed `column(name)` reduces
the kind dimension to whatever the schema declared at the call
site, so M1 sees no kind switch at all. Only the storage dimension
remains (and only for `.values` access — see F1 carry-forward).

A multi-kind chart adapter (M2 / M3) will still need to handle
storage; the kind switch is gone for any callsite that knows its
column name.

### F5. `fromTrustedColumns` for skip-validation intake — **unchanged**

Build cost at N=10M is still **1.12 s**. The chart still needs a
spinner; producers loading Arrow / Parquet still pay the
row-validation pass.

**Library-actionable carry-forward (unchanged):**
- `TimeSeries.fromTrustedColumns(schema, keys, columns)` — pond-ts
  has the substrate primitive (`ColumnarStore.fromTrustedStore`);
  it's not exposed at the `TimeSeries` boundary.

### F6. Range-aware reducers — **fully retired**

The spike version's per-frame Y-extent loop:

```ts
let lo = visYs[0]!;
let hi = lo;
for (let i = 1; i < visYs.length; i += 1) {
  const v = visYs[i]!;
  if (v < lo) lo = v;
  if (v > hi) hi = v;
}
```

becomes one method call:

```ts
const visibleCol = valueCol.slice(startIdx, endIdx);
const extent = visibleCol.minMax();
```

`col.slice(s, e)` is the zero-copy index-range view. `.minMax()`
delegates to PR #153's `reducer.reduceColumn` fast path on the
sliced view. Both compose without any intermediate construction.

The per-pixel min/max downsampler (30 lines in the spike version)
collapses to:

```ts
const { lo, hi } = visibleCol.bin(cssWidth, 'minMax');
```

The fused two-channel `{ lo, hi }` shape is exactly what the canvas
hot path consumes — stride-1 over both arrays, one allocation each,
NaN for empty bins.

## New friction surfaced by the rewrite

### NF1. Empty-bin convention is a NaN, and the chart has to check it

`col.bin(W, 'minMax')` returns NaN for bins covering zero rows. The
spike version skipped empty pixels with an index comparison
(`if (startRow >= endRow) continue`); the new version branches on
`Number.isNaN(hi[px])`.

```ts
for (let px = 0; px < cssWidth; px += 1) {
  const hiVal = hi[px]!;
  if (Number.isNaN(hiVal)) continue; // empty bin — break sub-path
  // ...
}
```

The intent matches Canvas's own behavior: `ctx.lineTo(x, NaN)`
breaks the sub-path natively, so the chart could just emit NaN
without the branch. M1 keeps the explicit branch for code clarity.
This isn't a friction _problem_ — it's a convention worth
explaining in the column-API docs so consumers know they can lean
on Canvas's NaN handling.

**Library-actionable:**
- Doc update: pond-ts's column-API JSDoc on `bin` should call
  out the NaN convention and the Canvas interop pattern. Already
  noted in PR #156's body and the RFC's §11, but worth surfacing on
  the method itself.

### NF2. Small-N zoom is slower in the columnar path

The bench captures it cleanly:

| Workload (1024 css pixels) | Spike | Columnar | Δ |
| --- | ---: | ---: | ---: |
| Full-window N=100k | 0.191 ms | 0.163 ms | -14.7% |
| Full-window N=1M | 1.238 ms | 1.182 ms | -4.5% |
| Full-window N=10M | 13.097 ms | 10.701 ms | **-18.3%** |
| 1% zoom N=100k | 0.013 ms | 0.004 ms | -69.2% |
| 1% zoom N=1M | 0.021 ms | 0.043 ms | **+104.8%** |
| 1% zoom N=10M | 0.147 ms | 0.155 ms | +5.4% |

The 1%-zoom N=1M case (~10k visible rows, just above `cssWidth =
1024`) shows the columnar path roughly 2× slower than the
open-coded loop. The cause is per-frame allocation of the bin
output (two `Float64Array(1024)`) being a real fraction of the work
when there are only 10× more input rows than output pixels.
Open-coded loops can spill to stack; method calls allocate output
buffers.

The chart's hot path is the **full-window case** (panned all the
way out), where the columnar path is unambiguously faster — and
that's the case the 60 fps budget cares about most. At 1% zoom
both paths are well under the budget so the relative delta is a
microbenchmark artifact, not a chart problem.

**Library-actionable (low priority):**
- `col.bin(W, reducer, { out: { lo, hi } })` — preallocated output
  buffers. Lets a chart reuse buffers across frames; eliminates the
  per-frame allocation. Worth landing if M3 (chunked) or M5
  (heatmap) hits it, otherwise defer.

### NF3. The 1:1 path still wants raw `.values` — **fully retired**

For the 1:1 path (visible ≤ cssWidth) the chart wants raw
`Float64Array` for inline canvas draw. M1.1 noted that the
column API gives `col.slice(s, e)` returning a `Float64Column`
view but the chart still reached for `.values` underneath; M1.2
deepened the observation.

**Status:** Closed by pond-ts PR #165's `col.toFloat64Array()`.
The chart's 1:1 path now reads `slice.toFloat64Array()` —
storage-agnostic, length-bounded, identity-when-possible
(`col.values` reference for the typical packed-exact-sized
case; subarray view for oversized; fresh allocation for
chunked). The chart adapter no longer reaches into substrate
internals for the 1:1 fast path.

### NF4. Hover/tooltip flow wants `keyColumn().at(i)` — **fully retired**

M1.2 added the below-canvas hover readout. The **value** side was
clean — `valueCol.at(idx)` from pond-ts 8b returned `number |
undefined` and worked first try. The **key** side reached for raw
`.begin`:

```ts
const time = seriesData.xs[idx]; // raw Float64Array access
```

That was the spike pattern surviving into the column-API era. NF4
flagged it as the load-bearing carry-forward.

Pond-ts step 8d ([PR #159](https://github.com/pjm17971/pond-ts/pull/159))
shipped `KeyColumn.at(i)` + `.slice(s, e)` on all three variants
plus a schema-narrowed `keyColumn()` return type. M1.3 (this
commit) drops the raw access:

```ts
const time = seriesData.keys.at(idx); // number | undefined
```

`seriesData.keys` caches `series.keyColumn()` from the seriesData
useMemo (cheap — it's a field access on the underlying store).
`keys.at(idx)` returns `number | undefined` for a `time`-keyed
schema because the schema-narrowed key column is `TimeKeyColumn`,
whose `at(i)` is the raw begin timestamp.

The substrate idiom holds: column-API stays in raw values, no
`Time` class wrapping for the chart hot path. F3's `bisect(new
Time(t))` is still the lone class-wrapping allocation in the
hover useMemo — and the only library-actionable item left at the
hover boundary.

**Status:** Closed by pond-ts 8d. The chart adapter abstraction
story now holds: `(col, idx) => value` works on both axes.

## Code-shape comparison

Three pond-ts calls before — three calls (different ones) after.
The wins are inside the loops:

| What | Spike (lines) | Columnar (lines) |
| --- | ---: | ---: |
| Column extraction + guards | 6 | 4 |
| Per-frame Y-extent | 7 | 2 |
| Per-frame per-pixel min/max | 26 | 6 |
| **Total per-frame work** | **33** | **8** |

Or in words: the chart's render loop drops one full screen of
hand-written reducer / downsampler code, replaced by two method
calls that compose off `col.slice(s, e)`.

## Validation gate: is the API shape proven?

Per pond-ts's PLAN.md step 8e: "the validation gate: if M1 retires
its kind/storage dispatch boilerplate cleanly, the API shape is
proven."

**Verdict:** the kind dispatch retires cleanly. The storage
dispatch survives at the `.values` boundary because pond-ts doesn't
yet expose a storage-agnostic typed-array materializer at the
column-API surface. That's a real gap but a small one — landed as
F1 / NF3 carry-forward — and not load-bearing for M1's correctness.

The headline win is `col.slice(s, e).bin(W, 'minMax')` — exactly the
chart-experiment reviewer's stride-1 cache-pattern recommendation
turned into an idiomatic one-liner. The chart-side per-pixel
downsampler loop is gone.

## Library-actionable items (carry-forward)

In priority order — refreshed after M1.4 closed F3 (no API change
needed; the chart was doing unnecessary work).

1. **`TimeSeries.fromTrustedColumns(schema, keys, columns)`.**
   Producer-side intake skipping the row-validation pass. F5
   unchanged from M1.0.
2. **Doc: NaN empty-bin convention on `bin`.** NF1. Quick win;
   note that Canvas `lineTo` handles NaN natively.

**Retired in this note's history:**

- **F1 / NF3 / MF4 — kind/storage dispatch** closed by pond-ts
  PR #165's `col.toFloat64Array()`. Chart adopted in M2.3.
- **NF4 — `KeyColumn.at`** closed by pond-ts 8d
  ([#159](https://github.com/pjm17971/pond-ts/pull/159)). M1.3
  adopted `keys.at(idx)` in the hover useMemo.
- **F3 — `bisect` re-wraps a number** closed by M1.4 chart-side
  cleanup (no API change). `series.bisect(viewport.start)` was
  always valid; the spike-era chart's `new Time(...)` wrap was
  redundant. Internal `Time` allocation per probe remains but
  V8's nursery handles 120/sec without a measurable cliff —
  never earned a new public method.
- **NF2 — pre-allocated bin output buffer.** Tried in pond-ts
  PR #161, measured negligible win after M2.2's yfrombins
  reorganization landed; reverted in PR #164. Honest walk-back.

The remaining open items are doc-only / producer-side. M1's
chart-hot-path friction is fully addressed.

## Bench numbers (Node-side)

`node scripts/bench-M1.mjs`. Median of 30 repeats, 3 warm-up.

The full table is in the bench script's stdout; the summary above
is the one to read. Frame-budget translation at 60 fps (16.67 ms):

- **N=10M full window, columnar path: 10.7 ms** — 1.5× headroom
  over the budget. Spike path was 13.1 ms — 1.27× headroom. The
  difference matters because Canvas draw + axis labels eat into
  that headroom; "1.5×" comfortably covers a real chart, "1.27×"
  is tight.
- **N=1M full window, columnar: 1.2 ms** — 14× headroom. Either
  path is essentially free.
- **1% zoom at any scale, either path: < 0.16 ms** — > 100×
  headroom. Interactive zoom is free.

Browser perf TBD via `npm run dev`; Node numbers are a strong
predictor for the data-layer cost.

## What this experiment doesn't yet cover

This is M1.1 — single-column line chart, post-step-8 API. Future
milestones still validate:

- **M2 multi-column overlay** — does schema-narrowed `column(name)`
  hold up across three columns? Does the chart adapter share Y
  extent calculation across columns cleanly?
- **M3 chunked-column rendering** — pins NF3 / F1 hard. The
  storage-agnostic API gap is the headline question here.
- **M4 range slicing for zoom** — 100M-row stress.
- **M5 interval-keyed heatmap** — non-point chart, depends on 8d
  (`KeyColumn.at` / `.slice`).

M1.1 confirms the substrate's column-centric idiom is the right
shape. Carry-forwards above feed pond-ts PRs.
