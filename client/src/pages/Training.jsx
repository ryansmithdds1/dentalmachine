import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, GraduationCap, Play, RotateCcw, UserPlus } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { toast } from '../toast.js';
import { label, fmtDate } from '../format.js';
import { loadTours } from '../components/tours/tourEngine.js';
import { startTour } from '../components/tours/TourProvider.jsx';
import '../components/tours/tours.css';

// Manage → Training. "My training": the walkthroughs a manager gave me (my to-do list, with how far I've got) and
// what I've completed. "Team" (training:manage): who has done what, and giving someone a set of walkthroughs
// ("Front desk basics") — it appears on their list. Every start, finish and assignment is recorded (audited).
export default function Training() {
  const [params, setParams] = useSearchParams();
  const { data: me, reload } = useApi('/training/me');
  const [tours, setTours] = useState(null);
  useEffect(() => { loadTours().then((d) => setTours(d)).catch(() => setTours({ tours: [], sets: [] })); }, []);
  const byId = useMemo(() => Object.fromEntries((tours?.tours || []).map((t) => [t.id, t])), [tours]);
  const tab = params.get('tab') === 'team' && me?.can_manage ? 'team' : 'mine';
  // Coming back from a walkthrough: the list shows what was just finished.
  useEffect(() => { const f = () => reload(); window.addEventListener('focus', f); return () => window.removeEventListener('focus', f); }, [reload]);
  return (
    <>
      <div className="page-header"><div><h1>Training</h1><div className="muted">Guided walkthroughs on Tess Training, the practice patient — nothing done there is real.</div></div></div>
      {me?.can_manage && (
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'active' : ''} onClick={() => setParams({})}>My training</button>
          <button type="button" role="tab" aria-selected={tab === 'team'} className={tab === 'team' ? 'active' : ''} onClick={() => setParams({ tab: 'team' })}>Team</button>
        </div>
      )}
      {!me || !tours ? <div className="empty">Loading…</div> : tab === 'team' ? <Team byId={byId} sets={tours.sets} /> : <Mine me={me} byId={byId} reload={reload} />}
    </>
  );
}

const Bar = ({ pct }) => <span className="progress-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% done`}><span style={{ width: `${pct}%` }} /></span>;

function Mine({ me, byId }) {
  const done = me.completed || {};
  const title = (id) => byId[id]?.q || byId[id]?.title || id;
  return (
    <>
      {me.assignments.length ? me.assignments.map((a) => {
        const next = a.tours.find((t) => !done[t] && byId[t]);
        return (
          <div key={a.id} className="card" data-assignment={a.id}>
            <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <h2 style={{ margin: 0 }}>{a.title}</h2>
                <div className="muted small">{a.done.length} of {a.tours.length} done{a.due_on ? ` · by ${fmtDate(a.due_on)}` : ''}{a.assigned_by ? ` · from ${a.assigned_by}` : ''}</div>
              </div>
              <div className="inline" style={{ gap: 10 }}>
                <Bar pct={a.pct} /> <strong>{a.pct}%</strong>
                {next && <button type="button" className="primary small" onClick={() => startTour(next, { queue: a.tours.filter((t) => !done[t] && t !== next && byId[t]), queueTitle: a.title })}><Play size={13} aria-hidden /> {a.done.length ? 'Continue' : 'Start'}</button>}
              </div>
            </div>
            <ul className="showme-list" style={{ marginTop: 8 }}>
              {a.tours.map((t) => (
                <li key={t}>
                  {done[t] ? <CheckCircle2 size={15} className="done-mark" aria-label="Done" /> : <GraduationCap size={15} className="muted" aria-hidden />}
                  <span className="showme-q">{title(t)}{done[t] && <span className="muted small"> · done {fmtDate(String(done[t]).slice(0, 10))}</span>}</span>
                  {byId[t] ? <button type="button" className="small" onClick={() => startTour(t)}><Play size={13} aria-hidden /> {done[t] ? 'Again' : 'Show me'}</button> : <span className="muted small">not available</span>}
                </li>
              ))}
            </ul>
          </div>
        );
      }) : (
        <div className="card empty">Nothing assigned to you right now. Every walkthrough is in <Link to="/help?tab=showme">Help → Show me</Link>.</div>
      )}
      <div className="card">
        <h2>Done so far</h2>
        {Object.keys(done).length ? (
          <ul className="showme-list">
            {Object.entries(done).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).map(([id, at]) => (
              <li key={id}><CheckCircle2 size={15} className="done-mark" aria-hidden /><span className="showme-q">{title(id)}</span><span className="muted small">{fmtDate(String(at).slice(0, 10))}</span></li>
            ))}
          </ul>
        ) : <div className="muted">No walkthroughs finished yet. <Link to="/help?tab=showme">Pick one in Help → Show me</Link>.</div>}
      </div>
    </>
  );
}

