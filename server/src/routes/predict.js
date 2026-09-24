import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404 } from '../util.js';
import { canSeePatient } from '../officeaccess.js';
import { getPredictor, forScreen } from '../predict/index.js';
import { noShowRisks, noShowAccuracy } from '../predict/noshow.js';
import { procedureDenial, denialAccuracy } from '../predict/denial.js';

// Predictions (docs/predictions.md): no-show risk of a visit, denial risk of planned procedures, and how well the
// predictions have matched what actually happened. Read-only: predictions inform people and never act.
export default function predictRoutes({ db }) {
  const r = Router();

  r.get('/predict/status', requirePermission('reports:read'), (req, res) => {
    res.json({ ...getPredictor().info(), kinds: ['no_show', 'denial'] });
  });

  // One visit's no-show risk (the schedule and the visit panel get it with the day's visits already).
  r.get('/predict/no-show/:id', requirePermission('schedule:read'), async (req, res) => {
    const a = await findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    if (!(await canSeePatient(db, req.user, a.patient_id))) throw new HttpError(404, 'Appointment not found');
    res.json({ appointment_id: a.id, prediction: forScreen((await noShowRisks(db, req.user.practice_id, [a])).get(a.id)) || null });
  });

  // Denial risk of one patient's procedures (planned or done), against their primary insurance.
  r.get('/predict/denial', requirePermission('billing:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.query.patient_id, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const ids = String(req.query.procedure_ids || '').split(',').filter(Boolean).map(Number);
    if (!ids.length || ids.length > 100 || ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new HttpError(400, 'procedure_ids must be 1–100 procedure ids, separated by commas');
    const out = await procedureDenial(db, req.user.practice_id, patient.id, [...new Set(ids)]);
    res.json(out || { claim: null, lines: [], no_insurance: true });
  });

  // Predicted vs what happened, for the last N months (tested out of time — see noShowAccuracy / denialAccuracy).
  r.get('/predict/accuracy', requirePermission('reports:read'), async (req, res) => {
    const kind = req.query.kind || 'no_show';
    if (!['no_show', 'denial'].includes(kind)) throw new HttpError(400, 'kind must be no_show or denial');
    const months = req.query.months == null ? 6 : Number(req.query.months);
    if (!Number.isInteger(months) || months < 1 || months > 24) throw new HttpError(400, 'months must be a whole number from 1 to 24');
    res.json(kind === 'no_show' ? await noShowAccuracy(db, req.user.practice_id, { months }) : await denialAccuracy(db, req.user.practice_id, { months }));
  });
  return r;
}
