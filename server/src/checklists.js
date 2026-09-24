// Recurring checklists by position (RCL1–RCL3, docs/workflows/specs/RCL-checklists.md): the schedule math, making
// each day's occurrences, who does them, and the flags that go up when something critical fails or isn't done.
// Routes are in routes/checklists.js; the background job (runChecklistJobs) is started from index.js.
//
// Why not the chat's recurring tasks (task_series → tasks)? A task is a to-do that disappears when ticked and a
// series skips dates nobody did. A compliance checklist needs the opposite: every due date kept, missed ones
// recorded as missed, a result and evidence on each, and a history an inspector can read. So occurrences are
// their own rows (one per item, date and office — the natural key that makes generation idempotent).
import { HttpError, can, effectivePermissions, USER_PERMISSION_SQL } from './auth.js';
import { audit, localNow } from './util.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { publish } from './events.js';
import { withActor } from './actor.js';
import { log } from './monitoring.js';
import { join, announce } from './chat.js';

// Until 'checklists:manage' is in PERMISSION_CATALOG (auth.js), only administrators have it (effectivePermissions
// drops names the catalog doesn't know).
export const MANAGE = 'checklists:manage';
export const canManage = (user) => can(user, MANAGE);

export const CADENCES = ['daily', 'weekly', 'monthly', 'quarterly', 'annually'];
export const RESULT_TYPES = ['none', 'number', 'pass_fail', 'text'];
export const ASSIGN_RULES = ['position', 'person', 'on_shift'];
// How many days ahead an occurrence shows up as "coming up" (an annual training shows a month before).
export const LEAD_DAYS = { daily: 0, weekly: 0, monthly: 3, quarterly: 7, annually: 30 };
// How far back the job fills in dates it didn't run on (a server down over a weekend still records the misses).
const LOOKBACK_DAYS = 35;
const BUILT_IN_ROLES = ['admin', 'dentist', 'hygienist', 'assistant', 'front_desk', 'billing'];
export { BUILT_IN_ROLES };

