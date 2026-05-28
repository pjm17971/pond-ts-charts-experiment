// M1 — Node-side bench for the pond-ts data path that backs the
// browser chart. Measures the work pond-ts does per frame (not the
// Canvas draw call, which Node can't simulate).
//
// Two paths are benched side-by-side so the M1-column-api-adoption
// friction note can quote real numbers:
//
//   "spike"    — the pre-step-8 access pattern (bisect → typed-array
//                subarray → manual min/max scan + manual per-pixel
//                downsampler loop). Pinned in friction-notes/
//                M1-line-chart-scaling.md.
//   "columnar" — the post-step-8 access pattern (bisect → col.slice
//                → col.minMax() for Y-extent → col.bin(cssWidth,
//                'minMax') for per-pixel downsampling).
//
// What each frame does at the data layer is identical between the
// two; the difference is *who* does the loop. The "spike" path
// runs JS for-loops; the "columnar" path delegates to pond-ts's
// reducer.reduceColumn fast paths (PR #153) and the bin fused walk
// (PR #156). We expect the columnar path to be roughly comparable
// or faster (monomorphic loops on TypedArrays inside the library
// vs hot-path JS loops in the chart adapter) and substantially less
// code.

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
const cssWidth = 1024; // representative chart pixel width
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
  const ys = valueCol.toFloat64Array();

  // ── Full-window per-frame work ─────────────────────────────
  // (Pan-zoomed all the way out — render the whole series.)
  //
  // Spike path: bisect endpoints, subarray, manual min/max scan,
  // manual per-pixel min/max downsampler loop.
  results.push(
    bench(`spike / per-frame full-window / N=${N}`, () => {
      const startIdx = series.bisect(new Time(xs[0]));
      const endIdx = series.bisect(new Time(xs[xs.length - 1] + 1));
      const visXs = xs.subarray(startIdx, endIdx);
      const visYs = ys.subarray(startIdx, endIdx);
      const visible = visYs.length;
      // Y extent
      let yLo = visYs[0];
      let yHi = yLo;
      for (let i = 1; i < visible; i += 1) {
        const v = visYs[i];
        if (v < yLo) yLo = v;
        if (v > yHi) yHi = v;
      }
      // Per-pixel min/max into Float64Arrays (matches canvas draw input).
      const binLo = new Float64Array(cssWidth);
      const binHi = new Float64Array(cssWidth);
      const rowsPerPixel = visible / cssWidth;
      for (let px = 0; px < cssWidth; px += 1) {
        const start = Math.floor(px * rowsPerPixel);
        const end = Math.min(Math.floor((px + 1) * rowsPerPixel), visible);
        if (start >= end) {
          binLo[px] = NaN;
          binHi[px] = NaN;
          continue;
        }
        let lo = visYs[start];
        let hi = lo;
        for (let i = start + 1; i < end; i += 1) {
          const v = visYs[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        binLo[px] = lo;
        binHi[px] = hi;
      }
      if (visXs[0] === Number.POSITIVE_INFINITY || yHi === Number.POSITIVE_INFINITY) {
        throw new Error('unreachable');
      }
    }),
  );

  // Columnar path: bisect endpoints, col.slice, col.minMax,
  // col.bin(cssWidth, 'minMax').
  results.push(
    bench(`columnar / per-frame full-window / N=${N}`, () => {
      const startIdx = series.bisect(new Time(xs[0]));
      const endIdx = series.bisect(new Time(xs[xs.length - 1] + 1));
      const slice = valueCol.slice(startIdx, endIdx);
      const extent = slice.minMax();
      const { lo, hi } = slice.bin(cssWidth, 'minMax');
      if (!extent || lo[0] === Number.POSITIVE_INFINITY || hi[0] === Number.POSITIVE_INFINITY) {
        throw new Error('unreachable');
      }
    }),
  );

  // ── 1% zoom-in per-frame work ─────────────────────────────
  // Typical interactive zoom state.
  const windowSize = Math.floor(N / 100);
  const t0 = xs[Math.floor(N / 2 - windowSize / 2)];
  const t1 = xs[Math.floor(N / 2 + windowSize / 2)];

  results.push(
    bench(`spike / per-frame 1%-window / N=${N}`, () => {
      const startIdx = series.bisect(new Time(t0));
      const endIdx = series.bisect(new Time(t1));
      const visYs = ys.subarray(startIdx, endIdx);
      const visible = visYs.length;
      let yLo = visYs[0];
      let yHi = yLo;
      for (let i = 1; i < visible; i += 1) {
        const v = visYs[i];
        if (v < yLo) yLo = v;
        if (v > yHi) yHi = v;
      }
      if (visible <= cssWidth) {
        // 1:1 path — no per-pixel scan
        if (yHi === Number.POSITIVE_INFINITY) throw new Error('unreachable');
        return;
      }
      const binLo = new Float64Array(cssWidth);
      const binHi = new Float64Array(cssWidth);
      const rowsPerPixel = visible / cssWidth;
      for (let px = 0; px < cssWidth; px += 1) {
        const start = Math.floor(px * rowsPerPixel);
        const end = Math.min(Math.floor((px + 1) * rowsPerPixel), visible);
        if (start >= end) {
          binLo[px] = NaN;
          binHi[px] = NaN;
          continue;
        }
        let lo = visYs[start];
        let hi = lo;
        for (let i = start + 1; i < end; i += 1) {
          const v = visYs[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        binLo[px] = lo;
        binHi[px] = hi;
      }
      if (yHi === Number.POSITIVE_INFINITY) throw new Error('unreachable');
    }),
  );

  results.push(
    bench(`columnar / per-frame 1%-window / N=${N}`, () => {
      const startIdx = series.bisect(new Time(t0));
      const endIdx = series.bisect(new Time(t1));
      const slice = valueCol.slice(startIdx, endIdx);
      const extent = slice.minMax();
      if (!extent) throw new Error('unreachable');
      if (endIdx - startIdx <= cssWidth) return; // 1:1 — no bin
      const { lo, hi } = slice.bin(cssWidth, 'minMax');
      if (lo[0] === Number.POSITIVE_INFINITY || hi[0] === Number.POSITIVE_INFINITY) {
        throw new Error('unreachable');
      }
    }),
  );
}

console.log(JSON.stringify(results, null, 2));

// Print a compact summary table for the friction note.
console.log('\nframe-budget summary (full-window):');
for (const N of sizes) {
  const spike = results.find((r) => r.label === `spike / per-frame full-window / N=${N}`);
  const cols = results.find((r) => r.label === `columnar / per-frame full-window / N=${N}`);
  const delta = cols && spike ? (cols.medianMs / spike.medianMs - 1) * 100 : 0;
  console.log(
    `  N=${N.toString().padStart(8)} | spike ${spike?.medianMs.toFixed(3).padStart(7)} ms ` +
      `| columnar ${cols?.medianMs.toFixed(3).padStart(7)} ms ` +
      `| Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`,
  );
}
console.log('\nframe-budget summary (1% zoom):');
for (const N of sizes) {
  const spike = results.find((r) => r.label === `spike / per-frame 1%-window / N=${N}`);
  const cols = results.find((r) => r.label === `columnar / per-frame 1%-window / N=${N}`);
  const delta = cols && spike ? (cols.medianMs / spike.medianMs - 1) * 100 : 0;
  console.log(
    `  N=${N.toString().padStart(8)} | spike ${spike?.medianMs.toFixed(3).padStart(7)} ms ` +
      `| columnar ${cols?.medianMs.toFixed(3).padStart(7)} ms ` +
      `| Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`,
  );
}
