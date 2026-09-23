import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { money, fmtDate, fmtUtcDate } from '../format.js';
import { useAuth } from '../auth.jsx';

const useAutoPrint = (ready) => {
  useEffect(() => {
    if (ready) setTimeout(() => window.print(), 300);
  }, [ready]);
};

// Printable treatment plan / case presentation.
export function TreatmentPlanPrint() {
  const { id } = useParams();
  const { data: live } = useApi(`/treatment-plans/${id}`);
  const tz = useAuth().practice?.timezone;
  const signedCopy = new URLSearchParams(window.location.search).get('signed') === '1';
  useAutoPrint(!!live);
  if (!live) return <div className="empty">Loading…</div>;
  // The signed copy prints exactly what the patient signed, even if the plan changed afterwards.
  const t = signedCopy && live.signed_version ? { ...live, procedures: live.signed_version.procedures, estimate: live.signed_version.estimate } : { ...live, signed_at: live.signed_version?.changed ? null : live.signed_at };
  const est = Object.fromEntries(t.estimate.items.map((i) => [i.procedure_id, i]));
  return (
    <div className="print-doc">
      <div className="no-print" style={{ marginBottom: 12 }}><Link to={`/patients/${t.patient.id}`}>← Back</Link> <button onClick={() => window.print()}>Print</button></div>
      <header className="doc-head">
        <div><h1>{t.practice.name}</h1><div>{t.practice.address}, {t.practice.city}, {t.practice.state} {t.practice.zip} · {t.practice.phone}</div></div>
        <div style={{ textAlign: 'right' }}><h2>Treatment plan</h2><div>{fmtUtcDate(t.created_at, tz)}</div></div>
      </header>
      <p><strong>{t.patient.first_name} {t.patient.last_name}</strong> · DOB {t.patient.dob ? fmtDate(t.patient.dob) : '—'} · {t.name}{t.option_label ? ` (${t.option_label})` : ''}</p>
      <table>
        <thead><tr><th>Code</th><th>Procedure</th><th>Tooth</th><th className="num">Fee</th><th className="num">Est. insurance</th><th className="num">Your estimate</th></tr></thead>
        <tbody>
          {t.procedures.filter((p) => p.status === 'planned').map((p, i, list) => [
            new Set(list.map((x) => x.phase || 1)).size > 1 && (i === 0 || (list[i - 1].phase || 1) !== (p.phase || 1))
              ? <tr key={`ph${p.phase}`} className="phase-row"><td colSpan={6}><strong>Phase {p.phase || 1}</strong></td></tr> : null,
            <tr key={p.id}><td>{p.code}</td><td>{p.description}</td><td>{p.tooth ? `#${p.tooth}` : ''} {p.surfaces || ''}{p.area || ''}</td>
              <td className="num">{money(p.fee)}</td><td className="num">{money(est[p.id]?.insurance || 0)}</td><td className="num">{money(est[p.id]?.patient ?? p.fee)}</td></tr>,
          ])}
          <tr className="totals-row"><td colSpan={3}>Total{t.estimate.total_write_off ? ` (after ${money(t.estimate.total_write_off)} in-network discount)` : ''}</td>
            <td className="num">{money(t.estimate.total_fee)}</td><td className="num">{money(t.estimate.total_insurance)}</td><td className="num">{money(t.estimate.total_patient)}</td></tr>
        </tbody>
      </table>
      {t.estimate.discount > 0 && <p><strong>{t.discount_pct}% discount:</strong> −{money(t.estimate.discount)} · your estimate after discount {money(t.estimate.patient_after_discount)}</p>}
      <p className="muted" style={{ fontSize: 12 }}>Insurance amounts are estimates based on the benefits on file{t.estimate.policy ? ` with ${t.estimate.policy.carrier_name}` : ''} and are not a guarantee of payment. You are responsible for any amount insurance does not pay.</p>
      {t.signed_at ? (
        <div className="doc-sign">
          {t.signature_image && <img src={t.signature_image} alt="Signature" style={{ maxHeight: 70 }} />}
          <div>Accepted and signed by <strong>{t.signature_name}</strong> on {fmtUtcDate(t.signed_at, tz)}</div>
        </div>
      ) : (
        <div className="doc-sign"><div>Patient signature ______________________________ Date __________</div></div>
      )}
    </div>
  );
}

