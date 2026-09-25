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
        <strong>{money(plan.total)} plan · {plan.schedule_edited ? `${plan.installments} payments (custom schedule)` : `${plan.installments} × ${money(plan.installment_amount)} ${label(plan.frequency).toLowerCase()}`}</strong>
        <span className={`badge ${plan.status === 'completed' ? 'ok' : plan.past_due > 0 ? 'danger' : 'info'}`}>{plan.past_due > 0 && plan.status === 'active' ? `${money(plan.past_due)} past due` : plan.status}</span>
      </div>
      <div className="plan-bar"><i style={{ width: `${Math.min(100, (plan.paid / Math.max(1, plan.financed)) * 100)}%` }} /></div>
      <div className="muted" style={{ fontSize: 12 }}>
        {money(plan.paid)} paid of {money(plan.financed)} financed{plan.down_payment ? ` (after ${money(plan.down_payment)} down)` : ''}
        {plan.next_due_date && plan.status === 'active' ? ` · next ${money(plan.next_due_amount)} due ${fmtDate(plan.next_due_date)}` : ''}
        {plan.late_fee ? ` · ${money(plan.late_fee)} late fee after ${plan.late_fee_days} days` : ''}
        {plan.late_fees_charged ? ` (${money(plan.late_fees_charged)} charged)` : ''}
        {plan.notes ? ` · ${plan.notes}` : ''}
      </div>
    </div>
  );
}

// Payment plans for the patient's household (plans belong to the guarantor).
// suggestedTotal: what the patient owes after pending insurance (cents, from the ledger) — the new plan's total.
export default function PaymentPlans({ patient, onChange, suggestedTotal = 0 }) {
  const { can } = useAuth();
  const { data: plans, reload } = useApi(`/patients/${patient.id}/payment-plans`);
  const { data: cards, reload: reloadCards } = useApi(`/patients/${patient.id}/payment-methods`);
  const { data: payCfg } = useApi('/payments/config');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [editing, setEditing] = useState(null);
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
              <thead><tr><th>#</th><th>Due</th><th className="num">Amount</th><th className="num">Paid</th><th className="num">Late fee</th></tr></thead>
              <tbody>{p.schedule.map((s) => <tr key={s.n}><td>{s.n}</td><td>{fmtDate(s.due_date)}</td><td className="num">{money(s.amount)}</td><td className="num">{s.paid >= s.amount ? '✓' : money(s.paid)}</td><td className="num">{s.late_fee ? money(s.late_fee) : ''}</td></tr>)}</tbody>
            </table>
          )}
          {w && p.status === 'active' && open === p.id && (
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="small" onClick={() => setEditing(p)}>Edit schedule & late fee</button>
              <button className="small danger" onClick={async () => { await api.put(`/payment-plans/${p.id}`, { status: 'cancelled' }); reload(); }}>Cancel plan</button>
            </div>
          )}
        </div>
      ))}
      {payCfg?.cards_on_file && <CardsOnFile patient={patient} cards={cards} mode={payCfg.mode} onChange={() => { reloadCards(); reload(); }} />}
      {editing && (
        <Modal title="Edit payment plan" wide onClose={() => setEditing(null)}>
          <ScheduleEditor plan={editing} onDone={() => { setEditing(null); reload(); onChange?.(); }} />
        </Modal>
      )}
      {creating && (
        <Modal title="New payment plan" onClose={() => setCreating(false)}>
          <PlanForm patient={patient} suggestedTotal={suggestedTotal} onDone={() => { setCreating(false); reload(); onChange?.(); }} />
        </Modal>
      )}
    </div>
  );
}

