// Workflows 21, 22, 23, 25 and 28: building a plan, handing the device to the patient to sign a plan or forms,
// suggested claim attachments, and quick staff tasks. Specs in docs/workflows/specs/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();
const tokenOf = (url, kind) => url.split(`/${kind}/`)[1];
const auditRows = (practiceId, action) => h.db.all('SELECT * FROM audit_log WHERE practice_id = ? AND action = ? ORDER BY id', practiceId, action);
async function login(api, role, name) {
  const email = `${role}${Math.random().toString(36).slice(2, 8)}@example.com`;
  const created = await api.post('/users', { name, email, password: 'correct-horse-battery', role });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const res = await h.client().post('/auth/login', { email, password: 'correct-horse-battery' });
  return { client: h.client(res.data.token), id: created.data.id, token: res.data.token };
}
// Signing in again as the same person: another device, another session.
async function secondSession(email) {
  return h.client((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);
}

test('21 · plans are named for you, gather all unplanned work in one step, and removing work can be undone in place', async () => {
  const { api, patient, provider, practiceId } = await h.practice();
  const a = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '14', provider_id: provider.id })).data;
  const b = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2391', tooth: '30', surfaces: 'O', provider_id: provider.id })).data;

  const plan = await api.post(`/patients/${patient.id}/treatment-plans`, { all_unplanned: true });
  assert.equal(plan.status, 201, JSON.stringify(plan.data));
  assert.match(plan.data.name, /^Treatment plan — \d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(plan.data.procedures.map((p) => p.id).sort(), [a.id, b.id].sort());
  // Nothing left to gather: a clear refusal, not an empty plan.
  assert.equal((await api.post(`/patients/${patient.id}/treatment-plans`, { all_unplanned: true })).status, 409);
  const [created] = await auditRows(practiceId, 'treatment_plan.create');
  assert.equal(JSON.parse(created.details).gathered, 2);

  // New work typed into the builder, with a name given.
  const typed = await api.post(`/patients/${patient.id}/treatment-plans`, { name: '  Crowns  ', procedures: [{ code: 'D2740', tooth: '3' }] });
  assert.equal(typed.data.name, 'Crowns');

  // Take #30 off the plan, then undo: it goes back in the same place.
  const before = plan.data.procedures.find((p) => p.id === b.id);
  assert.equal((await api.del(`/treatment-plans/${plan.data.id}/procedures/${b.id}`)).status, 200);
  const back = await api.post(`/treatment-plans/${plan.data.id}/procedures`, { procedure_ids: [b.id], keep_order: true });
  assert.equal(back.status, 200);
  assert.equal(back.data.procedures.find((p) => p.id === b.id).priority, before.priority);
  // Both moves are on the procedure's record.
  const trail = await h.db.all("SELECT * FROM audit_log WHERE entity = 'procedures' AND entity_id = ? AND changes LIKE '%treatment_plan_id%'", b.id);
  assert.ok(trail.length >= 2, 'removal and re-add recorded with before/after');
  // Fee changed inline, then undone.
  assert.equal((await api.put(`/procedures/${a.id}`, { fee: 99900 })).data.fee, 99900);
  assert.equal((await api.put(`/procedures/${a.id}`, { fee: a.fee })).data.fee, a.fee);

  // Another practice can't see or touch any of it.
  const other = await h.practice();
  assert.equal((await other.api.post(`/patients/${patient.id}/treatment-plans`, { all_unplanned: true })).status, 404);
  assert.equal((await other.api.post(`/treatment-plans/${plan.data.id}/procedures`, { procedure_ids: [b.id] })).status, 404);
  assert.equal((await other.api.post(`/treatment-plans/${other.patient.id}/procedures`, { procedure_ids: [b.id] })).status, 404);
  // Front desk can't build plans.
  const desk = await login(api, 'front_desk', 'Front Desk');
  assert.equal((await desk.client.post(`/patients/${patient.id}/treatment-plans`, { all_unplanned: true })).status, 403);
});

