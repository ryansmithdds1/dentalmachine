import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fullName, age, fmtDate, fmtDateTime, fmtUtcDate, label, practiceToday } from '../format.js';
import { Modal, Badge, ErrorBox, useSubmit } from '../components/ui.jsx';
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
  const { can, practice, user } = useAuth();
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
            <PatientPhoto p={p} canEdit={can('patients:write')} onChange={reload} />
            <div>
              <h1>{fullName(p)} {p.status !== 'active' && <Badge value={p.status} />}</h1>
              <div className="muted">
                #{p.id} · {p.dob ? `${fmtDate(p.dob)} (${age(p.dob)} y)` : 'DOB not recorded'} {p.gender ? `· ${label(p.gender)}` : ''} {p.phone ? `· ${p.phone}` : ''}
              </div>
              <div className="inline" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                {p.office_alert && <button className="office-chip" onClick={() => setPopup(p.office_alert)}>📌 {p.office_alert}</button>}
                {!!p.premed_required && <span className="alert-chip strong" title="Antibiotic premedication before treatment">💊 PREMED</span>}
                {p.asa_class && p.asa_class !== 'I' && <span className="alert-chip" title="ASA physical status">ASA {p.asa_class}</span>}
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
            {user?.role === 'admin' && <Link to={`/settings?tab=audit&patient_id=${p.id}`}><button title="Who viewed or changed this patient's record">Access log</button></Link>}
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
          <AppointmentForm patient={p} defaults={{ date: practiceToday(practice?.timezone) }} onCancel={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />
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
  const [historyReview, setHistoryReview] = useState(false);
  return (
    <>
    {modal && (
      <Modal title={modal.type === 'lab' ? (modal.item ? 'Lab case' : 'New lab case') : 'New task'} onClose={() => setModal(null)}>
        {modal.type === 'lab'
          ? <LabCaseForm patient={p} labCase={modal.item} onDone={() => { setModal(null); reload(); }} />
          : <TaskForm patient={p} onDone={() => { setModal(null); reloadTasks(); }} />}
      </Modal>
    )}
    {historyReview && <HistoryReview patient={p} onDone={() => { setHistoryReview(false); reload(); }} />}
    <div className="grid grid-2">
      <div className="card">
        <h2>Contact</h2>
        <dl className="kv">
          <dt>Mobile</dt><dd>{p.phone || '—'}</dd>
          {p.phone_home && (<><dt>Home</dt><dd>{p.phone_home}</dd></>)}
          {p.phone_work && (<><dt>Work</dt><dd>{p.phone_work}</dd></>)}
          <dt>Email</dt><dd>{p.email || '—'}</dd>
          {(p.preferred_contact || p.language) && (<><dt>Prefers</dt><dd>{[p.preferred_contact && { text: 'Text', call: 'Phone call', email: 'Email' }[p.preferred_contact], p.language].filter(Boolean).join(' · ')}</dd></>)}
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
        {p.history_review_pending && can('clinical:write') && (
          <div className="public-notice" style={{ marginBottom: 10 }}>
            📋 The patient submitted a new medical history. <button className="small primary" onClick={() => setHistoryReview(true)}>Review changes</button>
          </div>
        )}
        <MedicalSummary p={p} reload={reload} />
        <dl className="kv">
          <dt>Alerts</dt><dd>{p.medical_alerts || 'None'}</dd>
          <dt>Allergies</dt><dd>{p.allergies || <span className="muted">Not recorded — ask the patient</span>}</dd>
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
        <VisitHistory visits={p.past_appointments || []} />
        <Referrals patient={p} onChange={reload} />
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
              <span>{l.description} · {l.lab_name} <a href={`/lab-cases/${l.id}/slip`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>slip</a></span>
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

export const MEDICAL_CONDITIONS = [
  'Heart disease', 'Heart murmur', 'Artificial heart valve', 'Prosthetic joint', 'High blood pressure', 'Stroke', 'Diabetes', 'Asthma', 'COPD',
  'Bleeding disorder', 'Anticoagulant therapy', 'Hepatitis', 'HIV', 'Kidney disease', 'Liver disease', 'Seizures', 'Cancer / chemotherapy',
  'Radiation to head or neck', 'Bisphosphonates', 'Osteoporosis', 'Pregnant', 'Thyroid disorder', 'Tobacco use', 'Sleep apnea',
];
const ASA = [['I', 'Healthy'], ['II', 'Mild systemic disease'], ['III', 'Severe systemic disease'], ['IV', 'Severe disease, constant threat to life'], ['V', 'Moribund'], ['VI', 'Brain-dead organ donor']];
const parseList = (v) => { try { return JSON.parse(v || '[]'); } catch { return []; } };

// Conditions checklist, ASA class, premedication and vitals.
function MedicalSummary({ p, reload }) {
  const { can } = useAuth();
  const { data: vitals, reload: reloadVitals } = useApi(`/patients/${p.id}/vitals`);
  const [editing, setEditing] = useState(false);
  const [vForm, setVForm] = useState(null);
  const [warning, setWarning] = useState(null);
  const conditions = parseList(p.medical_conditions);
  const latest = vitals?.[0];
  const { submit, busy, error } = useSubmit(async () => {
    const v = await api.post(`/patients/${p.id}/vitals`, vForm);
    setWarning(v.warning);
    setVForm(null);
    reloadVitals();
  });
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="inline" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {p.asa_class && <span className="badge info" title={ASA.find((a) => a[0] === p.asa_class)?.[1]}>ASA {p.asa_class}</span>}
        {!!p.premed_required && <span className="badge danger">Premedication required</span>}
        {conditions.map((c) => <span key={c} className="badge warn">{c}</span>)}
        {!p.asa_class && !conditions.length && <span className="muted" style={{ fontSize: 13 }}>No conditions checked.</span>}
        {can('clinical:write') && <button className="small" onClick={() => setEditing(true)}>Edit health history</button>}
      </div>
      <div className="inline" style={{ flexWrap: 'wrap', gap: 8, fontSize: 13 }}>
        <strong>Vitals:</strong>
        {latest ? <span>BP {latest.bp_systolic ? `${latest.bp_systolic}/${latest.bp_diastolic}` : '—'} · pulse {latest.pulse || '—'} <span className="muted">({fmtDate(latest.recorded_at.slice(0, 10))})</span></span> : <span className="muted">none recorded</span>}
        {can('clinical:write') && !vForm && <button className="small" onClick={() => setVForm({ bp_systolic: '', bp_diastolic: '', pulse: '' })}>Record vitals</button>}
      </div>
      {warning && <div className="error" style={{ marginTop: 6 }}>{warning}</div>}
      {vForm && (
        <form className="inline" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <ErrorBox error={error} />
          <input type="number" placeholder="Systolic" style={{ width: 90 }} value={vForm.bp_systolic} onChange={(e) => setVForm({ ...vForm, bp_systolic: e.target.value })} aria-label="Systolic" />
          /
          <input type="number" placeholder="Diastolic" style={{ width: 90 }} value={vForm.bp_diastolic} onChange={(e) => setVForm({ ...vForm, bp_diastolic: e.target.value })} aria-label="Diastolic" />
          <input type="number" placeholder="Pulse" style={{ width: 80 }} value={vForm.pulse} onChange={(e) => setVForm({ ...vForm, pulse: e.target.value })} aria-label="Pulse" />
          <button className="small primary" disabled={busy}>Save</button>
          <button type="button" className="small" onClick={() => setVForm(null)}>Cancel</button>
        </form>
      )}
      {vitals?.length > 1 && (
        <details style={{ fontSize: 12, marginTop: 4 }}>
          <summary className="muted">Vitals history</summary>
          {vitals.map((v) => <div key={v.id}>{fmtDate(v.recorded_at.slice(0, 10))}: BP {v.bp_systolic ? `${v.bp_systolic}/${v.bp_diastolic}` : '—'}, pulse {v.pulse || '—'} {v.recorded_by_name ? <span className="muted">· {v.recorded_by_name}</span> : null}</div>)}
        </details>
      )}
      {editing && <HealthHistoryEditor p={p} conditions={conditions} onDone={() => { setEditing(false); reload(); }} />}
    </div>
  );
}

function HealthHistoryEditor({ p, conditions, onDone }) {
  const [checked, setChecked] = useState(conditions);
  const [asa, setAsa] = useState(p.asa_class || '');
  const [premed, setPremed] = useState(!!p.premed_required);
  const { submit, busy, error } = useSubmit(async () => {
    await api.put(`/patients/${p.id}`, { medical_conditions: checked, asa_class: asa || null, premed_required: premed });
    onDone();
  });
  const others = checked.filter((c) => !MEDICAL_CONDITIONS.includes(c));
  return (
    <Modal title="Health history" wide onClose={onDone}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <ErrorBox error={error} />
        <div className="checklist">
          {[...MEDICAL_CONDITIONS, ...others].map((c) => (
            <label key={c} className="checkbox">
              <input type="checkbox" checked={checked.includes(c)} onChange={(e) => setChecked(e.target.checked ? [...checked, c] : checked.filter((x) => x !== c))} /> {c}
            </label>
          ))}
        </div>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <label>
            ASA physical status
            <select value={asa} onChange={(e) => setAsa(e.target.value)}>
              <option value="">Not assessed</option>
              {ASA.map(([v, d]) => <option key={v} value={v}>ASA {v} — {d}</option>)}
            </select>
          </label>
          <label className="checkbox" style={{ alignSelf: 'end' }}><input type="checkbox" checked={premed} onChange={(e) => setPremed(e.target.checked)} /> Antibiotic premedication required</label>
        </div>
        <div className="form-actions"><button className="primary" disabled={busy}>Save</button></div>
      </form>
    </Modal>
  );
}

// Profile photo: tap to take or choose one; it's shrunk to a small JPEG in the browser.
function PatientPhoto({ p, canEdit, onChange }) {
  const [err, setErr] = useState(null);
  const pick = async (file) => {
    setErr(null);
    try {
      const img = await createImageBitmap(file);
      const size = 256;
      const scale = Math.max(size / img.width, size / img.height);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      canvas.getContext('2d').drawImage(img, (size - img.width * scale) / 2, (size - img.height * scale) / 2, img.width * scale, img.height * scale);
      await api.put(`/patients/${p.id}`, { photo: canvas.toDataURL('image/jpeg', 0.85) });
      onChange();
    } catch (e) {
      setErr(e.message || 'Could not use that image');
    }
  };
  const inner = p.photo ? <img src={p.photo} alt="" className="avatar photo" /> : <div className="avatar">{p.first_name[0]}{p.last_name[0]}</div>;
  if (!canEdit) return inner;
  return (
    <label className="avatar-edit" title={p.photo ? 'Change photo' : 'Add a photo'}>
      {inner}
      <input type="file" accept="image/*" capture="user" hidden onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
      {err && <span className="error" style={{ position: 'absolute', fontSize: 11 }}>{err}</span>}
    </label>
  );
}

const REF_STATUS = { open: 'Sent', scheduled: 'Scheduled with them', seen: 'Seen', report_received: 'Report received', closed: 'Closed' };

// Who referred the patient in, and specialists they've been referred out to.
function Referrals({ patient, onChange }) {
  const { can } = useAuth();
  const { data: list, reload } = useApi(`/patients/${patient.id}/referrals`);
  const [adding, setAdding] = useState(null);
  const done = () => { setAdding(null); reload(); onChange?.(); };
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Referrals</h2>
        {can('patients:write') && (
          <span className="inline">
            <button className="small" onClick={() => setAdding('in')}>Referred by…</button>
            <button className="small" onClick={() => setAdding('out')}>Refer out…</button>
          </span>
        )}
      </div>
      {list?.length === 0 && <div className="muted" style={{ marginTop: 6 }}>None.</div>}
      {list?.map((r) => (
        <div key={r.id} className="inline" style={{ justifyContent: 'space-between', marginTop: 8, flexWrap: 'wrap' }}>
          <span>
            {r.direction === 'in' ? 'Referred by ' : 'To '}<strong>{r.contact_name}</strong>{r.specialty ? ` (${r.specialty})` : ''}
            {r.reason ? ` · ${r.reason}` : ''} <span className="muted">· {fmtDate(r.referral_date)}</span>
          </span>
          {r.direction === 'out' && (
            <span className="inline">
              {can('patients:write') ? (
                <select value={r.status} onChange={async (e) => { await api.put(`/referrals/${r.id}`, { status: e.target.value }); reload(); }} style={{ width: 'auto' }}>
                  {Object.entries(REF_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              ) : <Badge value={r.status} />}
              <a href={`/referrals/${r.id}/letter`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>letter</a>
            </span>
          )}
        </div>
      ))}
      {adding && (
        <Modal title={adding === 'in' ? 'Who referred this patient?' : 'Refer to a specialist'} onClose={() => setAdding(null)}>
          <ReferralForm patient={patient} direction={adding} onDone={done} />
        </Modal>
      )}
    </div>
  );
}

function ReferralForm({ patient, direction, onDone }) {
  const { data: contacts, reload } = useApi('/referral-contacts');
  const providers = useLookup('/providers?active=true');
  const [form, setForm] = useState({ contact_id: '', reason: '', teeth: '', urgency: 'routine', provider_id: patient.primary_provider_id || '', notes: '' });
  const [newContact, setNewContact] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    let contactId = form.contact_id;
    if (newContact) contactId = (await api.post('/referral-contacts', newContact)).id;
    const r = await api.post(`/patients/${patient.id}/referrals`, {
      direction, contact_id: Number(contactId), reason: form.reason || null, notes: form.notes || null,
      ...(direction === 'out' ? { teeth: form.teeth || null, urgency: form.urgency, provider_id: form.provider_id ? Number(form.provider_id) : null } : {}),
    });
    if (direction === 'out') window.open(`/referrals/${r.id}/letter`, '_blank');
    reload();
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        {newContact ? (
          <>
            <label>Name<input required value={newContact.name} onChange={(e) => setNewContact({ ...newContact, name: e.target.value })} placeholder="Dr. Jane Smith" /></label>
            <label>Practice<input value={newContact.practice_name} onChange={(e) => setNewContact({ ...newContact, practice_name: e.target.value })} /></label>
            <label>Specialty<input list="specialties" value={newContact.specialty} onChange={(e) => setNewContact({ ...newContact, specialty: e.target.value })} /></label>
            <label>Phone<input value={newContact.phone} onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })} /></label>
            <label>Fax<input value={newContact.fax} onChange={(e) => setNewContact({ ...newContact, fax: e.target.value })} /></label>
            <label>Email<input type="email" value={newContact.email} onChange={(e) => setNewContact({ ...newContact, email: e.target.value })} /></label>
            <datalist id="specialties">{['Endodontics', 'Oral surgery', 'Periodontics', 'Orthodontics', 'Pediatric dentistry', 'Prosthodontics', 'General dentist', 'Physician', 'Patient'].map((x) => <option key={x} value={x} />)}</datalist>
          </>
        ) : (
          <label className="full">
            {direction === 'in' ? 'Referred by' : 'Refer to'}
            <select required value={form.contact_id} onChange={(e) => (e.target.value === 'new' ? setNewContact({ name: '', practice_name: '', specialty: '', phone: '', fax: '', email: '' }) : setForm({ ...form, contact_id: e.target.value }))}>
              <option value="">Choose…</option>
              {contacts?.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}{c.practice_name ? ` — ${c.practice_name}` : ''}{c.specialty ? ` (${c.specialty})` : ''}</option>)}
              <option value="new">+ Someone new…</option>
            </select>
          </label>
        )}
        <label className="full">{direction === 'in' ? 'Note' : 'Reason for referral'}<input value={form.reason} onChange={set('reason')} placeholder={direction === 'out' ? 'e.g. RCT #19, symptomatic irreversible pulpitis' : ''} /></label>
        {direction === 'out' && (
          <>
            <label>Teeth<input value={form.teeth} onChange={set('teeth')} /></label>
            <label>Urgency<select value={form.urgency} onChange={set('urgency')}><option value="routine">Routine</option><option value="soon">Soon</option><option value="urgent">Urgent</option></select></label>
            <label>Referring provider<select value={form.provider_id} onChange={set('provider_id')}><option value="">—</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="full">Notes for the specialist<textarea rows={2} value={form.notes} onChange={set('notes')} /></label>
          </>
        )}
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>{direction === 'out' ? 'Save & print letter' : 'Save'}</button></div>
    </form>
  );
}

