import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Trophy, PhoneMissed, HelpCircle, AlertTriangle, ListChecks } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useLiveEvents } from '../live.js';
import { toast } from '../toast.js';
import { fmtDateTime, todayLocal, shiftDate } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';
import '../components/phones/phones.css';

// Phones (PH2-PH7): the team's leaderboard and coaching, missed calls (by day, hour, weekday × hour, line and
// who was on shift), why callers didn't book, upset-caller alerts, and the office's phone protocols. Scores are
// for coaching and training — never used for discipline on their own. People without the coaching permission see
// their own numbers only.
const TABS = [['team', 'Team', Trophy], ['missed', 'Missed calls', PhoneMissed], ['no_book', 'Why they didn’t book', HelpCircle], ['alerts', 'Alerts', AlertTriangle], ['protocols', 'Protocols', ListChecks]];
const n = (v, suffix = '') => (v == null ? '—' : `${v}${suffix}`);

export default function Phones() {
  const [tab, setTab] = useState('team');
  const [days, setDays] = useState(30);
  const to = todayLocal();
  const from = shiftDate(to, -(days - 1));
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Phones</h1>
          <div className="muted">How calls are answered and handled, measured against your own phone protocols. For coaching — never discipline. See every call in <Link to="/calls">Calls</Link>.</div>
        </div>
      </div>
      <div className="inline" style={{ margin: '12px 0', gap: 8 }}>
        <div className="tabs" style={{ margin: 0 }} role="tablist">
          {TABS.map(([k, l, Icon]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}><Icon size={14} /> {l}</button>)}
        </div>
        {['team', 'missed', 'no_book'].includes(tab) && (
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period"><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select>
        )}
      </div>
      {tab === 'team' && <Team from={from} to={to} />}
      {tab === 'missed' && <Missed from={from} to={to} />}
      {tab === 'no_book' && <NoBook from={from} to={to} />}
      {tab === 'alerts' && <Alerts />}
      {tab === 'protocols' && <Protocols />}
    </>
  );
}

