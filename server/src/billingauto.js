import { createHash, randomBytes } from 'node:crypto';
import { NOT_TRAINING, refuseTraining } from './training.js';
import { HttpError } from './auth.js';
import { requireHuman } from './aiguard.js';
import { withActor } from './actor.js';
import { insert, update, audit, practiceNow, recorded } from './util.js';
import { raiseIssue, resolveIssue, failed } from './issues.js';
import { sendMessage, preferredChannel } from './messaging.js';
import { reverseEntry } from './services.js';
import { autoReceipt } from './receipts.js';
import { planStatus, installmentDate } from './routes/family.js';
import { accountSummary, householdIds } from './billpay.js';
import { reconcileCards } from './reconcile.js';
import { runAutopay } from './payments.js';
import { runMembershipBilling } from './memberships.js';

// Billing that runs itself, and never goes silent (backlog BL1–BL5; spec docs/workflows/specs/BL-billing.md).
// Built on what was there — payment plans + autopay (payments.js), memberships, ortho billing, cards on file, the
// Stripe adapter with its sandbox, online bill pay (billpay.js), Needs attention (issues.js), reconciliation — and
// adding what makes it run by itself:
//   BL1 one "set up payments" step (a plan, a recurring charge, or autopay on a membership / ortho contract), a card
//       on file and the patient's signed authorization (on screen or by text link), and one list of every plan;
//   BL2 every automatic charge tracked (billing_attempts) and posted once by the processor's charge id, and the
//       processor's charges and payouts checked against the ledger each day (exceptions go to Needs attention);
//   BL3 dunning: a declined charge posts nothing, becomes a Needs attention item, texts the patient a secure
//       "update your card" link, is retried on days 3 / 7 / 14 and then paused with next steps for the team;
//       expiring cards are caught a month ahead; disputes and processor refunds are posted as reversals;
//   BL4 the processor behind one adapter (Stripe today), the owner's pass-through rules by state;
//   BL5 passing card costs on (a surcharge on credit cards, or a flat convenience fee online) where the state allows,
//       disclosed before paying and on the receipt, and office fees ($ or % of what's collectible) posted as their
//       own reversible ledger lines, with caps and audited waivers.
// Money rules: the ledger is the only balance; amounts are integer cents; every posting is keyed so a retry, a
// webhook replay or a second server posts it once; corrections are reversing entries; AI can't move money here
// (requireHuman on every money function).

const DAY = 86400_000;
export const dollars = (c) => `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctText = (bps) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0).replace(/(\.\d)0$/, '$1')}%`;
export const todayFor = async (db, pid) => (await practiceNow(db, pid)).slice(0, 10);
export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const utcStamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
const nameOf = (p) => (p ? `${p.first_name} ${p.last_name}` : 'A patient');
const system = (practiceId) => ({ user: { practice_id: practiceId, id: null } });

// Where the patient's links point (set by the routes / the job from config.appUrl).
let appUrl = process.env.APP_URL || '';
export const setAppUrl = (url) => { if (url) appUrl = String(url).replace(/\/$/, ''); };
export const linkUrl = (token) => `${appUrl}/billing-link/${token}`;

// ---- BL4: processors ----
// One adapter (payments.js). Stripe is the one connected today; the others are the ones dental offices commonly
// use, listed so the owner sees what's coming — adding one is a new adapter, not a new billing system.
export const PROCESSORS = [
  { key: 'stripe', name: 'Stripe', available: true },
  { key: 'rectangle_health', name: 'Rectangle Health', available: false },
  { key: 'global_payments', name: 'Global Payments / OpenEdge', available: false },
  { key: 'worldpay', name: 'Worldpay', available: false },
  { key: 'square', name: 'Square', available: false },
  { key: 'payrix', name: 'Payrix', available: false },
];

// ---- BL5: surcharge and convenience-fee rules ----
// The card brands cap a credit-card surcharge at 3% (Visa's cap, the lowest), and never allow one on debit or
// prepaid cards. States add their own rules. This list is the software's starting point; it changes — the owner
// confirms with their processor (and registers the surcharge with them) before turning it on.
export const BRAND_MAX_BPS = 300;
export const STATE_RULES = {
  CA: { surcharge: false, note: 'California requires the price to include every fee, so a card surcharge can’t be added at payment.' },
  CT: { surcharge: false, note: 'Connecticut doesn’t allow credit card surcharges.' },
  MA: { surcharge: false, note: 'Massachusetts doesn’t allow credit card surcharges.' },
  ME: { surcharge: false, note: 'Maine doesn’t allow credit card surcharges.' },
  OK: { surcharge: false, note: 'Oklahoma doesn’t allow credit card surcharges.' },
  PR: { surcharge: false, note: 'Puerto Rico doesn’t allow credit card surcharges.' },
  CO: { max_bps: 200, note: 'Colorado caps card surcharges at 2%.' },
  NY: { max_bps: 300, cost_only: true, note: 'New York: no more than what card processing actually costs you, and the total with the surcharge must be shown.' },
  NJ: { max_bps: 300, cost_only: true, note: 'New Jersey: no more than what card processing actually costs you.' },
};
export const TEST_CARDS = {
  '4242424242424242': { brand: 'visa', funding: 'credit' },
  '4000000000000002': { brand: 'visa', funding: 'credit' }, // declines
  '5555555555554444': { brand: 'mastercard', funding: 'credit' },
  '4000056655665556': { brand: 'visa', funding: 'debit' },
};

const DEFAULT_SETTINGS = { processor: 'stripe', pass_through: 'off', surcharge_bps: 0, processing_cost_bps: 0, convenience_fee: 0, processor_notified: 0, retry_days: [3, 7, 14], expiring_days: 30 };

function cleanRetry(v) {
  const list = (Array.isArray(v) ? v : []).map(Number);
  if (!list.length || list.length > 5 || list.some((n, i) => !Number.isInteger(n) || n < 1 || n > 60 || (i && n <= list[i - 1]))) {
    throw new HttpError(400, 'Retry days must be 1–5 increasing whole days between 1 and 60 (e.g. 3, 7, 14)');
  }
  return list;
}

export async function billingSettings(db, practiceId) {
  const row = await db.get('SELECT * FROM billing_settings WHERE practice_id = ?', practiceId);
  if (!row) return { ...DEFAULT_SETTINGS, practice_id: practiceId };
  let retry;
  try { retry = cleanRetry(JSON.parse(row.retry_days)); } catch { retry = DEFAULT_SETTINGS.retry_days; }
  return { ...row, retry_days: retry };
}

// The state whose rules apply: the office's (when it has one on file), else the practice's.
export async function practiceState(db, practiceId, locationId = null) {
  const loc = locationId ? await db.get('SELECT state FROM locations WHERE id = ? AND practice_id = ?', locationId, practiceId) : null;
  const st = String(loc?.state || (await db.get('SELECT state FROM practices WHERE id = ?', practiceId))?.state || '').trim().toUpperCase().slice(0, 2);
  return st || null;
}

// The most that may be surcharged in a state, given the office's own processing cost (null: not allowed).
export function surchargeCap(state, costBps) {
  const rule = STATE_RULES[state] || {};
  if (rule.surcharge === false) return { max: null, note: rule.note };
  let max = Math.min(BRAND_MAX_BPS, rule.max_bps ?? BRAND_MAX_BPS);
  if (costBps > 0) max = Math.min(max, costBps);
  return { max, note: rule.note || null };
}

