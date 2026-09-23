import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, getToken, download } from '../api.js';
import { useApi, useLookup, invalidateLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDateTime, fmtUtcDateTime, label, toCents, fromCents } from '../format.js';
import { ErrorBox, Modal, useSubmit } from '../components/ui.jsx';
import MfaSetup from '../components/MfaSetup.jsx';

const ROLES = ['admin', 'dentist', 'hygienist', 'assistant', 'front_desk', 'billing'];
const CATEGORIES = ['diagnostic', 'preventive', 'restorative', 'endodontics', 'periodontics', 'prosthodontics', 'oral_surgery', 'orthodontics', 'implants', 'adjunctive'];

// Field specs: [name, label, type, options]
const RESOURCES = {
  providers: {
    title: 'Providers', singular: 'provider', path: '/providers', columns: ['name', 'type', 'npi', 'color', 'working_hours'],
    fields: [['name', 'Name', 'text'], ['type', 'Type', 'select', ['dentist', 'hygienist', 'specialist']], ['npi', 'NPI (10 digits)', 'text'], ['license_number', 'License #', 'text'], ['dea_number', 'DEA # (controlled substances)', 'text'], ['erx_user_id', 'e-Rx user ID (DoseSpot)', 'text'], ['color', 'Schedule color', 'color'], ['active', 'Active', 'checkbox'], ['working_hours', 'Working hours', 'hours']],
  },
  operatories: { title: 'Operatories', singular: 'operatory', path: '/operatories', columns: ['name'], fields: [['name', 'Name', 'text'], ['active', 'Active', 'checkbox']] },
  codes: {
    title: 'Fee schedule', singular: 'procedure code', path: '/procedure-codes', columns: ['code', 'description', 'category', 'fee'],
    fields: [['code', 'Code', 'text'], ['description', 'Description', 'text'], ['category', 'Category', 'select', CATEGORIES], ['fee', 'Fee ($)', 'money'], ['area', 'Charted by (blank = automatic)', 'select', ['tooth', 'quadrant', 'arch', 'mouth']], ['time_units', 'Time units (10 min each)', 'number'], ['requires_tooth', 'Requires tooth', 'checkbox'], ['requires_surface', 'Requires surfaces', 'checkbox'], ['active', 'Active', 'checkbox']],
  },
  types: {
    title: 'Appointment types', singular: 'appointment type', path: '/appointment-types', columns: ['name', 'duration', 'color', 'procedure_codes', 'online_bookable'],
    fields: [['name', 'Name', 'text'], ['duration', 'Length (minutes)', 'number'], ['color', 'Calendar color', 'color'], ['procedure_codes', 'Procedures added when booked (e.g. D0120, D1110)', 'codes'],
      ['provider_type', 'Usually booked with', 'select', ['dentist', 'hygienist', 'specialist']], ['online_bookable', 'Patients can book online', 'checkbox'], ['sort', 'Sort order', 'number'], ['active', 'Active', 'checkbox']],
  },
  carriers: {
    title: 'Insurance carriers', singular: 'insurance carrier', path: '/carriers', columns: ['name', 'payer_id', 'phone'], writePerm: 'billing:write',
    fields: [['name', 'Name', 'text'], ['payer_id', 'Payer ID', 'text'], ['phone', 'Phone', 'text'], ['address', 'Claims address', 'text'], ['active', 'Active', 'checkbox']],
  },
};

