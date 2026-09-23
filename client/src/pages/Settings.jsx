import { useState } from 'react';
import { api, getToken } from '../api.js';
import { useApi, invalidateLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDateTime, label, toCents, fromCents } from '../format.js';
import { ErrorBox, Modal, useSubmit } from '../components/ui.jsx';
import MfaSetup from '../components/MfaSetup.jsx';

const ROLES = ['admin', 'dentist', 'hygienist', 'assistant', 'front_desk', 'billing'];
const CATEGORIES = ['diagnostic', 'preventive', 'restorative', 'endodontics', 'periodontics', 'prosthodontics', 'oral_surgery', 'orthodontics', 'implants', 'adjunctive'];

// Field specs: [name, label, type, options]
const RESOURCES = {
  providers: {
    title: 'Providers', path: '/providers', columns: ['name', 'type', 'npi', 'color'],
    fields: [['name', 'Name', 'text'], ['type', 'Type', 'select', ['dentist', 'hygienist', 'specialist']], ['npi', 'NPI (10 digits)', 'text'], ['license_number', 'License #', 'text'], ['dea_number', 'DEA # (for printed Rx)', 'text'], ['color', 'Schedule color', 'color'], ['active', 'Active', 'checkbox']],
  },
  operatories: { title: 'Operatories', path: '/operatories', columns: ['name'], fields: [['name', 'Name', 'text'], ['active', 'Active', 'checkbox']] },
  codes: {
    title: 'Fee schedule', path: '/procedure-codes', columns: ['code', 'description', 'category', 'fee'],
    fields: [['code', 'Code', 'text'], ['description', 'Description', 'text'], ['category', 'Category', 'select', CATEGORIES], ['fee', 'Fee ($)', 'money'], ['requires_tooth', 'Requires tooth', 'checkbox'], ['requires_surface', 'Requires surfaces', 'checkbox'], ['active', 'Active', 'checkbox']],
  },
  types: {
    title: 'Appointment types', path: '/appointment-types', columns: ['name', 'duration', 'color', 'procedure_codes', 'online_bookable'],
    fields: [['name', 'Name', 'text'], ['duration', 'Length (minutes)', 'number'], ['color', 'Calendar color', 'color'], ['procedure_codes', 'Procedures added when booked (e.g. D0120, D1110)', 'codes'],
      ['provider_type', 'Usually booked with', 'select', ['dentist', 'hygienist', 'specialist']], ['online_bookable', 'Patients can book online', 'checkbox'], ['sort', 'Sort order', 'number'], ['active', 'Active', 'checkbox']],
  },
  carriers: {
    title: 'Insurance carriers', path: '/carriers', columns: ['name', 'payer_id', 'phone'], writePerm: 'billing:write',
    fields: [['name', 'Name', 'text'], ['payer_id', 'Payer ID', 'text'], ['phone', 'Phone', 'text'], ['address', 'Claims address', 'text'], ['active', 'Active', 'checkbox']],
  },
};

