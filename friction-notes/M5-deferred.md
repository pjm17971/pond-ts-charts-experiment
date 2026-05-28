# M5 — Interval-keyed heatmap — **deferred (stays on queue)**

**Date:** 2026-05-28
**Status:** Not started. Stays on the milestone roster; waits for
a real motivating workload.

## What M5 would exercise

Per CLAUDE.md: "`IntervalKeyColumn`-backed series rendered as a
heatmap (`start, end, label, value`). Validates the
non-point-shaped chart adapter shape."

The substrate side is real and tested:

- `IntervalKeyColumn` exists with `begin: Float64Array`, `end:
  Float64Array`, `labels: StringColumn | Float64Column`, and the
  `labelKind` discriminator.
- `series.keyColumn().at(i)` returns `{ begin, end, label }` on
  interval-keyed series (per step 8d).
- `series.keyColumn().slice(s, e)` slices labels in lockstep
  with begin/end (per step 8d).

What's *unvalidated* is whether the chart adapter can build a
non-point chart (a heatmap, where each row is a `[start, end] ×
category` cell with a value) against this substrate without
hitting friction.

## Why it's deferred

Same shape as M3: no real consumer is asking for it today. Pond-
ts has the building blocks but no one's currently building a
log-severity timeline, calendar heatmap, or event-track chart
against pond-ts. Friction-driven discipline says wait for the
real workload.

## What would unblock M5

A real downstream that wants to render interval-keyed data.
Possible triggers:

- gRPC experiment or webapp telemetry consumer adopts an
  interval-keyed series for log / event data
- A new agent / experiment specifically targeting timeline /
  heatmap UI
- A user pulling pond-ts into a project with this shape

## What the chart-experiment already de-risked for intervals

8d shipped the key-column public API including
`IntervalKeyColumn.at(i)` and `IntervalKeyColumn.slice(s, e)`,
both type-test-pinned to return `{ begin, end, label }` and a
sliced `IntervalKeyColumn` respectively. The substrate
mechanics are in place; what's missing is the consumer story.

## Status

Resume M5 when a real consumer of interval-keyed data emerges.
Until then, this note is the durable record of why it's deferred.
