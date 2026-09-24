import { Router } from 'express';
import { openSlotLater } from '../fill.js';
import { requirePermission, HttpError, can } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, normalizeDateTime, practiceNow, localNow, mapSeq, paged, recorded, isRealDate } from '../util.js';
import { hoursFor, providerHours, providerHoursFor, providerHoursOn, validateHours } from '../hours.js';
import { publish, eventStream } from '../events.js';
import { emitAppointment } from '../webhooks.js';
import { completeProcedure } from '../services.js';
import { recallTypes, typesForCode } from '../recalls.js';
import { setRecallInterval } from '../recallsync.js';
import { officeFee } from '../fees.js';
import { videoRoomFor } from '../video.js';
import { cleanPattern, fitPattern, providerOverlap, typeDuration } from '../patterns.js';
import { appointmentScope, checkOffice, canSeePatient } from '../officeaccess.js';
import { checkDayBlocks } from '../production.js';
import { recordOfficeMove, officeReasonFrom } from '../cards.js';
import { linkNoteBookings } from './doctornotes.js';
import { withNoShowRisk } from '../predict/noshow.js';

export const STATUSES = ['scheduled', 'confirmed', 'checked_in', 'in_chair', 'completed', 'cancelled', 'no_show'];
export const INACTIVE = "('cancelled','no_show')";
export const CONFIRM_METHODS = ['phone', 'text', 'email', 'in_person', 'portal', 'left_message'];
// The patient flow in order, and the times each step records (index + 1 = the step's rank).
const FLOW_RANK = { scheduled: 0, confirmed: 0, checked_in: 1, in_chair: 2, completed: 3 };
const FLOW_TIMES = [['arrived_at'], ['seated_at', 'ready_at', 'ready_for'], ['dismissed_at']];
export const READY_FOR = ['doctor', 'checkout'];
// Why a visit was cancelled or missed, from the reason picker (labels live in the client's BrokenPicker).
export const BROKEN_REASONS = ['sick', 'conflict', 'transportation', 'cost', 'forgot', 'office', 'no_contact', 'other'];

const SELECT = `SELECT a.*, p.first_name, p.last_name, p.preferred_name, p.phone, p.medical_alerts, p.premed_required, p.dob,
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
    `SELECT a.id, a.start_time, a.end_time, a.provider_id, a.operatory_id, a.patient_id, a.pattern FROM appointments a
     WHERE a.practice_id = ? AND a.id != ? AND a.status NOT IN ${INACTIVE}
       AND a.start_time < ? AND a.end_time > ?
       AND (a.provider_id = ? OR (a.operatory_id IS NOT NULL AND a.operatory_id = ?) OR a.patient_id = ?)`,
    practiceId, excludeId, end_time, start_time, provider_id, operatory_id ?? -1, patient_id,
  );
}

// Blockouts that apply to this provider/operatory (or the whole office) during the slot.
// A reserved block lets its own appointment types in.
// Adds type_names ("Crown prep, Implant") to reserved blocks for the calendar.
async function nameTypes(db, pid, blocks) {
  if (!blocks.some((b) => b.kind === 'reserved')) return blocks;
  const names = Object.fromEntries((await db.all('SELECT id, name FROM appointment_types WHERE practice_id = ?', pid)).map((t) => [t.id, t.name]));
  return blocks.map((b) => (b.kind === 'reserved' ? { ...b, type_names: JSON.parse(b.appointment_type_ids || '[]').map((id) => names[id]).filter(Boolean).join(', ') } : b));
}
export const reservedFor = (block, typeId) => block.kind === 'reserved' && typeId != null && JSON.parse(block.appointment_type_ids || '[]').includes(Number(typeId));

export async function findBlockouts(db, practiceId, { start_time, end_time, provider_id, operatory_id }) {
  return await db.all(
    `SELECT * FROM blockouts WHERE practice_id = ? AND start_time < ? AND end_time > ?
     AND ((provider_id IS NULL AND operatory_id IS NULL) OR provider_id = ? OR operatory_id = ?)`,
    practiceId, end_time, start_time, provider_id ?? -1, operatory_id ?? -1,
  );
}

// Every id an appointment points at must belong to the practice, whatever the appointment's status.
export async function checkApptRefs(db, practiceId, row) {
  await findOr404(db, 'patients', row.patient_id, practiceId, 'Patient');
  await findOr404(db, 'providers', row.provider_id, practiceId, 'Provider');
  if (row.operatory_id) await findOr404(db, 'operatories', row.operatory_id, practiceId, 'Operatory');
  if (row.location_id) await findOr404(db, 'locations', row.location_id, practiceId, 'Location');
  if (row.appointment_type_id) await findOr404(db, 'appointment_types', row.appointment_type_id, practiceId, 'Appointment type');
}

export async function validateAppt(db, practiceId, row, { overrideBlockout = false } = {}) {
  row.start_time = normalizeDateTime(row.start_time, 'start_time');
  row.end_time = normalizeDateTime(row.end_time, 'end_time');
  if (row.end_time <= row.start_time) throw new HttpError(400, 'end_time must be after start_time');
  if (row.start_time.slice(0, 10) !== row.end_time.slice(0, 10)) throw new HttpError(400, 'Appointments must start and end on the same day');
  requireOneOf(row.status, STATUSES, 'status');
  await findOr404(db, 'patients', row.patient_id, practiceId, 'Patient');
  const provider = await findOr404(db, 'providers', row.provider_id, practiceId, 'Provider');
  // The chair decides the office; a visit without a chair keeps the office it was booked at.
  if (row.operatory_id) row.location_id = (await findOr404(db, 'operatories', row.operatory_id, practiceId, 'Operatory')).location_id ?? row.location_id ?? null;
  const location = row.location_id ? await findOr404(db, 'locations', row.location_id, practiceId, 'Location') : null;
  if (row.appointment_type_id) await findOr404(db, 'appointment_types', row.appointment_type_id, practiceId, 'Appointment type');
  // A provider can be in two places only when one visit is in assistant time ("/") while the other needs them.
  if (row.pattern) row.pattern = fitPattern(cleanPattern(row.pattern), (Date.parse(row.end_time.replace(' ', 'T')) - Date.parse(row.start_time.replace(' ', 'T'))) / 60000);
  const conflicts = (await findConflicts(db, practiceId, row, row.id)).filter((c) => c.patient_id === Number(row.patient_id)
    || (row.operatory_id && c.operatory_id === Number(row.operatory_id))
    || (c.provider_id === Number(row.provider_id) && providerOverlap(c, row)));
  if (conflicts.length) {
    const kinds = new Set();
    for (const c of conflicts) {
      if (c.provider_id === Number(row.provider_id)) kinds.add('provider');
      if (row.operatory_id && c.operatory_id === Number(row.operatory_id)) kinds.add('operatory');
      if (c.patient_id === Number(row.patient_id)) kinds.add('patient');
    }
    throw new HttpError(409, `Scheduling conflict: ${[...kinds].join(', ')} already booked`, { conflicts });
  }
  // Perfect-day blocks (day templates, S2): kept for their visit types until their release time. Checked even
  // when overridden, so the caller can record that someone booked into one anyway.
  const dayBlock = await checkDayBlocks(db, practiceId, row);
  if (!overrideBlockout) {
    // Reserved blocks (block scheduling) take the appointment types they're kept for.
    const blocks = (await findBlockouts(db, practiceId, row)).filter((b) => !reservedFor(b, row.appointment_type_id));
    if (blocks.length) {
      const b = blocks[0];
      throw new HttpError(409, b.kind === 'reserved' ? `That time is reserved for ${b.reason}` : `That time is blocked: ${b.reason}`, { blockouts: blocks, can_override: true });
    }
    if (dayBlock) throw new HttpError(409, dayBlock.message, { day_block: dayBlock.block, can_override: true });
    // Nobody is booked outside their hours — the provider's own (part-time hygienists, visiting
    // specialists) or else the office's — without a deliberate override.
    const date = row.start_time.slice(0, 10);
    const practice = location?.office_hours ? location : await db.get('SELECT office_hours FROM practices WHERE id = ?', practiceId);
    const ranges = await providerHoursOn(db, practice, provider, date);
    const inside = ranges.some(([o, c]) => row.start_time.slice(11) >= o && row.end_time.slice(11) <= c);
    if (!inside) {
      const why = ranges.exception ? `${provider.name} ${ranges.length ? 'has different hours' : 'is off'} that day (${ranges.exception})`
        : providerHours(provider) ? `${provider.name} isn't scheduled to work then` : 'That time is outside office hours';
      throw new HttpError(409, why, { outside_hours: [...ranges], can_override: true });
    }
  }
  return { dayBlock: overrideBlockout ? dayBlock : null };
}

