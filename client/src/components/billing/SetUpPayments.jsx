import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, todayLocal } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox, useSubmit } from '../ui.jsx';

// "Set up payments" (BL1): one side panel from the ledger, checkout, treatment acceptance or anywhere a patient is
// open — a payment plan, a recurring charge, or autopay for a membership / ortho contract; the card on file; and the
// patient's OK, typed on screen or by a text link. The exact words are shown before anyone agrees, and the server
// only accepts the set-up with the fingerprint of what was shown.
// Props: patientId, kind? ('payment_plan' | 'recurring' | 'membership' | 'ortho_case'), sourceId?, total? (cents), onDone, onClose.
const KINDS = [['payment_plan', 'Payment plan'], ['recurring', 'Recurring charge'], ['membership', 'Membership autopay'], ['ortho_case', 'Ortho autopay']];
const today = todayLocal; // the office's calendar day, not UTC's

export default function SetUpPayments({ patientId, kind: initialKind = 'payment_plan', sourceId = null, total = null, onDone, onClose }) {
  const { can } = useAuth();
  const cards = useApi(`/patients/${patientId}/payment-methods`);
  const [kind, setKind] = useState(initialKind);
  const [f, setF] = useState({
    total: total != null ? (total / 100).toFixed(2) : '', down: '', months: 6, day: Math.min(28, Number(today().slice(8, 10))), amount: '', description: '', max: '',
    card: '', source: sourceId || '', fees: [], signer: '', how: 'screen', send: 'auto',
  });
  const [preview, setPreview] = useState(null);
  const set = (k, v) => { setF((x) => ({ ...x, [k]: v })); setPreview(null); };
  useEffect(() => { if (!f.card && cards.data?.length) setF((x) => ({ ...x, card: String(cards.data[0].id) })); }, [cards.data, f.card]);
  const cents = (v) => (v === '' || v == null ? undefined : Math.round(Number(v) * 100));
  const body = () => ({
    patient_id: patientId, kind, payment_method_id: f.card ? Number(f.card) : null,
    ...(kind === 'payment_plan' ? { total: cents(f.total), down_payment: cents(f.down) || 0, months: Number(f.months), day_of_month: Number(f.day), fees: f.fees } : {}),
    ...(kind === 'recurring' ? { amount: cents(f.amount), day_of_month: Number(f.day), description: f.description || undefined, max_charges: f.max ? Number(f.max) : null } : {}),
    ...(['membership', 'ortho_case'].includes(kind) ? { source_id: Number(f.source) } : {}),
  });
  const look = useSubmit(async () => setPreview(await api.post('/billing/setup/preview', body())));
  const go = useSubmit(async () => {
    const out = await api.post('/billing/setup', { ...body(), terms_hash: preview.terms_hash, agree: f.how === 'screen' ? { how: 'screen', signer_name: f.signer } : { how: 'link', send: f.send } });
    toast(out.link ? 'Link sent — it starts when the patient agrees' : out.replay ? 'Already set up' : 'Automatic payments are set up');
    onDone?.(out);
  });
  if (!can('billing:write')) return null;
  return (
    <aside className="drawer" aria-label="Set up payments">
      <div className="drawer-head"><h2>Set up payments</h2><button onClick={onClose} aria-label="Close">✕</button></div>
      <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); if (preview) go.submit(); else look.submit(); }}>
        <ErrorBox error={cards.error || look.error || go.error} />
        <div className="tabs" role="tablist">
          {KINDS.map(([k, label]) => <button type="button" key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} onClick={() => { setKind(k); setPreview(null); }}>{label}</button>)}
        </div>
        {kind === 'payment_plan' && (
          <>
            <label>Total ($) <span className="muted">(blank = what the account owes after insurance)</span><input autoFocus inputMode="decimal" value={f.total} onChange={(e) => set('total', e.target.value)} /></label>
            <label>Down payment today ($)<input inputMode="decimal" value={f.down} onChange={(e) => set('down', e.target.value)} /></label>
            <label>Months<input inputMode="numeric" value={f.months} onChange={(e) => set('months', e.target.value)} /></label>
          </>
        )}
        {kind === 'recurring' && (
          <>
            <label>Amount each month ($)<input autoFocus inputMode="decimal" value={f.amount} onChange={(e) => set('amount', e.target.value)} /></label>
            <label>For<input value={f.description} placeholder="Monthly payment toward the account" onChange={(e) => set('description', e.target.value)} /></label>
            <label>Number of payments (blank = until stopped)<input inputMode="numeric" value={f.max} onChange={(e) => set('max', e.target.value)} /></label>
          </>
        )}
        {['payment_plan', 'recurring'].includes(kind) && <label>Day of the month (1–28)<input inputMode="numeric" value={f.day} onChange={(e) => set('day', e.target.value)} /></label>}
        {['membership', 'ortho_case'].includes(kind) && <label>{kind === 'membership' ? 'Membership' : 'Ortho contract'} number<input autoFocus inputMode="numeric" value={f.source} onChange={(e) => set('source', e.target.value)} /></label>}
        <label>Card on file
          <select value={f.card} onChange={(e) => set('card', e.target.value)}>
            <option value="">{f.how === 'link' ? 'The patient adds one from the link' : 'Choose a card'}</option>
            {(cards.data || []).map((c) => <option key={c.id} value={c.id}>{c.brand} •••• {c.last4} (exp {c.exp_month}/{String(c.exp_year).slice(-2)})</option>)}
          </select>
        </label>
        <fieldset>
          <legend>The patient agrees</legend>
          <label className="checkbox"><input type="radio" checked={f.how === 'screen'} onChange={() => setF((x) => ({ ...x, how: 'screen' }))} /> Here, on this screen</label>
          <label className="checkbox"><input type="radio" checked={f.how === 'link'} onChange={() => setF((x) => ({ ...x, how: 'link' }))} /> By a text or email link</label>
        </fieldset>
        {!preview && <div className="drawer-actions"><button className="primary" type="submit" disabled={look.busy}>Show the terms</button></div>}
        {preview && (
          <>
            <div className="card">
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>{preview.terms}</pre>
              {preview.schedule?.length > 0 && <p className="muted">First payments: {preview.schedule.slice(0, 3).map((s) => `${fmtDate(s.date)} ${money(s.amount)}`).join(' · ')}</p>}
            </div>
            {f.how === 'screen'
              ? <label>Name of the person agreeing<input autoFocus value={f.signer} onChange={(e) => setF((x) => ({ ...x, signer: e.target.value }))} /></label>
              : (
                <label>Send by
                  <select value={f.send} onChange={(e) => setF((x) => ({ ...x, send: e.target.value }))}><option value="auto">Their usual way</option><option value="sms">Text</option><option value="email">Email</option></select>
                </label>
              )}
            <div className="drawer-actions">
              <button className="primary" type="submit" disabled={go.busy || (f.how === 'screen' && !f.signer.trim())}>{f.how === 'screen' ? 'Agreed — set it up' : 'Send the link'}</button>
              <button type="button" onClick={() => setPreview(null)}>Change</button>
            </div>
          </>
        )}
      </form>
    </aside>
  );
}
