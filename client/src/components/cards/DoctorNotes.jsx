import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquareText, Check, CalendarPlus, ListTodo, Undo2, X } from 'lucide-react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useLiveEvents } from '../../live.js';
import { toast } from '../../toast.js';
import { fmtUtcDateTime } from '../../format.js';
import { refreshCards } from './cardData.js';
import './cards.css';

// The doctor's notes to the front desk on the schedule (DN1). A note on a visit ("book crown next") or on an
// empty slot ("I have time 2–3 — fit an emergency"): left from a right-click (or Shift+N) on the schedule or from
// the visit's panel; everyone else hears a chime and sees it at once; the front desk says "Got it" and turns it into
// a booking or a task in one click. The quick picks make a note two actions: right-click, pick.
const QUICK = {
  slot: ['Fit an emergency here', 'Quick filling here', 'Free — call the ASAP list', 'Keep for a crown seat'],
  visit: ['Book crown next', 'Needs 90 min next time', 'Perio maintenance in 3 months', 'Recheck in 2 weeks'],
};
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const label12 = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`; };
const newKey = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// A floating box kept inside the window, where the person clicked.
function useFloating(at) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
  }, [at.x, at.y]);
  return [ref, pos];
}

// target: { kind: 'visit', appt } or { kind: 'slot', col, start: minutes, end: minutes }
export function NoteComposer({ target, at, onClose }) {
  const [ref, pos] = useFloating(at);
  const [body, setBody] = useState('');
  const [start, setStart] = useState(target.kind === 'slot' ? hhmm(target.start) : '');
  const [end, setEnd] = useState(target.kind === 'slot' ? hhmm(target.end) : '');
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [onClose, ref]);
  const save = async (text) => {
    const words = String(text || '').trim();
    if (!words || busy) return;
    setBusy(true);
    try {
      const where = target.kind === 'visit'
        ? { appointment_id: target.appt.id }
        : { date: target.col.date, start_time: start, end_time: end, ...(target.col.assign?.operatory_id ? { operatory_id: target.col.assign.operatory_id } : {}), ...(target.col.assign?.provider_id ? { provider_id: target.col.assign.provider_id } : {}) };
      await api.post('/schedule-notes', { ...where, body: words, client_key: key.current });
      toast('Note left for the front desk');
      refreshCards();
      onClose();
    } catch (err) {
      toast(err.message, { tone: 'error' });
      setBusy(false);
    }
  };
  const title = target.kind === 'visit' ? `Note on ${target.appt.first_name}’s visit` : `Note on ${target.col.label ? `${target.col.label}, ` : ''}${label12(start || '00:00')}–${label12(end || '00:00')}`;
  return (
    <div ref={ref} className="dn-composer" role="dialog" aria-label="Leave a note for the front desk" style={{ left: pos.left, top: pos.top }}
      onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <div className="dn-head"><MessageSquareText size={15} aria-hidden /> <strong>{title}</strong>
        <button type="button" className="icon-btn tiny" onClick={onClose} aria-label="Close"><X size={14} /></button>
      </div>
      <div className="dn-quick">
        {QUICK[target.kind].map((q) => <button key={q} type="button" className="dn-pick" disabled={busy} onClick={() => save(q)}>{q}</button>)}
      </div>
      {target.kind === 'slot' && (
        <div className="dn-times">
          <label>From <input type="time" value={start} step={300} onChange={(e) => setStart(e.target.value)} aria-label="From" /></label>
          <label>to <input type="time" value={end} step={300} onChange={(e) => setEnd(e.target.value)} aria-label="To" /></label>
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); save(body); }}>
        <textarea rows={2} value={body} maxLength={400} placeholder="Or write your own… (Enter to send)" aria-label="Note"
          onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(body); } }} />
        <div className="dn-actions"><button type="submit" className="primary small" disabled={!body.trim() || busy}>Send to the front desk</button></div>
      </form>
    </div>
  );
}

// The notes on a visit or a slot, with what the front desk can do with each.
export function NotesPopover({ notes, at, onClose, onBookSlot }) {
  const [ref, pos] = useFloating(at);
  const { user, can, practice } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [onClose, ref]);
  useEffect(() => { ref.current?.querySelector('button.dn-act')?.focus(); }, [ref]);
  const w = can('schedule:write');
  const act = async (n, path, body, done) => {
    setBusy(n.id);
    try {
      const r = await api.post(`/schedule-notes/${n.id}/${path}`, body || {});
      refreshCards();
      done?.(r);
      onClose();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    } finally { setBusy(null); }
  };
  const book = (n) => act(n, 'convert', { kind: 'booking' }, (r) => {
    const b = r.book;
    if (n.kind === 'slot' && onBookSlot) onBookSlot(b);
    else if (b.patient_id) nav(`/schedule?book=${b.patient_id}`);
  });
  return (
    <div ref={ref} className="dn-popover" role="dialog" aria-label="Doctor’s notes" style={{ left: pos.left, top: pos.top }} onPointerDown={(e) => e.stopPropagation()}>
      {notes.map((n) => (
        <div key={n.id} className={`dn-note ${n.status}`}>
          <div className="dn-body"><MessageSquareText size={14} aria-hidden /> <span>{n.body}</span></div>
          <div className="dn-who">
            {n.by || 'Someone'} · {fmtUtcDateTime(n.at, practice?.timezone)}{n.kind === 'slot' && n.start_time ? ` · ${label12(n.start_time)}–${label12(n.end_time)}` : ''}
            {n.status === 'acknowledged' && <> · <Check size={11} aria-hidden /> seen by {n.acked_by || 'the front desk'}</>}
          </div>
          <div className="dn-buttons">
            {w && n.status === 'open' && <button type="button" className="dn-act small" disabled={busy === n.id} onClick={() => act(n, 'ack')}><Check size={13} /> Got it</button>}
            {w && <button type="button" className="dn-act small" disabled={busy === n.id} onClick={() => book(n)}><CalendarPlus size={13} /> Book it</button>}
            {w && <button type="button" className="dn-act small" disabled={busy === n.id} onClick={() => act(n, 'convert', { kind: 'task' }, () => toast('Task added to the team’s list'))}><ListTodo size={13} /> Make a task</button>}
            {w && <button type="button" className="dn-act small" disabled={busy === n.id} onClick={() => act(n, 'done')}>Done</button>}
            {(n.by_id === user?.id || user?.role === 'admin') && <button type="button" className="dn-act small link-like" disabled={busy === n.id} onClick={() => act(n, 'withdraw')}><Undo2 size={13} /> Take back</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

// Slot notes drawn in a column: a soft outline over the time, with a bubble that opens the note.
export function SlotNotes({ notes, range, pxPerMin, onOpen }) {
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return notes.map((n) => {
    const s = Math.max(range.start, toMin(n.start_time));
    const e = Math.min(range.end, toMin(n.end_time));
    if (e <= s) return null;
    return (
      <div key={`dn-${n.id}`} className={`dn-slot ${n.status}`} style={{ top: (s - range.start) * pxPerMin, height: (e - s) * pxPerMin }} aria-hidden="false">
        <button type="button" className="dn-bubble" data-note-id={n.id} title={`${n.by || 'Note'}: ${n.body}`}
          onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); onOpen(n, ev.currentTarget); }}>
          <MessageSquareText size={12} strokeWidth={2.4} aria-hidden /> <span>{n.body}</span>
        </button>
      </div>
    );
  });
}

// A new note from someone else: a soft two-tone chime and a toast (the schedule shows it too).
let audioCtx = null;
function chime() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.08, t0 + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.3);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + i * 0.16);
      o.stop(t0 + i * 0.16 + 0.32);
    });
  } catch { /* no sound on this computer: the toast still shows */ }
}
export function useDoctorNoteAlerts() {
  const { user } = useAuth();
  useLiveEvents((ev) => {
    if (ev.type !== 'doctor_note' || ev.what !== 'new' || ev.by === user?.id) return;
    chime();
    toast(`${ev.by_name || 'The doctor'} left a note: “${ev.preview}”`);
  });
}
