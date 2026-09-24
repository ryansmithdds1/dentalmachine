import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, fmtTime, label, toCents, practiceToday } from '../format.js';
import { Badge, ErrorBox, Modal, useSubmit } from '../components/ui.jsx';
import AppointmentForm from '../components/AppointmentForm.jsx';
import { ReaderPay, useReaders } from '../components/CardReader.jsx';
import NextVisitPicker from '../components/NextVisitPicker.jsx';
import { useLastMethod, methodToPost } from '../components/patient/lastMethod.js';
import '../components/patient/moneyflows.css';
import { requestReview } from '../reviewRequest.js';
import { fileClaim, toastFiled } from '../components/billClaim.js';
import { useShortcut } from '../shortcuts.js';
import { useMakeActive } from '../activePatient.jsx';

const METHODS = ['credit_card', 'debit_card', 'cash', 'check', 'care_credit', 'ach', 'other'];

// End of visit on one screen: finish the work, file the claim, collect, book the next visit, print the walkout.
export default function Checkout() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can, practice } = useAuth();
  const { data: co, reload, error: loadErr } = useApi(`/appointments/${id}/checkout`);
  // The patient being checked out becomes the active patient (the bar at the top follows them).
  const a0 = co?.appointment;
  useMakeActive(a0 ? { id: a0.patient_id, first_name: a0.first_name, last_name: a0.last_name } : null);
  const { data: connection } = useApi(can('billing:write') ? '/clearinghouse' : null);
  const [err, setErr] = useState(null);
  const [booking, setBooking] = useState(null);
  const [picking, setPicking] = useState(false);
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
  // Workflow 24: the claim for today's finished work is made and sent in one action (B, or the button).
  const canBill = !!co?.policy && co.unclaimed.length > 0 && can('billing:write');
  const bill = () => canBill && act(async () => {
    const out = await fileClaim({ policy: co.policy, procedureIds: co.unclaimed, connection });
    toastFiled(out, { policy: co.policy, connection });
    if (!out.sent) throw out.error;
    setNote(`Claim #${out.claim.id} ${connection?.batch ? `sent to ${co.policy.carrier_name}` : 'saved as an 837 file'}.`);
  });
  useShortcut('b', bill, { label: 'Bill insurance for today’s work (make and send the claim)', section: 'Check out', enabled: canBill });
  // The payment amount has the focus when the screen opens (workflow 12). A letter means nothing in a number field,
  // so B still bills from there; in text fields (the reference) it types as usual.
  const billRef = useRef(bill);
  billRef.current = bill;
  useEffect(() => {
    if (!canBill) return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'b') return;
      if (!e.target.matches?.('.checkout-steps input[type=number]') || document.querySelector('.modal, .palette')) return;
      e.preventDefault();
      billRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canBill]);
  if (loadErr) return <div className="error">{loadErr.message}</div>;
  if (!co) return <div className="empty">Loading…</div>;
  const a = co.appointment;
  const planned = co.procedures.filter((p) => p.status === 'planned');
  const est = Object.fromEntries((co.estimate?.items || []).map((i) => [i.procedure_id, i]));
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
          <div className="table-wrap">
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
          </div>
          <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
            {planned.length > 0 && can('clinical:write') && (
              <button className="primary" onClick={() => act(() => api.post(`/appointments/${a.id}/checkout`, { complete_procedures: true, finish: false }), `Completed ${planned.length} procedure${planned.length > 1 ? 's' : ''}; charges posted.`)}>
                Complete {planned.length} planned procedure{planned.length > 1 ? 's' : ''}
              </button>
            )}
            {canBill && (
              <button onClick={bill} title="Makes the claim for today’s finished work and sends it (B)">
                {connection?.batch ? 'Send claim' : 'Create claim'} to {co.policy.carrier_name} <kbd className="elig-kbd">B</kbd>
              </button>
            )}
          </div>
        </section>

        <section className="card">
          <h2><span className="step-num">2</span> Collect</h2>
          {/* Without billing access the server leaves the money out (estimate is null), so there is nothing to show. */}
          {co.estimate && (
            <div className="checkout-money">
              <div><span>Account balance</span><strong className={co.balance > 0 ? 'text-danger' : ''}>{money(co.balance)}</strong></div>
              <div><span>Today&apos;s estimated patient portion</span><strong>{money(co.estimate.total_patient)}</strong></div>
              <div><span>Paid today</span><strong>{money(co.paid_today)}</strong></div>
              <div><span>Suggested now</span><strong>{money(co.suggested_payment)}</strong></div>
            </div>
          )}
          {can('billing:write') ? <CollectForm key={co.suggested_payment} patient={patient} patientId={a.patient_id} suggested={co.suggested_payment} onDone={(amt) => { setNote(`Payment of ${money(amt)} posted.`); reload(); }} /> : <p className="muted">Ask billing to take the payment.</p>}
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
          {can('schedule:write') && recall && picking && (
            <NextVisitPicker
              patientId={a.patient_id} recall={recall} onCancel={() => setPicking(false)}
              onBooked={(appt, provider) => { setPicking(false); setNote(`Booked ${recall.type_name.toLowerCase()} for ${fmtDate(appt.start_time.slice(0, 10))} at ${fmtTime(appt.start_time)} with ${provider.name}.`); reload(); }}
              // Another time: the full form, starting from the suggestion (the type sets the length).
              onOther={(slot, provider) => {
                setPicking(false);
                const date = slot?.start_time.slice(0, 10) || (recall.due_date > practiceToday(practice?.timezone) ? recall.due_date : practiceToday(practice?.timezone));
                setBooking({ date, time: slot?.start_time.slice(11, 16), provider_id: provider?.id, operatory_id: slot?.operatory_id || undefined, appointment_type_id: recall.appointment_type_id, reason: recall.type_name });
              }}
            />
          )}
          {can('schedule:write') && (
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              {recall && !picking && <button className="primary" onClick={() => setPicking(true)}>Book {recall.type_name.toLowerCase()} recall</button>}
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
          {can('patients:write') && <button style={{ marginLeft: 8 }} title="Text (or email) a “how did we do?” link" onClick={() => requestReview(a.patient_id, { source: 'checkout', appointmentId: a.id, name: `${a.first_name} ${a.last_name}` })}>Ask for a review</button>}
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

// Collect at checkout: the amount is ready to type (the suggested patient portion), the method is the one this
// person used last, and Enter posts. The card reader opens in place, not as a second dialog.
function CollectForm({ patient, patientId, suggested, onDone }) {
  const [lastMethod, rememberMethod] = useLastMethod(METHODS);
  const [form, setForm] = useState({ amount: suggested > 0 ? (suggested / 100).toFixed(2) : '', method: lastMethod, reference: '' });
  const picked = useRef(false);
  useEffect(() => { if (!picked.current) setForm((f) => ({ ...f, method: lastMethod })); }, [lastMethod]);
  const terminal = useReaders();
  const [onReader, setOnReader] = useState(false);
  const { data: contact } = useApi(onReader ? `/patients/${patientId}` : null); // email and phone for the receipt
  const posting = useRef(false);
  const { submit, busy, error } = useSubmit(async () => {
    if (posting.current) return; // one post per press; the Idempotency-Key covers retries
    posting.current = true;
    try {
      const amount = toCents(form.amount);
      const method = await methodToPost(METHODS, form, picked.current);
      await api.post(`/patients/${patientId}/payments`, { amount, method, reference: form.reference || null });
      rememberMethod(method);
      onDone(amount);
    } finally {
      posting.current = false;
    }
  });
  return (
    <>
    <form className="inline" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <label>Amount ($)<input type="number" step="0.01" min="0.01" required autoFocus onFocus={(e) => e.target.select()} aria-label="Payment amount" disabled={busy} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} style={{ width: 120 }} /></label>
      <label>Method<select value={form.method} disabled={busy} onChange={(e) => { picked.current = true; setForm({ ...form, method: e.target.value }); }}>{METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></label>
      <label>Reference<input value={form.reference} disabled={busy} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="last 4, check #" style={{ width: 140 }} /></label>
      <button className="primary" disabled={busy}>Post payment</button>
      {terminal.readers.length > 0 && patient && <button type="button" onClick={() => setOnReader(!onReader)}>{onReader ? 'Close card reader' : 'Card reader…'}</button>}
    </form>
    {onReader && (
      <div className="inline-panel" style={{ marginTop: 10 }} aria-label="Card reader payment">
        <header><h3>Card reader payment</h3><button className="small" onClick={() => setOnReader(false)}>Cancel</button></header>
        {contact && <ReaderPay patient={contact} amount={toCents(form.amount || 0)} readers={terminal.readers} testMode={terminal.test_mode} onDone={(p) => { setOnReader(false); onDone(p.amount); }} />}
      </div>
    )}
    </>
  );
}
