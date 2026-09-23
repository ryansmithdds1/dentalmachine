import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, getToken } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, toCents, fromCents } from '../format.js';
import { Badge, ErrorBox, Modal, useSubmit } from '../components/ui.jsx';

export default function ClaimDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: c, reload, error: loadErr } = useApi(`/claims/${id}`);
  const [modal, setModal] = useState(null);
  const [err, setErr] = useState(null);
  const act = async (fn) => {
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  if (loadErr) return <div className="error">{loadErr.message}</div>;
  if (!c) return <div className="empty">Loading…</div>;
  const w = can('billing:write');
  const sendElectronic = async () => {
    setErr(null);
    const res = await fetch('/api/claims/837', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ claim_ids: [c.id] }) });
    if (!res.ok) return setErr(new Error((await res.json()).error));
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: `claim-${c.id}.837` }).click();
    reload();
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Claim #{c.id} <Badge value={c.status} /></h1>
          <div className="muted"><Link to={`/patients/${c.patient_id}`}>{c.first_name} {c.last_name}</Link> · {c.carrier_name}</div>
        </div>
        <div className="actions no-print">
          <button onClick={() => window.print()}>Print</button>
          {w && ['draft', 'denied'].includes(c.status) && <button className="primary" onClick={sendElectronic}>Send electronically (837)</button>}
          {w && ['draft', 'denied'].includes(c.status) && <button onClick={() => act(() => api.post(`/claims/${c.id}/submit`))}>{c.status === 'denied' ? 'Resubmitted on paper' : 'Mark sent on paper'}</button>}
          {w && ['submitted', 'partially_paid'].includes(c.status) && <button className="primary" onClick={() => setModal('pay')}>Enter EOB payment</button>}
          {w && c.status === 'submitted' && <button className="danger" onClick={() => setModal('deny')}>Denied</button>}
          {w && ['draft', 'denied'].includes(c.status) && <button className="danger" onClick={() => confirm('Void this claim? Procedures become billable again.') && act(() => api.post(`/claims/${c.id}/void`))}>Void</button>}
        </div>
      </div>
      <ErrorBox error={err} />
      {c.denial_reason && <div className="error">Denial reason: {c.denial_reason}</div>}
      {c.payer_claim_number && <div className="muted" style={{ marginBottom: 8 }}>Payer claim # {c.payer_claim_number}</div>}
      <ClaimChecks id={c.id} status={c.status} />

      <div className="grid grid-2">
        <div className="card">
          <h2>Billing provider</h2>
          <dl className="kv">
            <dt>Practice</dt><dd>{c.practice.name}</dd>
            <dt>Address</dt><dd>{[c.practice.address, c.practice.city, c.practice.state, c.practice.zip].filter(Boolean).join(', ') || '—'}</dd>
            <dt>NPI / TIN</dt><dd>{c.practice.npi || '—'} / {c.practice.tax_id || '—'}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Subscriber</h2>
          <dl className="kv">
            <dt>Patient</dt><dd>{c.patient.first_name} {c.patient.last_name} (DOB {c.patient.dob || '—'})</dd>
            <dt>Carrier</dt><dd>{c.carrier_name} {c.payer_id ? `· Payer ID ${c.payer_id}` : ''}</dd>
            <dt>Member ID</dt><dd>{c.subscriber_id}</dd>
            <dt>Group</dt><dd>{c.group_number || '—'}</dd>
          </dl>
        </div>
      </div>

      <div className="card">
        <h2>Services</h2>
        <table>
          <thead><tr><th>Date</th><th>Code</th><th>Description</th><th>Tooth</th><th>Surf</th><th>Provider (NPI)</th><th className="num">Fee</th><th className="num">Est. ins.</th></tr></thead>
          <tbody>
            {c.items.map((i) => (
              <tr key={i.id}>
                <td>{fmtDate(i.completed_at)}</td><td>{i.code}</td><td>{i.description}</td><td>{i.tooth}</td><td>{i.surfaces}</td>
                <td>{i.provider_name} {i.provider_npi ? `(${i.provider_npi})` : ''}</td>
                <td className="num">{money(i.fee)}</td><td className="num">{money(i.estimated_amount)}</td>
              </tr>
            ))}
            <tr className="totals-row"><td colSpan={6}>Totals · paid {money(c.paid_amount)}</td><td className="num">{money(c.total_fee)}</td><td className="num">{money(c.estimated_amount)}</td></tr>
          </tbody>
        </table>
        <div className="muted" style={{ marginTop: 8 }}>
          Created {fmtDate(c.created_at)}{c.submitted_at ? ` · Submitted ${fmtDate(c.submitted_at)}` : ''}{c.paid_at ? ` · Paid ${fmtDate(c.paid_at)}` : ''}
        </div>
      </div>

      {modal === 'pay' && <Modal title="Enter insurance payment (EOB)" onClose={() => setModal(null)}><PaymentForm claim={c} onDone={() => { setModal(null); reload(); }} /></Modal>}
      {modal === 'deny' && <Modal title="Record denial" onClose={() => setModal(null)}><DenyForm claim={c} onDone={() => { setModal(null); reload(); }} /></Modal>}
    </>
  );
}

function PaymentForm({ claim, onDone }) {
  const remaining = Math.max(0, claim.estimated_amount - claim.paid_amount);
  const [form, setForm] = useState({ amount: fromCents(remaining), write_off: fromCents(claim.write_off_estimate || 0), reference: '', final: true });
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/claims/${claim.id}/payment`, { amount: toCents(form.amount), write_off: toCents(form.write_off || 0), reference: form.reference, final: form.final });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Insurance paid ($)<input type="number" step="0.01" min="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label>Contractual write-off ($)<input type="number" step="0.01" min="0" value={form.write_off} onChange={(e) => setForm({ ...form, write_off: e.target.value })} /></label>
        <label className="full">Check / EFT #<input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></label>
        <label className="checkbox full"><input type="checkbox" checked={form.final} onChange={(e) => setForm({ ...form, final: e.target.checked })} /> Final payment for this claim</label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Post payment</button></div>
    </form>
  );
}

function DenyForm({ claim, onDone }) {
  const [reason, setReason] = useState('');
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/claims/${claim.id}/deny`, { reason });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <label>Reason<textarea required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="form-actions"><button className="primary danger" disabled={busy}>Record denial</button></div>
    </form>
  );
}

function ClaimChecks({ id, status }) {
  const { data } = useApi(['draft', 'denied'].includes(status) ? `/claims/${id}/validate` : null);
  if (!data) return null;
  if (!data.problems.length) return <div className="badge ok" style={{ marginBottom: 12 }}>✓ Ready to send electronically</div>;
  return (
    <div className="error">
      <strong>Fix before sending electronically:</strong>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{data.problems.map((p) => <li key={p}>{p}</li>)}</ul>
    </div>
  );
}
