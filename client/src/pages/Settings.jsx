import { useState } from 'react';
import ConnectionActivity from '../components/ConnectionActivity.jsx';
import PhoneLineSettings from '../components/PhoneLineSettings.jsx';
import EducationSettings from '../components/EducationSettings.jsx';
import CheckinSettings from '../components/CheckinSettings.jsx';
import BookingSettings from '../components/BookingSettings.jsx';
import { CardReaderSettings } from '../components/CardReader.jsx';
import { Link, useSearchParams } from 'react-router-dom';
import { api, getToken, download } from '../api.js';
import { useApi, useLookup, invalidateLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDate, fmtDateTime, fmtUtcDateTime, label, toCents, fromCents } from '../format.js';
import { ErrorBox, Modal, useSubmit } from '../components/ui.jsx';
import { CustomFieldsSettings, DuplicateCharts } from '../components/Switching.jsx';
import ImportData from '../components/ImportData.jsx';
import Backups from '../components/Backups.jsx';
import Developer from '../components/Developer.jsx';
import FormTemplates from '../components/FormTemplates.jsx';
import { MembershipPlans } from '../components/Memberships.jsx';
import MfaSetup from '../components/MfaSetup.jsx';
import SensorTest from '../components/imaging/SensorTest.jsx';

const ROLES = ['admin', 'dentist', 'hygienist', 'assistant', 'front_desk', 'billing'];
const CATEGORIES = ['diagnostic', 'preventive', 'restorative', 'endodontics', 'periodontics', 'prosthodontics', 'oral_surgery', 'orthodontics', 'implants', 'adjunctive'];

// Field specs: [name, label, type, options]
const RESOURCES = {
  providers: {
    title: 'Providers', singular: 'provider', path: '/providers', columns: ['name', 'type', 'npi', 'color', 'working_hours'],
    fields: [['name', 'Name', 'text'], ['type', 'Type', 'select', ['dentist', 'hygienist', 'specialist']], ['npi', 'NPI (10 digits)', 'text'], ['license_number', 'License #', 'text'], ['dea_number', 'DEA # (controlled substances)', 'text'], ['erx_user_id', 'e-Rx user ID (DoseSpot)', 'text'], ['color', 'Schedule color', 'color'], ['fee_schedule_id', 'Own fees (office fee schedule)', 'feeschedule'], ['video_room_url', 'Video room link (Doxy.me, Zoom…; blank = a new private room each visit)', 'text'], ['daily_goal', 'Daily production goal ($, blank = none)', 'money'], ['active', 'Active', 'checkbox'], ['working_hours', 'Working hours', 'hours']],
  },
  locations: {
    title: 'Offices', singular: 'office', path: '/locations', columns: ['name', 'city', 'phone', 'office_hours'],
    intro: 'For practices with more than one office. Each chair belongs to an office; visits, production and front-desk payments are counted at their office, and staff can switch offices in the sidebar. Adding the first office puts your existing chairs and history there.',
    fields: [['name', 'Name', 'text'], ['phone', 'Phone', 'text'], ['address', 'Address', 'text'], ['city', 'City', 'text'], ['state', 'State', 'text'], ['zip', 'ZIP', 'text'], ['npi', 'Office NPI (if billed separately)', 'text'], ['fee_schedule_id', 'Fees (office fee schedule)', 'feeschedule'], ['sort', 'Display order', 'number'], ['active', 'Active', 'checkbox'],
      ['office_hours', 'Opening hours', 'hours', { note: 'Outside these hours the office is shaded on the calendar and online booking won’t offer times there.', same: 'Same as the practice’s office hours', alt: false }]],
  },
  operatories: { title: 'Operatories', singular: 'operatory', path: '/operatories', columns: ['name', 'location_id', 'sort', 'is_hygiene'], fields: [['name', 'Name', 'text'], ['location_id', 'Office', 'location'], ['sort', 'Display order', 'number'], ['default_provider_id', 'Usually works here', 'provider'], ['is_hygiene', 'Hygiene chair', 'checkbox'], ['active', 'Active', 'checkbox']] },
  codes: {
    title: 'Fee schedule', singular: 'procedure code', path: '/procedure-codes', columns: ['code', 'description', 'category', 'fee'],
    fields: [['code', 'Code', 'text'], ['description', 'Description', 'text'], ['category', 'Category', 'select', CATEGORIES], ['fee', 'Fee ($)', 'money'], ['area', 'Charted by (blank = automatic)', 'select', ['tooth', 'quadrant', 'arch', 'mouth']], ['time_units', 'Time units (10 min each)', 'number'], ['requires_tooth', 'Requires tooth', 'checkbox'], ['requires_surface', 'Requires surfaces', 'checkbox'], ['active', 'Active', 'checkbox']],
  },
  types: {
    title: 'Appointment types', singular: 'appointment type', path: '/appointment-types', columns: ['name', 'duration', 'color', 'procedure_codes', 'online_bookable'],
    fields: [['name', 'Name', 'text'], ['name_es', 'Name in Spanish (online booking)', 'text'], ['duration', 'Length (minutes)', 'number'], ['color', 'Calendar color', 'color'], ['procedure_codes', 'Procedures added when booked (e.g. D0120, D1110)', 'codes'],
      ['provider_type', 'Usually booked with', 'select', ['dentist', 'hygienist', 'specialist']], ['online_bookable', 'Patients can book online', 'checkbox'], ['is_video', 'Always a video visit', 'checkbox'], ['deposit', 'Deposit to book online ($, needs Stripe)', 'money'], ['sort', 'Sort order', 'number'], ['active', 'Active', 'checkbox'],
      ['pattern', 'Time pattern', 'pattern'], ['provider_durations', 'Length for each provider (blank = the usual length)', 'durations']],
  },
  referrals: {
    title: 'Referral contacts', singular: 'referral contact', path: '/referral-contacts', columns: ['name', 'practice_name', 'specialty', 'phone', 'referred_in', 'referred_out'], writePerm: 'patients:write',
    fields: [['name', 'Name', 'text'], ['practice_name', 'Practice', 'text'], ['specialty', 'Specialty', 'text'], ['phone', 'Phone', 'text'], ['fax', 'Fax', 'text'], ['email', 'Email', 'email'], ['address', 'Address', 'text'], ['npi', 'NPI', 'text'], ['notes', 'Notes', 'text'], ['active', 'Active', 'checkbox']],
  },
  carriers: {
    title: 'Insurance carriers', singular: 'insurance carrier', path: '/carriers', columns: ['name', 'payer_id', 'phone'], writePerm: 'billing:write',
    fields: [['name', 'Name', 'text'], ['payer_id', 'Payer ID', 'text'], ['phone', 'Phone', 'text'], ['address', 'Claims address', 'text'], ['timely_filing_days', 'Filing limit (days, blank = 365)', 'number'], ['active', 'Active', 'checkbox']],
  },
};

// What each section contains, so the search box finds "lock date" or "two-factor" as well as section names.
// Fields of the simple list sections (providers, carriers…) are added from their definitions.
const KEYWORDS = {
  account: 'password two-factor 2fa authenticator mfa my account sign in',
  practice: 'practice name phone email address city state zip group npi tax id tin timezone time zone office hours opening hours booking page address slug online booking instant booking reminders portal production goal hygiene goal texting number twilio sms two-factor mfa require sign-out idle timeout inactivity write-off approval limit adjustment lock date books closed month-end close export data single sign-on sso oidc google microsoft financing carecredit sunbit cherry payment plans lender interest receipts automatic receipt',
  users: 'users staff login roles permissions invite access front desk hygienist dentist billing admin',
  locations: 'offices locations multi-location branches',
  providers: 'time off vacation special hours schedule exceptions',
  types: 'appointment types reasons duration online booking deposit video',
  import: 'import open dental dentrix eaglesoft csv convert switch migrate',
  templates: 'clinical note templates auto notes prompts merge fields',
  forms: 'forms consents intake medical history health history signature',
  labs: 'dental labs turnaround lab slip',
  referrals: 'referral contacts specialists referring doctors',
  codes: 'fee schedule procedure codes cdt fees ucr import codes',
  ppo: 'fee schedules ppo contracted fees insurance fees office fees fee history',
  carriers: 'insurance carriers payers payer id',
  memberships: 'membership plans in-house plans subscription',
  messaging: 'messages reminders recall reviews google yelp templates spanish text email review link threshold',
  custom: 'custom patient fields extra fields',
  duplicates: 'duplicate charts merge patients',
  integrations: 'integrations stripe payments card reader terminal tap chip twilio texting email smtp clearinghouse edi eligibility e-prescribing erx dosespot mail lob postgrid attachments',
  imaging: 'imaging bridges dexis sidexis sensor capture twain x-ray workstation',
  developer: 'api keys webhooks developer integrations',
  audit: 'audit log access log who viewed hipaa',
  backups: 'backups restore download',
};

export default function Settings() {
  const { user, can } = useAuth();
  const admin = user.role === 'admin';
  const groups = [
    ['You', [['account', 'My account', true]]],
    ['Practice', [['practice', 'Practice & security', admin], ['users', 'Users & roles', admin], ['locations', 'Offices', admin], ['providers', 'Providers', true], ['operatories', 'Operatories', true], ['types', 'Appointment types', true], ['import', 'Import from another system', admin]]],
    ['Clinical', [['templates', 'Note templates', can('clinical:write')], ['forms', 'Forms & consents', can('patients:read')], ['labs', 'Labs', can('clinical:read')], ['education', 'Patient education', can('patients:read')], ['referrals', 'Referral contacts', can('patients:read')]]],
    ['Billing', [['codes', 'Fee schedule', true], ['ppo', 'Fee schedules', can('billing:read')], ['carriers', 'Insurance carriers', can('billing:read')], ['memberships', 'Membership plans', can('billing:read')]]],
    ['Patients', [['messaging', 'Messages & reviews', admin], ['phone', 'Phone line', admin], ['checkin', 'Mobile check-in', admin], ['booking', 'Online booking links', admin], ['custom', 'Custom patient fields', admin], ['duplicates', 'Duplicate charts', admin]]],
    ['Connections', [['integrations', 'Integrations', admin], ['imaging', 'Imaging bridges', admin], ['assistant', 'Assistant', admin], ['developer', 'API & webhooks', admin], ['activity', 'Connection activity', admin]]],
    ['Compliance', [['audit', 'Audit log', admin], ['backups', 'Backups', admin]]],
  ].map(([g, items]) => [g, items.filter((t) => t[2])]).filter(([, items]) => items.length);
  const all = groups.flatMap(([, items]) => items);
  const [params, setParams] = useSearchParams();
  const tab = all.some((t) => t[0] === params.get('tab')) ? params.get('tab') : admin ? 'practice' : 'account';
  const setTab = (k) => setParams({ tab: k }, { replace: true });
  const [q, setQ] = useState('');
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = (k, t) => `${t} ${KEYWORDS[k] || ''} ${RESOURCES[k] ? `${RESOURCES[k].title} ${RESOURCES[k].fields.map((f) => f[1]).join(' ')}` : ''}`.toLowerCase();
  const matches = (k, t) => words.every((w) => haystack(k, t).includes(w));
  // After choosing a result, bring the matching field or heading into view.
  const reveal = (k) => {
    setTab(k);
    if (!words.length) return;
    setTimeout(() => {
      const el = [...document.querySelectorAll('.settings-body label, .settings-body h2, .settings-body h3')].find((x) => words.some((w) => x.textContent.toLowerCase().includes(w)));
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1800);
    }, 350);
  };
  const shownGroups = words.length ? groups.map(([g, items]) => [g, items.filter(([k, t]) => matches(k, t))]).filter(([, items]) => items.length) : groups;

  return (
    <>
      <div className="page-header"><h1>Settings</h1></div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <input className="settings-search" type="search" placeholder="Search settings…" aria-label="Search settings" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && shownGroups[0]) { reveal(shownGroups[0][1][0][0]); } if (e.key === 'Escape') setQ(''); }} />
          {words.length > 0 && !shownGroups.length && <div className="muted" style={{ fontSize: 13, padding: '6px 8px' }}>Nothing matches “{q}”.</div>}
          {shownGroups.map(([g, items]) => (
            <div key={g} className="settings-group">
              <div className="settings-group-title">{g}</div>
              {items.map(([k, t]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => reveal(k)}>{t}</button>)}
            </div>
          ))}
        </nav>
        <select className="settings-select" value={tab} onChange={(e) => setTab(e.target.value)} aria-label="Settings section">
          {groups.map(([g, items]) => <optgroup key={g} label={g}>{items.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</optgroup>)}
        </select>
        <div className="settings-body">
      {tab === 'account' && <Account />}
      {tab === 'practice' && <Practice />}
      {tab === 'users' && <Users />}
      {RESOURCES[tab] && <ResourceTable key={tab} spec={RESOURCES[tab]} canWrite={RESOURCES[tab].writePerm ? can(RESOURCES[tab].writePerm) : admin} />}
      {tab === 'providers' && <TimeOff canWrite={can('schedule:write')} />}
      {tab === 'codes' && admin && <CodeImport />}
      {tab === 'templates' && <NoteTemplates />}
      {tab === 'forms' && <FormTemplates />}
      {tab === 'memberships' && <MembershipPlans />}
      {tab === 'labs' && <Labs canWrite={can('clinical:write')} />}
      {tab === 'ppo' && <FeeSchedules admin={admin} />}
      {tab === 'messaging' && <Messaging />}
      {tab === 'phone' && <PhoneLineSettings />}
      {tab === 'education' && <EducationSettings />}
      {tab === 'checkin' && <CheckinSettings />}
      {tab === 'booking' && <BookingSettings />}
      {tab === 'custom' && <CustomFieldsSettings />}
      {tab === 'import' && admin && <ImportData />}
      {tab === 'backups' && admin && <Backups />}
      {tab === 'developer' && admin && <Developer />}
      {tab === 'duplicates' && <DuplicateCharts />}
      {tab === 'imaging' && <ImagingBridges />}
      {tab === 'assistant' && <AssistantLog />}
      {tab === 'integrations' && <Integrations />}
      {tab === 'audit' && <AuditLog />}
      {tab === 'activity' && <ConnectionActivity />}
        </div>
      </div>
    </>
  );
}

