// M2 — Node-side bench for the multi-column overlay's per-frame
// pond-ts work.
//
// Compares three shapes:
//
//   "columnar"     — M2.0's original render loop: bisect, three
//                    col.slice(), three col.minMax() (for shared
//                    Y), three col.bin(W, 'minMax') per frame.
//
//   "columnar+yfrombins"
//                  — M2.2's render loop: drop the three
//                    col.minMax() walks; derive shared Y extent
//                    from the bin output (O(W) post-pass over
//                    {lo, hi}). This is what M2's chart actually
//                    runs.
//
//   "fused"        — theoretical floor: skip the slice abstraction
//                    AND compute bin + Y in one tight loop over
//                    each raw Float64Array. Used as a sanity-
//                    check ceiling on the chart-side wins.
//
// History note: the M2.1 milestone tried pond-ts's `col.bin(W,
// reducer, { out })` optional output buffer. Once yfrombins
// (M2.2) was in place, the { out } variant contributed zero
// measurable win and was reverted upstream. See M2 friction
// note's MF2 history.

import { performance } from 'node:perf_hooks';
import { TimeSeries } from 'pond-ts';

const SCHEMA = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'mem', kind: 'number' },
  { name: 'io', kind: 'number' },
]);

function buildSeries(n) {
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    rows[i] = [
      1_000 + i,
      50 + 35 * Math.sin(i / 5_000) + 10 * Math.sin(i / 137),
      45 + 20 * Math.sin(i / 7_500 + 1.2) + 8 * Math.sin(i / 211 + 0.7),
      30 + 25 * Math.sin(i / 3_000 + 2.4) + 15 * Math.sin(i / 89 + 1.3),
    ];
  }
  return new TimeSeries({ name: 'M2', schema: SCHEMA, rows });
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
const cssWidth = 1024;
const results = [];

