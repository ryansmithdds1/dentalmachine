import { HttpError } from './auth.js';
import { coverageTier } from './defaults.js';
import { insert, addMonths, practiceNow, mapSeq } from './util.js';

// ---- Insurance plans ----
// A plan is the employer group's coverage (shared by every subscriber and dependant on it); a policy is
// one patient's enrolment in it. Benefit fields live on the plan and are copied onto each policy so
// older readers of the policy row still see the right numbers.
export const PLAN_BENEFITS = [
  'annual_max', 'deductible', 'family_deductible', 'pct_preventive', 'pct_basic', 'pct_major', 'benefit_month',
  'ortho_max', 'ortho_pct', 'ortho_age_limit', 'wait_basic_months', 'wait_major_months', 'downgrade_composites',
  'frequencies', 'coverage_overrides', 'fee_schedule_id',
];
const SYNCED = ['annual_max', 'deductible', 'pct_preventive', 'pct_basic', 'pct_major', 'benefit_month'];

// Usual US dental plan limits. Codes are prefixes (D27 = any crown).
export const DEFAULT_FREQUENCIES = [
  { label: 'Exams', codes: ['D0120', 'D0150', 'D0180'], count: 2, per: 'benefit_year' },
  { label: 'Cleanings', codes: ['D1110', 'D1120', 'D4910'], count: 2, per: 'benefit_year' },
  { label: 'Bitewings', codes: ['D0270', 'D0272', 'D0273', 'D0274'], count: 1, months: 12 },
  { label: 'Full series or panoramic', codes: ['D0210', 'D0330'], count: 1, months: 60 },
  { label: 'Fluoride', codes: ['D1206', 'D1208'], count: 2, per: 'benefit_year' },
  { label: 'Sealants (same tooth)', codes: ['D1351'], count: 1, months: 36, per_tooth: true },
  { label: 'Crowns (same tooth)', codes: ['D27', 'D6065'], count: 1, months: 60, per_tooth: true },
  { label: 'Scaling & root planing (same quadrant)', codes: ['D4341', 'D4342'], count: 1, months: 24, per_area: true },
];

const json = (v, fallback) => {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};

export function validatePlan(row) {
  for (const k of ['pct_preventive', 'pct_basic', 'pct_major', 'ortho_pct']) {
    if (row[k] != null && (Number(row[k]) < 0 || Number(row[k]) > 100)) throw new HttpError(400, `${k} must be 0-100`);
  }
  for (const k of ['annual_max', 'deductible', 'family_deductible', 'ortho_max']) {
    if (row[k] != null) {
      row[k] = Math.round(Number(row[k]));
      if (!Number.isFinite(row[k]) || row[k] < 0) throw new HttpError(400, `${k} must be a positive amount`);
    }
  }
  for (const k of ['wait_basic_months', 'wait_major_months', 'ortho_age_limit']) if (row[k] != null && row[k] !== '') row[k] = Math.max(0, Math.round(Number(row[k]) || 0));
  if (row.benefit_month != null && !(Number(row.benefit_month) >= 1 && Number(row.benefit_month) <= 12)) throw new HttpError(400, 'benefit_month must be 1-12');
  if (row.downgrade_composites != null) row.downgrade_composites = row.downgrade_composites ? 1 : 0;
  if (row.frequencies != null) {
    const list = json(row.frequencies, null);
    if (!Array.isArray(list) || list.some((f) => !Array.isArray(f.codes) || !f.codes.length || !(Number(f.count) >= 0) || (!f.months && f.per !== 'benefit_year'))) {
      throw new HttpError(400, 'frequencies must be a list of { codes, count, months | per: "benefit_year" }');
    }
    row.frequencies = JSON.stringify(list.map((f) => ({ label: String(f.label || f.codes.join(', ')).slice(0, 60), codes: f.codes.map((c) => String(c).toUpperCase()), count: Number(f.count), ...(f.months ? { months: Number(f.months) } : { per: 'benefit_year' }), ...(f.per_tooth ? { per_tooth: true } : {}), ...(f.per_area ? { per_area: true } : {}) })));
  }
  if (row.coverage_overrides != null) {
    const o = json(row.coverage_overrides, null);
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.entries(o).some(([k, v]) => !/^D\d{0,4}$/i.test(k) || !(Number(v) >= 0 && Number(v) <= 100))) {
      throw new HttpError(400, 'coverage_overrides must map codes (or prefixes like D27) to a percentage');
    }
    row.coverage_overrides = JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toUpperCase(), Number(v)])));
  }
  return row;
}

