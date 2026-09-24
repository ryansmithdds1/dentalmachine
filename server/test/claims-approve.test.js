// Billing → Ready to approve (workflow 24, docs/workflows/specs/24-claims.md): claims are prepared by themselves
// from finished, unbilled work — nothing is made or sent — and a person approves each one (or all the ready ones)
// before it goes to a payer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { runAutoWatch } from '../src/autowatch.js';

const h = harness(); // EDI_MODE=sandbox: a sandbox clearinghouse connection
const auditRows = (practiceId, action) => h.db.all('SELECT * FROM audit_log WHERE practice_id = ? AND action = ? ORDER BY id', practiceId, action);
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
const claimCount = async (practiceId) => Number((await h.db.get('SELECT COUNT(*) AS n FROM claims WHERE practice_id = ?', practiceId)).n);
const charges = async (practiceId) => (await h.db.all("SELECT id, amount FROM ledger_entries WHERE practice_id = ? AND type IN ('charge','adjustment','payment') AND claim_id IS NULL ORDER BY id", practiceId));

async function login(harn, api, role, extra = {}) {
  const email = `${role}${Math.random().toString(36).slice(2, 8)}@example.com`;
  const created = await api.post('/users', { name: `${role} person`, email, password: 'correct-horse-battery', role, ...extra });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const res = await harn.client().post('/auth/login', { email, password: 'correct-horse-battery' });
  return { api: harn.client(res.data.token), token: res.data.token, id: created.data.id };
}

// A practice whose patient has insurance and two finished cleanings-and-exam procedures (a clean claim).
async function setup(harn = h, { subscriberId = 'W-1', codes = [{ code: 'D1110' }, { code: 'D0120' }] } = {}) {
  const p = await harn.practice();
  const carrier = (await p.api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await p.api.post(`/patients/${p.patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: subscriberId, group_number: 'G1' })).data;
  const procs = [];
  for (const c of codes) {
    const r = await p.api.post(`/patients/${p.patient.id}/procedures`, { ...c, provider_id: p.provider.id, complete: true });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    procs.push(r.data);
  }
  return { ...p, carrier, policy, procs };
}
async function addPatient(p, name, codes = [{ code: 'D1110' }]) {
  const patient = (await p.api.post('/patients', { first_name: name, last_name: 'Smith', dob: '1990-02-02' })).data;
  const policy = (await p.api.post(`/patients/${patient.id}/insurance`, { carrier_id: p.carrier.id, subscriber_name: `${name} Smith`, subscriber_id: `S-${name}` })).data;
  const procs = [];
  for (const c of codes) procs.push((await p.api.post(`/patients/${patient.id}/procedures`, { ...c, provider_id: p.provider.id, complete: true })).data);
  return { patient, policy, procs };
}
const groupFor = (list, patientId) => list.data.groups.find((g) => g.patient_id === patientId);
async function upload(harn, token, patientId, { name, tooth }) {
  const q = new URLSearchParams({ filename: name, category: 'xray', ...(tooth ? { tooth } : {}) });
  return (await fetch(`${harn.origin}/api/patients/${patientId}/documents?${q}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'x' })).json();
}

