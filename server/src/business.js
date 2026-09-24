// The business view (PM1–PM4, BD1–BD4; docs/business-view.md, docs/workflows/specs/BV-business-view.md).
//
// Pure functions — no database — so the money math can be pinned to the cent by server/test/business.test.js:
//  - direct cost profiles per procedure code / category, versioned by date of service (resolveProfile);
//  - the contribution margin of a visit: expected collection (fee after the PPO write-off, insurance + the patient
//    portion expected to be collected) minus direct costs (supplies, lab, provider pay, card/financing fees), per
//    chair-hour and per doctor-hour, against the office's fixed cost per chair-hour → profit per hour (visitMargin);
//  - the color bands the owner sets (bandFor);
//  - labor cost so far and projected for the day, with overtime (laborDay);
//  - what each person on the clock is doing minute by minute (staffTimeline), idle gaps and suggestions;
//  - staffing vs demand by hour and overtime risk (staffingByHour, overtimeRisk);
//  - trend rows (trendRow) and "what if" arithmetic.
// Money is integer cents everywhere; percentages of money are basis points (1% = 100 bp) so they stay integers.
import { fitPattern, SLOT } from './patterns.js';

// ---- Rounding ----
// Half away from zero, so a negative margin rounds the same way as a positive one.
export const rnd = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));
export const bp = (amount, basisPoints) => rnd((amount * (basisPoints || 0)) / 10000);
export const perHour = (cents, minutes) => (minutes > 0 && cents != null ? rnd((cents * 60) / minutes) : null);
export const pct1 = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
export const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const toMin = (t) => Number(String(t).slice(-5, -3)) * 60 + Number(String(t).slice(-2));
export const clock12 = (m) => {
  const h = Math.floor(m / 60) % 24;
  return `${((h + 11) % 12) + 1}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
};

// ---- Defaults ----
export const CATEGORIES = ['diagnostic', 'preventive', 'restorative', 'endodontics', 'periodontics', 'prosthodontics', 'oral_surgery', 'orthodontics', 'implants', 'adjunctive'];
// What a procedure of each kind typically uses (US general practice, 2025–26): used until the owner enters their own
// costs, always labelled "typical" on screen. Lab: 'case' = the linked lab case's cost when there is one, else the estimate.
export const CATEGORY_DEFAULTS = {
  diagnostic: { supplies_cents: 300, lab_mode: 'none', lab_cents: 0 },
  preventive: { supplies_cents: 800, lab_mode: 'none', lab_cents: 0 },
  restorative: { supplies_cents: 2500, lab_mode: 'none', lab_cents: 0 },
  endodontics: { supplies_cents: 4500, lab_mode: 'none', lab_cents: 0 },
  periodontics: { supplies_cents: 1500, lab_mode: 'none', lab_cents: 0 },
  prosthodontics: { supplies_cents: 4000, lab_mode: 'case', lab_cents: 22500 },
  oral_surgery: { supplies_cents: 3000, lab_mode: 'none', lab_cents: 0 },
  orthodontics: { supplies_cents: 4000, lab_mode: 'case', lab_cents: 15000 },
  implants: { supplies_cents: 25000, lab_mode: 'case', lab_cents: 35000 },
  adjunctive: { supplies_cents: 500, lab_mode: 'none', lab_cents: 0 },
};
export const LAB_MODES = ['none', 'fixed', 'case'];
export const PAY_BASES = ['none', 'production_pct', 'collections_pct', 'hourly'];
export const PAY_BASIS_LABELS = { none: 'Not paid per visit (owner / salaried)', production_pct: '% of production (after PPO write-off)', collections_pct: '% of collections', hourly: 'Hourly (time clock rate × visit time)' };
// When the finance data can't say what a chair-hour costs, this typical figure is used (and labelled "typical").
export const TYPICAL_OVERHEAD_PER_CHAIR_HOUR = 18000;
export const TYPICAL_FIXED_COSTS_PER_DAY = 120000;

export const DEFAULT_SETTINGS = {
  basis: 'chair', // color by margin per chair-hour, or per doctor-hour
  overhead_mode: 'auto', // auto: from the finance module (QuickBooks / bank); manual: the owner's numbers
  overhead_per_hour_cents: null, // manual fixed cost per chair-hour (includes team wages)
  fixed_costs_month_cents: null, // manual fixed costs per month other than wages (rent, software, marketing…)
  work_days_month: 18,
  red_below_cents: null, // null: the fixed cost per chair-hour
  green_from_cents: null, // null: 1.5 × red_below
  gold_from_cents: null, // null: 2.5 × red_below
  labor_target_low_bp: 2500,
  labor_target_high_bp: 3000,
  patient_collect_bp: 10000, // share of patient portions expected to be collected
  default_merchant_bp: 250, // card fee on what patients pay, when a procedure's profile doesn't say
  assistants_per_doctor_chair_bp: 10000, // staffing rule of thumb: one assistant per busy doctor chair
  idle_gap_minutes: 20,
};

// ---- Cost profiles (PM1): versions by date of service ----
// profiles: rows { scope: 'code'|'category', scope_key, version_no, effective_from, active, supplies_cents, lab_mode,
// lab_cents, merchant_bp, pay_pct_bp }. The version in effect on `date` wins (latest effective_from, then version_no).
// A code's own profile beats its category's; a retired version (active = 0) means "no profile from this date".
export function versionOn(rows, date) {
  let best = null;
  for (const r of rows) {
    if (r.effective_from > date) continue;
    if (!best || r.effective_from > best.effective_from || (r.effective_from === best.effective_from && r.version_no > best.version_no)) best = r;
  }
  return best;
}
export function resolveProfile(profiles, { code, category }, date) {
  const pick = (scope, key) => versionOn(profiles.filter((p) => p.scope === scope && p.scope_key === key), date);
  const own = pick('code', code);
  if (own?.active) return { ...own, source: 'code' };
  const cat = pick('category', category);
  if (cat?.active) return { ...cat, source: 'category' };
  const d = CATEGORY_DEFAULTS[category] || CATEGORY_DEFAULTS.adjunctive;
  return { scope: 'default', scope_key: category, supplies_cents: d.supplies_cents, lab_mode: d.lab_mode, lab_cents: d.lab_cents, merchant_bp: null, pay_pct_bp: null, source: 'typical' };
}
// Provider pay plans, also versioned: { provider_id, basis, pct_bp, hourly_cents, lab_deducted, effective_from, version_no }.
export function resolvePay(plans, providerId, date) {
  const p = versionOn(plans.filter((x) => x.provider_id === providerId), date);
  return p ? { ...p } : { basis: 'none', pct_bp: 0, hourly_cents: null, lab_deducted: 0 };
}

// Suggested supplies per category from what the practice actually spent on supplies (finance module): the typical
// amounts scaled so that, over the procedures done in the same months, they add up to the real spend.
// counts: { category: procedures done }, spend: supply spend in cents over the same months.
export function suggestSupplies(counts, spend) {
  const modelled = Object.entries(counts).reduce((t, [c, n]) => t + (CATEGORY_DEFAULTS[c]?.supplies_cents || 0) * n, 0);
  const ratio = spend > 0 && modelled > 0 ? Math.min(4, Math.max(0.25, spend / modelled)) : 1;
  const out = {};
  for (const c of CATEGORIES) out[c] = { supplies_cents: rnd(CATEGORY_DEFAULTS[c].supplies_cents * ratio), lab_mode: CATEGORY_DEFAULTS[c].lab_mode, lab_cents: CATEGORY_DEFAULTS[c].lab_cents };
  return { ratio: Math.round(ratio * 100) / 100, basis: spend > 0 && modelled > 0 ? 'finance' : 'typical', categories: out };
}

// ---- Time in a visit ----
// Chair minutes: the whole visit. Doctor minutes: the pattern's X time (10-minute slots, fitted to the visit's
// length) for a dentist or specialist; hygiene visits have no doctor time of their own here.
export function visitMinutes({ start_time, end_time, pattern = null, provider_type = 'dentist' }) {
  const chair = Math.max(0, toMin(end_time) - toMin(start_time) + (end_time.slice(0, 10) > start_time.slice(0, 10) ? 1440 : 0));
  if (provider_type === 'hygienist') return { chair, doctor: 0, provider: chair, assistant: 0 };
  const fitted = pattern ? fitPattern(pattern, chair) : null;
  const doctor = fitted ? Math.min(chair, [...fitted].filter((c) => c === 'X').length * SLOT) : chair;
  return { chair, doctor, provider: doctor, assistant: chair - doctor };
}
// The minutes of the day the doctor is needed: [[start, end], ...].
export function doctorBusy({ start, end, pattern }) {
  if (!pattern) return [[start, end]];
  const fitted = fitPattern(pattern, end - start);
  const out = [];
  for (let i = 0; i < fitted.length && start + i * SLOT < end; i++) {
    if (fitted[i] !== 'X') continue;
    const a = start + i * SLOT;
    const b = Math.min(end, a + SLOT);
    if (out.length && out.at(-1)[1] === a) out.at(-1)[1] = b;
    else out.push([a, b]);
  }
  return out;
}

// Splits `total` across weights so the parts add up exactly (largest remainder).
export function allocate(total, weights) {
  const sum = weights.reduce((t, w) => t + Math.max(0, w), 0);
  if (!weights.length) return [];
  if (sum <= 0) {
    const out = weights.map(() => 0);
    out[0] = total;
    return out;
  }
  const raw = weights.map((w) => (total * Math.max(0, w)) / sum);
  const out = raw.map((x) => (total < 0 ? -Math.floor(-x) : Math.floor(x)));
  let left = total - out.reduce((t, x) => t + x, 0);
  const order = raw.map((x, i) => [Math.abs(x - out[i]), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left !== 0 && k < order.length * 2; k++) {
    const i = order[k % order.length][1];
    const step = left > 0 ? 1 : -1;
    out[i] += step;
    left -= step;
  }
  return out;
}

// ---- The margin of one visit (PM2) ----
// procedures: [{ id, code, description, category, fee, write_off, insurance, patient?, profile, lab_case_cents? }]
//   write_off / insurance from the insurance estimate (the PPO's allowed fee; no insurance: write_off 0, insurance 0).
// minutes: { chair, doctor, provider } (visitMinutes). pay: resolvePay(). hourlyRate: the provider's time-clock rate
// (cents/hour) when pay.hourly_cents isn't set. settings: DEFAULT_SETTINGS-like. overheadPerHour: fixed cost per chair-hour.
export function visitMargin({ procedures, minutes, pay = { basis: 'none' }, hourlyRate = null, settings = DEFAULT_SETTINGS, overheadPerHour = null, providerType = 'dentist' }) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const notes = [];
  const lines = procedures.map((p) => {
    const fee = p.fee || 0;
    const writeOff = Math.max(0, Math.min(fee, p.write_off || 0));
    const allowed = fee - writeOff;
    const insurance = Math.max(0, Math.min(allowed, p.insurance || 0));
    const patient = p.patient != null ? Math.max(0, Math.min(allowed - insurance, p.patient)) : allowed - insurance;
    const patientExpected = bp(patient, s.patient_collect_bp);
    const expected = insurance + patientExpected;
    const prof = p.profile || {};
    let lab = 0;
    let labSource = null;
    if (p.lab_case_cents != null) { lab = p.lab_case_cents; labSource = 'case'; }
    else if (prof.lab_mode && prof.lab_mode !== 'none') { lab = prof.lab_cents || 0; labSource = prof.lab_mode === 'case' ? 'estimate' : 'fixed'; }
    const supplies = prof.supplies_cents || 0;
    const merchant = bp(patientExpected, prof.merchant_bp ?? s.default_merchant_bp);
    let payCents = 0;
    if (pay.basis === 'production_pct' || pay.basis === 'collections_pct') {
      const pctBp = prof.pay_pct_bp ?? pay.pct_bp ?? 0;
      let base = pay.basis === 'production_pct' ? allowed : expected;
      if (pay.lab_deducted) base -= lab;
      payCents = Math.max(0, bp(base, pctBp));
    }
    return {
      procedure_id: p.id ?? null, code: p.code, description: p.description ?? null, category: p.category, fee, write_off: writeOff, allowed, insurance,
      patient, patient_expected: patientExpected, uncollected: patient - patientExpected, expected, lab, lab_source: labSource, supplies, merchant, pay: payCents,
      profile_source: prof.source || null,
    };
  });
  // Hourly pay belongs to the visit (their time in it), shared across its procedures by allowed fee.
  let hourlyPay = 0;
  if (pay.basis === 'hourly') {
    const rate = pay.hourly_cents ?? hourlyRate;
    if (rate == null) notes.push('No hourly rate for this provider: their pay isn’t counted');
    else hourlyPay = rnd((rate * (minutes.provider ?? minutes.chair)) / 60);
    const parts = allocate(hourlyPay, lines.map((l) => l.allowed || 1));
    lines.forEach((l, i) => { l.pay += parts[i] || 0; });
  }
  for (const l of lines) {
    l.costs = l.lab + l.supplies + l.merchant + l.pay;
    l.margin = l.expected - l.costs;
  }
  const sum = (k) => lines.reduce((t, l) => t + l[k], 0);
  const out = {
    lines, fee: sum('fee'), write_off: sum('write_off'), allowed: sum('allowed'), insurance: sum('insurance'), patient: sum('patient'),
    patient_expected: sum('patient_expected'), uncollected: sum('uncollected'), expected: sum('expected'),
    lab: sum('lab'), supplies: sum('supplies'), merchant: sum('merchant'), pay: sum('pay'), costs: sum('costs'), margin: sum('margin'),
    pay_basis: pay.basis, hourly_pay: hourlyPay,
    chair_minutes: minutes.chair, doctor_minutes: providerType === 'hygienist' ? 0 : minutes.doctor,
    typical_costs: lines.some((l) => l.profile_source === 'typical'), notes,
  };
  out.margin_per_chair_hour = perHour(out.margin, out.chair_minutes);
  out.margin_per_doctor_hour = out.doctor_minutes > 0 ? perHour(out.margin, out.doctor_minutes) : null;
  out.overhead = overheadPerHour != null ? rnd((overheadPerHour * out.chair_minutes) / 60) : null;
  out.profit = out.overhead != null ? out.margin - out.overhead : null;
  out.profit_per_hour = out.profit != null ? perHour(out.profit, out.chair_minutes) : null;
  if (!lines.length) notes.push('No procedures on this visit yet');
  return out;
}

// Adds margins up (a column, a day, a report row). Per-hour figures are recomputed from the totals.
export function addUp(list) {
  const t = { visits: 0, fee: 0, write_off: 0, allowed: 0, insurance: 0, patient: 0, expected: 0, lab: 0, supplies: 0, merchant: 0, pay: 0, costs: 0, margin: 0, overhead: 0, profit: 0, chair_minutes: 0, doctor_minutes: 0 };
  let haveOverhead = list.length > 0;
  for (const m of list) {
    t.visits += 1;
    for (const k of ['fee', 'write_off', 'allowed', 'insurance', 'patient', 'expected', 'lab', 'supplies', 'merchant', 'pay', 'costs', 'margin', 'chair_minutes', 'doctor_minutes']) t[k] += m[k] || 0;
    if (m.overhead == null) haveOverhead = false;
    else { t.overhead += m.overhead; t.profit += m.profit; }
  }
  if (!haveOverhead) { t.overhead = null; t.profit = null; }
  t.margin_per_chair_hour = perHour(t.margin, t.chair_minutes);
  t.margin_per_doctor_hour = t.doctor_minutes > 0 ? perHour(t.margin, t.doctor_minutes) : null;
  t.profit_per_hour = t.profit != null ? perHour(t.profit, t.chair_minutes) : null;
  return t;
}

// ---- Bands (PM3) ----
export function thresholdsFor(settings, overheadPerHour) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const red = s.red_below_cents ?? overheadPerHour ?? TYPICAL_OVERHEAD_PER_CHAIR_HOUR;
  const green = Math.max(red, s.green_from_cents ?? rnd(red * 1.5));
  const gold = Math.max(green, s.gold_from_cents ?? rnd(red * 2.5));
  return { red_below: red, green_from: green, gold_from: gold };
}
export function bandFor(value, t) {
  if (value == null) return 'none';
  if (value < t.red_below) return 'red';
  if (value < t.green_from) return 'amber';
  if (value < t.gold_from) return 'green';
  return 'gold';
}
// The per-hour figure the colors use: per chair-hour, or per doctor-hour (hygiene visits fall back to chair-hours).
export const bandValue = (m, basis) => (basis === 'doctor' ? m.margin_per_doctor_hour ?? m.margin_per_chair_hour : m.margin_per_chair_hour);
export const BAND_LABELS = { red: 'Below fixed costs', amber: 'Covers costs', green: 'Good', gold: 'Excellent', none: 'No time on the visit' };

// ---- Labor (BD1) ----
export const laborCost = (m, rate) => (rate == null ? null : rnd((((m.regular || 0) + (m.overtime || 0) * 1.5 + (m.doubletime || 0) * 2) * rate) / 60));
// Overtime premium only: the extra half (overtime) or whole (double time) over the regular rate.
export const overtimePremium = (m, rate) => (rate == null ? null : rnd((((m.overtime || 0) * 0.5 + (m.doubletime || 0)) * rate) / 60));

// Classifies `length` more minutes worked today, starting after `todayBefore` minutes already worked today, in a week
// with `weekRegularBefore` regular minutes so far — the same rules as the payroll (timeclock.js classifyPunches):
// daily overtime / double time first, then the weekly 40 on what's still regular (no pyramiding).
export function splitSegment(length, { todayBefore = 0, weekRegularBefore = 0, settings = {}, exempt = false } = {}) {
  const out = { regular: 0, overtime: 0, doubletime: 0 };
  if (length <= 0) return out;
  if (exempt) { out.regular = length; return out; }
  const s = { ot_weekly: 1, ot_weekly_minutes: 2400, ot_daily: 0, ot_daily_minutes: 480, dt_daily: 0, dt_daily_minutes: 720, ...settings };
  const dt = s.dt_daily ? s.dt_daily_minutes : Infinity;
  const ot = s.ot_daily ? Math.min(s.ot_daily_minutes, dt) : dt;
  const from = todayBefore;
  const to = todayBefore + length;
  const span = (lo, hi) => Math.max(0, Math.min(to, hi) - Math.max(from, lo));
  out.regular = span(0, ot);
  out.overtime = span(ot, dt);
  out.doubletime = span(dt, Infinity);
  if (s.ot_weekly) {
    const room = Math.max(0, s.ot_weekly_minutes - weekRegularBefore);
    const keep = Math.min(out.regular, room);
    out.overtime += out.regular - keep;
    out.regular = keep;
  }
  return out;
}
const addM = (a, b) => ({ regular: a.regular + b.regular, overtime: a.overtime + b.overtime, doubletime: a.doubletime + b.doubletime });
const minutesOf = (m) => m.regular + m.overtime + m.doubletime;

// One person's labor for the day. closedToday: today's closed punches already classified by the payroll rules
// ({ regular, overtime, doubletime }); running: minutes on an open punch so far; remaining: minutes still to work on
// today's shift after now; weekRegularBefore: regular minutes in this workweek from closed punches before today.
export function laborDay({ closedToday = { regular: 0, overtime: 0, doubletime: 0 }, running = 0, remaining = 0, weekRegularBefore = 0, settings = {}, exempt = false, rate = null }) {
  const closedMin = minutesOf(closedToday);
  const runningSplit = splitSegment(running, { todayBefore: closedMin, weekRegularBefore: weekRegularBefore + closedToday.regular, settings, exempt });
  const soFar = addM(closedToday, runningSplit);
  const restSplit = splitSegment(remaining, { todayBefore: closedMin + running, weekRegularBefore: weekRegularBefore + soFar.regular, settings, exempt });
  const projected = addM(soFar, restSplit);
  return {
    so_far: { ...soFar, minutes: minutesOf(soFar), cost: laborCost(soFar, rate), overtime_premium: overtimePremium(soFar, rate) },
    projected: { ...projected, minutes: minutesOf(projected), cost: laborCost(projected, rate), overtime_premium: overtimePremium(projected, rate) },
  };
}

// ---- What everyone is doing, minute by minute (BD2) ----
// people: [{ user_id, name, kind: 'doctor'|'hygienist'|'assistant'|'admin', provider_ids: [], operatory_ids: [], pooled,
//   shift: { start, end, break_minutes } | null (minutes of the day), punches: [{ in, out|null }], breaks: [{ start, end|null, paid }],
//   left: true when they clocked out for the day; back_at: minute they're expected back (clocked out for lunch) }]
// visits: [{ id, provider_id, operatory_id, start, end, pattern, provider_kind: 'doctor'|'hygiene', production }]
// now: minute of the day (1440 for a past day, -1 for a future day). Minutes before `now` are what happened (punches);
// minutes from `now` on are the plan (shifts).
export const STATES = ['in_visit', 'assisting', 'admin', 'break', 'idle', 'absent', 'off'];
export const STATE_LABELS = { in_visit: 'With a patient', assisting: 'Assisting', admin: 'Front office / admin', break: 'Break', idle: 'Idle (on the clock, nothing scheduled)', absent: 'Scheduled, not clocked in', off: 'Off' };
export function staffTimeline({ people, visits, now, dayStart = 0, dayEnd = 1440, idleGap = 20 }) {
  const within = (m, a, b) => m >= a && m < (b ?? Infinity);
  const docBusy = new Map(visits.map((v) => [v.id, v.provider_kind === 'doctor' ? doctorBusy(v) : [[v.start, v.end]]]));
  const covers = (v, m) => m >= v.start && m < v.end;
  const perMin = new Map(visits.map((v) => [v.id, v.end > v.start ? (v.production || 0) / (v.end - v.start) : 0]));
  const rows = people.map((p) => ({ p, states: [], visitAt: [] }));
  for (let m = dayStart; m < dayEnd; m++) {
    const past = m < now;
    const pooled = [];
    const covered = new Set(); // doctor visits a linked assistant already covers this minute
    for (const r of rows) {
      const p = r.p;
      const inShift = p.shift && within(m, p.shift.start, p.shift.end);
      const punchedIn = (p.punches || []).some((x) => within(m, x.in, x.out ?? (past ? now : Infinity)));
      const onBreak = (p.breaks || []).some((b) => within(m, b.start, b.end ?? (past ? now : Infinity)));
      const open = (p.punches || []).some((x) => x.out == null);
      // Past: the punches. Ahead: someone on the clock stays until their shift ends (to the end of the day with no
      // shift); someone not in yet is expected for their shift, unless they already clocked out for the day.
      const working = past ? punchedIn : open ? (p.shift ? inShift : m >= Math.min(...p.punches.filter((x) => x.out == null).map((x) => x.in))) : !!inShift && !p.left && m >= (p.back_at ?? 0);
      let state;
      let visit = null;
      if (past && !punchedIn) state = inShift ? 'absent' : 'off';
      else if (!working) state = 'off';
      else if (onBreak) state = 'break';
      else if (p.kind === 'admin') state = 'admin';
      else if (p.kind === 'doctor' || p.kind === 'hygienist') {
        const v = visits.find((x) => p.provider_ids.includes(x.provider_id) && covers(x, m) && docBusy.get(x.id).some(([a, b]) => m >= a && m < b));
        if (v) { state = 'in_visit'; visit = v.id; } else state = 'idle';
      } else if (p.kind === 'assistant' && !p.pooled) {
        const v = visits.find((x) => covers(x, m) && (p.provider_ids.includes(x.provider_id) || p.operatory_ids.includes(x.operatory_id)));
        if (v) { state = 'assisting'; visit = v.id; covered.add(v.id); } else state = 'idle';
      } else { state = 'idle'; pooled.push(r); }
      r.states[m - dayStart] = state;
      r.visitAt[m - dayStart] = visit;
    }
    if (pooled.length) {
      // Shared assistants: each busy doctor chair not already covered takes one, in the order they came in.
      const demand = visits.filter((v) => v.provider_kind === 'doctor' && covers(v, m) && !covered.has(v.id)).sort((a, b) => a.start - b.start || a.id - b.id);
      pooled.sort((a, b) => firstIn(a.p) - firstIn(b.p) || a.p.user_id - b.p.user_id);
      pooled.forEach((r, i) => {
        if (i < demand.length) { r.states[m - dayStart] = 'assisting'; r.visitAt[m - dayStart] = demand[i].id; }
      });
    }
  }
  return rows.map(({ p, states, visitAt }) => {
    const segments = [];
    for (let i = 0; i < states.length; i++) {
      const m = dayStart + i;
      const planned = m >= now;
      const last = segments.at(-1);
      if (last && last.state === states[i] && last.visit_id === visitAt[i] && last.planned === planned) last.end = m + 1;
      else segments.push({ start: m, end: m + 1, state: states[i], visit_id: visitAt[i], planned });
    }
    const tally = (pred) => states.reduce((t, st, i) => t + (pred(st, dayStart + i) ? 1 : 0), 0);
    const clinical = p.kind !== 'admin';
    const paidBreak = (m) => (p.breaks || []).some((b) => b.paid && within(m, b.start, b.end ?? (m < now ? now : Infinity)));
    const totals = (range) => {
      const inR = (m) => (range === 'so_far' ? m < now : true);
      const working = tally((st, m) => inR(m) && ['in_visit', 'assisting', 'admin', 'idle'].includes(st));
      const paid = working + tally((st, m) => inR(m) && st === 'break' && paidBreak(m));
      const productive = tally((st, m) => inR(m) && (st === 'in_visit' || st === 'assisting'));
      const idle = tally((st, m) => inR(m) && st === 'idle');
      let supported = 0;
      states.forEach((st, i) => { if (inR(dayStart + i) && visitAt[i] != null) supported += perMin.get(visitAt[i]) || 0; });
      return {
        paid_minutes: paid, working_minutes: working, productive_minutes: productive, idle_minutes: idle,
        admin_minutes: tally((st, m) => inR(m) && st === 'admin'), break_minutes: tally((st, m) => inR(m) && st === 'break'),
        absent_minutes: tally((st, m) => inR(m) && st === 'absent'),
        productivity_pct: clinical ? pct1(productive, working) : null,
        production_supported: rnd(supported),
        production_per_labor_hour: clinical ? perHour(rnd(supported), paid) : null,
      };
    };
    const gaps = segments.filter((g) => g.state === 'idle' && g.end - g.start >= idleGap).map((g) => ({ start: g.start, end: g.end, minutes: g.end - g.start, planned: g.planned }));
    // Idle stretches that cross "now" come out as two segments; join them for the gap list.
    const joined = [];
    for (const g of gaps) {
      const last = joined.at(-1);
      if (last && last.end === g.start) { last.end = g.end; last.minutes += g.minutes; last.planned = last.planned && g.planned; }
      else joined.push({ ...g });
    }
    // Two halves of one gap may each be under the limit; look again at the whole idle run.
    const allIdle = [];
    for (const g of segments.filter((x) => x.state === 'idle')) {
      const last = allIdle.at(-1);
      if (last && last.end === g.start) { last.end = g.end; last.planned = last.planned && g.planned; last.partlyPlanned ||= g.planned; }
      else allIdle.push({ start: g.start, end: g.end, planned: g.planned, partlyPlanned: g.planned });
    }
    const idleGaps = allIdle.filter((g) => g.end - g.start >= idleGap).map((g) => ({ start: g.start, end: g.end, minutes: g.end - g.start, planned: g.planned, upcoming: g.partlyPlanned }));
    return { user_id: p.user_id, name: p.name, kind: p.kind, pooled: !!p.pooled, segments, so_far: totals('so_far'), day: totals('day'), gaps: idleGaps };
  });
}
const firstIn = (p) => Math.min(...(p.punches || []).map((x) => x.in), p.shift?.start ?? 1440);

// What to do about an idle stretch that's still ahead. ctx: { asapCount, rate (cents/h or null), person }.
export function suggestionsFor(gap, { person, asapCount = 0, rate = null }) {
  if (!gap.upcoming) return [];
  const first = String(person.name || '').replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?)\s+/i, '').split(/[\s,]+/)[0];
  const out = [];
  const from = Math.max(gap.start, gap.nowMin ?? gap.start);
  const cost = rate != null ? rnd((rate * (gap.end - from)) / 60) : null;
  // Filling the time is about a provider's chair; an idle assistant is a staffing question (home early, lunch).
  if ((person.kind === 'doctor' || person.kind === 'hygienist') && asapCount > 0) {
    out.push({ kind: 'fill', text: `Fill ${clock12(from)}–${clock12(gap.end)} from the ASAP list (${asapCount} waiting)` });
  }
  if (person.shift && gap.end >= person.shift.end - 5 && person.kind !== 'doctor') {
    out.push({ kind: 'send_home', text: `Send ${first} home at ${clock12(from)}${cost != null ? ` — saves about $${Math.round(cost / 100)}` : ''}`, saves: cost });
  }
  const midday = gap.start < 14 * 60 + 30 && gap.end > 11 * 60;
  if (midday && person.shift?.break_minutes > 0 && gap.end - from >= person.shift.break_minutes && person.kind !== 'admin') {
    out.push({ kind: 'move_lunch', text: `Move ${first}’s lunch to ${clock12(from)}–${clock12(from + person.shift.break_minutes)}` });
  }
  if (!out.length && person.kind === 'assistant') out.push({ kind: 'other', text: `${first} is free ${clock12(from)}–${clock12(gap.end)}: recall calls, sterilization, restock` });
  return out;
}

// ---- Staffing vs demand by hour (BD3) ----
// timeline: staffTimeline() output (with kind). visits: the day's live visits. Returns one row per hour.
export function staffingByHour({ timeline, visits, dayStart, dayEnd, assistantsPerChairBp = 10000 }) {
  const rows = [];
  for (let h = Math.floor(dayStart / 60) * 60; h < dayEnd; h += 60) {
    const from = Math.max(h, dayStart);
    const to = Math.min(h + 60, dayEnd);
    const len = to - from;
    if (len <= 0) continue;
    const busy = (kind) => visits.filter((v) => v.provider_kind === kind).reduce((t, v) => t + Math.max(0, Math.min(v.end, to) - Math.max(v.start, from)), 0) / len;
    const on = (kinds) => timeline.filter((t) => kinds.includes(t.kind)).reduce((sum, t) => sum + t.segments.reduce((x, g) => x + (['in_visit', 'assisting', 'admin', 'idle'].includes(g.state) ? Math.max(0, Math.min(g.end, to) - Math.max(g.start, from)) : 0), 0), 0) / len;
    const idle = timeline.reduce((sum, t) => sum + t.segments.reduce((x, g) => x + (g.state === 'idle' ? Math.max(0, Math.min(g.end, to) - Math.max(g.start, from)) : 0), 0), 0);
    const doctorChairs = busy('doctor');
    const hygieneChairs = busy('hygiene');
    const assistants = on(['assistant']);
    const needed = (doctorChairs * assistantsPerChairBp) / 10000;
    const diff = assistants - needed;
    rows.push({
      hour: h, from, to, doctor_chairs: r1(doctorChairs), hygiene_chairs: r1(hygieneChairs), doctors: r1(on(['doctor'])), hygienists: r1(on(['hygienist'])),
      assistants: r1(assistants), admin: r1(on(['admin'])), assistants_needed: r1(needed), idle_minutes: idle,
      status: diff >= 1 ? 'over' : diff <= -1 ? 'under' : 'ok',
    });
  }
  return rows;
}
const r1 = (x) => Math.round(x * 10) / 10;
const count = (x, one, many) => `${x} ${x === 1 ? one : many}`;
// Consecutive hours with the same problem become one plain-language recommendation.
export function staffingAdvice(rows) {
  const out = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    const a = Math.round(run.assistants);
    const c = Math.round(run.chairs);
    if (run.status === 'over') {
      out.push({ status: 'over', from: run.from, to: run.to, text: `${count(a, 'assistant', 'assistants')} for ${c ? count(c, 'doctor chair', 'doctor chairs') : 'no doctor patients'} from ${clock12(run.from)}–${clock12(run.to)}: someone could take lunch then, make recall calls, or go home early.` });
    } else {
      out.push({ status: 'under', from: run.from, to: run.to, text: `${count(a, 'assistant', 'assistants')} for ${count(c, 'doctor chair', 'doctor chairs')} from ${clock12(run.from)}–${clock12(run.to)}: the doctor will be waiting — move a lunch, or borrow help from hygiene or the front.` });
    }
    run = null;
  };
  for (const r of rows) {
    if (r.status === 'ok') { flush(); continue; }
    if (run && run.status === r.status && run.to === r.from) {
      run.to = r.to;
      run.assistants = Math.max(run.assistants, r.assistants);
      run.chairs = r.status === 'over' ? Math.min(run.chairs, r.doctor_chairs) : Math.max(run.chairs, r.doctor_chairs);
    } else {
      flush();
      run = { status: r.status, from: r.from, to: r.to, assistants: r.assistants, chairs: r.doctor_chairs };
    }
  }
  flush();
  return out;
}

// Will someone go into overtime today? weekMinutes: worked this week so far (incl. today); remaining: minutes still to
// work today; todayMinutes: worked today so far. Returns null or { at (minute of day), minutes, premium, kind }.
export function overtimeRisk({ nowMin, weekMinutes, todayMinutes, remaining, settings = {}, exempt = false, rate = null }) {
  if (exempt || remaining <= 0) return null;
  const s = { ot_weekly: 1, ot_weekly_minutes: 2400, ot_daily: 0, ot_daily_minutes: 480, ...settings };
  const cands = [];
  if (s.ot_weekly && weekMinutes + remaining > s.ot_weekly_minutes) cands.push({ kind: 'weekly', left: Math.max(0, s.ot_weekly_minutes - weekMinutes), over: weekMinutes + remaining - Math.max(s.ot_weekly_minutes, weekMinutes) });
  if (s.ot_daily && todayMinutes + remaining > s.ot_daily_minutes) cands.push({ kind: 'daily', left: Math.max(0, s.ot_daily_minutes - todayMinutes), over: todayMinutes + remaining - Math.max(s.ot_daily_minutes, todayMinutes) });
  if (!cands.length) return null;
  const c = cands.sort((a, b) => a.left - b.left)[0];
  const minutes = Math.min(remaining, Math.max(...cands.map((x) => x.over)));
  return { kind: c.kind, at: nowMin + c.left, minutes, premium: rate != null ? rnd((minutes * 0.5 * rate) / 60) : null };
}

// ---- Trends (BD4) ----
// One period's numbers → the derived figures (docs/metrics.md, "Labor and the business of the day").
export function trendRow(x) {
  return {
    ...x,
    labor_pct_production: x.labor_cost != null ? pct1(x.labor_cost, x.production) : null,
    labor_pct_collections: x.labor_cost != null ? pct1(x.labor_cost, x.collections) : null,
    production_per_labor_hour: perHour(x.production, x.paid_minutes),
    productivity_pct: pct1(x.productive_minutes, x.clinical_minutes),
    idle_hours: Math.round((x.idle_minutes / 60) * 10) / 10,
  };
}

// ---- Exams and the production they predict (EX1–EX3) ----
// Types and codes as the diagnosis module (diagnosis.js / metrics.js examsForDay) defines them; this fallback is
// used only until that is merged, and adds perio evaluations (D0180) as their own type.
export const EXAM_TYPE_LABELS = { new_patient: 'New patient', recall: 'Recall / periodic', emergency: 'Emergency / limited', perio: 'Perio' };
export const FALLBACK_EXAM_CODES = { D0150: 'new_patient', D0120: 'recall', D0145: 'recall', D0180: 'perio', D0140: 'emergency', D0160: 'emergency', D0170: 'emergency', D9110: 'emergency' };
// What an exam typically leads to (treatment diagnosed and done) within 1, 3 and 5 months, until the practice's own
// history (or the owner's numbers) says otherwise. Always labelled "typical".
const EXAM_SHORT = { new_patient: 'new patient', recall: 'recall', emergency: 'emergency', perio: 'perio' };
export const EXAM_HORIZONS = [1, 3, 5];
export const TYPICAL_EXAM_VALUES = {
  1: { new_patient: 60000, recall: 15000, emergency: 60000, perio: 25000 },
  3: { new_patient: 110000, recall: 30000, emergency: 80000, perio: 45000 },
  5: { new_patient: 140000, recall: 40000, emergency: 90000, perio: 55000 },
};
// An owner's own value is for 5 months; for a shorter horizon it's scaled like the typical values.
export const scaleExamValue = (type, value5, horizon) => (horizon === 5 || !TYPICAL_EXAM_VALUES[5][type] ? value5 : rnd((value5 * TYPICAL_EXAM_VALUES[horizon][type]) / TYPICAL_EXAM_VALUES[5][type]));
const EXAM_PRECEDENCE = ['new_patient', 'perio', 'recall', 'emergency'];
// One exam per patient per day (the highest-precedence code wins). rows: [{ patient_id, date, code }].
export function countExams(rows, codes = FALLBACK_EXAM_CODES) {
  const best = new Map();
  for (const r of rows) {
    const t = codes[r.code];
    if (!t) continue;
    const k = `${r.patient_id}|${r.date}`;
    const had = best.get(k);
    if (!had || EXAM_PRECEDENCE.indexOf(t) < EXAM_PRECEDENCE.indexOf(had)) best.set(k, t);
  }
  const out = {};
  for (const t of best.values()) out[t] = (out[t] || 0) + 1;
  return out;
}
// Today's exams against the owner's daily target per type.
export function examTargets(counts, targets = {}) {
  const types = [...new Set([...Object.keys(EXAM_TYPE_LABELS), ...Object.keys(counts), ...Object.keys(targets)])];
  return types.map((t) => {
    const count = counts[t] || 0;
    const target = targets[t] ?? null;
    return { type: t, label: EXAM_TYPE_LABELS[t] || t, count, target, status: target == null || target === 0 ? null : count >= target ? 'met' : 'short', short_by: target ? Math.max(0, target - count) : 0 };
  });
}
export const moneyShort = (c) => {
  const d = Math.round((c || 0) / 100);
  if (Math.abs(d) >= 10000) return `$${Math.round(d / 1000).toLocaleString('en-US')}k`;
  return `$${d.toLocaleString('en-US')}`;
};
// Exams × what each type is worth over the horizon (1, 3 or 5 months) = the future production they support. It is
// compared with the production goal for the matching coming months, taken at the period's share: a month of exams
// against a month's share of the next five months' goal (in a steady state each month's exams feed the months that
// follow, and the cohorts overlap, so one period's exams × value is comparable with one period's worth of goal).
// counts: { type: n }, values: { type: cents }, goal: cents or null, label: 'This month's'.
export function examSupport({ counts, values, goal = null, label = 'These' }) {
  const byType = Object.keys({ ...values, ...counts }).map((t) => {
    const count = counts[t] || 0;
    const value = values[t] ?? 0;
    return { type: t, label: EXAM_TYPE_LABELS[t] || t, count, value, supported: count * value };
  });
  const supported = byType.reduce((t, x) => t + x.supported, 0);
  const shortfall = goal != null ? Math.max(0, goal - supported) : null;
  // The levers are the exams a practice can book more of (new patients, recall); emergencies come as they come.
  const lever = (t) => (t === 'new_patient' || t === 'recall' ? 0 : 1);
  const options = shortfall ? byType.filter((x) => x.value > 0).sort((a, b) => lever(a.type) - lever(b.type) || b.value - a.value).slice(0, 2).map((x) => ({ type: x.type, label: x.label, value: x.value, needed: Math.ceil(shortfall / x.value) })) : [];
  let text = `${label} exams support about ${moneyShort(supported)}`;
  if (goal == null) text += ' of future production.';
  else if (!shortfall) text += ` of future production — at or above the ${moneyShort(goal)} goal.`;
  else text += ` of the ${moneyShort(goal)} goal${options.length ? `: add ${options.map((o) => `~${o.needed} ${EXAM_SHORT[o.type] || o.label.toLowerCase()} exam${o.needed === 1 ? '' : 's'}`).join(' or ')}` : ''}.`;
  return { supported, goal, pct: goal ? pct1(supported, goal) : null, shortfall, by_type: byType, options, text };
}

// ---- What if (PM4) ----
// A fee change: office fee × (1 + pctBp). A PPO patient's collection is capped at the plan's allowed fee, so raising
// the office fee only helps where the allowed fee was the office fee (no insurance, or a plan paying at or above it).
// rows: [{ fee, allowed, ppo_allowed|null, count }] → { before, after, change } in expected collection.
export function whatIfFee(rows, pctBp) {
  let before = 0;
  let after = 0;
  for (const r of rows) {
    const newFee = r.fee + bp(r.fee, pctBp);
    const newAllowed = r.ppo_allowed != null ? Math.min(newFee, r.ppo_allowed) : newFee;
    before += r.allowed;
    after += newAllowed;
  }
  return { before, after, change: after - before };
}
// Dropping a plan: `retention`% of its patients stay and pay the office fee (no write-off); the rest leave, and
// `refill`% of the chair time they used is filled at the rest of the practice's margin per hour.
export function whatIfDropPlan({ plan, others, retentionPct = 70, refillPct = 50 }) {
  const keep = retentionPct / 100;
  const recaptured = rnd(plan.write_off * keep);
  const lostMargin = rnd(plan.margin * (1 - keep));
  const freedMinutes = plan.chair_minutes * (1 - keep);
  const otherRate = others.chair_minutes > 0 ? others.margin / others.chair_minutes : 0;
  const refilled = rnd(freedMinutes * (refillPct / 100) * otherRate);
  return { recaptured_write_offs: recaptured, lost_margin: lostMargin, refilled_margin: refilled, change: recaptured - lostMargin + refilled, freed_hours: Math.round((freedMinutes / 60) * 10) / 10 };
}
