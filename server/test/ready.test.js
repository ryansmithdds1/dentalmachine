// Patient flow on the schedule: "Ready" (for the doctor or for checkout) and stepping back a step (undo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();
const DAY = '2031-01-06'; // a Monday

async function visit(api, provider, patient, time = '09:00') {
  const r = await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${DAY} ${time}`, end_time: `${DAY} ${time.slice(0, 3)}45`, override_blockout: true, notify: false });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

test('ready: set for the doctor, switch to checkout, clear; audited and idempotent', async () => {
  const { api, provider, patient } = await h.practice();
  const a = await visit(api, provider, patient);

  // Only a seated patient can be ready.
  const early = await api.put(`/appointments/${a.id}/ready`, { ready_for: 'doctor' });
  assert.equal(early.status, 409);
  assert.match(early.data.error, /Seat the patient/);
  await api.patch(`/appointments/${a.id}/status`, { status: 'checked_in' });
  await api.patch(`/appointments/${a.id}/status`, { status: 'in_chair' });

  assert.equal((await api.put(`/appointments/${a.id}/ready`, { ready_for: 'nurse' })).status, 400);
  const ready = await api.put(`/appointments/${a.id}/ready`, { ready_for: 'doctor' });
  assert.equal(ready.status, 200);
  assert.equal(ready.data.ready_for, 'doctor');
  assert.match(ready.data.ready_at, /^\d{4}-\d\d-\d\d \d\d:\d\d/);
  assert.equal(ready.data.status, 'in_chair', 'the status itself is unchanged');

  // A double click changes nothing and keeps the first time.
  const again = await api.put(`/appointments/${a.id}/ready`, { ready_for: 'doctor' });
  assert.equal(again.data.ready_at, ready.data.ready_at);
  const audits = await h.db.all("SELECT * FROM audit_log WHERE action = 'appointment.ready' AND entity_id = ? ORDER BY id", a.id);
  assert.equal(audits.length, 1);
  assert.deepEqual(JSON.parse(audits[0].details), { from: null, to: 'doctor' });
  assert.ok(audits[0].user_id, 'records who did it');

  assert.equal((await api.put(`/appointments/${a.id}/ready`, { ready_for: 'checkout' })).data.ready_for, 'checkout');
  const cleared = await api.put(`/appointments/${a.id}/ready`, { ready_for: null });
  assert.equal(cleared.data.ready_for, null);
  assert.equal(cleared.data.ready_at, null);
  const all = await h.db.all("SELECT details FROM audit_log WHERE action = 'appointment.ready' AND entity_id = ? ORDER BY id", a.id);
  assert.deepEqual(all.map((r) => JSON.parse(r.details).to), ['doctor', 'checkout', null]);

  // The schedule shows it.
  await api.put(`/appointments/${a.id}/ready`, { ready_for: 'doctor' });
  const day = (await api.get(`/schedule?from=${DAY}&to=${DAY}`)).data;
  assert.equal(day.appointments.find((x) => x.id === a.id).ready_for, 'doctor');
});

test('ready: needs schedule:write, and another practice gets 404', async () => {
  const { api, provider, patient } = await h.practice();
  const a = await visit(api, provider, patient);
  await api.patch(`/appointments/${a.id}/status`, { status: 'in_chair' });

  const other = await h.practice();
  assert.equal((await other.api.put(`/appointments/${a.id}/ready`, { ready_for: 'doctor' })).status, 404);

  const email = `billing-${Date.now()}@example.com`;
  await api.post('/users', { email, name: 'Bill', role: 'billing', password: 'billing-password-1' });
  const billing = h.client((await h.client().post('/auth/login', { email, password: 'billing-password-1' })).data.token);
  assert.equal((await billing.put(`/appointments/${a.id}/ready`, { ready_for: 'doctor' })).status, 403);
  const row = await h.db.get('SELECT ready_for FROM appointments WHERE id = ?', a.id);
  assert.equal(row.ready_for, null);
});

test('stepping back in the flow (undo) clears the times of the undone steps; completing keeps ready', async () => {
  const { api, provider, patient } = await h.practice();
  const a = await visit(api, provider, patient);
  await api.patch(`/appointments/${a.id}/status`, { status: 'confirmed', confirmed_via: 'phone' });
  const inn = (await api.patch(`/appointments/${a.id}/status`, { status: 'checked_in' })).data;
  assert.ok(inn.arrived_at);

  // Undo the check-in: back to confirmed, arrival time gone (the change log keeps it).
  const back = (await api.patch(`/appointments/${a.id}/status`, { status: 'confirmed' })).data;
  assert.equal(back.status, 'confirmed');
  assert.equal(back.arrived_at, null);
  assert.ok(back.confirmed_at, 'the confirmation stays');

  await api.patch(`/appointments/${a.id}/status`, { status: 'in_chair' });
  await api.put(`/appointments/${a.id}/ready`, { ready_for: 'checkout' });
  const out = (await api.patch(`/appointments/${a.id}/status`, { status: 'completed' })).data;
  assert.ok(out.dismissed_at);
  // Undo "out": back in the chair, still ready for checkout, no dismissal time.
  const undone = (await api.patch(`/appointments/${a.id}/status`, { status: 'in_chair', undo: true })).data;
  assert.equal(undone.dismissed_at, null);
  assert.equal(undone.ready_for, 'checkout');
  assert.ok(undone.seated_at);
  // Back to the waiting room: no longer seated or ready.
  const waiting = (await api.patch(`/appointments/${a.id}/status`, { status: 'checked_in' })).data;
  assert.equal(waiting.seated_at, null);
  assert.equal(waiting.ready_for, null);
  assert.ok(waiting.arrived_at);
  const audits = await h.db.all("SELECT details FROM audit_log WHERE action = 'appointment.status' AND entity_id = ? ORDER BY id", a.id);
  assert.deepEqual(audits.map((r) => JSON.parse(r.details).to), ['confirmed', 'checked_in', 'confirmed', 'in_chair', 'completed', 'in_chair', 'checked_in']);
  assert.deepEqual(audits.map((r) => !!JSON.parse(r.details).undo), [false, false, false, false, false, true, false], 'the undo is marked');
});