test('groups are prepared from finished, unbilled work — no claim is made, nothing is sent, the ledger is untouched', async () => {
  const p = await setup();
  const before = await charges(p.practiceId);
  const list = await p.api.get('/claim-queue');
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.equal(list.data.enabled, true, 'on by default');
  const g = groupFor(list, p.patient.id);
  assert.equal(g.status, 'ready', JSON.stringify(g.fixes));
  assert.deepEqual(g.procedure_ids, p.procs.map((x) => x.id).sort((a, b) => a - b));
  assert.equal(g.patient_insurance_id, p.policy.id);
  assert.equal(g.carrier_name, 'Delta Dental');
  assert.equal(g.total_fee, p.procs.reduce((t, x) => t + x.fee, 0));
  assert.equal(list.data.ready_count, 1);
  assert.equal(list.data.ready_total, g.total_fee);
  assert.equal((await p.api.get('/claim-queue/count')).data.count, 1);
  // Reading it again (and again) makes nothing.
  await p.api.get('/claim-queue');
  assert.equal(await claimCount(p.practiceId), 0);
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM edi_batches WHERE practice_id = ?', p.practiceId)).n), 0);
  assert.deepEqual(await charges(p.practiceId), before);

  // A patient without insurance isn't in it; work still in the chair waits for the visit to end.
  const uninsured = (await p.api.post('/patients', { first_name: 'Cash', last_name: 'Pay', dob: '1970-01-01' })).data;
  await p.api.post(`/patients/${uninsured.id}/procedures`, { code: 'D1110', provider_id: p.provider.id, complete: true });
  const other = await addPatient(p, 'Chair');
  const appt = await h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, '2026-01-01 09:00', '2026-01-01 10:00', 'in_chair')", p.practiceId, other.patient.id, p.provider.id);
  const apptId = appt.id ?? (await h.db.get('SELECT MAX(id) AS id FROM appointments WHERE patient_id = ?', other.patient.id)).id;
  await h.db.run('UPDATE procedures SET appointment_id = ? WHERE id = ?', apptId, other.procs[0].id);
  const again = await p.api.get('/claim-queue');
  assert.equal(groupFor(again, uninsured.id), undefined);
  assert.equal(groupFor(again, other.patient.id), undefined, 'still in the chair');
  await h.db.run("UPDATE appointments SET status = 'completed' WHERE id = ?", apptId);
  assert.ok(groupFor(await p.api.get('/claim-queue'), other.patient.id), 'ready once the visit is over');

  // The automation pass's "not on a claim" item links to this list.
  await h.db.run('UPDATE procedures SET completed_at = ? WHERE practice_id = ?', daysAgo(3), p.practiceId);
  await runAutoWatch(h.db, { practiceId: p.practiceId });
  const issue = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = 'unbilled-work' AND status = 'open'", p.practiceId);
  assert.ok(issue, 'raised');
  assert.equal(issue.entity, 'claim_queue');
  assert.match(issue.detail, /Ready to approve/);
  assert.equal(await claimCount(p.practiceId), 0, 'the automation pass makes no claims either');
});

test('approve (A) makes the claim and sends it, once; a double approve or a retry is harmless', async () => {
  const p = await setup();
  const before = await charges(p.practiceId);
  const g = groupFor(await p.api.get('/claim-queue'), p.patient.id);
  const r = await p.api.post('/claim-queue/approve', { key: g.key });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.sent, true);
  assert.equal(r.data.transport, 'sandbox');
  assert.ok(['submitted', 'paid', 'partially_paid'].includes(r.data.claim.status), r.data.claim.status);
  const claim = await h.db.get('SELECT * FROM claims WHERE id = ?', r.data.claim.id);
  assert.equal(claim.patient_insurance_id, p.policy.id);
  assert.ok(claim.batch_id, 'went out in a clearinghouse batch');
  const items = await h.db.all('SELECT procedure_id FROM claim_items WHERE claim_id = ? ORDER BY procedure_id', claim.id);
  assert.deepEqual(items.map((i) => i.procedure_id), g.procedure_ids);
  // Audited as this person, with what was approved.
  const [row] = await auditRows(p.practiceId, 'claim_queue.approve');
  assert.equal(row.entity_id, claim.id);
  assert.ok(row.user_id, 'the person who approved');
  assert.deepEqual(JSON.parse(row.details).procedure_ids, g.procedure_ids);
  assert.equal((await auditRows(p.practiceId, 'claims.submit')).length, 1);
  // The approval posts no charges or adjustments of its own (the sandbox payer's 835 is the payer's business).
  assert.deepEqual(await charges(p.practiceId), before);
  // It's gone from the list.
  assert.equal(groupFor(await p.api.get('/claim-queue'), p.patient.id), undefined);

  // The same approval again (double click, retry): the first claim comes back; nothing new is made or sent.
  const again = await p.api.post('/claim-queue/approve', { key: g.key });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.already, true);
  assert.equal(again.data.claim.id, claim.id);
  assert.equal(await claimCount(p.practiceId), 1);
  assert.equal((await auditRows(p.practiceId, 'claims.submit')).length, 1, 'not sent twice');

  // Two approvals of the same new work at the same moment: one claim.
  const more = await addPatient(p, 'Twin');
  const g2 = groupFor(await p.api.get('/claim-queue'), more.patient.id);
  const both = await Promise.all([p.api.post('/claim-queue/approve', { key: g2.key }), p.api.post('/claim-queue/approve', { key: g2.key })]);
  assert.ok(both.some((x) => x.status === 201), JSON.stringify(both.map((x) => x.data)));
  assert.ok(both.every((x) => [200, 201, 409].includes(x.status)), JSON.stringify(both.map((x) => [x.status, x.data])));
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM claims WHERE patient_id = ?', more.patient.id)).n), 1);

  // Work billed another way in the meantime (B at checkout): approving the stale key makes nothing.
  const late = await addPatient(p, 'Late');
  const g3 = groupFor(await p.api.get('/claim-queue'), late.patient.id);
  assert.equal((await p.api.post('/claims', { patient_insurance_id: late.policy.id, procedure_ids: late.procs.map((x) => x.id) })).status, 201);
  assert.equal((await p.api.post('/claim-queue/approve', { key: g3.key })).status, 404);
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM claims WHERE patient_id = ?', late.patient.id)).n), 1);
  // New work since the list was loaded: refused with the group as it is now.
  const grow = await addPatient(p, 'Grow');
  const g4 = groupFor(await p.api.get('/claim-queue'), grow.patient.id);
  await p.api.post(`/patients/${grow.patient.id}/procedures`, { code: 'D0120', provider_id: p.provider.id, complete: true });
  const changed = await p.api.post('/claim-queue/approve', { key: g4.key });
  assert.equal(changed.status, 409);
  assert.equal(changed.data.details.group.procedure_ids.length, 2);
  assert.equal((await p.api.post('/claim-queue/approve', { key: 'nonsense' })).status, 400);
});

