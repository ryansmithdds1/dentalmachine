// S2 perfect day / block scheduling: day templates per provider with block and day goals, applied by weekday
// with per-date changes, blocks kept for their visit types until the release time (enforced when booking and
// moving, with an audited "book it anyway"), and the goal feeding the schedule's production numbers.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import productionRoutes from '../src/routes/production.js';
import dayTemplateRoutes from '../src/routes/daytemplates.js';

const h = harness();
const MON = '2031-01-06'; // a Monday, office open 08:00-17:00 by default
const TUE = '2031-01-07';
const NEXT_MON = '2031-01-13';

// Until app.js mounts these routes, put them in the app's /api router ahead of the other route groups (where
// the hand-off says to mount them). Harmless if app.js already has them.
before(async () => {
  while (!h.app) await new Promise((r) => setTimeout(r, 10));
  const api = h.app.router.stack.find((l) => l.handle?.stack?.length > 40).handle;
  const at = api.stack.findIndex((l) => l.handle?.stack);
  api.use(productionRoutes({ db: h.db }), dayTemplateRoutes({ db: h.db }));
  api.stack.splice(at, 0, ...api.stack.splice(api.stack.length - 2, 2));
});

async function user(api, role) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await api.post('/users', { email, name: role, role, password: `${role}-password-123` });
  return h.client((await h.client().post('/auth/login', { email, password: `${role}-password-123` })).data.token);
}
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();

async function setup() {
  const p = await h.practice();
  const { api, provider } = p;
  const types = (await api.get('/appointment-types')).data;
  const crown = types.find((t) => t.name === 'Crown prep');
  const filling = types.find((t) => t.name === 'Filling');
  const emergency = types.find((t) => t.name.startsWith('Emergency'));
  const chairs = (await api.get('/operatories')).data;
  const tpl = await api.post('/day-templates', {
    provider_id: provider.id, name: 'Dr. Lee Monday', weekdays: [1], release_hours: 24,
    blocks: [
      { label: 'Fillings', start_time: '10:00', end_time: '12:00', appointment_type_ids: [filling.id], goal: 120000 },
      { label: 'Crowns', start_time: '08:00', end_time: '10:00', appointment_type_ids: [crown.id], goal: 300000 },
      { label: 'Emergency', start_time: '13:00', end_time: '13:30', appointment_type_ids: [emergency.id], goal: 15000, release_hours: 2 },
    ],
  });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.data));
  return { ...p, crown, filling, emergency, chairs, tpl: tpl.data };
}
const visit = (s, extra) => ({ patient_id: s.patient.id, provider_id: s.provider.id, operatory_id: s.chairs[0].id, notify: false, add_type_procedures: false, ...extra });

test('templates: created with sorted blocks and goals, checked, admin only, one per provider per weekday', async () => {
  const s = await setup();
  const { api, provider } = s;
  assert.deepEqual(s.tpl.blocks.map((b) => [b.label, b.start_time, b.goal]), [['Crowns', '08:00', 300000], ['Fillings', '10:00', 120000], ['Emergency', '13:00', 15000]]);
  assert.deepEqual(s.tpl.blocks[0].type_names, ['Crown prep']);
  assert.deepEqual(s.tpl.weekdays, [1]);
  const created = await h.db.get("SELECT * FROM audit_log WHERE action = 'day_template.create' AND entity_id = ?", s.tpl.id);
  assert.ok(created, 'creating a template is audited');

  const bad = async (body) => (await api.post('/day-templates', { provider_id: provider.id, name: 'X', weekdays: [3], ...body })).status;
  assert.equal(await bad({ blocks: [{ label: 'A', start_time: '09:00', end_time: '08:00' }] }), 400, 'end before start');
  assert.equal(await bad({ blocks: [{ label: 'A', start_time: '08:00', end_time: '10:00' }, { label: 'B', start_time: '09:30', end_time: '11:00' }] }), 400, 'overlap');
  assert.equal(await bad({ blocks: [{ label: 'A', start_time: '8am', end_time: '10:00' }] }), 400, 'bad time');
  assert.equal(await bad({ blocks: [{ label: 'A', start_time: '08:00', end_time: '10:00', appointment_type_ids: [999999] }] }), 404, 'type from elsewhere');
  assert.equal(await bad({ weekdays: [7] }), 400);
  assert.equal(await bad({ name: '' }), 400);
  assert.equal(await bad({ day_goal: -5 }), 400);
  const clash = await api.post('/day-templates', { provider_id: provider.id, name: 'Another Monday', weekdays: [1, 2] });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /already plans this provider’s Mondays/);

  // Only administrators change templates; everyone on the schedule reads them.
  const desk = await user(api, 'front_desk');
  assert.equal((await desk.post('/day-templates', { provider_id: provider.id, name: 'Mine', weekdays: [4] })).status, 403);
  assert.equal((await desk.put(`/day-templates/${s.tpl.id}`, { day_goal: 1 })).status, 403);
  assert.equal((await desk.get('/day-templates')).data.length, 1);
  // Another practice can't see or touch it.
  const other = await h.practice();
  assert.deepEqual((await other.api.get('/day-templates')).data, []);
  assert.equal((await other.api.put(`/day-templates/${s.tpl.id}`, { name: 'Mine now' })).status, 404);
});

