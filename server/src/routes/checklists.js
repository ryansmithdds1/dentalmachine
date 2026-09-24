import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { HttpError } from '../auth.js';
import { insert, update, audit, findOr404, recorded, isRealDate, toCsv, pageArgs } from '../util.js';
import { restricted } from '../officeaccess.js';
import { publish } from '../events.js';
import { currentActor } from '../actor.js';
import {
  MANAGE, canManage, CADENCES, RESULT_TYPES, ASSIGN_RULES, BUILT_IN_ROLES, isHm, addDays, weekdayOf, practiceClock, positionMembers, positionsOf,
  generate, rescheduleItem, cancelOpen, logEvent, cleanResult, outcomeOf, missingFor, MISSING_WORDS, raiseFlag, settingsOf, stateOf,
} from '../checklists.js';
import { STARTERS, STARTER_BY_KEY, DEFAULT_POSITIONS } from '../checklists-starters.js';

// Recurring checklists by position (backlog RCL1–RCL3; spec docs/workflows/specs/RCL-checklists.md).
// - Everyone signed in sees and ticks their own checklist (their positions' items, and items given to them).
// - Setting checklists up, the dashboard, resolving flags and the compliance log need checklists:manage
//   (owner / office manager; administrators always).
// - Every tick, undo, correction, photo and flag is on the occurrence's own history (checklist_events) and in the
//   audit log. Ticks can be undone for a few minutes; after that a change is a correction with a reason.
const MAX_FILE = 15 * 1024 * 1024;
const PHOTO_TYPES = /^image\/(jpeg|png|webp|gif|heic)$/;
const FILE_TYPES = /^(image\/(jpeg|png|webp|gif|heic)|application\/pdf)$/;
const marks = (a) => a.map(() => '?').join(',');
const utcNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const toMs = (utc) => Date.parse(`${String(utc).replace(' ', 'T')}Z`);
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const parseJson = (v, d = null) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

