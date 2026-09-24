// Benchmarks across practices (backlog BM1–BM5; docs/workflows/specs/BM-benchmarks.md).
// The routes are served by a small side server on the same database (authenticate → actor → office access →
// benchmarkRoutes, as app.js would), so these tests run whether or not app.js mounts them yet. The benchmark
// service runs in-process: in sandbox mode (seeded made-up peers) or behind a fake HTTPS fetch that forwards to
// the same handler, which is how the http adapter, loggedFetch and failures are exercised.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { authenticate, HttpError } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges, insert, practiceNow } from '../src/util.js';
import { officeAccess } from '../src/officeaccess.js';
import benchmarkRoutes from '../src/routes/benchmarks.js';
import { createBenchmarkClient, runBenchmarkSends, unexpectedKeys, buildSubmission, coachingCards } from '../src/benchmarks.js';
import { benchmarkDigestBlocks } from '../src/benchmarkdigest.js';
import { handle, computeResults, percentiles, standing, peerGroup, groupLabel, quantile, ensureServiceSchema } from '../src/benchmarkservice/service.js';
import { generateKeys, signedHeaders, nonce } from '../src/benchmarkservice/signing.js';
import { ensureSandboxPeers, SANDBOX_PRACTICES } from '../src/benchmarkservice/sandbox.js';
import { regionFor, sizeBandFor, payerMixFor, yearsBandFor } from '../src/benchmarkservice/catalog.js';

const h = harness();
const SECRET = 'test-secret';
let server;
let origin;
const db = {
  all: (...a) => h.db.all(...a), get: (...a) => h.db.get(...a), run: (...a) => h.db.run(...a), tx: (fn) => h.db.tx(fn), savepoint: (fn) => h.db.savepoint(fn),
  get dialect() { return h.db.dialect; },
};

// The adapter the routes use can be swapped per test (sandbox, a failing HTTPS service, …).
let current = null;
const client = {
  get mode() { return current.mode; }, get label() { return current.label; }, get destination() { return current.destination; }, get why() { return current.why; },
  call: (...a) => current.call(...a),
};
const sandbox = (service = {}) => createBenchmarkClient({ db, config: { mode: 'sandbox' }, service });
// An HTTPS benchmark service reached through fetch; `broken` makes it fail like a network outage or a 500.
const remote = { broken: null, calls: 0 };
const httpClient = () => createBenchmarkClient({
  db, config: { mode: 'http', url: 'https://bench.example.test' },
  fetchImpl: async (url, opts) => {
    remote.calls++;
    if (remote.broken === 'network') throw new Error('connect ECONNREFUSED');
    if (remote.broken === '500') return new Response(JSON.stringify({ error: 'The benchmark service had a problem' }), { status: 500, headers: { 'content-type': 'application/json' } });
    const today = new Date().toISOString().slice(0, 10);
    await ensureSandboxPeers(h.db, today);
    const out = await handle(h.db, { path: new URL(url).pathname, headers: Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v])), body: opts.body });
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json', 'x-request-id': out.body?.receipt || 'none' } });
  },
});

