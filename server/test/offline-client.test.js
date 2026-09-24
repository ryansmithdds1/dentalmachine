// The browser's offline module, checked in Node: the encryption round trip, the queue (order, one item per
// Idempotency-Key, keys kept on resend, what's refused), the sync rules and reading screens from the copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { importKey, seal, unseal, memoryBackend, toB64, fromB64 } from '../../client/src/offline/store.js';
import { classify, createOutbox, syncOutbox, placeholder, reportBody, needsInternet, CHECK_WINDOW_MS } from '../../client/src/offline/queue.js';
import { offlineRead, usable, overlay } from '../../client/src/offline/snapshot.js';

const newKey = () => importKey(randomBytes(32).toString('base64'));
const outboxWith = async (owner = '1:7') => {
  const key = await newKey();
  const backend = memoryBackend();
  return { backend, key, box: createOutbox({ backend, getKey: async () => key, owner }) };
};
const add = (box, method, path, body, key, now) => box.add({ ...classify(method, path, body, now), key, method, path }, now);

test('encryption: a sealed record opens with its key and label only, and holds no plain text', async () => {
  const key = await newKey();
  const value = { patients: { 5: { card: { allergies: 'Penicillin' } } }, big: 'x'.repeat(300_000) };
  const sealed = await seal(key, value, 'snapshot:abc');
  assert.ok(!JSON.stringify(sealed).includes('Penicillin'));
  assert.deepEqual(await unseal(key, sealed, 'snapshot:abc'), value);
  await assert.rejects(unseal(await newKey(), sealed, 'snapshot:abc'), 'another key');
  await assert.rejects(unseal(key, sealed, 'snapshot:other'), 'another label (a record swapped in)');
  const bad = { ...sealed, data: toB64(fromB64(sealed.data).map((b, i) => (i === 5 ? b ^ 1 : b))) };
  await assert.rejects(unseal(key, bad, 'snapshot:abc'), 'altered data');
  await assert.rejects(importKey(toB64(new Uint8Array(16))), /32 bytes/);
});

test('queue: the safe changes are kept, everything else says it needs the internet', () => {
  const now = new Date('2026-09-24T15:00:00');
  assert.equal(classify('POST', '/patients/5/notes', { body: 'Prophy' }).kind, 'note');
  assert.equal(classify('PATCH', '/appointments/9/status', { status: 'checked_in' }).kind, 'status');
  assert.equal(classify('PATCH', '/appointments/9/status', { status: 'in_chair' }).kind, 'status');
  assert.equal(classify('PATCH', '/appointments/9/status', { status: 'completed' }).kind, 'status');
  assert.equal(classify('PUT', '/appointments/9/ready', { ready_for: 'doctor' }).kind, 'ready');
  assert.equal(classify('POST', '/tasks', { title: 'Call lab' }).kind, 'task');
  const cash = classify('POST', '/patients/5/payments', { amount: 4000, method: 'cash' }, now);
  assert.equal(cash.kind, 'payment');
  assert.equal(cash.body.entry_date, '2026-09-24', 'posted on the day it was taken');
  assert.equal(classify('POST', '/patients/5/payments', { amount: 4000, method: 'check', reference: '1042' }).kind, 'payment');

  assert.match(classify('POST', '/patients/5/payments', { amount: 4000, method: 'credit_card' }).refuse, /Card payments need the internet/);
  assert.match(classify('POST', '/patients/5/payments', { amount: -5, method: 'cash' }).refuse, /amount/);
  assert.match(classify('POST', '/patients/5/payments', { amount: 10.5, method: 'cash' }).refuse, /amount/, 'whole cents only');
  assert.match(classify('PATCH', '/appointments/9/status', { status: 'completed', complete_procedures: true }).refuse, /Visit only/);
  assert.match(classify('PATCH', '/appointments/9/status', { status: 'cancelled' }).refuse, /internet/);
  assert.match(classify('POST', '/notes/3/sign', {}).refuse, /Signing a note needs the internet/);
  assert.match(classify('POST', '/claims/3/submit', {}).refuse, /claims need the internet/);
  assert.match(classify('POST', '/patients/5/eligibility', {}).refuse, /eligibility needs the internet/);
  assert.match(classify('POST', '/conversations/p5/sms', { body: 'hi' }).refuse, /Texting/);
  assert.match(classify('POST', '/terminal/charge', {}).refuse, /Card payments/);
  assert.match(classify('POST', '/patients/5/adjustments', { amount: -500 }).refuse, /can’t be saved offline/);
  assert.match(needsInternet('GET', '/reports/production'), /isn’t in the offline copy/);
});

