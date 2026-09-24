// Patient portal 2.0 and "Pay my bill" (PT1–PT4): household visibility, the account math against the ledger,
// payments posting once (double submits, webhook replays, coming back from Stripe), saved cards, payment plans
// within the owner's limits, finding a bill from the website without leaking anything, failures in Needs attention,
// and practice isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { harness } from './helpers.js';
import { ensureBillpaySchema, mountPortalBilling } from './ptmount.js';

const WHSEC = 'whsec_portal_test';
const h = harness({ config: { payments: 'sandbox', stripeWebhookSecret: WHSEC, billpayLookupsPer15Min: 40 } });

// A second app on Stripe (test mode), with Stripe's API answered here.
const stripe = { sessions: new Map(), n: 0, calls: [] };
const stripeFetch = async (url, init = {}) => {
  const u = new URL(url);
  const path = u.pathname.replace('/v1/', '');
  const params = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  stripe.calls.push({ method: init.method, path, params, idempotencyKey: init.headers?.['Idempotency-Key'] });
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (path === 'customers') return json({ id: 'cus_test_1' });
  if (path === 'checkout/sessions' && init.method === 'POST') {
    const id = `cs_test_${++stripe.n}`;
    const metadata = Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]));
    stripe.sessions.set(id, { id, amount_total: Number(params['line_items[0][price_data][unit_amount]']), metadata, payment_intent: `pi_test_${stripe.n}`, params });
    return json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (path.startsWith('checkout/sessions/')) {
    const s = stripe.sessions.get(decodeURIComponent(path.split('/')[2]));
    return json({ ...s, payment_status: 'paid', status: 'complete' });
  }
  if (path.startsWith('payment_intents/')) return json({ id: path.split('/')[1], customer: 'cus_test_1', payment_method: { id: 'pm_card_visa', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2031 } } });
  if (path.endsWith('/detach')) return json({ id: 'pm_card_visa' });
  return json({ error: { message: `unexpected ${path}` } }, 400);
};
const s = harness({ config: { stripeSecretKey: 'sk_test_portal', stripeWebhookSecret: WHSEC, stripeAch: true, billpayLookupsPer15Min: 40 }, fetchImpl: stripeFetch });

// Each app gets the routers (and table) once, the first time a test uses it.
const ready = new Set();
async function setup(x) {
  if (ready.has(x)) return x;
  ready.add(x);
  await ensureBillpaySchema(x.db);
  mountPortalBilling(x.app, { db: x.db, secret: 'test-secret', config: x.config, payments: x.app.locals.payments, messenger: x.messenger });
  return x;
}

const waitFor = async (fn) => {
  for (let i = 0; i < 100 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 10));
};
let keyN = 0;
const idem = () => ({ 'Idempotency-Key': `test-key-${Date.now()}-${++keyN}` });

async function portalFor(x, slug, { contact = 'jane@example.com', dob = '1985-04-12' } = {}) {
  const pub = x.client();
  const before = x.sent.length;
  await pub.post(`/public/portal/${slug}/code`, { contact, dob });
  await waitFor(() => x.sent.length > before);
  const code = x.sent.at(-1).body.match(/\d{6}/)[0];
  const token = (await pub.post(`/public/portal/${slug}/verify`, { contact, code })).data.token;
  assert.ok(token, 'signed in');
  return { token, get: (p) => x.client(token).get(p), post: (p, b, hdr = {}) => x.client(token, hdr).post(p, b), put: (p, b) => x.client(token).put(p, b), del: (p) => x.client(token).del(p) };
}

