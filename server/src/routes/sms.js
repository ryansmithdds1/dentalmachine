import express, { Router } from 'express';
import { setActor } from '../actor.js';
import { HERE, checkInToday } from '../checkin.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requirePermission, HttpError } from '../auth.js';
import { sendMessage, recordOptOut, clearOptOut, isOptedOutAddress, visitsText, markBad } from '../messaging.js';
import { insert, findOr404, audit, practiceNow, friendlyDateTime, recorded } from '../util.js';
import { publish } from '../events.js';
import { offerFor, claimOffer } from '../fill.js';
import { patientLang } from '../templates.js';
import { postopReply } from '../journeys.js';

const STOP = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT'];
const START = ['START', 'UNSTOP', 'YES START', 'SUBSCRIBE'];
const CONFIRM = ['C', 'CONFIRM', 'CONFIRMED', 'Y', 'YES', 'OK', 'SI', 'CONFIRMO', 'CONFIRMAR', 'CONFIRMADO', 'YES CONFIRM', 'C YES', 'OK THANKS', 'YES THANKS', 'THANKS YES', 'SI GRACIAS', 'CONFIRMED THANKS', 'CONFIRM THANKS', 'THUMBS UP'];
const HELP = ['HELP', 'INFO', 'AYUDA'];
const RESCHEDULE = ['R', 'RESCHEDULE', 'CHANGE', 'MOVE', 'CAMBIAR', 'CAMBIO'];
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
// Only US/Canada numbers can be texted back (caller ID can be faked; this keeps the office line from texting
// arbitrary international numbers).
export const textable = (s) => { const raw = String(s || '').replace(/\D/g, ''); return raw.length === 10 || (raw.length === 11 && raw.startsWith('1')); };
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
    // Which practice the reply is for: one with its own texting number (never the shared platform number),
    // else whichever practice last texted this phone, else the only practice on a single-office server.
    const shared = digits(process.env.TWILIO_FROM || '');
    const own = digits(to) !== shared ? (await db.all('SELECT * FROM practices WHERE sms_number IS NOT NULL')).find((p) => digits(p.sms_number) === digits(to)) : null;
    const lastTexted = async () => {
      const tail = digits(from).slice(-4);
      if (tail.length < 4) return null;
      const hit = (await db.all("SELECT practice_id, to_address FROM messages WHERE channel = 'sms' AND (direction IS NULL OR direction != 'inbound') AND to_address LIKE ? ORDER BY id DESC LIMIT 200", `%${tail}`))
        .find((m) => digits(m.to_address) === digits(from));
      return hit ? db.get('SELECT * FROM practices WHERE id = ?', hit.practice_id) : null;
    };
    setActor({ source: 'patient', actor: 'Patient (text message)' });
    // Twilio can deliver the same text twice; the second is acknowledged and ignored.
    if (req.body.MessageSid && await db.get("SELECT id FROM messages WHERE provider_id = ? AND direction = 'inbound'", String(req.body.MessageSid))) return res.type('text/xml').send(twiml());
    const practice = own || (await lastTexted())
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

    const keyword = body.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();
    const lang = patientLang(patient);
    const phone = practice.phone || (lang === 'es' ? 'la oficina' : 'the office');
    let reply = null;
    // The visits a reply can be about: those of everyone at this number, and of the children (or others without
    // their own phone) whose guarantor this is — the parent answers for the family.
    const dependents = candidates.length ? (await db.all(
      `SELECT * FROM patients WHERE practice_id = ? AND status != 'archived' AND guarantor_id IN (${candidates.map(() => '?').join(',')})`, practice.id, ...candidates.map((p) => p.id),
    )).filter((d) => !candidates.some((c) => c.id === d.id) && (!d.phone || digits(d.phone) === digits(from) || (d.dob && d.dob > `${new Date().getUTCFullYear() - 18}${new Date().toISOString().slice(4, 10)}`))) : [];
    const household = [...candidates, ...dependents];
    const ids = household.map((p) => p.id);
    const inList = ids.map(() => '?').join(',');
    const upcoming = async (statuses) => (ids.length ? db.all(
      `SELECT a.*, p.first_name FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.practice_id = ? AND a.patient_id IN (${inList})
       AND a.status IN (${statuses.map(() => '?').join(',')}) AND a.start_time > ? ORDER BY a.start_time`, practice.id, ...ids, ...statuses, await practiceNow(db, practice.id),
    ) : []);
    // The front desk gets a task to call about it: we don't cancel or move a visit from a text.
    const callTask = async (appt, what) => {
      const who = household.find((p) => p.id === appt.patient_id);
      const now = await practiceNow(db, practice.id);
      await insert(db, 'tasks', {
        practice_id: practice.id, patient_id: appt.patient_id, priority: 'high', due_date: now.slice(0, 10),
        title: `${who.first_name} ${who.last_name} texted "${body.slice(0, 60)}" — ${what} ${friendlyDateTime(appt.start_time)}. Call to reschedule.`,
      });
      publish(practice.id, { type: 'tasks' });
    };
    // A patient who writes "cancel" (the carriers' opt-out word, or "I need to cancel…") usually means their
    // appointment. We can't cancel it for them from one word, so the front desk gets a task to call.
    const wantsToCancel = candidates.length && (keyword === 'CANCEL' || /\bcancel|resched|\bcambiar|reprogram/i.test(body));
    const wantsToMove = candidates.length && RESCHEDULE.includes(keyword);
    if (wantsToCancel || wantsToMove) {
      const [appt] = await upcoming(['scheduled', 'confirmed']);
      if (appt) {
        await callTask(appt, wantsToMove ? 'wants a new time instead of' : 'may want to cancel');
        if (wantsToMove) {
          reply = lang === 'es'
            ? `Entendido. Alguien de ${practice.name} le llamará para buscar otro horario, o llámenos al ${phone}.`
            : `Got it — someone from ${practice.name} will call you to find a new time, or call us at ${phone}.`;
        }
      }
    }
    // A reply to an opening we texted (the last thing we sent this number): YES books it for the first to answer.
    const offer = !STOP.includes(keyword) && !START.includes(keyword) && !HELP.includes(keyword) ? await offerFor(db, practice.id, from) : null;
    if (offer && /^(YES|Y|YEP|YEAH|SI|OK|SURE|I LL TAKE IT|ILL TAKE IT|TAKE IT|YES PLEASE|BOOK IT|YES BOOK IT)$/.test(keyword)) {
      const out = await claimOffer(db, offer);
      const lang = patientLang(await db.get('SELECT language FROM patients WHERE id = ?', offer.patient_id));
      reply = out.won
        ? (lang === 'es' ? `¡Listo! Su cita quedó para el ${friendlyDateTime(out.offer.start_time, 'es')} en ${practice.name}.` : `You're booked for ${friendlyDateTime(out.offer.start_time)} at ${practice.name}. See you then!`)
        : (lang === 'es' ? `Lo sentimos, ese horario ya se tomó. Sigue en nuestra lista y le avisaremos del próximo.` : `Sorry — that time was just taken. You're still on our list and we'll text you the next one.`);
    } else if (offer && /^(NO|N|NOPE|NO THANKS|CANT)$/.test(keyword)) {
      await db.run("UPDATE fill_offer_recipients SET reply = 'no', replied_at = datetime('now') WHERE id = ?", offer.id);
      reply = lang === 'es' ? 'Entendido, gracias.' : 'No problem — thanks for letting us know.';
    } else if (STOP.includes(keyword)) {
      // "CANCEL" is a carrier opt-out keyword: the carrier stops our texts whatever we do, so we record it too.
      for (const p of candidates) await recorded(db, 'patients', p.id, () => db.run('UPDATE patients SET sms_opt_in = 0 WHERE id = ?', p.id));
      // The number itself is recorded too, so nothing reaches it even if it isn't (yet) on a patient's chart.
      await recordOptOut(db, practice.id, 'sms', from, 'stop');
      // Twilio sends the carrier-required opt-out confirmation itself.
    } else if (HERE.includes(keyword) && candidates.length) {
      // Arrived: check in today's visits for everyone at this number.
      const done = await checkInToday(db, practice.id, household.map((p) => p.id), { via: 'text' });
      const names = [...new Set(done.map((v) => v.first_name))].join(lang === 'es' ? ' y ' : ' and ');
      reply = done.length
        ? (lang === 'es' ? `¡Gracias! ${names} ya está registrado(a). Le avisaremos por mensaje cuando estemos listos.` : `Thanks! ${names} ${done.length > 1 ? 'are' : 'is'} checked in. We'll text you when we're ready for you.`)
        : (lang === 'es' ? `No encontramos una cita para hoy. Por favor pase a la recepción o llame al ${phone}.` : `We couldn't find a visit for today. Please come to the front desk or call ${phone}.`);
    } else if (START.includes(keyword)) {
      for (const p of candidates) await recorded(db, 'patients', p.id, () => db.run('UPDATE patients SET sms_opt_in = 1 WHERE id = ?', p.id));
      await clearOptOut(db, practice.id, 'sms', from);
    } else if (HELP.includes(keyword)) {
      // Carriers require an answer to HELP: who we are, how to reach a person, how to stop.
      reply = lang === 'es'
        ? `${practice.name}: recordatorios de citas. Para ayuda llame al ${phone}. Responda STOP para no recibir mensajes. Pueden aplicar tarifas de mensajes y datos.`
        : `${practice.name}: appointment reminders. For help call ${phone}. Reply STOP to opt out. Msg & data rates may apply.`;
    } else if (CONFIRM.includes(keyword) && candidates.length) {
      // Confirms everyone at this number who's coming in on the next visit day (a family's visits together).
      const open = await upcoming(['scheduled']);
      const day = open[0]?.start_time.slice(0, 10);
      const confirm = open.filter((a) => a.start_time.startsWith(day));
      for (const appt of confirm) {
        await recorded(db, 'appointments', appt.id, () => db.run("UPDATE appointments SET status = 'confirmed', confirmed_at = datetime('now'), confirmed_via = 'text' WHERE id = ?", appt.id));
      }
      if (confirm.length) {
        publish(practice.id, { type: 'schedule', dates: [day], source: 'sms' });
        if (confirm.length > 1 || confirm[0].patient_id !== patient.id) {
          const what = visitsText(confirm, lang, { providers: false });
          reply = lang === 'es' ? `¡Gracias! Quedaron confirmadas en ${practice.name}: ${what}.` : `Thanks! Confirmed at ${practice.name}: ${what}.`;
        } else {
          reply = lang === 'es'
            ? `¡Gracias! Su cita quedó confirmada para el ${friendlyDateTime(confirm[0].start_time, 'es')} en ${practice.name}.`
            : `Thanks! You're confirmed for ${friendlyDateTime(confirm[0].start_time)} at ${practice.name}.`;
        }
      } else {
        const [next] = await upcoming(['confirmed']);
        reply = next
          ? (lang === 'es' ? `Ya está confirmado para el ${friendlyDateTime(next.start_time, 'es')}. ¡Lo esperamos!` : `You're already confirmed for ${friendlyDateTime(next.start_time)}. See you then!`)
          : (lang === 'es' ? `No encontramos una cita por confirmar. Llámenos al ${phone} si necesita algo.` : `We didn't find a visit waiting to be confirmed. Call us at ${phone} if you need anything.`);
      }
    }
    // "1 / 2 / 3" answering an evening check-in after surgery (patient journeys): 2 or 3 alerts the doctor.
    if (!reply && candidates.length) reply = await postopReply(db, { practice, from, body });
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
    // Their last text, or (when we texted first, e.g. back after a call) the number we wrote to.
    const list = await numberMessages(req.user.practice_id, t.number);
    const last = list.filter((m) => m.direction === 'inbound').at(-1) || list.filter((m) => m.kind === 'reply').at(-1);
    if (!last) throw new HttpError(404, 'No texts from that number');
    const to = last.direction === 'inbound' ? last.from_address : last.to_address;
    if (await isOptedOutAddress(db, req.user.practice_id, 'sms', to)) throw new HttpError(409, 'This number replied STOP — they need to text START before you can text them');
    const msg = await sendMessage(db, messenger, { practiceId: req.user.practice_id, channel: 'sms', to, body, kind: 'reply', userId: req.user.id });
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
    if (!patient.phone && list.length) await recorded(db, 'patients', patient.id, () => db.run('UPDATE patients SET phone = ? WHERE id = ?', list.find((m) => m.direction === 'inbound')?.from_address ?? null, patient.id));
    await db.run('UPDATE conversation_state SET thread = ? WHERE practice_id = ? AND thread = ? AND NOT EXISTS (SELECT 1 FROM conversation_state x WHERE x.practice_id = ? AND x.thread = ?)',
      `p${patient.id}`, req.user.practice_id, req.params.thread, req.user.practice_id, `p${patient.id}`);
    await audit(db, req, 'conversation.attach', 'patients', patient.id, { messages: list.length });
    publish(req.user.practice_id, { type: 'message', patient_id: patient.id });
    res.json({ ok: true, moved: list.length, thread: `p${patient.id}` });
  });

  // Text the caller back from the pop (someone who isn't a patient yet, or a patient on another number).
  // Sends go through sendMessage, so a failure is saved on the message and raised in Needs attention; a
  // resent request with the same Idempotency-Key gets the first answer.
  r.post('/calls/:cid/text', requirePermission('patients:write'), async (req, res) => {
    const c = await findOr404(db, 'calls', req.params.cid, req.user.practice_id, 'Call');
    if (c.direction !== 'inbound' || !textable(c.from_number)) throw new HttpError(400, 'This caller’s number can’t be texted');
    const body = String(req.body?.body || '').trim().slice(0, 480);
    if (!body) throw new HttpError(400, 'Type a message first');
    if (await isOptedOutAddress(db, req.user.practice_id, 'sms', c.from_number)) throw new HttpError(409, 'This number replied STOP — they need to text START before you can text them');
    const msg = await sendMessage(db, messenger, { practiceId: req.user.practice_id, patientId: c.patient_id, channel: 'sms', to: c.from_number, body, kind: 'reply', userId: req.user.id });
    await audit(db, req, 'call.text', 'messages', msg.id, { call_id: c.id });
    publish(req.user.practice_id, { type: 'message', patient_id: c.patient_id ?? null });
    res.status(201).json({ ...msg, thread: c.patient_id ? `p${c.patient_id}` : `n${digits(c.from_number)}` });
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
