import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, ChevronLeft, ChevronRight, Camera, PenLine, ShieldCheck, XCircle, UserRound } from 'lucide-react';
import { ErrorBox } from '../../components/ui.jsx';
import SignaturePad from '../../components/SignaturePad.jsx';
import PublicLayout from './PublicLayout.jsx';
import { setLang, suggestLang, useLang } from './i18n.js';
import { usePT } from './paperwork-i18n.js';
import { DobGate, publicCall, readPass, savePass } from './LinkPass.jsx';
import { BackToOffice, useHandoff } from './HandOff.jsx';
import './paperwork.css';

// The patient's forms, one friendly screen at a time: a link on their own phone (/p/:token, after their birth
// date), this screen handed over by staff, or the office iPad in kiosk mode (Kiosk.jsx uses PaperworkFlow).
// Health history, the office's forms and consents; English or Spanish; a parent or guardian signs for a child;
// a team member can sign as witness on the office device; a consent can be declined — recorded just the same.
export default function PaperworkPage() {
  const pt = usePT();
  const { token } = useParams();
  const hand = useHandoff('paper', token);
  const [stored, setPass] = useState(() => readPass('paper', token));
  const pass = hand.pass || stored;
  const [view, setView] = useState(null);
  const [locked, setLocked] = useState(null);
  const [error, setError] = useState(null);
  const call = (method, path, body) => publicCall(method, `/papers/${token}${path}`, body, 'X-Form-Pass', pass);
  const load = () => call('GET', '')
    .then((v) => { suggestLang(v.language); setLocked(null); setView(v); })
    .catch((e) => (e.details?.dob_required ? (suggestLang(e.details.language), setLocked(e.details)) : setError(e)));
  useEffect(() => { if (!hand.checking) load(); }, [token, pass, hand.checking]); // eslint-disable-line react-hooks/exhaustive-deps

  if (locked && !view) {
    return (
      <DobGate title={pt('Patient forms')} practice={{ name: locked.practice_name }} onPass={(p) => { savePass('paper', token, p); setPass(p); }}
        verify={async (dob) => (await publicCall('POST', `/papers/${token}/verify`, { dob })).pass} />
    );
  }
  if (error) return <PublicLayout title={pt('Patient forms')}><ErrorBox error={error} /></PublicLayout>;
  if (!view) return <PublicLayout title={pt('Patient forms')}><p>{pt('Loading…')}</p></PublicLayout>;
  return (
    <PublicLayout practice={view.practice}>
      <PaperworkFlow view={view} mode={view.via === 'handoff' ? 'handoff' : 'link'} post={(path, body) => call('POST', path, body)} reload={load}
        footer={<BackToOffice back={hand.back} />} />
    </PublicLayout>
  );
}

const shrink = async (file, max = 1400) => {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } finally { URL.revokeObjectURL(url); }
};