// Copies a plan's benefits onto all of its policies (keeps the per-policy columns in step).
export async function syncPlan(db, planId) {
  const plan = await db.get('SELECT * FROM insurance_plans WHERE id = ?', planId);
  if (!plan) return;
  await db.run(`UPDATE patient_insurance SET ${SYNCED.map((k) => `${k} = ?`).join(', ')} WHERE plan_id = ?`, ...SYNCED.map((k) => plan[k]), plan.id);
}

// The plan a policy belongs to; a policy from before plans existed gets one made from its own numbers
// (shared with other policies of the same carrier and group number).
export async function planFor(db, policy) {
  if (policy.plan_id) {
    const plan = await db.get('SELECT * FROM insurance_plans WHERE id = ?', policy.plan_id);
    if (plan) return plan;
  }
  let plan = policy.group_number
    ? await db.get('SELECT * FROM insurance_plans WHERE practice_id = ? AND carrier_id = ? AND group_number = ? ORDER BY id LIMIT 1', policy.practice_id, policy.carrier_id, policy.group_number)
    : null;
  if (!plan) {
    const id = await insert(db, 'insurance_plans', {
      practice_id: policy.practice_id, carrier_id: policy.carrier_id, group_number: policy.group_number || null,
      ...Object.fromEntries(SYNCED.map((k) => [k, policy[k] ?? (k === 'benefit_month' ? 1 : 0)])),
      frequencies: JSON.stringify(DEFAULT_FREQUENCIES),
    });
    plan = await db.get('SELECT * FROM insurance_plans WHERE id = ?', id);
  }
  await db.run('UPDATE patient_insurance SET plan_id = ? WHERE id = ? AND plan_id IS NULL', plan.id, policy.id);
  return plan;
}

// Policy with its plan's benefits folded in (what estimates are made from).
export async function withPlan(db, policy) {
  if (!policy) return policy;
  const plan = await planFor(db, policy);
  const merged = { ...policy, plan_id: plan.id, plan };
  for (const k of SYNCED) merged[k] = plan[k] ?? policy[k];
  merged.fee_schedule_id = plan.fee_schedule_id ?? policy.fee_schedule_id ?? null;
  return merged;
}

// ---- Benefit years, deductibles and maximums ----
export function benefitYear(policy, date) {
  const month = Math.min(12, Math.max(1, Number(policy?.benefit_month) || 1));
  let year = Number(date.slice(0, 4));
  if (Number(date.slice(5, 7)) < month) year -= 1;
  const mm = String(month).padStart(2, '0');
  return { start: `${year}-${mm}-01`, end: `${year + 1}-${mm}-01` };
}

export const deductibleMet = (policy, date) => {
  const { start } = benefitYear(policy, date);
  return !policy.deductible_year || policy.deductible_year === start ? policy.deductible_met || 0 : 0;
};

// Benefits used in the benefit year containing `date`, by date of service: what paid claims paid plus
// what open claims are expected to pay. Orthodontics has its own lifetime maximum and isn't counted.
export async function benefitsUsed(db, policy, date) {
  const today = date || (await practiceNow(db, policy.practice_id)).slice(0, 10);
  const { start, end } = benefitYear(policy, today);
  const dos = '(SELECT MIN(pr.completed_at) FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = c.id)';
  return (await db.get(
    `SELECT COALESCE(SUM(CASE WHEN c.status = 'paid' THEN c.paid_amount
         WHEN c.paid_amount > c.estimated_amount THEN c.paid_amount ELSE c.estimated_amount END), 0) AS used
     FROM claims c
     WHERE c.patient_insurance_id = ? AND c.status IN ('draft','submitted','partially_paid','paid')
       AND NOT EXISTS (SELECT 1 FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = c.id AND pr.category = 'orthodontics')
       AND ${dos} >= ? AND ${dos} < ?`,
    policy.id, start, end,
  )).used;
}