test('approve all: one step after a confirmation with the count and total; needs-fix groups are left alone', async () => {
  const p = await setup();
  await addPatient(p, 'Ann');
  const crown = await addPatient(p, 'Crown', [{ code: 'D2740', tooth: '30' }]);
  const list = await p.api.get('/claim-queue');
  assert.equal(list.data.ready_count, 2);
  assert.equal(groupFor(list, crown.patient.id).status, 'needs_fix');
  // What the person confirmed must still be true.
  const wrong = await p.api.post('/claim-queue/approve-all', { expected_count: 3, expected_total: list.data.ready_total });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.data.details.count, 2);
  assert.equal(await claimCount(p.practiceId), 0);
  const r = await p.api.post('/claim-queue/approve-all', { expected_count: 2, expected_total: list.data.ready_total });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.approved, 2);
  assert.equal(r.data.sent, 2);
  assert.deepEqual(r.data.failures, []);
  assert.equal(await claimCount(p.practiceId), 2);
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM edi_batches WHERE practice_id = ?', p.practiceId)).n), 1, 'one batch');
  assert.equal((await auditRows(p.practiceId, 'claim_queue.approve')).length, 2);
  assert.equal((await auditRows(p.practiceId, 'claim_queue.approve_all')).length, 1);
  const after = await p.api.get('/claim-queue');
  assert.deepEqual(after.data.groups.map((g) => g.patient_id), [crown.patient.id]);
  // Again: nothing ready.
  assert.equal((await p.api.post('/claim-queue/approve-all', { expected_count: 2, expected_total: list.data.ready_total })).status, 409);
});

