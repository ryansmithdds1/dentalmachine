import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { money, fmtDate, label } from '../format.js';

export default function Statement() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const family = params.get('family') === '1';
  const { data: s } = useApi(`/patients/${id}/statement${family ? '?family=1' : ''}`);
  if (!s) return <div className="empty">Loading…</div>;
  const { practice: pr, patient: p } = s;

  return (
    <>
      <div className="page-header no-print">
        <Link to={`/patients/${id}`}>← Back to patient</Link>
        <button className="primary" onClick={() => window.print()}>Print</button>
      </div>
      <div className="card" style={{ maxWidth: 800, margin: '0 auto' }}>
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
        <div style={{ margin: '24px 0' }}>
          <strong>{p.first_name} {p.last_name}</strong>
          <div>{p.address}</div>
          <div>{[p.city, p.state, p.zip].filter(Boolean).join(', ')}</div>
        </div>
        <table>
          <thead><tr><th>Date</th>{s.family && <th>Patient</th>}<th>Description</th><th>Type</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {s.entries.map((e) => (
              <tr key={e.id}><td>{fmtDate(e.entry_date)}</td>{s.family && <td>{e.patient_first_name}</td>}<td>{e.description}</td><td>{label(e.type)}</td><td className="num">{money(e.amount)}</td></tr>
            ))}
            <tr className="totals-row"><td colSpan={s.family ? 4 : 3}>Account balance</td><td className="num">{money(s.balance)}</td></tr>
            {s.pending_insurance > 0 && <tr><td colSpan={s.family ? 4 : 3}>Less: expected from insurance</td><td className="num">−{money(s.pending_insurance)}</td></tr>}
            {s.pending_write_off > 0 && <tr><td colSpan={s.family ? 4 : 3}>Less: in-network discount to be applied</td><td className="num">−{money(s.pending_write_off)}</td></tr>}
            <tr className="totals-row"><td colSpan={s.family ? 4 : 3}>Amount due now</td><td className="num">{money(s.amount_due)}</td></tr>
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: 24 }}>Questions about your bill? Call us at {pr.phone || 'the office'}. Thank you for choosing {pr.name}.</p>
      </div>
    </>
  );
}
