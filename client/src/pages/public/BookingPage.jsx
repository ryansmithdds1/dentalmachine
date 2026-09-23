import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { fmtTime, shiftDate } from '../../format.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';

export default function BookingPage() {
  const { slug } = useParams();
  const [practice, setPractice] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [reason, setReason] = useState('');
  const [providerId, setProviderId] = useState('');
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState(null);
  const [slot, setSlot] = useState(null);
  const [form, setForm] = useState({ first_name: '', last_name: '', dob: '', phone: '', email: '', notes: '', new_patient: true, website: '' });
  const [done, setDone] = useState(false);

  useEffect(() => {
    api.get(`/public/practices/${slug}`).then((p) => {
      setPractice(p);
      setReason(p.reasons[0].label);
      let first = shiftDate(p.today, 1);
      while ([0, 6].includes(new Date(`${first}T12:00:00Z`).getUTCDay())) first = shiftDate(first, 1);
      setDate(first);
    }).catch(setLoadError);
  }, [slug]);

  useEffect(() => {
    if (!practice || !date) return;
    setSlots(null);
    setSlot(null);
    const q = new URLSearchParams({ date, reason, ...(providerId ? { provider_id: providerId } : {}) });
    api.get(`/public/practices/${slug}/availability?${q}`).then((r) => setSlots(r.slots)).catch(() => setSlots([]));
  }, [practice, slug, date, reason, providerId]);

  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/public/practices/${slug}/booking-requests`, { ...form, reason, start: slot.start, provider_id: slot.provider_id });
    setDone(true);
  });

  if (loadError) return <PublicLayout title="Online booking"><ErrorBox error={loadError} /></PublicLayout>;
  if (!practice) return <PublicLayout title="Online booking"><p>Loading…</p></PublicLayout>;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  if (done) {
    return (
      <PublicLayout title="Request received" practice={practice}>
        <div className="public-notice ok">
          Thanks, {form.first_name}! We&apos;ve received your request for {new Date(`${slot.start.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} at {fmtTime(slot.start)}.
          We&apos;ll confirm by {form.phone ? 'text' : 'email'} shortly.
        </div>
      </PublicLayout>
    );
  }

  // Office is closed weekends (the server enforces this too).
  const days = Array.from({ length: 20 }, (_, i) => shiftDate(practice.today, i + 1))
    .filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())).slice(0, 14);

  return (
    <PublicLayout title="Book an appointment" practice={practice}>
      <div className="card">
        <h2>1. What do you need?</h2>
        <div className="choice-grid">
          {practice.reasons.map((r) => (
            <button key={r.label} className={`choice${reason === r.label ? ' selected' : ''}`} onClick={() => setReason(r.label)}>
              {r.label}<span className="muted">{r.duration} min</span>
            </button>
          ))}
        </div>
        {practice.providers.length > 1 && (
          <label style={{ marginTop: 12 }}>
            Provider
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">No preference</option>
              {practice.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="card">
        <h2>2. Pick a time</h2>
        <div className="day-strip">
          {days.map((d) => {
            const dt = new Date(`${d}T12:00:00`);
            return (
              <button key={d} className={`day${d === date ? ' selected' : ''}`} onClick={() => setDate(d)}>
                <span>{dt.toLocaleDateString('en-US', { weekday: 'short' })}</span>
                <strong>{dt.getDate()}</strong>
                <span>{dt.toLocaleDateString('en-US', { month: 'short' })}</span>
              </button>
            );
          })}
        </div>
        {slots === null && <p className="muted">Checking availability…</p>}
        {slots?.length === 0 && <p className="muted">No openings this day. Try another date.</p>}
        <div className="slot-grid">
          {slots?.map((s) => (
            <button key={`${s.start}-${s.provider_id}`} className={`choice${slot === s ? ' selected' : ''}`} onClick={() => setSlot(s)}>
              {fmtTime(s.start)}
              {!providerId && practice.providers.length > 1 && <span className="muted">{s.provider_name}</span>}
            </button>
          ))}
        </div>
      </div>

      {slot && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <h2>3. Your details</h2>
          <ErrorBox error={error} />
          <div className="form-grid">
            <label>First name *<input required value={form.first_name} onChange={set('first_name')} autoComplete="given-name" /></label>
            <label>Last name *<input required value={form.last_name} onChange={set('last_name')} autoComplete="family-name" /></label>
            <label>Date of birth<input type="date" value={form.dob} onChange={set('dob')} /></label>
            <label>Mobile phone<input type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" /></label>
            <label className="full">Email<input type="email" value={form.email} onChange={set('email')} autoComplete="email" /></label>
            <label className="full">Anything we should know? (optional)<textarea rows={2} value={form.notes} onChange={set('notes')} /></label>
            <label className="checkbox full"><input type="checkbox" checked={form.new_patient} onChange={(e) => setForm({ ...form, new_patient: e.target.checked })} /> I&apos;m a new patient</label>
            {/* Hidden from people; bots fill it in. */}
            <input tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} style={{ position: 'absolute', left: -9999 }} aria-hidden="true" />
          </div>
          <p className="muted" style={{ fontSize: 12 }}>Please don&apos;t include medical details here. We&apos;ll send you secure forms before your visit.</p>
          <button className="primary big" disabled={busy}>Request {fmtTime(slot.start)} on {new Date(`${slot.start.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</button>
        </form>
      )}
    </PublicLayout>
  );
}
