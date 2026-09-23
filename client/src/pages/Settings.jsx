import { useState } from 'react';
import { api } from '../api.js';
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
    fields: [['name', 'Name', 'text'], ['type', 'Type', 'select', ['dentist', 'hygienist', 'specialist']], ['npi', 'NPI (10 digits)', 'text'], ['license_number', 'License #', 'text'], ['color', 'Schedule color', 'color'], ['active', 'Active', 'checkbox']],
  },
  operatories: { title: 'Operatories', path: '/operatories', columns: ['name'], fields: [['name', 'Name', 'text'], ['active', 'Active', 'checkbox']] },
  codes: {
    title: 'Fee schedule', path: '/procedure-codes', columns: ['code', 'description', 'category', 'fee'],
    fields: [['code', 'Code', 'text'], ['description', 'Description', 'text'], ['category', 'Category', 'select', CATEGORIES], ['fee', 'Fee ($)', 'money'], ['requires_tooth', 'Requires tooth', 'checkbox'], ['requires_surface', 'Requires surfaces', 'checkbox'], ['active', 'Active', 'checkbox']],
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
    ['carriers', 'Insurance carriers', can('billing:read')],
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
      {tab === 'audit' && <AuditLog />}
    </>
  );
}

function Account() {
  return (
    <div className="grid grid-2">
      <PasswordCard />
      <TwoFactorCard />
    </div>
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
          <label className="checkbox full"><input type="checkbox" checked={!!current.require_mfa} onChange={(e) => change('require_mfa', e.target.checked)} /> Require two-factor authentication for all staff</label>
        </div>
        <MessagingStatus />
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
    return [name, row[name] ?? ''];
  })));
  const { submit, busy, error } = useSubmit(async () => {
    const body = Object.fromEntries(spec.fields.map(([name, , type]) => [name, type === 'money' ? toCents(form[name] || 0) : form[name]]));
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
          return <label key={name}>{text}<input type={type === 'money' ? 'number' : type} step={type === 'money' ? '0.01' : undefined} value={form[name]} onChange={(e) => set(e.target.value)} /></label>;
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
