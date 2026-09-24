import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';

// The new-patient welcome page (PX1), linked from the welcome email: the doctor's photo, when and where, parking,
// what to bring and what to expect, and the way to the forms. First name and the visit time only — nothing clinical.
export default function WelcomePage() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get(`/public/journeys/welcome/${token}`).then(setInfo).catch(setError); }, [token]);
  if (error) return <PublicLayout title="Welcome!"><ErrorBox error={error} /></PublicLayout>;
  if (!info) return <PublicLayout title="Welcome!"><p>Loading…</p></PublicLayout>;
  const maps = info.practice.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${info.practice.name}, ${info.practice.address}`)}` : null;
  return (
    <PublicLayout title={`Welcome, ${info.first_name}!`} practice={info.practice}>
      <div className="card" style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        {info.doctor_photo && <img src={info.doctor_photo} alt={info.doctor} style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: '50%' }} />}
        <div>
          <p style={{ marginTop: 0 }}>We’re so glad you chose {info.practice.name}. {info.doctor} and the whole team are looking forward to meeting you.</p>
          {info.active && info.date && <p><strong>Your first visit:</strong> {info.date} at {info.time}</p>}
        </div>
      </div>
      {info.what_to_expect && <div className="card"><h2>What to expect</h2><p>{info.what_to_expect}</p></div>}
      <div className="card">
        <h2>Finding us</h2>
        {info.practice.address && <p>{info.practice.address}{maps && <> · <a href={maps} target="_blank" rel="noreferrer">Map</a></>}</p>}
        {info.parking && <p>{info.parking}</p>}
        {info.practice.phone && <p>Questions? Call <a href={`tel:${info.practice.phone}`}>{info.practice.phone}</a> or reply to our text.</p>}
      </div>
      {info.what_to_bring && <div className="card"><h2>What to bring</h2><p>Please bring {info.what_to_bring}.</p></div>}
      <div className="card">
        <h2>Your forms</h2>
        <p>Save time at the front desk: fill in your forms before you come, in your patient portal.</p>
        <a className="button primary" href="/portal">Open the patient portal</a>
      </div>
      {info.team_note && <div className="card"><p style={{ margin: 0 }}>{info.team_note}</p></div>}
    </PublicLayout>
  );
}