// ---- Dates ----
const DAY = 86400_000;
export const addDays = (s, n) => new Date(Date.parse(`${s}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const weekdayOf = (s) => new Date(`${s}T12:00:00Z`).getUTCDay();
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1–12
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHm = (s) => HM.test(String(s ?? ''));

// The weekdays an office is open, from its weekly hours ({ "1": [["08:00","17:00"]], ... }); Monday–Friday
// when none are set.
export function openDaysOf(hoursJson) {
  let hours = null;
  try { hours = hoursJson ? JSON.parse(hoursJson) : null; } catch { hours = null; }
  const days = new Set();
  if (hours && typeof hours === 'object') for (const [k, v] of Object.entries(hours)) if (Array.isArray(v) && v.length) days.add(Number(k));
  return days.size ? days : new Set([1, 2, 3, 4, 5]);
}
export function parseWeekdays(v) {
  if (v == null || v === '') return null;
  const days = String(v).split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return days.length ? new Set(days) : null;
}
// The day in month m of year y that "month_day" means: 1–31 clamped to the month's end (31 → Feb 28/29);
// -1 = the last day the office is open (the last business day).
export function monthTarget(y, m, monthDay, openDays) {
  const last = lastDayOf(y, m);
  if (Number(monthDay) === -1) {
    for (let d = last; d >= Math.max(1, last - 10); d--) if (openDays.has(weekdayOf(ymd(y, m, d)))) return ymd(y, m, d);
    return ymd(y, m, last);
  }
  return ymd(y, m, Math.min(Math.max(1, Number(monthDay) || 1), last));
}
// Whether an item is due on a date (openDays: the office's open weekdays).
export function occursOn(item, date, openDays) {
  const [y, m] = date.split('-').map(Number);
  const md = item.month_day ?? 1;
  switch (item.cadence) {
    case 'daily': return (parseWeekdays(item.weekdays) || openDays).has(weekdayOf(date));
    case 'weekly': return weekdayOf(date) === Number(item.weekday ?? 1);
    case 'monthly': return date === monthTarget(y, m, md, openDays);
    case 'quarterly': return (((m - Number(item.month || 1)) % 3) + 3) % 3 === 0 && date === monthTarget(y, m, md, openDays);
    case 'annually': return m === Number(item.month || 1) && date === monthTarget(y, m, md, openDays);
    default: return false;
  }
}
export function datesBetween(item, from, to, openDays) {
  const out = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) if (occursOn(item, d, openDays)) out.push(d);
  return out;
}
// The next date after `date` the item is due (null if none within ~13 months).
export function nextOccurrence(item, date, openDays) {
  for (let i = 1, d = addDays(date, 1); i <= 400; i++, d = addDays(d, 1)) if (occursOn(item, d, openDays)) return d;
  return null;
}
// The last day an occurrence can be done before it counts as missed: the day before the next one is due.
export function closesOn(item, date, openDays) {
  const next = nextOccurrence(item, date, openDays);
  return next ? addDays(next, -1) : addDays(date, 365);
}

export async function practiceClock(db, practiceId, now = new Date()) {
  const p = await db.get('SELECT timezone, office_hours FROM practices WHERE id = ?', practiceId);
  const nowLocal = localNow(p?.timezone || 'America/New_York', now);
  return { nowLocal, today: nowLocal.slice(0, 10), hours: p?.office_hours ?? null, tz: p?.timezone || 'America/New_York' };
}

// ---- Positions and people ----
// Everyone in a position: its built-in role, its custom role, or added by name. Active staff only; someone limited
// to other offices isn't counted for an office they can't work in.
export async function positionMembers(db, practiceId, positionId, locationId = null) {
  const rows = await db.all(
    `SELECT u.id, u.name, u.role, u.location_ids FROM users u
     WHERE u.practice_id = ? AND u.active = 1 AND (
       EXISTS (SELECT 1 FROM checklist_position_members m WHERE m.position_id = ? AND m.user_id = u.id AND m.removed_at IS NULL)
       OR u.role = (SELECT p.role FROM checklist_positions p WHERE p.id = ?)
       OR u.custom_role_id = (SELECT p.custom_role_id FROM checklist_positions p WHERE p.id = ?))
     ORDER BY u.name, u.id`, practiceId, positionId, positionId, positionId,
  );
  return rows.filter((u) => {
    if (!locationId || !u.location_ids) return true;
    try {
      const ids = JSON.parse(u.location_ids);
      return !Array.isArray(ids) || !ids.length || ids.includes(locationId);
    } catch { return true; }
  });
}
// The positions a person holds.
export async function positionsOf(db, user) {
  const rows = await db.all(
    `SELECT p.id, p.name FROM checklist_positions p WHERE p.practice_id = ? AND p.status = 'active' AND (
       p.role = ? OR (p.custom_role_id IS NOT NULL AND p.custom_role_id = ?)
       OR EXISTS (SELECT 1 FROM checklist_position_members m WHERE m.position_id = p.id AND m.user_id = ? AND m.removed_at IS NULL))
     ORDER BY p.sort, p.name`, user.practice_id, user.role, user.custom_role_id ?? 0, user.id,
  );
  return rows;
}

// Who does an "on shift" item: the position's person clocked in right now (today only), else the one scheduled
// to work that day at that office. null when nobody is — then anyone in the position sees it.
export async function whoIsOnShift(db, practiceId, positionId, locationId, date, today) {
  const people = await positionMembers(db, practiceId, positionId, locationId);
  if (!people.length) return null;
  const ids = people.map((u) => u.id);
  const marks = ids.map(() => '?').join(',');
  if (date === today) {
    const clocked = await db.all(
      `SELECT o.user_id, t.location_id, t.clock_in FROM time_open_punches o JOIN time_punches t ON t.id = o.punch_id
       WHERE o.practice_id = ? AND o.user_id IN (${marks}) ORDER BY t.clock_in, o.user_id`, practiceId, ...ids,
    );
    const hit = clocked.find((c) => !locationId || !c.location_id || c.location_id === locationId);
    if (hit) return { userId: hit.user_id, via: 'clocked_in' };
  }
  const shifts = await db.all(
    `SELECT user_id, location_id FROM staff_shifts WHERE practice_id = ? AND date = ? AND status = 'scheduled' AND user_id IN (${marks})
     ORDER BY start_time, user_id`, practiceId, date, ...ids,
  );
  const shift = shifts.find((s) => !locationId || !s.location_id || s.location_id === locationId);
  return shift ? { userId: shift.user_id, via: 'scheduled' } : null;
}

// ---- Making occurrences ----
async function assignmentFor(db, item, template, locationId, date, today) {
  if (item.assign_rule === 'person' && item.assignee_id) return { userId: item.assignee_id, via: 'person' };
  if (item.assign_rule === 'on_shift') return (await whoIsOnShift(db, item.practice_id, template.position_id, locationId, date, today)) || { userId: null, via: null };
  return { userId: null, via: null };
}

// Makes the occurrences due from the last run (or LOOKBACK_DAYS ago) through today plus each item's lead time.
// Safe to run any number of times at once: (item, date, office) is unique, and a date that already has a row is
// left alone (a cancelled one — dropped by a schedule change — comes back if the schedule has it again).
// Returns how many were made.
export async function generate(db, practiceId, { now = new Date(), itemId = null } = {}) {
  const { today, hours } = await practiceClock(db, practiceId, now);
  const offices = await db.all('SELECT id, office_hours FROM locations WHERE practice_id = ? AND active = 1 ORDER BY sort, id', practiceId);
  const items = await db.all(
    `SELECT i.*, t.position_id, t.location_id AS template_location_id FROM checklist_items i
     JOIN checklist_templates t ON t.id = i.template_id JOIN checklist_positions p ON p.id = t.position_id
     WHERE i.practice_id = ? AND i.status = 'active' AND t.status = 'active' AND p.status = 'active'${itemId ? ' AND i.id = ?' : ''}`,
    practiceId, ...(itemId ? [itemId] : []),
  );
  let made = 0;
  for (const item of items) {
    const until = addDays(today, LEAD_DAYS[item.cadence] ?? 0);
    let from = item.generated_through ? addDays(item.generated_through, 1) : item.start_date;
    const floor = addDays(today, -LOOKBACK_DAYS);
    if (from < floor) from = floor;
    if (from < item.start_date) from = item.start_date;
    if (from > until) continue;
    const where = item.template_location_id ? offices.filter((o) => o.id === item.template_location_id) : offices.length ? offices : [null];
    for (const office of where) {
      const openDays = openDaysOf(office?.office_hours || hours);
      for (const date of datesBetween(item, from, until, openDays)) {
        const who = await assignmentFor(db, item, { position_id: item.position_id }, office?.id ?? null, date, today);
        const row = {
          due_at: `${date} ${item.due_time}`, closes_on: closesOn(item, date, openDays), critical: item.critical ? 1 : 0,
          assigned_to: who.userId, assigned_via: who.via,
        };
        const r = await db.run(
          `INSERT INTO checklist_occurrences (practice_id, item_id, template_id, position_id, location_id, location_key, due_date, due_at, closes_on, critical, assigned_to, assigned_via)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (item_id, due_date, location_key) DO NOTHING`,
          practiceId, item.id, item.template_id, item.position_id, office?.id ?? null, office?.id ?? 0, date, row.due_at, row.closes_on, row.critical, row.assigned_to, row.assigned_via,
        );
        if (r.changes) made++;
        else {
          const back = await db.run(
            "UPDATE checklist_occurrences SET status = 'open', due_at = ?, closes_on = ?, critical = ?, assigned_to = ?, assigned_via = ?, position_id = ? WHERE item_id = ? AND due_date = ? AND location_key = ? AND status = 'cancelled'",
            row.due_at, row.closes_on, row.critical, row.assigned_to, row.assigned_via, item.position_id, item.id, date, office?.id ?? 0,
          );
          made += back.changes;
        }
      }
    }
    await db.run('UPDATE checklist_items SET generated_through = ? WHERE id = ? AND (generated_through IS NULL OR generated_through < ?)', until, item.id, until);
  }
  return made;
}

// An item's schedule, time or rules changed: occurrences still open from today on follow the new version.
// Future ones are cancelled and made again from the new schedule; today's keep their place with the new
// due time, critical flag and assignment. Done and missed ones are history and stay as they were.
export async function rescheduleItem(db, item, { now = new Date() } = {}) {
  const { today } = await practiceClock(db, item.practice_id, now);
  await db.run("UPDATE checklist_occurrences SET status = 'cancelled' WHERE item_id = ? AND status = 'open' AND due_date > ?", item.id, today);
  const todays = await db.all("SELECT * FROM checklist_occurrences WHERE item_id = ? AND status = 'open' AND due_date = ?", item.id, today);
  const template = await db.get('SELECT position_id FROM checklist_templates WHERE id = ?', item.template_id);
  for (const o of todays) {
    const who = await assignmentFor(db, item, template, o.location_id, o.due_date, today);
    await db.run('UPDATE checklist_occurrences SET due_at = ?, critical = ?, assigned_to = ?, assigned_via = ?, position_id = ? WHERE id = ?',
      `${o.due_date} ${item.due_time}`, item.critical ? 1 : 0, who.userId, who.via, template.position_id, o.id);
  }
  await db.run('UPDATE checklist_items SET generated_through = ? WHERE id = ?', today, item.id);
  if (item.status === 'active') await generate(db, item.practice_id, { now, itemId: item.id });
}
// An item or checklist taken away: its open occurrences from today on are cancelled (past ones stay).
export async function cancelOpen(db, practiceId, { itemId = null, templateId = null, now = new Date() }) {
  const { today } = await practiceClock(db, practiceId, now);
  const col = itemId ? 'item_id' : 'template_id';
  await db.run(`UPDATE checklist_occurrences SET status = 'cancelled' WHERE practice_id = ? AND ${col} = ? AND status = 'open' AND due_date >= ?`, practiceId, itemId || templateId, today);
}

// ---- Events (the occurrence's own history) ----
export async function logEvent(db, occ, kind, { details = null, reason = null, userId = null, source = 'human' } = {}) {
  await db.run('INSERT INTO checklist_events (practice_id, occurrence_id, kind, details, reason, user_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
    occ.practice_id, occ.id, kind, details ? JSON.stringify(details) : null, reason ? String(reason).slice(0, 1000) : null, userId, source);
}

// ---- Results and evidence ----
const num = (v) => (v == null || v === '' ? null : Number(v));
export function outOfRange(item, value) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n)) return false;
  const min = num(item.min_value);
  const max = num(item.max_value);
  return (min != null && n < min) || (max != null && n > max);
}
// Cleans the result fields a request sends for this item. Only the fields sent are returned.
export function cleanResult(item, body = {}) {
  const out = {};
  if (body.result_number !== undefined) {
    if (body.result_number === null || body.result_number === '') out.result_number = null;
    else {
      const n = Number(String(body.result_number).trim());
      if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw new HttpError(400, 'Enter a number');
      out.result_number = String(n);
    }
  }
  if (body.result_pass !== undefined) {
    const v = body.result_pass;
    out.result_pass = v === null ? null : v === true || v === 1 || v === 'pass' || v === '1' ? 1 : v === false || v === 0 || v === 'fail' || v === '0' ? 0 : undefined;
    if (out.result_pass === undefined) throw new HttpError(400, 'result_pass must be pass or fail');
  }
  if (body.result_text !== undefined) out.result_text = body.result_text == null ? null : String(body.result_text).trim().slice(0, 2000) || null;
  if (body.note !== undefined) out.note = body.note == null ? null : String(body.note).trim().slice(0, 2000) || null;
  return out;
}
export function outcomeOf(item, values) {
  if (item.result_type === 'pass_fail' && values.result_pass === 0) return 'fail';
  if (item.result_type === 'number' && outOfRange(item, values.result_number)) return 'out_of_range';
  return 'ok';
}
// What's still needed before an item can be ticked. A failure is never held up for its photo: a failed spore
// test must be on record (and flagged) the moment it's known.
export function missingFor(item, values, evidence) {
  const missing = [];
  const live = evidence.filter((e) => !e.removed_at);
  if (item.result_type === 'number' && (values.result_number == null || values.result_number === '')) missing.push('number');
  if (item.result_type === 'pass_fail' && values.result_pass == null) missing.push('pass_fail');
  if (item.result_type === 'text' && !values.result_text) missing.push('text');
  if (item.require_note && !values.note) missing.push('note');
  const failing = outcomeOf(item, values) !== 'ok';
  if (item.require_photo && !failing && !live.some((e) => e.kind === 'photo')) missing.push('photo');
  if (item.require_file && !failing && !live.some((e) => e.kind === 'file' || e.kind === 'photo')) missing.push('file');
  return missing;
}
export const MISSING_WORDS = { number: 'the reading', pass_fail: 'pass or fail', text: 'the answer', note: 'a note', photo: 'a photo', file: 'the file (certificate or report)' };

// ---- Flags and alerts ----
async function settingsOf(db, practiceId) {
  await db.run('INSERT INTO checklist_settings (practice_id) VALUES (?) ON CONFLICT (practice_id) DO NOTHING', practiceId);
  return db.get('SELECT * FROM checklist_settings WHERE practice_id = ?', practiceId);
}
export { settingsOf };
const parseList = (v) => { try { const x = JSON.parse(v || 'null'); return Array.isArray(x) ? x : null; } catch { return null; } };

// Who hears about flags: the people chosen in settings, else everyone with checklists:manage (administrators
// included).
export async function alertRecipients(db, practiceId) {
  const s = await settingsOf(db, practiceId);
  const chosen = parseList(s.alert_user_ids);
  const users = await db.all(`${USER_PERMISSION_SQL} WHERE u.practice_id = ? AND u.active = 1`, practiceId);
  if (chosen?.length) return users.filter((u) => chosen.includes(u.id)).map((u) => u.id);
  return users.filter((u) => u.role === 'admin' || effectivePermissions(u).includes(MANAGE)).map((u) => u.id);
}

const officeName = async (db, locationId) => (locationId ? (await db.get('SELECT name FROM locations WHERE id = ?', locationId))?.name : null);

export function flagTitle(kind, item, occ, office) {
  const where = office ? ` — ${office}` : '';
  const what = kind === 'fail' ? 'failed'
    : kind === 'out_of_range' ? `out of range (${occ.result_number}${item.unit ? ` ${item.unit}` : ''}; allowed ${[item.min_value, item.max_value].map((v) => v ?? '…').join('–')})`
      : `not done by ${occ.due_at.slice(11)} on ${occ.due_date}`;
  return `${occ.critical ? 'Critical: ' : ''}${item.title} ${what}${where}`;
}

// Posts an alert in the team chat's Everyone channel, calling on the recipients (they get it as an urgent
// mention). Ids only go out live; the text holds no patient details.
async function postToChat(db, practiceId, body, recipientIds, urgent) {
  await db.run(
    "INSERT INTO chat_channels (practice_id, kind, name, slug, topic, audience) VALUES (?, 'channel', 'Everyone', 'everyone', 'The whole office', 'everyone') ON CONFLICT (practice_id, slug) DO NOTHING",
    practiceId,
  );
  const channel = await db.get("SELECT * FROM chat_channels WHERE practice_id = ? AND slug = 'everyone'", practiceId);
  const made = await db.run(
    "INSERT INTO chat_messages (practice_id, channel_id, user_id, source, kind, body, urgent) VALUES (?, ?, NULL, 'automation', 'system', ?, ?)",
    practiceId, channel.id, body.slice(0, 3900), urgent ? 1 : 0,
  );
  for (const uid of recipientIds) {
    await join(db, channel, uid, { readThrough: made.id - 1 });
    await db.run('INSERT INTO chat_mentions (practice_id, message_id, channel_id, user_id, via) VALUES (?, ?, ?, ?, ?) ON CONFLICT (message_id, user_id) DO NOTHING', practiceId, made.id, channel.id, uid, 'checklist');
  }
  await announce(db, channel, { event: 'message', message_id: made.id, parent_id: null, mentions: recipientIds, urgent: !!urgent, by: null });
  return made.id;
}

// Tells the owner / office manager straight away: a live alert on their screens (always), a chat post (unless
// turned off) and, for critical flags, a text to the numbers in settings. A channel that fails becomes its own
// Needs attention item — the flag itself is already there.
export async function notify(db, messenger, flag) {
  const pid = flag.practice_id;
  const s = await settingsOf(db, pid);
  const to = await alertRecipients(db, pid);
  const via = ['live'];
  publish(pid, { type: 'checklist_alert', flag_id: flag.id, occurrence_id: flag.occurrence_id, critical: !!flag.critical, to });
  if (s.chat_alerts) {
    try {
      await postToChat(db, pid, `${flag.critical ? '🚩 ' : ''}${flag.title}. It stays on Needs attention until someone writes down what was done about it.`, to, !!flag.critical);
      via.push('chat');
      await resolveIssue(db, pid, `checklist-chat:${flag.id}`);
    } catch (err) {
      await raiseIssue(db, { practiceId: pid, kind: 'message', key: `checklist-chat:${flag.id}`, role: 'admin', title: `Couldn't post the checklist alert to team chat: ${flag.title}`, detail: err.message });
    }
  }
  const phones = parseList(s.alert_phones) || [];
  if (flag.critical && s.sms_alerts && phones.length) {
    if (!messenger?.send) {
      await raiseIssue(db, { practiceId: pid, kind: 'message', key: `checklist-sms:${flag.id}`, role: 'admin', title: 'Checklist alert texts are on, but texting isn’t set up on this server' });
    } else {
      const practice = await db.get('SELECT name FROM practices WHERE id = ?', pid);
      let sent = 0;
      for (const to of phones) {
        try {
          await messenger.send({ channel: 'sms', to, body: `${practice?.name || 'Dental Machine'}: ${flag.title}. Open Needs attention in Dental Machine.` });
          sent++;
        } catch (err) {
          await raiseIssue(db, { practiceId: pid, kind: 'message', key: `checklist-sms:${flag.id}`, role: 'admin', title: `A checklist alert text didn't go: ${flag.title}`, detail: err.message });
        }
      }
      if (sent) via.push('sms');
      if (sent === phones.length) await resolveIssue(db, pid, `checklist-sms:${flag.id}`);
    }
  }
  await db.run("UPDATE checklist_flags SET notified_at = datetime('now'), notified_via = ? WHERE id = ?", via.join(','), flag.id);
  return via;
}

