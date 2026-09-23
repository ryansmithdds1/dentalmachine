import { useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, toCents, label } from '../../format.js';
import { ErrorBox, Modal, useSubmit } from '../ui.jsx';

export function PlanSummary({ plan }) {
  return (
    <div className="plan">
      <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <strong>{money(plan.total)} plan · {plan.installments} × {money(plan.installment_amount)} {label(plan.frequency).toLowerCase()}</strong>
        <span className={`badge ${plan.status === 'completed' ? 'ok' : plan.past_due > 0 ? 'danger' : 'info'}`}>{plan.past_due > 0 && plan.status === 'active' ? `${money(plan.past_due)} past due` : plan.status}</span>
      </div>
      <div className="plan-bar"><i style={{ width: `${Math.min(100, (plan.paid / Math.max(1, plan.financed)) * 100)}%` }} /></div>
      <div className="muted" style={{ fontSize: 12 }}>
        {money(plan.paid)} paid of {money(plan.financed)} financed{plan.down_payment ? ` (after ${money(plan.down_payment)} down)` : ''}
        {plan.next_due_date && plan.status === 'active' ? ` · next ${money(plan.next_due_amount)} due ${fmtDate(plan.next_due_date)}` : ''}
        {plan.notes ? ` · ${plan.notes}` : ''}
      </div>
    </div>
  );
}

// Payment plans for the patient's household (plans belong to the guarantor).
export default function PaymentPlans({ patient, onChange }) {
  const { can } = useAuth();
  const { data: plans, reload } = useApi(`/patients/${patient.id}/payment-plans`);
  const { data: cards, reload: reloadCards } = useApi(`/patients/${patient.id}/payment-methods`);
  const { data: payCfg } = useApi('/payments/config');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const act = async (fn, done) => {
    setErr(null);
    setMsg(null);
    try {
      const r = await fn();
      if (done) setMsg(done(r));
      reload();
      reloadCards();
      onChange?.();
    } catch (e) {
      setErr(e);
    }
  };
  if (!plans) return null;
  const w = can('billing:write');
  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Payment plans</h3>
        {can('billing:write') && <button className="small" onClick={() => setCreating(true)}>+ New plan</button>}
      </div>
      {plans.length === 0 && <div className="muted">No payment plans.</div>}
      <ErrorBox error={err} />
      {msg && <div className="public-notice ok" style={{ marginBottom: 8 }}>{msg}</div>}
      {plans.map((p) => (
        <div key={p.id} style={{ marginBottom: 10 }}>
          <PlanSummary plan={p} />
          {p.status === 'active' && payCfg?.cards_on_file && (
            <div className="autopay-row">
              <label className="autopay-label">
                <span>Autopay</span>
                <select disabled={!w} value={p.autopay_method_id || ''} onChange={(e) => act(() => api.put(`/payment-plans/${p.id}`, { autopay_method_id: e.target.value ? Number(e.target.value) : null }))} style={{ width: 'auto' }}>
                  <option value="">Off</option>
                  {cards?.map((c) => <option key={c.id} value={c.id}>{cardLabel(c)}</option>)}
                </select>
              </label>
              {p.autopay_method_id && p.autopay_paused ? <span className="badge danger nocap">Paused after declines</span> : null}
              {p.autopay_message && <span className="muted" style={{ fontSize: 12 }}>{p.autopay_message}</span>}
              {w && p.autopay_method_id && p.past_due > 0 && (
                <button className="small" onClick={() => act(() => api.post(`/payment-plans/${p.id}/charge-now`), (r) => (r.ok ? `Charged ${money(r.amount)}.` : `Declined: ${r.reason}`))}>Charge {money(p.past_due)} now</button>
              )}
            </div>
          )}
          <button className="small link" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Hide schedule' : 'Show schedule'}</button>
          {open === p.id && (
            <table style={{ marginTop: 6 }}>
              <thead><tr><th>#</th><th>Due</th><th className="num">Amount</th><th className="num">Paid</th></tr></thead>
              <tbody>{p.schedule.map((s) => <tr key={s.n}><td>{s.n}</td><td>{fmtDate(s.due_date)}</td><td className="num">{money(s.amount)}</td><td className="num">{s.paid >= s.amount ? '✓' : money(s.paid)}</td></tr>)}</tbody>
            </table>
          )}
          {can('billing:write') && p.status === 'active' && open === p.id && (
            <button className="small danger" onClick={async () => { await api.put(`/payment-plans/${p.id}`, { status: 'cancelled' }); reload(); }}>Cancel plan</button>
          )}
        </div>
      ))}
      {payCfg?.cards_on_file && <CardsOnFile patient={patient} cards={cards} mode={payCfg.mode} onChange={() => { reloadCards(); reload(); }} />}
      {creating && (
        <Modal title="New payment plan" onClose={() => setCreating(false)}>
          <PlanForm patient={patient} onDone={() => { setCreating(false); reload(); onChange?.(); }} />
        </Modal>
      )}
    </div>
  );
}

