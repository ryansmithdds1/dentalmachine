import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { harness } from './helpers.js';
import { runAutopay } from '../src/payments.js';
import { runPlanLateFees } from '../src/routes/family.js';
import { createMailer } from '../src/mail.js';

// ---- Sandbox autopay ----
const letters = [];
const h = harness({ config: { payments: 'sandbox', mailer: { enabled: true, name: 'Test mail', sendLetter: async (l) => { letters.push(l); return { reference: `ltr_${letters.length}`, expected_delivery_date: '2026-10-01' }; } } } });

async function planDue(api, patient, { owe = true } = {}) {
  if (owe) {
    const provider = (await api.get('/providers')).data[0];
    await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '3', provider_id: provider.id, complete: true }); // $1,350 crown
  }
  const start = new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 10); // two installments already due
  return (await api.post(`/patients/${patient.id}/payment-plans`, { total: 60000, down_payment: 0, installments: 6, frequency: 'monthly', start_date: start })).data;
}

test('autopay charges due installments to the card on file and handles declines', async () => {
  const { api, patient } = await h.practice();
  const plan = await planDue(api, patient);
  assert.equal(plan.past_due, 20000);
  assert.equal((await api.post(`/patients/${patient.id}/payment-methods`, { number: '1234 5678 9012 3456' })).status, 400, 'only test cards in sandbox');
  const card = (await api.post(`/patients/${patient.id}/payment-methods`, { number: '4242 4242 4242 4242' })).data;
  assert.deepEqual([card.brand, card.last4], ['visa', '4242']);
  assert.equal((await api.post(`/payment-plans/${plan.id}/charge-now`)).status, 409, 'no card chosen yet');
  await api.put(`/payment-plans/${plan.id}`, { autopay_method_id: card.id });

  const charged = (await api.post(`/payment-plans/${plan.id}/charge-now`)).data;
  assert.deepEqual([charged.ok, charged.amount], [true, 20000]);
  const after = (await api.get(`/patients/${patient.id}/payment-plans`)).data[0];
  assert.equal(after.past_due, 0);
  assert.equal(after.paid, 20000);
  assert.match(after.autopay_message, /Charged \$200\.00/);
  // Nothing more is due, so the daily run does nothing.
  assert.deepEqual(await runAutopay(h.db, h.app.locals.payments, h.messenger, { planId: plan.id, force: true }), []);

  // A declining card: Needs attention, an update-card link to the patient, paused (with a task) after the first try
  // and the three retries of the practice's schedule (billingauto.js).
  const plan2 = await planDue(api, patient);
  const bad = (await api.post(`/patients/${patient.id}/payment-methods`, { number: '4000000000000002' })).data;
  await api.put(`/payment-plans/${plan2.id}`, { autopay_method_id: bad.id });
  const sentBefore = h.sent.length;
  for (let i = 0; i < 4; i++) await runAutopay(h.db, h.app.locals.payments, h.messenger, { planId: plan2.id, force: true });
  const p2 = (await api.get(`/patients/${patient.id}/payment-plans`)).data.find((p) => p.id === plan2.id);
  assert.equal(p2.autopay_failures, 4);
  assert.equal(p2.autopay_paused, 1);
  assert.match(p2.autopay_message, /declined/);
  assert.ok(h.sent.length > sentBefore, 'patient was told');
  const tasks = (await api.get('/tasks')).data;
  assert.ok((tasks.tasks || tasks).some((t) => /Autopay paused/.test(t.title)));
  // The daily run skips paused plans; picking a working card turns autopay back on.
  assert.deepEqual(await runAutopay(h.db, h.app.locals.payments, h.messenger), []);
  await api.put(`/payment-plans/${plan2.id}`, { autopay_method_id: card.id });
  assert.equal((await runAutopay(h.db, h.app.locals.payments, h.messenger))[0]?.ok, true);

  // Never more than the account owes: a plan with nothing owing on the ledger isn't charged.
  const { api: api2, patient: p3 } = await h.practice();
  const plan3 = await planDue(api2, p3, { owe: false });
  const c3 = (await api2.post(`/patients/${p3.id}/payment-methods`, { number: '4242424242424242' })).data;
  await api2.put(`/payment-plans/${plan3.id}`, { autopay_method_id: c3.id });
  assert.equal((await api2.post(`/payment-plans/${plan3.id}/charge-now`)).status, 409);

  // Removing a card turns autopay off for plans using it.
  await api.del(`/payment-methods/${card.id}`);
  assert.equal((await api.get(`/patients/${patient.id}/payment-plans`)).data.every((p) => !p.autopay_method_id), true);
});

