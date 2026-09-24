// Defaults for a new clinical note: which visit it's for and which provider it's written for, so the note
// opens already drafted and linked (workflow 7, docs/workflows/specs/07-clinical-notes.md).
import { HttpError } from './auth.js';

// Which of today's visits a note is most likely about, best first.
const RANK = { in_chair: 0, checked_in: 1 };

// The patient's visits on the practice's local day, and the one a note written now belongs to: the one in the
// chair, then the one checked in, then the one under way by the clock, then the next one, then the last one.
export async function todaysVisits(db, practiceId, patientId, now) {
  const day = now.slice(0, 10);
  const visits = await db.all(
    `SELECT a.id, a.start_time, a.end_time, a.status, a.provider_id, a.appointment_type_id, a.location_id, a.reason,
       COALESCE(t.name, a.reason) AS type_name, pv.name AS provider_name
     FROM appointments a LEFT JOIN appointment_types t ON t.id = a.appointment_type_id LEFT JOIN providers pv ON pv.id = a.provider_id
     WHERE a.practice_id = ? AND a.patient_id = ? AND a.start_time >= ? AND a.start_time <= ? AND a.status NOT IN ('cancelled','no_show')
     ORDER BY a.start_time, a.id`,
    practiceId, patientId, `${day} 00:00`, `${day} 23:59`,
  );
  const time = now.slice(0, 16);
  const score = (v) => RANK[v.status] ?? (v.start_time <= time && time < v.end_time ? 2 : v.start_time > time ? 3 : 4);
  const current = [...visits].sort((a, b) => score(a) - score(b) || (score(a) === 4 ? b.start_time.localeCompare(a.start_time) : 0))[0] || null;
  return { visits, current };
}

// A visit named by the client: it must be this patient's, in this practice.
export async function visitFor(db, practiceId, patientId, id) {
  const visit = await db.get('SELECT id, provider_id, appointment_type_id, location_id, patient_id FROM appointments WHERE id = ? AND practice_id = ?', Number(id), practiceId);
  if (!visit) throw new HttpError(404, 'Appointment not found');
  if (visit.patient_id !== patientId) throw new HttpError(400, "That visit is another patient's");
  return visit;
}

// The signed-in person's own provider record (dentists and hygienists are linked to their login).
export async function ownProviderId(db, user) {
  const row = await db.get('SELECT MIN(id) AS id FROM providers WHERE user_id = ? AND practice_id = ? AND active = 1', user.id, user.practice_id);
  return row?.id ?? null;
}
