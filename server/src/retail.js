import { randomInt } from 'node:crypto';
import { HttpError } from './auth.js';
import { insert, audit, recorded, practiceNow, addMonths } from './util.js';
import { reverseEntry, patientBalance, checkPostingDate } from './services.js';
import { moveStock } from './inventory.js';
import { requireHuman } from './aiguard.js';
import { isManager } from './deposits.js';
import { SOLD, REDEEMED } from './ledgerkinds.js';

// Retail sales and gift certificates (docs/cash-handling.md §10). Both live on the one ledger:
//
//   Product sale      charge  +price×qty (retail_sale_id)            the patient owes it like any charge
//                     adjustment +tax, adjustment_type 'Sales tax'   when the practice charges sales tax
//   Gift cert sold    payment −amount on the buyer (their cash/card)  the money reaches the day sheet and deposit
//                     adjustment +amount 'Gift certificate sold'       … and is held for the certificate: the
//                                                                      buyer's balance doesn't move
//   Gift cert used    adjustment −amount 'Gift certificate redeemed'  pays down the patient's balance
//
// What a certificate still holds is the SUM of its live adjustment lines (sold − redeemed): never stored. The total of
// every certificate's balance is what the practice owes holders (the liability on the outstanding report). Nothing is
// edited or deleted: a sale, a certificate or a redemption is voided with reversing entries (reverseEntry), and the
// generic ledger void sends linked lines here so a sale's tax and stock, or a certificate's two lines, go together.

export { SOLD, REDEEMED };
export const SALES_TAX = 'Sales tax';
export const MAX_CERTIFICATE = 1_000_000; // $10,000: a typo of extra zeros is refused
// The federal CARD Act: a gift certificate can't expire sooner than five years after it's sold (states may forbid
// expiry altogether — hence "never" by default).
export const MIN_EXPIRY_MONTHS = 60;

const today = async (db, practiceId) => (await practiceNow(db, practiceId)).slice(0, 10);
export const taxOn = (subtotal, bp) => Math.round((subtotal * (Number(bp) || 0)) / 10000);
export const pct = (bp) => `${(Number(bp || 0) / 100).toFixed(Number(bp) % 100 ? 2 : 0)}%`;

// ---- Product sales ----
export async function sellProduct(db, req, patient, { productId, quantity = 1, clientKey = null }) {
  requireHuman('selling a product (posts a charge)');
  const pid = req.user.practice_id;
  const key = clientKey ? String(clientKey).slice(0, 80) : null;
  if (key) {
    const again = await db.get('SELECT * FROM retail_sales WHERE practice_id = ? AND client_key = ?', pid, key);
    if (again) {
      if (again.patient_id !== patient.id) throw new HttpError(409, 'That sale was already posted to another account');
      return { sale: again, repeated: true };
    }
  }
  const product = await db.get('SELECT * FROM retail_products WHERE id = ? AND practice_id = ?', Number(productId), pid);
  if (!product) throw new HttpError(404, 'Product not found');
  if (!product.active) throw new HttpError(400, `${product.name} isn't for sale any more (Settings → Products for sale)`);
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new HttpError(400, 'Quantity must be a whole number, 1–99');
  const bp = product.taxable ? (await db.get('SELECT sales_tax_bp FROM practices WHERE id = ?', pid)).sales_tax_bp || 0 : 0;
  const subtotal = product.price * qty;
  const tax = taxOn(subtotal, bp);
  const date = await checkPostingDate(db, pid, null);
  const day = await today(db, pid);
  const label = `${product.name}${qty > 1 ? ` × ${qty}` : ''}`;
  const sale = await db.tx(async () => {
    const id = await insert(db, 'retail_sales', {
      practice_id: pid, location_id: req.location_id ?? patient.location_id ?? null, patient_id: patient.id, product_id: product.id, quantity: qty, unit_price: product.price,
      subtotal, tax, tax_bp: bp, client_key: key, created_by: req.user.id,
    });
    const base = { practice_id: pid, patient_id: patient.id, location_id: req.location_id ?? null, entry_date: date, created_by: req.user.id, retail_sale_id: id };
    const charge = await insert(db, 'ledger_entries', { ...base, type: 'charge', amount: subtotal, description: `${label}${product.code ? ` (${product.code})` : ''}` });
    if (tax) await insert(db, 'ledger_entries', { ...base, type: 'adjustment', adjustment_type: SALES_TAX, amount: tax, description: `Sales tax ${pct(bp)} on ${label}` });
    if (product.inventory_item_id) {
      const item = await db.get('SELECT * FROM inventory_items WHERE id = ? AND practice_id = ?', product.inventory_item_id, pid);
      if (item) await moveStock(db, item, -qty, { reason: 'sold', note: `Sale #${id}`, userId: req.user.id, today: day });
    }
    await audit(db, req, 'retail.sale', 'retail_sales', id, { product: product.name, quantity: qty, subtotal, tax, charge_id: charge, patient_id: patient.id }, { patientId: patient.id });
    return db.get('SELECT * FROM retail_sales WHERE id = ?', id);
  });
  return { sale, repeated: false };
}