// A household: Jane (guarantor) with a completed filling, and her son Sam with a cleaning.
async function household(x, slug) {
  await setup(x);
  const ctx = await x.practice({ slug, timezone: 'UTC' });
  const { api, patient, provider } = ctx;
  const son = (await api.post('/patients', { first_name: 'Sam', last_name: 'Doe', dob: '2012-06-01', guarantor_id: patient.id, email: 'sam@example.com', phone: '(512) 555-0199', zip: '78704' })).data;
  const done = async (pid, code, tooth) => (await api.post(`/patients/${pid}/procedures`, { code, tooth, surfaces: code === 'D2392' ? 'MO' : undefined, provider_id: provider.id, complete: true })).data;
  await done(patient.id, 'D2392', '30');
  await done(son.id, 'D1120');
  return { ...ctx, son };
}
const pidOf = async (x, patientId) => (await x.db.get('SELECT practice_id FROM patients WHERE id = ?', patientId)).practice_id;
const ledgerSum = async (x, ids) => (await x.db.get(`SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE patient_id IN (${ids.map(() => '?').join(',')})`, ...ids)).n;
const ledgerRows = (x, pid) => x.db.all("SELECT * FROM ledger_entries WHERE patient_id = ? AND type = 'payment'", pid);

test('PT1: the guarantor sees the household; the itemized visits add up to the ledger; others see only themselves', async () => {
  const slug = `pt1-${Date.now()}`;
  const { api, patient, son } = await household(h, slug);
  await api.post(`/patients/${patient.id}/payments`, { amount: 3000, method: 'cash' });
  const portal = await portalFor(h, slug);
  const acct = (await portal.get('/portal/account')).data;
  assert.equal(acct.is_guarantor, true);
  assert.deepEqual(acct.members.map((m) => m.first_name).sort(), ['Jane', 'Sam']);
  const total = await ledgerSum(h, [patient.id, son.id]);
  assert.equal(acct.summary.balance, total, 'balance is the ledger sum');
  assert.equal(acct.members.reduce((s2, m) => s2 + m.balance, 0), total, 'members add up to the household');
  // Visit lines: what's open on every visit, less unapplied credit, plus anything unexplained = the balance.
  const open = acct.visits.reduce((s2, v) => s2 + v.totals.open, 0);
  assert.equal(open - acct.summary.unapplied_credit + acct.summary.other, total);
  for (const v of acct.visits) for (const l of v.lines) assert.equal(l.charged, l.insurance_paid + l.write_off + l.patient_paid + l.adjusted + l.open);
  assert.equal(acct.summary.your_portion, Math.max(0, total - acct.summary.pending_insurance - acct.summary.pending_write_off));
  assert.ok(acct.receipts.some((r) => r.amount === -3000));
  assert.equal((await portal.get(`/portal/account/members/${son.id}`)).status, 200);

  // Sam signs in himself: only his own account, no household, no cards, no family member's details.
  const sam = await portalFor(h, slug, { contact: 'sam@example.com', dob: '2012-06-01' });
  const mine = (await sam.get('/portal/account')).data;
  assert.equal(mine.is_guarantor, false);
  assert.deepEqual(mine.members, []);
  assert.equal(mine.summary.balance, await ledgerSum(h, [son.id]));
  assert.ok(mine.visits.every((v) => v.patient_id === son.id));
  assert.equal((await sam.get(`/portal/account/members/${patient.id}`)).status, 404);
  assert.equal((await sam.post('/portal/billing/cards', { card_number: '4242424242424242' })).status, 403);
  assert.equal((await sam.post('/portal/billing/plans', { months: 3 })).status, 403);
  // Every view is audited as the patient.
  const views = await h.db.all("SELECT * FROM audit_log WHERE action IN ('portal.account_view','portal.member_view') AND practice_id = (SELECT practice_id FROM patients WHERE id = ?)", patient.id);
  assert.ok(views.length >= 3 && views.every((v) => v.source === 'patient'));
});