export async function saveBillingSettings(db, req, input = {}) {
  requireHuman('changing card surcharges and billing rules');
  const pid = req.user.practice_id;
  const before = await billingSettings(db, pid);
  const next = { ...before };
  const b = input || {};
  if (b.processor !== undefined) {
    if (!PROCESSORS.some((p) => p.key === b.processor && p.available)) throw new HttpError(400, 'Only Stripe can be connected for now');
    next.processor = b.processor;
  }
  if (b.pass_through !== undefined) {
    if (!['off', 'surcharge', 'convenience_fee'].includes(b.pass_through)) throw new HttpError(400, 'pass_through must be off, surcharge or convenience_fee');
    next.pass_through = b.pass_through;
  }
  const int = (v, name, min, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  if (b.surcharge_bps !== undefined) next.surcharge_bps = int(b.surcharge_bps, 'Surcharge (basis points)', 0, 400);
  if (b.processing_cost_bps !== undefined) next.processing_cost_bps = int(b.processing_cost_bps, 'Processing cost (basis points)', 0, 1000);
  if (b.convenience_fee !== undefined) next.convenience_fee = int(b.convenience_fee, 'Convenience fee (cents)', 0, 2500);
  if (b.processor_notified !== undefined) next.processor_notified = b.processor_notified ? 1 : 0;
  if (b.retry_days !== undefined) next.retry_days = cleanRetry(Array.isArray(b.retry_days) ? b.retry_days : String(b.retry_days).split(/[\s,]+/).filter(Boolean));
  if (b.expiring_days !== undefined) next.expiring_days = int(b.expiring_days, 'Days of notice before a card expires', 7, 60);
  if (next.pass_through === 'surcharge') {
    const state = await practiceState(db, pid);
    const cap = surchargeCap(state, next.processing_cost_bps);
    if (cap.max == null) throw new HttpError(400, `${cap.note} Choose a convenience fee or leave it off.`);
    if (!next.processing_cost_bps) throw new HttpError(400, 'Enter what card processing costs you (%) — a surcharge can’t be more than that');
    if (!next.surcharge_bps) throw new HttpError(400, 'Enter the surcharge %');
    if (next.surcharge_bps > cap.max) throw new HttpError(400, `The surcharge can be at most ${pctText(cap.max)} here${cap.note ? ` (${cap.note})` : ' (card brand rules and your processing cost)'}`);
    if (!next.processor_notified) throw new HttpError(400, 'Card brands require you to tell your processor at least 30 days before you start surcharging — confirm you have');
  }
  if (next.pass_through === 'convenience_fee' && !next.convenience_fee) throw new HttpError(400, 'Enter the convenience fee amount');
  const row = {
    processor: next.processor, pass_through: next.pass_through, surcharge_bps: next.surcharge_bps, processing_cost_bps: next.processing_cost_bps,
    convenience_fee: next.convenience_fee, processor_notified: next.processor_notified, retry_days: JSON.stringify(next.retry_days), expiring_days: next.expiring_days,
  };
  await db.run(
    `INSERT INTO billing_settings (practice_id, processor, pass_through, surcharge_bps, processing_cost_bps, convenience_fee, processor_notified, retry_days, expiring_days, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (practice_id) DO UPDATE SET processor = excluded.processor, pass_through = excluded.pass_through, surcharge_bps = excluded.surcharge_bps,
       processing_cost_bps = excluded.processing_cost_bps, convenience_fee = excluded.convenience_fee, processor_notified = excluded.processor_notified,
       retry_days = excluded.retry_days, expiring_days = excluded.expiring_days, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    pid, row.processor, row.pass_through, row.surcharge_bps, row.processing_cost_bps, row.convenience_fee, row.processor_notified, row.retry_days, row.expiring_days, req.user.id,
  );
  const was = { ...before, retry_days: JSON.stringify(before.retry_days) };
  await audit(db, req, 'billing.settings', 'billing_settings', pid, null, {
    before: Object.fromEntries(Object.keys(row).map((k) => [k, was[k]])), after: row,
  });
  return billingSettings(db, pid);
}

// What passing card costs on adds to one payment. channel: 'online' (portal, Pay my bill), 'office', or
// 'recurring' (automatic charges — only up to what the patient agreed to in their signed authorization).
// funding: the card's funding ('credit', 'debit', 'prepaid', null = not known, treated as debit).
export async function passThroughFor(db, practiceId, { amount, channel = 'online', funding = null, method = 'card', authorizedBps = null, locationId = null }) {
  const s = await billingSettings(db, practiceId);
  const none = (reason = null) => ({ kind: null, amount: 0, bps: 0, label: null, disclosure: null, reason });
  if (s.pass_through === 'off' || !(amount > 0)) return none();
  if (s.pass_through === 'surcharge') {
    if (method !== 'card') return none('Bank payments are never surcharged');
    const cap = surchargeCap(await practiceState(db, practiceId, locationId), s.processing_cost_bps);
    if (cap.max == null) return none(cap.note);
    if (funding !== 'credit') return none('Debit and prepaid cards are never surcharged');
    let bps = Math.min(s.surcharge_bps, cap.max);
    if (channel === 'recurring') bps = Math.min(bps, authorizedBps || 0);
    if (!(bps > 0)) return none('The patient hasn’t agreed to a surcharge on automatic payments');
    const fee = Math.floor((amount * bps + 5000) / 10000);
    return {
      kind: 'surcharge', amount: fee, bps, label: `Card surcharge (${pctText(bps)})`,
      disclosure: `A ${pctText(bps)} surcharge (${dollars(fee)}) is added to payments made with a credit card. It isn’t more than what card processing costs us. Debit cards and bank payments have no surcharge.`,
    };
  }
  // A convenience fee: flat, for the convenience of paying online — never on automatic payments or at the office.
  if (channel !== 'online') return none('The convenience fee is only for paying online');
  return {
    kind: 'convenience_fee', amount: s.convenience_fee, bps: 0, label: 'Convenience fee (paying online)',
    disclosure: `A ${dollars(s.convenience_fee)} convenience fee applies to paying online. There’s no fee to pay at the office, by phone with us, or by mail.`,
  };
}

// For the portal and "Pay my bill" pages: the rule in words, before anyone types a card.
export async function passThroughInfo(db, practiceId) {
  const s = await billingSettings(db, practiceId);
  if (s.pass_through === 'off') return null;
  if (s.pass_through === 'surcharge') {
    const cap = surchargeCap(await practiceState(db, practiceId), s.processing_cost_bps);
    if (cap.max == null) return null;
    const bps = Math.min(s.surcharge_bps, cap.max);
    return { kind: 'surcharge', bps, amount: 0, text: `A ${pctText(bps)} surcharge is added to credit card payments. Debit cards and bank payments have no surcharge.` };
  }
  return { kind: 'convenience_fee', bps: 0, amount: s.convenience_fee, text: `A ${dollars(s.convenience_fee)} convenience fee applies to paying online.` };
}

// ---- The sources of automatic charges ----
export const SOURCES = {
  payment_plan: { table: 'payment_plans', method: 'autopay_method_id', label: 'payment plan', link: 'payment_plan_id', live: "status = 'active'" },
  membership: { table: 'memberships', method: 'payment_method_id', label: 'membership', link: 'membership_id', live: "status IN ('active','past_due') AND autopay = 1" },
  ortho_case: { table: 'ortho_cases', method: 'payment_method_id', label: 'orthodontic payments', link: 'ortho_case_id', live: "status IN ('active','retention') AND autopay = 1" },
  recurring: { table: 'recurring_charges', method: 'payment_method_id', label: 'recurring payment', link: null, live: "status IN ('active','paused')" },
};
const issueKey = (type, id) => `dunning:${type}:${id}`;

// The surcharge the patient agreed to for automatic charges on a source (0 = none).
export async function authorizedSurcharge(db, sourceType, sourceId) {
  if (!sourceId || !SOURCES[sourceType]) return 0;
  const a = await db.get("SELECT surcharge_bps FROM billing_authorizations WHERE kind = ? AND source_id = ? AND status = 'signed' ORDER BY id DESC LIMIT 1", sourceType, sourceId);
  return a?.surcharge_bps || 0;
}

// ---- BL2: one tracked charge ----
// Every automatic charge goes through here: the attempt is recorded (visible on the patient's account), the
// surcharge the patient agreed to is decided once per idempotency key (a retry after a lost answer charges the
// same total, so the processor returns the first outcome), and a surcharge that went through is posted as its
// own ledger line (once, by the processor's id). The caller posts the payment for out.total.
export async function trackedCharge(db, payments, { method, amount, description, idempotencyKey, metadata = {} }, { practiceId, patientId, sourceType, sourceId = null, authorizedBps = null }) {
  requireHuman('charging a card');
  // Never for the training patient: no attempt, no dunning, nothing to the processor (training.js).
  await refuseTraining(db, patientId, 'charging a card');
  let att = await db.get('SELECT * FROM billing_attempts WHERE idempotency_key = ?', idempotencyKey);
  if (!att) {
    const bps = authorizedBps ?? (await authorizedSurcharge(db, sourceType, sourceId));
    const pt = bps > 0 ? await passThroughFor(db, practiceId, { amount, channel: 'recurring', funding: method.funding || null, authorizedBps: bps }) : null;
    await db.run(
      `INSERT INTO billing_attempts (practice_id, patient_id, source_type, source_id, payment_method_id, amount, surcharge, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`,
      practiceId, patientId, sourceType, sourceId, method.id ?? null, amount, pt?.kind === 'surcharge' ? pt.amount : 0, idempotencyKey,
    );
    att = await db.get('SELECT * FROM billing_attempts WHERE idempotency_key = ?', idempotencyKey);
  }
  const surcharge = att.surcharge || 0;
  const total = amount + surcharge;
  await db.run("UPDATE billing_attempts SET tries = tries + 1, updated_at = datetime('now') WHERE id = ?", att.id);
  let out;
  try {
    out = await payments.charge({
      method, amount: total, description: surcharge ? `${description} (incl. ${dollars(surcharge)} card surcharge)` : description, idempotencyKey,
      metadata: { ...metadata, ...(surcharge ? { surcharge } : {}) },
    });
  } catch (err) {
    out = { ok: false, ambiguous: true, reason: `Couldn't confirm the charge (${err.message})` };
  }
  const status = out.ok ? 'succeeded' : out.ambiguous ? 'unclear' : 'declined';
  await db.run("UPDATE billing_attempts SET status = ?, reason = ?, reference = COALESCE(?, reference), updated_at = datetime('now') WHERE id = ?", status, out.ok ? null : String(out.reason || '').slice(0, 300), out.reference ?? null, att.id);
  if (out.ok && surcharge) {
    await postSurcharge(db, { practiceId, patientId, reference: out.reference, amount: surcharge, bps: Math.round((surcharge * 10000) / amount), linkCol: SOURCES[sourceType]?.link, linkId: sourceId });
  }
  return { ...out, surcharge, total, attempt_id: att.id };
}

// The surcharge or convenience fee on its own ledger line (a debit), keyed to the processor's charge id.
export async function postSurcharge(db, { practiceId, patientId, reference, amount, bps = 0, kind = 'surcharge', linkCol = null, linkId = null }) {
  const type = kind === 'surcharge' ? 'Card surcharge' : 'Convenience fee';
  return db.tx(async () => {
    const had = await db.get('SELECT id FROM ledger_entries WHERE practice_id = ? AND reference = ? AND type = ? AND adjustment_type = ?', practiceId, reference, 'adjustment', type);
    if (had) return had.id;
    return insert(db, 'ledger_entries', {
      practice_id: practiceId, patient_id: patientId, type: 'adjustment', adjustment_type: type, amount,
      description: kind === 'surcharge' ? `Card surcharge${bps ? ` (${pctText(bps)})` : ''} on a credit card payment` : 'Convenience fee for paying online',
      reference, entry_date: await todayFor(db, practiceId), ...(linkCol && linkId ? { [linkCol]: linkId } : {}),
    });
  });
}

// ---- BL3: dunning ----
export async function openDunning(db, sourceType, sourceId) {
  return db.get('SELECT * FROM billing_dunning WHERE live_key = ?', `${sourceType}:${sourceId}`);
}

// May an automatic charge run today for this source? Not while a declined one waits for its retry day or is
// paused — unless the card has been changed since (a new card is tried straight away).
export async function mayCharge(db, sourceType, sourceId, methodId, today) {
  const d = await openDunning(db, sourceType, sourceId);
  if (!d) return true;
  if (methodId && d.payment_method_id !== methodId) return true;
  if (d.status === 'paused') return false;
  return !d.next_retry_on || d.next_retry_on <= today;
}

async function patientOf(db, id) {
  const p = await db.get('SELECT * FROM patients WHERE id = ?', id);
  return p?.guarantor_id ? (await db.get('SELECT * FROM patients WHERE id = ?', p.guarantor_id)) || p : p;
}

// Texts or emails the patient (the account holder). Returns the message, or null when they can't be reached.
async function tellPatient(db, messenger, { practiceId, patient, subject, body }) {
  const target = messenger ? preferredChannel(patient) : null;
  if (!target) return null;
  return sendMessage(db, messenger, { practiceId, patientId: patient.id, kind: 'payment_request', channel: target.channel, to: target.to, subject, body })
    .catch(failed(db, { practiceId, kind: 'payment', key: `billing-notice:${patient.id}`, role: 'billing', patientId: patient.id, title: `${nameOf(patient)} couldn’t be sent a billing message` }));
}

export async function makeLink(db, { practiceId, patientId, kind, oldMethodId = null, authorizationId = null, dunningId = null, userId = null, days = 30 }) {
  const token = randomBytes(24).toString('base64url');
  const id = await insert(db, 'billing_links', {
    practice_id: practiceId, patient_id: patientId, kind, token_hash: hashToken(token), old_method_id: oldMethodId, authorization_id: authorizationId,
    dunning_id: dunningId, expires_at: utcStamp(Date.now() + days * DAY), created_by: userId,
  });
  return { id, token, url: linkUrl(token) };
}

// Sends the patient a secure link to update the card (after a decline, before it expires, or when staff ask).
export async function sendUpdateCardLink(db, messenger, { practiceId, patientId, oldMethodId, dunningId = null, userId = null, reason }) {
  const patient = await patientOf(db, patientId);
  const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', practiceId);
  const link = await makeLink(db, { practiceId, patientId: patient.id, kind: 'update_card', oldMethodId, dunningId, userId });
  const card = oldMethodId ? await db.get('SELECT brand, last4 FROM payment_methods WHERE id = ?', oldMethodId) : null;
  const es = patient.language === 'es';
  const body = es
    ? `Hola ${patient.first_name}, le escribe ${practice.name}. ${reason.es} Actualice su tarjeta de forma segura aquí: ${link.url} — o llame al ${practice.phone || 'consultorio'}.`
    : `Hi ${patient.first_name}, this is ${practice.name}. ${reason.en} Please update your card securely here: ${link.url} — or call us at ${practice.phone || 'the office'}.`;
  const msg = await tellPatient(db, messenger, { practiceId, patient, subject: es ? `Actualice su tarjeta — ${practice.name}` : `Please update your card — ${practice.name}`, body });
  if (msg?.id) await db.run('UPDATE billing_links SET message_id = ? WHERE id = ?', msg.id, link.id);
  await audit(db, userId ? { user: { practice_id: practiceId, id: userId } } : system(practiceId), 'billing.update_card_link', 'billing_links', link.id, { card: card ? `${card.brand} ${card.last4}` : null, sent: !!msg }, { patientId: patient.id });
  return { ...link, message: msg || null };
}

const nextSteps = (patient, practice, label) => [
  `1. Call ${nameOf(patient)}${patient.phone ? ` at ${patient.phone}` : ''}: “Hi, this is ${practice.name}. The card we have on file for your ${label} didn’t go through, so we’ve paused the automatic payments. Could we update the card, or take a payment now?”`,
  '2. Send a statement from their Statement page (the update-card link is already in their texts/email).',
  '3. No answer in 30 days: consider Billing → Collections for the account.',
].join('\n');

// A declined automatic charge (nothing was posted). Opens or advances the account's dunning: Needs attention,
// the patient's update-card link, the next retry from the practice's schedule — and after the last try, a pause
// with next steps for the team. Returns { failures, paused, next_retry_on }.
export async function chargeDeclined(db, messenger, { practiceId, patientId, sourceType, sourceId, methodId, amount, reason, today }) {
  const settings = await billingSettings(db, practiceId);
  const schedule = settings.retry_days;
  const patient = await patientOf(db, patientId);
  const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', practiceId);
  const label = SOURCES[sourceType]?.label || 'payment';
  const live = `${sourceType}:${sourceId}`;
  let d = await openDunning(db, sourceType, sourceId);
  const fresh = !d || (methodId && d.payment_method_id !== methodId);
  if (!d) {
    await db.run(
      `INSERT INTO billing_dunning (practice_id, patient_id, source_type, source_id, payment_method_id, amount, failures, first_failed_on, last_failed_on, next_retry_on, last_reason, live_key)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?) ON CONFLICT (live_key) DO NOTHING`,
      practiceId, patient.id, sourceType, sourceId, methodId ?? null, amount, today, today, addDays(today, schedule[0]), String(reason).slice(0, 300), live,
    );
    d = await openDunning(db, sourceType, sourceId);
  } else if (fresh) {
    // A new card that was declined too: a new round of retries for it.
    await db.run("UPDATE billing_dunning SET payment_method_id = ?, amount = ?, status = 'retrying', failures = 1, first_failed_on = ?, last_failed_on = ?, next_retry_on = ?, last_reason = ?, paused_at = NULL WHERE id = ?",
      methodId ?? null, amount, today, today, addDays(today, schedule[0]), String(reason).slice(0, 300), d.id);
  } else {
    const failures = d.failures + 1;
    const paused = failures > schedule.length;
    await db.run("UPDATE billing_dunning SET failures = ?, amount = ?, last_failed_on = ?, last_reason = ?, status = ?, next_retry_on = ?, paused_at = CASE WHEN ? = 1 THEN datetime('now') ELSE paused_at END WHERE id = ?",
      failures, amount, today, String(reason).slice(0, 300), paused ? 'paused' : 'retrying', paused ? null : addDays(d.first_failed_on, schedule[failures - 1]), paused ? 1 : 0, d.id);
  }
  d = await db.get('SELECT * FROM billing_dunning WHERE id = ?', d.id);
  const paused = d.status === 'paused';
  // The patient: the update-card link on the first decline (and on a new card's first decline), and again when paused.
  let told = null;
  if (fresh || paused) {
    const link = await sendUpdateCardLink(db, messenger, {
      practiceId, patientId: patient.id, oldMethodId: methodId, dunningId: d.id,
      reason: paused
        ? { en: `We tried your card for your ${label} ${d.failures} times and it didn’t go through, so automatic payments are paused.`, es: `Intentamos cobrar su tarjeta ${d.failures} veces y no se aprobó, así que los pagos automáticos están en pausa.` }
        : { en: `Your ${label} payment of ${dollars(amount)} didn’t go through (${reason}). Nothing was charged.`, es: `Su pago de ${dollars(amount)} no se aprobó (${reason}). No se le cobró nada.` },
    });
    told = link.message && link.message.status !== 'failed' && link.message.status !== 'blocked';
    if (told) await db.run("UPDATE billing_dunning SET patient_notified_at = datetime('now') WHERE id = ?", d.id);
  }
  const reached = told == null ? (d.patient_notified_at ? 'The patient was sent a link to update their card.' : 'The patient hasn’t been reached yet — call them.')
    : told ? 'The patient was sent a link to update their card.' : 'We couldn’t text or email the patient — call them.';
  await raiseIssue(db, {
    practiceId, kind: 'payment', key: issueKey(sourceType, sourceId), role: 'billing', severity: paused ? 'high' : 'normal', patientId: patient.id, entity: 'billing_dunning', entityId: d.id,
    title: paused
      ? `Automatic payments paused: ${nameOf(patient)}’s ${label} (${d.failures} tries didn’t go through)`
      : `${nameOf(patient)}’s ${label} payment of ${dollars(amount)} didn’t go through`,
    detail: paused
      ? `${reason}. ${reached} Next steps:\n${nextSteps(patient, practice, label)}`
      : `${reason}. Nothing was posted. ${reached} The next try is ${d.next_retry_on}.`,
  });
  if (paused) await db.run("UPDATE issues SET severity = 'high' WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", practiceId, issueKey(sourceType, sourceId));
  // The team, once, when it's paused: a task with the next steps (the Needs attention item says the same).
  if (paused && !d.team_notified_at) {
    await insert(db, 'tasks', {
      practice_id: practiceId, patient_id: patient.id, priority: 'high', due_date: today,
      title: `Autopay paused: ${nameOf(patient)} — ${label} (${d.failures} tries didn’t go through)`.slice(0, 200), notes: nextSteps(patient, practice, label),
    });
    await db.run("UPDATE billing_dunning SET team_notified_at = datetime('now') WHERE id = ?", d.id);
    if (sourceType === 'recurring') await recorded(db, 'recurring_charges', sourceId, () => db.run("UPDATE recurring_charges SET status = 'paused' WHERE id = ? AND status = 'active'", sourceId));
  }
  await audit(db, system(practiceId), paused ? 'billing.dunning_paused' : 'billing.dunning_declined', 'billing_dunning', d.id, { source: live, amount, reason, failures: d.failures, next_retry_on: d.next_retry_on }, { patientId: patient.id });
  return { failures: d.failures, paused, next_retry_on: d.next_retry_on, dunning_id: d.id };
}

// A charge for the source went through (or nothing is owed any more, or it was paid at the desk): its dunning is
// over and the work item resolves itself.
export async function chargeSucceeded(db, { practiceId, sourceType, sourceId, today, note = null, status = 'recovered' }) {
  const d = await openDunning(db, sourceType, sourceId);
  if (!d) return false;
  const { changes } = await db.run("UPDATE billing_dunning SET status = ?, closed_at = datetime('now'), close_note = ?, live_key = NULL WHERE id = ? AND live_key IS NOT NULL",
    status, note || `The card went through on ${today}`, d.id);
  if (!changes) return false;
  await resolveIssue(db, practiceId, issueKey(sourceType, sourceId), `Resolved: ${note || `the card went through on ${today}`}`);
  await db.run("UPDATE billing_links SET used_at = COALESCE(used_at, datetime('now')) WHERE dunning_id = ?", d.id);
  if (sourceType === 'recurring') await recorded(db, 'recurring_charges', sourceId, () => db.run("UPDATE recurring_charges SET status = 'active' WHERE id = ? AND status = 'paused'", sourceId));
  await audit(db, system(practiceId), status === 'recovered' ? 'billing.dunning_recovered' : 'billing.dunning_stopped', 'billing_dunning', d.id, { source: `${sourceType}:${sourceId}`, note }, { patientId: d.patient_id });
  return true;
}

// Retries for something that has since ended (a plan cancelled or paid off, a membership cancelled, a contract
// finished) are closed, so nothing waits on them and their work item doesn't linger.
export async function closeEndedDunning(db) {
  let n = 0;
  for (const d of await db.all('SELECT * FROM billing_dunning WHERE live_key IS NOT NULL')) {
    const s = SOURCES[d.source_type];
    if (!s) continue;
    if (await db.get(`SELECT id FROM ${s.table} WHERE id = ? AND ${s.live}`, d.source_id)) continue;
    if (await chargeSucceeded(db, { practiceId: d.practice_id, sourceType: d.source_type, sourceId: d.source_id, today: await todayFor(db, d.practice_id), status: 'stopped', note: `the ${s.label} ended or automatic payments were turned off` })) n++;
  }
  return n;
}

// A person stops the retries (moving the account to collections, a statement instead, the patient paid another way).
export async function stopDunning(db, req, d, note) {
  if (!String(note || '').trim()) throw new HttpError(400, 'Say why the retries are stopping');
  const { changes } = await db.run("UPDATE billing_dunning SET status = 'stopped', closed_at = datetime('now'), close_note = ?, closed_by = ?, live_key = NULL WHERE id = ? AND live_key IS NOT NULL",
    String(note).trim().slice(0, 300), req.user.id, d.id);
  if (!changes) throw new HttpError(409, 'That is already closed');
  await resolveIssue(db, d.practice_id, issueKey(d.source_type, d.source_id), `Stopped by ${req.user.name}: ${String(note).trim().slice(0, 200)}`);
  await audit(db, req, 'billing.dunning_stopped', 'billing_dunning', d.id, { source: `${d.source_type}:${d.source_id}` }, { reason: String(note).trim(), patientId: d.patient_id });
}

// Puts a new card on everything that used the old one (for this account) and makes the open retries due now.
export async function replaceCard(db, { practiceId, patientId, oldMethodId, newMethodId, today, userId = null }) {
  requireHuman('changing the card for automatic payments');
  const changed = [];
  const account = await patientOf(db, patientId);
  const ids = await householdIds(db, practiceId, account.id);
  const L = ids.map(() => '?').join(',');
  for (const [type, s] of Object.entries(SOURCES)) {
    const rows = await db.all(`SELECT id FROM ${s.table} WHERE practice_id = ? AND patient_id IN (${L}) AND ${s.method} = ? AND ${s.live}`, practiceId, ...ids, oldMethodId);
    for (const { id } of rows) {
      const patch = { [s.method]: newMethodId };
      if (type === 'payment_plan') Object.assign(patch, { autopay_paused: 0, autopay_failures: 0, autopay_last_attempt: null });
      if (type === 'recurring') patch.status = 'active';
      await update(db, s.table, id, practiceId, patch);
      await db.run("UPDATE billing_dunning SET next_retry_on = ?, status = 'retrying', paused_at = NULL WHERE live_key = ?", today, `${type}:${id}`);
      changed.push({ type, id });
    }
  }
  await audit(db, userId ? { user: { practice_id: practiceId, id: userId } } : system(practiceId), 'billing.card_replaced', 'payment_methods', newMethodId, { old_method_id: oldMethodId, sources: changed }, { patientId: account.id });
  return changed;
}

// Tries a source again now (a new card, or staff pressing "retry now").
export async function retryNow(db, payments, messenger, sourceType, sourceId) {
  if (sourceType === 'payment_plan') return (await runAutopay(db, payments, messenger, { planId: sourceId, force: true }))[0] || null;
  if (sourceType === 'membership') return (await runMembershipBilling(db, payments, { membershipId: sourceId, messenger })).at(-1) || null;
  if (sourceType === 'ortho_case') return retryOrtho(db, payments, messenger, sourceId);
  if (sourceType === 'recurring') return (await runRecurringCharges(db, payments, messenger, { id: sourceId, force: true }))[0] || null;
  return null;
}

// Household balance straight from the ledger (never charge more than is owed).
async function owedBy(db, practiceId, guarantorId) {
  const ids = await householdIds(db, practiceId, guarantorId);
  if (!ids.length) return 0;
  return Number((await db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE practice_id = ? AND patient_id IN (${ids.map(() => '?').join(',')})`, practiceId, ...ids)).n);
}

// Ortho months are billed to the account whether or not the card goes through; a declined month is retried
// here on the dunning schedule for what's unpaid on the contract.
export async function retryOrtho(db, payments, messenger, caseId) {
  const c = await db.get('SELECT * FROM ortho_cases WHERE id = ?', caseId);
  if (!c || !payments?.enabled) return null;
  const today = await todayFor(db, c.practice_id);
  const d = await openDunning(db, 'ortho_case', c.id);
  const unpaid = Number((await db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE ortho_case_id = ?', c.id)).n);
  const amount = Math.min(unpaid, await owedBy(db, c.practice_id, (await patientOf(db, c.patient_id)).id));
  if (amount < 50) {
    await chargeSucceeded(db, { practiceId: c.practice_id, sourceType: 'ortho_case', sourceId: c.id, today, note: 'Nothing left to collect on the contract' });
    return { case_id: c.id, nothing_owed: true };
  }
  const method = c.payment_method_id ? await db.get('SELECT * FROM payment_methods WHERE id = ? AND removed_at IS NULL', c.payment_method_id) : null;
  if (!method) return null;
  const practice = await db.get('SELECT name FROM practices WHERE id = ?', c.practice_id);
  const out = await trackedCharge(db, payments, {
    method, amount, description: `${practice.name} — orthodontic payment (retry)`, idempotencyKey: `ortho-retry-${c.id}-${d?.id ?? 0}-${d?.failures ?? 0}${d?.resumes ? `-r${d.resumes}` : ''}-${method.id}`,
    metadata: { ortho_case_id: c.id, patient_id: c.patient_id },
  }, { practiceId: c.practice_id, patientId: c.patient_id, sourceType: 'ortho_case', sourceId: c.id });
  if (out.ambiguous) return { case_id: c.id, pending: true };
  if (!out.ok) {
    const r = await chargeDeclined(db, messenger, { practiceId: c.practice_id, patientId: c.patient_id, sourceType: 'ortho_case', sourceId: c.id, methodId: method.id, amount, reason: out.reason, today });
    await db.run('UPDATE ortho_cases SET billing_failures = billing_failures + 1, billing_message = ? WHERE id = ?', `${out.reason} (${today})`, c.id);
    return { case_id: c.id, declined: true, ...r };
  }
  const entryId = await postPaymentOnce(db, {
    practice_id: c.practice_id, patient_id: c.patient_id, amount: -out.total, method: 'credit_card', reference: out.reference, ortho_case_id: c.id,
    description: `Ortho autopay (${method.brand || 'card'} •••• ${method.last4})`, entry_date: today,
  });
  await db.run('UPDATE ortho_cases SET billing_failures = 0, billing_message = ? WHERE id = ?', `Charged ${dollars(out.total)} on ${today}`, c.id);
  await chargeSucceeded(db, { practiceId: c.practice_id, sourceType: 'ortho_case', sourceId: c.id, today });
  if (entryId) await autoReceipt(db, messenger, entryId);
  return { case_id: c.id, ok: true, amount: out.total };
}

// A payment posted once per processor charge id.
export async function postPaymentOnce(db, row) {
  return db.tx(async () => {
    if (await db.get("SELECT id FROM ledger_entries WHERE practice_id = ? AND type = 'payment' AND reference = ? AND reverses_id IS NULL", row.practice_id, row.reference)) return null;
    return insert(db, 'ledger_entries', { type: 'payment', ...row });
  });
}

// ---- Recurring charges (any amount, monthly) ----
export function monthlyOn(date, day, monthsAhead = 0) {
  const d = new Date(`${date}T12:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + monthsAhead;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last), 12)).toISOString().slice(0, 10);
}
// The first date on or after `from` that falls on the day of the month.
export function firstOn(from, day) {
  const here = monthlyOn(from, day);
  return here >= from ? here : monthlyOn(from, day, 1);
}

export async function runRecurringCharges(db, payments, messenger, { id = null, force = false } = {}) {
  if (!payments?.enabled) return [];
  // Never the training patient (training.js): nothing is charged for it.
  const rows = await db.all(`SELECT * FROM recurring_charges WHERE status = 'active' AND ${NOT_TRAINING()}${id ? ' AND id = ?' : ''}`, ...(id ? [id] : []));
  const results = [];
  for (const listed of rows) {
    const today = await todayFor(db, listed.practice_id);
    if (!force && listed.next_charge_date > today) continue;
    if (!force && !(await mayCharge(db, 'recurring', listed.id, listed.payment_method_id, today))) continue;
    const lock = new Date(Date.now() + 10 * 60_000).toISOString();
    const took = await db.run("UPDATE recurring_charges SET charge_lock = ? WHERE id = ? AND status = 'active' AND (charge_lock IS NULL OR charge_lock < ?)", lock, listed.id, new Date().toISOString());
    if (!took.changes) continue;
    try {
      const r = await db.get('SELECT * FROM recurring_charges WHERE id = ?', listed.id);
      const res = await chargeRecurring(db, payments, messenger, r, today);
      if (res) results.push(res);
    } finally {
      await db.run('UPDATE recurring_charges SET charge_lock = NULL WHERE id = ? AND charge_lock = ?', listed.id, lock);
    }
  }
  return results;
}

async function chargeRecurring(db, payments, messenger, r, today) {
  const finish = async (why) => {
    await recorded(db, 'recurring_charges', r.id, () => db.run("UPDATE recurring_charges SET status = 'completed', last_message = ? WHERE id = ? AND status = 'active'", why, r.id));
    return { recurring_id: r.id, completed: true, reason: why };
  };
  if ((r.max_charges && r.charges_made >= r.max_charges) || (r.end_date && today > r.end_date)) return finish('Finished as agreed');
  const owed = await owedBy(db, r.practice_id, r.patient_id);
  const amount = Math.min(r.amount, owed);
  if (amount < 50) {
    // Nothing owed this month: skipped (nothing charged), tried again next month.
    await db.run('UPDATE recurring_charges SET next_charge_date = ?, last_message = ? WHERE id = ?', monthlyOn(today, r.day_of_month, 1), `Nothing owed on ${today} — skipped`, r.id);
    await chargeSucceeded(db, { practiceId: r.practice_id, sourceType: 'recurring', sourceId: r.id, today, note: 'Nothing owed any more' });
    return { recurring_id: r.id, skipped: true };
  }
  const method = r.payment_method_id ? await db.get('SELECT * FROM payment_methods WHERE id = ? AND removed_at IS NULL', r.payment_method_id) : null;
  if (!method) {
    await raiseIssue(db, { practiceId: r.practice_id, kind: 'payment', key: issueKey('recurring', r.id), role: 'billing', patientId: r.patient_id, title: `Recurring payment #${r.id} has no card on file`, detail: 'Send the patient an update-card link or choose a card.' });
    return null;
  }
  const d = await openDunning(db, 'recurring', r.id);
  const practice = await db.get('SELECT name FROM practices WHERE id = ?', r.practice_id);
  const out = await trackedCharge(db, payments, {
    method, amount, description: `${practice.name} — ${r.description}`, idempotencyKey: `recurring-${r.id}-${r.charges_made}-${d?.failures ?? 0}${d?.resumes ? `-r${d.resumes}` : ''}-${method.id}`,
    metadata: { recurring_charge_id: r.id, patient_id: r.patient_id },
  }, { practiceId: r.practice_id, patientId: r.patient_id, sourceType: 'recurring', sourceId: r.id });
  if (out.ambiguous) {
    await db.run('UPDATE recurring_charges SET last_message = ? WHERE id = ?', `${out.reason} — will check again`, r.id);
    return { recurring_id: r.id, pending: true };
  }
  if (!out.ok) {
    const res = await chargeDeclined(db, messenger, { practiceId: r.practice_id, patientId: r.patient_id, sourceType: 'recurring', sourceId: r.id, methodId: method.id, amount, reason: out.reason, today });
    await db.run('UPDATE recurring_charges SET last_message = ? WHERE id = ?', `${out.reason} (${today})`, r.id);
    return { recurring_id: r.id, ok: false, reason: out.reason, ...res };
  }
  const entryId = await postPaymentOnce(db, {
    practice_id: r.practice_id, patient_id: r.patient_id, amount: -out.total, method: 'credit_card', reference: out.reference,
    description: `Automatic payment — ${r.description} (${method.brand || 'card'} •••• ${method.last4})`, entry_date: today,
  });
  const made = r.charges_made + 1;
  const next = monthlyOn(today, r.day_of_month, 1);
  const done = (r.max_charges && made >= r.max_charges) || (r.end_date && next > r.end_date);
  await db.run(`UPDATE recurring_charges SET charges_made = ?, next_charge_date = ?, last_message = ?${done ? ", status = 'completed'" : ''} WHERE id = ?`, made, next, `Charged ${dollars(out.total)} on ${today}`, r.id);
  await chargeSucceeded(db, { practiceId: r.practice_id, sourceType: 'recurring', sourceId: r.id, today });
  if (entryId) await autoReceipt(db, messenger, entryId);
  return { recurring_id: r.id, ok: true, amount: out.total, surcharge: out.surcharge, entry_id: entryId };
}

// ---- BL5: office fees ----
export const FEE_OCCASIONS = {
  plan_setup: 'When a payment plan is set up',
  late_payment: 'A payment-plan payment is late',
  returned_payment: 'A payment is returned (bank payment bounced, card dispute lost)',
  missed_appointment: 'A missed appointment (no-show)',
  statement: 'Each statement sent',
  manual: 'Only when staff add it',
};

export function cleanFee(input = {}, current = {}) {
  const b = { ...current, ...input };
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Give the fee a name');
  if (!['fixed', 'percent'].includes(b.kind)) throw new HttpError(400, 'kind must be fixed (a $ amount) or percent (of what’s collectible)');
  if (!FEE_OCCASIONS[b.occasion]) throw new HttpError(400, `occasion must be one of ${Object.keys(FEE_OCCASIONS).join(', ')}`);
  const applies = b.applies || 'offered';
  if (!['automatic', 'offered'].includes(applies)) throw new HttpError(400, 'applies must be automatic or offered');
  if (b.occasion === 'manual' && applies === 'automatic') throw new HttpError(400, 'A fee staff add by hand can’t be automatic');
  const cents = (v, n, max = 100_000) => {
    if (v == null || v === '') return null;
    const x = Number(v);
    if (!Number.isInteger(x) || x < 0 || x > max) throw new HttpError(400, `${n} must be whole cents from 0 to ${max}`);
    return x;
  };
  const amount = b.kind === 'fixed' ? cents(b.amount, 'amount') : 0;
  if (b.kind === 'fixed' && !amount) throw new HttpError(400, 'Enter the fee amount');
  const pct = b.kind === 'percent' ? Number(b.pct_bps) : 0;
  if (b.kind === 'percent' && (!Number.isInteger(pct) || pct < 1 || pct > 2500)) throw new HttpError(400, 'The % must be between 0.01% and 25% (in basis points: 1–2500)');
  const min = cents(b.min_amount, 'Minimum');
  const max = cents(b.max_amount, 'Cap');
  if (min != null && max != null && min > max) throw new HttpError(400, 'The minimum is above the cap');
  const perYear = b.max_per_year == null || b.max_per_year === '' ? null : Number(b.max_per_year);
  if (perYear != null && (!Number.isInteger(perYear) || perYear < 1 || perYear > 52)) throw new HttpError(400, 'Times per year must be 1–52');
  const grace = Number(b.grace_days ?? 0);
  if (!Number.isInteger(grace) || grace < 0 || grace > 90) throw new HttpError(400, 'Grace days must be 0–90');
  return {
    name, kind: b.kind, amount: amount || 0, pct_bps: pct, occasion: b.occasion, applies, min_amount: min, max_amount: max, max_per_year: perYear,
    grace_days: grace, waivable: b.waivable === undefined ? 1 : b.waivable ? 1 : 0, active: b.active === undefined ? 1 : b.active ? 1 : 0,
  };
}

// The fee on a basis (what's collectible, or what the fee is about): fixed, or % half-up, within the min and cap.
export function feeAmount(fee, basis) {
  let n = fee.kind === 'fixed' ? fee.amount : Math.floor((Math.max(0, Number(basis) || 0) * fee.pct_bps + 5000) / 10000);
  if (fee.min_amount != null && n > 0) n = Math.max(n, fee.min_amount);
  if (fee.max_amount != null) n = Math.min(n, fee.max_amount);
  return Math.max(0, n);
}
const feeWords = (fee) => (fee.kind === 'fixed' ? dollars(fee.amount) : `${pctText(fee.pct_bps)}${fee.max_amount != null ? ` (at most ${dollars(fee.max_amount)})` : ''}${fee.min_amount ? ` (at least ${dollars(fee.min_amount)})` : ''}`);

// What the account owes now after insurance (the basis for a % fee with nothing more specific).
export async function collectible(db, practiceId, patientId) {
  const account = await patientOf(db, patientId);
  return Math.max(0, (await accountSummary(db, practiceId, await householdIds(db, practiceId, account.id))).your_portion);
}

// Puts a fee on an account once for its occasion (source_key). Returns the fee charge, or null (nothing to charge,
// or the yearly limit reached). The fee is its own ledger line — never folded into a procedure's fee.
export async function applyFee(db, fee, { patientId, sourceKey, basis = null, userId = null, date = null, note = null }) {
  requireHuman('adding a fee to an account');
  if (!fee.active) throw new HttpError(409, 'That fee is turned off');
  const pid = fee.practice_id;
  const base = basis ?? (fee.kind === 'percent' ? await collectible(db, pid, patientId) : null);
  const amount = feeAmount(fee, base);
  if (amount <= 0) return null;
  if (fee.max_per_year) {
    const since = utcStamp(Date.now() - 365 * DAY);
    const n = Number((await db.get("SELECT COUNT(*) AS n FROM billing_fee_charges WHERE fee_id = ? AND patient_id = ? AND status = 'posted' AND created_at >= ?", fee.id, patientId, since)).n);
    if (n >= fee.max_per_year) return null;
  }
  const today = date || (await todayFor(db, pid));
  return db.tx(async () => {
    const claimed = await db.run(
      'INSERT INTO billing_fee_charges (practice_id, patient_id, fee_id, source_key, basis, amount, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (fee_id, source_key) DO NOTHING',
      pid, patientId, fee.id, String(sourceKey).slice(0, 120), base, amount, userId,
    );
    if (!claimed.changes) return null;
    const charge = await db.get('SELECT * FROM billing_fee_charges WHERE fee_id = ? AND source_key = ?', fee.id, String(sourceKey).slice(0, 120));
    const entryId = await insert(db, 'ledger_entries', {
      practice_id: pid, patient_id: patientId, type: 'adjustment', adjustment_type: 'Office fee', amount,
      description: `${fee.name}${fee.kind === 'percent' && base != null ? ` (${pctText(fee.pct_bps)} of ${dollars(base)})` : ''}${note ? ` — ${note}` : ''}`.slice(0, 300),
      reference: `fee:${charge.id}`, entry_date: today, created_by: userId,
    });
    await db.run('UPDATE billing_fee_charges SET ledger_entry_id = ? WHERE id = ?', entryId, charge.id);
    await audit(db, userId ? { user: { practice_id: pid, id: userId } } : system(pid), 'billing_fee.post', 'billing_fee_charges', charge.id, { fee: fee.name, amount, basis: base, source: sourceKey }, { patientId });
    return { ...charge, ledger_entry_id: entryId };
  });
}

// Waiving a posted fee: a reversing entry with the reason (the fee line stays, marked void), audited.
export async function waiveFee(db, req, charge, reason) {
  requireHuman('waiving a fee');
  const why = String(reason || '').trim();
  if (!why) throw new HttpError(400, 'Give a reason for waiving the fee');
  if (charge.status !== 'posted') throw new HttpError(409, 'That fee was already waived');
  const fee = await db.get('SELECT * FROM billing_fees WHERE id = ?', charge.fee_id);
  if (!fee.waivable && req.user.role !== 'admin') throw new HttpError(403, `The office set “${fee.name}” as not waivable — an administrator can reverse it`);
  const entry = await db.get('SELECT * FROM ledger_entries WHERE id = ?', charge.ledger_entry_id);
  const today = await todayFor(db, charge.practice_id);
  const reversal = await db.tx(async () => {
    const r = await reverseEntry(db, entry, { userId: req.user.id, reason: `Fee waived: ${why}`.slice(0, 300), date: today });
    const { changes } = await db.run("UPDATE billing_fee_charges SET status = 'waived', reversal_entry_id = ?, waived_by = ?, waive_reason = ?, waived_at = datetime('now') WHERE id = ? AND status = 'posted'", r, req.user.id, why.slice(0, 300), charge.id);
    if (!changes) throw new HttpError(409, 'That fee was already waived');
    return r;
  });
  await audit(db, req, 'billing_fee.waive', 'billing_fee_charges', charge.id, { fee: fee.name, amount: charge.amount, reversal_entry_id: reversal }, { reason: why, patientId: charge.patient_id });
  return reversal;
}

async function activeFees(db, practiceId, occasion, { automaticOnly = true } = {}) {
  return db.all(`SELECT * FROM billing_fees WHERE practice_id = ? AND occasion = ? AND active = 1${automaticOnly ? " AND applies = 'automatic'" : ''} ORDER BY id`, practiceId, occasion);
}

// Automatic fees for things that happened: late plan payments, missed visits, statements sent. Each once
// (the fee charge's unique key; late fees also share payment_plan_late_fees with the plan's own late fee, so
// an installment never gets two). Only what happened after the fee was set up.
export async function runAutoFees(db, practiceId) {
  const out = { late: 0, missed: 0, statement: 0 };
  const today = await todayFor(db, practiceId);
  for (const fee of await activeFees(db, practiceId, 'late_payment')) {
    const since = String(fee.created_at).slice(0, 10);
    const plans = await db.all(`SELECT * FROM payment_plans WHERE practice_id = ? AND status = 'active' AND late_fee = 0 AND ${NOT_TRAINING()}`, practiceId);
    for (const plan of plans) {
      const st = await planStatus(db, plan, today);
      for (const s of st.schedule) {
        if (s.due_date < since || addDays(s.due_date, fee.grace_days) >= today || s.paid >= s.amount || s.late_fee) continue;
        const amount = feeAmount(fee, s.amount - s.paid);
        if (amount <= 0) continue;
        // Claim the installment and post the fee together: the claim row stays only when a fee really posted.
        const posted = await db.tx(async () => {
          const claimed = await db.run('INSERT INTO payment_plan_late_fees (plan_id, installment, amount) VALUES (?, ?, ?) ON CONFLICT (plan_id, installment) DO NOTHING', plan.id, s.n, amount);
          if (!claimed.changes) return false;
          const c = await applyFee(db, fee, { patientId: plan.patient_id, sourceKey: `plan:${plan.id}:${s.n}`, basis: s.amount - s.paid, date: today, note: `payment plan installment ${s.n} due ${s.due_date}` });
          if (!c) {
            // Nothing posted (the fee's yearly limit, or it came to $0): release the claim. It is a derived
            // claim row, not a record of money — the ledger and billing_fee_charges hold the real fee — so a
            // hard delete is safe, and the plan screen never shows a fee that wasn't charged.
            await db.run('DELETE FROM payment_plan_late_fees WHERE plan_id = ? AND installment = ? AND ledger_entry_id IS NULL', plan.id, s.n);
            return false;
          }
          await db.run('UPDATE payment_plan_late_fees SET ledger_entry_id = ? WHERE plan_id = ? AND installment = ?', c.ledger_entry_id, plan.id, s.n);
          return true;
        });
        if (posted) out.late++;
      }
    }
  }
  for (const fee of await activeFees(db, practiceId, 'missed_appointment')) {
    const appts = await db.all("SELECT id, patient_id, start_time FROM real_appointments appointments WHERE practice_id = ? AND status = 'no_show' AND start_time >= ? ORDER BY id", practiceId, String(fee.created_at).slice(0, 10));
    for (const a of appts) {
      if (await db.get('SELECT id FROM billing_fee_charges WHERE fee_id = ? AND source_key = ?', fee.id, `appt:${a.id}`)) continue;
      if (await applyFee(db, fee, { patientId: a.patient_id, sourceKey: `appt:${a.id}`, date: today, note: `missed appointment ${String(a.start_time).slice(0, 10)}` })) out.missed++;
    }
  }
  for (const fee of await activeFees(db, practiceId, 'statement')) {
    const rows = await db.all("SELECT id, patient_id, amount, created_at FROM statement_deliveries WHERE practice_id = ? AND created_at >= ? AND status <> 'failed' ORDER BY id", practiceId, fee.created_at);
    for (const sd of rows) {
      if (await db.get('SELECT id FROM billing_fee_charges WHERE fee_id = ? AND source_key = ?', fee.id, `statement:${sd.id}`)) continue;
      if (await applyFee(db, fee, { patientId: sd.patient_id, sourceKey: `statement:${sd.id}`, basis: sd.amount, date: today, note: `statement ${String(sd.created_at).slice(0, 10)}` })) out.statement++;
    }
  }
  return out;
}

// A returned payment (a bank payment that bounced, a card dispute the office lost): the office's automatic fee.
export async function returnedPaymentFee(db, { practiceId, patientId, amount, key }) {
  let n = 0;
  for (const fee of await activeFees(db, practiceId, 'returned_payment')) {
    if (await applyFee(db, fee, { patientId, sourceKey: `returned:${key}`, basis: amount, note: 'returned payment' })) n++;
  }
  return n;
}

// ---- BL3: expiring cards ----
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
export async function runExpiringCards(db, messenger, practiceId) {
  const s = await billingSettings(db, practiceId);
  const today = await todayFor(db, practiceId);
  const horizon = addDays(today, s.expiring_days);
  const used = Object.values(SOURCES).map((src) => `EXISTS (SELECT 1 FROM ${src.table} x WHERE x.${src.method} = pm.id AND x.${src.live})`).join(' OR ');
  const cards = await db.all(`SELECT pm.* FROM payment_methods pm WHERE pm.practice_id = ? AND pm.removed_at IS NULL AND pm.exp_year IS NOT NULL AND pm.exp_month IS NOT NULL AND (${used})`, practiceId);
  let sent = 0;
  for (const pm of cards) {
    const ends = lastDayOf(pm.exp_year, pm.exp_month);
    if (ends > horizon) continue;
    const key = `expiring:${pm.id}:${pm.exp_year}-${String(pm.exp_month).padStart(2, '0')}`;
    const claimed = await db.run('INSERT INTO billing_notices (practice_id, patient_id, payment_method_id, kind, notice_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT (notice_key) DO NOTHING', practiceId, pm.patient_id, pm.id, 'expiring', key);
    if (!claimed.changes) continue;
    const expired = ends < today;
    const link = await sendUpdateCardLink(db, messenger, {
      practiceId, patientId: pm.patient_id, oldMethodId: pm.id,
      reason: expired
        ? { en: `The ${pm.brand || 'card'} ending ${pm.last4} we use for your automatic payments has expired.`, es: `La tarjeta que termina en ${pm.last4} para sus pagos automáticos ya venció.` }
        : { en: `The ${pm.brand || 'card'} ending ${pm.last4} we use for your automatic payments expires ${String(pm.exp_month).padStart(2, '0')}/${pm.exp_year}.`, es: `La tarjeta que termina en ${pm.last4} para sus pagos automáticos vence el ${String(pm.exp_month).padStart(2, '0')}/${pm.exp_year}.` },
    });
    await db.run('UPDATE billing_notices SET link_id = ?, message_id = ? WHERE notice_key = ?', link.id, link.message?.id ?? null, key);
    sent++;
  }
  return sent;
}

// ---- BL3: disputes and refunds at the processor ----
// Card disputes (chargebacks) take the money back: posted as a reversing entry of the payment (reverses_id), with a
// Needs attention item to respond before the deadline; a won dispute puts the payment back. Refunds made at the
// processor's own dashboard post as refunds (refund_of_id). Each once, by the processor's id.
async function paymentByReference(db, reference) {
  if (!reference) return null;
  return db.get("SELECT * FROM ledger_entries WHERE reference = ? AND type = 'payment' AND amount < 0 AND reverses_id IS NULL ORDER BY id LIMIT 1", reference);
}

export async function handleBillingEvent(db, { messenger } = {}, event) {
  const o = event?.data?.object || {};
  if (event.type === 'charge.dispute.created') return disputeOpened(db, o);
  if (event.type === 'charge.dispute.closed' || (event.type === 'charge.dispute.updated' && ['won', 'lost'].includes(o.status))) return disputeClosed(db, messenger, o);
  if (event.type === 'charge.refunded') return processorRefunds(db, o);
  return null;
}

async function disputeOpened(db, d) {
  const entry = await paymentByReference(db, d.payment_intent);
  const practiceId = entry?.practice_id ?? (Number(d.metadata?.practice_id) || null);
  if (!practiceId) return null;
  const claimed = await db.run(
    `INSERT INTO billing_disputes (practice_id, patient_id, kind, processor_id, payment_reference, payment_entry_id, amount, reason, status, respond_by)
     VALUES (?, ?, 'dispute', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (processor_id) DO NOTHING`,
    practiceId, entry?.patient_id ?? null, d.id, d.payment_intent || null, entry?.id ?? null, Number(d.amount) || 0, d.reason || null, entry ? 'open' : 'unmatched',
    d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000).toISOString().slice(0, 10) : null,
  );
  if (!claimed.changes) return null;
  const row = await db.get('SELECT * FROM billing_disputes WHERE processor_id = ?', d.id);
  const patient = entry ? await db.get('SELECT * FROM patients WHERE id = ?', entry.patient_id) : null;
  let reversal = null;
  if (entry) {
    const today = await todayFor(db, practiceId);
    reversal = await insert(db, 'ledger_entries', {
      practice_id: practiceId, patient_id: entry.patient_id, type: 'payment', amount: Math.min(Number(d.amount) || 0, -entry.amount), method: entry.method, reference: d.id,
      description: `Card dispute (chargeback)${d.reason ? ` — ${String(d.reason).replace(/_/g, ' ')}` : ''}: reverses the ${entry.entry_date} payment`.slice(0, 300),
      reverses_id: entry.id, payment_plan_id: entry.payment_plan_id ?? null, membership_id: entry.membership_id ?? null, ortho_case_id: entry.ortho_case_id ?? null, entry_date: today,
    });
    await db.run('UPDATE billing_disputes SET reversal_entry_id = ? WHERE id = ?', reversal, row.id);
  }
  await raiseIssue(db, {
    practiceId, kind: 'payment', key: `dispute:${d.id}`, role: 'billing', severity: 'high', patientId: patient?.id ?? null, entity: 'billing_disputes', entityId: row.id,
    title: `${patient ? nameOf(patient) : 'A patient'} disputed a ${dollars(d.amount)} card payment`,
    detail: `${entry ? 'The payment was taken back off the ledger (a reversing entry).' : 'No payment in the ledger matches it — find it and post it.'} Respond at the processor${row.respond_by ? ` by ${row.respond_by}` : ''} with the signed treatment plan or consent, the payment authorization and the receipt.`,
  });
  await audit(db, system(practiceId), 'billing.dispute_opened', 'billing_disputes', row.id, { amount: d.amount, reason: d.reason, reversal_entry_id: reversal }, { patientId: patient?.id ?? null });
  return row.id;
}

