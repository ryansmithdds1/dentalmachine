import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './auth.js';
import { insert, audit, localNow, hashToken, recorded, friendlyDateTime } from './util.js';
import { withActor } from './actor.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { sendMessage, withinSendHours, recipientFor, isOptedOutAddress } from './messaging.js';
import { renderTemplate, patientLang, fixedText } from './templates.js';
import { mailable } from './mail.js';
import { publish } from './events.js';
import { recallCadence } from './cadence-recall.js';

// ---- The cadence engine ----
// A cadence is a sequence of steps around an anchor date — "30 days before the recall is due: a text with a
// link to book; on the due date: a text; 30 days after: a call…" — that runs on its own until a stop
// condition ends it (a visit booked, the patient declined or opted out). Recall (RC1–RC4) is the first user;
// treatment follow-up (TF) plugs in as another type. A type supplies:
//   label                      'Recall'
//   enabled(practice)          is the practice running it
//   defaultSequences(db, pid)  [{ subtype, name, steps: [{ offset_days, channel, template, subject?, conditions?, repeat_days?, repeat_max? }] }]
//   candidates(db, practice, { today, windows })  who should be on it: [{ patient_id, subtype, source_type, source_id, anchor_date, location_id }]
//                              (windows[subtype] = { from, to }: the anchor dates worth enrolling now)
//   stopCheck(db, enrollment, { today, nowLocal })  null to carry on, or { reason, appointment_id? } to stop
//   describe(db, enrollments)  words for the message: { visit: 'checkup and cleaning' }
//   afterSend(db, enrollments) (optional) bookkeeping on the source rows (recall → contacted)
//   linkPath                   the patient page a message's link opens (/rb/<token>), or null for none
// Everything the job does runs as the automation actor; AI calls are recorded as 'ai'. The engine never sends
// a step twice: each (enrollment, step, occurrence) is claimed by inserting its cadence_runs row first.

export const CHANNELS = ['text', 'email', 'ai_call', 'task_call', 'letter', 'postcard'];
export const CHANNEL_LABELS = { text: 'Text', email: 'Email', ai_call: 'AI call', task_call: 'Call (team)', letter: 'Letter', postcard: 'Postcard' };
// Where a step goes when its own channel can't reach the patient or fails.
export const DEFAULT_FALLBACK = { text: ['email'], email: ['text'], ai_call: ['task_call'], task_call: [], letter: ['email'], postcard: ['email'] };
export const STOP_REASONS = {
  booked: 'Booked a visit', declined: 'Declined', opted_out: 'Opted out of messages', inactive: 'Patient inactive', deceased: 'Deceased', moved: 'Moved away',
  no_contact: 'Asked not to be contacted', other: 'Stopped by the office', recall_done: 'Recall done', recall_inactive: 'Recall switched off', recall_changed: 'Due date changed',
  sequence_off: 'Sequence switched off', manual: 'Stopped by the office',
};
const MAX_OVERDUE_DAYS = 730; // older than this, a recall is a reactivation campaign's job, not the cadence's
const RETRIES = 3;
const LINK_DAYS = 60;

const TYPES = new Map();
export function registerCadenceType(type, def) {
  TYPES.set(type, def);
}
export const cadenceType = (type) => TYPES.get(type);
export const cadenceTypes = () => [...TYPES.keys()];
registerCadenceType('recall', recallCadence);

// ---- Dates (practice-local calendar days, 'YYYY-MM-DD') ----
export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);
export const practiceToday = (practice, now = new Date()) => localNow(practice.timezone || 'America/New_York', now).slice(0, 10);
const utcStamp = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// Every (step, occurrence) whose date has come (on or before today), oldest first. A step with repeat_days
// comes round again every repeat_days after its first date, up to repeat_max more times.
export function dueOccurrences(steps, anchorDate, today) {
  const out = [];
  for (const s of steps) {
    if (s.active === 0) continue;
    const first = addDays(anchorDate, Number(s.offset_days));
    if (first > today) continue;
    out.push({ step: s, occurrence: 0, due_date: first });
    if (Number(s.repeat_days) > 0) {
      for (let k = 1; k <= Number(s.repeat_max ?? 8); k++) {
        const d = addDays(first, k * Number(s.repeat_days));
        if (d > today) break;
        out.push({ step: s, occurrence: k, due_date: d });
      }
    }
  }
  return out.sort((a, b) => a.due_date.localeCompare(b.due_date) || (a.step.position ?? 0) - (b.step.position ?? 0));
}

// The whole timeline (past and future) for showing a patient's cadence: every occurrence with its date.
export function timeline(steps, anchorDate) {
  const out = [];
  for (const s of steps) {
    if (s.active === 0) continue;
    const first = addDays(anchorDate, Number(s.offset_days));
    out.push({ step: s, occurrence: 0, due_date: first });
    if (Number(s.repeat_days) > 0) for (let k = 1; k <= Number(s.repeat_max ?? 8); k++) out.push({ step: s, occurrence: k, due_date: addDays(first, k * Number(s.repeat_days)) });
  }
  return out.sort((a, b) => a.due_date.localeCompare(b.due_date) || (a.step.position ?? 0) - (b.step.position ?? 0));
}

