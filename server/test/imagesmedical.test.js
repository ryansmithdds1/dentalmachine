// Workflows 14 (x-rays & photos) and 15 (medical history): undoable document removal, the single medical
// history editor, "reviewed today, no changes", and the review-due flag on the patient card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { medicalReviewDue } from '../src/routes/patients.js';

const h = harness();

const upload = async (token, patientId, name = 'pa30.txt', category = 'xray', key) => {
  const res = await fetch(`${h.origin}/api/patients/${patientId}/documents?filename=${name}&category=${category}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain', ...(key ? { 'Idempotency-Key': key } : {}) }, body: 'radiograph',
  });
  return { status: res.status, data: await res.json() };
};
const login = async (api, role, extra = {}) => {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await api.post('/users', { email, name: role, role, password: 'correct-horse-battery', ...extra });
  return h.client((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);
};
const auditRows = (entityId, action) => h.db.all('SELECT * FROM audit_log WHERE entity_id = ? AND action = ? ORDER BY id', entityId, action);

test('a removed document can be restored (undo): both steps audited with before/after, another practice gets 404', async () => {
  const { api, token, patient } = await h.practice();
  const doc = (await upload(token, patient.id)).data;
  const list = async () => (await api.get(`/patients/${patient.id}/documents`)).data.map((d) => d.id);
  assert.deepEqual(await list(), [doc.id]);

  assert.equal((await api.del(`/documents/${doc.id}`)).status, 200);
  assert.deepEqual(await list(), []);
  // Removing again (a double click) changes nothing.
  assert.equal((await api.del(`/documents/${doc.id}`)).data.already, true);
  const removed = await auditRows(doc.id, 'document.delete');
  assert.equal(removed.length, 1);
  assert.deepEqual(JSON.parse(removed[0].changes).deleted_at[0], null, 'before: not removed');
  assert.ok(JSON.parse(removed[0].changes).deleted_at[1], 'after: removed');
  assert.equal(removed[0].patient_id, patient.id);

  assert.equal((await api.post(`/documents/${doc.id}/restore`)).status, 200);
  assert.deepEqual(await list(), [doc.id]);
  assert.equal((await api.post(`/documents/${doc.id}/restore`)).data.already, true);
  const restored = await auditRows(doc.id, 'document.restore');
  assert.equal(restored.length, 1);
  assert.equal(JSON.parse(restored[0].changes).deleted_at[1], null);
  // The file itself was never touched.
  assert.equal((await fetch(`${h.origin}/api/documents/${doc.id}/file`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);

  // Someone else's practice can't see, remove or restore it.
  const other = await h.practice();
  assert.equal((await other.api.del(`/documents/${doc.id}`)).status, 404);
  assert.equal((await other.api.post(`/documents/${doc.id}/restore`)).status, 404);
  // Front desk (no clinical:write) can't remove or restore.
  const fd = await login(api, 'front_desk');
  assert.equal((await fd.del(`/documents/${doc.id}`)).status, 403);
  assert.equal((await fd.post(`/documents/${doc.id}/restore`)).status, 403);
  assert.deepEqual(await list(), [doc.id]);
});

test('an upload sent twice with the same key files one document; detail edits record before/after', async () => {
  const { api, token, patient } = await h.practice();
  const a = await upload(token, patient.id, 'IMG_0001.txt', 'photo', 'drop-abc-12345');
  const b = await upload(token, patient.id, 'IMG_0001.txt', 'photo', 'drop-abc-12345');
  assert.equal(a.status, 201);
  assert.equal(b.data.id, a.data.id);
  assert.equal((await api.get(`/patients/${patient.id}/documents`)).data.length, 1);
  assert.equal((await api.put(`/documents/${a.data.id}`, { category: 'xray', tooth: '30' })).status, 200);
  const row = (await auditRows(a.data.id, 'document.update'))[0];
  assert.deepEqual(JSON.parse(row.changes).category, ['photo', 'xray']);
});

test('one medical editor: alerts, allergies, meds, conditions, ASA and premed saved together, recorded, and counted as a review', async () => {
  const { api, patient } = await h.practice();
  const saved = await api.put(`/patients/${patient.id}/medical`, {
    medical_alerts: 'Hypertension', allergies: 'Penicillin', medications: 'Lisinopril 10mg', medical_conditions: ['High blood pressure', 'High blood pressure'], asa_class: 'II', premed_required: true,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.allergies, 'Penicillin');
  assert.deepEqual(JSON.parse(saved.data.medical_conditions), ['High blood pressure']);
  assert.equal(saved.data.asa_class, 'II');
  assert.equal(saved.data.premed_required, true);
  assert.ok(saved.data.medical_reviewed_at, 'saving the whole history counts as reviewing it');
  assert.equal(saved.data.medical_review_due, false);
  assert.deepEqual(saved.data.changed.sort(), ['allergies', 'asa_class', 'medical_alerts', 'medical_conditions', 'medications', 'premed_required']);
  const first = (await auditRows(patient.id, 'patient.medical_update'))[0];
  const ch = JSON.parse(first.changes);
  assert.deepEqual(ch.allergies, [null, 'Penicillin']);
  assert.deepEqual(ch.asa_class, [null, 'II']);
  assert.ok(ch.medical_reviewed_at);

  // Only what changed is changed (and recorded); an undo puts it back without claiming a new review.
  const again = await api.put(`/patients/${patient.id}/medical`, { allergies: 'Penicillin, Latex', medications: 'Lisinopril 10mg' });
  assert.deepEqual(again.data.changed, ['allergies']);
  const second = (await auditRows(patient.id, 'patient.medical_update'))[1];
  assert.deepEqual(JSON.parse(second.changes).allergies, ['Penicillin', 'Penicillin, Latex']);
  const undo = await api.put(`/patients/${patient.id}/medical`, { allergies: 'Penicillin', reviewed: false });
  assert.equal(undo.data.allergies, 'Penicillin');
  assert.equal(undo.data.medical_reviewed_at, again.data.medical_reviewed_at);
  assert.equal((await auditRows(patient.id, 'patient.medical_revert')).length, 1);

  // Bad values are refused.
  assert.equal((await api.put(`/patients/${patient.id}/medical`, { asa_class: 'IX' })).status, 400);
  assert.equal((await api.put(`/patients/${patient.id}/medical`, { medical_conditions: 'not a list' })).status, 400);
  assert.equal((await api.put(`/patients/${patient.id}/medical`, { premed_required: 'maybe' })).status, 400);
  assert.equal((await api.put(`/patients/${patient.id}/medical`, { reviewed: false })).status, 400);
  assert.equal((await api.put(`/patients/${patient.id}/medical`, { allergies: 'x'.repeat(2001) })).status, 400);
  // Cleared fields become empty, not the text "null".
  assert.equal((await api.put(`/patients/${patient.id}/medical`, { medical_alerts: '', medical_conditions: null })).data.medical_alerts, null);
});

test('medical history permissions: clinical:write to change it, other practices get 404', async () => {
  const { api, patient } = await h.practice();
  const fd = await login(api, 'front_desk');
  assert.equal((await fd.put(`/patients/${patient.id}/medical`, { allergies: 'Latex' })).status, 403);
  assert.equal((await fd.post(`/patients/${patient.id}/medical-reviewed`)).status, 403);
  // The general patient edit can't be used to get around it, but sending the same values back is fine.
  assert.equal((await fd.put(`/patients/${patient.id}`, { allergies: 'Latex' })).status, 403);
  assert.equal((await fd.put(`/patients/${patient.id}`, { phone: '(512) 555-0199', allergies: null, medical_conditions: [], premed_required: false })).status, 200);
  const asst = await login(api, 'assistant');
  assert.equal((await asst.put(`/patients/${patient.id}/medical`, { allergies: 'Latex' })).status, 200);
  const other = await h.practice();
  assert.equal((await other.api.put(`/patients/${patient.id}/medical`, { allergies: 'Sulfa' })).status, 404);
  assert.equal((await other.api.post(`/patients/${patient.id}/medical-reviewed`)).status, 404);
  assert.equal((await other.api.get(`/patients/${patient.id}/card`)).status, 404);
});

test('"reviewed today, no changes" in one call: review date recorded, card flag clears, twice is harmless', async () => {
  const { api, patient } = await h.practice();
  const before = (await api.get(`/patients/${patient.id}/card`)).data;
  assert.equal(before.medical_review_due, true, 'never reviewed is due');
  const r = await api.post(`/patients/${patient.id}/medical-reviewed`);
  assert.equal(r.status, 200);
  assert.ok(r.data.medical_reviewed_at);
  assert.equal((await api.get(`/patients/${patient.id}/card`)).data.medical_review_due, false);
  const rows = await auditRows(patient.id, 'patient.medical_reviewed');
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].changes).medical_reviewed_at[0], null);
  assert.equal((await api.post(`/patients/${patient.id}/medical-reviewed`)).status, 200);
  // Nothing else on the chart moved.
  assert.equal((await api.get(`/patients/${patient.id}`)).data.allergies, null);

  // Over a year old is due again; the card hides the flag without clinical access.
  await h.db.run("UPDATE patients SET medical_reviewed_at = '2020-01-01 09:00:00' WHERE id = ?", patient.id);
  assert.equal((await api.get(`/patients/${patient.id}/card`)).data.medical_review_due, true);
  const role = (await api.post('/roles', { name: 'Greeter', permissions: ['patients:read', 'schedule:read'] })).data;
  const g = await login(api, 'front_desk', { custom_role_id: role.id });
  assert.equal((await g.get(`/patients/${patient.id}/card`)).data.medical_review_due, undefined);
});

test('review due: never, or more than a year before today', () => {
  assert.equal(medicalReviewDue(null, '2026-09-24'), true);
  assert.equal(medicalReviewDue('2026-03-01 10:00:00', '2026-09-24'), false);
  assert.equal(medicalReviewDue('2025-09-24 10:00:00', '2026-09-24'), false);
  assert.equal(medicalReviewDue('2025-09-23 23:59:59', '2026-09-24'), true);
});