async function disputeClosed(db, messenger, d) {
  const row = await db.get('SELECT * FROM billing_disputes WHERE processor_id = ?', d.id);
  if (!row || !['open', 'unmatched'].includes(row.status)) return null;
  const won = d.status === 'won';
  const { changes } = await db.run("UPDATE billing_disputes SET status = ?, closed_at = datetime('now') WHERE id = ? AND status IN ('open','unmatched')", won ? 'won' : 'lost', row.id);
  if (!changes) return null;
  if (won && row.reversal_entry_id) {
    const entry = await db.get('SELECT * FROM ledger_entries WHERE id = ?', row.payment_entry_id);
    const restored = await insert(db, 'ledger_entries', {
      practice_id: row.practice_id, patient_id: entry.patient_id, type: 'payment', amount: -row.amount, method: entry.method, reference: `${d.id}:won`,
      description: `Card dispute won — the ${entry.entry_date} payment is restored`, payment_plan_id: entry.payment_plan_id ?? null, membership_id: entry.membership_id ?? null,
      ortho_case_id: entry.ortho_case_id ?? null, entry_date: await todayFor(db, row.practice_id),
    });
    await db.run('UPDATE billing_disputes SET restored_entry_id = ? WHERE id = ?', restored, row.id);
  }
  if (!won && row.patient_id) await returnedPaymentFee(db, { practiceId: row.practice_id, patientId: row.patient_id, amount: row.amount, key: d.id });
  await resolveIssue(db, row.practice_id, `dispute:${d.id}`, won ? 'Resolved: the dispute was won and the payment restored' : 'Resolved: the dispute was lost; the reversal stands and the amount is owed again');
  await audit(db, system(row.practice_id), won ? 'billing.dispute_won' : 'billing.dispute_lost', 'billing_disputes', row.id, { amount: row.amount }, { patientId: row.patient_id });
  return row.id;
}

