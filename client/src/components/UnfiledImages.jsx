import { useEffect, useState } from 'react';
import { api, getToken } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtDateTime, fmtDate } from '../format.js';
import { ErrorBox, PatientPicker, ConfirmButton } from './ui.jsx';
import { useLiveEvents } from '../live.js';

function Preview({ id }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let url;
    fetch(`/api/imaging/unfiled/${id}/image`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => (r.ok ? r.blob() : null)).then((b) => b && setSrc((url = URL.createObjectURL(b)))).catch(() => {});
    return () => url && URL.revokeObjectURL(url);
  }, [id]);
  return <div className="doc-thumb">{src ? <img src={src} alt="" /> : <span style={{ fontSize: 28 }}>🩻</span>}</div>;
}

// Images from the imaging bridges that couldn't be matched to a patient: pick some, choose the patient, file.
export default function UnfiledImages() {
  const { can } = useAuth();
  const { data: rows, reload } = useApi('/imaging/unfiled');
  useLiveEvents((e) => e.type === 'unfiled' && reload());
  const [picked, setPicked] = useState([]);
  const [patient, setPatient] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const act = async (body, done) => {
    setErr(null);
    try {
      await api.post('/imaging/unfiled/file', { ids: picked, ...body });
      setNote(done);
      setPicked([]);
      reload();
    } catch (e) { setErr(e); }
  };
  if (!rows) return <div className="empty">Loading…</div>;
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Unfiled images</h2>
      <p className="muted" style={{ marginTop: 0 }}>X-rays and photos from the imaging bridges that couldn&apos;t be matched to a patient (nobody was open on that workstation, or the label disagreed). Nothing is guessed: choose the patient and file them.</p>
      <ErrorBox error={err} />
      {note && <div className="public-notice ok" style={{ marginBottom: 10 }}>{note}</div>}
      {!rows.length ? <div className="empty">Nothing waiting. 🎉</div> : (
        <>
          {can('clinical:write') && (
            <div className="inline" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <span>{picked.length} selected</span>
              <button className="small" onClick={() => setPicked(picked.length === rows.length ? [] : rows.map((r) => r.id))}>{picked.length === rows.length ? 'Clear' : 'Select all'}</button>
              <div style={{ minWidth: 260 }}><PatientPicker value={patient} onChange={setPatient} /></div>
              <button className="primary" disabled={!picked.length || !patient} onClick={() => act({ patient_id: patient.id }, `Filed ${picked.length} image${picked.length === 1 ? '' : 's'} in ${patient.first_name} ${patient.last_name}'s chart.`)}>File in chart</button>
              <ConfirmButton className="danger" disabled={!picked.length} ask="Discard the selected images? They stay in storage for the record but leave this list." yes="Discard" onConfirm={() => act({ discard: true }, 'Discarded.')}>Discard</ConfirmButton>
            </div>
          )}
          <div className="doc-grid">
            {rows.map((r) => (
              <label key={r.id} className={`doc-tile unfiled${picked.includes(r.id) ? ' picked' : ''}`}>
                <Preview id={r.id} />
                <div className="doc-meta">
                  <span className="inline" style={{ gap: 6 }}>
                    {can('clinical:write') && <input type="checkbox" style={{ width: 'auto' }} checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} />}
                    <strong>{r.filename}</strong>
                  </span>
                  <span className="muted">{r.workstation || 'Bridge'} · {fmtDateTime(r.created_at)}{r.taken_at ? ` · taken ${fmtDate(r.taken_at)}` : ''}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{r.reason}</span>
                  {r.opened_first_name && <button type="button" className="link" style={{ fontSize: 12, textAlign: 'left' }} onClick={(e) => { e.preventDefault(); setPatient({ id: r.opened_patient_id, first_name: r.opened_first_name, last_name: r.opened_last_name }); }}>Open at the time: {r.opened_first_name} {r.opened_last_name}</button>}
                </div>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
