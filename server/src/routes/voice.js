import express, { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { twilioSignature } from './sms.js';
import { hashToken, insert, practiceNow } from '../util.js';
import { patientLang } from '../templates.js';
import { publish } from '../events.js';

// What an automated confirmation call says and does (Twilio asks these URLs as the call goes).
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const VOICE = { en: ['Polly.Joanna-Neural', 'en-US'], es: ['Polly.Lupe-Neural', 'es-US'] };
const say = (lang, text) => `<Say voice="${VOICE[lang][0]}" language="${VOICE[lang][1]}">${xml(text)}</Say>`;
const twiml = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

// "Tuesday, September 29 at 2:30 PM", the way it should be read aloud.
function spoken(dt, lang) {
  const d = new Date(`${dt.slice(0, 10)}T12:00:00Z`);
  const day = d.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const [h, m] = dt.slice(11, 16).split(':').map(Number);
  const time = `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? (lang === 'es' ? 'de la mañana' : 'A M') : (lang === 'es' ? 'de la tarde' : 'P M')}`;
  return lang === 'es' ? `el ${day} a las ${time}` : `${day} at ${time}`;
}
const phoneWords = (p) => String(p || '').replace(/\D/g, '').split('').join(' ');

export function voiceWebhooks({ db, config }) {
  const r = Router();
  const form = express.urlencoded({ extended: false, limit: '64kb' });
  const signed = (req) => {
    if (!config.twilioAuthToken) return false;
    const expected = Buffer.from(twilioSignature(config.twilioAuthToken, `${config.appUrl}${req.originalUrl}`, req.body));
    const given = Buffer.from(String(req.headers['x-twilio-signature'] || ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const callFor = async (token) => {
    const hash = hashToken(token);
    const links = await db.all('SELECT * FROM confirm_links WHERE token_hash = ? ORDER BY id', hash);
    if (!links.length) return null;
    const visits = await db.all(
      `SELECT a.*, p.first_name, pv.name AS provider_name FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN providers pv ON pv.id = a.provider_id
       WHERE a.id IN (${links.map(() => '?').join(',')}) ORDER BY a.start_time`, ...links.map((l) => l.appointment_id),
    );
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', links[0].practice_id);
    const recipient = await db.get('SELECT id, first_name, language FROM patients WHERE id = ?', links[0].recipient_id);
    const call = await db.get('SELECT * FROM calls WHERE token_hash = ? ORDER BY id DESC LIMIT 1', hash);
    return { visits, practice, recipient, call, lang: patientLang(recipient) === 'es' ? 'es' : 'en' };
  };
  const reject = (res) => res.status(403).type('text/xml').send(twiml(''));

  r.post('/api/webhooks/twilio/voice/confirm/:token', form, async (req, res) => {
    if (!signed(req)) return reject(res);
    const c = await callFor(req.params.token);
    if (!c) return res.type('text/xml').send(twiml('<Hangup/>'));
    const { visits, practice, lang } = c;
    const who = visits.map((v) => v.first_name).filter((n, i, a) => a.indexOf(n) === i);
    const names = who.join(lang === 'es' ? ' y ' : ' and ');
    const when = spoken(visits[0].start_time, lang);
    const phone = phoneWords(practice.phone);
    // A voicemail gets a message; a person gets asked.
    if (/^machine/.test(String(req.body.AnsweredBy || ''))) {
      if (c.call) await db.run("UPDATE calls SET answered_by = 'machine', outcome = 'voicemail' WHERE id = ?", c.call.id);
      for (const v of visits) if (v.status === 'scheduled') await db.run("UPDATE appointments SET confirmed_via = 'left_message' WHERE id = ? AND status = 'scheduled'", v.id);
      return res.type('text/xml').send(twiml(say(lang, lang === 'es'
        ? `Hola, le llama ${practice.name} para recordarle la cita de ${names} ${when}. Por favor llámenos al ${phone} para confirmar. Gracias.`
        : `Hello, this is ${practice.name} with a reminder of ${names}'s appointment on ${when}. Please call us at ${phone} to confirm, or reply to our text. Thank you.`) + '<Hangup/>'));
    }
    if (c.call) await db.run("UPDATE calls SET answered_by = 'human', status = 'in-progress' WHERE id = ?", c.call.id);
    const attempt = Number(req.query.try || 1);
    const action = `${config.appUrl}/api/webhooks/twilio/voice/confirm/${req.params.token}/answer?try=${attempt}`;
    const prompt = lang === 'es'
      ? `Hola, le llama ${practice.name}. ${names} tiene cita ${when} con ${visits[0].provider_name}. Para confirmar, oprima 1 o diga sí. Si necesita otro horario, oprima 2 o diga cambiar.`
      : `Hello, this is ${practice.name}. ${names} ${who.length > 1 ? 'have appointments' : 'has an appointment'} on ${when} with ${visits[0].provider_name}. To confirm, press 1 or say yes. If you need a different time, press 2 or say change.`;
    res.type('text/xml').send(twiml(
      `<Gather input="dtmf speech" numDigits="1" timeout="6" speechTimeout="auto" language="${VOICE[lang][1]}" hints="yes, confirm, change, reschedule, cancel" action="${xml(action)}" method="POST">${say(lang, prompt)}</Gather>`
      + say(lang, lang === 'es' ? `No le escuchamos. Por favor llámenos al ${phone}. Adiós.` : `We didn't hear you. Please call us at ${phone}. Goodbye.`),
    ));
  });

  r.post('/api/webhooks/twilio/voice/confirm/:token/answer', form, async (req, res) => {
    if (!signed(req)) return reject(res);
    const c = await callFor(req.params.token);
    if (!c) return res.type('text/xml').send(twiml('<Hangup/>'));
    const { visits, practice, lang, call } = c;
    const heard = `${req.body.Digits || ''} ${String(req.body.SpeechResult || '').toLowerCase()}`;
    const yes = /\b1\b|yes|yeah|yep|confirm|sure|correct|s[ií]\b|okay|ok\b/.test(heard);
    const change = /\b2\b|change|resched|cancel|another|different|cambi|otro/.test(heard);
    if (yes && !change) {
      for (const v of visits) {
        await db.run("UPDATE appointments SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, datetime('now')), confirmed_via = 'call' WHERE id = ? AND status IN ('scheduled','confirmed')", v.id);
      }
      if (call) await db.run("UPDATE calls SET outcome = 'confirmed' WHERE id = ?", call.id);
      publish(practice.id, { type: 'schedule', dates: [visits[0].start_time.slice(0, 10)], source: 'call' });
      return res.type('text/xml').send(twiml(say(lang, lang === 'es' ? '¡Gracias! Quedó confirmada. Lo esperamos. Adiós.' : "Thank you, you're confirmed. We'll see you then. Goodbye.") + '<Hangup/>'));
    }
    if (change) {
      const now = await practiceNow(db, practice.id);
      const v = visits[0];
      await insert(db, 'tasks', {
        practice_id: practice.id, patient_id: v.patient_id, priority: 'high', due_date: now.slice(0, 10),
        title: `${v.first_name} asked for a new time on the confirmation call (${v.start_time}). Call back to reschedule.`,
      });
      if (call) await db.run("UPDATE calls SET outcome = 'reschedule' WHERE id = ?", call.id);
      publish(practice.id, { type: 'tasks' });
      return res.type('text/xml').send(twiml(say(lang, lang === 'es' ? 'Entendido. Alguien de la oficina le llamará para buscar otro horario. Adiós.' : 'Got it. Someone from the office will call you back to find a new time. Goodbye.') + '<Hangup/>'));
    }
    const attempt = Number(req.query.try || 1);
    if (attempt < 2) return res.type('text/xml').send(twiml(`<Redirect method="POST">${xml(`${config.appUrl}/api/webhooks/twilio/voice/confirm/${req.params.token}?try=${attempt + 1}`)}</Redirect>`));
    if (call) await db.run("UPDATE calls SET outcome = 'no_answer' WHERE id = ?", call.id);
    return res.type('text/xml').send(twiml(say(lang, lang === 'es' ? `Por favor llámenos al ${phoneWords(practice.phone)}. Adiós.` : `Please call us at ${phoneWords(practice.phone)}. Goodbye.`) + '<Hangup/>'));
  });

  // How each call ended (Twilio's status callback).
  r.post('/api/webhooks/twilio/call-status', form, async (req, res) => {
    if (!signed(req)) return reject(res);
    const sid = String(req.body.CallSid || '');
    if (sid) {
      await db.run("UPDATE calls SET status = ?, duration = COALESCE(?, duration), answered_by = COALESCE(answered_by, ?), ended_at = CASE WHEN ? IN ('completed','busy','failed','no-answer','canceled') THEN datetime('now') ELSE ended_at END WHERE provider_id = ?",
        String(req.body.CallStatus || 'unknown'), req.body.CallDuration ? Number(req.body.CallDuration) : null, req.body.AnsweredBy || null, String(req.body.CallStatus || ''), sid);
    }
    res.status(204).end();
  });
  return r;
}