// Bring in a fee schedule or code list (e.g. exported from the old system or from the ADA's CDT file).
function CodeImport() {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState(null);
  const { submit, busy, error } = useSubmit(async () => {
    setResult(await api.post('/procedure-codes/import', { csv }));
    invalidateLookup('/procedure-codes?active=true');
    setCsv('');
  });
  return (
    <div className="card">
      <h2>Import codes & fees</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        CSV with columns <code>code, description, category, fee, area, time_units</code> (a header row is fine). Existing codes are updated; blank cells are left alone.
        Area is tooth, quadrant, arch or mouth; each time unit is 10 minutes.
      </p>
      <ErrorBox error={error} />
      <input type="file" aria-label="CSV file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
      <textarea rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'D2740,Crown - porcelain/ceramic,restorative,1350.00,tooth,6'} style={{ marginTop: 8 }} />
      <div className="form-actions"><button className="primary" disabled={busy || !csv.trim()} onClick={submit}>Import</button></div>
      {result && (
        <div className={result.errors.length ? 'public-notice' : 'public-notice ok'}>
          {result.created} added, {result.updated} updated.{result.errors.length ? ` ${result.errors.length} rows skipped:` : ''}
          {result.errors.length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{result.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}

function NoteTemplates() {
  const { data: list, reload } = useApi('/note-templates');
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState(null);
  const done = () => { setEditing(null); reload(); invalidateLookup('/note-templates'); };
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="inline" style={{ padding: '14px 16px', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0 }}>Clinical note templates</h2>
          <div className="muted" style={{ fontSize: 13 }}>Offered when the listed procedures are completed. <code>{'{patient}'}</code> <code>{'{procedures}'}</code> <code>{'{teeth}'}</code> <code>{'{bp}'}</code> <code>{'{allergies}'}</code> fill in; <code>[[Anesthetic: Lidocaine|Articaine]]</code> asks the writer to pick.</div>
        </div>
        <button className="primary" onClick={() => setEditing({ name: '', codes: '', body: '', active: 1 })}>+ Template</button>
      </div>
      <ErrorBox error={err} />
      <table>
        <thead><tr><th>Name</th><th>Codes</th><th>Questions</th><th /></tr></thead>
        <tbody>
          {list?.map((t) => (
            <tr key={t.id} style={{ opacity: t.active ? 1 : 0.5 }}>
              <td>{t.name}</td><td>{t.codes || <span className="muted">any (pick manually)</span>}</td><td>{t.prompts.map((p) => p.label).join(', ') || '—'}</td>
              <td className="row-actions">
                <button className="small" onClick={() => setEditing(t)}>Edit</button>
                <button className="small danger" onClick={async () => { if (!window.confirm(`Delete “${t.name}”?`)) return; try { await api.del(`/note-templates/${t.id}`); done(); } catch (e) { setErr(e); } }}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <Modal title={editing.id ? 'Edit template' : 'New template'} wide onClose={() => setEditing(null)}>
          <TemplateForm tpl={editing} onDone={done} />
        </Modal>
      )}
    </div>
  );
}

function TemplateForm({ tpl, onDone }) {
  const [form, setForm] = useState({ name: tpl.name, codes: tpl.codes || '', body: tpl.body, active: !!tpl.active });
  const { submit, busy, error } = useSubmit(async () => {
    if (tpl.id) await api.put(`/note-templates/${tpl.id}`, form);
    else await api.post('/note-templates', form);
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>For codes (prefixes OK, e.g. D23 D27)<input value={form.codes} onChange={(e) => setForm({ ...form, codes: e.target.value })} /></label>
        <label className="full">Template<textarea required rows={10} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></label>
        <label className="checkbox"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Save</button></div>
    </form>
  );
}

function Labs({ canWrite }) {
  const { data: labs, reload } = useApi('/labs');
  const [editing, setEditing] = useState(null);
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="inline" style={{ padding: '14px 16px', justifyContent: 'space-between' }}>
        <div><h2 style={{ margin: 0 }}>Dental labs</h2><div className="muted" style={{ fontSize: 13 }}>Pick a lab on a case and its due date follows the usual turnaround; the slip prints with its details.</div></div>
        {canWrite && <button className="primary" onClick={() => setEditing({ active: 1 })}>+ Lab</button>}
      </div>
      <table>
        <thead><tr><th>Lab</th><th>Phone</th><th>Email</th><th>Turnaround</th><th>Open cases</th><th /></tr></thead>
        <tbody>
          {labs?.map((l) => (
            <tr key={l.id} style={{ opacity: l.active ? 1 : 0.5 }}>
              <td>{l.name}{l.account_number ? <div className="muted">Acct {l.account_number}</div> : null}</td><td>{l.phone || '—'}</td><td>{l.email || '—'}</td>
              <td>{l.turnaround_days ? `${l.turnaround_days} days` : '—'}</td><td>{l.open_cases}</td>
              <td>{canWrite && <button className="small" onClick={() => setEditing(l)}>Edit</button>}</td>
            </tr>
          ))}
          {labs?.length === 0 && <tr><td colSpan={6} className="muted">No labs yet.</td></tr>}
        </tbody>
      </table>
      {editing && (
        <Modal title={editing.id ? editing.name : 'New lab'} onClose={() => setEditing(null)}>
          <LabForm lab={editing} onDone={() => { setEditing(null); reload(); invalidateLookup('/labs'); }} />
        </Modal>
      )}
    </div>
  );
}

function LabForm({ lab, onDone }) {
  const [form, setForm] = useState({ name: lab.name || '', phone: lab.phone || '', email: lab.email || '', address: lab.address || '', turnaround_days: lab.turnaround_days ?? '', account_number: lab.account_number || '', active: !!lab.active });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    if (lab.id) await api.put(`/labs/${lab.id}`, form);
    else await api.post('/labs', form);
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Name<input required value={form.name} onChange={set('name')} /></label>
        <label>Phone<input value={form.phone} onChange={set('phone')} /></label>
        <label>Email<input type="email" value={form.email} onChange={set('email')} /></label>
        <label>Usual turnaround (days)<input type="number" min="0" value={form.turnaround_days} onChange={set('turnaround_days')} /></label>
        <label className="full">Address<input value={form.address} onChange={set('address')} /></label>
        <label>Account #<input value={form.account_number} onChange={set('account_number')} /></label>
        <label className="checkbox"><input type="checkbox" checked={form.active} onChange={set('active')} /> Active</label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Save</button></div>
    </form>
  );
}

function Account() {
  const { user, logout } = useAuth();
  return (
    <>
      <div className="card inline" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div><strong>{user.name}</strong><div className="muted">{user.email} · {label(user.role)}</div></div>
        <button onClick={logout}>Sign out</button>
      </div>
      <div className="grid grid-2">
        <PasswordCard />
        <TwoFactorCard />
      </div>
    </>
  );
}

function TwoFactorCard() {
  const { user, refresh, adoptSession } = useAuth();
  const [mode, setMode] = useState(null);
  const [password, setPassword] = useState('');
  const disable = useSubmit(async () => {
    const res = await api.post('/auth/mfa/disable', { password });
    setMode(null);
    setPassword('');
    await adoptSession(res.token);
  });
  return (
    <div className="card">
      <h2>Two-factor authentication</h2>
      {user.mfa_enabled ? (
        <>
          <p><span className="badge ok">On</span> Sign-ins require a code from your authenticator app.</p>
          {mode === 'disable' ? (
            <form onSubmit={(e) => { e.preventDefault(); disable.submit(); }}>
              <ErrorBox error={disable.error} />
              <label>Confirm your password<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
              <div className="form-actions"><button type="button" onClick={() => setMode(null)}>Cancel</button><button className="danger" disabled={disable.busy}>Turn off</button></div>
            </form>
          ) : <button className="danger" onClick={() => setMode('disable')}>Turn off</button>}
        </>
      ) : mode === 'setup' ? (
        <MfaSetup onDone={() => { setMode(null); refresh(); }} />
      ) : (
        <>
          <p className="muted">Protect patient data with a second step at sign-in. Strongly recommended for everyone with chart access.</p>
          <button className="primary" onClick={() => setMode('setup')}>Set up authenticator app</button>
        </>
      )}
    </div>
  );
}

function PasswordCard() {
  const { adoptSession } = useAuth();
  const [form, setForm] = useState({ current_password: '', new_password: '' });
  const [ok, setOk] = useState(null);
  const { submit, busy, error } = useSubmit(async () => {
    const res = await api.post('/auth/change-password', form);
    setForm({ current_password: '', new_password: '' });
    await adoptSession(res.token);
    setOk('Password updated — you were signed out on your other devices');
  });
  const signOutOthers = useSubmit(async () => {
    const res = await api.post('/auth/logout-all');
    await adoptSession(res.token);
    setOk('Signed out on every other device');
  });
  return (
    <div className="card">
      <h2>Change password</h2>
      <ErrorBox error={error} />
      <ErrorBox error={signOutOthers.error} />
      {ok && <div className="badge ok" style={{ marginBottom: 10 }}>{ok}</div>}
      <form onSubmit={(e) => { e.preventDefault(); setOk(null); submit(); }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label>Current password<input type="password" required value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} /></label>
        <label>New password (min 10 characters)<input type="password" required minLength={10} value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} /></label>
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <button className="primary" disabled={busy}>Update password</button>
          <button type="button" disabled={signOutOthers.busy} onClick={() => { setOk(null); signOutOthers.submit(); }} title="Lost a phone or signed in on a shared computer?">Sign out other devices</button>
        </div>
      </form>
    </div>
  );
}

function Practice() {
  const { refresh } = useAuth();
  const { data } = useApi('/practice');
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const current = form || data;
  const { submit, busy, error } = useSubmit(async () => {
    await api.put('/practice', current);
    setSaved(true);
    refresh();
  });
  if (!current) return null;
  const change = (k, v) => { setSaved(false); setForm({ ...current, [k]: v }); };
  const f = (k, t) => <label>{t}<input value={current[k] ?? ''} onChange={(e) => change(k, e.target.value)} /></label>;
  const bookingUrl = current.slug ? `${window.location.origin}/book/${current.slug}` : null;
  return (
    <>
      <div className="card">
        <h2>Practice details</h2>
        <div className="form-grid">
          {f('name', 'Practice name')}{f('phone', 'Phone')}{f('email', 'Email')}
          {f('address', 'Address')}{f('city', 'City')}{f('state', 'State')}{f('zip', 'ZIP')}
          {f('npi', 'Group NPI')}{f('tax_id', 'Tax ID')}{f('timezone', 'Time zone (IANA, e.g. America/Chicago)')}
        </div>
      </div>
      <div className="card">
        <h2>Office hours</h2>
        <OfficeHours value={current.office_hours} onChange={(v) => change('office_hours', v)} />
      </div>
      <div className="card">
        <h2>Patient engagement</h2>
        <div className="form-grid">
          <label>
            Booking page address
            <input value={current.slug ?? ''} placeholder="e.g. bright-smiles" onChange={(e) => change('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
            {bookingUrl && <span className="muted">{bookingUrl}</span>}
          </label>
          <label>
            Appointment reminders
            <select value={current.reminder_hours} onChange={(e) => change('reminder_hours', Number(e.target.value))}>
              <option value={0}>Off</option>
              {[24, 48, 72].map((h) => <option key={h} value={h}>{h} hours before</option>)}
            </select>
          </label>
          <label className="checkbox full"><input type="checkbox" checked={!!current.online_booking} onChange={(e) => change('online_booking', e.target.checked)} /> Allow patients to request appointments online</label>
          {!!current.online_booking && <label className="checkbox full" style={{ marginLeft: 22 }}><input type="checkbox" checked={!!current.instant_booking} onChange={(e) => change('instant_booking', e.target.checked)} /> Book them straight onto the schedule (instead of waiting for the office to accept). Deposits, if set on an appointment type, are taken first.</label>}
          <label className="checkbox full"><input type="checkbox" checked={current.portal_enabled !== 0} onChange={(e) => change('portal_enabled', e.target.checked)} /> Patient portal (visits, balance and online payment, forms, treatment plans)</label>
          {current.portal_enabled !== 0 && <span className="muted full" style={{ fontSize: 12, marginTop: -6 }}>Portal address: {window.location.origin}/portal/{current.slug || current.id} — it&apos;s also printed on statements.</span>}
          <label className="checkbox full"><input type="checkbox" checked={current.auto_receipts !== 0} onChange={(e) => change('auto_receipts', e.target.checked)} /> Email a receipt for online and automatic card payments (staff choose for payments taken at the desk)</label>
          <label>
            Daily production goal ($)
            <input type="number" min="0" step="100" value={current.daily_goal != null ? current.daily_goal / 100 : ''} onChange={(e) => change('daily_goal', Math.round(Number(e.target.value) * 100))} />
          </label>
          <label>
            Practice texting number (Twilio)
            <input value={current.sms_number ?? ''} placeholder="+15125550142" onChange={(e) => change('sms_number', e.target.value)} />
          </label>
          <label>
            Daily hygiene goal ($)
            <input type="number" min="0" step="100" value={current.hygiene_goal != null ? current.hygiene_goal / 100 : ''} onChange={(e) => change('hygiene_goal', Math.round(Number(e.target.value) * 100))} />
          </label>
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>Texting, email, card payments and other connections: <Link to="/settings?tab=integrations">Settings → Integrations</Link>.</p>
      </div>
      <FinancingSettings value={current.financing} onChange={(v) => change('financing', v)} />
      <div className="card">
        <h2>Security & data</h2>
        <div className="form-grid">
          <label className="checkbox full"><input type="checkbox" checked={!!current.require_mfa} onChange={(e) => change('require_mfa', e.target.checked)} /> Require two-factor authentication for all staff</label>
          <label>
            Automatic sign-out after inactivity
            <select value={current.idle_timeout_minutes || 15} onChange={(e) => change('idle_timeout_minutes', Number(e.target.value))}>
              {[5, 10, 15, 30, 60, 120, 240].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`}</option>)}
            </select>
          </label>
          <label>
            Write-offs over this need an administrator ($)
            <input type="number" min="0" step="1" value={current.adjustment_approval_limit != null ? current.adjustment_approval_limit / 100 : ''} placeholder="No limit" onChange={(e) => change('adjustment_approval_limit', e.target.value === '' ? null : Math.round(Number(e.target.value) * 100))} />
          </label>
          <label>
            Books closed through
            <input type="date" value={current.lock_date || ''} max={new Date(Date.now() - 86400_000).toLocaleDateString('en-CA')} onChange={(e) => change('lock_date', e.target.value || null)} />
            <span className="muted" style={{ fontSize: 12 }}>Nothing can be posted or backdated on or before this date (month-end close). Corrections post today.</span>
          </label>
          <div>
            <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>Your data is yours. Download everything (patients, charts, ledger, claims, schedule) as JSON.</div>
            <button type="button" onClick={exportData}>⬇ Export practice data</button>
          </div>
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="form-actions">
        {saved && <span className="badge ok">Saved</span>}
        <button className="primary" disabled={busy} onClick={submit}>Save</button>
      </div>
      <SingleSignOn />
    </>
  );
}

// Financing offered on treatment plans: the office's own monthly plans and outside lenders' links.
function FinancingSettings({ value, onChange }) {
  let f = { in_house_months: [], in_house_apr: 0, links: [], min_amount: 0 };
  try { if (value) f = { ...f, ...(typeof value === 'string' ? JSON.parse(value) : value) }; } catch { /* keep the defaults */ }
  const set = (patch) => onChange(JSON.stringify({ ...f, ...patch }));
  const toggleMonths = (m) => set({ in_house_months: f.in_house_months.includes(m) ? f.in_house_months.filter((x) => x !== m) : [...f.in_house_months, m].sort((a, b) => a - b) });
  const links = [...f.links, { name: '', url: '' }];
  return (
    <div className="card">
      <h2>Financing</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Shown with treatment plans (to staff, and to patients reviewing their plan online) as monthly amounts for the patient&apos;s portion.</p>
      <div className="form-grid">
        <div className="full">
          <div className="muted" style={{ fontSize: 12 }}>In-house payment plans</div>
          <div className="inline" style={{ gap: 12, flexWrap: 'wrap' }}>
            {[3, 6, 12, 18, 24].map((m) => <label key={m} className="checkbox"><input type="checkbox" checked={f.in_house_months.includes(m)} onChange={() => toggleMonths(m)} /> {m} months</label>)}
          </div>
        </div>
        <label>Interest rate (% a year, 0 for none)<input type="number" min="0" max="30" step="0.1" value={f.in_house_apr} onChange={(e) => set({ in_house_apr: e.target.value })} /></label>
        <label>Only offer from ($)<input type="number" min="0" step="50" value={f.min_amount ? f.min_amount / 100 : ''} placeholder="Any amount" onChange={(e) => set({ min_amount: Math.round(Number(e.target.value || 0) * 100) })} /></label>
        {links.map((l, i) => (
          <div key={i} className="full inline" style={{ gap: 8 }}>
            <input aria-label="Lender" placeholder="Lender (e.g. CareCredit)" value={l.name} style={{ width: 200 }} onChange={(e) => { const next = [...links]; next[i] = { ...l, name: e.target.value }; set({ links: next.filter((x) => x.name || x.url) }); }} />
            <input aria-label="Application link" placeholder="https:// your application link" value={l.url} style={{ flex: 1 }} onChange={(e) => { const next = [...links]; next[i] = { ...l, url: e.target.value }; set({ links: next.filter((x) => x.name || x.url) }); }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Users() {
  const { user: me } = useAuth();
  const { data: users, reload } = useApi('/users');
  const { data: roles, reload: reloadRoles } = useApi('/roles');
  const { data: perms } = useApi('/permissions');
  const [modal, setModal] = useState(null);
  const [roleEdit, setRoleEdit] = useState(null);
  const roleName = (u) => roles?.find((r) => r.id === u.custom_role_id)?.name || label(u.role);
  const overrides = (u) => {
    const add = JSON.parse(u.permissions_add || '[]');
    const rem = JSON.parse(u.permissions_remove || '[]');
    return add.length || rem.length ? ` (${[...add.map((p) => `+${perms?.catalog[p] || p}`), ...rem.map((p) => `−${perms?.catalog[p] || p}`)].join(', ')})` : '';
  };
  return (
    <>
    <div className="card" style={{ padding: 0 }}>
      <div className="page-header" style={{ padding: '14px 16px', marginBottom: 0 }}>
        <h2 style={{ margin: 0 }}>Users</h2>
        <button className="primary" onClick={() => setModal({})}>+ Invite user</button>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>2FA</th><th>Last login</th><th /></tr></thead>
        <tbody>
          {users?.map((u) => (
            <tr key={u.id}>
              <td>{u.name}{u.id === me.id && <span className="muted"> (you)</span>}</td>
              <td>{u.email}</td>
              <td>{roleName(u)}<span className="muted" style={{ fontSize: 12 }}>{overrides(u)}</span></td>
              <td><span className={`badge ${u.active ? 'ok' : 'danger'}`}>{u.active ? 'Active' : 'Disabled'}</span></td>
              <td>{u.mfa_enabled ? <span className="badge ok">On</span> : <span className="muted">Off</span>}</td>
              <td>{u.last_login_at ? fmtDateTime(u.last_login_at) : 'Never'}</td>
              <td><button className="small" onClick={() => setModal({ user: u })}>Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {modal && (
        <Modal title={modal.user ? `Edit ${modal.user.name}` : 'New user'} onClose={() => setModal(null)}>
          <UserForm user={modal.user} roles={roles || []} perms={perms} onDone={() => { setModal(null); reload(); }} />
        </Modal>
      )}
    </div>
    <div className="card" style={{ padding: 0 }}>
      <div className="page-header" style={{ padding: '14px 16px', marginBottom: 0 }}>
        <div>
          <h2 style={{ margin: 0 }}>Roles</h2>
          <div className="muted" style={{ fontSize: 13 }}>Built-in roles cover most offices. Make your own when someone’s job doesn’t fit — a treatment coordinator, an office manager who shouldn’t see charts.</div>
        </div>
        <button onClick={() => setRoleEdit({ name: '', permissions: [] })}>+ Role</button>
      </div>
      {perms && (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>Role</th>{Object.values(perms.catalog).map((l) => <th key={l} style={{ fontSize: 11, whiteSpace: 'normal', minWidth: 70 }}>{l}</th>)}<th /></tr></thead>
            <tbody>
              {Object.entries(perms.roles).map(([k, list]) => (
                <tr key={k}><td>{label(k)} <span className="muted" style={{ fontSize: 11 }}>built-in</span></td>{Object.keys(perms.catalog).map((p) => <td key={p} style={{ textAlign: 'center' }}>{list.includes(p) ? '✓' : ''}</td>)}<td /></tr>
              ))}
              {(roles || []).map((r) => (
                <tr key={r.id}><td><strong>{r.name}</strong> <span className="muted" style={{ fontSize: 11 }}>{r.users} people</span></td>{Object.keys(perms.catalog).map((p) => <td key={p} style={{ textAlign: 'center' }}>{r.permissions.includes(p) ? '✓' : ''}</td>)}<td><button className="small" onClick={() => setRoleEdit(r)}>Edit</button></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {roleEdit && <RoleForm role={roleEdit} catalog={perms.catalog} onDone={() => { setRoleEdit(null); reloadRoles(); reload(); }} onClose={() => setRoleEdit(null)} />}
    </div>
    </>
  );
}

function RoleForm({ role, catalog, onDone, onClose }) {
  const [r, setR] = useState({ name: role.name, permissions: role.permissions });
  const save = useSubmit(async () => { if (role.id) await api.put(`/roles/${role.id}`, r); else await api.post('/roles', r); onDone(); });
  const del = useSubmit(async () => { await api.del(`/roles/${role.id}`); onDone(); });
  return (
    <Modal title={role.id ? `Edit ${role.name}` : 'New role'} onClose={onClose}>
      <ErrorBox error={save.error || del.error} />
      <label>Name<input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /></label>
      <div style={{ marginTop: 10 }}>
        {Object.entries(catalog).map(([k, l]) => (
          <label key={k} className="checkbox" style={{ margin: '4px 0' }}>
            <input type="checkbox" checked={r.permissions.includes(k)} onChange={(e) => setR({ ...r, permissions: e.target.checked ? [...r.permissions, k] : r.permissions.filter((x) => x !== k) })} /> {l}
          </label>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>Settings and user accounts are always administrator-only.</div>
      <div className="form-actions">
        {role.id && <button type="button" className="danger" onClick={del.submit}>Delete</button>}
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={save.busy || !r.name} onClick={save.submit}>Save</button>
      </div>
    </Modal>
  );
}

function UserForm({ user, roles = [], perms, onDone }) {
  const [form, setForm] = useState({
    name: user?.name || '', email: user?.email || '', role: user?.role || 'front_desk', active: user ? !!user.active : true, password: '',
    custom_role_id: user?.custom_role_id || '', permissions_add: JSON.parse(user?.permissions_add || '[]'), permissions_remove: JSON.parse(user?.permissions_remove || '[]'),
    location_ids: JSON.parse(user?.location_ids || '[]'),
  });
  const offices = useLookup('/locations');
  const base = form.custom_role_id ? roles.find((r) => r.id === Number(form.custom_role_id))?.permissions || [] : perms?.roles[form.role] || [];
  // Each permission: from the role, added just for this person, or taken away from them.
  const state = (p) => (form.permissions_add.includes(p) ? 'add' : form.permissions_remove.includes(p) ? 'remove' : 'role');
  const setState = (p, v) => setForm({ ...form, permissions_add: form.permissions_add.filter((x) => x !== p).concat(v === 'add' ? [p] : []), permissions_remove: form.permissions_remove.filter((x) => x !== p).concat(v === 'remove' ? [p] : []) });
  const { submit, busy, error } = useSubmit(async () => {
    const body = { ...form, custom_role_id: form.custom_role_id ? Number(form.custom_role_id) : null };
    if (!body.password) delete body.password;
    if (user) await api.put(`/users/${user.id}`, body);
    // A new person picks their own password at their first sign-in.
    else await api.post('/users', { ...body, must_change_password: true });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Email<input type="email" required disabled={!!user} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label>Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></label>
        <label>{user ? 'Reset password (optional)' : 'Temporary password'}<input type="password" minLength={10} required={!user} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        {user && <label className="checkbox"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>}
        {user?.mfa_enabled ? <label className="checkbox"><input type="checkbox" checked={!!form.reset_mfa} onChange={(e) => setForm({ ...form, reset_mfa: e.target.checked })} /> Reset 2FA (lost phone)</label> : null}
        {form.role !== 'admin' && roles.length > 0 && (
          <label>Custom role (instead of the built-in one)
            <select value={form.custom_role_id} onChange={(e) => setForm({ ...form, custom_role_id: e.target.value })}>
              <option value="">— use {label(form.role)} —</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {offices.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 12 }}>Works at (none ticked = every office). Someone limited to some offices sees only those offices' schedule and patients, and only office-level reports.</div>
          <div className="inline" style={{ flexWrap: 'wrap', gap: 12 }}>
            {offices.map((l) => (
              <label key={l.id} className="checkbox"><input type="checkbox" checked={form.location_ids.includes(l.id)} onChange={(e) => setForm({ ...form, location_ids: e.target.checked ? [...form.location_ids, l.id] : form.location_ids.filter((x) => x !== l.id) })} /> {l.name}</label>
            ))}
          </div>
        </div>
      )}
      {form.role !== 'admin' && perms && (
        <details style={{ marginTop: 10 }}>
          <summary>Permissions for this person</summary>
          <table className="compact-table" style={{ marginTop: 6 }}>
            <tbody>
              {Object.entries(perms.catalog).map(([p, l]) => (
                <tr key={p}>
                  <td>{l}</td>
                  <td>
                    <select value={state(p)} onChange={(e) => setState(p, e.target.value)}>
                      <option value="role">{base.includes(p) ? 'Yes (from role)' : 'No (from role)'}</option>
                      <option value="add">Yes, for this person</option>
                      <option value="remove">No, for this person</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <div className="form-actions"><button className="primary" disabled={busy}>Save</button></div>
    </form>
  );
}

function ResourceTable({ spec, canWrite }) {
  const { data: rows, reload } = useApi(spec.path);
  const locations = useLookup(spec.columns.includes('location_id') ? '/locations' : null);
  const [editing, setEditing] = useState(null);
  const done = () => {
    setEditing(null);
    invalidateLookup(`${spec.path}?active=true`);
    invalidateLookup(spec.path);
    reload();
  };
  const cell = (row, col) => {
    if (col === 'fee') return money(row.fee);
    if (col === 'color') return <span className="inline" style={{ gap: 6 }}><span className="swatch" style={{ background: row.color }} aria-hidden />{row.color}</span>;
    if (col === 'type' || col === 'category') return label(row[col]);
    if (col === 'duration') return `${row.duration} min`;
    if (col === 'procedure_codes') return (row.procedure_codes ? JSON.parse(row.procedure_codes) : []).join(', ') || '—';
    if (col === 'online_bookable') return row.online_bookable ? 'Online' : '—';
    if (col === 'office_hours') return row.office_hours ? summarizeHours(JSON.parse(row.office_hours)) : 'Practice hours';
    if (col === 'location_id') return locations.find((l) => l.id === row.location_id)?.name || '—';
    if (col === 'working_hours') return row.working_hours ? (() => { const h = JSON.parse(row.working_hours); return `${summarizeHours(h)}${h.alt ? ' · alternating weeks' : ''}`; })() : 'Office hours';
    return row[col] ?? '—';
  };
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="page-header" style={{ padding: '14px 16px', marginBottom: 0 }}>
        <h2 style={{ margin: 0 }}>{spec.title}</h2>
        {canWrite && <button className="primary" onClick={() => setEditing({})}>+ Add</button>}
      </div>
      {spec.intro && <p className="muted" style={{ fontSize: 13, margin: '0 16px 12px' }}>{spec.intro}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr>{spec.columns.map((c) => <th key={c} className={c === 'fee' ? 'num' : ''}>{label(c)}</th>)}<th>Status</th><th /></tr></thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}>
                {spec.columns.map((c) => <td key={c} className={c === 'fee' ? 'num' : ''}>{cell(r, c)}</td>)}
                <td>{r.active ? 'Active' : 'Inactive'}</td>
                <td>{canWrite && <button className="small" onClick={() => setEditing(r)}>Edit</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <Modal title={`${editing.id ? 'Edit' : 'Add'} ${spec.singular || spec.title.toLowerCase()}`} onClose={() => setEditing(null)}>
          <ResourceForm spec={spec} row={editing} onDone={done} />
        </Modal>
      )}
    </div>
  );
}

// A time pattern drawn as a strip: dark for provider time, hatched for assistant time.
function PatternBar({ pattern }) {
  return (
    <div className="pattern-bar" aria-hidden="true">
      {[...pattern].map((c, i) => <i key={i} className={c === 'X' ? 'x' : 'a'} title={`${i * 10}–${i * 10 + 10} min: ${c === 'X' ? 'provider' : 'assistant'}`} />)}
    </div>
  );
}

function ResourceForm({ spec, row, onDone }) {
  const providerList = useLookup('/providers?active=true');
  const locationList = useLookup(spec.fields.some((f) => f[2] === 'location') ? '/locations' : null);
  const officeSchedules = useLookup(spec.fields.some((f) => f[2] === 'feeschedule') ? '/fee-schedules' : null).filter((f) => f.kind === 'office');
  const { data: practice } = useApi(spec.fields.some((f) => f[2] === 'hours') ? '/practice' : null);
  const practiceHours = practice?.office_hours ? JSON.parse(practice.office_hours) : DEFAULT_HOURS;
  const [form, setForm] = useState(() => Object.fromEntries(spec.fields.map(([name, , type]) => {
    if (type === 'checkbox') return [name, row.id ? !!row[name] : name === 'active'];
    if (type === 'money') return [name, row.id ? fromCents(row[name]) : ''];
    if (type === 'color') return [name, row[name] || '#3b82f6'];
    if (type === 'codes') return [name, row[name] ? JSON.parse(row[name]).join(', ') : ''];
    if (type === 'hours') return [name, row[name] ? JSON.parse(row[name]) : null];
    if (type === 'durations') return [name, row[name] ? JSON.parse(row[name]) : {}];
    return [name, row[name] ?? ''];
  })));
  const { submit, busy, error } = useSubmit(async () => {
    const body = Object.fromEntries(spec.fields.map(([name, , type]) => [name,
      type === 'money' ? toCents(form[name] || 0)
        : type === 'codes' ? String(form[name] || '').split(/[\s,]+/).filter(Boolean)
          : type === 'number' ? Number(form[name] || 0)
            : form[name]]));
    if (row.id) await api.put(`${spec.path}/${row.id}`, body);
    else await api.post(spec.path, body);
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        {spec.fields.map(([name, text, type, options]) => {
          const set = (v) => setForm({ ...form, [name]: v });
          if (type === 'checkbox') return <label key={name} className="checkbox"><input type="checkbox" checked={form[name]} onChange={(e) => set(e.target.checked)} /> {text}</label>;
          if (type === 'hours') return (
            <div key={name} className="full">
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{text}</div>
              <label className="checkbox" style={{ color: 'var(--text)', marginBottom: 8 }}>
                <input type="checkbox" checked={!form[name]} onChange={(e) => set(e.target.checked ? null : practiceHours)} /> {options?.same || 'Same as office hours'}
              </label>
              {form[name] && <OfficeHours value={form[name]} onChange={set} note={options?.note || "Outside these hours the provider's column is shaded, online booking won't offer them, and staff are asked before booking."} />}
              {form[name] && options?.alt !== false && <AltWeeks value={form[name]} onChange={set} />}
            </div>
          );
          if (type === 'pattern') return (
            <label key={name} className="full">
              {text} <span className="muted" style={{ fontSize: 12 }}>— one letter per 10 minutes: X provider, / assistant only (e.g. //XXXX// for a crown prep). The provider can be booked elsewhere during / time.</span>
              <input value={form[name]} placeholder="blank = provider the whole time" onChange={(e) => set(e.target.value.toUpperCase().replace(/[^X/]/g, ''))} />
              {form[name] && <PatternBar pattern={form[name]} />}
            </label>
          );
          if (type === 'durations') return (
            <div key={name} className="full">
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{text}</div>
              <div className="inline" style={{ flexWrap: 'wrap', gap: 10 }}>
                {providerList.map((p) => (
                  <label key={p.id} className="inline" style={{ gap: 6, flexDirection: 'row', alignItems: 'center' }}>
                    <span style={{ fontSize: 13 }}>{p.name}</span>
                    <input type="number" min="5" step="5" style={{ width: 80 }} aria-label={`Minutes with ${p.name}`} value={form[name]?.[p.id] ?? ''} onChange={(e) => { const next = { ...form[name] }; if (e.target.value) next[p.id] = Number(e.target.value); else delete next[p.id]; set(next); }} />
                  </label>
                ))}
              </div>
            </div>
          );
          if (type === 'feeschedule') return <label key={name}>{text}<select value={form[name] || ''} onChange={(e) => set(e.target.value ? Number(e.target.value) : null)}><option value="">Standard fees</option>{officeSchedules.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>;
          if (type === 'location') return locationList.length ? <label key={name}>{text}<select value={form[name] || ''} onChange={(e) => set(e.target.value ? Number(e.target.value) : null)}><option value="">—</option>{locationList.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label> : null;
          if (type === 'provider') return <label key={name}>{text}<select value={form[name] || ''} onChange={(e) => set(e.target.value ? Number(e.target.value) : null)}><option value="">—</option>{providerList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>;
          if (type === 'select') return <label key={name}>{text}<select value={form[name]} onChange={(e) => set(e.target.value)}><option value="">—</option>{options.map((o) => <option key={o} value={o}>{label(o)}</option>)}</select></label>;
          return <label key={name} className={type === 'codes' ? 'full' : ''}>{text}<input type={type === 'money' || type === 'number' ? 'number' : type === 'codes' ? 'text' : type} step={type === 'money' ? '0.01' : undefined} value={form[name]} onChange={(e) => set(e.target.value)} /></label>;
        })}
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Save</button></div>
    </form>
  );
}

function AuditLog() {
  const [params] = useSearchParams();
  const users = useLookup('/users');
  const offices = useLookup('/locations');
  const [filters, setFilters] = useState({ from: '', to: '', user_id: '', action: '', patient_id: params.get('patient_id') || '', source: '', location_id: '', changes: '' });
  const [applied, setApplied] = useState(filters);
  const [pages, setPages] = useState(1);
  const qs = (extra = {}) => new URLSearchParams(Object.fromEntries(Object.entries({ ...applied, ...extra }).filter(([, v]) => v !== '' && v != null))).toString();
  const { data: rows } = useApi(`/audit-log?${qs({ limit: 200 * pages })}`);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });
  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: '14px 16px' }}>
        <h2 style={{ margin: 0 }}>Audit log</h2>
        <div className="muted">Every access to and change of patient information is recorded here (HIPAA §164.312(b)). Search it for access reviews; export for your compliance file.</div>
        <form className="inline" style={{ flexWrap: 'wrap', marginTop: 10, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); setPages(1); setApplied(filters); }}>
          <label>From<input type="date" value={filters.from} onChange={set('from')} /></label>
          <label>To<input type="date" value={filters.to} onChange={set('to')} /></label>
          <label>User<select value={filters.user_id} onChange={set('user_id')}><option value="">Anyone</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label>Action starts with<input value={filters.action} onChange={set('action')} placeholder="e.g. patient.view, ledger." /></label>
          <label>Patient #<input value={filters.patient_id} onChange={set('patient_id')} inputMode="numeric" style={{ width: 90 }} /></label>
          <label>Done by<select value={filters.source} onChange={set('source')}><option value="">Anyone or anything</option>{Object.entries(AUDIT_SOURCES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {offices.length > 1 && <label>Office<select value={filters.location_id} onChange={set('location_id')}><option value="">All</option>{offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>}
          <label className="checkbox"><input type="checkbox" checked={filters.changes === '1'} onChange={(e) => setFilters({ ...filters, changes: e.target.checked ? '1' : '' })} /> Only changes</label>
          <button className="primary">Search</button>
          <button type="button" onClick={() => download(`/audit-log?${qs({ format: 'csv' })}`, 'audit-log.csv').catch(setErr)}>⬇ Export CSV</button>
        </form>
        <ErrorBox error={err} />
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When (UTC)</th><th>Who</th><th>Action</th><th>Record</th><th>Before → after</th><th>Details</th></tr></thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{r.created_at}</td>
                <td>
                  {r.actor || r.user_name || '—'}
                  <div className="muted" style={{ fontSize: 11 }}>{AUDIT_SOURCES[r.source] || r.source}{r.source === 'ai' && r.user_name ? ` · for ${r.user_name}` : ''}{r.location_name ? ` · ${r.location_name}` : ''}{r.ip ? ` · ${r.ip}` : ''}</div>
                </td>
                <td><code>{r.action}</code>{r.reason && <div style={{ fontSize: 12 }}>Why: {r.reason}</div>}</td>
                <td>{r.entity ? `${r.entity} #${r.entity_id}` : ''}{r.patient_id && r.entity !== 'patients' ? <div className="muted" style={{ fontSize: 11 }}>patient #{r.patient_id}</div> : null}</td>
                <td style={{ fontSize: 12 }}><Changes json={r.changes} /></td>
                <td className="muted" style={{ fontSize: 12, maxWidth: 260, overflowWrap: 'anywhere' }}>{r.details}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows?.length === 0 && <div className="empty">Nothing matches.</div>}
        {rows?.length === 200 * pages && <div style={{ padding: 12 }}><button onClick={() => setPages(pages + 1)}>Show more</button></div>}
      </div>
    </div>
  );
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULT_HOURS = { 0: [], 1: [['08:00', '17:00']], 2: [['08:00', '17:00']], 3: [['08:00', '17:00']], 4: [['08:00', '17:00']], 5: [['08:00', '17:00']], 6: [] };

// Weekly hours editor; used by the schedule shading and online booking.
// A second weekly pattern for every other week (e.g. a hygienist in Mondays one week, Tuesdays the next).
function AltWeeks({ value, onChange }) {
  const { alt, ...week } = value;
  const monday = () => {
    const d = new Date();
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.toLocaleDateString('en-CA');
  };
  return (
    <div style={{ marginTop: 10 }}>
      <label className="checkbox" style={{ color: 'var(--text)' }}>
        <input type="checkbox" checked={!!alt} onChange={(e) => onChange(e.target.checked ? { ...week, alt: { anchor: monday(), hours: week } } : week)} /> Different hours every other week
      </label>
      {alt && (
        <div className="alt-weeks">
          <label>Alternate pattern starts the week of<input type="date" value={alt.anchor} onChange={(e) => onChange({ ...week, alt: { ...alt, anchor: e.target.value } })} style={{ width: 170 }} /></label>
          <OfficeHours value={alt.hours} onChange={(h) => onChange({ ...week, alt: { ...alt, hours: h } })} note="Used that week and every second week after it; the hours above apply to the weeks in between." />
        </div>
      )}
    </div>
  );
}

function OfficeHours({ value, onChange, note }) {
  const hours = typeof value === 'string' ? JSON.parse(value) : value || DEFAULT_HOURS;
  const setDay = (d, ranges) => onChange({ ...hours, [d]: ranges });
  return (
    <div className="hours-grid">
      {[1, 2, 3, 4, 5, 6, 0].map((d) => {
        const ranges = hours[d] || [];
        return (
          <div key={d} className="hours-row">
            <label className="checkbox" style={{ color: 'var(--text)', minWidth: 130 }}>
              <input type="checkbox" checked={ranges.length > 0} onChange={(e) => setDay(d, e.target.checked ? [['08:00', '17:00']] : [])} /> {DAYS[d]}
            </label>
            {ranges.length === 0 && <span className="muted">Closed</span>}
            {ranges.map(([o, c], i) => (
              <span key={i} className="inline">
                <input type="time" aria-label={`${DAYS[d]} opens`} value={o} step={900} onChange={(e) => setDay(d, ranges.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
                <span>–</span>
                <input type="time" aria-label={`${DAYS[d]} closes`} value={c} step={900} onChange={(e) => setDay(d, ranges.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
                <button type="button" className="small" onClick={() => setDay(d, ranges.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
              </span>
            ))}
            {ranges.length > 0 && ranges.length < 3 && (
              <button type="button" className="small link" onClick={() => setDay(d, [...ranges, [ranges.at(-1)[1] < '13:00' ? '13:00' : ranges.at(-1)[1], '17:00']])}>+ split shift</button>
            )}
          </div>
        );
      })}
      <p className="muted" style={{ fontSize: 12 }}>{note || 'Closed times are shaded on the schedule and never offered for online booking. Use blocked time for lunches and one-off closures.'}</p>
    </div>
  );
}

async function exportData() {
  const res = await fetch('/api/export', { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) return alert('Export failed');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = (res.headers.get('Content-Disposition') || '').match(/filename="(.+)"/)?.[1] || 'dentalmachine-export.json';
  a.click();
  URL.revokeObjectURL(url);
}

// Fee schedules: PPO contracted allowed fees per carrier (write-offs and estimates), and office fees (what's charged).
function FeeSchedules({ admin }) {
  const { data: list, reload } = useApi('/fee-schedules');
  const { data: carriers } = useApi('/carriers');
  const { data: codes } = useApi('/procedure-codes');
  const [sel, setSel] = useState(null);
  const [creating, setCreating] = useState(false);
  const current = list?.find((f) => f.id === sel) || list?.[0];
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(200px, 260px) minmax(0, 1fr)' }}>
      <div className="card">
        <h2>Schedules</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          <strong>Insurance (PPO)</strong> schedules are what in-network plans allow: the difference from your fee is written off and estimates use it.{' '}
          <strong>Office</strong> schedules change what you charge — for a patient (cash / uninsured), a provider (an associate or specialist) or an office. The patient’s wins, then the provider’s, then the office’s, then the standard fee.
        </p>
        {list?.map((f) => (
          <button key={f.id} className={`list-item${current?.id === f.id ? ' active' : ''}`} onClick={() => setSel(f.id)}>
            <strong>{f.name}</strong> <span className="badge">{f.kind === 'office' ? 'Office' : 'PPO'}</span>
            <div className="muted" style={{ fontSize: 12 }}>{f.items.length} codes{f.kind !== 'office' && ` · ${f.carriers.map((c) => c.name).join(', ') || 'no carriers'}`}</div>
          </button>
        ))}
        {list?.length === 0 && <div className="muted">None yet — all carriers are paid from office fees.</div>}
        {admin && <button className="primary" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>+ New fee schedule</button>}
        <FeeHistory />
      </div>
      {current && codes && carriers && <FeeScheduleEditor key={current.id} fs={current} codes={codes} carriers={carriers} admin={admin} onSaved={reload} />}
      {creating && (
        <Modal title="New fee schedule" onClose={() => setCreating(false)}>
          <NewFeeSchedule onDone={(fs) => { setCreating(false); reload(); setSel(fs.id); }} />
        </Modal>
      )}
    </div>
  );
}

// Every change to a standard or scheduled fee, newest first.
function FeeHistory() {
  const [code, setCode] = useState('');
  const { data } = useApi(`/fee-history${code.length >= 5 ? `?code=${encodeURIComponent(code)}` : ''}`);
  return (
    <details style={{ marginTop: 16 }}>
      <summary>Fee history</summary>
      <input placeholder="Code, e.g. D2740" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ margin: '6px 0' }} />
      <table className="compact-table">
        <tbody>
          {data?.slice(0, 100).map((x) => (
            <tr key={x.id}><td>{x.code}<div className="muted" style={{ fontSize: 11 }}>{x.schedule_name || 'Standard'} · {fmtDate(x.changed_at.slice(0, 10))}</div></td><td className="num">{x.old_fee == null ? '—' : money(x.old_fee)} → {x.new_fee == null ? '—' : money(x.new_fee)}</td></tr>
          ))}
          {data?.length === 0 && <tr><td className="muted">No changes recorded yet.</td></tr>}
        </tbody>
      </table>
    </details>
  );
}

function NewFeeSchedule({ onDone }) {
  const [form, setForm] = useState({ name: '', kind: 'ppo', percent_of_ucr: 80 });
  const { submit, busy, error } = useSubmit(async () => onDone(await api.post('/fee-schedules', form)));
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <div className="full inline" style={{ gap: 16 }}>
          <label className="checkbox"><input type="radio" checked={form.kind === 'ppo'} onChange={() => setForm({ ...form, kind: 'ppo', percent_of_ucr: 80 })} /> Insurance (PPO) allowed fees</label>
          <label className="checkbox"><input type="radio" checked={form.kind === 'office'} onChange={() => setForm({ ...form, kind: 'office', percent_of_ucr: 100 })} /> Office fees (cash, associate, office)</label>
        </div>
        <label className="full">Name<input required value={form.name} placeholder={form.kind === 'ppo' ? 'e.g. Delta Dental PPO 2026' : 'e.g. Cash / uninsured'} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="full">Start at % of office fees<input type="number" min="0" max="100" value={form.percent_of_ucr} onChange={(e) => setForm({ ...form, percent_of_ucr: Number(e.target.value) })} /><span className="muted">You can then enter each contracted fee exactly.</span></label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Create</button></div>
    </form>
  );
}

function FeeScheduleEditor({ fs, codes, carriers, admin, onSaved }) {
  const [fees, setFees] = useState(() => Object.fromEntries(fs.items.map((i) => [i.code, fromCents(i.fee)])));
  const [assigned, setAssigned] = useState(() => fs.carriers.map((c) => c.id));
  const [filter, setFilter] = useState('');
  const [saved, setSaved] = useState(false);
  const { submit, busy, error } = useSubmit(async () => {
    const items = codes.map((c) => ({ code: c.code, fee: fees[c.code] === '' || fees[c.code] == null ? null : toCents(fees[c.code]) }));
    await api.put(`/fee-schedules/${fs.id}`, { items, carrier_ids: assigned });
    setSaved(true);
    onSaved();
  });
  const shown = codes.filter((c) => !filter || `${c.code} ${c.description}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{fs.name}</h2>
        {admin && <div className="inline">{saved && <span className="badge ok">Saved</span>}<button className="primary" disabled={busy} onClick={submit}>Save</button></div>}
      </div>
      <ErrorBox error={error} />
      {fs.kind === 'office' && <p className="muted" style={{ fontSize: 13 }}>Choose it on a patient’s chart, a provider (Settings → Providers) or an office (Settings → Offices). Codes left blank use the standard fee.</p>}
      <div style={{ marginBottom: 12, display: fs.kind === 'office' ? 'none' : undefined }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Used for these carriers</div>
        <div className="chips">
          {carriers.map((c) => (
            <button key={c.id} type="button" disabled={!admin} className={`chip${assigned.includes(c.id) ? ' active' : ''}`}
              onClick={() => { setSaved(false); setAssigned(assigned.includes(c.id) ? assigned.filter((x) => x !== c.id) : [...assigned, c.id]); }}>
              {assigned.includes(c.id) ? '✓ ' : ''}{c.name}
            </button>
          ))}
        </div>
      </div>
      <input placeholder="Filter codes…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 8, maxWidth: 280 }} />
      <div className="table-wrap" style={{ maxHeight: 460, overflow: 'auto' }}>
        <table>
          <thead><tr><th>Code</th><th>Description</th><th className="num">Standard fee</th><th className="num">{fs.kind === 'office' ? 'This schedule' : 'Contracted'}</th><th className="num">{fs.kind === 'office' ? 'Difference' : 'Write-off'}</th></tr></thead>
          <tbody>
            {shown.map((c) => {
              const v = fees[c.code];
              const wo = v !== '' && v != null ? c.fee - toCents(v) : null;
              return (
                <tr key={c.code}>
                  <td>{c.code}</td><td>{c.description}</td><td className="num">{money(c.fee)}</td>
                  <td className="num"><input className="fee-input" type="number" min="0" step="0.01" disabled={!admin} value={v ?? ''} placeholder="standard" onChange={(e) => { setSaved(false); setFees({ ...fees, [c.code]: e.target.value }); }} /></td>
                  <td className="num muted">{wo ? money(wo) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}


// Recall types: which procedures reset each one and how often it comes due.
function RecallTypes() {
  const { user } = useAuth();
  const { data: types, reload } = useApi('/recall-types');
  const apptTypes = useLookup('/appointment-types?active=true');
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const save = async (t, patch) => {
    setErr(null);
    try {
      if (t.id) await api.put(`/recall-types/${t.id}`, patch);
      else await api.post('/recall-types', { ...t, ...patch });
      setAdding(false);
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  const admin = user.role === 'admin';
  return (
    <div style={{ marginTop: 16 }}>
      <h3>Recall types</h3>
      <ErrorBox error={err} />
      <table className="compact-table">
        <thead><tr><th>Type</th><th>Every</th><th>Reset by codes</th><th>Book as</th><th>On</th></tr></thead>
        <tbody>
          {types?.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td><input type="number" aria-label={`${t.name} interval (months)`} min="1" max="120" defaultValue={t.interval_months} disabled={!admin} style={{ width: 60 }} onBlur={(e) => Number(e.target.value) !== t.interval_months && save(t, { interval_months: Number(e.target.value) })} /> mo</td>
              <td><input aria-label={`${t.name} codes`} defaultValue={t.codes.join(', ')} disabled={!admin} onBlur={(e) => e.target.value !== t.codes.join(', ') && save(t, { codes: e.target.value })} /></td>
              <td>
                <select aria-label={`${t.name} visit type`} value={t.appointment_type_id || ''} disabled={!admin} onChange={(e) => save(t, { appointment_type_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">—</option>
                  {apptTypes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </td>
              <td><input type="checkbox" aria-label={`${t.name} active`} checked={!!t.active} disabled={!admin} onChange={(e) => save(t, { active: e.target.checked })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {admin && (adding ? (
        <form className="inline" style={{ marginTop: 8, gap: 6 }} onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.target); save({}, { name: f.get('name'), interval_months: Number(f.get('months')), codes: f.get('codes') }); }}>
          <input name="name" placeholder="e.g. Fluoride varnish" required />
          <input name="months" type="number" min="1" defaultValue="6" style={{ width: 70 }} />
          <input name="codes" placeholder="D1206" />
          <button className="small primary">Add</button>
        </form>
      ) : <button type="button" className="small" style={{ marginTop: 8 }} onClick={() => setAdding(true)}>+ Recall type</button>)}
    </div>
  );
}

const RECOMMENDED_STEPS = [{ hours: 168, channel: 'email', confirmed: false }, { hours: 48, channel: 'auto', confirmed: false }, { hours: 4, channel: 'sms', confirmed: true }];

// Reminders, recall automation, message templates and the Google review request program.
function Messaging() {
  const { data: practice } = useApi('/practice');
  const { data: meta } = useApi('/message-templates/meta');
  const [tplLang, setTplLang] = useState('en');
  const [focus, setFocus] = useState('reminder');
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const { refresh } = useAuth();
  const { submit, busy, error } = useSubmit(async () => {
    await api.put('/practice', {
      review_url: form.review_url || null, review_requests: form.review_requests, review_threshold: Number(form.review_threshold), message_templates: form.templates,
      reminder_steps: form.reminder_steps.map((s) => ({ ...s, hours: Number(s.hours) })), recall_auto: form.recall_auto, recall_steps: form.recall_steps.map((s) => ({ ...s, days: Number(s.days) })),
      send_from: form.send_from, send_until: form.send_until, booking_notices: form.booking_notices, no_show_texts: form.no_show_texts, auto_fill: form.auto_fill, fill_batch: Number(form.fill_batch) || 5,
    });
    setSaved(true);
    refresh();
  });
  if (!practice || !meta) return null;
  const cur = form || {
    review_url: practice.review_url || '', review_requests: !!practice.review_requests, review_threshold: practice.review_threshold || 4, templates: JSON.parse(practice.message_templates || '{}'),
    reminder_steps: practice.reminder_steps ? JSON.parse(practice.reminder_steps) : (practice.reminder_hours > 0 ? [{ hours: practice.reminder_hours, channel: 'auto', confirmed: false }] : []),
    recall_auto: !!practice.recall_auto,
    send_from: practice.send_from || '08:00', send_until: practice.send_until || '20:00', booking_notices: practice.booking_notices !== 0, no_show_texts: practice.no_show_texts !== 0, auto_fill: practice.auto_fill !== 0, fill_batch: practice.fill_batch || 5,
    recall_steps: practice.recall_steps ? JSON.parse(practice.recall_steps) : [{ days: -14, channel: 'auto' }, { days: 0, channel: 'auto' }, { days: 30, channel: 'auto' }, { days: 90, channel: 'auto' }],
  };
  const setStep = (list, i, patch) => change({ [list]: cur[list].map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const change = (patch) => { setSaved(false); setForm({ ...cur, ...patch }); };
  const sample = { first_name: 'Maria', practice: practice.name, when: 'Tue, Oct 6 at 9:00 AM', visits: 'Tue, Oct 6: Maria at 9:00 AM with Dr. Chen, Sofia at 10:00 AM with Dr. Chen', provider: 'Dr. Chen', link: 'https://…/c/abc123', phone: practice.phone || '(555) 555-0100', forms: '3 forms', amount: '$125.00', reason: 'Card declined (insufficient funds)', date: 'Oct 6', method: 'credit card', balance: '$80.00', receipt: '#1042', code: '482913', minutes: '10' };
  const render = (t, extra = {}) => t.replace(/\{(\w+)\}/g, (_, k) => extra[k] ?? sample[k] ?? '');
  return (
    <>
      <div className="card">
        <h2>Appointment reminders</h2>
        <p className="muted" style={{ fontSize: 13 }}>Each reminder goes out once, at the set time before the visit, with a one-tap confirm link. A visit booked late gets only the reminders still ahead of it. Confirmed patients are skipped unless you tick the box (useful for a same-day “see you soon”).</p>
        <table className="compact-table">
          <thead><tr><th>Before the visit</th><th>Send by</th><th>Also to confirmed patients</th><th /></tr></thead>
          <tbody>
            {cur.reminder_steps.map((s, i) => (
              <tr key={i}>
                <td>
                  <select aria-label="Before the visit" value={s.hours} onChange={(e) => setStep('reminder_steps', i, { hours: e.target.value })}>
                    {[[336, '2 weeks'], [168, '1 week'], [72, '3 days'], [48, '2 days'], [24, '1 day'], [4, '4 hours'], [2, '2 hours']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </td>
                <td>
                  <select aria-label="Send by" value={s.channel || 'auto'} onChange={(e) => setStep('reminder_steps', i, { channel: e.target.value })}>
                    <option value="auto">Text, or email if no mobile</option><option value="sms">Text</option><option value="email">Email</option><option value="call">Phone call (if not confirmed yet)</option>
                  </select>
                </td>
                <td><input type="checkbox" aria-label="Also to confirmed patients" checked={!!s.confirmed} onChange={(e) => setStep('reminder_steps', i, { confirmed: e.target.checked })} /></td>
                <td><button type="button" className="small" onClick={() => change({ reminder_steps: cur.reminder_steps.filter((_, j) => j !== i) })} aria-label="Remove reminder">✕</button></td>
              </tr>
            ))}
            {!cur.reminder_steps.length && <tr><td colSpan={4} className="muted">No automatic reminders.</td></tr>}
          </tbody>
        </table>
        <div className="inline" style={{ marginTop: 8 }}>
          {cur.reminder_steps.length < 5 && <button type="button" className="small" onClick={() => change({ reminder_steps: [...cur.reminder_steps, { hours: 24, channel: 'auto', confirmed: false }] })}>+ Reminder</button>}
          <button type="button" className="small" title="An email a week out with the calendar invite, a text two days out asking for a yes, and a same-day “see you soon” text" onClick={() => change({ reminder_steps: RECOMMENDED_STEPS })}>Use the recommended schedule</button>
        </div>
        <h3 style={{ marginTop: 18 }}>Also</h3>
        <label className="checkbox"><input type="checkbox" checked={cur.booking_notices} onChange={(e) => change({ booking_notices: e.target.checked })} /> Tell patients when the office books or moves a visit (a text or email with the time and the confirm link; untick “Let the patient know” when booking to skip one)</label>
        <label className="checkbox"><input type="checkbox" checked={cur.no_show_texts} onChange={(e) => change({ no_show_texts: e.target.checked })} /> Send a “we missed you” message the same day when a visit is marked as a no-show</label>
        <label className="checkbox"><input type="checkbox" checked={cur.auto_fill} onChange={(e) => change({ auto_fill: e.target.checked })} /> Fill cancellations automatically: text the opening to
          <input type="number" min={1} max={20} value={cur.fill_batch} onChange={(e) => change({ fill_batch: e.target.value })} style={{ width: 56, margin: '0 6px' }} />
          ASAP and waitlist patients; the first to reply YES is booked</label>
        <div className="inline" style={{ marginTop: 10, alignItems: 'center' }}>
          <span>Automatic messages go out between</span>
          <input type="time" aria-label="Send from" value={cur.send_from} onChange={(e) => change({ send_from: e.target.value })} style={{ width: 140 }} />
          <span>and</span>
          <input type="time" aria-label="Send until" value={cur.send_until} onChange={(e) => change({ send_until: e.target.value })} style={{ width: 140 }} />
          <span className="muted" style={{ fontSize: 12 }}>(office time; texting laws allow 8 AM–9 PM in the patient’s time zone)</span>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>A family sharing a phone gets one message for everyone&apos;s visits that day, and a child&apos;s reminders go to the parent. Patients reply C to confirm, R for a new time, HELP or STOP. A “Phone call” step rings those not yet confirmed (press 1 to confirm) — and reaches landlines. Texts to a landline and emails that bounce are noticed and the other channel is used.</p>
      </div>
      <div className="card">
        <h2>Recall</h2>
        <label className="checkbox"><input type="checkbox" checked={cur.recall_auto} onChange={(e) => change({ recall_auto: e.target.checked })} /> Automatically remind patients who are due and have nothing booked</label>
        {cur.recall_auto && (
          <>
            <p className="muted" style={{ fontSize: 13 }}>One message per patient per step, covering all of their due recalls. Patients first found long overdue get only the latest step.</p>
            <table className="compact-table">
              <thead><tr><th>When</th><th>Send by</th><th /></tr></thead>
              <tbody>
                {cur.recall_steps.map((s, i) => (
                  <tr key={i}>
                    <td className="inline">
                      <input type="number" aria-label="Days" value={Math.abs(s.days)} min="0" style={{ width: 70 }} onChange={(e) => setStep('recall_steps', i, { days: (Number(s.days) < 0 ? -1 : 1) * Math.abs(Number(e.target.value)) })} /> days
                      <select aria-label="Before or after due" value={Number(s.days) < 0 ? 'before' : 'after'} onChange={(e) => setStep('recall_steps', i, { days: (e.target.value === 'before' ? -1 : 1) * Math.abs(Number(s.days)) })}>
                        <option value="before">before due</option><option value="after">after due</option>
                      </select>
                    </td>
                    <td>
                      <select aria-label="Send by" value={s.channel || 'auto'} onChange={(e) => setStep('recall_steps', i, { channel: e.target.value })}>
                        <option value="auto">Text, or email if no mobile</option><option value="sms">Text</option><option value="email">Email</option>
                      </select>
                    </td>
                    <td><button type="button" className="small" onClick={() => change({ recall_steps: cur.recall_steps.filter((_, j) => j !== i) })} aria-label="Remove step">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cur.recall_steps.length < 8 && <button type="button" className="small" onClick={() => change({ recall_steps: [...cur.recall_steps, { days: 60, channel: 'auto' }] })}>+ Step</button>}
          </>
        )}
        <RecallTypes />
      </div>
      <div className="card">
        <h2>Online reviews</h2>
        <p className="muted" style={{ fontSize: 13 }}>After a completed visit, patients get one text (at most every 6 months) asking how the visit went. Happy patients are invited to post a review on your review page; anyone less happy can tell you privately, and the office gets a task to call them back.</p>
        <div className="form-grid">
          <label className="full">Review link (Google, Yelp…)<input value={cur.review_url} placeholder="https://g.page/r/your-practice/review" onChange={(e) => change({ review_url: e.target.value })} /></label>
          <label>
            Invite to post a review at
            <select value={cur.review_threshold} onChange={(e) => change({ review_threshold: Number(e.target.value) })}>
              <option value={5}>5 stars only</option><option value={4}>4 stars and up</option><option value={3}>3 stars and up</option>
            </select>
          </label>
          <label className="checkbox full"><input type="checkbox" checked={cur.review_requests} onChange={(e) => change({ review_requests: e.target.checked })} /> Automatically send review requests after visits</label>
        </div>
      </div>
      <div className="card">
        <h2>Message templates</h2>
        <p className="muted" style={{ fontSize: 13 }}>Every automatic message, in your own words. Leave one blank to use the standard wording. Texts over 160 characters are sent in parts. Patients whose language is Spanish (on their chart) get the Spanish wording.</p>
        <div className="seg" style={{ marginBottom: 10 }}>
          <button type="button" className={tplLang === 'en' ? 'active' : ''} onClick={() => setTplLang('en')}>English</button>
          <button type="button" className={tplLang === 'es' ? 'active' : ''} onClick={() => setTplLang('es')}>Español</button>
        </div>
        <div className="templates-layout">
        <div>
        {Object.entries(meta).map(([base, m]) => {
          const k = tplLang === 'es' ? `${base}_es` : base;
          const std = tplLang === 'es' ? m.es : m.text;
          const value = cur.templates[k] ?? '';
          const out = render(value || std, base === 'booking_declined' ? { reason: tplLang === 'es' ? 'Ya no tenemos espacio esa mañana.' : 'We are fully booked that morning.' } : {});
          return (
            <div key={k} className={`template-row${focus === base ? ' focused' : ''}`} onFocus={() => setFocus(base)} onClick={() => setFocus(base)}>
              <label>{m.label}{tplLang === 'es' ? ' (Spanish)' : ''}<textarea rows={2} value={value} placeholder={std} lang={tplLang} onChange={(e) => change({ templates: { ...cur.templates, [k]: e.target.value } })} /></label>
              <div className="muted" style={{ fontSize: 12 }}>
                {m.help} Uses {m.vars.map((v) => <code key={v} style={{ cursor: 'pointer' }} title="Add to the message" onClick={() => change({ templates: { ...cur.templates, [k]: `${value || std} {${v}}` } })}>{`{${v}}`}</code>).reduce((a, b) => [a, ' ', b])}
                {m.required.length > 0 && <> · must include {m.required.map((v) => `{${v}}`).join(', ')}</>}
              </div>
              <div className="sms-preview">{out}<span className="muted" style={{ float: 'right', fontSize: 11 }}>{out.length} chars{out.length > 160 ? ` · ${Math.ceil(out.length / 153)} texts` : ''}</span></div>
              {value && <button type="button" className="small" onClick={() => change({ templates: { ...cur.templates, [k]: '' } })}>Use standard wording</button>}
            </div>
          );
        })}
        </div>
        {meta[focus] && (() => {
          const m = meta[focus];
          const k = tplLang === 'es' ? `${focus}_es` : focus;
          const body = render(cur.templates[k] || (tplLang === 'es' ? m.es : m.text), focus === 'booking_declined' ? { reason: tplLang === 'es' ? 'Ya no tenemos espacio esa mañana.' : 'We are fully booked that morning.' } : {})
            + (focus === 'reminder' ? (tplLang === 'es' ? ' Responda C para confirmar, o llámenos para cambiar su cita. Responda STOP para no recibir mensajes.' : ' Reply C to confirm, or call us to reschedule. Reply STOP to opt out.') : '');
          return <PhonePreview from={practice.sms_number || practice.name} label={m.label} body={body} emailOnly={focus === 'statement'} subject={practice.name} />;
        })()}
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="form-actions">{saved && <span className="badge ok">Saved</span>}<button className="primary" disabled={busy} onClick={submit}>Save</button></div>
    </>
  );
}

// "Tue, Thu 7:00–15:00" style summary of weekly hours.
function summarizeHours(hours) {
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => (hours[d] || []).length);
  if (!days.length) return 'Not scheduled';
  const spans = new Set(days.map((d) => hours[d].map((r) => r.join('–')).join(', ')));
  return `${days.map((d) => DAYS[d].slice(0, 3)).join(', ')}${spans.size === 1 ? ` ${[...spans][0]}` : ''}`;
}

// What staff asked the assistant, what it did, how long it took and how it ended — to find the
// phrases that go wrong and see whether it's quick enough.
function AssistantLog() {
  const { practice } = useAuth();
  const { data: rows, error } = useApi('/assistant/log');
  const { data: status } = useApi('/assistant');
  const counts = (rows || []).reduce((m, r) => ({ ...m, [r.outcome]: (m[r.outcome] || 0) + 1 }), {});
  const avg = rows?.length ? rows.reduce((s, r) => s + (r.ms || 0), 0) / rows.length / 1000 : 0;
  return (
    <>
      <div className="card">
        <h2>Assistant</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          {status?.enabled ? 'On.' : 'Off — set ANTHROPIC_API_KEY on the server to turn it on.'} Staff hold the talk key (F2 unless changed on that computer) and speak;
          moving around the app is instant, other requests go to Claude. Changes are confirmed (or, for check-ins, seating and perio readings, done at once with Undo).
        </p>
        {rows?.length > 0 && (
          <p style={{ fontSize: 13 }}>
            Last {rows.length} requests · average {avg.toFixed(1)} s · {Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')}
          </p>
        )}
        <ErrorBox error={error} />
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Said</th><th>Did</th><th>Time</th><th>Outcome</th></tr></thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtUtcDateTime(r.created_at, practice?.timezone)}</td>
                  <td>{r.user_name || '—'}</td>
                  <td>{r.said}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{JSON.parse(r.tools || '[]').join(', ') || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.ms != null ? `${(r.ms / 1000).toFixed(1)} s` : ''}</td>
                  <td><span className={`badge ${{ confirmed: 'ok', done: 'ok', answered: '', asked: 'warn', cancelled: 'warn', undone: 'warn', failed: 'danger', refused: 'danger' }[r.outcome] || ''}`}>{r.outcome}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows?.length === 0 && <div className="empty">Nothing yet.</div>}
        </div>
      </div>
    </>
  );
}

// What the bridge found when it last checked its own setup (programs, folders, sensor, uploads).
function BridgeChecks({ agent }) {
  const [open, setOpen] = useState(false);
  if (!agent.checked_at) return agent.version ? <div className="muted" style={{ fontSize: 12 }}>Update the bridge for setup checks</div> : null;
  const bad = agent.checks.filter((c) => !c.ok);
  return (
    <div style={{ fontSize: 12 }}>
      <button type="button" className="link" onClick={() => setOpen(!open)} style={{ color: bad.length ? 'var(--danger)' : undefined }}>
        {bad.length ? `${bad.length} setup problem${bad.length > 1 ? 's' : ''}` : `All ${agent.checks.length} checks passed`}
      </button>
      {(open || bad.length > 0) && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
          {(open ? agent.checks : bad).map((c) => <li key={c.name} style={{ color: c.ok ? undefined : 'var(--danger)' }}>{c.ok ? '✓' : '✗'} {c.name}{!c.ok && c.note ? ` — ${c.note}` : ''}</li>)}
        </ul>
      )}
    </div>
  );
}

// Workstations running the imaging bridge (opens DEXIS/Sidexis/etc. and imports captured images).
function ImagingBridges() {
  const { practice } = useAuth();
  const { data: agents, reload } = useApi('/imaging/agents');
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null);
  const [sensorPreset, setSensorPreset] = useState('');
  const [testing, setTesting] = useState(null);
  const add = useSubmit(async () => {
    setCreated(await api.post('/imaging/agents', { name }));
    setName('');
    reload();
  });
  const config = created && JSON.stringify({
    server: window.location.origin, token: created.token,
    apps: [{ id: 'dexis', name: 'DEXIS', command: 'C:\\DEXIS\\DEXIS.exe', args: ['/P{patientId}'] }],
    watch: [{ folder: 'C:\\DEXIS\\Export', category: 'xray' }],
    ...(sensorPreset ? { sensor: { preset: sensorPreset, exposure: { kvp: 70, ma: 7 } } } : {}),
  }, null, 2);
  const download = async (path, filename, text) => {
    const blob = text ? new Blob([text], { type: 'application/json' }) : await (await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } })).blob();
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename }).click();
  };
  return (
    <>
      <div className="card">
        <h2>Imaging bridges</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Install the bridge on each operatory computer that runs imaging software (DEXIS, Sidexis, Carestream, Apteryx, VixWin…). Staff can then open the
          patient in the imaging program straight from the chart, and new x-rays and photos are filed in the patient&apos;s Documents automatically.
        </p>
        <ol className="muted" style={{ fontSize: 13, paddingLeft: 18 }}>
          <li>Add the workstation below and download its settings file.</li>
          <li>On that computer, install Node.js (18 or newer) and save the <button className="link" onClick={() => download('/imaging/agent-download', 'dental-machine-bridge.mjs')}>bridge program</button> next to the settings file.</li>
          <li>Edit the settings file with your imaging program&apos;s path and export folder (your imaging vendor&apos;s bridge guide lists the command-line options), then run <code>node dental-machine-bridge.mjs bridge-config.json</code> — or set it to start with Windows.</li>
          <li>For direct sensor capture (Tuxedo, Jazz or any TWAIN sensor): install the sensor&apos;s TWAIN driver and the free NAPS2 scanner app, choose the sensor below, then press <strong>Test sensor</strong>. <code>node dental-machine-bridge.mjs bridge-config.json --list-sensors</code> shows the sensors that PC can see.</li>
          <li>Check the setup with <code>node dental-machine-bridge.mjs bridge-config.json --check</code>. While it runs, the bridge re-checks itself every 10 minutes; problems show here and in Needs attention.</li>
        </ol>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); add.submit(); }} style={{ gap: 8 }}>
          <input placeholder='Workstation name, e.g. "Op 2"' value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} />
          <select aria-label="Sensor" value={sensorPreset} onChange={(e) => setSensorPreset(e.target.value)} style={{ width: 'auto' }}>
            <option value="">No sensor on this PC</option>
            <option value="tuxedo">Tuxedo sensor</option>
            <option value="jazz">Jazz sensor</option>
            <option value="twain">Other TWAIN sensor</option>
          </select>
          <button className="primary" disabled={!name.trim() || add.busy}>Add workstation</button>
        </form>
        <ErrorBox error={add.error} />
        {created && (
          <div className="public-notice ok" style={{ marginTop: 12 }}>
            <strong>{created.name} added.</strong> Its key is shown only once — download the settings file now.
            <div style={{ marginTop: 8 }}><button className="small primary" onClick={() => download(null, 'bridge-config.json', config)}>Download bridge-config.json</button></div>
          </div>
        )}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Workstation</th><th>Status</th><th>Computer</th><th>Imaging programs</th><th>Sensor</th><th>Last seen</th><th /></tr></thead>
            <tbody>
              {agents?.map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.name}</strong></td>
                  <td>
                    <span className={`live-dot${a.online ? ' on' : ''}`}>{a.online ? 'Online' : 'Offline'}</span>
                    <BridgeChecks agent={a} />
                  </td>
                  <td>{a.hostname || '—'}{a.version ? <span className="muted"> · v{a.version}</span> : ''}</td>
                  <td>{a.apps.map((x) => x.name).join(', ') || <span className="muted">—</span>}</td>
                  <td>
                    {a.sensor || <span className="muted">—</span>}
                    {a.sensor_info?.exposure && <div className="muted" style={{ fontSize: 12 }}>{[a.sensor_info.exposure.kvp && `${a.sensor_info.exposure.kvp} kVp`, a.sensor_info.exposure.ma && `${a.sensor_info.exposure.ma} mA`].filter(Boolean).join(' · ')}</div>}
                  </td>
                  <td>{a.last_seen_at ? fmtUtcDateTime(a.last_seen_at, practice?.timezone) : 'Never'}</td>
                  <td className="inline" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    {a.sensor && <button className="small" disabled={!a.online} onClick={() => setTesting(a)} title={a.online ? 'Take one test exposure' : 'The bridge is offline'}>Test sensor</button>}
                    <button className="small danger" onClick={() => confirm(`Remove ${a.name}? Its bridge will stop working.`) && api.del(`/imaging/agents/${a.id}`).then(reload)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {agents?.length === 0 && <div className="empty">No workstations yet.</div>}
        </div>
      </div>
      {testing && <SensorTest agent={testing} onClose={() => setTesting(null)} />}
    </>
  );
}

const SSO_HELP = {
  google: 'Google Cloud console → APIs & Services → Credentials → Create OAuth client ID (Web application).',
  microsoft: 'Azure portal → Microsoft Entra ID → App registrations → New registration (Web). Create a client secret under Certificates & secrets.',
  oidc: 'Create an OpenID Connect web application in your identity provider (Okta, Auth0, Keycloak, JumpCloud…).',
};

// Staff sign-in through Google Workspace, Microsoft 365 or another OpenID Connect provider.
function SingleSignOn() {
  const { data, reload } = useApi('/practice/sso');
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const cur = form || (data && { provider: data.provider || '', tenant: data.tenant || '', issuer: data.issuer || '', client_id: data.client_id || '', client_secret: '', domain: data.domain || '', sso_only: data.sso_only });
  const { submit, busy, error } = useSubmit(async () => {
    await api.put('/practice/sso', { ...cur, provider: cur.provider || null });
    setForm(null);
    setSaved(true);
    reload();
  });
  const [linkErr, setLinkErr] = useState(null);
  const linkMine = async () => {
    setLinkErr(null);
    try {
      window.location.assign((await api.post('/auth/sso/link')).url);
    } catch (e) {
      setLinkErr(e);
    }
  };
  if (!cur) return null;
  const set = (k) => (e) => { setSaved(false); setForm({ ...cur, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }); };
  return (
    <div className="card">
      <h2>Single sign-on</h2>
      <p className="muted" style={{ fontSize: 13 }}>Let staff sign in with their work Google or Microsoft account (or another identity provider). Their email must match a user here; turning off someone&apos;s work account ends their access.</p>
      <div className="form-grid">
        <label>
          Identity provider
          <select value={cur.provider} onChange={set('provider')}>
            <option value="">Off — passwords only</option>
            <option value="google">Google Workspace</option>
            <option value="microsoft">Microsoft 365 / Entra ID</option>
            <option value="oidc">Other (OpenID Connect)</option>
          </select>
        </label>
        {cur.provider && (
          <>
            {cur.provider === 'microsoft' && <label>Tenant ID<input value={cur.tenant} onChange={set('tenant')} placeholder="00000000-0000-0000-0000-000000000000" /></label>}
            {cur.provider === 'oidc' && <label>Issuer URL<input value={cur.issuer} onChange={set('issuer')} placeholder="https://yourcompany.okta.com" /></label>}
            <label>Client ID<input value={cur.client_id} onChange={set('client_id')} /></label>
            <label>Client secret<input type="password" value={cur.client_secret} onChange={set('client_secret')} placeholder={data.has_secret ? 'Saved — leave blank to keep' : ''} autoComplete="new-password" /></label>
            <label>Allowed email domain (optional)<input value={cur.domain} onChange={set('domain')} placeholder="brightsmiles.com" /></label>
            <label className="checkbox full"><input type="checkbox" checked={!!cur.sso_only} onChange={set('sso_only')} /> Require single sign-on (passwords stop working for everyone except administrators)</label>
            <div className="full muted" style={{ fontSize: 12 }}>
              {SSO_HELP[cur.provider]} Add this redirect URI: <code>{data.redirect_uri}</code>
            </div>
          </>
        )}
      </div>
      {data.provider && data.has_secret && (
        <div className="notice" style={{ marginTop: 12 }}>
          {data.linked
            ? <>✓ Your account is linked — you can sign in with {SSO_NAMES[data.provider]}.</>
            : <>Administrators link their own sign-in once (staff are linked automatically the first time they use it). <button className="small" onClick={linkMine}>Link my account</button></>}
        </div>
      )}
      <ErrorBox error={error || linkErr} />
      <div className="form-actions">{saved && <span className="badge ok">Saved</span>}<button className="primary" disabled={busy} onClick={submit}>Save sign-in settings</button></div>
    </div>
  );
}
const SSO_NAMES = { google: 'Google', microsoft: 'Microsoft', oidc: 'single sign-on' };

// Everything this deployment connects to, with what each does and how to turn it on.
function Integrations() {
  const { data: d } = useApi('/integrations');
  if (!d) return <div className="empty">Loading…</div>;
  const on = (label) => ['ok', label];
  const sandbox = (label = 'Sandbox') => ['info', label];
  const off = (label = 'Not set up') => ['warn', label];
  const items = [
    ['💬', 'Text messages', d.sms === 'log' ? off('Logged only') : on('Twilio'), 'Reminders, two-way texting, recall and review requests.', 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM'],
    ['✉️', 'Email', d.email === 'log' ? off('Logged only') : on('SendGrid'), 'Reminders, statements, forms and portal sign-in codes.', 'SENDGRID_API_KEY, EMAIL_FROM'],
    ['💳', 'Card payments & autopay', d.payments === 'stripe' ? on('Stripe') : d.payments === 'sandbox' ? sandbox('Sandbox (test cards)') : off(), 'Text-to-pay, portal payments, card readers at the desk, cards on file and payment-plan autopay.', 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET'],
    ['🧾', 'Clearinghouse', d.clearinghouse.mode === 'sftp' ? on(d.clearinghouse.name) : d.clearinghouse.mode === 'sandbox' ? sandbox() : off('Manual upload'), `Claims sent automatically; acknowledgments, claim status and ERAs posted for you.${d.clearinghouse.realtime ? ' Real-time eligibility and claim status are on.' : ''}`, 'CLEARINGHOUSE=sftp, CH_SFTP_*, CH_REALTIME_URL'],
    ['℞', 'E-prescribing', d.erx.mode === 'dosespot' ? on('DoseSpot') : d.erx.mode === 'sandbox' ? sandbox() : off('Printed Rx only'), 'Send prescriptions to the pharmacy, including controlled substances (EPCS).', 'ERX=dosespot, ERX_DOSESPOT_CLINIC_ID, ERX_DOSESPOT_CLINIC_KEY'],
    ['📮', 'Mailed statements', d.mail.mode === 'lob' ? on('Lob') : d.mail.mode === 'log' ? sandbox('Logged only') : off('Printed at the office'), 'Statements for accounts without email are printed and mailed for you.', 'MAIL_DRIVER=lob, LOB_API_KEY'],
    ['🩻', 'Imaging bridges', d.imaging.workstations ? (d.imaging.online ? on(`${d.imaging.online} of ${d.imaging.workstations} online`) : off(`${d.imaging.workstations} offline`)) : off(), 'Open DEXIS/Sidexis/etc. from the chart; captured images file themselves.', null, 'imaging'],
    ['🔐', 'Single sign-on', d.sso.provider ? on(`${{ google: 'Google', microsoft: 'Microsoft', oidc: 'OpenID Connect' }[d.sso.provider]}${d.sso.required ? ' (required)' : ''}`) : off('Passwords'), 'Staff sign in with their work Google or Microsoft account.', null, 'practice'],
    ['🌐', 'Patient portal', d.portal.enabled ? on('On') : off('Off'), <>Patients see visits, pay, and complete forms at <a href={d.portal.url} target="_blank" rel="noreferrer">{d.portal.url}</a>.</>, null, 'practice'],
    ['📅', 'Online booking', d.booking.enabled ? on('On') : off('Off'), d.booking.url ? <>Booking page: <a href={d.booking.url} target="_blank" rel="noreferrer">{d.booking.url}</a></> : 'Choose a booking page address to turn it on.', null, 'practice'],
  ];
  return (
    <>
      <div className="integration-grid">
        {items.map(([icon, name, [tone, status], what, env, tab]) => (
          <div key={name} className="card integration">
            <div className="integration-head"><span className="integration-icon">{icon}</span><strong>{name}</strong><span className={`badge nocap ${tone}`}>{status}</span></div>
            <div className="muted" style={{ fontSize: 13 }}>{what}</div>
            {env && tone !== 'ok' && <div className="integration-env">Server settings: <code>{env}</code></div>}
            {tab && <Link to={`/settings?tab=${tab}`} className="integration-link">Configure →</Link>}
          </div>
        ))}
      </div>
      <CardReaderSettings />
      <XrayAiSetting />
      <div className="card">
        <h2>Platform</h2>
        <dl className="kv">
          <dt>Database</dt><dd>{d.platform.database === 'postgres' ? 'PostgreSQL' : 'SQLite (single server)'}</dd>
          <dt>Servers</dt><dd>{d.platform.cluster === 'redis' ? 'Several, coordinated through Redis' : 'Single server'}</dd>
          <dt>Documents</dt><dd>{d.platform.storage === 's3' ? 'S3-compatible object storage' : 'Server disk'}{d.platform.encrypted ? ', encrypted (AES-256-GCM)' : ' — not encrypted: set DOCUMENT_ENCRYPTION_KEY'}</dd>
          <dt>Web address</dt><dd>{d.app_url}</dd>
        </dl>
      </div>
    </>
  );
}

// Vacations, days off and one-off hours: the schedule shades them and booking warns.
function TimeOff({ canWrite }) {
  const providers = useLookup('/providers?active=true');
  const [providerId, setProviderId] = useState('');
  const pid = providerId || providers[0]?.id;
  const { data: list, reload } = useApi(pid ? `/providers/${pid}/exceptions` : null);
  const today = new Date().toLocaleDateString('en-CA');
  const [form, setForm] = useState({ from: today, to: today, off: true, open: '08:00', close: '12:00', reason: '' });
  const [result, setResult] = useState(null);
  const { submit, busy, error } = useSubmit(async () => {
    setResult(await api.post(`/providers/${pid}/exceptions`, { from: form.from, to: form.to || form.from, off: form.off, hours: form.off ? [] : [[form.open, form.close]], reason: form.reason || null }));
    reload();
  });
  const remove = async (id) => { await api.del(`/provider-exceptions/${id}`); reload(); };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  if (!providers.length) return null;
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Time off & special hours</h2>
        <select aria-label="Provider" value={pid || ''} onChange={(e) => { setProviderId(e.target.value); setResult(null); }} style={{ width: 'auto' }}>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Vacations, CE days and one-off schedule changes. The calendar shades them and booking into them needs a deliberate override.</p>
      {canWrite && (
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <label>From<input type="date" required value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value, to: form.to < e.target.value ? e.target.value : form.to })} /></label>
          <label>To<input type="date" value={form.to} min={form.from} onChange={set('to')} /></label>
          <label>
            That day
            <select value={form.off ? 'off' : 'hours'} onChange={(e) => setForm({ ...form, off: e.target.value === 'off' })}>
              <option value="off">Off all day</option>
              <option value="hours">Working different hours</option>
            </select>
          </label>
          {!form.off && (
            <label>Hours<span className="inline"><input type="time" aria-label="Opens" value={form.open} onChange={set('open')} /> – <input type="time" aria-label="Closes" value={form.close} onChange={set('close')} /></span></label>
          )}
          <label>Reason<input value={form.reason} onChange={set('reason')} placeholder="Vacation, CE course…" /></label>
          <div style={{ alignSelf: 'end' }}><button className="primary" disabled={busy}>Save</button></div>
        </form>
      )}
      <ErrorBox error={error} />
      {result?.conflicts?.length > 0 && (
        <div className="error" style={{ marginTop: 10 }}>
          {result.conflicts.length} booked visit{result.conflicts.length === 1 ? ' falls' : 's fall'} in that time and need{result.conflicts.length === 1 ? 's' : ''} moving:
          {result.conflicts.map((a) => <div key={a.id}>{fmtDateTime(a.start_time)} — {a.first_name} {a.last_name}</div>)}
        </div>
      )}
      {list?.length ? (
        <table style={{ marginTop: 12 }}>
          <tbody>
            {list.map((x) => {
              const hours = JSON.parse(x.hours);
              return (
                <tr key={x.id}>
                  <td>{new Date(`${x.date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td>{hours.length ? hours.map(([o, c]) => `${o}–${c}`).join(', ') : <span className="badge warn">Off</span>}</td>
                  <td className="muted">{x.reason}</td>
                  <td>{canWrite && <button className="small" onClick={() => remove(x.id)}>Remove</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <div className="muted" style={{ marginTop: 10 }}>Nothing coming up.</div>}
    </div>
  );
}

// A phone showing how a text arrives (or an inbox, for email-only messages), with the sample details filled in.
function PhonePreview({ from, label, body, emailOnly, subject }) {
  const links = (text) => text.split(/(https?:\/\/\S+)/).map((part, i) => (/^https?:/.test(part) ? <u key={i}>{part}</u> : part));
  return (
    <aside className="phone-preview" aria-label={`Preview: ${label}`}>
      <div className="phone-frame">
        <div className="phone-notch" />
        <div className="phone-top"><span className="phone-avatar">{String(from).replace(/[^A-Za-z]/g, '').slice(0, 1) || '#'}</span><div><strong>{from}</strong><div className="muted">{emailOnly ? 'Email' : 'Text message'}</div></div></div>
        <div className="phone-screen">
          <div className="phone-time">Today 9:41 AM</div>
          {emailOnly
            ? <div className="phone-email"><strong>{subject}</strong><p>{links(body)}</p></div>
            : <div className="phone-bubble">{links(body)}</div>}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 6 }}>{label} · {body.length} characters{!emailOnly && body.length > 160 ? ` · sent as ${Math.ceil(body.length / 153)} texts` : ''}</div>
    </aside>
  );
}

// AI x-ray reading: whether new x-rays are read automatically as they arrive.
function XrayAiSetting() {
  const { data: ai } = useApi('/xray-ai');
  const { data: practice, reload } = useApi('/practice');
  const [err, setErr] = useState(null);
  if (!ai || !practice) return null;
  return (
    <div className="card">
      <h2>AI x-ray reading</h2>
      <ErrorBox error={err} />
      {ai.enabled ? (
        <>
          <div className="muted" style={{ fontSize: 13 }}>Engine: {ai.label || ai.mode}{ai.cleared ? ' (FDA-cleared)' : ' — decision support, not FDA-cleared: the dentist confirms every finding'}.</div>
          <label className="checkbox" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={!!practice.xray_ai_auto} onChange={async (e) => { setErr(null); try { await api.put('/practice', { xray_ai_auto: e.target.checked }); reload(); } catch (x) { setErr(x); } }} />
            Read new x-rays automatically when they’re captured or uploaded
          </label>
        </>
      ) : <div className="muted" style={{ fontSize: 13 }}>Off on this server. Set XRAY_AI=vendor (with XRAY_AI_URL, XRAY_AI_KEY) for an FDA-cleared service, or XRAY_AI=claude.</div>}
    </div>
  );
}

const AUDIT_SOURCES = { human: 'A person', ai: 'AI', automation: 'Automation', api: 'API', import: 'Import', integration: 'Outside service', patient: 'Patient' };
// Before → after for each changed field (or the values set, for something new).
function Changes({ json }) {
  if (!json) return null;
  let c;
  try { c = JSON.parse(json); } catch { return null; }
  return (
    <div>
      {Object.entries(c).slice(0, 12).map(([k, v]) => (
        <div key={k}><span className="muted">{k.replace(/_/g, ' ')}:</span> {Array.isArray(v) ? <><s className="muted">{v[0] == null || v[0] === '' ? '∅' : String(v[0]).slice(0, 60)}</s> → {v[1] == null || v[1] === '' ? '∅' : String(v[1]).slice(0, 60)}</> : String(v ?? '∅').slice(0, 60)}</div>
      ))}
    </div>
  );
}
