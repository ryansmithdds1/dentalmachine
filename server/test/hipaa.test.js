import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { totp, timeStep } from '../src/totp.js';

const h = harness();
const auditRows = (action, practiceId) => h.db.all('SELECT * FROM audit_log WHERE action = ? AND practice_id = ?', action, practiceId);

test('reading notes, perio, the ledger or a plan is on the audit log (once a minute), and nothing is cached', async () => {
  const p = await h.practice();
  const me = (await p.api.get('/auth/me')).data.user;
  const notes = await p.api.get(`/patients/${p.patient.id}/notes`);
  assert.equal(notes.status, 200);
  assert.equal(notes.headers.get('cache-control'), 'no-store');
  await p.api.get(`/patients/${p.patient.id}/notes`);
  await p.api.get(`/patients/${p.patient.id}/ledger`);
  await new Promise((r) => setTimeout(r, 50));
  const reads = await auditRows('patient.notes.view', me.practice_id);
  assert.equal(reads.length, 1, 'a refresh within the minute is one entry');
  assert.equal(reads[0].entity_id, p.patient.id);
  assert.equal(reads[0].user_id, me.id);
  assert.equal((await auditRows('patient.ledger.view', me.practice_id)).length, 1);
  // It shows up on the patient's own access history.
  const history = await p.api.get(`/audit-log?patient_id=${p.patient.id}`);
  assert.ok(Array.isArray(history.data), JSON.stringify(history.data));
  assert.ok(history.data.some((e) => e.action === 'patient.notes.view'));
});

test('API-key reads are logged against the key', async () => {
  const p = await h.practice();
  const k = (await p.api.post('/api-keys', { name: 'Website', scopes: ['patients:read'] })).data;
  const res = await fetch(`${h.origin}/api/v1/patients/${p.patient.id}`, { headers: { Authorization: `Bearer ${k.key}` } });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const [row] = await h.db.all("SELECT * FROM audit_log WHERE action = 'api.patient.view' AND entity_id = ?", p.patient.id);
  assert.equal(JSON.parse(row.details).api_key_id, k.id);
});

test('a deleted perio exam leaves the chart but stays in the record; edits keep the old values', async () => {
  const p = await h.practice();
  const exam = (await p.api.post(`/patients/${p.patient.id}/perio`, { readings: { 3: { pd: [3, 2, 3, 3, 2, 3] } }, notes: 'first' })).data;
  assert.equal((await p.api.put(`/perio/${exam.id}`, { notes: 'second' })).status, 200);
  const [upd] = await h.db.all("SELECT details FROM audit_log WHERE action = 'perio.update' AND entity_id = ?", exam.id);
  assert.equal(JSON.parse(upd.details).before.notes, 'first');
  assert.equal((await p.api.del(`/perio/${exam.id}`)).status, 200);
  assert.equal((await p.api.get(`/patients/${p.patient.id}/perio`)).data.length, 0);
  assert.equal((await p.api.del(`/perio/${exam.id}`)).status, 404);
  const kept = await h.db.get('SELECT notes, deleted_at FROM perio_exams WHERE id = ?', exam.id);
  assert.equal(kept.notes, 'second');
  assert.ok(kept.deleted_at);
});

test('authenticator keys are stored encrypted; keys saved before that still work and get sealed', async () => {
  const p = await h.practice();
  const { secret } = (await p.api.post('/auth/mfa/setup')).data;
  const stored = (await h.db.get('SELECT mfa_secret FROM users WHERE email = ?', p.email)).mfa_secret;
  assert.match(stored, /^v1\./);
  assert.ok(!stored.includes(secret));
  assert.equal((await p.api.post('/auth/mfa/enable', { code: totp(secret, timeStep() - 1) })).status, 200);
  assert.equal((await h.client().post('/auth/login', { email: p.email, password: 'correct-horse-battery', mfa_code: totp(secret) })).status, 200);

  // A key from before encryption (plain base32).
  await h.db.run("UPDATE users SET mfa_secret = 'JBSWY3DPEHPK3PXP', mfa_last_step = NULL WHERE email = ?", p.email);
  assert.equal((await h.client().post('/auth/login', { email: p.email, password: 'correct-horse-battery', mfa_code: totp('JBSWY3DPEHPK3PXP') })).status, 200);
  assert.match((await h.db.get('SELECT mfa_secret FROM users WHERE email = ?', p.email)).mfa_secret, /^v1\./);
});

