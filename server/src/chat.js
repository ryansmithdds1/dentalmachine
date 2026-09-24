// Team chat and tasks: the rules shared by the routes (routes/chat.js) and the background job.
// - Channels are open to everyone in the practice. Each practice gets "Everyone", "Front desk", "Clinical" and,
//   with several offices, one per office. Direct messages and small groups are visible to their members only.
// - Live events (events.js) go to the whole practice's open screens, so they carry ids only — never message
//   text or patient details. Screens fetch what they're allowed to see.
// - A message about a patient follows office access (officeaccess.js): someone limited to other offices sees
//   that a message exists, not what it says or who it's about.
import { HttpError } from './auth.js';
import { insert, audit, localNow, isRealDate } from './util.js';
import { patientScope, restricted } from './officeaccess.js';
import { publish } from './events.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { withActor } from './actor.js';

export const DEFAULT_CHANNELS = [
  { slug: 'everyone', name: 'Everyone', audience: 'everyone', topic: 'The whole office' },
  { slug: 'front-desk', name: 'Front desk', audience: 'front_desk', topic: 'Check-in, phones, scheduling and billing' },
  { slug: 'clinical', name: 'Clinical', audience: 'clinical', topic: 'Doctors, hygienists and assistants' },
];
// @groups a message can call on, by role.
export const MENTION_GROUPS = {
  'front-desk': ['front_desk', 'billing'], frontdesk: ['front_desk', 'billing'], desk: ['front_desk', 'billing'],
  clinical: ['dentist', 'hygienist', 'assistant'], hygiene: ['hygienist'], hygienists: ['hygienist'],
  doctors: ['dentist'], dentists: ['dentist'], assistants: ['assistant'], billing: ['billing'], admins: ['admin'],
};
export const EVERYONE_WORDS = new Set(['everyone', 'all', 'here', 'channel']);
const AUDIENCE_ROLES = { front_desk: ['front_desk', 'billing', 'admin'], clinical: ['dentist', 'hygienist', 'assistant', 'admin'] };

export const MAX_BODY = 4000;
export const MAX_GROUP = 9;

// Whether a default channel is meant for this person (they're added to it the first time they open chat).
export function audienceIncludes(channel, user) {
  if (!channel.audience || channel.audience === 'everyone') return true;
  if (channel.audience === 'location') return !restricted(user) || user.location_ids.includes(channel.location_id);
  return (AUDIENCE_ROLES[channel.audience] || []).includes(user.role);
}

// The practice's default channels and settings, and this person's place in them. Safe to run on every visit:
// natural unique keys (practice + slug, channel + user) mean a second run (or two at once) changes nothing.
export async function ensureChat(db, user) {
  const pid = user.practice_id;
  await db.run('INSERT INTO chat_settings (practice_id) VALUES (?) ON CONFLICT (practice_id) DO NOTHING', pid);
  const wanted = [...DEFAULT_CHANNELS];
  const offices = await db.all('SELECT id, name FROM locations WHERE practice_id = ? AND active = 1 ORDER BY sort, id', pid);
  if (offices.length > 1) for (const o of offices) wanted.push({ slug: `office-${o.id}`, name: o.name, audience: 'location', location_id: o.id, topic: `Everyone at ${o.name}` });
  for (const c of wanted) {
    await db.run(
      "INSERT INTO chat_channels (practice_id, kind, name, slug, topic, audience, location_id) VALUES (?, 'channel', ?, ?, ?, ?, ?) ON CONFLICT (practice_id, slug) DO NOTHING",
      pid, c.name, c.slug, c.topic, c.audience, c.location_id ?? null,
    );
  }
  // First visit to a default channel: join it, already caught up (the history isn't a pile of "unread").
  const defaults = await db.all(
    `SELECT c.* FROM chat_channels c WHERE c.practice_id = ? AND c.kind = 'channel' AND c.audience IS NOT NULL AND c.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.user_id = ?)`, pid, user.id,
  );
  for (const c of defaults) if (audienceIncludes(c, user)) await join(db, c, user.id, { caughtUp: true });
}