// mode: 'link' | 'handoff' | 'kiosk'. post(path, body) → the server (relative to the link or the kiosk session).
export function PaperworkFlow({ view, mode, post, reload, onFinished, onActivity, footer = null }) {
  const pt = usePT();
  const lang = useLang();
  const todo = useMemo(() => view.forms.filter((f) => f.status === 'pending'), [view]);
  const [step, setStep] = useState(todo.length > 1 || mode === 'kiosk' ? -1 : 0); // -1: welcome
  const [done, setDone] = useState([]);
  const left = todo.filter((f) => !done.includes(f.id));
  const current = step >= 0 ? left[0] : null;
  const total = view.forms.length;
  const page = view.forms.length - left.length + (current ? 1 : 0);
  const topRef = useRef(null);

  // Staff see "page 3 of 5" live.
  useEffect(() => {
    // Until they tap Start, the team sees "waiting for Jane".
    if (step >= 0) post('/progress', { page: Math.max(page, 1), total }).catch(() => { /* progress is a nicety; the forms still work */ });
    topRef.current?.scrollIntoView?.({ block: 'start' });
  }, [page, step]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (step >= 0 && !current) onFinished?.(); }, [current, step]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = (id) => { setDone((d) => [...d, id]); onActivity?.(); };

  if (step < 0) {
    return (
      <div className="pw" ref={topRef}>
        <div className="pw-hero">
          <div className="pw-hero-icon"><ShieldCheck size={44} strokeWidth={1.6} /></div>
          <h1>{pt('Hi {name}!', { name: view.first_name })}</h1>
          <p className="pw-lead">{todo.length === 1 ? pt('You have 1 form to complete. It takes a few minutes.') : pt('You have {n} forms to complete. It takes a few minutes.', { n: todo.length })}</p>
          <LangChoice />
          <button type="button" className="pw-primary" autoFocus onClick={() => setStep(0)}>{pt('Start')} <ChevronRight size={22} /></button>
        </div>
      </div>
    );
  }
  if (!current) {
    return (
      <div className="pw" ref={topRef}>
        <div className="pw-hero">
          <div className="pw-hero-icon ok"><CheckCircle2 size={52} strokeWidth={1.6} /></div>
          <h1>{pt('All done — thank you!')}</h1>
          <p className="pw-lead">{pt('Your forms were sent securely to {practice}.', { practice: view.practice?.name || '' })}</p>
          {mode !== 'link' && <p className="pw-lead strong">{pt('Please hand the iPad back to the team.')}</p>}
        </div>
        {footer}
      </div>
    );
  }
  const header = (
    <div className="pw-steps" ref={topRef}>
      <div className="pw-step-label">{pt('Form {n} of {total}', { n: page, total })}</div>
      <div className="pw-bar"><span style={{ width: `${Math.round((page / Math.max(total, 1)) * 100)}%` }} /></div>
    </div>
  );
  return (
    <div className="pw">
      {header}
      {current.kind === 'medical_history'
        ? <HistoryStep key={current.id} view={view} post={post} lang={lang} onDone={() => finish(current.id)} onActivity={onActivity} />
        : <FormStep key={`${current.id}:${current.version_id}`} form={current} view={view} mode={mode} post={post} lang={lang} reload={reload} onDone={() => finish(current.id)} onActivity={onActivity} />}
      {footer}
    </div>
  );
}

function LangChoice() {
  const lang = useLang();
  return (
    <div className="pw-lang" role="group" aria-label="Language / Idioma">
      <button type="button" className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>English</button>
      <button type="button" className={lang === 'es' ? 'on' : ''} onClick={() => setLang('es')}>Español</button>
    </div>
  );
}

function Req() { return <span className="pw-req" aria-label="required">*</span>; }