// Raises a flag on an occurrence (once per kind): a Needs attention item — high for critical items — and the
// alerts above. Returns the flag, or null when it was already up.
export async function raiseFlag(db, messenger, occ, item, kind, { userId = null, source = 'automation' } = {}) {
  const office = await officeName(db, occ.location_id);
  const title = flagTitle(kind, item, occ, office);
  const r = await db.run(
    'INSERT INTO checklist_flags (practice_id, occurrence_id, item_id, location_id, kind, critical, title) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (occurrence_id, kind) DO NOTHING',
    occ.practice_id, occ.id, item.id, occ.location_id, kind, occ.critical ? 1 : 0, title.slice(0, 300),
  );
  if (!r.changes) return null;
  const flag = await db.get('SELECT * FROM checklist_flags WHERE occurrence_id = ? AND kind = ?', occ.id, kind);
  const issueId = await raiseIssue(db, {
    practiceId: occ.practice_id, kind: 'records', key: `checklist-flag:${flag.id}`, role: 'admin', severity: occ.critical ? 'high' : 'normal',
    title: title.slice(0, 300), entity: 'checklist_occurrences', entityId: occ.id,
    detail: `${kind === 'overdue' ? 'Nobody has ticked this item off.' : 'Recorded on the checklist.'} Resolve it from Checklists → Dashboard with the corrective action taken.`,
  });
  if (issueId) await db.run('UPDATE checklist_flags SET issue_id = ? WHERE id = ?', issueId, flag.id);
  await logEvent(db, occ, 'flagged', { details: { kind, flag_id: flag.id, critical: !!occ.critical }, userId, source });
  await audit(db, null, 'checklist.flag', 'checklist_flags', flag.id, { occurrence_id: occ.id, item_id: item.id, kind, critical: !!occ.critical, title }, { locationId: occ.location_id });
  const full = { ...flag, issue_id: issueId };
  await notify(db, messenger, full);
  return full;
}

