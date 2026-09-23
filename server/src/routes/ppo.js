import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, toCents, practiceNow, mapSeq, publicPractice } from '../util.js';
import { estimateCoverage } from '../services.js';
import { build837D } from '../x12.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));

// PPO fee schedules (contracted allowed amounts) and insurance pre-authorizations/predeterminations.
export default function ppoRoutes({ db, config }) {
  const r = Router();

  // ---- Fee schedules ----
  const withItems = async (fs) => ({
    ...fs,
    items: await db.all('SELECT code, fee FROM fee_schedule_items WHERE fee_schedule_id = ? ORDER BY code', fs.id),
    carriers: await db.all('SELECT id, name FROM insurance_carriers WHERE fee_schedule_id = ?', fs.id)
  });

  r.get('/fee-schedules', requirePermission('billing:read'), async (req, res) => {
    res.json(await mapSeq((await db.all('SELECT * FROM fee_schedules WHERE practice_id = ? ORDER BY name', req.user.practice_id)), withItems));
  });

  r.post('/fee-schedules', requireAdmin, async (req, res) => {
    const row = pick(req.body, ['name', 'notes']);
    requireFields(row, ['name']);
    const id = await insert(db, 'fee_schedules', { ...row, practice_id: req.user.practice_id });
    // Optionally start from a percentage of the office (UCR) fees — how most PPO schedules are negotiated.
    const pct = Number(req.body.percent_of_ucr);
    if (pct > 0 && pct <= 100) {
      for (const c of await db.all('SELECT code, fee FROM procedure_codes WHERE practice_id = ? AND active = 1', req.user.practice_id)) {
        await db.run('INSERT INTO fee_schedule_items (fee_schedule_id, code, fee) VALUES (?, ?, ?)', id, c.code, Math.round((c.fee * pct) / 100));
      }
    }
    await audit(db, req, 'fee_schedule.create', 'fee_schedules', id);
    res.status(201).json(await withItems(await db.get('SELECT * FROM fee_schedules WHERE id = ?', id)));
  });

  r.put('/fee-schedules/:fid', requireAdmin, async (req, res) => {
    const fs = await findOr404(db, 'fee_schedules', req.params.fid, req.user.practice_id, 'Fee schedule');
    await update(db, 'fee_schedules', fs.id, req.user.practice_id, pick(req.body, ['name', 'notes', 'active']));
    if (Array.isArray(req.body.items)) {
      await db.tx(async () => {
        for (const it of req.body.items) {
          const code = String(it.code || '').toUpperCase();
          if (!/^D\d{4}$/.test(code)) throw new HttpError(400, `Invalid code ${it.code}`);
          if (it.fee === null || it.fee === '') await db.run('DELETE FROM fee_schedule_items WHERE fee_schedule_id = ? AND code = ?', fs.id, code);
          else await db.run('INSERT INTO fee_schedule_items (fee_schedule_id, code, fee) VALUES (?, ?, ?) ON CONFLICT(fee_schedule_id, code) DO UPDATE SET fee = excluded.fee', fs.id, code, toCents(it.fee, 'fee'));
        }
      });
    }
    if (Array.isArray(req.body.carrier_ids)) {
      await db.tx(async () => {
        await db.run('UPDATE insurance_carriers SET fee_schedule_id = NULL WHERE fee_schedule_id = ? AND practice_id = ?', fs.id, req.user.practice_id);
        for (const cid of req.body.carrier_ids) {
          await findOr404(db, 'insurance_carriers', cid, req.user.practice_id, 'Carrier');
          await db.run('UPDATE insurance_carriers SET fee_schedule_id = ? WHERE id = ?', fs.id, Number(cid));
        }
      });
    }
    await audit(db, req, 'fee_schedule.update', 'fee_schedules', fs.id);
    res.json(await withItems(await db.get('SELECT * FROM fee_schedules WHERE id = ?', fs.id)));
  });

  // ---- Pre-authorizations (predeterminations) ----
  const PRE_SELECT = `SELECT pa.*, p.first_name, p.last_name, c.name AS carrier_name, tp.name AS plan_name
    FROM preauths pa JOIN patients p ON p.id = pa.patient_id JOIN patient_insurance pi ON pi.id = pa.patient_insurance_id
    JOIN insurance_carriers c ON c.id = pi.carrier_id LEFT JOIN treatment_plans tp ON tp.id = pa.treatment_plan_id`;
  const view = async (row) => row && ({ ...row, procedure_ids: JSON.parse(row.procedure_ids), procedures: await db.all(`SELECT id, code, description, tooth, surfaces, fee FROM procedures WHERE id IN (${JSON.parse(row.procedure_ids).map(Number).join(',') || 0})`) });

  r.get('/preauths', requirePermission('billing:read'), async (req, res) => {
    const where = ['pa.practice_id = ?'];
    const params = [req.user.practice_id];
    if (req.query.patient_id) {
      where.push('pa.patient_id = ?');
      params.push(Number(req.query.patient_id));
    }
    if (req.query.status) {
      where.push('pa.status = ?');
      params.push(req.query.status);
    }
    res.json(await mapSeq((await db.all(`${PRE_SELECT} WHERE ${where.join(' AND ')} ORDER BY pa.id DESC`, ...params)), view));
  });

  r.post('/preauths', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const policy = await findOr404(db, 'patient_insurance', req.body?.patient_insurance_id, pid, 'Policy');
    let procs;
    let planId = null;
    if (req.body?.treatment_plan_id) {
      const plan = await findOr404(db, 'treatment_plans', req.body.treatment_plan_id, pid, 'Treatment plan');
      if (plan.patient_id !== policy.patient_id) throw new HttpError(400, 'Plan belongs to another patient');
      planId = plan.id;
      procs = await db.all("SELECT * FROM procedures WHERE treatment_plan_id = ? AND status = 'planned'", plan.id);
    } else {
      procs = await mapSeq((req.body?.procedure_ids || []), async (id) => await findOr404(db, 'procedures', id, pid, 'Procedure'));
    }
    if (!procs.length) throw new HttpError(400, 'No planned procedures to send');
    if (procs.some((p) => p.patient_id !== policy.patient_id)) throw new HttpError(400, 'Procedures belong to another patient');
    const est = await estimateCoverage(db, policy, procs);
    const id = await insert(db, 'preauths', {
      practice_id: pid, patient_id: policy.patient_id, patient_insurance_id: policy.id, treatment_plan_id: planId,
      procedure_ids: JSON.stringify(procs.map((p) => p.id)), total_fee: est.total_fee, estimated_amount: est.total_insurance, created_by: req.user.id,
    });
    await audit(db, req, 'preauth.create', 'preauths', id);
    res.status(201).json(await view(await db.get(`${PRE_SELECT} WHERE pa.id = ?`, id)));
  });

  r.put('/preauths/:aid', requirePermission('billing:write'), async (req, res) => {
    const pa = await findOr404(db, 'preauths', req.params.aid, req.user.practice_id, 'Pre-authorization');
    const row = pick(req.body, ['status', 'approved_amount', 'payer_reference', 'notes', 'expires_at']);
    requireOneOf(row.status, ['draft', 'submitted', 'approved', 'denied'], 'status');
    // Status only moves forward: draft → submitted → approved/denied (a denial can be resubmitted).
    const allowed = { draft: ['draft', 'submitted'], submitted: ['submitted', 'approved', 'denied'], approved: ['approved'], denied: ['denied', 'submitted'] };
    if (row.status && !allowed[pa.status]?.includes(row.status)) throw new HttpError(409, `A ${pa.status} pre-authorization can't go back to ${row.status}`);
    if (row.expires_at && !/^\d{4}-\d{2}-\d{2}$/.test(row.expires_at)) throw new HttpError(400, 'expires_at must be YYYY-MM-DD');
    if (row.approved_amount != null) row.approved_amount = toCents(row.approved_amount, 'approved_amount');
    if (row.status === 'submitted' && pa.status !== 'submitted') row.submitted_at = new Date().toISOString();
    if (['approved', 'denied'].includes(row.status)) row.responded_at = new Date().toISOString();
    await update(db, 'preauths', pa.id, req.user.practice_id, row);
    await audit(db, req, 'preauth.update', 'preauths', pa.id, row.status ? { status: row.status } : undefined);
    res.json(await view(await db.get(`${PRE_SELECT} WHERE pa.id = ?`, pa.id)));
  });

  // Predetermination as an 837D (CLM19 = PB, no service dates).
  r.post('/preauths/:aid/837', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const pa = await findOr404(db, 'preauths', req.params.aid, pid, 'Pre-authorization');
    const practice = publicPractice(await db.get('SELECT * FROM practices WHERE id = ?', pid));
    const policy = await db.get('SELECT * FROM patient_insurance WHERE id = ?', pa.patient_insurance_id);
    const items = await db.all(
      `SELECT pr.fee, pr.code, pr.tooth, pr.surfaces, NULL AS completed_at, pv.name AS provider_name, pv.npi AS provider_npi
       FROM procedures pr LEFT JOIN providers pv ON pv.id = pr.provider_id WHERE pr.id IN (${JSON.parse(pa.procedure_ids).map(Number).join(',')})`,
    );
    const file = build837D({
      practice, taxonomy: practice.billing_provider_taxonomy, control: (Date.now() % 1e9) || 1,
      senderId: config.ediSubmitterId || String(practice.tax_id || '').replace(/\D/g, '') || `DM${practice.id}`, receiverId: config.ediReceiverId || 'CLEARINGHOUSE',
      claims: [{
        claim: { control_number: `PD${pa.id}`, total_fee: pa.total_fee, predetermination: true },
        policy, patient: await db.get('SELECT * FROM patients WHERE id = ?', pa.patient_id), carrier: await db.get('SELECT * FROM insurance_carriers WHERE id = ?', policy.carrier_id), items,
      }],
    });
    if (pa.status === 'draft') await db.run("UPDATE preauths SET status = 'submitted', submitted_at = ? WHERE id = ?", new Date().toISOString(), pa.id);
    await audit(db, req, 'preauth.export_837', 'preauths', pa.id);
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="predetermination-${pa.id}.837"` }).send(file);
  });

  // Insurance follow-up: submitted claims by age.
  r.get('/reports/outstanding-claims', requirePermission('billing:read'), async (req, res) => {
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const rows = await db.all(
      `SELECT c.id, c.patient_id, c.status, c.total_fee, c.estimated_amount, c.paid_amount, c.submitted_at, c.control_number,
         p.first_name, p.last_name, ic.name AS carrier_name, ic.phone AS carrier_phone,
         (SELECT MAX(created_at) FROM followups f WHERE f.practice_id = c.practice_id AND f.kind = 'claim' AND f.note LIKE '%#' || c.id || '%') AS last_followup
       FROM claims c JOIN patients p ON p.id = c.patient_id JOIN patient_insurance pi ON pi.id = c.patient_insurance_id JOIN insurance_carriers ic ON ic.id = pi.carrier_id
       WHERE c.practice_id = ? AND c.status IN ('submitted','partially_paid') ORDER BY c.submitted_at`, req.user.practice_id,
    );
    for (const c of rows) c.days_out = c.submitted_at ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${c.submitted_at.slice(0, 10)}T00:00:00Z`)) / 86400_000) : null;
    const bucket = (d) => (d <= 30 ? 'd0_30' : d <= 60 ? 'd31_60' : d <= 90 ? 'd61_90' : 'd90_plus');
    const totals = { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
    for (const r2 of rows) totals[bucket(r2.days_out ?? 0)] += r2.estimated_amount - r2.paid_amount;
    res.json({ as_of: today, totals, rows });
  });

  return r;
}
