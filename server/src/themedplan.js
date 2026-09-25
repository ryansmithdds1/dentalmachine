// The themed demo practice, planned in memory (themeddemo.js writes it). A pure function of (size, anchor day):
// the same inputs give exactly the same patients, visits, procedures, claims and money, so a seed that stops
// part-way (a serverless time limit) can rebuild the plan and carry on where it left off without duplicating
// anything. Money follows the ledger rules: integer cents, every balance is the sum of its entries, corrections
// are voids with a reversing entry and refunds are their own entries.
import { DEFAULT_CODES } from './defaults.js';
import * as D from './themeddata.js';

export const SIZES = {
  small: { patients: 200, months: 6, futureDays: 21, batch: 60 },
  medium: { patients: 1000, months: 12, futureDays: 42, batch: 80 },
  large: { patients: 3000, months: 24, futureDays: 42, batch: 80 },
};

// ---- Days ----
const DAY = 86400000;
export const dn = (s) => Math.floor(Date.parse(`${s}T12:00:00Z`) / DAY);
export const ds = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const weekday = (n) => (n + 4) % 7; // day 0 (1970-01-01) was a Thursday
export const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const addMonthsN = (n, months) => {
  const d = new Date(n * DAY);
  d.setUTCMonth(d.getUTCMonth() + months);
  return Math.floor(d.getTime() / DAY);
};
function isHoliday(n) {
  const s = ds(n).slice(5);
  if (['01-01', '07-04', '12-24', '12-25', '12-31'].includes(s)) return true;
  const d = new Date(n * DAY);
  // Thanksgiving (fourth Thursday of November) and Labor Day (first Monday of September).
  if (d.getUTCMonth() === 10 && weekday(n) === 4 && d.getUTCDate() >= 22 && d.getUTCDate() <= 28) return true;
  if (d.getUTCMonth() === 8 && weekday(n) === 1 && d.getUTCDate() <= 7) return true;
  return false;
}
export const isWorkday = (n) => weekday(n) >= 1 && weekday(n) <= 5 && !isHoliday(n);
const nextWorkday = (n) => { while (!isWorkday(n)) n++; return n; };

// ---- Deterministic randomness ----
export function rng(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.chance = (p) => r() < p;
  r.weighted = (items, w) => {
    const total = items.reduce((s, x) => s + w(x), 0);
    let k = r() * total;
    for (const x of items) { k -= w(x); if (k < 0) return x; }
    return items[items.length - 1];
  };
  return r;
}

// ---- Codes and fees ----
export const CODES = Object.fromEntries(DEFAULT_CODES.map(([code, description, category, fee]) => [code, { code, description, category, fee }]));
const tierOf = (category) => (['diagnostic', 'preventive'].includes(category) ? 'preventive' : ['prosthodontics', 'implants', 'orthodontics'].includes(category) ? 'major' : 'basic');
// PPO contracted fee: a share of the office fee, to the dollar (the same rule the setup uses for the schedules).
export const ppoFee = (fee, pct) => Math.round((fee * pct) / 100 / 100) * 100;
const HYG_CODES = new Set(['D1110', 'D1120', 'D1206', 'D1351', 'D4910', 'D4341', 'D4342', 'D0274', 'D0272', 'D0210', 'D0330']);

// Visit kinds: [appointment type name, length in 10-minute blocks, column kind].
export const VISIT_KINDS = {
  hyg: ['Recall exam & cleaning', 6, 'hyg'], np: ['New patient exam & cleaning', 9, 'hyg'], perio: ['Perio maintenance', 6, 'hyg'], srp: ['Scaling & root planing', 9, 'hyg'],
  filling: ['Filling', 6, 'dr'], crownprep: ['Crown prep', 9, 'dr'], seat: ['Crown seat', 3, 'dr'], endo: ['Root canal', 9, 'dr'], ext: ['Extraction', 6, 'dr'],
  implant: ['Implant surgery', 9, 'dr'], implantcrown: ['Implant crown', 6, 'dr'], emergency: ['Emergency / limited exam', 3, 'dr'], consult: ['Consultation', 3, 'dr'],
};
const BLOCKS = 54; // 8:00–17:00 in 10-minute blocks
const LUNCH = [24, 30]; // 12:00–13:00

const POSTERIOR = ['2', '3', '4', '5', '12', '13', '14', '15', '18', '19', '20', '21', '28', '29', '30', '31'];
const ANTERIOR = ['6', '7', '8', '9', '10', '11', '22', '23', '24', '25', '26', '27'];
const MOLARS = ['2', '3', '14', '15', '18', '19', '30', '31'];
const PREMOLARS = ['4', '5', '12', '13', '20', '21', '28', '29'];
const WISDOM = ['1', '16', '17', '32'];
const SURFACES = ['MO', 'DO', 'O', 'MOD', 'OL', 'OB', 'MODB'];

const ageAt = (dob, n) => {
  const b = new Date(`${dob}T12:00:00Z`); const d = new Date(n * DAY);
  let a = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) a--;
  return a;
};
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '');

// ---- The whole practice ----
// Version 2 makes missed visits realistic (see planVisits): who misses, when and how, instead of 5% of everyone's
// visits at random, and confirmations that don't give the answer away. A seed keeps the version it started with
// (demo_seed_state.plan_version), so one cut off part-way always finishes with the same plan.
export const PLAN_VERSION = 2;

