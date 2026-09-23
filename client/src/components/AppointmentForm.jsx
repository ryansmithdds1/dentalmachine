import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLookup } from '../hooks.js';
import { fmtTime } from '../format.js';
import { ErrorBox, PatientPicker, useSubmit } from './ui.jsx';

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

export default function AppointmentForm({ appointment, defaults = {}, patient: initialPatient, onSaved, onCancel }) {
  const providers = useLookup('/providers?active=true');
  const operatories = useLookup('/operatories?active=true');
  const [patient, setPatient] = useState(initialPatient || (appointment ? { id: appointment.patient_id, first_name: appointment.first_name, last_name: appointment.last_name } : null));
  const startTime = appointment?.start_time.slice(11, 16) || defaults.time || '09:00';
  const [form, setForm] = useState({
    date: appointment?.start_time.slice(0, 10) || defaults.date,
    time: startTime,
    duration: appointment ? diffMinutes(startTime, appointment.end_time.slice(11, 16)) : 60,
    provider_id: appointment?.provider_id || defaults.provider_id || '',
    operatory_id: appointment?.operatory_id || defaults.operatory_id || '',
    status: appointment?.status || 'scheduled',
    reason: appointment?.reason || '',
    notes: appointment?.notes || '',
  });
  const [planned, setPlanned] = useState([]);
  const [selectedProcs, setSelectedProcs] = useState([]);
  const [slots, setSlots] = useState(null);

  useEffect(() => {
    if (!form.provider_id && providers.length) setForm((f) => ({ ...f, provider_id: providers[0].id }));
  }, [providers, form.provider_id]);

  useEffect(() => {
    if (!patient || appointment) return;
    api.get(`/patients/${patient.id}/procedures?status=planned`).then((rows) => setPlanned(rows.filter((p) => !p.appointment_id))).catch(() => setPlanned([]));
  }, [patient, appointment]);

  const { submit, busy, error } = useSubmit(async () => {
    if (!patient) throw new Error('Select a patient');
    const body = {
      patient_id: patient.id,
      provider_id: Number(form.provider_id),
      operatory_id: form.operatory_id ? Number(form.operatory_id) : null,
      start_time: `${form.date} ${form.time}`,
      end_time: `${form.date} ${addMinutes(form.time, Number(form.duration))}`,
      status: form.status,
      reason: form.reason,
      notes: form.notes,
    };
    const saved = appointment
      ? await api.put(`/appointments/${appointment.id}`, body)
      : await api.post('/appointments', { ...body, procedure_ids: selectedProcs });
    onSaved(saved);
  });

  const findSlots = async () => {
    const r = await api.get(`/availability?date=${form.date}&provider_id=${form.provider_id}&duration=${form.duration}`);
    setSlots(r.slots.filter((s) => s.endsWith(':00') || s.endsWith(':30')));
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label className="full">
          Patient
          {appointment ? <strong style={{ color: 'var(--text)' }}>{patient.first_name} {patient.last_name}</strong> : <PatientPicker value={patient} onChange={setPatient} />}
        </label>
        <label>Date<input type="date" required value={form.date} onChange={set('date')} /></label>
        <label>Start time<input type="time" required step={600} value={form.time} onChange={set('time')} /></label>
        <label>
          Length
          <select value={form.duration} onChange={set('duration')}>
            {[10, 15, 20, 30, 40, 45, 60, 75, 90, 120, 150, 180].map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
        </label>
        <label>
          Provider
          <select required value={form.provider_id} onChange={set('provider_id')}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>
          Operatory
          <select value={form.operatory_id} onChange={set('operatory_id')}>
            <option value="">—</option>
            {operatories.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <label>
          Status
          <select value={form.status} onChange={set('status')}>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
        </label>
        <label className="full">Reason<input value={form.reason} onChange={set('reason')} placeholder="e.g. Recall exam & cleaning" /></label>
        <label className="full">Notes<textarea rows={2} value={form.notes} onChange={set('notes')} /></label>
      </div>

      <div style={{ marginTop: 10 }}>
        <button type="button" className="small" onClick={findSlots} disabled={!form.provider_id || !form.date}>Find open times</button>
        {slots && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {slots.length === 0 && <span className="muted">No openings for this length.</span>}
            {slots.map((s) => (
              <button type="button" key={s} className="small" onClick={() => setForm({ ...form, time: s.slice(11) })}>{fmtTime(s)}</button>
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
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : appointment ? 'Save changes' : 'Book appointment'}</button>
      </div>
    </form>
  );
}
