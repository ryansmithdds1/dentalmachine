import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { money } from '../../format.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import SignaturePad from '../../components/SignaturePad.jsx';
import PublicLayout from './PublicLayout.jsx';
import { locale, suggestLang, useLang, useT } from './i18n.js';

// The plan link alone doesn't open the plan: the patient confirms their birth date and gets a short-lived
// pass (a portal link already carries one in its #fragment). Kept for this tab only.
const passKey = (token) => `dm_tp_pass_${token.slice(0, 12)}`;
function readPass(token) {
  const fromLink = new URLSearchParams(window.location.hash.slice(1)).get('pass');
  try {
    if (fromLink) {
      sessionStorage.setItem(passKey(token), fromLink);
      window.history.replaceState(null, '', window.location.pathname);
    }
    return sessionStorage.getItem(passKey(token)) || '';
  } catch {
    return fromLink || '';
  }
}
async function call(method, path, body, pass) {
  const res = await fetch(`/api/public${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(pass ? { 'X-Plan-Pass': pass } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, details: data.details });
  return data;
}

// Patient-facing treatment plan: plain-language costs, then accept with an e-signature.
export default function CaseAcceptance() {
  const t = useT();
  const lang = useLang();
  const { token } = useParams();
  const [plan, setPlan] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [pass, setPass] = useState(() => readPass(token));
  const [locked, setLocked] = useState(null);
  const [dob, setDob] = useState('');
  const [name, setName] = useState('');
  const [image, setImage] = useState(null);
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    call('GET', `/tp/${token}`, null, pass)
      .then((p) => { suggestLang(p.language); setLocked(null); setPlan(p); })
      .catch((err) => (err.details?.dob_required ? setLocked(err.details) : setLoadError(err)));
  }, [token, pass]);
  const verify = useSubmit(async () => {
    const { pass: fresh } = await call('POST', `/tp/${token}/verify`, { dob });
    try {
      sessionStorage.setItem(passKey(token), fresh);
    } catch {
      /* storage unavailable */
    }
    setPass(fresh);
  });
  const { submit, busy, error } = useSubmit(async () => {
    setPlan(await call('POST', `/tp/${token}`, { signature_name: name, signature_image: image, consent }, pass));
    window.scrollTo(0, 0);
  });
  if (loadError) return <PublicLayout title={t('Treatment plan')}><ErrorBox error={loadError} /></PublicLayout>;
  if (locked && !plan) {
    return (
      <PublicLayout title={t('Treatment plan')} practice={locked.practice}>
        <form className="card" onSubmit={(ev) => { ev.preventDefault(); verify.submit(); }}>
          <p>{t('To keep your information private, please confirm your date of birth.')}</p>
          <label>{t('Date of birth')}<input required type="date" value={dob} onChange={(ev) => setDob(ev.target.value)} /></label>
          <ErrorBox error={verify.error} />
          <button className="primary big" style={{ marginTop: 12 }} disabled={verify.busy || !dob}>{t('Continue')}</button>
        </form>
      </PublicLayout>
    );
  }
  if (!plan) return <PublicLayout title={t('Treatment plan')}><p>{t('Loading…')}</p></PublicLayout>;
  const e = plan.estimate;
  const planned = plan.procedures.filter((p) => p.status === 'planned');

  return (
    <PublicLayout title={plan.signed_at ? t('Thank you!') : t('Your treatment plan, {name}', { name: plan.first_name })} practice={plan.practice}>
      {plan.signed_at && <div className="public-notice ok" style={{ marginBottom: 16 }}>{t('You accepted this plan on {date}. We’ll be in touch to schedule — or call us at {phone}.', { date: new Date(plan.signed_at.replace(' ', 'T') + 'Z').toLocaleDateString(locale(lang)), phone: plan.practice.phone })} <a href={`/api/public/tp/${token}/pdf${pass ? `?pass=${encodeURIComponent(pass)}` : ''}`}>{t('Download a copy (PDF)')}</a></div>}
      <div className="card">
        <h2>{plan.name}</h2>
        {planned.map((p, i) => (
          <div key={i} className="tp-line">
            <div><strong>{p.description}</strong>{p.tooth ? <span className="muted"> · {t('tooth #{n}', { n: p.tooth })}{p.surfaces ? ` (${p.surfaces})` : ''}</span> : ''}<div className="muted" style={{ fontSize: 12 }}>{p.code}</div></div>
            <div className="num">{money(e.items[i]?.patient ?? p.fee)}</div>
          </div>
        ))}
        <div className="tp-totals">
          <div><span>{t('Office fees')}</span><span>{money(e.total_fee)}</span></div>
          {e.total_write_off > 0 && <div><span>{t('In-network discount')}</span><span>−{money(e.total_write_off)}</span></div>}
          {e.total_insurance > 0 && <div><span>{t('Estimated insurance')}{e.policy ? ` (${e.policy.carrier_name})` : ''}</span><span>−{money(e.total_insurance)}</span></div>}
          <div className="tp-you"><span>{t('Your estimated cost')}</span><span>{money(e.total_patient)}</span></div>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>{t('Insurance amounts are estimates and not a guarantee of payment. Ask us about payment plans.')}</p>
      </div>

      {plan.financing && !plan.signed_at && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('Ways to pay your {amount}', { amount: money(plan.financing.amount) })}</h3>
          {plan.financing.in_house.length > 0 && <p>{t('Monthly with us:')} {plan.financing.in_house.map((o) => `${o.months} × ${money(o.monthly)}`).join(' · ')}{plan.financing.in_house[0]?.apr ? ` (${plan.financing.in_house[0].apr}% APR)` : ` (${t('no interest')})`}</p>}
          {plan.financing.links.length > 0 && <p>{t('Or apply for financing:')} {plan.financing.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer" style={{ marginRight: 12 }}>{l.name} ↗</a>)}</p>}
        </div>
      )}
      {!plan.signed_at && (
        <form className="card" onSubmit={(ev) => { ev.preventDefault(); submit(); }}>
          <h2>{t('Accept your plan')}</h2>
          <label className="checkbox" style={{ color: 'var(--text)', fontSize: 14, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={consent} onChange={(ev) => setConsent(ev.target.checked)} style={{ marginTop: 3 }} />
            {t('I have reviewed this treatment plan, my questions have been answered, and I understand the estimated costs are my responsibility if insurance pays less.')}
          </label>
          <label style={{ marginTop: 12 }}>{t('Type your full name')}<input required value={name} onChange={(ev) => setName(ev.target.value)} autoComplete="name" /></label>
          <div style={{ marginTop: 10 }}><SignaturePad onChange={setImage} /></div>
          <ErrorBox error={error} />
          <button className="primary big" style={{ marginTop: 12 }} disabled={busy || !consent || name.trim().length < 2}>{t('Accept & sign')}</button>
        </form>
      )}
    </PublicLayout>
  );
}
