// K1/K2/K4: metric emails. Due in the practice's time zone, sent once per period whatever happens, every failure
// in Needs attention until the next one works, one-click unsubscribe, the least patient detail, and practices
// kept apart. Routes are expected at /api (routes/digests.js) and /api/public (digestPublicRoutes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { runDigests, dueFor, digestRange, unsubscribeToken, verifyUnsubscribeToken, aiInput, areasForImprovement, buildDigest } from '../src/digests.js';
import { compareMetrics } from '../src/metrics.js';
import { renderEmail } from '../src/email/layout.js';

// A messenger that can be told to fail, to see failures raised and later resolved.
const outbox = [];
const mail = { fail: false };
const messenger = {
  status: { sms: 'test', email: 'test' },
  async send(m) {
    if (mail.fail) throw new Error('SendGrid error 503: try later');
    outbox.push(m);
    return { provider_id: `test-${outbox.length}` };
  },
};
const h = harness({ messenger, config: { digestAi: 'sandbox' } });
const SECRET = 'test-secret';
const run = (now) => runDigests(h.db, messenger, { config: h.config, secret: SECRET, now: new Date(now) });

async function setup(extra = {}) {
  const c = await h.practice({ timezone: 'America/Los_Angeles', ...extra });
  const me = (await c.api.get('/auth/me')).data;
  c.pid = me.practice.id;
  c.userId = me.user.id;
  return c;
}

test('due logic follows the practice’s time zone, office days and the digest’s own day', () => {
  const office = { office_hours: null }; // Mon–Fri
  const sub = (digest, send_time) => ({ digest, send_time });
  assert.equal(dueFor(sub('huddle', '07:00'), office, '2026-09-24 06:59'), null, 'not before its time');
  assert.deepEqual(dueFor(sub('huddle', '07:00'), office, '2026-09-24 07:00'), { periodKey: 'huddle:2026-09-24', date: '2026-09-24' });
  assert.equal(dueFor(sub('huddle', '07:00'), office, '2026-09-26 09:00'), null, 'Saturday: the office is closed');
  assert.equal(dueFor(sub('weekly', '07:00'), office, '2026-09-24 09:00'), null, 'weekly goes on Mondays');
  assert.deepEqual(dueFor(sub('weekly', '07:00'), office, '2026-09-28 07:30'), { periodKey: 'weekly:2026-09-21', date: '2026-09-28' });
  assert.deepEqual(dueFor(sub('monthly', '07:00'), office, '2026-10-01 08:00'), { periodKey: 'monthly:2026-09', date: '2026-10-01' });
  assert.deepEqual(digestRange('weekly', '2026-09-28'), { ...digestRange('weekly', '2026-09-28'), from: '2026-09-21', to: '2026-09-27' });
  assert.deepEqual([digestRange('monthly', '2026-10-01').from, digestRange('monthly', '2026-10-01').to], ['2026-09-01', '2026-09-30']);
  assert.deepEqual(digestRange('end_of_day', '2026-09-24').previous, { from: '2026-09-17', to: '2026-09-17' }, 'a day is compared with the same weekday last week');
});

test('the job sends each digest once per period, at the practice’s local time — restarts and a second server don’t double-send', async () => {
  const c = await setup();
  const add = await c.api.post('/digests/subscriptions', { user_id: c.userId, digest: 'huddle', send_time: '07:00' });
  assert.equal(add.status, 201);
  assert.equal(add.data.audience, 'owner', 'an administrator gets the owner’s version by default');
  const before = outbox.length;
  // 06:30 in Los Angeles (13:30 UTC): not yet.
  await run('2026-09-24T13:30:00Z');
  assert.equal(outbox.length, before);
  // 07:10 there: due. Two servers at once, then a restart: still one email.
  await Promise.all([run('2026-09-24T14:10:00Z'), run('2026-09-24T14:10:00Z')]);
  await run('2026-09-24T14:15:00Z');
  const mine = outbox.slice(before).filter((m) => m.to === c.email);
  assert.equal(mine.length, 1);
  assert.match(mine[0].subject, /^Today at /);
  assert.ok(mine[0].html.includes('Morning huddle'));
  assert.ok(mine[0].body.length > 50, 'with a plain-text version');
  assert.equal(mine[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const sends = await h.db.all('SELECT * FROM digest_sends WHERE subscription_id = ?', add.data.id);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].period_key, 'huddle:2026-09-24');
  const msg = await h.db.get('SELECT * FROM messages WHERE id = ?', sends[0].message_id);
  assert.equal(msg.kind, 'digest');
  assert.equal(msg.status, 'sent');
  // Paused: nothing the next day.
  await c.api.put(`/digests/subscriptions/${add.data.id}`, { status: 'paused' });
  await run('2026-09-25T14:10:00Z');
  assert.equal(outbox.filter((m) => m.to === c.email).length, 1);
});