// What the bytes really are (never what the file is called).
export function sniffEvidence(buf) {
  const b = buf.subarray(0, 16);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(b.toString('latin1', 8, 12))) return 'image/heic';
  if (b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

const OCC_SELECT = `SELECT o.*, i.title, i.instructions, i.cadence, i.result_type, i.min_value, i.max_value, i.unit, i.require_photo, i.require_file, i.require_note,
    i.sop_page_id, i.assign_rule, i.sort AS item_sort, sp.title AS sop_title, t.name AS template_name, p.name AS position_name, l.name AS location_name,
    au.name AS assigned_name, cu.name AS completed_by_name,
    (SELECT COUNT(*) FROM checklist_evidence e WHERE e.occurrence_id = o.id AND e.removed_at IS NULL AND e.kind = 'photo') AS photos,
    (SELECT COUNT(*) FROM checklist_evidence e WHERE e.occurrence_id = o.id AND e.removed_at IS NULL AND e.kind = 'file') AS files,
    (SELECT COUNT(*) FROM checklist_flags f WHERE f.occurrence_id = o.id AND f.status = 'open') AS open_flags
  FROM checklist_occurrences o JOIN checklist_items i ON i.id = o.item_id JOIN checklist_templates t ON t.id = o.template_id
  JOIN checklist_positions p ON p.id = o.position_id LEFT JOIN intranet_pages sp ON sp.id = i.sop_page_id AND sp.status = 'active'
  LEFT JOIN locations l ON l.id = o.location_id LEFT JOIN users au ON au.id = o.assigned_to LEFT JOIN users cu ON cu.id = o.completed_by`;

export default function checklistRoutes({ db, storage, messenger = null }) {
  const r = Router();
  const staff = (req, _res, next) => (req.user?.practice_id ? next() : next(new HttpError(401, 'Authentication required')));
  const manage = (req, _res, next) => (canManage(req.user) ? next() : next(new HttpError(403, `Missing permission: ${MANAGE}`)));
  r.use('/checklists', staff);

  // ---- Shared checks ----
  const officeOk = (req, locationId) => !restricted(req.user) || !locationId || req.user.location_ids.includes(Number(locationId));
  const checkLocation = async (req, id) => {
    if (id == null || id === '') return null;
    const loc = await findOr404(db, 'locations', id, req.user.practice_id, 'Office');
    if (!officeOk(req, loc.id)) throw new HttpError(403, "That office isn't one of yours");
    return loc.id;
  };
  // Offices a list may show: the one asked for, else (for someone limited to some offices) theirs.
  const officeWhere = async (req, alias = 'o') => {
    if (req.query.location_id) return { sql: ` AND ${alias}.location_id = ?`, args: [await checkLocation(req, req.query.location_id)] };
    if (restricted(req.user)) return { sql: ` AND (${alias}.location_id IS NULL OR ${alias}.location_id IN (${marks(req.user.location_ids)}))`, args: [...req.user.location_ids] };
    return { sql: '', args: [] };
  };
  // May this person see (and work on) this occurrence? Managers: any in their offices. Others: theirs, their
  // positions', or one they ticked. Anything else answers 404 as if it didn't exist.
  const mayWork = async (req, occ) => {
    if (!officeOk(req, occ.location_id)) return false;
    if (canManage(req.user)) return true;
    if (occ.assigned_to === req.user.id || occ.completed_by === req.user.id) return true;
    return (await positionsOf(db, req.user)).some((p) => p.id === occ.position_id);
  };
  const loadOcc = async (req, id) => {
    const occ = await findOr404(db, 'checklist_occurrences', id, req.user.practice_id, 'Checklist item');
    if (!(await mayWork(req, occ))) throw new HttpError(404, 'Checklist item not found');
    const item = await db.get('SELECT * FROM checklist_items WHERE id = ?', occ.item_id);
    return { occ, item };
  };
  const evidenceOf = (occId) => db.all(
    'SELECT e.id, e.kind, e.filename, e.mime, e.size, e.uploaded_by, e.created_at, e.removed_at, e.removed_reason, u.name AS uploaded_by_name FROM checklist_evidence e LEFT JOIN users u ON u.id = e.uploaded_by WHERE e.occurrence_id = ? ORDER BY e.id', occId,
  );
  const shape = (row, nowLocal, undoMinutes, me) => ({
    ...row, photos: Number(row.photos || 0), files: Number(row.files || 0), open_flags: Number(row.open_flags || 0), state: stateOf(row, nowLocal),
    undo_until: row.status === 'done' && row.completed_at && row.completed_by === me ? new Date(toMs(row.completed_at) + undoMinutes * 60_000).toISOString() : null,
  });
  const detail = async (req, id) => {
    const { nowLocal } = await practiceClock(db, req.user.practice_id);
    const s = await settingsOf(db, req.user.practice_id);
    const row = await db.get(`${OCC_SELECT} WHERE o.id = ?`, id);
    const events = await db.all('SELECT e.*, u.name AS user_name FROM checklist_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.occurrence_id = ? ORDER BY e.id', id);
    const flags = await db.all('SELECT f.*, u.name AS resolved_by_name FROM checklist_flags f LEFT JOIN users u ON u.id = f.resolved_by WHERE f.occurrence_id = ? ORDER BY f.id', id);
    return {
      ...shape(row, nowLocal, s.undo_minutes, req.user.id), evidence: await evidenceOf(id), flags,
      events: events.map((e) => ({ ...e, details: parseJson(e.details) })), can_manage: canManage(req.user),
    };
  };
  const changed = (req, occ) => publish(req.user.practice_id, { type: 'checklists', occurrence_id: occ.id, by: req.user.id });
  const source = () => currentActor()?.source || 'human';

  // ---- Setup (RCL1) ----
  const ensureSetup = async (pid) => {
    const s = await settingsOf(db, pid);
    if (s.positions_seeded) return;
    const claim = await db.run('UPDATE checklist_settings SET positions_seeded = 1 WHERE practice_id = ? AND positions_seeded = 0', pid);
    if (!claim.changes) return;
    for (const [i, p] of DEFAULT_POSITIONS.entries()) {
      await db.run('INSERT INTO checklist_positions (practice_id, name, role, sort) VALUES (?, ?, ?, ?) ON CONFLICT (practice_id, name) DO NOTHING', pid, p.name, p.role, i);
    }
  };

  const cleanPosition = async (req, b, existing = null) => {
    const row = {};
    if (b.name !== undefined || !existing) {
      row.name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!row.name) throw new HttpError(400, 'Name the position');
    }
    if (b.role !== undefined) {
      row.role = b.role || null;
      if (row.role && !BUILT_IN_ROLES.includes(row.role)) throw new HttpError(400, `role must be one of: ${BUILT_IN_ROLES.join(', ')}`);
    }
    if (b.custom_role_id !== undefined) row.custom_role_id = b.custom_role_id ? (await findOr404(db, 'custom_roles', b.custom_role_id, req.user.practice_id, 'Custom role')).id : null;
    if (b.sort !== undefined) row.sort = Number.isInteger(Number(b.sort)) ? Number(b.sort) : 0;
    if (b.status !== undefined) {
      if (!['active', 'archived'].includes(b.status)) throw new HttpError(400, 'status must be active or archived');
      row.status = b.status;
    }
    return row;
  };
  const setMembers = async (req, positionId, ids) => {
    if (!Array.isArray(ids)) return;
    const want = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (want.length) {
      const found = await db.all(`SELECT id FROM users WHERE practice_id = ? AND id IN (${marks(want)})`, req.user.practice_id, ...want);
      if (found.length !== want.length) throw new HttpError(400, 'Someone in that list isn’t on this practice’s team');
    }
    const had = await db.all('SELECT * FROM checklist_position_members WHERE position_id = ?', positionId);
    for (const uid of want) {
      const row = had.find((m) => m.user_id === uid);
      if (!row) await db.run('INSERT INTO checklist_position_members (practice_id, position_id, user_id, added_by) VALUES (?, ?, ?, ?) ON CONFLICT (position_id, user_id) DO NOTHING', req.user.practice_id, positionId, uid, req.user.id);
      else if (row.removed_at) await db.run('UPDATE checklist_position_members SET removed_at = NULL, removed_by = NULL, added_by = ? WHERE id = ?', req.user.id, row.id);
    }
    for (const m of had) if (!m.removed_at && !want.includes(m.user_id)) await db.run("UPDATE checklist_position_members SET removed_at = datetime('now'), removed_by = ? WHERE id = ?", req.user.id, m.id);
    return { before: had.filter((m) => !m.removed_at).map((m) => m.user_id).sort((a, b) => a - b), after: want.sort((a, b) => a - b) };
  };

  const cleanItem = async (req, b, existing = null) => {
    const pid = req.user.practice_id;
    const has = (k) => b[k] !== undefined;
    const row = {};
    if (has('title') || !existing) {
      row.title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!row.title) throw new HttpError(400, 'Say what needs doing');
    }
    if (has('instructions')) row.instructions = b.instructions ? String(b.instructions).trim().slice(0, 4000) : null;
    if (has('sort')) row.sort = Number.isInteger(Number(b.sort)) ? Number(b.sort) : 0;
    const cadence = has('cadence') ? String(b.cadence) : existing?.cadence || 'daily';
    if (!CADENCES.includes(cadence)) throw new HttpError(400, `cadence must be one of: ${CADENCES.join(', ')}`);
    if (has('cadence') || !existing) row.cadence = cadence;
    if (has('weekdays')) {
      const list = Array.isArray(b.weekdays) ? b.weekdays : b.weekdays == null || b.weekdays === '' ? [] : String(b.weekdays).split(',');
      const days = [...new Set(list.map((x) => Number(String(x).trim())))].sort();
      if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HttpError(400, 'weekdays are 0 (Sunday) to 6 (Saturday)');
      row.weekdays = days.length ? days.join(',') : null;
    }
    if (has('weekday') || (cadence === 'weekly' && !existing)) {
      const w = b.weekday ?? 1;
      if (!Number.isInteger(Number(w)) || w < 0 || w > 6) throw new HttpError(400, 'weekday must be 0 (Sunday) to 6 (Saturday)');
      row.weekday = Number(w);
    }
    if (has('month_day') || (['monthly', 'quarterly', 'annually'].includes(cadence) && !existing)) {
      const d = Number(b.month_day ?? 1);
      if (!Number.isInteger(d) || !(d === -1 || (d >= 1 && d <= 31))) throw new HttpError(400, 'month_day must be 1 to 31, or -1 for the last business day');
      row.month_day = d;
    }
    if (has('month') || (['quarterly', 'annually'].includes(cadence) && !existing)) {
      const m = Number(b.month ?? 1);
      if (!Number.isInteger(m) || m < 1 || m > 12) throw new HttpError(400, 'month must be 1 to 12');
      row.month = m;
    }
    if (has('due_time')) {
      if (!isHm(b.due_time)) throw new HttpError(400, "due_time must be a time like '17:00'");
      row.due_time = b.due_time;
    }
    if (has('assign_rule')) {
      if (!ASSIGN_RULES.includes(b.assign_rule)) throw new HttpError(400, `assign_rule must be one of: ${ASSIGN_RULES.join(', ')}`);
      row.assign_rule = b.assign_rule;
    }
    if (has('assignee_id')) row.assignee_id = b.assignee_id ? (await findOr404(db, 'users', b.assignee_id, pid, 'Person')).id : null;
    const rule = row.assign_rule ?? existing?.assign_rule ?? 'position';
    if (rule === 'person' && !(row.assignee_id ?? existing?.assignee_id)) throw new HttpError(400, 'Choose who does this item');
    if (has('result_type')) {
      if (!RESULT_TYPES.includes(b.result_type)) throw new HttpError(400, `result_type must be one of: ${RESULT_TYPES.join(', ')}`);
      row.result_type = b.result_type;
    }
    for (const k of ['min_value', 'max_value']) {
      if (!has(k)) continue;
      if (b[k] === null || b[k] === '') row[k] = null;
      else {
        const n = Number(b[k]);
        if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw new HttpError(400, `${k} must be a number`);
        row[k] = String(n);
      }
    }
    const min = row.min_value !== undefined ? row.min_value : existing?.min_value;
    const max = row.max_value !== undefined ? row.max_value : existing?.max_value;
    if (min != null && max != null && Number(min) > Number(max)) throw new HttpError(400, 'The lowest allowed number is above the highest');
    if (has('unit')) row.unit = b.unit ? String(b.unit).trim().slice(0, 20) : null;
    for (const k of ['require_photo', 'require_file', 'require_note', 'critical']) if (has(k)) row[k] = bool(b[k]);
    if (has('sop_page_id')) {
      if (b.sop_page_id) {
        const page = await findOr404(db, 'intranet_pages', b.sop_page_id, pid, 'Office manual page');
        if (page.status !== 'active') throw new HttpError(400, 'That office manual page is archived');
        row.sop_page_id = page.id;
      } else row.sop_page_id = null;
    }
    if (has('start_date')) {
      if (!isRealDate(b.start_date)) throw new HttpError(400, 'start_date must be a real date (YYYY-MM-DD)');
      row.start_date = b.start_date;
    }
    return row;
  };
  const SCHEDULE_FIELDS = ['cadence', 'weekdays', 'weekday', 'month_day', 'month', 'due_time', 'assign_rule', 'assignee_id', 'critical', 'start_date'];

  const addItem = async (req, template, b, today) => {
    const row = await cleanItem(req, b);
    const id = await insert(db, 'checklist_items', {
      practice_id: req.user.practice_id, template_id: template.id, due_time: '17:00', start_date: today, ...row,
      created_by: req.user.id, updated_by: req.user.id,
    });
    await audit(db, req, 'checklist.item.create', 'checklist_items', id, { template_id: template.id, title: row.title, cadence: row.cadence, critical: !!row.critical }, { after: row });
    return id;
  };

  const setupPayload = async (req) => {
    const pid = req.user.practice_id;
    const positions = await db.all('SELECT * FROM checklist_positions WHERE practice_id = ? ORDER BY status, sort, name', pid);
    const members = await db.all('SELECT position_id, user_id FROM checklist_position_members WHERE practice_id = ? AND removed_at IS NULL', pid);
    for (const p of positions) {
      p.member_ids = members.filter((m) => m.position_id === p.id).map((m) => m.user_id);
      p.people = (await positionMembers(db, pid, p.id)).map((u) => ({ id: u.id, name: u.name }));
    }
    const templates = await db.all(
      `SELECT t.*, p.name AS position_name, l.name AS location_name FROM checklist_templates t JOIN checklist_positions p ON p.id = t.position_id
       LEFT JOIN locations l ON l.id = t.location_id WHERE t.practice_id = ? ORDER BY t.status, p.sort, t.name`, pid,
    );
    const items = await db.all(
      `SELECT i.*, sp.title AS sop_title, u.name AS assignee_name FROM checklist_items i LEFT JOIN intranet_pages sp ON sp.id = i.sop_page_id LEFT JOIN users u ON u.id = i.assignee_id
       WHERE i.practice_id = ? ORDER BY i.template_id, i.status, i.sort, i.id`, pid,
    );
    for (const t of templates) t.items = items.filter((i) => i.template_id === t.id);
    const settings = await settingsOf(db, pid);
    const added = new Set(templates.map((t) => t.starter_key).filter(Boolean));
    return {
      positions, templates,
      users: await db.all('SELECT id, name, role, custom_role_id FROM users WHERE practice_id = ? AND active = 1 ORDER BY name', pid),
      custom_roles: await db.all('SELECT id, name FROM custom_roles WHERE practice_id = ? ORDER BY name', pid),
      locations: await db.all('SELECT id, name FROM locations WHERE practice_id = ? AND active = 1 ORDER BY sort, id', pid),
      sop_pages: await db.all("SELECT id, title FROM intranet_pages WHERE practice_id = ? AND status = 'active' ORDER BY title", pid),
      settings: { ...settings, alert_user_ids: parseJson(settings.alert_user_ids), alert_phones: parseJson(settings.alert_phones, []) },
      starters: STARTERS.map((s) => ({ key: s.key, name: s.name, description: s.description, position: s.position, items: s.items.length, critical: s.items.filter((i) => i.critical).length, added: added.has(s.key) })),
      sms_ready: !!messenger?.send,
    };
  };

  r.get('/checklists/setup', manage, async (req, res) => {
    await ensureSetup(req.user.practice_id);
    res.json(await setupPayload(req));
  });

  r.post('/checklists/positions', manage, async (req, res) => {
    const pid = req.user.practice_id;
    const row = await cleanPosition(req, req.body || {});
    if (await db.get('SELECT id FROM checklist_positions WHERE practice_id = ? AND name = ?', pid, row.name)) throw new HttpError(409, 'There is already a position with that name');
    const id = await insert(db, 'checklist_positions', { practice_id: pid, ...row, created_by: req.user.id });
    const members = await setMembers(req, id, req.body?.member_ids);
    await audit(db, req, 'checklist.position.create', 'checklist_positions', id, { name: row.name, role: row.role ?? null, members: members?.after ?? [] });
    res.status(201).json(await db.get('SELECT * FROM checklist_positions WHERE id = ?', id));
  });

  r.put('/checklists/positions/:id', manage, async (req, res) => {
    const pid = req.user.practice_id;
    const pos = await findOr404(db, 'checklist_positions', req.params.id, pid, 'Position');
    const row = await cleanPosition(req, req.body || {}, pos);
    if (row.name && row.name !== pos.name && await db.get('SELECT id FROM checklist_positions WHERE practice_id = ? AND name = ? AND id <> ?', pid, row.name, pos.id)) throw new HttpError(409, 'There is already a position with that name');
    await update(db, 'checklist_positions', pos.id, pid, row);
    const members = await setMembers(req, pos.id, req.body?.member_ids);
    await audit(db, req, 'checklist.position.update', 'checklist_positions', pos.id, { name: row.name ?? pos.name }, members ? { before: { members: members.before.join(',') }, after: { members: members.after.join(',') } } : {});
    if (row.status === 'archived') {
      for (const t of await db.all('SELECT id FROM checklist_templates WHERE position_id = ?', pos.id)) await cancelOpen(db, pid, { templateId: t.id });
    }
    res.json(await db.get('SELECT * FROM checklist_positions WHERE id = ?', pos.id));
  });

  r.post('/checklists/templates', manage, async (req, res) => {
    const pid = req.user.practice_id;
    const b = req.body || {};
    const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Name the checklist');
    const position = await findOr404(db, 'checklist_positions', b.position_id, pid, 'Position');
    const locationId = await checkLocation(req, b.location_id);
    const { today } = await practiceClock(db, pid);
    const items = Array.isArray(b.items) ? b.items.slice(0, 100) : [];
    const id = await db.tx(async () => {
      const tid = await insert(db, 'checklist_templates', {
        practice_id: pid, position_id: position.id, location_id: locationId, name, description: b.description ? String(b.description).trim().slice(0, 1000) : null,
        created_by: req.user.id, updated_by: req.user.id,
      });
      for (const [i, it] of items.entries()) await addItem(req, { id: tid }, { sort: i, ...it }, today);
      return tid;
    });
    await audit(db, req, 'checklist.template.create', 'checklist_templates', id, { name, position_id: position.id, location_id: locationId, items: items.length });
    await generate(db, pid);
    res.status(201).json((await setupPayload(req)).templates.find((t) => t.id === id));
  });

  r.put('/checklists/templates/:id', manage, async (req, res) => {
    const pid = req.user.practice_id;
    const t = await findOr404(db, 'checklist_templates', req.params.id, pid, 'Checklist');
    const b = req.body || {};
    const row = {};
    if (b.name !== undefined) {
      row.name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!row.name) throw new HttpError(400, 'Name the checklist');
    }
    if (b.description !== undefined) row.description = b.description ? String(b.description).trim().slice(0, 1000) : null;
    if (b.position_id !== undefined) row.position_id = (await findOr404(db, 'checklist_positions', b.position_id, pid, 'Position')).id;
    if (b.location_id !== undefined) row.location_id = await checkLocation(req, b.location_id);
    if (b.status !== undefined) {
      if (!['active', 'archived'].includes(b.status)) throw new HttpError(400, 'status must be active or archived');
      row.status = b.status;
      row.archived_at = b.status === 'archived' ? utcNow() : null;
      row.archived_by = b.status === 'archived' ? req.user.id : null;
    }
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    await update(db, 'checklist_templates', t.id, pid, { ...row, updated_by: req.user.id, updated_at: utcNow() });
    await audit(db, req, `checklist.template.${row.status === 'archived' ? 'archive' : row.status === 'active' && t.status === 'archived' ? 'restore' : 'update'}`, 'checklist_templates', t.id, { name: row.name ?? t.name });
    const { today } = await practiceClock(db, pid);
    if (row.status === 'archived') await cancelOpen(db, pid, { templateId: t.id });
    else if ((row.status === 'active' && t.status === 'archived') || row.position_id !== undefined || row.location_id !== undefined) {
      // Back, or moved to another position or office: open ones from today on are made again for where it now
      // belongs. The dates it was away are not filled in as "missed".
      await cancelOpen(db, pid, { templateId: t.id });
      await db.run('UPDATE checklist_items SET generated_through = ? WHERE template_id = ?', addDays(today, -1), t.id);
      await generate(db, pid);
    }
    res.json((await setupPayload(req)).templates.find((x) => x.id === t.id));
  });

  r.post('/checklists/templates/:id/items', manage, async (req, res) => {
    const pid = req.user.practice_id;
    const t = await findOr404(db, 'checklist_templates', req.params.id, pid, 'Checklist');
    const { today } = await practiceClock(db, pid);
    const max = await db.get('SELECT MAX(sort) AS n FROM checklist_items WHERE template_id = ?', t.id);
    const id = await addItem(req, t, { sort: Number(max?.n ?? -1) + 1, ...(req.body || {}) }, today);
    await generate(db, pid, { itemId: id });
    res.status(201).json(await db.get('SELECT * FROM checklist_items WHERE id = ?', id));
  });

  r.put('/checklists/items/:id', manage, async (req, res) => {
    const pid = req.user.practice_id;
    const item = await findOr404(db, 'checklist_items', req.params.id, pid, 'Checklist item');
    const b = req.body || {};
    const row = await cleanItem(req, b, item);
    if (b.status !== undefined) {
      if (!['active', 'archived'].includes(b.status)) throw new HttpError(400, 'status must be active or archived');
      row.status = b.status;
      row.archived_at = b.status === 'archived' ? utcNow() : null;
      row.archived_by = b.status === 'archived' ? req.user.id : null;
    }
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    await update(db, 'checklist_items', item.id, pid, { ...row, updated_by: req.user.id, updated_at: utcNow() });
    await audit(db, req, `checklist.item.${row.status === 'archived' ? 'archive' : 'update'}`, 'checklist_items', item.id, { title: row.title ?? item.title, template_id: item.template_id });
    const now = await db.get('SELECT * FROM checklist_items WHERE id = ?', item.id);
    if (row.status === 'archived') await cancelOpen(db, pid, { itemId: item.id });
    else if (row.status === 'active' && item.status === 'archived') {
      const { today } = await practiceClock(db, pid);
      await db.run('UPDATE checklist_items SET generated_through = ? WHERE id = ?', addDays(today, -1), item.id);
      await generate(db, pid, { itemId: item.id });
    } else if (SCHEDULE_FIELDS.some((k) => row[k] !== undefined && String(row[k]) !== String(item[k]))) await rescheduleItem(db, now);
    res.json(await db.get('SELECT * FROM checklist_items WHERE id = ?', item.id));
  });

  r.get('/checklists/starters', manage, async (req, res) => {
    res.json((await setupPayload(req)).starters);
  });

  // One click: the starter's checklist (and its position, if the practice doesn't have one by that name).
  // Adding it again brings back the same checklist.
  r.post('/checklists/starters/:key', manage, async (req, res) => {
    const pid = req.user.practice_id;
    const starter = STARTER_BY_KEY[req.params.key];
    if (!starter) throw new HttpError(404, 'No such starter checklist');
    await ensureSetup(pid);
    const had = await db.get('SELECT * FROM checklist_templates WHERE practice_id = ? AND starter_key = ?', pid, starter.key);
    if (had) {
      if (had.status === 'archived') {
        const { today } = await practiceClock(db, pid);
        await update(db, 'checklist_templates', had.id, pid, { status: 'active', archived_at: null, archived_by: null, updated_by: req.user.id });
        await db.run('UPDATE checklist_items SET generated_through = ? WHERE template_id = ?', addDays(today, -1), had.id);
        await audit(db, req, 'checklist.template.restore', 'checklist_templates', had.id, { starter: starter.key });
        await generate(db, pid);
      }
      return res.status(200).json((await setupPayload(req)).templates.find((t) => t.id === had.id));
    }
    const locationId = await checkLocation(req, req.body?.location_id);
    const { today } = await practiceClock(db, pid);
    const id = await db.tx(async () => {
      await db.run('INSERT INTO checklist_positions (practice_id, name, role, created_by) VALUES (?, ?, ?, ?) ON CONFLICT (practice_id, name) DO NOTHING', pid, starter.position, starter.role, req.user.id);
      const position = await db.get('SELECT * FROM checklist_positions WHERE practice_id = ? AND name = ?', pid, starter.position);
      if (position.status === 'archived') await update(db, 'checklist_positions', position.id, pid, { status: 'active' });
      const made = await db.run(
        'INSERT INTO checklist_templates (practice_id, position_id, location_id, name, description, starter_key, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (practice_id, starter_key) DO NOTHING',
        pid, position.id, locationId, starter.name, `${starter.description} Starter checklist — adapt it to your office and your state’s rules.`, starter.key, req.user.id, req.user.id,
      );
      if (!made.changes) return null; // added by a second click at the same moment
      const tid = (await db.get('SELECT id FROM checklist_templates WHERE practice_id = ? AND starter_key = ?', pid, starter.key)).id;
      for (const [i, it] of starter.items.entries()) await addItem(req, { id: tid }, { sort: i, ...it }, today);
      return tid;
    });
    const tid = id ?? (await db.get('SELECT id FROM checklist_templates WHERE practice_id = ? AND starter_key = ?', pid, starter.key)).id;
    if (id) await audit(db, req, 'checklist.template.create', 'checklist_templates', id, { starter: starter.key, name: starter.name, items: starter.items.length });
    await generate(db, pid);
    res.status(id ? 201 : 200).json((await setupPayload(req)).templates.find((t) => t.id === tid));
  });

  r.put('/checklists/settings', manage, async (req, res) => {
    const pid = req.user.practice_id;
    const s = await settingsOf(db, pid);
    const b = req.body || {};
    const row = {};
    if (b.alert_user_ids !== undefined) {
      if (b.alert_user_ids === null) row.alert_user_ids = null;
      else {
        const ids = [...new Set((Array.isArray(b.alert_user_ids) ? b.alert_user_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
        if (ids.length && (await db.all(`SELECT id FROM users WHERE practice_id = ? AND id IN (${marks(ids)})`, pid, ...ids)).length !== ids.length) throw new HttpError(400, 'Someone in that list isn’t on this practice’s team');
        row.alert_user_ids = ids.length ? JSON.stringify(ids) : null;
      }
    }
    if (b.alert_phones !== undefined) {
      const phones = (Array.isArray(b.alert_phones) ? b.alert_phones : []).map((p) => String(p).trim()).filter(Boolean).slice(0, 5);
      for (const p of phones) if (!/^\+?[\d\s().-]{10,20}$/.test(p) || p.replace(/\D/g, '').length < 10) throw new HttpError(400, `${p} isn’t a phone number`);
      row.alert_phones = phones.length ? JSON.stringify(phones) : null;
    }
    if (b.chat_alerts !== undefined) row.chat_alerts = bool(b.chat_alerts);
    if (b.sms_alerts !== undefined) row.sms_alerts = bool(b.sms_alerts);
    if (b.undo_minutes !== undefined) {
      const n = Number(b.undo_minutes);
      if (!Number.isInteger(n) || n < 0 || n > 60) throw new HttpError(400, 'undo_minutes must be 0 to 60');
      row.undo_minutes = n;
    }
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    await update(db, 'checklist_settings', s.id, pid, { ...row, updated_by: req.user.id, updated_at: utcNow() });
    await audit(db, req, 'checklist.settings', 'checklist_settings', s.id, null);
    res.json((await setupPayload(req)).settings);
  });

  // ---- My checklist (staff) ----
  const mineWhere = async (req) => {
    const positions = await positionsOf(db, req.user);
    const ids = positions.map((p) => p.id);
    const where = [`o.practice_id = ?`, `(o.assigned_to = ?${ids.length ? ` OR (o.assigned_to IS NULL AND o.position_id IN (${marks(ids)}))` : ''})`];
    const args = [req.user.practice_id, req.user.id, ...ids];
    // The office this screen works in; someone limited to some offices only ever sees theirs.
    if (req.location_id) { where.push('o.location_key IN (0, ?)'); args.push(req.location_id); }
    else if (restricted(req.user)) { where.push(`o.location_key IN (0, ${marks(req.user.location_ids)})`); args.push(...req.user.location_ids); }
    return { where, args, positions };
  };

  r.get('/checklists/mine', async (req, res) => {
    const pid = req.user.practice_id;
    await generate(db, pid);
    const { nowLocal, today } = await practiceClock(db, pid);
    const s = await settingsOf(db, pid);
    const { where, args, positions } = await mineWhere(req);
    const rows = await db.all(
      `${OCC_SELECT} WHERE ${where.join(' AND ')} AND ((o.status = 'open' AND o.due_date <= ?) OR (o.status = 'done' AND o.completed_local >= ?))
       ORDER BY o.due_at, i.sort, o.id`, ...args, addDays(today, 31), today,
    );
    const items = rows.map((r) => shape(r, nowLocal, s.undo_minutes, req.user.id));
    const due = items.filter((x) => x.status === 'open' && x.due_date <= today);
    res.json({
      today, now: nowLocal, positions, items,
      counts: { due: due.length, overdue: due.filter((x) => x.state === 'overdue').length, done_today: items.filter((x) => x.status === 'done').length, coming_up: items.filter((x) => x.status === 'open' && x.due_date > today).length },
      can_manage: canManage(req.user),
    });
  });

  r.get('/checklists/count', async (req, res) => {
    const { nowLocal, today } = await practiceClock(db, req.user.practice_id);
    const { where, args } = await mineWhere(req);
    const row = await db.get(
      `SELECT COUNT(*) AS due, SUM(CASE WHEN o.due_at < ? THEN 1 ELSE 0 END) AS overdue, SUM(CASE WHEN o.critical = 1 THEN 1 ELSE 0 END) AS critical
       FROM checklist_occurrences o WHERE ${where.join(' AND ')} AND o.status = 'open' AND o.due_date <= ?`, nowLocal, ...args, today,
    );
    const flags = canManage(req.user) ? await db.get("SELECT COUNT(*) AS n, SUM(critical) AS critical FROM checklist_flags WHERE practice_id = ? AND status = 'open'", req.user.practice_id) : null;
    res.json({ due: Number(row?.due || 0), overdue: Number(row?.overdue || 0), critical: Number(row?.critical || 0), open_flags: flags ? Number(flags.n || 0) : null, critical_flags: flags ? Number(flags.critical || 0) : null });
  });

  r.get('/checklists/occurrences/:id', async (req, res) => {
    const { occ } = await loadOcc(req, req.params.id);
    res.json(await detail(req, occ.id));
  });

  // Saves what's been entered so far (a reading, pass/fail, a note) without ticking it off.
  r.post('/checklists/occurrences/:id/progress', async (req, res) => {
    const { occ, item } = await loadOcc(req, req.params.id);
    if (!['open', 'missed'].includes(occ.status)) throw new HttpError(409, occ.status === 'done' ? 'Already ticked off — use Correct to change it' : 'This item is no longer on the checklist');
    const values = cleanResult(item, req.body || {});
    if (Object.keys(values).length) await recorded(db, 'checklist_occurrences', occ.id, () => db.run(`UPDATE checklist_occurrences SET ${Object.keys(values).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(values), occ.id));
    res.json(await detail(req, occ.id));
  });

  // Ticks it off. Everything the item requires must be there (a failed result is recorded straight away, photo or
  // not). A second tick is harmless. A failed result or a number out of range raises a flag.
  r.post('/checklists/occurrences/:id/complete', async (req, res) => {
    const pid = req.user.practice_id;
    const { occ, item } = await loadOcc(req, req.params.id);
    if (occ.status === 'done') return res.json(await detail(req, occ.id));
    if (occ.status === 'cancelled') throw new HttpError(409, 'This item is no longer on the checklist');
    const b = req.body || {};
    const values = { result_number: occ.result_number, result_pass: occ.result_pass, result_text: occ.result_text, note: occ.note, ...cleanResult(item, b) };
    const reason = b.reason ? String(b.reason).trim().slice(0, 500) : null;
    if (occ.status === 'missed' && !reason) throw new HttpError(400, 'This one was missed — say why it’s being recorded late', { needs_reason: true });
    const missing = missingFor(item, values, await evidenceOf(occ.id));
    if (missing.length) throw new HttpError(400, `Still needed: ${missing.map((m) => MISSING_WORDS[m]).join(', ')}`, { missing });
    const outcome = outcomeOf(item, values);
    const { nowLocal } = await practiceClock(db, pid);
    const late = occ.status === 'missed' || nowLocal > occ.due_at ? 1 : 0;
    const out = await recorded(db, 'checklist_occurrences', occ.id, () => db.run(
      `UPDATE checklist_occurrences SET status = 'done', result_number = ?, result_pass = ?, result_text = ?, note = ?, outcome = ?, completed_at = ?, completed_local = ?,
         completed_by = ?, completed_source = ?, completed_late = ?, late_reason = ? WHERE id = ? AND status IN ('open','missed')`,
      values.result_number ?? null, values.result_pass ?? null, values.result_text ?? null, values.note ?? null, outcome, utcNow(), nowLocal,
      req.user.id, source(), late, reason, occ.id,
    ));
    if (!out.changes) return res.json(await detail(req, occ.id)); // ticked by someone else a moment ago
    await logEvent(db, occ, 'done', { details: { outcome, late: !!late, result_number: values.result_number ?? null, result_pass: values.result_pass ?? null }, reason, userId: req.user.id, source: source() });
    await audit(db, req, 'checklist.complete', 'checklist_occurrences', occ.id, { item_id: item.id, title: item.title, due_date: occ.due_date, outcome, late: !!late, critical: !!occ.critical }, { reason, locationId: occ.location_id });
    if (outcome !== 'ok') await raiseFlag(db, messenger, await db.get('SELECT * FROM checklist_occurrences WHERE id = ?', occ.id), item, outcome, { userId: req.user.id, source: source() });
    changed(req, occ);
    res.json(await detail(req, occ.id));
  });

  // Undo a tick within the practice's undo window (default 10 minutes), by whoever ticked it or a manager. A tick
  // that raised a flag can't be undone: a manager resolves the flag, and a wrong entry is corrected with a reason.
  r.post('/checklists/occurrences/:id/undo', async (req, res) => {
    const pid = req.user.practice_id;
    const { occ } = await loadOcc(req, req.params.id);
    if (occ.status !== 'done') throw new HttpError(409, 'This item isn’t ticked off');
    if (occ.completed_by !== req.user.id && !canManage(req.user)) throw new HttpError(403, 'Only the person who ticked it (or a manager) can undo it');
    const s = await settingsOf(db, pid);
    if (Date.now() - toMs(occ.completed_at) > s.undo_minutes * 60_000) throw new HttpError(409, `It’s been more than ${s.undo_minutes} minutes — make a correction with a reason instead`, { correction: true });
    if (await db.get("SELECT id FROM checklist_flags WHERE occurrence_id = ? AND kind IN ('fail','out_of_range')", occ.id)) throw new HttpError(409, 'This result raised a flag — a manager resolves it, and a wrong entry is corrected with a reason', { correction: true });
    const { today } = await practiceClock(db, pid);
    const back = occ.closes_on < today ? 'missed' : 'open';
    const out = await recorded(db, 'checklist_occurrences', occ.id, () => db.run(
      "UPDATE checklist_occurrences SET status = ?, outcome = NULL, completed_at = NULL, completed_local = NULL, completed_by = NULL, completed_source = NULL, completed_late = 0, late_reason = NULL WHERE id = ? AND status = 'done'",
      back, occ.id,
    ));
    if (out.changes) {
      await logEvent(db, occ, 'undone', { userId: req.user.id, source: source(), details: { ticked_by: occ.completed_by } });
      await audit(db, req, 'checklist.undo', 'checklist_occurrences', occ.id, { item_id: occ.item_id, due_date: occ.due_date }, { locationId: occ.location_id });
      changed(req, occ);
    }
    res.json(await detail(req, occ.id));
  });

  // A change to a ticked item after the undo window: the new values, with why. The earlier ones stay in the
  // history. A correction that makes the result a failure raises its flag.
  r.post('/checklists/occurrences/:id/correct', async (req, res) => {
    const { occ, item } = await loadOcc(req, req.params.id);
    if (occ.status !== 'done') throw new HttpError(409, 'Only a ticked-off item can be corrected');
    if (occ.completed_by !== req.user.id && !canManage(req.user)) throw new HttpError(403, 'Only the person who ticked it (or a manager) can correct it');
    const b = req.body || {};
    const reason = String(b.reason || '').trim().slice(0, 500);
    if (reason.length < 3) throw new HttpError(400, 'Say why it’s being corrected');
    const patch = cleanResult(item, b);
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change');
    const before = { result_number: occ.result_number, result_pass: occ.result_pass, result_text: occ.result_text, note: occ.note };
    const values = { ...before, ...patch };
    const missing = missingFor(item, values, await evidenceOf(occ.id)).filter((m) => !['photo', 'file'].includes(m));
    if (missing.length) throw new HttpError(400, `Still needed: ${missing.map((m) => MISSING_WORDS[m]).join(', ')}`, { missing });
    const outcome = outcomeOf(item, values);
    await recorded(db, 'checklist_occurrences', occ.id, () => db.run(
      'UPDATE checklist_occurrences SET result_number = ?, result_pass = ?, result_text = ?, note = ?, outcome = ? WHERE id = ?',
      values.result_number ?? null, values.result_pass ?? null, values.result_text ?? null, values.note ?? null, outcome, occ.id,
    ));
    await logEvent(db, occ, 'corrected', { details: { before: { ...before, outcome: occ.outcome }, after: { ...values, outcome } }, reason, userId: req.user.id, source: source() });
    await audit(db, req, 'checklist.correct', 'checklist_occurrences', occ.id, { item_id: item.id, title: item.title, due_date: occ.due_date }, { reason, locationId: occ.location_id });
    if (outcome !== 'ok') await raiseFlag(db, messenger, await db.get('SELECT * FROM checklist_occurrences WHERE id = ?', occ.id), item, outcome, { userId: req.user.id, source: source() });
    changed(req, occ);
    res.json(await detail(req, occ.id));
  });

  // ---- Evidence: photos (straight from the phone or tablet camera) and files, stored encrypted ----
  r.post('/checklists/occurrences/:id/evidence', express.raw({ type: () => true, limit: MAX_FILE }), async (req, res) => {
    const pid = req.user.practice_id;
    const { occ } = await loadOcc(req, req.params.id);
    if (occ.status === 'cancelled') throw new HttpError(409, 'This item is no longer on the checklist');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Empty upload');
    const kind = req.query.kind === 'file' ? 'file' : 'photo';
    const mime = sniffEvidence(req.body);
    if (!mime || !(kind === 'photo' ? PHOTO_TYPES : FILE_TYPES).test(mime)) throw new HttpError(415, kind === 'photo' ? 'That isn’t a photo (JPEG, PNG, HEIC, WebP or GIF)' : 'Attach a photo or a PDF');
    const sha = createHash('sha256').update(req.body).digest('hex');
    const had = await db.get('SELECT * FROM checklist_evidence WHERE occurrence_id = ? AND sha256 = ?', occ.id, sha);
    if (had && !had.removed_at) return res.status(200).json(had); // the same file sent twice
    if (had) throw new HttpError(409, 'That file was taken off this item — take a new photo');
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' }[mime];
    const base = String(req.query.filename || `${kind}-${occ.due_date}`).replace(/[^\w.\- ()]/g, '_').replace(/\.[^.]*$/, '').slice(0, 120) || kind;
    const { storageKey, encrypted } = await storage.save(pid, req.body);
    const id = await insert(db, 'checklist_evidence', {
      practice_id: pid, occurrence_id: occ.id, kind, filename: `${base}.${ext}`, mime, size: req.body.length, sha256: sha, storage_key: storageKey, encrypted: encrypted ? 1 : 0,
      uploaded_by: req.user.id, source: source(),
    });
    await logEvent(db, occ, 'evidence_added', { details: { evidence_id: id, kind, mime, size: req.body.length }, userId: req.user.id, source: source() });
    await audit(db, req, 'checklist.evidence.add', 'checklist_evidence', id, { occurrence_id: occ.id, kind, mime, size: req.body.length, encrypted: !!encrypted }, { locationId: occ.location_id });
    changed(req, occ);
    res.status(201).json(await db.get('SELECT id, occurrence_id, kind, filename, mime, size, created_at, uploaded_by FROM checklist_evidence WHERE id = ?', id));
  });

  r.get('/checklists/evidence/:eid', async (req, res) => {
    const e = await findOr404(db, 'checklist_evidence', req.params.eid, req.user.practice_id, 'File');
    await loadOcc(req, e.occurrence_id);
    if (e.removed_at && !canManage(req.user)) throw new HttpError(404, 'File not found');
    const data = await storage.read(e.storage_key, !!e.encrypted);
    if (!data) throw new HttpError(404, 'File missing from storage');
    res.set({
      'Content-Type': e.mime, 'Content-Length': data.length, 'Cache-Control': 'private, no-store',
      'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${e.filename.replace(/"/g, '')}"`,
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(data);
  });

  // Take a photo or file off an item (a wrong or blurry picture). Before the tick: whoever added it. After: a
  // manager, with a reason — and never the last piece of evidence an item requires.
  r.post('/checklists/evidence/:eid/remove', async (req, res) => {
    const e = await findOr404(db, 'checklist_evidence', req.params.eid, req.user.practice_id, 'File');
    const { occ, item } = await loadOcc(req, e.occurrence_id);
    if (e.removed_at) return res.json({ ok: true });
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (occ.status === 'done') {
      if (!canManage(req.user)) throw new HttpError(403, 'The item is ticked off — a manager can take evidence off it, with a reason');
      if (reason.length < 3) throw new HttpError(400, 'Say why it’s being taken off');
      const left = (await evidenceOf(occ.id)).filter((x) => !x.removed_at && x.id !== e.id);
      if ((item.require_photo && !left.some((x) => x.kind === 'photo')) || (item.require_file && !left.length)) throw new HttpError(409, 'This is the evidence the item requires — add the right one first');
    } else if (e.uploaded_by !== req.user.id && !canManage(req.user)) throw new HttpError(403, 'Only whoever added it (or a manager) can take it off');
    await recorded(db, 'checklist_evidence', e.id, () => db.run("UPDATE checklist_evidence SET removed_at = datetime('now'), removed_by = ?, removed_reason = ? WHERE id = ? AND removed_at IS NULL", req.user.id, reason || null, e.id));
    await logEvent(db, occ, 'evidence_removed', { details: { evidence_id: e.id }, reason: reason || null, userId: req.user.id, source: source() });
    await audit(db, req, 'checklist.evidence.remove', 'checklist_evidence', e.id, { occurrence_id: occ.id }, { reason: reason || null, locationId: occ.location_id });
    changed(req, occ);
    res.json({ ok: true });
  });

  // ---- Flags (RCL2) ----
  const FLAG_SELECT = `SELECT f.*, o.due_date, o.due_at, o.status AS occurrence_status, o.result_number, o.result_pass, o.completed_local, i.title AS item_title, i.unit,
      p.name AS position_name, l.name AS location_name, u.name AS resolved_by_name, cu.name AS completed_by_name
    FROM checklist_flags f JOIN checklist_occurrences o ON o.id = f.occurrence_id JOIN checklist_items i ON i.id = f.item_id JOIN checklist_positions p ON p.id = o.position_id
    LEFT JOIN locations l ON l.id = f.location_id LEFT JOIN users u ON u.id = f.resolved_by LEFT JOIN users cu ON cu.id = o.completed_by`;

  r.get('/checklists/flags', manage, async (req, res) => {
    const status = String(req.query.status || 'open');
    if (!['open', 'resolved', 'all'].includes(status)) throw new HttpError(400, 'status must be open, resolved or all');
    const office = await officeWhere(req, 'f');
    const rows = await db.all(
      `${FLAG_SELECT} WHERE f.practice_id = ?${status === 'all' ? '' : ' AND f.status = ?'}${office.sql} ORDER BY CASE f.status WHEN 'open' THEN 0 ELSE 1 END, f.critical DESC, f.id DESC LIMIT 500`,
      req.user.practice_id, ...(status === 'all' ? [] : [status]), ...office.args,
    );
    res.json(rows);
  });

  // Closing a flag takes the corrective action: what was done about it (sterilizer out of service and retested,
  // kit restocked…). It closes the Needs attention item with the same words.
  r.post('/checklists/flags/:id/resolve', manage, async (req, res) => {
    const pid = req.user.practice_id;
    const f = await findOr404(db, 'checklist_flags', req.params.id, pid, 'Flag');
    if (!officeOk(req, f.location_id)) throw new HttpError(404, 'Flag not found');
    if (f.status === 'resolved') return res.json(await db.get(`${FLAG_SELECT} WHERE f.id = ?`, f.id));
    const action = String(req.body?.action || '').trim().slice(0, 2000);
    if (action.length < 5) throw new HttpError(400, 'Write down the corrective action taken');
    await recorded(db, 'checklist_flags', f.id, () => db.run("UPDATE checklist_flags SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ?, corrective_action = ? WHERE id = ? AND status = 'open'", req.user.id, action, f.id));
    if (f.issue_id) {
      const issue = await db.get('SELECT * FROM issues WHERE id = ?', f.issue_id);
      if (issue?.status === 'open') {
        await update(db, 'issues', issue.id, pid, { status: 'resolved', resolved_at: utcNow(), resolved_by: req.user.id, resolution: `Corrective action: ${action}`.slice(0, 1000) });
        publish(pid, { type: 'issues' });
      }
    }
    const occ = await db.get('SELECT * FROM checklist_occurrences WHERE id = ?', f.occurrence_id);
    await logEvent(db, occ, 'flag_resolved', { details: { flag_id: f.id, kind: f.kind }, reason: action, userId: req.user.id, source: source() });
    await audit(db, req, 'checklist.flag.resolve', 'checklist_flags', f.id, { occurrence_id: f.occurrence_id, kind: f.kind, critical: !!f.critical }, { reason: action, locationId: f.location_id });
    publish(pid, { type: 'checklists', flag_id: f.id });
    res.json(await db.get(`${FLAG_SELECT} WHERE f.id = ?`, f.id));
  });

  // ---- Dashboard (RCL3) ----
  const weekStartOf = (d) => addDays(d, -((weekdayOf(d) + 6) % 7)); // Monday
  // Consecutive days (back from today) on which every item was done on time. Days with nothing due don't break
  // it; today counts once everything due today is done, and doesn't break it while the day is still going.
  const streakOf = (rows, today, nowLocal) => {
    const byDay = new Map();
    for (const o of rows) {
      if (!byDay.has(o.due_date)) byDay.set(o.due_date, []);
      byDay.get(o.due_date).push(stateOf(o, nowLocal));
    }
    let streak = 0;
    const days = [...byDay.keys()].sort().reverse();
    for (const d of days) {
      const states = byDay.get(d);
      const ok = states.every((s) => s === 'done');
      if (d === today) { if (ok) streak++; continue; }
      if (d > today) continue;
      if (!ok) break;
      streak++;
    }
    return streak;
  };
  const tally = (list, nowLocal) => {
    const c = { done: 0, late: 0, missed: 0, overdue: 0, open: 0, failed: 0, total: 0 };
    for (const o of list) {
      const s = stateOf(o, nowLocal);
      if (s === 'cancelled') continue;
      c[s]++;
      c.total++;
      if (o.outcome && o.outcome !== 'ok') c.failed++;
    }
    const due = c.done + c.late + c.missed + c.overdue;
    c.rate = due ? Math.round((c.done / due) * 100) : null;
    return c;
  };

  r.get('/checklists/dashboard', manage, async (req, res) => {
    const pid = req.user.practice_id;
    await generate(db, pid);
    const { nowLocal, today } = await practiceClock(db, pid);
    const from = req.query.from ? String(req.query.from) : weekStartOf(today);
    const to = req.query.to ? String(req.query.to) : today;
    if (!isRealDate(from) || !isRealDate(to) || from > to) throw new HttpError(400, 'from and to must be real dates, from first');
    const office = await officeWhere(req);
    const since = addDays(today, -90) < from ? addDays(today, -90) : from;
    const rows = await db.all(
      `SELECT o.id, o.item_id, o.position_id, o.location_id, o.due_date, o.due_at, o.status, o.outcome, o.completed_late, o.completed_by, o.assigned_to, o.critical,
         p.name AS position_name, cu.name AS completed_by_name, au.name AS assigned_name
       FROM checklist_occurrences o JOIN checklist_positions p ON p.id = o.position_id LEFT JOIN users cu ON cu.id = o.completed_by LEFT JOIN users au ON au.id = o.assigned_to
       WHERE o.practice_id = ? AND o.status <> 'cancelled' AND o.due_date >= ? AND o.due_date <= ?${office.sql}`,
      pid, since, today > to ? today : to, ...office.args,
    );
    const inRange = rows.filter((o) => o.due_date >= from && o.due_date <= to && o.due_date <= today);
    const history = rows.filter((o) => o.due_date <= today);
    // Positions.
    const positions = new Map();
    for (const o of history) if (!positions.has(o.position_id)) positions.set(o.position_id, { id: o.position_id, name: o.position_name });
    const byPosition = [...positions.values()].map((p) => ({
      ...p, counts: tally(inRange.filter((o) => o.position_id === p.id), nowLocal), streak: streakOf(history.filter((o) => o.position_id === p.id), today, nowLocal),
    })).sort((a, b) => a.name.localeCompare(b.name));
    // People: done items count for whoever did them; open and missed ones for whoever they were given to.
    const personOf = (o) => (o.status === 'done' ? o.completed_by : o.assigned_to);
    const people = new Map();
    for (const o of history) {
      const id = personOf(o);
      if (id && !people.has(id)) people.set(id, { id, name: o.status === 'done' ? o.completed_by_name : o.assigned_name });
    }
    const byPerson = [...people.values()].map((u) => ({
      ...u, counts: tally(inRange.filter((o) => personOf(o) === u.id), nowLocal), streak: streakOf(history.filter((o) => personOf(o) === u.id), today, nowLocal),
    })).sort((a, b) => a.name.localeCompare(b.name));
    const unassigned = tally(inRange.filter((o) => !personOf(o)), nowLocal);
    // Trend: the last 8 weeks, on time out of everything due.
    const trend = [];
    for (let w = 7; w >= 0; w--) {
      const start = addDays(weekStartOf(today), -7 * w);
      const end = addDays(start, 6);
      const c = tally(history.filter((o) => o.due_date >= start && o.due_date <= end), nowLocal);
      trend.push({ week: start, due: c.done + c.late + c.missed + c.overdue, on_time: c.done, late: c.late, missed: c.missed, rate: c.rate });
    }
    const todays = await db.all(`${OCC_SELECT} WHERE o.practice_id = ? AND o.due_date = ? AND o.status <> 'cancelled'${office.sql} ORDER BY p.sort, p.name, o.due_at, i.sort`, pid, today, ...office.args);
    const s = await settingsOf(db, pid);
    const flagOffice = await officeWhere(req, 'f');
    res.json({
      today, now: nowLocal, from, to, totals: tally(inRange, nowLocal), positions: byPosition, people: byPerson, unassigned, trend,
      today_items: todays.map((r) => shape(r, nowLocal, s.undo_minutes, req.user.id)),
      overdue: (await db.all(`${OCC_SELECT} WHERE o.practice_id = ? AND o.status = 'open' AND o.due_at < ? AND o.due_date < ?${office.sql} ORDER BY o.due_at LIMIT 100`, pid, nowLocal, today, ...office.args)).map((r) => shape(r, nowLocal, s.undo_minutes, req.user.id)),
      flags: await db.all(`${FLAG_SELECT} WHERE f.practice_id = ? AND f.status = 'open'${flagOffice.sql} ORDER BY f.critical DESC, f.id DESC`, pid, ...flagOffice.args),
    });
  });

  // ---- Compliance log (RCL3): e.g. every spore test for the last 12 months, with results, who, evidence and
  // what was done about each failure. JSON for the screen and the printable page, or CSV.
  r.get('/checklists/log', manage, async (req, res) => {
    const pid = req.user.practice_id;
    const { today, nowLocal } = await practiceClock(db, pid);
    const from = req.query.from ? String(req.query.from) : addDays(today, -365);
    const to = req.query.to ? String(req.query.to) : today;
    if (!isRealDate(from) || !isRealDate(to) || from > to) throw new HttpError(400, 'from and to must be real dates, from first');
    const where = ['o.practice_id = ?', "o.status <> 'cancelled'", 'o.due_date >= ?', 'o.due_date <= ?', "(o.status <> 'open' OR o.due_at < ?)"];
    const args = [pid, from, to, nowLocal];
    if (req.query.item_id) { where.push('o.item_id = ?'); args.push((await findOr404(db, 'checklist_items', req.query.item_id, pid, 'Checklist item')).id); }
    if (req.query.template_id) { where.push('o.template_id = ?'); args.push((await findOr404(db, 'checklist_templates', req.query.template_id, pid, 'Checklist')).id); }
    if (req.query.position_id) { where.push('o.position_id = ?'); args.push((await findOr404(db, 'checklist_positions', req.query.position_id, pid, 'Position')).id); }
    if (req.query.critical === '1') where.push('o.critical = 1');
    if (req.query.q) { where.push('i.title LIKE ?'); args.push(`%${String(req.query.q).slice(0, 100)}%`); }
    const office = await officeWhere(req);
    const rows = await db.all(`${OCC_SELECT} WHERE ${where.join(' AND ')}${office.sql} ORDER BY o.due_date DESC, o.due_at DESC, o.id DESC LIMIT 5000`, ...args, ...office.args);
    const ids = rows.map((r) => r.id);
    const flags = [];
    const evidence = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      flags.push(...await db.all(`SELECT f.*, u.name AS resolved_by_name FROM checklist_flags f LEFT JOIN users u ON u.id = f.resolved_by WHERE f.occurrence_id IN (${marks(chunk)}) ORDER BY f.id`, ...chunk));
      evidence.push(...await db.all(`SELECT id, occurrence_id, kind, filename, mime FROM checklist_evidence WHERE removed_at IS NULL AND occurrence_id IN (${marks(chunk)}) ORDER BY id`, ...chunk));
    }
    const s = await settingsOf(db, pid);
    const out = rows.map((r) => ({
      ...shape(r, nowLocal, s.undo_minutes, req.user.id), flags: flags.filter((f) => f.occurrence_id === r.id), evidence: evidence.filter((e) => e.occurrence_id === r.id),
    }));
    await audit(db, req, 'checklist.log.export', 'checklist_occurrences', null, { from, to, rows: out.length, format: req.query.format === 'csv' ? 'csv' : 'screen', item_id: req.query.item_id ?? null, q: req.query.q ?? null });
    if (req.query.format === 'csv') {
      const result = (o) => (o.result_type === 'pass_fail' ? (o.result_pass == null ? '' : o.result_pass ? 'Pass' : 'Fail') : o.result_type === 'number' ? (o.result_number == null ? '' : `${o.result_number}${o.unit ? ` ${o.unit}` : ''}`) : o.result_text || '');
      const csv = toCsv(out, [
        ['Due date', (o) => o.due_date], ['Due time', (o) => o.due_at.slice(11)], ['Item', (o) => o.title], ['Checklist', (o) => o.template_name], ['Position', (o) => o.position_name],
        ['Office', (o) => o.location_name || ''], ['Critical', (o) => (o.critical ? 'Yes' : '')], ['Status', (o) => ({ done: 'Done', late: 'Done late', missed: 'Missed', overdue: 'Not done (overdue)', open: 'Open' }[o.state] || o.state)],
        ['Result', result], ['Outcome', (o) => ({ ok: 'OK', fail: 'FAIL', out_of_range: 'OUT OF RANGE' }[o.outcome] || '')], ['Done by', (o) => o.completed_by_name || ''],
        ['Done at', (o) => o.completed_local || ''], ['Note', (o) => o.note || ''], ['Late entry reason', (o) => o.late_reason || ''], ['Evidence files', (o) => o.evidence.map((e) => e.filename).join('; ')],
        ['Flag', (o) => o.flags.map((f) => f.title).join('; ')], ['Corrective action', (o) => o.flags.map((f) => f.corrective_action || (f.status === 'open' ? 'OPEN' : '')).join('; ')],
        ['Resolved by', (o) => o.flags.map((f) => f.resolved_by_name || '').filter(Boolean).join('; ')],
      ]);
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="checklist-log-${from}-to-${to}.csv"` });
      return res.send(csv);
    }
    const { limit, offset } = pageArgs(req, { dflt: 5000, max: 5000 });
    res.set('X-Total-Count', String(out.length));
    res.json({ from, to, rows: out.slice(offset, offset + limit), items: await db.all("SELECT i.id, i.title, t.name AS template_name, i.critical FROM checklist_items i JOIN checklist_templates t ON t.id = i.template_id WHERE i.practice_id = ? ORDER BY t.name, i.sort", pid) });
  });

  return r;
}