function PlanForm({ patient, onDone }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ total: '', down_payment: '0', installments: 6, frequency: 'monthly', start_date: today, notes: '' });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const financed = Math.max(0, Number(form.total || 0) - Number(form.down_payment || 0));
  const each = form.installments ? Math.ceil((financed * 100) / Number(form.installments)) / 100 : 0;
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${patient.id}/payment-plans`, {
      ...form, total: toCents(form.total), down_payment: toCents(form.down_payment || 0), installments: Number(form.installments),
    });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Total ($)<input type="number" step="0.01" min="1" required value={form.total} onChange={set('total')} /></label>
        <label>Down payment ($)<input type="number" step="0.01" min="0" value={form.down_payment} onChange={set('down_payment')} /></label>
        <label>Installments<input type="number" min="1" max="120" required value={form.installments} onChange={set('installments')} /></label>
        <label>Frequency<select value={form.frequency} onChange={set('frequency')}><option value="monthly">Monthly</option><option value="biweekly">Every 2 weeks</option><option value="weekly">Weekly</option></select></label>
        <label>First payment due<input type="date" required value={form.start_date} onChange={set('start_date')} /></label>
        <label className="full">Notes<input value={form.notes} onChange={set('notes')} placeholder="e.g. Crown #3 and buildup" /></label>
      </div>
      {financed > 0 && <p className="muted">{form.installments} payments of about <strong>${each.toFixed(2)}</strong>. Record the down payment as a normal payment.</p>}
      <div className="form-actions"><button className="primary" disabled={busy}>Create plan</button></div>
    </form>
  );
}

const cardLabel = (c) => `${c.brand ? c.brand[0].toUpperCase() + c.brand.slice(1) : 'Card'} •••• ${c.last4}${c.exp_month ? ` (exp ${String(c.exp_month).padStart(2, '0')}/${String(c.exp_year).slice(-2)})` : ''}`;

// Cards on file for the account. With Stripe the card is typed on Stripe's secure page (never here).
function CardsOnFile({ patient, cards, mode, onChange }) {
  const { can } = useAuth();
  const [adding, setAdding] = useState(false);
  const [number, setNumber] = useState('4242 4242 4242 4242');
  const [note, setNote] = useState(null);
  const add = useSubmit(async (how) => {
    if (mode === 'sandbox') {
      await api.post(`/patients/${patient.id}/payment-methods`, { number });
      setAdding(false);
      return onChange();
    }
    const r = await api.post(`/patients/${patient.id}/card-setup`, how === 'send' ? { send: 'auto' } : {});
    if (how === 'send') setNote(`Secure card link sent by ${r.message?.channel === 'sms' ? 'text' : 'email'}. The card appears here once saved.`);
    else {
      window.open(r.url, '_blank', 'noopener');
      setNote('The secure card page opened in a new tab. The card appears here once saved.');
    }
    setAdding(false);
  });
  return (
    <div className="cards-on-file">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <strong>Cards on file</strong>
        {can('billing:write') && !adding && <button className="small link" onClick={() => setAdding(true)}>+ Add card</button>}
      </div>
      {cards?.length === 0 && !adding && <div className="muted" style={{ fontSize: 13 }}>None — add one to charge plan installments automatically.</div>}
      {cards?.map((c) => (
        <div key={c.id} className="card-row">
          <span>💳 {cardLabel(c)}</span>
          {can('billing:write') && <button className="small link" onClick={() => confirm('Remove this card? Autopay using it will stop.') && api.del(`/payment-methods/${c.id}`).then(onChange)}>Remove</button>}
        </div>
      ))}
      <ErrorBox error={add.error} />
      {note && <div className="muted" style={{ fontSize: 13 }}>{note}</div>}
      {adding && (mode === 'sandbox' ? (
        <div className="inline" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select value={number} onChange={(e) => setNumber(e.target.value)} style={{ width: 'auto' }}>
            <option value="4242 4242 4242 4242">Test Visa 4242 (approves)</option>
            <option value="5555 5555 5555 4444">Test Mastercard 4444 (approves)</option>
            <option value="4000 0000 0000 0002">Test Visa 0002 (declines)</option>
          </select>
          <button className="small primary" disabled={add.busy} onClick={() => add.submit()}>Save test card</button>
          <button className="small" onClick={() => setAdding(false)}>Cancel</button>
        </div>
      ) : (
        <div className="inline" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="small primary" disabled={add.busy} onClick={() => add.submit('send')}>Text/email secure link</button>
          <button className="small" disabled={add.busy} onClick={() => add.submit('open')}>Open card form here</button>
          <button className="small" onClick={() => setAdding(false)}>Cancel</button>
        </div>
      ))}
    </div>
  );
}
