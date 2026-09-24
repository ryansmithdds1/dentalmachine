// Opportunity finder (OF1–OF3): each starter rule against ages, history, frequency, the chart and perio readings;
// insurance frequency limits ("eligible on"); adding to the visit (idempotent) and undoing it; the day view; the
// capture report; rules retired not deleted; practice/office isolation and permissions. The routes aren't mounted
// in app.js by this file's author, so the tests mount them on a small app of their own (as offline.test.js does).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import opportunityRoutes from '../src/routes/opportunities.js';
import { authenticate, HttpError } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges, practiceNow, insert, addMonths } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';

const h = harness();
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
  api.use(opportunityRoutes({ db: h.db }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const client = (token) => {
  const call = async (method, path, body) => {
    const res = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
};
const signIn = async (email, password = 'correct-horse-battery') => (await h.client().post('/auth/login', { email, password })).data.token;

// A practice with the starter rules, a hygienist, and helpers to make patients, visits and history.
async function setUp() {
  const p = await h.practice({ timezone: 'UTC' });
  const pid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', p.provider.id)).practice_id;
  const today = (await practiceNow(h.db, pid)).slice(0, 10);
  const opp = client(p.token);
  const seeded = await opp.post('/opportunity-rules/starter');
  assert.equal(seeded.status, 201);
  const rules = Object.fromEntries((await h.db.all('SELECT id, starter_key FROM opportunity_rules WHERE practice_id = ?', pid)).map((r) => [r.starter_key, r.id]));
  const hyg = (await p.api.post('/providers', { name: 'Hal Hygienist, RDH', type: 'hygienist' })).data;
  const code = async (c) => h.db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', pid, c);
  const dobFor = (age) => addMonths(today, -(age * 12 + 1));
  const patient = async (age, extra = {}) => ({ id: await insert(h.db, 'patients', { practice_id: pid, first_name: 'Pat', last_name: `Age${age}`, dob: dobFor(age), ...extra }) });
  const visit = async (pt, extra = {}) => ({
    id: await insert(h.db, 'appointments', { practice_id: pid, patient_id: pt.id, provider_id: hyg.id, start_time: `${today} 10:00`, end_time: `${today} 11:00`, status: 'scheduled', ...extra }),
  });
  const proc = async (pt, c, { status = 'completed', monthsAgo = 0, tooth = null, area = null, appointment_id = null } = {}) => {
    const pc = await code(c);
    return insert(h.db, 'procedures', {
      practice_id: pid, patient_id: pt.id, code_id: pc.id, code: pc.code, description: pc.description, category: pc.category, fee: pc.fee, status, tooth, area, appointment_id,
      completed_at: status === 'completed' ? `${addMonths(today, -monthsAgo)} 10:00:00` : null, provider_id: hyg.id,
    });
  };
  const condition = (pt, tooth, c, notes = null) => insert(h.db, 'tooth_conditions', { practice_id: pid, patient_id: pt.id, tooth, condition: c, notes });
  const perio = (pt, depths) => insert(h.db, 'perio_exams', {
    practice_id: pid, patient_id: pt.id, exam_date: addMonths(today, -1),
    readings: JSON.stringify(Object.fromEntries(Object.entries(depths).map(([t, d]) => [t, { pd: [d, 2, 2, 2, 2, 2] }]))),
  });
  const list = async (appt) => {
    const r = await opp.get(`/appointments/${appt.id}/opportunities`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const find = (data, key) => data.opportunities.find((o) => o.rule_id === rules[key]);
  return { ...p, pid, today, opp, rules, hyg, code, patient, visit, proc, condition, perio, list, find };
}

test('starter rules seed once, and retiring a rule keeps it (no deletes)', async () => {
  const p = await setUp();
  const again = await p.opp.post('/opportunity-rules/starter');
  assert.equal(again.status, 200);
  assert.equal(again.data.added.length, 0, 'seeding twice adds nothing');
  const listed = (await p.opp.get('/opportunity-rules')).data;
  assert.ok(listed.rules.length >= 12);
  assert.deepEqual(listed.starters_missing, []);
  const retired = await p.opp.post(`/opportunity-rules/${p.rules.fluoride_child}/retire`);
  assert.equal(retired.data.active, false);
  assert.ok((await p.opp.get('/opportunity-rules')).data.rules.some((r) => r.id === p.rules.fluoride_child && !r.active), 'still listed, retired');
  assert.equal((await p.opp.del(`/opportunity-rules/${p.rules.fluoride_child}`)).status, 404, 'there is no delete');
  // A retired rule isn't checked.
  const kid = await p.patient(9);
  assert.equal(p.find(await p.list(await p.visit(kid)), 'fluoride_child'), undefined);
  await p.opp.post(`/opportunity-rules/${p.rules.fluoride_child}/restore`);
  assert.ok(p.find(await p.list(await p.visit(kid)), 'fluoride_child'));
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'opportunity_rule.retire'", p.pid), 'audited');
  // Editing: validated, before/after audited.
  const bad = await p.opp.put(`/opportunity-rules/${p.rules.fmx}`, { frequency_months: 0 });
  assert.equal(bad.status, 400);
  assert.equal((await p.opp.put(`/opportunity-rules/${p.rules.sealants}`, { scope: 'tooth', conditions: [] })).status, 400, 'per tooth needs a tooth condition');
  const edited = await p.opp.put(`/opportunity-rules/${p.rules.fmx}`, { frequency_months: 36 });
  assert.equal(edited.data.frequency_months, 36);
  const a = await h.db.get("SELECT changes FROM audit_log WHERE practice_id = ? AND action = 'opportunity_rule.update' ORDER BY id DESC", p.pid);
  assert.deepEqual(JSON.parse(a.changes).frequency_months, [60, 36]);
  const created = await p.opp.post('/opportunity-rules', { name: 'Second night guard', codes: ['D9944'], frequency_months: 24, age_min: 18 });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.codes, ['D9944']);
  assert.equal((await p.opp.post('/opportunity-rules', { name: 'Nothing', codes: ['D9999'] })).status, 400, 'a code the office doesn’t have');
});

test('sealants: permanent molars not sealed, restored, decayed or missing, ages 6–15', async () => {
  const p = await setUp();
  const kid = await p.patient(9);
  await p.condition(kid, '3', 'sealant');
  await p.condition(kid, '14', 'filling');
  await p.condition(kid, '19', 'missing');
  await p.condition(kid, '30', 'caries');
  await p.proc(kid, 'D1351', { tooth: '31', monthsAgo: 30 });
  const data = await p.list(await p.visit(kid));
  const s = p.find(data, 'sealants');
  assert.ok(s, 'eligible');
  assert.deepEqual(s.targets.map((t) => t.tooth), ['2', '15', '18']);
  assert.equal(s.fee, 3 * (await p.code('D1351')).fee);
  assert.match(s.reason, /Age 9/);
  assert.match(s.reason, /#2, #15, #18/);
  for (const age of [16, 4, 30]) assert.equal(p.find(await p.list(await p.visit(await p.patient(age))), 'sealants'), undefined, `not at age ${age}`);
  const noDob = { id: await insert(h.db, 'patients', { practice_id: p.pid, first_name: 'No', last_name: 'Birthday' }) };
  assert.equal(p.find(await p.list(await p.visit(noDob)), 'sealants'), undefined, 'no birth date: age rules don’t guess');
});

test('fluoride: under 19 every 6 months; adults only at high caries risk', async () => {
  const p = await setUp();
  const recent = await p.patient(10);
  await p.proc(recent, 'D1206', { monthsAgo: 3 });
  assert.equal(p.find(await p.list(await p.visit(recent)), 'fluoride_child'), undefined, 'done 3 months ago');
  const due = await p.patient(10);
  await p.proc(due, 'D1206', { monthsAgo: 7 });
  const f = p.find(await p.list(await p.visit(due)), 'fluoride_child');
  assert.ok(f);
  assert.match(f.reason, /Last done/);
  assert.equal(f.codes[0], 'D1206');
  const adult = await p.patient(40);
  assert.equal(p.find(await p.list(await p.visit(adult)), 'fluoride_child'), undefined);
  assert.equal(p.find(await p.list(await p.visit(adult)), 'fluoride_risk'), undefined, 'not at risk');
  await insert(h.db, 'risk_assessments', { practice_id: p.pid, patient_id: adult.id, kind: 'caries', answers: '{}', level: 'high', result: '{}' });
  const risk = p.find(await p.list(await p.visit(adult)), 'fluoride_risk');
  assert.ok(risk);
  assert.match(risk.reason, /High caries risk/);
});

test('x-rays: full series every 5 years, bitewings yearly (from age 5), pano every 5 years', async () => {
  const p = await setUp();
  const a = await p.patient(35);
  await p.proc(a, 'D0210', { monthsAgo: 24 });
  await p.proc(a, 'D0274', { monthsAgo: 6 });
  let data = await p.list(await p.visit(a));
  assert.equal(p.find(data, 'fmx'), undefined);
  assert.equal(p.find(data, 'bitewings'), undefined);
  const b = await p.patient(35);
  await p.proc(b, 'D0210', { monthsAgo: 61 });
  await p.proc(b, 'D0274', { monthsAgo: 13 });
  data = await p.list(await p.visit(b));
  assert.ok(p.find(data, 'fmx'));
  assert.ok(p.find(data, 'bitewings'));
  assert.ok(p.find(data, 'pano'), 'never had a pano');
  assert.equal(p.find(await p.list(await p.visit(await p.patient(4))), 'bitewings'), undefined, 'too young');
});

test('perio: SRP per quadrant on 4 mm+ pockets (D4341 / D4342), Arestin on 5 mm+ sites once the code exists', async () => {
  const p = await setUp();
  const pt = await p.patient(50);
  await p.perio(pt, { 2: 5, 3: 5, 4: 4, 5: 4, 20: 4, 30: 3 });
  let data = await p.list(await p.visit(pt));
  const srp = p.find(data, 'srp');
  assert.ok(srp);
  assert.deepEqual(srp.targets.map((t) => [t.area, t.code]), [['LL', 'D4342'], ['UR', 'D4341']]);
  assert.match(srp.reason, /UR \(4 teeth\)/);
  assert.equal(p.find(data, 'arestin'), undefined, 'D4381 isn’t in the office’s codes');
  await insert(h.db, 'procedure_codes', { practice_id: p.pid, code: 'D4381', description: 'Localized antimicrobial, per tooth', category: 'periodontics', fee: 9000 });
  data = await p.list(await p.visit(pt));
  const ar = p.find(data, 'arestin');
  assert.deepEqual(ar.targets.map((t) => t.tooth), ['2', '3']);
  assert.equal(ar.fee, 18000);
  // SRP done on UR last year: only LL is left.
  await p.proc(pt, 'D4341', { area: 'UR', monthsAgo: 12 });
  data = await p.list(await p.visit(pt));
  assert.deepEqual(p.find(data, 'srp').targets.map((t) => t.area), ['LL']);
  // Healthy mouth: nothing.
  const healthy = await p.patient(50);
  await p.perio(healthy, { 2: 3, 3: 2 });
  data = await p.list(await p.visit(healthy));
  assert.equal(p.find(data, 'srp'), undefined);
});

test('perio maintenance instead of the prophy after SRP: adding it sets the prophy aside, undo puts it back', async () => {
  const p = await setUp();
  const pt = await p.patient(55);
  await p.proc(pt, 'D4342', { area: 'LL', monthsAgo: 8 });
  const appt = await p.visit(pt);
  const prophy = await p.proc(pt, 'D1110', { status: 'planned', appointment_id: appt.id });
  const data = await p.list(appt);
  const pm = p.find(data, 'perio_maint');
  assert.ok(pm);
  assert.equal(pm.added_fee, (await p.code('D4910')).fee - (await p.code('D1110')).fee);
  assert.match(pm.reason, /In place of D1110/);
  const added = await p.opp.post(`/appointments/${appt.id}/opportunities/${p.rules.perio_maint}/add`);
  assert.equal(added.status, 201);
  assert.equal(added.data.procedures[0].code, 'D4910');
  assert.equal((await h.db.get('SELECT status FROM procedures WHERE id = ?', prophy)).status, 'cancelled');
  const undo = await p.opp.post(`/appointments/${appt.id}/opportunities/${p.rules.perio_maint}/undo`);
  assert.equal(undo.status, 200);
  assert.equal((await h.db.get('SELECT status FROM procedures WHERE id = ?', prophy)).status, 'planned');
  assert.equal((await h.db.get('SELECT status FROM procedures WHERE id = ?', added.data.procedures[0].id)).status, 'cancelled');
  // No SRP history: no perio maintenance.
  assert.equal(p.find(await p.list(await p.visit(await p.patient(55))), 'perio_maint'), undefined);
});

test('night guard when grinding is noted; unscheduled treatment and an overdue recall join the visit', async () => {
  const p = await setUp();
  const grinder = await p.patient(35, { medical_alerts: 'Grinds teeth at night' });
  assert.ok(p.find(await p.list(await p.visit(grinder)), 'night_guard'));
  assert.equal(p.find(await p.list(await p.visit(await p.patient(35))), 'night_guard'), undefined);
  const pt = await p.patient(40);
  const crown = await p.proc(pt, 'D2740', { status: 'planned', tooth: '3' });
  await insert(h.db, 'recalls', { practice_id: p.pid, patient_id: pt.id, type: 'prophy', interval_months: 6, due_date: addMonths(p.today, -2), status: 'due' });
  const appt = await p.visit(pt, { start_time: `${p.today} 14:00`, end_time: `${p.today} 15:00`, provider_id: p.provider.id });
  const data = await p.list(appt);
  const un = p.find(data, 'unscheduled');
  assert.deepEqual(un.targets.map((t) => t.procedure_id), [crown]);
  const rc = p.find(data, 'recall');
  assert.deepEqual(rc.codes, ['D1110']);
  assert.match(rc.reason, /overdue since/);
  const add = await p.opp.post(`/appointments/${appt.id}/opportunities/${p.rules.unscheduled}/add`);
  assert.equal(add.status, 201);
  assert.equal((await h.db.get('SELECT appointment_id FROM procedures WHERE id = ?', crown)).appointment_id, appt.id, 'the planned crown moved onto the visit');
  const after = await p.list(appt);
  assert.equal(p.find(after, 'unscheduled'), undefined);
  assert.equal(after.added.length, 1);
});

test('insurance: covered, not covered yet with the date it becomes eligible, or no insurance', async () => {
  const p = await setUp();
  const kid = await p.patient(10);
  let f = p.find(await p.list(await p.visit(kid)), 'fluoride_child');
  assert.equal(f.coverage.status, 'no_insurance');
  assert.equal(f.coverage.patient, f.fee);
  const carrier = (await p.api.post('/carriers', { name: 'Delta Test', payer_id: '12345' })).data;
  for (const pt of [kid]) {
    const r = await p.api.post(`/patients/${pt.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Parent', subscriber_id: `S${pt.id}`, annual_max: 150000, deductible: 5000, pct_preventive: 100, pct_basic: 80, pct_major: 50 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  f = p.find(await p.list(await p.visit(kid)), 'fluoride_child');
  assert.equal(f.coverage.status, 'covered');
  assert.equal(f.coverage.patient, 0);
  // The plan counts a pano against the full series (1 per 5 years): FMX is due by the office's rule, but
  // insurance won't pay until 5 years after the pano.
  const adult = await p.patient(40);
  await p.api.post(`/patients/${adult.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Adult', subscriber_id: `S${adult.id}`, annual_max: 150000, deductible: 5000, pct_preventive: 100, pct_basic: 80, pct_major: 50 });
  await p.proc(adult, 'D0330', { monthsAgo: 20 });
  const fmx = p.find(await p.list(await p.visit(adult)), 'fmx');
  assert.equal(fmx.coverage.status, 'not_yet');
  const pano = await h.db.get("SELECT completed_at FROM procedures WHERE patient_id = ? AND code = 'D0330'", adult.id);
  assert.equal(fmx.coverage.eligible_on, addMonths(pano.completed_at.slice(0, 10), 60));
  assert.match(fmx.coverage.label, /Not covered yet — eligible on \d{4}-\d{2}-\d{2}/);
  assert.equal(fmx.coverage.patient, fmx.fee, 'the patient would pay it all today');
});

test('adding to the visit is idempotent (double click, two at once); declining and the day view', async () => {
  const p = await setUp();
  const kid = await p.patient(9);
  const appt = await p.visit(kid);
  const path = `/appointments/${appt.id}/opportunities/${p.rules.sealants}/add`;
  const [a, b] = await Promise.all([p.opp.post(path), p.opp.post(path)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  const again = await p.opp.post(path);
  assert.equal(again.data.already, true);
  const sealants = await h.db.all("SELECT * FROM procedures WHERE appointment_id = ? AND code = 'D1351' AND status = 'planned'", appt.id);
  assert.equal(sealants.length, 8, 'one per unsealed molar, once');
  assert.equal(new Set(sealants.map((s) => s.tooth)).size, 8);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'opportunity.add' AND patient_id = ?", p.pid, kid.id), 'audited against the patient');
  // Only some teeth.
  const kid2 = await p.patient(9);
  const appt2 = await p.visit(kid2, { start_time: `${p.today} 13:00`, end_time: `${p.today} 14:00` });
  const some = await p.opp.post(`/appointments/${appt2.id}/opportunities/${p.rules.sealants}/add`, { only: ['t3', 't14'] });
  assert.deepEqual(some.data.procedures.map((x) => x.tooth).sort(), ['14', '3']);
  // Not today.
  const dec = await p.opp.post(`/appointments/${appt2.id}/opportunities/${p.rules.fluoride_child}/decline`, { reason: 'Parent declined' });
  assert.equal(dec.data.status, 'declined');
  const shown = await p.list(appt2);
  assert.ok(shown.declined.some((o) => o.rule_id === p.rules.fluoride_child));
  assert.equal(p.find(shown, 'fluoride_child'), undefined);
  // The day: per visit and totals, declined left out.
  const day = (await p.opp.get(`/schedule/opportunities?date=${p.today}`)).data;
  const v2 = day.visits.find((v) => v.appointment_id === appt2.id);
  assert.ok(!v2.items.some((i) => i.rule_id === p.rules.fluoride_child));
  assert.equal(day.totals.fee, day.visits.reduce((s, v) => s + v.fee, 0));
  assert.equal(day.totals.count, day.visits.reduce((s, v) => s + v.count, 0));
  assert.equal(day.by_provider[p.hyg.id].fee, day.totals.fee);
  // Capture: offered → accepted → done.
  await p.api.post(`/procedures/${sealants[0].id}/complete`, {});
  const cap = (await p.opp.get(`/opportunities/capture?from=${p.today}&to=${p.today}`)).data;
  const row = cap.rules.find((r) => r.rule_id === p.rules.sealants);
  assert.equal(row.accepted, 2);
  assert.equal(row.done_fee, sealants[0].fee);
  assert.ok(cap.totals.offered >= 3 && cap.totals.declined === 1);
});

test('practices and offices never mix; seeing needs clinical:read, adding clinical:write, rules an administrator', async () => {
  const p = await setUp();
  const kid = await p.patient(9);
  const north = (await p.api.post('/locations', { name: 'North' })).data;
  const south = (await p.api.post('/locations', { name: 'South' })).data;
  const appt = await p.visit(kid, { location_id: south.id });
  const other = await h.practice({ timezone: 'UTC' });
  const theirs = client(other.token);
  assert.equal((await theirs.get(`/appointments/${appt.id}/opportunities`)).status, 404);
  assert.equal((await theirs.post(`/appointments/${appt.id}/opportunities/${p.rules.sealants}/add`)).status, 404);
  await theirs.post('/opportunity-rules/starter');
  assert.equal((await theirs.put(`/opportunity-rules/${p.rules.fmx}`, { name: 'Mine now' })).status, 404);
  const otherAppt = await insert(h.db, 'appointments', { practice_id: (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', other.provider.id)).practice_id, patient_id: other.patient.id, provider_id: other.provider.id, start_time: `${p.today} 10:00`, end_time: `${p.today} 11:00` });
  assert.equal((await p.opp.post(`/appointments/${otherAppt}/opportunities/${p.rules.sealants}/add`)).status, 404, 'their visit');
  const otherDay = (await theirs.get(`/schedule/opportunities?date=${p.today}`)).data;
  assert.ok(!otherDay.visits.some((v) => v.appointment_id === appt.id));
  // Someone at North doesn't see South's visit.
  const nEmail = `north-${Date.now()}@example.com`;
  await p.api.post('/users', { email: nEmail, name: 'North Hygienist', role: 'hygienist', password: 'correct-horse-battery', location_ids: [north.id] });
  const northie = client(await signIn(nEmail));
  assert.equal((await northie.get(`/appointments/${appt.id}/opportunities`)).status, 404);
  assert.ok(!(await northie.get(`/schedule/opportunities?date=${p.today}`)).data.visits.some((v) => v.appointment_id === appt.id));
  assert.equal((await northie.get(`/schedule/opportunities?date=${p.today}&location_id=${south.id}`)).status, 403);
  // Front desk can see but not add; a dentist can add but not change rules.
  const dEmail = `desk-${Date.now()}@example.com`;
  await p.api.post('/users', { email: dEmail, name: 'Desk', role: 'front_desk', password: 'correct-horse-battery' });
  const desk = client(await signIn(dEmail));
  assert.equal((await desk.get(`/appointments/${appt.id}/opportunities`)).status, 200);
  assert.equal((await desk.post(`/appointments/${appt.id}/opportunities/${p.rules.sealants}/add`)).status, 403);
  const drEmail = `dr-${Date.now()}@example.com`;
  await p.api.post('/users', { email: drEmail, name: 'Dr Two', role: 'dentist', password: 'correct-horse-battery' });
  const dr = client(await signIn(drEmail));
  assert.equal((await dr.post(`/appointments/${appt.id}/opportunities/${p.rules.sealants}/add`)).status, 201);
  assert.equal((await dr.post(`/opportunity-rules/${p.rules.fmx}/retire`)).status, 403);
  assert.equal((await dr.post('/opportunity-rules', { name: 'X', codes: ['D0210'] })).status, 403);
  // A cancelled visit takes nothing.
  const gone = await p.visit(await p.patient(9), { status: 'cancelled' });
  assert.equal((await p.opp.post(`/appointments/${gone.id}/opportunities/${p.rules.sealants}/add`)).status, 409);
});
