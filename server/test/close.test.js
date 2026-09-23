import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

test('month-end close: totals, loose ends, and locking the books', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const pid = (await api.get('/practice')).data.id;
  const lastMonth = new Date();
  lastMonth.setUTCDate(1);
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  const month = lastMonth.toISOString().slice(0, 7);
  const day = `${month}-10`;
  await h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, type, amount, description, entry_date) VALUES (?, ?, 'charge', 20000, 'Crown', ?)", pid, patient.id, day);
  await h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, type, amount, description, method, entry_date) VALUES (?, ?, 'payment', -5000, 'Cash', 'cash', ?)", pid, patient.id, day);
  await h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'scheduled')", pid, patient.id, provider.id, `${day} 09:00`, `${day} 10:00`);

  const s = (await api.get(`/close?type=month&period=${month}`)).data;
  assert.deepEqual([s.totals.production, s.totals.patient_payments, s.totals.net_collections], [20000, 5000, 5000]);
  const loose = Object.fromEntries(s.checks.map((c) => [c.key, c.count]));
  assert.equal(loose.visits, 1);
  assert.equal(loose.undeposited, 1);
  assert.equal(s.closed, false);

  assert.equal((await api.post('/close', { type: 'month', period: '2099-01' })).status, 400, 'not over yet');
  const closed = await api.post('/close', { type: 'month', period: month });
  assert.equal(closed.status, 201);
  assert.equal((await api.get('/practice')).data.lock_date, s.end);
  assert.equal((await api.post('/close', { type: 'month', period: month })).status, 409);
  // Nothing more can be posted into the closed month.
  const late = await api.post(`/patients/${patient.id}/payments`, { amount: 100, method: 'cash', entry_date: day });
  assert.equal(late.status, 400);
  assert.match(late.data.error, /closed through/);
  const hist = (await api.get(`/close?type=month&period=${month}`)).data;
  assert.equal(hist.closed, true);
  assert.equal(JSON.parse(hist.history[0].totals).open_items.visits, 1);

  // Only administrators close the books.
  const staff = (await api.post('/users', { email: `fd-${Date.now()}@example.com`, name: 'Desk', role: 'billing', password: 'correct-horse-battery' })).data;
  const login = await h.client().post('/auth/login', { email: staff.email, password: 'correct-horse-battery' });
  assert.equal((await h.client(login.data.token).post('/close', { type: 'day', period: `${month}-28` })).status, 403);
});
