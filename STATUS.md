# pond-ts charts experiment — status

**Date:** 2026-05-28
**Status:** Paused after M1 + M2 wrap. M3 deferred, M5 stays on
queue but waits. See per-milestone friction notes for details.

## Headline

The chart-experiment validated the original strategic hypothesis
from
[`chart-spike-friction.md`](https://github.com/pjm17971/pond-ts/blob/main/docs/notes/chart-spike-friction.md):

> "The substrate's whole strategic justification is 'where
> columnar pays back NOW: the browser.' If chart adapters can't
> actually consume the substrate cleanly, the back-half of the
> roadmap is mis-targeted."

**The substrate does pay back.** The M2 chart sustains 60fps at
N=10M with three lines on the data layer (measured 15.75 ms per
frame, comfortably under the 16.67 ms 60fps budget). The
copy-free path from `TimeSeries → series.column(name) → typed
arrays → canvas` works end-to-end without surprising friction.

What was projected to ship as new library API (the original M1
friction note listed six carry-forward items) shrunk through
honest measurement to: the column-API surface itself (4 numbered
steps 8a–8d), `col.toFloat64Array()`, and substrate-internal
`bin` inlining. Two projected APIs (`multiBin`, `multiMinMax`)
never needed to ship. One that did ship (`col.bin(W, reducer, {
out })`) was honestly walked back when the bench showed it
earned nothing. One ergonomic item (F3's `bisectBegin`) closed
without code by re-reading the existing `KeyLike` shape.

## What this experiment validates

| Milestone | Status | What it proved |
|---|---|---|
| **M1** — single-column line chart, 100k → 10M | ✅ Shipped | Substrate access pattern is sound. 60 fps at N=10M with the column-API. |
| **M1.1** — column-centric idiom adoption | ✅ Shipped | Schema-narrowed `column(name)` retires the spike-era kind dispatch. |
| **M1.2** — hover-value readout | ✅ Shipped | First exercise of `col.at(i)`; surfaced KeyColumn.at gap. |
| **M1.3** — `keyColumn().at(idx)` adoption | ✅ Shipped | 8d closes the tooltip pattern's key-axis access. |
| **M1.4** — drop redundant `new Time()` wraps | ✅ Shipped | F3 closes by re-reading existing API. |
| **M2** — multi-column overlay (3 lines, shared X+Y) | ✅ Shipped | Alignment-by-construction holds. The chart's per-frame `(col, idx) => value` mental model works across columns. |
| **M2.1** — adopted `col.bin(W, reducer, { out })` | ✅ Shipped, then reverted | Measured: zero net win after yfrombins; reverted upstream. Honest walk-back. |
| **M2.2** — derive Y from bin output | ✅ Shipped | The load-bearing chart-side win that landed N=10M under 60 fps budget. |
| **M2.3** — adopt `col.toFloat64Array()` | ✅ Shipped | Retired F1 / NF3 / MF4 storage-check friction. |
| **M3** — chunked-column rendering | ⏸ Deferred | No public path produces chunked storage today. See [M3-deferred.md](./friction-notes/M3-deferred.md). |
| **M4** — range slicing for zoom | ✅ Implicitly validated by M1 | M1's 1%-zoom bench numbers (< 0.5 ms at N=10M) already cover the zero-copy zoom path. No separate milestone needed. |
| **M5** — interval-keyed heatmap | ⏸ Deferred (stays on queue) | Substrate is ready (8d's `IntervalKeyColumn.at` / `slice`); awaits a real interval-keyed consumer. See [M5-deferred.md](./friction-notes/M5-deferred.md). |

## What got driven into pond-ts

Library changes that landed because of friction surfaced here:

| pond-ts PR | Source friction | Outcome |
|---|---|---|
| [#154](https://github.com/pjm17971/pond-ts/pull/154) | M1.0 F2 — type re-exports missing | Step 8a: public column type re-exports |
| [#155](https://github.com/pjm17971/pond-ts/pull/155) | M1.0 F1 / F4 — kind/storage dispatch boilerplate | Step 8b: method surface + schema-narrowed `column(name)` |
| [#156](https://github.com/pjm17971/pond-ts/pull/156) | Chart per-pixel min/max downsampler manual loop | Step 8c: `Float64Column.bin(W, reducer)` |
| [#159](https://github.com/pjm17971/pond-ts/pull/159) | M1.2 NF4 — hover wants `keyColumn().at(i)` | Step 8d: KeyColumn `.at` / `.slice` + narrowed `keyColumn()` |
| [#161 → #164](https://github.com/pjm17971/pond-ts/pull/164) | M2 MF2 — allocation-driven overhead (turned out to be measurement-wrong) | `col.bin(W, reducer, { out })` shipped, then reverted after honest re-bench |
| [#162](https://github.com/pjm17971/pond-ts/pull/162) | M2.1 finding — per-bin substrate cost | Inline `minMax` walk in `bin()` |
| [#163](https://github.com/pjm17971/pond-ts/pull/163) | Library author preference | Rename `column-api.ts` → `column.ts` |
| [#165](https://github.com/pjm17971/pond-ts/pull/165) | M1.0 F1 / NF3 / M2.0 MF4 — storage-agnostic gather | `col.toFloat64Array()` |
| [#166](https://github.com/pjm17971/pond-ts/pull/166) | Library author preference (post-PR-165 cleanup) | Rename `Float64Column.values` → `_values` |

## What pond-ts surface is "complete enough" after this

For chart adapters consuming a `Float64Column`-bearing `TimeSeries`:

- **Schema-narrowed access**: `series.column<Name>(name): Float64Column | ChunkedFloat64Column` — no `| undefined`, kind-narrowed.
- **Position-indexed**: `at(i)`, `first()`, `last()`, `firstDefined()`, `lastDefined()`.
- **Reductions**: `min()`, `max()`, `sum()`, `mean()`, `stdev()`, `median()`, `percentile(q)`, `minMax()`, `count()`.
- **Predicates**: `hasMissing()`, `nullCount()`.
- **Slice**: `slice(s, e)`, `sliceByRange`, `sliceByIndices`.
- **Bulk export**: `toFloat64Array()` — storage-agnostic, length-bounded.
- **Per-pixel binning**: `bin(W, reducer)` with `'minMax'` returning `{ lo, hi }` for the chart hot path.
- **Substrate iteration**: `read(i)`, `scan(fn, options?)`.

Plus key-axis: `series.keyColumn(): KeyColumnForSchema<S>` with
`.at(i)`, `.slice(s, e)`, `.begin`, `.end`, `.labels`.

The remaining open carry-forward (NF1 doc fix on `bin`'s NaN
convention, F5 `fromTrustedColumns`) are friction-driven —
they'll earn their shape when a real consumer asks for them.

## Lessons for the next chart consumer

If you're building a chart against pond-ts:

1. **Use `series.column(name).toFloat64Array()`** for raw
   Float64Array access. Don't reach for `_values` or do storage
   checks.
2. **Pass raw numbers to `series.bisect()`** — wrapping in `new
   Time(...)` is redundant.
3. **For multi-column shared Y axes**, derive Y extent from the
   bin output rather than calling `minMax()` separately. O(W)
   post-pass vs. O(N) per column — was the load-bearing M2.2
   win.
4. **Pre-allocated bin output buffers don't help.** Tried, walked
   back. V8's nursery handles the per-frame allocation.
5. **`col.bin(W, 'minMax')`** returns `{ lo: Float64Array(W), hi:
   Float64Array(W) }` — stride-1 cache pattern that the canvas
   inner loop consumes natively.

## What's next for pond-ts

Paused on the chart-experiment side. Next wave per project
direction: columnar integration into the core library —
re-benchmarking the gRPC experiment against the matured columnar
substrate. That's the work the original chart-spike friction
note was strategically targeting; now's the time to close the
loop with the original motivating downstream.

## License

MIT. Same as pond-ts.
