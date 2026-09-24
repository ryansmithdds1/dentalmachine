import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Camera, Sparkles } from 'lucide-react';
import { api, getToken } from '../../api.js';
import { useApi, useLookup, invalidateLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, toCents, fromCents } from '../../format.js';
import { Badge, ErrorBox, Modal, useSubmit } from '../ui.jsx';
import Eligibility from './Eligibility.jsx';
import InsurancePlanForm from '../InsurancePlanForm.jsx';
import { useShortcut, useCommands } from '../../shortcuts.js';
import { toast } from '../../toast.js';
import { readCard, storedCards } from '../cardRead.js';
import { fileClaim, toastFiled } from '../billClaim.js';
import '../insurance-intake.css';

export default function InsuranceTab({ patient, onChange }) {
  const { can } = useAuth();
  const { data: policies, reload } = useApi(`/patients/${patient.id}/insurance`);
  const { data: claims, reload: reloadClaims } = useApi(can('billing:read') ? `/claims?patient_id=${patient.id}&limit=2000` : null);
  const [modal, setModal] = useState(null);
  // null = the smart default: everything finished and unbilled is ticked (workflow 24).
  const [picked, setPicked] = useState(null);
  const [err, setErr] = useState(null);
  const active = policies?.filter((p) => p.active) || [];
  // Claims go to one insurer at a time: primary first, then the same procedures to the secondary.
  const [billTo, setBillTo] = useState(null);
  const claimPolicy = active.find((p) => p.id === billTo) || active[0];
  const { data: unclaimed, reload: reloadUnclaimed } = useApi(can('billing:read') && claimPolicy ? `/patients/${patient.id}/unclaimed-procedures?patient_insurance_id=${claimPolicy.id}` : null);
  const refresh = () => { reload(); reloadClaims(); reloadUnclaimed(); onChange?.(); };
  const billable = (unclaimed || []).filter((p) => p.fee > 0 || picked?.includes(p.id));
  const selected = picked ?? billable.map((p) => p.id);
  const setSelected = (ids) => setPicked(ids);
  // A claim to this policy that was made but hasn't gone out (it failed the checks, or was made by hand): the
  // bill key sends it rather than making another.
  const draft = claimPolicy && !selected.length ? (claims || []).find((c) => c.patient_insurance_id === claimPolicy.id && c.status === 'draft') : null;
  const { data: connection } = useApi(can('billing:write') ? '/clearinghouse' : null);

  // Scan a card: a photo (front, and the back if picked too) is read by AI and the policy form opens filled in
  // for a person to check. Card photos a patient already sent (?card=<document ids>, from the intake list)
  // are read the same way.
  const picker = useRef(null);
  const [reading, setReading] = useState(false);
  const [cardErr, setCardErr] = useState(null);
  const [params, setParams] = useSearchParams();
  const readFrom = async (files, { stored = null } = {}) => {
    setReading(true);
    setCardErr(null);
    try {
      const read = await readCard(patient.id, files);
      setModal({ policy: null, card: { ...read, files: stored ? [] : files, stored } });
    } catch (e) {
      setCardErr(e);
      toast(`Couldn’t read the card: ${e.message}`, { tone: 'error' });
    } finally {
      setReading(false);
    }
  };
  const pickCard = () => picker.current?.click();
  const canAdd = can('patients:write');
  useShortcut('s', pickCard, { label: 'Scan an insurance card (photo → filled-in policy)', section: 'Insurance', enabled: canAdd && !reading });
  useCommands(canAdd ? [{ id: 'scan-insurance-card', label: 'Scan an insurance card', hint: 'S', run: pickCard }] : []);
  const cardParam = params.get('card');
  useEffect(() => {
    if (!cardParam || !canAdd) return;
    const ids = cardParam.split(',').map(Number).filter(Boolean);
    const next = new URLSearchParams(params);
    next.delete('card');
    setParams(next, { replace: true });
    if (ids.length) storedCards(ids).then((blobs) => readFrom(blobs, { stored: ids }), (e) => setCardErr(e));
  }, [cardParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // Workflow 24: one action (B, or the button) makes the claim for what's ticked and sends it when it passes the
  // checks; a claim that doesn't stays a draft and says what to fix.
  const billing = useRef(false);
  const bill = async () => {
    if (billing.current || !claimPolicy || (!selected.length && !draft)) return;
    billing.current = true;
    setErr(null);
    try {
      const out = await fileClaim({ policy: claimPolicy, procedureIds: selected, draft: selected.length ? null : draft, connection });
      toastFiled(out, { policy: claimPolicy, connection });
      if (!out.sent) setErr(out.error);
      setPicked(null);
      refresh();
    } catch (e) {
      setErr(e);
    } finally {
      billing.current = false;
    }
  };
  const canBill = can('billing:write') && !!claimPolicy && (selected.length > 0 || !!draft);
  const billLabel = selected.length
    ? `${connection?.batch ? 'Send' : 'Create'} ${claimPolicy?.priority || ''} claim to ${claimPolicy?.carrier_name || ''}${connection?.batch ? '' : ' (837 file)'}`
    : draft ? `${connection?.batch ? 'Send' : 'Download'} claim #${draft.id}` : '';
  useShortcut('b', bill, { label: 'Bill insurance: make the claim for the finished work and send it', section: 'Insurance', enabled: canBill });
  useCommands(canBill ? [{ id: 'bill-insurance-tab', label: `Bill insurance: ${billLabel}`, hint: 'B', run: bill }] : []);

  return (
    <>
      <div className="card">
        <div className="page-header" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Coverage</h2>
          {canAdd && (
            <div className="card-scan-row">
              {reading && <span className="card-busy"><Sparkles size={14} /> Reading the card…</span>}
              <button className="primary" disabled={reading} onClick={pickCard} title="Take or choose a photo of the card (front, and back if you have it)"><Camera size={15} /> Scan card <kbd className="elig-kbd">S</kbd></button>
              <button onClick={() => setModal({ policy: null })}>+ Type it in</button>
              <input ref={picker} type="file" accept="image/*,application/pdf" capture="environment" multiple hidden aria-label="Insurance card photo"
                onChange={(e) => { const files = [...(e.target.files || [])]; e.target.value = ''; if (files.length) readFrom(files); }} />
            </div>
          )}
        </div>
        <ErrorBox error={cardErr} />
        {policies?.length === 0 && <div className="muted">No insurance on file (self-pay).</div>}
        {policies?.length > 0 && (
          <table>
            <thead><tr><th>Priority</th><th>Carrier</th><th>Subscriber</th><th>Member ID / Group</th><th>Coverage (P/B/M)</th><th className="num">Annual max</th><th className="num">Deductible</th><th /></tr></thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
                  <td><Badge value={p.active ? p.priority : 'inactive'} /></td>
                  <td>{p.carrier_name}</td>
                  <td>{p.subscriber_name}<div className="muted">{p.relationship}</div></td>
                  <td>{p.subscriber_id}<div className="muted">{p.group_number}</div></td>
                  <td>
                    {p.pct_preventive}% / {p.pct_basic}% / {p.pct_major}%
                    {p.plan && <div className="muted" style={{ fontSize: 11 }}>{p.plan.name || 'Plan'}{p.plan.members > 1 ? ` · shared by ${p.plan.members}` : ''} · <button className="link" style={{ fontSize: 11 }} onClick={() => setModal({ plan: p.plan })}>limits & rules</button></div>}
                  </td>
                  <td className="num">{money(p.annual_max)}</td>
                  <td className="num">{money(p.deductible_met)} of {money(p.deductible)}{p.benefit_month > 1 && <div className="muted" style={{ fontSize: 12 }}>year starts {new Date(2000, p.benefit_month - 1, 1).toLocaleString('en-US', { month: 'short' })} 1</div>}</td>
                  <td>{can('patients:write') && <button className="small" onClick={() => setModal({ policy: p })}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <PortalInsuranceUpdates patient={patient} onApplied={refresh} onRead={(blobs, ids) => readFrom(blobs, { stored: ids })} />
      <Eligibility patient={patient} policies={policies} onApplied={refresh} />

      {can('billing:read') && (
        <div className="card">
          <h2>Claims</h2>
          <ErrorBox error={err} />
          {active.length > 1 && can('billing:write') && (
            <div className="seg" style={{ marginBottom: 10 }}>
              {active.map((p) => <button key={p.id} type="button" className={claimPolicy?.id === p.id ? 'active' : ''} onClick={() => { setBillTo(p.id); setPicked(null); }}>Bill {p.priority}: {p.carrier_name}</button>)}
            </div>
          )}
          {unclaimed?.length > 0 && claimPolicy && can('billing:write') && (
            <div style={{ marginBottom: 16, padding: 12, background: 'var(--warn-soft)', borderRadius: 8 }}>
              <strong>Completed procedures not yet billed to {claimPolicy.carrier_name}{claimPolicy.priority === 'secondary' ? ' (secondary — estimates what the primary leaves)' : ''}</strong>
              {unclaimed.map((p) => (
                <label key={p.id} className="checkbox" style={{ color: 'var(--text)', marginTop: 6 }}>
                  <input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))} />
                  {fmtDate(p.completed_at)} · {p.code} {p.description} {p.tooth ? `#${p.tooth}` : ''} {p.surfaces || ''} · {money(p.fee)}
                </label>
              ))}
              <div className="inline" style={{ marginTop: 8 }}>
                {selected.length < unclaimed.length && <button className="small" onClick={() => setSelected(unclaimed.map((p) => p.id))}>Select all</button>}
                <button className="small primary" disabled={!selected.length} onClick={bill}>{billLabel || `Create ${claimPolicy.priority} claim to ${claimPolicy.carrier_name}`} <kbd className="elig-kbd">B</kbd></button>
              </div>
            </div>
          )}
          {!unclaimed?.length && draft && can('billing:write') && (
            <div className="inline" style={{ marginBottom: 12 }}>
              <span className="muted">Claim #{draft.id} to {claimPolicy.carrier_name} hasn’t gone out yet.</span>
              <button className="small primary" onClick={bill}>{billLabel} <kbd className="elig-kbd">B</kbd></button>
            </div>
          )}
          {claims?.length === 0 ? <div className="muted">No claims.</div> : (
            <table>
              <thead><tr><th>Claim</th><th>Created</th><th>Carrier</th><th>Status</th><th className="num">Billed</th><th className="num">Estimated</th><th className="num">Paid</th></tr></thead>
              <tbody>
                {claims?.map((c) => (
                  <tr key={c.id}>
                    <td><Link to={`/claims/${c.id}`}>#{c.id}</Link></td>
                    <td>{fmtDate(c.created_at)}</td>
                    <td>{c.carrier_name}</td>
                    <td><Badge value={c.status} /></td>
                    <td className="num">{money(c.total_fee)}</td>
                    <td className="num">{money(c.estimated_amount)}</td>
                    <td className="num">{money(c.paid_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {modal?.plan && (
        <Modal title={`Plan: ${modal.plan.name || modal.plan.group_number || 'benefits'}`} wide onClose={() => setModal(null)}>
          <InsurancePlanForm plan={modal.plan} onDone={() => { setModal(null); refresh(); }} />
        </Modal>
      )}
      {modal && !modal.plan && (
        <Modal title={modal.policy ? 'Edit policy' : modal.card ? 'Check the card and save' : 'Add insurance policy'} wide onClose={() => setModal(null)}>
          <PolicyForm patient={patient} policy={modal.policy} card={modal.card} onDone={() => { setModal(null); refresh(); }} />
        </Modal>
      )}
    </>
  );
}

// After a policy is saved from a card: the AI's part and the person's approval on record, the photos filed in
// the chart, and the new coverage checked with the payer — none of it asks anything more of the person.
async function afterCardSave({ patient, card, policyId, can }) {
  await api.post(`/patients/${patient.id}/insurance-card/confirm`, { read_id: card.read_id, policy_id: policyId });
  if (card.files?.length && can('clinical:write')) {
    await Promise.all(card.files.slice(0, 2).map((f, i) => fetch(`/api/patients/${patient.id}/documents?category=insurance_card&filename=${encodeURIComponent(`Insurance card ${i ? 'back' : 'front'}.${(f.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': f.type || 'application/octet-stream' }, body: f,
    }).then((r) => { if (!r.ok) throw new Error('Couldn’t file the card photo in Documents'); })));
  }
  if (can('billing:read')) {
    const r = await api.post(`/insurance/${policyId}/eligibility`);
    if (r.applied) toast(`Saved and checked: coverage ${r.status === 'active' ? 'active' : r.status}, benefits applied`);
    else if (r.reasons?.length) toast(`Saved. Insurance needs a look: ${r.reasons[0]}`, { tone: 'error' });
    else toast('Saved');
  } else toast('Policy saved');
}

function PolicyForm({ patient, policy, card = null, onDone }) {
  const { can } = useAuth();
  const carriers = useLookup('/carriers');
  const fromCard = card?.proposed || {};
  const [form, setForm] = useState(() => ({
    carrier_id: policy?.carrier_id || card?.carrier?.id || (card?.new_carrier && can('billing:write') ? 'new' : ''),
    new_carrier_name: card?.new_carrier?.name || '',
    new_carrier_payer_id: card?.new_carrier?.payer_id || '',
    priority: policy?.priority || 'primary',
    subscriber_name: policy?.subscriber_name || fromCard.subscriber_name || `${patient.first_name} ${patient.last_name}`,
    subscriber_id: policy?.subscriber_id || fromCard.subscriber_id || '',
    subscriber_dob: policy?.subscriber_dob || fromCard.subscriber_dob || patient.dob || '',
    relationship: policy?.relationship || fromCard.relationship || 'self',
    group_number: policy?.group_number || fromCard.group_number || '',
    annual_max: fromCents(policy?.annual_max ?? 150000),
    deductible: fromCents(policy?.deductible ?? 5000),
    deductible_met: fromCents(policy?.deductible_met ?? 0),
    pct_preventive: policy?.pct_preventive ?? 100,
    pct_basic: policy?.pct_basic ?? 80,
    pct_major: policy?.pct_major ?? 50,
    active: policy ? !!policy.active : true,
    benefit_month: policy?.benefit_month ?? 1,
    plan_id: policy?.plan_id ?? '',
    effective_date: policy?.effective_date || fromCard.effective_date || '',
  }));
  // Read from a card: Enter saves (the Save button has focus once the form is up).
  const saveBtn = useRef(null);
  useEffect(() => {
    if (!card) return undefined;
    const t = setTimeout(() => saveBtn.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [card]);
  // Existing plans for the carrier (employer groups): choosing one fills in its benefits.
  const { data: plans } = useApi(form.carrier_id && form.carrier_id !== 'new' ? `/insurance-plans?carrier_id=${form.carrier_id}` : null);
  const pickPlan = (id) => {
    const pl = plans?.find((x) => String(x.id) === String(id));
    if (!pl) return setForm({ ...form, plan_id: '' });
    setForm({
      ...form, plan_id: pl.id, group_number: pl.group_number || form.group_number,
      annual_max: fromCents(pl.annual_max), deductible: fromCents(pl.deductible), pct_preventive: pl.pct_preventive, pct_basic: pl.pct_basic, pct_major: pl.pct_major, benefit_month: pl.benefit_month,
    });
  };
  const chosenPlan = plans?.find((x) => String(x.id) === String(form.plan_id));
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    // A carrier that isn't set up yet is added here, not in Settings.
    let carrierId = form.carrier_id;
    if (carrierId === 'new') {
      if (!form.new_carrier_name.trim()) throw new Error('Enter the insurance company’s name');
      const c = await api.post('/carriers', { name: form.new_carrier_name.trim(), payer_id: form.new_carrier_payer_id.trim() || null });
      invalidateLookup('/carriers');
      carrierId = c.id;
      setForm((f) => ({ ...f, carrier_id: c.id }));
    }
    const { new_carrier_name: _n, new_carrier_payer_id: _p, ...rest } = form;
    const body = {
      ...rest, carrier_id: Number(carrierId),
      annual_max: toCents(form.annual_max), deductible: toCents(form.deductible), deductible_met: toCents(form.deductible_met),
      pct_preventive: Number(form.pct_preventive), pct_basic: Number(form.pct_basic), pct_major: Number(form.pct_major), benefit_month: Number(form.benefit_month),
      plan_id: form.plan_id ? Number(form.plan_id) : null, effective_date: form.effective_date || null,
    };
    if (policy) await api.put(`/insurance/${policy.id}`, body);
    else {
      const saved = await api.post(`/patients/${patient.id}/insurance`, body);
      if (card) {
        onDone();
        await afterCardSave({ patient, card, policyId: saved.id, can }).catch((e) => toast(`Policy saved, but: ${e.message}`, { tone: 'error' }));
        return;
      }
    }
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      {card && (
        <div className={`card-read-banner${card.sandbox ? ' sandbox' : ''}`}>
          <Sparkles size={16} />
          <div>
            <strong>{card.sandbox ? 'Sandbox card reader' : 'Read by AI from the card'}</strong> — {card.reason}
            {card.unclear?.length > 0 && <div>Check these closely: {card.unclear.join(', ')}.</div>}
          </div>
        </div>
      )}
      <div className="form-grid">
        <label>
          Carrier *
          <select required value={form.carrier_id} onChange={set('carrier_id')}>
            <option value="">Select…</option>
            {carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {can('billing:write') && <option value="new">{card?.new_carrier ? `+ New: ${card.new_carrier.name}` : '+ Add a new carrier…'}</option>}
          </select>
        </label>
        {form.carrier_id === 'new' && (
          <div className="full card-new-carrier">
            <label>New carrier name *<input value={form.new_carrier_name} onChange={set('new_carrier_name')} /></label>
            <label>Payer ID<input value={form.new_carrier_payer_id} onChange={set('new_carrier_payer_id')} placeholder="for e-claims" /></label>
          </div>
        )}
        <label>Priority<select value={form.priority} onChange={set('priority')}><option value="primary">Primary</option><option value="secondary">Secondary</option></select></label>
        {plans?.length > 0 && (
          <label className="full">
            Employer plan
            <select value={form.plan_id} onChange={(e) => pickPlan(e.target.value)}>
              <option value="">New plan (or match by group #)</option>
              {plans.map((pl) => <option key={pl.id} value={pl.id}>{pl.name || 'Plan'} · group {pl.group_number || '—'} · {pl.members} patient{pl.members === 1 ? '' : 's'}</option>)}
            </select>
          </label>
        )}
        {chosenPlan && chosenPlan.members > (policy?.plan_id === chosenPlan.id ? 1 : 0) && <div className="full muted" style={{ fontSize: 12 }}>Benefit changes below apply to everyone on this plan ({chosenPlan.members} patient{chosenPlan.members === 1 ? '' : 's'}).</div>}
        <label>Subscriber name *<input required value={form.subscriber_name} onChange={set('subscriber_name')} /></label>
        <label>Member ID *<input required value={form.subscriber_id} onChange={set('subscriber_id')} /></label>
        <label>Subscriber DOB<input type="date" value={form.subscriber_dob} onChange={set('subscriber_dob')} /></label>
        <label>
          Relationship
          <select value={form.relationship} onChange={set('relationship')}>
            <option value="self">Self</option><option value="spouse">Spouse</option><option value="child">Child</option><option value="other">Other</option>
          </select>
        </label>
        <label>Group #<input value={form.group_number} onChange={set('group_number')} /></label>
        <label>Coverage start date<input type="date" value={form.effective_date} onChange={set('effective_date')} /></label>
        <label>Annual max ($)<input type="number" step="0.01" value={form.annual_max} onChange={set('annual_max')} /></label>
        <label>Deductible ($)<input type="number" step="0.01" value={form.deductible} onChange={set('deductible')} /></label>
        <label>Deductible met this benefit year ($)<input type="number" step="0.01" value={form.deductible_met} onChange={set('deductible_met')} /></label>
        <label>
          Benefit year starts
          <select value={form.benefit_month} onChange={set('benefit_month')}>
            {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Date(2000, i, 1).toLocaleString('en-US', { month: 'long' })} 1{i === 0 ? ' (calendar year)' : ''}</option>)}
          </select>
        </label>
        <label>Preventive %<input type="number" min="0" max="100" value={form.pct_preventive} onChange={set('pct_preventive')} /></label>
        <label>Basic %<input type="number" min="0" max="100" value={form.pct_basic} onChange={set('pct_basic')} /></label>
        <label>Major %<input type="number" min="0" max="100" value={form.pct_major} onChange={set('pct_major')} /></label>
        <label className="checkbox"><input type="checkbox" checked={form.active} onChange={set('active')} /> Active</label>
      </div>
      <div className="form-actions"><button ref={saveBtn} className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save policy'}</button></div>
    </form>
  );
}

// A card photo from the chart (documents are behind auth, so fetched with the token).
function CardPhoto({ id }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let url;
    fetch(`/api/documents/${id}/file`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => (r.ok ? r.blob() : null)).then((b) => b && setSrc((url = URL.createObjectURL(b)))).catch(() => {});
    return () => url && URL.revokeObjectURL(url);
  }, [id]);
  return src ? <a href={src} target="_blank" rel="noreferrer"><img className="ins-card-photo" src={src} alt="Insurance card" /></a> : <div className="ins-card-photo muted">Loading…</div>;
}

// New insurance the patient sent in from the portal, with their card photos, until someone enters it.
// "Apply" enters it in one step; without a member ID typed in, the card photos are read instead.
function PortalInsuranceUpdates({ patient, onApplied, onRead }) {
  const { can } = useAuth();
  const { data, reload } = useApi(can('billing:read') ? `/patients/${patient.id}/insurance-updates` : null);
  const [replace, setReplace] = useState({});
  const [err, setErr] = useState(null);
  const pending = (data || []).filter((u) => u.status === 'pending');
  if (!pending.length) return null;
  const apply = async (u) => {
    setErr(null);
    try {
      const r = await api.post(`/insurance-updates/${u.id}/apply`, replace[u.id] ? { replace: true } : {});
      toast(r.already_on_file ? 'Already on file — marked done' : `Added ${r.policy.carrier_name}${r.carrier_created ? ' (new carrier)' : ''}${r.replaced_policy_id ? '; the old primary is now inactive' : ''}`);
      reload();
      onApplied?.();
      if (!r.already_on_file && can('billing:read')) {
        const e = await api.post(`/insurance/${r.policy.id}/eligibility`).catch((x) => ({ error: x }));
        if (e.error) toast(`Couldn’t check the new insurance: ${e.error.message}`, { tone: 'error' });
        else if (e.reasons?.length) toast(`Insurance needs a look: ${e.reasons[0]}`, { tone: 'error' });
        onApplied?.();
      }
    } catch (e) {
      if (e.status === 409 && e.details?.replaces) setReplace((x) => ({ ...x, [u.id]: e.details.replaces }));
      else if (e.details?.needs_card_read && u.document_ids.length) onRead(await storedCards(u.document_ids), u.document_ids);
      else setErr(e);
    }
  };
  const REL = { self: 'the patient', spouse: 'spouse', child: 'parent (patient is their child)', other: 'someone else' };
  return (
    <div className="card portal-ins-update">
      <h2>New insurance from the patient portal</h2>
      {pending.map((u) => (
        <div key={u.id} className="inline" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 10 }}>
          <div className="inline" style={{ gap: 8 }}>{u.document_ids.map((d) => <CardPhoto key={d} id={d} />)}</div>
          <dl className="kv" style={{ gridTemplateColumns: '130px 1fr', flex: 1, minWidth: 260 }}>
            <dt>Sent</dt><dd>{fmtDate(u.created_at.slice(0, 10))}</dd>
            <dt>Insurance company</dt><dd>{u.carrier_name || '—'}</dd>
            <dt>Member ID</dt><dd>{u.member_id || '—'}</dd>
            <dt>Group</dt><dd>{u.group_number || '—'}</dd>
            <dt>Policyholder</dt><dd>{REL[u.relationship] || '—'}{u.subscriber_name ? ` · ${u.subscriber_name}` : ''}{u.subscriber_dob ? ` (born ${fmtDate(u.subscriber_dob)})` : ''}</dd>
            {u.note && <><dt>Note</dt><dd>{u.note}</dd></>}
          </dl>
          {can('billing:write') && (
            <div className="inline" style={{ gap: 6, flexDirection: 'column', alignItems: 'stretch' }}>
              <button className="primary small" onClick={() => apply(u)}>{replace[u.id] ? `Replace ${replace[u.id]} with this` : u.carrier_name && u.member_id ? 'Apply' : 'Read the card'}</button>
              <button className="small" onClick={() => api.post(`/insurance-updates/${u.id}/reviewed`).then(reload, setErr)}>Entered — mark done</button>
            </div>
          )}
        </div>
      ))}
      <ErrorBox error={err} />
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>Apply adds it as the primary policy (a missing carrier is added too) and checks it with the payer.</p>
    </div>
  );
}
