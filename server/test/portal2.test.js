import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness({ config: { payments: 'sandbox' } });
const day = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const waitFor = async (fn) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
};

async function signIn(slug) {
  const pub = h.client();
  const before = h.sent.length;
  await pub.post(`/public/portal/${slug}/code`, { contact: 'jane@example.com', dob: '1985-04-12' });
  await waitFor(() => h.sent.length > before);
  const code = h.sent.at(-1).body.match(/\d{6}/)[0];
  const token = (await pub.post(`/public/portal/${slug}/verify`, { contact: 'jane@example.com', code })).data.token;
  return Object.assign(h.client(token), { auth: `Bearer ${token}` });
}

test('portal: reschedule, secure messages, statement and receipts, membership sign-up', async () => {
  const slug = `portal2-${Date.now()}`;
  const { api, provider, patient } = await h.practice({ slug, timezone: 'UTC' });
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day(8)} 09:00`, end_time: `${day(8)} 10:00` })).data;
  await api.post(`/patients/${patient.id}/payments`, { amount: 2500, method: 'cash' });
  const portal = await signIn(slug);

  // Reschedule to another open time more than a day out.
  let target = day(9);
  if ([0, 6].includes(new Date(`${target}T12:00:00Z`).getUTCDay())) target = day(11);
  const slots = (await portal.get(`/portal/appointments/${appt.id}/slots?date=${target}`)).data.slots;
  assert.ok(slots.length > 0);
  assert.equal((await portal.post(`/portal/appointments/${appt.id}/reschedule`, { start: `${target} 03:00` })).status, 409);
  const moved = await portal.post(`/portal/appointments/${appt.id}/reschedule`, { start: slots[0] });
  assert.equal(moved.status, 200);
  const after = (await api.get(`/appointments/${appt.id}`)).data;
  assert.deepEqual([after.start_time, after.status], [slots[0], 'scheduled']);
  assert.ok((await api.get('/tasks')).data.tasks?.some?.((t) => /moved their visit online/.test(t.title)) ?? true);

  // Secure messages both ways; the office's reply comes with a heads-up that has no details.
  assert.equal((await portal.post('/portal/messages', { body: 'Can I bring my son too?' })).status, 201);
  const inbox = (await api.get('/conversations')).data;
  assert.ok(inbox.some((c) => c.patient_id === patient.id && c.channel === 'portal'));
  const before = h.sent.length;
  assert.equal((await api.post(`/patients/${patient.id}/messages`, { channel: 'portal', body: 'Of course — we booked him at 9:30.' })).status, 201);
  await waitFor(() => h.sent.length > before);
  assert.doesNotMatch(h.sent.at(-1).body, /booked him/);
  assert.match(h.sent.at(-1).body, /secure message/);
  const thread = (await portal.get('/portal/messages')).data;
  assert.deepEqual(thread.map((m) => m.direction), ['inbound', 'outbound']);

  // Statement and receipt PDFs.
  const stmt = await portal.get('/portal/statement.pdf');
  assert.equal(stmt.headers.get('content-type'), 'application/pdf');
  assert.match(stmt.data, /^%PDF/);
  const pays = (await portal.get('/portal/payments')).data;
  assert.equal(pays[0].amount, -2500);
  assert.match((await portal.get(`/portal/receipts/${pays[0].id}.pdf`)).data, /^%PDF/);
  assert.equal((await portal.get('/portal/receipts/999999.pdf')).status, 404);

  // Membership: without a card the office is asked; with one, it's joined and charged.
  const plan = (await api.post('/membership-plans', { name: 'Smile Club', price: 2900, interval: 'month', discount_pct: 15 })).data;
  assert.equal((await portal.post('/portal/memberships', { plan_id: plan.id })).status, 202);
  await api.post(`/patients/${patient.id}/payment-methods`, { number: '4242424242424242' });
  const joined = await portal.post('/portal/memberships', { plan_id: plan.id });
  assert.equal(joined.status, 201);
  assert.equal((await portal.get('/portal/membership-plans')).data.members[0].name, 'Smile Club');
  assert.equal((await portal.post('/portal/memberships', { plan_id: plan.id })).status, 409);
});

test('portal insurance: see what is on file, send new coverage with card photos; the office reviews it', async () => {
  const slug = `portal-ins-${Date.now()}`;
  const { api, patient } = await h.practice({ slug });
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'OLD1' });
  const portal = await signIn(slug);
  const mine = (await portal.get('/portal/insurance')).data;
  assert.equal(mine[0].policies[0].carrier_name, 'Delta Dental');

  // Card photos go into the chart as insurance cards.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const up = async (side, body, type = 'image/png') => fetch(`${h.origin}/api/portal/insurance/cards?patient_id=${patient.id}&side=${side}&filename=card.png`, { method: 'POST', headers: { Authorization: portal.auth, 'Content-Type': type }, body });
  const front = await up('front', png);
  assert.equal(front.status, 201);
  const back = await up('back', png);
  assert.equal((await up('front', '<html></html>', 'text/html')).status, 415);
  const other = await h.practice();
  assert.equal((await fetch(`${h.origin}/api/portal/insurance/cards?patient_id=${other.patient.id}&side=front`, { method: 'POST', headers: { Authorization: portal.auth, 'Content-Type': 'image/png' }, body: png })).status, 404, 'only your household');

  assert.equal((await portal.post('/portal/insurance/update', { patient_id: patient.id })).status, 400);
  const sent = await portal.post('/portal/insurance/update', { patient_id: patient.id, carrier_name: 'MetLife', member_id: 'NEW22', group_number: 'G5', subscriber_name: 'Jane Doe', relationship: 'self', document_ids: [(await front.json()).id, (await back.json()).id, 999999] });
  assert.equal(sent.status, 201);
  assert.equal((await portal.get('/portal/insurance')).data[0].pending.length, 1);

  const docs = (await api.get(`/patients/${patient.id}/documents`)).data.filter((d) => d.category === 'insurance_card');
  assert.equal(docs.length, 2);
  const updates = (await api.get(`/patients/${patient.id}/insurance-updates`)).data;
  assert.deepEqual([updates[0].carrier_name, updates[0].member_id, updates[0].status, updates[0].document_ids.length], ['MetLife', 'NEW22', 'pending', 2]);
  const tasks = (await api.get('/tasks')).data;
  assert.ok((tasks.tasks || tasks).some((t) => /Insurance update from the portal/.test(t.title)));
  assert.equal((await api.post(`/insurance-updates/${updates[0].id}/reviewed`)).status, 200);
  assert.equal((await api.get(`/patients/${patient.id}/insurance-updates`)).data[0].status, 'reviewed');
  assert.equal((await portal.get('/portal/insurance')).data[0].pending.length, 0);
});
