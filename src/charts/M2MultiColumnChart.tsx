// M2 — multi-column overlay (three numeric columns, shared X + Y).
//
// What this validates from CLAUDE.md:
//   "Does the substrate's alignment-by-construction (all columns
//    indexed by the same key) actually buy the chart adapter what
//    it needs?"
//
// Approach: synthetic system-load workload (cpu_pct, mem_pct,
// io_pct) — three percentage-shaped numeric columns sharing a
// time key. Three differently-colored lines on one canvas.
// Per-pixel min/max downsampling for each. Hover shows all three
// values + the timestamp at the cursor.
//
// Decisions worth pinning before the code starts:
//   - Shared Y axis. Forcing one Y scale across three columns is
//     the most natural "three lines on one chart" pattern and is
//     what exercises cross-column friction (computing a global Y
//     extent across columns). All three columns are bounded
//     roughly [0, 100] in the synthetic data so the squash is
//     mild.
//   - One canvas, three sub-paths. Don't reach for SVG, multiple
//     canvases, or a chart-lib; the friction we want to surface is
//     about pond-ts composition, not Canvas plumbing.
//   - The chart code shouldn't know how many columns there are —
//     it should iterate `COLUMNS`. That's the patternmatch a real
//     chart adapter would expose.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Time, TimeSeries } from 'pond-ts';

type N = 100_000 | 1_000_000 | 10_000_000;

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'mem', kind: 'number' },
  { name: 'io', kind: 'number' },
] as const;

// The chart's render loop iterates this. A real chart adapter
// would derive it from the schema + a per-column style config;
// for M2 we just enumerate.
const COLUMNS = [
  { name: 'cpu', color: '#3a8fff', label: 'CPU %' },
  { name: 'mem', color: '#ff7a3a', label: 'Mem %' },
  { name: 'io', color: '#7aff3a', label: 'IO %' },
] as const;

function buildSeries(n: number): TimeSeries<typeof SCHEMA> {
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    // Three different "load profiles" — phases and frequencies
    // offset so the lines don't collapse onto each other.
    rows[i] = [
      1_000 + i,
      50 + 35 * Math.sin(i / 5_000) + 10 * Math.sin(i / 137),
      45 + 20 * Math.sin(i / 7_500 + 1.2) + 8 * Math.sin(i / 211 + 0.7),
      30 + 25 * Math.sin(i / 3_000 + 2.4) + 15 * Math.sin(i / 89 + 1.3),
    ];
  }
  return new TimeSeries({ name: 'M2', schema: SCHEMA, rows });
}

