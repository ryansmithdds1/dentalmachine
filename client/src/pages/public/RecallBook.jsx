import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Check } from 'lucide-react';
import { api } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import { fmtDateL, fmtTimeL, suggestLang, useLang, useT } from './i18n.js';
import '../recall.css';

// RC2 — the page behind the link in a recall text or email (/rb/:token). Real open times with the patient's own
// hygienist that fit their visit, from the due date on; a family sees back-to-back times. Two taps: a time,
// then "Book it". A double tap or a retry books once (the same key goes with the same choice).

const newKey = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function RecallBook() {
  const t = useT();
  const lang = useLang();
  const { token } = useParams();
  const [page, setPage] = useState(null);
  const [slots, setSlots] = useState(null);
  const [error, setError] = useState(null);
  const [chosen, setChosen] = useState(null); // { option, key }
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [one, setOne] = useState(null); // book one person at a time (enrollment id)
  const [any, setAny] = useState(false);
  const [from, setFrom] = useState(null);

  useEffect(() => {
    api.get(`/public/recall/${token}`).then((p) => {
      suggestLang(/^(es|spanish|espa)/i.test(p.language || '') ? 'es' : 'en');
      setPage(p);
    }).catch(setError);
  }, [token]);

  const open = useMemo(() => (page?.people || []).filter((p) => p.open && !p.booked), [page]);
  const loadSlots = useCallback(async () => {
    if (!open.length) return;
    setSlots(null);
    setChosen(null);
    const qs = new URLSearchParams({ ...(from ? { from } : {}), ...(any ? { any: '1' } : {}), ...(one ? { enrollment_id: String(one) } : {}) });
    try {
      setSlots(await api.get(`/public/recall/${token}/slots${qs.toString() ? `?${qs}` : ''}`));
    } catch (e) {
      setError(e);
    }
  }, [token, open.length, from, any, one]);
  useEffect(() => { loadSlots(); }, [loadSlots]);

  const book = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/public/recall/${token}/book`, { items: chosen.option.items.map(({ enrollment_id: e, start, provider_id: p }) => ({ enrollment_id: e, start, provider_id: p })), key: chosen.key });
      setDone(r.visits);
    } catch (e) {
      setError(e);
      if (e.status === 409) loadSlots();
    } finally {
      setBusy(false);
    }
  };

  if (!page) return <PublicLayout title={t('Book your visit')}><ErrorBox error={error} />{!error && <p>{t('Loading…')}</p>}</PublicLayout>;
  const practice = page.practice;
  const booked = page.people.filter((p) => p.booked);

  if (done || (!open.length && booked.length)) {
    const visits = done || booked.map((p) => ({ id: p.booked.id, start_time: p.booked.start_time, first_name: p.first_name, provider_name: p.booked.provider_name }));
    return (
      <PublicLayout practice={practice}>
        <div className="card rb-done">
          <div className="rb-check"><Check size={30} /></div>
          <h1>{t('You’re booked!')}</h1>
          {visits.map((v) => (
            <div key={v.id}>
              <div className="rb-visit">{fmtDateL(lang, v.start_time)} · {fmtTimeL(lang, v.start_time)}</div>
              <div className="muted">{page.people.length > 1 ? `${v.first_name} · ` : ''}{t('with {provider}', { provider: v.provider_name })}</div>
            </div>
          ))}
          <p className="muted" style={{ marginTop: 12 }}>{t('We’ve sent you a confirmation. Need to change it? Use the link in that message or call us.')}</p>
        </div>
      </PublicLayout>
    );
  }
  if (!open.length) {
    return (
      <PublicLayout practice={practice} title={t('Book your visit')}>
        <div className="public-notice">{practice.phone ? t('Please call us at {phone} and we’ll find you a time.', { phone: practice.phone }) : t('Please call us and we’ll find you a time.')}</div>
      </PublicLayout>
    );
  }

  const names = open.map((p) => p.first_name);
  const family = open.length > 1;
  return (
    <PublicLayout practice={practice} title={family && !one ? t('Pick a time for {names}', { names: names.join(' & ') }) : t('Pick a time for your visit')}>
      <div className="rb-people">
        {open.filter((p) => !one || p.enrollment_id === one).map((p) => (
          <span key={p.enrollment_id} className="rb-person"><b>{p.first_name}</b> · {p.visit} · {t('{n} min', { n: p.minutes })}{p.provider_name && !any ? ` · ${p.provider_name}` : ''}</span>
        ))}
      </div>
      {family && (
        <div className="rb-links">
          {one ? <button type="button" className="link" onClick={() => setOne(null)}>{t('Book everyone back-to-back')}</button>
            : open.map((p) => <button key={p.enrollment_id} type="button" className="link" onClick={() => setOne(p.enrollment_id)}>{t('Just {name}', { name: p.first_name })}</button>)}
        </div>
      )}
      <ErrorBox error={error} />
      {!slots && !error && <p className="muted">{t('Finding open times…')}</p>}
      {slots && !slots.days.length && (
        <div className="public-notice">{practice.phone ? t('No open times online in the next few weeks. Call us at {phone} and we’ll fit you in.', { phone: practice.phone }) : t('No open times online in the next few weeks. Please call us.')}</div>
      )}
      {slots?.days.map((d) => (
        <div className="rb-day" key={d.date}>
          <h2>{fmtDateL(lang, d.date)}</h2>
          <div className="rb-times">
            {d.options.map((o) => {
              const isChosen = chosen?.option === o;
              return (
                <button key={o.start} type="button" className={`rb-time ${isChosen ? 'chosen' : ''}`} aria-pressed={isChosen} onClick={() => setChosen(isChosen ? null : { option: o, key: newKey() })}>
                  {fmtTimeL(lang, o.start)}
                  <small>{o.items.length > 1 ? o.items.map((i) => `${i.first_name} ${fmtTimeL(lang, i.start)}`).join(' · ') : o.items[0].provider_name}</small>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {slots && (
        <div className="rb-links">
          {slots.days.length > 0 && <button type="button" className="link" onClick={() => setFrom(slots.next_from)}>{t('Later dates')}</button>}
          {from && <button type="button" className="link" onClick={() => setFrom(null)}>{t('Earliest dates')}</button>}
          {slots.own_provider && !any && <button type="button" className="link" onClick={() => setAny(true)}>{t('See other hygienists too')}</button>}
          {practice.phone && <a href={`tel:${practice.phone}`}>{t('Rather talk? Call {phone}', { phone: practice.phone })}</a>}
        </div>
      )}
      {chosen && (
        <div className="rb-confirm">
          <div className="rb-summary">
            <strong>{fmtDateL(lang, chosen.option.start)}</strong>
            {chosen.option.items.map((i) => <div key={i.enrollment_id}>{family ? `${i.first_name}: ` : ''}{fmtTimeL(lang, i.start)} {t('with {provider}', { provider: i.provider_name })}</div>)}
          </div>
          <button type="button" className="primary big" disabled={busy} onClick={book}>{busy ? t('Booking…') : t('Book it')}</button>
        </div>
      )}
    </PublicLayout>
  );
}
