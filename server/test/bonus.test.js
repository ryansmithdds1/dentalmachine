// Team bonus module (BN1–BN3; docs/workflows/specs/BN-bonus.md). The routes are served by a small side server on
// the harness database (authenticate → actor → bonusRoutes, as app.js would), so these tests run whether or not
// app.js mounts them yet. The payroll export is the real, mounted time-clock route. "Today" for the bonus routes is
// pinned to 2026-09-15 (app.locals.bonusToday), so July and August 2026 are finished periods.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { authenticate, HttpError, PERMISSION_CATALOG } from '../src/auth.js';
import { actorMiddleware, setActor } from '../src/actor.js';
import { flushChanges, insert } from '../src/util.js';
import { periodFor, DEFAULT_SETTINGS } from '../src/timeclock.js';
import { ensureBusinessSchema } from '../src/businessdata.js';
import bonusRoutes from '../src/routes/bonus.js';
import { teamPool, splitPool, applyCaps, recover, overBase, tierFor, normalizeConfig, periodOf, kpiMet, PLAN_TYPES } from '../src/bonus.js';

const TODAY = '2026-09-15';
const h = harness();
let server;
let origin;
const db = {
  all: (...a) => h.db.all(...a), get: (...a) => h.db.get(...a), run: (...a) => h.db.run(...a), tx: (fn) => h.db.tx(fn), savepoint: (fn) => h.db.savepoint(fn),
  get dialect() { return h.db.dialect; },
};
before(async () => {
  const app = express();
  app.locals.bonusToday = () => TODAY;
  app.use(actorMiddleware(db, flushChanges));
  app.use(express.json());
  const api = express.Router();
  api.use(authenticate(db, 'test-secret'));
  api.use((req, _res, next) => {
    const ai = req.get('X-Acting-For') === 'assistant';
    setActor({ source: ai ? 'ai' : 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: ai ? `Assistant (for ${req.user.name})` : req.user.name });
    next();
  });
  api.use(bonusRoutes({ db }));
  app.use('/api', api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { if (!(err instanceof HttpError)) console.error(err); res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const client = (token, headers = {}) => {
  const call = async (method, path, body) => {
    const res = await fetch(`${origin}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };

async function member(p, role, name) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = ok(await p.api.post('/users', { email, name, role, password: 'correct-horse-battery' }), 201);
  const login = await h.client(null, { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }).post('/auth/login', { email, password: 'correct-horse-battery' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { ...u, token: login.data.token, b: client(login.data.token) };
}

// A practice with four staff: Amy (assistant), Bea (hygienist), Cal (front desk), Dee (assistant, part time).
async function setUp() {
  const p = await h.practice({ timezone: 'UTC' });
  const pid = (await h.db.get('SELECT practice_id FROM providers WHERE id = ?', p.provider.id)).practice_id;
  const adminId = (await h.db.get("SELECT id FROM users WHERE practice_id = ? AND role = 'admin'", pid)).id;
  const b = client(p.token);
  const amy = await member(p, 'assistant', 'Amy Assistant');
  const bea = await member(p, 'hygienist', 'Bea Hygienist');
  const cal = await member(p, 'front_desk', 'Cal Desk');
  const dee = await member(p, 'assistant', 'Dee Parttime');
  const punch = (u, date) => insert(h.db, 'time_punches', { practice_id: pid, user_id: u.id, clock_in: `${date} 08:00`, clock_out: `${date} 16:00` });
  const pay = (cents, date) => insert(h.db, 'ledger_entries', { practice_id: pid, patient_id: p.patient.id, type: 'payment', amount: -cents, description: 'Payment', entry_date: date });
  const charge = (cents, date, extra = {}) => insert(h.db, 'ledger_entries', { practice_id: pid, patient_id: p.patient.id, type: 'charge', amount: cents, description: 'Charge', entry_date: date, ...extra });
  // Hours in July and August: Amy 4 days, Bea 3, Cal 2, Dee 1 (8 hours each) — the 4:3:2 split of the worked example.
  for (const [month, days] of [['07', ['06', '07', '08', '09']], ['08', ['17', '18', '19', '20']]]) {
    for (const d of days) await punch(amy, `2026-${month}-${d}`);
    for (const d of days.slice(0, 3)) await punch(bea, `2026-${month}-${d}`);
    for (const d of days.slice(0, 2)) await punch(cal, `2026-${month}-${d}`);
    await punch(dee, `2026-${month}-${days[0]}`);
  }
  await ok(await b.put('/bonus/settings', { enabled: true }));
  return { p, pid, adminId, b, amy, bea, cal, dee, pay, charge, punch };
}
const lineOf = (review, u) => review.people.find((x) => x.user_id === u.id);
const teamConfig = (extra = {}) => ({ basis: 'collections', target_mode: 'fixed', target_cents: 9_000_000, share_bp: 2000, split: 'hours', eligibility: { min_hours: 10 }, ...extra });

// ---------------- The money math ----------------

test('money math: pool, exact splits, caps, clawback recovery, tiers — and the worked examples add up', () => {
  // Team example: $98,000 collected over a $90,000 target, 20% share → $1,600 split 160:120:80 hours.
  const { excess, pool } = teamPool({ actual: 9_800_000, target: 9_000_000, share_bp: 2000 });
  assert.equal(excess, 800_000);
  assert.equal(pool, 160_000);
  assert.deepEqual(splitPool(pool, [160, 120, 80]), [71_111, 53_333, 35_556]);
  assert.match(PLAN_TYPES.team_collections.example, /Maria \$711\.11, Sam \$533\.33, Jo \$355\.56/);
  // Labor target: $19,800 ÷ 22% = $90,000.
  assert.equal(Math.round((1_980_000 * 10000) / 2200), 9_000_000);
  // Under the target: no pool, never negative. Nobody with hours: nothing paid (not all to one person).
  assert.deepEqual(teamPool({ actual: 100, target: 500, share_bp: 5000 }), { excess: 0, pool: 0 });
  assert.deepEqual(splitPool(1000, [0, 0]), [0, 0]);
  assert.deepEqual(splitPool(100, [1, 1, 1]), [34, 33, 33]);
  // Provider % above base: ($15,500 − $12,000) × 10% = $350; below base pays nothing.
  assert.equal(overBase(1_550_000, 1_200_000, 1000), 35_000);
  assert.equal(overBase(1_000_000, 1_200_000, 1000), 0);
  // Caps: per person first, then the plan total scaled evenly (still exact).
  assert.deepEqual(applyCaps([71_111, 53_333, 35_556], { cap_person_cents: 60_000 }), [60_000, 53_333, 35_556]);
  const scaled = applyCaps([71_111, 53_333, 35_556], { cap_total_cents: 100_000 });
  assert.equal(scaled.reduce((t, x) => t + x, 0), 100_000);
  assert.ok(scaled[0] > scaled[1] && scaled[1] > scaled[2]);
  // Clawback recovery: oldest first, never below zero, the rest carried.
  assert.deepEqual(recover(1000, [{ approval_id: 2, period_start: '2026-08-01', cents: 700 }, { approval_id: 1, period_start: '2026-07-01', cents: 500 }]),
    { taken: 1000, clawbacks: [{ approval_id: 1, period_start: '2026-07-01', cents: 500 }, { approval_id: 2, period_start: '2026-08-01', cents: 500 }], left: 200 });
  assert.deepEqual(recover(0, [{ approval_id: 1, period_start: '2026-07-01', cents: 5 }]), { taken: 0, clawbacks: [], left: 5 });
  // Tiers and KPI direction.
  const tiers = [{ points: 3, amount_cents: 5000 }, { points: 5, amount_cents: 10000 }];
  assert.equal(tierFor(4, tiers).amount_cents, 5000);
  assert.equal(tierFor(5, tiers).amount_cents, 10000);
  assert.equal(tierFor(2, tiers), null);
  assert.equal(kpiMet('broken_rate', 8, 10), true);
  assert.equal(kpiMet('broken_rate', 12, 10), false);
  assert.equal(kpiMet('case_acceptance', null, 60), false);
  // Periods.
  assert.deepEqual(periodOf('month', '2026-02-11'), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(periodOf('week', '2026-09-17', 1), { start: '2026-09-14', end: '2026-09-20' });
  // Settings are range-checked.
  assert.throws(() => normalizeConfig('team_collections', { target_cents: -5 }), /target_cents/);
  assert.throws(() => normalizeConfig('team_collections', { target_mode: 'fixed' }), /target/);
  assert.throws(() => normalizeConfig('spiff', { rules: [{ codes: ['D1351; DROP'], amount_cents: 5 }] }), /codes/);
  assert.throws(() => normalizeConfig('scorecard', { kpis: [{ key: 'made_up', target: 1 }] }), /kpis/);
  assert.throws(() => normalizeConfig('nope', {}), /type/);
  for (const type of Object.keys(PLAN_TYPES)) assert.ok(PLAN_TYPES[type].example && PLAN_TYPES[type].summary, `${type} explains itself`);
});

// ---------------- Off by default; the owner's switch ----------------

test('the module is off until the owner turns it on; only the owner (or bonus:manage) can; audited', async () => {
  const p = await h.practice({ timezone: 'UTC' });
  const b = client(p.token);
  const cal = await member(p, 'front_desk', 'Cal Desk');
  assert.deepEqual(ok(await cal.b.get('/bonus/progress')), { enabled: false, plans: [], can_manage: false });
  const s = ok(await cal.b.get('/bonus/settings'));
  assert.equal(s.enabled, false);
  assert.equal(s.can_manage, false);
  assert.equal(s.pay_type_label, undefined, 'staff don’t see the owner’s settings');
  assert.equal((await cal.b.put('/bonus/settings', { enabled: true })).status, 403);
  assert.equal((await cal.b.get('/bonus/plan-types')).status, 403);
  assert.equal((await cal.b.get('/bonus/plans')).status, 403);
  assert.equal((await cal.b.post('/bonus/plans', { type: 'spiff', config: {} })).status, 403);
  // The assistant can't switch it on without a yes on screen.
  assert.equal((await client(p.token, { 'X-Acting-For': 'assistant' }).put('/bonus/settings', { enabled: true })).status, 428);
  const on = ok(await b.put('/bonus/settings', { enabled: true }));
  assert.equal(on.enabled, true);
  const a = await h.db.get("SELECT * FROM audit_log WHERE action = 'bonus.module_on' AND entity_id = (SELECT id FROM bonus_settings WHERE practice_id = (SELECT practice_id FROM users WHERE id = ?))", cal.id);
  assert.ok(a, 'switching it on is audited');
  assert.deepEqual(JSON.parse(a.changes).enabled, [0, 1]);
  // The catalog explains every plan with a worked example.
  const types = ok(await b.get('/bonus/plan-types'));
  assert.deepEqual(Object.keys(types.types).sort(), ['daily_goal', 'front_desk', 'provider_pct', 'scorecard', 'spiff', 'team_collections']);
  assert.ok(types.types.team_collections.example.includes('$1,600'));
  // A person given bonus:manage can set plans up (once the permission is in the catalog).
  if ('bonus:manage' in PERMISSION_CATALOG) {
    await h.db.run('UPDATE users SET permissions_add = ? WHERE id = ?', JSON.stringify(['bonus:manage']), cal.id);
    assert.equal((await cal.b.get('/bonus/plans')).status, 200);
  }
});

// ---------------- Team collections: split, eligibility, approval, clawback, payroll ----------------

test('team collections: split by hours, hours minimum, approval is idempotent, a void claws back, approved bonuses reach payroll', async () => {
  const s = await setUp();
  // July: $98,000 collected (one $5,000 payment will be voided later). August: $95,000.
  await s.pay(9_300_000, '2026-07-10');
  const later = await s.pay(500_000, '2026-07-20');
  await s.pay(9_500_000, '2026-08-10');
  const plan = ok(await s.b.post('/bonus/plans', { type: 'team_collections', name: 'Team collections', active: true, effective_from: '2026-07-01', config: teamConfig() }), 201);
  assert.equal(plan.status, 'active');
  assert.equal(plan.current.version, 1);

  const july = ok(await s.b.get(`/bonus/periods?plan_id=${plan.id}&start=2026-07-01`));
  assert.equal(july.final, true);
  assert.equal(july.team.actual, 9_800_000);
  assert.equal(july.team.pool, 160_000);
  assert.equal(lineOf(july, s.amy).earned_cents, 71_111);
  assert.equal(lineOf(july, s.bea).earned_cents, 53_333);
  assert.equal(lineOf(july, s.cal).earned_cents, 35_556);
  assert.equal(lineOf(july, s.dee).eligible, false, 'Dee worked 8 of the 10 hours needed');
  assert.match(lineOf(july, s.dee).why, /Needed 10 hours, worked 8/);
  assert.equal(july.people.find((x) => x.role === 'admin'), undefined, 'the owner isn’t in the team plan by default');
  assert.equal(july.totals.net_cents, 160_000);

  // Not yet over: can't approve September.
  assert.equal((await s.b.post('/bonus/periods/approve', { plan_id: plan.id, start: '2026-09-01' })).status, 409);
  // The assistant needs a yes on screen.
  assert.equal((await client(s.p.token, { 'X-Acting-For': 'assistant' }).post('/bonus/periods/approve', { plan_id: plan.id, start: '2026-07-01' })).status, 428);
  // Numbers changed since the owner looked → refused.
  assert.equal((await s.b.post('/bonus/periods/approve', { plan_id: plan.id, start: '2026-07-01', expected_total_cents: 1 })).status, 409);

  // A double click: exactly one approval.
  const [a1, a2] = await Promise.all([
    s.b.post('/bonus/periods/approve', { plan_id: plan.id, start: '2026-07-01', payroll_start: '2026-08-16', expected_total_cents: 160_000 }),
    s.b.post('/bonus/periods/approve', { plan_id: plan.id, start: '2026-07-01', payroll_start: '2026-08-16', expected_total_cents: 160_000 }),
  ]);
  assert.deepEqual([a1.status, a2.status].sort(), [200, 201]);
  const again = ok(await s.b.post('/bonus/periods/approve', { plan_id: plan.id, start: '2026-07-01' }));
  assert.equal(again.already_approved, true);
  assert.equal(Number((await h.db.get("SELECT COUNT(*) AS n FROM bonus_approvals WHERE plan_id = ? AND period_start = '2026-07-01'", plan.id)).n), 1);
  const julyApproval = await h.db.get("SELECT * FROM bonus_approvals WHERE plan_id = ? AND period_start = '2026-07-01'", plan.id);
  assert.equal(julyApproval.total_cents, 160_000);
  assert.equal(Number((await h.db.get('SELECT SUM(net_cents) AS n FROM bonus_payout_lines WHERE approval_id = ?', julyApproval.id)).n), 160_000);
  const au = await h.db.get("SELECT * FROM audit_log WHERE action = 'bonus.period_approve' AND entity_id = ?", julyApproval.id);
  assert.ok(au, 'approval audited');
  assert.equal(au.user_id, s.adminId);
  assert.equal(JSON.parse(au.changes).total_cents, 160_000);

  // The $5,000 July payment is voided after approval: July now pays a $600 pool (4:3:2 → 26,667 / 20,000 / 13,333).
  await h.db.run("UPDATE ledger_entries SET voided_at = '2026-09-02 10:00:00', void_reason = 'Bounced' WHERE id = ?", later);
  const julyNow = ok(await s.b.get(`/bonus/periods?plan_id=${plan.id}&start=2026-07-01`));
  assert.equal(julyNow.approval.total_cents, 160_000, 'the approved numbers stand');
  assert.deepEqual(julyNow.changed_since_approval.map((c) => [c.name, c.approved_cents, c.now_cents]).sort(), [['Amy Assistant', 71_111, 26_667], ['Bea Hygienist', 53_333, 20_000], ['Cal Desk', 35_556, 13_333]]);

  // August: $95,000 → $1,000 pool → 44,445 / 33,333 / 22,222; the July shortfalls (44,444 / 33,333 / 22,223) come off.
  const aug = ok(await s.b.get(`/bonus/periods?plan_id=${plan.id}&start=2026-08-01`));
  assert.equal(aug.team.pool, 100_000);
  const amy = lineOf(aug, s.amy);
  assert.equal(amy.earned_cents, 44_445);
  assert.equal(amy.clawback_cents, 44_444);
  assert.equal(amy.net_cents, 1);
  assert.deepEqual(amy.clawbacks, [{ approval_id: julyApproval.id, period_start: '2026-07-01', cents: 44_444 }]);
  assert.equal(lineOf(aug, s.bea).net_cents, 0);
  const cal = lineOf(aug, s.cal);
  assert.equal(cal.clawback_cents, 22_222, 'never below zero');
  assert.equal(cal.still_owed_cents, 1, 'the rest carries to the next bonus');
  const augOk = ok(await s.b.post('/bonus/periods/approve', { plan_id: plan.id, start: '2026-08-01', payroll_start: '2026-08-16' }), 201);
  assert.equal(augOk.approval.total_cents, 1);
  assert.equal(augOk.approval.clawback_cents, 99_999);

  // What people see: their own line, never anyone else's pay (this plan isn't team-visible).
  const mine = ok(await s.amy.b.get('/bonus/me?date=2026-08-20'));
  assert.equal(mine.plans.length, 1);
  assert.equal(mine.plans[0].me.net_cents, 1);
  assert.equal(mine.plans[0].people, undefined);
  assert.equal(mine.plans[0].team.labor_cents, undefined);
  assert.match(mine.plans[0].headline, /Team goal hit/);
  assert.deepEqual(mine.history.map((x) => [x.period_start, x.net_cents]), [['2026-08-01', 1], ['2026-07-01', 71_111]]);
  const deeView = ok(await s.dee.b.get('/bonus/progress?date=2026-08-20'));
  assert.match(deeView.plans[0].my_line, /Didn’t qualify/);
  // The owner sees everyone; staff can't open the owner's review.
  assert.ok(ok(await s.b.get('/bonus/progress?date=2026-08-20')).plans[0].people.length >= 3);
  assert.equal((await s.amy.b.get(`/bonus/periods?plan_id=${plan.id}`)).status, 403);
  assert.equal((await s.amy.b.post('/bonus/periods/approve', { plan_id: plan.id, start: '2026-08-01' })).status, 403);

  // Payroll: both approvals are on the pay period starting Aug 16, as their own pay type.
  const period = periodFor('2026-08-20', DEFAULT_SETTINGS);
  assert.equal(period.start, '2026-08-16');
  const due = ok(await s.b.get('/bonus/payroll?start=2026-08-16'));
  assert.equal(due.total_cents, 160_001);
  ok(await s.p.api.post('/timeclock/period/approve', { start: period.start }));
  const csv = await s.p.api.get(`/timeclock/period/export.csv?start=${period.start}&format=csv`);
  assert.equal(csv.status, 200, csv.data);
  const rows = csv.data.replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(','));
  const col = rows[0].indexOf('Bonus ($)');
  assert.ok(col > 0, 'a Bonus column');
  const bonusOf = (name) => rows.find((r) => r[0] === name)?.[col];
  assert.equal(bonusOf('Amy Assistant'), '711.12');
  assert.equal(bonusOf('Bea Hygienist'), '533.33');
  assert.equal(bonusOf('Cal Desk'), '355.56');
  assert.equal(bonusOf('Dee Parttime'), '0.00');
  const exp = await h.db.get('SELECT * FROM payroll_exports WHERE practice_id = ? ORDER BY id DESC LIMIT 1', s.pid);
  assert.equal(exp.bonus_cents, 160_001);
  assert.deepEqual(JSON.parse(exp.bonus_detail).approval_ids.length, 2);
  const gusto = await s.p.api.get(`/timeclock/period/export.csv?start=${period.start}&format=gusto`);
  assert.match(gusto.data, /,bonus\r\n/);
  const adp = await s.p.api.get(`/timeclock/period/export.csv?start=${period.start}&format=adp`);
  assert.match(adp.data, /Earnings 3 Code,Earnings 3 Amount/);
  assert.match(adp.data, /,B,711\.12/);

  // Reopening needs a reason, warns that payroll already went, and takes the bonus out of the next file.
  assert.equal((await s.b.post(`/bonus/periods/${julyApproval.id}/reopen`, {})).status, 400);
  const re = ok(await s.b.post(`/bonus/periods/${julyApproval.id}/reopen`, { reason: 'Recount after the bounced payment' }));
  assert.match(re.warning, /payroll/);
  assert.equal((await s.b.post(`/bonus/periods/${julyApproval.id}/reopen`, { reason: 'again' })).status, 409);
  assert.equal(ok(await s.b.get('/bonus/payroll?start=2026-08-16')).total_cents, 1);
  const reAudit = await h.db.get("SELECT * FROM audit_log WHERE action = 'bonus.period_reopen' AND entity_id = ?", julyApproval.id);
  assert.equal(reAudit.reason, 'Recount after the bounced payment');
  assert.deepEqual(JSON.parse(reAudit.changes).status, ['approved', 'reopened']);
  // Nothing is deleted.
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM bonus_payout_lines WHERE approval_id = ?', julyApproval.id)).n), 3);
});

test('caps: per person, then the plan total; eligibility by role, person and active status', async () => {
  const s = await setUp();
  await s.pay(9_800_000, '2026-07-10');
  const plan = ok(await s.b.post('/bonus/plans', { type: 'team_collections', active: true, effective_from: '2026-07-01', config: teamConfig({ cap_person_cents: 60_000, cap_total_cents: 120_000 }) }), 201);
  const r = ok(await s.b.get(`/bonus/periods?plan_id=${plan.id}&start=2026-07-01`));
  const amy = lineOf(r, s.amy);
  assert.equal(amy.earned_cents, 71_111);
  assert.ok(amy.cap_cut_cents >= 11_111);
  assert.equal(r.totals.net_cents, 120_000);
  assert.equal(r.totals.earned_cents - r.totals.cap_cut_cents, 120_000);
  for (const p of r.people) assert.ok(p.net_cents <= 60_000);

  // Only hygienists and front desk, and Cal left out by name; Bea since left the practice.
  const p2 = ok(await s.b.post('/bonus/plans', { type: 'team_collections', active: true, effective_from: '2026-07-01', config: teamConfig({ eligibility: { min_hours: 0, roles: ['hygienist', 'front_desk'], exclude_user_ids: [s.cal.id] } }) }), 201);
  await h.db.run('UPDATE users SET active = 0 WHERE id = ?', s.bea.id);
  const r2 = ok(await s.b.get(`/bonus/periods?plan_id=${p2.id}&start=2026-07-01`));
  assert.equal(lineOf(r2, s.amy), undefined, 'assistants aren’t in this plan');
  assert.equal(lineOf(r2, s.cal), undefined);
  assert.equal(lineOf(r2, s.bea), undefined, 'no longer active');
  assert.equal(r2.totals.net_cents, 0);
  await h.db.run('UPDATE users SET active = 1 WHERE id = ?', s.bea.id);
});

test('plans are versioned: a change needs a reason, starts next period by default, and can’t rewrite an approved period', async () => {
  const s = await setUp();
  await s.pay(9_800_000, '2026-07-10');
  const plan = ok(await s.b.post('/bonus/plans', { type: 'team_collections', active: true, effective_from: '2026-07-01', config: teamConfig() }), 201);
  assert.equal((await s.b.put(`/bonus/plans/${plan.id}`, { config: teamConfig({ share_bp: 3000 }) })).status, 400, 'a reason is required');
  const v2 = ok(await s.b.put(`/bonus/plans/${plan.id}`, { config: teamConfig({ share_bp: 3000 }), reason: 'Bigger share from next month' }));
  assert.equal(v2.versions.length, 2);
  assert.equal(v2.upcoming.effective_from, '2026-10-01');
  assert.equal(v2.current.version, 1, 'September keeps the rules the team was promised');
  const ch = await h.db.get("SELECT * FROM audit_log WHERE action = 'bonus.plan_change' AND entity_id = ?", plan.id);
  assert.equal(ch.reason, 'Bigger share from next month');
  assert.ok(JSON.parse(ch.changes).config[1].includes('3000'));
  // July approved under version 1; a version back-dated into July is refused.
  ok(await s.b.post('/bonus/periods/approve', { plan_id: plan.id, start: '2026-07-01' }), 201);
  assert.equal((await s.b.put(`/bonus/plans/${plan.id}`, { config: teamConfig({ share_bp: 5000 }), effective_from: '2026-07-15', reason: 'Oops' })).status, 409);
  // Switching off and archiving: status, never deleted; archiving needs a reason.
  ok(await s.b.post(`/bonus/plans/${plan.id}/status`, { status: 'off' }));
  assert.equal((await s.b.post(`/bonus/plans/${plan.id}/status`, { status: 'archived' })).status, 400);
  ok(await s.b.post(`/bonus/plans/${plan.id}/status`, { status: 'archived', reason: 'Replaced by the scorecard' }));
  assert.equal((await h.db.get('SELECT status FROM bonus_plans WHERE id = ?', plan.id)).status, 'archived');
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM bonus_plan_versions WHERE plan_id = ?', plan.id)).n), 2);
  // Bad settings are refused on the server.
  assert.equal((await s.b.post('/bonus/plans', { type: 'team_collections', config: { target_mode: 'fixed', target_cents: 5, share_bp: 20000 } })).status, 400);
  assert.equal((await s.b.post('/bonus/plans', { type: 'daily_goal', config: { goal_mode: 'fixed' } })).status, 400);
});

// ---------------- The other plan types ----------------

test('daily goal: each day at goal pays everyone who worked it', async () => {
  const s = await setUp();
  await s.charge(150_000, '2026-08-17');
  await s.charge(120_000, '2026-08-18');
  await s.charge(50_000, '2026-08-19');
  const plan = ok(await s.b.post('/bonus/plans', { type: 'daily_goal', active: true, effective_from: '2026-08-01', config: { goal_mode: 'fixed', goal_cents: 100_000, amount_cents: 2000, basis: 'production_gross' } }), 201);
  const r = ok(await s.b.get(`/bonus/periods?plan_id=${plan.id}&start=2026-08-01`));
  assert.equal(r.team.hits, 2);
  assert.equal(r.team.counted, 21, 'every open weekday in August');
  assert.equal(lineOf(r, s.amy).earned_cents, 4000, 'worked the 17th and 18th');
  assert.equal(lineOf(r, s.bea).earned_cents, 4000);
  assert.equal(lineOf(r, s.cal).earned_cents, 4000);
  assert.equal(lineOf(r, s.dee).earned_cents, 2000, 'worked only the 17th');
  // Mid-month progress: "Today: 60% of goal" when today's production is $600 of $1,000.
  await s.charge(60_000, TODAY);
  const prog = ok(await s.amy.b.get('/bonus/progress'));
  assert.match(prog.plans[0].headline, /^Today: 60% of goal/);
});

test('spiffs: by code to the provider, the assistant on shift and whoever booked; a voided charge doesn’t count', async () => {
  const s = await setUp();
  const hyg = ok(await s.p.api.post('/providers', { name: 'Bea Hygienist, RDH', type: 'hygienist' }), 201);
  await h.db.run('UPDATE providers SET user_id = ? WHERE id = ?', s.bea.id, hyg.id);
  await ensureBusinessSchema(h.db);
  await h.db.run("INSERT INTO business_staff_roles (practice_id, user_id, kind, provider_ids) VALUES (?, ?, 'assistant', ?)", s.pid, s.amy.id, JSON.stringify([hyg.id]));
  const anyCode = await h.db.get('SELECT * FROM procedure_codes WHERE practice_id = ? ORDER BY id LIMIT 1', s.pid);
  const appt = await insert(h.db, 'appointments', { practice_id: s.pid, patient_id: s.p.patient.id, provider_id: hyg.id, start_time: '2026-08-18 09:00', end_time: '2026-08-18 10:00', status: 'completed' });
  await h.db.run("INSERT INTO audit_log (practice_id, user_id, action, entity, entity_id, source) VALUES (?, ?, 'appointment.create', 'appointments', ?, 'human')", s.pid, s.cal.id, appt);
  const done = async (code, fee) => {
    const id = await insert(h.db, 'procedures', { practice_id: s.pid, patient_id: s.p.patient.id, appointment_id: appt, provider_id: hyg.id, code_id: anyCode.id, code, description: code, category: 'preventive', fee, status: 'completed', completed_at: '2026-08-18 10:00:00' });
    return s.charge(fee, '2026-08-18', { procedure_id: id, provider_id: hyg.id });
  };
  await done('D1351', 5000);
  await done('D1351', 5000);
  const voided = await done('D1351', 5000);
  await h.db.run("UPDATE ledger_entries SET voided_at = '2026-08-19 10:00:00' WHERE id = ?", voided);
  await done('D9975', 40000);
  const plan = ok(await s.b.post('/bonus/plans', { type: 'spiff', active: true, effective_from: '2026-08-01', config: { rules: [
    { codes: ['D1351'], label: 'Sealants', amount_cents: 500, to: 'provider' },
    { codes: ['d1351'], label: 'Sealant assist', amount_cents: 100, to: 'assistant' },
    { codes: ['D9975'], label: 'Whitening', pct_bp: 1000, to: 'scheduler' },
  ] } }), 201);
  const r = ok(await s.b.get(`/bonus/periods?plan_id=${plan.id}&start=2026-08-01`));
  assert.equal(lineOf(r, s.bea).earned_cents, 1000, 'two live sealants × $5');
  assert.equal(lineOf(r, s.amy).earned_cents, 200, 'assisting that hygienist, on the clock that day');
  assert.equal(lineOf(r, s.cal).earned_cents, 4000, '10% of the $400 whitening she booked');
  assert.equal(r.team.procedures, 3);
});

test('provider % above base: each provider sees only their own numbers unless the plan is team-visible', async () => {
  const s = await setUp();
  const hyg = ok(await s.p.api.post('/providers', { name: 'Bea Hygienist, RDH', type: 'hygienist' }), 201);
  await h.db.run('UPDATE providers SET user_id = ? WHERE id = ?', s.bea.id, hyg.id);
  const doc = await member(s.p, 'dentist', 'Dan Dentist');
  await h.db.run('UPDATE providers SET user_id = ? WHERE id = ?', doc.id, s.p.provider.id);
  await s.charge(1_550_000, '2026-09-03', { provider_id: hyg.id });
  await s.charge(2_000_000, '2026-09-03', { provider_id: s.p.provider.id });
  const cfg = (team_visible) => ({ basis: 'production_gross', team_visible, providers: [{ provider_id: hyg.id, base_cents: 1_200_000, pct_bp: 1000 }, { provider_id: s.p.provider.id, base_cents: 1_500_000, pct_bp: 1000 }] });
  const plan = ok(await s.b.post('/bonus/plans', { type: 'provider_pct', active: true, effective_from: '2026-09-01', config: cfg(false) }), 201);
  const bea = ok(await s.bea.b.get('/bonus/progress'));
  assert.equal(bea.plans.length, 1);
  assert.equal(bea.plans[0].me.net_cents, 35_000);
  assert.deepEqual(bea.plans[0].team.providers.map((x) => x.provider_id), [hyg.id], 'only her own production');
  assert.equal(bea.plans[0].people, undefined);
  assert.equal(ok(await s.amy.b.get('/bonus/progress')).plans.length, 0, 'not a provider: the plan isn’t shown');
  // The owner sees both.
  assert.equal(ok(await s.b.get('/bonus/progress')).plans.find((x) => x.plan.id === plan.id).team.providers.length, 2);
  // A team-visible plan shows everyone's earnings to everyone in it.
  await ok(await s.b.post('/bonus/plans', { type: 'provider_pct', active: true, effective_from: '2026-09-01', config: cfg(true) }), 201);
  const open = ok(await s.bea.b.get('/bonus/progress')).plans.find((x) => x.team_visible);
  assert.equal(open.team.providers.length, 2);
  assert.deepEqual(open.people.map((x) => x.net_cents).sort((a, b) => a - b), [35_000, 50_000]);
});

test('scorecard: points for targets hit decide the tier', async () => {
  const s = await setUp();
  await s.charge(250_000, '2026-08-10');
  const plan = ok(await s.b.post('/bonus/plans', { type: 'scorecard', active: true, effective_from: '2026-08-01', config: {
    team_visible: true,
    kpis: [{ key: 'production_gross', target: 200_000, points: 1 }, { key: 'collections', target: 1, points: 1 }, { key: 'broken_rate', target: 10, points: 1 }],
    tiers: [{ points: 1, amount_cents: 5000 }, { points: 3, amount_cents: 10000 }],
  } }), 201);
  const r = ok(await s.b.get(`/bonus/periods?plan_id=${plan.id}&start=2026-08-01`));
  assert.deepEqual(r.team.kpis.map((k) => k.met), [true, false, false]);
  assert.equal(r.team.points, 1);
  assert.equal(lineOf(r, s.amy).earned_cents, 5000);
  assert.equal(r.totals.net_cents, 5000 * r.people.filter((x) => x.eligible).length);
  // Front desk version: its own measures and roles.
  const fd = ok(await s.b.post('/bonus/plans', { type: 'front_desk', active: true, effective_from: '2026-08-01', config: {} }), 201);
  const r2 = ok(await s.b.get(`/bonus/periods?plan_id=${fd.id}&start=2026-08-01`));
  assert.deepEqual(r2.team.kpis.map((k) => k.key), ['schedule_fill', 'broken_rate', 'otc_collections', 'tx_scheduled']);
  assert.deepEqual(r2.people.filter((x) => x.in_plan).map((x) => x.name), ['Cal Desk']);
});

// ---------------- Practice isolation ----------------

test('practice isolation: another practice can’t see, approve, or name this one’s plans and people', async () => {
  const s = await setUp();
  await s.pay(9_800_000, '2026-07-10');
  const plan = ok(await s.b.post('/bonus/plans', { type: 'team_collections', active: true, effective_from: '2026-07-01', config: teamConfig() }), 201);
  ok(await s.b.post('/bonus/periods/approve', { plan_id: plan.id, start: '2026-07-01' }), 201);
  const other = await h.practice({ timezone: 'UTC' });
  const ob = client(other.token);
  ok(await ob.put('/bonus/settings', { enabled: true }));
  assert.equal((await ob.get(`/bonus/periods?plan_id=${plan.id}&start=2026-07-01`)).status, 404);
  assert.equal((await ob.post('/bonus/periods/approve', { plan_id: plan.id, start: '2026-08-01' })).status, 404);
  assert.equal((await ob.put(`/bonus/plans/${plan.id}`, { name: 'Mine', reason: 'x' })).status, 404);
  const approval = await h.db.get('SELECT id FROM bonus_approvals WHERE plan_id = ?', plan.id);
  assert.equal((await ob.post(`/bonus/periods/${approval.id}/reopen`, { reason: 'x' })).status, 404);
  assert.equal((await ob.post('/bonus/plans', { type: 'team_collections', config: teamConfig({ eligibility: { user_ids: [s.amy.id] } }) })).status, 404);
  assert.deepEqual(ok(await ob.get('/bonus/plans')).plans, []);
  assert.deepEqual(ok(await ob.get('/bonus/approvals')), []);
  assert.equal(ok(await ob.get('/bonus/payroll?start=2026-08-16')).total_cents, 0);
  assert.equal(ok(await ob.get('/bonus/me')).history.length, 0);
  // And their team numbers don't include this practice's money.
  await ob.post('/bonus/plans', { type: 'team_collections', active: true, effective_from: '2026-07-01', config: teamConfig({ eligibility: { min_hours: 0 } }) });
  const theirs = ok(await ob.get('/bonus/plans')).plans[0];
  assert.equal(ok(await ob.get(`/bonus/periods?plan_id=${theirs.id}&start=2026-07-01`)).team.actual, 0);
});
