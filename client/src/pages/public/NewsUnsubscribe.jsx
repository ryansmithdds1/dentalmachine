import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import PublicLayout, { PublicError } from './PublicLayout.jsx';
import { useT } from './i18n.js';

// Leaving the newsletter (PX5): one tap. Appointment reminders and the rest are unaffected.
export default function NewsUnsubscribe() {
  const t = useT();
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  useEffect(() => { api.get(`/public/journeys/unsubscribe/${token}`).then(setInfo).catch(setError); }, [token]);
  const go = useSubmit(async () => { await api.post(`/public/journeys/unsubscribe/${token}`); setDone(true); });
  const practice = info ? { name: info.practice_name } : null;
  if (error) return <PublicLayout title={t('Newsletter')}><PublicError error={error} /></PublicLayout>;
  if (!info) return <PublicLayout title="Newsletter"><p>Loading…</p></PublicLayout>;
  return (
    <PublicLayout title="Newsletter" practice={practice}>
      <div className="card">
        <ErrorBox error={go.error} />
        {done
          ? <div className="public-notice ok">You won’t get the {info.practice_name} newsletter any more. Appointment reminders still come as usual.</div>
          : (
            <>
              <p>Stop getting the {info.practice_name} newsletter? Appointment reminders still come as usual.</p>
              <button type="button" className="primary big" disabled={go.busy} onClick={go.submit}>Unsubscribe</button>
            </>
          )}
      </div>
    </PublicLayout>
  );
}
