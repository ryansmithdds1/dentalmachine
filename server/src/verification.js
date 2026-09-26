import { HttpError } from './auth.js';
import { insert, audit, localNow, zonedToUtc, newToken } from './util.js';
import { withActor } from './actor.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { benefitsUsed, benefitYear, planFor } from './benefits.js';
import { sendMessage, preferredChannel, recipientFor } from './messaging.js';
import { appointmentScope } from './officeaccess.js';
import { requireHuman } from './aiguard.js';
import { structured, aiClient } from './ai.js';
import { parse271Detail } from './benefitdetail.js';
import { applyVerification, METHOD_LABELS, PLAN_LEVEL, PATIENT_LEVEL, planDiff } from './planverify.js';
import { worklist } from './training.js';

// ---- Insurance verification center (IV1–IV4, docs/workflows/specs/IV-verification.md) ----
// Every upcoming patient has two statuses that answer "can we trust what's on file for this visit?":
//   eligibility — is coverage active (when checked, how, by whom);
//   breakdown   — the full benefit breakdown (percentages, maximums, deductibles, frequencies, waiting
//                 periods) verified recently, for their plan (by anyone, for anyone on the same plan).
// Eligibility runs by itself a few days before each visit and again the morning of (runVerificationAutomation);
// breakdowns come from the payer's 271 when it carries them, else from a portal page or fax read by AI and
// confirmed by a person field by field, or from a phone call. Only the exceptions need a person.

export const VERIFY_DEFAULTS = {
  days_ahead: 3, // eligibility this many days before each visit (0 = off)
  morning_of: true, // and again the morning of the visit
  morning_hour: 6, // from this hour, practice time
  eligibility_fresh_days: 30, // the same as the schedule's badge
  breakdown_stale_days: 180, // a breakdown older than this (or from before the benefit year renewed) is stale
  max_nearly_used_pct: 80, // an exception once this much of the annual maximum is used
  auto_request_insurance: false, // text the patient by itself when coverage comes back inactive
};
const LIMITS = { days_ahead: [0, 14], morning_hour: [0, 12], eligibility_fresh_days: [1, 120], breakdown_stale_days: [7, 730], max_nearly_used_pct: [50, 100] };

const json = (v, fallback = null) => {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};
export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const utcNow = (now = new Date()) => now.toISOString().slice(0, 19).replace('T', ' ');
const ageDays = (utc, now = Date.now()) => (utc ? Math.max(0, Math.floor((now - Date.parse(`${String(utc).slice(0, 19).replace(' ', 'T')}Z`)) / 86400_000)) : null);
const IN = (list) => list.map(() => '?').join(',');
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function verificationSettings(practice) {
  const saved = json(practice?.verification_settings, {}) || {};
  const out = { ...VERIFY_DEFAULTS };
  for (const k of Object.keys(VERIFY_DEFAULTS)) if (saved[k] !== undefined) out[k] = saved[k];
  return out;
}