test('queue: kept in the order made, one item per Idempotency-Key, sealed at rest', async () => {
  const { box, backend } = await outboxWith();
  const t = (m) => new Date(Date.UTC(2026, 8, 24, 14, m));
  await add(box, 'PATCH', '/appointments/9/status', { status: 'checked_in' }, 'key-checkin-1', t(1));
  await add(box, 'POST', '/patients/5/notes', { body: 'BP 120/80, allergy to latex' }, 'key-note-0001', t(2));
  await add(box, 'PATCH', '/appointments/9/status', { status: 'checked_in' }, 'key-checkin-1', t(3)); // a double click
  await add(box, 'POST', '/patients/5/payments', { amount: 2500, method: 'cash' }, 'key-cash-0001', t(4));
  const items = await box.list();
  assert.deepEqual(items.map((i) => i.key), ['key-checkin-1', 'key-note-0001', 'key-cash-0001']);
  assert.deepEqual(items.map((i) => i.seq), [1, 2, 3]);
  assert.equal(items[0].queued_at, t(1).toISOString(), 'the first click is the one kept');
  const stored = JSON.stringify(await backend.all('outbox'));
  assert.ok(!stored.includes('latex') && !stored.includes('/patients/5'), 'nothing readable on disk');
  // Someone else on this computer can't read (or send) them.
  const other = createOutbox({ backend, getKey: newKey, owner: '1:8' });
  assert.deepEqual(await other.list(), []);
  assert.equal(await other.others(), 3);
});

test('sync: sent in order with each original key and body; a failure is kept, later steps for that visit wait', async () => {
  const { box } = await outboxWith();
  const now = new Date();
  await add(box, 'PATCH', '/appointments/9/status', { status: 'checked_in' }, 'k-a9-checkin', now);
  await add(box, 'POST', '/patients/5/payments', { amount: 2500, method: 'cash' }, 'k-cash-00001', now);
  await add(box, 'PATCH', '/appointments/9/status', { status: 'in_chair' }, 'k-a9-seat-01', now);
  await add(box, 'POST', '/tasks', { title: 'Call lab' }, 'k-task-00001', now);
  const before = await box.list();
  const calls = [];
  const send = async (item) => {
    calls.push([item.method, item.path, item.key, JSON.stringify(item.body)]);
    if (item.key === 'k-a9-checkin') return { status: 409, data: { error: 'Seat the patient before marking them ready' } };
    return { status: item.method === 'POST' ? 201 : 200, data: {} };
  };
  const r = await syncOutbox(box, { send, alreadySent: async () => [] });
  assert.deepEqual(calls.map((c) => c[2]), ['k-a9-checkin', 'k-cash-00001', 'k-task-00001'], 'in order; the seat step waits behind the failed check-in');
  for (const c of calls) {
    const orig = before.find((i) => i.key === c[2]);
    assert.equal(c[3], JSON.stringify(orig.body), 'the same body the key was made for');
  }
  assert.deepEqual(r.sent.map((i) => i.key), ['k-cash-00001', 'k-task-00001']);
  assert.deepEqual(r.failed.map((i) => [i.key, i.status]), [['k-a9-checkin', 409]]);
  const left = await box.list();
  assert.deepEqual(left.map((i) => [i.key, i.state]), [['k-a9-checkin', 'failed'], ['k-a9-seat-01', 'waiting']], 'nothing dropped');
  assert.match(left[0].error, /Seat the patient/);
  // The report for the server carries kinds, keys and answers — no patient details.
  const body = JSON.stringify(reportBody(r));
  assert.ok(!body.includes('/patients/') && !body.includes('Call lab'));
});

