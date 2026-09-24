import { HttpError } from './auth.js';
import { insert, audit, recorded, practiceNow } from './util.js';
import { currentActor } from './actor.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { PLAN_BENEFITS, validatePlan, syncPlan, planFor, benefitYear } from './benefits.js';
import { parse271Detail } from './benefitdetail.js';

// ---- A verified benefit breakdown, applied (IV2, IV3) ----
// A breakdown someone (or the payer's 271) verified for one patient belongs to their employer group's plan,
// so it updates every patient on that plan at once — nobody verifies the same plan twice. What is the
// patient's own (the maximum used and left, the deductible met, the services already used) stays theirs.
//
// The guard: the plan is only changed for everyone when it is certainly this patient's plan — the policy and
// the plan are with the same payer and carry the same group number, and whatever the source says the group
// number is agrees. Otherwise the plan-level changes wait on a review list for a person (and Needs attention),
// and nothing on the plan changes. Other plan records that share the group number are never changed on
// their own either: they are named on the review so a person can decide.
//
// Every change goes through recorded() (before → after in the audit trail, with who or what did it: a person,
// the payer's answer, the nightly job, or the AI read a person confirmed), and a benefit_verifications row
// says how it was verified, by whom, and how many patients it updated.

export const METHODS = ['electronic', 'sandbox', 'phone', 'portal', 'fax', 'document_ai', 'manual'];
export const METHOD_LABELS = {
  electronic: 'Electronic (271)', sandbox: 'Electronic (sandbox)', phone: 'Phone call', portal: 'Payer portal', fax: 'Fax', document_ai: 'Document read by AI, confirmed', manual: 'Entered by hand',
};
// Plan-level: the same for everyone on the employer group. (Notes and the fee schedule aren't verified here.)
export const PLAN_LEVEL = PLAN_BENEFITS.filter((k) => !['benefit_notes', 'fee_schedule_id'].includes(k));
// The patient's own figures, kept on the verification (and the deductible met on their policy).
export const PATIENT_LEVEL = ['max_used', 'max_remaining', 'deductible_met', 'deductible_remaining', 'family_deductible_remaining', 'ortho_remaining', 'history', 'plan_begin', 'plan_end'];

const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const json = (v, fallback = null) => {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};
// Frequencies and overrides are compared as stored (JSON text), everything else by value.
const same = (a, b) => String(a ?? '') === String(b ?? '');

// Is the plan on file certainly this patient's plan? evidence: what the source says (group_number…).
export async function planIdentity(db, policy, evidence = {}) {
  const plan = await planFor(db, policy);
  const reasons = [];
  if (plan.carrier_id !== policy.carrier_id) reasons.push('the policy and the plan on file are with different insurance companies');
  const pg = norm(policy.group_number);
  const lg = norm(plan.group_number);
  const eg = norm(evidence.group_number);
  if (pg !== lg) reasons.push(`the patient’s group number (${policy.group_number || 'none'}) isn’t the plan’s (${plan.group_number || 'none'})`);
  if (eg && lg && eg !== lg) reasons.push(`the payer says group ${evidence.group_number}; the plan on file is group ${plan.group_number}`);
  const members = await db.all('SELECT id, patient_id, subscriber_id FROM patient_insurance WHERE plan_id = ? AND active = 1', plan.id);
  // No group number: it can only be told apart when everyone on it is one family (the same subscriber).
  if (!lg && new Set(members.map((m) => norm(m.subscriber_id))).size > 1) reasons.push('the plan has no group number, so it can’t be told apart from other plans with this payer');
  const siblings = lg
    ? (await db.all('SELECT id, name, group_number FROM insurance_plans WHERE practice_id = ? AND carrier_id = ? AND id != ? AND active = 1', policy.practice_id, plan.carrier_id, plan.id)).filter((p) => norm(p.group_number) === lg)
    : [];
  return { ok: !reasons.length, reasons, plan, members: new Set(members.map((m) => m.patient_id)).size, siblings };
}

