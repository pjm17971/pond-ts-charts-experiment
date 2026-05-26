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
| M1 (TBD) | Single-column line chart, scaling | Pending |
| M2 (TBD) | Multi-column overlay | Pending |
| M3 (TBD) | Chunked-column rendering | Pending |
| M4 (TBD) | Range slicing for zoom | Pending |
| M5 (TBD) | Interval-keyed heatmap | Pending |

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