test('a failed send is a Needs attention item until a later attempt works', async () => {
  const c = await setup();
  const sub = (await c.api.post('/digests/subscriptions', { user_id: c.userId, digest: 'end_of_day', send_time: '18:00' })).data;
  mail.fail = true;
  await run('2026-09-24T01:30:00Z'); // 18:30 on Sep 23 in Los Angeles
  mail.fail = false;
  const issue = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", c.pid, `digest:${sub.id}`);
  assert.ok(issue, 'raised');
  assert.match(issue.title, /end of day email/);
  const failedSend = await h.db.get('SELECT * FROM digest_sends WHERE subscription_id = ?', sub.id);
  assert.equal(failedSend.status, 'failed');
  assert.equal((await h.db.get('SELECT status FROM messages WHERE id = ?', failedSend.message_id)).status, 'failed', 'in the sending log too');
  // The next run the same evening retries the same period, and it goes.
  await run('2026-09-24T01:40:00Z');
  const sent = await h.db.get('SELECT * FROM digest_sends WHERE subscription_id = ?', sub.id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.attempts, 2);
  assert.equal((await h.db.get('SELECT status FROM issues WHERE id = ?', issue.id)).status, 'resolved');
  // The settings screen shows the log with the outcome.
  const screen = (await c.api.get('/digests')).data;
  assert.equal(screen.log[0].status, 'sent');
  assert.equal(screen.subscriptions[0].last_status, 'sent');
});

test('one-click unsubscribe: a signed link, a page with one button, and only the person can turn it back on', async () => {
  const c = await setup();
  const sub = (await c.api.post('/digests/subscriptions', { user_id: c.userId, digest: 'weekly' })).data;
  const token = unsubscribeToken(SECRET, sub.id);
  assert.equal(verifyUnsubscribeToken(SECRET, token), sub.id);
  assert.equal(verifyUnsubscribeToken(SECRET, `${sub.id + 1}.${token.split('.')[1]}`), null, 'a changed id fails the signature');
  assert.equal(verifyUnsubscribeToken('other-secret', token), null);
  const pub = h.client();
  assert.equal((await pub.get(`/public/digests/unsubscribe/${sub.id}.${'x'.repeat(32)}`)).status, 404);
  const page = await pub.get(`/public/digests/unsubscribe/${token}`);
  assert.equal(page.status, 200);
  assert.match(page.data, /Unsubscribe<\/button>/);
  assert.equal((await h.db.get('SELECT status FROM digest_subscriptions WHERE id = ?', sub.id)).status, 'active', 'opening the link changes nothing');
  const done = await pub.post(`/public/digests/unsubscribe/${token}`);
  assert.equal(done.status, 200);
  assert.equal((await h.db.get('SELECT status FROM digest_subscriptions WHERE id = ?', sub.id)).status, 'unsubscribed');
  assert.equal((await pub.post(`/public/digests/unsubscribe/${token}`)).status, 200, 'twice is fine');
  const trail = await h.db.get("SELECT * FROM audit_log WHERE action = 'digest.unsubscribe' AND entity_id = ?", sub.id);
  assert.equal(trail.source, 'human');
  assert.equal(trail.practice_id, c.pid);
  // Nothing goes on Monday.
  const n = outbox.filter((m) => m.to === c.email).length;
  await run('2026-09-28T15:00:00Z');
  assert.equal(outbox.filter((m) => m.to === c.email).length, n);
  // An administrator can't resubscribe someone else; the person can.
  await c.api.post('/users', { email: `bill-${Date.now()}@example.com`, name: 'Bill Ing', role: 'billing', password: 'billing-password-12' });
  const bill = (await c.api.get('/users')).data.find((u) => u.role === 'billing');
  const billSub = (await c.api.post('/digests/subscriptions', { user_id: bill.id, digest: 'weekly' })).data;
  assert.equal(billSub.audience, 'billing');
  await pub.post(`/public/digests/unsubscribe/${unsubscribeToken(SECRET, billSub.id)}`);
  assert.equal((await c.api.put(`/digests/subscriptions/${billSub.id}`, { status: 'active' })).status, 409);
  const billApi = h.client((await h.client().post('/auth/login', { email: bill.email, password: 'billing-password-12' })).data.token);
  assert.equal((await billApi.get('/digests')).status, 403, 'settings are for administrators');
  assert.equal((await billApi.get('/digests/mine')).data.subscriptions.length, 1);
  assert.equal((await billApi.put(`/digests/subscriptions/${sub.id}`, { status: 'paused' })).status, 403, 'not someone else’s');
  const back = await billApi.put(`/digests/subscriptions/${billSub.id}`, { status: 'active', send_time: '05:00' });
  assert.equal(back.status, 200);
  assert.equal(back.data.status, 'active');
  assert.equal(back.data.send_time, '07:00', 'people change only whether theirs is on');
});