// ---- The sweep ----
// For each practice: fill in "on shift" assignments for today, raise overdue flags on critical items past their
// due time, mark occurrences whose window has closed as missed (one Needs attention summary a day for the
// ordinary ones), and close flags someone resolved from the Needs attention page.
export async function sweep(db, practiceId, messenger, { now = new Date() } = {}) {
  const { nowLocal, today } = await practiceClock(db, practiceId, now);
  const out = { assigned: 0, flagged: 0, missed: 0 };
  // On shift: someone clocked in after the occurrence was made.
  const unassigned = await db.all(
    `SELECT o.* FROM checklist_occurrences o JOIN checklist_items i ON i.id = o.item_id
     WHERE o.practice_id = ? AND o.status = 'open' AND o.assigned_to IS NULL AND i.assign_rule = 'on_shift' AND o.due_date = ?`, practiceId, today,
  );
  for (const o of unassigned) {
    const who = await whoIsOnShift(db, practiceId, o.position_id, o.location_id, o.due_date, today);
    if (who) {
      await db.run('UPDATE checklist_occurrences SET assigned_to = ?, assigned_via = ? WHERE id = ? AND assigned_to IS NULL', who.userId, who.via, o.id);
      out.assigned++;
    }
  }
  // Critical and past the due time: the big flag.
  const overdue = await db.all(
    `SELECT o.* FROM checklist_occurrences o WHERE o.practice_id = ? AND o.status IN ('open','missed') AND o.critical = 1 AND o.due_at < ?
       AND NOT EXISTS (SELECT 1 FROM checklist_flags f WHERE f.occurrence_id = o.id AND f.kind = 'overdue')`, practiceId, nowLocal,
  );
  for (const o of overdue) {
    const item = await db.get('SELECT * FROM checklist_items WHERE id = ?', o.item_id);
    if (await raiseFlag(db, messenger, o, item, 'overdue')) out.flagged++;
  }
  // Window closed without a tick: missed.
  const closing = await db.all("SELECT o.* FROM checklist_occurrences o WHERE o.practice_id = ? AND o.status = 'open' AND o.closes_on < ?", practiceId, today);
  const ordinary = new Map();
  for (const o of closing) {
    const r = await db.run("UPDATE checklist_occurrences SET status = 'missed', missed_at = datetime('now') WHERE id = ? AND status = 'open'", o.id);
    if (!r.changes) continue;
    out.missed++;
    await logEvent(db, o, 'missed', { source: 'automation' });
    await audit(db, null, 'checklist.missed', 'checklist_occurrences', o.id, { item_id: o.item_id, due_date: o.due_date }, { locationId: o.location_id });
    if (!o.critical) ordinary.set(o.closes_on, (ordinary.get(o.closes_on) || 0) + 1);
  }
  for (const [day, n] of ordinary) {
    await raiseIssue(db, {
      practiceId, kind: 'records', key: `checklist-missed:${day}`, role: 'admin',
      title: `${n} checklist item${n === 1 ? ' was' : 's were'} missed (window closed ${day})`, detail: 'See Checklists → Dashboard for which ones and whose they were.',
    });
  }
  // Resolved on the Needs attention page (with a note there): the flag follows, with that note as its action.
  const settled = await db.all(
    `SELECT f.id, f.occurrence_id, i.status AS issue_status, i.resolution, i.resolved_by FROM checklist_flags f JOIN issues i ON i.id = f.issue_id
     WHERE f.practice_id = ? AND f.status = 'open' AND i.status <> 'open'`, practiceId,
  );
  for (const f of settled) {
    const action = `${f.issue_status === 'ignored' ? 'Marked as not needing action on Needs attention' : 'Resolved on Needs attention'}: ${f.resolution || '(no note)'}`;
    await db.run("UPDATE checklist_flags SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ?, corrective_action = ? WHERE id = ? AND status = 'open'", f.resolved_by, action.slice(0, 2000), f.id);
    const occ = await db.get('SELECT * FROM checklist_occurrences WHERE id = ?', f.occurrence_id);
    await logEvent(db, occ, 'flag_resolved', { details: { flag_id: f.id }, reason: action, userId: f.resolved_by, source: 'human' });
  }
  if (out.flagged || out.missed || settled.length || out.assigned) publish(practiceId, { type: 'checklists' });
  return out;
}

