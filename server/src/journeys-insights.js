import { PdfDoc } from './pdf.js';
import { can } from './auth.js';
import { appointmentScope } from './officeaccess.js';
import { npsScore } from './surveys.js';
import { addDays } from './cadence.js';
import { ensureJourneySetup, firstVisitIds, personalNotes, doctorName, birthdayIn } from './journeys.js';

// What the team sees and the owner measures (PX6, PX7): the huddle's "moments" card, NPS by provider and office,
// and the "patient delight" score. Read-only.

const nameOf = (p) => `${p.first_name} ${p.last_name}`;
const IN = (list) => list.map(() => '?').join(',');
const excerpt = (s, n = 140) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

// The morning huddle's moments for one day: today's birthdays, first visits, milestones, patients who had a hard
// last visit and personal notes worth mentioning — so the team can make it personal in person.
export async function huddleMoments(db, user, { date }) {
  const pid = user.practice_id;
  await ensureJourneySetup(db, pid);
  const scope = appointmentScope(user);
  const appts = await db.all(
    `SELECT a.id, a.patient_id, a.start_time, a.status, a.provider_id, p.first_name, p.last_name, p.preferred_name, p.dob FROM appointments a JOIN patients p ON p.id = a.patient_id
     WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ('cancelled','no_show')${scope.sql} ORDER BY a.start_time`,
    pid, `${date} 00:00`, `${date} 24:00`, ...scope.args,
  );
  const firstAppt = new Map();
  for (const a of appts) if (!firstAppt.has(a.patient_id)) firstAppt.set(a.patient_id, a);
  const ids = [...firstAppt.keys()];
  const who = (a, extra) => ({ patient_id: a.patient_id, name: nameOf(a), preferred_name: a.preferred_name || null, time: a.start_time?.slice(11, 16) || null, appointment_id: a.id ?? null, ...extra });
  const year = Number(date.slice(0, 4));

  const birthdays = [...firstAppt.values()].filter((a) => a.dob && birthdayIn(a.dob, year) === date).map((a) => who(a, { age: year - Number(a.dob.slice(0, 4)), scheduled: true }));
  // Birthdays of patients not coming in today (to text or call), a short list.
  const mds = [date.slice(5), ...(date.endsWith('-02-28') ? ['02-29'] : [])];
  const others = (await db.all(
    `SELECT id AS patient_id, first_name, last_name, preferred_name, dob FROM patients WHERE practice_id = ? AND status = 'active' AND merged_into_id IS NULL AND dob IS NOT NULL AND substr(dob, 6, 5) IN (${IN(mds)}) ORDER BY last_name, first_name LIMIT 60`,
    pid, ...mds,
  )).filter((p) => !firstAppt.has(p.patient_id) && birthdayIn(p.dob, year) === date);

  const firsts = await firstVisitIds(db, pid, appts);
  const firstVisits = appts.filter((a) => firsts.has(a.id)).map((a) => who(a));

  const milestones = (await db.all(
    `SELECT m.*, p.first_name, p.last_name, p.preferred_name FROM journey_moments m JOIN patients p ON p.id = m.patient_id
     WHERE m.practice_id = ? AND m.kind IN ('braces_off','cavity_free') AND m.status = 'suggested' AND (m.detected_on >= ?${ids.length ? ` OR m.patient_id IN (${IN(ids)})` : ''}) ORDER BY m.detected_on DESC LIMIT 50`,
    pid, addDays(date, -14), ...ids,
  )).map((m) => ({ moment_id: m.id, patient_id: m.patient_id, name: nameOf(m), kind: m.kind, detail: m.detail, detected_on: m.detected_on, time: firstAppt.get(m.patient_id)?.start_time.slice(11, 16) || null, certificate: true }));

  const hard = [];
  if (ids.length) {
    const since = `${addDays(date, -180)} 00:00`;
    const add = (patientId, detail, extra = {}) => {
      const a = firstAppt.get(patientId);
      const had = hard.find((h) => h.patient_id === patientId);
      if (had) had.reasons.push(detail);
      else hard.push({ ...who(a), reasons: [detail], ...extra });
    };
    for (const r of await db.all(`SELECT patient_id, nps, answered_at FROM survey_responses WHERE practice_id = ? AND patient_id IN (${IN(ids)}) AND nps IS NOT NULL AND nps <= 6 AND answered_at >= ? ORDER BY answered_at DESC`, pid, ...ids, since)) {
      add(r.patient_id, `Scored us ${r.nps}/10 on ${r.answered_at.slice(0, 10)}`);
    }
    for (const r of await db.all(`SELECT patient_id, rating, sent_at FROM review_feedback WHERE practice_id = ? AND patient_id IN (${IN(ids)}) AND rating IS NOT NULL AND rating <= 3 AND sent_at >= ?`, pid, ...ids, since)) {
      add(r.patient_id, `Rated their visit ${r.rating}★ (${r.sent_at.slice(0, 10)})`);
    }
    for (const r of await db.all(`SELECT patient_id, reply, visit_date FROM journey_checkins WHERE practice_id = ? AND patient_id IN (${IN(ids)}) AND reply >= 2 AND visit_date >= ?`, pid, ...ids, addDays(date, -60))) {
      add(r.patient_id, r.reply === 3 ? `Asked to talk after their visit on ${r.visit_date}` : `Had some discomfort after their visit on ${r.visit_date}`);
    }
  }

  const notes = [];
  if (ids.length && can(user, 'patients:read')) {
    const byPatient = await personalNotes(db, pid, ids);
    for (const [patientId, list] of byPatient) if (list.length) notes.push({ ...who(firstAppt.get(patientId)), notes: list.map((n) => excerpt(n)) });
  }
  const lifeEvents = (await db.all(
    `SELECT m.*, p.first_name, p.last_name, p.preferred_name FROM journey_moments m JOIN patients p ON p.id = m.patient_id
     WHERE m.practice_id = ? AND m.kind = 'life_event' AND m.status = 'suggested' AND m.detected_on >= ? ORDER BY m.detected_on DESC LIMIT 30`, pid, addDays(date, -14),
  )).map((m) => ({ moment_id: m.id, patient_id: m.patient_id, name: nameOf(m), detail: m.detail, time: firstAppt.get(m.patient_id)?.start_time.slice(11, 16) || null }));

  const cards = await db.get("SELECT COUNT(*) AS n FROM journey_cards c JOIN tasks t ON t.id = c.task_id WHERE c.practice_id = ? AND t.status = 'open'", pid);
  return {
    date, birthdays, other_birthdays: others.map((p) => ({ patient_id: p.patient_id, name: nameOf(p), preferred_name: p.preferred_name || null })),
    first_visits: firstVisits, milestones, hard_visits: hard, notes, life_events: lifeEvents, cards_to_write: Number(cards?.n) || 0,
    total: birthdays.length + firstVisits.length + milestones.length + hard.length + lifeEvents.length,
  };
}

