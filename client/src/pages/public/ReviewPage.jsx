import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import { suggestLang, useT } from './i18n.js';

// "How did we do?" after a visit. Happy patients are invited to post a public review; anyone else
// can tell the office privately.
export default function ReviewPage() {
  const t = useT();
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => { api.get(`/public/review/${token}`).then((i) => { suggestLang(i.language); setInfo(i); }).catch(setLoadError); }, [token]);
  const rate = useSubmit(async (rating) => setInfo(await api.post(`/public/review/${token}`, { rating })));
  const tell = useSubmit(async () => { setInfo(await api.post(`/public/review/${token}`, { comment })); setSent(true); });

  if (loadError) return <PublicLayout title={t('Thank you')}><ErrorBox error={loadError} /></PublicLayout>;
  if (!info) return <PublicLayout title={t('How did we do?')}><p>{t('Loading…')}</p></PublicLayout>;
  const practice = { name: info.practice_name };
  return (
    <PublicLayout title={t('How did we do?')} practice={practice}>
      <ErrorBox error={rate.error || tell.error} />
      {info.rating == null ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 17 }}>{t('Hi {name}, how was your visit to {practice}?', { name: info.first_name, practice: info.practice_name })}</p>
          <div className="stars" role="group" aria-label={t('Rating')}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className="star" disabled={rate.busy} onClick={() => rate.submit(n)} aria-label={n > 1 ? t('{n} stars', { n }) : t('1 star')}>★</button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 13 }}>{t('Tap a star')}</div>
        </div>
      ) : info.happy ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 17 }}>{t('Thank you, {name}! We’re so glad.', { name: info.first_name })}</p>
          {info.review_link && (
            <>
              <p>{t('Would you share that in a quick review? It helps other people find a dentist they can trust.')}</p>
              <a className="button primary big" href={`/api/public/review/${token}/go`}>{t('Leave a review')}</a>
            </>
          )}
        </div>
      ) : sent || info.comment ? (
        <div className="public-notice ok">{info.practice_phone ? t('Thank you for telling us. Someone from {practice} will be in touch — or call us any time at {phone}.', { practice: info.practice_name, phone: info.practice_phone }) : t('Thank you for telling us. Someone from {practice} will be in touch.', { practice: info.practice_name })}</div>
      ) : (
        <div className="card">
          <p style={{ fontSize: 17 }}>{t('We’re sorry your visit wasn’t better, {name}. What could we have done differently?', { name: info.first_name })}</p>
          <textarea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('This goes straight to the office, not to any public site.')} />
          <button className="primary big" style={{ marginTop: 10 }} disabled={tell.busy || !comment.trim()} onClick={tell.submit}>{t('Send to {practice}', { practice: info.practice_name })}</button>
        </div>
      )}
    </PublicLayout>
  );
}
