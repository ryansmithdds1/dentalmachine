import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { fmtTime } from '../../format.js';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';

export default function ConfirmPage() {
  const { token } = useParams();
  const [appt, setAppt] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    api.get(`/public/confirm/${token}`).then(setAppt).catch(setError);
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

  if (!appt) return <PublicLayout title="Your appointment"><ErrorBox error={error} />{!error && <p>Loading…</p>}</PublicLayout>;
  const date = new Date(`${appt.start_time.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const p = appt.practice;

  return (
    <PublicLayout title={`Hi ${appt.first_name}!`} practice={p}>
      <ErrorBox error={error} />
      <div className="card">
        <div className="muted">Your appointment</div>
        <div style={{ fontSize: 22, fontWeight: 700, margin: '6px 0' }}>{date}</div>
        <div style={{ fontSize: 18 }}>{fmtTime(appt.start_time)} with {appt.provider_name}</div>
        {p.address && <div className="muted" style={{ marginTop: 10 }}>{p.address}, {[p.city, p.state, p.zip].filter(Boolean).join(', ')}</div>}
      </div>

      <div style={{ marginTop: 20 }}>
        {appt.status === 'confirmed' && <div className="public-notice ok">✓ You&apos;re confirmed. See you then!</div>}
        {appt.status === 'cancelled' && <div className="public-notice">This appointment has been cancelled. Please call us{p.phone ? ` at ${p.phone}` : ''} to reschedule.</div>}
        {appt.status === 'scheduled' && (
          <button className="primary big" disabled={busy} onClick={() => act('confirm')}>Confirm my appointment</button>
        )}
        {['scheduled', 'confirmed'].includes(appt.status) && !confirmCancel && (
          <button className="link" style={{ marginTop: 16, display: 'block' }} onClick={() => setConfirmCancel(true)}>I need to cancel</button>
        )}
        {confirmCancel && (
          <div className="card" style={{ marginTop: 12 }}>
            <p>Are you sure you want to cancel? We may charge a fee for cancellations with less than 24 hours notice.</p>
            <div className="inline">
              <button className="danger" disabled={busy} onClick={() => act('cancel')}>Yes, cancel it</button>
              <button onClick={() => setConfirmCancel(false)}>Keep my appointment</button>
            </div>
          </div>
        )}
      </div>
    </PublicLayout>
  );
}
