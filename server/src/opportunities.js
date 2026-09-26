// Opportunity finder (OF1–OF3): work a patient is due for that nobody has booked yet — sealants, fluoride,
// x-rays, perio maintenance instead of a prophy, scaling on deep pockets, Arestin, a night guard, unscheduled
// treatment, an overdue recall — checked against the patient's history, chart, perio readings and insurance, and
// shown on the visit so the hygienist can add it with one click.
//
// The office's rules (opportunity_rules) are configuration: codes (JSON list), where they apply (whole mouth, per
// tooth, per quadrant), ages, how often (months since any of the codes was last done) and chart conditions. A rule
// is retired (active = 0), never deleted. What was offered, added or turned down on each visit is in
// opportunity_events (one row per visit and rule) so the capture report can show offered → accepted → done.
//
// These are suggestions for a person to act on: nothing is charted until someone clicks "Add to today", and then
// only as planned work (no charge until it's completed through the normal path).
import { HttpError } from './auth.js';
import { addMonths } from './util.js';
import { estimateCoverage, primaryPolicy } from './services.js';
import { withPlan, benefitYear, DEFAULT_FREQUENCIES } from './benefits.js';
import { officeFee } from './fees.js';
import { DEFAULT_RECALL_TYPES } from './recalls.js';

export const CONDITIONS = {
  unsealed_permanent_molars: 'Permanent first or second molars not sealed, restored, decayed or missing',
  pockets_4mm_plus: 'Pockets of 4 mm or more on the latest perio exam (per quadrant)',
  pockets_5mm_plus: 'Sites of 5 mm or more on the latest perio exam (per tooth)',
  prior_srp: 'Has had scaling and root planing (or perio maintenance) before',
  high_caries_risk: 'Latest caries risk assessment is high or extreme',
  bruxism: 'Grinding or clenching noted (medical history, alerts or notes in the last 2 years)',
  unscheduled_treatment: 'Planned treatment not booked on any visit',
  recall_overdue: 'A recall is past due and not booked',
};
export const SCOPES = ['mouth', 'tooth', 'quadrant'];
const TOOTH_CONDITIONS = ['unsealed_permanent_molars', 'pockets_5mm_plus'];

// The starter set (seeded on demand, once per key; the office edits or retires them like any rule).
export const STARTER_RULES = [
  { starter_key: 'sealants', name: 'Sealants on permanent molars', codes: ['D1351'], scope: 'tooth', age_min: 6, age_max: 15, frequency_months: null, conditions: ['unsealed_permanent_molars'], note: 'First and second molars with no sealant, filling, crown, decay or extraction on the chart.' },
  { starter_key: 'fluoride_child', name: 'Fluoride varnish (under 19)', codes: ['D1206', 'D1208'], scope: 'mouth', age_min: null, age_max: 18, frequency_months: 6, conditions: [] },
  { starter_key: 'fluoride_risk', name: 'Fluoride for high caries risk (adults)', codes: ['D1206', 'D1208'], scope: 'mouth', age_min: 19, age_max: null, frequency_months: 3, conditions: ['high_caries_risk'] },
  { starter_key: 'fmx', name: 'Full-mouth x-rays', codes: ['D0210'], scope: 'mouth', age_min: 12, age_max: null, frequency_months: 60, conditions: [] },
  { starter_key: 'bitewings', name: 'Bitewings', codes: ['D0274', 'D0272'], scope: 'mouth', age_min: 5, age_max: null, frequency_months: 12, conditions: [] },
  { starter_key: 'pano', name: 'Panoramic x-ray', codes: ['D0330'], scope: 'mouth', age_min: 6, age_max: null, frequency_months: 60, conditions: [] },
  { starter_key: 'perio_maint', name: 'Perio maintenance instead of a prophy', codes: ['D4910'], replaces: ['D1110', 'D1120'], scope: 'mouth', age_min: null, age_max: null, frequency_months: 3, conditions: ['prior_srp'], note: 'Scaling and root planing on record: bill perio maintenance, not a prophy.' },
  { starter_key: 'srp', name: 'Scaling and root planing (4 mm+ pockets)', codes: ['D4341', 'D4342'], scope: 'quadrant', age_min: null, age_max: null, frequency_months: 24, conditions: ['pockets_4mm_plus'], note: 'D4341 for 4 or more teeth in the quadrant, D4342 for 1–3.' },
  { starter_key: 'arestin', name: 'Arestin on 5 mm+ sites', codes: ['D4381'], scope: 'tooth', age_min: null, age_max: null, frequency_months: 3, conditions: ['pockets_5mm_plus'] },
  { starter_key: 'night_guard', name: 'Night guard (bruxism)', codes: ['D9944'], scope: 'mouth', age_min: 13, age_max: null, frequency_months: 60, conditions: ['bruxism'] },
  { starter_key: 'unscheduled', name: 'Unscheduled treatment', codes: [], scope: 'mouth', age_min: null, age_max: null, frequency_months: null, conditions: ['unscheduled_treatment'] },
  { starter_key: 'recall', name: 'Overdue recall', codes: [], scope: 'mouth', age_min: null, age_max: null, frequency_months: null, conditions: ['recall_overdue'], note: 'Adds the overdue recall’s own procedure (e.g. the prophy) to this visit.' },
];

