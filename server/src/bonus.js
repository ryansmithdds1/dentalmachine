import { createHash } from 'node:crypto';
import { HttpError } from './auth.js';
import { computeMetrics, goalsFor } from './metrics.js';
import { computeHours, practiceRules, staffList } from './routes/timeclock.js';
import { staffRoles } from './businessdata.js';
import { allocate, laborCost } from './business.js';
import { hoursFor, providerHoursOn } from './hours.js';
import { practiceNow, utcRange, MAX_CENTS } from './util.js';
import { weekStart as tcWeekStart } from './timeclock.js';

// Team bonus module (BN1–BN3; docs/workflows/specs/BN-bonus.md). Off until the owner turns it on.
//
// Six common plans, each a deterministic calculation from data the practice already keeps:
//   team_collections — collections (or production) over a target → a share of the excess split by hours / role / equally;
//   daily_goal       — each day (or week) the office hits its goal → a set amount to everyone who worked it;
//   spiff            — a set amount (or %) per procedure code to the provider, assistant or whoever booked the visit;
//   provider_pct     — a provider's % of production or collections above a base;
//   scorecard        — points for hitting KPI targets → payout tiers;
//   front_desk       — the same scorecard with front-desk measures (schedule fill, broken appointments, collected
//                      at checkout, waiting treatment scheduled).
// Money and KPIs come from metrics.js (one definition per KPI; the ledger is the source of truth, voided entries and
// their reversals left out), hours from the time clock (computeHours: the same hours payroll pays). Amounts are
// integer cents; every split adds up exactly (largest remainder).
//
// Clawbacks: an approved period stores each person's calculation. When a later period is approved, every approved
// period of the same plan within the plan's clawback window is recalculated from the ledger as it stands now; if a
// void or refund means someone was paid more than they'd earn today, the difference is taken from their next bonus
// (never below zero; what's left carries on to the next one). Nothing already approved is ever edited.

export const DEFAULT_ROLES = ['dentist', 'hygienist', 'assistant', 'front_desk', 'billing'];
export const ROLES = ['admin', ...DEFAULT_ROLES];
export const ROLE_LABELS = { admin: 'Administrator / owner', dentist: 'Dentist', hygienist: 'Hygienist', assistant: 'Assistant', front_desk: 'Front desk', billing: 'Billing' };
export const MONEY_BASES = { collections: 'Collections', production_net: 'Net production (after write-offs)', production_gross: 'Gross production' };
export const PERIODS = { month: 'Month', week: 'Week' };

// The measures a scorecard can use. better: which way is good; unit: percent (a number like 90), money (cents), count.
export const KPIS = {
  hygiene_reappointment: { label: 'Hygiene reappointment', unit: 'percent', better: 'higher', source: 'metric' },
  case_acceptance: { label: 'Case acceptance', unit: 'percent', better: 'higher', source: 'metric' },
  collection_rate: { label: 'Collection rate', unit: 'percent', better: 'higher', source: 'metric' },
  new_patients: { label: 'New patients', unit: 'count', better: 'higher', source: 'metric' },
  broken_rate: { label: 'No-show & cancel rate', unit: 'percent', better: 'lower', source: 'metric' },
  production_gross: { label: 'Gross production', unit: 'money', better: 'higher', source: 'metric' },
  collections: { label: 'Collections', unit: 'money', better: 'higher', source: 'metric' },
  reviews: { label: 'Reviews & shout-outs (positive mentions of the team)', unit: 'count', better: 'higher', source: 'reviews' },
  checklists: { label: 'Checklists done on time', unit: 'percent', better: 'higher', source: 'checklists' },
  schedule_fill: { label: 'Schedule fill (booked time ÷ provider hours)', unit: 'percent', better: 'higher', source: 'schedule' },
  otc_collections: { label: 'Collected at checkout (patient payments on the visit day)', unit: 'money', better: 'higher', source: 'otc' },
  tx_scheduled: { label: 'Waiting treatment scheduled (fees of earlier-planned work booked in the period)', unit: 'money', better: 'higher', source: 'txsched' },
};

const COMMON_DEFAULTS = {
  period: 'month', location_id: null, cap_person_cents: 0, cap_total_cents: 0, team_visible: false, clawback_days: 90,
  eligibility: { min_hours: 0, roles: DEFAULT_ROLES, user_ids: [], exclude_user_ids: [] },
};

