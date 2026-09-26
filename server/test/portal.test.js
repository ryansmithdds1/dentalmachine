import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const waitFor = async (fn) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
};
const h = harness({ config: { payments: 'sandbox' } });
// A 10-minute visit a few hours from now (UTC), not crossing midnight.
const soon = () => {
  const start = new Date(Date.now() + 3 * 3600_000);
  if (start.getUTCHours() >= 23) start.setUTCHours(start.getUTCHours() - 2);
  start.setUTCMinutes(Math.floor(start.getUTCMinutes() / 10) * 10);
  const end = new Date(start.getTime() + 10 * 60_000);
  const f = (d) => d.toISOString().slice(0, 16).replace('T', ' ');
  return { start_time: f(start), end_time: f(end) };
};
const day = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

test('patient portal: code sign-in, household view, confirm/cancel, pay, forms and plans', async () => {
  const slug = `portal-${Date.now()}`;
  const { api, provider, patient, token: staffToken } = await h.practice({ slug, timezone: 'UTC' });
  const kid = (await api.post(`/patients/${patient.id}/family`, { first_name: 'Kid', dob: '2015-06-01' })).data;
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D0150', provider_id: provider.id, complete: true });
  const far = (await api.post('/appointments', { patient_id: kid.id, provider_id: provider.id, start_time: `${day(5)} 09:00`, end_time: `${day(5)} 10:00`, override_blockout: true })).data; // may be a weekend
  const nearRes = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, ...soon(), override_blockout: true }));
  assert.equal(nearRes.status, 201, JSON.stringify(nearRes.data));
  const near = nearRes.data;
  const tp = (await api.post(`/patients/${kid.id}/treatment-plans`, { name: 'Sealants' })).data;
  await api.post(`/patients/${kid.id}/procedures`, { code: 'D1351', tooth: '3', provider_id: provider.id, treatment_plan_id: tp.id });
  await api.post(`/patients/${patient.id}/form-requests`, {});

  const pub = h.client();
  assert.equal((await pub.get(`/public/portal/${slug}`)).data.name.startsWith('Practice'), true);
  // Wrong date of birth: same answer, but no code is sent.
  const before = h.sent.length;
  assert.deepEqual((await pub.post(`/public/portal/${slug}/code`, { contact: 'JANE@example.com', dob: '1999-01-01' })).data, { sent: true, channel: 'email' });
  assert.equal(h.sent.length, before);
  await pub.post(`/public/portal/${slug}/code`, { contact: 'jane@example.com', dob: '1985-04-12' });
  await waitFor(() => h.sent.length > before); // codes are sent in the background
  const msg = h.sent.at(-1);
  // A later request with a mistyped birth date doesn't hide the real code.
  await pub.post(`/public/portal/${slug}/code`, { contact: 'jane@example.com', dob: '1985-04-21' });
  assert.equal(msg.to, 'jane@example.com');
  const code = msg.body.match(/\d{6}/)[0];
  assert.equal((await pub.post(`/public/portal/${slug}/verify`, { contact: 'jane@example.com', code: code === '000000' ? '111111' : '000000' })).status, 403);
  const signin = (await pub.post(`/public/portal/${slug}/verify`, { contact: 'jane@example.com', code })).data;
  assert.ok(signin.token);
  assert.equal((await pub.post(`/public/portal/${slug}/verify`, { contact: 'jane@example.com', code })).status, 403, 'codes are single-use');

  // Five wrong guesses use a code up, even when they arrive at once.
  const n = h.sent.length;
  await pub.post(`/public/portal/${slug}/code`, { contact: 'jane@example.com', dob: '1985-04-12' });
  await waitFor(() => h.sent.length > n);
  const code2 = h.sent.at(-1).body.match(/\d{6}/)[0];
  const wrong = code2 === '000000' ? '111111' : '000000';
  await Promise.all([1, 2, 3, 4, 5, 6].map(() => pub.post(`/public/portal/${slug}/verify`, { contact: 'jane@example.com', code: wrong })));
  assert.equal((await pub.post(`/public/portal/${slug}/verify`, { contact: 'jane@example.com', code: code2 })).status, 403);

  // Portal and staff sessions can't be swapped.
  const portal = h.client(signin.token);
  assert.equal((await portal.get('/patients')).status, 401);
  assert.equal((await h.client(staffToken).get('/portal/me')).status, 401);

  const me = (await portal.get('/portal/me')).data;
  assert.equal(me.household.length, 2);
  assert.equal(me.is_guarantor, true);
  assert.equal(me.balance, 11000);
  assert.deepEqual(me.appointments.map((a) => [a.id, a.can_cancel]).sort(), [[far.id, true], [near.id, false]].sort());
  assert.equal(me.treatment_plans[0].name, 'Sealants');
  assert.equal(me.forms.length, 1);

  assert.equal((await portal.post(`/portal/appointments/${far.id}/confirm`)).status, 200);
  assert.equal((await api.get(`/appointments/${far.id}`)).data.status, 'confirmed');
  assert.equal((await portal.post(`/portal/appointments/${near.id}/cancel`)).status, 409);
  assert.equal((await portal.post(`/portal/appointments/${far.id}/cancel`, { reason: 'Soccer game' })).status, 200);
  assert.equal((await api.get(`/appointments/${far.id}`)).data.status, 'cancelled');
  const tasks = (await api.get('/tasks')).data;
  assert.ok((tasks.tasks || tasks).some((t) => /cancelled .* online.*Soccer game/.test(t.title)));

  const planLink = (await portal.post(`/portal/treatment-plans/${tp.id}/open`)).data.url;
  // Already signed in to the portal: the link carries its own pass (in the #fragment), no birth date asked.
  const [tpToken, tpPass] = planLink.split('/').pop().split('#pass=');
  assert.equal((await pub.get(`/public/tp/${tpToken}`)).status, 403);
  assert.equal((await h.client(null, { 'X-Plan-Pass': tpPass }).get(`/public/tp/${tpToken}`)).status, 200);
  const formLink = (await portal.post(`/portal/forms/${me.forms[0].id}/open`)).data.url;
  const [formToken, formPass] = formLink.split('/').pop().split('#pass=');
  assert.equal((await pub.get(`/public/forms/${formToken}`)).status, 403);
  assert.equal((await h.client(null, { 'X-Form-Pass': formPass }).get(`/public/forms/${formToken}`)).status, 200);

  assert.equal((await portal.put('/portal/contact', { phone: '(512) 555-0199', sms_opt_in: false })).status, 200);
  assert.equal((await api.get(`/patients/${patient.id}`)).data.phone, '(512) 555-0199');

  assert.equal((await portal.post('/portal/pay', { amount: 99_999_00 })).status, 400, 'sandbox payments are capped at the balance');
  assert.equal((await portal.post('/portal/pay', { amount: 5000 })).data.paid, true);
  assert.equal((await portal.get('/portal/me')).data.balance, 6000);
  // Another practice's patient can't be reached.
  const other = await h.practice();
  assert.equal((await portal.post(`/portal/appointments/${(await other.api.post('/appointments', { patient_id: other.patient.id, provider_id: other.provider.id, start_time: `${day(6)} 09:00`, end_time: `${day(6)} 10:00` })).data.id}/confirm`)).status, 404);
  // Signing out ends the session on the server, not just in the browser.
  assert.equal((await portal.post('/portal/logout')).status, 200);
  assert.equal((await portal.get('/portal/me')).status, 401);
});
