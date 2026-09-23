import express, { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requirePermission, HttpError } from '../auth.js';
import { sendMessage } from '../messaging.js';
import { insert, findOr404, audit, practiceNow, friendlyDateTime } from '../util.js';
import { publish } from '../events.js';
import { patientLang } from '../templates.js';

const STOP = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT'];
const START = ['START', 'UNSTOP', 'YES START', 'SUBSCRIBE'];
const CONFIRM = ['C', 'CONFIRM', 'CONFIRMED', 'Y', 'YES', 'OK', 'SI', 'CONFIRMO', 'CONFIRMAR', 'CONFIRMADO'];
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

    const keyword = body.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z ]/g, '').trim();
    let reply = null;
    // A patient who writes "cancel" (the carriers' opt-out word, or "I need to cancel…") usually means their
    // appointment. We can't cancel it for them from one word, so the front desk gets a task to call.
    const wantsToCancel = candidates.length && (keyword === 'CANCEL' || /\bcancel|resched|\bcambiar|reprogram/i.test(body));
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
        const lang = patientLang(candidates.find((p) => p.id === appt.patient_id));
        reply = lang === 'es'
          ? `¡Gracias! Su cita quedó confirmada para el ${friendlyDateTime(appt.start_time, 'es')} en ${practice.name}.`
          : `Thanks! You're confirmed for ${friendlyDateTime(appt.start_time)} at ${practice.name}.`;
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
export default function conversationRoutes({ db, messenger }) {
  const r = Router();

  // A conversation is a patient's texts, or the texts from a number no patient has.
  const threadKey = (m) => (m.patient_id ? `p${m.patient_id}` : `n${digits(m.direction === 'inbound' ? m.from_address : m.to_address)}`);
  r.get('/conversations', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const rows = await db.all(
      `SELECT m.*, p.first_name, p.last_name,
         (SELECT COUNT(*) FROM messages u WHERE u.practice_id = m.practice_id AND u.direction = 'inbound' AND u.read_at IS NULL
            AND ((m.patient_id IS NULL AND u.patient_id IS NULL AND u.from_address = m.from_address) OR u.patient_id = m.patient_id)) AS unread
       FROM messages m LEFT JOIN patients p ON p.id = m.patient_id
       WHERE m.id IN (
         SELECT MAX(id) FROM messages WHERE practice_id = ? AND channel IN ('sms','portal')
           AND (direction = 'inbound' OR patient_id IN (SELECT patient_id FROM messages WHERE practice_id = ? AND direction = 'inbound')
                OR (patient_id IS NULL AND kind = 'reply'))
         GROUP BY COALESCE(CAST(patient_id AS TEXT), 'x' || CASE WHEN direction = 'inbound' THEN from_address ELSE to_address END)
       ) ORDER BY m.id DESC LIMIT 300`,
      pid, pid,
    );
    const states = new Map((await db.all('SELECT s.*, u.name AS assigned_name FROM conversation_state s LEFT JOIN users u ON u.id = s.assigned_to WHERE s.practice_id = ?', pid)).map((s) => [s.thread, s]));
    const view = req.query.view || 'open';
    res.json(rows.map((m) => {
      const thread = threadKey(m);
      const st = states.get(thread);
      // Archived until the patient writes again.
      const archived = !!st?.archived_at && m.created_at <= st.archived_at;
      return { ...m, thread, number: m.patient_id ? null : (m.direction === 'inbound' ? m.from_address : m.to_address), assigned_to: st?.assigned_to ?? null, assigned_name: st?.assigned_name ?? null, archived };
    }).filter((t) => (view === 'archived' ? t.archived : !t.archived) && (view !== 'mine' || t.assigned_to === req.user.id) && (view !== 'unassigned' || !t.assigned_to)));
  });

  const parseThread = (thread) => {
    const m = /^(p)(\d+)$|^(n)(\d{10})$/.exec(String(thread));
    if (!m) throw new HttpError(400, 'Unknown conversation');
    return m[1] ? { patientId: Number(m[2]) } : { number: m[4] };
  };
  const numberMessages = async (pid, number) => (await db.all(
    "SELECT m.*, u.name AS created_by_name FROM messages m LEFT JOIN users u ON u.id = m.created_by WHERE m.practice_id = ? AND m.channel = 'sms' AND m.patient_id IS NULL ORDER BY m.id", pid,
  )).filter((m) => digits(m.direction === 'inbound' ? m.from_address : m.to_address) === number);

  // Texts from a number no patient has.
  r.get('/conversations/:thread/messages', requirePermission('patients:read'), async (req, res) => {
    const t = parseThread(req.params.thread);
    if (t.patientId) {
      const patient = await findOr404(db, 'patients', t.patientId, req.user.practice_id, 'Patient');
      return res.json(await db.all(
        `SELECT m.*, u.name AS created_by_name FROM messages m LEFT JOIN users u ON u.id = m.created_by
         WHERE m.practice_id = ? AND m.patient_id = ? AND m.channel IN ('sms','portal') ORDER BY m.id`, req.user.practice_id, patient.id,
      ));
    }
    const list = await numberMessages(req.user.practice_id, t.number);
    const unread = list.filter((m) => m.direction === 'inbound' && !m.read_at).map((m) => m.id);
    for (const id of unread) await db.run("UPDATE messages SET read_at = datetime('now') WHERE id = ?", id);
    res.json(list);
  });

  // Reply to a number that isn't a patient yet (someone texting to ask about an appointment).
  r.post('/conversations/:thread/reply', requirePermission('patients:write'), async (req, res) => {
    const t = parseThread(req.params.thread);
    if (t.patientId) throw new HttpError(400, "Reply from the patient's conversation");
    const body = String(req.body?.body || '').trim().slice(0, 480);
    if (!body) throw new HttpError(400, 'body is required');
    const last = (await numberMessages(req.user.practice_id, t.number)).filter((m) => m.direction === 'inbound').at(-1);
    if (!last) throw new HttpError(404, 'No texts from that number');
    const msg = await sendMessage(db, messenger, { practiceId: req.user.practice_id, channel: 'sms', to: last.from_address, body, kind: 'reply', userId: req.user.id });
    await audit(db, req, 'conversation.reply', 'messages', msg.id);
    publish(req.user.practice_id, { type: 'message', patient_id: null });
    res.status(201).json(msg);
  });

  // File an unknown number's texts under a patient (and remember the number on the chart if it has none).
  r.post('/conversations/:thread/attach', requirePermission('patients:write'), async (req, res) => {
    const t = parseThread(req.params.thread);
    if (t.patientId) throw new HttpError(400, 'This conversation already belongs to a patient');
    const patient = await findOr404(db, 'patients', req.body?.patient_id, req.user.practice_id, 'Patient');
    const list = await numberMessages(req.user.practice_id, t.number);
    for (const m of list) await db.run('UPDATE messages SET patient_id = ? WHERE id = ?', patient.id, m.id);
    if (!patient.phone && list.length) await db.run('UPDATE patients SET phone = ? WHERE id = ?', list.find((m) => m.direction === 'inbound')?.from_address ?? null, patient.id);
    await db.run('UPDATE conversation_state SET thread = ? WHERE practice_id = ? AND thread = ? AND NOT EXISTS (SELECT 1 FROM conversation_state x WHERE x.practice_id = ? AND x.thread = ?)',
      `p${patient.id}`, req.user.practice_id, req.params.thread, req.user.practice_id, `p${patient.id}`);
    await audit(db, req, 'conversation.attach', 'patients', patient.id, { messages: list.length });
    publish(req.user.practice_id, { type: 'message', patient_id: patient.id });
    res.json({ ok: true, moved: list.length, thread: `p${patient.id}` });
  });

  // Assign a conversation to a teammate, or archive it (it comes back when the patient writes again).
  r.put('/conversations/:thread', requirePermission('patients:write'), async (req, res) => {
    parseThread(req.params.thread);
    const pid = req.user.practice_id;
    const b = req.body || {};
    if (b.assigned_to) await findOr404(db, 'users', b.assigned_to, pid, 'User');
    await db.run('INSERT INTO conversation_state (practice_id, thread) VALUES (?, ?) ON CONFLICT (practice_id, thread) DO NOTHING', pid, req.params.thread);
    if ('assigned_to' in b) await db.run('UPDATE conversation_state SET assigned_to = ? WHERE practice_id = ? AND thread = ?', b.assigned_to || null, pid, req.params.thread);
    if ('archived' in b) await db.run(`UPDATE conversation_state SET archived_at = ${b.archived ? "datetime('now')" : 'NULL'} WHERE practice_id = ? AND thread = ?`, pid, req.params.thread);
    if (b.archived) {
      const t = parseThread(req.params.thread);
      if (t.patientId) await db.run("UPDATE messages SET read_at = datetime('now') WHERE practice_id = ? AND patient_id = ? AND direction = 'inbound' AND read_at IS NULL", pid, t.patientId);
    }
    await audit(db, req, 'conversation.update', 'conversation_state', null, { thread: req.params.thread, ...b });
    publish(pid, { type: 'message', patient_id: null });
    res.json(await db.get('SELECT * FROM conversation_state WHERE practice_id = ? AND thread = ?', pid, req.params.thread));
  });

  // The office's quick replies (editable; the defaults until changed).
  const DEFAULT_QUICK = ['Thanks! See you then.', 'Yes, that works. We have updated your appointment.', 'Please call the office so we can help: {phone}', 'We have openings later this week. Would you like one?'];
  r.get('/quick-replies', requirePermission('patients:read'), async (req, res) => {
    const p = await db.get('SELECT quick_replies FROM practices WHERE id = ?', req.user.practice_id);
    res.json(p.quick_replies ? JSON.parse(p.quick_replies) : DEFAULT_QUICK);
  });
  r.put('/quick-replies', requirePermission('patients:write'), async (req, res) => {
    const list = req.body?.replies;
    if (!Array.isArray(list) || list.length > 20) throw new HttpError(400, 'replies must be a list of up to 20');
    const clean = list.map((q) => String(q).trim().slice(0, 320)).filter(Boolean);
    await db.run('UPDATE practices SET quick_replies = ? WHERE id = ?', JSON.stringify(clean), req.user.practice_id);
    await audit(db, req, 'quick_replies.update', 'practices', req.user.practice_id);
    res.json(clean);
  });

  r.get('/conversations/unread', requirePermission('patients:read'), async (req, res) => {
    res.json({ unread: (await db.get("SELECT COUNT(*) AS n FROM messages WHERE practice_id = ? AND direction = 'inbound' AND read_at IS NULL", req.user.practice_id)).n });
  });

  r.get('/patients/:id/conversation', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json(await db.all(
      `SELECT m.*, u.name AS created_by_name FROM messages m LEFT JOIN users u ON u.id = m.created_by
       WHERE m.practice_id = ? AND m.patient_id = ? AND m.channel IN ('sms','portal') ORDER BY m.id`, req.user.practice_id, patient.id,
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
