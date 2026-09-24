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

// PDFs need the portal session, so they're fetched and saved rather than linked.
async function download(path, token, name) {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw Object.assign(new Error((await res.json().catch(() => ({}))).error || res.statusText), { status: res.status });
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    call('POST', '/portal/logout', null, token).catch(() => { /* the session is forgotten here either way */ });
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
  const [moving, setMoving] = useState(null);
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
                {a.can_cancel && <button className="small" onClick={() => setMoving(moving?.id === a.id ? null : a)}>{t('Move')}</button>}
                {a.can_cancel && <button className="small" onClick={() => confirm(t('Cancel the {when} visit?', { when: when(lang, a.start_time) })) && act(() => call('POST', `/portal/appointments/${a.id}/cancel`, {}, token), "Cancelled. We'll reach out to find a new time.")}>{t('Cancel')}</button>}
              </div>
              {moving?.id === a.id && <Reschedule token={token} appt={a} onDone={() => { setMoving(null); act(async () => {}, 'Your visit was moved. We’ll send a new reminder.'); }} />}
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

        <Messages token={token} onError={setError} />

        <section className="card">
          <h2>{t('Statements & receipts')}</h2>
          <button className="small" onClick={() => act(() => download('/portal/statement.pdf', token, 'statement.pdf'))}>{t('Download statement (PDF)')}</button>{' '}
          <button className="small" onClick={() => act(() => download('/portal/record-export', token, 'health-record.zip'))} title={t('Your records: a summary, your chart details, and your x-rays and documents')}>{t('Download my health record')}</button>
          <Receipts token={token} onError={setError} />
        </section>

        <Memberships token={token} household={me.household} onDone={(msg) => act(async () => {}, msg)} onError={setError} />

        <InsuranceSection token={token} onDone={(msg) => act(async () => {}, msg)} />

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

function Reschedule({ token, appt, onDone }) {
  const t = useT();
  const lang = useLang();
  const [date, setDate] = useState(appt.start_time.slice(0, 10));
  const [slots, setSlots] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setSlots(null);
    call('GET', `/portal/appointments/${appt.id}/slots?date=${date}`, null, token).then((r) => setSlots(r.slots)).catch(setError);
  }, [appt.id, date, token]);
  const pick = async (start) => {
    setError(null);
    try { await call('POST', `/portal/appointments/${appt.id}/reschedule`, { start }, token); onDone(); } catch (e) { setError(e); }
  };
  return (
    <div className="portal-move">
      <ErrorBox error={error} />
      <label>{t('New day')} <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
      {slots === null ? <p className="muted">{t('Checking availability…')}</p> : slots.length === 0 ? <p className="muted">{t('No openings that day — try another.')}</p> : (
        <div className="slot-grid">{slots.map((s) => <button key={s} className="small" onClick={() => pick(s)}>{fmtTimeL(lang, s)}</button>)}</div>
      )}
    </div>
  );
}

function Messages({ token, onError }) {
  const t = useT();
  const lang = useLang();
  const [list, setList] = useState(null);
  const [body, setBody] = useState('');
  const load = useCallback(() => call('GET', '/portal/messages', null, token).then(setList).catch(onError), [token, onError]);
  useEffect(() => { load(); }, [load]);
  const send = async () => {
    try { await call('POST', '/portal/messages', { body }, token); setBody(''); load(); } catch (e) { onError(e); }
  };
  return (
    <section className="card">
      <h2>{t('Messages')}</h2>
      <div className="portal-thread">
        {list?.map((m) => (
          <div key={m.id} className={`bubble ${m.direction === 'inbound' ? 'mine' : 'theirs'}`}>
            <div>{m.body}</div>
            <div className="muted" style={{ fontSize: 11 }}>{m.direction === 'inbound' ? t('You') : t('The office')} · {fmtDateL(lang, m.created_at, { month: 'short', day: 'numeric' })}</div>
          </div>
        ))}
        {list?.length === 0 && <p className="muted">{t('Questions about a visit, a bill or your care? Send the office a secure message.')}</p>}
      </div>
      <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('Write a message…')} maxLength={2000} />
      <button className="small primary" disabled={!body.trim()} onClick={send} style={{ marginTop: 6 }}>{t('Send')}</button>
    </section>
  );
}

function Receipts({ token, onError }) {
  const t = useT();
  const lang = useLang();
  const [list, setList] = useState(null);
  useEffect(() => { call('GET', '/portal/payments', null, token).then(setList).catch(onError); }, [token, onError]);
  if (!list?.length) return null;
  return (
    <div style={{ marginTop: 10 }}>
      {list.slice(0, 10).map((p) => (
        <div key={p.id} className="portal-activity">
          <div>{shortDate(lang, p.entry_date)}<span className="muted"> · {money(-p.amount)}</span></div>
          <button className="link" onClick={() => download(`/portal/receipts/${p.id}.pdf`, token, `receipt-${p.id}.pdf`).catch(onError)}>{t('Receipt')}</button>
        </div>
      ))}
    </div>
  );
}

