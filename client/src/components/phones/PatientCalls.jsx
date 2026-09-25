import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PhoneIncoming, PhoneOutgoing, Mic, PhoneCall } from 'lucide-react';
import { getToken } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import LogCallForm, { logOutcomeLabel } from './LogCall.jsx';
import { fmtUtcDateTime } from '../../format.js';
import { NO_BOOK_REASONS } from './NoBookReason.jsx';
import './phones.css';

const dur = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');

// The chart's call history (PH1): every call with this patient (or their household), who took it, what it was
// about, and — for recorded calls — playback (each listen is recorded in the audit log) and the transcript.
// "Log a call" (A053) opens the same form inline here; calls logged from the side panel (Alt+G) show up at once.
export default function PatientCalls({ patient }) {
  const { can, practice } = useAuth();
  const [family, setFamily] = useState(false);
  const [logging, setLogging] = useState(false);
  const { data, reload } = useApi(`/patients/${patient.id}/calls${family ? '?family=1' : ''}`);
  useEffect(() => {
    window.addEventListener('dm:calls', reload);
    return () => window.removeEventListener('dm:calls', reload);
  }, [reload]);
  const [audio, setAudio] = useState({});
  const [text, setText] = useState({});
  const play = async (id) => {
    const res = await fetch(`/api/calls/${id}/recording`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    setAudio((a) => ({ ...a, [id]: url }));
  };
  const read = async (id) => {
    const res = await fetch(`/api/calls/${id}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (res.ok) { const c = await res.json(); setText((t) => ({ ...t, [id]: c.transcript || '' })); }
  };
  if (!data) return null;
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Calls</h2>
        <span className="inline" style={{ gap: 8 }}>
          <label className="checkbox" style={{ fontSize: 12 }}><input type="checkbox" checked={family} onChange={(e) => setFamily(e.target.checked)} /> Whole household</label>
          {can('patients:write') && !logging && <button type="button" className="small" onClick={() => setLogging(true)} title="Log a call (Alt+G from any screen)"><PhoneCall size={13} aria-hidden /> Log a call</button>}
        </span>
      </div>
      {logging && <LogCallForm patientId={patient.id} onClose={() => setLogging(false)} onSaved={() => { setLogging(false); reload(); }} />}
      {data.map((c) => (
        <div key={c.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
          <div className="inline" style={{ gap: 6 }}>
            {c.direction === 'inbound' ? <PhoneIncoming size={13} /> : <PhoneOutgoing size={13} />}
            <Link to={`/calls?open=${c.id}`}>{fmtUtcDateTime(c.created_at, practice?.timezone)}</Link>
            {family && c.first_name && <span className="muted">{c.first_name}</span>}
            {c.call_type && <span className="badge">{c.call_type.replace('_', ' ')}</span>}
            {c.appointment_id ? <span className="badge ok">booked</span> : c.no_book_reason ? <span className="badge warn">didn’t book: {NO_BOOK_REASONS[c.no_book_reason]?.toLowerCase()}</span> : null}
            {c.agent_name && c.purpose !== 'logged' && <span className="muted">· {c.agent_name}</span>}
            <span className="muted">{dur(c.duration)}</span>
          </div>
          {c.purpose === 'logged' && <div className="muted">{[logOutcomeLabel(c.outcome), c.caller_name && `with ${c.caller_name}`, c.agent_name && `logged by ${c.agent_name}`].filter(Boolean).join(' · ')}</div>}
          {c.summary && <div className={c.purpose === 'logged' ? 'call-note' : 'muted'}>{c.summary}</div>}
          {c.notes && <div className="call-note">{c.notes}</div>}
          <div className="inline" style={{ gap: 6, marginTop: 2 }}>
            {c.has_recording && (audio[c.id] ? <audio controls src={audio[c.id]} style={{ height: 28 }} /> : <button type="button" className="small" onClick={() => play(c.id)}><Mic size={12} /> Play</button>)}
            {c.has_transcript && text[c.id] === undefined && <button type="button" className="small" onClick={() => read(c.id)}>Transcript</button>}
          </div>
          {text[c.id] && <div style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', fontSize: 12, marginTop: 4 }}>{text[c.id]}</div>}
        </div>
      ))}
      {!data.length && <div className="muted">No calls on file{family ? ' for the household' : ''}.</div>}
    </div>
  );
}
