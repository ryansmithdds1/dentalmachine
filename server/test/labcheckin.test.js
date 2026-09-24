// Lab case check-in and visit readiness (LB1–LB5, docs/workflows/specs/LB-labcheckin.md): which codes need a lab,
// auto-linking a visit to its case (and when it must be picked by hand), the late-case huddle flag with one "call the
// lab" to-do however often it runs, the check-in (photo stored encrypted and scoped, checklist required, audited,
// idempotent), the voice parser and matcher, the problem path (the doctor's to-do and live note, the note to the lab),
// lab stats, parts templates with stock set aside vs to order, and practice / office isolation and permissions.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from './helpers.js';
import labCheckinRoutes from '../src/routes/labcheckin.js';
import {
  LABCHECK_TABLES, LABCHECK_COLUMNS, labKind, parseTeeth, parseUtterance, matchUtterance, rollup, labStats, cleanChecklist, cleanSettings, caseState, sweepPractice, addDays,
} from '../src/labcheck.js';
import { listen, unlisten } from '../src/cluster.js';
import { practiceNow } from '../src/util.js';

const speech = { next: '' };
const transcriber = { mode: 'sandbox', dictation: async () => speech.next };
const h = harness({ config: { documentKey: 'labcheck-test-key' } });
const isPg = !!process.env.TEST_DATABASE_URL;

before(async () => {
  while (!h.db || !h.app) await new Promise((r) => setTimeout(r, 10));
  // Until db.js carries the tables and columns (see the hand-off), add them here. Harmless once it does.
  for (const sql of LABCHECK_TABLES) await h.db.run(isPg ? sql.replace('id INTEGER PRIMARY KEY', 'id SERIAL PRIMARY KEY') : sql);
  for (const [table, column, def] of LABCHECK_COLUMNS) {
    await h.db.run(`ALTER TABLE ${table} ADD COLUMN ${isPg ? 'IF NOT EXISTS ' : ''}${column} ${def}`).catch((e) => { if (!/duplicate column/i.test(e.message)) throw e; });
  }
  // Until app.js mounts the routes, put them in the app's /api router ahead of the other route groups.
  if (!h.app.router.stack.some((l) => l.handle?.stack?.some?.((x) => x.route?.path === '/lab-checkin'))) {
    const api = h.app.router.stack.find((l) => l.handle?.stack?.length > 40).handle;
    const at = api.stack.findIndex((l) => l.handle?.stack);
    api.use(labCheckinRoutes({ db: h.db, storage: h.app.locals.storage, config: h.config, messenger: h.messenger, transcriber }));
    api.stack.splice(at, 0, ...api.stack.splice(api.stack.length - 1, 1));
  }
});

