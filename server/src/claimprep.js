// Billing → Ready to approve (docs/workflows/specs/24-claims.md): claims are prepared by themselves, and a
// person approves each one before anything goes to a payer.
//
// Nothing is stored for the queue: it's worked out when it's read, from completed, unbilled work for insured
// patients — one group per patient, primary policy and office (claims are billed per office). Each group runs
// the same checks a claim gets before it's sent (claimProblems from routes/edi.js, attachmentHints, and the
// scrubber's denial risks via scrubWork), so what's "ready" here is what the send would accept. No claim is
// made and nothing is sent until a person approves (routes/claimprep.js). The ledger is never touched here.
import { patientScope } from './officeaccess.js';
import { practiceNow } from './util.js';
import { estimateCoverage } from './benefits.js';
import { attachmentHints } from './attachments.js';
import { scrubWork } from './scrubber.js';
import { suggestAttachments } from './routes/attachments.js';
import { denialFor, narrativeOf } from './predict/denial.js';

// Older unbilled work is past most payers' filing limits: the month-end packet's business, not this list's.
export const PREP_LOOKBACK_DAYS = 365;
export const MAX_GROUPS = 300;

const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

// A group's key names exactly the work that was on screen: approving a key whose work has changed since
// (a procedure finished or billed in between) is refused, so a person approves what they saw.
export const groupKey = (g) => `p${g.patient_id}-i${g.patient_insurance_id}-l${g.location_id ?? 0}-${g.procedure_ids.join('.')}`;
export function parseKey(key) {
  const m = /^p(\d{1,12})-i(\d{1,12})-l(\d{1,12})-(\d{1,12}(?:\.\d{1,12}){0,99})$/.exec(String(key || ''));
  if (!m) return null;
  return { patient_id: Number(m[1]), patient_insurance_id: Number(m[2]), location_id: Number(m[3]) || null, procedure_ids: m[4].split('.').map(Number) };
}

export async function prepEnabled(db, practiceId) {
  return !!(await db.get('SELECT claim_prep FROM practices WHERE id = ?', practiceId))?.claim_prep;
}

// Completed, unbilled work (fee > 0) for patients with active insurance, to the policy billPatient would use
// (primary first). Work from a visit still in the chair waits until the patient leaves, so a claim isn't
// prepared for half a visit. Skipped work (a person's "skip for now") is left out, or only it, with skipped.
async function unbilledWork(db, { practiceId, user = null, locationId = null, patientId = null, skipped = false }) {
  const today = (await practiceNow(db, practiceId)).slice(0, 10);
  const scope = patientScope(user, 'p');
  const where = [];
  const args = [practiceId, addDays(today, -PREP_LOOKBACK_DAYS)];
  if (patientId) { where.push('pr.patient_id = ?'); args.push(patientId); }
  if (locationId) { where.push('(pr.location_id = ? OR pr.location_id IS NULL)'); args.push(locationId); }
  return db.all(
    `SELECT pr.id, pr.practice_id, pr.patient_id, pr.code, pr.description, pr.category, pr.tooth, pr.surfaces, pr.area, pr.fee, pr.completed_at,
       pr.location_id, pr.provider_id, pr.code_id, pr.status, pr.appointment_id,
       pc.requires_tooth, pc.requires_surface, pv.name AS provider_name, pv.npi AS provider_npi, pi.id AS policy_id
     FROM procedures pr
     JOIN patients p ON p.id = pr.patient_id
     JOIN patient_insurance pi ON pi.id = (SELECT x.id FROM patient_insurance x WHERE x.patient_id = pr.patient_id AND x.practice_id = pr.practice_id AND x.active = 1
       ORDER BY CASE x.priority WHEN 'primary' THEN 0 ELSE 1 END, x.id LIMIT 1)
     LEFT JOIN procedure_codes pc ON pc.id = pr.code_id
     LEFT JOIN providers pv ON pv.id = pr.provider_id
     WHERE pr.practice_id = ? AND pr.status = 'completed' AND pr.fee > 0 AND substr(pr.completed_at, 1, 10) >= ?
       AND NOT EXISTS (SELECT 1 FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE ci.procedure_id = pr.id AND c.status != 'void' AND c.patient_insurance_id = pi.id)
       AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id = pr.appointment_id AND a.status IN ('checked_in','in_chair'))
       AND ${skipped ? '' : 'NOT '}EXISTS (SELECT 1 FROM claim_prep_skips s WHERE s.procedure_id = pr.id AND s.patient_insurance_id = pi.id AND s.restored_at IS NULL)
       ${where.length ? `AND ${where.join(' AND ')}` : ''}${scope.sql}
     ORDER BY pr.patient_id, pr.completed_at, pr.id`,
    ...args, ...scope.args,
  );
}

