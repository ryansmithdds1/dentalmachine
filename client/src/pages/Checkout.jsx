import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, fmtTime, label, toCents, practiceToday } from '../format.js';
import { Badge, ErrorBox, Modal, useSubmit } from '../components/ui.jsx';
import AppointmentForm from '../components/AppointmentForm.jsx';

const METHODS = ['credit_card', 'debit_card', 'cash', 'check', 'care_credit', 'ach', 'other'];

// End of visit on one screen: finish the work, file the claim, collect, book the next visit, print the walkout.
export default function Checkout() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, practice } = useAuth();
  const { data: co, reload, error: loadErr } = useApi(`/appointments/${id}/checkout`);
  const [err, setErr] = useState(null);
  const [booking, setBooking] = useState(null);
  const [note, setNote] = useState(null);
  const act = async (fn, msg) => {
    setErr(null);
    try {
      await fn();
      if (msg) setNote(msg);
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  if (loadErr) return <div className="error">{loadErr.message}</div>;
  if (!co) return <div className="empty">Loading…</div>;
  const a = co.appointment;
  const planned = co.procedures.filter((p) => p.status === 'planned');
  const est = Object.fromEntries((co.estimate.items || []).map((i) => [i.procedure_id, i]));
  const recall = co.recalls.find((r) => ['due', 'contacted'].includes(r.status));
  const patient = { id: a.patient_id, first_name: a.first_name, last_name: a.last_name };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Check out · {a.first_name} {a.last_name}</h1>
          <div className="muted">{fmtDate(a.start_time.slice(0, 10))} {fmtTime(a.start_time)} · {a.provider_name}{a.operatory_name ? ` · ${a.operatory_name}` : ''} <Badge value={a.status} /></div>
        </div>
        <div className="actions">
          <Link to={`/patients/${a.patient_id}`}><button>Open chart</button></Link>
          <button onClick={() => window.open(`/appointments/${a.id}/walkout`, '_blank')}>Print walkout</button>
          <button onClick={() => nav('/schedule')}>Back to schedule</button>
        </div>
      </div>
      <ErrorBox error={err} />
      {note && <div className="public-notice ok" style={{ marginBottom: 12 }}>{note}</div>}

      <div className="checkout-steps">
        <section className="card">
          <h2><span className="step-num">1</span> Today&apos;s work</h2>
          <table className="compact-table">
            <thead><tr><th>Code</th><th>Procedure</th><th>Tooth</th><th>Status</th><th className="num">Fee</th><th className="num">Est. ins.</th><th className="num">Patient</th></tr></thead>
            <tbody>
              {co.procedures.map((p) => (
                <tr key={p.id}>
                  <td>{p.code}</td><td>{p.description}</td><td>{p.tooth ? `#${p.tooth}` : ''} {p.surfaces || ''}{p.area || ''}</td>
                  <td><Badge value={p.status} />{p.claim_id ? <div className="muted" style={{ fontSize: 11 }}><Link to={`/claims/${p.claim_id}`}>claim #{p.claim_id}</Link></div> : null}</td>
                  <td className="num">{money(p.fee)}</td>
                  <td className="num">{est[p.id] ? money(est[p.id].insurance) : '—'}</td>
                  <td className="num">{est[p.id] ? money(est[p.id].patient) : p.status === 'planned' ? '—' : money(p.fee)}</td>
                </tr>
              ))}
              {!co.procedures.length && <tr><td colSpan={7} className="muted">No procedures on this visit.</td></tr>}
            </tbody>
          </table>
          <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
            {planned.length > 0 && can('clinical:write') && (
              <button className="primary" onClick={() => act(() => api.post(`/appointments/${a.id}/checkout`, { complete_procedures: true, finish: false }), `Completed ${planned.length} procedure${planned.length > 1 ? 's' : ''}; charges posted.`)}>
                Complete {planned.length} planned procedure{planned.length > 1 ? 's' : ''}
              </button>
            )}
            {co.unclaimed.length > 0 && can('billing:write') && (
              <button onClick={() => act(async () => { const c = await api.post('/claims', { patient_insurance_id: co.policy.id, procedure_ids: co.unclaimed }); setNote(`Claim #${c.id} created for ${co.policy.carrier_name}.`); })}>
                Create claim ({co.policy.carrier_name})
              </button>
            )}
          </div>
        </section>

        <section className="card">
          <h2><span className="step-num">2</span> Collect</h2>
          <div className="checkout-money">
            <div><span>Account balance</span><strong className={co.balance > 0 ? 'text-danger' : ''}>{money(co.balance)}</strong></div>
            <div><span>Today&apos;s estimated patient portion</span><strong>{money(co.estimate.total_patient)}</strong></div>
            <div><span>Paid today</span><strong>{money(co.paid_today)}</strong></div>
            <div><span>Suggested now</span><strong>{money(co.suggested_payment)}</strong></div>
          </div>
          {can('billing:write') ? <CollectForm key={co.suggested_payment} patientId={a.patient_id} suggested={co.suggested_payment} onDone={(amt) => { setNote(`Payment of ${money(amt)} posted.`); reload(); }} /> : <p className="muted">Ask billing to take the payment.</p>}
        </section>

        <section className="card">
          <h2><span className="step-num">3</span> Next visit</h2>
          {co.next_appointment ? (
            <p>Next: <strong>{fmtDate(co.next_appointment.start_time.slice(0, 10))} {fmtTime(co.next_appointment.start_time)}</strong> · {co.next_appointment.reason || 'appointment'}</p>
          ) : <p className="muted">Nothing booked yet.</p>}
          {co.recalls.length > 0 && (
            <p style={{ fontSize: 14 }}>Recall: {co.recalls.map((r) => `${r.type_name} due ${fmtDate(r.due_date)}${r.status === 'scheduled' ? ' (booked)' : ''}`).join(' · ')}</p>
          )}
          {co.unscheduled.length > 0 && (
            <p style={{ fontSize: 14 }}>Still to schedule: {co.unscheduled.map((p) => `${p.code}${p.tooth ? ` #${p.tooth}` : ''}`).join(', ')} ({money(co.unscheduled.reduce((s, p) => s + p.fee, 0))})</p>
          )}
          {can('schedule:write') && (
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              {recall && <button className="primary" onClick={() => setBooking({ date: recall.due_date > practiceToday(practice?.timezone) ? recall.due_date : practiceToday(practice?.timezone), appointment_type_id: recall.appointment_type_id, reason: recall.type_name })}>Book {recall.type_name.toLowerCase()} recall</button>}
              {co.unscheduled.length > 0 && <button onClick={() => setBooking({ date: practiceToday(practice?.timezone), procedure_ids: co.unscheduled.map((p) => p.id), reason: 'Treatment' })}>Book remaining treatment</button>}
              <button onClick={() => setBooking({ date: practiceToday(practice?.timezone) })}>Book another visit</button>
            </div>
          )}
        </section>

        <section className="card">
          <h2><span className="step-num">4</span> Finish</h2>
          {a.checked_out_at ? <p><span className="badge ok">Checked out</span> at {fmtTime(a.checked_out_at)}</p> : (
            <button className="primary" onClick={() => act(() => api.post(`/appointments/${a.id}/checkout`, {}), 'Checked out.')}>Mark checked out</button>
          )}
          <button style={{ marginLeft: 8 }} onClick={() => window.open(`/appointments/${a.id}/walkout`, '_blank')}>Print walkout</button>
        </section>
      </div>

      {booking && (
        <Modal title={`Book ${a.first_name}'s next visit`} wide onClose={() => setBooking(null)}>
          <AppointmentForm patient={patient} defaults={booking} onCancel={() => setBooking(null)} onSaved={() => { setBooking(null); setNote('Next visit booked.'); reload(); }} />
        </Modal>
      )}
    </>
  );
}

function CollectForm({ patientId, suggested, onDone }) {
  const [form, setForm] = useState({ amount: suggested > 0 ? (suggested / 100).toFixed(2) : '', method: 'credit_card', reference: '' });
  const { submit, busy, error } = useSubmit(async () => {
    const amount = toCents(form.amount);
    await api.post(`/patients/${patientId}/payments`, { amount, method: form.method, reference: form.reference || null });
    onDone(amount);
  });
  return (
    <form className="inline" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <label>Amount ($)<input type="number" step="0.01" min="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} style={{ width: 120 }} /></label>
      <label>Method<select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>{METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></label>
      <label>Reference<input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="last 4, check #" style={{ width: 140 }} /></label>
      <button className="primary" disabled={busy}>Post payment</button>
    </form>
  );
}
