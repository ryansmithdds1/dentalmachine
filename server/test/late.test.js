// S7 late patients and running behind: the pure calculations the schedule uses (client/src/components/calendar/
// late.js) and the practice's late thresholds (GET/PUT /schedule/late-settings).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import dayTemplateRoutes from '../src/routes/daytemplates.js';
import { lateness, lateList, runningBehind, lateSettings, minutesBetween, waitLabel } from '../../client/src/components/calendar/late.js';

const D = '2031-01-06';
const visit = (id, start, end, status = 'scheduled', extra = {}) => ({ id, start_time: `${D} ${start}`, end_time: `${D} ${end}`, status, first_name: `P${id}`, last_name: 'Test', ...extra });
const S = { lateAfter: 5, veryLateAfter: 10 };

test('lateness: late after N minutes, very late after M, only while waiting to check in and only today', () => {
  assert.equal(minutesBetween(`${D} 09:00`, `${D} 09:07`), 7);
  assert.deepEqual([waitLabel(7), waitLabel(60), waitLabel(292)], ['7 min', '1 h', '4 h 52 min']);
  const a = visit(1, '09:00', '10:00');
  assert.equal(lateness(a, `${D} 09:04`, S), null, 'not yet');
  assert.deepEqual(lateness(a, `${D} 09:05`, S), { minutes: 5, level: 'late' });
  assert.deepEqual(lateness(a, `${D} 09:07`, S), { minutes: 7, level: 'late' });
  assert.deepEqual(lateness(a, `${D} 09:10`, S), { minutes: 10, level: 'very_late' });
  assert.deepEqual(lateness({ ...a, status: 'confirmed' }, `${D} 10:30`, S), { minutes: 90, level: 'very_late' }, 'still late after the visit’s end until someone acts');
  for (const status of ['checked_in', 'in_chair', 'completed', 'cancelled', 'no_show']) assert.equal(lateness({ ...a, status }, `${D} 09:30`, S), null, status);
  assert.equal(lateness(a, '2031-01-07 08:00', S), null, 'a past day is a no-show to record, not "late"');
  assert.equal(lateness(a, `${D} 08:00`, S), null, 'not before it starts');
  assert.deepEqual(lateness(a, `${D} 09:03`, { lateAfter: 2, veryLateAfter: 3 }), { minutes: 3, level: 'very_late' }, 'the practice’s own numbers');

  const list = lateList([visit(1, '09:00', '10:00'), visit(2, '08:30', '09:00', 'confirmed'), visit(3, '09:20', '10:00'), visit(4, '08:00', '09:00', 'checked_in')], `${D} 09:12`, S);
  assert.deepEqual(list.map((x) => [x.appt.id, x.late.minutes, x.late.level]), [[2, 42, 'very_late'], [1, 12, 'very_late']], 'longest wait first; not yet due and checked in left out');
});

test('settings are kept sensible whatever is stored', () => {
  assert.deepEqual(lateSettings(null), { lateAfter: 5, veryLateAfter: 10 });
  assert.deepEqual(lateSettings({ late_minutes: 7, very_late_minutes: 15 }), { lateAfter: 7, veryLateAfter: 15 });
  assert.deepEqual(lateSettings({ late_minutes: 0, very_late_minutes: 3 }), { lateAfter: 5, veryLateAfter: 10 });
  assert.deepEqual(lateSettings({ late_minutes: 12, very_late_minutes: 4 }), { lateAfter: 12, veryLateAfter: 12 });
});

test('running behind: checked in and not seated after N minutes; in the chair past the end with the next patient waiting', () => {
  // Checked in on time, not seated: behind once N minutes have passed since their time.
  const waiting = visit(1, '09:00', '10:00', 'checked_in', { arrived_at: `${D} 08:55` });
  assert.equal(runningBehind([waiting], `${D} 09:04`, S), null);
  const w = runningBehind([waiting], `${D} 09:07`, S);
  assert.equal(w.minutes, 7);
  assert.match(w.reason, /checked in and not seated for 7 min/);
  // Arrived late: counted from when they arrived.
  assert.equal(runningBehind([{ ...waiting, arrived_at: `${D} 09:20` }], `${D} 09:22`, S), null);

  // Over time in the chair, and the next patient is here.
  const over = visit(2, '10:00', '11:00', 'in_chair');
  const next = visit(3, '11:00', '12:00', 'checked_in', { arrived_at: `${D} 10:55` });
  assert.equal(runningBehind([over, next], `${D} 10:59`, S), null, 'not past the end yet');
  const b = runningBehind([over, next], `${D} 11:12`, S);
  assert.equal(b.minutes, 12, 'the worst of: 12 over time, next waited 12 − 5');
  assert.match(b.reason, /12 min past their end time/);
  // Over time but nobody waiting: not behind.
  assert.equal(runningBehind([over, visit(4, '13:00', '14:00')], `${D} 11:30`, S), null);
  // The next one is due (not checked in yet) also counts as waiting.
  assert.equal(runningBehind([over, visit(5, '11:00', '11:30', 'confirmed')], `${D} 11:03`, S).minutes, 3);
  // Other days never count.
  assert.equal(runningBehind([over, next], '2031-01-07 11:12', S), null);
});

const h = harness();
before(async () => {
  while (!h.app) await new Promise((r) => setTimeout(r, 10));
  const api = h.app.router.stack.find((l) => l.handle?.stack?.length > 40).handle;
  const at = api.stack.findIndex((l) => l.handle?.stack);
  api.use(dayTemplateRoutes({ db: h.db }));
  api.stack.splice(at, 0, api.stack.pop());
});

test('late settings: defaults 5 and 10, admin sets 1–60 (very late not before late), audited, practice-scoped', async () => {
  const { api } = await h.practice();
  assert.deepEqual((await api.get('/schedule/late-settings')).data, { late_minutes: 5, very_late_minutes: 10 });
  for (const body of [{ late_minutes: 0 }, { late_minutes: 61 }, { very_late_minutes: 3 }, { late_minutes: 'soon' }, { late_minutes: 5.5 }]) {
    assert.equal((await api.put('/schedule/late-settings', body)).status, 400, JSON.stringify(body));
  }
  const saved = await api.put('/schedule/late-settings', { late_minutes: 7, very_late_minutes: 15 });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual((await api.get('/schedule/late-settings')).data, { late_minutes: 7, very_late_minutes: 15 });
  assert.equal((await api.get('/practice')).data.late_minutes, 7, 'the practice record carries it to every screen');
  const log = await h.db.get("SELECT * FROM audit_log WHERE action = 'practice.late_settings' ORDER BY id DESC");
  assert.deepEqual(JSON.parse(log.changes).late_minutes, [5, 7]);

  const email = `desk-${Date.now()}@example.com`;
  await api.post('/users', { email, name: 'Desk', role: 'front_desk', password: 'desk-password-123' });
  const desk = h.client((await h.client().post('/auth/login', { email, password: 'desk-password-123' })).data.token);
  assert.equal((await desk.get('/schedule/late-settings')).status, 200);
  assert.equal((await desk.put('/schedule/late-settings', { late_minutes: 9 })).status, 403);
  const other = await h.practice();
  assert.deepEqual((await other.api.get('/schedule/late-settings')).data, { late_minutes: 5, very_late_minutes: 10 });
});