test('autopay charges each installment once, even when runs overlap or the answer is lost', async () => {
  const { api, patient } = await h.practice();
  const plan = await planDue(api, patient);
  const card = (await api.post(`/patients/${patient.id}/payment-methods`, { number: '4242 4242 4242 4242' })).data;
  await api.put(`/payment-plans/${plan.id}`, { autopay_method_id: card.id });
  const calls = [];
  let lose = 1; // the first answer is lost (timeout); the processor still charged it
  const processor = {
    enabled: true,
    async charge(args) {
      calls.push(args.idempotencyKey);
      // Long enough that the three runs really overlap: on Postgres each run's first queries can open a new
      // pool connection, so they reach the lock up to ~100 ms apart.
      await new Promise((r) => setTimeout(r, 300));
      if (lose-- > 0) return { ok: false, ambiguous: true, reason: "Couldn't confirm the charge (timeout)" };
      return { ok: true, reference: `pi_${args.idempotencyKey}` };
    },
  };
  // Three overlapping runs: only one gets to charge.
  const first = (await Promise.all([1, 2, 3].map(() => runAutopay(h.db, processor, h.messenger, { planId: plan.id, force: true })))).flat();
  assert.equal(calls.length, 1);
  assert.equal(first[0].pending, true);
  let p = (await api.get(`/patients/${patient.id}/payment-plans`)).data[0];
  assert.equal(p.paid, 0);
  assert.equal(p.autopay_failures, 0, 'a lost answer is not a decline');
  // The next run asks again with the same key, so the processor returns the original charge.
  const second = await runAutopay(h.db, processor, h.messenger);
  assert.equal(second[0].ok, true);
  assert.equal(calls[1], calls[0]);
  p = (await api.get(`/patients/${patient.id}/payment-plans`)).data[0];
  assert.equal(p.paid, 20000);
  // Once charged today, the scheduled run leaves it alone.
  assert.deepEqual(await runAutopay(h.db, processor, h.messenger), []);
  assert.equal(calls.length, 2);
});

test('statement run emails, mails through the mail service, or leaves to print', async () => {
  const { api, provider, patient } = await h.practice();
  // Patient with email; a second account with only a mailing address; a third with neither.
  const mailOnly = (await api.post('/patients', { first_name: 'Mo', last_name: 'Mail', address: '12 Oak St', city: 'Austin', state: 'TX', zip: '78704' })).data;
  const nothing = (await api.post('/patients', { first_name: 'No', last_name: 'Address' })).data;
  for (const p of [patient, mailOnly, nothing]) await api.post(`/patients/${p.id}/procedures`, { code: 'D0150', provider_id: provider.id, complete: true });
  const run = (await api.post('/statements/run', { min_balance: 1, since_days: 0 })).data;
  assert.deepEqual([run.emailed, run.mailed, run.printed], [1, 1, 1]);
  assert.deepEqual(run.print_ids, [nothing.id]);
  const letter = letters.at(-1);
  assert.equal(letter.to.name, 'Mo Mail');
  assert.equal(letter.from.zip, '78701');
  assert.match(letter.html, /Amount due now/);
  assert.match(letter.html, /Comprehensive oral evaluation/);
  assert.match(letter.html, /\/portal/);
});

test('Lob letters are sent with the right request', async () => {
  let seen;
  const mailer = createMailer({
    env: { MAIL_DRIVER: 'lob', LOB_API_KEY: 'test_abc' },
    fetchImpl: async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ id: 'ltr_123', expected_delivery_date: '2026-10-02' }), { status: 200 });
    },
  });
  const out = await mailer.sendLetter({ to: { name: 'Mo Mail', address: '12 Oak St', city: 'Austin', state: 'TX', zip: '78704' }, from: { name: 'Bright Smiles', address: '1 Main', city: 'Austin', state: 'TX', zip: '78701' }, html: '<p>hi</p>', description: 'Statement', idempotencyKey: 'k1' });
  assert.deepEqual(out, { reference: 'ltr_123', expected_delivery_date: '2026-10-02' });
  assert.equal(seen.url, 'https://api.lob.com/v1/letters');
  assert.equal(seen.init.headers.Authorization, `Basic ${Buffer.from('test_abc:').toString('base64')}`);
  assert.equal(seen.init.headers['Idempotency-Key'], 'k1');
  assert.deepEqual([seen.body.to.address_line1, seen.body.to.address_zip, seen.body.use_type, seen.body.color], ['12 Oak St', '78704', 'operational', false]);
});