function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.patient_id}|${r.policy_id}|${r.location_id ?? 0}`;
    if (!groups.has(k)) groups.set(k, { patient_id: r.patient_id, patient_insurance_id: r.policy_id, location_id: r.location_id ?? null, procedures: [] });
    groups.get(k).procedures.push(r);
  }
  return [...groups.values()].map((g) => {
    g.procedures.sort((a, b) => a.id - b.id);
    g.procedure_ids = g.procedures.map((p) => p.id);
    g.key = groupKey(g);
    return g;
  });
}

// How many groups are waiting (the tab's badge) — no checks, just the grouping.
export async function countGroups(db, opts) {
  if (!(await prepEnabled(db, opts.practiceId))) return 0;
  return groupRows(await unbilledWork(db, opts)).length;
}

// Where each clearinghouse problem is fixed, in words and a link.
function fixFor(problem, g) {
  const at = (kind, link, label) => ({ kind, message: problem, hard: true, link, link_label: label });
  if (/^Practice /.test(problem)) return at('practice', '/settings?tab=practice', 'Open practice settings');
  if (/^Payer ID/.test(problem)) return at('carrier', '/settings?tab=carriers', 'Open insurance carriers');
  if (/date of birth/.test(problem)) return at('patient', `/patients/${g.patient_id}`, 'Open the patient');
  if (/provider NPI/.test(problem)) return at('provider', '/settings?tab=providers', 'Open providers');
  if (/attachments first/.test(problem)) return null; // prepared attachments are sent on approval, before the claim
  return at('insurance', `/patients/${g.patient_id}?tab=insurance`, 'Open the insurance');
}

// Every check a claim for this group would get, for unsaved work. Blocking fixes are either "hard" (the
// clearinghouse would reject it, so it must be fixed where the data lives) or soft (a missing x-ray or narrative,
// a likely denial — fixed inline, or approved anyway with a reason a person gives).
async function checkGroup(db, g, { practice, claimProblems }) {
  const policy = await db.get('SELECT * FROM patient_insurance WHERE id = ?', g.patient_insurance_id);
  const carrier = await db.get('SELECT * FROM insurance_carriers WHERE id = ?', policy.carrier_id);
  const patient = await db.get('SELECT id, first_name, last_name, dob FROM patients WHERE id = ?', g.patient_id);
  const prepared = await db.all(
    `SELECT a.id, a.document_id, a.report_type, a.narrative, a.created_at, d.filename FROM claim_prep_attachments a LEFT JOIN documents d ON d.id = a.document_id
     WHERE a.practice_id = ? AND a.patient_insurance_id = ? AND a.claim_id IS NULL AND a.removed_at IS NULL ORDER BY a.id`,
    practice.id, policy.id,
  );
  const items = g.procedures;
  const fixes = [];
  const bundle = {
    claim: { frequency_code: null, original_reference: null }, policy, primary: null, carrier, patient, items,
    // Prepared attachments get their control numbers when the group is approved, before the claim goes.
    attachments: prepared.map((a) => ({ ...a, control_number: 'on approval' })),
  };
  for (const problem of claimProblems(bundle, practice)) {
    const fix = fixFor(problem, g);
    if (fix) fixes.push(fix);
  }
  const insurance = { kind: 'insurance', hard: true, link: `/patients/${g.patient_id}?tab=insurance`, link_label: 'Open the insurance' };
  if (!String(policy.subscriber_id || '').trim()) fixes.push({ ...insurance, message: 'The subscriber (member) ID is missing on the insurance' });
  if (policy.relationship !== 'self' && !String(policy.subscriber_name || '').trim()) fixes.push({ ...insurance, message: 'The subscriber’s name is missing on the insurance' });

  // X-rays and perio charts payers want: the attachment suggestions the claim screen uses, found in the chart.
  let suggestions = [];
  if (attachmentHints(items, prepared).length) {
    const s = await suggestAttachments(db, {
      practiceId: practice.id, patientId: g.patient_id, attached: prepared,
      items: items.map((i) => ({ code: i.code, tooth: i.tooth, service_date: String(i.completed_at || '').slice(0, 10) })),
    });
    suggestions = s.suggestions;
    for (const need of s.needs) {
      const found = s.suggestions.some((x) => x.report_type === need.type);
      fixes.push({
        kind: need.type === 'P6' ? 'perio' : 'xray', report_type: need.type, hard: false, teeth: need.teeth,
        message: `${need.reasons.join('; ')}${found ? '' : ' — nothing suitable is in the chart yet'}`,
      });
    }
  }
  // The scrubber: likely denials block (fix, or approve anyway with a reason); narrative warnings ask for one;
  // anything else is a heads-up.
  const risks = await scrubWork(db, { practiceId: practice.id, policy, items, attachments: prepared });
  const notes = [];
  const narrative = risks.filter((r) => r.fix === 'narrative');
  if (narrative.length) fixes.push({ kind: 'narrative', hard: false, message: [...new Set(narrative.map((r) => `${r.code}${r.tooth ? ` #${r.tooth}` : ''}: ${r.message}`))].join('; ') });
  for (const r of risks.filter((x) => x.level === 'deny')) fixes.push({ kind: 'risk', hard: false, message: `${r.code}${r.tooth ? ` #${r.tooth}` : ''}: ${r.message}` });
  for (const r of risks.filter((x) => x.level === 'warn' && x.fix !== 'narrative')) notes.push(`${r.code}${r.tooth ? ` #${r.tooth}` : ''}: ${r.message}`);

  // The chance the payer denies it, from this office's history with this payer and these codes plus the checks above
  // (predict/denial.js). It informs the person approving; it never holds or changes a claim by itself.
  const denial = await denialFor(db, practice.id, { carrierId: carrier.id, carrierName: carrier.name, items, risks, hasNarrative: narrativeOf(prepared, null) });
  const est = await estimateCoverage(db, { ...policy, carrier_name: carrier.name }, items);
  return {
    key: g.key, patient_id: g.patient_id, patient_name: `${patient.first_name} ${patient.last_name}`, patient_insurance_id: policy.id,
    priority: policy.priority, carrier_name: carrier.name, location_id: g.location_id,
    procedures: items.map((i) => ({ id: i.id, code: i.code, description: i.description, tooth: i.tooth, surfaces: i.surfaces, fee: i.fee, completed_at: i.completed_at, provider_name: i.provider_name })),
    procedure_ids: g.procedure_ids,
    first_service: String(items[0].completed_at || '').slice(0, 10),
    total_fee: items.reduce((t, i) => t + i.fee, 0), est_insurance: est.total_insurance,
    status: fixes.length ? 'needs_fix' : 'ready', fixes, can_override: fixes.length > 0 && fixes.every((f) => !f.hard), notes,
    attachments: prepared.map((a) => ({ id: a.id, report_type: a.report_type, document_id: a.document_id, filename: a.filename, narrative: a.narrative })),
    suggestions, denial,
  };
}

// The queue as a person sees it: their offices' patients (and the office they're working in), ready ones first.
export async function prepareGroups(db, { practiceId, user = null, locationId = null, patientId = null, claimProblems }) {
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  const groups = groupRows(await unbilledWork(db, { practiceId, user, locationId, patientId }));
  const out = [];
  for (const g of groups.slice(0, MAX_GROUPS)) out.push(await checkGroup(db, g, { practice, claimProblems }));
  out.sort((a, b) => ((a.status === 'ready' ? 0 : 1) - (b.status === 'ready' ? 0 : 1)) || a.first_service.localeCompare(b.first_service) || a.patient_id - b.patient_id);
  return { groups: out, more: Math.max(0, groups.length - MAX_GROUPS) };
}

// What's been skipped, one row per skip (reason, who, when, the work), for "Put back".
export async function skippedGroups(db, { practiceId, user = null, locationId = null }) {
  const work = await unbilledWork(db, { practiceId, user, locationId, skipped: true });
  if (!work.length) return [];
  const byProc = new Map(work.map((w) => [w.id, w]));
  const rows = await db.all(
    `SELECT s.skip_group, s.procedure_id, s.reason, s.created_at, s.patient_id, u.name AS skipped_by_name, p.first_name, p.last_name
     FROM claim_prep_skips s JOIN patients p ON p.id = s.patient_id LEFT JOIN users u ON u.id = s.skipped_by
     WHERE s.practice_id = ? AND s.restored_at IS NULL ORDER BY s.id DESC`, practiceId,
  );
  const out = new Map();
  for (const r of rows) {
    const w = byProc.get(r.procedure_id);
    if (!w) continue; // billed since, or not one of this person's patients
    if (!out.has(r.skip_group)) out.set(r.skip_group, { skip_group: r.skip_group, patient_id: r.patient_id, patient_name: `${r.first_name} ${r.last_name}`, reason: r.reason, skipped_by_name: r.skipped_by_name, skipped_at: r.created_at, procedures: [], total_fee: 0 });
    const g = out.get(r.skip_group);
    g.procedures.push({ id: w.id, code: w.code, description: w.description, tooth: w.tooth, fee: w.fee, completed_at: w.completed_at });
    g.total_fee += w.fee;
  }
  return [...out.values()];
}
