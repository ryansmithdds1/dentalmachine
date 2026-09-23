import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, label, toCents } from '../../format.js';
import { ErrorBox, Modal, useSubmit } from '../ui.jsx';
import PaymentPlans from './PaymentPlans.jsx';

const KINDS = { Charges: ['charge'], 'Patient payments': ['payment'], 'Insurance payments': ['insurance_payment'], Adjustments: ['adjustment'], Refunds: ['refund'] };
const METHODS = ['credit_card', 'debit_card', 'cash', 'check', 'ach', 'care_credit', 'other'];

export default function LedgerTab({ patient, onChange }) {
  const { can } = useAuth();
  const { data, reload } = useApi(`/patients/${patient.id}/ledger`);
  const { data: payConfig } = useApi('/payments/config');
  const { data: payRequests, reload: reloadRequests } = useApi(`/patients/${patient.id}/payment-requests`);
  const [modal, setModal] = useState(null);
  const [kind, setKind] = useState('');
  const [prov, setProv] = useState('');
  const [hideVoided, setHideVoided] = useState(false);
  // ?pay=1 (from quick search "Take payment…") opens the payment form.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (!params.get('pay')) return;
    setModal('payment');
    const next = new URLSearchParams(params);
    next.delete('pay');
    setParams(next, { replace: true });
  }, [params, setParams]);
  const done = () => { setModal(null); reload(); onChange?.(); };
  if (!data) return <div className="empty">Loading…</div>;
  const providers = [...new Map(data.entries.filter((e) => e.provider_id).map((e) => [e.provider_id, e.provider_name])).entries()];
  const shown = data.entries.filter((e) => (!kind || KINDS[kind].includes(e.type)) && (!prov || String(e.provider_id) === prov) && !(hideVoided && (e.voided_at || e.reverses_id)));
  const filtered = shown.length !== data.entries.length;

  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card stat"><div className="label">Account balance</div><div className="value">{money(data.balance)}</div></div>
        <div className="card stat">
          <div className="label">Pending insurance</div><div className="value">{money(data.pending_insurance)}</div>
          {data.pending_write_off > 0 && <div className="muted" style={{ fontSize: 12 }}>+ {money(data.pending_write_off)} in-network write-off expected</div>}
        </div>
        {data.patient_portion < 0
          ? <div className="card stat"><div className="label">Est. credit after insurance</div><div className="value" style={{ color: 'var(--ok, #15803d)' }}>{money(-data.patient_portion)}</div></div>
          : <div className="card stat"><div className="label">Est. patient portion</div><div className="value" style={{ color: data.patient_portion > 0 ? 'var(--danger)' : undefined }}>{money(data.patient_portion)}</div></div>}
        {data.unapplied_credit > 0 && <div className="card stat"><div className="label">Unapplied credit</div><div className="value">{money(data.unapplied_credit)}</div><div className="muted" style={{ fontSize: 12 }}>paid ahead — applies to the next charges</div></div>}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="page-header" style={{ padding: '14px 16px', marginBottom: 0 }}>
          <h2 style={{ margin: 0 }}>Ledger</h2>
          <div className="actions">
            <Link to={`/patients/${patient.id}/statement`}><button>Print statement</button></Link>
            {(patient.guarantor || patient.family_size > 1) && <Link to={`/patients/${patient.id}/statement?family=1`}><button>Family statement</button></Link>}
            {can('billing:write') && (
              <>
                {payConfig?.enabled && <button onClick={() => setModal('paylink')}>Send card payment link</button>}
                <button onClick={() => setModal('adjustment')}>Adjustment</button>
                {data.balance < 0 && <button onClick={() => setModal('refund')}>Refund credit</button>}
                {(patient.guarantor || patient.family_size > 1) && <button onClick={() => setModal('transfer')} title="Move a balance or credit to another family member">Transfer</button>}
                <button className="primary" onClick={() => setModal('payment')}>Take payment</button>
              </>
            )}
          </div>
        </div>
        <div className="inline ledger-filters" style={{ gap: 8, padding: '0 16px 10px', flexWrap: 'wrap' }}>
          <select aria-label="Show entries" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All entries</option>
            {Object.keys(KINDS).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          {providers.length > 0 && (
            <select aria-label="Provider" value={prov} onChange={(e) => setProv(e.target.value)} style={{ width: 'auto' }}>
              <option value="">All providers</option>
              {providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          )}
          <label className="inline" style={{ gap: 4, flexDirection: "row", alignItems: "center", margin: 0 }}><input type="checkbox" style={{ width: "auto" }} checked={hideVoided} onChange={(e) => setHideVoided(e.target.checked)} /> Hide voided</label>
          {filtered && <span className="muted">{shown.length} of {data.entries.length} entries · charges {money(shown.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0))} · credits {money(-shown.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0))}</span>}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Type</th><th>Description</th><th>By</th><th className="num">Charges</th><th className="num">Credits</th><th className="num">Balance</th>{can('billing:write') && <th />}</tr></thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id} className={e.voided_at ? 'voided' : undefined}>
                  <td>{fmtDate(e.entry_date)}</td>
                  <td>{label(e.type)}</td>
                  <td>
                    {e.proc_code && <span className="badge" style={{ marginRight: 6 }}>{e.proc_code}{e.proc_tooth ? ` #${e.proc_tooth}` : ''}{e.proc_surfaces ? ` ${e.proc_surfaces}` : ''}</span>}
                    {e.description}{e.reference ? <span className="muted"> · ref {e.reference}</span> : ''}
                    {e.claim_link && <> · <Link to={`/claims/${e.claim_link}`}>claim #{e.claim_link}</Link></>}
                    {e.provider_name && <span className="muted"> · {e.provider_name}</span>}
                    {e.voided_at && <div className="muted" style={{ fontSize: 12 }}>Voided — {e.void_reason}</div>}
                  </td>
                  <td className="muted">{e.created_by_name}</td>
                  <td className="num">{e.amount > 0 ? money(e.amount) : ''}</td>
                  <td className="num">{e.amount < 0 ? money(-e.amount) : ''}</td>
                  <td className="num">{money(e.running_balance)}</td>
                  {can('billing:write') && (
                    <td className="num">
                      {!e.voided_at && !e.reverses_id && !e.claim_id && <button className="small" title={e.type === 'charge' ? 'Void this charge and put the procedure back to planned' : 'Void this entry'} onClick={() => setModal({ void: e })}>Void</button>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!data.entries.length && <div className="empty">No transactions.</div>}
          {data.entries.length > 0 && !shown.length && <div className="empty">No entries match.</div>}
        </div>
      </div>
      {modal === 'payment' && <Modal title="Take payment" onClose={() => setModal(null)}><PaymentForm patient={patient} balance={data.patient_portion} lockDate={data.lock_date} onDone={done} /></Modal>}
      <PaymentPlans patient={patient} onChange={reload} />
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
      {modal === 'adjustment' && <Modal title="Ledger adjustment" onClose={() => setModal(null)}><AdjustmentForm patient={patient} lockDate={data.lock_date} onDone={done} /></Modal>}
      {modal === 'transfer' && <Modal title="Transfer within the family" onClose={() => setModal(null)}><TransferForm patient={patient} balance={data.balance} onDone={done} /></Modal>}
      {modal === 'refund' && <Modal title="Refund credit" onClose={() => setModal(null)}><RefundForm patient={patient} credit={-data.balance} entries={data.entries} onDone={done} /></Modal>}
      {modal?.void && <Modal title={`Void ${label(modal.void.type).toLowerCase()}`} onClose={() => setModal(null)}><VoidForm entry={modal.void} onDone={done} /></Modal>}
    </>
  );
}

// Voiding keeps the original on the ledger and posts an equal and opposite entry today.
function VoidForm({ entry, onDone }) {
  const [reason, setReason] = useState('');
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/ledger/${entry.id}/void`, { reason });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <p><strong>{entry.description}</strong> · {money(Math.abs(entry.amount))} on {fmtDate(entry.entry_date)}</p>
      <p className="muted" style={{ fontSize: 13 }}>
        The entry stays on the ledger marked void, and a reversing entry is posted today, so closed days don't change.
        {entry.type === 'charge' && entry.procedure_id ? ' The procedure goes back to planned.' : ''}
        {entry.type === 'payment' && /^(pi_|sbx_)/.test(entry.reference || '') ? " This doesn't return money to the card — use Refund credit for that." : ''}
      </p>
      <label>Reason<input autoFocus required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Posted to the wrong patient" /></label>
      <div className="form-actions"><button className="danger" disabled={busy || !reason.trim()}>Void entry</button></div>
    </form>
  );
}

function RefundForm({ patient, credit, entries, onDone }) {
  const cardPayments = entries.filter((e) => e.type === 'payment' && e.amount < 0 && !e.voided_at && ['credit_card', 'debit_card'].includes(e.method) && /^(pi_|sbx_)/.test(e.reference || ''));
  const [form, setForm] = useState({ amount: (credit / 100).toFixed(2), payment_id: cardPayments.at(-1)?.id ? String(cardPayments.at(-1).id) : '', method: 'check', reference: '' });
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${patient.id}/refunds`, { amount: toCents(form.amount), ...(form.payment_id ? { payment_id: Number(form.payment_id) } : { method: form.method, reference: form.reference || null }) });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <p className="muted">This account has a {money(credit)} credit.</p>
      <div className="form-grid">
        <label>Amount ($)<input type="number" step="0.01" min="0.01" max={(credit / 100).toFixed(2)} required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label>
          Refund to
          <select value={form.payment_id} onChange={(e) => setForm({ ...form, payment_id: e.target.value })}>
            {cardPayments.map((p) => <option key={p.id} value={p.id}>Card payment {fmtDate(p.entry_date)} ({money(-p.amount)})</option>)}
            <option value="">Cash or check from the office</option>
          </select>
        </label>
        {!form.payment_id && (
          <>
            <label>Method<select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>{['check', 'cash', 'ach', 'other'].map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></label>
            <label>Check # / reference<input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></label>
          </>
        )}
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>{form.payment_id ? 'Refund to card' : 'Record refund'}</button></div>
    </form>
  );
}