export function M2MultiColumnChart({ n }: { n: N }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stats, setStats] = useState({
    buildMs: 0,
    lastRenderMs: 0,
    medianRenderMs: 0,
    fps: 0,
    visibleRows: 0,
    totalRows: 0,
  });

  // Series + per-column packed-Float64Column references + cached
  // key column. The schema-narrowed `series.column(name)` returns
  // `Float64Column | ChunkedFloat64Column`; the `storage` check
  // (residual F1 friction from M1.1) still has to happen per
  // column for M1's data-built-from-rows path which is always
  // packed.
  //
  // M2-specific question: does iterating `COLUMNS` to extract
  // the three columns scale, or does the boilerplate per column
  // get tiring? See M2 friction note.
  const seriesData = useMemo(() => {
    const buildStart = performance.now();
    const series = buildSeries(n);
    const buildMs = performance.now() - buildStart;

    const keys = series.keyColumn();

    // Per-column extraction. Each column needs its own storage
    // check because pond-ts doesn't yet expose a storage-agnostic
    // `col.toFloat64Array()` (F1 / NF3 carry-forward). The check
    // is uniform across columns but it's three of them.
    const valueCols = COLUMNS.map((cfg) => {
      const col = series.column(cfg.name);
      if (col.storage !== 'packed') {
        throw new Error(
          `M2 expected packed Float64 for column '${cfg.name}'; got storage=${col.storage}`,
        );
      }
      return col;
    });

    return { series, keys, valueCols, buildMs };
  }, [n]);

  const [viewport, setViewport] = useState(() => {
    const xs = seriesData.keys.begin;
    return {
      start: xs[0]!,
      end: xs[xs.length - 1]! + 1,
    };
  });

  // Hover state — cursor X in CSS pixels, or null when not hovering.
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [canvasCssWidth, setCanvasCssWidth] = useState<number>(0);

  // Pre-allocated per-column { lo, hi } buffers for `col.bin(W,
  // 'minMax', { out })` (pond-ts 8c follow-up). Without this, each
  // frame allocates 6 × Float64Array(W) — at 60fps that's ~3MB/s
  // of allocation churn (W=1024). Pre-allocating once per
  // `cssWidth` and reusing across frames retires MF2's allocation
  // component.
  //
  // The chart-experiment M2.1 friction-note addendum quantifies the
  // measured win.
  const binBuffers = useMemo(() => {
    if (canvasCssWidth <= 0) return null;
    return COLUMNS.map(() => ({
      lo: new Float64Array(canvasCssWidth),
      hi: new Float64Array(canvasCssWidth),
    }));
  }, [canvasCssWidth]);

  // Hover readout shows the timestamp + value for EACH column at
  // the hovered row. Three `col.at(idx)` calls — exercises the
  // "per-column read" pattern the chart adapter cares about.
  const hover = useMemo(() => {
    if (hoverX === null || canvasCssWidth <= 0) return null;
    const xRange = viewport.end - viewport.start;
    const t = viewport.start + (hoverX / canvasCssWidth) * xRange;
    const idx = seriesData.series.bisect(new Time(t));
    if (idx < 0 || idx >= seriesData.series.length) return null;
    const time = seriesData.keys.at(idx);
    if (time === undefined) return null;
    // Per-column reads. The chart doesn't care about column-API
    // internals here — `at(idx)` returns the kind-narrowed value
    // per column.
    const values = seriesData.valueCols.map((col) => col.at(idx));
    if (values.some((v) => v === undefined)) return null;
    return { idx, time, values: values as number[] };
  }, [hoverX, canvasCssWidth, viewport, seriesData]);

  // Reset viewport when N changes.
  useEffect(() => {
    const xs = seriesData.keys.begin;
    setViewport({
      start: xs[0]!,
      end: xs[xs.length - 1]! + 1,
    });
    setStats((s) => ({ ...s, buildMs: seriesData.buildMs, totalRows: n }));
  }, [seriesData, n]);

  // Render loop.
  const renderSamples = useRef<number[]>([]);
  const lastFrameTimeRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    setCanvasCssWidth(cssWidth);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    let cancelled = false;

    function draw() {
      if (cancelled) return;
      if (!ctx) return;
      const drawStart = performance.now();

      const startIdx = seriesData.series.bisect(new Time(viewport.start));
      const endIdx = seriesData.series.bisect(new Time(viewport.end));
      const visible = endIdx - startIdx;

      ctx.clearRect(0, 0, cssWidth, cssHeight);

      if (visible <= 0) {
        recordFrame();
        return;
      }

      // Per-column slice. The substrate's alignment-by-construction
      // guarantees every column has the same `length` and `[startIdx,
      // endIdx)` maps to the same time range across all of them.
      // This is what makes the three-line chart possible without
      // re-keying per column.
      const slices = seriesData.valueCols.map((c) =>
        c.slice(startIdx, endIdx),
      );

      // Compute the SHARED Y extent — across all three columns'
      // visible windows. M2-specific friction: pond-ts gives us
      // `col.minMax()` per column but no `multiMinMax([a, b, c])`.
      // The chart adapter assembles its own shared extent.
      //
      // Three minMax() calls + an O(3) reduction is fine perf-wise,
      // but the SHAPE of the friction is interesting: the chart
      // wants a single shared scale, the library gives it per-
      // column reductions. Captured in M2 friction note.
      let yMin = Infinity;
      let yMax = -Infinity;
      for (const slice of slices) {
        const extent = slice.minMax();
        if (!extent) continue;
        if (extent[0] < yMin) yMin = extent[0];
        if (extent[1] > yMax) yMax = extent[1];
      }
      if (!Number.isFinite(yMin)) {
        recordFrame();
        return;
      }
      const yRange = yMax - yMin || 1;
      const xRange = viewport.end - viewport.start;

      // Per-column render. Each line gets its own stroke pass; the
      // visible-row count drives 1:1 vs per-pixel min/max
      // downsampling identically for every column.
      for (let c = 0; c < COLUMNS.length; c += 1) {
        const slice = slices[c]!;
        const cfg = COLUMNS[c]!;

        ctx.beginPath();
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth = 1;

        if (visible <= cssWidth) {
          // 1:1 — no downsampling. Raw .values from the packed
          // column slice (storage was checked at extraction time).
          // For chunked support, M3 will need a different path.
          const xs = seriesData.keys.begin.subarray(startIdx, endIdx);
          const ys = slice.values;
          for (let i = 0; i < xs.length; i += 1) {
            const px = ((xs[i]! - viewport.start) / xRange) * cssWidth;
            const py =
              cssHeight - ((ys[i]! - yMin) / yRange) * cssHeight;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
        } else {
          // Per-pixel min/max via the column-API, writing into the
          // pre-allocated per-column { lo, hi } buffer (no per-
          // frame allocation). M2.1 carry-forward from M2's MF2.
          const buf = binBuffers ? binBuffers[c] : undefined;
          const { lo, hi } = buf
            ? slice.bin(cssWidth, 'minMax', { out: buf })
            : slice.bin(cssWidth, 'minMax');
          for (let px = 0; px < cssWidth; px += 1) {
            const hiVal = hi[px]!;
            const loVal = lo[px]!;
            if (Number.isNaN(hiVal)) continue;
            const pyHi =
              cssHeight - ((hiVal - yMin) / yRange) * cssHeight;
            const pyLo =
              cssHeight - ((loVal - yMin) / yRange) * cssHeight;
            if (px === 0) ctx.moveTo(px, pyHi);
            ctx.lineTo(px, pyHi);
            ctx.lineTo(px, pyLo);
          }
        }
        ctx.stroke();
      }

      recordFrame();

      function recordFrame() {
        const drawMs = performance.now() - drawStart;
        renderSamples.current.push(drawMs);
        if (renderSamples.current.length > 30) renderSamples.current.shift();
        const samples = renderSamples.current.slice();
        samples.sort((a, b) => a - b);
        const medianRenderMs =
          samples[Math.floor(samples.length / 2)] ?? 0;

        const now = performance.now();
        const dt = now - lastFrameTimeRef.current;
        lastFrameTimeRef.current = now;
        const fps = dt > 0 ? 1000 / dt : 0;

        setStats((s) => ({
          ...s,
          lastRenderMs: drawMs,
          medianRenderMs,
          fps,
          visibleRows: visible,
          totalRows: n,
        }));
      }
    }

    draw();

    return () => {
      cancelled = true;
    };
  }, [seriesData, viewport, n, binBuffers]);

  // Pan + zoom + hover — same shape as M1.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dragging = false;
    let lastX = 0;

    function onDown(e: PointerEvent) {
      dragging = true;
      lastX = e.clientX;
      canvas?.setPointerCapture(e.pointerId);
    }
    function onMove(e: PointerEvent) {
      const rect = canvas?.getBoundingClientRect();
      if (rect) setHoverX(e.clientX - rect.left);
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      setViewport((v) => {
        const range = v.end - v.start;
        const cssWidth = canvas?.clientWidth ?? 1;
        const shift = (-dx / cssWidth) * range;
        return { start: v.start + shift, end: v.end + shift };
      });
    }
    function onUp(e: PointerEvent) {
      dragging = false;
      canvas?.releasePointerCapture(e.pointerId);
    }
    function onLeave() {
      setHoverX(null);
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = canvas?.getBoundingClientRect();
      if (!rect) return;
      const cssWidth = rect.width;
      const cursorX = e.clientX - rect.left;
      const cursorFrac = cursorX / cssWidth;
      const factor = Math.exp(e.deltaY * 0.001);
      setViewport((v) => {
        const range = v.end - v.start;
        const newRange = range * factor;
        const cursorTime = v.start + cursorFrac * range;
        return {
          start: cursorTime - cursorFrac * newRange,
          end: cursorTime + (1 - cursorFrac) * newRange,
        };
      });
    }

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          fontFamily: 'monospace',
          fontSize: 13,
          background: '#111',
          color: '#9f9',
          padding: '8px 12px',
          borderRadius: 4,
        }}
      >
        N={stats.totalRows.toLocaleString()} | visible=
        {stats.visibleRows.toLocaleString()} | build=
        {stats.buildMs.toFixed(1)} ms | render last=
        {stats.lastRenderMs.toFixed(2)} ms median=
        {stats.medianRenderMs.toFixed(2)} ms | {stats.fps.toFixed(0)} fps
      </div>
      {/* Legend — one chip per column. */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          fontFamily: 'monospace',
          fontSize: 12,
          color: '#aaa',
        }}
      >
        {COLUMNS.map((cfg) => (
          <span
            key={cfg.name}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                background: cfg.color,
                display: 'inline-block',
              }}
            />
            {cfg.label}
          </span>
        ))}
      </div>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: 500,
          background: '#1c1c1c',
          cursor: 'crosshair',
          touchAction: 'none',
        }}
      />
      {/*
        Hover readout — three values + timestamp. The friction
        question M2 surfaces here: pond-ts gave us `(col, idx) =>
        value` as the access primitive, and the chart composes N of
        them. Is that the right granularity, or does the chart
        want a "row-shaped" accessor that returns all column
        values at idx in one call? See M2 friction note.
      */}
      <div
        style={{
          fontFamily: 'monospace',
          fontSize: 13,
          background: '#111',
          color: hover ? '#ffe066' : '#666',
          padding: '8px 12px',
          borderRadius: 4,
          minHeight: 19,
        }}
      >
        {hover
          ? `idx=${hover.idx.toLocaleString()} | t=${new Date(hover.time).toISOString().slice(11, 23)} | ` +
            COLUMNS.map(
              (cfg, i) =>
                `${cfg.label}=${hover.values[i]!.toFixed(2)}`,
            ).join(' | ')
          : '— hover the chart to see the row at the cursor —'}
      </div>
    </div>
  );
}