test('a plan link turns itself off after five wrong birth dates', async () => {
  const p = await h.practice();
  const plan = (await p.api.post(`/patients/${p.patient.id}/treatment-plans`, { name: 'Phase 1', procedures: [{ code: 'D2740', tooth: '3', provider_id: p.provider.id }] })).data;
  const token = (await p.api.post(`/treatment-plans/${plan.id}/present`, {})).data.url.split('/tp/')[1];
  const pub = h.client();
  assert.equal((await pub.get(`/public/tp/${token}/pdf`)).status, 403, 'no PDF without the birth date either');
  for (let i = 0; i < 4; i++) assert.equal((await pub.post(`/public/tp/${token}/verify`, { dob: '2000-01-01' })).status, 403);
  assert.equal((await pub.post(`/public/tp/${token}/verify`, { dob: '2000-01-01' })).status, 410);
  assert.equal((await pub.post(`/public/tp/${token}/verify`, { dob: '1985-04-12' })).status, 404, 'even the right date is too late');
  // A pass for one plan doesn't open another.
  const other = (await p.api.post(`/patients/${p.patient.id}/treatment-plans`, { name: 'Phase 2', procedures: [{ code: 'D1110', provider_id: p.provider.id }] })).data;
  const t2 = (await p.api.post(`/treatment-plans/${other.id}/present`, {})).data.url.split('/tp/')[1];
  const plan3 = (await p.api.post(`/patients/${p.patient.id}/treatment-plans`, { name: 'Phase 3', procedures: [{ code: 'D1110', provider_id: p.provider.id }] })).data;
  const t3 = (await p.api.post(`/treatment-plans/${plan3.id}/present`, {})).data.url.split('/tp/')[1];
  const { pass } = (await pub.post(`/public/tp/${t2}/verify`, { dob: '1985-04-12' })).data;
  assert.equal((await h.client(null, { 'X-Plan-Pass': pass }).get(`/public/tp/${t2}`)).status, 200);
  assert.equal((await h.client(null, { 'X-Plan-Pass': pass }).get(`/public/tp/${t3}`)).status, 403);
  assert.ok((await h.db.all("SELECT * FROM audit_log WHERE action = 'treatment_plan.link_view' AND entity_id = ?", other.id)).length === 1);
});

test('portal codes: wrong guesses for one address are capped across devices, and flooding mints no codes', async () => {
  const slug = `cap-${Date.now()}`;
  await h.practice({ slug });
  const pub = h.client();
  const ask = () => pub.post(`/public/portal/${slug}/code`, { contact: 'jane@example.com', dob: '1985-04-12' });
  await ask();
  for (let i = 0; i < 10; i++) assert.equal((await pub.post(`/public/portal/${slug}/verify`, { contact: 'jane@example.com', code: 'abcdef' })).status, 403);
  assert.equal((await pub.post(`/public/portal/${slug}/verify`, { contact: 'jane@example.com', code: '123456' })).status, 429);

  const practice = await h.db.get('SELECT id FROM practices WHERE slug = ?', slug);
  const count = async () => Number((await h.db.get("SELECT COUNT(*) AS n FROM portal_codes WHERE practice_id = ? AND contact = '5125550100'", practice.id)).n);
  const text = (ip) => h.client(null, { 'X-Forwarded-For': ip }).post(`/public/portal/${slug}/code`, { contact: '(512) 555-0100', dob: '1985-04-12' });
  for (let i = 0; i < 14; i++) await text(`10.0.${i}.1`);
  assert.equal(await count(), 10, 'codes stop being made after ten an hour');
});