// Booking into a perfect-day block "anyway" is recorded with the block it went into.
export async function auditDayBlockOverride(db, req, apptId, dayBlock) {
  if (!dayBlock) return;
  const b = dayBlock.block;
  await audit(db, req, 'appointment.block_override', 'appointments', apptId, { block: b.label, template_id: b.template_id, block_id: b.id, start: b.start_time, end: b.end_time, release_at: b.release_at }, {
    reason: `Booked into ${b.label} time (kept for ${b.type_names.join(', ') || 'other visit types'}) anyway`,
  });
}

// Recall visits: which recall a booked appointment takes care of. The visit's procedures decide
// (prophy, perio maintenance); a hygiene visit with none on it covers the patient's due recalls.
export async function linkRecalls(db, practiceId, apptId) {
  const appt = await db.get('SELECT a.*, pv.type AS provider_type FROM appointments a JOIN providers pv ON pv.id = a.provider_id WHERE a.id = ?', apptId);
  if (!appt) return;
  const codes = (await db.all("SELECT code FROM procedures WHERE appointment_id = ? AND status = 'planned'", apptId)).map((p) => p.code);
  const recallTypeList = await recallTypes(db, practiceId);
  const types = [...new Set(codes.flatMap((c) => typesForCode(recallTypeList, c).map((t) => t.key)))];
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
export async function openSlots(db, practiceId, providerId, date, { duration = 60, step = 10, after = null, open = null, close = null, typeId = null, locationId = null } = {}) {
  const location = locationId ? await db.get('SELECT office_hours FROM locations WHERE id = ? AND practice_id = ?', locationId, practiceId) : null;
  const practice = location?.office_hours ? location : await db.get('SELECT office_hours FROM practices WHERE id = ?', practiceId);
  const provider = await db.get('SELECT id, working_hours FROM providers WHERE id = ?', providerId);
  const ranges = open && close ? [[open, close]] : await providerHoursOn(db, practice, provider, date);
  const busy = [
    ...(await db.all(
      `SELECT start_time, end_time FROM appointments WHERE practice_id = ? AND provider_id = ? AND status NOT IN ${INACTIVE}
       AND start_time >= ? AND start_time < ?`, practiceId, providerId, `${date} 00:00`, `${date} 24:00`,
    )),
    ...(await db.all(
      `SELECT start_time, end_time, kind, appointment_type_ids FROM blockouts WHERE practice_id = ? AND start_time < ? AND end_time > ?
       AND ((provider_id IS NULL AND operatory_id IS NULL) OR provider_id = ?)`, practiceId, `${date} 24:00`, `${date} 00:00`, providerId,
    )).filter((b) => !reservedFor(b, typeId)),
    // A pending online request holds its slot so it isn't offered to someone else meanwhile.
    ...(await db.all(
      // (one waiting on its deposit only for as long as the checkout is open).
      `SELECT requested_start, duration FROM booking_requests WHERE practice_id = ? AND provider_id = ? AND status = 'pending' AND requested_start >= ? AND requested_start < ?
         AND (deposit_status = 'paid' OR hold_until > ? OR (deposit_status IS NULL AND created_at > ?))`,
      // A request without a deposit holds its time for two days; after that the time is offered again.
      practiceId, providerId, `${date} 00:00`, `${date} 24:00`, new Date().toISOString(), new Date(Date.now() - 48 * 3600_000).toISOString().slice(0, 19).replace('T', ' '),
    )).map((b) => ({ start_time: b.requested_start, end_time: addMinutes(b.requested_start, b.duration || 60) })),
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

const nextDay = (d) => new Date(Date.parse(`${d}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
const overlaps = (rows, s, e) => rows.some((x) => x.start_time < e && x.end_time > s);

// Smart defaults for booking a patient (workflow 9), so the form only needs a yes: who they see (their own
// dentist, or hygienist for a hygiene type; else whoever they saw last), the visit type (a recall that's due),
// its length, the provider's usual chair, and the first open time from `after` on — free for the provider,
// the chair and the patient. Anything given is kept as it is. `why` says where each default came from.
export async function suggestBooking(db, pid, { patient, type = null, pickType = false, providerId = null, operatoryId = null, lastChair = null, duration = null, after, start = null, days = 60, locationId = null }) {
  const why = {};
  const first = patient.preferred_name || patient.first_name;
  let notBefore = null;
  // A recall that's due decides the visit type (and the search starts on its due date, so insurance's
  // "once every six months" is respected).
  if (!type && pickType) {
    const types = await recallTypes(db, pid);
    const due = await db.all("SELECT type, due_date FROM recalls WHERE practice_id = ? AND patient_id = ? AND status IN ('due','contacted') ORDER BY due_date", pid, patient.id);
    for (const r of due) {
      const rt = types.find((t) => t.key === r.type && t.appointment_type_id);
      const t = rt && await db.get('SELECT * FROM appointment_types WHERE id = ? AND practice_id = ? AND active = 1', rt.appointment_type_id, pid);
      if (t) {
        type = t;
        why.type = `${rt.name} due ${r.due_date}`;
        notBefore = r.due_date;
        break;
      }
    }
  }
  const providers = await db.all('SELECT id, name, type FROM providers WHERE practice_id = ? AND active = 1 ORDER BY id', pid);
  const fits = (p) => p && (!type?.provider_type || p.type === type.provider_type || !providers.some((x) => x.type === type.provider_type));
  let provider = null;
  let source = 'given';
  if (providerId) provider = providers.find((p) => p.id === Number(providerId)) || await db.get('SELECT id, name, type FROM providers WHERE id = ? AND practice_id = ?', Number(providerId), pid);
  if (!provider) {
    const own = type?.provider_type === 'hygienist'
      ? [[patient.primary_hygienist_id, 'hygienist'], [patient.primary_provider_id, 'dentist']]
      : [[patient.primary_provider_id, 'dentist'], [patient.primary_hygienist_id, 'hygienist']];
    for (const [id, role] of own) {
      const p = providers.find((x) => x.id === id);
      if (fits(p)) { provider = p; source = 'patient'; why.provider = `${first}'s ${role}`; break; }
    }
  }
  if (!provider) {
    const last = await db.all("SELECT provider_id FROM appointments WHERE practice_id = ? AND patient_id = ? AND status NOT IN ('cancelled','no_show') ORDER BY start_time DESC LIMIT 10", pid, patient.id);
    for (const { provider_id: id } of last) {
      const p = providers.find((x) => x.id === id);
      if (fits(p)) { provider = p; source = 'history'; why.provider = `${first} saw them last`; break; }
    }
  }
  if (!provider) {
    provider = providers.find(fits) || providers[0];
    source = 'default';
  }
  if (!provider) throw new HttpError(409, 'Add a provider first');
  const length = Number(duration) || typeDuration(type, provider.id) || 60;

  // The chair: the one given, else the provider's usual chair, the one this person used last with them,
  // or where the provider has worked most in the last three months.
  const chairs = await db.all(`SELECT id, name, location_id, default_provider_id FROM operatories WHERE practice_id = ? AND active = 1${locationId ? ' AND (location_id = ? OR location_id IS NULL)' : ''} ORDER BY id`, pid, ...(locationId ? [locationId] : []));
  let chair = operatoryId ? await db.get('SELECT id, name, location_id FROM operatories WHERE id = ? AND practice_id = ?', Number(operatoryId), pid) : null;
  if (!chair && !operatoryId) {
    chair = chairs.find((o) => o.default_provider_id === provider.id) || null;
    if (chair) why.chair = `${provider.name}'s usual chair`;
    else if (lastChair && (chair = chairs.find((o) => o.id === Number(lastChair)) || null)) why.chair = 'the chair you used last';
    else {
      const since = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
      const used = await db.all(
        'SELECT operatory_id, COUNT(*) AS n FROM appointments WHERE practice_id = ? AND provider_id = ? AND operatory_id IS NOT NULL AND start_time >= ? GROUP BY operatory_id ORDER BY n DESC, operatory_id',
        pid, provider.id, since,
      );
      for (const u of used) if ((chair = chairs.find((o) => o.id === u.operatory_id) || null)) break;
      if (chair) why.chair = `where ${provider.name} usually works`;
    }
  }
  const out = {
    patient_id: patient.id, appointment_type_id: type?.id ?? null, provider_id: provider.id, provider_source: source,
    operatory_id: chair?.id ?? null, duration: length, start_time: null, end_time: null, why,
  };
  if (start) return { ...out, start_time: start, end_time: addMinutes(start, length) };

  // The first time from `after` on that's open for the provider (hours, visits, blocks, held online requests),
  // the chair (visits and chair blocks) and the patient (no double booking).
  let from = after;
  if (notBefore && notBefore > from.slice(0, 10)) from = `${notBefore} 00:00`;
  let date = from.slice(0, 10);
  for (let i = 0; i < Math.min(Math.max(Number(days) || 60, 1), 120); i++, date = nextDay(date)) {
    const slots = await openSlots(db, pid, provider.id, date, { duration: length, after: date === from.slice(0, 10) ? from : null, typeId: type?.id ?? null, locationId: chair?.location_id ?? locationId });
    if (!slots.length) continue;
    const dayStart = `${date} 00:00`;
    const dayEnd = `${date} 24:00`;
    const mine = await db.all(`SELECT start_time, end_time FROM appointments WHERE practice_id = ? AND patient_id = ? AND status NOT IN ${INACTIVE} AND start_time < ? AND end_time > ?`, pid, patient.id, dayEnd, dayStart);
    const inChair = chair ? await db.all(`SELECT start_time, end_time FROM appointments WHERE practice_id = ? AND operatory_id = ? AND status NOT IN ${INACTIVE} AND start_time < ? AND end_time > ?`, pid, chair.id, dayEnd, dayStart) : [];
    const chairBlocks = chair ? (await db.all('SELECT start_time, end_time, kind, appointment_type_ids FROM blockouts WHERE practice_id = ? AND operatory_id = ? AND start_time < ? AND end_time > ?', pid, chair.id, dayEnd, dayStart)).filter((b) => !reservedFor(b, type?.id)) : [];
    for (const s of slots) {
      const e = addMinutes(s, length);
      if (overlaps(mine, s, e) || overlaps(inChair, s, e) || overlaps(chairBlocks, s, e)) continue;
      return { ...out, start_time: s, end_time: e };
    }
  }
  return out;
}

// ---- Recurring visits ----
// repeat: { every: 1-12, unit: 'week' | 'month', count: 2-52 }
// Repeats: every N weeks or months, for a number of visits or until a date. Monthly repeats land on
// the same date, or on the same weekday of the month ("2nd Tuesday", "last Friday").
export function parseRepeat(repeat, start) {
  if (!repeat) return null;
  const every = Number(repeat.every || 1);
  if (!['week', 'month'].includes(repeat.unit)) throw new HttpError(400, "repeat.unit must be 'week' or 'month'");
  if (!Number.isInteger(every) || every < 1 || every > 12) throw new HttpError(400, 'repeat.every must be 1-12');
  const monthlyBy = repeat.unit === 'month' ? repeat.monthly_by || 'date' : null;
  if (monthlyBy && !['date', 'weekday'].includes(monthlyBy)) throw new HttpError(400, "repeat.monthly_by must be 'date' or 'weekday'");
  let count = Number(repeat.count);
  let until = null;
  if (repeat.until) {
    until = String(repeat.until);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new HttpError(400, 'repeat.until must be YYYY-MM-DD');
    if (!start) throw new HttpError(400, 'start_time is required');
    count = 0;
    while (count < 52 && shiftVisit(start, { every, unit: repeat.unit, monthly_by: monthlyBy }, count).slice(0, 10) <= until) count++;
  }
  if (!Number.isInteger(count) || count < 2 || count > 52) throw new HttpError(400, until ? 'The end date must allow 2 to 52 visits' : 'repeat.count must be 2-52 visits');
  return { every, unit: repeat.unit, count, ...(monthlyBy ? { monthly_by: monthlyBy } : {}), ...(until ? { until_date: until } : {}) };
}
// The i-th visit: weekly steps, or monthly on the same date (clamped to the month's last day) or on
// the same nth weekday (a 5th weekday becomes that month's last).
export function shiftVisit(dateTime, { every, unit, monthly_by: monthlyBy }, i) {
  const d = new Date(`${dateTime.slice(0, 10)}T12:00:00Z`);
  if (unit === 'week') d.setUTCDate(d.getUTCDate() + 7 * every * i);
  else if (monthlyBy === 'weekday') {
    const weekday = d.getUTCDay();
    const nth = Math.ceil(d.getUTCDate() / 7);
    const lastOfStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const isLast = d.getUTCDate() + 7 > lastOfStart;
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + every * i);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const first = 1 + ((weekday - d.getUTCDay() + 7) % 7);
    let day = first + (nth - 1) * 7;
    if (isLast || day > last) day = first + Math.floor((last - first) / 7) * 7;
    d.setUTCDate(day);
  } else {
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

const datesBetween = (from, to, max = 62) => {
  const out = [];
  for (let d = from; d <= to && out.length < max; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};

// Each appointment's insurance check: the primary policy's latest eligibility result and when it ran.
export const withEligibility = async (db, rows) => {
  const patients = [...new Set(rows.map((a) => a.patient_id))];
  const primary = new Map();
  const latest = new Map();
  for (let i = 0; i < patients.length; i += 500) {
    const ids = patients.slice(i, i + 500);
    const policies = await db.all(`SELECT id, patient_id, priority FROM patient_insurance WHERE active = 1 AND patient_id IN (${ids.map(() => '?').join(',')}) ORDER BY CASE priority WHEN 'primary' THEN 0 ELSE 1 END, id`, ...ids);
    for (const p of policies) if (!primary.has(p.patient_id)) primary.set(p.patient_id, p.id);
  }
  const policyIds = [...primary.values()];
  for (let i = 0; i < policyIds.length; i += 500) {
    const ids = policyIds.slice(i, i + 500);
    const checks = await db.all(`SELECT e.patient_insurance_id, e.status, e.created_at FROM eligibility_checks e WHERE e.id IN (SELECT MAX(id) FROM eligibility_checks WHERE patient_insurance_id IN (${ids.map(() => '?').join(',')}) GROUP BY patient_insurance_id)`, ...ids);
    for (const c of checks) latest.set(c.patient_insurance_id, c);
  }
  for (const a of rows) {
    const policy = primary.get(a.patient_id);
    const c = policy && latest.get(policy);
    a.eligibility = !policy ? null : c ? { status: c.status, checked_at: c.created_at } : { status: 'unverified', checked_at: null };
  }
  return rows;
};

export default function scheduleRoutes({ db }) {
  const r = Router();
  const FIELDS = ['patient_id', 'provider_id', 'operatory_id', 'location_id', 'start_time', 'end_time', 'status', 'reason', 'notes', 'appointment_type_id', 'asap', 'pattern'];
  const seriesInfo = async (appt) => {
    const s = await db.get('SELECT id, every, unit, count, monthly_by, until_date FROM appointment_series WHERE id = ?', appt.series_id);
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
    const scope = appointmentScope(req.user);
    res.json(await withEligibility(db, await db.all(`${SELECT} WHERE ${where.join(' AND ')}${scope.sql} ORDER BY a.start_time`, ...params, ...scope.args)));
  });


  // The booking form's smart defaults and next open time for a patient (see suggestBooking). Read-only.
  r.get('/appointments/suggest', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const q = req.query;
    if (!q.patient_id) throw new HttpError(400, 'patient_id is required');
    const patient = await findOr404(db, 'patients', q.patient_id, pid, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const type = q.appointment_type_id ? await findOr404(db, 'appointment_types', q.appointment_type_id, pid, 'Appointment type') : null;
    if (q.provider_id) await findOr404(db, 'providers', q.provider_id, pid, 'Provider');
    if (q.operatory_id) await findOr404(db, 'operatories', q.operatory_id, pid, 'Operatory');
    let duration = null;
    if (q.duration) {
      duration = Number(q.duration);
      if (!Number.isInteger(duration) || duration < 5 || duration > 480) throw new HttpError(400, 'duration must be 5-480 minutes');
    }
    // Never suggest a time that's already gone.
    const now = await practiceNow(db, pid);
    let after = now;
    if (q.after) {
      const given = /^\d{4}-\d{2}-\d{2}$/.test(q.after) ? (isRealDate(q.after) ? `${q.after} 00:00` : null) : normalizeDateTime(q.after, 'after');
      if (!given) throw new HttpError(400, 'after must be a real date (YYYY-MM-DD) or date and time');
      if (given > after) after = given;
    }
    const start = q.start_time ? normalizeDateTime(q.start_time, 'start_time') : null;
    res.json(await suggestBooking(db, pid, {
      patient, type, pickType: q.pick_type === '1', providerId: q.provider_id ? Number(q.provider_id) : null, operatoryId: q.operatory_id ? Number(q.operatory_id) : null,
      lastChair: Number(q.last_chair) || null, duration, after, start, days: Number(q.days) || 60, locationId: Number(q.location_id) || req.location_id || null,
    }));
  });

  r.get('/appointments/:id', requirePermission('schedule:read'), async (req, res) => {
    const row = await db.get(`${SELECT} WHERE a.id = ? AND a.practice_id = ?`, Number(req.params.id), req.user.practice_id);
    if (!row) throw new HttpError(404, 'Appointment not found');
    await withEligibility(db, [row]);
    await withNoShowRisk(db, req.user.practice_id, [row]);
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
        code_id: pc.id, code: pc.code, description: pc.description, category: pc.category,
        fee: await officeFee(db, req.user.practice_id, pc, { patientId: row.patient_id, providerId: row.provider_id, locationId: row.location_id }),
      });
    }
  };

  r.post('/appointments', requirePermission('schedule:write'), async (req, res) => {
    const row = pick(req.body, FIELDS);
    const type = row.appointment_type_id ? await findOr404(db, 'appointment_types', row.appointment_type_id, req.user.practice_id, 'Appointment type') : null;
    if (type && row.start_time && !row.end_time) row.end_time = addMinutes(normalizeDateTime(row.start_time, 'start_time'), typeDuration(type, row.provider_id));
    // The type's time pattern, fitted to this visit's length (unless one was given).
    if (type?.pattern && row.pattern === undefined) row.pattern = type.pattern;
    if (type && !row.reason) row.reason = type.name;
    if (!row.location_id && req.location_id) row.location_id = req.location_id;
    checkOffice(req.user, row.location_id);
    if (row.patient_id && !(await canSeePatient(db, req.user, row.patient_id))) throw new HttpError(404, 'Patient not found');
    // A video visit (asked for, or the visit type is one) gets its meeting link now.
    if (req.body.video || type?.is_video) row.video_url = videoRoomFor(await db.get('SELECT * FROM providers WHERE id = ? AND practice_id = ?', Number(row.provider_id), req.user.practice_id));
    requireFields(row, ['patient_id', 'provider_id', 'start_time', 'end_time']);
    const repeat = parseRepeat(req.body.repeat, row.start_time && normalizeDateTime(row.start_time, 'start_time'));
    const checked = await validateAppt(db, req.user.practice_id, row, { overrideBlockout: !!req.body.override_blockout });
    const withTypeProcs = req.body.add_type_procedures !== false && !(req.body.procedure_ids || []).length;
    let series = null;
    const id = await db.tx(async () => {
      if (repeat) {
        const seriesId = await insert(db, 'appointment_series', { practice_id: req.user.practice_id, patient_id: row.patient_id, ...repeat, created_by: req.user.id });
        row.series_id = seriesId;
        series = { id: seriesId, ...repeat, created: 1, skipped: [] };
      }
      // The patient hears about it on the next reminder run (unless the office says not to).
      const newId = await insert(db, 'appointments', { ...row, practice_id: req.user.practice_id, notice_due: req.body.notify === false ? null : 'booked' });
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
    // Booked: off the waitlist.
    await db.run("UPDATE waitlist SET status = 'booked' WHERE practice_id = ? AND patient_id = ? AND status = 'waiting'", req.user.practice_id, row.patient_id);
    await audit(db, req, 'appointment.create', 'appointments', id, { start: row.start_time });
    await auditDayBlockOverride(db, req, id, checked.dayBlock);
    // A doctor's note someone pressed "Book it" on is closed by this booking (DN1).
    await linkNoteBookings(db, req, { ...row, id, patient_id: Number(row.patient_id) });
    changed(req, row.start_time, ...(series ? Array.from({ length: repeat.count }, (_, i) => shiftVisit(row.start_time, repeat, i)) : []));
    await emitAppointment(db, id, 'appointment.created');
    res.status(201).json({ ...(await db.get(`${SELECT} WHERE a.id = ?`, id)), ...(series ? { series } : {}) });
  });

  // Book several family members at once: back to back with the same provider and chair, or side by
  // side at the same time in their own chairs. All of them are booked, or none are.
  r.post('/appointments/family', requirePermission('schedule:write'), async (req, res) => {
    const b = req.body || {};
    const members = Array.isArray(b.members) ? b.members : [];
    if (members.length < 2 || members.length > 8) throw new HttpError(400, 'Book 2 to 8 family members');
    requireOneOf(b.mode, ['back_to_back', 'side_by_side'], 'mode');
    let start = normalizeDateTime(b.start_time, 'start_time');
    const pid = req.user.practice_id;
    const overrides = [];
    const ids = await db.tx(async () => {
      const out = [];
      for (const [i, m] of members.entries()) {
        const type = m.appointment_type_id ? await findOr404(db, 'appointment_types', m.appointment_type_id, pid, 'Appointment type') : null;
        const duration = Number(m.duration) || type?.duration || 60;
        if (!Number.isInteger(duration) || duration < 5 || duration > 480) throw new HttpError(400, 'Each visit is 5-480 minutes');
        const row = {
          patient_id: m.patient_id, provider_id: m.provider_id || b.provider_id, operatory_id: m.operatory_id || b.operatory_id || null,
          appointment_type_id: type?.id ?? null, reason: m.reason || type?.name || null, status: 'scheduled',
          start_time: start, end_time: addMinutes(start, duration),
        };
        requireFields(row, ['patient_id', 'provider_id']);
        let checked;
        try {
          checked = await validateAppt(db, pid, row, { overrideBlockout: !!b.override_blockout });
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          const p = await db.get('SELECT first_name FROM patients WHERE id = ?', row.patient_id);
          throw new HttpError(err.status, `${p?.first_name || `Member ${i + 1}`}: ${err.message}`, err.details);
        }
        const id = await insert(db, 'appointments', { ...row, practice_id: pid, notice_due: b.notify === false ? null : 'booked' });
        await addTypeProcedures(req, type, id, row);
        await linkRecalls(db, pid, id);
        out.push(id);
        if (checked.dayBlock) overrides.push([id, checked.dayBlock]);
        if (b.mode === 'back_to_back') start = row.end_time;
      }
      return out;
    });
    await audit(db, req, 'appointment.family', 'appointments', ids[0], { count: ids.length, mode: b.mode });
    for (const [id, block] of overrides) await auditDayBlockOverride(db, req, id, block);
    changed(req, normalizeDateTime(b.start_time, 'start_time'));
    for (const x of ids) await emitAppointment(db, x, 'appointment.created');
    res.status(201).json(await db.all(`${SELECT} WHERE a.id IN (${ids.map(() => '?').join(',')}) ORDER BY a.start_time, a.id`, ...ids));
  });

  r.put('/appointments/:id', requirePermission('schedule:write'), async (req, res) => {
    const existing = await findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    const changes = pick(req.body, FIELDS);
    const merged = { ...existing, ...changes };
    if ('location_id' in changes) checkOffice(req.user, changes.location_id);
    if (changes.patient_id && !(await canSeePatient(db, req.user, changes.patient_id))) throw new HttpError(404, 'Patient not found');
    let checked = null;
    if (!['cancelled', 'no_show'].includes(merged.status)) checked = await validateAppt(db, req.user.practice_id, merged, { overrideBlockout: !!req.body.override_blockout });
    else {
      requireOneOf(merged.status, STATUSES, 'status');
      await checkApptRefs(db, req.user.practice_id, merged);
    }
    const row = pick(merged, FIELDS);
    if (req.body.video !== undefined) {
      row.video_url = req.body.video ? existing.video_url || videoRoomFor(await findOr404(db, 'providers', row.provider_id, req.user.practice_id, 'Provider')) : null;
    }
    const inactive = ['cancelled', 'no_show'];
    // A moved appointment needs a fresh reminder and confirmation.
    if (row.start_time !== existing.start_time) {
      Object.assign(row, { reminder_sent_at: null, confirmed_at: null, confirmed_via: null, notice_due: req.body.notify === false || !['scheduled', 'confirmed'].includes(row.status) ? null : 'moved' });
      await db.run('DELETE FROM appointment_reminders WHERE appointment_id = ?', existing.id);
    }
    await update(db, 'appointments', existing.id, req.user.practice_id, row);
    // Keep attached procedures with the provider the patient is now seeing.
    if (Number(row.provider_id) !== existing.provider_id) await db.run("UPDATE procedures SET provider_id = ? WHERE appointment_id = ? AND status = 'planned'", row.provider_id, existing.id);
    // Cancelling from the edit form releases procedures and recalls, same as the status buttons.
    if (inactive.includes(row.status) && !inactive.includes(existing.status)) await releaseAppointment(db, existing.id);
    if (row.status === 'cancelled' && existing.status !== 'cancelled') openSlotLater(db, existing.id);
    await audit(db, req, 'appointment.update', 'appointments', existing.id, {
      fields: Object.keys(changes),
      ...(row.start_time !== existing.start_time ? { from: existing.start_time, to: row.start_time } : {}),
      ...(Number(row.provider_id) !== existing.provider_id ? { provider_id: Number(row.provider_id) } : {}),
    });
    await auditDayBlockOverride(db, req, existing.id, checked?.dayBlock);
    // Whose reason (S8): a move the office caused counts on the patient ("moved by us"); a patient's own is noted.
    if (row.start_time !== existing.start_time && req.body.moved_by != null) {
      requireOneOf(req.body.moved_by, ['patient', 'office'], 'moved_by');
      if (req.body.moved_by === 'office') {
        await recordOfficeMove(db, { practiceId: req.user.practice_id, appt: existing, kind: 'move', reason: officeReasonFrom({ office_reason: req.body.office_reason ?? 'other' }), note: req.body.office_note ?? null, toTime: row.start_time, userId: req.user.id });
      } else await recorded(db, 'appointments', existing.id, () => db.run("UPDATE appointments SET moved_by = 'patient', office_reason = NULL, office_note = NULL WHERE id = ?", existing.id));
    }
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
          await update(db, 'appointments', occ.id, req.user.practice_id, { ...pick(next, ['provider_id', 'operatory_id', 'appointment_type_id', 'reason', 'start_time', 'end_time']), ...(moved ? { reminder_sent_at: null, confirmed_at: null, confirmed_via: null, status: 'scheduled', notice_due: req.body.notify === false ? null : 'moved' } : {}) });
          if (moved) await db.run('DELETE FROM appointment_reminders WHERE appointment_id = ?', occ.id);
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
    await emitAppointment(db, existing.id);
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
    const via = req.body.confirmed_via;
    requireOneOf(via, CONFIRM_METHODS, 'confirmed_via');
    // Why it was cancelled or missed: a code from the short list, and a few words when it's "other".
    const broken = ['cancelled', 'no_show'].includes(status);
    const brokenReason = req.body.broken_reason ?? null;
    let brokenNote = null;
    if (brokenReason != null) {
      if (!broken) throw new HttpError(400, 'A reason only goes with a cancellation or no-show');
      requireOneOf(brokenReason, BROKEN_REASONS, 'broken_reason');
      brokenNote = req.body.broken_note == null ? null : String(req.body.broken_note).trim().slice(0, 300) || null;
      if (brokenReason === 'other' && !brokenNote) throw new HttpError(400, 'Add a few words about what happened when the reason is "Other"');
    }
    await recorded(db, 'appointments', existing.id, () => db.run(
      "UPDATE appointments SET status = ?, confirmed_at = CASE WHEN ? = 'confirmed' THEN COALESCE(confirmed_at, datetime('now')) ELSE confirmed_at END WHERE id = ?",
      status, status, existing.id,
    ));
    // "Left a message" is a contact attempt, not a confirmation.
    if (via) await recorded(db, 'appointments', existing.id, () => db.run('UPDATE appointments SET confirmed_via = ? WHERE id = ?', via, existing.id));
    else if (status === 'confirmed' && !existing.confirmed_via) await recorded(db, 'appointments', existing.id, () => db.run("UPDATE appointments SET confirmed_via = 'phone' WHERE id = ?", existing.id));
    // Stepping back in the flow (an undo, or a mistaken check-in) clears the times of the steps undone, so
    // the next real check-in or seating records the right time. The change log keeps what they were.
    const rank = FLOW_RANK[status];
    if (rank != null && FLOW_RANK[existing.status] > rank) {
      const clear = FLOW_TIMES.filter((_, i) => i + 1 > rank).flat();
      await recorded(db, 'appointments', existing.id, () => db.run(`UPDATE appointments SET ${clear.map((c) => `${c} = NULL`).join(', ')} WHERE id = ?`, existing.id));
    }
    // Patient flow: when they arrived, were seated and left (practice-local time, for wait and chair times).
    const flow = { checked_in: 'arrived_at', in_chair: 'seated_at', completed: 'dismissed_at' }[status];
    if (flow) {
      // A step made during an internet outage and sent later carries when it really happened (offline queue).
      // Trusted only within the last 36 hours and never in the future; otherwise it's the time it arrived.
      const queued = Date.parse(req.get('X-Offline-Queued-At') || '');
      const real = Number.isFinite(queued) && queued <= Date.now() && queued > Date.now() - 36 * 3600_000;
      const now = real
        ? localNow((await db.get('SELECT timezone FROM practices WHERE id = ?', req.user.practice_id))?.timezone || 'America/New_York', new Date(queued))
        : await practiceNow(db, req.user.practice_id);
      await recorded(db, 'appointments', existing.id, () => db.run(`UPDATE appointments SET ${flow} = COALESCE(${flow}, ?) WHERE id = ?`, now, existing.id));
      if (status === 'in_chair') await recorded(db, 'appointments', existing.id, () => db.run('UPDATE appointments SET arrived_at = COALESCE(arrived_at, ?) WHERE id = ?', now, existing.id));
    }
    if (brokenReason) await recorded(db, 'appointments', existing.id, () => db.run('UPDATE appointments SET broken_reason = ?, broken_note = ? WHERE id = ?', brokenReason, brokenNote, existing.id));
    // Back on the schedule (a mistaken cancel put right): the old reason no longer applies. The change log keeps it.
    else if (!broken && existing.broken_reason) await recorded(db, 'appointments', existing.id, () => db.run('UPDATE appointments SET broken_reason = NULL, broken_note = NULL WHERE id = ?', existing.id));
    // Whose reason (S8): "We had to move it" is the office's doing and counts on the patient; any other reason is theirs.
    if (status === 'cancelled' && brokenReason === 'office' && existing.status !== 'cancelled') {
      const officeReason = officeReasonFrom(req.body);
      await recordOfficeMove(db, { practiceId: req.user.practice_id, appt: existing, kind: 'cancel', reason: officeReason, note: req.body.office_note ?? (officeReason === 'other' ? brokenNote : null), userId: req.user.id });
    } else if (broken && brokenReason && brokenReason !== 'office') await recorded(db, 'appointments', existing.id, () => db.run("UPDATE appointments SET moved_by = 'patient' WHERE id = ?", existing.id));
    if (status === 'cancelled' || status === 'no_show') await releaseAppointment(db, existing.id);
    if (status === 'cancelled' && existing.status !== 'cancelled') openSlotLater(db, existing.id);
    // Finishing the visit also completes the work planned for it (posting the charges), when the
    // person has clinical rights and asked for it.
    let completedProcedures = 0;
    if (status === 'completed' && req.body.complete_procedures && can(req.user, 'clinical:write')) {
      const planned = await db.all("SELECT * FROM procedures WHERE appointment_id = ? AND status = 'planned' ORDER BY id", existing.id);
      for (const p of planned) {
        await completeProcedure(db, req.user, p, { providerId: p.provider_id || existing.provider_id, appointmentId: existing.id, locationId: req.location_id });
        completedProcedures++;
      }
    }
    if (status === 'cancelled' && req.body.scope === 'following' && existing.series_id) {
      const later = await db.all("SELECT id, start_time FROM appointments WHERE series_id = ? AND practice_id = ? AND start_time > ? AND status IN ('scheduled','confirmed')", existing.series_id, req.user.practice_id, existing.start_time);
      for (const occ of later) {
        await recorded(db, 'appointments', occ.id, () => db.run("UPDATE appointments SET status = 'cancelled', broken_reason = COALESCE(?, broken_reason), broken_note = COALESCE(?, broken_note) WHERE id = ?", brokenReason, brokenNote, occ.id));
        await db.run("UPDATE recalls SET status = 'due', appointment_id = NULL WHERE appointment_id = ? AND status = 'scheduled'", occ.id);
        // Their pre-loaded type procedures are only placeholders; cancel them rather than leave "planned" work behind.
        for (const pr of await db.all("SELECT id FROM procedures WHERE appointment_id = ? AND status = 'planned' AND treatment_plan_id IS NULL", occ.id)) {
          await recorded(db, 'procedures', pr.id, () => db.run("UPDATE procedures SET status = 'cancelled' WHERE id = ?", pr.id));
        }
      }
      changed(req, ...later.map((o) => o.start_time));
    }
    // "undo" marks a step taken back from the schedule's Undo, so the history reads as what happened.
    await audit(db, req, 'appointment.status', 'appointments', existing.id, {
      from: existing.status, to: status, ...(completedProcedures ? { completed_procedures: completedProcedures } : {}), ...(req.body.undo === true ? { undo: true } : {}),
      ...(brokenReason ? { broken_reason: brokenReason, ...(brokenNote ? { broken_note: brokenNote } : {}) } : {}),
    }, brokenReason ? { reason: brokenNote ? `${brokenReason}: ${brokenNote}` : brokenReason } : {});
    changed(req, existing.start_time);
    await emitAppointment(db, existing.id);
    res.json({ ...(await db.get(`${SELECT} WHERE a.id = ?`, existing.id)), completed_procedures: completedProcedures });
  });

  // "Ready" for the patient in the chair: ready for the doctor's exam, or ready for checkout. A flag beside the
  // status (not a status of its own) so the flow stays arrived → seated → ready → out. null clears it.
  r.put('/appointments/:id/ready', requirePermission('schedule:write'), async (req, res) => {
    const existing = await findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    const readyFor = req.body?.ready_for ?? null;
    requireOneOf(readyFor, READY_FOR, 'ready_for');
    if (readyFor && existing.status !== 'in_chair') throw new HttpError(409, 'Seat the patient before marking them ready');
    // Asking twice (a double click, a retry) changes nothing and keeps the first time.
    if ((existing.ready_for || null) !== readyFor) {
      const now = readyFor ? await practiceNow(db, req.user.practice_id) : null;
      await recorded(db, 'appointments', existing.id, () => db.run('UPDATE appointments SET ready_for = ?, ready_at = ? WHERE id = ?', readyFor, now, existing.id));
      await audit(db, req, 'appointment.ready', 'appointments', existing.id, { from: existing.ready_for || null, to: readyFor, ...(req.body.undo === true ? { undo: true } : {}) }, {
        before: { ready_for: existing.ready_for, ready_at: existing.ready_at }, after: { ready_for: readyFor, ready_at: now },
      });
      changed(req, existing.start_time);
    }
    res.json(await db.get(`${SELECT} WHERE a.id = ?`, existing.id));
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
    if (!isRealDate(from) || !isRealDate(to) || to < from) throw new HttpError(400, 'from/to must be real dates (YYYY-MM-DD), from first');
    // Counted in full, so a long leave is refused rather than quietly cut short.
    const days = datesBetween(from, to, 367);
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
    const slots = await openSlots(db, pid, Number(provider_id), date, {
      duration, open: req.query.open, close: req.query.close, typeId: req.query.appointment_type_id ? Number(req.query.appointment_type_id) : null,
      locationId: Number(req.query.location_id) || req.location_id,
    });
    res.json({ date, provider_id: Number(provider_id), duration, slots });
  });

  // Everything the calendar needs for a date range in one round trip.
  r.get('/schedule', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const from = req.query.from || (await practiceNow(db, pid)).slice(0, 10);
    const to = req.query.to || from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw new HttpError(400, 'from/to must be YYYY-MM-DD');
    const office = await db.get('SELECT office_hours, daily_goal FROM practices WHERE id = ?', pid);
    // One office of a multi-location practice: its visits, chairs and hours.
    const location = req.query.location_id ? await findOr404(db, 'locations', req.query.location_id, pid, 'Location') : null;
    if (location) checkOffice(req.user, location.id);
    const scope = appointmentScope(req.user);
    const practice = location?.office_hours ? { ...office, office_hours: location.office_hours } : office;
    const dates = datesBetween(from, to);
    const appointments = await db.all(
      `${SELECT} WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? ${req.query.include_cancelled === 'true' ? '' : `AND a.status NOT IN ${INACTIVE}`}${location ? ' AND a.location_id = ?' : ''}${scope.sql} ORDER BY a.start_time`,
      pid, `${from} 00:00`, `${to} 24:00`, ...(location ? [location.id] : []), ...scope.args,
    );
    await withEligibility(db, appointments);
    // Each upcoming visit's no-show risk (one set of queries for the whole range; it informs, never acts).
    await withNoShowRisk(db, pid, appointments);
    const blockouts = await db.all(
      `SELECT * FROM blockouts WHERE practice_id = ? AND start_time < ? AND end_time > ?${location ? ' AND (operatory_id IS NULL OR operatory_id IN (SELECT id FROM operatories WHERE location_id = ?))' : ''} ORDER BY start_time`,
      pid, `${to} 24:00`, `${from} 00:00`, ...(location ? [location.id] : []),
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
      location_id: location?.id ?? null,
      blockouts: await nameTypes(db, pid, blockouts),
      production,
    });
  });

  // ASAP list: booked patients who'd take an earlier opening.
  r.get('/asap', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    res.json(await db.all(`${SELECT} WHERE a.practice_id = ? AND a.asap = 1 AND a.start_time > ? AND a.status IN ('scheduled','confirmed') ORDER BY a.start_time`, pid, await practiceNow(db, pid)));
  });

  // ---- Blockouts (lunch, meetings, holidays, "crown seats only"…) ----
  const BLOCK_FIELDS = ['provider_id', 'operatory_id', 'start_time', 'end_time', 'reason', 'kind', 'appointment_type_ids'];
  const validateBlockout = async (req, row) => {
    row.start_time = normalizeDateTime(row.start_time, 'start_time');
    row.end_time = normalizeDateTime(row.end_time, 'end_time');
    if (row.end_time <= row.start_time) throw new HttpError(400, 'end_time must be after start_time');
    if (row.provider_id) await findOr404(db, 'providers', row.provider_id, req.user.practice_id, 'Provider');
    if (row.operatory_id) await findOr404(db, 'operatories', row.operatory_id, req.user.practice_id, 'Operatory');
    if (row.kind !== undefined) requireOneOf(row.kind, ['blocked', 'reserved'], 'kind');
    if (row.appointment_type_ids !== undefined) {
      const ids = (Array.isArray(row.appointment_type_ids) ? row.appointment_type_ids : JSON.parse(row.appointment_type_ids || '[]')).map(Number);
      for (const id of ids) await findOr404(db, 'appointment_types', id, req.user.practice_id, 'Appointment type');
      row.appointment_type_ids = JSON.stringify([...new Set(ids)]);
    }
    if (row.kind === 'reserved' && !JSON.parse(row.appointment_type_ids || '[]').length) throw new HttpError(400, 'Choose which appointment types this time is reserved for');
  };
  // Scheduled production per provider per day (procedures planned on, or done at, the visits), for goals.
  r.get('/schedule/production', requirePermission('schedule:read'), async (req, res) => {
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    if (!DATE.test(req.query.from || '') || !DATE.test(req.query.to || '')) throw new HttpError(400, 'from and to are required (YYYY-MM-DD)');
    const rows = await db.all(
      `SELECT a.provider_id, substr(a.start_time, 1, 10) AS date, COALESCE(SUM(pr.fee), 0) AS scheduled
       FROM appointments a JOIN procedures pr ON pr.appointment_id = a.id AND pr.status != 'cancelled'
       WHERE a.practice_id = ? AND a.status NOT IN ('cancelled','no_show') AND a.start_time >= ? AND a.start_time <= ?
       GROUP BY a.provider_id, substr(a.start_time, 1, 10)`, req.user.practice_id, `${req.query.from} 00:00`, `${req.query.to} 23:59`,
    );
    const goals = await db.all('SELECT id, daily_goal FROM providers WHERE practice_id = ? AND daily_goal > 0', req.user.practice_id);
    res.json({ rows, goals: Object.fromEntries(goals.map((g) => [g.id, g.daily_goal])) });
  });
  r.get('/blockouts', requirePermission('schedule:read'), async (req, res) => {
    const from = req.query.from || '0000-00-00';
    const to = req.query.to || '9999-12-31';
    res.json(await db.all('SELECT * FROM blockouts WHERE practice_id = ? AND start_time < ? AND end_time > ? ORDER BY start_time', req.user.practice_id, `${to} 24:00`, `${from} 00:00`));
  });
  r.post('/blockouts', requirePermission('schedule:write'), async (req, res) => {
    const row = pick(req.body, BLOCK_FIELDS);
    requireFields(row, ['start_time', 'end_time', 'reason']);
    await validateBlockout(req, row);
    // Repeat weekly for N weeks (e.g. lunch every Tuesday), or every day through a date (a holiday
    // week, a conference). Repeats are linked so the whole series can be changed or removed at once.
    const repeat = Math.min(Math.max(Number(req.body.repeat_weeks) || 1, 1), 52);
    const through = req.body.through_date ? String(req.body.through_date) : null;
    if (through && (!/^\d{4}-\d{2}-\d{2}$/.test(through) || through < row.start_time.slice(0, 10))) throw new HttpError(400, 'through_date must be on or after the start date');
    const days = through ? Math.round((Date.parse(`${through}T12:00:00Z`) - Date.parse(`${row.start_time.slice(0, 10)}T12:00:00Z`)) / 86400_000) + 1 : 1;
    if (days > 62) throw new HttpError(400, 'Block at most 62 days at a time');
    const offsets = through ? Array.from({ length: days }, (_, i) => i) : Array.from({ length: repeat }, (_, i) => i * 7);
    const seriesKey = offsets.length > 1 ? `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : null;
    const ids = await db.tx(() => mapSeq(offsets, async (n) => {
      const shift = (v) => `${new Date(Date.parse(`${v.slice(0, 10)}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10)} ${v.slice(11)}`;
      return await insert(db, 'blockouts', { ...row, start_time: shift(row.start_time), end_time: shift(row.end_time), practice_id: req.user.practice_id, created_by: req.user.id, series_key: seriesKey });
    }));
    await audit(db, req, 'blockout.create', 'blockouts', ids[0], { count: ids.length });
    changed(req, row.start_time);
    res.status(201).json(await db.all(`SELECT * FROM blockouts WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids));
  });
  r.put('/blockouts/:bid', requirePermission('schedule:write'), async (req, res) => {
    const existing = await findOr404(db, 'blockouts', req.params.bid, req.user.practice_id, 'Blockout');
    const row = { ...pick(existing, BLOCK_FIELDS), ...pick(req.body, BLOCK_FIELDS) };
    await validateBlockout(req, row);
    // The whole series: the reason, provider and chair (each keeps its own day).
    if (req.body?.scope === 'series' && existing.series_key) {
      await db.run('UPDATE blockouts SET reason = ?, provider_id = ?, operatory_id = ?, kind = ?, appointment_type_ids = ? WHERE practice_id = ? AND series_key = ?',
        row.reason, row.provider_id ?? null, row.operatory_id ?? null, row.kind || 'blocked', row.appointment_type_ids ?? null, req.user.practice_id, existing.series_key);
      delete row.start_time;
      delete row.end_time;
    }
    await update(db, 'blockouts', existing.id, req.user.practice_id, row);
    await audit(db, req, 'blockout.update', 'blockouts', existing.id);
    changed(req, existing.start_time, row.start_time);
    res.json(await db.get('SELECT * FROM blockouts WHERE id = ?', existing.id));
  });
  r.delete('/blockouts/:bid', requirePermission('schedule:write'), async (req, res) => {
    const existing = await findOr404(db, 'blockouts', req.params.bid, req.user.practice_id, 'Blockout');
    if (req.query.scope === 'series' && existing.series_key) await db.run('DELETE FROM blockouts WHERE practice_id = ? AND series_key = ?', req.user.practice_id, existing.series_key);
    else await db.run('DELETE FROM blockouts WHERE id = ?', existing.id);
    await audit(db, req, 'blockout.delete', 'blockouts', existing.id, { scope: req.query.scope === 'series' ? 'series' : 'one' });
    changed(req, existing.start_time);
    res.json({ ok: true });
  });

  r.get('/events', requirePermission('schedule:read'), eventStream);

  // ---- Recall types ----
  const RECALL_TYPE_FIELDS = ['name', 'interval_months', 'codes', 'appointment_type_id', 'active'];
  const cleanRecallType = async (req, row) => {
    if (row.interval_months != null) {
      row.interval_months = Number(row.interval_months);
      if (!Number.isInteger(row.interval_months) || row.interval_months < 1 || row.interval_months > 120) throw new HttpError(400, 'interval_months must be 1-120');
    }
    if (row.codes != null) {
      const list = Array.isArray(row.codes) ? row.codes : String(row.codes).split(/[\s,]+/);
      row.codes = JSON.stringify([...new Set(list.map((c) => String(c).trim().toUpperCase()).filter(Boolean))]);
    }
    if (row.appointment_type_id) await findOr404(db, 'appointment_types', row.appointment_type_id, req.user.practice_id, 'Appointment type');
    else if ('appointment_type_id' in row) row.appointment_type_id = null;
    if (row.active != null) row.active = row.active ? 1 : 0;
    return row;
  };
  r.get('/recall-types', requirePermission('schedule:read'), async (req, res) => res.json(await recallTypes(db, req.user.practice_id)));
  r.post('/recall-types', requirePermission('schedule:write'), async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can add recall types');
    const row = await cleanRecallType(req, pick(req.body, RECALL_TYPE_FIELDS));
    requireFields(row, ['name', 'interval_months']);
    await recallTypes(db, req.user.practice_id);
    const key = String(row.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'recall';
    if (await db.get('SELECT 1 AS x FROM recall_types WHERE practice_id = ? AND key = ?', req.user.practice_id, key)) throw new HttpError(409, 'There is already a recall type with that name');
    const id = await insert(db, 'recall_types', { codes: '[]', ...row, key, practice_id: req.user.practice_id });
    await audit(db, req, 'recall_type.create', 'recall_types', id);
    res.status(201).json((await recallTypes(db, req.user.practice_id)).find((t) => t.id === id));
  });
  r.put('/recall-types/:tid', requirePermission('schedule:write'), async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can change recall types');
    const existing = await findOr404(db, 'recall_types', req.params.tid, req.user.practice_id, 'Recall type');
    await update(db, 'recall_types', existing.id, req.user.practice_id, await cleanRecallType(req, pick(req.body, RECALL_TYPE_FIELDS)));
    await audit(db, req, 'recall_type.update', 'recall_types', existing.id);
    res.json((await recallTypes(db, req.user.practice_id)).find((t) => t.id === existing.id));
  });

  r.get('/recalls', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const before = req.query.before || (await practiceNow(db, pid)).slice(0, 10);
    const statuses = String(req.query.status || 'due,contacted').split(',');
    res.json(paged(req, res, await db.all(
      `SELECT r.*, p.first_name, p.last_name, p.phone, p.email, rt.name AS type_name, rt.appointment_type_id,
         (SELECT MAX(sent_at) FROM recall_contacts rc WHERE rc.recall_id = r.id) AS auto_contacted_at
       FROM recalls r JOIN patients p ON p.id = r.patient_id LEFT JOIN recall_types rt ON rt.practice_id = r.practice_id AND rt.key = r.type
       WHERE r.practice_id = ? AND r.due_date <= ? AND r.status IN (${statuses.map(() => '?').join(',')}) AND p.status = 'active'
       ORDER BY r.due_date`,
      pid, before, ...statuses,
    )));
  });

  r.put('/recalls/:id', requirePermission('schedule:write'), async (req, res) => {
    const existing = await findOr404(db, 'recalls', req.params.id, req.user.practice_id, 'Recall');
    const row = pick(req.body, ['status', 'due_date', 'interval_months', 'notes']);
    requireOneOf(row.status, ['due', 'scheduled', 'contacted', 'completed', 'inactive'], 'status');
    // "Scheduled" means booked: that comes from booking the visit, not from typing the status.
    if (row.status === 'scheduled' && !existing.appointment_id) throw new HttpError(400, 'Book the recall visit to mark it scheduled');
    if (row.due_date != null && !isRealDate(row.due_date)) throw new HttpError(400, 'due_date must be a real date (YYYY-MM-DD)');
    if (row.interval_months != null && !(Number.isInteger(Number(row.interval_months)) && Number(row.interval_months) >= 1 && Number(row.interval_months) <= 120)) throw new HttpError(400, 'interval_months must be 1-120');
    if (row.notes != null) row.notes = String(row.notes).slice(0, 1000);
    if (row.status === 'contacted') row.last_contacted_at = new Date().toISOString();
    // A different interval for one patient is a clinical decision: same rule as PUT /recalls/:id/interval —
    // clinical permission and a reason, recorded with before/after.
    let changedInterval = null;
    if (row.interval_months != null && Number(row.interval_months) !== existing.interval_months) {
      if (!can(req.user, 'clinical:write')) throw new HttpError(403, 'Changing how often a patient is recalled needs clinical permission');
      const reason = String(req.body?.reason ?? '').trim();
      if (reason.length < 3) throw new HttpError(400, 'Give the reason for a different interval (a few words)');
      changedInterval = await setRecallInterval(db, existing, Number(row.interval_months), reason.slice(0, 300));
      await audit(db, req, 'recall.interval', 'recalls', existing.id, { type: existing.type, reason: reason.slice(0, 300) }, {
        reason: reason.slice(0, 300), patientId: existing.patient_id,
        before: { interval_months: existing.interval_months, due_date: existing.due_date }, after: { interval_months: changedInterval.interval_months, due_date: changedInterval.due_date },
      });
      // The new interval sets the due date unless one was typed too.
      if (row.due_date == null) delete row.due_date;
    }
    delete row.interval_months;
    if (Object.keys(row).length) await update(db, 'recalls', existing.id, req.user.practice_id, row);
    if (Object.keys(row).length || !changedInterval) await audit(db, req, 'recall.update', 'recalls', existing.id);
    res.json(await db.get('SELECT * FROM recalls WHERE id = ?', existing.id));
  });

  return r;
}

