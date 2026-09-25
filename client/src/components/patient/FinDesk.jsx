import { useEffect, useState } from 'react';
import { CalendarPlus, FileSignature, FileDown, BadgeCheck } from 'lucide-react';
import { api, download } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { money } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import { toast } from '../../toast.js';
import FinOptionCards, { LENDER_NAMES } from './FinOptionCards.jsx';

const METHODS = [['credit_card', 'Card'], ['debit_card', 'Debit'], ['cash', 'Cash'], ['check', 'Check'], ['ach', 'Bank (ACH)']];

// At the desk (F3/F4): the same options the patient sees, the phases to include, and one button to record the
// patient's choice. Afterwards: the agreement, the prepayment (which posts the prepay discount with it), the
// printable agreement, and the next steps — book the first visit and send the consent.
export default function FinDesk({ plan, patient, quote, onQuote, onChange, onBook, onConsent }) {
  const { can, user } = useAuth();
  const [picked, setPicked] = useState(null);
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState('credit_card');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => { if (picked && !quote?.options.some((o) => o.key === picked)) setPicked(null); }, [quote, picked]);
  if (!quote) return null;
  const a = quote.agreement;
  const billing = can('billing:write');
  const run = async (fn) => {
    setErr(null);
    setBusy(true);
    try { await fn(); } catch (e) {
      if (e.details?.changed) { toast('The numbers changed — here they are again', { tone: 'warn' }); onQuote(quote.chosen); } else setErr(e);
    } finally { setBusy(false); }
  };
  const phases = quote.phases.filter((p) => p.count);
  const togglePhase = (n) => {
    const set = new Set(quote.chosen);
    if (set.has(n)) set.delete(n); else set.add(n);
    if (set.size) onQuote([...set].sort());
  };
  const accept = () => run(async () => {
    const out = await api.post(`/treatment-plans/${plan.id}/fin-accept`, { option_key: picked, quote_hash: quote.quote_hash, phases: quote.chosen, signature_name: name.trim() || undefined });
    toast(`${patient.first_name} chose: ${out.chosen.kind === 'lender' ? `${LENDER_NAMES[out.chosen.lender]} — ` : ''}${out.chosen.title}`);
    onChange();
  });
  // The first chosen phase's work that isn't booked yet.
  const firstOpen = () => {
    const ph = quote.phases.find((p) => (a?.phases || quote.chosen).includes(p.phase) && p.lines.length);
    const ids = new Set(ph?.lines.map((l) => l.id) || []);
    return plan.procedures.filter((p) => ids.has(p.id) && p.status === 'planned' && !p.appointment_id);
  };
  const toBook = a ? firstOpen() : [];

  return (
    <div className="fin-desk" data-fin={plan.id}>
      <ErrorBox error={err} />
      {a ? (
        <>
          <div className="fin-agreement">
            <BadgeCheck size={18} aria-hidden="true" />
            <span><strong>{a.chosen.kind === 'lender' ? `${LENDER_NAMES[a.chosen.lender]} — ` : ''}{a.chosen.title}</strong> · total {money(a.total)} · today {money(a.due_today)}{a.monthly ? ` · ${a.months} × ${money(a.monthly)}` : ''}</span>
            <span className="muted" style={{ fontSize: 12 }}>{a.source === 'patient' ? `Signed by ${a.signature_name}` : `Recorded by staff${a.signature_name ? ` for ${a.signature_name}` : ''}`}{a.intact ? '' : ' · snapshot check failed'}</span>
            <span style={{ marginLeft: 'auto' }} className="inline">
              <button type="button" className="small" onClick={() => download(`/fin-agreements/${a.id}/pdf`, `agreement-${a.id}.pdf`)}><FileDown size={14} aria-hidden="true" /> Agreement</button>
              {billing && a.discount_status !== 'posted' && !cancelling && <button type="button" className="small" onClick={() => setCancelling(true)}>Cancel…</button>}
            </span>
          </div>
          {billing && a.discount_status === 'pending' && (
            <div className="fin-accept">
              <span>Prepay discount of <strong>{money(a.discount_amount)}</strong> goes on the ledger with the payment of <strong>{money(a.due_today)}</strong>:</span>
              <select aria-label="Payment method" value={method} onChange={(e) => setMethod(e.target.value)} style={{ width: 'auto' }}>{METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <button type="button" className="primary small" disabled={busy} onClick={() => run(async () => { await api.post(`/fin-agreements/${a.id}/prepay`, { method }); toast(`Prepayment of ${money(a.due_today)} and the ${money(a.discount_amount)} discount posted`); onChange(); })}>Post prepayment</button>
            </div>
          )}
          {a.discount_status === 'posted' && (
            <div className="fin-accept muted" style={{ fontSize: 13 }}>
              Prepaid {money(a.due_today)} with a {money(a.discount_amount)} discount.
              {(user?.role === 'admin' || can('deposits:manage')) && !cancelling && <button type="button" className="small" onClick={() => setCancelling('discount')}>Reverse discount…</button>}
            </div>
          )}
          {cancelling && (
            <form className="fin-accept" onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const out = await api.post(`/fin-agreements/${a.id}/${cancelling === 'discount' ? 'reverse-discount' : 'cancel'}`, { reason });
                toast(cancelling === 'discount' ? 'Discount reversed (a reversing entry is on the ledger)' : `Agreement cancelled${out.left?.length ? ` — ${out.left.join(' ')}` : ''}`);
                setCancelling(false); setReason(''); onChange();
              });
            }}>
              <input autoFocus aria-label="Reason" placeholder="Why? (kept on record)" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setCancelling(false)} />
              <button className="small danger" disabled={busy || !reason.trim()}>{cancelling === 'discount' ? 'Reverse discount' : 'Cancel agreement'}</button>
              <button type="button" className="small" onClick={() => setCancelling(false)}>Keep</button>
            </form>
          )}
          {(toBook.length > 0 || plan.procedures.some((p) => p.status === 'planned')) && (
            <div className="fin-next">
              {toBook.length > 0 && can('schedule:write') && <button type="button" className="small primary" onClick={() => onBook(toBook)}><CalendarPlus size={14} aria-hidden="true" /> Book first visit</button>}
              <button type="button" className="small" onClick={() => onConsent(plan)}><FileSignature size={14} aria-hidden="true" /> Send consent</button>
            </div>
          )}
        </>
      ) : quote.options.length > 0 ? (
        <>
          <div className="fin-desk-head">
            <h4>Ways to pay {money(quote.amount)}</h4>
            {phases.length > 1 && phases.map((p) => (
              <button key={p.phase} type="button" className="fin-chip" aria-pressed={quote.chosen.includes(p.phase)} onClick={() => togglePhase(p.phase)}>{p.name}</button>
            ))}
            {quote.ppo_savings > 0 && <span className="fin-save">In-network savings {money(quote.ppo_savings)}</span>}
          </div>
          <FinOptionCards options={quote.options} picked={picked} onPick={(k) => setPicked(k === picked ? null : k)} disabled={!billing} />
          {billing && (
            <div className="fin-accept">
              <input aria-label="Patient's name (optional)" placeholder={`${patient.first_name} ${patient.last_name} (optional)`} value={name} onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && picked) { e.preventDefault(); accept(); } }} />
              <button type="button" className="primary" disabled={busy || !picked} onClick={accept}>Accept for {patient.first_name}</button>
              <span className="muted" style={{ fontSize: 12.5 }}>Or <em>Present here</em> so {patient.first_name} chooses and signs.</span>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