const medStale = (p) => !p.medical_reviewed_at || Date.now() - new Date(p.medical_reviewed_at.slice(0, 10)).getTime() > 365 * 86400000;

// A clinician compares the submitted history with the chart and accepts the merged values.
function HistoryReview({ patient, onDone }) {
  const { data } = useApi(`/patients/${patient.id}/history-review`);
  const [form, setForm] = useState(null);
  const fields = [['medical_alerts', 'Medical alerts'], ['allergies', 'Allergies'], ['medications', 'Medications']];
  const values = form || (data && Object.fromEntries(fields.map(([f]) => [f, data.changes[f] ? data.changes[f].proposed || '' : patient[f] || ''])));
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patient-forms/${data.form_id}/review`, values);
    onDone();
  });
  return (
    <Modal title="Review medical history" wide onClose={() => onDone()}>
      {!data ? <div className="empty">Loading…</div> : (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <ErrorBox error={error} />
          <p className="muted">Signed by {data.signature_name} on {fmtDateTime(data.signed_at.replace(' ', 'T') + 'Z')}. Nothing on the chart changes until you save.</p>
          {fields.map(([f, name]) => (
            <div key={f} style={{ marginBottom: 14 }}>
              <strong>{name}</strong>{!data.changes[f] && <span className="muted"> — no change</span>}
              {data.changes[f] && (
                <div className="grid grid-2" style={{ fontSize: 13, margin: '4px 0' }}>
                  <div><span className="muted">On the chart:</span> {data.changes[f].current || '—'}</div>
                  <div><span className="muted">Patient reported:</span> {data.changes[f].reported || '—'}</div>
                </div>
              )}
              <textarea rows={2} value={values[f]} onChange={(e) => setForm({ ...values, [f]: e.target.value })} />
            </div>
          ))}
          {(data.answers.pregnant || data.answers.premedication || data.answers.tobacco) && (
            <p style={{ fontSize: 13 }}>{[data.answers.pregnant && 'Pregnant', data.answers.premedication && 'Needs premedication', data.answers.tobacco && 'Uses tobacco'].filter(Boolean).join(' · ')}</p>
          )}
          <div className="form-actions"><button className="primary" disabled={busy}>Save to chart</button></div>
        </form>
      )}
    </Modal>
  );
}

// Past visits with missed and cancelled ones counted, so the front desk knows how reliable a booking is.
function VisitHistory({ visits }) {
  const [all, setAll] = useState(false);
  if (!visits.length) return null;
  const missed = visits.filter((v) => v.status === 'no_show').length;
  const cancelled = visits.filter((v) => v.status === 'cancelled').length;
  const shown = all ? visits : visits.slice(0, 5);
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Visit history</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          {missed ? <span className="badge danger">{missed} no-show{missed === 1 ? '' : 's'}</span> : null} {cancelled ? <span className="badge warn">{cancelled} cancelled</span> : null}
        </span>
      </div>
      <table style={{ marginTop: 8 }}>
        <tbody>
          {shown.map((a) => (
            <tr key={a.id} style={{ opacity: ['cancelled', 'no_show'].includes(a.status) ? 0.75 : 1 }}>
              <td>{fmtDateTime(a.start_time)}</td>
              <td>{a.reason || '—'}<div className="muted">{a.provider_name}</div></td>
              <td><Badge value={a.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {visits.length > 5 && <button className="link" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${visits.length}`}</button>}
    </div>
  );
}
