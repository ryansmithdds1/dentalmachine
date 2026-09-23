import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';

// One click to stop marketing messages from the practice.
export default function UnsubscribePage() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get(`/public/unsubscribe/${token}`).then(setInfo).catch(setError); }, [token]);
  const go = useSubmit(async () => setInfo(await api.post(`/public/unsubscribe/${token}`)));
  if (error) return <PublicLayout title="Unsubscribe"><ErrorBox error={error} /></PublicLayout>;
  if (!info) return <PublicLayout title="Unsubscribe"><p>Loading…</p></PublicLayout>;
  const what = info.channel === 'sms' ? 'text messages' : 'emails';
  return (
    <PublicLayout title="Unsubscribe" practice={{ name: info.practice_name }}>
      <ErrorBox error={go.error} />
      {info.done ? (
        <div className="public-notice ok">You won’t get any more {what} from {info.practice_name}. Appointment details can still reach you another way — call the office to change this.</div>
      ) : (
        <div className="card">
          <p>Stop receiving {what} from {info.practice_name}?</p>
          <button className="primary big" disabled={go.busy} onClick={go.submit}>Unsubscribe</button>
        </div>
      )}
    </PublicLayout>
  );
}
