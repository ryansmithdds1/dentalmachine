import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { money } from '../../format.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import SignaturePad from '../../components/SignaturePad.jsx';
import PublicLayout from './PublicLayout.jsx';

// Patient-facing treatment plan: plain-language costs, then accept with an e-signature.
export default function CaseAcceptance() {
  const { token } = useParams();
  const [plan, setPlan] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [name, setName] = useState('');
  const [image, setImage] = useState(null);
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    api.get(`/public/tp/${token}`).then(setPlan).catch(setLoadError);
  }, [token]);
  const { submit, busy, error } = useSubmit(async () => {
    setPlan(await api.post(`/public/tp/${token}`, { signature_name: name, signature_image: image, consent }));
    window.scrollTo(0, 0);
  });
  if (loadError) return <PublicLayout title="Treatment plan"><ErrorBox error={loadError} /></PublicLayout>;
  if (!plan) return <PublicLayout title="Treatment plan"><p>Loading…</p></PublicLayout>;
  const e = plan.estimate;
  const planned = plan.procedures.filter((p) => p.status === 'planned');

  return (
    <PublicLayout title={plan.signed_at ? 'Thank you!' : `Your treatment plan, ${plan.first_name}`} practice={plan.practice}>
      {plan.signed_at && <div className="public-notice ok" style={{ marginBottom: 16 }}>You accepted this plan on {new Date(plan.signed_at.replace(' ', 'T') + 'Z').toLocaleDateString()}. We&apos;ll be in touch to schedule — or call us at {plan.practice.phone}.</div>}
      <div className="card">
        <h2>{plan.name}</h2>
        {planned.map((p, i) => (
          <div key={i} className="tp-line">
            <div><strong>{p.description}</strong>{p.tooth ? <span className="muted"> · tooth #{p.tooth}{p.surfaces ? ` (${p.surfaces})` : ''}</span> : ''}<div className="muted" style={{ fontSize: 12 }}>{p.code}</div></div>
            <div className="num">{money(e.items[i]?.patient ?? p.fee)}</div>
          </div>
        ))}
        <div className="tp-totals">
          <div><span>Office fees</span><span>{money(e.total_fee)}</span></div>
          {e.total_write_off > 0 && <div><span>In-network discount</span><span>−{money(e.total_write_off)}</span></div>}
          {e.total_insurance > 0 && <div><span>Estimated insurance{e.policy ? ` (${e.policy.carrier_name})` : ''}</span><span>−{money(e.total_insurance)}</span></div>}
          <div className="tp-you"><span>Your estimated cost</span><span>{money(e.total_patient)}</span></div>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>Insurance amounts are estimates and not a guarantee of payment. Ask us about payment plans.</p>
      </div>

      {!plan.signed_at && (
        <form className="card" onSubmit={(ev) => { ev.preventDefault(); submit(); }}>
          <h2>Accept your plan</h2>
          <label className="checkbox" style={{ color: 'var(--text)', fontSize: 14, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={consent} onChange={(ev) => setConsent(ev.target.checked)} style={{ marginTop: 3 }} />
            I have reviewed this treatment plan, my questions have been answered, and I understand the estimated costs are my responsibility if insurance pays less.
          </label>
          <label style={{ marginTop: 12 }}>Type your full name<input required value={name} onChange={(ev) => setName(ev.target.value)} autoComplete="name" /></label>
          <div style={{ marginTop: 10 }}><SignaturePad onChange={setImage} /></div>
          <ErrorBox error={error} />
          <button className="primary big" style={{ marginTop: 12 }} disabled={busy || !consent || name.trim().length < 2}>Accept & sign</button>
        </form>
      )}
    </PublicLayout>
  );
}
