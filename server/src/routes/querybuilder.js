import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, findOr404, audit } from '../util.js';
import { buildQuery, QUERY_META } from '../querybuilder.js';

// Reports → Report builder.
export default function queryBuilderRoutes({ db }) {
  const r = Router();
  r.get('/query-builder', requirePermission('reports:read'), async (req, res) => {
    res.json({ ...QUERY_META, saved: (await db.all('SELECT id, name, spec FROM custom_queries WHERE practice_id = ? ORDER BY name', req.user.practice_id)).map((q) => ({ ...q, spec: JSON.parse(q.spec) })) });
  });
  r.post('/query-builder/run', requirePermission('reports:read'), async (req, res) => {
    const { sql, args, headers, limit } = buildQuery(req.body, req.user.practice_id);
    const rows = (await db.all(sql, ...args)).map((row) => headers.map((_, i) => row[`c${i}`] ?? null));
    await audit(db, req, 'report.custom', 'practices', req.user.practice_id, { dataset: req.body.dataset, rows: Math.min(rows.length, limit) });
    res.json({ headers, rows: rows.slice(0, limit), truncated: rows.length > limit });
  });
  r.post('/query-builder/saved', requirePermission('reports:read'), async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 100);
    if (!name) throw new HttpError(400, 'Name the report');
    buildQuery(req.body.spec, req.user.practice_id); // checks it
    const id = await insert(db, 'custom_queries', { practice_id: req.user.practice_id, name, spec: JSON.stringify(req.body.spec), created_by: req.user.id });
    res.status(201).json({ id, name, spec: req.body.spec });
  });
  r.delete('/query-builder/saved/:qid', requirePermission('reports:read'), async (req, res) => {
    const q = await findOr404(db, 'custom_queries', req.params.qid, req.user.practice_id, 'Saved report');
    await db.run('DELETE FROM custom_queries WHERE id = ?', q.id);
    res.json({ ok: true });
  });
  return r;
}
