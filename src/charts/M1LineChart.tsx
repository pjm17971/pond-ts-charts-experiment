// M1 — single-column line chart at scale (100k → 1M → 10M).
//
// Updated 2026-05-27: rewritten to use pond-ts's column-centric
// public API (Phase 4.7 step 8a/8b/8c). Diff vs the spike-accessor
// version (git log b814cbb) is the body of friction-notes/
// M1-column-api-adoption.md.
//
// What this version exercises:
//   - `series.column('value')` returns a schema-narrowed
//     `Float64Column | ChunkedFloat64Column` (no `| undefined`).
//     No `kind !== 'number'` check needed at the call site.
//   - The chart's per-pixel min/max downsampler collapses to
//     `col.bin(cssWidth, 'minMax')` — one method call returning
//     `{ lo, hi }` Float64Arrays of width `cssWidth`.
//   - Y-extent for axis scaling collapses to `col.minMax()`.
//   - `col.slice(startIdx, endIdx)` produces a zero-copy view
//     that's itself a Column — `.bin()` / `.minMax()` chain off it
//     cleanly.
//
// What still touches raw substrate:
//   - The 1:1 fast path (visible ≤ cssWidth) wants raw `Float64Array`
//     values for inline moveTo/lineTo. `col.scan(fn)` would work
//     storage-agnostically but the closure overhead is measurable
//     at 1M+ rows. M1's data is always packed (built from rows)
//     so we keep a single `storage === 'packed'` assertion at
//     extraction and use raw `.values` from there.
//   - `series.keyColumn().begin` for x-axis projection — raw
//     `Float64Array` is exactly what canvas wants. Step 8d
//     (`KeyColumn.slice`) will tidy this further; not needed yet.
//   - `series.bisect(new Time(ts))` for window resolution —
//     still a `KeyLike` argument. Friction item F3 (number-in,
//     number-out `bisectBegin`) is still outstanding.
//
// Architecture is unchanged:
//   - One <canvas> at fixed pixel size (devicePixelRatio-aware).
//   - Series cached via `useMemo`; only rebuilt when N changes.
//   - Viewport state drives the draw. Pan + zoom mutate viewport.
//   - Per-frame timing recorded for the stats overlay.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Time, TimeSeries } from 'pond-ts';

type N = 100_000 | 1_000_000 | 10_000_000;

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;

function buildSeries(n: number): TimeSeries<typeof SCHEMA> {
  // Build via the row-array path a real consumer would use —
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

  // Series + column + key-column raw view. `useMemo` recomputes only
  // when N changes.
  //
  // `series.column('value')` is now schema-narrowed:
  //   - schema declares `value` as `kind: 'number'`, so the return
  //     type is `Float64Column | ChunkedFloat64Column`.
  //   - no `| undefined` (RFC §7.2 — typos and key-column names
  //     fail to compile rather than returning undefined at runtime).
  //
  // Only the storage check remains — and only because the 1:1 path
  // wants raw `.values` for inline canvas draw. For series built
  // from rows this is always 'packed'; chunked surfaces only after
  // `concatSorted` and is M3's concern.
  const seriesData = useMemo(() => {
    const buildStart = performance.now();
    const series = buildSeries(n);
    const buildMs = performance.now() - buildStart;

    const valueCol = series.column('value');
    if (valueCol.storage !== 'packed') {
      // M1's data is always packed. Chunked → M3.
      throw new Error(
        `M1 expected a packed Float64 column; got storage=${valueCol.storage}`,
      );
    }
    const xs: Float64Array = series.keyColumn().begin;
    const ys: Float64Array = valueCol.values;
    return { series, valueCol, xs, ys, buildMs };
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

  // Render loop. Re-draws on viewport change. FPS counter samples
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

      // Resolve visible-window indices via bisect. Friction item F3
      // (`bisectBegin(number)`) is still outstanding — for now we
      // wrap raw timestamps in `Time` for the `KeyLike` argument.
      const startIdx = seriesData.series.bisect(new Time(viewport.start));
      const endIdx = seriesData.series.bisect(new Time(viewport.end));
      const visible = endIdx - startIdx;

      // Clear.
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      if (visible <= 0) {
        recordFrame();
        return;
      }

      // Column-centric slice. Zero-copy view via the substrate's
      // `sliceByRange`; the return type narrows to
      // `Float64Column | ChunkedFloat64Column` so the method chain
      // composes naturally.
      const visibleCol = seriesData.valueCol.slice(startIdx, endIdx);

      // Y extent for axis scaling — one call.
      // (Was: a manual `for` loop tracking lo/hi.)
      const extent = visibleCol.minMax();
      if (!extent) {
        recordFrame();
        return;
      }
      const [yMin, yMax] = extent;
      const yRange = yMax - yMin || 1;
      const xRange = viewport.end - viewport.start;

      ctx.beginPath();
      ctx.strokeStyle = '#3a8fff';
      ctx.lineWidth = 1;

      if (visible <= cssWidth) {
        // 1:1 — no downsampling. The chart still needs raw row-level
        // access for inline canvas draw; we use the cached raw
        // typed-array view (subarray over the packed Float64Array).
        const xs = seriesData.xs.subarray(startIdx, endIdx);
        const ys = seriesData.ys.subarray(startIdx, endIdx);
        for (let i = 0; i < xs.length; i += 1) {
          const px = ((xs[i]! - viewport.start) / xRange) * cssWidth;
          const py = cssHeight - ((ys[i]! - yMin) / yRange) * cssHeight;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      } else {
        // Per-pixel min/max. The chart's headline operation collapses
        // to one method call: `.bin(W, 'minMax')` returns
        // `{ lo: Float64Array(W), hi: Float64Array(W) }` — exactly
        // the stride-1 cache pattern the chart-experiment reviewer's
        // finding called for (see RFC §8).
        const { lo, hi } = visibleCol.bin(cssWidth, 'minMax');
        for (let px = 0; px < cssWidth; px += 1) {
          const hiVal = hi[px]!;
          const loVal = lo[px]!;
          if (Number.isNaN(hiVal)) continue; // empty bin — break sub-path
          const pyHi = cssHeight - ((hiVal - yMin) / yRange) * cssHeight;
          const pyLo = cssHeight - ((loVal - yMin) / yRange) * cssHeight;
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

    draw();

    return () => {
      cancelled = true;
    };
  }, [seriesData, viewport, n]);

  // Pan + zoom — unchanged from the spike-accessor version.
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
        N={stats.totalRows.toLocaleString()} | visible=
        {stats.visibleRows.toLocaleString()} | build=
        {stats.buildMs.toFixed(1)} ms | render last=
        {stats.lastRenderMs.toFixed(2)} ms median=
        {stats.medianRenderMs.toFixed(2)} ms | {stats.fps.toFixed(0)} fps
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
