import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import { fmtDateL, fmtTimeL, suggestLang, useLang, useT } from './i18n.js';

export default function ConfirmPage() {
  const t = useT();
  const lang = useLang();
  const { token } = useParams();
  const [appt, setAppt] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    api.get(`/public/confirm/${token}`).then((a) => { suggestLang(a.language); setAppt(a); }).catch(setError);
  }, [token]);

  const act = async (action) => {
    setBusy(true);
    setError(null);
    try {
      setAppt(await api.post(`/public/confirm/${token}`, { action }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setConfirmCancel(false);
    }
  };

  if (!appt) return <PublicLayout title={t('Your appointment')}><ErrorBox error={error} />{!error && <p>{t('Loading…')}</p>}</PublicLayout>;
  const date = fmtDateL(lang, appt.start_time);
  const p = appt.practice;

  return (
    <PublicLayout title={t('Hi {name}!', { name: appt.first_name })} practice={p}>
      <ErrorBox error={error} />
      <div className="card">
        <div className="muted">{t('Your appointment')}</div>
        <div style={{ fontSize: 22, fontWeight: 700, margin: '6px 0' }}>{date}</div>
        <div style={{ fontSize: 18 }}>{t('{time} with {provider}', { time: fmtTimeL(lang, appt.start_time), provider: appt.provider_name })}</div>
        {p.address && <div className="muted" style={{ marginTop: 10 }}>{p.address}, {[p.city, p.state, p.zip].filter(Boolean).join(', ')}</div>}
      </div>

      <div style={{ marginTop: 20 }}>
        {appt.status === 'confirmed' && <div className="public-notice ok">✓ {t('You’re confirmed. See you then!')}</div>}
        {appt.status === 'cancelled' && <div className="public-notice">{p.phone ? t('This appointment has been cancelled. Please call us at {phone} to reschedule.', { phone: p.phone }) : t('This appointment has been cancelled. Please call us to reschedule.')}</div>}
        {appt.status === 'scheduled' && (
          <button className="primary big" disabled={busy} onClick={() => act('confirm')}>{t('Confirm my appointment')}</button>
        )}
        {['scheduled', 'confirmed'].includes(appt.status) && !confirmCancel && (
          <button className="link" style={{ marginTop: 16, display: 'block' }} onClick={() => setConfirmCancel(true)}>{t('I need to cancel')}</button>
        )}
        {confirmCancel && (
          <div className="card" style={{ marginTop: 12 }}>
            <p>{t('Are you sure you want to cancel? We may charge a fee for cancellations with less than 24 hours notice.')}</p>
            <div className="inline">
              <button className="danger" disabled={busy} onClick={() => act('cancel')}>{t('Yes, cancel it')}</button>
              <button onClick={() => setConfirmCancel(false)}>{t('Keep my appointment')}</button>
            </div>
          </div>
        )}
      </div>
    </PublicLayout>
  );
}
