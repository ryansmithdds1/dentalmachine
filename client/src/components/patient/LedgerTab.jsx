import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, label, toCents } from '../../format.js';
import { ErrorBox, Modal, useSubmit } from '../ui.jsx';

const METHODS = ['credit_card', 'debit_card', 'cash', 'check', 'ach', 'care_credit', 'other'];

export default function LedgerTab({ patient, onChange }) {
  const { can } = useAuth();
  const { data, reload } = useApi(`/patients/${patient.id}/ledger`);
  const { data: payConfig } = useApi('/payments/config');
  const { data: payRequests, reload: reloadRequests } = useApi(`/patients/${patient.id}/payment-requests`);
  const [modal, setModal] = useState(null);
  const done = () => { setModal(null); reload(); onChange?.(); };
  if (!data) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card stat"><div className="label">Account balance</div><div className="value">{money(data.balance)}</div></div>
        <div className="card stat"><div className="label">Pending insurance</div><div className="value">{money(data.pending_insurance)}</div></div>
        <div className="card stat"><div className="label">Est. patient portion</div><div className="value" style={{ color: data.patient_portion > 0 ? 'var(--danger)' : undefined }}>{money(data.patient_portion)}</div></div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="page-header" style={{ padding: '14px 16px', marginBottom: 0 }}>
          <h2 style={{ margin: 0 }}>Ledger</h2>
          <div className="actions">
            <Link to={`/patients/${patient.id}/statement`}><button>Print statement</button></Link>
            {can('billing:write') && (
              <>
                {payConfig?.enabled && <button onClick={() => setModal('paylink')}>Send card payment link</button>}
                <button onClick={() => setModal('adjustment')}>Adjustment</button>
                <button className="primary" onClick={() => setModal('payment')}>Take payment</button>
              </>
            )}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Type</th><th>Description</th><th>By</th><th className="num">Charges</th><th className="num">Credits</th><th className="num">Balance</th></tr></thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td>{fmtDate(e.entry_date)}</td>
                  <td>{label(e.type)}</td>
                  <td>{e.description}{e.reference ? <span className="muted"> · ref {e.reference}</span> : ''}</td>
                  <td className="muted">{e.created_by_name}</td>
                  <td className="num">{e.amount > 0 ? money(e.amount) : ''}</td>
                  <td className="num">{e.amount < 0 ? money(-e.amount) : ''}</td>
                  <td className="num">{money(e.running_balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.entries.length && <div className="empty">No transactions.</div>}
        </div>
      </div>
      {modal === 'payment' && <Modal title="Take payment" onClose={() => setModal(null)}><PaymentForm patient={patient} balance={data.patient_portion} onDone={done} /></Modal>}
      {payRequests?.length > 0 && (
        <div className="card">
          <h3>Online payment requests</h3>
          <table>
            <tbody>
              {payRequests.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.created_at)}</td>
                  <td className="num">{money(r.amount)}</td>
                  <td><span className={`badge ${r.status === 'paid' ? 'ok' : r.status === 'pending' ? 'info' : 'danger'}`}>{r.status}</span></td>
                  <td>{r.status === 'pending' && r.url && <a href={r.url} target="_blank" rel="noreferrer">Open checkout</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {modal === 'paylink' && <Modal title="Send card payment link" onClose={() => setModal(null)}><PayLinkForm patient={patient} balance={data.patient_portion} onDone={() => { setModal(null); reloadRequests(); }} /></Modal>}
      {modal === 'adjustment' && <Modal title="Ledger adjustment" onClose={() => setModal(null)}><AdjustmentForm patient={patient} onDone={done} /></Modal>}
    </>
  );
}

function PaymentForm({ patient, balance, onDone }) {
  const [form, setForm] = useState({ amount: balance > 0 ? (balance / 100).toFixed(2) : '', method: 'credit_card', reference: '' });
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${patient.id}/payments`, { ...form, amount: toCents(form.amount) });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Amount ($)<input type="number" step="0.01" min="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label>
          Method
          <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            {METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}
          </select>
        </label>
        <label className="full">Reference (check #, last 4, auth code)<input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Post payment</button></div>
    </form>
  );
}

function PayLinkForm({ patient, balance, onDone }) {
  const [amount, setAmount] = useState(balance > 0 ? (balance / 100).toFixed(2) : '');
  const [send, setSend] = useState(patient.phone && patient.sms_opt_in ? 'sms' : patient.email && patient.email_opt_in ? 'email' : '');
  const [result, setResult] = useState(null);
  const { submit, busy, error } = useSubmit(async () => {
    setResult(await api.post(`/patients/${patient.id}/payment-requests`, { amount: toCents(amount), send: send || null }));
  });
  if (result) {
    return (
      <div>
        <p>{result.message ? `Link ${result.message.status === 'sent' ? 'sent' : 'could not be sent'} to ${result.message.to_address}.` : 'Link created.'}</p>
        <p><a href={result.url} target="_blank" rel="noreferrer">{result.url}</a></p>
        <p className="muted">The payment posts to the ledger automatically when the patient pays.</p>
        <div className="form-actions"><button className="primary" onClick={onDone}>Done</button></div>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Amount ($)<input type="number" step="0.01" min="0.50" required value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>
          Send link by
          <select value={send} onChange={(e) => setSend(e.target.value)}>
            <option value="sms">Text {patient.phone ? `(${patient.phone})` : '(no phone)'}</option>
            <option value="email">Email {patient.email ? `(${patient.email})` : '(no email)'}</option>
            <option value="">Don&apos;t send, just create the link</option>
          </select>
        </label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Create secure payment link</button></div>
    </form>
  );
}

function AdjustmentForm({ patient, onDone }) {
  const [form, setForm] = useState({ amount: '', direction: 'credit', description: 'Courtesy discount' });
  const { submit, busy, error } = useSubmit(async () => {
    const cents = toCents(form.amount);
    await api.post(`/patients/${patient.id}/adjustments`, { amount: form.direction === 'credit' ? -cents : cents, description: form.description });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Amount ($)<input type="number" step="0.01" min="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label>
          Type
          <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
            <option value="credit">Credit (reduces balance)</option>
            <option value="debit">Debit (increases balance)</option>
          </select>
        </label>
        <label className="full">Reason<input required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Post adjustment</button></div>
    </form>
  );
}