export async function voidSale(db, req, sale, reason) {
  requireHuman('voiding a product sale');
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw new HttpError(400, 'Give a reason for the void');
  if (sale.status === 'voided') throw new HttpError(409, 'That sale was already voided');
  const limit = (await db.get('SELECT adjustment_approval_limit FROM practices WHERE id = ?', sale.practice_id)).adjustment_approval_limit;
  if (limit != null && sale.subtotal + sale.tax > limit && req.user.role !== 'admin') throw new HttpError(403, `Voiding sales over $${(limit / 100).toFixed(2)} needs an administrator`, { approval_required: true });
  const date = await today(db, sale.practice_id);
  await db.tx(async () => {
    const marked = await recorded(db, 'retail_sales', sale.id, () => db.run("UPDATE retail_sales SET status = 'voided', voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ? AND status = 'posted'", req.user.id, why, sale.id));
    if (!marked.changes) throw new HttpError(409, 'That sale was already voided');
    const lines = await db.all('SELECT * FROM ledger_entries WHERE retail_sale_id = ? AND voided_at IS NULL AND reverses_id IS NULL', sale.id);
    for (const e of lines) await reverseEntry(db, e, { userId: req.user.id, reason: why, date });
    const product = await db.get('SELECT * FROM retail_products WHERE id = ?', sale.product_id);
    const item = product?.inventory_item_id ? await db.get('SELECT * FROM inventory_items WHERE id = ?', product.inventory_item_id) : null;
    if (item) await moveStock(db, item, sale.quantity, { reason: 'sale_voided', note: `Sale #${sale.id} voided`, userId: req.user.id });
    await audit(db, req, 'retail.void', 'retail_sales', sale.id, { reason: why, reversed: lines.map((e) => e.id), amount: sale.subtotal + sale.tax, patient_id: sale.patient_id }, { patientId: sale.patient_id, reason: why });
  });
  return db.get('SELECT * FROM retail_sales WHERE id = ?', sale.id);
}