test('blocks: only their visit types book there before release; moves are checked; "book it anyway" is audited', async () => {
  const s = await setup();
  const { api } = s;
  // A filling in the crown block is refused with a clear, overridable answer.
  const refused = await api.post('/appointments', visit(s, { appointment_type_id: s.filling.id, start_time: `${MON} 08:30`, end_time: `${MON} 09:30` }));
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /08:00–10:00 is Dr\. Ann Lee, DDS’s Crowns time, kept for Crown prep until Sun, Jan 5 at 8:00 AM/);
  assert.equal(refused.data.details.can_override, true);
  assert.equal(refused.data.details.day_block.label, 'Crowns');
  // No visit type at all: also kept.
  assert.equal((await api.post('/appointments', visit(s, { start_time: `${MON} 08:00`, end_time: `${MON} 08:30` }))).status, 409);
  // A crown prep books straight in; a filling books in the filling block.
  const crown = await api.post('/appointments', visit(s, { appointment_type_id: s.crown.id, start_time: `${MON} 08:00`, end_time: `${MON} 09:30` }));
  assert.equal(crown.status, 201, JSON.stringify(crown.data));
  const other = (await api.post('/patients', { first_name: 'Sam', last_name: 'Roe', dob: '1990-01-01' })).data;
  const fill = await api.post('/appointments', visit(s, { patient_id: other.id, appointment_type_id: s.filling.id, start_time: `${MON} 10:00`, end_time: `${MON} 11:00` }));
  assert.equal(fill.status, 201, JSON.stringify(fill.data));
  // Outside every block: anything.
  const third = (await api.post('/patients', { first_name: 'Al', last_name: 'Ray', dob: '1970-01-01' })).data;
  assert.equal((await api.post('/appointments', visit(s, { patient_id: third.id, appointment_type_id: s.filling.id, start_time: `${MON} 14:00`, end_time: `${MON} 15:00` }))).status, 201);

  // Moving the filling into the crown block is refused too; moving it later in its own block is fine.
  const move = await api.put(`/appointments/${fill.data.id}`, { start_time: `${MON} 09:30`, end_time: `${MON} 10:30` });
  assert.equal(move.status, 409);
  assert.equal(move.data.details.day_block.label, 'Crowns');
  assert.equal((await api.put(`/appointments/${fill.data.id}`, { start_time: `${MON} 11:00`, end_time: `${MON} 12:00` })).status, 200);

  // "Book it anyway": allowed, and recorded with the block and why.
  const anyway = await api.post('/appointments', visit(s, { patient_id: third.id, appointment_type_id: s.filling.id, start_time: `${MON} 09:30`, end_time: `${MON} 10:00`, override_blockout: true }));
  assert.equal(anyway.status, 201, JSON.stringify(anyway.data));
  const log = await h.db.get("SELECT * FROM audit_log WHERE action = 'appointment.block_override' AND entity_id = ?", anyway.data.id);
  assert.ok(log, 'the override is audited');
  assert.match(log.reason, /Booked into Crowns time \(kept for Crown prep\) anyway/);
  assert.equal(JSON.parse(log.details).block, 'Crowns');
  assert.equal(log.user_id != null, true);
  // Editing that visit without moving it isn't refused again.
  assert.equal((await api.put(`/appointments/${anyway.data.id}`, { notes: 'Bring the shade guide' })).status, 200);
  // Moved into a block anyway (with the override) is audited too.
  const toEmergency = { start_time: `${MON} 13:00`, end_time: `${MON} 13:30` };
  assert.equal((await api.put(`/appointments/${fill.data.id}`, toEmergency)).status, 409, 'the emergency slot is kept');
  assert.equal((await api.put(`/appointments/${fill.data.id}`, { ...toEmergency, override_blockout: true })).status, 200);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'appointment.block_override' AND entity_id = ?", fill.data.id));
  const tue = await api.put(`/appointments/${fill.data.id}`, { start_time: `${TUE} 08:00`, end_time: `${TUE} 09:00` });
  assert.equal(tue.status, 200, 'Tuesdays have no template');
});

