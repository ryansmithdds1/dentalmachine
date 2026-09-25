import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

// Retail sales and gift certificates (docs/cash-handling.md §10): money correctness on the one ledger,
// voids that reverse (never edit or delete), idempotency, permissions, practice isolation and the AI guard.
const h = harness();

const staff = async (api, role, tag) => {
  const email = `${role}-${tag}-${Date.now()}@example.com`;
  await api.post('/users', { email, name: `${role} ${tag}`, role, password: 'correct-horse-battery' });
  return h.client((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);
};
const ledger = async (api, id) => (await api.get(`/patients/${id}/ledger`)).data;
const sum = (rows) => rows.reduce((s, e) => s + e.amount, 0);

test('products: sold to the ledger with sales tax, stock taken, idempotent, voided as a whole (never deleted)', async () => {
  const { api, patient } = await h.practice({ timezone: 'UTC' });
  const desk = await staff(api, 'front_desk', 'retail');
  // Only administrators set prices and tax; the tax can't be silly.
  assert.equal((await desk.post('/retail/products', { name: 'Toothbrush', price: 500 })).status, 403);
  assert.equal((await api.put('/retail/settings', { sales_tax_bp: 5000 })).status, 400);
  assert.equal((await api.put('/retail/settings', { sales_tax_bp: 825 })).data.sales_tax_bp, 825);
  const stock = (await api.post('/inventory', { name: 'Whitening kits', unit: 'each', on_hand: 5 })).data;
  const kit = (await api.post('/retail/products', { name: 'Whitening kit', price: 19900, inventory_item_id: stock.id, code: 'WK1' })).data;
  const floss = (await api.post('/retail/products', { name: 'Floss', price: 300, taxable: false })).data;
  assert.equal((await api.post('/retail/products', { name: 'Whitening kit', price: 100 })).status, 409);
  assert.equal((await api.post('/retail/products', { name: 'Free', price: 0 })).status, 400);
  const list = (await desk.get('/retail/products')).data;
  assert.equal(list.find((p) => p.id === kit.id).tax, 1642, '8.25% of $199.00, rounded to the cent');

  // Two kits: $398.00 + $32.84 tax, one charge and one tax line on the ledger, stock 5 → 3.
  const key = `sale-${Date.now()}`;
  const sold = await desk.post(`/patients/${patient.id}/retail-sales`, { product_id: kit.id, quantity: 2, client_key: key });
  assert.equal(sold.status, 201, JSON.stringify(sold.data));
  assert.equal(sold.data.sale.subtotal, 39800);
  assert.equal(sold.data.sale.tax, 3284);
  assert.equal(sold.data.balance, 43084);
  // The same sale again (a double click, a retry): nothing new is posted.
  const again = await desk.post(`/patients/${patient.id}/retail-sales`, { product_id: kit.id, quantity: 2, client_key: key });
  assert.equal(again.status, 200);
  assert.equal(again.data.sale.id, sold.data.sale.id);
  let l = await ledger(api, patient.id);
  const lines = l.entries.filter((e) => e.retail_sale_id === sold.data.sale.id);
  assert.deepEqual(lines.map((e) => [e.type, e.amount]).sort(), [['adjustment', 3284], ['charge', 39800]]);
  assert.equal(l.balance, 43084);
  assert.equal((await api.get('/inventory')).data.items.find((i) => i.id === stock.id).on_hand, 3);
  // Untaxed product: no tax line.
  const flossSale = (await desk.post(`/patients/${patient.id}/retail-sales`, { product_id: floss.id })).data.sale;
  assert.equal(flossSale.tax, 0);
  assert.equal((await desk.post(`/patients/${patient.id}/retail-sales`, { product_id: kit.id, quantity: 0 })).status, 400);
  assert.equal((await desk.post(`/patients/${patient.id}/retail-sales`, { product_id: kit.id, quantity: 1.5 })).status, 400);

  // The ledger's own Void on the charge voids the whole sale: charge and tax reversed, stock back.
  const charge = lines.find((e) => e.type === 'charge');
  assert.equal((await desk.post(`/ledger/${charge.id}/void`, {})).status, 400, 'a reason is required');
  const v = await desk.post(`/ledger/${charge.id}/void`, { reason: 'Changed their mind' });
  assert.equal(v.status, 201, JSON.stringify(v.data));
  assert.equal(v.data.sale.status, 'voided');
  l = await ledger(api, patient.id);
  assert.equal(l.balance, 300, 'only the floss is left');
  assert.ok(l.entries.filter((e) => e.retail_sale_id === sold.data.sale.id && !e.reverses_id).every((e) => e.voided_at), 'originals kept, marked void');
  assert.equal(l.entries.filter((e) => e.retail_sale_id === sold.data.sale.id && e.reverses_id).length, 2, 'the reversals stay linked to the sale');
  assert.equal(l.entries.filter((e) => e.description.startsWith('Void: ')).length, 2, 'two reversing entries');
  assert.equal((await api.get('/inventory')).data.items.find((i) => i.id === stock.id).on_hand, 5);
  assert.equal((await desk.post(`/retail-sales/${sold.data.sale.id}/void`, { reason: 'again' })).status, 409);
  // A tax line can't be voided on its own.
  const tax = lines.find((e) => e.type === 'adjustment');
  assert.equal((await desk.post(`/ledger/${tax.id}/void`, { reason: 'x' })).status, 409);
  const audit = (await api.get('/audit-log?limit=100')).data;
  assert.ok(audit.some((e) => e.action === 'retail.sale') && audit.some((e) => e.action === 'retail.void'));

  // Prices change with before → after in the audit log; products are switched off, never removed.
  await api.put(`/retail/products/${floss.id}`, { price: 350, active: false });
  assert.equal((await desk.get('/retail/products')).data.some((p) => p.id === floss.id), false);
  assert.equal((await desk.post(`/patients/${patient.id}/retail-sales`, { product_id: floss.id })).status, 400);
  const change = (await api.get('/audit-log?limit=20')).data.find((e) => e.action === 'retail.product_change');
  assert.deepEqual(JSON.parse(change.changes).price, [300, 350]);
});

test('gift certificates: a liability, not income; redeemed against a balance in parts; voids reverse; expiry rules', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const desk = await staff(api, 'front_desk', 'gc');
  const buyer = (await api.post('/patients', { first_name: 'Gail', last_name: 'Giver', dob: '1970-01-01' })).data;

  // Expiry can't be under five years (federal CARD Act); blank is never.
  assert.equal((await api.put('/retail/settings', { gift_certificate_expiry_months: 12 })).status, 400);
  assert.equal((await api.put('/retail/settings', { gift_certificate_expiry_months: 60 })).data.gift_certificate_expiry_months, 60);

  const key = `gc-${Date.now()}`;
  const sold = await desk.post('/gift-certificates', { amount: 20000, purchaser_patient_id: buyer.id, recipient_name: 'Jane Doe', method: 'cash', client_key: key });
  assert.equal(sold.status, 201, JSON.stringify(sold.data));
  const gc = sold.data;
  assert.match(gc.code, /^GC-[A-Z2-9]{8}$/);
  assert.equal(gc.balance, 20000);
  assert.ok(gc.expires_on > gc.issued_on);
  assert.equal((await desk.post('/gift-certificates', { amount: 20000, purchaser_patient_id: buyer.id, method: 'cash', client_key: key })).data.id, gc.id, 'same sale again: same certificate');
  const printed = await desk.get(`/gift-certificates/${gc.id}/certificate.pdf`);
  assert.equal(printed.headers.get('content-type'), 'application/pdf');
  assert.equal((await desk.post('/gift-certificates', { amount: 0, purchaser_patient_id: buyer.id })).status, 400);
  assert.equal((await desk.post('/gift-certificates', { amount: 2_000_000, purchaser_patient_id: buyer.id })).status, 400);
  // The buyer paid $200 (it's on the day sheet as their payment) but owes nothing and has no credit: the money is held.
  let b = await ledger(api, buyer.id);
  assert.equal(b.balance, 0);
  assert.deepEqual(b.entries.map((e) => [e.type, e.amount]).sort(), [['adjustment', 20000], ['payment', -20000]]);

  // Jane has $80 of work done. The certificate pays part, then the rest can't exceed what she owes.
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true });
  const owed = (await ledger(api, patient.id)).balance;
  assert.ok(owed > 0 && owed < 20000, `owes ${owed}`);
  assert.equal((await desk.post(`/patients/${patient.id}/gift-certificates/redeem`, { code: 'GC-NOPE2345' })).status, 404);
  const part = await desk.post(`/patients/${patient.id}/gift-certificates/redeem`, { code: gc.code.toLowerCase().replace('-', ' '), amount: 3000 });
  assert.equal(part.status, 201, JSON.stringify(part.data));
  assert.equal(part.data.cert.balance, 17000);
  assert.equal(part.data.balance, owed - 3000);
  assert.equal((await desk.post(`/patients/${patient.id}/gift-certificates/redeem`, { code: gc.code, amount: owed })).status, 400, 'more than she owes: no credit from a certificate');
  // No amount: the most it can do (what she still owes).
  const rest = (await desk.post(`/patients/${patient.id}/gift-certificates/redeem`, { code: gc.code })).data;
  assert.equal(rest.balance, 0);
  assert.equal(rest.cert.balance, 20000 - owed);
  assert.equal((await desk.post(`/patients/${patient.id}/gift-certificates/redeem`, { code: gc.code })).status, 400, 'nothing owed now');

  // Lookup and the outstanding report: what the practice still owes holders.
  const look = (await desk.get(`/gift-certificates/lookup?code=${gc.code}`)).data;
  assert.equal(look.balance, 20000 - owed);
  assert.equal(look.redeemed, owed);
  let report = (await desk.get('/gift-certificates')).data;
  assert.equal(report.summary.outstanding_total, 20000 - owed);
  const csv = await desk.get('/gift-certificates?format=csv');
  assert.match(csv.data, new RegExp(gc.code));

  // Voiding a redemption gives the certificate its money back and Jane owes it again (reversing entry).
  const first = part.data.entry;
  const undo = await desk.post(`/gift-certificates/redemptions/${first.id}/void`, { reason: 'Wrong patient' });
  assert.equal(undo.status, 201, JSON.stringify(undo.data));
  assert.equal(undo.data.cert.balance, 20000 - owed + 3000);
  assert.equal(undo.data.balance, 3000);
  // Can't void the certificate while some of it is used; the buyer's payment can't be voided on its own either.
  const payLine = b.entries.find((e) => e.type === 'payment');
  assert.equal((await api.post(`/gift-certificates/${gc.id}/void`, { reason: 'Returned' })).status, 409);
  assert.equal((await desk.post(`/gift-certificates/${gc.id}/void`, { reason: 'Returned' })).status, 403, 'a manager voids certificates');
  assert.equal((await desk.post(`/ledger/${payLine.id}/void`, { reason: 'x' })).status, 403, 'the payment line routes to the certificate void: manager only');

  // A second certificate, returned unused: both sale lines reversed, the buyer is back to zero, report excludes it.
  const gc2 = (await desk.post('/gift-certificates', { amount: 5000, purchaser_patient_id: buyer.id, method: 'credit_card' })).data;
  const voided = await api.post(`/gift-certificates/${gc2.id}/void`, { reason: 'Returned the same day' });
  assert.equal(voided.status, 201, JSON.stringify(voided.data));
  b = await ledger(api, buyer.id);
  assert.equal(b.balance, 0);
  assert.equal(b.entries.filter((e) => e.voided_at).length, 2);
  assert.equal((await desk.post(`/patients/${patient.id}/gift-certificates/redeem`, { code: gc2.code })).status, 409);
  report = (await desk.get('/gift-certificates')).data;
  assert.ok(!report.rows.some((c) => c.id === gc2.id));
  const acts = (await api.get('/audit-log?limit=100')).data.map((e) => e.action);
  for (const a of ['gift_certificate.sell', 'gift_certificate.redeem', 'gift_certificate.redemption_void', 'gift_certificate.void']) assert.ok(acts.includes(a), a);

  // Expired certificates can't be used.
  const gc3 = (await desk.post('/gift-certificates', { amount: 1000, purchaser_patient_id: buyer.id, method: 'cash' })).data;
  await h.db.run('UPDATE gift_certificates SET expires_on = ? WHERE id = ?', '2020-01-01', gc3.id);
  const ex = await desk.post(`/patients/${patient.id}/gift-certificates/redeem`, { code: gc3.code });
  assert.equal(ex.status, 409);
  assert.match(ex.data.error, /expired/);
});