test('PT2: paying posts exactly once — double submits, a webhook replay, the saved card; declines raise and then resolve a billing item', async () => {
  const slug = `pt2-${Date.now()}`;
  const { patient, son } = await household(h, slug);
  const portal = await portalFor(h, slug);
  const acct = (await portal.get('/portal/account')).data;
  assert.equal(acct.payment.enabled, true);
  assert.equal(acct.payment.ach, true);

  // Declined card: nothing posted, a kind message, and billing gets a Needs attention item.
  const bad = await portal.post('/portal/billing/pay', { amount: 1000, card_number: '4000 0000 0000 0002' }, idem());
  assert.equal(bad.status, 402);
  assert.match(bad.data.error, /wasn’t approved.*haven’t been charged/);
  assert.equal((await ledgerRows(h, patient.id)).length, 0);
  const issue = await h.db.get("SELECT * FROM issues WHERE dedupe_key = ? AND status = 'open'", `online-pay:${patient.id}`);
  assert.ok(issue && issue.role === 'billing' && issue.kind === 'payment');
  // Not a test number: refused (sandbox never takes a real card number).
  assert.equal((await portal.post('/portal/billing/pay', { amount: 1000, card_number: '4111111111111111' }, idem())).status, 400);
  // More than the household owes: refused.
  assert.equal((await portal.post('/portal/billing/pay', { amount: acct.payment.max + 1, card_number: '4242424242424242' }, idem())).status, 400);

  // Good card, saved for next time; the same request sent twice posts once.
  const k = idem();
  const [a, b] = [await portal.post('/portal/billing/pay', { amount: 1500, card_number: '4242424242424242', save_card: true }, k), await portal.post('/portal/billing/pay', { amount: 1500, card_number: '4242424242424242', save_card: true }, k)];
  assert.equal(a.status, 201);
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  let pays = await ledgerRows(h, patient.id);
  assert.equal(pays.length, 1);
  assert.equal(pays[0].amount, -1500);
  assert.match(pays[0].reference, /^sbx_pi_/);
  assert.equal((await h.db.get('SELECT status FROM issues WHERE id = ?', issue.id)).status, 'resolved', 'a later success resolves the item');

  // The processor's event for the same payment arrives (and again): still one ledger entry.
  const pr = await h.db.get("SELECT * FROM payment_requests WHERE patient_id = ? AND status = 'paid'", patient.id);
  for (let i = 0; i < 2; i++) {
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: pr.session_id, payment_status: 'paid', amount_total: 1500, payment_intent: pays[0].reference, metadata: { source: 'portal' } } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', WHSEC).update(`${t}.${body}`).digest('hex');
    const res = await fetch(`${h.origin}/api/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body });
    assert.equal(res.status, 200);
  }
  assert.equal((await ledgerRows(h, patient.id)).length, 1);

  // The saved card pays the rest; bank (ACH) in sandbox posts as ACH.
  const cards = (await portal.get('/portal/account')).data.cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].last4, '4242');
  assert.equal((await portal.post('/portal/billing/pay', { amount: 500, how: 'saved', card_id: cards[0].id }, idem())).status, 201);
  assert.equal((await portal.post('/portal/billing/pay', { amount: 500, method: 'ach', account_number: '000123456789' }, idem())).status, 201);
  pays = await ledgerRows(h, patient.id);
  assert.deepEqual(pays.map((p) => p.method).sort(), ['ach', 'credit_card', 'credit_card']);
  assert.ok(pays.every((p) => p.voided_at == null));
  // The son's charges are paid from the guarantor's account: the household balance went down by what was paid.
  const acct2 = (await portal.get('/portal/account')).data;
  assert.equal(acct2.summary.balance, await ledgerSum(h, [patient.id, son.id]));
  assert.equal(acct.summary.balance - acct2.summary.balance, 2500);
  // Every payment audited as the patient.
  const audits = await h.db.all("SELECT * FROM audit_log WHERE action = 'portal.payment' AND patient_id = ?", patient.id);
  assert.equal(audits.length, 3);
  assert.ok(audits.every((x) => x.source === 'patient'));
});

test('PT2: saved cards are the guarantor’s own, removing one stops autopay; payment plans stay within the office’s limits', async () => {
  const slug = `pt2c-${Date.now()}`;
  const { api, patient, provider } = await household(h, slug);
  // A bigger balance so a plan is offered (the default minimum is $500).
  for (const tooth of ['3', '14', '19']) await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth, provider_id: provider.id, complete: true });
  const portal = await portalFor(h, slug);
  const card = (await portal.post('/portal/billing/cards', { card_number: '5555555555554444' }, idem())).data.card;
  assert.equal(card.last4, '4444');

  // Another practice's card id (or any id not yours) can't be used or removed.
  const otherSlug = `pt2c-other-${Date.now()}`;
  await household(h, otherSlug);
  const otherPortal = await portalFor(h, otherSlug);
  const theirCard = (await otherPortal.post('/portal/billing/cards', { card_number: '4242424242424242' }, idem())).data.card;
  assert.equal((await portal.del(`/portal/billing/cards/${theirCard.id}`)).status, 404);
  assert.equal((await portal.post('/portal/billing/pay', { amount: 500, how: 'saved', card_id: theirCard.id }, idem())).status, 404);

  const acct = (await portal.get('/portal/account')).data;
  assert.deepEqual(acct.plan_choices.map((c) => c.months), [3, 6, 12]);
  const c6 = acct.plan_choices.find((c) => c.months === 6);
  assert.equal(c6.down_payment, Math.ceil(acct.summary.your_portion * 0.2));
  // Outside the allowed options: refused.
  assert.equal((await portal.post('/portal/billing/plans', { months: 24, card_id: card.id }, idem())).status, 400);
  assert.equal((await portal.post('/portal/billing/plans', { months: 5, card_id: card.id }, idem())).status, 400);
  // The owner allows at most 6 months now (financial options): 12 disappears.
  await h.db.run('UPDATE practices SET fin_options = ? WHERE id = ?', JSON.stringify({ in_office: { months: [3, 6], max_months: 6, min_down_pct: 10, min_amount: 50000, apr: 0 } }), await pidOf(h, patient.id));
  const limited = (await portal.get('/portal/account')).data.plan_choices;
  assert.deepEqual(limited.map((c) => c.months), [3, 6]);
  assert.equal((await portal.post('/portal/billing/plans', { months: 12, card_id: card.id }, idem())).status, 400);
  const plan = await portal.post('/portal/billing/plans', { months: 6, card_id: card.id }, idem());
  assert.equal(plan.status, 201, JSON.stringify(plan.data));
  const row = await h.db.get('SELECT * FROM payment_plans WHERE id = ?', plan.data.id);
  assert.deepEqual([row.installments, row.autopay_method_id, row.total], [6, card.id, limited[0].total]);
  const down = (await ledgerRows(h, patient.id)).find((l) => l.amount === -row.down_payment);
  assert.ok(down && down.payment_plan_id == null, 'down payment posted to the ledger (not counted as an installment)');
  assert.equal((await portal.post('/portal/billing/plans', { months: 3, card_id: card.id }, idem())).status, 409, 'one plan at a time');

  // Autopay off and on again; removing the card stops autopay and tells the office.
  assert.equal((await portal.put(`/portal/billing/plans/${row.id}/autopay`, { card_id: null })).data.autopay_card_id, null);
  assert.equal((await portal.put(`/portal/billing/plans/${row.id}/autopay`, { card_id: card.id })).data.autopay_card_id, card.id);
  const removed = await portal.del(`/portal/billing/cards/${card.id}`);
  assert.equal(removed.data.autopay_stopped, 1);
  assert.equal((await h.db.get('SELECT autopay_method_id FROM payment_plans WHERE id = ?', row.id)).autopay_method_id, null);
  assert.ok((await h.db.get('SELECT removed_at FROM payment_methods WHERE id = ?', card.id)).removed_at, 'marked removed, not deleted');
});

test('PT3: pay my bill — by statement code or name + birth date + ZIP; only the amount due before the one-time code; rate limited', async () => {
  const slug = `pt3-${Date.now()}`;
  const { api, patient, son } = await household(h, slug);
  const pub = h.client();
  // The statement carries the account's code and a link.
  const stmt = (await api.get(`/patients/${son.id}/statement?family=1`)).data;
  assert.match(stmt.pay_code, /^[2-9A-Z]{5}-[2-9A-Z]{5}$/);
  assert.match(stmt.billpay_url, new RegExp(`/billpay/${slug}\\?code=`));
  const code = stmt.pay_code;
  assert.equal((await api.get(`/patients/${son.id}/billpay-code`)).data.code, code, 'one code per account (the guarantor’s)');

  const info = (await pub.get(`/public/billpay/${slug}`)).data;
  assert.equal(info.payments_enabled, true);
  const found = await pub.post(`/public/billpay/${slug}/lookup`, { code: code.toLowerCase() });
  assert.equal(found.status, 200);
  const due = found.data.amount_due;
  assert.ok(due > 0);
  // Nothing but the amount due (and whether a code can be sent) before verification.
  assert.deepEqual(Object.keys(found.data).sort(), ['amount_due', 'language', 'token', 'verify']);
  assert.doesNotMatch(JSON.stringify(found.data), /Jane|Doe|jane@|555|Elm|78704/);

  // By name + birth date + ZIP: the son's details find the family account (the guarantor pays).
  const byName = await pub.post(`/public/billpay/${slug}/lookup`, { last_name: ' doe ', dob: '2012-06-01', zip: '78704' });
  assert.equal(byName.status, 200);
  assert.equal(byName.data.amount_due, due);
  assert.equal((await pub.post(`/public/billpay/${slug}/lookup`, { last_name: 'Doe', dob: '2012-06-02', zip: '78704' })).status, 404);
  assert.equal((await pub.post(`/public/billpay/${slug}/lookup`, { last_name: 'Doe', dob: '2012-06-01', zip: '99999' })).status, 404);
  assert.equal((await pub.post(`/public/billpay/${slug}/lookup`, { code, website: 'http://spam' })).status, 404, 'honeypot');
  assert.equal((await pub.post(`/public/billpay/${slug}/lookup`, { last_name: 'Doe' })).status, 400);

  // Pay the amount due with a test card — posted to the guarantor, audited as the patient.
  assert.equal((await h.client(found.data.token, idem()).post(`/public/billpay/${slug}/pay`, { amount: due + 1, card_number: '4242424242424242' })).status, 400, 'no more than the amount due');
  const payer = h.client(found.data.token, idem());
  const paid = await payer.post(`/public/billpay/${slug}/pay`, { amount: due, card_number: '4242424242424242' });
  assert.equal(paid.status, 201, JSON.stringify(paid.data));
  assert.equal(paid.data.paid, true);
  assert.equal(paid.data.amount_due, 0);
  const replay = await payer.post(`/public/billpay/${slug}/pay`, { amount: due, card_number: '4242424242424242' });
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  const pays = await ledgerRows(h, patient.id);
  assert.equal(pays.length, 1);
  assert.match(pays[0].description, /Pay my bill/);
  const a = await h.db.get("SELECT * FROM audit_log WHERE action = 'billpay.payment' AND patient_id = ?", patient.id);
  assert.equal(a.source, 'patient');
  // A tampered or foreign token can't pay.
  assert.equal((await h.client('x.y.z').post(`/public/billpay/${slug}/pay`, { amount: 100, card_number: '4242424242424242' })).status, 401);

  // The one-time code opens the full portal.
  const before2 = h.sent.length;
  assert.equal((await h.client(found.data.token).post(`/public/billpay/${slug}/verify/send`, { channel: 'sms' })).status, 200);
  await waitFor(() => h.sent.length > before2);
  const otp = h.sent.at(-1).body.match(/\d{6}/)[0];
  assert.equal(h.sent.at(-1).to, '(512) 555-0100');
  assert.equal((await h.client(found.data.token).post(`/public/billpay/${slug}/verify`, { code: '000000' === otp ? '111111' : '000000' })).status, 403);
  const ok = await h.client(found.data.token).post(`/public/billpay/${slug}/verify`, { code: otp });
  assert.equal(ok.status, 200);
  assert.equal((await h.client(ok.data.portal_token).get('/portal/account')).data.is_guarantor, true);

  // Replacing the code: the old one stops working.
  const fresh = (await api.post(`/patients/${patient.id}/billpay-code/rotate`, { reason: 'Statement went to the old address' })).data.code;
  assert.notEqual(fresh, code);
  assert.equal((await pub.post(`/public/billpay/${slug}/lookup`, { code })).status, 404);

});

test('practice isolation: another practice’s code, token or portal session finds nothing', async () => {
  const a = await household(s, `iso-a-${Date.now()}`);
  const bSlug = `iso-b-${Date.now()}`;
  await s.practice({ slug: bSlug, timezone: 'UTC' });
  const aSlug = (await s.db.get('SELECT slug FROM practices WHERE id = (SELECT practice_id FROM patients WHERE id = ?)', a.patient.id)).slug;
  const code = (await a.api.get(`/patients/${a.patient.id}/billpay-code`)).data.code;
  const pub = s.client();
  assert.equal((await pub.post(`/public/billpay/${bSlug}/lookup`, { code })).status, 404);
  const tok = (await pub.post(`/public/billpay/${aSlug}/lookup`, { code })).data.token;
  assert.equal((await s.client(tok).post(`/public/billpay/${bSlug}/pay`, { amount: 100 })).status, 401);
  assert.equal((await pub.post(`/public/billpay/${bSlug}/lookup`, { last_name: 'Doe', dob: '1985-04-12', zip: '78704' })).status, 200, 'B has its own Jane Doe');
  const bJane = (await pub.post(`/public/billpay/${bSlug}/lookup`, { last_name: 'Doe', dob: '1985-04-12', zip: '78704' })).data;
  assert.equal(bJane.amount_due, 0, 'and her own (empty) account');
});

test('PT2 on Stripe: the hosted page (card with wallets, or bank), save the card, post once from the webhook or the return; a bounced bank payment raises an item', async () => {
  const slug = `pts-${Date.now()}`;
  const { patient } = await household(s, slug);
  const portal = await portalFor(s, slug);
  const acct = (await portal.get('/portal/account')).data;
  assert.equal(acct.payment.wallets, true);
  const start = await portal.post('/portal/billing/pay', { amount: 2000, save_card: true }, idem());
  assert.equal(start.status, 201);
  assert.match(start.data.url, /^https:\/\/checkout\.stripe\.com\//);
  const call = stripe.calls.findLast((c) => c.path === 'checkout/sessions');
  assert.equal(call.params['payment_method_types[0]'], 'card');
  assert.equal(call.params['payment_intent_data[setup_future_usage]'], 'off_session');
  assert.equal(call.params['payment_intent_data[metadata][practice_id]'], String(await pidOf(s, patient.id)), 'reconciliation finds it');
  assert.equal((await ledgerRows(s, patient.id)).length, 0, 'nothing posted until Stripe says paid');
  const sessionId = [...stripe.sessions.keys()].at(-1);
  const session = stripe.sessions.get(sessionId);
  const hook = async (type, obj) => {
    const body = JSON.stringify({ type, data: { object: obj } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', WHSEC).update(`${t}.${body}`).digest('hex');
    return fetch(`${s.origin}/api/webhooks/stripe`, { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${sig}` }, body });
  };
  // Back from Stripe first (the page asks), then the webhook, then its retry: one ledger entry.
  const back = (await portal.get(`/portal/billing/return?session_id=${sessionId}`)).data;
  assert.equal(back.status, 'paid');
  for (let i = 0; i < 2; i++) assert.equal((await hook('checkout.session.completed', { ...session, payment_status: 'paid' })).status, 200);
  const pays = await ledgerRows(s, patient.id);
  assert.equal(pays.length, 1);
  assert.deepEqual([pays[0].amount, pays[0].reference, pays[0].method], [-2000, session.payment_intent, 'credit_card']);
  const saved = await s.db.get('SELECT * FROM payment_methods WHERE patient_id = ? AND removed_at IS NULL', patient.id);
  assert.deepEqual([saved.payment_method_id, saved.last4, saved.customer_id], ['pm_card_visa', '4242', 'cus_test_1']);

  // Bank payment: the hosted page for a US bank account; it bounces days later → Needs attention; nothing posted.
  const ach = await portal.post('/portal/billing/pay', { amount: 1000, method: 'ach' }, idem());
  assert.equal(ach.status, 201);
  assert.equal(stripe.calls.findLast((c) => c.path === 'checkout/sessions').params['payment_method_types[0]'], 'us_bank_account');
  const achId = [...stripe.sessions.keys()].at(-1);
  await hook('checkout.session.completed', { ...stripe.sessions.get(achId), payment_status: 'unpaid' });
  await hook('checkout.session.async_payment_failed', { ...stripe.sessions.get(achId), payment_status: 'unpaid' });
  assert.equal((await ledgerRows(s, patient.id)).length, 1);
  assert.ok(await s.db.get("SELECT id FROM issues WHERE dedupe_key = ? AND status = 'open'", `online-pay:${patient.id}`));
  // Card on file: charged off-session (a Stripe PaymentIntent), which resolves the item.
  const card = (await portal.get('/portal/account')).data.cards[0];
  const origCharge = s.app.locals.payments.charge;
  s.app.locals.payments.charge = async () => ({ ok: true, reference: 'pi_offsession_1' });
  try {
    assert.equal((await portal.post('/portal/billing/pay', { amount: 1000, how: 'saved', card_id: card.id }, idem())).status, 201);
  } finally {
    s.app.locals.payments.charge = origCharge;
  }
  assert.equal((await s.db.get("SELECT COUNT(*) AS n FROM issues WHERE dedupe_key = ? AND status = 'open'", `online-pay:${patient.id}`)).n, 0);
  // Removing the card detaches it at Stripe.
  await portal.del(`/portal/billing/cards/${card.id}`);
  assert.ok(stripe.calls.some((c) => c.path === 'payment_methods/pm_card_visa/detach'));
});

test('website button: /billpay.js is a small loader that links to the bill-pay page', async () => {
  await setup(h);
  const res = await fetch(`${h.origin}/billpay.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  const js = await res.text();
  assert.match(js, /\/billpay\/' \+ encodeURIComponent\(slug\)/);
  assert.ok(js.length < 4000);
});

// Last: it uses up this address's lookups.
test('PT3: guessing is stopped — per person looked up, and per address', async () => {
  const slug = `pt3g-${Date.now()}`;
  await household(h, slug);
  const pub = h.client();
  let status = 0;
  // Guessing: name-based lookups stop per person, and every address is capped.
  for (let i = 0; i < 12 && status !== 429; i++) status = (await pub.post(`/public/billpay/${slug}/lookup`, { last_name: 'Guess', dob: `1990-01-${String(i + 1).padStart(2, '0')}`, zip: '78704' })).status;
  assert.equal(status, 429);
  for (let i = 0; i < 45 && status !== 429; i++) status = (await pub.post(`/public/billpay/${slug}/lookup`, { code: 'AAAAA-AAAAA' })).status;
  assert.equal(status, 429);
});
