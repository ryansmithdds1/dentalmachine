import { Router } from 'express';
import { HttpError, can } from '../auth.js';
import { insert, update, recorded, findOr404, audit } from '../util.js';
import { currentActor, setActor } from '../actor.js';
import { requireHuman } from '../aiguard.js';
import { periodFor } from '../timeclock.js';
import {
  PLAN_TYPES, COMMON_RULES, KPIS, MONEY_BASES, PERIODS, ROLES, ROLE_LABELS, DEFAULT_ROLES, normalizeConfig, parseConfig, loadContext, reviewPeriod, forViewer, paceOf,
  periodOf, previousPeriodOf, nextPeriodOf, versionFor, versionById, isDate,
} from '../bonus.js';
import { bonusesForPayroll } from '../bonuspay.js';

// Team bonus module routes (BN1–BN3; docs/workflows/specs/BN-bonus.md). Mounted with the signed-in API:
// api.use(bonusRoutes({ db })).
//
// Who can do what:
// - Everyone signed in (staff, not API keys) sees whether the module is on, the team's progress on the plans they're
//   in, and their own status and history — never anyone else's pay unless the owner made that plan visible to the team.
// - Administrators and people given 'bonus:manage' switch the module on, set up plans (versioned, with effective
//   dates), review periods (everyone's numbers), approve them and reopen them. All of it is audited.
// - The assistant (AI) can read, but can't change plans or approve money without the person's yes (428).