test('sync: stops when the connection drops again (the rest wait, in order), and on an expired sign-in', async () => {
  const { box } = await outboxWith();
  const now = new Date();
  for (const k of ['k-one-00001', 'k-two-00002', 'k-three-0003']) await add(box, 'POST', '/tasks', { title: k }, k, now);
  let n = 0;
  const r = await syncOutbox(box, { send: async () => { if (++n === 2) throw new Error('Failed to fetch'); return { status: 201, data: {} }; }, alreadySent: async () => [] });
  assert.equal(r.stopped, 'offline');
  assert.deepEqual((await box.list()).map((i) => i.key), ['k-two-00002', 'k-three-0003']);
  const r2 = await syncOutbox(box, { send: async () => ({ status: 401, data: {} }), alreadySent: async () => [] });
  assert.equal(r2.stopped, 'signin');
  assert.equal((await box.list()).length, 2);
  const r3 = await syncOutbox(box, { send: async () => ({ status: 503, data: {} }), alreadySent: async () => [] });
  assert.equal(r3.stopped, 'retry');
  assert.deepEqual((await box.list()).map((i) => i.state), ['waiting', 'waiting']);
});

test('sync: a change that already reached the server (answer lost) is not sent again', async () => {
  const { box } = await outboxWith();
  const now = new Date();
  await add(box, 'POST', '/patients/5/payments', { amount: 2500, method: 'cash' }, 'k-cash-arrived', now);
  await add(box, 'POST', '/patients/5/payments', { amount: 900, method: 'check' }, 'k-check-running', now);
  const sent = [];
  const r = await syncOutbox(box, {
    send: async (i) => { sent.push(i.key); return { status: 201, data: {} }; },
    alreadySent: async (keys) => {
      assert.deepEqual(keys, ['k-cash-arrived', 'k-check-running']);
      return [{ key: 'k-cash-arrived', status: 'done', response_status: 201 }, { key: 'k-check-running', status: 'running', response_status: null }];
    },
  });
  assert.deepEqual(sent, [], 'neither payment posted again');
  assert.equal(r.sent[0].already, true);
  const left = await box.list();
  assert.deepEqual(left.map((i) => [i.key, i.state]), [['k-check-running', 'check']], 'a person checks the one that may have gone through');

  // Old items (past the server's one-day memory) also wait for a person.
  const { box: old } = await outboxWith();
  await add(old, 'POST', '/tasks', { title: 'x' }, 'k-old-task-01', new Date(Date.now() - CHECK_WINDOW_MS - 60_000));
  await syncOutbox(old, { send: async () => assert.fail('not sent'), alreadySent: async () => [] });
  assert.equal((await old.list())[0].state, 'check');
  // "I checked — send it"
  await old.update('k-old-task-01', { state: 'waiting', force: true });
  const r2 = await syncOutbox(old, { send: async () => ({ status: 201, data: {} }), alreadySent: async () => [] });
  assert.equal(r2.sent.length, 1);
});

test('sync: a discarded change is reported, never sent', async () => {
  const { box } = await outboxWith();
  await add(box, 'POST', '/tasks', { title: 'x' }, 'k-discard-01', new Date());
  await box.update('k-discard-01', { state: 'discarded' });
  const r = await syncOutbox(box, { send: async () => assert.fail('not sent'), alreadySent: async () => assert.fail('nothing to check') });
  assert.deepEqual(r.discarded.map((i) => i.key), ['k-discard-01']);
});

// A copy of today like GET /offline/snapshot returns.
const snap = {
  generated_at: new Date().toISOString(), today: '2026-09-24', tomorrow: '2026-09-25', location_id: 2, max_age_hours: 14,
  schedule: {
    from: '2026-09-24', to: '2026-09-25', hours: { '2026-09-24': [['08:00', '17:00']], '2026-09-25': [] }, production: { '2026-09-24': 100, '2026-09-25': 0 },
    provider_hours: { 3: { '2026-09-24': [], '2026-09-25': [] } }, provider_exceptions: [], blockouts: [],
    appointments: [
      { id: 9, patient_id: 5, first_name: 'Jane', last_name: 'Doe', status: 'scheduled', start_time: '2026-09-24 09:00', end_time: '2026-09-24 10:00' },
      { id: 10, patient_id: 6, first_name: 'Tia', last_name: 'Lo', status: 'scheduled', start_time: '2026-09-25 09:00', end_time: '2026-09-25 10:00' },
    ],
  },
  lookups: { '/providers?active=true': [{ id: 3, name: 'Dr. Lee' }] },
  patients: { 5: { patient: { id: 5, first_name: 'Jane' }, card: { id: 5, allergies: 'Penicillin' }, notes: [{ id: 1, body: 'old note' }], chart: { conditions: [], procedures: [] }, perio: [] } },
};