export default function Settings() {
  const { user, can } = useAuth();
  const admin = user.role === 'admin';
  const tabs = [
    ['account', 'My account', true],
    ['practice', 'Practice', admin],
    ['users', 'Users', admin],
    ['providers', 'Providers', true],
    ['operatories', 'Operatories', true],
    ['codes', 'Fee schedule', true],
    ['types', 'Appointment types', true],
    ['carriers', 'Insurance carriers', can('billing:read')],
    ['ppo', 'PPO fee schedules', can('billing:read')],
    ['messaging', 'Messages & reviews', admin],
    ['audit', 'Audit log', admin],
  ].filter((t) => t[2]);
  const [tab, setTab] = useState(admin ? 'practice' : 'account');

  return (
    <>
      <div className="page-header"><h1>Settings</h1></div>
      <div className="tabs">{tabs.map(([k, t]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{t}</button>)}</div>
      {tab === 'account' && <Account />}
      {tab === 'practice' && <Practice />}
      {tab === 'users' && <Users />}
      {RESOURCES[tab] && <ResourceTable key={tab} spec={RESOURCES[tab]} canWrite={RESOURCES[tab].writePerm ? can(RESOURCES[tab].writePerm) : admin} />}
      {tab === 'ppo' && <FeeSchedules admin={admin} />}
      {tab === 'messaging' && <Messaging />}
      {tab === 'audit' && <AuditLog />}
    </>
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
  const { user, refresh } = useAuth();
  const [mode, setMode] = useState(null);
  const [password, setPassword] = useState('');
  const disable = useSubmit(async () => {
    await api.post('/auth/mfa/disable', { password });
    setMode(null);
    setPassword('');
    refresh();
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
  const [form, setForm] = useState({ current_password: '', new_password: '' });
  const [ok, setOk] = useState(false);
  const { submit, busy, error } = useSubmit(async () => {
    await api.post('/auth/change-password', form);
    setForm({ current_password: '', new_password: '' });
    setOk(true);
  });
  return (
    <div className="card">
      <h2>Change password</h2>
      <ErrorBox error={error} />
      {ok && <div className="badge ok" style={{ marginBottom: 10 }}>Password updated</div>}
      <form onSubmit={(e) => { e.preventDefault(); setOk(false); submit(); }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label>Current password<input type="password" required value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} /></label>
        <label>New password (min 10 characters)<input type="password" required minLength={10} value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} /></label>
        <div><button className="primary" disabled={busy}>Update password</button></div>
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
        <MessagingStatus />
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
        <Modal title={editing.id ? `Edit ${spec.title.toLowerCase()}` : `Add to ${spec.title.toLowerCase()}`} onClose={() => setEditing(null)}>
          <ResourceForm spec={spec} row={editing} onDone={done} />
        </Modal>
      )}
    </div>
  );
}

function ResourceForm({ spec, row, onDone }) {
  const [form, setForm] = useState(() => Object.fromEntries(spec.fields.map(([name, , type]) => {
    if (type === 'checkbox') return [name, row.id ? !!row[name] : name === 'active'];
    if (type === 'money') return [name, row.id ? fromCents(row[name]) : ''];
    if (type === 'color') return [name, row[name] || '#3b82f6'];
    if (type === 'codes') return [name, row[name] ? JSON.parse(row[name]).join(', ') : ''];
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
          if (type === 'select') return <label key={name}>{text}<select value={form[name]} onChange={(e) => set(e.target.value)}><option value="">—</option>{options.map((o) => <option key={o} value={o}>{label(o)}</option>)}</select></label>;
          return <label key={name} className={type === 'codes' ? 'full' : ''}>{text}<input type={type === 'money' || type === 'number' ? 'number' : type === 'codes' ? 'text' : type} step={type === 'money' ? '0.01' : undefined} value={form[name]} onChange={(e) => set(e.target.value)} /></label>;
        })}
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Save</button></div>
    </form>
  );
}

function AuditLog() {
  const { data: rows } = useApi('/audit-log?limit=300');
  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: '14px 16px' }}>
        <h2 style={{ margin: 0 }}>Audit log</h2>
        <div className="muted">Every access to and change of patient information is recorded here (HIPAA §164.312(b)).</div>
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
      </div>
    </div>
  );
}

function MessagingStatus() {
  const { data } = useApi('/messaging/status');
  const { data: pay } = useApi('/payments/config');
  if (!data) return null;
  const row = (name, on, hint) => (
    <li>{name}: {on ? <span className="badge ok">Connected</span> : <span className="badge warn">Not configured</span>} {!on && <span className="muted">{hint}</span>}</li>
  );
  return (
    <ul style={{ marginTop: 14, lineHeight: 1.9, paddingLeft: 18 }}>
      {row('Text messages', data.sms !== 'log', 'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM on the server. Messages are logged but not sent.')}
      {row('Email', data.email !== 'log', 'Set SENDGRID_API_KEY and EMAIL_FROM on the server. Messages are logged but not sent.')}
      {row('Card payments', pay?.enabled, 'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET on the server.')}
    </ul>
  );
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULT_HOURS = { 0: [], 1: [['08:00', '17:00']], 2: [['08:00', '17:00']], 3: [['08:00', '17:00']], 4: [['08:00', '17:00']], 5: [['08:00', '17:00']], 6: [] };

// Weekly hours editor; used by the schedule shading and online booking.
function OfficeHours({ value, onChange }) {
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
      <p className="muted" style={{ fontSize: 12 }}>Closed times are shaded on the schedule and never offered for online booking. Use blocked time for lunches and one-off closures.</p>
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
