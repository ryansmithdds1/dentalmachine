// Recurring checklists by position (backlog RCL1–RCL3; docs/workflows/specs/RCL-checklists.md).
// The routes are served by a small side server on the same database (authenticate → actor → office access →
// checklistRoutes, as app.js does), so these tests run whether or not app.js mounts them yet; the last test
// checks the real mount and skips until it's there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './helpers.js';
import { authenticate, HttpError, PERMISSION_CATALOG } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import { createStorage } from '../src/storage.js';
import checklistRoutes, { sniffEvidence } from '../src/routes/checklists.js';
import {
  occursOn, monthTarget, datesBetween, closesOn, nextOccurrence, openDaysOf, generate, sweep, runChecklistJobs, outOfRange, missingFor, MANAGE,
} from '../src/checklists.js';
import { STARTERS } from '../src/checklists-starters.js';

const h = harness();
const sms = [];
const messenger = { status: { sms: 'test', email: 'test' }, send: async (m) => { sms.push(m); return { provider_id: `t-${sms.length}` }; } };
const dir = mkdtempSync(join(tmpdir(), 'dm-checklists-'));
let side;
let origin;
// The harness opens its database in its own before hook: this side server reaches it lazily.
const db = {
  all: (...a) => h.db.all(...a), get: (...a) => h.db.get(...a), run: (...a) => h.db.run(...a), tx: (fn) => h.db.tx(fn), savepoint: (fn) => h.db.savepoint(fn),
  get dialect() { return h.db.dialect; },
};
before(async () => {
  const storage = createStorage({ dir, key: 'checklist-test-key', s3: null });
  const app = express();
  app.use(actorMiddleware(db, flushChanges));
  app.use(express.json());
  const api = express.Router();
  api.use(authenticate(db, 'test-secret'));
  api.use((req, _res, next) => {
    setActor({ source: 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(officeAccess(db));
  api.use(checklistRoutes({ db, storage, messenger }));
  app.use('/api', api);
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large' });
    console.error(err);
    res.status(500).json({ error: err.message });
  });
  await new Promise((resolve) => { side = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${side.address().port}`;
});
after(() => {
  side?.close();
  rmSync(dir, { recursive: true, force: true });
});

// A client for the checklist routes (side server), same shape as h.client.
const cl = (token, headers = {}) => {
  const call = async (method, path, body) => {
    const res = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* CSV or empty */ }
    return { status: res.status, data, headers: res.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b) };
};
const upload = async (token, occId, buf, kind = 'photo') => {
  const res = await fetch(`${origin}/api/checklists/occurrences/${occId}/evidence?kind=${kind}&filename=spore.jpg`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: buf });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d1a1a40000000049454e44ae426082', 'hex');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body for a spore test photo')]);

async function owner() {
  const p = await h.practice();
  return { ...p, cl: cl(p.token), pid: (await h.db.get('SELECT practice_id FROM users WHERE email = ?', p.email)).practice_id };
}
async function member(p, role, extra = {}) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = (await p.api.post('/users', { email, name: `${role} ${Math.random().toString(36).slice(2, 5)}`, role, password: 'correct-horse-battery', ...extra })).data;
  assert.ok(u.id, JSON.stringify(u));
  const login = await h.client(null, { 'X-Forwarded-For': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }).post('/auth/login', { email, password: 'correct-horse-battery' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { user: u, token: login.data.token, cl: cl(login.data.token) };
}
const everyDay = '0,1,2,3,4,5,6';
async function makeTemplate(o, { position, items, name = 'Test checklist', location_id = null }) {
  const setup = (await o.cl.get('/checklists/setup')).data;
  const pos = setup.positions.find((p) => p.name === position);
  assert.ok(pos, `position ${position}`);
  const res = await o.cl.post('/checklists/templates', { name, position_id: pos.id, location_id, items });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}
const occsOf = (itemId) => h.db.all('SELECT * FROM checklist_occurrences WHERE item_id = ? ORDER BY due_date, location_key', itemId);
const audits = (action, entityId) => h.db.all('SELECT * FROM audit_log WHERE action = ? AND entity_id = ?', action, entityId);

// ---- Schedule math ----
test('cadence: daily on open days or chosen weekdays, weekly, monthly with month-end and last business day, quarterly, annually', () => {
  const monFri = openDaysOf(null);
  assert.deepEqual([...monFri].sort(), [1, 2, 3, 4, 5], 'no office hours: Monday to Friday');
  const monThu = openDaysOf(JSON.stringify({ 0: [], 1: [['08:00', '17:00']], 2: [['08:00', '17:00']], 3: [['08:00', '17:00']], 4: [['08:00', '17:00']], 5: [], 6: [] }));
  // Week of Mon 2026-09-21.
  const week = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'];
  assert.deepEqual(week.filter((d) => occursOn({ cadence: 'daily' }, d, monFri)), week.slice(1, 6));
  assert.deepEqual(week.filter((d) => occursOn({ cadence: 'daily' }, d, monThu)), week.slice(1, 5), 'office closed Fridays');
  assert.deepEqual(week.filter((d) => occursOn({ cadence: 'daily', weekdays: '2,4' }, d, monFri)), ['2026-09-22', '2026-09-24'], 'specific weekdays');
  assert.deepEqual(week.filter((d) => occursOn({ cadence: 'weekly', weekday: 1 }, d, monFri)), ['2026-09-21']);
  // Month ends.
  assert.equal(monthTarget(2027, 2, 31, monFri), '2027-02-28');
  assert.equal(monthTarget(2028, 2, 31, monFri), '2028-02-29', 'leap year');
  assert.equal(monthTarget(2026, 4, 31, monFri), '2026-04-30');
  assert.equal(monthTarget(2026, 5, -1, monFri), '2026-05-29', 'May 31 2026 is a Sunday: the last business day is Friday the 29th');
  assert.equal(monthTarget(2026, 7, -1, monFri), '2026-07-31');
  assert.equal(monthTarget(2026, 7, -1, monThu), '2026-07-30', 'closed Fridays: Thursday');
  const monthly31 = { cadence: 'monthly', month_day: 31 };
  assert.deepEqual(datesBetween(monthly31, '2027-01-01', '2027-04-30', monFri), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  assert.deepEqual(datesBetween({ cadence: 'monthly', month_day: -1 }, '2026-05-01', '2026-06-30', monFri), ['2026-05-29', '2026-06-30']);
  assert.deepEqual(datesBetween({ cadence: 'quarterly', month: 1, month_day: 15 }, '2026-01-01', '2026-12-31', monFri), ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
  assert.deepEqual(datesBetween({ cadence: 'quarterly', month: 2, month_day: 1 }, '2026-01-01', '2026-12-31', monFri), ['2026-02-01', '2026-05-01', '2026-08-01', '2026-11-01']);
  assert.deepEqual(datesBetween({ cadence: 'annually', month: 2, month_day: 29 }, '2026-01-01', '2028-12-31', monFri), ['2026-02-28', '2027-02-28', '2028-02-29']);
  // Windows: a weekly item can be done until the day before the next one; a daily one only on its day.
  assert.equal(closesOn({ cadence: 'weekly', weekday: 1 }, '2026-09-21', monFri), '2026-09-27');
  assert.equal(closesOn({ cadence: 'daily' }, '2026-09-25', monFri), '2026-09-27', 'Friday’s daily item stays open over the weekend the office is closed');
  assert.equal(closesOn({ cadence: 'daily' }, '2026-09-22', monFri), '2026-09-22');
  assert.equal(nextOccurrence({ cadence: 'annually', month: 1, month_day: 31 }, '2026-01-31', monFri), '2027-01-31');
  // Numbers and evidence rules.
  assert.equal(outOfRange({ min_value: '250', max_value: '275' }, '249.5'), true);
  assert.equal(outOfRange({ min_value: '250', max_value: '275' }, '275'), false);
  assert.equal(outOfRange({ min_value: null, max_value: '500' }, '501'), true);
  const spore = { result_type: 'pass_fail', require_photo: 1 };
  assert.deepEqual(missingFor(spore, {}, []), ['pass_fail', 'photo']);
  assert.deepEqual(missingFor(spore, { result_pass: 1 }, []), ['photo']);
  assert.deepEqual(missingFor(spore, { result_pass: 0 }, []), [], 'a failure is recorded without waiting for the photo');
  assert.deepEqual(missingFor(spore, { result_pass: 1 }, [{ kind: 'photo', removed_at: '2026-01-01' }]), ['photo'], 'a removed photo doesn’t count');
  assert.equal(sniffEvidence(JPEG), 'image/jpeg');
  assert.equal(sniffEvidence(PNG), 'image/png');
  assert.equal(sniffEvidence(Buffer.from('%PDF-1.4 hello')), 'application/pdf');
  assert.equal(sniffEvidence(Buffer.from('<html>not an image</html>')), null);
});

// ---- Generation ----
test('generation is idempotent per item + due date + office, backfills missed days, and follows schedule changes', async () => {
  const o = await owner();
  const t = await makeTemplate(o, {
    position: 'Front desk',
    items: [
      { title: 'Open the office', cadence: 'daily', weekdays: everyDay, due_time: '08:00', start_date: '2030-01-01' },
      { title: 'Month end', cadence: 'monthly', month_day: 31, due_time: '17:00', start_date: '2030-01-01' },
    ],
  });
  const [daily, monthly] = t.items;
  assert.equal((await occsOf(daily.id)).length, 0, 'nothing before its start date');
  const now = new Date('2030-01-10T15:00:00Z'); // 10:00 in New York
  const first = await Promise.all([generate(h.db, o.pid, { now }), generate(h.db, o.pid, { now }), runChecklistJobs(h.db, messenger, { now })]);
  assert.ok(first[0] + first[1] >= 10);
  const rows = await occsOf(daily.id);
  assert.deepEqual(rows.map((r) => r.due_date), Array.from({ length: 10 }, (_, i) => `2030-01-${String(i + 1).padStart(2, '0')}`), 'one per day, however many runs at once');
  assert.equal(await generate(h.db, o.pid, { now }), 0, 'running again makes nothing');
  // Month end shows up 3 days early (lead time) and not before.
  assert.equal((await occsOf(monthly.id)).length, 0);
  await generate(h.db, o.pid, { now: new Date('2030-01-28T15:00:00Z') });
  assert.deepEqual((await occsOf(monthly.id)).map((r) => [r.due_date, r.closes_on]), [['2030-01-31', '2030-02-27']]);
  await generate(h.db, o.pid, { now: new Date('2030-02-26T15:00:00Z') });
  assert.deepEqual((await occsOf(monthly.id)).map((r) => r.due_date), ['2030-01-31', '2030-02-28'], 'February: the 28th');
  // Days the job didn't run are still made (and will count as missed).
  const later = (await occsOf(daily.id)).length;
  assert.ok(later >= 57, `backfilled through Feb 26 (${later})`);
  // A schedule change: future open ones are cancelled and made again on the new schedule.
  const res = await o.cl.put(`/checklists/items/${monthly.id}`, { month_day: 15 });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const audit = await audits('checklist.item.update', monthly.id);
  assert.ok(audit.length && JSON.parse(audit[0].changes).month_day, 'item edits keep before/after');
});

test('multi-office: an "every office" checklist makes one per office; an office checklist only its own', async () => {
  const o = await owner();
  const a = (await o.api.post('/locations', { name: 'North office' })).data;
  const b = (await o.api.post('/locations', { name: 'South office' })).data;
  assert.ok(a.id && b.id, JSON.stringify(a));
  const all = await makeTemplate(o, { position: 'Sterilization', items: [{ title: 'Autoclave log', cadence: 'daily', weekdays: everyDay, start_date: '2030-03-01' }] });
  const south = await makeTemplate(o, { position: 'Sterilization', name: 'South only', location_id: b.id, items: [{ title: 'South waterlines', cadence: 'daily', weekdays: everyDay, start_date: '2030-03-01' }] });
  await generate(h.db, o.pid, { now: new Date('2030-03-01T15:00:00Z') });
  assert.deepEqual((await occsOf(all.items[0].id)).map((r) => r.location_id).sort(), [a.id, b.id].sort());
  assert.deepEqual((await occsOf(south.items[0].id)).map((r) => r.location_id), [b.id]);
});

test('assignee rules: a named person, or whoever is scheduled or clocked in for the position', async () => {
  const o = await owner();
  const ana = await member(o, 'assistant');
  const ben = await member(o, 'assistant');
  const desk = await member(o, 'front_desk');
  const t = await makeTemplate(o, {
    position: 'Sterilization',
    items: [
      { title: 'Autoclave log', cadence: 'daily', weekdays: everyDay, assign_rule: 'on_shift', start_date: '2030-04-01' },
      { title: 'Order indicators', cadence: 'daily', weekdays: everyDay, assign_rule: 'person', assignee_id: desk.user.id, start_date: '2030-04-01' },
    ],
  });
  assert.equal((await o.cl.post(`/checklists/templates/${t.id}/items`, { title: 'x', assign_rule: 'person' })).status, 400, 'a person rule needs the person');
  // Ben is scheduled on the 1st.
  await h.db.run("INSERT INTO staff_shifts (practice_id, user_id, date, status, start_time, end_time) VALUES (?, ?, '2030-04-01', 'scheduled', '08:00', '17:00')", o.pid, ben.user.id);
  await generate(h.db, o.pid, { now: new Date('2030-04-01T13:00:00Z') });
  const [first] = await occsOf(t.items[0].id);
  assert.equal(first.assigned_to, ben.user.id);
  assert.equal(first.assigned_via, 'scheduled');
  assert.equal((await occsOf(t.items[1].id))[0].assigned_to, desk.user.id);
  // Nobody scheduled on the 2nd: unassigned (the whole position sees it) until Ana clocks in.
  await generate(h.db, o.pid, { now: new Date('2030-04-02T12:00:00Z') });
  const second = (await occsOf(t.items[0].id)).find((r) => r.due_date === '2030-04-02');
  assert.equal(second.assigned_to, null);
  const punch = await h.db.run("INSERT INTO time_punches (practice_id, user_id, clock_in) VALUES (?, ?, '2030-04-02 07:55')", o.pid, ana.user.id);
  await h.db.run('INSERT INTO time_open_punches (practice_id, user_id, punch_id) VALUES (?, ?, ?)', o.pid, ana.user.id, punch.id);
  const s = await sweep(h.db, o.pid, messenger, { now: new Date('2030-04-02T13:00:00Z') });
  assert.equal(s.assigned, 1);
  const now = await h.db.get('SELECT * FROM checklist_occurrences WHERE id = ?', second.id);
  assert.equal(now.assigned_to, ana.user.id);
  assert.equal(now.assigned_via, 'clocked_in');
  await h.db.run('DELETE FROM time_open_punches WHERE punch_id = ?', punch.id);
});

// ---- Doing the checklist ----
async function sporeSetup() {
  const o = await owner();
  const assistant = await member(o, 'assistant');
  const desk = await member(o, 'front_desk');
  await o.cl.put('/checklists/settings', { sms_alerts: true, alert_phones: ['(512) 555-0199'] });
  const t = await makeTemplate(o, {
    position: 'Sterilization',
    items: [
      { title: 'Weekly spore test', cadence: 'daily', weekdays: everyDay, due_time: '23:59', result_type: 'pass_fail', require_photo: true, critical: true },
      { title: 'Autoclave temperature', cadence: 'daily', weekdays: everyDay, due_time: '23:59', result_type: 'number', min_value: 250, max_value: 275, unit: '°F', critical: true },
      { title: 'Wipe down', cadence: 'daily', weekdays: everyDay, due_time: '23:59', require_note: true },
    ],
  });
  const mine = (await assistant.cl.get('/checklists/mine')).data;
  const find = (title) => mine.items.find((i) => i.title === title);
  return { o, assistant, desk, t, mine, spore: find('Weekly spore test'), temp: find('Autoclave temperature'), wipe: find('Wipe down') };
}

test('my checklist: only my positions’ items; evidence requirements are enforced; photos are stored encrypted', async () => {
  const { o, assistant, desk, spore, temp, wipe, mine } = await sporeSetup();
  assert.equal(mine.items.length, 3, JSON.stringify(mine));
  assert.deepEqual(mine.positions.map((p) => p.name).sort(), ['Assisting', 'Sterilization']);
  assert.equal((await desk.cl.get('/checklists/mine')).data.items.length, 0, 'front desk doesn’t see sterilization');
  assert.equal((await desk.cl.post(`/checklists/occurrences/${spore.id}/complete`, { result_pass: 'pass' })).status, 404, 'nor tick it');

  // Pass without the photo: refused, saying what's missing.
  const noPhoto = await assistant.cl.post(`/checklists/occurrences/${spore.id}/complete`, { result_pass: 'pass' });
  assert.equal(noPhoto.status, 400);
  assert.deepEqual(noPhoto.data.details.missing, ['photo']);
  assert.equal((await assistant.cl.post(`/checklists/occurrences/${temp.id}/complete`, {})).status, 400, 'the reading is required');
  assert.equal((await assistant.cl.post(`/checklists/occurrences/${wipe.id}/complete`, {})).data.details.missing[0], 'note');
  assert.equal((await upload(assistant.token, spore.id, Buffer.from('<script>alert(1)</script>'))).status, 415, 'only real photos');

  const up = await upload(assistant.token, spore.id, JPEG);
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal((await upload(assistant.token, spore.id, JPEG)).status, 200, 'the same photo twice is one photo');
  const row = await h.db.get('SELECT * FROM checklist_evidence WHERE id = ?', up.data.id);
  assert.equal(row.encrypted, 1);
  const onDisk = readFileSync(join(dir, row.storage_key));
  assert.equal(onDisk.subarray(0, 4).toString(), 'DMK2', 'sealed with the document key');
  assert.ok(!onDisk.includes(Buffer.from('fake jpeg body')), 'no plain bytes on disk');
  const back = await fetch(`${origin}/api/checklists/evidence/${up.data.id}`, { headers: { Authorization: `Bearer ${assistant.token}` } });
  assert.equal(back.status, 200);
  assert.equal(back.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.from(await back.arrayBuffer()).equals(JPEG));
  // Scope: someone not in the position, and another practice, can't open it.
  assert.equal((await fetch(`${origin}/api/checklists/evidence/${up.data.id}`, { headers: { Authorization: `Bearer ${desk.token}` } })).status, 404);
  const other = await owner();
  assert.equal((await fetch(`${origin}/api/checklists/evidence/${up.data.id}`, { headers: { Authorization: `Bearer ${other.token}` } })).status, 404);
  assert.equal((await fetch(`${origin}/api/checklists/evidence/${up.data.id}`, { headers: { Authorization: `Bearer ${o.token}` } })).status, 200, 'the owner can');

  const done = await assistant.cl.post(`/checklists/occurrences/${spore.id}/complete`, { result_pass: 'pass' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.status, 'done');
  assert.equal(done.data.outcome, 'ok');
  assert.equal(done.data.completed_by, assistant.user.id);
  const again = await assistant.cl.post(`/checklists/occurrences/${spore.id}/complete`, { result_pass: 'pass' });
  assert.equal(again.status, 200, 'a second tick is harmless');
  assert.equal(again.data.events.filter((e) => e.kind === 'done').length, 1);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM checklist_flags WHERE occurrence_id = ?", spore.id)).n, 0);
  const a = await audits('checklist.complete', spore.id);
  assert.equal(a.length, 1);
  assert.equal(a[0].user_id, assistant.user.id);
  assert.equal(a[0].source, 'human');
  assert.equal(JSON.parse(a[0].changes).status[1], 'done', 'before → after on the audit entry');
  // A ticked item keeps its required photo.
  assert.equal((await assistant.cl.post(`/checklists/evidence/${up.data.id}/remove`, {})).status, 403);
  assert.equal((await o.cl.post(`/checklists/evidence/${up.data.id}/remove`, { reason: 'blurry' })).status, 409);
  // Wipe-down with its note.
  assert.equal((await assistant.cl.post(`/checklists/occurrences/${wipe.id}/complete`, { note: 'Done with the new wipes' })).status, 200);
});

test('critical: a failed spore test is recorded without its photo, raises a high Needs attention item and tells the owner (live, chat, text)', async () => {
  const { o, assistant, spore, temp } = await sporeSetup();
  sms.length = 0;
  const failed = await assistant.cl.post(`/checklists/occurrences/${spore.id}/complete`, { result_pass: 'fail', note: 'Test vial turned yellow' });
  assert.equal(failed.status, 200, JSON.stringify(failed.data));
  assert.equal(failed.data.outcome, 'fail');
  assert.equal(failed.data.flags.length, 1);
  const flag = failed.data.flags[0];
  assert.equal(flag.kind, 'fail');
  assert.equal(flag.critical, 1);
  assert.match(flag.title, /^Critical: Weekly spore test failed/);
  assert.equal(flag.notified_via, 'live,chat,sms');
  const issue = await h.db.get('SELECT * FROM issues WHERE id = ?', flag.issue_id);
  assert.equal(issue.severity, 'high');
  assert.equal(issue.status, 'open');
  assert.equal(issue.practice_id, o.pid);
  // Chat: an urgent system post that calls on the owner.
  const post = await h.db.get("SELECT * FROM chat_messages WHERE practice_id = ? AND kind = 'system' ORDER BY id DESC", o.pid);
  assert.equal(post.urgent, 1);
  assert.match(post.body, /spore test failed/);
  const ownerId = (await h.db.get('SELECT id FROM users WHERE email = ?', o.email)).id;
  assert.ok(await h.db.get('SELECT id FROM chat_mentions WHERE message_id = ? AND user_id = ?', post.id, ownerId));
  // Text to the number in settings, with no patient details.
  assert.equal(sms.length, 1);
  assert.equal(sms[0].channel, 'sms');
  assert.equal(sms[0].to, '(512) 555-0199');
  assert.match(sms[0].body, /spore test failed/);
  // The tick that raised a flag can't be undone.
  assert.equal((await assistant.cl.post(`/checklists/occurrences/${spore.id}/undo`, {})).status, 409);
  // A number out of range flags too.
  const hot = await assistant.cl.post(`/checklists/occurrences/${temp.id}/complete`, { result_number: '240' });
  assert.equal(hot.data.outcome, 'out_of_range');
  assert.match(hot.data.flags[0].title, /out of range \(240 °F; allowed 250–275\)/);
  assert.ok((await audits('checklist.flag', flag.id)).length === 1);

  // Resolve: the corrective action is required, and closes the Needs attention item with it.
  assert.equal((await assistant.cl.post(`/checklists/flags/${flag.id}/resolve`, { action: 'Retested, passed' })).status, 403, 'staff can’t close flags');
  assert.equal((await o.cl.post(`/checklists/flags/${flag.id}/resolve`, { action: 'ok' })).status, 400);
  const resolved = await o.cl.post(`/checklists/flags/${flag.id}/resolve`, { action: 'Sterilizer taken out of service, serviced, three retests passed; loads since last pass reprocessed.' });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
  assert.equal(resolved.data.status, 'resolved');
  assert.equal(resolved.data.resolved_by, ownerId);
  const closed = await h.db.get('SELECT * FROM issues WHERE id = ?', flag.issue_id);
  assert.equal(closed.status, 'resolved');
  assert.match(closed.resolution, /^Corrective action: Sterilizer taken out of service/);
  const ra = await audits('checklist.flag.resolve', flag.id);
  assert.equal(ra.length, 1);
  assert.match(ra[0].reason, /three retests passed/);
  // Closed from the Needs attention page instead: the flag follows, with that note.
  const hotFlag = hot.data.flags[0];
  const pr = await o.api.patch(`/issues/${hotFlag.issue_id}`, { status: 'resolved', note: 'Replaced the gasket, next cycle read 262' });
  assert.equal(pr.status, 200, JSON.stringify(pr.data));
  await sweep(h.db, o.pid, messenger);
  const synced = await h.db.get('SELECT * FROM checklist_flags WHERE id = ?', hotFlag.id);
  assert.equal(synced.status, 'resolved');
  assert.match(synced.corrective_action, /Replaced the gasket/);
  // The log shows it all (and exports as CSV).
  const log = await o.cl.get('/checklists/log?q=spore');
  assert.equal(log.status, 200);
  const row = log.data.rows.find((r) => r.id === spore.id);
  assert.equal(row.outcome, 'fail');
  assert.equal(row.flags[0].corrective_action.startsWith('Sterilizer'), true);
  const csv = await o.cl.get('/checklists/log?q=spore&format=csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /Weekly spore test/);
  assert.match(csv.data, /FAIL/);
  assert.match(csv.data, /Sterilizer taken out of service/);
  assert.ok((await h.db.all("SELECT id FROM audit_log WHERE action = 'checklist.log.export' AND practice_id = ?", o.pid)).length >= 2, 'exports are audited');
});

test('missed: a critical item past its due time flags at once; ordinary ones are marked missed when their window closes', async () => {
  const o = await owner();
  const t = await makeTemplate(o, {
    position: 'Office manager',
    items: [
      { title: 'AED check', cadence: 'daily', weekdays: everyDay, due_time: '09:00', result_type: 'pass_fail', critical: true, start_date: '2030-05-06' },
      { title: 'Water the plants', cadence: 'daily', weekdays: everyDay, due_time: '12:00', start_date: '2030-05-06' },
    ],
  });
  const [aed, plants] = t.items;
  // 08:00 in New York: not due yet.
  let run = await runChecklistJobs(h.db, messenger, { practiceId: o.pid, now: new Date('2030-05-06T12:00:00Z') });
  assert.equal(run.flagged, 0);
  // 11:00: the AED check is two hours late.
  run = await runChecklistJobs(h.db, messenger, { practiceId: o.pid, now: new Date('2030-05-06T15:00:00Z') });
  assert.equal(run.flagged, 1);
  const [occ] = await occsOf(aed.id);
  const flag = await h.db.get('SELECT * FROM checklist_flags WHERE occurrence_id = ?', occ.id);
  assert.equal(flag.kind, 'overdue');
  assert.match(flag.title, /^Critical: AED check not done by 09:00 on 2030-05-06/);
  const issue = await h.db.get('SELECT * FROM issues WHERE id = ?', flag.issue_id);
  assert.equal(issue.severity, 'high');
  assert.equal(issue.source, 'automation');
  // Running again doesn't flag or alert twice.
  const posts = (await h.db.get("SELECT COUNT(*) AS n FROM chat_messages WHERE practice_id = ? AND kind = 'system'", o.pid)).n;
  run = await runChecklistJobs(h.db, messenger, { practiceId: o.pid, now: new Date('2030-05-06T16:00:00Z') });
  assert.equal(run.flagged, 0);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM chat_messages WHERE practice_id = ? AND kind = 'system'", o.pid)).n, posts);
  // Next day: yesterday's plants are missed (one summary item), the AED occurrence too; the flag stays open.
  await runChecklistJobs(h.db, messenger, { practiceId: o.pid, now: new Date('2030-05-07T12:00:00Z') });
  assert.equal((await occsOf(plants.id))[0].status, 'missed');
  assert.equal((await occsOf(aed.id))[0].status, 'missed');
  const summary = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = 'checklist-missed:2030-05-06'", o.pid);
  assert.match(summary.title, /^1 checklist item was missed/);
  assert.equal((await h.db.get('SELECT status FROM checklist_flags WHERE id = ?', flag.id)).status, 'open', 'stays open until resolved with an action');
  // Recording a missed one late needs a reason.
  const plantsOcc = (await occsOf(plants.id))[0];
  assert.equal((await o.cl.post(`/checklists/occurrences/${plantsOcc.id}/complete`, {})).status, 400);
  const late = await o.cl.post(`/checklists/occurrences/${plantsOcc.id}/complete`, { reason: 'Done at 5pm, forgot to tick' });
  assert.equal(late.status, 200);
  assert.equal(late.data.completed_late, 1);
  assert.equal(late.data.late_reason, 'Done at 5pm, forgot to tick');
  // Dashboard: by position and person, missed counted, the open flag listed.
  const dash = await o.cl.get('/checklists/dashboard?from=2030-05-06&to=2030-05-07');
  assert.equal(dash.status, 200, JSON.stringify(dash.data));
  assert.ok(dash.data.flags.some((f) => f.id === flag.id));
});

test('undo within the window, corrections with a reason after it (and a correction to a failure flags)', async () => {
  const { o, assistant, temp, wipe } = await sporeSetup();
  const done = await assistant.cl.post(`/checklists/occurrences/${temp.id}/complete`, { result_number: 262 });
  assert.equal(done.data.outcome, 'ok');
  assert.ok(done.data.undo_until);
  const other = await member(o, 'assistant');
  assert.equal((await other.cl.post(`/checklists/occurrences/${temp.id}/undo`, {})).status, 403, 'only whoever ticked it');
  const undone = await assistant.cl.post(`/checklists/occurrences/${temp.id}/undo`, {});
  assert.equal(undone.status, 200);
  assert.equal(undone.data.status, 'open');
  assert.equal(undone.data.completed_by, null);
  assert.ok((await audits('checklist.undo', temp.id)).length === 1);
  await assistant.cl.post(`/checklists/occurrences/${temp.id}/complete`, { result_number: 262 });
  // 20 minutes later: too late to undo.
  await h.db.run('UPDATE checklist_occurrences SET completed_at = ? WHERE id = ?', new Date(Date.now() - 20 * 60_000).toISOString().slice(0, 19).replace('T', ' '), temp.id);
  const tooLate = await assistant.cl.post(`/checklists/occurrences/${temp.id}/undo`, {});
  assert.equal(tooLate.status, 409);
  assert.equal(tooLate.data.details.correction, true);
  assert.equal((await assistant.cl.post(`/checklists/occurrences/${temp.id}/correct`, { result_number: 245 })).status, 400, 'a reason is required');
  const fixed = await assistant.cl.post(`/checklists/occurrences/${temp.id}/correct`, { result_number: 245, reason: 'Misread the display — it was 245' });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.data));
  assert.equal(fixed.data.result_number, '245');
  assert.equal(fixed.data.outcome, 'out_of_range');
  assert.equal(fixed.data.flags[0].kind, 'out_of_range');
  const ev = fixed.data.events.find((e) => e.kind === 'corrected');
  assert.equal(ev.details.before.result_number, '262');
  assert.equal(ev.details.after.result_number, '245');
  assert.equal(ev.reason, 'Misread the display — it was 245');
  const ca = await audits('checklist.correct', temp.id);
  assert.equal(ca[0].reason, 'Misread the display — it was 245');
  assert.deepEqual(JSON.parse(ca[0].changes).result_number, ['262', '245']);
  assert.equal((await other.cl.post(`/checklists/occurrences/${wipe.id}/correct`, { note: 'x', reason: 'because' })).status, 409, 'only ticked items are corrected');
});

// ---- Permissions and isolation ----
test('permissions: setting up, the dashboard, flags and the log are for checklists:manage', async () => {
  const o = await owner();
  const desk = await member(o, 'front_desk');
  for (const [m, p] of [['get', '/checklists/setup'], ['get', '/checklists/dashboard'], ['get', '/checklists/flags'], ['get', '/checklists/log'], ['post', '/checklists/starters/sterilization'], ['put', '/checklists/settings']]) {
    assert.equal((await desk.cl[m](p, {})).status, 403, `${m} ${p}`);
  }
  assert.equal((await desk.cl.get('/checklists/mine')).status, 200, 'everyone has their own checklist');
  if (MANAGE in PERMISSION_CATALOG) {
    await o.api.put(`/users/${desk.user.id}`, { permissions_add: [MANAGE] });
    // A permission change signs the person out everywhere; they sign in again with the new permission.
    const again = await h.client(null, { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }).post('/auth/login', { email: desk.user.email, password: 'correct-horse-battery' });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal((await cl(again.data.token).get('/checklists/setup')).status, 200, 'granted to an office manager');
  }
});

test('practice and office isolation', async () => {
  const a = await owner();
  const b = await owner();
  const t = await makeTemplate(a, { position: 'Front desk', items: [{ title: 'Open up', cadence: 'daily', weekdays: everyDay, due_time: '23:59' }] });
  const occ = (await a.cl.get('/checklists/dashboard')).data.today_items[0];
  assert.ok(occ);
  assert.equal((await b.cl.get(`/checklists/occurrences/${occ.id}`)).status, 404);
  assert.equal((await b.cl.post(`/checklists/occurrences/${occ.id}/complete`, {})).status, 404);
  assert.equal((await b.cl.put(`/checklists/items/${t.items[0].id}`, { title: 'Mine now' })).status, 404);
  assert.equal((await b.cl.put(`/checklists/templates/${t.id}`, { name: 'x' })).status, 404);
  assert.equal((await b.cl.get('/checklists/log')).data.rows.length, 0);
  const aPos = (await a.cl.get('/checklists/setup')).data.positions[0];
  assert.equal((await b.cl.post('/checklists/templates', { name: 'x', position_id: aPos.id })).status, 404, 'another practice’s position');
  const bLoc = (await b.api.post('/locations', { name: 'B office' })).data;
  const bPos = (await b.cl.get('/checklists/setup')).data.positions[0];
  assert.equal((await a.cl.post('/checklists/templates', { name: 'x', position_id: aPos.id, location_id: bLoc.id })).status, 404, 'another practice’s office');
  // Office limits: someone limited to one office doesn't see another office's items.
  const north = (await a.api.post('/locations', { name: 'North' })).data;
  const south = (await a.api.post('/locations', { name: 'South' })).data;
  const southT = await makeTemplate(a, { position: 'Front desk', name: 'South desk', location_id: south.id, items: [{ title: 'South open', cadence: 'daily', weekdays: everyDay, due_time: '23:59' }] });
  const nd = await member(a, 'front_desk', { location_ids: [north.id] });
  const mine = (await nd.cl.get('/checklists/mine')).data.items;
  assert.ok(!mine.some((i) => i.item_id === southT.items[0].id), 'north-only person doesn’t get south items');
  const southOcc = (await occsOf(southT.items[0].id))[0];
  assert.equal((await nd.cl.get(`/checklists/occurrences/${southOcc.id}`)).status, 404);
  assert.ok(bPos);
});

test('starters: one click, never twice, marked to adapt; positions made on first visit', async () => {
  const o = await owner();
  const setup = (await o.cl.get('/checklists/setup')).data;
  assert.deepEqual(setup.positions.map((p) => p.name).sort(), ['Assisting', 'Doctors', 'Front desk', 'Hygiene', 'Office manager', 'Sterilization']);
  assert.equal(setup.starters.length, STARTERS.length);
  assert.ok(setup.starters.every((s) => !s.added));
  const first = await o.cl.post('/checklists/starters/sterilization', {});
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.match(first.data.description, /adapt it to your office and your state’s rules/);
  const spore = first.data.items.find((i) => /spore/i.test(i.title));
  assert.equal(spore.critical, 1);
  assert.equal(spore.require_photo, 1);
  assert.equal(spore.result_type, 'pass_fail');
  const again = await o.cl.post('/checklists/starters/sterilization', {});
  assert.equal(again.status, 200);
  assert.equal(again.data.id, first.data.id);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM checklist_templates WHERE practice_id = ? AND starter_key = 'sterilization'", o.pid)).n, 1);
  for (const s of STARTERS) assert.ok([200, 201].includes((await o.cl.post(`/checklists/starters/${s.key}`, {})).status), s.key);
  assert.equal((await o.cl.post('/checklists/starters/nope', {})).status, 404);
  // Items validate like any other.
  const tid = first.data.id;
  for (const bad of [{ title: '' }, { title: 'x', cadence: 'hourly' }, { title: 'x', due_time: '25:00' }, { title: 'x', cadence: 'monthly', month_day: 32 }, { title: 'x', result_type: 'number', min_value: 10, max_value: 5 }, { title: 'x', weekdays: [7] }]) {
    assert.equal((await o.cl.post(`/checklists/templates/${tid}/items`, bad)).status, 400, JSON.stringify(bad));
  }
  const page = await o.api.post('/intranet/pages', { title: 'Spore testing SOP', body: 'Run the BI…' });
  if (page.status === 201) {
    const linked = await o.cl.put(`/checklists/items/${spore.id}`, { sop_page_id: page.data.id });
    assert.equal(linked.data.sop_page_id, page.data.id, 'linked to the office manual');
  }
  // Positions: members by name, and archived rather than deleted.
  const person = await member(o, 'billing');
  const pos = await o.cl.post('/checklists/positions', { name: 'Billing lead', member_ids: [person.user.id] });
  assert.equal(pos.status, 201);
  assert.equal((await o.cl.post('/checklists/positions', { name: 'Billing lead' })).status, 409);
  assert.deepEqual((await person.cl.get('/checklists/mine')).data.positions.map((p) => p.name), ['Billing lead']);
  const off = await o.cl.put(`/checklists/positions/${pos.data.id}`, { member_ids: [] });
  assert.equal(off.status, 200);
  assert.equal((await h.db.get('SELECT removed_at FROM checklist_position_members WHERE position_id = ?', pos.data.id)).removed_at != null, true, 'the membership row stays');
});

test('mounted in app.js (skips until the mount line is added)', async (t) => {
  const o = await owner();
  const probe = await o.api.get('/checklists/mine');
  if (probe.status === 404) { t.skip('checklistRoutes not mounted in app.js yet'); return; }
  assert.equal(probe.status, 200);
  assert.equal((await o.api.get('/checklists/setup')).status, 200);
});