test('22 · "on this screen" hands the plan over without the birth date: once, on this session, for this plan, for 15 minutes', async () => {
  const { api, patient, provider, practiceId, email } = await h.practice();
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '14', provider_id: provider.id });
  const plan = (await api.post(`/patients/${patient.id}/treatment-plans`, { all_unplanned: true })).data;
  const other = (await api.post(`/patients/${patient.id}/treatment-plans`, { procedures: [{ code: 'D2391', tooth: '19', surfaces: 'O' }] })).data;

  const here = await api.post(`/treatment-plans/${plan.id}/present`, { here: true });
  assert.equal(here.status, 200);
  assert.ok(here.data.handoff, 'a one-time pass for this device');
  const token = tokenOf(here.data.url, 'tp');
  const pub = h.client();
  assert.equal((await pub.get(`/public/tp/${token}`)).data.details?.dob_required, true, 'the link alone still asks for the birth date');

  // Another device signed in as the same person can't use it.
  const elsewhere = await secondSession(email);
  assert.equal((await elsewhere.post('/signing-passes/redeem', { code: here.data.handoff })).status, 410);
  // Nor can another practice, or nobody.
  const stranger = await h.practice();
  assert.equal((await stranger.api.post('/signing-passes/redeem', { code: here.data.handoff })).status, 410);
  assert.equal((await pub.post('/signing-passes/redeem', { code: here.data.handoff })).status, 401);

  const redeemed = await api.post('/signing-passes/redeem', { code: here.data.handoff });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.data));
  assert.equal(redeemed.data.kind, 'plan');
  assert.equal(redeemed.data.back, `/patients/${patient.id}?tab=treatment`);
  // The patient in the chair finds their name on the signing line (only on the device the office handed over).
  assert.equal(redeemed.data.signer_name, 'Jane Doe');
  // Single use.
  assert.equal((await api.post('/signing-passes/redeem', { code: here.data.handoff })).status, 410);

  const withPass = h.client(null, { 'X-Plan-Pass': redeemed.data.pass });
  const view = await withPass.get(`/public/tp/${token}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.first_name, 'Jane');
  // Bound to that plan: the pass doesn't open the other plan's link.
  const otherToken = tokenOf((await api.post(`/treatment-plans/${other.id}/present`, {})).data.url, 'tp');
  assert.equal((await withPass.get(`/public/tp/${otherToken}`)).status, 403);

  const signed = await withPass.post(`/public/tp/${token}`, { signature_name: 'Jane Doe', consent: true });
  assert.equal(signed.status, 200);
  assert.ok(signed.data.signed_at);

  // Expired passes don't work.
  const late = await api.post(`/treatment-plans/${other.id}/present`, { here: true });
  await h.db.run("UPDATE oauth_states SET expires_at = '2000-01-01T00:00:00Z' WHERE purpose = ?", `handoff:plan:${other.id}`);
  assert.equal((await api.post('/signing-passes/redeem', { code: late.data.handoff })).status, 410);

  // Who handed the device over, and when it was opened, are on the record.
  const handed = await auditRows(practiceId, 'treatment_plan.handoff');
  assert.equal(handed.length, 2);
  assert.ok(handed[0].user_id, 'the staff member who handed it over');
  const opened = await auditRows(practiceId, 'treatment_plan.handoff_opened');
  assert.equal(opened.length, 1);
  assert.equal(JSON.parse(opened[0].details).handed_over_by, handed[0].user_id);
  // Sending a link by text keeps the birth-date check (no pass).
  assert.equal((await api.post(`/treatment-plans/${other.id}/present`, { send: 'sms' })).data.handoff, undefined);

  // Only people who can change treatment can hand a plan over.
  const desk = await login(api, 'front_desk', 'Front Desk');
  assert.equal((await desk.client.post(`/treatment-plans/${other.id}/present`, { here: true })).status, 403);
});

test('23 · consent forms signed on the office device skip the birth date the same way', async () => {
  const { api, patient, provider, practiceId, email } = await h.practice();
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D7140', tooth: '17', provider_id: provider.id })).data;
  const [consent] = (await api.get(`/patients/${patient.id}/consents/suggest?procedure_ids=${proc.id}`)).data;
  const packet = await api.post(`/patients/${patient.id}/form-packets`, { template_ids: [consent.id], procedure_ids: [proc.id], here: true });
  assert.equal(packet.status, 201);
  assert.ok(packet.data.handoff);
  const token = tokenOf(packet.data.url, 'f');
  assert.equal((await h.client().get(`/public/forms/${token}`)).data.details?.dob_required, true);

  assert.equal((await (await secondSession(email)).post('/signing-passes/redeem', { code: packet.data.handoff })).status, 410);
  const got = await api.post('/signing-passes/redeem', { code: packet.data.handoff });
  assert.equal(got.status, 200);
  assert.equal(got.data.kind, 'forms');
  assert.equal((await api.post('/signing-passes/redeem', { code: packet.data.handoff })).status, 410);
  const open = await h.client(null, { 'X-Form-Pass': got.data.pass }).get(`/public/forms/${token}`);
  assert.equal(open.status, 200);
  assert.equal(open.data.forms?.length, 1);

  assert.equal((await auditRows(practiceId, 'form_request.handoff')).length, 1);
  assert.equal((await auditRows(practiceId, 'form_request.handoff_opened')).length, 1);
  // A sent link gets no pass.
  assert.equal((await api.post(`/patients/${patient.id}/form-packets`, { template_ids: [consent.id], here: true, send: 'auto' })).data.handoff, undefined);
  // Other practice: can't make a packet for this patient.
  const other = await h.practice();
  assert.equal((await other.api.post(`/patients/${patient.id}/form-packets`, { template_ids: [consent.id], here: true })).status, 404);
});

async function upload(token, patientId, { name, tooth, category = 'xray' }) {
  const q = new URLSearchParams({ filename: name, category, ...(tooth ? { tooth } : {}) });
  return (await fetch(`${h.origin}/api/patients/${patientId}/documents?${q}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'x' })).json();
}
async function claimFor(api, patient, procs) {
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W123', group_number: 'G1' })).data;
  const ids = [];
  for (const p of procs) ids.push((await api.post(`/patients/${patient.id}/procedures`, { ...p, complete: true })).data.id);
  return (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: ids })).data;
}

