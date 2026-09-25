// Phase 2, batch 1A (schedule, front desk, chairside): what checkout asks for (A017), the next hygiene visit near
// the time of today's visit (A027), one recall call for all of a patient's recalls (A051), logging an ordinary
// call on the chart (A053) and plain-language time-clock errors (A107).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { localNow } from '../src/util.js';

const h = harness({ config: { payments: 'sandbox' } });

const login = async (api, role) => {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await api.post('/users', { email, name: `${role} person`, role, password: `${role}-password-123` });
  return h.client((await h.client().post('/auth/login', { email, password: `${role}-password-123` })).data.token);
};
const monthsAgo = (n) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };
const utcAgo = (min) => new Date(Date.now() - min * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const auditRows = (action, entityId) => h.db.all('SELECT * FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY id', action, entityId);

test('A017 checkout: "due now" is today’s share plus the older balance, from the ledger, less what insurance still owes', async () => {
  const { api, patient, provider } = await h.practice();
  const tz = (await api.get('/practice')).data.timezone;
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', annual_max: 150000, deductible: 0, pct_basic: 80, pct_major: 50 })).data;
  // Older work, already on a claim: insurance's estimate is pending, the rest is the patient's.
  const filling = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id, complete: true })).data;
  const claim = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [filling.id] })).data;
  assert.ok(claim.id, JSON.stringify(claim));
  const olderShare = filling.fee - claim.estimated_amount;
  assert.ok(olderShare > 0);
  // Today's visit with its work done and no claim yet.
  const day = localNow(tz, new Date()).slice(0, 10);
  const visit = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 07:00`, end_time: `${day} 07:30`, override_blockout: true })).data;
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D0120', provider_id: provider.id, appointment_id: visit.id, complete: true });
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, appointment_id: visit.id, complete: true });

  let co = (await api.get(`/appointments/${visit.id}/checkout`)).data;
  const ledger = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.equal(co.balance, ledger.balance, 'the balance is the ledger’s');
  assert.equal(co.due.today_share, co.estimate.total_patient);
  assert.equal(co.due.earlier, olderShare, 'the older balance is the patient’s part of the earlier work');
  assert.equal(co.due.now, olderShare + co.estimate.total_patient);
  assert.equal(co.suggested_payment, co.due.now, 'the payment box starts on what’s due now');
  const todaysIns = co.estimate.items.reduce((s, i) => s + i.insurance + i.write_off, 0);
  assert.equal(co.due.insurance_expected, claim.estimated_amount + todaysIns);
  assert.equal(co.due.now, co.balance - co.due.insurance_expected, 'what the patient owes after insurance');

  // A payment today comes off "due now"; the older balance and today's share don't change.
  const paid = await api.post(`/patients/${patient.id}/payments`, { amount: 1000, method: 'cash' });
  assert.equal(paid.status, 201, JSON.stringify(paid.data));
  co = (await api.get(`/appointments/${visit.id}/checkout`)).data;
  assert.equal(co.paid_today, 1000);
  assert.equal(co.due.now, olderShare + co.estimate.total_patient - 1000);

  // Filing today's claim moves its estimate into "pending": the amount due stays the same.
  const before = co.due.now;
  const todays = co.procedures.map((p) => p.id);
  assert.equal((await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: todays })).status, 201);
  co = (await api.get(`/appointments/${visit.id}/checkout`)).data;
  assert.equal(co.due.now, before);

  // Without billing access the money is left out.
  const asst = await login(api, 'assistant');
  const seen = (await asst.get(`/appointments/${visit.id}/checkout`)).data;
  assert.equal(seen.due, null);
  assert.equal(seen.suggested_payment, null);
});

test('A027 next slots near the time of today’s visit; bad times refused', async () => {
  const { api, patient } = await h.practice();
  const hyg = (await api.post('/providers', { name: 'Sam RDH', type: 'hygienist', npi: '1234567919' })).data;
  const type = (await api.post('/appointment-types', { name: 'Recall exam & cleaning', duration: 50 })).data;
  const monday = '2030-03-04';
  const first = (await api.get(`/patients/${patient.id}/next-slots?appointment_type_id=${type.id}&from=${monday}&count=2`)).data;
  assert.equal(first.near, null);
  assert.ok(first.slots.every((s) => s.start_time.endsWith('08:00')), 'without a preferred time: the first open time');
  const after = (await api.get(`/patients/${patient.id}/next-slots?appointment_type_id=${type.id}&from=${monday}&count=2&near=15:00`)).data;
  assert.equal(after.near, '15:00');
  assert.equal(after.provider.id, hyg.id);
  assert.deepEqual(after.slots.map((s) => s.start_time.slice(11)), ['15:00', '15:00'], 'the open time closest to today’s visit time');
  // Taken at 15:00 on the Monday: the closest one left that day.
  assert.equal((await api.post('/appointments', { patient_id: patient.id, provider_id: hyg.id, appointment_type_id: type.id, start_time: `${monday} 15:00` })).status, 201);
  const other = (await api.get(`/patients/${patient.id}/next-slots?appointment_type_id=${type.id}&from=${monday}&count=1&near=15:00`)).data;
  assert.ok(other.slots[0].start_time !== `${monday} 15:00`);
  assert.equal((await api.get(`/patients/${patient.id}/next-slots?near=3pm`)).status, 400);
  assert.equal((await api.get(`/patients/${patient.id}/next-slots?near=25:00`)).status, 400);
});

test('A051 one recall call covers all the recalls the patient is due for; a note or a wrong number doesn’t count as contact', async () => {
  const { api, patient } = await h.practice();
  for (const code of ['D1110', 'D0120', 'D0274']) {
    const r = await api.post(`/patients/${patient.id}/outside-procedures`, { code, date: monthsAgo(14), office_name: 'Previous dentist' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  const due = (await api.get('/recalls?status=due&limit=200')).data;
  const mine = (due.rows || due).filter((r) => r.patient_id === patient.id);
  assert.ok(mine.length >= 2, `the patient is due for more than one recall (${mine.map((r) => r.type)})`);

  // A note alone changes nothing.
  const note = await api.post(`/patients/${patient.id}/followups`, { kind: 'recall', outcome: 'note', note: 'Prefers mornings' });
  assert.equal(note.status, 201);
  assert.deepEqual(note.data.recalls_contacted, []);
  // Left a voicemail: every due recall is contacted, in one call, audited with the recalls it covered.
  const vm = await api.post(`/patients/${patient.id}/followups`, { kind: 'recall', outcome: 'left_voicemail' });
  assert.equal(vm.status, 201, JSON.stringify(vm.data));
  assert.deepEqual([...vm.data.recalls_contacted].sort(), mine.map((r) => r.id).sort());
  const rows = await h.db.all('SELECT status, last_contacted_at FROM recalls WHERE patient_id = ? AND id IN (' + mine.map(() => '?').join(',') + ')', patient.id, ...mine.map((r) => r.id));
  assert.ok(rows.every((r) => r.status === 'contacted' && r.last_contacted_at));
  const [a] = await auditRows('followup.create', vm.data.id);
  assert.deepEqual(JSON.parse(a.details).recalls_contacted.sort(), mine.map((r) => r.id).sort());
  // Logging again: nothing left to change.
  assert.deepEqual((await api.post(`/patients/${patient.id}/followups`, { kind: 'recall', outcome: 'left_voicemail' })).data.recalls_contacted, []);

  // recall_ids must be this patient's recalls.
  const other = (await api.post('/patients', { first_name: 'Other', last_name: 'Person', dob: '1990-01-01' })).data;
  assert.equal((await api.post(`/patients/${other.id}/followups`, { kind: 'recall', outcome: 'left_voicemail', recall_ids: [mine[0].id] })).status, 404);
  assert.equal((await api.post(`/patients/${patient.id}/followups`, { kind: 'recall', outcome: 'left_voicemail', recall_ids: 'all' })).status, 400);
  const elsewhere = await h.practice();
  assert.equal((await elsewhere.api.post(`/patients/${patient.id}/followups`, { kind: 'recall', outcome: 'left_voicemail' })).status, 404);
});

test('A053 log a call on the chart: defaults, validation, one row per call, audited; a note goes onto the phone line’s call', async () => {
  const { api, patient } = await h.practice();
  const me = (await api.get('/auth/me')).data;
  const count = async () => (await h.db.get("SELECT COUNT(*) AS n FROM calls WHERE patient_id = ? AND purpose = 'logged'", patient.id)).n;

  // Everything defaults: we called, spoke with them, just now, with the patient, by me.
  const r = await api.post(`/patients/${patient.id}/calls`, { note: 'Asked about whitening; will call back after payday' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.direction, r.data.outcome, r.data.purpose, r.data.caller_name, r.data.user_id, r.data.agent_id], ['outbound', 'spoke', 'logged', 'Jane Doe', me.user?.id ?? me.id, me.user?.id ?? me.id]);
  const [log] = await auditRows('call.log', r.data.id);
  assert.ok(log, 'audited');
  assert.equal(log.patient_id, patient.id);
  assert.match(log.changes, /whitening/);
  // A double click or a retry: the same call, not two.
  const again = await api.post(`/patients/${patient.id}/calls`, { note: 'Asked about whitening; will call back after payday' });
  assert.equal(again.status, 200);
  assert.equal(again.data.id, r.data.id);
  assert.equal(again.data.duplicate, true);
  assert.equal(await count(), 1);
  // It's in the chart's call history.
  const hist = (await api.get(`/patients/${patient.id}/calls`)).data;
  assert.ok(hist.some((c) => c.id === r.data.id && c.summary.includes('whitening') && c.caller_name === 'Jane Doe'));

  // Someone else on the line, a while ago, they called.
  const mom = (await api.post(`/patients/${patient.id}/calls`, { direction: 'inbound', outcome: 'left_voicemail', with_name: 'Mother (Ann)', minutes_ago: 30 })).data;
  assert.equal(mom.caller_name, 'Mother (Ann)');
  const ago = (Date.now() - Date.parse(`${mom.created_at.replace(' ', 'T')}Z`)) / 60000;
  assert.ok(ago > 28 && ago < 32, `logged ~30 minutes ago (${ago})`);

  // Impossible input is refused.
  for (const bad of [{ direction: 'sideways' }, { outcome: 'maybe' }, { minutes_ago: 5000 }, { minutes_ago: -5 }, { minutes_ago: 1.5 }]) {
    assert.equal((await api.post(`/patients/${patient.id}/calls`, bad)).status, 400, JSON.stringify(bad));
  }

  // The phone line logged a call a minute ago: it's offered, and the note goes onto it (once, however often sent).
  const lineId = (await h.db.run("INSERT INTO calls (practice_id, patient_id, direction, purpose, status, outcome, from_number, created_at) VALUES (?, ?, 'inbound', 'call', 'completed', 'answered', '+15125550100', ?)", patient.practice_id, patient.id, utcAgo(1))).id;
  const recent = (await api.get(`/patients/${patient.id}/calls/recent`)).data;
  assert.equal(recent.call.id, lineId);
  const add = await api.post(`/patients/${patient.id}/calls`, { call_id: lineId, note: 'Needs a Saturday' });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  assert.equal(add.data.added_to, lineId);
  assert.match(add.data.notes, /Needs a Saturday — Admin/);
  await api.post(`/patients/${patient.id}/calls`, { call_id: lineId, note: 'Needs a Saturday' });
  assert.equal((await h.db.get('SELECT notes FROM calls WHERE id = ?', lineId)).notes.split('\n').length, 1, 'added once');
  const [noted] = await auditRows('call.note', lineId);
  assert.match(noted.changes, /Needs a Saturday/);
  assert.equal((await api.post(`/patients/${patient.id}/calls`, { call_id: lineId })).status, 400, 'a note is needed');
  // Someone else's call can't take this patient's note.
  const other = (await api.post('/patients', { first_name: 'Other', last_name: 'Caller', dob: '1990-01-01' })).data;
  assert.equal((await api.post(`/patients/${other.id}/calls`, { call_id: lineId, note: 'x' })).status, 409);
  // An older phone-line call isn't offered.
  await h.db.run('UPDATE calls SET created_at = ? WHERE id = ?', utcAgo(40), lineId);
  assert.equal((await api.get(`/patients/${patient.id}/calls/recent`)).data.call, null);

  // Permissions and other practices.
  const billing = await login(api, 'billing');
  assert.equal((await billing.post(`/patients/${patient.id}/calls`, {})).status, 403);
  const elsewhere = await h.practice();
  assert.equal((await elsewhere.api.post(`/patients/${patient.id}/calls`, {})).status, 404);
  assert.equal((await elsewhere.api.get(`/patients/${patient.id}/calls/recent`)).status, 404);
  assert.equal((await elsewhere.api.post(`/patients/${elsewhere.patient.id}/calls`, { call_id: lineId, note: 'x' })).status, 404);
});

test('A107 time clock: a bad date says so in plain words', async () => {
  const { api } = await h.practice();
  const me = (await api.get('/auth/me')).data;
  const bad = await api.post('/timeclock/punches', { user_id: me.user?.id ?? me.id, clock_in: '2026-02-30 08:00', clock_out: '2026-03-01 17:00', reason: 'Forgot to clock in' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /^Clock-in isn’t a real date and time/);
  const out = await api.post('/timeclock/punches', { user_id: me.user?.id ?? me.id, clock_in: '2026-03-02 08:00', clock_out: 'tomorrow', reason: 'Forgot to clock in' });
  assert.match(out.data.error, /^Clock-out isn’t a real date and time/);
});
