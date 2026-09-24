import { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { audit, findOr404, insert, update, isRealDate, practiceNow } from '../util.js';
import { currentActor } from '../actor.js';
import { publish } from '../events.js';
import { appointmentScope, canSeePatient, checkOffice } from '../officeaccess.js';
import { noteOut } from '../cards.js';

// The doctor's notes to the front desk on the schedule (DN1; docs/workflows/specs/PP-DN-S8-S6.md): a bubble on a
// visit ("book the crown here next", "needs 90 minutes") or on an empty slot ("I have time 2–3 — fit in an
// emergency"). Everyone on the schedule sees it straight away (live event + chime); the front desk acknowledges
// it and turns it into a booking or a task in one click. Notes are never deleted: done or withdrawn.
//   GET  /schedule-notes?from=&to=&status=open     the notes for those days (open + acknowledged unless status=all)
//   POST /schedule-notes                           { appointment_id } or { date, start_time, end_time, provider_id?, operatory_id? }, body, client_key
//   POST /schedule-notes/:id/ack                   "Got it"
//   POST /schedule-notes/:id/convert               { kind: 'task' } makes the task; { kind: 'booking' } returns what to book with
//                                                  (the note is closed when that booking is made — linkNoteBookings)
//   POST /schedule-notes/:id/done                  handled another way
//   POST /schedule-notes/:id/withdraw              the author (or an administrator) takes it back
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const clean = (v, max) => (v == null ? null : String(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) || null);
const utcNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const SELECT = `SELECT n.*, u.name AS by_name, k.name AS acked_by_name FROM schedule_notes n
  LEFT JOIN users u ON u.id = n.created_by LEFT JOIN users k ON k.id = n.acked_by`;

// A booking made after someone pressed "Book it" on a note closes that note: for a visit note, the same patient's
// next booking; for a slot note, a visit booked into that slot (same chair / provider when the note named one).
// Called by POST /appointments (schedule.js) with the new visit. Looks back two hours.
export async function linkNoteBookings(db, req, appt) {
  const cutoff = new Date(Date.now() - 2 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  const date = appt.start_time.slice(0, 10);
  const notes = await db.all(
    `SELECT * FROM schedule_notes WHERE practice_id = ? AND status IN ('open','acknowledged') AND booking_started_at IS NOT NULL AND booking_started_at >= ?
       AND ((kind = 'visit' AND patient_id = ?) OR (kind = 'slot' AND note_date = ? AND start_time < ? AND end_time > ?))`,
    req.user.practice_id, cutoff, appt.patient_id, date, appt.end_time.slice(11, 16), appt.start_time.slice(11, 16),
  );
  for (const n of notes) {
    if (n.kind === 'slot' && ((n.operatory_id && n.operatory_id !== Number(appt.operatory_id)) || (n.provider_id && n.provider_id !== Number(appt.provider_id)))) continue;
    await update(db, 'schedule_notes', n.id, req.user.practice_id, { status: 'done', done_by: req.user.id, done_at: utcNow(), result_kind: 'appointment', result_id: appt.id });
    await audit(db, req, 'schedule_note.done', 'schedule_notes', n.id, { result_kind: 'appointment', result_id: appt.id, patient_id: appt.patient_id }, { patientId: appt.patient_id });
    publish(req.user.practice_id, { type: 'doctor_note', what: 'done', id: n.id, dates: [n.note_date], by: req.user.id });
  }
}

export default function doctorNoteRoutes({ db }) {
  const r = Router();
  const writer = (req) => {
    if (!can(req.user, 'schedule:write') && !can(req.user, 'clinical:write')) throw new HttpError(403, 'You don’t have permission to leave notes on the schedule');
  };
  const one = async (req) => {
    const n = await findOr404(db, 'schedule_notes', req.params.id, req.user.practice_id, 'Note');
    if (n.patient_id && !(await canSeePatient(db, req.user, n.patient_id))) throw new HttpError(404, 'Note not found');
    if (n.location_id && Array.isArray(req.user.location_ids) && req.user.location_ids.length && !req.user.location_ids.includes(n.location_id)) throw new HttpError(404, 'Note not found');
    return n;
  };
  const out = async (id) => noteOut(await db.get(`${SELECT} WHERE n.id = ?`, id));
  const tell = (req, what, n) => publish(req.user.practice_id, {
    type: 'doctor_note', what, id: n.id, dates: [n.note_date], by: req.user.id, by_name: req.user.name, kind: n.kind, preview: String(n.body).slice(0, 80),
  });

  r.get('/schedule-notes', requirePermission('schedule:read'), async (req, res) => {
    const from = req.query.from || req.query.date || (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const to = req.query.to || from;
    if (!isRealDate(from) || !isRealDate(to)) throw new HttpError(400, 'from and to must be real dates (YYYY-MM-DD)');
    const all = req.query.status === 'all';
    const scope = appointmentScope(req.user, 'n');
    const rows = await db.all(
      `${SELECT} WHERE n.practice_id = ? AND n.note_date >= ? AND n.note_date <= ?${all ? '' : " AND n.status IN ('open','acknowledged')"}${scope.sql} ORDER BY n.note_date, n.start_time, n.created_at`,
      req.user.practice_id, from, to, ...scope.args,
    );
    res.json(rows.map(noteOut));
  });

  r.post('/schedule-notes', requirePermission('schedule:read'), async (req, res) => {
    writer(req);
    const pid = req.user.practice_id;
    const b = req.body || {};
    const body = clean(b.body, 400);
    if (!body) throw new HttpError(400, 'Write the note');
    const key = clean(b.client_key, 80);
    if (key) {
      const had = await db.get('SELECT id FROM schedule_notes WHERE practice_id = ? AND client_key = ?', pid, key);
      if (had) return res.json(await out(had.id));
    }
    let row;
    if (b.appointment_id != null) {
      const a = await findOr404(db, 'appointments', b.appointment_id, pid, 'Appointment');
      if (!(await canSeePatient(db, req.user, a.patient_id))) throw new HttpError(404, 'Appointment not found');
      row = {
        kind: 'visit', appointment_id: a.id, patient_id: a.patient_id, provider_id: a.provider_id, operatory_id: a.operatory_id, location_id: a.location_id,
        note_date: a.start_time.slice(0, 10), start_time: a.start_time.slice(11, 16), end_time: a.end_time.slice(11, 16),
      };
    } else {
      if (!isRealDate(b.date)) throw new HttpError(400, 'date must be a real date (YYYY-MM-DD)');
      if (!HHMM.test(b.start_time || '') || !HHMM.test(b.end_time || '') || b.end_time <= b.start_time) throw new HttpError(400, 'Give the slot a start and an end time (HH:MM), end after start');
      const provider = b.provider_id != null ? await findOr404(db, 'providers', b.provider_id, pid, 'Provider') : null;
      const chair = b.operatory_id != null ? await findOr404(db, 'operatories', b.operatory_id, pid, 'Operatory') : null;
      const location = chair?.location_id ?? (b.location_id != null ? (await findOr404(db, 'locations', b.location_id, pid, 'Location')).id : req.location_id ?? null);
      checkOffice(req.user, location);
      row = { kind: 'slot', provider_id: provider?.id ?? null, operatory_id: chair?.id ?? null, location_id: location, note_date: b.date, start_time: b.start_time, end_time: b.end_time };
    }
    const source = currentActor()?.source || 'human';
    const id = await insert(db, 'schedule_notes', { practice_id: pid, ...row, body, client_key: key, source, created_by: req.user.id });
    await audit(db, req, 'schedule_note.create', 'schedule_notes', id, { kind: row.kind, date: row.note_date, start: row.start_time, patient_id: row.patient_id ?? null }, {
      patientId: row.patient_id ?? null, locationId: row.location_id ?? null, after: { body },
    });
    const n = await out(id);
    tell(req, 'new', { ...row, id, body });
    res.status(201).json(n);
  });

  r.post('/schedule-notes/:id/ack', requirePermission('schedule:write'), async (req, res) => {
    const n = await one(req);
    if (n.status === 'open') {
      await update(db, 'schedule_notes', n.id, req.user.practice_id, { status: 'acknowledged', acked_by: req.user.id, acked_at: utcNow() });
      await audit(db, req, 'schedule_note.ack', 'schedule_notes', n.id, { patient_id: n.patient_id }, { patientId: n.patient_id });
      tell(req, 'ack', n);
    } else if (n.status !== 'acknowledged') throw new HttpError(409, 'That note is already closed');
    res.json(await out(n.id));
  });

  r.post('/schedule-notes/:id/convert', requirePermission('schedule:write'), async (req, res) => {
    const n = await one(req);
    if (!['open', 'acknowledged'].includes(n.status)) {
      // Asked twice: the second answer is the first result.
      if (n.status === 'done') return res.json({ note: await out(n.id), result_kind: n.result_kind, result_id: n.result_id, already: true });
      throw new HttpError(409, 'That note was withdrawn');
    }
    const kind = req.body?.kind;
    const now = utcNow();
    if (kind === 'task') {
      let assignedTo = null;
      if (req.body.assigned_to != null) assignedTo = (await findOr404(db, 'users', req.body.assigned_to, req.user.practice_id, 'Person')).id;
      const who = (await db.get('SELECT name FROM users WHERE id = ?', n.created_by))?.name || 'The doctor';
      const title = clean(req.body.title, 300) || `${who}: ${n.body}`.slice(0, 300);
      const taskId = await insert(db, 'tasks', {
        practice_id: req.user.practice_id, patient_id: n.patient_id, assigned_to: assignedTo, title,
        notes: `From the schedule note on ${n.note_date}${n.start_time ? ` at ${n.start_time}` : ''}.`, due_date: n.note_date, priority: 'normal', created_by: req.user.id,
      });
      await audit(db, req, 'task.create', 'tasks', taskId, { patient_id: n.patient_id ?? null, assigned_to: assignedTo, schedule_note_id: n.id });
      await update(db, 'schedule_notes', n.id, req.user.practice_id, {
        status: 'done', done_by: req.user.id, done_at: now, result_kind: 'task', result_id: taskId, ...(n.acked_at ? {} : { acked_by: req.user.id, acked_at: now }),
      });
      await audit(db, req, 'schedule_note.done', 'schedule_notes', n.id, { result_kind: 'task', result_id: taskId, patient_id: n.patient_id }, { patientId: n.patient_id });
      publish(req.user.practice_id, { type: 'tasks', by: req.user.id });
      tell(req, 'done', n);
      return res.json({ note: await out(n.id), result_kind: 'task', result_id: taskId });
    }
    if (kind === 'booking') {
      // The booking form opens on the person's screen with these; making the booking closes the note.
      await update(db, 'schedule_notes', n.id, req.user.practice_id, {
        booking_started_at: now, booking_started_by: req.user.id, ...(n.status === 'open' ? { status: 'acknowledged', acked_by: req.user.id, acked_at: now } : {}),
      });
      await audit(db, req, 'schedule_note.booking', 'schedule_notes', n.id, { patient_id: n.patient_id }, { patientId: n.patient_id });
      tell(req, 'ack', n);
      return res.json({
        note: await out(n.id),
        book: { patient_id: n.patient_id, date: n.note_date, start_time: n.kind === 'slot' ? n.start_time : null, end_time: n.kind === 'slot' ? n.end_time : null, provider_id: n.provider_id, operatory_id: n.operatory_id },
      });
    }
    throw new HttpError(400, "kind must be 'task' or 'booking'");
  });

  r.post('/schedule-notes/:id/done', requirePermission('schedule:write'), async (req, res) => {
    const n = await one(req);
    if (n.status === 'withdrawn') throw new HttpError(409, 'That note was withdrawn');
    if (n.status !== 'done') {
      const now = utcNow();
      await update(db, 'schedule_notes', n.id, req.user.practice_id, { status: 'done', done_by: req.user.id, done_at: now, ...(n.acked_at ? {} : { acked_by: req.user.id, acked_at: now }) });
      await audit(db, req, 'schedule_note.done', 'schedule_notes', n.id, { patient_id: n.patient_id, note: clean(req.body?.note, 200) }, { patientId: n.patient_id });
      tell(req, 'done', n);
    }
    res.json(await out(n.id));
  });

  r.post('/schedule-notes/:id/withdraw', requirePermission('schedule:read'), async (req, res) => {
    const n = await one(req);
    if (n.created_by !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Only whoever wrote the note can take it back');
    if (n.status === 'done') throw new HttpError(409, 'That note has already been handled');
    if (n.status !== 'withdrawn') {
      await update(db, 'schedule_notes', n.id, req.user.practice_id, { status: 'withdrawn', withdrawn_by: req.user.id, withdrawn_at: utcNow() });
      await audit(db, req, 'schedule_note.withdraw', 'schedule_notes', n.id, { patient_id: n.patient_id }, { patientId: n.patient_id, before: { status: n.status }, after: { status: 'withdrawn' } });
      tell(req, 'withdrawn', n);
    }
    res.json(await out(n.id));
  });

  return r;
}
