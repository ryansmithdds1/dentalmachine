import express, { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requirePermission } from '../auth.js';
import { insert, findOr404, audit, practiceNow, friendlyDateTime } from '../util.js';
import { publish } from '../events.js';

const STOP = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT'];
const START = ['START', 'UNSTOP', 'YES START', 'SUBSCRIBE'];
const CONFIRM = ['C', 'CONFIRM', 'CONFIRMED', 'Y', 'YES', 'OK'];
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const twiml = (reply) => `<?xml version="1.0" encoding="UTF-8"?><Response>${reply ? `<Message>${xml(reply)}</Message>` : ''}</Response>`;

// Twilio request signature: base64(HMAC-SHA1(authToken, url + concatenated sorted key/value pairs)).
export function twilioSignature(authToken, url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', authToken).update(data).digest('base64');
}

// Inbound texts from patients (Twilio "A message comes in" webhook).
export function smsWebhook({ db, config }) {
  const r = Router();
  r.post('/api/webhooks/twilio/sms', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
    if (!config.twilioAuthToken) return res.status(501).json({ error: 'Twilio not configured' });
    const expected = twilioSignature(config.twilioAuthToken, `${config.appUrl}/api/webhooks/twilio/sms`, req.body);
    const given = Buffer.from(String(req.headers['x-twilio-signature'] || ''));
    if (given.length !== Buffer.from(expected).length || !timingSafeEqual(given, Buffer.from(expected))) return res.status(403).send('Invalid signature');

    const from = String(req.body.From || '');
    const to = String(req.body.To || '');
    const body = String(req.body.Body || '').trim().slice(0, 1600);
    const practice = (await db.all('SELECT * FROM practices WHERE sms_number IS NOT NULL')).find((p) => digits(p.sms_number) === digits(to))
      || ((await db.get('SELECT COUNT(*) AS n FROM practices')).n === 1 ? await db.get('SELECT * FROM practices LIMIT 1') : null);
    if (!practice) return res.type('text/xml').send(twiml());
    // Match on the last 10 digits; prefer the head of household if several share a number.
    const candidates = (await db.all('SELECT * FROM patients WHERE practice_id = ? AND status != \'archived\' AND phone IS NOT NULL', practice.id))
      .filter((p) => digits(p.phone) === digits(from))
      .sort((a, b) => (a.guarantor_id ? 1 : 0) - (b.guarantor_id ? 1 : 0));
    const patient = candidates[0] || null;

    const msgId = await insert(db, 'messages', {
      practice_id: practice.id, patient_id: patient?.id ?? null, channel: 'sms', kind: 'reply', direction: 'inbound',
      to_address: to, from_address: from, body, status: 'sent', provider_id: req.body.MessageSid || null, sent_at: new Date().toISOString(),
    });

    const keyword = body.toUpperCase().replace(/[^A-Z ]/g, '').trim();
    let reply = null;
    // A patient who writes "cancel" (the carriers' opt-out word, or "I need to cancel…") usually means their
    // appointment. We can't cancel it for them from one word, so the front desk gets a task to call.
    const wantsToCancel = candidates.length && (keyword === 'CANCEL' || /\bcancel|resched/i.test(body));
    if (wantsToCancel) {
      const now = await practiceNow(db, practice.id);
      const appt = await db.get(
        `SELECT * FROM appointments WHERE practice_id = ? AND patient_id IN (${candidates.map(() => '?').join(',')})
         AND status IN ('scheduled','confirmed') AND start_time > ? ORDER BY start_time LIMIT 1`, practice.id, ...candidates.map((p) => p.id), now,
      );
      if (appt) {
        const who = candidates.find((p) => p.id === appt.patient_id);
        await insert(db, 'tasks', {
          practice_id: practice.id, patient_id: appt.patient_id, priority: 'high', due_date: now.slice(0, 10),
          title: `${who.first_name} ${who.last_name} texted "${body.slice(0, 60)}" — may want to cancel ${friendlyDateTime(appt.start_time)}. Call to reschedule.`,
        });
      }
    }
    if (STOP.includes(keyword)) {
      // "CANCEL" is a carrier opt-out keyword: the carrier stops our texts whatever we do, so we record it too.
      for (const p of candidates) await db.run('UPDATE patients SET sms_opt_in = 0 WHERE id = ?', p.id);
      // Twilio sends the carrier-required opt-out confirmation itself.
    } else if (START.includes(keyword)) {
      for (const p of candidates) await db.run('UPDATE patients SET sms_opt_in = 1 WHERE id = ?', p.id);
    } else if (CONFIRM.includes(keyword) && candidates.length) {
      const now = await practiceNow(db, practice.id);
      const appt = await db.get(
        `SELECT * FROM appointments WHERE practice_id = ? AND patient_id IN (${candidates.map(() => '?').join(',')})
         AND status = 'scheduled' AND start_time > ? ORDER BY start_time LIMIT 1`, practice.id, ...candidates.map((p) => p.id), now,
      );
      if (appt) {
        await db.run("UPDATE appointments SET status = 'confirmed', confirmed_at = datetime('now'), confirmed_via = 'text' WHERE id = ?", appt.id);
        publish(practice.id, { type: 'schedule', dates: [appt.start_time.slice(0, 10)], source: 'sms' });
        reply = `Thanks! You're confirmed for ${friendlyDateTime(appt.start_time)} at ${practice.name}.`;
      }
    }
    if (reply) {
      await insert(db, 'messages', {
        practice_id: practice.id, patient_id: patient?.id ?? null, channel: 'sms', kind: 'auto_reply', direction: 'outbound',
        to_address: from, from_address: to, body: reply, status: 'sent', provider_id: 'twiml', sent_at: new Date().toISOString(),
      });
    }
    await audit(db, { ip: req.ip, user: { practice_id: practice.id, id: null } }, 'sms.inbound', 'messages', msgId, { keyword: keyword.length <= 12 ? keyword : undefined });
    publish(practice.id, { type: 'message', patient_id: patient?.id ?? null });
    res.type('text/xml').send(twiml(reply));
  });
  return r;
}

