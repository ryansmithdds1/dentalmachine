import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import PublicLayout, { PublicError } from './PublicLayout.jsx';
import { suggestLang, translate, useLang } from './i18n.js';
import './review.css';

// "How did we do?" (RV2, docs/reviews.md). Everyone rates first. Happy ratings get a warm invitation to post a
// review (their words copied, one tap to the site); lower ratings get a caring private form that goes straight to
// the owner and office manager. Whatever the rating, a small honest link to post a public review is always on the
// page: offering reviews only to happy patients ("review gating") is against Google's rules and the FTC's.
const ES = {
  'Hi {name}, how was your visit to {practice}?': 'Hola {name}, ¿cómo fue su visita a {practice}?',
  'Tap a star': 'Toque una estrella',
  '{n} of 5 stars': '{n} de 5 estrellas',
  'Thank you, {name}! We’re so glad.': '¡Gracias, {name}! Nos alegra mucho.',
  'Would you share that in a quick review? It helps other people find a dentist they can trust.': '¿Le gustaría compartirlo en una breve reseña? Ayuda a otras personas a encontrar un dentista de confianza.',
  'Your words (optional)': 'Sus palabras (opcional)',
  'What did you like? Anyone on our team you’d like to thank?': '¿Qué le gustó? ¿Alguien de nuestro equipo a quien quiera agradecer?',
  'We’ll copy your words so you can paste them.': 'Copiaremos sus palabras para que pueda pegarlas.',
  'Copy and post on {site}': 'Copiar y publicar en {site}',
  'Post on {site}': 'Publicar en {site}',
  'Copied — paste it in the review box': 'Copiado: péguelo en el cuadro de la reseña',
  'We’re sorry your visit wasn’t better, {name}. What went wrong?': 'Lamentamos que su visita no fuera mejor, {name}. ¿Qué salió mal?',
  'This goes privately to the owner and office manager, not to any public site.': 'Esto va en privado al dueño y al gerente de la oficina, no a ningún sitio público.',
  'Please call me back': 'Por favor, llámenme',
  'Best time or number (optional)': 'Mejor hora o número (opcional)',
  'Send to {practice}': 'Enviar a {practice}',
  'Thank you for telling us. Someone from {practice} will be in touch — or call us any time at {phone}.': 'Gracias por decírnoslo. Alguien de {practice} se comunicará con usted, o llámenos cuando quiera al {phone}.',
  'Thank you for telling us. Someone from {practice} will be in touch.': 'Gracias por decírnoslo. Alguien de {practice} se comunicará con usted.',
  'You can also post a public review on': 'También puede publicar una reseña pública en',
  'or': 'o',
  'Change my rating': 'Cambiar mi calificación',
  'How did we do?': '¿Cómo lo hicimos?',
  'Thank you': 'Gracias',
  'Loading…': 'Cargando…',
};

function useTr() {
  const lang = useLang();
  return (s, vars) => (lang === 'es' && ES[s] ? translate('en', ES[s], vars) : translate(lang, s, vars));
}

