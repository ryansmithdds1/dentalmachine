// Review requests with a feedback screen (RV1–RV2, docs/reviews.md).
//
// A "review request" is one review_feedback row: the link we texted or emailed, and each step the patient took
// (opened → rated → clicked through to a review site, or sent private feedback). Rules:
// - Ask from anywhere (chart, patient bar, checkout, command bar) or automatically after a visit (the practice's
//   review_requests switch, off by default); never more than once per N months per patient (review_settings).
// - Asking twice by accident (double click, retry) returns the first request; a natural unique key (patient +
//   practice-local day) means two at once can't both send.
// - Opt-outs and quiet hours are respected: sendMessage refuses opted-out addresses, and outside sending hours
//   a request waits ("queued") until the office's hours open.
// - Everyone rates first. Happy ratings (the practice's review_threshold, 4 by default) are invited to post a
//   review; lower ratings are asked what went wrong, privately. The public review link is shown to EVERYONE, at
//   every step (Google forbids "review gating" and the FTC forbids suppressing negative reviews) — there is no
//   setting that hides it.
// - Private feedback reaches the owner and office manager at once (live event, a "Patient feedback" team chat
//   post) with a follow-up task, and waits in the Reviews page inbox (new → contacted → resolved).
import { HttpError, USER_PERMISSION_SQL, can } from './auth.js';
import { insert, change, audit, localNow, newToken } from './util.js';
import { sendMessage, preferredChannel, recipientFor, withinSendHours, isOptedOutAddress } from './messaging.js';
import { templatesFor, renderTemplate, patientLang, subjectFor, fixedText } from './templates.js';
import { publish } from './events.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { announce } from './chat.js';
import { withActor } from './actor.js';
import { recordMentions } from './shoutouts.js';

export const REQUEST_SOURCES = ['chart', 'patient_bar', 'checkout', 'command', 'schedule', 'reviews', 'auto'];
export const FEEDBACK_STATUSES = ['new', 'contacted', 'resolved'];
export const MANAGE = 'reviews:manage';
// A repeat of the same ask within this window is the same request (a double click), not a throttled one.
const REPEAT_MS = 10 * 60_000;
// Asked outside sending hours: sent when the office opens, unless it's older than this.
const QUEUE_DAYS = 3;

const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const utc = (s) => new Date(`${String(s).replace(' ', 'T')}Z`);
const isUnique = (err) => /unique|duplicate/i.test(String(err?.message)) || err?.code === '23505';
const nameOf = (p) => `${p.first_name} ${p.last_name}`;

// ---- Settings ----
export async function reviewSettings(db, practiceId) {
  const row = await db.get('SELECT * FROM review_settings WHERE practice_id = ?', practiceId);
  const pr = await db.get('SELECT review_url, review_threshold, review_requests FROM practices WHERE id = ?', practiceId);
  return {
    throttle_months: row?.throttle_months ?? 6, channel: row?.channel || 'auto', other_sites: parse(row?.other_sites, []),
    notify_user_ids: parse(row?.notify_user_ids, []), followup_user_id: row?.followup_user_id ?? null,
    points_per_mention: row?.points_per_mention ?? 10, reward_note: row?.reward_note || null,
    review_url: pr?.review_url || null, threshold: pr?.review_threshold || 4, auto_after_visit: !!pr?.review_requests,
    // Always on: shown so screens can say so, never settable (see the compliance note above).
    public_link_for_everyone: true, updated_at: row?.updated_at || null,
  };
}

// The review sites a patient can pick: Google (the practice's review link) first, then the office's others.
export function reviewSites(settings) {
  const sites = [];
  if (settings.review_url) sites.push({ key: 'google', name: 'Google', url: settings.review_url });
  settings.other_sites.forEach((s, i) => sites.push({ key: String(i + 1), name: s.name, url: s.url }));
  return sites;
}