// The catalog: what each plan does in plain words, a worked example, and its starting settings.
export const PLAN_TYPES = {
  team_collections: {
    label: 'Team collections bonus',
    summary: 'When the office collects more than a target in the month, the team shares part of the extra.',
    how: [
      'The target is a set amount, or your labor cost ÷ your target labor % (the usual way: if payroll should be 22% of collections, the target is payroll ÷ 0.22).',
      'Everything collected above the target is the "excess"; the team’s share of it (say 20%) is the bonus pool.',
      'The pool is split by hours worked (from the time clock), by role weights, or equally among everyone who qualifies.',
    ],
    example: 'Labor cost last month was $19,800 and the target labor is 22%, so the target is $90,000. The team collected $98,000 — $8,000 over. A 20% share makes a $1,600 pool. Split by hours (Maria 160 h, Sam 120 h, Jo 80 h): Maria $711.11, Sam $533.33, Jo $355.56.',
    defaults: { basis: 'collections', target_mode: 'fixed', target_cents: 0, labor_bp: 2200, share_bp: 2000, split: 'hours', role_weights: {} },
  },
  daily_goal: {
    label: 'Daily or weekly goal bonus',
    summary: 'Each day (or week) the office hits its production or collections goal, everyone who worked it earns a set amount.',
    how: [
      'The goal is the one already set in Metrics (or the daily goal in Settings), or a fixed amount you choose here.',
      'Everyone who clocked in that day (any day of the week, for weekly goals) earns the amount for each goal hit.',
      'Totals are paid once a month, after you approve them.',
    ],
    example: 'The goal is $6,000 a day and each hit pays $20. The office hit it on 14 of 20 days; Sam worked 12 of those days, so Sam earns 12 × $20 = $240.',
    defaults: { unit: 'day', basis: 'production_gross', goal_mode: 'goal', goal_cents: 0, amount_cents: 2000 },
  },
  spiff: {
    label: 'Per-procedure spiffs',
    summary: 'A set amount (or a %) for specific procedures — sealants, fluoride, whitening, perio maintenance, same-day crowns.',
    how: [
      'Counts procedures completed in the period whose charge is still live on the ledger.',
      'Goes to the provider who did it (their login must be linked to the provider), the assistant working with that provider or chair that day (split if more than one), or the person who booked the visit.',
      'If a charge is voided after the period is approved, the spiff comes off that person’s next bonus.',
    ],
    example: 'Sealants pay $5 each to the hygienist; whitening pays 10% to whoever booked it. Hal placed 14 sealants → $70. Jo booked a $400 whitening → $40.',
    defaults: { rules: [{ codes: ['D1351'], label: 'Sealants', amount_cents: 500, pct_bp: 0, to: 'provider' }] },
  },
  provider_pct: {
    label: 'Hygiene / associate % above a base',
    summary: 'Each provider earns a % of their own production or collections above a base amount.',
    how: [
      'Production and collections are the provider’s own, by the same rules as Reports → Metrics (collections split by what each payment paid for).',
      'Paid to the login linked to the provider. Each provider sees only their own numbers unless you make the plan visible to the team.',
    ],
    example: 'Hal’s base is $12,000 a month at 10%. Hal collected $15,500 → ($15,500 − $12,000) × 10% = $350.',
    defaults: { basis: 'collections', providers: [], eligibility: { min_hours: 0, roles: ['dentist', 'hygienist'], user_ids: [], exclude_user_ids: [] } },
  },
  scorecard: {
    label: 'KPI scorecard',
    summary: 'Points for each target the team hits — reappointment, case acceptance, collection rate, reviews, checklists… — and the points decide the payout.',
    how: [
      'Each measure has a target and a number of points. The measures are the practice’s own (Reports → Metrics), reviews and shout-outs, and checklists.',
      'The highest tier reached pays everyone who qualifies the same amount.',
    ],
    example: 'Five targets at 1 point each; 3 points pays $50, 5 points pays $100. Reappointment 91% ✓, case acceptance 55% ✗, collection rate 99% ✓, 6 shout-outs ✓, checklists 97% ✓ → 4 points → $50 each.',
    defaults: {
      kpis: [{ key: 'hygiene_reappointment', target: 90, points: 1 }, { key: 'case_acceptance', target: 60, points: 1 }, { key: 'collection_rate', target: 98, points: 1 },
        { key: 'reviews', target: 5, points: 1 }, { key: 'checklists', target: 95, points: 1 }],
      tiers: [{ points: 3, amount_cents: 5000 }, { points: 5, amount_cents: 10000 }],
    },
  },
  front_desk: {
    label: 'Front desk bonus',
    summary: 'A scorecard for the front desk: a full schedule, few broken appointments, money collected at checkout and waiting treatment booked.',
    how: [
      'Schedule fill is booked visit time over the providers’ hours; broken appointments are no-shows and cancellations over all visits.',
      'Collected at checkout is patient payments taken on the day of the patient’s visit; waiting treatment scheduled is the fees of work planned earlier that got booked in the period.',
    ],
    example: 'Schedule 92% full ✓ (target 90%), no-shows 8% ✓ (10% or less), $11,200 collected at checkout ✓ ($10,000), $3,800 of waiting treatment booked ✗ ($5,000) → 3 points; the 2-point tier pays $40 → $40 each.',
    defaults: {
      kpis: [{ key: 'schedule_fill', target: 90, points: 1 }, { key: 'broken_rate', target: 10, points: 1 }, { key: 'otc_collections', target: 1000000, points: 1 }, { key: 'tx_scheduled', target: 500000, points: 1 }],
      tiers: [{ points: 2, amount_cents: 4000 }, { points: 4, amount_cents: 8000 }],
      eligibility: { min_hours: 0, roles: ['front_desk', 'billing'], user_ids: [], exclude_user_ids: [] },
    },
  },
};
export const COMMON_RULES = [
  'Who qualifies: active staff in the roles (or people) you choose, with at least the hours you set in the period (from the time clock).',
  'Caps: an optional most per person and most for the whole plan each period; a total cap scales everyone down evenly.',
  'Clawbacks: if a charge is voided or a payment refunded after a period was approved, the difference comes off the next bonus (never below zero).',
  'Nothing is paid until you approve the period. Approved bonuses go into the time-clock payroll export as their own pay type.',
];

// ---- Dates and periods ----
export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const monthEnd = (d) => addDays(`${addDays(`${d.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (d) => DATE.test(String(d || '')) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;
export function periodOf(kind, date, weekStartDay = 1) {
  if (kind === 'week') {
    const start = tcWeekStart(date, weekStartDay);
    return { start, end: addDays(start, 6) };
  }
  return { start: `${date.slice(0, 7)}-01`, end: monthEnd(date) };
}
export const previousPeriodOf = (kind, period, wsd) => periodOf(kind, addDays(period.start, -1), wsd);
export const nextPeriodOf = (kind, period, wsd) => periodOf(kind, addDays(period.end, 1), wsd);
const minDate = (a, b) => (a < b ? a : b);

// ---- Configuration ----
const bad = (msg) => { throw new HttpError(400, msg); };
const int = (v, name, min, max) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || Math.round(n) !== n || n < min || n > max) bad(`${name} must be a whole number from ${min} to ${max}`);
  return n;
};
const num = (v, name, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) bad(`${name} must be a number from ${min} to ${max}`);
  return n;
};
const oneOf = (v, list, name) => {
  if (!list.includes(v)) bad(`${name} must be one of: ${list.join(', ')}`);
  return v;
};
const idList = (v, name) => {
  if (v == null) return [];
  if (!Array.isArray(v)) bad(`${name} must be a list`);
  return [...new Set(v.map((x) => int(x, name, 1, 2 ** 31 - 1)))];
};
const CODE = /^[A-Z0-9]{2,10}$/;