export const MANAGE = 'bonus:manage';
export const canManage = (user) => user?.role === 'admin' || can(user, MANAGE);
const AI_HIGH_RISK = [['POST', /^\/bonus\/(plans(\/\d+\/status)?|periods\/(approve|\d+\/reopen))$/], ['PUT', /^\/bonus\/(settings|plans\/\d+)$/]];
const REASON_MAX = 300;
const clean = (v, max = 200) => (v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) || null);
const asId = (v, name = 'id') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a number`);
  return n;
};
const reqDate = (v, name) => {
  if (!isDate(v)) throw new HttpError(400, `${name} must be a real date (YYYY-MM-DD)`);
  return v;
};
const isUnique = (err) => /unique|duplicate key/i.test(String(err?.message));
const money = (c) => `$${(Math.round(c) / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const PERIOD_WORD = { month: 'this month', week: 'this week' };

export async function bonusSettings(db, practiceId) {
  const row = await db.get('SELECT * FROM bonus_settings WHERE practice_id = ?', practiceId);
  return row || { id: null, practice_id: practiceId, enabled: 0, show_dashboard: 1, show_schedule: 1, pay_type_label: 'Bonus' };
}

// The version and period a plan is in on a date: the version in effect on the period's first day.
async function currentFor(db, plan, date, wsd) {
  const probe = await versionFor(db, plan.id, date);
  if (!probe) return null;
  const period = periodOf(parseConfig(probe.config).period, date, wsd);
  const version = (await versionFor(db, plan.id, period.start)) || probe;
  return { version, period: periodOf(parseConfig(version.config).period, date, wsd) };
}

// Checks that every office, person and provider a plan names belongs to this practice.
async function checkIds(db, pid, cfg) {
  if (cfg.location_id) await findOr404(db, 'locations', cfg.location_id, pid, 'Office');
  for (const id of [...cfg.eligibility.user_ids, ...cfg.eligibility.exclude_user_ids]) await findOr404(db, 'users', id, pid, 'Person');
  for (const x of cfg.providers || []) await findOr404(db, 'providers', x.provider_id, pid, 'Provider');
}

// One plain sentence for the dashboard card and the schedule bar.
function headline(view, kind) {
  const t = view.team;
  const when = PERIOD_WORD[kind] || 'this period';
  if (t.kind === 'target') {
    const pace = view.pace?.status === 'on_pace' ? ' · on pace' : view.pace?.status === 'behind' ? ' · behind pace' : view.pace?.status === 'hit' ? ' · goal hit' : '';
    return t.actual >= t.target ? `Team goal hit: ${money(t.actual)} of ${money(t.target)} ${when} — ${money(t.actual - t.target)} over${pace}` : `Team goal: ${money(t.actual)} of ${money(t.target)} ${when} — ${money(t.to_go)} to go${pace}`;
  }
  if (t.kind === 'goals') {
    const today = t.today && t.today.goal ? `Today: ${Math.round((t.today.actual / t.today.goal) * 100)}% of goal · ` : '';
    return `${today}${t.hits} of ${t.counted} ${t.unit === 'day' ? 'days' : 'weeks'} at goal ${when}`;
  }
  if (t.kind === 'scorecard') {
    const next = t.next_tier ? ` — ${t.next_tier.points - t.points} more for the ${money(t.next_tier.amount_cents)} tier` : '';
    return `Scorecard: ${t.points} of ${t.max_points} points ${when}${next}`;
  }
  if (t.kind === 'count') return `${t.procedures} bonus procedure${t.procedures === 1 ? '' : 's'} ${when}`;
  if (t.kind === 'providers') {
    const mine = view.me?.provider;
    if (mine) return mine.value >= mine.base ? `Your ${t.label.toLowerCase()}: ${money(mine.value)} — ${money(mine.value - mine.base)} over your base ${when}` : `Your ${t.label.toLowerCase()}: ${money(mine.value)} of ${money(mine.base)} base — ${money(mine.to_go)} to go`;
    return `${t.providers.length} provider${t.providers.length === 1 ? '' : 's'} on this plan`;
  }
  return '';
}
function myLine(me, final) {
  if (!me) return null;
  if (!me.in_plan) return 'You’re not in this plan';
  if (!me.eligible) return final ? `Didn’t qualify: ${me.why}` : `Not yet: ${me.why}`;
  return `${final ? 'Qualified' : 'Qualified so far'} · ${money(me.net_cents)} ${final ? 'earned' : 'so far'}`;
}

export default function bonusRoutes({ db }) {
  const r = Router();
  const today = (req) => req.app?.locals?.bonusToday?.() ?? null;
  const ctxFor = (req) => loadContext(db, req.user.practice_id, { today: today(req) });
  const needManage = (req) => {
    if (!canManage(req.user)) throw new HttpError(403, `Missing permission: ${MANAGE}`);
  };

  r.use((req, res, next) => {
    if (!req.path.startsWith('/bonus')) return next();
    // Pay is people's own business: no API keys here.
    if (!req.user?.id || req.user.role === 'api') return next(new HttpError(403, 'Bonuses are only available to signed-in staff'));
    const ctx = currentActor();
    if (ctx?.source === 'ai' && AI_HIGH_RISK.some(([m, re]) => m === req.method && re.test(req.path))) {
      if (req.get('X-Human-Approved') !== '1') return res.status(428).json({ error: 'The assistant can’t change bonus plans or approve bonuses without your OK. Confirm it, or do it yourself.', needs_approval: true });
      setActor({ approvedBy: req.user.id });
    }
    next();
  });

  // ---------------- Settings ----------------
  r.get('/bonus/settings', async (req, res) => {
    const s = await bonusSettings(db, req.user.practice_id);
    const manage = canManage(req.user);
    res.json({ enabled: !!s.enabled, show_dashboard: !!s.show_dashboard, show_schedule: !!s.show_schedule, can_manage: manage, ...(manage ? { pay_type_label: s.pay_type_label } : {}) });
  });
  r.put('/bonus/settings', async (req, res) => {
    needManage(req);
    requireHuman('changing the bonus module');
    const b = req.body || {};
    const row = {};
    for (const k of ['enabled', 'show_dashboard', 'show_schedule']) if (b[k] !== undefined) row[k] = b[k] ? 1 : 0;
    if (b.pay_type_label !== undefined) row.pay_type_label = clean(b.pay_type_label, 40) || 'Bonus';
    const s = await bonusSettings(db, req.user.practice_id);
    const stamp = { updated_by: req.user.id, updated_at: new Date().toISOString() };
    let id = s.id;
    const before = { enabled: s.enabled, show_dashboard: s.show_dashboard, show_schedule: s.show_schedule, pay_type_label: s.pay_type_label };
    if (!id) {
      try {
        id = await insert(db, 'bonus_settings', { practice_id: req.user.practice_id, ...row, ...stamp });
      } catch (err) {
        if (!isUnique(err)) throw err;
        id = (await bonusSettings(db, req.user.practice_id)).id;
        await update(db, 'bonus_settings', id, req.user.practice_id, { ...row, ...stamp });
      }
    } else await update(db, 'bonus_settings', id, req.user.practice_id, { ...row, ...stamp });
    const after = await bonusSettings(db, req.user.practice_id);
    await audit(db, req, row.enabled === 1 && !s.enabled ? 'bonus.module_on' : row.enabled === 0 && s.enabled ? 'bonus.module_off' : 'bonus.settings', 'bonus_settings', id, null,
      { before, after: { enabled: after.enabled, show_dashboard: after.show_dashboard, show_schedule: after.show_schedule, pay_type_label: after.pay_type_label } });
    res.json({ enabled: !!after.enabled, show_dashboard: !!after.show_dashboard, show_schedule: !!after.show_schedule, pay_type_label: after.pay_type_label, can_manage: true });
  });

  // ---------------- The catalog ----------------
  r.get('/bonus/plan-types', async (req, res) => {
    needManage(req);
    const types = Object.fromEntries(Object.entries(PLAN_TYPES).map(([k, t]) => [k, { key: k, label: t.label, summary: t.summary, how: t.how, example: t.example, defaults: normalizeConfigSafe(k) }]));
    const staff = await db.all('SELECT id, name, role FROM users WHERE practice_id = ? AND active = 1 ORDER BY name', req.user.practice_id);
    res.json({ types, common_rules: COMMON_RULES, kpis: KPIS, bases: MONEY_BASES, periods: PERIODS, roles: ROLES, role_labels: ROLE_LABELS, default_roles: DEFAULT_ROLES, staff });
  });

  // ---------------- Plans (versioned) ----------------
  const planOut = async (plan, date) => {
    const versions = await db.all('SELECT v.*, u.name AS created_by_name FROM bonus_plan_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.plan_id = ? ORDER BY v.version DESC', plan.id);
    const current = (await versionFor(db, plan.id, date)) || null;
    const upcoming = versions.filter((v) => v.effective_from > date).sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))[0] || null;
    const shape = (v) => (v ? { id: v.id, version: v.version, effective_from: v.effective_from, config: parseConfig(v.config), reason: v.reason, created_by_name: v.created_by_name, created_at: v.created_at } : null);
    const last = await db.get("SELECT period_end FROM bonus_approvals WHERE plan_id = ? AND status = 'approved' ORDER BY period_end DESC LIMIT 1", plan.id);
    return { ...plan, current: shape(current && versions.find((v) => v.id === current.id)), upcoming: shape(upcoming), versions: versions.map(shape), last_approved_end: last?.period_end || null };
  };
  r.get('/bonus/plans', async (req, res) => {
    needManage(req);
    const ctx = await ctxFor(req);
    const plans = await db.all("SELECT * FROM bonus_plans WHERE practice_id = ? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'off' THEN 1 ELSE 2 END, id", req.user.practice_id);
    const out = [];
    for (const p of plans) out.push(await planOut(p, ctx.today));
    res.json({ today: ctx.today, plans: out });
  });

  r.post('/bonus/plans', async (req, res) => {
    needManage(req);
    requireHuman('setting up a bonus plan');
    const b = req.body || {};
    const type = String(b.type || '');
    const cfg = normalizeConfig(type, b.config || {});
    await checkIds(db, req.user.practice_id, cfg);
    const ctx = await ctxFor(req);
    const name = clean(b.name, 80) || PLAN_TYPES[type].label;
    const effective = b.effective_from ? reqDate(b.effective_from, 'effective_from') : periodOf(cfg.period, ctx.today, ctx.tc.week_start_day).start;
    const status = b.active ? 'active' : 'off';
    let id;
    let vid;
    await db.tx(async () => {
      id = await insert(db, 'bonus_plans', { practice_id: req.user.practice_id, type, name, status, created_by: req.user.id, updated_by: req.user.id });
      vid = await insert(db, 'bonus_plan_versions', { practice_id: req.user.practice_id, plan_id: id, version: 1, effective_from: effective, config: JSON.stringify(cfg), reason: clean(b.reason, REASON_MAX) || 'New plan', created_by: req.user.id });
    });
    await audit(db, req, 'bonus.plan_create', 'bonus_plans', id, { type, name, version_id: vid }, { after: { type, name, status, effective_from: effective, config: JSON.stringify(cfg) } });
    res.status(201).json(await planOut(await db.get('SELECT * FROM bonus_plans WHERE id = ?', id), ctx.today));
  });

  // A change to a plan's rules is a new version from a date (default: the start of the next period). Periods that
  // are already approved can't be changed underneath — reopen them first.
  r.put('/bonus/plans/:id', async (req, res) => {
    needManage(req);
    requireHuman('changing a bonus plan');
    const plan = await findOr404(db, 'bonus_plans', asId(req.params.id), req.user.practice_id, 'Plan');
    if (plan.status === 'archived') throw new HttpError(409, 'This plan is archived — make a new one instead');
    const b = req.body || {};
    const reason = clean(b.reason, REASON_MAX);
    if (!reason) throw new HttpError(400, 'Say why the plan is changing — the team’s pay depends on it, so the reason is kept with the change');
    const ctx = await ctxFor(req);
    const out = {};
    if (b.name !== undefined) {
      const name = clean(b.name, 80);
      if (!name) throw new HttpError(400, 'The plan needs a name');
      if (name !== plan.name) {
        await update(db, 'bonus_plans', plan.id, req.user.practice_id, { name, updated_by: req.user.id, updated_at: new Date().toISOString() });
        out.name = name;
      }
    }
    if (b.config !== undefined) {
      const cfg = normalizeConfig(plan.type, b.config);
      await checkIds(db, req.user.practice_id, cfg);
      const cur = await currentFor(db, plan, ctx.today, ctx.tc.week_start_day);
      const effective = b.effective_from ? reqDate(b.effective_from, 'effective_from') : cur ? nextPeriodOf(cfg.period, periodOf(cfg.period, ctx.today, ctx.tc.week_start_day), ctx.tc.week_start_day).start : ctx.today;
      const last = await db.get("SELECT period_end FROM bonus_approvals WHERE plan_id = ? AND status = 'approved' ORDER BY period_end DESC LIMIT 1", plan.id);
      if (last && effective <= last.period_end) throw new HttpError(409, `The period up to ${last.period_end} is already approved — pick a date after it, or reopen that period first`);
      const before = await versionFor(db, plan.id, effective);
      const n = (await db.get('SELECT COALESCE(MAX(version), 0) AS n FROM bonus_plan_versions WHERE plan_id = ?', plan.id)).n;
      const vid = await insert(db, 'bonus_plan_versions', { practice_id: req.user.practice_id, plan_id: plan.id, version: Number(n) + 1, effective_from: effective, config: JSON.stringify(cfg), reason, created_by: req.user.id });
      out.version = { id: vid, version: Number(n) + 1, effective_from: effective };
      await audit(db, req, 'bonus.plan_change', 'bonus_plans', plan.id, { version_id: vid, version: Number(n) + 1, effective_from: effective }, { reason, before: { config: before?.config ?? null }, after: { config: JSON.stringify(cfg) } });
    } else if (out.name) {
      await audit(db, req, 'bonus.plan_rename', 'bonus_plans', plan.id, null, { reason, before: { name: plan.name }, after: { name: out.name } });
    }
    res.json(await planOut(await db.get('SELECT * FROM bonus_plans WHERE id = ?', plan.id), ctx.today));
  });

  r.post('/bonus/plans/:id/status', async (req, res) => {
    needManage(req);
    requireHuman('switching a bonus plan on or off');
    const plan = await findOr404(db, 'bonus_plans', asId(req.params.id), req.user.practice_id, 'Plan');
    const status = String(req.body?.status || '');
    if (!['active', 'off', 'archived'].includes(status)) throw new HttpError(400, 'status must be one of: active, off, archived');
    if (plan.status === 'archived') throw new HttpError(409, 'This plan is archived');
    const reason = clean(req.body?.reason, REASON_MAX);
    if (status === 'archived' && !reason) throw new HttpError(400, 'Say why the plan is being retired');
    if (status === plan.status) return res.json({ ...plan, unchanged: true });
    await update(db, 'bonus_plans', plan.id, req.user.practice_id, { status, updated_by: req.user.id, updated_at: new Date().toISOString() });
    await audit(db, req, `bonus.plan_${status === 'active' ? 'on' : status === 'off' ? 'off' : 'archive'}`, 'bonus_plans', plan.id, null, { reason });
    res.json(await db.get('SELECT * FROM bonus_plans WHERE id = ?', plan.id));
  });

  // "What would this plan have paid?" — any settings, on real numbers, saving nothing.
  r.post('/bonus/preview', async (req, res) => {
    needManage(req);
    const b = req.body || {};
    const type = String(b.type || '');
    const cfg = normalizeConfig(type, b.config || {});
    await checkIds(db, req.user.practice_id, cfg);
    const ctx = await ctxFor(req);
    const period = b.start ? periodOf(cfg.period, reqDate(b.start, 'start'), ctx.tc.week_start_day) : previousPeriodOf(cfg.period, periodOf(cfg.period, ctx.today, ctx.tc.week_start_day), ctx.tc.week_start_day);
    const review = await reviewPeriod(ctx, { id: 0, type, name: clean(b.name, 80) || PLAN_TYPES[type].label, status: 'off' }, { id: 0, version: 0, effective_from: period.start, config: cfg }, period, { clawbacks: false });
    res.json(review);
  });

  // ---------------- What the team sees ----------------
  const progress = async (req, date) => {
    const s = await bonusSettings(db, req.user.practice_id);
    if (!s.enabled) return { enabled: false, plans: [], can_manage: canManage(req.user) };
    const ctx = await ctxFor(req);
    const on = date || ctx.today;
    const manager = canManage(req.user);
    const plans = await db.all("SELECT * FROM bonus_plans WHERE practice_id = ? AND status = 'active' ORDER BY id", req.user.practice_id);
    const out = [];
    for (const plan of plans) {
      const cur = await currentFor(db, plan, on, ctx.tc.week_start_day);
      if (!cur) continue;
      // An approved period shows what was approved (after caps and clawbacks); otherwise the numbers so far.
      const approval = await db.get("SELECT id, detail, approved_at FROM bonus_approvals WHERE plan_id = ? AND period_start = ? AND status = 'approved'", plan.id, cur.period.start);
      const review = approval ? JSON.parse(approval.detail) : await reviewPeriod(ctx, plan, cur.version, cur.period, { clawbacks: false });
      const view = forViewer(review, req.user.id, { manager });
      view.approved = approval ? { id: approval.id, approved_at: approval.approved_at } : null;
      if (!manager && !view.me?.in_plan && !view.team_visible) continue;
      const cfg = review.config;
      if (review.team.kind === 'target') view.pace = await paceOf(ctx, cur.period, cfg.location_id, review.team.actual, review.team.target);
      if (view.me?.provider) view.me.provider.pace = await paceOf(ctx, cur.period, cfg.location_id, view.me.provider.value, view.me.provider.base);
      view.period_kind = cfg.period;
      view.headline = headline(view, cfg.period);
      view.my_line = myLine(view.me, review.final);
      out.push(view);
    }
    return { enabled: true, show_dashboard: !!s.show_dashboard, show_schedule: !!s.show_schedule, today: ctx.today, can_manage: manager, plans: out };
  };
  r.get('/bonus/progress', async (req, res) => {
    const date = req.query.date ? reqDate(req.query.date, 'date') : null;
    res.json(await progress(req, date));
  });

  // My bonus: this period's progress on my plans, and my own approved (and reopened) history.
  r.get('/bonus/me', async (req, res) => {
    const date = req.query.date ? reqDate(req.query.date, 'date') : null;
    const p = await progress(req, date);
    const history = await db.all(
      `SELECT l.id, l.plan_id, pl.name AS plan_name, l.period_start, a.period_end, a.status, a.payroll_period_start, a.approved_at, l.earned_cents, l.cap_cut_cents, l.clawback_cents, l.net_cents, l.detail
       FROM bonus_payout_lines l JOIN bonus_approvals a ON a.id = l.approval_id JOIN bonus_plans pl ON pl.id = l.plan_id
       WHERE l.practice_id = ? AND l.user_id = ? ORDER BY a.period_end DESC, l.id DESC LIMIT 100`, req.user.practice_id, req.user.id,
    );
    res.json({ ...p, history: history.map((h) => ({ ...h, detail: JSON.parse(h.detail || '[]') })), paid_total_cents: history.filter((h) => h.status === 'approved').reduce((t, h) => t + h.net_cents, 0) });
  });

  // ---------------- Periods: review, approve, reopen (the owner) ----------------
  const loadPeriod = async (req, planId, start) => {
    const plan = await findOr404(db, 'bonus_plans', asId(planId, 'plan_id'), req.user.practice_id, 'Plan');
    const ctx = await ctxFor(req);
    const wsd = ctx.tc.week_start_day;
    let cur;
    if (start) {
      reqDate(start, 'start');
      cur = await currentFor(db, plan, start, wsd);
      if (!cur) throw new HttpError(404, 'This plan hadn’t started by then');
    } else {
      const now = await currentFor(db, plan, ctx.today, wsd);
      if (!now) throw new HttpError(404, 'This plan hasn’t started yet');
      const kind = parseConfig(now.version.config).period;
      cur = (await currentFor(db, plan, previousPeriodOf(kind, now.period, wsd).start, wsd)) || now;
    }
    return { plan, ctx, ...cur, kind: parseConfig(cur.version.config).period, wsd };
  };

  r.get('/bonus/periods', async (req, res) => {
    needManage(req);
    const { plan, ctx, version, period, kind, wsd } = await loadPeriod(req, req.query.plan_id, req.query.start);
    const approval = await db.get("SELECT a.*, u.name AS approved_by_name FROM bonus_approvals a LEFT JOIN users u ON u.id = a.approved_by WHERE a.plan_id = ? AND a.period_start = ? AND a.status = 'approved'", plan.id, period.start);
    let review;
    let changed = [];
    if (approval) {
      review = JSON.parse(approval.detail);
      // Has anything moved since? Those differences are what a later approval takes back.
      const now = await reviewPeriod(ctx, plan, await versionById(db, approval.plan_version_id), period, { final: true, clawbacks: false });
      const nowBy = new Map(now.people.map((p) => [p.user_id, p.earned_cents - p.cap_cut_cents]));
      changed = review.people.filter((p) => (p.earned_cents - p.cap_cut_cents) !== (nowBy.get(p.user_id) || 0))
        .map((p) => ({ user_id: p.user_id, name: p.name, approved_cents: p.earned_cents - p.cap_cut_cents, now_cents: nowBy.get(p.user_id) || 0 }));
    } else review = await reviewPeriod(ctx, plan, version, period);
    const history = await db.all('SELECT a.id, a.period_start, a.period_end, a.status, a.total_cents, a.people, a.payroll_period_start, a.approved_at, a.reopened_at, a.reopen_reason, u.name AS approved_by_name FROM bonus_approvals a LEFT JOIN users u ON u.id = a.approved_by WHERE a.plan_id = ? ORDER BY a.period_start DESC, a.id DESC LIMIT 50', plan.id);
    res.json({
      ...review, period, prev: previousPeriodOf(kind, period, wsd), next: nextPeriodOf(kind, period, wsd), ended: period.end < ctx.today, today: ctx.today,
      approval: approval ? { id: approval.id, approved_at: approval.approved_at, approved_by_name: approval.approved_by_name, total_cents: approval.total_cents, payroll_period_start: approval.payroll_period_start } : null,
      changed_since_approval: changed, history, payroll_default: periodFor(ctx.today, ctx.tc).start,
    });
  });

  r.post('/bonus/periods/approve', async (req, res) => {
    needManage(req);
    requireHuman('approving bonuses');
    const b = req.body || {};
    if (!b.start) throw new HttpError(400, 'start is required (the first day of the period)');
    const s = await bonusSettings(db, req.user.practice_id);
    if (!s.enabled) throw new HttpError(409, 'Turn the bonus module on first');
    const { plan, ctx, version, period } = await loadPeriod(req, b.plan_id, b.start);
    if (period.start !== b.start) throw new HttpError(400, `${b.start} isn’t the first day of a period (it’s in ${period.start} to ${period.end})`);
    if (plan.status === 'archived') throw new HttpError(409, 'This plan is archived');
    if (period.end >= ctx.today) throw new HttpError(409, `This period ends ${period.end} — approve it once it’s over`);
    const existing = async () => db.get("SELECT * FROM bonus_approvals WHERE plan_id = ? AND period_start = ? AND status = 'approved'", plan.id, period.start);
    const shaped = (a, already) => ({ already_approved: already, approval: { ...a, detail: undefined }, lines: null });
    const had = await existing();
    // Approving twice (a double click, a retry) is harmless: the first approval stands.
    if (had) return res.json(shaped(had, true));
    let payroll = periodFor(ctx.today, ctx.tc).start;
    if (b.payroll_start) {
      reqDate(b.payroll_start, 'payroll_start');
      if (periodFor(b.payroll_start, ctx.tc).start !== b.payroll_start) throw new HttpError(400, `${b.payroll_start} isn’t the first day of a pay period`);
      payroll = b.payroll_start;
    }
    const review = await reviewPeriod(ctx, plan, version, period, { final: true });
    if (b.expected_total_cents != null && Number(b.expected_total_cents) !== review.totals.net_cents) {
      throw new HttpError(409, `The numbers changed since you looked (now ${money(review.totals.net_cents)}) — have another look before approving`, { total_cents: review.totals.net_cents });
    }
    const lines = review.people.filter((p) => p.earned_cents || p.clawback_cents || p.still_owed_cents);
    let id;
    try {
      await db.tx(async () => {
        id = await insert(db, 'bonus_approvals', {
          practice_id: req.user.practice_id, plan_id: plan.id, plan_version_id: version.id, period_start: period.start, period_end: period.end, status: 'approved',
          earned_cents: review.totals.earned_cents, cap_cut_cents: review.totals.cap_cut_cents, clawback_cents: review.totals.clawback_cents, total_cents: review.totals.net_cents,
          people: lines.filter((l) => l.net_cents).length, detail: JSON.stringify(review), detail_hash: review.hash, payroll_period_start: payroll, approved_by: req.user.id, approved_at: new Date().toISOString(),
        });
        for (const l of lines) {
          await insert(db, 'bonus_payout_lines', {
            practice_id: req.user.practice_id, approval_id: id, plan_id: plan.id, user_id: l.user_id, period_start: period.start, earned_cents: l.earned_cents, cap_cut_cents: l.cap_cut_cents,
            clawback_cents: l.clawback_cents, net_cents: l.net_cents, clawbacks: l.clawbacks.length ? JSON.stringify(l.clawbacks) : null, detail: JSON.stringify(l.detail),
          });
        }
      });
    } catch (err) {
      if (!isUnique(err)) throw err;
      return res.json(shaped(await existing(), true));
    }
    await audit(db, req, 'bonus.period_approve', 'bonus_approvals', id, { plan_id: plan.id, period_start: period.start, period_end: period.end, payroll_period_start: payroll },
      { after: { status: 'approved', earned_cents: review.totals.earned_cents, cap_cut_cents: review.totals.cap_cut_cents, clawback_cents: review.totals.clawback_cents, total_cents: review.totals.net_cents, people: lines.length } });
    const exported = await db.get('SELECT COUNT(*) AS n FROM payroll_exports WHERE practice_id = ? AND period_start = ?', req.user.practice_id, payroll);
    const approval = await db.get('SELECT * FROM bonus_approvals WHERE id = ?', id);
    res.status(201).json({
      already_approved: false, approval: { ...approval, detail: undefined },
      lines: lines.map((l) => ({ user_id: l.user_id, name: l.name, earned_cents: l.earned_cents, cap_cut_cents: l.cap_cut_cents, clawback_cents: l.clawback_cents, net_cents: l.net_cents })),
      warning: Number(exported.n) ? `Payroll for the pay period starting ${payroll} was already exported — export it again to include these bonuses.` : null,
    });
  });

  r.post('/bonus/periods/:id/reopen', async (req, res) => {
    needManage(req);
    requireHuman('reopening approved bonuses');
    const a = await findOr404(db, 'bonus_approvals', asId(req.params.id), req.user.practice_id, 'Approval');
    const reason = clean(req.body?.reason, REASON_MAX);
    if (!reason) throw new HttpError(400, 'Say why the approved bonuses are being reopened');
    if (a.status !== 'approved') throw new HttpError(409, 'This period is already reopened');
    const exports = (await db.all('SELECT id, bonus_detail FROM payroll_exports WHERE practice_id = ? AND period_start = ? AND bonus_detail IS NOT NULL', req.user.practice_id, a.payroll_period_start))
      .filter((e) => (JSON.parse(e.bonus_detail).approval_ids || []).includes(a.id)).map((e) => e.id);
    await recorded(db, 'bonus_approvals', a.id, () => db.run("UPDATE bonus_approvals SET status = 'reopened', reopened_by = ?, reopened_at = ?, reopen_reason = ? WHERE id = ? AND status = 'approved'", req.user.id, new Date().toISOString(), reason, a.id));
    await audit(db, req, 'bonus.period_reopen', 'bonus_approvals', a.id, { plan_id: a.plan_id, period_start: a.period_start, total_cents: a.total_cents, already_exported: exports }, { reason });
    res.json({ ok: true, warning: exports.length ? 'These bonuses were already in a payroll file. If that payroll was run, fix it with your payroll provider — the next file leaves them out.' : null });
  });

  r.get('/bonus/approvals', async (req, res) => {
    needManage(req);
    const planId = req.query.plan_id ? asId(req.query.plan_id, 'plan_id') : null;
    res.json(await db.all(
      `SELECT a.id, a.plan_id, p.name AS plan_name, a.period_start, a.period_end, a.status, a.earned_cents, a.cap_cut_cents, a.clawback_cents, a.total_cents, a.people, a.payroll_period_start,
         a.approved_at, u.name AS approved_by_name, a.reopened_at, a.reopen_reason FROM bonus_approvals a JOIN bonus_plans p ON p.id = a.plan_id LEFT JOIN users u ON u.id = a.approved_by
       WHERE a.practice_id = ?${planId ? ' AND a.plan_id = ?' : ''} ORDER BY a.period_start DESC, a.id DESC LIMIT 200`, req.user.practice_id, ...(planId ? [planId] : []),
    ));
  });

  // What the next payroll file carries (the owner checks it before exporting).
  r.get('/bonus/payroll', async (req, res) => {
    needManage(req);
    const ctx = await ctxFor(req);
    const start = req.query.start ? reqDate(req.query.start, 'start') : periodFor(ctx.today, ctx.tc).start;
    const p = periodFor(start, ctx.tc);
    res.json({ period: p, ...(await bonusesForPayroll(db, req.user.practice_id, p.start)) });
  });

  return r;
}

// A plan type's starting settings. The team plan needs its target filled in before it can be saved.
function normalizeConfigSafe(type) {
  if (type !== 'team_collections') return normalizeConfig(type, {});
  return { ...normalizeConfig(type, { target_cents: 1 }), target_cents: 0 };
}
