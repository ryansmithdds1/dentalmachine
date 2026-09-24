import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDateTime, fmtDate } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import NoteComposer from '../NoteComposer.jsx';
import Scribe from './Scribe.jsx';
import LongRecorder from './LongRecorder.jsx';
import CheckMyChart from '../chartaudit/CheckMyChart.jsx';

export default function NotesTab({ patient }) {
  const { user, can } = useAuth();
  const [filter, setFilter] = useState({ q: '', provider_id: '', unsigned: false });
  const query = new URLSearchParams({ ...(filter.q.trim() ? { q: filter.q.trim() } : {}), ...(filter.provider_id ? { provider_id: filter.provider_id } : {}), ...(filter.unsigned ? { unsigned: '1' } : {}) }).toString();
  const { data: notes, reload } = useApi(`/patients/${patient.id}/notes${query ? `?${query}` : ''}`);
  const providers = useLookup('/providers');
  const { data: visits } = useApi(`/appointments?patient_id=${patient.id}&from=2000-01-01&to=2100-01-01`);
  const visitLabel = (v) => `${fmtDate(v.start_time.slice(0, 10))} · ${v.type_name || v.reason || 'Visit'}`;
  const [editing, setEditing] = useState(null);
  const [addendum, setAddendum] = useState(null);
  const [actionErr, setActionErr] = useState(null);
  // ?visit=<appointment id> (from the chart audit or the review queue): that visit's check opens by itself.
  const [params] = useSearchParams();
  const focusVisit = Number(params.get('visit')) || null;
  const checkable = notes?.filter((n) => n.appointment_id && !n.signed) || [];
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
    <div className="grid notes-layout">
      {can('clinical:write') && (
        <div>
          <LongRecorder patient={patient} appointmentId={focusVisit} onSaved={reload} />
          <Scribe patient={patient} onSaved={reload} />
          <div className="card">
            <h2>New note</h2>
            {/* Opens drafted from today's visit, linked to it, with the cursor ready to type or dictate. */}
            <NoteComposer key={patient.id} patient={patient} draftToday autoFocus onSaved={reload} />
          </div>
        </div>
      )}
      <div>
        <div className="inline notes-filter" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <input type="search" aria-label="Search notes" placeholder="Search notes…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
          <select aria-label="Provider" value={filter.provider_id} onChange={(e) => setFilter({ ...filter, provider_id: e.target.value })} style={{ width: 'auto' }}>
            <option value="">All providers</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label className="inline" style={{ gap: 4, flexDirection: 'row', alignItems: 'center', margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={filter.unsigned} onChange={(e) => setFilter({ ...filter, unsigned: e.target.checked })} /> Unsigned only</label>
          <button className="small" onClick={() => window.open(`/patients/${patient.id}/notes/print${query ? `?${query}` : ''}`, '_blank')}>Print</button>
        </div>
        <ErrorBox error={actionErr} />
        {notes?.length === 0 && <div className="card empty">{query ? 'No notes match.' : 'No clinical notes.'}</div>}
        {notes?.map((n) => (
          <div className="card" key={n.id}>
            <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <div>
                <strong>{fmtDateTime(n.created_at.replace('T', ' '))}</strong>
                <span className="muted"> · {n.author_name}{n.provider_name ? ` for ${n.provider_name}` : ''}</span>
              </div>
              {n.signed ? <span className="badge ok">Signed{n.signed_by_name ? ` by ${n.signed_by_name}` : ''} {fmtDateTime(n.signed_at)}</span> : <span className="badge warn">Unsigned</span>}
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              {n.visit_start ? <>Visit: {fmtDate(n.visit_start.slice(0, 10))} · {n.visit_reason || 'appointment'}</> : !n.signed && can('clinical:write') && visits?.length ? (
                <select aria-label="Link to visit" value="" style={{ width: 'auto' }} onChange={(e) => e.target.value && act(() => api.put(`/notes/${n.id}`, { appointment_id: Number(e.target.value) }))}>
                  <option value="">Link to a visit…</option>
                  {visits.map((v) => <option key={v.id} value={v.id}>{visitLabel(v)}</option>)}
                </select>
              ) : 'Not linked to a visit'}
            </div>
            {n.appointment_id && !n.signed && (
              <CheckMyChart patientId={patient.id} visitKey={`a${n.appointment_id}`} autoOpen={focusVisit === n.appointment_id} shortcut={n.id === (checkable.find((c) => c.appointment_id === focusVisit) || checkable[0])?.id} onChanged={reload} compact />
            )}
            {editing?.id === n.id ? (
              <>
                <textarea rows={6} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
                <div className="form-actions">
                  <button className="small" onClick={() => setEditing(null)}>Cancel</button>
                  <button className="small primary" onClick={() => act(async () => { await api.put(`/notes/${n.id}`, { body: editing.body }); setEditing(null); })}>Save</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                {n.signature && <div className="note-signature">{n.signature} · {fmtDateTime(n.signed_at)}</div>}
              </>
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
            {!!n.signed && can('clinical:write') && (addendum?.id === n.id ? (
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
