# M3 — Chunked-column rendering — **deferred**

**Date:** 2026-05-28
**Status:** Not started. Deferred until a real consumer of chunked
storage emerges. This note captures the access-friction finding
that made M3 premature, so a future session (human or agent) can
pick it up without re-discovering the issue.

## The pre-coding finding

`ChunkedFloat64Column` is on the schema-narrowed public type that
`series.column('x')` returns (`Float64Column |
ChunkedFloat64Column`), and the column-API methods
(`toFloat64Array`, `slice`, `bin`, `at`, `scan`) all handle it
correctly via materialize-then-delegate. The substrate is real
and tested.

**But no public path through `TimeSeries` actually produces
chunked storage today.** Specifically:

- `concatSorted(stores)` is exported from `pond-ts` and is what
  CLAUDE.md pointed M3 at. But it operates on `ColumnarStore<S>`
  (substrate type, not user-facing) and returns one. Wrapping a
  `ColumnarStore` into a `TimeSeries` requires the unforgeable
  `TRUSTED_STORE_SENTINEL` symbol — external code can't reach it
  by design.

- `TimeSeries.concat([s1, s2])` exists, but materializes through
  `s.events` and rebuilds with packed storage. The chunked
  storage of `concatSorted`'s output is discarded.

- `LiveSeries` retention / ring-buffer paths produce packed
  columns via `ColumnarRingBuffer.toColumn()` (exact-sized
  allocation). No chunked storage.

- No Arrow / Parquet loader yet (would naturally produce chunked
  storage from row groups).

Net effect: `series.column('x').storage === 'chunked'` is
type-system-reachable but **runtime-unreachable** from any
consumer-facing API.

## Why this matters for M3

M3's question per CLAUDE.md: "Does the adapter need to handle
`ChunkedFloat64Column` directly, or call `materialize()` first?
Quantify the cost difference."

To answer it as a "real consumer building a chart," the chart
would need a chunked input to render against. With the current
substrate-only access:

- The chart would have to reach into substrate primitives
  (`ChunkedFloat64Column`, `ColumnarStore`, `concatSorted`,
  `TimeKeyColumn`) and construct its own chunked input via
  reach-arounds the public API doesn't sanction.
- The cost measurement would be against data **no real consumer
  has**, since no real consumer can produce chunked storage
  today.
- The friction note would document cost characteristics of a
  code path no one is exercising.

That's the inverse of the friction-driven discipline: friction is
supposed to come from real workloads, not from synthetic
exercises against hypothetical data.

## What would unblock M3

In rough order of "most likely to land first":

1. **Storage-preserving `TimeSeries.concat`** (or `concatChunked`).
   Direct user motivation: "I have yesterday's series and
   today's series; let me view them together without re-copying
   N+M rows into a fresh buffer." This is the cleanest path —
   exposes the chunked storage as a real consumer outcome of a
   plausible operation.

2. **`TimeSeries.fromTrustedStore` / `fromTrustedColumns`** — the
   F5 escape hatch the friction note has carried since M1.0.
   Lets external code (Arrow loaders, Parquet readers, the gRPC
   experiment) construct a `TimeSeries` directly from a
   pre-built `ColumnarStore`. Lands chunked-storage support as a
   side effect rather than as the headline.

3. **`LiveSeries` retention emits chunked snapshots.** Would be
   a structural change to retention. Speculative — no current
   user is asking for it.

4. **External pond-ts experiment that needs chunked.** The
   gRPC experiment or webapp telemetry agent (per pond-ts
   CLAUDE.md "Active experiments") might surface the friction
   organically.

Until one of these lands, M3 has no real workload to validate
against.

## What the chart-experiment already de-risked for chunked

The relevant question for a future M3 cycle is "what happens
when `series.column('x')` returns a `ChunkedFloat64Column`."
The chart-experiment has already validated that this works at
the API level for every method the chart cares about:

- `.toFloat64Array()` — materialize-then-return, single allocation per call (PR #165)
- `.slice(s, e)` — returns a chunked or packed column depending on whether the slice crosses chunk boundaries
- `.bin(W, reducer)` — materializes then delegates to packed `bin` (PR #156's chunked variant)
- `.at(i)`, `.scan(fn)` — substrate-native, no materialize

So the **mechanical** chunked-handling story is in place. What's
unmeasured is the **per-frame cost shape** when the chart's hot
path encounters real chunked input, which is what M3 was meant
to surface — but, again, no real consumer is producing such
input yet.

## Status

Resume M3 when one of the unblocking items above lands and brings
a real workload with it. Until then, this note is the durable
record of why M3 was deferred rather than half-built.

## Related

- M5 (interval-keyed heatmap) — same flavor of "needs a real
  motivating consumer." Stays on the queue; waits. See
  [`M5-deferred.md`](./M5-deferred.md).