export default function Settings() {
  const { user, can } = useAuth();
  const admin = user.role === 'admin';
  const groups = [
    ['You', [['account', 'My account', true]]],
    ['Practice', [['practice', 'Practice & security', admin], ['users', 'Users & roles', admin], ['providers', 'Providers', true], ['operatories', 'Operatories', true], ['types', 'Appointment types', true]]],
    ['Clinical', [['templates', 'Note templates', can('clinical:write')], ['labs', 'Labs', can('clinical:read')]]],
    ['Billing', [['codes', 'Fee schedule', true], ['ppo', 'PPO fee schedules', can('billing:read')], ['carriers', 'Insurance carriers', can('billing:read')]]],
    ['Patients', [['messaging', 'Messages & reviews', admin]]],
    ['Connections', [['integrations', 'Integrations', admin], ['imaging', 'Imaging bridges', admin]]],
    ['Compliance', [['audit', 'Audit log', admin]]],
  ].map(([g, items]) => [g, items.filter((t) => t[2])]).filter(([, items]) => items.length);
  const all = groups.flatMap(([, items]) => items);
  const [params, setParams] = useSearchParams();
  const tab = all.some((t) => t[0] === params.get('tab')) ? params.get('tab') : admin ? 'practice' : 'account';
  const setTab = (k) => setParams({ tab: k }, { replace: true });

  return (
    <>
      <div className="page-header"><h1>Settings</h1></div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {groups.map(([g, items]) => (
            <div key={g} className="settings-group">
              <div className="settings-group-title">{g}</div>
              {items.map(([k, t]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{t}</button>)}
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
      {tab === 'labs' && <Labs canWrite={can('clinical:write')} />}
      {tab === 'ppo' && <FeeSchedules admin={admin} />}
      {tab === 'messaging' && <Messaging />}
      {tab === 'imaging' && <ImagingBridges />}
      {tab === 'integrations' && <Integrations />}
      {tab === 'audit' && <AuditLog />}
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
      <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
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
          <label className="checkbox full"><input type="checkbox" checked={current.portal_enabled !== 0} onChange={(e) => change('portal_enabled', e.target.checked)} /> Patient portal (visits, balance and online payment, forms, treatment plans)</label>
          {current.portal_enabled !== 0 && <span className="muted full" style={{ fontSize: 12, marginTop: -6 }}>Portal address: {window.location.origin}/portal/{current.slug || current.id} — it&apos;s also printed on statements.</span>}
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

function Users() {
  const { user: me } = useAuth();
  const { data: users, reload } = useApi('/users');
  const [modal, setModal] = useState(null);
  return (
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
              <td>{label(u.role)}</td>
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
          <UserForm user={modal.user} onDone={() => { setModal(null); reload(); }} />
        </Modal>
      )}
    </div>
  );
}

function UserForm({ user, onDone }) {
  const [form, setForm] = useState({ name: user?.name || '', email: user?.email || '', role: user?.role || 'front_desk', active: user ? !!user.active : true, password: '' });
  const { submit, busy, error } = useSubmit(async () => {
    const body = { ...form };
    if (!body.password) delete body.password;
    if (user) await api.put(`/users/${user.id}`, body);
    else await api.post('/users', body);
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
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Save</button></div>
    </form>
  );
}

function ResourceTable({ spec, canWrite }) {
  const { data: rows, reload } = useApi(spec.path);
  const [editing, setEditing] = useState(null);
  const done = () => {
    setEditing(null);
    invalidateLookup(`${spec.path}?active=true`);
    invalidateLookup(spec.path);
    reload();
  };
  const cell = (row, col) => {
    if (col === 'fee') return money(row.fee);
    if (col === 'color') return <span className="badge" style={{ background: row.color, color: '#fff' }}>{row.color}</span>;
    if (col === 'type' || col === 'category') return label(row[col]);
    if (col === 'duration') return `${row.duration} min`;
    if (col === 'procedure_codes') return (row.procedure_codes ? JSON.parse(row.procedure_codes) : []).join(', ') || '—';
    if (col === 'online_bookable') return row.online_bookable ? 'Online' : '—';
    if (col === 'working_hours') return row.working_hours ? summarizeHours(JSON.parse(row.working_hours)) : 'Office hours';
    return row[col] ?? '—';
  };
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="page-header" style={{ padding: '14px 16px', marginBottom: 0 }}>
        <h2 style={{ margin: 0 }}>{spec.title}</h2>
        {canWrite && <button className="primary" onClick={() => setEditing({})}>+ Add</button>}
      </div>
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

function ResourceForm({ spec, row, onDone }) {
  const { data: practice } = useApi(spec.fields.some((f) => f[2] === 'hours') ? '/practice' : null);
  const practiceHours = practice?.office_hours ? JSON.parse(practice.office_hours) : DEFAULT_HOURS;
  const [form, setForm] = useState(() => Object.fromEntries(spec.fields.map(([name, , type]) => {
    if (type === 'checkbox') return [name, row.id ? !!row[name] : name === 'active'];
    if (type === 'money') return [name, row.id ? fromCents(row[name]) : ''];
    if (type === 'color') return [name, row[name] || '#3b82f6'];
    if (type === 'codes') return [name, row[name] ? JSON.parse(row[name]).join(', ') : ''];
    if (type === 'hours') return [name, row[name] ? JSON.parse(row[name]) : null];
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
                <input type="checkbox" checked={!form[name]} onChange={(e) => set(e.target.checked ? null : practiceHours)} /> Same as office hours
              </label>
              {form[name] && <OfficeHours value={form[name]} onChange={set} note="Outside these hours the provider's column is shaded, online booking won't offer them, and staff are asked before booking." />}
            </div>
          );
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
  const [filters, setFilters] = useState({ from: '', to: '', user_id: '', action: '', patient_id: params.get('patient_id') || '' });
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
          <button className="primary">Search</button>
          <button type="button" onClick={() => download(`/audit-log?${qs({ format: 'csv' })}`, 'audit-log.csv').catch(setErr)}>⬇ Export CSV</button>
        </form>
        <ErrorBox error={err} />
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When (UTC)</th><th>User</th><th>Action</th><th>Record</th><th>IP</th><th>Details</th></tr></thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{r.created_at}</td>
                <td>{r.user_name || '—'}</td>
                <td><code>{r.action}</code></td>
                <td>{r.entity ? `${r.entity} #${r.entity_id}` : ''}</td>
                <td className="muted">{r.ip}</td>
                <td className="muted" style={{ fontSize: 12 }}>{r.details}</td>
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
                <input type="time" value={o} step={900} onChange={(e) => setDay(d, ranges.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
                <span>–</span>
                <input type="time" value={c} step={900} onChange={(e) => setDay(d, ranges.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
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

// PPO fee schedules: contracted allowed fees per carrier, which drive write-offs and patient estimates.
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
        <p className="muted" style={{ fontSize: 13 }}>In-network (PPO) plans pay from their contracted fee, not your office fee. The difference is written off and patient estimates use the contracted fee.</p>
        {list?.map((f) => (
          <button key={f.id} className={`list-item${current?.id === f.id ? ' active' : ''}`} onClick={() => setSel(f.id)}>
            <strong>{f.name}</strong>
            <div className="muted" style={{ fontSize: 12 }}>{f.items.length} codes · {f.carriers.map((c) => c.name).join(', ') || 'no carriers'}</div>
          </button>
        ))}
        {list?.length === 0 && <div className="muted">None yet — all carriers are paid from office fees.</div>}
        {admin && <button className="primary" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>+ New fee schedule</button>}
      </div>
      {current && codes && carriers && <FeeScheduleEditor key={current.id} fs={current} codes={codes} carriers={carriers} admin={admin} onSaved={reload} />}
      {creating && (
        <Modal title="New PPO fee schedule" onClose={() => setCreating(false)}>
          <NewFeeSchedule onDone={(fs) => { setCreating(false); reload(); setSel(fs.id); }} />
        </Modal>
      )}
    </div>
  );
}

function NewFeeSchedule({ onDone }) {
  const [form, setForm] = useState({ name: '', percent_of_ucr: 80 });
  const { submit, busy, error } = useSubmit(async () => onDone(await api.post('/fee-schedules', form)));
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label className="full">Name<input required value={form.name} placeholder="e.g. Delta Dental PPO 2026" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
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
      <div style={{ marginBottom: 12 }}>
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
          <thead><tr><th>Code</th><th>Description</th><th className="num">Office fee</th><th className="num">Contracted</th><th className="num">Write-off</th></tr></thead>
          <tbody>
            {shown.map((c) => {
              const v = fees[c.code];
              const wo = v !== '' && v != null ? c.fee - toCents(v) : null;
              return (
                <tr key={c.code}>
                  <td>{c.code}</td><td>{c.description}</td><td className="num">{money(c.fee)}</td>
                  <td className="num"><input className="fee-input" type="number" min="0" step="0.01" disabled={!admin} value={v ?? ''} placeholder="office fee" onChange={(e) => { setSaved(false); setFees({ ...fees, [c.code]: e.target.value }); }} /></td>
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

const TEMPLATE_INFO = {
  reminder: ['Appointment reminder', 'Sent before each appointment. Must include {link} (the confirm page).'],
  booking_confirmation: ['Booking confirmation', 'Sent when a patient books online or the office books them.'],
  recall: ['Recall reminder', 'Sent from the recall list and recall campaigns.'],
  review: ['Review request', 'Sent after a completed visit when review requests are on. Must include {link}.'],
};

// Message templates and the Google review request program.
function Messaging() {
  const { data: practice } = useApi('/practice');
  const { data: defaults } = useApi('/message-templates/defaults');
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const { refresh } = useAuth();
  const { submit, busy, error } = useSubmit(async () => {
    await api.put('/practice', { review_url: form.review_url || null, review_requests: form.review_requests, message_templates: form.templates });
    setSaved(true);
    refresh();
  });
  if (!practice || !defaults) return null;
  const cur = form || { review_url: practice.review_url || '', review_requests: !!practice.review_requests, templates: JSON.parse(practice.message_templates || '{}') };
  const change = (patch) => { setSaved(false); setForm({ ...cur, ...patch }); };
  const sample = { first_name: 'Maria', practice: practice.name, when: 'Tue, Oct 6 at 9:00 AM', provider: 'Dr. Chen', link: 'https://…/c/abc123', phone: practice.phone || '' };
  const render = (t) => t.replace(/\{(\w+)\}/g, (_, k) => sample[k] ?? '');
  return (
    <>
      <div className="card">
        <h2>Online reviews</h2>
        <p className="muted" style={{ fontSize: 13 }}>After a completed visit, patients get one friendly text asking for a review (at most once every 6 months). More 5-star reviews means more new patients.</p>
        <div className="form-grid">
          <label className="full">Review link (Google, Yelp…)<input value={cur.review_url} placeholder="https://g.page/r/your-practice/review" onChange={(e) => change({ review_url: e.target.value })} /></label>
          <label className="checkbox full"><input type="checkbox" checked={cur.review_requests} onChange={(e) => change({ review_requests: e.target.checked })} /> Automatically send review requests after visits</label>
        </div>
      </div>
      <div className="card">
        <h2>Message templates</h2>
        <p className="muted" style={{ fontSize: 13 }}>Placeholders: <code>{'{first_name}'}</code> <code>{'{practice}'}</code> <code>{'{when}'}</code> <code>{'{provider}'}</code> <code>{'{link}'}</code> <code>{'{phone}'}</code>. Leave blank to use the default.</p>
        {Object.entries(TEMPLATE_INFO).map(([k, [title, help]]) => {
          const value = cur.templates[k] ?? '';
          return (
            <div key={k} className="template-row">
              <label>{title}<textarea rows={2} value={value} placeholder={defaults[k]} onChange={(e) => change({ templates: { ...cur.templates, [k]: e.target.value } })} /></label>
              <div className="muted" style={{ fontSize: 12 }}>{help}</div>
              <div className="sms-preview">{render(value || defaults[k])}</div>
            </div>
          );
        })}
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

// Workstations running the imaging bridge (opens DEXIS/Sidexis/etc. and imports captured images).
function ImagingBridges() {
  const { practice } = useAuth();
  const { data: agents, reload } = useApi('/imaging/agents');
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null);
  const add = useSubmit(async () => {
    setCreated(await api.post('/imaging/agents', { name }));
    setName('');
    reload();
  });
  const config = created && JSON.stringify({
    server: window.location.origin, token: created.token,
    apps: [{ id: 'dexis', name: 'DEXIS', command: 'C:\\DEXIS\\DEXIS.exe', args: ['/P{patientId}'] }],
    watch: [{ folder: 'C:\\DEXIS\\Export', category: 'xray' }],
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
        </ol>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); add.submit(); }} style={{ gap: 8 }}>
          <input placeholder='Workstation name, e.g. "Op 2"' value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} />
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
            <thead><tr><th>Workstation</th><th>Status</th><th>Computer</th><th>Imaging programs</th><th>Last seen</th><th /></tr></thead>
            <tbody>
              {agents?.map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.name}</strong></td>
                  <td><span className={`live-dot${a.online ? ' on' : ''}`}>{a.online ? 'Online' : 'Offline'}</span></td>
                  <td>{a.hostname || '—'}{a.version ? <span className="muted"> · v{a.version}</span> : ''}</td>
                  <td>{a.apps.map((x) => x.name).join(', ') || <span className="muted">—</span>}</td>
                  <td>{a.last_seen_at ? fmtUtcDateTime(a.last_seen_at, practice?.timezone) : 'Never'}</td>
                  <td><button className="small danger" onClick={() => confirm(`Remove ${a.name}? Its bridge will stop working.`) && api.del(`/imaging/agents/${a.id}`).then(reload)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {agents?.length === 0 && <div className="empty">No workstations yet.</div>}
        </div>
      </div>
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
    ['💳', 'Card payments & autopay', d.payments === 'stripe' ? on('Stripe') : d.payments === 'sandbox' ? sandbox('Sandbox (test cards)') : off(), 'Text-to-pay, portal payments, cards on file and payment-plan autopay.', 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET'],
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
        <select value={pid || ''} onChange={(e) => { setProviderId(e.target.value); setResult(null); }} style={{ width: 'auto' }}>
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
            <label>Hours<span className="inline"><input type="time" value={form.open} onChange={set('open')} /> – <input type="time" value={form.close} onChange={set('close')} /></span></label>
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
