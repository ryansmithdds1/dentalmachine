// Workflows #11, #12, #16, #17 and #18: completing today's work, taking a payment, suggesting the next hygiene
// visit, explaining a balance and estimating the patient's portion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness({ config: { payments: 'sandbox' } });

const count = async (table, patientId) => (await h.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE patient_id = ?`, patientId)).n;
const login = async (api, role) => {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await api.post('/users', { email, name: role, role, password: `${role}-password-123` });
  return h.client((await h.client().post('/auth/login', { email, password: `${role}-password-123` })).data.token);
};
async function insure(api, patient) {
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  return (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', annual_max: 150000, deductible: 0, pct_basic: 80, pct_major: 50 })).data;
}

test('#18 estimate: work not charted yet is priced with the primary policy, and nothing is written', async () => {
  const { api, patient } = await h.practice();
  const policy = await insure(api, patient);
  const before = [await count('procedures', patient.id), await count('ledger_entries', patient.id)];
  const est = await api.post(`/patients/${patient.id}/estimate`, { items: [{ code: 'd2740', tooth: '14' }, { code: 'D2392', tooth: '30', surfaces: 'mo' }] });
  assert.equal(est.status, 200, JSON.stringify(est.data));
  assert.equal(est.data.policy.id, policy.id, 'the primary policy by default');
  const [crown, filling] = est.data.items;
  assert.deepEqual([crown.code, crown.tooth, crown.pct], ['D2740', '14', 50]);
  assert.equal(crown.insurance, Math.round(crown.fee * 0.5));
  assert.equal(crown.patient, crown.fee - crown.insurance);
  assert.equal(filling.insurance, Math.round(filling.fee * 0.8));
  assert.equal(est.data.total_patient, crown.patient + filling.patient);
  assert.deepEqual([await count('procedures', patient.id), await count('ledger_entries', patient.id)], before, 'read-only');

  // Explicitly without insurance: the patient pays the fee.
  const self = (await api.post(`/patients/${patient.id}/estimate`, { patient_insurance_id: null, items: [{ code: 'D2740', tooth: '14' }] })).data;
  assert.equal(self.total_patient, crown.fee);
  // Already-charted work still works the old way, alongside.
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110' })).data;
  const both = (await api.post(`/patients/${patient.id}/estimate`, { procedure_ids: [proc.id], items: [{ code: 'D0120' }] })).data;
  assert.deepEqual(both.items.map((i) => i.code), ['D1110', 'D0120']);

  // Impossible input is refused.
  assert.equal((await api.post(`/patients/${patient.id}/estimate`, { items: [{ code: 'D9999X' }] })).status, 400);
  assert.equal((await api.post(`/patients/${patient.id}/estimate`, { items: [{ code: 'D2740', tooth: '99' }] })).status, 400);
  assert.equal((await api.post(`/patients/${patient.id}/estimate`, { items: [{ code: 'D2392', tooth: '30', surfaces: 'XZ' }] })).status, 400);
  assert.equal((await api.post(`/patients/${patient.id}/estimate`, { items: Array.from({ length: 51 }, () => ({ code: 'D0120' })) })).status, 400);

  // Another practice sees neither the patient, nor this patient's policy or procedures.
  const other = await h.practice();
  assert.equal((await other.api.post(`/patients/${patient.id}/estimate`, { items: [{ code: 'D2740' }] })).status, 404);
  assert.equal((await other.api.post(`/patients/${other.patient.id}/estimate`, { patient_insurance_id: policy.id, items: [{ code: 'D2740' }] })).status, 404);
  assert.equal((await other.api.post(`/patients/${other.patient.id}/estimate`, { procedure_ids: [proc.id] })).status, 404);
  // Needs billing access (an assistant has none).
  const asst = await login(api, 'assistant');
  assert.equal((await asst.post(`/patients/${patient.id}/estimate`, { items: [{ code: 'D2740' }] })).status, 403);
  const hyg = await login(api, 'hygienist');
  assert.equal((await hyg.post(`/patients/${patient.id}/estimate`, { items: [{ code: 'D2740' }] })).status, 200);
});

test('#16 next slots: the hygienist, the type length, and never on top of the patient', async () => {
  const { api, patient, provider } = await h.practice();
  const hyg = (await api.post('/providers', { name: 'Sam RDH', type: 'hygienist', npi: '1234567919' })).data;
  const type = (await api.post('/appointment-types', { name: 'Recall exam & cleaning', duration: 50 })).data;
  const monday = '2030-03-04';
  // The patient is already in at 08:00 Monday with the dentist.
  assert.equal((await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${monday} 08:00`, end_time: `${monday} 09:00` })).status, 201);
  const res = await api.get(`/patients/${patient.id}/next-slots?appointment_type_id=${type.id}&from=${monday}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.provider.id, hyg.id, 'the office hygienist when the patient has none');
  assert.equal(res.data.duration, 50);
  assert.equal(res.data.slots.length, 3);
  assert.deepEqual(res.data.slots.map((s) => s.start_time), [`${monday} 09:00`, '2030-03-05 08:00', '2030-03-06 08:00'], 'first open time each day, not over the patient');
  assert.equal(res.data.slots[0].end_time, `${monday} 09:50`);

  // The patient's own hygienist wins; a provider can be asked for.
  const hyg2 = (await api.post('/providers', { name: 'Kim RDH', type: 'hygienist', npi: '1234567927' })).data;
  await api.put(`/patients/${patient.id}`, { primary_hygienist_id: hyg2.id });
  assert.equal((await api.get(`/patients/${patient.id}/next-slots?from=${monday}`)).data.provider.id, hyg2.id);
  assert.equal((await api.get(`/patients/${patient.id}/next-slots?from=${monday}&provider_id=${provider.id}&count=1`)).data.slots.length, 1);

  // Booking the first suggestion goes through the normal booking checks, and it's gone from the next answer.
  const first = res.data.slots[0];
  const booked = await api.post('/appointments', { patient_id: patient.id, provider_id: hyg.id, appointment_type_id: type.id, start_time: first.start_time });
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  assert.equal(booked.data.end_time, first.end_time);
  const again = (await api.get(`/patients/${patient.id}/next-slots?appointment_type_id=${type.id}&from=${monday}&provider_id=${hyg.id}`)).data;
  assert.notEqual(again.slots[0].start_time, first.start_time);

  // Never in the past; bad input refused; other practices' ids are not found.
  const past = (await api.get(`/patients/${patient.id}/next-slots?from=2001-01-01`)).data;
  assert.ok(past.from >= new Date(Date.now() - 86400_000).toISOString().slice(0, 10));
  assert.equal((await api.get(`/patients/${patient.id}/next-slots?from=March`)).status, 400);
  const other = await h.practice();
  assert.equal((await other.api.get(`/patients/${patient.id}/next-slots`)).status, 404);
  assert.equal((await other.api.get(`/patients/${other.patient.id}/next-slots?provider_id=${hyg.id}`)).status, 404);
  assert.equal((await other.api.get(`/patients/${other.patient.id}/next-slots?appointment_type_id=${type.id}`)).status, 404);
  const billing = await login(api, 'billing');
  assert.equal((await billing.get(`/patients/${patient.id}/next-slots`)).status, 200, 'read-only: schedule:read is enough');
});

test('#17 the balance explained by visit adds up to the ledger balance', async () => {
  const { api, patient, provider } = await h.practice();
  const policy = await insure(api, patient);
  const filling = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id, complete: true })).data;
  const exam = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D0120', provider_id: provider.id, complete: true })).data;
  const claim = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [filling.id] })).data;
  await api.post(`/patients/${patient.id}/payments`, { amount: 1000, method: 'cash' });
  // A payment posted in error and voided: it cancels out and isn't counted.
  const wrong = (await api.post(`/patients/${patient.id}/payments`, { amount: 5000, method: 'check' })).data.entry;
  await api.post(`/ledger/${wrong.id}/void`, { reason: 'Wrong patient' });

  let why = (await api.get(`/patients/${patient.id}/balance-explained`)).data;
  const ledger = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.equal(why.balance, ledger.balance);
  assert.equal(why.patient_portion, ledger.patient_portion);
  assert.equal(why.visits.length, 1, 'both charges are one day without an appointment');
  const lines = why.visits[0].lines;
  assert.equal(lines.length, 2);
  const f = lines.find((l) => l.procedure_id === filling.id);
  const e = lines.find((l) => l.procedure_id === exam.id);
  assert.equal(f.waiting_on_insurance, claim.estimated_amount);
  assert.equal(f.patient_paid + e.patient_paid, 1000, 'the $10 paid the oldest charge first');
  const opens = why.visits.reduce((s, v) => s + v.totals.open, 0);
  assert.equal(opens - why.unapplied_credit + why.other, why.balance);
  assert.equal(why.other, 0);

  // Insurance pays: the filling shows what it paid, and nothing is waiting any more.
  await api.post(`/claims/${claim.id}/submit`);
  const pay = await api.post(`/claims/${claim.id}/payment`, { amount: claim.estimated_amount, write_off: 0 });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  why = (await api.get(`/patients/${patient.id}/balance-explained`)).data;
  const paid = why.visits[0].lines.find((l) => l.procedure_id === filling.id);
  assert.equal(paid.insurance_paid, claim.estimated_amount);
  assert.equal(paid.waiting_on_insurance, 0);
  assert.equal(why.visits.reduce((s, v) => s + v.totals.open, 0) - why.unapplied_credit + why.other, (await api.get(`/patients/${patient.id}/ledger`)).data.balance);

  // Overpaid: the credit shows as credit.
  await api.post(`/patients/${patient.id}/payments`, { amount: 100000, method: 'cash' });
  why = (await api.get(`/patients/${patient.id}/balance-explained`)).data;
  assert.ok(why.unapplied_credit > 0);
  assert.equal(why.visits.reduce((s, v) => s + v.totals.open, 0), 0);
  assert.equal(-why.unapplied_credit + why.other, why.balance);

  const other = await h.practice();
  assert.equal((await other.api.get(`/patients/${patient.id}/balance-explained`)).status, 404);
  const asst = await login(api, 'assistant');
  assert.equal((await asst.get(`/patients/${patient.id}/balance-explained`)).status, 403);
});

test('#11 today\'s work completes in one go with the default provider; un-completing needs billing access and a reason', async () => {
  const { api, patient, provider } = await h.practice();
  const planned = [];
  for (const code of ['D0120', 'D1110']) planned.push((await api.post(`/patients/${patient.id}/procedures`, { code, provider_id: provider.id })).data);
  // What the chart's "Complete today's work" sends: one complete per procedure.
  for (const p of planned) assert.equal((await api.post(`/procedures/${p.id}/complete`, {})).status, 200);
  const charges = (await api.get(`/patients/${patient.id}/ledger`)).data.entries.filter((x) => x.type === 'charge');
  assert.equal(charges.length, 2);
  assert.ok(charges.every((c) => c.provider_id === provider.id));
  // A second click can't charge twice.
  assert.equal((await api.post(`/procedures/${planned[0].id}/complete`, {})).status, 409);
  // Un-complete: the front desk (billing:write) can, with a reason; the assistant can't.
  const asst = await login(api, 'assistant');
  assert.equal((await asst.post(`/procedures/${planned[0].id}/uncomplete`, { reason: 'Charted in error' })).status, 403);
  assert.equal((await api.post(`/procedures/${planned[0].id}/uncomplete`, {})).status, 400, 'a reason is required');
  assert.equal((await api.post(`/procedures/${planned[0].id}/uncomplete`, { reason: 'Charted in error' })).status, 200);
  const l = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.equal(l.balance, charges[1].amount, 'the first charge is reversed, not deleted');
  assert.ok(l.entries.some((x) => x.voided_at && x.void_reason === 'Charted in error'));
});

test('#12 a payment sent twice with the same key posts once', async () => {
  const { api, patient, token } = await h.practice();
  const twice = h.client(token, { 'Idempotency-Key': 'pay-once-1' });
  const r1 = await twice.post(`/patients/${patient.id}/payments`, { amount: 2500, method: 'cash' });
  const r2 = await twice.post(`/patients/${patient.id}/payments`, { amount: 2500, method: 'cash' });
  assert.equal(r1.status, 201);
  assert.equal(r2.data.entry.id, r1.data.entry.id);
  assert.equal((await api.get(`/patients/${patient.id}/ledger`)).data.entries.filter((e) => e.type === 'payment').length, 1);
  assert.equal((await api.post(`/patients/${patient.id}/payments`, { amount: 0, method: 'cash' })).status, 400);
  assert.equal((await api.post(`/patients/${patient.id}/payments`, { amount: 100, method: 'bitcoin' })).status, 400);
  const other = await h.practice();
  assert.equal((await other.api.post(`/patients/${patient.id}/payments`, { amount: 100, method: 'cash' })).status, 404);
});