// Adds someone to a conversation (or back into one they left).
export async function join(db, channel, userId, { caughtUp = false, readThrough = null } = {}) {
  const last = readThrough ?? (caughtUp ? Number((await db.get('SELECT MAX(id) AS n FROM chat_messages WHERE channel_id = ?', channel.id))?.n || 0) : 0);
  await db.run(
    'INSERT INTO chat_members (practice_id, channel_id, user_id, last_read_id) VALUES (?, ?, ?, ?) ON CONFLICT (channel_id, user_id) DO NOTHING',
    channel.practice_id, channel.id, userId, last,
  );
  await db.run('UPDATE chat_members SET left_at = NULL WHERE channel_id = ? AND user_id = ? AND left_at IS NOT NULL', channel.id, userId);
}

export const membersOf = async (db, channelId) => (await db.all('SELECT user_id FROM chat_members WHERE channel_id = ? AND left_at IS NULL', channelId)).map((r) => r.user_id);

// A conversation this person may read: any channel in their practice, or a DM/group they're in. Anything
// else answers 404, as if it didn't exist.
export async function readableChannel(db, user, id) {
  const c = await db.get('SELECT * FROM chat_channels WHERE id = ? AND practice_id = ?', Number(id), user.practice_id);
  if (!c) throw new HttpError(404, 'Conversation not found');
  if (c.kind !== 'channel') {
    const m = await db.get('SELECT id FROM chat_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL', c.id, user.id);
    if (!m) throw new HttpError(404, 'Conversation not found');
  }
  return c;
}

// The message (in a conversation this person can read), or 404.
export async function readableMessage(db, user, id) {
  const m = await db.get('SELECT * FROM chat_messages WHERE id = ? AND practice_id = ?', Number(id), user.practice_id);
  if (!m) throw new HttpError(404, 'Message not found');
  const channel = await readableChannel(db, user, m.channel_id).catch(() => null);
  if (!channel) throw new HttpError(404, 'Message not found');
  if (m.patient_id && !(await visiblePatients(db, user, [m.patient_id])).has(m.patient_id)) throw new HttpError(404, 'Message not found');
  return { message: m, channel };
}

// Which of these patients this person may see (office access).
export async function visiblePatients(db, user, ids) {
  const list = [...new Set(ids.filter(Boolean).map(Number))];
  if (!list.length) return new Set();
  const s = patientScope(user);
  const rows = await db.all(`SELECT p.id FROM patients p WHERE p.practice_id = ? AND p.id IN (${list.map(() => '?').join(',')})${s.sql}`, user.practice_id, ...list, ...s.args);
  return new Set(rows.map((r) => r.id));
}

