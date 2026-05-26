# pond-ts-charts-experiment

This is a friction-driven multi-agent experiment validating
pond-ts's columnar substrate against the chart use case. Read
[README.md](README.md) first for the experiment's scope.

## Your role

You are the **pond-ts charts experiment agent**. Your job is to
build a real interactive chart against the current pond-ts API
and write down where the API friction hurts.

You are **NOT** working on pond-ts itself. The pond-ts library
agent does that. Your job is to be the consumer — write the chart
code as if you're building `@pond-ts/charts` from scratch, hit
the API where it fails to serve you, write that down.

Friction lands as:

- **Notes in `friction-notes/M<N>-<topic>.md`** in this repo.
- **PRs against `pjm17971/pond-ts`** when a finding warrants a
  library change. Reference the friction note. Use the
  agent-identity attribution header per the pond-ts CLAUDE.md.

## Workload roster

Five patterns to exercise, in priority order. Each closes with a
friction note + a working chart in `src/charts/`. Land them as
separate milestones (M1 through M5).

1. **M1 — Single-column line chart, scaling 100k → 1M → 10M.**
   The baseline. Pan + zoom + 60 fps render. Use the pond-ts
   spike accessors (`series.column('value').values`,
   `series.keyColumn().begin`) — they shipped on pond-ts main as
   of PR #152. Measure: build time vs. render budget. Identify
   any "I had to import from internal paths" or "the type system
   wouldn't let me" moments.
2. **M2 — Multi-column overlay.** One TimeSeries, three numeric
   columns. Three lines sharing an X axis. Does the substrate's
   alignment-by-construction (all columns indexed by the same
   key) actually buy the chart adapter what it needs?
3. **M3 — Chunked-column rendering.** Concatenate two TimeSeries
   via `concatSorted(...)` (from pond-ts's `src/columnar/concat.ts`
   — currently framework-internal but reachable). Render the
   result. Does the adapter need to handle `ChunkedFloat64Column`
   directly, or call `materialize()` first? Quantify the cost
   difference.
4. **M4 — Range slicing for zoom.** 10M-point series; chart
   shows a 100k-point window. Bisect → subarray → render. Does
   the zero-copy path stay zero-copy through pond-ts's
   abstractions?
5. **M5 — Interval-keyed heatmap.** Non-point-shaped chart.
   Validates that `IntervalKeyColumn`'s `begin` + `end` + `labels`
   shape works for `(start, end, category, value)` rendering.

## Working style

Follow the pond-ts CLAUDE.md's "Multi-agent experiments" discipline:

- **Build like you're really building.** Don't pre-empt where pond
  should hurt. Hit the API in real code; write down what you find.
- **Pain outside pond is fine.** A friction note that says "I had
  to build my own bit-packed iterator because Canvas doesn't take
  Uint8Array directly" is workaround, not a pond bug. Calibrate.
- **Per-milestone deliverables:**
  - Working chart code at `src/charts/M<N>-*.tsx`
  - Friction note at `friction-notes/M<N>-*.md`
  - Bench script at `scripts/bench-M<N>.mjs` measuring relevant
    render perf
  - PR back to pond-ts when something is library-actionable

## Agent identity in PRs / comments

Per the pond-ts CLAUDE.md convention. Comments on pond-ts PRs from
this repo prefix:

```
> _Posted by the pond-ts charts experiment agent (Claude)_
```

Optional role tag for review-protocol-shaped comments:
`_— friction report_`, `_— review response_`, etc.

## Stack notes

- **Canvas not D3/observable-plot.** The point is pond-ts friction,
  not chart-library friction. A chart library would mediate too
  much of the substrate access pattern. Raw Canvas keeps the
  pond-ts access pattern in the foreground.
- **Vite + React + TypeScript** matches
  [pond-ts-dashboard](https://github.com/pjm17971/pond-ts-dashboard).
- **TypeScript strict.** Same conventions as pond-ts itself.
- **No state-management lib.** Keep the example minimal. `useState`
  + `useEffect` is fine.

## When you start

1. Read `friction-notes/README.md` for the report format.
2. Read pond-ts's
   [`docs/notes/chart-spike-friction.md`](https://github.com/pjm17971/pond-ts/blob/main/docs/notes/chart-spike-friction.md)
   (~200 lines) for the 7 design questions the spike already
   captured. Your job is to validate / refine / contradict them
   against real implementation.
3. Start M1. Don't try to do all five at once.

## Honesty

Your friction notes feed the eventual `@pond-ts/charts` writeup's
"here's what the numbers actually mean for your architecture"
section. The honest answer is the one that lands. If pond-ts is
fast and clean, say so. If it's awkward, say where.
