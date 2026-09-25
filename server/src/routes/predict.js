import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, toCsv, practiceNow } from '../util.js';
import { canSeePatient } from '../officeaccess.js';
import { getPredictor, forScreen } from '../predict/index.js';
import { noShowRisks, noShowAccuracy } from '../predict/noshow.js';
import { procedureDenial, denialAccuracy } from '../predict/denial.js';
import { logShown, noShowEntries, denialEntries, loggedAccuracy, loggedWithOutcomes, MIN_LOGGED } from '../predict/log.js';
import { addDays } from '../predict/noshow.js';

// Predictions (docs/predictions.md): no-show risk of a visit, denial risk of planned procedures, and how well the
// predictions have matched what actually happened. Predictions inform people and never act; what a person was shown
// is noted in prediction_log (predict/log.js) after the response, for "What staff saw".
export default function predictRoutes({ db }) {
  const r = Router();

  r.get('/predict/status', requirePermission('reports:read'), (req, res) => {
    res.json({ ...getPredictor().info(), kinds: ['no_show', 'denial'] });
  });

  // One visit's no-show risk (the schedule and the visit panel get it with the day's visits already).
  r.get('/predict/no-show/:id', requirePermission('schedule:read'), async (req, res) => {
    const a = await findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    if (!(await canSeePatient(db, req.user, a.patient_id))) throw new HttpError(404, 'Appointment not found');
    const prediction = forScreen((await noShowRisks(db, req.user.practice_id, [a])).get(a.id)) || null;
    res.json({ appointment_id: a.id, prediction });
    logShown(db, req, noShowEntries([{ ...a, no_show_risk: prediction }]), 'visit_panel');
  });

  // Denial risk of one patient's procedures (planned or done), against their primary insurance.
  r.get('/predict/denial', requirePermission('billing:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.query.patient_id, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const ids = String(req.query.procedure_ids || '').split(',').filter(Boolean).map(Number);
    if (!ids.length || ids.length > 100 || ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new HttpError(400, 'procedure_ids must be 1–100 procedure ids, separated by commas');
    const out = await procedureDenial(db, req.user.practice_id, patient.id, [...new Set(ids)]);
    res.json(out || { claim: null, lines: [], no_insurance: true });
    // Only the lines: no claim is being made from a treatment plan.
    if (out) logShown(db, req, denialEntries(out), 'treatment_plan');
  });

  const kindMonths = (req) => {
    const kind = req.query.kind || 'no_show';
    if (!['no_show', 'denial'].includes(kind)) throw new HttpError(400, 'kind must be no_show or denial');
    const months = req.query.months == null ? 6 : Number(req.query.months);
    if (!Number.isInteger(months) || months < 1 || months > 24) throw new HttpError(400, 'months must be a whole number from 1 to 24');
    return { kind, months };
  };

  // Predicted vs what happened, for the last N months. source: 'logged' ("What staff saw": the percentages people were
  // shown, predict/log.js), 'backtest' (worked out again out of time — noShowAccuracy / denialAccuracy), or left out:
  // what staff saw once there are MIN_LOGGED of them with an outcome, else the backtest.
  r.get('/predict/accuracy', requirePermission('reports:read'), async (req, res) => {
    const { kind, months } = kindMonths(req);
    const source = req.query.source ?? null;
    if (source != null && !['logged', 'backtest'].includes(source)) throw new HttpError(400, 'source must be logged or backtest');
    const pid = req.user.practice_id;
    const logged = source === 'backtest' ? null : await loggedAccuracy(db, pid, kind, { months });
    const available = { logged: logged?.n ?? null, min_logged: MIN_LOGGED };
    if (source === 'logged' || (source == null && logged.n >= MIN_LOGGED)) return res.json({ ...logged, available });
    const back = kind === 'no_show' ? await noShowAccuracy(db, pid, { months }) : await denialAccuracy(db, pid, { months });
    res.json({ ...back, source: 'backtest', available });
  });

  // The predictions staff were shown, with what happened, as a spreadsheet (an export, so it's audited). Subjects are
  // record numbers only — no names.
  r.get('/predict/log.csv', requirePermission('reports:read'), async (req, res) => {
    const { kind, months } = kindMonths(req);
    const pid = req.user.practice_id;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const from = addDays(today, -Math.round(months * 30.44));
    const rows = await loggedWithOutcomes(db, pid, kind, { from, to: today });
    await audit(db, req, 'report.export', 'prediction_log', null, { report: 'prediction_log', kind, from, to: today, rows: rows.length });
    const WHAT = { appointment: 'Visit', procedure: 'Claim line (procedure)', claim: 'Claim', claim_group: 'Claim being prepared (first procedure)' };
    const said = { no_show: ['Kept', 'Missed or cancelled late'], denial: ['Paid', 'Denied'] }[kind];
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="predictions-${kind}-${from}-to-${today}.csv"`, 'Cache-Control': 'no-store' });
    res.send(toCsv(rows, [
      ['Shown on', (r) => r.shown_on], ['Shown at (UTC)', (r) => r.shown_at], ['Prediction', () => (kind === 'no_show' ? 'No-show or late cancellation' : 'Denial')],
      ['About', (r) => WHAT[r.subject_type] || r.subject_type], ['Record #', (r) => r.subject_id], ['Percent', (r) => r.percent], ['Confidence', (r) => r.confidence],
      ['Reasons', (r) => { try { return JSON.parse(r.reasons || '[]').join('; '); } catch { return ''; } }], ['Screen', (r) => r.screen], ['Shown to', (r) => r.shown_to_name],
      ['Model', (r) => r.driver], ['Model version', (r) => r.model_version], ['What happened', (r) => (r.outcome == null ? 'Not known yet' : said[r.outcome])],
    ]));
  });
  return r;
}