// Lifetime orthodontic benefits already used on this policy.
async function orthoUsed(db, policy) {
  return (await db.get(
    `SELECT COALESCE(SUM(CASE WHEN c.status IN ('paid','partially_paid') AND c.estimated_amount > 0 THEN ci.estimated_amount * c.paid_amount / c.estimated_amount ELSE ci.estimated_amount END), 0) AS n
     FROM claim_items ci JOIN claims c ON c.id = ci.claim_id JOIN procedures pr ON pr.id = ci.procedure_id
     WHERE c.patient_insurance_id = ? AND c.status IN ('draft','submitted','partially_paid','paid') AND pr.category = 'orthodontics'`, policy.id,
  )).n;
}

// Family deductible met: every member on the same plan and subscriber.
async function familyDeductibleMet(db, policy, date) {
  const rows = await db.all('SELECT deductible_met, deductible_year, benefit_month FROM patient_insurance WHERE plan_id = ? AND subscriber_id = ? AND active = 1', policy.plan_id, policy.subscriber_id);
  return rows.reduce((s, p) => s + deductibleMet(p, date), 0);
}

// ---- Coverage rules ----
const POSTERIOR = new Set(['1', '2', '3', '4', '5', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '28', '29', '30', '31', '32', 'A', 'B', 'I', 'J', 'K', 'L', 'S', 'T']);
// Posterior composite → amalgam of the same number of surfaces (the usual "alternate benefit").
const AMALGAM_FOR = { D2391: 'D2140', D2392: 'D2150', D2393: 'D2160', D2394: 'D2161' };
const matches = (code, list) => list.some((c) => code.startsWith(c));
const longestPrefix = (map, code) => Object.keys(map).filter((k) => code.startsWith(k)).sort((a, b) => b.length - a.length)[0];

// Treatment area for per-area limits (quadrant or arch), when recorded.
const areaOf = (p) => p.area || null;

async function frequencyProblem(db, policy, freqs, p, dos, earlier, ids) {
  const rule = freqs.find((f) => matches(p.code, f.codes));
  if (!rule) return null;
  const from = rule.per === 'benefit_year' ? benefitYear(policy, dos).start : addMonths(dos, -rule.months);
  const sameSpot = (x) => (!rule.per_tooth || !p.tooth || x.tooth === p.tooth) && (!rule.per_area || !areaOf(p) || areaOf(x) === areaOf(p));
  const prior = (await db.all(
    `SELECT id, code, tooth, completed_at FROM procedures WHERE patient_id = ? AND status = 'completed' AND id != ? AND completed_at >= ? AND completed_at < ?`,
    p.patient_id, p.id ?? -1, from, `${dos} 23:59:59`,
  )).filter((x) => !ids.has(x.id) && matches(x.code, rule.codes) && sameSpot(x));
  const inThisEstimate = earlier.filter((x) => matches(x.code, rule.codes) && sameSpot(x));
  const used = prior.length + inThisEstimate.length;
  if (used < rule.count) return null;
  const last = prior.map((x) => x.completed_at.slice(0, 10)).sort().at(-1);
  const window = rule.per === 'benefit_year' ? 'per benefit year' : rule.months === 12 ? 'every year' : rule.months % 12 === 0 ? `every ${rule.months / 12} years` : `every ${rule.months} months`;
  return `Frequency: ${rule.label} ${rule.count}× ${window}${last ? ` (last ${last})` : ' (already in this plan)'}`;
}

