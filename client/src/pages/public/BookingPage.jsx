import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { shiftDate } from '../../format.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import { fmtDateL, fmtTimeL, useLang, useT, HEARD_FROM } from './i18n.js';

export default function BookingPage() {
  const t = useT();
  const lang = useLang();
  const { slug } = useParams();
  const [practice, setPractice] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [reason, setReason] = useState('');
  const [providerId, setProviderId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState(null);
  const [nextAvailable, setNextAvailable] = useState(null);
  const jumped = useRef(false);
  const [slot, setSlot] = useState(null);
  const [form, setForm] = useState({ first_name: '', last_name: '', dob: '', phone: '', email: '', notes: '', new_patient: true, website: '', insurance_carrier: '', insurance_member_id: '', insurance_subscriber: '', referral_source: '' });
  const [done, setDone] = useState(false);
  const [params] = useSearchParams();
  const returned = params.get('deposit');

  useEffect(() => {
    api.get(`/public/practices/${slug}`).then((p) => {
      setPractice(p);
      setReason(p.reasons[0].label);
      // Offices: one is picked for the patient; with several, a link can name one (?location=).
      const office = p.locations?.length === 1 ? p.locations[0] : p.locations?.find((l) => String(l.id) === params.get('location'));
      if (office) setLocationId(String(office.id));
      const open = office?.open_days || p.open_days || [1, 2, 3, 4, 5];
      let first = shiftDate(p.today, 1);
      for (let i = 0; i < 14 && !open.includes(new Date(`${first}T12:00:00Z`).getUTCDay()); i++) first = shiftDate(first, 1);
      setDate(first);
    }).catch(setLoadError);
  }, [slug]);

  useEffect(() => {
    if (!practice || !date) return;
    setSlots(null);
    setSlot(null);
    if (practice.locations?.length > 1 && !locationId) return;
    const q = new URLSearchParams({ date, reason, ...(providerId ? { provider_id: providerId } : {}), ...(locationId ? { location_id: locationId } : {}) });
    api.get(`/public/practices/${slug}/availability?${q}`).then((r) => {
      // First load: jump straight to the first day with openings.
      if (!r.slots.length && r.next_available && !jumped.current) {
        jumped.current = true;
        setDate(r.next_available);
        return;
      }
      jumped.current = true;
      setSlots(r.slots);
      setNextAvailable(r.next_available);
    }).catch(() => setSlots([]));
  }, [practice, slug, date, reason, providerId, locationId]);

  const { submit, busy, error } = useSubmit(async () => {
    const r = await api.post(`/public/practices/${slug}/booking-requests`, { ...form, reason, start: slot.start, provider_id: slot.provider_id, language: lang, ...(params.get('src') ? { source: params.get('src') } : {}), ...(locationId ? { location_id: Number(locationId) } : {}) });
    // A deposit is paid on the secure card page, which brings the patient back here.
    if (r.checkout_url) { window.location.assign(r.checkout_url); return; }
    setDone(r.booked ? 'booked' : 'requested');
  });

  if (loadError) return <PublicLayout title={t('Online booking')}><ErrorBox error={loadError} /></PublicLayout>;
  if (!practice) return <PublicLayout title={t('Online booking')}><p>{t('Loading…')}</p></PublicLayout>;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const deposit = practice.reasons.find((r) => r.label === reason)?.deposit || 0;
  const by = form.phone ? t('text') : t('email');

  if (returned) {
    return (
      <PublicLayout title={returned === 'paid' ? t('Deposit received') : t('Not booked')} practice={practice}>
        <div className={returned === 'paid' ? 'public-notice ok' : 'public-notice'}>
          {returned === 'paid'
            ? t('Thank you! Your deposit is paid and {practice} will confirm your visit by text or email in a moment.', { practice: practice.name })
            : <>{t('The deposit wasn’t paid, so the time wasn’t booked.')} <a href={`/book/${slug}`}>{t('Choose a time again')}</a> {practice.phone ? t('or call us at {phone}.', { phone: practice.phone }) : t('or call us.')}</>}
        </div>
      </PublicLayout>
    );
  }
  if (done === 'booked') {
    return (
      <PublicLayout title={t('You’re booked!')} practice={practice}>
        <div className="public-notice ok">
          {t('See you {date} at {time}, {name}. A confirmation is on its way by {by}.', { date: fmtDateL(lang, slot.start), time: fmtTimeL(lang, slot.start), name: form.first_name, by })}
        </div>
      </PublicLayout>
    );
  }
  if (done) {
    return (
      <PublicLayout title={t('Request received')} practice={practice}>
        <div className="public-notice ok">
          {t('Thanks, {name}! We’ve received your request for {date} at {time}.', { name: form.first_name, date: fmtDateL(lang, slot.start), time: fmtTimeL(lang, slot.start) })}{' '}
          {t('We’ll confirm by {by} shortly.', { by })}
        </div>
      </PublicLayout>
    );
  }

  // Only days the office is open (from Settings → Office hours).
  const office = practice.locations?.find((l) => String(l.id) === locationId);
  const openDay = (d) => (office?.open_days || practice.open_days || [1, 2, 3, 4, 5]).includes(new Date(`${d}T12:00:00Z`).getUTCDay());
  const days = Array.from({ length: 45 }, (_, i) => shiftDate(practice.today, i + 1)).filter(openDay).slice(0, 25);

  return (
    <PublicLayout title={t('Book an appointment')} practice={practice}>
      {practice.locations?.length > 1 && (
        <div className="card">
          <h2>{t('Which office?')}</h2>
          <div className="choice-grid">
            {practice.locations.map((l) => (
              <button key={l.id} className={`choice${locationId === String(l.id) ? ' selected' : ''}`} onClick={() => { setLocationId(String(l.id)); jumped.current = false; }}>
                {l.name}<span className="muted">{[l.address, l.city].filter(Boolean).join(', ')}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="card">
        <h2>{t('1. What do you need?')}</h2>
        <div className="choice-grid">
          {practice.reasons.map((r) => (
            <button key={r.label} className={`choice${reason === r.label ? ' selected' : ''}`} onClick={() => setReason(r.label)}>
              {(lang === 'es' && r.label_es) || t(r.label)}<span className="muted">{t('{n} min', { n: r.duration })}</span>
            </button>
          ))}
        </div>
        {practice.providers.length > 1 && (
          <label style={{ marginTop: 12 }}>
            {t('Provider')}
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">{t('No preference')}</option>
              {practice.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="card">
        <h2>{t('2. Pick a time')}</h2>
        <div className="day-strip">
          {days.map((d) => (
            <button key={d} className={`day${d === date ? ' selected' : ''}`} onClick={() => setDate(d)}>
              <span>{fmtDateL(lang, d, { weekday: 'short' })}</span>
              <strong>{Number(d.slice(8, 10))}</strong>
              <span>{fmtDateL(lang, d, { month: 'short' })}</span>
            </button>
          ))}
        </div>
        {slots === null && <p className="muted">{practice.locations?.length > 1 && !locationId ? t('Choose an office above to see open times.') : t('Checking availability…')}</p>}
        {slots?.length === 0 && (
          <p className="muted">
            {t('No openings this day.')}{' '}
            {nextAvailable && <button className="link" onClick={() => setDate(nextAvailable)}>{t('Next available: {date}', { date: fmtDateL(lang, nextAvailable, { weekday: 'long', month: 'short', day: 'numeric' }) })}</button>}
          </p>
        )}
        <div className="slot-grid">
          {slots?.map((s) => (
            <button key={`${s.start}-${s.provider_id}`} className={`choice${slot === s ? ' selected' : ''}`} onClick={() => setSlot(s)}>
              {fmtTimeL(lang, s.start)}
              {!providerId && practice.providers.length > 1 && <span className="muted">{s.provider_name}</span>}
            </button>
          ))}
        </div>
      </div>

      {slot && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <h2>{t('3. Your details')}</h2>
          <ErrorBox error={error} />
          <div className="form-grid">
            <label>{t('First name')} *<input required value={form.first_name} onChange={set('first_name')} autoComplete="given-name" /></label>
            <label>{t('Last name')} *<input required value={form.last_name} onChange={set('last_name')} autoComplete="family-name" /></label>
            <label>{t('Date of birth')}<input type="date" value={form.dob} onChange={set('dob')} /></label>
            <label>{t('Mobile phone')}<input type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" /></label>
            <label className="full">{t('Email')}<input type="email" value={form.email} onChange={set('email')} autoComplete="email" /></label>
            <label className="full">{t('Anything we should know? (optional)')}<textarea rows={2} value={form.notes} onChange={set('notes')} /></label>
            <label className="checkbox full"><input type="checkbox" checked={form.new_patient} onChange={(e) => setForm({ ...form, new_patient: e.target.checked })} /> {t('I’m a new patient')}</label>
            {form.new_patient && (
              <label className="full">{t('How did you hear about us? (optional)')}
                <select value={form.referral_source} onChange={set('referral_source')}>
                  <option value="">—</option>
                  {HEARD_FROM.map((h) => <option key={h} value={h}>{t(h)}</option>)}
                </select>
              </label>
            )}
            <label>{t('Dental insurance (optional)')}<input value={form.insurance_carrier} onChange={set('insurance_carrier')} placeholder={t('e.g. Delta Dental')} /></label>
            <label>{t('Member ID')}<input value={form.insurance_member_id} onChange={set('insurance_member_id')} /></label>
            {form.insurance_member_id && <label className="full">{t('Policy holder, if not you')}<input value={form.insurance_subscriber} onChange={set('insurance_subscriber')} placeholder={t('Full name')} /></label>}
            {/* Hidden from people; bots fill it in. */}
            <input tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} style={{ position: 'absolute', left: -9999 }} aria-hidden="true" />
          </div>
          <p className="muted" style={{ fontSize: 12 }}>{t('Please don’t include medical details here. We’ll send you secure forms before your visit.')}</p>
          {deposit > 0 && <p style={{ fontSize: 14 }}>{t('A {amount} deposit holds this time. It’s paid on a secure card page next and comes off your bill.', { amount: `$${(deposit / 100).toFixed(2)}` })}</p>}
          <button className="primary big" disabled={busy}>{t(deposit > 0 ? 'Continue to deposit: {time} on {date}' : practice.instant ? 'Book {time} on {date}' : 'Request {time} on {date}', { time: fmtTimeL(lang, slot.start), date: fmtDateL(lang, slot.start, { month: 'short', day: 'numeric' }) })}</button>
        </form>
      )}
    </PublicLayout>
  );
}