// Checks and fills a plan's settings. Unknown keys are dropped; every number is range-checked.
export function normalizeConfig(type, raw = {}) {
  const t = PLAN_TYPES[type] || bad(`type must be one of: ${Object.keys(PLAN_TYPES).join(', ')}`);
  const d = { ...COMMON_DEFAULTS, ...t.defaults };
  const r = { ...d, ...(raw || {}) };
  const e = { ...d.eligibility, ...(raw?.eligibility || {}) };
  const out = {
    period: oneOf(r.period, Object.keys(PERIODS), 'period'),
    location_id: r.location_id == null || r.location_id === '' ? null : int(r.location_id, 'location_id', 1, 2 ** 31 - 1),
    cap_person_cents: int(r.cap_person_cents, 'cap_person_cents', 0, MAX_CENTS),
    cap_total_cents: int(r.cap_total_cents, 'cap_total_cents', 0, MAX_CENTS),
    team_visible: !!r.team_visible,
    clawback_days: int(r.clawback_days, 'clawback_days', 0, 365),
    eligibility: {
      min_hours: num(e.min_hours ?? 0, 'eligibility.min_hours', 0, 500),
      roles: (Array.isArray(e.roles) ? e.roles : bad('eligibility.roles must be a list')).map((x) => oneOf(x, ROLES, 'eligibility.roles')),
      user_ids: idList(e.user_ids, 'eligibility.user_ids'),
      exclude_user_ids: idList(e.exclude_user_ids, 'eligibility.exclude_user_ids'),
    },
  };
  if (type === 'team_collections') {
    out.basis = oneOf(r.basis, Object.keys(MONEY_BASES), 'basis');
    out.target_mode = oneOf(r.target_mode, ['fixed', 'labor'], 'target_mode');
    out.target_cents = int(r.target_cents, 'target_cents', 0, MAX_CENTS);
    out.labor_bp = int(r.labor_bp, 'labor_bp', 1, 10000);
    out.share_bp = int(r.share_bp, 'share_bp', 0, 10000);
    out.split = oneOf(r.split, ['hours', 'role_weights', 'equal'], 'split');
    out.role_weights = {};
    for (const [k, v] of Object.entries(r.role_weights || {})) out.role_weights[oneOf(k, ROLES, 'role_weights')] = num(v, `role_weights.${k}`, 0, 100);
    if (out.target_mode === 'fixed' && !out.target_cents) bad('Set the target the team needs to beat');
  } else if (type === 'daily_goal') {
    out.unit = oneOf(r.unit, ['day', 'week'], 'unit');
    out.basis = oneOf(r.basis, Object.keys(MONEY_BASES), 'basis');
    out.goal_mode = oneOf(r.goal_mode, ['goal', 'fixed'], 'goal_mode');
    out.goal_cents = int(r.goal_cents, 'goal_cents', 0, MAX_CENTS);
    out.amount_cents = int(r.amount_cents, 'amount_cents', 0, 10_000_000);
    if (out.goal_mode === 'fixed' && !out.goal_cents) bad('Set the goal for each day (or week)');
    out.period = 'month';
  } else if (type === 'spiff') {
    if (!Array.isArray(r.rules) || !r.rules.length) bad('Add at least one procedure');
    if (r.rules.length > 50) bad('At most 50 spiff rules');
    out.rules = r.rules.map((x, i) => {
      const codes = (Array.isArray(x.codes) ? x.codes : [x.code]).map((c) => String(c ?? '').trim().toUpperCase()).filter(Boolean);
      if (!codes.length || codes.some((c) => !CODE.test(c))) bad(`Rule ${i + 1}: give procedure codes like D1351`);
      const amount = int(x.amount_cents, `rules[${i}].amount_cents`, 0, 10_000_000);
      const pct = int(x.pct_bp, `rules[${i}].pct_bp`, 0, 10000);
      if (!amount && !pct) bad(`Rule ${i + 1}: set an amount or a %`);
      return { codes: [...new Set(codes)], label: String(x.label || codes.join(', ')).replace(/[\u0000-\u001f]+/g, ' ').slice(0, 80), amount_cents: amount, pct_bp: pct, to: oneOf(x.to || 'provider', ['provider', 'assistant', 'scheduler'], `rules[${i}].to`) };
    });
  } else if (type === 'provider_pct') {
    out.basis = oneOf(r.basis, Object.keys(MONEY_BASES), 'basis');
    if (!Array.isArray(r.providers)) bad('providers must be a list');
    out.providers = r.providers.map((x, i) => ({
      provider_id: int(x.provider_id, `providers[${i}].provider_id`, 1, 2 ** 31 - 1),
      base_cents: int(x.base_cents, `providers[${i}].base_cents`, 0, MAX_CENTS),
      pct_bp: int(x.pct_bp, `providers[${i}].pct_bp`, 0, 10000),
    }));
    if (new Set(out.providers.map((p) => p.provider_id)).size !== out.providers.length) bad('Each provider once');
  } else {
    if (!Array.isArray(r.kpis) || !r.kpis.length) bad('Add at least one target');
    out.kpis = r.kpis.map((k, i) => ({ key: oneOf(k.key, Object.keys(KPIS), `kpis[${i}].key`), target: num(k.target, `kpis[${i}].target`, 0, MAX_CENTS), points: int(k.points ?? 1, `kpis[${i}].points`, 0, 100) }));
    if (!Array.isArray(r.tiers) || !r.tiers.length) bad('Add at least one payout tier');
    out.tiers = r.tiers.map((x, i) => ({ points: int(x.points, `tiers[${i}].points`, 0, 1000), amount_cents: int(x.amount_cents, `tiers[${i}].amount_cents`, 0, 10_000_000) })).sort((a, b) => a.points - b.points);
  }
  return out;
}

// ---- Pure money math (the tests pin these) ----

// The team pool: the share of what's over the target (never negative), rounded down to the cent.
export function teamPool({ actual, target, share_bp }) {
  const excess = Math.max(0, (actual || 0) - (target || 0));
  return { excess, pool: Math.floor((excess * share_bp) / 10000) };
}

// Splits a pool across weights, exactly (largest remainder). Nobody with weight gets anything → nothing is paid
// (the pool never lands on one person by default).
export function splitPool(pool, weights) {
  if (!weights.length || pool <= 0 || weights.reduce((t, w) => t + Math.max(0, w), 0) <= 0) return weights.map(() => 0);
  return allocate(pool, weights);
}

