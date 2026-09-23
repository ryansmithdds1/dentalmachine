import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';

// "How did we do?" after a visit. Happy patients are invited to post a public review; anyone else
// can tell the office privately.
export default function ReviewPage() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => { api.get(`/public/review/${token}`).then(setInfo).catch(setLoadError); }, [token]);
  const rate = useSubmit(async (rating) => setInfo(await api.post(`/public/review/${token}`, { rating })));
  const tell = useSubmit(async () => { setInfo(await api.post(`/public/review/${token}`, { comment })); setSent(true); });

  if (loadError) return <PublicLayout title="Thank you"><ErrorBox error={loadError} /></PublicLayout>;
  if (!info) return <PublicLayout title="How did we do?"><p>Loading…</p></PublicLayout>;
  const practice = { name: info.practice_name };
  return (
    <PublicLayout title="How did we do?" practice={practice}>
      <ErrorBox error={rate.error || tell.error} />
      {info.rating == null ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 17 }}>Hi {info.first_name}, how was your visit to {info.practice_name}?</p>
          <div className="stars" role="group" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className="star" disabled={rate.busy} onClick={() => rate.submit(n)} aria-label={`${n} star${n > 1 ? 's' : ''}`}>★</button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 13 }}>Tap a star</div>
        </div>
      ) : info.happy ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 17 }}>Thank you, {info.first_name}! We're so glad.</p>
          {info.review_link && (
            <>
              <p>Would you share that in a quick review? It helps other people find a dentist they can trust.</p>
              <a className="button primary big" href={`/api/public/review/${token}/go`}>Leave a review</a>
            </>
          )}
        </div>
      ) : sent || info.comment ? (
        <div className="public-notice ok">Thank you for telling us. Someone from {info.practice_name} will be in touch{info.practice_phone ? ` — or call us any time at ${info.practice_phone}` : ''}.</div>
      ) : (
        <div className="card">
          <p style={{ fontSize: 17 }}>We're sorry your visit wasn't better, {info.first_name}. What could we have done differently?</p>
          <textarea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="This goes straight to the office, not to any public site." />
          <button className="primary big" style={{ marginTop: 10 }} disabled={tell.busy || !comment.trim()} onClick={tell.submit}>Send to {info.practice_name}</button>
        </div>
      )}
    </PublicLayout>
  );
}