// ---- Throttle ----
export async function lastRequest(db, practiceId, patientId) {
  // Requests that never went (failed, blocked by an opt-out, expired in the queue) don't count.
  return db.get(
    "SELECT * FROM review_feedback WHERE practice_id = ? AND patient_id = ? AND (send_status IS NULL OR send_status IN ('sent','queued','sending')) ORDER BY sent_at DESC, id DESC LIMIT 1",
    practiceId, patientId,
  );
}

export async function throttleFor(db, practiceId, patientId, now = new Date()) {
  const s = await reviewSettings(db, practiceId);
  const last = await lastRequest(db, practiceId, patientId);
  if (!last) return { allowed: true, last: null, next_allowed: null, months: s.throttle_months };
  const next = utc(last.sent_at);
  next.setUTCMonth(next.getUTCMonth() + s.throttle_months);
  return { allowed: now >= next, last, next_allowed: next.toISOString().slice(0, 10), months: s.throttle_months };
}

// Who can be reached, and how: the patient (or a child's parent), by the channel asked for or the office's
// usual one, skipping any address that opted out (STOP / unsubscribed).
async function reachable(db, practiceId, patient, requested, settings) {
  const to = await recipientFor(db, patient);
  const want = requested && requested !== 'auto' ? requested : settings.channel !== 'auto' ? settings.channel : undefined;
  const options = [preferredChannel(to, want, { fallback: !requested || requested === 'auto' })];
  if (!requested || requested === 'auto') options.push(preferredChannel(to, options[0]?.channel === 'sms' ? 'email' : 'sms'));
  for (const t of options.filter(Boolean)) if (!(await isOptedOutAddress(db, practiceId, t.channel, t.to))) return { ...t, recipient: to };
  return null;
}

// ---- Asking ----
// Returns { request, status: 'sent' | 'queued' | 'failed' | 'blocked', already?, error? }. Throws 409 when the
// patient was asked too recently and 422 when they can't be reached (opted out, nothing on file).
export async function requestReview(db, messenger, { practiceId, patientId, appointmentId = null, userId = null, source = 'chart', channel = 'auto', appUrl = '', now = new Date(), req = null }) {
  const patient = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', Number(patientId), practiceId);
  if (!patient) throw new HttpError(404, 'Patient not found');
  if (patient.status && patient.status !== 'active') throw new HttpError(400, `${nameOf(patient)}’s chart is ${patient.status}`);
  if (!REQUEST_SOURCES.includes(source)) throw new HttpError(400, 'Unknown source');
  if (!['auto', 'sms', 'email'].includes(channel)) throw new HttpError(400, 'Send by text or email');
  if (appointmentId != null) {
    const a = await db.get('SELECT id FROM appointments WHERE id = ? AND practice_id = ? AND patient_id = ?', Number(appointmentId), practiceId, patient.id);
    if (!a) throw new HttpError(400, 'That visit isn’t this patient’s');
  }
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  const settings = await reviewSettings(db, practiceId);

  const t = await throttleFor(db, practiceId, patient.id, now);
  if (!t.allowed) {
    if (now - utc(t.last.sent_at) < REPEAT_MS && source !== 'auto') return { request: t.last, status: t.last.send_status || 'sent', already: true };
    throw new HttpError(409, `${patient.first_name} was asked for a review on ${t.last.sent_at.slice(0, 10)}. The office asks at most once every ${t.months} month${t.months === 1 ? '' : 's'} — next possible ${t.next_allowed}.`,
      { last_sent_at: t.last.sent_at, next_allowed: t.next_allowed });
  }
  const target = await reachable(db, practiceId, patient, channel, settings);
  if (!target) {
    throw new HttpError(422, channel === 'sms' ? `${patient.first_name} can’t get texts (opted out, or no mobile number on file)`
      : channel === 'email' ? `${patient.first_name} can’t get email (opted out, or no email address on file)`
        : `${patient.first_name} can’t be reached — they opted out of texts and email, or there’s no number or address on file`);
  }

  const local = localNow(practice.timezone || 'America/New_York', now);
  const day = local.slice(0, 10);
  const quiet = !withinSendHours(practice, local);
  const fields = { channel: target.channel, requested_by: userId, request_source: source, appointment_id: appointmentId != null ? Number(appointmentId) : null, send_status: quiet ? 'queued' : 'sending', send_error: null };
  // An earlier try today that didn't go (failed, blocked) is retried on the same row: one request per patient per day.
  const earlier = await db.get('SELECT * FROM review_feedback WHERE practice_id = ? AND patient_id = ? AND request_day = ?', practiceId, patient.id, day);
  let id;
  if (earlier) {
    await change(db, 'review_feedback', earlier.id, fields);
    id = earlier.id;
  } else {
    try {
      id = await insert(db, 'review_feedback', { practice_id: practiceId, patient_id: patient.id, location_id: patient.location_id ?? null, token_hash: newToken().hash, request_day: day, ...fields });
    } catch (err) {
      if (!isUnique(err)) throw err;
      // The same ask arrived twice at once: the other one is sending it.
      return { request: await db.get('SELECT * FROM review_feedback WHERE practice_id = ? AND patient_id = ? AND request_day = ?', practiceId, patient.id, day), status: 'sending', already: true };
    }
  }
  const row = await db.get('SELECT * FROM review_feedback WHERE id = ?', id);
  const out = quiet ? { request: row, status: 'queued' } : await deliver(db, messenger, row, { appUrl, userId });
  await audit(db, req || { user: { practice_id: practiceId, id: userId } }, 'review.request', 'review_feedback', id,
    { patient_id: patient.id, channel: target.channel, source, status: out.status, message_id: out.request.message_id ?? null, ...(out.error ? { error: out.error } : {}) });
  return out;
}