export function buildPlan(sizeName, anchorDate, version = PLAN_VERSION) {
  const size = SIZES[sizeName] || SIZES.large;
  const anchor = dn(anchorDate);
  const histStart = addMonthsN(anchor, -size.months);
  const futEnd = anchor + size.futureDays;
  const R = rng(hash(`${sizeName}|${anchorDate}`));
  const plan = { size: sizeName, anchor, anchorDate, histStart, futEnd, patients: [], households: [], version };

  // ---- Who works where, each day ----
  const opsByOffice = { riv: [], stk: [] };
  D.OPERATORIES.forEach((o, i) => opsByOffice[o.office].push({ ...o, idx: i }));
  const dentistAt = (n, office) => D.PROVIDERS.find((p) => p.type === 'dentist' && p.days[weekday(n)] === office)?.key || null;
  // The columns a visit of this kind can go in, on this day, at this office: [op index, provider key].
  const columns = (n, office, kind) => {
    if (!isWorkday(n)) return [];
    if (kind === 'dr') { const dr = dentistAt(n, office); return dr ? opsByOffice[office].filter((o) => o.kind === 'dr').map((o) => [o.idx, dr]) : []; }
    return opsByOffice[office].filter((o) => o.kind === 'hyg' && D.PROVIDERS.find((p) => p.key === o.hyg).days[weekday(n)] === office).map((o) => [o.idx, o.hyg]);
  };
  plan.dentistAt = dentistAt;
  const occ = new Map();
  const grid = (n, op) => {
    const k = n * 16 + op;
    let g = occ.get(k);
    if (!g) { g = new Uint8Array(BLOCKS); for (let b = LUNCH[0]; b < LUNCH[1]; b++) g[b] = 1; occ.set(k, g); }
    return g;
  };
  // A free slot on the day or up to `spread` workdays after it; mornings are a little more popular.
  const book = (r, day, office, kind, blocks, spread = 8) => {
    for (let n = day, tries = 0; tries <= spread && n <= futEnd; n++) {
      if (!isWorkday(n)) continue;
      tries++;
      const cols = columns(n, office, kind);
      const order = cols.map((c) => [r(), c]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      for (const [op, prov] of order) {
        const g = grid(n, op);
        const starts = [];
        for (let b = 0; b + blocks <= BLOCKS; b++) {
          let ok = true;
          for (let k = b; k < b + blocks; k++) if (g[k]) { ok = false; break; }
          if (ok) starts.push(b);
        }
        if (!starts.length) continue;
        // Snug starts (next to another visit, lunch or the day's edge) keep the day packed like a real schedule.
        const snug = starts.filter((b) => b === 0 || g[b - 1] || b + blocks === BLOCKS || g[b + blocks]);
        const b = snug.length && r() < 0.9 ? snug[Math.floor(r() * snug.length)] : starts[Math.floor(r() * starts.length)];
        for (let k = b; k < b + blocks; k++) g[k] = 1;
        return { day: n, op, provider: prov, start: 480 + b * 10, dur: blocks * 10, office };
      }
    }
    plan.unbooked = (plan.unbooked || 0) + 1; // the schedule was full: the visit didn't happen
    return null;
  };

  // ---- Households and patients ----
  const insuredPlans = D.PLANS.map(([key, carrier, name, group, max, ded, prev, basic, major, waitMajor, weight, office]) => ({ key, carrier, name, group, max, ded, prev, basic, major, waitMajor, weight, office }));
  plan.insurancePlans = insuredPlans;
  const planByKey = Object.fromEntries(insuredPlans.map((p) => [p.key, p]));
  const carrierByKey = Object.fromEntries(D.CARRIERS.map((c) => [c.key, c]));
  const choosePlan = (r, office) => r.weighted(insuredPlans, (p) => p.weight * (p.office === office ? 4 : 1));
  let phoneSeq = 1000;
  const addPatient = (r, h, m, i) => {
    const office = h.office;
    const o = D.OFFICES.find((x) => x.key === office);
    const idx = plan.patients.length;
    const p = {
      idx, household: h.idx, first: m.first, last: m.last, dob: m.dob, gender: m.gender, relationship: i === 0 ? null : m.relationship, head: i === 0 ? null : h.head,
      office, preferred: m.extra?.preferred ?? null, alert: m.extra?.alert ?? null, named: !!h.named, extra: m.extra || {},
      phone: `(${o.area}) 555-${String(phoneSeq++).padStart(4, '0')}`,
      email: r.chance(0.82) ? `${slug(m.first)}.${slug(m.last)}${idx}@${o.mail}` : null,
      address: h.address, city: h.city, state: h.state, zip: h.zip,
    };
    if (p.phone.endsWith('0000')) p.phone = `(${o.area}) 555-0199`;
    plan.patients.push(p);
    h.members.push(idx);
    if (i === 0) h.head = idx;
    return p;
  };
  const newHousehold = (office, named, street, town) => {
    const h = { idx: plan.households.length, office, named, members: [], head: null, address: street, city: town[0], state: town[1], zip: town[2] };
    plan.households.push(h);
    return h;
  };

  // The named cast first.
  for (const [office, street, members] of D.HOUSEHOLDS) {
    const r = rng(hash(`hh|${street}|${members[0][0]}`));
    const town = office === 'riv' ? r.pick(D.ME_TOWNS) : r.pick(D.MV_TOWNS);
    const h = newHousehold(office, true, street, town);
    const ex = members[0][5] || {};
    h.plan = ex.noIns ? null : ex.plan || null;
    h.member = ex.member || null;
    h.inactive = !!ex.inactive;
    members.forEach(([first, last, dob, gender, relationship, extra], i) => addPatient(r, h, { first, last, dob, gender, relationship, extra }, i));
  }
  // Then generic households until the practice has its size of active patients (plus the ones who left).
  const activeTarget = size.patients;
  let active = plan.patients.filter((p) => !plan.households[p.household].inactive).length;
  let g = 0;
  while (active < activeTarget) {
    const r = rng(hash(`gen|${sizeName}|${g++}`));
    const office = r.chance(0.55) ? 'riv' : 'stk';
    const me = office === 'riv' ? r.chance(0.85) : r.chance(0.12);
    const [firstM, firstF, lasts, streets, towns] = me ? [D.ME_FIRST_M, D.ME_FIRST_F, D.ME_LAST, D.ME_STREETS, D.ME_TOWNS] : [D.MV_FIRST_M, D.MV_FIRST_F, D.MV_LAST, D.MV_STREETS, D.MV_TOWNS];
    const last = r.pick(lasts);
    const h = newHousehold(office, false, `${r.int(2, 980)} ${r.pick(streets)}`, r.pick(towns));
    const year = plan.anchorDate.slice(0, 4) * 1;
    const dob = (lo, hi) => `${year - r.int(lo, hi)}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`;
    const shape = r();
    const adult = (gender) => ({ first: r.pick(gender === 'male' ? firstM : firstF), last, gender });
    const people = [];
    const g1 = r.chance(0.5) ? 'male' : 'female';
    if (shape < 0.33) people.push({ ...adult(g1), dob: dob(19, 88) });
    else if (shape < 0.5) { people.push({ ...adult(g1), dob: dob(55, 88) }); people.push({ ...adult(g1 === 'male' ? 'female' : 'male'), dob: dob(55, 88), relationship: 'spouse' }); }
    else if (shape < 0.68) { people.push({ ...adult(g1), dob: dob(24, 54) }); people.push({ ...adult(g1 === 'male' ? 'female' : 'male'), dob: dob(24, 54), relationship: 'spouse' }); }
    else if (shape < 0.92) {
      people.push({ ...adult(g1), dob: dob(28, 52) });
      if (r.chance(0.8)) people.push({ ...adult(g1 === 'male' ? 'female' : 'male'), dob: dob(28, 52), relationship: 'spouse' });
      const kids = r.int(1, 3);
      for (let k = 0; k < kids; k++) { const kg = r.chance(0.5) ? 'male' : 'female'; people.push({ first: r.pick(kg === 'male' ? firstM : firstF), last, gender: kg, dob: dob(2, 19), relationship: 'child' }); }
    } else { people.push({ ...adult(g1), dob: dob(66, 92) }); }
    h.plan = r.chance(0.72) ? choosePlan(r, office).key : null;
    h.inactive = r.chance(0.07);
    h.member = !h.plan && r.chance(0.28) ? (r.chance(0.6) ? 'fellowship' : 'fellowship_monthly') : null;
    people.forEach((m, i) => addPatient(r, h, { ...m, extra: {} }, i));
    if (!h.inactive) active += people.length;
  }

  // ---- Per-patient setup: status, joining, insurance, membership, clinical profile ----
  for (const p of plan.patients) {
    const r = rng(hash(`pt|${sizeName}|${p.idx}|${p.first}|${p.last}`));
    p.r = r;
    const h = plan.households[p.household];
    const age = ageAt(p.dob, anchor);
    p.age = age;
    p.inactive = h.inactive || !!p.extra.inactive;
    // Established patients predate the window; about a fifth joined during it (or will join in the coming weeks).
    const joinsLate = !p.named && r.chance(size.months >= 12 ? 0.22 : 0.12);
    p.joinDay = joinsLate ? histStart + r.int(0, anchor + Math.floor(size.futureDays / 2) - histStart) : histStart - r.int(40, 2600);
    if (ageAt(p.dob, p.joinDay) < 1) p.joinDay = dn(p.dob) + 400;
    // Members of a household join together.
    if (p.head != null) p.joinDay = Math.max(plan.patients[p.head].joinDay, dn(p.dob) + 400);
    p.newPatient = p.joinDay >= histStart;
    p.leaveDay = p.inactive ? Math.min(anchor - 20, histStart + r.int(30, Math.max(40, anchor - histStart - 60))) : null;
    if (p.inactive && p.leaveDay <= p.joinDay) p.joinDay = histStart - r.int(200, 900);
    p.createdDay = p.newPatient ? Math.min(p.joinDay - r.int(0, 10), anchor) : p.joinDay;
    // Insurance: the household's plan, the head as subscriber; children to 26 on a parent's plan.
    const ins = h.plan ? planByKey[h.plan] : null;
    if (ins && (p.head == null || p.relationship === 'spouse' || age < 26)) {
      const sub = p.head == null ? p : plan.patients[p.head];
      p.policy = {
        plan: ins.key, carrier: ins.carrier, subscriber: sub.idx, relationship: p.head == null ? 'self' : p.relationship === 'spouse' ? 'spouse' : 'child',
        subscriberId: `${carrierByKey[ins.carrier].payer_id.slice(0, 3)}${String(hash(`${sub.first}${sub.last}${sub.idx}`) % 1e9).padStart(9, '0')}`,
        effective: ds(Math.min(p.joinDay, histStart) - r.int(30, 900)),
      };
    } else p.policy = null;
    // Membership for uninsured patients (by age), from the day they join or a later visit.
    if (!p.policy && !p.inactive && (p.extra.member || h.member || (!h.plan && r.chance(0.08)))) {
      const wanted = p.extra.member || h.member || 'fellowship';
      p.membership = { plan: age < 18 ? 'young_avengers' : wanted, start: Math.max(p.joinDay, histStart - r.int(0, 300)) };
    } else p.membership = null;
    p.perio = !!p.extra.perio || (age >= 35 && r.chance(age >= 55 ? 0.16 : 0.08));
    if (p.perio && p.membership && r.chance(0.5)) p.membership.plan = 'perio_guardians';
    p.risk = r.chance(0.2) ? 'high' : r.chance(0.5) ? 'medium' : 'low';
    p.sporadic = !p.named && r.chance(0.12);
    p.compliance = p.sporadic ? 0.3 : r.chance(0.2) ? 0.65 : 0.92;
    if (version >= 2) {
      // Habits (their own random stream, so the rest of the patient's plan draws the same numbers): most patients
      // nearly always come; about one in five misses now and then; a few miss often. Those who miss are also more
      // often slow to pay, so a balance owed goes with missed visits, as it does in real offices.
      const q = rng(hash(`habits|${sizeName}|${p.idx}`));
      const x = q();
      p.missing = (x < 0.08 ? 3.2 : x < 0.3 ? 1.2 : 0.55) * (p.sporadic ? 1.5 : 1);
      p.slowPayer = q.chance(0.12 + (p.missing > 3 ? 0.35 : p.missing > 1 ? 0.1 : 0));
      p.habits = q;
    }
    // Medical history.
    const med = r.pick(D.MEDICATIONS);
    p.medications = age >= 30 ? med : null;
    p.conditions = [...new Set([...(p.medications ? D.CONDITIONS_BY_MED[p.medications] || [] : []), ...(p.extra.medical || [])])];
    if (p.gender === 'female' && age >= 22 && age <= 40 && r.chance(0.03)) p.conditions.push('Pregnant');
    p.allergies = r.pick(D.ALLERGIES);
    p.asa = p.conditions.length >= 2 ? 'III' : p.conditions.length ? 'II' : 'I';
    p.premed = p.conditions.includes('Prosthetic joint') || p.conditions.includes('Artificial heart valve') ? 1 : 0;
    if (age >= 60 && r.chance(0.05)) { p.conditions.push('Prosthetic joint'); p.premed = 1; }
    p.officeAlert = p.alert || (p.named ? null : r.pick(D.OFFICE_ALERTS));
    p.language = !p.named && r.chance(0.04) ? (r.chance(0.5) ? 'es' : 'Sindarin') : null;
    p.referral = p.newPatient || r.chance(0.5) ? r.weighted(D.REFERRAL_SOURCES, (x) => x[2]) : null;
    p.lastBwx = histStart - r.int(0, 400);
    p.lastFmx = histStart - r.int(0, 1900);
    p.visits = [];
    p.plans = [];
    p.procs = [];
    p.conds = [];
    p.referrals = [];
    p.notesExtra = [];
  }

  // ---- Visits ----
  // Every patient's visits, in patient order (the slot grid is shared, so the order matters and is fixed).
  for (const p of plan.patients) planVisits(plan, p, book);

  // ---- Money: charges, claims, insurance payments, patient payments, plans, refunds, voids ----
  plan.checks = new Map();
  plan.deposits = new Map();
  for (const p of plan.patients) planMoney(plan, p, { planByKey, carrierByKey });
  finishMoney(plan);
  return plan;
}

// ---- One patient's visits and treatment ----
function planVisits(plan, p, book) {
  const { anchor, histStart, futEnd } = plan;
  const r = p.r;
  const end = p.inactive ? p.leaveDay : futEnd;
  const v2 = plan.version >= 2;
  // Version 2: how likely this visit is to be missed, relative to the practice's usual — the patient's habits, their
  // misses so far, a Monday-morning or Friday-afternoon slot, a first visit, booked long ahead, owing money.
  const riskOf = (slot, kind, lead) => {
    let m = p.missing;
    const prior = p.visits.filter((x) => x.day < slot.day && (x.status === 'no_show' || (x.status === 'cancelled' && x.late))).length;
    m *= 1 + 0.6 * Math.min(3, prior);
    const wd = weekday(slot.day);
    if ((wd === 1 && slot.start < 10 * 60) || (wd === 5 && slot.start >= 13 * 60)) m *= 2;
    if (kind === 'np') m *= 2.2;
    if (lead != null) m *= lead >= 90 ? 1.5 : lead >= 30 ? 1.1 : lead <= 2 ? 0.5 : 0.9;
    if (p.slowPayer) m *= 1.8;
    return m;
  };
  // Days booked ahead: recall visits mostly at the last cleaning, treatment within weeks, emergencies the same day.
  const leadFor = (kind) => {
    const q = p.habits;
    if (kind === 'hyg' || kind === 'perio') return q.chance(0.7) ? q.int(150, 200) : q.int(7, 45);
    if (kind === 'np') return q.int(2, 21);
    if (kind === 'emergency') return q.int(0, 1);
    if (kind === 'seat' || kind === 'implantcrown') return q.int(14, 28);
    return q.int(4, 35);
  };
  const status = (slot, rebookable = true, kind = null, lead = null) => {
    const m = v2 ? riskOf(slot, kind, lead) : 1;
    if (slot.day > anchor) return 'future';
    if (slot.day === anchor) {
      // Today, as the morning huddle would see it at about half past eleven.
      if (slot.start + slot.dur <= 11 * 60) return r.chance(Math.min(0.3, 0.05 * m)) ? 'no_show' : 'completed';
      if (slot.start <= 11 * 60 + 30) return r.chance(0.6) ? 'in_chair' : 'checked_in';
      return r.chance(0.7) ? 'confirmed' : 'scheduled';
    }
    const x = r();
    if (!v2) {
      if (!rebookable) return x < 0.04 ? 'no_show' : 'completed';
      return x < 0.05 ? 'no_show' : x < 0.12 ? 'cancelled' : 'completed';
    }
    const noShow = Math.min(0.45, 0.03 * m);
    if (!rebookable) return x < noShow ? 'no_show' : 'completed';
    return x < noShow ? 'no_show' : x < noShow + Math.min(0.3, 0.055 * Math.sqrt(m)) ? 'cancelled' : 'completed';
  };
  // Adds a visit (and books its slot); broken past visits are rebooked a week or three later.
  const visit = (kind, day, procs, extra = {}) => {
    const [, blocks, col] = VISIT_KINDS[kind];
    const office = r.chance(0.95) ? p.office : p.office === 'riv' ? 'stk' : 'riv';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (day > end || day > futEnd) return null;
      const slot = book(r, Math.max(day, p.joinDay), office, col, blocks);
      if (!slot) return null;
      const lead = v2 ? leadFor(kind) : null;
      const st = status(slot, attempt < 2 && kind !== 'emergency', kind, lead);
      const v = { idx: p.visits.length, kind, ...slot, status: st, procs: [], ...extra };
      if (v2) {
        v.lead = lead;
        if (st === 'cancelled') {
          // How much notice they gave: riskier visits are more often cancelled at the last minute.
          v.late = p.habits.chance(Math.min(0.85, 0.4 * Math.sqrt(riskOf(slot, kind, lead))));
          v.notice = v.late ? p.habits.int(1, 22) : p.habits.int(2, 14) * 24 + p.habits.int(0, 8);
        }
      }
      p.visits.push(v);
      if ((st === 'no_show' || st === 'cancelled') && slot.day < anchor) {
        v.broken = st === 'cancelled' ? r.pick(['Sick', 'Work conflict', 'Car trouble', 'Called to an urgent quest', 'Family emergency']) : null;
        day = slot.day + r.int(7, 24);
        continue;
      }
      for (const pr of procs) addProc(p, v, pr, plan);
      return v;
    }
    return null;
  };
  p.visitFn = visit;

  // A new patient's first visit.
  let t;
  if (p.newPatient) {
    const v = visit('np', p.joinDay, npCodes(plan, p, p.joinDay));
    if (v) { exam(plan, p, v); t = v.day + (p.perio ? 95 : 182); } else t = p.joinDay + 182;
    if (p.perio && v && v.day < anchor) planSrp(plan, p, v.day);
  } else {
    // Established: the first recall in the window is somewhere in the first interval.
    t = histStart + r.int(0, p.perio ? 90 : 180);
    recordExisting(p);
  }
  if (p.sporadic) {
    // Comes for emergencies, and a cleaning now and then.
    for (let n = histStart + r.int(0, 300); n < end; n += r.int(200, 420)) {
      if (r.chance(0.5)) { const v = visit('emergency', n, [['D0140'], ['D0220', pickTooth(r)]]); if (v) emergency(plan, p, v); } else { const v = visit('hyg', n, hygCodes(plan, p, n)); if (v) exam(plan, p, v); }
    }
  } else {
    while (t <= end) {
      if (t > anchor && !r.chance(0.86)) break; // not every due recall is booked yet
      if (t < anchor && !r.chance(p.compliance)) { t += r.int(60, 150); continue; } // fell behind
      const v = visit(p.perio ? 'perio' : 'hyg', t, p.perio ? perioCodes(plan, p, t) : hygCodes(plan, p, t));
      if (v) { exam(plan, p, v); t = v.day + (p.perio ? r.int(85, 115) : r.int(170, 200)); } else t += 30;
    }
    // Emergencies: a few a year across the practice.
    const years = (end - histStart) / 365;
    for (let k = 0; k < years; k++) {
      if (!r.chance(0.035)) continue;
      const v = visit('emergency', histStart + r.int(0, end - histStart), [['D0140'], ['D0220', r.pick(POSTERIOR)], ...(r.chance(0.4) ? [['D9110']] : [])]);
      if (v) emergency(plan, p, v);
    }
  }
}

