import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Flag, Flame, CheckCircle2, AlertTriangle, Clock, TimerOff, Gauge } from 'lucide-react';
import { api } from '../../api.js';
import { useLookup } from '../../hooks.js';
import { fmtDate } from '../../format.js';
import { toast } from '../../toast.js';
import { useLiveEvents } from '../../live.js';
import { ErrorBox } from '../ui.jsx';
import { OccurrenceDrawer, StateChip, CriticalChip, resultText, time12 } from './shared.jsx';
import './checklists.css';

const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

// The owner / office manager's view (RCL3): what's done, late and missed today or this week, by position and by
// person, streaks, an 8-week on-time trend, open flags (resolved here with the corrective action), and the
// evidence behind any item (click it).
export default function ChecklistDashboard() {
  const [range, setRange] = useState('week');
  const [office, setOffice] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [actions, setActions] = useState({});
  const locations = useLookup('/locations');
  const load = useCallback(async () => {
    try {
      const base = await api.get(`/checklists/dashboard${office ? `?location_id=${office}` : ''}`);
      let d = base;
      if (range !== 'week') {
        const from = range === 'today' ? base.today : addDays(base.today, -29);
        d = await api.get(`/checklists/dashboard?from=${from}&to=${base.today}${office ? `&location_id=${office}` : ''}`);
      }
      setData(d);
      setError(null);
    } catch (e) { setError(e); }
  }, [range, office]);
  useEffect(() => { load(); }, [load]);
  const timer = useRef(null);
  useLiveEvents((e) => {
    if (e.type !== 'checklists' && e.type !== 'checklist_alert') return;
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 500);
  });

  const resolve = async (f) => {
    try {
      await api.post(`/checklists/flags/${f.id}/resolve`, { action: actions[f.id] || '' });
      toast('Flag resolved — corrective action recorded');
      setActions((a) => ({ ...a, [f.id]: '' }));
      load();
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };

  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const t = data.totals;
  const byPosition = new Map();
  for (const o of data.today_items) {
    if (!byPosition.has(o.position_name)) byPosition.set(o.position_name, []);
    byPosition.get(o.position_name).push(o);
  }
  return (
    <div>
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div className="seg" role="group" aria-label="Period">
          {[['today', 'Today'], ['week', 'This week'], ['30', 'Last 30 days']].map(([k, l]) => <button key={k} className={range === k ? 'active' : ''} onClick={() => setRange(k)}>{l}</button>)}
        </div>
        <div className="actions">
          {locations.length > 1 && (
            <select value={office} onChange={(e) => setOffice(e.target.value)} aria-label="Office">
              <option value="">All offices</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
          <span className="muted" style={{ fontSize: 13 }}>{fmtDate(data.from)}{data.from !== data.to ? ` – ${fmtDate(data.to)}` : ''}</span>
        </div>
      </div>

      {data.flags.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Flag size={18} aria-hidden /> Open flags <span className="count">{data.flags.length}</span></h2>
          <p className="muted" style={{ marginTop: -6, fontSize: 13 }}>Each stays open until you write down what was done about it.</p>
          {data.flags.map((f) => (
            <div key={f.id} className={`cl-flag${f.critical ? ' critical' : ''}`}>
              <h4>{f.critical ? <AlertTriangle size={15} aria-hidden /> : <Flag size={14} aria-hidden />} {f.title}</h4>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {f.position_name} · raised {f.raised_at} UTC{f.completed_by_name ? ` · recorded by ${f.completed_by_name}` : ''} · <button className="link" onClick={() => setOpenId(f.occurrence_id)}>See the item and evidence</button>
              </div>
              <textarea aria-label={`Corrective action for ${f.title}`} placeholder="Corrective action taken (e.g. sterilizer out of service, serviced, 3 retests passed, loads reprocessed)" value={actions[f.id] || ''} onChange={(e) => setActions((a) => ({ ...a, [f.id]: e.target.value }))} />
              <button className="primary small" style={{ marginTop: 6 }} disabled={(actions[f.id] || '').trim().length < 5} onClick={() => resolve(f)}>Resolve</button>
            </div>
          ))}
        </div>
      )}

      <div className="cl-kpis">
        <Kpi icon={<Gauge size={14} />} value={t.rate == null ? '—' : `${t.rate}%`} label="On time" />
        <Kpi icon={<CheckCircle2 size={14} />} value={t.done} label="Done on time" />
        <Kpi icon={<Clock size={14} />} value={t.late} label="Done late" />
        <Kpi icon={<TimerOff size={14} />} value={t.missed} label="Missed" />
        <Kpi icon={<AlertTriangle size={14} />} value={t.overdue} label="Overdue now" />
      </div>

      <div className="cl-grid2">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>By position</h2>
          <Table rows={data.positions} />
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>By person</h2>
          <Table rows={data.people} extra={data.unassigned.total ? { name: 'Unassigned', counts: data.unassigned } : null} />
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>On time, last 8 weeks</h2>
          <Trend weeks={data.trend} />
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Today</h2>
          {!data.today_items.length && <p className="muted">Nothing due today.</p>}
          {[...byPosition].map(([pos, list]) => (
            <div key={pos} style={{ marginBottom: 10 }}>
              <div className="cl-section" style={{ marginTop: 6 }}>{pos} · {list.filter((o) => o.status === 'done').length}/{list.length}</div>
              {list.map((o) => (
                <div key={o.id} className="cl-board-row" role="button" tabIndex={0} onClick={() => setOpenId(o.id)} onKeyDown={(e) => e.key === 'Enter' && setOpenId(o.id)}>
                  <StateChip state={o.state} />
                  <span className="t">{o.title}{o.critical ? <> <CriticalChip /></> : null}</span>
                  <span className="muted" style={{ fontSize: 12.5 }}>{o.status === 'done' ? `${resultText(o) ? `${resultText(o)} · ` : ''}${o.completed_by_name}` : `${o.assigned_name || 'anyone'} · ${time12(o.due_at.slice(11))}`}{o.location_name ? ` · ${o.location_name}` : ''}</span>
                </div>
              ))}
            </div>
          ))}
          {data.overdue.length > 0 && (
            <>
              <div className="cl-section">Still open from earlier days</div>
              {data.overdue.map((o) => (
                <div key={o.id} className="cl-board-row" role="button" tabIndex={0} onClick={() => setOpenId(o.id)} onKeyDown={(e) => e.key === 'Enter' && setOpenId(o.id)}>
                  <StateChip state="overdue" /><span className="t">{o.title}</span><span className="muted" style={{ fontSize: 12.5 }}>due {fmtDate(o.due_date)} · {o.position_name}</span>
                </div>
              ))}
            </>
          )}
          <p style={{ marginTop: 12 }}><Link to="/checklists/log">Compliance log and exports →</Link></p>
        </div>
      </div>
      {openId && <OccurrenceDrawer id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

const Kpi = ({ icon, value, label }) => <div className="cl-kpi"><div className="v">{value}</div><div className="l">{icon}{label}</div></div>;

function Table({ rows, extra }) {
  if (!rows.length && !extra) return <p className="muted">Nothing due in this period.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
    <table className="cl-table">
      <thead><tr><th>Name</th><th className="n">Done</th><th className="n">Late</th><th className="n">Missed</th><th>On time</th><th className="n" title="Days in a row with everything done on time">Streak</th></tr></thead>
      <tbody>
        {[...rows, ...(extra ? [extra] : [])].map((r) => (
          <tr key={r.id ?? 'none'}>
            <td>{r.name}</td>
            <td className="n">{r.counts.done}</td>
            <td className="n">{r.counts.late || ''}</td>
            <td className="n" style={{ color: r.counts.missed + r.counts.overdue ? 'var(--danger)' : undefined }}>{r.counts.missed + r.counts.overdue || ''}</td>
            <td><div className="cl-rate"><span className="bar"><i style={{ width: `${r.counts.rate ?? 0}%` }} /></span><span style={{ fontSize: 12 }}>{r.counts.rate == null ? '—' : `${r.counts.rate}%`}</span></div></td>
            <td className="n">{r.streak != null && <span className="cl-streak" title={`${r.streak} day${r.streak === 1 ? '' : 's'} in a row`}>{r.streak > 0 && <Flame size={13} aria-hidden />}{r.streak}</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

// One series (share done on time per week): single colour, no legend; each bar says its numbers on hover.
function Trend({ weeks }) {
  return (
    <>
      <div className="cl-trend" role="img" aria-label={`On-time rate by week: ${weeks.map((w) => `${fmtDate(w.week)} ${w.rate ?? 'none'}${w.rate == null ? '' : '%'}`).join(', ')}`}>
        {weeks.map((w) => (
          <div key={w.week} className={`col${w.rate == null ? ' none' : ''}`} title={`Week of ${fmtDate(w.week)}: ${w.due ? `${w.on_time} of ${w.due} on time (${w.rate}%), ${w.late} late, ${w.missed} missed` : 'nothing due'}`}>
            <span className="pct">{w.rate == null ? '' : `${w.rate}%`}</span>
            <i style={{ height: `${w.rate == null ? 2 : Math.max(2, w.rate)}%` }} />
          </div>
        ))}
      </div>
      <div className="cl-trend-x">{weeks.map((w) => <span key={w.week}>{w.week.slice(5).replace('-', '/')}</span>)}</div>
    </>
  );
}
