// Team chat and tasks (routes/chat.js): who can see what, history kept on edit/delete, idempotent sends,
// unread counts, urgent acknowledgements, tasks from messages, recurring tasks, and GIFs off by default.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { authenticate, HttpError } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { idempotency } from '../src/idempotency.js';
import { officeAccess } from '../src/officeaccess.js';
import { flushChanges } from '../src/util.js';
import chatRoutes from '../src/routes/chat.js';
import { runRecurringTasks, runChatDigests, firstOnOrAfter, nextAfter, inQuietHours } from '../src/chat.js';
import { cleanGifQuery, cleanGif } from '../src/gifs.js';

// Every outside call the app makes goes through here: GIF providers must never be reached from tests.
const outside = [];
const spyFetch = (url, opts) => {
  outside.push(String(url));
  return globalThis.fetch(url, opts);
};
const gifCalls = () => outside.filter((u) => /tenor|giphy/i.test(u));

const h = harness({ fetchImpl: spyFetch });
let origin;
let mini;

// The chat routes as app.js mounts them (api.use(chatRoutes(...)) after sign-in, the actor, idempotency and
// office access). If app.js already mounts them, the tests use the real app; otherwise this same chain.
let ready = null;
const setup = () => (ready ??= mount());
async function mount() {
  const reg = await h.client(null, { 'X-Forwarded-For': '10.78.0.1' }).post('/auth/register', { practice_name: 'Probe', name: 'Probe', email: `probe-${Date.now()}@example.com`, password: 'correct-horse-battery' });
  const probe = await h.client(reg.data.token).get('/chat/unread');
  if (probe.status !== 404) {
    origin = h.origin;
    return;
  }
  const app = express();
  app.use(actorMiddleware(h.db, flushChanges));
  app.use(express.json({ limit: '1mb' }));
  const api = express.Router();
  api.use(authenticate(h.db, 'test-secret'));
  api.use((req, _res, next) => {
    setActor({ source: 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(idempotency(h.db, 'test-secret', { scopeOf: (req) => `u${req.user.id}:${req.session_id ?? ''}` }));
  api.use(officeAccess(h.db));
  api.use(chatRoutes({ db: h.db, storage: h.app.locals.storage, messenger: h.messenger, fetchImpl: spyFetch }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (/unique/i.test(String(err.message))) return res.status(409).json({ error: 'Record already exists' });
    console.error(err);
    res.status(500).json({ error: err.message });
  });
  await new Promise((resolve) => { mini = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${mini.address().port}`;
}
after(() => mini?.close());

const chat = (token, headers = {}) => {
  const call = async (method, path, body, extra = {}) => {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(`${origin}/api${path}`, {
      method,
      headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', Authorization: `Bearer ${token}`, ...headers, ...extra },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let data = buf;
    try { data = JSON.parse(buf.toString()); } catch { /* a file */ }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (p) => call('GET', p), post: (p, b = {}, x) => call('POST', p, b, x), put: (p, b) => call('PUT', p, b), del: (p, b) => call('DELETE', p, b),
  };
};

// Sign-in is rate limited per address: each sign-in here comes from its own (private-network) address.
const anon = () => h.client(null, { 'X-Forwarded-For': `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
async function practice() {
  const email = `chat-admin-${Math.random().toString(36).slice(2, 9)}@example.com`;
  const reg = await anon().post('/auth/register', { practice_name: 'Chat Dental', name: 'Admin', email, password: 'correct-horse-battery' });
  const api = h.client(reg.data.token);
  const patient = (await api.post('/patients', { first_name: 'Jane', last_name: 'Doe', dob: '1985-04-12', phone: '(512) 555-0100', email: 'jane@example.com' })).data;
  return { api, token: reg.data.token, email, patient };
}

// A practice with its admin plus named teammates: { admin, people: { maria: { id, c }, … }, patient, api }.
async function office(team = [['Maria Lopez', 'front_desk'], ['Bob Smith', 'hygienist']], extra = {}) {
  await setup();
  const p = await practice();
  const out = { ...p, admin: { c: chat(p.token), id: (await p.api.get('/auth/me')).data.user.id }, people: {} };
  for (const [name, role, more = {}] of team) {
    const email = `${name.split(' ')[0].toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const u = (await p.api.post('/users', { email, name, role, password: 'correct-horse-battery', ...more })).data;
    const login = await anon().post('/auth/login', { email, password: 'correct-horse-battery' });
    out.people[name.split(' ')[0].toLowerCase()] = { id: u.id, c: chat(login.data.token, extra[name] || {}), token: login.data.token };
  }
  return out;
}
const channel = async (c, slug) => (await c.get('/chat/bootstrap')).data.channels.find((x) => x.slug === slug);
const send = (c, channelId, body) => c.post(`/chat/channels/${channelId}/messages`, typeof body === 'string' ? { body } : body);

test('default channels, practice isolation: nothing crosses practices', async () => {
  const a = await office();
  const b = await office();
  const boot = (await a.admin.c.get('/chat/bootstrap')).data;
  assert.deepEqual(boot.channels.filter((c) => c.kind === 'channel').map((c) => c.name), ['Everyone', 'Front desk', 'Clinical']);
  assert.ok(boot.channels.find((c) => c.slug === 'everyone').member, 'everyone joins the Everyone channel');
  // Role channels: the hygienist is in Clinical, not Front desk.
  const bob = (await a.people.bob.c.get('/chat/bootstrap')).data.channels;
  assert.equal(bob.find((c) => c.slug === 'clinical').member, true);
  assert.equal(bob.find((c) => c.slug === 'front-desk').member, false);

  const everyone = boot.channels.find((c) => c.slug === 'everyone');
  const msg = (await send(a.admin.c, everyone.id, 'Lunch is here')).data;
  assert.equal(msg.body, 'Lunch is here');

  const other = b.admin.c;
  assert.equal((await other.get(`/chat/channels/${everyone.id}/messages`)).status, 404);
  assert.equal((await send(other, everyone.id, 'hi')).status, 404);
  assert.equal((await other.get(`/chat/messages/${msg.id}`)).status, 404);
  assert.equal((await other.post(`/chat/messages/${msg.id}/reactions`, { emoji: '👍' })).status, 404);
  assert.equal((await other.post(`/chat/messages/${msg.id}/ack`)).status, 404);
  assert.equal((await other.post(`/chat/messages/${msg.id}/task`, {})).status, 404);
  assert.equal((await other.del(`/chat/messages/${msg.id}`)).status, 404);
  assert.equal((await other.post('/chat/dms', { user_ids: [a.people.maria.id] })).status, 404, "can't DM another practice's staff");
  assert.equal((await send(other, (await channel(other, 'everyone')).id, { body: 'x', patient_id: a.patient.id })).status, 404, "can't link another practice's patient");
  assert.ok(!(await other.get('/chat/search?q=lunch')).data.length);
  assert.ok(!(await other.get('/chat/bootstrap')).data.channels.some((c) => c.id === everyone.id));
});

test('direct messages and groups are only visible to their members', async () => {
  const { admin, people } = await office([['Maria Lopez', 'front_desk'], ['Bob Smith', 'hygienist'], ['Cara Diaz', 'assistant']]);
  const dm = (await admin.c.post('/chat/dms', { user_ids: [people.maria.id] })).data;
  assert.equal(dm.kind, 'dm');
  assert.equal(dm.title, 'Maria Lopez');
  assert.equal((await admin.c.post('/chat/dms', { user_ids: [people.maria.id] })).data.id, dm.id, 'the same two people get the same conversation');
  const secret = (await send(admin.c, dm.id, 'Maria, your raise is approved')).data;
  // Maria sees it; Bob can't, by any route.
  assert.equal((await people.maria.c.get(`/chat/channels/${dm.id}/messages`)).data.messages[0].body, 'Maria, your raise is approved');
  assert.equal((await people.bob.c.get(`/chat/channels/${dm.id}/messages`)).status, 404);
  assert.equal((await people.bob.c.get(`/chat/messages/${secret.id}`)).status, 404);
  assert.equal((await people.bob.c.get(`/chat/messages/${secret.id}/thread`)).status, 404);
  assert.equal((await send(people.bob.c, dm.id, 'me too?')).status, 404);
  assert.equal((await people.bob.c.post(`/chat/channels/${dm.id}/read`)).status, 404);
  assert.ok(!(await people.bob.c.get('/chat/search?q=raise')).data.length);
  assert.equal((await people.maria.c.get('/chat/search?q=raise')).data.length, 1);
  assert.ok(!(await people.bob.c.get('/chat/bootstrap')).data.channels.some((c) => c.id === dm.id));
  // A file sent in the DM is theirs too.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const file = (await admin.c.post('/chat/attachments?filename=photo.png', png)).data;
  assert.equal(file.mime, 'image/png');
  assert.equal((await people.maria.c.get(`/chat/attachments/${file.id}`)).status, 404, 'not until it is sent');
  await send(admin.c, dm.id, { body: 'see photo', attachment_ids: [file.id] });
  const got = await people.maria.c.get(`/chat/attachments/${file.id}`);
  assert.equal(got.status, 200);
  assert.ok(Buffer.compare(got.data, png) === 0);
  assert.equal((await people.bob.c.get(`/chat/attachments/${file.id}`)).status, 404);
  assert.equal((await admin.c.post('/chat/attachments?filename=page.html', Buffer.from('<script>alert(1)</script>'))).status, 415);
  // Mentions in a DM only reach its members.
  const group = (await admin.c.post('/chat/dms', { user_ids: [people.maria.id, people.cara.id] })).data;
  assert.equal(group.kind, 'group');
  await send(admin.c, group.id, '@Bob can you cover? @Maria too');
  const mentioned = await h.db.all('SELECT user_id FROM chat_mentions WHERE channel_id = ?', group.id);
  assert.deepEqual(mentioned.map((m) => m.user_id), [people.maria.id]);
});

test('messages about a patient follow office access and their reads are audited', async () => {
  const p = await office([]);
  const north = (await p.api.post('/locations', { name: 'North' })).data;
  const south = (await p.api.post('/locations', { name: 'South' })).data;
  await h.db.run('UPDATE patients SET location_id = ? WHERE id = ?', north.id, p.patient.id);
  const email = `south-${Date.now()}@example.com`;
  await p.api.post('/users', { email, name: 'Sam South', role: 'front_desk', password: 'correct-horse-battery', location_ids: [south.id] });
  const sam = chat((await anon().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);

  const boot = (await p.admin.c.get('/chat/bootstrap')).data;
  assert.deepEqual(boot.channels.filter((c) => c.kind === 'channel').map((c) => c.name), ['Everyone', 'Front desk', 'Clinical', 'North', 'South'], 'one channel per office');
  const samBoot = (await sam.get('/chat/bootstrap')).data;
  assert.equal(samBoot.channels.find((c) => c.name === 'South').member, true);
  assert.equal(samBoot.channels.find((c) => c.name === 'North').member, false);

  const everyone = boot.channels.find((c) => c.slug === 'everyone');
  const msg = (await send(p.admin.c, everyone.id, { body: 'Her crown came back cracked', patient_id: p.patient.id })).data;
  assert.equal(msg.patient.name, 'Jane Doe');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'chat.message.patient_link' AND patient_id = ?", p.patient.id));

  // Sam (South only) sees that a message exists, not what it says or who it's about.
  const seen = (await sam.get(`/chat/channels/${everyone.id}/messages`)).data.messages.find((m) => m.id === msg.id);
  assert.equal(seen.hidden, true);
  assert.equal(seen.body, null);
  assert.equal(seen.patient, null);
  assert.equal((await sam.get(`/chat/messages/${msg.id}`)).status, 404);
  assert.ok(!(await sam.get('/chat/search?q=crown')).data.length);
  assert.equal((await sam.get(`/chat/search?patient_id=${p.patient.id}`)).status, 404);
  assert.equal((await send(sam, everyone.id, { body: 'about her', patient_id: p.patient.id })).status, 404);

  // The admin's read of it is a PHI view in the audit log.
  const before = (await h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'chat.patient_message.view' AND patient_id = ?", p.patient.id)).n;
  const list = (await p.admin.c.get(`/chat/search?patient_id=${p.patient.id}`)).data;
  assert.equal(list.length, 1);
  const afterN = (await h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'chat.patient_message.view' AND patient_id = ?", p.patient.id)).n;
  assert.equal(Number(afterN), Number(before) + 1);
});

test('edits keep history; deletes hide the text but keep the record', async () => {
  const { admin, people } = await office();
  const ch = await channel(admin.c, 'everyone');
  const m = (await send(people.maria.c, ch.id, 'Metting at noon')).data;
  assert.equal((await people.bob.c.put(`/chat/messages/${m.id}`, { body: 'hacked' })).status, 403, "can't edit someone else's");
  const edited = (await people.maria.c.put(`/chat/messages/${m.id}`, { body: 'Meeting at noon' })).data;
  assert.equal(edited.body, 'Meeting at noon');
  assert.ok(edited.edited_at);
  const hist = (await people.maria.c.get(`/chat/messages/${m.id}/history`)).data;
  assert.deepEqual(hist.map((e) => [e.body_before, e.body_after]), [['Metting at noon', 'Meeting at noon']]);
  assert.equal((await people.bob.c.get(`/chat/messages/${m.id}/history`)).status, 403);
  const editAudit = await h.db.get("SELECT changes FROM audit_log WHERE action = 'chat.message.edit' AND entity_id = ?", m.id);
  assert.deepEqual(JSON.parse(editAudit.changes).body, ['Metting at noon', 'Meeting at noon']);

  assert.equal((await people.bob.c.del(`/chat/messages/${m.id}`)).status, 403);
  assert.equal((await admin.c.del(`/chat/messages/${m.id}`)).status, 400, 'an administrator removing someone else’s message says why');
  const gone = (await people.maria.c.del(`/chat/messages/${m.id}`)).data;
  assert.equal(gone.status, 'deleted');
  assert.equal(gone.body, null);
  const row = await h.db.get('SELECT status, body, deleted_by FROM chat_messages WHERE id = ?', m.id);
  assert.deepEqual([row.status, row.body, row.deleted_by], ['deleted', 'Meeting at noon', people.maria.id], 'never hard deleted');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'chat.message.delete' AND entity_id = ?", m.id));
  const shown = (await people.bob.c.get(`/chat/channels/${ch.id}/messages`)).data.messages.find((x) => x.id === m.id);
  assert.equal(shown.body, null);
  assert.equal((await people.maria.c.put(`/chat/messages/${m.id}`, { body: 'again' })).status, 400);
  // Undo: the person who deleted it can bring it back (audited); nobody else can.
  assert.equal((await people.bob.c.post(`/chat/messages/${m.id}/restore`)).status, 403);
  assert.equal((await people.maria.c.post(`/chat/messages/${m.id}/restore`)).data.body, 'Meeting at noon');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'chat.message.restore' AND entity_id = ?", m.id));
});

test('sending twice (same client key or Idempotency-Key) posts one message', async () => {
  const { admin } = await office([]);
  const ch = await channel(admin.c, 'everyone');
  const first = await send(admin.c, ch.id, { body: 'Running 10 minutes late', client_key: 'msg-abc-12345' });
  const again = await send(admin.c, ch.id, { body: 'Running 10 minutes late', client_key: 'msg-abc-12345' });
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.data.id, first.data.id);
  const k = { 'Idempotency-Key': 'idem-chat-0001' };
  const x = await admin.c.post(`/chat/channels/${ch.id}/messages`, { body: 'Double click' }, k);
  const y = await admin.c.post(`/chat/channels/${ch.id}/messages`, { body: 'Double click' }, k);
  assert.equal(x.data.id, y.data.id);
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM chat_messages WHERE channel_id = ?', ch.id)).n), 2);
});

test('unread counts, mentions and read markers', async () => {
  const { admin, people } = await office();
  const ch = await channel(admin.c, 'everyone');
  await send(people.maria.c, ch.id, 'Good morning');
  await send(people.maria.c, ch.id, '@Admin the printer is out of toner');
  const dm = (await people.maria.c.post('/chat/dms', { user_ids: [admin.id] })).data;
  await send(people.maria.c, dm.id, 'Can I leave at 4?');
  let boot = (await admin.c.get('/chat/bootstrap')).data;
  const ev = boot.channels.find((c) => c.id === ch.id);
  assert.equal(ev.unread, 2);
  assert.equal(ev.mentions, 1);
  assert.equal(boot.channels.find((c) => c.id === dm.id).unread, 1);
  assert.equal(boot.unread.important, 2, 'the DM and the mention (channel chatter shows per channel)');
  assert.equal(boot.unread.total, 3);
  // Maria's own messages aren't unread for her.
  assert.equal((await people.maria.c.get('/chat/unread')).data.total, 0);
  // Thread replies don't count as channel unread.
  const top = (await admin.c.get(`/chat/channels/${ch.id}/messages`)).data.messages.at(-1);
  await send(people.maria.c, ch.id, { body: 'replying', parent_id: top.id });
  assert.equal((await admin.c.get('/chat/unread')).data.total, 3);
  assert.equal((await admin.c.get(`/chat/messages/${top.id}/thread`)).data.replies.length, 1);

  await admin.c.post(`/chat/channels/${ch.id}/read`);
  await admin.c.post(`/chat/channels/${dm.id}/read`);
  boot = (await admin.c.get('/chat/bootstrap')).data;
  assert.equal(boot.unread.total, 0);
  assert.equal(boot.unread.important, 0);
  // Read markers only go forward.
  await admin.c.post(`/chat/channels/${ch.id}/read`, { message_id: 1 });
  assert.equal((await admin.c.get('/chat/unread')).data.total, 0);
  // @front-desk reaches the front desk, not the hygienist.
  await send(admin.c, ch.id, '@front-desk please confirm tomorrow');
  assert.equal((await people.maria.c.get('/chat/unread')).data.important, 1);
  assert.equal((await people.bob.c.get('/chat/unread')).data.important, 0);
});

test('urgent messages stay until acknowledged and show who has seen them', async () => {
  const { admin, people } = await office();
  const ch = await channel(admin.c, 'everyone');
  await people.bob.c.get('/chat/bootstrap');
  await people.maria.c.get('/chat/bootstrap');
  const m = (await send(admin.c, ch.id, { body: 'Fire drill at 2pm — everyone out front', urgent: true })).data;
  assert.equal(m.urgent, true);
  assert.deepEqual((await people.maria.c.get('/chat/urgent')).data.map((x) => x.id), [m.id]);
  assert.equal((await admin.c.get('/chat/urgent')).data.length, 0, 'not for its author');
  assert.equal((await people.maria.c.get('/chat/unread')).data.urgent, 1);
  assert.equal((await people.maria.c.post(`/chat/messages/${m.id}/ack`)).status, 200);
  assert.equal((await people.maria.c.post(`/chat/messages/${m.id}/ack`)).status, 200, 'twice is fine');
  assert.equal((await people.maria.c.get('/chat/urgent')).data.length, 0);
  assert.equal((await people.bob.c.get('/chat/urgent')).data.length, 1, 'still on Bob’s screen');
  const acks = (await admin.c.get(`/chat/messages/${m.id}/acks`)).data;
  assert.deepEqual(acks.acked.map((a) => a.name), ['Maria Lopez']);
  assert.deepEqual(acks.waiting.map((a) => a.name), ['Bob Smith']);
  const shown = (await admin.c.get(`/chat/messages/${m.id}`)).data;
  assert.deepEqual(shown.acks, { count: 1, mine: false });
});

test('reactions: set on or off, repeat-safe; only real emoji', async () => {
  const { admin, people } = await office();
  const ch = await channel(admin.c, 'everyone');
  const m = (await send(admin.c, ch.id, 'Great job today')).data;
  await people.maria.c.post(`/chat/messages/${m.id}/reactions`, { emoji: '🎉' });
  const r = (await people.bob.c.post(`/chat/messages/${m.id}/reactions`, { emoji: '🎉' })).data;
  assert.deepEqual(r.reactions.map((x) => [x.emoji, x.count]), [['🎉', 2]]);
  await people.bob.c.post(`/chat/messages/${m.id}/reactions`, { emoji: '🎉' });
  const off = (await people.bob.c.post(`/chat/messages/${m.id}/reactions`, { emoji: '🎉', on: false })).data;
  assert.deepEqual(off.reactions.map((x) => [x.emoji, x.count, x.mine]), [['🎉', 1, false]]);
  assert.equal((await people.bob.c.post(`/chat/messages/${m.id}/reactions`, { emoji: '<b>' })).status, 400);
  assert.equal((await people.bob.c.post(`/chat/messages/${m.id}/reactions`, { emoji: '7' })).status, 400);
});

test('turn a message into a task; my tasks; done with undo', async () => {
  const { admin, people, patient } = await office();
  const ch = await channel(admin.c, 'everyone');
  const m = (await send(admin.c, ch.id, { body: 'Call the lab about her crown', patient_id: patient.id })).data;
  const due = '2030-01-15';
  const task = await admin.c.post(`/chat/messages/${m.id}/task`, { assigned_to: people.maria.id, due_date: due, checklist: ['Call lab', 'Update chart'] });
  assert.equal(task.status, 201);
  assert.equal(task.data.title, 'Call the lab about her crown');
  assert.equal(task.data.patient_id, patient.id, 'the message’s patient comes along');
  assert.equal(task.data.chat_message_id, m.id);
  assert.equal(task.data.assigned_to, people.maria.id);
  assert.deepEqual(task.data.checklist.map((i) => i.text), ['Call lab', 'Update chart']);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'task.create' AND entity_id = ?", task.data.id));
  assert.deepEqual((await admin.c.get(`/chat/messages/${m.id}`)).data.tasks.map((t) => t.assigned_to_name), ['Maria Lopez']);

  const mine = (await people.maria.c.get('/chat/tasks')).data;
  assert.ok(mine.tasks.some((t) => t.id === task.data.id));
  assert.ok((await admin.c.get('/chat/tasks?view=assigned')).data.tasks.some((t) => t.id === task.data.id), 'on my "assigned to others" list');
  assert.equal((await admin.c.post(`/chat/messages/${m.id}/task`, { assigned_to: 999999 })).status, 404);
  assert.equal((await admin.c.post(`/chat/messages/${m.id}/task`, { due_date: '2030-02-31' })).status, 400);

  const item = task.data.checklist[0];
  const ticked = (await people.maria.c.put(`/chat/tasks/${task.data.id}/checklist/${item.id}`, { done: true })).data;
  assert.equal(ticked.checklist[0].done_by, people.maria.id);
  const done = (await people.maria.c.post(`/chat/tasks/${task.data.id}/done`)).data;
  assert.equal(done.status, 'done');
  assert.equal(done.completed_by, people.maria.id);
  assert.ok((await people.maria.c.get('/chat/tasks')).data.done.some((t) => t.id === task.data.id), 'shown as done today, for undo');
  const back = (await people.maria.c.post(`/chat/tasks/${task.data.id}/reopen`)).data;
  assert.equal(back.status, 'open');
  assert.equal(back.completed_by, null);
  // A task for yourself by default.
  const self = (await people.bob.c.post('/chat/tasks', { title: 'Order floss samples' })).data;
  assert.equal(self.assigned_to, people.bob.id);
});

test('recurring tasks: one task per date, next one after done, missed dates skipped, never doubled', async () => {
  const { admin, people } = await office();
  const t = (await admin.c.post('/chat/tasks', { title: 'Order supplies', assigned_to: people.maria.id, due_date: '2030-03-01', repeat: { rule: 'weekly', weekday: 5 } })).data;
  assert.equal(t.due_date, '2030-03-01', '2030-03-01 is a Friday');
  assert.equal(t.repeat_rule, 'weekly');
  const series = t.series_id;
  const count = async () => Number((await h.db.get('SELECT COUNT(*) AS n FROM task_occurrences WHERE series_id = ?', series)).n);
  assert.equal(await count(), 1);
  // Running again (or on two servers) before it's done or due: nothing new.
  await runRecurringTasks(h.db, { seriesId: series, today: '2030-02-20' });
  await runRecurringTasks(h.db, { seriesId: series, today: '2030-02-20' });
  assert.equal(await count(), 1);
  // Done → the next Friday.
  await people.maria.c.post(`/chat/tasks/${t.id}/done`);
  await runRecurringTasks(h.db, { seriesId: series, today: '2030-02-20' });
  await runRecurringTasks(h.db, { seriesId: series, today: '2030-02-20' });
  const dates = async () => (await h.db.all('SELECT due_date FROM task_occurrences WHERE series_id = ? ORDER BY due_date', series)).map((r) => r.due_date);
  assert.deepEqual(await dates(), ['2030-03-01', '2030-03-08']);
  // A month away: one task for the next Friday on or after today, not four.
  await runRecurringTasks(h.db, { seriesId: series, today: '2030-04-10' });
  assert.deepEqual(await dates(), ['2030-03-01', '2030-03-08', '2030-04-12']);
  const tasks = await h.db.all("SELECT t.title, t.assigned_to, t.due_date FROM tasks t JOIN task_occurrences o ON o.task_id = t.id WHERE o.series_id = ? ORDER BY t.due_date", series);
  assert.ok(tasks.every((x) => x.title === 'Order supplies' && x.assigned_to === people.maria.id));
  await admin.c.post(`/chat/series/${series}/stop`);
  await runRecurringTasks(h.db, { seriesId: series, today: '2031-01-01' });
  assert.equal(await count(), 3, 'a stopped series makes no more');
  // Date rules.
  assert.equal(firstOnOrAfter({ rule: 'weekdays' }, '2030-03-02'), '2030-03-04');
  assert.equal(nextAfter({ rule: 'weekdays' }, '2030-03-01'), '2030-03-04');
  assert.equal(nextAfter({ rule: 'monthly', month_day: 31 }, '2030-01-31'), '2030-02-28');
  assert.equal((await admin.c.post('/chat/tasks', { title: 'x', repeat: { rule: 'hourly' } })).status, 400);
});

test('GIFs are off by default, admin-only to turn on, and never reach a real provider in tests', async () => {
  const { admin, people, patient } = await office();
  const ch = await channel(admin.c, 'everyone');
  assert.equal((await admin.c.get('/chat/gifs?q=party')).status, 403);
  assert.equal((await send(admin.c, ch.id, { gif: { id: 'sb-party' } })).status, 403);
  assert.equal((await people.maria.c.put('/chat/settings', { gifs_enabled: true })).status, 403);
  assert.equal((await admin.c.put('/chat/settings', { gifs_enabled: true })).data.gifs_enabled, true);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'chat.settings.update'"));
  const found = (await people.maria.c.get('/chat/gifs?q=party 555-0100')).data;
  assert.equal(found.provider, 'sandbox');
  assert.equal(found.query, 'party', 'digits never leave');
  assert.ok(found.results[0].emoji);
  const sent = (await send(people.maria.c, ch.id, { gif: found.results[0] })).data;
  assert.equal(sent.kind, 'gif');
  assert.equal(sent.gif.id, found.results[0].id);
  assert.equal((await send(people.maria.c, ch.id, { gif: { id: 'tenor:1', url: 'https://evil.example.com/x.gif' } })).status, 400);
  assert.equal((await admin.c.get(`/chat/gifs/media?u=${encodeURIComponent('https://evil.example.com/x.gif')}`)).status, 400);
  // Patient names and contact details are stripped from what would be searched.
  assert.equal(await cleanGifQuery(h.db, (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', patient.id)).practice_id, 'Jane Doe happy birthday jane@example.com 04/12'), 'happy birthday');
  assert.equal(cleanGif({ id: 'giphy:abc', url: 'https://media2.giphy.com/media/abc/giphy.gif' }).url, 'https://media2.giphy.com/media/abc/giphy.gif');
  assert.equal(gifCalls().length, 0);
});

test('digest email: counts only, no message text, once per message, quiet hours respected', async () => {
  const { admin, people, api } = await office();
  const email = (await api.get('/auth/me')).data.user.email;
  const dm = (await people.maria.c.post('/chat/dms', { user_ids: [admin.id] })).data;
  await send(people.maria.c, dm.id, { body: 'Jane Doe owes $300, call her', patient_id: null });
  const later = new Date(Date.now() + 5 * 3600_000);
  const sentBefore = h.sent.length;
  await runChatDigests(h.db, h.messenger, { now: later });
  const mine = h.sent.slice(sentBefore).filter((m) => m.to === email);
  assert.equal(mine.length, 1);
  assert.match(mine[0].body, /1 unread team message/);
  assert.match(mine[0].body, /Maria Lopez \(direct message\)/);
  assert.doesNotMatch(mine[0].body, /Jane|owes|\$300/, 'never the message itself');
  await runChatDigests(h.db, h.messenger, { now: later });
  assert.equal(h.sent.slice(sentBefore).filter((m) => m.to === email).length, 1, 'each message is in one digest');
  // Quiet hours all day: nothing sent.
  assert.equal(inQuietHours({ enabled: true, from: '19:00', until: '07:00' }, '22:30'), true);
  assert.equal(inQuietHours({ enabled: true, from: '19:00', until: '07:00' }, '12:00'), false);
  await h.db.run("INSERT INTO user_prefs (user_id, key, value) VALUES (?, 'chat.quiet', ?)", admin.id, JSON.stringify({ enabled: true, from: '00:00', until: '23:59' }));
  await send(people.maria.c, dm.id, 'another');
  const n = h.sent.length;
  await runChatDigests(h.db, h.messenger, { now: new Date(Date.now() + 10 * 3600_000) });
  assert.equal(h.sent.slice(n).filter((m) => m.to === email).length, 0);
});
