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
- M1.2 (this commit) — added a below-canvas hover-value readout
  to exercise `col.at(i)`. Surfaced NF4 (`KeyColumn.at` gap)
  and confirmed `col.at` works cleanly for the value side.

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

### F1. Kind/storage dispatch — **mostly retired (was 3 guards, now 1)**

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

The `storage !== 'packed'` check remains because the chart's 1:1
draw path wants raw `Float64Array` for inline `moveTo`/`lineTo`,
and `ChunkedFloat64Column` doesn't expose a single contiguous
buffer (it can't, by construction). The chart could call a
substrate-internal `materializeChunkedFloat64()` to gather, but
that helper isn't on the public column surface — and a real chart
library would want a one-shot `col.toFloat64Array(): Float64Array`
that's identity-on-packed and gather-on-chunked.

**Status:** 2 of 3 guards retired. The remaining storage check is
still real friction for cross-storage chart code (M3 will pin this
hard).

**Library-actionable carry-forward:**
- `col.toFloat64Array(): Float64Array` (identity-on-packed,
  gather-on-chunked) would close this entirely. Lives next to the
  `at` / `slice` / `values` family on `Float64Column`. Same shape
  for `Uint8Array` on `BooleanColumn`, etc.

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

### F3. `bisect` allocates a `Time` per probe — **unchanged**

The chart still does:

```ts
const startIdx = seriesData.series.bisect(new Time(viewport.start));
```

Two allocations per frame plus log₂(N) comparisons each. V8's
nursery handles it; not a measurable perf cliff at 60 fps, but the
**API ergonomics** complaint stands: the chart is on the
typed-array layer and re-wraps a number into a class just to do a
binary search.

**Library-actionable carry-forward (unchanged):**
- `series.bisectBegin(ts: number): number` — number-in, number-out.

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

### NF3. The 1:1 path still wants raw `.values`

For the 1:1 path (visible ≤ cssWidth) the chart wants raw
`Float64Array` for inline canvas draw. The new column API gives the
chart `col.slice(s, e)` returning a `Float64Column` view, but the
chart still reaches for `.values` underneath.

`col.scan(fn)` is the substrate's storage-agnostic iteration
primitive, but the closure-per-iteration overhead is measurable for
1M+ rows in JS. M1 keeps a raw-typed-array fast path for now.

This is a partial duplicate of F1's carry-forward: a
`col.toFloat64Array()` would let the 1:1 path stay storage-agnostic
without paying the scan closure cost.

### NF4. Hover/tooltip flow wants `keyColumn().at(i)`

Added a below-canvas readout in commit on top of the M1.1 rewrite:
hover the chart → show `idx`, the row's timestamp, the row's value.

The value side is clean — `col.at(idx)` from 8b is the right shape:

```ts
const value = seriesData.valueCol.at(idx); // number | undefined
```

One call, no narrowing, returns the type the schema declared, and
the `| undefined` neatly covers "cursor outside data" rather than
needing a separate guard. Positive signal: this is the **first
place M1 actually uses `col.at(idx)`** (the render path uses raw
`.values` for the inline canvas loop), and it worked first try.

The key-axis side does **not** have an equivalent yet. To show the
hovered row's timestamp, the chart reaches for raw `.begin`:

```ts
const time = seriesData.xs[idx]; // raw Float64Array access
```

That's the spike pattern, not the column-centric one. `KeyColumn`
doesn't expose an `.at(i)` method in v1. The substrate has the
machinery (`read(i)` on each key-column subtype), but it isn't on
the public surface. Step 8d (`KeyColumn.at(i)` + `.slice(s, e)`)
is supposed to close this — PLAN.md calls it out as "unblocks
experiment M5 (heatmap) and tooltip / crosshair flows", and the
tooltip case is exactly this hover readout.

The friction here is small in code-shape terms (`xs[idx]` is one
line either way), but it's load-bearing for the **adapter
abstraction story**: a chart library that ships against the
column-centric API wants `(col, idx) => value` everywhere
including the key axis. Forcing key-axis callers to drop down to
the substrate's typed-array layer means the chart library either
exposes both styles (column-centric value, typed-array key — ugly)
or it builds its own `.at(i)` wrapper around `.begin[i]` (silly).

**Library-actionable (the headline of M1.2):**
- **`series.keyColumn().at(i): number | TimeRange | Interval`** —
  per-row key access matching `col.at(i)`'s shape. Already on
  PLAN.md as step 8d. This finding promotes 8d from "next code
  step" to "the close for the M1.2 hover loop."
- (Optional) `keyColumn().slice(s, e)` for range-slice consistency
  with `col.slice(s, e)` — same PR.

Sibling note on F3: hover does `bisect(new Time(cursorTime))` once
per move, which is the same pattern as the per-frame bisect — same
`Time` allocation friction. Adding `bisectBegin(ts: number)` (the
F3 carry-forward) would close it for both call sites at once.

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

In priority order — what to file as PRs against pond-ts:

1. **`series.keyColumn().at(i)` + `.slice(s, e)`.** NF4 from the
   M1.2 hover work. PLAN.md step 8d. Closes the tooltip pattern's
   key-axis gap: chart adapters that ship against the column-API
   shouldn't have to drop to `.begin[i]` for per-row timestamp
   access. M5 (heatmap) needs this too.
2. **`series.bisectBegin(ts: number): number`.** Number-in,
   number-out. F3 unchanged from M1.0; ergonomic, not a perf
   cliff. Hits both the per-frame bisect and the per-hover bisect.
3. **`col.toFloat64Array(): Float64Array`** (and `toUint8Array()`
   on Boolean, etc.). One method call replaces the storage check.
   Closes F1 / NF3.
4. **`TimeSeries.fromTrustedColumns(schema, keys, columns)`.**
   Producer-side intake skipping the row-validation pass. F5
   unchanged from M1.0.
5. **Doc: NaN empty-bin convention on `bin`.** NF1. Quick win;
   note that Canvas `lineTo` handles NaN natively.
6. **(Deferred) Pre-allocated bin output buffer.** NF2. Worth
   landing only if a later milestone hits the small-N pattern in a
   real workload.

Item 1 is the headline of the M1.2 work and the natural next step
the friction note exists to drive. Items 2-3 are real but the chart
can work around. Item 4 is producer-side. Items 5-6 are
doc-only / defer-until-friction.

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
