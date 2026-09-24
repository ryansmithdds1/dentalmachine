// The built-in prediction model: a transparent statistical model computed from the practice's own history. No outside
// calls, nothing hidden — every number it gives can be explained in a sentence.
//
// How it works (the same for both kinds):
//   1. Rates are "smoothed": a rate from few visits (or claims) is pulled toward a wider rate, e.g. a weekday's
//      no-show rate with 4 visits behind it is mostly the office's overall rate: (hits + k × prior) / (n + k).
//      The office's own overall rate is itself pulled toward a typical dental-office rate while it has little history.
//   2. Each factor moves the odds away from the office's overall rate by how far its smoothed rate is from it
//      (a difference in log-odds), scaled down by a weight because the factors overlap (a patient who misses a lot
//      also tends to book far ahead, and so on).
//   3. The shifts are added up on the log-odds scale and turned back into a probability (a logistic combination).
//   4. The biggest shifts upward become the plain-language reasons; confidence says how much history was behind it.
//
// Features are counts and categories only (no names, dates of birth or record ids); see noshow.js / denial.js.

export const logit = (p) => Math.log(p / (1 - p));
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clamp = (p, lo, hi) => Math.min(hi, Math.max(lo, p));
// A smoothed rate: `hits` of `n`, pulled toward `prior` as if k more cases had happened at the prior rate.
export const smoothed = (s, prior, k) => {
  const n = Math.max(0, Number(s?.n) || 0);
  const hits = Math.max(0, Math.min(n, Number(s?.hits) || 0));
  return clamp((hits + k * prior) / (n + k), 0.001, 0.999);
};
export const pct = (p) => Math.round(p * 100);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const round2 = (x) => Math.round(x * 100) / 100;

// Typical rates for a dental office, used only until the office has its own history.
export const PRIORS = { no_show: 0.08, denial: 0.05 };
// How strongly each factor counts (overlapping factors are damped) and how many cases it takes to trust a group's
// own rate over the wider one.
export const NO_SHOW_WEIGHTS = { patient: 1, confirmed: 0.8, first_visit: 0.6, lead: 0.5, type: 0.5, weekday: 0.4, time: 0.4, owes: 0.4 };
const K = { practice: 20, group: 30, patient: 2 };
// No one group factor may move the odds more than about 4× (e^1.5) either way, and a patient's own record about
// 12× (e^2.5): a group that happens to be all misses (or none) in the history shouldn't decide the answer alone.
export const MAX_SHIFT = { group: 1.5, patient: 2.5 };
export const LITTLE_HISTORY = { practice: 100, solid: 1000 };

// The level used for "Double-confirm" and the chips: relative to the office's own usual rate, with floors so an
// office where many visits are missed doesn't flag everyone.
export function noShowLevel(p, base) {
  if (p >= Math.max(0.3, 2.5 * base)) return 'high';
  if (p >= Math.max(0.15, 1.5 * base)) return 'some';
  return 'low';
}

// f: see noshow.js visitFeatures. Returns { probability, percent, level, confidence, reasons, factors, base_rate }.
export function predictNoShow(f) {
  const base = smoothed(f.practice, PRIORS.no_show, K.practice);
  const lb = logit(base);
  const factors = [];
  const add = (key, shift, reason, lowReason = null) => factors.push({ key, shift: round2(shift), reason, lowReason });
  const group = (key, stats, reason) => {
    if (!stats || !(stats.n > 0)) return;
    const r = smoothed(stats, base, K.group);
    const w = NO_SHOW_WEIGHTS[key] * (key === 'confirmed' && !f.confirmed && f.days_ahead > 0 ? 0.6 : 1);
    add(key, w * clamp(logit(r) - lb, -MAX_SHIFT.group, MAX_SHIFT.group), typeof reason === 'function' ? reason(r) : reason);
  };

  // The patient's own record, recency-weighted (a miss last month counts more than one two years ago).
  const p = f.patient || {};
  const n = (p.missed_w || 0) + (p.kept_w || 0);
  if (n > 0) {
    const r = clamp(((p.missed_w || 0) + K.patient * base) / (n + K.patient), 0.001, 0.999);
    const bits = [];
    if (p.no_shows_1y) bits.push(`${plural(p.no_shows_1y, 'missed visit')}`);
    if (p.late_cancels_1y) bits.push(`${plural(p.late_cancels_1y, 'late cancellation')}`);
    const older = (p.missed_2y || 0) - (p.no_shows_1y || 0) - (p.late_cancels_1y || 0);
    const why = bits.length ? `${bits.join(' and ')} in the past year` : older > 0 ? `${plural(older, 'missed or late-cancelled visit', 'missed or late-cancelled visits')} in the past 2 years` : null;
    add('patient', NO_SHOW_WEIGHTS.patient * clamp(logit(r) - lb, -MAX_SHIFT.patient, MAX_SHIFT.patient), why, p.kept_2y >= 3 && !p.missed_2y ? `kept all ${p.kept_2y} visits in the past 2 years` : null);
  }
  if (f.first_visit) group('first_visit', f.first_visit_stats, 'first visit with us');
  group('confirmed', f.confirmed_stats, f.confirmed ? 'confirmed' : 'not confirmed yet');
  group('lead', f.lead_stats, f.lead_label);
  group('type', f.type_stats, (r) => `${f.visit_type || 'this kind of'} visits are missed ${pct(r)}% of the time here`);
  group('weekday', f.weekday_stats, (r) => `${f.weekday}s are missed ${pct(r)}% of the time here`);
  group('time', f.time_stats, (r) => `${f.time_of_day} visits are missed ${pct(r)}% of the time here`);
  if (f.owes) group('owes', f.owes_stats, 'owes a balance');

  const x = lb + factors.reduce((s, fa) => s + fa.shift, 0);
  const probability = clamp(sigmoid(x), 0.01, 0.95);
  const practiceN = f.practice?.n || 0;
  const patientN = (p.kept_2y || 0) + (p.missed_2y || 0);
  const confidence = practiceN < LITTLE_HISTORY.practice ? 'low' : practiceN < LITTLE_HISTORY.solid || patientN < 3 ? 'medium' : 'high';
  // Why it's high: the biggest pushes up. Why it's low, when it's below the office's usual rate: their good record.
  const good = factors.find((fa) => fa.key === 'patient' && fa.lowReason);
  const reasons = good && probability <= base ? [good.lowReason]
    : factors.filter((fa) => fa.shift > 0.15 && fa.reason).sort((a, b) => b.shift - a.shift).slice(0, 3).map((fa) => fa.reason);
  if (practiceN < LITTLE_HISTORY.practice) reasons.push('not much history yet');
  else if (!patientN && !f.first_visit) reasons.push('not enough history for this patient yet');
  return { probability: round2(probability), percent: pct(probability), level: noShowLevel(probability, base), confidence, reasons, factors, base_rate: round2(base) };
}

