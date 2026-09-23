import { insert, friendlyDateTime, newToken, localNow, zonedToUtc } from './util.js';
import { templatesFor, renderTemplate, patientLang, fixedText, subjectFor } from './templates.js';

// Delivery drivers. "log" records the message without sending it (development / not yet configured).
export function createMessenger({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const smsDriver = env.SMS_DRIVER || (env.TWILIO_ACCOUNT_SID ? 'twilio' : 'log');
  const emailDriver = env.EMAIL_DRIVER || (env.SENDGRID_API_KEY ? 'sendgrid' : 'log');
  // Delivery reports come back to the server when it has a public https address.
  const base = (env.APP_URL || env.RENDER_EXTERNAL_URL || (env.VERCEL_PROJECT_PRODUCTION_URL && `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`) || '').replace(/\/$/, '');
  const statusCallback = base.startsWith('https://') ? `${base}/api/webhooks/twilio/status` : null;

  async function sendSms(to, body) {
    if (smsDriver === 'log') return { provider_id: 'log' };
    if (smsDriver !== 'twilio') throw new Error(`Unknown SMS_DRIVER ${smsDriver}`);
    const sid = env.TWILIO_ACCOUNT_SID;
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: toE164(to), From: env.TWILIO_FROM, Body: body, ...(statusCallback ? { StatusCallback: statusCallback } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || `Twilio error ${res.status}`), { code: data.code });
    return { provider_id: data.sid };
  }

  // Plain text, plus an HTML version, attachments (a calendar invite) and headers (one-click unsubscribe)
  // when given. The message id rides along so delivery reports find their message.
  async function sendEmail(to, subject, body, { html, attachments, headers, messageId } = {}) {
    if (emailDriver === 'log') return { provider_id: 'log' };
    if (emailDriver !== 'sendgrid') throw new Error(`Unknown EMAIL_DRIVER ${emailDriver}`);
    const res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }], ...(messageId ? { custom_args: { dm_message_id: String(messageId) } } : {}) }],
        from: { email: env.EMAIL_FROM, ...(env.EMAIL_FROM_NAME ? { name: env.EMAIL_FROM_NAME } : {}) },
        subject,
        content: [{ type: 'text/plain', value: body }, ...(html ? [{ type: 'text/html', value: html }] : [])],
        ...(attachments?.length ? { attachments: attachments.map((a) => ({ filename: a.filename, type: a.type, disposition: 'attachment', content: Buffer.from(a.content).toString('base64') })) } : {}),
        ...(headers ? { headers } : {}),
      }),
    });
    if (!res.ok) throw new Error(`SendGrid error ${res.status}: ${await res.text().catch(() => '')}`.trim());
    return { provider_id: res.headers.get('x-message-id') || 'sendgrid' };
  }

  // An outbound phone call: Twilio fetches what to say from `url` once someone (or a voicemail) answers.
  async function call(to, url, { statusCallback: callback } = {}) {
    if (smsDriver === 'log') return { provider_id: `log-call-${Date.now()}` };
    const sid = env.TWILIO_ACCOUNT_SID;
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        To: toE164(to), From: env.TWILIO_VOICE_FROM || env.TWILIO_FROM, Url: url, MachineDetection: 'DetectMessageEnd',
        ...(callback || (base.startsWith('https://') ? { StatusCallback: `${base}/api/webhooks/twilio/call-status` } : {})),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || `Twilio error ${res.status}`), { code: data.code });
    return { provider_id: data.sid };
  }

  return {
    status: { sms: smsDriver, email: emailDriver, voice: smsDriver },
    send: ({ channel, to, subject, body, ...extra }) => (channel === 'sms' ? sendSms(to, body) : sendEmail(to, subject || 'Message from your dental office', body, extra)),
    call,
  };
}

