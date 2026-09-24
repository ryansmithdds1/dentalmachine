import express, { Router } from 'express';
import { createPublicKey, verify as verifySignature, timingSafeEqual } from 'node:crypto';
import { twilioSignature } from './sms.js';
import { markBad, recordOptOut } from '../messaging.js';
import { publish } from '../events.js';

// Delivery reports: whether a text or email actually arrived. A text to a landline or a dead number, or an
// email that bounces, marks that number or address as not working, so the next reminder goes by the other
// channel; a reminder that didn't arrive is tried again that way.

// Twilio error codes that mean the number itself can't get texts (not a passing network problem).
const DEAD_NUMBER = { 30006: 'Landline or unreachable carrier', 30005: 'Unknown or inactive number', 21614: 'Not a mobile number', 21211: 'Not a valid number' };
const OPTED_OUT = ['21610'];

async function afterFailure(db, msg) {
  // The visits this message was about: a failed reminder is due again, by the other channel if this one is dead.
  const visits = (await db.all('SELECT DISTINCT appointment_id FROM confirm_links WHERE message_id = ?', msg.id)).map((r) => r.appointment_id);
  if (!visits.length && msg.appointment_id) visits.push(msg.appointment_id);
  if (msg.kind !== 'reminder') return;
  for (const id of visits) {
    const last = await db.get("SELECT id FROM appointment_reminders WHERE appointment_id = ? AND status = 'sent' ORDER BY sent_at DESC, step ASC LIMIT 1", id);
    if (last) await db.run("UPDATE appointment_reminders SET status = 'failed' WHERE id = ?", last.id);
  }
}

async function record(db, msg, delivery, code) {
  await db.run('UPDATE messages SET delivery = ?, error_code = COALESCE(?, error_code) WHERE id = ?', delivery, code || null, msg.id);
  publish(msg.practice_id, { type: 'message', patient_id: msg.patient_id });
}

export function deliveryWebhooks({ db, config }) {
  const r = Router();

  // Twilio's StatusCallback for each text we send.
  r.post('/api/webhooks/twilio/status', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
    if (!config.twilioAuthToken) return res.status(501).json({ error: 'Twilio not configured' });
    const expected = Buffer.from(twilioSignature(config.twilioAuthToken, `${config.appUrl}/api/webhooks/twilio/status`, req.body));
    const given = Buffer.from(String(req.headers['x-twilio-signature'] || ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return res.status(403).send('Invalid signature');
    const { MessageSid: sid, MessageStatus: status, ErrorCode: code } = req.body;
    const msg = sid && await db.get("SELECT * FROM messages WHERE provider_id = ? AND channel = 'sms'", String(sid));
    if (!msg || !['sent', 'delivered', 'undelivered', 'failed'].includes(status)) return res.status(204).end();
    if (msg.delivery === 'delivered' && status !== 'delivered') return res.status(204).end(); // reports can arrive out of order
    await record(db, msg, status, code);
    if (status === 'undelivered' || status === 'failed') {
      if (DEAD_NUMBER[code]) await markBad(db, msg.practice_id, 'sms', msg.to_address, DEAD_NUMBER[code]);
      if (OPTED_OUT.includes(String(code))) await recordOptOut(db, msg.practice_id, 'sms', msg.to_address, 'carrier');
      await afterFailure(db, msg);
    }
    res.status(204).end();
  });

  // SendGrid's Event Webhook (signed): delivered, bounced, dropped, marked as spam, unsubscribed.
  r.post('/api/webhooks/sendgrid', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    if (!config.sendgridWebhookKey) return res.status(501).json({ error: 'SendGrid events not configured' });
    const sig = String(req.headers['x-twilio-email-event-webhook-signature'] || '');
    const ts = String(req.headers['x-twilio-email-event-webhook-timestamp'] || '');
    let ok = false;
    try {
      const key = createPublicKey({ key: Buffer.from(config.sendgridWebhookKey, 'base64'), format: 'der', type: 'spki' });
      ok = verifySignature('sha256', Buffer.concat([Buffer.from(ts), req.body]), key, Buffer.from(sig, 'base64'));
    } catch {
      ok = false;
    }
    if (!ok) return res.status(403).send('Invalid signature');
    // A signed batch replayed later would re-apply old bounces and opt-outs: only fresh batches count.
    if (!/^\d{9,11}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 600) return res.status(403).send('Stale event batch');
    let events;
    try {
      events = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).send('Bad JSON');
    }
    for (const e of Array.isArray(events) ? events : []) {
      const id = Number(e.dm_message_id);
      const msg = id ? await db.get("SELECT * FROM messages WHERE id = ? AND channel = 'email'", id) : null;
      if (!msg) continue;
      if (e.event === 'delivered') {
        if (msg.delivery !== 'bounced') await record(db, msg, 'delivered');
      } else if (e.event === 'bounce' || e.event === 'dropped') {
        await record(db, msg, 'bounced', e.status || e.reason?.slice(0, 40));
        // A hard bounce (or a dropped address that bounced before): the address doesn't work.
        if (e.event === 'dropped' || e.type !== 'blocked') await markBad(db, msg.practice_id, 'email', msg.to_address, String(e.reason || 'Email bounced').slice(0, 200));
        await afterFailure(db, msg);
      } else if (e.event === 'spamreport' || e.event === 'unsubscribe' || e.event === 'group_unsubscribe') {
        await recordOptOut(db, msg.practice_id, 'email', msg.to_address, e.event === 'spamreport' ? 'spam report' : 'unsubscribe');
      }
    }
    res.status(204).end();
  });
  return r;
}
