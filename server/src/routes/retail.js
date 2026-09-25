import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, update, change, insert, practiceNow, toCents, toCsv } from '../util.js';
import { patientBalance } from '../services.js';
import { isManager } from '../deposits.js';
import { PdfDoc } from '../pdf.js';
import { PAYMENT_METHODS } from './billing.js';
import {
  sellProduct, voidSale, sellCertificate, redeemCertificate, voidRedemption, voidCertificate, certificateView, normalizeCode, taxOn, pct,
  MIN_EXPIRY_MONTHS, REDEEMED,
} from '../retail.js';

// Products for sale and gift certificates (docs/cash-handling.md §10; actions A176, A184). The money rules
// are in ../retail.js; this is the HTTP side: permissions, validation, and the lists and reports.
const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only administrators change products, prices and sales tax')));

export default function retailRoutes({ db }) {
  const r = Router();
  const today = async (req) => (await practiceNow(db, req.user.practice_id)).slice(0, 10);
  const patientOr404 = (req) => findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');

  // ---- Settings: sales tax and gift certificate expiry ----
  r.get('/retail/settings', requirePermission('billing:read'), async (req, res) => {
    const p = await db.get('SELECT sales_tax_bp, gift_certificate_expiry_months FROM practices WHERE id = ?', req.user.practice_id);
    res.json({ ...p, min_expiry_months: MIN_EXPIRY_MONTHS });
  });
  r.put('/retail/settings', requireAdmin, async (req, res) => {
    const row = {};
    if ('sales_tax_bp' in (req.body || {})) {
      const bp = Number(req.body.sales_tax_bp);
      if (!Number.isInteger(bp) || bp < 0 || bp > 2000) throw new HttpError(400, 'Sales tax must be between 0% and 20%');
      row.sales_tax_bp = bp;
    }
    if ('gift_certificate_expiry_months' in (req.body || {})) {
      const m = req.body.gift_certificate_expiry_months;
      if (m === null || m === '' || m === 0) row.gift_certificate_expiry_months = null;
      else if (!Number.isInteger(Number(m)) || Number(m) < MIN_EXPIRY_MONTHS || Number(m) > 600) throw new HttpError(400, `Gift certificates can't expire sooner than ${MIN_EXPIRY_MONTHS / 12} years after they're sold (federal CARD Act) — leave it blank for never`);
      else row.gift_certificate_expiry_months = Number(m);
    }
    await change(db, 'practices', req.user.practice_id, row);
    await audit(db, req, 'retail.settings', 'practices', req.user.practice_id, row);
    res.json(await db.get('SELECT sales_tax_bp, gift_certificate_expiry_months FROM practices WHERE id = ?', req.user.practice_id));
  });

  // ---- Products ----
  const PRODUCT_SELECT = 'SELECT rp.*, i.name AS inventory_name, i.on_hand FROM retail_products rp LEFT JOIN inventory_items i ON i.id = rp.inventory_item_id';
  const productRow = async (req, body, partial) => {
    const row = {};
    if (!partial || 'name' in body) {
      row.name = String(body.name ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
      if (!row.name) throw new HttpError(400, 'Name the product', { missing: ['name'] });
    }
    if (!partial || 'price' in body) {
      row.price = toCents(body.price, 'Price');
      if (row.price <= 0 || row.price > 1_000_000) throw new HttpError(400, 'Price must be more than $0 and up to $10,000');
    }
    if ('code' in body) row.code = String(body.code ?? '').trim().slice(0, 30) || null;
    if ('taxable' in body) row.taxable = body.taxable ? 1 : 0;
    if ('active' in body) row.active = body.active ? 1 : 0;
    if ('sort' in body) row.sort = Number(body.sort) || 0;
    if ('inventory_item_id' in body) {
      row.inventory_item_id = body.inventory_item_id ? (await findOr404(db, 'inventory_items', body.inventory_item_id, req.user.practice_id, 'Stock item')).id : null;
    }
    return row;
  };
  r.get('/retail/products', requirePermission('billing:read'), async (req, res) => {
    const all = req.query.all === '1';
    const bp = (await db.get('SELECT sales_tax_bp FROM practices WHERE id = ?', req.user.practice_id)).sales_tax_bp || 0;
    const rows = await db.all(`${PRODUCT_SELECT} WHERE rp.practice_id = ?${all ? '' : ' AND rp.active = 1'} ORDER BY rp.active DESC, rp.sort, rp.name`, req.user.practice_id);
    res.json(rows.map((p) => ({ ...p, tax: p.taxable ? taxOn(p.price, bp) : 0, tax_rate: pct(bp) })));
  });
  r.post('/retail/products', requireAdmin, async (req, res) => {
    const row = await productRow(req, req.body || {}, false);
    if (await db.get('SELECT id FROM retail_products WHERE practice_id = ? AND name = ?', req.user.practice_id, row.name)) throw new HttpError(409, `There's already a product called ${row.name}`);
    const id = await insert(db, 'retail_products', { taxable: 1, ...row, practice_id: req.user.practice_id });
    await audit(db, req, 'retail.product_create', 'retail_products', id, row, { after: row });
    res.status(201).json(await db.get(`${PRODUCT_SELECT} WHERE rp.id = ?`, id));
  });
  // Price changes are kept (before → after) like any fee change. Products are switched off, never removed.
  r.put('/retail/products/:pid', requireAdmin, async (req, res) => {
    const p = await findOr404(db, 'retail_products', req.params.pid, req.user.practice_id, 'Product');
    const row = await productRow(req, req.body || {}, true);
    if (row.name && row.name !== p.name && await db.get('SELECT id FROM retail_products WHERE practice_id = ? AND name = ? AND id != ?', req.user.practice_id, row.name, p.id)) throw new HttpError(409, `There's already a product called ${row.name}`);
    await update(db, 'retail_products', p.id, req.user.practice_id, row);
    await audit(db, req, 'retail.product_change', 'retail_products', p.id, { fields: Object.keys(row) });
    res.json(await db.get(`${PRODUCT_SELECT} WHERE rp.id = ?`, p.id));
  });

  // ---- Selling a product (checkout or the patient's ledger) ----
  r.post('/patients/:id/retail-sales', requirePermission('billing:write'), async (req, res) => {
    const patient = await patientOr404(req);
    if (!req.body?.product_id) throw new HttpError(400, 'Choose the product', { missing: ['product_id'] });
    const { sale, repeated } = await sellProduct(db, req, patient, { productId: req.body.product_id, quantity: req.body.quantity ?? 1, clientKey: req.body.client_key });
    res.status(repeated ? 200 : 201).json({ sale, repeated, balance: await patientBalance(db, req.user.practice_id, patient.id) });
  });
  r.get('/patients/:id/retail-sales', requirePermission('billing:read'), async (req, res) => {
    const patient = await patientOr404(req);
    res.json(await db.all('SELECT s.*, p.name AS product_name FROM retail_sales s JOIN retail_products p ON p.id = s.product_id WHERE s.practice_id = ? AND s.patient_id = ? ORDER BY s.id DESC', req.user.practice_id, patient.id));
  });
  r.post('/retail-sales/:sid/void', requirePermission('billing:write'), async (req, res) => {
    const sale = await findOr404(db, 'retail_sales', req.params.sid, req.user.practice_id, 'Sale');
    const out = await voidSale(db, req, sale, req.body?.reason);
    res.status(201).json({ sale: out, balance: await patientBalance(db, req.user.practice_id, sale.patient_id) });
  });

  // ---- Gift certificates ----
  // The buyer is someone on file (the active patient, usually): the payment is theirs.
  r.post('/gift-certificates', requirePermission('billing:write'), async (req, res) => {
    const b = req.body || {};
    const buyer = await findOr404(db, 'patients', b.purchaser_patient_id, req.user.practice_id, 'Buyer');
    const method = b.method || 'credit_card';
    if (!PAYMENT_METHODS.includes(method)) throw new HttpError(400, `Payment method must be one of: ${PAYMENT_METHODS.join(', ')}`);
    const { cert, repeated } = await sellCertificate(db, req, buyer, {
      amount: toCents(b.amount, 'Amount'), method, reference: b.reference, recipientName: b.recipient_name, note: b.note, clientKey: b.client_key,
    });
    res.status(repeated ? 200 : 201).json({ ...(await certificateView(db, cert, await today(req))), repeated });
  });
  // Balance lookup by code (a holder at the desk, or on the phone).
  r.get('/gift-certificates/lookup', requirePermission('billing:read'), async (req, res) => {
    const code = normalizeCode(req.query.code);
    const cert = code && await db.get('SELECT * FROM gift_certificates WHERE practice_id = ? AND code = ?', req.user.practice_id, code);
    if (!cert) throw new HttpError(404, `No gift certificate ${code || ''}`.trim());
    await audit(db, req, 'gift_certificate.lookup', 'gift_certificates', cert.id, { code });
    res.json(await certificateView(db, cert, await today(req)));
  });
  // Outstanding certificates (what the practice owes holders) and everything sold/used in a period; ?format=csv.
  r.get('/gift-certificates', requirePermission('billing:read'), async (req, res) => {
    const day = await today(req);
    const rows = [];
    for (const c of await db.all('SELECT * FROM gift_certificates WHERE practice_id = ? ORDER BY id DESC LIMIT 2000', req.user.practice_id)) rows.push(await certificateView(db, c, day));
    const outstanding = rows.filter((c) => c.status === 'active' && c.balance > 0);
    const shown = req.query.status === 'all' ? rows : req.query.status === 'used' ? rows.filter((c) => c.status === 'active' && c.balance <= 0) : req.query.status === 'voided' ? rows.filter((c) => c.status === 'voided') : outstanding;
    const summary = {
      outstanding_count: outstanding.length, outstanding_total: outstanding.reduce((s, c) => s + c.balance, 0),
      expired_total: outstanding.filter((c) => c.expired).reduce((s, c) => s + c.balance, 0), sold_total: rows.filter((c) => c.status === 'active').reduce((s, c) => s + c.sold, 0),
      redeemed_total: rows.reduce((s, c) => s + c.redeemed, 0),
    };
    if (req.query.format === 'csv') {
      await audit(db, req, 'gift_certificate.report', 'gift_certificates', null, { rows: shown.length });
      const csv = toCsv(shown, [['Code', (c) => c.code], ['Sold', (c) => c.issued_on], ['Bought by', (c) => c.purchaser_name], ['For', (c) => c.recipient_name], ['Amount', (c) => (c.amount / 100).toFixed(2)],
        ['Used', (c) => (c.redeemed / 100).toFixed(2)], ['Left', (c) => (c.balance / 100).toFixed(2)], ['Expires', (c) => c.expires_on || 'never'], ['Status', (c) => (c.status === 'voided' ? 'voided' : c.expired ? 'expired' : c.balance > 0 ? 'outstanding' : 'used up')]]);
      return res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="gift-certificates-${day}.csv"` }).send(csv);
    }
    res.json({ summary, rows: shown });
  });
  r.get('/gift-certificates/:gid', requirePermission('billing:read'), async (req, res) => {
    const cert = await findOr404(db, 'gift_certificates', req.params.gid, req.user.practice_id, 'Gift certificate');
    const lines = await db.all(`SELECT l.id, l.patient_id, l.type, l.amount, l.adjustment_type, l.entry_date, l.voided_at, l.description, p.first_name, p.last_name
      FROM ledger_entries l JOIN patients p ON p.id = l.patient_id WHERE l.gift_certificate_id = ? ORDER BY l.id`, cert.id);
    res.json({ ...(await certificateView(db, cert, await today(req))), lines });
  });
  // A printable certificate to hand over: code, amount, who it's for, expiry. Printing it is audited.
  r.get('/gift-certificates/:gid/certificate.pdf', requirePermission('billing:read'), async (req, res) => {
    const cert = await findOr404(db, 'gift_certificates', req.params.gid, req.user.practice_id, 'Gift certificate');
    const v = await certificateView(db, cert, await today(req));
    const pr = await db.get('SELECT name, phone, address, city, state, zip FROM practices WHERE id = ?', req.user.practice_id);
    const doc = new PdfDoc({ pageNumbers: false });
    doc.space(40);
    doc.text(pr.name, { size: 20, bold: true });
    doc.text([pr.address, [pr.city, pr.state, pr.zip].filter(Boolean).join(' '), pr.phone].filter(Boolean).join(' · '), { size: 10 });
    doc.space(30);
    doc.text('Gift certificate', { size: 28, bold: true });
    doc.space(10);
    if (cert.recipient_name) doc.text(`For ${cert.recipient_name}`, { size: 16 });
    doc.text(`Value: $${(cert.amount / 100).toFixed(2)}${v.redeemed ? ` ($${(v.balance / 100).toFixed(2)} left)` : ''}`, { size: 16 });
    doc.space(10);
    doc.text(`Certificate code: ${cert.code}`, { size: 14, bold: true });
    doc.text(`Issued ${cert.issued_on} · ${cert.expires_on ? `Use by ${cert.expires_on}` : 'Does not expire'}`, { size: 11 });
    doc.space(20);
    doc.text('Good toward dental care and products at our office. Not redeemable for cash except where the law requires. Keep this code safe: anyone with it can use the certificate.', { size: 9, color: [0.35, 0.38, 0.45] });
    if (cert.status === 'voided') doc.text('VOID', { size: 40, bold: true, color: [0.8, 0.1, 0.1] });
    await audit(db, req, 'gift_certificate.print', 'gift_certificates', cert.id, { code: cert.code });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="gift-certificate-${cert.code}.pdf"` }).send(doc.toBuffer());
  });
  r.post('/patients/:id/gift-certificates/redeem', requirePermission('billing:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const amount = req.body?.amount == null || req.body.amount === '' ? null : toCents(req.body.amount, 'Amount');
    res.status(201).json(await redeemCertificate(db, req, patient, { code: req.body?.code, amount }));
  });
  r.post('/gift-certificates/redemptions/:eid/void', requirePermission('billing:write'), async (req, res) => {
    const entry = await findOr404(db, 'ledger_entries', req.params.eid, req.user.practice_id, 'Redemption');
    if (entry.adjustment_type !== REDEEMED || entry.voided_at) throw new HttpError(409, entry.voided_at ? 'Already voided' : 'That line is not a gift certificate redemption');
    res.status(201).json(await voidRedemption(db, req, entry, req.body?.reason));
  });
  // Money goes back to the buyer: a manager's job, like a refund.
  r.post('/gift-certificates/:gid/void', requirePermission('billing:write'), async (req, res) => {
    if (!isManager(req.user)) throw new HttpError(403, 'Voiding a gift certificate needs a manager — ask one to do it', { manager_required: true });
    const cert = await findOr404(db, 'gift_certificates', req.params.gid, req.user.practice_id, 'Gift certificate');
    res.status(201).json(await voidCertificate(db, req, cert, req.body?.reason));
  });
  return r;
}
