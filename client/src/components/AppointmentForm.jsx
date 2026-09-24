import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useLookup } from '../hooks.js';
import { fmtTime, fmtDate } from '../format.js';
import { useActivePatient } from '../activePatient.jsx';
import { useRemembered } from '../prefs.js';
import { ErrorBox, PatientPicker, useSubmit } from './ui.jsx';
import './calendar/workflow.css';

export const REPEATS = [
  { value: '', label: 'Does not repeat' },
  { value: 'w1', label: 'Every week', every: 1, unit: 'week' },
  { value: 'w2', label: 'Every 2 weeks', every: 2, unit: 'week' },
  { value: 'w3', label: 'Every 3 weeks', every: 3, unit: 'week' },
  { value: 'w4', label: 'Every 4 weeks', every: 4, unit: 'week' },
  { value: 'm1', label: 'Every month (same date)', every: 1, unit: 'month' },
  { value: 'mw', label: 'Every month (same weekday, e.g. 2nd Tuesday)', every: 1, unit: 'month', monthly_by: 'weekday' },
  { value: 'm3', label: 'Every 3 months', every: 3, unit: 'month' },
  { value: 'm6', label: 'Every 6 months', every: 6, unit: 'month' },
];
const STATUSES = ['scheduled', 'confirmed', 'checked_in', 'in_chair', 'completed', 'cancelled', 'no_show'];
const addMinutes = (hhmm, mins) => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = Math.min(h * 60 + m + mins, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const diffMinutes = (a, b) => {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return bh * 60 + bm - (ah * 60 + am);
};

// Booking (workflow 9, docs/workflows/specs/09-book.md): once the patient is known, everything else defaults —
// their own provider (hygienist for a hygiene type), the type's length, the provider's usual chair (or the one
// this person used last with them), a due recall's visit type, and the next open time (unless a time was
// dragged on the schedule). The Book button then has the focus, so Enter books it.
export default function AppointmentForm({ appointment, defaults = {}, patient: initialPatient, onSaved, onCancel, onBlock }) {
  const providers = useLookup('/providers?active=true');
  const operatories = useLookup('/operatories?active=true');
  const types = useLookup('/appointment-types?active=true');
  const [patient, setPatient] = useState(initialPatient || (appointment ? { id: appointment.patient_id, first_name: appointment.first_name, last_name: appointment.last_name } : null));
  // The patient being worked on elsewhere in the app: one click (or Alt+B) books for them.
  const { patientId: activeId, recent } = useActivePatient();
  const activePatient = !appointment && !patient && activeId ? recent.find((p) => p.id === activeId) : null;
  const startTime = appointment?.start_time.slice(11, 16) || defaults.time || '09:00';
  const [form, setForm] = useState({
    date: appointment?.start_time.slice(0, 10) || defaults.date,
    time: startTime,
    duration: appointment ? diffMinutes(startTime, appointment.end_time.slice(11, 16)) : defaults.end ? diffMinutes(startTime, defaults.end) : defaults.duration || 60,
    appointment_type_id: appointment?.appointment_type_id || defaults.appointment_type_id || '',
    asap: !!appointment?.asap,
    video: !!appointment?.video_url,
    notify: true,
    provider_id: appointment?.provider_id || defaults.provider_id || '',
    operatory_id: appointment?.operatory_id || defaults.operatory_id || '',
    status: appointment?.status || 'scheduled',
    reason: appointment?.reason || defaults.reason || '',
    notes: appointment?.notes || '',
  });
  const [planned, setPlanned] = useState([]);
  // Booking a treatment plan phase arrives with its procedures already picked.
  const [selectedProcs, setSelectedProcs] = useState(defaults.procedure_ids || []);
  const [slots, setSlots] = useState(null);
  const [override, setOverride] = useState(null);
  const [repeat, setRepeat] = useState({ rule: '', count: 6, end: 'count', until: '' });
  const [scope, setScope] = useState('this');
  // Fields the person set themselves keep their value; the rest follow the suggestion.
  const [touched, setTouched] = useState({});
  const touch = (k) => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  const isNew = !appointment;
  const fixedTime = !!defaults.time; // a slot dragged or clicked on the schedule keeps its time
  const [lastChair, rememberChair] = useRemembered(form.provider_id ? `book.chair@provider:${form.provider_id}` : null, '');
  const [suggested, setSuggested] = useState(null);
  const [later, setLater] = useState(null); // "Another time": search after the one shown
  const bookRef = useRef(null);
  const keepType = touched.type || !!defaults.appointment_type_id;
  const keepProvider = touched.provider || !!defaults.provider_id;
  const keepChair = touched.chair || !!defaults.operatory_id;
  const keepLength = touched.duration || !!defaults.end || !!defaults.duration;
  const timeFixed = fixedTime || touched.time;
  // Only what the person chose goes into the question, so a suggestion never re-triggers itself.
  const suggestKey = isNew && patient ? JSON.stringify([
    patient.id, keepType ? form.appointment_type_id : '', keepProvider ? form.provider_id : '', keepChair ? form.operatory_id : '', keepLength ? form.duration : '',
    timeFixed ? `${form.date} ${form.time}` : '', touched.date ? form.date : '', later || '',
  ]) : null;
  const [loadedKey, setLoadedKey] = useState(null);
  useEffect(() => {
    if (!suggestKey) return undefined;
    let live = true;
    const q = new URLSearchParams({ patient_id: patient.id });
    if (keepType && form.appointment_type_id) q.set('appointment_type_id', form.appointment_type_id);
    if (!keepType) q.set('pick_type', '1');
    if (keepProvider && form.provider_id) q.set('provider_id', form.provider_id);
    if (keepChair && form.operatory_id) q.set('operatory_id', form.operatory_id);
    if (keepLength) q.set('duration', form.duration);
    if (lastChair) q.set('last_chair', lastChair);
    if (timeFixed) q.set('start_time', `${form.date} ${form.time}`);
    else q.set('after', later || (touched.date ? form.date : defaults.after || defaults.date || ''));
    api.get(`/appointments/suggest?${q}`).then((s) => {
      if (!live) return;
      // A chair's usual provider beats a guess (nobody on file and no history) when the slot was dragged into that chair.
      const provider = s.provider_source === 'default' && defaults.chair_provider_id ? defaults.chair_provider_id : s.provider_id;
      setForm((f) => ({
        ...f,
        ...(!keepProvider && provider ? { provider_id: provider } : {}),
        ...(!keepChair && s.operatory_id ? { operatory_id: s.operatory_id } : {}),
        ...(!keepType && s.appointment_type_id ? { appointment_type_id: s.appointment_type_id } : {}),
        ...(!keepLength && s.duration ? { duration: s.duration } : {}),
        ...(!timeFixed && s.start_time ? { date: s.start_time.slice(0, 10), time: s.start_time.slice(11, 16) } : {}),
      }));
      setSuggested(s);
      setLoadedKey(suggestKey);
      // Enter books it — unless the person is busy in another field.
      const el = document.activeElement;
      focusBook.current = !el || el === document.body || !el.closest?.('input, textarea, select');
    }).catch(() => { if (live) { setSuggested(null); setLoadedKey(suggestKey); } });
    return () => { live = false; };
  }, [suggestKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = isNew && !!patient && loadedKey !== suggestKey;
  // Start in the patient search (the dialog focuses its first button, the ✕, after this form mounts).
  const formRef = useRef(null);
  useEffect(() => {
    if (!isNew || patient) return undefined;
    const t = setTimeout(() => formRef.current?.querySelector('input[aria-label="Find a patient"]')?.focus(), 0);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const focusBook = useRef(false);
  useEffect(() => {
    if (!waiting && focusBook.current) bookRef.current?.focus();
    focusBook.current = false;
  }, [loadedKey, waiting]);
  // How long a type takes with a provider (the type can set its own length per provider).
  const lengthFor = (t, providerId) => {
    try { return JSON.parse(t.provider_durations || '{}')[providerId] || t.duration; } catch { return t.duration; }
  };
  const chooseType = (id) => {
    touch('type');
    const t = types.find((x) => String(x.id) === String(id));
    // A dragged selection keeps its length; otherwise the type sets it.
    setForm((f) => ({ ...f, appointment_type_id: id, ...(t && !(defaults.end && !appointment) ? { duration: lengthFor(t, f.provider_id) } : {}), ...(t && !f.reason ? { reason: '' } : {}) }));
  };
  const chooseProvider = (e) => {
    const providerId = e.target.value;
    touch('provider');
    const t = types.find((x) => String(x.id) === String(form.appointment_type_id));
    setForm((f) => ({ ...f, provider_id: providerId, ...(t && !appointment && !defaults.end ? { duration: lengthFor(t, providerId) } : {}) }));
  };

  useEffect(() => {
    if (!form.provider_id && providers.length) setForm((f) => ({ ...f, provider_id: providers[0].id }));
  }, [providers, form.provider_id]);
  // A type handed in (booking a recall at checkout, a plan phase) sets the length once the types load, unless a
  // length or a dragged time range came with it.
  useEffect(() => {
    if (appointment || !defaults.appointment_type_id || defaults.duration || defaults.end || !types.length) return;
    const t = types.find((x) => String(x.id) === String(defaults.appointment_type_id));
    if (t) setForm((f) => ({ ...f, duration: lengthFor(t, f.provider_id) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.length]);

  useEffect(() => {
    if (!patient || appointment) return;
    api.get(`/patients/${patient.id}/procedures?status=planned`).then((rows) => setPlanned(rows.filter((p) => !p.appointment_id))).catch(() => setPlanned([]));
  }, [patient, appointment]);

  const { submit, busy, error } = useSubmit(async (forceBlockout = false) => {
    if (!patient) throw new Error('Select a patient');
    setOverride(null);
    const body = {
      appointment_type_id: form.appointment_type_id ? Number(form.appointment_type_id) : null,
      asap: form.asap,
      video: form.video,
      notify: form.notify,
      ...(forceBlockout ? { override_blockout: true } : {}),
      patient_id: patient.id,
      provider_id: Number(form.provider_id),
      operatory_id: form.operatory_id ? Number(form.operatory_id) : null,
      start_time: `${form.date} ${form.time}`,
      end_time: `${form.date} ${addMinutes(form.time, Number(form.duration))}`,
      status: form.status,
      reason: form.reason,
      notes: form.notes,
    };
    const rule = repeat.rule ? REPEATS.find((r) => r.value === repeat.rule) : null;
    try {
      const saved = appointment
        ? await api.put(`/appointments/${appointment.id}`, { ...body, ...(appointment.series_id && scope === 'following' ? { scope: 'following' } : {}) })
        : await api.post('/appointments', { ...body, procedure_ids: selectedProcs, ...(rule ? { repeat: { every: rule.every, unit: rule.unit, ...(rule.monthly_by ? { monthly_by: rule.monthly_by } : {}), ...(repeat.end === 'until' ? { until: repeat.until } : { count: Number(repeat.count) }) } } : {}) });
      if (form.operatory_id) rememberChair(Number(form.operatory_id));
      const report = saved.series || saved.series_update;
      if (report?.skipped?.length) {
        alert(`${saved.series ? `Booked ${report.created} visits.` : `Updated ${report.updated} later visits.`} These couldn't be booked:\n\n${report.skipped.map((s) => `• ${s.start_time.slice(0, 10)} ${fmtTime(s.start_time)} — ${s.reason}`).join('\n')}`);
      }
      onSaved(saved);
    } catch (e) {
      if (e.details?.can_override) setOverride(e.message);
      throw e;
    }
  });

  // Every open start time that day (on the 10-minute grid), not just the hours and half hours.
  const findSlots = async () => {
    const r = await api.get(`/availability?date=${form.date}&provider_id=${form.provider_id}&duration=${form.duration}${form.appointment_type_id ? `&appointment_type_id=${form.appointment_type_id}` : ''}`);
    setSlots(r.slots);
  };

  const set = (k, t = k) => (e) => { touch(t); setForm({ ...form, [k]: e.target.value }); };
  const chairName = (id) => operatories.find((o) => String(o.id) === String(id))?.name;
  const providerName = (id) => providers.find((p) => String(p.id) === String(id))?.name;

  return (
    <form ref={formRef} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      {override && (
        <div className="inline" style={{ marginTop: -6, marginBottom: 12 }}>
          <button type="button" className="small" onClick={() => submit(true)}>Book it anyway</button>
        </div>
      )}
      <div className="form-grid">
        <label className="full">
          Patient
          {appointment ? <strong style={{ color: 'var(--text)' }}>{patient.first_name} {patient.last_name}</strong> : <PatientPicker value={patient} onChange={setPatient} />}
        </label>
        {activePatient && (
          // Outside the label: a click on a label's button would also "click" the picker's Change button after it.
          <div className="full book-active-row">
            <button type="button" className="small book-active" onClick={() => setPatient(activePatient)} title="The patient you're working with (Alt+B)">
              Book for {activePatient.first_name} {activePatient.last_name}
            </button>
          </div>
        )}
        {isNew && patient && (
          // What was filled in and why, and the time it found; "Another time" looks for the next one.
          <div className="full book-suggest" aria-live="polite">
            {waiting ? <span className="muted">Finding the next opening…</span> : suggested && (
              <>
                <span>
                  {timeFixed ? 'Booking' : suggested.start_time ? 'Next opening:' : 'No opening in the next two months for this provider and length.'}
                  {(timeFixed || suggested.start_time) && <strong> {fmtDate(`${form.date} ${form.time}`)} {fmtTime(`${form.date} ${form.time}`)}</strong>}
                  {' '}with {providerName(form.provider_id) || 'the provider'}{form.operatory_id ? ` in ${chairName(form.operatory_id) || 'the chair'}` : ''}
                </span>
                {Object.values(suggested.why || {}).length > 0 && <span className="muted"> ({Object.values(suggested.why).join(' · ')})</span>}
                {!timeFixed && suggested.start_time && <button type="button" className="link" onClick={() => setLater(`${form.date} ${form.time}`)}>Another time</button>}
              </>
            )}
          </div>
        )}
        <label className="full">
          Appointment type
          <select value={form.appointment_type_id} onChange={(e) => chooseType(e.target.value)} aria-label="Appointment type">
            <option value="">— None —</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.duration} min)</option>)}
          </select>
        </label>
        <label>Date<input type="date" required value={form.date} onChange={(e) => { setLater(null); set('date')(e); }} /></label>
        <label>Start time<input type="time" required step={600} value={form.time} onChange={set('time')} /></label>
        <label>
          Length
          <select value={form.duration} onChange={set('duration')} aria-label="Length">
            {[...new Set([10, 15, 20, 30, 40, 45, 60, 75, 90, 120, 150, 180, Number(form.duration)])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
        </label>
        <label>
          Provider
          <select required value={form.provider_id} onChange={chooseProvider}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>
          Operatory
          <select value={form.operatory_id} onChange={set('operatory_id', 'chair')} aria-label="Chair">
            <option value="">—</option>
            {operatories.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        {/* A new booking is always "scheduled"; the status only changes on a visit that exists. */}
        {!isNew && (
          <label>
            Status
            <select value={form.status} onChange={set('status')}>
              {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          </label>
        )}
        <label className="full">Reason<input value={form.reason} onChange={set('reason')} placeholder="e.g. Recall exam & cleaning" /></label>
        <label className="full">Notes<textarea rows={2} value={form.notes} onChange={set('notes')} /></label>
        <label className="checkbox full"><input type="checkbox" checked={form.video} onChange={(e) => setForm({ ...form, video: e.target.checked })} /> Video visit (the patient gets a link to join)</label>
        <label className="checkbox full"><input type="checkbox" checked={form.asap} onChange={(e) => setForm({ ...form, asap: e.target.checked })} /> Add to ASAP list (patient wants an earlier opening)</label>
        <label className="checkbox full"><input type="checkbox" checked={form.notify} onChange={(e) => setForm({ ...form, notify: e.target.checked })} /> Let the patient know {appointment ? 'if the time changes' : 'it’s booked'} (text or email, with the confirm link)</label>
        {!appointment && (
          <div className="full repeat-row">
            <label>
              Repeat
              <select value={repeat.rule} onChange={(e) => setRepeat({ ...repeat, rule: e.target.value })}>
                {REPEATS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </label>
            {repeat.rule && (
              <label>
                Ends
                <select value={repeat.end} onChange={(e) => setRepeat({ ...repeat, end: e.target.value })}>
                  <option value="count">After a number of visits</option>
                  <option value="until">On a date</option>
                </select>
              </label>
            )}
            {repeat.rule && repeat.end === 'count' && (
              <label>
                Number of visits
                <input type="number" min={2} max={52} value={repeat.count} onChange={(e) => setRepeat({ ...repeat, count: e.target.value })} />
              </label>
            )}
            {repeat.rule && repeat.end === 'until' && (
              <label>
                Last visit by
                <input type="date" required min={form.date} value={repeat.until} onChange={(e) => setRepeat({ ...repeat, until: e.target.value })} />
              </label>
            )}
            {repeat.rule && <span className="muted repeat-hint">Times that are taken are skipped and listed after booking.</span>}
          </div>
        )}
        {appointment?.series_id && (
          <div className="full seg-choice">
            <span className="muted">Apply changes to</span>
            <div className="seg">
              <button type="button" className={scope === 'this' ? 'active' : ''} onClick={() => setScope('this')}>This visit</button>
              <button type="button" className={scope === 'following' ? 'active' : ''} onClick={() => setScope('following')}>This and following</button>
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 10 }}>
        <button type="button" className="small" onClick={findSlots} disabled={!form.provider_id || !form.date}>Find open times</button>
        {slots && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {slots.length === 0 && <span className="muted">No openings for this length.</span>}
            {slots.map((s) => (
              <button type="button" key={s} className="small" onClick={() => { touch('time'); setForm({ ...form, time: s.slice(11) }); }}>{fmtTime(s)}</button>
            ))}
          </div>
        )}
      </div>

      {!appointment && planned.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3>Schedule planned treatment</h3>
          {planned.map((p) => (
            <label key={p.id} className="checkbox" style={{ color: 'var(--text)' }}>
              <input type="checkbox" checked={selectedProcs.includes(p.id)}
                onChange={(e) => setSelectedProcs(e.target.checked ? [...selectedProcs, p.id] : selectedProcs.filter((x) => x !== p.id))} />
              {p.code} {p.description} {p.tooth ? `#${p.tooth}` : ''} {p.surfaces || ''}
            </label>
          ))}
        </div>
      )}

      <div className="form-actions">
        {onBlock && !appointment && <button type="button" className="link" style={{ marginRight: 'auto' }} onClick={onBlock}>Block this time instead</button>}
        <button type="button" onClick={onCancel}>Cancel</button>
        <button ref={bookRef} className="primary" disabled={busy || waiting}>{busy ? 'Saving…' : appointment ? 'Save changes' : 'Book appointment'}</button>
      </div>
    </form>
  );
}