test('needs a fix: blocked until fixed inline (an x-ray from the chart, a narrative), or approved anyway with a reason; hard problems never', async () => {
  const p = await setup(h, { codes: [{ code: 'D2740', tooth: '30' }] });
  let g = groupFor(await p.api.get('/claim-queue'), p.patient.id);
  assert.equal(g.status, 'needs_fix');
  const xray = g.fixes.find((f) => f.kind === 'xray');
  assert.ok(xray, JSON.stringify(g.fixes));
  assert.match(xray.message, /x-ray/i);
  assert.equal(g.can_override, true);
  const blocked = await p.api.post('/claim-queue/approve', { key: g.key });
  assert.equal(blocked.status, 422);
  assert.ok(blocked.data.details.needs_fix.length);
  assert.equal(await claimCount(p.practiceId), 0);

  // The film of #30 in the chart is suggested; attaching it clears the fix.
  const film = await upload(h, p.token, p.patient.id, { name: 'pa30.png', tooth: '30' });
  g = groupFor(await p.api.get('/claim-queue'), p.patient.id);
  assert.equal(g.suggestions.find((s) => s.document_id === film.id)?.preselected, true);
  const att = await p.api.post('/claim-queue/fixes', { key: g.key, document_id: film.id });
  assert.equal(att.status, 201, JSON.stringify(att.data));
  assert.equal((await p.api.post('/claim-queue/fixes', { key: g.key, document_id: film.id })).data.already, true, 'a repeat adds nothing');
  g = groupFor(await p.api.get('/claim-queue'), p.patient.id);
  assert.equal(g.status, 'ready', JSON.stringify(g.fixes));
  assert.equal(g.attachments.length, 1);
  const ok = await p.api.post('/claim-queue/approve', { key: g.key });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.sent, true);
  const onClaim = await h.db.all('SELECT * FROM claim_attachments WHERE claim_id = ?', ok.data.claim.id);
  assert.equal(onClaim.length, 1);
  assert.equal(onClaim[0].report_type, 'RB');
  assert.ok(onClaim[0].control_number, 'the x-ray was sent before the claim');

  // A narrative for a build-up; or "send it anyway" with a reason, recorded.
  const bu = await addPatient(p, 'Buildup', [{ code: 'D2950', tooth: '19' }]);
  let b = groupFor(await p.api.get('/claim-queue'), bu.patient.id);
  assert.ok(b.fixes.some((f) => f.kind === 'narrative'), JSON.stringify(b.fixes));
  assert.equal((await p.api.post('/claim-queue/fixes', { key: b.key, narrative: '  ' })).status, 400);
  assert.equal((await p.api.post('/claim-queue/fixes', { key: b.key, narrative: 'Fractured cusp; over half the tooth structure is missing.' })).status, 201);
  b = groupFor(await p.api.get('/claim-queue'), bu.patient.id);
  assert.ok(!b.fixes.some((f) => f.kind === 'narrative'), JSON.stringify(b.fixes));
  const crown = await addPatient(p, 'Anyway', [{ code: 'D2740', tooth: '3' }]);
  const c = groupFor(await p.api.get('/claim-queue'), crown.patient.id);
  const anyway = await p.api.post('/claim-queue/approve', { key: c.key, override_reason: 'This payer takes crowns without films' });
  assert.equal(anyway.status, 201, JSON.stringify(anyway.data));
  const row = (await auditRows(p.practiceId, 'claim_queue.approve')).find((x) => x.entity_id === anyway.data.claim.id);
  assert.equal(row.reason, 'This payer takes crowns without films');
  assert.ok(JSON.parse(row.details).approved_despite.length);

  // A hard problem (no subscriber ID — the clearinghouse would reject it) can't be approved anyway.
  const q = await setup(h);
  await h.db.run("UPDATE patient_insurance SET subscriber_id = '' WHERE id = ?", q.policy.id); // e.g. imported that way
  const hg = groupFor(await q.api.get('/claim-queue'), q.patient.id);
  assert.equal(hg.status, 'needs_fix');
  assert.ok(hg.fixes.some((f) => f.hard && /subscriber/i.test(f.message)), JSON.stringify(hg.fixes));
  assert.equal(hg.can_override, false);
  assert.equal((await q.api.post('/claim-queue/approve', { key: hg.key, override_reason: 'please' })).status, 422);
  assert.equal(await claimCount(q.practiceId), 0);
  // Fixed where the data lives: then it's ready.
  assert.equal((await q.api.put(`/insurance/${q.policy.id}`, { subscriber_id: 'W-9' })).status, 200);
  assert.equal(groupFor(await q.api.get('/claim-queue'), q.patient.id).status, 'ready');
});