// Backdating is allowed only into the open period (after the practice's lock date), never the future.
function DateField({ value, onChange, lockDate }) {
  const today = new Date().toLocaleDateString('en-CA');
  return <label>Date<input type="date" value={value} max={today} min={lockDate ? new Date(Date.parse(`${lockDate}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10) : undefined} onChange={(e) => onChange(e.target.value)} placeholder="Today" /></label>;
}

function PaymentForm({ patient, balance, lockDate, onDone }) {
  const { data: plans } = useApi(`/patients/${patient.id}/payment-plans`);
  const active = (plans || []).filter((p) => p.status === 'active');
  const [form, setForm] = useState({ amount: balance > 0 ? (balance / 100).toFixed(2) : '', method: 'credit_card', reference: '', payment_plan_id: '', entry_date: '' });
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${patient.id}/payments`, { ...form, entry_date: form.entry_date || undefined, amount: toCents(form.amount), payment_plan_id: form.payment_plan_id ? Number(form.payment_plan_id) : null });
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
        <label>Reference (check #, last 4, auth code)<input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></label>
        <DateField value={form.entry_date} lockDate={lockDate} onChange={(v) => setForm({ ...form, entry_date: v })} />
        {active.length > 0 && (
          <label className="full">
            Apply to payment plan
            <select value={form.payment_plan_id} onChange={(e) => {
              const plan = active.find((p) => String(p.id) === e.target.value);
              setForm({ ...form, payment_plan_id: e.target.value, ...(plan ? { amount: ((plan.past_due || plan.next_due_amount) / 100).toFixed(2) } : {}) });
            }}>
              <option value="">No plan</option>
              {active.map((p) => <option key={p.id} value={p.id}>{money(p.total)} plan — {p.past_due ? `${money(p.past_due)} past due` : `next ${money(p.next_due_amount)}`}</option>)}
            </select>
          </label>
        )}
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

function TransferForm({ patient, balance, onDone }) {
  const { data: family } = useApi(`/patients/${patient.id}/family`);
  const members = (family?.members || []).filter((m) => m.id !== patient.id);
  const [form, setForm] = useState({ to: '', kind: balance < 0 ? 'credit' : 'balance', amount: (Math.abs(balance) / 100).toFixed(2), note: '' });
  const { submit, busy, error } = useSubmit(async () => {
    const cents = toCents(form.amount);
    await api.post(`/patients/${patient.id}/transfer`, { to_patient_id: Number(form.to), amount: form.kind === 'credit' ? -cents : cents, note: form.note });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>To<select required value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })}><option value="">Choose…</option>{members.map((m) => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}</select></label>
        <label>Move<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="balance">Balance owed</option><option value="credit">Credit</option></select></label>
        <label>Amount ($)<input type="number" step="0.01" min="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label>Note<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Overpayment applied to son's visit" /></label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Transfer</button></div>
    </form>
  );
}

function AdjustmentForm({ patient, lockDate, onDone }) {
  const { data: types } = useApi('/adjustment-types');
  const [form, setForm] = useState({ amount: '', direction: 'credit', description: 'Courtesy discount', entry_date: '', adjustment_type: 'Courtesy discount' });
  const { submit, busy, error } = useSubmit(async () => {
    const cents = toCents(form.amount);
    await api.post(`/patients/${patient.id}/adjustments`, { amount: form.direction === 'credit' ? -cents : cents, description: form.description, entry_date: form.entry_date || undefined, adjustment_type: form.adjustment_type || null });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Amount ($)<input type="number" step="0.01" min="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label>
          Type
          <select value={form.adjustment_type} onChange={(e) => {
            const t = types?.find((x) => x.name === e.target.value);
            setForm({ ...form, adjustment_type: e.target.value, direction: t?.direction || form.direction, description: form.description === form.adjustment_type || !form.description ? e.target.value : form.description });
          }}>
            {(types || []).filter((t) => t.active && t.name !== 'Insurance write-off').map((t) => <option key={t.id} value={t.name}>{t.name} ({t.direction === 'credit' ? 'reduces balance' : 'adds to balance'})</option>)}
          </select>
        </label>
        <label>Reason<input required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <DateField value={form.entry_date} lockDate={lockDate} onChange={(v) => setForm({ ...form, entry_date: v })} />
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Post adjustment</button></div>
    </form>
  );
}