// NPS by month, and by provider or office, from answered surveys tied to a visit.
export async function npsTrend(db, pid, { from, to, by = 'provider' }) {
  const rows = await db.all(
    `SELECT r.nps, substr(r.answered_at, 1, 7) AS month, a.provider_id, pv.name AS provider_name, a.location_id, l.name AS location_name
     FROM survey_responses r LEFT JOIN appointments a ON a.id = r.appointment_id LEFT JOIN providers pv ON pv.id = a.provider_id LEFT JOIN locations l ON l.id = a.location_id
     WHERE r.practice_id = ? AND r.nps IS NOT NULL AND r.answered_at >= ? AND r.answered_at < ?`, pid, `${from} 00:00`, `${to} 24:00`,
  );
  const months = new Map();
  const groups = new Map();
  for (const r of rows) {
    if (!months.has(r.month)) months.set(r.month, []);
    months.get(r.month).push(r.nps);
    const key = by === 'location' ? r.location_id ?? 0 : r.provider_id ?? 0;
    const label = by === 'location' ? r.location_name || 'No office' : r.provider_name ? doctorName({ name: r.provider_name }) : 'No provider';
    if (!groups.has(key)) groups.set(key, { id: key || null, name: label, values: [], months: new Map() });
    const g = groups.get(key);
    g.values.push(r.nps);
    if (!g.months.has(r.month)) g.months.set(r.month, []);
    g.months.get(r.month).push(r.nps);
  }
  const all = rows.map((r) => r.nps);
  return {
    from, to, by, nps: npsScore(all), responses: all.length,
    months: [...months.entries()].sort().map(([month, v]) => ({ month, nps: npsScore(v), responses: v.length })),
    groups: [...groups.values()].map((g) => ({ id: g.id, name: g.name, nps: npsScore(g.values), responses: g.values.length, months: [...g.months.entries()].sort().map(([month, v]) => ({ month, nps: npsScore(v), responses: v.length })) }))
      .sort((a, b) => b.responses - a.responses),
  };
}

