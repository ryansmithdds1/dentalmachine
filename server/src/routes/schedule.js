import { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, normalizeDateTime, practiceNow, mapSeq } from '../util.js';
import { hoursFor, providerHours, providerHoursFor, providerHoursOn, validateHours } from '../hours.js';
import { publish, eventStream } from '../events.js';
import { completeProcedure } from '../services.js';

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

async function findConflicts(db, practiceId, { start_time, end_time, provider_id, operatory_id, patient_id }, excludeId = 0) {
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
  const provider = await findOr404(db, 'providers', row.provider_id, practiceId, 'Provider');
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
    // Nobody is booked outside their hours — the provider's own (part-time hygienists, visiting
    // specialists) or else the office's — without a deliberate override.
    const date = row.start_time.slice(0, 10);
    const practice = await db.get('SELECT office_hours FROM practices WHERE id = ?', practiceId);
    const ranges = await providerHoursOn(db, practice, provider, date);
    const inside = ranges.some(([o, c]) => row.start_time.slice(11) >= o && row.end_time.slice(11) <= c);
    if (!inside) {
      const why = ranges.exception ? `${provider.name} ${ranges.length ? 'has different hours' : 'is off'} that day (${ranges.exception})`
        : providerHours(provider) ? `${provider.name} isn't scheduled to work then` : 'That time is outside office hours';
      throw new HttpError(409, why, { outside_hours: [...ranges], can_override: true });
    }
  }
}

// Recall visits: which recall a booked appointment takes care of. The visit's procedures decide
// (prophy, perio maintenance); a hygiene visit with none on it covers the patient's due recalls.
const RECALL_FOR_CODE = { D1110: 'prophy', D1120: 'prophy', D4910: 'perio_maint', D4346: 'prophy' };
export async function linkRecalls(db, practiceId, apptId) {
  const appt = await db.get('SELECT a.*, pv.type AS provider_type FROM appointments a JOIN providers pv ON pv.id = a.provider_id WHERE a.id = ?', apptId);
  if (!appt) return;
  const codes = (await db.all("SELECT code FROM procedures WHERE appointment_id = ? AND status = 'planned'", apptId)).map((p) => p.code);
  const types = [...new Set(codes.map((c) => RECALL_FOR_CODE[c]).filter(Boolean))];
  if (!types.length && appt.provider_type !== 'hygienist') return;
  await db.run(
    `UPDATE recalls SET status = 'scheduled', appointment_id = ? WHERE practice_id = ? AND patient_id = ? AND status IN ('due','contacted')${types.length ? ` AND type IN (${types.map(() => '?').join(',')})` : ''}`,
    apptId, practiceId, appt.patient_id, ...types,
  );
}
// A cancelled or missed visit gives back what it held: its planned procedures go back to the
// unscheduled-treatment list, and the recalls it covered are due again.
export async function releaseAppointment(db, apptId) {
  await db.run("UPDATE procedures SET appointment_id = NULL WHERE appointment_id = ? AND status = 'planned'", apptId);
  await db.run("UPDATE recalls SET status = 'due', appointment_id = NULL WHERE appointment_id = ? AND status = 'scheduled'", apptId);
}

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
export const addMinutes = (dateTime, minutes) => `${dateTime.slice(0, 10)} ${fromMin(toMin(dateTime.slice(11, 16)) + minutes)}`;

// Free start times for a provider on a day, on a grid (minutes) within office hours, avoiding appointments and blockouts.
export async function openSlots(db, practiceId, providerId, date, { duration = 60, step = 10, after = null, open = null, close = null } = {}) {
  const practice = await db.get('SELECT office_hours FROM practices WHERE id = ?', practiceId);
  const provider = await db.get('SELECT id, working_hours FROM providers WHERE id = ?', providerId);
  const ranges = open && close ? [[open, close]] : await providerHoursOn(db, practice, provider, date);
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

// ---- Recurring visits ----
// repeat: { every: 1-12, unit: 'week' | 'month', count: 2-52 }
export function parseRepeat(repeat) {
  if (!repeat) return null;
  const every = Number(repeat.every || 1);
  const count = Number(repeat.count);
  if (!['week', 'month'].includes(repeat.unit)) throw new HttpError(400, "repeat.unit must be 'week' or 'month'");
  if (!Number.isInteger(every) || every < 1 || every > 12) throw new HttpError(400, 'repeat.every must be 1-12');
  if (!Number.isInteger(count) || count < 2 || count > 52) throw new HttpError(400, 'repeat.count must be 2-52 visits');
  return { every, unit: repeat.unit, count };
}
// The i-th visit: weekly steps, or the same day of the month (clamped to the month's last day).
export function shiftVisit(dateTime, { every, unit }, i) {
  const d = new Date(`${dateTime.slice(0, 10)}T12:00:00Z`);
  if (unit === 'week') d.setUTCDate(d.getUTCDate() + 7 * every * i);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + every * i);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return `${d.toISOString().slice(0, 10)} ${dateTime.slice(11, 16)}`;
}
const stamp = (dt) => Date.parse(`${dt.slice(0, 10)}T${dt.slice(11, 16)}:00Z`);
const minutesBetween = (a, b) => Math.round((stamp(b) - stamp(a)) / 60_000);
const shiftMinutes = (dt, minutes) => new Date(stamp(dt) + minutes * 60_000).toISOString().slice(0, 16).replace('T', ' ');

