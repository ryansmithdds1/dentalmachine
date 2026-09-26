// Where a treatment plan stands (Presented → Thinking it over → Accepted → Scheduled → In progress → Completed &
// paid, or Declined / Expired) and the office's staff-only notes on it: status worked out from the procedures,
// visits and ledger (never stored); notes append-only, audited, never on anything the patient sees; follow-up
// dates as one task per plan; permissions and practice isolation. planprogress.js, routes/plannotes.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { stageOf, PLAN_EXPIRES_DAYS } from '../src/planprogress.js';

const h = harness();
const day = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const SECRET = 'Going home to talk to her husband about the cost';

const newPlan = async (api, patient, provider, work = [['D2740', '14'], ['D2392', '30', 'MO']]) => (await api.post(`/patients/${patient.id}/treatment-plans`, {
  name: 'Crown and filling', procedures: work.map(([code, tooth, surfaces]) => ({ code, tooth, surfaces, provider_id: provider.id })),
})).data;
const progressOf = async (api, patient, planId) => (await api.get(`/patients/${patient.id}/treatment-plans`)).data.find((p) => p.id === planId).progress;

test('stage rules: declined, done & paid, in progress, scheduled, accepted, thinking, expired, presented', () => {
  const today = '2026-09-26';
  const plan = { status: 'proposed', created_at: '2026-09-01 10:00:00' };
  const p = (status, extra = {}) => ({ status, ...extra });
  assert.equal(stageOf(plan, [p('planned')], null, today).stage, 'proposed');
  assert.equal(stageOf({ ...plan, presented_at: '2026-09-02 10:00:00' }, [p('planned')], null, today).stage, 'presented');
  assert.equal(stageOf({ ...plan, decision: 'thinking' }, [p('planned')], null, today).stage, 'thinking');
  assert.equal(stageOf({ ...plan, created_at: `${Number(today.slice(0, 4)) - 2}-01-01 10:00:00` }, [p('planned')], null, today).stage, 'expired');
  assert.ok(PLAN_EXPIRES_DAYS >= 180);
  // What the system knows wins over what staff said: signed is accepted even if someone had said "thinking".
  assert.equal(stageOf({ ...plan, decision: 'thinking', signed_at: '2026-09-03 10:00:00' }, [p('planned')], null, today).stage, 'accepted');
  const booked = stageOf({ ...plan, status: 'accepted' }, [p('planned', { appointment_id: 7, appt_status: 'scheduled' }), p('planned')], null, today);
  assert.deepEqual([booked.stage, booked.detail], ['scheduled', '1 of 2 booked']);
  // Work on a cancelled or missed visit isn't booked.
  assert.equal(stageOf({ ...plan, status: 'accepted' }, [p('planned', { appointment_id: 7, appt_status: 'cancelled' })], null, today).stage, 'accepted');
  const going = stageOf(plan, [p('completed'), p('planned')], { open: 5000, charged: 10000 }, today);
  assert.deepEqual([going.stage, going.detail, going.balance], ['in_progress', '1 of 2 done', 5000]);
  assert.equal(stageOf(plan, [p('completed')], { open: 1, charged: 10000 }, today).stage, 'completed');
  assert.equal(stageOf(plan, [p('completed')], { open: 0, charged: 10000 }, today).stage, 'paid');
  assert.equal(stageOf({ ...plan, status: 'rejected' }, [p('completed')], { open: 0 }, today).stage, 'declined');
  assert.equal(stageOf(plan, [p('planned')], null, today).balance, null, 'nothing done: nothing owed on the plan yet');
});