test('retail and gift certificates: permissions, practice isolation and the AI guard', async () => {
  const a = await h.practice();
  const b = await h.practice();
  const product = (await a.api.post('/retail/products', { name: 'Brush', price: 400 })).data;
  const gc = (await a.api.post('/gift-certificates', { amount: 2500, purchaser_patient_id: a.patient.id, method: 'cash' })).data;
  // Another practice can't sell A's product, see or use A's certificate, or void A's sale.
  assert.equal((await b.api.post(`/patients/${b.patient.id}/retail-sales`, { product_id: product.id })).status, 404);
  assert.equal((await b.api.post(`/patients/${a.patient.id}/retail-sales`, { product_id: product.id })).status, 404);
  assert.equal((await b.api.get(`/gift-certificates/lookup?code=${gc.code}`)).status, 404);
  assert.equal((await b.api.post(`/patients/${b.patient.id}/gift-certificates/redeem`, { code: gc.code })).status, 404);
  assert.equal((await b.api.post(`/gift-certificates/${gc.id}/void`, { reason: 'x' })).status, 404);
  assert.equal((await b.api.post('/gift-certificates', { amount: 100, purchaser_patient_id: a.patient.id })).status, 404);
  const sale = (await a.api.post(`/patients/${a.patient.id}/retail-sales`, { product_id: product.id })).data.sale;
  assert.equal((await b.api.post(`/retail-sales/${sale.id}/void`, { reason: 'x' })).status, 404);
  // A dentist (billing:read only) can look but not sell.
  const dentist = await staff(a.api, 'dentist', 'iso');
  assert.equal((await dentist.post(`/patients/${a.patient.id}/retail-sales`, { product_id: product.id })).status, 403);
  assert.equal((await dentist.post('/gift-certificates', { amount: 100, purchaser_patient_id: a.patient.id })).status, 403);
  // The assistant can't sell, redeem or void without the person's OK on screen.
  const ai = h.client(a.token, { 'X-Acting-For': 'assistant' });
  assert.equal((await ai.post(`/patients/${a.patient.id}/retail-sales`, { product_id: product.id })).status, 428);
  assert.equal((await ai.post('/gift-certificates', { amount: 100, purchaser_patient_id: a.patient.id })).status, 428);
  assert.equal((await ai.post(`/patients/${a.patient.id}/gift-certificates/redeem`, { code: gc.code })).status, 428);
  assert.equal((await ai.post(`/retail-sales/${sale.id}/void`, { reason: 'x' })).status, 428);
  assert.equal((await ai.put('/retail/settings', { sales_tax_bp: 0 })).status, 428);
  const ok = await h.client(a.token, { 'X-Acting-For': 'assistant', 'X-Human-Approved': '1' }).post(`/patients/${a.patient.id}/retail-sales`, { product_id: product.id });
  assert.equal(ok.status, 201);
  // Idempotency-Key: the same request twice posts once.
  const keyed = h.client(a.token, { 'Idempotency-Key': `idem-sale-${Date.now()}` });
  const one = await keyed.post(`/patients/${a.patient.id}/retail-sales`, { product_id: product.id });
  const two = await keyed.post(`/patients/${a.patient.id}/retail-sales`, { product_id: product.id });
  assert.equal(two.headers.get('idempotent-replay'), 'true');
  assert.equal(one.data.sale.id, two.data.sale.id);
});

