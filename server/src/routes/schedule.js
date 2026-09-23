import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, normalizeDateTime, practiceNow } from '../util.js';

export const STATUSES = ['scheduled', 'confirmed', 'checked_in', 'in_chair', 'completed', 'cancelled', 'no_show'];
export const INACTIVE = "('cancelled','no_show')";

const SELECT = `SELECT a.*, p.first_name, p.last_name, p.preferred_name, p.phone, p.medical_alerts,
  pr.name AS provider_name, pr.color AS provider_color, o.name AS operatory_name
  FROM appointments a
  JOIN patients p ON p.id = a.patient_id
  JOIN providers pr ON pr.id = a.provider_id
  LEFT JOIN operatories o ON o.id = a.operatory_id`;

function findConflicts(db, practiceId, { start_time, end_time, provider_id, operatory_id, patient_id }, excludeId = 0) {
  return db.all(
    `SELECT a.id, a.start_time, a.end_time, a.provider_id, a.operatory_id, a.patient_id FROM appointments a
     WHERE a.practice_id = ? AND a.id != ? AND a.status NOT IN ${INACTIVE}
       AND a.start_time < ? AND a.end_time > ?
       AND (a.provider_id = ? OR (a.operatory_id IS NOT NULL AND a.operatory_id = ?) OR a.patient_id = ?)`,
    practiceId, excludeId, end_time, start_time, provider_id, operatory_id ?? -1, patient_id,
  );
}

export function validateAppt(db, practiceId, row) {
  row.start_time = normalizeDateTime(row.start_time, 'start_time');
  row.end_time = normalizeDateTime(row.end_time, 'end_time');
  if (row.end_time <= row.start_time) throw new HttpError(400, 'end_time must be after start_time');
  if (row.start_time.slice(0, 10) !== row.end_time.slice(0, 10)) throw new HttpError(400, 'Appointments must start and end on the same day');
  requireOneOf(row.status, STATUSES, 'status');
  findOr404(db, 'patients', row.patient_id, practiceId, 'Patient');
  findOr404(db, 'providers', row.provider_id, practiceId, 'Provider');
  if (row.operatory_id) findOr404(db, 'operatories', row.operatory_id, practiceId, 'Operatory');
  const conflicts = findConflicts(db, practiceId, row, row.id);
  if (conflicts.length) {
    const kinds = new Set();
    for (const c of conflicts) {
      if (c.provider_id === Number(row.provider_id)) kinds.add('provider');
      if (row.operatory_id && c.operatory_id === Number(row.operatory_id)) kinds.add('operatory');
      if (c.patient_id === Number(row.patient_id)) kinds.add('patient');
    }
    throw new HttpError(409, `Scheduling conflict: ${[...kinds].join(', ')} already booked`, { conflicts });
  }
}

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

// Free start times for a provider on a day, on a grid (minutes) within opening hours.
export function openSlots(db, practiceId, providerId, date, { duration = 60, open = '08:00', close = '17:00', step = 10, after = null } = {}) {
  const busy = db.all(
    `SELECT start_time, end_time FROM appointments WHERE practice_id = ? AND provider_id = ? AND status NOT IN ${INACTIVE}
     AND start_time >= ? AND start_time < ? ORDER BY start_time`,
    practiceId, providerId, `${date} 00:00`, `${date} 24:00`,
  ).map((a) => [toMin(a.start_time.slice(11)), toMin(a.end_time.slice(11))]);
  const slots = [];
  for (let t = toMin(open); t + duration <= toMin(close); t += step) {
    const slot = `${date} ${fromMin(t)}`;
    if (after && slot <= after) continue;
    if (!busy.some(([s, e]) => t < e && t + duration > s)) slots.push(slot);
  }
  return slots;
}

