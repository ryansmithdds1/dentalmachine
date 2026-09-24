import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import BookingPageClassic from './BookingPageClassic.jsx';
import { fmtDateL, fmtTimeL, useLang, useT } from './i18n.js';
import './onlinebook.css';

// Online scheduling (OS1–OS5): office → reason → time → details → confirmed, in as few taps as possible.
// The server decides everything that matters (open times, new vs existing patient, urgent triage, instant vs
// request); this page only asks. Works on the hosted page (/book/:slug) and inside the practice's website
// (?embed=1, via /embed.js or an iframe). No personal details go into the address bar or analytics.

// A random id for this visit to the page (analytics steps are counted per session; nothing else is kept).
const sessionId = () => {
  try {
    let s = sessionStorage.getItem('dm_os_session');
    if (!s) { s = `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; sessionStorage.setItem('dm_os_session', s); }
    return s;
  } catch {
    return `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
};
const newKey = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, '');

// Posts without the staff app's offline queue or shared idempotency header: the booking carries its own key.
async function post(path, body) {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: path.endsWith('/events') });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || res.statusText, data.details, data.request_id);
  return data;
}

// MM/DD/YYYY as it's typed (numbers only on phones) → YYYY-MM-DD.
const dobMask = (v) => {
  const d = v.replace(/\D/g, '').slice(0, 8);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join('/');
};
const dobIso = (v) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : '';
};
// Shrinks a card photo in the browser (a phone photo is several MB; a card reads fine at 1200px).
async function shrink(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
  const b64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
  return { mime: 'image/jpeg', file_base64: b64 };
}
const HEADLINES = { a: 'Book your visit online', b: 'Pick a time that works for you — it takes about a minute' };
const blankPerson = () => ({ first_name: '', last_name: '', dob: '' });

