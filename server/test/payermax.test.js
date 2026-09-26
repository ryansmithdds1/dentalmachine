// Estimates use the payer's own "maximum left" (from insurance verification) when it's lower than what our
// claims say: the payer knows about work done at other offices. Owner decision, 2026-09.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { insert, localNow, zonedToUtc } from '../src/util.js';
import { estimateCoverage } from '../src/benefits.js';

const h = harness();

async function setUp() {
  const { api, patient } = await h.practice();
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', annual_max: 100000, deductible: 0, pct_major: 50 });
  const policy = await h.db.get('SELECT * FROM patient_insurance WHERE patient_id = ?', patient.id);
  const pc = await h.db.get('SELECT category FROM procedure_codes WHERE practice_id = ? AND code = ?', policy.practice_id, 'D2740');
  const crown = { id: null, patient_id: patient.id, code: 'D2740', category: pc.category, fee: 135000, tooth: '3' };
  const verified = (maxRemaining, createdAt = null) => insert(h.db, 'benefit_verifications', {
    practice_id: policy.practice_id, patient_id: patient.id, patient_insurance_id: policy.id, plan_id: policy.plan_id, method: 'phone',
    patient_detail: JSON.stringify({ max_remaining: maxRemaining }), ...(createdAt ? { created_at: createdAt } : {}),
  });
  return { policy, crown, verified };
}

test('no payer figure: the maximum left comes from claims here', async () => {
  const { policy, crown } = await setUp();
  const est = await estimateCoverage(h.db, policy, [crown]);
  assert.equal(est.items[0].insurance, 67500);
  assert.equal(est.remaining.annual_max_source, 'claims');
});

test('the payer says less is left (work elsewhere): the estimate is capped at the payer’s figure, with a note', async () => {
  const { policy, crown, verified } = await setUp();
  await verified(30000);
  const est = await estimateCoverage(h.db, policy, [crown]);
  assert.equal(est.items[0].insurance, 30000);
  assert.equal(est.remaining.annual_max, 0);
  assert.equal(est.remaining.annual_max_source, 'payer');
  assert.ok(est.items[0].notes.some((n) => /insurer/.test(n)), est.items[0].notes.join('; '));
});

test('the payer says more is left than our claims do: our (lower) figure stands', async () => {
  const { policy, crown, verified } = await setUp();
  await verified(200000);
  const est = await estimateCoverage(h.db, policy, [crown]);
  assert.equal(est.items[0].insurance, 67500);
  assert.equal(est.remaining.annual_max_source, 'claims');
});

test('a figure from an earlier benefit year is ignored; a bad figure is skipped', async () => {
  const { policy, crown, verified } = await setUp();
  // The office's year (New York), not UTC's: on a New Year's Eve evening UTC is already in the next year.
  const lastYear = `${Number(localNow('America/New_York').slice(0, 4)) - 1}-01-15 10:00:00`;
  await verified(1000, lastYear);
  let est = await estimateCoverage(h.db, policy, [crown]);
  assert.equal(est.items[0].insurance, 67500);
  await verified('not a number');
  est = await estimateCoverage(h.db, policy, [crown]);
  assert.equal(est.items[0].insurance, 67500);
});

test('the benefit year of a payer figure is the office’s: New Year’s Eve evening belongs to the year that’s ending', async () => {
  const year = localNow('America/New_York').slice(0, 4);
  // 10 pm on Dec 31 last year, New York time — already Jan 1 of this year in UTC: last year's figure, ignored.
  const a = await setUp();
  await a.verified(1000, zonedToUtc('America/New_York', `${Number(year) - 1}-12-31`, '22:00'));
  assert.equal((await estimateCoverage(h.db, a.policy, [a.crown])).items[0].insurance, 67500);
  // 9 pm on Dec 31 this year, New York time (Jan 1 next year in UTC): this year's figure, used.
  const b = await setUp();
  await b.verified(30000, zonedToUtc('America/New_York', `${year}-12-31`, '21:00'));
  assert.equal((await estimateCoverage(h.db, b.policy, [b.crown])).items[0].insurance, 30000);
});
