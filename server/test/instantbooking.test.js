import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { harness } from './helpers.js';

const calls = [];
let sessions = 0;
const fakeStripe = async (url, init) => {
  const u = new URL(url);
  const params = init.body ? Object.fromEntries(new URLSearchParams(init.body.toString())) : {};
  calls.push({ path: u.pathname, params });
  if (u.pathname === '/v1/checkout/sessions') { sessions++; return new Response(JSON.stringify({ id: `cs_dep_${sessions}`, url: `https://checkout.stripe.com/c/pay/cs_dep_${sessions}` })); }
  return new Response('{}', { status: 404 });
};
const h = harness({ config: { stripeSecretKey: 'sk_test_1', stripeWebhookSecret: 'whsec_1' }, fetchImpl: fakeStripe });

const nextWeekday = (plus = 3) => {
  const d = new Date(Date.now() + plus * 86400_000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const webhook = async (event) => {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', 'whsec_1').update(`${t}.${body}`).digest('hex');
  return fetch(`${h.origin}/api/webhooks/stripe`, { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${sig}`, 'Content-Type': 'application/json' }, body });
};

async function setup(extra = {}) {
  const slug = `ib-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ctx = await h.practice({ timezone: 'UTC', slug, online_booking: true, ...extra });
  const type = (await ctx.api.post('/appointment-types', { name: 'New patient exam', duration: 60, online_bookable: true, provider_type: 'dentist' })).data;
  const day = nextWeekday();
  const slots = (await h.client().get(`/public/practices/${slug}/availability?date=${day}&reason=${encodeURIComponent('New patient exam')}`)).data.slots;
  return { ...ctx, slug, type, day, slots };
}

test('instant booking: the visit goes straight on the schedule, existing patients are matched, insurance is added', async () => {
  const { api, slug, provider, patient, slots } = await setup({ instant_booking: true });
  const before = h.sent.length;
  const res = await h.client().post(`/public/practices/${slug}/booking-requests`, {
    first_name: 'Jane', last_name: 'Doe', dob: '1985-04-12', phone: '(512) 555-0100', reason: 'New patient exam', start: slots[0].start, provider_id: provider.id,
    insurance_carrier: 'Delta Dental', insurance_member_id: 'DD999',
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.booked, true);
  const appts = (await api.get(`/patients/${patient.id}`)).data.upcoming_appointments;
  assert.equal(appts.length, 1); // booked on Jane's existing chart, not a new one
  assert.equal((await api.get('/patients?q=Doe')).data.rows.length, 1);
  assert.match(h.sent.slice(before)[0].body, /you're booked/);
  const pol = (await api.get(`/patients/${patient.id}/insurance`)).data[0];
  assert.deepEqual([pol.carrier_name, pol.subscriber_id, pol.relationship], ['Delta Dental', 'DD999', 'self']);
  assert.ok((await api.get(`/tasks?patient_id=${patient.id}`)).data.some((t) => /Verify insurance from online booking/.test(t.title)));
  assert.equal((await api.get('/booking-requests')).data.length, 0); // nothing left for the office to accept
  // The slot is gone for the next person.
  const again = await h.client().post(`/public/practices/${slug}/booking-requests`, { first_name: 'Al', last_name: 'B', phone: '5125550111', reason: 'New patient exam', start: slots[0].start, provider_id: provider.id });
  assert.equal(again.status, 409);
});

test('deposits: paid on Stripe, then booked; an unpaid checkout releases the slot', async () => {
  const { api, slug, provider, type, slots, day } = await setup({ instant_booking: true });
  await api.put(`/appointment-types/${type.id}`, { deposit: 5000 });
  const info = (await h.client().get(`/public/practices/${slug}`)).data;
  assert.equal(info.reasons.find((r) => r.label === 'New patient exam').deposit, 5000);

  const res = (await h.client().post(`/public/practices/${slug}/booking-requests`, { first_name: 'Dee', last_name: 'Posit', email: 'dee@example.com', reason: 'New patient exam', start: slots[0].start, provider_id: provider.id })).data;
  assert.match(res.checkout_url, /checkout\.stripe\.com/);
  const session = calls.filter((c) => c.path === '/v1/checkout/sessions').at(-1).params;
  assert.equal(session['line_items[0][price_data][unit_amount]'], '5000');
  // Held while the checkout is open: not offered, and not in the office's queue yet.
  let open = (await h.client().get(`/public/practices/${slug}/availability?date=${day}&reason=${encodeURIComponent('New patient exam')}`)).data.slots;
  assert.ok(!open.some((s) => s.start === slots[0].start));
  assert.equal((await api.get('/booking-requests')).data.length, 0);

  const paid = { type: 'checkout.session.completed', data: { object: { id: `cs_dep_${sessions}`, mode: 'payment', payment_status: 'paid', amount_total: 5000, payment_intent: 'pi_dep', metadata: { booking_request_id: String(res.id) } } } };
  assert.equal((await webhook(paid)).status, 200);
  assert.equal((await webhook(paid)).status, 200); // Stripe retries: applied once
  const pt = (await api.get('/patients?q=Posit')).data.rows[0];
  const full = (await api.get(`/patients/${pt.id}`)).data;
  assert.equal(full.upcoming_appointments.length, 1);
  assert.equal(full.balance, -5000); // the deposit is a credit on the account

  // Second booking never paid.
  const res2 = (await h.client().post(`/public/practices/${slug}/booking-requests`, { first_name: 'Nope', last_name: 'Pay', email: 'n@example.com', reason: 'New patient exam', start: slots[2].start, provider_id: provider.id })).data;
  await webhook({ type: 'checkout.session.expired', data: { object: { id: `cs_dep_${sessions}`, metadata: { booking_request_id: String(res2.id) } } } });
  open = (await h.client().get(`/public/practices/${slug}/availability?date=${day}&reason=${encodeURIComponent('New patient exam')}`)).data.slots;
  assert.ok(open.some((s) => s.start === slots[2].start));
  assert.equal((await api.get('/patients?q=Pay')).data.rows.length, 0);
});

test('without instant booking, requests still wait for the office (and accept uses the same matching)', async () => {
  const { api, slug, provider, patient, slots } = await setup();
  const res = (await h.client().post(`/public/practices/${slug}/booking-requests`, { first_name: 'jane', last_name: 'doe', dob: '1985-04-12', phone: '5125550100', reason: 'New patient exam', start: slots[1].start, provider_id: provider.id })).data;
  assert.equal(res.booked, undefined);
  const [reqd] = (await api.get('/booking-requests')).data;
  assert.equal(reqd.id, res.id);
  const acc = await api.post(`/booking-requests/${res.id}/accept`, {});
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  assert.equal((await api.get(`/patients/${patient.id}`)).data.upcoming_appointments.length, 1);
});