// ---- Gift certificates ----
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: read out over the phone
const newCode = () => `GC-${Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
export const normalizeCode = (c) => {
  const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s ? `GC-${s.replace(/^GC/, '')}` : '';
};

// What a certificate holds now, and what has been taken from it: from its live ledger lines.
export async function certificateBalance(db, certId) {
  const row = await db.get(
    `SELECT COALESCE(SUM(CASE WHEN adjustment_type = ? THEN amount ELSE 0 END), 0) AS sold, COALESCE(SUM(CASE WHEN adjustment_type = ? THEN -amount ELSE 0 END), 0) AS redeemed
     FROM ledger_entries WHERE gift_certificate_id = ? AND type = 'adjustment' AND voided_at IS NULL AND reverses_id IS NULL`,
    SOLD, REDEEMED, certId,
  );
  return { sold: Number(row.sold), redeemed: Number(row.redeemed), balance: Number(row.sold) - Number(row.redeemed) };
}

export async function certificateView(db, cert, day) {
  const b = await certificateBalance(db, cert.id);
  const buyer = await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', cert.purchaser_patient_id);
  const expired = !!(cert.expires_on && day && cert.expires_on < day);
  return { ...cert, ...b, purchaser_name: buyer ? `${buyer.first_name} ${buyer.last_name}` : null, expired, usable: cert.status === 'active' && !expired && b.balance > 0 };
}

export async function sellCertificate(db, req, buyer, { amount, method, reference = null, recipientName = null, note = null, clientKey = null }) {
  requireHuman('selling a gift certificate (takes a payment)');
  const pid = req.user.practice_id;
  const key = clientKey ? String(clientKey).slice(0, 80) : null;
  if (key) {
    const again = await db.get('SELECT * FROM gift_certificates WHERE practice_id = ? AND client_key = ?', pid, key);
    if (again) return { cert: again, repeated: true };
  }
  const cents = Number(amount);
  if (!Number.isInteger(cents) || cents <= 0) throw new HttpError(400, 'Enter the certificate amount');
  if (cents > MAX_CERTIFICATE) throw new HttpError(400, 'Gift certificates are up to $10,000');
  const date = await checkPostingDate(db, pid, null);
  const months = (await db.get('SELECT gift_certificate_expiry_months FROM practices WHERE id = ?', pid)).gift_certificate_expiry_months;
  const recipient = recipientName ? String(recipientName).replace(/[\r\n]+/g, ' ').trim().slice(0, 120) || null : null;
  const cert = await db.tx(async () => {
    let id = null;
    let code = null;
    for (let i = 0; i < 5 && !id; i++) {
      code = newCode();
      if (await db.get('SELECT id FROM gift_certificates WHERE practice_id = ? AND code = ?', pid, code)) continue;
      id = await insert(db, 'gift_certificates', {
        practice_id: pid, location_id: req.location_id ?? null, code, amount: cents, purchaser_patient_id: buyer.id, recipient_name: recipient,
        note: note ? String(note).trim().slice(0, 300) || null : null, issued_on: date, expires_on: months ? addMonths(date, months) : null, client_key: key, created_by: req.user.id,
      });
    }
    if (!id) throw new HttpError(500, 'Could not make a unique certificate code — try again');
    const base = { practice_id: pid, patient_id: buyer.id, location_id: req.location_id ?? null, entry_date: date, created_by: req.user.id, gift_certificate_id: id };
    const pay = await insert(db, 'ledger_entries', { ...base, type: 'payment', amount: -cents, method, reference: reference ? String(reference).slice(0, 50) : null, description: `Gift certificate ${code} bought (${method.replace('_', ' ')})` });
    await insert(db, 'ledger_entries', { ...base, type: 'adjustment', adjustment_type: SOLD, amount: cents, description: `Gift certificate ${code}${recipient ? ` for ${recipient}` : ''} — held until it's used` });
    await audit(db, req, 'gift_certificate.sell', 'gift_certificates', id, { code, amount: cents, method, payment_id: pay, patient_id: buyer.id, expires_on: months ? addMonths(date, months) : null }, { patientId: buyer.id });
    return db.get('SELECT * FROM gift_certificates WHERE id = ?', id);
  });
  return { cert, repeated: false };
}

export async function redeemCertificate(db, req, patient, { code, amount = null }) {
  requireHuman('redeeming a gift certificate (pays a balance)');
  const pid = req.user.practice_id;
  const c = normalizeCode(code);
  if (!c) throw new HttpError(400, 'Type the certificate code', { missing: ['code'] });
  const cert = await db.get('SELECT * FROM gift_certificates WHERE practice_id = ? AND code = ?', pid, c);
  if (!cert) throw new HttpError(404, `No gift certificate ${c}`);
  const day = await today(db, pid);
  if (cert.status !== 'active') throw new HttpError(409, `Gift certificate ${c} was voided`);
  if (cert.expires_on && cert.expires_on < day) throw new HttpError(409, `Gift certificate ${c} expired on ${cert.expires_on}`);
  const date = await checkPostingDate(db, pid, null);
  return db.tx(async () => {
    // Takes the certificate for this redemption: a second one at the same moment waits here, then sees what's left.
    await db.run('UPDATE gift_certificates SET status = status WHERE id = ?', cert.id);
    const { balance } = await certificateBalance(db, cert.id);
    if (balance <= 0) throw new HttpError(409, `Gift certificate ${c} has been used up`);
    const owes = Math.max(0, Number(await patientBalance(db, pid, patient.id)));
    if (!owes) throw new HttpError(400, `${patient.first_name} doesn't owe anything right now — use the certificate when there's a balance`);
    // Never more than the certificate holds, nor more than the account owes (a certificate isn't cashed out as a credit).
    const most = Math.min(balance, owes);
    const cents = amount == null || amount === '' ? most : Number(amount);
    if (!Number.isInteger(cents) || cents <= 0) throw new HttpError(400, 'Enter the amount to use');
    if (cents > balance) throw new HttpError(400, `Gift certificate ${c} has $${(balance / 100).toFixed(2)} left`);
    if (cents > owes) throw new HttpError(400, `${patient.first_name} owes $${(owes / 100).toFixed(2)} — use no more than that`);
    const id = await insert(db, 'ledger_entries', {
      practice_id: pid, patient_id: patient.id, location_id: req.location_id ?? null, entry_date: date, created_by: req.user.id, gift_certificate_id: cert.id,
      type: 'adjustment', adjustment_type: REDEEMED, amount: -cents, description: `Gift certificate ${c} used`,
    });
    await audit(db, req, 'gift_certificate.redeem', 'gift_certificates', cert.id, { code: c, amount: cents, entry_id: id, patient_id: patient.id, left: balance - cents }, { patientId: patient.id });
    return { entry: await db.get('SELECT * FROM ledger_entries WHERE id = ?', id), cert: await certificateView(db, cert, day), balance: await patientBalance(db, pid, patient.id) };
  });
}