// Sends the link. A fresh token each time (only its hash is kept), so a queued or retried request works.
async function deliver(db, messenger, row, { appUrl = '', userId = null } = {}) {
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', row.patient_id);
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', row.practice_id);
  const settings = await reviewSettings(db, row.practice_id);
  const target = await reachable(db, row.practice_id, patient, row.channel || 'auto', settings);
  if (!target) {
    await db.run("UPDATE review_feedback SET send_status = 'blocked', send_error = ? WHERE id = ?", 'Opted out or no number/address on file', row.id);
    return { request: await db.get('SELECT * FROM review_feedback WHERE id = ?', row.id), status: 'blocked', error: 'Opted out or no number/address on file' };
  }
  const lang = patientLang(patient);
  const { token, hash } = newToken();
  const body = renderTemplate(templatesFor(practice, lang).review, { first_name: patient.first_name, practice: practice.name, link: `${appUrl}/r/${token}`, phone: practice.phone || '' });
  const msg = await sendMessage(db, messenger, {
    practiceId: row.practice_id, patientId: row.patient_id, appointmentId: row.appointment_id, kind: 'review', channel: target.channel, to: target.to, userId,
    subject: subjectFor(lang, 'review', `How was your visit to ${practice.name}?`, practice.name), body: target.channel === 'sms' ? `${body}${fixedText(lang).sms_stop}` : body,
  });
  const status = msg.status === 'sent' ? 'sent' : msg.status === 'blocked' ? 'blocked' : msg.status === 'queued' ? 'sent' : 'failed';
  await db.run("UPDATE review_feedback SET token_hash = ?, message_id = ?, channel = ?, send_status = ?, send_error = ?, sent_at = datetime('now') WHERE id = ?",
    hash, msg.id, target.channel, status, msg.error || null, row.id);
  return { request: await db.get('SELECT * FROM review_feedback WHERE id = ?', row.id), status, error: msg.error || null };
}

