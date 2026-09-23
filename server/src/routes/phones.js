import express, { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { twilioSignature } from './sms.js';
import { requirePermission, HttpError } from '../auth.js';
import { insert, practiceNow, audit, findOr404 } from '../util.js';
import { publish } from '../events.js';
import { practiceForNumber, patientForNumber, callerCard, isOpenNow, textBack, processRecording, summarizeCall, receptionistTurn } from '../phones.js';
import { aiClient } from '../ai.js';

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const twiml = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
const say = (text) => `<Say voice="Polly.Joanna-Neural">${xml(text)}</Say>`;
const later = (label, fn) => setImmediate(() => fn().catch((err) => console.error(`${label}:`, err.message)));

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
    const id = await insert(db, 'calls', {
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
        later('text-back', () => textBack(db, messenger, call, practice, config.appUrl));
      }
      if (!ai) return send(res, voicemail(practice, call));
      await db.run("UPDATE calls SET purpose = 'receptionist' WHERE id = ?", id);
      return send(res, greetAi(call));
    }
    // Ring the office; recorded (both sides, on separate channels) when the practice records calls.
    const rec = practice.record_calls ? ` record="record-from-answer-dual" recordingStatusCallback="${url(`recording?call=${id}`)}"` : '';
    send(res, (practice.record_calls ? say('This call may be recorded for quality and training.') : '')
      + `<Dial timeout="${Math.min(60, Math.max(5, practice.ring_seconds || 20))}" action="${url(`dial-done?call=${id}`)}"${rec}>${/^sip:/i.test(practice.forward_to) ? `<Sip>${xml(practice.forward_to)}</Sip>` : `<Number>${xml(practice.forward_to)}</Number>`}</Dial>`);
  });

  // The office phone rang out: text the caller back, then the AI receptionist or voicemail.
  r.post('/api/webhooks/twilio/voice/dial-done', form, guard, async (req, res) => {
    const call = await callOf(req);
    if (!call) return send(res, '<Hangup/>');
    const status = String(req.body.DialCallStatus || '');
    if (status === 'completed' || status === 'answered') {
      await db.run("UPDATE calls SET status = 'completed', outcome = 'answered', duration = ?, ended_at = datetime('now') WHERE id = ?", Number(req.body.DialCallDuration) || null, call.id);
      publish(call.practice_id, { type: 'call', event: 'ended', call_id: call.id });
      return send(res, '<Hangup/>');
    }
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', call.practice_id);
    await db.run("UPDATE calls SET outcome = 'missed' WHERE id = ?", call.id);
    publish(call.practice_id, { type: 'call', event: 'missed', call_id: call.id });
    later('text-back', () => textBack(db, messenger, call, practice, config.appUrl));
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
      later('summary', () => summarizeCall(db, config, call.id));
    }
    res.status(204).end();
  });
  r.post('/api/webhooks/twilio/voice/recording', form, guard, async (req, res) => {
    const call = await callOf(req);
    if (call && req.body.RecordingUrl && (req.body.RecordingStatus || 'completed') === 'completed') {
      later('recording', () => processRecording(db, { storage, transcriber, config, fetchImpl }, call.id, String(req.body.RecordingUrl)));
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
      later('summary', () => summarizeCall(db, config, call.id));
      return send(res, say('I didn’t catch that. Please call back anytime. Goodbye.') + '<Hangup/>');
    }
    const { say: text, hangup } = await receptionistTurn(db, config, call.id, heard || '(silence)');
    if (hangup) {
      await db.run("UPDATE calls SET status = 'completed', outcome = COALESCE(outcome, 'handled'), ended_at = datetime('now') WHERE id = ?", call.id);
      later('summary', () => summarizeCall(db, config, call.id));
      return send(res, say(text) + '<Hangup/>');
    }
    send(res, gather(call, text));
  });
  return r;
}

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
  r.get('/calls/:cid', requirePermission('patients:read'), async (req, res) => {
    const c = await findOr404(db, 'calls', req.params.cid, req.user.practice_id, 'Call');
    await audit(db, req, 'call.view', 'calls', c.id);
    const { token_hash: _t, ai_turns: turns, ...call } = c;
    res.json({ ...call, turns: JSON.parse(turns || '[]'), card: await callerCard(db, req.user.practice_id, c.patient_id) });
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
      if (req.body.patient_id) await findOr404(db, 'patients', req.body.patient_id, req.user.practice_id, 'Patient');
      await db.run('UPDATE calls SET patient_id = ? WHERE id = ?', req.body.patient_id || null, c.id);
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
  return r;
}