// "Patient delight" (0–100): the average of what we can measure — NPS (−100…100 mapped to 0…100), review
// ratings (1–5★ as a share of 5) and post-op check-ins answered "doing well". Each part is shown, with its count.
export async function delightScore(db, pid, { from, to }) {
  const range = [`${from} 00:00`, `${to} 24:00`];
  const nps = (await db.all('SELECT nps FROM survey_responses WHERE practice_id = ? AND nps IS NOT NULL AND answered_at >= ? AND answered_at < ?', pid, ...range)).map((r) => r.nps);
  const ratings = (await db.all('SELECT rating FROM review_feedback WHERE practice_id = ? AND rating IS NOT NULL AND sent_at >= ? AND sent_at < ?', pid, ...range)).map((r) => r.rating);
  const replies = (await db.all('SELECT reply FROM journey_checkins WHERE practice_id = ? AND reply IS NOT NULL AND visit_date >= ? AND visit_date <= ?', pid, from, to)).map((r) => r.reply);
  const parts = [];
  const n = npsScore(nps);
  if (n != null) parts.push({ key: 'nps', label: 'Would recommend us (NPS)', value: n, score: Math.round((n + 100) / 2), count: nps.length });
  if (ratings.length) {
    const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    parts.push({ key: 'ratings', label: 'Visit ratings', value: Math.round(avg * 10) / 10, score: Math.round((avg / 5) * 100), count: ratings.length });
  }
  if (replies.length) {
    const good = replies.filter((r) => r === 1).length;
    parts.push({ key: 'postop', label: 'Feeling good after surgery', value: good, score: Math.round((good / replies.length) * 100), count: replies.length });
  }
  const unhappy = nps.filter((v) => v <= 6).length + ratings.filter((v) => v <= 3).length + replies.filter((v) => v === 3).length;
  return { from, to, score: parts.length ? Math.round(parts.reduce((a, p) => a + p.score, 0) / parts.length) : null, parts, unhappy };
}

// A printable certificate for a milestone (braces off, a first cavity-free checkup).
export function certificatePdf({ practice, patient, moment, doctor }) {
  const doc = new PdfDoc({ footer: practice.name });
  const what = moment.kind === 'braces_off' ? 'got their braces off' : 'had a cavity-free checkup';
  doc.space(90);
  doc.text('Certificate of Achievement', { size: 34, bold: true, color: [0.06, 0.46, 0.43] });
  doc.space(20);
  doc.text('This certifies that', { size: 16 });
  doc.space(6);
  doc.text(`${patient.preferred_name || patient.first_name} ${patient.last_name}`, { size: 30, bold: true });
  doc.space(6);
  doc.text(`${what}!`, { size: 20 });
  doc.space(24);
  doc.text(moment.kind === 'braces_off' ? 'All that patience paid off — show off that smile!' : 'Great brushing, great flossing, great job. Keep up the super smile!', { size: 14 });
  doc.space(60);
  doc.rule();
  doc.text(`${doctor || practice.name}    ·    ${new Date(`${moment.detected_on}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`, { size: 12 });
  doc.text(practice.name, { size: 12, bold: true });
  return doc.toBuffer();
}
