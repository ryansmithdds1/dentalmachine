import { insert, friendlyDateTime, newToken, localNow } from './util.js';
import { templatesFor, renderTemplate } from './templates.js';

// Delivery drivers. "log" records the message without sending it (development / not yet configured).
export function createMessenger({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const smsDriver = env.SMS_DRIVER || (env.TWILIO_ACCOUNT_SID ? 'twilio' : 'log');
  const emailDriver = env.EMAIL_DRIVER || (env.SENDGRID_API_KEY ? 'sendgrid' : 'log');

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
      body: new URLSearchParams({ To: toE164(to), From: env.TWILIO_FROM, Body: body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Twilio error ${res.status}`);
    return { provider_id: data.sid };
  }

  async function sendEmail(to, subject, body) {
    if (emailDriver === 'log') return { provider_id: 'log' };
    if (emailDriver !== 'sendgrid') throw new Error(`Unknown EMAIL_DRIVER ${emailDriver}`);
    const res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: env.EMAIL_FROM },
        subject,
        content: [{ type: 'text/plain', value: body }],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid error ${res.status}: ${await res.text().catch(() => '')}`.trim());
    return { provider_id: res.headers.get('x-message-id') || 'sendgrid' };
  }

  return {
    status: { sms: smsDriver, email: emailDriver },
    send: ({ channel, to, subject, body }) => (channel === 'sms' ? sendSms(to, body) : sendEmail(to, subject || 'Message from your dental office', body)),
  };
}

export function toE164(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (String(phone).trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

// Chooses SMS when the patient has a phone and hasn't opted out, otherwise email.
export function preferredChannel(patient, requested) {
  if (requested === 'sms') return patient.phone && patient.sms_opt_in ? { channel: 'sms', to: patient.phone } : null;
  if (requested === 'email') return patient.email && patient.email_opt_in ? { channel: 'email', to: patient.email } : null;
  if (patient.phone && patient.sms_opt_in) return { channel: 'sms', to: patient.phone };
  if (patient.email && patient.email_opt_in) return { channel: 'email', to: patient.email };
  return null;
}

// Records a message, attempts delivery, and stores the outcome. Never throws for delivery errors.
export async function sendMessage(db, messenger, { practiceId, patientId, appointmentId, channel, to, subject, body, kind = 'custom', userId }) {
  const id = await insert(db, 'messages', {
    practice_id: practiceId, patient_id: patientId ?? null, appointment_id: appointmentId ?? null,
    channel, to_address: to, subject: subject ?? null, body, kind, created_by: userId ?? null,
  });
  try {
    const { provider_id } = await messenger.send({ channel, to, subject, body });
    await db.run("UPDATE messages SET status = 'sent', provider_id = ?, sent_at = datetime('now') WHERE id = ?", provider_id, id);
  } catch (err) {
    await db.run("UPDATE messages SET status = 'failed', error = ? WHERE id = ?", String(err.message).slice(0, 500), id);
  }
  return await db.get('SELECT * FROM messages WHERE id = ?', id);
}

// Sends a reminder with a one-tap confirmation link, rotating the appointment's confirm token.
export async function sendAppointmentReminder(db, messenger, { appointmentId, appUrl, userId, channel: requested, kind = 'reminder' }) {
  const a = await db.get(
    `SELECT a.*, p.first_name, p.phone, p.email, p.sms_opt_in, p.email_opt_in, pr.name AS practice_name, pr.phone AS practice_phone, pr.message_templates, pv.name AS provider_name
     FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN practices pr ON pr.id = a.practice_id JOIN providers pv ON pv.id = a.provider_id
     WHERE a.id = ?`, appointmentId,
  );
  const target = preferredChannel(a, requested);
  if (!target) return null;
  const { token, hash } = newToken();
  await db.run('UPDATE appointments SET confirm_token_hash = ? WHERE id = ?', hash, a.id);
  const link = `${appUrl}/c/${token}`;
  const when = friendlyDateTime(a.start_time);
  const templates = templatesFor({ message_templates: a.message_templates });
  const vars = { first_name: a.first_name, practice: a.practice_name, when, provider: a.provider_name, link, phone: a.practice_phone || '' };
  const body = kind === 'booking_confirmation'
    ? renderTemplate(templates.booking_confirmation, vars)
    : `${renderTemplate(templates.reminder, vars)}${target.channel === 'sms' ? ' Reply C to confirm, or call us to reschedule. Reply STOP to opt out.' : ''}`;
  const msg = await sendMessage(db, messenger, {
    practiceId: a.practice_id, patientId: a.patient_id, appointmentId: a.id, userId, kind,
    channel: target.channel, to: target.to, subject: `Your appointment at ${a.practice_name}`, body,
  });
  if (msg.status === 'sent' && kind === 'reminder') await db.run("UPDATE appointments SET reminder_sent_at = datetime('now') WHERE id = ?", a.id);
  return msg;
}

// Finds unconfirmed appointments inside each practice's reminder window and reminds them once.
export async function runReminders(db, messenger, { appUrl, now = new Date() } = {}) {
  let sent = 0;
  for (const practice of await db.all('SELECT id, timezone, reminder_hours FROM practices WHERE reminder_hours > 0')) {
    const from = localNow(practice.timezone, now);
    const to = localNow(practice.timezone, new Date(now.getTime() + practice.reminder_hours * 3600_000));
    const due = await db.all(
      `SELECT id FROM appointments WHERE practice_id = ? AND status = 'scheduled' AND reminder_sent_at IS NULL
       AND start_time > ? AND start_time <= ? ORDER BY start_time`, practice.id, from, to,
    );
    for (const { id } of due) {
      const msg = await sendAppointmentReminder(db, messenger, { appointmentId: id, appUrl });
      if (msg?.status === 'sent') sent++;
      // No reachable channel: nothing to retry. A failed send (carrier or provider error) is retried on the
      // next cycles, up to three attempts.
      else if (!msg) await db.run("UPDATE appointments SET reminder_sent_at = datetime('now') WHERE id = ?", id);
      else {
        await db.run('UPDATE appointments SET reminder_attempts = reminder_attempts + 1 WHERE id = ?', id);
        await db.run("UPDATE appointments SET reminder_sent_at = datetime('now') WHERE id = ? AND reminder_attempts >= 3", id);
      }
    }
  }
  return sent + (await runReviewRequests(db, messenger, { now }));
}

// After a completed visit, ask happy patients for an online review (at most once every 6 months).
export async function runReviewRequests(db, messenger, { now = new Date() } = {}) {
  let sent = 0;
  for (const practice of await db.all("SELECT * FROM practices WHERE review_requests = 1 AND review_url IS NOT NULL AND review_url != ''")) {
    const local = localNow(practice.timezone, now);
    const due = await db.all(
      `SELECT a.id, a.patient_id FROM appointments a WHERE a.practice_id = ? AND a.status = 'completed' AND a.review_sent_at IS NULL
       AND a.start_time >= ? AND a.end_time <= ?`,
      practice.id, `${local.slice(0, 10)} 00:00`, local,
    );
    const templates = templatesFor(practice);
    for (const { id, patient_id: patientId } of due) {
      await db.run("UPDATE appointments SET review_sent_at = datetime('now') WHERE id = ?", id);
      const recent = await db.get("SELECT 1 FROM messages WHERE patient_id = ? AND kind = 'review' AND created_at > ?", patientId, new Date(Date.now() - 180 * 86400_000).toISOString().slice(0, 19).replace('T', ' '));
      const patient = await db.get('SELECT * FROM patients WHERE id = ?', patientId);
      const target = preferredChannel(patient);
      if (recent || !target) continue;
      const msg = await sendMessage(db, messenger, {
        practiceId: practice.id, patientId, appointmentId: id, kind: 'review', channel: target.channel, to: target.to,
        subject: `Thanks for visiting ${practice.name}`,
        body: renderTemplate(templates.review, { first_name: patient.first_name, practice: practice.name, link: practice.review_url, phone: practice.phone || '' }),
      });
      if (msg.status === 'sent') sent++;
    }
  }
  return sent;
}