// One field, big enough for a finger.
function BigField({ f, value, set }) {
  const pt = usePT();
  const lang = useLang();
  if (f.type === 'heading') return <h2 className="pw-h">{f.label}</h2>;
  if (f.type === 'paragraph') return <p className="pw-p">{f.text}</p>;
  const label = <>{f.label}{f.required && <Req />}</>;
  const extra = f.text ? <p className="pw-p">{f.text}</p> : null;
  switch (f.type) {
    case 'checkbox':
      return (<>{extra}<label className={`pw-check${value ? ' on' : ''}`}><input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} /><span>{label}</span></label></>);
    case 'yesno':
      return (
        <div className="pw-q">{extra}<div className="pw-qlabel">{label}</div>
          <div className="pw-seg">{['yes', 'no'].map((v) => <button type="button" key={v} className={value === v ? 'on' : ''} aria-pressed={value === v} onClick={() => set(v)}>{v === 'yes' ? pt('Yes') : pt('No')}</button>)}</div>
        </div>
      );
    case 'select': {
      const shown = lang === 'es' && f.options_es ? f.options_es : f.options;
      return (
        <div className="pw-q">{extra}<div className="pw-qlabel">{label}</div>
          <div className="pw-choices">{f.options.map((o, i) => <button type="button" key={o} className={value === o ? 'on' : ''} aria-pressed={value === o} onClick={() => set(o)}>{shown[i] || o}</button>)}</div>
        </div>
      );
    }
    case 'initials':
      return (<>{extra}<label className="pw-initials"><input maxLength={4} value={value || ''} onChange={(e) => set(e.target.value.toUpperCase())} aria-label={f.label} placeholder="—" /><span>{label}</span></label></>);
    case 'textarea':
      return (<label className="pw-field">{extra}<span className="pw-qlabel">{label}</span><textarea rows={3} value={value || ''} onChange={(e) => set(e.target.value)} /></label>);
    case 'date':
      return (<label className="pw-field">{extra}<span className="pw-qlabel">{label}</span><input type="date" value={value || ''} onChange={(e) => set(e.target.value)} /></label>);
    case 'photo':
      return (
        <div className="pw-q">{extra}<div className="pw-qlabel">{label}</div>
          {value && <img className="pw-photo" src={value} alt="" />}
          <label className="pw-secondary pw-camera"><Camera size={20} /> {value ? pt('Retake') : pt('Take a photo')}
            <input type="file" accept="image/*" capture="environment" onChange={async (e) => { const file = e.target.files?.[0]; if (file) set(await shrink(file)); }} />
          </label>
        </div>
      );
    case 'signature':
      return (<div className="pw-q">{extra}<div className="pw-qlabel"><PenLine size={18} /> {label}</div><div className="pw-sign"><SignaturePad onChange={set} /></div></div>);
    default:
      return (<label className="pw-field">{extra}<span className="pw-qlabel">{label}</span><input value={value || ''} onChange={(e) => set(e.target.value)} /></label>);
  }
}

const REL = [['self', 'I am the patient'], ['parent', 'Parent'], ['guardian', 'Legal guardian'], ['representative', 'Legal representative']];
function Signer({ view, relationship, setRelationship, name, setName }) {
  const pt = usePT();
  const choices = view.minor ? REL.filter(([k]) => k !== 'self') : REL;
  return (
    <div className="pw-card">
      <div className="pw-qlabel"><UserRound size={18} /> {pt('Who is signing?')}</div>
      {view.minor && <p className="pw-p">{pt('Because {name} is under 18, a parent or guardian signs.', { name: view.first_name })}</p>}
      <div className="pw-choices">{choices.map(([k, l]) => <button type="button" key={k} className={relationship === k ? 'on' : ''} aria-pressed={relationship === k} onClick={() => setRelationship(k)}>{pt(l)}</button>)}</div>
      <label className="pw-field"><span className="pw-qlabel">{pt('Full name of the person signing')}<Req /></span><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
    </div>
  );
}

function missing(fields, answers) {
  return fields.filter((f) => f.key && f.required && (answers[f.key] == null || answers[f.key] === '' || answers[f.key] === false));
}

