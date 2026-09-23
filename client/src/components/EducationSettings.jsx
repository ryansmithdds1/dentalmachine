import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox, Modal, useSubmit } from './ui.jsx';

// Settings → Patient education: the built-in pages, edits to them, and the office's own.
export default function EducationSettings() {
  const { data, reload } = useApi('/education');
  const [editing, setEditing] = useState(null);
  if (!data) return null;
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Patient education</h2>
        <button className="primary small" onClick={() => setEditing({ slug: '', title: '', body: '', codes: [], isNew: true })}>+ Page</button>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Pages patients can be sent from their chart (Risk & education tab). Pages are matched to treatment by code; editing a built-in page keeps its address.</p>
      <table>
        <thead><tr><th>Page</th><th>For codes</th><th /><th /></tr></thead>
        <tbody>
          {data.articles.map((a) => (
            <tr key={a.slug}>
              <td><a href={`${data.base}/${a.slug}`} target="_blank" rel="noreferrer">{a.title}</a></td>
              <td className="muted" style={{ fontSize: 12 }}>{a.codes.join(', ')}</td>
              <td className="muted" style={{ fontSize: 12 }}>{a.built_in ? 'Built in' : a.overrides ? 'Edited' : 'Yours'}{a.active ? '' : ' · hidden'}</td>
              <td><button className="small" onClick={() => setEditing({ ...a })}>Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <Editor article={editing} onDone={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function Editor({ article, onDone }) {
  const [f, setF] = useState({ ...article, codes: article.codes.join(', ') });
  const save = useSubmit(async () => { await api.put(`/education/${f.slug}`, { title: f.title, body: f.body, codes: f.codes, active: f.active !== 0 }); onDone(); });
  const revert = useSubmit(async () => { await api.del(`/education/${f.slug}`); onDone(); });
  return (
    <Modal title={article.isNew ? 'New page' : article.title} wide onClose={onDone}>
      <ErrorBox error={save.error} />
      <div className="form-grid">
        {article.isNew && <label>Address (e.g. sleep-apnea)<input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} /></label>}
        <label>Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label>For codes (prefixes OK: D27 = crowns)<input value={f.codes} onChange={(e) => setF({ ...f, codes: e.target.value })} /></label>
        <label className="full">Text (blank line between paragraphs; start a line with “- ” for a bullet)<textarea rows={14} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
        <label className="checkbox"><input type="checkbox" checked={f.active !== 0} onChange={(e) => setF({ ...f, active: e.target.checked ? 1 : 0 })} /> Offer this page</label>
      </div>
      <div className="form-actions">
        {!article.built_in && !article.isNew && <button className="danger" onClick={revert.submit}>{article.overrides ? 'Go back to the built-in page' : 'Delete'}</button>}
        <button className="primary" disabled={save.busy || !f.slug || !f.title || !f.body} onClick={save.submit}>Save</button>
      </div>
    </Modal>
  );
}
