import { HttpError } from './auth.js';
import { localNow } from './util.js';
import { sendMessage, preferredChannel, withinSendHours } from './messaging.js';
import { renderTemplate, templatesFor, patientLang, fixedText, subjectFor } from './templates.js';

// The recall types a practice starts with: [key, name, months, codes, active, rules]. Codes are prefixes that reset
// the type when completed (the first is the one booked). rules: age_until + adult_key (a child type until that
// age, then the adult one: applied on completion and by the nightly age check), retires (types this one
// replaces — perio maintenance retires the prophy), bundle (x-rays, exam and fluoride ride along with the
// hygiene visit: tracked and suggested when booking, but no reminders of their own). Intervals match the
// opportunity finder and the usual plan limits (BWX yearly, FMX/pano every 5 years). The office-defined starters
// (ortho check, implant maintenance, sleep appliance check) start switched off.
export const DEFAULT_RECALL_TYPES = [
  ['prophy', 'Prophy', 6, ['D1110', 'D4346'], 1, { retires: ['child_prophy'] }],
  ['child_prophy', 'Child prophy', 6, ['D1120'], 1, { age_until: 14, adult_key: 'prophy', retires: ['prophy'] }],
  ['perio_maint', 'Perio maintenance', 3, ['D4910'], 1, { retires: ['prophy', 'child_prophy'] }],
  ['exam', 'Periodic exam', 6, ['D0120', 'D0150', 'D0180'], 1, { bundle: 1 }],
  ['bwx', 'Bitewings', 12, ['D0274', 'D0272', 'D0270', 'D0273', 'D0277'], 1, { bundle: 1 }],
  ['fmx', 'Full-mouth x-rays or pano', 60, ['D0210', 'D0330'], 1, { bundle: 1 }],
  ['fluoride', 'Fluoride', 6, ['D1206', 'D1208'], 1, { bundle: 1, age_until: 19 }],
  ['ortho_check', 'Ortho check', 6, ['D8660', 'D8680'], 0, {}],
  ['implant_maint', 'Implant maintenance', 6, ['D6080', 'D6081'], 0, {}],
  ['sleep_check', 'Sleep appliance check', 12, ['D9947', 'D9948'], 0, {}],
];

// Automated recall messages: days relative to the due date (negative = before it).
export const DEFAULT_RECALL_STEPS = [{ days: -14 }, { days: 0 }, { days: 30 }, { days: 90 }];

const parseList = (v) => {
  try {
    const list = JSON.parse(v || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};
const seedRow = async (db, practiceId, [key, name, months, codes, active, rules = {}], activeOverride = null) => db.run(
  'INSERT INTO recall_types (practice_id, key, name, interval_months, codes, active, age_until, adult_key, retires, bundle) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (practice_id, key) DO NOTHING',
  practiceId, key, name, months, JSON.stringify(codes), activeOverride ?? active, rules.age_until ?? null, rules.adult_key ?? null, rules.retires ? JSON.stringify(rules.retires) : null, rules.bundle ? 1 : 0,
);

// A practice's recall types. A new practice gets the defaults; a practice set up before a default type existed
// gets it added switched off (its own setup is never changed behind its back — an administrator turns it on).
export async function recallTypes(db, practiceId) {
  const sql = 'SELECT * FROM recall_types WHERE practice_id = ? ORDER BY interval_months, name';
  let rows = await db.all(sql, practiceId);
  const have = new Set(rows.map((r) => r.key));
  const missing = DEFAULT_RECALL_TYPES.filter(([key]) => !have.has(key));
  if (missing.length) {
    for (const t of missing) await seedRow(db, practiceId, t, rows.length ? 0 : null);
    rows = await db.all(sql, practiceId);
  }
  return rows.map((t) => ({ ...t, codes: parseList(t.codes), retires: parseList(t.retires), bundle: t.bundle ? 1 : 0 }));
}

// The active recall types a procedure code resets (e.g. D1110 → prophy, D0274 → bitewings).
export const typesForCode = (types, code) => types.filter((t) => t.active && t.codes.some((c) => String(code).startsWith(c)));

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
  // A practice on the recall cadence (cadence.js) gets its recall messages from there instead.
  for (const practice of await db.all('SELECT * FROM practices WHERE recall_auto = 1 AND recall_cadence = 0')) {
    const steps = recallSteps(practice);
    if (!steps.length) continue;
    // X-rays, exam and fluoride ride along with the cleaning: they go in a message the cleaning sends, never alone.
    const bundled = new Set((await recallTypes(db, practice.id)).filter((t) => t.bundle).map((t) => t.key));
    const nowLocal = localNow(practice.timezone, now);
    if (!withinSendHours(practice, nowLocal)) continue;
    const today = nowLocal.slice(0, 10);
    const horizon = new Date(Date.parse(`${today}T12:00:00Z`) - steps[0].days * 86400000).toISOString().slice(0, 10);
    const due = await db.all(
      `SELECT r.*, p.first_name, p.phone, p.email, p.sms_opt_in, p.email_opt_in, p.language FROM recalls r JOIN patients p ON p.id = r.patient_id
       WHERE r.practice_id = ? AND r.status IN ('due','contacted') AND r.due_date <= ? AND p.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = r.patient_id AND a.start_time >= ? AND a.status IN ('scheduled','confirmed'))
       ORDER BY r.due_date`,
      practice.id, horizon, nowLocal,
    );
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
      if (!pending.length || pending.every((p) => bundled.has(p.r.type))) continue;
      // One message covers all of the patient's due recalls.
      const { r, step } = pending[0];
      const target = preferredChannel(r, step.channel === 'auto' ? undefined : step.channel);
      const message = target ? await sendMessage(db, messenger, {
        practiceId: practice.id, patientId: r.patient_id, kind: 'recall', channel: target.channel, to: target.to,
        subject: subjectFor(patientLang(r), 'recall', `Time for your visit at ${practice.name}`, practice.name),
        body: renderTemplate(templatesFor(practice, patientLang(r)).recall, { first_name: r.first_name, practice: practice.name, phone: practice.phone || fixedText(patientLang(r)).the_office, link: practice.slug ? `${appUrl}/book/${practice.slug}${patientLang(r) === 'es' ? '?lang=es' : ''}` : practice.phone || '' }),
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