// A % of what's over a base (never negative), rounded down to the cent.
export const overBase = (value, base, pct_bp) => Math.floor((Math.max(0, (value || 0) - (base || 0)) * pct_bp) / 10000);

// Caps: first the most per person, then the most for the plan (scaled evenly across people, exactly).
export function applyCaps(amounts, { cap_person_cents = 0, cap_total_cents = 0 } = {}) {
  let out = amounts.map((a) => (cap_person_cents > 0 ? Math.min(a, cap_person_cents) : a));
  const total = out.reduce((t, a) => t + a, 0);
  if (cap_total_cents > 0 && total > cap_total_cents) out = allocate(cap_total_cents, out);
  return out;
}

// Takes what a person still owes from earlier periods out of this period's amount (oldest first, never below zero).
// owed: [{ approval_id, period_start, cents }] → { taken, clawbacks: [{ approval_id, period_start, cents }], left }
export function recover(available, owed) {
  let room = Math.max(0, available);
  const clawbacks = [];
  let left = 0;
  for (const o of [...owed].sort((a, b) => (a.period_start < b.period_start ? -1 : a.period_start > b.period_start ? 1 : a.approval_id - b.approval_id))) {
    const take = Math.min(room, o.cents);
    if (take > 0) clawbacks.push({ approval_id: o.approval_id, period_start: o.period_start, cents: take });
    room -= take;
    left += o.cents - take;
  }
  const taken = clawbacks.reduce((t, c) => t + c.cents, 0);
  return { taken, clawbacks, left };
}

// The highest tier reached by a number of points (null: none).
export const tierFor = (points, tiers) => [...tiers].sort((a, b) => b.points - a.points).find((t) => points >= t.points) || null;

export const kpiMet = (key, value, target) => (value == null ? false : KPIS[key].better === 'lower' ? value <= target : value >= target);

// ---- Context ----
export async function loadContext(db, pid, { today = null } = {}) {
  const { tz, settings } = await practiceRules(db, pid);
  const now = today || (await practiceNow(db, pid)).slice(0, 10);
  const staff = await staffList(db, pid);
  const practice = await db.get('SELECT office_hours FROM practices WHERE id = ?', pid);
  return { db, pid, tz, tc: settings, today: now, staff, practice, cache: new Map() };
}
const cached = async (ctx, key, fn) => {
  if (!ctx.cache.has(key)) ctx.cache.set(key, fn());
  return ctx.cache.get(key);
};
const hoursOf = (ctx, from, to) => cached(ctx, `hours:${from}:${to}`, () => computeHours(ctx.db, ctx.pid, { from, to, tz: ctx.tz, settings: ctx.tc, staff: ctx.staff }));
const metricValue = (ctx, key, from, to, { locationId = null, providerId = null } = {}) => cached(ctx, `m:${key}:${from}:${to}:${locationId}:${providerId}`, async () => {
  const { values } = await computeMetrics(ctx.db, ctx.pid, { from, to, today: ctx.today, keys: [key], ...(locationId ? { locationId } : {}), ...(providerId ? { providerId } : {}) });
  return values[key] ?? null;
});
async function officeOf(ctx, locationId) {
  if (!locationId) return ctx.practice;
  const loc = await ctx.db.get('SELECT office_hours FROM locations WHERE id = ? AND practice_id = ?', locationId, ctx.pid);
  return loc?.office_hours ? loc : ctx.practice;
}
export async function openDaysIn(ctx, from, to, locationId = null) {
  const office = await officeOf(ctx, locationId);
  const out = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) if (hoursFor(office, d).length) out.push(d);
  return out;
}

// Who is in a plan, and whether they qualify. final: the period is over (short of hours = didn't qualify).
function standingOf(u, elig, minutes, final) {
  if (!u.active) return { in_plan: false, eligible: false, why: 'No longer active' };
  if (elig.roles.length && !elig.roles.includes(u.role)) return { in_plan: false, eligible: false, why: `This plan is for: ${elig.roles.map((r) => ROLE_LABELS[r]).join(', ')}` };
  if (elig.user_ids.length && !elig.user_ids.includes(u.id)) return { in_plan: false, eligible: false, why: 'Not one of the people in this plan' };
  if (elig.exclude_user_ids.includes(u.id)) return { in_plan: false, eligible: false, why: 'Left out of this plan' };
  const need = Math.round(elig.min_hours * 60);
  if (need > 0 && minutes < need) {
    const h = (m) => Math.round((m / 60) * 10) / 10;
    return { in_plan: true, eligible: false, why: final ? `Needed ${h(need)} hours, worked ${h(minutes)}` : `${h(minutes)} of ${h(need)} hours so far` };
  }
  return { in_plan: true, eligible: true, why: null };
}