const ALL_WEEK = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['07:00', '19:00']]]));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function office() {
  const p = await h.practice({ office_hours: ALL_WEEK });
  const today = (await practiceNow(h.db, p.practiceId ?? (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', p.patient.id)).practice_id)).slice(0, 10);
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', p.patient.id)).practice_id;
  const lab = (await p.api.post('/labs', { name: 'Glidewell', email: 'cases@lab.example.com', turnaround_days: 10 })).data;
  const visit = async (patientId, days, codes = [], extra = {}) => {
    const procs = [];
    for (const c of codes) procs.push((await p.api.post(`/patients/${patientId}/procedures`, { provider_id: p.provider.id, ...c })).data);
    const d = addDays(today, days);
    const a = await p.api.post('/appointments', { patient_id: patientId, provider_id: p.provider.id, start_time: `${d} 10:00`, end_time: `${d} 11:00`, procedure_ids: procs.map((x) => x.id), ...extra });
    assert.equal(a.status, 201, JSON.stringify(a.data));
    return { ...a.data, procs };
  };
  const labCase = async (patientId, body) => {
    const r = await p.api.post('/lab-cases', { patient_id: patientId, provider_id: p.provider.id, lab_id: lab.id, description: 'Zirconia crown', ...body });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  const readiness = async (date = today, to = addDays(today, 6)) => (await p.api.get(`/visit-readiness?date=${date}&to=${to}`)).data;
  return { ...p, pid, today, lab, visit, labCase, readiness };
}
async function staff(api, role, extra = {}) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = (await api.post('/users', { email, name: `${role} person`, role, password: `${role}-password-123`, ...extra })).data;
  return { id: u.id, api: h.client((await h.client().post('/auth/login', { email, password: `${role}-password-123` })).data.token) };
}
const upload = (token, query, body = PNG, type = 'image/png') => fetch(`${h.origin}/api/lab-checkin/photos?${new URLSearchParams(query)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body })
  .then(async (r) => ({ status: r.status, data: await r.json() }));
const ALL_GOOD = { right_patient: true, matches_rx: true, shade: true, margins: true, no_cracks: true, all_parts: true };

// ---- Pure rules ----
test('which codes need a lab: crowns, bridges, dentures, partials, night guards, implant crowns — not fillings or implant placement', () => {
  for (const [code, kind] of [['D2740', 'crown'], ['D2750', 'crown'], ['D6240', 'bridge'], ['D6750', 'bridge'], ['D5110', 'denture'], ['D5120', 'denture'], ['D5213', 'partial'],
    ['D9944', 'night_guard'], ['D9946', 'night_guard'], ['D6065', 'implant_crown'], ['D6058', 'implant_crown'], ['D2962', 'veneer'], ['D2644', 'inlay']]) assert.equal(labKind(code), kind, code);
  for (const code of ['D2391', 'D6010', 'D1110', 'D0120', 'D2950', 'D9940', 'D7140']) assert.equal(labKind(code), null, code);
  assert.deepEqual([...parseTeeth('#3, 4-6')], ['3', '4', '5', '6']);
  assert.deepEqual([...parseTeeth('30')], ['30']);
  assert.deepEqual([...parseTeeth('U')], []);
});

test('voice parser: "number 30", "tooth #3", "upper denture", "shade A2", looks good vs "margin is open", parts', () => {
  const a = parseUtterance('Lab case is in for Maria Lopez — crown for number 30, shade A2, looks good');
  assert.deepEqual([a.patient_words, a.teeth, a.kind, a.shade, a.verdict], [['maria', 'lopez'], ['30'], 'crown', 'A2', 'ok']);
  assert.ok(Object.values(a.checklist).every(Boolean) && Object.keys(a.checklist).length === 6, 'looks good ticks the whole checklist');
  const b = parseUtterance('The crown on tooth #3 for John Smith, the margin is open');
  assert.deepEqual([b.teeth, b.verdict, b.problem_kind, b.checklist.margins], [['3'], 'problem', 'remake', false]);
  assert.deepEqual(b.problems, ['Margin is open']);
  const c = parseUtterance('upper denture for Ann Lee is here, looks great');
  assert.deepEqual([c.kind, c.arch, c.teeth, c.verdict], ['denture', 'U', [], 'ok']);
  assert.equal(parseUtterance('shade A2 crown number thirty for Maria').teeth[0], '30', 'number words');
  assert.deepEqual(parseUtterance('shade A2 crown for Maria').teeth, [], 'the 2 of A2 is not a tooth');
  assert.equal(parseUtterance('shade b 1 for Maria').shade, 'B1');
  const d = parseUtterance('looks good but the contact is open on 19');
  assert.deepEqual([d.verdict, d.problem_kind, d.teeth], ['problem', 'adjust', ['19']], 'a problem said anywhere wins');
  const e = parseUtterance('crown for Maria Lopez, no cracks, looks good');
  assert.equal(e.verdict, 'ok', '"no cracks" is not a crack');
  const f = parseUtterance('crown for Maria Lopez is chipped');
  assert.deepEqual([f.verdict, f.checklist.no_cracks], ['problem', false]);
  assert.equal(parseUtterance('crown for Maria Lopez is in').verdict, null, 'no verdict: the person is asked');
  const g = parseUtterance('implant parts for Maria are in — Nobel 4.3 by 10, looks good');
  assert.deepEqual(g.part, { part: 'fixture', brand: 'Nobel', platform: null, diameter: 4.3, length: 10 });
  assert.deepEqual([g.teeth, g.verdict, g.patient_words], [[], 'ok', ['maria']], 'the 10 of 4.3 by 10 is not a tooth');
  assert.equal(parseUtterance('Straumann healing abutment for Bob Ray is here').part.part, 'healing_abutment');
  assert.equal(parseUtterance('scan body for Bob').part.part, 'scan_body');
  assert.deepEqual(parseUtterance('teeth 3 through 5 bridge for Ann').teeth, ['3', '4', '5']);
});

test('matching: name + tooth + kind; two cases that fit equally are ambiguous (the person picks); always needs a confirm', () => {
  const cases = [
    { type: 'lab_case', id: 1, first_name: 'Maria', last_name: 'Lopez', tooth: '30', description: 'Zirconia crown', shade: 'A2' },
    { type: 'lab_case', id: 2, first_name: 'Maria', last_name: 'Lopez', tooth: '31', description: 'Zirconia crown' },
    { type: 'lab_case', id: 3, first_name: 'John', last_name: 'Smith', tooth: '30', description: 'PFM crown' },
    { type: 'lab_case', id: 4, first_name: 'Ann', last_name: 'Lee', tooth: null, description: 'Upper denture' },
  ];
  const m = matchUtterance(parseUtterance('crown for Maria Lopez number 30 looks good'), cases);
  assert.deepEqual([m.best.id, m.ambiguous, m.confident, m.needs_confirm], [1, false, true, true]);
  const amb = matchUtterance(parseUtterance('crown for Maria Lopez looks good'), cases);
  assert.equal(amb.ambiguous, true);
  assert.deepEqual(amb.candidates.slice(0, 2).map((c) => c.id).sort(), [1, 2]);
  assert.equal(matchUtterance(parseUtterance('crown number 30 looks good'), cases).ambiguous, true, 'no name: never confident');
  assert.equal(matchUtterance(parseUtterance('upper denture for Ann Lee looks good'), cases).best.id, 4);
  assert.equal(matchUtterance(parseUtterance('crown for Nobody Atall'), cases).best, null);
  const parts = [{ type: 'part', id: 9, first_name: 'Maria', last_name: 'Lopez', item_name: 'Implant fixture', details: { part: 'fixture', brand: 'Nobel', diameter: 4.3, length: 10 } }, ...cases];
  const p = matchUtterance(parseUtterance('implant parts for Maria Lopez are in — Nobel 4.3 by 10, looks good'), parts);
  assert.equal(p.best.id, 9);
});

test('readiness rollup, case states, checklist and settings validation, lab stats math', () => {
  assert.equal(rollup([]), null);
  assert.equal(rollup(['checked', 'set_aside']), 'ready');
  assert.equal(rollup(['checked', 'arrived']), 'arrived');
  assert.equal(rollup(['checked', 'in_production']), 'waiting');
  assert.equal(rollup(['sent', 'late']), 'late');
  assert.equal(rollup(['checked', 'to_order']), 'missing');
  assert.equal(rollup(['late', 'problem', 'needed']), 'problem');
  const T = '2030-03-10';
  assert.equal(caseState({ status: 'sent', due_date: '2030-03-09' }, '2030-03-12', T), 'late');
  assert.equal(caseState({ status: 'sent', due_date: '2030-03-12' }, '2030-03-12', T), 'late', 'promised back the day of the visit');
  assert.equal(caseState({ status: 'sent', due_date: '2030-03-11' }, '2030-03-14', T), 'due');
  assert.equal(caseState({ status: 'sent', due_date: '2030-03-20', lab_status: 'in_production' }, '2030-03-25', T), 'in_production');
  assert.equal(caseState({ status: 'received' }, '2030-03-25', T), 'arrived');
  assert.equal(caseState({ status: 'received', check_status: 'checked' }, '2030-03-25', T), 'checked');
  assert.equal(caseState({ status: 'received', check_status: 'problem' }, '2030-03-25', T), 'problem');
  assert.throws(() => cleanChecklist({ ...ALL_GOOD, shade: undefined }, 'ok'), /Answer every checklist item \(Shade is right\)/);
  assert.throws(() => cleanChecklist({ ...ALL_GOOD, margins: false }, 'ok'), /note the problem/);
  assert.deepEqual(cleanChecklist({ ...ALL_GOOD, margins: false }, 'problem').margins, false);
  assert.throws(() => cleanSettings({ days_ahead: 99 }), /0–30/);
  assert.throws(() => cleanSettings({ templates: { X1: [] } }), /isn't a procedure code/);
  assert.throws(() => cleanSettings({ templates: { D6010: [{ name: '' }] } }), /needs a name/);
  assert.equal(cleanSettings({}).templates.D6010.length, 3);

  const rows = [
    // Lab A: 3 received — 8, 12 and 10 days (promised 10 each): one late; one remade.
    { lab_id: 1, lab_name: 'A', sent_date: '2030-01-01', promised_date: '2030-01-11', received_date: '2030-01-09', status: 'received' },
    { lab_id: 1, lab_name: 'A', sent_date: '2030-01-01', promised_date: '2030-01-11', received_date: '2030-01-13', status: 'received', remade: true, problem: true },
    { lab_id: 1, lab_name: 'A', sent_date: '2030-01-01', promised_date: '2030-01-11', due_date: '2030-01-20', received_date: '2030-01-11', status: 'delivered' },
    // …and one still out past its date.
    { lab_id: 1, lab_name: 'A', sent_date: '2030-02-01', due_date: '2030-02-05', status: 'sent' },
    { lab_id: 2, lab_name: 'B', sent_date: '2030-01-01', due_date: '2030-01-08', received_date: '2030-01-08', status: 'received', problem: true },
  ];
  const [a, b] = labStats(rows, '2030-03-01');
  assert.deepEqual(a, { lab_id: 1, lab_name: 'A', cases: 4, received: 3, avg_turnaround_days: 10, avg_promised_days: 10, late: 1, late_pct: 33, remakes: 1, remake_pct: 33, problems: 1, open_late: 1 });
  assert.deepEqual([b.lab_name, b.received, b.late_pct, b.remake_pct, b.problems, b.avg_turnaround_days], ['B', 1, 0, 0, 1, 7]);
});

// ---- With the database and the routes ----
test('LB1 auto-link: the one open case for the tooth links itself; two that fit must be picked; the case named on the visit links too', async () => {
  const o = await office();
  const { api, patient } = o;
  const c30 = await o.labCase(patient.id, { tooth: '30', due_date: addDays(o.today, 1) });
  await o.labCase(patient.id, { tooth: '19', due_date: addDays(o.today, 1) }); // another tooth: not linked
  const v = await o.visit(patient.id, 5, [{ code: 'D2740', tooth: '30' }, { code: 'D1110' }]);
  let r = await o.readiness();
  const items = r.byAppt[v.id].items;
  assert.equal(items.length, 1, 'one lab item; the cleaning needs nothing');
  assert.match(items[0].name, /Zirconia crown #30/);
  const row = await h.db.get('SELECT * FROM visit_requirements WHERE appointment_id = ?', v.id);
  assert.deepEqual([row.lab_case_id, row.status, row.source], [c30.id, 'linked', 'auto']);
  assert.match(row.reason, /only open case for tooth #30/);
  assert.equal((await h.db.get('SELECT appointment_id, promised_date FROM lab_cases WHERE id = ?', c30.id)).appointment_id, v.id, 'the case now names its seat visit');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'visit_requirement.auto_link' AND entity_id = ? AND source = 'automation'", row.id));
  // Loading again changes nothing (idempotent).
  await o.readiness();
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM visit_requirements WHERE appointment_id = ?', v.id)).n), 1);

  // Two open cases for #3: nothing is guessed — the visit asks for the case to be picked.
  const p2 = (await api.post('/patients', { first_name: 'Two', last_name: 'Cases', dob: '1970-01-01' })).data;
  const x1 = await o.labCase(p2.id, { tooth: '3', description: 'PFM crown' });
  await o.labCase(p2.id, { tooth: '3', description: 'Zirconia crown' });
  const v2 = await o.visit(p2.id, 6, [{ code: 'D2750', tooth: '3' }]);
  r = await o.readiness();
  assert.equal(r.byAppt[v2.id].state, 'missing');
  const detail = (await api.get(`/visit-readiness/appointments/${v2.id}`)).data;
  assert.equal(detail.items[0].state, 'choose');
  assert.equal(detail.items[0].choices.length, 2);
  // Manual link fills that line.
  const link = await api.post('/visit-requirements', { appointment_id: v2.id, lab_case_id: x1.id, requirement_id: detail.items[0].id });
  assert.equal(link.status, 201, JSON.stringify(link.data));
  assert.deepEqual([link.data.items.length, link.data.items[0].lab_case_id], [1, x1.id]);
  // Another patient's case can't be linked.
  const other = await o.labCase(patient.id, { tooth: '2' });
  assert.equal((await api.post('/visit-requirements', { appointment_id: v2.id, lab_case_id: other.id })).status, 400);
  // A case that already names another upcoming visit: moving it needs a yes.
  assert.equal((await api.post('/visit-requirements', { appointment_id: v2.id, lab_case_id: c30.id })).status, 400, 'and it is another patient’s');

  // A denture visit (no tooth) links the patient's one open upper denture; the office can name the visit on the case.
  const p3 = (await api.post('/patients', { first_name: 'Den', last_name: 'Ture', dob: '1950-01-01' })).data;
  const upper = await o.labCase(p3.id, { description: 'Upper denture, wax try-in', tooth: null });
  const lower = await o.labCase(p3.id, { description: 'Lower denture' });
  const v3 = await o.visit(p3.id, 4, [{ code: 'D5110', area: 'U' }]);
  const nightGuard = await o.labCase(p3.id, { description: 'Night guard' });
  await api.put(`/lab-cases/${nightGuard.id}`, { appointment_id: v3.id });
  r = await o.readiness();
  const linked = (await h.db.all("SELECT lab_case_id FROM visit_requirements WHERE appointment_id = ? AND status != 'cancelled' ORDER BY lab_case_id", v3.id)).map((x) => x.lab_case_id);
  assert.deepEqual(linked, [upper.id, nightGuard.id].sort((a, b) => a - b));
  assert.ok(!linked.includes(lower.id), 'the lower denture is not for a D5110');
  // "Made in the office" (no lab): not needed, with a reason.
  const p4 = (await api.post('/patients', { first_name: 'Cerec', last_name: 'Crown', dob: '1960-01-01' })).data;
  const v4 = await o.visit(p4.id, 3, [{ code: 'D2740', tooth: '14' }]);
  const d4 = (await api.get(`/visit-readiness/appointments/${v4.id}`)).data;
  assert.equal(d4.items[0].state, 'needed');
  assert.equal((await api.put(`/visit-requirements/${d4.items[0].id}`, { status: 'cancelled' })).status, 400, 'a reason is required');
  const cancelled = await api.put(`/visit-requirements/${d4.items[0].id}`, { status: 'cancelled', reason: 'Milled in the office' });
  assert.deepEqual(cancelled.data.items, []);
  assert.equal((await o.readiness()).byAppt[v4.id], undefined, 'nothing needed: no badge');
});

test('LB1 late case → huddle flag and ONE "call the lab" to-do however often it runs; checking it in closes the to-do', async () => {
  const o = await office();
  const { api, patient } = o;
  const c = await o.labCase(patient.id, { tooth: '19', due_date: addDays(o.today, -1) });
  const v = await o.visit(patient.id, 2, [{ code: 'D2740', tooth: '19' }]);
  const far = await o.visit(patient.id, 10, [{ code: 'D2740', tooth: '20' }]);
  const huddle = (await api.get('/visit-readiness/huddle')).data;
  assert.equal(huddle.days_ahead, 3);
  const row = huddle.rows.find((x) => x.appointment_id === v.id);
  assert.equal(row.state, 'late');
  assert.equal(row.patient_name, 'Jane Doe');
  assert.ok(!huddle.rows.some((x) => x.appointment_id === far.id), 'beyond N days: not in the huddle');
  const tasks = async () => (await h.db.all("SELECT * FROM tasks WHERE practice_id = ? AND title LIKE 'Call the lab%' AND status = 'open'", o.pid));
  assert.equal((await tasks()).length, 1);
  assert.match((await tasks())[0].title, /Call the lab \(Glidewell\): Jane Doe's Zirconia crown #19 is late \(due \d{4}-\d{2}-\d{2}\) — visit/);
  assert.equal((await tasks())[0].priority, 'high');
  await api.get('/visit-readiness/huddle');
  await sweepPractice(h.db, o.pid);
  await Promise.all([sweepPractice(h.db, o.pid), sweepPractice(h.db, o.pid)]);
  assert.equal((await tasks()).length, 1, 'idempotent');
  // No lab case at all for a visit in the window → its own to-do.
  const p2 = (await api.post('/patients', { first_name: 'No', last_name: 'Case', dob: '1970-01-01' })).data;
  await o.visit(p2.id, 1, [{ code: 'D6240', tooth: '4' }]);
  await sweepPractice(h.db, o.pid);
  assert.ok(await h.db.get("SELECT id FROM tasks WHERE practice_id = ? AND title LIKE 'No lab case for No Case''s Bridge #4%'", o.pid));
  // The window is a setting.
  assert.equal((await api.put('/visit-readiness/settings', { days_ahead: 12 })).status, 200);
  assert.ok((await api.get('/visit-readiness/huddle')).data.rows.some((x) => x.appointment_id === far.id));
  // Checked in: the card turns green and the to-do is done.
  const ok = await api.post('/lab-checkin', { lab_case_id: c.id, verdict: 'ok', checklist: ALL_GOOD });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal((await tasks()).filter((t) => t.title.includes('#19')).length, 0);
  assert.equal((await o.readiness()).byAppt[v.id].state, 'ready');
});

test('LB2 check-in: photo stored encrypted, filed on the visit, scoped to the patient; checklist required; audited; a repeat does nothing twice', async () => {
  const o = await office();
  const { api, patient, token } = o;
  const other = await office();
  const c = await o.labCase(patient.id, { tooth: '30', shade: 'A2', due_date: addDays(o.today, 1) });
  const v = await o.visit(patient.id, 3, [{ code: 'D2740', tooth: '30' }]);
  const due = (await o.readiness()).byAppt[v.id];
  assert.deepEqual([due.state, due.items[0].state], ['waiting', 'due']);

  const photo = await upload(token, { lab_case_id: c.id, filename: 'case.png' });
  assert.equal(photo.status, 201, JSON.stringify(photo.data));
  const doc = await h.db.get('SELECT * FROM documents WHERE id = ?', photo.data.id);
  assert.deepEqual([doc.patient_id, doc.category, doc.appointment_id, doc.tooth, doc.encrypted, doc.source], [patient.id, 'photo', v.id, '30', 1, 'lab-checkin']);
  // What's on disk isn't the picture.
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
  walk(h.config.uploadDir);
  assert.ok(files.length && files.every((f) => !readFileSync(f).includes(PNG.subarray(8, 24))), 'encrypted at rest');
  assert.equal((await upload(token, { lab_case_id: c.id, filename: 'notes.txt' }, Buffer.from('hello'), 'text/plain')).status, 415, 'photos only');
  assert.equal((await upload(other.token, { lab_case_id: c.id })).status, 404, 'another practice');
  const theirs = await other.labCase(other.patient.id, { tooth: '30' });
  const theirPhoto = await upload(other.token, { lab_case_id: theirs.id });
  assert.equal(theirPhoto.status, 201);

  // The checklist must be answered; "Looks good" needs every item; a problem needs a note.
  const bad = [
    [{ lab_case_id: c.id, verdict: 'ok', checklist: { ...ALL_GOOD, shade: null } }, /Answer every checklist item/],
    [{ lab_case_id: c.id, verdict: 'ok', checklist: { ...ALL_GOOD, no_cracks: false } }, /note the problem/],
    [{ lab_case_id: c.id, verdict: 'problem', checklist: { ...ALL_GOOD, margins: false } }, /Say what’s wrong/],
    [{ lab_case_id: c.id, verdict: 'maybe', checklist: ALL_GOOD }, /verdict/],
    [{ lab_case_id: c.id, verdict: 'ok', checklist: ALL_GOOD, photo_ids: [theirPhoto.data.id] }, /Photos must be of this patient/],
    [{ verdict: 'ok', checklist: ALL_GOOD }, /Pick the case/],
  ];
  for (const [body, re] of bad) {
    const r = await api.post('/lab-checkin', body);
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, re);
  }
  assert.equal((await other.api.post('/lab-checkin', { lab_case_id: c.id, verdict: 'ok', checklist: ALL_GOOD })).status, 404, 'practice isolation');

  const body = { lab_case_id: c.id, verdict: 'ok', checklist: ALL_GOOD, photo_ids: [photo.data.id], key: 'chk-1' };
  const first = await api.post('/lab-checkin', body);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const again = await api.post('/lab-checkin', body);
  assert.equal(again.data.id, first.data.id);
  assert.equal(again.data.repeat, true);
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM lab_checkins WHERE lab_case_id = ?', c.id)).n), 1);
  const after = await h.db.get('SELECT * FROM lab_cases WHERE id = ?', c.id);
  assert.deepEqual([after.status, after.check_status, after.received_date, after.appointment_id], ['received', 'checked', o.today, v.id]);
  assert.equal(first.data.appointment_id, v.id);
  assert.deepEqual(first.data.photo_ids, [photo.data.id]);
  const log = await h.db.get("SELECT * FROM audit_log WHERE action = 'lab_checkin.ok' AND entity_id = ?", c.id);
  assert.equal(log.source, 'human');
  assert.equal(log.patient_id, patient.id);
  assert.match(log.changes, /"check_status":\[null,"checked"\]/);
  assert.equal((await o.readiness()).byAppt[v.id].state, 'ready');
  // The slip's QR code and the lab's own link find the case; another practice's code doesn't.
  assert.equal((await api.get(`/lab-checkin/lookup?code=DM-LAB-${c.id}`)).data.id, c.id);
  assert.equal((await other.api.get(`/lab-checkin/lookup?code=DM-LAB-${c.id}`)).status, 404);
  const sent = await api.post(`/lab-cases/${c.id}/send`, { rx: { shade: 'A2' } });
  assert.equal((await api.get(`/lab-checkin/lookup?code=${encodeURIComponent(sent.data.link)}`)).data.id, c.id);
  // Due this week lists open cases for checking in.
  const c2 = await o.labCase(patient.id, { tooth: '3', due_date: addDays(o.today, 4) });
  const dueList = (await api.get('/lab-checkin/due')).data;
  assert.ok(dueList.cases.some((x) => x.id === c2.id));
  assert.ok(!dueList.cases.some((x) => x.id === c.id), 'checked cases drop off');
  assert.ok(!dueList.cases.some((x) => x.id === theirs.id));
});

test('LB3 voice: transcribed (sandbox), matched to the case and visit, checklist prefilled — nothing saved until confirmed', async () => {
  const o = await office();
  const { api } = o;
  const maria = (await api.post('/patients', { first_name: 'Maria', last_name: 'Lopez', dob: '1980-02-02' })).data;
  const c30 = await o.labCase(maria.id, { tooth: '30', shade: 'A3', due_date: addDays(o.today, 2) });
  const c31 = await o.labCase(maria.id, { tooth: '31', due_date: addDays(o.today, 2) });
  const v = await o.visit(maria.id, 3, [{ code: 'D2740', tooth: '30' }]);
  speech.next = 'Lab case is in for Maria Lopez — crown for number 30, shade A2, looks good';
  const heard = await fetch(`${h.origin}/api/lab-checkin/voice`, { method: 'POST', headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'audio/webm' }, body: Buffer.from('fake-audio') }).then((r) => r.json());
  assert.equal(heard.text, speech.next);
  assert.deepEqual([heard.match.id, heard.match.patient, heard.ambiguous, heard.needs_confirm, heard.verdict], [c30.id, 'Maria Lopez', false, true, 'ok']);
  assert.equal(heard.checklist.shade, false, 'said A2, the Rx says A3: flagged, not trusted');
  assert.deepEqual(heard.warnings, ['You said shade A2; the Rx says A3']);
  assert.equal(await h.db.get('SELECT id FROM lab_checkins WHERE lab_case_id = ?', c30.id), undefined, 'nothing saved');
  // Ambiguous: two of Maria's crowns, no tooth said.
  const amb = (await api.post('/lab-checkin/parse', { text: 'crown for Maria Lopez looks good' })).data;
  assert.equal(amb.ambiguous, true);
  assert.match(amb.question, /More than one case/);
  assert.deepEqual(amb.candidates.map((x) => x.id).sort(), [c30.id, c31.id].sort());
  const unknown = (await api.post('/lab-checkin/parse', { text: 'the crown for Zed Quux' })).data;
  assert.equal(unknown.match, null);
  // The confirm is a normal check-in, recorded as said by voice.
  const ok = await api.post('/lab-checkin', { lab_case_id: c30.id, verdict: 'ok', checklist: ALL_GOOD, via: 'voice', transcript: speech.next, appointment_id: v.id });
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.data.via, ok.data.transcript], ['voice', speech.next]);
  // The assistant can prefill but can't check in without the person's OK.
  const ai = h.client(o.token, { 'X-Acting-For': 'assistant' });
  assert.equal((await ai.post('/lab-checkin/parse', { text: 'crown for Maria Lopez 31 looks good' })).status, 200);
  assert.equal((await ai.post('/lab-checkin', { lab_case_id: c31.id, verdict: 'ok', checklist: ALL_GOOD })).status, 428);
  // Empty speech is a clear message; no speech service is a 409 in production (browser speech is used).
  speech.next = '   ';
  assert.equal((await fetch(`${h.origin}/api/lab-checkin/voice`, { method: 'POST', headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'audio/webm' }, body: Buffer.from('x') })).status, 422);
});

test('LB4 problem: the doctor gets a to-do and a live note, a note to the lab is drafted and sent once, the visit can be moved; lab stats count it', async () => {
  const o = await office();
  const { api, patient } = o;
  const doc = await staff(api, 'dentist');
  await api.put(`/providers/${o.provider.id}`, { user_id: doc.id });
  const c = await o.labCase(patient.id, { tooth: '30', due_date: addDays(o.today, 1), sent_date: addDays(o.today, -9) });
  const v = await o.visit(patient.id, 2, [{ code: 'D2740', tooth: '30' }]);
  await o.readiness();
  const photo = await upload(o.token, { lab_case_id: c.id });
  const events = [];
  const onEvent = (e) => events.push(e);
  listen(`practice:${o.pid}`, onEvent);
  const r = await api.post('/lab-checkin', { lab_case_id: c.id, verdict: 'problem', checklist: { ...ALL_GOOD, margins: false }, problem_kind: 'remake', problem_note: 'Margin is open on the distal', photo_ids: [photo.data.id] });
  unlisten(`practice:${o.pid}`, onEvent);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.notified.user_id, doc.id);
  const task = await h.db.get('SELECT * FROM tasks WHERE id = ?', r.data.notified.task_id);
  assert.deepEqual([task.assigned_to, task.priority], [doc.id, 'high']);
  assert.match(task.title, /Lab case problem — Jane Doe, Zirconia crown #30: Margin is open on the distal \(visit .+\)\. Remake, adjust or move the visit\?/);
  const live = events.find((e) => e.type === 'lab_checkin');
  assert.deepEqual([live.verdict, live.notify_user_id, live.lab_case_id], ['problem', doc.id, c.id]);
  assert.ok(!JSON.stringify(live).includes('Jane'), 'live events carry ids only');
  assert.equal((await o.readiness()).byAppt[v.id].state, 'problem');
  assert.match(r.data.next.lab_message, /Case #\d+ — Jane Doe — Zirconia crown #30/);
  assert.match(r.data.next.lab_message, /Please remake it — the patient is scheduled/);
  assert.deepEqual(r.data.next.move_visit, { appointment_id: v.id, date: addDays(o.today, 2), after: addDays(o.today, 1) });
  assert.ok(JSON.parse((await h.db.get('SELECT document_ids FROM lab_cases WHERE id = ?', c.id)).document_ids).includes(photo.data.id), 'the lab sees our photo');
  // Sent to the lab (a person's click), once.
  const before = h.sent.length;
  const send = await api.post(`/lab-checkin/${r.data.id}/lab-message`, { kind: 'remake', message: r.data.next.lab_message, new_due_date: addDays(o.today, 8) });
  assert.equal(send.status, 200, JSON.stringify(send.data));
  assert.equal(send.data.emailed, true);
  assert.equal(h.sent.length, before + 1);
  assert.match(h.sent.at(-1).subject, /Remake needed: case #\d+/);
  assert.ok(h.sent.at(-1).body.includes('/lab/'));
  assert.equal((await api.post(`/lab-checkin/${r.data.id}/lab-message`, { kind: 'remake', message: 'again' })).data.repeat, true);
  assert.equal(h.sent.length, before + 1);
  const back = await h.db.get('SELECT * FROM lab_cases WHERE id = ?', c.id);
  assert.deepEqual([back.status, back.due_date], ['returned_for_adjustment', addDays(o.today, 8)]);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'lab_case.return_to_lab' AND entity_id = ?", c.id));
  // An OK check can't be sent back; the AI can't send it without a yes.
  const ai = h.client(o.token, { 'X-Acting-For': 'assistant' });
  assert.equal((await ai.post(`/lab-checkin/${r.data.id}/lab-message`, { message: 'x' })).status, 428);

  // Lab stats: this lab had one case received (a remake), 9 days after sending, promised in 10.
  const stats = (await api.get('/lab-checkin/stats')).data.labs;
  const g = stats.find((s) => s.lab_name === 'Glidewell');
  assert.deepEqual([g.cases, g.received, g.remakes, g.remake_pct, g.late_pct, g.avg_turnaround_days, g.avg_promised_days], [1, 1, 1, 100, 0, 9, 10]);
  assert.deepEqual((await (await office()).api.get('/lab-checkin/stats')).data.labs, [], 'another practice sees none of it');
});

test('LB5 parts: templates prefill a visit, stock is set aside when on the shelf, otherwise to order; one badge for lab + parts', async () => {
  const o = await office();
  const { api } = o;
  const maria = (await api.post('/patients', { first_name: 'Maria', last_name: 'Lopez', dob: '1980-02-02' })).data;
  const bob = (await api.post('/patients', { first_name: 'Bob', last_name: 'Ray', dob: '1981-02-02' })).data;
  const heal = (await api.post('/inventory', { name: 'Healing abutment 4.5 × 3', on_hand: 1, category: 'Implant' })).data;
  // The office links the healing abutment in the D6010 template to its stock item.
  const s = await api.put('/visit-readiness/settings', { templates: { D6010: [{ name: 'Implant fixture', part: 'fixture', details: true }, { name: 'Healing abutment', part: 'healing_abutment', inventory_item_id: heal.id }, { name: 'Bone graft', part: 'graft' }] } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const v1 = await o.visit(maria.id, 2, [{ code: 'D6010', tooth: '30' }]);
  const v2 = await o.visit(bob.id, 3, [{ code: 'D6010', tooth: '19' }]);
  const r = await o.readiness();
  const d1 = (await api.get(`/visit-readiness/appointments/${v1.id}`)).data;
  assert.deepEqual(d1.items.map((i) => [i.name, i.state]), [['Implant fixture', 'to_order'], ['Healing abutment', 'set_aside'], ['Bone graft', 'to_order']]);
  assert.match(d1.items[1].reason, /Set aside from stock \(0 each left free\)/);
  const d2 = (await api.get(`/visit-readiness/appointments/${v2.id}`)).data;
  assert.equal(d2.items[1].state, 'to_order', 'the one on the shelf is already set aside for Maria');
  assert.match(d2.items[1].reason, /Only 0 each free on the shelf — order 1/);
  assert.equal(r.byAppt[v1.id].state, 'missing');
  assert.equal((await h.db.get('SELECT on_hand FROM inventory_items WHERE id = ?', heal.id)).on_hand, 1, 'set aside is a reservation, not a use');
  // Loading again doesn't add the template twice.
  await o.readiness();
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM visit_requirements WHERE appointment_id = ?', v1.id)).n), 3);
  // The fixture's size, then ordered; the to-order list; the graft isn't needed for this one.
  const fx = d1.items[0];
  assert.equal((await api.put(`/visit-requirements/${fx.id}`, { details: { brand: 'Nobel', platform: 'RP', diameter: 4.3, length: 10 }, status: 'ordered' })).status, 200);
  assert.equal((await api.put(`/visit-requirements/${fx.id}`, { details: { diameter: 400 } })).status, 400);
  assert.equal((await api.put(`/visit-requirements/${fx.id}`, { status: 'checked' })).status, 400, 'checking in is done by the check-in');
  await api.put(`/visit-requirements/${d1.items[2].id}`, { status: 'cancelled', reason: 'No graft planned' });
  const toOrder = (await api.get('/visit-requirements/to-order')).data;
  assert.ok(toOrder.some((x) => x.id === d2.items[1].id && x.stock.available === 0 && x.stock.reserved === 1));
  assert.ok(toOrder.some((x) => x.id === fx.id && x.status === 'ordered' && x.details.brand === 'Nobel'));
  // Parts arrive: said out loud, matched to Maria's fixture; checked in by a person.
  const heard = (await api.post('/lab-checkin/parse', { text: 'implant parts for Maria are in — Nobel 4.3 by 10, looks good' })).data;
  assert.deepEqual([heard.match?.type, heard.match?.id, heard.verdict], ['part', fx.id, 'ok']);
  const ok = await api.post('/lab-checkin', { requirement_id: fx.id, verdict: 'ok', checklist: ALL_GOOD, via: 'voice' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal((await o.readiness()).byAppt[v1.id].state, 'ready', 'fixture checked + healing abutment set aside + graft not needed');
  // A part added by hand, linked to a stock item with enough on the shelf.
  const burs = (await api.post('/inventory', { name: 'Surgical bur kit', on_hand: 2 })).data;
  const added = await api.post('/visit-requirements', { appointment_id: v2.id, kind: 'part', item_name: 'Surgical bur kit', inventory_item_id: burs.id, qty: 2, key: 'burs-1' });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.equal(added.data.items.find((i) => i.name === 'Surgical bur kit').state, 'set_aside');
  const repeat = await api.post('/visit-requirements', { appointment_id: v2.id, kind: 'part', item_name: 'Surgical bur kit', inventory_item_id: burs.id, qty: 2, key: 'burs-1' });
  assert.equal(repeat.data.items.filter((i) => i.name === 'Surgical bur kit').length, 1, 'the same request twice adds it once');
  // The lab case and the parts roll up into one badge: a crown case in production keeps the visit "waiting".
  await o.labCase(bob.id, { tooth: '19', description: 'Implant crown', due_date: addDays(o.today, 1) });
  await api.post(`/patients/${bob.id}/procedures`, { code: 'D6065', tooth: '19', provider_id: o.provider.id }).then((p) => api.put(`/procedures/${p.data.id}`, { appointment_id: v2.id }));
  const combo = (await o.readiness()).byAppt[v2.id];
  assert.ok(combo.items.some((i) => i.kind === 'lab_case') && combo.items.some((i) => i.kind === 'part'));
  assert.equal(combo.state, 'missing', 'the worst item wins');
});

test('permissions, office limits and settings', async () => {
  const o = await office();
  const { api, patient } = o;
  const west = (await api.post('/locations', { name: 'Westside', office_hours: ALL_WEEK })).data;
  const main = (await api.post('/locations', { name: 'Main St', office_hours: ALL_WEEK })).data;
  const c = await o.labCase(patient.id, { tooth: '30' });
  const v = await o.visit(patient.id, 2, [{ code: 'D2740', tooth: '30' }], { location_id: main.id });
  await h.db.run('UPDATE patients SET location_id = ? WHERE id = ?', main.id, patient.id);
  const desk = await staff(api, 'front_desk');
  const billing = await staff(api, 'billing');
  const westie = await staff(api, 'assistant', { location_ids: [west.id] });
  const assistant = await staff(api, 'assistant');
  // Front desk sees the badges (clinical:read) but doesn't do the clinical check.
  assert.equal((await desk.api.get(`/visit-readiness?date=${o.today}&to=${addDays(o.today, 6)}`)).data.byAppt[v.id].state, 'late', 'due back (sent today + the lab’s 10 days) after the visit');
  assert.equal((await desk.api.post('/lab-checkin', { lab_case_id: c.id, verdict: 'ok', checklist: ALL_GOOD })).status, 403);
  assert.equal((await billing.api.post('/lab-checkin/parse', { text: 'crown for Jane' })).status, 403);
  assert.equal((await assistant.api.put('/visit-readiness/settings', { days_ahead: 5 })).status, 403, 'administrators change settings');
  assert.equal((await api.put('/visit-readiness/settings', { days_ahead: 45 })).status, 400);
  assert.equal((await api.put('/visit-readiness/settings', { days_ahead: 5 })).status, 200);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'visit_readiness.settings' AND practice_id = ? AND changes LIKE '%days_ahead%'", o.pid));
  // Someone limited to another office doesn't see this visit or its case.
  const theirs = (await westie.api.get(`/visit-readiness?date=${o.today}&to=${addDays(o.today, 6)}`)).data;
  assert.equal(theirs.byAppt[v.id], undefined);
  assert.equal((await westie.api.get(`/visit-readiness/appointments/${v.id}`)).status, 404);
  assert.equal((await westie.api.get(`/lab-checkin/lookup?code=DM-LAB-${c.id}`)).status, 404);
  assert.equal((await westie.api.post('/lab-checkin', { lab_case_id: c.id, verdict: 'ok', checklist: ALL_GOOD })).status, 404);
  assert.ok(!(await westie.api.get('/lab-checkin/due')).data.cases.some((x) => x.id === c.id));
  // Everyone at the practice with clinical write can.
  assert.equal((await assistant.api.post('/lab-checkin', { lab_case_id: c.id, verdict: 'ok', checklist: ALL_GOOD })).status, 201);
  // Dates are checked.
  assert.equal((await api.get('/visit-readiness?date=2030-02-31')).status, 400);
  assert.equal((await api.get(`/visit-readiness?date=${o.today}&to=${addDays(o.today, 40)}`)).status, 400);
});
