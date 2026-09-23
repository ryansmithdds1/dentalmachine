import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

let server;
let base;
const db = await openDb(':memory:');
after(() => db.close());

before(async () => {
  const app = createApp({ db, secret: 'test-secret' });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

function client(token) {
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    return { status: res.status, data };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
  };
}

async function registerPractice(suffix) {
  const { status, data } = await client().post('/auth/register', {
    practice_name: `Practice ${suffix}`, name: `Admin ${suffix}`, email: `admin-${suffix}@example.com`, password: 'correct-horse-battery',
  });
  assert.equal(status, 201);
  return { api: client(data.token), user: data.user };
}

async function setupPractice(suffix) {
  const { api, user } = await registerPractice(suffix);
  const provider = (await api.post('/providers', { name: 'Dr. Smile', type: 'dentist', npi: '1234567890' })).data;
  const ops = (await api.get('/operatories')).data;
  const patient = (await api.post('/patients', { first_name: 'Jane', last_name: 'Doe', dob: '1985-04-12', phone: '555-0100' })).data;
  return { api, user, provider, ops, patient };
}

test('rejects unauthenticated access and bad logins', async () => {
  assert.equal((await client().get('/patients')).status, 401);
  assert.equal((await client('garbage.token.here').get('/patients')).status, 401);
  await registerPractice('login');
  assert.equal((await client().post('/auth/login', { email: 'admin-login@example.com', password: 'wrong-password' })).status, 401);
  const ok = await client().post('/auth/login', { email: 'ADMIN-login@example.com', password: 'correct-horse-battery' });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
});

test('registration validates password and seeds defaults', async () => {
  const weak = await client().post('/auth/register', { practice_name: 'X', name: 'Y', email: 'weak@example.com', password: 'short' });
  assert.equal(weak.status, 400);
  const { api } = await registerPractice('seed');
  const codes = (await api.get('/procedure-codes')).data;
  assert.ok(codes.some((c) => c.code === 'D1110'));
  assert.equal((await api.get('/operatories')).data.length, 3);
});

test('practices are isolated from each other', async () => {
  const a = await setupPractice('iso-a');
  const b = await setupPractice('iso-b');
  assert.equal((await b.api.get(`/patients/${a.patient.id}`)).status, 404);
  assert.equal((await b.api.put(`/patients/${a.patient.id}`, { first_name: 'Hacked' })).status, 404);
  assert.equal((await b.api.get(`/patients/${a.patient.id}/ledger`)).status, 404);
  const list = (await b.api.get('/patients')).data;
  assert.ok(list.rows.every((p) => p.id !== a.patient.id));
  // Cannot book another practice's patient.
  const appt = await b.api.post('/appointments', {
    patient_id: a.patient.id, provider_id: b.provider.id, start_time: '2030-01-01 09:00', end_time: '2030-01-01 10:00',
  });
  assert.equal(appt.status, 404);
});

test('patient CRUD, search and archive', async () => {
  const { api, patient } = await setupPractice('patients');
  assert.equal((await api.post('/patients', { first_name: 'No' })).status, 400);
  assert.equal((await api.post('/patients', { first_name: 'A', last_name: 'B', dob: '12/01/1990' })).status, 400);
  const found = (await api.get('/patients?q=doe')).data;
  assert.equal(found.total, 1);
  const updated = (await api.put(`/patients/${patient.id}`, { allergies: 'Penicillin' })).data;
  assert.equal(updated.allergies, 'Penicillin');
  assert.equal((await api.del(`/patients/${patient.id}`)).status, 200);
  assert.equal((await api.get('/patients?q=doe')).data.total, 0);
  assert.equal((await api.get('/patients?q=doe&status=archived')).data.total, 1);
});

test('scheduling detects provider, operatory and patient conflicts', async () => {
  const { api, provider, ops, patient } = await setupPractice('sched');
  const other = (await api.post('/patients', { first_name: 'John', last_name: 'Roe' })).data;
  const provider2 = (await api.post('/providers', { name: 'Hyg. Anne', type: 'hygienist' })).data;
  const base = { patient_id: patient.id, provider_id: provider.id, operatory_id: ops[0].id, start_time: '2030-03-04 09:00', end_time: '2030-03-04 10:00' };
  const first = await api.post('/appointments', base);
  assert.equal(first.status, 201);

  const providerClash = await api.post('/appointments', { ...base, patient_id: other.id, operatory_id: ops[1].id, start_time: '2030-03-04 09:30', end_time: '2030-03-04 10:30' });
  assert.equal(providerClash.status, 409);
  assert.match(providerClash.data.error, /provider/);

  const opClash = await api.post('/appointments', { ...base, patient_id: other.id, provider_id: provider2.id });
  assert.equal(opClash.status, 409);
  assert.match(opClash.data.error, /operatory/);

  const patientClash = await api.post('/appointments', { ...base, provider_id: provider2.id, operatory_id: ops[1].id });
  assert.equal(patientClash.status, 409);

  const backToBack = await api.post('/appointments', { ...base, patient_id: other.id, start_time: '2030-03-04 10:00', end_time: '2030-03-04 11:00' });
  assert.equal(backToBack.status, 201);

  assert.equal((await api.post('/appointments', { ...base, start_time: '2030-03-04 12:00', end_time: '2030-03-04 11:00' })).status, 400);

  // Cancelling frees the slot.
  await api.patch(`/appointments/${first.data.id}/status`, { status: 'cancelled' });
  assert.equal((await api.post('/appointments', { ...base, patient_id: other.id, provider_id: provider2.id, start_time: '2030-03-04 09:00', end_time: '2030-03-04 09:50' })).status, 201);
  // ...so re-activating the cancelled appointment would now double-book.
  assert.equal((await api.patch(`/appointments/${first.data.id}/status`, { status: 'scheduled' })).status, 409);

  const day = (await api.get('/appointments?date=2030-03-04')).data;
  assert.equal(day.length, 2);
  const avail = (await api.get(`/availability?date=2030-03-04&provider_id=${provider.id}&duration=60`)).data;
  assert.ok(!avail.slots.includes('2030-03-04 10:00'));
  assert.ok(avail.slots.includes('2030-03-04 11:00'));
  assert.ok(avail.slots.includes('2030-03-04 08:00'));
});

test('treatment plan → completion → claim → insurance payment flows through the ledger', async () => {
  const { api, provider, patient } = await setupPractice('flow');
  const carrier = (await api.post('/carriers', { name: 'Delta Test', payer_id: '12345' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, {
    carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'ABC123',
    annual_max: 150000, deductible: 5000, pct_preventive: 100, pct_basic: 80, pct_major: 50,
  })).data;

  const bad = await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Bad', procedures: [{ code: 'D2392', tooth: '30' }] });
  assert.equal(bad.status, 400, 'surface-required code without surfaces is rejected');

  const plan = (await api.post(`/patients/${patient.id}/treatment-plans`, {
    name: 'Phase 1',
    procedures: [
      { code: 'D1110', provider_id: provider.id },
      { code: 'D2392', tooth: '30', surfaces: 'mo', provider_id: provider.id },
    ],
  })).data;
  assert.equal(plan.procedures.length, 2);
  assert.equal(plan.procedures[1].surfaces, 'MO');
  // Prophy 11000 @100% = 11000. Composite 23500: 5000 deductible then 80% of 18500 = 14800.
  assert.equal(plan.estimate.total_fee, 34500);
  assert.equal(plan.estimate.total_insurance, 11000 + 14800);

  for (const p of plan.procedures) {
    const done = await api.post(`/procedures/${p.id}/complete`);
    assert.equal(done.status, 200);
  }
  assert.equal((await api.post(`/procedures/${plan.procedures[0].id}/complete`)).status, 409);

  const plans = (await api.get(`/patients/${patient.id}/treatment-plans`)).data;
  assert.equal(plans[0].status, 'completed');

  const detail = (await api.get(`/patients/${patient.id}`)).data;
  assert.equal(detail.balance, 34500);
  assert.equal(detail.recalls.length, 1, 'prophy creates a recall');

  const unclaimed = (await api.get(`/patients/${patient.id}/unclaimed-procedures`)).data;
  assert.equal(unclaimed.length, 2);
  const claim = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: unclaimed.map((p) => p.id) })).data;
  assert.equal(claim.estimated_amount, 25800);
  assert.equal((await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [unclaimed[0].id] })).status, 409);
  assert.equal((await api.post(`/claims/${claim.id}/payment`, { amount: 100 })).status, 409, 'cannot pay a draft claim');

  await api.post(`/claims/${claim.id}/submit`);
  const ledgerPending = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.equal(ledgerPending.pending_insurance, 25800);

  const paid = (await api.post(`/claims/${claim.id}/payment`, { amount: 25000, write_off: 800 })).data;
  assert.equal(paid.status, 'paid');
  await api.post(`/patients/${patient.id}/payments`, { amount: 8700, method: 'credit_card' });
  const ledger = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.equal(ledger.balance, 0);
  assert.equal(ledger.entries.at(-1).running_balance, 0);

  const dash = (await api.get('/dashboard')).data;
  assert.equal(dash.production, 34500);
  assert.equal(dash.collections, 33700);

  // Remaining benefits reduce future estimates.
  const est = (await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Crown', procedures: [{ code: 'D2740', tooth: '3' }] })).data;
  assert.equal(est.estimate.total_insurance, 67500, 'deductible already met; 50% major coverage');
  assert.equal((await api.get(`/patients/${patient.id}/insurance`)).data[0].deductible_met, 5000);
});

