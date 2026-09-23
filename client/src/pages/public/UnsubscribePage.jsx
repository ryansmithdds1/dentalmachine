import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import { suggestLang, useT } from './i18n.js';

// One click to stop marketing messages from the practice.
export default function UnsubscribePage() {
  const t = useT();
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get(`/public/unsubscribe/${token}`).then((i) => { suggestLang(i.language); setInfo(i); }).catch(setError); }, [token]);
  const go = useSubmit(async () => setInfo(await api.post(`/public/unsubscribe/${token}`)));
  if (error) return <PublicLayout title={t('Unsubscribe')}><ErrorBox error={error} /></PublicLayout>;
  if (!info) return <PublicLayout title={t('Unsubscribe')}><p>{t('Loading…')}</p></PublicLayout>;
  const sms = info.channel === 'sms';
  const vars = { practice: info.practice_name };
  return (
    <PublicLayout title={t('Unsubscribe')} practice={{ name: info.practice_name }}>
      <ErrorBox error={go.error} />
      {info.done ? (
        <div className="public-notice ok">{t(sms ? 'You won’t get any more text messages from {practice}. Appointment details can still reach you another way — call the office to change this.' : 'You won’t get any more emails from {practice}. Appointment details can still reach you another way — call the office to change this.', vars)}</div>
      ) : (
        <div className="card">
          <p>{t(sms ? 'Stop receiving text messages from {practice}?' : 'Stop receiving emails from {practice}?', vars)}</p>
          <button className="primary big" disabled={go.busy} onClick={go.submit}>{t('Unsubscribe')}</button>
        </div>
      )}
    </PublicLayout>
  );
}
