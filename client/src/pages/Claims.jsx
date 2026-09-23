import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { money, fmtDate } from '../format.js';
import { Badge } from '../components/ui.jsx';

const FILTERS = [['', 'All'], ['draft', 'Draft'], ['submitted', 'Submitted'], ['partially_paid', 'Partially paid'], ['denied', 'Denied'], ['paid', 'Paid'], ['void', 'Void']];

export default function Claims() {
  const nav = useNavigate();
  const [status, setStatus] = useState('submitted');
  const { data: claims } = useApi(`/claims${status ? `?status=${status}` : ''}`);
  const totals = (claims || []).reduce((t, c) => ({ billed: t.billed + c.total_fee, est: t.est + c.estimated_amount, paid: t.paid + c.paid_amount }), { billed: 0, est: 0, paid: 0 });

  return (
    <>
      <div className="page-header">
        <h1>Insurance claims</h1>
      </div>
      <div className="tabs">
        {FILTERS.map(([v, text]) => <button key={v} className={status === v ? 'active' : ''} onClick={() => setStatus(v)}>{text}</button>)}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Claim</th><th>Patient</th><th>Carrier</th><th>Created</th><th>Submitted</th><th>Status</th><th className="num">Billed</th><th className="num">Estimated</th><th className="num">Paid</th></tr></thead>
            <tbody>
              {claims?.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => nav(`/claims/${c.id}`)}>
                  <td>#{c.id}</td>
                  <td>{c.first_name} {c.last_name}</td>
                  <td>{c.carrier_name}</td>
                  <td>{fmtDate(c.created_at)}</td>
                  <td>{fmtDate(c.submitted_at)}</td>
                  <td><Badge value={c.status} /></td>
                  <td className="num">{money(c.total_fee)}</td>
                  <td className="num">{money(c.estimated_amount)}</td>
                  <td className="num">{money(c.paid_amount)}</td>
                </tr>
              ))}
              {claims?.length > 0 && (
                <tr className="totals-row"><td colSpan={6}>{claims.length} claims</td><td className="num">{money(totals.billed)}</td><td className="num">{money(totals.est)}</td><td className="num">{money(totals.paid)}</td></tr>
              )}
            </tbody>
          </table>
          {claims?.length === 0 && <div className="empty">No claims. Create claims from a patient&apos;s Insurance tab.</div>}
        </div>
      </div>
    </>
  );
}