const MOLARS = ['2', '3', '14', '15', '18', '19', '30', '31'];
const HYGIENE = ['D1110', 'D1120', 'D4910', 'D4341', 'D4342', 'D4346', 'D4355'];
const quadrantOf = (tooth) => {
  const n = Number(tooth);
  if (!Number.isInteger(n) || n < 1 || n > 32) return null;
  return n <= 8 ? 'UR' : n <= 16 ? 'UL' : n <= 24 ? 'LL' : 'LR';
};
const parse = (v, fallback) => {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};
const matches = (code, list) => list.some((c) => String(code || '').startsWith(c));
const ageOn = (dob, date) => {
  if (!dob || !/^\d{4}-\d{2}-\d{2}/.test(dob)) return null;
  let age = Number(date.slice(0, 4)) - Number(dob.slice(0, 4));
  if (date.slice(5, 10) < dob.slice(5, 10)) age--;
  return age;
};
const $ = (c) => `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- Rules ----

export const ruleView = (r) => ({
  ...r, codes: parse(r.codes, []), conditions: parse(r.conditions, []), replaces: parse(r.replaces, []), active: !!r.active,
});

// Validates a rule from the settings screen. Codes must be codes the practice has (or the starter's), conditions
// known, ages and months sensible, and tooth/quadrant rules need a condition that says which teeth.
export async function validateRule(db, practiceId, input, existing = null) {
  const b = { ...(existing ? ruleView(existing) : {}), ...input };
  const out = {};
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 80) throw new HttpError(400, 'Give the opportunity a name (up to 80 characters)');
  out.name = name;
  const codeList = (v, what) => {
    const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
    const clean = [...new Set(list.map((c) => String(c).trim().toUpperCase()).filter(Boolean))];
    if (clean.length > 12) throw new HttpError(400, `Up to 12 ${what}`);
    for (const c of clean) if (!/^D\d{4}$/.test(c)) throw new HttpError(400, `${c} isn't a procedure code (D followed by 4 digits)`);
    return clean;
  };
  out.codes = codeList(b.codes, 'codes');
  out.replaces = codeList(b.replaces ?? [], 'codes to replace');
  const conditions = Array.isArray(b.conditions) ? [...new Set(b.conditions.map(String))] : [];
  for (const c of conditions) if (!(c in CONDITIONS)) throw new HttpError(400, `Unknown condition ${c.slice(0, 40)}`);
  out.conditions = conditions;
  const special = conditions.includes('unscheduled_treatment') || conditions.includes('recall_overdue');
  if (!out.codes.length && !special) throw new HttpError(400, 'List at least one procedure code');
  out.scope = b.scope || 'mouth';
  if (!SCOPES.includes(out.scope)) throw new HttpError(400, 'scope must be mouth, tooth or quadrant');
  if (out.scope === 'tooth' && !conditions.some((c) => TOOTH_CONDITIONS.includes(c))) throw new HttpError(400, 'A per-tooth opportunity needs a condition that picks the teeth (unsealed molars, or 5 mm+ sites)');
  if (out.scope === 'quadrant' && !conditions.includes('pockets_4mm_plus')) throw new HttpError(400, 'A per-quadrant opportunity needs the 4 mm+ pockets condition');
  const int = (v, lo, hi, what) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${what} must be a whole number from ${lo} to ${hi}`);
    return n;
  };
  out.age_min = int(b.age_min, 0, 120, 'Minimum age');
  out.age_max = int(b.age_max, 0, 120, 'Maximum age');
  if (out.age_min != null && out.age_max != null && out.age_min > out.age_max) throw new HttpError(400, 'The minimum age is above the maximum');
  out.frequency_months = int(b.frequency_months, 1, 240, 'How often (months)');
  out.note = b.note == null ? null : String(b.note).trim().slice(0, 300) || null;
  out.sort = int(b.sort, 0, 9999, 'Order') ?? 0;
  const known = new Set((await db.all('SELECT code FROM procedure_codes WHERE practice_id = ?', practiceId)).map((c) => c.code));
  const missing = out.codes.filter((c) => !known.has(c));
  if (out.codes.length && missing.length === out.codes.length) throw new HttpError(400, `None of ${out.codes.join(', ')} is in your procedure codes yet — add the code first`);
  return { ...out, codes: JSON.stringify(out.codes), replaces: JSON.stringify(out.replaces), conditions: JSON.stringify(out.conditions) };
}

export async function loadRules(db, practiceId, { all = false } = {}) {
  const rows = await db.all(`SELECT * FROM opportunity_rules WHERE practice_id = ?${all ? '' : ' AND active = 1'} ORDER BY sort, id`, practiceId);
  return rows.map(ruleView);
}

// ---- What we know about a patient ----

async function loadPatient(db, practiceId, patientId, date) {
  const patient = await db.get('SELECT id, practice_id, first_name, last_name, dob, location_id, medical_alerts, medical_conditions, notes, office_alert FROM patients WHERE id = ? AND practice_id = ?', patientId, practiceId);
  if (!patient) throw new HttpError(404, 'Patient not found');
  const procedures = await db.all(
    `SELECT pr.id, pr.code, pr.tooth, pr.area, pr.status, pr.fee, pr.category, pr.description, pr.completed_at, pr.appointment_id, pr.treatment_plan_id, pr.provider_id, pr.patient_id,
       a.status AS appt_status, a.start_time AS appt_time, tp.status AS plan_status
     FROM real_procedures pr LEFT JOIN real_appointments a ON a.id = pr.appointment_id LEFT JOIN real_treatment_plans tp ON tp.id = pr.treatment_plan_id
     WHERE pr.practice_id = ? AND pr.patient_id = ? AND pr.status != 'cancelled'`, practiceId, patientId,
  );
  const conditions = await db.all('SELECT tooth, condition, notes FROM tooth_conditions WHERE practice_id = ? AND patient_id = ? AND voided_at IS NULL AND resolved = 0', practiceId, patientId);
  const perio = await db.get('SELECT id, exam_date, readings FROM perio_exams WHERE practice_id = ? AND patient_id = ? AND deleted_at IS NULL ORDER BY exam_date DESC, id DESC LIMIT 1', practiceId, patientId);
  const caries = await db.get("SELECT level, created_at FROM risk_assessments WHERE practice_id = ? AND patient_id = ? AND kind = 'caries' ORDER BY created_at DESC, id DESC LIMIT 1", practiceId, patientId);
  const recalls = await db.all('SELECT id, type, due_date, status, appointment_id FROM recalls WHERE practice_id = ? AND patient_id = ?', practiceId, patientId);
  const since = addMonths(date, -24);
  const notes = await db.all('SELECT body FROM clinical_notes WHERE practice_id = ? AND patient_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 40', practiceId, patientId, since);
  return { patient, procedures, conditions, perio: perio ? { ...perio, readings: parse(perio.readings, {}) } : null, caries, recalls, notes };
}

const lastDone = (history, codes, target = {}) => history
  .filter((p) => p.status === 'completed' && p.completed_at && matches(p.code, codes) && (!target.tooth || p.tooth === target.tooth) && (!target.area || p.area === target.area))
  .map((p) => p.completed_at.slice(0, 10)).sort().at(-1) || null;

// Chart facts behind the conditions, worked out once per patient.
function chartFacts(data, date) {
  const byTooth = new Map();
  const mark = (tooth, what) => {
    const t = String(tooth || '').toUpperCase();
    if (!t) return;
    if (!byTooth.has(t)) byTooth.set(t, new Set());
    byTooth.get(t).add(what);
  };
  for (const c of data.conditions) {
    if (c.condition === 'sealant') mark(c.tooth, 'sealed');
    else if (['filling', 'crown', 'root_canal', 'implant', 'bridge_pontic', 'veneer'].includes(c.condition)) mark(c.tooth, 'restored');
    else if (['missing', 'impacted'].includes(c.condition)) mark(c.tooth, 'missing');
    else if (c.condition === 'caries') mark(c.tooth, 'caries');
  }
  for (const p of data.procedures) {
    if (!p.tooth) continue;
    if (/^D135[12]/.test(p.code)) mark(p.tooth, p.status === 'completed' ? 'sealed' : 'planned');
    else if (/^D[236]/.test(p.code)) mark(p.tooth, p.status === 'completed' ? 'restored' : 'planned');
    else if (/^D7(1[1-4]\d|2[0-5]\d)$/.test(p.code)) mark(p.tooth, p.status === 'completed' ? 'missing' : 'planned');
  }
  const unsealed = MOLARS.filter((t) => !byTooth.get(t)?.size);
  // Deepest pocket per tooth on the latest exam.
  const deepest = new Map();
  for (const [tooth, v] of Object.entries(data.perio?.readings || {})) {
    if (v?.missing) continue;
    const max = Math.max(0, ...(Array.isArray(v?.pd) ? v.pd.filter((d) => d != null).map(Number) : []));
    if (max > 0) deepest.set(String(tooth).toUpperCase(), max);
  }
  const quadrants = new Map();
  for (const [tooth, d] of deepest) {
    if (d < 4) continue;
    const q = quadrantOf(tooth);
    if (!q) continue;
    if (!quadrants.has(q)) quadrants.set(q, []);
    quadrants.get(q).push(tooth);
  }
  const deep5 = [...deepest].filter(([, d]) => d >= 5).map(([t]) => t).sort((a, b) => Number(a) - Number(b));
  const text = [data.patient.medical_alerts, data.patient.medical_conditions, data.patient.notes, data.patient.office_alert, ...data.conditions.map((c) => c.notes), ...data.notes.map((n) => n.body)].filter(Boolean).join('\n');
  const srp = data.procedures.some((p) => p.status === 'completed' && matches(p.code, ['D4341', 'D4342', 'D4910']));
  const overdue = data.recalls.filter((r) => r.due_date < date && ['due', 'contacted'].includes(r.status));
  return {
    byTooth, unsealed, deepest, quadrants, deep5, srp, overdue,
    highRisk: ['high', 'extreme'].includes(data.caries?.level),
    bruxism: /brux|grind(s|ing)?\b|clench/i.test(text),
  };
}

// ---- Checking the rules ----

// Everything evaluate() needs from the practice, loaded once per request (a day's schedule reuses it).
export async function practiceContext(db, practiceId) {
  const codes = new Map((await db.all('SELECT * FROM procedure_codes WHERE practice_id = ? AND active = 1', practiceId)).map((c) => [c.code, c]));
  const typeRows = await db.all('SELECT key, name, codes, active FROM recall_types WHERE practice_id = ?', practiceId);
  const recallTypes = typeRows.length
    ? typeRows.map((t) => ({ ...t, codes: parse(t.codes, []) }))
    : DEFAULT_RECALL_TYPES.map(([key, name, , codes, active]) => ({ key, name, codes, active }));
  return { practiceId, codes, recallTypes, rules: await loadRules(db, practiceId) };
}

// The opportunities for one patient on one date (a visit, when given). estimate: price each with the patient's
// insurance (the panel); without it only fees are worked out (the day's schedule).
export async function evaluate(db, pc, { patientId, appointment = null, date, estimate = true, rules = null }) {
  const data = await loadPatient(db, pc.practiceId, patientId, date);
  const facts = chartFacts(data, date);
  const age = ageOn(data.patient.dob, date);
  const onVisit = appointment ? data.procedures.filter((p) => p.appointment_id === appointment.id) : [];
  const live = (p) => p.appointment_id && !['cancelled', 'no_show'].includes(p.appt_status);
  const feeFor = async (code) => officeFee(db, pc.practiceId, code, { patientId, providerId: appointment?.provider_id ?? null, locationId: appointment?.location_id ?? null });
  const available = (codes) => codes.map((c) => pc.codes.get(c)).filter(Boolean);
  let policy;
  const out = [];
  for (const rule of rules || pc.rules) {
    const conds = rule.conditions;
    if ((rule.age_min != null || rule.age_max != null) && age == null) continue;
    if (rule.age_min != null && age < rule.age_min) continue;
    if (rule.age_max != null && age > rule.age_max) continue;
    if (conds.includes('high_caries_risk') && !facts.highRisk) continue;
    if (conds.includes('bruxism') && !facts.bruxism) continue;
    if (conds.includes('prior_srp') && !facts.srp) continue;
    const why = [];
    if (age != null && (rule.age_min != null || rule.age_max != null)) why.push(`Age ${age}`);
    let targets = [];
    let replaced = [];
    if (conds.includes('unscheduled_treatment')) {
      const open = data.procedures.filter((p) => p.status === 'planned' && !live(p) && p.plan_status !== 'rejected' && (!rule.codes.length || matches(p.code, rule.codes)));
      if (!open.length) continue;
      targets = open.map((p) => ({ procedure_id: p.id, code: p.code, tooth: p.tooth, area: p.area, description: p.description, category: p.category, fee: p.fee }));
      why.push(`${open.length} planned ${open.length === 1 ? 'item' : 'items'} not booked: ${open.slice(0, 4).map((p) => `${p.code}${p.tooth ? ` #${p.tooth}` : p.area ? ` ${p.area}` : ''}`).join(', ')}${open.length > 4 ? '…' : ''}`);
    } else if (conds.includes('recall_overdue')) {
      if (onVisit.some((p) => matches(p.code, HYGIENE))) continue;
      const due = facts.overdue.filter((r) => r.appointment_id !== appointment?.id);
      if (!due.length) continue;
      const types = new Map(pc.recallTypes.map((t) => [t.key, t]));
      for (const r of due) {
        let code = rule.codes.length ? available(rule.codes)[0] : available(types.get(r.type)?.codes || [])[0];
        if (code?.code === 'D1110' && age != null && age < 14 && pc.codes.get('D1120')) code = pc.codes.get('D1120');
        if (!code || targets.some((t) => t.code === code.code) || onVisit.some((p) => p.code === code.code)) continue;
        if (data.procedures.some((p) => p.status === 'planned' && p.code === code.code && live(p))) continue;
        targets.push({ code: code.code, description: code.description, category: code.category, fee: await feeFor(code) });
        why.push(`${types.get(r.type)?.name || r.type} recall overdue since ${r.due_date}`);
      }
      if (!targets.length) continue;
    } else {
      const codes = available(rule.codes);
      if (!codes.length) continue;
      const planned = (t) => data.procedures.some((p) => p.status === 'planned' && matches(p.code, rule.codes) && (!t.tooth || p.tooth === t.tooth) && (!t.area || p.area === t.area));
      let spots = [{}];
      if (rule.scope === 'tooth') {
        const teeth = conds.includes('unsealed_permanent_molars') ? facts.unsealed : facts.deep5;
        spots = teeth.map((tooth) => ({ tooth }));
        if (conds.includes('unsealed_permanent_molars')) why.push(`Unsealed molars ${facts.unsealed.map((t) => `#${t}`).join(', ') || '—'}`);
        if (conds.includes('pockets_5mm_plus') && data.perio) why.push(`5 mm+ sites on ${facts.deep5.map((t) => `#${t}`).join(', ') || '—'} (exam ${data.perio.exam_date})`);
      } else if (rule.scope === 'quadrant') {
        spots = [...facts.quadrants.keys()].sort().map((area) => ({ area }));
        if (data.perio) why.push(`4 mm+ pockets: ${[...facts.quadrants].sort().map(([q, t]) => `${q} (${t.length} ${t.length === 1 ? 'tooth' : 'teeth'})`).join(', ') || '—'} (exam ${data.perio.exam_date})`);
      } else if (conds.includes('pockets_4mm_plus') && !facts.quadrants.size) continue;
      else if (conds.includes('pockets_5mm_plus') && !facts.deep5.length) continue;
      else if (conds.includes('unsealed_permanent_molars') && !facts.unsealed.length) continue;
      const last = [];
      for (const spot of spots) {
        if (planned(spot)) continue; // already on this visit, booked, or in a treatment plan
        const done = lastDone(data.procedures, rule.codes, spot);
        if (done && rule.frequency_months && addMonths(done, rule.frequency_months) > date) continue;
        // D4341 for 4+ teeth in a quadrant, D4342 for 1–3; otherwise the first code the office has.
        let code = codes[0];
        if (rule.scope === 'quadrant' && codes.length > 1) {
          const n = facts.quadrants.get(spot.area)?.length || 0;
          code = codes.find((c) => (n >= 4 ? c.code === 'D4341' : c.code === 'D4342')) || codes[0];
        }
        last.push(done);
        targets.push({ ...spot, code: code.code, description: code.description, category: code.category, fee: await feeFor(code) });
      }
      if (!targets.length) continue;
      if (conds.includes('high_caries_risk')) why.push(`High caries risk (${data.caries.level})`);
      if (conds.includes('bruxism')) why.push('Grinding or clenching noted');
      if (conds.includes('prior_srp')) why.push('Scaling and root planing on record');
      const known = last.filter(Boolean).sort();
      if (rule.scope === 'mouth') why.push(known.length ? `Last done ${known.at(-1)}${rule.frequency_months ? ` (every ${rule.frequency_months} months)` : ''}` : 'Never done here');
      else if (!known.length) why.push('Not done here before');
      replaced = rule.replaces.length ? onVisit.filter((p) => p.status === 'planned' && matches(p.code, rule.replaces)) : [];
      if (replaced.length) why.push(`In place of ${replaced.map((p) => p.code).join(', ')} on this visit`);
    }
    const fee = targets.reduce((s, t) => s + t.fee, 0);
    const opp = {
      rule_id: rule.id, name: rule.name, codes: [...new Set(targets.map((t) => t.code))], targets,
      replaces: replaced.map((p) => ({ procedure_id: p.id, code: p.code, fee: p.fee })),
      fee, added_fee: fee - replaced.reduce((s, p) => s + p.fee, 0),
      last_done: lastDone(data.procedures, rule.codes.length ? rule.codes : targets.map((t) => t.code)),
      reason: why.join(' · '), note: rule.note || null,
    };
    if (estimate) {
      if (policy === undefined) policy = (await primaryPolicy(db, pc.practiceId, patientId)) || null;
      opp.coverage = await coverageFor(db, policy, data, targets, date);
    }
    out.push(opp);
  }
  return { patient: { id: data.patient.id, name: `${data.patient.first_name} ${data.patient.last_name}`, age }, date, opportunities: out };
}

// When a plan's frequency limit reopens for a code on a tooth/quadrant: after the count-th most recent one
// ages out (or the next benefit year, for per-year limits).
function eligibleOn(policy, freqs, history, target, date) {
  const rule = freqs.find((f) => matches(target.code, f.codes));
  if (!rule) return null;
  if (rule.per === 'benefit_year') return benefitYear(policy, date).end;
  const done = history
    .filter((x) => x.status === 'completed' && x.completed_at && matches(x.code, rule.codes) && (!rule.per_tooth || !target.tooth || x.tooth === target.tooth) && (!rule.per_area || !target.area || x.area === target.area))
    .map((x) => x.completed_at.slice(0, 10)).sort().reverse();
  const nth = done[Math.max(0, Number(rule.count || 1) - 1)];
  return nth ? addMonths(nth, Number(rule.months)) : null;
}

// Insurance coverage and the patient's estimated cost, from the same estimate the rest of the system uses.
async function coverageFor(db, rawPolicy, data, targets, date) {
  const procs = targets.map((t, i) => ({
    id: t.procedure_id ?? null, preview: i, practice_id: data.patient.practice_id, patient_id: data.patient.id, code: t.code, category: t.category, tooth: t.tooth ?? null, area: t.area ?? null, fee: t.fee, status: 'planned',
  }));
  const est = await estimateCoverage(db, rawPolicy, procs, { asOf: date });
  const patientCost = est.total_patient;
  if (!rawPolicy) return { status: 'no_insurance', label: `No insurance · patient pays about ${$(patientCost)}`, insurance: 0, patient: patientCost, eligible_on: null, notes: [] };
  const policy = await withPlan(db, rawPolicy);
  const freqs = parse(policy.plan?.frequencies, DEFAULT_FREQUENCIES);
  const covered = est.items.filter((i) => i.covered && i.pct > 0);
  const notes = [...new Set(est.items.flatMap((i) => i.notes))];
  let eligible = null;
  for (const [i, item] of est.items.entries()) {
    if (item.covered) continue;
    const freq = item.notes.some((n) => n.startsWith('Frequency')) ? eligibleOn(policy, freqs, data.procedures, targets[i], date) : null;
    const wait = item.notes.map((n) => n.match(/covered from (\d{4}-\d{2}-\d{2})/)?.[1]).find(Boolean) || null;
    const on = freq || wait;
    if (on && (!eligible || on < eligible)) eligible = on;
  }
  const base = { insurance: est.total_insurance, patient: patientCost, notes, carrier: rawPolicy.carrier_name || null };
  if (covered.length === est.items.length) return { ...base, status: 'covered', label: `Covered · patient pays about ${$(patientCost)}`, eligible_on: null };
  if (covered.length) return { ...base, status: 'partly', label: `Partly covered · patient pays about ${$(patientCost)}`, eligible_on: eligible };
  if (eligible) return { ...base, status: 'not_yet', label: `Not covered yet — eligible on ${eligible}`, eligible_on: eligible };
  return { ...base, status: 'not_covered', label: `Not covered${notes[0] ? ` (${notes[0]})` : ''} · patient pays about ${$(patientCost)}`, eligible_on: null };
}
