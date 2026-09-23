import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, update, audit } from '../util.js';
import { ISSUE_KINDS, ROLES } from '../issues.js';
import { publish } from '../events.js';

// "Needs attention": failures that became work items (see issues.js), and the log of calls to outside services.
const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));
const STATUSES = ['open', 'resolved', 'ignored'];
// Which queue a staff role works from; administrators see every queue.
const ROLE_QUEUE = { billing: 'billing', front_desk: 'front_desk', dentist: 'clinical', hygienist: 'clinical', assistant: 'clinical' };

export default function issueRoutes({ db }) {
  const r = Router();

  r.get('/issues', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const where = ['i.practice_id = ?'];
    const args = [pid];
    const status = String(req.query.status || 'open');
    if (!STATUSES.includes(status) && status !== 'all') throw new HttpError(400, `status must be one of: ${STATUSES.join(', ')}, all`);
    if (status !== 'all') { where.push('i.status = ?'); args.push(status); }
    if (req.query.kind) {
      if (!Object.hasOwn(ISSUE_KINDS, req.query.kind)) throw new HttpError(400, 'Unknown kind');
      where.push('i.kind = ?'); args.push(req.query.kind);
    }
    let role = req.query.role;
    if (role === 'mine') role = ROLE_QUEUE[req.user.role] || null;
    if (role) {
      if (!Object.hasOwn(ROLES, role)) throw new HttpError(400, 'Unknown role');
      where.push('(i.role = ? OR i.assigned_to = ?)'); args.push(role, req.user.id);
    }
    const issues = await db.all(
      `SELECT i.*, p.first_name || ' ' || p.last_name AS patient_name, a.name AS assigned_name, rb.name AS resolved_by_name
       FROM issues i LEFT JOIN patients p ON p.id = i.patient_id LEFT JOIN users a ON a.id = i.assigned_to LEFT JOIN users rb ON rb.id = i.resolved_by
       WHERE ${where.join(' AND ')}
       ORDER BY CASE i.severity WHEN 'high' THEN 0 ELSE 1 END, i.last_seen DESC LIMIT 300`, ...args,
    );
    const counts = await db.all("SELECT role, COUNT(*) AS n FROM issues WHERE practice_id = ? AND status = 'open' GROUP BY role", pid);
    res.json({ issues, open: Object.fromEntries(counts.map((c) => [c.role, Number(c.n)])), kinds: ISSUE_KINDS, roles: ROLES, my_queue: ROLE_QUEUE[req.user.role] || null });
  });

  // Resolve (with what was done), ignore (with why), reopen, or hand to someone.
  r.patch('/issues/:id', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const issue = await findOr404(db, 'issues', req.params.id, pid, 'Item');
    const row = {};
    const note = String(req.body?.note || '').trim().slice(0, 1000);
    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of: ${STATUSES.join(', ')}`);
      if (status !== 'open' && !note) throw new HttpError(400, status === 'ignored' ? 'Say why this can be ignored' : 'Say what was done to fix it');
      if (status === 'open' && issue.status !== 'open') {
        // Reopening can't collide with a newer open item for the same problem.
        if (await db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open' AND id <> ?", pid, issue.dedupe_key, issue.id)) throw new HttpError(409, 'This problem is already open again as a newer item');
      }
      Object.assign(row, status === 'open'
        ? { status, resolved_at: null, resolved_by: null, resolution: null }
        : { status, resolved_at: new Date().toISOString().slice(0, 19).replace('T', ' '), resolved_by: req.user.id, resolution: note });
    }
    if (req.body?.assigned_to !== undefined) {
      const uid = req.body.assigned_to === null ? null : Number(req.body.assigned_to);
      if (uid && !(await db.get('SELECT id FROM users WHERE id = ? AND practice_id = ?', uid, pid))) throw new HttpError(400, 'That person isn’t on this practice’s team');
      row.assigned_to = uid;
    }
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    await update(db, 'issues', issue.id, pid, row);
    await audit(db, req, `issue.${row.status || 'assign'}`, 'issues', issue.id, { title: issue.title }, { reason: note || null, patientId: issue.patient_id });
    publish(pid, { type: 'issues' });
    res.json(await db.get('SELECT * FROM issues WHERE id = ?', issue.id));
  });

  // Outside-service activity (administrators): what was called, whether it worked, how long it took.
  r.get('/integration-log', requireAdmin, async (req, res) => {
    const where = ['practice_id = ?'];
    const args = [req.user.practice_id];
    if (req.query.service) { where.push('service = ?'); args.push(String(req.query.service)); }
    if (req.query.failed === '1') where.push('ok = 0');
    const rows = await db.all(`SELECT * FROM integration_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 300`, ...args);
    const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const summary = await db.all(
      `SELECT service, COUNT(*) AS calls, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures, MAX(created_at) AS last_call,
         MAX(CASE WHEN ok = 0 THEN created_at END) AS last_failure
       FROM integration_log WHERE practice_id = ? AND created_at >= ? GROUP BY service ORDER BY service`, req.user.practice_id, since,
    );
    res.json({ rows, summary: summary.map((s) => ({ ...s, calls: Number(s.calls), failures: Number(s.failures) })) });
  });

  return r;
}
