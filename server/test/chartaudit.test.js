// Chart audit (CA1-CA4): each check on its own, the nightly pass (idempotent, resolves what was fixed, keeps
// history), practice and office isolation, who sees which provider's findings, the AI read (sandbox) with the
// note's own sentence as evidence, notes never touched, and "Check my chart" → ready for doctor → doctor queue.
// The routes aren't mounted in app.js by this file's author, so they're mounted on a small app here
// (pattern: offline.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import chartAuditRoutes from '../src/routes/chartaudit.js';
import { authenticate, HttpError } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import { checks, DEFAULT_RULES, cleanRules, teethIn, surfacesIn, findProcedure, runPracticeAudit, checkVisit, auditVisit } from '../src/chartaudit.js';
import { spellCheck, grammarCheck, templateQuestions } from '../src/chartcheck.js';
import { createNoteComparer } from '../src/ai/notecompare.js';

const h = harness();
const sandbox = createNoteComparer({ mode: 'sandbox' });
let origin;
let server;
before(async () => {
  for (let i = 0; !h.db && i < 3000; i++) await new Promise((r) => setTimeout(r, 20));
  const app = express();
  app.use(actorMiddleware(h.db, flushChanges));
  app.use(express.json());
  const api = express.Router();
  api.use(authenticate(h.db, 'test-secret'));
  api.use((req, _res, next) => {
    setActor({ source: 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(officeAccess(h.db));
  api.use(chartAuditRoutes({ db: h.db, config: h.config, comparer: sandbox }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message, details: err.details }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const call = (token) => async (method, path, body) => {
  const res = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, data };
};
const signIn = async (email) => (await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token;

// ---- The pure checks ----
const ctxOf = (over = {}) => {
  const notes = over.notes ?? [{ id: 1, body: over.body ?? '', signed: 1, signed_by: 10, signed_by_name: 'Dr A' }];
  return {
    key: 'a1', appointment_id: 1, patient_id: 1, date: '2026-09-01', today: '2026-09-10', procedures: [], addenda: [], editableNoteId: null, mainNote: notes[0] || null,
    treatingUsers: [10], providerNames: ['Dr A'], patientAge: 40, medicalReviews: ['2026-08-01 10:00:00'], xrays: [], vitals: [], prescriptions: [], declined: [],
    consent: { forms: 0, signedPlans: [], refusalForms: 0 }, lastPerio: '2026-06-01', ...over, notes, noteText: notes.map((n) => n.body).join('\n'),
  };
};
const proc = (code, category, extra = {}) => ({ id: extra.id ?? Math.floor(Math.random() * 1e6), code, category, description: extra.description || code, status: 'completed', tooth: null, surfaces: null, appointment_id: 1, ...extra });
const R = structuredClone(DEFAULT_RULES);
const codes = (list) => list.map((f) => f.check);

test('reading notes: teeth, surfaces and procedure wording', () => {
  assert.deepEqual([...teethIn('Restored #14 MO and tooth 3; teeth 30, 31 and 32 checked.')].sort(), ['14', '3', '30', '31', '32']);
  assert.deepEqual(surfacesIn('#14 MO composite, B surface on #3 B'), ['MO', 'B', 'B']);
  assert.deepEqual(surfacesIn('I do not see it'), []);
  assert.equal(findProcedure('Placed composite on #14.', { code: 'D2392', description: 'Resin-based composite' }).found, true);
  assert.equal(findProcedure('D2392 done.', { code: 'D2392' }).found, true);
  assert.equal(findProcedure('Patient happy.', { code: 'D2392' }).found, false);
});

test('no note / unsigned / signed by someone else', () => {
  assert.deepEqual(codes(checks.no_note(ctxOf({ notes: [] }))), ['no_note']);
  assert.deepEqual(checks.no_note(ctxOf({ body: 'Exam done.' })), []);
  const unsigned = ctxOf({ notes: [{ id: 5, body: 'x', signed: 0 }] });
  const f = checks.unsigned_note(unsigned, R);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'high'); // 9 days > 7
  assert.match(f[0].detail, /9 days/);
  assert.equal(checks.unsigned_note({ ...unsigned, today: '2026-09-04' }, R)[0].severity, 'medium');
  assert.deepEqual(checks.unsigned_note({ ...unsigned, today: '2026-09-02' }, R), []); // within the grace day
  assert.deepEqual(codes(checks.signed_by_other(ctxOf({ notes: [{ id: 1, body: 'x', signed: 1, signed_by: 99, signed_by_name: 'Front Desk' }] }))), ['signed_by_other']);
  assert.deepEqual(checks.signed_by_other(ctxOf({ body: 'x' })), []);
});

test('charted work vs the note, both ways, with teeth and surfaces', () => {
  const composite = proc('D2392', 'restorative', { id: 7, description: 'Resin-based composite, two surfaces, posterior', tooth: '14', surfaces: 'MO' });
  assert.deepEqual(codes(checks.proc_not_in_note(ctxOf({ body: 'Patient tolerated well.', procedures: [composite] }))), ['proc_not_in_note']);
  assert.deepEqual(checks.proc_not_in_note(ctxOf({ body: 'Composite placed #14 MO.', procedures: [composite] })), []);
  assert.deepEqual(checks.tooth_mismatch(ctxOf({ body: 'Composite placed #14 MO.', procedures: [composite] })), []);
  const wrongTooth = checks.tooth_mismatch(ctxOf({ body: 'Composite placed #15 MO.', procedures: [composite] }));
  assert.equal(wrongTooth.length, 1);
  assert.equal(wrongTooth[0].evidence, 'Composite placed #15 MO.');
  const wrongSurface = checks.tooth_mismatch(ctxOf({ body: 'Composite placed #14 DO.', procedures: [composite] }));
  assert.match(wrongSurface[0].title, /Surfaces differ/);
  assert.equal(checks.tooth_mismatch(ctxOf({ body: 'Composite placed #14 OM.', procedures: [composite] })).length, 0); // same surfaces, other order
  assert.match(checks.tooth_mismatch(ctxOf({ body: 'Composite placed.', procedures: [composite] }))[0].title, /doesn’t say which tooth/);
  // The reverse: work described as done that isn't charted; planned work isn't.
  const extra = checks.work_not_charted(ctxOf({ body: 'Composite placed #14 MO. Extracted #32 with forceps.', procedures: [composite] }));
  assert.deepEqual(extra.map((f) => f.subject), ['extraction:32']);
  assert.equal(extra[0].evidence, 'Extracted #32 with forceps.');
  assert.deepEqual(checks.work_not_charted(ctxOf({ body: 'Recommended extraction of #32 next visit.', procedures: [] })), []);
});

test('anesthetic details, x-ray reading, consent, medical history, BP', () => {
  const composite = proc('D2391', 'restorative', { tooth: '3', surfaces: 'O' });
  assert.match(checks.anesthetic_details(ctxOf({ body: 'Composite #3 O.', procedures: [composite] }), R)[0].title, /No anesthetic/);
  const partial = checks.anesthetic_details(ctxOf({ body: 'Composite #3 O. Lidocaine given.', procedures: [composite] }), R);
  assert.match(partial[0].detail, /amount \(carpules\), injection site/);
  assert.deepEqual(checks.anesthetic_details(ctxOf({ body: 'Composite #3 O. 2% lidocaine 1:100k epi, 2 carpules, infiltration buccal.', procedures: [composite] }), R), []);
  assert.deepEqual(checks.anesthetic_details(ctxOf({ body: 'Composite #3 O, no anesthetic needed.', procedures: [composite] }), R), []);
  assert.deepEqual(checks.anesthetic_details(ctxOf({ body: 'Prophy.', procedures: [proc('D1110', 'preventive')] }), R), []);

  const bw = proc('D0274', 'diagnostic', { description: 'Bitewings, four images' });
  assert.equal(checks.xray_interpretation(ctxOf({ body: 'Periodic exam.', procedures: [bw] })).length, 1);
  assert.deepEqual(checks.xray_interpretation(ctxOf({ body: 'BWX taken; radiographs show no caries.', procedures: [bw] })), []);
  assert.deepEqual(checks.xray_interpretation(ctxOf({ body: 'Exam.', xrays: [{ id: 1, notes: 'Distal caries #30 into dentin.' }] })), []);
  assert.equal(checks.xray_interpretation(ctxOf({ body: 'Exam.', xrays: [{ id: 1, notes: null }] })).length, 1);

  const ext = proc('D7140', 'oral_surgery', { id: 44, tooth: '32', treatment_plan_id: 3 });
  const noConsent = checks.consent_missing(ctxOf({ body: 'Extraction #32. Consent signed.', procedures: [ext] }), R);
  assert.match(noConsent[0].detail, /note says consent was given, but no signed consent is on file/);
  assert.deepEqual(checks.consent_missing(ctxOf({ body: 'x', procedures: [ext], consent: { forms: 1, signedPlans: [], refusalForms: 0 } }), R), []);
  assert.deepEqual(checks.consent_missing(ctxOf({ body: 'x', procedures: [ext], consent: { forms: 0, signedPlans: [3], refusalForms: 0 } }), R), []);
  assert.deepEqual(checks.consent_missing(ctxOf({ body: 'x', procedures: [composite] }), R), []);

  assert.deepEqual(checks.medical_history(ctxOf(), R), []);
  assert.match(checks.medical_history(ctxOf({ medicalReviews: ['2025-01-01 10:00:00'] }), R)[0].detail, /Last reviewed 2025-01-01/);
  assert.match(checks.medical_history(ctxOf({ medicalReviews: [] }), R)[0].detail, /No medical history review/);

  assert.equal(checks.blood_pressure(ctxOf({ body: 'Composite #3 O, lidocaine 1 carpule infiltration.', procedures: [composite] }), R).length, 1);
  assert.deepEqual(checks.blood_pressure(ctxOf({ body: 'BP 128/82. Composite #3 O.', procedures: [composite] }), R), []);
  assert.deepEqual(checks.blood_pressure(ctxOf({ body: 'Composite', procedures: [composite], vitals: [{ bp_systolic: 120, bp_diastolic: 80 }] }), R), []);
  assert.deepEqual(checks.blood_pressure(ctxOf({ body: 'Prophy.', procedures: [proc('D1110', 'preventive')] }), R), []); // no anesthetic, office asks only then
  assert.equal(checks.blood_pressure(ctxOf({ body: 'Prophy.', procedures: [proc('D1110', 'preventive')] }), { ...R, bp_required: 'every_visit' }).length, 1);
  assert.deepEqual(checks.blood_pressure(ctxOf({ body: 'x', procedures: [composite] }), { ...R, bp_required: 'never' }), []);
});

test('informed refusal, post-op, perio, prescriptions, scheduled work', () => {
  const declined = [{ id: 9, name: 'Crown #19' }];
  assert.equal(checks.informed_refusal(ctxOf({ body: 'Exam.', declined })).length, 1);
  assert.deepEqual(checks.informed_refusal(ctxOf({ body: 'Pt declined crown #19. Risks of fracture explained; patient understands.', declined })), []);
  const ext = proc('D7140', 'oral_surgery', { tooth: '1' });
  assert.equal(checks.postop_missing(ctxOf({ body: 'Extracted #1.', procedures: [ext] }), R).length, 1);
  assert.deepEqual(checks.postop_missing(ctxOf({ body: 'Extracted #1. Post-op instructions given.', procedures: [ext] }), R), []);
  const prophy = proc('D1110', 'preventive');
  assert.deepEqual(checks.perio_overdue(ctxOf({ procedures: [prophy] }), R), []);
  assert.match(checks.perio_overdue(ctxOf({ procedures: [prophy], lastPerio: '2025-01-01' }), R)[0].detail, /Last full perio charting 2025-01-01/);
  assert.deepEqual(checks.perio_overdue(ctxOf({ procedures: [prophy], lastPerio: null, patientAge: 12 }), R), []); // children aren't charted yearly
  const rx = [{ id: 3, drug: 'Amoxicillin', strength: '500 mg', sig: '1 cap tid', quantity: '21' }];
  assert.equal(checks.rx_not_noted(ctxOf({ body: 'Exam.', prescriptions: rx })).length, 1);
  assert.deepEqual(checks.rx_not_noted(ctxOf({ body: 'Rx amoxicillin 500mg for infection.', prescriptions: rx })), []);
  const planned = proc('D2392', 'restorative', { status: 'planned', tooth: '30' });
  assert.equal(checks.scheduled_not_done(ctxOf({ body: 'Exam.', procedures: [planned] })).length, 1);
  assert.deepEqual(checks.scheduled_not_done(ctxOf({ body: 'Patient declined filling today.', procedures: [planned] })), []);
});

test('rules: cleaned and validated', () => {
  const r = cleanRules({ checks: { blood_pressure: false }, medical_history_days: 180, consent_codes: 'd7140, D7210', bp_required: 'every_visit' });
  assert.equal(r.checks.blood_pressure, false);
  assert.equal(r.checks.no_note, true);
  assert.deepEqual(r.consent_codes, ['D7140', 'D7210']);
  assert.throws(() => cleanRules({ checks: { nope: true } }), /Unknown check/);
  assert.throws(() => cleanRules({ medical_history_days: 5 }), /medical_history_days/);
  assert.throws(() => cleanRules({ consent_categories: ['surgery'] }), /consent_categories/);
  assert.throws(() => cleanRules({ bp_required: 'sometimes' }), /bp_required/);
});

test('spelling, grammar and template questions (Check my chart extras)', () => {
  const s = spellCheck('Gave 2 carpels of articane. Occlussal caries on #30. The patient was happy and fine.');
  assert.deepEqual(s.map((x) => [x.word, x.suggestion]), [['carpels', 'carpules'], ['articane', 'articaine'], ['Occlussal', 'Occlusal']]);
  assert.deepEqual(spellCheck('Patient happy, crown seated, bridge fine, mental nerve block.'), []); // ordinary words aren't flagged
  assert.equal(spellCheck('Distral caries noted.')[0].suggestion, 'Distal');
  assert.deepEqual(grammarCheck('Placed the the composite.').map((g) => g.suggestion), ['the']);
  assert.deepEqual(templateQuestions('Shade [[Shade: A1|A2]] placed.').map((q) => q.label), ['Shade']);
});

test('AI sandbox: reads wording the keywords can’t place, with the note’s own sentence as evidence', async () => {
  const guard = proc('D9944', 'adjunctive', { id: 21, description: 'Occlusal guard, hard appliance, full arch' });
  const seal = proc('D1351', 'preventive', { id: 22, description: 'Sealant, per tooth', tooth: '3' });
  const body = 'Delivered the hard appliance for bruxism; adjusted and polished. Pt happy.';
  const ctx = ctxOf({ body, procedures: [guard, seal] });
  const plain = await auditVisit(ctx, R, {});
  assert.deepEqual(plain.findings.filter((f) => f.check === 'proc_not_in_note').map((f) => f.subject).sort(), ['21', '22']);
  const read = await auditVisit(ctx, R, { comparer: sandbox });
  assert.equal(read.aiUsed, true);
  const left = read.findings.filter((f) => f.check === 'proc_not_in_note');
  assert.deepEqual(left.map((f) => [f.subject, f.source]), [['22', 'ai']]); // the guard is described; the sealant isn't
  // A tooth mismatch the AI reports carries the exact sentence it relied on.
  // (D1999, a code the keyword families don't know, so its wording goes to the AI.)
  const ctx2 = ctxOf({ body: 'Isolation and placement done on #5.', procedures: [proc('D1999', 'preventive', { id: 30, description: 'Unspecified preventive procedure, isolation placement', tooth: '4' })] });
  const out = await auditVisit(ctx2, R, { comparer: sandbox });
  const tooth = out.findings.find((f) => f.check === 'tooth_mismatch' && f.source === 'ai');
  assert.equal(tooth.evidence, 'Isolation and placement done on #5.');
  assert.ok(!out.findings.some((f) => f.check === 'proc_not_in_note'));
  // AI off for the office: the keyword result stands.
  const off = await auditVisit(ctx, { ...R, ai_compare: false }, { comparer: sandbox });
  assert.equal(off.aiUsed, false);
});

// ---- The nightly pass, the report and permissions (real database) ----
let otherP = null;
const otherPractice = async () => (otherP ??= await setUp());
async function setUp(extra = {}) {
  const p = await h.practice({ timezone: 'UTC', ...extra });
  const db = h.db;
  const pid = (await db.get('SELECT practice_id FROM patients WHERE id = ?', p.patient.id)).practice_id;
  const admin = await db.get("SELECT id FROM users WHERE practice_id = ? AND role = 'admin'", pid);
  const mk = async (role, name) => {
    const email = `${role}${Math.random().toString(36).slice(2, 8)}@example.com`;
    await p.api.post('/users', { name, email, password: 'correct-horse-battery', role });
    const user = await db.get('SELECT id FROM users WHERE email = ?', email);
    // Signed in only when a test uses them (sign-ins are rate limited).
    let token = null;
    return { id: user.id, get token() { return token || signIn(email).then((t) => { token = t; return t; }); } };
  };
  const drA = await mk('dentist', 'Dr A');
  const drB = await mk('dentist', 'Dr B');
  const asst = await mk('assistant', 'Asst Amy');
  await db.run('UPDATE providers SET user_id = ? WHERE id = ?', drA.id, p.provider.id);
  const provB = (await p.api.post('/providers', { name: 'Dr B', type: 'dentist' })).data;
  await db.run('UPDATE providers SET user_id = ? WHERE id = ?', drB.id, provB.id);
  // Dr B is an associate: no practice reports, so not a manager.
  await db.run("UPDATE users SET permissions_remove = '[\"reports:read\"]' WHERE id = ?", drB.id);
  await db.run("UPDATE users SET permissions_remove = '[\"reports:read\"]' WHERE id = ?", drA.id);
  const code = async (c) => db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', pid, c);
  const appt = async ({ date, provider = p.provider.id, patient = p.patient.id, status = 'completed', location = null }) => (await db.run(
    'INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status, location_id) VALUES (?, ?, ?, ?, ?, ?, ?)', pid, patient, provider, `${date} 09:00`, `${date} 10:00`, status, location,
  )).id;
  const procedure = async ({ c, appointmentId, tooth = null, surfaces = null, status = 'completed', provider = p.provider.id, patient = p.patient.id }) => {
    const pc = await code(c);
    return (await db.run(
      'INSERT INTO procedures (practice_id, patient_id, appointment_id, provider_id, code_id, code, description, category, tooth, surfaces, fee, status, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      pid, patient, appointmentId, provider, pc.id, pc.code, pc.description, pc.category, tooth, surfaces, pc.fee, status, status === 'completed' ? '2026-09-01 15:00:00' : null,
    )).id;
  };
  const note = async ({ appointmentId, body, signed = true, signer = drA.id, provider = p.provider.id, patient = p.patient.id }) => (await db.run(
    'INSERT INTO clinical_notes (practice_id, patient_id, appointment_id, provider_id, author_id, body, signed, signed_at, signed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    pid, patient, appointmentId, provider, admin.id, body, signed ? 1 : 0, signed ? '2026-09-01 16:00:00' : null, signed ? signer : null,
  )).id;
  await db.run("UPDATE patients SET medical_reviewed_at = '2026-08-15 10:00:00' WHERE id = ?", p.patient.id);
  await db.run("INSERT INTO perio_exams (practice_id, patient_id, exam_date, readings) VALUES (?, ?, '2026-06-01', '{}')", pid, p.patient.id);
  const adminToken = p.token;
  return { ...p, pid, drA, drB, asst, provB, appt, procedure, note, adminToken };
}

test('nightly pass: finds, is idempotent, resolves what was fixed and keeps it; notes are never changed', async () => {
  const s = await setUp();
  const db = h.db;
  const a1 = await s.appt({ date: '2026-09-01' });
  await s.procedure({ c: 'D2392', appointmentId: a1, tooth: '14', surfaces: 'MO' });
  const n1 = await s.note({ appointmentId: a1, body: 'Composite placed #15 MO. Patient tolerated well.' });
  const a2 = await s.appt({ date: '2026-09-02' });
  await s.procedure({ c: 'D1110', appointmentId: a2 });
  const before = await db.all('SELECT id, body, signed, signed_at FROM clinical_notes WHERE practice_id = ? ORDER BY id', s.pid);

  const first = await runPracticeAudit(db, s.pid, { today: '2026-09-10', comparer: sandbox });
  assert.equal(first.skipped, false);
  assert.equal(first.visits, 2);
  const open = await db.all("SELECT check_code, subject, visit_key, source FROM chart_audit_findings WHERE practice_id = ? AND status = 'open' ORDER BY visit_key, check_code", s.pid);
  assert.deepEqual(open.filter((f) => f.visit_key === `a${a1}`).map((f) => f.check_code).sort(), ['anesthetic_details', 'blood_pressure', 'tooth_mismatch']);
  assert.deepEqual(open.filter((f) => f.visit_key === `a${a2}`).map((f) => f.check_code), ['no_note']);
  // The same night again: nothing new.
  assert.equal((await runPracticeAudit(db, s.pid, { today: '2026-09-10', comparer: sandbox })).skipped, true);
  const again = await runPracticeAudit(db, s.pid, { today: '2026-09-10', runKey: 'manual:x', comparer: sandbox });
  assert.equal(again.opened, 0);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM chart_audit_findings WHERE practice_id = ?', s.pid)).n, open.length);

  // Fixed with an addendum (the signed note itself is untouched) and a note for the second visit.
  await db.run('INSERT INTO clinical_notes (practice_id, patient_id, appointment_id, author_id, body, addendum_of, signed) VALUES (?, ?, ?, ?, ?, ?, 1)', s.pid, s.patient.id, a1, s.drA.id,
    'Addendum: correction, the composite was on #14 MO (not #15). 4% articaine 1 carpule, infiltration buccal. BP 122/78.', n1);
  await s.note({ appointmentId: a2, body: 'Adult prophy, scaled and polished.' });
  const third = await runPracticeAudit(db, s.pid, { today: '2026-09-11', comparer: sandbox });
  assert.ok(third.resolved >= 3, JSON.stringify(third));
  const after = await db.all('SELECT check_code, status, resolved_at FROM chart_audit_findings WHERE practice_id = ? ORDER BY id', s.pid);
  assert.deepEqual(after.filter((f) => f.status === 'open'), [], JSON.stringify(after));
  assert.ok(after.filter((f) => f.status === 'resolved').every((f) => f.resolved_at));
  assert.equal(after.length, open.length); // history kept: resolved rows are still there
  // Notes are exactly as they were (the audit never edits or signs).
  const nowNotes = await db.all('SELECT id, body, signed, signed_at FROM clinical_notes WHERE practice_id = ? AND id IN (' + before.map(() => '?').join(',') + ') ORDER BY id', s.pid, ...before.map((n) => n.id));
  assert.deepEqual(nowNotes, before);
  // A problem that comes back is a new row; the resolved one stays as history.
  await db.run("UPDATE patients SET medical_reviewed_at = NULL WHERE id = ?", s.patient.id);
  await runPracticeAudit(db, s.pid, { today: '2026-09-12' });
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM chart_audit_findings WHERE practice_id = ? AND check_code = 'medical_history' AND status = 'open'", s.pid)).n, 2);
});

test('report: provider visibility, practice isolation, office scope, filters, CSV, rules and acknowledge', async () => {
  const s = await setUp();
  const other = await otherPractice();
  // "Run now" (below) looks back from the real today, so this visit history is dated relative to it: the audit day
  // is two days ago, and the visits, sign-offs and history keep the distances the fixed dates had (Sep 1 & 2, audited
  // Sep 10) — fixed 2026 dates fall out of the one-year look-back by September 2027.
  const shiftDay = (base, n) => new Date(Date.parse(`${base}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const auditDay = shiftDay(new Date().toISOString().slice(0, 10), -2); // clear of the office's today in any time zone
  const on = (fixed) => shiftDay(auditDay, Math.round((Date.parse(`${fixed}T12:00:00Z`) - Date.parse('2026-09-10T12:00:00Z')) / 86400_000));
  await h.db.run('UPDATE patients SET medical_reviewed_at = ? WHERE id = ?', `${on('2026-08-15')} 10:00:00`, s.patient.id);
  await h.db.run('UPDATE perio_exams SET exam_date = ? WHERE patient_id = ?', on('2026-06-01'), s.patient.id);
  const aA = await s.appt({ date: on('2026-09-01') });
  await s.procedure({ c: 'D2392', appointmentId: aA, tooth: '14', surfaces: 'MO' });
  const aB = await s.appt({ date: on('2026-09-02'), provider: s.provB.id });
  await s.procedure({ c: 'D7140', appointmentId: aB, tooth: '1', provider: s.provB.id });
  await s.note({ appointmentId: aB, body: 'Extracted #1.', signer: s.drB.id, provider: s.provB.id });
  const oa = await other.appt({ date: on('2026-09-01') });
  await other.procedure({ c: 'D2392', appointmentId: oa, tooth: '3', surfaces: 'O' });
  await h.db.run("UPDATE procedures SET completed_at = ? WHERE practice_id IN (?, ?) AND completed_at = '2026-09-01 15:00:00'", `${on('2026-09-01')} 15:00:00`, s.pid, other.pid);
  await h.db.run("UPDATE clinical_notes SET signed_at = ? WHERE practice_id IN (?, ?) AND signed_at = '2026-09-01 16:00:00'", `${on('2026-09-01')} 16:00:00`, s.pid, other.pid);
  await runPracticeAudit(h.db, s.pid, { today: on('2026-09-10') });
  await runPracticeAudit(h.db, other.pid, { today: on('2026-09-10') });

  const admin = call(s.adminToken);
  const all = (await admin('GET', '/chart-audit/findings')).data;
  assert.equal(all.can_manage, true);
  assert.deepEqual([...new Set(all.findings.map((f) => f.patient_id))], [s.patient.id]); // nothing from the other practice
  assert.deepEqual(all.groups.map((g) => g.provider_name).sort(), ['Dr B', 'Dr. Ann Lee, DDS']);
  assert.ok(all.findings[0].risk >= all.findings.at(-1).risk);
  assert.ok(all.findings.every((f) => f.why && f.title));

  // Dr B sees only Dr B's visit; Dr A only Dr A's; the assistant (no provider record) none.
  const drB = call(await s.drB.token);
  const mineB = (await drB('GET', '/chart-audit/findings')).data;
  assert.equal(mineB.can_manage, false);
  assert.ok(mineB.findings.length && mineB.findings.every((f) => f.provider_id === s.provB.id));
  assert.equal((await drB('GET', `/chart-audit/findings?provider_id=${s.provider.id}`)).data.findings.length, 0);
  assert.equal((await drB('GET', `/chart-audit/visits/a${aA}`)).status, 403);
  assert.equal((await drB('GET', `/chart-audit/visits/a${aB}`)).status, 200);
  assert.equal((await call(await s.asst.token)('GET', '/chart-audit/findings')).data.findings.length, 0);
  // Another practice's visit doesn't exist.
  assert.equal((await admin('GET', `/chart-audit/visits/a${oa}`)).status, 404);
  // Filters.
  const consent = (await admin('GET', '/chart-audit/findings?check=consent_missing')).data.findings;
  assert.deepEqual(consent.map((f) => f.check_code), ['consent_missing']);
  assert.equal((await admin('GET', '/chart-audit/findings?severity=bad')).status, 400);
  assert.equal((await admin('GET', `/chart-audit/findings?from=${on('2026-09-02')}&to=${on('2026-09-02')}`)).data.findings.every((f) => f.visit_date === on('2026-09-02')), true);
  // CSV export is audited.
  const csv = await admin('GET', '/chart-audit/findings.csv');
  assert.match(csv.data, /Why it matters/);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'chart_audit.export'", s.pid));

  // Rules: managers only, audited with before/after, and they change what's found.
  assert.equal((await drB('PUT', '/chart-audit/rules', { checks: { consent_missing: false } })).status, 403);
  assert.equal((await admin('PUT', '/chart-audit/rules', { medical_history_days: 2 })).status, 400);
  assert.equal((await admin('PUT', '/chart-audit/rules', { checks: { consent_missing: false } })).status, 200);
  const change = await h.db.get("SELECT changes FROM audit_log WHERE practice_id = ? AND action = 'chart_audit.rules'", s.pid);
  assert.deepEqual(JSON.parse(change.changes)['check.consent_missing'], [1, 0]);
  const run = await admin('POST', '/chart-audit/run');
  assert.equal(run.status, 200);
  assert.equal((await admin('GET', '/chart-audit/findings?check=consent_missing')).data.findings.length, 0);
  assert.equal((await admin('GET', '/chart-audit/findings?check=consent_missing&status=resolved')).data.findings.length, 1);
  assert.equal((await drB('POST', '/chart-audit/run')).status, 403);

  // Acknowledge with a reason (the visit's own provider may), audited; empty reason refused.
  const f = mineB.findings.find((x) => x.status === 'open' && x.check_code !== 'consent_missing');
  assert.equal((await drB('POST', `/chart-audit/findings/${f.id}/acknowledge`, { reason: '' })).status, 400);
  assert.equal((await drB('POST', `/chart-audit/findings/${f.id}/acknowledge`, { reason: 'Documented on paper chart, scanned' })).data.status, 'acknowledged');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'chart_audit.acknowledge' AND entity_id = ? AND reason IS NOT NULL", f.id));
  assert.equal((await call(other.adminToken)('POST', `/chart-audit/findings/${f.id}/acknowledge`, { reason: 'nope nope' })).status, 404);

  // Trend by provider.
  const trend = (await admin('GET', '/chart-audit/trend?weeks=520')).data;
  assert.ok(trend.length >= 1 && trend[0].weeks[0].found >= 1);
});

test('office scope: someone limited to one office sees only that office’s findings', async () => {
  const s = await setUp();
  const db = h.db;
  const l1 = (await db.run("INSERT INTO locations (practice_id, name) VALUES (?, 'North')", s.pid)).id;
  const l2 = (await db.run("INSERT INTO locations (practice_id, name) VALUES (?, 'South')", s.pid)).id;
  const pat2 = (await s.api.post('/patients', { first_name: 'Sam', last_name: 'South', dob: '1970-01-01' })).data;
  await db.run('UPDATE patients SET location_id = ? WHERE id = ?', l1, s.patient.id);
  await db.run('UPDATE patients SET location_id = ? WHERE id = ?', l2, pat2.id);
  await s.appt({ date: '2026-09-01', location: l1 });
  await s.appt({ date: '2026-09-01', location: l2, patient: pat2.id });
  await runPracticeAudit(db, s.pid, { today: '2026-09-10' });
  await db.run('UPDATE users SET location_ids = ?, permissions_remove = NULL WHERE id = ?', JSON.stringify([l1]), s.drA.id);
  const rows = (await call(await s.drA.token)('GET', '/chart-audit/findings?all=1')).data.findings;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((f) => f.location_id === l1 && f.patient_id === s.patient.id), JSON.stringify(rows.map((r) => [r.location_id, r.patient_id])));
});

test('Check my chart → ready for doctor → doctor queue → coaching', async () => {
  const s = await setUp();
  const db = h.db;
  // The doctor's queue looks back at most 90 days from today, so these visits are recent ones (fixed dates here
  // fell out of it by December 2026); the history and perio dates keep their distance from the visit.
  const day = (base, n) => new Date(Date.parse(`${base}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const visitDay = day(new Date().toISOString().slice(0, 10), -20); // the practice is on UTC
  await db.run('UPDATE patients SET medical_reviewed_at = ? WHERE id = ?', `${day(visitDay, -17)} 10:00:00`, s.patient.id);
  await db.run('UPDATE perio_exams SET exam_date = ? WHERE patient_id = ?', day(visitDay, -92), s.patient.id);
  const a = await s.appt({ date: visitDay });
  await s.procedure({ c: 'D2391', appointmentId: a, tooth: '3', surfaces: 'O' });
  const n = await s.note({ appointmentId: a, body: 'Composite #3 O. 2 carpels of articane, infiltration. [[Shade: A1|A2]]', signed: false });
  const b = await s.appt({ date: day(visitDay, 1) });
  await s.procedure({ c: 'D1110', appointmentId: b });
  const asst = call(await s.asst.token);

  const check = await asst('POST', `/chart-audit/visits/a${a}/check`);
  assert.equal(check.status, 200, JSON.stringify(check.data));
  assert.equal(check.data.first_pass, true);
  const byCheck = Object.groupBy(check.data.items, (i) => i.check);
  assert.deepEqual(byCheck.spelling.map((i) => i.fix.replace), ['carpules', 'articaine']);
  assert.equal(byCheck.template_field[0].fix.type, 'choose');
  assert.ok(byCheck.blood_pressure);
  assert.ok(!byCheck.unsigned_note); // signing is the doctor's part
  // Can't be marked ready with items open.
  const blocked = await asst('POST', `/chart-audit/visits/a${a}/ready`, {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.details.open.length, check.data.items.length);
  // The assistant fixes the note (as the screen's one-click fixes do, through the normal note update) …
  const fixedBody = 'Composite #3 O, shade A2. 2 carpules of articaine, infiltration buccal.';
  await db.run('UPDATE clinical_notes SET body = ? WHERE id = ?', fixedBody, n);
  const second = (await asst('POST', `/chart-audit/visits/a${a}/check`)).data;
  assert.equal(second.first_pass, false);
  assert.deepEqual(second.items.map((i) => i.check), ['blood_pressure']);
  // … and says why the rest is fine.
  const ready = await asst('POST', `/chart-audit/visits/a${a}/ready`, { acknowledged: [{ check: 'blood_pressure', subject: '', reason: 'BP taken on paper, doctor to add' }] });
  assert.equal(ready.status, 201, JSON.stringify(ready.data));
  assert.equal(ready.data.first_pass_clean, 0);
  assert.ok(await db.get("SELECT id FROM audit_log WHERE action = 'chart.ready_for_doctor' AND entity_id = ?", ready.data.id));
  assert.equal((await db.get("SELECT status FROM chart_audit_findings WHERE visit_key = ? AND check_code = 'blood_pressure'", `a${a}`)).status, 'acknowledged');
  // Again: the same state, the same row.
  assert.equal((await asst('POST', `/chart-audit/visits/a${a}/ready`, { acknowledged: [{ check: 'blood_pressure', subject: '', reason: 'BP taken on paper, doctor to add' }] })).data.id, ready.data.id);

  // Visit b: note written, checked clean on the first pass.
  await s.note({ appointmentId: b, body: 'Adult prophy, scaled and polished.', signed: false });
  const clean = (await asst('POST', `/chart-audit/visits/a${b}/check`)).data;
  assert.equal(clean.problems, 0, JSON.stringify(clean.items));
  assert.equal((await asst('POST', `/chart-audit/visits/a${b}/ready`, {})).data.first_pass_clean, 1);

  // The doctor's queue: clean first, then ready with notes; who prepared each.
  const queue = (await call(await s.drA.token)('GET', '/chart-audit/doctor-queue?days=90')).data;
  const mine = queue.filter((q) => [`a${a}`, `a${b}`].includes(q.visit_key));
  assert.deepEqual(mine.map((q) => [q.visit_key, q.state, q.prepared_by]), [[`a${b}`, 'clean', 'Asst Amy'], [`a${a}`, 'ready_with_notes', 'Asst Amy']]);
  assert.match(mine[1].acknowledged[0].reason, /paper/);
  // Another provider's queue is a manager's to see.
  assert.equal((await call(await s.drB.token)('GET', `/chart-audit/doctor-queue?provider_id=${s.provider.id}`)).status, 403);
  // Not checked: a visit with a note nobody checked.
  const c = await s.appt({ date: day(visitDay, 2) });
  await s.note({ appointmentId: c, body: 'Exam.', signed: false });
  await s.procedure({ c: 'D0120', appointmentId: c });
  assert.equal((await call(await s.drA.token)('GET', '/chart-audit/doctor-queue?days=90')).data.find((q) => q.visit_key === `a${c}`).state, 'not_checked');

  // Coaching: first-pass clean rate per assistant, managers only.
  assert.equal((await asst('GET', '/chart-audit/coaching')).status, 403);
  const coach = (await call(s.adminToken)('GET', '/chart-audit/coaching')).data;
  const amy = coach.find((p) => p.name === 'Asst Amy');
  assert.deepEqual([amy.checked, amy.clean, amy.clean_rate], [2, 1, 50]);
  // Other practices can't check this visit.
  const other = await otherPractice();
  assert.equal((await call(other.adminToken)('POST', `/chart-audit/visits/a${a}/check`)).status, 404);
});

test('checkVisit on a visit with work but no appointment', async () => {
  const s = await otherPractice();
  await s.procedure({ c: 'D1110', appointmentId: null });
  const out = await checkVisit(h.db, s.pid, `d${s.patient.id}-2026-09-01`, { today: '2026-09-10' });
  assert.deepEqual(out.findings.map((f) => f.check), ['no_note']);
});