test('skip for now needs a reason, is audited, leaves the automation pass quiet, and can be put back', async () => {
  const p = await setup();
  const before = await charges(p.practiceId);
  const g = groupFor(await p.api.get('/claim-queue'), p.patient.id);
  assert.equal((await p.api.post('/claim-queue/skip', { key: g.key })).status, 400);
  assert.equal((await p.api.post('/claim-queue/skip', { key: g.key, reason: '   ' })).status, 400);
  const s = await p.api.post('/claim-queue/skip', { key: g.key, reason: 'Waiting on the new insurance card' });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.equal((await p.api.post('/claim-queue/skip', { key: g.key, reason: 'Waiting on the new insurance card' })).data.already, true, 'a double click');
  assert.equal(groupFor(await p.api.get('/claim-queue'), p.patient.id), undefined);
  const [row] = await auditRows(p.practiceId, 'claim_queue.skip');
  assert.equal(row.reason, 'Waiting on the new insurance card');
  assert.equal(row.entity_id, p.patient.id);
  assert.deepEqual(JSON.parse(row.details).procedure_ids, g.procedure_ids);
  const skipped = await p.api.get('/claim-queue?view=skipped');
  assert.equal(skipped.data.skipped.length, 1);
  assert.equal(skipped.data.skipped[0].reason, 'Waiting on the new insurance card');
  // Skipped work has been looked at: the automation pass doesn't nag about it.
  await h.db.run('UPDATE procedures SET completed_at = ? WHERE practice_id = ?', daysAgo(3), p.practiceId);
  const pass = await runAutoWatch(h.db, { practiceId: p.practiceId });
  assert.equal(pass[p.practiceId].unbilled, 0);
  assert.equal(await claimCount(p.practiceId), 0);
  assert.deepEqual(await charges(p.practiceId), before);
  // Put back: it's in the list again, recorded.
  const back = await p.api.post('/claim-queue/skips/restore', { skip_group: skipped.data.skipped[0].skip_group });
  assert.equal(back.data.restored, g.procedure_ids.length);
  assert.ok(groupFor(await p.api.get('/claim-queue'), p.patient.id));
  assert.equal((await auditRows(p.practiceId, 'claim_queue.unskip')).length, 1);
});

test('the AI can prepare nothing into a claim on its own: approving, approving all and skipping answer 428', async () => {
  const p = await setup();
  const ai = h.client(p.token, { 'X-Acting-For': 'assistant' });
  const list = await ai.get('/claim-queue');
  assert.equal(list.status, 200, 'it may read the list and recommend');
  const g = groupFor(list, p.patient.id);
  const r = await ai.post('/claim-queue/approve', { key: g.key });
  assert.equal(r.status, 428, JSON.stringify(r.data));
  assert.equal((await ai.post('/claim-queue/approve-all', { expected_count: 1, expected_total: g.total_fee })).status, 428);
  assert.equal((await ai.post('/claim-queue/skip', { key: g.key, reason: 'AI thinks so' })).status, 428);
  assert.equal(await claimCount(p.practiceId), 0);
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM claim_prep_skips WHERE practice_id = ?', p.practiceId)).n), 0);
});

test('permissions: billing:write approves and skips; read-only billing sees the list; settings are the administrator\'s', async () => {
  const p = await setup();
  const g = groupFor(await p.api.get('/claim-queue'), p.patient.id);
  const assistant = await login(h, p.api, 'assistant');
  assert.equal((await assistant.api.get('/claim-queue')).status, 403);
  assert.equal((await assistant.api.post('/claim-queue/approve', { key: g.key })).status, 403);
  const dentist = await login(h, p.api, 'dentist');
  assert.equal((await dentist.api.get('/claim-queue')).status, 200);
  assert.equal((await dentist.api.post('/claim-queue/approve', { key: g.key })).status, 403);
  assert.equal((await dentist.api.post('/claim-queue/skip', { key: g.key, reason: 'x' })).status, 403);
  assert.equal((await dentist.api.post('/claim-queue/fixes', { key: g.key, narrative: 'x' })).status, 403);
  assert.equal(await claimCount(p.practiceId), 0);
  const billing = await login(h, p.api, 'billing');
  assert.equal((await billing.api.put('/claim-queue/settings', { enabled: false })).status, 403);
  const ok = await billing.api.post('/claim-queue/approve', { key: g.key });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const [row] = await auditRows(p.practiceId, 'claim_queue.approve');
  assert.equal(row.user_id, billing.id, 'recorded as the person who approved');

  // Turned off: nothing is prepared and nothing can be approved from here; the change is audited.
  assert.equal((await p.api.put('/claim-queue/settings', { enabled: 'no' })).status, 400);
  assert.equal((await p.api.put('/claim-queue/settings', { enabled: false })).status, 200);
  await addPatient(p, 'Off');
  const off = await p.api.get('/claim-queue');
  assert.equal(off.data.enabled, false);
  assert.deepEqual(off.data.groups, []);
  assert.equal((await p.api.get('/claim-queue/count')).data.count, 0);
  assert.equal((await auditRows(p.practiceId, 'practice.claim_prep')).length, 1);
  await p.api.put('/claim-queue/settings', { enabled: true });
  assert.equal((await p.api.get('/claim-queue/settings')).data.enabled, true);
});

