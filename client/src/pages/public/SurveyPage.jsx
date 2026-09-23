import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import { suggestLang, useLang, useT } from './i18n.js';

// A short patient survey (the link in the message after a visit).
export default function SurveyPage() {
  const t = useT();
  const lang = useLang();
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [answers, setAnswers] = useState({});
  const [done, setDone] = useState(false);
  useEffect(() => { api.get(`/public/survey/${token}`).then((i) => { suggestLang(i.language); setInfo(i); }).catch(setLoadError); }, [token]);
  const send = useSubmit(async () => { await api.post(`/public/survey/${token}`, { answers }); setDone(true); });
  if (loadError) return <PublicLayout title={t('Thank you')}><ErrorBox error={loadError} /></PublicLayout>;
  if (!info) return <PublicLayout title={t('How did we do?')}><p>{t('Loading…')}</p></PublicLayout>;
  const practice = { name: info.practice_name, phone: info.practice_phone };
  if (done || info.answered) return <PublicLayout title={t('Thank you')} practice={practice}><div className="public-notice ok">{t('Thank you, {name}! Your answers go straight to {practice}.', { name: info.first_name, practice: info.practice_name })}</div></PublicLayout>;
  const set = (id, v) => setAnswers({ ...answers, [id]: v });
  return (
    <PublicLayout title={t('How did we do?')} practice={practice}>
      <ErrorBox error={send.error} />
      <div className="card">
        {info.questions.map((q) => {
          const label = (lang === 'es' && q.label_es) || q.label;
          return (
            <fieldset key={q.id} className="survey-q">
              <legend>{label}</legend>
              {q.type === 'nps' && (
                <>
                  <div className="nps-row" role="group" aria-label={label}>
                    {Array.from({ length: 11 }, (_, n) => <button key={n} type="button" className={answers[q.id] === n ? 'selected' : ''} aria-pressed={answers[q.id] === n} onClick={() => set(q.id, n)}>{n}</button>)}
                  </div>
                  <div className="nps-ends muted"><span>{t('Not likely')}</span><span>{t('Very likely')}</span></div>
                </>
              )}
              {q.type === 'rating' && (
                <div className="stars" role="group" aria-label={label}>
                  {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" className={`star${answers[q.id] >= n ? ' on' : ''}`} aria-pressed={answers[q.id] === n} aria-label={n > 1 ? t('{n} stars', { n }) : t('1 star')} onClick={() => set(q.id, n)}>★</button>)}
                </div>
              )}
              {q.type === 'yesno' && (
                <div className="inline" style={{ gap: 8 }}>
                  {[['yes', t('Yes')], ['no', t('No')]].map(([v, l]) => <button key={v} type="button" className={answers[q.id] === v ? 'primary' : ''} onClick={() => set(q.id, v)}>{l}</button>)}
                </div>
              )}
              {q.type === 'text' && <textarea rows={3} aria-label={label} value={answers[q.id] || ''} onChange={(e) => set(q.id, e.target.value)} maxLength={2000} />}
            </fieldset>
          );
        })}
        <button className="primary big" disabled={send.busy || !Object.keys(answers).length} onClick={send.submit}>{t('Send')}</button>
        <p className="muted" style={{ fontSize: 12 }}>{t('Your answers go only to {practice}.', { practice: info.practice_name })}</p>
      </div>
    </PublicLayout>
  );
}