async function peopleFor(ctx, cfg, period, to, final) {
  const hours = await hoursOf(ctx, period.start, to);
  return ctx.staff.map((u) => {
    const minutes = hours.get(u.id)?.summary?.worked || 0;
    return { user_id: u.id, name: u.name, role: u.role, minutes, earned_cents: 0, detail: [], ...standingOf(u, cfg.eligibility, minutes, final) };
  });
}
const fmt = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- The plans ----
const ENGINES = {
  async team_collections(ctx, cfg, period, to, final) {
    const loc = { locationId: cfg.location_id };
    const actual = (await metricValue(ctx, cfg.basis, period.start, to, loc)) || 0;
    let target = cfg.target_cents;
    const notes = [];
    let labor = null;
    if (cfg.target_mode === 'labor') {
      const hours = await hoursOf(ctx, period.start, to);
      labor = 0;
      const missing = [];
      for (const u of ctx.staff) {
        const h = hours.get(u.id);
        if (!h?.summary?.worked) continue;
        if (u.hourly_rate_cents == null) { missing.push(u.name); continue; }
        labor += laborCost(h.summary, u.hourly_rate_cents);
      }
      if (missing.length) notes.push(`No pay rate on the time clock for ${missing.join(', ')} — their hours aren’t in the labor cost.`);
      target = Math.round((labor * 10000) / cfg.labor_bp);
    }
    const { excess, pool } = teamPool({ actual, target, share_bp: cfg.share_bp });
    const people = await peopleFor(ctx, cfg, period, to, final);
    const eligible = people.filter((p) => p.eligible);
    const weights = eligible.map((p) => (cfg.split === 'hours' ? p.minutes : cfg.split === 'role_weights' ? cfg.role_weights[p.role] ?? 1 : 1));
    const shares = splitPool(pool, weights);
    eligible.forEach((p, i) => {
      p.earned_cents = shares[i];
      p.weight = weights[i];
      if (pool > 0) p.detail.push(cfg.split === 'hours' ? `${Math.round((p.minutes / 60) * 10) / 10} h of the team’s hours` : cfg.split === 'role_weights' ? `Role weight ${weights[i]}` : 'Equal share');
    });
    if (pool > 0 && !shares.some((s) => s > 0)) notes.push('Nobody who qualifies has hours to split the pool by, so nothing is paid.');
    return {
      team: { kind: 'target', label: MONEY_BASES[cfg.basis], actual, target, excess, pool, labor_cents: labor, to_go: Math.max(0, target - actual) },
      people, notes,
    };
  },

  async daily_goal(ctx, cfg, period, to, final) {
    const loc = { locationId: cfg.location_id };
    const units = [];
    if (cfg.unit === 'day') {
      for (const d of await openDaysIn(ctx, period.start, period.end, cfg.location_id)) units.push({ from: d, to: d });
    } else {
      for (let w = tcWeekStart(period.start, ctx.tc.week_start_day); w <= period.end; w = addDays(w, 7)) {
        const end = addDays(w, 6);
        if (end >= period.start && end <= period.end) units.push({ from: w, to: end });
      }
    }
    const firstFrom = units.length ? minDate(units[0].from, period.start) : period.start;
    const hours = await hoursOf(ctx, firstFrom, to);
    const workedOn = (uid, from, until) => (hours.get(uid)?.all || []).some((p) => p.date >= from && p.date <= until && (p.minutes || 0) > 0);
    const people = await peopleFor(ctx, cfg, period, to, final);
    const notes = [];
    const results = [];
    let today = null;
    for (const u of units) {
      if (u.from > ctx.today) break;
      const done = u.to < ctx.today || final;
      const upTo = minDate(u.to, ctx.today);
      const actual = (await metricValue(ctx, cfg.basis, u.from, upTo, loc)) || 0;
      let goal = cfg.goal_cents;
      if (cfg.goal_mode === 'goal') {
        const g = await goalsFor(ctx.db, ctx.pid, { from: u.from, to: u.to, ...(cfg.location_id ? { locationId: cfg.location_id } : {}) });
        goal = g[cfg.basis]?.goal ?? null;
      }
      const row = { from: u.from, to: u.to, actual, goal, pct: goal ? Math.round((actual / goal) * 1000) / 10 : null, hit: !!goal && actual >= goal, done };
      if (!done) { today = row; continue; }
      results.push(row);
    }
    if (cfg.goal_mode === 'goal' && results.some((r) => !r.goal)) notes.push(`There’s no ${MONEY_BASES[cfg.basis].toLowerCase()} goal for some ${cfg.unit === 'day' ? 'days' : 'weeks'} — set one in Reports → Metrics or pick a fixed goal.`);
    const hits = results.filter((r) => r.hit);
    for (const p of people) {
      if (!p.in_plan) continue;
      const mine = hits.filter((r) => workedOn(p.user_id, r.from, r.to));
      p.hits = mine.length;
      if (p.eligible) {
        p.earned_cents = mine.length * cfg.amount_cents;
        if (mine.length) p.detail.push(`${mine.length} goal${mine.length === 1 ? '' : 's'} hit while working × ${fmt(cfg.amount_cents)}`);
      }
    }
    return {
      team: { kind: 'goals', label: MONEY_BASES[cfg.basis], unit: cfg.unit, hits: hits.length, counted: results.length, total_units: units.length, units: results, today },
      people, notes,
    };
  },

  async spiff(ctx, cfg, period, to, final) {
    const people = await peopleFor(ctx, cfg, period, to, final);
    const byUser = new Map(people.map((p) => [p.user_id, p]));
    const codes = [...new Set(cfg.rules.flatMap((r) => r.codes))];
    const loc = cfg.location_id ? ' AND l.location_id = ?' : '';
    const rows = codes.length ? await ctx.db.all(
      `SELECT l.id, l.amount, l.entry_date, COALESCE(pr.provider_id, l.provider_id) AS provider_id, pr.id AS procedure_id, pr.code, pr.appointment_id, a.operatory_id
       FROM ledger_entries l JOIN procedures pr ON pr.id = l.procedure_id LEFT JOIN appointments a ON a.id = pr.appointment_id
       WHERE l.practice_id = ? AND l.type = 'charge' AND l.voided_at IS NULL AND l.reverses_id IS NULL AND l.entry_date >= ? AND l.entry_date <= ?
         AND pr.code IN (${codes.map(() => '?').join(',')})${loc} ORDER BY l.id`,
      ctx.pid, period.start, to, ...codes, ...(cfg.location_id ? [cfg.location_id] : []),
    ) : [];
    const providers = new Map((await ctx.db.all('SELECT id, user_id, name FROM providers WHERE practice_id = ?', ctx.pid)).map((p) => [p.id, p]));
    const apptIds = [...new Set(rows.map((r) => r.appointment_id).filter(Boolean))];
    const booker = new Map();
    for (let i = 0; i < apptIds.length; i += 500) {
      const chunk = apptIds.slice(i, i + 500);
      for (const a of await ctx.db.all(`SELECT entity_id, user_id FROM audit_log WHERE practice_id = ? AND entity = 'appointments' AND action = 'appointment.create' AND source = 'human' AND user_id IS NOT NULL AND entity_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`, ctx.pid, ...chunk)) {
        if (!booker.has(Number(a.entity_id))) booker.set(Number(a.entity_id), a.user_id);
      }
    }
    const needsAssistants = cfg.rules.some((r) => r.to === 'assistant');
    const roles = needsAssistants ? await staffRoles(ctx.db, ctx.pid, ctx.staff) : new Map();
    const hours = needsAssistants ? await hoursOf(ctx, period.start, to) : new Map();
    const onShift = (uid, date) => (hours.get(uid)?.all || []).some((p) => p.date === date && (p.minutes || 0) > 0);
    const unassigned = [];
    const counts = new Map();
    const credit = (uid, cents, what) => {
      const p = byUser.get(uid);
      if (!p) return false;
      if (!p.in_plan) return false;
      if (p.eligible) p.earned_cents += cents;
      const k = `${uid}:${what}`;
      counts.set(k, (counts.get(k) || 0) + 1);
      p.spiff_cents = (p.spiff_cents || 0) + cents;
      return true;
    };
    for (const row of rows) {
      for (const rule of cfg.rules) {
        if (!rule.codes.includes(row.code)) continue;
        const cents = rule.amount_cents + Math.floor((Math.max(0, row.amount) * rule.pct_bp) / 10000);
        if (!cents) continue;
        let to_ = [];
        if (rule.to === 'provider') {
          const pv = providers.get(row.provider_id);
          if (pv?.user_id) to_ = [pv.user_id];
          else unassigned.push(`${row.code} on ${row.entry_date}: ${pv ? `${pv.name} isn’t linked to a login` : 'no provider'}`);
        } else if (rule.to === 'scheduler') {
          const uid = row.appointment_id ? booker.get(row.appointment_id) : null;
          if (uid) to_ = [uid];
          else unassigned.push(`${row.code} on ${row.entry_date}: not booked by a person in the app`);
        } else {
          const linked = [...roles.entries()].filter(([uid, r]) => r.kind === 'assistant' && (r.provider_ids.includes(row.provider_id) || (row.operatory_id && r.operatory_ids.includes(row.operatory_id))) && onShift(uid, row.entry_date)).map(([uid]) => uid);
          const pooled = linked.length ? linked : [...roles.entries()].filter(([uid, r]) => r.kind === 'assistant' && r.pooled && onShift(uid, row.entry_date)).map(([uid]) => uid);
          to_ = pooled.sort((a, b) => a - b);
          if (!to_.length) unassigned.push(`${row.code} on ${row.entry_date}: no assistant on the clock that day`);
        }
        const parts = splitPool(cents, to_.map(() => 1));
        to_.forEach((uid, i) => credit(uid, parts[i], rule.label));
      }
    }
    for (const [k, n] of counts) {
      const [uid, what] = [Number(k.slice(0, k.indexOf(':'))), k.slice(k.indexOf(':') + 1)];
      byUser.get(uid).detail.push(`${n} × ${what}`);
    }
    // People who earned spiffs but didn't qualify see why (and so does the owner).
    for (const p of people) if (p.spiff_cents && !p.eligible) p.detail.push(`${fmt(p.spiff_cents)} in spiffs not paid: ${p.why}`);
    return {
      team: { kind: 'count', label: 'Procedures counted', procedures: rows.length, spiff_cents: people.reduce((t, p) => t + (p.spiff_cents || 0), 0) },
      people, notes: unassigned.length ? [`Not paid to anyone (${unassigned.length}): ${unassigned.slice(0, 10).join('; ')}${unassigned.length > 10 ? '…' : ''}`] : [],
    };
  },

  async provider_pct(ctx, cfg, period, to, final) {
    const people = await peopleFor(ctx, cfg, period, to, final);
    const byUser = new Map(people.map((p) => [p.user_id, p]));
    const providers = new Map((await ctx.db.all('SELECT id, user_id, name FROM providers WHERE practice_id = ?', ctx.pid)).map((p) => [p.id, p]));
    const notes = [];
    const rows = [];
    for (const x of cfg.providers) {
      const pv = providers.get(x.provider_id);
      if (!pv) continue;
      const value = (await metricValue(ctx, cfg.basis, period.start, to, { locationId: cfg.location_id, providerId: pv.id })) || 0;
      const earned = overBase(value, x.base_cents, x.pct_bp);
      rows.push({ provider_id: pv.id, provider_name: pv.name, user_id: pv.user_id, value, base: x.base_cents, pct_bp: x.pct_bp, earned, to_go: Math.max(0, x.base_cents - value) });
      if (!pv.user_id) { notes.push(`${pv.name} isn’t linked to a login, so their bonus can’t be paid.`); continue; }
      const p = byUser.get(pv.user_id);
      if (!p) continue;
      p.provider = { provider_id: pv.id, value, base: x.base_cents, pct_bp: x.pct_bp, to_go: Math.max(0, x.base_cents - value) };
      if (p.in_plan && p.eligible) p.earned_cents += earned;
      p.detail.push(`${MONEY_BASES[cfg.basis]} ${fmt(value)} − base ${fmt(x.base_cents)} × ${x.pct_bp / 100}%`);
    }
    for (const p of people) if (!p.provider) { p.in_plan = false; p.eligible = false; p.why = p.why || 'Not a provider in this plan'; }
    return { team: { kind: 'providers', label: MONEY_BASES[cfg.basis], providers: rows }, people, notes };
  },

  async scorecard(ctx, cfg, period, to, final) {
    const kpis = [];
    for (const k of cfg.kpis) {
      const value = await kpiValue(ctx, k.key, period.start, to, cfg.location_id);
      kpis.push({ ...k, label: KPIS[k.key].label, unit: KPIS[k.key].unit, better: KPIS[k.key].better, value, met: kpiMet(k.key, value, k.target) });
    }
    const points = kpis.filter((k) => k.met).reduce((t, k) => t + k.points, 0);
    const tier = tierFor(points, cfg.tiers);
    const next = cfg.tiers.find((t) => t.points > points) || null;
    const people = await peopleFor(ctx, cfg, period, to, final);
    for (const p of people) if (p.eligible && tier) {
      p.earned_cents = tier.amount_cents;
      p.detail.push(`${points} point${points === 1 ? '' : 's'} → ${fmt(tier.amount_cents)} tier`);
    }
    return { team: { kind: 'scorecard', kpis, points, max_points: kpis.reduce((t, k) => t + k.points, 0), tier, next_tier: next }, people, notes: [] };
  },
};
ENGINES.front_desk = ENGINES.scorecard;

