import { useState } from 'react';
import { HandHeart, MessageSquareText, Tag } from 'lucide-react';
import { api } from '../../api.js';
import { toast } from '../../toast.js';
import { useCardData, useConnection, refreshCards } from './cardData.js';
import ConnectionChips from './Connection.jsx';
import { NoteComposer, NotesPopover } from './DoctorNotes.jsx';
import './cards.css';

// The visit panel's "comfort & connection" block: urgent preferences front and centre (above all once they're
// seated), the latest personal note, "moved by us" strikes, the doctor's notes on this visit (and leaving one from
// the chair), and the office's own labels.
export default function VisitExtras({ appt: a, can }) {
  const date = a.start_time.slice(0, 10);
  const cards = useCardData(date, date);
  const c = useConnection(a.patient_id);
  const x = cards.by_appt?.[a.id];
  const notes = x?.notes || [];
  const labels = cards.layout?.labels || [];
  const [composer, setComposer] = useState(null);
  const [popover, setPopover] = useState(null);
  const urgent = (c?.prefs || []).filter((p) => p.urgent);
  const seated = ['checked_in', 'in_chair'].includes(a.status);
  const canNote = can('schedule:write') || can('clinical:write');
  const toggleLabel = async (l, on) => {
    try {
      await api.post(`/appointments/${a.id}/labels`, { label_key: l.key, on });
      refreshCards();
    } catch (err) { toast(err.message, { tone: 'error' }); }
  };
  return (
    <div className="visit-extras">
      {urgent.length > 0 && (
        <div className={`ve-urgent${seated ? ' seated' : ''}`} role="note" aria-label="Urgent preferences">
          <HandHeart size={16} aria-hidden /> <strong>{urgent.map((p) => p.label).join(' · ')}</strong>
        </div>
      )}
      <ConnectionChips patientId={a.patient_id} />
      {(notes.length > 0 || canNote) && (
        <div className="ve-notes">
          {notes.map((n) => (
            <button key={n.id} type="button" className={`ve-note ${n.status}`} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPopover({ x: r.left, y: r.bottom + 4 }); }}>
              <MessageSquareText size={13} aria-hidden /> <span>{n.body}</span> <span className="muted">— {n.by}</span>
            </button>
          ))}
          {canNote && !['cancelled', 'no_show'].includes(a.status) && (
            <button type="button" className="link-button" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setComposer({ x: r.left, y: r.bottom + 4 }); }}>
              <MessageSquareText size={13} aria-hidden /> Note for the front desk…
            </button>
          )}
        </div>
      )}
      {labels.length > 0 && (
        <div className="ve-labels" aria-label="Office labels">
          <Tag size={13} aria-hidden className="muted" />
          {labels.map((l) => {
            const on = (x?.labels || []).includes(l.key);
            return (
              <button key={l.key} type="button" className={`ve-label${on ? ' on' : ''}`} style={{ '--l': l.color }} aria-pressed={on} disabled={!can('schedule:write')} onClick={() => toggleLabel(l, !on)}>{l.text}</button>
            );
          })}
        </div>
      )}
      {composer && <NoteComposer target={{ kind: 'visit', appt: a }} at={composer} onClose={() => setComposer(null)} />}
      {popover && notes.length > 0 && <NotesPopover notes={notes} at={popover} onClose={() => setPopover(null)} />}
    </div>
  );
}
