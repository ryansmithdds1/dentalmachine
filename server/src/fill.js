import { insert, localNow, friendlyDateTime } from './util.js';
import { sendMessage, withinSendHours, recipientFor } from './messaging.js';
import { templatesFor, renderTemplate, patientLang, fixedText } from './templates.js';
import { validateAppt } from './routes/schedule.js';
import { publish } from './events.js';

// Filling a cancellation on its own: when a visit is cancelled with at least two hours to go, the next few
// patients who'd take it — those booked later who asked for anything sooner (ASAP), then the waitlist —
// get a text. The first to reply YES is booked into it (an ASAP patient's visit moves up); anyone after
// hears it's gone. The front desk sees what happened.
const MIN_LEAD_MIN = 120;
const minutesBetween = (a, b) => (Date.parse(`${b.replace(' ', 'T')}:00Z`) - Date.parse(`${a.replace(' ', 'T')}:00Z`)) / 60000;
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);

function fits(w, start, minutes, providerId) {
  const days = w.days ? JSON.parse(w.days) : null;
  const time = start.slice(11, 16);
  if (days && !days.includes(new Date(`${start.slice(0, 10)}T12:00:00Z`).getUTCDay())) return false;
  if (w.times === 'morning' && time >= '12:00') return false;
  if (w.times === 'afternoon' && time < '12:00') return false;
  if (w.duration && w.duration > minutes) return false;
  if (w.provider_id && w.provider_id !== providerId) return false;
  return true;
}

// Who to ask, best first: ASAP patients booked later with this provider (their visit fits the gap), then the waitlist in the order they joined.
async function candidates(db, offer, exceptPatient) {
  const minutes = minutesBetween(offer.start_time, offer.end_time);
  const asap = (await db.all(
    `SELECT a.id, a.patient_id, a.start_time, a.end_time FROM appointments a WHERE a.practice_id = ? AND a.asap = 1 AND a.status IN ('scheduled','confirmed')
     AND a.start_time > ? AND a.provider_id = ? AND a.patient_id != ? ORDER BY a.created_at, a.id`, offer.practice_id, offer.end_time, offer.provider_id, exceptPatient,
  )).filter((a) => minutesBetween(a.start_time, a.end_time) <= minutes).map((a) => ({ source: 'asap', ref_id: a.id, patient_id: a.patient_id }));
  const waiting = (await db.all("SELECT * FROM waitlist WHERE practice_id = ? AND status = 'waiting' AND patient_id != ? ORDER BY created_at, id", offer.practice_id, exceptPatient))
    .filter((w) => fits(w, offer.start_time, minutes, offer.provider_id)).map((w) => ({ source: 'waitlist', ref_id: w.id, patient_id: w.patient_id }));
  const seen = new Set();
  return [...asap, ...waiting].filter((c) => !seen.has(c.patient_id) && seen.add(c.patient_id));
}

// Each app's messenger, so a cancellation anywhere (the schedule, the confirm link, the portal) can make an
// opening without every route having to carry it.
const deps = new WeakMap();
export const registerFill = (db, messenger) => deps.set(db, messenger);
export function openSlotLater(db, appointmentId) {
  const messenger = deps.get(db);
  if (!messenger) return;
  openSlot(db, messenger, appointmentId).catch(() => {});
}

// Called whenever a visit is cancelled. Makes an opening and texts it now (or when sending hours start).
export async function openSlot(db, messenger, appointmentId, { now = new Date() } = {}) {
  const a = await db.get('SELECT a.*, p.timezone, p.auto_fill, p.send_from, p.send_until FROM appointments a JOIN practices p ON p.id = a.practice_id WHERE a.id = ?', appointmentId);
  if (!a || !a.auto_fill) return null;
  const local = localNow(a.timezone, now);
  if (minutesBetween(local, a.start_time) < MIN_LEAD_MIN) return null;
  if (await db.get("SELECT id FROM fill_offers WHERE source_appointment_id = ? AND status IN ('open','queued')", a.id)) return null;
  const id = await insert(db, 'fill_offers', {
    practice_id: a.practice_id, source_appointment_id: a.id, cancelled_patient_id: a.patient_id, provider_id: a.provider_id, operatory_id: a.operatory_id,
    start_time: a.start_time, end_time: a.end_time, status: 'queued',
  });
  await sendOffer(db, messenger, id, { now });
  return id;
}

