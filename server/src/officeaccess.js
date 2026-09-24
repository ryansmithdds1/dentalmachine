// Location restrictions as access control. Someone limited to some offices (users.location_ids) sees those
// offices' schedule and only the patients who belong there: the patient's home office is one of theirs, or
// they have a visit at one of them. A patient with no home office and no visit at any office (a new chart)
// is open to everyone. Everyone else in the practice is unaffected.
import { HttpError } from './auth.js';

export const restricted = (user) => Array.isArray(user?.location_ids) && user.location_ids.length > 0;

const list = (ids) => ids.map(() => '?').join(',');

// SQL condition on a patients alias for "this person may see the patient".
export function patientScope(user, alias = 'p') {
  if (!restricted(user)) return { sql: '', args: [] };
  const ids = user.location_ids;
  return {
    sql: ` AND (${alias}.location_id IN (${list(ids)})
      OR EXISTS (SELECT 1 FROM appointments xa WHERE xa.patient_id = ${alias}.id AND xa.location_id IN (${list(ids)}))
      OR (${alias}.location_id IS NULL AND NOT EXISTS (SELECT 1 FROM appointments xb WHERE xb.patient_id = ${alias}.id AND xb.location_id IS NOT NULL)))`,
    args: [...ids, ...ids],
  };
}

// SQL condition on an appointments alias: their offices' visits (and visits not tied to an office).
export function appointmentScope(user, alias = 'a') {
  if (!restricted(user)) return { sql: '', args: [] };
  return { sql: ` AND (${alias}.location_id IS NULL OR ${alias}.location_id IN (${list(user.location_ids)}))`, args: [...user.location_ids] };
}

// Every patient id sent in a request body (statements, campaigns, surveys…) must be one the person can see.
export async function requireVisiblePatients(db, user, ids) {
  if (!restricted(user)) return;
  for (const id of ids) if (!(await canSeePatient(db, user, id))) throw new HttpError(404, 'Patient not found');
}

export async function canSeePatient(db, user, patientId) {
  if (!restricted(user) || !patientId) return true;
  const s = patientScope(user);
  return !!(await db.get(`SELECT p.id FROM patients p WHERE p.id = ? AND p.practice_id = ?${s.sql}`, Number(patientId), user.practice_id, ...s.args));
}

// /<segment>/:id routes whose record belongs to a patient.
const TABLES = {
  appointments: 'appointments', claims: 'claims', 'treatment-plans': 'treatment_plans', documents: 'documents', procedures: 'procedures',
  memberships: 'memberships', notes: 'clinical_notes', referrals: 'referrals', recalls: 'recalls', preauths: 'preauths', perio: 'perio_exams',
  payments: 'ledger_entries', receipts: 'ledger_entries', ledger: 'ledger_entries', 'payment-plans': 'payment_plans', ortho: 'ortho_cases',
  mounts: 'image_mounts', 'lab-cases': 'lab_cases', insurance: 'patient_insurance', 'booking-requests': 'booking_requests', waitlist: 'waitlist',
  tasks: 'tasks', prescriptions: 'prescriptions', 'payment-methods': 'payment_methods', 'patient-forms': 'patient_forms',
  'insurance-updates': 'insurance_updates', conditions: 'tooth_conditions', eligibility: 'eligibility_checks', 'terminal-payments': 'terminal_payments',
  calls: 'calls', 'ai-findings': 'xray_findings', deposits: 'deposits',
};

// Reports that can be held to the person's offices (see reports.js); every other report covers the whole
// practice, so it isn't open to someone limited to some offices.
const OFFICE_REPORTS = new Set(['/reports/production', '/reports/adjustments', '/reports/daysheet', '/reports/my-production']);
// Practice-wide tools (the report builder and "Ask your data" answer across every office) are closed to
// someone limited to some offices, whatever the method.
const PRACTICE_WIDE = /^\/(reports|query|query-builder|saved-reports|audit-log|backup|exports?|ask)(\/|$)/;

// Lists (claims, messages, recalls, tasks, follow-up lists…) drop rows about patients the person can't see:
// any array in the response whose rows carry a patient_id, at the top level or one level down.
async function filterRows(db, user, body) {
  const arrays = Array.isArray(body) ? [body] : body && typeof body === 'object' ? Object.values(body).filter(Array.isArray) : [];
  const ids = [...new Set(arrays.flatMap((a) => a.map((x) => x?.patient_id).filter((v) => Number.isInteger(v))))];
  if (!ids.length) return body;
  const s = patientScope(user);
  const visible = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of await db.all(`SELECT p.id FROM patients p WHERE p.practice_id = ? AND p.id IN (${list(chunk)})${s.sql}`, user.practice_id, ...chunk, ...s.args)) visible.add(r.id);
  }
  const keep = (a) => a.filter((x) => !Number.isInteger(x?.patient_id) || visible.has(x.patient_id));
  if (Array.isArray(body)) return Object.assign(keep(body), body.total != null ? { total: body.total } : {});
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, Array.isArray(v) ? keep(v) : v]));
}

// Runs after sign-in on every staff API request. Out-of-office records answer 404, as if they didn't exist.
export function officeAccess(db) {
  const hidden = () => new HttpError(404, 'Not found');
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!restricted(user)) return next();
      if (req.method === 'GET') {
        const send = res.json.bind(res);
        res.json = (body) => {
          filterRows(db, user, body).then(send, (err) => next(err));
          return res;
        };
      }
      if (PRACTICE_WIDE.test(req.path) && !OFFICE_REPORTS.has(req.path)) {
        throw new HttpError(403, 'This report covers every office. Ask an administrator.');
      }
      const [, segment, rawId] = req.path.split('/');
      if (!rawId) return next();
      if (segment === 'patients' || segment === 'collections') {
        if (/^\d+$/.test(rawId) && !(await canSeePatient(db, user, rawId))) throw hidden();
        return next();
      }
      if (segment === 'conversations') {
        const m = rawId.match(/^p(\d+)$/);
        if (m && !(await canSeePatient(db, user, m[1]))) throw hidden();
        return next();
      }
      const table = TABLES[segment];
      if (!table || !/^\d+$/.test(rawId.replace(/\.pdf$/, ''))) return next();
      const row = await db.get(`SELECT * FROM ${table} WHERE id = ? AND practice_id = ?`, Number(rawId.replace(/\.pdf$/, '')), user.practice_id);
      if (!row) return next(); // the route answers 404 itself
      if (row.location_id != null && ['appointments', 'ledger_entries', 'booking_requests', 'calls', 'deposits'].includes(table) && !user.location_ids.includes(row.location_id)) throw hidden();
      if (row.patient_id && !(await canSeePatient(db, user, row.patient_id))) throw hidden();
      next();
    } catch (err) {
      next(err);
    }
  };
}

// A new or moved appointment (or other record placed at an office) must be at one of the person's offices.
export function checkOffice(user, locationId) {
  if (restricted(user) && locationId != null && !user.location_ids.includes(Number(locationId))) throw new HttpError(403, "That office isn't one of yours");
}