function recordExisting(p) {
  // Work done before the window, charted as existing conditions.
  const r = p.r;
  if (p.age < 16) return;
  const at = p.joinDay;
  if (p.age >= 20 && r.chance(0.6)) for (const t of WISDOM) if (r.chance(0.7)) p.conds.push({ tooth: t, condition: 'missing', day: at });
  const n = p.age < 25 ? r.int(0, 2) : p.age < 50 ? r.int(1, 5) : r.int(2, 8);
  const used = new Set();
  for (let k = 0; k < n; k++) { const t = r.pick(POSTERIOR); if (used.has(t)) continue; used.add(t); p.conds.push({ tooth: t, surfaces: r.pick(SURFACES), condition: 'filling', day: at }); }
  if (p.age >= 35 && r.chance(0.4)) { const t = r.pick(MOLARS); if (!used.has(t)) { used.add(t); p.conds.push({ tooth: t, condition: 'crown', day: at }); if (r.chance(0.4)) p.conds.push({ tooth: t, condition: 'root_canal', day: at }); } }
  if (p.age >= 45 && r.chance(0.06)) { const t = r.pick(['19', '30', '3', '14']); if (!used.has(t)) p.conds.push({ tooth: t, condition: 'implant', day: at }); }
}

const pickTooth = (r) => r.pick(POSTERIOR);
function hygCodes(plan, p, n) {
  const age = ageAt(p.dob, n);
  const out = [['D0120']];
  if (age < 14) {
    out.push(['D1120'], ['D1206']);
    if (age >= 6 && n - p.lastBwx > 340) { out.push(['D0272']); p.lastBwx = n; }
    if (age >= 6 && age <= 10 && !p.sealed && p.r.chance(0.5)) { p.sealed = true; for (const t of ['3', '14', '19', '30']) out.push(['D1351', t]); }
    return out;
  }
  out.push(['D1110']);
  if (age < 19) out.push(['D1206']);
  if (n - p.lastFmx > 1800) { out.push(['D0210']); p.lastFmx = n; p.lastBwx = n; } else if (n - p.lastBwx > 340) { out.push(['D0274']); p.lastBwx = n; }
  return out;
}
function perioCodes(plan, p, n) {
  const out = [['D4910']];
  p.perioCount = (p.perioCount || 0) + 1;
  if (p.perioCount % 2 === 1) out.push(['D0120']);
  if (n - p.lastBwx > 340) { out.push(['D0274']); p.lastBwx = n; }
  return out;
}
function npCodes(plan, p, n) {
  const age = ageAt(p.dob, n);
  if (age < 14) { const c = [['D0150'], ['D1120'], ['D1206']]; if (age >= 6) c.push(['D0272']); p.lastBwx = n; return c; }
  p.lastFmx = n; p.lastBwx = n;
  return p.perio ? [['D0180'], ['D0210']] : [['D0150'], ['D0210'], ['D1110']];
}

