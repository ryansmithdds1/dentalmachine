import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, practiceToday } from '../format.js';
import { ErrorBox } from './ui.jsx';

// Both sides of every boundary, side by side: the card processor vs the ledger, insurance checks vs what was
// posted from them, claims created → sent → answered → paid, and import files vs rows brought in.
export default function Reconciliation() {
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [range, setRange] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const { data, error } = useApi(`/reports/reconciliation?from=${range.from}&to=${range.to}`, [range.from, range.to]);
  const Ok = ({ n, children }) => (n ? <span className="badge danger">{children}</span> : <span className="badge ok">matches</span>);
  return (
    <>
      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
        <label>From<input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label>To<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        <p className="muted" style={{ margin: 0, flex: 1, minWidth: 240 }}>Nothing here changes anything — it shows where two records of the same money or data disagree, so someone can look.</p>
      </div>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="card">
            <h2>Card payments: processor vs ledger</h2>
            {!data.cards.available ? <p className="muted">{data.cards.note}</p> : (
              <>
                <p>Processor {money(data.cards.processor_total)} · Ledger {money(data.cards.ledger_total)} · {data.cards.matched} matched{' '}
                  <Ok n={data.cards.charged_not_posted.length + data.cards.posted_not_charged.length + data.cards.amount_differs.length + data.cards.voided_but_charged.length}>differences</Ok></p>
                <Diffs title="Charged at the processor but not in the ledger" rows={data.cards.charged_not_posted} cols={[['date', 'Date'], ['id', 'Processor id'], ['amount', 'Amount', money], ['description', 'Description']]} />
                <Diffs title="In the ledger but not at the processor" rows={data.cards.posted_not_charged} cols={[['date', 'Date'], ['patient', 'Patient'], ['reference', 'Reference'], ['amount', 'Amount', money]]} />
                <Diffs title="Amounts differ" rows={data.cards.amount_differs} cols={[['date', 'Date'], ['patient', 'Patient'], ['id', 'Processor id'], ['amount', 'Processor', money], ['ledger_amount', 'Ledger', money]]} />
                <Diffs title="Voided in the ledger but still charged (refund it, or un-void)" rows={data.cards.voided_but_charged} cols={[['date', 'Date'], ['patient', 'Patient'], ['id', 'Processor id'], ['amount', 'Amount', money]]} />
              </>
            )}
          </div>
          <div className="card">
            <h2>Insurance checks and EFTs vs posted</h2>
            <p>{data.insurance.checks} checks · {money(data.insurance.total)} received · {money(data.insurance.posted)} posted to patients <Ok n={data.insurance.differences.length}>{data.insurance.differences.length} not fully posted</Ok></p>
            <Diffs rows={data.insurance.differences} cols={[['check_date', 'Date', fmtDate], ['payer_name', 'Payer'], ['check_number', 'Check / EFT'], ['amount', 'Amount', money], ['posted', 'Posted', money], ['unposted', 'Not posted', money]]} />
          </div>
          <div className="card">
            <h2>Claims created → sent → answered → paid</h2>
            <div className="grid grid-4">
              {[['created', 'Created'], ['sent', 'Sent'], ['acknowledged', 'Answered by the payer'], ['paid', 'Paid'], ['denied', 'Denied'], ['void', 'Voided']].map(([k, l]) => (
                <div key={k} className="card stat" style={{ margin: 0 }}><div className="label">{l}</div><div className="value">{data.claims.funnel[k]}</div></div>
              ))}
            </div>
            {[['not_sent', 'Drafts not sent after 3 days'], ['rejected', 'Rejected by the clearinghouse, not fixed'], ['no_acknowledgement', 'Sent electronically, no answer after 3 days'], ['unpaid_30_days', 'Sent over 30 days ago, not paid']].map(([k, l]) => (
              <Diffs key={k} title={`${l} (${data.claims.stuck[k].length})`} rows={data.claims.stuck[k]} cols={[['id', 'Claim', (id) => <Link to={`/claims/${id}`}>#{id}</Link>], ['patient', 'Patient'], ['carrier', 'Carrier'], ['total_fee', 'Billed', money], ['submitted_at', 'Sent', fmtDate], ['ch_message', 'Last message']]} />
            ))}
          </div>
          <div className="card">
            <h2>Imports: file rows vs rows brought in</h2>
            {!data.imports.length ? <p className="muted">No imports in this range.</p> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>When</th><th>What</th><th className="num">Rows in file</th><th className="num">Added</th><th className="num">Updated</th><th className="num">Skipped</th><th className="num">Refused</th><th /></tr></thead>
                  <tbody>{data.imports.map((b) => (
                    <tr key={b.id}><td>{fmtDate(b.created_at)}</td><td>{b.kind}{b.filename ? ` · ${b.filename}` : ''}</td><td className="num">{b.total_rows || '—'}</td><td className="num">{b.created_count}</td><td className="num">{b.updated_count}</td><td className="num">{b.skipped_count}</td><td className="num">{b.error_count}</td>
                      <td>{b.ok ? <span className="badge ok">matches</span> : <span className="badge danger">{b.missing ? `${b.missing} rows unaccounted for` : b.error_count ? `${b.error_count} refused` : b.status}</span>}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function Diffs({ title, rows, cols }) {
  if (!rows?.length) return null;
  return (
    <>
      {title && <h3 style={{ fontSize: 14, margin: '14px 0 6px' }}>{title}</h3>}
      <div className="table-wrap">
        <table>
          <thead><tr>{cols.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={r.id ?? r.entry_id ?? i}>{cols.map(([k, , f]) => <td key={k}>{r[k] == null ? '—' : f ? f(r[k]) : r[k]}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </>
  );
}
