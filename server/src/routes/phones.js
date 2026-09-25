import express, { Router } from 'express';
import { raiseIssue, resolveIssue, failed } from '../issues.js';
import { timingSafeEqual } from 'node:crypto';
import { twilioSignature, textable } from './sms.js';
import { requirePermission, HttpError } from '../auth.js';
import { insert, practiceNow, audit, findOr404, recorded } from '../util.js';
import { publish } from '../events.js';
import { patientScope, canSeePatient } from '../officeaccess.js';
import { practiceForNumber, patientForNumber, callerCard, isOpenNow, textBack, processRecording, summarizeCall, receptionistTurn } from '../phones.js';
import { aiClient } from '../ai.js';
import { phoneSettings, DEFAULT_DISCLOSURE, answerers, shiftIndex } from '../phonecoach.js';
import { createLiveTranscription } from '../livecall.js';
import { utcToLocal } from '../timeclock.js';

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const twiml = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
const say = (text) => `<Say voice="Polly.Joanna-Neural">${xml(text)}</Say>`;
// Work done after answering Twilio; a failure becomes a Needs-attention item for the practice.
const laterFor = (db) => (label, fn, practiceId) => setImmediate(() => fn().catch((err) => raiseIssue(db, { practiceId, kind: 'integration', key: `phone:${label}`, role: 'front_desk', title: `Phone line: ${label} failed`, detail: err.message })));

// An answered call nobody claimed on screen goes to the one person who answers phones and was on shift then.
async function attributeAgent(db, call) {
  const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', call.practice_id))?.timezone || 'America/New_York';
  const local = utcToLocal(tz, Date.parse(`${String(call.created_at).replace(' ', 'T')}Z`));
  const { answerers: team } = await answerers(db, call.practice_id);
  const ids = new Set(team.map((u) => u.id));
  const onShift = (await shiftIndex(db, call.practice_id, local.slice(0, 10), local.slice(0, 10)))(local).filter((id) => ids.has(id));
  if (onShift.length === 1) await db.run("UPDATE calls SET agent_id = ?, agent_source = 'shift' WHERE id = ? AND agent_id IS NULL", onShift[0], call.id);
}

