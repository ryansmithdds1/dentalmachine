// Reviews with a feedback screen and team shout-outs (RV1–RV3, docs/reviews.md). Staff routes (mounted on the
// signed-in api router) and the patient's public page (/r/:token → /api/public/review/:token).
import { Router } from 'express';
import { HttpError, requirePermission, rateLimit, can } from '../auth.js';
import { insert, update, change, recorded, audit, findOr404, hashToken } from '../util.js';
import { patientLang } from '../templates.js';
import {
  requestReview, reviewSettings, reviewSites, throttleFor, raiseFeedback, feedbackMentions, feedbackRecipients, REQUEST_SOURCES, FEEDBACK_STATUSES, MANAGE,
} from '../reviewfunnel.js';
import { scanReviews, norm } from '../shoutouts.js';
import { publish } from '../events.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;
const thisMonth = () => new Date().toISOString().slice(0, 7);
const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
// Links carry only a hash in the database; never hand even that back.
const clean = (row) => (row ? { ...row, token_hash: undefined } : row);
const requireManage = (req, _res, next) => (can(req.user, MANAGE) ? next() : next(new HttpError(403, 'Only the owner or office manager can do this (Reviews: manage)')));
const intIn = (v, lo, hi, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${name} must be a whole number from ${lo} to ${hi}`);
  return n;
};
async function staffMember(db, practiceId, id, name = 'Team member') {
  const u = await db.get('SELECT id, name FROM users WHERE id = ? AND practice_id = ? AND active = 1', Number(id), practiceId);
  if (!u) throw new HttpError(400, `${name} isn’t an active member of this practice`);
  return u;
}

export default function reviewFunnelRoutes({ db, messenger, config }) {
  const r = Router();

  // ---- RV1: ask for a review from anywhere ----
  r.get('/patients/:id/review-request', requirePermission('patients:read'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const t = await throttleFor(db, req.user.practice_id, p.id);
    const history = await db.all('SELECT id, sent_at, channel, request_source, send_status, opened_at, rating, posted_click_at, posted_site, feedback_at, feedback_status FROM review_feedback WHERE practice_id = ? AND patient_id = ? ORDER BY id DESC LIMIT 10', req.user.practice_id, p.id);
    res.json({ allowed: t.allowed, next_allowed: t.next_allowed, months: t.months, last: clean(t.last), history });
  });

  r.post('/patients/:id/review-request', requirePermission('patients:write'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const b = req.body || {};
    const source = b.source == null ? 'chart' : String(b.source);
    if (!REQUEST_SOURCES.includes(source) || source === 'auto') throw new HttpError(400, 'Unknown source');
    const out = await requestReview(db, messenger, {
      practiceId: req.user.practice_id, patientId: p.id, appointmentId: b.appointment_id ?? null, userId: req.user.id, source, channel: b.channel || 'auto', appUrl: config.appUrl, req,
    });
    const body = { status: out.status, already: !!out.already, channel: out.request.channel, request: clean(out.request) };
    if (out.status === 'blocked') throw new HttpError(422, out.error || 'The patient opted out of this channel');
    if (out.status === 'failed') throw new HttpError(502, `The message didn’t go: ${out.error || 'unknown error'}. It’s in Needs attention.`);
    res.status(out.already ? 200 : out.status === 'queued' ? 202 : 201).json(body);
  });

  // ---- The Reviews page: funnel, rating, inbox, leaderboard ----
  r.get('/reviews/overview', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const to = DATE.test(req.query.to || '') ? req.query.to : new Date().toISOString().slice(0, 10);
    const from = DATE.test(req.query.from || '') ? req.query.from : `${to.slice(0, 7)}-01`;
    // Names in online reviews synced since the last look.
    await scanReviews(db, pid);
    const s = await reviewSettings(db, pid);
    const rows = await db.all('SELECT * FROM review_feedback WHERE practice_id = ? AND substr(sent_at, 1, 10) BETWEEN ? AND ?', pid, from, to);
    const went = rows.filter((x) => x.send_status == null || x.send_status === 'sent');
    const rated = went.filter((x) => x.rating != null);
    const funnel = {
      sent: went.length, queued: rows.filter((x) => x.send_status === 'queued').length, not_sent: rows.filter((x) => ['failed', 'blocked', 'expired'].includes(x.send_status)).length,
      opened: went.filter((x) => x.opened_at || x.rating != null).length, rated: rated.length,
      happy: rated.filter((x) => x.rating >= s.threshold).length, unhappy: rated.filter((x) => x.rating < s.threshold).length,
      posted_click: went.filter((x) => x.posted_click_at || x.went_to_review).length, feedback: went.filter((x) => x.feedback_at).length,
    };
    const online = await db.all('SELECT rating, posted_at, created_at FROM reviews WHERE practice_id = ? AND rating IS NOT NULL', pid);
    const inRange = online.filter((x) => String(x.posted_at || x.created_at).slice(0, 10) >= from && String(x.posted_at || x.created_at).slice(0, 10) <= to);
    const bySource = {};
    for (const x of rows) bySource[x.request_source || 'auto'] = (bySource[x.request_source || 'auto'] || 0) + 1;
    const manage = can(req.user, MANAGE);
    const inbox = manage ? await db.all("SELECT feedback_status AS status, COUNT(*) AS n FROM review_feedback WHERE practice_id = ? AND feedback_status IS NOT NULL GROUP BY feedback_status", pid) : [];
    res.json({
      from, to, threshold: s.threshold, funnel, by_source: bySource,
      average: avg(rated.map((x) => x.rating)), by_stars: [5, 4, 3, 2, 1].map((n) => ({ stars: n, count: rated.filter((x) => x.rating === n).length })),
      online: { average: avg(online.map((x) => x.rating)), count: online.length, average_in_range: avg(inRange.map((x) => x.rating)), count_in_range: inRange.length },
      inbox: manage ? Object.fromEntries(FEEDBACK_STATUSES.map((k) => [k, Number(inbox.find((x) => x.status === k)?.n || 0)])) : null,
      can_manage: manage, review_url: !!s.review_url,
    });
  });

  // Private feedback inbox: new → contacted → resolved.
  r.get('/reviews/feedback', requirePermission('patients:read'), requireManage, async (req, res) => {
    const status = String(req.query.status || 'open');
    const cond = status === 'open' ? " AND rf.feedback_status IN ('new','contacted')" : FEEDBACK_STATUSES.includes(status) ? ' AND rf.feedback_status = ?' : '';
    const rows = await db.all(
      `SELECT rf.id, rf.patient_id, rf.rating, rf.comment, rf.callback_wanted, rf.callback_note, rf.feedback_status, rf.feedback_status_at, rf.resolution_note, rf.feedback_at, rf.rated_at, rf.sent_at,
         rf.posted_click_at, rf.task_id, p.first_name, p.last_name, p.phone, t.status AS task_status, u.name AS status_by_name
       FROM review_feedback rf JOIN patients p ON p.id = rf.patient_id LEFT JOIN tasks t ON t.id = rf.task_id LEFT JOIN users u ON u.id = rf.feedback_status_by
       WHERE rf.practice_id = ? AND rf.feedback_status IS NOT NULL${cond} ORDER BY CASE rf.feedback_status WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 ELSE 2 END, rf.id DESC LIMIT 300`,
      req.user.practice_id, ...(FEEDBACK_STATUSES.includes(status) ? [status] : []),
    );
    res.json(rows);
  });

  r.patch('/reviews/feedback/:id', requirePermission('patients:read'), requireManage, async (req, res) => {
    const f = await findOr404(db, 'review_feedback', req.params.id, req.user.practice_id, 'Feedback');
    const status = String(req.body?.status || '');
    if (!FEEDBACK_STATUSES.includes(status)) throw new HttpError(400, 'Status must be new, contacted or resolved');
    if (!f.feedback_status) throw new HttpError(400, 'This request has no private feedback to follow up');
    const note = req.body?.note != null ? String(req.body.note).trim().slice(0, 1000) || null : f.resolution_note;
    await update(db, 'review_feedback', f.id, req.user.practice_id, { feedback_status: status, feedback_status_by: req.user.id, feedback_status_at: new Date().toISOString().slice(0, 19).replace('T', ' '), resolution_note: note });
    // Resolved: the follow-up task is done too (and back open if the feedback is reopened).
    if (f.task_id) {
      const t = await db.get('SELECT status FROM tasks WHERE id = ? AND practice_id = ?', f.task_id, req.user.practice_id);
      if (t && status === 'resolved' && t.status !== 'done') await change(db, 'tasks', f.task_id, { status: 'done', completed_at: new Date().toISOString(), completed_by: req.user.id });
      if (t && status !== 'resolved' && t.status === 'done' && f.feedback_status === 'resolved') await change(db, 'tasks', f.task_id, { status: 'open', completed_at: null, completed_by: null });
      publish(req.user.practice_id, { type: 'tasks' });
    }
    await audit(db, req, 'review.feedback_status', 'review_feedback', f.id, { patient_id: f.patient_id, from: f.feedback_status, to: status }, { reason: note });
    res.json(clean(await db.get('SELECT * FROM review_feedback WHERE id = ?', f.id)));
  });

  // ---- Settings ----
  r.get('/reviews/settings', requirePermission('patients:read'), async (req, res) => {
    const s = await reviewSettings(db, req.user.practice_id);
    res.json({ ...s, recipients: await feedbackRecipients(db, req.user.practice_id) });
  });

  r.put('/reviews/settings', requirePermission('patients:read'), requireManage, async (req, res) => {
    const pid = req.user.practice_id;
    const b = req.body || {};
    // Nothing here can hide the public review link: that's not a setting (docs/reviews.md).
    if ('public_link_for_everyone' in b && b.public_link_for_everyone !== true) throw new HttpError(400, 'The public review link is always offered to everyone (Google and FTC rules) — it can’t be turned off');
    const row = {};
    if (b.throttle_months !== undefined) row.throttle_months = intIn(b.throttle_months, 1, 24, 'Months between requests');
    if (b.channel !== undefined) {
      if (!['auto', 'sms', 'email'].includes(b.channel)) throw new HttpError(400, 'Channel must be auto, sms or email');
      row.channel = b.channel;
    }
    if (b.points_per_mention !== undefined) row.points_per_mention = intIn(b.points_per_mention, 0, 1000, 'Points per shout-out');
    if (b.reward_note !== undefined) row.reward_note = b.reward_note ? String(b.reward_note).trim().slice(0, 300) : null;
    if (b.other_sites !== undefined) {
      if (!Array.isArray(b.other_sites) || b.other_sites.length > 5) throw new HttpError(400, 'Up to 5 other review sites');
      row.other_sites = JSON.stringify(b.other_sites.map((x) => {
        const name = String(x?.name || '').trim().slice(0, 40);
        const url = String(x?.url || '').trim();
        if (!name || !URL_RE.test(url)) throw new HttpError(400, 'Each review site needs a name and a web address (https://…)');
        return { name, url };
      }));
    }
    if (b.notify_user_ids !== undefined) {
      if (!Array.isArray(b.notify_user_ids) || b.notify_user_ids.length > 20) throw new HttpError(400, 'Pick up to 20 people to tell');
      for (const id of b.notify_user_ids) await staffMember(db, pid, id, 'Someone to tell');
      row.notify_user_ids = JSON.stringify([...new Set(b.notify_user_ids.map(Number))]);
    }
    if (b.followup_user_id !== undefined) row.followup_user_id = b.followup_user_id == null ? null : (await staffMember(db, pid, b.followup_user_id, 'The follow-up person')).id;
    const practice = {};
    if (b.threshold !== undefined) practice.review_threshold = intIn(b.threshold, 2, 5, 'Happy from (stars)');
    if (b.auto_after_visit !== undefined) practice.review_requests = b.auto_after_visit ? 1 : 0;
    if (b.review_url !== undefined) {
      if (b.review_url && !URL_RE.test(String(b.review_url).trim())) throw new HttpError(400, 'The Google review link must be a web address (https://…)');
      practice.review_url = b.review_url ? String(b.review_url).trim() : null;
    }
    const before = await reviewSettings(db, pid);
    if (Object.keys(row).length) {
      await db.run('INSERT INTO review_settings (practice_id) VALUES (?) ON CONFLICT (practice_id) DO NOTHING', pid);
      const id = (await db.get('SELECT id FROM review_settings WHERE practice_id = ?', pid)).id;
      await update(db, 'review_settings', id, pid, { ...row, updated_by: req.user.id, updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    }
    if (Object.keys(practice).length) await recorded(db, 'practices', pid, () => db.run(`UPDATE practices SET ${Object.keys(practice).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(practice), pid));
    const after = await reviewSettings(db, pid);
    const pickShown = (x) => ({ throttle_months: x.throttle_months, channel: x.channel, other_sites: JSON.stringify(x.other_sites), notify_user_ids: JSON.stringify(x.notify_user_ids), followup_user_id: x.followup_user_id, points_per_mention: x.points_per_mention, reward_note: x.reward_note, threshold: x.threshold, auto_after_visit: x.auto_after_visit ? 1 : 0, review_url: x.review_url });
    await audit(db, req, 'review.settings', 'practices', pid, null, { before: pickShown(before), after: pickShown(after) });
    res.json({ ...after, recipients: await feedbackRecipients(db, pid) });
  });

  // ---- RV3: nicknames, shout-outs, leaderboard, rewards ----
  r.get('/reviews/nicknames', requirePermission('patients:read'), async (req, res) => {
    res.json(await db.all('SELECT n.id, n.user_id, n.nickname, u.name FROM staff_nicknames n JOIN users u ON u.id = n.user_id WHERE n.practice_id = ? ORDER BY u.name, n.nickname', req.user.practice_id));
  });
  r.post('/reviews/nicknames', requirePermission('patients:read'), requireManage, async (req, res) => {
    const pid = req.user.practice_id;
    const u = await staffMember(db, pid, req.body?.user_id);
    const nickname = String(req.body?.nickname || '').trim().replace(/\s+/g, ' ');
    if (!/^[\p{L}][\p{L} .'’-]{1,29}$/u.test(nickname) || !norm(nickname)) throw new HttpError(400, 'A nickname is 2–30 letters (like “Annie” or “Dr. Bob”)');
    const taken = (await db.all('SELECT n.nickname, u.name FROM staff_nicknames n JOIN users u ON u.id = n.user_id WHERE n.practice_id = ?', pid)).find((x) => norm(x.nickname) === norm(nickname));
    if (taken) throw new HttpError(409, `“${taken.nickname}” already means ${taken.name}`);
    const id = await insert(db, 'staff_nicknames', { practice_id: pid, user_id: u.id, nickname, created_by: req.user.id });
    await audit(db, req, 'shoutout.nickname_add', 'staff_nicknames', id, { user_id: u.id, name: u.name, nickname });
    res.status(201).json({ id, user_id: u.id, nickname, name: u.name });
  });
  // Configuration, not a record: removing a nickname is a hard delete, audited with what it was.
  r.delete('/reviews/nicknames/:id', requirePermission('patients:read'), requireManage, async (req, res) => {
    const n = await findOr404(db, 'staff_nicknames', req.params.id, req.user.practice_id, 'Nickname');
    await db.run('DELETE FROM staff_nicknames WHERE id = ? AND practice_id = ?', n.id, req.user.practice_id);
    await audit(db, req, 'shoutout.nickname_remove', 'staff_nicknames', n.id, { user_id: n.user_id, nickname: n.nickname });
    res.json({ ok: true });
  });

  r.get('/reviews/shoutouts', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const month = MONTH.test(req.query.month || '') ? req.query.month : null;
    const status = ['counted', 'needs_match', 'unlinked'].includes(req.query.status) ? req.query.status : null;
    const manage = can(req.user, MANAGE);
    const rows = await db.all(
      `SELECT s.*, u.name AS user_name, p.first_name, p.last_name, d.name AS decided_by_name FROM review_shoutouts s LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN patients p ON p.id = s.patient_id LEFT JOIN users d ON d.id = s.decided_by
       WHERE s.practice_id = ?${month ? ' AND s.month = ?' : ''}${status ? ' AND s.status = ?' : ''} ORDER BY s.id DESC LIMIT 500`,
      pid, ...(month ? [month] : []), ...(status ? [status] : []),
    );
    const team = new Map((await db.all('SELECT id, name FROM users WHERE practice_id = ?', pid)).map((u) => [u.id, u.name]));
    res.json(rows
      // Everyone sees the praise; coaching notes (named in a low rating) are for the owner and manager.
      .filter((x) => manage || x.positive)
      .map((x) => ({
        ...x, candidates: x.candidate_ids ? JSON.parse(x.candidate_ids).map((id) => ({ id, name: team.get(id) || '?' })) : [],
        patient_name: manage && x.first_name ? `${x.first_name} ${x.last_name}` : null, first_name: undefined, last_name: undefined, patient_id: manage ? x.patient_id : undefined,
      })));
  });

  r.post('/reviews/shoutouts/:id/confirm', requirePermission('patients:read'), requireManage, async (req, res) => {
    const s = await findOr404(db, 'review_shoutouts', req.params.id, req.user.practice_id, 'Shout-out');
    const u = await staffMember(db, req.user.practice_id, req.body?.user_id ?? s.user_id);
    const pts = s.positive ? (await reviewSettings(db, req.user.practice_id)).points_per_mention : 0;
    await update(db, 'review_shoutouts', s.id, req.user.practice_id, {
      user_id: u.id, status: 'counted', points: s.status === 'counted' && s.user_id === u.id ? s.points : pts, decided_by: req.user.id,
      decided_at: new Date().toISOString().slice(0, 19).replace('T', ' '), decision_note: req.body?.note ? String(req.body.note).slice(0, 300) : null,
    });
    await audit(db, req, 'shoutout.confirm', 'review_shoutouts', s.id, { user_id: u.id, name: u.name, was: s.user_id, was_status: s.status });
    res.json(await db.get('SELECT * FROM review_shoutouts WHERE id = ?', s.id));
  });

  r.post('/reviews/shoutouts/:id/unlink', requirePermission('patients:read'), requireManage, async (req, res) => {
    const s = await findOr404(db, 'review_shoutouts', req.params.id, req.user.practice_id, 'Shout-out');
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (!reason) throw new HttpError(400, 'Say why (e.g. “a different Sam — the patient’s son”)');
    await update(db, 'review_shoutouts', s.id, req.user.practice_id, { status: 'unlinked', decided_by: req.user.id, decided_at: new Date().toISOString().slice(0, 19).replace('T', ' '), decision_note: reason });
    await audit(db, req, 'shoutout.unlink', 'review_shoutouts', s.id, { user_id: s.user_id, points: s.points }, { reason });
    res.json(await db.get('SELECT * FROM review_shoutouts WHERE id = ?', s.id));
  });

  // Reads everything again for names (after adding a nickname). Existing shout-outs are never counted twice.
  r.post('/reviews/shoutouts/rescan', requirePermission('patients:read'), requireManage, async (req, res) => {
    const pid = req.user.practice_id;
    await db.run('UPDATE reviews SET mentions_checked_at = NULL WHERE practice_id = ?', pid);
    let found = await scanReviews(db, pid);
    for (const f of await db.all('SELECT id FROM review_feedback WHERE practice_id = ? AND comment IS NOT NULL', pid)) found += (await feedbackMentions(db, f.id)).length;
    await audit(db, req, 'shoutout.rescan', 'practices', pid, { found });
    res.json({ found });
  });

  r.get('/reviews/leaderboard', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const month = MONTH.test(req.query.month || '') ? req.query.month : thisMonth();
    const rows = await db.all(
      `SELECT s.user_id, u.name, SUM(s.points) AS points, COUNT(*) AS mentions FROM review_shoutouts s JOIN users u ON u.id = s.user_id
       WHERE s.practice_id = ? AND s.month = ? AND s.status = 'counted' AND s.positive = 1 GROUP BY s.user_id, u.name ORDER BY SUM(s.points) DESC, COUNT(*) DESC, u.name`,
      pid, month,
    );
    const rewards = await db.all('SELECT user_id, note, id FROM review_rewards WHERE practice_id = ? AND month = ?', pid, month);
    const needs = await db.get("SELECT COUNT(*) AS n FROM review_shoutouts WHERE practice_id = ? AND status = 'needs_match'", pid);
    const s = await reviewSettings(db, pid);
    res.json({
      month, reward_note: s.reward_note, points_per_mention: s.points_per_mention, needs_match: Number(needs?.n || 0),
      rows: rows.map((x) => ({ ...x, points: Number(x.points), mentions: Number(x.mentions), reward: rewards.find((w) => w.user_id === x.user_id)?.note || null })),
    });
  });

  r.put('/reviews/rewards', requirePermission('patients:read'), requireManage, async (req, res) => {
    const pid = req.user.practice_id;
    const u = await staffMember(db, pid, req.body?.user_id);
    const month = String(req.body?.month || '');
    if (!MONTH.test(month)) throw new HttpError(400, 'Month is YYYY-MM');
    const note = String(req.body?.note || '').trim().slice(0, 300);
    if (!note) throw new HttpError(400, 'Write the reward (e.g. “$25 coffee card”)');
    const have = await db.get('SELECT * FROM review_rewards WHERE practice_id = ? AND user_id = ? AND month = ?', pid, u.id, month);
    let id = have?.id;
    if (have) await update(db, 'review_rewards', have.id, pid, { note, updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    else id = await insert(db, 'review_rewards', { practice_id: pid, user_id: u.id, month, note, created_by: req.user.id });
    await audit(db, req, 'shoutout.reward', 'review_rewards', id, { user_id: u.id, name: u.name, month }, { before: have ? { note: have.note } : null, after: { note } });
    res.json({ id, user_id: u.id, month, note });
  });

  return r;
}

// ---- RV2: the patient's page ----
export function reviewPublicRoutes({ db }) {
  const r = Router();
  const reader = rateLimit({ windowMs: 60_000, max: 120, name: 'review-read' });
  const writer = rateLimit({ windowMs: 3600_000, max: 60, name: 'review-write' });
  const logPublic = (req, practiceId, action, entityId, details) => audit(db, { ip: req.ip, user: { practice_id: practiceId, id: null } }, action, 'review_feedback', entityId, details);

  const reviewFor = async (token) => {
    const f = await db.get(
      `SELECT rf.*, p.first_name, p.last_name, p.language, pr.name AS practice_name, pr.phone AS practice_phone
       FROM review_feedback rf JOIN patients p ON p.id = rf.patient_id JOIN practices pr ON pr.id = rf.practice_id WHERE rf.token_hash = ?`, hashToken(String(token)),
    );
    if (!f) throw new HttpError(404, 'This link is not valid');
    if (new Date(`${f.sent_at.replace(' ', 'T')}Z`) < new Date(Date.now() - 30 * 86400_000)) throw new HttpError(410, 'This link has expired. Thank you anyway!');
    return f;
  };
  // Everyone gets the review sites (the small public link); happy ratings get the big invitation too.
  const view = async (f) => {
    const s = await reviewSettings(db, f.practice_id);
    const sites = reviewSites(s).map(({ key, name }) => ({ key, name }));
    const happy = f.rating != null && f.rating >= s.threshold;
    return {
      practice_name: f.practice_name, first_name: f.first_name, practice_phone: f.practice_phone, language: patientLang(f), threshold: s.threshold,
      rating: f.rating, comment: f.comment, happy, step: f.rating == null ? 'rate' : happy ? 'invite' : f.feedback_at ? 'thanks' : 'feedback',
      sites, public_review: sites[0] || null, review_link: sites.length > 0, feedback_sent: !!f.feedback_at, callback_wanted: !!f.callback_wanted,
    };
  };

  r.get('/review/:token', reader, async (req, res) => {
    const f = await reviewFor(req.params.token);
    if (!f.opened_at) await recorded(db, 'review_feedback', f.id, () => db.run("UPDATE review_feedback SET opened_at = COALESCE(opened_at, datetime('now')) WHERE id = ?", f.id));
    res.json(await view(f));
  });

  r.post('/review/:token', writer, async (req, res) => {
    const f = await reviewFor(req.params.token);
    const b = req.body || {};
    const s = await reviewSettings(db, f.practice_id);
    const rating = b.rating != null ? Number(b.rating) : f.rating;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'Choose 1 to 5 stars');
    const comment = b.comment != null ? String(b.comment).trim().slice(0, 2000) || null : f.comment;
    const callback = b.callback != null ? (b.callback ? 1 : 0) : f.callback_wanted;
    const callbackNote = b.callback_note != null ? String(b.callback_note).trim().slice(0, 200) || null : f.callback_note;
    const low = rating < s.threshold;
    const wrote = (b.comment != null && comment !== f.comment) || (b.callback != null && callback !== f.callback_wanted) || (b.callback_note != null && callbackNote !== f.callback_note);
    await recorded(db, 'review_feedback', f.id, () => db.run(
      `UPDATE review_feedback SET rating = ?, comment = ?, callback_wanted = ?, callback_note = ?, rated_at = COALESCE(rated_at, datetime('now')), responded_at = COALESCE(responded_at, datetime('now')),
         opened_at = COALESCE(opened_at, datetime('now')), feedback_at = ${low && wrote ? "COALESCE(feedback_at, datetime('now'))" : 'feedback_at'} WHERE id = ?`,
      rating, comment, callback, callbackNote, f.id,
    ));
    await logPublic(req, f.practice_id, wrote ? 'review.feedback' : 'review.rated', f.id, { patient_id: f.patient_id, rating, low, callback: !!callback });
    if (low && wrote) await raiseFeedback(db, f.id, 'feedback');
    else if (low && (f.rating == null || f.rating >= s.threshold || !f.task_id)) await raiseFeedback(db, f.id, 'rated');
    if (comment && comment !== f.comment) await feedbackMentions(db, f.id);
    res.json(await view(await reviewFor(req.params.token)));
  });

  // To a review site, through us so the office sees who went on to post. Open to every rating (no gating).
  r.get('/review/:token/go', reader, async (req, res) => {
    const f = await reviewFor(req.params.token);
    const sites = reviewSites(await reviewSettings(db, f.practice_id));
    const site = sites.find((x) => x.key === String(req.query.site || '')) || sites[0];
    if (!site) throw new HttpError(404, 'No review page');
    await recorded(db, 'review_feedback', f.id, () => db.run("UPDATE review_feedback SET went_to_review = 1, posted_click_at = COALESCE(posted_click_at, datetime('now')), posted_site = COALESCE(posted_site, ?) WHERE id = ?", site.name, f.id));
    await logPublic(req, f.practice_id, 'review.go', f.id, { patient_id: f.patient_id, site: site.name, rating: f.rating });
    res.redirect(302, site.url);
  });
  return r;
}