function addProc(p, v, [code, tooth = null, surfaces = null, area = null], plan, extra = {}) {
  const c = CODES[code];
  const provider = HYG_CODES.has(code) && VISIT_KINDS[v.kind][2] === 'hyg' ? v.provider : VISIT_KINDS[v.kind][2] === 'hyg' ? plan.dentistAt(v.day, v.office) || v.provider : v.provider;
  const done = v.status === 'completed';
  const pr = { idx: p.procs.length, code, tooth, surfaces, area, fee: c.fee, category: c.category, description: c.description, provider, visit: v.idx, status: done ? 'completed' : 'planned', day: v.day, office: v.office, ...extra };
  p.procs.push(pr);
  v.procs.push(pr.idx);
  return pr;
}

// What an exam finds, and the treatment plan that follows (accepted, declined or still to decide).
function exam(plan, p, v) {
  if (v.status !== 'completed') return;
  const r = p.r;
  const age = ageAt(p.dob, v.day);
  const risk = { low: 0.2, medium: 0.38, high: 0.6 }[p.risk] * (age < 14 ? 0.6 : 1);
  const items = [];
  if (r.chance(risk)) {
    const n = r.int(1, p.risk === 'high' ? 4 : 2);
    const used = new Set();
    for (let k = 0; k < n; k++) {
      const ant = r.chance(0.15);
      const tooth = age < 12 ? r.pick(['A', 'B', 'I', 'J', 'K', 'L', 'S', 'T']) : r.pick(ant ? ANTERIOR : POSTERIOR);
      if (used.has(tooth)) continue;
      used.add(tooth);
      const s = ant ? r.pick(['M', 'D', 'ML', 'DL']) : r.pick(SURFACES);
      const code = ant ? (s.length > 1 ? 'D2331' : 'D2330') : s.length === 1 ? 'D2391' : s.length === 2 ? 'D2392' : s.length === 3 ? 'D2393' : 'D2394';
      items.push({ kind: 'filling', codes: [[code, tooth, s]], cond: { tooth, surfaces: s, condition: 'caries' } });
    }
  }
  if (age >= 25 && r.chance(0.08)) { const t = r.pick(MOLARS); items.push({ kind: 'crownprep', codes: [['D2740', t], ['D2950', t]], cond: { tooth: t, condition: 'fracture' } }); }
  if (age >= 18 && r.chance(0.012)) { const t = r.pick([...MOLARS, ...PREMOLARS]); items.push({ kind: 'ext', codes: [[r.chance(0.25) ? 'D7210' : 'D7140', t]], cond: { tooth: t, condition: 'abscess' } }); }
  if (age >= 16 && age <= 24 && r.chance(0.05)) items.push({ kind: 'ref_os', teeth: WISDOM.join(','), cond: { tooth: '17', condition: 'impacted' } });
  if (age >= 9 && age <= 13 && r.chance(0.04)) items.push({ kind: 'ref_ortho' });
  if (age >= 25 && r.chance(0.008)) items.push({ kind: 'guard', codes: [['D9944']] });
  if (items.length) treatment(plan, p, v.day, items);
}
function emergency(plan, p, v) {
  if (v.status !== 'completed') return;
  const r = p.r;
  const t = v.procs.map((i) => p.procs[i].tooth).find(Boolean) || r.pick(MOLARS);
  const x = r();
  const items = x < 0.35 ? [{ kind: 'endo', codes: [[MOLARS.includes(t) ? 'D3330' : PREMOLARS.includes(t) ? 'D3320' : 'D3310', t]], cond: { tooth: t, condition: 'abscess' } }, { kind: 'crownprep', codes: [['D2740', t], ['D2950', t]] }]
    : x < 0.55 ? [{ kind: 'ext', codes: [[r.chance(0.3) ? 'D7210' : 'D7140', t]], cond: { tooth: t, condition: 'fracture' } }, ...(r.chance(0.45) ? [{ kind: 'implant', codes: [['D6010', t]] }, { kind: 'implantcrown', codes: [['D6057', t], ['D6065', t]] }] : [])]
      : x < 0.8 ? [{ kind: 'crownprep', codes: [['D2740', t], ['D2950', t]], cond: { tooth: t, condition: 'fracture' } }] : [];
  if (items.length) treatment(plan, p, v.day, items, { urgent: true });
}
function planSrp(plan, p, day) {
  treatment(plan, p, day, [{ kind: 'srp', codes: [['D4341', null, null, 'UR'], ['D4341', null, null, 'LR']] }, { kind: 'srp', codes: [['D4341', null, null, 'UL'], ['D4341', null, null, 'LL']] }], { urgent: true, name: 'Periodontal therapy' });
  p.perioExamDays = [...(p.perioExamDays || []), day];
}

