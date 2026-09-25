// Permissions that fit the job (scorecard bugs 4–9): what each role is offered matches what the server lets
// them do, sensitive actions stay on the stronger permissions (CLAUDE.md rule 8), and the answers say why in
// plain words — before the person has done the work, not after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { PERMISSIONS } from '../src/auth.js';

const h = harness();

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function staff(api, role, name) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await api.post('/users', { email, name, role, password: `${role}-password-123` });
  const login = await h.client().post('/auth/login', { email, password: `${role}-password-123` });
  const me = (await h.client(login.data.token).get('/auth/me')).data;
  return { ...h.client(login.data.token), token: login.data.token, id: me.user?.id ?? me.id };
}
const upload = (token, patientId, name = 'referral.png', body = PNG) => fetch(`${h.origin}/api/patients/${patientId}/documents?filename=${encodeURIComponent(name)}&category=referral`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' }, body,
}).then(async (r) => ({ status: r.status, data: await r.json() }));

test('front desk and billing can add documents to a chart (and take back their own), not change or remove them', async () => {
  const { api, token, patient } = await h.practice();
  assert.ok(PERMISSIONS.front_desk.includes('documents:add') && PERMISSIONS.billing.includes('documents:add'));
  assert.ok(!PERMISSIONS.front_desk.includes('clinical:write'), 'no clinical editing for the front desk');
  const desk = await staff(api, 'front_desk', 'Desk');
  const bill = await staff(api, 'billing', 'Bill');
  const asst = await staff(api, 'assistant', 'Asst');

  const mine = await upload(desk.token, patient.id);
  assert.equal(mine.status, 201, JSON.stringify(mine.data));
  assert.equal((await upload(bill.token, patient.id, 'eob.png', Buffer.concat([PNG, Buffer.from([0])]))).status, 201);
  const clinical = await upload(token, patient.id, 'xray.png', Buffer.concat([PNG, Buffer.from([1])]));
  assert.equal(clinical.status, 201);
  // A phone scan link, too (the S menu's "phone").
  assert.equal((await desk.post(`/patients/${patient.id}/upload-links`, { category: 'document' })).status, 201);

  // Changing or removing what's on the chart stays clinical, and the answer says so in words.
  const edit = await desk.put(`/documents/${clinical.data.id}`, { notes: 'x' });
  assert.equal(edit.status, 403);
  const other = await desk.del(`/documents/${clinical.data.id}`);
  assert.equal(other.status, 403);
  assert.match(other.data.error, /You can add documents to a chart; changing or removing them needs a clinical login/);
  // …but the Undo on their own "Added" toast works (a soft delete, audited).
  assert.equal((await desk.del(`/documents/${mine.data.id}`)).status, 200);
  assert.ok((await h.db.get('SELECT deleted_at FROM documents WHERE id = ?', mine.data.id)).deleted_at);
  assert.ok(await h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'document.delete' AND entity_id = ?", mine.data.id));
  // Only for a few minutes: an older upload of theirs is no longer theirs to remove.
  const old = await upload(desk.token, patient.id, 'id-card.png', Buffer.concat([PNG, Buffer.from([2])]));
  await h.db.run("UPDATE documents SET created_at = '2020-01-01 00:00:00' WHERE id = ?", old.data.id);
  assert.equal((await desk.del(`/documents/${old.data.id}`)).status, 403);
  // An assistant (clinical:write) can do everything, as before.
  assert.equal((await asst.del(`/documents/${old.data.id}`)).status, 200);
});

test('a price estimate for the front desk: the chart preview works, charting does not', async () => {
  const { api, patient } = await h.practice();
  const desk = await staff(api, 'front_desk', 'Desk');
  const est = await desk.post('/charting/resolve', { patient_id: patient.id, text: '14 D2740' });
  assert.equal(est.status, 200, JSON.stringify(est.data));
  assert.ok(est.data.estimate, 'fee and patient share');
  assert.equal(typeof est.data.estimate.total_patient, 'number');
  assert.equal((await desk.post(`/patients/${patient.id}/chart-entry`, { items: est.data.items, source: 'typing' })).status, 403, 'nothing is charted');
});

test('the command bar finds a claim by "#N" and "claim N", only for people who can see claims', async () => {
  const { api, patient, provider } = await h.practice();
  const carrier = (await api.post('/carriers', { name: 'Delta', payer_id: '12345' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'X1', group_number: 'G1' })).data;
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D0120', provider_id: provider.id, complete: true })).data;
  const claim = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] })).data;
  assert.ok(claim.id, JSON.stringify(claim));
  // (A bare number is searched from 2 digits; "#1" and "claim 1" work for any claim.)
  for (const q of [`#${claim.id}`, `claim ${claim.id}`, `Claim #${claim.id}`, ...(claim.id > 9 ? [String(claim.id)] : [])]) {
    const r = (await api.get(`/search?q=${encodeURIComponent(q)}`)).data;
    assert.deepEqual(r.claims.map((c) => c.id), [claim.id], q);
  }
  assert.deepEqual((await api.get(`/search?q=${encodeURIComponent(`claim ${claim.id}`)}`)).data.patients, [], '"claim N" is only a claim');
  const asst = await staff(api, 'assistant', 'Asst');
  assert.deepEqual((await asst.get(`/search?q=%23${claim.id}`)).data.claims, [], 'claims are billing information');
});

