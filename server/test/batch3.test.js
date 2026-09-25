// Workflow batch 3: the things the scorecard's last B's and leftovers needed (docs/workflows/scorecard.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness({ config: { payments: 'sandbox' } });

test('day sheet exports as a spreadsheet, and the export is recorded', async () => {
  const { api, patient, provider } = await h.practice();
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id, complete: true });
  const day = (await api.get('/reports/daysheet')).data;
  const res = await api.get(`/reports/daysheet?date=${day.date}&format=csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), new RegExp(`day-sheet-${day.date}\\.csv`));
  const lines = res.data.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Date,Type,Patient,Description,Method,Reference,Provider / by,Amount ($)');
  assert.equal(lines.length, 1 + day.entries.length);
  assert.ok(lines.some((l) => l.includes('Jane Doe') && l.endsWith('235.00')), lines.join('\n'));
  const rows = await h.db.all("SELECT * FROM audit_log WHERE action = 'report.export' AND details LIKE '%day-sheet%'");
  assert.equal(rows.length, 1);
  assert.equal((await api.get('/reports/daysheet?date=nope&format=csv')).status, 400);
});

const inDays = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

test('mark deceased: one step stops recall, statements and messages, cancels future visits, and undoes', async () => {
  const { api, patient, provider } = await h.practice();
  const chair = (await api.post('/operatories', { name: 'Op 9' })).data;
  const visit = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, operatory_id: chair.id, start_time: `${inDays(30)} 09:00`, end_time: `${inDays(30)} 10:00`, override_blockout: true, notify: false })).data;
  const later = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, operatory_id: chair.id, start_time: `${inDays(60)} 09:00`, end_time: `${inDays(60)} 10:00`, override_blockout: true, notify: false })).data;
  const planned = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id, appointment_id: later.id })).data;
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D0120', provider_id: provider.id, complete: true }); // a balance

  const bad = await api.post(`/patients/${patient.id}/deceased`, { date_of_death: inDays(3) });
  assert.equal(bad.status, 400, 'not in the future');
  const res = await api.post(`/patients/${patient.id}/deceased`, {});
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.cancelled_visits.length, 2);
  assert.ok(res.data.recall_stopped);
  assert.ok(res.data.left_for_you.some((x) => x.kind === 'balance'), 'the balance is left for a person');
  // Twice is the same step.
  const again = await api.post(`/patients/${patient.id}/deceased`, {});
  assert.equal(again.status, 200);
  assert.ok(again.data.already);
  assert.equal((await h.db.all('SELECT * FROM patient_deaths WHERE patient_id = ?', patient.id)).length, 1);

  const p = (await api.get(`/patients/${patient.id}`)).data;
  assert.equal(p.status, 'inactive');
  assert.ok(p.deceased_at);
  assert.equal((await h.db.get('SELECT status, broken_note FROM appointments WHERE id = ?', visit.id)).status, 'cancelled');
  assert.equal((await h.db.get('SELECT appointment_id FROM procedures WHERE id = ?', planned.id)).appointment_id, null);
  const holds = (await api.get(`/cadence/patients/${patient.id}`)).data.holds.filter((x) => !x.released_at);
  assert.deepEqual(holds.map((x) => x.reason), ['deceased']);
  // Statements skip them, and nothing is sent to them.
  const cands = (await api.get('/statements/candidates?min_balance=0')).data;
  assert.ok(!cands.some((c) => c.id === patient.id), 'no statement to a deceased patient');
  const msg = await api.post(`/patients/${patient.id}/messages`, { channel: 'sms', body: 'Hello' });
  assert.ok(msg.status >= 400 || msg.data.status === 'blocked', JSON.stringify(msg.data));
  // Recorded.
  const a = await h.db.get("SELECT * FROM audit_log WHERE action = 'patient.deceased' AND entity_id = ?", patient.id);
  assert.ok(a);

  // Someone else takes the first visit's time; undo puts back only the one still free, with its planned work.
  const other = (await api.post('/patients', { first_name: 'Otto', last_name: 'Other', dob: '1990-01-01' })).data;
  await api.post('/appointments', { patient_id: other.id, provider_id: provider.id, operatory_id: chair.id, start_time: `${inDays(30)} 09:00`, end_time: `${inDays(30)} 10:00`, override_blockout: true, notify: false });
  const undo = await api.post(`/patients/${patient.id}/deceased/undo`, {});
  assert.equal(undo.status, 200);
  assert.deepEqual(undo.data.restored_visits.map((v) => v.id), [later.id]);
  assert.deepEqual(undo.data.not_restored.map((v) => v.id), [visit.id]);
  assert.equal((await h.db.get('SELECT appointment_id FROM procedures WHERE id = ?', planned.id)).appointment_id, later.id);
  const back = (await api.get(`/patients/${patient.id}`)).data;
  assert.equal(back.status, 'active');
  assert.equal(back.deceased_at, null);
  assert.equal((await api.get(`/cadence/patients/${patient.id}`)).data.holds.filter((x) => !x.released_at).length, 0);
  assert.equal((await api.post(`/patients/${patient.id}/deceased/undo`, {})).data.undone, false, 'a second undo does nothing');
  assert.ok(await h.db.get("SELECT * FROM audit_log WHERE action = 'patient.deceased_undo' AND entity_id = ?", patient.id));
});

test('mark deceased only works on a patient of this practice, and the AI needs a person’s OK', async () => {
  const { api } = await h.practice();
  const other = await h.practice();
  assert.equal((await api.post(`/patients/${other.patient.id}/deceased`, {})).status, 404);
  const { riskOf } = await import('../src/aiguard.js');
  assert.ok(riskOf('POST', `/patients/${other.patient.id}/deceased`));
  assert.ok(riskOf('POST', `/patients/${other.patient.id}/deceased/undo`));
});

test('staff licences: per person, a to-do before expiry (once), renewals replace, undo puts the old one back', async () => {
  const { api } = await h.practice();
  const maria = (await api.post('/users', { name: 'Maria Lopez', email: `maria${Date.now()}@example.com`, role: 'assistant', password: 'correct-horse-battery' })).data;
  assert.ok(maria.id, JSON.stringify(maria));
  // Far off: no to-do yet.
  const far = await api.post('/staff-credentials', { user_id: maria.id, kind: 'license', expires_on: inDays(400), client_key: 'k1' });
  assert.equal(far.status, 201, JSON.stringify(far.data));
  assert.equal(far.data.credential.state, 'ok');
  assert.equal(far.data.credential.reminder_task_id, null);
  // Inside the window: a to-do for Maria at once, and only one however often the job runs.
  const cpr = await api.post('/staff-credentials', { user_id: maria.id, kind: 'cpr', expires_on: inDays(20), client_key: 'k2' });
  assert.equal(cpr.data.credential.state, 'due');
  assert.ok(cpr.data.credential.reminder_task_id);
  const { runCredentialReminders } = await import('../src/routes/credentials.js');
  await runCredentialReminders(h.db);
  const tasks = await h.db.all("SELECT * FROM tasks WHERE assigned_to = ? AND title LIKE '%CPR%'", maria.id);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /Maria Lopez.*CPR/);
  // The same Enter twice.
  const dup = await api.post('/staff-credentials', { user_id: maria.id, kind: 'cpr', expires_on: inDays(20), client_key: 'k2' });
  assert.equal(dup.data.repeat, true);
  // Renewal: the old one is replaced (kept) and its to-do closed.
  const renew = await api.post('/staff-credentials', { user_id: maria.id, kind: 'cpr', expires_on: inDays(730), client_key: 'k3' });
  assert.equal(renew.data.replaced.id, cpr.data.credential.id);
  assert.equal((await h.db.get('SELECT status FROM tasks WHERE id = ?', tasks[0].id)).status, 'done');
  const list = (await api.get('/staff-credentials')).data;
  const mine = list.people.find((x) => x.user_id === maria.id);
  assert.deepEqual(mine.credentials.map((c) => c.kind).sort(), ['cpr', 'license']);
  assert.ok(list.people.some((x) => x.credentials.length === 0), 'people with nothing on file are listed');
  // Undo the renewal: the old card is current again.
  assert.equal((await api.post(`/staff-credentials/${renew.data.credential.id}/undo`, {})).status, 200);
  assert.equal((await h.db.get('SELECT status FROM staff_credentials WHERE id = ?', cpr.data.credential.id)).status, 'active');
  // Validation.
  assert.equal((await api.post('/staff-credentials', { user_id: maria.id, kind: 'cpr', expires_on: '2027-02-30' })).status, 400);
  assert.equal((await api.post('/staff-credentials', { user_id: maria.id, kind: 'nope', expires_on: inDays(10) })).status, 400);
  assert.equal((await api.post('/staff-credentials', { user_id: maria.id, kind: 'other', expires_on: inDays(10) })).status, 400);
  const other = await h.practice();
  assert.equal((await other.api.post('/staff-credentials', { user_id: maria.id, kind: 'cpr', expires_on: inDays(10) })).status, 404, 'not another practice’s staff');
  assert.equal((await api.post(`/staff-credentials/${far.data.credential.id}/archive`, {})).status, 400, 'a reason is needed');
  assert.equal((await api.post(`/staff-credentials/${far.data.credential.id}/archive`, { reason: 'Moved states' })).status, 200);
  assert.ok(await h.db.get("SELECT * FROM audit_log WHERE action = 'staff_credential.archive'"));
  // A staff member without the office-documents permission can't see everyone's.
  const login = await h.client().post('/auth/login', { email: maria.email, password: 'correct-horse-battery' });
  if (login.data.token) assert.equal((await h.client(login.data.token).get('/staff-credentials')).status, 403);
});

test('collections by provider: product and gift certificate sales are their own row, not "Unapplied credit"', async () => {
  const { api, patient } = await h.practice();
  const floss = (await api.post('/retail/products', { name: 'Floss', price: 300, taxable: false })).data;
  assert.equal((await api.post(`/patients/${patient.id}/retail-sales`, { product_id: floss.id })).status, 201);
  const pay = await api.post(`/patients/${patient.id}/payments`, { amount: 300, method: 'cash' });
  assert.ok(pay.status < 300, JSON.stringify(pay.data));
  const rows = (await api.get('/reports/collections-by-provider')).data.rows;
  const retail = rows.find((r) => r.name === 'Retail & gift certificates');
  assert.equal(retail?.patient_collections, 300, JSON.stringify(rows));
  assert.ok(!rows.some((r) => r.name === 'Unapplied credit'), 'nothing is unapplied');
  const lib = (await api.get('/report-library/collections-by-provider')).data.rows;
  assert.equal(lib.find((r) => r.provider === 'Retail & gift certificates')?.patient, 300, JSON.stringify(lib));
});

test('sandbox payment link: text-to-pay opens the account’s Pay my bill page (test cards only)', async () => {
  const { api, patient, provider } = await h.practice();
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D0120', provider_id: provider.id, complete: true });
  const cfg = (await api.get('/payments/config')).data;
  assert.equal(cfg.links, true);
  const noSlug = await api.post(`/patients/${patient.id}/payment-requests`, { send: null });
  assert.equal(noSlug.status, 409, 'needs the practice’s web address');
  assert.equal((await api.put('/practice', { slug: `sbx-${Date.now().toString(36)}`, portal_enabled: 1 })).status, 200);
  const res = await api.post(`/patients/${patient.id}/payment-requests`, { send: 'sms' });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.match(res.data.url, /\/billpay\/sbx-[a-z0-9]+\?code=\w+/);
  assert.match(res.data.session_id, /^sbx_cs_/);
  assert.equal(res.data.message.status, 'sent');
  assert.ok(await h.db.get("SELECT * FROM audit_log WHERE action = 'payment_request.create'"));
});
