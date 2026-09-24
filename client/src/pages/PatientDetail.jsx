import { useEffect, useState } from 'react';
import RecallStatus from '../components/RecallStatus.jsx';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useMakeActive } from '../activePatient.jsx';
import './patient.css';
import { money, fullName, age, fmtDate, fmtDateTime, label, practiceToday } from '../format.js';
import { Modal, Badge, ErrorBox, useSubmit, Menu } from '../components/ui.jsx';
import { Pin, Pill, TriangleAlert, MoreHorizontal, GitMerge, FileArchive, ShieldCheck, CalendarPlus, Pencil, Star } from 'lucide-react';
import { requestReview } from '../reviewRequest.js';
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
import OrthoTab from '../components/patient/OrthoTab.jsx';
import RiskTab from '../components/patient/RiskTab.jsx';
import { LabCaseForm, TaskForm, WaitlistForm, LAB_STATUSES } from '../components/OfficeForms.jsx';
import { api, download } from '../api.js';
import { CustomFieldValues, MergeDialog } from '../components/Switching.jsx';
import { MembershipCard } from '../components/Memberships.jsx';
import RecallPanel from '../components/RecallPanel.jsx';
import AttributionCard from '../components/marketing/AttributionCard.jsx';
import MedicalHistory, { medStale, MEDICAL_CONDITIONS } from '../components/patient/MedicalHistory.jsx';
import ConnectionChips from '../components/cards/Connection.jsx';

export { MEDICAL_CONDITIONS };