function Team({ byId, sets }) {
  const { data, reload } = useApi('/training/team');
  const [assigning, setAssigning] = useState(null); // user id
  if (!data) return <div className="empty">Loading…</div>;
  const resetTess = async () => {
    try { const r = await api.post('/training/patient/reset'); toast(`Tess Training is back to a clean chart (${r.removed} practice records cleared)`); } catch (e) { toast(e.message, { tone: e.status === 404 ? 'ok' : 'error' }); }
  };
  const unassign = async (a) => {
    try {
      await api.post(`/training/assignments/${a.id}/cancel`);
      toast(`Took “${a.title}” off the list`);
      reload();
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  return (
    <>
      <div className="showme-bar">
        <span className="muted">Give someone a set of walkthroughs and it becomes their to-do list under Training. Progress counts walkthroughs they finished themselves.</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="small" onClick={resetTess}><RotateCcw size={13} aria-hidden /> Reset training patient</button>
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Person</th><th>Role</th><th>Assigned</th><th>Progress</th><th>Walkthroughs done</th><th>Last</th><th /></tr></thead>
          <tbody>
            {data.people.map((p) => (
              <tr key={p.id} data-person={p.id}>
                <td><strong>{p.name}</strong></td>
                <td>{label(p.role)}</td>
                <td>
                  {p.assignments.length ? p.assignments.map((a) => (
                    <div key={a.id} className="small">
                      {a.title} <span className="muted">({a.done.length}/{a.tours.length})</span>{' '}
                      <button type="button" className="link small" onClick={() => unassign(a)} aria-label={`Take ${a.title} off ${p.name}’s list`}>remove</button>
                    </div>
                  )) : <span className="muted small">—</span>}
                </td>
                <td>{p.pct == null ? <span className="muted small">—</span> : <span className="inline" style={{ gap: 6 }}><Bar pct={p.pct} /> {p.pct}%</span>}</td>
                <td>{Object.keys(p.completed).length}</td>
                <td className="muted small">{p.last_at ? fmtDate(p.last_at.slice(0, 10)) : '—'}</td>
                <td><button type="button" className="small" onClick={() => setAssigning(assigning === p.id ? null : p.id)} aria-expanded={assigning === p.id}><UserPlus size={13} aria-hidden /> Assign</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {assigning && <Assign person={data.people.find((x) => x.id === assigning)} sets={sets} byId={byId} onDone={() => { setAssigning(null); reload(); }} />}
      </div>
    </>
  );
}

// Inline (not a pop-up): a ready-made set for their role is chosen already; or pick walkthroughs one by one.
function Assign({ person, sets, byId, onDone }) {
  const roleSet = sets.find((s) => s.role === { front_desk: 'front desk', admin: 'office manager' }[person.role] || s.role === person.role);
  const [setKey, setSetKey] = useState(roleSet?.key || sets[0]?.key || '');
  const [picked, setPicked] = useState([]);
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const custom = setKey === 'custom';
  const all = Object.values(byId).sort((a, b) => (b.perDay || 0) - (a.perDay || 0));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = custom ? { user_id: person.id, tour_ids: picked, title: `Walkthroughs for ${person.name.split(' ')[0]}`, due_on: due || null } : { user_id: person.id, set_key: setKey, due_on: due || null };
      const made = await api.post('/training/assignments', { ...body, client_key: `${person.id}-${setKey}-${picked.join('.')}-${due}` });
      toast(`${person.name} has “${made.title}” on their list`);
      onDone();
    } catch (err) { toast(err.message, { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <form className="inline-panel" onSubmit={save} aria-label={`Assign training to ${person.name}`} style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong>Assign to {person.name}</strong>
      <label>Walkthroughs
        <select value={setKey} onChange={(e) => setSetKey(e.target.value)} aria-label="Training set">
          {sets.map((s) => <option key={s.key} value={s.key}>{s.title} ({s.tours.length})</option>)}
          <option value="custom">Choose them one by one…</option>
        </select>
      </label>
      {custom && (
        <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 6 }}>
          {all.map((t) => (
            <label key={t.id} className="inline small" style={{ gap: 6 }}>
              <input type="checkbox" checked={picked.includes(t.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, t.id] : picked.filter((x) => x !== t.id))} /> {t.q}
            </label>
          ))}
        </div>
      )}
      <label>Finish by (optional)<input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Finish by" /></label>
      <div className="inline" style={{ gap: 6 }}>
        <button type="submit" className="primary small" disabled={busy || (custom && !picked.length)}>Assign</button>
        <button type="button" className="small" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
