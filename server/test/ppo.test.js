import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();
const DAY = 86400_000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// One-hour visits, each with one $400 crown prep, written off at the carrier's rate.
async function visit({ api, provider, practiceId }, patient, daysAgo, policy, writeOff) {
  const d = ymd(Date.now() - daysAgo * DAY);
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${d} 09:00`, end_time: `${d} 10:00`, override_blockout: true, notify: false })).data;
  await h.db.run("UPDATE appointments SET status = 'completed' WHERE id = ?", appt.id);
  const code = await h.db.get("SELECT id FROM procedure_codes WHERE practice_id = ? AND code = 'D2740'", practiceId);
  const pr = await h.db.get(
    "INSERT INTO procedures (practice_id, patient_id, appointment_id, provider_id, code_id, code, description, category, fee, status, completed_at) VALUES (?, ?, ?, ?, ?, 'D2740', 'Crown', 'crowns', 40000, 'completed', ?) RETURNING id",
    practiceId, patient.id, appt.id, provider.id, code.id, `${d} 10:00:00`,
  );
  if (!policy) return;
  const cl = await h.db.get("INSERT INTO claims (practice_id, patient_id, patient_insurance_id, status, total_fee, paid_amount) VALUES (?, ?, ?, 'paid', 40000, ?) RETURNING id", practiceId, patient.id, policy.id, (40000 - writeOff) / 2);
  await h.db.run('INSERT INTO claim_items (claim_id, procedure_id, fee, write_off, adjusted_amount, paid_amount) VALUES (?, ?, 40000, ?, ?, ?)', cl.id, pr.id, writeOff, writeOff, (40000 - writeOff) / 2);
}

test('PPO profitability: net per chair hour against the cost of an hour, and what dropping a plan would do', async () => {
  const ctx = await h.practice();
  const { api } = ctx;
  const cheap = (await api.post('/carriers', { name: 'Cheap PPO' })).data;
  const good = (await api.post('/carriers', { name: 'Good PPO' })).data;
  const person = async (first, carrier) => {
    const p = (await api.post('/patients', { first_name: first, last_name: 'Test' })).data;
    const policy = carrier ? (await api.post(`/patients/${p.id}/insurance`, { carrier_id: carrier.id, subscriber_name: first, subscriber_id: first })).data : null;
    return { p, policy };
  };
  const [a1, a2, b1, c1] = [await person('Ann', cheap), await person('Al', cheap), await person('Bea', good), await person('Cy', null)];
  for (const [who, n] of [[a1, 10], [a1, 40], [a2, 70], [a2, 100]]) await visit(ctx, who.p, n, who.policy, 24000);
  for (const n of [15, 45]) await visit(ctx, b1.p, n, b1.policy, 8000);
  for (const n of [20, 50]) await visit(ctx, c1.p, n, null, 0);

  const res = await api.get('/finance/ppo?cost_per_hour=30000');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const by = Object.fromEntries(res.data.carriers.map((c) => [c.name, c]));
  const A = by['Cheap PPO'];
  assert.deepEqual([A.patients, A.visits, A.chair_hours, A.gross, A.write_off, A.net, A.write_off_pct], [2, 4, 4, 160000, 96000, 64000, 60]);
  assert.deepEqual([A.net_per_hour, A.profit_per_hour], [16000, -14000]);
  assert.deepEqual(A.codes[0], { code: 'D2740', description: 'Crown', count: 4, fee: 40000, allowed: 16000, pct_of_fee: 40 });
  // 70% stay and pay the full fee (+$672 of write-offs kept), 30% leave (-$192), half their 1.2 hours refilled at $360/h (+$216).
  assert.deepEqual([A.drop.recaptured_write_offs, A.drop.lost_net, A.drop.refilled, A.drop.change_per_year], [67200, 19200, 21600, 69600]);
  assert.equal(A.verdict, 'consider_dropping');
  assert.equal(A.raise_needed_pct, 88);
  assert.deepEqual([by['Good PPO'].net_per_hour, by['Good PPO'].verdict], [32000, 'profitable']);
  assert.equal(by['No insurance'].net_per_hour, 40000);
  assert.equal(by['No insurance'].drop, undefined);
  assert.match(res.data.insights[0].text, /Cheap PPO nets \$160 an hour against \$300/);

  // If everyone leaves and nobody replaces them, the plan is worth keeping and renegotiating.
  const strict = (await api.get('/finance/ppo?cost_per_hour=30000&retention=0&refill=0')).data.carriers.find((c) => c.name === 'Cheap PPO');
  assert.deepEqual([strict.drop.change_per_year, strict.verdict], [-64000, 'renegotiate']);

  // Without cost data or a cost entered, there's no verdict — just the plan's numbers.
  const bare = (await api.get('/finance/ppo')).data;
  assert.equal(bare.cost_per_hour, null);
  assert.equal(bare.carriers.find((c) => c.name === 'Cheap PPO').verdict, null);
});
