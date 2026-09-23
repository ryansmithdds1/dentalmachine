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
  const { data: t } = useApi(`/treatment-plans/${id}`);
  const tz = useAuth().practice?.timezone;
  useAutoPrint(!!t);
  if (!t) return <div className="empty">Loading…</div>;
  const est = Object.fromEntries(t.estimate.items.map((i) => [i.procedure_id, i]));
  return (
    <div className="print-doc">
      <div className="no-print" style={{ marginBottom: 12 }}><Link to={`/patients/${t.patient.id}`}>← Back</Link> <button onClick={() => window.print()}>Print</button></div>
      <header className="doc-head">
        <div><h1>{t.practice.name}</h1><div>{t.practice.address}, {t.practice.city}, {t.practice.state} {t.practice.zip} · {t.practice.phone}</div></div>
        <div style={{ textAlign: 'right' }}><h2>Treatment plan</h2><div>{fmtUtcDate(t.created_at, tz)}</div></div>
      </header>
      <p><strong>{t.patient.first_name} {t.patient.last_name}</strong> · DOB {t.patient.dob ? fmtDate(t.patient.dob) : '—'} · {t.name}</p>
      <table>
        <thead><tr><th>Code</th><th>Procedure</th><th>Tooth</th><th className="num">Fee</th><th className="num">Est. insurance</th><th className="num">Your estimate</th></tr></thead>
        <tbody>
          {t.procedures.filter((p) => p.status === 'planned').map((p) => (
            <tr key={p.id}><td>{p.code}</td><td>{p.description}</td><td>{p.tooth ? `#${p.tooth}` : ''} {p.surfaces || ''}</td>
              <td className="num">{money(p.fee)}</td><td className="num">{money(est[p.id]?.insurance || 0)}</td><td className="num">{money(est[p.id]?.patient ?? p.fee)}</td></tr>
          ))}
          <tr className="totals-row"><td colSpan={3}>Total{t.estimate.total_write_off ? ` (after ${money(t.estimate.total_write_off)} in-network discount)` : ''}</td>
            <td className="num">{money(t.estimate.total_fee)}</td><td className="num">{money(t.estimate.total_insurance)}</td><td className="num">{money(t.estimate.total_patient)}</td></tr>
        </tbody>
      </table>
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
          <div><strong>Sig:</strong> {rx.sig}</div>
          <div><strong>Disp:</strong> {rx.quantity}</div>
          <div><strong>Refills:</strong> {rx.refills || 'None'}</div>
          {rx.dispense_as_written ? <div><strong>Dispense as written</strong></div> : <div className="muted">Substitution permitted</div>}
          {rx.notes && <div style={{ marginTop: 6 }}>{rx.notes}</div>}
        </div>
      </div>
      <div className="doc-sign"><div>______________________________</div><div>{rx.provider_name}</div></div>
    </div>
  );
}
