import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useApi } from '../../hooks.js';
import { money, fmtDate, shiftDate, practiceToday } from '../../format.js';
import { useAuth } from '../../auth.jsx';
import { ErrorBox } from '../ui.jsx';

const signed = (c) => <span className={c > 0 ? 'dep-over' : c < 0 ? 'dep-short' : ''}>{c > 0 ? '+' : c < 0 ? '−' : ''}{money(Math.abs(c))}</span>;

// The owner's Cash integrity report: drawer over/short by person and over time, voids and refunds on cash,
// adjustments and write-offs by person, deposits late to the bank, voided receipts, separation-of-duties warnings.
export default function CashIntegrity() {
  const { practice } = useAuth();
  const today = practiceToday(practice?.timezone);
  const [from, setFrom] = useState(shiftDate(today, -90));
  const [to, setTo] = useState(today);
  const { data: r, error } = useApi(`/cash/integrity?from=${from}&to=${to}`);
  if (error) return <ErrorBox error={error} />;
  const maxWeek = Math.max(1, ...(r?.over_short_trend || []).map((w) => Math.abs(w.net)));
  return (
    <>
      <div className="dep-toolbar">
        <label>From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} /></label>
        <span className="muted" style={{ fontSize: 13 }}>Only you see this. Opening it is recorded.</span>
      </div>
      {!r ? <div className="card muted">Loading…</div> : (
        <>
          <div className="integrity-tiles">
            <div className={r.summary.net_over_short < 0 ? 'bad' : ''}><strong>{signed(r.summary.net_over_short)}</strong><span>drawer over/short ({r.summary.drawer_counts} counts)</span></div>
            <div className={r.summary.cash_voids ? 'bad' : ''}><strong>{r.summary.cash_voids}</strong><span>cash payments voided</span></div>
            <div><strong>{money(r.summary.cash_refund_total)}</strong><span>refunded in cash ({r.summary.cash_refunds})</span></div>
            <div className={r.summary.late_deposits ? 'bad' : ''}><strong>{r.summary.late_deposits}</strong><span>deposits late to the bank</span></div>
            <div className={r.summary.separation_warnings ? 'bad' : ''}><strong>{r.summary.separation_warnings}</strong><span>separation-of-duties warnings</span></div>
            <div><strong>{r.summary.receipts_voided}</strong><span>cash receipts voided</span></div>
          </div>

          {r.separation.length > 0 && (
            <div className="card">
              <h2><ShieldAlert size={18} /> One person took the money, adjusted the account and made the deposit</h2>
              <table className="dep-table"><tbody>{r.separation.map((s) => <tr key={`${s.deposit_id}-${s.kind}`}><td>{fmtDate(s.business_date)}</td><td>{s.text}</td><td>Deposit #{s.deposit_id}</td></tr>)}</tbody></table>
            </div>
          )}

          <div className="dep-grid">
            <div className="card">
              <h2>Drawer over/short by person</h2>
              <table className="dep-table">
                <thead><tr><th>Counted by</th><th className="num">Counts</th><th className="num">Over</th><th className="num">Short</th><th className="num">Net</th></tr></thead>
                <tbody>
                  {r.over_short_by_person.map((p) => <tr key={p.user_id}><td>{p.name}{p.flagged ? <span className="dep-chip exception" style={{ marginLeft: 6 }}>{p.flagged} big</span> : null}</td><td className="num">{p.counts}</td><td className="num">{signed(p.over)}</td><td className="num">{signed(p.short)}</td><td className="num">{signed(p.net)}</td></tr>)}
                  {!r.over_short_by_person.length && <tr><td colSpan={5} className="muted">No drawer counts in this period.</td></tr>}
                </tbody>
              </table>
              {r.over_short_trend.length > 0 && (
                <>
                  <h3 style={{ marginTop: 14 }}>By week</h3>
                  <div className="trend" role="img" aria-label="Net over/short by week">
                    {r.over_short_trend.map((w) => <div key={w.week} title={`Week of ${fmtDate(w.week)}: ${money(w.net)}`} className={`bar${w.net < 0 ? ' neg' : ''}`} style={{ height: `${Math.max(4, (Math.abs(w.net) / maxWeek) * 100)}%` }} />)}
                  </div>
                </>
              )}
            </div>
            <div className="card">
              <h2>Adjustments and write-offs by person</h2>
              <table className="dep-table">
                <thead><tr><th>Posted by</th><th className="num">#</th><th className="num">Discounts</th><th className="num">Write-offs</th></tr></thead>
                <tbody>
                  {r.adjustments_by_person.map((a) => <tr key={a.user_id ?? 'none'}><td>{a.name}</td><td className="num">{a.count}</td><td className="num">{money(a.discounts)}</td><td className="num">{money(a.write_offs)}</td></tr>)}
                  {!r.adjustments_by_person.length && <tr><td colSpan={4} className="muted">None.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h2>Cash voids and refunds</h2>
            <table className="dep-table">
              <thead><tr><th>Date</th><th>What</th><th>Patient</th><th>Taken by</th><th>Done by</th><th>Manager OK</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {r.cash_voids.map((v) => <tr key={`v${v.id}`}><td>{fmtDate(v.voided_at.slice(0, 10))}</td><td>Void{v.reason ? `: ${v.reason}` : ''}</td><td>{v.patient}</td><td>{v.taken_by}</td><td>{v.voided_by}{v.same_person && <span className="dep-chip warn" style={{ marginLeft: 6 }}>same person</span>}</td><td>{v.approved_by || <span className="dep-short">no</span>}</td><td className="num">{money(v.amount)}</td></tr>)}
                {r.cash_refunds.map((f) => <tr key={`r${f.id}`}><td>{fmtDate(f.entry_date)}</td><td>Refund in cash</td><td>{f.patient}</td><td>—</td><td>{f.by}</td><td>{f.approved_by || <span className="dep-short">no</span>}</td><td className="num">{money(f.amount)}</td></tr>)}
                {!r.cash_voids.length && !r.cash_refunds.length && <tr><td colSpan={7} className="muted">None.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="dep-grid">
            <div className="card">
              <h2>Deposits late to the bank</h2>
              <table className="dep-table">
                <tbody>
                  {r.late_deposits.map((d) => <tr key={d.deposit_id}><td>{fmtDate(d.business_date)}</td><td>{d.prepared_by}</td><td className="num">{money(d.total)}</td><td>{d.still_missing ? <span className="dep-short">still not in the bank</span> : `in the bank ${fmtDate(d.bank_date)}`} ({d.business_days} business days)</td></tr>)}
                  {!r.late_deposits.length && <tr><td className="muted">Every deposit reached the bank within {r.settings.late_business_days} business days.</td></tr>}
                </tbody>
              </table>
              <h3 style={{ marginTop: 14 }}>Differences</h3>
              <table className="dep-table">
                <tbody>
                  {r.differences.map((d) => <tr key={`${d.kind}${d.deposit_id}`}><td>{fmtDate(d.business_date)}</td><td>{d.kind === 'bank' ? 'Bank vs slip' : 'Slip vs ledger'}{d.reopened ? ' (reopened)' : ''}</td><td className="num">{signed(d.amount)}</td><td>{d.reason || <span className="dep-short">no reason</span>}</td></tr>)}
                  {!r.differences.length && <tr><td className="muted">None.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="card">
              <h2>Voided receipts, reopened deposits, float changes</h2>
              <table className="dep-table">
                <tbody>
                  {r.receipts_voided.map((x) => <tr key={`rc${x.receipt_no}-${x.location_id}`}><td>Receipt #{x.receipt_no}</td><td>{money(x.amount)}</td><td>taken by {x.taken_by}, voided by {x.voided_by}</td></tr>)}
                  {r.reopened.map((x) => <tr key={`ro${x.deposit_id}`}><td>Deposit #{x.deposit_id} reopened</td><td>{fmtDate(x.business_date)}</td><td>{x.reopened_by}: {x.reason}</td></tr>)}
                  {r.float_mismatches.map((x, i) => <tr key={`f${i}`}><td>Float changed</td><td>{signed(x.amount)}</td><td>{x.name}</td></tr>)}
                  {!r.receipts_voided.length && !r.reopened.length && !r.float_mismatches.length && <tr><td className="muted">None.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
