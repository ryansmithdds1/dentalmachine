import { useEffect, useState } from 'react';
import { api, download } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtDate, practiceToday, shiftDate } from '../format.js';
import { ErrorBox, Modal, useSubmit } from './ui.jsx';

const hm = (t) => (t ? t.slice(11, 16) : '—');
const dur = (m) => (m == null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);
const monday = (d) => shiftDate(d, -((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7));

// Sidebar button: clock in, or see how long you've been in and clock out.
export function ClockButton() {
  const [me, setMe] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api.get('/timeclock/me').then(setMe).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 5 * 60_000); return () => clearInterval(t); }, []);
  if (!me) return null;
  const go = async () => {
    setErr(null);
    try {
      if (me.clocked_in) {
        const brk = window.prompt('Minutes of unpaid break this shift?', '0');
        if (brk === null) return;
        await api.post('/timeclock/out', { break_minutes: Number(brk) || 0 });
      } else await api.post('/timeclock/in');
      load();
    } catch (e) { setErr(e.message); }
  };
  return (
    <div className="clock-button">
      <button className="small" onClick={go}>{me.clocked_in ? `Clock out (in since ${hm(me.clocked_in)})` : 'Clock in'}</button>
      <div style={{ fontSize: 11 }}>{me.week_hours}h this week</div>
      {err && <div className="error-text" style={{ fontSize: 11 }}>{err}</div>}
    </div>
  );
}

// To-do & labs → Time clock: your timesheet, or everyone's for managers, with fixes and the payroll export.
export default function TimeClock() {
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [from, setFrom] = useState(() => monday(today));
  const [to, setTo] = useState(today);
  const [who, setWho] = useState('');
  const { data, reload } = useApi(`/timeclock?from=${from}&to=${to}${who ? `&user_id=${who}` : ''}`);
  const users = useLookup('/users');
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState(null);
  if (!data) return <div className="card">Loading…</div>;
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{data.manager ? 'Timesheets' : 'My timesheet'}</h2>
        <div className="inline" style={{ flexWrap: 'wrap' }}>
          <button className="small" onClick={() => { setFrom(monday(today)); setTo(today); }}>This week</button>
          <button className="small" onClick={() => { const m = shiftDate(monday(today), -7); setFrom(m); setTo(shiftDate(m, 6)); }}>Last week</button>
          <input type="date" aria-label="From" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          <input type="date" aria-label="To" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
          {data.manager && (
            <>
              <select aria-label="Person" value={who} onChange={(e) => setWho(e.target.value)} style={{ width: 'auto' }}>
                <option value="">Everyone</option>
                {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <button className="small" onClick={() => setEditing({ user_id: who || users[0]?.id, clock_in: `${today} 08:00`, clock_out: `${today} 17:00`, break_minutes: 30 })}>+ Missed shift</button>
              <button className="small" onClick={() => download(`/timeclock/payroll.csv?from=${from}&to=${to}`, `payroll-${from}-to-${to}.csv`).catch(setErr)}>⬇ Payroll CSV</button>
            </>
          )}
        </div>
      </div>
      <ErrorBox error={err} />
      {data.summary.length > 0 && (
        <table className="compact-table" style={{ marginTop: 10 }}>
          <thead><tr><th>Person</th><th className="num">Regular</th><th className="num">Overtime</th><th className="num">Total</th><th /></tr></thead>
          <tbody>{data.summary.map((s) => <tr key={s.user_id}><td>{s.name}</td><td className="num">{s.regular_hours}h</td><td className="num">{s.overtime_hours}h</td><td className="num"><strong>{s.hours}h</strong></td><td>{s.open_punches ? <span className="error-text">{s.open_punches} still clocked in</span> : ''}</td></tr>)}</tbody>
        </table>
      )}
      <table className="compact-table" style={{ marginTop: 14 }}>
        <thead><tr>{data.manager && <th>Person</th>}<th>Day</th><th>In</th><th>Out</th><th>Break</th><th className="num">Worked</th><th /></tr></thead>
        <tbody>
          {data.punches.map((p) => (
            <tr key={p.id}>
              {data.manager && <td>{p.user_name}</td>}
              <td>{fmtDate(p.clock_in.slice(0, 10))}</td><td>{hm(p.clock_in)}</td><td>{p.clock_out ? hm(p.clock_out) : <em>clocked in</em>}</td>
              <td>{p.break_minutes ? `${p.break_minutes}m` : '—'}</td><td className="num">{dur(p.minutes)}</td>
              <td>{p.edited_by_name && <span className="muted" style={{ fontSize: 11 }} title={p.note || ''}>fixed by {p.edited_by_name}</span>} {data.manager && <button className="small" onClick={() => setEditing(p)}>Fix</button>}</td>
            </tr>
          ))}
          {!data.punches.length && <tr><td colSpan={7} className="muted">No time recorded in these dates.</td></tr>}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 12 }}>Overtime is hours past 40 in a Monday–Sunday week. Check your state’s rules (some count daily overtime) before running payroll.</p>
      {editing && <PunchForm init={editing} users={users} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function PunchForm({ init, users, onClose, onDone }) {
  const [f, setF] = useState({ ...init, clock_in: init.clock_in.replace(' ', 'T'), clock_out: (init.clock_out || '').replace(' ', 'T') });
  const body = () => ({ clock_in: f.clock_in, clock_out: f.clock_out || null, break_minutes: Number(f.break_minutes) || 0, note: f.note || null });
  const save = useSubmit(async () => {
    if (init.id) await api.put(`/timeclock/punches/${init.id}`, body());
    else await api.post('/timeclock/punches', { ...body(), user_id: Number(f.user_id) });
    onDone();
  });
  const remove = useSubmit(async (reason) => { await api.del(`/timeclock/punches/${init.id}`, { reason }); onDone(); });
  return (
    <Modal title={init.id ? `Fix ${init.user_name}'s punch` : 'Add a missed shift'} onClose={onClose}>
      <ErrorBox error={save.error || remove.error} />
      <div className="form-grid">
        {!init.id && <label className="full">Person<select value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })}>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>}
        <label>Clock in<input type="datetime-local" value={f.clock_in} onChange={(e) => setF({ ...f, clock_in: e.target.value })} /></label>
        <label>Clock out<input type="datetime-local" value={f.clock_out} onChange={(e) => setF({ ...f, clock_out: e.target.value })} /></label>
        <label>Unpaid break (minutes)<input type="number" min="0" value={f.break_minutes} onChange={(e) => setF({ ...f, break_minutes: e.target.value })} /></label>
        <label>Why (kept with the change)<input value={f.note || ''} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. forgot to clock out" /></label>
      </div>
      <div className="form-actions">
        {init.id && <button className="danger" disabled={remove.busy} onClick={() => { const why = window.prompt('Remove this punch from the timesheet? It stays on record as removed. Why?'); if (why?.trim()) remove.submit(why.trim()); }}>Delete</button>}
        <button className="primary" disabled={save.busy} onClick={save.submit}>Save</button>
      </div>
    </Modal>
  );
}