export default function ReviewPage() {
  const t = useTr();
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [words, setWords] = useState('');
  const [copied, setCopied] = useState(false);
  const [callback, setCallback] = useState(false);
  const [note, setNote] = useState('');
  const [rerate, setRerate] = useState(false);
  useEffect(() => {
    api.get(`/public/review/${token}`).then((i) => { suggestLang(i.language); setInfo(i); setWords(i.comment || ''); }).catch(setLoadError);
  }, [token]);
  const rate = useSubmit(async (rating) => { setInfo(await api.post(`/public/review/${token}`, { rating })); setRerate(false); });
  const tell = useSubmit(async () => setInfo(await api.post(`/public/review/${token}`, { comment: words, callback, callback_note: note || null })));
  const goTo = (site) => `/api/public/review/${token}/go?site=${encodeURIComponent(site.key)}`;
  // Happy: keep their words (staff shout-outs are counted from them), copy them, then one tap to the site.
  const post = async (site) => {
    const text = words.trim();
    if (text) {
      try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* clipboard blocked: they can still type it */ }
      if (text !== (info.comment || '')) api.post(`/public/review/${token}`, { comment: text }).catch(() => { /* saving their words is a nicety; the link still works */ });
    }
    window.location.assign(goTo(site));
  };

  if (loadError) return <PublicLayout title={t('How did we do?')}><PublicError error={loadError} /></PublicLayout>;
  if (!info) return <PublicLayout title={t('How did we do?')}><p>{t('Loading…')}</p></PublicLayout>;
  const practice = { name: info.practice_name, phone: info.practice_phone };
  const step = rerate ? 'rate' : info.step;
  return (
    <PublicLayout title={t('How did we do?')} practice={practice}>
      <ErrorBox error={rate.error || tell.error} />
      {step === 'rate' && (
        <div className="card rv-card" style={{ textAlign: 'center' }}>
          <p className="rv-lead">{t('Hi {name}, how was your visit to {practice}?', { name: info.first_name, practice: info.practice_name })}</p>
          <div className="rv-stars" role="group" aria-label={t('Tap a star')}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className={`rv-star${info.rating >= n ? ' on' : ''}`} disabled={rate.busy} onClick={() => rate.submit(n)} aria-label={t('{n} of 5 stars', { n })}>★</button>
            ))}
          </div>
          <div className="muted">{t('Tap a star')}</div>
        </div>
      )}

      {step === 'invite' && (
        <div className="card rv-card">
          <p className="rv-lead" style={{ textAlign: 'center' }}>{t('Thank you, {name}! We’re so glad.', { name: info.first_name })}</p>
          {info.sites.length > 0 && (
            <>
              <p>{t('Would you share that in a quick review? It helps other people find a dentist they can trust.')}</p>
              <label className="rv-label">{t('Your words (optional)')}
                <textarea rows={4} value={words} onChange={(e) => setWords(e.target.value)} placeholder={t('What did you like? Anyone on our team you’d like to thank?')} />
              </label>
              <div className="muted rv-small">{t('We’ll copy your words so you can paste them.')}</div>
              <div className="rv-sites">
                {info.sites.map((s, i) => (
                  <button key={s.key} type="button" className={i === 0 ? 'primary big' : 'big'} onClick={() => post(s)}>
                    {words.trim() ? t('Copy and post on {site}', { site: s.name }) : t('Post on {site}', { site: s.name })}
                  </button>
                ))}
              </div>
              {copied && <div className="public-notice ok">{t('Copied — paste it in the review box')}</div>}
            </>
          )}
          <button type="button" className="link rv-small" onClick={() => setRerate(true)}>{t('Change my rating')}</button>
        </div>
      )}

      {step === 'feedback' && (
        <form className="card rv-card" onSubmit={(e) => { e.preventDefault(); tell.submit(); }}>
          <p className="rv-lead">{t('We’re sorry your visit wasn’t better, {name}. What went wrong?', { name: info.first_name })}</p>
          <textarea rows={5} value={words} onChange={(e) => setWords(e.target.value)} aria-label={t('We’re sorry your visit wasn’t better, {name}. What went wrong?', { name: info.first_name })} />
          <div className="muted rv-small">{t('This goes privately to the owner and office manager, not to any public site.')}</div>
          <label className="checkbox rv-callback"><input type="checkbox" checked={callback} onChange={(e) => setCallback(e.target.checked)} /> {t('Please call me back')}</label>
          {callback && <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Best time or number (optional)')} aria-label={t('Best time or number (optional)')} />}
          <button className="primary big" style={{ marginTop: 10 }} disabled={tell.busy || (!words.trim() && !callback)}>{t('Send to {practice}', { practice: info.practice_name })}</button>
          <button type="button" className="link rv-small" onClick={() => setRerate(true)}>{t('Change my rating')}</button>
        </form>
      )}

      {step === 'thanks' && (
        <div className="public-notice ok">{info.practice_phone ? t('Thank you for telling us. Someone from {practice} will be in touch — or call us any time at {phone}.', { practice: info.practice_name, phone: info.practice_phone }) : t('Thank you for telling us. Someone from {practice} will be in touch.', { practice: info.practice_name })}</div>
      )}

      {info.sites.length > 0 && (
        <p className="rv-public muted" data-testid="public-review-link">
          {t('You can also post a public review on')}{' '}
          {info.sites.map((s, i) => (
            <span key={s.key}>{i > 0 && (i === info.sites.length - 1 ? ` ${t('or')} ` : ', ')}<a href={goTo(s)}>{s.name}</a></span>
          ))}.
        </p>
      )}
    </PublicLayout>
  );
}