function treatment(plan, p, day, items, { urgent = false, name = null } = {}) {
  const r = p.r;
  const { anchor } = plan;
  // Referrals out (oral surgery for wisdom teeth, orthodontics, and some root canals) instead of a plan here.
  for (const it of items.filter((x) => x.kind.startsWith('ref_'))) {
    p.referrals.push({ direction: 'out', day, contact: it.kind === 'ref_ortho' ? 'erebor_ortho' : p.office === 'riv' ? 'isildur_os' : 'palmer_os', reason: it.kind === 'ref_ortho' ? 'Orthodontic evaluation — crowding' : 'Evaluate and remove third molars', teeth: it.teeth || null });
    if (it.cond) p.conds.push({ ...it.cond, day });
  }
  items = items.filter((x) => !x.kind.startsWith('ref_'));
  if (!items.length) return;
  if (items.some((x) => x.kind === 'endo') && r.chance(0.25)) {
    // Referred to an endodontist; the crown still happens here.
    const endo = items.find((x) => x.kind === 'endo');
    p.referrals.push({ direction: 'out', day, contact: p.office === 'riv' ? 'elrond_endo' : 'pym_endo', reason: 'Root canal therapy — symptomatic pulpitis', teeth: endo.codes[0][1] });
    items = items.filter((x) => x !== endo);
  }
  const x = r();
  const status = urgent ? (x < 0.85 ? 'accepted' : 'proposed') : x < 0.62 ? 'accepted' : x < 0.76 ? 'rejected' : 'proposed';
  const tp = {
    idx: p.plans.length, name: name || (items.some((i) => ['implant', 'crownprep', 'endo'].includes(i.kind)) ? 'Restorative & crowns' : items.every((i) => i.kind === 'filling') ? 'Fillings' : 'Treatment'),
    status, day, acceptedDay: status === 'accepted' ? day + (r.chance(0.7) ? 0 : r.int(1, 12)) : null, phases: [], signed: status === 'accepted' && r.chance(0.6),
  };
  if (tp.acceptedDay != null && tp.acceptedDay > anchor) { tp.acceptedDay = null; tp.status = 'proposed'; }
  p.plans.push(tp);
  for (const it of items) if (it.cond) p.conds.push({ ...it.cond, day });
  // Phases: urgent care first, then fillings, then crowns and implants.
  const phaseOf = (k) => (['endo', 'ext', 'srp'].includes(k) ? 1 : k === 'filling' || k === 'guard' ? 2 : 3);
  const used = [...new Set(items.map((i) => phaseOf(i.kind)))].sort();
  const phaseNames = { 1: ['Urgent care', 'Get you out of pain and treat infection first'], 2: ['Fillings', 'Stop decay before it gets bigger'], 3: ['Crowns & implants', 'Protect and replace teeth for the long term'] };
  tp.phases = used.map((ph, i) => ({ phase: i + 1, key: ph, name: phaseNames[ph][0], why: phaseNames[ph][1], visits: items.filter((it) => phaseOf(it.kind) === ph).length }));
  const phaseNo = (k) => used.indexOf(phaseOf(k)) + 1;
  // Accepted work is booked visit by visit; some of it stays unscheduled (a follow-up list).
  let next = (tp.acceptedDay ?? day) + r.int(5, 30);
  const book = tp.status === 'accepted' && r.chance(0.88);
  let prep = null;
  const fillings = items.filter((i) => i.kind === 'filling');
  const visits = [...(fillings.length ? [{ kind: 'filling', codes: fillings.flatMap((f) => f.codes) }] : []), ...items.filter((i) => i.kind !== 'filling')];
  visits.sort((a, b) => phaseOf(a.kind) - phaseOf(b.kind));
  for (const it of visits) {
    const vkind = it.kind === 'guard' ? 'consult' : it.kind;
    let v = null;
    if (book) {
      v = p.visitFn(vkind, next, []);
      if (v && !['no_show', 'cancelled'].includes(v.status)) {
        for (const c of it.codes) addProc(p, v, c, plan, { plan: tp.idx, phase: phaseNo(it.kind) });
        if (it.kind === 'crownprep' || it.kind === 'implantcrown') {
          prep = v;
          const seatDay = v.day + r.int(14, 22);
          const seat = p.visitFn('seat', seatDay, []);
          if (seat) { v.seat = seat.idx; seat.prep = v.idx; }
          v.lab = { kind: it.kind, tooth: it.codes[0][1] };
        }
        if (it.kind === 'implant') next = v.day + r.int(90, 120); else next = v.day + r.int(10, 35);
        continue;
      }
    }
    // Not booked (or not bookable yet): the procedures wait on the plan.
    for (const c of it.codes) {
      const pr = { idx: p.procs.length, code: c[0], tooth: c[1] ?? null, surfaces: c[2] ?? null, area: c[3] ?? null, fee: CODES[c[0]].fee, category: CODES[c[0]].category, description: CODES[c[0]].description,
        provider: plan.dentistAt(nextWorkday(day), p.office) || (p.office === 'riv' ? 'banner' : 'strange'), visit: null, status: 'planned', day, office: p.office, plan: tp.idx, phase: phaseNo(it.kind) };
      p.procs.push(pr);
    }
  }
  if (prep) tp.hasLab = true;
}