// The plan-level fields in `fields` that differ from the plan: { field: [before, after] } (after as stored).
export function planDiff(plan, fields) {
  const row = validatePlan(Object.fromEntries(Object.entries(fields || {}).filter(([k, v]) => PLAN_LEVEL.includes(k) && v !== undefined)));
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const now = k === 'frequencies' || k === 'coverage_overrides' || k === 'age_limits' ? (plan[k] ? JSON.stringify(json(plan[k])) : null) : plan[k];
    if (!same(now, v)) out[k] = [plan[k] ?? null, v];
  }
  return out;
}

const patientName = async (db, id) => {
  const p = await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', id);
  return p ? `${p.first_name} ${p.last_name}` : 'a patient';
};

// Applies a verified breakdown. o: {
//   policy, method, planFields ({ plan column: value }), patientFields ({ max_remaining, deductible_met, history… }),
//   evidence ({ group_number, plan_name, payer_name… }), complete (a full breakdown), checkId, documentId, readId,
//   reference, repName, notes, userId, force (a person decided after review: apply even if the identity isn't certain) }
// Returns { id, group_status, patients_updated, plan_changes, reasons, siblings }.
export async function applyVerification(db, o) {
  const { policy } = o;
  if (!METHODS.includes(o.method)) throw new HttpError(400, `method must be one of ${METHODS.join(', ')}`);
  const identity = await planIdentity(db, policy, o.evidence || {});
  const plan = identity.plan;
  const changes = planDiff(plan, o.planFields);
  const certain = identity.ok || !!o.force;
  const ctx = currentActor();
  const source = ctx?.source || 'automation';
  const today = (await practiceNow(db, policy.practice_id)).slice(0, 10);
  let groupStatus = 'none';
  let patientsUpdated = 0;
  const pending = Object.keys(changes).length > 0;

  const id = await db.tx(async () => {
    if (certain && (pending || o.complete)) {
      const set = { ...Object.fromEntries(Object.entries(changes).map(([k, [, v]]) => [k, v])) };
      if (o.complete) Object.assign(set, { verified_at: new Date().toISOString().slice(0, 19).replace('T', ' '), verified_source: SOURCE_OF[o.method] || o.method });
      await recorded(db, 'insurance_plans', plan.id, () => db.run(`UPDATE insurance_plans SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(set), plan.id));
      await syncPlan(db, plan.id);
      groupStatus = o.force ? 'applied_after_review' : 'applied';
      patientsUpdated = identity.members;
    } else if (pending) groupStatus = 'review';
    // The patient's own deductible met this benefit year goes on their policy (estimates use it).
    const met = o.patientFields?.deductible_met;
    if (met != null && Number.isFinite(Number(met)) && Number(met) >= 0 && Number(met) !== policy.deductible_met) {
      const year = benefitYear({ benefit_month: plan.benefit_month }, today).start;
      await recorded(db, 'patient_insurance', policy.id, () => db.run('UPDATE patient_insurance SET deductible_met = ?, deductible_year = ? WHERE id = ?', Math.round(Number(met)), year, policy.id));
    }
    const patientDetail = Object.fromEntries(PATIENT_LEVEL.filter((k) => o.patientFields?.[k] != null).map((k) => [k, o.patientFields[k]]));
    return await insert(db, 'benefit_verifications', {
      practice_id: policy.practice_id, patient_id: policy.patient_id, patient_insurance_id: policy.id, plan_id: plan.id,
      location_id: (await db.get('SELECT location_id FROM patients WHERE id = ?', policy.patient_id))?.location_id ?? null,
      method: o.method, eligibility_check_id: o.checkId ?? null, document_id: o.documentId ?? null, read_id: o.readId ?? null, complete: o.complete ? 1 : 0,
      plan_changes: groupStatus === 'review' ? null : JSON.stringify(changes), proposed: groupStatus === 'review' ? JSON.stringify(changes) : null,
      patient_detail: Object.keys(patientDetail).length ? JSON.stringify(patientDetail) : null, evidence: o.evidence && Object.keys(o.evidence).length ? JSON.stringify(o.evidence) : null,
      review_reasons: groupStatus === 'review' ? JSON.stringify(identity.reasons) : null,
      group_status: groupStatus, patients_updated: patientsUpdated, reference: clip(o.reference, 80), rep_name: clip(o.repName, 80), notes: clip(o.notes, 1000),
      source, actor: ctx?.actor || null, verified_by: source === 'human' || source === 'ai' ? o.userId ?? ctx?.userId ?? null : null,
    });
  });

  const who = await patientName(db, policy.patient_id);
  const before = Object.fromEntries(Object.entries(changes).map(([k, [b]]) => [k, b]));
  const after = Object.fromEntries(Object.entries(changes).map(([k, [, a]]) => [k, a]));
  await audit(db, null, groupStatus === 'review' ? 'benefits.verify_review' : 'benefits.verify', 'insurance_plans', plan.id, {
    verification_id: id, method: o.method, policy_id: policy.id, group_status: groupStatus, patients_updated: patientsUpdated, complete: !!o.complete,
    reference: o.reference || null, rep_name: o.repName || null, patient_id: policy.patient_id,
  }, {
    ...(groupStatus === 'review' ? {} : { before, after }), patientId: policy.patient_id,
    reason: groupStatus === 'review'
      ? `Benefits verified for ${who} (${METHOD_LABELS[o.method]}); the plan wasn’t changed because ${identity.reasons.join('; ')}`
      : `Benefits verified for ${who} (${METHOD_LABELS[o.method]}${o.reference ? `, reference ${o.reference}` : ''}${o.repName ? `, ${o.repName}` : ''})${patientsUpdated > 1 ? `; applied to all ${patientsUpdated} patients on the plan` : ''}`,
  });
  if (groupStatus === 'review') {
    await raiseIssue(db, {
      practiceId: policy.practice_id, kind: 'eligibility', key: `plan-review:${id}`, role: 'billing', entity: 'benefit_verifications', entityId: id, patientId: policy.patient_id,
      title: `Plan benefits to review before they update the group: ${who}`, detail: identity.reasons.join('; '),
    });
  }
  return { id, group_status: groupStatus, patients_updated: patientsUpdated, plan_changes: changes, reasons: identity.ok ? [] : identity.reasons, siblings: identity.siblings, plan_id: plan.id };
}
const clip = (v, n) => (v == null || v === '' ? null : String(v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n) || null);
// insurance_plans.verified_source keeps its older vocabulary (the plan form shows it).
const SOURCE_OF = { electronic: 'eligibility', sandbox: 'eligibility', document_ai: 'ai_read', phone: 'phone', portal: 'portal', fax: 'fax', manual: 'manual' };

// A person decided about a change waiting for review: apply it to this plan (and, if they choose, to other
// plan records of the same group), or keep what's on file. Only the first decision counts.
export async function decideReview(db, verificationId, { apply, planIds = [], userId, userName, note = null }) {
  const v = await db.get('SELECT * FROM benefit_verifications WHERE id = ?', verificationId);
  if (!v) throw new HttpError(404, 'Review not found');
  if (v.group_status !== 'review') throw new HttpError(409, 'That change was already decided');
  const changes = json(v.proposed, {});
  const fields = Object.fromEntries(Object.entries(changes).map(([k, [, a]]) => [k, a]));
  const targets = [v.plan_id, ...planIds.map(Number).filter((n) => n && n !== v.plan_id)];
  let updated = 0;
  const applied = [];
  await db.tx(async () => {
    // Claimed first, so a double click or a second person can't apply it twice.
    const took = await db.run("UPDATE benefit_verifications SET group_status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ? AND group_status = 'review'",
      apply ? 'applied_after_review' : 'kept', userId ?? null, clip(note, 500), v.id);
    if (!took.changes) throw new HttpError(409, 'That change was already decided');
    if (!apply) return;
    for (const pid of targets) {
      const plan = await db.get('SELECT * FROM insurance_plans WHERE id = ? AND practice_id = ?', pid, v.practice_id);
      if (!plan) throw new HttpError(404, 'Plan not found');
      const diff = planDiff(plan, fields);
      const set = { ...Object.fromEntries(Object.entries(diff).map(([k, [, a]]) => [k, a])), ...(v.complete ? { verified_at: new Date().toISOString().slice(0, 19).replace('T', ' '), verified_source: SOURCE_OF[v.method] || v.method } : {}) };
      if (Object.keys(set).length) await recorded(db, 'insurance_plans', plan.id, () => db.run(`UPDATE insurance_plans SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(set), plan.id));
      await syncPlan(db, plan.id);
      updated += new Set((await db.all('SELECT patient_id FROM patient_insurance WHERE plan_id = ? AND active = 1', plan.id)).map((m) => m.patient_id)).size;
      applied.push(plan.id);
    }
    await db.run('UPDATE benefit_verifications SET patients_updated = ?, plan_changes = ? WHERE id = ?', updated, apply ? v.proposed : null, v.id);
  });
  await audit(db, null, apply ? 'benefits.review_apply' : 'benefits.review_keep', 'benefit_verifications', v.id, { plan_ids: applied, patients_updated: updated, patient_id: v.patient_id }, {
    patientId: v.patient_id, reason: apply ? `Reviewed by ${userName} and applied to ${updated} patient${updated === 1 ? '' : 's'}${note ? `: ${note}` : ''}` : `Reviewed by ${userName}; kept what’s on file${note ? `: ${note}` : ''}`,
  });
  await resolveIssue(db, v.practice_id, `plan-review:${v.id}`, apply ? `Applied to ${updated} patient${updated === 1 ? '' : 's'} by ${userName}` : `Kept what’s on file (${userName})`);
  return { patients_updated: updated, plan_ids: applied };
}

