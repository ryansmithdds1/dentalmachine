import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, practiceNow } from '../util.js';
import { openSlots, addMinutes, INACTIVE } from './schedule.js';
import { typeDuration } from '../patterns.js';
import { canSeePatient } from '../officeaccess.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

// Who a patient's next hygiene visit is with, when nobody said: their own hygienist, else whoever saw them for
// their last hygiene visit, else the office's first hygienist, else their dentist.
async function hygienistFor(db, pid, patient) {
  const active = async (id) => (id ? (await db.get('SELECT id FROM providers WHERE id = ? AND practice_id = ? AND active = 1', id, pid))?.id : null);
  return (await active(patient.primary_hygienist_id))
    ?? (await db.get(
      `SELECT a.provider_id AS id FROM appointments a JOIN providers pv ON pv.id = a.provider_id
       WHERE a.practice_id = ? AND a.patient_id = ? AND pv.type = 'hygienist' AND pv.active = 1 AND a.status NOT IN ${INACTIVE}
       ORDER BY a.start_time DESC LIMIT 1`, pid, patient.id,
    ))?.id
    ?? (await db.get("SELECT id FROM providers WHERE practice_id = ? AND type = 'hygienist' AND active = 1 ORDER BY id LIMIT 1", pid))?.id
    ?? (await active(patient.primary_provider_id));
}

// A chair for the visit: the one this provider used last, if it's free then.
async function chairFor(db, pid, providerId, start, end) {
  const last = await db.get(
    `SELECT a.operatory_id AS id FROM appointments a JOIN operatories o ON o.id = a.operatory_id
     WHERE a.practice_id = ? AND a.provider_id = ? AND o.active = 1 AND a.status NOT IN ${INACTIVE} ORDER BY a.start_time DESC LIMIT 1`, pid, providerId,
  );
  if (!last) return null;
  const busy = await db.get(
    `SELECT 1 AS x FROM appointments WHERE practice_id = ? AND operatory_id = ? AND status NOT IN ${INACTIVE} AND start_time < ? AND end_time > ?`,
    pid, last.id, end, start,
  ) || await db.get('SELECT 1 AS x FROM blockouts WHERE practice_id = ? AND operatory_id = ? AND start_time < ? AND end_time > ?', pid, last.id, end, start);
  return busy ? null : last.id;
}

// Suggested times for a patient's next visit (#16: book the next hygiene visit at checkout). Read-only: it
// suggests, the booking itself goes through POST /appointments and its usual checks.
// GET /patients/:id/next-slots?appointment_type_id=&provider_id=&from=YYYY-MM-DD&count=3
// The first open time on each of the next `count` working days on or after `from` (never before now).
export default function nextSlotRoutes({ db }) {
  const r = Router();
  r.get('/patients/:id/next-slots', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const patient = await findOr404(db, 'patients', req.params.id, pid, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const type = req.query.appointment_type_id ? await findOr404(db, 'appointment_types', req.query.appointment_type_id, pid, 'Appointment type') : null;
    const providerId = req.query.provider_id
      ? (await findOr404(db, 'providers', req.query.provider_id, pid, 'Provider')).id
      : await hygienistFor(db, pid, patient);
    if (!providerId) throw new HttpError(400, 'Add a provider first: there is nobody to book with');
    if (req.query.from != null && !DATE.test(String(req.query.from))) throw new HttpError(400, 'from must be YYYY-MM-DD');
    const count = Math.min(10, Math.max(1, Number(req.query.count) || 3));
    const duration = typeDuration(type, providerId) || 60;
    const now = (await practiceNow(db, pid)).slice(0, 16).replace('T', ' ');
    const today = now.slice(0, 10);
    const from = req.query.from && req.query.from > today ? String(req.query.from) : today;
    // The patient can't be in two places either.
    const theirs = await db.all(
      `SELECT start_time, end_time FROM appointments WHERE practice_id = ? AND patient_id = ? AND status NOT IN ${INACTIVE} AND start_time >= ?`,
      pid, patient.id, `${from} 00:00`,
    );
    const slots = [];
    // Up to four months ahead: far enough for a recall that's due soon, bounded so a fully booked
    // provider doesn't turn this into a long scan.
    for (let i = 0; i < 120 && slots.length < count; i++) {
      const date = addDays(from, i);
      const open = await openSlots(db, pid, providerId, date, { duration, step: 10, after: date === today ? now : null, typeId: type?.id ?? null, locationId: req.location_id || null });
      const start = open.find((s) => {
        const end = addMinutes(s, duration);
        return !theirs.some((a) => a.start_time < end && a.end_time > s);
      });
      if (!start) continue;
      const end = addMinutes(start, duration);
      slots.push({ start_time: start, end_time: end, operatory_id: await chairFor(db, pid, providerId, start, end) });
    }
    const provider = await db.get('SELECT id, name, type FROM providers WHERE id = ?', providerId);
    res.json({ provider, appointment_type_id: type?.id ?? null, duration, from, slots });
  });
  return r;
}