function PlanForm({ patient, onDone, suggestedTotal = 0 }) {
  const today = new Date().toISOString().slice(0, 10);
  // Starts on what the patient owes (after pending insurance); change it for part of the balance.
  const [form, setForm] = useState({ total: suggestedTotal > 0 ? (suggestedTotal / 100).toFixed(2) : '', down_payment: '0', installments: 6, frequency: 'monthly', start_date: today, notes: '' });
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
        <label>Total ($)<input type="number" step="0.01" min="1" required autoFocus value={form.total} onChange={set('total')} />{suggestedTotal > 0 && <span className="muted" style={{ fontSize: 12 }}>Their share of the balance after insurance</span>}</label>
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

const addPeriod = (date, frequency, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  if (frequency === 'monthly') {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  } else d.setUTCDate(d.getUTCDate() + n * (frequency === 'weekly' ? 7 : 14));
  return d.toISOString().slice(0, 10);
};

// Re-arrange what's left: change dates and amounts, add or remove payments, or re-spread the unpaid balance.
function ScheduleEditor({ plan, onDone }) {
  const [rows, setRows] = useState(plan.schedule.map((s) => ({ due_date: s.due_date, amount: (s.amount / 100).toFixed(2), locked: s.paid >= s.amount })));
  const [fee, setFee] = useState({ late_fee: plan.late_fee ? (plan.late_fee / 100).toFixed(2) : '', late_fee_days: plan.late_fee_days ?? 10 });
  const [spread, setSpread] = useState({ count: Math.max(1, plan.schedule.filter((s) => s.paid < s.amount).length), frequency: plan.frequency || 'monthly', from: plan.next_due_date || plan.start_date });
  const total = rows.reduce((t, r) => t + toCents(r.amount || 0), 0);
  const off = total - plan.financed;
  const set = (i, patch) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const respread = () => {
    const kept = rows.filter((r) => r.locked);
    const left = plan.financed - kept.reduce((t, r) => t + toCents(r.amount), 0);
    const n = Math.max(1, Number(spread.count) || 1);
    const base = Math.floor(left / n);
    const extra = left - base * n;
    setRows([...kept, ...Array.from({ length: n }, (_, i) => ({ due_date: addPeriod(spread.from, spread.frequency, i), amount: ((base + (i < extra ? 1 : 0)) / 100).toFixed(2), locked: false }))]);
  };
  const { submit, busy, error } = useSubmit(async () => {
    await api.put(`/payment-plans/${plan.id}`, {
      schedule: rows.map((r) => ({ due_date: r.due_date, amount: toCents(r.amount) })),
      late_fee: toCents(fee.late_fee || 0), late_fee_days: Number(fee.late_fee_days) || 0,
    });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <p className="muted" style={{ fontSize: 13 }}>Payments already made stay put. The schedule must add up to the {money(plan.financed)} financed.</p>
      <div className="inline plan-respread" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
        <span>Spread what&apos;s unpaid over</span>
        <input type="number" min="1" max="120" aria-label="Number of payments" value={spread.count} onChange={(e) => setSpread({ ...spread, count: e.target.value })} style={{ width: 70 }} />
        <select aria-label="How often" value={spread.frequency} onChange={(e) => setSpread({ ...spread, frequency: e.target.value })} style={{ width: 'auto' }}>
          <option value="weekly">weekly</option><option value="biweekly">every 2 weeks</option><option value="monthly">monthly</option>
        </select>
        <span>payments from</span>
        <input type="date" aria-label="First payment" value={spread.from} onChange={(e) => setSpread({ ...spread, from: e.target.value })} style={{ width: 'auto' }} />
        <button type="button" className="small" onClick={respread}>Re-spread</button>
      </div>
      <table>
        <thead><tr><th>#</th><th>Due</th><th className="num">Amount ($)</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{r.locked ? fmtDate(r.due_date) : <input type="date" aria-label={`Payment ${i + 1} date`} value={r.due_date} onChange={(e) => set(i, { due_date: e.target.value })} />}</td>
              <td className="num">{r.locked ? <>{money(toCents(r.amount))} <span className="muted">paid</span></> : <input type="number" step="0.01" min="0.01" aria-label={`Payment ${i + 1} amount`} value={r.amount} onChange={(e) => set(i, { amount: e.target.value })} style={{ width: 110 }} />}</td>
              <td>{!r.locked && rows.length > 1 && <button type="button" className="small link" onClick={() => setRows(rows.filter((_, k) => k !== i))}>Remove</button>}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td /><td><button type="button" className="small link" onClick={() => setRows([...rows, { due_date: addPeriod(rows.at(-1)?.due_date || plan.start_date, spread.frequency, 1), amount: '', locked: false }])}>+ Add a payment</button></td><td className={`num ${off ? 'text-danger' : ''}`}><strong>{money(total)}</strong>{off ? ` (${off > 0 ? 'over' : 'short'} ${money(Math.abs(off))})` : ''}</td><td /></tr></tfoot>
      </table>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <label>Late fee ($)<input type="number" step="0.01" min="0" value={fee.late_fee} placeholder="none" onChange={(e) => setFee({ ...fee, late_fee: e.target.value })} /></label>
        <label>Charged when a payment is this many days late<input type="number" min="0" max="90" value={fee.late_fee_days} onChange={(e) => setFee({ ...fee, late_fee_days: e.target.value })} /></label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy || off !== 0}>Save</button></div>
    </form>
  );
}