test('status follows the work: presented → thinking → accepted → scheduled → in progress → completed → paid (by the ledger)', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const plan = await newPlan(api, patient, provider);
  assert.equal((await progressOf(api, patient, plan.id)).stage, 'proposed');
  await api.post(`/treatment-plans/${plan.id}/present`, { here: true });
  assert.equal((await progressOf(api, patient, plan.id)).stage, 'presented');

  // A note with a chip, a follow-up date and "thinking it over", in one step.
  const noted = await api.post(`/treatment-plans/${plan.id}/notes`, { tag: 'discuss', text: SECRET, follow_up_date: day(7), stage: 'thinking' });
  assert.equal(noted.status, 201, JSON.stringify(noted.data));
  assert.equal(noted.data.progress.stage, 'thinking');
  assert.equal(noted.data.note.note, SECRET);
  assert.equal(noted.data.note.tag_label, 'Going home to discuss');
  assert.equal(noted.data.note.plan_stage, 'thinking');
  assert.deepEqual(noted.data.follow_up, { task_id: noted.data.note.task_id, date: day(7) });
  const task = (await h.db.get('SELECT * FROM tasks WHERE id = ?', noted.data.note.task_id));
  assert.equal(task.patient_id, patient.id);
  assert.equal(task.due_date, day(7));
  assert.match(task.title, /Follow up on treatment plan: Crown and filling/);
  // A second follow-up date moves the same task (one open follow-up per plan).
  const again = (await api.post(`/treatment-plans/${plan.id}/notes`, { tag: 'call_back', follow_up_date: day(10) })).data;
  assert.equal(again.note.task_id, task.id);
  assert.equal((await h.db.get('SELECT due_date FROM tasks WHERE id = ?', task.id)).due_date, day(10));
  assert.equal(again.note.note, 'Will call back', 'a chip alone is the note');

  // The list, the patient header and the Plans in process list all show it.
  const listed = (await api.get(`/patients/${patient.id}/treatment-plans`)).data.find((p) => p.id === plan.id);
  assert.equal(listed.progress.label, 'Thinking it over');
  assert.equal(listed.staff_notes.length, 2);
  assert.equal(listed.follow_up.date, day(10));
  const header = (await api.get(`/patients/${patient.id}`)).data.plan_status;
  assert.deepEqual([header.plan_id, header.stage, header.follow_up.date, header.latest_note], [plan.id, 'thinking', day(10), 'Will call back']);
  const inProcess = (await api.get('/followups/plans')).data;
  const row = inProcess.rows.find((r) => r.plan_id === plan.id);
  assert.deepEqual([row.stage, row.latest_note.text, row.follow_up.date], ['thinking', 'Will call back', day(10)]);
  assert.equal(inProcess.counts.thinking, 1);
  assert.equal((await api.get('/followups/plans?stage=accepted')).data.rows.some((r) => r.plan_id === plan.id), false);
  const unsched = (await api.get('/followups/unscheduled')).data.find((r) => r.patient_id === patient.id);
  assert.equal(unsched.follow_up, day(10));
  assert.equal(unsched.last_contact.note, 'Will call back');

  // Accepted verbally, then the crown booked, done, then paid.
  await api.put(`/treatment-plans/${plan.id}`, { status: 'accepted' });
  assert.equal((await progressOf(api, patient, plan.id)).stage, 'accepted');
  const [crown, filling] = plan.procedures;
  const appt = await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day(3)} 09:00`, end_time: `${day(3)} 10:00`, procedure_ids: [crown.id], override_blockout: true });
  assert.equal(appt.status, 201, JSON.stringify(appt.data));
  const sched = await progressOf(api, patient, plan.id);
  assert.deepEqual([sched.stage, sched.detail], ['scheduled', '1 of 2 booked']);
  assert.equal((await api.post(`/procedures/${crown.id}/complete`)).status, 200);
  const going = await progressOf(api, patient, plan.id);
  assert.deepEqual([going.stage, going.detail, going.balance], ['in_progress', '1 of 2 done', crown.fee]);
  assert.equal((await api.post(`/procedures/${filling.id}/complete`)).status, 200);
  const done = await progressOf(api, patient, plan.id);
  assert.deepEqual([done.stage, done.label, done.balance], ['completed', 'Completed', crown.fee + filling.fee]);
  // Paid in part: still a balance. Paid in full: "Completed & paid" — from the ledger, never stored.
  assert.equal((await api.post(`/patients/${patient.id}/payments`, { amount: crown.fee, method: 'cash' })).status, 201);
  assert.equal((await progressOf(api, patient, plan.id)).balance, filling.fee);
  assert.equal((await api.post(`/patients/${patient.id}/payments`, { amount: filling.fee, method: 'cash' })).status, 201);
  const paid = await progressOf(api, patient, plan.id);
  assert.deepEqual([paid.stage, paid.label, paid.balance], ['paid', 'Completed & paid', 0]);
  assert.equal((await api.get('/followups/plans')).data.rows.some((r) => r.plan_id === plan.id), false, 'paid plans leave the list');
  assert.equal((await api.get('/followups/plans?all=1')).data.rows.find((r) => r.plan_id === plan.id).stage, 'paid');
  assert.equal((await api.get(`/patients/${patient.id}`)).data.plan_status, null, 'nothing in process');
  // A voided payment reopens the balance.
  const pay = (await api.get(`/patients/${patient.id}/ledger`)).data;
  const last = (pay.entries || pay).filter((e) => e.type === 'payment').at(-1);
  assert.ok([200, 201].includes((await api.post(`/ledger/${last.id}/void`, { reason: 'Bounced' })).status));
  assert.equal((await progressOf(api, patient, plan.id)).stage, 'completed');
});

test('notes are never on anything the patient sees: plan page, PDF, portal plan list, staff print data only has status', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const plan = await newPlan(api, patient, provider);
  await api.post(`/treatment-plans/${plan.id}/notes`, { text: SECRET, tag: 'price' });
  await api.post(`/patients/${patient.id}/conditions`, { tooth: '3', condition: 'crown' });
  await api.post(`/patients/${patient.id}/conditions`, { tooth: '30', condition: 'caries', surfaces: 'MO' });
  const link = (await api.post(`/treatment-plans/${plan.id}/present`, { here: true })).data;
  const token = new URL(link.url).pathname.split('/').pop();
  const pass = (await h.client().post(`/public/tp/${token}/verify`, { dob: patient.dob })).data.pass;
  const pub = h.client(null, { 'X-Plan-Pass': pass });
  const page = await pub.get(`/public/tp/${token}`);
  assert.equal(page.status, 200);
  // The drawing of their mouth: restorations already there, not findings, and nothing but tooth/what/surfaces.
  assert.deepEqual(page.data.chart.existing, [{ tooth: '3', condition: 'crown', surfaces: null }]);
  const text = JSON.stringify(page.data);
  assert.ok(!text.includes(SECRET) && !text.includes('Price concern') && !text.includes('decision'), 'no notes or staff status on the patient page');
  const quote = JSON.stringify((await pub.get(`/public/tp/${token}/quote`)).data);
  assert.ok(!quote.includes(SECRET));
  const pdf = await fetch(`${h.origin}/api/public/tp/${token}/pdf?pass=${encodeURIComponent(pass)}`);
  assert.equal(pdf.status, 200);
  assert.ok(!Buffer.from(await pdf.arrayBuffer()).toString('latin1').includes('talk to her husband'), 'not in the patient PDF');
  // The staff print page's data carries the status but not the notes.
  const print = (await api.get(`/treatment-plans/${plan.id}`)).data;
  assert.ok(!JSON.stringify(print).includes(SECRET));
  assert.equal(print.progress.stage, 'presented');
});

test('staff PDF of the plan never carries the notes', async () => {
  const { api, token, patient, provider } = await h.practice({ timezone: 'UTC' });
  const plan = await newPlan(api, patient, provider);
  await api.post(`/treatment-plans/${plan.id}/notes`, { text: SECRET });
  const pdf = await fetch(`${h.origin}/api/treatment-plans/${plan.id}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(pdf.status, 200);
  assert.ok(!Buffer.from(await pdf.arrayBuffer()).toString('latin1').includes('talk to her husband'));
});