// Staff inbox of text conversations.
export default function conversationRoutes({ db }) {
  const r = Router();

  r.get('/conversations', requirePermission('patients:read'), async (req, res) => {
    res.json(await db.all(
      `SELECT m.*, p.first_name, p.last_name,
         (SELECT COUNT(*) FROM messages u WHERE u.practice_id = m.practice_id AND u.direction = 'inbound' AND u.read_at IS NULL
            AND ((m.patient_id IS NULL AND u.patient_id IS NULL AND u.from_address = m.from_address) OR u.patient_id = m.patient_id)) AS unread
       FROM messages m LEFT JOIN patients p ON p.id = m.patient_id
       WHERE m.id IN (
         SELECT MAX(id) FROM messages WHERE practice_id = ? AND channel = 'sms'
           AND (direction = 'inbound' OR patient_id IN (SELECT patient_id FROM messages WHERE practice_id = ? AND direction = 'inbound'))
         GROUP BY COALESCE(CAST(patient_id AS TEXT), 'x' || from_address)
       ) ORDER BY m.id DESC LIMIT 200`,
      req.user.practice_id, req.user.practice_id,
    ));
  });

  r.get('/conversations/unread', requirePermission('patients:read'), async (req, res) => {
    res.json({ unread: (await db.get("SELECT COUNT(*) AS n FROM messages WHERE practice_id = ? AND direction = 'inbound' AND read_at IS NULL", req.user.practice_id)).n });
  });

  r.get('/patients/:id/conversation', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json(await db.all(
      `SELECT m.*, u.name AS created_by_name FROM messages m LEFT JOIN users u ON u.id = m.created_by
       WHERE m.practice_id = ? AND m.patient_id = ? AND m.channel = 'sms' ORDER BY m.id`, req.user.practice_id, patient.id,
    ));
  });

  r.post('/patients/:id/conversation/read', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    await db.run("UPDATE messages SET read_at = datetime('now') WHERE practice_id = ? AND patient_id = ? AND direction = 'inbound' AND read_at IS NULL", req.user.practice_id, patient.id);
    await audit(db, req, 'conversation.read', 'patients', patient.id);
    publish(req.user.practice_id, { type: 'message', patient_id: patient.id });
    res.json({ ok: true });
  });

  return r;
}
