import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { runOrthoBilling } from '../src/ortho.js';
import { addInterval } from '../src/memberships.js';
import { localNow } from '../src/util.js';

const h = harness({ config: { payments: 'sandbox' } });
// The practice's own date (the default time zone), which is what billing goes by.
const today = () => localNow().slice(0, 10);

async function insured(api, patient, plan) {
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', group_number: 'ORTHO' })).data;
  await api.put(`/insurance-plans/${policy.plan_id}`, plan);
  return policy;
}

test('estimate: insurance pays its ortho percentage up to the lifetime maximum, only under the age limit', async () => {
  const { api, patient } = await h.practice();
  let est = (await api.post(`/patients/${patient.id}/ortho/estimate`, { total_fee: 600000, down_payment: 100000, months: 24 })).data;
  assert.equal(est.insurance_estimate, 0);
  assert.match(est.insurance_note, /No insurance/);

  await insured(api, patient, { ortho_max: 150000, ortho_pct: 50, ortho_age_limit: 19 });
  est = (await api.post(`/patients/${patient.id}/ortho/estimate`, { total_fee: 600000, down_payment: 100000, months: 24 })).data;
  assert.equal(est.insurance_estimate, 0, 'the 41-year-old is past the age limit');
  assert.match(est.insurance_note, /under age 19/);

  const kid = (await api.post('/patients', { first_name: 'Timmy', last_name: 'Doe', dob: '2014-05-01' })).data;
  await insured(api, kid, { ortho_max: 150000, ortho_pct: 50, ortho_age_limit: 19 });
  est = (await api.post(`/patients/${kid.id}/ortho/estimate`, { total_fee: 600000, down_payment: 100000, months: 24 })).data;
  assert.equal(est.insurance_estimate, 150000, '50% of $6000 capped at the $1500 max');
  assert.equal(est.patient_portion, 450000);
  assert.equal(est.monthly_amount, Math.floor(350000 / 24));
  assert.equal(est.monthly_amount * 23 + est.last_month, 350000, 'the last month absorbs the rounding');
  assert.equal((await api.post(`/patients/${kid.id}/ortho/estimate`, { total_fee: 600000, months: 0 })).status, 400);
});

test('starting treatment posts the down payment; months come due from the start date and autopay charges the card', async () => {
  const { api, patient, provider } = await h.practice();
  const pm = (await api.post(`/patients/${patient.id}/payment-methods`, { number: '4242424242424242' })).data;
  const start = addInterval(today(), 'month', -2);
  const res = await api.post(`/patients/${patient.id}/ortho`, { total_fee: 500000, down_payment: 50000, months: 18, provider_id: provider.id, appliance: 'aligners', start_date: start, payment_method_id: pm.id });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const c = res.data;
  assert.equal(c.monthly_amount, 25000);
  assert.equal(c.billed_months, 2, 'two months past the start date are billed straight away');
  assert.equal(c.next_bill_date, addInterval(start, 'month', 3));
  assert.equal(c.billed, 50000 + 2 * 25000);

  const ledger = (await h.db.all('SELECT type, amount, reference FROM ledger_entries WHERE ortho_case_id = ? ORDER BY id', c.id));
  assert.deepEqual(ledger.filter((l) => l.type === 'charge').map((l) => l.amount), [50000, 25000, 25000]);
  assert.deepEqual(ledger.filter((l) => l.type === 'payment').map((l) => l.amount), [-25000, -25000], 'autopay paid both months');

  // Running again bills nothing more until next month.
  assert.deepEqual(await runOrthoBilling(h.db, h.app.locals.payments), []);
  assert.equal((await api.post(`/patients/${patient.id}/ortho`, { total_fee: 1000, months: 1 })).status, 409, 'one active case at a time');

  // The adjustment log.
  assert.equal((await api.post(`/ortho/${c.id}/visits`, {})).status, 400);
  const v = await api.post(`/ortho/${c.id}/visits`, { aligner: '6 of 22', elastics: 'Class II, 1/4" 6oz', notes: 'Tracking well', next_weeks: 6 });
  assert.equal(v.status, 201);
  const view = (await api.get(`/patients/${patient.id}/ortho`)).data.cases[0];
  assert.equal(view.visits.length, 1);
  assert.equal(view.visits[0].aligner, '6 of 22');

  // Debond: into retention.
  const upd = await api.put(`/ortho/${c.id}`, { status: 'retention', debond_date: today() });
  assert.equal(upd.data.status, 'retention');
  assert.equal((await api.put(`/ortho/${c.id}`, { status: 'bogus' })).status, 400);
});

test('a declined card still bills the month, raises a Needs attention item once, and the last month evens out the balance', async () => {
  const { api, patient } = await h.practice();
  const pm = (await api.post(`/patients/${patient.id}/payment-methods`, { number: '4000000000000002' })).data;
  const start = addInterval(today(), 'month', -3);
  const c = (await api.post(`/patients/${patient.id}/ortho`, { total_fee: 100000, months: 3, start_date: start, payment_method_id: pm.id })).data;
  assert.equal(c.billed_months, 3);
  assert.equal(c.billed, 100000, '33333 + 33333 + 33334');
  const pays = await h.db.get("SELECT COUNT(*) AS n FROM ledger_entries WHERE ortho_case_id = ? AND type = 'payment'", c.id);
  assert.equal(pays.n, 0);
  // Billing autopilot (billingauto.js): one item for billing; later months wait for the retry instead of piling on.
  const items = await h.db.all('SELECT * FROM issues WHERE dedupe_key = ?', `dunning:ortho_case:${c.id}`);
  assert.equal(items.length, 1);
  assert.equal(items[0].occurrences, 1);
  assert.ok(c.billing_failures >= 1);
});