test('notes are append-only: corrections are new notes, the old one stays, the database refuses an edit, all audited', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const plan = await newPlan(api, patient, provider);
  const first = (await api.post(`/treatment-plans/${plan.id}/notes`, { text: 'Wants to do it in Janury' })).data.note;
  const fix = await api.post(`/treatment-plans/${plan.id}/notes`, { text: 'Wants to do it in January', corrects_id: first.id });
  assert.equal(fix.status, 201);
  const notes = (await api.get(`/treatment-plans/${plan.id}/notes`)).data.notes;
  assert.equal(notes.length, 2);
  assert.equal(notes.find((n) => n.id === first.id).corrected_by, fix.data.note.id);
  assert.equal(notes.find((n) => n.id === first.id).note, 'Wants to do it in Janury', 'the original is kept as written');
  assert.equal((await api.post(`/treatment-plans/${plan.id}/notes`, { text: 'again', corrects_id: first.id })).status, 409, 'corrected once');
  await assert.rejects(h.db.run("UPDATE followups SET note = 'changed' WHERE id = ?", first.id), /cannot be changed/);
  // No route edits or deletes a note.
  assert.equal((await api.put(`/treatment-plans/${plan.id}/notes/${first.id}`, { text: 'x' })).status, 404);
  assert.equal((await api.del(`/treatment-plans/${plan.id}/notes/${first.id}`)).status, 404);
  const audits = await h.db.all("SELECT * FROM audit_log WHERE action = 'treatment_plan.note' AND entity_id = ?", plan.id);
  assert.equal(audits.length, 2);
  assert.equal(JSON.parse(audits[1].details).corrects_id, first.id);
  assert.ok(audits.every((a) => a.user_id));

  // Validation: nothing to say, unknown chip, a past or impossible date, too long, another plan's note.
  for (const bad of [{}, { tag: 'nope' }, { text: 'x', follow_up_date: day(-2) }, { text: 'x', follow_up_date: '2026-02-30' }, { text: 'x'.repeat(1001) }, { text: 'x', stage: 'accepted' }]) {
    assert.equal((await api.post(`/treatment-plans/${plan.id}/notes`, bad)).status, 400, JSON.stringify(bad));
  }
  const other = await newPlan(api, patient, provider);
  assert.equal((await api.post(`/treatment-plans/${other.id}/notes`, { text: 'x', corrects_id: first.id })).status, 404);
});

