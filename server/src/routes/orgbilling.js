import { Router } from 'express';
import { HttpError, PERMISSION_CATALOG } from '../auth.js';
import { insert, update, audit, practiceNow, paged, toCsv } from '../util.js';
import { requireHuman } from '../aiguard.js';
import {
  QUEUES, REPORT_COLUMNS, groupAccess, requireGroupBilling, pickPractices, queueRows, summarize, itemPractice,
  lookupCriteria, lookupPatients, reportRange, groupReport,
} from '../orgbilling.js';

// DSO central billing office, group reports and group role templates (see docs/dso.md).
// Mounted from routes/org.js, so it sits behind the same sign-in, actor, AI-guard and idempotency layers.
//
// Access:
//  - Billing queues and cross-practice patient lookup: group owners and members on the group's billing team
//    (org_members.billing), who also have billing:read in their own practice. They *see* rows from every
//    practice in the group; they *act* only inside a practice they're signed in to, through its own screens and
//    permissions — rows elsewhere come back read-only (can_open false, no link).
//  - Group reports: any member of the group (totals per practice, no patient records).
//  - Role templates and billing-team membership: group owners (who are administrators). Audited per practice.
const BASE_ROLES = ['dentist', 'hygienist', 'assistant', 'front_desk', 'billing'];

