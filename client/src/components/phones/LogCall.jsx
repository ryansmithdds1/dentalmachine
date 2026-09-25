import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { useRemembered } from '../../prefs.js';
import { toast } from '../../toast.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import './phones.css';

// Log a call on a patient's chart (A053): an ordinary call — on a cell phone, or one the phone line didn't see —
// noted in seconds from any screen (Alt+G with the patient active, the command bar, or Messages & forms → Calls).
// Everything has a default: now, the signed-in person, the patient, the way this person logged their last call,
// "Spoke with them". The cursor starts in the note, so it's type and Enter. If the phone line already logged a call
// with the patient in the last few minutes, the note goes onto that call (the choice is on screen) instead of
// logging the same conversation twice. Saved to the calls log (server: POST /patients/:id/calls), audited.
export const LOG_OUTCOMES = [['spoke', 'Spoke with them'], ['left_voicemail', 'Left voicemail'], ['no_answer', 'No answer'], ['wrong_number', 'Wrong number']];
export const logOutcomeLabel = (o) => LOG_OUTCOMES.find(([k]) => k === o)?.[1];
// A UTC time from the server (calls.created_at) as the practice's clock time.
const clock = (s, tz) => new Date(`${s.slice(0, 19).replace(' ', 'T')}Z`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
const WHEN = [[0, 'Just now'], [5, '5 min ago'], [15, '15 min ago'], [30, '30 min ago'], [60, 'An hour ago'], [120, '2 hours ago']];

// Opens the panel for a patient from anywhere (the host is mounted once, in App.jsx).
export const openLogCall = (patientId) => window.dispatchEvent(new CustomEvent('dm:logcall', { detail: { patientId } }));

export function LogCallHost() {
  const [patientId, setPatientId] = useState(null);
  useEffect(() => {
    const on = (e) => setPatientId(e.detail?.patientId || null);
    window.addEventListener('dm:logcall', on);
    return () => window.removeEventListener('dm:logcall', on);
  }, []);
  if (!patientId) return null;
  return (
    <aside className="side-panel logcall-panel" aria-label="Log a call">
      <LogCallForm key={patientId} patientId={patientId} onClose={() => setPatientId(null)} onSaved={() => { setPatientId(null); window.dispatchEvent(new Event('dm:calls')); }} />
    </aside>
  );
}

export default function LogCallForm({ patientId, onClose, onSaved }) {
  const { practice } = useAuth();
  const tz = practice?.timezone;
  const { data: p } = useApi(`/patients/${patientId}/card`);
  const { data: recent } = useApi(`/patients/${patientId}/calls/recent`);
  const [lastDirection, rememberDirection] = useRemembered('logcall.direction', 'outbound');
  const [f, setF] = useState({ direction: null, outcome: 'spoke', with_name: '', minutes_ago: 0, note: '' });
  const [addTo, setAddTo] = useState(null); // the phone line's call to add the note to, when there is one
  const direction = f.direction || lastDirection;
  const name = p ? `${p.preferred_name || p.first_name} ${p.last_name}` : '';
  const note = useRef(null);
  useEffect(() => { note.current?.focus(); }, []);
  // Offer the phone line's call first: it's almost always the one being noted.
  useEffect(() => { if (recent?.call) setAddTo(recent.call.id); }, [recent?.call?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { submit, busy, error } = useSubmit(async () => {
    if (addTo) {
      await api.post(`/patients/${patientId}/calls`, { call_id: addTo, note: f.note });
      toast(`Note added to the ${clock(recent.call.created_at, tz)} call`);
    } else {
      const saved = await api.post(`/patients/${patientId}/calls`, { direction, outcome: f.outcome, note: f.note, with_name: f.with_name || name, minutes_ago: Number(f.minutes_ago) });
      rememberDirection(direction);
      toast(saved.duplicate ? 'That call was already logged' : `Call logged: ${logOutcomeLabel(f.outcome).toLowerCase()}${f.note ? ' — note saved' : ''}`);
    }
    onSaved?.();
  });
  const keys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose?.(); return; }
    // Enter saves from the note (Shift+Enter for a new line), like a text reply.
    if (e.key === 'Enter' && !e.shiftKey && e.target === note.current) { e.preventDefault(); if (!busy) submit(); return; }
    // 1–4 pick how it went when the cursor isn't in a box.
    if (!e.target.closest('input, textarea, select') && /^[1-4]$/.test(e.key) && !addTo) {
      e.preventDefault();
      setF((x) => ({ ...x, outcome: LOG_OUTCOMES[Number(e.key) - 1][0] }));
    }
  };
  const recentCall = recent?.call;
  return (
    <form className="logcall" onSubmit={(e) => { e.preventDefault(); submit(); }} onKeyDown={keys}>
      <header className="logcall-head">
        <h2>Log a call{name ? ` — ${name}` : ''}</h2>
        {onClose && <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>}
      </header>
      <ErrorBox error={error} />
      {recentCall && (
        <div className="logcall-recent" role="group" aria-label="A call is already on file">
          <div>The phone line already logged a call with {p?.first_name || 'them'} at <strong>{clock(recentCall.created_at, tz)}</strong> ({recentCall.direction === 'inbound' ? 'they called' : 'we called'}{recentCall.duration ? `, ${Math.round(recentCall.duration / 60) || 1} min` : ''}).</div>
          <label className="checkbox"><input type="radio" name="logcall-to" checked={!!addTo} onChange={() => setAddTo(recentCall.id)} /> Add this note to that call</label>
          <label className="checkbox"><input type="radio" name="logcall-to" checked={!addTo} onChange={() => setAddTo(null)} /> It was a different call — log it separately</label>
        </div>
      )}
      <label className="full">Note
        <textarea ref={note} rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} aria-label="Call note" placeholder={addTo ? 'What was said (added to that call)' : 'What was said — optional. Enter saves, Shift+Enter for a new line'} maxLength={2000} />
      </label>
      {!addTo && (
        <>
          <div className="logcall-row" role="radiogroup" aria-label="How it went">
            {LOG_OUTCOMES.map(([k, l], i) => (
              <button key={k} type="button" role="radio" aria-checked={f.outcome === k} className={`chip${f.outcome === k ? ' active' : ''}`} onClick={() => setF({ ...f, outcome: k })}>{l} <kbd>{i + 1}</kbd></button>
            ))}
          </div>
          <div className="logcall-row">
            <div className="seg" role="radiogroup" aria-label="Who called">
              <button type="button" role="radio" aria-checked={direction === 'outbound'} className={direction === 'outbound' ? 'active' : ''} onClick={() => setF({ ...f, direction: 'outbound' })}>We called</button>
              <button type="button" role="radio" aria-checked={direction === 'inbound'} className={direction === 'inbound' ? 'active' : ''} onClick={() => setF({ ...f, direction: 'inbound' })}>They called</button>
            </div>
            <select value={f.minutes_ago} onChange={(e) => setF({ ...f, minutes_ago: e.target.value })} aria-label="When">
              {WHEN.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
            </select>
          </div>
          <label className="full">With <input value={f.with_name || name} onChange={(e) => setF({ ...f, with_name: e.target.value })} aria-label="Who the call was with" placeholder="The patient, or e.g. their mother" /></label>
        </>
      )}
      <div className="form-actions">
        {onClose && <button type="button" onClick={onClose}>Cancel <kbd>Esc</kbd></button>}
        <button className="primary" disabled={busy || (addTo && !f.note.trim())}>{busy ? 'Saving…' : addTo ? 'Add note' : 'Log call'} <kbd>Enter</kbd></button>
      </div>
    </form>
  );
}
