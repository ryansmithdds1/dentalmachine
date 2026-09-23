import { useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDateTime } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import NoteComposer from '../NoteComposer.jsx';

export default function NotesTab({ patient }) {
  const { user, can } = useAuth();
  const { data: notes, reload } = useApi(`/patients/${patient.id}/notes`);
  const [editing, setEditing] = useState(null);
  const [addendum, setAddendum] = useState(null);
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
          <NoteComposer patient={patient} providerId={patient.primary_provider_id} onSaved={reload} />
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
              {n.signed ? <span className="badge ok">Signed{n.signed_by_name ? ` by ${n.signed_by_name}` : ''} {fmtDateTime(n.signed_at)}</span> : <span className="badge warn">Unsigned</span>}
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
            {n.addenda?.map((a) => (
              <div key={a.id} className="addendum">
                <div className="muted" style={{ fontSize: 12 }}>
                  Addendum · {fmtDateTime(a.created_at.replace('T', ' '))} · {a.author_name}
                  {a.signed ? ` · signed${a.signed_by_name ? ` by ${a.signed_by_name}` : ''}` : ' · unsigned'}
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{a.body}</div>
                {!a.signed && can('clinical:sign') && <button className="small primary" style={{ marginTop: 4 }} onClick={() => act(() => api.post(`/notes/${a.id}/sign`))}>Sign addendum</button>}
              </div>
            ))}
            {n.signed && can('clinical:write') && (addendum?.id === n.id ? (
              <div style={{ marginTop: 8 }}>
                <textarea rows={3} autoFocus value={addendum.body} onChange={(e) => setAddendum({ ...addendum, body: e.target.value })} placeholder="Correction or late entry…" />
                <div className="form-actions">
                  <button className="small" onClick={() => setAddendum(null)}>Cancel</button>
                  <button className="small primary" disabled={!addendum.body.trim()} onClick={() => act(async () => {
                    const a = await api.post(`/notes/${n.id}/addenda`, { body: addendum.body });
                    setAddendum(null);
                    if (can('clinical:sign')) await api.post(`/notes/${a.id}/sign`).catch(() => {});
                  })}>Save addendum</button>
                </div>
              </div>
            ) : <div className="form-actions" style={{ marginTop: 8 }}><button className="small" onClick={() => setAddendum({ id: n.id, body: '' })}>Add addendum</button></div>)}
          </div>
        ))}
      </div>
    </div>
  );
}
