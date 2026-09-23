import { HttpError } from './auth.js';
import { insert, localNow, addMonths } from './util.js';
import { sendMessage, preferredChannel } from './messaging.js';
import { renderTemplate, templatesFor } from './templates.js';

// The recall types a practice starts with. X-ray recalls start switched off; offices that track
// them separately turn them on.
export const DEFAULT_RECALL_TYPES = [
  ['prophy', 'Prophy', 6, ['D1110', 'D1120', 'D4346'], 1],
  ['perio_maint', 'Perio maintenance', 3, ['D4910'], 1],
  ['bwx', 'Bitewings', 12, ['D0272', 'D0273', 'D0274'], 0],
  ['fmx', 'Full-mouth x-rays', 36, ['D0210'], 0],
  ['pano', 'Panoramic x-ray', 60, ['D0330'], 0],
];

// Automated recall messages: days relative to the due date (negative = before it).
export const DEFAULT_RECALL_STEPS = [{ days: -14 }, { days: 0 }, { days: 30 }, { days: 90 }];

export async function recallTypes(db, practiceId) {
  let rows = await db.all('SELECT * FROM recall_types WHERE practice_id = ? ORDER BY interval_months, name', practiceId);
  if (!rows.length) {
    for (const [key, name, months, codes, active] of DEFAULT_RECALL_TYPES) {
      await db.run(
        'INSERT INTO recall_types (practice_id, key, name, interval_months, codes, active) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (practice_id, key) DO NOTHING',
        practiceId, key, name, months, JSON.stringify(codes), active,
      );
    }
    rows = await db.all('SELECT * FROM recall_types WHERE practice_id = ? ORDER BY interval_months, name', practiceId);
  }
  return rows.map((t) => ({ ...t, codes: JSON.parse(t.codes || '[]') }));
}

// The active recall types a procedure code resets (e.g. D1110 → prophy, D0274 → bitewings).
export const typesForCode = (types, code) => types.filter((t) => t.active && t.codes.some((c) => String(code).startsWith(c)));

// Completing a recall procedure sets the next due date for each type it resets.
export async function resetRecalls(db, procedure, today) {
  for (const type of typesForCode(await recallTypes(db, procedure.practice_id), procedure.code)) {
    const existing = await db.get('SELECT * FROM recalls WHERE practice_id = ? AND patient_id = ? AND type = ?', procedure.practice_id, procedure.patient_id, type.key);
    const due = addMonths(today, existing?.interval_months ?? type.interval_months);
    if (existing) await db.run("UPDATE recalls SET due_date = ?, status = 'due', appointment_id = NULL WHERE id = ?", due, existing.id);
    else await insert(db, 'recalls', { practice_id: procedure.practice_id, patient_id: procedure.patient_id, type: type.key, interval_months: type.interval_months, due_date: due });
  }
}

export function recallSteps(practice) {
  try {
    const steps = practice.recall_steps ? JSON.parse(practice.recall_steps) : DEFAULT_RECALL_STEPS;
    return Array.isArray(steps) ? steps : DEFAULT_RECALL_STEPS;
  } catch {
    return DEFAULT_RECALL_STEPS;
  }
}

export function validateRecallSteps(steps) {
  if (!Array.isArray(steps) || steps.length > 8) throw new HttpError(400, 'recall_steps must be a list of up to 8 steps');
  const out = steps.map((s) => {
    const days = Number(s?.days);
    if (!Number.isInteger(days) || days < -60 || days > 730) throw new HttpError(400, 'Each recall step is -60 to 730 days from the due date');
    if (s.channel && !['auto', 'sms', 'email'].includes(s.channel)) throw new HttpError(400, 'channel must be auto, sms or email');
    return { days, channel: s.channel || 'auto' };
  });
  if (new Set(out.map((s) => s.days)).size !== out.length) throw new HttpError(400, 'Two recall steps fall on the same day');
  return out.sort((a, b) => a.days - b.days);
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

// Automated recall: for patients due (or overdue) with nothing booked, send the latest sequence step
// they haven't had yet. One message per patient per run, however many recalls they have due.
export async function runRecallSequences(db, messenger, { appUrl, now = new Date() } = {}) {
  let sent = 0;
  for (const practice of await db.all('SELECT * FROM practices WHERE recall_auto = 1')) {
    const steps = recallSteps(practice);
    if (!steps.length) continue;
    const nowLocal = localNow(practice.timezone, now);
    const today = nowLocal.slice(0, 10);
    const horizon = new Date(Date.parse(`${today}T12:00:00Z`) - steps[0].days * 86400000).toISOString().slice(0, 10);
    const due = await db.all(
      `SELECT r.*, p.first_name, p.phone, p.email, p.sms_opt_in, p.email_opt_in FROM recalls r JOIN patients p ON p.id = r.patient_id
       WHERE r.practice_id = ? AND r.status IN ('due','contacted') AND r.due_date <= ? AND p.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = r.patient_id AND a.start_time >= ? AND a.status IN ('scheduled','confirmed'))
       ORDER BY r.due_date`,
      practice.id, horizon, nowLocal,
    );
    const templates = templatesFor(practice);
    const byPatient = new Map();
    for (const r of due) {
      if (!byPatient.has(r.patient_id)) byPatient.set(r.patient_id, []);
      byPatient.get(r.patient_id).push(r);
    }
    for (const recalls of byPatient.values()) {
      // Each recall's latest step it hasn't had yet. Steps are recorded once; a patient first found a
      // year overdue gets only the latest step.
      const pending = [];
      for (const r of recalls) {
        const step = [...steps].reverse().find((st) => st.days <= daysBetween(r.due_date, today));
        if (step && !(await db.get('SELECT 1 AS x FROM recall_contacts WHERE recall_id = ? AND step >= ?', r.id, step.days))) pending.push({ r, step });
      }
      if (!pending.length) continue;
      // One message covers all of the patient's due recalls.
      const { r, step } = pending[0];
      const target = preferredChannel(r, step.channel === 'auto' ? undefined : step.channel);
      const message = target ? await sendMessage(db, messenger, {
        practiceId: practice.id, patientId: r.patient_id, kind: 'recall', channel: target.channel, to: target.to,
        subject: `Time for your visit at ${practice.name}`,
        body: renderTemplate(templates.recall, { first_name: r.first_name, practice: practice.name, phone: practice.phone || 'the office', link: practice.slug ? `${appUrl}/book/${practice.slug}` : practice.phone || '' }),
      }) : null;
      if (message?.status === 'sent') sent++;
      for (const p of pending) {
        await db.run('INSERT INTO recall_contacts (recall_id, step, message_id) VALUES (?, ?, ?) ON CONFLICT (recall_id, step) DO NOTHING', p.r.id, p.step.days, message?.id ?? null);
        if (message?.status === 'sent') await db.run("UPDATE recalls SET status = 'contacted', last_contacted_at = datetime('now') WHERE id = ?", p.r.id);
      }
    }
  }
  return sent;
}
