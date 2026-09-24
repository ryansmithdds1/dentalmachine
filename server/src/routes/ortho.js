import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, findOr404, audit, practiceNow, isRealDate } from '../util.js';
import { orthoEstimate, runOrthoBilling } from '../ortho.js';
import { addInterval } from '../memberships.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const APPLIANCES = ['brackets', 'clear_brackets', 'aligners', 'lingual', 'appliance', 'other'];

// Patient chart → Ortho: the contract and the adjustment log.
export default function orthoRoutes({ db, payments }) {
  const r = Router();
  const patientOr404 = (req) => findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
  const caseView = async (c) => {
    const visits = await db.all('SELECT v.*, u.name AS by_name FROM ortho_visits v LEFT JOIN users u ON u.id = v.created_by WHERE v.case_id = ? AND v.deleted_at IS NULL ORDER BY v.visit_date DESC, v.id DESC', c.id);
    const billed = (await db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE ortho_case_id = ? AND type = 'charge'", c.id)).n;
    const today = (await practiceNow(db, c.practice_id)).slice(0, 10);
    const elapsed = Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${c.start_date}T12:00:00Z`)) / (30.44 * 86400_000)));
    return { ...c, autopay: !!c.autopay, visits, billed, left_to_bill: c.total_fee - c.insurance_estimate - billed, months_elapsed: elapsed };
  };

  r.get('/patients/:id/ortho', requirePermission('clinical:read'), async (req, res) => {
    const p = await patientOr404(req);
    const cases = await db.all('SELECT * FROM ortho_cases WHERE patient_id = ? ORDER BY id DESC', p.id);
    const out = [];
    for (const c of cases) out.push(await caseView(c));
    res.json({ cases: out, appliances: APPLIANCES });
  });

  const terms = (b) => {
    const total = Math.round(Number(b.total_fee));
    const months = Math.round(Number(b.months));
    if (!Number.isFinite(total) || total <= 0 || total > 1_000_000_000) throw new HttpError(400, 'Enter the treatment fee');
    if (!Number.isInteger(months) || months < 1 || months > 60) throw new HttpError(400, 'Monthly payments: 1 to 60 months');
    const down = Math.round(Number(b.down_payment) || 0);
    if (down < 0 || down > total) throw new HttpError(400, 'The down payment can’t be more than the fee');
    return { total_fee: total, months, down_payment: down };
  };
  r.post('/patients/:id/ortho/estimate', requirePermission('clinical:read'), async (req, res) => {
    const p = await patientOr404(req);
    res.json(await orthoEstimate(db, req.user.practice_id, p, terms(req.body || {})));
  });

  // Start treatment: the contract is set, the down payment is charged now, and months follow from the start date.
  r.post('/patients/:id/ortho', requirePermission('billing:write'), async (req, res) => {
    const p = await patientOr404(req);
    const b = req.body || {};
    const t = terms(b);
    const est = await orthoEstimate(db, req.user.practice_id, p, t);
    if (b.insurance_estimate != null && !Number.isFinite(Number(b.insurance_estimate))) throw new HttpError(400, 'insurance_estimate must be a number');
    if (b.est_months != null && b.est_months !== '' && !(Number.isInteger(Number(b.est_months)) && Number(b.est_months) >= 1 && Number(b.est_months) <= 120)) throw new HttpError(400, 'est_months must be 1-120');
    const insurance = b.insurance_estimate != null ? Math.max(0, Math.min(t.total_fee, Math.round(Number(b.insurance_estimate)))) : est.insurance_estimate;
    const financed = Math.max(0, t.total_fee - insurance - t.down_payment);
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const start = b.start_date || today;
    if (!DATE.test(start) || !isRealDate(start)) throw new HttpError(400, 'start_date must be a real date (YYYY-MM-DD)');
    if (b.provider_id) await findOr404(db, 'providers', b.provider_id, req.user.practice_id, 'Provider');
    const appliance = APPLIANCES.includes(b.appliance) ? b.appliance : 'brackets';
    let methodId = null;
    if (b.payment_method_id) {
      const m = await db.get('SELECT id FROM payment_methods WHERE id = ? AND practice_id = ? AND patient_id = ? AND removed_at IS NULL', Number(b.payment_method_id), req.user.practice_id, p.guarantor_id || p.id);
      if (!m) throw new HttpError(404, 'Card not found on this account');
      methodId = m.id;
    }
    if (await db.get("SELECT id FROM ortho_cases WHERE patient_id = ? AND status = 'active'", p.id)) throw new HttpError(409, 'This patient already has active ortho treatment');
    const id = await db.tx(async () => {
      const caseId = await insert(db, 'ortho_cases', {
        practice_id: req.user.practice_id, patient_id: p.id, provider_id: b.provider_id ? Number(b.provider_id) : null, appliance, start_date: start,
        est_months: b.est_months ? Math.round(Number(b.est_months)) : t.months, ...t, insurance_estimate: insurance, monthly_amount: Math.floor(financed / t.months),
        next_bill_date: addInterval(start, 'month'), payment_method_id: methodId, autopay: methodId && b.autopay !== false ? 1 : 0, notes: b.notes ? String(b.notes).slice(0, 1000) : null, created_by: req.user.id,
      });
      if (t.down_payment > 0) {
        await insert(db, 'ledger_entries', {
          practice_id: req.user.practice_id, patient_id: p.id, type: 'charge', amount: t.down_payment, provider_id: b.provider_id ? Number(b.provider_id) : null,
          description: 'Orthodontic treatment — down payment', reference: `ortho:${caseId}:0`, entry_date: today, ortho_case_id: caseId, created_by: req.user.id,
        });
      }
      return caseId;
    });
    await audit(db, req, 'ortho.start', 'ortho_cases', id, { total: t.total_fee, months: t.months });
    await runOrthoBilling(db, payments, { caseId: id }); // a start date in the past bills what's due
    res.status(201).json(await caseView(await db.get('SELECT * FROM ortho_cases WHERE id = ?', id)));
  });

  r.put('/ortho/:cid', requirePermission('clinical:write'), async (req, res) => {
    const c = await findOr404(db, 'ortho_cases', req.params.cid, req.user.practice_id, 'Ortho case');
    const b = req.body || {};
    const row = {};
    if (b.status !== undefined) {
      if (!['active', 'retention', 'completed', 'cancelled'].includes(b.status)) throw new HttpError(400, 'Unknown status');
      row.status = b.status;
    }
    if (b.debond_date !== undefined) {
      if (b.debond_date && !DATE.test(b.debond_date)) throw new HttpError(400, 'debond_date must be YYYY-MM-DD');
      row.debond_date = b.debond_date || null;
    }
    if (b.est_months !== undefined) row.est_months = Math.max(1, Math.round(Number(b.est_months) || 1));
    if (b.notes !== undefined) row.notes = String(b.notes || '').slice(0, 1000) || null;
    if (b.appliance !== undefined && APPLIANCES.includes(b.appliance)) row.appliance = b.appliance;
    if (b.autopay !== undefined) row.autopay = b.autopay && c.payment_method_id ? 1 : 0;
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    await db.run(`UPDATE ortho_cases SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), c.id);
    await audit(db, req, 'ortho.update', 'ortho_cases', c.id, row);
    res.json(await caseView(await db.get('SELECT * FROM ortho_cases WHERE id = ?', c.id)));
  });

  // The adjustment log: wires, elastics, aligner number, notes, when to come back.
  r.post('/ortho/:cid/visits', requirePermission('clinical:write'), async (req, res) => {
    const c = await findOr404(db, 'ortho_cases', req.params.cid, req.user.practice_id, 'Ortho case');
    const b = req.body || {};
    const date = b.visit_date || (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    if (!DATE.test(date) || !isRealDate(date)) throw new HttpError(400, 'visit_date must be a real date (YYYY-MM-DD)');
    if (b.next_weeks != null && b.next_weeks !== '' && !(Number.isInteger(Number(b.next_weeks)) && Number(b.next_weeks) >= 1 && Number(b.next_weeks) <= 52)) throw new HttpError(400, 'next_weeks must be 1-52');
    const clip = (v) => (v ? String(v).trim().slice(0, 120) || null : null);
    const row = { upper_wire: clip(b.upper_wire), lower_wire: clip(b.lower_wire), elastics: clip(b.elastics), aligner: clip(b.aligner), notes: b.notes ? String(b.notes).slice(0, 2000) : null };
    if (!Object.values(row).some(Boolean)) throw new HttpError(400, 'Record what was done');
    const id = await insert(db, 'ortho_visits', { practice_id: req.user.practice_id, case_id: c.id, visit_date: date, ...row, next_weeks: b.next_weeks ? Math.round(Number(b.next_weeks)) : null, created_by: req.user.id });
    res.status(201).json(await db.get('SELECT * FROM ortho_visits WHERE id = ?', id));
  });
  r.delete('/ortho/visits/:vid', requirePermission('clinical:write'), async (req, res) => {
    const v = await findOr404(db, 'ortho_visits', req.params.vid, req.user.practice_id, 'Visit');
    if (v.deleted_at) throw new HttpError(409, 'This visit entry was already removed');
    await db.run("UPDATE ortho_visits SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?", req.user.id, v.id);
    await audit(db, req, 'ortho.visit_remove', 'ortho_visits', v.id, { case_id: v.case_id }, { reason: req.body?.reason || null });
    res.json({ ok: true });
  });
  return r;
}
