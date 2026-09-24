import { createHash } from 'node:crypto';
import { HttpError } from './auth.js';
import { audit, localNow, newToken, hashToken, recorded } from './util.js';
import { toPostgres } from './db.js';
import { withActor } from './actor.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { sendMessage, withinSendHours } from './messaging.js';
import { renderTemplate } from './templates.js';
import { mailable } from './mail.js';
import { publish } from './events.js';
import { registerCadenceType, addDays, STOP_REASONS } from './cadence.js';

// ---- Patient journeys (PX1–PX7, docs/workflows/specs/PX-patient-experience.md) ----
// The moments that make people feel cared for: a welcome from the doctor before the first visit, a thank-you
// after it, a check-in the evening after surgery, birthdays, anniversaries, "we miss you", thank-yous for
// referrals, a handwritten card now and then. Each is a journey the practice switches on or off and words its own way.
//
// Journeys that send something on a date run on the cadence engine (cadence.js) as one cadence type,
// 'journey', with one sequence per journey (subtype = the journey key) holding a single step. The engine gives
// them what every automated message needs: enrol once per (source, anchor date) — which is what makes "one
// birthday text a year" true — opt-outs and holds, quiet hours, channel fallback, the claim-before-send that
// never sends twice, the automation actor, the audit trail and failures in Needs attention.
//
// The engine fills a step's words from its own short list of fields (first name, practice, {visit}…). Journeys
// need more ({doctor}, {date}, {time}, {address}, {parking}, {link}…), so each journey step's stored template is
// just '{visit}' and describe() below returns the whole message, written from the journey's own template
// (journey_settings), as `visit`. The office edits the journey's template, never the step's.
//
// Things that aren't messages on a date — handwritten-card tasks, milestone and life-event suggestions,
// comments routed to the owner, holiday cards and newsletters — run in runJourneyExtras (the journey job).

export const TYPE = 'journey';

// Words that don't belong in a text or email about a patient: the message says "your visit today" and no more.
export const CLINICAL = /\b(D\d{4}|extract\w*|root canals?|endodont\w*|surger(y|ies)|surgical|implants?|biops\w*|diagnos\w*|cavit(y|ies)|decay|caries|periodont\w*|gum disease|crowns?|fillings?|x-?rays?|anesthe\w*|infections?|prescriptions?|antibiotics?|braces)\b/i;

const BASE_FIELDS = ['first_name', 'doctor', 'practice', 'date', 'time', 'address', 'parking', 'link', 'phone'];

// The journeys. engine: runs on the cadence engine (offset_days from the anchor, the channels the office may pick).
// on: default switch (birthday text and the new-patient welcome start on; everything else waits for the office).
export const JOURNEYS = [
  {
    key: 'welcome', group: 'Before the first visit', name: 'New-patient welcome', on: true, engine: true, offset: -120, channels: ['email', 'letter', 'text'], channel: 'email', fields: ['what_to_bring'],
    about: 'When a new patient books their first visit: a welcome from the doctor with what to expect, parking, what to bring and a link to their forms and a photo of the team.',
    subject: 'Welcome to {practice}, {first_name}!',
    template: ('Hi {first_name}, I’m so glad you chose {practice}, and our whole team is looking forward to meeting you on {date} at {time}. Your first visit is all about getting to know you: we’ll listen to what matters to you, take a careful look, and answer every question — plan on about an hour. We’re at {address}. {parking} Please bring {what_to_bring}. You can fill in your forms ahead of time and meet the team here: {link} See you soon! — {doctor}'),
  },
  {
    key: 'arrival', group: 'Before the first visit', name: 'Day-before arrival text', on: true, engine: true, offset: -1, channels: ['text', 'email'], channel: 'text', fields: ['what_to_bring'],
    about: 'The day before a new patient’s first visit: where to go, where to park and what to bring.',
    subject: 'See you tomorrow at {practice}',
    template: ('Hi {first_name}! We can’t wait to meet you tomorrow at {time} at {practice}, {address}. {parking} Please bring {what_to_bring}. Questions? Just reply to this text.'),
  },
  {
    key: 'thankyou', group: 'After the visit', name: 'Same-day thank-you text', on: false, engine: true, offset: 0, channels: ['text', 'email'], channel: 'text',
    about: 'After a completed visit: a short thank-you from the provider, the same day. (If the “You’re all set” summary is on, it replaces this one.)',
    subject: 'Thank you from {practice}',
    template: ('Thank you for coming in today, {first_name}! It was a pleasure to see you. — {doctor} and the team at {practice}'),
  },
  {
    key: 'postop', group: 'After the visit', name: 'Evening check-in after surgery', on: false, engine: true, offset: 0, channels: ['text'], channel: 'text', noFallback: true,
    about: 'The evening after surgery, an extraction or a root canal: “How are you feeling?” A reply of 2 or 3 alerts the doctor and shows in Needs attention.',
    subject: 'Checking in from {practice}',
    template: ('Hi {first_name}, it’s {practice} checking in after your visit today. How are you feeling? Reply 1 if you’re doing well, 2 if you have some discomfort, or 3 if you’d like to talk with us.'),
    options: { code_prefixes: ['D7', 'D33', 'D34', 'D42', 'D60'], evening: '18:00', review_after_good: false },
  },
  {
    key: 'summary', group: 'After the visit', name: '“You’re all set” summary', on: false, engine: true, offset: 0, channels: ['text', 'email'], channel: 'text', fields: ['next_visit'],
    about: 'After checkout: thanks, the next visit, and a link to the portal for the visit summary, forms and balance (the details stay behind the portal sign-in).',
    subject: 'You’re all set, {first_name}',
    template: ('You’re all set, {first_name}! Thanks for coming in today. {next_visit} Your visit summary, forms and any balance are in your patient portal: {link}'),
  },
  {
    key: 'birthday', group: 'Celebrations', name: 'Happy birthday', on: true, engine: true, offset: 0, channels: ['text', 'email'], channel: 'text',
    about: 'On the patient’s birthday: a warm note from the team. One a year, never more.',
    subject: 'Happy birthday from {practice}!',
    template: ('Happy birthday, {first_name}! Everyone at {practice} is wishing you a wonderful day and a year full of smiles.'),
    options: { recent_months: 36 },
  },
  {
    key: 'birthday_card', group: 'Celebrations', name: 'Mailed birthday card (kids and VIPs)', on: false, engine: true, offset: -5, channels: ['postcard', 'letter'], channel: 'postcard', noFallback: true,
    about: 'A printed card mailed to arrive by the birthday, for children and for patients marked VIP.',
    subject: 'Happy birthday!',
    template: ('Happy birthday, {first_name}! Everyone at {practice} is sending big smiles and warm wishes for your special day. We hope it’s a great one!'),
    options: { max_age: 12, vip: true },
  },
  {
    key: 'anniversary', group: 'Celebrations', name: 'Practice anniversary', on: false, engine: true, offset: 0, channels: ['text', 'email', 'postcard'], channel: 'text', fields: ['years'],
    about: 'On the anniversary of a patient’s first visit (“5 years with us!”).',
    subject: 'Happy anniversary from {practice}',
    template: ('Happy anniversary, {first_name}! It’s been {years} since your first visit to {practice}. Thank you for trusting us with your smile — it means the world to our whole team.'),
    options: { years: [1, 5, 10, 15, 20, 25, 30] },
  },
  {
    key: 'milestone', group: 'Celebrations', name: 'Milestone congratulations', on: false, engine: true, offset: 0, channels: ['text', 'email'], channel: 'text',
    about: 'Braces off, or a child’s first cavity-free checkup: a congratulations note (the printable certificate is on the huddle).',
    subject: 'Congratulations from {practice}!',
    template: ('Congratulations, {first_name}! The whole team at {practice} is so proud of you. What a day to celebrate!'),
  },
  {
    key: 'reactivation', group: 'Staying in touch', name: '“We miss you”', on: false, engine: true, offset: 0, channels: ['text', 'email', 'letter', 'postcard'], channel: 'text', repeat: { days: 120, max: 2 },
    about: 'Patients not seen in a while, with nothing booked. Patients with a recall due are left to recall autopilot when it’s on.',
    subject: 'We miss you at {practice}',
    template: ('Hi {first_name}, it’s been a while and we miss you at {practice}! Whenever you’re ready, we’d love to see you — book here: {link} or just reply and we’ll find a time that works for you.'),
    options: { months: 18 },
  },
  {
    key: 'referral_thanks', group: 'Staying in touch', name: 'Referral thank-you', on: false, engine: true, offset: 0, channels: ['text', 'email', 'letter'], channel: 'text',
    about: 'When someone a patient referred comes in for their first visit, a thank-you to the patient who referred them (the friend is never named).',
    subject: 'Thank you from {practice}',
    template: ('Thank you so much, {first_name}! A friend of yours came to see us at {practice}, and a referral is the nicest compliment we can get. We’re so grateful for you.'),
  },
  // Not on the engine:
  {
    key: 'card_task', group: 'After the visit', name: 'Handwritten thank-you card', on: false,
    about: 'A task for the team to write and mail a card after a new patient’s first visit or a big treatment day. Tick it when the card is in the mail.',
    options: { first_visit: true, threshold_cents: 150000, assign_to: null },
  },
  {
    key: 'referral_gift', group: 'Staying in touch', name: 'Referral gift card task', on: false,
    about: 'With the referral thank-you: a task to send the referring patient a gift card.', options: { gift: '$25 gift card', assign_to: null },
  },
  {
    key: 'survey', group: 'Feedback', name: 'One-question survey after visits', on: false,
    about: 'The day after a visit: “How likely are you to recommend us?” with room for a comment. Comments go to the owner; low scores show on the huddle.',
    options: { owner_user_id: null },
  },
  {
    key: 'life_events', group: 'Celebrations', name: 'Life-event suggestions', on: true,
    about: 'Reads the office’s notes for a new baby, a wedding or a graduation and suggests a congratulations to the team. Never sent automatically — the team chooses.',
  },
  {
    key: 'newsletter', group: 'Staying in touch', name: 'Newsletter', on: false,
    about: 'A short email to patients who asked for it, with an unsubscribe link in every one.',
  },
  {
    key: 'holiday', group: 'Celebrations', name: 'Holiday cards', on: false,
    about: 'Seasonal cards the office picks and sends (email or a mailed postcard) to the families it has seen lately.',
  },
];
export const journeyDef = (key) => JOURNEYS.find((j) => j.key === key);
const ENGINE = JOURNEYS.filter((j) => j.engine);

