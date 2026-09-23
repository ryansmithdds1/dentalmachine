import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, normalizeDateTime, practiceNow, mapSeq } from '../util.js';
import { hoursFor } from '../hours.js';
import { publish, eventStream } from '../events.js';

export const STATUSES = ['scheduled', 'confirmed', 'checked_in', 'in_chair', 'completed', 'cancelled', 'no_show'];
export const INACTIVE = "('cancelled','no_show')";

const SELECT = `SELECT a.*, p.first_name, p.last_name, p.preferred_name, p.phone, p.medical_alerts, p.dob,
  pr.name AS provider_name, pr.color AS provider_color, o.name AS operatory_name,
  t.name AS type_name, t.color AS type_color,
  (SELECT COALESCE(SUM(fee), 0) FROM procedures x WHERE x.appointment_id = a.id AND x.status != 'cancelled') AS production,
  (SELECT GROUP_CONCAT(code || COALESCE(' #' || tooth, ''), ', ') FROM procedures x WHERE x.appointment_id = a.id AND x.status != 'cancelled') AS procedure_summary
  FROM appointments a
  JOIN patients p ON p.id = a.patient_id
  JOIN providers pr ON pr.id = a.provider_id
  LEFT JOIN operatories o ON o.id = a.operatory_id
  LEFT JOIN appointment_types t ON t.id = a.appointment_type_id`;

async function findConflicts(
  db,
  practiceId,
  { start_time, end_time, provider_id, operatory_id, patient_id },
  excludeId = 0
) {
  return await db.all(
    `SELECT a.id, a.start_time, a.end_time, a.provider_id, a.operatory_id, a.patient_id FROM appointments a
     WHERE a.practice_id = ? AND a.id != ? AND a.status NOT IN ${INACTIVE}
       AND a.start_time < ? AND a.end_time > ?
       AND (a.provider_id = ? OR (a.operatory_id IS NOT NULL AND a.operatory_id = ?) OR a.patient_id = ?)`,
    practiceId, excludeId, end_time, start_time, provider_id, operatory_id ?? -1, patient_id,
  );
}

// Blockouts that apply to this provider/operatory (or the whole office) during the slot.
export async function findBlockouts(db, practiceId, { start_time, end_time, provider_id, operatory_id }) {
  return await db.all(
    `SELECT * FROM blockouts WHERE practice_id = ? AND start_time < ? AND end_time > ?
     AND ((provider_id IS NULL AND operatory_id IS NULL) OR provider_id = ? OR operatory_id = ?)`,
    practiceId, end_time, start_time, provider_id ?? -1, operatory_id ?? -1,
  );
}

export async function validateAppt(db, practiceId, row, { overrideBlockout = false } = {}) {
  row.start_time = normalizeDateTime(row.start_time, 'start_time');
  row.end_time = normalizeDateTime(row.end_time, 'end_time');
  if (row.end_time <= row.start_time) throw new HttpError(400, 'end_time must be after start_time');
  if (row.start_time.slice(0, 10) !== row.end_time.slice(0, 10)) throw new HttpError(400, 'Appointments must start and end on the same day');
  requireOneOf(row.status, STATUSES, 'status');
  await findOr404(db, 'patients', row.patient_id, practiceId, 'Patient');
  await findOr404(db, 'providers', row.provider_id, practiceId, 'Provider');
  if (row.operatory_id) await findOr404(db, 'operatories', row.operatory_id, practiceId, 'Operatory');
  if (row.appointment_type_id) await findOr404(db, 'appointment_types', row.appointment_type_id, practiceId, 'Appointment type');
  const conflicts = await findConflicts(db, practiceId, row, row.id);
  if (conflicts.length) {
    const kinds = new Set();
    for (const c of conflicts) {
      if (c.provider_id === Number(row.provider_id)) kinds.add('provider');
      if (row.operatory_id && c.operatory_id === Number(row.operatory_id)) kinds.add('operatory');
      if (c.patient_id === Number(row.patient_id)) kinds.add('patient');
    }
    throw new HttpError(409, `Scheduling conflict: ${[...kinds].join(', ')} already booked`, { conflicts });
  }
  if (!overrideBlockout) {
    const blocks = await findBlockouts(db, practiceId, row);
    if (blocks.length) throw new HttpError(409, `That time is blocked: ${blocks[0].reason}`, { blockouts: blocks, can_override: true });
  }
}

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
export const addMinutes = (dateTime, minutes) => `${dateTime.slice(0, 10)} ${fromMin(toMin(dateTime.slice(11, 16)) + minutes)}`;