test('emails carry the least patient detail: first name and last initial, counts, no contact details', async () => {
  const c = await setup({ timezone: 'UTC' });
  const hyg = (await c.api.post('/providers', { name: 'Hyg. Bea', type: 'hygienist' })).data;
  // Jane Doe had a cleaning last week and left without her next visit booked; she's overdue for recall too.
  const d = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
  await h.db.run("INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'completed')", c.pid, c.patient.id, hyg.id, `${d(8)} 09:00`, `${d(8)} 10:00`);
  await h.db.run("INSERT INTO recalls (practice_id, patient_id, due_date, status) VALUES (?, ?, ?, 'due')", c.pid, c.patient.id, d(20));
  await c.api.put('/metric-goals', { metric: 'hygiene_reappointment', value: 90 });
  const today = d(0);
  const built = await buildDigest(h.db, { practiceId: c.pid, digest: 'weekly', audience: 'owner', date: today, today, appUrl: 'https://app.example.com', config: h.config });
  assert.ok(built.areas.length >= 1 && built.areas.length <= 3);
  const hygArea = built.areas.find((a) => a.metric === 'hygiene_reappointment');
  assert.ok(hygArea, 'the metric furthest from its goal is flagged');
  assert.deepEqual(hygArea.items, ['Jane D.']);
  assert.match(hygArea.link, /^https:\/\/app\.example\.com\/metrics\?metric=hygiene_reappointment/);
  for (const body of [built.html, built.text]) {
    assert.ok(body.includes('Jane D.'));
    assert.ok(!body.includes('Doe'), 'no last name');
    assert.ok(!body.includes('555'), 'no phone number');
    assert.ok(!body.includes('jane@example.com'), 'no patient email');
    assert.ok(!body.includes('1985'), 'no date of birth');
  }
  // The AI is off by default, and when on is given totals only.
  assert.equal(built.ai, null);
  const cmp = await compareMetrics(h.db, c.pid, { from: built.range.from, to: built.range.to, today, keys: ['hygiene_reappointment', 'recall_overdue'] });
  const areas = await areasForImprovement(h.db, c.pid, cmp, { o: { today } });
  const input = aiInput('Weekly summary', 'last week', cmp, areas);
  assert.ok(!/Jane|Doe/.test(input));
  assert.equal((await c.api.put('/digests/settings', { ai_summary: true })).status, 200);
  const withAi = await buildDigest(h.db, { practiceId: c.pid, digest: 'weekly', audience: 'owner', date: today, today, appUrl: 'https://app.example.com', config: h.config, withAi: true });
  assert.match(withAi.html, /Written by AI \(sandbox\)/);
  assert.match(withAi.text, /\[Written by AI \(sandbox\)\]/);
  const settingsTrail = await h.db.get("SELECT changes FROM audit_log WHERE practice_id = ? AND action = 'digest.settings'", c.pid);
  assert.deepEqual(JSON.parse(settingsTrail.changes), { ai_summary: [0, 1] });
  // Names can be left out altogether (an email provider without a BAA): counts and a link only.
  await c.api.put('/digests/settings', { names: false });
  const noNames = await buildDigest(h.db, { practiceId: c.pid, digest: 'weekly', audience: 'owner', date: today, today, appUrl: 'https://app.example.com', config: h.config });
  assert.ok(!noNames.text.includes('Jane'));
  assert.match(noNames.text, /left without their next visit — call to book: 1\. The list is in Dental Machine\./);
});