// Estimates insurance vs patient portion for a list of procedures, applying the plan: in-network fees,
// frequency limits, waiting periods, alternate benefits (downgrades), per-code coverage, the deductible
// (individual and family), the annual maximum, and the orthodontic lifetime maximum.
// For a secondary policy, pass `primary`: procedure id → { covered, write_off } from the primary claim.
export async function estimateCoverage(db, rawPolicy, procedures, { primary = null, asOf = null } = {}) {
  if (!rawPolicy) {
    return {
      policy: null,
      items: procedures.map((p) => ({ procedure_id: p.id, fee: p.fee, allowed: p.fee, write_off: 0, deductible: 0, insurance: 0, patient: p.fee, notes: [] })),
      total_fee: procedures.reduce((s, p) => s + p.fee, 0),
      total_write_off: 0,
      total_deductible: 0,
      total_insurance: 0,
      total_patient: procedures.reduce((s, p) => s + p.fee, 0),
    };
  }
  const policy = await withPlan(db, rawPolicy);
  const plan = policy.plan;
  // asOf: price the work as if done on another day (e.g. once the benefit year renews).
  const today = asOf || (await practiceNow(db, policy.practice_id)).slice(0, 10);
  // In-network (PPO) carriers pay from their fee schedule; the difference is written off.
  const scheduleId = policy.fee_schedule_id ?? (await db.get('SELECT fee_schedule_id FROM insurance_carriers WHERE id = ?', policy.carrier_id))?.fee_schedule_id;
  const scheduleFee = async (code) => (scheduleId ? (await db.get('SELECT fee FROM fee_schedule_items WHERE fee_schedule_id = ? AND code = ?', scheduleId, code))?.fee : null);
  const officeFee = async (code) => (await db.get('SELECT fee FROM procedure_codes WHERE practice_id = ? AND code = ?', policy.practice_id, code))?.fee;
  const allowedFor = async (p) => {
    const f = await scheduleFee(p.code);
    return f != null ? Math.min(f, p.fee) : p.fee;
  };
  const freqs = json(plan.frequencies, DEFAULT_FREQUENCIES);
  const overrides = json(plan.coverage_overrides, {});
  const patient = await db.get('SELECT dob FROM patients WHERE id = ?', procedures[0]?.patient_id ?? policy.patient_id);

  let remainingMax = Math.max(0, policy.annual_max - (await benefitsUsed(db, policy, today)));
  let remainingDeductible = Math.max(0, policy.deductible - deductibleMet(policy, today));
  if (plan.family_deductible > 0) remainingDeductible = Math.min(remainingDeductible, Math.max(0, plan.family_deductible - (await familyDeductibleMet(db, policy, today))));
  let remainingOrtho = plan.ortho_max > 0 ? Math.max(0, plan.ortho_max - (await orthoUsed(db, policy))) : 0;

  const earlier = [];
  const ids = new Set(procedures.map((p) => p.id));
  const items = await mapSeq(procedures, async (p) => {
    const notes = [];
    const dos = (p.completed_at || today).slice(0, 10);
    const tier = coverageTier(p.category);
    const ortho = p.category === 'orthodontics';
    const contracted = await allowedFor(p);
    let writeOff = p.fee - contracted;
    let covered = true;
    // Percentage: a per-code override, else ortho or the category tier.
    const override = longestPrefix(overrides, p.code);
    let pct = override != null ? overrides[override] : ortho ? plan.ortho_pct ?? 50 : policy[`pct_${tier}`] ?? 0;
    if (override != null) notes.push(`${pct}% for ${override}`);

    const freq = await frequencyProblem(db, policy, freqs, p, dos, earlier, ids);
    if (freq) {
      covered = false;
      notes.push(freq);
    }
    const wait = tier === 'major' ? plan.wait_major_months : tier === 'basic' ? plan.wait_basic_months : 0;
    if (covered && wait > 0 && policy.effective_date && dos < addMonths(policy.effective_date, wait)) {
      covered = false;
      notes.push(`Waiting period: ${tier} work is covered from ${addMonths(policy.effective_date, wait)}`);
    }
    if (covered && ortho) {
      const age = patient?.dob ? Math.floor((Date.parse(dos) - Date.parse(patient.dob)) / (365.25 * 86400_000)) : null;
      if (!(plan.ortho_max > 0)) {
        covered = false;
        notes.push('Orthodontics is not covered by this plan');
      } else if (plan.ortho_age_limit && age != null && age >= plan.ortho_age_limit) {
        covered = false;
        notes.push(`Orthodontics covered only under age ${plan.ortho_age_limit}`);
      }
    }
    // Alternate benefit: posterior composites paid as amalgam.
    let base = contracted;
    if (covered && plan.downgrade_composites && AMALGAM_FOR[p.code] && POSTERIOR.has(String(p.tooth || '').toUpperCase())) {
      const alt = AMALGAM_FOR[p.code];
      const altFee = (await scheduleFee(alt)) ?? (await officeFee(alt));
      if (altFee != null && altFee < base) {
        base = altFee;
        notes.push(`Paid as amalgam (${alt}, ${(altFee / 100).toFixed(2)}): posterior composite downgrade`);
      }
    }

    let deductible = 0;
    let insurance = 0;
    if (covered) {
      if (tier !== 'preventive' && !ortho && remainingDeductible > 0) {
        deductible = Math.min(remainingDeductible, base);
        remainingDeductible -= deductible;
      }
      insurance = Math.round(((base - deductible) * pct) / 100);
      if (ortho) {
        if (insurance > remainingOrtho) notes.push('Limited by the orthodontic lifetime maximum');
        insurance = Math.min(insurance, remainingOrtho);
        remainingOrtho -= insurance;
      }
    }
    let owed = contracted;
    const prior = primary?.get(p.id);
    if (prior) {
      // Coordination of benefits: the primary's allowed amount stands and its write-off isn't repeated.
      owed = Math.max(0, p.fee - prior.write_off - prior.covered);
      writeOff = 0;
      insurance = Math.min(insurance, owed);
    }
    if (!ortho) {
      if (insurance > remainingMax) notes.push('Limited by the annual maximum');
      insurance = Math.min(insurance, remainingMax);
      remainingMax -= insurance;
    }
    earlier.push(p);
    return {
      procedure_id: p.id, code: p.code, fee: p.fee, allowed: prior ? p.fee - prior.write_off : contracted, write_off: writeOff, tier, pct, deductible, insurance,
      primary_covered: prior?.covered ?? 0, patient: owed - insurance, covered, notes,
    };
  });
  const sum = (k) => items.reduce((s, i) => s + i[k], 0);
  return {
    policy: { id: policy.id, carrier_name: policy.carrier_name, annual_max: policy.annual_max, plan_id: plan.id },
    items,
    total_fee: sum('fee'),
    total_write_off: sum('write_off'),
    total_deductible: sum('deductible'),
    total_insurance: sum('insurance'),
    total_patient: sum('patient'),
    remaining: { annual_max: remainingMax, deductible: remainingDeductible, ortho: plan.ortho_max > 0 ? remainingOrtho : null },
  };
}