test('reading the copy: the screens’ own GET paths, only for what it covers', () => {
  const day = offlineRead(snap, '/schedule?from=2026-09-24&to=2026-09-24&location_id=2');
  assert.deepEqual(day.appointments.map((a) => a.id), [9]);
  assert.deepEqual(Object.keys(day.hours), ['2026-09-24']);
  assert.equal(offlineRead(snap, '/schedule?from=2026-09-24&to=2026-09-24').appointments.length, 1);
  assert.equal(offlineRead(snap, '/schedule?from=2026-09-24&to=2026-09-25').appointments.length, 2);
  assert.equal(offlineRead(snap, '/schedule?from=2026-09-21&to=2026-09-27'), undefined, 'a week isn’t in the copy');
  assert.equal(offlineRead(snap, '/schedule?from=2026-09-24&to=2026-09-24&location_id=3'), undefined, 'nor another office');
  assert.equal(offlineRead(snap, '/patients/5/card').allergies, 'Penicillin');
  assert.equal(offlineRead(snap, '/patients/5').first_name, 'Jane');
  assert.equal(offlineRead(snap, '/patients/5/notes')[0].body, 'old note');
  assert.deepEqual(offlineRead(snap, '/patients/5/chart'), { conditions: [], procedures: [] });
  assert.equal(offlineRead(snap, '/patients/5/chart?as_of=2020-01-01'), undefined);
  assert.equal(offlineRead(snap, '/patients/6/card'), undefined, 'tomorrow’s patients’ charts aren’t kept');
  assert.equal(offlineRead(snap, '/patients/5/ledger'), undefined);
  assert.equal(offlineRead(snap, '/providers?active=true')[0].name, 'Dr. Lee');
  assert.equal(offlineRead(snap, '/appointments/10').first_name, 'Tia');
  assert.deepEqual(offlineRead(snap, '/appointments?patient_id=5&from=2000-01-01&to=2100-01-01').map((a) => a.id), [9]);
  assert.equal(offlineRead(null, '/patients/5/card'), undefined);
  assert.equal(usable(snap), true);
  assert.equal(usable({ ...snap, generated_at: new Date(Date.now() - 15 * 3600_000).toISOString() }), false, 'too old to show');
});

test('reading the copy: changes waiting to send show on it; the copy itself is untouched', () => {
  const queue = [
    { kind: 'status', key: 'k1', path: '/appointments/9/status', body: { status: 'checked_in' }, queued_at: '2026-09-24T14:00:00.000Z', state: 'waiting' },
    { kind: 'note', key: 'k2', path: '/patients/5/notes', body: { body: 'new note' }, queued_at: '2026-09-24T14:01:00.000Z', state: 'waiting' },
    { kind: 'status', key: 'k3', path: '/appointments/10/status', body: { status: 'checked_in' }, queued_at: '2026-09-24T14:02:00.000Z', state: 'discarded' },
  ];
  assert.equal(offlineRead(snap, '/appointments/9', queue).status, 'checked_in');
  assert.equal(offlineRead(snap, '/appointments/10', queue).status, 'scheduled', 'a discarded change isn’t shown');
  const notes = offlineRead(snap, '/patients/5/notes', queue);
  assert.deepEqual(notes.map((n) => n.body), ['new note', 'old note']);
  assert.equal(notes[0].signed, 0);
  assert.equal(snap.schedule.appointments[0].status, 'scheduled');
  assert.equal(overlay(snap, []), snap);
  // What the screen gets back when a change is queued.
  assert.equal(placeholder({ ...queue[0], kind: 'status' }, snap.schedule.appointments[0]).status, 'checked_in');
  const pay = placeholder({ kind: 'payment', key: 'k4', body: { amount: 2500, method: 'cash', entry_date: '2026-09-24' }, queued_at: queue[0].queued_at });
  assert.equal(pay.entry.amount, -2500);
  assert.equal(pay.balance, null, 'the balance comes from the ledger once posted');
});
