import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { money, toCents, fromCents } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import '../../pages/compliance.css';
import './retail.css';
import { toast } from '../../toast.js';

// A toast with Undo: the undo goes through the void route (reversing entries, audited).
const withUndo = (message, undo) => toast(message, {
  undo: async () => { try { await undo(); toast('Undone'); } catch (e) { toast(`Couldn’t undo: ${e.message}`, { tone: 'error' }); } },
});

// Selling a product and using a gift certificate, right on the ledger or at checkout (A176, A184;
// docs/cash-handling.md §10). Both post to the one ledger on the server; Undo voids them (reversing
// entries), nothing is deleted. The request carries a key made when the panel opens, so a double click or a retry
// posts once.
const newKey = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Pick a product (its number key or ↑↓), quantity 1 unless changed, Enter sells it.
export function SellProduct({ patient, onDone, onCancel }) {
  const { data: products } = useApi('/retail/products');
  const [pick, setPick] = useState(0);
  const [qty, setQty] = useState(1);
  const key = useRef(newKey());
  const box = useRef(null);
  useEffect(() => { box.current?.focus(); }, [products]);
  const p = products?.[pick];
  const subtotal = p ? p.price * (Number(qty) || 0) : 0;
  const tax = p?.taxable ? Math.round(p.tax * (Number(qty) || 0)) : 0;
  const { submit, busy, error } = useSubmit(async () => {
    if (!p) return;
    const out = await api.post(`/patients/${patient.id}/retail-sales`, { product_id: p.id, quantity: Number(qty) || 1, client_key: key.current });
    key.current = newKey();
    onDone(out);
    withUndo(`Sold ${p.name}${qty > 1 ? ` × ${qty}` : ''} — ${money(out.sale.subtotal + out.sale.tax)} added to the account.`,
      async () => { await api.post(`/retail-sales/${out.sale.id}/void`, { reason: 'Undone right after the sale' }); onDone(null); });
  });
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); submit(); return; }
    if (e.target.tagName === 'INPUT') return;
    const n = Number(e.key);
    if (n >= 1 && n <= 9 && products?.[n - 1]) { e.preventDefault(); setPick(n - 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setPick((i) => Math.min((products?.length || 1) - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPick((i) => Math.max(0, i - 1)); }
  };
  if (products && !products.length) return <div className="muted">No products set up yet — add them in <Link to="/settings?tab=retail">Settings → Products for sale</Link>.</div>;
  return (
    <form ref={box} tabIndex={-1} onKeyDown={onKey} onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label="Sell a product">
      <ErrorBox error={error} />
      <div className="retail-grid" role="listbox" aria-label="Products">
        {products?.map((x, i) => (
          <button key={x.id} type="button" role="option" aria-selected={i === pick} className={`retail-item${i === pick ? ' active' : ''}`} onClick={() => setPick(i)}>
            {i < 9 && <kbd>{i + 1}</kbd>} <span>{x.name}</span> <b>{money(x.price)}</b>
          </button>
        ))}
      </div>
      <div className="cmp-row" style={{ marginTop: 10 }}>
        <label className="inline-label">How many<input type="number" min="1" max="99" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 70 }} /></label>
        {p && <span>{money(subtotal)}{tax ? ` + ${money(tax)} tax (${p.tax_rate})` : ''} = <strong>{money(subtotal + tax)}</strong></span>}
        {p?.on_hand != null && p.inventory_item_id && <span className="muted" style={{ fontSize: 12 }}>{p.on_hand} in stock</span>}
        <button className="primary" disabled={busy || !p} style={{ marginLeft: 'auto' }}>Sell (Enter)</button>
      </div>
    </form>
  );
}

// Type the code; the amount is what the certificate holds or what the account owes, whichever is less. Enter uses it.
export function RedeemGiftCertificate({ patient, balance, onDone, onCancel }) {
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [cert, setCert] = useState(null);
  const [look, setLook] = useState(null);
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^GC/, '');
  useEffect(() => {
    setCert(null);
    setLook(null);
    if (clean.length !== 8) return undefined;
    let live = true;
    api.get(`/gift-certificates/lookup?code=GC-${clean}`).then((c) => live && setCert(c)).catch((e) => live && setLook(e));
    return () => { live = false; };
  }, [clean]);
  const most = cert ? Math.max(0, Math.min(cert.balance, Math.max(0, balance))) : 0;
  const problem = cert && (cert.status === 'voided' ? 'This certificate was voided.' : cert.expired ? `Expired on ${cert.expires_on}.` : cert.balance <= 0 ? 'Nothing left on this certificate.' : balance <= 0 ? `${patient.first_name} doesn’t owe anything right now.` : null);
  const { submit, busy, error } = useSubmit(async () => {
    const out = await api.post(`/patients/${patient.id}/gift-certificates/redeem`, { code: `GC-${clean}`, amount: amount === '' ? null : toCents(amount) });
    onDone(out);
    withUndo(`Used ${money(-out.entry.amount)} of ${out.cert.code} — ${money(out.cert.balance)} left on it.`,
      async () => { await api.post(`/gift-certificates/redemptions/${out.entry.id}/void`, { reason: 'Undone right after it was used' }); onDone(null); });
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (cert && !problem) submit(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }} aria-label="Use a gift certificate">
      <ErrorBox error={error} />
      <div className="cmp-row">
        <label className="inline-label">Certificate code<input autoFocus className="gc-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="GC-XXXXXXXX" style={{ width: 160 }} /></label>
        <label className="inline-label">Amount<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={cert ? fromCents(most) : '0.00'} style={{ width: 100 }} aria-label="Amount to use" /></label>
        <button className="primary" disabled={busy || !cert || !!problem}>Use it (Enter)</button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        {look ? <span className="text-danger">{look.message}</span>
          : cert ? (problem ? <span className="text-danger">{problem}</span> : <>{cert.code}{cert.recipient_name ? ` for ${cert.recipient_name}` : ''}: {money(cert.balance)} left · uses {money(amount === '' ? most : toCents(amount))} of the {money(balance)} owed{cert.expires_on ? ` · expires ${cert.expires_on}` : ''}</>)
            : 'Type the 8 characters after GC-.'}
      </div>
    </form>
  );
}

// For the ledger's buttons: how many products there are (the Sell button only shows when there are some).
export function useHasProducts() {
  const { data } = useApi('/retail/products');
  return useMemo(() => (data?.length || 0) > 0, [data]);
}
