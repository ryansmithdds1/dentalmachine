import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import {
  pick, requireFields, requireOneOf, insert, update, findOr404, audit, validTooth, normalizeSurfaces, mapSeq, codeArea, QUADRANTS, ARCHES, practiceNow } from '../util.js';
import { completeProcedure, estimateCoverage, primaryPolicy, voidLedgerEntry } from '../services.js';
import { signedVersion } from './casepres.js';
import { memberSavings } from '../memberships.js';
import { officeFee } from '../fees.js';

export const CONDITIONS = [
  'caries', 'missing', 'filling', 'crown', 'root_canal', 'implant', 'bridge_pontic', 'fracture',
  'sealant', 'veneer', 'impacted', 'watch', 'abscess', 'mobility',
];

function normalizeToothFields(row) {
  if (row.tooth != null) {
    row.tooth = String(row.tooth).toUpperCase();
    if (!validTooth(row.tooth)) throw new HttpError(400, 'tooth must be 1-32, A-T, or a supernumerary tooth (51-82, AS-TS)');
  }
  if (row.area != null) row.area = String(row.area).toUpperCase() || null;
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
    const conditions = await db.all('SELECT * FROM tooth_conditions WHERE patient_id = ? AND practice_id = ? ORDER BY recorded_at DESC', patient.id, req.user.practice_id);
    const procedures = await db.all(
      `SELECT pr.*, pv.name AS provider_name, tp.name AS plan_name, tp.option_label AS plan_option FROM procedures pr LEFT JOIN providers pv ON pv.id = pr.provider_id
       LEFT JOIN treatment_plans tp ON tp.id = pr.treatment_plan_id
       WHERE pr.patient_id = ? AND pr.practice_id = ? AND pr.status != 'cancelled' ORDER BY COALESCE(pr.completed_at, pr.created_at) DESC`,
      patient.id, req.user.practice_id,
    );
    // The chart as it stood on a past date: what was recorded by then, and work completed by then
    // (planned work isn't dated history, so it's left out).
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of || '') ? `${req.query.as_of} 23:59:59` : null;
    if (!asOf) return res.json({ conditions, procedures });
    const by = (t) => t && t.replace('T', ' ') <= asOf;
    res.json({
      as_of: req.query.as_of,
      conditions: conditions.filter((c) => by(c.recorded_at)).map((c) => (c.resolved && by(c.resolved_at || c.recorded_at) ? c : { ...c, resolved: 0 })),
      procedures: procedures.filter((p) => p.status === 'completed' && by(p.completed_at)),
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
    if (row.resolved != null) {
      row.resolved = row.resolved ? 1 : 0;
      if (row.resolved && !existing.resolved) row.resolved_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
      if (!row.resolved) row.resolved_at = null;
    }
    await update(db, 'tooth_conditions', existing.id, req.user.practice_id, row);
    await audit(db, req, 'condition.update', 'tooth_conditions', existing.id);
    res.json(await db.get('SELECT * FROM tooth_conditions WHERE id = ?', existing.id));
  });

  // ---- Procedures ----
  async function buildProcedure(req, patientId, input) {
    const row = normalizeToothFields(pick(input, ['code_id', 'code', 'tooth', 'surfaces', 'area', 'fee', 'provider_id', 'treatment_plan_id', 'appointment_id', 'priority', 'phase']));
    const pid = req.user.practice_id;
    const code = row.code_id
      ? await findOr404(db, 'procedure_codes', row.code_id, pid, 'Procedure code')
      : await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', pid, String(row.code || '').toUpperCase());
    if (!code) throw new HttpError(400, 'A valid code_id or code is required');
    if (code.requires_tooth && !row.tooth) throw new HttpError(400, `${code.code} requires a tooth`);
    if (code.requires_surface && !row.surfaces) throw new HttpError(400, `${code.code} requires surfaces`);
    checkArea(code, row);
    if (row.provider_id) await findOr404(db, 'providers', row.provider_id, pid, 'Provider');
    if (row.appointment_id) await findOr404(db, 'appointments', row.appointment_id, pid, 'Appointment');
    if (row.treatment_plan_id) {
      const plan = await findOr404(db, 'treatment_plans', row.treatment_plan_id, pid, 'Treatment plan');
      if (plan.patient_id !== patientId) throw new HttpError(400, 'Treatment plan belongs to another patient');
    }
    const fee = row.fee != null ? Math.round(Number(row.fee))
      : await officeFee(db, pid, code, { patientId, providerId: row.provider_id, locationId: req.location_id });
    if (!Number.isFinite(fee) || fee < 0) throw new HttpError(400, 'fee must be a non-negative number of cents');
    return {
      practice_id: pid, patient_id: patientId, code_id: code.id, code: code.code, description: code.description, category: code.category,
      tooth: row.tooth ?? null, surfaces: row.surfaces ?? null, area: row.area ?? null, fee, provider_id: row.provider_id ?? null,
      treatment_plan_id: row.treatment_plan_id ?? null, appointment_id: row.appointment_id ?? null, priority: row.priority ?? 1, phase: checkPhase(row.phase ?? 1),
    };
  }

  // Quadrant codes (scaling and root planing, osseous surgery) need a quadrant; arch codes (dentures) an arch.
  function checkArea(code, row) {
    const kind = codeArea(code);
    if (kind === 'quadrant') {
      if (!QUADRANTS.includes(row.area)) throw new HttpError(400, `${code.code} is charted by quadrant: area must be one of ${QUADRANTS.join(', ')}`);
    } else if (kind === 'arch') {
      if (!ARCHES.includes(row.area)) throw new HttpError(400, `${code.code} is charted by arch: area must be U or L`);
    } else if (row.area) {
      throw new HttpError(400, `${code.code} is not charted by quadrant or arch`);
    }
  }
  const checkPhase = (phase) => {
    const n = Number(phase);
    if (!Number.isInteger(n) || n < 1 || n > 9) throw new HttpError(400, 'phase must be 1-9');
    return n;
  };

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
      if (req.body?.complete) await completeProcedure(db, req.user, await db.get('SELECT * FROM procedures WHERE id = ?', newId), { locationId: req.location_id });
      return newId;
    });
    await audit(db, req, 'procedure.create', 'procedures', id, { code: row.code, complete: !!req.body?.complete });
    res.status(201).json(await db.get('SELECT * FROM procedures WHERE id = ?', id));
  });

  r.put('/procedures/:pid', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'procedures', req.params.pid, req.user.practice_id, 'Procedure');
    if (existing.status !== 'planned') throw new HttpError(409, 'Only planned procedures can be edited');
    const row = normalizeToothFields(pick(req.body, ['tooth', 'surfaces', 'area', 'fee', 'provider_id', 'treatment_plan_id', 'appointment_id', 'priority', 'phase']));
    if ('area' in row) checkArea(await db.get('SELECT * FROM procedure_codes WHERE id = ?', existing.code_id) || { code: existing.code }, row);
    if (row.phase != null) row.phase = checkPhase(row.phase);
    if (row.provider_id) await findOr404(db, 'providers', row.provider_id, req.user.practice_id, 'Provider');
    if (row.appointment_id) await findOr404(db, 'appointments', row.appointment_id, req.user.practice_id, 'Appointment');
    if (row.treatment_plan_id) {
      const plan = await findOr404(db, 'treatment_plans', row.treatment_plan_id, req.user.practice_id, 'Treatment plan');
      if (plan.patient_id !== existing.patient_id) throw new HttpError(400, 'Treatment plan belongs to another patient');
    }
    if (row.fee != null) {
      row.fee = Math.round(Number(row.fee));
      if (!Number.isFinite(row.fee) || row.fee < 0) throw new HttpError(400, 'fee must be a non-negative number of cents');
    }
    await update(db, 'procedures', existing.id, req.user.practice_id, row);
    await audit(db, req, 'procedure.update', 'procedures', existing.id);
    res.json(await db.get('SELECT * FROM procedures WHERE id = ?', existing.id));
  });

  r.post('/procedures/:pid/complete', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'procedures', req.params.pid, req.user.practice_id, 'Procedure');
    const providerId = req.body?.provider_id ? (await findOr404(db, 'providers', req.body.provider_id, req.user.practice_id, 'Provider')).id : undefined;
    await completeProcedure(db, req.user, existing, { providerId, appointmentId: req.body?.appointment_id, locationId: req.location_id });
    await audit(db, req, 'procedure.complete', 'procedures', existing.id);
    res.json(await db.get('SELECT * FROM procedures WHERE id = ?', existing.id));
  });

  // Un-completes a procedure charted in error: its charge is voided (reversed today) and it goes back to planned.
  r.post('/procedures/:pid/uncomplete', requirePermission('billing:write'), async (req, res) => {
    const existing = await findOr404(db, 'procedures', req.params.pid, req.user.practice_id, 'Procedure');
    if (existing.status !== 'completed') throw new HttpError(409, 'Only completed procedures can be un-completed');
    const charge = await db.get("SELECT * FROM ledger_entries WHERE procedure_id = ? AND type = 'charge' AND voided_at IS NULL AND reverses_id IS NULL ORDER BY id DESC LIMIT 1", existing.id);
    if (charge) await voidLedgerEntry(db, charge, { userId: req.user.id, reason: req.body?.reason });
    else await db.run("UPDATE procedures SET status = 'planned', completed_at = NULL WHERE id = ?", existing.id);
    await audit(db, req, 'procedure.uncomplete', 'procedures', existing.id, { reason: req.body?.reason });
    res.json(await db.get('SELECT * FROM procedures WHERE id = ?', existing.id));
  });

  r.post('/procedures/:pid/cancel', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'procedures', req.params.pid, req.user.practice_id, 'Procedure');
    if (existing.status !== 'planned') throw new HttpError(409, 'Only planned procedures can be cancelled; un-complete completed work first');
    await db.run("UPDATE procedures SET status = 'cancelled' WHERE id = ?", existing.id);
    await audit(db, req, 'procedure.cancel', 'procedures', existing.id);
    res.json({ ok: true });
  });

  // ---- Treatment plans ----
  const planWithDetails = async (plan) => {
    const procedures = await db.all("SELECT * FROM procedures WHERE treatment_plan_id = ? AND status != 'cancelled' ORDER BY phase, priority, id", plan.id);
    const planned = procedures.filter((p) => p.status === 'planned');
    const estimate = await estimateCoverage(db, await primaryPolicy(db, plan.practice_id, plan.patient_id), planned);
    // Membership benefits, or else the plan discount, come off the patient's share of each procedure
    // (posted as adjustments when the work is done).
    const today = (await practiceNow(db, plan.practice_id)).slice(0, 10);
    const membership = await memberSavings(db, plan.patient_id, (estimate.items || []).map((i) => ({ ...i, code: planned.find((p) => p.id === i.procedure_id)?.code })), today);
    const discount = (estimate.items || []).reduce((s, i) => {
      const member = membership?.items.find((x) => x.procedure_id === i.procedure_id)?.off || 0;
      return s + (member || (plan.discount_pct ? Math.round((i.patient * plan.discount_pct) / 100) : 0));
    }, 0);
    const phases = [...new Set(procedures.map((p) => p.phase || 1))].map((phase) => {
      const list = procedures.filter((p) => (p.phase || 1) === phase);
      const items = estimate.items?.filter((i) => list.some((p) => p.id === i.procedure_id)) || [];
      return {
        phase, count: list.length, planned: list.filter((p) => p.status === 'planned').length,
        fee: list.filter((p) => p.status === 'planned').reduce((s, p) => s + p.fee, 0),
        insurance: items.reduce((s, i) => s + (i.insurance || 0), 0),
      };
    });
    return {
      ...plan, sign_token_hash: undefined, signed_snapshot: undefined, procedures, phases,
      estimate: { ...estimate, discount, membership, patient_after_discount: Math.max(0, (estimate.total_patient ?? 0) - discount) },
      signed_version: signedVersion(plan, procedures),
    };
  };
  const planOr404 = async (req) => await findOr404(db, 'treatment_plans', req.params.tid, req.user.practice_id, 'Treatment plan');
  const editablePlan = async (req) => {
    const plan = await planOr404(req);
    if (['completed', 'rejected'].includes(plan.status)) throw new HttpError(409, `This plan is ${plan.status}; reopen it or start a new one`);
    return plan;
  };

  r.get('/patients/:id/treatment-plans', requirePermission('clinical:read'), async (req, res) => {
    const patient = await patientOr404(req);
    const plans = await db.all('SELECT * FROM treatment_plans WHERE patient_id = ? AND practice_id = ? ORDER BY created_at DESC, id DESC', patient.id, req.user.practice_id);
    res.json(await mapSeq(plans, planWithDetails));
  });

  r.post('/patients/:id/treatment-plans', requirePermission('clinical:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const row = pick(req.body, ['name', 'notes', 'discount_pct']);
    requireFields(row, ['name']);
    if (row.discount_pct != null) row.discount_pct = checkDiscount(row.discount_pct);
    const id = await db.tx(async () => {
      const planId = await insert(db, 'treatment_plans', { ...row, patient_id: patient.id, practice_id: req.user.practice_id });
      for (const [i, p] of (req.body.procedures || []).entries()) {
        await insert(db, 'procedures', await buildProcedure(req, patient.id, { priority: i + 1, ...p, treatment_plan_id: planId }));
      }
      // Existing planned procedures (e.g. charted on the odontogram) can be gathered into the new plan.
      await attachProcedures(req, planId, patient.id, req.body.procedure_ids);
      return planId;
    });
    await audit(db, req, 'treatment_plan.create', 'treatment_plans', id);
    res.status(201).json(await planWithDetails(await db.get('SELECT * FROM treatment_plans WHERE id = ?', id)));
  });

  r.put('/treatment-plans/:tid', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'treatment_plans', req.params.tid, req.user.practice_id, 'Treatment plan');
    const row = pick(req.body, ['name', 'notes', 'status', 'discount_pct', 'option_label']);
    requireOneOf(row.status, ['proposed', 'accepted', 'rejected', 'completed'], 'status');
    if (row.discount_pct != null) row.discount_pct = checkDiscount(row.discount_pct);
    if (row.status === 'accepted' && existing.status !== 'accepted') row.accepted_at = new Date().toISOString();
    await db.tx(async () => {
      await update(db, 'treatment_plans', existing.id, req.user.practice_id, row);
      // Accepting one option turns down the others, and their unstarted work comes off the chart.
      if (row.status === 'accepted' && existing.option_group) {
        const others = await db.all("SELECT id FROM treatment_plans WHERE practice_id = ? AND option_group = ? AND id != ? AND status = 'proposed'", req.user.practice_id, existing.option_group, existing.id);
        for (const o of others) {
          await db.run("UPDATE treatment_plans SET status = 'rejected' WHERE id = ?", o.id);
          await db.run("UPDATE procedures SET status = 'cancelled' WHERE treatment_plan_id = ? AND status = 'planned'", o.id);
        }
      }
    });
    await audit(db, req, 'treatment_plan.update', 'treatment_plans', existing.id, row.status ? { status: row.status } : undefined);
    res.json(await planWithDetails(await db.get('SELECT * FROM treatment_plans WHERE id = ?', existing.id)));
  });

  const checkDiscount = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new HttpError(400, 'discount_pct must be 0-100');
    return n;
  };

  async function attachProcedures(req, planId, patientId, ids) {
    if (!Array.isArray(ids) || !ids.length) return;
    const top = (await db.get('SELECT MAX(priority) AS m FROM procedures WHERE treatment_plan_id = ?', planId)).m || 0;
    for (const [i, raw] of ids.entries()) {
      const p = await findOr404(db, 'procedures', raw, req.user.practice_id, 'Procedure');
      if (p.patient_id !== patientId) throw new HttpError(400, 'Procedure belongs to another patient');
      if (p.status !== 'planned') throw new HttpError(409, `${p.code} is ${p.status}; only planned work can be added to a plan`);
      await db.run('UPDATE procedures SET treatment_plan_id = ?, priority = ? WHERE id = ?', planId, top + i + 1, p.id);
    }
  }

  // Add work to a plan: existing planned procedures by id, and/or new ones.
  r.post('/treatment-plans/:tid/procedures', requirePermission('clinical:write'), async (req, res) => {
    const plan = await editablePlan(req);
    await db.tx(async () => {
      await attachProcedures(req, plan.id, plan.patient_id, req.body?.procedure_ids);
      let top = (await db.get('SELECT MAX(priority) AS m FROM procedures WHERE treatment_plan_id = ?', plan.id)).m || 0;
      for (const p of req.body?.procedures || []) {
        await insert(db, 'procedures', await buildProcedure(req, plan.patient_id, { ...p, priority: ++top, treatment_plan_id: plan.id }));
      }
    });
    await audit(db, req, 'treatment_plan.add', 'treatment_plans', plan.id);
    res.json(await planWithDetails(await db.get('SELECT * FROM treatment_plans WHERE id = ?', plan.id)));
  });

  // Take a procedure off the plan: it stays on the chart as unplanned work, or is cancelled with ?cancel=1.
  r.delete('/treatment-plans/:tid/procedures/:pid', requirePermission('clinical:write'), async (req, res) => {
    const plan = await editablePlan(req);
    const p = await findOr404(db, 'procedures', req.params.pid, req.user.practice_id, 'Procedure');
    if (p.treatment_plan_id !== plan.id) throw new HttpError(404, 'That procedure is not on this plan');
    if (p.status !== 'planned') throw new HttpError(409, 'Completed work stays on the plan');
    if (req.query.cancel) await db.run("UPDATE procedures SET status = 'cancelled' WHERE id = ?", p.id);
    else await db.run('UPDATE procedures SET treatment_plan_id = NULL WHERE id = ?', p.id);
    await audit(db, req, 'treatment_plan.remove', 'treatment_plans', plan.id, { procedure_id: p.id, cancelled: !!req.query.cancel });
    res.json(await planWithDetails(await db.get('SELECT * FROM treatment_plans WHERE id = ?', plan.id)));
  });

  // Reorder and phase: items = [{ id, phase }] in the order they should be done.
  r.put('/treatment-plans/:tid/order', requirePermission('clinical:write'), async (req, res) => {
    const plan = await editablePlan(req);
    const items = req.body?.items;
    if (!Array.isArray(items)) throw new HttpError(400, 'items must be a list of { id, phase }');
    const onPlan = new Set((await db.all('SELECT id FROM procedures WHERE treatment_plan_id = ?', plan.id)).map((p) => p.id));
    await db.tx(async () => {
      for (const [i, it] of items.entries()) {
        if (!onPlan.has(Number(it.id))) throw new HttpError(400, `Procedure ${it.id} is not on this plan`);
        await db.run('UPDATE procedures SET priority = ?, phase = ? WHERE id = ?', i + 1, checkPhase(it.phase ?? 1), Number(it.id));
      }
    });
    res.json(await planWithDetails(await db.get('SELECT * FROM treatment_plans WHERE id = ?', plan.id)));
  });

  // An alternative option: a copy of the plan's unstarted work the patient can choose instead
  // (e.g. "Option B: implant" beside "Option A: bridge"). Accepting one option turns down the rest.
  r.post('/treatment-plans/:tid/duplicate', requirePermission('clinical:write'), async (req, res) => {
    const plan = await planOr404(req);
    if (plan.status !== 'proposed') throw new HttpError(409, 'Alternatives can only be made from a proposed plan');
    const group = plan.option_group || `plan-${plan.id}`;
    const siblings = (await db.get('SELECT COUNT(*) AS n FROM treatment_plans WHERE practice_id = ? AND option_group = ?', plan.practice_id, group)).n;
    const letter = String.fromCharCode(65 + Math.max(siblings, 1));
    const id = await db.tx(async () => {
      if (!plan.option_group) await db.run("UPDATE treatment_plans SET option_group = ?, option_label = COALESCE(option_label, 'Option A') WHERE id = ?", group, plan.id);
      const newId = await insert(db, 'treatment_plans', {
        practice_id: plan.practice_id, patient_id: plan.patient_id, name: String(req.body?.name || plan.name), notes: plan.notes,
        discount_pct: plan.discount_pct, option_group: group, option_label: String(req.body?.option_label || `Option ${letter}`),
      });
      const cols = ['practice_id', 'patient_id', 'code_id', 'code', 'description', 'category', 'tooth', 'surfaces', 'area', 'fee', 'provider_id', 'priority', 'phase'];
      for (const p of await db.all("SELECT * FROM procedures WHERE treatment_plan_id = ? AND status = 'planned' ORDER BY priority, id", plan.id)) {
        await insert(db, 'procedures', { ...Object.fromEntries(cols.map((c) => [c, p[c]])), treatment_plan_id: newId });
      }
      return newId;
    });
    await audit(db, req, 'treatment_plan.alternative', 'treatment_plans', id, { from: plan.id });
    res.status(201).json(await planWithDetails(await db.get('SELECT * FROM treatment_plans WHERE id = ?', id)));
  });

  // ---- Clinical notes (signed notes are immutable; corrections go in an addendum) ----
  r.get('/patients/:id/notes', requirePermission('clinical:read'), async (req, res) => {
    const patient = await patientOr404(req);
    // The signer's provider record gives their credentials and license for the signature line.
    const notes = await db.all(
      `SELECT n.*, u.name AS author_name, pv.name AS provider_name, s.name AS signed_by_name,
         sp.name AS signer_provider_name, sp.license_number AS signer_license, sp.npi AS signer_npi,
         a.start_time AS visit_start, COALESCE(t.name, a.reason) AS visit_reason
       FROM clinical_notes n
       JOIN users u ON u.id = n.author_id LEFT JOIN providers pv ON pv.id = n.provider_id LEFT JOIN users s ON s.id = n.signed_by
       LEFT JOIN providers sp ON sp.id = COALESCE((SELECT MIN(x.id) FROM providers x WHERE x.user_id = n.signed_by AND x.practice_id = n.practice_id), CASE WHEN n.signed_by IS NULL THEN n.provider_id END)
       LEFT JOIN appointments a ON a.id = n.appointment_id LEFT JOIN appointment_types t ON t.id = a.appointment_type_id
       WHERE n.patient_id = ? AND n.practice_id = ? ORDER BY n.created_at DESC, n.id DESC`,
      patient.id, req.user.practice_id,
    );
    for (const n of notes) {
      n.signature = n.signed ? `Electronically signed by ${n.signer_provider_name || n.signed_by_name || 'staff'}${n.signer_license ? ` · License ${n.signer_license}` : ''}${n.signer_npi ? ` · NPI ${n.signer_npi}` : ''}` : null;
    }
    // Addenda are shown under the note they amend, oldest first.
    let top = notes.filter((n) => !n.addendum_of);
    for (const n of top) n.addenda = notes.filter((a) => a.addendum_of === n.id).reverse();
    // Filters: words in the note (or its addenda), provider, visit, dates, unsigned only.
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) top = top.filter((n) => q.split(/\s+/).every((w) => [n.body, ...n.addenda.map((a) => a.body)].join(' ').toLowerCase().includes(w)));
    if (req.query.provider_id) top = top.filter((n) => n.provider_id === Number(req.query.provider_id));
    if (req.query.appointment_id) top = top.filter((n) => n.appointment_id === Number(req.query.appointment_id));
    if (req.query.from) top = top.filter((n) => n.created_at.slice(0, 10) >= req.query.from);
    if (req.query.to) top = top.filter((n) => n.created_at.slice(0, 10) <= req.query.to);
    if (req.query.unsigned === '1') top = top.filter((n) => !n.signed || n.addenda.some((a) => !a.signed));
    res.json(top);
  });

  // Signed notes never change; a correction or late entry is an addendum, itself signed.
  r.post('/notes/:nid/addenda', requirePermission('clinical:write'), async (req, res) => {
    const note = await findOr404(db, 'clinical_notes', req.params.nid, req.user.practice_id, 'Note');
    if (note.addendum_of) throw new HttpError(400, 'Add the addendum to the original note');
    if (!note.signed) throw new HttpError(409, 'This note is not signed yet — edit it instead');
    const body = String(req.body?.body || '').trim();
    if (!body) throw new HttpError(400, 'body is required');
    const id = await insert(db, 'clinical_notes', {
      practice_id: note.practice_id, patient_id: note.patient_id, appointment_id: note.appointment_id, provider_id: note.provider_id,
      author_id: req.user.id, body: body.slice(0, 20000), addendum_of: note.id,
    });
    await audit(db, req, 'note.addendum', 'clinical_notes', id, { note_id: note.id });
    res.status(201).json(await db.get('SELECT * FROM clinical_notes WHERE id = ?', id));
  });

  r.post('/patients/:id/notes', requirePermission('clinical:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const row = pick(req.body, ['body', 'appointment_id', 'provider_id']);
    requireFields(row, ['body']);
    if (row.provider_id) await findOr404(db, 'providers', row.provider_id, req.user.practice_id, 'Provider');
    if (row.appointment_id && (await findOr404(db, 'appointments', row.appointment_id, req.user.practice_id, 'Appointment')).patient_id !== patient.id) throw new HttpError(400, "That visit is another patient's");
    const id = await insert(db, 'clinical_notes', { ...row, patient_id: patient.id, practice_id: req.user.practice_id, author_id: req.user.id });
    await audit(db, req, 'note.create', 'clinical_notes', id);
    res.status(201).json(await db.get('SELECT * FROM clinical_notes WHERE id = ?', id));
  });

  r.put('/notes/:nid', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'clinical_notes', req.params.nid, req.user.practice_id, 'Note');
    if (existing.signed) throw new HttpError(409, 'Signed notes cannot be edited; add an addendum instead');
    if (existing.author_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Only the author can edit this note');
    const row = pick(req.body, ['body', 'appointment_id']);
    if (row.body !== undefined) requireFields(row, ['body']);
    if (row.appointment_id) {
      const appt = await findOr404(db, 'appointments', row.appointment_id, req.user.practice_id, 'Appointment');
      if (appt.patient_id !== existing.patient_id) throw new HttpError(400, "That visit is another patient's");
    }
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    await update(db, 'clinical_notes', existing.id, req.user.practice_id, row);
    await audit(db, req, 'note.update', 'clinical_notes', existing.id);
    res.json(await db.get('SELECT * FROM clinical_notes WHERE id = ?', existing.id));
  });

  r.post('/notes/:nid/sign', requirePermission('clinical:sign'), async (req, res) => {
    const existing = await findOr404(db, 'clinical_notes', req.params.nid, req.user.practice_id, 'Note');
    if (existing.signed) throw new HttpError(409, 'Note already signed');
    // A note written for a provider is signed by that provider (when they have a login); an assistant
    // or another dentist can't sign it for them.
    const provider = existing.provider_id ? await db.get('SELECT name, user_id FROM providers WHERE id = ?', existing.provider_id) : null;
    if (provider?.user_id && provider.user_id !== req.user.id) throw new HttpError(403, `Only ${provider.name} can sign this note`);
    if (!provider?.user_id && existing.author_id !== req.user.id && req.user.role !== 'admin' && !(await db.get('SELECT 1 AS ok FROM providers WHERE user_id = ? AND practice_id = ?', req.user.id, req.user.practice_id))) {
      throw new HttpError(403, 'Only the author or a provider can sign this note');
    }
    const signed = await db.run("UPDATE clinical_notes SET signed = 1, signed_at = datetime('now'), signed_by = ? WHERE id = ? AND signed = 0", req.user.id, existing.id);
    if (!signed.changes) throw new HttpError(409, 'Note already signed');
    await audit(db, req, 'note.sign', 'clinical_notes', existing.id);
    res.json(await db.get('SELECT * FROM clinical_notes WHERE id = ?', existing.id));
  });

  // ---- Periodontal charting ----
  // readings = { "<tooth>": { pd: [6], gm: [6], bop: [6], sup: [6], plaque: [6], furc: [6], mob } }
  // Sites run DB, B, MB, DL, L, ML. gm is the gingival margin relative to the CEJ (positive = recession),
  // so clinical attachment level = pd + gm. furc is a furcation grade (0-3) at a site, mob a Miller grade (0-3).
  const perioView = (e) => ({ ...e, readings: JSON.parse(e.readings) });
  r.get('/patients/:id/perio', requirePermission('clinical:read'), async (req, res) => {
    const patient = await patientOr404(req);
    res.json((await db.all('SELECT * FROM perio_exams WHERE patient_id = ? AND practice_id = ? ORDER BY exam_date DESC, id DESC', patient.id, req.user.practice_id)).map(perioView));
  });

  const siteList = (tooth, v, key, lo, hi, what) => {
    if (v[key] == null) return;
    if (!Array.isArray(v[key]) || v[key].length !== 6 || v[key].some((d) => d != null && d !== '' && !(Number.isInteger(Number(d)) && Number(d) >= lo && Number(d) <= hi))) {
      throw new HttpError(400, `Tooth ${tooth}: ${key} must be 6 ${what} between ${lo} and ${hi}`);
    }
    v[key] = v[key].map((d) => (d == null || d === '' ? null : Number(d)));
  };
  const flagList = (tooth, v, key) => {
    if (v[key] == null) return;
    if (!Array.isArray(v[key]) || v[key].length !== 6) throw new HttpError(400, `Tooth ${tooth}: ${key} must be 6 true/false values`);
    v[key] = v[key].map(Boolean);
  };
  function validReadings(readings) {
    if (!readings || typeof readings !== 'object' || Array.isArray(readings)) throw new HttpError(400, 'readings object is required');
    const out = {};
    for (const [rawTooth, raw] of Object.entries(readings)) {
      const tooth = String(rawTooth).toUpperCase();
      if (!validTooth(tooth)) throw new HttpError(400, `Invalid tooth ${rawTooth}`);
      const v = pick(raw || {}, ['pd', 'gm', 'bop', 'sup', 'plaque', 'furc', 'mob', 'missing']);
      if ('recession' in (raw || {}) && v.gm == null) v.gm = raw.recession;
      siteList(tooth, v, 'pd', 0, 15, 'depths (mm)');
      siteList(tooth, v, 'gm', -10, 15, 'gingival margin readings (mm)');
      siteList(tooth, v, 'furc', 0, 3, 'furcation grades');
      for (const k of ['bop', 'sup', 'plaque']) flagList(tooth, v, k);
      if (v.mob != null && v.mob !== '') {
        v.mob = Number(v.mob);
        if (!Number.isInteger(v.mob) || v.mob < 0 || v.mob > 3) throw new HttpError(400, `Tooth ${tooth}: mobility must be 0-3`);
      } else delete v.mob;
      if (v.missing) v.missing = true;
      out[tooth] = v;
    }
    return out;
  }

  r.post('/patients/:id/perio', requirePermission('clinical:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const { exam_date, provider_id, notes } = req.body || {};
    const readings = validReadings(req.body?.readings);
    if (exam_date && !/^\d{4}-\d{2}-\d{2}$/.test(exam_date)) throw new HttpError(400, 'exam_date must be YYYY-MM-DD');
    if (provider_id) await findOr404(db, 'providers', provider_id, req.user.practice_id, 'Provider');
    const id = await insert(db, 'perio_exams', {
      practice_id: req.user.practice_id, patient_id: patient.id, provider_id: provider_id ?? null,
      exam_date: exam_date || new Date().toISOString().slice(0, 10), readings: JSON.stringify(readings), notes: notes ?? null,
    });
    await audit(db, req, 'perio.create', 'perio_exams', id);
    res.status(201).json(perioView(await db.get('SELECT * FROM perio_exams WHERE id = ?', id)));
  });

  // Exams stay editable (a hygienist finishing the chart later, or fixing a misread).
  r.put('/perio/:eid', requirePermission('clinical:write'), async (req, res) => {
    const exam = await findOr404(db, 'perio_exams', req.params.eid, req.user.practice_id, 'Perio exam');
    const row = pick(req.body, ['exam_date', 'provider_id', 'notes']);
    if (req.body?.readings) row.readings = JSON.stringify(validReadings(req.body.readings));
    if (row.exam_date && !/^\d{4}-\d{2}-\d{2}$/.test(row.exam_date)) throw new HttpError(400, 'exam_date must be YYYY-MM-DD');
    if (row.provider_id) await findOr404(db, 'providers', row.provider_id, req.user.practice_id, 'Provider');
    await update(db, 'perio_exams', exam.id, req.user.practice_id, row);
    await audit(db, req, 'perio.update', 'perio_exams', exam.id);
    res.json(perioView(await db.get('SELECT * FROM perio_exams WHERE id = ?', exam.id)));
  });

  r.delete('/perio/:eid', requirePermission('clinical:write'), async (req, res) => {
    const exam = await findOr404(db, 'perio_exams', req.params.eid, req.user.practice_id, 'Perio exam');
    await db.run('DELETE FROM perio_exams WHERE id = ?', exam.id);
    await audit(db, req, 'perio.delete', 'perio_exams', exam.id);
    res.json({ ok: true });
  });

  return r;
}
