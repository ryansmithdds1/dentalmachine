import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, fmtUtcDateTime, practiceToday, shiftDate } from '../format.js';
import { ErrorBox, useSubmit } from './ui.jsx';
import { useShortcuts } from '../shortcuts.js';
import { undoable } from '../toast.js';
import '../pages/monthly.css';

// Reports → Close: end-of-day and month-end totals, loose ends to tidy, then close the books. Closing happens at
// once with Undo on the toast (POST /close/:id/reopen puts the lock date back; both are audited) instead of a
// confirm box. The month view carries the month-end packet (workflow 54, docs/workflows/specs/54-month-end-close.md).
export default function CloseBooks() {
  const { practice, user } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [params] = useSearchParams();
  // ?type=month (the command bar's "Month-end close") opens on last month.
  const [type, setType] = useState(params.get('type') === 'month' ? 'month' : 'day');
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(() => shiftDate(`${today.slice(0, 7)}-01`, -1).slice(0, 7));
  const value = type === 'day' ? day : month;
  const { data, reload } = useApi(`/close?type=${type}&period=${value}`);
  const close = useSubmit(async () => {
    const through = data.end;
    await undoable(
      `Books closed through ${fmtDate(through)} — nothing can be posted on or before it`,
      () => api.post('/close', { type, period: value }),
      (made) => api.post(`/close/${made.id}/reopen`, { reason: 'Undo right after closing' }).then(reload),
    );
    reload();
  });
  const open = data?.checks.filter((c) => c.count > 0) || [];
  const t = data?.totals;
  const canClose = !!data && !data.closed && user.role === 'admin' && data.end <= data.today;
  useShortcuts([
    { combo: 'm', handler: () => setType('month'), label: 'Month-end close', section: 'Close', enabled: type !== 'month' },
    { combo: 'd', handler: () => setType('day'), label: 'End-of-day close', section: 'Close', enabled: type !== 'day' },
    { combo: 'c', handler: () => !close.busy && close.submit(), label: 'Close the books for the period shown (Undo on the toast)', section: 'Close', enabled: canClose },
    { combo: 'p', handler: () => window.print(), label: 'Print the month-end packet', section: 'Close', enabled: type === 'month' },
  ]);
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
                {/* Not dental production: product sales and gift certificates on their own lines; their payments are in the payments above. */}
                {t.retail_sales ? <tr><td>Retail sales{t.retail_sales_tax ? ` (incl. ${money(t.retail_sales_tax)} tax)` : ''}</td><td className="num">{money(t.retail_sales)}</td></tr> : null}
                {t.gift_certificates_sold ? <tr><td>Gift certificates sold</td><td className="num">{money(t.gift_certificates_sold)}</td></tr> : null}
                {t.gift_certificates_used ? <tr><td>Gift certificates used</td><td className="num">{money(t.gift_certificates_used)}</td></tr> : null}
                <tr><td><strong>Net collections</strong></td><td className="num"><strong>{money(t.net_collections)}</strong></td></tr>
              </tbody>
            </table>
            <h3 style={{ marginTop: 16 }}>Before closing</h3>
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
                <button className="primary" disabled={close.busy || data.end > data.today} onClick={close.submit} title="Nothing can then be posted on or before that date. Undo on the toast, or an administrator reopens it.">
                  Close through {fmtDate(data.end)} <kbd>C</kbd>
                </button>
              </div>
            ) : <p className="muted">An administrator closes the books.</p>}
          </>
        )}
        {type === 'month' && <MonthPacket month={value} version={data?.lock_date} />}
      </div>
      <div className="card">
        <h2>Closed periods</h2>
        <p className="muted" style={{ fontSize: 13 }}>{data?.lock_date ? `Currently locked through ${fmtDate(data.lock_date)}.` : 'Nothing is locked yet.'} Administrators can move the lock date in Settings → Practice.</p>
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

// The month-end packet: the numbers the owner and the accountant look at, on one screen and one print (P).
// Every section comes from the report library, so it matches the reports; patient A/R and credits are totals only.
const cell = (c, v) => (v == null || v === '' ? '' : c.type === 'money' ? money(v) : c.type === 'pct' ? `${v}%` : c.type === 'date' ? fmtDate(v) : String(v));
function MonthPacket({ month, version }) {
  const { data, error } = useApi(`/close/packet?month=${month}&v=${version || ''}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading the month-end packet…</div>;
  const s = data.sections;
  const table = (sec) => {
    if (sec.error) return <div className="muted">Couldn’t build this part: {sec.error}</div>;
    const cols = (sec.columns || []).filter((c) => sec.rows.some((r) => r[c.key] != null && r[c.key] !== ''));
    if (!sec.rows.length) return <div className="muted">Nothing this month.</div>;
    return (
      <table className="compact-table">
        <thead><tr>{cols.map((c) => <th key={c.key} className={['money', 'int', 'pct'].includes(c.type) ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {sec.rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.key} className={['money', 'int', 'pct'].includes(c.type) ? 'num' : ''}>{cell(c, r[c.key])}</td>)}</tr>)}
          {sec.totals && <tr className="total">{cols.map((c, i) => <th key={c.key} className={['money', 'int', 'pct'].includes(c.type) ? 'num' : ''}>{i === 0 ? 'Total' : c.key in sec.totals ? cell(c, sec.totals[c.key]) : ''}</th>)}</tr>}
        </tbody>
      </table>
    );
  };
  return (
    <div className="packet" aria-label={`Month-end packet for ${data.month}`}>
      <div className="inline" style={{ justifyContent: 'space-between', marginTop: 18 }}>
        <h2 style={{ margin: 0 }}>Month-end packet · {data.month}</h2>
        <button className="small no-print" onClick={() => window.print()}>Print / PDF <kbd>P</kbd></button>
      </div>
      <section className="packet-section"><h3>{s.summary.name || 'Month-end summary'}</h3>{table(s.summary)}</section>
      <section className="packet-section"><h3>Production &amp; income by provider</h3>{table(s.production)}</section>
      <section className="packet-section"><h3>Collections by payment type</h3>{table(s.payment_types)}</section>
      <section className="packet-section"><h3>Adjustments &amp; write-offs by type</h3>{table(s.adjustments)}</section>
      <section className="packet-section"><h3>Insurance aging by carrier</h3>{table(s.insurance_aging)}</section>
      <section className="packet-section">
        <h3>Patient accounts</h3>
        <table className="compact-table">
          <tbody>
            {s.patient_aging.totals && (s.patient_aging.columns || []).filter((c) => c.key in s.patient_aging.totals).map((c) => <tr key={c.key}><td>{/^\d/.test(c.label) ? `${c.label} days` : c.label} <span className="muted">(as of {fmtDate(s.patient_aging.as_of)})</span></td><td className="num">{money(s.patient_aging.totals[c.key])}</td></tr>)}
            <tr><td>Accounts with a balance</td><td className="num">{s.patient_aging.accounts}</td></tr>
            <tr><td>Credit balances ({s.credit_balances.accounts} accounts) — <Link to="/claims?tab=refunds">refund queue</Link></td><td className="num">{money(s.credit_balances.total)}</td></tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}