export function toE164(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (String(phone).trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

// How to reach a patient: by text unless they prefer email, skipping a channel they turned off or whose
// number or address stopped working (a landline, a bounced email). With a channel asked for, only that one,
// unless `fallback` allows the other.
const canText = (p) => !!(p.phone && p.sms_opt_in && !p.sms_bad_at);
const canEmail = (p) => !!(p.email && p.email_opt_in && !p.email_bad_at);
export function preferredChannel(patient, requested, { fallback = false } = {}) {
  const sms = canText(patient) ? { channel: 'sms', to: patient.phone } : null;
  const email = canEmail(patient) ? { channel: 'email', to: patient.email } : null;
  if (requested === 'sms') return sms || (fallback ? email : null);
  if (requested === 'email') return email || (fallback ? sms : null);
  return patient.preferred_contact === 'email' ? email || sms : sms || email;
}

// A number that can't take texts (a landline) or an email address that bounces: every patient on the
// practice with that number or address falls back to the other channel until someone edits it.
export async function markBad(db, practiceId, channel, to, reason) {
  const key = optOutAddress(channel, to);
  if (!key) return 0;
  const col = channel === 'sms' ? 'phone' : 'email';
  const hits = (await db.all(`SELECT id, ${col} AS v FROM patients WHERE practice_id = ? AND ${col} IS NOT NULL`, practiceId)).filter((p) => optOutAddress(channel, p.v) === key);
  for (const p of hits) await db.run(`UPDATE patients SET ${channel}_bad_at = datetime('now'), ${channel}_bad_reason = ? WHERE id = ?`, String(reason).slice(0, 200), p.id);
  return hits.length;
}

// Opt-outs are keyed by the address: the last 10 digits of a phone, or the lower-cased email.
export const optOutAddress = (channel, to) => (channel === 'sms' ? String(to || '').replace(/\D/g, '').slice(-10) : String(to || '').trim().toLowerCase());
export async function recordOptOut(db, practiceId, channel, to, source) {
  const address = optOutAddress(channel, to);
  if (!address) return;
  if (!(await db.get('SELECT id FROM message_opt_outs WHERE practice_id = ? AND channel = ? AND address = ?', practiceId, channel, address))) {
    await insert(db, 'message_opt_outs', { practice_id: practiceId, channel, address, source });
  }
}
export async function clearOptOut(db, practiceId, channel, to) {
  await db.run('DELETE FROM message_opt_outs WHERE practice_id = ? AND channel = ? AND address = ?', practiceId, channel, optOutAddress(channel, to));
}
export async function isOptedOutAddress(db, practiceId, channel, to) {
  return !!(await db.get('SELECT id FROM message_opt_outs WHERE practice_id = ? AND channel = ? AND address = ?', practiceId, channel, optOutAddress(channel, to)));
}

// Sign-in codes are only ever sent because the patient asked for one, so they're exempt.
const OPT_OUT_EXEMPT = new Set(['portal_code']);
// Why a message can't go: the patient turned the channel off, or the address itself opted out (STOP).
async function blockedReason(db, { practiceId, patientId, channel, to, kind }) {
  if (channel === 'portal' || OPT_OUT_EXEMPT.has(kind)) return null;
  if (patientId) {
    const p = await db.get('SELECT sms_opt_in, email_opt_in FROM patients WHERE id = ?', patientId);
    if (p && channel === 'sms' && !p.sms_opt_in) return 'Patient has opted out of text messages';
    if (p && channel === 'email' && !p.email_opt_in) return 'Patient has opted out of email';
  }
  if (await isOptedOutAddress(db, practiceId, channel, to)) return channel === 'sms' ? 'This number replied STOP — they must text START to receive texts again' : 'This address unsubscribed';
  return null;
}

// Records a message, attempts delivery, and stores the outcome. Never throws for delivery errors.
// Every outbound text and email passes the opt-out check here, whatever sent it.
export async function sendMessage(db, messenger, { practiceId, patientId, appointmentId, channel, to, subject, body, kind = 'custom', userId, html, attachments, headers }) {
  const blocked = await blockedReason(db, { practiceId, patientId, channel, to, kind });
  const id = await insert(db, 'messages', {
    practice_id: practiceId, patient_id: patientId ?? null, appointment_id: appointmentId ?? null,
    channel, to_address: to, subject: subject ?? null, body, kind, created_by: userId ?? null,
    ...(blocked ? { status: 'blocked', error: blocked } : {}),
  });
  if (blocked) return await db.get('SELECT * FROM messages WHERE id = ?', id);
  try {
    const { provider_id } = await messenger.send({ channel, to, subject, body, html, attachments, headers, messageId: id });
    await db.run("UPDATE messages SET status = 'sent', provider_id = ?, sent_at = datetime('now') WHERE id = ?", provider_id, id);
  } catch (err) {
    await db.run("UPDATE messages SET status = 'failed', error = ?, error_code = ? WHERE id = ?", String(err.message).slice(0, 500), err.code ? String(err.code) : null, id);
    // Twilio refuses some numbers outright: not a mobile number, or not a valid one. Stop texting them.
    if (channel === 'sms' && patientId && ['21614', '21211', '21612'].includes(String(err.code))) await markBad(db, practiceId, 'sms', to, String(err.code) === '21614' ? 'Not a mobile number' : 'Not a valid number');
  }
  return await db.get('SELECT * FROM messages WHERE id = ?', id);
}

const ACTIVE = ['scheduled', 'confirmed'];
const yearsOld = (dob, today = new Date().toISOString().slice(0, 10)) => {
  const [y, m, d] = String(dob).slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
};

// Who hears about a patient's visits: the patient, or the guarantor (the parent) for a child under 18 or
// for someone with no phone or email of their own.
export async function recipientFor(db, patient) {
  const minor = patient.dob && /^\d{4}-\d{2}-\d{2}/.test(patient.dob) && yearsOld(patient.dob) < 18;
  if (patient.guarantor_id && patient.guarantor_id !== patient.id && (minor || !preferredChannel(patient))) {
    const g = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', patient.guarantor_id, patient.practice_id);
    if (g && preferredChannel(g)) return g;
  }
  return patient;
}

// Sending hours in the practice's time zone (08:00-20:00 unless changed; the same start and end means any time).
export function withinSendHours(practice, local) {
  const from = practice.send_from || '08:00';
  const until = practice.send_until || '20:00';
  if (from === until) return true;
  const hm = local.slice(11, 16);
  return from < until ? hm >= from && hm < until : hm >= from || hm < until;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dayOf = (dt, lang) => {
  const d = new Date(`${dt.slice(0, 10)}T12:00:00Z`);
  return lang === 'es'
    ? d.toLocaleDateString('es-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const timeOf = (dt, lang) => {
  const [h, m] = dt.slice(11, 16).split(':').map(Number);
  const t = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`;
  return lang === 'es' ? `${t} ${h < 12 ? 'a. m.' : 'p. m.'}` : `${t} ${h < 12 ? 'AM' : 'PM'}`;
};
// "Tue, Sep 29: Emma at 2:00 PM with Dr. Lee, Liam at 3:00 PM with Dr. Lee" — first names and times only.
export function visitsText(visits, lang = 'en', { providers = true } = {}) {
  const t = fixedText(lang);
  const days = [...new Set(visits.map((v) => v.start_time.slice(0, 10)))].sort();
  return days.map((day) => `${dayOf(day, lang)}: ${visits.filter((v) => v.start_time.startsWith(day))
    .map((v) => `${v.first_name} ${lang === 'es' ? 'a las' : 'at'} ${timeOf(v.start_time, lang)}${providers ? ` ${t.with} ${v.provider_name}` : ''}`).join(', ')}`).join('; ');
}

const address = (pr) => [pr.address, [pr.city, pr.state].filter(Boolean).join(', '), pr.zip].filter(Boolean).join(', ');
export const mapsUrl = (pr) => (address(pr) ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${pr.name}, ${address(pr)}`)}` : null);

// A calendar file for the visits. Times go out in UTC so every calendar puts them at the right hour.
// The title names the office, not the treatment.
export function visitsIcs(visits, practice, link) {
  const tz = practice.timezone || 'America/New_York';
  const utc = (dt) => zonedToUtc(tz, dt.slice(0, 10), dt.slice(11, 16)).replace(/[-: ]/g, '').replace(/^(\d{8})(\d{6})$/, '$1T$2Z');
  const text = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Dental Machine//Appointments//EN', 'METHOD:PUBLISH', 'CALSCALE:GREGORIAN'];
  for (const v of visits) {
    lines.push(
      'BEGIN:VEVENT', `UID:appointment-${v.id}@dentalmachine`, `DTSTAMP:${stamp}`, `SEQUENCE:${Math.floor(Date.now() / 60000) % 2147483647}`,
      `DTSTART:${utc(v.start_time)}`, `DTEND:${utc(v.end_time)}`,
      `SUMMARY:${text(`${visits.length > 1 ? `${v.first_name}: ` : ''}Dental appointment — ${practice.name}`)}`,
      ...(address(practice) ? [`LOCATION:${text(address(practice))}`] : []),
      `DESCRIPTION:${text(`With ${v.provider_name}.${practice.phone ? ` Questions or changes: ${practice.phone}.` : ''}${link ? ` ${link}` : ''}`)}`,
      ...(link ? [`URL:${link}`] : []),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Dental appointment', 'TRIGGER:-PT2H', 'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  // Lines longer than 75 octets are folded, as the format requires.
  return lines.map(fold).join('\r\n') + '\r\n';
}

// Calendar lines longer than 75 bytes continue on the next line after a space.
function fold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const BUTTON = {
  en: { confirm: 'Confirm', view: 'View appointment', directions: 'Directions', calendar: 'The calendar invite is attached.', unsub: 'Stop appointment emails' },
  es: { confirm: 'Confirmar', view: 'Ver la cita', directions: 'Cómo llegar', calendar: 'Se adjunta la invitación para su calendario.', unsub: 'No recibir correos de citas' },
};
// The email version: the same words, a button instead of a bare link, the office's address with directions,
// and a way to stop these emails.
function visitsHtml({ practice, text, link, asksConfirm, visits, lang, unsubscribeUrl, withIcs }) {
  const b = BUTTON[lang === 'es' ? 'es' : 'en'];
  const maps = mapsUrl(practice);
  const rows = visits.map((v) => `<tr><td style="padding:6px 12px 6px 0;font-weight:600">${esc(friendlyDateTime(v.start_time, lang))}</td><td style="padding:6px 0">${esc(v.first_name)} · ${esc(v.provider_name)}</td></tr>`).join('');
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:24px">
<tr><td style="font-size:18px;font-weight:700;padding-bottom:12px">${esc(practice.name)}</td></tr>
<tr><td style="font-size:15px;line-height:1.5;padding-bottom:16px">${esc(text)}</td></tr>
<tr><td><table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px">${rows}</table></td></tr>
<tr><td style="padding:20px 0 8px"><a href="${esc(link)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px">${esc(asksConfirm ? b.confirm : b.view)}</a></td></tr>
${address(practice) ? `<tr><td style="font-size:14px;color:#52606d;padding-top:12px">${esc(address(practice))}${maps ? ` · <a href="${esc(maps)}" style="color:#0f766e">${esc(b.directions)}</a>` : ''}${practice.phone ? ` · ${esc(practice.phone)}` : ''}</td></tr>` : ''}
${withIcs ? `<tr><td style="font-size:13px;color:#7b8794;padding-top:8px">${esc(b.calendar)}</td></tr>` : ''}
</table>
${unsubscribeUrl ? `<p style="font-size:12px;color:#9aa5b1;margin-top:16px"><a href="${esc(unsubscribeUrl)}" style="color:#9aa5b1">${esc(b.unsub)}</a></p>` : ''}
</td></tr></table></body></html>`;
}

const SUBJECT_EN = {
  reminder: (p) => `Your appointment at ${p}`, reminder_confirmed: (p) => `See you soon at ${p}`, booking_confirmation: (p) => `Your appointment at ${p}`,
  appointment_moved: (p) => `Your appointment at ${p} has moved`, family_reminder: (p) => `Your family's appointments at ${p}`, family_booked: (p) => `Your family's appointments at ${p}`,
};
// Which wording: a reminder that asks for a yes, a "see you then" once it's confirmed, a new or moved booking;
// and the family version when the message covers several people or goes to a parent.
function templateKey(kind, family, allConfirmed) {
  if (family) return kind === 'reminder' && !allConfirmed ? 'family_reminder' : 'family_booked';
  if (kind === 'reminder') return allConfirmed ? 'reminder_confirmed' : 'reminder';
  return kind === 'moved' ? 'appointment_moved' : 'booking_confirmation';
}
const ASKS_CONFIRM = new Set(['reminder', 'family_reminder', 'appointment_moved']);

// One message about one or more visits to one person — a reminder, a new or moved booking, or a "see you
// soon" for visits already confirmed — with one link that covers all of them. Links are kept per visit, so
// an earlier reminder's link still works after a newer one goes out.
export async function sendVisitsMessage(db, messenger, { appointmentIds, kind = 'reminder', appUrl, userId, channel: requested, fallback = false, recipientId }) {
  const ids = [...new Set(appointmentIds.map(Number))];
  if (!ids.length) return null;
  const visits = await db.all(
    `SELECT a.*, p.first_name, pv.name AS provider_name FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN providers pv ON pv.id = a.provider_id
     WHERE a.id IN (${ids.map(() => '?').join(',')}) ORDER BY a.start_time, a.id`, ...ids,
  );
  if (!visits.length) return null;
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', visits[0].practice_id);
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', visits[0].patient_id);
  const to = recipientId ? await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', recipientId, practice.id) : await recipientFor(db, patient);
  const target = to && preferredChannel(to, requested, { fallback });
  if (!target) return null;

  const { token, hash } = newToken();
  for (const v of visits) {
    await insert(db, 'confirm_links', { practice_id: practice.id, token_hash: hash, appointment_id: v.id, recipient_id: to.id, channel: target.channel, address: target.to });
  }
  const link = `${appUrl}/c/${token}`;
  const lang = patientLang(to);
  const t = fixedText(lang);
  const family = visits.length > 1 || to.id !== patient.id;
  const key = templateKey(kind, family, visits.every((v) => v.status === 'confirmed'));
  const vars = {
    first_name: to.first_name, practice: practice.name, when: friendlyDateTime(visits[0].start_time, lang), provider: visits[0].provider_name,
    visits: visitsText(visits, lang), link, phone: practice.phone || t.the_office,
  };
  let body = renderTemplate(templatesFor(practice, lang)[key], vars);
  const video = visits.find((v) => v.video_url);
  if (video) body += ` ${lang === 'es' ? 'Es una visita por video; entre aquí a la hora:' : 'This is a video visit — join here at the time:'} ${video.video_url}`;
  if (target.channel === 'sms' && !/\bSTOP\b/.test(body)) body += ASKS_CONFIRM.has(key) ? t.sms_reply : t.sms_stop;

  const email = target.channel === 'email' ? (() => {
    const unsubscribeUrl = `${appUrl}/api/public/confirm/${token}/stop-emails`;
    const withIcs = visits.every((v) => ACTIVE.includes(v.status));
    const plain = renderTemplate(templatesFor(practice, lang)[key], { ...vars, link: '' }).replace(/[\s:]+$/, '.').replace(/\.\.$/, '.');
    return {
      html: visitsHtml({ practice, text: plain, link, asksConfirm: ASKS_CONFIRM.has(key), visits, lang, unsubscribeUrl, withIcs }),
      attachments: withIcs ? [{ filename: 'appointment.ics', type: 'text/calendar', content: visitsIcs(visits, practice, link) }] : [],
      headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      text: `${body}\n\n${address(practice) ? `${practice.name} · ${address(practice)}\n` : ''}${BUTTON[lang === 'es' ? 'es' : 'en'].unsub}: ${unsubscribeUrl}`,
    };
  })() : null;

  const msg = await sendMessage(db, messenger, {
    practiceId: practice.id, patientId: visits[0].patient_id, appointmentId: visits[0].id, userId, kind: kind === 'moved' ? 'booking_confirmation' : kind,
    channel: target.channel, to: target.to, subject: subjectFor(lang, key, (SUBJECT_EN[key] || SUBJECT_EN.reminder)(practice.name), practice.name),
    body: email ? email.text : body, html: email?.html, attachments: email?.attachments, headers: email?.headers,
  });
  await db.run('UPDATE confirm_links SET message_id = ? WHERE token_hash = ?', msg.id, hash);
  if (msg.status === 'sent') {
    const col = kind === 'reminder' ? 'reminder_sent_at = COALESCE(reminder_sent_at, datetime(\'now\')), ' : '';
    await db.run(`UPDATE appointments SET ${col}notice_due = NULL WHERE id IN (${visits.map(() => '?').join(',')})`, ...visits.map((v) => v.id));
  }
  return { ...msg, appointment_ids: visits.map((v) => v.id), recipient_id: to.id };
}

// One visit: the Send reminder button, and the confirmation when an online booking goes onto the schedule.
export async function sendAppointmentReminder(db, messenger, { appointmentId, appUrl, userId, channel, kind = 'reminder' }) {
  return sendVisitsMessage(db, messenger, { appointmentIds: [appointmentId], kind, appUrl, userId, channel });
}

// Reminder steps: how long before the visit each goes out, by which channel, and whether patients
// who already confirmed get it too (e.g. a same-day "see you at 2pm"). The single "reminder_hours"
// window is the default when a practice hasn't set steps.
export function reminderSteps(practice) {
  let steps = null;
  try {
    steps = practice.reminder_steps ? JSON.parse(practice.reminder_steps) : null;
  } catch {
    steps = null;
  }
  if (!Array.isArray(steps)) steps = practice.reminder_hours > 0 ? [{ hours: practice.reminder_hours, channel: 'auto', confirmed: false }] : [];
  return steps.map((s) => ({ hours: Number(s.hours), channel: s.channel || 'auto', confirmed: !!s.confirmed })).sort((x, y) => y.hours - x.hours);
}
export function validateReminderSteps(steps) {
  if (!Array.isArray(steps) || steps.length > 5) throw new Error('reminder_steps must be a list of up to 5 steps');
  const out = steps.map((s) => {
    const hours = Number(s?.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30) throw new Error('Each reminder goes out 1 hour to 30 days before the visit');
    if (s.channel && !['auto', 'sms', 'email', 'call'].includes(s.channel)) throw new Error('channel must be auto, sms, email or call');
    return { hours, channel: s.channel || 'auto', confirmed: !!s.confirmed };
  });
  if (new Set(out.map((s) => s.hours)).size !== out.length) throw new Error('Two reminders are set for the same time');
  return out.sort((a, b) => b.hours - a.hours);
}

const hoursUntil = (fromLocal, toLocal) => (Date.parse(`${toLocal.replace(' ', 'T')}Z`) - Date.parse(`${fromLocal.replace(' ', 'T')}Z`)) / 3600000;
const addressKey = (target) => `${target.channel}:${optOutAddress(target.channel, target.to)}`;

// Groups what's due by who it goes to and the day of the visits, so a family sharing a phone gets one
// text for everyone's visits that day, then sends each group. `due` is [{ appt, step? }].
async function sendGrouped(db, messenger, due, { kind, appUrl, channelOf }) {
  const groups = new Map();
  for (const item of due) {
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', item.appt.patient_id);
    const to = await recipientFor(db, patient);
    const requested = channelOf(item);
    const target = preferredChannel(to, requested, { fallback: true });
    const key = target ? `${addressKey(target)}|${item.appt.start_time.slice(0, 10)}|${requested || ''}` : `none:${item.appt.id}`;
    if (!groups.has(key)) groups.set(key, { items: [], recipients: [] });
    groups.get(key).items.push(item);
    groups.get(key).recipients.push(to);
  }
  const results = [];
  for (const [key, g] of groups) {
    // Greet the head of household when several people share the number.
    const head = g.recipients.find((r) => !r.guarantor_id) || g.recipients[0];
    const msg = key.startsWith('none:') ? null : await sendVisitsMessage(db, messenger, {
      appointmentIds: g.items.map((i) => i.appt.id), kind, appUrl, channel: channelOf(g.items[0]), fallback: true, recipientId: head.id,
    });
    results.push({ items: g.items, msg });
  }
  return results;
}
const outcome = (msg) => (!msg || msg.status === 'blocked' ? 'unreachable' : msg.status === 'sent' ? 'sent' : 'failed');

// Automated confirmation calls: one call per phone number and day. Whoever answers hears the visits and can
// press 1 (or say yes) to confirm, or 2 to ask for a new time; a voicemail gets a message with the office's
// number. Home phones are fine — this is how landline-only patients are reached.
export async function placeConfirmCalls(db, messenger, due, appUrl) {
  const groups = new Map();
  for (const item of due) {
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', item.appt.patient_id);
    const to = await recipientFor(db, patient);
    const number = to.preferred_contact === 'email' ? null : (to.sms_bad_at ? to.phone_home || to.phone : to.phone || to.phone_home);
    const key = number ? `${number.replace(/\D/g, '').slice(-10)}|${item.appt.start_time.slice(0, 10)}` : `none:${item.appt.id}`;
    if (!groups.has(key)) groups.set(key, { items: [], to, number });
    groups.get(key).items.push(item);
  }
  const out = [];
  for (const g of groups.values()) {
    if (!g.number || !messenger.call) {
      out.push({ items: g.items, status: 'unreachable' });
      continue;
    }
    const { token, hash } = newToken();
    const practiceId = g.items[0].appt.practice_id;
    for (const i of g.items) await insert(db, 'confirm_links', { practice_id: practiceId, token_hash: hash, appointment_id: i.appt.id, recipient_id: g.to.id, channel: 'call', address: g.number });
    const callId = await insert(db, 'calls', { practice_id: practiceId, patient_id: g.to.id, direction: 'outbound', purpose: 'confirm', to_number: g.number, token_hash: hash });
    try {
      const { provider_id } = await messenger.call(g.number, `${appUrl}/api/webhooks/twilio/voice/confirm/${token}`);
      await db.run("UPDATE calls SET provider_id = ?, status = 'ringing' WHERE id = ?", provider_id, callId);
      out.push({ items: g.items, status: 'sent' });
    } catch (err) {
      await db.run("UPDATE calls SET status = 'failed', outcome = ? WHERE id = ?", String(err.message).slice(0, 200), callId);
      out.push({ items: g.items, status: 'failed' });
    }
  }
  return out;
}

// The reminder run (every few minutes), within each practice's sending hours:
// - reminders: each visit gets the latest step it's inside the window for and hasn't had (a visit booked the
//   day before gets only the day-before reminder); failed sends are retried up to three times;
// - booked and moved notices: a visit the office booked or moved hears about it, unless a reminder is going
//   out now anyway;
// - missed visits: a same-day "we missed you" to no-shows, when the practice has it on.
export async function runReminders(db, messenger, { appUrl, now = new Date() } = {}) {
  let sent = 0;
  for (const practice of await db.all('SELECT * FROM practices')) {
    const from = localNow(practice.timezone, now);
    if (!withinSendHours(practice, from)) continue;
    const steps = reminderSteps(practice);
    const due = [];
    if (steps.length) {
      const to = localNow(practice.timezone, new Date(now.getTime() + steps[0].hours * 3600_000));
      const upcoming = await db.all(
        `SELECT * FROM appointments WHERE practice_id = ? AND status IN ('scheduled','confirmed') AND start_time > ? AND start_time <= ? ORDER BY start_time`, practice.id, from, to,
      );
      for (const a of upcoming) {
        const left = hoursUntil(from, a.start_time);
        const step = [...steps].reverse().find((s) => s.hours >= left);
        if (!step || (a.status === 'confirmed' && !step.confirmed)) continue;
        const prior = await db.get('SELECT * FROM appointment_reminders WHERE appointment_id = ? AND step = ?', a.id, step.hours);
        if (prior && (prior.status !== 'failed' || prior.attempts >= 3)) continue;
        due.push({ appt: a, step, prior });
      }
    }
    const reminded = new Set(due.map((d) => d.appt.id));
    // Call steps ring those who haven't confirmed (a family's visits that day in one call); the rest are messages.
    const calls = due.filter((d) => d.step.channel === 'call');
    const messages = due.filter((d) => d.step.channel !== 'call');
    for (const { items, status } of await placeConfirmCalls(db, messenger, calls.filter((d) => d.appt.status === 'scheduled'), appUrl)) {
      if (status === 'sent') sent++;
      for (const { appt, step, prior } of items) {
        if (prior) await db.run('UPDATE appointment_reminders SET status = ?, attempts = attempts + 1, sent_at = datetime(\'now\') WHERE id = ?', status, prior.id);
        else await db.run('INSERT INTO appointment_reminders (appointment_id, step, status) VALUES (?, ?, ?)', appt.id, step.hours, status);
      }
    }
    for (const { items, msg } of await sendGrouped(db, messenger, messages, { kind: 'reminder', appUrl, channelOf: (i) => (i.step.channel === 'auto' ? undefined : i.step.channel) })) {
      const status = outcome(msg);
      if (status === 'sent') sent++;
      for (const { appt, step, prior } of items) {
        if (prior) await db.run('UPDATE appointment_reminders SET status = ?, attempts = attempts + 1, sent_at = datetime(\'now\') WHERE id = ?', status, prior.id);
        else await db.run('INSERT INTO appointment_reminders (appointment_id, step, status) VALUES (?, ?, ?)', appt.id, step.hours, status);
      }
    }

    // Booked or moved by the office. A visit starting within the hour, or one a reminder just covered, needs no notice.
    const notices = await db.all("SELECT * FROM appointments WHERE practice_id = ? AND notice_due IS NOT NULL AND status IN ('scheduled','confirmed')", practice.id);
    const soon = localNow(practice.timezone, new Date(now.getTime() + 3600_000));
    const skip = notices.filter((a) => !practice.booking_notices || reminded.has(a.id) || a.start_time <= soon);
    if (skip.length) await db.run(`UPDATE appointments SET notice_due = NULL WHERE id IN (${skip.map(() => '?').join(',')})`, ...skip.map((a) => a.id));
    for (const kind of ['booked', 'moved']) {
      const list = notices.filter((a) => a.notice_due === kind && !skip.includes(a)).map((appt) => ({ appt }));
      for (const { items, msg } of await sendGrouped(db, messenger, list, { kind: kind === 'booked' ? 'booking_confirmation' : 'moved', appUrl, channelOf: () => undefined })) {
        if (outcome(msg) === 'sent') sent++;
        // Tried once: a notice that couldn't go isn't worth retrying once the reminders take over.
        await db.run(`UPDATE appointments SET notice_due = NULL WHERE id IN (${items.map(() => '?').join(',')})`, ...items.map((i) => i.appt.id));
      }
    }

    if (practice.no_show_texts) sent += await sendNoShowTexts(db, messenger, practice, from, appUrl);
  }
  return sent + (await runReviewRequests(db, messenger, { now, appUrl }));
}

// "We missed you today": once, the same day, to visits marked as no-shows. A reply lands in the inbox.
async function sendNoShowTexts(db, messenger, practice, local, appUrl) {
  let sent = 0;
  const missed = await db.all(
    "SELECT * FROM appointments WHERE practice_id = ? AND status = 'no_show' AND no_show_msg_at IS NULL AND start_time >= ? AND start_time <= ?",
    practice.id, `${local.slice(0, 10)} 00:00`, local,
  );
  for (const a of missed) {
    await db.run("UPDATE appointments SET no_show_msg_at = datetime('now') WHERE id = ?", a.id);
    // Not if they've been booked again already.
    if (await db.get("SELECT 1 FROM appointments WHERE patient_id = ? AND id != ? AND status IN ('scheduled','confirmed') AND start_time > ?", a.patient_id, a.id, local)) continue;
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', a.patient_id);
    const to = await recipientFor(db, patient);
    const target = preferredChannel(to);
    if (!target) continue;
    const lang = patientLang(to);
    const booking = practice.slug && practice.online_booking ? `${appUrl}/book/${practice.slug}` : '';
    const body = renderTemplate(templatesFor(practice, lang).no_show, { first_name: to.first_name, practice: practice.name, phone: practice.phone || fixedText(lang).the_office, link: booking });
    const msg = await sendMessage(db, messenger, {
      practiceId: practice.id, patientId: a.patient_id, appointmentId: a.id, kind: 'no_show', channel: target.channel, to: target.to,
      subject: subjectFor(lang, 'no_show', `We missed you at ${practice.name}`, practice.name), body: target.channel === 'sms' ? `${body}${fixedText(lang).sms_stop}` : body,
    });
    if (msg.status === 'sent') sent++;
  }
  return sent;
}

// After a completed visit, ask happy patients for an online review (at most once every 6 months).
export async function runReviewRequests(db, messenger, { now = new Date(), appUrl = '' } = {}) {
  let sent = 0;
  for (const practice of await db.all("SELECT * FROM practices WHERE review_requests = 1 AND review_url IS NOT NULL AND review_url != ''")) {
    const local = localNow(practice.timezone, now);
    const due = await db.all(
      `SELECT a.id, a.patient_id FROM appointments a WHERE a.practice_id = ? AND a.status = 'completed' AND a.review_sent_at IS NULL
       AND a.start_time >= ? AND a.end_time <= ?`,
      practice.id, `${local.slice(0, 10)} 00:00`, local,
    );
    for (const { id, patient_id: patientId } of due) {
      await db.run("UPDATE appointments SET review_sent_at = datetime('now') WHERE id = ?", id);
      const recent = await db.get("SELECT 1 FROM messages WHERE patient_id = ? AND kind = 'review' AND created_at > ?", patientId, new Date(Date.now() - 180 * 86400_000).toISOString().slice(0, 19).replace('T', ' '));
      const patient = await db.get('SELECT * FROM patients WHERE id = ?', patientId);
      const target = preferredChannel(patient);
      if (recent || !target) continue;
      // The link asks how the visit went first: happy patients go on to the public review page,
      // unhappy ones can tell the office privately (review routing).
      const { token, hash } = newToken();
      await insert(db, 'review_feedback', { practice_id: practice.id, patient_id: patientId, appointment_id: id, token_hash: hash });
      const msg = await sendMessage(db, messenger, {
        practiceId: practice.id, patientId, appointmentId: id, kind: 'review', channel: target.channel, to: target.to,
        subject: subjectFor(patientLang(patient), 'review', `Thanks for visiting ${practice.name}`, practice.name),
        body: renderTemplate(templatesFor(practice, patientLang(patient)).review, { first_name: patient.first_name, practice: practice.name, link: `${appUrl}/r/${token}`, phone: practice.phone || '' }),
      });
      if (msg.status === 'sent') sent++;
    }
  }
  return sent;
}