test('release time: a block opens to anything once its release time has passed', async () => {
  const s = await setup();
  const { api, provider } = s;
  const tz = (await api.get('/practice')).data.timezone || 'America/New_York';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  let soon = addDays(today, 2);
  while ([0, 6].includes(weekday(soon))) soon = addDays(soon, 1);
  const tpl = await api.post('/day-templates', {
    provider_id: provider.id, name: 'Soon', weekdays: [], release_hours: 0,
    blocks: [{ label: 'New patients', start_time: '15:00', end_time: '16:00', appointment_type_ids: [s.crown.id], goal: 50000 }],
  });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.data));
  // Use this template on that date whatever its weekday (a per-date change).
  const plan = await api.put(`/providers/${provider.id}/day-plan/${soon}`, { mode: 'template', template_id: tpl.data.id, reason: 'Trying the new-patient block' });
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  const body = visit(s, { appointment_type_id: s.filling.id, start_time: `${soon} 15:00`, end_time: `${soon} 15:30` });
  assert.equal((await api.post('/appointments', body)).status, 409, 'kept until it starts');
  // Released two weeks ahead: open to anything now.
  assert.equal((await api.put(`/day-templates/${tpl.data.id}`, { release_hours: 336 })).status, 200);
  const booked = await api.post('/appointments', body);
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  assert.equal(await h.db.get("SELECT id FROM audit_log WHERE action = 'appointment.block_override' AND entity_id = ?", booked.data.id), undefined, 'not an override');
});