test('signed clinical notes are immutable', async () => {
  const { api, patient } = await setupPractice('notes');
  const note = (await api.post(`/patients/${patient.id}/notes`, { body: 'Pt presents for exam.' })).data;
  assert.equal((await api.put(`/notes/${note.id}`, { body: 'Edited' })).data.body, 'Edited');
  const signed = await api.post(`/notes/${note.id}/sign`);
  assert.equal(signed.status, 200);
  assert.ok(signed.data.signed_by, 'the signer is recorded');
  assert.equal((await api.put(`/notes/${note.id}`, { body: 'Tamper' })).status, 409);
  assert.equal((await api.post(`/notes/${note.id}/sign`)).status, 409);
  // Corrections go in a signed addendum under the note.
  const add = await api.post(`/notes/${note.id}/addenda`, { body: 'Addendum: patient also reports sensitivity on #14.' });
  assert.equal(add.status, 201);
  assert.equal((await api.post(`/notes/${add.data.id}/sign`)).status, 200);
  const list = (await api.get(`/patients/${patient.id}/notes`)).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].addenda[0].body, 'Addendum: patient also reports sensitivity on #14.');
  assert.equal(list[0].addenda[0].signed, 1);
  assert.ok(list[0].signed_by_name);

  // A note written for a provider with a login can only be signed by that provider.
  await api.post('/users', { email: 'dr2@notes.example.com', name: 'Dr Two', role: 'dentist', password: 'dentist-two-password' });
  const dr2 = client((await client().post('/auth/login', { email: 'dr2@notes.example.com', password: 'dentist-two-password' })).data.token);
  const me = (await api.get('/auth/me')).data.user;
  const prov = (await api.post('/providers', { name: 'Dr. One', type: 'dentist' })).data;
  await api.put(`/providers/${prov.id}`, { user_id: me.id });
  const forOne = (await dr2.post(`/patients/${patient.id}/notes`, { body: 'Seated crown #3.', provider_id: prov.id })).data;
  const refused = await dr2.post(`/notes/${forOne.id}/sign`);
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /Only Dr\. One/);
  assert.equal((await api.post(`/notes/${forOne.id}/sign`)).status, 200);
});