// The background job: for every practice with checklists, make today's occurrences and sweep. A practice that
// fails becomes a Needs attention item (and doesn't stop the others); the next good run clears it.
export async function runChecklistJobs(db, messenger, { now = new Date(), practiceId = null } = {}) {
  const practices = practiceId ? [{ practice_id: practiceId }] : await db.all("SELECT DISTINCT practice_id FROM checklist_items WHERE status = 'active'");
  const totals = { practices: 0, made: 0, flagged: 0, missed: 0 };
  for (const { practice_id: pid } of practices) {
    try {
      await withActor({ source: 'automation', actor: 'Checklists', userId: null, practiceId: pid, pending: null }, async () => {
        totals.made += await generate(db, pid, { now });
        const s = await sweep(db, pid, messenger, { now });
        totals.flagged += s.flagged;
        totals.missed += s.missed;
      });
      totals.practices++;
      await resolveIssue(db, pid, 'checklist-job');
    } catch (err) {
      log.error('Checklist job failed', err, { practice_id: pid });
      await raiseIssue(db, { practiceId: pid, kind: 'records', key: 'checklist-job', role: 'admin', severity: 'high', title: 'Checklists couldn’t be updated (due items and alerts may be late)', detail: err.message });
    }
  }
  return totals;
}

// ---- How an occurrence stands right now ----
// done (on time), late (done after its due time), missed, overdue (open and past due), open (not due yet).
export function stateOf(o, nowLocal) {
  if (o.status === 'done') return o.completed_late ? 'late' : 'done';
  if (o.status === 'missed') return 'missed';
  if (o.status === 'cancelled') return 'cancelled';
  return o.due_at < nowLocal ? 'overdue' : 'open';
}