// ---- The background job: queued requests, and automatic requests after a visit ----
export async function runReviewJobs(db, messenger, { now = new Date(), appUrl = '' } = {}) {
  let sent = 0;
  for (const practice of await db.all('SELECT * FROM practices')) {
    const local = localNow(practice.timezone || 'America/New_York', now);
    if (!withinSendHours(practice, local)) continue;
    await withActor({ source: 'automation', actor: 'Review requests', practiceId: practice.id, userId: null }, async () => {
      const cutoff = new Date(now.getTime() - QUEUE_DAYS * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
      for (const row of await db.all("SELECT * FROM review_feedback WHERE practice_id = ? AND send_status = 'queued' ORDER BY id", practice.id)) {
        if (row.sent_at < cutoff) {
          await db.run("UPDATE review_feedback SET send_status = 'expired' WHERE id = ?", row.id);
          continue;
        }
        const out = await deliver(db, messenger, row, { appUrl });
        await audit(db, null, 'review.request_sent', 'review_feedback', row.id, { patient_id: row.patient_id, status: out.status, queued: true });
        if (out.status === 'sent') sent++;
      }
      // Automatic after a visit: only when the office turned it on (and has somewhere to send happy patients).
      if (!practice.review_requests || !practice.review_url) return;
      const yesterday = new Date(`${local.slice(0, 10)}T12:00:00Z`);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const due = await db.all(
        `SELECT a.id, a.patient_id FROM real_appointments a WHERE a.practice_id = ? AND a.status = 'completed' AND a.review_sent_at IS NULL
         AND a.start_time >= ? AND a.end_time <= ? ORDER BY a.id`, practice.id, `${yesterday.toISOString().slice(0, 10)} 00:00`, local,
      );
      for (const a of due) {
        // Marked first: whatever happens next, one visit is never asked about twice.
        await db.run("UPDATE appointments SET review_sent_at = datetime('now') WHERE id = ? AND review_sent_at IS NULL", a.id);
        try {
          const out = await requestReview(db, messenger, { practiceId: practice.id, patientId: a.patient_id, appointmentId: a.id, source: 'auto', appUrl, now });
          if (out.status === 'sent' && !out.already) sent++;
        } catch (err) {
          // Asked recently, opted out or unreachable: the automatic request simply doesn't go.
          if (!(err instanceof HttpError)) throw err;
        }
      }
    });
  }
  return sent;
}

// ---- Private feedback: owner + office manager hear at once ----
// The people named in review settings, else every administrator and anyone given reviews:manage.
export async function feedbackRecipients(db, practiceId) {
  const s = await reviewSettings(db, practiceId);
  const team = await db.all(`${USER_PERMISSION_SQL} WHERE u.practice_id = ? AND u.active = 1 ORDER BY u.id`, practiceId);
  if (s.notify_user_ids.length) return team.filter((u) => s.notify_user_ids.includes(u.id)).map((u) => ({ id: u.id, name: u.name }));
  return team.filter((u) => can(u, MANAGE)).map((u) => ({ id: u.id, name: u.name }));
}

async function feedbackChannel(db, practiceId, userIds) {
  await db.run("INSERT INTO chat_channels (practice_id, kind, name, topic, dm_key) VALUES (?, 'group', 'Patient feedback', 'Private feedback from the review screen', 'patient-feedback') ON CONFLICT (practice_id, dm_key) DO NOTHING", practiceId);
  const c = await db.get("SELECT * FROM chat_channels WHERE practice_id = ? AND dm_key = 'patient-feedback'", practiceId);
  for (const id of userIds) {
    await db.run('INSERT INTO chat_members (practice_id, channel_id, user_id, last_read_id) VALUES (?, ?, ?, 0) ON CONFLICT (channel_id, user_id) DO NOTHING', practiceId, c.id, id);
    await db.run('UPDATE chat_members SET left_at = NULL WHERE channel_id = ? AND user_id = ? AND left_at IS NOT NULL', c.id, id);
  }
  return c;
}

export const taskTitle = (f, p) => `Unhappy after visit (${f.rating}★): ${nameOf(p)}${f.comment ? ` — “${f.comment.slice(0, 140)}”` : ''}${f.callback_wanted ? ' · wants a call back' : ''}`;

// A low rating (stage 'rated') or the private feedback itself (stage 'feedback'): a follow-up task (one per
// request, kept up to date), a live alert to the recipients' screens and a post in their Patient feedback chat.
export async function raiseFeedback(db, feedbackId, stage) {
  const f = await db.get('SELECT * FROM review_feedback WHERE id = ?', feedbackId);
  const p = await db.get('SELECT id, first_name, last_name, location_id FROM patients WHERE id = ?', f.patient_id);
  const s = await reviewSettings(db, f.practice_id);
  const practice = await db.get('SELECT timezone FROM practices WHERE id = ?', f.practice_id);
  const title = taskTitle(f, p);
  let taskId = f.task_id;
  if (taskId) await change(db, 'tasks', taskId, { title, priority: 'high' });
  else {
    taskId = await insert(db, 'tasks', {
      practice_id: f.practice_id, patient_id: f.patient_id, priority: 'high', due_date: localNow(practice.timezone || 'America/New_York').slice(0, 10), title,
      assigned_to: s.followup_user_id, notes: 'From the review feedback screen. Call, listen, then mark it contacted or resolved on the Reviews page.',
    });
    await change(db, 'review_feedback', f.id, { task_id: taskId });
  }
  if (!f.feedback_status) await change(db, 'review_feedback', f.id, { feedback_status: 'new' });
  publish(f.practice_id, { type: 'tasks' });

  const recipients = await feedbackRecipients(db, f.practice_id);
  const ids = recipients.map((u) => u.id);
  publish(f.practice_id, { type: 'review_feedback', feedback_id: f.id, stage, to: ids });
  if (stage === 'rated' && f.notified_at) return { task_id: taskId, notified: ids, chat: null };
  let chatId = null;
  try {
    if (ids.length) {
      const c = await feedbackChannel(db, f.practice_id, ids);
      const body = stage === 'rated'
        ? `${nameOf(p)} rated their visit ${f.rating}★ on the review screen. We’ve asked what went wrong — a follow-up task is on the list.`
        : `Private feedback from ${nameOf(p)} (${f.rating}★): “${String(f.comment || '').slice(0, 600)}”${f.callback_wanted ? `\nWants a call back${f.callback_note ? ` — ${f.callback_note}` : ''}.` : ''}`;
      const urgent = f.callback_wanted || f.rating <= 2 ? 1 : 0;
      const made = await db.run("INSERT INTO chat_messages (practice_id, channel_id, user_id, source, kind, body, patient_id, urgent) VALUES (?, ?, NULL, 'automation', 'system', ?, ?, ?)",
        f.practice_id, c.id, body.slice(0, 3900), p.id, urgent);
      chatId = made.id;
      await announce(db, c, { event: 'message', message_id: made.id, parent_id: null, mentions: ids, urgent: !!urgent, by: null });
    }
    await db.run("UPDATE review_feedback SET notified_at = COALESCE(notified_at, datetime('now')) WHERE id = ?", f.id);
    await resolveIssue(db, f.practice_id, `review-feedback-notify:${f.id}`);
  } catch (err) {
    // The task and the inbox still have it; the missing chat post becomes a work item, not a log line.
    await raiseIssue(db, { practiceId: f.practice_id, kind: 'message', key: `review-feedback-notify:${f.id}`, role: 'admin', patientId: p.id,
      title: `Private feedback from ${nameOf(p)} couldn’t be posted to team chat`, detail: err.message });
  }
  return { task_id: taskId, notified: ids, chat: chatId };
}

// Staff named in what the patient wrote (RV3).
export async function feedbackMentions(db, feedbackId) {
  const f = await db.get('SELECT * FROM review_feedback WHERE id = ?', feedbackId);
  if (!f?.comment) return [];
  return recordMentions(db, { practiceId: f.practice_id, source: 'feedback', sourceId: f.id, patientId: f.patient_id, text: f.comment, rating: f.rating, when: f.feedback_at || f.responded_at });
}
