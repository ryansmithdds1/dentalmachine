import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fullName, age, fmtDate, fmtDateTime, fmtUtcDate, label } from '../format.js';
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
import FamilyTab from '../components/patient/FamilyTab.jsx';
import RxTab from '../components/patient/RxTab.jsx';
import { LabCaseForm, TaskForm, LAB_STATUSES } from '../components/OfficeForms.jsx';
import { api } from '../api.js';

export default function PatientDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: p, error, reload } = useApi(`/patients/${id}`);
  const [tab, setTab] = useState('overview');
  const [modal, setModal] = useState(null);
  const [popup, setPopup] = useState(null);

  // Pop-up office alert, shown once per session per patient (like Dentrix/Open Dental pop-ups).
  useEffect(() => {
    if (!p?.office_alert) return;
    const key = `dm_alert_seen_${p.id}`;
    try {
      if (sessionStorage.getItem(key) === p.office_alert) return;
      sessionStorage.setItem(key, p.office_alert);
    } catch {
      /* storage unavailable */
    }
    setPopup(p.office_alert);
  }, [p?.id, p?.office_alert]);

  if (error) return <div className="error">{error.message}</div>;
  if (!p) return <div className="empty">Loading…</div>;

  const tabs = [
    ['overview', 'Overview', true],
    ['family', `Family${p.family_size > 1 ? ` (${p.family_size})` : ''}`, true],
    ['chart', 'Chart', can('clinical:read')],
    ['treatment', 'Treatment plans', can('clinical:read')],
    ['perio', 'Perio', can('clinical:read')],
    ['notes', 'Clinical notes', can('clinical:read')],
    ['rx', 'Rx', can('clinical:read')],
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
                {p.office_alert && <button className="office-chip" onClick={() => setPopup(p.office_alert)}>📌 {p.office_alert}</button>}
                {p.medical_alerts && <span className="alert-chip">⚠ {p.medical_alerts}</span>}
                {p.allergies && <span className="alert-chip">Allergy: {p.allergies}</span>}
                {p.guarantor && <button className="link" style={{ fontSize: 12 }} onClick={() => setTab('family')}>Guarantor: {p.guarantor.first_name} {p.guarantor.last_name}</button>}
                {!p.guarantor && p.family_size > 1 && <button className="link" style={{ fontSize: 12 }} onClick={() => setTab('family')}>Head of household · {p.family_size} in family</button>}
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

      {tab === 'overview' && <Overview p={p} reload={reload} />}
      {tab === 'family' && <FamilyTab patient={p} onChange={reload} />}
      {tab === 'chart' && <ChartTab patient={p} onChange={reload} />}
      {tab === 'treatment' && <TreatmentTab patient={p} onChange={reload} />}
      {tab === 'perio' && <PerioTab patient={p} />}
      {tab === 'notes' && <NotesTab patient={p} />}
      {tab === 'rx' && <RxTab patient={p} onChange={reload} />}
      {tab === 'ledger' && <LedgerTab patient={p} onChange={reload} />}
      {tab === 'insurance' && <InsuranceTab patient={p} onChange={reload} />}
      {tab === 'documents' && <DocumentsTab patient={p} />}
      {tab === 'comms' && <CommsTab patient={p} onChange={reload} />}

      {popup && (
        <Modal title="Office alert" onClose={() => setPopup(null)}>
          <div className="office-popup">📌 {popup}</div>
          <div className="form-actions"><button className="primary" autoFocus onClick={() => setPopup(null)}>Got it</button></div>
        </Modal>
      )}
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

function Overview({ p, reload }) {
  const ins = p.primary_insurance;
  const { can, practice } = useAuth();
  const { data: tasks, reload: reloadTasks } = useApi(`/tasks?patient_id=${p.id}`);
  const [modal, setModal] = useState(null);
  return (
    <>
    {modal && (
      <Modal title={modal.type === 'lab' ? (modal.item ? 'Lab case' : 'New lab case') : 'New task'} onClose={() => setModal(null)}>
        {modal.type === 'lab'
          ? <LabCaseForm patient={p} labCase={modal.item} onDone={() => { setModal(null); reload(); }} />
          : <TaskForm patient={p} onDone={() => { setModal(null); reloadTasks(); }} />}
      </Modal>
    )}
    <div className="grid grid-2">
      <div className="card">
        <h2>Contact</h2>
        <dl className="kv">
          <dt>Phone</dt><dd>{p.phone || '—'}</dd>
          <dt>Email</dt><dd>{p.email || '—'}</dd>
          <dt>Address</dt><dd>{[p.address, p.city, p.state, p.zip].filter(Boolean).join(', ') || '—'}</dd>
          <dt>Emergency contact</dt><dd>{p.emergency_contact || '—'}</dd>
          <dt>Referred by</dt><dd>{p.referral_source || '—'}</dd>
        </dl>
        <div className="inline" style={{ marginTop: 18, justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Medical history</h2>
          {can('clinical:write') && <button className="small" onClick={() => api.post(`/patients/${p.id}/medical-reviewed`).then(reload)}>✓ Reviewed today</button>}
        </div>
        <div className={`muted`} style={{ fontSize: 12, margin: '4px 0 8px', color: medStale(p) ? 'var(--warn)' : undefined }}>
          {p.medical_reviewed_at ? `Last reviewed ${fmtUtcDate(p.medical_reviewed_at, practice?.timezone)}` : 'Never reviewed'}{medStale(p) ? ' — update due' : ''}
        </div>
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
        <div className="card">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Lab cases</h2>
            {can('clinical:write') && <button className="small" onClick={() => setModal({ type: 'lab' })}>+ Lab case</button>}
          </div>
          {p.open_lab_cases.length === 0 && <div className="muted" style={{ marginTop: 6 }}>No open lab cases.</div>}
          {p.open_lab_cases.map((l) => (
            <div key={l.id} className="inline" style={{ justifyContent: 'space-between', marginTop: 8 }}>
              <span>{l.description} · {l.lab_name}</span>
              <span className="inline">
                <span className={`badge ${l.status === 'received' ? 'ok' : 'warn'}`}>{LAB_STATUSES.find((s) => s[0] === l.status)?.[1]}</span>
                {l.due_date && <span className="muted">due {fmtDate(l.due_date)}</span>}
                {can('clinical:write') && l.status !== 'received' && <button className="small" onClick={async () => { await api.put(`/lab-cases/${l.id}`, { status: 'received' }); reload(); }}>Received</button>}
              </span>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Tasks</h2>
            <button className="small" onClick={() => setModal({ type: 'task' })}>+ Task</button>
          </div>
          {tasks?.length === 0 && <div className="muted" style={{ marginTop: 6 }}>Nothing to do.</div>}
          {tasks?.map((t) => (
            <label key={t.id} className="checkbox" style={{ color: 'var(--text)', marginTop: 8 }}>
              <input type="checkbox" onChange={async () => { await api.put(`/tasks/${t.id}`, { status: 'done' }); reloadTasks(); }} />
              {t.priority === 'high' && <span className="badge danger">High</span>} {t.title}
              {t.due_date && <span className="muted"> · due {fmtDate(t.due_date)}</span>}
              {t.assigned_to_name && <span className="muted"> · {t.assigned_to_name}</span>}
            </label>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}><Link to="/office">All lab cases & tasks →</Link></div>
      </div>
    </div>
    </>
  );
}

const medStale = (p) => !p.medical_reviewed_at || Date.now() - new Date(p.medical_reviewed_at.slice(0, 10)).getTime() > 365 * 86400000;