// Product sales and gift certificates are money on the ledger, but not dental production and not write-offs: every
// production and adjustment total leaves them out, and the day sheet and close show them on their own lines, so the
// payments (and the deposit) still reconcile.
test('retail sales and gift certificates stay out of production and write-offs; the day sheet shows them on their own lines', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const buyer = (await api.post('/patients', { first_name: 'Bea', last_name: 'Buyer', dob: '1970-01-01' })).data;
  await api.put('/retail/settings', { sales_tax_bp: 825 });
  const kit = (await api.post('/retail/products', { name: 'Kit', price: 10000 })).data;
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true });
  await api.post(`/patients/${patient.id}/adjustments`, { amount: -500, description: 'Courtesy', adjustment_type: 'Courtesy discount' });
  await api.post(`/patients/${patient.id}/payments`, { amount: 1000, method: 'cash' });
  const LIB = ['production-by-day', 'production-by-provider', 'adjustments-by-type', 'gross-vs-net-production', 'production-by-category'];
  const snap = async () => {
    const out = {
      dashboard: (await api.get('/dashboard')).data,
      production: (await api.get('/reports/production')).data,
      byProvider: (await api.get('/reports/collections-by-provider')).data.rows.filter((r) => r.id),
      adjustments: (await api.get('/reports/adjustments')).data.rows,
      day: (await api.get('/reports/daysheet')).data.totals,
      close: (await api.get(`/close?type=day&period=${new Date().toISOString().slice(0, 10)}`)).data.totals,
    };
    for (const id of LIB) out[id] = (await api.get(`/report-library/${id}`)).data;
    return out;
  };
  const before = await snap();

  // A kit sold (+$8.25 tax) and paid for in cash; a second one sold and voided; a $50 certificate bought by Bea and
  // $50 of it used against Jane's balance.
  await api.post(`/patients/${patient.id}/retail-sales`, { product_id: kit.id });
  await api.post(`/patients/${patient.id}/payments`, { amount: 10825, method: 'cash' });
  const oops = (await api.post(`/patients/${patient.id}/retail-sales`, { product_id: kit.id })).data.sale;
  await api.post(`/retail-sales/${oops.id}/void`, { reason: 'Rang up twice' });
  const gc = (await api.post('/gift-certificates', { amount: 5000, purchaser_patient_id: buyer.id, method: 'cash' })).data;
  await api.post(`/patients/${patient.id}/gift-certificates/redeem`, { code: gc.code, amount: 5000 });
  const after = await snap();

  // Dental production and adjustments: unchanged everywhere.
  assert.equal(after.dashboard.production, before.dashboard.production);
  assert.equal(after.dashboard.adjustments, before.dashboard.adjustments);
  assert.deepEqual(after.production.by_provider, before.production.by_provider);
  assert.deepEqual(after.production.by_day.map((d) => d.production), before.production.by_day.map((d) => d.production));
  assert.deepEqual(after.byProvider.map((r) => [r.production, r.adjustments]), before.byProvider.map((r) => [r.production, r.adjustments]), 'a certificate used is not a write-off on the dentist');
  assert.deepEqual(after.adjustments, before.adjustments, 'no "Sales tax" or gift certificate rows among adjustments');
  for (const k of ['production', 'adjustments']) {
    assert.equal(after.day[k], before.day[k], `day sheet ${k}`);
    assert.equal(after.close[k], before.close[k], `close ${k}`);
  }
  const dental = (t = {}) => Object.fromEntries(Object.entries(t).filter(([k]) => !/collect|payment/.test(k)));
  for (const id of LIB) assert.deepEqual(dental(after[id].totals), dental(before[id].totals), id);
  // Collections still include the money that came in, and the day sheet shows what it was for.
  assert.equal(after.day.patient_payments - before.day.patient_payments, 10825 + 5000);
  assert.equal(after.day.retail_sales, 10825, 'the voided sale nets out');
  assert.equal(after.day.retail_sales_tax, 825);
  assert.equal(after.day.gift_certificates_sold, 5000);
  assert.equal(after.day.gift_certificates_used, 5000);
  assert.equal(after.close.retail_sales, 10825);
  assert.equal(after.close.gift_certificates_sold, 5000);
  assert.equal(after.close.gift_certificates_used, 5000);
  assert.equal(after.close.net_collections - before.close.net_collections, 15825);
  const deposit = (await api.get('/reports/daysheet')).data.deposit;
  assert.equal(deposit.cash, 1000 + 10825 + 5000, 'the cash deposit is every cash payment, retail and certificates included');
});