test('role-based access control', async () => {
  const { api, patient } = await setupPractice('rbac');
  await api.post('/users', { email: 'desk@rbac.example.com', name: 'Desk', role: 'front_desk', password: 'front-desk-password' });
  await api.post('/users', { email: 'asst@rbac.example.com', name: 'Asst', role: 'assistant', password: 'assistant-password' });
  const desk = client((await client().post('/auth/login', { email: 'desk@rbac.example.com', password: 'front-desk-password' })).data.token);
  const asst = client((await client().post('/auth/login', { email: 'asst@rbac.example.com', password: 'assistant-password' })).data.token);

  assert.equal((await desk.get('/patients')).status, 200);
  assert.equal((await desk.post(`/patients/${patient.id}/payments`, { amount: 100, method: 'cash' })).status, 201);
  assert.equal((await desk.post(`/patients/${patient.id}/notes`, { body: 'x' })).status, 403);
  assert.equal((await desk.post('/providers', { name: 'X' })).status, 403);
  assert.equal((await desk.get('/audit-log')).status, 403);
  assert.equal((await desk.get('/reports/aging')).status, 403);
  assert.equal((await asst.get(`/patients/${patient.id}/ledger`)).status, 403);
  const note = (await asst.post(`/patients/${patient.id}/notes`, { body: 'Assisted.' })).data;
  assert.equal((await asst.post(`/notes/${note.id}/sign`)).status, 403);

  const log = (await api.get('/audit-log')).data;
  assert.ok(log.some((e) => e.action === 'patient.create'));
  assert.ok(log.some((e) => e.action === 'ledger.payment'));
});

test('aging report buckets balances', async () => {
  const { api, provider, patient } = await setupPractice('aging');
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D0150', provider_id: provider.id, complete: true })).data;
  assert.equal(proc.status, 'completed');
  await db.run("UPDATE ledger_entries SET entry_date = ? WHERE procedure_id = ?", new Date(Date.now() - 45 * 86400_000).toISOString().slice(0, 10), proc.id);
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D0274', provider_id: provider.id, complete: true });
  const aging = (await api.get('/reports/aging')).data;
  const row = aging.rows.find((r) => r.id === patient.id);
  assert.equal(row.current, 7000);
  assert.equal(row.d31_60, 11000);
  assert.equal(aging.totals.total, 18000);
});