// Twilio's webhooks for the office line. Point the number's "A call comes in" at /api/webhooks/twilio/voice/inbound
// and its call status callback at /api/webhooks/twilio/call-status.
export function phoneWebhooks({ db, config, messenger, storage, transcriber, fetchImpl }) {
  const r = Router();
  const form = express.urlencoded({ extended: false, limit: '64kb' });
  const signed = (req) => {
    if (!config.twilioAuthToken) return false;
    const expected = Buffer.from(twilioSignature(config.twilioAuthToken, `${config.appUrl}${req.originalUrl}`, req.body));
    const given = Buffer.from(String(req.headers['x-twilio-signature'] || ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const later = laterFor(db);
  const live = createLiveTranscription({ config });
  const guard = (req, res, next) => (signed(req) ? next() : res.status(403).type('text/xml').send(twiml('')));
  const url = (path) => xml(`${config.appUrl}/api/webhooks/twilio/voice/${path}`);
  const callOf = (req) => db.get('SELECT * FROM calls WHERE id = ?', Number(req.query.call));
  const send = (res, body) => res.type('text/xml').send(twiml(body));

  const receptionist = (practice) => practice.ai_receptionist && practice.ai_receptionist !== 'off' && !!aiClient(config);
  const greetAi = (call) => `<Redirect method="POST">${url(`ai?call=${call.id}`)}</Redirect>`;
  const voicemail = (practice, call) => say(practice.voicemail_greeting || `You've reached ${practice.name}. We can't take your call right now. Please leave a message after the tone and we'll call you back.`)
    + `<Record maxLength="120" playBeep="true" transcribe="true" transcribeCallback="${url(`voicemail-text?call=${call.id}`)}" recordingStatusCallback="${url(`recording?call=${call.id}`)}" action="${url(`voicemail-done?call=${call.id}`)}"/>`;

  r.post('/api/webhooks/twilio/voice/inbound', form, guard, async (req, res) => {
    const practice = await practiceForNumber(db, req.body.To);
    if (!practice) return send(res, say('Sorry, this number is not in service.') + '<Hangup/>');
    const from = String(req.body.From || '');
    const patient = await patientForNumber(db, practice.id, from);
    // A resent webhook for a call already under way continues it rather than logging a second call.
    const again = req.body.CallSid ? await db.get("SELECT id FROM calls WHERE provider_id = ? AND direction = 'inbound'", String(req.body.CallSid)) : null;
    if (again) return send(res, practice.forward_to ? `<Dial timeout="${Math.min(60, Math.max(5, practice.ring_seconds || 20))}" action="${url(`dial-done?call=${again.id}`)}">${/^sip:/i.test(practice.forward_to) ? `<Sip>${xml(practice.forward_to)}</Sip>` : `<Number>${xml(practice.forward_to)}</Number>`}</Dial>` : `<Redirect method="POST">${url(`ai?call=${again.id}`)}</Redirect>`);
    const tracked = (await db.all('SELECT number, source FROM tracking_numbers WHERE practice_id = ? AND active = 1', practice.id)).find((t) => t.number.replace(/\D/g, '').slice(-10) === String(req.body.To || '').replace(/\D/g, '').slice(-10));
    // Linked by the number (only patients of this practice, never archived ones); a number a family shares links to
    // the account holder, and the screen asks who's calling.
    const sharing = patient ? (await db.all("SELECT phone FROM patients WHERE practice_id = ? AND status != 'archived' AND phone IS NOT NULL AND phone LIKE ?", practice.id, `%${tail10(from).slice(-4)}`)).filter((x) => tail10(x.phone) === tail10(from)).length : 0;
    const id = await insert(db, 'calls', {
      source: tracked?.source ?? null, new_caller: patient ? 0 : 1, linked_via: patient ? (sharing > 1 ? 'family_number' : 'number') : null,
      practice_id: practice.id, patient_id: patient?.id ?? null, direction: 'inbound', purpose: 'inbound', from_number: from, to_number: String(req.body.To || ''),
      provider_id: String(req.body.CallSid || '') || null, status: 'ringing', caller_name: req.body.CallerName || null,
    });
    const call = await db.get('SELECT * FROM calls WHERE id = ?', id);
    // The screen pop: every open screen at the office sees who's calling.
    publish(practice.id, { type: 'call', event: 'ringing', call_id: id, from, patient: patient ? { id: patient.id, name: `${patient.first_name} ${patient.last_name}` } : null });
    const now = await practiceNow(db, practice.id);
    const open = isOpenNow(practice, now);
    const ai = receptionist(practice);
    if ((!open && ai && ['after_hours', 'always'].includes(practice.ai_receptionist)) || (ai && practice.ai_receptionist === 'always')) {
      await db.run("UPDATE calls SET purpose = 'receptionist' WHERE id = ?", id);
      return send(res, greetAi(call));
    }
    if (!open || !practice.forward_to) {
      if (!open) {
        await db.run("UPDATE calls SET outcome = 'after_hours' WHERE id = ?", id);
        later('text-back', () => textBack(db, messenger, call, practice, config.appUrl), practice.id);
      }
      if (!ai) return send(res, voicemail(practice, call));
      await db.run("UPDATE calls SET purpose = 'receptionist' WHERE id = ?", id);
      return send(res, greetAi(call));
    }
    // Ring the office; recorded (both sides, on separate channels) when the practice records calls.
    const rec = practice.record_calls ? ` record="record-from-answer-dual" recordingStatusCallback="${url(`recording?call=${id}`)}"` : '';
    // The recording disclosure the office wrote (Settings → Phones), before anyone picks up; and live transcription
    // for the call screen when the provider supports it and the office turned it on.
    const phone = await phoneSettings(db, practice.id);
    const listen = live && !live.sandbox && phone.live_transcription ? live.twiml(`${config.appUrl}/api/webhooks/twilio/voice/transcription?call=${id}`) : '';
    send(res, listen + (practice.record_calls ? say(phone.recording_disclosure || DEFAULT_DISCLOSURE) : '')
      + `<Dial timeout="${Math.min(60, Math.max(5, practice.ring_seconds || 20))}" action="${url(`dial-done?call=${id}`)}"${rec}>${/^sip:/i.test(practice.forward_to) ? `<Sip>${xml(practice.forward_to)}</Sip>` : `<Number>${xml(practice.forward_to)}</Number>`}</Dial>`);
  });

  // The office phone rang out: text the caller back, then the AI receptionist or voicemail.
  r.post('/api/webhooks/twilio/voice/dial-done', form, guard, async (req, res) => {
    const call = await callOf(req);
    if (!call) return send(res, '<Hangup/>');
    const status = String(req.body.DialCallStatus || '');
    // How long it rang before someone answered (the dial ends after the conversation: total time less talk time).
    const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(`${String(call.created_at).replace(' ', 'T')}Z`)) / 1000));
    if (status === 'completed' || status === 'answered') {
      const talk = Number(req.body.DialCallDuration) || 0;
      const ring = Math.max(0, elapsed - talk);
      await db.run("UPDATE calls SET status = 'completed', outcome = 'answered', desk_result = 'answered', ring_seconds = ?, answered_at = ?, duration = ?, ended_at = datetime('now') WHERE id = ?",
        ring, new Date(Date.parse(`${String(call.created_at).replace(' ', 'T')}Z`) + ring * 1000).toISOString().slice(0, 19).replace('T', ' '), talk || null, call.id);
      // Who took it: whoever claimed it on screen; else, when only one person who answers phones was on shift, them.
      if (!call.agent_id) later('who answered', () => attributeAgent(db, call), call.practice_id);
      publish(call.practice_id, { type: 'call', event: 'ended', call_id: call.id });
      return send(res, '<Hangup/>');
    }
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', call.practice_id);
    // The caller hung up while it rang ("canceled") is an abandoned call; otherwise it rang out.
    await db.run("UPDATE calls SET outcome = 'missed', desk_result = ?, ring_seconds = ? WHERE id = ?", status === 'canceled' ? 'abandoned' : 'missed', elapsed, call.id);
    publish(call.practice_id, { type: 'call', event: 'missed', call_id: call.id });
    later('text-back', () => textBack(db, messenger, call, practice, config.appUrl), practice.id);
    if (receptionist(practice) && ['missed', 'always'].includes(practice.ai_receptionist)) {
      await db.run("UPDATE calls SET purpose = 'receptionist' WHERE id = ?", call.id);
      return send(res, greetAi(call));
    }
    send(res, voicemail(practice, call));
  });

  r.post('/api/webhooks/twilio/voice/voicemail-done', form, guard, async (req, res) => {
    const call = await callOf(req);
    if (call) await db.run("UPDATE calls SET outcome = 'voicemail', duration = COALESCE(?, duration) WHERE id = ?", Number(req.body.RecordingDuration) || null, call.id);
    send(res, say('Thank you. Goodbye.') + '<Hangup/>');
  });
  r.post('/api/webhooks/twilio/voice/voicemail-text', form, guard, async (req, res) => {
    const call = await callOf(req);
    if (call && req.body.TranscriptionText) {
      await db.run('UPDATE calls SET transcript = COALESCE(transcript, ?) WHERE id = ?', `Caller (voicemail): ${String(req.body.TranscriptionText).slice(0, 8000)}`, call.id);
      later('call summary', () => summarizeCall(db, config, call.id), call.practice_id);
    }
    res.status(204).end();
  });
  r.post('/api/webhooks/twilio/voice/recording', form, guard, async (req, res) => {
    const call = await callOf(req);
    if (call && req.body.RecordingUrl && (req.body.RecordingStatus || 'completed') === 'completed') {
      later('recording', () => processRecording(db, { storage, transcriber, config, fetchImpl, messenger }, call.id, String(req.body.RecordingUrl)), call.practice_id);
    }
    res.status(204).end();
  });

  // The AI receptionist: listen, answer, repeat.
  const gather = (call, text) => `<Gather input="speech" speechTimeout="auto" language="en-US" action="${url(`ai/turn?call=${call.id}`)}" method="POST">${say(text)}</Gather>`
    + `<Redirect method="POST">${url(`ai/turn?call=${call.id}&silent=1`)}</Redirect>`;
  r.post('/api/webhooks/twilio/voice/ai', form, guard, async (req, res) => {
    const call = await callOf(req);
    if (!call) return send(res, '<Hangup/>');
    const { say: text, hangup } = await receptionistTurn(db, config, call.id, null);
    send(res, hangup ? say(text) + '<Hangup/>' : gather(call, text));
  });
  r.post('/api/webhooks/twilio/voice/ai/turn', form, guard, async (req, res) => {
    const call = await callOf(req);
    if (!call) return send(res, '<Hangup/>');
    const heard = String(req.body.SpeechResult || '').trim();
    const silences = JSON.parse(call.ai_turns || '[]').filter((t) => t.role === 'caller' && t.text === '(silence)').length;
    if (!heard && silences >= 1) {
      await db.run("UPDATE calls SET outcome = COALESCE(outcome, 'hung_up') WHERE id = ?", call.id);
      later('call summary', () => summarizeCall(db, config, call.id), call.practice_id);
      return send(res, say('I didn’t catch that. Please call back anytime. Goodbye.') + '<Hangup/>');
    }
    const { say: text, hangup } = await receptionistTurn(db, config, call.id, heard || '(silence)');
    if (hangup) {
      await db.run("UPDATE calls SET status = 'completed', outcome = COALESCE(outcome, 'handled'), ended_at = datetime('now') WHERE id = ?", call.id);
      later('call summary', () => summarizeCall(db, config, call.id), call.practice_id);
      return send(res, say(text) + '<Hangup/>');
    }
    send(res, gather(call, text));
  });
  return r;
}

