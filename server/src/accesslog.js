// HIPAA access log for reads: who looked at which patient's notes, perio, plans, ledger, images and so on
// (staff, API keys and the patient portal). Writes are audited where they happen; the reads that already
// audit themselves (chart, patient, document files) aren't repeated here. The same person re-reading the
// same thing within a minute is one entry, so screens that refresh don't flood the log.
import { audit } from './util.js';

const RULES = [
  [/^\/patients\/(\d+)\/(notes|perio|treatment-plans|prescriptions|ledger|statement|documents|mounts|insurance|insurance-updates|procedures|vitals|forms|history-review|ortho|referrals|payment-methods|payment-plans|payment-requests|eligibility|family|note-draft|followups|membership|unclaimed-procedures|conversation|consents\/suggest)$/, 'patients', (m) => `patient.${m[2].replace(/\//g, '_')}.view`],
  [/^\/documents\/(\d+)\/(thumb|viewer)$/, 'documents', (m) => `document.${m[2]}`],
  [/^\/imaging\/unfiled\/(\d+)\/image$/, 'unfiled_images', () => 'imaging.unfiled_view'],
  [/^\/treatment-plans\/(\d+)$/, 'treatment_plans', () => 'treatment_plan.view'],
  [/^\/treatment-plans\/(\d+)\/pdf$/, 'treatment_plans', () => 'treatment_plan.pdf'],
  [/^\/prescriptions\/(\d+)$/, 'prescriptions', () => 'prescription.view'],
  [/^\/claims\/(\d+)$/, 'claims', () => 'claim.view'],
  [/^\/claims\/(\d+)\/attachments$/, 'claims', () => 'claim.attachments_view'],
  [/^\/v1\/patients$/, 'patients', () => 'api.patients.list'],
  [/^\/v1\/patients\/(\d+)$/, 'patients', () => 'api.patient.view'],
  [/^\/v1\/appointments(\/\d+)?$/, 'appointments', () => 'api.appointments.view'],
  [/^\/v1\/payments$/, 'ledger_entries', () => 'api.payments.list'],
  [/^\/portal\/(me|messages|insurance|statement\.pdf|payments)$/, 'patients', (m) => `portal.${m[1].replace('.pdf', '')}.view`],
  [/^\/portal\/receipts\/(\d+)\.pdf$/, 'ledger_entries', () => 'portal.receipt.view'],
];

export function readAudit(db) {
  const recent = new Map();
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    const path = req.path.replace(/^\/api/, '');
    const hit = RULES.find(([re]) => re.test(path));
    if (!hit) return next();
    res.on('finish', () => {
      if (res.statusCode >= 300) return;
      const who = req.api ? { practice_id: req.api.practice_id, id: null } : req.portal ? { practice_id: req.portal.practice.id, id: null } : req.user;
      if (!who?.practice_id) return;
      const tag = req.api ? `k${req.api.key_id}` : req.portal ? `p${req.portal.patient.id}` : `u${who.id}`;
      const key = `${tag}|${path}`;
      const now = Date.now();
      if (now - (recent.get(key) || 0) < 60_000) return;
      recent.set(key, now);
      if (recent.size > 5000) for (const [k, t] of recent) if (now - t > 60_000) recent.delete(k);
      const [re, entity, action] = hit;
      const m = path.match(re);
      const id = m[1] && /^\d+$/.test(m[1]) ? Number(m[1]) : req.portal ? req.portal.patient.id : null;
      const details = req.api ? { api_key_id: req.api.key_id } : req.portal ? { portal_patient_id: req.portal.patient.id } : null;
      audit(db, { ip: req.ip, user: who }, action(m), entity, id, details).catch(() => {});
    });
    next();
  };
}