export default function orgBillingRoutes({ db }) {
  const r = Router();
  const billing = async (req, _res, next) => {
    try {
      req.group = await requireGroupBilling(db, req.user);
      next();
    } catch (err) { next(err); }
  };
  const member = async (req, _res, next) => {
    try {
      req.group = await groupAccess(db, req.user);
      if (!req.group) throw new HttpError(403, 'You aren’t part of a practice group');
      next();
    } catch (err) { next(err); }
  };
  const owner = async (req, _res, next) => {
    try {
      const g = await groupAccess(db, req.user);
      if (!g) throw new HttpError(403, 'You aren’t part of a practice group');
      if (g.role !== 'owner' || req.user.role !== 'admin') throw new HttpError(403, 'Only the group’s owners can do this');
      req.group = g;
      next();
    } catch (err) { next(err); }
  };
  // Audit entries land in the practice the record belongs to, so each practice's own log shows who in the
  // group looked at or changed its records.
  const asIn = (req, practiceId) => ({ user: { id: req.user.id, practice_id: practiceId, name: req.user.name, role: req.user.role }, ip: req.ip });

  // ---- Central billing queues ----
  r.get('/org/billing/summary', billing, async (req, res) => {
    const rows = await queueRows(db, req.user, req.group, req.group.practices);
    const s = summarize(rows, req.group.practices);
    const mine = rows.filter((x) => x.assigned_to === req.user.id).length;
    res.json({ queues: QUEUES, ...s, mine, practices: s.practices.map((p) => ({ ...p, can_open: p.practice_id === req.user.practice_id })) });
  });

  r.get('/org/billing/queue', billing, async (req, res) => {
    const queue = String(req.query.queue || 'outstanding');
    if (!Object.hasOwn(QUEUES, queue)) throw new HttpError(400, `Queue must be one of: ${Object.keys(QUEUES).join(', ')}`);
    const practices = pickPractices(req.group, req.query.practice_id);
    let rows = await queueRows(db, req.user, req.group, practices, { queues: [queue] });
    const who = String(req.query.assigned || 'all');
    if (who === 'me') rows = rows.filter((x) => x.assigned_to === req.user.id);
    else if (who === 'unassigned') rows = rows.filter((x) => !x.assigned_to);
    const minAge = Number(req.query.min_age) || 0;
    if (minAge > 0) rows = rows.filter((x) => (x.age_days ?? 0) >= minAge);
    const total = rows.length;
    const amount = rows.reduce((s, x) => s + x.amount, 0);
    // Patient names from other practices are on screen: a light record that the group billing view was used.
    await audit(db, req, 'org.billing_queue_view', 'organizations', req.group.id, { queue, practices: practices.map((p) => p.id), rows: total });
    res.json({ queue, label: QUEUES[queue], total, amount, rows: paged(req, res, rows, { dflt: 500, max: 5000 }) });
  });

  // Who can be given work: the group's billing team.
  r.get('/org/billing/team', billing, async (req, res) => {
    res.json(await db.all(
      `SELECT u.id, u.name, p.name AS practice, m.role FROM org_members m JOIN users u ON u.id = m.user_id JOIN practices p ON p.id = u.practice_id
       WHERE m.organization_id = ? AND (m.role = 'owner' OR m.billing = 1) AND u.active = 1 AND p.organization_id = ? ORDER BY u.name`, req.group.id, req.group.id,
    ));
  });

  // Bulk "assign to me" / to a teammate / unassign. Each item's practice is looked up here and must be in the group.
  r.post('/org/billing/assign', billing, async (req, res) => {
    const keys = [...new Set((Array.isArray(req.body?.keys) ? req.body.keys : []).map(String))];
    if (!keys.length) throw new HttpError(400, 'Choose at least one item');
    if (keys.length > 500) throw new HttpError(400, 'Assign at most 500 items at a time');
    const to = req.body.user_id == null || req.body.user_id === '' ? null : Number(req.body.user_id);
    if (to != null) {
      const ok = await db.get(
        `SELECT u.id FROM org_members m JOIN users u ON u.id = m.user_id JOIN practices p ON p.id = u.practice_id
         WHERE m.organization_id = ? AND m.user_id = ? AND (m.role = 'owner' OR m.billing = 1) AND u.active = 1 AND p.organization_id = ?`, req.group.id, to, req.group.id,
      );
      if (!ok) throw new HttpError(400, 'That person isn’t on the group’s billing team');
    }
    const members = new Set(req.group.practices.map((p) => p.id));
    const items = [];
    for (const key of keys) {
      const pid = await itemPractice(db, key);
      if (!pid || !members.has(pid)) throw new HttpError(404, `Not an item in this group: ${key}`);
      items.push({ key, pid });
    }
    const now = new Date().toISOString();
    const byPractice = new Map();
    await db.tx(async () => {
      for (const { key, pid } of items) {
        const have = await db.get('SELECT id, assigned_to FROM org_assignments WHERE organization_id = ? AND item_key = ?', req.group.id, key);
        if (have && (have.assigned_to ?? null) === to) continue;
        if (have) await db.run('UPDATE org_assignments SET assigned_to = ?, assigned_by = ?, updated_at = ? WHERE id = ?', to, req.user.id, now, have.id);
        else await insert(db, 'org_assignments', { organization_id: req.group.id, practice_id: pid, item_key: key, assigned_to: to, assigned_by: req.user.id, updated_at: now });
        if (!byPractice.has(pid)) byPractice.set(pid, []);
        byPractice.get(pid).push({ key, from: have?.assigned_to ?? null });
      }
    });
    for (const [pid, changed] of byPractice) {
      await audit(db, asIn(req, pid), 'org.billing_assign', 'organizations', req.group.id, { assigned_to: to, items: changed.map((c) => c.key) },
        { before: { assigned_to: [...new Set(changed.map((c) => c.from))].join(',') || null }, after: { assigned_to: to } });
    }
    res.json({ ok: true, changed: [...byPractice.values()].reduce((s, a) => s + a.length, 0) });
  });

  // ---- Cross-practice patient lookup (read-only summary) ----
  r.get('/org/billing/lookup', billing, async (req, res) => {
    const criteria = lookupCriteria(req.query);
    const rows = await lookupPatients(db, req.user, req.group, criteria);
    const fields = ['name', 'dob', 'phone'].filter((k) => (k === 'name' ? criteria.words.length : criteria[k]));
    // One entry in the searcher's practice, and one per patient shown in that patient's practice.
    await audit(db, req, 'org.patient_lookup', 'organizations', req.group.id, { fields, results: rows.length, practices: [...new Set(rows.map((x) => x.practice_id))] });
    for (const p of rows) {
      await audit(db, asIn(req, p.practice_id), 'org.patient_lookup', 'patients', p.patient_id, { fields, by_practice_id: req.user.practice_id, organization_id: req.group.id }, { patientId: p.patient_id });
    }
    res.json({ rows });
  });

  // ---- Group reports ----
  const report = async (req) => {
    const practices = pickPractices(req.group, req.query.practice_id);
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    return groupReport(db, practices, reportRange(req.query, today));
  };
  r.get('/org/reports', member, async (req, res) => {
    res.json({ columns: REPORT_COLUMNS, ...(await report(req)) });
  });
  r.get('/org/reports.csv', member, async (req, res) => {
    const rep = await report(req);
    const fmt = (kind, v) => (v == null ? '' : kind === 'money' ? (v / 100).toFixed(2) : String(v));
    const csv = toCsv([...rep.practices, { name: 'Group total', ...rep.totals }], [['Practice', (x) => x.name], ...REPORT_COLUMNS.map(([k, l, kind]) => [l, (x) => fmt(kind, x[k])])]);
    await audit(db, req, 'org.report_export', 'organizations', req.group.id, { from: rep.from, to: rep.to, practices: rep.practices.map((p) => p.practice_id) });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="group-report-${rep.from}-to-${rep.to}.csv"` }).send(csv);
  });

  // ---- Role templates (owners only) ----
  const view = (t) => ({ ...t, permissions: JSON.parse(t.permissions || '[]') });
  const clean = (b, partial = false) => {
    const out = {};
    if (!partial || b?.name !== undefined) {
      out.name = String(b?.name || '').trim().slice(0, 60);
      if (!out.name) throw new HttpError(400, 'Name the role');
    }
    if (!partial || b?.base_role !== undefined) {
      if (!BASE_ROLES.includes(b?.base_role)) throw new HttpError(400, `Base role must be one of: ${BASE_ROLES.join(', ')} (administrators are made in each practice)`);
      out.base_role = b.base_role;
    }
    if (!partial || b?.permissions !== undefined) {
      const perms = Array.isArray(b?.permissions) ? [...new Set(b.permissions.map(String))] : [];
      const bad = perms.find((p) => !(p in PERMISSION_CATALOG));
      if (bad) throw new HttpError(400, `Unknown permission ${bad}`);
      out.permissions = JSON.stringify(perms.sort());
    }
    return out;
  };
  const template = async (req) => {
    const t = await db.get('SELECT * FROM org_role_templates WHERE id = ? AND organization_id = ?', Number(req.params.tid), req.group.id);
    if (!t) throw new HttpError(404, 'Role template not found');
    return t;
  };

  r.get('/org/role-templates', owner, async (req, res) => {
    const ids = req.group.practices.map((p) => p.id);
    const counts = new Map((await db.all(
      `SELECT cr.org_template_id AS tid, COUNT(u.id) AS n FROM custom_roles cr JOIN users u ON u.custom_role_id = cr.id AND u.active = 1
       WHERE cr.practice_id IN (${ids.map(() => '?').join(',')}) AND cr.org_template_id IS NOT NULL GROUP BY cr.org_template_id`, ...ids,
    )).map((c) => [c.tid, Number(c.n)]));
    res.json({
      catalog: PERMISSION_CATALOG, base_roles: BASE_ROLES,
      templates: (await db.all('SELECT * FROM org_role_templates WHERE organization_id = ? AND active = 1 ORDER BY name', req.group.id)).map((t) => ({ ...view(t), people: counts.get(t.id) || 0 })),
    });
  });

  r.post('/org/role-templates', owner, async (req, res) => {
    const row = clean(req.body);
    if (await db.get('SELECT id FROM org_role_templates WHERE organization_id = ? AND lower(name) = lower(?) AND active = 1', req.group.id, row.name)) throw new HttpError(409, 'There’s already a template with that name');
    // A retired template with the same name comes back rather than colliding with the unique name.
    const old = await db.get('SELECT id FROM org_role_templates WHERE organization_id = ? AND lower(name) = lower(?)', req.group.id, row.name);
    let id;
    if (old) {
      await db.run('UPDATE org_role_templates SET name = ?, base_role = ?, permissions = ?, active = 1 WHERE id = ?', row.name, row.base_role, row.permissions, old.id);
      id = old.id;
    } else id = await insert(db, 'org_role_templates', { ...row, organization_id: req.group.id, created_by: req.user.id });
    await audit(db, req, 'org.role_template_create', 'org_role_templates', id, { organization_id: req.group.id }, { after: row });
    res.status(201).json(view(await db.get('SELECT * FROM org_role_templates WHERE id = ?', id)));
  });

  // Changing a template's permissions changes them for everyone given it, in every practice (their sessions restart).
  r.put('/org/role-templates/:tid', owner, async (req, res) => {
    requireHuman('changing permissions');
    const t = await template(req);
    const row = clean(req.body, true);
    if (row.name && row.name.toLowerCase() !== t.name.toLowerCase()
      && await db.get('SELECT id FROM org_role_templates WHERE organization_id = ? AND lower(name) = lower(?) AND id != ?', req.group.id, row.name, t.id)) throw new HttpError(409, 'There’s already a template with that name');
    const next = { ...t, ...row };
    await db.tx(async () => {
      await db.run('UPDATE org_role_templates SET name = ?, base_role = ?, permissions = ? WHERE id = ?', next.name, next.base_role, next.permissions, t.id);
      if (next.permissions !== t.permissions) {
        for (const cr of await db.all(`SELECT id, practice_id, permissions FROM custom_roles WHERE org_template_id = ? AND practice_id IN (${req.group.practices.map(() => '?').join(',')})`, t.id, ...req.group.practices.map((p) => p.id))) {
          await db.run('UPDATE custom_roles SET permissions = ? WHERE id = ?', next.permissions, cr.id);
          await db.run('UPDATE users SET token_version = token_version + 1 WHERE custom_role_id = ?', cr.id);
          await audit(db, asIn(req, cr.practice_id), 'role.update', 'custom_roles', cr.id, { from_org_template: t.id }, { before: { permissions: cr.permissions }, after: { permissions: next.permissions } });
        }
      }
    });
    await audit(db, req, 'org.role_template_update', 'org_role_templates', t.id, { organization_id: req.group.id },
      { before: { name: t.name, base_role: t.base_role, permissions: t.permissions }, after: { name: next.name, base_role: next.base_role, permissions: next.permissions } });
    res.json(view(await db.get('SELECT * FROM org_role_templates WHERE id = ?', t.id)));
  });

  // Retired, not deleted: people keep the practice role it made until someone changes it.
  r.post('/org/role-templates/:tid/retire', owner, async (req, res) => {
    const t = await template(req);
    await db.run('UPDATE org_role_templates SET active = 0 WHERE id = ?', t.id);
    await audit(db, req, 'org.role_template_retire', 'org_role_templates', t.id, { organization_id: req.group.id }, { before: { active: 1 }, after: { active: 0 } });
    res.json({ ok: true });
  });

  // Everyone at the group's practices, for choosing who gets a template.
  r.get('/org/people', owner, async (req, res) => {
    const ids = req.group.practices.map((p) => p.id);
    res.json(await db.all(
      `SELECT u.id, u.name, u.email, u.role, u.active, u.practice_id, p.name AS practice, cr.name AS custom_role, cr.org_template_id
       FROM users u JOIN practices p ON p.id = u.practice_id LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id AND cr.practice_id = u.practice_id
       WHERE u.practice_id IN (${ids.map(() => '?').join(',')}) AND u.active = 1 ORDER BY p.name, u.name`, ...ids,
    ));
  });

  // Apply a template to people across the group's practices at once. Each practice gets (or keeps) its own custom
  // role linked to the template; each person's role change is recorded before → after in their practice's log.
  r.post('/org/role-templates/:tid/apply', owner, async (req, res) => {
    requireHuman('changing permissions');
    const t = await template(req);
    if (!t.active) throw new HttpError(409, 'This template has been retired');
    const uids = [...new Set((Array.isArray(req.body?.user_ids) ? req.body.user_ids : []).map(Number).filter(Number.isInteger))];
    if (!uids.length) throw new HttpError(400, 'Choose who gets this role');
    if (uids.length > 200) throw new HttpError(400, 'Apply to at most 200 people at a time');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) || null : null;
    const members = new Set(req.group.practices.map((p) => p.id));
    const people = [];
    for (const uid of uids) {
      const u = await db.get('SELECT id, practice_id, name, role, active, custom_role_id, permissions_add, permissions_remove FROM users WHERE id = ?', uid);
      if (!u || !members.has(u.practice_id) || !u.active) throw new HttpError(404, `No active person with id ${uid} at a practice in this group`);
      if (u.role === 'admin') throw new HttpError(400, `${u.name} is an administrator — change administrators in their own practice`);
      people.push(u);
    }
    const results = [];
    await db.tx(async () => {
      const roleIn = new Map();
      for (const u of people) {
        let cr = roleIn.get(u.practice_id) || await db.get('SELECT id, permissions FROM custom_roles WHERE practice_id = ? AND org_template_id = ?', u.practice_id, t.id);
        if (!cr) {
          // The practice may already have its own role by that name; the group's one is told apart.
          const clash = await db.get('SELECT id FROM custom_roles WHERE practice_id = ? AND lower(name) = lower(?)', u.practice_id, t.name);
          const id = await insert(db, 'custom_roles', { practice_id: u.practice_id, name: clash ? `${t.name} (group)` : t.name, permissions: t.permissions, org_template_id: t.id });
          await audit(db, asIn(req, u.practice_id), 'role.create', 'custom_roles', id, { from_org_template: t.id }, { after: { permissions: t.permissions } });
          cr = { id, permissions: t.permissions };
        } else if (cr.permissions !== t.permissions) {
          await db.run('UPDATE custom_roles SET permissions = ? WHERE id = ?', t.permissions, cr.id);
          await db.run('UPDATE users SET token_version = token_version + 1 WHERE custom_role_id = ?', cr.id);
          await audit(db, asIn(req, u.practice_id), 'role.update', 'custom_roles', cr.id, { from_org_template: t.id }, { before: { permissions: cr.permissions }, after: { permissions: t.permissions } });
          cr = { ...cr, permissions: t.permissions };
        }
        roleIn.set(u.practice_id, cr);
        const after = { role: t.base_role, custom_role_id: cr.id, permissions_add: null, permissions_remove: null };
        const before = { role: u.role, custom_role_id: u.custom_role_id, permissions_add: u.permissions_add, permissions_remove: u.permissions_remove };
        const changed = Object.keys(after).some((k) => String(before[k] ?? '') !== String(after[k] ?? ''));
        if (changed) {
          await update(db, 'users', u.id, u.practice_id, after);
          // New permissions take effect now: the person's open sessions end.
          await db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', u.id);
        }
        await audit(db, asIn(req, u.practice_id), 'org.role_template_apply', 'users', u.id, { template_id: t.id, template: t.name, organization_id: req.group.id, changed }, { before, after, reason });
        results.push({ user_id: u.id, practice_id: u.practice_id, custom_role_id: cr.id, changed });
      }
    });
    res.json({ results });
  });

  return r;
}