export function validateSettings(body, current = VERIFY_DEFAULTS) {
  const out = { ...current };
  for (const [k, [min, max]] of Object.entries(LIMITS)) {
    if (body?.[k] === undefined) continue;
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${k} must be a whole number from ${min} to ${max}`);
    out[k] = n;
  }
  for (const k of ['morning_of', 'auto_request_insurance']) if (body?.[k] !== undefined) out[k] = !!body[k];
  return out;
}

// ---- The two statuses ----
// The latest answer from the payer for each policy (a pending 270 isn't an answer), and whether one is waiting.
async function latestChecks(db, policyIds) {
  const out = new Map();
  for (let i = 0; i < policyIds.length; i += 400) {
    const ids = policyIds.slice(i, i + 400);
    const rows = await db.all(
      `SELECT e.id, e.patient_insurance_id, e.status, e.summary, e.created_at, e.response_x12, u.name AS by_name
       FROM eligibility_checks e LEFT JOIN users u ON u.id = e.created_by
       WHERE e.id IN (SELECT MAX(x.id) FROM eligibility_checks x WHERE x.patient_insurance_id IN (${IN(ids)}) AND x.status != 'pending' GROUP BY x.patient_insurance_id)`, ...ids,
    );
    for (const r of rows) out.set(r.patient_insurance_id, r);
    const pending = await db.all(`SELECT DISTINCT patient_insurance_id FROM eligibility_checks WHERE status = 'pending' AND patient_insurance_id IN (${IN(ids)})`, ...ids);
    for (const p of pending) if (!out.has(p.patient_insurance_id)) out.set(p.patient_insurance_id, { pending: true });
  }
  return out;
}

// The latest full-breakdown verification that covers each policy: made for it, or for anyone on its plan and
// applied to the plan.
async function latestBreakdowns(db, policies) {
  const out = new Map();
  if (!policies.length) return out;
  const ids = policies.map((p) => p.id);
  const plans = [...new Set(policies.map((p) => p.plan_id).filter(Boolean))];
  const rows = await db.all(
    `SELECT bv.id, bv.patient_insurance_id, bv.plan_id, bv.method, bv.group_status, bv.patients_updated, bv.patient_detail, bv.reference, bv.rep_name, bv.created_at, bv.actor, bv.source, u.name AS by_name
     FROM benefit_verifications bv LEFT JOIN users u ON u.id = bv.verified_by
     WHERE bv.complete = 1 AND (bv.patient_insurance_id IN (${IN(ids)})${plans.length ? ` OR (bv.plan_id IN (${IN(plans)}) AND bv.group_status IN ('applied','applied_after_review'))` : ''})
     ORDER BY bv.id DESC`, ...ids, ...plans,
  );
  for (const p of policies) {
    const own = rows.find((r) => r.patient_insurance_id === p.id || (r.plan_id === p.plan_id && ['applied', 'applied_after_review'].includes(r.group_status)));
    if (own) out.set(p.id, own);
  }
  return out;
}

const METHOD_OF_CHECK = (c) => {
  const s = json(c.summary, {}) || {};
  if (s.method) return s.method;
  if (s.sandbox) return 'sandbox';
  return c.response_x12 ? 'electronic' : 'manual';
};

export function eligibilityState(check, settings, now = Date.now()) {
  if (!check) return { state: 'never', label: 'Not checked yet' };
  if (check.pending) return { state: 'pending', label: 'Waiting for the payer’s answer' };
  const s = json(check.summary, {}) || {};
  const days = ageDays(check.created_at, now);
  const method = METHOD_OF_CHECK(check);
  let planEnd = s.plan_end || null;
  let evidence = null;
  if (check.response_x12) {
    try {
      const d = parse271Detail(check.response_x12);
      planEnd ||= d.patient.plan_end;
      evidence = d.identity;
    } catch { /* not a 271 we can read again; the summary stands */ }
  }
  const base = {
    check_id: check.id, at: check.created_at, days, method, how: METHOD_LABELS[method] || method, by: check.by_name || (s.verified_by ?? 'Automatic'),
    reference: s.reference || null, rep_name: s.rep_name || null, plan_end: planEnd, evidence, max_remaining: s.max_remaining ?? null, annual_max: s.annual_max ?? null,
    review: s.review && !s.review.resolved_at ? s.review.reasons : null,
  };
  if (check.status === 'inactive') return { ...base, state: 'inactive', label: 'Coverage inactive' };
  if (check.status === 'error') return { ...base, state: 'error', label: 'The payer couldn’t check it' };
  if (days > settings.eligibility_fresh_days) return { ...base, state: 'stale', label: `Verified ${days} days ago — check again` };
  return { ...base, state: 'verified', label: days === 0 ? 'Verified today' : days === 1 ? 'Verified yesterday' : `Verified ${days} days ago` };
}

export function breakdownState(row, { policy, plan, settings, today, now = Date.now() }) {
  if (!row) {
    // A breakdown entered on the plan form before the verification center (portal, phone, fax, AI read).
    if (plan?.verified_at && ['portal', 'phone', 'fax', 'ai_read', 'manual'].includes(plan.verified_source)) row = { created_at: plan.verified_at, method: { ai_read: 'document_ai' }[plan.verified_source] || plan.verified_source, legacy: true };
    else return { state: 'never', label: 'Full breakdown never verified' };
  }
  const days = ageDays(row.created_at, now);
  const base = {
    verification_id: row.id ?? null, at: row.created_at, days, method: row.method, how: METHOD_LABELS[row.method] || row.method,
    by: row.by_name || row.actor || (row.legacy ? null : 'Automatic'), reference: row.reference || null, rep_name: row.rep_name || null,
    via_group: !!row.patient_insurance_id && row.patient_insurance_id !== policy.id, patients_updated: row.patients_updated ?? null,
    // The amounts used and left are the patient's own: never another patient's on the same plan.
    patient_detail: row.patient_insurance_id === policy.id ? json(row.patient_detail, null) : null,
  };
  if (row.group_status === 'review') return { ...base, state: 'review', label: 'Verified — waiting for a person to update the plan' };
  if (days > settings.breakdown_stale_days) return { ...base, state: 'stale', label: `Verified ${days} days ago — out of date`, why: `older than ${settings.breakdown_stale_days} days` };
  const renewal = benefitYear({ benefit_month: plan?.benefit_month }, today).start;
  if (String(row.created_at).slice(0, 10) < renewal) return { ...base, state: 'stale', label: 'Verified before the benefit year renewed', why: `the benefit year renewed on ${renewal}` };
  return { ...base, state: 'verified', label: days === 0 ? 'Breakdown verified today' : `Breakdown verified ${days} days ago` };
}

// What a policy is missing for a clean check (and a clean claim).
export function missingInfo(policy, patient, carrier) {
  const out = [];
  if (!policy.subscriber_id) out.push('Member ID');
  if (!policy.subscriber_name) out.push('Subscriber name');
  if (policy.relationship && policy.relationship !== 'self' && !policy.subscriber_dob) out.push('Subscriber date of birth');
  if ((!policy.relationship || policy.relationship === 'self') && !patient?.dob && !policy.subscriber_dob) out.push('Date of birth');
  if (!policy.group_number) out.push('Group number');
  if (carrier && !carrier.payer_id) out.push('Payer ID (for electronic checks)');
  return out;
}

const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// The exceptions on one visit (IV4). Pure: row carries eligibility, breakdown, missing, remaining, flags.
export const EXCEPTION_ORDER = ['inactive', 'terminated', 'check_failed', 'plan_changed', 'missing_info', 'not_verified', 'max_nearly_used', 'breakdown_stale'];
export const EXCEPTION_LABELS = {
  inactive: 'Coverage inactive', terminated: 'Coverage ends before the visit', check_failed: 'The payer couldn’t check it', plan_changed: 'Plan changed',
  missing_info: 'Missing subscriber details', not_verified: 'Not verified yet', max_nearly_used: 'Maximum nearly used', breakdown_stale: 'Breakdown out of date',
};
export function exceptionsFor(row, settings, today) {
  const out = [];
  const add = (kind, detail) => out.push({ kind, label: EXCEPTION_LABELS[kind], detail });
  if (!row.policy) {
    if (row.pending_update) add('plan_changed', 'The patient sent new insurance — enter it');
    return out;
  }
  const e = row.eligibility;
  const b = row.breakdown;
  if (e.state === 'inactive') add('inactive', `${e.how}${e.at ? `, ${String(e.at).slice(0, 10)}` : ''}: the payer says coverage isn’t active`);
  if (e.plan_end && e.plan_end < row.date && e.state !== 'inactive') add('terminated', `Coverage ends ${e.plan_end}; the visit is ${row.date}`);
  if (e.state === 'error' || (e.review && e.state !== 'inactive')) add('check_failed', (e.review || ['the payer couldn’t check it']).join('; '));
  const changed = [];
  if (row.pending_update) changed.push('the patient sent new insurance');
  if (row.new_card) changed.push('a new card photo came in');
  if (e.evidence?.group_number && row.policy.group_number && norm(e.evidence.group_number) !== norm(row.policy.group_number)) changed.push(`the payer says group ${e.evidence.group_number}, not ${row.policy.group_number}`);
  if (changed.length) add('plan_changed', changed.join('; '));
  if (row.missing.length) add('missing_info', row.missing.join(', '));
  if (['never', 'stale', 'pending'].includes(e.state) && row.date <= addDays(today, 1)) add('not_verified', e.state === 'pending' ? 'The payer hasn’t answered yet' : `${e.label} — the visit is ${row.date === today ? 'today' : 'tomorrow'}`);
  const r = row.remaining;
  if (r && r.annual_max > 0 && r.max_remaining != null && r.max_remaining <= Math.round(r.annual_max * (1 - settings.max_nearly_used_pct / 100))) {
    add('max_nearly_used', `${dollars(r.max_remaining)} of ${dollars(r.annual_max)} left${r.source === 'payer' ? ' (the payer’s figure)' : ' (from claims here)'}`);
  }
  if (['never', 'stale', 'review'].includes(b.state)) add('breakdown_stale', b.state === 'review' ? 'A verified change is waiting for review before it updates the plan' : b.state === 'never' ? 'No full breakdown on file for this plan' : `${b.label}${b.why ? ` (${b.why})` : ''}`);
  return out.sort((x, y) => EXCEPTION_ORDER.indexOf(x.kind) - EXCEPTION_ORDER.indexOf(y.kind));
}
const dollars = (c) => `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
// Exceptions texting the patient answers; the rest need the office.
const PATIENT_FIXES = new Set(['inactive', 'terminated', 'plan_changed', 'missing_info']);

// ---- Upcoming visits with both statuses ----
// range: from..to practice-local dates. user: for office restrictions. Returns { rows, settings, today }.
export async function upcoming(db, practiceId, { from, to, locationId = null, user = null, now = new Date() } = {}) {
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  const settings = verificationSettings(practice);
  const today = localNow(practice.timezone || 'America/New_York', now).slice(0, 10);
  const scope = appointmentScope(user);
  const visits = await db.all(
    `SELECT a.id AS appointment_id, a.start_time, a.status, a.location_id, a.patient_id, l.name AS location_name, pr.name AS provider_name,
       p.first_name, p.last_name, p.preferred_name, p.dob, p.phone, p.guarantor_id
     FROM ${worklist('appointments')} a JOIN ${worklist('patients')} p ON p.id = a.patient_id LEFT JOIN locations l ON l.id = a.location_id LEFT JOIN providers pr ON pr.id = a.provider_id
     WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ('cancelled','no_show','completed')${locationId ? ' AND a.location_id = ?' : ''}${scope.sql}
     ORDER BY a.start_time, a.id`,
    practiceId, `${from} 00:00`, `${addDays(to, 1)} 00:00`, ...(locationId ? [locationId] : []), ...scope.args,
  );
  const rows = await statusRows(db, practice, settings, visits, { today, now });
  return { rows, settings, today };
}

// visits: [{ patient_id, start_time, … }] → the same with policy, eligibility, breakdown, remaining, missing, exceptions.
async function statusRows(db, practice, settings, visits, { today, now = new Date() }) {
  const patientIds = [...new Set(visits.map((v) => v.patient_id))];
  const primary = new Map();
  const policies = [];
  for (let i = 0; i < patientIds.length; i += 400) {
    const ids = patientIds.slice(i, i + 400);
    const list = await db.all(
      `SELECT pi.*, c.name AS carrier_name, c.phone AS payer_phone, c.payer_id, pl.name AS plan_name, pl.group_number AS plan_group, pl.benefit_month AS plan_benefit_month,
         pl.verified_at AS plan_verified_at, pl.verified_source AS plan_verified_source, pl.annual_max AS plan_annual_max
       FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id LEFT JOIN insurance_plans pl ON pl.id = pi.plan_id
       WHERE pi.active = 1 AND pi.patient_id IN (${IN(ids)}) ORDER BY pi.patient_id, CASE pi.priority WHEN 'primary' THEN 0 ELSE 1 END, pi.id`, ...ids,
    );
    for (const p of list) {
      if (primary.has(p.patient_id)) { primary.get(p.patient_id).has_secondary = true; continue; }
      if (!p.plan_id) {
        const plan = await planFor(db, p);
        Object.assign(p, { plan_id: plan.id, plan_name: plan.name, plan_group: plan.group_number, plan_benefit_month: plan.benefit_month, plan_verified_at: plan.verified_at, plan_verified_source: plan.verified_source, plan_annual_max: plan.annual_max });
      }
      primary.set(p.patient_id, p);
      policies.push(p);
    }
  }
  const checks = await latestChecks(db, policies.map((p) => p.id));
  const breakdowns = await latestBreakdowns(db, policies);
  const pendingUpdates = new Set(patientIds.length ? (await db.all(`SELECT DISTINCT patient_id FROM insurance_updates WHERE status = 'pending' AND patient_id IN (${IN(patientIds)})`, ...patientIds)).map((r) => r.patient_id) : []);
  // Asked for new insurance in the last 3 days (a text with the card link), and card photos that came back since.
  const since = utcNow(new Date(now.getTime() - 3 * 86400_000));
  const asked = new Map();
  if (patientIds.length) {
    for (const a of await db.all(`SELECT patient_id, MAX(created_at) AS at FROM audit_log WHERE practice_id = ? AND action = 'verification.request_insurance' AND created_at >= ? AND patient_id IN (${IN(patientIds)}) GROUP BY patient_id`, practice.id, since, ...patientIds)) asked.set(a.patient_id, a.at);
  }
  const cards = new Map();
  if (patientIds.length) {
    for (const d of await db.all(`SELECT patient_id, MAX(created_at) AS at FROM documents WHERE practice_id = ? AND category = 'insurance_card' AND uploaded_by IS NULL AND deleted_at IS NULL AND created_at >= ? AND patient_id IN (${IN(patientIds)}) GROUP BY patient_id`, practice.id, since, ...patientIds)) cards.set(d.patient_id, d.at);
  }
  const used = new Map();
  const out = [];
  for (const v of visits) {
    const p = primary.get(v.patient_id) || null;
    const row = {
      appointment_id: v.appointment_id, start_time: v.start_time, date: v.start_time.slice(0, 10), status: v.status, location_id: v.location_id, location_name: v.location_name || null,
      provider_name: v.provider_name || null, patient_id: v.patient_id, patient_name: `${v.preferred_name || v.first_name} ${v.last_name}`, dob: v.dob, phone: v.phone,
      pending_update: pendingUpdates.has(v.patient_id), requested_at: asked.get(v.patient_id) || null, new_card: !!cards.get(v.patient_id) && (!asked.get(v.patient_id) || cards.get(v.patient_id) >= asked.get(v.patient_id)),
      policy: null, eligibility: { state: 'self_pay', label: 'No insurance on file' }, breakdown: { state: 'self_pay', label: '—' }, missing: [], remaining: null,
    };
    if (p) {
      const plan = { id: p.plan_id, benefit_month: p.plan_benefit_month, verified_at: p.plan_verified_at, verified_source: p.plan_verified_source };
      row.policy = {
        id: p.id, carrier_id: p.carrier_id, carrier_name: p.carrier_name, payer_phone: p.payer_phone || null, payer_id: p.payer_id || null, subscriber_id: p.subscriber_id, subscriber_name: p.subscriber_name,
        subscriber_dob: p.subscriber_dob, relationship: p.relationship, group_number: p.group_number, plan_id: p.plan_id, plan_name: p.plan_name || null, has_secondary: !!p.has_secondary,
      };
      row.eligibility = eligibilityState(checks.get(p.id), settings, now.getTime());
      row.breakdown = breakdownState(breakdowns.get(p.id), { policy: p, plan, settings, today, now: now.getTime() });
      row.missing = missingInfo(p, v, { payer_id: p.payer_id });
      // What's left of the maximum: the payer's latest figure when there is one, else from claims here.
      const annualMax = p.plan_annual_max ?? p.annual_max;
      let remaining = row.breakdown.patient_detail?.max_remaining ?? row.eligibility.max_remaining ?? null;
      let source = remaining != null ? 'payer' : 'claims';
      if (remaining == null && annualMax > 0) {
        if (!used.has(p.id)) used.set(p.id, await benefitsUsed(db, p));
        remaining = Math.max(0, annualMax - used.get(p.id));
        source = 'claims';
      }
      row.remaining = annualMax > 0 ? { annual_max: annualMax, max_remaining: remaining, source } : null;
    }
    row.exceptions = exceptionsFor(row, settings, today);
    // Texting the patient answers some exceptions: those wait on the patient for three days, unless a card came in.
    row.waiting = !!row.requested_at && !row.new_card && row.exceptions.length > 0 && row.exceptions.every((x) => PATIENT_FIXES.has(x.kind) || x.kind === 'breakdown_stale');
    out.push(row);
  }
  return out;
}

// One patient's current status (the badge on the chart and patient bar): their next visit's date, or today.
export async function patientStatus(db, practiceId, patientId, { now = new Date() } = {}) {
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  const settings = verificationSettings(practice);
  const today = localNow(practice.timezone || 'America/New_York', now).slice(0, 10);
  const next = await db.get("SELECT id, start_time, location_id FROM appointments WHERE practice_id = ? AND patient_id = ? AND start_time >= ? AND status NOT IN ('cancelled','no_show','completed') ORDER BY start_time LIMIT 1", practiceId, patientId, `${today} 00:00`);
  const p = await db.get('SELECT id AS patient_id, first_name, last_name, preferred_name, dob, phone, guarantor_id FROM patients WHERE id = ? AND practice_id = ?', patientId, practiceId);
  if (!p) throw new HttpError(404, 'Patient not found');
  const [row] = await statusRows(db, practice, settings, [{ ...p, appointment_id: next?.id ?? null, start_time: next?.start_time || `${today} 00:00`, status: 'scheduled', location_id: next?.location_id ?? null }], { today, now });
  return { ...row, next_visit: next?.start_time || null, settings };
}

// ---- Automation (IV2) ----
// Eligibility days_ahead days before each visit (and for anything booked later than that, as soon as it's in
// the window) and again the morning of. Each (policy, visit day, window) is done once: claimed by inserting its
// verification_runs row first (a unique key), so two servers or a second pass can't check it twice. A failure
// is retried on later passes (three tries); after that it's a Needs attention item. Clean answers are applied
// by eligibility.js (settle), breakdowns and all; the rest become exceptions there.
const RETRIES = 3;
const RETRY_AFTER_MIN = 30;

export async function runVerificationAutomation(db, eligibility, { now = new Date(), messenger = null, appUrl = '' } = {}) {
  if (!eligibility.automatic) return [];
  const done = [];
  for (const practice of await db.all('SELECT * FROM practices')) {
    const settings = verificationSettings(practice);
    const tz = practice.timezone || 'America/New_York';
    const local = localNow(tz, now);
    const today = local.slice(0, 10);
    const windows = [];
    if (settings.days_ahead > 0) windows.push({ name: 'ahead', from: addDays(today, 1), to: addDays(today, settings.days_ahead) });
    if (settings.morning_of && Number(local.slice(11, 13)) >= settings.morning_hour) windows.push({ name: 'morning', from: today, to: today, after: local });
    const out = { practice_id: practice.id, checked: 0, skipped: 0, failed: 0, requested: 0, windows: {} };
    for (const w of windows) {
      const visits = await db.all(
        `SELECT a.id, a.patient_id, a.start_time FROM real_appointments a WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status IN ('scheduled','confirmed','checked_in')
         ORDER BY a.start_time`, practice.id, w.after && w.name === 'morning' ? w.after : `${w.from} 00:00`, `${addDays(w.to, 1)} 00:00`,
      );
      const n = { checked: 0, skipped: 0, failed: 0 };
      const seen = new Set();
      for (const v of visits) {
        const policy = await db.get("SELECT * FROM patient_insurance WHERE patient_id = ? AND active = 1 ORDER BY CASE priority WHEN 'primary' THEN 0 ELSE 1 END, id LIMIT 1", v.patient_id);
        if (!policy) continue;
        const visitDate = v.start_time.slice(0, 10);
        const key = `${policy.id}:${visitDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const run = await claimRun(db, { practiceId: practice.id, policy, appointmentId: v.id, visitDate, window: w.name, now });
        if (!run) continue;
        // Somebody checked already (at the desk, or an earlier window): not asked again so soon.
        const recentSince = w.name === 'morning' ? zonedToUtc(tz, today) : utcNow(new Date(now.getTime() - 86400_000));
        const recent = await db.get("SELECT id FROM eligibility_checks WHERE patient_insurance_id = ? AND status != 'pending' AND created_at >= ? ORDER BY id DESC LIMIT 1", policy.id, recentSince);
        if (recent) {
          await db.run("UPDATE verification_runs SET status = 'skipped', eligibility_check_id = ?, updated_at = ? WHERE id = ?", recent.id, utcNow(now), run.id);
          n.skipped++;
          continue;
        }
        try {
          const actor = w.name === 'morning' ? 'Morning-of insurance check' : `Insurance check ${settings.days_ahead} days ahead`;
          const result = await withActor({ source: 'automation', actor, practiceId: practice.id }, () => eligibility.check(policy));
          await db.run("UPDATE verification_runs SET status = 'done', eligibility_check_id = ?, error = NULL, updated_at = ? WHERE id = ?", result.id, utcNow(now), run.id);
          await resolveIssue(db, practice.id, `verification-run:${policy.id}:${visitDate}`);
          n.checked++;
          if (result.status === 'inactive' && settings.auto_request_insurance && messenger && w.name === 'ahead') {
            const sent = await withActor({ source: 'automation', actor: 'Insurance verification', practiceId: practice.id }, () => requestInsurance(db, messenger, { practiceId: practice.id, patientId: policy.patient_id, appUrl, now }).catch((err) => ({ error: err.message })));
            if (sent?.message_id) out.requested++;
          }
        } catch (err) {
          const attempts = run.attempts + 1;
          await db.run("UPDATE verification_runs SET status = 'failed', attempts = ?, error = ?, updated_at = ? WHERE id = ?", attempts, String(err.message).slice(0, 300), utcNow(now), run.id);
          n.failed++;
          if (attempts >= RETRIES) {
            const who = await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', policy.patient_id);
            await raiseIssue(db, {
              practiceId: practice.id, kind: 'eligibility', key: `verification-run:${policy.id}:${visitDate}`, role: 'front_desk', entity: 'patient_insurance', entityId: policy.id, patientId: policy.patient_id,
              title: `Insurance couldn’t be checked for ${who.first_name} ${who.last_name} (visit ${visitDate}) — verify by phone or the payer’s portal`, detail: err.message,
            });
          }
        }
      }
      out.windows[w.name] = n;
      out.checked += n.checked; out.skipped += n.skipped; out.failed += n.failed;
    }
    if (out.checked || out.failed || out.skipped) done.push(out);
  }
  return done;
}

// Claims one (policy, visit day, window): a new row, or a failed one due another try. null = nothing to do.
async function claimRun(db, { practiceId, policy, appointmentId, visitDate, window, now }) {
  const stamp = utcNow(now);
  const made = await db.run(
    `INSERT INTO verification_runs (practice_id, patient_id, patient_insurance_id, appointment_id, visit_date, run_window, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', 0, ?, ?) ON CONFLICT DO NOTHING`, practiceId, policy.patient_id, policy.id, appointmentId, visitDate, window, stamp, stamp,
  );
  if (made.changes) return await db.get('SELECT * FROM verification_runs WHERE patient_insurance_id = ? AND visit_date = ? AND run_window = ?', policy.id, visitDate, window);
  const row = await db.get('SELECT * FROM verification_runs WHERE patient_insurance_id = ? AND visit_date = ? AND run_window = ?', policy.id, visitDate, window);
  if (!row || row.status !== 'failed' || row.attempts >= RETRIES) return null;
  const due = utcNow(new Date(now.getTime() - RETRY_AFTER_MIN * 60_000));
  if ((row.updated_at || row.created_at) > due) return null;
  const took = await db.run("UPDATE verification_runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'failed'", stamp, row.id);
  return took.changes ? row : null;
}

// "Check everyone now" for a range the person is looking at: each policy once, skipping any checked in the last day.
export async function runNow(db, eligibility, user, { from, to, locationId = null }) {
  if (!eligibility.automatic) throw new HttpError(409, 'Checking everyone at once needs a real-time clearinghouse connection (Settings → Integrations). Until then verify by phone or the payer’s portal.');
  const { rows } = await upcoming(db, user.practice_id, { from, to, locationId, user });
  const since = utcNow(new Date(Date.now() - 86400_000));
  const out = { checked: 0, applied: 0, needs_look: 0, skipped: 0, failed: [] };
  const seen = new Set();
  for (const r of rows) {
    if (!r.policy || seen.has(r.policy.id)) continue;
    seen.add(r.policy.id);
    if (r.eligibility.at && r.eligibility.at >= since && ['verified', 'inactive'].includes(r.eligibility.state)) { out.skipped++; continue; }
    try {
      const policy = await db.get('SELECT * FROM patient_insurance WHERE id = ?', r.policy.id);
      const done = await eligibility.check(policy, { userId: user.id });
      out.checked++;
      if (done.applied) out.applied++;
      if (done.reasons?.length) out.needs_look++;
    } catch (err) {
      out.failed.push({ patient_id: r.patient_id, error: err.message });
    }
  }
  return out;
}

// ---- Asking the patient for their new insurance (IV4) ----
// A text (or email) with a secure link to photograph their card; the photo lands in the chart as an insurance
// card and in Intake review, where the card reader fills in the policy for a person to confirm (#31).
const LINK_HOURS = 72;
export async function requestInsurance(db, messenger, { practiceId, patientId, appUrl, userId = null, now = new Date() }) {
  const patient = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', patientId, practiceId);
  if (!patient) throw new HttpError(404, 'Patient not found');
  const recent = await db.get("SELECT id, created_at FROM audit_log WHERE practice_id = ? AND patient_id = ? AND action = 'verification.request_insurance' AND created_at >= ? ORDER BY id DESC LIMIT 1", practiceId, patientId, utcNow(new Date(now.getTime() - 86400_000)));
  // Once a day at most, however it's asked for (a double press, the automatic run and a person).
  if (recent) return { already: true, at: recent.created_at };
  const recipient = await recipientFor(db, patient);
  const route = preferredChannel(recipient, 'sms', { fallback: true });
  if (!route) throw new HttpError(409, `${patient.first_name} has no mobile number or email we can use — call them instead`);
  const practice = await db.get('SELECT name, phone, timezone FROM practices WHERE id = ?', practiceId);
  const next = await db.get("SELECT start_time FROM appointments WHERE patient_id = ? AND start_time >= ? AND status NOT IN ('cancelled','no_show','completed') ORDER BY start_time LIMIT 1", patient.id, localNow(practice.timezone || 'America/New_York', now));
  const { token, hash } = newToken();
  const expires = new Date(now.getTime() + LINK_HOURS * 3600_000).toISOString();
  // No staff member on the link: what comes back is the patient's, so it shows in Intake review like any card they send.
  await insert(db, 'upload_links', { practice_id: practiceId, patient_id: patient.id, token_hash: hash, category: 'insurance_card', created_by: null, expires_at: expires });
  const url = `${appUrl}/scan/${token}`;
  const who = recipient.id === patient.id ? 'your' : `${patient.first_name}’s`;
  const when = next ? ` before the visit on ${new Date(`${next.start_time.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}` : '';
  const body = `${practice.name}: we couldn’t confirm ${who} dental insurance${when}. Please send a photo of the current insurance card (front and back) here: ${url} — the link works for 3 days. Questions? Call ${practice.phone || 'the office'}.`;
  const message = await sendMessage(db, messenger, {
    practiceId, patientId: recipient.id, channel: route.channel, to: route.to, subject: route.channel === 'email' ? `${practice.name}: your dental insurance` : undefined, body, kind: 'insurance_request', userId,
  });
  if (message.status === 'blocked' || message.status === 'failed') throw new HttpError(409, `The ${route.channel === 'sms' ? 'text' : 'email'} didn’t go: ${message.error || 'unknown error'}`);
  await audit(db, null, 'verification.request_insurance', 'patients', patient.id, { message_id: message.id, channel: route.channel, to_guarantor: recipient.id !== patient.id, expires_at: expires }, {
    patientId: patient.id, reason: 'Asked the patient for their current insurance card (secure upload link)',
  });
  return { message_id: message.id, channel: route.channel, to: route.channel === 'sms' ? `…${String(route.to).replace(/\D/g, '').slice(-4)}` : route.to.replace(/^(.).*@/, '$1…@'), expires_at: expires };
}

// ---- The payer phone script ----
export function payerScript({ practice, provider = null, user, patient, policy, carrier, visitDate }) {
  const dob = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'UTC' }) : 'not on file');
  return [
    `Call ${carrier?.name || 'the insurance company'}${carrier?.phone ? ` at ${carrier.phone}` : ''} (provider services, dental).`,
    `“Hi, this is ${user?.name?.split(' ')[0] || 'me'} from ${practice.name}. I’m verifying dental benefits. Our NPI is ${provider?.npi || practice.npi || '—'}${practice.tax_id ? `, tax ID ${practice.tax_id}` : ''}.”`,
    `Patient: ${patient.first_name} ${patient.last_name}, born ${dob(patient.dob)}. Subscriber: ${policy.subscriber_name || '—'}${policy.relationship && policy.relationship !== 'self' ? ` (${policy.relationship})` : ''}, born ${dob(policy.subscriber_dob || (policy.relationship === 'self' ? patient.dob : null))}. Member ID ${policy.subscriber_id || '—'}, group ${policy.group_number || '—'}.`,
    `1. Is coverage active today${visitDate ? ` and on ${visitDate}` : ''}? When did it start, and is there an end date?`,
    '2. Annual maximum: how much, how much is used this benefit year, and does the year run by calendar or plan year?',
    '3. Deductible (individual and family): how much, how much is met, and is it waived for preventive?',
    '4. Percentages: diagnostic and preventive, fillings, root canals, gum treatment, extractions, crowns, bridges and dentures, implants.',
    '5. Frequencies: exams and cleanings, bitewings, full series or panoramic, fluoride (to what age), sealants, crown replacement, scaling and root planing.',
    '6. Waiting periods? Missing tooth clause? Are posterior composites paid as amalgam? Orthodontics: lifetime maximum, percentage, age limit.',
    '7. History: the last exam, cleaning, bitewings and full series or panoramic dates.',
    '8. “May I have a reference number for this call, and your name?”',
  ].join('\n');
}

// ---- Verified by phone (IV4) ----
// The call's answer is an eligibility answer (recorded like a payer's, with the reference number and the
// representative's name), and whatever breakdown was given on the call is applied like any other.
export async function verifyByPhone(db, { policy, user, body }) {
  requireHuman('recording a phone verification');
  const reference = String(body?.reference ?? '').trim().slice(0, 80);
  const repName = String(body?.rep_name ?? '').trim().slice(0, 80);
  if (!reference) throw new HttpError(400, 'The call reference number is required');
  if (!repName) throw new HttpError(400, 'The representative’s name is required');
  if (typeof body?.active !== 'boolean') throw new HttpError(400, 'Say whether coverage is active (active: true or false)');
  const day = (k) => {
    if (body[k] == null || body[k] === '') return null;
    if (!DATE.test(String(body[k])) || Number.isNaN(Date.parse(`${body[k]}T12:00:00Z`))) throw new HttpError(400, `${k} must be a real date (YYYY-MM-DD)`);
    return String(body[k]);
  };
  const planBegin = day('plan_begin');
  const planEnd = day('plan_end');
  const patientFields = cleanPatientFields(body.patient || {});
  const summary = {
    method: 'phone', active: body.active, reference, rep_name: repName, verified_by: user.name, plan_begin: planBegin, plan_end: planEnd,
    ...(patientFields.max_remaining != null ? { max_remaining: patientFields.max_remaining } : {}), notes: body.notes ? String(body.notes).slice(0, 1000) : null, errors: [], coinsurance: {},
  };
  const checkId = await insert(db, 'eligibility_checks', {
    practice_id: policy.practice_id, patient_id: policy.patient_id, patient_insurance_id: policy.id, status: body.active ? 'active' : 'inactive', summary: JSON.stringify(summary), created_by: user.id,
  });
  await audit(db, null, 'verification.phone', 'patient_insurance', policy.id, { check_id: checkId, active: body.active, reference, rep_name: repName, plan_end: planEnd, patient_id: policy.patient_id }, {
    patientId: policy.patient_id, reason: `Verified by phone with ${repName} (reference ${reference})`,
  });
  if (body.active) {
    await resolveIssue(db, policy.practice_id, `eligibility-review:${policy.id}`, `Verified by phone by ${user.name} (reference ${reference})`);
    const open = await db.all("SELECT dedupe_key FROM issues WHERE practice_id = ? AND status = 'open' AND dedupe_key LIKE ?", policy.practice_id, `verification-run:${policy.id}:%`);
    for (const i of open) await resolveIssue(db, policy.practice_id, i.dedupe_key, `Verified by phone by ${user.name}`);
  }
  let verification = null;
  const planFields = pickPlan(body.plan || {});
  if (Object.keys(planFields).length || Object.keys(patientFields).length) {
    verification = await applyVerification(db, {
      policy, method: 'phone', planFields, patientFields, complete: isComplete(planFields, body.complete), checkId, reference, repName, notes: body.notes, userId: user.id,
      evidence: body.group_number ? { group_number: String(body.group_number).slice(0, 40) } : {},
    });
  }
  return { check_id: checkId, verification };
}

const pickPlan = (fields) => Object.fromEntries(Object.entries(fields || {}).filter(([k, v]) => PLAN_LEVEL.includes(k) && v !== undefined && v !== ''));
// A full breakdown: the maximum, the deductible and all three percentages, checked.
const isComplete = (plan, said) => (said != null ? !!said : ['annual_max', 'deductible', 'pct_preventive', 'pct_basic', 'pct_major'].every((k) => plan[k] != null));
function cleanPatientFields(p) {
  const out = {};
  for (const k of ['max_used', 'max_remaining', 'deductible_met', 'deductible_remaining', 'family_deductible_remaining', 'ortho_remaining']) {
    if (p[k] == null || p[k] === '') continue;
    const n = Math.round(Number(p[k]));
    if (!Number.isFinite(n) || n < 0 || n > 100_000_000) throw new HttpError(400, `${k} must be an amount in cents`);
    out[k] = n;
  }
  for (const k of ['plan_begin', 'plan_end']) if (p[k] && DATE.test(String(p[k]))) out[k] = String(p[k]);
  if (Array.isArray(p.history)) {
    out.history = p.history.filter((h) => Array.isArray(h.codes) && DATE.test(String(h.date || ''))).slice(0, 40)
      .map((h) => ({ codes: h.codes.map((c) => String(c).toUpperCase()).filter((c) => /^D\d{4}$/.test(c)), date: String(h.date) })).filter((h) => h.codes.length);
  }
  return out;
}

// ---- A portal page or fax, read by AI, confirmed by a person (IV2) ----
const READ_TOOL = {
  name: 'benefit_breakdown',
  description: 'The dental plan’s benefits and this member’s amounts, as written in the document. Leave out anything the document doesn’t say.',
  input_schema: {
    type: 'object',
    properties: {
      payer_name: { type: 'string' }, plan_name: { type: 'string' }, group_number: { type: 'string' }, member_id: { type: 'string' },
      coverage_active: { type: 'boolean' }, plan_begin: { type: 'string', description: 'YYYY-MM-DD' }, plan_end: { type: 'string', description: 'YYYY-MM-DD, only if the coverage ends' },
      annual_max: { type: 'number', description: 'Dollars' }, max_used: { type: 'number' }, max_remaining: { type: 'number' },
      deductible: { type: 'number' }, deductible_met: { type: 'number' }, family_deductible: { type: 'number' },
      pct_preventive: { type: 'integer' }, pct_basic: { type: 'integer' }, pct_major: { type: 'integer' },
      benefit_month: { type: 'integer', description: '1 for a calendar year; the month a plan year starts otherwise' },
      ortho_max: { type: 'number' }, ortho_pct: { type: 'integer' }, ortho_age_limit: { type: 'integer' },
      wait_basic_months: { type: 'integer' }, wait_major_months: { type: 'integer' },
      downgrade_composites: { type: 'boolean' }, missing_tooth_clause: { type: 'boolean' },
      frequencies: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, codes: { type: 'array', items: { type: 'string' } }, count: { type: 'integer' }, months: { type: 'integer' }, per: { type: 'string', enum: ['benefit_year'] }, per_tooth: { type: 'boolean' } }, required: ['codes', 'count'] } },
      coverage_overrides: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, pct: { type: 'integer' } }, required: ['code', 'pct'] } },
      history: { type: 'array', items: { type: 'object', properties: { codes: { type: 'array', items: { type: 'string' } }, date: { type: 'string' } }, required: ['codes', 'date'] } },
      unclear: { type: 'array', items: { type: 'string' }, description: 'Fields that were hard to read or ambiguous' },
    },
  },
};
const READ_SYSTEM = `You read US dental insurance benefit documents (payer portal pages, breakdown faxes) for a dental office's front desk.
Copy the plan's rules and this member's amounts into the tool exactly as written; don't infer or fill in typical values. Percentages are what the plan pays. Map service categories to CDT: preventive D1, diagnostic D0, basic restorative D2140-D2394, endodontics D3, periodontics D4, oral surgery D7, crowns D27, prosthodontics D5/D62, implants D60, orthodontics D8.`;

const toCents = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Math.round(Number(v) * 100));
function proposalOf(out) {
  const plan = {};
  for (const k of ['annual_max', 'deductible', 'family_deductible', 'ortho_max']) if (toCents(out[k]) != null) plan[k] = toCents(out[k]);
  for (const k of ['pct_preventive', 'pct_basic', 'pct_major', 'benefit_month', 'ortho_pct', 'ortho_age_limit', 'wait_basic_months', 'wait_major_months']) if (out[k] != null && Number.isFinite(Number(out[k]))) plan[k] = Math.round(Number(out[k]));
  for (const k of ['downgrade_composites', 'missing_tooth_clause']) if (out[k] != null) plan[k] = out[k] ? 1 : 0;
  if (out.frequencies?.length) plan.frequencies = out.frequencies.map((f) => ({ label: f.label || f.codes.join(', '), codes: f.codes.map((c) => String(c).toUpperCase()), count: f.count, ...(f.months ? { months: f.months } : { per: 'benefit_year' }), ...(f.per_tooth ? { per_tooth: true } : {}) }));
  if (out.coverage_overrides?.length) plan.coverage_overrides = Object.fromEntries(out.coverage_overrides.map((o) => [String(o.code).toUpperCase(), o.pct]));
  const patient = {};
  for (const k of ['max_used', 'max_remaining', 'deductible_met']) if (toCents(out[k]) != null) patient[k] = toCents(out[k]);
  for (const k of ['plan_begin', 'plan_end']) if (DATE.test(String(out[k] || ''))) patient[k] = out[k];
  if (out.history?.length) patient.history = out.history.filter((h) => DATE.test(String(h.date || ''))).map((h) => ({ codes: h.codes.map((c) => String(c).toUpperCase()), date: h.date }));
  const evidence = Object.fromEntries(['payer_name', 'plan_name', 'group_number', 'member_id'].filter((k) => out[k]).map((k) => [k, String(out[k]).slice(0, 80)]));
  return { plan, patient, evidence, active: out.coverage_active ?? null, unclear: Array.isArray(out.unclear) ? out.unclear.map((x) => String(x).slice(0, 60)).slice(0, 10) : [] };
}

// The sandbox reader (no AI key; demo and test servers): made-up values, never read from the file — the plan
// on file with a 12-month major waiting period and some of the maximum used — so the flow can be tried.
function sandboxProposal(plan) {
  return {
    plan: { annual_max: plan.annual_max, deductible: plan.deductible, pct_preventive: plan.pct_preventive, pct_basic: plan.pct_basic, pct_major: plan.pct_major, wait_major_months: 12, missing_tooth_clause: 1 },
    patient: { max_used: Math.min(plan.annual_max, 40000), max_remaining: Math.max(0, plan.annual_max - 40000), deductible_met: plan.deductible },
    evidence: { group_number: plan.group_number || undefined }, active: true, unclear: [],
  };
}

export async function readBenefitDocument(db, config, { policy, user, content, documentId, sandbox }) {
  const plan = await planFor(db, policy);
  let proposal;
  if (aiClient(config)) {
    const out = await structured(config, { system: READ_SYSTEM, tool: READ_TOOL, effort: 'medium', content: [...content, { type: 'text', text: 'Fill in the benefit breakdown and this member’s amounts from this document.' }] });
    proposal = proposalOf(out);
  } else if (sandbox) proposal = sandboxProposal(plan);
  else throw new HttpError(503, 'Reading documents needs AI, which is off on this server — enter the breakdown by hand (Verified by phone) instead');
  const isSandbox = !aiClient(config);
  const fields = [...Object.keys(proposal.plan), ...Object.keys(proposal.patient)];
  if (!fields.length) throw new HttpError(422, 'No benefits could be read from that document — try the payer’s benefit summary page');
  const reason = isSandbox
    ? 'Sandbox reader: made-up values for trying things out — not read from the document'
    : `Read from the document by AI${proposal.unclear.length ? `; hard to read: ${proposal.unclear.join(', ')}` : ''}. Check each field against the document before applying.`;
  const id = await insert(db, 'benefit_reads', {
    practice_id: policy.practice_id, patient_id: policy.patient_id, patient_insurance_id: policy.id, plan_id: plan.id, document_id: documentId ?? null,
    proposed: JSON.stringify(proposal), reason, sandbox: isSandbox ? 1 : 0, status: 'draft', created_by: user.id,
  });
  await audit(db, null, 'benefits.ai_read', 'benefit_reads', id, { fields, document_id: documentId ?? null, sandbox: isSandbox, patient_id: policy.patient_id }, {
    source: 'ai', actor: isSandbox ? 'Benefit reader (sandbox)' : `AI benefit reader (for ${user.name})`, reason, patientId: policy.patient_id,
  });
  return await readView(db, id);
}

export async function readView(db, id) {
  const r = await db.get('SELECT * FROM benefit_reads WHERE id = ?', id);
  if (!r) return null;
  const plan = await db.get('SELECT * FROM insurance_plans WHERE id = ?', r.plan_id);
  const policy = await db.get('SELECT * FROM patient_insurance WHERE id = ?', r.patient_insurance_id);
  const proposed = json(r.proposed, {});
  const current = Object.fromEntries(Object.keys(proposed.plan || {}).map((k) => [k, ['frequencies', 'coverage_overrides', 'age_limits'].includes(k) ? json(plan?.[k]) : plan?.[k] ?? null]));
  const currentPatient = { deductible_met: policy?.deductible_met ?? null };
  return { id: r.id, status: r.status, sandbox: !!r.sandbox, reason: r.reason, document_id: r.document_id, patient_insurance_id: r.patient_insurance_id, plan_id: r.plan_id, proposed, current, current_patient: currentPatient, created_at: r.created_at, verification_id: r.verification_id };
}

// The person checked the read against the document: only the fields they ticked are applied, with the values
// they left or corrected. Nothing from an AI read is ever applied without this.
export async function confirmRead(db, { read, policy, user, body }) {
  requireHuman('applying benefits read from a document');
  const confirmed = Array.isArray(body?.confirmed) ? body.confirmed.map(String) : [];
  if (!confirmed.length) throw new HttpError(400, 'Tick each field you checked against the document');
  const proposal = json(read.proposed, {});
  const values = { ...proposal.plan, ...proposal.patient, ...(body.values || {}) };
  const unknown = confirmed.filter((k) => !PLAN_LEVEL.includes(k) && !PATIENT_LEVEL.includes(k));
  if (unknown.length) throw new HttpError(400, `Unknown fields: ${unknown.join(', ')}`);
  const planFields = Object.fromEntries(confirmed.filter((k) => PLAN_LEVEL.includes(k) && values[k] !== undefined).map((k) => [k, values[k]]));
  const patientFields = cleanPatientFields(Object.fromEntries(confirmed.filter((k) => PATIENT_LEVEL.includes(k)).map((k) => [k, values[k]])));
  const edited = confirmed.filter((k) => body.values?.[k] !== undefined && JSON.stringify(body.values[k]) !== JSON.stringify({ ...proposal.plan, ...proposal.patient }[k]));
  const skipped = Object.keys({ ...proposal.plan, ...proposal.patient }).filter((k) => !confirmed.includes(k));
  planDiff({}, planFields); // validates (400 on an impossible value) before anything is claimed
  const took = await db.run("UPDATE benefit_reads SET status = 'confirmed', confirmed_by = ?, confirmed_at = datetime('now') WHERE id = ? AND status = 'draft'", user.id, read.id);
  if (!took.changes) throw new HttpError(409, 'That read was already applied or set aside');
  const verification = await applyVerification(db, {
    policy, method: 'document_ai', planFields, patientFields, complete: isComplete(planFields), documentId: read.document_id, readId: read.id, evidence: proposal.evidence || {}, userId: user.id,
    notes: edited.length ? `Corrected from the AI read: ${edited.join(', ')}` : null,
  });
  await db.run('UPDATE benefit_reads SET verification_id = ? WHERE id = ?', verification.id, read.id);
  await audit(db, null, 'benefits.ai_read_confirmed', 'benefit_reads', read.id, { confirmed, edited, skipped, verification_id: verification.id, patient_id: policy.patient_id }, {
    patientId: policy.patient_id, reason: `Read by AI from the document; checked field by field and applied by ${user.name}${edited.length ? ` (corrected ${edited.join(', ')})` : ''}`,
  });
  return { verification, confirmed, edited, skipped };
}

// ---- Metrics ----
// % of visits verified 48 hours ahead: of the visits in the range whose 48-hour mark has passed, how many had an
// answer from the payer (active or not, electronic or by phone) from within the freshness window before it.
// Stale breakdowns: the patients booked in the next 14 days whose plan's breakdown is out of date or missing.
export async function verificationMetrics(db, practiceId, { from, to, locationId = null, now = new Date() } = {}) {
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  const settings = verificationSettings(practice);
  const tz = practice.timezone || 'America/New_York';
  const today = localNow(tz, now).slice(0, 10);
  to ||= today;
  from ||= addDays(to, -29);
  const visits = await db.all(
    `SELECT a.id, a.patient_id, a.start_time FROM real_appointments a WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ('cancelled','no_show')${locationId ? ' AND a.location_id = ?' : ''}`,
    practiceId, `${from} 00:00`, `${addDays(to, 1)} 00:00`, ...(locationId ? [locationId] : []),
  );
  const pids = [...new Set(visits.map((v) => v.patient_id))];
  const policyOf = new Map();
  if (pids.length) {
    for (const p of await db.all(`SELECT id, patient_id FROM real_patient_insurance patient_insurance WHERE patient_id IN (${IN(pids)}) ORDER BY CASE priority WHEN 'primary' THEN 0 ELSE 1 END, active DESC, id`, ...pids)) if (!policyOf.has(p.patient_id)) policyOf.set(p.patient_id, p.id);
  }
  const answers = new Map();
  const ids = [...new Set(policyOf.values())];
  if (ids.length) for (const c of await db.all(`SELECT patient_insurance_id, created_at FROM real_eligibility_checks eligibility_checks WHERE status IN ('active','inactive') AND patient_insurance_id IN (${IN(ids)})`, ...ids)) (answers.get(c.patient_insurance_id) || answers.set(c.patient_insurance_id, []).get(c.patient_insurance_id)).push(c.created_at);
  const nowUtc = utcNow(now);
  let measured = 0;
  let verified = 0;
  for (const v of visits) {
    const policy = policyOf.get(v.patient_id);
    if (!policy) continue;
    const start = zonedToUtc(tz, v.start_time.slice(0, 10), v.start_time.slice(11, 16));
    const mark = utcNow(new Date(Date.parse(`${start.replace(' ', 'T')}Z`) - 48 * 3600_000));
    if (mark > nowUtc) continue;
    measured++;
    const earliest = utcNow(new Date(Date.parse(`${mark.replace(' ', 'T')}Z`) - settings.eligibility_fresh_days * 86400_000));
    if ((answers.get(policy) || []).some((at) => at <= mark && at >= earliest)) verified++;
  }
  const next = await upcoming(db, practiceId, { from: today, to: addDays(today, 13), locationId, now });
  const policies = new Map();
  for (const r of next.rows) if (r.policy) policies.set(r.policy.id, r.breakdown.state);
  const states = [...policies.values()];
  return {
    from, to, visits: measured, verified_48h: verified, pct_verified_48h: measured ? Math.round((verified / measured) * 1000) / 10 : null,
    stale_breakdowns: states.filter((s) => s === 'stale' || s === 'never').length, never_verified_breakdowns: states.filter((s) => s === 'never').length,
    upcoming_policies: states.length, exceptions: next.rows.filter((r) => r.exceptions.length && !r.waiting).length,
  };
}

// ---- One policy, in full (the side panel) ----
export async function policyDetail(db, policy, { user, now = new Date() }) {
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', policy.practice_id);
  const plan = await planFor(db, policy);
  const carrier = await db.get('SELECT * FROM insurance_carriers WHERE id = ?', policy.carrier_id);
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', policy.patient_id);
  const status = await patientStatus(db, policy.practice_id, policy.patient_id, { now });
  const members = await db.all('SELECT pi.id, pi.patient_id, p.first_name, p.last_name FROM patient_insurance pi JOIN patients p ON p.id = pi.patient_id WHERE pi.plan_id = ? AND pi.active = 1 ORDER BY p.last_name, p.first_name', plan.id);
  const history = (await db.all(
    `SELECT bv.id, bv.method, bv.complete, bv.group_status, bv.patients_updated, bv.plan_changes, bv.proposed, bv.review_reasons, bv.patient_detail, bv.reference, bv.rep_name, bv.notes,
       bv.source, bv.actor, bv.created_at, bv.patient_insurance_id, bv.reviewed_at, u.name AS by_name, r.name AS reviewed_by_name, p.first_name, p.last_name
     FROM benefit_verifications bv LEFT JOIN users u ON u.id = bv.verified_by LEFT JOIN users r ON r.id = bv.reviewed_by JOIN patients p ON p.id = bv.patient_id
     WHERE bv.plan_id = ? OR bv.patient_insurance_id = ? ORDER BY bv.id DESC LIMIT 30`, plan.id, policy.id,
  )).map((h) => ({ ...h, how: METHOD_LABELS[h.method] || h.method, plan_changes: json(h.plan_changes, {}), proposed: json(h.proposed, null), review_reasons: json(h.review_reasons, null), patient_detail: json(h.patient_detail, null), for_patient: `${h.first_name} ${h.last_name}` }));
  const checks = (await db.all(
    'SELECT e.id, e.status, e.summary, e.created_at, u.name AS by_name FROM eligibility_checks e LEFT JOIN users u ON u.id = e.created_by WHERE e.patient_insurance_id = ? ORDER BY e.id DESC LIMIT 10', policy.id,
  )).map((c) => {
    const s = json(c.summary, {}) || {};
    return { id: c.id, status: c.status, at: c.created_at, by: c.by_name || s.verified_by || 'Automatic', method: s.method || (s.sandbox ? 'sandbox' : 'electronic'), reference: s.reference || null, rep_name: s.rep_name || null, plan_end: s.plan_end || null };
  });
  const latest = await db.get("SELECT response_x12 FROM eligibility_checks WHERE patient_insurance_id = ? AND response_x12 IS NOT NULL AND status = 'active' ORDER BY id DESC LIMIT 1", policy.id);
  let categories = [];
  if (latest?.response_x12) { try { categories = parse271Detail(latest.response_x12).categories; } catch { /* unreadable */ } }
  const reads = await db.all("SELECT id, status, sandbox, created_at FROM benefit_reads WHERE patient_insurance_id = ? AND status = 'draft' ORDER BY id DESC", policy.id);
  const provider = await db.get("SELECT npi FROM providers WHERE practice_id = ? AND active = 1 AND npi IS NOT NULL ORDER BY CASE type WHEN 'dentist' THEN 0 ELSE 1 END, id LIMIT 1", policy.practice_id);
  const planView = Object.fromEntries(['id', 'name', 'group_number', 'verified_at', 'verified_source', ...PLAN_LEVEL].map((k) => [k, ['frequencies', 'coverage_overrides', 'age_limits'].includes(k) ? json(plan[k]) : plan[k]]));
  return {
    policy: { ...policy, carrier_name: carrier.name, payer_phone: carrier.phone || null, payer_id: carrier.payer_id || null },
    plan: planView, members, status, history, checks, categories, drafts: reads,
    script: payerScript({ practice, provider, user, patient, policy, carrier, visitDate: status.next_visit?.slice(0, 10) || null }),
  };
}

// Plan changes waiting for a person because the plan's identity wasn't certain (IV3).
export async function reviewList(db, practiceId) {
  const rows = await db.all(
    `SELECT bv.id, bv.plan_id, bv.patient_id, bv.patient_insurance_id, bv.method, bv.proposed, bv.review_reasons, bv.created_at, bv.reference, bv.rep_name, u.name AS by_name, bv.actor,
       p.first_name, p.last_name, pl.name AS plan_name, pl.group_number AS plan_group, c.name AS carrier_name, pl.carrier_id
     FROM benefit_verifications bv JOIN real_patients p ON p.id = bv.patient_id JOIN insurance_plans pl ON pl.id = bv.plan_id JOIN insurance_carriers c ON c.id = pl.carrier_id
     LEFT JOIN users u ON u.id = bv.verified_by
     WHERE bv.practice_id = ? AND bv.group_status = 'review' ORDER BY bv.id`, practiceId,
  );
  const out = [];
  for (const r of rows) {
    const members = (await db.get('SELECT COUNT(DISTINCT patient_id) AS n FROM patient_insurance WHERE plan_id = ? AND active = 1', r.plan_id)).n;
    const siblings = r.plan_group
      ? (await db.all('SELECT id, name, group_number, (SELECT COUNT(DISTINCT patient_id) FROM patient_insurance WHERE plan_id = insurance_plans.id AND active = 1) AS members FROM insurance_plans WHERE practice_id = ? AND carrier_id = ? AND id != ? AND active = 1', practiceId, r.carrier_id, r.plan_id))
        .filter((s) => norm(s.group_number) === norm(r.plan_group))
      : [];
    out.push({ ...r, proposed: json(r.proposed, {}), review_reasons: json(r.review_reasons, []), how: METHOD_LABELS[r.method] || r.method, by: r.by_name || r.actor, patient_name: `${r.first_name} ${r.last_name}`, members, siblings });
  }
  return out;
}

