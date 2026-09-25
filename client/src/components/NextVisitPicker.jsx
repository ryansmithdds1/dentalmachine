import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { fmtDate, fmtTime } from '../format.js';
import { ErrorBox } from './ui.jsx';

// #16: the next hygiene visit, booked in two keys. Suggests the first open time on the next few days with the
// patient's hygienist, on or after the recall due date, at the time of day closest to `near` (today's visit time,
// so a patient who comes before work keeps coming before work); the first one has focus, so Enter books it.
// Booking goes through POST /appointments with all its usual checks (double-booking, hours, blockouts), so a
// time taken meanwhile is refused and the list refreshes. "Other time…" opens the full form.
export default function NextVisitPicker({ patientId, recall, near, onBooked, onOther, onCancel }) {
  const q = new URLSearchParams({ from: recall.due_date, count: '3', ...(recall.appointment_type_id ? { appointment_type_id: String(recall.appointment_type_id) } : {}), ...(near ? { near } : {}) });
  const { data, error: loadErr, reload } = useApi(`/patients/${patientId}/next-slots?${q}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const book = async (slot) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const appt = await api.post('/appointments', {
        patient_id: patientId, provider_id: data.provider.id, appointment_type_id: recall.appointment_type_id || undefined,
        start_time: slot.start_time, end_time: recall.appointment_type_id ? undefined : slot.end_time, operatory_id: slot.operatory_id || undefined, reason: recall.type_name,
      });
      onBooked(appt, data.provider);
    } catch (e) {
      setErr(e);
      reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inline-panel next-visit-picker" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <header>
        <h3>{recall.type_name} · due {fmtDate(recall.due_date)}</h3>
        <button className="small" onClick={onCancel}>Cancel</button>
      </header>
      <ErrorBox error={loadErr || err} />
      {!data && !loadErr && <div className="muted">Finding open times…</div>}
      {data && (
        <>
          <div className="hint">Open times with {data.provider.name} ({data.duration} min){data.near ? ', near the time of today’s visit' : ''}. Enter books the first, Esc skips.</div>
          <div className="slot-picks">
            {/* The first choice takes focus so Enter books it. */}
            {data.slots.map((s, i) => (
              <button key={s.start_time} className={i === 0 ? 'primary' : ''} autoFocus={i === 0} disabled={busy} onClick={() => book(s)}>
                <strong>{fmtDate(s.start_time.slice(0, 10))} {fmtTime(s.start_time)}</strong>
                <small>{new Date(`${s.start_time.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}</small>
              </button>
            ))}
            <button disabled={busy} onClick={() => onOther(data.slots[0], data.provider)}>Other time…</button>
          </div>
          {!data.slots.length && <p className="muted">No open times with {data.provider.name} in the next four months. Use Other time… to pick one.</p>}
        </>
      )}
    </div>
  );
}