function FormStep({ form, view, mode, post, lang, reload, onDone, onActivity }) {
  const pt = usePT();
  const fields = (lang === 'es' && form.fields.es) || form.fields.en;
  const [answers, setAnswers] = useState({});
  const [relationship, setRelationship] = useState(view.minor ? '' : 'self');
  const [name, setName] = useState('');
  const [stage, setStage] = useState('form'); // form | witness | decline
  const [witness, setWitness] = useState({ name: '', signature: null });
  const [decline, setDecline] = useState({ reason: '', signature: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const needWitness = form.witness && mode !== 'link';
  const set = (k) => (v) => { setAnswers((a) => ({ ...a, [k]: v })); onActivity?.(); };
  const holes = missing(fields, answers);
  const ready = !holes.length && name.trim() && relationship;

  const send = async (path, body) => {
    setBusy(true);
    setError(null);
    try {
      await post(path, body);
      onDone();
    } catch (e) {
      if (e.status === 409 && e.details?.changed) { setError(new Error(pt('This form was updated by the office. Please read it again.'))); reload?.(); } else setError(e);
    } finally { setBusy(false); }
  };
  const sign = () => send(`/forms/${form.id}`, {
    answers, signature_name: name.trim(), signer_relationship: relationship, version_id: form.version_id, lang: lang === 'es' && form.fields.es ? 'es' : 'en',
    ...(needWitness ? { witness } : {}),
  });

  if (stage === 'decline') {
    return (
      <div className="pw-card">
        <h1 className="pw-title">{form.name}</h1>
        <p className="pw-p">{pt('You don’t have to consent. Please tell us why (optional), and sign to show you were offered this treatment.')}</p>
        <label className="pw-field"><span className="pw-qlabel">{pt('Reason (optional)')}</span><textarea rows={3} value={decline.reason} onChange={(e) => setDecline({ ...decline, reason: e.target.value })} /></label>
        <Signer view={view} relationship={relationship} setRelationship={setRelationship} name={name} setName={setName} />
        <div className="pw-q"><div className="pw-qlabel"><PenLine size={18} /> {pt('Sign here with your finger')}</div><div className="pw-sign"><SignaturePad onChange={(s) => setDecline((d) => ({ ...d, signature: s }))} /></div></div>
        <ErrorBox error={error} />
        <div className="pw-actions">
          <button type="button" className="pw-secondary" onClick={() => setStage('form')}><ChevronLeft size={20} /> {pt('Go back to the form')}</button>
          <button type="button" className="pw-danger" disabled={busy || !name.trim() || !relationship}
            onClick={() => send(`/forms/${form.id}/decline`, { reason: decline.reason, signature_name: name.trim(), signature: decline.signature, signer_relationship: relationship, lang })}>
            <XCircle size={20} /> {pt('Record that I don’t consent')}
          </button>
        </div>
      </div>
    );
  }
  if (stage === 'witness') {
    return (
      <div className="pw-card">
        <h1 className="pw-title">{pt('Witness')}</h1>
        <p className="pw-lead strong">{pt('Please hand the iPad back to the team.')}</p>
        <p className="pw-p">{pt('A team member signs as witness')}: {form.name}</p>
        <label className="pw-field"><span className="pw-qlabel">{pt('Team member’s name')}<Req /></span><input value={witness.name} onChange={(e) => setWitness({ ...witness, name: e.target.value })} /></label>
        <div className="pw-q"><div className="pw-qlabel"><PenLine size={18} /> {pt('Sign here with your finger')}</div><div className="pw-sign"><SignaturePad onChange={(s) => setWitness((w) => ({ ...w, signature: s }))} /></div></div>
        <ErrorBox error={error} />
        <div className="pw-actions">
          <button type="button" className="pw-secondary" onClick={() => setStage('form')}><ChevronLeft size={20} /> {pt('Back')}</button>
          <button type="button" className="pw-primary" disabled={busy || !witness.name.trim() || !witness.signature} onClick={sign}>{busy ? pt('Sending…') : pt('Sign and continue')}</button>
        </div>
      </div>
    );
  }
  return (
    <form className="pw-card" onSubmit={(e) => { e.preventDefault(); if (ready) (needWitness ? setStage('witness') : sign()); }}>
      <h1 className="pw-title">{form.name}</h1>
      {fields.filter((f) => f.type !== 'signature').map((f, i) => <BigField key={f.key || `s${i}`} f={f} value={f.key ? answers[f.key] : undefined} set={set(f.key)} />)}
      <Signer view={view} relationship={relationship} setRelationship={setRelationship} name={name} setName={setName} />
      {fields.filter((f) => f.type === 'signature').map((f) => <BigField key={f.key} f={{ ...f, label: pt('Sign here with your finger') }} value={answers[f.key]} set={set(f.key)} />)}
      {holes.length > 0 && <p className="pw-hint">{pt('Please answer the questions marked with *')}</p>}
      <ErrorBox error={error} />
      <div className="pw-actions">
        {form.consent && <button type="button" className="pw-secondary" onClick={() => setStage('decline')}><XCircle size={20} /> {pt('I don’t consent')}</button>}
        <button type="submit" className="pw-primary" disabled={busy || !ready}>{busy ? pt('Sending…') : pt('Sign and continue')} <ChevronRight size={22} /></button>
      </div>
    </form>
  );
}

function HistoryStep({ view, post, lang, onDone, onActivity }) {
  const pt = usePT();
  const [a, setA] = useState(() => ({ conditions: [], consent_hipaa: false, consent_treatment: false, ...Object.fromEntries(Object.entries(view.prefill || {}).map(([k, v]) => [k, v || ''])) }));
  const [name, setName] = useState('');
  const [signature, setSignature] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const put = (k, v) => { setA((x) => ({ ...x, [k]: v })); onActivity?.(); };
  const text = (k, label, type = 'text') => <label className="pw-field"><span className="pw-qlabel">{pt(label)}</span><input type={type} value={a[k] || ''} onChange={(e) => put(k, e.target.value)} /></label>;
  const area = (k, label) => <label className="pw-field"><span className="pw-qlabel">{pt(label)}</span><textarea rows={2} value={a[k] || ''} onChange={(e) => put(k, e.target.value)} /></label>;
  const check = (k, label) => <label className={`pw-check${a[k] ? ' on' : ''}`}><input type="checkbox" checked={!!a[k]} onChange={(e) => put(k, e.target.checked)} /><span>{pt(label)}</span></label>;
  const ready = a.consent_hipaa && a.consent_treatment && name.trim().length > 1;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await post('/history', { answers: a, signature_name: name.trim(), signature_image: signature, lang }); onDone(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <form className="pw-card" onSubmit={submit}>
      <h1 className="pw-title">{pt('Health history')}</h1>
      <h2 className="pw-h">{pt('Contact details')}</h2>
      <div className="pw-grid">{text('phone', 'Mobile phone', 'tel')}{text('email', 'Email', 'email')}{text('address', 'Street address')}{text('city', 'City')}{text('state', 'State')}{text('zip', 'ZIP')}</div>
      {text('emergency_contact', 'Emergency contact (name & phone)')}
      <h2 className="pw-h">{pt('Medical history')}</h2>
      <p className="pw-p">{pt('Do you have, or have you ever had, any of the following?')}</p>
      <div className="pw-chips">
        {view.conditions.map((c) => {
          const on = a.conditions.includes(c);
          return <button type="button" key={c} className={on ? 'on' : ''} aria-pressed={on} onClick={() => put('conditions', on ? a.conditions.filter((x) => x !== c) : [...a.conditions, c])}>{pt(c)}</button>;
        })}
      </div>
      {area('allergies', 'Allergies (medications, latex, foods)')}
      {area('medications', 'Current medications & supplements')}
      {area('other_conditions', 'Other conditions or surgeries')}
      {check('premedication', 'I have been told to take antibiotics before dental visits')}
      {check('pregnant', 'I am pregnant or may be pregnant')}
      {check('tobacco', 'I use tobacco or vape')}
      <h2 className="pw-h"><ShieldCheck size={18} /> {pt('Sign and continue')}</h2>
      {check('consent_hipaa', 'I acknowledge I have been offered the Notice of Privacy Practices.')}
      {check('consent_treatment', 'The information above is accurate to the best of my knowledge, and I consent to examination and necessary diagnostic x-rays.')}
      <label className="pw-field"><span className="pw-qlabel">{pt('Full name of the person signing')}<Req /></span><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
      <div className="pw-q"><div className="pw-qlabel"><PenLine size={18} /> {pt('Sign here with your finger')}</div><div className="pw-sign"><SignaturePad onChange={setSignature} /></div></div>
      <ErrorBox error={error} />
      <div className="pw-actions"><button type="submit" className="pw-primary" disabled={busy || !ready}>{busy ? pt('Sending…') : pt('Sign and continue')} <ChevronRight size={22} /></button></div>
    </form>
  );
}