// The value of one scorecard measure for [from, to] (practice or one office).
export async function kpiValue(ctx, key, from, to, locationId = null) {
  const def = KPIS[key];
  if (def.source === 'metric') return metricValue(ctx, key, from, to, { locationId });
  const { db, pid } = ctx;
  if (def.source === 'reviews') {
    const [a, b] = await utcRange(db, pid, from, to);
    return Number((await db.get("SELECT COUNT(*) AS n FROM review_shoutouts WHERE practice_id = ? AND status = 'counted' AND positive = 1 AND created_at >= ? AND created_at < ?", pid, a, b)).n);
  }
  if (def.source === 'checklists') {
    const r = await db.get(
      `SELECT COALESCE(SUM(CASE WHEN status = 'done' AND completed_late = 0 THEN 1 ELSE 0 END),0) AS ok, COALESCE(SUM(CASE WHEN status IN ('done','missed') THEN 1 ELSE 0 END),0) AS n
       FROM checklist_occurrences WHERE practice_id = ? AND due_date >= ? AND due_date <= ?${locationId ? ' AND location_id = ?' : ''}`, pid, from, to, ...(locationId ? [locationId] : []),
    );
    return Number(r.n) ? Math.round((Number(r.ok) / Number(r.n)) * 1000) / 10 : null;
  }
  if (def.source === 'schedule') {
    const office = await officeOf(ctx, locationId);
    const provs = await db.all('SELECT * FROM providers WHERE practice_id = ? AND active = 1 ORDER BY id', pid);
    const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
    let available = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (!hoursFor(office, d).length) continue;
      for (const pv of provs) for (const [o, c] of (await providerHoursOn(db, office, pv, d)) || []) available += Math.max(0, toMin(c) - toMin(o));
    }
    const visits = await db.all(
      `SELECT start_time, end_time FROM appointments WHERE practice_id = ? AND start_time >= ? AND start_time < ? AND status NOT IN ('cancelled','no_show')${locationId ? ' AND location_id = ?' : ''}`,
      pid, `${from} 00:00`, `${to} 24:00`, ...(locationId ? [locationId] : []),
    );
    const booked = visits.reduce((t, v) => t + Math.max(0, (Date.parse(`${v.end_time.replace(' ', 'T')}:00Z`) - Date.parse(`${v.start_time.replace(' ', 'T')}:00Z`)) / 60000), 0);
    return available ? Math.round((booked / available) * 1000) / 10 : null;
  }
  if (def.source === 'otc') {
    const r = await db.get(
      `SELECT COALESCE(SUM(-l.amount),0) AS n FROM ledger_entries l WHERE l.practice_id = ? AND l.type = 'payment' AND l.voided_at IS NULL AND l.reverses_id IS NULL AND l.entry_date >= ? AND l.entry_date <= ?
         AND EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = l.patient_id AND a.status = 'completed' AND substr(a.start_time, 1, 10) = l.entry_date)${locationId ? ' AND l.location_id = ?' : ''}`,
      pid, from, to, ...(locationId ? [locationId] : []),
    );
    return Number(r.n);
  }
  if (def.source === 'txsched') {
    const [a, b] = await utcRange(db, pid, from, to);
    const r = await db.get(
      `SELECT COALESCE(SUM(pr.fee),0) AS n FROM procedures pr JOIN appointments ap ON ap.id = pr.appointment_id
       WHERE pr.practice_id = ? AND pr.status != 'cancelled' AND ap.status NOT IN ('cancelled','no_show') AND ap.created_at >= ? AND ap.created_at < ?
         AND substr(pr.created_at, 1, 10) < substr(ap.created_at, 1, 10)${locationId ? ' AND ap.location_id = ?' : ''}`,
      pid, a, b, ...(locationId ? [locationId] : []),
    );
    return Number(r.n);
  }
  return null;
}

