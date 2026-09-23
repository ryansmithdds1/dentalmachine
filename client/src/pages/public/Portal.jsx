import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { money } from '../../format.js';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import { fmtDateL, fmtTimeL, suggestLang, useLang, useT } from './i18n.js';

// Patient portal: sign in with a one-time code, then see visits, balance, forms and plans for the household.
const storeKey = (key) => `dm_portal_${key}`;
const readToken = (key) => {
  try {
    return sessionStorage.getItem(storeKey(key));
  } catch {
    return null;
  }
};
const saveToken = (key, token) => {
  try {
    if (token) sessionStorage.setItem(storeKey(key), token);
    else sessionStorage.removeItem(storeKey(key));
  } catch {
    /* private mode: stays signed in for this page only */
  }
};

async function call(method, path, body, token) {
  const res = await fetch(`/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

const when = (lang, s) => `${fmtDateL(lang, s, { weekday: 'short', month: 'short', day: 'numeric' })}, ${fmtTimeL(lang, s)}`;
const shortDate = (lang, s) => fmtDateL(lang, s, { month: 'short', day: 'numeric', year: 'numeric' });

export default function Portal() {
  const t = useT();
  const { key } = useParams();
  const [token, setToken] = useState(() => readToken(key));
  const [practice, setPractice] = useState(null);
  const [notFound, setNotFound] = useState(false);
  useEffect(() => {
    call('GET', `/public/portal/${key}`).then((p) => { suggestLang(p.language); setPractice(p); }).catch(() => setNotFound(true));
  }, [key]);
  const signOut = () => {
    saveToken(key, null);
    setToken(null);
  };
  if (notFound) return <PublicLayout title={t('Patient portal')}><div className="public-notice">{t('This patient portal link isn’t valid. Please check with your dental office.')}</div></PublicLayout>;
  if (!token) return <SignIn portalKey={key} practice={practice} onSignedIn={(tok) => { saveToken(key, tok); setToken(tok); }} />;
  return <Dashboard token={token} onSignOut={signOut} />;
}

function SignIn({ portalKey, practice, onSignedIn }) {
  const t = useT();
  const [step, setStep] = useState('who');
  const [contact, setContact] = useState('');
  const [dob, setDob] = useState('');
  const [code, setCode] = useState('');
  const [channel, setChannel] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PublicLayout title={t('Patient portal')} practice={practice}>
      <div className="card portal-signin">
        {step === 'who' ? (
          <form onSubmit={(e) => { e.preventDefault(); run(async () => { setChannel((await call('POST', `/public/portal/${portalKey}/code`, { contact, dob })).channel); setStep('code'); }); }}>
            <h2>{t('Sign in')}</h2>
            <p className="muted">{t('See your upcoming visits, pay your balance and complete forms. We’ll send a one-time code to the email or mobile number we have on file.')}</p>
            <label>{t('Email or mobile number')}<input required autoComplete="username" value={contact} onChange={(e) => setContact(e.target.value)} placeholder={t('you@example.com or (512) 555-0100')} /></label>
            <label>{t('Date of birth')}<input required type="date" value={dob} onChange={(e) => setDob(e.target.value)} /></label>
            <ErrorBox error={error} />
            <button className="primary big" disabled={busy}>{t('Send my code')}</button>
          </form>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); run(async () => onSignedIn((await call('POST', `/public/portal/${portalKey}/verify`, { contact, code })).token)); }}>
            <h2>{t('Enter your code')}</h2>
            <p className="muted">{t(channel === 'email' ? 'If we found your record, a 6-digit code is on its way by email. It expires in 10 minutes.' : 'If we found your record, a 6-digit code is on its way by text message. It expires in 10 minutes.')}</p>
            <input className="code-input" autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="••••••" />
            <ErrorBox error={error} />
            <button className="primary big" disabled={busy || code.length !== 6}>{t('Sign in')}</button>
            <button type="button" className="link" style={{ marginTop: 10 }} onClick={() => { setStep('who'); setCode(''); setError(null); }}>{t('Use a different email or number')}</button>
          </form>
        )}
        {practice?.phone && <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>{t('Trouble signing in? Call {practice} at {phone}.', { practice: practice.name, phone: practice.phone })}</p>}
      </div>
    </PublicLayout>
  );
}

function Dashboard({ token, onSignOut }) {
  const t = useT();
  const lang = useLang();
  const [params, setParams] = useSearchParams();
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(params.get('paid') ? 'Thank you — your payment was received and will show on your account shortly.' : null);
  const load = useCallback(async () => {
    try {
      const data = await call('GET', '/portal/me', null, token);
      suggestLang(data.language ?? data.patient?.language);
      setMe(data);
    } catch (e) {
      if (e.status === 401) onSignOut();
      else setError(e);
    }
  }, [token, onSignOut]);
  useEffect(() => {
    load();
    if (params.get('paid')) setParams({}, { replace: true });
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn, msg) => {
    setError(null);
    try {
      await fn();
      if (msg) setNotice(msg);
      await load();
    } catch (e) {
      if (e.status === 401) onSignOut();
      else setError(e);
    }
  };
  const open = (path) => act(async () => {
    window.location.href = (await call('POST', path, {}, token)).url;
  });
  if (!me) return <PublicLayout title={t('Patient portal')}><p>{error ? error.message : t('Loading…')}</p></PublicLayout>;
  const p = me.patient;
  const todo = me.forms.length + me.treatment_plans.length;
  return (
    <PublicLayout title={t('Hi, {name}', { name: p.preferred_name || p.first_name })} practice={me.practice}>
      <div className="portal-top"><span className="muted">{me.household.length > 1 ? t('You’re signed in for your household ({n} people).', { n: me.household.length }) : ''}</span><button className="link" onClick={onSignOut}>{t('Sign out')}</button></div>
      {notice && <div className="public-notice ok" style={{ marginBottom: 12 }}>{t(notice)}</div>}
      <ErrorBox error={error} />

      <div className="portal-grid">
        <section className="card">
          <h2>{t('Balance')}</h2>
          <div className="portal-balance">{money(Math.max(0, me.amount_due))}</div>
          <div className="muted" style={{ fontSize: 13 }}>
            {me.pending_insurance > 0 ? t('Account balance {balance}, including {insurance} we expect from insurance.', { balance: money(me.balance), insurance: money(me.pending_insurance) }) : me.balance < 0 ? t('You have a {amount} credit.', { amount: money(-me.balance) }) : t('Amount due now.')}
          </div>
          {me.payments_enabled && me.amount_due > 0 && <PayForm token={token} due={me.amount_due} onPaid={(url) => (url ? (window.location.href = url) : act(async () => {}, 'Thank you — your payment was received.'))} />}
          {me.payment_plans.map((pp) => (
            <div key={pp.id} className="portal-plan">
              <strong>{t('Payment plan')}</strong> · {t('{paid} paid, {left} left', { paid: money(pp.paid), left: money(pp.remaining) })}
              {pp.next_due_date && <div className="muted">{t('Next {amount} due {date}', { amount: money(pp.next_due_amount), date: shortDate(lang, pp.next_due_date) })}{pp.autopay ? ` — ${t('paid automatically')}` : ''}</div>}
            </div>
          ))}
        </section>

        <section className="card">
          <h2>{t('Upcoming visits')}</h2>
          {me.appointments.length === 0 && <p className="muted">{t('No visits scheduled.')}</p>}
          {me.appointments.map((a) => (
            <div key={a.id} className="portal-appt">
              <div>
                <strong>{when(lang, a.start_time)}</strong>
                <div className="muted">{me.household.length > 1 ? `${a.patient_name} · ` : ''}{t('{reason} with {provider}', { reason: a.reason ? t(a.reason) : t('Visit'), provider: a.provider_name })}</div>
              </div>
              <div className="portal-actions">
                {a.status === 'confirmed' ? <span className="badge ok nocap">{t('Confirmed')}</span> : a.status === 'scheduled' && <button className="small primary" onClick={() => act(() => call('POST', `/portal/appointments/${a.id}/confirm`, {}, token), 'Thanks — your visit is confirmed.')}>{t('Confirm')}</button>}
                {a.can_cancel && <button className="small" onClick={() => confirm(t('Cancel the {when} visit?', { when: when(lang, a.start_time) })) && act(() => call('POST', `/portal/appointments/${a.id}/cancel`, {}, token), "Cancelled. We'll reach out to find a new time.")}>{t('Cancel')}</button>}
              </div>
            </div>
          ))}
          <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            {me.practice.booking_url ? <><a href={me.practice.booking_url}>{t('Book a visit online')}</a> {t('or call {phone}.', { phone: me.practice.phone })}</> : <>{t('To book or reschedule, call {phone}.', { phone: me.practice.phone })}</>}
            {' '}{t('Visits within 24 hours can only be changed by phone.')}
          </div>
        </section>

        {todo > 0 && (
          <section className="card">
            <h2>{t('To do')}</h2>
            {me.forms.map((f) => (
              <div key={f.id} className="portal-appt">
                <div><strong>{t('Health history form')}</strong>{me.household.length > 1 && <div className="muted">{t('for {name}', { name: f.patient_name })}</div>}</div>
                <button className="small primary" onClick={() => open(`/portal/forms/${f.id}/open`)}>{t('Fill it out')}</button>
              </div>
            ))}
            {me.treatment_plans.map((tp) => (
              <div key={tp.id} className="portal-appt">
                <div><strong>{t('Treatment plan: {name}', { name: tp.name })}</strong><div className="muted">{me.household.length > 1 ? `${tp.patient_name} · ` : ''}{tp.procedures === 1 ? t('1 procedure') : t('{n} procedures', { n: tp.procedures })} · {t('your estimate {amount}', { amount: money(tp.your_estimate) })}</div></div>
                <button className="small primary" onClick={() => open(`/portal/treatment-plans/${tp.id}/open`)}>{t('Review & sign')}</button>
              </div>
            ))}
          </section>
        )}

        <section className="card">
          <h2>{t('Your details')}</h2>
          <ContactForm token={token} patient={p} onSaved={() => act(async () => {}, 'Your details were updated.')} />
          {me.household.length > 1 && <p className="muted" style={{ fontSize: 13 }}>{t('Household: {names}', { names: me.household.map((h) => h.first_name).join(', ') })}</p>}
          {me.cards.length > 0 && <p className="muted" style={{ fontSize: 13 }}>{t('Card on file: {cards}', { cards: me.cards.map((c) => `${c.brand ? c.brand[0].toUpperCase() + c.brand.slice(1) : t('Card')} •••• ${c.last4}`).join(', ') })}</p>}
        </section>

        <section className="card portal-wide">
          <h2>{t('Recent account activity')}</h2>
          {me.activity.map((e, i) => (
            <div key={i} className="portal-activity">
              <div>
                <div>{e.description || e.type}</div>
                <div className="muted" style={{ fontSize: 12 }}>{shortDate(lang, e.entry_date)}{me.household.length > 1 ? ` · ${e.patient_name}` : ''}</div>
              </div>
              <div className={`num${e.amount < 0 ? ' paid' : ''}`}>{e.amount < 0 ? `−${money(-e.amount)}` : money(e.amount)}</div>
            </div>
          ))}
          {me.activity.length === 0 && <p className="muted">{t('No activity yet.')}</p>}
        </section>
      </div>
    </PublicLayout>
  );
}

function PayForm({ token, due, onPaid }) {
  const t = useT();
  const [amount, setAmount] = useState((due / 100).toFixed(2));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="portal-pay" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const r = await call('POST', '/portal/pay', { amount: Math.round(Number(amount) * 100) }, token);
        onPaid(r.url || null);
      } catch (err) {
        setError(err);
      } finally {
        setBusy(false);
      }
    }}>
      <label>{t('Amount ($)')}<input type="number" min="0.5" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <button className="primary" disabled={busy}>{t('Pay now')}</button>
      <ErrorBox error={error} />
    </form>
  );
}

function ContactForm({ token, patient, onSaved }) {
  const t = useT();
  const [form, setForm] = useState({ email: patient.email || '', phone: patient.phone || '', address: patient.address || '', city: patient.city || '', state: patient.state || '', zip: patient.zip || '', sms_opt_in: !!patient.sms_opt_in, email_opt_in: !!patient.email_opt_in });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <form className="form-grid" onSubmit={async (e) => {
      e.preventDefault();
      setError(null);
      try {
        await call('PUT', '/portal/contact', form, token);
        onSaved();
      } catch (err) {
        setError(err);
      }
    }}>
      <label>{t('Email')}<input type="email" value={form.email} onChange={set('email')} /></label>
      <label>{t('Mobile')}<input value={form.phone} onChange={set('phone')} /></label>
      <label className="full">{t('Address')}<input value={form.address} onChange={set('address')} /></label>
      <label>{t('City')}<input value={form.city} onChange={set('city')} /></label>
      <label>{t('State')}<input value={form.state} onChange={set('state')} maxLength={2} /></label>
      <label>{t('ZIP')}<input value={form.zip} onChange={set('zip')} /></label>
      <label className="checkbox full"><input type="checkbox" checked={form.sms_opt_in} onChange={set('sms_opt_in')} /> {t('Text me reminders')}</label>
      <label className="checkbox full"><input type="checkbox" checked={form.email_opt_in} onChange={set('email_opt_in')} /> {t('Email me reminders and statements')}</label>
      <ErrorBox error={error} />
      <div className="form-actions full"><button className="primary">{t('Save')}</button></div>
    </form>
  );
}