test('declining and reopening with a note: status recorded before/after; declining needs clinical permission', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const plan = await newPlan(api, patient, provider);
  const desk = (await api.post('/users', { email: `desk-${Date.now()}@example.com`, name: 'Desk', role: 'front_desk', password: 'correct-horse-battery' })).data;
  const deskApi = h.client((await h.client().post('/auth/login', { email: desk.email, password: 'correct-horse-battery' })).data.token);
  // The front desk writes notes and marks "thinking it over", but can't decline a plan.
  assert.equal((await deskApi.post(`/treatment-plans/${plan.id}/notes`, { tag: 'financing', stage: 'thinking' })).status, 201);
  assert.equal((await deskApi.post(`/treatment-plans/${plan.id}/notes`, { text: 'No thanks', stage: 'declined' })).status, 403);
  const declined = await api.post(`/treatment-plans/${plan.id}/notes`, { text: 'Getting it done elsewhere', stage: 'declined' });
  assert.equal(declined.data.progress.stage, 'declined');
  assert.equal((await api.post(`/treatment-plans/${plan.id}/notes`, { text: 'again', stage: 'declined' })).status, 409);
  const a = await h.db.get("SELECT * FROM audit_log WHERE action = 'treatment_plan.note' AND entity_id = ? ORDER BY id DESC LIMIT 1", plan.id);
  assert.deepEqual(JSON.parse(a.changes).status, ['proposed', 'rejected']);
  assert.equal((await api.post(`/treatment-plans/${plan.id}/notes`, { text: 'Changed her mind', stage: 'reopen' })).data.progress.stage, 'proposed');
  assert.equal((await h.db.get('SELECT status, decision FROM treatment_plans WHERE id = ?', plan.id)).status, 'proposed');
});

test('permissions and practice isolation: billing reads without dollars hidden, other practices see nothing', async () => {
  const a = await h.practice({ timezone: 'UTC' });
  const b = await h.practice({ timezone: 'UTC' });
  const plan = await newPlan(a.api, a.patient, a.provider);
  await a.api.post(`/treatment-plans/${plan.id}/notes`, { text: SECRET });
  assert.equal((await b.api.get(`/treatment-plans/${plan.id}/notes`)).status, 404);
  assert.equal((await b.api.post(`/treatment-plans/${plan.id}/notes`, { text: 'x' })).status, 404);
  assert.ok(!JSON.stringify((await b.api.get('/followups/plans')).data).includes(SECRET));
  // The billing team can read (and sees dollars) but doesn't write clinical follow-up notes (patients:write).
  const bill = (await a.api.post('/users', { email: `bill-${Date.now()}@example.com`, name: 'Bill', role: 'billing', password: 'correct-horse-battery' })).data;
  const billApi = h.client((await h.client().post('/auth/login', { email: bill.email, password: 'correct-horse-battery' })).data.token);
  assert.equal((await billApi.get(`/treatment-plans/${plan.id}/notes`)).status, 200);
  assert.equal((await billApi.post(`/treatment-plans/${plan.id}/notes`, { text: 'x' })).status, 403);
  // Without a login: nothing.
  assert.equal((await h.client().get(`/treatment-plans/${plan.id}/notes`)).status, 401);
});
