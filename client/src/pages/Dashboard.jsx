import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useLiveEvents } from '../live.js';
import { money, fmtTime, shiftDate, practiceToday } from '../format.js';
import { Badge } from '../components/ui.jsx';

export const FLAG_INFO = {
  new_patient: ['New patient', 'info'],
  birthday_today: ['🎂 Birthday today', 'ok'],
  birthday_this_week: ['🎂 Birthday this week', 'ok'],
  unconfirmed: ['Unconfirmed', 'warn'],
  verify_insurance: ['Verify insurance', 'warn'],
  update_medical_history: ['Update med history', 'warn'],
  forms_pending: ['Forms pending', 'warn'],
  lab_not_back: ['Lab case not back', 'danger'],
  recall_due: ['Recall due', 'info'],
  unscheduled_treatment: ['Unscheduled tx', 'info'],
  balance_due: ['Balance due', 'danger'],
};

const Stat = ({ label, value, sub, tone, to }) => {
  const body = (
    <div className={`card stat${tone ? ` stat-${tone}` : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
  return to ? <Link to={to} className="stat-link">{body}</Link> : body;
};

// "Today" — the morning huddle: what to know about every patient on the schedule.
export default function Dashboard() {
  const { user, practice, can } = useAuth();
  const nav = useNavigate();
  const today = practiceToday(practice?.timezone);
  const [date, setDate] = useState(today);
  const { data: h, reload } = useApi(`/huddle?date=${date}`, [date]);
  const { data: d } = useApi('/dashboard');
  const [filter, setFilter] = useState('');
  useLiveEvents((e) => e.type === 'schedule' && (!e.dates || e.dates.includes(date)) && reload());

  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: practice?.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const rows = (h?.rows || []).filter((r) => !filter || r.flags.includes(filter));
  const goalPct = h?.daily_goal ? Math.round((h.production / h.daily_goal) * 100) : null;
  const flagCounts = Object.fromEntries(Object.keys(FLAG_INFO).map((f) => [f, (h?.rows || []).filter((r) => r.flags.includes(f)).length]));

  return (
    <>
      {can('reports:own') && !can('reports:read') && <MyProduction />}
      <div className="page-header">
        <div>
          <h1>{date === today ? `${greeting}, ${user.name.split(' ')[0]}` : 'Huddle'}</h1>
          <div className="muted">{new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}{date === today ? ' · morning huddle' : ''}</div>
        </div>
        <div className="actions no-print">
          <button onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day">‹</button>
          <button className={date === today ? 'active' : ''} onClick={() => setDate(today)}>Today</button>
          <button onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day">›</button>
          <button onClick={() => window.print()}>Print huddle</button>
        </div>
      </div>

      {h && (
        <div className="grid grid-4">
          <Stat label="Scheduled production" value={money(h.production).replace('.00', '')}
            sub={h.daily_goal ? <><span className="goal-bar" style={{ width: 120 }}><i style={{ width: `${Math.min(100, goalPct)}%` }} /></span> {goalPct}% of {money(h.daily_goal).replace('.00', '')} goal</> : 'Set a daily goal in Settings'}
            tone={goalPct != null && goalPct >= 100 ? 'ok' : undefined} />
          <Stat label="Patients" value={h.summary.appointments} sub={`${h.summary.new_patients} new · ${h.summary.medical_alerts} with medical alerts`} to={`/schedule?date=${date}`} />
          <Stat label="Unconfirmed" value={h.summary.unconfirmed} sub="Send reminders from the schedule" tone={h.summary.unconfirmed ? 'warn' : 'ok'} />
          <Stat label="Balances to collect" value={money(h.summary.balances_to_collect).replace('.00', '')} sub="Family balances of today's patients" tone={h.summary.balances_to_collect ? 'danger' : undefined} />
          <Stat label="Unscheduled treatment" value={money(h.summary.unscheduled_treatment).replace('.00', '')} sub="Diagnosed for today's patients — schedule it" />
          <Stat label="Insurance to verify" value={h.summary.verify_insurance} sub="Not verified in 30 days" tone={h.summary.verify_insurance ? 'warn' : 'ok'} />
          {d?.recalls_due != null && <Stat label="Recalls due" value={d.recalls_due} to="/followups" sub="Work the follow-up list →" />}
          {d?.production != null && <Stat label="Production (month)" value={money(d.production).replace('.00', '')} sub={`Collections ${money(d.collections).replace('.00', '')}`} to="/reports" />}
        </div>
      )}

      <div className="card" style={{ marginTop: 16, padding: 0 }}>
        <div className="page-header" style={{ padding: '14px 16px', marginBottom: 0 }}>
          <h2 style={{ margin: 0 }}>Patients {date === today ? 'today' : 'this day'}</h2>
          <div className="chips no-print">
            <button className={`chip${!filter ? ' active' : ''}`} onClick={() => setFilter('')}>All {h?.rows.length ?? ''}</button>
            {Object.entries(FLAG_INFO).filter(([f]) => flagCounts[f]).map(([f, [label]]) => (
              <button key={f} className={`chip${filter === f ? ' active' : ''}`} onClick={() => setFilter(filter === f ? '' : f)}>{label} {flagCounts[f]}</button>
            ))}
          </div>
        </div>
        {!h ? <div className="empty">Loading…</div> : !rows.length ? <div className="empty">{h.rows.length ? 'Nobody matches this filter.' : 'No appointments.'}</div> : (
          <div className="huddle">
            {rows.map((r) => (
              <div key={r.id} className="huddle-row" style={{ '--c': r.type_color || r.provider_color }}>
                <div className="huddle-time">
                  <strong>{fmtTime(r.start_time)}</strong>
                  <span className="muted">{fmtTime(r.end_time)}</span>
                </div>
                <div className="huddle-main">
                  <div className="inline" style={{ flexWrap: 'wrap', gap: 6 }}>
                    <button className="link huddle-name" onClick={() => nav(`/patients/${r.patient_id}`)}>{r.first_name} {r.last_name}</button>
                    <Badge value={r.status} />
                    <span className="muted">{r.type_name} · {r.provider_name}{r.production ? ` · ${money(r.production).replace('.00', '')}` : ''}</span>
                  </div>
                  {(r.medical_alerts || r.allergies || r.office_alert) && (
                    <div className="inline" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                      {r.medical_alerts && <span className="alert-chip">⚠ {r.medical_alerts}</span>}
                      {r.allergies && <span className="alert-chip">Allergy: {r.allergies}</span>}
                      {r.office_alert && <span className="office-chip">📌 {r.office_alert}</span>}
                    </div>
                  )}
                  <div className="flag-row">
                    {r.flags.filter((f) => FLAG_INFO[f]).map((f) => (
                      <span key={f} className={`badge ${FLAG_INFO[f][1]}`}>
                        {FLAG_INFO[f][0]}
                        {f === 'balance_due' ? ` ${money(r.family_balance).replace('.00', '')}` : ''}
                        {f === 'unscheduled_treatment' ? ` ${money(r.unscheduled_amount).replace('.00', '')}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="huddle-actions no-print">
                  <Link to={`/appointments/${r.id}/route-slip`}><button className="small">Route slip</button></Link>
                  {can('schedule:read') && <Link to={`/schedule?date=${date}`}><button className="small">Schedule</button></Link>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// For people who may see only their own numbers.
function MyProduction() {
  const { data } = useApi('/reports/my-production');
  if (!data) return null;
  if (!data.providers.length) return <div className="muted" style={{ marginBottom: 8 }}>Ask an administrator to link your login to your provider record to see your production.</div>;
  return (
    <div className="grid grid-4" style={{ gap: 12, marginBottom: 12 }}>
      {[['Your production today', data.today], ['This month', data.month], ['This year', data.year]].map(([l, v]) => (
        <div key={l} className="card stat" style={{ margin: 0 }}><div className="label">{l}</div><div className="value">{money(v)}</div></div>
      ))}
    </div>
  );
}