// ---- Plans and versions ----
export const parseConfig = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
export async function versionFor(db, planId, date) {
  return db.get('SELECT * FROM bonus_plan_versions WHERE plan_id = ? AND effective_from <= ? ORDER BY effective_from DESC, version DESC LIMIT 1', planId, date);
}
export const versionById = (db, id) => db.get('SELECT * FROM bonus_plan_versions WHERE id = ?', id);

// ---- One plan's period, start to finish ----
// Returns the team numbers, each person's line (earned → cap → clawbacks → net) and notes. final: the period is
// over (approval, or the owner's review of a past period); clawbacks are only worked out for final reviews.
export async function reviewPeriod(ctx, plan, version, period, { final = null, clawbacks = true } = {}) {
  const cfg = parseConfig(version.config);
  const isFinal = final ?? period.end < ctx.today;
  const to = isFinal ? period.end : minDate(period.end, ctx.today);
  const ev = await ENGINES[plan.type](ctx, cfg, period, to, isFinal);
  const paid = ev.people.filter((p) => p.earned_cents > 0);
  const capped = applyCaps(paid.map((p) => p.earned_cents), cfg);
  paid.forEach((p, i) => { p.cap_cut_cents = p.earned_cents - capped[i]; });
  for (const p of ev.people) {
    p.cap_cut_cents ??= 0;
    p.clawback_cents = 0;
    p.clawbacks = [];
    p.still_owed_cents = 0;
    p.net_cents = p.earned_cents - p.cap_cut_cents;
    if (p.cap_cut_cents) p.detail.push(`${fmt(p.cap_cut_cents)} over the cap`);
  }
  if (isFinal && clawbacks && cfg.clawback_days > 0) {
    const owed = await owedFor(ctx, plan, period, cfg);
    for (const [uid, list] of owed) {
      let p = ev.people.find((x) => x.user_id === uid);
      if (!p) {
        const u = ctx.staff.find((s) => s.id === uid);
        p = { user_id: uid, name: u?.name || 'Unknown', role: u?.role || null, minutes: 0, earned_cents: 0, cap_cut_cents: 0, net_cents: 0, in_plan: false, eligible: false, why: 'Not in this plan now', detail: [] };
        ev.people.push(p);
      }
      const r = recover(p.net_cents, list);
      p.clawback_cents = r.taken;
      p.clawbacks = r.clawbacks;
      p.still_owed_cents = r.left;
      p.net_cents -= r.taken;
      for (const c of r.clawbacks) p.detail.push(`${fmt(c.cents)} taken back for ${c.period_start} (a charge voided or a payment refunded since it was approved)`);
      if (r.left) p.detail.push(`${fmt(r.left)} still to take back from a later bonus`);
    }
  }
  const lines = ev.people.filter((p) => p.earned_cents || p.clawback_cents || p.still_owed_cents || p.in_plan);
  const sum = (k) => lines.reduce((t, p) => t + (p[k] || 0), 0);
  const totals = { earned_cents: sum('earned_cents'), cap_cut_cents: sum('cap_cut_cents'), clawback_cents: sum('clawback_cents'), net_cents: sum('net_cents'), still_owed_cents: sum('still_owed_cents') };
  const out = {
    plan: { id: plan.id, name: plan.name, type: plan.type, status: plan.status }, version: { id: version.id, version: version.version, effective_from: version.effective_from },
    period, final: isFinal, through: to, config: cfg, team: ev.team, notes: ev.notes, totals,
    people: lines.map((p) => ({
      user_id: p.user_id, name: p.name, role: p.role, hours: Math.round((p.minutes / 60) * 100) / 100, in_plan: !!p.in_plan, eligible: !!p.eligible, why: p.why || null,
      earned_cents: p.earned_cents, cap_cut_cents: p.cap_cut_cents, clawback_cents: p.clawback_cents, still_owed_cents: p.still_owed_cents, net_cents: p.net_cents,
      clawbacks: p.clawbacks, detail: p.detail, ...(p.provider ? { provider: p.provider } : {}), ...(p.hits != null ? { hits: p.hits } : {}),
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
  out.hash = createHash('sha256').update(JSON.stringify({ team: out.team, people: out.people, totals })).digest('hex');
  return out;
}

// What each person still owes from earlier approved periods of this plan: recalculated now, compared with what was
// approved, minus what later bonuses already took back.
async function owedFor(ctx, plan, period, cfg) {
  const { db } = ctx;
  const since = addDays(period.start, -cfg.clawback_days);
  const prior = await db.all("SELECT * FROM bonus_approvals WHERE practice_id = ? AND plan_id = ? AND status = 'approved' AND period_start < ? AND period_end >= ? ORDER BY period_start", ctx.pid, plan.id, period.start, since);
  if (!prior.length) return new Map();
  const taken = new Map();
  for (const l of await db.all("SELECT l.user_id, l.clawbacks FROM bonus_payout_lines l JOIN bonus_approvals a ON a.id = l.approval_id WHERE a.plan_id = ? AND a.status = 'approved' AND l.clawbacks IS NOT NULL", plan.id)) {
    for (const c of JSON.parse(l.clawbacks || '[]')) taken.set(`${l.user_id}:${c.approval_id}`, (taken.get(`${l.user_id}:${c.approval_id}`) || 0) + c.cents);
  }
  const owed = new Map();
  for (const a of prior) {
    const v = await versionById(db, a.plan_version_id);
    const now = await reviewPeriod(ctx, plan, v, { start: a.period_start, end: a.period_end }, { final: true, clawbacks: false });
    const nowBy = new Map(now.people.map((p) => [p.user_id, p.earned_cents - p.cap_cut_cents]));
    for (const l of await db.all('SELECT * FROM bonus_payout_lines WHERE approval_id = ?', a.id)) {
      const then = l.earned_cents - l.cap_cut_cents;
      const short = Math.max(0, then - (nowBy.get(l.user_id) || 0)) - (taken.get(`${l.user_id}:${a.id}`) || 0);
      if (short > 0) {
        if (!owed.has(l.user_id)) owed.set(l.user_id, []);
        owed.get(l.user_id).push({ approval_id: a.id, period_start: a.period_start, cents: short });
      }
    }
  }
  return owed;
}

// ---- What a person may see ----
// Pace: where the team should be by now (open office days gone ÷ all open days in the period).
export async function paceOf(ctx, period, locationId, actual, target) {
  if (!target) return null;
  const all = await openDaysIn(ctx, period.start, period.end, locationId);
  const gone = all.filter((d) => d < ctx.today).length;
  if (!all.length || period.end < ctx.today) return { expected: target, status: actual >= target ? 'hit' : 'missed' };
  if (!gone) return { expected: 0, status: 'starting' };
  const expected = Math.round((target * gone) / all.length);
  return { expected, status: actual >= target ? 'hit' : actual >= expected ? 'on_pace' : 'behind' };
}

// A review cut down to what one person may see: the team's numbers (never pay), their own line, and everyone's
// lines only when the owner made the plan visible to the team. Providers' own production stays private too.
export function forViewer(review, userId, { manager = false } = {}) {
  const cfg = review.config;
  const me = review.people.find((p) => p.user_id === userId) || null;
  const visible = manager || cfg.team_visible;
  let team = review.team;
  if (team.kind === 'providers' && !visible) team = { ...team, providers: team.providers.filter((x) => x.user_id === userId) };
  // The labor cost behind a target is everyone's pay added up, and a plan's spiff total is other people's pay.
  if (!manager && 'labor_cents' in team) { team = { ...team }; delete team.labor_cents; }
  if (!visible && 'spiff_cents' in team) { team = { ...team }; delete team.spiff_cents; }
  return {
    plan: review.plan, period: review.period, through: review.through, final: review.final, team,
    me: me ? { in_plan: me.in_plan, eligible: me.eligible, why: me.why, hours: me.hours, earned_cents: me.earned_cents, net_cents: me.net_cents, detail: me.detail, ...(me.provider ? { provider: me.provider } : {}) } : null,
    ...(visible ? { people: review.people.map((p) => ({ user_id: p.user_id, name: p.name, eligible: p.eligible, why: p.why, earned_cents: p.earned_cents, net_cents: p.net_cents })) } : {}),
    team_visible: !!cfg.team_visible,
  };
}