// Stop reasons journeys add to the engine's list (labels only).
Object.assign(STOP_REASONS, {
  visit_changed: 'The visit was moved or cancelled', too_late: 'The moment passed', already_seen: 'Already came in', moment_dismissed: 'Dismissed by the office',
});

// ---- Schema (the lines for db.js are in the spec; until they're there, created on first use) ----
export const JOURNEY_SCHEMA = `
-- Patient journeys (PX): each journey's switch, channel, wording and options per practice. enabled_since keeps a
-- journey switched on today from reaching back to visits booked before it.
CREATE TABLE IF NOT EXISTS journey_settings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  channel TEXT,
  template TEXT,
  subject TEXT,
  options TEXT,
  enabled_since TEXT,
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, key)
);
-- What the welcome says about the office: parking, what to bring, what to expect, the doctor's photo.
CREATE TABLE IF NOT EXISTS journey_profile (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL UNIQUE REFERENCES practices(id),
  parking TEXT,
  what_to_bring TEXT,
  what_to_expect TEXT,
  team_note TEXT,
  doctor_photo TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Per-patient choices: the newsletter (opt-in), VIP (mailed birthday card), no celebrations at all.
CREATE TABLE IF NOT EXISTS journey_prefs (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL UNIQUE REFERENCES patients(id),
  newsletter INTEGER NOT NULL DEFAULT 0,
  newsletter_at TEXT,
  vip INTEGER NOT NULL DEFAULT 0,
  no_celebrations INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Links in journey messages (the welcome page): only the token's hash is kept.
CREATE TABLE IF NOT EXISTS journey_links (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  enrollment_id INTEGER REFERENCES cadence_enrollments(id),
  appointment_id INTEGER REFERENCES appointments(id),
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  opened_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Post-op check-ins sent by text, and the patient's answer (1 good / 2 some pain / 3 need to talk).
CREATE TABLE IF NOT EXISTS journey_checkins (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  enrollment_id INTEGER NOT NULL UNIQUE REFERENCES cadence_enrollments(id),
  provider_id INTEGER REFERENCES providers(id),
  visit_date TEXT NOT NULL,
  phone TEXT NOT NULL,
  message_id INTEGER REFERENCES messages(id),
  reply INTEGER,
  reply_text TEXT,
  replied_at TEXT,
  task_id INTEGER REFERENCES tasks(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Moments for the team: milestones (braces off, first cavity-free checkup), life events read from notes, a hard
-- last visit, a comment for the owner. One per (patient, kind, source); suggested until done or dismissed.
CREATE TABLE IF NOT EXISTS journey_moments (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  kind TEXT NOT NULL CHECK (kind IN ('braces_off','cavity_free','life_event','hard_visit','comment')),
  source_key TEXT NOT NULL,
  detail TEXT,
  detected_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','done','dismissed')),
  task_id INTEGER REFERENCES tasks(id),
  done_by INTEGER REFERENCES users(id),
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, patient_id, kind, source_key)
);
-- A patient who referred a friend (the friend is the new patient).
CREATE TABLE IF NOT EXISTS journey_referrals (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  referrer_patient_id INTEGER NOT NULL REFERENCES patients(id),
  referred_patient_id INTEGER NOT NULL REFERENCES patients(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, referred_patient_id)
);
-- Handwritten cards (and gift cards) for the team: one per reason; sent when its task is ticked.
CREATE TABLE IF NOT EXISTS journey_cards (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  reason TEXT NOT NULL,
  reason_key TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, reason_key)
);
-- Holiday cards and newsletters: written by the office, sent once to a snapshot of recipients.
CREATE TABLE IF NOT EXISTS journey_broadcasts (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  kind TEXT NOT NULL CHECK (kind IN ('holiday','newsletter')),
  title TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','postcard')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','cancelled')),
  recipients INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  sent_by INTEGER REFERENCES users(id),
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS journey_broadcast_recipients (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  broadcast_id INTEGER NOT NULL REFERENCES journey_broadcasts(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  token_hash TEXT,
  message_id INTEGER REFERENCES messages(id),
  external_id TEXT,
  result TEXT,
  sent_at TEXT,
  UNIQUE (broadcast_id, patient_id)
);
CREATE INDEX IF NOT EXISTS idx_journey_checkins_phone ON journey_checkins(practice_id, phone);
CREATE INDEX IF NOT EXISTS idx_journey_moments_status ON journey_moments(practice_id, status);
CREATE INDEX IF NOT EXISTS idx_journey_bcr_status ON journey_broadcast_recipients(broadcast_id, status);
`;

