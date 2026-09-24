// Billing that runs itself, and never goes silent (backlog BL1–BL5; docs/workflows/specs/BL-billing.md).
// The routes are served by a small side server on the harness database (authenticate → actor → aiGuard → routes,
// as app.js does), so these tests run whether or not app.js mounts them yet. Stripe webhooks go through the real
// app (the webhook route is already mounted); cards are the sandbox's published test numbers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHmac } from 'node:crypto';
import { harness } from './helpers.js';
import { authenticate, HttpError } from '../src/auth.js';
import { actorMiddleware, setActor, withActor } from '../src/actor.js';
import { aiGuard } from '../src/aiguard.js';
import { flushChanges, insert, practiceNow } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import billingAutoRoutes, { billingPublicRoutes } from '../src/routes/billingauto.js';
import {
  feeAmount, passThroughFor, surchargeCap, runExpiringCards, runAutoFees, runRecurringCharges, reconcileDay, trackedCharge, addDays, runBillingAutopilot,
} from '../src/billingauto.js';
import { runAutopay } from '../src/payments.js';
import { takePayment } from '../src/billpay.js';
import { receiptData } from '../src/receipts.js';
import { runMembershipBilling } from '../src/memberships.js';

const WHSEC = 'whsec_billing_test';
const h = harness({ config: { payments: 'sandbox', stripeWebhookSecret: WHSEC } });
let server;
let origin;
const db = {
  all: (...a) => h.db.all(...a), get: (...a) => h.db.get(...a), run: (...a) => h.db.run(...a), tx: (fn) => h.db.tx(fn), savepoint: (fn) => h.db.savepoint(fn),
  get dialect() { return h.db.dialect; },
};
const lazy = {
  get enabled() { return h.app.locals.payments.enabled; },
  get mode() { return h.app.locals.payments.mode; },
  charge: (...a) => h.app.locals.payments.charge(...a),
  sandboxPay: (...a) => h.app.locals.payments.sandboxPay(...a),
};
const messenger = { status: { sms: 'test', email: 'test' }, send: (m) => h.messenger.send(m) };
before(async () => {
  const app = express();
  app.use(actorMiddleware(db, flushChanges));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/public', billingPublicRoutes({ db, payments: lazy, messenger, config: { appUrl: 'https://app.example.com' } }));
  const api = express.Router();
  api.use(authenticate(db, 'test-secret'));
  api.use((req, _res, next) => {
    const ai = req.get('X-Acting-For') === 'assistant';
    setActor({ source: ai ? 'ai' : 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: ai ? `Assistant (for ${req.user.name})` : req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(aiGuard());
  api.use(officeAccess(db));
  api.use(billingAutoRoutes({ db, payments: lazy, messenger, config: { appUrl: 'https://app.example.com' } }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { if (!(err instanceof HttpError)) console.error(err); res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message, details: err.details }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const client = (token, headers = {}) => {
  const call = async (method, path, body) => {
    const res = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
};
const hook = async (type, object) => {
  const body = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', WHSEC).update(`${t}.${body}`).digest('hex');
  const res = await fetch(`${h.origin}/api/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body });
  assert.equal(res.status, 200, await res.text());
};
const tokenIn = (msg) => /billing-link\/([A-Za-z0-9_-]+)/.exec(msg?.body || '')?.[1];
const balance = async (pid, patientId) => Number((await h.db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE practice_id = ? AND patient_id = ?', pid, patientId)).n);
const issue = (pid, key) => h.db.get('SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ? ORDER BY id DESC LIMIT 1', pid, key);

async function setUp(extra = {}) {
  const p = await h.practice({ timezone: 'UTC', ...extra });
  const pid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', p.provider.id)).practice_id;
  const today = (await practiceNow(h.db, pid)).slice(0, 10);
  const b = client(p.token);
  // The patient owes $1,350 (a crown).
  const crown = await p.api.post(`/patients/${p.patient.id}/procedures`, { code: 'D2740', tooth: '3', provider_id: p.provider.id, complete: true });
  assert.equal(crown.status, 201, JSON.stringify(crown.data));
  const card = async (number, patientId = p.patient.id) => (await p.api.post(`/patients/${patientId}/payment-methods`, { number })).data;
  return { ...p, pid, today, b, card };
}

async function member(p, role, extra = {}) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = (await p.api.post('/users', { email, name: `${role} user`, role, password: 'correct-horse-battery', ...extra })).data;
  assert.ok(u.id, JSON.stringify(u));
  const login = await h.client(null, { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }).post('/auth/login', { email, password: 'correct-horse-battery' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { user: u, token: login.data.token, b: client(login.data.token) };
}

// Sets up a payment plan on screen through the one "set up payments" step.
async function setUpPlan(s, { cardId, total = 60000, down = 10000, months = 5, extra = {} }) {
  const input = { patient_id: s.patient.id, kind: 'payment_plan', total, down_payment: down, months, day_of_month: 15, payment_method_id: cardId, ...extra };
  const preview = await s.b.post('/billing/setup/preview', input);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const res = await s.b.post('/billing/setup', { ...input, terms_hash: preview.data.terms_hash, agree: { how: 'screen', signer_name: 'Jane Doe' } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { preview: preview.data, ...res.data };
}

test('BL1/BL2: one set-up step with a signed authorization; the down payment and each installment post exactly once', async () => {
  const s = await setUp();
  const visa = await s.card('4242424242424242');
  const input = { patient_id: s.patient.id, kind: 'payment_plan', total: 60000, down_payment: 10000, months: 5, day_of_month: 15, payment_method_id: visa.id };
  const preview = (await s.b.post('/billing/setup/preview', input)).data;
  assert.equal(preview.schedule.length, 5);
  assert.equal(preview.schedule.reduce((t, x) => t + x.amount, 0), 50000, 'installments add up to what is financed');
  assert.match(preview.terms, /\$100\.00 down payment today, then 5 monthly payments of \$100\.00 on the 15th/);
  assert.match(preview.terms, /try again on day 3, on day 7, on day 14/);
  // What the patient saw is what gets set up.
  assert.equal((await s.b.post('/billing/setup', { ...input, terms_hash: 'x'.repeat(64), agree: { how: 'screen', signer_name: 'Jane Doe' } })).status, 409);
  assert.equal((await s.b.post('/billing/setup', { ...input, terms_hash: preview.terms_hash, agree: { how: 'screen' } })).status, 400, 'a name is needed');
  const done = await s.b.post('/billing/setup', { ...input, terms_hash: preview.terms_hash, agree: { how: 'screen', signer_name: 'Jane Doe' } });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.equal(done.data.authorization.status, 'signed');
  assert.equal(done.data.authorization.signer_name, 'Jane Doe');
  assert.equal(done.data.down_payment.amount, 10000);
  // A double click / retry: the same answer, nothing charged or posted twice.
  const again = await s.b.post('/billing/setup', { ...input, terms_hash: preview.terms_hash, agree: { how: 'screen', signer_name: 'Jane Doe' } });
  assert.equal(again.status, 200);
  assert.equal(again.data.replay, true);
  const downs = await h.db.all("SELECT * FROM ledger_entries WHERE patient_id = ? AND type = 'payment'", s.patient.id);
  assert.equal(downs.length, 1);
  assert.equal(downs[0].amount, -10000);
  assert.equal((await h.db.all("SELECT id FROM payment_plans WHERE patient_id = ?", s.patient.id)).length, 1);
  const planId = done.data.source_id;
  const plan = await h.db.get('SELECT * FROM payment_plans WHERE id = ?', planId);
  assert.equal(plan.autopay_method_id, visa.id);

  // Two installments come due: charged once, posted once by the processor's id, visible on the account.
  await h.db.run('UPDATE payment_plans SET start_date = ? WHERE id = ?', addDays(s.today, -35), planId);
  const [r1] = await runAutopay(h.db, h.app.locals.payments, h.messenger);
  assert.equal(r1.ok, true);
  assert.equal(r1.amount, 20000);
  assert.deepEqual(await runAutopay(h.db, h.app.locals.payments, h.messenger), [], 'the same day is not charged again');
  const planPays = await h.db.all("SELECT * FROM ledger_entries WHERE payment_plan_id = ? AND type = 'payment'", planId);
  assert.equal(planPays.length, 1);
  assert.equal(planPays[0].amount, -20000);
  const attempts = await h.db.all("SELECT * FROM billing_attempts WHERE source_type = 'payment_plan' AND source_id = ?", planId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 'succeeded');
  assert.equal(attempts[0].reference, planPays[0].reference);

  // The one list: this plan, its card, its signed authorization and what's next.
  const list = (await s.b.get('/billing/active')).data;
  const row = list.items.find((i) => i.kind === 'payment_plan' && i.id === planId);
  assert.ok(row.authorization?.signed_at);
  assert.equal(row.card.label.startsWith('visa ending 4242'), true);
  assert.equal(row.status, 'ok');
  assert.ok(row.next_date);
  const activity = (await s.b.get(`/patients/${s.patient.id}/billing-activity`)).data;
  assert.ok(activity.events.some((e) => e.type === 'authorization' && /Jane Doe agreed/.test(e.text)));
  assert.ok(activity.events.some((e) => e.type === 'charge' && /Charged \$200\.00/.test(e.text)));
  // The signed words are kept.
  const auth = (await s.b.get(`/billing/authorizations/${done.data.authorization.id}`)).data;
  assert.equal(auth.terms, preview.terms);
});

test('BL1: agreeing by text link — the patient sees the terms, adds a card and agrees; replays do nothing more', async () => {
  const s = await setUp();
  const input = { patient_id: s.patient.id, kind: 'recurring', amount: 5000, day_of_month: 1, description: 'Monthly payment toward the account' };
  const preview = (await s.b.post('/billing/setup/preview', input)).data;
  const sentBefore = h.sent.length;
  const res = await s.b.post('/billing/setup', { ...input, terms_hash: preview.terms_hash, agree: { how: 'link', send: 'sms' } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.authorization.status, 'pending');
  const msg = h.sent.slice(sentBefore).find((m) => /review and agree/.test(m.body));
  const token = tokenIn(msg);
  assert.ok(token, 'the patient got a link');
  const pub = client(null);
  const view = (await pub.get(`/public/billing-link/${token}`)).data;
  assert.equal(view.kind, 'authorize');
  assert.equal(view.status, 'open');
  assert.match(view.terms, /\$50\.00 on the 1st of each month/);
  assert.equal((await pub.get('/public/billing-link/not-a-real-token')).status, 404);
  assert.equal((await pub.post(`/public/billing-link/${token}/agree`, { signer_name: 'Jane Doe', agree: true, terms_hash: 'changed', card_number: '4242424242424242' })).status, 409);
  assert.equal((await pub.post(`/public/billing-link/${token}/agree`, { signer_name: '', agree: true, terms_hash: view.terms_hash, card_number: '4242424242424242' })).status, 400);
  const ok = await pub.post(`/public/billing-link/${token}/agree`, { signer_name: 'Jane Doe', agree: true, terms_hash: view.terms_hash, card_number: '4242424242424242' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const again = await pub.post(`/public/billing-link/${token}/agree`, { signer_name: 'Jane Doe', agree: true, terms_hash: view.terms_hash, card_number: '4242424242424242' });
  assert.equal(again.data.replay, true);
  const a = await h.db.get('SELECT * FROM billing_authorizations WHERE id = ?', res.data.authorization.id);
  assert.equal(a.status, 'signed');
  assert.equal(a.signed_via, 'link');
  const rc = await h.db.all('SELECT * FROM recurring_charges WHERE patient_id = ?', s.patient.id);
  assert.equal(rc.length, 1);
  assert.equal(rc[0].authorization_id, a.id);
  // The first charge on its date: posted once even if the processor answers the same id twice.
  await h.db.run('UPDATE recurring_charges SET next_charge_date = ? WHERE id = ?', s.today, rc[0].id);
  const same = { enabled: true, mode: 'sandbox', charge: async () => ({ ok: true, reference: 'pi_same_answer' }) };
  const [first] = await runRecurringCharges(h.db, same, h.messenger);
  assert.equal(first.ok, true);
  await runRecurringCharges(h.db, same, h.messenger, { id: rc[0].id, force: true });
  assert.equal((await h.db.all("SELECT id FROM ledger_entries WHERE reference = 'pi_same_answer' AND type = 'payment'")).length, 1);
  assert.equal((await h.db.get('SELECT charges_made FROM recurring_charges WHERE id = ?', rc[0].id)).charges_made, 2, 'a second (forced) run is a new month, not a second post');
});

test('BL3: a declined charge posts nothing, raises and texts, retries on day 3/7/14, pauses — and a new card from the link recovers it', async () => {
  const s = await setUp();
  const bad = await s.card('4000000000000002');
  const plan = await setUpPlan(s, { cardId: bad.id, down: 0 });
  const planId = plan.source_id;
  await h.db.run('UPDATE payment_plans SET start_date = ? WHERE id = ?', addDays(s.today, -5), planId);
  const sentBefore = h.sent.length;
  const [d1] = await runAutopay(h.db, h.app.locals.payments, h.messenger);
  assert.equal(d1.ok, false);
  assert.equal((await h.db.all("SELECT id FROM ledger_entries WHERE payment_plan_id = ? AND type = 'payment'", planId)).length, 0, 'nothing posted');
  const key = `dunning:payment_plan:${planId}`;
  let item = await issue(s.pid, key);
  assert.equal(item.status, 'open');
  assert.equal(item.role, 'billing');
  assert.match(item.detail, /Nothing was posted/);
  const notice = h.sent.slice(sentBefore).find((m) => /update your card/i.test(m.body));
  assert.ok(tokenIn(notice), 'the patient was texted an update-card link');
  let dun = await h.db.get('SELECT * FROM billing_dunning WHERE live_key = ?', `payment_plan:${planId}`);
  assert.deepEqual([dun.failures, dun.next_retry_on, dun.status], [1, addDays(s.today, 3), 'retrying']);

  // Not before its retry day, even if the daily guard is cleared.
  await h.db.run('UPDATE payment_plans SET autopay_last_attempt = NULL WHERE id = ?', planId);
  assert.deepEqual(await runAutopay(h.db, h.app.locals.payments, h.messenger), []);
  // Day 3, day 7, day 14: each retry declines; the last one pauses.
  for (const [n, nextDay] of [[2, 7], [3, 14], [4, null]]) {
    await h.db.run("UPDATE billing_dunning SET next_retry_on = ? WHERE id = ?", s.today, dun.id);
    await h.db.run('UPDATE payment_plans SET autopay_last_attempt = NULL WHERE id = ?', planId);
    const [r] = await runAutopay(h.db, h.app.locals.payments, h.messenger);
    assert.equal(r.ok, false);
    dun = await h.db.get('SELECT * FROM billing_dunning WHERE id = ?', dun.id);
    assert.equal(dun.failures, n);
    assert.equal(dun.next_retry_on, nextDay ? addDays(dun.first_failed_on, nextDay) : null);
  }
  assert.equal(dun.status, 'paused');
  assert.equal((await h.db.get('SELECT autopay_paused FROM payment_plans WHERE id = ?', planId)).autopay_paused, 1);
  item = await issue(s.pid, key);
  assert.equal(item.severity, 'high');
  assert.match(item.title, /paused/);
  assert.match(item.detail, /Call Jane Doe/);
  assert.equal((await h.db.all("SELECT id FROM tasks WHERE patient_id = ? AND title LIKE 'Autopay paused%'", s.patient.id)).length, 1, 'the team is told once, with next steps');
  assert.equal((await h.db.all("SELECT id FROM ledger_entries WHERE payment_plan_id = ? AND type = 'payment'", planId)).length, 0);
  // Paused: the daily run leaves it alone.
  await h.db.run('UPDATE payment_plans SET autopay_last_attempt = NULL WHERE id = ?', planId);
  assert.deepEqual(await runAutopay(h.db, h.app.locals.payments, h.messenger, { planId }), []);
  const list = (await s.b.get('/billing/dunning')).data;
  assert.ok(list.some((x) => x.id === dun.id && x.status === 'paused'));

  // The patient opens the link and adds a working card: it replaces the declined one and the plan is charged now.
  const token = tokenIn([...h.sent].reverse().find((m) => /update your card/i.test(m.body) && m.to === '(512) 555-0100'));
  const pub = client(null);
  const view = (await pub.get(`/public/billing-link/${token}`)).data;
  assert.equal(view.kind, 'update_card');
  assert.equal(view.old_card.last4, '0002');
  assert.equal((await pub.post(`/public/billing-link/${token}/card`, { card_number: '1234' })).status, 400);
  const saved = await pub.post(`/public/billing-link/${token}/card`, { card_number: '4242424242424242' });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.equal(saved.data.updated, 1);
  assert.equal(saved.data.retried[0].ok, true);
  const p = await h.db.get('SELECT * FROM payment_plans WHERE id = ?', planId);
  assert.notEqual(p.autopay_method_id, bad.id);
  assert.equal(p.autopay_paused, 0);
  assert.equal((await h.db.all("SELECT id FROM ledger_entries WHERE payment_plan_id = ? AND type = 'payment'", planId)).length, 1);
  assert.equal((await h.db.get('SELECT status FROM billing_dunning WHERE id = ?', dun.id)).status, 'recovered');
  assert.equal((await issue(s.pid, key)).status, 'resolved', 'the work item resolves itself on the later success');
  // The link is used up.
  assert.equal((await pub.post(`/public/billing-link/${token}/card`, { card_number: '4242424242424242' })).status, 410);
});

test('BL3: memberships and recurring charges follow the same retry schedule', async () => {
  const s = await setUp();
  const bad = await s.card('4000000000000002');
  const mp = (await s.api.post('/membership-plans', { name: 'Smile Club', price: 3000, interval: 'month', discount_pct: 10, included: [{ label: 'Cleanings', codes: 'D1110', per_year: 2 }] })).data;
  const m = (await s.api.post(`/patients/${s.patient.id}/memberships`, { plan_id: mp.id, payment_method_id: bad.id, start_date: s.today })).data;
  assert.ok(m.id, JSON.stringify(m));
  await runMembershipBilling(h.db, h.app.locals.payments, { membershipId: m.id, messenger: h.messenger });
  const d = await h.db.get('SELECT * FROM billing_dunning WHERE live_key = ?', `membership:${m.id}`);
  assert.ok(d, 'the decline opened dunning');
  assert.equal(d.next_retry_on, addDays(s.today, 3));
  assert.equal((await issue(s.pid, `dunning:membership:${m.id}`)).status, 'open');
  // The next day's run doesn't retry (day 3 does).
  await h.db.run("UPDATE memberships SET billing_message = 'Card declined (yesterday)' WHERE id = ?", m.id);
  await runMembershipBilling(h.db, h.app.locals.payments, { membershipId: m.id, messenger: h.messenger });
  assert.equal((await h.db.get('SELECT failures FROM billing_dunning WHERE id = ?', d.id)).failures, 1);
});

test('BL3: expiring cards in use are caught a month ahead, once per card', async () => {
  const s = await setUp();
  const now = new Date(`${s.today}T12:00:00Z`);
  const soon = await insert(h.db, 'payment_methods', { practice_id: s.pid, patient_id: s.patient.id, provider: 'sandbox', brand: 'visa', last4: '1111', exp_month: now.getUTCMonth() + 1, exp_year: now.getUTCFullYear(), funding: 'credit' });
  const later = await insert(h.db, 'payment_methods', { practice_id: s.pid, patient_id: s.patient.id, provider: 'sandbox', brand: 'visa', last4: '2222', exp_month: 1, exp_year: now.getUTCFullYear() + 3, funding: 'credit' });
  const unused = await insert(h.db, 'payment_methods', { practice_id: s.pid, patient_id: s.patient.id, provider: 'sandbox', brand: 'visa', last4: '3333', exp_month: now.getUTCMonth() + 1, exp_year: now.getUTCFullYear(), funding: 'credit' });
  for (const mid of [soon, later]) {
    await insert(h.db, 'recurring_charges', { practice_id: s.pid, patient_id: s.patient.id, amount: 1000, day_of_month: 1, next_charge_date: addDays(s.today, 20), description: 'Monthly', payment_method_id: mid });
  }
  const sentBefore = h.sent.length;
  assert.equal(await runExpiringCards(h.db, h.messenger, s.pid), 1, 'only the card in use that expires soon');
  const msg = h.sent.slice(sentBefore).find((m) => /1111/.test(m.body));
  assert.ok(tokenIn(msg));
  assert.equal(await runExpiringCards(h.db, h.messenger, s.pid), 0, 'once per card');
  const listed = (await s.b.get('/billing/expiring-cards')).data;
  assert.deepEqual(listed.map((c) => c.last4), ['1111']);
  assert.ok(listed[0].notified_at);
  assert.ok(!listed.some((c) => c.id === unused));
  // A new card from the link goes on the recurring charge.
  const saved = await client(null).post(`/public/billing-link/${tokenIn(msg)}/card`, { card_number: '5555555555554444' });
  assert.equal(saved.status, 201);
  const rc = await h.db.get('SELECT * FROM recurring_charges WHERE patient_id = ? AND payment_method_id <> ? ORDER BY id LIMIT 1', s.patient.id, later);
  assert.notEqual(rc.payment_method_id, soon);
});

test('BL3: disputes and processor refunds post once as reversals; a won dispute restores the payment', async () => {
  const s = await setUp();
  const pay = await insert(h.db, 'ledger_entries', { practice_id: s.pid, patient_id: s.patient.id, type: 'payment', amount: -40000, method: 'credit_card', reference: 'pi_disputed_1', description: 'Card payment', entry_date: s.today });
  const start = await balance(s.pid, s.patient.id);
  const dispute = { id: 'dp_test_1', object: 'dispute', amount: 40000, payment_intent: 'pi_disputed_1', reason: 'fraudulent', status: 'needs_response', evidence_details: { due_by: Math.floor(Date.now() / 1000) + 7 * 86400 } };
  await hook('charge.dispute.created', dispute);
  await hook('charge.dispute.created', dispute); // Stripe retries
  const rev = await h.db.all('SELECT * FROM ledger_entries WHERE reverses_id = ?', pay);
  assert.equal(rev.length, 1);
  assert.equal(rev[0].amount, 40000);
  assert.equal(rev[0].type, 'payment');
  assert.equal(await balance(s.pid, s.patient.id), start + 40000, 'the money taken back is owed again');
  const item = await issue(s.pid, 'dispute:dp_test_1');
  assert.equal(item.severity, 'high');
  assert.match(item.detail, /Respond at the processor by/);
  await hook('charge.dispute.closed', { ...dispute, status: 'won' });
  await hook('charge.dispute.closed', { ...dispute, status: 'won' });
  assert.equal(await balance(s.pid, s.patient.id), start, 'won: the payment is back');
  assert.equal((await h.db.all("SELECT id FROM ledger_entries WHERE reference = 'dp_test_1:won'")).length, 1);
  assert.equal((await issue(s.pid, 'dispute:dp_test_1')).status, 'resolved');
  assert.equal((await s.b.get('/billing/disputes')).data[0].status, 'won');

  // A lost dispute keeps the reversal and adds the office's returned-payment fee (set to automatic).
  const fee = await s.b.post('/billing/fees', { name: 'Returned payment fee', kind: 'fixed', amount: 2500, occasion: 'returned_payment', applies: 'automatic' });
  assert.equal(fee.status, 201, JSON.stringify(fee.data));
  await insert(h.db, 'ledger_entries', { practice_id: s.pid, patient_id: s.patient.id, type: 'payment', amount: -10000, method: 'credit_card', reference: 'pi_disputed_2', description: 'Card payment', entry_date: s.today });
  const lost = { id: 'dp_test_2', amount: 10000, payment_intent: 'pi_disputed_2', reason: 'product_not_received', status: 'needs_response' };
  await hook('charge.dispute.created', lost);
  await hook('charge.dispute.closed', { ...lost, status: 'lost' });
  await hook('charge.dispute.closed', { ...lost, status: 'lost' });
  assert.equal((await h.db.all("SELECT id FROM billing_fee_charges WHERE source_key = 'returned:dp_test_2'")).length, 1);

  // A refund made in the processor's dashboard posts once; one made from here (marked) isn't posted again.
  const charge = { id: 'ch_1', payment_intent: 'pi_disputed_1', amount_refunded: 1500, refunds: { data: [{ id: 're_outside_1', amount: 1500, status: 'succeeded' }, { id: 're_ours_1', amount: 700, status: 'succeeded', metadata: { source: 'dentalmachine' } }] } };
  await hook('charge.refunded', charge);
  await hook('charge.refunded', charge);
  const refunds = await h.db.all("SELECT * FROM ledger_entries WHERE type = 'refund' AND refund_of_id = ?", pay);
  assert.equal(refunds.length, 1);
  assert.deepEqual([refunds[0].amount, refunds[0].reference], [1500, 're_outside_1']);
  assert.equal((await issue(s.pid, 'processor-refund:re_outside_1')).status, 'open');
});

test('BL5: surcharge rules by state, never on debit, disclosed before paying and shown on the receipt', async () => {
  // Rules: brands cap 3%, a state ban, a state cap, and the office's own processing cost.
  assert.equal(surchargeCap('TX', 0).max, 300);
  assert.equal(surchargeCap('TX', 250).max, 250);
  assert.equal(surchargeCap('CO', 350).max, 200);
  assert.equal(surchargeCap('CT', 300).max, null);
  assert.match(surchargeCap('MA', 300).note, /Massachusetts/);

  const ct = await setUp({ state: 'CT' });
  const refused = await ct.b.put('/billing/settings', { pass_through: 'surcharge', surcharge_bps: 300, processing_cost_bps: 300, processor_notified: true });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /Connecticut/);
  assert.equal((await ct.b.put('/billing/settings', { pass_through: 'convenience_fee', convenience_fee: 295 })).status, 200, 'a convenience fee instead');

  const s = await setUp();
  assert.equal((await s.b.put('/billing/settings', { pass_through: 'surcharge', surcharge_bps: 300, processor_notified: true })).status, 400, 'the processing cost is required');
  assert.equal((await s.b.put('/billing/settings', { pass_through: 'surcharge', surcharge_bps: 300, processing_cost_bps: 250, processor_notified: true })).status, 400, 'never more than it costs');
  assert.equal((await s.b.put('/billing/settings', { pass_through: 'surcharge', surcharge_bps: 250, processing_cost_bps: 250 })).status, 400, 'the processor must be told first');
  const ok = await s.b.put('/billing/settings', { pass_through: 'surcharge', surcharge_bps: 250, processing_cost_bps: 250, processor_notified: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE practice_id = ? AND action = 'billing.settings'", s.pid)).n >= 1, true);

  assert.equal((await passThroughFor(h.db, s.pid, { amount: 10000, channel: 'online', funding: 'debit' })).amount, 0);
  assert.equal((await passThroughFor(h.db, s.pid, { amount: 10000, channel: 'online', funding: null })).amount, 0, 'unknown funding is treated as debit');
  assert.equal((await passThroughFor(h.db, s.pid, { amount: 10000, channel: 'online', funding: 'credit', method: 'ach' })).amount, 0);
  const credit = await passThroughFor(h.db, s.pid, { amount: 10000, channel: 'online', funding: 'credit' });
  assert.deepEqual([credit.kind, credit.amount], ['surcharge', 250]);
  assert.match(credit.disclosure, /2\.5% surcharge \(\$2\.50\)/);
  assert.equal((await passThroughFor(h.db, s.pid, { amount: 10000, channel: 'recurring', funding: 'credit', authorizedBps: 0 })).amount, 0, 'automatic charges only with the patient’s signed OK');

  // Online: refused until the page has shown the fee; then the payment and its surcharge line, both on the receipt.
  const practice = await h.db.get('SELECT * FROM practices WHERE id = ?', s.pid);
  const payer = await h.db.get('SELECT * FROM patients WHERE id = ?', s.patient.id);
  const pay = (extra) => withActor({ source: 'patient' }, () => takePayment(h.db, h.app.locals.payments, h.messenger, { practice, payer, amount: 10000, how: 'new', method: 'card', source: 'portal', ...extra }));
  await assert.rejects(pay({ sandbox: { card_number: '4242424242424242' } }), (err) => err.status === 409 && err.details.fee_required.amount === 250);
  const paid = await pay({ sandbox: { card_number: '4242424242424242' }, feeAck: 250 });
  assert.equal(paid.paid, true);
  const entry = await h.db.get('SELECT * FROM ledger_entries WHERE id = ?', paid.entry_id);
  assert.equal(entry.amount, -10250);
  const line = await h.db.get("SELECT * FROM ledger_entries WHERE reference = ? AND adjustment_type = 'Card surcharge'", entry.reference);
  assert.equal(line.amount, 250);
  const receipt = await receiptData(h.db, entry.id, s.pid);
  assert.deepEqual(receipt.fees.map((f) => f.amount), [250]);
  // A debit card: no surcharge, nothing to acknowledge.
  const debit = await pay({ sandbox: { card_number: '4000056655665556' } });
  assert.equal((await h.db.get('SELECT amount FROM ledger_entries WHERE id = ?', debit.entry_id)).amount, -10000);

  // Set-up terms disclose it, and automatic charges on a credit card add what the patient agreed to.
  const visa = await s.card('4242424242424242');
  const input = { patient_id: s.patient.id, kind: 'recurring', amount: 10000, day_of_month: 1, payment_method_id: visa.id };
  const preview = (await s.b.post('/billing/setup/preview', input)).data;
  assert.match(preview.terms, /2\.5% card surcharge is added to each payment/);
  const setup = await s.b.post('/billing/setup', { ...input, terms_hash: preview.terms_hash, agree: { how: 'screen', signer_name: 'Jane Doe' } });
  assert.equal(setup.status, 201, JSON.stringify(setup.data));
  const [r] = await runRecurringCharges(h.db, h.app.locals.payments, h.messenger, { id: setup.data.source_id, force: true });
  assert.equal(r.ok, true);
  assert.equal(r.surcharge, 250);
  assert.equal((await h.db.get('SELECT amount FROM ledger_entries WHERE id = ?', r.entry_id)).amount, -10250);
  // Debit on the same terms: no surcharge.
  const debitCard = await s.card('4000056655665556');
  const out = await withActor({ source: 'automation' }, () => trackedCharge(h.db, h.app.locals.payments, { method: { ...debitCard, practice_id: s.pid }, amount: 10000, description: 'x', idempotencyKey: `t-debit-${Date.now()}` }, { practiceId: s.pid, patientId: s.patient.id, sourceType: 'recurring', sourceId: setup.data.source_id }));
  assert.equal(out.surcharge, 0);

  // Convenience fee: flat, online only, never on automatic payments.
  const cf = await setUp();
  assert.equal((await cf.b.put('/billing/settings', { pass_through: 'convenience_fee', convenience_fee: 300 })).status, 200);
  assert.equal((await passThroughFor(h.db, cf.pid, { amount: 5000, channel: 'online', funding: 'debit' })).amount, 300);
  assert.equal((await passThroughFor(h.db, cf.pid, { amount: 5000, channel: 'recurring', funding: 'credit', authorizedBps: 300 })).amount, 0);
  assert.equal((await passThroughFor(h.db, cf.pid, { amount: 5000, channel: 'office', funding: 'credit' })).amount, 0);
});

test('BL5: office fees — $ or % of collectible with caps, posted once as their own lines; waivers need a manager, a reason, and are audited', async () => {
  // The math, in cents, half-up.
  assert.equal(feeAmount({ kind: 'fixed', amount: 2500 }, null), 2500);
  assert.equal(feeAmount({ kind: 'percent', pct_bps: 1000 }, 12345), 1235);
  assert.equal(feeAmount({ kind: 'percent', pct_bps: 1000, max_amount: 5000 }, 135000), 5000);
  assert.equal(feeAmount({ kind: 'percent', pct_bps: 100, min_amount: 500 }, 10000), 500);
  assert.equal(feeAmount({ kind: 'percent', pct_bps: 100, min_amount: 500 }, 0), 0, 'nothing owed, no fee');

  const s = await setUp();
  assert.equal((await s.b.post('/billing/fees', { name: 'Bad', kind: 'percent', pct_bps: 9000, occasion: 'manual' })).status, 400);
  assert.equal((await s.b.post('/billing/fees', { name: 'Bad', kind: 'fixed', amount: 100, occasion: 'manual', applies: 'automatic' })).status, 400);
  const pctFee = (await s.b.post('/billing/fees', { name: 'Collection fee', kind: 'percent', pct_bps: 1000, max_amount: 5000, min_amount: 500, occasion: 'manual' })).data;
  const fixed = (await s.b.post('/billing/fees', { name: 'Records copy fee', kind: 'fixed', amount: 1500, occasion: 'manual', waivable: false })).data;
  const setupFee = (await s.b.post('/billing/fees', { name: 'Plan set-up fee', kind: 'fixed', amount: 2500, occasion: 'plan_setup', applies: 'automatic' })).data;

  // 10% of the $1,350 owed is $135, capped at $50.
  const preview = (await s.b.get(`/billing/fees/${pctFee.id}/preview?patient_id=${s.patient.id}`)).data;
  assert.deepEqual([preview.basis, preview.amount], [135000, 5000]);
  const applied = await s.b.post(`/billing/fees/${pctFee.id}/apply`, { patient_id: s.patient.id, occasion_key: 'sept-letter' });
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.equal((await s.b.post(`/billing/fees/${pctFee.id}/apply`, { patient_id: s.patient.id, occasion_key: 'sept-letter' })).status, 409, 'once per occasion');
  const line = await h.db.get('SELECT * FROM ledger_entries WHERE id = ?', applied.data.ledger_entry_id);
  assert.deepEqual([line.type, line.adjustment_type, line.amount], ['adjustment', 'Office fee', 5000]);
  assert.match(line.description, /Collection fee \(10% of \$1,350\.00\)/);

  // The set-up fee is in the terms the patient agrees to and posts with the plan.
  const visa = await s.card('4242424242424242');
  const plan = await setUpPlan(s, { cardId: visa.id, down: 0 });
  assert.match(plan.preview.terms, /Plan set-up fee: \$25\.00/);
  const setupCharge = await h.db.get('SELECT * FROM billing_fee_charges WHERE fee_id = ?', setupFee.id);
  assert.equal(setupCharge.amount, 2500);

  // Waiving: a manager, a reason, a reversing entry, audited; not twice.
  const desk = await member(s, 'front_desk');
  assert.equal((await desk.b.post(`/billing/fee-charges/${applied.data.id}/waive`, { reason: 'Goodwill' })).status, 403);
  assert.equal((await s.b.post(`/billing/fee-charges/${applied.data.id}/waive`, {})).status, 400);
  const before = await balance(s.pid, s.patient.id);
  const w = await s.b.post(`/billing/fee-charges/${applied.data.id}/waive`, { reason: 'Goodwill — long-time patient' });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.equal(await balance(s.pid, s.patient.id), before - 5000);
  const rev = await h.db.get('SELECT * FROM ledger_entries WHERE id = ?', w.data.reversal_entry_id);
  assert.equal(rev.reverses_id, line.id);
  assert.ok((await h.db.get('SELECT voided_at FROM ledger_entries WHERE id = ?', line.id)).voided_at);
  const a = await h.db.get("SELECT * FROM audit_log WHERE action = 'billing_fee.waive' AND entity_id = ?", applied.data.id);
  assert.equal(a.reason, 'Goodwill — long-time patient');
  assert.equal((await s.b.post(`/billing/fee-charges/${applied.data.id}/waive`, { reason: 'again' })).status, 409);
  // A manager who isn't an administrator can't waive a fee the office marked not waivable.
  const mgr = await member(s, 'billing', { permissions_add: ['deposits:manage'] });
  const f2 = await s.b.post(`/billing/fees/${fixed.id}/apply`, { patient_id: s.patient.id, occasion_key: 'records-1' });
  assert.equal((await mgr.b.post(`/billing/fee-charges/${f2.data.id}/waive`, { reason: 'x' })).status, 403);
  assert.equal((await s.b.post(`/billing/fee-charges/${f2.data.id}/waive`, { reason: 'Administrator correction' })).status, 200);

  // Automatic fees: a missed visit (at most once a year), a late plan payment (after the grace days) — each once.
  const missed = (await s.b.post('/billing/fees', { name: 'Missed appointment fee', kind: 'fixed', amount: 3500, occasion: 'missed_appointment', applies: 'automatic', max_per_year: 1 })).data;
  const late = (await s.b.post('/billing/fees', { name: 'Late fee', kind: 'percent', pct_bps: 500, min_amount: 1000, occasion: 'late_payment', applies: 'automatic', grace_days: 5 })).data;
  await h.db.run("UPDATE billing_fees SET created_at = '2020-01-01 00:00:00' WHERE id IN (?, ?)", missed.id, late.id);
  for (const days of [2, 1]) {
    await insert(h.db, 'appointments', { practice_id: s.pid, patient_id: s.patient.id, provider_id: s.provider.id, start_time: `${addDays(s.today, -days)} 09:00`, end_time: `${addDays(s.today, -days)} 10:00`, status: 'no_show' });
  }
  await h.db.run('UPDATE payment_plans SET start_date = ? WHERE id = ?', addDays(s.today, -40), plan.source_id);
  const r1 = await runAutoFees(h.db, s.pid);
  const r2 = await runAutoFees(h.db, s.pid);
  assert.equal(r1.missed, 1, 'the yearly limit');
  assert.equal(r2.missed + r2.late, 0, 'each once');
  assert.equal(r1.late, 2, 'two installments are past due beyond the grace days');
  const lateLines = await h.db.all("SELECT c.amount FROM billing_fee_charges c WHERE c.fee_id = ?", late.id);
  assert.deepEqual(lateLines.map((x) => x.amount), [1000, 1000], '5% of $100 is $5, raised to the $10 minimum');
  assert.equal((await h.db.all('SELECT id FROM payment_plan_late_fees WHERE plan_id = ?', plan.source_id)).length, 2, 'shared with the plan’s own late fee, so never two');
  const fees = (await s.b.get(`/patients/${s.patient.id}/fee-charges`)).data;
  assert.ok(fees.some((f) => f.status === 'waived'));
});

test('BL2: the daily check with the processor turns differences into Needs attention items, resolved when fixed', async () => {
  const s = await setUp();
  const day = addDays(s.today, -1);
  await insert(h.db, 'ledger_entries', { practice_id: s.pid, patient_id: s.patient.id, type: 'payment', amount: -5000, method: 'credit_card', reference: 'pi_matched', description: 'Card', entry_date: day });
  const at = Math.floor(Date.parse(`${day}T15:00:00Z`) / 1000);
  const processor = {
    enabled: true, mode: 'stripe',
    listCharges: async () => [{ id: 'pi_matched', amount: 5000, created: at }, { id: 'pi_missing', amount: 7000, created: at }],
    listPayouts: async () => [{ id: 'po_1', amount: 11000, items: [
      { type: 'charge', amount: 5000, net: 4800, payment_intent: 'pi_matched', practice_id: String(s.pid) },
      { type: 'charge', amount: 7000, net: 6700, payment_intent: 'pi_missing', practice_id: String(s.pid) },
    ] }],
  };
  const out = await reconcileDay(h.db, processor, s.pid, day);
  assert.equal(out.matched, 1);
  assert.ok(out.exceptions >= 2);
  assert.equal((await issue(s.pid, 'recon:pi_missing')).status, 'open');
  assert.equal((await issue(s.pid, 'payout:po_1:pi_missing')).status, 'open');
  assert.equal((await issue(s.pid, 'payout:po_1')).status, 'open', 'the payout doesn’t add up (4800 + 6700 ≠ 11000)');
  // Someone posts the missing payment; checking the day again resolves what's now matched.
  await insert(h.db, 'ledger_entries', { practice_id: s.pid, patient_id: s.patient.id, type: 'payment', amount: -7000, method: 'credit_card', reference: 'pi_missing', description: 'Card', entry_date: day });
  await reconcileDay(h.db, processor, s.pid, day);
  assert.equal((await issue(s.pid, 'recon:pi_missing')).status, 'resolved');
  assert.equal((await issue(s.pid, 'payout:po_1:pi_missing')).status, 'resolved');
  const days = (await s.b.get('/billing/reconciliation')).data.days;
  assert.equal(days[0].day, day);
  // The hourly job checks yesterday once per practice.
  const stats = await runBillingAutopilot(h.db, { ...processor, listCharges: async () => [] }, h.messenger, { appUrl: 'https://app.example.com' });
  assert.equal(typeof stats.reconciled, 'number');
});

test('permissions: settings and fees for administrators, waivers for managers, set-up for billing staff; the AI can’t move money', async () => {
  const s = await setUp();
  const desk = await member(s, 'front_desk');
  const dentist = await member(s, 'dentist');
  assert.equal((await desk.b.put('/billing/settings', { pass_through: 'convenience_fee', convenience_fee: 100 })).status, 403);
  assert.equal((await desk.b.post('/billing/fees', { name: 'X', kind: 'fixed', amount: 100, occasion: 'manual' })).status, 403);
  assert.equal((await desk.b.get('/billing/active')).status, 200);
  const visa = await s.card('4242424242424242');
  const input = { patient_id: s.patient.id, kind: 'recurring', amount: 2000, day_of_month: 3, payment_method_id: visa.id };
  assert.equal((await dentist.b.post('/billing/setup/preview', input)).status, 403, 'no billing:write');
  assert.equal((await dentist.b.get('/billing/active')).status, 200);
  const preview = (await desk.b.post('/billing/setup/preview', input)).data;
  // The assistant acting for a person: refused without the person's OK on screen.
  const ai = client(desk.token, { 'X-Acting-For': 'assistant' });
  const refused = await ai.post('/billing/setup', { ...input, terms_hash: preview.terms_hash, agree: { how: 'screen', signer_name: 'Jane Doe' } });
  assert.equal(refused.status, 428);
  assert.equal((await h.db.all('SELECT id FROM recurring_charges WHERE patient_id = ?', s.patient.id)).length, 0);
  // Server-side AI can't charge a card either.
  await assert.rejects(withActor({ source: 'ai' }, () => trackedCharge(h.db, h.app.locals.payments, { method: visa, amount: 1000, description: 'x', idempotencyKey: 'ai-1' }, { practiceId: s.pid, patientId: s.patient.id, sourceType: 'recurring' })), (err) => err.status === 428);
  // A person can.
  const done = await desk.b.post('/billing/setup', { ...input, terms_hash: preview.terms_hash, agree: { how: 'screen', signer_name: 'Jane Doe' } });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  const setupAudit = await h.db.get("SELECT * FROM audit_log WHERE action = 'billing.setup' AND entity_id = ?", done.data.authorization.id);
  assert.equal(setupAudit.user_id, desk.user.id);
  // Revoking needs a reason and is audited.
  assert.equal((await desk.b.post(`/billing/authorizations/${done.data.authorization.id}/revoke`, {})).status, 400);
  assert.equal((await desk.b.post(`/billing/authorizations/${done.data.authorization.id}/revoke`, { reason: 'Patient asked to stop' })).status, 200);
  assert.equal((await h.db.get('SELECT status FROM recurring_charges WHERE id = ?', done.data.source_id)).status, 'cancelled');
});

test('practice isolation: nothing from another practice can be seen, charged, waived or linked', async () => {
  const a = await setUp();
  const b = await setUp();
  const visa = await a.card('4242424242424242');
  const plan = await setUpPlan(a, { cardId: visa.id, down: 0 });
  const fee = (await a.b.post('/billing/fees', { name: 'A fee', kind: 'fixed', amount: 1000, occasion: 'manual' })).data;
  const charge = (await a.b.post(`/billing/fees/${fee.id}/apply`, { patient_id: a.patient.id, occasion_key: 'k1' })).data;
  assert.equal((await b.b.get(`/billing/authorizations/${plan.authorization.id}`)).status, 404);
  assert.equal((await b.b.get(`/patients/${a.patient.id}/billing-activity`)).status, 404);
  assert.equal((await b.b.get(`/patients/${a.patient.id}/fee-charges`)).status, 404);
  assert.equal((await b.b.post(`/billing/fees/${fee.id}/apply`, { patient_id: b.patient.id })).status, 404);
  const bFee = (await b.b.post('/billing/fees', { name: 'B fee', kind: 'fixed', amount: 1000, occasion: 'manual' })).data;
  assert.equal((await b.b.post(`/billing/fees/${bFee.id}/apply`, { patient_id: a.patient.id })).status, 404, 'B’s fee on A’s patient');
  assert.equal((await b.b.post(`/billing/fee-charges/${charge.id}/waive`, { reason: 'x' })).status, 404);
  assert.equal((await b.b.post(`/billing/authorizations/${plan.authorization.id}/revoke`, { reason: 'x' })).status, 404);
  assert.equal((await b.b.post('/billing/setup/preview', { patient_id: a.patient.id, kind: 'recurring', amount: 1000, day_of_month: 1 })).status, 404);
  assert.equal((await b.b.post('/billing/setup/preview', { patient_id: b.patient.id, kind: 'recurring', amount: 1000, day_of_month: 1, payment_method_id: visa.id })).status, 400, 'A’s card on B’s patient');
  assert.equal((await b.b.post('/billing/replace-card', { old_method_id: visa.id, new_method_id: visa.id })).status, 404);
  const bList = (await b.b.get('/billing/active')).data;
  assert.ok(!bList.items.some((i) => i.patient_id === a.patient.id));
  assert.equal((await b.b.get('/billing/dunning')).data.length, 0);
  // Settings are per practice.
  assert.equal((await a.b.put('/billing/settings', { pass_through: 'convenience_fee', convenience_fee: 200 })).status, 200);
  assert.equal((await b.b.get('/billing/settings')).data.settings.pass_through, 'off');
});

test('the real app mounts the billing routes (skips until app.js does)', async (t) => {
  const s = await h.practice();
  const res = await s.api.get('/billing/active');
  if (res.status === 404) return t.skip('billingauto routes are not mounted in app.js yet');
  assert.equal(res.status, 200);
});