function Memberships({ token, household, onDone, onError }) {
  const t = useT();
  const [data, setData] = useState(null);
  const [who, setWho] = useState(household[0]?.id);
  const load = useCallback(() => call('GET', '/portal/membership-plans', null, token).then(setData).catch(onError), [token, onError]);
  useEffect(() => { load(); }, [load]);
  if (!data?.plans.length) return null;
  const join = async (plan) => {
    const name = household.find((h) => h.id === Number(who))?.first_name;
    if (!confirm(t('Join {plan} for {name} at {price}?', { plan: plan.name, name, price: `${money(plan.price)}/${plan.interval === 'year' ? t('year') : t('month')}` }))) return;
    try {
      const r = await call('POST', '/portal/memberships', { plan_id: plan.id, patient_id: Number(who) }, token);
      onDone(r.requested ? 'Thanks — the office will call to set up your card and finish joining.' : 'Welcome to the plan! Your first payment was charged to your card on file.');
      load();
    } catch (e) { onError(e); }
  };
  return (
    <section className="card">
      <h2>{t('Membership plans')}</h2>
      {data.members.map((m) => <div key={m.patient_id} className="muted" style={{ fontSize: 13 }}>{t('{name} is a member: {plan}', { name: household.find((h) => h.id === m.patient_id)?.first_name, plan: m.name })}</div>)}
      {household.length > 1 && <label style={{ fontSize: 13 }}>{t('For')} <select value={who} onChange={(e) => setWho(e.target.value)}>{household.map((h) => <option key={h.id} value={h.id}>{h.first_name}</option>)}</select></label>}
      {data.plans.map((pl) => (
        <div key={pl.id} className="portal-appt">
          <div><strong>{pl.name}</strong> · {money(pl.price)}/{pl.interval === 'year' ? t('year') : t('month')}<div className="muted" style={{ fontSize: 12 }}>{pl.description || (pl.discount_pct ? t('{pct}% off other care', { pct: pl.discount_pct }) : '')}</div></div>
          <button className="small primary" onClick={() => join(pl)}>{t('Join')}</button>
        </div>
      ))}
    </section>
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

// Coverage on file for each family member, and sending in new insurance with photos of the card.
function InsuranceSection({ token, onDone }) {
  const t = useT();
  const [members, setMembers] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => call('GET', '/portal/insurance', null, token).then(setMembers).catch(setError), [token]);
  useEffect(() => { load(); }, [load]);
  if (!members) return null;
  const upload = async (side, file) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/portal/insurance/cards?patient_id=${form.patient_id}&side=${side}&filename=${encodeURIComponent(file.name || 'card.jpg')}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      setForm((f) => ({ ...f, [side]: { id: data.id, preview: URL.createObjectURL(file) } }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await call('POST', '/portal/insurance/update', { ...form, document_ids: [form.front?.id, form.back?.id].filter(Boolean) }, token);
      setForm(null);
      await load();
      onDone(t('Thanks — the office will update your insurance before your next visit.'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <section className="card">
      <h2>{t('Insurance')}</h2>
      {members.map((m) => (
        <div key={m.id} style={{ marginBottom: 10 }}>
          {members.length > 1 && <strong>{m.first_name}</strong>}
          {m.policies.length ? m.policies.map((p, i) => (
            <div key={i} style={{ fontSize: 14 }}>{p.carrier_name} · {t('Member ID')} {p.subscriber_id}{p.group_number ? ` · ${t('Group')} ${p.group_number}` : ''} <span className="muted">({p.priority === 'primary' ? t('primary') : t('secondary')})</span></div>
          )) : <div className="muted" style={{ fontSize: 14 }}>{t('No insurance on file.')}</div>}
          {m.pending.length > 0 && <div className="muted" style={{ fontSize: 13 }}>{t('New insurance sent — the office is updating it.')}</div>}
          {!form && <button className="small" style={{ marginTop: 4 }} onClick={() => setForm({ patient_id: m.id, carrier_name: '', member_id: '', group_number: '', subscriber_name: '', subscriber_dob: '', relationship: 'self', note: '' })}>{t('Update insurance')}</button>}
        </div>
      ))}
      {form && (
        <form className="form-grid" onSubmit={submit}>
          <div className="full portal-cards">
            {['front', 'back'].map((side) => (
              <label key={side} className="card-photo">
                {form[side] ? <img src={form[side].preview} alt={side === 'front' ? t('Front of card') : t('Back of card')} /> : <span>📷 {side === 'front' ? t('Photo of the front of the card') : t('Photo of the back')}</span>}
                <input type="file" accept="image/*,application/pdf" capture="environment" disabled={busy} onChange={(e) => upload(side, e.target.files[0])} />
              </label>
            ))}
          </div>
          <label>{t('Insurance company')}<input value={form.carrier_name} onChange={set('carrier_name')} /></label>
          <label>{t('Member ID')}<input value={form.member_id} onChange={set('member_id')} /></label>
          <label>{t('Group number')}<input value={form.group_number} onChange={set('group_number')} /></label>
          <label>
            {t('Who is the policyholder?')}
            <select value={form.relationship} onChange={set('relationship')}>
              <option value="self">{t('The patient')}</option><option value="spouse">{t('Spouse')}</option><option value="child">{t('Parent (patient is their child)')}</option><option value="other">{t('Someone else')}</option>
            </select>
          </label>
          {form.relationship !== 'self' && (
            <>
              <label>{t('Policyholder name')}<input value={form.subscriber_name} onChange={set('subscriber_name')} /></label>
              <label>{t('Policyholder date of birth')}<input type="date" value={form.subscriber_dob} onChange={set('subscriber_dob')} /></label>
            </>
          )}
          <label className="full">{t('Anything else we should know?')}<textarea rows={2} value={form.note} onChange={set('note')} /></label>
          <ErrorBox error={error} />
          <div className="form-actions full"><button type="button" onClick={() => setForm(null)}>{t('Cancel')}</button><button className="primary" disabled={busy}>{t('Send to the office')}</button></div>
        </form>
      )}
      {!form && <ErrorBox error={error} />}
    </section>
  );
}
