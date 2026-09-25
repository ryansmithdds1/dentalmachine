import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { fmtDate, fmtTime } from '../../format.js';
import { toast } from '../../toast.js';

// After a cancel or no-show (workflow 19): the next open time for the same patient, type, provider and length,
// right on the schedule — not a form on top of it. Enter books it (the Book button has the focus), "Other time"
// opens the full booking panel, Esc or Not now puts it away; doing nothing leaves the visit unbooked.
export default function RebookBar({ ask, onBooked, onOther, onClose }) {
  const { patient, defaults } = ask;
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const bookRef = useRef(null);
  const otherRef = useRef(null);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ patient_id: patient.id, after: defaults.after || defaults.date });
    if (defaults.appointment_type_id) q.set('appointment_type_id', defaults.appointment_type_id);
    if (defaults.provider_id) q.set('provider_id', defaults.provider_id);
    if (defaults.duration) q.set('duration', defaults.duration);
    api.get(`/appointments/suggest?${q}`).then((r) => { if (live) setS(r); }).catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
  }, [patient.id, defaults.after, defaults.date, defaults.appointment_type_id, defaults.provider_id, defaults.duration]);
  // Enter books the time found; with no time found, Enter opens the full booking panel instead.
  useEffect(() => { if (s) (s.start_time ? bookRef : otherRef).current?.focus({ preventScroll: true }); }, [s]);
  const book = async () => {
    if (!s?.start_time || busy) return;
    setBusy(true);
    try {
      const a = await api.post('/appointments', {
        patient_id: patient.id, provider_id: s.provider_id, operatory_id: s.operatory_id ?? null, appointment_type_id: s.appointment_type_id ?? defaults.appointment_type_id ?? null,
        start_time: s.start_time, end_time: s.end_time, reason: defaults.reason || '', notify: true,
      });
      toast(`${patient.first_name} rebooked for ${fmtDate(s.start_time)} ${fmtTime(s.start_time)}`);
      onBooked(a);
    } catch (e) { setErr(e); setBusy(false); }
  };
  const name = `${patient.first_name} ${patient.last_name}`;
  return (
    <div className="rebook-bar" role="region" aria-label={`Rebook ${name}`} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <strong>Rebook {name}?</strong>
      {!s && !err && <span className="muted">Finding the next opening…</span>}
      {s && !s.start_time && <span className="muted">No opening in the next two months with this provider and length.</span>}
      {s?.start_time && <span>Next opening <strong>{fmtDate(s.start_time)} {fmtTime(s.start_time)}</strong>{s.why && Object.values(s.why).length ? <span className="muted"> ({Object.values(s.why).join(' · ')})</span> : null}</span>}
      {err && <span className="error" style={{ margin: 0 }}>{err.message}</span>}
      <span className="rebook-actions">
        {s?.start_time && <button ref={bookRef} className="small primary" disabled={busy} onClick={book} title="Enter">Book it</button>}
        <button ref={otherRef} className="small" onClick={onOther}>Other time…</button>
        <button className="small" onClick={onClose} title="Esc">Not now</button>
      </span>
    </div>
  );
}