export default function PatientDetail() {
  const { id } = useParams();
  const { can, practice, user } = useAuth();
  const navigate = useNavigate();
  const { data: p, error, reload } = useApi(`/patients/${id}`);
  useMakeActive(p);
  // Links can open a tab directly (?tab=ledger, ?tab=insurance…).
  const [params] = useSearchParams();
  const [tab, setTab] = useState(() => params.get('tab') || 'overview');
  useEffect(() => {
    if (params.get('tab')) setTab(params.get('tab'));
  }, [params]);
  const [modal, setModal] = useState(null);
  const [popup, setPopup] = useState(null);

  // The office alert stands out the first time a patient is opened in a session (like Dentrix/Open Dental
  // pop-ups), as a banner rather than a dialog so it never blocks what the user came to do.
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
    ['risk', 'Risk & education', can('clinical:read')],
    ['notes', 'Clinical notes', can('clinical:read')],
    ['rx', 'Rx', can('clinical:read')],
    ['ortho', 'Ortho', can('clinical:read')],
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
                {p.office_alert && <button className="office-chip" onClick={() => setPopup(p.office_alert)}><Pin size={13} /> {p.office_alert}</button>}
                {!!p.premed_required && <span className="alert-chip strong" title="Antibiotic premedication before treatment"><Pill size={13} /> PREMED</span>}
                {p.asa_class && p.asa_class !== 'I' && <span className="alert-chip" title="ASA physical status">ASA {p.asa_class}</span>}
                {p.medical_alerts && <span className="alert-chip"><TriangleAlert size={13} /> {p.medical_alerts}</span>}
                {p.allergies && <span className="alert-chip">Allergy: {p.allergies}</span>}
                {can('clinical:read') && medStale(p) && (
                  <button type="button" className="alert-chip med-due-chip" title="Go over the medical history with the patient"
                    onClick={() => { setTab('overview'); setTimeout(() => document.getElementById('medical-history')?.scrollIntoView({ block: 'center' }), 50); }}>
                    <TriangleAlert size={13} /> {p.medical_reviewed_at ? 'Medical history review due' : 'Medical history never reviewed'}
                  </button>
                )}
                {p.guarantor && <button className="link" style={{ fontSize: 12 }} onClick={() => setTab('family')}>Guarantor: {p.guarantor.first_name} {p.guarantor.last_name}</button>}
                {!p.guarantor && p.family_size > 1 && <button className="link" style={{ fontSize: 12 }} onClick={() => setTab('family')}>Head of household · {p.family_size} in family</button>}
                {/* Preferences (urgent first), "moved by us" strikes and the latest personal note — always here (PP1, PP2, S8). */}
                <ConnectionChips patientId={p.id} />
              </div>
            </div>
          </div>
          <div className="actions">
            <div className={`balance-block${p.balance > 0 ? ' owed' : ''}`}>
              <span>Balance</span>
              <strong>{money(p.balance)}</strong>
            </div>
            {can('patients:write') && <button onClick={() => setModal('edit')}><Pencil size={15} /> Edit</button>}
            {can('patients:write') && <button className="review-ask" title="Text (or email) a “how did we do?” link — Alt+R from any screen" onClick={() => requestReview(p.id, { source: 'chart', name: `${p.first_name} ${p.last_name}` })}><Star size={15} /> Ask for review</button>}
            {can('schedule:write') && <button className="primary" onClick={() => setModal('appt')}><CalendarPlus size={16} /> Book appointment</button>}
            <Menu label={<MoreHorizontal size={18} />} title="More" items={[
              can('clinical:read') && can('billing:read') && { label: 'Export record', icon: <FileArchive size={16} />, title: "The patient's copy of their record (for a records request): summary PDF, all the data and their images and documents, in one ZIP", onClick: () => download(`/patients/${p.id}/record-export`, `health-record-${p.id}.zip`) },
              user?.role === 'admin' && { label: 'Access log', icon: <ShieldCheck size={16} />, title: "Who viewed or changed this patient's record", onClick: () => navigate(`/settings?tab=audit&patient_id=${p.id}`) },
              user?.role === 'admin' && { label: 'Merge a duplicate chart…', icon: <GitMerge size={16} />, title: "Move a duplicate chart's history into this one", onClick: () => setModal('merge') },
            ]} />
          </div>
        </div>
      </div>

      {/* The office alert, the first time this patient is opened today: hard to miss, but it doesn't stop you. */}
      {popup && (
        <div className="office-alert-banner no-print" role="alert">
          <Pin size={16} aria-hidden /> <span>{popup}</span>
          <button type="button" className="link" onClick={() => setPopup(null)} aria-label="Hide the office alert">Got it</button>
        </div>
      )}
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
      {tab === 'risk' && <RiskTab patient={p} />}
      {tab === 'notes' && <NotesTab patient={p} />}
      {tab === 'rx' && <RxTab patient={p} onChange={reload} />}
      {tab === 'ortho' && <OrthoTab patient={p} onChange={reload} />}
      {tab === 'ledger' && <LedgerTab patient={p} onChange={reload} />}
      {tab === 'insurance' && <InsuranceTab patient={p} onChange={reload} />}
      {tab === 'documents' && <DocumentsTab patient={p} />}
      {tab === 'comms' && <CommsTab patient={p} onChange={reload} />}

      {modal === 'edit' && (
        <Modal title="Edit patient" wide onClose={() => setModal(null)}>
          <PatientForm patient={p} onCancel={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />
        </Modal>
      )}
      {modal === 'merge' && <MergeDialog patient={p} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
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
  const { can } = useAuth();
  const { data: tasks, reload: reloadTasks } = useApi(`/tasks?patient_id=${p.id}`);
  const [modal, setModal] = useState(null);
  return (
    <>
    {modal && (
      <Modal title={modal.type === 'lab' ? (modal.item ? 'Lab case' : 'New lab case') : modal.type === 'waitlist' ? `Add ${p.first_name} to the waitlist` : 'New task'} onClose={() => setModal(null)}>
        {modal.type === 'waitlist' ? <WaitlistForm patient={p} onDone={() => setModal(null)} /> : modal.type === 'lab'
          ? <LabCaseForm patient={p} labCase={modal.item} onDone={() => { setModal(null); reload(); }} />
          : <TaskForm patient={p} onDone={() => { setModal(null); reloadTasks(); }} />}
      </Modal>
    )}
    <div className="grid grid-2">
      <div className="card">
        <h2>Contact</h2>
        <dl className="kv">
          <dt>Mobile</dt><dd>{p.phone || '—'}{p.sms_bad_at && <span className="badge warn" style={{ marginLeft: 6 }} title="Reminders go by email until the number is changed">{p.sms_bad_reason || 'Can’t get texts'}</span>}</dd>
          {p.phone_home && (<><dt>Home</dt><dd>{p.phone_home}</dd></>)}
          {p.phone_work && (<><dt>Work</dt><dd>{p.phone_work}</dd></>)}
          <dt>Email</dt><dd>{p.email || '—'}{p.email_bad_at && <span className="badge warn" style={{ marginLeft: 6 }} title="Reminders go by text until the address is changed">Bounced</span>}</dd>
          {(p.preferred_contact || p.language) && (<><dt>Prefers</dt><dd>{[p.preferred_contact && { text: 'Text', call: 'Phone call', email: 'Email' }[p.preferred_contact], p.language].filter(Boolean).join(' · ')}</dd></>)}
          <dt>Address</dt><dd>{[p.address, p.city, p.state, p.zip].filter(Boolean).join(', ') || '—'}</dd>
          <dt>Emergency contact</dt><dd>{p.emergency_contact || '—'}</dd>
          <dt>Referred by</dt><dd>{p.referral_source || '—'}</dd>
          <CustomFieldValues patient={p} />
        </dl>
        {/* Alerts, allergies, medications, conditions, ASA and premed: read, reviewed and changed in one place. */}
        <MedicalHistory p={p} reload={reload} />
      </div>
      <div>
        <div className="card">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Upcoming appointments</h2>
            {can('schedule:write') && <button className="small" onClick={() => setModal({ type: 'waitlist' })}>Add to waitlist</button>}
          </div>
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
        <MembershipCard patient={p} onChange={reload} />
        <AttributionCard patientId={p.id} />
        <div className="card">
          <h2>Recall</h2>
          <RecallPanel patientId={p.id} heading={false} />
          <RecallStatus patientId={p.id} />
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
