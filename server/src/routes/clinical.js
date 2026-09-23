import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import {
  pick, requireFields, requireOneOf, insert, update, findOr404, audit, validTooth, normalizeSurfaces, mapSeq } from '../util.js';
import { completeProcedure, estimateCoverage, primaryPolicy } from '../services.js';

export const CONDITIONS = [
  'caries', 'missing', 'filling', 'crown', 'root_canal', 'implant', 'bridge_pontic', 'fracture',
  'sealant', 'veneer', 'impacted', 'watch', 'abscess', 'mobility',
];

function normalizeToothFields(row) {
  if (row.tooth != null) {
    row.tooth = String(row.tooth).toUpperCase();
    if (!validTooth(row.tooth)) throw new HttpError(400, 'tooth must be 1-32 or A-T');
  }
  if ('surfaces' in row) row.surfaces = normalizeSurfaces(row.surfaces);
  return row;
}

export default function clinicalRoutes({ db }) {
  const r = Router();
  const patientOr404 = async (req) => await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');

  // ---- Odontogram ----
  r.get('/patients/:id/chart', requirePermission('clinical:read'), async (req, res) => {
    const patient = await patientOr404(req);
    await audit(db, req, 'chart.view', 'patients', patient.id);
    res.json({
      conditions: await db.all('SELECT * FROM tooth_conditions WHERE patient_id = ? AND practice_id = ? ORDER BY recorded_at DESC', patient.id, req.user.practice_id),
      procedures: await db.all(
        `SELECT pr.*, pv.name AS provider_name FROM procedures pr LEFT JOIN providers pv ON pv.id = pr.provider_id
         WHERE pr.patient_id = ? AND pr.practice_id = ? AND pr.status != 'cancelled' ORDER BY COALESCE(pr.completed_at, pr.created_at) DESC`,
        patient.id, req.user.practice_id,
      ),
    });
  });

  r.post('/patients/:id/conditions', requirePermission('clinical:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const row = normalizeToothFields(pick(req.body, ['tooth', 'surfaces', 'condition', 'notes']));
    requireFields(row, ['tooth', 'condition']);
    requireOneOf(row.condition, CONDITIONS, 'condition');
    const id = await insert(db, 'tooth_conditions', { ...row, patient_id: patient.id, practice_id: req.user.practice_id, recorded_by: req.user.id });
    await audit(db, req, 'condition.create', 'tooth_conditions', id);
    res.status(201).json(await db.get('SELECT * FROM tooth_conditions WHERE id = ?', id));
  });

  r.put('/conditions/:cid', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'tooth_conditions', req.params.cid, req.user.practice_id, 'Condition');
    const row = normalizeToothFields(pick(req.body, ['surfaces', 'condition', 'notes', 'resolved']));
    requireOneOf(row.condition, CONDITIONS, 'condition');
    await update(db, 'tooth_conditions', existing.id, req.user.practice_id, row);
    await audit(db, req, 'condition.update', 'tooth_conditions', existing.id);
    res.json(await db.get('SELECT * FROM tooth_conditions WHERE id = ?', existing.id));
  });

  // ---- Procedures ----
  async function buildProcedure(req, patientId, input) {
    const row = normalizeToothFields(pick(input, ['code_id', 'code', 'tooth', 'surfaces', 'fee', 'provider_id', 'treatment_plan_id', 'appointment_id', 'priority']));
    const pid = req.user.practice_id;
    const code = row.code_id
      ? await findOr404(db, 'procedure_codes', row.code_id, pid, 'Procedure code')
      : await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', pid, String(row.code || '').toUpperCase());
    if (!code) throw new HttpError(400, 'A valid code_id or code is required');
    if (code.requires_tooth && !row.tooth) throw new HttpError(400, `${code.code} requires a tooth`);
    if (code.requires_surface && !row.surfaces) throw new HttpError(400, `${code.code} requires surfaces`);
    if (row.provider_id) await findOr404(db, 'providers', row.provider_id, pid, 'Provider');
    if (row.appointment_id) await findOr404(db, 'appointments', row.appointment_id, pid, 'Appointment');
    if (row.treatment_plan_id) {
      const plan = await findOr404(db, 'treatment_plans', row.treatment_plan_id, pid, 'Treatment plan');
      if (plan.patient_id !== patientId) throw new HttpError(400, 'Treatment plan belongs to another patient');
    }
    const fee = row.fee != null ? Math.round(Number(row.fee)) : code.fee;
    if (!Number.isFinite(fee) || fee < 0) throw new HttpError(400, 'fee must be a non-negative number of cents');
    return {
      practice_id: pid, patient_id: patientId, code_id: code.id, code: code.code, description: code.description, category: code.category,
      tooth: row.tooth ?? null, surfaces: row.surfaces ?? null, fee, provider_id: row.provider_id ?? null,
      treatment_plan_id: row.treatment_plan_id ?? null, appointment_id: row.appointment_id ?? null, priority: row.priority ?? 1,
    };
  }

  r.get('/patients/:id/procedures', requirePermission('clinical:read'), async (req, res) => {
    const patient = await patientOr404(req);
    const where = ['pr.patient_id = ?', 'pr.practice_id = ?'];
    const params = [patient.id, req.user.practice_id];
    if (req.query.status) {
      where.push('pr.status = ?');
      params.push(req.query.status);
    }
    res.json(await db.all(
      `SELECT pr.*, pv.name AS provider_name FROM procedures pr LEFT JOIN providers pv ON pv.id = pr.provider_id
       WHERE ${where.join(' AND ')} ORDER BY pr.priority, pr.id`, ...params,
    ));
  });

  // Adds a planned procedure, or charts one as already completed with {complete: true}.
  r.post('/patients/:id/procedures', requirePermission('clinical:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const row = await buildProcedure(req, patient.id, req.body || {});
    const id = await db.tx(async () => {
      const newId = await insert(db, 'procedures', row);
      if (req.body?.complete) await completeProcedure(db, req.user, await db.get('SELECT * FROM procedures WHERE id = ?', newId));
      return newId;
    });
    await audit(db, req, 'procedure.create', 'procedures', id, { code: row.code, complete: !!req.body?.complete });
    res.status(201).json(await db.get('SELECT * FROM procedures WHERE id = ?', id));
  });

  r.put('/procedures/:pid', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'procedures', req.params.pid, req.user.practice_id, 'Procedure');
    if (existing.status !== 'planned') throw new HttpError(409, 'Only planned procedures can be edited');
    const row = normalizeToothFields(pick(req.body, ['tooth', 'surfaces', 'fee', 'provider_id', 'treatment_plan_id', 'appointment_id', 'priority']));
    if (row.provider_id) await findOr404(db, 'providers', row.provider_id, req.user.practice_id, 'Provider');
    if (row.appointment_id) await findOr404(db, 'appointments', row.appointment_id, req.user.practice_id, 'Appointment');
    if (row.treatment_plan_id) await findOr404(db, 'treatment_plans', row.treatment_plan_id, req.user.practice_id, 'Treatment plan');
    if (row.fee != null) row.fee = Math.round(Number(row.fee));
    await update(db, 'procedures', existing.id, req.user.practice_id, row);
    await audit(db, req, 'procedure.update', 'procedures', existing.id);
    res.json(await db.get('SELECT * FROM procedures WHERE id = ?', existing.id));
  });

  r.post('/procedures/:pid/complete', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'procedures', req.params.pid, req.user.practice_id, 'Procedure');
    const providerId = req.body?.provider_id ? (await findOr404(db, 'providers', req.body.provider_id, req.user.practice_id, 'Provider')).id : undefined;
    await completeProcedure(db, req.user, existing, { providerId, appointmentId: req.body?.appointment_id });
    await audit(db, req, 'procedure.complete', 'procedures', existing.id);
    res.json(await db.get('SELECT * FROM procedures WHERE id = ?', existing.id));
  });

  r.post('/procedures/:pid/cancel', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'procedures', req.params.pid, req.user.practice_id, 'Procedure');
    if (existing.status !== 'planned') throw new HttpError(409, 'Only planned procedures can be cancelled; reverse completed work with a ledger adjustment');
    await db.run("UPDATE procedures SET status = 'cancelled' WHERE id = ?", existing.id);
    await audit(db, req, 'procedure.cancel', 'procedures', existing.id);
    res.json({ ok: true });
  });

  // ---- Treatment plans ----
  const planWithDetails = async (plan) => {
    const procedures = await db.all("SELECT * FROM procedures WHERE treatment_plan_id = ? AND status != 'cancelled' ORDER BY priority, id", plan.id);
    const planned = procedures.filter((p) => p.status === 'planned');
    return { ...plan, procedures, estimate: await estimateCoverage(db, await primaryPolicy(db, plan.practice_id, plan.patient_id), planned) };
  };

  r.get('/patients/:id/treatment-plans', requirePermission('clinical:read'), async (req, res) => {
    const patient = await patientOr404(req);
    const plans = await db.all('SELECT * FROM treatment_plans WHERE patient_id = ? AND practice_id = ? ORDER BY created_at DESC, id DESC', patient.id, req.user.practice_id);
    res.json(await mapSeq(plans, planWithDetails));
  });

  r.post('/patients/:id/treatment-plans', requirePermission('clinical:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const row = pick(req.body, ['name', 'notes']);
    requireFields(row, ['name']);
    const id = await db.tx(async () => {
      const planId = await insert(db, 'treatment_plans', { ...row, patient_id: patient.id, practice_id: req.user.practice_id });
      for (const [i, p] of (req.body.procedures || []).entries()) {
        await insert(db, 'procedures', await buildProcedure(req, patient.id, { priority: i + 1, ...p, treatment_plan_id: planId }));
      }
      return planId;
    });
    await audit(db, req, 'treatment_plan.create', 'treatment_plans', id);
    res.status(201).json(await planWithDetails(await db.get('SELECT * FROM treatment_plans WHERE id = ?', id)));
  });

  r.put('/treatment-plans/:tid', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'treatment_plans', req.params.tid, req.user.practice_id, 'Treatment plan');
    const row = pick(req.body, ['name', 'notes', 'status']);
    requireOneOf(row.status, ['proposed', 'accepted', 'rejected', 'completed'], 'status');
    if (row.status === 'accepted' && existing.status !== 'accepted') row.accepted_at = new Date().toISOString();
    await update(db, 'treatment_plans', existing.id, req.user.practice_id, row);
    await audit(db, req, 'treatment_plan.update', 'treatment_plans', existing.id, row.status ? { status: row.status } : undefined);
    res.json(await planWithDetails(await db.get('SELECT * FROM treatment_plans WHERE id = ?', existing.id)));
  });

  // ---- Clinical notes (signed notes are immutable; corrections go in an addendum) ----
  r.get('/patients/:id/notes', requirePermission('clinical:read'), async (req, res) => {
    const patient = await patientOr404(req);
    res.json(await db.all(
      `SELECT n.*, u.name AS author_name, pv.name AS provider_name FROM clinical_notes n
       JOIN users u ON u.id = n.author_id LEFT JOIN providers pv ON pv.id = n.provider_id
       WHERE n.patient_id = ? AND n.practice_id = ? ORDER BY n.created_at DESC, n.id DESC`,
      patient.id, req.user.practice_id,
    ));
  });

  r.post('/patients/:id/notes', requirePermission('clinical:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const row = pick(req.body, ['body', 'appointment_id', 'provider_id']);
    requireFields(row, ['body']);
    if (row.provider_id) await findOr404(db, 'providers', row.provider_id, req.user.practice_id, 'Provider');
    if (row.appointment_id) await findOr404(db, 'appointments', row.appointment_id, req.user.practice_id, 'Appointment');
    const id = await insert(db, 'clinical_notes', { ...row, patient_id: patient.id, practice_id: req.user.practice_id, author_id: req.user.id });
    await audit(db, req, 'note.create', 'clinical_notes', id);
    res.status(201).json(await db.get('SELECT * FROM clinical_notes WHERE id = ?', id));
  });

  r.put('/notes/:nid', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'clinical_notes', req.params.nid, req.user.practice_id, 'Note');
    if (existing.signed) throw new HttpError(409, 'Signed notes cannot be edited; add an addendum instead');
    if (existing.author_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Only the author can edit this note');
    const row = pick(req.body, ['body']);
    requireFields(row, ['body']);
    await update(db, 'clinical_notes', existing.id, req.user.practice_id, row);
    await audit(db, req, 'note.update', 'clinical_notes', existing.id);
    res.json(await db.get('SELECT * FROM clinical_notes WHERE id = ?', existing.id));
  });

  r.post('/notes/:nid/sign', requirePermission('clinical:sign'), async (req, res) => {
    const existing = await findOr404(db, 'clinical_notes', req.params.nid, req.user.practice_id, 'Note');
    if (existing.signed) throw new HttpError(409, 'Note already signed');
    await db.run("UPDATE clinical_notes SET signed = 1, signed_at = datetime('now') WHERE id = ?", existing.id);
    await audit(db, req, 'note.sign', 'clinical_notes', existing.id);
    res.json(await db.get('SELECT * FROM clinical_notes WHERE id = ?', existing.id));
  });

  // ---- Periodontal charting: readings = { "<tooth>": { pd: [6 depths], bop: [6 bools], mobility, recession: [6] } } ----
  r.get('/patients/:id/perio', requirePermission('clinical:read'), async (req, res) => {
    const patient = await patientOr404(req);
    res.json((await db.all('SELECT * FROM perio_exams WHERE patient_id = ? AND practice_id = ? ORDER BY exam_date DESC, id DESC', patient.id, req.user.practice_id))
      .map((e) => ({ ...e, readings: JSON.parse(e.readings) })));
  });

  r.post('/patients/:id/perio', requirePermission('clinical:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const { readings, exam_date, provider_id, notes } = req.body || {};
    if (!readings || typeof readings !== 'object') throw new HttpError(400, 'readings object is required');
    for (const [tooth, v] of Object.entries(readings)) {
      if (!validTooth(tooth)) throw new HttpError(400, `Invalid tooth ${tooth}`);
      if (v.pd && (!Array.isArray(v.pd) || v.pd.length !== 6 || v.pd.some((d) => d != null && (d < 0 || d > 15)))) {
        throw new HttpError(400, `Tooth ${tooth}: pd must be 6 depths between 0 and 15mm`);
      }
    }
    if (provider_id) await findOr404(db, 'providers', provider_id, req.user.practice_id, 'Provider');
    const id = await insert(db, 'perio_exams', {
      practice_id: req.user.practice_id, patient_id: patient.id, provider_id: provider_id ?? null,
      exam_date: exam_date || new Date().toISOString().slice(0, 10), readings: JSON.stringify(readings), notes: notes ?? null,
    });
    await audit(db, req, 'perio.create', 'perio_exams', id);
    const exam = await db.get('SELECT * FROM perio_exams WHERE id = ?', id);
    res.status(201).json({ ...exam, readings: JSON.parse(exam.readings) });
  });

  return r;
}
