import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { money } from '../../format.js';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import { suggestLang, useLang } from './i18n.js';
import { useBT } from './billing-i18n.js';
import { PayForm } from './PortalAccount.jsx';
import './billpay.css';

// "Pay my bill" from the practice's website (PT3): find the bill with the code on the statement (or last name,
// date of birth and ZIP or phone), see only the amount due, pay it. A one-time code opens the full account in the
// patient portal. Mobile-first; English and Spanish. docs/workflows/specs/PT-portal.md.

const KEY = 'dm_billpay';
const remember = (slug, v) => { try { if (v) sessionStorage.setItem(`${KEY}_${slug}`, JSON.stringify(v)); else sessionStorage.removeItem(`${KEY}_${slug}`); } catch { /* private mode */ } };
const recall = (slug) => { try { return JSON.parse(sessionStorage.getItem(`${KEY}_${slug}`)); } catch { return null; } };
const newKey = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function call(method, path, body, token) {
  const res = await fetch(`/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method === 'POST' ? { 'Idempotency-Key': newKey() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

export default function BillPay() {
  const t = useBT();
  const lang = useLang();
  const { slug } = useParams();
  const [params, setParams] = useSearchParams();
  const [practice, setPractice] = useState(null);
  const [missing, setMissing] = useState(false);
  const [bill, setBill] = useState(() => recall(slug)); // { token, amount_due, verify }
  const [paid, setPaid] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    call('GET', `/public/billpay/${encodeURIComponent(slug)}`).then(setPractice).catch(() => setMissing(true));
  }, [slug]);
  const found = (b) => { setBill(b); remember(slug, b); if (b.language) suggestLang(b.language); };
  // A link with the code in it (the statement's QR code or a text) goes straight to the amount due.
  const linkCode = params.get('code');
  const tried = useRef(false);
  useEffect(() => {
    if (!linkCode || tried.current || !practice) return;
    tried.current = true;
    call('POST', `/public/billpay/${encodeURIComponent(slug)}/lookup`, { code: linkCode }).then(found).catch(setError);
    params.delete('code');
    setParams(params, { replace: true });
  }, [linkCode, practice]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back from the card processor's secure page.
  const sessionId = params.get('session_id');
  useEffect(() => {
    if (!sessionId || !bill?.token) return;
    call('GET', `/public/billpay/${encodeURIComponent(slug)}/return?session_id=${encodeURIComponent(sessionId)}`, null, bill.token)
      .then((r) => setPaid({ amount: r.amount, confirmation: r.confirmation, processing: r.status !== 'paid' }))
      .catch(() => setPaid({ processing: true }));
    setParams({}, { replace: true });
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const cancelled = params.get('pay') === 'cancelled';

  if (missing) return <PublicLayout title={t('Pay my bill')}><div className="public-notice">{t('This bill-pay page isn’t available. Please call your dental office.')}</div></PublicLayout>;
  return (
    <PublicLayout title={t('Pay my bill')} practice={practice}>
      <div className="bp-page">
        {paid ? <Paid practice={practice} paid={paid} bill={bill} slug={slug} onAnother={() => { setPaid(null); remember(slug, null); setBill(null); }} />
          : bill ? (
            <Due practice={practice} bill={bill} slug={slug} lang={lang} cancelled={cancelled} onPaid={(r) => { setPaid(r); setBill({ ...bill, amount_due: r.amount_due }); }} onStartOver={() => { remember(slug, null); setBill(null); }} />
          ) : <Find practice={practice} slug={slug} onFound={found} initialError={error} />}
      </div>
    </PublicLayout>
  );
}

function Find({ practice, slug, onFound, initialError }) {
  const t = useBT();
  const [mode, setMode] = useState('code');
  const [f, setF] = useState({ code: '', last_name: '', dob: '', zip: '', website: '' });
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const captchaRef = useRef(null);
  const [captcha, setCaptcha] = useState('');
  // Optional bot check (Cloudflare Turnstile) when the office has it on.
  useEffect(() => {
    if (!practice?.captcha_site_key) return;
    window.dmBillpayCaptcha = (tok) => setCaptcha(tok);
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.async = true;
    document.head.appendChild(s);
    return () => { s.remove(); delete window.dmBillpayCaptcha; };
  }, [practice?.captcha_site_key]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const zipOrPhone = f.zip.replace(/\D/g, '');
      const body = mode === 'code' ? { code: f.code, website: f.website, captcha } : { last_name: f.last_name, dob: f.dob, ...(zipOrPhone.length >= 10 ? { phone: zipOrPhone } : { zip: zipOrPhone }), website: f.website, captcha };
      onFound(await call('POST', `/public/billpay/${encodeURIComponent(slug)}/lookup`, body));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card bp-find" onSubmit={submit} aria-describedby="bp-find-help">
      <h2>{t('Find your bill')}</h2>
      <p id="bp-find-help" className="muted">{mode === 'code' ? t('Enter the statement code printed on your statement or in our text or email.') : t('Enter the patient’s last name and date of birth, and the ZIP code or phone number on the account.')}</p>
      {mode === 'code' ? (
        <label>{t('Statement code')}<input className="bp-code" autoFocus autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="XXXXX-XXXXX" required value={f.code} onChange={set('code')} /></label>
      ) : (
        <>
          <label>{t('Last name')}<input autoFocus autoComplete="family-name" required value={f.last_name} onChange={set('last_name')} /></label>
          <label>{t('Date of birth')}<input type="date" required value={f.dob} onChange={set('dob')} /></label>
          <label>{t('ZIP code or phone number')}<input inputMode="numeric" autoComplete="postal-code" required value={f.zip} onChange={set('zip')} /></label>
        </>
      )}
      {/* Honeypot: hidden from people and screen readers; bots fill it in. */}
      <div className="bp-hp" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} /></label></div>
      {practice?.captcha_site_key && <div ref={captchaRef} className="cf-turnstile" data-sitekey={practice.captcha_site_key} data-callback="dmBillpayCaptcha" />}
      <ErrorBox error={error} />
      <button className="primary big" disabled={busy}>{busy ? t('Looking…') : t('Find my bill')}</button>
      <button type="button" className="link" onClick={() => { setMode(mode === 'code' ? 'name' : 'code'); setError(null); }}>
        {mode === 'code' ? t('No statement handy? Use your name and date of birth') : t('I have a statement code')}
      </button>
      {practice?.phone && <p className="muted bp-small">{t('Questions about your bill? Call {phone}.', { phone: practice.phone })}</p>}
    </form>
  );
}

function Due({ practice, bill, slug, lang, cancelled, onPaid, onStartOver }) {
  const t = useBT();
  const due = bill.amount_due;
  const acct = {
    payment: {
      enabled: practice?.payments_enabled, mode: practice?.mode, ach: practice?.ach, wallets: practice?.wallets, max: due, suggested: due, can_save_card: false, email_on_file: true,
      pass_through: practice?.pass_through || null,
    },
    cards: [],
  };
  return (
    <section className="card bp-balance" aria-live="polite">
      <h2>{t('Amount due')}</h2>
      <div className="bp-amount" data-testid="amount-due">{money(due)}</div>
      {cancelled && <div className="public-notice">{t('No payment was taken. You can try again below.')}</div>}
      {due <= 0 ? <p>{t('Nothing is due right now — thank you!')}</p>
        : practice?.payments_enabled
          ? <PayForm acct={acct} token={bill.token} lookup path={`/public/billpay/${encodeURIComponent(slug)}/pay`} onPaid={(_msg, r) => onPaid(r)} key={lang} />
          : <p>{t('To pay, please call {phone}.', { phone: practice?.phone || t('the office') })}</p>}
      <Verify bill={bill} slug={slug} practice={practice} />
      <button type="button" className="link bp-small" onClick={onStartOver}>{t('Not your bill? Start over')}</button>
    </section>
  );
}

// Optional: a one-time code to the phone or email on file opens the full account (visits, statements, receipts).
function Verify({ bill, slug }) {
  const t = useBT();
  const [step, setStep] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  if (!bill.verify?.sms && !bill.verify?.email) return null;
  const send = async (channel) => {
    setError(null);
    try { await call('POST', `/public/billpay/${encodeURIComponent(slug)}/verify/send`, { channel }, bill.token); setStep(channel); } catch (e) { setError(e); }
  };
  const check = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await call('POST', `/public/billpay/${encodeURIComponent(slug)}/verify`, { code }, bill.token);
      try { sessionStorage.setItem(`dm_portal_${r.portal_key}`, r.portal_token); } catch { /* private mode */ }
      window.location.href = `/portal/${encodeURIComponent(r.portal_key)}`;
    } catch (err) { setError(err); }
  };
  return (
    <div className="bp-verify">
      {!step ? (
        <>
          <p className="muted bp-small">{t('Want to see the details — each visit, statements and receipts? We’ll send a one-time code to the contact on file.')}</p>
          <div className="bp-actions-inline">
            {bill.verify.sms && <button type="button" className="small" onClick={() => send('sms')}>{t('Text me a code')}</button>}
            {bill.verify.email && <button type="button" className="small" onClick={() => send('email')}>{t('Email me a code')}</button>}
          </div>
        </>
      ) : (
        <form onSubmit={check} className="bp-inline-form">
          <label>{step === 'email' ? t('Code from the email') : t('Code from the text')}<input className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus /></label>
          <button className="primary" disabled={code.length !== 6}>{t('See my account')}</button>
        </form>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

function Paid({ practice, paid, bill, slug, onAnother }) {
  const t = useBT();
  return (
    <section className="card bp-balance bp-paid" role="status">
      <h2>{paid.processing ? t('Payment on its way') : t('Thank you — you’re paid!')}</h2>
      {paid.amount != null && <div className="bp-amount">{money(paid.amount)}</div>}
      <p>{paid.processing ? t('Bank payments take a few business days to clear. We’ll post it to your account as soon as it does.') : t('Your payment is on your account.')}</p>
      {paid.confirmation && <p className="bp-small">{t('Confirmation number {n}', { n: paid.confirmation })}</p>}
      {paid.receipt_emailed && <p className="muted bp-small">{t('A receipt is on its way to the email on file.')}</p>}
      {paid.amount_due > 0 && <p className="bp-small">{t('Still due: {amount}', { amount: money(paid.amount_due) })}</p>}
      {bill?.token && <Verify bill={bill} slug={slug} practice={practice} />}
      <button type="button" className="link" onClick={onAnother}>{t('Pay another bill')}</button>
    </section>
  );
}
