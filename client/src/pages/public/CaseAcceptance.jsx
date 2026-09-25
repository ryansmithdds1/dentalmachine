import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CalendarDays, ShieldCheck, Smile, ExternalLink, Maximize } from 'lucide-react';
import { money } from '../../format.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import SignaturePad from '../../components/SignaturePad.jsx';
import ToothMap from '../../components/patient/ToothMap.jsx';
import FinOptionCards, { LENDER_NAMES } from '../../components/patient/FinOptionCards.jsx';
import CompareBoard from '../../components/patient/CompareBoard.jsx';
import PublicLayout, { PublicError } from './PublicLayout.jsx';
import { locale, suggestLang, useLang, useT } from './i18n.js';
import { DobGate, publicCall, readPass, savePass } from './LinkPass.jsx';
import { BackToOffice, useHandoff } from './HandOff.jsx';
import './handoff.css';
import '../../components/xray/xray.css';

const call = (method, path, body, pass) => publicCall(method, path, body, 'X-Plan-Pass', pass);

// The patient's treatment plan (F2): the teeth involved, each phase as a card in plain words, other options side
// by side, and ways to pay (F3) — then choose and sign (F4). Details only on tap. Choosing how to pay is
// optional: signing the plan alone still works (workflow 22).
export default function CaseAcceptance() {
  const t = useT();
  const lang = useLang();
  const { token } = useParams();
  const [plan, setPlan] = useState(null);
  const [quote, setQuote] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [pass, setPass] = useState(() => readPass('tp', token));
  // Opened on the office device by staff: no birth-date step.
  const hand = useHandoff('tp', token);
  const usePass = hand.pass || pass;
  const [locked, setLocked] = useState(null);
  const [name, setName] = useState('');
  const [image, setImage] = useState(null);
  const [consent, setConsent] = useState(false);
  const [option, setOption] = useState(null);
  const [phases, setPhases] = useState(null);
  const [alt, setAlt] = useState(null);
  const [open, setOpen] = useState({});
  const [changed, setChanged] = useState(false);
  // Comparing options (F6). ?compare=<plan id>: this is the patient's window on the second screen, opened and
  // pointed at by the staff screen on the same computer (BroadcastChannel keeps the two in step).
  const [compare, setCompare] = useState(null);
  const [pointed, setPointed] = useState(null);
  const [picked, setPicked] = useState(null);
  // Read once: the hand-off step clears the address bar right after.
  const [screenFor] = useState(() => new URLSearchParams(window.location.search).get('compare'));
  const channel = useRef(null);
  useEffect(() => {
    if (!screenFor || typeof BroadcastChannel === 'undefined') return undefined;
    const ch = new BroadcastChannel(`dm-compare-${screenFor}`);
    channel.current = ch;
    ch.onmessage = (ev) => {
      if (ev.data?.type === 'highlight') setPointed(ev.data.plan_id);
      if (ev.data?.type === 'reload') window.location.reload();
    };
    ch.postMessage({ type: 'opened' });
    return () => ch.close();
  }, [screenFor]);
  const tell = (msg) => channel.current?.postMessage(msg);
  useEffect(() => {
    if (hand.checking) return;
    call('GET', `/tp/${token}`, null, usePass)
      .then((p) => {
        suggestLang(p.language); setLocked(null); setPlan(p); setQuote(p.quote);
        if (!p.signed_at && p.alternatives?.length > 1) call('GET', `/tp/${token}/compare`, null, usePass).then(setCompare).catch(() => setCompare(null));
      })
      .catch((err) => (err.details?.dob_required ? setLocked(err.details) : setLoadError(err)));
  }, [token, usePass, hand.checking]);
  // Another option or other phases: the numbers come again from the office's server.
  const requote = async (nextPhases, nextAlt) => {
    const qs = new URLSearchParams();
    if (nextPhases) qs.set('phases', nextPhases.join(','));
    if (nextAlt) qs.set('plan', nextAlt);
    const q = await call('GET', `/tp/${token}/quote?${qs}`, null, usePass);
    setQuote(q);
    if (option && !q.options.some((o) => o.key === option)) setOption(null);
  };
  // Handed the office tablet: the cursor waits in the name box (without scrolling past the plan).
  const nameBox = useRef(null);
  const ready = !!plan && !plan.signed_at;
  useEffect(() => { if (ready && hand.back) nameBox.current?.focus({ preventScroll: true }); }, [ready, hand.back]);
  // Handed over in the office: their name is already on the signing line (they can change it); they tick and sign.
  useEffect(() => { if (hand.signerName) setName((n) => n || hand.signerName); }, [hand.signerName]);
  const { submit, busy, error } = useSubmit(async () => {
    try {
      const choice = option ? { option_key: option, quote_hash: quote.quote_hash, phases: phases || undefined, plan_id: alt || undefined } : null;
      const out = await call('POST', `/tp/${token}`, { signature_name: name, signature_image: image, consent, choice, plan_id: alt || undefined }, usePass);
      if (out.pass) { savePass('tp', token, out.pass); setPass(out.pass); }
      setPlan(out);
      tell({ type: 'signed', plan_id: out.agreement ? undefined : null });
      window.scrollTo(0, 0);
    } catch (err) {
      // The numbers moved (the office changed something): show the new ones and let them choose again.
      if (err.details?.changed) { setChanged(true); setOption(null); await requote(phases, alt); return; }
      throw err;
    }
  });
  if (loadError) return <PublicLayout title={t('Treatment plan')}><PublicError error={loadError} /><BackToOffice back={hand.back} /></PublicLayout>;
  if (locked && !plan) {
    return (
      <DobGate title={t('Treatment plan')} practice={locked.practice} onPass={(p) => { savePass('tp', token, p); setPass(p); }}
        verify={async (dob) => (await call('POST', `/tp/${token}/verify`, { dob })).pass} />
    );
  }
  if (!plan) return <PublicLayout title={t('Treatment plan')}><p>{t('Loading…')}</p></PublicLayout>;
  const pdf = `/api/public/tp/${token}/pdf${usePass ? `?pass=${encodeURIComponent(usePass)}` : ''}`;

  if (plan.signed_at) {
    const a = plan.agreement;
    return (
      <PublicLayout title={t('Thank you!')} practice={plan.practice}>
        <div className="public-notice ok" style={{ marginBottom: 16 }}>{t('You accepted this plan on {date}. We’ll be in touch to schedule — or call us at {phone}.', { date: new Date(plan.signed_at.replace(' ', 'T') + 'Z').toLocaleDateString(locale(lang)), phone: plan.practice.phone })} <a href={pdf}>{t('Download a copy (PDF)')}</a></div>
        {a && (
          <div className="card cp-done">
            <div className="muted">{t('How you’ll pay')}</div>
            <strong>{a.kind === 'lender' ? `${LENDER_NAMES[a.lender] || ''} — ` : ''}{t(a.title)}</strong>
            <span className="fin-big">{a.monthly ? <>{money(a.monthly)}<small>/{t('mo')}</small></> : money(a.total)}</span>
            <span className="muted">{t('Total')} {money(a.total)} · {t('Due today')} {money(a.due_today)}</span>
            {a.kind === 'full' && a.discount > 0 && <span className="cp-save">{t('Your prepay discount: {amount}', { amount: money(a.discount) })}</span>}
            {a.apply_url && <a className="button primary" href={a.apply_url} target="_blank" rel="noreferrer">{t('Apply for financing')} <ExternalLink size={14} aria-hidden="true" /></a>}
          </div>
        )}
        {hand.back && <div className="public-notice" style={{ marginTop: 8 }}>{t('Please hand the device back to the office.')}</div>}
        <BackToOffice back={hand.back} />
      </PublicLayout>
    );
  }

  const q = quote;
  const e = plan.estimate;
  const planned = plan.procedures.filter((p) => p.status === 'planned');
  const chosen = new Set(q?.chosen || []);
  const togglePhase = async (n) => {
    const next = chosen.has(n) ? [...chosen].filter((x) => x !== n) : [...chosen, n].sort();
    if (!next.length) return;
    setPhases(next);
    await requote(next, alt);
  };
  const pickAlt = async (id, explicit = false) => {
    const current = plan.alternatives.find((x) => x.current)?.id;
    const next = id === current ? null : (explicit || id !== alt ? id : null);
    setAlt(next);
    setPhases(null);
    setOption(null);
    await requote(null, next);
  };
  const visits = q ? q.phases.filter((p) => chosen.has(p.phase)).reduce((n, p) => n + p.visits, 0) : 0;
  const imgSrc = (n) => `/api/public/tp/${token}/phase-image/${n}?${new URLSearchParams({ ...(usePass ? { pass: usePass } : {}), ...(alt ? { plan: alt } : {}) })}`;

  return (
    <PublicLayout title={t('Your treatment plan, {name}', { name: plan.first_name })} practice={plan.practice}>
      {screenFor && <CompareScreen t={t} />}
      {changed && <div className="public-notice" style={{ marginBottom: 12 }}>{t('The office just updated your plan — here are the new numbers. Please choose again.')}</div>}
      {q ? (
        <div className="card">
          <div className="cp-hero">
            <div>
              <h2 style={{ marginBottom: 6 }}>{(alt && plan.alternatives.find((a) => a.id === alt)?.name) || plan.name}</h2>
              <ToothMap teeth={q.teeth} />
              <div className="cp-meta">
                <span><Smile size={15} aria-hidden="true" /> {t('{n} treatments', { n: q.phases.filter((p) => chosen.has(p.phase)).reduce((n, p) => n + p.count, 0) })}</span>
                <span><CalendarDays size={15} aria-hidden="true" /> {visits === 1 ? t('about 1 visit') : t('about {n} visits', { n: visits })}</span>
                {q.policy && <span><ShieldCheck size={15} aria-hidden="true" /> {q.policy.carrier_name}</span>}
              </div>
            </div>
            <div className="cp-cost">
              <div className="muted">{t('Your estimated cost')}</div>
              <div className="fin-big">{money(q.amount)}</div>
              {q.totals.insurance > 0 && <div className="muted">{t('after {amount} from insurance', { amount: money(q.totals.insurance) })}</div>}
              {q.ppo_savings > 0 && <div className="cp-save">{t('Your in-network savings: {amount}', { amount: money(q.ppo_savings) })}</div>}
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <h2>{plan.name}</h2>
          {planned.map((p, i) => (
            <div key={i} className="tp-line">
              <div><strong>{p.description}</strong>{p.tooth ? <span className="muted"> · {t('tooth #{n}', { n: p.tooth })}</span> : ''}</div>
              <div className="num">{money(e.items[i]?.patient ?? p.fee)}</div>
            </div>
          ))}
        </div>
      )}

      {/* XR3: what the x-rays showed on the plan's teeth — only what the dentist confirmed. */}
      {plan.xray_findings?.length > 0 && (
        <div className="card xr-plan">
          <h3 style={{ marginTop: 0 }}>{t('What your x-rays showed')}</h3>
          <div className="muted" style={{ fontSize: 13 }}>{t('Your dentist reviewed your x-rays and confirmed:')}</div>
          <ul>
            {plan.xray_findings.map((f, i) => <li key={i}><strong>{t(f.label)}</strong>{f.where ? <span className="muted"> · {f.where}</span> : null}</li>)}
          </ul>
        </div>
      )}

      {compare?.options?.length > 1 ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('Your options')}</h3>
          <CompareBoard options={compare.options} t={t} highlight={pointed} chosen={picked}
            onChoose={async (id) => { setPicked(id); tell({ type: 'picked', plan_id: id }); await pickAlt(id, true); document.querySelector('.cp-accept')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); nameBox.current?.focus({ preventScroll: true }); }} />
        </div>
      ) : plan.alternatives?.length > 1 ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('Your options')}</h3>
          <div className="cp-alts">
            {plan.alternatives.map((a) => {
              const on = alt ? a.id === alt : a.current;
              return (
                <button key={a.id} type="button" className={`cp-alt${on ? ' on' : ''}`} aria-pressed={on} onClick={() => pickAlt(a.id)}>
                  <span className="cp-alt-label">{a.label}</span>
                  <span className="cp-alt-what">{[...new Set(a.procedures.map((p) => t(p.plain)))].join(' + ')}</span>
                  <span className="fin-big">{money(a.you_pay)}</span>
                  <span className="muted" style={{ fontSize: 12.5 }}>{a.visits === 1 ? t('about 1 visit') : t('about {n} visits', { n: a.visits })}{a.from_monthly ? ` · ${t('from {amount}/mo', { amount: money(a.from_monthly) })}` : ''}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {q && (
        <div className="cp-phases" style={{ marginBottom: 16 }}>
          {q.phases.map((p, i) => {
            const on = chosen.has(p.phase);
            return (
              <div key={p.phase} className={`cp-phase${on ? '' : ' off'}`}>
                <div className="cp-step">{i + 1}</div>
                <div>
                  <h3>{t(p.name)}</h3>
                  {p.why && <div className="cp-why">{t(p.why)}</div>}
                  <div className="cp-what">
                    {[...new Set(p.lines.map((l) => `${t(l.plain)}${l.tooth ? ` #${l.tooth}` : ''}`))].join(' · ')} · {p.visits === 1 ? t('1 visit') : t('{n} visits', { n: p.visits })}
                    <button type="button" className="cp-linkbtn" aria-expanded={!!open[p.phase]} onClick={() => setOpen({ ...open, [p.phase]: !open[p.phase] })}>{open[p.phase] ? t('Hide details') : t('Details')}</button>
                  </div>
                  {p.has_image && <img src={imgSrc(p.phase)} alt={t('X-ray or photo for {name}', { name: t(p.name) })} loading="lazy" />}
                  {open[p.phase] && (
                    <div className="cp-detail">
                      {p.lines.map((l, k) => (
                        <div key={k}><span>{l.description}{l.tooth ? ` · #${l.tooth}` : ''}{l.surfaces ? ` ${l.surfaces}` : ''} <span className="muted">({l.code})</span></span><span>{money(l.fee)}{l.insurance ? ` − ${money(l.insurance)} ${t('insurance')}` : ''}{l.write_off ? ` − ${money(l.write_off)} ${t('in-network')}` : ''} = <strong>{money(l.you_pay)}</strong></span></div>
                      ))}
                    </div>
                  )}
                  {q.phases.length > 1 && (
                    <button type="button" className="cp-toggle" aria-pressed={on} onClick={() => togglePhase(p.phase)}>{on ? t('Included now') : t('Add to what I’m doing now')}</button>
                  )}
                </div>
                <div className="cp-price">
                  <div className="muted" style={{ fontSize: 12 }}>{t('You pay')}</div>
                  <strong>{money(p.you_pay)}</strong>
                  {p.insurance > 0 && <div className="muted" style={{ fontSize: 12 }}>{t('insurance {amount}', { amount: money(p.insurance) })}</div>}
                </div>
              </div>
            );
          })}
          {q.years.length > 1 && <div className="muted" style={{ fontSize: 12.5 }}>{t('Spread over two benefit years so your insurance pays more.')}</div>}
        </div>
      )}

      {q?.options?.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('Ways to pay your {amount}', { amount: money(q.amount) })}</h3>
          <FinOptionCards options={q.options} picked={option} onPick={(k) => setOption(k === option ? null : k)} t={t} />
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{t('Insurance amounts are estimates and not a guarantee of payment. Financing is subject to the lender’s approval.')}</p>
        </div>
      )}
      {!q && plan.financing && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('Ways to pay your {amount}', { amount: money(plan.financing.amount) })}</h3>
          {plan.financing.links.length > 0 && <p>{t('Or apply for financing:')} {plan.financing.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer" style={{ marginRight: 12 }}>{l.name} ↗</a>)}</p>}
        </div>
      )}
      <form className="card cp-accept" onSubmit={(ev) => { ev.preventDefault(); submit(); }}>
        <h2>{t('Accept your plan')}</h2>
        <label className="checkbox" style={{ color: 'var(--text)', fontSize: 14, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={consent} onChange={(ev) => setConsent(ev.target.checked)} style={{ marginTop: 3 }} />
          {t('I have reviewed this treatment plan, my questions have been answered, and I understand the estimated costs are my responsibility if insurance pays less.')}
        </label>
        <label style={{ marginTop: 12 }}>{t('Type your full name')}<input required value={name} onChange={(ev) => setName(ev.target.value)} autoComplete="name" ref={nameBox} /></label>
        <div style={{ marginTop: 10 }}><SignaturePad onChange={setImage} /></div>
        <ErrorBox error={error} />
        <button className="primary big" style={{ marginTop: 12 }} disabled={busy || !consent || name.trim().length < 2 || (compare?.options?.length > 1 && !picked)}>{t('Accept & sign')}</button>
        {compare?.options?.length > 1 && !picked && <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{t('Choose one of the options above first.')}</div>}
        {option && q && <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{t('With: {option}', { option: (() => { const o = q.options.find((x) => x.key === option); return o ? `${o.kind === 'lender' ? `${LENDER_NAMES[o.lender]} — ` : ''}${t(o.title)}` : ''; })() })}</div>}
      </form>
      <BackToOffice back={hand.back} />
    </PublicLayout>
  );
}

// The patient's window on the second screen: wide, and one tap to fill the screen (browsers only allow full
// screen after a tap in the window itself; F11 works too).
function CompareScreen({ t }) {
  useEffect(() => {
    document.body.classList.add('cmp-present');
    return () => document.body.classList.remove('cmp-present');
  }, []);
  if (!document.fullscreenEnabled) return null;
  return (
    <button type="button" className="cmp-fullscreen" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})}>
      <Maximize size={14} aria-hidden="true" /> {t('Full screen')}
    </button>
  );
}
