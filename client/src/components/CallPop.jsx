import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PhoneIncoming, X } from 'lucide-react';
import { api } from '../api.js';
import { useLiveEvents } from '../live.js';
import { money, fmtDateTime } from '../format.js';

// The screen pop: when the office line rings, who it is (matched by caller ID), what they owe and when
// they're next in — before anyone picks up.
export default function CallPop() {
  const [calls, setCalls] = useState([]);
  const drop = (id) => setCalls((list) => list.filter((c) => c.call_id !== id));
  useLiveEvents(async (e) => {
    if (e.type !== 'call') return;
    if (e.event === 'ringing') {
      let card = null;
      try { card = (await api.get(`/calls/${e.call_id}`)).card; } catch { /* no access to patients: number only */ }
      setCalls((list) => [...list.filter((c) => c.call_id !== e.call_id), { ...e, card }].slice(-3));
      setTimeout(() => drop(e.call_id), 90_000);
    } else if (e.event === 'ended' || e.event === 'missed') {
      setTimeout(() => drop(e.call_id), e.event === 'missed' ? 15_000 : 4000);
      setCalls((list) => list.map((c) => (c.call_id === e.call_id ? { ...c, state: e.event } : c)));
    }
  });
  if (!calls.length) return null;
  return (
    <div className="call-pop-stack" role="status" aria-live="polite">
      {calls.map((c) => (
        <div key={c.call_id} className="call-pop card">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <strong><PhoneIncoming size={16} /> {c.state === 'missed' ? 'Missed call' : c.state === 'ended' ? 'Call ended' : 'Incoming call'}</strong>
            <button type="button" className="link" aria-label="Dismiss" onClick={() => drop(c.call_id)}><X size={16} /></button>
          </div>
          {c.card ? (
            <>
              <div style={{ fontSize: 16, marginTop: 4 }}><Link to={`/patients/${c.card.id}`} onClick={() => drop(c.call_id)}>{c.card.preferred_name || c.card.first_name} {c.card.last_name}</Link></div>
              <div className="muted" style={{ fontSize: 12 }}>{c.from}{c.card.household.length ? ` · family: ${c.card.household.map((h) => h.first_name).join(', ')}` : ''}</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>
                {c.card.balance > 0 && <div>Balance <strong>{money(c.card.balance)}</strong></div>}
                <div>Next visit: {c.card.next_visit ? `${fmtDateTime(c.card.next_visit.start_time)}${c.card.next_visit.reason ? ` · ${c.card.next_visit.reason}` : ''}` : <span className="text-warn">none scheduled</span>}</div>
                {c.card.last_visit && <div className="muted">Last seen {fmtDateTime(c.card.last_visit).split(' ')[0]}</div>}
              </div>
            </>
          ) : (
            <div style={{ marginTop: 4 }}>{c.patient?.name || c.from} <div className="muted" style={{ fontSize: 12 }}>{c.patient ? c.from : 'Not a patient on file'}</div></div>
          )}
        </div>
      ))}
    </div>
  );
}
