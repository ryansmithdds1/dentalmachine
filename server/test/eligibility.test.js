import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { parse271 } from '../src/x12.js';
import { createEligibility, runEligibilityBatches, mergeFrequencies } from '../src/eligibility.js';

const h = harness();
const DAY = '2031-04-07';

test('271 frequency limits and service history are read', () => {
  const r = parse271('ISA*00*          *00*          *ZZ*PAYER          *ZZ*US             *240101*1200*^*00501*000000001*0*P*:~GS*HB*P*U*20240101*1200*1*X*005010X279A1~ST*271*0001*005010X279A1~'
    + 'EB*1*IND*35**PPO~EB*F*IND*41**********AD:D1110~HSD*VS*2***22~DTP*304*D8*20240115~EB*F*IND*41**********AD:D0274~HSD*VS*1***34*12~EB*F*IND*41**********AD:D2740~HSD*VS*1***21*5~SE*9*0001~GE*1*1~IEA*1*000000001~');
  assert.deepEqual(r.frequencies, [{ codes: ['D1110'], count: 2, per: 'benefit_year' }, { codes: ['D0274'], count: 1, months: 12 }, { codes: ['D2740'], count: 1, months: 60 }]);
  assert.deepEqual(r.history, [{ codes: ['D1110'], date: '2024-01-15' }]);
  const merged = mergeFrequencies(null, r.frequencies);
  assert.deepEqual(merged.find((f) => f.label === 'Bitewings').months, 12);
  assert.equal(merged.find((f) => f.label.startsWith('Crowns')).months, 60, 'D2740 falls under the D27 crown rule');
  assert.equal(merged.find((f) => f.label === 'Cleanings').per, 'benefit_year');
});

test("batch eligibility: a day's patients, skipping recent checks; applies payer frequencies; nightly run", async () => {
  const { api, provider, patient } = await h.practice({ timezone: 'UTC' });
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W123', annual_max: 150000, deductible: 5000 })).data;
  const noIns = (await api.post('/patients', { first_name: 'Cash', last_name: 'Only' })).data;
  for (const [p, t] of [[patient, '09:00'], [noIns, '10:00']]) await api.post('/appointments', { patient_id: p.id, provider_id: provider.id, start_time: `${DAY} ${t}`, end_time: `${DAY} ${t.slice(0, 2)}:30` });

  let day = (await api.get(`/eligibility/batch?date=${DAY}`)).data;
  assert.equal(day.automatic, true);
  assert.deepEqual(day.rows.map((r) => [r.last_name, r.carrier_name, r.status]), [['Doe', 'Delta Dental', null], ['Only', null, null]]);
  const run = (await api.post('/eligibility/batch', { date: DAY })).data;
  assert.deepEqual([run.checked, run.skipped, run.failed.length], [1, 0, 0]);
  assert.equal((await api.post('/eligibility/batch', { date: DAY })).data.skipped, 1, 'checked recently');
  day = (await api.get(`/eligibility/batch?date=${DAY}`)).data;
  assert.equal(day.rows[0].status, 'active');
  assert.equal(day.rows[0].summary.frequencies.find((f) => f.codes[0] === 'D0274').months, 12);

  // Applying the check puts the payer's limits on the plan.
  await api.post(`/eligibility/${day.rows[0].check_id}/apply`);
  const plan = (await api.get(`/patients/${patient.id}/insurance`)).data.find((x) => x.id === policy.id);
  const freqs = plan.plan.frequencies;
  assert.equal(freqs.find((f) => f.label === 'Full series or panoramic').months, 60);

  // The evening job checks tomorrow once per practice.
  const elig = createEligibility({ db: h.db, config: { ediMode: 'sandbox' } });
  const evening = new Date(`${DAY}T00:00:00Z`);
  evening.setUTCDate(evening.getUTCDate() - 1);
  evening.setUTCHours(18);
  await h.db.run("UPDATE eligibility_checks SET created_at = '2000-01-01 00:00:00'");
  const first = await runEligibilityBatches(h.db, elig, evening);
  assert.equal(first.find((x) => x.date === DAY && x.checked === 1) != null, true);
  assert.equal((await runEligibilityBatches(h.db, elig, evening)).length, 0, 'once a night');
});
