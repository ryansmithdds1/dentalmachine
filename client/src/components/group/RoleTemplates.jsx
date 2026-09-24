import { useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { label } from '../../format.js';
import { ErrorBox, Modal, useSubmit } from '../ui.jsx';

// Group role templates (owners): define "Front desk", "Billing", "Dentist" once and give it to people at several
// practices at once. Each practice gets its own role linked to the template; every change is in that practice's log.
export default function RoleTemplates() {
  const { data, error, reload } = useApi('/org/role-templates');
  const [editing, setEditing] = useState(null);
  const [applying, setApplying] = useState(null);
  const retire = useSubmit(async (t) => { await api.post(`/org/role-templates/${t.id}/retire`); reload(); });
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading…</div>;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Role templates</h2>
        <button className="small primary" onClick={() => setEditing({ name: '', base_role: 'front_desk', permissions: [] })}>New template</button>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Set up a role once and apply it to people across your offices. Changing a template changes it everywhere it’s used, and those people sign in again.</p>
      <ErrorBox error={retire.error} />
      {data.templates.length === 0 && <div className="muted">No templates yet.</div>}
      {data.templates.map((t) => (
        <div key={t.id} className="inline" style={{ justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border)', gap: 8, flexWrap: 'wrap' }}>
          <div>
            <strong>{t.name}</strong> <span className="muted" style={{ fontSize: 12 }}>based on {label(t.base_role)} · {t.people} {t.people === 1 ? 'person' : 'people'}</span>
            <div className="muted" style={{ fontSize: 12 }}>{t.permissions.map((p) => data.catalog[p] || p).join(' · ') || 'No extra permissions'}</div>
          </div>
          <div className="inline" style={{ gap: 6 }}>
            <button className="small primary" onClick={() => setApplying(t)}>Apply to people…</button>
            <button className="small" onClick={() => setEditing(t)}>Edit</button>
            <button className="small" onClick={() => window.confirm(`Retire “${t.name}”? People keep the role it gave them.`) && retire.submit(t)}>Retire</button>
          </div>
        </div>
      ))}
      {editing && <Editor t={editing} catalog={data.catalog} baseRoles={data.base_roles} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
      {applying && <Apply t={applying} onClose={() => setApplying(null)} onDone={() => { setApplying(null); reload(); }} />}
    </div>
  );
}

function Editor({ t, catalog, baseRoles, onClose, onDone }) {
  const [form, setForm] = useState({ name: t.name, base_role: t.base_role, permissions: t.permissions });
  const save = useSubmit(async () => {
    if (t.id && JSON.stringify([...form.permissions].sort()) !== JSON.stringify([...t.permissions].sort()) && t.people
      && !window.confirm(`This changes permissions for ${t.people} ${t.people === 1 ? 'person' : 'people'} across the group. Continue?`)) return;
    if (t.id) await api.put(`/org/role-templates/${t.id}`, form);
    else await api.post('/org/role-templates', form);
    onDone();
  });
  const toggle = (p) => setForm({ ...form, permissions: form.permissions.includes(p) ? form.permissions.filter((x) => x !== p) : [...form.permissions, p] });
  return (
    <Modal title={t.id ? `Edit ${t.name}` : 'New role template'} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save.submit(); }}>
        <ErrorBox error={save.error} />
        <div className="form-grid">
          <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Front desk" autoFocus /></label>
          <label>Based on<select value={form.base_role} onChange={(e) => setForm({ ...form, base_role: e.target.value })}>{baseRoles.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></label>
        </div>
        <div style={{ marginTop: 10 }}>
          {Object.entries(catalog).map(([p, l]) => <label key={p} className="checkbox"><input type="checkbox" checked={form.permissions.includes(p)} onChange={() => toggle(p)} /> {l}</label>)}
        </div>
        <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={!form.name.trim() || save.busy}>Save</button></div>
      </form>
    </Modal>
  );
}

function Apply({ t, onClose, onDone }) {
  const { data: people, error } = useApi('/org/people');
  const [ids, setIds] = useState([]);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(null);
  const apply = useSubmit(async () => {
    if (!window.confirm(`Give ${ids.length} ${ids.length === 1 ? 'person' : 'people'} the “${t.name}” role? Their permissions change now and they sign in again.`)) return;
    setDone((await api.post(`/org/role-templates/${t.id}/apply`, { user_ids: ids, reason })).results);
  });
  const byPractice = (people || []).reduce((m, p) => ({ ...m, [p.practice]: [...(m[p.practice] || []), p] }), {});
  const toggle = (id) => setIds(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  return (
    <Modal title={`Apply “${t.name}”`} onClose={done ? onDone : onClose}>
      <ErrorBox error={error || apply.error} />
      {done ? (
        <>
          <div className="public-notice ok">Done: {done.filter((r) => r.changed).length} changed, {done.filter((r) => !r.changed).length} already had it. Each change is in that practice’s activity log.</div>
          <div className="form-actions"><button className="primary" onClick={onDone}>Close</button></div>
        </>
      ) : (
        <>
          {!people && <div className="muted">Loading…</div>}
          {Object.entries(byPractice).map(([practice, list]) => (
            <div key={practice} style={{ marginBottom: 10 }}>
              <div className="muted" style={{ fontSize: 12, fontWeight: 600 }}>{practice}</div>
              {list.map((p) => (
                <label key={p.id} className="checkbox" title={p.role === 'admin' ? 'Administrators are changed in their own practice' : ''}>
                  <input type="checkbox" disabled={p.role === 'admin'} checked={ids.includes(p.id)} onChange={() => toggle(p.id)} /> {p.name} <span className="muted">· {p.custom_role || label(p.role)}</span>
                </label>
              ))}
            </div>
          ))}
          <label>Why (kept with the change)<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Standardising front desk access" /></label>
          <div className="form-actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={!ids.length || apply.busy} onClick={apply.submit}>Apply to {ids.length || ''}</button></div>
        </>
      )}
    </Modal>
  );
}