// ---- Stripe (request shapes against a fake Stripe) ----
const calls = [];
const fakeStripe = async (url, init) => {
  const u = new URL(url);
  const params = init.body ? Object.fromEntries(new URLSearchParams(init.body.toString())) : Object.fromEntries(u.searchParams);
  calls.push({ path: u.pathname, method: init.method, params, headers: init.headers });
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  if (u.pathname === '/v1/customers') return json({ id: 'cus_1' });
  if (u.pathname === '/v1/checkout/sessions') return json({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
  if (u.pathname === '/v1/setup_intents/seti_1') return json({ id: 'seti_1', payment_method: { id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } } });
  if (u.pathname === '/v1/payment_intents') return json({ id: 'pi_1', status: 'succeeded' });
  return new Response('{}', { status: 404 });
};
const hs = harness({ config: { stripeSecretKey: 'sk_test_1', stripeWebhookSecret: 'whsec_1' }, fetchImpl: fakeStripe });

test('Stripe: card-on-file link, webhook saves the card, off-session autopay charge', async () => {
  const { api, patient } = await hs.practice();
  const setup = (await api.post(`/patients/${patient.id}/card-setup`, { send: 'auto' })).data;
  assert.equal(setup.url, 'https://checkout.stripe.com/c/pay/cs_1');
  const session = calls.find((c) => c.path === '/v1/checkout/sessions').params;
  assert.deepEqual([session.mode, session.customer, session['metadata[purpose]']], ['setup', 'cus_1', 'card_on_file']);
  assert.match(hs.sent.at(-1).body, /Add your card securely/);

  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'setup', setup_intent: 'seti_1', customer: 'cus_1', metadata: { purpose: 'card_on_file', patient_id: String(patient.id), practice_id: session['metadata[practice_id]'] } } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', 'whsec_1').update(`${t}.${event}`).digest('hex');
  const res = await fetch(`${hs.origin}/api/webhooks/stripe`, { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${sig}`, 'Content-Type': 'application/json' }, body: event });
  assert.equal(res.status, 200);
  const [card] = (await api.get(`/patients/${patient.id}/payment-methods`)).data;
  assert.deepEqual([card.brand, card.last4, card.provider], ['visa', '4242', 'stripe']);

  const plan = await planDue(api, patient);
  await api.put(`/payment-plans/${plan.id}`, { autopay_method_id: card.id });
  assert.equal((await api.post(`/payment-plans/${plan.id}/charge-now`)).data.ok, true);
  const pi = calls.find((c) => c.path === '/v1/payment_intents');
  assert.deepEqual([pi.params.amount, pi.params.customer, pi.params.payment_method, pi.params.off_session, pi.params.confirm], ['20000', 'cus_1', 'pm_1', 'true', 'true']);
  assert.match(pi.headers['Idempotency-Key'], new RegExp(`^autopay-${plan.id}-`));
});

test('receipts: printed, emailed or texted for any payment; automatic for autopay when turned on', async () => {
  const { api, patient } = await h.practice();
  const other = await h.practice();
  const before = h.sent.length;
  const paid = (await api.post(`/patients/${patient.id}/payments`, { amount: 5000, method: 'check', reference: '1042', receipt: 'email' })).data;
  assert.equal(paid.receipt.status, 'sent');
  assert.equal(paid.receipt.kind, 'receipt');
  const mail = h.sent.at(-1);
  assert.equal(mail.to, 'jane@example.com');
  assert.match(mail.subject, /receipt/i);
  assert.match(mail.body, /\$50\.00/);
  assert.match(mail.body, new RegExp(`#${paid.entry.id}`));

  const res = await api.get(`/payments/${paid.entry.id}/receipt.pdf`);
  assert.equal(res.status, 200);
  assert.match(String(res.data).slice(0, 8), /^%PDF/);
  assert.equal((await other.api.get(`/payments/${paid.entry.id}/receipt.pdf`)).status, 404, 'not another practice');

  const text = await api.post(`/payments/${paid.entry.id}/receipt`, { channel: 'sms' });
  assert.equal(text.status, 201);
  assert.equal(h.sent.at(-1).to, '(512) 555-0100');
  assert.equal((await api.post(`/payments/${paid.entry.id}/receipt`, { channel: 'fax' })).status, 400);
  // No receipt unless asked for.
  const n = h.sent.length;
  assert.equal((await api.post(`/patients/${patient.id}/payments`, { amount: 100, method: 'cash' })).data.receipt, null);
  assert.equal(h.sent.length, n);
  // A charge isn't a payment.
  const charge = (await api.get(`/patients/${patient.id}/ledger`)).data.entries.find((e) => e.type !== 'payment');
  if (charge) assert.equal((await api.get(`/payments/${charge.id}/receipt.pdf`)).status, 404);

  // Autopay emails a receipt; turning automatic receipts off stops it.
  const plan = await planDue(api, patient);
  const card = (await api.post(`/patients/${patient.id}/payment-methods`, { number: '4242 4242 4242 4242' })).data;
  await api.put(`/payment-plans/${plan.id}`, { autopay_method_id: card.id });
  const m1 = h.sent.length;
  assert.equal((await api.post(`/payment-plans/${plan.id}/charge-now`)).data.ok, true);
  assert.ok(h.sent.slice(m1).some((m) => m.to === 'jane@example.com' && /receipt/i.test(m.subject)), 'autopay receipt emailed');
  await api.put('/practice', { auto_receipts: false });
  const plan2 = await planDue(api, patient);
  await api.put(`/payment-plans/${plan2.id}`, { autopay_method_id: card.id });
  const m2 = h.sent.length;
  assert.equal((await api.post(`/payment-plans/${plan2.id}/charge-now`)).data.ok, true);
  assert.equal(h.sent.slice(m2).filter((m) => /receipt/i.test(m.subject || '')).length, 0);
  assert.ok(h.sent.length > before);
});

test('card readers: register, send an amount, tap, posted once with a receipt; declines and cancels', async () => {
  const { api, patient } = await h.practice();
  const other = await h.practice();
  assert.equal((await api.post('/terminal/readers', { label: 'Front desk' })).status, 400, 'needs the registration code');
  const reader = (await api.post('/terminal/readers', { registration_code: 'simulated-wpe', label: 'Front desk' })).data;
  assert.match(reader.reader_id, /^sbx_tmr_/);
  const list = (await api.get('/terminal/readers')).data;
  assert.deepEqual([list.enabled, list.test_mode, list.readers.length], [true, true, 1]);
  assert.equal((await other.api.post(`/patients/${other.patient.id}/terminal-payments`, { reader_id: reader.id, amount: 5000 })).status, 404, "another practice's reader");

  const started = await api.post(`/patients/${patient.id}/terminal-payments`, { reader_id: reader.id, amount: 5000, receipt: 'email' });
  assert.equal(started.status, 201);
  assert.equal(started.data.status, 'pending');
  assert.equal((await api.get(`/terminal-payments/${started.data.id}`)).data.status, 'pending', 'waits for the card');
  assert.equal((await api.post(`/patients/${patient.id}/terminal-payments`, { reader_id: reader.id, amount: 100 })).status, 409, 'one at a time per reader');
  const sentBefore = h.sent.length;
  const tapped = (await api.post(`/terminal-payments/${started.data.id}/simulate`)).data;
  assert.deepEqual([tapped.status, tapped.card_brand, tapped.card_last4], ['succeeded', 'visa', '4242']);
  assert.ok(tapped.ledger_entry_id);
  // Checking again (or the webhook) doesn't post it twice.
  await api.get(`/terminal-payments/${started.data.id}`);
  const payments = (await api.get(`/patients/${patient.id}/ledger`)).data.entries.filter((e) => e.type === 'payment');
  assert.equal(payments.length, 1);
  assert.equal(payments[0].amount, -5000);
  assert.match(payments[0].description, /Visa •••• 4242/);
  assert.ok(h.sent.slice(sentBefore).some((m) => /receipt/i.test(m.subject || '')), 'receipt emailed');
  // It can be refunded to the card like any card payment.
  const refund = await api.post(`/patients/${patient.id}/refunds`, { amount: 1000, payment_id: payments[0].id });
  assert.equal(refund.status, 201, JSON.stringify(refund.data));

  // A decline ends it without touching the ledger; a cancel frees the reader.
  const declined = (await api.post(`/patients/${patient.id}/terminal-payments`, { reader_id: reader.id, amount: 1002 })).data;
  const d = (await api.post(`/terminal-payments/${declined.id}/simulate`)).data;
  assert.deepEqual([d.status, d.ledger_entry_id], ['failed', null]);
  assert.match(d.error, /declined/);
  const waiting = (await api.post(`/patients/${patient.id}/terminal-payments`, { reader_id: reader.id, amount: 2000 })).data;
  assert.equal((await api.post(`/terminal-payments/${waiting.id}/cancel`)).data.status, 'canceled');
  assert.equal((await api.post(`/terminal-payments/${waiting.id}/simulate`)).status, 409);
  assert.equal((await api.get(`/patients/${patient.id}/ledger`)).data.entries.filter((e) => e.type === 'payment').length, 1);

  // Removing a reader keeps its history.
  assert.equal((await api.del(`/terminal/readers/${reader.id}`)).status, 200);
  assert.equal((await api.get('/terminal/readers')).data.readers.length, 0);
  assert.equal((await api.post(`/patients/${patient.id}/terminal-payments`, { reader_id: reader.id, amount: 5000 })).status, 400);
});

test('payment plans: staff can re-arrange the schedule; late fees charged once per late installment', async () => {
  const { api, patient } = await h.practice();
  const plan = await planDue(api, patient); // $600 over 6 monthly, two already due
  const s = plan.schedule;
  // Must add up to what's financed, in date order.
  assert.equal((await api.put(`/payment-plans/${plan.id}`, { schedule: [{ due_date: s[0].due_date, amount: 50000 }] })).status, 400);
  assert.equal((await api.put(`/payment-plans/${plan.id}`, { schedule: [{ due_date: s[1].due_date, amount: 30000 }, { due_date: s[0].due_date, amount: 30000 }] })).status, 400);
  // A smaller first payment, then the rest spread over four.
  const edited = [{ due_date: s[0].due_date, amount: 4000 }, ...[1, 2, 3, 4].map((i) => ({ due_date: s[i].due_date, amount: 14000 }))];
  const res = await api.put(`/payment-plans/${plan.id}`, { schedule: edited });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.schedule_edited, true);
  assert.deepEqual(res.data.schedule.map((x) => x.amount), [4000, 14000, 14000, 14000, 14000]);
  assert.equal(res.data.past_due, 18000, 'the first two as re-arranged');
  assert.equal(res.data.installments, 5);

  // Late fees: $25 once an installment is 20 days late (only the first is; the second is about 10 days late), never twice.
  await api.put(`/payment-plans/${plan.id}`, { late_fee: 2500, late_fee_days: 20 });
  const first = await runPlanLateFees(h.db);
  const mine = first.filter((f) => f.plan_id === plan.id);
  assert.equal(mine.length, 1, 'only the installment more than 20 days late');
  assert.deepEqual((await runPlanLateFees(h.db)).filter((f) => f.plan_id === plan.id), []);
  const ledger = (await api.get(`/patients/${patient.id}/ledger`)).data.entries;
  const fees = ledger.filter((e) => e.adjustment_type === 'Late fee');
  assert.equal(fees.length, 1);
  assert.equal(fees[0].amount, 2500);
  const after = (await api.get(`/patients/${patient.id}/payment-plans`)).data.find((p) => p.id === plan.id);
  assert.equal(after.late_fees_charged, 2500);
  assert.equal(after.past_due, 18000, "a late fee isn't a plan payment");
  assert.equal(after.schedule[0].late_fee, 2500);
  // Going back to even installments.
  const back = (await api.put(`/payment-plans/${plan.id}`, { schedule: null })).data;
  assert.equal(back.schedule_edited, false);
  assert.equal(back.schedule.reduce((t, x) => t + x.amount, 0), 60000);
});
