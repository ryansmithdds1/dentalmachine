import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, GraduationCap, Keyboard, Play, RotateCcw } from 'lucide-react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { toast } from '../../toast.js';
import { loadTours, searchTours, MY_ROLE } from './tourEngine.js';
import { startTour } from './TourProvider.jsx';
import { ROLES } from '../manual/manualData.js';

// Help → Show me: every guided walkthrough, by role or by area, most frequent first, with search. One click (or
// Enter on the first search result) starts it on the training patient. What you've completed is ticked.
export default function ShowMeBrowser({ q, setQ }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [me, setMe] = useState(null);
  const [by, setBy] = useState('role');
  const [resetting, setResetting] = useState(false);
  useEffect(() => { loadTours().then(setData, setError); }, []);
  useEffect(() => { api.get('/training/me').then(setMe).catch(() => setMe({ completed: {} })); }, []);
  const tours = useMemo(() => data?.tours || [], [data]);
  const found = useMemo(() => (q.trim() ? searchTours(tours, q, 50, { role: MY_ROLE[user?.role] }) : null), [tours, q, user?.role]);
  if (error) return <div className="error">{error.message}</div>;
  if (!data) return <div className="empty">Loading the walkthroughs…</div>;

  const mine = MY_ROLE[user?.role];
  const done = me?.completed || {};
  const groups = by === 'role'
    ? [...ROLES].sort(([a], [b]) => (b === mine) - (a === mine)).map(([key, label]) => ({ key, label: key === mine ? `${label} (you)` : label, list: tours.filter((t) => t.roles.includes(key) || (key !== 'everyone' && t.roles.includes('everyone'))) }))
    : [...new Set(tours.map((t) => t.area))].map((area) => ({ key: area, label: tours.find((t) => t.area === area).areaLabel, list: tours.filter((t) => t.area === area) }));
  const reset = async () => {
    setResetting(true);
    try {
      const r = await api.post('/training/patient/reset');
      toast(`Tess Training is back to a clean chart (${r.removed} practice record${r.removed === 1 ? '' : 's'} cleared)`);
    } catch (e) {
      toast(e.status === 404 ? 'There’s no training patient yet — it’s made the first time you start a walkthrough' : e.message, { tone: e.status === 404 ? 'ok' : 'error' });
    } finally { setResetting(false); }
  };
  const row = (t) => (
    <li key={t.id}>
      {done[t.id] ? <CheckCircle2 size={15} className="done-mark" aria-label="You’ve done this one" /> : <GraduationCap size={15} className="muted" aria-hidden />}
      <span className="showme-q">
        <button type="button" className="link" onClick={() => startTour(t.id)} data-tour-start={t.id}>{t.q}</button>
        {t.keyboard && <Keyboard size={13} className="manual-row-kbd" aria-label="works from the keyboard alone" />}
        <span className="muted"> · {t.steps.length} step{t.steps.length === 1 ? '' : 's'}{t.patient ? ' · on Tess Training' : t.effects === 'office' ? ' · real office screens' : ''}</span>
      </span>
      <Link to={`/help?how=${t.id}`} className="small muted">Read</Link>
      <button type="button" className="small" onClick={() => startTour(t.id)} aria-label={`Show me: ${t.q}`}><Play size={13} aria-hidden /> Show me</button>
    </li>
  );
  return (
    <div className="manual-browser">
      <input
        type="search" autoFocus placeholder="Show me how to… (e.g. schedule a new patient, change a recall, send a statement)" aria-label="Search the walkthroughs"
        value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && found?.[0]) startTour(found[0].id); }}
      />
      <div className="showme-bar no-print">
        <span className="muted">{tours.length} walkthroughs. You do each step yourself (or press <strong>Show me</strong> to watch it done), on <strong>Tess Training</strong> — a pretend patient: nothing leaves the office and nothing counts in reports.</span>
        <span style={{ flex: 1 }} />
        <Link to="/training"><button type="button" className="small">My training</button></Link>
        <button type="button" className="small" onClick={reset} disabled={resetting} title="Clears everything done to the training patient and starts it fresh"><RotateCcw size={13} aria-hidden /> Reset training patient</button>
      </div>
      {found ? (
        <div className="card">
          {found.length ? <ul className="showme-list">{found.map(row)}</ul> : <div className="empty">No walkthrough matches “{q}”. Try fewer words — or Help → How do I… has a page for every task.</div>}
        </div>
      ) : (
        <>
          <div className="manual-by no-print" role="group" aria-label="Group the walkthroughs">
            <span className="muted">Most frequent first · by</span>
            <button type="button" className={`small${by === 'role' ? ' active' : ''}`} aria-pressed={by === 'role'} onClick={() => setBy('role')}>role</button>
            <button type="button" className={`small${by === 'area' ? ' active' : ''}`} aria-pressed={by === 'area'} onClick={() => setBy('area')}>area</button>
          </div>
          <div className="manual-groups">
            {groups.filter((g) => g.list.length).map((g) => (
              <details key={g.key} className="card manual-group" open={by === 'role' ? g.key === mine || (!mine && g.key === 'front desk') : true}>
                <summary><strong>{g.label}</strong> <span className="muted">{g.list.length}</span></summary>
                <ul className="showme-list">{g.list.map(row)}</ul>
              </details>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
