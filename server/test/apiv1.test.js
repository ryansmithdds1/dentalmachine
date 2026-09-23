import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { harness } from './helpers.js';
import { deliverWebhooks, scanPayments } from '../src/webhooks.js';

const received = [];
let failNext = 0;
const fetchImpl = async (url, init) => {
  if (String(url).startsWith('https://hooks.example.com')) {
    received.push({ url, body: init.body, headers: init.headers });
    if (failNext > 0) { failNext--; return new Response('nope', { status: 500 }); }
    return new Response('ok');
  }
  return new Response('{}', { status: 404 });
};
const h = harness({ fetchImpl });
const settle = () => new Promise((r) => setTimeout(r, 50));
const apiClient = (key) => ({
  call: async (method, path, body) => {
    const res = await fetch(`${h.origin}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  },
});

test('public API: keys and scopes, patients, availability and booking', async () => {
  const { api, patient, provider } = await h.practice();
  assert.equal((await api.post('/api-keys', { name: 'Website', scopes: ['everything'] })).status, 400);
  const k = (await api.post('/api-keys', { name: 'Website', scopes: ['patients:read', 'appointments:read', 'appointments:write'] })).data;
  assert.match(k.key, /^dm_live_/);
  assert.equal((await api.get('/api-keys')).data.keys[0].key, undefined); // never shown again
  const v1 = apiClient(k.key);
  assert.equal((await apiClient('dm_live_wrong').call('GET', '/me')).status, 401);
  assert.equal((await v1.call('GET', '/me')).data.key, 'Website');

  const pats = (await v1.call('GET', '/patients?limit=1')).data;
  assert.equal(pats.data[0].id, patient.id);
  assert.equal(pats.data[0].password_hash, undefined);
  assert.equal((await v1.call('GET', `/patients?phone=5125550100`)).data.data.length, 1);
  assert.equal((await v1.call('POST', '/patients', { first_name: 'A', last_name: 'B' })).status, 403); // no patients:write

  const d = new Date(Date.now() + 7 * 86400_000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  const day = d.toISOString().slice(0, 10);
  const slots = (await v1.call('GET', `/availability?date=${day}&provider_id=${provider.id}&duration=60`)).data.data;
  assert.ok(slots.length > 0);
  const booked = await v1.call('POST', '/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: slots[0].start_time, duration: 60 });
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  assert.equal((await v1.call('POST', '/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: slots[0].start_time, duration: 60 })).status, 409); // double-booked
  const confirmed = (await v1.call('POST', `/appointments/${booked.data.id}/confirm`)).data;
  assert.equal(confirmed.status, 'confirmed');
  assert.equal((await api.get(`/patients/${patient.id}`)).data.upcoming_appointments[0].status, 'confirmed');
  const listed = (await v1.call('GET', `/appointments?from=${day}&to=${day}`)).data.data;
  assert.equal(listed.length, 1);

  await api.del(`/api-keys/${k.id}`);
  assert.equal((await v1.call('GET', '/me')).status, 401);
});

test('webhooks: signed deliveries for appointments, patients and payments, retried on failure', async () => {
  const { api, patient, provider } = await h.practice();
  assert.equal((await api.post('/webhooks', { url: 'http://insecure.example.com', events: ['*'] })).status, 400);
  const ep = (await api.post('/webhooks', { url: 'https://hooks.example.com/dm', events: ['appointment.created', 'patient.created', 'payment.created'] })).data;
  assert.match(ep.secret, /^whsec_/);

  const before = received.length;
  const newPt = (await api.post('/patients', { first_name: 'Web', last_name: 'Hook' })).data;
  await settle();
  const got = received.slice(before);
  assert.equal(got.length, 1);
  const evt = JSON.parse(got[0].body);
  assert.deepEqual([evt.type, evt.data.object.id], ['patient.created', newPt.id]);
  // The signature verifies with the endpoint secret.
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(got[0].headers['DM-Signature']);
  assert.equal(createHmac('sha256', ep.secret).update(`${t}.${got[0].body}`).digest('hex'), v1);

  // A failing endpoint is retried later.
  failNext = 1;
  const d = new Date(Date.now() + 7 * 86400_000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  const day = d.toISOString().slice(0, 10);
  await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 10:00`, end_time: `${day} 11:00` });
  await settle();
  let hooks = (await api.get('/webhooks')).data;
  const pending = hooks.deliveries.find((x) => x.event === 'appointment.created');
  assert.deepEqual([pending.status, pending.attempts, pending.response_code], ['pending', 1, 500]);
  await deliverWebhooks(h.db, { fetchImpl, now: new Date(Date.now() + 2 * 60_000) });
  hooks = (await api.get('/webhooks')).data;
  assert.equal(hooks.deliveries.find((x) => x.id === pending.id).status, 'delivered');

  // Payments from anywhere are picked up by the scan.
  await api.post(`/patients/${patient.id}/payments`, { amount: 2500, method: 'cash' });
  const n = received.length;
  await scanPayments(h.db);
  await settle();
  const pay = received.slice(n).map((r) => JSON.parse(r.body)).find((e) => e.type === 'payment.created');
  assert.equal(pay.data.object.amount, 2500);
  await scanPayments(h.db);
  await settle();
  assert.equal(received.slice(n).filter((r) => JSON.parse(r.body).type === 'payment.created').length, 1); // once

  const test2 = (await api.post(`/webhooks/${ep.id}/test`)).data;
  assert.equal(test2.status, 'delivered');
});