const ensured = new WeakSet();
export async function ensureJourneySchema(db) {
  if (ensured.has(db)) return;
  const sql = db.dialect === 'postgres' ? toPostgres(JOURNEY_SCHEMA).replace(/id INTEGER PRIMARY KEY/g, 'id SERIAL PRIMARY KEY') : JOURNEY_SCHEMA;
  const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);
  for (const s of statements) await db.run(s);
  ensured.add(db);
}
// Postgres only returns ids for tables it knows from SCHEMA; RETURNING works on both.
export const addRow = async (db, table, row) => {
  const keys = Object.keys(row);
  return (await db.get(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING id`, ...Object.values(row)))?.id;
};
const parse = (v, d) => {
  try {
    const o = typeof v === 'string' ? JSON.parse(v) : v;
    return o ?? d;
  } catch {
    return d;
  }
};
const utcStamp = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// ---- Settings ----
// Every journey has a row per practice (made with its defaults the first time), and every engine journey its
// sequence, made here before the engine would make it, so it starts switched on or off as the defaults say and
// never groups a family into one message (family_window_days 0: a birthday is one person's).
const setUp = new WeakMap();
export async function ensureJourneySetup(db, practiceId) {
  await ensureJourneySchema(db);
  if (!setUp.has(db)) setUp.set(db, new Set());
  const done = setUp.get(db);
  if (done.has(practiceId)) return;
  for (const j of JOURNEYS) {
    await db.run(
      `INSERT INTO journey_settings (practice_id, key, enabled, channel, template, subject, options, enabled_since) VALUES (?, ?, ?, ?, ?, ?, ?, ${j.on ? "datetime('now')" : 'NULL'})
       ON CONFLICT (practice_id, key) DO NOTHING`,
      practiceId, j.key, j.on ? 1 : 0, j.channel || null, j.template || null, j.subject || null, JSON.stringify(j.options || {}),
    );
  }
  for (const j of ENGINE) {
    const s = await db.get('SELECT enabled, channel FROM journey_settings WHERE practice_id = ? AND key = ?', practiceId, j.key);
    const seq = await db.get(
      `INSERT INTO cadence_sequences (practice_id, type, subtype, name, active, family_window_days) VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT (practice_id, type, subtype) DO NOTHING RETURNING id`, practiceId, TYPE, j.key, j.name, s.enabled ? 1 : 0,
    );
    if (seq?.id) await addRow(db, 'cadence_steps', stepRow(practiceId, seq.id, j, s.channel || j.channel));
  }
  await db.run('UPDATE cadence_sequences SET family_window_days = 0 WHERE practice_id = ? AND type = ? AND family_window_days <> 0', practiceId, TYPE);
  done.add(practiceId);
}
const stepRow = (practiceId, sequenceId, j, channel) => ({
  practice_id: practiceId, sequence_id: sequenceId, position: 0, offset_days: j.offset, channel, template: '{visit}', subject: j.subject || null,
  conditions: JSON.stringify(j.noFallback ? { fallback: [] } : {}), repeat_days: j.repeat?.days ?? null, repeat_max: j.repeat?.max ?? null,
});

export async function journeySettings(db, practiceId) {
  await ensureJourneySetup(db, practiceId);
  const rows = await db.all('SELECT * FROM journey_settings WHERE practice_id = ?', practiceId);
  return JOURNEYS.map((j) => {
    const r = rows.find((x) => x.key === j.key) || {};
    return {
      key: j.key, name: j.name, group: j.group, about: j.about, engine: !!j.engine, default_on: !!j.on, channels: j.channels || [],
      fields: j.engine ? [...BASE_FIELDS, ...(j.fields || [])] : [], enabled: !!r.enabled, channel: r.channel || j.channel || null,
      template: r.template ?? j.template ?? null, subject: r.subject ?? j.subject ?? null, starter_template: j.template || null, starter_subject: j.subject || null,
      options: { ...(j.options || {}), ...parse(r.options, {}) }, enabled_since: r.enabled_since || null, updated_at: r.updated_at || null,
    };
  });
}
export async function journeySetting(db, practiceId, key) {
  return (await journeySettings(db, practiceId)).find((s) => s.key === key);
}

// Checks a journey's wording: only its own fields, short enough for the channel, and nothing clinical.
export function validateTemplate(j, text, channel) {
  const t = String(text ?? '').trim();
  if (!t) throw new HttpError(400, 'Write what the message says');
  const max = ['email', 'letter', 'postcard'].includes(channel) ? 1500 : 600;
  if (t.length > max) throw new HttpError(400, `Keep it under ${max} characters`);
  const allowed = [...BASE_FIELDS, ...(j.fields || [])];
  const unknown = [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((x) => !allowed.includes(x));
  if (unknown.length) throw new HttpError(400, `{${unknown[0]}} isn’t a field this message can use — it can use ${allowed.map((x) => `{${x}}`).join(' ')}`);
  const hit = CLINICAL.exec(t);
  if (hit) throw new HttpError(400, `Keep clinical details out of messages (“${hit[0]}”) — say “your visit” instead. Texts and emails aren’t private.`);
  return t;
}

// Saves a journey's switch, channel, wording and options. Recorded with before and after.
export async function saveJourney(db, req, key, body = {}) {
  const j = journeyDef(key);
  if (!j) throw new HttpError(404, 'Unknown journey');
  const pid = req.user.practice_id;
  await ensureJourneySetup(db, pid);
  const before = await db.get('SELECT * FROM journey_settings WHERE practice_id = ? AND key = ?', pid, key);
  const row = {};
  if (body.enabled != null) {
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    row.enabled = body.enabled ? 1 : 0;
  }
  if (body.channel != null) {
    if (!j.channels?.includes(body.channel)) throw new HttpError(400, `${j.name} can go by ${(j.channels || []).join(', ') || 'no channel'}`);
    row.channel = body.channel;
  }
  const channel = row.channel || before.channel || j.channel;
  if (body.template != null) {
    if (!j.engine) throw new HttpError(400, 'This journey has no message to word');
    row.template = validateTemplate(j, body.template, channel);
  }
  if (body.subject != null) {
    const s = String(body.subject).trim().slice(0, 200);
    const bad = [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((x) => !['first_name', 'practice'].includes(x));
    if (bad.length) throw new HttpError(400, 'An email subject can use {first_name} and {practice}');
    if (CLINICAL.test(s)) throw new HttpError(400, 'Keep clinical details out of the subject');
    row.subject = s || null;
  }
  if (body.options != null) row.options = JSON.stringify(await cleanOptions(db, pid, j, { ...parse(before.options, {}), ...body.options }));
  if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
  const turningOn = row.enabled === 1 && !before.enabled;
  const sets = Object.keys(row).map((k) => `${k} = ?`);
  await db.run(
    `UPDATE journey_settings SET ${sets.join(', ')}${turningOn ? ", enabled_since = datetime('now')" : ''}, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
    ...Object.values(row), req.user.id, before.id,
  );
  // The engine's side: the sequence's switch and the step's channel and subject.
  if (j.engine) {
    const seq = await db.get('SELECT * FROM cadence_sequences WHERE practice_id = ? AND type = ? AND subtype = ?', pid, TYPE, key);
    if (row.enabled != null) await recorded(db, 'cadence_sequences', seq.id, () => db.run("UPDATE cadence_sequences SET active = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?", row.enabled, req.user.id, seq.id));
    if (row.channel || 'subject' in row) {
      await db.run('UPDATE cadence_steps SET channel = ?, subject = ? WHERE sequence_id = ? AND active = 1', channel, row.subject !== undefined ? row.subject : before.subject, seq.id);
    }
  }
  if (key === 'survey' && row.enabled != null) await syncSurvey(db, pid, !!row.enabled, req.user.id);
  const after = await db.get('SELECT * FROM journey_settings WHERE id = ?', before.id);
  const pickLog = (r) => ({ enabled: r.enabled, channel: r.channel, template: r.template, subject: r.subject, options: r.options });
  await audit(db, req, row.enabled == null ? 'journey.update' : row.enabled ? 'journey.on' : 'journey.off', 'journey_settings', before.id, { key }, { before: pickLog(before), after: pickLog(after) });
  publish(pid, { type: 'journeys' });
  return journeySetting(db, pid, key);
}

async function cleanOptions(db, pid, j, o) {
  const out = {};
  const user = async (v) => {
    if (v == null || v === '') return null;
    const u = await db.get('SELECT id FROM users WHERE id = ? AND practice_id = ? AND active = 1', Number(v), pid);
    if (!u) throw new HttpError(400, 'Choose someone on the team');
    return u.id;
  };
  const int = (v, lo, hi, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${what} must be ${lo} to ${hi}`);
    return n;
  };
  const d = j.options || {};
  for (const k of Object.keys(d)) {
    const v = o[k] ?? d[k];
    if (k === 'code_prefixes') {
      const list = (Array.isArray(v) ? v : String(v).split(/[\s,]+/)).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
      if (!list.length || list.length > 20 || list.some((x) => !/^D\d{1,4}$/.test(x))) throw new HttpError(400, 'Procedure codes start with D and a number (D7, D33…)');
      out[k] = [...new Set(list)];
    } else if (k === 'evening') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw new HttpError(400, 'The check-in time is HH:MM');
      out[k] = String(v);
    } else if (k === 'years') {
      const list = (Array.isArray(v) ? v : String(v).split(/[\s,]+/)).filter((x) => x !== '').map((x) => int(x, 1, 80, 'Anniversary years'));
      if (!list.length) throw new HttpError(400, 'Choose at least one anniversary');
      out[k] = [...new Set(list)].sort((a, b) => a - b);
    } else if (k === 'threshold_cents') out[k] = int(v, 0, 10_000_000_00, 'The treatment amount');
    else if (k === 'recent_months') out[k] = int(v, 1, 120, 'Months');
    else if (k === 'months') out[k] = int(v, 6, 60, 'Months since the last visit');
    else if (k === 'max_age') out[k] = int(v, 0, 17, 'The age for kids’ cards');
    else if (k === 'assign_to' || k === 'owner_user_id') out[k] = await user(v);
    else if (typeof d[k] === 'boolean') out[k] = !!v;
    else out[k] = String(v ?? '').trim().slice(0, 100);
  }
  return out;
}

// The one-question survey reuses Surveys: a practice survey with auto_after_visit, sent by the survey job.
export const QUICK_SURVEY = 'Quick check-in (after visits)';
export async function syncSurvey(db, pid, on, userId = null) {
  const row = await db.get('SELECT * FROM surveys WHERE practice_id = ? AND name = ?', pid, QUICK_SURVEY);
  if (!row && on) {
    const questions = [
      { id: 'nps', type: 'nps', label: 'How likely are you to recommend us to a friend or family member?', label_es: '¿Qué tan probable es que nos recomiende a un amigo o familiar?' },
      { id: 'comment', type: 'text', label: 'Anything you’d like us to know? (optional)', label_es: '¿Algo que quiera contarnos? (opcional)' },
    ];
    await db.run('INSERT INTO surveys (practice_id, name, questions, auto_after_visit, active, created_by) VALUES (?, ?, ?, 1, 1, ?)', pid, QUICK_SURVEY, JSON.stringify(questions), userId);
  } else if (row) await db.run('UPDATE surveys SET auto_after_visit = ?, active = ? WHERE id = ?', on ? 1 : 0, on ? 1 : row.active, row.id);
}

export async function journeyProfile(db, pid) {
  await ensureJourneySchema(db);
  const r = await db.get('SELECT * FROM journey_profile WHERE practice_id = ?', pid);
  return {
    parking: r?.parking ?? '', what_to_bring: r?.what_to_bring ?? 'your photo ID, your insurance card and a list of any medicines you take',
    what_to_expect: r?.what_to_expect ?? 'Your first visit is about getting to know you. We’ll listen, take a careful look, answer every question and plan next steps together. Plan on about an hour.',
    team_note: r?.team_note ?? '', doctor_photo: r?.doctor_photo ?? null, updated_at: r?.updated_at ?? null,
  };
}

// ---- Merge fields ----
const DAY = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const TIME = (dt) => {
  const [h, m] = dt.slice(11, 16).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
// "Dr. Ann Lee, DDS" → "Dr. Ann Lee"; a dentist without the title gets it.
export function doctorName(p) {
  if (!p?.name) return null;
  const bare = String(p.name).replace(/,\s*(DDS|DMD|RDH|MS|MD|PhD|FAGD|MAGD)\b.*$/i, '').trim();
  return p.type === 'dentist' && !/^dr\.?\s/i.test(bare) ? `Dr. ${bare}` : bare;
}
const addressOf = (x) => (x?.address ? `${x.address}${x.city ? `, ${x.city}` : ''}` : '');
const yearsWord = (n) => `${n} year${n === 1 ? '' : 's'}`;
// Set by the routes (and tests): the app's address for links, and the messenger a review request after a good
// check-in uses. The engine's describe() has no deps of its own.
const journeyConfig = { appUrl: null, messenger: null };
export function configureJourneys({ appUrl, messenger } = {}) {
  if (appUrl != null) journeyConfig.appUrl = appUrl;
  if (messenger) journeyConfig.messenger = messenger;
}
export const appUrlOf = (deps) => deps?.appUrl ?? journeyConfig.appUrl ?? process.env.APP_URL ?? '';

// The words for one message about one patient. ctx: { key, appointment?, provider?, visitDate?, years?, link? }.
export async function journeyVars(db, practice, patient, ctx = {}) {
  const profile = await journeyProfile(db, practice.id);
  const location = (ctx.appointment?.location_id || patient.location_id)
    ? await db.get('SELECT * FROM locations WHERE id = ? AND practice_id = ?', ctx.appointment?.location_id || patient.location_id, practice.id) : null;
  const provider = ctx.provider || (ctx.appointment ? await db.get('SELECT * FROM providers WHERE id = ?', ctx.appointment.provider_id) : null)
    || (patient.primary_provider_id ? await db.get('SELECT * FROM providers WHERE id = ?', patient.primary_provider_id) : null)
    || await db.get("SELECT * FROM providers WHERE practice_id = ? AND active = 1 AND type = 'dentist' ORDER BY id LIMIT 1", practice.id);
  const when = ctx.appointment?.start_time || null;
  return {
    first_name: patient.preferred_name || patient.first_name, practice: practice.name, doctor: doctorName(provider) || `the team at ${practice.name}`,
    date: when ? DAY(when.slice(0, 10)) : ctx.visitDate ? DAY(ctx.visitDate) : '', time: when ? TIME(when) : '',
    address: addressOf(location?.address ? location : practice), parking: profile.parking || '', phone: location?.phone || practice.phone || 'the office',
    what_to_bring: profile.what_to_bring, link: ctx.link || '', years: ctx.years ? yearsWord(ctx.years) : '', next_visit: ctx.next_visit || '',
  };
}
export const renderJourney = (template, vars) => renderTemplate(String(template || ''), vars);

// A pretend patient for previews and tests sent to yourself: nothing real leaves the building.
export async function sampleVars(db, practice, key) {
  const fake = { id: 0, practice_id: practice.id, first_name: 'Alex', location_id: null, primary_provider_id: null };
  const tomorrow = addDays(localNow(practice.timezone || 'America/New_York').slice(0, 10), 1);
  return journeyVars(db, practice, fake, {
    key, appointment: null, visitDate: tomorrow, years: 5, link: `${appUrlOf()}/…`,
    next_visit: `Your next visit is ${DAY(addDays(tomorrow, 180))} at 9:00 AM.`,
  }).then((v) => ({ ...v, date: DAY(tomorrow), time: '9:00 AM' }));
}

// ---- The cadence type ----
const ACTIVE_VISIT = "('scheduled','confirmed','checked_in','in_chair')";
const ageOn = (dob, date) => {
  const [y, m, d] = String(dob).slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = date.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
};
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
// This year's birthday (29 February is kept on the 28th in other years).
export function birthdayIn(dob, year) {
  const md = String(dob).slice(5, 10);
  return md === '02-29' && !isLeap(year) ? `${year}-02-28` : `${year}-${md}`;
}
const dayRange = (d) => [`${d} 00:00`, `${d} 24:00`];

// Visits that are a patient's first: nothing completed before (no visit, no procedure, no recall), no earlier
// booked visit, and the chart is new (made in the last 180 days, so a chart imported without its history isn't "new").
export async function firstVisitIds(db, practiceId, appts) {
  const ids = [...new Set(appts.map((a) => a.patient_id))];
  if (!ids.length) return new Set();
  const IN = ids.map(() => '?').join(',');
  const seen = new Set((await db.all(
    `SELECT DISTINCT patient_id FROM appointments WHERE practice_id = ? AND patient_id IN (${IN}) AND status = 'completed'`, practiceId, ...ids,
  )).map((r) => r.patient_id));
  const treated = new Set((await db.all(`SELECT DISTINCT patient_id FROM procedures WHERE practice_id = ? AND patient_id IN (${IN}) AND status = 'completed'`, practiceId, ...ids)).map((r) => r.patient_id));
  // A recall on file means someone has cared for them before (a chart brought over from another system).
  for (const r of await db.all(`SELECT DISTINCT patient_id FROM recalls WHERE practice_id = ? AND patient_id IN (${IN})`, practiceId, ...ids)) treated.add(r.patient_id);
  const charts = new Map((await db.all(`SELECT id, created_at FROM patients WHERE practice_id = ? AND id IN (${IN})`, practiceId, ...ids)).map((r) => [r.id, r.created_at]));
  const earliest = new Map((await db.all(
    `SELECT patient_id, MIN(start_time) AS first FROM appointments WHERE practice_id = ? AND patient_id IN (${IN}) AND status NOT IN ('cancelled','no_show') GROUP BY patient_id`, practiceId, ...ids,
  )).map((r) => [r.patient_id, r.first]));
  const recent = utcStamp(new Date(Date.now() - 180 * 86400_000));
  const out = new Set();
  for (const a of appts) {
    if (['cancelled', 'no_show'].includes(a.status)) continue;
    const onlyToday = a.status === 'completed' ? (await db.get(`SELECT COUNT(*) AS n FROM appointments WHERE patient_id = ? AND status = 'completed' AND start_time < ?`, a.patient_id, a.start_time)).n === 0 : !seen.has(a.patient_id);
    if (!onlyToday) continue;
    if (a.status !== 'completed' && treated.has(a.patient_id)) continue;
    if ((charts.get(a.patient_id) || '') < recent) continue;
    if (earliest.get(a.patient_id) && earliest.get(a.patient_id) < a.start_time) continue;
    out.add(a.id);
  }
  return out;
}
// For the schedule payload: first_visit on each appointment ("first visit — greet by name" on the card).
export async function markFirstVisits(db, practiceId, appts) {
  const firsts = await firstVisitIds(db, practiceId, appts);
  for (const a of appts) a.first_visit = firsts.has(a.id);
  return appts;
}

async function settingsMap(db, pid) {
  const rows = await db.all('SELECT * FROM journey_settings WHERE practice_id = ?', pid);
  return new Map(rows.map((r) => [r.key, { ...r, options: { ...(journeyDef(r.key)?.options || {}), ...parse(r.options, {}) } }]));
}
async function prefsFor(db, patientId) {
  return (await db.get('SELECT * FROM journey_prefs WHERE patient_id = ?', patientId)) || { newsletter: 0, vip: 0, no_celebrations: 0 };
}

export const journeyCadence = {
  label: 'Patient journeys',
  messageKind: 'journey',
  linkPath: null,
  enabled: () => true,

  async defaultSequences(db, practiceId) {
    await ensureJourneySetup(db, practiceId);
    return ENGINE.map((j) => ({ subtype: j.key, name: j.name, steps: [{ offset_days: j.offset, channel: j.channel, template: '{visit}', subject: j.subject }] }));
  },

  // Who's due, per journey that's on (windows has a key for each active sequence).
  async candidates(db, practice, { today, nowLocal, windows }) {
    const pid = practice.id;
    await ensureJourneySetup(db, pid);
    const on = (k) => !!windows[k];
    const s = await settingsMap(db, pid);
    const out = [];
    const [t0, t1] = dayRange(today);

    if (on('welcome') || on('arrival')) {
      for (const k of ['welcome', 'arrival']) {
        if (!on(k)) continue;
        const to = addDays(today, k === 'welcome' ? 120 : 1);
        const rows = await db.all(
          `SELECT a.id, a.patient_id, a.start_time, a.status, a.location_id FROM appointments a JOIN patients p ON p.id = a.patient_id
           WHERE a.practice_id = ? AND a.status IN ('scheduled','confirmed') AND a.start_time >= ? AND a.start_time < ? AND p.status = 'active' AND a.created_at >= ?`,
          pid, `${today} 00:00`, `${to} 24:00`, s.get(k)?.enabled_since || '9999',
        );
        const firsts = await firstVisitIds(db, pid, rows);
        for (const a of rows.filter((x) => firsts.has(x.id))) {
          if (k === 'arrival' && a.start_time.slice(0, 10) !== addDays(today, 1)) continue;
          out.push({ patient_id: a.patient_id, subtype: k, source_type: 'appointment', source_id: a.id, anchor_date: a.start_time.slice(0, 10), location_id: a.location_id });
        }
      }
    }

    if (on('thankyou') || on('summary')) {
      const rows = await db.all(
        `SELECT a.patient_id, MIN(a.id) AS id, MIN(a.location_id) AS location_id FROM appointments a JOIN patients p ON p.id = a.patient_id
         WHERE a.practice_id = ? AND a.status = 'completed' AND a.start_time >= ? AND a.start_time < ? AND p.status = 'active' GROUP BY a.patient_id`, pid, t0, t1,
      );
      // The summary says thank you too: with both on, only the summary goes.
      const k = on('summary') ? 'summary' : 'thankyou';
      for (const r of rows) out.push({ patient_id: r.patient_id, subtype: k, source_type: 'patient_day', source_id: r.patient_id, anchor_date: today, location_id: r.location_id });
    }

    if (on('postop') && nowLocal.slice(11, 16) >= (s.get('postop')?.options.evening || '18:00')) {
      const prefixes = s.get('postop')?.options.code_prefixes || [];
      if (prefixes.length) {
        const rows = await db.all(
          `SELECT pr.patient_id, MIN(pr.location_id) AS location_id FROM procedures pr JOIN patients p ON p.id = pr.patient_id
           WHERE pr.practice_id = ? AND pr.status = 'completed' AND pr.completed_at >= ? AND pr.completed_at < ? AND p.status = 'active'
             AND (${prefixes.map(() => 'pr.code LIKE ?').join(' OR ')}) GROUP BY pr.patient_id`, pid, t0, t1, ...prefixes.map((x) => `${x}%`),
        );
        for (const r of rows) out.push({ patient_id: r.patient_id, subtype: 'postop', source_type: 'patient_day', source_id: r.patient_id, anchor_date: today, location_id: r.location_id });
      }
    }

    if (on('birthday') || on('birthday_card')) {
      const days = on('birthday_card') ? [0, 1, 2, 3, 4, 5, 6, 7].map((n) => addDays(today, n)) : [today];
      const mds = new Set(days.map((d) => d.slice(5)));
      if (days.some((d) => d.endsWith('-02-28') && !isLeap(Number(d.slice(0, 4))))) mds.add('02-29');
      const recent = s.get('birthday')?.options.recent_months ?? 36;
      const since = `${addDays(today, -Math.round(recent * 30.44))} 00:00`;
      const rows = await db.all(
        `SELECT p.id, p.dob, p.location_id, p.created_at, (SELECT MAX(a.start_time) FROM appointments a WHERE a.patient_id = p.id AND a.status = 'completed') AS last_visit
         FROM patients p WHERE p.practice_id = ? AND p.status = 'active' AND p.merged_into_id IS NULL AND p.dob IS NOT NULL AND substr(p.dob, 6, 5) IN (${[...mds].map(() => '?').join(',')})`,
        pid, ...mds,
      );
      for (const p of rows) {
        const prefs = await prefsFor(db, p.id);
        if (prefs.no_celebrations) continue;
        const bday = birthdayIn(p.dob, Number(today.slice(0, 4)));
        const current = (p.last_visit && p.last_visit >= since) || p.created_at >= since.slice(0, 10);
        if (on('birthday') && bday === today && current) out.push({ patient_id: p.id, subtype: 'birthday', source_type: 'patient', source_id: p.id, anchor_date: bday, location_id: p.location_id });
        if (on('birthday_card') && bday >= today && bday <= days.at(-1)) {
          const o = s.get('birthday_card')?.options || {};
          const kid = ageOn(p.dob, bday) <= (o.max_age ?? 12);
          if ((kid || (o.vip && prefs.vip)) && current) out.push({ patient_id: p.id, subtype: 'birthday_card', source_type: 'patient', source_id: p.id, anchor_date: bday, location_id: p.location_id });
        }
      }
    }

    if (on('anniversary')) {
      const years = s.get('anniversary')?.options.years || [];
      const dates = years.map((y) => `${Number(today.slice(0, 4)) - y}${today.slice(4)}`);
      if (dates.length) {
        const rows = await db.all(
          `SELECT a.patient_id, MIN(a.start_time) AS first, MIN(p.location_id) AS location_id FROM appointments a JOIN patients p ON p.id = a.patient_id
           WHERE a.practice_id = ? AND a.status = 'completed' AND p.status = 'active' GROUP BY a.patient_id HAVING substr(MIN(a.start_time), 6, 5) = ?`, pid, today.slice(5),
        );
        for (const r of rows) {
          if (!dates.includes(r.first.slice(0, 10)) || (await prefsFor(db, r.patient_id)).no_celebrations) continue;
          out.push({ patient_id: r.patient_id, subtype: 'anniversary', source_type: 'patient', source_id: r.patient_id, anchor_date: today, location_id: r.location_id });
        }
      }
    }

    if (on('milestone')) {
      const rows = await db.all(
        "SELECT m.id, m.patient_id, m.detected_on, p.location_id FROM journey_moments m JOIN patients p ON p.id = m.patient_id WHERE m.practice_id = ? AND m.kind IN ('braces_off','cavity_free') AND m.status <> 'dismissed' AND m.detected_on >= ?",
        pid, addDays(today, -7),
      );
      for (const r of rows) out.push({ patient_id: r.patient_id, subtype: 'milestone', source_type: 'journey_moment', source_id: r.id, anchor_date: r.detected_on, location_id: r.location_id });
    }

    if (on('reactivation')) {
      const months = s.get('reactivation')?.options.months ?? 18;
      const cutoff = addDays(today, -Math.round(months * 30.44));
      const oldest = addDays(today, -365 * 5);
      const recallOn = Number(practice.recall_cadence) === 1;
      const rows = await db.all(
        `SELECT p.id, p.location_id, MAX(a.start_time) AS last FROM patients p JOIN appointments a ON a.patient_id = p.id AND a.status = 'completed'
         WHERE p.practice_id = ? AND p.status = 'active' AND p.merged_into_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM appointments f WHERE f.patient_id = p.id AND f.status IN ${ACTIVE_VISIT} AND f.start_time >= ?)
         GROUP BY p.id, p.location_id HAVING MAX(a.start_time) < ? AND MAX(a.start_time) >= ?`, pid, `${today} 00:00`, `${cutoff} 00:00`, `${oldest} 00:00`,
      );
      for (const r of rows) {
        // Recall autopilot already says "we miss you" to patients with a recall due: it keeps them.
        if (recallOn && await db.get("SELECT id FROM recalls WHERE practice_id = ? AND patient_id = ? AND status IN ('due','contacted')", pid, r.id)) continue;
        const anchor = addDays(r.last.slice(0, 10), Math.round(months * 30.44));
        out.push({ patient_id: r.id, subtype: 'reactivation', source_type: 'patient', source_id: r.id, anchor_date: anchor, location_id: r.location_id });
      }
    }

    if (on('referral_thanks')) {
      for (const r of await referralsSeen(db, pid, addDays(today, -14))) {
        out.push({ patient_id: r.referrer_patient_id, subtype: 'referral_thanks', source_type: 'journey_referral', source_id: r.id, anchor_date: r.first_visit.slice(0, 10), location_id: null });
      }
    }
    return out;
  },

  // Checked on every pass and again right before every send.
  async stopCheck(db, e, ctx) {
    const seq = await db.get('SELECT subtype FROM cadence_sequences WHERE id = ?', e.sequence_id);
    const today = ctx?.today || localNow((await db.get('SELECT timezone FROM practices WHERE id = ?', e.practice_id))?.timezone || 'America/New_York').slice(0, 10);
    const k = seq?.subtype;
    if (k === 'welcome' || k === 'arrival') {
      const a = await db.get('SELECT status, start_time FROM appointments WHERE id = ? AND practice_id = ?', e.source_id, e.practice_id);
      if (!a || !['scheduled', 'confirmed'].includes(a.status) || a.start_time.slice(0, 10) !== e.anchor_date) return { reason: 'visit_changed' };
      if (today >= e.anchor_date) return { reason: 'too_late' };
    }
    // A thank-you or a check-in held overnight by quiet hours still goes the next morning; a birthday is on the day.
    if (['thankyou', 'summary', 'postop', 'anniversary', 'referral_thanks'].includes(k) && today > addDays(e.anchor_date, 1)) return { reason: 'too_late' };
    if (['birthday', 'birthday_card'].includes(k) && today > e.anchor_date) return { reason: 'too_late' };
    if (['birthday', 'birthday_card', 'anniversary'].includes(k) && (await prefsFor(db, e.patient_id)).no_celebrations) return { reason: 'no_contact' };
    if (k === 'milestone') {
      const m = await db.get('SELECT status FROM journey_moments WHERE id = ?', e.source_id);
      if (!m || m.status === 'dismissed') return { reason: 'moment_dismissed' };
    }
    if (k === 'reactivation') {
      const f = await db.get(`SELECT id FROM appointments WHERE practice_id = ? AND patient_id = ? AND status IN ${ACTIVE_VISIT} AND start_time >= ? ORDER BY start_time LIMIT 1`, e.practice_id, e.patient_id, `${today} 00:00`);
      if (f) return { reason: 'booked', appointment_id: f.id };
      const seen = await db.get("SELECT MAX(start_time) AS last FROM appointments WHERE patient_id = ? AND status = 'completed'", e.patient_id);
      if (seen?.last && seen.last.slice(0, 10) > addDays(e.anchor_date, -400)) {
        // Came in after we enrolled them (the anchor is last visit + months): nothing to miss.
        const months = (await journeySetting(db, e.practice_id, 'reactivation'))?.options.months ?? 18;
        if (addDays(seen.last.slice(0, 10), Math.round(months * 30.44)) !== e.anchor_date) return { reason: 'already_seen' };
      }
    }
    return null;
  },

  // The whole message (see the note at the top): the journey's wording with its fields filled in.
  async describe(db, enrollments) {
    const e = enrollments[0];
    try {
      return { visit: await writeMessage(db, e) };
    } catch (err) {
      await raiseIssue(db, { practiceId: e.practice_id, kind: 'message', key: `journey-write:${e.id}`, role: 'front_desk', patientId: e.patient_id, title: 'A patient journey message couldn’t be written', detail: err.message });
      throw err;
    }
  },

  // Post-op check-ins that went by text wait for the reply.
  async afterSend(db, enrollments) {
    for (const e of enrollments) {
      const seq = await db.get('SELECT subtype FROM cadence_sequences WHERE id = ?', e.sequence_id);
      if (seq?.subtype !== 'postop') continue;
      const run = await db.get("SELECT r.message_id, m.to_address, m.channel FROM cadence_runs r LEFT JOIN messages m ON m.id = r.message_id WHERE r.enrollment_id = ? AND r.status = 'sent' ORDER BY r.id DESC LIMIT 1", e.id);
      if (!run?.message_id || run.channel !== 'sms') continue;
      const proc = await db.get(
        "SELECT provider_id FROM procedures WHERE patient_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ? AND provider_id IS NOT NULL ORDER BY fee DESC LIMIT 1",
        e.patient_id, ...dayRange(e.anchor_date),
      );
      await db.run(
        `INSERT INTO journey_checkins (practice_id, patient_id, enrollment_id, provider_id, visit_date, phone, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (enrollment_id) DO NOTHING`, e.practice_id, e.patient_id, e.id, proc?.provider_id ?? null, e.anchor_date, digits(run.to_address), run.message_id,
      );
    }
  },
};
registerCadenceType(TYPE, journeyCadence);

async function referralsSeen(db, pid, since) {
  return db.all(
    `SELECT r.*, (SELECT MIN(a.start_time) FROM appointments a WHERE a.patient_id = r.referred_patient_id AND a.status = 'completed') AS first_visit
     FROM journey_referrals r JOIN patients p ON p.id = r.referrer_patient_id WHERE r.practice_id = ? AND p.status = 'active'
       AND (SELECT MIN(a.start_time) FROM appointments a WHERE a.patient_id = r.referred_patient_id AND a.status = 'completed') >= ?`, pid, `${since} 00:00`,
  );
}

// Writes the message for one enrollment.
export async function writeMessage(db, e, deps = {}) {
  const seq = await db.get('SELECT subtype FROM cadence_sequences WHERE id = ?', e.sequence_id);
  const key = seq.subtype;
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', e.practice_id);
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', e.patient_id);
  const setting = await db.get('SELECT * FROM journey_settings WHERE practice_id = ? AND key = ?', e.practice_id, key);
  const j = journeyDef(key);
  const ctx = { key, visitDate: e.anchor_date };
  const appUrl = appUrlOf(deps);
  if (key === 'welcome' || key === 'arrival') {
    ctx.appointment = await db.get('SELECT * FROM appointments WHERE id = ?', e.source_id);
    if (key === 'welcome') ctx.link = await welcomeLink(db, { practiceId: practice.id, patientId: patient.id, enrollmentId: e.id, appointmentId: e.source_id, appUrl, visitDate: e.anchor_date });
  }
  if (['thankyou', 'summary', 'postop'].includes(key)) {
    ctx.appointment = await db.get(`SELECT * FROM appointments WHERE practice_id = ? AND patient_id = ? AND start_time >= ? AND start_time < ? AND status NOT IN ('cancelled','no_show') ORDER BY start_time DESC LIMIT 1`, practice.id, patient.id, ...dayRange(e.anchor_date));
  }
  if (key === 'summary') {
    const next = await db.get(`SELECT start_time FROM appointments WHERE practice_id = ? AND patient_id = ? AND status IN ${ACTIVE_VISIT} AND start_time > ? ORDER BY start_time LIMIT 1`, practice.id, patient.id, `${e.anchor_date} 24:00`);
    ctx.next_visit = next ? `Your next visit is ${DAY(next.start_time.slice(0, 10))} at ${TIME(next.start_time)}.` : 'Whenever you’re ready for your next visit, just reply and we’ll find a time.';
    ctx.link = `${appUrl}/portal`;
  }
  if (key === 'anniversary') {
    const first = await db.get("SELECT MIN(start_time) AS first FROM appointments WHERE patient_id = ? AND status = 'completed'", patient.id);
    ctx.years = first?.first ? Number(e.anchor_date.slice(0, 4)) - Number(first.first.slice(0, 4)) : null;
  }
  if (key === 'reactivation') ctx.link = practice.online_booking && practice.slug ? `${appUrl}/book/${practice.slug}` : (practice.phone || '');
  if (!ctx.link) ctx.link = `${appUrl}/portal`;
  const vars = await journeyVars(db, practice, patient, ctx);
  const text = renderJourney(setting?.template || j.template, vars);
  // The last line of defence: an office edit that slipped past validation never sends clinical words.
  if (CLINICAL.test(text)) throw new HttpError(400, `The ${j.name} wording mentions clinical details — edit it in Settings → Patient journeys`);
  return text;
}

async function welcomeLink(db, { practiceId, patientId, enrollmentId, appointmentId, appUrl, visitDate }) {
  const { token, hash } = newToken();
  await addRow(db, 'journey_links', {
    practice_id: practiceId, patient_id: patientId, enrollment_id: enrollmentId, appointment_id: appointmentId, purpose: 'welcome', token_hash: hash,
    expires_at: `${addDays(visitDate, 14)} 23:59:59`,
  });
  return `${appUrl}/welcome/${token}`;
}
export async function welcomeFromToken(db, token) {
  await ensureJourneySchema(db);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(token || ''))) throw new HttpError(404, 'This link is not valid');
  const link = await db.get('SELECT * FROM journey_links WHERE token_hash = ?', hashToken(token));
  if (!link) throw new HttpError(404, 'This link is not valid');
  if (link.expires_at < utcStamp(new Date())) throw new HttpError(410, 'This welcome page has expired — we can’t wait to see you!');
  if (!link.opened_at) await db.run("UPDATE journey_links SET opened_at = datetime('now') WHERE id = ?", link.id);
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', link.practice_id);
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', link.patient_id);
  const appt = link.appointment_id ? await db.get('SELECT * FROM appointments WHERE id = ?', link.appointment_id) : null;
  const vars = await journeyVars(db, practice, patient, { appointment: appt });
  const profile = await journeyProfile(db, practice.id);
  // First name, the visit time and the office: nothing clinical, nothing else about the patient.
  return {
    practice: { name: practice.name, phone: practice.phone, address: vars.address }, first_name: vars.first_name, doctor: vars.doctor, date: vars.date, time: vars.time,
    parking: profile.parking, what_to_bring: profile.what_to_bring, what_to_expect: profile.what_to_expect, team_note: profile.team_note, doctor_photo: profile.doctor_photo,
    active: !!appt && ['scheduled', 'confirmed'].includes(appt.status),
  };
}

// ---- Post-op replies (the inbound text handler calls this) ----
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const REPLY_WORDS = { 1: 'doing well', 2: 'some discomfort', 3: 'wants to talk' };
// Returns the text to answer with, or null when the text isn't an answer to a check-in.
export async function postopReply(db, { practice, from, body, now = new Date() }) {
  const m = /^\s*([123])(\s|[.!)]|$)/.exec(String(body || ''));
  if (!m || !practice) return null;
  try {
    await ensureJourneySchema(db);
    const since = utcStamp(new Date(now.getTime() - 3 * 86400_000));
    const c = await db.get('SELECT * FROM journey_checkins WHERE practice_id = ? AND phone = ? AND created_at >= ? ORDER BY id DESC LIMIT 1', practice.id, digits(from), since);
    if (!c) return null;
    const code = Number(m[1]);
    const text = String(body).trim().slice(0, 300);
    // The first answer counts; a worse one later still reaches the doctor (someone who said "good" and now hurts).
    const { changes } = await db.run(
      "UPDATE journey_checkins SET reply = ?, reply_text = ?, replied_at = datetime('now') WHERE id = ? AND (reply IS NULL OR reply < ?)", code, text, c.id, code,
    );
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', c.patient_id);
    const provider = c.provider_id ? await db.get('SELECT * FROM providers WHERE id = ?', c.provider_id) : null;
    const doctor = doctorName(provider) || 'the doctor';
    const phone = practice.phone || 'the office';
    if (changes) {
      await audit(db, { user: { practice_id: practice.id, id: null } }, 'journey.postop.reply', 'journey_checkins', c.id, { reply: code, meaning: REPLY_WORDS[code] }, { patientId: c.patient_id, source: 'patient', actor: 'Patient (text message)' });
      if (code >= 2) {
        const title = `${code === 3 ? 'Wants to talk' : 'Some discomfort'} after their visit: ${patient.first_name} ${patient.last_name} replied “${text.slice(0, 60)}” — please call ${patient.phone || ''}`.trim();
        const taskId = await addRow(db, 'tasks', {
          practice_id: practice.id, patient_id: c.patient_id, assigned_to: provider?.user_id ?? null, priority: 'high', due_date: localNow(practice.timezone || 'America/New_York').slice(0, 10),
          title: title.slice(0, 200), notes: `Evening check-in after the visit on ${c.visit_date}. Reply: ${code} (${REPLY_WORDS[code]}). Call the patient and note how they are in the chart.`,
        });
        await db.run('UPDATE journey_checkins SET task_id = ? WHERE id = ?', taskId, c.id);
        await raiseIssue(db, {
          practiceId: practice.id, kind: 'message', key: `postop:${c.id}`, role: 'clinical', severity: code === 3 ? 'high' : 'normal', entity: 'journey_checkins', entityId: c.id, patientId: c.patient_id,
          title: `${patient.first_name} ${patient.last_name} ${code === 3 ? 'asked to talk' : 'has some discomfort'} after their visit — call them (${doctor} has a task)`,
        });
        publish(practice.id, { type: 'tasks' });
        publish(practice.id, { type: 'journeys', patient_id: c.patient_id });
      } else {
        await maybeAskForReview(db, practice, patient);
      }
    }
    if (code === 1) return `So glad to hear it, ${patient.first_name}! Rest up, and call us at ${phone} if anything changes.`;
    if (code === 2) return `Thanks for letting us know, ${patient.first_name}. We’ve told ${doctor} and someone will check in with you soon. If it gets worse, call us at ${phone}.`;
    return `We’ve let ${doctor} know and someone will call you shortly. If this is an emergency, call 911.`;
  } catch (err) {
    await raiseIssue(db, { practiceId: practice.id, kind: 'message', key: `postop-reply:${digits(from)}`, role: 'clinical', severity: 'high', title: 'A reply to a post-visit check-in couldn’t be read — check the texts', detail: err.message });
    return null;
  }
}

// Reviews (RV) belong to the review funnel; asked only after a good check-in and only when the office says so.
async function maybeAskForReview(db, practice, patient) {
  const s = await journeySetting(db, practice.id, 'postop');
  if (!s?.options.review_after_good) return;
  try {
    const { requestReview } = await import('./reviewfunnel.js');
    if (typeof requestReview !== 'function' || !journeyConfig.messenger) return;
    await requestReview(db, journeyConfig.messenger, { practiceId: practice.id, patientId: patient.id, source: 'auto', appUrl: appUrlOf() });
  } catch (err) {
    if ([409, 422].includes(err?.status)) return; // asked recently, or can't be reached: the review funnel's rules
    await raiseIssue(db, { practiceId: practice.id, kind: 'message', key: `journey-review:${patient.id}`, role: 'front_desk', patientId: patient.id, title: 'A review request after a good check-in didn’t go', detail: err.message });
  }
}

// ---- The journey job: cards, milestones, life events, feedback, broadcasts ----
export async function runJourneyExtras(db, deps = {}) {
  await ensureJourneySchema(db);
  const now = deps.now || new Date();
  const stats = { cards: 0, moments: 0, comments: 0, broadcast_sent: 0, broadcast_failed: 0 };
  for (const practice of await db.all('SELECT * FROM practices ORDER BY id')) {
    if (deps.practiceIds && !deps.practiceIds.includes(practice.id)) continue;
    const key = 'journey-job';
    await withActor({ source: 'automation', actor: 'Patient journeys', practiceId: practice.id, userId: null, locationId: null, reason: null }, async () => {
      try {
        await ensureJourneySetup(db, practice.id);
        const today = localNow(practice.timezone || 'America/New_York', now).slice(0, 10);
        const s = await settingsMap(db, practice.id);
        await detectMilestones(db, practice, today, stats);
        if (s.get('life_events')?.enabled) await detectLifeEvents(db, practice, today, stats);
        if (s.get('card_task')?.enabled) await cardTasks(db, practice, today, s.get('card_task').options, stats);
        if (s.get('referral_gift')?.enabled) await giftTasks(db, practice, today, s.get('referral_gift').options, stats);
        await routeFeedback(db, practice, today, s.get('survey')?.options || {}, stats, now);
        await sendBroadcasts(db, practice, { ...deps, now }, stats);
        await resolveIssue(db, practice.id, key);
      } catch (err) {
        await raiseIssue(db, { practiceId: practice.id, kind: 'message', key, role: 'front_desk', title: 'Patient journeys stopped part-way — they will try again soon', detail: err.message });
      }
    });
  }
  return stats;
}

async function addMoment(db, practice, { patientId, kind, sourceKey, detail, today }, stats) {
  const r = await db.get(
    `INSERT INTO journey_moments (practice_id, patient_id, kind, source_key, detail, detected_on) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (practice_id, patient_id, kind, source_key) DO NOTHING RETURNING id`, practice.id, patientId, kind, sourceKey, detail ? String(detail).slice(0, 300) : null, today,
  );
  if (r?.id) {
    stats.moments++;
    await audit(db, { user: { practice_id: practice.id, id: null } }, 'journey.moment', 'journey_moments', r.id, { kind }, { patientId });
    publish(practice.id, { type: 'journeys', patient_id: patientId });
  }
  return r?.id ?? null;
}

// Braces off (the ortho case's debond date) and a child's first cavity-free checkup.
async function detectMilestones(db, practice, today, stats) {
  const from = addDays(today, -14);
  for (const c of await db.all("SELECT id, patient_id, debond_date FROM ortho_cases WHERE practice_id = ? AND debond_date IS NOT NULL AND debond_date >= ? AND debond_date <= ? AND status <> 'cancelled'", practice.id, from, today)) {
    await addMoment(db, practice, { patientId: c.patient_id, kind: 'braces_off', sourceKey: `case:${c.id}`, detail: 'Braces off', today: c.debond_date.slice(0, 10) }, stats);
  }
  const exams = await db.all(
    `SELECT pr.patient_id, MAX(pr.completed_at) AS at, p.dob FROM procedures pr JOIN patients p ON p.id = pr.patient_id
     WHERE pr.practice_id = ? AND pr.status = 'completed' AND pr.code IN ('D0120','D0145','D0150') AND pr.completed_at >= ? AND pr.completed_at < ? AND p.dob IS NOT NULL
     GROUP BY pr.patient_id, p.dob`, practice.id, `${from} 00:00`, `${today} 24:00`,
  );
  for (const x of exams) {
    const day = x.at.slice(0, 10);
    if (ageOn(x.dob, day) >= 18) continue;
    const caries = await db.get("SELECT id FROM tooth_conditions WHERE patient_id = ? AND resolved = 0 AND lower(condition) LIKE '%caries%'", x.patient_id);
    const restorative = await db.get("SELECT id FROM procedures WHERE patient_id = ? AND category = 'restorative' AND (status = 'planned' OR (status = 'completed' AND completed_at >= ?))", x.patient_id, `${day} 00:00`);
    if (caries || restorative) continue;
    await addMoment(db, practice, { patientId: x.patient_id, kind: 'cavity_free', sourceKey: 'first', detail: 'First cavity-free checkup', today: day }, stats);
  }
}

// Life events in the office's notes, for patients coming in this week. A suggestion only.
export const LIFE_EVENTS = [
  [/\b(new ?born|new baby|had a baby|baby (boy|girl)|became a (mom|dad|parent)|expecting|pregnan\w*)\b/i, 'New baby'],
  [/\b(wedding|got married|just married|engaged|engagement)\b/i, 'Wedding or engagement'],
  [/\b(graduat\w*)\b/i, 'Graduation'],
  [/\b(retir\w*)\b/i, 'Retirement'],
  [/\b(new job|promot\w*)\b/i, 'New job'],
  [/\b(new (house|home)|moved into)\b/i, 'New home'],
];
// Where personal notes come from. Today: the chart's notes and office alert. When personal-connection notes
// (PP2) exist, read them here too — the huddle and the suggestions use this one function.
export async function personalNotes(db, practiceId, patientIds) {
  if (!patientIds.length) return new Map();
  const rows = await db.all(`SELECT id, notes, office_alert FROM patients WHERE practice_id = ? AND id IN (${patientIds.map(() => '?').join(',')})`, practiceId, ...patientIds);
  return new Map(rows.map((r) => [r.id, [r.office_alert, r.notes].filter((x) => x && String(x).trim()).map((x) => String(x).trim())]));
}
async function detectLifeEvents(db, practice, today, stats) {
  const ids = (await db.all(
    `SELECT DISTINCT patient_id FROM appointments WHERE practice_id = ? AND status IN ${ACTIVE_VISIT} AND start_time >= ? AND start_time < ?`, practice.id, `${today} 00:00`, `${addDays(today, 7)} 24:00`,
  )).map((r) => r.patient_id);
  const notes = await personalNotes(db, practice.id, ids);
  for (const [pid, list] of notes) {
    for (const note of list) {
      for (const [re, label] of LIFE_EVENTS) {
        const hit = re.exec(note);
        if (!hit) continue;
        const start = Math.max(0, hit.index - 40);
        const excerpt = note.slice(start, hit.index + hit[0].length + 60).trim();
        await addMoment(db, practice, { patientId: pid, kind: 'life_event', sourceKey: createHash('sha256').update(`${label}:${note}`).digest('hex').slice(0, 16), detail: `${label}: “${excerpt}”`, today }, stats);
      }
    }
  }
}

async function addCardTask(db, practice, { patientId, reasonKey, reason, title, notes, assignTo, today }, stats) {
  const claim = await db.get(
    'INSERT INTO journey_cards (practice_id, patient_id, reason, reason_key) VALUES (?, ?, ?, ?) ON CONFLICT (practice_id, reason_key) DO NOTHING RETURNING id', practice.id, patientId, reason, reasonKey,
  );
  if (!claim?.id) return null;
  const taskId = await addRow(db, 'tasks', { practice_id: practice.id, patient_id: patientId, assigned_to: assignTo ?? null, priority: 'normal', due_date: addDays(today, 2), title: title.slice(0, 200), notes });
  await db.run('UPDATE journey_cards SET task_id = ? WHERE id = ?', taskId, claim.id);
  await audit(db, { user: { practice_id: practice.id, id: null } }, 'journey.card_task', 'journey_cards', claim.id, { reason, task_id: taskId }, { patientId });
  stats.cards++;
  publish(practice.id, { type: 'tasks' });
  return claim.id;
}

// A card after a new patient's first visit, and after a big treatment day (the office's threshold).
async function cardTasks(db, practice, today, o, stats) {
  const from = addDays(today, -2);
  const note = 'Write a short, personal note from the team (the doctor signs) and mail it. Tick this task when the card is in the mail.';
  if (o.first_visit !== false) {
    const done = await db.all(
      `SELECT a.id, a.patient_id, a.start_time, p.first_name, p.last_name FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.practice_id = ? AND a.status = 'completed' AND a.start_time >= ? AND a.start_time < ? AND p.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM appointments b WHERE b.patient_id = a.patient_id AND b.status = 'completed' AND b.start_time < a.start_time)`,
      practice.id, `${from} 00:00`, `${today} 24:00`,
    );
    for (const a of done) {
      await addCardTask(db, practice, {
        patientId: a.patient_id, reasonKey: `first:${a.patient_id}`, reason: 'first_visit', assignTo: o.assign_to, today,
        title: `Handwritten thank-you card: ${a.first_name} ${a.last_name} (first visit)`, notes: note,
      }, stats);
    }
  }
  const threshold = Number(o.threshold_cents) || 0;
  if (threshold > 0) {
    const big = await db.all(
      `SELECT pr.patient_id, substr(pr.completed_at, 1, 10) AS day, SUM(pr.fee) AS total, p.first_name, p.last_name FROM procedures pr JOIN patients p ON p.id = pr.patient_id
       WHERE pr.practice_id = ? AND pr.status = 'completed' AND pr.completed_at >= ? AND pr.completed_at < ? AND p.status = 'active'
       GROUP BY pr.patient_id, substr(pr.completed_at, 1, 10), p.first_name, p.last_name`, practice.id, `${from} 00:00`, `${today} 24:00`,
    );
    for (const b of big.filter((x) => Number(x.total) >= threshold)) {
      await addCardTask(db, practice, {
        patientId: b.patient_id, reasonKey: `big:${b.patient_id}:${b.day}`, reason: 'big_treatment', assignTo: o.assign_to, today,
        title: `Handwritten thank-you card: ${b.first_name} ${b.last_name} (big treatment day)`, notes: note,
      }, stats);
    }
  }
}
async function giftTasks(db, practice, today, o, stats) {
  for (const r of await referralsSeen(db, practice.id, addDays(today, -14))) {
    const p = await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', r.referrer_patient_id);
    await addCardTask(db, practice, {
      patientId: r.referrer_patient_id, reasonKey: `gift:${r.id}`, reason: 'referral_gift', assignTo: o.assign_to, today,
      title: `Referral thank-you gift: send ${p.first_name} ${p.last_name} a ${o.gift || 'gift card'}`, notes: 'A friend they referred came in for their first visit. Tick this task when the gift is in the mail.',
    }, stats);
  }
}

// After-visit survey answers: comments go to the owner as a task; a low score marks a hard visit for the huddle.
async function routeFeedback(db, practice, today, o, stats, now) {
  const since = utcStamp(new Date(now.getTime() - 7 * 86400_000));
  const rows = await db.all(
    `SELECT r.id, r.patient_id, r.nps, r.answers, p.first_name, p.last_name FROM survey_responses r JOIN patients p ON p.id = r.patient_id
     WHERE r.practice_id = ? AND r.answered_at IS NOT NULL AND r.answered_at >= ?`, practice.id, since,
  );
  let owner = o.owner_user_id || null;
  if (!owner) owner = (await db.get("SELECT id FROM users WHERE practice_id = ? AND role = 'admin' AND active = 1 ORDER BY id LIMIT 1", practice.id))?.id ?? null;
  for (const r of rows) {
    const answers = parse(r.answers, {});
    const comment = Object.values(answers).find((v) => typeof v === 'string' && v.trim().length > 1 && !['yes', 'no'].includes(v));
    if (r.nps != null && r.nps <= 6) await addMoment(db, practice, { patientId: r.patient_id, kind: 'hard_visit', sourceKey: `survey:${r.id}`, detail: `Scored us ${r.nps}/10 after their last visit`, today }, stats);
    if (comment) {
      const id = await addMoment(db, practice, { patientId: r.patient_id, kind: 'comment', sourceKey: `survey:${r.id}`, detail: comment.slice(0, 300), today }, stats);
      if (id) {
        const taskId = await addRow(db, 'tasks', {
          practice_id: practice.id, patient_id: r.patient_id, assigned_to: owner, priority: r.nps != null && r.nps <= 6 ? 'high' : 'normal', due_date: addDays(today, 1),
          title: `Patient comment (${r.nps != null ? `${r.nps}/10` : 'no score'}): ${r.first_name} ${r.last_name} — “${comment.slice(0, 120)}”`.slice(0, 200),
          notes: 'From the after-visit survey. Read it, and reach out if it needs a reply.',
        });
        await db.run('UPDATE journey_moments SET task_id = ? WHERE id = ?', taskId, id);
        stats.comments++;
      }
    }
  }
}

// ---- Holiday cards and newsletters ----
export const HOLIDAY_STARTERS = [
  { key: 'winter', title: 'Winter holidays', subject: 'Warm wishes from {practice}', body: 'Wishing you and your family a season full of warmth, laughter and time together. Thank you for being part of our practice family this year — it’s a joy to care for you. Happy holidays from all of us at {practice}!' },
  { key: 'thanksgiving', title: 'Thanksgiving', subject: 'We’re thankful for you', body: 'This Thanksgiving, we’re especially grateful for you. Thank you for trusting {practice} with your smile. We hope your table is full and your heart is fuller!' },
  { key: 'new_year', title: 'New Year', subject: 'Happy New Year from {practice}', body: 'Here’s to a bright, healthy and happy new year! Thank you for letting us be part of your year — we can’t wait to see you in the next one.' },
  { key: 'spring', title: 'Spring', subject: 'Happy spring from {practice}', body: 'Longer days, blooming flowers and a fresh start — happy spring from all of us at {practice}! We hope the season brings you lots to smile about.' },
];
export const NEWSLETTER_STARTER = { title: 'News from the office', subject: 'News from {practice}', body: 'Hi {first_name}! A quick hello from all of us at {practice}. Here’s what’s new at the office this season: … Thank you for being part of our practice family — we love seeing you.' };

// Everyone the card goes to: one per household (the head of the family), seen in the last two years, reachable.
export async function broadcastAudience(db, pid, kind, channel) {
  const since = `${addDays(new Date().toISOString().slice(0, 10), -730)} 00:00`;
  if (kind === 'newsletter') {
    return db.all(
      `SELECT p.* FROM patients p JOIN journey_prefs jp ON jp.patient_id = p.id AND jp.newsletter = 1
       WHERE p.practice_id = ? AND p.status = 'active' AND p.merged_into_id IS NULL AND p.email IS NOT NULL AND p.email_opt_in = 1 ORDER BY p.id`, pid,
    );
  }
  const rows = await db.all(
    `SELECT p.* FROM patients p WHERE p.practice_id = ? AND p.status = 'active' AND p.merged_into_id IS NULL AND (p.guarantor_id IS NULL OR p.guarantor_id = p.id)
       AND EXISTS (SELECT 1 FROM appointments a JOIN patients m ON m.id = a.patient_id WHERE (m.id = p.id OR m.guarantor_id = p.id) AND a.status = 'completed' AND a.start_time >= ?)
     ORDER BY p.id`, pid, since,
  );
  const out = [];
  for (const p of rows) {
    if ((await prefsFor(db, p.id)).no_celebrations) continue;
    if (channel === 'email' ? p.email && p.email_opt_in : mailable(p)) out.push(p);
  }
  return out;
}

// Starts sending: the recipient list is fixed now (once — a second click finds it already sending).
export async function startBroadcast(db, req, b) {
  if (b.status !== 'draft') {
    if (['sending', 'sent'].includes(b.status)) return b;
    throw new HttpError(409, 'This one was cancelled');
  }
  const { changes } = await db.run("UPDATE journey_broadcasts SET status = 'sending', sent_by = ?, started_at = datetime('now') WHERE id = ? AND status = 'draft'", req.user.id, b.id);
  if (!changes) return db.get('SELECT * FROM journey_broadcasts WHERE id = ?', b.id);
  const people = await broadcastAudience(db, b.practice_id, b.kind, b.channel);
  for (const p of people) {
    await db.run('INSERT INTO journey_broadcast_recipients (practice_id, broadcast_id, patient_id) VALUES (?, ?, ?) ON CONFLICT (broadcast_id, patient_id) DO NOTHING', b.practice_id, b.id, p.id);
  }
  await db.run('UPDATE journey_broadcasts SET recipients = ? WHERE id = ?', people.length, b.id);
  await audit(db, req, 'journey.broadcast.send', 'journey_broadcasts', b.id, { kind: b.kind, channel: b.channel, recipients: people.length, title: b.title });
  return db.get('SELECT * FROM journey_broadcasts WHERE id = ?', b.id);
}

const BATCH = 200;
async function sendBroadcasts(db, practice, deps, stats) {
  const nowLocal = localNow(practice.timezone || 'America/New_York', deps.now);
  for (const b of await db.all("SELECT * FROM journey_broadcasts WHERE practice_id = ? AND status = 'sending' ORDER BY id", practice.id)) {
    if (b.channel === 'email' && !withinSendHours(practice, nowLocal)) continue;
    const pending = await db.all("SELECT * FROM journey_broadcast_recipients WHERE broadcast_id = ? AND status = 'pending' ORDER BY id LIMIT ?", b.id, BATCH);
    let failedNow = 0;
    for (const r of pending) {
      // Claim with a fresh token (only its hash is kept): the unsubscribe link in this email.
      const { token, hash } = newToken();
      const claim = await db.run("UPDATE journey_broadcast_recipients SET status = 'skipped', result = 'sending', token_hash = ? WHERE id = ? AND status = 'pending'", hash, r.id);
      if (!claim.changes) continue;
      const p = await db.get('SELECT * FROM patients WHERE id = ?', r.patient_id);
      const vars = await journeyVars(db, practice, p, {});
      const text = renderJourney(b.body, vars);
      const subject = renderJourney(b.subject || b.title, vars);
      let status = 'failed';
      let result = null;
      let messageId = null;
      let external = null;
      if (b.channel === 'email') {
        const unsub = `${appUrlOf(deps)}/unsubscribe-news/${token}`;
        const body = b.kind === 'newsletter' ? `${text}\n\nDon’t want these? Unsubscribe: ${unsub}` : text;
        if (!deps.messenger) result = 'email is not set up';
        else {
          const msg = await sendMessage(db, deps.messenger, {
            practiceId: practice.id, patientId: p.id, channel: 'email', to: p.email, subject, body, kind: b.kind === 'newsletter' ? 'newsletter' : 'holiday_card',
            headers: b.kind === 'newsletter' ? { 'List-Unsubscribe': `<${unsub}>` } : undefined,
          });
          messageId = msg.id;
          status = msg.status === 'sent' ? 'sent' : msg.status === 'blocked' ? 'skipped' : 'failed';
          result = msg.error || null;
        }
      } else if (!deps.mailer?.enabled) result = 'mailing is not set up';
      else {
        try {
          const { letterHtml } = await import('./cadence.js');
          const sent = await deps.mailer.sendLetter({
            to: { name: `${p.first_name} ${p.last_name}`, address: p.address, city: p.city, state: p.state, zip: p.zip },
            from: { name: practice.name, address: practice.address, city: practice.city, state: practice.state, zip: practice.zip },
            html: letterHtml({ practice, recipient: p, text }), description: `Holiday card (${b.id})`, idempotencyKey: `journey-bc-${r.id}`,
          });
          status = 'sent';
          external = sent.reference;
        } catch (err) {
          result = String(err.message).slice(0, 200);
        }
      }
      await db.run("UPDATE journey_broadcast_recipients SET status = ?, result = ?, message_id = ?, external_id = ?, sent_at = datetime('now') WHERE id = ?", status, result, messageId, external, r.id);
      if (status === 'sent') stats.broadcast_sent++;
      if (status === 'failed') { stats.broadcast_failed++; failedNow++; }
    }
    const left = await db.get("SELECT COUNT(*) AS n FROM journey_broadcast_recipients WHERE broadcast_id = ? AND status = 'pending'", b.id);
    const counts = await db.get(
      "SELECT SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM journey_broadcast_recipients WHERE broadcast_id = ?", b.id,
    );
    await db.run(`UPDATE journey_broadcasts SET sent = ?, failed = ?${Number(left.n) ? '' : ", status = 'sent', finished_at = datetime('now')"} WHERE id = ?`, Number(counts.sent) || 0, Number(counts.failed) || 0, b.id);
    const key = `journey-broadcast:${b.id}`;
    if (failedNow) {
      await raiseIssue(db, { practiceId: practice.id, kind: 'message', key, role: 'front_desk', entity: 'journey_broadcasts', entityId: b.id, title: `“${b.title}” didn’t reach ${Number(counts.failed)} patient${Number(counts.failed) === 1 ? '' : 's'}`, detail: 'See the list in Settings → Patient journeys → Holiday cards & newsletter.' });
    }
    publish(practice.id, { type: 'journeys' });
  }
}

export async function unsubscribeNewsletter(db, token) {
  await ensureJourneySchema(db);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(token || ''))) throw new HttpError(404, 'This link is not valid');
  const r = await db.get('SELECT r.*, pr.name AS practice_name FROM journey_broadcast_recipients r JOIN practices pr ON pr.id = r.practice_id WHERE r.token_hash = ?', hashToken(token));
  if (!r) throw new HttpError(404, 'This link is not valid');
  return r;
}
