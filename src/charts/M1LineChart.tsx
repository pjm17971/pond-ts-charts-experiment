// M1 — single-column line chart at scale (100k → 1M → 10M).
//
// What this validates from pond-ts/docs/notes/chart-spike-friction.md:
//   - The substrate is reachable: `series.column('value').values`
//     returns a `Float64Array` ready for canvas draw.
//   - Range slicing for zoom (friction item #3): use `series.bisect()`
//     to find visible-window row indices, then `subarray()` for a
//     zero-copy view.
//   - The "kind/storage dispatch boilerplate" (friction item #1) gets
//     written by a real consumer here, in real code we can quote in
//     the friction note.
//
// Architecture:
//   - One <canvas> at a fixed pixel size (devicePixelRatio-aware).
//   - Series + extracted typed arrays cached via `useMemo`; only
//     rebuilt when N changes.
//   - Viewport state (x-range) drives the draw. Pan + zoom mutate
//     the viewport; a `requestAnimationFrame` loop re-draws when
//     `needsRedraw` flips.
//   - Per-frame timing recorded for the stats overlay.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Time, TimeSeries } from 'pond-ts';

type N = 100_000 | 1_000_000 | 10_000_000;

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;

function buildSeries(n: number): TimeSeries<typeof SCHEMA> {
  // Build via the same row-array path a real consumer would —
  // post-2c column-native intake handles this efficiently.
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    rows[i] = [
      1_000 + i,
      // Synthetic but visually interesting: low-freq + medium-freq sines.
      50 * Math.sin(i / 5_000) + 15 * Math.sin(i / 137),
    ];
  }
  return new TimeSeries({ name: 'M1', schema: SCHEMA, rows });
}

