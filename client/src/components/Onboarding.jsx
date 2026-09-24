import { Link } from 'react-router-dom';
import { CheckCircle2, Circle } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';

// Getting started: what's left to set up, each step checking itself off. For administrators on Today.
export default function Onboarding() {
  const { data, reload } = useApi('/onboarding');
  if (!data || data.dismissed || data.done === data.total) return null;
  const groups = [...new Set(data.steps.map((s) => s.group))];
  const next = data.steps.find((s) => !s.done);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Getting set up · {data.done} of {data.total}</h2>
        <div className="inline" style={{ gap: 8 }}>
          <Link to="/help">Help</Link>
          <button className="link" onClick={async () => { await api.post('/onboarding/dismiss'); reload(); }}>Hide</button>
        </div>
      </div>
      <span className="goal-bar" style={{ width: '100%', margin: '8px 0' }}><i style={{ width: `${Math.round((data.done / data.total) * 100)}%` }} /></span>
      {next && <div style={{ marginBottom: 8 }}>Next: <Link to={next.link}><strong>{next.title}</strong> →</Link></div>}
      <div className="grid grid-4" style={{ fontSize: 13 }}>
        {groups.map((g) => (
          <div key={g}>
            <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>{g}</div>
            {data.steps.filter((s) => s.group === g).map((s) => (
              <div key={s.key} className="inline" style={{ gap: 6, padding: '3px 0', alignItems: 'flex-start' }}>
                {s.done ? <CheckCircle2 size={15} color="var(--ok)" style={{ flexShrink: 0, marginTop: 1 }} /> : <Circle size={15} color="var(--muted)" style={{ flexShrink: 0, marginTop: 1 }} />}
                {s.done ? <span className="muted">{s.title}</span> : <Link to={s.link}>{s.title}</Link>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