test('25 · suggested attachments: recent x-rays of the claim\'s teeth and the perio chart, attached together', async () => {
  const { api, patient, provider, token, practiceId } = await h.practice();
  const claim = await claimFor(api, patient, [{ code: 'D2740', tooth: '30', provider_id: provider.id }, { code: 'D4341', area: 'LR', provider_id: provider.id }]);
  const recent = await upload(token, patient.id, { name: 'pa30.png', tooth: '30' });
  const old = await upload(token, patient.id, { name: 'pa30-old.png', tooth: '30' });
  await h.db.run("UPDATE documents SET taken_at = '2020-01-01' WHERE id = ?", old.id);
  const elsewhere = await upload(token, patient.id, { name: 'pa3.png', tooth: '3' });
  const pano = await upload(token, patient.id, { name: 'pano.png' });
  await api.post(`/patients/${patient.id}/perio`, { readings: { 30: { pd: [5, 4, 6, 3, 3, 4], bop: [true, false, true, false, false, false] } } });

  const s = await api.get(`/claims/${claim.id}/attachments/suggest`);
  assert.equal(s.status, 200);
  assert.deepEqual(s.data.needs.map((n) => n.type).sort(), ['P6', 'RB']);
  const byDoc = Object.fromEntries(s.data.suggestions.filter((x) => x.document_id).map((x) => [x.document_id, x]));
  assert.equal(byDoc[recent.id]?.preselected, true, 'the recent film of #30 is picked');
  assert.equal(byDoc[pano.id]?.preselected, false, 'full-mouth film offered, not picked when #30 has its own');
  assert.equal(byDoc[old.id], undefined, 'older than a year: not suggested');
  assert.equal(byDoc[elsewhere.id], undefined, 'another tooth: not suggested');
  const perio = s.data.suggestions.find((x) => x.kind === 'perio');
  assert.equal(perio?.preselected, true);

  // Attach every preselected one in one step.
  const picked = s.data.suggestions.filter((x) => x.preselected).map((x) => (x.kind === 'perio' ? { perio_exam_id: x.perio_exam_id } : { document_id: x.document_id, report_type: x.report_type }));
  const done = await api.post(`/claims/${claim.id}/attachments/batch`, { items: picked });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.equal(done.data.added.length, 2);
  assert.ok(done.data.attachments.some((a) => a.report_type === 'P6' && /Perio chart/.test(a.filename)), 'perio chart filed as a PDF and attached');
  assert.deepEqual((await api.get(`/claims/${claim.id}/validate`)).data.warnings, []);
  // A repeat adds nothing; nothing is suggested any more.
  assert.equal((await api.post(`/claims/${claim.id}/attachments/batch`, { items: picked })).data.added.length, 0);
  assert.deepEqual((await api.get(`/claims/${claim.id}/attachments/suggest`)).data.suggestions, []);
  assert.equal((await auditRows(practiceId, 'claim.attachment_add')).length, 2);

  // Another practice's claim or document: not found. Bad input: refused.
  const other = await h.practice();
  const otherDoc = await upload(other.token, other.patient.id, { name: 'theirs.png', tooth: '30' });
  assert.equal((await api.post(`/claims/${claim.id}/attachments/batch`, { items: [{ document_id: otherDoc.id }] })).status, 404);
  assert.equal((await other.api.get(`/claims/${claim.id}/attachments/suggest`)).status, 404);
  assert.equal((await other.api.post(`/claims/${claim.id}/attachments/batch`, { items: [{ document_id: recent.id }] })).status, 404);
  assert.equal((await api.post(`/claims/${claim.id}/attachments/batch`, { items: [] })).status, 400);
  assert.equal((await api.post(`/claims/${claim.id}/attachments/batch`, { items: [{ document_id: pano.id, report_type: 'ZZ' }] })).status, 400);
  // Permissions: an assistant can't see claims; nobody without billing:write attaches.
  const assistant = await login(api, 'assistant', 'Asha Assist');
  assert.equal((await assistant.client.get(`/claims/${claim.id}/attachments/suggest`)).status, 403);
  const dentist = await login(api, 'dentist', 'Dr. Dan');
  assert.equal((await dentist.client.post(`/claims/${claim.id}/attachments/batch`, { items: [{ document_id: pano.id }] })).status, 403);
});

