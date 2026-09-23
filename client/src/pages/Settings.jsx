import { useState } from 'react';
import { api } from '../api.js';
import { useApi, invalidateLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fmtDateTime, label, toCents, fromCents } from '../format.js';
import { ErrorBox, Modal, useSubmit } from '../components/ui.jsx';

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
  const [form, setForm] = useState({ current_password: '', new_password: '' });
  const [ok, setOk] = useState(false);
  const { submit, busy, error } = useSubmit(async () => {
    await api.post('/auth/change-password', form);
    setForm({ current_password: '', new_password: '' });
    setOk(true);
  });
  return (
    <div className="card" style={{ maxWidth: 480 }}>
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
  const f = (k, t) => <label>{t}<input value={current[k] || ''} onChange={(e) => { setSaved(false); setForm({ ...current, [k]: e.target.value }); }} /></label>;
  return (
    <div className="card">
      <ErrorBox error={error} />
      <div className="form-grid">
        {f('name', 'Practice name')}{f('phone', 'Phone')}{f('email', 'Email')}
        {f('address', 'Address')}{f('city', 'City')}{f('state', 'State')}{f('zip', 'ZIP')}
        {f('npi', 'Group NPI')}{f('tax_id', 'Tax ID')}{f('timezone', 'Time zone (IANA, e.g. America/Chicago)')}
      </div>
      <div className="form-actions">
        {saved && <span className="badge ok">Saved</span>}
        <button className="primary" disabled={busy} onClick={submit}>Save</button>
      </div>
    </div>
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
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th /></tr></thead>
        <tbody>
          {users?.map((u) => (
            <tr key={u.id}>
              <td>{u.name}{u.id === me.id && <span className="muted"> (you)</span>}</td>
              <td>{u.email}</td>
              <td>{label(u.role)}</td>
              <td><span className={`badge ${u.active ? 'ok' : 'danger'}`}>{u.active ? 'Active' : 'Disabled'}</span></td>
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
