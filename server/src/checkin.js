import { practiceNow, recorded } from './util.js';
import { publish } from './events.js';

// Checking in from a phone: texting HERE, or scanning the QR code at the door. Checks in today's visits
// for everyone given (a parent checks in the children) that haven't started yet, from two hours before.
export const HERE = ['HERE', 'IM HERE', 'I AM HERE', 'ARRIVED', 'CHECK IN', 'CHECKIN', 'AQUI', 'ESTOY AQUI', 'LLEGUE', 'LLEGAMOS', 'WE ARE HERE', 'WERE HERE'];

export async function checkInToday(db, practiceId, patientIds, { via = 'text' } = {}) {
  if (!patientIds.length) return [];
  const now = await practiceNow(db, practiceId);
  const today = now.slice(0, 10);
  const soon = new Date(Date.parse(`${now.replace(' ', 'T')}:00Z`) + 2 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
  const visits = await db.all(
    `SELECT a.id, a.start_time, a.patient_id, p.first_name FROM appointments a JOIN patients p ON p.id = a.patient_id
     WHERE a.practice_id = ? AND a.patient_id IN (${patientIds.map(() => '?').join(',')}) AND a.status IN ('scheduled','confirmed')
       AND a.start_time >= ? AND a.start_time <= ? ORDER BY a.start_time`,
    practiceId, ...patientIds, `${today} 00:00`, soon,
  );
  for (const v of visits) {
    await recorded(db, 'appointments', v.id, () => db.run("UPDATE appointments SET status = 'checked_in', arrived_at = COALESCE(arrived_at, ?), checked_in_via = ? WHERE id = ?", now, via, v.id));
  }
  if (visits.length) publish(practiceId, { type: 'schedule', dates: [today], source: 'checkin', checked_in: visits.map((v) => ({ id: v.id, name: v.first_name })) });
  return visits;
}