const datesBetween = (from, to) => {
  const out = [];
  for (let d = from; d <= to && out.length < 62; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};

export default function scheduleRoutes({ db }) {
  const r = Router();
  const FIELDS = ['patient_id', 'provider_id', 'operatory_id', 'start_time', 'end_time', 'status', 'reason', 'notes', 'appointment_type_id', 'asap'];
  const seriesInfo = async (appt) => {
    const s = await db.get('SELECT id, every, unit, count FROM appointment_series WHERE id = ?', appt.series_id);
    const visits = await db.all('SELECT id, start_time, status FROM appointments WHERE series_id = ? ORDER BY start_time', appt.series_id);
    const active = visits.filter((v) => !['cancelled', 'no_show'].includes(v.status));
    return { ...s, position: active.findIndex((v) => v.id === appt.id) + 1, total: active.length, remaining: active.filter((v) => v.start_time > appt.start_time).length };
  };
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
    if (row.series_id) row.series = await seriesInfo(row);
    res.json(row);
  });

  // Appointment types can pre-load their procedures (e.g. exam + prophy + BWX) so scheduled production is known.
  const addTypeProcedures = async (req, type, apptId, row) => {
    if (!type?.procedure_codes) return;
    for (const code of JSON.parse(type.procedure_codes)) {
      const pc = await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ? AND active = 1', req.user.practice_id, code);
      if (!pc || pc.requires_tooth) continue;
      await insert(db, 'procedures', {
        practice_id: req.user.practice_id, patient_id: row.patient_id, appointment_id: apptId, provider_id: row.provider_id,
        code_id: pc.id, code: pc.code, description: pc.description, category: pc.category, fee: pc.fee,
      });
    }
  };

  r.post('/appointments', requirePermission('schedule:write'), async (req, res) => {
    const row = pick(req.body, FIELDS);
    const type = row.appointment_type_id ? await findOr404(db, 'appointment_types', row.appointment_type_id, req.user.practice_id, 'Appointment type') : null;
    if (type && row.start_time && !row.end_time) row.end_time = addMinutes(normalizeDateTime(row.start_time, 'start_time'), type.duration);
    if (type && !row.reason) row.reason = type.name;
    requireFields(row, ['patient_id', 'provider_id', 'start_time', 'end_time']);
    const repeat = parseRepeat(req.body.repeat);
    await validateAppt(db, req.user.practice_id, row, { overrideBlockout: !!req.body.override_blockout });
    const withTypeProcs = req.body.add_type_procedures !== false && !(req.body.procedure_ids || []).length;
    let series = null;
    const id = await db.tx(async () => {
      if (repeat) {
        const seriesId = await insert(db, 'appointment_series', { practice_id: req.user.practice_id, patient_id: row.patient_id, ...repeat, created_by: req.user.id });
        row.series_id = seriesId;
        series = { id: seriesId, ...repeat, created: 1, skipped: [] };
      }
      const newId = await insert(db, 'appointments', { ...row, practice_id: req.user.practice_id });
      if (withTypeProcs) await addTypeProcedures(req, type, newId, row);
      // Later visits in the series: book what's free and report what isn't.
      for (let i = 1; repeat && i < repeat.count; i++) {
        const next = { ...row, start_time: shiftVisit(row.start_time, repeat, i), end_time: shiftVisit(row.end_time, repeat, i) };
        try {
          await validateAppt(db, req.user.practice_id, next);
          const occId = await insert(db, 'appointments', { ...next, practice_id: req.user.practice_id, status: 'scheduled' });
          if (req.body.add_type_procedures !== false) await addTypeProcedures(req, type, occId, next);
          series.created++;
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          series.skipped.push({ start_time: next.start_time, reason: err.message });
        }
      }
      return newId;
    });
    // Attach planned procedures the user chose to schedule in this visit.
    for (const procId of req.body.procedure_ids || []) {
      await db.run("UPDATE procedures SET appointment_id = ? WHERE id = ? AND practice_id = ? AND patient_id = ? AND status = 'planned'", id, Number(procId), req.user.practice_id, row.patient_id);
    }
    await linkRecalls(db, req.user.practice_id, id);
    await audit(db, req, 'appointment.create', 'appointments', id);
    changed(req, row.start_time, ...(series ? Array.from({ length: repeat.count }, (_, i) => shiftVisit(row.start_time, repeat, i)) : []));
    res.status(201).json({ ...(await db.get(`${SELECT} WHERE a.id = ?`, id)), ...(series ? { series } : {}) });
  });

  r.put('/appointments/:id', requirePermission('schedule:write'), async (req, res) => {
    const existing = await findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    const changes = pick(req.body, FIELDS);
    const merged = { ...existing, ...changes };
    if (!['cancelled', 'no_show'].includes(merged.status)) await validateAppt(db, req.user.practice_id, merged, { overrideBlockout: !!req.body.override_blockout });
    else requireOneOf(merged.status, STATUSES, 'status');
    const row = pick(merged, FIELDS);
    const inactive = ['cancelled', 'no_show'];
    // A moved appointment needs a fresh reminder and confirmation.
    if (row.start_time !== existing.start_time) Object.assign(row, { reminder_sent_at: null, confirmed_at: null });
    await update(db, 'appointments', existing.id, req.user.practice_id, row);
    // Keep attached procedures with the provider the patient is now seeing.
    if (Number(row.provider_id) !== existing.provider_id) await db.run("UPDATE procedures SET provider_id = ? WHERE appointment_id = ? AND status = 'planned'", row.provider_id, existing.id);
    // Cancelling from the edit form releases procedures and recalls, same as the status buttons.
    if (inactive.includes(row.status) && !inactive.includes(existing.status)) await releaseAppointment(db, existing.id);
    await audit(db, req, 'appointment.update', 'appointments', existing.id, { fields: Object.keys(changes) });
    // "This and following": apply the same shift (and provider/chair/length changes) to later visits in the series.
    let seriesUpdate = null;
    if (req.body.scope === 'following' && existing.series_id) {
      const shift = minutesBetween(existing.start_time, row.start_time);
      const length = minutesBetween(row.start_time, row.end_time);
      const later = await db.all(
        `SELECT * FROM appointments WHERE series_id = ? AND practice_id = ? AND id != ? AND start_time > ? AND status IN ('scheduled','confirmed') ORDER BY start_time`,
        existing.series_id, req.user.practice_id, existing.id, existing.start_time,
      );
      seriesUpdate = { updated: 0, skipped: [] };
      for (const occ of later) {
        const start = shiftMinutes(occ.start_time, shift);
        const next = { ...occ, provider_id: row.provider_id, operatory_id: row.operatory_id, appointment_type_id: row.appointment_type_id, reason: row.reason, start_time: start, end_time: shiftMinutes(start, length) };
        try {
          await validateAppt(db, req.user.practice_id, next);
          const moved = next.start_time !== occ.start_time;
          await update(db, 'appointments', occ.id, req.user.practice_id, { ...pick(next, ['provider_id', 'operatory_id', 'appointment_type_id', 'reason', 'start_time', 'end_time']), ...(moved ? { reminder_sent_at: null, confirmed_at: null, status: 'scheduled' } : {}) });
          if (Number(next.provider_id) !== occ.provider_id) await db.run("UPDATE procedures SET provider_id = ? WHERE appointment_id = ? AND status = 'planned'", next.provider_id, occ.id);
          seriesUpdate.updated++;
          changed(req, occ.start_time, next.start_time);
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          seriesUpdate.skipped.push({ id: occ.id, start_time: next.start_time, reason: err.message });
        }
      }
    }
    changed(req, existing.start_time, row.start_time);
    res.json({ ...(await db.get(`${SELECT} WHERE a.id = ?`, existing.id)), ...(seriesUpdate ? { series_update: seriesUpdate } : {}) });
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
    if (status === 'cancelled' || status === 'no_show') await releaseAppointment(db, existing.id);
    // Finishing the visit also completes the work planned for it (posting the charges), when the
    // person has clinical rights and asked for it.
    let completedProcedures = 0;
    if (status === 'completed' && req.body.complete_procedures && can(req.user, 'clinical:write')) {
      const planned = await db.all("SELECT * FROM procedures WHERE appointment_id = ? AND status = 'planned' ORDER BY id", existing.id);
      for (const p of planned) {
        await completeProcedure(db, req.user, p, { providerId: p.provider_id || existing.provider_id, appointmentId: existing.id });
        completedProcedures++;
      }
    }
    if (status === 'cancelled' && req.body.scope === 'following' && existing.series_id) {
      const later = await db.all("SELECT id, start_time FROM appointments WHERE series_id = ? AND practice_id = ? AND start_time > ? AND status IN ('scheduled','confirmed')", existing.series_id, req.user.practice_id, existing.start_time);
      for (const occ of later) {
        await db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", occ.id);
        await db.run("UPDATE recalls SET status = 'due', appointment_id = NULL WHERE appointment_id = ? AND status = 'scheduled'", occ.id);
        // Their pre-loaded type procedures are only placeholders; drop them rather than leave "planned" work behind.
        await db.run("DELETE FROM procedures WHERE appointment_id = ? AND status = 'planned' AND treatment_plan_id IS NULL", occ.id);
      }
      changed(req, ...later.map((o) => o.start_time));
    }
    await audit(db, req, 'appointment.status', 'appointments', existing.id, { from: existing.status, to: status, ...(completedProcedures ? { completed_procedures: completedProcedures } : {}) });
    changed(req, existing.start_time);
    res.json({ ...(await db.get(`${SELECT} WHERE a.id = ?`, existing.id)), completed_procedures: completedProcedures });
  });

  // ---- Provider time off and one-off hours ----
  r.get('/providers/:pid/exceptions', requirePermission('schedule:read'), async (req, res) => {
    const provider = await findOr404(db, 'providers', req.params.pid, req.user.practice_id, 'Provider');
    const from = req.query.from || (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    res.json(await db.all('SELECT * FROM provider_exceptions WHERE provider_id = ? AND date >= ? ORDER BY date', provider.id, from));
  });

  // A day or a range (vacation): off entirely, or working different hours.
  r.post('/providers/:pid/exceptions', requirePermission('schedule:write'), async (req, res) => {
    const provider = await findOr404(db, 'providers', req.params.pid, req.user.practice_id, 'Provider');
    const { from, to = from, off = true, hours = [], reason = null } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || to < from) throw new HttpError(400, 'from/to must be YYYY-MM-DD');
    const days = datesBetween(from, to);
    if (days.length > 366) throw new HttpError(400, 'Choose a range of a year or less');
    const ranges = off ? [] : validateHours({ 0: hours })[0];
    if (!off && !ranges.length) throw new HttpError(400, 'Give the hours they will work, or mark them off');
    await db.tx(async () => {
      for (const d of days) {
        await db.run(
          'INSERT INTO provider_exceptions (practice_id, provider_id, date, hours, reason, created_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (provider_id, date) DO UPDATE SET hours = excluded.hours, reason = excluded.reason',
          req.user.practice_id, provider.id, d, JSON.stringify(ranges), reason ? String(reason).slice(0, 120) : null, req.user.id,
        );
      }
    });
    // Tell the front desk about visits already booked in that time.
    const affected = await db.all(
      `SELECT a.id, a.start_time, a.end_time, p.first_name, p.last_name FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.provider_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ${INACTIVE} ORDER BY a.start_time`,
      provider.id, `${from} 00:00`, `${to} 24:00`,
    );
    const conflicts = affected.filter((a) => !ranges.some(([o, c]) => a.start_time.slice(11) >= o && a.end_time.slice(11) <= c));
    await audit(db, req, 'provider.exception', 'providers', provider.id, { from, to, off, reason });
    changed(req, ...days);
    res.status(201).json({ days: days.length, conflicts });
  });

  r.delete('/provider-exceptions/:eid', requirePermission('schedule:write'), async (req, res) => {
    const ex = await findOr404(db, 'provider_exceptions', req.params.eid, req.user.practice_id, 'Exception');
    await db.run('DELETE FROM provider_exceptions WHERE id = ?', ex.id);
    await audit(db, req, 'provider.exception_removed', 'providers', ex.provider_id, { date: ex.date });
    changed(req, ex.date);
    res.json({ ok: true });
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
    // Providers whose day differs from the office's: their own weekly hours, or a one-off exception.
    const exceptions = await db.all('SELECT provider_id, date, hours, reason FROM provider_exceptions WHERE practice_id = ? AND date BETWEEN ? AND ?', pid, from, to);
    const custom = (await db.all('SELECT id, working_hours FROM providers WHERE practice_id = ? AND active = 1', pid))
      .filter((pv) => pv.working_hours || exceptions.some((e) => e.provider_id === pv.id));
    const exceptionFor = (pv, d) => exceptions.find((e) => e.provider_id === pv.id && e.date === d);
    for (const a of appointments) if (!['cancelled', 'no_show'].includes(a.status)) production[a.start_time.slice(0, 10)] += a.production;
    res.json({
      from, to, daily_goal: practice.daily_goal,
      hours: Object.fromEntries(dates.map((d) => [d, hoursFor(practice, d)])),
      provider_hours: Object.fromEntries(custom.map((pv) => [pv.id, Object.fromEntries(dates.map((d) => {
        const ex = exceptionFor(pv, d);
        return [d, ex ? JSON.parse(ex.hours) : providerHoursFor(practice, pv, d)];
      }))])),
      provider_exceptions: exceptions.map((e) => ({ provider_id: e.provider_id, date: e.date, off: JSON.parse(e.hours).length === 0, reason: e.reason })),
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

