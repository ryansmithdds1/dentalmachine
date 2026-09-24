import { randomInt } from 'node:crypto';
import { HttpError } from './auth.js';
import { insert, audit, practiceNow } from './util.js';
import { pendingInsurance } from './services.js';
import { raiseIssue, resolveIssue, failed } from './issues.js';
import { autoReceipt, sendReceipt } from './receipts.js';

// Patient portal 2.0 and "Pay my bill" (PT1–PT4, docs/workflows/specs/PT-portal.md): the household account in
// plain numbers, paying it (card, bank/ACH, Apple Pay / Google Pay through Stripe's hosted page, a saved card),
// and the per-account code printed on statements that finds the bill from the practice's website.
//
// Money rules kept here:
// - Every online payment is a payment_requests row first (session_id = the processor's checkout/charge id) and is
//   posted to the ledger only by postOnlinePayment, which flips that row to 'paid' before posting — so a webhook
//   replay, a patient coming back from Stripe and a double click all post it once.
// - The ledger reference is the processor's payment id (pi_… / sbx_pi_…), which daily reconciliation matches.
// - Card and bank numbers never reach this server with Stripe (hosted pages). Sandbox mode accepts only the
//   published test numbers.

// ---- Schema (the lines for db.js: the table at the end of SCHEMA) ----
export const BILLPAY_TABLES = [
  `CREATE TABLE IF NOT EXISTS billpay_codes (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  code TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, code)
);`,
  'CREATE INDEX IF NOT EXISTS idx_billpay_codes_patient ON billpay_codes(practice_id, patient_id);',
];

// ---- Statement codes ----
// Ten characters from an alphabet without look-alikes (no 0/O, 1/I/L): 31^10 ≈ 8×10^14 codes, shown as
// "K7QM4-XPD2R". One live code per guarantor (the account); staff can replace it (the old one stops working).
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
export const formatCode = (c) => (c ? `${c.slice(0, 5)}-${c.slice(5)}` : null);
const newCode = () => Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

// Until the table is in db.js (see BILLPAY_TABLES) statements carry on without a code instead of failing.
let hasTable = null;
async function tableReady(db) {
  if (hasTable) return true;
  try {
    await db.get('SELECT id FROM billpay_codes WHERE id = 0');
    hasTable = true;
  } catch {
    hasTable = false;
  }
  return hasTable;
}
export const resetTableCheck = () => { hasTable = null; };

export const guarantorIdOf = (p) => p.guarantor_id || p.id;

// The account's live code, made the first time a statement (or the office) asks for it.
export async function payCodeFor(db, practiceId, guarantorId, { create = true } = {}) {
  if (!(await tableReady(db))) return null;
  const live = await db.get('SELECT code FROM billpay_codes WHERE practice_id = ? AND patient_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1', practiceId, guarantorId);
  if (live || !create) return live?.code ?? null;
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    try {
      const id = await insert(db, 'billpay_codes', { practice_id: practiceId, patient_id: guarantorId, code });
      await audit(db, { user: { practice_id: practiceId, id: null } }, 'billpay_code.create', 'billpay_codes', id, null, { patientId: guarantorId });
      return code;
    } catch (err) {
      if (!/unique|duplicate/i.test(String(err.message))) throw err;
    }
  }
  throw new Error('Could not make a unique statement code');
}

// Replaces the account's code (lost statement, sent to the wrong address): the old one stops working.
export async function rotatePayCode(db, practiceId, guarantorId) {
  if (!(await tableReady(db))) throw new HttpError(501, 'Statement codes aren’t set up on this server yet');
  await db.run("UPDATE billpay_codes SET revoked_at = datetime('now') WHERE practice_id = ? AND patient_id = ? AND revoked_at IS NULL", practiceId, guarantorId);
  return payCodeFor(db, practiceId, guarantorId);
}

export async function accountByCode(db, practiceId, code) {
  const c = normalizeCode(code);
  if (c.length !== 10 || !(await tableReady(db))) return null;
  const row = await db.get('SELECT patient_id FROM billpay_codes WHERE practice_id = ? AND code = ? AND revoked_at IS NULL', practiceId, c);
  return row ? db.get("SELECT * FROM patients WHERE id = ? AND practice_id = ? AND status != 'archived'", row.patient_id, practiceId) : null;
}

