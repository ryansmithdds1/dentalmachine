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
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  if (!plans) return null;
  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Payment plans</h3>
        {can('billing:write') && <button className="small" onClick={() => setCreating(true)}>+ New plan</button>}
      </div>
      {plans.length === 0 && <div className="muted">No payment plans.</div>}
      {plans.map((p) => (
        <div key={p.id} style={{ marginBottom: 10 }}>
          <PlanSummary plan={p} />
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
