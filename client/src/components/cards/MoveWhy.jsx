import { useEffect, useState } from 'react';
import { CalendarX2, X } from 'lucide-react';
import { api } from '../../api.js';
import { toast } from '../../toast.js';
import { refreshCards } from './cardData.js';
import './cards.css';

// Right after a visit is moved on the schedule: "Whose reason?" (S8). Doing nothing means it was the patient's
// (nothing is recorded); picking an office reason records the move as ours — it counts on the patient
// ("Moved by us 2× in 12 mo") and in the report. It never blocks the move and goes away by itself.
export const OFFICE_REASONS = [['provider_sick', 'Provider sick'], ['emergency', 'Emergency'], ['double_booked', 'Double-booked'], ['equipment_down', 'Equipment down']];

export default function MoveWhy({ appt, warning, onClose }) {
  const [other, setOther] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (other) return undefined;
    const t = setTimeout(onClose, 15000);
    return () => clearTimeout(t);
  }, [onClose, other]);
  const record = async (reason) => {
    if (busy) return;
    setBusy(true);
    const send = () => api.post(`/appointments/${appt.id}/office-move`, { reason, ...(reason === 'other' ? { note } : {}) });
    try {
      // The move itself may still be saving: try again once if the server hasn't seen it yet.
      await send().catch(async (err) => { if (err.status !== 409) throw err; await new Promise((r) => setTimeout(r, 900)); return send(); });
      toast(`Noted: we moved ${appt.first_name}${reason === 'other' ? '' : ` (${OFFICE_REASONS.find(([k]) => k === reason)[1].toLowerCase()})`}`);
      refreshCards();
      onClose();
    } catch (err) {
      toast(err.message, { tone: 'error' });
      setBusy(false);
    }
  };
  return (
    <div className="move-why no-print" role="status" aria-label="Whose reason was the move?">
      <span>Moved <strong>{appt.first_name} {appt.last_name}</strong> — whose reason?</span>
      <button type="button" className="small" onClick={onClose}>Patient’s</button>
      <span className="why-office"><CalendarX2 size={13} aria-hidden /> Ours:</span>
      {OFFICE_REASONS.map(([k, l]) => <button key={k} type="button" className="small" disabled={busy} onClick={() => record(k)}>{l}</button>)}
      {!other ? <button type="button" className="small" onClick={() => setOther(true)}>Other…</button> : (
        <form className="inline" onSubmit={(e) => { e.preventDefault(); if (note.trim()) record('other'); }}>
          <input autoFocus value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="What happened?" aria-label="What happened" />
          <button className="small" disabled={!note.trim() || busy}>Save</button>
        </form>
      )}
      {warning && <span className="cc-strike-badge" title={warning}>{warning}</span>}
      <button type="button" className="icon-btn tiny" onClick={onClose} aria-label="Dismiss"><X size={14} /></button>
    </div>
  );
}