test('per-date changes, retiring, editing blocks (old ones kept), and goals feeding production', async () => {
  const s = await setup();
  const { api, provider } = s;
  const filler = visit(s, { appointment_type_id: s.filling.id, start_time: `${NEXT_MON} 08:00`, end_time: `${NEXT_MON} 09:00` });
  // No template that Monday.
  assert.equal((await api.put(`/providers/${provider.id}/day-plan/${NEXT_MON}`, { mode: 'none', reason: 'Staff training' })).status, 200);
  const free = await api.post('/appointments', filler);
  assert.equal(free.status, 201, JSON.stringify(free.data));
  await api.patch(`/appointments/${free.data.id}/status`, { status: 'cancelled', broken_reason: 'office' });
  // Back to usual: kept again. The date row stays (mode auto), with its history in the audit log.
  assert.equal((await api.put(`/providers/${provider.id}/day-plan/${NEXT_MON}`, { mode: 'auto' })).status, 200);
  assert.equal((await api.post('/appointments', filler)).status, 409);
  assert.equal((await h.db.all("SELECT * FROM audit_log WHERE action = 'day_template.date'")).filter((r) => JSON.parse(r.details).date === NEXT_MON).length, 2);
  assert.equal((await api.put(`/providers/${provider.id}/day-plan/${NEXT_MON}`, { mode: 'template', template_id: 999999 })).status, 404);
  assert.equal((await api.put(`/providers/${provider.id}/day-plan/2031-02-30`, { mode: 'none' })).status, 400);

  // The day's goal: the blocks' goals added up (no day goal set), per block what's booked, live.
  const crown = await api.post('/appointments', visit(s, { appointment_type_id: s.crown.id, start_time: `${MON} 08:00`, end_time: `${MON} 09:30` }));
  const pr = (await api.post(`/patients/${s.patient.id}/procedures`, { code: 'D2740', tooth: '3', appointment_id: crown.data.id, provider_id: provider.id })).data;
  let day = (await api.get(`/schedule/production?date=${MON}`)).data.days[0];
  assert.equal(day.goal, 300000 + 120000 + 15000);
  assert.equal(day.providers[provider.id].goal, 435000);
  const crowns = day.blocks.find((b) => b.label === 'Crowns');
  assert.deepEqual([crowns.goal, crowns.scheduled, crowns.visits, crowns.matching, crowns.provider_id], [300000, pr.fee, 1, 1, provider.id]);
  assert.equal(crowns.release_at, '2031-01-05 08:00');
  // The Hygiene view still shows the doctor's blocks (they're about where to book), with what's in them.
  const hygView = (await api.get(`/schedule/production?date=${MON}&kind=hygiene`)).data.days[0];
  assert.equal(hygView.blocks.find((b) => b.label === 'Crowns').scheduled, pr.fee);
  assert.equal(hygView.scheduled, 0);
  // A day goal on the template wins over the blocks' sum.
  assert.equal((await api.put(`/day-templates/${s.tpl.id}`, { day_goal: 500000 })).status, 200);
  day = (await api.get(`/schedule/production?date=${MON}`)).data.days[0];
  assert.equal(day.goal, 500000);
  // Not on other weekdays.
  assert.equal((await api.get(`/schedule/production?date=${TUE}`)).data.days[0].blocks.length, 0);
  // Without billing access the blocks still show, without money.
  const assistant = await user(api, 'assistant');
  const seen = (await assistant.get(`/schedule/production?date=${MON}`)).data.days[0];
  assert.equal(seen.blocks.length, 3);
  assert.equal(seen.blocks[0].goal, null);

  // Editing the blocks retires the old ones (kept) and adds the new.
  const edited = await api.put(`/day-templates/${s.tpl.id}`, { blocks: [{ label: 'Big cases', start_time: '08:00', end_time: '12:00', appointment_type_ids: [s.crown.id], goal: 400000 }], reason: 'New plan from the owner' });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.deepEqual(edited.data.blocks.map((b) => b.label), ['Big cases']);
  const rows = await h.db.all('SELECT label, active FROM day_template_blocks WHERE template_id = ? ORDER BY id', s.tpl.id);
  assert.deepEqual(rows.map((r) => [r.label, r.active]), [['Crowns', 0], ['Fillings', 0], ['Emergency', 0], ['Big cases', 1]]);
  const upd = await h.db.get("SELECT * FROM audit_log WHERE action = 'day_template.update' AND reason = 'New plan from the owner'");
  assert.match(JSON.parse(upd.changes).blocks[0], /Crowns/);
  assert.match(JSON.parse(upd.changes).blocks[1], /Big cases/);

  // Retiring: no longer planning days, never deleted.
  assert.equal((await api.post(`/day-templates/${s.tpl.id}/retire`, { reason: 'Summer hours' })).status, 200);
  assert.equal((await api.get('/day-templates')).data.length, 0);
  assert.equal((await api.get('/day-templates?include_retired=true')).data[0].active, 0);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'day_template.retire' AND entity_id = ?", s.tpl.id));
  const other = (await api.post('/patients', { first_name: 'Sam', last_name: 'Roe', dob: '1990-01-01' })).data;
  assert.equal((await api.post('/appointments', visit(s, { patient_id: other.id, appointment_type_id: s.filling.id, start_time: `${MON} 10:00`, end_time: `${MON} 11:00` }))).status, 201);
  assert.equal((await api.put(`/providers/${provider.id}/day-plan/${MON}`, { mode: 'template', template_id: s.tpl.id })).status, 409, 'a retired template can’t be used');
});