before(async () => {
  current = sandbox();
  const app = express();
  app.use(actorMiddleware(db, flushChanges));
  app.use(express.json());
  const api = express.Router();
  api.use(authenticate(db, SECRET));
  api.use((req, _res, next) => {
    setActor({ source: 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: req.user.name, locationId: req.location_id ?? null });
    next();
  });
  api.use(officeAccess(db));
  api.use(benchmarkRoutes({ db, secret: SECRET, client }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { if (!(err instanceof HttpError)) console.error(err); res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const side = (token) => {
  const call = async (method, path, body) => {
    const res = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
};

// A practice (in Texas, UTC) with a dentist who did eight recall exams today and charted a filling at each.
async function setUp({ name = 'Dr. Ann Lee, DDS' } = {}) {
  const p = await h.practice({ timezone: 'UTC' });
  const pid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', p.provider.id)).practice_id;
  await h.db.run('UPDATE providers SET name = ? WHERE id = ?', name, p.provider.id);
  const today = (await practiceNow(h.db, pid)).slice(0, 10);
  const code = (c) => h.db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', pid, c);
  const exam = await code('D0120');
  const fill = await code('D2391');
  const patients = [];
  for (let i = 0; i < 8; i++) {
    const pt = await insert(h.db, 'patients', { practice_id: pid, first_name: `Zelda${i}`, last_name: `Quimby${i}`, dob: '1980-02-03', phone: '(512) 555-0199', email: `zq${i}@example.com` });
    patients.push(pt);
    await insert(h.db, 'procedures', { practice_id: pid, patient_id: pt, code_id: exam.id, code: exam.code, description: exam.description, category: exam.category, fee: exam.fee, status: 'completed', completed_at: `${today} 09:00:00`, provider_id: p.provider.id });
    await insert(h.db, 'procedures', { practice_id: pid, patient_id: pt, code_id: fill.id, code: fill.code, description: fill.description, category: fill.category, fee: 20000, status: 'planned', provider_id: p.provider.id, tooth: '30', surfaces: 'MO' });
  }
  const admin = side(p.token);
  return { ...p, pid, today, admin, patients };
}
async function staff(p, role, extra = {}) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = (await p.api.post('/users', { name: `${role} person`, email, password: 'correct-horse-battery', role, ...extra })).data;
  const token = (await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token;
  return { user: u, api: side(token) };
}
const join = (c, body = {}) => c.admin.post('/benchmarks/join', { agree: true, ...body });

test('the payload holds provider aggregates only: no patient fields, no names unless chosen', async () => {
  current = sandbox();
  const c = await setUp();
  const pre = await c.admin.get('/benchmarks/preview');
  assert.equal(pre.status, 200, JSON.stringify(pre.data));
  const payload = pre.data.payload;
  assert.deepEqual(unexpectedKeys(payload), [], 'every field is on the shared list');
  // The only date in it is when it was sent (no visit, birth or exam dates).
  const text = JSON.stringify({ ...payload, sent_at: undefined });
  for (const leak of ['Zelda', 'Quimby', '1980-02-03', '555-0199', 'example.com', 'Ann Lee', c.today, 'patient_id', 'first_name', 'dob']) assert.ok(!text.includes(leak), `payload must not contain ${leak}`);
  const month = payload.months.find((m) => m.month === c.today.slice(0, 7));
  const dx = month.rows.find((r) => r.metric === 'dx_per_exam_recall' && r.role === 'dentist');
  assert.ok(dx, 'the dentist’s recall-exam diagnosis is shared');
  assert.equal(dx.value, 20000, '$200 diagnosed per recall exam (8 fillings over 8 exams), from diagnosis.js');
  assert.equal(dx.n, 8);
  assert.match(dx.provider_key, /^k_[a-f0-9]{16}$/);
  assert.match(dx.anon_code, /^\d{4}$/);
  assert.equal(dx.display_name, undefined);
  assert.ok(month.rows.find((r) => r.metric === 'conv_presented'), 'funnel steps are shared once there are five findings');
  assert.ok(!month.rows.some((r) => r.metric === 'case_acceptance' && r.role === 'dentist'), 'numbers resting on too small a sample are left out');
  for (const r of month.rows) assert.deepEqual(Object.keys(r).filter((k) => !['provider_key', 'role', 'anon_code', 'metric', 'value', 'n'].includes(k)), []);
  assert.deepEqual(Object.keys(payload.profile).sort(), ['payer_mix', 'practice_type', 'region', 'size_band', 'years_band']);
  assert.equal(payload.profile.region, 'south');
  // The service refuses anything that isn't on the list, even if the app were to send it.
  const bad = { ...payload, months: [{ ...month, rows: [{ ...dx, patient_name: 'Zelda' }] }] };
  assert.ok(unexpectedKeys(bad).includes('patient_name'));
});

test('opt-in is off by default: nothing is computed or sent, and no results are shown', async () => {
  let calls = 0;
  current = { mode: 'sandbox', label: 'spy', destination: 'spy', call: async () => { calls++; throw new Error('must not be called'); } };
  const c = await setUp();
  assert.equal((await c.admin.get('/benchmarks/status')).data.status, 'off');
  assert.equal(await runBenchmarkSends(h.db, { client, secret: SECRET }), 0);
  assert.equal(calls, 0);
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM bm_sends WHERE practice_id = ?', c.pid)).n), 0);
  const res = await c.admin.get('/benchmarks/results');
  assert.equal(res.status, 200);
  assert.equal(res.data.joined, false);
  assert.equal((await c.admin.post('/benchmarks/send-now')).status, 409);
  assert.equal((await c.admin.post('/benchmarks/join', {})).status, 400, 'joining needs the owner to agree');
  assert.equal(calls, 0);
  current = sandbox();
});

test('the service checks signatures, refuses replays, stale times and fields that are not shared', async () => {
  await ensureServiceSchema(h.db);
  const keys = generateKeys();
  const other = generateKeys();
  const pid = `bp_${'a1'.repeat(12)}`;
  const profile = { practice_type: 'general', region: 'west', size_band: 'small', payer_mix: 'mixed', years_band: 'established' };
  const send = (path, payload, { key = keys.privateKey, now = Date.now(), tamper = null } = {}) => {
    const body = JSON.stringify(payload);
    const headers = signedHeaders({ participantId: pid, privateKey: key, body, now });
    return handle(h.db, { path, headers, body: tamper ? tamper(body) : body });
  };
  const joined = await send('/v1/join', { v: 1, kind: 'join', participant_id: pid, nonce: nonce(), sent_at: 'x', public_key: keys.publicKey, profile });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  // A join signed by a different key than the one it registers is refused (proof of possession).
  const pid2 = `bp_${'b2'.repeat(12)}`;
  const body2 = JSON.stringify({ v: 1, kind: 'join', participant_id: pid2, nonce: nonce(), public_key: keys.publicKey, profile });
  assert.equal((await handle(h.db, { path: '/v1/join', headers: signedHeaders({ participantId: pid2, privateKey: other.privateKey, body: body2 }), body: body2 })).status, 401);

  const month = new Date().toISOString().slice(0, 7);
  const rows = [{ provider_key: 'k_0123456789abcdef', role: 'dentist', anon_code: '4821', metric: 'case_acceptance', value: 61.5, n: 12 }];
  const submit = () => ({ v: 1, kind: 'submit', participant_id: pid, nonce: nonce(), profile, months: [{ month, complete: false, rows }] });
  const ok = await send('/v1/submit', submit());
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.accepted_rows, 1);
  assert.equal((await send('/v1/submit', submit(), { key: other.privateKey })).status, 401, 'signed with someone else’s key');
  assert.equal((await send('/v1/submit', submit(), { tamper: (b) => b.replace('61.5', '99.5') })).status, 401, 'changed on the way');
  assert.equal((await send('/v1/submit', submit(), { now: Date.now() - 60 * 60 * 1000 })).status, 401, 'an hour old');
  const once = submit();
  assert.equal((await send('/v1/submit', once)).status, 200);
  assert.equal((await send('/v1/submit', once)).status, 409, 'the same request twice is a replay');
  const unsigned = JSON.stringify(submit());
  assert.equal((await handle(h.db, { path: '/v1/submit', headers: { 'x-dm-participant': pid }, body: unsigned })).status, 401);
  const extra = submit();
  extra.months[0].rows = [{ ...rows[0], patient_id: 12 }];
  assert.equal((await send('/v1/submit', extra)).status, 400, 'a field that is not shared is refused');
  const named = submit();
  named.months[0].rows = [{ ...rows[0], role: 'practice', metric: 'collection_rate', display_name: 'Smile Dental' }];
  assert.equal((await send('/v1/submit', named)).status, 400, 'practices are never named');
  const odd = submit();
  odd.months[0].rows = [{ ...rows[0], metric: 'patients_list' }];
  assert.equal((await send('/v1/submit', odd)).status, 400);
  // Resending a month replaces it (idempotent).
  await send('/v1/submit', submit());
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM bms_rows WHERE participant_id = ?', pid)).n), 1);
});

test('percentiles, standing and peer groups', () => {
  const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110];
  assert.equal(quantile(v, 0.5), 60);
  assert.equal(quantile([1, 2], 0.5), 1.5);
  assert.deepEqual(percentiles(v, 'higher', 'percent'), { p25: 35, p50: 60, p75: 85, p90: 100 });
  // Lower is better (no-show rate): the 90th percentile of performance is the low end.
  assert.deepEqual(percentiles(v, 'lower', 'percent'), { p25: 85, p50: 60, p75: 35, p90: 20 });
  assert.equal(standing(v, 80, 'higher'), 70, 'better than 7 of the 10 others');
  assert.equal(standing(v, 80, 'lower'), 30);
  assert.equal(standing([5], 5), null, 'alone: no standing');

  const profile = { practice_type: 'general', region: 'south', size_band: 'small', payer_mix: 'mixed', years_band: 'new' };
  const byId = new Map();
  const add = (id, p) => byId.set(id, { participant_id: id, ...profile, ...p });
  add('me', {});
  for (let i = 0; i < 6; i++) add(`same${i}`, {});
  for (let i = 0; i < 5; i++) add(`older${i}`, { years_band: 'mature' });
  for (let i = 0; i < 20; i++) add(`north${i}`, { region: 'northeast', size_band: 'large', payer_mix: 'fee_for_service' });
  for (let i = 0; i < 20; i++) add(`ortho${i}`, { practice_type: 'ortho' });
  const everyone = new Set(byId.keys());
  // 7 identical → too few; dropping years gives 12 ≥ 10.
  const g = peerGroup(profile, byId, everyone, 10);
  assert.deepEqual(g.dims, ['practice_type', 'region', 'size_band', 'payer_mix']);
  assert.equal(g.practices, 12);
  assert.equal(groupLabel(profile, g.dims), 'General practices · South · 2–3 dentists · Mixed insurance and self-pay');
  // Needing 30: widened until only practice type is left (32 general practices).
  const wide = peerGroup(profile, byId, everyone, 30);
  assert.deepEqual(wide.dims, ['practice_type']);
  assert.equal(wide.practices, 32);
  assert.equal(peerGroup(profile, byId, everyone, 100), null);
  // Profile bands.
  assert.equal(regionFor('tx'), 'south');
  assert.equal(regionFor('ON'), 'other');
  assert.equal(sizeBandFor(1), 'solo');
  assert.equal(sizeBandFor(5), 'medium');
  assert.equal(payerMixFor(70), 'insurance_heavy');
  assert.equal(payerMixFor(10), 'fee_for_service');
  assert.equal(yearsBandFor(2020, 2026), 'established');
  assert.equal(yearsBandFor(null, 2026), 'unknown');
});

test('a benchmark shows only with at least N practices in the peer group', () => {
  const participants = [];
  const rows = [];
  const add = (i) => {
    const id = `p${i}`;
    participants.push({ participant_id: id, practice_type: 'general', region: 'west', size_band: 'solo', payer_mix: 'mixed', years_band: 'new' });
    rows.push({ participant_id: id, provider_key: `k${i}`, role: 'dentist', anon_code: String(1000 + i), display_name: null, metric: 'case_acceptance', value: 40 + i, n: 20 });
  };
  for (let i = 0; i < 9; i++) add(i);
  let r = computeResults({ participants, rows, me: 'p0', month: '2026-08', minPeers: 10 });
  const m = r.metrics.find((x) => x.metric === 'case_acceptance');
  assert.equal(m.suppressed, true);
  assert.equal(m.percentiles, undefined);
  assert.equal(m.mine[0].standing, null, 'no standing when hidden');
  assert.equal(r.leaderboards.length, 0, 'no leaderboard either');
  add(9);
  r = computeResults({ participants, rows, me: 'p0', month: '2026-08', minPeers: 10 });
  const shown = r.metrics.find((x) => x.metric === 'case_acceptance');
  assert.equal(shown.suppressed, false);
  assert.equal(shown.group.practices, 10);
  assert.equal(shown.mine[0].standing, 1, 'the lowest value is the 1st percentile');
  assert.equal(r.leaderboards[0].entries[0].label, 'Dr. #1009');
  assert.equal(r.leaderboards[0].entries[0].badge.tier, 'gold');
});

test('joining sends signed numbers; results show percentiles, anonymous leaderboards and coaching cards', async () => {
  current = sandbox();
  const c = await setUp();
  const res = await join(c, { practice_type: 'general', founded_year: 2015 });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.ok(!res.data.first_send.error, JSON.stringify(res.data.first_send));
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'benchmark.join'", c.pid), 'joining is audited');
  const s = await h.db.get('SELECT * FROM bm_settings WHERE practice_id = ?', c.pid);
  assert.equal(s.status, 'joined');
  assert.ok(s.signing_secret.startsWith('v1.'), 'the private key is sealed, not stored in the clear');
  assert.ok(!s.signing_secret.includes('PRIVATE KEY'));
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM bms_participants WHERE synthetic = 1')).n), SANDBOX_PRACTICES);
  const stored = await h.db.all('SELECT * FROM bms_rows WHERE participant_id = ?', s.participant_id);
  assert.ok(stored.length > 0);
  assert.ok(stored.every((r) => r.display_name == null), 'nobody is named until they choose to be');
  // Recorded in Connection activity.
  assert.ok(await h.db.get("SELECT id FROM integration_log WHERE practice_id = ? AND service = 'Benchmarks (sandbox)' AND operation = 'POST /v1/submit' AND ok = 1", c.pid));

  const r = await c.admin.get(`/benchmarks/results?month=${c.today.slice(0, 7)}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const dx = r.data.metrics.find((m) => m.metric === 'dx_per_exam_recall' && m.role === 'dentist');
  assert.equal(dx.suppressed, false);
  assert.ok(dx.group.practices >= 10);
  assert.ok(['p25', 'p50', 'p75', 'p90'].every((k) => typeof dx.percentiles[k] === 'number'));
  assert.ok(dx.percentiles.p25 <= dx.percentiles.p50 && dx.percentiles.p50 <= dx.percentiles.p75 && dx.percentiles.p75 <= dx.percentiles.p90);
  assert.equal(dx.mine[0].provider_id, c.provider.id);
  assert.equal(typeof dx.mine[0].standing, 'number');
  const board = r.data.leaderboards.find((b) => b.metric === 'dx_per_exam_recall' && b.role === 'dentist');
  assert.ok(board.entries.length >= 10);
  for (const e of board.entries.filter((x) => !x.mine)) {
    assert.ok(e.named ? /^Dr\. [A-Z]/.test(e.label) : /^Dr\. #\d{4}$/.test(e.label), e.label);
    assert.deepEqual(Object.keys(e).filter((k) => !['rank', 'label', 'named', 'region', 'practice_type', 'value', 'badge', 'mine', 'sample'].includes(k)), [], 'region and type only');
    assert.equal(e.sample, true, 'sandbox peers are labelled as samples');
  }
  assert.ok(board.entries.some((e) => e.badge?.tier === 'gold'));
  const mine = board.entries.find((e) => e.mine);
  assert.equal(mine.you, 'Dr. Ann Lee, DDS', 'our own row carries our own name (it never left the practice)');
  const card = r.data.cards.find((x) => x.provider_id === c.provider.id);
  assert.ok(card.compared > 0);
  assert.match(card.headline, /^You are at the \d+(st|nd|rd|th) percentile for /);
  assert.ok(card.opportunities.length <= 3);
  for (const o of card.opportunities) assert.ok(o.standing < 50);
  // The monthly email reads the answer the nightly send keeps (here: this month's, stored the same way).
  await h.db.run('UPDATE bm_settings SET last_results = ?, last_results_month = ? WHERE practice_id = ?', JSON.stringify({ month: r.data.month, cards: r.data.cards, sample: true }), r.data.month, c.pid);
  const blocks = await benchmarkDigestBlocks(h.db, { practiceId: c.pid, appUrl: 'https://app.example.com' });
  assert.equal(blocks[0].type, 'heading');
  assert.ok(blocks[1].items.some((i) => i.startsWith('Dr. Ann Lee, DDS: Above the peer median on ')), JSON.stringify(blocks[1].items));
  for (const i of blocks[1].items) assert.ok(!/Zelda|Quimby/.test(i));
  const { buildDigest } = await import('../src/digests.js');
  const email = await buildDigest(h.db, { practiceId: c.pid, digest: 'monthly', audience: 'owner', date: c.today, today: c.today, appUrl: 'https://app.example.com' });
  assert.match(email.text, /How you compare with practices like yours/i);
  const billing = await buildDigest(h.db, { practiceId: c.pid, digest: 'monthly', audience: 'billing', date: c.today, today: c.today, appUrl: 'https://app.example.com' });
  assert.doesNotMatch(billing.text, /How you compare/i);
  assert.deepEqual(coachingCards({ metrics: [] }, [{ provider_key: 'k' }]), []);
});

test('doctors choose to be named; the owner can only turn it off', async () => {
  current = sandbox();
  const c = await setUp();
  await join(c);
  const doc = await staff(c, 'dentist');
  await c.api.put(`/providers/${c.provider.id}`, { user_id: doc.user.id });
  // The owner can't name a doctor.
  assert.equal((await c.admin.put(`/benchmarks/providers/${c.provider.id}/name`, { show_name: true })).status, 403);
  let payload = await buildSubmission(h.db, c.pid, { today: c.today });
  assert.ok(payload.months.every((m) => m.rows.every((r) => r.display_name === undefined)));
  const me = await doc.api.get('/benchmarks/status');
  assert.match(me.data.me.anonymous_as, /^Dr\. #\d{4}$/);
  const on = await doc.api.put(`/benchmarks/providers/${c.provider.id}/name`, { show_name: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.shown_as, 'Dr. Ann Lee');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'benchmark.name_display'", c.pid));
  payload = await buildSubmission(h.db, c.pid, { today: c.today });
  const named = payload.months.flatMap((m) => m.rows).filter((r) => r.display_name);
  assert.ok(named.length > 0 && named.every((r) => r.display_name === 'Dr. Ann Lee' && r.role === 'dentist'));
  // Another doctor can't name her.
  const other = await staff(c, 'dentist');
  assert.equal((await other.api.put(`/benchmarks/providers/${c.provider.id}/name`, { show_name: false })).status, 403);
  // The owner can turn it off.
  assert.equal((await c.admin.put(`/benchmarks/providers/${c.provider.id}/name`, { show_name: false })).status, 200);
  payload = await buildSubmission(h.db, c.pid, { today: c.today });
  assert.ok(payload.months.every((m) => m.rows.every((r) => r.display_name === undefined)));
});

test('the owner can see exactly what was sent', async () => {
  current = sandbox();
  const c = await setUp();
  await join(c);
  const list = await c.admin.get('/benchmarks/sends');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.map((x) => x.kind).sort(), ['join', 'submit']);
  const sub = list.data.find((x) => x.kind === 'submit');
  assert.equal(sub.status, 'sent');
  assert.equal(sub.accepted_rows, sub.rows, 'reconciled: every row sent was stored');
  assert.ok(sub.receipt);
  const one = await c.admin.get(`/benchmarks/sends/${sub.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.data.payload.kind, 'submit');
  // What the owner sees is byte for byte what the service received.
  const rec = await h.db.get('SELECT body_sha256 FROM bms_receipts WHERE receipt = ?', sub.receipt);
  assert.equal(rec.body_sha256, one.data.payload_sha256);
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(one.data.payload_text).digest('hex'), rec.body_sha256);
  // Send now is audited.
  assert.equal((await c.admin.post('/benchmarks/send-now')).status, 200);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'benchmark.send'", c.pid));
  // The nightly job sends once per practice day, however often it runs.
  await runBenchmarkSends(h.db, { client, secret: SECRET });
  await runBenchmarkSends(h.db, { client, secret: SECRET });
  const nightly = await h.db.all("SELECT id FROM bm_sends WHERE practice_id = ? AND cause = 'nightly'", c.pid);
  const hour = Number((await practiceNow(h.db, c.pid)).slice(11, 13));
  assert.equal(nightly.length, hour >= 1 ? 1 : 0);
});

test('leaving deletes the practice’s rows from the service and stops sending', async () => {
  current = sandbox();
  const c = await setUp();
  await join(c);
  const s = await h.db.get('SELECT participant_id, signing_secret FROM bm_settings WHERE practice_id = ?', c.pid);
  assert.ok(Number((await h.db.get('SELECT COUNT(*) AS n FROM bms_rows WHERE participant_id = ?', s.participant_id)).n) > 0);
  const out = await c.admin.post('/benchmarks/leave');
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.left, true);
  assert.ok(out.data.removed_rows > 0);
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM bms_rows WHERE participant_id = ?', s.participant_id)).n), 0);
  assert.equal((await h.db.get('SELECT status FROM bms_participants WHERE participant_id = ?', s.participant_id)).status, 'left');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'benchmark.leave'", c.pid));
  const after = await h.db.get('SELECT status, signing_secret FROM bm_settings WHERE practice_id = ?', c.pid);
  assert.equal(after.status, 'left');
  assert.equal(after.signing_secret, null, 'the key is forgotten');
  // Nothing more goes out; the results screen says so; the sent log is kept.
  const before = Number((await h.db.get('SELECT COUNT(*) AS n FROM bm_sends WHERE practice_id = ?', c.pid)).n);
  await runBenchmarkSends(h.db, { client, secret: SECRET });
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM bm_sends WHERE practice_id = ?', c.pid)).n), before);
  assert.equal((await c.admin.get('/benchmarks/results')).data.joined, false);
  // Re-joining makes a brand-new participant, not linkable to the old one.
  assert.equal((await join(c)).status, 201);
  const again = await h.db.get('SELECT participant_id FROM bm_settings WHERE practice_id = ?', c.pid);
  assert.notEqual(again.participant_id, s.participant_id);
});

test('if the service can’t be reached while leaving, nothing more is sent and the job keeps asking', async () => {
  current = httpClient();
  remote.broken = null;
  const c = await setUp();
  assert.equal((await join(c)).status, 201);
  remote.broken = 'network';
  const out = await c.admin.post('/benchmarks/leave');
  assert.equal(out.data.pending, true);
  assert.equal((await h.db.get('SELECT status FROM bm_settings WHERE practice_id = ?', c.pid)).status, 'leaving');
  assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = 'benchmark-leave' AND status = 'open'", c.pid));
  remote.broken = null;
  await runBenchmarkSends(h.db, { client, secret: SECRET });
  assert.equal((await h.db.get('SELECT status FROM bm_settings WHERE practice_id = ?', c.pid)).status, 'left');
  assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = 'benchmark-leave' AND status = 'resolved'", c.pid));
  current = sandbox();
});

test('permissions: joining, leaving, settings and sent payloads are the owner’s; doctors see their own card', async () => {
  current = sandbox();
  const c = await setUp();
  const desk = await staff(c, 'front_desk');
  const dentist = await staff(c, 'dentist');
  for (const [method, path, body] of [['post', '/benchmarks/join', { agree: true }], ['post', '/benchmarks/leave'], ['post', '/benchmarks/send-now'], ['get', '/benchmarks/settings'], ['put', '/benchmarks/settings', { practice_type: 'ortho' }], ['get', '/benchmarks/sends'], ['get', '/benchmarks/preview']]) {
    assert.equal((await dentist.api[method](path, body)).status, 403, `${method} ${path}`);
    assert.equal((await desk.api[method](path, body)).status, 403, `${method} ${path}`);
  }
  assert.equal((await c.admin.put('/benchmarks/settings', { practice_type: 'nope' })).status, 400);
  assert.equal((await c.admin.put('/benchmarks/settings', { founded_year: 3000 })).status, 400);
  const set = await c.admin.put('/benchmarks/settings', { practice_type: 'general', founded_year: 2001, share_labor: false });
  assert.equal(set.status, 200);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'benchmark.settings'", c.pid));
  await join(c);
  assert.equal((await desk.api.get('/benchmarks/results')).status, 403, 'no report permission');
  assert.equal((await dentist.api.get(`/benchmarks/results?month=${c.today.slice(0, 7)}`)).status, 200, 'dentists have reports:read');
  // A hygienist with only reports:own sees her own card and no one else's numbers.
  const hyg = await staff(c, 'hygienist', { permissions_add: ['reports:own'] });
  const hp = (await c.api.post('/providers', { name: 'Hana Hygienist, RDH', type: 'hygienist' })).data;
  await c.api.put(`/providers/${hp.id}`, { user_id: hyg.user.id });
  const hers = await hyg.api.get(`/benchmarks/results?month=${c.today.slice(0, 7)}`);
  assert.equal(hers.status, 200);
  assert.ok(hers.data.metrics.every((m) => m.mine.every((x) => x.provider_id === hp.id)));
  assert.ok(hers.data.cards.every((x) => x.provider_id === hp.id));
  assert.ok(hers.data.metrics.every((m) => m.role !== 'practice'));
  assert.equal((await c.admin.get('/benchmarks/results?month=2026-13')).status, 400);
});

test('practice isolation: one practice never sees another’s sends, keys or numbers', async () => {
  current = sandbox();
  const a = await setUp();
  const b = await setUp({ name: 'Dr. Bo Kim, DMD' });
  await join(a);
  const aSend = (await a.admin.get('/benchmarks/sends')).data[0];
  assert.equal((await b.admin.get(`/benchmarks/sends/${aSend.id}`)).status, 404);
  assert.deepEqual((await b.admin.get('/benchmarks/sends')).data, []);
  assert.equal((await b.admin.get('/benchmarks/results')).data.joined, false);
  assert.equal((await b.admin.put(`/benchmarks/providers/${a.provider.id}/name`, { show_name: false })).status, 404);
  await join(b);
  const br = await b.admin.get(`/benchmarks/results?month=${b.today.slice(0, 7)}`);
  const aKeys = new Set((await h.db.all('SELECT provider_key FROM bm_providers WHERE practice_id = ?', a.pid)).map((x) => x.provider_key));
  for (const m of br.data.metrics) for (const x of m.mine) assert.ok(!aKeys.has(x.provider_key));
  for (const board of br.data.leaderboards) for (const e of board.entries) if (e.mine) assert.ok(!aKeys.has(e.provider_key));
  // A's own row appears on B's board only anonymously.
  const text = JSON.stringify(br.data);
  assert.ok(!text.includes('Ann Lee'));
});

test('a failed send becomes a Needs attention item and the next good send resolves it', async () => {
  current = httpClient();
  remote.broken = null;
  const c = await setUp();
  assert.equal((await join(c)).status, 201);
  assert.ok(await h.db.get("SELECT id FROM integration_log WHERE practice_id = ? AND service = 'bench.example.test' AND ok = 1", c.pid), 'the https call is in Connection activity');
  remote.broken = '500';
  const failed = await c.admin.post('/benchmarks/send-now');
  assert.equal(failed.status, 502);
  const issue = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = 'benchmark-send' AND status = 'open'", c.pid);
  assert.ok(issue, 'raised in Needs attention');
  assert.equal(issue.role, 'admin');
  assert.ok(await h.db.get("SELECT id FROM bm_sends WHERE practice_id = ? AND status = 'failed' AND http_status = 500", c.pid));
  assert.ok(await h.db.get("SELECT id FROM integration_log WHERE practice_id = ? AND service = 'bench.example.test' AND ok = 0", c.pid));
  remote.broken = 'network';
  assert.equal((await c.admin.post('/benchmarks/send-now')).status, 502);
  assert.equal(Number((await h.db.get("SELECT occurrences FROM issues WHERE id = ?", issue.id)).occurrences), 2, 'the same problem counts up, not a new item');
  remote.broken = null;
  assert.equal((await c.admin.post('/benchmarks/send-now')).status, 200);
  assert.equal((await h.db.get('SELECT status FROM issues WHERE id = ?', issue.id)).status, 'resolved');
  // A plain-http URL is refused: numbers only travel over TLS.
  const plain = createBenchmarkClient({ db, config: { mode: 'http', url: 'http://bench.example.test' } });
  assert.equal(plain.mode, 'off');
  current = sandbox();
});

test('with too few peers nothing is shown, through the whole path', async () => {
  current = sandbox({ minPeers: 1000 });
  const c = await setUp();
  await join(c);
  const r = await c.admin.get(`/benchmarks/results?month=${c.today.slice(0, 7)}`);
  assert.equal(r.status, 200);
  assert.ok(r.data.metrics.length > 0);
  assert.ok(r.data.metrics.every((m) => m.suppressed && m.percentiles === undefined));
  assert.deepEqual(r.data.leaderboards, []);
  current = sandbox();
});

test('the settings screen lists what is shared and each doctor’s name setting', async () => {
  current = sandbox();
  const c = await setUp();
  const s = await c.admin.get('/benchmarks/settings');
  assert.equal(s.status, 200);
  assert.equal(s.data.status, 'off');
  assert.equal(s.data.mode, 'sandbox');
  assert.ok(s.data.shared.some((x) => x.key === 'dx_per_exam_recall'));
  assert.ok(s.data.terms.length >= 4);
  assert.equal(s.data.profile.region, 'south');
  assert.equal(s.data.providers[0].show_name, false);
  assert.match(s.data.providers[0].anonymous_as, /^Dr\. #\d{4}$/);
  const json = JSON.stringify(s.data);
  assert.ok(!json.includes('signing_secret') && !json.includes('PRIVATE KEY'));
});
