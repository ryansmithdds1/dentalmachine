import { Router } from 'express';
import { can, HttpError } from '../auth.js';
import { restricted } from '../officeaccess.js';
import { audit, findOr404, practiceNow } from '../util.js';
import { METRICS, BENCHMARKS, compareMetrics, metricRows, goalToValue, isDate, addDays, previousRange } from '../metrics.js';
import { areasForImprovement } from '../digests.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));

// Reports → Metrics: every KPI with its goal and trend, and the rows behind each number (metrics.js has the
// definitions; docs/metrics.md explains them). Goals per practice, office and provider are set here too.
export default function metricRoutes({ db }) {
  const r = Router();

  // Who may look, and at what: the whole practice with reports:read; only their own numbers with reports:own;
  // someone limited to some offices only those offices.
  async function scopeFor(req) {
    const pid = req.user.practice_id;
    const all = can(req.user, 'reports:read');
    let providerId = Number(req.query.provider_id) || null;
    let locationId = Number(req.query.location_id) || null;
    if (!all) {
      if (!can(req.user, 'reports:own')) throw new HttpError(403, 'Missing permission: reports:read');
      const mine = await db.get('SELECT id FROM providers WHERE practice_id = ? AND user_id = ? AND active = 1', pid, req.user.id);
      if (!mine) throw new HttpError(403, 'Your login isn’t linked to a provider, so there are no numbers of your own to show');
      providerId = mine.id;
    }
    if (providerId) await findOr404(db, 'providers', providerId, pid, 'Provider');
    if (locationId) await findOr404(db, 'locations', locationId, pid, 'Office');
    if (restricted(req.user)) {
      if (!locationId) locationId = req.user.location_ids[0];
      if (!req.user.location_ids.includes(locationId)) throw new HttpError(403, 'That office isn’t one of yours');
    }
    return { providerId, locationId };
  }

  // The dates asked for: a named period or from/to (practice-local), up to two years.
  async function rangeFor(req) {
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const period = String(req.query.period || (req.query.from ? 'custom' : 'month'));
    let from;
    let to;
    if (period === 'custom') {
      from = String(req.query.from || '');
      to = String(req.query.to || '');
      if (!isDate(from) || !isDate(to)) throw new HttpError(400, 'from and to must be real dates (YYYY-MM-DD)');
      if (to < from) throw new HttpError(400, 'to must be on or after from');
      if (Date.parse(to) - Date.parse(from) > 731 * 86400_000) throw new HttpError(400, 'Pick at most two years');
    } else if (period === 'today') ({ from, to } = { from: today, to: today });
    else if (period === 'yesterday') ({ from, to } = { from: addDays(today, -1), to: addDays(today, -1) });
    else if (period === 'week') {
      const monday = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
      ({ from, to } = { from: monday, to: today });
    } else if (period === 'last_week') {
      const monday = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
      ({ from, to } = { from: addDays(monday, -7), to: addDays(monday, -1) });
    } else if (period === 'month') ({ from, to } = { from: `${today.slice(0, 7)}-01`, to: today });
    else if (period === 'last_month') ({ from, to } = previousRange(`${today.slice(0, 7)}-01`, addDays(`${addDays(`${today.slice(0, 7)}-01`, 32).slice(0, 7)}-01`, -1)));
    else if (period === 'ytd') ({ from, to } = { from: `${today.slice(0, 4)}-01-01`, to: today });
    else throw new HttpError(400, 'period must be today, yesterday, week, last_week, month, last_month, ytd or custom');
    // Month to date is compared with the same days of last month, not the whole of it.
    const previous = period === 'month' || period === 'week' || period === 'ytd'
      ? (() => { const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000); const f = period === 'ytd' ? `${Number(from.slice(0, 4)) - 1}-01-01` : period === 'week' ? addDays(from, -7) : previousRange(from, addDays(`${addDays(from, 32).slice(0, 7)}-01`, -1)).from; return { from: f, to: addDays(f, days) }; })()
      : null;
    return { from, to, today, period, previous };
  }

  r.get('/metrics', async (req, res) => {
    const pid = req.user.practice_id;
    const s = await scopeFor(req);
    const range = await rangeFor(req);
    const keys = req.query.keys ? String(req.query.keys).split(',').filter((k) => METRICS[k]) : null;
    const cmp = await compareMetrics(db, pid, { from: range.from, to: range.to, today: range.today, ...(range.previous ? { previous: range.previous } : {}), ...(keys?.length ? { keys } : {}), ...s });
    const areas = await areasForImprovement(db, pid, cmp, { o: { today: range.today, ...s }, appUrl: '', names: 'full', vs: 'the period before' });
    res.json({ ...cmp, period: range.period, today: range.today, areas });
  });

  r.get('/metrics/:key/rows', async (req, res) => {
    if (!METRICS[req.params.key]) throw new HttpError(404, 'Unknown metric');
    const pid = req.user.practice_id;
    const s = await scopeFor(req);
    const range = await rangeFor(req);
    const out = await metricRows(db, pid, req.params.key, { from: range.from, to: range.to, today: range.today, ...s }, { limit: Math.min(Number(req.query.limit) || 500, 2000) });
    // Seeing who is behind the numbers is looking at patients' records: logged like any other report view.
    await audit(db, req, 'metrics.drill_down', 'metrics', null, { metric: req.params.key, from: range.from, to: range.to, rows: out.count, ...s });
    res.json({ ...out, from: range.from, to: range.to });
  });

  // ---- Goals ----
  const view = (g) => ({ ...g, display_value: goalToValue(g.metric, Number(g.value)) });
  r.get('/metric-goals', async (req, res) => {
    if (!can(req.user, 'reports:read')) throw new HttpError(403, 'Missing permission: reports:read');
    const goals = await db.all(
      `SELECT g.*, l.name AS location_name, pv.name AS provider_name FROM metric_goals g LEFT JOIN locations l ON l.id = g.location_id LEFT JOIN providers pv ON pv.id = g.provider_id
       WHERE g.practice_id = ? ORDER BY g.scope_key, g.metric`, req.user.practice_id,
    );
    res.json({
      goals: goals.map(view), benchmarks: BENCHMARKS,
      metrics: Object.fromEntries(Object.entries(METRICS).filter(([, m]) => m.goal).map(([k, m]) => [k, { label: m.label, unit: m.unit, better: m.better, goal: m.goal, scopes: m.scopes }])),
    });
  });

  // One goal for a metric and scope (practice, one office or one provider), replacing the one there.
  r.put('/metric-goals', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const b = req.body || {};
    const def = METRICS[b.metric];
    if (!def?.goal) throw new HttpError(400, 'Choose a metric that takes a goal');
    const scope = b.scope || 'practice';
    let locationId = null;
    let providerId = null;
    if (scope === 'location') locationId = (await findOr404(db, 'locations', b.location_id, pid, 'Office')).id;
    else if (scope === 'provider') providerId = (await findOr404(db, 'providers', b.provider_id, pid, 'Provider')).id;
    else if (scope !== 'practice') throw new HttpError(400, 'scope must be practice, location or provider');
    if (scope !== 'practice' && !def.scopes.includes(scope)) throw new HttpError(400, `${def.label} is only tracked for the whole practice`);
    const n = Number(b.value);
    if (b.value === '' || b.value == null || !Number.isFinite(n) || n < 0) throw new HttpError(400, 'The goal must be a number of zero or more');
    let stored;
    if (def.unit === 'percent') {
      if (n > 100) throw new HttpError(400, 'Percentage goals go from 0 to 100');
      stored = Math.round(n * 10);
    } else if (def.unit === 'money') {
      // Sent in cents, like every amount.
      if (!Number.isInteger(n) || n > 100_000_000_00) throw new HttpError(400, 'Money goals are whole cents, up to $100,000,000');
      stored = n;
    } else {
      if (!Number.isInteger(n) || n > 1_000_000) throw new HttpError(400, 'Count goals are whole numbers');
      stored = n;
    }
    const key = scope === 'practice' ? 'practice' : scope === 'location' ? `location:${locationId}` : `provider:${providerId}`;
    const before = await db.get('SELECT * FROM metric_goals WHERE practice_id = ? AND metric = ? AND scope_key = ?', pid, b.metric, key);
    if (before) await db.run("UPDATE metric_goals SET value = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?", stored, req.user.id, before.id);
    else await db.run('INSERT INTO metric_goals (practice_id, metric, scope_key, location_id, provider_id, value, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)', pid, b.metric, key, locationId, providerId, stored, req.user.id);
    const row = await db.get('SELECT * FROM metric_goals WHERE practice_id = ? AND metric = ? AND scope_key = ?', pid, b.metric, key);
    await audit(db, req, before ? 'metric_goal.change' : 'metric_goal.create', 'metric_goals', row.id, { metric: b.metric, scope: key }, { before: before ? { value: before.value } : undefined, after: { value: stored } });
    res.status(before ? 200 : 201).json(view(row));
  });

  // Goals are configuration: taking one away deletes it (audited with what it was).
  r.delete('/metric-goals/:gid', requireAdmin, async (req, res) => {
    const g = await findOr404(db, 'metric_goals', req.params.gid, req.user.practice_id, 'Goal');
    await db.run('DELETE FROM metric_goals WHERE id = ?', g.id);
    await audit(db, req, 'metric_goal.delete', 'metric_goals', g.id, { metric: g.metric, scope: g.scope_key }, { before: { value: g.value }, after: { value: null } });
    res.json({ ok: true });
  });

  return r;
}