// Rule hits from the scrubber count strongly: a 'deny' (a frequency limit, a filing deadline, a duplicate…) is
// usually denied as it stands; a missing narrative the payer wants, less so.
export const RULE_SHIFT = { deny: 2.2, more_deny: 0.5, narrative: 0.8, warn: 0.3 };

// f: see denial.js lineFeatures. Returns { probability, percent, confidence, reasons, factors, base_rate }.
export function predictDenial(f) {
  const L = f.labels || {};
  const base = smoothed(f.practice, PRIORS.denial, K.practice);
  const payer = smoothed(f.payer_stats, base, 10);
  const code = smoothed(f.code_stats, base, 10);
  // Payer × code, with the payer's and the code's own rates as its starting point.
  const pcPrior = clamp(sigmoid(logit(payer) + logit(code) - logit(base)), 0.001, 0.999);
  let hist = smoothed(f.payer_code_stats, pcPrior, 5);
  const narr = f.narrative === false && f.payer_code_narr_stats?.n > 0;
  if (narr) hist = smoothed(f.payer_code_narr_stats, hist, 3);
  const factors = [{ key: 'history', shift: round2(logit(hist) - logit(base)) }];
  const reasons = [];
  const pc = narr ? f.payer_code_narr_stats : f.payer_code_stats;
  const who = L.payer || 'This payer';
  if (pc?.n > 0 && pc.hits > 0) reasons.push(`${who} has denied ${pc.hits} of ${pc.n} ${f.code}${narr ? ' sent without a narrative' : ''}`);
  else if (pc?.n >= 3) reasons.push(`${who} has paid all ${pc.n} ${f.code} sent before`);
  else if (f.code_stats?.n >= 5 && f.code_stats.hits > 0 && code > base * 1.5) reasons.push(`${f.code} is denied ${pct(code)}% of the time here`);
  if (f.payer_stats?.n >= 20 && payer > base * 1.5) reasons.push(`${who} denies ${pct(payer)}% of lines here`);

  const rules = f.rules || {};
  let shift = 0;
  if (rules.deny > 0) shift += RULE_SHIFT.deny + RULE_SHIFT.more_deny * (rules.deny - 1);
  if (rules.narrative > 0) shift += RULE_SHIFT.narrative;
  if (rules.warn > 0) shift += RULE_SHIFT.warn * Math.min(2, rules.warn);
  if (shift) factors.push({ key: 'rules', shift: round2(shift) });
  if (L.first_rule) reasons.unshift(L.first_rule);

  const probability = clamp(sigmoid(logit(hist) + shift), 0.01, 0.97);
  const pcN = f.payer_code_stats?.n || 0;
  let confidence = pcN >= 10 ? 'high' : pcN >= 3 || (f.code_stats?.n || 0) >= 20 ? 'medium' : 'low';
  if (rules.deny > 0 && confidence === 'low') confidence = 'medium';
  if ((f.practice?.n || 0) < LITTLE_HISTORY.practice) reasons.push('not much claim history yet');
  else if (pcN < 3 && !rules.deny) reasons.push(`not enough history with ${L.payer || 'this payer'} for ${f.code} yet`);
  return { probability: round2(probability), percent: pct(probability), confidence, reasons: reasons.slice(0, 3), factors, base_rate: round2(base) };
}

export const builtin = {
  id: 'builtin',
  name: 'Built-in (this office’s own history)',
  async predictMany(kind, list) {
    const fn = kind === 'no_show' ? predictNoShow : kind === 'denial' ? predictDenial : null;
    if (!fn) throw new Error(`Unknown prediction: ${kind}`);
    return list.map((f) => fn(f));
  },
};
