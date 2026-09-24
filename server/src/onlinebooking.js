import { HttpError } from './auth.js';
import { insert, practiceNow } from './util.js';
import { validateAppt } from './routes/schedule.js';
import { findDuplicates } from './routes/patients.js';
import { savePolicy } from './benefits.js';
import { emitAppointment } from './webhooks.js';

// Which chart an online booking is for. An existing patient booking online shouldn't become a second chart, but
// anyone can type a name into a public form: it joins a chart only when the birth date and the phone or email on
// file all match (sure). A near miss (same name, or same birthday and last name…) is never merged: it gets a new
// chart and a task to merge it if it's the same person.
export async function matchPatient(db, practiceId, b) {
  const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
  const found = (await findDuplicates(db, practiceId, { first_name: b.first_name, last_name: b.last_name, dob: b.dob, phone: b.phone, email: b.email }))
    .filter((m) => m.status !== 'archived' && m.last_name.toLowerCase() === String(b.last_name || '').toLowerCase());
  const sure = found.find((m) => b.dob && m.dob === b.dob
    && ((digits(b.phone).length === 10 && digits(m.phone) === digits(b.phone)) || (b.email && m.email && m.email.toLowerCase() === String(b.email).toLowerCase())));
  return { sure: sure ?? null, nearMiss: sure ? null : found[0] ?? null };
}

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
    const chosen = !!patientId; // the office picked the chart
    const today = (await practiceNow(db, pid)).slice(0, 10);
    let nearMiss = null;
    if (!pat) {
      const m = await matchPatient(db, pid, b);
      pat = m.sure?.id ?? null;
      nearMiss = m.nearMiss;
    }
    const existing = !!pat;
    if (!pat) {
      pat = await insert(db, 'patients', {
        practice_id: pid, first_name: b.first_name, last_name: b.last_name, dob: b.dob, phone: b.phone, email: b.email,
        referral_source: b.referral_source || 'Online booking', notes: b.notes ? `Online booking note: ${b.notes}` : null, language: b.language === 'es' ? 'Spanish' : null,
      });
      if (nearMiss) {
        await insert(db, 'tasks', { practice_id: pid, patient_id: pat, priority: 'normal', due_date: today, title: `Online booking may be ${nearMiss.first_name} ${nearMiss.last_name} (chart #${nearMiss.id}) — check and merge if so` });
      }
    }
    if (b.insurance_carrier && b.insurance_member_id && existing && !chosen) {
      // An existing chart's insurance isn't changed from a public form: the office reviews it first.
      const holder = b.insurance_subscriber ? String(b.insurance_subscriber) : `${b.first_name} ${b.last_name}`;
      await insert(db, 'insurance_updates', {
        practice_id: pid, patient_id: pat, carrier_name: String(b.insurance_carrier).trim(), member_id: String(b.insurance_member_id), subscriber_name: holder,
        relationship: holder.toLowerCase() === `${b.first_name} ${b.last_name}`.toLowerCase() ? 'self' : 'other', note: 'Entered when booking online',
      });
    } else if (b.insurance_carrier && b.insurance_member_id) {
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
        await insert(db, 'tasks', { practice_id: pid, patient_id: pat, priority: 'normal', due_date: today, title: `Verify insurance from online booking: ${carrierName} ${b.insurance_member_id}` });
      }
    }
    // Insurance card photos sent with an online booking are filed in the chart and wait, with anything typed,
    // for the office to read and confirm them (Insurance tab); nothing becomes a policy without a person.
    const cards = b.card_files ? JSON.parse(b.card_files) : [];
    if (cards.length) {
      const docIds = [];
      for (const [i, c] of cards.entries()) {
        docIds.push(await insert(db, 'documents', {
          practice_id: pid, patient_id: pat, category: 'insurance_card', filename: `Insurance card ${i ? 'back' : 'front'} (online booking).${c.mime === 'image/png' ? 'png' : 'jpg'}`,
          mime: c.mime, size: c.size, storage_key: c.storage_key, encrypted: c.encrypted ? 1 : 0, notes: 'Sent when booking online',
        }));
      }
      const typed = b.insurance_carrier && b.insurance_member_id && existing && !chosen;
      if (typed) {
        await db.run("UPDATE insurance_updates SET document_ids = ? WHERE id = (SELECT MAX(id) FROM insurance_updates WHERE patient_id = ? AND status = 'pending')", JSON.stringify(docIds), pat);
      } else {
        await insert(db, 'insurance_updates', {
          practice_id: pid, patient_id: pat, carrier_name: b.insurance_carrier ? String(b.insurance_carrier).trim() : null, member_id: b.insurance_member_id || null,
          subscriber_name: b.insurance_subscriber || null, document_ids: JSON.stringify(docIds), note: 'Card photo sent when booking online',
        });
      }
    }
    operatoryId = operatoryId || b.operatory_id || null;
    const [h, m] = start.slice(11, 16).split(':').map(Number);
    const endMin = h * 60 + m + duration;
    const row = {
      patient_id: pat, provider_id: providerId, operatory_id: operatoryId ? Number(operatoryId) : null,
      start_time: start, end_time: `${start.slice(0, 10)} ${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`,
      status: 'scheduled', reason: b.reason, notes: b.notes, location_id: b.location_id ?? null,
      ...(b.online_booking_id ? { online_booking_id: b.online_booking_id } : {}), ...(b.asap ? { asap: 1 } : {}),
    };
    const type = await db.get('SELECT id, pattern FROM appointment_types WHERE practice_id = ? AND name = ?', pid, b.reason);
    row.appointment_type_id = type?.id ?? null;
    if (type?.pattern) row.pattern = type.pattern;
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
      "UPDATE booking_requests SET status = 'accepted', patient_id = ?, appointment_id = ?, deposit_entry_id = ?, possible_duplicate_id = ?, handled_by = ?, handled_at = datetime('now') WHERE id = ?",
      pat, apptId, entryId ?? null, nearMiss?.id ?? null, userId, b.id,
    );
    return apptId;
  }).then(async (apptId) => {
    await emitAppointment(db, apptId, 'appointment.created');
    return apptId;
  });
}
