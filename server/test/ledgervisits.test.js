// The ledger by visit (colour kinds, grouping, per-visit balance from the ledger) and applying a patient
// payment or adjustment to a visit: permissions, practice and patient checks, idempotency, audit, closed books.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { groupByVisit, entryKind, linkProblem } from '../src/ledgervisits.js';
import { allocate } from '../src/allocation.js';

const h = harness();

const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

// Two visits: a cleaning (Aug 1) and a filling (Sep 1) with a claim the insurer paid part of, plus a patient
// payment nobody applied to a visit.
async function setup() {
  const ctx = await h.practice();
  const { api, patient, provider, practiceId } = ctx;
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', group_number: 'ACME', annual_max: 150000, deductible: 0, pct_basic: 80, pct_major: 50 })).data;
  const appt = async (day) => (await h.db.run(
    "INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status, reason) VALUES (?, ?, ?, ?, ?, 'completed', ?)",
    practiceId ?? patient.practice_id, patient.id, provider.id, `${day} 09:00`, `${day} 10:00`, day.endsWith('08-01') ? 'Cleaning' : 'Filling',
  )).id;
  const a1 = await appt('2026-08-01');
  const a2 = await appt('2026-09-01');
  const cleaning = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, appointment_id: a1 })).data;
  const filling = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id, appointment_id: a2 })).data;
  await api.post(`/procedures/${cleaning.id}/complete`, {});
  await api.post(`/procedures/${filling.id}/complete`, {});
  const claim = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [filling.id] })).data;
  await api.post(`/claims/${claim.id}/submit`);
  assert.equal((await api.post(`/claims/${claim.id}/payment`, { amount: 10000, write_off: 2000 })).status, 200);
  const pay = (await api.post(`/patients/${patient.id}/payments`, { amount: 5000, method: 'cash' })).data.entry;
  const charge = async (procId) => h.db.get("SELECT * FROM ledger_entries WHERE procedure_id = ? AND type = 'charge'", procId);
  return { ...ctx, carrier, claim, a1, a2, pay, cleaningCharge: await charge(cleaning.id), fillingCharge: await charge(filling.id) };
}
const ledger = async (api, patient) => (await api.get(`/patients/${patient.id}/ledger`)).data;
const sumVisits = (l) => l.visits.reduce((s, v) => s + v.balance, 0) + (l.not_applied?.balance || 0);