function Team({ from, to }) {
  const { data, error } = useApi(`/phones/leaderboard?from=${from}&to=${to}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading…</div>;
  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: '10px 14px' }} className="muted">{data.note}{data.scope === 'own' ? ` You’re seeing your own numbers (${data.team_size} people answer phones).` : ''}</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Who</th><th>Position</th><th className="num">Calls taken</th><th className="num">Answer rate</th><th className="num">Secs to answer</th><th className="num">Missed</th><th className="num">Abandoned</th><th className="num">New patients booked</th><th className="num">Avg score</th></tr></thead>
          <tbody>
            {data.rows.map((p) => (
              <tr key={p.user_id}>
                <td>{p.rank}</td>
                <td><Link to={`/calls`} title="See their calls in Calls">{p.name}</Link></td>
                <td className="muted">{(p.position || '').replace('_', ' ')}</td>
                <td className="num">{p.handled}</td>
                <td className="num">{n(p.answer_rate, '%')}</td>
                <td className="num">{n(p.avg_seconds_to_answer)}</td>
                <td className="num">{p.missed}</td>
                <td className="num">{p.abandoned}</td>
                <td className="num">{p.new_patient_calls ? `${p.new_patient_booked}/${p.new_patient_calls} (${n(p.new_patient_booked_pct, '%')})` : '—'}</td>
                <td className="num">{n(p.avg_score)}{p.owner_rated ? <span className="ai-label" style={{ marginLeft: 4 }} title="Includes owner ratings">★</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.rows.length && <div className="empty">No calls taken in this period yet.</div>}
      </div>
    </div>
  );
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hourLabel = (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;
function Missed({ from, to }) {
  const { data, error } = useApi(`/phones/metrics?from=${from}&to=${to}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading…</div>;
  const t = data.totals;
  if (!t) return <div className="card muted">Practice-wide missed-call numbers are for managers. Your own: {data.people[0] ? `${data.people[0].missed} missed of ${data.people[0].rang} that rang while you were on (${n(data.people[0].answer_rate, '%')} answered).` : 'no calls yet.'}</div>;
  // Only the hours anything happened in, so the heatmap stays readable.
  const hours = data.by_hour.filter((h) => h.total).map((h) => h.hour);
  const span = hours.length ? Array.from({ length: Math.max(...hours) - Math.min(...hours) + 1 }, (_, i) => Math.min(...hours) + i) : [];
  const maxDay = Math.max(1, ...data.by_day.map((d) => d.rang));
  return (
    <>
      <div className="stat-strip">
        <div><strong>{t.total}</strong><span>calls in</span></div>
        <div><strong>{t.answered}</strong><span>answered</span></div>
        <div><strong>{t.missed}</strong><span>missed ({n(t.missed_pct, '%')})</span></div>
        <div><strong>{t.abandoned}</strong><span>hung up while ringing</span></div>
        <div><strong>{t.voicemail}</strong><span>voicemails</span></div>
        <div><strong>{t.callbacks}</strong><span>called back{t.callback_median_minutes != null ? ` (median ${t.callback_median_minutes} min)` : ''}</span></div>
        <div><strong>{t.texted_back}</strong><span>texted back</span></div>
      </div>
      <div className="phones-grid" style={{ marginTop: 12 }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Missed by weekday and hour</h3>
          <p className="muted" style={{ fontSize: 12 }}>Darker = a bigger share of calls missed. Hover for the numbers. Times are the office’s ({data.timezone}).</p>
          <div className="table-wrap">
            <table className="heatmap">
              <thead><tr><th />{span.map((h) => <th key={h}>{hourLabel(h)}</th>)}</tr></thead>
              <tbody>
                {data.heatmap.map((row, d) => (
                  <tr key={d}><th>{DOW[d]}</th>{span.map((h) => {
                    const c = row[h];
                    const share = c.total ? c.missed / c.total : 0;
                    return <td key={h} title={`${DOW[d]} ${hourLabel(h)}: ${c.missed} missed of ${c.total}`} style={{ background: c.total ? `color-mix(in srgb, var(--danger, #dc2626) ${Math.round(12 + share * 78)}%, transparent)` : undefined }}>{c.missed || ''}</td>;
                  })}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>By day</h3>
          <table>
            <thead><tr><th>Day</th><th className="num">Rang</th><th className="num">Missed</th><th style={{ width: '40%' }}>Missed %</th></tr></thead>
            <tbody>{data.by_day.map((d) => (
              <tr key={d.date} title={`${d.missed} of ${d.rang} missed`}><td>{d.date}</td><td className="num">{d.rang}</td><td className="num">{d.missed}</td>
                <td><div className="bar" style={{ width: `${Math.round(((d.missed_pct || 0) / 100) * 100)}%`, opacity: 0.4 + 0.6 * (d.rang / maxDay) }} /> <span className="muted" style={{ fontSize: 11 }}>{n(d.missed_pct, '%')}</span></td></tr>
            ))}</tbody>
          </table>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>By line</h3>
          <table><thead><tr><th>Line</th><th className="num">Calls</th><th className="num">Missed</th><th className="num">%</th></tr></thead>
            <tbody>{data.by_line.map((l) => <tr key={l.line}><td>{l.line}</td><td className="num">{l.total}</td><td className="num">{l.missed}</td><td className="num">{n(l.missed_pct, '%')}</td></tr>)}</tbody></table>
          <h3>Who should have answered</h3>
          <p className="muted" style={{ fontSize: 12 }}>Whoever took the call; otherwise the people who answer phones and were clocked in (or scheduled) then.</p>
          <table><thead><tr><th>Position / person</th><th className="num">Rang</th><th className="num">Missed</th><th className="num">%</th></tr></thead>
            <tbody>
              {data.by_position.map((p) => <tr key={p.position}><td><strong>{p.position.replace('_', ' ')}</strong></td><td className="num">{p.rang}</td><td className="num">{p.missed}</td><td className="num">{n(p.missed_pct, '%')}</td></tr>)}
              {(data.people || []).map((p) => <tr key={p.user_id}><td>{p.name}</td><td className="num">{p.rang}</td><td className="num">{p.missed}</td><td className="num">{p.rang ? n(Math.round((1000 * p.missed) / p.rang) / 10, '%') : '—'}</td></tr>)}
              {data.unattributed?.rang ? <tr><td className="muted">Nobody on shift</td><td className="num">{data.unattributed.rang}</td><td className="num">{data.unattributed.missed}</td><td className="num">{n(data.unattributed.missed_pct, '%')}</td></tr> : null}
            </tbody></table>
        </div>
      </div>
    </>
  );
}

function NoBook({ from, to }) {
  const { data, error } = useApi(`/phones/no-book?from=${from}&to=${to}`);
  const [reason, setReason] = useState(null);
  const { data: calls } = useApi(reason ? `/phones/calls?reason=${reason}&from=${from}&to=${to}` : null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading…</div>;
  const max = Math.max(1, ...data.reasons.map((r) => r.count));
  return (
    <div className="phones-grid">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Why callers didn’t book</h3>
        <p className="muted" style={{ fontSize: 12 }}>{data.total} calls with a confirmed reason{data.waiting ? ` · ${data.waiting} waiting for someone to confirm (Calls → Didn’t book)` : ''}. Click a reason to see its calls.</p>
        <table>
          <tbody>{data.reasons.map((r) => (
            <tr key={r.reason} style={{ cursor: 'pointer' }} onClick={() => setReason(r.reason)} title={`${r.count} calls (${n(r.pct, '%')})`}>
              <td style={{ width: 170 }}><button type="button" className="link">{r.label}</button></td>
              <td><div className="bar" style={{ width: `${(100 * r.count) / max}%` }} /></td>
              <td className="num">{r.count}</td><td className="num muted">{n(r.pct, '%')}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Week by week</h3>
        <table><thead><tr><th>Week of</th><th className="num">Total</th>{data.reasons.map((r) => <th key={r.reason} className="num">{r.label}</th>)}</tr></thead>
          <tbody>{data.trend.map((w) => <tr key={w.week}><td>{w.week}</td><td className="num">{w.total}</td>{data.reasons.map((r) => <td key={r.reason} className="num">{w[r.reason] || ''}</td>)}</tr>)}</tbody></table>
        {!data.trend.length && <div className="muted">Nothing yet.</div>}
      </div>
      {reason && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{data.reasons.find((r) => r.reason === reason)?.label} <button type="button" className="link small" onClick={() => setReason(null)}>close</button></h3>
          {(calls?.calls || []).map((c) => <div key={c.id} style={{ fontSize: 13, padding: '4px 0' }}><Link to={`/calls?open=${c.id}`}>{fmtDateTime(c.created_at)}</Link> · {c.first_name ? `${c.first_name} ${c.last_name}` : c.from_number}{c.summary ? <span className="muted"> — {c.summary}</span> : null}</div>)}
        </div>
      )}
    </div>
  );
}

function Alerts() {
  const { data, error, reload } = useApi('/phones/alerts');
  const [notes, setNotes] = useState({});
  useLiveEvents((e) => e.type === 'phone_alert' && reload());
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading…</div>;
  const ack = async (a) => {
    try { await api.post(`/phones/alerts/${a.id}/ack`, { note: notes[a.id] || null }); toast('Acknowledged'); reload(); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  return (
    <div className="card">
      {data.map((a) => (
        <div key={a.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
          <AlertTriangle size={14} /> <strong>{a.kind === 'upset' ? `Upset caller: ${a.first_name ? `${a.first_name} ${a.last_name}` : a.from_number || 'unknown'}` : 'Missed calls over target'}</strong>
          <span className="muted" style={{ fontSize: 12 }}> · {fmtDateTime(a.created_at)}</span>
          {a.quote && <div style={{ fontStyle: 'italic', fontSize: 13 }}>“{a.quote}”</div>}
          {a.detail && <div style={{ fontSize: 13 }}>{a.detail}</div>}
          <div className="inline" style={{ gap: 8, marginTop: 4 }}>
            {a.call_id && <Link className="small" to={`/calls?open=${a.call_id}`}>Listen</Link>}
            <input value={notes[a.id] || ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} placeholder="What you did (optional)" aria-label="Note" style={{ flex: 1, maxWidth: 320 }} />
            <button type="button" className="small primary" onClick={() => ack(a)}>Acknowledge</button>
          </div>
        </div>
      ))}
      {!data.length && <div className="empty">No open alerts.</div>}
    </div>
  );
}

function Protocols() {
  const { can } = useAuth();
  const { data, error, reload } = useApi('/phones/protocols');
  const { data: settings } = useApi('/phones/settings');
  const [edit, setEdit] = useState(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading…</div>;
  const coach = settings?.can_coach || can('phones:coach');
  const save = async (reset = false) => {
    try {
      await api.put(`/phones/protocols/${edit.call_type}`, reset ? { reset: true } : { name: edit.name, philosophy: edit.philosophy, steps: edit.steps });
      toast(reset ? 'Back to the starter protocol' : 'Protocol saved (earlier version kept)');
      setEdit(null); reload();
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const step = (i, patch) => setEdit({ ...edit, steps: edit.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <div className="phones-grid">
      {data.protocols.map((p) => (
        <div key={p.id} className="card">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>{p.label}: {p.name}</h3>
            {coach && edit?.id !== p.id && <button type="button" className="small" onClick={() => setEdit({ ...p, steps: p.steps.map((s) => ({ ...s, hints: (s.hints || []).join('\n') })) })}>Edit</button>}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>Version {p.version}{p.updated_by_name ? ` · ${p.updated_by_name}` : ''}</div>
          {edit?.id === p.id ? (
            <form onSubmit={(e) => { e.preventDefault(); save(); }}>
              <label>Name<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              <label>Our philosophy<textarea rows={2} value={edit.philosophy || ''} onChange={(e) => setEdit({ ...edit, philosophy: e.target.value })} /></label>
              <div className="muted" style={{ fontSize: 12, margin: '6px 0' }}>Steps: what good looks like, how much it counts (1-5), required or optional, and words that show it happened (one per line; /pattern/ allowed).</div>
              {edit.steps.map((s, i) => (
                <div key={i} className="protocol-step">
                  <input value={s.label} onChange={(e) => step(i, { label: e.target.value })} aria-label={`Step ${i + 1}`} />
                  <input type="number" min={1} max={5} value={s.weight} onChange={(e) => step(i, { weight: Number(e.target.value) })} aria-label="Weight" />
                  <label className="checkbox" style={{ fontSize: 12 }}><input type="checkbox" checked={!!s.required} onChange={(e) => step(i, { required: e.target.checked })} /> required</label>
                  <button type="button" className="link" aria-label="Remove step" onClick={() => setEdit({ ...edit, steps: edit.steps.filter((_, j) => j !== i) })}>×</button>
                  <textarea rows={1} value={s.hints} onChange={(e) => step(i, { hints: e.target.value })} aria-label="Words that show it" style={{ gridColumn: '1 / -1', fontSize: 12 }} />
                </div>
              ))}
              <div className="form-actions">
                <button type="button" className="small" onClick={() => setEdit({ ...edit, steps: [...edit.steps, { label: '', weight: 1, required: false, hints: '' }] })}>Add a step</button>
                <button type="button" className="small" onClick={() => save(true)}>Reset to starter</button>
                <button type="button" className="small" onClick={() => setEdit(null)}>Cancel</button>
                <button className="small primary">Save</button>
              </div>
            </form>
          ) : (
            <>
              {p.philosophy && <p style={{ fontSize: 13 }}>{p.philosophy}</p>}
              <ol style={{ fontSize: 13, paddingLeft: 18 }}>
                {p.steps.map((s) => <li key={s.key}>{s.label} <span className="muted">· {s.weight} pt{s.weight > 1 ? 's' : ''}{s.required ? ' · required' : ''}</span></li>)}
              </ol>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