// Undoes one redemption: the certificate gets the amount back and the patient owes it again.
export async function voidRedemption(db, req, entry, reason) {
  requireHuman('voiding a gift certificate redemption');
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw new HttpError(400, 'Give a reason for the void');
  if (entry.adjustment_type !== REDEEMED || !entry.gift_certificate_id) throw new HttpError(400, 'That line is not a gift certificate redemption');
  const cert = await db.get('SELECT * FROM gift_certificates WHERE id = ?', entry.gift_certificate_id);
  const id = await db.tx(async () => {
    const rid = await reverseEntry(db, entry, { userId: req.user.id, reason: why, date: await today(db, entry.practice_id) });
    await audit(db, req, 'gift_certificate.redemption_void', 'gift_certificates', cert.id, { code: cert.code, amount: -entry.amount, entry_id: entry.id, reversal_id: rid, patient_id: entry.patient_id }, { patientId: entry.patient_id, reason: why });
    return rid;
  });
  return { reversal_id: id, cert: await certificateView(db, cert, await today(db, entry.practice_id)), balance: await patientBalance(db, entry.practice_id, entry.patient_id) };
}

// Voids a certificate that was sold by mistake or returned: its sale lines are reversed (the buyer's payment and the
// held amount), so give the money back the way it was paid. Only while nothing has been redeemed from it.
export async function voidCertificate(db, req, cert, reason) {
  requireHuman('voiding a gift certificate');
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw new HttpError(400, 'Give a reason for the void');
  if (cert.status === 'voided') throw new HttpError(409, 'That certificate was already voided');
  const date = await today(db, cert.practice_id);
  await db.tx(async () => {
    await db.run('UPDATE gift_certificates SET status = status WHERE id = ?', cert.id);
    const { redeemed } = await certificateBalance(db, cert.id);
    if (redeemed > 0) throw new HttpError(409, `$${(redeemed / 100).toFixed(2)} of it has been used — void those redemptions on the patients' ledgers first`);
    const marked = await recorded(db, 'gift_certificates', cert.id, () => db.run("UPDATE gift_certificates SET status = 'voided', voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ? AND status = 'active'", req.user.id, why, cert.id));
    if (!marked.changes) throw new HttpError(409, 'That certificate was already voided');
    const lines = await db.all('SELECT * FROM ledger_entries WHERE gift_certificate_id = ? AND voided_at IS NULL AND reverses_id IS NULL', cert.id);
    for (const e of lines) await reverseEntry(db, e, { userId: req.user.id, reason: why, date });
    await audit(db, req, 'gift_certificate.void', 'gift_certificates', cert.id, { code: cert.code, amount: cert.amount, reversed: lines.map((e) => e.id), reason: why, patient_id: cert.purchaser_patient_id }, { patientId: cert.purchaser_patient_id, reason: why });
  });
  return db.get('SELECT * FROM gift_certificates WHERE id = ?', cert.id);
}

// The ledger's own "Void" on a line that belongs to a sale or certificate does the whole thing (null otherwise).
export async function voidLinkedEntry(db, req, entry, reason) {
  if (entry.retail_sale_id) {
    const sale = await db.get('SELECT * FROM retail_sales WHERE id = ?', entry.retail_sale_id);
    return { sale: await voidSale(db, req, sale, reason) };
  }
  if (entry.gift_certificate_id) {
    if (entry.adjustment_type === REDEEMED) return voidRedemption(db, req, entry, reason);
    if (!isManager(req.user)) throw new HttpError(403, 'Voiding a gift certificate needs a manager — ask one to do it', { manager_required: true });
    const cert = await db.get('SELECT * FROM gift_certificates WHERE id = ?', entry.gift_certificate_id);
    return { cert: await voidCertificate(db, req, cert, reason) };
  }
  return null;
}
