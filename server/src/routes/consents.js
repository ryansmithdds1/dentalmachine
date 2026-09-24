import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, recorded } from '../util.js';
import { canSeePatient } from '../officeaccess.js';
import { cleanCodes } from '../formtemplates.js';
import {
  libraryState, installLibrary, currentVersion, alignSpanish, cleanCategories, consentsForTreatment, consentView, declineConsent, supersedeConsent,
} from '../consents.js';
import { CONSENT_LIBRARY } from '../consentlib.js';
import { DUE_RULES } from '../paperwork.js';
import { proofFor } from '../eduproof.js';

// Consents (C1–C4): the library, how consents are picked from treatment (Settings), each patient's consents,
// "patient declined" at the chair, and replacing a signed consent with a new version (which needs a new signature).
// Signing itself happens on the patient's screen (routes/paperworkpublic.js).
export default function consentRoutes({ db, storage }) {
  const r = Router();
  const adminOnly = (req) => { if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can change forms'); };
  const asId = (v, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${what} must be an id`);
    return n;
  };
  const consentOr404 = async (req) => {
    const c = await findOr404(db, 'consents', asId(req.params.cid, 'Consent'), req.user.practice_id, 'Consent');
    if (!(await canSeePatient(db, req.user, c.patient_id))) throw new HttpError(404, 'Consent not found');
    return c;
  };

  // ---- C1: the library ----
  r.get('/consents/library', requirePermission('patients:read'), async (req, res) => {
    res.json(await libraryState(db, req.user.practice_id));
  });
  r.post('/consents/library/install', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : req.body?.all ? CONSENT_LIBRARY.map((x) => x.key) : [];
    if (!keys.length) throw new HttpError(400, 'Choose the consents to add');
    const ids = await installLibrary(db, req, [...new Set(keys)].slice(0, 20));
    res.status(201).json({ template_ids: ids, library: await libraryState(db, req.user.practice_id) });
  });

  // ---- C2: which consents go with which treatment, Spanish wording, witness, when forms are due ----
  r.put('/form-templates/:tid/consent-settings', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    const t = await findOr404(db, 'form_templates', asId(req.params.tid, 'Form'), req.user.practice_id, 'Form');
    const b = req.body || {};
    const row = {};
    if (b.procedure_codes !== undefined) row.procedure_codes = cleanCodes(b.procedure_codes);
    if (b.procedure_categories !== undefined) row.procedure_categories = cleanCategories(b.procedure_categories);
    if (b.witness !== undefined) row.witness = b.witness ? 1 : 0;
    if (b.due_rule !== undefined) {
      if (b.due_rule !== null && !DUE_RULES.includes(b.due_rule)) throw new HttpError(400, `due_rule must be one of: ${DUE_RULES.join(', ')}`);
      row.due_rule = b.due_rule;
    }
    if (b.education_slugs !== undefined) {
      const slugs = (Array.isArray(b.education_slugs) ? b.education_slugs : []).map(String).filter((s) => /^[a-z0-9][a-z0-9-]{1,60}$/.test(s)).slice(0, 10);
      row.education_slugs = slugs.length ? JSON.stringify(slugs) : null;
    }
    // The office has had its attorney review the wording: the "template" marker comes off (audited).
    if (b.legal_reviewed !== undefined) row.legal_review = b.legal_reviewed ? 0 : 1;
    if (b.fields_es !== undefined) {
      const es = b.fields_es === null ? null : JSON.stringify(alignSpanish(JSON.parse(t.fields), b.fields_es));
      if (es !== t.fields_es) { row.fields_es = es; row.version = t.version + 1; }
    }
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    await recorded(db, 'form_templates', t.id, () => db.run(`UPDATE form_templates SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...Object.values(row), t.id));
    const v = await currentVersion(db, t.id, req.user.id);
    await audit(db, req, 'form_template.consent_settings', 'form_templates', t.id, { version: v.version, fields: Object.keys(row) });
    const out = await db.get('SELECT * FROM form_templates WHERE id = ?', t.id);
    res.json({ ...out, fields: JSON.parse(out.fields), fields_es: out.fields_es ? JSON.parse(out.fields_es) : null, education_slugs: JSON.parse(out.education_slugs || '[]') });
  });

  // Every version of a form's wording, and the exact text of one.
  r.get('/form-templates/:tid/versions', requirePermission('patients:read'), async (req, res) => {
    const t = await findOr404(db, 'form_templates', asId(req.params.tid, 'Form'), req.user.practice_id, 'Form');
    await currentVersion(db, t, req.user.id);
    res.json(await db.all(
      `SELECT v.id, v.version, v.name, v.content_hash, v.created_at, u.name AS created_by_name, (v.fields_es IS NOT NULL) AS spanish,
         (SELECT COUNT(*) FROM patient_forms f WHERE f.version_id = v.id) AS signed_count
       FROM form_template_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.template_id = ? ORDER BY v.version DESC`, t.id,
    ));
  });
  r.get('/form-template-versions/:vid', requirePermission('patients:read'), async (req, res) => {
    const v = await findOr404(db, 'form_template_versions', asId(req.params.vid, 'Version'), req.user.practice_id, 'Version');
    res.json({ ...v, fields: JSON.parse(v.fields), fields_es: v.fields_es ? JSON.parse(v.fields_es) : null });
  });

  // ---- A patient's consents ----
  r.get('/patients/:id/consents', requirePermission('patients:read'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const rows = await db.all('SELECT * FROM consents WHERE practice_id = ? AND patient_id = ? ORDER BY id DESC LIMIT 200', req.user.practice_id, p.id);
    const out = [];
    for (const c of rows) out.push(await consentView(db, c));
    res.json(out);
  });

  // C2: the consents a visit, a plan or chosen procedures need, attached (safe to call again; booking and planning
  // screens call it, and the autopilot does before each visit).
  r.post('/patients/:id/consents/attach', requirePermission('patients:write'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const b = req.body || {};
    let appointmentId = null;
    let planId = null;
    if (b.appointment_id != null) {
      const a = await findOr404(db, 'appointments', asId(b.appointment_id, 'appointment_id'), req.user.practice_id, 'Appointment');
      if (a.patient_id !== p.id) throw new HttpError(400, 'That appointment is for another patient');
      appointmentId = a.id;
    } else if (b.treatment_plan_id != null) {
      const plan = await findOr404(db, 'treatment_plans', asId(b.treatment_plan_id, 'treatment_plan_id'), req.user.practice_id, 'Treatment plan');
      if (plan.patient_id !== p.id) throw new HttpError(400, 'That plan is for another patient');
      planId = plan.id;
    } else if (!Array.isArray(b.procedure_ids) || !b.procedure_ids.length) throw new HttpError(400, 'Give an appointment_id, a treatment_plan_id or procedure_ids');
    const got = await consentsForTreatment(db, {
      practiceId: req.user.practice_id, patientId: p.id, appointmentId, planId, procedureIds: b.procedure_ids?.map((x) => asId(x, 'procedure_ids')), attach: true, userId: req.user.id, source: 'human',
    });
    const out = [];
    for (const c of got.consents) out.push(await consentView(db, c));
    res.json({ context: got.contextKey, consents: out });
  });

  r.get('/consents/:cid', requirePermission('patients:read'), async (req, res) => {
    const c = await consentOr404(req);
    const view = await consentView(db, c);
    const version = c.version_id ? await db.get('SELECT id, version, name, content_hash, created_at FROM form_template_versions WHERE id = ?', c.version_id) : null;
    const education = await proofFor(db, c.practice_id, c.patient_id, { consentId: c.id, appointmentId: c.appointment_id });
    const history = await db.all(
      "SELECT a.action, a.created_at, a.source, a.actor, a.ip, a.reason, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.practice_id = ? AND a.entity = 'consents' AND a.entity_id = ? ORDER BY a.id",
      c.practice_id, c.id,
    );
    await audit(db, req, 'consent.view', 'consents', c.id, { patient_id: c.patient_id });
    res.json({ ...view, wording: c.content ? JSON.parse(c.content) : null, version, education, history });
  });

  // "Patient declined": recorded by the clinician at the chair, with the reason — just as traceable as a signature.
  r.post('/consents/:cid/decline', requirePermission('clinical:write'), async (req, res) => {
    const c = await consentOr404(req);
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!reason) throw new HttpError(400, 'Say what the patient said (the reason they declined)');
    const docId = await declineConsent(db, storage, {
      consent: c, reason, userId: req.user.id, recordedBy: req.user.name, ip: req.ip, device: String(req.get('user-agent') || '').slice(0, 200), via: 'chair',
      lang: req.body?.lang === 'es' ? 'es' : 'en',
    });
    await audit(db, req, 'consent.decline', 'consents', c.id, { patient_id: c.patient_id, document_id: docId, via: 'chair' }, { reason });
    res.json(await consentView(db, await db.get('SELECT * FROM consents WHERE id = ?', c.id)));
  });

  // A signed consent never changes; when a new version is needed, the old one is kept (superseded) and a new
  // consent is needed — signed again by the patient.
  r.post('/consents/:cid/supersede', requirePermission('clinical:write'), async (req, res) => {
    const c = await consentOr404(req);
    const id = await supersedeConsent(db, req, c, String(req.body?.reason || '').trim());
    res.status(201).json(await consentView(db, await db.get('SELECT * FROM consents WHERE id = ?', id)));
  });

  // C3: before starting, the clinician sees whether the visit's consents are signed.
  r.get('/appointments/:id/consent-check', requirePermission('patients:read'), async (req, res) => {
    const a = await findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    const { consents } = await consentsForTreatment(db, { practiceId: a.practice_id, patientId: a.patient_id, appointmentId: a.id, attach: false });
    const list = consents.map((c) => ({ id: c.id, template_id: c.template_id, name: c.template_name, status: c.status, signed_at: c.signed_at || null, declined_at: c.declined_at || null, covers: !!c.covers }));
    res.json({ ready: list.every((c) => c.status === 'signed'), needed: list.filter((c) => c.status === 'needed' || c.status === 'sent'), signed: list.filter((c) => c.status === 'signed'), declined: list.filter((c) => c.status === 'declined'), consents: list });
  });

  return r;
}
