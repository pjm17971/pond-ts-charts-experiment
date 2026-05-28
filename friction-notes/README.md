# Friction notes

Per-milestone friction reports for the chart-extraction experiment.

## Format

One file per milestone: `M<N>-<topic>.md`. Each report covers:

1. **Workload** — what was built, with N (points), refresh rate
   target, browser environment.
2. **API path** — which pond-ts methods got called from the chart
   code. Quote the actual call sites.
3. **What worked** — clean affordances. Names and pointers; if a
   pond-ts method felt obvious to reach for, say so.
4. **Friction** — where the API made you write a workaround,
   reach into internal paths, or do gymnastics. Code samples of
   the workaround.
5. **Bench numbers** — render perf in the browser. Frame budget
   used / available. Compare across N when relevant.
6. **Library-actionable** — items that warrant a pond-ts PR.
   Linked to issues / PRs once filed.

## Reports

| File | Workload | Status |
| --- | --- | --- |
| [`M1-line-chart-scaling.md`](M1-line-chart-scaling.md) | Single-column line chart, scaling | Shipped 2026-05-26 — 6 library-actionable items |
| [`M1-column-api-adoption.md`](M1-column-api-adoption.md) | M1.1–M1.4 column-API adoption | Shipped 2026-05-28 — closes 8a–8d adoption, F3/NF4 retired |
| [`M2-multi-column-overlay.md`](M2-multi-column-overlay.md) | Multi-column overlay (3 lines, shared X+Y) | Shipped 2026-05-28 — load-bearing M2.2 win, `{out}` walked back |
| [`M3-deferred.md`](M3-deferred.md) | Chunked-column rendering | ⏸ Deferred — no public path produces chunked storage today |
| M4 | Range slicing for zoom | ✅ Implicitly validated by M1 (1%-zoom bench numbers cover the zero-copy path) |
| [`M5-deferred.md`](M5-deferred.md) | Interval-keyed heatmap | ⏸ Deferred — substrate ready (8d), awaits real interval-keyed consumer |

See [`../STATUS.md`](../STATUS.md) for the top-level landing summary.

Update this table as milestones land.

## Discipline reminders

- **Write the friction down before you fix it.** If you find
  yourself writing a workaround, pause and capture the surface
  before you move on. The point of the experiment is the friction
  report, not the chart.
- **Pain outside pond is fine.** A workaround for a browser
  Canvas API quirk isn't a pond-ts bug; don't conflate the two.
- **The chart is a vehicle.** It exists to surface friction. A
  beautiful working chart with no friction notes is a failed
  experiment.
