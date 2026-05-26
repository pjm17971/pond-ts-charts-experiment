# pond-ts charts experiment

Friction-driven chart-extraction experiment for [pond-ts](https://github.com/pjm17971/pond-ts).
This repo's job is to validate that the columnar substrate that
shipped in Phase 4.7 actually serves the chart use case it was
strategically motivated by.

The hypothesis (from
[`chart-spike-friction.md`](https://github.com/pjm17971/pond-ts/blob/main/docs/notes/chart-spike-friction.md)
in the pond-ts repo):

> The substrate's whole strategic justification is "where columnar
> pays back NOW: the browser." If chart adapters can't actually
> consume the substrate cleanly, the back-half of the roadmap is
> mis-targeted.

The spike in pond-ts itself measured **~9× speedup** on the
per-frame walk via typed arrays vs. the row-API path. This repo
validates the SAME claim in a real browser environment with
interactive pan / zoom / range-select rendering.

## What this experiment validates

Five workload patterns, in priority order:

1. **Single-column line chart, 100k → 1M → 10M points.** The basic
   case. Pan and zoom should stay at 60 fps. Verify the pond-ts
   `series.column('value').values` typed-array access pattern.
2. **Multi-column overlay.** One TimeSeries with cpu + memory +
   network columns; chart renders three lines sharing an X axis.
   Verifies the multi-column alignment pattern.
3. **Chunked column at the boundary.** Concatenate two TimeSeries
   via the spike's columnar primitives (or a follow-up); render
   the result. Does the chart adapter handle `ChunkedFloat64Column`
   transparently, or does it require `materialize()` first?
4. **Range slicing for zoom.** Chart shows `[t1, t2]` window. Does
   `series.bisect(t1) + bisect(t2) + .subarray(...)` give a
   zero-copy view that scales to 100M-point series?
5. **Interval-keyed heatmap.** `IntervalKeyColumn`-backed series
   rendered as a heatmap (`start, end, label, value`). Validates
   the non-point-shaped chart adapter shape.

## Deliverables

This experiment closes when there's a working chart + a written
friction report. The friction report drives back into pond-ts as a
PR or set of PRs (`docs/notes/chart-experiment-friction.md` and
follow-ups against the open design questions in
[`chart-spike-friction.md`](https://github.com/pjm17971/pond-ts/blob/main/docs/notes/chart-spike-friction.md)).

Per the
[pond-ts CLAUDE.md "Multi-agent experiments" section](https://github.com/pjm17971/pond-ts/blob/main/CLAUDE.md#multi-agent-experiments-and-the-feedback-model),
three outputs land:

1. **Friction notes** in `friction-notes/` (this repo). Each
   workload pattern gets its own `M<N>-<topic>.md` capturing what
   worked, what was hard, what the library should add / change.
2. **Bench data**. `scripts/bench-*.mjs` measuring real-browser
   render perf. Numbers feed the eventual `@pond-ts/charts`
   honesty section.
3. **Reference implementation**. The working chart code at
   `src/charts/`. Becomes the basis for a how-to guide in the
   pond-ts website's `how-to-guides/` directory.

## Stack

- Vite + React + TypeScript (matching
  [pond-ts-dashboard](https://github.com/pjm17971/pond-ts-dashboard))
- pond-ts (from npm; current version pinned via package-lock)
- HTML5 Canvas for the chart rendering (no D3, no existing chart
  library — the whole point is to surface pond-ts friction
  without a chart lib mediating)

## Running

```bash
npm install
npm run dev
```

Open http://localhost:5173. Use the in-page controls to switch
between the five workload patterns.

## Reporting back

Friction reports drive PRs against pond-ts. When a finding is
worth a library change, open a PR in pjm17971/pond-ts referencing
the friction note. Use the `_Posted by the pond-ts charts experiment
agent (Claude)_` attribution header per the pond-ts agent-identity
convention.

## License

MIT. Same as pond-ts.