test('28 · a task typed in one line: assignee by first name, due today, badge count, done and undone on record', async () => {
  const { api, patient, practiceId } = await h.practice();
  const anna = await login(api, 'front_desk', 'Anna Smith');
  await login(api, 'front_desk', 'Annabel Jones');
  const bo = await login(api, 'billing', 'Bo Chen');

  const t = await api.post('/tasks', { text: 'Call the lab about the crown @anna', patient_id: patient.id });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  assert.equal(t.data.title, 'Call the lab about the crown');
  assert.equal(t.data.assigned_to, anna.id);
  assert.match(t.data.due_date, /^\d{4}-\d{2}-\d{2}$/, 'due today by default');
  assert.equal(t.data.patient_id, patient.id);
  assert.equal((await api.post('/tasks', { text: 'Refill gloves @bo' })).data.assigned_to, bo.id);
  assert.equal((await api.post('/tasks', { text: 'Check EOB @ann' })).status, 400, 'two people start with "ann"');
  assert.equal((await api.post('/tasks', { text: 'Check EOB @zed' })).status, 400);
  assert.equal((await api.post('/tasks', { text: '@anna @bo split this' })).status, 400);
  assert.equal((await api.post('/tasks', { text: '@anna' })).status, 400, 'nothing to do');
  assert.equal((await api.post('/tasks', { text: 'Email me at x@example.com' })).data.assigned_to, null, 'an email address is not a mention');

  const count = (await anna.client.get('/tasks/count')).data;
  assert.equal(count.open, 1);
  assert.equal(count.due, 1);
  assert.equal(count.latest.title, 'Call the lab about the crown');

  // Done with one key, then undone.
  const done = await anna.client.put(`/tasks/${t.data.id}`, { status: 'done' });
  assert.equal(done.data.completed_by, anna.id);
  assert.equal((await anna.client.get('/tasks/count')).data.open, 0);
  const undone = await anna.client.put(`/tasks/${t.data.id}`, { status: 'open' });
  assert.equal(undone.data.completed_by, null);
  assert.equal(undone.data.completed_at, null);
  const trail = await h.db.all("SELECT * FROM audit_log WHERE practice_id = ? AND action = 'task.update' AND entity_id = ?", practiceId, t.data.id);
  assert.deepEqual(trail.map((r) => JSON.parse(r.details).status), ['done', 'open']);
  assert.equal(trail[0].user_id, anna.id);

  // Other practice: can't point a task at this patient, or touch this task.
  const other = await h.practice();
  assert.equal((await other.api.post('/tasks', { text: 'peek', patient_id: patient.id })).status, 404);
  assert.equal((await other.api.put(`/tasks/${t.data.id}`, { status: 'done' })).status, 404);
  assert.equal((await other.api.post('/tasks', { text: 'hi @anna' })).status, 400, 'names come from your own team only');
  assert.equal((await other.api.get('/tasks/count')).data.open, 0);
});