export function M1LineChart({ n }: { n: N }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stats, setStats] = useState({
    buildMs: 0,
    lastRenderMs: 0,
    medianRenderMs: 0,
    fps: 0,
    visibleRows: 0,
    totalRows: 0,
  });

  // Series + extracted typed arrays. `useMemo` recomputes only when N
  // changes. The kind/storage dispatch (friction item #1) shows up here:
  // the chart code has to verify the schema's value column is the
  // expected packed Float64 shape before reaching `.values`.
  const seriesData = useMemo(() => {
    const buildStart = performance.now();
    const series = buildSeries(n);
    const buildMs = performance.now() - buildStart;

    const valueCol = series.column('value');
    if (!valueCol || valueCol.kind !== 'number' || valueCol.storage !== 'packed') {
      // M1 only handles packed Float64. A real chart would `materialize`
      // chunked or surface a fallback path. Captured as friction item #4.
      throw new Error(
        `M1 expected a packed Float64 'value' column; got kind=${valueCol?.kind} storage=${valueCol?.storage}`,
      );
    }
    const xs: Float64Array = series.keyColumn().begin;
    const ys: Float64Array = valueCol.values;
    return { series, xs, ys, buildMs };
  }, [n]);

  // Viewport state. `start` / `end` are inclusive begin / exclusive end
  // millisecond timestamps. Initial viewport covers the full series.
  const [viewport, setViewport] = useState(() => ({
    start: seriesData.xs[0]!,
    end: seriesData.xs[seriesData.xs.length - 1]! + 1,
  }));

  // Reset viewport when N changes.
  useEffect(() => {
    setViewport({
      start: seriesData.xs[0]!,
      end: seriesData.xs[seriesData.xs.length - 1]! + 1,
    });
    setStats((s) => ({ ...s, buildMs: seriesData.buildMs, totalRows: n }));
  }, [seriesData, n]);

  // Render loop. Re-draws on viewport change. The FPS counter samples
  // recent frame intervals to surface frame-budget pressure.
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
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    let cancelled = false;

    function draw() {
      if (cancelled) return;
      if (!ctx) return;
      const drawStart = performance.now();

      // Find the visible-window row indices via bisect. Friction
      // item #3: chart wants a `series.window(t0, t1)` convenience.
      // For now: two bisect calls, one per endpoint.
      const startIdx = seriesData.series.bisect(new Time(viewport.start));
      const endIdx = seriesData.series.bisect(new Time(viewport.end));
      const visible = endIdx - startIdx;

      // Slice the typed arrays (zero-copy subarray views).
      const xs = seriesData.xs.subarray(startIdx, endIdx);
      const ys = seriesData.ys.subarray(startIdx, endIdx);

      // Clear.
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      if (xs.length === 0) {
        // empty window — nothing to draw
        recordFrame();
        return;
      }

      // Compute Y extent for this slice. Could be cached if hot;
      // computing per frame is fine for the pan/zoom story.
      let yMin = ys[0]!;
      let yMax = yMin;
      for (let i = 1; i < ys.length; i += 1) {
        const v = ys[i]!;
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
      const yRange = yMax - yMin || 1;
      const xRange = viewport.end - viewport.start;

      // Pixel-bucket downsampling: render at most one (min, max) line
      // per pixel column. Without this, > 1M points = millions of
      // sub-pixel lineTo calls and the browser stalls. The bucket
      // size is `visible / cssWidth` rows per pixel.
      ctx.beginPath();
      ctx.strokeStyle = '#3a8fff';
      ctx.lineWidth = 1;

      if (visible <= cssWidth) {
        // 1:1 — no downsampling.
        for (let i = 0; i < xs.length; i += 1) {
          const px = ((xs[i]! - viewport.start) / xRange) * cssWidth;
          const py = cssHeight - ((ys[i]! - yMin) / yRange) * cssHeight;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      } else {
        // Per-pixel min/max. For each pixel column, scan the rows
        // mapped to it and draw a vertical line from min to max.
        const rowsPerPixel = visible / cssWidth;
        for (let px = 0; px < cssWidth; px += 1) {
          const startRow = Math.floor(px * rowsPerPixel);
          const endRow = Math.min(
            Math.floor((px + 1) * rowsPerPixel),
            ys.length,
          );
          if (startRow >= endRow) continue;
          let lo = ys[startRow]!;
          let hi = lo;
          for (let i = startRow + 1; i < endRow; i += 1) {
            const v = ys[i]!;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          const pyLo = cssHeight - ((lo - yMin) / yRange) * cssHeight;
          const pyHi = cssHeight - ((hi - yMin) / yRange) * cssHeight;
          if (px === 0) ctx.moveTo(px, pyHi);
          ctx.lineTo(px, pyHi);
          ctx.lineTo(px, pyLo);
        }
      }
      ctx.stroke();

      recordFrame();

      function recordFrame() {
        const drawMs = performance.now() - drawStart;
        renderSamples.current.push(drawMs);
        if (renderSamples.current.length > 30) renderSamples.current.shift();
        const samples = renderSamples.current.slice();
        samples.sort((a, b) => a - b);
        const medianRenderMs = samples[Math.floor(samples.length / 2)] ?? 0;

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

    // Initial draw + redraw whenever viewport changes (handled via
    // the parent useEffect dep array).
    draw();

    return () => {
      cancelled = true;
    };
  }, [seriesData, viewport, n]);

  // Pan + zoom. Pointer-event pan; wheel zoom (delta y → log-scale
  // factor around the cursor).
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
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
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
        N={stats.totalRows.toLocaleString()} | visible={stats.visibleRows.toLocaleString()} |
        build={stats.buildMs.toFixed(1)} ms |
        render last={stats.lastRenderMs.toFixed(2)} ms median={stats.medianRenderMs.toFixed(2)} ms |
        {stats.fps.toFixed(0)} fps
      </div>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: 500,
          background: '#1c1c1c',
          cursor: 'grab',
          touchAction: 'none',
        }}
      />
    </div>
  );
}
