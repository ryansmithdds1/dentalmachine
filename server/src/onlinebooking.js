import { HttpError } from './auth.js';
import { insert, practiceNow } from './util.js';
import { validateAppt } from './routes/schedule.js';
import { findDuplicates } from './routes/patients.js';
import { savePolicy } from './benefits.js';

// Turns an online booking request into a real appointment: finds the patient (or adds them), adds
// the insurance they entered, books the visit, and posts any deposit they paid. Used when the office
// accepts a request, and straight away for instant booking.
export async function finishBooking(db, b, { providerId, start, duration, patientId = null, operatoryId = null, userId = null } = {}) {
  const pid = b.practice_id;
  providerId = Number(providerId || b.provider_id);
  if (!providerId) throw new HttpError(400, 'Choose a provider');
  start = start || b.requested_start;
  duration = Number(duration || b.duration);
  return db.tx(async () => {
    let pat = patientId;
    // An existing patient booking online shouldn't become a second chart.
    if (!pat) {
      const match = (await findDuplicates(db, pid, { first_name: b.first_name, last_name: b.last_name, dob: b.dob, phone: b.phone, email: b.email }))
        .find((m) => m.status !== 'archived' && m.last_name.toLowerCase() === b.last_name.toLowerCase() && (!b.dob || !m.dob || m.dob === b.dob));
      pat = match?.id ?? null;
    }
    if (!pat) {
      pat = await insert(db, 'patients', {
        practice_id: pid, first_name: b.first_name, last_name: b.last_name, dob: b.dob, phone: b.phone, email: b.email,
        referral_source: 'Online booking', notes: b.notes ? `Online booking note: ${b.notes}` : null,
      });
    }
    if (b.insurance_carrier && b.insurance_member_id) {
      const carrierName = String(b.insurance_carrier).trim();
      let carrier = await db.get('SELECT id FROM insurance_carriers WHERE practice_id = ? AND lower(name) = lower(?)', pid, carrierName);
      const carrierId = carrier?.id ?? await insert(db, 'insurance_carriers', { practice_id: pid, name: carrierName });
      const has = await db.get('SELECT id FROM patient_insurance WHERE patient_id = ? AND carrier_id = ? AND subscriber_id = ?', pat, carrierId, b.insurance_member_id);
      if (!has) {
        const holder = b.insurance_subscriber ? String(b.insurance_subscriber) : `${b.first_name} ${b.last_name}`;
        const own = !b.insurance_subscriber || holder.toLowerCase() === `${b.first_name} ${b.last_name}`.toLowerCase();
        await savePolicy(db, pid, null, {
          patient_id: pat, carrier_id: carrierId, priority: 'primary', subscriber_name: holder, subscriber_id: String(b.insurance_member_id),
          relationship: own ? 'self' : 'other', subscriber_dob: own ? b.dob : null,
        });
        const today = (await practiceNow(db, pid)).slice(0, 10);
        await insert(db, 'tasks', { practice_id: pid, patient_id: pat, priority: 'normal', due_date: today, title: `Verify insurance from online booking: ${carrierName} ${b.insurance_member_id}` });
      }
    }
    const [h, m] = start.slice(11, 16).split(':').map(Number);
    const endMin = h * 60 + m + duration;
    const row = {
      patient_id: pat, provider_id: providerId, operatory_id: operatoryId ? Number(operatoryId) : null,
      start_time: start, end_time: `${start.slice(0, 10)} ${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`,
      status: 'scheduled', reason: b.reason, notes: b.notes,
      appointment_type_id: (await db.get('SELECT id FROM appointment_types WHERE practice_id = ? AND name = ?', pid, b.reason))?.id ?? null,
    };
    await validateAppt(db, pid, row);
    const apptId = await insert(db, 'appointments', { ...row, practice_id: pid });
    // A paid deposit is a credit on the account, applied when the visit is charged.
    let entryId = b.deposit_entry_id;
    if (b.deposit_status === 'paid' && !entryId && b.deposit_amount > 0) {
      entryId = await insert(db, 'ledger_entries', {
        practice_id: pid, patient_id: pat, type: 'payment', amount: -b.deposit_amount, method: 'credit_card', reference: b.deposit_reference,
        description: `Online booking deposit (${start.slice(0, 10)} visit)`, entry_date: (await practiceNow(db, pid)).slice(0, 10),
      });
    }
    await db.run(
      "UPDATE booking_requests SET status = 'accepted', patient_id = ?, appointment_id = ?, deposit_entry_id = ?, handled_by = ?, handled_at = datetime('now') WHERE id = ?",
      pat, apptId, entryId ?? null, userId, b.id,
    );
    return apptId;
  });
}
