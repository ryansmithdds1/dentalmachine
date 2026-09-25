import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404 } from '../util.js';
import { runCheck, PDMP_WINDOW_HOURS } from '../pdmp.js';

// PDMP checks (README.md, “PDMP”): what's connected, a patient's checks, and running one. Prescribers only (clinical:sign),
// since a PDMP report is itself sensitive and states limit who may query it.
export default function pdmpRoutes({ db, pdmp }) {
  const r = Router();
  r.get('/pdmp', requirePermission('clinical:read'), (_req, res) => res.json({ mode: pdmp.mode, name: pdmp.name, automatic: pdmp.automatic, state: pdmp.state, window_hours: PDMP_WINDOW_HOURS }));
  r.get('/patients/:id/pdmp-checks', requirePermission('clinical:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const since = new Date(Date.now() - PDMP_WINDOW_HOURS * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    const rows = await db.all('SELECT c.*, u.name AS checked_by_name FROM pdmp_checks c LEFT JOIN users u ON u.id = c.checked_by WHERE c.practice_id = ? AND c.patient_id = ? ORDER BY c.id DESC LIMIT 50', req.user.practice_id, patient.id);
    res.json({ checks: rows, current: rows.find((c) => c.status === 'done' && c.created_at >= since) || null });
  });
  r.post('/patients/:id/pdmp-checks', requirePermission('clinical:sign'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const b = req.body || {};
    const provider = b.provider_id ? await findOr404(db, 'providers', b.provider_id, req.user.practice_id, 'Provider')
      : await db.get('SELECT * FROM providers WHERE practice_id = ? AND user_id = ? AND active = 1', req.user.practice_id, req.user.id);
    if (!b.manual && !pdmp.automatic && !b.summary) throw new HttpError(409, `No PDMP connection is set up — check the ${pdmp.state || 'state'} PDMP website and record what it showed`, { manual_only: true });
    const check = await runCheck(db, pdmp, req, patient, { provider, manual: !!b.manual, summary: b.summary });
    res.status(201).json(check);
  });
  return r;
}
