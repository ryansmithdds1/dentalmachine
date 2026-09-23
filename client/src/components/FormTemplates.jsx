import { useState } from 'react';
import { api } from '../api.js';
import { useApi, invalidateLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { Badge, ErrorBox, Modal, useSubmit } from './ui.jsx';
import FormFields from './FormFields.jsx';

const TYPES = [
  ['paragraph', 'Paragraph of text'], ['heading', 'Heading'], ['checkbox', 'Checkbox (I agree…)'], ['initials', 'Initials'], ['yesno', 'Yes / no question'],
  ['text', 'Short answer'], ['textarea', 'Long answer'], ['date', 'Date'], ['select', 'Pick one'], ['photo', 'Photo (card, ID)'], ['signature', 'Signature'],
];
const KINDS = [['consent', 'Consent'], ['policy', 'Policy'], ['intake', 'Intake'], ['other', 'Other']];
const RENEW = [[0, 'Once'], [12, 'Every year'], [24, 'Every 2 years'], [6, 'Every 6 months']];

// Settings → Forms & consents: the practice's forms, and an editor with a live preview.
export default function FormTemplates() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const { data: list, reload } = useApi('/form-templates?all=true');
  const [editing, setEditing] = useState(null);
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="inline" style={{ padding: '14px 16px', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0 }}>Forms & consents</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            Patients sign these on their phone or an office tablet; each signed form is filed in the chart as a PDF. Consents with procedure codes are suggested
            for matching treatment, and forms marked “auto-send” go out with the visit reminder when a patient still needs them.
          </div>
        </div>
        {admin && <button className="primary" onClick={() => setEditing({ name: '', kind: 'consent', procedure_codes: '', auto_send: false, renew_months: 0, active: true, fields: [{ type: 'paragraph', text: '' }, { type: 'signature', label: 'Patient (or parent/guardian) signature', required: true }] })}>+ New form</button>}
      </div>
      {!list ? <div className="empty">Loading…</div> : (
        <table>
          <thead><tr><th>Form</th><th>Type</th><th>For procedures</th><th>Sent</th><th>Version</th><th /></tr></thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id} style={{ opacity: t.active ? 1 : 0.55 }}>
                <td><strong>{t.name}</strong>{!t.active && <> <Badge value="inactive" /></>}</td>
                <td>{KINDS.find(([k]) => k === t.kind)?.[1]}</td>
                <td>{t.procedure_codes || <span className="muted">—</span>}</td>
                <td>{t.auto_send ? `Automatically · ${RENEW.find(([m]) => m === t.renew_months)?.[1]?.toLowerCase() || `every ${t.renew_months} months`}` : <span className="muted">When sent</span>}</td>
                <td>v{t.version}</td>
                <td>{admin && <button className="small" onClick={() => setEditing({ ...t, procedure_codes: t.procedure_codes || '', auto_send: !!t.auto_send, active: !!t.active })}>Edit</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <Editor template={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); invalidateLookup('/form-templates'); }} />}
    </div>
  );
}

function Editor({ template, onClose, onSaved }) {
  const [t, setT] = useState(template);
  const [sample, setSample] = useState({});
  const set = (patch) => setT({ ...t, ...patch });
  const setField = (i, patch) => set({ fields: t.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const move = (i, d) => { const f = [...t.fields]; [f[i], f[i + d]] = [f[i + d], f[i]]; set({ fields: f }); };
  const { submit, busy, error } = useSubmit(async () => {
    const body = { name: t.name, kind: t.kind, procedure_codes: t.procedure_codes, auto_send: t.auto_send, renew_months: Number(t.renew_months), active: t.active, fields: t.fields };
    if (t.id) await api.put(`/form-templates/${t.id}`, body);
    else await api.post('/form-templates', body);
    onSaved();
  });
  const preview = t.fields.map((f, i) => ({ ...f, key: f.key || `f${i}`, options: typeof f.options === 'string' ? f.options.split(',').map((o) => o.trim()).filter(Boolean) : f.options || [] }))
    .map((f) => ({ ...f, label: fillSample(f.label), text: fillSample(f.text) }));
  return (
    <Modal title={t.id ? `Edit “${template.name}”` : 'New form'} wide onClose={onClose}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Name<input value={t.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label>Type<select value={t.kind} onChange={(e) => set({ kind: e.target.value })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>For procedure codes<input value={t.procedure_codes} onChange={(e) => set({ procedure_codes: e.target.value })} placeholder="e.g. D71, D72 (prefixes work)" /></label>
        <label>
          Needed
          <select value={t.renew_months} onChange={(e) => set({ renew_months: Number(e.target.value) })}>{RENEW.map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select>
        </label>
        <label className="checkbox"><input type="checkbox" checked={t.auto_send} onChange={(e) => set({ auto_send: e.target.checked })} /> Send automatically before visits{t.procedure_codes ? ' with these procedures' : ''}</label>
        <label className="checkbox"><input type="checkbox" checked={t.active} onChange={(e) => set({ active: e.target.checked })} /> Active</label>
      </div>
      {t.id && <div className="muted" style={{ fontSize: 12, margin: '6px 0' }}>Changing the wording saves a new version; forms already signed keep the version the patient saw.</div>}
      <div className="form-editor">
        <div>
          <h3>Fields</h3>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>In text, <code>{'{patient}'}</code> <code>{'{procedures}'}</code> <code>{'{teeth}'}</code> <code>{'{provider}'}</code> <code>{'{practice}'}</code> <code>{'{date}'}</code> are filled in.</div>
          {t.fields.map((f, i) => (
            <div key={i} className="field-row">
              <div className="inline" style={{ gap: 6 }}>
                <select value={f.type} onChange={(e) => setField(i, { type: e.target.value })} style={{ flex: 1 }}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                {!['paragraph', 'heading'].includes(f.type) && <label className="checkbox" style={{ whiteSpace: 'nowrap' }}><input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Required</label>}
                <button type="button" className="small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                <button type="button" className="small" disabled={i === t.fields.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                <button type="button" className="small" onClick={() => set({ fields: t.fields.filter((_, j) => j !== i) })} aria-label="Remove">✕</button>
              </div>
              {f.type === 'paragraph'
                ? <textarea rows={3} value={f.text || ''} onChange={(e) => setField(i, { text: e.target.value })} placeholder="Text the patient reads" />
                : <input value={f.label || ''} onChange={(e) => setField(i, { label: e.target.value })} placeholder={f.type === 'heading' ? 'Heading' : 'Question or statement'} />}
              {f.type === 'select' && <input value={Array.isArray(f.options) ? f.options.join(', ') : f.options || ''} onChange={(e) => setField(i, { options: e.target.value })} placeholder="Choices, separated by commas" />}
            </div>
          ))}
          <button type="button" onClick={() => set({ fields: [...t.fields, { type: 'checkbox', label: '', required: true }] })}>+ Add field</button>
        </div>
        <div className="form-preview">
          <h3>Preview</h3>
          <div className="card" style={{ margin: 0 }}>
            <h2 style={{ marginTop: 0 }}>{t.name || 'Untitled form'}</h2>
            <FormFields fields={preview} answers={sample} onChange={setSample} preview />
          </div>
        </div>
      </div>
      <div className="form-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Save form'}</button>
      </div>
    </Modal>
  );
}

const SAMPLE = { patient: 'Jane Doe', procedures: 'Extraction, erupted tooth', teeth: '#17', provider: 'Dr. Ann Lee', practice: 'your practice', date: new Date().toLocaleDateString() };
const fillSample = (s) => (s ? String(s).replace(/\{(\w+)\}/g, (m, k) => SAMPLE[k] ?? m) : s);