test('preview, test send and practice isolation', async () => {
  const a = await setup();
  const b = await setup();
  const subA = (await a.api.post('/digests/subscriptions', { user_id: a.userId, digest: 'monthly', audience: 'billing' })).data;
  const p = await a.api.get('/digests/preview?digest=end_of_day&audience=office_manager');
  assert.equal(p.status, 200);
  assert.match(p.data.html, /^<!doctype html>/);
  assert.ok(p.data.text.includes('End of day'));
  assert.equal((await a.api.get('/digests/preview?digest=nope')).status, 400);
  assert.equal((await a.api.get('/digests/preview?date=2026-02-31')).status, 400);
  const sp = await a.api.get(`/digests/subscriptions/${subA.id}/preview`);
  assert.match(sp.data.html, /Unsubscribe from this email/);

  const t = await a.api.post(`/digests/subscriptions/${subA.id}/test`);
  assert.equal(t.status, 200);
  const last = outbox.at(-1);
  assert.equal(last.to, a.email);
  assert.match(last.subject, /^\[Test\] Monthly summary/);
  assert.equal((await h.db.get('SELECT kind FROM messages WHERE id = ?', t.data.message_id)).kind, 'digest_test');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'digest.test_send' AND entity_id = ?", subA.id));

  // Practice B can't see, change, preview or test A's subscription, nor subscribe A's staff.
  assert.equal((await b.api.put(`/digests/subscriptions/${subA.id}`, { status: 'paused' })).status, 404);
  assert.equal((await b.api.get(`/digests/subscriptions/${subA.id}/preview`)).status, 404);
  assert.equal((await b.api.post(`/digests/subscriptions/${subA.id}/test`)).status, 404);
  assert.equal((await b.api.post('/digests/subscriptions', { user_id: a.userId, digest: 'weekly' })).status, 404);
  assert.equal((await b.api.post('/digests/subscriptions', { user_id: b.userId, digest: 'weekly', location_id: 999999 })).status, 404);
  assert.equal((await b.api.get('/digests')).data.subscriptions.length, 0);
  assert.equal((await b.api.post('/digests/subscriptions', { user_id: b.userId, digest: 'weekly', send_time: '25:00' })).status, 400);
});

test('the email layout: phone-friendly HTML with escaped content and a plain-text twin', () => {
  const { html, text } = renderEmail({
    brand: 'Bright <Smiles>', title: 'Hello', blocks: [
      { type: 'stats', items: [{ label: 'Production', value: '$1,000', change: '▲ 5%', good: true }] },
      { type: 'list', title: 'Call', items: ['<script>x</script>'] },
      { type: 'button', text: 'Open', url: 'javascript:alert(1)' },
    ], footer: ['Why you got this'], unsubscribeUrl: 'https://app.example.com/u',
  });
  assert.ok(html.includes('Bright &lt;Smiles&gt;'));
  assert.ok(!html.includes('<script>x'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('max-width:600px'));
  assert.ok(html.includes('@media only screen and (max-width: 480px)'));
  assert.match(text, /Production: \$1,000 \(▲ 5%\)/);
  assert.match(text, /Unsubscribe: https:\/\/app\.example\.com\/u/);
});
