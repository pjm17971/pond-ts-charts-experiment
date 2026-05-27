import { useState } from 'react';
import { M1LineChart } from './charts/M1LineChart';
import { M2MultiColumnChart } from './charts/M2MultiColumnChart';

type N = 100_000 | 1_000_000 | 10_000_000;
type Milestone = 'M1' | 'M2';

const MILESTONES: Record<Milestone, { title: string; description: string }> = {
  M1: {
    title: 'M1 — Single-column line chart at scale',
    description:
      'Single-column line chart scaling 100k → 1M → 10M. See friction-notes/M1-line-chart-scaling.md and M1-column-api-adoption.md.',
  },
  M2: {
    title: 'M2 — Multi-column overlay',
    description:
      'Three numeric columns (CPU / Mem / IO) sharing one time key. Three lines on one canvas, shared Y axis. See friction-notes/M2-multi-column-overlay.md.',
  },
};

function App() {
  const [n, setN] = useState<N>(100_000);
  const [milestone, setMilestone] = useState<Milestone>('M1');

  const meta = MILESTONES[milestone];

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0 }}>pond-ts charts experiment</h1>

      {/* Milestone picker */}
      <div
        style={{
          marginBottom: 16,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <label>Milestone:</label>
        {(['M1', 'M2'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMilestone(m)}
            style={{
              padding: '6px 12px',
              background: milestone === m ? '#3a8fff' : '#222',
              color: milestone === m ? '#fff' : '#9f9',
              border: '1px solid #333',
              borderRadius: 4,
              fontFamily: 'monospace',
              cursor: 'pointer',
            }}
          >
            {m}
          </button>
        ))}
      </div>

      <h2 style={{ marginTop: 0 }}>{meta.title}</h2>
      <p>{meta.description}</p>

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

      {milestone === 'M1' ? (
        <M1LineChart n={n} />
      ) : (
        <M2MultiColumnChart n={n} />
      )}

      <details style={{ marginTop: 24, color: '#888' }}>
        <summary>Hint</summary>
        <ul>
          <li>Drag the canvas horizontally to pan.</li>
          <li>
            Scroll up to zoom in (smaller visible window), down to zoom out.
          </li>
          <li>Hover the canvas to read the row at the cursor.</li>
          <li>
            At 10M rows the build cost is the dominant first-paint cost;
            steady-state render stays fast because the chart only walks the
            visible window via <code>bisect</code> + <code>slice</code>.
          </li>
          <li>
            M2's three lines all share the X key by construction — that's
            pond-ts's substrate alignment-by-construction in action.
          </li>
        </ul>
      </details>
    </div>
  );
}

export default App;
