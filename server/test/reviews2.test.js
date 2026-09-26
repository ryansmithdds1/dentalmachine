// Reviews with a feedback screen and team shout-outs (RV1–RV3, docs/reviews.md): throttle and idempotent sends,
// opt-outs and quiet hours, rating routing with the public review link offered to everyone (no review gating),
// owner/manager notifications with a follow-up task, staff mention matching (nicknames, ambiguity), points and
// the leaderboard, practice isolation and permissions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { recordOptOut, runReviewRequests } from '../src/messaging.js';
import { requestReview } from '../src/reviewfunnel.js';
import { findMentions, staffIndex } from '../src/shoutouts.js';

const h = harness();
const GOOGLE = 'https://g.page/r/example/review';
const tokenOf = (body) => /\/r\/([\w-]+)/.exec(body)[1];
let seq = 0;

async function person(api, role, extra = {}) {
  const email = `rv${++seq}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const u = (await api.post('/users', { email, name: extra.name || `Staff ${seq}`, role, password: 'correct-horse-battery', ...extra })).data;
  const token = (await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token;
  return { user: u, api: h.client(token) };
}
const newPatient = async (api, first, extra = {}) => (await api.post('/patients', { first_name: first, last_name: 'Tester', phone: `512555${String(1000 + ++seq).slice(-4)}`, email: `${first.toLowerCase()}${seq}@example.com`, ...extra })).data;
const ask = (api, patientId, body = {}) => api.post(`/patients/${patientId}/review-request`, { source: 'chart', ...body });

test('RV1: asking sends one link; a repeat is the same request; the throttle holds for N months', async () => {
  const { api, patient } = await h.practice({ review_url: GOOGLE });
  const before = h.sent.length;
  const first = await ask(api, patient.id);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.status, 'sent');
  assert.equal(first.data.channel, 'sms');
  assert.equal(first.data.request.token_hash, undefined, 'the link hash never leaves the server');
  assert.equal(h.sent.length, before + 1);
  assert.match(h.sent.at(-1).body, /https:\/\/app\.example\.com\/r\/[\w-]{20,}/);
  assert.match(h.sent.at(-1).body, /Reply STOP to opt out/);

  // A double click (no key) gets the first request back, and nothing more is sent.
  const again = await ask(api, patient.id, { source: 'patient_bar' });
  assert.equal(again.status, 200);
  assert.equal(again.data.already, true);
  assert.equal(again.data.request.id, first.data.request.id);
  assert.equal(h.sent.length, before + 1);

  // Two at once for another patient: exactly one message goes.
  const other = await newPatient(api, 'Twice');
  const n = h.sent.length;
  const both = await Promise.all([ask(api, other.id), ask(api, other.id)]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 201]);
  assert.equal(h.sent.length, n + 1);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM review_feedback WHERE patient_id = ?', other.id)).n, 1);

  // Later (two months on): the throttle (6 months by default) says no, with when it's possible again.
  await h.db.run("UPDATE review_feedback SET sent_at = ?, request_day = '2000-01-01' WHERE id = ?", new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 19).replace('T', ' '), first.data.request.id);
  const early = await ask(api, patient.id);
  assert.equal(early.status, 409);
  assert.match(early.data.error, /at most once every 6 months/);
  assert.ok(early.data.details.next_allowed);
  const status = (await api.get(`/patients/${patient.id}/review-request`)).data;
  assert.equal(status.allowed, false);
  assert.equal(status.months, 6);

  // The office changes it to 1 month: allowed again. Audited, before and after.
  assert.equal((await api.put('/reviews/settings', { throttle_months: 0 })).status, 400);
  assert.equal((await api.put('/reviews/settings', { throttle_months: 1 })).status, 200);
  const later = await ask(api, patient.id, { source: 'checkout' });
  assert.equal(later.status, 201);
  const logged = await h.db.all("SELECT * FROM audit_log WHERE action = 'review.request' AND entity_id = ?", later.data.request.id);
  assert.equal(logged.length, 1);
  assert.equal(JSON.parse(logged[0].details).source, 'checkout');
  assert.equal(logged[0].source, 'human');
  const settingsAudit = await h.db.get("SELECT changes FROM audit_log WHERE action = 'review.settings' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(JSON.parse(settingsAudit.changes).throttle_months, [6, 1]);

  // Bad input is refused.
  assert.equal((await ask(api, patient.id, { source: 'auto' })).status, 400);
  assert.equal((await ask(api, other.id, { channel: 'fax' })).status, 400);
  assert.equal((await ask(api, 999999)).status, 404);
});

test('RV1: opt-outs are respected (no request, nothing sent); email works when asked', async () => {
  const { api } = await h.practice({ review_url: GOOGLE });
  const quiet = await newPatient(api, 'Quiet');
  await api.put(`/patients/${quiet.id}`, { sms_opt_in: false, email_opt_in: false });
  const before = h.sent.length;
  const r1 = await ask(api, quiet.id);
  assert.equal(r1.status, 422);
  assert.match(r1.data.error, /opted out/);

  // Replied STOP to texts, and has no email: can't be reached.
  const stop = (await api.post('/patients', { first_name: 'Stop', last_name: 'Tester', phone: '5125558801' })).data;
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', stop.id)).practice_id;
  await recordOptOut(h.db, pid, 'sms', '5125558801', 'reply');
  assert.equal((await ask(api, stop.id)).status, 422);
  assert.equal((await ask(api, stop.id, { channel: 'sms' })).status, 422);
  assert.equal(h.sent.length, before);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM review_feedback WHERE patient_id IN (?, ?)', quiet.id, stop.id)).n, 0);

  // By email when asked for.
  const mail = await newPatient(api, 'Mail');
  const r2 = await ask(api, mail.id, { channel: 'email' });
  assert.equal(r2.status, 201);
  assert.equal(r2.data.channel, 'email');
  assert.equal(h.sent.at(-1).channel, 'email');
});

test('RV1: outside sending hours a request waits for the morning; automatic after a visit is off by default', async () => {
  const { api, patient, provider } = await h.practice({ review_url: GOOGLE, timezone: 'UTC', send_from: '08:00', send_until: '20:00' });
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', patient.id)).practice_id;
  const before = h.sent.length;
  const night = new Date('2030-03-04T23:00:00Z');
  const out = await requestReview(h.db, h.messenger, { practiceId: pid, patientId: patient.id, source: 'chart', appUrl: 'https://app.example.com', now: night });
  assert.equal(out.status, 'queued');
  assert.equal(h.sent.length, before);
  // Still night: nothing goes. Morning: it goes (a fresh link; only its hash is kept).
  await h.db.run("UPDATE review_feedback SET sent_at = '2030-03-04 23:00:00' WHERE id = ?", out.request.id);
  await runReviewRequests(h.db, h.messenger, { now: new Date('2030-03-05T03:00:00Z'), appUrl: 'https://app.example.com' });
  assert.equal((await h.db.get('SELECT send_status FROM review_feedback WHERE id = ?', out.request.id)).send_status, 'queued');
  assert.equal(h.sent.length, before);
  await runReviewRequests(h.db, h.messenger, { now: new Date('2030-03-05T09:00:00Z'), appUrl: 'https://app.example.com' });
  assert.equal((await h.db.get('SELECT send_status FROM review_feedback WHERE id = ?', out.request.id)).send_status, 'sent');
  assert.match(h.sent.at(-1).body, /\/r\/[\w-]{20,}/);
  assert.equal(h.sent.filter((m) => m.to === patient.phone || m.to === '(512) 555-0100').length >= 1, true);

  // A completed visit today: no automatic request unless the office turned it on.
  const other = await newPatient(api, 'Visit');
  const d = new Date().toISOString().slice(0, 10);
  const a = (await api.post('/appointments', { patient_id: other.id, provider_id: provider.id, start_time: `${d} 09:00`, end_time: `${d} 09:30`, override_blockout: true })).data;
  assert.ok(a.id, JSON.stringify(a));
  await api.put(`/appointments/${a.id}`, { status: 'completed' });
  await api.put('/practice', { send_from: '00:00', send_until: '00:00' });
  const n = h.sent.length;
  await runReviewRequests(h.db, h.messenger, { now: new Date(`${d}T23:00:00Z`), appUrl: 'https://app.example.com' });
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM review_feedback WHERE patient_id = ?', other.id)).n, 0);
  assert.equal((await api.put('/reviews/settings', { auto_after_visit: true })).status, 200);
  await runReviewRequests(h.db, h.messenger, { now: new Date(`${d}T23:00:00Z`), appUrl: 'https://app.example.com' });
  const auto = await h.db.get('SELECT * FROM review_feedback WHERE patient_id = ?', other.id);
  assert.equal(auto.request_source, 'auto');
  assert.equal(h.sent.length, n + 1);
  // Once per visit.
  await runReviewRequests(h.db, h.messenger, { now: new Date(`${d}T23:00:00Z`), appUrl: 'https://app.example.com' });
  assert.equal(h.sent.length, n + 1);
});

test('RV2: everyone rates first; happy → invitation, unhappy → private feedback; the public link is always there', async () => {
  const { api, patient } = await h.practice({ review_url: GOOGLE });
  await api.put('/reviews/settings', { other_sites: [{ name: 'Yelp', url: 'https://yelp.com/biz/example' }] });
  assert.equal((await api.put('/reviews/settings', { other_sites: [{ name: 'Bad', url: 'javascript:alert(1)' }] })).status, 400);
  assert.equal((await api.put('/reviews/settings', { public_link_for_everyone: false })).status, 400, 'no setting hides the public link');
  const pub = h.client();

  await ask(api, patient.id);
  const happyToken = tokenOf(h.sent.at(-1).body);
  const opened = (await pub.get(`/public/review/${happyToken}`)).data;
  assert.equal(opened.step, 'rate');
  assert.equal(opened.public_review.name, 'Google', 'public link offered before rating');
  assert.equal((await pub.post(`/public/review/${happyToken}`, { rating: 0 })).status, 400);
  const happy = (await pub.post(`/public/review/${happyToken}`, { rating: 5 })).data;
  assert.equal(happy.step, 'invite');
  assert.deepEqual(happy.sites.map((s) => s.name), ['Google', 'Yelp']);
  assert.equal(happy.sites[0].url, undefined, 'links go through us, so clicks are counted');
  const go = await fetch(`${h.origin}/api/public/review/${happyToken}/go?site=1`, { redirect: 'manual' });
  assert.equal(go.status, 302);
  assert.equal(go.headers.get('location'), 'https://yelp.com/biz/example');

  const sad = await newPatient(api, 'Sad');
  await ask(api, sad.id);
  const sadToken = tokenOf(h.sent.at(-1).body);
  const low = (await pub.post(`/public/review/${sadToken}`, { rating: 2 })).data;
  assert.equal(low.happy, false);
  assert.equal(low.step, 'feedback');
  assert.equal(low.public_review.name, 'Google', 'the small public link is there for low ratings too');
  const sadGo = await fetch(`${h.origin}/api/public/review/${sadToken}/go?site=google`, { redirect: 'manual' });
  assert.equal(sadGo.status, 302, 'no review gating');
  assert.equal(sadGo.headers.get('location'), GOOGLE);
  const sent = (await pub.post(`/public/review/${sadToken}`, { comment: 'Waited 40 minutes and nobody said why.', callback: true, callback_note: 'After 3pm' })).data;
  assert.equal(sent.step, 'thanks');
  assert.equal(sent.public_review.name, 'Google');
  // Every threshold: the public link never disappears.
  for (const t of [2, 3, 5]) {
    await api.put('/reviews/settings', { threshold: t });
    assert.equal((await pub.get(`/public/review/${sadToken}`)).data.public_review.name, 'Google');
  }
  await api.put('/reviews/settings', { threshold: 4 });

  // The funnel: sent, opened, rated, clicked through, private feedback.
  const o = (await api.get('/reviews/overview')).data;
  assert.deepEqual([o.funnel.sent, o.funnel.opened, o.funnel.rated, o.funnel.happy, o.funnel.unhappy, o.funnel.posted_click, o.funnel.feedback], [2, 2, 2, 1, 1, 2, 1]);
  assert.equal(o.average, 3.5);
  assert.equal(o.by_source.chart, 2);
  assert.deepEqual(o.inbox, { new: 1, contacted: 0, resolved: 0 });
  // The patient's steps are on record as the patient.
  const steps = await h.db.all("SELECT action, source FROM audit_log WHERE entity = 'review_feedback' AND action IN ('review.rated','review.feedback','review.go') ORDER BY id");
  assert.ok(steps.length >= 4 && steps.every((s) => s.source === 'patient'));
  // Unknown or expired links.
  assert.equal((await pub.get('/public/review/not-a-real-token')).status, 404);
});

test('RV2: a low rating tells the owner and office manager at once, with a follow-up task; the inbox tracks it', async () => {
  const { api, patient } = await h.practice({ review_url: GOOGLE });
  const manager = await person(api, 'front_desk', { name: 'Maya Manager', permissions_add: ['reviews:manage'] });
  const desk = await person(api, 'front_desk', { name: 'Dana Desk' });
  const pub = h.client();
  await ask(api, patient.id);
  const token = tokenOf(h.sent.at(-1).body);
  await pub.post(`/public/review/${token}`, { rating: 1 });
  let tasks = (await api.get(`/tasks?patient_id=${patient.id}`)).data;
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /^Unhappy after visit \(1★\): Jane Doe$/);
  assert.equal(tasks[0].priority, 'high');
  const chan = await h.db.get("SELECT * FROM chat_channels WHERE dm_key = 'patient-feedback' AND practice_id = (SELECT practice_id FROM patients WHERE id = ?)", patient.id);
  const members = (await h.db.all('SELECT user_id FROM chat_members WHERE channel_id = ?', chan.id)).map((m) => m.user_id);
  assert.ok(members.includes(manager.user.id), 'office manager (reviews:manage) is told');
  assert.ok(!members.includes(desk.user.id), 'others are not');
  let posts = await h.db.all('SELECT * FROM chat_messages WHERE channel_id = ? ORDER BY id', chan.id);
  assert.equal(posts.length, 1);
  assert.match(posts[0].body, /rated their visit 1★/);
  assert.equal(posts[0].patient_id, patient.id);
  assert.equal(posts[0].source, 'automation');

  // Rating again the same doesn't post twice; the feedback itself does, and updates the one task.
  await pub.post(`/public/review/${token}`, { rating: 1 });
  await pub.post(`/public/review/${token}`, { comment: 'The front desk was rude about my bill.', callback: true });
  tasks = (await api.get(`/tasks?patient_id=${patient.id}`)).data;
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /Unhappy after visit \(1★\): Jane Doe — “The front desk was rude about my bill\.” · wants a call back/);
  posts = await h.db.all('SELECT * FROM chat_messages WHERE channel_id = ? ORDER BY id', chan.id);
  assert.equal(posts.length, 2);
  assert.match(posts[1].body, /Private feedback from Jane Doe \(1★\): “The front desk was rude about my bill\.”\nWants a call back/);
  assert.equal(posts[1].urgent, 1);

  // Inbox: the manager sees it; a desk person without reviews:manage doesn't.
  assert.equal((await desk.api.get('/reviews/feedback')).status, 403);
  const inbox = (await manager.api.get('/reviews/feedback')).data;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].feedback_status, 'new');
  assert.equal(inbox[0].callback_wanted, 1);
  assert.equal((await manager.api.patch(`/reviews/feedback/${inbox[0].id}`, { status: 'closed' })).status, 400);
  assert.equal((await manager.api.patch(`/reviews/feedback/${inbox[0].id}`, { status: 'contacted', note: 'Called, left a message' })).data.feedback_status, 'contacted');
  const done = (await manager.api.patch(`/reviews/feedback/${inbox[0].id}`, { status: 'resolved', note: 'Spoke with Jane, fixed the bill' })).data;
  assert.equal(done.feedback_status, 'resolved');
  assert.equal(done.feedback_status_by, manager.user.id);
  assert.equal((await h.db.get('SELECT status FROM tasks WHERE id = ?', tasks[0].id)).status, 'done');
  const trail = await h.db.all("SELECT reason, user_id FROM audit_log WHERE action = 'review.feedback_status' AND entity_id = ? ORDER BY id", inbox[0].id);
  assert.deepEqual(trail.map((t) => t.reason), ['Called, left a message', 'Spoke with Jane, fixed the bill']);

  // The owner can name exactly who's told and who gets the task.
  await api.put('/reviews/settings', { notify_user_ids: [manager.user.id], followup_user_id: manager.user.id });
  const other = await newPatient(api, 'Grumpy');
  await ask(api, other.id);
  await pub.post(`/public/review/${tokenOf(h.sent.at(-1).body)}`, { rating: 2 });
  const t2 = (await api.get(`/tasks?patient_id=${other.id}`)).data[0];
  assert.equal(t2.assigned_to, manager.user.id);
  assert.equal((await api.put('/reviews/settings', { notify_user_ids: [999999] })).status, 400);
});

test('RV3: staff mention matching — first names, nicknames, "Dr. Lee", ambiguity and everyday words', () => {
  const users = [
    { id: 1, name: 'Anna Smith', role: 'hygienist' }, { id: 2, name: 'Sam Ortiz', role: 'front_desk' }, { id: 3, name: 'Sam Patel', role: 'assistant' },
    { id: 4, name: 'Dr. Ann Lee, DDS', role: 'dentist' }, { id: 5, name: 'Will Brown', role: 'assistant' }, { id: 6, name: 'José Núñez', role: 'front_desk' },
  ];
  const idx = staffIndex(users, [{ user_id: 1, nickname: 'Annie' }]);
  const byKey = (text) => Object.fromEntries(findMentions(text, idx).map((m) => [m.match_key, m]));
  const m = byKey('Annie was so gentle! Dr. Lee explained everything. Sam at the desk was great.');
  assert.equal(m.u1.matched_name, 'Annie');
  assert.equal(m.u1.quote, 'Annie was so gentle!');
  assert.equal(m.u4.quote, 'Dr. Lee explained everything.');
  assert.deepEqual(m['nsam'].candidate_ids, [2, 3]);
  assert.equal(m['nsam'].user_id, null);
  // "Sam Ortiz" named in full settles the bare "Sam" in the same text.
  assert.deepEqual(Object.keys(byKey('Sam Ortiz rocks. Sam also found me a sooner time.')), ['u2']);
  // Everyday words only count with a capital; accents don't matter.
  assert.deepEqual(Object.keys(byKey('I will be back, and jose was kind')), ['u6']);
  assert.deepEqual(Object.keys(byKey('Will made me laugh')), ['u5']);
  // Once per person per text.
  assert.equal(findMentions('Anna, Anna, Anna!', idx).length, 1);
  assert.deepEqual(findMentions('Great visit, nice team.', idx), []);
});

test('RV3: shout-outs from feedback and Google reviews score points; the owner confirms or unlinks; leaderboard by month', async () => {
  const { api, patient } = await h.practice({ review_url: GOOGLE });
  const anna = await person(api, 'hygienist', { name: 'Anna Smith' });
  const samO = await person(api, 'front_desk', { name: 'Sam Ortiz' });
  await person(api, 'assistant', { name: 'Sam Patel' });
  const desk = await person(api, 'front_desk', { name: 'Dana Desk' });
  assert.equal((await api.post('/reviews/nicknames', { user_id: anna.user.id, nickname: 'Annie' })).status, 201);
  assert.equal((await api.post('/reviews/nicknames', { user_id: samO.user.id, nickname: 'annie' })).status, 409);
  assert.equal((await desk.api.post('/reviews/nicknames', { user_id: anna.user.id, nickname: 'Smitty' })).status, 403);
  await api.put('/reviews/settings', { points_per_mention: 15, reward_note: 'Top of the month picks lunch' });
  const pub = h.client();

  await ask(api, patient.id);
  const token = tokenOf(h.sent.at(-1).body);
  await pub.post(`/public/review/${token}`, { rating: 5 });
  await pub.post(`/public/review/${token}`, { comment: 'Annie was so gentle. Sam at the front desk found me a time.' });
  const month = new Date().toISOString().slice(0, 7);
  let list = (await api.get(`/reviews/shoutouts?month=${month}`)).data;
  const annaRow = list.find((s) => s.user_id === anna.user.id);
  assert.equal(annaRow.points, 15);
  assert.equal(annaRow.quote, 'Annie was so gentle.');
  assert.equal(annaRow.patient_name, 'Jane Doe');
  const sam = list.find((s) => s.status === 'needs_match');
  assert.equal(sam.points, 0);
  assert.deepEqual(sam.candidates.map((c) => c.name).sort(), ['Sam Ortiz', 'Sam Patel']);
  // Saying the same thing again never double counts.
  await pub.post(`/public/review/${token}`, { comment: 'Annie was so gentle. Sam at the front desk found me a time!' });
  assert.equal((await api.get(`/reviews/shoutouts?month=${month}`)).data.length, 2);

  let board = (await api.get(`/reviews/leaderboard?month=${month}`)).data;
  assert.deepEqual(board.rows.map((r) => [r.name, r.points, r.mentions]), [['Anna Smith', 15, 1]]);
  assert.equal(board.needs_match, 1);
  assert.equal(board.reward_note, 'Top of the month picks lunch');

  // The owner says which Sam; points follow.
  assert.equal((await desk.api.post(`/reviews/shoutouts/${sam.id}/confirm`, { user_id: samO.user.id })).status, 403);
  assert.equal((await api.post(`/reviews/shoutouts/${sam.id}/confirm`, { user_id: samO.user.id })).data.points, 15);
  // A Google review names Anna too (read when the Reviews page opens).
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', patient.id)).practice_id;
  await h.db.run("INSERT INTO reviews (practice_id, source, external_id, author, rating, text, posted_at) VALUES (?, 'google', 'g-1', 'Maria G.', 5, 'Anna is the best hygienist in Austin.', ?)", pid, new Date().toISOString());
  await h.db.run("INSERT INTO reviews (practice_id, source, external_id, author, rating, text, posted_at) VALUES (?, 'google', 'g-2', 'Tom R.', 1, 'Anna was rough and rushed.', ?)", pid, new Date().toISOString());
  await api.get('/reviews/overview');
  await api.get('/reviews/overview');
  board = (await api.get(`/reviews/leaderboard?month=${month}`)).data;
  assert.deepEqual(board.rows.map((r) => [r.name, r.points, r.mentions]), [['Anna Smith', 30, 2], ['Sam Ortiz', 15, 1]]);
  // Named in a 1-star review: kept for the owner (coaching), no points, not shown to everyone.
  list = (await api.get(`/reviews/shoutouts?month=${month}`)).data;
  const rough = list.find((s) => s.quote === 'Anna was rough and rushed.');
  assert.equal(rough.positive, 0);
  assert.equal(rough.points, 0);
  assert.ok(!(await desk.api.get(`/reviews/shoutouts?month=${month}`)).data.some((s) => !s.positive));
  assert.ok((await desk.api.get(`/reviews/shoutouts?month=${month}`)).data.every((s) => s.patient_name === null), 'patient names are for managers');

  // Unlink needs a reason; the row stays, the points go.
  const google = list.find((s) => s.source === 'review' && s.positive);
  assert.equal((await api.post(`/reviews/shoutouts/${google.id}/unlink`, {})).status, 400);
  assert.equal((await api.post(`/reviews/shoutouts/${google.id}/unlink`, { reason: 'Another Anna — a different office' })).data.status, 'unlinked');
  board = (await api.get(`/reviews/leaderboard?month=${month}`)).data;
  assert.deepEqual(board.rows.map((r) => [r.name, r.points]), [['Anna Smith', 15], ['Sam Ortiz', 15]]);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'shoutout.unlink' AND reason = 'Another Anna — a different office'"));

  // Rewards: one note per person per month.
  assert.equal((await api.put('/reviews/rewards', { user_id: anna.user.id, month, note: '' })).status, 400);
  await api.put('/reviews/rewards', { user_id: anna.user.id, month, note: '$25 coffee card' });
  await api.put('/reviews/rewards', { user_id: anna.user.id, month, note: '$30 coffee card' });
  board = (await api.get(`/reviews/leaderboard?month=${month}`)).data;
  assert.equal(board.rows.find((r) => r.name === 'Anna Smith').reward, '$30 coffee card');
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM review_rewards WHERE user_id = ?', anna.user.id)).n, 1);
});

test('reviews: practice isolation and permissions', async () => {
  const a = await h.practice({ review_url: GOOGLE });
  const b = await h.practice({ review_url: GOOGLE });
  const billing = await person(a.api, 'billing', { name: 'Bill Ing' });
  const pub = h.client();
  await ask(a.api, a.patient.id);
  await pub.post(`/public/review/${tokenOf(h.sent.at(-1).body)}`, { rating: 2 });
  const fb = (await a.api.get('/reviews/feedback')).data[0];
  const anna = await person(a.api, 'hygienist', { name: 'Anna Smith' });
  await pub.post(`/public/review/${tokenOf(h.sent.at(-1).body)}`, { comment: 'Anna was lovely but the wait was long.' });
  const so = (await a.api.get('/reviews/shoutouts')).data[0];
  assert.ok(so);

  // Practice B can't see or touch practice A's patients, feedback, shout-outs or staff.
  assert.equal((await ask(b.api, a.patient.id)).status, 404);
  assert.equal((await b.api.get(`/patients/${a.patient.id}/review-request`)).status, 404);
  assert.equal((await b.api.patch(`/reviews/feedback/${fb.id}`, { status: 'resolved' })).status, 404);
  assert.equal((await b.api.post(`/reviews/shoutouts/${so.id}/confirm`, { user_id: anna.user.id })).status, 404);
  assert.equal((await b.api.post(`/reviews/shoutouts/${so.id}/unlink`, { reason: 'x' })).status, 404);
  assert.equal((await b.api.post('/reviews/nicknames', { user_id: anna.user.id, nickname: 'Annie' })).status, 400);
  assert.equal((await b.api.put('/reviews/rewards', { user_id: anna.user.id, month: '2030-01', note: 'x' })).status, 400);
  assert.equal((await b.api.put('/reviews/settings', { followup_user_id: anna.user.id })).status, 400);
  assert.deepEqual((await b.api.get('/reviews/feedback')).data, []);
  assert.deepEqual((await b.api.get('/reviews/shoutouts')).data, []);
  assert.equal((await b.api.get('/reviews/overview')).data.funnel.sent, 0);

  // Asking needs patients:write; managing needs reviews:manage (administrators have it).
  assert.equal((await ask(billing.api, a.patient.id)).status, 403);
  assert.equal((await billing.api.put('/reviews/settings', { throttle_months: 2 })).status, 403);
  assert.equal((await billing.api.get('/reviews/overview')).data.inbox, null);
  assert.equal((await h.client().get('/reviews/overview')).status, 401);
});