// ---- Sequences ----
export const parseConditions = (v) => {
  try {
    const o = typeof v === 'string' ? JSON.parse(v || '{}') : v || {};
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
};

// Validates a sequence's steps as sent by the editor. Throws a 400 with a plain explanation.
export async function validateSteps(db, practiceId, steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 20) throw new HttpError(400, 'A sequence has 1 to 20 steps');
  const out = steps.map((s, i) => {
    const offset = Number(s?.offset_days);
    if (!Number.isInteger(offset) || offset < -180 || offset > 1095) throw new HttpError(400, `Step ${i + 1}: the day must be a whole number from -180 to 1095 (days from the due date)`);
    if (!CHANNELS.includes(s.channel)) throw new HttpError(400, `Step ${i + 1}: choose text, email, AI call, team call, letter or postcard`);
    const template = String(s.template ?? '').trim();
    if (!template) throw new HttpError(400, `Step ${i + 1}: write what it says`);
    if (template.length > 1500) throw new HttpError(400, `Step ${i + 1}: keep the wording under 1500 characters`);
    const cond = parseConditions(s.conditions);
    const fallback = Array.isArray(cond.fallback) ? cond.fallback.filter((c) => CHANNELS.includes(c) && c !== s.channel).slice(0, 3) : undefined;
    const assignTo = cond.assign_to ? Number(cond.assign_to) : null;
    const repeatDays = s.repeat_days == null || s.repeat_days === '' ? null : Number(s.repeat_days);
    if (repeatDays != null && (!Number.isInteger(repeatDays) || repeatDays < 7 || repeatDays > 365)) throw new HttpError(400, `Step ${i + 1}: repeat every 7 to 365 days`);
    const repeatMax = repeatDays ? Math.min(Math.max(Number(s.repeat_max) || 4, 1), 12) : null;
    return {
      id: s.id ? Number(s.id) : null, offset_days: offset, channel: s.channel, template, subject: s.subject ? String(s.subject).trim().slice(0, 200) : null,
      conditions: { ...(fallback ? { fallback } : {}), ...(assignTo ? { assign_to: assignTo } : {}) }, repeat_days: repeatDays, repeat_max: repeatMax,
    };
  });
  for (const s of out) {
    if (s.conditions.assign_to && !(await db.get('SELECT id FROM users WHERE id = ? AND practice_id = ? AND active = 1', s.conditions.assign_to, practiceId))) {
      throw new HttpError(400, 'Call tasks can only go to someone on the team');
    }
  }
  const keys = out.map((s) => `${s.offset_days}:${s.channel}`);
  if (new Set(keys).size !== keys.length) throw new HttpError(400, 'Two steps are the same channel on the same day');
  return out.sort((a, b) => a.offset_days - b.offset_days).map((s, i) => ({ ...s, position: i }));
}

async function addSteps(db, practiceId, sequenceId, steps) {
  for (const [i, s] of steps.entries()) {
    await insert(db, 'cadence_steps', {
      practice_id: practiceId, sequence_id: sequenceId, position: s.position ?? i, offset_days: s.offset_days, channel: s.channel, template: s.template,
      subject: s.subject ?? null, conditions: JSON.stringify(s.conditions || {}), repeat_days: s.repeat_days ?? null, repeat_max: s.repeat_max ?? null,
    });
  }
}

// The practice's sequences of a type, making the defaults the first time (and for a new recall type).
export async function ensureSequences(db, practiceId, type) {
  const def = cadenceType(type);
  if (!def) throw new HttpError(404, 'Unknown cadence type');
  for (const d of await def.defaultSequences(db, practiceId)) {
    const { changes, id } = await db.run(
      'INSERT INTO cadence_sequences (practice_id, type, subtype, name) VALUES (?, ?, ?, ?) ON CONFLICT (practice_id, type, subtype) DO NOTHING',
      practiceId, type, d.subtype, d.name,
    );
    if (changes && id) await addSteps(db, practiceId, id, d.steps.map((s, i) => ({ ...s, position: i })));
  }
  return sequencesFor(db, practiceId, type);
}

export async function sequencesFor(db, practiceId, type) {
  const seqs = await db.all('SELECT * FROM cadence_sequences WHERE practice_id = ? AND type = ? ORDER BY id', practiceId, type);
  for (const s of seqs) s.steps = await stepsFor(db, s.id);
  return seqs;
}
export const stepsFor = async (db, sequenceId, { all = false } = {}) => (await db.all(
  `SELECT * FROM cadence_steps WHERE sequence_id = ?${all ? '' : ' AND active = 1'} ORDER BY position, offset_days, id`, sequenceId,
)).map((s) => ({ ...s, conditions: parseConditions(s.conditions) }));

// Saves an edited sequence. Steps keep their id when edited (their runs stay attached); a removed step is
// switched off rather than deleted, because runs point at it.
export async function saveSequence(db, req, sequence, body) {
  const pid = sequence.practice_id;
  const steps = body.steps ? await validateSteps(db, pid, body.steps) : null;
  const before = { name: sequence.name, active: sequence.active, family_window_days: sequence.family_window_days, steps: JSON.stringify((await stepsFor(db, sequence.id)).map(stepSummary)) };
  const row = {};
  if (body.name != null) {
    row.name = String(body.name).trim().slice(0, 80);
    if (!row.name) throw new HttpError(400, 'Give the sequence a name');
  }
  if (body.active != null) row.active = body.active ? 1 : 0;
  if (body.family_window_days != null) {
    const n = Number(body.family_window_days);
    if (!Number.isInteger(n) || n < 0 || n > 120) throw new HttpError(400, 'Family members due within 0 to 120 days are grouped');
    row.family_window_days = n;
  }
  await db.tx(async () => {
    if (Object.keys(row).length) {
      await db.run(`UPDATE cadence_sequences SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND practice_id = ?`, ...Object.values(row), req.user.id, sequence.id, pid);
    }
    if (steps) {
      const existing = await stepsFor(db, sequence.id);
      const keep = new Set();
      for (const s of steps) {
        const match = s.id && existing.find((e) => e.id === s.id);
        if (match) {
          keep.add(match.id);
          await db.run('UPDATE cadence_steps SET position = ?, offset_days = ?, channel = ?, template = ?, subject = ?, conditions = ?, repeat_days = ?, repeat_max = ? WHERE id = ?',
            s.position, s.offset_days, s.channel, s.template, s.subject, JSON.stringify(s.conditions), s.repeat_days, s.repeat_max, match.id);
        } else await addSteps(db, pid, sequence.id, [s]);
      }
      for (const e of existing) if (!keep.has(e.id)) await db.run('UPDATE cadence_steps SET active = 0 WHERE id = ?', e.id);
      await db.run("UPDATE cadence_sequences SET updated_by = ?, updated_at = datetime('now') WHERE id = ?", req.user.id, sequence.id);
    }
  });
  const after = await db.get('SELECT * FROM cadence_sequences WHERE id = ?', sequence.id);
  await audit(db, req, 'cadence.sequence.update', 'cadence_sequences', sequence.id, { type: sequence.type, subtype: sequence.subtype }, {
    before, after: { name: after.name, active: after.active, family_window_days: after.family_window_days, steps: JSON.stringify((await stepsFor(db, sequence.id)).map(stepSummary)) },
  });
  return { ...after, steps: await stepsFor(db, sequence.id) };
}
const stepSummary = (s) => `${s.offset_days >= 0 ? '+' : ''}${s.offset_days}d ${s.channel}${s.repeat_days ? ` every ${s.repeat_days}d x${s.repeat_max}` : ''}`;