// Texts a queued opening to the first few who fit, inside sending hours and while it's still far enough off.
export async function sendOffer(db, messenger, offerId, { now = new Date(), limit } = {}) {
  const offer = await db.get('SELECT o.*, pr.name AS practice_name, pr.phone AS practice_phone, pr.message_templates, pr.timezone, pr.send_from, pr.send_until, pr.fill_batch, pv.name AS provider_name FROM fill_offers o JOIN practices pr ON pr.id = o.practice_id JOIN providers pv ON pv.id = o.provider_id WHERE o.id = ?', offerId);
  if (!offer || offer.status !== 'queued') return 0;
  const local = localNow(offer.timezone, now);
  if (minutesBetween(local, offer.start_time) < MIN_LEAD_MIN) {
    await db.run("UPDATE fill_offers SET status = 'expired' WHERE id = ?", offer.id);
    return 0;
  }
  if (!withinSendHours(offer, local)) return 0;
  // Still free? (Someone may have booked it by hand.)
  if (await db.get("SELECT id FROM appointments WHERE practice_id = ? AND provider_id = ? AND status NOT IN ('cancelled','no_show') AND start_time < ? AND end_time > ?", offer.practice_id, offer.provider_id, offer.end_time, offer.start_time)) {
    await db.run("UPDATE fill_offers SET status = 'expired' WHERE id = ?", offer.id);
    return 0;
  }
  let sent = 0;
  for (const c of await candidates(db, offer, offer.cancelled_patient_id)) {
    if (sent >= (limit || offer.fill_batch || 5)) break;
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', c.patient_id);
    const to = await recipientFor(db, patient);
    // A reply decides it, so only texts.
    if (!to.phone || !to.sms_opt_in || to.sms_bad_at) continue;
    const lang = patientLang(to);
    const body = `${renderTemplate(templatesFor({ message_templates: offer.message_templates }, lang).fill_offer, {
      first_name: to.first_name, practice: offer.practice_name, when: friendlyDateTime(offer.start_time, lang), provider: offer.provider_name, phone: offer.practice_phone || fixedText(lang).the_office,
    })}${fixedText(lang).sms_stop}`;
    const msg = await sendMessage(db, messenger, { practiceId: offer.practice_id, patientId: patient.id, kind: 'fill_offer', channel: 'sms', to: to.phone, body });
    if (msg.status !== 'sent') continue;
    await insert(db, 'fill_offer_recipients', { offer_id: offer.id, patient_id: patient.id, source: c.source, ref_id: c.ref_id, phone: digits(to.phone), message_id: msg.id });
    if (c.source === 'waitlist') await db.run("UPDATE waitlist SET last_offered_at = datetime('now') WHERE id = ?", c.ref_id);
    sent++;
  }
  await db.run(`UPDATE fill_offers SET status = ?, sent_at = datetime('now'), offered = ? WHERE id = ?`, sent ? 'open' : 'no_takers', sent, offer.id);
  return sent;
}

// Openings waiting for sending hours, and ones that have run out of time.
export async function runFillOffers(db, messenger, { now = new Date() } = {}) {
  let sent = 0;
  for (const o of await db.all("SELECT id FROM fill_offers WHERE status = 'queued'")) sent += await sendOffer(db, messenger, o.id, { now });
  for (const o of await db.all("SELECT o.id, o.start_time, p.timezone FROM fill_offers o JOIN practices p ON p.id = o.practice_id WHERE o.status = 'open'")) {
    if (minutesBetween(localNow(o.timezone, now), o.start_time) < 60) await db.run("UPDATE fill_offers SET status = 'expired' WHERE id = ?", o.id);
  }
  return sent;
}

// A text from someone we offered an opening to, when that offer is the last thing we sent them.
export async function offerFor(db, practiceId, phone) {
  const last = (await db.all(
    "SELECT id, kind, to_address FROM messages WHERE practice_id = ? AND channel = 'sms' AND (direction IS NULL OR direction = 'outbound') AND kind != 'auto_reply' AND to_address LIKE ? ORDER BY id DESC LIMIT 50",
    practiceId, `%${digits(phone).slice(-4)}`,
  )).find((m) => digits(m.to_address) === digits(phone));
  if (!last || last.kind !== 'fill_offer') return null;
  return db.get(
    `SELECT r.*, o.status AS offer_status, o.start_time, o.end_time, o.provider_id, o.operatory_id, o.practice_id FROM fill_offer_recipients r JOIN fill_offers o ON o.id = r.offer_id
     WHERE r.message_id = ? AND r.phone = ?`, last.id, digits(phone),
  );
}

