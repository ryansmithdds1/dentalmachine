// Schedule setup. Perfect day / block scheduling (S2): named day templates per provider, their blocks and goals, and one-date
// changes. Templates are practice configuration: administrators create and change them (goals are money
// targets); anyone on the schedule can read them. A date override ("Dr. Chen is doing the Thursday plan this
// Tuesday", or "no template today") is a scheduling decision, so schedule:write. Nothing is deleted:
// templates and blocks are retired (active = 0) and a date goes back to normal with mode 'auto'.
import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, insert, update, findOr404, audit, toCents, isRealDate, recorded } from '../util.js';
import { checkOffice, restricted } from '../officeaccess.js';
import { publish } from '../events.js';
import { loadTemplates } from '../production.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only an administrator can change this')));

export default function dayTemplateRoutes({ db }) {
  const r = Router();
  const changed = (req) => publish(req.user.practice_id, { type: 'schedule', dates: null, by: req.user.id });

  const cleanBlocks = async (pid, blocks) => {
    if (!Array.isArray(blocks)) throw new HttpError(400, 'blocks must be a list');
    if (blocks.length > 24) throw new HttpError(400, 'A day template has at most 24 blocks');
    const out = [];
    for (const [i, b] of blocks.entries()) {
      const at = `Block ${i + 1}`;
      const label = String(b?.label ?? '').trim().slice(0, 60);
      if (!label) throw new HttpError(400, `${at}: give it a name (e.g. Crowns)`);
      if (!HHMM.test(b.start_time || '') || !HHMM.test(b.end_time || '')) throw new HttpError(400, `${at}: times must be HH:MM`);
      if (b.end_time <= b.start_time) throw new HttpError(400, `${at}: the end must be after the start`);
      const ids = [...new Set((Array.isArray(b.appointment_type_ids) ? b.appointment_type_ids : []).map(Number))];
      for (const id of ids) await findOr404(db, 'appointment_types', id, pid, 'Appointment type');
      const goal = b.goal == null || b.goal === '' ? 0 : toCents(b.goal, `${at} goal`);
      if (goal < 0) throw new HttpError(400, `${at}: the goal can't be negative`);
      let release = null;
      if (b.release_hours != null && b.release_hours !== '') {
        release = Number(b.release_hours);
        if (!Number.isInteger(release) || release < 0 || release > 336) throw new HttpError(400, `${at}: release time must be 0-336 hours before`);
      }
      const color = b.color == null || b.color === '' ? null : String(b.color);
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new HttpError(400, `${at}: color must look like #0ea5e9`);
      out.push({ label, start_time: b.start_time, end_time: b.end_time, appointment_type_ids: JSON.stringify(ids), goal, release_hours: release, color });
    }
    const sorted = [...out].sort((a, b) => a.start_time.localeCompare(b.start_time));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start_time < sorted[i - 1].end_time) throw new HttpError(400, `${sorted[i - 1].label} and ${sorted[i].label} overlap`);
    }
    return sorted;
  };

  // Checks and normalises the template's own fields (not its blocks).
  const cleanTemplate = async (req, row, existing = null) => {
    const pid = req.user.practice_id;
    if (row.name !== undefined) {
      row.name = String(row.name ?? '').trim().slice(0, 80);
      if (!row.name) throw new HttpError(400, 'Give the template a name, like "Dr. Chen Tuesday"');
    }
    if (row.provider_id !== undefined) row.provider_id = (await findOr404(db, 'providers', row.provider_id, pid, 'Provider')).id;
    if (row.location_id !== undefined && row.location_id !== null) {
      row.location_id = (await findOr404(db, 'locations', row.location_id, pid, 'Office')).id;
      checkOffice(req.user, row.location_id);
    }
    if (row.weekdays !== undefined) {
      const days = Array.isArray(row.weekdays) ? row.weekdays.map(Number) : null;
      if (!days || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HttpError(400, 'weekdays must be a list of 0 (Sunday) to 6 (Saturday)');
      row.weekdays = JSON.stringify([...new Set(days)].sort());
    }
    if (row.day_goal !== undefined && row.day_goal !== null) {
      row.day_goal = toCents(row.day_goal, 'day_goal');
      if (row.day_goal < 0) throw new HttpError(400, "The day's goal can't be negative");
    }
    if (row.release_hours !== undefined) {
      row.release_hours = Number(row.release_hours ?? 24);
      if (!Number.isInteger(row.release_hours) || row.release_hours < 0 || row.release_hours > 336) throw new HttpError(400, 'release_hours must be 0-336');
    }
    if (row.active !== undefined) row.active = row.active ? 1 : 0;
    // One template per provider per weekday, so the week always knows which plan to use.
    const merged = { ...existing, ...row };
    if (merged.active !== 0) {
      const days = JSON.parse(merged.weekdays || '[]');
      const others = await db.all('SELECT id, name, weekdays FROM day_templates WHERE practice_id = ? AND provider_id = ? AND active = 1 AND id != ?', pid, merged.provider_id, existing?.id ?? 0);
      const clash = others.find((o) => JSON.parse(o.weekdays || '[]').some((d) => days.includes(d)));
      if (clash) {
        const names = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
        const day = JSON.parse(clash.weekdays).find((d) => days.includes(d));
        throw new HttpError(409, `“${clash.name}” already plans this provider’s ${names[day]} — take that day off it first`, { template_id: clash.id });
      }
    }
  };
  const addBlocks = async (pid, templateId, blocks) => {
    for (const b of blocks) await insert(db, 'day_template_blocks', { practice_id: pid, template_id: templateId, ...b });
  };
  const visible = (req, list) => (restricted(req.user) ? list.filter((t) => !t.location_id || req.user.location_ids.includes(t.location_id)) : list);
  const one = async (req, id) => (await loadTemplates(db, req.user.practice_id, { includeRetired: true })).find((t) => t.id === id);

  r.get('/day-templates', requirePermission('schedule:read'), async (req, res) => {
    res.json(visible(req, await loadTemplates(db, req.user.practice_id, { includeRetired: req.query.include_retired === 'true' })));
  });

  r.post('/day-templates', requirePermission('schedule:read'), requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const row = pick(req.body, ['provider_id', 'location_id', 'name', 'weekdays', 'day_goal', 'release_hours']);
    if (row.provider_id == null) throw new HttpError(400, 'Choose the provider this day is for');
    row.weekdays ??= [];
    row.release_hours ??= 24;
    row.name ??= '';
    await cleanTemplate(req, row);
    const blocks = await cleanBlocks(pid, req.body?.blocks ?? []);
    const id = await db.tx(async () => {
      const tid = await insert(db, 'day_templates', { ...row, practice_id: pid, created_by: req.user.id });
      await addBlocks(pid, tid, blocks);
      return tid;
    });
    const saved = await one(req, id);
    await audit(db, req, 'day_template.create', 'day_templates', id, { name: saved.name, provider_id: saved.provider_id, weekdays: saved.weekdays, blocks: saved.blocks.length }, { after: { name: saved.name, day_goal: saved.day_goal, weekdays: JSON.stringify(saved.weekdays) } });
    changed(req);
    res.status(201).json(saved);
  });

  // Changes the template; `blocks`, when sent, replaces the day's blocks (the old ones are retired, kept for history).
  r.put('/day-templates/:tid', requirePermission('schedule:read'), requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const existing = await findOr404(db, 'day_templates', req.params.tid, pid, 'Day template');
    const row = pick(req.body, ['provider_id', 'location_id', 'name', 'weekdays', 'day_goal', 'release_hours', 'active']);
    await cleanTemplate(req, row, existing);
    const blocks = req.body?.blocks !== undefined ? await cleanBlocks(pid, req.body.blocks) : null;
    const before = await one(req, existing.id);
    await db.tx(async () => {
      if (Object.keys(row).length) await update(db, 'day_templates', existing.id, pid, { ...row, updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
      if (blocks) {
        for (const b of before.blocks) await update(db, 'day_template_blocks', b.id, pid, { active: 0 });
        await addBlocks(pid, existing.id, blocks);
      }
    });
    const saved = await one(req, existing.id);
    const summary = (t) => t.blocks.map((b) => `${b.start_time}-${b.end_time} ${b.label} (${b.goal})`).join('; ');
    await audit(db, req, row.active === 0 && existing.active ? 'day_template.retire' : 'day_template.update', 'day_templates', existing.id, { name: saved.name, fields: Object.keys(row), ...(blocks ? { blocks: blocks.length } : {}) }, {
      reason: req.body?.reason ?? null,
      before: { ...(blocks ? { blocks: summary(before) } : {}) },
      after: { ...(blocks ? { blocks: summary(saved) } : {}) },
    });
    changed(req);
    res.json(saved);
  });

  // Retiring a template: it stops planning days, and stays on file.
  r.post('/day-templates/:tid/retire', requirePermission('schedule:read'), requireAdmin, async (req, res) => {
    const existing = await findOr404(db, 'day_templates', req.params.tid, req.user.practice_id, 'Day template');
    if (existing.active) {
      await update(db, 'day_templates', existing.id, req.user.practice_id, { active: 0 });
      await audit(db, req, 'day_template.retire', 'day_templates', existing.id, { name: existing.name }, { reason: req.body?.reason ?? null });
      changed(req);
    }
    res.json(await one(req, existing.id));
  });

  // One date planned differently: { mode: 'template', template_id } | { mode: 'none' } | { mode: 'auto' } (back to usual).
  r.get('/day-template-dates', requirePermission('schedule:read'), async (req, res) => {
    const { from, to } = req.query;
    if (!isRealDate(from) || !isRealDate(to) || to < from) throw new HttpError(400, 'from and to must be real dates (YYYY-MM-DD)');
    res.json(await db.all("SELECT * FROM day_template_dates WHERE practice_id = ? AND date >= ? AND date <= ? AND mode != 'auto' ORDER BY date, provider_id", req.user.practice_id, from, to));
  });
  r.put('/providers/:pid/day-plan/:date', requirePermission('schedule:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const provider = await findOr404(db, 'providers', req.params.pid, pid, 'Provider');
    const date = req.params.date;
    if (!isRealDate(date)) throw new HttpError(400, 'date must be a real date (YYYY-MM-DD)');
    const mode = req.body?.mode;
    if (!['template', 'none', 'auto'].includes(mode)) throw new HttpError(400, "mode must be 'template', 'none' or 'auto'");
    let templateId = null;
    if (mode === 'template') {
      const t = await findOr404(db, 'day_templates', req.body.template_id, pid, 'Day template');
      if (!t.active) throw new HttpError(409, 'That template is retired');
      if (t.provider_id !== provider.id) throw new HttpError(400, 'That template is for another provider');
      if (t.location_id) checkOffice(req.user, t.location_id);
      templateId = t.id;
    }
    const reason = req.body?.reason == null ? null : String(req.body.reason).trim().slice(0, 300) || null;
    const was = await db.get('SELECT * FROM day_template_dates WHERE provider_id = ? AND date = ? AND practice_id = ?', provider.id, date, pid);
    let id = was?.id;
    if (was) await update(db, 'day_template_dates', was.id, pid, { mode, template_id: templateId, reason });
    else id = await insert(db, 'day_template_dates', { practice_id: pid, provider_id: provider.id, date, mode, template_id: templateId, reason, created_by: req.user.id });
    await audit(db, req, 'day_template.date', 'day_template_dates', id, { provider_id: provider.id, date, mode, template_id: templateId }, {
      reason, before: was ? { mode: was.mode, template_id: was.template_id } : undefined, after: { mode, template_id: templateId },
    });
    publish(pid, { type: 'schedule', dates: [date], by: req.user.id });
    res.json(await db.get('SELECT * FROM day_template_dates WHERE id = ?', id));
  });

  // Late patients (S7): how many minutes after a visit's start the schedule calls it late, and very late.
  r.get('/schedule/late-settings', requirePermission('schedule:read'), async (req, res) => {
    res.json(await db.get('SELECT late_minutes, very_late_minutes FROM practices WHERE id = ?', req.user.practice_id));
  });
  r.put('/schedule/late-settings', requirePermission('schedule:read'), requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const before = await db.get('SELECT late_minutes, very_late_minutes FROM practices WHERE id = ?', pid);
    const late = Number(req.body?.late_minutes ?? before.late_minutes);
    const veryLate = Number(req.body?.very_late_minutes ?? before.very_late_minutes);
    if (!Number.isInteger(late) || late < 1 || late > 60) throw new HttpError(400, 'Late after must be 1 to 60 minutes');
    if (!Number.isInteger(veryLate) || veryLate < 1 || veryLate > 60) throw new HttpError(400, 'Very late after must be 1 to 60 minutes');
    if (veryLate < late) throw new HttpError(400, '“Very late” has to be the same or later than “late”');
    await recorded(db, 'practices', pid, () => db.run('UPDATE practices SET late_minutes = ?, very_late_minutes = ? WHERE id = ?', late, veryLate, pid));
    await audit(db, req, 'practice.late_settings', 'practices', pid, null, { before, after: { late_minutes: late, very_late_minutes: veryLate } });
    publish(pid, { type: 'schedule', dates: null, by: req.user.id });
    res.json({ late_minutes: late, very_late_minutes: veryLate });
  });

  return r;
}