test('practice isolation and office restriction: another practice or another office\'s patient is not found', async () => {
  const p = await setup();
  const g = groupFor(await p.api.get('/claim-queue'), p.patient.id);
  const other = await setup();
  assert.equal(groupFor(await other.api.get('/claim-queue'), p.patient.id), undefined);
  assert.equal((await other.api.post('/claim-queue/approve', { key: g.key })).status, 404);
  assert.equal((await other.api.post('/claim-queue/skip', { key: g.key, reason: 'mine now' })).status, 404);
  assert.equal((await other.api.post('/claim-queue/fixes', { key: g.key, narrative: 'hello' })).status, 404);
  // Their x-ray can't be attached to our work.
  const theirs = await upload(h, other.token, other.patient.id, { name: 'theirs.png', tooth: '30' });
  assert.equal((await p.api.post('/claim-queue/fixes', { key: g.key, document_id: theirs.id })).status, 404);
  assert.equal(await claimCount(p.practiceId), 0);

  // Offices: someone at North doesn't see (or approve) a South patient's claim.
  const north = (await p.api.post('/locations', { name: 'North' })).data;
  const south = (await p.api.post('/locations', { name: 'South' })).data;
  await h.db.run('UPDATE patients SET location_id = ? WHERE id = ?', south.id, p.patient.id);
  await h.db.run('UPDATE procedures SET location_id = ? WHERE patient_id = ?', south.id, p.patient.id);
  const northie = await login(h, p.api, 'billing', { location_ids: [north.id] });
  const theirList = await northie.api.get('/claim-queue');
  assert.equal(theirList.status, 200);
  assert.equal(groupFor(theirList, p.patient.id), undefined);
  const g2 = groupFor(await p.api.get('/claim-queue'), p.patient.id);
  assert.equal((await northie.api.post('/claim-queue/approve', { key: g2.key })).status, 404);
  assert.equal((await northie.api.post('/claim-queue/skip', { key: g2.key, reason: 'x' })).status, 404);
  assert.equal(await claimCount(p.practiceId), 0);
  // Working at North, the admin's list leaves South's work out too.
  const atNorth = h.client(p.token, { 'X-Location-Id': String(north.id) });
  assert.equal(groupFor(await atNorth.get('/claim-queue'), p.patient.id), undefined);
});

// No clearinghouse connection: approving saves the claim in an 837 file to upload, kept to download again.
const manual = harness({ config: { ediMode: 'manual' } });
test('without a clearinghouse, an approval saves the claim as an 837 file', async () => {
  const p = await setup(manual);
  const g = (await p.api.get('/claim-queue')).data.groups.find((x) => x.patient_id === p.patient.id);
  const r = await p.api.post('/claim-queue/approve', { key: g.key });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.transport, 'file');
  assert.equal(r.data.claim.status, 'submitted');
  assert.ok(r.data.file.batch_id);
  const file = await p.api.get(`/claim-queue/files/${r.data.file.batch_id}`);
  assert.equal(file.status, 200);
  assert.match(String(file.data), /^ISA\*/);
  assert.match(String(file.data), /CLM\*/);
  const other = await setup(manual);
  assert.equal((await other.api.get(`/claim-queue/files/${r.data.file.batch_id}`)).status, 404);
  assert.equal((await manual.db.all("SELECT * FROM audit_log WHERE action = 'claims.export_837' AND practice_id = ?", p.practiceId)).length, 2, 'saved, then downloaded');
});
