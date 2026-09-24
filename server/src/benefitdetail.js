import { parseX12, parse271 } from './x12.js';

// The full benefit breakdown in a payer's 271, read service type by service type (IV2).
//
// parse271 (x12.js) reads what eligibility has always used: active or not, the maximum and deductible with what
// is left, one percentage per tier, frequency limits and service history. Many payers send much more: a
// percentage for each kind of dentistry (EB03 service types), the maximum already used this year, the family
// deductible, the orthodontic lifetime maximum and its age limit, waiting periods (a later "benefit begin" date
// per service type, or a message), the missing-tooth clause and the composite downgrade. This reads all of it
// into the plan's own fields, keeping what belongs to the plan (the same for everyone on the employer group)
// apart from what belongs to this patient (their used and remaining amounts, their history).

// X12 service type codes a dental 271 uses (EB03).
export const SERVICE_TYPES = {
  35: 'Dental care', 23: 'Diagnostic', 41: 'Preventive', 25: 'Restorative (basic)', 26: 'Endodontics', 24: 'Periodontics', 40: 'Oral surgery',
  36: 'Crowns', 39: 'Prosthodontics', 27: 'Maxillofacial prosthetics', 28: 'Adjunctive', 37: 'Dental accident', 38: 'Orthodontics',
};
// Which of the plan's three tiers each service type is priced by (the same split as coverageTier in defaults.js:
// diagnostic and preventive; basic restorative, endo, perio and oral surgery; crowns and prosthetics).
const TIER = { 23: 'preventive', 41: 'preventive', 25: 'basic', 26: 'basic', 24: 'basic', 40: 'basic', 28: 'basic', 36: 'major', 39: 'major', 27: 'major' };
// The service type whose percentage stands for the whole tier, in order of preference.
const ANCHOR = { preventive: ['41', '23'], basic: ['25', '26', '24', '40'], major: ['36', '39', '27'] };
// CDT prefixes for a per-code override when a service type is paid differently from its tier.
const PREFIXES = { 23: ['D0'], 41: ['D1'], 25: ['D2'], 26: ['D3'], 24: ['D4'], 40: ['D7'], 36: ['D27'], 39: ['D5', 'D62'], 27: ['D59'], 28: ['D9'] };

const cents = (v) => Math.round(Number(v || 0) * 100);
const d8 = (v) => (/^\d{8}$/.test(v || '') ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);
// EB08 is the patient's share (0.20, or 20 from some payers); the plan pays the rest.
const planPays = (share) => {
  const n = Number(share);
  if (!Number.isFinite(n) || share === '' || share == null) return null;
  return Math.max(0, Math.min(100, Math.round((1 - (n > 1 ? n / 100 : n)) * 100)));
};
const monthsBetween = (from, to) => {
  if (!from || !to || to <= from) return 0;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.max(0, (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0));
};
const WAIT = /WAIT(?:ING)?\s*PERIOD[^0-9]{0,20}(\d{1,2})\s*(MONTHS?|MOS?|YEARS?|YRS?)/i;
const AGE = /(?:AGE\s*LIMIT|TO\s+AGE|THROUGH\s+AGE|THRU\s+AGE|UNDER\s+AGE|UP\s+TO\s+AGE|AGE)\D{0,6}(\d{1,2})/i;