// The breakdown in a payer's 271, applied after the eligibility answer itself was (eligibility.js calls this):
// what parse271 always applied is already on the plan, so this adds the rest — per-category percentages,
// waiting periods, the family deductible, ortho, clauses — and records the verification with the patient's
// own amounts. A response with no breakdown in it records nothing here.
export async function recordElectronicBreakdown(db, check, { sandbox = false, force = false } = {}) {
  if (!check?.response_x12) return null;
  let detail;
  try {
    detail = parse271Detail(check.response_x12);
  } catch {
    return null;
  }
  if (!detail.active) return null;
  const policy = await db.get('SELECT * FROM patient_insurance WHERE id = ?', check.patient_insurance_id);
  const plan = await planFor(db, policy);
  // The sandbox makes its answer up from the policy on file; the extras it adds (an ortho maximum, a family
  // deductible) aren't the plan's, so they never change it.
  const planFields = sandbox ? Object.fromEntries(Object.entries(detail.plan).filter(([k]) => SANDBOX_FIELDS.includes(k))) : { ...detail.plan };
  // Payer frequencies replace the plan's rule for the same procedures (the rest of the plan's rules stay).
  if (planFields.frequencies) {
    const { mergeFrequencies } = await import('./eligibility.js');
    planFields.frequencies = mergeFrequencies(json(plan.frequencies), planFields.frequencies);
  }
  const hasPlan = Object.keys(planDiff(plan, planFields)).length > 0;
  if (!detail.complete && !hasPlan) return null;
  return await applyVerification(db, {
    policy, method: sandbox ? 'sandbox' : 'electronic', planFields, patientFields: detail.patient, evidence: detail.identity, complete: detail.complete,
    checkId: check.id, force,
  });
}

const SANDBOX_FIELDS = ['annual_max', 'deductible', 'pct_preventive', 'pct_basic', 'pct_major', 'frequencies'];

// What the source says identifies the plan, from a 271 (for the guard before anything is applied).
export function evidenceOf(check) {
  if (!check?.response_x12) return {};
  try { return parse271Detail(check.response_x12).identity; } catch { return {}; }
}
