import { useState } from 'react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, toCents, fromCents } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import { toast } from '../../toast.js';

// Settings → Products for sale (A176) and gift certificate rules (A184): docs/cash-handling.md §10.
// Prices, tax and expiry are an administrator's; every change is kept in the audit log (before → after). Products
// are switched off, never removed, so past sales still name them.
export default function RetailSettings() {
  const { user } = useAuth();
  const admin = user.role === 'admin';
  const { data: products, reload } = useApi('/retail/products?all=1');
  const { data: settings, reload: reloadSettings } = useApi('/retail/settings');
  const stock = useLookup(admin ? '/inventory' : null);
  const items = stock?.items || [];
  const [adding, setAdding] = useState({ name: '', price: '', code: '', taxable: true, inventory_item_id: '' });
  const add = useSubmit(async () => {
    await api.post('/retail/products', { ...adding, price: toCents(adding.price), inventory_item_id: adding.inventory_item_id || null });
    setAdding({ name: '', price: '', code: '', taxable: true, inventory_item_id: '' });
    toast('Product added');
    reload();
  });
  const save = async (p, patch) => { await api.put(`/retail/products/${p.id}`, patch); reload(); };
  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Products for sale</h2>
        <p className="muted">Toothbrushes, whitening kits, night-guard cleaner… Sold from the patient’s ledger or at checkout (“Sell a product”), posted as a charge, with sales tax when you charge it. Linking a supplies item takes it out of stock.</p>
        {settings && <SalesTax settings={settings} admin={admin} onSaved={reloadSettings} />}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Product</th><th>Code</th><th className="num">Price</th><th>Taxable</th><th>Stock item</th><th>For sale</th></tr></thead>
            <tbody>
              {products?.map((p) => (
                <tr key={p.id} className={p.active ? '' : 'cmp-voided'}>
                  <td>{p.name}</td>
                  <td>{p.code || <span className="muted">—</span>}</td>
                  <td className="num">{admin ? <PriceCell p={p} onSave={(price) => save(p, { price })} /> : money(p.price)}</td>
                  <td><input type="checkbox" aria-label={`${p.name} is taxable`} checked={!!p.taxable} disabled={!admin} onChange={(e) => save(p, { taxable: e.target.checked })} /></td>
                  <td>{p.inventory_name ? `${p.inventory_name} (${p.on_hand} left)` : <span className="muted">—</span>}</td>
                  <td><input type="checkbox" aria-label={`${p.name} is for sale`} checked={!!p.active} disabled={!admin} onChange={(e) => save(p, { active: e.target.checked })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {products && !products.length && <div className="empty">No products yet.</div>}
        </div>
        {admin && (
          <form className="form-grid" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); if (adding.name.trim() && Number(adding.price) > 0) add.submit(); }}>
            <label>Product<input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="e.g. Sonic toothbrush" /></label>
            <label>Price ($)<input inputMode="decimal" value={adding.price} onChange={(e) => setAdding({ ...adding, price: e.target.value })} /></label>
            <label>Code (optional)<input value={adding.code} onChange={(e) => setAdding({ ...adding, code: e.target.value })} /></label>
            <label>Stock item (optional)
              <select value={adding.inventory_item_id} onChange={(e) => setAdding({ ...adding, inventory_item_id: e.target.value })}>
                <option value="">Not tracked</option>
                {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </label>
            <label className="checkbox"><input type="checkbox" checked={adding.taxable} onChange={(e) => setAdding({ ...adding, taxable: e.target.checked })} /> Taxable</label>
            <div className="form-actions"><button className="primary" disabled={add.busy || !adding.name.trim() || !(Number(adding.price) > 0)}>Add product</button></div>
            <ErrorBox error={add.error} />
          </form>
        )}
      </div>
      {settings && <GiftCertificateRules settings={settings} admin={admin} onSaved={reloadSettings} />}
    </>
  );
}

function PriceCell({ p, onSave }) {
  const [v, setV] = useState(null);
  if (v === null) return <button type="button" className="link" onClick={() => setV(fromCents(p.price))} title="Change the price">{money(p.price)}</button>;
  const done = async () => { const c = toCents(v); setV(null); if (c > 0 && c !== p.price) { await onSave(c); toast(`${p.name}: ${money(p.price)} → ${money(c)}`); } };
  return <input autoFocus aria-label={`Price of ${p.name}`} inputMode="decimal" value={v} style={{ width: 90 }} onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') setV(null); }} />;
}

function SalesTax({ settings, admin, onSaved }) {
  const [rate, setRate] = useState(String((settings.sales_tax_bp || 0) / 100));
  const save = useSubmit(async () => { await api.put('/retail/settings', { sales_tax_bp: Math.round(Number(rate) * 100) }); toast('Sales tax saved'); onSaved(); });
  return (
    <form className="cmp-row" style={{ marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); save.submit(); }}>
      <label className="inline-label">Sales tax on taxable products (%)<input inputMode="decimal" value={rate} disabled={!admin} onChange={(e) => setRate(e.target.value)} style={{ width: 80 }} /></label>
      {admin && <button disabled={save.busy || Number(rate) * 100 === settings.sales_tax_bp}>Save</button>}
      <span className="muted" style={{ fontSize: 12 }}>0 if you don’t charge sales tax. Ask your accountant which products are taxable in your state.</span>
      <ErrorBox error={save.error} />
    </form>
  );
}

function GiftCertificateRules({ settings, admin, onSaved }) {
  const [years, setYears] = useState(settings.gift_certificate_expiry_months ? String(settings.gift_certificate_expiry_months / 12) : '');
  const save = useSubmit(async () => {
    await api.put('/retail/settings', { gift_certificate_expiry_months: years === '' ? null : Math.round(Number(years) * 12) });
    toast('Saved');
    onSaved();
  });
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Gift certificates</h2>
      <p className="muted">Sold from Account → Gift certificates, used on a patient’s ledger or at checkout. By federal law a gift certificate can’t expire sooner than {settings.min_expiry_months / 12} years after it’s sold, and some states don’t allow expiry at all — leave this blank unless you’re sure.</p>
      <form className="cmp-row" onSubmit={(e) => { e.preventDefault(); save.submit(); }}>
        <label className="inline-label">Expire after (years)<input inputMode="numeric" value={years} disabled={!admin} placeholder="never" onChange={(e) => setYears(e.target.value)} style={{ width: 80 }} /></label>
        {admin && <button disabled={save.busy}>Save</button>}
        <ErrorBox error={save.error} />
      </form>
    </div>
  );
}