const tail10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only administrators can do this')));

// Staff: the call log, playing a recording, and the caller card for the screen pop.
export default function phoneRoutes({ db, storage }) {
  const r = Router();
  r.get('/calls', requirePermission('patients:read'), async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const where = ['c.practice_id = ?', 'c.created_at >= ?'];
    const args = [req.user.practice_id, since];
    if (req.query.patient_id) { where.push('c.patient_id = ?'); args.push(Number(req.query.patient_id)); }
    if (req.query.direction) { where.push('c.direction = ?'); args.push(String(req.query.direction)); }
    if (req.location_id) { where.push('(c.location_id = ? OR c.location_id IS NULL)'); args.push(req.location_id); }
    if (req.query.filter === 'missed') where.push("c.outcome IN ('missed','voicemail','after_hours','hung_up')");
    if (req.query.filter === 'follow_up') where.push('c.follow_up = 1 AND c.handled_at IS NULL');
    const rows = await db.all(
      `SELECT c.id, c.patient_id, c.direction, c.purpose, c.from_number, c.to_number, c.caller_name, c.status, c.outcome, c.duration, c.summary, c.reason, c.follow_up,
         c.handled_at, c.texted_back_at, c.created_at, c.ended_at, c.recording_key IS NOT NULL AS has_recording, c.transcript IS NOT NULL AS has_transcript,
         p.first_name, p.last_name, u.name AS handled_by_name
       FROM calls c LEFT JOIN patients p ON p.id = c.patient_id LEFT JOIN users u ON u.id = c.handled_by
       WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT 500`, ...args,
    );
    const stats = await db.get(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
         SUM(CASE WHEN outcome IN ('missed','voicemail','after_hours','hung_up') THEN 1 ELSE 0 END) AS missed,
         SUM(CASE WHEN purpose = 'receptionist' THEN 1 ELSE 0 END) AS ai_answered, SUM(CASE WHEN outcome IN ('booked','requested') THEN 1 ELSE 0 END) AS ai_booked,
         SUM(CASE WHEN texted_back_at IS NOT NULL THEN 1 ELSE 0 END) AS texted_back
       FROM calls WHERE practice_id = ? AND created_at >= ?`, req.user.practice_id, since,
    );
    res.json({ calls: rows, stats });
  });
  // ---- Call tracking ----
  r.get('/tracking-numbers', requirePermission('reports:read'), async (req, res) => res.json(await db.all('SELECT * FROM tracking_numbers WHERE practice_id = ? ORDER BY source', req.user.practice_id)));
  r.post('/tracking-numbers', requireAdmin, async (req, res) => {
    const number = String(req.body?.number || '').trim();
    const source = String(req.body?.source || '').trim().slice(0, 80);
    if (number.replace(/\D/g, '').length < 10 || !source) throw new HttpError(400, 'A phone number and the source it’s used for are required');
    const id = await insert(db, 'tracking_numbers', { practice_id: req.user.practice_id, number, source, monthly_cost: Math.max(0, Math.round(Number(req.body.monthly_cost || 0) * 100)) });
    res.status(201).json(await db.get('SELECT * FROM tracking_numbers WHERE id = ?', id));
  });
  r.put('/tracking-numbers/:tid', requireAdmin, async (req, res) => {
    const t = await findOr404(db, 'tracking_numbers', req.params.tid, req.user.practice_id, 'Tracking number');
    await db.run('UPDATE tracking_numbers SET source = COALESCE(?, source), monthly_cost = COALESCE(?, monthly_cost), active = COALESCE(?, active) WHERE id = ?',
      req.body.source ? String(req.body.source).slice(0, 80) : null, req.body.monthly_cost != null ? Math.max(0, Math.round(Number(req.body.monthly_cost) * 100)) : null, req.body.active != null ? (req.body.active ? 1 : 0) : null, t.id);
    res.json(await db.get('SELECT * FROM tracking_numbers WHERE id = ?', t.id));
  });
  // Which sources bring calls, new patients and production — and what each costs per new patient.
  r.get('/calls/sources', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const days = Math.min(730, Math.max(7, Number(req.query.days) || 90));
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const calls = await db.all("SELECT id, from_number, source, outcome, new_caller, created_at FROM calls WHERE practice_id = ? AND direction = 'inbound' AND created_at >= ? ORDER BY id", pid, since);
    const patients = await db.all("SELECT id, phone, created_at FROM patients WHERE practice_id = ? AND created_at >= ? AND phone IS NOT NULL", pid, since);
    const tail = (s) => String(s || '').replace(/\D/g, '').slice(-10);
    const firstCall = new Map();
    for (const c of calls) if (c.new_caller && !firstCall.has(tail(c.from_number))) firstCall.set(tail(c.from_number), c);
    const rows = new Map();
    const row = (source) => {
      if (!rows.has(source)) rows.set(source, { source, calls: 0, missed: 0, new_callers: new Set(), new_patients: [], production: 0 });
      return rows.get(source);
    };
    for (const c of calls) {
      const r0 = row(c.source || 'Main number');
      r0.calls++;
      if (['missed', 'voicemail', 'after_hours', 'hung_up'].includes(c.outcome)) r0.missed++;
      if (c.new_caller) r0.new_callers.add(tail(c.from_number));
    }
    // A new patient is credited to the source of their first call, when they became a patient after it.
    for (const p of patients) {
      const c = firstCall.get(tail(p.phone));
      if (c && p.created_at >= c.created_at) row(c.source || 'Main number').new_patients.push(p.id);
    }
    const costs = new Map((await db.all('SELECT source, SUM(monthly_cost) AS cost FROM tracking_numbers WHERE practice_id = ? GROUP BY source', pid)).map((t) => [t.source, Number(t.cost) || 0]));
    const out = [];
    for (const r0 of rows.values()) {
      const production = r0.new_patients.length ? Number((await db.get(`SELECT SUM(amount) AS n FROM ledger_entries WHERE type = 'charge' AND retail_sale_id IS NULL AND patient_id IN (${r0.new_patients.map(() => '?').join(',')})`, ...r0.new_patients))?.n) || 0 : 0;
      const spend = Math.round(((costs.get(r0.source) || 0) * days) / 30);
      out.push({ source: r0.source, calls: r0.calls, missed: r0.missed, new_callers: r0.new_callers.size, new_patients: r0.new_patients.length, production, spend, cost_per_new_patient: spend && r0.new_patients.length ? Math.round(spend / r0.new_patients.length) : null, return_on_spend: spend ? Math.round((production / spend) * 10) / 10 : null });
    }
    res.json({ days, sources: out.sort((a, b) => b.new_patients - a.new_patients || b.calls - a.calls) });
  });

  r.get('/calls/:cid', requirePermission('patients:read'), async (req, res) => {
    const c = await findOr404(db, 'calls', req.params.cid, req.user.practice_id, 'Call');
    await audit(db, req, 'call.view', 'calls', c.id);
    const { token_hash: _t, ai_turns: turns, ...call } = c;
    // Everyone on file with this number (a family often shares one), so the desk can pick who's calling.
    const d = tail10(c.from_number);
    // Only the patients this user may see (office restrictions), narrowed in SQL by the last four digits.
    const scope = patientScope(req.user);
    const matches = d.length === 10
      ? (await db.all(`SELECT id, first_name, last_name, preferred_name, dob, phone, guarantor_id FROM patients p WHERE p.practice_id = ? AND p.status != 'archived' AND p.phone LIKE ?${scope.sql}`, req.user.practice_id, `%${d.slice(-4)}`, ...scope.args))
        .filter((p) => tail10(p.phone) === d).sort((a, b) => (a.guarantor_id ? 1 : 0) - (b.guarantor_id ? 1 : 0) || a.id - b.id).slice(0, 10)
        .map(({ phone: _p, guarantor_id: _g, ...p }) => p)
      : [];
    res.json({ ...call, turns: JSON.parse(turns || '[]'), card: await callerCard(db, req.user.practice_id, c.patient_id), matches, textable: textable(c.from_number) });
  });
  r.get('/calls/:cid/recording', requirePermission('patients:read'), async (req, res) => {
    const c = await findOr404(db, 'calls', req.params.cid, req.user.practice_id, 'Call');
    if (!c.recording_key) throw new HttpError(404, 'No recording for this call');
    const audio = await storage.read(c.recording_key, !!c.recording_encrypted);
    await audit(db, req, 'call.recording', 'calls', c.id);
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }).send(audio);
  });
  r.patch('/calls/:cid', requirePermission('patients:write'), async (req, res) => {
    const c = await findOr404(db, 'calls', req.params.cid, req.user.practice_id, 'Call');
    if (req.body.patient_id !== undefined) {
      const patient = req.body.patient_id ? await findOr404(db, 'patients', req.body.patient_id, req.user.practice_id, 'Patient') : null;
      await recorded(db, 'calls', c.id, () => db.run('UPDATE calls SET patient_id = ? WHERE id = ?', patient?.id ?? null, c.id));
      // A caller attached to a patient with no phone on file: remember the number on the chart, like texts do.
      if (patient && !patient.phone && tail10(c.from_number).length === 10) {
        await recorded(db, 'patients', patient.id, () => db.run('UPDATE patients SET phone = ? WHERE id = ?', c.from_number, patient.id));
      }
      await audit(db, req, 'call.attach', 'calls', c.id, { patient_id: patient?.id ?? null }, { before: { patient_id: c.patient_id }, after: { patient_id: patient?.id ?? null } });
    }
    if (req.body.handled !== undefined) await db.run(`UPDATE calls SET handled_at = ${req.body.handled ? "datetime('now')" : 'NULL'}, handled_by = ? WHERE id = ?`, req.body.handled ? req.user.id : null, c.id);
    if (req.body.notes !== undefined) await db.run('UPDATE calls SET notes = ? WHERE id = ?', String(req.body.notes || '').slice(0, 2000) || null, c.id);
    res.json(await db.get('SELECT * FROM calls WHERE id = ?', c.id));
  });
  // Staff log a call they made or took on another phone.
  r.post('/calls', requirePermission('patients:write'), async (req, res) => {
    const b = req.body || {};
    if (b.patient_id) await findOr404(db, 'patients', b.patient_id, req.user.practice_id, 'Patient');
    const id = await insert(db, 'calls', {
      practice_id: req.user.practice_id, patient_id: b.patient_id || null, direction: b.direction === 'outbound' ? 'outbound' : 'inbound', purpose: 'logged',
      from_number: b.number || null, status: 'completed', outcome: String(b.outcome || 'answered').slice(0, 40), summary: String(b.summary || '').slice(0, 2000) || null,
      duration: Number(b.minutes) ? Math.round(Number(b.minutes) * 60) : null, user_id: req.user.id, ended_at: await practiceNow(db, req.user.practice_id),
    });
    res.status(201).json(await db.get('SELECT * FROM calls WHERE id = ?', id));
  });

  // ---- Log a call on a patient's chart (A053) ----
  // An ordinary call — on a cell phone, or one the phone line didn't see — noted in a few seconds: which way, how
  // it went, who it was with and a short note. Defaults: now, the signed-in person, the patient. It lands in the
  // chart's call history (Messages & forms → Calls) and the Calls page. When the phone line already logged a call
  // with this patient in the last few minutes, the screen offers to add the note to that call (call_id) instead
  // of logging the same conversation twice. Every change is audited; a double click or a retry logs it once.
  r.get('/patients/:pid/calls/recent', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.pid, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const call = await db.get(
      `SELECT id, direction, outcome, duration, summary, notes, created_at FROM calls
       WHERE practice_id = ? AND patient_id = ? AND purpose != 'logged' AND created_at >= ? ORDER BY id DESC LIMIT 1`,
      req.user.practice_id, patient.id, utcMinutesAgo(RECENT_CALL_MINUTES),
    );
    res.json({ call: call || null, window_minutes: RECENT_CALL_MINUTES });
  });
  r.post('/patients/:pid/calls', requirePermission('patients:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const patient = await findOr404(db, 'patients', req.params.pid, pid, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const b = req.body || {};
    const note = String(b.note ?? '').trim().slice(0, 2000) || null;
    // Add the note to the call the phone line already logged.
    if (b.call_id != null) {
      const call = await findOr404(db, 'calls', b.call_id, pid, 'Call');
      if (call.patient_id && call.patient_id !== patient.id) throw new HttpError(409, 'That call was with someone else');
      if (!note) throw new HttpError(400, 'Type the note to add to the call');
      const line = `${note} — ${req.user.name}`;
      // The same note sent again (a retry) is already there: nothing changes.
      if (!String(call.notes || '').split('\n').includes(line)) {
        const notes = [call.notes, line].filter(Boolean).join('\n').slice(0, 4000);
        await recorded(db, 'calls', call.id, () => db.run('UPDATE calls SET notes = ?, patient_id = COALESCE(patient_id, ?), agent_id = COALESCE(agent_id, ?) WHERE id = ?', notes, patient.id, req.user.id, call.id));
        await audit(db, req, 'call.note', 'calls', call.id, { patient_id: patient.id }, { before: { notes: call.notes }, after: { notes }, patientId: patient.id });
      }
      return res.json({ ...(await db.get('SELECT * FROM calls WHERE id = ?', call.id)), added_to: call.id });
    }
    const direction = b.direction ?? 'outbound';
    if (!['inbound', 'outbound'].includes(direction)) throw new HttpError(400, 'direction must be inbound (they called) or outbound (we called)');
    const outcome = b.outcome ?? 'spoke';
    if (!LOG_OUTCOMES.includes(outcome)) throw new HttpError(400, `outcome must be one of: ${LOG_OUTCOMES.join(', ')}`);
    const minutesAgo = b.minutes_ago == null || b.minutes_ago === '' ? 0 : Number(b.minutes_ago);
    if (!Number.isInteger(minutesAgo) || minutesAgo < 0 || minutesAgo > 24 * 60) throw new HttpError(400, 'When must be within the last 24 hours');
    const withName = String(b.with_name ?? '').trim().slice(0, 120) || `${patient.first_name} ${patient.last_name}`;
    const at = utcMinutesAgo(minutesAgo);
    const same = await db.get(
      `SELECT id FROM calls WHERE practice_id = ? AND patient_id = ? AND purpose = 'logged' AND user_id = ? AND direction = ? AND outcome = ?
         AND COALESCE(summary, '') = ? AND created_at >= ? ORDER BY id DESC LIMIT 1`,
      pid, patient.id, req.user.id, direction, outcome, note || '', utcMinutesAgo(minutesAgo + 2),
    );
    if (same) return res.json({ ...(await db.get('SELECT * FROM calls WHERE id = ?', same.id)), duplicate: true });
    const id = await insert(db, 'calls', {
      practice_id: pid, patient_id: patient.id, location_id: req.location_id || null, direction, purpose: 'logged', status: 'completed', outcome,
      from_number: direction === 'inbound' ? patient.phone || null : null, to_number: direction === 'outbound' ? patient.phone || null : null,
      summary: note, caller_name: withName, user_id: req.user.id, agent_id: req.user.id, agent_source: 'logged', created_at: at, ended_at: at,
    });
    await audit(db, req, 'call.log', 'calls', id, { patient_id: patient.id, direction, outcome }, { after: { direction, outcome, with: withName, note, at }, patientId: patient.id });
    res.status(201).json(await db.get('SELECT * FROM calls WHERE id = ?', id));
  });
  return r;
}

// How a call logged by hand went (A053). The phone line's own outcomes (answered, missed, voicemail…) are separate.
export const LOG_OUTCOMES = ['spoke', 'left_voicemail', 'no_answer', 'wrong_number'];
// A call the phone line logged this recently is probably the one being noted.
const RECENT_CALL_MINUTES = 15;
const utcMinutesAgo = (min) => new Date(Date.now() - min * 60_000).toISOString().slice(0, 19).replace('T', ' ');