// ---- Money ----
function planMoney(plan, p, { planByKey, carrierByKey }) {
  const { anchor } = plan;
  const r = p.r;
  p.ledger = [];
  p.claims = [];
  p.paymentPlans = [];
  const policy = p.policy ? { ...planByKey[p.policy.plan], carrier: carrierByKey[planByKey[p.policy.plan].carrier] } : null;
  const used = new Map(); // benefit year → { max used, deductible used }
  const memberUse = new Map();
  const mplan = p.membership ? D.MEMBERSHIP_PLANS.find((m) => m.key === p.membership.plan) : null;
  const L = (e) => { const x = { idx: p.ledger.length, ...e }; p.ledger.push(x); return x; };
  const payMethod = () => { const x = r(); return x < 0.62 ? 'credit_card' : x < 0.72 ? 'debit_card' : x < 0.84 ? 'cash' : x < 0.95 ? 'check' : 'care_credit'; };
  // Membership fees: every period up to today, paid by card the same day.
  if (mplan) {
    const m = p.membership;
    const months = mplan.interval === 'year' ? 12 : 1;
    let n = m.start;
    m.periods = [];
    while (n <= anchor) {
      m.periods.push(n);
      const end = addMonthsN(n, months);
      L({ type: 'charge', amount: mplan.price, day: n, desc: `${mplan.name} membership ${ds(n)} to ${ds(end)}`, ref: `period:${ds(n)}`, membership: true, office: p.office });
      // A monthly member's card was declined this month: the fee waits and the membership is past due.
      if (mplan.interval === 'month' && n > anchor - 31 && r.chance(0.08)) m.pastDue = true;
      else L({ type: 'payment', amount: -mplan.price, day: n, desc: 'Membership autopay (card •••• 4242)', method: 'credit_card', membership: true, office: p.office });
      n = end;
    }
    m.nextBill = n;
  }
  for (const v of [...p.visits].sort((a, b) => a.day - b.day || a.start - b.start)) {
    if (v.status !== 'completed') continue;
    const procs = v.procs.map((i) => p.procs[i]).filter((x) => x.status === 'completed');
    if (!procs.length) continue;
    const payer = policy && p.policy.effective <= ds(v.day) ? policy : null;
    let patientShare = 0;
    for (const pr of procs) {
      L({ type: 'charge', amount: pr.fee, day: v.day, desc: `${pr.code} ${pr.description}${pr.tooth ? ` #${pr.tooth}` : ''}${pr.surfaces ? ` ${pr.surfaces}` : ''}${pr.area ? ` ${pr.area}` : ''}`, proc: pr.idx, provider: pr.provider, office: v.office });
    }
    // Members: included services come off in full; everything else gets the member discount.
    if (mplan && !payer && v.day >= p.membership.start) {
      const year = Math.floor((v.day - p.membership.start) / 365);
      for (const pr of procs) {
        const rule = mplan.included.find((x) => x.codes.includes(pr.code));
        const key = `${year}|${rule?.label}`;
        if (rule && (memberUse.get(key) || 0) < rule.per_year) {
          memberUse.set(key, (memberUse.get(key) || 0) + 1);
          L({ type: 'adjustment', adj: 'Membership included', amount: -pr.fee, day: v.day, desc: `${rule.label} included with ${mplan.name} — ${pr.code}`, proc: pr.idx, provider: pr.provider, office: v.office, membership: true });
        } else {
          const off = Math.round((pr.fee * mplan.discount_pct) / 100);
          L({ type: 'adjustment', adj: 'Membership discount', amount: -off, day: v.day, desc: `${mplan.discount_pct}% ${mplan.name} discount — ${pr.code}`, proc: pr.idx, provider: pr.provider, office: v.office, membership: true });
          patientShare += pr.fee - off;
        }
      }
    } else if (payer) {
      // The claim: contracted fee, the plan's share by tier, the deductible once a year, up to the annual max.
      const yr = ds(v.day).slice(0, 4);
      const u = used.get(yr) || { max: 0, ded: 0 };
      const items = procs.map((pr) => {
        const allowed = payer.carrier.ppo ? Math.min(pr.fee, ppoFee(pr.fee, payer.carrier.ppo)) : pr.fee;
        const tier = tierOf(pr.category);
        let pct = tier === 'preventive' ? payer.prev : tier === 'basic' ? payer.basic : payer.major;
        if (tier === 'major' && payer.waitMajor && v.day - dn(p.policy.effective) < payer.waitMajor * 30) pct = 0;
        let ded = 0;
        if (tier !== 'preventive' && u.ded < payer.ded) { ded = Math.min(payer.ded - u.ded, allowed); u.ded += ded; }
        let ins = Math.round(((allowed - ded) * pct) / 100);
        ins = Math.max(0, Math.min(ins, payer.max - u.max));
        u.max += ins;
        return { proc: pr.idx, fee: pr.fee, allowed, writeOff: pr.fee - allowed, ins, patient: allowed - ins, ded };
      });
      used.set(yr, u);
      const claim = claimFor(plan, p, v, payer, items);
      patientShare = items.reduce((s, it) => s + it.patient, 0);
      p.claims.push(claim);
    } else {
      patientShare = procs.reduce((s, pr) => s + pr.fee, 0);
    }
    v.patientShare = patientShare;
    // Now and then a courtesy adjustment (a long wait, a loyal family).
    if (patientShare > 5000 && r.chance(0.02)) {
      const off = Math.round(patientShare * 0.1 / 100) * 100;
      L({ type: 'adjustment', adj: 'Courtesy', amount: -off, day: v.day, desc: r.pick(['Courtesy adjustment — long wait', 'Courtesy adjustment — family discount', 'Courtesy adjustment — approved by Maria Hill']), office: v.office });
      patientShare -= off;
    }
    // Patient payments: at the desk, later from a statement, on a payment plan — or still owed.
    let paid = 0;
    const claim = p.claims.find((c) => c.visit === v.idx);
    if (patientShare > 0) {
      const big = patientShare >= 60000;
      if (big && r.chance(0.35) && v.day < anchor - 30) {
        const down = Math.round((patientShare * 0.2) / 100) * 100;
        const n = r.pick([3, 4, 6]);
        const each = Math.ceil((patientShare - down) / n);
        const pp = { idx: p.paymentPlans.length, total: patientShare, down, each, n, start: v.day + 30, day: v.day, note: `${procs.map((x) => x.code).join(' + ')}${procs[0].tooth ? ` #${procs[0].tooth}` : ''}` };
        p.paymentPlans.push(pp);
        L({ type: 'payment', amount: -down, day: v.day, desc: 'Down payment (credit card)', method: 'credit_card', office: v.office, pplan: pp.idx });
        let left = patientShare - down; let k = 0;
        for (let d = pp.start; d < anchor && left > 0; d = addMonthsN(d, 1)) {
          const amt = Math.min(each, left);
          k++;
          L({ type: 'payment', amount: -amt, day: d, desc: `Payment plan installment ${k}`, method: 'credit_card', office: v.office, pplan: pp.idx });
          left -= amt;
        }
        pp.status = left <= 0 ? 'completed' : 'active';
        paid = patientShare - left;
      } else if (r.chance((payer ? 0.66 : mplan ? 0.9 : 0.78) * (p.slowPayer ? 0.5 : 1))) {
        const method = big ? r.pick(['credit_card', 'care_credit', 'check']) : payMethod();
        // Rarely, the first card payment was keyed in wrong: voided with a reason and taken again.
        if (r.chance(0.01) && ['credit_card', 'debit_card'].includes(method)) {
          const wrong = L({ type: 'payment', amount: -(patientShare + 1000), day: v.day, desc: `Patient payment (${method.replace('_', ' ')})`, method, office: v.office,
            voided: { reason: 'Keyed the wrong amount — re-entered', day: v.day } });
          L({ type: 'payment', amount: patientShare + 1000, day: v.day, desc: `Void: ${wrong.desc}`, method, office: v.office, reverses: wrong.idx });
        }
        const pay = L({ type: 'payment', amount: -patientShare, day: v.day, desc: `Patient payment (${method.replace('_', ' ')})`, method, office: v.office });
        paid = patientShare;
        // The insurance paid more than we estimated: the overpayment goes back to the patient.
        if (claim?.outcome === 'paid' && claim.payDay < anchor - 8 && r.chance(0.04)) {
          const bonus = Math.min(patientShare, Math.round(claim.items.reduce((s, it) => s + it.allowed, 0) * 0.1 / 100) * 100);
          if (bonus > 0) { claim.bonus = bonus; claim.paid += bonus; claim.refund = { amount: bonus, day: claim.payDay + r.int(3, 7), of: pay.idx, method }; }
        }
      }
      // What's left: some pay after the statement, the rest is still owed.
      const due = patientShare - paid;
      if (due > 0) {
        const after = (claim?.payDay ?? v.day) + r.int(12, 45);
        if (after < anchor && r.chance(p.slowPayer ? 0.45 : 0.88)) {
          L({ type: 'payment', amount: -due, day: after, desc: `Patient payment — statement (${r.chance(0.6) ? 'online' : 'mail'})`, method: r.chance(0.6) ? 'credit_card' : 'check', office: v.office });
        } else if (v.day < anchor - 400 && r.chance(0.5)) {
          L({ type: 'adjustment', adj: 'Bad debt write-off', amount: -due, day: v.day + r.int(300, 390), desc: 'Bad debt write-off — no response to four statements', office: v.office });
          p.badDebt = true;
        }
      }
    }
  }
  // Some pay ahead for a booked crown or implant: a credit on the account until the work is done.
  for (const v of p.visits) {
    if (v.status !== 'future' && v.status !== 'scheduled' && v.status !== 'confirmed') continue;
    if (!['crownprep', 'implant'].includes(v.kind) || !r.chance(0.3)) continue;
    const fees = v.procs.reduce((s2, i) => s2 + p.procs[i].fee, 0);
    const amount = Math.round((fees * (policy ? 0.25 : 0.5)) / 1000) * 1000;
    if (amount > 0) L({ type: 'payment', amount: -amount, day: Math.min(anchor - 1, v.day - r.int(5, 25)), desc: `Prepayment for upcoming ${v.kind === 'implant' ? 'implant' : 'crown'} visit (credit card)`, method: 'credit_card', office: v.office });
  }
  // Insurance payments, write-offs and refunds, each on its own day.
  for (const c of p.claims) {
    if (c.paid > 0) {
      L({ type: 'insurance_payment', amount: -c.paid, day: c.payDay, desc: `Insurance payment - ${c.carrierName} (claim)`, method: c.electronic ? 'ach' : 'check', claim: c.idx, check: c.checkKey, office: c.office });
      if (c.outcome === 'paid' && c.writeOff > 0) L({ type: 'adjustment', adj: 'Insurance write-off', amount: -c.writeOff, day: c.payDay, desc: `Insurance write-off - ${c.carrierName} (claim)`, claim: c.idx, check: c.checkKey, office: c.office });
    }
    // An older denial: the patient was billed for the insurance share and most paid it.
    if (c.outcome === 'denied' && c.denyDay < anchor - 45 && r.chance(0.8)) {
      L({ type: 'payment', amount: -c.est, day: c.denyDay + r.int(15, 40), desc: 'Patient payment — insurance denied the claim', method: r.pick(['credit_card', 'check']), office: c.office });
    }
    if (c.refund && c.refund.day < plan.anchor) L({ type: 'refund', amount: c.refund.amount, day: c.refund.day, desc: `Refund of ${ds(c.day)} payment — insurance paid more than estimated`, method: c.refund.method, refundOf: c.refund.of, office: c.office });
  }
  p.ledger.sort((a, b) => a.day - b.day || a.idx - b.idx);
  p.balance = p.ledger.reduce((s, e) => s + e.amount, 0);
}

function claimFor(plan, p, v, payer, items) {
  const { anchor } = plan;
  const r = p.r;
  const age = anchor - v.day;
  const total = items.reduce((s, it) => s + it.fee, 0);
  const est = items.reduce((s, it) => s + it.ins, 0);
  const c = {
    idx: p.claims.length, visit: v.idx, day: v.day, office: v.office, items, total, est, writeOff: items.reduce((s, it) => s + it.writeOff, 0), ded: items.reduce((s, it) => s + it.ded, 0),
    carrierKey: payer.carrier.key, carrierName: payer.carrier.name, electronic: payer.carrier.electronic, paid: 0, outcome: null,
  };
  // How far along it is, by age: waiting for approval (not a claim yet), draft, sent, accepted, paid, partly paid, denied.
  const x = r();
  c.submitDay = v.day + (r.chance(0.8) ? 0 : 1);
  const payDay = (() => { let n = v.day + r.int(12, 34); while ((n + 4) % 7 !== payer.carrier.payDay || !isWorkday(n)) n++; return n; })();
  if (age <= 2) c.outcome = 'unbilled';
  else if (age <= 10 && x < 0.12) c.outcome = 'draft';
  else if (payDay >= anchor) c.outcome = x < 0.03 ? 'rejected' : 'submitted';
  else if (x < 0.03) c.outcome = 'denied';
  else if (x < 0.1 && payDay > anchor - 45) c.outcome = 'partial';
  else if (x < 0.115 && age > 45 && age < 150) c.outcome = 'submitted'; // no answer yet: the aging claims list
  else c.outcome = 'paid';
  if (est === 0 && ['paid', 'partial'].includes(c.outcome)) c.outcome = 'paid';
  if (c.outcome === 'paid') { c.paid = est; c.payDay = payDay; }
  if (c.outcome === 'partial') { c.paid = Math.round((est * r.int(40, 75)) / 100); c.payDay = payDay; if (c.paid === 0) c.outcome = 'submitted'; }
  if (c.outcome === 'denied') { c.denyDay = payDay; c.denial = r.pick(D.DENIALS); }
  if (c.outcome === 'submitted' && age > 45) c.followUp = anchor + r.int(-5, 10);
  if (c.paid > 0) c.checkKey = `${c.carrierKey}|${c.payDay}`;
  return c;
}

// Insurance checks (one per payer and payment day) and bank deposits (one per office and day), from every entry.
function finishMoney(plan) {
  const { anchor } = plan;
  for (const p of plan.patients) {
    for (const c of p.claims) {
      if (!c.checkKey) continue;
      let k = plan.checks.get(c.checkKey);
      if (!k) {
        const carrier = D.CARRIERS.find((x) => x.key === c.carrierKey);
        k = { key: c.checkKey, carrier: c.carrierKey, day: c.payDay, amount: 0, claims: 0, electronic: carrier.electronic,
          number: carrier.electronic ? `${carrier.payer_id}-EFT-${ds(c.payDay).replace(/-/g, '')}` : String(100000 + (hash(c.checkKey) % 900000)) };
        plan.checks.set(c.checkKey, k);
      }
      k.amount += c.paid;
      k.claims++;
    }
  }
  const deposit = (office, day, amount) => {
    const key = `${office}|${day}`;
    let d = plan.deposits.get(key);
    if (!d) { d = { key, office, day, total: 0, items: 0 }; plan.deposits.set(key, d); }
    d.total += amount;
    d.items++;
    return key;
  };
  // Cash and checks go to the bank the same day; the last two days' are still waiting in the drawer.
  for (const p of plan.patients) {
    for (const e of p.ledger) {
      if (e.type === 'payment' && ['cash', 'check'].includes(e.method) && e.amount < 0 && !e.voided && e.day < anchor - 1) e.deposit = deposit(e.office, e.day, -e.amount);
    }
  }
  for (const k of plan.checks.values()) if (!k.electronic && k.day < anchor - 1) k.deposit = deposit('riv', k.day, k.amount);
  for (const p of plan.patients) for (const e of p.ledger) if (e.type === 'insurance_payment' && e.check && plan.checks.get(e.check).deposit) e.deposit = plan.checks.get(e.check).deposit;
}

// ---- One visit's booking, confirmation and cancellation times (version 2) ----
// Written as the app would have left them: most kept visits were confirmed (about 88%), some never were; about 40% of
// no-shows had confirmed; last-minute cancellations sometimes had, early ones almost never. cancelled_at is
// v.notice hours before the start. r: the visit's own random stream. Times are [day number, minutes after midnight].
export function visitFacts(plan, p, v, r) {
  const { anchor } = plan;
  let status = v.status;
  const risky = (p.missing || 1) > 1.5 || !!p.slowPayer;
  if (status === 'future') status = v.day <= anchor + 2 ? (r.chance(risky ? 0.45 : 0.7) ? 'confirmed' : 'scheduled') : r.chance(risky ? 0.15 : 0.25) ? 'confirmed' : 'scheduled';
  const here = ['completed', 'in_chair', 'checked_in'].includes(status);
  const split = (t) => [Math.floor(t / 1440), ((t % 1440) + 1440) % 1440];
  const startAt = v.day * 1440 + v.start;
  const lead = v.lead ?? r.int(1, 60);
  // Booked: `lead` days before (never after today), during office hours; a same-day emergency an hour or two before.
  const created = lead === 0 ? split(startAt - r.int(60, 180)) : [Math.min(v.day - lead, anchor), 600 + r.int(0, 400)];
  const cancelled = status === 'cancelled' ? split(startAt - (v.notice ?? 72) * 60) : null;
  let confirmed;
  if (status === 'confirmed') confirmed = true;
  else if (here) confirmed = r.chance(risky ? 0.8 : 0.9);
  else if (status === 'no_show') confirmed = r.chance(0.4);
  else if (status === 'cancelled') confirmed = v.late ? r.chance(0.3) : r.chance(0.04);
  else confirmed = false;
  let confirmedAt = null;
  if (confirmed) {
    // A day or three before, in the daytime; never before it was booked, after today, or after it was cancelled.
    let t = (Math.min(anchor, v.day - r.int(1, 3))) * 1440 + 540 + r.int(0, 540);
    const bookedAt = created[0] * 1440 + created[1];
    if (cancelled) t = Math.min(t, cancelled[0] * 1440 + cancelled[1] - 30);
    t = Math.max(t, bookedAt + 5);
    confirmedAt = split(Math.min(t, startAt - 5));
  }
  return { status, created, confirmedAt, via: confirmed ? r.pick(['sms', 'sms', 'email', 'phone']) : null, cancelled };
}