// Back to the recommended steps (the old steps are switched off, not deleted).
export async function resetSequence(db, req, sequence) {
  const d = (await cadenceType(sequence.type).defaultSequences(db, sequence.practice_id)).find((x) => x.subtype === sequence.subtype);
  if (!d) throw new HttpError(404, 'No recommended sequence for this one');
  return saveSequence(db, req, sequence, { steps: d.steps });
}

// ---- Self-scheduling links ----
// The token is "<row id>.<signature>": the signature is an HMAC of the row's id, practice and expiry with the
// server's secret, so a link can't be guessed or altered; only a hash of it is stored. Expired links answer 410.
const sign = (secret, id, practiceId, expires) => createHmac('sha256', String(secret)).update(`cadence-link:${id}:${practiceId}:${expires}`).digest('base64url').slice(0, 22);
export async function createLink(db, secret, { practiceId, recipientId, runId = null, enrollmentIds, days = LINK_DAYS, now = new Date() }) {
  const expires = utcStamp(new Date(now.getTime() + days * 86400_000));
  const { id } = await db.run(
    'INSERT INTO cadence_links (practice_id, recipient_id, run_id, enrollment_ids, sig_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    practiceId, recipientId, runId, JSON.stringify(enrollmentIds.map(Number)), 'pending', expires,
  );
  const sig = sign(secret, id, practiceId, expires);
  await db.run('UPDATE cadence_links SET sig_hash = ? WHERE id = ?', hashToken(sig), id);
  return { id, token: `${id}.${sig}`, expires_at: expires };
}
export async function verifyLink(db, secret, token, { now = new Date() } = {}) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
  if (!m) throw new HttpError(404, 'This link is not valid');
  const link = await db.get('SELECT * FROM cadence_links WHERE id = ?', Number(m[1]));
  if (!link) throw new HttpError(404, 'This link is not valid');
  const expected = Buffer.from(sign(secret, link.id, link.practice_id, link.expires_at));
  const given = Buffer.from(m[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given) || hashToken(m[2]) !== link.sig_hash) throw new HttpError(404, 'This link is not valid');
  if (link.expires_at < utcStamp(now)) throw new HttpError(410, 'This link has expired — call us, or reply to our text, and we’ll find you a time');
  return { ...link, enrollment_ids: JSON.parse(link.enrollment_ids) };
}

// ---- Stops ----
// Holds (deceased, moved, don't contact) and the patient's own state apply to every type.
export async function activeHold(db, patientId, type) {
  return db.get('SELECT * FROM cadence_holds WHERE patient_id = ? AND released_at IS NULL AND (type IS NULL OR type = ?) ORDER BY id DESC LIMIT 1', patientId, type);
}
// Opted out of every electronic channel: texts (off, or the number replied STOP) and email (off, or unsubscribed).
export async function optedOutOfAll(db, patient) {
  const textOff = !patient.sms_opt_in || (patient.phone && await isOptedOutAddress(db, patient.practice_id, 'sms', patient.phone));
  const emailOff = !patient.email_opt_in || (patient.email && await isOptedOutAddress(db, patient.practice_id, 'email', patient.email));
  return !!(textOff && emailOff);
}
// Why a patient shouldn't be on (or stay on) a cadence of this type, or null.
export async function skipReason(db, patient, type) {
  if (!patient || patient.status !== 'active' || patient.merged_into_id) return 'inactive';
  const hold = await activeHold(db, patient.id, type);
  if (hold) return hold.reason;
  if (await optedOutOfAll(db, patient)) return 'opted_out';
  return null;
}
export async function stopReasonFor(db, enrollment, ctx) {
  const def = cadenceType(ctx.type);
  const seq = await db.get('SELECT active FROM cadence_sequences WHERE id = ?', enrollment.sequence_id);
  if (!seq?.active) return { reason: 'sequence_off' };
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', enrollment.patient_id);
  const skip = await skipReason(db, patient, ctx.type);
  if (skip) return { reason: skip };
  return (await def.stopCheck(db, enrollment, ctx)) || null;
}

// Ends an enrollment (once: only an active one changes). A booking is credited to the last step that
// reached the patient; open call tasks for it are closed so nobody calls someone who already booked.
export async function stopEnrollment(db, enrollment, { reason, appointmentId = null, via = null, stepId = null, userId = null, req = null }) {
  const last = stepId ?? (await db.get("SELECT step_id FROM cadence_runs WHERE enrollment_id = ? AND status IN ('sent','task','done') ORDER BY due_date DESC, id DESC LIMIT 1", enrollment.id))?.step_id ?? null;
  const booked = reason === 'booked';
  const { changes } = await recorded(db, 'cadence_enrollments', enrollment.id, () => db.run(
    `UPDATE cadence_enrollments SET status = 'stopped', stop_reason = ?, stopped_at = datetime('now'), stopped_by = ?,
       booked_appointment_id = ?, booked_step_id = ?, booked_via = ?, booked_at = ${booked ? "datetime('now')" : 'NULL'} WHERE id = ? AND status = 'active'`,
    reason, userId, booked ? appointmentId : null, booked ? last : null, booked ? via || 'office' : null, enrollment.id,
  ));
  if (!changes) return false;
  for (const run of await db.all("SELECT * FROM cadence_runs WHERE enrollment_id = ? AND status = 'task'", enrollment.id)) {
    await db.run("UPDATE cadence_runs SET status = 'done', outcome = 'not_needed', outcome_note = ?, outcome_at = datetime('now') WHERE id = ? AND status = 'task'", STOP_REASONS[reason] || reason, run.id);
    if (run.task_id) await recorded(db, 'tasks', run.task_id, () => db.run("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ? AND status = 'open'", run.task_id));
  }
  await audit(db, req || { user: { practice_id: enrollment.practice_id, id: userId } }, 'cadence.stop', 'cadence_enrollments', enrollment.id, {
    reason, appointment_id: appointmentId, booked_step_id: booked ? last : null, via,
  }, { patientId: enrollment.patient_id, reason: STOP_REASONS[reason] || reason });
  publish(enrollment.practice_id, { type: 'cadence', patient_id: enrollment.patient_id });
  return true;
}

