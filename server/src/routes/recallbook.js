import express, { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { HttpError, rateLimit } from '../auth.js';
import { insert, audit, practiceNow, normalizeDateTime, hashToken } from '../util.js';
import { setActor } from '../actor.js';
import { raiseIssue } from '../issues.js';
import { publish } from '../events.js';
import { emitAppointment } from '../webhooks.js';
import { sendVisitsMessage, sendMessage } from '../messaging.js';
import { typeDuration } from '../patterns.js';
import { openSlots, validateAppt, linkRecalls, addMinutes } from './schedule.js';
import { twilioSignature } from './sms.js';
import { verifyLink, stopEnrollment, cadenceType, addDays } from '../cadence.js';

// RC2 — booking straight from a recall message. The link (signed, expiring, one family's) opens a page with
// real open times that fit the visit's length and the patient's own hygienist (office hours, provider hours,
// blocks and held requests all respected through openSlots), books with one more tap, and confirms by
// text/email. Mounted under /api/public, so everything done here is recorded as the patient.

const SEARCH_DAYS = 60;
const DAYS_SHOWN = 4;
const PER_DAY = 8;
const ACTIVE = ['scheduled', 'confirmed', 'checked_in', 'in_chair'];

// Everything about the link's people needed to find and book their times.
async function loadLink(db, secret, token) {
  const link = await verifyLink(db, secret, token);
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', link.practice_id);
  const ids = link.enrollment_ids.filter(Number.isInteger);
  if (!ids.length) throw new HttpError(404, 'This link is not valid');
  const enrollments = await db.all(`SELECT * FROM cadence_enrollments WHERE practice_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, practice.id, ...ids);
  const providers = await db.all('SELECT id, name, type FROM providers WHERE practice_id = ? AND active = 1 ORDER BY name', practice.id);
  const members = [];
  for (const e of enrollments) {
    const patient = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', e.patient_id, practice.id);
    if (!patient) continue;
    const recall = e.source_type === 'recall' ? await db.get('SELECT * FROM recalls WHERE id = ? AND practice_id = ?', e.source_id, practice.id) : null;
    const rtype = recall ? await db.get('SELECT * FROM recall_types WHERE practice_id = ? AND key = ?', practice.id, recall.type) : null;
    const apptType = rtype?.appointment_type_id ? await db.get('SELECT * FROM appointment_types WHERE id = ? AND practice_id = ? AND active = 1', rtype.appointment_type_id, practice.id) : null;
    // Who can see them: the visit type's kind of provider (hygiene by default), their own hygienist first.
    const kind = apptType?.provider_type || 'hygienist';
    const fits = providers.some((p) => p.type === kind) ? providers.filter((p) => p.type === kind) : providers;
    const own = fits.find((p) => p.id === patient.primary_hygienist_id) || fits.find((p) => p.id === patient.primary_provider_id) || null;
    const { visit } = await cadenceType('recall').describe(db, [e]);
    members.push({
      e, patient, recall, rtype, apptType, own, providers: own ? [own, ...fits.filter((p) => p.id !== own.id)] : fits, visit,
      durationFor: (pid) => typeDuration(apptType, pid) || apptType?.duration || 60,
    });
  }
  if (!members.length) throw new HttpError(404, 'This link is not valid');
  return { link, practice, members };
}

const bookedVisit = async (db, e) => (e.booked_appointment_id ? db.get(`SELECT a.id, a.start_time, a.status, pv.name AS provider_name FROM appointments a JOIN providers pv ON pv.id = a.provider_id WHERE a.id = ? AND a.status IN (${ACTIVE.map(() => '?').join(',')})`, e.booked_appointment_id, ...ACTIVE) : null);

// Open times for one person on one day: { providerId: Set(starts) } over the providers they can see.
async function openFor(db, practice, m, date, after) {
  const out = new Map();
  for (const p of m.providers.slice(0, 12)) {
    const slots = await openSlots(db, practice.id, p.id, date, { duration: m.durationFor(p.id), step: 10, after, typeId: m.apptType?.id ?? null, locationId: m.patient.location_id ?? null });
    if (slots.length) out.set(p.id, new Set(slots));
  }
  return out;
}

// Options on a day: a single start for one person, or back-to-back starts for a family (the next person
// starts when the one before finishes; the same provider when they're free, else another who fits).
async function optionsOn(db, practice, members, date, after) {
  const open = [];
  for (const m of members) open.push(await openFor(db, practice, m, date, after));
  if (open.some((o) => !o.size)) return [];
  const starts = [...new Set([...open[0].values()].flatMap((s) => [...s]))].filter((s) => /:(00|30)$/.test(s)).sort();
  const options = [];
  for (const start of starts) {
    let t = start;
    let prev = null;
    const items = [];
    for (const [i, m] of members.entries()) {
      const order = prev ? [prev, ...m.providers.map((p) => p.id).filter((id) => id !== prev)] : m.providers.map((p) => p.id);
      const pid = order.find((id) => open[i].get(id)?.has(t));
      if (!pid) break;
      const provider = m.providers.find((p) => p.id === pid);
      items.push({ enrollment_id: m.e.id, first_name: m.patient.preferred_name || m.patient.first_name, start: t, provider_id: pid, provider_name: provider.name, minutes: m.durationFor(pid) });
      prev = pid;
      t = addMinutes(t, m.durationFor(pid));
    }
    if (items.length === members.length) options.push({ start, items });
  }
  // A spread through the day rather than the first eight in the morning.
  if (options.length <= PER_DAY) return options;
  const step = options.length / PER_DAY;
  return Array.from({ length: PER_DAY }, (_, i) => options[Math.floor(i * step)]);
}

export default function recallBookRoutes({ db, messenger, config = {}, secret }) {
  const r = Router();
  const reader = rateLimit({ windowMs: 60_000, max: 60, name: 'recall-book' });
  const slotReader = rateLimit({ windowMs: 60_000, max: 20, name: 'recall-book-slots' });
  const booker = rateLimit({ windowMs: 60 * 60_000, max: 20, name: 'recall-book-post' });
  const asPatient = () => setActor({ source: 'patient', actor: 'Patient (recall link)' });

  r.get('/recall/:token', reader, async (req, res) => {
    asPatient();
    const { link, practice, members } = await loadLink(db, secret, req.params.token);
    if (!link.opened_at) await db.run("UPDATE cadence_links SET opened_at = datetime('now') WHERE id = ?", link.id);
    const today = (await practiceNow(db, practice.id)).slice(0, 10);
    const people = [];
    for (const m of members) {
      people.push({
        enrollment_id: m.e.id, first_name: m.patient.preferred_name || m.patient.first_name, visit: m.visit, minutes: m.durationFor(m.own?.id ?? m.providers[0]?.id),
        provider_name: m.own?.name || null, due_date: m.e.anchor_date, booked: await bookedVisit(db, m.e), open: m.e.status === 'active',
      });
    }
    res.json({
      practice: { name: practice.name, phone: practice.phone, address: practice.address, city: practice.city, state: practice.state, zip: practice.zip },
      today, people, language: members.find((m) => m.patient.id === link.recipient_id)?.patient.language || null,
    });
  });

  // ?from=YYYY-MM-DD&enrollment_id=<one person only>: the next few days with openings.
  r.get('/recall/:token/slots', reader, slotReader, async (req, res) => {
    asPatient();
    const { practice, members } = await loadLink(db, secret, req.params.token);
    const want = req.query.enrollment_id ? Number(req.query.enrollment_id) : null;
    const chosen = members.filter((m) => m.e.status === 'active' && (!want || m.e.id === want));
    if (!chosen.length) return res.json({ days: [] });
    const now = await practiceNow(db, practice.id);
    const today = now.slice(0, 10);
    // Not before the due date (insurance pays for cleanings on its schedule), and never in the past.
    let from = [today, ...chosen.map((m) => m.e.anchor_date)].sort().at(-1);
    if (req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from)) && req.query.from > from) from = String(req.query.from);
    if (from > addDays(today, 365)) throw new HttpError(400, 'Choose a date within the next year');
    // Their own hygienist's times; everyone who fits only if that person has nothing in the next weeks (or ?any=1).
    const search = async (people) => {
      const days = [];
      let d = from;
      for (let i = 0; i < SEARCH_DAYS && days.length < DAYS_SHOWN; i++, d = addDays(d, 1)) {
        const options = await optionsOn(db, practice, people, d, d === today ? now : null);
        if (options.length) days.push({ date: d, options });
      }
      return days;
    };
    const ownOnly = chosen.map((m) => (m.own ? { ...m, providers: [m.own] } : m));
    const any = req.query.any === '1' || !chosen.some((m) => m.own);
    let days = any ? [] : await search(ownOnly);
    const widened = !days.length;
    if (widened) days = await search(chosen);
    res.json({ from, days, own_provider: !widened, next_from: days.length ? addDays(days.at(-1).date, 1) : addDays(from, SEARCH_DAYS), together: chosen.length > 1 });
  });

  // { items: [{ enrollment_id, start, provider_id }], key }: books the visits (one, or a family's back-to-back).
  // The same key again (a double tap, a retry) returns the same booking.
  r.post('/recall/:token/book', booker, async (req, res) => {
    asPatient();
    const { link, practice, members } = await loadLink(db, secret, req.params.token);
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items.slice(0, 8) : [];
    if (!items.length) throw new HttpError(400, 'Choose a time');
    const key = String(body.key || JSON.stringify(items)).slice(0, 200);
    const prior = await db.get('SELECT * FROM cadence_bookings WHERE link_id = ? AND request_key = ?', link.id, key);
    if (prior) return res.json(await result(JSON.parse(prior.appointment_ids), true));

    const now = await practiceNow(db, practice.id);
    const plan = [];
    for (const it of items) {
      const m = members.find((x) => x.e.id === Number(it.enrollment_id));
      if (!m) throw new HttpError(400, 'That person isn’t on this link');
      if (plan.some((p) => p.m === m)) throw new HttpError(400, 'Each person once, please');
      const already = await bookedVisit(db, m.e);
      if (already) throw new HttpError(409, `${m.patient.first_name} is already booked — see you then!`, { booked: already });
      if (m.e.status !== 'active') throw new HttpError(409, `Please call us to book ${m.patient.first_name}’s visit`);
      const start = normalizeDateTime(it.start, 'start');
      if (start <= now) throw new HttpError(400, 'Please choose a future time');
      if (start.slice(0, 10) < [now.slice(0, 10), m.e.anchor_date].sort().at(-1)) throw new HttpError(400, 'Please choose a time on or after the due date');
      const provider = m.providers.find((p) => p.id === Number(it.provider_id));
      if (!provider) throw new HttpError(400, 'Choose one of the times shown');
      const minutes = m.durationFor(provider.id);
      const free = await openSlots(db, practice.id, provider.id, start.slice(0, 10), { duration: minutes, step: 10, typeId: m.apptType?.id ?? null, locationId: m.patient.location_id ?? null });
      if (!free.includes(start)) throw new HttpError(409, 'That time was just taken — please pick another');
      plan.push({ m, provider, start, minutes });
    }
    // Two people on one provider must not overlap.
    for (const a of plan) for (const b of plan) if (a !== b && a.provider.id === b.provider.id && a.start < addMinutes(b.start, b.minutes) && b.start < addMinutes(a.start, a.minutes)) throw new HttpError(400, 'Those times overlap');

    let ids;
    try {
      ids = await db.tx(async () => {
        const out = [];
        for (const p of plan) {
          const row = {
            patient_id: p.m.patient.id, provider_id: p.provider.id, start_time: p.start, end_time: addMinutes(p.start, p.minutes), status: 'scheduled',
            reason: p.m.apptType?.name || p.m.rtype?.name || 'Recall visit', appointment_type_id: p.m.apptType?.id ?? null, location_id: p.m.patient.location_id ?? null,
            notes: 'Booked by the patient from a recall link', ...(p.m.apptType?.pattern ? { pattern: p.m.apptType.pattern } : {}),
          };
          await validateAppt(db, practice.id, row);
          out.push(await insert(db, 'appointments', { ...row, practice_id: practice.id }));
        }
        await db.run('INSERT INTO cadence_bookings (practice_id, link_id, request_key, appointment_ids) VALUES (?, ?, ?, ?)', practice.id, link.id, key, JSON.stringify(out));
        return out;
      });
    } catch (err) {
      // The same request raced itself: the first one's booking stands.
      const again = await db.get('SELECT * FROM cadence_bookings WHERE link_id = ? AND request_key = ?', link.id, key);
      if (again) return res.json(await result(JSON.parse(again.appointment_ids), true));
      if (err.status === 409) throw new HttpError(409, 'That time was just taken — please pick another');
      throw err;
    }
    await db.run("UPDATE cadence_links SET booked_at = COALESCE(booked_at, datetime('now')) WHERE id = ?", link.id);
    for (const [i, p] of plan.entries()) {
      await linkRecalls(db, practice.id, ids[i]);
      await stopEnrollment(db, p.m.e, { reason: 'booked', appointmentId: ids[i], via: 'self_schedule', req: { ip: req.ip, user: { practice_id: practice.id, id: null } } });
      await audit(db, { ip: req.ip, user: { practice_id: practice.id, id: null } }, 'recall.self_book', 'appointments', ids[i], {
        enrollment_id: p.m.e.id, link_id: link.id, start: p.start, provider_id: p.provider.id, family: plan.length > 1,
      }, { patientId: p.m.patient.id, source: 'patient', actor: 'Patient (recall link)' });
      await emitAppointment(db, ids[i], 'appointment.created');
    }
    publish(practice.id, { type: 'schedule', dates: [...new Set(plan.map((p) => p.start.slice(0, 10)))], source: 'patient' });
    if (messenger) {
      const msg = await sendVisitsMessage(db, messenger, { appointmentIds: ids, kind: 'booking_confirmation', appUrl: config.appUrl, recipientId: link.recipient_id, fallback: true });
      if (!msg) {
        await raiseIssue(db, {
          practiceId: practice.id, kind: 'message', key: `recall-book-confirm:${link.id}`, role: 'front_desk', entity: 'appointments', entityId: ids[0], patientId: link.recipient_id,
          title: 'A patient booked from a recall link but has no way to get the confirmation — call to confirm',
        });
      }
    }
    res.status(201).json(await result(ids, false));
  });

  async function result(ids, repeat) {
    const visits = await db.all(
      `SELECT a.id, a.start_time, a.end_time, a.status, p.first_name, pv.name AS provider_name FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN providers pv ON pv.id = a.provider_id
       WHERE a.id IN (${ids.map(() => '?').join(',')}) ORDER BY a.start_time`, ...ids,
    );
    return { booked: true, repeat, visits };
  }

  return r;
}

// ---- The AI recall call (a cadence ai_call step) ----
// What Twilio asks as the call goes. The caller hears who's due and can press 1 for a text with their booking
// link, 2 for a call back from the office, or 3 to stop recall calls and messages. A voicemail gets a short
// message. The call was placed by the AI (calls.source 'ai'); what the person chooses is recorded as theirs.
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const say = (text) => `<Say voice="Polly.Joanna-Neural" language="en-US">${xml(text)}</Say>`;
const twiml = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
const phoneWords = (p) => String(p || '').replace(/\D/g, '').split('').join(' ');

export function recallVoiceWebhooks({ db, config = {}, messenger, secret }) {
  const r = Router();
  const form = express.urlencoded({ extended: false, limit: '64kb' });
  const signed = (req) => {
    if (!config.twilioAuthToken) return false;
    const expected = Buffer.from(twilioSignature(config.twilioAuthToken, `${config.appUrl}${req.originalUrl}`, req.body));
    const given = Buffer.from(String(req.headers['x-twilio-signature'] || ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const reject = (res) => res.status(403).type('text/xml').send(twiml(''));
  const callFor = async (token) => {
    const call = await db.get("SELECT * FROM calls WHERE token_hash = ? AND purpose = 'recall' ORDER BY id DESC LIMIT 1", hashToken(token));
    if (!call) return null;
    let loaded;
    try {
      loaded = await loadLink(db, secret, token);
    } catch {
      return null;
    }
    const run = await db.get('SELECT * FROM cadence_runs WHERE call_id = ?', call.id);
    return { call, run, ...loaded };
  };
  const note = async (c, outcome) => {
    await db.run('UPDATE calls SET outcome = ? WHERE id = ?', outcome, c.call.id);
    if (c.run) await db.run('UPDATE cadence_runs SET outcome = ?, outcome_at = datetime(\'now\') WHERE id = ?', outcome, c.run.id);
  };

  r.post('/api/webhooks/twilio/voice/recall/:token', form, async (req, res) => {
    setActor({ source: 'patient', actor: 'Patient (recall call)' });
    if (!signed(req)) return reject(res);
    const c = await callFor(req.params.token);
    if (!c) return res.type('text/xml').send(twiml('<Hangup/>'));
    const names = [...new Set(c.members.map((m) => m.patient.preferred_name || m.patient.first_name))];
    const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are` : `${names[0]} is`;
    const visit = c.members[0].visit;
    if (/^machine/.test(String(req.body.AnsweredBy || ''))) {
      await db.run("UPDATE calls SET answered_by = 'machine' WHERE id = ?", c.call.id);
      await note(c, 'voicemail');
      return res.type('text/xml').send(twiml(say(`Hello, this is an automated call from ${c.practice.name}. ${who} due for a ${visit}. You can book online from the link in our text, or call us at ${phoneWords(c.practice.phone)}. Thank you.`) + '<Hangup/>'));
    }
    await db.run("UPDATE calls SET answered_by = 'human', status = 'in-progress' WHERE id = ?", c.call.id);
    const action = `${config.appUrl}/api/webhooks/twilio/voice/recall/${req.params.token}/answer`;
    res.type('text/xml').send(twiml(
      `<Gather input="dtmf speech" numDigits="1" timeout="6" speechTimeout="auto" language="en-US" hints="text, call me, stop" action="${xml(action)}" method="POST">`
      + say(`Hello, this is an automated assistant calling from ${c.practice.name}. ${who} due for a ${visit}. To get a text with a link to pick a time, press 1. To have someone from the office call you back, press 2. To stop these reminders, press 3.`)
      + '</Gather>' + say(`We didn't hear a choice. Please call us at ${phoneWords(c.practice.phone)}. Goodbye.`),
    ));
  });

  r.post('/api/webhooks/twilio/voice/recall/:token/answer', form, async (req, res) => {
    setActor({ source: 'patient', actor: 'Patient (recall call)' });
    if (!signed(req)) return reject(res);
    const c = await callFor(req.params.token);
    if (!c) return res.type('text/xml').send(twiml('<Hangup/>'));
    const heard = `${req.body.Digits || ''} ${String(req.body.SpeechResult || '').toLowerCase()}`;
    const recipient = await db.get('SELECT * FROM patients WHERE id = ?', c.link.recipient_id);
    const today = (await practiceNow(db, c.practice.id)).slice(0, 10);
    if (/\b3\b|stop|don.?t call|no more/.test(heard)) {
      for (const m of c.members) await stopEnrollment(db, m.e, { reason: 'declined', via: 'call', req: { ip: null, user: { practice_id: c.practice.id, id: null } } });
      await note(c, 'declined');
      return res.type('text/xml').send(twiml(say('Okay, we won’t send any more reminders. Goodbye.') + '<Hangup/>'));
    }
    if (/\b1\b|text|link/.test(heard) && recipient?.phone && messenger) {
      const msg = await sendMessage(db, messenger, {
        practiceId: c.practice.id, patientId: recipient.id, channel: 'sms', to: recipient.phone, kind: 'recall',
        body: `Here’s your link to book with ${c.practice.name}: ${config.appUrl}/rb/${req.params.token}`,
      });
      await note(c, msg.status === 'sent' ? 'link_texted' : 'link_failed');
      if (msg.status === 'sent') return res.type('text/xml').send(twiml(say('Great, we just texted you the link. Goodbye.') + '<Hangup/>'));
    }
    // A person asked for a call (or the text couldn't go): a task for the team.
    const taskId = await insert(db, 'tasks', {
      practice_id: c.practice.id, patient_id: c.members[0].patient.id, priority: 'high', due_date: today,
      title: `Call back ${recipient?.first_name || 'patient'} to book ${c.members[0].visit} (asked on the recall call)`.slice(0, 200),
    });
    publish(c.practice.id, { type: 'tasks' });
    await note(c, 'callback_requested');
    if (c.run) await db.run('UPDATE cadence_runs SET task_id = COALESCE(task_id, ?) WHERE id = ?', taskId, c.run.id);
    return res.type('text/xml').send(twiml(say('Got it. Someone from the office will call you back soon. Goodbye.') + '<Hangup/>'));
  });

  return r;
}