// ---- Mentions ----
const firstName = (n) => String(n).replace(/^(dr|mr|mrs|ms)\.?\s+/i, '').split(/[\s,]+/)[0].toLowerCase();
const wholeName = (n) => String(n).toLowerCase().replace(/[^\p{L}]/gu, '');
const MENTION = /(^|[\s(])@([\p{L}][\p{L}'.-]*)/gu;

// Who a message calls on: @name (one clear match by first name, or whole name run together), @front-desk and
// the other role groups, @everyone (the conversation's members), plus people picked from the autocomplete
// (explicitIds). In a DM or group only its members can be called on. Returns [{ user_id, via }] without the author.
export async function resolveMentions(db, { channel, body, explicitIds = [], authorId, practiceId }) {
  const team = await db.all('SELECT id, name, role FROM users WHERE practice_id = ? AND active = 1', practiceId);
  const members = new Set(await membersOf(db, channel.id));
  const out = new Map();
  const add = (id, via) => { if (id !== authorId && !out.has(id)) out.set(id, via); };
  for (const id of explicitIds) {
    const u = team.find((t) => t.id === Number(id));
    if (u) add(u.id, 'name');
  }
  for (const m of String(body || '').matchAll(MENTION)) {
    const word = m[2].replace(/[.'-]+$/, '').toLowerCase();
    if (EVERYONE_WORDS.has(word)) {
      for (const id of members) add(id, 'everyone');
      continue;
    }
    if (MENTION_GROUPS[word]) {
      for (const u of team) if (MENTION_GROUPS[word].includes(u.role)) add(u.id, `@${word}`);
      continue;
    }
    let hits = team.filter((u) => firstName(u.name) === word);
    if (!hits.length) hits = team.filter((u) => wholeName(u.name).startsWith(word.replace(/[^\p{L}]/gu, '')));
    if (hits.length === 1) add(hits[0].id, 'name');
  }
  const list = [...out].map(([user_id, via]) => ({ user_id, via }));
  return channel.kind === 'channel' ? list : list.filter((x) => members.has(x.user_id));
}

// ---- Live events (ids only) ----
export async function announce(db, channel, event) {
  const to = channel.kind === 'channel' ? null : await membersOf(db, channel.id);
  publish(channel.practice_id, { type: 'chat', channel_id: channel.id, to, ...event });
}

// ---- Unread ----
// Per conversation: unread top-level messages from others, unseen @mentions, and the newest message id.
export async function unreadFor(db, user) {
  const rows = await db.all(
    `SELECT m.channel_id, m.last_read_id, m.muted, c.kind,
       (SELECT COUNT(*) FROM chat_messages x WHERE x.channel_id = m.channel_id AND x.id > m.last_read_id AND x.parent_id IS NULL
          AND x.status = 'active' AND (x.user_id IS NULL OR x.user_id <> m.user_id)) AS unread,
       (SELECT MAX(x.id) FROM chat_messages x WHERE x.channel_id = m.channel_id) AS last_id
     FROM chat_members m JOIN chat_channels c ON c.id = m.channel_id
     WHERE m.user_id = ? AND m.practice_id = ? AND m.left_at IS NULL AND c.archived_at IS NULL`, user.id, user.practice_id,
  );
  const mentions = await db.all(
    `SELECT n.channel_id, COUNT(*) AS n FROM chat_mentions n JOIN chat_messages x ON x.id = n.message_id
     WHERE n.user_id = ? AND n.practice_id = ? AND n.seen_at IS NULL AND x.status = 'active' GROUP BY n.channel_id`, user.id, user.practice_id,
  );
  const byChannel = new Map(rows.map((r) => [r.channel_id, { channel_id: r.channel_id, kind: r.kind, muted: !!r.muted, unread: Number(r.unread || 0), mentions: 0, last_id: Number(r.last_id || 0), last_read_id: Number(r.last_read_id || 0) }]));
  for (const m of mentions) {
    const c = byChannel.get(m.channel_id) || { channel_id: m.channel_id, kind: 'channel', muted: false, unread: 0, mentions: 0, last_id: 0, last_read_id: 0 };
    c.mentions = Number(m.n);
    byChannel.set(m.channel_id, c);
  }
  const list = [...byChannel.values()];
  const urgent = (await pendingUrgent(db, user)).length;
  // The rail badge: direct messages, mentions and urgent messages (channel chatter only shows per channel).
  const important = list.reduce((s, c) => s + (c.kind !== 'channel' && !c.muted ? c.unread : 0) + c.mentions, 0) + urgent;
  const total = list.reduce((s, c) => s + (c.muted ? 0 : c.unread), 0);
  return { channels: list, important, total, urgent };
}

// Urgent messages this person hasn't said "Got it" to: from the last week, in conversations they're in (or
// that called on them), not their own.
export async function pendingUrgent(db, user) {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  const rows = await db.all(
    `SELECT x.id, x.channel_id, x.patient_id, x.body, x.created_at, x.user_id, u.name AS author_name, c.name AS channel_name, c.kind
     FROM chat_messages x JOIN chat_channels c ON c.id = x.channel_id LEFT JOIN users u ON u.id = x.user_id
     WHERE x.practice_id = ? AND x.urgent = 1 AND x.status = 'active' AND x.created_at >= ? AND (x.user_id IS NULL OR x.user_id <> ?)
       AND (EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = x.channel_id AND m.user_id = ? AND m.left_at IS NULL)
            OR EXISTS (SELECT 1 FROM chat_mentions n WHERE n.message_id = x.id AND n.user_id = ?))
       AND NOT EXISTS (SELECT 1 FROM chat_acks a WHERE a.message_id = x.id AND a.user_id = ?)
     ORDER BY x.id`, user.practice_id, since, user.id, user.id, user.id, user.id,
  );
  const seen = await visiblePatients(db, user, rows.map((r) => r.patient_id));
  return rows.map((r) => (r.patient_id && !seen.has(r.patient_id) ? { ...r, body: null, patient_id: null, hidden: true } : r));
}

// ---- Recurring tasks ----
const DAY = 86400_000;
const d2s = (d) => d.toISOString().slice(0, 10);
const s2d = (s) => new Date(`${s}T12:00:00Z`);
const addDays = (s, n) => d2s(new Date(s2d(s).getTime() + n * DAY));
export const RULES = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];

function monthDay(year, month, day) {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return d2s(new Date(Date.UTC(year, month, Math.min(day, last), 12)));
}
// The first date on or after `from` that the rule falls on.
export function firstOnOrAfter(series, from) {
  const d = s2d(from);
  if (series.rule === 'daily') return from;
  if (series.rule === 'weekdays') {
    const w = d.getUTCDay();
    return w === 6 ? addDays(from, 2) : w === 0 ? addDays(from, 1) : from;
  }
  if (series.rule === 'weekly' || series.rule === 'biweekly') return addDays(from, (Number(series.weekday) - d.getUTCDay() + 7) % 7);
  const here = monthDay(d.getUTCFullYear(), d.getUTCMonth(), Number(series.month_day));
  return here >= from ? here : monthDay(d.getUTCFullYear(), d.getUTCMonth() + 1, Number(series.month_day));
}
// The rule's next date after `date` (which is one of its dates).
export function nextAfter(series, date) {
  if (series.rule === 'daily') return addDays(date, 1);
  if (series.rule === 'weekdays') return firstOnOrAfter(series, addDays(date, 1));
  if (series.rule === 'weekly') return addDays(date, 7);
  if (series.rule === 'biweekly') return addDays(date, 14);
  const d = s2d(date);
  return monthDay(d.getUTCFullYear(), d.getUTCMonth() + 1, Number(series.month_day));
}

export function cleanRepeat(repeat, startDate) {
  if (!repeat) return null;
  const rule = String(repeat.rule || '');
  if (!RULES.includes(rule)) throw new HttpError(400, `repeat.rule must be one of: ${RULES.join(', ')}`);
  const out = { rule, weekday: null, month_day: null };
  if (rule === 'weekly' || rule === 'biweekly') {
    out.weekday = repeat.weekday ?? s2d(startDate).getUTCDay();
    if (!Number.isInteger(Number(out.weekday)) || out.weekday < 0 || out.weekday > 6) throw new HttpError(400, 'repeat.weekday must be 0 (Sunday) to 6 (Saturday)');
    out.weekday = Number(out.weekday);
  }
  if (rule === 'monthly') {
    out.month_day = repeat.month_day ?? s2d(startDate).getUTCDate();
    if (!Number.isInteger(Number(out.month_day)) || out.month_day < 1 || out.month_day > 31) throw new HttpError(400, 'repeat.month_day must be 1 to 31');
    out.month_day = Number(out.month_day);
  }
  return out;
}

const practiceToday = async (db, practiceId) => localNow((await db.get('SELECT timezone FROM practices WHERE id = ?', practiceId))?.timezone || 'America/New_York').slice(0, 10);

// Keeps each active series' current task in place: when the last one's date has passed or it's been ticked
// off, the next one is made (missed dates are skipped, so a week away doesn't come back as five tasks). One
// task per series and date, enforced by task_occurrences' unique key. Returns the tasks made.
export async function runRecurringTasks(db, { practiceId = null, seriesId = null, today = null } = {}) {
  const where = ['s.active = 1'];
  const args = [];
  if (practiceId) { where.push('s.practice_id = ?'); args.push(practiceId); }
  if (seriesId) { where.push('s.id = ?'); args.push(seriesId); }
  const list = await db.all(`SELECT s.* FROM task_series s WHERE ${where.join(' AND ')} ORDER BY s.id`, ...args);
  const made = [];
  const todays = new Map();
  for (const s of list) {
    if (!todays.has(s.practice_id)) todays.set(s.practice_id, today || await practiceToday(db, s.practice_id));
    const day = todays.get(s.practice_id);
    const last = await db.get(
      'SELECT o.due_date, t.status FROM task_occurrences o LEFT JOIN tasks t ON t.id = o.task_id WHERE o.series_id = ? ORDER BY o.due_date DESC LIMIT 1', s.id,
    );
    if (last && last.due_date >= day && last.status !== 'done') continue;
    let due = s.next_due;
    let guard = 0;
    while (due < day && guard++ < 1000) due = nextAfter(s, due);
    const id = await withActor({ source: 'automation', actor: 'Recurring tasks', userId: null, practiceId: s.practice_id }, () => db.tx(async () => {
      const occ = await db.run('INSERT INTO task_occurrences (practice_id, series_id, due_date) VALUES (?, ?, ?) ON CONFLICT (series_id, due_date) DO NOTHING', s.practice_id, s.id, due);
      if (!occ.changes) return null;
      const taskId = await insert(db, 'tasks', {
        practice_id: s.practice_id, title: s.title, notes: s.notes, assigned_to: s.assigned_to, patient_id: s.patient_id,
        priority: s.priority, due_date: due, created_by: s.created_by,
      });
      await db.run('UPDATE task_occurrences SET task_id = ? WHERE series_id = ? AND due_date = ?', taskId, s.id, due);
      let items = [];
      try { items = JSON.parse(s.checklist || '[]'); } catch { items = []; }
      for (const [i, text] of items.entries()) await db.run('INSERT INTO task_checklist_items (practice_id, task_id, text, position) VALUES (?, ?, ?, ?)', s.practice_id, taskId, String(text).slice(0, 200), i);
      await db.run('UPDATE task_series SET next_due = ? WHERE id = ?', nextAfter(s, due), s.id);
      await audit(db, null, 'task.create', 'tasks', taskId, { series_id: s.id, due_date: due, assigned_to: s.assigned_to, patient_id: s.patient_id ?? null }, { source: 'automation', actor: 'Recurring tasks' });
      return taskId;
    }));
    if (id) {
      made.push(id);
      publish(s.practice_id, { type: 'tasks', event: 'created', task_id: id, assigned_to: s.assigned_to ?? null, by: null });
    }
  }
  return made;
}

export function validDate(v, name) {
  if (v == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || !isRealDate(String(v))) throw new HttpError(400, `${name} must be a real date (YYYY-MM-DD)`);
  return String(v);
}

// ---- Quiet hours and the unread digest ----
// chat.quiet pref: { enabled, from: 'HH:MM', until: 'HH:MM' } in the practice's time; overnight spans wrap.
export function inQuietHours(quiet, hhmm) {
  if (!quiet?.enabled || !/^\d{2}:\d{2}$/.test(quiet.from || '') || !/^\d{2}:\d{2}$/.test(quiet.until || '')) return false;
  return quiet.from <= quiet.until ? hhmm >= quiet.from && hhmm < quiet.until : hhmm >= quiet.from || hhmm < quiet.until;
}
const prefOf = (rows, key, dflt) => {
  const r = rows.find((x) => x.key === key);
  if (!r) return dflt;
  try { return JSON.parse(r.value); } catch { return dflt; }
};

// Email for anything addressed to a person (direct and group messages, @mentions, urgent) that has stayed
// unread longer than the practice's digest delay. The email says how many and from where — never the message
// text or a patient's name. Each message is only ever in one digest (chat_members.emailed_through_id).
export async function runChatDigests(db, messenger, { now = new Date(), appUrl = '' } = {}) {
  if (!messenger?.send) return 0;
  // Practices where someone has chatted, with their delay (the default until an administrator changes it).
  const practices = (await db.all(
    `SELECT p.id AS practice_id, COALESCE(s.digest_minutes, 240) AS digest_minutes, p.timezone, p.name FROM practices p LEFT JOIN chat_settings s ON s.practice_id = p.id
     WHERE EXISTS (SELECT 1 FROM chat_channels c WHERE c.practice_id = p.id)`,
  )).filter((p) => Number(p.digest_minutes) > 0);
  let sent = 0;
  for (const p of practices) {
    const cutoff = new Date(now.getTime() - p.digest_minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    const hhmm = localNow(p.timezone || 'America/New_York', now).slice(11, 16);
    const users = await db.all('SELECT id, name, email FROM users WHERE practice_id = ? AND active = 1', p.practice_id);
    for (const u of users) {
      const prefs = await db.all("SELECT key, value FROM user_prefs WHERE user_id = ? AND key IN ('chat.digest', 'chat.quiet')", u.id);
      if (prefOf(prefs, 'chat.digest', true) === false || inQuietHours(prefOf(prefs, 'chat.quiet', null), hhmm)) continue;
      const rows = await db.all(
        `SELECT x.id, x.channel_id, c.kind, c.name AS channel_name, a.name AS author_name,
           CASE WHEN n.id IS NOT NULL THEN 1 ELSE 0 END AS mentioned, x.urgent
         FROM chat_members m JOIN chat_channels c ON c.id = m.channel_id
         JOIN chat_messages x ON x.channel_id = m.channel_id AND x.id > m.last_read_id AND x.id > m.emailed_through_id
         LEFT JOIN users a ON a.id = x.user_id
         LEFT JOIN chat_mentions n ON n.message_id = x.id AND n.user_id = m.user_id AND n.seen_at IS NULL
         WHERE m.user_id = ? AND m.left_at IS NULL AND m.muted = 0 AND c.archived_at IS NULL AND x.status = 'active'
           AND (x.user_id IS NULL OR x.user_id <> m.user_id) AND x.created_at <= ?
           AND (c.kind <> 'channel' OR n.id IS NOT NULL OR (x.urgent = 1 AND NOT EXISTS (SELECT 1 FROM chat_acks k WHERE k.message_id = x.id AND k.user_id = m.user_id)))
         ORDER BY x.id`, u.id, cutoff,
      );
      if (!rows.length || !u.email) continue;
      const lines = new Map();
      for (const r of rows) {
        const where = r.kind === 'dm' ? `${r.author_name || 'Someone'} (direct message)` : r.kind === 'group' ? `${r.channel_name || 'a group conversation'}` : `#${r.channel_name}`;
        const l = lines.get(where) || { n: 0, urgent: 0, mentions: 0 };
        l.n++;
        l.urgent += r.urgent ? 1 : 0;
        l.mentions += r.mentioned ? 1 : 0;
        lines.set(where, l);
      }
      const body = [
        `Hi ${u.name.split(' ')[0]},`, '',
        `You have ${rows.length} unread team message${rows.length === 1 ? '' : 's'} in Dental Machine:`,
        ...[...lines].map(([where, l]) => `• ${where}: ${l.n}${l.urgent ? ` (${l.urgent} urgent)` : ''}${l.mentions ? ` — you were mentioned${l.mentions > 1 ? ` ${l.mentions} times` : ''}` : ''}`),
        '', `Open the team chat (Ctrl/⌘ J) to read them${appUrl ? `: ${appUrl}` : ''}.`,
        '', 'For privacy this email never includes the messages themselves. Change digest emails and quiet hours under your chat settings.',
      ].join('\n');
      try {
        await messenger.send({ channel: 'email', to: u.email, subject: `${rows.length} unread team message${rows.length === 1 ? '' : 's'} — ${p.name}`, body });
        sent++;
        const through = new Map();
        for (const r of rows) through.set(r.channel_id, Math.max(through.get(r.channel_id) || 0, r.id));
        for (const [channelId, id] of through) await db.run('UPDATE chat_members SET emailed_through_id = ? WHERE channel_id = ? AND user_id = ? AND emailed_through_id < ?', id, channelId, u.id, id);
        await resolveIssue(db, p.practice_id, `chat-digest:${u.id}`);
      } catch (err) {
        await raiseIssue(db, { practiceId: p.practice_id, kind: 'message', key: `chat-digest:${u.id}`, role: 'admin', title: `Team chat digest email to ${u.name} didn't go`, detail: err.message });
      }
    }
  }
  return sent;
}

// The background job: recurring tasks for every practice, then digests. Mounted from index.js.
export async function runChatJobs(db, messenger, { appUrl = '' } = {}) {
  const made = await runRecurringTasks(db);
  const emailed = await runChatDigests(db, messenger, { appUrl });
  return { tasks: made.length, digests: emailed };
}
