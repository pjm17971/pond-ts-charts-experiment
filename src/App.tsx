import { useState } from 'react';
import { M1LineChart } from './charts/M1LineChart';

type N = 100_000 | 1_000_000 | 10_000_000;

function App() {
  const [n, setN] = useState<N>(100_000);

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0 }}>pond-ts charts experiment — M1</h1>
      <p>
        Single-column line chart at scale. Pan with drag; zoom with wheel.
        See <code>friction-notes/M1-line-chart-scaling.md</code> for the
        report.
      </p>

      <div
        style={{
          marginBottom: 16,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <label>Row count:</label>
        {([100_000, 1_000_000, 10_000_000] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setN(option)}
            style={{
              padding: '6px 12px',
              background: n === option ? '#3a8fff' : '#222',
              color: n === option ? '#fff' : '#9f9',
              border: '1px solid #333',
              borderRadius: 4,
              fontFamily: 'monospace',
              cursor: 'pointer',
            }}
          >
            {option.toLocaleString()}
          </button>
        ))}
      </div>

      <M1LineChart n={n} />

      <details style={{ marginTop: 24, color: '#888' }}>
        <summary>Hint</summary>
        <ul>
          <li>Drag the canvas horizontally to pan.</li>
          <li>Scroll up to zoom in (smaller visible window), down to zoom out.</li>
          <li>
            Watch the stats bar — the median render time tells you the
            sustained frame budget cost; FPS shows real per-frame perf.
          </li>
          <li>
            At 10M rows the build cost is the dominant first-paint cost;
            steady-state render stays fast because the chart only walks
            the visible window via <code>bisect</code> +{' '}
            <code>subarray</code>.
          </li>
        </ul>
      </details>
    </div>
  );
}

export default App;
