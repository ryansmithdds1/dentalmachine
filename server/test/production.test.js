// S5 production on the schedule: scheduled vs completed (from the ledger), goals, the Doctor / Hygiene split,
// office scoping, and money hidden from people without billing access.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import productionRoutes from '../src/routes/production.js';
import dayTemplateRoutes from '../src/routes/daytemplates.js';

const h = harness();
const MON = '2031-01-06'; // a Monday, office open 08:00-17:00 by default
const SUN = '2031-01-05';

// Until app.js mounts these routes, put them in the app's /api router ahead of the other route groups (where
// the hand-off says to mount them). Harmless if app.js already has them.
before(async () => {
  while (!h.app) await new Promise((r) => setTimeout(r, 10));
  const api = h.app.router.stack.find((l) => l.handle?.stack?.length > 40).handle;
  const at = api.stack.findIndex((l) => l.handle?.stack);
  api.use(productionRoutes({ db: h.db }), dayTemplateRoutes({ db: h.db }));
  api.stack.splice(at, 0, ...api.stack.splice(api.stack.length - 2, 2));
});

async function user(api, role, extra = {}) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const made = await api.post('/users', { email, name: role, role, password: `${role}-password-123`, ...extra });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return h.client((await h.client().post('/auth/login', { email, password: `${role}-password-123` })).data.token);
}
const book = async (api, body) => {
  const r = await api.post('/appointments', { override_blockout: true, notify: false, add_type_procedures: false, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const proc = async (api, patientId, code, apptId, extra = {}) => {
  const r = await api.post(`/patients/${patientId}/procedures`, { code, appointment_id: apptId, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const prod = async (api, q) => {
  const r = await api.get(`/schedule/production?${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};

async function setup() {
  const p = await h.practice();
  const { api, provider: dentist, patient } = p;
  const hyg = (await api.post('/providers', { name: 'Hana Rose, RDH', type: 'hygienist' })).data;
  const chairs = (await api.get('/operatories')).data;
  const other = (await api.post('/patients', { first_name: 'Sam', last_name: 'Roe', dob: '1990-01-01' })).data;
  const third = (await api.post('/patients', { first_name: 'Al', last_name: 'Ray', dob: '1970-01-01' })).data;
  const a1 = await book(api, { patient_id: patient.id, provider_id: dentist.id, operatory_id: chairs[0].id, start_time: `${MON} 09:00`, end_time: `${MON} 10:00` });
  const p1 = await proc(api, patient.id, 'D2391', a1.id, { tooth: '30', surfaces: 'O', provider_id: dentist.id });
  const p2 = await proc(api, patient.id, 'D2740', a1.id, { tooth: '19', provider_id: dentist.id });
  const a2 = await book(api, { patient_id: other.id, provider_id: hyg.id, operatory_id: chairs[2].id, start_time: `${MON} 09:00`, end_time: `${MON} 10:00` });
  const p3 = await proc(api, other.id, 'D1110', a2.id, { provider_id: hyg.id });
  const a3 = await book(api, { patient_id: third.id, provider_id: dentist.id, operatory_id: chairs[1].id, start_time: `${MON} 13:00`, end_time: `${MON} 14:00` });
  const p4 = await proc(api, third.id, 'D0150', a3.id, { provider_id: dentist.id });
  return { ...p, hyg, chairs, other, third, a1, a2, a3, p1, p2, p3, p4 };
}

test('scheduled = fees on the day’s live visits; completed = live ledger charges (voids and cancellations drop out)', async () => {
  const s = await setup();
  const { api } = s;
  let r = await prod(api, `date=${MON}`);
  assert.equal(r.money, true);
  let day = r.days[0];
  assert.equal(day.date, MON);
  assert.equal(day.scheduled, s.p1.fee + s.p2.fee + s.p3.fee + s.p4.fee);
  assert.equal(day.completed, 0);
  assert.equal(day.visits, 3);

  // A cancelled visit comes off (and its planned work goes back to the unscheduled list).
  await api.patch(`/appointments/${s.a3.id}/status`, { status: 'cancelled', broken_reason: 'sick' });
  r = await prod(api, `date=${MON}`);
  day = r.days[0];
  assert.equal(day.scheduled, s.p1.fee + s.p2.fee + s.p3.fee);
  assert.equal(day.visits, 2);
  assert.equal(r.unscheduled.amount, s.p4.fee, 'the cancelled visit’s exam is treatment still to book');
  assert.equal(r.unscheduled.patients, 1);

  // Completing posts charges; the completed number follows the ledger.
  const c1 = await api.post(`/procedures/${s.p1.id}/complete`);
  assert.equal(c1.status, 200, JSON.stringify(c1.data));
  assert.equal((await api.post(`/procedures/${s.p2.id}/complete`)).status, 200);
  day = (await prod(api, `date=${MON}`)).days[0];
  assert.equal(day.completed, s.p1.fee + s.p2.fee);
  // Voiding the crown's charge (reversed in the ledger) takes it out of completed, not out of scheduled.
  const charge = await h.db.get("SELECT id FROM ledger_entries WHERE procedure_id = ? AND type = 'charge'", s.p2.id);
  const v = await api.post(`/ledger/${charge.id}/void`, { reason: 'Charted on the wrong tooth' });
  assert.ok([200, 201].includes(v.status), JSON.stringify(v.data));
  const net = await h.db.get("SELECT SUM(amount) AS n FROM ledger_entries WHERE procedure_id = ? AND type = 'charge'", s.p2.id);
  assert.equal(Number(net.n), 0, 'the void and its reversal cancel out in the ledger');
  day = (await prod(api, `date=${MON}`)).days[0];
  assert.equal(day.completed, s.p1.fee, 'voided charge not counted');
  assert.equal(day.scheduled, s.p1.fee + s.p2.fee + s.p3.fee, 'still booked for the day');

  // Breakdowns: by provider, chair and category.
  assert.equal(day.providers[s.provider.id].scheduled, s.p1.fee + s.p2.fee);
  assert.equal(day.providers[s.provider.id].completed, s.p1.fee);
  assert.equal(day.providers[s.provider.id].kind, 'doctor');
  assert.equal(day.providers[s.hyg.id].scheduled, s.p3.fee);
  assert.equal(day.providers[s.hyg.id].kind, 'hygiene');
  assert.equal(day.operatories[s.chairs[0].id].scheduled, s.p1.fee + s.p2.fee);
  assert.equal(day.operatories[s.chairs[0].id].visits, 1);
  assert.equal(day.operatories[s.chairs[2].id].scheduled, s.p3.fee);
  assert.deepEqual(day.categories.restorative, { scheduled: s.p1.fee, completed: s.p1.fee });
  assert.deepEqual(day.categories.prosthodontics, { scheduled: s.p2.fee, completed: 0 });
  assert.deepEqual(day.categories.preventive, { scheduled: s.p3.fee, completed: 0 });
  assert.deepEqual(day.providers[s.provider.id].categories.restorative, { scheduled: s.p1.fee, completed: s.p1.fee });
  assert.equal(day.operatories[s.chairs[0].id].providers[s.provider.id].scheduled, s.p1.fee + s.p2.fee);
  assert.deepEqual(day.operatories[s.chairs[2].id].categories, { preventive: { scheduled: s.p3.fee, completed: 0 } });
});

test('Doctor / Hygiene split and goals: provider goals, else the practice’s (hygiene_goal is hygiene’s part)', async () => {
  const s = await setup();
  const { api } = s;
  await api.put('/practice', { daily_goal: 500000, hygiene_goal: 150000 });
  const all = (await prod(api, `date=${MON}`)).days[0];
  const doc = (await prod(api, `date=${MON}&kind=doctor`)).days[0];
  const hyg = (await prod(api, `date=${MON}&kind=hygiene`)).days[0];
  assert.equal(doc.scheduled, s.p1.fee + s.p2.fee + s.p4.fee);
  assert.equal(hyg.scheduled, s.p3.fee);
  assert.equal(all.scheduled, doc.scheduled + hyg.scheduled);
  assert.deepEqual(Object.keys(hyg.providers).map(Number), [s.hyg.id], 'only hygiene columns');
  assert.equal(hyg.operatories[s.chairs[0].id], undefined);
  assert.deepEqual([all.goal, doc.goal, hyg.goal], [500000, 350000, 150000]);
  // Sunday: the office is closed, so no goal.
  assert.equal((await prod(api, `date=${SUN}`)).days[0].goal, 0);

  // A provider goal replaces the practice's for that kind.
  await api.put(`/providers/${s.provider.id}`, { daily_goal: 400000 });
  const all2 = (await prod(api, `date=${MON}`)).days[0];
  assert.equal(all2.goal, 400000 + 150000);
  assert.equal(all2.providers[s.provider.id].goal, 400000);
  assert.equal((await prod(api, `date=${MON}&kind=doctor`)).days[0].goal, 400000);
  // A day off (exception) means no provider goal that day.
  const ex = await api.post(`/providers/${s.provider.id}/exceptions`, { from: MON, off: true, reason: 'Conference' });
  assert.equal(ex.status, 201, JSON.stringify(ex.data));
  assert.equal((await prod(api, `date=${MON}&kind=doctor`)).days[0].goal, 0);

  // Week: one entry per day, each with its own total.
  const week = await prod(api, `date=${SUN}&days=7`);
  assert.equal(week.days.length, 7);
  assert.equal(week.to, '2031-01-11');
  assert.equal(week.days[1].scheduled, all.scheduled);
  assert.equal(week.days[2].scheduled, 0);

  // Checked input.
  for (const q of ['date=2031-02-30', 'date=2031-01-06&days=15', 'date=2031-01-06&kind=ortho', 'date=2031-01-06&location_id=999999']) {
    assert.ok([400, 404].includes((await api.get(`/schedule/production?${q}`)).status), q);
  }
  // The older per-provider summary (?from&to) still answers.
  const old = (await api.get(`/schedule/production?from=${MON}&to=${MON}`)).data;
  assert.ok(Array.isArray(old.rows));
});

test('money hidden without billing access; visit counts and blocks still shown', async () => {
  const s = await setup();
  const assistant = await user(s.api, 'assistant');
  const r = await prod(assistant, `date=${MON}`);
  assert.equal(r.money, false);
  const day = r.days[0];
  assert.equal(day.visits, 3);
  assert.equal(day.scheduled, null);
  assert.equal(day.completed, null);
  assert.equal(day.goal, null);
  assert.equal(day.providers[s.provider.id].scheduled, null);
  assert.equal(day.providers[s.provider.id].visits, 2);
  assert.deepEqual(day.providers[s.provider.id].categories, {});
  assert.equal(Object.values(day.operatories)[0].providers[s.provider.id].scheduled, null);
  assert.equal(r.unscheduled.amount, null);
  assert.deepEqual(day.categories, {});
  // Front desk has billing:read.
  const desk = await user(s.api, 'front_desk');
  assert.equal((await prod(desk, `date=${MON}`)).days[0].scheduled, s.p1.fee + s.p2.fee + s.p3.fee + s.p4.fee);
  // Other practices' data never shows.
  const stranger = await h.practice();
  const theirs = (await prod(stranger.api, `date=${MON}`)).days[0];
  assert.deepEqual([theirs.scheduled, theirs.visits], [0, 0]);
});

test('office scoping: one office’s numbers, and people limited to an office see only theirs', async () => {
  const { api, provider, patient } = await h.practice();
  const main = (await api.post('/locations', { name: 'Main St' })).data;
  const west = (await api.post('/locations', { name: 'Westside' })).data;
  const opMain = (await api.get('/operatories')).data[0];
  const opWest = (await api.post('/operatories', { name: 'West 1', location_id: west.id })).data;
  const other = (await api.post('/patients', { first_name: 'Wes', last_name: 'Tside', dob: '1980-02-02' })).data;
  const am = await book(api, { patient_id: patient.id, provider_id: provider.id, operatory_id: opMain.id, start_time: `${MON} 08:00`, end_time: `${MON} 09:00` });
  const aw = await book(api, { patient_id: other.id, provider_id: provider.id, operatory_id: opWest.id, start_time: `${MON} 10:00`, end_time: `${MON} 11:00` });
  const pm = await proc(api, patient.id, 'D0150', am.id);
  const pw = await proc(api, other.id, 'D2740', aw.id, { tooth: '3' });
  assert.equal((await prod(api, `date=${MON}`)).days[0].scheduled, pm.fee + pw.fee);
  assert.equal((await prod(api, `date=${MON}&location_id=${main.id}`)).days[0].scheduled, pm.fee);
  assert.equal((await prod(api, `date=${MON}&location_id=${west.id}`)).days[0].scheduled, pw.fee);

  const westDesk = await user(api, 'front_desk', { location_ids: [west.id] });
  assert.equal((await prod(westDesk, `date=${MON}`)).days[0].scheduled, pw.fee, 'only their office’s visits');
  assert.equal((await westDesk.get(`/schedule/production?date=${MON}&location_id=${main.id}`)).status, 403);
});