test('Sign is offered only to someone who can sign that note, with who can when it is someone else', async () => {
  const { api, patient } = await h.practice();
  const hyg = await staff(api, 'hygienist', 'Sam Okafor');
  const dr2 = await staff(api, 'dentist', 'Dr Two');
  const hygProvider = (await api.post('/providers', { name: 'Sam Okafor, RDH', type: 'hygienist', user_id: hyg.id })).data;
  if (!(await h.db.get('SELECT user_id FROM providers WHERE id = ?', hygProvider.id)).user_id) await h.db.run('UPDATE providers SET user_id = ? WHERE id = ?', hyg.id, hygProvider.id);
  const note = (await api.post(`/patients/${patient.id}/notes`, { body: 'Prophy, OHI.', provider_id: hygProvider.id })).data;
  const seen = async (who) => (await who.get(`/patients/${patient.id}/notes`)).data.find((n) => n.id === note.id);
  const forDr = await seen(dr2);
  assert.equal(forDr.can_sign, false);
  assert.equal(forDr.sign_blocker, 'Only Sam Okafor, RDH can sign this note');
  const forHyg = await seen(hyg);
  assert.equal(forHyg.can_sign, true);
  // The server says the same thing it showed.
  const refused = await dr2.post(`/notes/${note.id}/sign`);
  assert.equal(refused.status, 403);
  assert.equal(refused.data.error, forDr.sign_blocker);
  assert.equal((await hyg.post(`/notes/${note.id}/sign`)).status, 200);
  const desk = await staff(api, 'front_desk', 'Desk');
  const note2 = (await api.post(`/patients/${patient.id}/notes`, { body: 'Called about the bill.' })).data;
  const deskView = (await desk.get(`/patients/${patient.id}/notes`)).data.find((n) => n.id === note2.id);
  assert.equal(deskView.can_sign, false);
});

test('voids that need a manager are marked on the ledger before anyone types a reason', async () => {
  const { api, patient } = await h.practice();
  const desk = await staff(api, 'front_desk', 'Desk');
  const cash = (await api.post(`/patients/${patient.id}/payments`, { amount: 4500, method: 'cash' })).data;
  const check = (await api.post(`/patients/${patient.id}/payments`, { amount: 2000, method: 'check', reference: '101' })).data;
  const cashId = cash.entry?.id ?? cash.id;
  const checkId = check.entry?.id ?? check.id;
  const rows = (await desk.get(`/patients/${patient.id}/ledger`)).data.entries;
  assert.match(rows.find((e) => e.id === cashId).void_needs_manager, /needs a manager/);
  assert.equal(rows.find((e) => e.id === checkId).void_needs_manager, undefined);
  // The admin (a manager) isn't told that.
  assert.equal((await api.get(`/patients/${patient.id}/ledger`)).data.entries.find((e) => e.id === cashId).void_needs_manager, undefined);
  // And the server still refuses the front desk, as it always did.
  assert.equal((await desk.post(`/ledger/${cashId}/void`, { reason: 'wrong patient' })).status, 403);
});

test('"+ Invite user": no made-up password — an email with a link to choose one, which works once', async () => {
  const { api } = await h.practice();
  const before = h.sent.length;
  const r = await api.post('/users', { email: 'riley@example.com', name: 'Riley', role: 'assistant', invite: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.invite_emailed, true);
  assert.match(r.data.invite_link, /^https:\/\/app\.example\.com\/#reset=[\w-]+$/);
  const mail = h.sent.slice(before).find((m) => m.to === 'riley@example.com');
  assert.ok(mail && mail.body.includes(r.data.invite_link), 'the link is emailed to them');
  assert.ok(!('password_hash' in r.data));
  // Nobody knows the starting password: they choose theirs from the link.
  const token = r.data.invite_link.split('#reset=')[1];
  assert.equal((await h.client().post('/auth/reset-password', { token, password: 'rileys-own-password' })).status, 200);
  assert.equal((await h.client().post('/auth/login', { email: 'riley@example.com', password: 'rileys-own-password' })).status, 200);
  assert.equal((await h.client().post('/auth/reset-password', { token, password: 'another-password-1' })).status, 400, 'works once');
  // Without invite, a password is still needed (API clients); a bad email is refused in words.
  assert.equal((await api.post('/users', { email: 'x@example.com', name: 'X', role: 'assistant' })).status, 400);
  assert.match((await api.post('/users', { email: 'not-an-email', name: 'X', role: 'assistant', invite: true })).data.error, /doesn’t look like an email/);
  assert.match((await api.post('/users', { email: 'riley@example.com', name: 'R2', role: 'assistant', invite: true })).data.error, /already signs in with that email/);
  const audit = await h.db.get("SELECT details FROM audit_log WHERE action = 'user.create' ORDER BY id DESC LIMIT 1");
  assert.match(audit.details, /"invited":true/);
});

test('settings forms answer a missing field in the form’s words', async () => {
  const { api } = await h.practice();
  const r = await api.post('/procedure-codes', { code: 'D9991', description: 'Test', fee: 100 });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'Please fill in “Category”');
  const p = await api.post('/providers', { name: 'Dr. New', type: null });
  assert.equal(p.status, 400);
  assert.doesNotMatch(p.data.error, /is required|Missing required fields/);
  assert.match(p.data.error, /Please fill in “Type”/);
});