// Free start times for a provider on a day, on a grid (minutes) within office hours, avoiding appointments and blockouts.
export async function openSlots(
  db,
  practiceId,
  providerId,
  date,
  { duration = 60, step = 10, after = null, open = null, close = null } = {}
) {
  const practice = await db.get('SELECT office_hours FROM practices WHERE id = ?', practiceId);
  const ranges = open && close ? [[open, close]] : hoursFor(practice, date);
  const busy = [
    ...(await db.all(
      `SELECT start_time, end_time FROM appointments WHERE practice_id = ? AND provider_id = ? AND status NOT IN ${INACTIVE}
       AND start_time >= ? AND start_time < ?`, practiceId, providerId, `${date} 00:00`, `${date} 24:00`,
    )),
    ...(await db.all(
      `SELECT start_time, end_time FROM blockouts WHERE practice_id = ? AND start_time < ? AND end_time > ?
       AND ((provider_id IS NULL AND operatory_id IS NULL) OR provider_id = ?)`, practiceId, `${date} 24:00`, `${date} 00:00`, providerId,
    )),
  ].map((a) => [a.start_time.slice(0, 10) < date ? 0 : toMin(a.start_time.slice(11)), a.end_time.slice(0, 10) > date ? 24 * 60 : toMin(a.end_time.slice(11))]);
  const slots = [];
  for (const [o, c] of ranges) {
    for (let t = toMin(o); t + duration <= toMin(c); t += step) {
      const slot = `${date} ${fromMin(t)}`;
      if (after && slot <= after) continue;
      if (!busy.some(([s, e]) => t < e && t + duration > s)) slots.push(slot);
    }
  }
  return slots;
}

