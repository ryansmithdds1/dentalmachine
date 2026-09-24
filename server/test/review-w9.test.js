// Review W9 regressions: office-restricted staff can't reach another office's patients through the insurance
// and billing autopilots or payment agreements; journey records follow a merged chart and are backed up; a late
// fee held back by its yearly limit isn't shown as charged; resuming dunning never reuses a declined key.
// (The paper-EOB findings are in eobauto.test.js, which has the stand-in for the AI.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { insert } from '../src/util.js';
import { backupTables } from '../src/backup.js';
import { runAutoFees, runRecurringCharges, addDays, todayFor, retryNow } from '../src/billingauto.js';
import { planStatus } from '../src/routes/family.js';

const h = harness({ config: { payments: 'sandbox' } });
const practiceOf = async (patient) => (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', patient.id)).practice_id;

// A user limited to the Westside office, while the patient belongs to Main St.
async function westsideUser(api, patient, role) {
  const main = (await api.post('/locations', { name: 'Main St' })).data;
  const west = (await api.post('/locations', { name: `Westside ${role}` })).data;
  await h.db.run('UPDATE patients SET location_id = ? WHERE id = ?', main.id, patient.id);
  const email = `west-${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = (await api.post('/users', { email, name: `West ${role}`, role, password: 'west-desk-password' })).data;
  assert.equal((await api.put(`/users/${u.id}`, { location_ids: [west.id] })).status, 200);
  const login = await h.client().post('/auth/login', { email, password: 'west-desk-password' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const desk = h.client(login.data.token);
  assert.equal((await desk.get(`/patients/${patient.id}`)).status, 404, 'the patient is hidden from the Westside user');
  return desk;
}

test('W9 office: someone limited to one office gets 404 on another office’s remittance lines, agreements and billing records', async () => {
  const { api, patient } = await h.practice();
  const pid = await practiceOf(patient);
  const desk = await westsideUser(api, patient, 'billing');

  // Insurance autopilot: the line, a decision on it, and the claims offered for "match".
  const lineId = await insert(h.db, 'remit_lines', { practice_id: pid, source: 'era', dedupe_key: 'w9-1', line_no: 0, patient_id: patient.id, billed: 23500, paid: 15000, state: 'exception', kind: 'review', reason: 'test', payer_name: 'DELTA' });
  assert.equal((await desk.get(`/eob-autopilot/lines/${lineId}`)).status, 404);
  assert.equal((await desk.post(`/eob-autopilot/lines/${lineId}/dismiss`, { note: 'nothing to do' })).status, 404);
  assert.equal((await h.db.get('SELECT state FROM remit_lines WHERE id = ?', lineId)).state, 'exception', 'nothing changed');
  assert.equal((await api.get(`/eob-autopilot/lines/${lineId}`)).status, 200, 'the whole-practice admin still sees it');
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', annual_max: 150000, deductible: 0, pct_basic: 80, effective_date: '2025-01-01' })).data;
  const claimId = await insert(h.db, 'claims', { practice_id: pid, patient_id: patient.id, patient_insurance_id: policy.id, status: 'submitted', total_fee: 23500 });
  const unmatched = await insert(h.db, 'remit_lines', { practice_id: pid, source: 'era', dedupe_key: 'w9-2', line_no: 0, patient_id: null, billed: 23500, paid: 15000, state: 'exception', kind: 'unmatched', reason: 'no claim', payer_name: 'DELTA' });
  const offered = await desk.get(`/eob-autopilot/lines/${unmatched}`);
  assert.equal(offered.status, 200);
  assert.ok(!offered.data.candidates.some((c) => c.id === claimId), 'another office’s claim isn’t offered for match');
  assert.ok((await api.get(`/eob-autopilot/lines/${unmatched}`)).data.candidates.some((c) => c.id === claimId));
  assert.equal((await desk.post(`/eob-autopilot/lines/${unmatched}/match`, { claim_id: claimId })).status, 404, 'nor can it be matched by id');

  // Payment agreements.
  const tp = await insert(h.db, 'treatment_plans', { practice_id: pid, patient_id: patient.id, name: 'Crowns' });
  const fa = await insert(h.db, 'fin_agreements', { practice_id: pid, patient_id: patient.id, treatment_plan_id: tp, phases: '[1]', option_key: 'full', kind: 'full', total: 100000, due_today: 95000, discount_amount: 5000, discount_status: 'pending', snapshot: JSON.stringify({ chosen: { discount_pct: 5 } }), snapshot_hash: 'x', quote_hash: 'y' });
  assert.equal((await desk.get(`/fin-agreements/${fa}`)).status, 404);
  assert.equal((await desk.post(`/fin-agreements/${fa}/prepay`, { method: 'cash' })).status, 404);
  assert.equal((await h.db.get('SELECT discount_status FROM fin_agreements WHERE id = ?', fa)).discount_status, 'pending');

  // Billing autopilot: authorizations, dunning, recurring charges.
  const auth = await insert(h.db, 'billing_authorizations', { practice_id: pid, patient_id: patient.id, kind: 'recurring', setup: '{}', terms: 'Terms', terms_hash: 'w9' });
  assert.equal((await desk.get(`/billing/authorizations/${auth}`)).status, 404);
  assert.equal((await desk.post(`/billing/authorizations/${auth}/revoke`, { reason: 'asked' })).status, 404);
  const today = await todayFor(h.db, pid);
  const pm = await insert(h.db, 'payment_methods', { practice_id: pid, patient_id: patient.id, provider: 'sandbox', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 });
  const rid = await insert(h.db, 'recurring_charges', { practice_id: pid, patient_id: patient.id, amount: 10000, day_of_month: 1, next_charge_date: today, description: 'Monthly', payment_method_id: pm });
  assert.equal((await desk.post(`/billing/recurring/${rid}/charge-now`, {})).status, 404);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM billing_attempts WHERE source_id = ?', rid)).n, 0, 'no card was charged');
  const did = await insert(h.db, 'billing_dunning', { practice_id: pid, patient_id: patient.id, source_type: 'recurring', source_id: rid, payment_method_id: pm, amount: 10000, status: 'paused', failures: 3, first_failed_on: today, last_failed_on: today, live_key: `recurring:${rid}` });
  for (const action of ['retry', 'send-link', 'resume', 'stop']) {
    assert.equal((await desk.post(`/billing/dunning/${did}/${action}`, { note: 'x' })).status, 404, action);
  }
  assert.equal((await h.db.get('SELECT status FROM billing_dunning WHERE id = ?', did)).status, 'paused');

  // Waiving a fee needs a manager: an administrator limited to Westside can't waive a Main St patient's fee.
  const fee = await insert(h.db, 'billing_fees', { practice_id: pid, name: 'Late fee', kind: 'fixed', amount: 2500, occasion: 'manual' });
  const entry = await insert(h.db, 'ledger_entries', { practice_id: pid, patient_id: patient.id, type: 'adjustment', adjustment_type: 'Office fee', amount: 2500, description: 'Late fee', entry_date: today });
  const charge = await insert(h.db, 'billing_fee_charges', { practice_id: pid, patient_id: patient.id, fee_id: fee, source_key: 'manual:w9', amount: 2500, ledger_entry_id: entry });
  const westAdmin = await westsideUser(api, patient, 'admin');
  assert.equal((await westAdmin.post(`/billing/fee-charges/${charge}/waive`, { reason: 'goodwill' })).status, 404);
  assert.equal((await h.db.get('SELECT status FROM billing_fee_charges WHERE id = ?', charge)).status, 'posted');
  assert.equal((await westAdmin.post(`/billing/fees/${fee}/apply`, { patient_id: patient.id })).status, 404, 'a fee can’t be added to their account either');
});

test('W9 merge: a duplicate chart’s journey choices move to the kept chart, and journey tables are backed up', async () => {
  const { api, patient } = await h.practice();
  const dup = (await api.post('/patients', { first_name: 'Jane', last_name: 'Doe', dob: '1985-04-12', phone: '(512) 555-0100' })).data;
  assert.equal((await api.put(`/journeys/patients/${dup.id}/prefs`, { no_celebrations: true, vip: true })).status, 200);
  const m = await api.post(`/patients/${patient.id}/merge`, { from_id: dup.id });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.equal(m.data.moved['journey_prefs.patient_id'], 1);
  const kept = (await api.get(`/journeys/patients/${patient.id}/prefs`)).data;
  assert.equal(!!kept.no_celebrations, true, 'no celebrations follows the kept chart');
  assert.equal(!!kept.vip, true);
  assert.equal(await h.db.get('SELECT id FROM journey_prefs WHERE patient_id = ?', dup.id), undefined);

  // Both charts with choices: the kept chart takes the stricter one; the duplicate's row stays on its chart.
  const dup2 = (await api.post('/patients', { first_name: 'Jane', last_name: 'Doe', dob: '1985-04-12', phone: '(512) 555-0100' })).data;
  const other = (await api.post('/patients', { first_name: 'Sam', last_name: 'Roe', dob: '1990-01-01' })).data;
  assert.equal((await api.put(`/journeys/patients/${other.id}/prefs`, { vip: false })).status, 200);
  assert.equal((await api.put(`/journeys/patients/${dup2.id}/prefs`, { no_celebrations: true })).status, 200);
  const m2 = await api.post(`/patients/${other.id}/merge`, { from_id: dup2.id });
  assert.equal(m2.status, 200, JSON.stringify(m2.data));
  assert.equal(!!(await api.get(`/journeys/patients/${other.id}/prefs`)).data.no_celebrations, true);
  assert.ok(await h.db.get('SELECT id FROM journey_prefs WHERE patient_id = ?', dup2.id));

  const tables = backupTables().map((t) => t.table);
  for (const t of ['journey_settings', 'journey_profile', 'journey_prefs', 'journey_links', 'journey_checkins', 'journey_moments', 'journey_referrals', 'journey_cards', 'journey_broadcasts', 'journey_broadcast_recipients']) {
    assert.ok(tables.includes(t), `${t} is in the backup`);
  }
});

test('W9 late fee: a fee held back by its yearly limit doesn’t mark the installment as charged', async () => {
  const { api, patient } = await h.practice();
  const pid = await practiceOf(patient);
  const today = await todayFor(h.db, pid);
  const planId = await insert(h.db, 'payment_plans', { practice_id: pid, patient_id: patient.id, total: 30000, down_payment: 0, installments: 3, installment_amount: 10000, frequency: 'monthly', start_date: addDays(today, -75) });
  await insert(h.db, 'ledger_entries', { practice_id: pid, patient_id: patient.id, type: 'charge', amount: 30000, description: 'Work', entry_date: addDays(today, -80) });
  const fee = await api.post('/billing/fees', { name: 'Late fee', kind: 'fixed', amount: 2500, occasion: 'late_payment', applies: 'automatic', max_per_year: 1 });
  assert.equal(fee.status, 201, JSON.stringify(fee.data));
  await h.db.run("UPDATE billing_fees SET created_at = '2020-01-01 00:00:00' WHERE id = ?", fee.data.id);
  const out = await runAutoFees(h.db, pid);
  assert.equal(out.late, 1, 'one fee posts; the yearly limit holds back the second');
  const posted = Number((await h.db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE patient_id = ? AND adjustment_type = 'Office fee'", patient.id)).n);
  const plan = await planStatus(h.db, await h.db.get('SELECT * FROM payment_plans WHERE id = ?', planId), today);
  assert.equal(plan.late_fees_charged, posted, 'the plan screen shows what was really charged');
  assert.equal(plan.schedule.filter((s) => s.late_fee).length, 1);
  const rows = await h.db.all('SELECT installment, ledger_entry_id FROM payment_plan_late_fees WHERE plan_id = ?', planId);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].ledger_entry_id, 'the kept row is the fee that posted');
  // Running again posts nothing more and claims nothing.
  assert.equal((await runAutoFees(h.db, pid)).late, 0);
  assert.equal((await h.db.all('SELECT id FROM payment_plan_late_fees WHERE plan_id = ?', planId)).length, 1);
});

test('W9 resume: a retry after resuming dunning gets a fresh idempotency key, and the history is kept', async () => {
  const { api, patient } = await h.practice();
  const pid = await practiceOf(patient);
  const today = await todayFor(h.db, pid);
  await insert(h.db, 'ledger_entries', { practice_id: pid, patient_id: patient.id, type: 'charge', amount: 90000, description: 'Work', entry_date: today });
  const pm = await insert(h.db, 'payment_methods', { practice_id: pid, patient_id: patient.id, provider: 'sandbox', brand: 'visa', last4: '0002', exp_month: 12, exp_year: 2030 });
  const rid = await insert(h.db, 'recurring_charges', { practice_id: pid, patient_id: patient.id, amount: 10000, day_of_month: 1, next_charge_date: today, description: 'Monthly', payment_method_id: pm });
  const keys = [];
  let decline = true;
  const payments = { enabled: true, mode: 'stripe', charge: async ({ idempotencyKey }) => { keys.push(idempotencyKey); return decline ? { ok: false, reason: 'Card declined' } : { ok: true, reference: `pi_${keys.length}` }; } };
  await runRecurringCharges(h.db, payments, null, { id: rid, force: true });
  for (let i = 0; i < 3; i++) await retryNow(h.db, payments, null, 'recurring', rid);
  const d = await h.db.get('SELECT * FROM billing_dunning WHERE source_id = ?', rid);
  assert.equal(d.status, 'paused');
  const res = await api.post(`/billing/dunning/${d.id}/resume`, {});
  assert.equal(res.status, 200, JSON.stringify(res.data));
  decline = false;
  await retryNow(h.db, payments, null, 'recurring', rid);
  assert.equal(new Set(keys).size, keys.length, `every try went with its own key: ${JSON.stringify(keys)}`);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM billing_attempts WHERE source_id = ? AND source_type = 'recurring'", rid)).n, keys.length, 'every attempt is kept');
  assert.ok(await h.db.get("SELECT id FROM ledger_entries WHERE patient_id = ? AND type = 'payment' AND amount = -10000", patient.id), 'the retry after the resume charged the card');
  const trail = await h.db.get("SELECT changes FROM audit_log WHERE action = 'billing.dunning_resume' AND entity_id = ?", d.id);
  assert.match(trail.changes, /"status":\["paused","retrying"\]/);
});