test('kinds for colour coding, and what can be applied to a visit', () => {
  assert.equal(entryKind({ type: 'charge', amount: 100 }), 'charge');
  assert.equal(entryKind({ type: 'payment', amount: -100 }), 'patient_payment');
  assert.equal(entryKind({ type: 'insurance_payment', amount: -100 }), 'insurance_payment');
  assert.equal(entryKind({ type: 'adjustment', amount: -100, claim_id: 3 }), 'write_off');
  assert.equal(entryKind({ type: 'adjustment', amount: -100, adjustment_type: 'Insurance write-off' }), 'write_off');
  assert.equal(entryKind({ type: 'adjustment', amount: -100, adjustment_type: 'Courtesy discount' }), 'credit_adjustment');
  assert.equal(entryKind({ type: 'adjustment', amount: 2500, adjustment_type: 'NSF / returned check fee' }), 'debit_adjustment');
  assert.equal(entryKind({ type: 'refund', amount: 100 }), 'refund');
  assert.equal(linkProblem({ type: 'payment', amount: -1, entry_date: '2026-09-01' }, null), null);
  assert.match(linkProblem({ type: 'insurance_payment', claim_id: 4 }, null), /Only payments and adjustments/);
  assert.match(linkProblem({ type: 'adjustment', claim_id: 4 }, null), /claim #4/);
  assert.match(linkProblem({ type: 'payment', voided_at: 'x' }, null), /Voided/);
  assert.match(linkProblem({ type: 'payment', entry_date: '2026-01-01' }, '2026-01-31'), /closed through 2026-01-31/);
});

test('grouping (pure): claims follow their procedures, reversals follow what they reverse, balances add up', () => {
  const entries = [
    { id: 1, type: 'charge', amount: 10000, procedure_id: 11, visit_appointment_id: 7, visit_start: '2026-08-01 09:00', entry_date: '2026-08-01' },
    { id: 2, type: 'charge', amount: 20000, procedure_id: 12, entry_date: '2026-09-01' },
    { id: 3, type: 'insurance_payment', amount: -15000, claim_id: 9, entry_date: '2026-09-10' },
    { id: 4, type: 'adjustment', amount: -1000, claim_id: 9, entry_date: '2026-09-10' },
    { id: 5, type: 'payment', amount: -3000, entry_date: '2026-09-11', voided_at: 'x' },
    { id: 6, type: 'payment', amount: 3000, entry_date: '2026-09-12', reverses_id: 5 },
    { id: 7, type: 'payment', amount: -2000, entry_date: '2026-09-13', applied_to_id: 1 },
    { id: 8, type: 'payment', amount: -500, entry_date: '2026-09-14' },
  ];
  const claims = [{ id: 9, status: 'partially_paid', carrier_name: 'Delta', estimated_amount: 16000, paid_amount: 15000, write_off_estimate: 0 }];
  const { visits, unapplied } = groupByVisit(entries, claims, [{ claim_id: 9, procedure_id: 12 }]);
  assert.equal(visits.length, 2);
  const [sep, aug] = visits; // newest first
  assert.equal(sep.key, 'd2026-09-01');
  assert.deepEqual(sep.entry_ids, [2, 3, 4]);
  assert.equal(sep.balance, 20000 - 15000 - 1000);
  assert.deepEqual([sep.totals.insurance_paid, sep.totals.write_off], [15000, 1000]);
  assert.deepEqual(sep.claims.map((c) => [c.id, c.carrier_name, c.expected]), [[9, 'Delta', 1000]]);
  assert.equal(sep.insurance_expected, 1000);
  assert.equal(aug.key, 'a7');
  assert.equal(aug.date, '2026-08-01');
  assert.deepEqual(aug.entry_ids, [1, 7]);
  assert.equal(aug.balance, 8000);
  assert.equal(aug.totals.patient_paid, 2000);
  assert.deepEqual(unapplied.entry_ids, [5, 6, 8], 'a void and its reversal stay together');
  assert.equal(unapplied.balance, -500);
  assert.equal(unapplied.totals.patient_paid, 500, 'voided pairs are left out of the totals');
  const total = entries.reduce((s, e) => s + e.amount, 0);
  assert.equal(visits.reduce((s, v) => s + v.balance, 0) + unapplied.balance, total);

  // Allocation agrees: the payment applied to the August visit pays it, even though September is open too.
  const { allocations } = allocate(entries, [{ claim_id: 9, procedure_id: 12, paid_amount: 15000, adjusted_amount: 1000 }]);
  assert.deepEqual(allocations.filter((a) => a.credit_id === 7).map((a) => [a.charge_id, a.amount]), [[1, 2000]]);
});

test('ledger by visit: charges, the claim, insurance money and unapplied payments, adding up to the balance', async () => {
  const ctx = await setup();
  const l = await ledger(ctx.api, ctx.patient);
  assert.equal(sumVisits(l), l.balance);
  assert.equal(l.visits.length, 2);
  const [filling, cleaning] = l.visits;
  assert.equal(filling.appointment_id, ctx.a2);
  assert.equal(filling.date, '2026-09-01');
  assert.equal(filling.reason, 'Filling');
  assert.deepEqual(filling.claims.map((c) => [c.id, c.carrier_name, c.status]), [[ctx.claim.id, 'Delta Dental', 'paid']]);
  const kinds = (v) => v.entry_ids.map((id) => l.entries.find((e) => e.id === id).kind).sort();
  assert.deepEqual(kinds(filling), ['charge', 'insurance_payment', 'write_off']);
  assert.equal(filling.balance, ctx.fillingCharge.amount - 10000 - 2000);
  assert.deepEqual(kinds(cleaning), ['charge']);
  assert.equal(cleaning.balance, ctx.cleaningCharge.amount);
  assert.deepEqual(l.not_applied.entry_ids, [ctx.pay.id]);
  assert.equal(l.not_applied.balance, -5000);
  const byId = Object.fromEntries(l.entries.map((e) => [e.id, e]));
  assert.equal(byId[ctx.pay.id].linkable, true);
  assert.equal(byId[ctx.pay.id].visit_key, 'unapplied');
  assert.equal(byId[ctx.fillingCharge.id].linkable, false);
});

test('applying a payment to a visit: moves it there, counts it there, audited, harmless twice, and undone', async () => {
  const ctx = await setup();
  const { api, patient, pay } = ctx;
  // Before: the payment pays the oldest visit first (the cleaning).
  let why = (await api.get(`/patients/${patient.id}/balance-explained`)).data;
  const whyVisit = (w, appt) => w.visits.find((v) => v.appointment_id === appt);
  assert.equal(whyVisit(why, ctx.a1).totals.patient_paid, 5000);

  const linked = await api.post(`/ledger/${pay.id}/link`, { applied_to_id: ctx.fillingCharge.id, reason: 'Paid at the filling visit' });
  assert.equal(linked.status, 200);
  assert.equal(linked.data.unchanged, false);
  assert.equal(linked.data.entry.applied_to_id, ctx.fillingCharge.id);
  assert.equal(linked.data.entry.amount, -5000, 'the amount never changes');
  let l = await ledger(api, patient);
  assert.equal(l.not_applied, null);
  const filling = l.visits.find((v) => v.appointment_id === ctx.a2);
  assert.ok(filling.entry_ids.includes(pay.id));
  assert.equal(filling.balance, ctx.fillingCharge.amount - 10000 - 2000 - 5000);
  assert.equal(filling.totals.patient_paid, 5000);
  assert.equal(sumVisits(l), l.balance);
  // "Why this balance" now counts it on the filling.
  why = (await api.get(`/patients/${patient.id}/balance-explained`)).data;
  assert.equal(whyVisit(why, ctx.a2).totals.patient_paid, 5000);
  assert.equal(whyVisit(why, ctx.a1).totals.patient_paid, 0);

  // The same request again (double click, retry) changes nothing and records nothing more.
  const again = await api.post(`/ledger/${pay.id}/link`, { applied_to_id: ctx.fillingCharge.id });
  assert.equal(again.status, 200);
  assert.equal(again.data.unchanged, true);
  const links = await h.db.all("SELECT * FROM audit_log WHERE action = 'ledger.link' AND entity_id = ?", pay.id);
  assert.equal(links.length, 1);
  assert.deepEqual(JSON.parse(links[0].changes).applied_to_id, [null, ctx.fillingCharge.id]);
  assert.equal(links[0].reason, 'Paid at the filling visit');
  assert.equal(links[0].patient_id, patient.id);
  assert.equal(links[0].source, 'human');

  // Moving it to the other visit records before → after.
  assert.equal((await api.post(`/ledger/${pay.id}/link`, { applied_to_id: ctx.cleaningCharge.id })).status, 200);
  const moved = await h.db.get("SELECT * FROM audit_log WHERE action = 'ledger.link' AND entity_id = ? ORDER BY id DESC LIMIT 1", pay.id);
  assert.deepEqual(JSON.parse(moved.changes).applied_to_id, [ctx.fillingCharge.id, ctx.cleaningCharge.id]);

  // Undo: back to "Not applied to a visit", audited; twice is harmless.
  const un = await api.post(`/ledger/${pay.id}/unlink`, { reason: 'Undone' });
  assert.equal(un.status, 200);
  assert.equal(un.data.entry.applied_to_id, null);
  assert.equal((await api.post(`/ledger/${pay.id}/unlink`, {})).data.unchanged, true);
  const unlinks = await h.db.all("SELECT * FROM audit_log WHERE action = 'ledger.unlink' AND entity_id = ?", pay.id);
  assert.equal(unlinks.length, 1);
  assert.deepEqual(JSON.parse(unlinks[0].changes).applied_to_id, [ctx.cleaningCharge.id, null]);
  l = await ledger(api, patient);
  assert.deepEqual(l.not_applied.entry_ids, [pay.id]);
  // The ledger rows themselves: same count, same amounts.
  const rows = await h.db.all('SELECT amount FROM ledger_entries WHERE patient_id = ? ORDER BY id', patient.id);
  assert.equal(rows.reduce((s, r) => s + r.amount, 0), l.balance);
});

test('applying to a visit: permission, practice, patient and entry checks', async () => {
  const ctx = await setup();
  const { api, patient, pay } = ctx;
  // Needs billing:write — a dentist can see the ledger but not move money around.
  const email = `dds-${Date.now()}@example.com`;
  await api.post('/users', { email, name: 'Dr. Two', role: 'dentist', password: 'dentist-password-1' });
  const dds = h.client((await h.client().post('/auth/login', { email, password: 'dentist-password-1' })).data.token);
  assert.equal((await dds.get(`/patients/${patient.id}/ledger`)).status, 200);
  assert.equal((await dds.post(`/ledger/${pay.id}/link`, { applied_to_id: ctx.fillingCharge.id })).status, 403);
  assert.equal((await dds.post(`/ledger/${pay.id}/unlink`, {})).status, 403);

  // Another practice can't touch this entry, or point one of its entries at this practice's visit.
  const other = await h.practice();
  assert.equal((await other.api.post(`/ledger/${pay.id}/link`, { applied_to_id: ctx.fillingCharge.id })).status, 404);
  assert.equal((await other.api.post(`/ledger/${pay.id}/unlink`, {})).status, 404);
  const theirPay = (await other.api.post(`/patients/${other.patient.id}/payments`, { amount: 100, method: 'cash' })).data.entry;
  assert.equal((await other.api.post(`/ledger/${theirPay.id}/link`, { applied_to_id: ctx.fillingCharge.id })).status, 404);

  // Another patient's visit in the same practice.
  const sib = (await api.post('/patients', { first_name: 'Sam', last_name: 'Doe' })).data;
  const sibProc = (await api.post(`/patients/${sib.id}/procedures`, { code: 'D1120', provider_id: ctx.provider.id, complete: true })).data;
  const sibCharge = await h.db.get("SELECT id FROM ledger_entries WHERE procedure_id = ? AND type = 'charge'", sibProc.id);
  const cross = await api.post(`/ledger/${pay.id}/link`, { applied_to_id: sibCharge.id });
  assert.equal(cross.status, 400);
  assert.match(cross.data.error, /another patient/);

  // Only a visit's charge is a target; only payments and adjustments move.
  assert.equal((await api.post(`/ledger/${pay.id}/link`, {})).status, 400);
  assert.equal((await api.post(`/ledger/${pay.id}/link`, { applied_to_id: 'abc' })).status, 400);
  const ins = await h.db.get("SELECT id FROM ledger_entries WHERE patient_id = ? AND type = 'insurance_payment'", patient.id);
  assert.equal((await api.post(`/ledger/${pay.id}/link`, { applied_to_id: ins.id })).status, 400);
  assert.equal((await api.post(`/ledger/${ins.id}/link`, { applied_to_id: ctx.cleaningCharge.id })).status, 409);
  assert.equal((await api.post(`/ledger/${ctx.cleaningCharge.id}/link`, { applied_to_id: ctx.fillingCharge.id })).status, 409);
  const wo = await h.db.get("SELECT id FROM ledger_entries WHERE patient_id = ? AND type = 'adjustment' AND claim_id IS NOT NULL", patient.id);
  assert.equal((await api.post(`/ledger/${wo.id}/link`, { applied_to_id: ctx.cleaningCharge.id })).status, 409);

  // A discount can be applied to a visit too.
  const disc = (await api.post(`/patients/${patient.id}/adjustments`, { amount: -1500, description: 'Courtesy', adjustment_type: 'Courtesy discount' })).data.entry;
  assert.equal((await api.post(`/ledger/${disc.id}/link`, { applied_to_id: ctx.cleaningCharge.id })).status, 200);

  // Voided payments stay where they are.
  const p2 = (await api.post(`/patients/${patient.id}/payments`, { amount: 700, method: 'cash' })).data.entry;
  await api.post(`/ledger/${p2.id}/void`, { reason: 'Wrong patient' });
  assert.equal((await api.post(`/ledger/${p2.id}/link`, { applied_to_id: ctx.cleaningCharge.id })).status, 409);

  // Closed books: a payment dated in a closed period can't be moved (collections for that month would change).
  const old = (await api.post(`/patients/${patient.id}/payments`, { amount: 900, method: 'cash', entry_date: daysAgo(3) })).data.entry;
  assert.equal((await api.put('/practice', { lock_date: daysAgo(1) })).status, 200);
  const closed = await api.post(`/ledger/${old.id}/link`, { applied_to_id: ctx.cleaningCharge.id });
  assert.equal(closed.status, 409);
  assert.match(closed.data.error, /closed/);

  // The assistant needs the person's OK.
  const ai = h.client(ctx.token, { 'X-Acting-For': 'assistant' });
  assert.equal((await ai.post(`/ledger/${pay.id}/link`, { applied_to_id: ctx.cleaningCharge.id })).status, 428);
  assert.equal((await ai.post(`/ledger/${pay.id}/unlink`, {})).status, 428);
});