// The patient said yes. First one wins: their ASAP visit moves up, or a waitlist patient gets a new visit.
export async function claimOffer(db, recipient) {
  return db.tx(async () => {
    const offer = await db.get('SELECT * FROM fill_offers WHERE id = ?', recipient.offer_id);
    await db.run("UPDATE fill_offer_recipients SET reply = 'yes', replied_at = datetime('now') WHERE id = ?", recipient.id);
    if (offer.status !== 'open') return { won: false, offer };
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', recipient.patient_id);
    let apptId;
    let was = null;
    if (recipient.source === 'asap') {
      const current = await db.get('SELECT * FROM appointments WHERE id = ?', recipient.ref_id);
      if (!current || !['scheduled', 'confirmed'].includes(current.status)) return { won: false, offer };
      was = current.start_time;
      const length = minutesBetween(current.start_time, current.end_time);
      const end = new Date(Date.parse(`${offer.start_time.replace(' ', 'T')}:00Z`) + length * 60000).toISOString().slice(0, 16).replace('T', ' ');
      const row = { ...current, start_time: offer.start_time, end_time: end, provider_id: offer.provider_id, operatory_id: offer.operatory_id, status: 'confirmed' };
      try { await validateAppt(db, offer.practice_id, row, { overrideBlockout: true }); } catch { return { won: false, offer }; }
      await db.run("UPDATE appointments SET start_time = ?, end_time = ?, provider_id = ?, operatory_id = ?, status = 'confirmed', confirmed_at = datetime('now'), confirmed_via = 'text', asap = 0, reminder_sent_at = NULL, notice_due = NULL WHERE id = ?",
        row.start_time, row.end_time, row.provider_id, row.operatory_id, current.id);
      await db.run('DELETE FROM appointment_reminders WHERE appointment_id = ?', current.id);
      apptId = current.id;
    } else {
      const w = await db.get('SELECT * FROM waitlist WHERE id = ?', recipient.ref_id);
      const length = Math.min(w?.duration || 60, minutesBetween(offer.start_time, offer.end_time));
      const end = new Date(Date.parse(`${offer.start_time.replace(' ', 'T')}:00Z`) + length * 60000).toISOString().slice(0, 16).replace('T', ' ');
      const row = { patient_id: patient.id, provider_id: offer.provider_id, operatory_id: offer.operatory_id, start_time: offer.start_time, end_time: end, status: 'confirmed', reason: w?.reason || null };
      try { await validateAppt(db, offer.practice_id, row, { overrideBlockout: true }); } catch { return { won: false, offer }; }
      apptId = await insert(db, 'appointments', { ...row, practice_id: offer.practice_id, confirmed_at: new Date().toISOString().slice(0, 19).replace('T', ' '), confirmed_via: 'text' });
      if (w) await db.run("UPDATE waitlist SET status = 'booked' WHERE id = ?", w.id);
    }
    await db.run("UPDATE fill_offers SET status = 'filled', filled_patient_id = ?, filled_appointment_id = ?, filled_at = datetime('now') WHERE id = ?", patient.id, apptId, offer.id);
    await db.run("UPDATE fill_offer_recipients SET won = 1 WHERE id = ?", recipient.id);
    await insert(db, 'tasks', {
      practice_id: offer.practice_id, patient_id: patient.id, priority: 'normal', due_date: offer.start_time.slice(0, 10),
      title: `${patient.first_name} ${patient.last_name} took the ${friendlyDateTime(offer.start_time)} opening by text${was ? ` (moved up from ${friendlyDateTime(was)})` : ' (from the waitlist)'}.`,
    });
    publish(offer.practice_id, { type: 'schedule', dates: [...new Set([offer.start_time.slice(0, 10), ...(was ? [was.slice(0, 10)] : [])])], source: 'fill' });
    publish(offer.practice_id, { type: 'tasks' });
    return { won: true, offer, appointment_id: apptId, was };
  });
}
