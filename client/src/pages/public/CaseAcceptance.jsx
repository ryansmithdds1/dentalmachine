import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { money } from '../../format.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import SignaturePad from '../../components/SignaturePad.jsx';
import PublicLayout from './PublicLayout.jsx';
import { locale, suggestLang, useLang, useT } from './i18n.js';

// Patient-facing treatment plan: plain-language costs, then accept with an e-signature.
export default function CaseAcceptance() {
  const t = useT();
  const lang = useLang();
  const { token } = useParams();
  const [plan, setPlan] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [name, setName] = useState('');
  const [image, setImage] = useState(null);
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    api.get(`/public/tp/${token}`).then((p) => { suggestLang(p.language); setPlan(p); }).catch(setLoadError);
  }, [token]);
  const { submit, busy, error } = useSubmit(async () => {
    setPlan(await api.post(`/public/tp/${token}`, { signature_name: name, signature_image: image, consent }));
    window.scrollTo(0, 0);
  });
  if (loadError) return <PublicLayout title={t('Treatment plan')}><ErrorBox error={loadError} /></PublicLayout>;
  if (!plan) return <PublicLayout title={t('Treatment plan')}><p>{t('Loading…')}</p></PublicLayout>;
  const e = plan.estimate;
  const planned = plan.procedures.filter((p) => p.status === 'planned');

  return (
    <PublicLayout title={plan.signed_at ? t('Thank you!') : t('Your treatment plan, {name}', { name: plan.first_name })} practice={plan.practice}>
      {plan.signed_at && <div className="public-notice ok" style={{ marginBottom: 16 }}>{t('You accepted this plan on {date}. We’ll be in touch to schedule — or call us at {phone}.', { date: new Date(plan.signed_at.replace(' ', 'T') + 'Z').toLocaleDateString(locale(lang)), phone: plan.practice.phone })} <a href={`/api/public/tp/${token}/pdf`}>{t('Download a copy (PDF)')}</a></div>}
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