const datesBetween = (from, to) => {
  const out = [];
  for (let d = from; d <= to && out.length < 62; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};

export default function scheduleRoutes({ db }) {
  const r = Router();
  const FIELDS = ['patient_id', 'provider_id', 'operatory_id', 'start_time', 'end_time', 'status', 'reason', 'notes', 'appointment_type_id', 'asap'];
  const changed = (req, ...dates) => publish(req.user.practice_id, { type: 'schedule', dates: [...new Set(dates.filter(Boolean).map((d) => d.slice(0, 10)))], by: req.user.id });

  r.get('/appointments', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const from = req.query.from || req.query.date || (await practiceNow(db, pid)).slice(0, 10);
    const to = req.query.to || from;
    const where = ['a.practice_id = ?', 'a.start_time >= ?', 'a.start_time < ?'];
    const params = [pid, `${from} 00:00`, `${to} 24:00`];
    for (const key of ['provider_id', 'operatory_id', 'patient_id']) {
      if (req.query[key]) {
        where.push(`a.${key} = ?`);
        params.push(Number(req.query[key]));
      }
    }
    if (req.query.include_cancelled !== 'true') where.push(`a.status NOT IN ${INACTIVE}`);
    res.json(await db.all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY a.start_time`, ...params));
  });

  r.get('/appointments/:id', requirePermission('schedule:read'), async (req, res) => {
    const row = await db.get(`${SELECT} WHERE a.id = ? AND a.practice_id = ?`, Number(req.params.id), req.user.practice_id);
    if (!row) throw new HttpError(404, 'Appointment not found');
    row.procedures = await db.all('SELECT * FROM procedures WHERE appointment_id = ? ORDER BY id', row.id);
    res.json(row);
  });

  r.post('/appointments', requirePermission('schedule:write'), async (req, res) => {
    const row = pick(req.body, FIELDS);
    const type = row.appointment_type_id ? await findOr404(db, 'appointment_types', row.appointment_type_id, req.user.practice_id, 'Appointment type') : null;
    if (type && row.start_time && !row.end_time) row.end_time = addMinutes(normalizeDateTime(row.start_time, 'start_time'), type.duration);
    if (type && !row.reason) row.reason = type.name;
    requireFields(row, ['patient_id', 'provider_id', 'start_time', 'end_time']);
    await validateAppt(db, req.user.practice_id, row, { overrideBlockout: !!req.body.override_blockout });
    const id = await db.tx(async () => {
      const newId = await insert(db, 'appointments', { ...row, practice_id: req.user.practice_id });
      // Appointment types can pre-load their procedures (e.g. exam + prophy + BWX) so scheduled production is known.
      if (type?.procedure_codes && req.body.add_type_procedures !== false && !(req.body.procedure_ids || []).length) {
        for (const code of JSON.parse(type.procedure_codes)) {
          const pc = await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ? AND active = 1', req.user.practice_id, code);
          if (!pc || pc.requires_tooth) continue;
          await insert(db, 'procedures', {
            practice_id: req.user.practice_id, patient_id: row.patient_id, appointment_id: newId, provider_id: row.provider_id,
            code_id: pc.id, code: pc.code, description: pc.description, category: pc.category, fee: pc.fee,
          });
        }
      }
      return newId;
    });
    // Attach planned procedures the user chose to schedule in this visit.
    for (const procId of req.body.procedure_ids || []) {
      await db.run("UPDATE procedures SET appointment_id = ? WHERE id = ? AND practice_id = ? AND patient_id = ? AND status = 'planned'", id, Number(procId), req.user.practice_id, row.patient_id);
    }
    await db.run("UPDATE recalls SET status = 'scheduled' WHERE practice_id = ? AND patient_id = ? AND status IN ('due','contacted')", req.user.practice_id, row.patient_id);
    await audit(db, req, 'appointment.create', 'appointments', id);
    changed(req, row.start_time);
    res.status(201).json(await db.get(`${SELECT} WHERE a.id = ?`, id));
  });

  r.put('/appointments/:id', requirePermission('schedule:write'), async (req, res) => {
    const existing = await findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    const changes = pick(req.body, FIELDS);
    const merged = { ...existing, ...changes };
    if (!['cancelled', 'no_show'].includes(merged.status)) await validateAppt(db, req.user.practice_id, merged, { overrideBlockout: !!req.body.override_blockout });
    else requireOneOf(merged.status, STATUSES, 'status');
    const row = pick(merged, FIELDS);
    // A moved appointment needs a fresh reminder and confirmation.
    if (row.start_time !== existing.start_time) Object.assign(row, { reminder_sent_at: null, confirmed_at: null });
    await update(db, 'appointments', existing.id, req.user.practice_id, row);
    // Keep attached procedures with the provider the patient is now seeing.
    if (Number(row.provider_id) !== existing.provider_id) await db.run("UPDATE procedures SET provider_id = ? WHERE appointment_id = ? AND status = 'planned'", row.provider_id, existing.id);
    await audit(db, req, 'appointment.update', 'appointments', existing.id, { fields: Object.keys(changes) });
    changed(req, existing.start_time, row.start_time);
    res.json(await db.get(`${SELECT} WHERE a.id = ?`, existing.id));
  });

  r.patch('/appointments/:id/status', requirePermission('schedule:write'), async (req, res) => {
    const existing = await findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    const { status } = req.body || {};
    requireFields({ status }, ['status']);
    requireOneOf(status, STATUSES, 'status');
    // Reactivating a cancelled slot must not double-book.
    if (['cancelled', 'no_show'].includes(existing.status) && !['cancelled', 'no_show'].includes(status)) {
      await validateAppt(db, req.user.practice_id, { ...existing, status }, { overrideBlockout: true });
    }
    await db.run(
      "UPDATE appointments SET status = ?, confirmed_at = CASE WHEN ? = 'confirmed' THEN COALESCE(confirmed_at, datetime('now')) ELSE confirmed_at END WHERE id = ?",
      status, status, existing.id,
    );
    if (status === 'cancelled' || status === 'no_show') {
      await db.run("UPDATE procedures SET appointment_id = NULL WHERE appointment_id = ? AND status = 'planned'", existing.id);
    }
    await audit(db, req, 'appointment.status', 'appointments', existing.id, { from: existing.status, to: status });
    changed(req, existing.start_time);
    res.json(await db.get(`${SELECT} WHERE a.id = ?`, existing.id));
  });

  // Free slots for a provider on a day, on a 10-minute grid within opening hours.
  r.get('/availability', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const { date, provider_id } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new HttpError(400, 'date must be YYYY-MM-DD');
    await findOr404(db, 'providers', provider_id, pid, 'Provider');
    const duration = Math.max(10, Number(req.query.duration) || 60);
    const slots = await openSlots(db, pid, Number(provider_id), date, { duration, open: req.query.open, close: req.query.close });
    res.json({ date, provider_id: Number(provider_id), duration, slots });
  });

  // Everything the calendar needs for a date range in one round trip.
  r.get('/schedule', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const from = req.query.from || (await practiceNow(db, pid)).slice(0, 10);
    const to = req.query.to || from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw new HttpError(400, 'from/to must be YYYY-MM-DD');
    const practice = await db.get('SELECT office_hours, daily_goal FROM practices WHERE id = ?', pid);
    const dates = datesBetween(from, to);
    const appointments = await db.all(
      `${SELECT} WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? ${req.query.include_cancelled === 'true' ? '' : `AND a.status NOT IN ${INACTIVE}`} ORDER BY a.start_time`,
      pid, `${from} 00:00`, `${to} 24:00`,
    );
    const production = Object.fromEntries(dates.map((d) => [d, 0]));
    for (const a of appointments) if (!['cancelled', 'no_show'].includes(a.status)) production[a.start_time.slice(0, 10)] += a.production;
    res.json({
      from, to, daily_goal: practice.daily_goal,
      hours: Object.fromEntries(dates.map((d) => [d, hoursFor(practice, d)])),
      appointments,
      blockouts: await db.all('SELECT * FROM blockouts WHERE practice_id = ? AND start_time < ? AND end_time > ? ORDER BY start_time', pid, `${to} 24:00`, `${from} 00:00`),
      production,
    });
  });

  // ASAP list: booked patients who'd take an earlier opening.
  r.get('/asap', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    res.json(await db.all(`${SELECT} WHERE a.practice_id = ? AND a.asap = 1 AND a.start_time > ? AND a.status IN ('scheduled','confirmed') ORDER BY a.start_time`, pid, await practiceNow(db, pid)));
  });

  // ---- Blockouts (lunch, meetings, holidays, "crown seats only"…) ----
  const BLOCK_FIELDS = ['provider_id', 'operatory_id', 'start_time', 'end_time', 'reason'];
  const validateBlockout = async (req, row) => {
    row.start_time = normalizeDateTime(row.start_time, 'start_time');
    row.end_time = normalizeDateTime(row.end_time, 'end_time');
    if (row.end_time <= row.start_time) throw new HttpError(400, 'end_time must be after start_time');
    if (row.provider_id) await findOr404(db, 'providers', row.provider_id, req.user.practice_id, 'Provider');
    if (row.operatory_id) await findOr404(db, 'operatories', row.operatory_id, req.user.practice_id, 'Operatory');
  };
  r.get('/blockouts', requirePermission('schedule:read'), async (req, res) => {
    const from = req.query.from || '0000-00-00';
    const to = req.query.to || '9999-12-31';
    res.json(await db.all('SELECT * FROM blockouts WHERE practice_id = ? AND start_time < ? AND end_time > ? ORDER BY start_time', req.user.practice_id, `${to} 24:00`, `${from} 00:00`));
  });
  r.post('/blockouts', requirePermission('schedule:write'), async (req, res) => {
    const row = pick(req.body, BLOCK_FIELDS);
    requireFields(row, ['start_time', 'end_time', 'reason']);
    await validateBlockout(req, row);
    // Repeat weekly for N weeks (e.g. lunch every Tuesday).
    const repeat = Math.min(Math.max(Number(req.body.repeat_weeks) || 1, 1), 52);
    const ids = await db.tx(() => mapSeq(Array.from({ length: repeat }, (_, i) => i), async (i) => {
      const shift = (v) => `${new Date(Date.parse(`${v.slice(0, 10)}T12:00:00Z`) + i * 7 * 86400_000).toISOString().slice(0, 10)} ${v.slice(11)}`;
      return await insert(db, 'blockouts', { ...row, start_time: shift(row.start_time), end_time: shift(row.end_time), practice_id: req.user.practice_id, created_by: req.user.id });
    }));
    await audit(db, req, 'blockout.create', 'blockouts', ids[0], { count: ids.length });
    changed(req, row.start_time);
    res.status(201).json(await db.all(`SELECT * FROM blockouts WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids));
  });
  r.put('/blockouts/:bid', requirePermission('schedule:write'), async (req, res) => {
    const existing = await findOr404(db, 'blockouts', req.params.bid, req.user.practice_id, 'Blockout');
    const row = { ...pick(existing, BLOCK_FIELDS), ...pick(req.body, BLOCK_FIELDS) };
    await validateBlockout(req, row);
    await update(db, 'blockouts', existing.id, req.user.practice_id, row);
    await audit(db, req, 'blockout.update', 'blockouts', existing.id);
    changed(req, existing.start_time, row.start_time);
    res.json(await db.get('SELECT * FROM blockouts WHERE id = ?', existing.id));
  });
  r.delete('/blockouts/:bid', requirePermission('schedule:write'), async (req, res) => {
    const existing = await findOr404(db, 'blockouts', req.params.bid, req.user.practice_id, 'Blockout');
    await db.run('DELETE FROM blockouts WHERE id = ?', existing.id);
    await audit(db, req, 'blockout.delete', 'blockouts', existing.id);
    changed(req, existing.start_time);
    res.json({ ok: true });
  });

  r.get('/events', eventStream);

  r.get('/recalls', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const before = req.query.before || (await practiceNow(db, pid)).slice(0, 10);
    const statuses = String(req.query.status || 'due,contacted').split(',');
    res.json(await db.all(
      `SELECT r.*, p.first_name, p.last_name, p.phone, p.email FROM recalls r JOIN patients p ON p.id = r.patient_id
       WHERE r.practice_id = ? AND r.due_date <= ? AND r.status IN (${statuses.map(() => '?').join(',')}) AND p.status = 'active'
       ORDER BY r.due_date`,
      pid, before, ...statuses,
    ));
  });

  r.put('/recalls/:id', requirePermission('schedule:write'), async (req, res) => {
    const existing = await findOr404(db, 'recalls', req.params.id, req.user.practice_id, 'Recall');
    const row = pick(req.body, ['status', 'due_date', 'interval_months', 'notes']);
    requireOneOf(row.status, ['due', 'scheduled', 'contacted', 'completed', 'inactive'], 'status');
    if (row.status === 'contacted') row.last_contacted_at = new Date().toISOString();
    await update(db, 'recalls', existing.id, req.user.practice_id, row);
    await audit(db, req, 'recall.update', 'recalls', existing.id);
    res.json(await db.get('SELECT * FROM recalls WHERE id = ?', existing.id));
  });

  return r;
}

