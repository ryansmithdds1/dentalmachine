import { useState } from 'react';
import { api } from '../../api.js';
import { toast } from '../../toast.js';
import './phones.css';

export const NO_BOOK_REASONS = { cost: 'Cost', time: 'No time that works', insurance: 'Insurance', shopping: 'Just shopping', think: 'Wants to think', other: 'Other' };

// Why a caller didn't book (PH4): the AI's suggestion (dashed, labelled) is one click to confirm; any other reason
// is one click too ("Other" asks for a few words). Saved at once; changing it later is recorded.
export default function NoBookReason({ callId, suggested = null, quote = null, current = null, onSaved }) {
  const [reason, setReason] = useState(current);
  const [other, setOther] = useState(false);
  const [note, setNote] = useState('');
  const save = async (r, n = null) => {
    try {
      await api.post(`/phones/calls/${callId}/no-book`, { reason: r, note: n });
      setReason(r);
      setOther(false);
      toast(`Noted: didn’t book — ${NO_BOOK_REASONS[r].toLowerCase()}`);
      onSaved?.(r);
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  return (
    <div className="reason-chips" role="group" aria-label="Why didn’t they book?">
      <span className="muted">{reason ? 'Didn’t book:' : 'Didn’t book — why?'}</span>
      {Object.entries(NO_BOOK_REASONS).map(([k, label]) => (
        <button key={k} type="button" className={`chip${reason === k ? ' on' : ''}${!reason && suggested === k ? ' suggested' : ''}`} aria-pressed={reason === k}
          title={!reason && suggested === k ? `AI suggestion${quote ? `: “${quote}”` : ''}` : undefined}
          onClick={() => (k === 'other' ? setOther(true) : save(k))}>{label}{!reason && suggested === k ? ' · AI' : ''}</button>
      ))}
      {other && (
        <form onSubmit={(e) => { e.preventDefault(); if (note.trim()) save('other', note.trim()); }} style={{ display: 'flex', gap: 4, width: '100%' }}>
          <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="A few words" aria-label="Other reason" style={{ flex: 1 }} />
          <button className="small primary" disabled={!note.trim()}>Save</button>
        </form>
      )}
    </div>
  );
}