// text: a 271. Returns { active, complete, plan, patient, identity, categories, messages, base }.
//   plan:     plan-level fields present in the response (the names of insurance_plans' columns)
//   patient:  this patient's amounts: max_used, max_remaining, deductible_met, deductible_remaining, …, history
//   identity: what identifies the plan: payer, group number, plan number and name, member ID, subscriber
//   complete: a full breakdown — maximum, deductible and a percentage for all three tiers
export function parse271Detail(text) {
  const base = parse271(text);
  const segs = parseX12(text);
  const pct = {}; // service type → plan pays %
  const benefitBegin = {}; // service type → 'YYYY-MM-DD' (DTP*348 after its EB)
  const waitMonths = {}; // service type → months, from a message
  const identity = { payer_name: null, group_number: null, plan_number: null, plan_name: base.plan_name || null, member_id: null, subscriber_name: null, subscriber_dob: null };
  const patient = {
    max_used: null, max_remaining: base.max_remaining, deductible_met: null, deductible_remaining: base.deductible_remaining,
    family_deductible_remaining: base.family_deductible_remaining, ortho_remaining: base.ortho_remaining, history: base.history,
    plan_begin: base.plan_begin, plan_end: null,
  };
  const plan = {};
  const flags = { missing_tooth_clause: null, downgrade_composites: null, ortho_age_limit: null, ortho_not_covered: false, calendar_year: false };
  let services = [];
  let inNetwork = true;
  let nm1 = null;
  for (const s of segs) {
    if (s.id === 'NM1') {
      nm1 = s.e[1];
      if (nm1 === 'PR' && !identity.payer_name) identity.payer_name = s.e[3] || null;
      if (nm1 === 'IL') {
        identity.subscriber_name = [s.e[4], s.e[3]].filter(Boolean).join(' ') || null;
        if (s.e[8] === 'MI' && s.e[9]) identity.member_id = s.e[9];
      }
      continue;
    }
    if (s.id === 'DMG' && nm1 === 'IL' && s.e[1] === 'D8' && !identity.subscriber_dob) identity.subscriber_dob = d8(s.e[2]);
    if (s.id === 'REF' && s.e[1] === '6P' && s.e[2]) identity.group_number ??= s.e[2];
    if (s.id === 'REF' && s.e[1] === '18' && s.e[2]) identity.plan_number ??= s.e[2];
    if (s.id === 'REF' && s.e[1] === '6P' && s.e[3] && !identity.plan_name) identity.plan_name = s.e[3];
    if (s.id === 'DTP' && ['347', '357'].includes(s.e[1])) {
      // A range (RD8 20250101-20251231) or a single end date.
      const v = String(s.e[3] || '');
      const end = s.e[2] === 'RD8' ? d8(v.split('-')[1]) : d8(v);
      if (end && !patient.plan_end) patient.plan_end = end;
    }
    if (s.id === 'DTP' && ['346', '356'].includes(s.e[1]) && s.e[2] === 'RD8') {
      const [from, to] = String(s.e[3] || '').split('-');
      patient.plan_begin ??= d8(from);
      if (to && !patient.plan_end) patient.plan_end = d8(to);
    }
    if (s.id === 'DTP' && s.e[1] === '348' && services.length && inNetwork) {
      const at = d8(String(s.e[3] || '').split('-')[0]);
      for (const st of services) if (at) benefitBegin[st] ??= at;
    }
    if (s.id === 'MSG') {
      const msg = String(s.e[1] || '');
      const wait = WAIT.exec(msg);
      if (wait && services.length) for (const st of services) waitMonths[st] ??= Number(wait[1]) * (/^Y/i.test(wait[2]) ? 12 : 1);
      if (/MISSING\s+TOOTH/i.test(msg)) flags.missing_tooth_clause = /NO\s+MISSING|NOT\s+APPL|WAIVED|DOES\s+NOT/i.test(msg) ? 0 : 1;
      if (/ALTERNATE\s+BENEFIT|DOWNGRADE|AMALGAM\s+RATE|PAID\s+AS\s+AMALGAM/i.test(msg)) flags.downgrade_composites = /NO\s+(ALTERNATE|DOWNGRADE)/i.test(msg) ? 0 : 1;
      if (services.includes('38')) {
        const age = AGE.exec(msg);
        if (age && Number(age[1]) >= 5 && Number(age[1]) <= 30) flags.ortho_age_limit ??= Number(age[1]);
      }
      continue;
    }
    if (s.id !== 'EB') continue;
    const [info, level, stc, , , period, amount, percent] = s.e.slice(1);
    services = String(stc || '').split(/[\^:]/).filter(Boolean);
    inNetwork = s.e[12] !== 'N';
    if (!inNetwork) continue; // out-of-network figures are kept by parse271 on their own
    const ind = !level || level === 'IND';
    if (info === 'A' && percent !== undefined && percent !== '') {
      const p = planPays(percent);
      if (p != null) for (const st of services) if (pct[st] === undefined) pct[st] = p;
    }
    if (info === 'I' && services.includes('38')) flags.ortho_not_covered = true;
    if (info === 'I') for (const st of services) if (TIER[st] && pct[st] === undefined) pct[st] = 0;
    if (info === 'F' && amount && ind && !services.includes('38') && period === '24') patient.max_used ??= cents(amount);
    if (info === 'C' && amount && ind && period === '24') patient.deductible_met ??= cents(amount);
    if ((info === 'F' || info === 'C') && period === '23') flags.calendar_year = true;
  }

  // The three tiers: the anchor service type's percentage (parse271's own reading as a fallback).
  for (const [tier, order] of Object.entries(ANCHOR)) {
    const st = order.find((c) => pct[c] !== undefined);
    const value = st ? pct[st] : base.coinsurance?.[tier];
    if (value != null) plan[`pct_${tier}`] = value;
  }
  // Service types paid differently from their tier become per-code overrides (endodontics at 50% on an
  // 80% basic plan). An override on D2 would also catch crowns (D27), so crowns get their own.
  const overrides = {};
  for (const [st, p] of Object.entries(pct)) {
    const tier = TIER[st];
    if (!tier || plan[`pct_${tier}`] == null || p === plan[`pct_${tier}`] || ANCHOR[tier][0] === st) continue;
    for (const prefix of PREFIXES[st] || []) overrides[prefix] = p;
  }
  if (overrides.D2 != null && overrides.D27 == null && plan.pct_major != null) overrides.D27 = pct['36'] ?? plan.pct_major;
  if (Object.keys(overrides).length) plan.coverage_overrides = overrides;

  if (base.annual_max != null) plan.annual_max = base.annual_max;
  if (base.deductible != null) plan.deductible = base.deductible;
  if (base.family_deductible != null) plan.family_deductible = base.family_deductible;
  if (base.ortho_max != null) plan.ortho_max = base.ortho_max;
  if (flags.ortho_not_covered && base.ortho_max == null) plan.ortho_max = 0;
  if (pct['38'] !== undefined && !flags.ortho_not_covered) plan.ortho_pct = pct['38'];
  if (flags.ortho_age_limit != null) plan.ortho_age_limit = flags.ortho_age_limit;
  if (flags.missing_tooth_clause != null) plan.missing_tooth_clause = flags.missing_tooth_clause;
  if (flags.downgrade_composites != null) plan.downgrade_composites = flags.downgrade_composites;
  if (flags.calendar_year) plan.benefit_month = 1;
  if (base.frequencies?.length) plan.frequencies = base.frequencies;

  // Waiting periods: the longest wait among a tier's service types — a later "benefit begin" date than the
  // coverage start, or a message saying so.
  for (const tier of ['basic', 'major']) {
    const months = Object.keys(TIER).filter((st) => TIER[st] === tier).map((st) => waitMonths[st] ?? monthsBetween(patient.plan_begin, benefitBegin[st]) ?? 0);
    const worst = Math.max(0, ...months.filter((m) => Number.isFinite(m)));
    const reported = Object.keys(TIER).some((st) => TIER[st] === tier && (waitMonths[st] != null || benefitBegin[st]));
    if (reported) plan[`wait_${tier}_months`] = worst;
  }
  if (patient.max_used == null && base.annual_max != null && base.max_remaining != null) patient.max_used = Math.max(0, base.annual_max - base.max_remaining);
  if (patient.deductible_met == null && base.deductible != null && base.deductible_remaining != null) patient.deductible_met = Math.max(0, base.deductible - base.deductible_remaining);

  const categories = Object.entries(pct).filter(([st]) => SERVICE_TYPES[st]).map(([st, p]) => ({ service_type: st, label: SERVICE_TYPES[st], pct: p, tier: TIER[st] || null }));
  const complete = plan.annual_max != null && plan.deductible != null && ['preventive', 'basic', 'major'].every((t) => plan[`pct_${t}`] != null);
  return { active: base.active, errors: base.errors, complete, plan, patient, identity, categories, messages: base.messages, base };
}