// For code that books a visit (the schedule, online booking): stop this patient's cadences right away instead
// of waiting for the next pass. The next pass (and the check right before every send) catches it anyway.
export async function stopForBooking(db, practiceId, patientId, appointmentId, { via = 'office' } = {}) {
  let n = 0;
  for (const e of await db.all("SELECT e.*, s.type FROM cadence_enrollments e JOIN cadence_sequences s ON s.id = e.sequence_id WHERE e.practice_id = ? AND e.patient_id = ? AND e.status = 'active'", practiceId, patientId)) {
    const why = await stopReasonFor(db, e, { type: e.type, today: null, nowLocal: null });
    if (why?.reason === 'booked' && await stopEnrollment(db, e, { reason: 'booked', appointmentId: why.appointment_id ?? appointmentId, via })) n++;
  }
  return n;
}

// ---- Rendering ----
const listNames = (names) => (names.length <= 1 ? names[0] || '' : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
export function messageVars({ practice, recipient, patients, anchor, visit, link, lang = 'en' }) {
  const names = patients.map((p) => p.preferred_name || p.first_name);
  const self = patients.length === 1 && patients[0].id === recipient.id;
  return {
    first_name: recipient.preferred_name || recipient.first_name, names: listNames(names), practice: practice.name,
    phone: practice.phone || fixedText(lang).the_office, link: link || practice.phone || '', visit: visit || 'visit',
    who: self ? 'your' : `${listNames(names)}’s`, due: friendlyDateTime(`${anchor} 09:00`, lang).replace(/ at .*$/, ''),
    family_note: patients.length > 1 ? ' We can book everyone back-to-back.' : '',
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function letterHtml({ practice, recipient, text }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:8.5in 11in;margin:0}body{font-family:Helvetica,Arial,sans-serif;font-size:12pt;color:#111;margin:0}
  .page{padding:0.6in 0.8in}.top{height:3in;position:relative}.practice{position:absolute;right:0;top:0;text-align:right}.practice h1{font-size:16pt;margin:0 0 4px;color:#0f766e}
  p{line-height:1.5}</style></head><body><div class="page"><div class="top"><div class="practice"><h1>${esc(practice.name)}</h1>${esc(practice.address || '')}<br>${esc([practice.city, practice.state].filter(Boolean).join(', '))} ${esc(practice.zip || '')}<br>${esc(practice.phone || '')}</div></div>
  <p>Dear ${esc(recipient.first_name)},</p><p>${esc(text)}</p><p>Warm regards,<br>${esc(practice.name)}</p></div></body></html>`;
}

// ---- The job ----
// Every few minutes: enrol whoever is due, stop whoever booked, and run each enrollment's latest due step.
// deps: { messenger, mailer, appUrl, secret, now }.
export async function runCadences(db, deps = {}) {
  const now = deps.now || new Date();
  const stats = { enrolled: 0, sent: 0, tasks: 0, stopped: 0, failed: 0, skipped: 0, completed: 0 };
  const practices = await db.all('SELECT * FROM practices ORDER BY id');
  for (const practice of practices) {
    if (deps.practiceIds && !deps.practiceIds.includes(practice.id)) continue;
    for (const [type, def] of TYPES) {
      if (!def.enabled(practice)) continue;
      const key = `cadence-job:${type}`;
      await withActor({ source: 'automation', actor: `${def.label} autopilot`, practiceId: practice.id, userId: null, locationId: null, reason: null }, async () => {
        try {
          await runPractice(db, practice, type, def, { ...deps, now }, stats);
          await resolveIssue(db, practice.id, key);
        } catch (err) {
          await raiseIssue(db, { practiceId: practice.id, kind: 'message', key, role: 'front_desk', title: `${def.label} autopilot stopped part-way — it will try again in a few minutes`, detail: err.message });
        }
      });
    }
  }
  return stats;
}

const jobReq = (practiceId) => ({ user: { practice_id: practiceId, id: null } });

async function runPractice(db, practice, type, def, deps, stats) {
  const { now } = deps;
  const nowLocal = localNow(practice.timezone || 'America/New_York', now);
  const today = nowLocal.slice(0, 10);
  const ctx = { type, today, nowLocal, practice };
  const sequences = (await ensureSequences(db, practice.id, type)).filter((s) => s.active && s.steps.length);
  const bySubtype = new Map(sequences.map((s) => [s.subtype, s]));

  // A claim left behind by a crash mid-send is never retried (it may have gone): it becomes a failure to look at.
  for (const r of await db.all("SELECT * FROM cadence_runs WHERE practice_id = ? AND status = 'claimed' AND created_at < ?", practice.id, utcStamp(new Date(now.getTime() - 30 * 60_000)))) {
    await db.run("UPDATE cadence_runs SET status = 'failed', attempts = ?, result = 'Interrupted while sending — not retried in case it went', finished_at = datetime('now') WHERE id = ? AND status = 'claimed'", RETRIES, r.id);
    await raiseIssue(db, { practiceId: practice.id, kind: 'message', key: `cadence:${r.enrollment_id}`, role: 'front_desk', entity: 'cadence_runs', entityId: r.id, patientId: r.patient_id, title: 'A recall message may not have gone (interrupted) — check the patient’s messages' });
  }

  // 1. Enrol: everyone the type says is due, inside each sequence's window, who isn't held, inactive or opted out.
  const windows = {};
  for (const s of sequences) {
    const lead = Math.max(0, -Math.min(...s.steps.map((x) => x.offset_days)));
    // Family members due a little later are enrolled early, so the first one's message can include them.
    windows[s.subtype] = { from: addDays(today, -MAX_OVERDUE_DAYS), to: addDays(today, lead + Number(s.family_window_days || 0)) };
  }
  for (const c of await def.candidates(db, practice, { today, nowLocal, windows })) {
    const seq = bySubtype.get(c.subtype);
    if (!seq) continue;
    const patient = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', c.patient_id, practice.id);
    if (await skipReason(db, patient, type)) continue;
    const { changes, id } = await db.run(
      `INSERT INTO cadence_enrollments (practice_id, patient_id, sequence_id, source_type, source_id, anchor_date, location_id)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (sequence_id, source_type, source_id, anchor_date) DO NOTHING`,
      practice.id, c.patient_id, seq.id, c.source_type, c.source_id, c.anchor_date, c.location_id ?? patient.location_id ?? null,
    );
    if (changes) {
      stats.enrolled++;
      await audit(db, jobReq(practice.id), 'cadence.enroll', 'cadence_enrollments', id, { type, sequence: seq.name, anchor_date: c.anchor_date }, { patientId: c.patient_id });
    }
  }

  // 2. Each active enrollment: stop it, finish it, or find its latest due step.
  const sendHours = withinSendHours(practice, nowLocal);
  const due = [];
  const active = await db.all(
    "SELECT e.* FROM cadence_enrollments e JOIN cadence_sequences s ON s.id = e.sequence_id WHERE e.practice_id = ? AND s.type = ? AND e.status = 'active' ORDER BY e.anchor_date, e.id",
    practice.id, type,
  );
  const stepsBySeq = new Map();
  const steps = async (sid) => {
    if (!stepsBySeq.has(sid)) stepsBySeq.set(sid, await stepsFor(db, sid));
    return stepsBySeq.get(sid);
  };
  for (const e of active) {
    const why = await stopReasonFor(db, e, ctx);
    if (why) {
      if (await stopEnrollment(db, e, { reason: why.reason, appointmentId: why.appointment_id ?? null, via: why.via ?? null })) stats.stopped++;
      continue;
    }
    const st = await steps(e.sequence_id);
    const runs = await db.all('SELECT * FROM cadence_runs WHERE enrollment_id = ?', e.id);
    const had = new Set(runs.map((r) => `${r.step_id}:${r.occurrence}`));
    const occ = dueOccurrences(st, e.anchor_date, today);
    const pending = occ.filter((o) => !had.has(`${o.step.id}:${o.occurrence}`));
    if (!pending.length) {
      // A failed step is tried again (up to three times) while it's still the latest one.
      const latest = occ.at(-1);
      const retry = latest && runs.find((r) => r.step_id === latest.step.id && r.occurrence === latest.occurrence && r.status === 'failed' && r.attempts < RETRIES
        && (!r.finished_at || r.finished_at < utcStamp(new Date(now.getTime() - 60 * 60_000))));
      if (retry && (sendHours || !needsHours(latest.step.channel))) due.push({ e, ...latest, retry });
      else if (!timeline(st, e.anchor_date).some((o) => o.due_date > today) && !runs.some((r) => r.status === 'task' || r.status === 'claimed')) {
        const { changes } = await recorded(db, 'cadence_enrollments', e.id, () => db.run("UPDATE cadence_enrollments SET status = 'completed', stopped_at = datetime('now') WHERE id = ? AND status = 'active'", e.id));
        if (changes) stats.completed++;
      }
      continue;
    }
    // Starting late (or after a pause): only the latest step goes; the ones it passed are marked skipped.
    const latest = pending.at(-1);
    for (const o of pending.slice(0, -1)) {
      await db.run(
        `INSERT INTO cadence_runs (practice_id, enrollment_id, step_id, occurrence, patient_id, due_date, status, result, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'A later step was already due', datetime('now')) ON CONFLICT (enrollment_id, step_id, occurrence) DO NOTHING`,
        practice.id, e.id, o.step.id, o.occurrence, e.patient_id, o.due_date,
      );
    }
    if (!sendHours && needsHours(latest.step.channel)) continue; // quiet hours: it waits for the morning
    due.push({ e, ...latest });
  }

  // 3. Group: a family sharing a recipient gets one message. The first one's step pulls in the others due
  //    within the sequence's family window, so they aren't messaged again for the same step.
  const taken = new Set();
  for (const item of due) {
    if (taken.has(item.e.id)) continue;
    taken.add(item.e.id);
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', item.e.patient_id);
    const recipient = await recipientFor(db, patient);
    const seq = sequences.find((s) => s.id === item.e.sequence_id) || await db.get('SELECT * FROM cadence_sequences WHERE id = ?', item.e.sequence_id);
    const members = [{ ...item, patient }];
    if (!item.retry && seq.family_window_days > 0) {
      const head = patient.guarantor_id || patient.id;
      const family = await db.all(
        `SELECT e.* FROM cadence_enrollments e JOIN patients p ON p.id = e.patient_id JOIN cadence_sequences s ON s.id = e.sequence_id
         WHERE e.practice_id = ? AND s.type = ? AND e.status = 'active' AND e.id <> ? AND (p.guarantor_id = ? OR p.id = ?)
           AND e.anchor_date >= ? AND e.anchor_date <= ? ORDER BY e.anchor_date, e.id`,
        practice.id, type, item.e.id, head, head, addDays(item.e.anchor_date, -seq.family_window_days), addDays(item.e.anchor_date, seq.family_window_days),
      );
      for (const f of family) {
        if (taken.has(f.id) || members.some((m) => m.e.patient_id === f.patient_id && m.e.sequence_id === f.sequence_id)) continue;
        const fp = await db.get('SELECT * FROM patients WHERE id = ?', f.patient_id);
        if ((await recipientFor(db, fp)).id !== recipient.id) continue;
        const fstep = (await steps(f.sequence_id)).find((s) => s.position === item.step.position);
        if (!fstep || await db.get('SELECT id FROM cadence_runs WHERE enrollment_id = ? AND step_id = ? AND occurrence = ?', f.id, fstep.id, item.occurrence)) continue;
        if (await stopReasonFor(db, f, ctx)) continue; // stopped on its own pass
        taken.add(f.id);
        members.push({ e: f, step: fstep, occurrence: item.occurrence, due_date: item.due_date, patient: fp });
      }
    }
    await runGroup(db, practice, type, def, { recipient, members, lead: item, ctx, deps, stats });
  }
}

const needsHours = (channel) => ['text', 'email', 'ai_call'].includes(channel);

// Claims, re-checks and runs one step for one recipient (one patient, or a family grouped together).
async function runGroup(db, practice, type, def, { recipient, members, lead, ctx, deps, stats }) {
  // Claim first: the unique (enrollment, step, occurrence) row means a second job, or a restart, never sends it again.
  const claimed = [];
  for (const m of members) {
    if (m.retry) {
      const { changes } = await db.run("UPDATE cadence_runs SET status = 'claimed', attempts = attempts + 1 WHERE id = ? AND status = 'failed' AND attempts = ?", m.retry.id, m.retry.attempts);
      if (changes) claimed.push({ ...m, runId: m.retry.id });
      continue;
    }
    const { changes } = await db.run(
      `INSERT INTO cadence_runs (practice_id, enrollment_id, step_id, occurrence, patient_id, due_date, status)
       VALUES (?, ?, ?, ?, ?, ?, 'claimed') ON CONFLICT (enrollment_id, step_id, occurrence) DO NOTHING`,
      practice.id, m.e.id, m.step.id, m.occurrence, m.e.patient_id, m.due_date,
    );
    if (!changes) continue;
    const run = await db.get('SELECT id FROM cadence_runs WHERE enrollment_id = ? AND step_id = ? AND occurrence = ?', m.e.id, m.step.id, m.occurrence);
    claimed.push({ ...m, runId: run.id });
  }
  if (!claimed.length) return;
  // Always re-check right before sending: a visit booked a second ago stops it.
  const going = [];
  for (const m of claimed) {
    const why = await stopReasonFor(db, m.e, ctx);
    if (why) {
      await db.run("UPDATE cadence_runs SET status = 'skipped', result = ?, finished_at = datetime('now') WHERE id = ?", `Stopped before sending: ${STOP_REASONS[why.reason] || why.reason}`, m.runId);
      if (await stopEnrollment(db, m.e, { reason: why.reason, appointmentId: why.appointment_id ?? null, via: why.via ?? null })) stats.stopped++;
    } else going.push(m);
  }
  if (!going.length) return;
  const head = going.find((m) => m.e.id === lead.e.id) || going[0];
  const step = head.step;
  const leadRunId = head.runId;
  const lang = patientLang(recipient);
  const { visit } = await def.describe(db, going.map((m) => m.e));
  const anchor = going.map((m) => m.e.anchor_date).sort()[0];
  const patients = going.map((m) => m.patient);

  let link = null;
  if (def.linkPath && deps.secret) {
    const l = await createLink(db, deps.secret, { practiceId: practice.id, recipientId: recipient.id, runId: leadRunId, enrollmentIds: going.map((m) => m.e.id), now: deps.now });
    link = `${deps.appUrl || ''}/${def.linkPath}/${l.token}`;
  }
  const vars = messageVars({ practice, recipient, patients, anchor, visit, link, lang });
  const text = renderTemplate(step.template || '', vars);
  const subject = step.subject ? renderTemplate(step.subject, vars) : `${practice.name}: time to book ${vars.who === 'your' ? 'your' : vars.who} ${visit}`;

  // The step's channel first (a patient who prefers email gets email for a text step, and the reverse), then its
  // fallbacks. A channel that failed last time for this patient goes to the back of the line.
  const cond = parseConditions(step.conditions);
  let order = [step.channel, ...(cond.fallback || DEFAULT_FALLBACK[step.channel] || [])];
  const pref = recipient.preferred_contact === 'email' ? 'email' : ['sms', 'text'].includes(recipient.preferred_contact) ? 'text' : null;
  if (pref && ['text', 'email'].includes(step.channel) && order.includes(pref)) order = [pref, ...order.filter((c) => c !== pref)];
  const prior = await db.get('SELECT fallback_from FROM cadence_runs WHERE enrollment_id = ? AND id <> ? AND fallback_from IS NOT NULL ORDER BY id DESC LIMIT 1', head.e.id, leadRunId);
  if (prior?.fallback_from && order.length > 1 && order[0] === prior.fallback_from) order = [...order.slice(1), order[0]];
  order = [...new Set(order)];

  let outcome = null;
  const tried = [];
  for (const channel of order) {
    if (needsHours(channel) && !withinSendHours(practice, ctx.nowLocal)) { tried.push({ channel, result: 'quiet hours' }); continue; }
    const r = await deliver(db, practice, { channel, recipient, patients, text, subject, vars, step, runId: leadRunId, link, deps, lang, members: going });
    tried.push({ channel, ...r });
    if (r.status === 'sent' || r.status === 'task') {
      outcome = { channel, ...r };
      break;
    }
  }
  const failedAny = tried.some((t) => t.status === 'failed');
  const status = outcome ? outcome.status : failedAny ? 'failed' : 'skipped';
  const result = outcome ? outcome.result : tried.map((t) => `${CHANNEL_LABELS[t.channel] || t.channel}: ${t.result}`).join('; ').slice(0, 500);
  const fallbackFrom = outcome && outcome.channel !== order[0] ? order[0] : null;
  for (const m of going) {
    const main = m.runId === leadRunId;
    await db.run(
      `UPDATE cadence_runs SET status = ?, channel = ?, fallback_from = ?, source = ?, message_id = ?, call_id = ?, task_id = ?, external_id = ?, grouped_with = ?, result = ?,
         finished_at = ${status === 'task' ? 'NULL' : "datetime('now')"} WHERE id = ?`,
      status, outcome?.channel ?? tried.at(-1)?.channel ?? step.channel, fallbackFrom, outcome?.channel === 'ai_call' ? 'ai' : 'automation',
      outcome?.message_id ?? null, outcome?.call_id ?? null, outcome?.task_id ?? null, outcome?.external_id ?? null, main ? null : leadRunId,
      main ? result : `${result} (with ${recipient.first_name}’s family message)`, m.runId,
    );
    await db.run("UPDATE cadence_enrollments SET current_step = ?, last_run_at = datetime('now') WHERE id = ?", m.step.position, m.e.id);
    await audit(db, jobReq(practice.id), `cadence.step.${status}`, 'cadence_runs', m.runId, {
      enrollment_id: m.e.id, step: stepSummary(m.step), channel: outcome?.channel ?? null, fallback_from: fallbackFrom, grouped: going.length > 1, result,
    }, { patientId: m.e.patient_id, source: outcome?.channel === 'ai_call' ? 'ai' : undefined, actor: outcome?.channel === 'ai_call' ? 'AI recall call' : undefined });
  }
  const issueKey = `cadence:${head.e.id}`;
  if (outcome) {
    if (status === 'task') stats.tasks++;
    else stats.sent++;
    for (const m of going) await resolveIssue(db, practice.id, `cadence:${m.e.id}`, 'Resolved: a later step reached them');
    if (def.afterSend) await def.afterSend(db, going.map((m) => m.e));
  } else if (failedAny) {
    stats.failed++;
    await raiseIssue(db, {
      practiceId: practice.id, kind: 'message', key: issueKey, role: 'front_desk', entity: 'cadence_runs', entityId: leadRunId, patientId: head.e.patient_id,
      title: `${def.label} ${CHANNEL_LABELS[step.channel].toLowerCase()} to ${recipient.first_name} ${recipient.last_name} didn’t go`, detail: result,
    });
  } else stats.skipped++;
  publish(practice.id, { type: 'cadence' });
}

// One channel, one attempt. Returns { status: 'sent' | 'task' | 'failed' | 'unreachable', result, ids… }.
async function deliver(db, practice, { channel, recipient, patients, text, subject, vars, step, runId, link, deps, lang, members }) {
  const { messenger, mailer } = deps;
  if (channel === 'text' || channel === 'email') {
    const sms = channel === 'text';
    const to = sms ? recipient.phone : recipient.email;
    if (!to) return { status: 'unreachable', result: sms ? 'no mobile number' : 'no email address' };
    if (sms ? !recipient.sms_opt_in || recipient.sms_bad_at : !recipient.email_opt_in || recipient.email_bad_at) return { status: 'unreachable', result: sms ? 'can’t text this number' : 'email turned off or bouncing' };
    if (await isOptedOutAddress(db, practice.id, sms ? 'sms' : 'email', to)) return { status: 'unreachable', result: 'opted out' };
    if (!messenger) return { status: 'failed', result: 'messaging is not set up' };
    const body = sms && !/\bSTOP\b/.test(text) ? `${text}${fixedText(lang).sms_stop}` : text;
    const msg = await sendMessage(db, messenger, { practiceId: practice.id, patientId: recipient.id, channel: sms ? 'sms' : 'email', to, subject, body, kind: 'recall' });
    if (msg.status === 'sent') return { status: 'sent', result: sms ? 'texted' : 'emailed', message_id: msg.id };
    if (msg.status === 'blocked') return { status: 'unreachable', result: msg.error || 'blocked' };
    return { status: 'failed', result: msg.error || 'delivery failed', message_id: msg.id };
  }
  if (channel === 'ai_call') {
    const number = recipient.phone || recipient.phone_home;
    if (!number) return { status: 'unreachable', result: 'no phone number' };
    if (!messenger?.call) return { status: 'unreachable', result: 'calling is not set up' };
    const token = link ? link.split('/').pop() : null;
    if (!token) return { status: 'unreachable', result: 'no booking link to offer' };
    const callId = await withActor({ source: 'ai', actor: 'AI recall call' }, () => insert(db, 'calls', {
      practice_id: practice.id, patient_id: recipient.id, direction: 'outbound', purpose: 'recall', to_number: number, token_hash: hashToken(token), source: 'ai', reason: text.slice(0, 500),
    }));
    try {
      const { provider_id: sid } = await messenger.call(number, `${deps.appUrl || ''}/api/webhooks/twilio/voice/recall/${token}`);
      await db.run("UPDATE calls SET provider_id = ?, status = 'ringing' WHERE id = ?", sid, callId);
      return { status: 'sent', result: 'AI call placed', call_id: callId, external_id: sid };
    } catch (err) {
      await db.run("UPDATE calls SET status = 'failed', outcome = ? WHERE id = ?", String(err.message).slice(0, 200), callId);
      return { status: 'failed', result: `call failed: ${err.message}`.slice(0, 200), call_id: callId };
    }
  }
  if (channel === 'task_call') {
    const number = recipient.phone || recipient.phone_home || recipient.phone_work;
    if (!number) return { status: 'unreachable', result: 'no phone number' };
    const cond = parseConditions(step.conditions);
    const today = practiceToday(practice, deps.now);
    const taskId = await insert(db, 'tasks', {
      practice_id: practice.id, patient_id: members[0].e.patient_id, assigned_to: cond.assign_to || null, priority: 'normal', due_date: today,
      title: `Recall call: ${vars.names} — ${vars.visit}${members.length > 1 ? ' (family)' : ''} · ${number}`.slice(0, 200),
      notes: `Script: ${text}\n\nLog the outcome on the Recall screen (reached, left message, will call back, declined).`,
    });
    publish(practice.id, { type: 'tasks' });
    return { status: 'task', result: `call task for ${cond.assign_to ? 'a team member' : 'the team'}`, task_id: taskId };
  }
  if (channel === 'letter' || channel === 'postcard') {
    if (!mailer?.enabled) return { status: 'unreachable', result: 'mailing is not set up' };
    if (!mailable(recipient)) return { status: 'unreachable', result: 'no mailing address' };
    try {
      const sent = await mailer.sendLetter({
        to: { name: `${recipient.first_name} ${recipient.last_name}`, address: recipient.address, city: recipient.city, state: recipient.state, zip: recipient.zip },
        from: { name: practice.name, address: practice.address, city: practice.city, state: practice.state, zip: practice.zip },
        html: letterHtml({ practice, recipient, text }), description: `Recall ${channel} (run ${runId})`, idempotencyKey: `cadence-run-${runId}`,
      });
      return { status: 'sent', result: `${channel} mailed`, external_id: sent.reference };
    } catch (err) {
      return { status: 'failed', result: `${channel} failed: ${err.message}`.slice(0, 200) };
    }
  }
  return { status: 'unreachable', result: 'unknown channel' };
}

// ---- Call outcomes (the team's one click) ----
export const OUTCOMES = { reached: 'Reached', left_message: 'Left a message', call_back: 'Will call back', declined: 'Declined', booked: 'Booked', wrong_number: 'Wrong number' };
export async function recordOutcome(db, req, run, { outcome, note }) {
  if (!OUTCOMES[outcome]) throw new HttpError(400, 'Choose reached, left message, will call back, declined, booked or wrong number');
  if (run.status !== 'task') {
    if (run.outcome === outcome) return run; // the same click twice
    throw new HttpError(409, 'This call already has an outcome');
  }
  const clean = note ? String(note).trim().slice(0, 500) : null;
  const { changes } = await recorded(db, 'cadence_runs', run.id, () => db.run(
    "UPDATE cadence_runs SET status = 'done', outcome = ?, outcome_note = ?, outcome_by = ?, outcome_at = datetime('now'), finished_at = datetime('now') WHERE id = ? AND status = 'task'",
    outcome, clean, req.user.id, run.id,
  ));
  if (!changes) return db.get('SELECT * FROM cadence_runs WHERE id = ?', run.id);
  if (run.task_id) await recorded(db, 'tasks', run.task_id, () => db.run("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ? AND status = 'open'", run.task_id));
  await audit(db, req, 'cadence.call_outcome', 'cadence_runs', run.id, { outcome, note: clean, enrollment_id: run.enrollment_id }, { patientId: run.patient_id });
  const e = await db.get("SELECT * FROM cadence_enrollments WHERE id = ?", run.enrollment_id);
  if (outcome === 'declined' && e) await stopEnrollment(db, e, { reason: 'declined', userId: req.user.id, req });
  if (outcome === 'booked' && e) {
    const appt = await db.get("SELECT id FROM appointments WHERE patient_id = ? AND status IN ('scheduled','confirmed') AND start_time >= ? ORDER BY start_time LIMIT 1", e.patient_id, localNow((await db.get('SELECT timezone FROM practices WHERE id = ?', e.practice_id))?.timezone || 'America/New_York'));
    await stopEnrollment(db, e, { reason: 'booked', appointmentId: appt?.id ?? null, via: 'call', stepId: run.step_id, userId: req.user.id, req });
  }
  if (outcome === 'wrong_number' && e) {
    const p = await db.get('SELECT * FROM patients WHERE id = ?', e.patient_id);
    await recorded(db, 'patients', p.id, () => db.run("UPDATE patients SET sms_bad_at = COALESCE(sms_bad_at, datetime('now')), sms_bad_reason = COALESCE(sms_bad_reason, 'Wrong number (recall call)') WHERE id = ?", p.id));
  }
  publish(run.practice_id, { type: 'cadence', patient_id: run.patient_id });
  return db.get('SELECT * FROM cadence_runs WHERE id = ?', run.id);
}

// ---- Per-patient status (the patient page) ----
export async function patientStatus(db, practiceId, patientId, { now = new Date() } = {}) {
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  const today = practiceToday(practice, now);
  const patient = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', patientId, practiceId);
  if (!patient) throw new HttpError(404, 'Patient not found');
  const enrollments = await db.all(
    `SELECT e.*, s.name AS sequence_name, s.type, s.subtype FROM cadence_enrollments e JOIN cadence_sequences s ON s.id = e.sequence_id
     WHERE e.practice_id = ? AND e.patient_id = ? ORDER BY CASE WHEN e.status = 'active' THEN 0 ELSE 1 END, e.anchor_date DESC, e.id DESC LIMIT 10`, practiceId, patientId,
  );
  for (const e of enrollments) {
    const steps = await stepsFor(db, e.sequence_id, { all: true });
    const runs = await db.all(
      `SELECT r.id, r.step_id, r.occurrence, r.due_date, r.status, r.channel, r.fallback_from, r.source, r.result, r.outcome, r.outcome_note, r.finished_at, r.created_at, r.message_id, r.task_id
       FROM cadence_runs r WHERE r.enrollment_id = ? ORDER BY r.due_date, r.id`, e.id,
    );
    const had = new Map(runs.map((r) => [`${r.step_id}:${r.occurrence}`, r]));
    const planned = e.status === 'active' ? timeline(steps.filter((s) => s.active), e.anchor_date).filter((o) => !had.has(`${o.step.id}:${o.occurrence}`)).slice(0, 6) : [];
    e.timeline = [
      ...runs.map((r) => ({ ...r, step: stepView(steps.find((s) => s.id === r.step_id)), state: r.status })),
      ...planned.map((o) => ({ due_date: o.due_date, occurrence: o.occurrence, step: stepView(o.step), state: o.due_date <= today ? 'due' : 'planned' })),
    ];
    e.stop_label = e.stop_reason ? STOP_REASONS[e.stop_reason] || e.stop_reason : null;
  }
  const holds = await db.all('SELECT * FROM cadence_holds WHERE practice_id = ? AND patient_id = ? ORDER BY id DESC', practiceId, patientId);
  const skip = await skipReason(db, patient, 'recall');
  return { patient_id: patient.id, today, enrollments, holds, skip_reason: skip, skip_label: skip ? STOP_REASONS[skip] || skip : null };
}
const stepView = (s) => (s ? { id: s.id, offset_days: s.offset_days, channel: s.channel, label: CHANNEL_LABELS[s.channel], repeat_days: s.repeat_days, active: s.active } : null);