// Printable prescription.
export function PrescriptionPrint() {
  const { id } = useParams();
  const { data: rx } = useApi(`/prescriptions/${id}`);
  const tz = useAuth().practice?.timezone;
  useAutoPrint(!!rx);
  if (!rx) return <div className="empty">Loading…</div>;
  return (
    <div className="print-doc rx">
      <div className="no-print" style={{ marginBottom: 12 }}><Link to={`/patients/${rx.patient_id}`}>← Back</Link> <button onClick={() => window.print()}>Print</button></div>
      <header className="doc-head">
        <div><h1>{rx.provider_name}</h1><div>{rx.practice.name}</div><div>{rx.practice.address}, {rx.practice.city}, {rx.practice.state} {rx.practice.zip}</div><div>{rx.practice.phone}</div></div>
        <div style={{ textAlign: 'right', fontSize: 13 }}>
          {rx.provider_npi && <div>NPI {rx.provider_npi}</div>}
          {rx.license_number && <div>Lic. {rx.license_number}</div>}
          {rx.dea_number && <div>DEA {rx.dea_number}</div>}
        </div>
      </header>
      <div className="rx-patient">
        <div><strong>{rx.patient.first_name} {rx.patient.last_name}</strong> · DOB {rx.patient.dob ? fmtDate(rx.patient.dob) : '—'}</div>
        <div>{[rx.patient.address, rx.patient.city, rx.patient.state, rx.patient.zip].filter(Boolean).join(', ')}</div>
        <div>Date: {fmtUtcDate(rx.created_at, tz)} {rx.patient.allergies ? <> · <strong>Allergies:</strong> {rx.patient.allergies}</> : ''}</div>
      </div>
      <div className="rx-body">
        <div className="rx-symbol">℞</div>
        <div>
          <div style={{ fontSize: 18 }}><strong>{rx.drug}</strong> {rx.strength}</div>
          {rx.schedule && <div><strong>Schedule {rx.schedule} controlled substance</strong></div>}
          <div><strong>Sig:</strong> {rx.sig}</div>
          <div><strong>Disp:</strong> {rx.quantity}</div>
          <div><strong>Refills:</strong> {rx.refills || 'None'}</div>
          {rx.dispense_as_written ? <div><strong>Dispense as written</strong></div> : <div className="muted">Substitution permitted</div>}
          {rx.notes && <div style={{ marginTop: 6 }}>{rx.notes}</div>}
        </div>
      </div>
      {rx.pharmacy && <div className="muted" style={{ fontSize: 13 }}>Pharmacy: {rx.pharmacy.name}{rx.pharmacy.phone ? ` · ${rx.pharmacy.phone}` : ''}</div>}
      {rx.status === 'transmitted'
        ? <div className="doc-sign"><div><strong>COPY — sent electronically to the pharmacy</strong>{rx.erx_reference ? ` (ref ${rx.erx_reference})` : ''}. Not valid for dispensing.</div><div>{rx.provider_name}</div></div>
        : <div className="doc-sign"><div>______________________________</div><div>{rx.provider_name}</div></div>}
    </div>
  );
}

// Printable lab prescription (slip) that goes in the box with the case.
export function LabSlipPrint() {
  const { id } = useParams();
  const { data: d } = useApi(`/lab-cases/${id}/slip`);
  useAutoPrint(!!d);
  if (!d) return <div className="empty">Loading…</div>;
  const c = d.case;
  return (
    <div className="print-doc">
      <div className="no-print" style={{ marginBottom: 12 }}><Link to={`/patients/${d.patient.id}`}>← Back</Link> <button onClick={() => window.print()}>Print</button></div>
      <header className="doc-head">
        <div><h1>{d.practice.name}</h1><div>{[d.practice.address, d.practice.city, d.practice.state, d.practice.zip].filter(Boolean).join(', ')}</div><div>{d.practice.phone}</div></div>
        <div style={{ textAlign: 'right' }}><h2>Lab prescription</h2><div>Case #{c.id}</div></div>
      </header>
      <div className="grid grid-2" style={{ marginBottom: 12 }}>
        <div>
          <strong>To:</strong> {d.lab?.name || c.lab_name}
          {d.lab && <div>{d.lab.address}</div>}
          {d.lab?.phone && <div>{d.lab.phone}{d.lab.email ? ` · ${d.lab.email}` : ''}</div>}
          {d.lab?.account_number && <div>Account {d.lab.account_number}</div>}
        </div>
        <div>
          <strong>Patient:</strong> {d.patient.first_name} {d.patient.last_name}
          {d.patient.dob && <div>DOB {fmtDate(d.patient.dob)}{d.patient.gender ? ` · ${d.patient.gender}` : ''}</div>}
          <div>Sent {fmtDate(c.sent_date)} · <strong>Due back {c.due_date ? fmtDate(c.due_date) : '—'}</strong></div>
          {d.appointment && <div>Seat appointment {fmtDate(d.appointment.start_time.slice(0, 10))}</div>}
        </div>
      </div>
      <table>
        <tbody>
          <tr><th style={{ width: 160 }}>Restoration</th><td>{c.description}</td></tr>
          {d.procedure && <tr><th>Procedure</th><td>{d.procedure.code} {d.procedure.description}</td></tr>}
          <tr><th>Tooth</th><td>{c.tooth ? `#${c.tooth}` : '—'}</td></tr>
          <tr><th>Shade</th><td>{c.shade || '—'}</td></tr>
          <tr><th>Instructions</th><td style={{ whiteSpace: 'pre-wrap', height: 90, verticalAlign: 'top' }}>{c.notes || ''}</td></tr>
        </tbody>
      </table>
      <div className="doc-sign">
        <div>______________________________ Date __________</div>
        <div>{d.provider?.name || 'Prescribing dentist'}{d.provider?.license_number ? ` · Lic. ${d.provider.license_number}` : ''}{d.provider?.npi ? ` · NPI ${d.provider.npi}` : ''}</div>
      </div>
    </div>
  );
}
