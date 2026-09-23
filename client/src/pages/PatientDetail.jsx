import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fullName, age, fmtDate, fmtDateTime, label } from '../format.js';
import { Modal, Badge } from '../components/ui.jsx';
import PatientForm from '../components/PatientForm.jsx';
import AppointmentForm from '../components/AppointmentForm.jsx';
import ChartTab from '../components/patient/ChartTab.jsx';
import TreatmentTab from '../components/patient/TreatmentTab.jsx';
import NotesTab from '../components/patient/NotesTab.jsx';
import LedgerTab from '../components/patient/LedgerTab.jsx';
import InsuranceTab from '../components/patient/InsuranceTab.jsx';
import PerioTab from '../components/patient/PerioTab.jsx';
import DocumentsTab from '../components/patient/DocumentsTab.jsx';
import CommsTab from '../components/patient/CommsTab.jsx';

export default function PatientDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: p, error, reload } = useApi(`/patients/${id}`);
  const [tab, setTab] = useState('overview');
  const [modal, setModal] = useState(null);

  if (error) return <div className="error">{error.message}</div>;
  if (!p) return <div className="empty">Loading…</div>;

  const tabs = [
    ['overview', 'Overview', true],
    ['chart', 'Chart', can('clinical:read')],
    ['treatment', 'Treatment plans', can('clinical:read')],
    ['perio', 'Perio', can('clinical:read')],
    ['notes', 'Clinical notes', can('clinical:read')],
    ['documents', 'Documents & x-rays', can('clinical:read')],
    ['ledger', 'Ledger', can('billing:read')],
    ['insurance', 'Insurance', true],
    ['comms', 'Messages & forms', true],
  ].filter((t) => t[2]);

  return (
    <>
      <div className="card">
        <div className="page-header" style={{ marginBottom: 0 }}>
          <div className="patient-banner">
            <div className="avatar">{p.first_name[0]}{p.last_name[0]}</div>
            <div>
              <h1>{fullName(p)} {p.status !== 'active' && <Badge value={p.status} />}</h1>
              <div className="muted">
                #{p.id} · {p.dob ? `${fmtDate(p.dob)} (${age(p.dob)} y)` : 'DOB not recorded'} {p.gender ? `· ${label(p.gender)}` : ''} {p.phone ? `· ${p.phone}` : ''}
              </div>
              <div className="inline" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                {p.medical_alerts && <span className="alert-chip">⚠ {p.medical_alerts}</span>}
                {p.allergies && <span className="alert-chip">Allergy: {p.allergies}</span>}
              </div>
            </div>
          </div>
          <div className="actions">
            <div style={{ textAlign: 'right', marginRight: 8 }}>
              <div className="muted" style={{ fontSize: 12 }}>Balance</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: p.balance > 0 ? 'var(--danger)' : undefined }}>{money(p.balance)}</div>
            </div>
            {can('schedule:write') && <button className="primary" onClick={() => setModal('appt')}>Book appointment</button>}
            {can('patients:write') && <button onClick={() => setModal('edit')}>Edit</button>}
          </div>
        </div>
      </div>

      <div className="tabs" style={{ marginTop: 16 }}>
        {tabs.map(([key, text]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{text}</button>
        ))}
      </div>

      {tab === 'overview' && <Overview p={p} />}
      {tab === 'chart' && <ChartTab patient={p} onChange={reload} />}
      {tab === 'treatment' && <TreatmentTab patient={p} onChange={reload} />}
      {tab === 'perio' && <PerioTab patient={p} />}
      {tab === 'notes' && <NotesTab patient={p} />}
      {tab === 'ledger' && <LedgerTab patient={p} onChange={reload} />}
      {tab === 'insurance' && <InsuranceTab patient={p} onChange={reload} />}
      {tab === 'documents' && <DocumentsTab patient={p} />}
      {tab === 'comms' && <CommsTab patient={p} onChange={reload} />}

      {modal === 'edit' && (
        <Modal title="Edit patient" wide onClose={() => setModal(null)}>
          <PatientForm patient={p} onCancel={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />
        </Modal>
      )}
      {modal === 'appt' && (
        <Modal title="Book appointment" onClose={() => setModal(null)}>
          <AppointmentForm patient={p} defaults={{ date: new Date().toISOString().slice(0, 10) }} onCancel={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />
        </Modal>
      )}
    </>
  );
}

function Overview({ p }) {
  const ins = p.primary_insurance;
  return (
    <div className="grid grid-2">
      <div className="card">
        <h2>Contact</h2>
        <dl className="kv">
          <dt>Phone</dt><dd>{p.phone || '—'}</dd>
          <dt>Email</dt><dd>{p.email || '—'}</dd>
          <dt>Address</dt><dd>{[p.address, p.city, p.state, p.zip].filter(Boolean).join(', ') || '—'}</dd>
          <dt>Emergency contact</dt><dd>{p.emergency_contact || '—'}</dd>
        </dl>
        <h2 style={{ marginTop: 18 }}>Medical history</h2>
        <dl className="kv">
          <dt>Alerts</dt><dd>{p.medical_alerts || 'None'}</dd>
          <dt>Allergies</dt><dd>{p.allergies || 'NKDA'}</dd>
          <dt>Medications</dt><dd>{p.medications || 'None reported'}</dd>
          <dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{p.notes || '—'}</dd>
        </dl>
      </div>
      <div>
        <div className="card">
          <h2>Upcoming appointments</h2>
          {p.upcoming_appointments.length === 0 ? <div className="muted">None scheduled.</div> : (
            <table>
              <tbody>
                {p.upcoming_appointments.map((a) => (
                  <tr key={a.id}>
                    <td>{fmtDateTime(a.start_time)}</td>
                    <td>{a.reason}<div className="muted">{a.provider_name}</div></td>
                    <td><Badge value={a.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h2>Recall</h2>
          {p.recalls.length === 0 ? <div className="muted">No recall set. Completing a prophy creates one automatically.</div> : p.recalls.map((r) => (
            <div key={r.id} className="inline" style={{ justifyContent: 'space-between' }}>
              <span>{label(r.type)} every {r.interval_months} months</span>
              <span>Due {fmtDate(r.due_date)} <Badge value={r.status} /></span>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>Primary insurance</h2>
          {ins ? (
            <dl className="kv">
              <dt>Carrier</dt><dd>{ins.carrier_name}</dd>
              <dt>Subscriber</dt><dd>{ins.subscriber_name} ({ins.subscriber_id})</dd>
              <dt>Coverage</dt><dd>{ins.pct_preventive}/{ins.pct_basic}/{ins.pct_major}</dd>
              <dt>Annual max</dt><dd>{money(ins.annual_max)}</dd>
            </dl>
          ) : <div className="muted">Self-pay. Add a policy on the Insurance tab.</div>}
        </div>
      </div>
    </div>
  );
}