// ---- The account in numbers (always from the ledger) ----
export async function householdIds(db, practiceId, guarantorId) {
  return (await db.all("SELECT id FROM patients WHERE practice_id = ? AND (id = ? OR guarantor_id = ?) AND status != 'archived'", practiceId, guarantorId, guarantorId)).map((r) => r.id);
}

// balance: SUM of the ledger. pending: what insurance is still expected to pay or write off.
// your_portion: what the patient owes now. max_payment: what they can pay online (the balance; never a credit).
export async function accountSummary(db, practiceId, ids) {
  if (!ids.length) return { balance: 0, pending_insurance: 0, pending_write_off: 0, your_portion: 0, credit: 0, max_payment: 0 };
  const L = ids.map(() => '?').join(',');
  const balance = Number((await db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE practice_id = ? AND patient_id IN (${L})`, practiceId, ...ids)).n);
  const pending = await pendingInsurance(db, practiceId, ids);
  return {
    balance, pending_insurance: pending.insurance, pending_write_off: pending.write_off,
    your_portion: Math.max(0, balance - pending.total), credit: balance < 0 ? -balance : 0, max_payment: Math.max(0, balance),
  };
}

// ---- Needs attention for billing ----
const issueKey = (guarantorId) => `online-pay:${guarantorId}`;
export async function paymentFailed(db, { practiceId, payer, amount, reason, source }) {
  await raiseIssue(db, {
    practiceId, kind: 'payment', key: issueKey(payer.id), role: 'billing', patientId: payer.id, entity: 'patients', entityId: payer.id,
    title: `${payer.first_name} ${payer.last_name} tried to pay $${(amount / 100).toFixed(2)} online and it didn’t go through`,
    detail: `${reason} (${source === 'billpay' ? 'Pay my bill page' : 'patient portal'})`,
  });
}
export const paymentWorked = (db, practiceId, payerId) => resolveIssue(db, practiceId, issueKey(payerId), 'Resolved: the patient’s next online payment went through');

// What the patient sees when a payment doesn't go through: never the processor's jargon, never blame.
export function kindError(out, practice, lang = 'en') {
  const phone = practice.phone || (lang === 'es' ? 'la oficina' : 'the office');
  if (out.ambiguous || out.processor) {
    return new HttpError(503, lang === 'es'
      ? `No pudimos completar el pago en este momento y no se le cobró. Inténtelo de nuevo en unos minutos o llame al ${phone}.`
      : `We couldn’t finish the payment just now, and you haven’t been charged. Please try again in a few minutes or call ${phone}.`);
  }
  return Object.assign(new HttpError(402, lang === 'es'
    ? `El pago no se aprobó (${out.reason}). No se le cobró. Pruebe con otra tarjeta o cuenta, o llame al ${phone}.`
    : `That payment wasn’t approved (${out.reason}). You haven’t been charged. Please try another card or account, or call ${phone}.`), { details: { declined: true } });
}

// ---- Posting ----
// session: { id, payment_status, amount_total, payment_intent, metadata } — a Stripe Checkout session, or the same
// shape for a sandbox or saved-card charge. Posts once: the payment_requests row is flipped to 'paid' first, in the
// same transaction, so any second delivery finds nothing to do. Returns the ledger entry id, or null.
export async function postOnlinePayment(db, session) {
  if (session.payment_status !== 'paid') return null;
  return db.tx(async () => {
    const flipped = await db.run("UPDATE payment_requests SET status = 'paid', paid_at = datetime('now') WHERE session_id = ? AND status <> 'paid'", session.id);
    if (!flipped.changes) return null; // unknown session or already applied
    const pr = await db.get('SELECT * FROM payment_requests WHERE session_id = ?', session.id);
    const md = session.metadata || {};
    const ach = md.pay_method === 'ach';
    const where = md.source === 'billpay' ? ' — Pay my bill' : md.source === 'portal' ? ' — patient portal' : '';
    const entryId = await insert(db, 'ledger_entries', {
      practice_id: pr.practice_id, patient_id: pr.patient_id, type: 'payment', amount: -session.amount_total,
      description: `${ach ? 'Online bank payment (ACH)' : 'Online card payment'}${where}${md.card_label ? ` (${md.card_label})` : ''}`,
      method: ach ? 'ach' : 'credit_card', reference: session.payment_intent || session.id,
      entry_date: (await practiceNow(db, pr.practice_id)).slice(0, 10),
    });
    await db.run('UPDATE payment_requests SET ledger_entry_id = ? WHERE id = ?', entryId, pr.id);
    await audit(db, { user: { practice_id: pr.practice_id, id: null } }, 'payment.online', 'ledger_entries', entryId, { amount: session.amount_total, source: md.source || null }, { patientId: pr.patient_id });
    return entryId;
  });
}

// After a payment posted (by a webhook, the patient coming back from Stripe, or a sandbox/saved-card charge):
// the receipt, a card saved for next time when the patient asked, and the billing work item closed.
export async function afterOnlinePayment(db, payments, messenger, session, entryId) {
  const pr = await db.get('SELECT * FROM payment_requests WHERE session_id = ?', session.id);
  if (!pr) return;
  const md = session.metadata || {};
  if (md.save_card === '1' && payments?.paymentMethodOf && session.payment_intent) {
    try {
      const pm = await payments.paymentMethodOf(session.payment_intent);
      if (pm?.type === 'card' && !(await db.get('SELECT id FROM payment_methods WHERE payment_method_id = ? AND removed_at IS NULL', pm.id))) {
        const id = await insert(db, 'payment_methods', {
          practice_id: pr.practice_id, patient_id: pr.patient_id, provider: 'stripe', customer_id: pm.customer, payment_method_id: pm.id,
          brand: pm.brand, last4: pm.last4, exp_month: pm.exp_month, exp_year: pm.exp_year,
        });
        await audit(db, { user: { practice_id: pr.practice_id, id: null } }, 'card.saved', 'payment_methods', id, { source: md.source || 'portal' }, { patientId: pr.patient_id });
      }
    } catch (err) {
      await failed(db, { practiceId: pr.practice_id, kind: 'payment', key: `save-card:${pr.patient_id}`, role: 'billing', patientId: pr.patient_id, title: 'A patient paid online but their card couldn’t be saved for next time' })(err);
    }
  }
  await paymentWorked(db, pr.practice_id, pr.patient_id);
  if (!entryId) return;
  const practice = await db.get('SELECT auto_receipts FROM practices WHERE id = ?', pr.practice_id);
  if (practice?.auto_receipts) await autoReceipt(db, messenger, entryId);
  else if (md.receipt === '1' && messenger) {
    await sendReceipt(db, messenger, { entryId, practiceId: pr.practice_id, channel: 'email' })
      .catch(failed(db, { practiceId: pr.practice_id, kind: 'message', key: `receipt:${entryId}`, role: 'billing', patientId: pr.patient_id, title: 'An online payment receipt couldn’t be emailed' }));
  }
}

// ---- Taking a payment ----
// One charge at a time per account (two tabs, a double click without an Idempotency-Key): a card charge already
// under way for this account (a sandbox or saved-card charge not yet answered) turns the second one away.
// Stripe's hosted pages aren't counted (they stay open while the patient types), nor finished attempts.
export async function oneAtATime(db, payerId) {
  const since = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const busy = await db.get("SELECT id FROM payment_requests WHERE patient_id = ? AND status = 'pending' AND (session_id LIKE 'sbx_cs_%' OR session_id LIKE 'off_cs_%') AND created_at > ?", payerId, since);
  if (busy) throw new HttpError(409, 'A payment for this account is already going through — wait a moment and check before trying again');
}

// Validates the amount against the household's ledger balance (patients pay what's owed, not more).
export async function checkAmount(db, practiceId, payer, amount) {
  if (!Number.isSafeInteger(amount) || amount < 50) throw new HttpError(400, 'Enter an amount of at least $0.50');
  const { max_payment: max } = await accountSummary(db, practiceId, await householdIds(db, practiceId, payer.id));
  if (amount > max) throw new HttpError(400, max > 0 ? `The most you can pay online is $${(max / 100).toFixed(2)}` : 'There is nothing to pay right now');
  return max;
}

// Starts or makes a payment for a guarantor's account.
//   how: 'saved' (card on file: charged now), 'new' (Stripe: a hosted Checkout page — card, Apple Pay / Google Pay,
//        or bank; sandbox: a test card or bank number, charged now)
// Returns { paid: true, entry_id, amount } or { url } (Stripe's page) — or throws a kind 402/503.
export async function takePayment(db, payments, messenger, {
  practice, payer, amount, how = 'new', method = 'card', saveCard = false, cardId = null, sandbox = {}, receipt = false,
  source, lang = 'en', successUrl, cancelUrl, requestKey = null,
}) {
  if (!payments?.enabled) throw new HttpError(409, `Online payments aren’t available — please call ${practice.phone || 'the office'}`);
  if (!['card', 'ach'].includes(method)) throw new HttpError(400, 'method must be card or ach');
  if (method === 'ach' && !achEnabled(payments)) throw new HttpError(400, 'Bank payments aren’t available online — please pay by card');
  await checkAmount(db, practice.id, payer, amount);
  await oneAtATime(db, payer.id);
  const md = { source, practice_id: String(practice.id), patient_id: String(payer.id), pay_method: how === 'saved' ? 'card' : method, ...(receipt ? { receipt: '1' } : {}), ...(saveCard ? { save_card: '1' } : {}) };
  const rand = `${Date.now().toString(36)}${randomInt(1e9).toString(36)}`;

  // A card on file: charged now, off-session.
  if (how === 'saved') {
    const card = await db.get('SELECT * FROM payment_methods WHERE id = ? AND practice_id = ? AND patient_id = ? AND removed_at IS NULL', Number(cardId), practice.id, payer.id);
    if (!card) throw new HttpError(404, 'That card isn’t on file any more');
    const sessionId = `off_cs_${rand}`;
    const prId = await insert(db, 'payment_requests', { practice_id: practice.id, patient_id: payer.id, amount, provider: payments.mode, session_id: sessionId });
    const out = await payments.charge({
      method: card, amount, description: `${practice.name} account payment`, idempotencyKey: `online-pay-${requestKey || prId}`,
      metadata: { payment_request_id: prId, source, patient_id: payer.id },
    });
    return settleNow(db, payments, messenger, { practice, payer, amount, prId, sessionId, out, md: { ...md, save_card: undefined, card_label: `${card.brand || 'card'} •••• ${card.last4}` }, source, lang });
  }

  // Sandbox: the published test numbers only (4242… approves, …0002 declines; bank 000123456789 approves,
  // 000111111116 is refused), charged straight away.
  if (payments.mode === 'sandbox') {
    const sessionId = `sbx_cs_${rand}`;
    const test = payments.sandboxPay({ method, number: method === 'ach' ? sandbox.account_number : sandbox.card_number, amount });
    const prId = await insert(db, 'payment_requests', { practice_id: practice.id, patient_id: payer.id, amount, provider: 'sandbox', session_id: sessionId });
    const res = await settleNow(db, payments, messenger, {
      practice, payer, amount, prId, sessionId, out: test, md: { ...md, save_card: undefined, card_label: test.last4 ? `${test.brand} •••• ${test.last4}` : undefined }, source, lang,
    });
    if (saveCard && method === 'card') {
      const id = await insert(db, 'payment_methods', {
        practice_id: practice.id, patient_id: payer.id, provider: 'sandbox', brand: test.brand, last4: test.last4, exp_month: 12, exp_year: new Date().getUTCFullYear() + 3,
      });
      await audit(db, { user: { practice_id: practice.id, id: null } }, 'card.saved', 'payment_methods', id, { source }, { patientId: payer.id });
      res.card_saved = true;
    }
    return res;
  }

  // Stripe: its hosted page (card with Apple Pay / Google Pay / Link, or a US bank account). The payment posts
  // from the webhook (or when the patient comes back, whichever is first).
  const prId = await insert(db, 'payment_requests', { practice_id: practice.id, patient_id: payer.id, amount, provider: 'stripe' });
  let session;
  try {
    session = await payments.checkout({
      customerId: saveCard || payer.stripe_customer_id ? await payments.ensureCustomer(db, payer) : null,
      amount, description: `${practice.name} - account payment`, method, saveCard: saveCard && method === 'card',
      metadata: { ...md, payment_request_id: String(prId) }, successUrl, cancelUrl, idempotencyKey: `online-checkout-${requestKey || prId}`,
    });
  } catch (err) {
    await db.run("UPDATE payment_requests SET status = 'cancelled' WHERE id = ?", prId);
    await paymentFailed(db, { practiceId: practice.id, payer, amount, reason: `The card processor didn’t answer: ${err.message}`, source });
    throw kindError({ processor: true }, practice, lang);
  }
  await db.run('UPDATE payment_requests SET session_id = ?, url = ? WHERE id = ?', session.id, session.url, prId);
  return { url: session.url, payment_request_id: prId };
}

async function settleNow(db, payments, messenger, { practice, payer, amount, prId, sessionId, out, md, source, lang }) {
  if (!out.ok) {
    // An unclear answer stays pending (a retry with the same key returns the first outcome); a decline is final.
    if (!out.ambiguous) await db.run("UPDATE payment_requests SET status = 'cancelled' WHERE id = ?", prId);
    await paymentFailed(db, { practiceId: practice.id, payer, amount, reason: out.reason || 'Declined', source });
    throw kindError(out, practice, lang);
  }
  const session = { id: sessionId, payment_status: 'paid', amount_total: amount, payment_intent: out.reference, metadata: md };
  const entryId = await postOnlinePayment(db, session);
  await afterOnlinePayment(db, payments, messenger, session, entryId);
  return { paid: true, entry_id: entryId, amount, payment_request_id: prId };
}

// Stripe return (success page): asks Stripe for the session and posts it if the webhook hasn't yet.
export async function settleReturn(db, payments, messenger, { practiceId, payerIds, sessionId }) {
  const pr = await db.get('SELECT * FROM payment_requests WHERE session_id = ? AND practice_id = ?', String(sessionId || ''), practiceId);
  if (!pr || !payerIds.includes(pr.patient_id)) throw new HttpError(404, 'Payment not found');
  if (pr.status === 'paid') return { status: 'paid', amount: pr.amount, entry_id: pr.ledger_entry_id };
  if (pr.status !== 'pending' || !payments?.checkoutSession) return { status: pr.status, amount: pr.amount };
  const session = await payments.checkoutSession(pr.session_id);
  if (session.payment_status === 'paid') {
    const entryId = await postOnlinePayment(db, session);
    await afterOnlinePayment(db, payments, messenger, session, entryId);
    const after = await db.get('SELECT * FROM payment_requests WHERE id = ?', pr.id);
    return { status: 'paid', amount: after.amount, entry_id: after.ledger_entry_id };
  }
  // A bank payment takes a few days to clear; the webhook posts it then.
  return { status: session.status === 'complete' ? 'processing' : 'pending', amount: pr.amount };
}

export const achEnabled = (payments) => payments?.mode === 'sandbox' || !!payments?.ach;

// ---- Payment plans the patient can set up (the owner's financial options, F5, or the defaults) ----
const DEFAULT_PLAN_RULES = { show: true, months: [3, 6, 12], max_months: 12, min_amount: 50000, min_down_pct: 20, min_down: 0, apr: 0, setup_fee: 0, first_payment_days: 30 };
export async function planRules(db, practiceId) {
  const raw = (await db.get('SELECT * FROM practices WHERE id = ?', practiceId))?.fin_options;
  try {
    // The financial-options module (F5) owns these settings when it's present.
    const fin = await import('./finoptions.js');
    const s = fin.readSettings(raw);
    return { show: !!s.show.in_office, months: s.in_office.months, max_months: s.in_office.max_months, min_amount: s.in_office.min_amount, min_down_pct: s.in_office.min_down_pct, min_down: s.in_office.min_down, apr: s.in_office.apr, setup_fee: s.in_office.setup_fee, first_payment_days: s.in_office.first_payment_days ?? 30 };
  } catch {
    return DEFAULT_PLAN_RULES;
  }
}

// The choices shown to the patient for an amount: months allowed, the down payment and the monthly payment.
// Only interest-free plans without a setup fee are set up online; anything else is a conversation with the office.
export function planChoices(amount, rules) {
  const selfServe = rules.show && rules.apr === 0 && !rules.setup_fee;
  if (!selfServe || amount < Math.max(rules.min_amount, 100)) return [];
  const down = Math.min(amount - 1, Math.max(rules.min_down || 0, Math.ceil((amount * Math.round((rules.min_down_pct || 0) * 100)) / 10000)));
  return rules.months.filter((m) => Number.isInteger(m) && m >= 2 && m <= rules.max_months).map((months) => ({
    months, down_payment: down, monthly: Math.ceil((amount - down) / months), total: amount,
  }));
}

export function addDays(date, n) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
}