export default function BookingPage() {
  const t = useT();
  const lang = useLang();
  const { slug } = useParams();
  const [params] = useSearchParams();
  const embed = params.get('embed') === '1';
  const session = useMemo(sessionId, []);
  const variant = useMemo(() => (session.charCodeAt(session.length - 1) % 2 ? 'b' : 'a'), [session]);
  // Where the visitor came from: ?src= / UTM tags on the link, or the site that sent them (host only).
  const source = useMemo(() => {
    let ref = params.get('ref') || '';
    if (!ref && !embed && document.referrer) { try { const h = new URL(document.referrer).hostname; if (h !== window.location.hostname) ref = h; } catch { /* no referrer */ } }
    return { src: params.get('src') || '', utm_source: params.get('utm_source') || '', utm_medium: params.get('utm_medium') || '', utm_campaign: params.get('utm_campaign') || '', ref, variant };
  }, [params, embed, variant]);

  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [step, setStep] = useState('reason');
  const [locationId, setLocationId] = useState(null);
  const [type, setType] = useState(null);
  const [count, setCount] = useState(1);
  const [providerId, setProviderId] = useState('');
  const [days, setDays] = useState(null);
  const [nextFrom, setNextFrom] = useState(null);
  const [slotError, setSlotError] = useState(null);
  const [option, setOption] = useState(null);
  const [people, setPeople] = useState([blankPerson()]);
  const [contact, setContact] = useState({ phone: '', email: '' });
  const [answers, setAnswers] = useState({});
  const [notes, setNotes] = useState('');
  const [asap, setAsap] = useState(false);
  const [showIns, setShowIns] = useState(false);
  const [ins, setIns] = useState({ carrier: '', member_id: '', subscriber: '' });
  const [card, setCard] = useState(null);
  const [website, setWebsite] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [nearest, setNearest] = useState(null);
  const [done, setDone] = useState(null);
  const key = useRef(newKey());
  const heading = useRef(null);

  const track = (s, extra = {}) => post(`/public/os/${slug}/events`, { session, step: s, source: source.src || source.utm_source || null, variant, ...extra })
    .catch(() => { /* analytics only: a lost step never gets in the patient's way */ });

  useEffect(() => {
    api.get(`/public/os/${slug}`).then((p) => {
      setInfo(p);
      const offices = p.locations || [];
      const office = offices.length === 1 ? offices[0] : offices.find((l) => String(l.id) === params.get('location'));
      if (office) setLocationId(office.id);
      const pre = p.visit_types.find((v) => String(v.id) === params.get('type') || v.kind === params.get('kind'));
      if (pre && (!offices.length || office)) { setType(pre); setStep('time'); } else setStep(offices.length > 1 && !office ? 'office' : 'reason');
      if (pre) setType(pre);
      track('view');
    }).catch(setLoadError);
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each step's heading takes the focus, so screen readers (and keyboards) start in the right place; on the details
  // step it's the first name box, so typing can start straight away.
  useEffect(() => { heading.current?.focus(); }, [step]);

  // Open times for the chosen visit, office, provider and party size.
  const loadSlots = async (from = null) => {
    if (!type) return;
    setSlotError(null);
    const q = new URLSearchParams({ visit_type_id: type.id, people: count, ...(locationId ? { location_id: locationId } : {}), ...(providerId ? { provider_id: providerId } : {}), ...(from ? { from } : {}) });
    try {
      const r = await api.get(`/public/os/${slug}/slots?${q}`);
      setDays((d) => (from && d ? [...d, ...r.days] : r.days));
      setNextFrom(r.next_from);
    } catch (e) {
      setSlotError(e);
      if (!from) setDays([]);
    }
  };
  useEffect(() => { if (step === 'time') { setDays(null); loadSlots(); } }, [step, type, locationId, providerId, count]); // eslint-disable-line react-hooks/exhaustive-deps

  // Turnstile, when the office has turned it on.
  const captchaBox = useRef(null);
  useEffect(() => {
    const k = info?.captcha_site_key;
    if (!k || step !== 'details' || !captchaBox.current) return;
    const draw = () => window.turnstile?.render(captchaBox.current, { sitekey: k, callback: setCaptcha, 'expired-callback': () => setCaptcha('') });
    if (window.turnstile) { draw(); return; }
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = draw;
    document.head.appendChild(s);
  }, [info, step]);

  const tellParent = (action, extra = {}) => { if (embed && window.parent !== window) window.parent.postMessage({ type: 'dm-booking', action, ...extra }, '*'); };

  // A server without the online scheduling routes yet answers the API's plain 404: use the earlier page.
  if (loadError?.status === 404 && loadError.message === 'Not found') return <BookingPageClassic />;
  if (loadError) return <PublicLayout title={t('Online booking')}><ErrorBox error={loadError} /></PublicLayout>;
  if (!info) return <PublicLayout title={t('Online booking')}><p aria-live="polite">{t('Loading…')}</p></PublicLayout>;

  const practice = info.practice;
  const brandStyle = info.brand?.color ? { '--primary': info.brand.color, '--primary-soft': `${info.brand.color}1f` } : undefined;
  const label = (v) => (lang === 'es' && v.label_es) || t(v.label);
  const qLabel = (q) => (lang === 'es' && q.label_es) || t(q.label);
  const offices = info.locations || [];
  const office = offices.find((l) => l.id === locationId);
  const types = info.visit_types.filter((v) => !v.location_ids.length || !locationId || v.location_ids.includes(locationId));
  const returned = params.get('deposit') || params.get('card');
  const headline = (lang === 'es' && info.brand?.headline_es) || info.brand?.headline || t(HEADLINES[variant]);

  const layout = (title, body) => (
    <div className={`os-page${embed ? ' os-embed' : ''}`} style={brandStyle}>
      <PublicLayout title={title} practice={practice} logo={info.brand?.logo_url} compact={embed}>{body}</PublicLayout>
    </div>
  );

  if (returned) {
    const ok = returned === 'paid' || returned === 'saved';
    return layout(ok ? t('Thank you!') : t('Not finished'), (
      <div className={`public-notice${ok ? ' ok' : ''}`} role="status">
        {returned === 'paid' && t('Your deposit is paid and {practice} will confirm your visit by text or email in a moment.', { practice: practice.name })}
        {returned === 'saved' && t('Your card is saved. See you soon!')}
        {returned === 'cancelled' && <>{t('The deposit wasn’t paid, so the time wasn’t booked.')} <a href={`/book/${slug}`}>{t('Choose a time again')}</a></>}
        {returned === 'skipped' && t('No problem — your visit is still booked. You can give us a card at your visit.')}
      </div>
    ));
  }

  const chooseOffice = (l) => { setLocationId(l.id); track('office'); setStep(type ? 'time' : 'reason'); };
  const chooseType = (v) => {
    setType(v);
    if (!v.family) setCount(1);
    setAnswers({});
    track('reason', { kind: v.kind });
    setStep('time');
  };
  const chooseTime = (o) => {
    setOption(o);
    setNearest(null);
    setError(null);
    key.current = newKey();
    setPeople((list) => Array.from({ length: count }, (_, i) => list[i] || blankPerson()));
    track('time', { kind: type.kind });
    setStep('details');
  };
  const back = () => {
    setError(null);
    if (step === 'details') setStep('time');
    else if (step === 'time') setStep('reason');
    else if (step === 'reason' && offices.length > 1) setStep('office');
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    track('details', { kind: type.kind });
    const list = people.map((p) => ({ ...p, dob: dobIso(p.dob) }));
    const bad = list.findIndex((p) => !p.dob);
    if (bad >= 0) { setError(new Error(t('Please enter the date of birth as MM/DD/YYYY'))); return; }
    setBusy(true);
    try {
      const r = await post(`/public/os/${slug}/book`, {
        key: key.current, session, visit_type_id: type.id, location_id: locationId, start: option.start, ...(providerId ? { provider_id: Number(providerId) } : {}),
        people: list, phone: contact.phone, email: contact.email, answers, notes, asap, language: lang, website, captcha, source,
        insurance: { carrier: ins.carrier, member_id: ins.member_id, subscriber: ins.subscriber, ...(card ? { card_front: card } : {}) },
      });
      // A deposit or saving a card happens on the card company's own secure page.
      const away = r.checkout_url || r.card_url;
      if (away) { if (embed) window.open(away, '_top'); else window.location.assign(away); }
      setDone(r);
      setStep('done');
      tellParent('booked', { status: r.status });
    } catch (err) {
      if (err.status === 409 && err.details?.nearest) {
        setNearest(err.details.nearest);
        key.current = newKey();
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const setPerson = (i, k) => (e) => setPeople((list) => list.map((p, j) => (j === i ? { ...p, [k]: k === 'dob' ? dobMask(e.target.value) : e.target.value } : p)));
  const when = option ? `${fmtDateL(lang, option.start, { weekday: 'short', month: 'short', day: 'numeric' })}, ${fmtTimeL(lang, option.start)}` : '';
  const stepNo = { office: 1, reason: offices.length > 1 ? 2 : 1, time: offices.length > 1 ? 3 : 2, details: offices.length > 1 ? 4 : 3 }[step];
  const stepsTotal = offices.length > 1 ? 4 : 3;

  if (step === 'done' && done) {
    const booked = done.status === 'booked';
    return layout(booked ? t('You’re booked!') : t('Request received'), (
      <div className="card os-done">
        <div className="public-notice ok" role="status">
          {booked
            ? t('See you soon! A confirmation is on its way by {by}.', { by: contact.phone ? t('text') : t('email') })
            : t('Thanks! {practice} will confirm your time by {by} shortly.', { practice: practice.name, by: contact.phone ? t('text') : t('email') })}
          {done.urgent && <div style={{ marginTop: 8 }}><strong>{t('Because you’re in pain, someone from our office will call you shortly.')}</strong></div>}
        </div>
        <ul className="os-visits">
          {(done.visits || []).map((v, i) => (
            <li key={i}><strong>{v.first_name}</strong> — {fmtDateL(lang, v.start)}, {fmtTimeL(lang, v.start)}{v.provider_name ? ` · ${v.provider_name}` : ''}</li>
          ))}
        </ul>
        {booked && (
          <div className="os-actions">
            {done.ics_url && <a className="button" href={done.ics_url}>{t('Add to calendar')}</a>}
            {done.manage_url && <a className="button" href={done.manage_url} target={embed ? '_top' : undefined}>{t('Change or cancel')}</a>}
          </div>
        )}
        {booked && <p className="muted">{t('New patients: we’ll send forms to fill in before your visit, so check-in is quick.')}</p>}
        {embed && <button type="button" className="link" onClick={() => tellParent('close')}>{t('Close')}</button>}
      </div>
    ));
  }

  const Back = () => (step !== 'reason' || offices.length > 1) && step !== 'office'
    ? <button type="button" className="link os-back" onClick={back}>← {t('Back')}</button> : null;

  return layout(null, (
    <>
      <div className="os-top">
        <p className="os-headline">{headline}</p>
        <div className="os-progress" aria-label={t('Step {n} of {total}', { n: stepNo, total: stepsTotal })}>
          {Array.from({ length: stepsTotal }, (_, i) => <span key={i} className={i < stepNo ? 'on' : ''} />)}
        </div>
      </div>

      {step === 'office' && (
        <section className="card" aria-labelledby="os-h">
          <h2 id="os-h" tabIndex={-1} ref={heading}>{t('Which office?')}</h2>
          <div className="choice-grid">
            {offices.map((l) => (
              <button key={l.id} type="button" className="choice" onClick={() => chooseOffice(l)}>
                {l.name}<span className="muted">{[l.address, l.city].filter(Boolean).join(', ')}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 'reason' && (
        <section className="card" aria-labelledby="os-h">
          <Back />
          <h2 id="os-h" tabIndex={-1} ref={heading}>{t('What do you need?')}</h2>
          {office && <p className="muted">{office.name}</p>}
          <div className="os-types">
            {types.map((v) => (
              <button key={v.id} type="button" className={`choice os-type kind-${v.kind}`} onClick={() => chooseType(v)}>
                <strong>{label(v)}</strong>
                {(v.blurb || v.blurb_es) && <span className="muted">{(lang === 'es' && v.blurb_es) || t(v.blurb)}</span>}
                <span className="muted">{t('{n} min', { n: v.duration })}{v.who === 'existing' ? ` · ${t('current patients')}` : v.who === 'new' ? ` · ${t('new patients')}` : ''}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 'time' && type && (
        <section className="card" aria-labelledby="os-h">
          <Back />
          <h2 id="os-h" tabIndex={-1} ref={heading}>{t('Pick a time')}</h2>
          <p className="muted">{label(type)}{office ? ` · ${office.name}` : ''}</p>
          {type.kind === 'emergency' && (
            <div className="os-warn" role="note">
              {t('Trouble breathing or swallowing, or swelling spreading to your eye or neck? Call 911 or go to the emergency room now.')}
              {practice.phone && <> {t('Can’t find a time today? Call us at')} <a href={`tel:${practice.phone}`}>{practice.phone}</a>.</>}
            </div>
          )}
          <div className="os-filters">
            {type.family && (
              <div className="os-count" role="group" aria-label={t('How many people?')}>
                <span className="muted">{t('Booking for')}</span>
                {Array.from({ length: type.family_max }, (_, i) => i + 1).map((n) => (
                  <button key={n} type="button" className={`chip${count === n ? ' selected' : ''}`} aria-pressed={count === n} onClick={() => setCount(n)}>
                    {n === 1 ? t('Just me') : t('{n} people', { n })}
                  </button>
                ))}
              </div>
            )}
            {info.providers.length > 1 && (
              <label className="os-provider">{t('Provider')}
                <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                  <option value="">{t('No preference')}</option>
                  {info.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}
          </div>
          {count > 1 && <p className="muted">{t('Back-to-back visits, one after the other.')}</p>}
          <ErrorBox error={slotError} />
          {days === null && <p className="muted" aria-live="polite">{t('Checking availability…')}</p>}
          {days?.length === 0 && <p>{t('No online times in the coming weeks.')} {practice.phone && <>{t('Please call us at')} <a href={`tel:${practice.phone}`}>{practice.phone}</a>.</>}</p>}
          {days?.map((d) => (
            <div key={d.date} className="os-day">
              <h3>{fmtDateL(lang, d.date, { weekday: 'long', month: 'long', day: 'numeric' })}{d.date === practice.today ? ` · ${t('today')}` : ''}</h3>
              <div className="slot-grid">
                {d.options.map((o) => (
                  <button key={o.start} type="button" className="choice os-slot" onClick={() => chooseTime(o)}
                    aria-label={`${fmtDateL(lang, o.start, { weekday: 'long', month: 'long', day: 'numeric' })} ${fmtTimeL(lang, o.start)}${o.items[0]?.provider_name ? `, ${o.items[0].provider_name}` : ''}`}>
                    {fmtTimeL(lang, o.start)}
                    {!providerId && info.providers.length > 1 && <span className="muted">{o.items[0]?.provider_name}</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {days?.length > 0 && nextFrom && <button type="button" className="link" onClick={() => loadSlots(nextFrom)}>{t('Show later dates')}</button>}
        </section>
      )}

      {step === 'details' && option && (
        <form className="card" onSubmit={submit} aria-labelledby="os-h" noValidate>
          <Back />
          <h2 id="os-h">{t('Your details')}</h2>
          <p className="os-when"><strong>{label(type)}</strong> · {when}{option.items[0]?.provider_name ? ` · ${option.items[0].provider_name}` : ''}</p>
          {error && <div className="error" role="alert">{error.message}</div>}
          {nearest && (
            <div className="os-nearest">
              <div className="slot-grid">
                {nearest.map((o) => (
                  <button key={o.start} type="button" className="choice" onClick={() => { setOption(o); setNearest(null); setError(null); key.current = newKey(); }}>
                    {fmtDateL(lang, o.start, { weekday: 'short', month: 'short', day: 'numeric' })}<span>{fmtTimeL(lang, o.start)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {people.map((p, i) => (
            <fieldset key={i} className="os-person">
              {people.length > 1 && <legend>{t('Person {n}', { n: i + 1 })} · {fmtTimeL(lang, option.items[i]?.start)}</legend>}
              <div className="form-grid">
                <label>{t('First name')}<input required ref={i === 0 ? heading : undefined} value={p.first_name} onChange={setPerson(i, 'first_name')} autoComplete={i ? 'off' : 'given-name'} enterKeyHint="next" /></label>
                <label>{t('Last name')}<input required value={p.last_name} onChange={setPerson(i, 'last_name')} autoComplete={i ? 'off' : 'family-name'} enterKeyHint="next" /></label>
                <label>{t('Date of birth')}<input required inputMode="numeric" placeholder="MM/DD/YYYY" value={p.dob} onChange={setPerson(i, 'dob')} autoComplete={i ? 'off' : 'bday'} aria-describedby="os-dob-hint" /></label>
              </div>
            </fieldset>
          ))}
          <span id="os-dob-hint" className="sr-only">MM/DD/YYYY</span>
          <div className="form-grid">
            <label>{t('Mobile phone')}<input type="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} autoComplete="tel" /></label>
            <label>{t('Email')}<input type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} autoComplete="email" /></label>
          </div>

          {type.questions.map((q) => (
            <div key={q.key} className="os-q" role="group" aria-labelledby={`q-${q.key}`}>
              <div id={`q-${q.key}`} className="os-q-label">{qLabel(q)}{q.required ? ' *' : ''}</div>
              {q.type === 'scale' && (
                <div className="os-scale">
                  {Array.from({ length: 11 }, (_, n) => (
                    <button key={n} type="button" className={`chip${answers[q.key] === n ? ' selected' : ''}`} aria-pressed={answers[q.key] === n} onClick={() => setAnswers({ ...answers, [q.key]: n })}>{n}</button>
                  ))}
                </div>
              )}
              {q.type === 'yesno' && (
                <div className="os-yesno">
                  {[[true, t('Yes')], [false, t('No')]].map(([v, l]) => (
                    <button key={l} type="button" className={`chip${answers[q.key] === v ? ' selected' : ''}`} aria-pressed={answers[q.key] === v} onClick={() => setAnswers({ ...answers, [q.key]: v })}>{l}</button>
                  ))}
                </div>
              )}
              {q.type === 'choice' && (
                <div className="os-yesno">
                  {q.options.map((o) => (
                    <button key={o} type="button" className={`chip${answers[q.key] === o ? ' selected' : ''}`} aria-pressed={answers[q.key] === o} onClick={() => setAnswers({ ...answers, [q.key]: o })}>{t(o)}</button>
                  ))}
                </div>
              )}
              {q.type === 'text' && <input value={answers[q.key] || ''} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} maxLength={300} aria-labelledby={`q-${q.key}`} />}
            </div>
          ))}

          {!showIns
            ? <button type="button" className="link os-more" onClick={() => setShowIns(true)}>+ {t('Add dental insurance (optional)')}</button>
            : (
              <div className="form-grid os-ins">
                <label>{t('Insurance company')}<input value={ins.carrier} onChange={(e) => setIns({ ...ins, carrier: e.target.value })} placeholder={t('e.g. Delta Dental')} /></label>
                <label>{t('Member ID')}<input value={ins.member_id} onChange={(e) => setIns({ ...ins, member_id: e.target.value })} /></label>
                <label className="full">{t('Policy holder, if not you')}<input value={ins.subscriber} onChange={(e) => setIns({ ...ins, subscriber: e.target.value })} placeholder={t('Full name')} /></label>
                <label className="full">{t('Or a photo of the front of your card')}
                  <input type="file" accept="image/*" capture="environment" onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) { setCard(null); return; }
                    try { setCard(await shrink(f)); } catch { setError(new Error(t('That picture couldn’t be used — try another photo, or type the details'))); }
                  }} />
                </label>
                {card && <span className="muted full">{t('Card photo added — the office will check it for you.')}</span>}
              </div>
            )}
          <label className="full os-notes">{t('Anything we should know? (optional)')}<textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></label>
          <label className="checkbox"><input type="checkbox" checked={asap} onChange={(e) => setAsap(e.target.checked)} /> {t('Text me if an earlier time opens up')}</label>
          {/* Hidden from people; bots fill it in. */}
          <input tabIndex={-1} autoComplete="off" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} className="os-hp" aria-hidden="true" />
          {info.captcha_site_key && <div ref={captchaBox} style={{ margin: '8px 0' }} />}
          {type.deposit > 0 && (type.deposit_rule === 'always' || type.deposit_rule === 'new_patients' || type.deposit_rule === 'risky_slots') && (
            <p className="muted">{t('Some visits need a {amount} deposit to hold the time. If so, you’ll pay it on a secure card page next, and it comes off your bill.', { amount: `$${(type.deposit / 100).toFixed(2)}` })}</p>
          )}
          <p className="muted os-privacy">{t('Please don’t include medical details here. We’ll send you secure forms before your visit.')}</p>
          <button className="primary big os-submit" disabled={busy || (!!info.captcha_site_key && !captcha)}>
            {busy ? t('Booking…') : t(type.mode === 'request' ? 'Request {when}' : 'Book {when}', { when })}
          </button>
        </form>
      )}
    </>
  ));
}
