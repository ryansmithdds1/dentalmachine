import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, fmtUtcDateTime, practiceToday, shiftDate } from '../format.js';
import { ErrorBox, useSubmit } from './ui.jsx';

// Reports → Close: end-of-day and month-end totals, loose ends to tidy, then close the books.
export default function CloseBooks() {
  const { practice, user } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [type, setType] = useState('day');
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(() => shiftDate(`${today.slice(0, 7)}-01`, -1).slice(0, 7));
  const value = type === 'day' ? day : month;
  const { data, reload } = useApi(`/close?type=${type}&period=${value}`);
  const close = useSubmit(async () => { await api.post('/close', { type, period: value }); reload(); });
  const open = data?.checks.filter((c) => c.count > 0) || [];
  const t = data?.totals;
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
      <div className="card">
        <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Close the books</h2>
          <div className="inline">
            <div className="seg">
              <button className={type === 'day' ? 'active' : ''} onClick={() => setType('day')}>Day</button>
              <button className={type === 'month' ? 'active' : ''} onClick={() => setType('month')}>Month</button>
            </div>
            {type === 'day' ? <input type="date" aria-label="Day" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} /> : <input type="month" aria-label="Month" value={month} max={today.slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />}
          </div>
        </div>
        {data && (
          <>
            <table className="compact-table" style={{ marginTop: 12 }}>
              <tbody>
                <tr><td>Production</td><td className="num">{money(t.production)}</td></tr>
                <tr><td>Patient payments</td><td className="num">{money(t.patient_payments)}</td></tr>
                <tr><td>Insurance payments</td><td className="num">{money(t.insurance_payments)}</td></tr>
                <tr><td>Refunds</td><td className="num">{money(t.refunds)}</td></tr>
                <tr><td>Adjustments</td><td className="num">{money(t.adjustments)}</td></tr>
                <tr><td><strong>Net collections</strong></td><td className="num"><strong>{money(t.net_collections)}</strong></td></tr>
              </tbody>
            </table>
            <h3>Before closing</h3>
            <ul className="close-list">
              {data.checks.map((c) => (
                <li key={c.key} className={c.count ? 'todo' : 'done'}>
                  {c.count ? '•' : '✓'} {c.label}{c.count ? <>: <strong>{c.count}</strong> <Link to={c.link}>Open</Link></> : ''}
                </li>
              ))}
            </ul>
            <ErrorBox error={close.error} />
            {data.closed ? (
              <div className="public-notice ok">Closed — nothing can be posted on or before {fmtDate(data.lock_date)}.</div>
            ) : user.role === 'admin' ? (
              <div className="form-actions">
                <span className="muted" style={{ fontSize: 13 }}>{data.end > data.today ? 'This period isn’t over yet.' : open.length ? `${open.length} loose ends — you can still close; they’re noted.` : 'All tidy.'}</span>
                <button className="primary" disabled={close.busy || data.end > data.today} onClick={() => window.confirm(`Close the books through ${fmtDate(data.end)}? Nothing can then be posted on or before that date without an administrator moving the lock date.`) && close.submit()}>
                  Close through {fmtDate(data.end)}
                </button>
              </div>
            ) : <p className="muted">An administrator closes the books.</p>}
          </>
        )}
      </div>
      <div className="card">
        <h2>Closed periods</h2>
        <p className="muted" style={{ fontSize: 13 }}>Currently locked through {data?.lock_date ? fmtDate(data.lock_date) : '—'}. Administrators can move the lock date in Settings → Practice.</p>
        <table className="compact-table">
          <tbody>
            {data?.history.map((hh) => {
              const tt = JSON.parse(hh.totals);
              return <tr key={hh.id}><td>{hh.period_type === 'month' ? hh.period_start.slice(0, 7) : fmtDate(hh.period_end)}<div className="muted" style={{ fontSize: 11 }}>{fmtUtcDateTime(hh.closed_at, practice?.timezone)} · {hh.closed_by_name}</div></td><td className="num">{money(tt.production)}<div className="muted" style={{ fontSize: 11 }}>{money(tt.net_collections)} collected</div></td></tr>;
            })}
            {data?.history.length === 0 && <tr><td className="muted">None yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