for (const N of sizes) {
  const buildStart = performance.now();
  const series = buildSeries(N);
  const buildMs = performance.now() - buildStart;
  results.push({
    label: `build / N=${N}`,
    medianMs: Number(buildMs.toFixed(3)),
  });

  const cpuCol = series.column('cpu');
  const memCol = series.column('mem');
  const ioCol = series.column('io');
  const cols = [cpuCol, memCol, ioCol];
  const keys = series.keyColumn();
  const xs = keys.begin;
  const ysAll = cols.map((c) => c.toFloat64Array());

  // ── Full-window per-frame work ─────────────────────────────
  results.push(
    bench(`columnar / per-frame full-window / N=${N}`, () => {
      const startIdx = series.bisect(xs[0]);
      const endIdx = series.bisect(xs[xs.length - 1] + 1);
      // Three slices.
      const slices = cols.map((c) => c.slice(startIdx, endIdx));
      // Three minMax for shared Y.
      let yMin = Infinity;
      let yMax = -Infinity;
      for (const s of slices) {
        const e = s.minMax();
        if (!e) continue;
        if (e[0] < yMin) yMin = e[0];
        if (e[1] > yMax) yMax = e[1];
      }
      // Three bin('minMax').
      const bins = slices.map((s) => s.bin(cssWidth, 'minMax'));
      if (
        !Number.isFinite(yMin) ||
        bins[0].lo[0] === Number.POSITIVE_INFINITY
      ) {
        throw new Error('unreachable');
      }
    }),
  );

  // M2.2 chart path — derive Y extent from the bin output instead
  // of calling slice.minMax() separately per column. The bin
  // already walks every defined value; its lo/hi arrays carry
  // exactly what Y extent needs. Three O(N) walks replaced with
  // three O(W) post-passes over Float64Array(1024).
  results.push(
    bench(`columnar+yfrombins / per-frame full-window / N=${N}`, () => {
      const startIdx = series.bisect(xs[0]);
      const endIdx = series.bisect(xs[xs.length - 1] + 1);
      const slices = cols.map((c) => c.slice(startIdx, endIdx));
      let yMin = Infinity;
      let yMax = -Infinity;
      for (let i = 0; i < slices.length; i += 1) {
        const { lo, hi } = slices[i].bin(cssWidth, 'minMax');
        for (let px = 0; px < cssWidth; px += 1) {
          const loVal = lo[px];
          const hiVal = hi[px];
          if (Number.isNaN(loVal)) continue;
          if (loVal < yMin) yMin = loVal;
          if (hiVal > yMax) yMax = hiVal;
        }
      }
      if (!Number.isFinite(yMin)) {
        throw new Error('unreachable');
      }
    }),
  );

  // Lower-bound "fused" path: walk each value buffer once,
  // writing into pre-allocated bin output Float64Arrays. Skips
  // the .slice abstraction, the bin reducer dispatch, and
  // per-frame allocations.
  const fusedLo = [
    new Float64Array(cssWidth),
    new Float64Array(cssWidth),
    new Float64Array(cssWidth),
  ];
  const fusedHi = [
    new Float64Array(cssWidth),
    new Float64Array(cssWidth),
    new Float64Array(cssWidth),
  ];
  results.push(
    bench(`fused / per-frame full-window / N=${N}`, () => {
      const startIdx = series.bisect(xs[0]);
      const endIdx = series.bisect(xs[xs.length - 1] + 1);
      const visible = endIdx - startIdx;
      let yMin = Infinity;
      let yMax = -Infinity;
      const rowsPerPixel = visible / cssWidth;
      for (let col = 0; col < 3; col += 1) {
        const ys = ysAll[col];
        const lo = fusedLo[col];
        const hi = fusedHi[col];
        for (let px = 0; px < cssWidth; px += 1) {
          const start = startIdx + Math.floor(px * rowsPerPixel);
          const end = Math.min(
            startIdx + Math.floor((px + 1) * rowsPerPixel),
            endIdx,
          );
          if (start >= end) {
            lo[px] = NaN;
            hi[px] = NaN;
            continue;
          }
          let loV = ys[start];
          let hiV = loV;
          for (let i = start + 1; i < end; i += 1) {
            const v = ys[i];
            if (v < loV) loV = v;
            if (v > hiV) hiV = v;
          }
          lo[px] = loV;
          hi[px] = hiV;
          if (loV < yMin) yMin = loV;
          if (hiV > yMax) yMax = hiV;
        }
      }
      if (!Number.isFinite(yMin)) throw new Error('unreachable');
    }),
  );

  // ── 1% zoom-in per-frame work ─────────────────────────────
  const windowSize = Math.floor(N / 100);
  const t0 = xs[Math.floor(N / 2 - windowSize / 2)];
  const t1 = xs[Math.floor(N / 2 + windowSize / 2)];

  results.push(
    bench(`columnar / per-frame 1%-window / N=${N}`, () => {
      const startIdx = series.bisect(t0);
      const endIdx = series.bisect(t1);
      const slices = cols.map((c) => c.slice(startIdx, endIdx));
      let yMin = Infinity;
      let yMax = -Infinity;
      for (const s of slices) {
        const e = s.minMax();
        if (!e) continue;
        if (e[0] < yMin) yMin = e[0];
        if (e[1] > yMax) yMax = e[1];
      }
      if (endIdx - startIdx <= cssWidth) {
        if (!Number.isFinite(yMin)) throw new Error('unreachable');
        return;
      }
      const bins = slices.map((s) => s.bin(cssWidth, 'minMax'));
      if (bins[0].lo[0] === Number.POSITIVE_INFINITY) {
        throw new Error('unreachable');
      }
    }),
  );
}

console.log(JSON.stringify(results, null, 2));

console.log('\nframe-budget summary (full-window):');
for (const N of sizes) {
  const col = results.find(
    (r) => r.label === `columnar / per-frame full-window / N=${N}`,
  );
  const yfb = results.find(
    (r) => r.label === `columnar+yfrombins / per-frame full-window / N=${N}`,
  );
  const fus = results.find(
    (r) => r.label === `fused / per-frame full-window / N=${N}`,
  );
  if (!col || !yfb || !fus) continue;
  const pct = (x) => ((x / fus.medianMs - 1) * 100).toFixed(0);
  const winYfb = (
    ((col.medianMs - yfb.medianMs) / col.medianMs) *
    100
  ).toFixed(0);
  console.log(
    `  N=${N.toString().padStart(8)}` +
      ` | columnar ${col.medianMs.toFixed(3).padStart(7)} ms (+${pct(col.medianMs)}%)` +
      ` | +yfrombins ${yfb.medianMs.toFixed(3).padStart(7)} ms (+${pct(yfb.medianMs)}%)` +
      ` | fused ${fus.medianMs.toFixed(3).padStart(7)} ms` +
      ` | yfrombins vs columnar: ${winYfb}% faster`,
  );
}
console.log('\n1%-zoom (columnar):');
for (const N of sizes) {
  const col = results.find(
    (r) => r.label === `columnar / per-frame 1%-window / N=${N}`,
  );
  if (!col) continue;
  console.log(
    `  N=${N.toString().padStart(8)} | ${col.medianMs.toFixed(3).padStart(7)} ms`,
  );
}