// Applies an edit to a policy: benefit fields go to its plan (and so to everyone on it), the rest to the
// policy itself. A new policy joins the plan for its carrier and group number, or starts a new one.
export async function savePolicy(db, practiceId, policyId, row) {
  const planFields = Object.fromEntries(Object.entries(row).filter(([k]) => PLAN_BENEFITS.includes(k) && !SYNCED_READONLY.includes(k)));
  const own = Object.fromEntries(Object.entries(row).filter(([k]) => !PLAN_BENEFITS.includes(k) || k === 'benefit_month'));
  let policy = policyId ? await db.get('SELECT * FROM patient_insurance WHERE id = ?', policyId) : null;
  let planId = row.plan_id ?? policy?.plan_id ?? null;
  if (planId) {
    const plan = await db.get('SELECT id, carrier_id FROM insurance_plans WHERE id = ? AND practice_id = ?', planId, practiceId);
    if (!plan) throw new HttpError(404, 'Insurance plan not found');
    if (row.carrier_id && Number(row.carrier_id) !== plan.carrier_id && !row.plan_id) planId = null; // switched carrier: a different plan
  }
  if (!planId) {
    const carrierId = row.carrier_id ?? policy?.carrier_id;
    const group = row.group_number ?? policy?.group_number ?? null;
    const existing = group ? await db.get('SELECT id FROM insurance_plans WHERE practice_id = ? AND carrier_id = ? AND group_number = ? ORDER BY id LIMIT 1', practiceId, carrierId, group) : null;
    planId = existing?.id ?? await insert(db, 'insurance_plans', {
      practice_id: practiceId, carrier_id: carrierId, group_number: group,
      ...Object.fromEntries(SYNCED.map((k) => [k, row[k] ?? policy?.[k] ?? PLAN_DEFAULTS[k]])),
      frequencies: JSON.stringify(DEFAULT_FREQUENCIES),
    });
  }
  if (Object.keys(planFields).length) {
    validatePlan(planFields);
    await db.run(`UPDATE insurance_plans SET ${Object.keys(planFields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(planFields), planId);
  }
  const fields = { ...own, plan_id: planId };
  delete fields.benefit_month;
  if (policy) await db.run(`UPDATE patient_insurance SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(fields), policy.id);
  else policyId = await insert(db, 'patient_insurance', { ...fields, practice_id: practiceId });
  if (row.benefit_month != null) await db.run('UPDATE insurance_plans SET benefit_month = ? WHERE id = ?', Number(row.benefit_month), planId);
  await syncPlan(db, planId);
  return policyId;
}
const SYNCED_READONLY = [];
const PLAN_DEFAULTS = { annual_max: 150000, deductible: 5000, pct_preventive: 100, pct_basic: 80, pct_major: 50, benefit_month: 1 };
