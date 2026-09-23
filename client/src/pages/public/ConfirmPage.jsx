import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import { fmtDateL, fmtTimeL, suggestLang, useLang, useT } from './i18n.js';

// The page behind the link in a reminder: one visit, or a family's visits on one day. Confirm them all with
// one tap; cancel or ask for a new time for one; add them to a calendar; get directions.

const OPEN = ['scheduled', 'confirmed'];
const stamp = (s) => s.replace(/[-: ]/g, '').replace(/^(\d{8})(\d{4})$/, '$1T$200');
const googleCalendar = (v, p) => `https://calendar.google.com/calendar/render?${new URLSearchParams({
  action: 'TEMPLATE', text: `Dental appointment — ${p.name}`, dates: `${stamp(v.start_time)}/${stamp(v.end_time)}`, ...(p.timezone ? { ctz: p.timezone } : {}),
  details: `With ${v.provider_name}.${p.phone ? ` Questions: ${p.phone}` : ''}`, location: [p.address, p.city, p.state, p.zip].filter(Boolean).join(', '),
})}`;

export default function ConfirmPage() {
  const t = useT();
  const lang = useLang();
  const { token } = useParams();
  const [appt, setAppt] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(null); // { id, action: 'cancel' | 'reschedule' }
  const [note, setNote] = useState('');
  const [done, setDone] = useState(null);

  useEffect(() => {
    api.get(`/public/confirm/${token}`).then((a) => { suggestLang(a.language); setAppt(a); }).catch(setError);
  }, [token]);

  const act = async (action, appointmentId) => {
    setBusy(true);
    setError(null);
    try {
      setAppt(await api.post(`/public/confirm/${token}`, { action, ...(appointmentId ? { appointment_id: appointmentId } : {}), ...(note.trim() ? { note: note.trim() } : {}) }));
      setDone(action === 'reschedule' ? 'reschedule' : null);
      setAsking(null);
      setNote('');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!appt) return <PublicLayout title={t('Your appointment')}><ErrorBox error={error} />{!error && <p>{t('Loading…')}</p>}</PublicLayout>;
  const p = appt.practice;
  const visits = appt.visits?.length ? appt.visits : [{ ...appt, id: null, upcoming: true }];
  const family = visits.length > 1 || visits.some((v) => v.first_name !== appt.first_name);
  const open = visits.filter((v) => v.upcoming && OPEN.includes(v.status));
  const waiting = open.filter((v) => v.status === 'scheduled');
  const days = [...new Set(visits.map((v) => v.start_time.slice(0, 10)))];
  const address = [p.address, [p.city, p.state].filter(Boolean).join(', '), p.zip].filter(Boolean).join(', ');
  const video = open.find((v) => v.video_url);

  return (
    <PublicLayout title={t('Hi {name}!', { name: appt.first_name })} practice={p}>
      <ErrorBox error={error} />
      {days.map((day) => (
        <div className="card" key={day} style={{ marginBottom: 12 }}>
          <div className="muted">{t(family ? 'Your family’s appointments' : 'Your appointment')}</div>
          <div style={{ fontSize: 22, fontWeight: 700, margin: '6px 0' }}>{fmtDateL(lang, day)}</div>
          {visits.filter((v) => v.start_time.startsWith(day)).map((v) => (
            <div key={v.id ?? 'one'} className="confirm-visit">
              <div style={{ fontSize: 18 }}>
                {family && <strong>{v.first_name} · </strong>}
                {t('{time} with {provider}', { time: fmtTimeL(lang, v.start_time), provider: v.provider_name })}
              </div>
              <div className="confirm-visit-status">
                {v.status === 'confirmed' && <span className="public-pill ok">✓ {t('Confirmed')}</span>}
                {v.status === 'cancelled' && <span className="public-pill">{t('Cancelled')}</span>}
                {v.upcoming && OPEN.includes(v.status) && asking?.id !== v.id && (
                  <span className="confirm-visit-links">
                    <button className="link" onClick={() => { setAsking({ id: v.id, action: 'reschedule' }); setDone(null); }}>{t('Need a different time?')}</button>
                    <button className="link" onClick={() => { setAsking({ id: v.id, action: 'cancel' }); setDone(null); }}>{t('Cancel')}</button>
                  </span>
                )}
              </div>
              {asking?.id === v.id && (
                <div className="card" style={{ marginTop: 10 }}>
                  <p>{asking.action === 'cancel'
                    ? t('Are you sure you want to cancel? We may charge a fee for cancellations with less than 24 hours notice.')
                    : t('We’ll call you to find a better time. Anything we should know? (optional)')}</p>
                  <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={asking.action === 'cancel' ? t('Reason (optional)') : t('Best days or times for you')} style={{ width: '100%' }} />
                  <div className="inline" style={{ marginTop: 8 }}>
                    {asking.action === 'cancel'
                      ? <button className="danger" disabled={busy} onClick={() => act('cancel', v.id)}>{t('Yes, cancel it')}</button>
                      : <button className="primary" disabled={busy} onClick={() => act('reschedule', v.id)}>{t('Ask for a new time')}</button>}
                    <button onClick={() => { setAsking(null); setNote(''); }}>{t('Keep my appointment')}</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {done === 'reschedule' && <div className="public-notice ok">{p.phone ? t('Got it — we’ll call you to find a new time. You can also call us at {phone}.', { phone: p.phone }) : t('Got it — we’ll call you to find a new time.')}</div>}

      <div style={{ marginTop: 8 }}>
        {waiting.length > 0 && (
          <button className="primary big" disabled={busy} onClick={() => act('confirm')}>
            {waiting.length > 1 ? t('Confirm all {n} appointments', { n: waiting.length }) : t('Confirm my appointment')}
          </button>
        )}
        {!waiting.length && open.length > 0 && <div className="public-notice ok">✓ {t('You’re confirmed. See you then!')}</div>}
        {!open.length && visits.every((v) => v.status === 'cancelled') && (
          <div className="public-notice">{p.phone ? t('This appointment has been cancelled. Please call us at {phone} to reschedule.', { phone: p.phone }) : t('This appointment has been cancelled. Please call us to reschedule.')}</div>
        )}
      </div>

      {video && (
        <div className="card" style={{ marginTop: 16 }}>
          <div>📹 {t('This is a video visit. Join from your phone or computer at the time of your appointment.')}</div>
          <a className="button primary" style={{ marginTop: 8, display: 'inline-block' }} href={video.video_url} target="_blank" rel="noreferrer">{t('Join video visit')}</a>
        </div>
      )}

      {open.length > 0 && (
        <div className="confirm-extras">
          <a className="button" href={`/api/public/confirm/${token}/calendar.ics`}>📅 {t('Add to calendar')}</a>
          {open.length === 1 && <a className="button" href={googleCalendar(open[0], p)} target="_blank" rel="noreferrer">{t('Google Calendar')}</a>}
          {!video && p.maps_url && <a className="button" href={p.maps_url} target="_blank" rel="noreferrer">📍 {t('Directions')}</a>}
          {p.phone && <a className="button" href={`tel:${p.phone.replace(/[^\d+]/g, '')}`}>📞 {t('Call us')}</a>}
        </div>
      )}
      {!video && address && <div className="muted" style={{ marginTop: 12 }}>{p.name} · {address}</div>}
    </PublicLayout>
  );
}
