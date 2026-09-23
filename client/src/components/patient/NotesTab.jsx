import { useState } from 'react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDateTime } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';

const TEMPLATES = {
  'Recall exam': 'S: Pt presents for periodic exam and prophy. No complaints.\nO: Soft tissue WNL. Light plaque/calculus. \nA: \nP: Adult prophy completed. OHI reviewed. RTC 6 months.',
  'Restorative': 'Tooth #__ surfaces __. Anesthetic: __ carpules __. Isolation: rubber dam. Caries removed, __ placed and cured. Occlusion checked and adjusted. Pt tolerated well.',
  'Emergency / limited': 'CC: \nHx: \nClinical findings: \nRadiographs: \nDx: \nTx rendered: \nPlan: ',
};

export default function NotesTab({ patient }) {
  const { user, can } = useAuth();
  const { data: notes, reload } = useApi(`/patients/${patient.id}/notes`);
  const providers = useLookup('/providers?active=true');
  const [body, setBody] = useState('');
  const [providerId, setProviderId] = useState('');
  const [signNow, setSignNow] = useState(false);
  const [editing, setEditing] = useState(null);
  const { submit, busy, error } = useSubmit(async () => {
    const note = await api.post(`/patients/${patient.id}/notes`, { body, provider_id: providerId ? Number(providerId) : null });
    if (signNow) await api.post(`/notes/${note.id}/sign`);
    setBody('');
    reload();
  });
  const [actionErr, setActionErr] = useState(null);
  const act = async (fn) => {
    setActionErr(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionErr(e);
    }
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.3fr)' }}>
      {can('clinical:write') && (
        <div className="card">
          <h2>New note</h2>
          <ErrorBox error={error} />
          <div className="inline" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            {Object.keys(TEMPLATES).map((t) => <button key={t} className="small" onClick={() => setBody(TEMPLATES[t])}>{t}</button>)}
          </div>
          <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Clinical note…" />
          <div className="form-grid" style={{ marginTop: 10 }}>
            <label>
              Provider
              <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                <option value="">—</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {can('clinical:sign') && <label className="checkbox" style={{ alignSelf: 'end' }}><input type="checkbox" checked={signNow} onChange={(e) => setSignNow(e.target.checked)} /> Sign now</label>}
          </div>
          <div className="form-actions">
            <button className="primary" disabled={busy || !body.trim()} onClick={submit}>Save note</button>
          </div>
        </div>
      )}
      <div>
        <ErrorBox error={actionErr} />
        {notes?.length === 0 && <div className="card empty">No clinical notes.</div>}
        {notes?.map((n) => (
          <div className="card" key={n.id}>
            <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <div>
                <strong>{fmtDateTime(n.created_at.replace('T', ' '))}</strong>
                <span className="muted"> · {n.author_name}{n.provider_name ? ` for ${n.provider_name}` : ''}</span>
              </div>
              {n.signed ? <span className="badge ok">Signed {fmtDateTime(n.signed_at)}</span> : <span className="badge warn">Unsigned</span>}
            </div>
            {editing?.id === n.id ? (
              <>
                <textarea rows={6} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
                <div className="form-actions">
                  <button className="small" onClick={() => setEditing(null)}>Cancel</button>
                  <button className="small primary" onClick={() => act(async () => { await api.put(`/notes/${n.id}`, { body: editing.body }); setEditing(null); })}>Save</button>
                </div>
              </>
            ) : (
              <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
            )}
            {!n.signed && editing?.id !== n.id && (
              <div className="form-actions" style={{ marginTop: 8 }}>
                {(n.author_id === user.id || user.role === 'admin') && <button className="small" onClick={() => setEditing({ id: n.id, body: n.body })}>Edit</button>}
                {can('clinical:sign') && <button className="small primary" onClick={() => act(() => api.post(`/notes/${n.id}/sign`))}>Sign</button>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
