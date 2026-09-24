import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, findOr404, audit, practiceNow } from '../util.js';
import { REPORTS, PERIODS, renderSaved, sendSaved } from '../savedreports.js';

// Saved reports and their email schedule (Reports → Saved & scheduled).
export default function savedReportRoutes({ db, messenger }) {
  const r = Router();
  const clean = async (req, b, existing = {}) => {
    const row = {};
    if (b.name !== undefined || !existing.id) {
      row.name = String(b.name || '').trim().slice(0, 100);
      if (!row.name) throw new HttpError(400, 'Give the report a name');
    }
    if (b.report !== undefined || !existing.id) {
      if (!REPORTS[b.report]) throw new HttpError(400, `report must be one of ${Object.keys(REPORTS).join(', ')}`);
      row.report = b.report;
    }
    if (b.params !== undefined) {
      const p = b.params || {};
      if (p.period && !PERIODS[p.period]) throw new HttpError(400, 'Unknown period');
      if (p.location_id) await findOr404(db, 'locations', p.location_id, req.user.practice_id, 'Location');
      if (p.provider_id) await findOr404(db, 'providers', p.provider_id, req.user.practice_id, 'Provider');
      row.params = JSON.stringify({ period: p.period || 'mtd', ...(p.location_id ? { location_id: Number(p.location_id) } : {}), ...(p.provider_id ? { provider_id: Number(p.provider_id) } : {}) });
    }
    if (b.schedule !== undefined) {
      if (b.schedule && !['daily', 'weekly', 'monthly'].includes(b.schedule)) throw new HttpError(400, 'schedule must be daily, weekly or monthly');
      row.schedule = b.schedule || null;
    }
    if (b.recipients !== undefined) {
      const list = (Array.isArray(b.recipients) ? b.recipients : String(b.recipients || '').split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      const bad = list.find((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
      if (bad) throw new HttpError(400, `${bad} isn't an email address`);
      if (list.length > 10) throw new HttpError(400, 'Up to 10 recipients');
      row.recipients = JSON.stringify([...new Set(list)]);
    }
    const schedule = row.schedule !== undefined ? row.schedule : existing.schedule;
    const recipients = JSON.parse(row.recipients ?? existing.recipients ?? '[]');
    if (schedule && !recipients.length) throw new HttpError(400, 'Add who it goes to');
    return row;
  };

  r.get('/saved-reports', requirePermission('reports:read'), async (req, res) => {
    res.json({
      reports: Object.fromEntries(Object.entries(REPORTS).map(([k, v]) => [k, v.label])), periods: PERIODS,
      saved: (await db.all('SELECT * FROM saved_reports WHERE practice_id = ? ORDER BY name', req.user.practice_id)).map((x) => ({ ...x, params: JSON.parse(x.params || '{}'), recipients: JSON.parse(x.recipients || '[]') })),
    });
  });
  r.post('/saved-reports', requirePermission('reports:read'), async (req, res) => {
    const row = await clean(req, { params: {}, ...req.body });
    const id = await insert(db, 'saved_reports', { ...row, practice_id: req.user.practice_id, created_by: req.user.id });
    await audit(db, req, 'saved_report.create', 'saved_reports', id);
    res.status(201).json(await db.get('SELECT * FROM saved_reports WHERE id = ?', id));
  });
  r.put('/saved-reports/:sid', requirePermission('reports:read'), async (req, res) => {
    const existing = await findOr404(db, 'saved_reports', req.params.sid, req.user.practice_id, 'Saved report');
    const row = await clean(req, req.body || {}, existing);
    if (Object.keys(row).length) await db.run(`UPDATE saved_reports SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), existing.id);
    res.json(await db.get('SELECT * FROM saved_reports WHERE id = ?', existing.id));
  });
  r.delete('/saved-reports/:sid', requirePermission('reports:read'), async (req, res) => {
    const existing = await findOr404(db, 'saved_reports', req.params.sid, req.user.practice_id, 'Saved report');
    await db.run('DELETE FROM saved_reports WHERE id = ?', existing.id);
    await audit(db, req, 'saved_report.delete', 'saved_reports', existing.id, { name: existing.name });
    res.json({ ok: true });
  });
  r.get('/saved-reports/:sid/preview', requirePermission('reports:read'), async (req, res) => {
    const existing = await findOr404(db, 'saved_reports', req.params.sid, req.user.practice_id, 'Saved report');
    res.json(await renderSaved(db, existing, (await practiceNow(db, req.user.practice_id)).slice(0, 10)));
  });
  r.post('/saved-reports/:sid/send', requirePermission('reports:read'), async (req, res) => {
    const existing = await findOr404(db, 'saved_reports', req.params.sid, req.user.practice_id, 'Saved report');
    if (!JSON.parse(existing.recipients || '[]').length) throw new HttpError(400, 'Add who it goes to first');
    const sent = await sendSaved(db, messenger, existing, (await practiceNow(db, req.user.practice_id)).slice(0, 10));
    await audit(db, req, 'saved_report.send', 'saved_reports', existing.id, { sent });
    res.json({ sent });
  });
  return r;
}
