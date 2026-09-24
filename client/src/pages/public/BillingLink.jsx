import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';

// The patient's secure billing link (/billing-link/:token, backlog BL1/BL3): update the card after a declined
// payment or before it expires — the declined payment is tried again straight away — or read and agree to
// automatic payments the office set up. With Stripe the card is typed on Stripe's page (never on ours); in sandbox
// only test card numbers are taken.
export default function BillingLink() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  const [card, setCard] = useState('');
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const load = () => api.get(`/public/billing-link/${token}`).then(setPage).catch(setError);
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back from Stripe's card page: the card arrives by webhook a moment later.
  useEffect(() => {
    if (params.get('saved') !== '1') return undefined;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const saveCard = () => run(async () => {
    const out = await api.post(`/public/billing-link/${token}/card`, page.mode === 'sandbox' ? { card_number: card } : {});
    if (out.url) { window.location.href = out.url; return; }
    setDone(page.kind === 'update_card'
      ? (out.retried?.length ? (out.retried.every((r) => r.ok) ? 'Thank you — your card is updated and the payment went through.' : 'Your card is updated, but the payment still didn’t go through. The office will be in touch.') : 'Thank you — your card is updated.')
      : null);
    await load();
  });
  const sign = () => run(async () => {
    await api.post(`/public/billing-link/${token}/agree`, { signer_name: name, agree, terms_hash: page.terms_hash, ...(page.mode === 'sandbox' && !page.new_card ? { card_number: card } : {}) });
    setDone('Thank you — your automatic payments are set up. You’ll get a receipt for each payment.');
    await load();
  });

  if (!page) return <PublicLayout title="Payments"><ErrorBox error={error} />{!error && <p>Loading…</p>}</PublicLayout>;
  const practice = page.practice;
  const cardField = page.mode === 'sandbox' && (
    <label>Card number (sandbox: 4242 4242 4242 4242)
      <input inputMode="numeric" autoComplete="cc-number" value={card} onChange={(e) => setCard(e.target.value)} />
    </label>
  );
  return (
    <PublicLayout title={page.kind === 'authorize' ? 'Your automatic payments' : 'Update your card'} practice={practice}>
      <ErrorBox error={error} />
      {done && <div className="card"><p>{done}</p></div>}
      {page.status === 'expired' && !done && <div className="card"><p>This link has expired. Please call {practice.phone || 'the office'} and we’ll help.</p></div>}
      {page.status === 'done' && !done && <div className="card"><p>All set — nothing more to do here. Thank you, {page.first_name}!</p></div>}
      {page.status === 'open' && page.kind === 'update_card' && !done && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); saveCard(); }}>
          <p>Hi {page.first_name}{page.old_card ? `, the ${page.old_card.brand || 'card'} ending ${page.old_card.last4} we have on file needs updating` : ''}. Add a card below and we’ll use it for your automatic payments{page.old_card ? ' — and try the payment that didn’t go through again right away' : ''}.</p>
          {cardField}
          <button className="primary" type="submit" disabled={busy || (page.mode === 'sandbox' && !card)}>{page.mode === 'sandbox' ? 'Save card' : 'Add a card securely'}</button>
          <p className="muted">Questions? Call {practice.phone || 'the office'}.</p>
        </form>
      )}
      {page.status === 'open' && page.kind === 'authorize' && !done && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); sign(); }}>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{page.terms}</pre>
          {page.pass_through && <p><strong>{page.pass_through.text}</strong></p>}
          {page.new_card
            ? <p>Card: {page.new_card.brand} •••• {page.new_card.last4}</p>
            : page.mode === 'sandbox' ? cardField : <button type="button" onClick={saveCard} disabled={busy}>Add a card securely</button>}
          <label>Your full name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
          <label className="row"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I agree to these automatic payments</label>
          <button className="primary" type="submit" disabled={busy || !name.trim() || !agree || (!page.new_card && page.mode !== 'sandbox') || (page.mode === 'sandbox' && !page.new_card && !card)}>Agree and set up</button>
        </form>
      )}
    </PublicLayout>
  );
}
