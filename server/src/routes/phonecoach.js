import express, { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { requirePermission, HttpError, can } from '../auth.js';
import { twilioSignature } from './sms.js';
import { audit, findOr404, practiceNow, isRealDate, recorded, localNow, utcRange } from '../util.js';
import { withActor } from '../actor.js';
import { failed } from '../issues.js';
import { patientScope, canSeePatient } from '../officeaccess.js';
import { publish } from '../events.js';
import {
  COACH, canCoach, CALL_TYPES, CALL_TYPE_LABELS, NO_BOOK_REASONS, STARTER_PROTOCOLS, cleanSteps, ensureProtocols, phoneSettings, reviewCall, acknowledgeAlert,
  parseRequest, emptyRequest, alertRecipients, likelyNeed, nextOpenings, bookFromCall, wasBooked, hearSpeech, phoneMetrics, leaderboard, noBookStats, addDays, DEFAULT_DISCLOSURE,
} from '../phonecoach.js';
import { createCallScorer } from '../ai/callscore.js';
import { createLiveTranscription, playScript } from '../livecall.js';

// Phones: every call saved, linked and coached (PH1-PH7). Staff routes under /phones (plus the chart's call history),
// and the phone provider's live-transcription webhook. Scores and coaching are for coaching, never discipline:
// people see their own; everyone's needs the phones:coach permission (owners and office managers).
const coachOnly = (req, _res, next) => (canCoach(req.user) ? next() : next(new HttpError(403, `Missing permission: ${COACH}`)));
const adminOnly = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only administrators can do this')));
const idOf = (v, name) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be an id`); return n; };
const clean = (v, n = 500) => (v == null ? null : String(v).trim().slice(0, n) || null);

async function period(db, req, { maxDays = 366, dflt = 30 } = {}) {
  const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
  const to = req.query.to || today;
  const from = req.query.from || addDays(to, -(dflt - 1));
  if (!isRealDate(from) || !isRealDate(to)) throw new HttpError(400, 'from and to must be real dates (YYYY-MM-DD)');
  if (from > to) throw new HttpError(400, 'from must be on or before to');
  if ((Date.parse(to) - Date.parse(from)) / 86400_000 > maxDays) throw new HttpError(400, `Pick at most ${maxDays} days`);
  return { from, to };
}

// A call in this practice that this person may see (office restrictions follow the patient).
async function callFor(db, req, id) {
  const c = await findOr404(db, 'calls', id, req.user.practice_id, 'Call');
  if (c.patient_id && !(await canSeePatient(db, req.user, c.patient_id))) throw new HttpError(404, 'Call not found');
  return c;
}
const mineOrCoach = (req, call) => canCoach(req.user) || (call.agent_id && call.agent_id === req.user.id);

export default function phoneCoachRoutes({ db, config = {}, messenger = null, scorer, live } = {}) {
  const r = Router();
  scorer ??= createCallScorer({ config });
  live ??= createLiveTranscription({ config });
  const deps = { scorer, messenger, config };

  // ---- Settings (PH1, PH5, PH7) ----
  r.get('/phones/settings', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const st = await phoneSettings(db, pid);
    const practice = await db.get('SELECT record_calls FROM practices WHERE id = ?', pid);
    const team = await db.all("SELECT id, name, role FROM users WHERE practice_id = ? AND active = 1 AND role <> 'api' ORDER BY name", pid);
    res.json({
      ...st, record_calls: !!practice.record_calls, default_disclosure: DEFAULT_DISCLOSURE, team, can_coach: canCoach(req.user),
      live: live ? { mode: live.mode, label: live.label, sandbox: !!live.sandbox } : null, scorer: scorer ? { mode: scorer.mode, label: scorer.label } : null,
      call_types: CALL_TYPE_LABELS, no_book_reasons: NO_BOOK_REASONS,
    });
  });
  r.put('/phones/settings', adminOnly, async (req, res) => {
    const pid = req.user.practice_id;
    const b = req.body || {};
    const before = await phoneSettings(db, pid);
    const users = new Set((await db.all('SELECT id FROM users WHERE practice_id = ? AND active = 1', pid)).map((u) => u.id));
    const userList = (v, name) => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.length > 50) throw new HttpError(400, `${name} must be a list of people`);
      const list = [...new Set(v.map(Number))];
      if (list.some((id) => !users.has(id))) throw new HttpError(400, `${name}: everyone must be on this practice’s team`);
      return list;
    };
    const answerersList = userList(b.answerer_ids, 'answerer_ids');
    const alertList = userList(b.alert_user_ids, 'alert_user_ids');
    let sms;
    if (b.alert_sms_to !== undefined) {
      if (!Array.isArray(b.alert_sms_to) || b.alert_sms_to.length > 5) throw new HttpError(400, 'alert_sms_to: up to 5 mobile numbers');
      sms = b.alert_sms_to.map((n) => String(n).trim()).filter(Boolean);
      if (sms.some((n) => { const d = n.replace(/\D/g, ''); return !(d.length === 10 || (d.length === 11 && d.startsWith('1'))); })) throw new HttpError(400, 'alert_sms_to: US or Canadian mobile numbers only');
    }
    const num = (v, name, lo, hi) => { if (v === undefined) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${name} must be ${lo}-${hi}`); return n; };
    const target = num(b.missed_target_pct, 'missed_target_pct', 1, 100);
    const minCalls = num(b.missed_min_calls, 'missed_min_calls', 1, 500);
    const disclosure = b.recording_disclosure === undefined ? undefined : clean(b.recording_disclosure, 300);
    await db.run('INSERT INTO phone_settings (practice_id) VALUES (?) ON CONFLICT (practice_id) DO NOTHING', pid);
    const row = await db.get('SELECT id FROM phone_settings WHERE practice_id = ?', pid);
    const set = {};
    if (answerersList !== undefined) set.answerer_ids = JSON.stringify(answerersList);
    if (alertList !== undefined) set.alert_user_ids = JSON.stringify(alertList);
    if (sms !== undefined) set.alert_sms_to = JSON.stringify(sms);
    if (target !== undefined) set.missed_target_pct = target;
    if (minCalls !== undefined) set.missed_min_calls = minCalls;
    if (disclosure !== undefined) set.recording_disclosure = disclosure;
    if (b.live_transcription !== undefined) set.live_transcription = b.live_transcription ? 1 : 0;
    if (b.scoring !== undefined) set.scoring = b.scoring ? 1 : 0;
    if (Object.keys(set).length) {
      set.updated_by = req.user.id;
      set.updated_at = new Date().toISOString();
      await db.run(`UPDATE phone_settings SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(set), row.id);
    }
    // Recording is the practice's phone-line setting; changing it here is the same change, recorded.
    if (b.record_calls !== undefined) await recorded(db, 'practices', pid, () => db.run('UPDATE practices SET record_calls = ? WHERE id = ?', b.record_calls ? 1 : 0, pid));
    const after = await phoneSettings(db, pid);
    const { updated_at: _a, ...b0 } = before;
    const { updated_at: _b, ...a0 } = after;
    await audit(db, req, 'phone_settings.update', 'phone_settings', row.id, null, { before: { ...b0, answerer_ids: JSON.stringify(b0.answerer_ids), alert_user_ids: JSON.stringify(b0.alert_user_ids), alert_sms_to: JSON.stringify(b0.alert_sms_to) }, after: { ...a0, answerer_ids: JSON.stringify(a0.answerer_ids), alert_user_ids: JSON.stringify(a0.alert_user_ids), alert_sms_to: JSON.stringify(a0.alert_sms_to) } });
    res.json({ ...after, record_calls: !!(await db.get('SELECT record_calls FROM practices WHERE id = ?', pid)).record_calls });
  });

  // ---- Protocols (PH2) ----
  r.get('/phones/protocols', requirePermission('patients:read'), async (req, res) => {
    await ensureProtocols(db, req.user.practice_id);
    const rows = await db.all(`SELECT p.*, u.name AS updated_by_name FROM phone_protocols p LEFT JOIN users u ON u.id = COALESCE(p.updated_by, p.created_by) WHERE p.practice_id = ? AND (p.status = 'active' OR ? = 1) ORDER BY p.call_type, p.version DESC`, req.user.practice_id, req.query.all === '1' ? 1 : 0);
    res.json({ protocols: rows.map((p) => ({ ...p, steps: JSON.parse(p.steps), label: CALL_TYPE_LABELS[p.call_type] })), starters: STARTER_PROTOCOLS, call_types: CALL_TYPE_LABELS });
  });
  // An edit makes the next version (the one before is archived and kept: past scores point at it).
  r.put('/phones/protocols/:type', coachOnly, async (req, res) => {
    const pid = req.user.practice_id;
    const type = String(req.params.type);
    if (!CALL_TYPES.includes(type)) throw new HttpError(400, `Call type must be one of ${CALL_TYPES.join(', ')}`);
    const b = req.body || {};
    const steps = cleanSteps(b.reset ? STARTER_PROTOCOLS[type].steps : b.steps);
    const name = clean(b.reset ? STARTER_PROTOCOLS[type].name : b.name, 80);
    if (!name) throw new HttpError(400, 'Give the protocol a name');
    const philosophy = clean(b.reset ? STARTER_PROTOCOLS[type].philosophy : b.philosophy, 1000);
    await ensureProtocols(db, pid);
    const current = await db.get("SELECT * FROM phone_protocols WHERE practice_id = ? AND call_type = ? AND status = 'active'", pid, type);
    const id = await db.tx(async () => {
      if (current) await db.run("UPDATE phone_protocols SET status = 'archived', updated_by = ?, updated_at = ? WHERE id = ?", req.user.id, new Date().toISOString(), current.id);
      return (await db.run('INSERT INTO phone_protocols (practice_id, call_type, name, philosophy, steps, version, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        pid, type, name, philosophy, JSON.stringify(steps), (current?.version || 0) + 1, req.user.id, req.user.id)).id;
    });
    await audit(db, req, 'phone_protocol.update', 'phone_protocols', id, { call_type: type, version: (current?.version || 0) + 1, reset: !!b.reset }, {
      before: current ? { name: current.name, philosophy: current.philosophy, steps: current.steps } : {}, after: { name, philosophy, steps: JSON.stringify(steps) },
    });
    const row = await db.get('SELECT * FROM phone_protocols WHERE id = ?', id);
    res.json({ ...row, steps: JSON.parse(row.steps) });
  });

  // ---- Finding calls (PH1): by patient, staff member, date, kind of call and topic (words in the summary or transcript) ----
  r.get('/phones/calls', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const { from, to } = await period(db, req, { maxDays: 731, dflt: 90 });
    const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', pid))?.timezone || 'America/New_York';
    const [s0, s1] = await utcRange(db, pid, from, to);
    const where = ['c.practice_id = ?', 'c.created_at >= ?', 'c.created_at < ?'];
    const args = [pid, s0, s1];
    if (req.query.patient_id) { where.push('c.patient_id = ?'); args.push(idOf(req.query.patient_id, 'patient_id')); }
    if (req.query.agent_id) { where.push('c.agent_id = ?'); args.push(idOf(req.query.agent_id, 'agent_id')); }
    if (req.query.call_type) {
      if (!CALL_TYPES.includes(req.query.call_type)) throw new HttpError(400, 'Unknown call type');
      where.push('c.call_type = ?'); args.push(req.query.call_type);
    }
    if (req.query.reason) {
      if (!NO_BOOK_REASONS[req.query.reason]) throw new HttpError(400, 'Unknown reason');
      where.push('n.reason = ?'); args.push(req.query.reason);
    }
    if (req.query.missed === '1') where.push("c.desk_result IN ('missed','abandoned')");
    const q = clean(req.query.q, 80);
    if (q) {
      const like = `%${q.toLowerCase().replace(/[%_]/g, '')}%`;
      where.push('(LOWER(COALESCE(c.summary, \'\')) LIKE ? OR LOWER(COALESCE(c.transcript, \'\')) LIKE ? OR LOWER(COALESCE(c.notes, \'\')) LIKE ? OR LOWER(COALESCE(c.reason, \'\')) LIKE ?)');
      args.push(like, like, like, like);
    }
    if (req.location_id) { where.push('(c.location_id = ? OR c.location_id IS NULL)'); args.push(req.location_id); }
    const scope = patientScope(req.user);
    const rows = await db.all(
      `SELECT c.id, c.patient_id, c.direction, c.purpose, c.from_number, c.to_number, c.caller_name, c.outcome, c.desk_result, c.duration, c.summary, c.call_type, c.agent_id,
         c.appointment_id, c.created_at, c.recording_key IS NOT NULL AS has_recording, c.transcript IS NOT NULL AS has_transcript, p.first_name, p.last_name, u.name AS agent_name,
         n.reason AS no_book_reason, n.suggested_reason, s.score AS ai_score
       FROM calls c LEFT JOIN patients p ON p.id = c.patient_id LEFT JOIN users u ON u.id = c.agent_id LEFT JOIN call_no_book n ON n.call_id = c.id
       LEFT JOIN call_scores s ON s.call_id = c.id AND s.status = 'current'
       WHERE ${where.join(' AND ')}${scope.sql ? ` AND (c.patient_id IS NULL OR EXISTS (SELECT 1 FROM patients p WHERE p.id = c.patient_id${scope.sql}))` : ''}
       ORDER BY c.created_at DESC LIMIT 300`, ...args, ...scope.args,
    );
    const coach = canCoach(req.user);
    // Scores are coaching: someone else's call's score only for a coach.
    res.json({ from, to, timezone: tz, calls: rows.map((c) => ({ ...c, has_recording: !!c.has_recording, has_transcript: !!c.has_transcript, ai_score: coach || c.agent_id === req.user.id ? c.ai_score : undefined })) });
  });

  // The chart's call history: this patient's calls (and, with family=1, their household's), newest first.
  r.get('/patients/:pid/calls', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.pid, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const head = patient.guarantor_id || patient.id;
    const people = req.query.family === '1' ? (await db.all('SELECT id FROM patients WHERE practice_id = ? AND (id = ? OR guarantor_id = ?)', req.user.practice_id, head, head)).map((p) => p.id) : [patient.id];
    const rows = await db.all(
      `SELECT c.id, c.patient_id, c.direction, c.purpose, c.outcome, c.desk_result, c.duration, c.summary, c.notes, c.caller_name, c.call_type, c.agent_id, c.appointment_id, c.created_at,
         c.recording_key IS NOT NULL AS has_recording, c.transcript IS NOT NULL AS has_transcript, u.name AS agent_name, p.first_name, n.reason AS no_book_reason
       FROM calls c LEFT JOIN users u ON u.id = c.agent_id LEFT JOIN patients p ON p.id = c.patient_id LEFT JOIN call_no_book n ON n.call_id = c.id
       WHERE c.practice_id = ? AND c.patient_id IN (${people.map(() => '?').join(',')}) ORDER BY c.created_at DESC LIMIT 200`, req.user.practice_id, ...people,
    );
    res.json(rows.map((c) => ({ ...c, has_recording: !!c.has_recording, has_transcript: !!c.has_transcript })));
  });

  // ---- One call's coaching (PH3, PH4, PH5) ----
  r.get('/phones/calls/:cid/review', requirePermission('patients:read'), async (req, res) => {
    const call = await callFor(db, req, req.params.cid);
    const mine = mineOrCoach(req, call);
    const score = mine ? await db.get("SELECT * FROM call_scores WHERE call_id = ? AND status = 'current'", call.id) : null;
    const reviews = mine ? await db.all('SELECT r.id, r.rating, r.comment, r.created_at, u.name AS by_name FROM call_reviews r JOIN users u ON u.id = r.user_id WHERE r.call_id = ? ORDER BY r.id', call.id) : [];
    const noBook = await db.get('SELECT n.*, u.name AS confirmed_by_name FROM call_no_book n LEFT JOIN users u ON u.id = n.confirmed_by WHERE n.call_id = ?', call.id);
    const alerts = await db.all('SELECT a.*, u.name AS ack_by_name FROM phone_alerts a LEFT JOIN users u ON u.id = a.ack_by WHERE a.call_id = ? ORDER BY a.id', call.id);
    const agent = call.agent_id ? await db.get('SELECT id, name FROM users WHERE id = ?', call.agent_id) : null;
    const owner = reviews.filter((x) => x.rating != null).at(-1);
    if (score) await audit(db, req, 'call.review.view', 'calls', call.id, { patient_id: call.patient_id });
    res.json({
      call_id: call.id, call_type: call.call_type, agent, agent_source: call.agent_source, can_coach: canCoach(req.user), visible: mine,
      score: score ? { ...score, steps: JSON.parse(score.steps), label: `AI review (${score.model})` } : null,
      effective_score: owner ? owner.rating : score?.score ?? null, effective_by: owner ? 'owner' : score ? 'ai' : null,
      reviews, no_book: noBook, alerts, show_no_book: !!noBook || (call.direction === 'inbound' && call.call_type !== 'billing' && !!call.transcript && !(await wasBooked(db, call))), coaching_note: 'For coaching and training only — never used for discipline on its own.',
    });
  });
  r.post('/phones/calls/:cid/score', coachOnly, async (req, res) => {
    const call = await callFor(db, req, req.params.cid);
    if (!scorer) throw new HttpError(503, 'AI call scoring is off on this server');
    if (!(await phoneSettings(db, call.practice_id)).scoring) throw new HttpError(409, 'Call scoring is turned off in Phone settings');
    if (!call.transcript) throw new HttpError(409, 'This call has no transcript to score');
    const out = await reviewCall(db, deps, call.id, { force: true });
    if (out?.error) throw new HttpError(502, `The call couldn’t be scored: ${out.error}`);
    await audit(db, req, 'call.score', 'calls', call.id, { score: out?.score ?? null, patient_id: call.patient_id });
    res.json(out);
  });
  // The owner's or manager's own rating (0-100) and comments; the newest rating counts.
  r.post('/phones/calls/:cid/reviews', coachOnly, async (req, res) => {
    const call = await callFor(db, req, req.params.cid);
    const b = req.body || {};
    const rating = b.rating == null || b.rating === '' ? null : Number(b.rating);
    if (rating != null && (!Number.isInteger(rating) || rating < 0 || rating > 100)) throw new HttpError(400, 'rating must be 0-100');
    const comment = clean(b.comment, 2000);
    if (rating == null && !comment) throw new HttpError(400, 'Give a rating or a comment');
    const { id } = await db.run('INSERT INTO call_reviews (practice_id, call_id, user_id, rating, comment) VALUES (?, ?, ?, ?, ?)', call.practice_id, call.id, req.user.id, rating, comment);
    const prev = await db.get('SELECT rating FROM call_reviews WHERE call_id = ? AND rating IS NOT NULL AND id < ? ORDER BY id DESC LIMIT 1', call.id, id);
    const ai = await db.get("SELECT score FROM call_scores WHERE call_id = ? AND status = 'current'", call.id);
    await audit(db, req, 'call.rate', 'calls', call.id, { review_id: id, patient_id: call.patient_id }, rating != null ? { before: { rating: prev?.rating ?? ai?.score ?? null }, after: { rating } } : {});
    res.status(201).json(await db.get('SELECT * FROM call_reviews WHERE id = ?', id));
  });
  // "I've got this call" (from the call screen): who took it, for their numbers. The first person keeps it.
  r.post('/phones/calls/:cid/claim', requirePermission('patients:write'), async (req, res) => {
    const call = await callFor(db, req, req.params.cid);
    if (!call.agent_id) {
      await recorded(db, 'calls', call.id, () => db.run("UPDATE calls SET agent_id = ?, agent_source = 'claimed' WHERE id = ? AND agent_id IS NULL", req.user.id, call.id));
      await audit(db, req, 'call.claim', 'calls', call.id, { patient_id: call.patient_id });
    }
    const after = await db.get('SELECT id, agent_id, agent_source FROM calls WHERE id = ?', call.id);
    res.json({ ...after, mine: after.agent_id === req.user.id });
  });
  // A manager corrects who took a call.
  r.put('/phones/calls/:cid/agent', coachOnly, async (req, res) => {
    const call = await callFor(db, req, req.params.cid);
    const userId = req.body?.user_id == null ? null : idOf(req.body.user_id, 'user_id');
    if (userId) await findOr404(db, 'users', userId, req.user.practice_id, 'Team member');
    await recorded(db, 'calls', call.id, () => db.run("UPDATE calls SET agent_id = ?, agent_source = 'manager' WHERE id = ?", userId, call.id));
    await audit(db, req, 'call.agent', 'calls', call.id, { patient_id: call.patient_id }, { before: { agent_id: call.agent_id }, after: { agent_id: userId }, reason: clean(req.body?.reason, 300) });
    res.json(await db.get('SELECT id, agent_id, agent_source FROM calls WHERE id = ?', call.id));
  });

  // ---- Why they didn't book (PH4) ----
  r.post('/phones/calls/:cid/no-book', requirePermission('patients:write'), async (req, res) => {
    const call = await callFor(db, req, req.params.cid);
    const reason = String(req.body?.reason || '');
    if (!NO_BOOK_REASONS[reason]) throw new HttpError(400, `reason must be one of ${Object.keys(NO_BOOK_REASONS).join(', ')}`);
    const note = clean(req.body?.note, 500);
    if (reason === 'other' && !note) throw new HttpError(400, 'Say in a few words why, for “other”');
    const before = await db.get('SELECT * FROM call_no_book WHERE call_id = ?', call.id);
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO call_no_book (practice_id, call_id, patient_id, reason, note, confirmed_by, confirmed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (call_id) DO UPDATE SET reason = excluded.reason, note = excluded.note, confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at, updated_at = excluded.updated_at`,
      call.practice_id, call.id, call.patient_id, reason, note, req.user.id, now, now,
    );
    const row = await db.get('SELECT * FROM call_no_book WHERE call_id = ?', call.id);
    await audit(db, req, before?.reason ? 'call.no_book.change' : 'call.no_book.confirm', 'call_no_book', row.id, { call_id: call.id, patient_id: call.patient_id, suggested: before?.suggested_reason ?? null, agreed_with_ai: before?.suggested_reason === reason },
      { before: { reason: before?.reason ?? null, note: before?.note ?? null }, after: { reason, note }, patientId: call.patient_id });
    publish(call.practice_id, { type: 'call', event: 'no_book', call_id: call.id });
    res.json(row);
  });
  // Calls waiting for someone to confirm the reason (the AI's suggestion shown, one click to confirm).
  r.get('/phones/no-book/pending', requirePermission('patients:read'), async (req, res) => {
    const scope = patientScope(req.user);
    const rows = await db.all(
      `SELECT n.*, c.created_at AS call_at, c.from_number, c.caller_name, c.summary, c.call_type, p.first_name, p.last_name FROM call_no_book n JOIN calls c ON c.id = n.call_id LEFT JOIN patients p ON p.id = n.patient_id
       WHERE n.practice_id = ? AND n.reason IS NULL${scope.sql ? ` AND (n.patient_id IS NULL OR EXISTS (SELECT 1 FROM patients p WHERE p.id = n.patient_id${scope.sql}))` : ''} ORDER BY c.created_at DESC LIMIT 100`,
      req.user.practice_id, ...scope.args,
    );
    res.json(rows);
  });
  r.get('/phones/no-book', (req, res, next) => (canCoach(req.user) || can(req.user, 'reports:read') ? next() : next(new HttpError(403, `Missing permission: ${COACH}`))), async (req, res) => {
    const { from, to } = await period(db, req, { dflt: 90, maxDays: 731 });
    res.json(await noBookStats(db, req.user.practice_id, { from, to }));
  });

  // ---- Alerts (PH5, PH7) ----
  const seesAlerts = async (req) => canCoach(req.user) || (await alertRecipients(db, req.user.practice_id)).users.some((u) => u.id === req.user.id);
  r.get('/phones/alerts', requirePermission('patients:read'), async (req, res) => {
    if (!(await seesAlerts(req))) throw new HttpError(403, `Missing permission: ${COACH}`);
    const status = req.query.status === 'all' ? null : 'open';
    const rows = await db.all(
      `SELECT a.*, p.first_name, p.last_name, c.from_number, c.created_at AS call_at, u.name AS ack_by_name FROM phone_alerts a LEFT JOIN patients p ON p.id = a.patient_id
       LEFT JOIN calls c ON c.id = a.call_id LEFT JOIN users u ON u.id = a.ack_by WHERE a.practice_id = ?${status ? ' AND a.status = ?' : ''} ORDER BY a.id DESC LIMIT 200`,
      req.user.practice_id, ...(status ? [status] : []),
    );
    const scope = [];
    for (const a of rows) if (!a.patient_id || await canSeePatient(db, req.user, a.patient_id)) scope.push(a);
    res.json(scope);
  });
  r.post('/phones/alerts/:aid/ack', requirePermission('patients:read'), async (req, res) => {
    if (!(await seesAlerts(req))) throw new HttpError(403, `Missing permission: ${COACH}`);
    res.json(await acknowledgeAlert(db, req, idOf(req.params.aid, 'alert id'), req.body?.note));
  });

  // ---- The numbers and the leaderboard (PH3, PH7) ----
  r.get('/phones/metrics', requirePermission('patients:read'), async (req, res) => {
    const { from, to } = await period(db, req);
    const m = await phoneMetrics(db, req.user.practice_id, { from, to });
    const coach = canCoach(req.user);
    if (coach) return res.json({ ...m, scope: 'team' });
    // Everyone else sees their own numbers; practice-wide missed-call patterns with the reports permission.
    const own = m.people.find((p) => p.user_id === req.user.id) || null;
    const practiceWide = can(req.user, 'reports:read') ? { totals: m.totals, by_day: m.by_day, by_hour: m.by_hour, heatmap: m.heatmap, by_line: m.by_line } : {};
    res.json({ from, to, timezone: m.timezone, scope: 'own', people: own ? [own] : [], ...practiceWide });
  });
  r.get('/phones/leaderboard', requirePermission('patients:read'), async (req, res) => {
    const { from, to } = await period(db, req);
    const m = await phoneMetrics(db, req.user.practice_id, { from, to });
    const board = leaderboard(m.people);
    const note = 'Coaching, not discipline: scores are the AI’s read against your protocols (or an owner’s rating) and are meant for training.';
    if (canCoach(req.user)) return res.json({ from, to, scope: 'team', rows: board, totals: m.totals, note });
    const mine = board.find((p) => p.user_id === req.user.id) || null;
    res.json({ from, to, scope: 'own', rows: mine ? [mine] : [], team_size: board.length, note });
  });

  // ---- The call screen (PH6) ----
  r.get('/phones/live', requirePermission('patients:read'), async (req, res) => {
    const st = await phoneSettings(db, req.user.practice_id);
    res.json({ realtime: !!live && (live.sandbox || st.live_transcription), mode: live?.mode || null, sandbox: !!live?.sandbox, label: live?.label || null });
  });
  // What the caller likely needs and the next open times for it, filtered by what they've asked for (the live
  // transcript's request, or the quick filter row: weekdays=4,5 part=am|pm provider_ids=3 asap=1, or q=free words).
  r.get('/phones/calls/:cid/openings', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const call = await callFor(db, req, req.params.cid);
    const patientId = req.query.patient_id ? idOf(req.query.patient_id, 'patient_id') : call.patient_id;
    const patient = patientId ? await findOr404(db, 'patients', patientId, pid, 'Patient') : null;
    if (patient && !(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', pid))?.timezone || 'America/New_York';
    const today = localNow(tz).slice(0, 10);
    const providers = await db.all('SELECT id, name FROM providers WHERE practice_id = ? AND active = 1', pid);
    const said = (await db.all("SELECT text FROM call_segments WHERE call_id = ? AND track = 'caller' ORDER BY seq", call.id)).map((x) => x.text).join(' ');
    let request = parseRequest([said, clean(req.query.q, 300) || ''].join(' '), { today, providers });
    const list = (v) => String(v || '').split(',').filter(Boolean).map(Number);
    if (req.query.weekdays) { const w = list(req.query.weekdays); if (w.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HttpError(400, 'weekdays are 0 (Sunday) to 6'); request.weekdays = w; }
    if (req.query.part) { if (!['am', 'pm', 'any'].includes(req.query.part)) throw new HttpError(400, 'part is am or pm'); request.part = req.query.part === 'any' ? null : req.query.part; }
    if (req.query.provider_ids) { const ids = list(req.query.provider_ids); if (ids.some((id) => !providers.some((p) => p.id === id))) throw new HttpError(404, 'Provider not found'); request.provider_ids = ids; }
    if (req.query.asap) request.asap = req.query.asap === '1';
    const need = await likelyNeed(db, pid, { patient, call });
    if (req.query.need_duration) { const d = Number(req.query.need_duration); if (Number.isInteger(d) && d >= 10 && d <= 240) need.duration = d; }
    const { providers: pool, slots } = await nextOpenings(db, pid, { need, request: emptyRequest(request) ? null : request, days: request.asap ? 7 : 28, locationId: req.location_id ?? null });
    const shown = request.asap ? slots.slice(0, 6) : slots.slice(0, 12);
    res.json({ patient: patient ? { id: patient.id, first_name: patient.first_name, last_name: patient.last_name, preferred_name: patient.preferred_name } : null, need, request, slots: shown, providers: pool, all_providers: providers, today });
  });
  r.post('/phones/calls/:cid/book', requirePermission('schedule:write'), async (req, res) => {
    const call = await callFor(db, req, req.params.cid);
    const b = req.body || {};
    const patientId = b.patient_id ? idOf(b.patient_id, 'patient_id') : call.patient_id;
    if (!patientId) throw new HttpError(400, 'Attach the caller to a patient (or add them) first');
    if (!(await canSeePatient(db, req.user, patientId))) throw new HttpError(404, 'Patient not found');
    await findOr404(db, 'providers', idOf(b.provider_id, 'provider_id'), req.user.practice_id, 'Provider');
    const out = await bookFromCall(db, req, call, { ...b, patient_id: patientId });
    res.status(out.repeat ? 200 : 201).json(out);
  });
  // The current request heard on a call (for a screen opened mid-call).
  r.get('/phones/calls/:cid/request', requirePermission('patients:read'), async (req, res) => {
    const call = await callFor(db, req, req.params.cid);
    const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', call.practice_id))?.timezone || 'America/New_York';
    const providers = await db.all('SELECT id, name FROM providers WHERE practice_id = ? AND active = 1', call.practice_id);
    const said = (await db.all("SELECT text FROM call_segments WHERE call_id = ? AND track = 'caller' ORDER BY seq", call.id)).map((x) => x.text).join(' ');
    res.json({ call_id: call.id, call_type: call.call_type, request: parseRequest(said, { today: localNow(tz).slice(0, 10), providers }) });
  });
  // Sandbox only: play phrases into a call as the provider's live transcription would (demos and tests).
  r.post('/phones/calls/:cid/sandbox-speech', requirePermission('patients:write'), async (req, res) => {
    if (!live?.sandbox) throw new HttpError(404, 'Not found');
    const call = await callFor(db, req, req.params.cid);
    const b = req.body || {};
    const script = Array.isArray(b.script) ? b.script.slice(0, 20).map((x) => ({ track: x.track === 'office' ? 'office' : 'caller', text: String(x.text || '').slice(0, 500) }))
      : b.text ? [{ track: b.track === 'office' ? 'office' : 'caller', text: String(b.text).slice(0, 500) }] : live.script;
    const delayMs = Math.min(1000, Math.max(0, Number(b.delay_ms) || 0));
    const hear = (x) => withActor({ source: 'integration', actor: 'Live transcription (sandbox)', practiceId: call.practice_id }, () => hearSpeech(db, deps, call, x));
    if (!delayMs) {
      await playScript(hear, script);
      return res.json({ played: script.length });
    }
    playScript(hear, script, { delayMs }).catch(failed(db, { practiceId: call.practice_id, kind: 'phones', key: `live-sandbox:${call.id}`, role: 'admin', title: 'The sandbox live transcription stopped' }));
    res.status(202).json({ playing: script.length });
  });
  return r;
}

// The phone provider's live transcription for a call (Twilio Real-Time Transcription posts each phrase here).
export function phoneCoachWebhooks({ db, config = {}, messenger = null, live, scorer } = {}) {
  const r = Router();
  live ??= createLiveTranscription({ config });
  scorer ??= createCallScorer({ config });
  const form = express.urlencoded({ extended: false, limit: '64kb' });
  const signed = (req) => {
    if (!config.twilioAuthToken) return false;
    const expected = Buffer.from(twilioSignature(config.twilioAuthToken, `${config.appUrl}${req.originalUrl}`, req.body));
    const given = Buffer.from(String(req.headers['x-twilio-signature'] || ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  r.post('/api/webhooks/twilio/voice/transcription', form, async (req, res) => {
    if (!signed(req)) return res.status(403).end();
    const call = await db.get('SELECT * FROM calls WHERE id = ?', Number(req.query.call));
    // The callback must belong to the call it names (Twilio sends the CallSid): no writing into someone else's call.
    if (!call || !live || (call.provider_id && req.body.CallSid && String(req.body.CallSid) !== call.provider_id)) return res.status(204).end();
    const phrase = live.parse(req.body);
    if (phrase) {
      await withActor({ source: 'integration', actor: 'Live transcription', practiceId: call.practice_id }, () => hearSpeech(db, { scorer, messenger, config }, call, phrase))
        .catch(failed(db, { practiceId: call.practice_id, kind: 'phones', key: `live-transcription:${call.practice_id}`, role: 'admin', title: 'Live call transcription stopped working' }));
    }
    res.status(204).end();
  });
  return r;
}
