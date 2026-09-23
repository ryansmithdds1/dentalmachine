import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, toCents, practiceNow } from '../util.js';
import { estimateCoverage } from '../services.js';
import { build837D } from '../x12.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));

// PPO fee schedules (contracted allowed amounts) and insurance pre-authorizations/predeterminations.
export default function ppoRoutes({ db, config }) {
  const r = Router();

  // ---- Fee schedules ----
  const withItems = (fs) => ({
    ...fs,
    items: db.all('SELECT code, fee FROM fee_schedule_items WHERE fee_schedule_id = ? ORDER BY code', fs.id),
    carriers: db.all('SELECT id, name FROM insurance_carriers WHERE fee_schedule_id = ?', fs.id),
  });

  r.get('/fee-schedules', requirePermission('billing:read'), (req, res) => {
    res.json(db.all('SELECT * FROM fee_schedules WHERE practice_id = ? ORDER BY name', req.user.practice_id).map(withItems));
  });

  r.post('/fee-schedules', requireAdmin, (req, res) => {
    const row = pick(req.body, ['name', 'notes']);
    requireFields(row, ['name']);
    const id = insert(db, 'fee_schedules', { ...row, practice_id: req.user.practice_id });
    // Optionally start from a percentage of the office (UCR) fees — how most PPO schedules are negotiated.
    const pct = Number(req.body.percent_of_ucr);
    if (pct > 0 && pct <= 100) {
      for (const c of db.all('SELECT code, fee FROM procedure_codes WHERE practice_id = ? AND active = 1', req.user.practice_id)) {
        db.run('INSERT INTO fee_schedule_items (fee_schedule_id, code, fee) VALUES (?, ?, ?)', id, c.code, Math.round((c.fee * pct) / 100));
      }
    }
    audit(db, req, 'fee_schedule.create', 'fee_schedules', id);
    res.status(201).json(withItems(db.get('SELECT * FROM fee_schedules WHERE id = ?', id)));
  });

  r.put('/fee-schedules/:fid', requireAdmin, (req, res) => {
    const fs = findOr404(db, 'fee_schedules', req.params.fid, req.user.practice_id, 'Fee schedule');
    update(db, 'fee_schedules', fs.id, req.user.practice_id, pick(req.body, ['name', 'notes', 'active']));
    if (Array.isArray(req.body.items)) {
      db.tx(() => {
        for (const it of req.body.items) {
          const code = String(it.code || '').toUpperCase();
          if (!/^D\d{4}$/.test(code)) throw new HttpError(400, `Invalid code ${it.code}`);
          if (it.fee === null || it.fee === '') db.run('DELETE FROM fee_schedule_items WHERE fee_schedule_id = ? AND code = ?', fs.id, code);
          else db.run('INSERT INTO fee_schedule_items (fee_schedule_id, code, fee) VALUES (?, ?, ?) ON CONFLICT(fee_schedule_id, code) DO UPDATE SET fee = excluded.fee', fs.id, code, toCents(it.fee, 'fee'));
        }
      });
    }
    if (Array.isArray(req.body.carrier_ids)) {
      db.tx(() => {
        db.run('UPDATE insurance_carriers SET fee_schedule_id = NULL WHERE fee_schedule_id = ? AND practice_id = ?', fs.id, req.user.practice_id);
        for (const cid of req.body.carrier_ids) {
          findOr404(db, 'insurance_carriers', cid, req.user.practice_id, 'Carrier');
          db.run('UPDATE insurance_carriers SET fee_schedule_id = ? WHERE id = ?', fs.id, Number(cid));
        }
      });
    }
    audit(db, req, 'fee_schedule.update', 'fee_schedules', fs.id);
    res.json(withItems(db.get('SELECT * FROM fee_schedules WHERE id = ?', fs.id)));
  });

  // ---- Pre-authorizations (predeterminations) ----
  const PRE_SELECT = `SELECT pa.*, p.first_name, p.last_name, c.name AS carrier_name, tp.name AS plan_name
    FROM preauths pa JOIN patients p ON p.id = pa.patient_id JOIN patient_insurance pi ON pi.id = pa.patient_insurance_id
    JOIN insurance_carriers c ON c.id = pi.carrier_id LEFT JOIN treatment_plans tp ON tp.id = pa.treatment_plan_id`;
  const view = (row) => row && ({ ...row, procedure_ids: JSON.parse(row.procedure_ids), procedures: db.all(`SELECT id, code, description, tooth, surfaces, fee FROM procedures WHERE id IN (${JSON.parse(row.procedure_ids).map(Number).join(',') || 0})`) });

  r.get('/preauths', requirePermission('billing:read'), (req, res) => {
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
    res.json(db.all(`${PRE_SELECT} WHERE ${where.join(' AND ')} ORDER BY pa.id DESC`, ...params).map(view));
  });

  r.post('/preauths', requirePermission('billing:write'), (req, res) => {
    const pid = req.user.practice_id;
    const policy = findOr404(db, 'patient_insurance', req.body?.patient_insurance_id, pid, 'Policy');
    let procs;
    let planId = null;
    if (req.body?.treatment_plan_id) {
      const plan = findOr404(db, 'treatment_plans', req.body.treatment_plan_id, pid, 'Treatment plan');
      if (plan.patient_id !== policy.patient_id) throw new HttpError(400, 'Plan belongs to another patient');
      planId = plan.id;
      procs = db.all("SELECT * FROM procedures WHERE treatment_plan_id = ? AND status = 'planned'", plan.id);
    } else {
      procs = (req.body?.procedure_ids || []).map((id) => findOr404(db, 'procedures', id, pid, 'Procedure'));
    }
    if (!procs.length) throw new HttpError(400, 'No planned procedures to send');
    if (procs.some((p) => p.patient_id !== policy.patient_id)) throw new HttpError(400, 'Procedures belong to another patient');
    const est = estimateCoverage(db, policy, procs);
    const id = insert(db, 'preauths', {
      practice_id: pid, patient_id: policy.patient_id, patient_insurance_id: policy.id, treatment_plan_id: planId,
      procedure_ids: JSON.stringify(procs.map((p) => p.id)), total_fee: est.total_fee, estimated_amount: est.total_insurance, created_by: req.user.id,
    });
    audit(db, req, 'preauth.create', 'preauths', id);
    res.status(201).json(view(db.get(`${PRE_SELECT} WHERE pa.id = ?`, id)));
  });

  r.put('/preauths/:aid', requirePermission('billing:write'), (req, res) => {
    const pa = findOr404(db, 'preauths', req.params.aid, req.user.practice_id, 'Pre-authorization');
    const row = pick(req.body, ['status', 'approved_amount', 'payer_reference', 'notes']);
    requireOneOf(row.status, ['draft', 'submitted', 'approved', 'denied'], 'status');
    if (row.approved_amount != null) row.approved_amount = toCents(row.approved_amount, 'approved_amount');
    if (row.status === 'submitted' && pa.status !== 'submitted') row.submitted_at = new Date().toISOString();
    if (['approved', 'denied'].includes(row.status)) row.responded_at = new Date().toISOString();
    update(db, 'preauths', pa.id, req.user.practice_id, row);
    audit(db, req, 'preauth.update', 'preauths', pa.id, row.status ? { status: row.status } : undefined);
    res.json(view(db.get(`${PRE_SELECT} WHERE pa.id = ?`, pa.id)));
  });

  // Predetermination as an 837D (CLM19 = PB, no service dates).
  r.post('/preauths/:aid/837', requirePermission('billing:write'), (req, res) => {
    const pid = req.user.practice_id;
    const pa = findOr404(db, 'preauths', req.params.aid, pid, 'Pre-authorization');
    const practice = db.get('SELECT * FROM practices WHERE id = ?', pid);
    const policy = db.get('SELECT * FROM patient_insurance WHERE id = ?', pa.patient_insurance_id);
    const items = db.all(
      `SELECT pr.fee, pr.code, pr.tooth, pr.surfaces, NULL AS completed_at, pv.name AS provider_name, pv.npi AS provider_npi
       FROM procedures pr LEFT JOIN providers pv ON pv.id = pr.provider_id WHERE pr.id IN (${JSON.parse(pa.procedure_ids).map(Number).join(',')})`,
    );
    const file = build837D({
      practice, taxonomy: practice.billing_provider_taxonomy, control: (Date.now() % 1e9) || 1,
      senderId: config.ediSubmitterId || String(practice.tax_id || '').replace(/\D/g, '') || `DM${practice.id}`, receiverId: config.ediReceiverId || 'CLEARINGHOUSE',
      claims: [{
        claim: { control_number: `PD${pa.id}`, total_fee: pa.total_fee, predetermination: true },
        policy, patient: db.get('SELECT * FROM patients WHERE id = ?', pa.patient_id), carrier: db.get('SELECT * FROM insurance_carriers WHERE id = ?', policy.carrier_id), items,
      }],
    });
    if (pa.status === 'draft') db.run("UPDATE preauths SET status = 'submitted', submitted_at = ? WHERE id = ?", new Date().toISOString(), pa.id);
    audit(db, req, 'preauth.export_837', 'preauths', pa.id);
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="predetermination-${pa.id}.837"` }).send(file);
  });

  // Insurance follow-up: submitted claims by age.
  r.get('/reports/outstanding-claims', requirePermission('billing:read'), (req, res) => {
    const today = practiceNow(db, req.user.practice_id).slice(0, 10);
    const rows = db.all(
      `SELECT c.id, c.patient_id, c.status, c.total_fee, c.estimated_amount, c.paid_amount, c.submitted_at, c.control_number,
         p.first_name, p.last_name, ic.name AS carrier_name, ic.phone AS carrier_phone,
         CAST(julianday(?) - julianday(substr(c.submitted_at, 1, 10)) AS INTEGER) AS days_out,
         (SELECT MAX(created_at) FROM followups f WHERE f.practice_id = c.practice_id AND f.kind = 'claim' AND f.note LIKE '%#' || c.id || '%') AS last_followup
       FROM claims c JOIN patients p ON p.id = c.patient_id JOIN patient_insurance pi ON pi.id = c.patient_insurance_id JOIN insurance_carriers ic ON ic.id = pi.carrier_id
       WHERE c.practice_id = ? AND c.status IN ('submitted','partially_paid') ORDER BY c.submitted_at`, today, req.user.practice_id,
    );
    const bucket = (d) => (d <= 30 ? 'd0_30' : d <= 60 ? 'd31_60' : d <= 90 ? 'd61_90' : 'd90_plus');
    const totals = { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
    for (const r2 of rows) totals[bucket(r2.days_out ?? 0)] += r2.estimated_amount - r2.paid_amount;
    res.json({ as_of: today, totals, rows });
  });

  return r;
}
