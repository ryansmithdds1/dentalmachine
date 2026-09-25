import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, useLookup, invalidateLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { ErrorBox, useSubmit } from '../ui.jsx';
import { toast } from '../../toast.js';

// Settings → Letter templates (A171, docs/documents.md, “Letters and mailing labels”): the office's letters with merge fields. Changes
// are kept (before → after); a template no longer wanted is switched off, never removed (past letters name it).
export default function LetterTemplates() {
  const { user } = useAuth();
  const admin = user.role === 'admin';
  const { data: list, reload } = useApi('/letter-templates?all=1');
  const fields = useLookup('/letter-fields');
  const [open, setOpen] = useState(null); // a template, or {} for a new one
  const done = () => { setOpen(null); invalidateLookup('/letter-templates'); reload(); };
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Letter templates</h2>
      <p className="muted">Letters to patients, filled in from the chart. Write one from the command bar (“Write a letter”) or from a report’s results. A letter can’t be printed or emailed while a field has nothing to fill it (for example {'{next_appointment}'} with no visit booked).</p>
      <table>
        <thead><tr><th>Letter</th><th>Subject</th><th>In use</th><th aria-label="Actions" /></tr></thead>
        <tbody>
          {list?.map((t) => (
            <tr key={t.id} className={t.active ? '' : 'cmp-voided'}>
              <td>{t.name}</td>
              <td className="muted">{t.subject}</td>
              <td>{t.active ? 'Yes' : 'Off'}</td>
              <td>{admin && <button type="button" className="small" onClick={() => setOpen(t)}>Edit</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {admin && !open && <button type="button" className="primary" style={{ marginTop: 10 }} onClick={() => setOpen({})}>New letter</button>}
      {open && <Editor t={open} fields={fields} onDone={done} />}
      <p className="muted" style={{ fontSize: 12 }}>Try one: <Link to="/letters">Write a letter</Link></p>
    </div>
  );
}

function Editor({ t, fields, onDone }) {
  const [f, setF] = useState({ name: t.name || '', subject: t.subject || '', body: t.body || 'Dear {preferred_name},\n\n', active: t.active ?? 1 });
  const save = useSubmit(async () => {
    if (t.id) await api.put(`/letter-templates/${t.id}`, f);
    else await api.post('/letter-templates', f);
    toast('Letter saved');
    onDone();
  });
  const insert = (key) => setF({ ...f, body: `${f.body}{${key}}` });
  return (
    <form className="inline-panel" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); save.submit(); }} aria-label="Letter template">
      <ErrorBox error={save.error} />
      <div className="form-grid">
        <label>Name<input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Subject (email subject and heading)<input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
      </div>
      <label className="full" style={{ display: 'grid', gap: 4, marginTop: 8 }}>Letter<textarea rows={10} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
      <div className="chips" style={{ margin: '8px 0' }}>
        {fields.map((x) => <button key={x.key} type="button" className="chip" title={x.label} onClick={() => insert(x.key)}>{`{${x.key}}`}</button>)}
      </div>
      <div className="cmp-row">
        <label className="inline-label"><input type="checkbox" checked={!!f.active} onChange={(e) => setF({ ...f, active: e.target.checked ? 1 : 0 })} /> In use</label>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" onClick={() => onDone()}>Cancel</button>
        <button className="primary" disabled={save.busy || !f.name.trim() || !f.body.trim()}>Save</button>
      </div>
    </form>
  );
}