async function processorRefunds(db, charge) {
  const entry = await paymentByReference(db, charge.payment_intent);
  if (!entry) return null;
  let n = 0;
  for (const re of charge.refunds?.data || []) {
    if (!re?.id || re.status === 'failed' || re.status === 'canceled') continue;
    // Refunds made from here are posted by the refund itself (payments.js marks them); only outside ones post here.
    if (re.metadata?.source === 'dentalmachine') continue;
    const claimed = await db.run(
      `INSERT INTO billing_disputes (practice_id, patient_id, kind, processor_id, payment_reference, payment_entry_id, amount, status)
       VALUES (?, ?, 'refund', ?, ?, ?, ?, 'posted') ON CONFLICT (processor_id) DO NOTHING`, entry.practice_id, entry.patient_id, re.id, charge.payment_intent, entry.id, Number(re.amount) || 0,
    );
    if (!claimed.changes) continue;
    if (await db.get("SELECT id FROM ledger_entries WHERE practice_id = ? AND type = 'refund' AND reference = ?", entry.practice_id, re.id)) continue;
    const refunded = Number((await db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE refund_of_id = ? AND type = 'refund'", entry.id)).n);
    const amount = Math.min(Number(re.amount) || 0, -entry.amount - refunded);
    if (amount <= 0) continue;
    const id = await insert(db, 'ledger_entries', {
      practice_id: entry.practice_id, patient_id: entry.patient_id, type: 'refund', amount, method: entry.method, reference: re.id, refund_of_id: entry.id,
      description: `Refund made at the card processor — ${entry.entry_date} payment`, entry_date: await todayFor(db, entry.practice_id),
    });
    await db.run('UPDATE billing_disputes SET reversal_entry_id = ? WHERE processor_id = ?', id, re.id);
    await raiseIssue(db, {
      practiceId: entry.practice_id, kind: 'payment', key: `processor-refund:${re.id}`, role: 'billing', patientId: entry.patient_id, entity: 'ledger_entries', entityId: id,
      title: `A ${dollars(amount)} refund was made at the card processor, not here`, detail: 'It’s posted to the patient’s ledger. Check it was meant to happen, then resolve this.',
    });
    await audit(db, system(entry.practice_id), 'billing.processor_refund', 'ledger_entries', id, { amount, refund: re.id, payment_entry_id: entry.id }, { patientId: entry.patient_id });
    n++;
  }
  return n;
}

// ---- BL2: the daily check with the processor ----
// Card charges at the processor vs the ledger for one day (reconcile.js), plus that day's payouts: every charge a
// payout paid out must be on a ledger, and (for an account used only by this practice) the payout must add up.
// Each difference is a Needs attention item; a later check that finds it fixed resolves it.
export async function reconcileDay(db, payments, practiceId, day) {
  await db.run('INSERT INTO billing_recon_days (practice_id, day) VALUES (?, ?) ON CONFLICT (practice_id, day) DO NOTHING', practiceId, day);
  const row = await db.get('SELECT * FROM billing_recon_days WHERE practice_id = ? AND day = ?', practiceId, day);
  const had = (() => { try { return JSON.parse(row.detail || '{}').keys || []; } catch { return []; } })();
  const cards = await reconcileCards(db, payments, practiceId, day, day);
  if (!cards.available) {
    await db.run("UPDATE billing_recon_days SET status = 'unavailable', detail = ?, checked_at = datetime('now') WHERE id = ?", JSON.stringify({ note: cards.note, keys: [] }), row.id);
    return { day, available: false, note: cards.note };
  }
  const ex = [];
  for (const c of cards.charged_not_posted) ex.push({ key: `recon:${c.id}`, title: `A ${dollars(c.amount)} card charge at the processor on ${day} isn’t on any ledger`, detail: `Processor id ${c.id}${c.description ? ` (${c.description})` : ''}. Find the patient and post it (or refund it at the processor).` });
  for (const c of cards.amount_differs) ex.push({ key: `recon:${c.id}`, title: `${c.patient}: the processor charged ${dollars(c.amount)} but the ledger says ${dollars(c.ledger_amount)}`, detail: `Ledger entry #${c.entry_id}, processor id ${c.id}.` });
  for (const c of cards.voided_but_charged) ex.push({ key: `recon:${c.id}`, title: `${c.patient}: a voided payment was still charged (${dollars(c.amount)})`, detail: `Ledger entry #${c.entry_id}. Refund it at the processor or re-post it.` });
  for (const l of cards.posted_not_charged.filter((x) => /^pi_/.test(x.reference || ''))) ex.push({ key: `recon:e${l.entry_id}`, title: `${l.patient}: a ${dollars(l.amount)} card payment is on the ledger but not at the processor`, detail: `Ledger entry #${l.entry_id} (${l.reference}). Check the charge went through before the patient is given credit for it.` });
  let payouts = 0;
  if (payments?.listPayouts) {
    const from = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
    for (const po of await payments.listPayouts({ fromTs: from, toTs: from + 86400 })) {
      payouts++;
      const items = (po.items || []).filter((t) => t.type !== 'payout');
      const ours = items.filter((t) => t.practice_id == null || Number(t.practice_id) === practiceId);
      for (const t of ours.filter((x) => ['charge', 'payment'].includes(x.type) && x.payment_intent)) {
        if (!(await db.get("SELECT id FROM ledger_entries WHERE practice_id = ? AND type = 'payment' AND reference = ?", practiceId, t.payment_intent))) {
          ex.push({ key: `payout:${po.id}:${t.payment_intent}`, title: `Payout ${po.id} includes a ${dollars(t.amount)} charge that isn’t on any ledger`, detail: `Processor id ${t.payment_intent}.` });
        }
      }
      if (ours.length === items.length && items.length) {
        const net = items.reduce((s, t) => s + (Number(t.net) || 0), 0);
        if (net !== po.amount) ex.push({ key: `payout:${po.id}`, title: `Payout ${po.id} (${dollars(po.amount)}) doesn’t add up to its charges less fees and refunds (${dollars(net)})`, detail: 'Compare the payout report at the processor with the ledger.' });
      }
    }
  }
  const keys = [...new Set(ex.map((e) => e.key))];
  for (const e of ex) await raiseIssue(db, { practiceId, kind: 'payment', key: e.key, role: 'billing', title: e.title, detail: e.detail });
  for (const k of had.filter((x) => !keys.includes(x))) await resolveIssue(db, practiceId, k, `Resolved: the ${day} check found it matched`);
  await db.run("UPDATE billing_recon_days SET status = ?, processor_total = ?, ledger_total = ?, matched = ?, exceptions = ?, payouts = ?, detail = ?, checked_at = datetime('now') WHERE id = ?",
    keys.length ? 'exceptions' : 'ok', cards.processor_total, cards.ledger_total, cards.matched, keys.length, payouts, JSON.stringify({ keys, exceptions: ex.map(({ key, title }) => ({ key, title })) }), row.id);
  return { day, available: true, matched: cards.matched, exceptions: ex.length, payouts };
}

// ---- BL1: set up payments ----
const TERMS_VERSION = 1;
const cardLabel = (m) => (m ? `${m.brand || 'card'} ending ${m.last4}${m.exp_month ? ` (exp ${String(m.exp_month).padStart(2, '0')}/${String(m.exp_year).slice(-2)})` : ''}` : null);

// The set-up in plain numbers and the exact words the patient agrees to. Deterministic: the same inputs give the
// same terms and hash, so what was shown is what gets signed (the hash is checked when it's agreed).
export async function setupPreview(db, practiceId, input = {}) {
  const b = input || {};
  const kinds = ['payment_plan', 'recurring', 'membership', 'ortho_case'];
  if (!kinds.includes(b.kind)) throw new HttpError(400, `kind must be one of ${kinds.join(', ')}`);
  const person = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', Number(b.patient_id), practiceId);
  if (!person) throw new HttpError(404, 'Patient not found');
  const account = await patientOf(db, person.id);
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  const today = await todayFor(db, practiceId);
  let method = null;
  if (b.payment_method_id) {
    method = await db.get('SELECT * FROM payment_methods WHERE id = ? AND practice_id = ? AND patient_id = ? AND removed_at IS NULL', Number(b.payment_method_id), practiceId, account.id);
    if (!method) throw new HttpError(400, 'That card isn’t on file for this account');
  }
  const int = (v, name, min, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  const settings = await billingSettings(db, practiceId);
  const spec = { v: TERMS_VERSION, kind: b.kind, patient_id: account.id, payment_method_id: method?.id ?? null, today };
  const lines = [];
  const schedule = [];
  const fees = [];
  if (b.kind === 'payment_plan') {
    const owed = await collectible(db, practiceId, account.id);
    const total = b.total == null ? owed : int(b.total, 'Total (cents)', 100, 100_000_000);
    if (total < 100) throw new HttpError(400, 'There’s nothing owed to set a plan up for — enter the total');
    const down = int(b.down_payment ?? 0, 'Down payment (cents)', 0, total - 1);
    const months = int(b.months, 'Months', 1, 60);
    const day = int(b.day_of_month ?? Number(today.slice(8, 10)), 'Day of the month', 1, 28);
    const financed = total - down;
    if (financed < months) throw new HttpError(400, 'The amount is too small to split over that many months');
    const first = firstOn(addDays(today, 1), day);
    const base = Math.floor(financed / months);
    const extra = financed - base * months;
    const plan = { start_date: first, frequency: 'monthly' };
    for (let i = 0; i < months; i++) schedule.push({ n: i + 1, date: installmentDate(plan, i), amount: base + (i < extra ? 1 : 0) });
    Object.assign(spec, { total, down_payment: down, months, day_of_month: day, start_date: first, installment_amount: Math.ceil(financed / months) });
    for (const fee of await db.all("SELECT * FROM billing_fees WHERE practice_id = ? AND occasion = 'plan_setup' AND active = 1 ORDER BY id", practiceId)) {
      const chosen = fee.applies === 'automatic' || (Array.isArray(b.fees) && b.fees.map(Number).includes(fee.id));
      const amount = feeAmount(fee, total);
      if (chosen && amount > 0) fees.push({ fee_id: fee.id, name: fee.name, amount });
    }
    spec.fees = fees;
    lines.push(`${down ? `${dollars(down)} down payment today, then ` : ''}${months} monthly payment${months > 1 ? 's' : ''} of ${dollars(schedule[0].amount)}${extra && extra < months ? ` (the last ${months - extra} are ${dollars(base)})` : ''} on the ${day}${['th', 'st', 'nd', 'rd'][day % 10 > 3 || [11, 12, 13].includes(day) ? 0 : day % 10]} of each month, starting ${first}. Total ${dollars(total)}.`);
  } else if (b.kind === 'recurring') {
    const amount = int(b.amount, 'Amount (cents)', 100, 10_000_000);
    const day = int(b.day_of_month ?? Number(today.slice(8, 10)), 'Day of the month', 1, 28);
    const max = b.max_charges == null || b.max_charges === '' ? null : int(b.max_charges, 'Number of payments', 1, 120);
    const end = b.end_date ? String(b.end_date) : null;
    if (end && (!/^\d{4}-\d{2}-\d{2}$/.test(end) || end <= today)) throw new HttpError(400, 'The end date must be a date after today');
    const first = firstOn(b.start_now ? today : addDays(today, 1), day);
    const description = String(b.description || 'Monthly payment toward the account').trim().slice(0, 120);
    Object.assign(spec, { amount, day_of_month: day, start_date: first, max_charges: max, end_date: end, description });
    for (let i = 0; i < Math.min(3, max || 3); i++) schedule.push({ n: i + 1, date: monthlyOn(first, day, i), amount });
    lines.push(`${dollars(amount)} on the ${day}${['th', 'st', 'nd', 'rd'][day % 10 > 3 || [11, 12, 13].includes(day) ? 0 : day % 10]} of each month, starting ${first}${max ? `, ${max} payments` : ''}${end ? `, until ${end}` : ''} — ${description}. Never more than the account owes; it stops charging while nothing is owed.`);
  } else {
    const s = SOURCES[b.kind];
    const src = await db.get(`SELECT * FROM ${s.table} WHERE id = ? AND practice_id = ?`, Number(b.source_id), practiceId);
    const ids = await householdIds(db, practiceId, account.id);
    if (!src || !ids.includes(src.patient_id)) throw new HttpError(404, b.kind === 'membership' ? 'Membership not found for this account' : 'Orthodontic contract not found for this account');
    if (b.kind === 'membership') {
      if (!['active', 'past_due'].includes(src.status)) throw new HttpError(409, 'That membership isn’t active');
      const plan = await db.get('SELECT name, price, interval FROM membership_plans WHERE id = ?', src.plan_id);
      Object.assign(spec, { source_id: src.id });
      schedule.push({ n: 1, date: src.next_bill_date, amount: plan.price });
      lines.push(`${plan.name} membership: ${dollars(plan.price)} each ${plan.interval}, next on ${src.next_bill_date}, until the membership is cancelled.`);
    } else {
      if (!['active', 'retention'].includes(src.status)) throw new HttpError(409, 'That orthodontic contract isn’t active');
      Object.assign(spec, { source_id: src.id });
      const left = src.months - src.billed_months;
      schedule.push({ n: 1, date: src.next_bill_date, amount: src.monthly_amount });
      lines.push(`Orthodontic treatment: ${dollars(src.monthly_amount)} a month for the ${left} month${left === 1 ? '' : 's'} left on the contract, next on ${src.next_bill_date}.`);
    }
  }
  // Fees that can come up later, and the surcharge, are part of what the patient agrees to.
  const later = await db.all("SELECT * FROM billing_fees WHERE practice_id = ? AND active = 1 AND applies = 'automatic' AND occasion IN ('late_payment','returned_payment') ORDER BY id", practiceId);
  const feeLines = [
    ...fees.map((f) => `${f.name}: ${dollars(f.amount)}, added to the account when the plan is set up.`),
    ...later.filter((f) => b.kind === 'payment_plan' || f.occasion === 'returned_payment').map((f) => `${f.name}: ${feeWords(f)} ${f.occasion === 'late_payment' ? `if a plan payment is more than ${f.grace_days} day${f.grace_days === 1 ? '' : 's'} late` : 'if a payment is returned or disputed and lost'}.`),
  ];
  let surchargeBps = 0;
  if (settings.pass_through === 'surcharge' && b.surcharge !== false) {
    const cap = surchargeCap(await practiceState(db, practiceId), settings.processing_cost_bps);
    if (cap.max != null) surchargeBps = Math.min(settings.surcharge_bps, cap.max);
  }
  spec.surcharge_bps = surchargeBps;
  const retry = settings.retry_days;
  const terms = [
    `Payment authorization — ${practice.name}`,
    `I, ${nameOf(account)}, authorize ${practice.name} to charge ${method ? `my ${cardLabel(method)}` : 'the card I add'} automatically:`,
    ...lines.map((l) => `• ${l}`),
    ...feeLines.map((l) => `• ${l}`),
    ...(surchargeBps ? [`• If the card is a credit card, a ${pctText(surchargeBps)} card surcharge is added to each payment (it isn’t more than what card processing costs). Debit cards have no surcharge.`] : []),
    `• Each charge is only for what I owe, and I get a receipt for each. If a payment doesn’t go through, the office will try again ${retry.map((d) => `on day ${d}`).join(', ')} and let me know.`,
    `• I can stop automatic payments at any time by calling ${practice.phone || 'the office'}; what I already owe stays owed.`,
  ].join('\n');
  const termsHash = createHash('sha256').update(JSON.stringify({ spec, terms })).digest('hex');
  return {
    kind: b.kind, account: { id: account.id, name: nameOf(account) }, card: method ? { id: method.id, label: cardLabel(method), funding: method.funding || null } : null,
    schedule, fees, surcharge_bps: surchargeBps, terms, terms_hash: termsHash, spec,
  };
}

// Records the set-up as a pending authorization (optionally sent to the patient by text/email link), or — agreed on
// screen now — carries it out. Idempotent: the same terms for the same account again return the same result.
export async function startSetup(db, payments, messenger, { user, input, ip = null, userAgent = null }) {
  requireHuman('setting up automatic payments');
  const pid = user.practice_id;
  const preview = await setupPreview(db, pid, input);
  if (!input.terms_hash || input.terms_hash !== preview.terms_hash) throw new HttpError(409, 'The terms have changed since they were shown — please look them over again', { changed: true, preview });
  const how = input.agree?.how === 'link' ? 'link' : 'screen';
  if (how === 'screen') {
    if (!preview.card) throw new HttpError(400, 'Choose the card on file (or send the patient a link to add one and agree)');
    if (!String(input.agree?.signer_name || '').trim()) throw new HttpError(400, 'Type the name of the person agreeing');
  }
  let auth = await db.get('SELECT * FROM billing_authorizations WHERE patient_id = ? AND terms_hash = ?', preview.account.id, preview.terms_hash);
  if (auth?.status === 'signed') return { authorization: auth, replay: true };
  if (!auth) {
    try {
      const id = await db.savepoint(() => insert(db, 'billing_authorizations', {
        practice_id: pid, patient_id: preview.account.id, kind: preview.kind, source_id: preview.spec.source_id ?? null, payment_method_id: preview.card?.id ?? null,
        setup: JSON.stringify(preview.spec), terms: preview.terms, terms_hash: preview.terms_hash, surcharge_bps: preview.surcharge_bps, created_by: user.id,
      }));
      auth = await db.get('SELECT * FROM billing_authorizations WHERE id = ?', id);
    } catch (err) {
      if (!/unique|duplicate/i.test(String(err.message)) && err.code !== '23505') throw err;
      auth = await db.get('SELECT * FROM billing_authorizations WHERE patient_id = ? AND terms_hash = ?', preview.account.id, preview.terms_hash);
      if (auth?.status === 'signed') return { authorization: auth, replay: true };
    }
  } else if (auth.status !== 'pending') {
    await db.run("UPDATE billing_authorizations SET status = 'pending', revoked_at = NULL, revoke_reason = NULL WHERE id = ?", auth.id);
  }
  await audit(db, { user }, 'billing.setup_start', 'billing_authorizations', auth.id, { kind: preview.kind, how }, { patientId: preview.account.id });
  if (how === 'link') {
    const account = await db.get('SELECT * FROM patients WHERE id = ?', preview.account.id);
    const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', pid);
    const link = await makeLink(db, { practiceId: pid, patientId: account.id, kind: 'authorize', authorizationId: auth.id, userId: user.id, days: 14 });
    const target = preferredChannel(account, input.agree?.send && input.agree.send !== 'auto' ? input.agree.send : undefined);
    if (!target) throw new HttpError(400, 'The patient has no phone or email we can use (or has opted out) — have them agree on screen');
    const msg = await sendMessage(db, messenger, {
      practiceId: pid, patientId: account.id, userId: user.id, kind: 'payment_request', channel: target.channel, to: target.to,
      subject: `Please review your payment set-up — ${practice.name}`,
      body: `Hi ${account.first_name}, this is ${practice.name}. Please review and agree to your automatic payments here: ${link.url} — questions? Call ${practice.phone || 'us'}.`,
    });
    await db.run('UPDATE billing_links SET message_id = ? WHERE id = ?', msg?.id ?? null, link.id);
    return { authorization: await db.get('SELECT * FROM billing_authorizations WHERE id = ?', auth.id), link: { id: link.id, url: link.url }, message: msg };
  }
  return finishSetup(db, payments, messenger, auth, {
    methodId: preview.card.id, signer: String(input.agree.signer_name).trim().slice(0, 120), signature: input.agree.signature || null, via: 'screen', ip, userAgent, userId: user.id,
  });
}

// Carries out a set-up the patient agreed to: the down payment (charged first — if it's declined nothing is set up),
// then in one transaction the plan / recurring charge / autopay switch, the set-up fees and the signed authorization.
export async function finishSetup(db, payments, messenger, auth, { methodId, signer, signature = null, via, ip = null, userAgent = null, userId = null }) {
  requireHuman('setting up automatic payments');
  if (auth.status === 'signed') return { authorization: auth, replay: true };
  if (auth.status !== 'pending') throw new HttpError(409, 'This set-up is no longer open — ask the office for a new link');
  const spec = JSON.parse(auth.setup);
  const pid = auth.practice_id;
  const method = await db.get('SELECT * FROM payment_methods WHERE id = ? AND practice_id = ? AND patient_id = ? AND removed_at IS NULL', methodId, pid, auth.patient_id);
  if (!method) throw new HttpError(400, 'Add a card first');
  if (signature && (typeof signature !== 'string' || !/^data:image\/png;base64,/.test(signature) || signature.length > 200_000)) throw new HttpError(400, 'The signature must be a PNG image');
  const today = await todayFor(db, pid);
  const practice = await db.get('SELECT name FROM practices WHERE id = ?', pid);
  let down = null;
  if (spec.kind === 'payment_plan' && spec.down_payment > 0) {
    if (!payments?.enabled) throw new HttpError(409, 'Card payments aren’t set up — take the down payment at the desk first');
    down = await trackedCharge(db, payments, {
      method, amount: spec.down_payment, description: `${practice.name} — payment plan down payment`, idempotencyKey: `setup-${auth.id}-down-${method.id}`, metadata: { billing_authorization_id: auth.id, patient_id: auth.patient_id },
    }, { practiceId: pid, patientId: auth.patient_id, sourceType: 'setup', sourceId: auth.id, authorizedBps: auth.surcharge_bps });
    if (down.ambiguous) throw new HttpError(503, 'We couldn’t confirm the down payment just now — nothing was set up. Try again in a minute (it won’t be charged twice).');
    if (!down.ok) throw new HttpError(402, `The down payment wasn’t approved (${down.reason}). Nothing was set up — try another card.`, { declined: true });
  }
  const result = await db.tx(async () => {
    const fresh = await db.get('SELECT status FROM billing_authorizations WHERE id = ?', auth.id);
    if (fresh.status === 'signed') return { replay: true };
    let sourceId = spec.source_id ?? null;
    if (spec.kind === 'payment_plan') {
      sourceId = await insert(db, 'payment_plans', {
        practice_id: pid, patient_id: auth.patient_id, total: spec.total, down_payment: spec.down_payment, installment_amount: spec.installment_amount, installments: spec.months,
        frequency: 'monthly', start_date: spec.start_date, notes: `Set up with signed authorization #${auth.id}`, created_by: userId, autopay_method_id: method.id,
      });
    } else if (spec.kind === 'recurring') {
      const account = await db.get('SELECT location_id FROM patients WHERE id = ?', auth.patient_id);
      sourceId = await insert(db, 'recurring_charges', {
        practice_id: pid, location_id: account?.location_id ?? null, patient_id: auth.patient_id, amount: spec.amount, day_of_month: spec.day_of_month, next_charge_date: spec.start_date,
        end_date: spec.end_date, max_charges: spec.max_charges, description: spec.description, payment_method_id: method.id, authorization_id: auth.id, created_by: userId,
      });
    } else {
      const s = SOURCES[spec.kind];
      await update(db, s.table, sourceId, pid, { payment_method_id: method.id, autopay: 1 });
    }
    if (down?.ok) {
      await postPaymentOnce(db, {
        practice_id: pid, patient_id: auth.patient_id, amount: -down.total, method: 'credit_card', reference: down.reference, entry_date: today, created_by: userId,
        description: `Payment plan down payment (${method.brand || 'card'} •••• ${method.last4})`,
      });
    }
    const posted = [];
    for (const f of spec.fees || []) {
      const fee = await db.get('SELECT * FROM billing_fees WHERE id = ? AND practice_id = ?', f.fee_id, pid);
      if (!fee?.active) continue;
      const c = await applyFee(db, fee, { patientId: auth.patient_id, sourceKey: `setup:${auth.id}`, basis: spec.total, userId, date: today, note: `payment plan #${sourceId}` });
      if (c) posted.push(c.id);
    }
    const { changes } = await db.run(
      "UPDATE billing_authorizations SET status = 'signed', source_id = ?, payment_method_id = ?, signer_name = ?, signature_image = ?, signed_via = ?, signed_at = datetime('now'), ip = ?, user_agent = ? WHERE id = ? AND status = 'pending'",
      sourceId, method.id, signer, signature, via, ip, userAgent ? String(userAgent).slice(0, 300) : null, auth.id,
    );
    if (!changes) throw new HttpError(409, 'This set-up was just completed — refresh');
    return { source_id: sourceId, fee_charges: posted };
  });
  const signed = await db.get('SELECT * FROM billing_authorizations WHERE id = ?', auth.id);
  if (result.replay) return { authorization: signed, replay: true };
  await audit(db, userId ? { user: { practice_id: pid, id: userId } } : system(pid), 'billing.setup', 'billing_authorizations', auth.id, {
    kind: spec.kind, source_id: result.source_id, via, signer, down_payment: down?.total ?? 0, fees: result.fee_charges,
  }, { patientId: auth.patient_id });
  if (down?.ok) {
    const entry = await db.get("SELECT id FROM ledger_entries WHERE practice_id = ? AND type = 'payment' AND reference = ?", pid, down.reference);
    if (entry) await autoReceipt(db, messenger, entry.id);
  }
  return { authorization: signed, source_id: result.source_id, down_payment: down ? { amount: down.total, surcharge: down.surcharge } : null, fee_charges: result.fee_charges };
}

// ---- Links opened by the patient ----
export async function linkByToken(db, token) {
  const link = await db.get('SELECT * FROM billing_links WHERE token_hash = ?', hashToken(token));
  if (!link) throw new HttpError(404, 'This link isn’t valid — please call the office');
  return link;
}
export const linkExpired = (link) => link.expires_at < utcStamp(Date.now());

// A card saved from an update-card link: it replaces the old card everywhere it was used and the declined
// charges are tried again straight away.
export async function cardFromLink(db, payments, messenger, link, methodId) {
  const today = await todayFor(db, link.practice_id);
  await db.run('UPDATE billing_links SET new_method_id = ? WHERE id = ?', methodId, link.id);
  if (link.kind !== 'update_card') return { saved: true };
  const changed = link.old_method_id ? await replaceCard(db, { practiceId: link.practice_id, patientId: link.patient_id, oldMethodId: link.old_method_id, newMethodId: methodId, today }) : [];
  await db.run("UPDATE billing_links SET used_at = COALESCE(used_at, datetime('now')) WHERE id = ?", link.id);
  const retried = [];
  for (const s of changed) {
    if (!(await openDunning(db, s.type, s.id))) continue;
    try {
      retried.push({ ...s, result: await retryNow(db, payments, messenger, s.type, s.id) });
    } catch (err) {
      await failed(db, { practiceId: link.practice_id, kind: 'payment', key: issueKey(s.type, s.id), role: 'billing', patientId: link.patient_id, title: 'A declined payment couldn’t be retried after the patient updated their card' })(err);
    }
  }
  return { saved: true, updated: changed.length, retried };
}

// ---- BL1: the one list ----
export async function activeList(db, practiceId) {
  const today = await todayFor(db, practiceId);
  const rows = [];
  const card = async (id) => (id ? db.get('SELECT id, brand, last4, exp_month, exp_year, funding, removed_at FROM payment_methods WHERE id = ?', id) : null);
  const horizon = addDays(today, (await billingSettings(db, practiceId)).expiring_days);
  const cardView = (m) => (m ? { id: m.id, label: cardLabel(m), removed: !!m.removed_at, expiring: m.exp_year ? lastDayOf(m.exp_year, m.exp_month) <= horizon : false } : null);
  const auths = new Map((await db.all("SELECT kind, source_id, id, signed_at FROM billing_authorizations WHERE practice_id = ? AND status = 'signed'", practiceId)).map((a) => [`${a.kind}:${a.source_id}`, a]));
  const dunning = new Map((await db.all('SELECT * FROM billing_dunning WHERE practice_id = ? AND live_key IS NOT NULL', practiceId)).map((d) => [`${d.source_type}:${d.source_id}`, d]));
  const who = new Map((await db.all('SELECT id, first_name, last_name FROM patients WHERE practice_id = ?', practiceId)).map((p) => [p.id, p]));
  const push = async (type, id, patientId, label, next, amount, methodId, extra = {}) => {
    const d = dunning.get(`${type}:${id}`);
    const a = auths.get(`${type}:${id}`);
    rows.push({
      kind: type, id, patient_id: patientId, patient: nameOf(who.get(patientId)), label, next_date: next, next_amount: amount, card: cardView(await card(methodId)),
      autopay: !!methodId, authorization: a ? { id: a.id, signed_at: a.signed_at } : null,
      status: d ? d.status : extra.status || 'ok', dunning: d ? { id: d.id, failures: d.failures, next_retry_on: d.next_retry_on, reason: d.last_reason } : null, ...extra,
    });
  };
  for (const p of await db.all("SELECT * FROM payment_plans WHERE practice_id = ? AND status = 'active' ORDER BY id", practiceId)) {
    const s = await planStatus(db, p, today);
    await push('payment_plan', p.id, p.patient_id, `Payment plan — ${dollars(s.remaining)} left of ${dollars(p.total - p.down_payment)}`, s.next_due_date, s.next_due_amount, p.autopay_method_id,
      { past_due: s.past_due, status: p.autopay_paused ? 'paused' : s.past_due ? 'past_due' : 'ok' });
  }
  for (const m of await db.all("SELECT m.*, mp.name AS plan_name, mp.price FROM memberships m JOIN membership_plans mp ON mp.id = m.plan_id WHERE m.practice_id = ? AND m.status IN ('active','past_due') ORDER BY m.id", practiceId)) {
    await push('membership', m.id, m.patient_id, `${m.plan_name} membership`, m.next_bill_date, m.price, m.autopay ? m.payment_method_id : null, { status: m.status === 'past_due' ? 'past_due' : 'ok' });
  }
  for (const c of await db.all("SELECT * FROM ortho_cases WHERE practice_id = ? AND status IN ('active','retention') AND billed_months < months ORDER BY id", practiceId)) {
    await push('ortho_case', c.id, c.patient_id, `Orthodontics — month ${c.billed_months + 1} of ${c.months}`, c.next_bill_date, c.monthly_amount, c.autopay ? c.payment_method_id : null);
  }
  for (const r of await db.all("SELECT * FROM recurring_charges WHERE practice_id = ? AND status IN ('active','paused') ORDER BY id", practiceId)) {
    await push('recurring', r.id, r.patient_id, r.description, r.next_charge_date, r.amount, r.payment_method_id, { status: r.status === 'paused' ? 'paused' : 'ok' });
  }
  const pending = await db.all(
    `SELECT a.id, a.kind, a.patient_id, a.created_at, p.first_name, p.last_name FROM billing_authorizations a JOIN patients p ON p.id = a.patient_id
     WHERE a.practice_id = ? AND a.status = 'pending' ORDER BY a.id DESC LIMIT 100`, practiceId,
  );
  rows.sort((a, b) => String(a.next_date || '9999').localeCompare(String(b.next_date || '9999')));
  return {
    today, items: rows,
    waiting_for_patient: pending.map((a) => ({ id: a.id, kind: a.kind, patient_id: a.patient_id, patient: nameOf(a), sent_at: a.created_at })),
    counts: { total: rows.length, retrying: rows.filter((r) => r.status === 'retrying').length, paused: rows.filter((r) => r.status === 'paused').length, no_card: rows.filter((r) => !r.autopay).length },
  };
}

// Everything billing did on an account, newest first ("every step visible on the patient's account").
export async function accountActivity(db, practiceId, patientId) {
  const account = await patientOf(db, patientId);
  const ids = await householdIds(db, practiceId, account.id);
  const L = ids.map(() => '?').join(',');
  const q = (sql) => db.all(sql, practiceId, ...ids);
  const events = [
    ...(await q(`SELECT id, created_at AS at, source_type, amount, surcharge, status, reason, tries FROM billing_attempts WHERE practice_id = ? AND patient_id IN (${L})`)).map((a) => ({
      at: a.at, type: 'charge', text: `${a.status === 'succeeded' ? 'Charged' : a.status === 'declined' ? 'Declined' : a.status === 'unclear' ? 'Checking' : 'Charging'} ${dollars(a.amount + a.surcharge)} — ${SOURCES[a.source_type]?.label || 'down payment'}${a.reason ? ` (${a.reason})` : ''}`,
    })),
    ...(await q(`SELECT * FROM billing_dunning WHERE practice_id = ? AND patient_id IN (${L})`)).map((d) => ({
      at: d.created_at, type: 'dunning', text: `${SOURCES[d.source_type]?.label || 'Payment'}: ${d.failures} decline${d.failures === 1 ? '' : 's'} — ${d.status === 'retrying' ? `next try ${d.next_retry_on}` : d.status}${d.close_note ? ` (${d.close_note})` : ''}`, dunning_id: d.id, status: d.status,
    })),
    ...(await q(`SELECT l.id, l.kind, l.created_at, l.used_at, l.opened_at FROM billing_links l WHERE l.practice_id = ? AND l.patient_id IN (${L})`)).map((l) => ({
      at: l.created_at, type: 'link', text: `${l.kind === 'authorize' ? 'Sent a link to agree to automatic payments' : 'Sent an update-card link'}${l.used_at ? ' — done' : l.opened_at ? ' — opened' : ''}`,
    })),
    ...(await q(`SELECT a.id, a.kind, a.status, a.created_at, a.signed_at, a.signer_name, a.signed_via, a.revoked_at FROM billing_authorizations a WHERE a.practice_id = ? AND a.patient_id IN (${L})`)).map((a) => ({
      at: a.signed_at || a.created_at, type: 'authorization', authorization_id: a.id, text: a.status === 'signed' ? `${a.signer_name} agreed to automatic payments (${a.kind.replace('_', ' ')}, ${a.signed_via === 'link' ? 'by link' : 'on screen'})` : `Automatic payments ${a.status} (${a.kind.replace('_', ' ')})`,
    })),
    ...(await q(`SELECT c.*, f.name FROM billing_fee_charges c JOIN billing_fees f ON f.id = c.fee_id WHERE c.practice_id = ? AND c.patient_id IN (${L})`)).map((c) => ({
      at: c.created_at, type: 'fee', fee_charge_id: c.id, status: c.status, amount: c.amount, text: `${c.name}: ${dollars(c.amount)}${c.status === 'waived' ? ` — waived (${c.waive_reason})` : ''}`,
    })),
    ...(await q(`SELECT * FROM billing_disputes WHERE practice_id = ? AND patient_id IN (${L})`)).map((d) => ({
      at: d.created_at, type: d.kind, text: d.kind === 'dispute' ? `Card dispute of ${dollars(d.amount)} — ${d.status}${d.respond_by && d.status === 'open' ? ` (respond by ${d.respond_by})` : ''}` : `Refund of ${dollars(d.amount)} made at the processor`,
    })),
    ...(await q(`SELECT * FROM billing_notices WHERE practice_id = ? AND patient_id IN (${L})`)).map((n) => ({ at: n.created_at, type: 'notice', text: 'Asked to update a card that expires soon' })),
  ];
  events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { account_id: account.id, events: events.slice(0, 200) };
}

// ---- The job ----
// Hourly: recurring charges due, declined ortho months to retry, expiring cards, automatic office fees, and — once
// a day per practice — yesterday's check with the processor. (Plan autopay and membership billing run in their own
// jobs; they follow the same retry schedule through mayCharge.)
export async function runBillingAutopilot(db, payments, messenger, { appUrl: url = null } = {}) {
  setAppUrl(url);
  return withActor({ source: 'automation', actor: 'Billing autopilot' }, async () => {
    const stats = { recurring: 0, ortho_retries: 0, expiring: 0, fees: 0, reconciled: 0, closed: 0 };
    stats.closed = await closeEndedDunning(db);
    stats.recurring = (await runRecurringCharges(db, payments, messenger)).length;
    if (payments?.enabled) {
      for (const d of await db.all("SELECT * FROM billing_dunning WHERE source_type = 'ortho_case' AND live_key IS NOT NULL")) {
        const c = await db.get('SELECT payment_method_id FROM ortho_cases WHERE id = ?', d.source_id);
        if (!(await mayCharge(db, 'ortho_case', d.source_id, c?.payment_method_id, await todayFor(db, d.practice_id)))) continue;
        if (await retryOrtho(db, payments, messenger, d.source_id)) stats.ortho_retries++;
      }
    }
    for (const { id } of await db.all('SELECT id FROM practices ORDER BY id')) {
      try {
        stats.expiring += await runExpiringCards(db, messenger, id);
        const f = await runAutoFees(db, id);
        stats.fees += f.late + f.missed + f.statement;
        if (payments?.listCharges) {
          const yesterday = addDays(await todayFor(db, id), -1);
          if (!(await db.get('SELECT id FROM billing_recon_days WHERE practice_id = ? AND day = ?', id, yesterday))) {
            await reconcileDay(db, payments, id, yesterday);
            stats.reconciled++;
          }
        }
      } catch (err) {
        await raiseIssue(db, { practiceId: id, kind: 'payment', key: 'billing-autopilot', role: 'billing', title: 'The billing autopilot couldn’t finish its hourly run', detail: err.message });
      }
    }
    return stats;
  });
}

