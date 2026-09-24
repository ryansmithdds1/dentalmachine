import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit } from '../util.js';
import { mintHandoff, HANDOFF_MINUTES } from '../handoff.js';
import { cleanFields, cleanCodes, seedTemplates, createPacket, templateMatches, procContext, FORM_KINDS } from '../formtemplates.js';
import { currentVersion } from '../consents.js';

// Form templates (consents, policies, intake) and sending them to patients.
export default function formRoutes({ db, messenger, config }) {
  const r = Router();
  const adminOnly = (req) => { if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can change forms'); };
  const view = (t) => ({ ...t, fields: JSON.parse(t.fields) });
  const clean = (body, existing = {}) => {
    const row = {};
    if (body.name !== undefined) {
      row.name = String(body.name || '').trim().slice(0, 120);
      if (!row.name) throw new HttpError(400, 'Name the form');
    }
    if (body.kind !== undefined) {
      if (!FORM_KINDS.includes(body.kind)) throw new HttpError(400, `kind must be one of: ${FORM_KINDS.join(', ')}`);
      row.kind = body.kind;
    }
    if (body.description !== undefined) row.description = String(body.description || '').slice(0, 500) || null;
    if (body.fields !== undefined) row.fields = JSON.stringify(cleanFields(body.fields));
    if (body.procedure_codes !== undefined) row.procedure_codes = cleanCodes(body.procedure_codes);
    if (body.auto_send !== undefined) row.auto_send = body.auto_send ? 1 : 0;
    if (body.renew_months !== undefined) {
      row.renew_months = Number(body.renew_months) || 0;
      if (row.renew_months < 0 || row.renew_months > 120) throw new HttpError(400, 'renew_months must be 0-120');
    }
    if (body.active !== undefined) row.active = body.active ? 1 : 0;
    // Editing the wording makes a new version; signed forms keep the version they were signed against.
    if (row.fields && existing.fields && row.fields !== existing.fields) row.version = (existing.version || 1) + 1;
    return row;
  };

  r.get('/form-templates', requirePermission('patients:read'), async (req, res) => {
    await seedTemplates(db, req.user.practice_id);
    const rows = await db.all(`SELECT * FROM form_templates WHERE practice_id = ?${req.query.all === 'true' ? '' : ' AND active = 1'} ORDER BY active DESC, kind, name`, req.user.practice_id);
    res.json(rows.map(view));
  });

  r.post('/form-templates', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    const row = clean({ kind: 'consent', ...req.body });
    if (!row.name || !row.fields) throw new HttpError(400, 'A form needs a name and fields');
    const keys = Object.keys(row);
    const { id } = await db.run(`INSERT INTO form_templates (practice_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`, req.user.practice_id, ...Object.values(row));
    // Every wording is kept (form_template_versions): a signed form points at the exact version it was signed against.
    await currentVersion(db, id, req.user.id);
    await audit(db, req, 'form_template.create', 'form_templates', id);
    res.status(201).json(view(await db.get('SELECT * FROM form_templates WHERE id = ?', id)));
  });

  r.put('/form-templates/:tid', requirePermission('patients:write'), async (req, res) => {
    adminOnly(req);
    const existing = await findOr404(db, 'form_templates', req.params.tid, req.user.practice_id, 'Form');
    const row = clean(req.body, existing);
    if (Object.keys(row).length) {
      await db.run(`UPDATE form_templates SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...Object.values(row), existing.id);
    }
    await currentVersion(db, existing.id, req.user.id);
    await audit(db, req, 'form_template.update', 'form_templates', existing.id, row.version ? { version: row.version } : undefined);
    res.json(view(await db.get('SELECT * FROM form_templates WHERE id = ?', existing.id)));
  });

  // Consents that fit the chosen procedures (e.g. extraction consent for D7140).
  r.get('/patients/:id/consents/suggest', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const ids = String(req.query.procedure_ids || '').split(',').map(Number).filter(Boolean);
    const procs = ids.length ? await db.all(`SELECT code FROM procedures WHERE patient_id = ? AND id IN (${ids.map(() => '?').join(',')})`, patient.id, ...ids) : [];
    await seedTemplates(db, req.user.practice_id);
    const templates = await db.all('SELECT * FROM form_templates WHERE practice_id = ? AND active = 1 AND procedure_codes IS NOT NULL', req.user.practice_id);
    res.json(templates.filter((t) => templateMatches(t, procs.map((p) => p.code))).map(view));
  });

  // Sends (or opens on this device) one link with the chosen forms. Consents are filled in with the
  // procedures, teeth and provider they're for.
  r.post('/patients/:id/form-packets', requirePermission('patients:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const b = req.body || {};
    let appointmentId = null;
    let procs = [];
    let providerName = '';
    if (b.appointment_id) {
      const a = await findOr404(db, 'appointments', b.appointment_id, req.user.practice_id, 'Appointment');
      if (a.patient_id !== patient.id) throw new HttpError(400, 'That appointment is for another patient');
      appointmentId = a.id;
      procs = await db.all("SELECT code, description, tooth, provider_id FROM procedures WHERE appointment_id = ? AND status = 'planned'", a.id);
      providerName = (await db.get('SELECT name FROM providers WHERE id = ?', a.provider_id))?.name;
    }
    const ids = (Array.isArray(b.procedure_ids) ? b.procedure_ids : []).map(Number).filter(Boolean);
    if (ids.length) {
      procs = await db.all(`SELECT code, description, tooth, provider_id FROM procedures WHERE patient_id = ? AND practice_id = ? AND id IN (${ids.map(() => '?').join(',')})`, patient.id, req.user.practice_id, ...ids);
      if (procs.length !== new Set(ids).size) throw new HttpError(404, 'Procedure not found');
    }
    if (!providerName && procs[0]?.provider_id) providerName = (await db.get('SELECT name FROM providers WHERE id = ?', procs[0].provider_id))?.name;
    const packet = await createPacket(db, messenger, {
      practiceId: req.user.practice_id, patient, templateIds: Array.isArray(b.template_ids) ? b.template_ids : [], history: !!b.history,
      appointmentId, context: procContext(procs, providerName), userId: req.user.id, send: b.send || null, appUrl: config.appUrl,
    });
    await audit(db, req, 'form_request.create', 'form_requests', packet.id, { forms: packet.ids.length, sent: !!packet.message });
    // Signing here on the office device: a one-time pass past the birth-date step, for this packet and this
    // signed-in session only (see handoff.js). Who handed the device over is on the record.
    if (b.here && !b.send) {
      packet.handoff = await mintHandoff(db, req, 'forms', packet.id);
      await audit(db, req, 'form_request.handoff', 'form_requests', packet.id, { patient_id: patient.id, minutes: HANDOFF_MINUTES });
    }
    res.status(201).json(packet);
  });

  return r;
}
