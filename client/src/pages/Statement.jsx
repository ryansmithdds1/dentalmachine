import { useEffect, useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { useApi } from '../hooks.js';
import { money, fmtDate, label } from '../format.js';

const FREQ = { weekly: 'week', biweekly: 'two weeks', monthly: 'month' };

export default function Statement() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const family = params.get('family') === '1';
  const { data: s } = useApi(`/patients/${id}/statement${family ? '?family=1' : ''}`);
  const [qr, setQr] = useState(null);
  useEffect(() => {
    if (s?.pay_url) QRCode.toDataURL(s.pay_url, { margin: 1, width: 132 }).then(setQr).catch(() => setQr(null));
  }, [s?.pay_url]);
  if (!s) return <div className="empty">Loading…</div>;
  const { practice: pr, patient: p } = s;
  const cols = s.family ? 4 : 3;

  return (
    <>
      <div className="page-header no-print">
        <Link to={`/patients/${id}`}>← Back to patient</Link>
        <button className="primary" onClick={() => window.print()}>Print</button>
      </div>
      <div className="card statement" style={{ maxWidth: 800, margin: '0 auto' }}>
        <div className="inline" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1>{pr.name}</h1>
            <div>{pr.address}</div>
            <div>{[pr.city, pr.state, pr.zip].filter(Boolean).join(', ')}</div>
            <div>{pr.phone}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <h2>{s.family ? 'Family statement' : 'Patient statement'}</h2>
            <div>Date: {fmtDate(s.generated_at)}</div>
            <div>Account #{p.id}</div>
          </div>
        </div>
        <div className="inline" style={{ justifyContent: 'space-between', alignItems: 'flex-start', margin: '20px 0' }}>
          <div>
            <strong>{p.first_name} {p.last_name}</strong>
            {s.also_responsible && <div className="muted" style={{ fontSize: 13 }}>Also responsible: {s.also_responsible.first_name} {s.also_responsible.last_name}</div>}
            <div>{p.address}</div>
            <div>{[p.city, p.state, p.zip].filter(Boolean).join(', ')}</div>
          </div>
          <div className="statement-due">
            <div className="muted">Amount due now</div>
            <div className="statement-due-amount">{money(s.amount_due)}</div>
            <div style={{ fontSize: 12 }}>Account balance {money(s.balance)}</div>
            {s.pending_insurance > 0 && <div style={{ fontSize: 12 }}>Pending with insurance −{money(s.pending_insurance)}</div>}
            {s.pending_write_off > 0 && <div style={{ fontSize: 12 }}>In-network discount to apply −{money(s.pending_write_off)}</div>}
          </div>
        </div>
        <table>
          <thead><tr><th>Date</th>{s.family && <th>Patient</th>}<th>Description</th><th>Type</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {s.since > '0000-00-00' && <tr><td>{fmtDate(s.since)}</td>{s.family && <td />}<td>Previous balance</td><td /><td className="num">{money(s.previous_balance)}</td></tr>}
            {s.entries.map((e) => (
              <tr key={e.id}><td>{fmtDate(e.entry_date)}</td>{s.family && <td>{e.patient_first_name}</td>}<td>{e.description}</td><td>{label(e.type)}</td><td className="num">{money(e.amount)}</td></tr>
            ))}
            <tr className="totals-row"><td colSpan={cols}>Account balance</td><td className="num">{money(s.balance)}</td></tr>
            {s.pending_insurance > 0 && <tr><td colSpan={cols}>Less: expected from insurance</td><td className="num">−{money(s.pending_insurance)}</td></tr>}
            {s.pending_write_off > 0 && <tr><td colSpan={cols}>Less: in-network discount to be applied</td><td className="num">−{money(s.pending_write_off)}</td></tr>}
            <tr className="totals-row"><td colSpan={cols}>Estimated patient portion — amount due now</td><td className="num">{money(s.amount_due)}</td></tr>
          </tbody>
        </table>
        {s.balance > 0 && (
          <table className="statement-aging" style={{ marginTop: 16 }}>
            <thead><tr><th className="num">Current</th><th className="num">31–60 days</th><th className="num">61–90 days</th><th className="num">Over 90 days</th></tr></thead>
            <tbody><tr><td className="num">{money(s.aging.current)}</td><td className="num">{money(s.aging.d31_60)}</td><td className="num">{money(s.aging.d61_90)}</td><td className="num">{money(s.aging.d90_plus)}</td></tr></tbody>
          </table>
        )}
        {s.plans.map((pl) => (
          <div key={pl.id} className="statement-note">
            <strong>Payment plan:</strong> {money(pl.installment_amount)} every {FREQ[pl.frequency] || pl.frequency} · {money(pl.remaining)} left
            {pl.next_due_date && <> · next payment {money(pl.next_due_amount)} due {fmtDate(pl.next_due_date)}</>}
            {pl.past_due > 0 && <strong style={{ color: 'var(--danger)' }}> · {money(pl.past_due)} past due</strong>}
          </div>
        ))}
        <div className="statement-pay">
          {qr && <img src={qr} alt="QR code to pay online" width={112} height={112} />}
          <div>
            <strong>Ways to pay</strong>
            <div>{s.pay_url ? <>Online: scan the code or visit <span className="mono">{s.pay_url}</span></> : 'Online through your patient portal'}</div>
            <div>By phone: {pr.phone || 'call the office'} · Or at your next visit</div>
            <div className="muted" style={{ fontSize: 12 }}>Questions about your bill? Call us — we’re happy to help or set up a payment plan.</div>
          </div>
        </div>
        <div className="statement-stub">
          <div>
            <strong>Please detach and return this part with your payment</strong>
            <div>Make checks payable to {pr.name}</div>
            <div>{pr.address}</div>
            <div>{[pr.city, pr.state, pr.zip].filter(Boolean).join(', ')}</div>
          </div>
          <div>
            <div>Account #{p.id} · {p.first_name} {p.last_name}</div>
            <div className="stub-box">Amount due <strong>{money(s.amount_due)}</strong></div>
            <div className="stub-box">Amount enclosed $</div>
            <div className="stub-box" style={{ fontSize: 11 }}>Card # ____________________ Exp ____ CVC ____</div>
          </div>
        </div>
      </div>
    </>
  );
}