export default function scheduleRoutes({ db }) {
  const r = Router();
  const FIELDS = ['patient_id', 'provider_id', 'operatory_id', 'start_time', 'end_time', 'status', 'reason', 'notes'];

  r.get('/appointments', requirePermission('schedule:read'), (req, res) => {
    const pid = req.user.practice_id;
    const from = req.query.from || req.query.date || practiceNow(db, pid).slice(0, 10);
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
    res.json(db.all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY a.start_time`, ...params));
  });

  r.get('/appointments/:id', requirePermission('schedule:read'), (req, res) => {
    const row = db.get(`${SELECT} WHERE a.id = ? AND a.practice_id = ?`, Number(req.params.id), req.user.practice_id);
    if (!row) throw new HttpError(404, 'Appointment not found');
    row.procedures = db.all('SELECT * FROM procedures WHERE appointment_id = ? ORDER BY id', row.id);
    res.json(row);
  });

  r.post('/appointments', requirePermission('schedule:write'), (req, res) => {
    const row = pick(req.body, FIELDS);
    requireFields(row, ['patient_id', 'provider_id', 'start_time', 'end_time']);
    validateAppt(db, req.user.practice_id, row);
    const id = insert(db, 'appointments', { ...row, practice_id: req.user.practice_id });
    // Attach planned procedures the user chose to schedule in this visit.
    for (const procId of req.body.procedure_ids || []) {
      db.run("UPDATE procedures SET appointment_id = ? WHERE id = ? AND practice_id = ? AND patient_id = ? AND status = 'planned'", id, Number(procId), req.user.practice_id, row.patient_id);
    }
    db.run("UPDATE recalls SET status = 'scheduled' WHERE practice_id = ? AND patient_id = ? AND status IN ('due','contacted')", req.user.practice_id, row.patient_id);
    audit(db, req, 'appointment.create', 'appointments', id);
    res.status(201).json(db.get(`${SELECT} WHERE a.id = ?`, id));
  });

  r.put('/appointments/:id', requirePermission('schedule:write'), (req, res) => {
    const existing = findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    const changes = pick(req.body, FIELDS);
    const merged = { ...existing, ...changes };
    if (!['cancelled', 'no_show'].includes(merged.status)) validateAppt(db, req.user.practice_id, merged);
    else requireOneOf(merged.status, STATUSES, 'status');
    const row = pick(merged, FIELDS);
    // A moved appointment needs a fresh reminder and confirmation.
    if (row.start_time !== existing.start_time) Object.assign(row, { reminder_sent_at: null, confirmed_at: null });
    update(db, 'appointments', existing.id, req.user.practice_id, row);
    audit(db, req, 'appointment.update', 'appointments', existing.id, { fields: Object.keys(changes) });
    res.json(db.get(`${SELECT} WHERE a.id = ?`, existing.id));
  });

  r.patch('/appointments/:id/status', requirePermission('schedule:write'), (req, res) => {
    const existing = findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    const { status } = req.body || {};
    requireFields({ status }, ['status']);
    requireOneOf(status, STATUSES, 'status');
    // Reactivating a cancelled slot must not double-book.
    if (['cancelled', 'no_show'].includes(existing.status) && !['cancelled', 'no_show'].includes(status)) {
      validateAppt(db, req.user.practice_id, { ...existing, status });
    }
    db.run(
      "UPDATE appointments SET status = ?, confirmed_at = CASE WHEN ? = 'confirmed' THEN COALESCE(confirmed_at, datetime('now')) ELSE confirmed_at END WHERE id = ?",
      status, status, existing.id,
    );
    if (status === 'cancelled' || status === 'no_show') {
      db.run("UPDATE procedures SET appointment_id = NULL WHERE appointment_id = ? AND status = 'planned'", existing.id);
    }
    audit(db, req, 'appointment.status', 'appointments', existing.id, { from: existing.status, to: status });
    res.json(db.get(`${SELECT} WHERE a.id = ?`, existing.id));
  });

  // Free slots for a provider on a day, on a 10-minute grid within opening hours.
  r.get('/availability', requirePermission('schedule:read'), (req, res) => {
    const pid = req.user.practice_id;
    const { date, provider_id } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new HttpError(400, 'date must be YYYY-MM-DD');
    findOr404(db, 'providers', provider_id, pid, 'Provider');
    const duration = Math.max(10, Number(req.query.duration) || 60);
    const open = req.query.open || '08:00';
    const close = req.query.close || '17:00';
    const slots = openSlots(db, pid, Number(provider_id), date, { duration, open, close });
    res.json({ date, provider_id: Number(provider_id), duration, slots });
  });

  r.get('/recalls', requirePermission('schedule:read'), (req, res) => {
    const pid = req.user.practice_id;
    const before = req.query.before || practiceNow(db, pid).slice(0, 10);
    const statuses = String(req.query.status || 'due,contacted').split(',');
    res.json(db.all(
      `SELECT r.*, p.first_name, p.last_name, p.phone, p.email FROM recalls r JOIN patients p ON p.id = r.patient_id
       WHERE r.practice_id = ? AND r.due_date <= ? AND r.status IN (${statuses.map(() => '?').join(',')}) AND p.status = 'active'
       ORDER BY r.due_date`,
      pid, before, ...statuses,
    ));
  });

  r.put('/recalls/:id', requirePermission('schedule:write'), (req, res) => {
    const existing = findOr404(db, 'recalls', req.params.id, req.user.practice_id, 'Recall');
    const row = pick(req.body, ['status', 'due_date', 'interval_months', 'notes']);
    requireOneOf(row.status, ['due', 'scheduled', 'contacted', 'completed', 'inactive'], 'status');
    if (row.status === 'contacted') row.last_contacted_at = new Date().toISOString();
    update(db, 'recalls', existing.id, req.user.practice_id, row);
    audit(db, req, 'recall.update', 'recalls', existing.id);
    res.json(db.get('SELECT * FROM recalls WHERE id = ?', existing.id));
  });

  return r;
}

