// M1 — Node-side bench for the pond-ts data path that backs the
// browser chart. Measures the work pond-ts does per frame (not the
// Canvas draw call, which Node can't simulate).
//
// What each frame does at the data layer:
//   - bisect(t0) + bisect(t1)  ← find visible window's row indices
//   - subarray(start, end)     ← zero-copy view of visible xs / ys
//   - walk visible to compute Y extent (min/max for axis scaling)
//
// That's the cost the chart pays even before it draws a single
// canvas pixel. The expectation: substantially under the 16.7 ms
// 60-fps budget, even at N=10M with a small zoom window.

import { performance } from 'node:perf_hooks';
import { Time, TimeSeries } from 'pond-ts';

const SCHEMA = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
]);

function buildSeries(n) {
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    rows[i] = [1_000 + i, 50 * Math.sin(i / 5_000) + 15 * Math.sin(i / 137)];
  }
  return new TimeSeries({ name: 'M1', schema: SCHEMA, rows });
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function bench(label, fn, repeats = 30) {
  for (let i = 0; i < 3; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return {
    label,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

const sizes = [100_000, 1_000_000, 10_000_000];
const results = [];

for (const N of sizes) {
  const buildStart = performance.now();
  const series = buildSeries(N);
  const buildMs = performance.now() - buildStart;
  results.push({
    label: `build / N=${N}`,
    medianMs: Number(buildMs.toFixed(3)),
  });

  const valueCol = series.column('value');
  const xs = series.keyColumn().begin;
  const ys = valueCol.values;

  // Full-window per-frame work — the "render whole series" path.
  results.push(
    bench(`per-frame full-window / N=${N}`, () => {
      const startIdx = series.bisect(new Time(xs[0]));
      const endIdx = series.bisect(new Time(xs[xs.length - 1] + 1));
      const visXs = xs.subarray(startIdx, endIdx);
      const visYs = ys.subarray(startIdx, endIdx);
      let lo = visYs[0];
      let hi = lo;
      for (let i = 1; i < visYs.length; i += 1) {
        const v = visYs[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (visXs[0] === Number.POSITIVE_INFINITY) throw new Error('unreachable');
    }),
  );

  // Zoomed-in per-frame work — 1% of the series. Represents the
  // typical interactive zoom state.
  const windowSize = Math.floor(N / 100);
  const t0 = xs[Math.floor(N / 2 - windowSize / 2)];
  const t1 = xs[Math.floor(N / 2 + windowSize / 2)];
  results.push(
    bench(`per-frame 1%-window / N=${N}`, () => {
      const startIdx = series.bisect(new Time(t0));
      const endIdx = series.bisect(new Time(t1));
      const visXs = xs.subarray(startIdx, endIdx);
      const visYs = ys.subarray(startIdx, endIdx);
      let lo = visYs[0];
      let hi = lo;
      for (let i = 1; i < visYs.length; i += 1) {
        const v = visYs[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (visXs[0] === Number.POSITIVE_INFINITY) throw new Error('unreachable');
    }),
  );
}

console.log(JSON.stringify(results, null, 2));

const oneM = results.find((r) => r.label === 'per-frame full-window / N=1000000');
const tenM = results.find(
  (r) => r.label === 'per-frame full-window / N=10000000',
);
console.log(
  `\nframe-budget: full-window 1M = ${oneM?.medianMs} ms (${Math.floor(16.7 / (oneM?.medianMs || 1))} per 60-fps frame), ` +
    `full-window 10M = ${tenM?.medianMs} ms.`,
);
