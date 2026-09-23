import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, findOr404, audit, friendlyDateTime, mapSeq, publicPractice } from '../util.js';
import { sendMessage, sendAppointmentReminder, runReminders, preferredChannel } from '../messaging.js';
import { runRecallSequences } from '../recalls.js';
import { publish } from '../events.js';
import { templatesFor, renderTemplate, messageText, patientLang, fixedText, subjectFor } from '../templates.js';
import { createPacket, runFormSends } from '../formtemplates.js';
import { finishBooking } from '../onlinebooking.js';
import { portalKey } from './portal.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));

// Staff-side patient engagement: messaging, reminders, online booking queue, intake form links.
export default function engagementRoutes({ db, messenger, config }) {
  const r = Router();
  const patientOr404 = async (req) => await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
  const practiceName = async (pid) => (await db.get('SELECT name FROM practices WHERE id = ?', pid)).name;

  // ---- Messages ----
  r.get('/messaging/status', (_req, res) => res.json({ ...messenger.status, app_url: config.appUrl }));

  r.get('/messages', requirePermission('patients:read'), async (req, res) => {
    const where = ['m.practice_id = ?'];
    const params = [req.user.practice_id];
    if (req.query.patient_id) {
      where.push('m.patient_id = ?');
      params.push(Number(req.query.patient_id));
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(await db.all(
      `SELECT m.*, p.first_name, p.last_name, u.name AS created_by_name FROM messages m
       LEFT JOIN patients p ON p.id = m.patient_id LEFT JOIN users u ON u.id = m.created_by
       WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`, ...params, limit,
    ));
  });

  r.post('/patients/:id/messages', requirePermission('patients:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const row = pick(req.body, ['channel', 'subject', 'body']);
    requireFields(row, ['body']);
    requireOneOf(row.channel, ['sms', 'email', 'portal'], 'channel');
    // A secure portal message: kept in the portal, with a short heads-up by text or email (no details in it).
    if (row.channel === 'portal') {
      const practice = await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
      if (!practice.portal_enabled) throw new HttpError(400, 'Turn on the patient portal first');
      const id = await insert(db, 'messages', {
        practice_id: practice.id, patient_id: patient.id, channel: 'portal', direction: 'outbound', kind: 'custom', to_address: 'portal', body: String(row.body).slice(0, 4000),
        status: 'sent', sent_at: new Date().toISOString(), created_by: req.user.id,
      });
      const heads = preferredChannel(patient);
      if (heads) {
        await sendMessage(db, messenger, {
          practiceId: practice.id, patientId: patient.id, userId: req.user.id, kind: 'portal_notice', channel: heads.channel, to: heads.to,
          subject: subjectFor(patientLang(patient), 'portal_notice', `New message from ${practice.name}`, practice.name),
          body: await messageText(db, practice.id, 'portal_notice', { first_name: patient.first_name, link: `${config.appUrl}/portal/${portalKey(practice)}` }, patientLang(patient)),
        });
      }
      await audit(db, req, 'message.send', 'messages', id, { channel: 'portal' });
      publish(req.user.practice_id, { type: 'message', patient_id: patient.id });
      return res.status(201).json(await db.get('SELECT * FROM messages WHERE id = ?', id));
    }
    const target = preferredChannel(patient, row.channel);
    if (!target) throw new HttpError(400, 'Patient has no reachable phone/email for that channel (or has opted out)');
    const msg = await sendMessage(db, messenger, {
      practiceId: req.user.practice_id, patientId: patient.id, userId: req.user.id, kind: 'custom',
      channel: target.channel, to: target.to, subject: row.subject || `Message from ${await practiceName(req.user.practice_id)}`, body: row.body,
    });
    await audit(db, req, 'message.send', 'messages', msg.id, { channel: target.channel });
    publish(req.user.practice_id, { type: 'message', patient_id: patient.id });
    res.status(201).json(msg);
  });

  r.post('/appointments/:aid/remind', requirePermission('schedule:write'), async (req, res) => {
    const appt = await findOr404(db, 'appointments', req.params.aid, req.user.practice_id, 'Appointment');
    if (['cancelled', 'no_show', 'completed'].includes(appt.status)) throw new HttpError(409, `Appointment is ${appt.status}`);
    const msg = await sendAppointmentReminder(db, messenger, { appointmentId: appt.id, appUrl: config.appUrl, userId: req.user.id, channel: req.body?.channel });
    if (!msg) throw new HttpError(400, 'Patient has no reachable phone or email (or has opted out)');
    await audit(db, req, 'appointment.remind', 'appointments', appt.id);
    res.status(201).json(msg);
  });

  r.post('/recalls/:rid/remind', requirePermission('schedule:write'), async (req, res) => {
    const recall = await findOr404(db, 'recalls', req.params.rid, req.user.practice_id, 'Recall');
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', recall.patient_id);
    const target = preferredChannel(patient, req.body?.channel);
    if (!target) throw new HttpError(400, 'Patient has no reachable phone or email (or has opted out)');
    const practice = publicPractice(await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id));
    const lang = patientLang(patient);
    const bookLink = practice.online_booking && practice.slug ? `${lang === 'es' ? 'Reserve en línea' : 'Book online'}: ${config.appUrl}/book/${practice.slug}${lang === 'es' ? '?lang=es' : ''}` : '';
    const msg = await sendMessage(db, messenger, {
      practiceId: req.user.practice_id, patientId: patient.id, userId: req.user.id, kind: 'recall', channel: target.channel, to: target.to,
      subject: subjectFor(lang, 'recall', `Time for your next visit at ${practice.name}`, practice.name),
      body: renderTemplate(templatesFor(practice, lang).recall, { first_name: patient.first_name, practice: practice.name, phone: practice.phone || fixedText(lang).the_office, link: bookLink }),
    });
    if (msg.status === 'sent') await db.run("UPDATE recalls SET status = 'contacted', last_contacted_at = datetime('now') WHERE id = ?", recall.id);
    await audit(db, req, 'recall.remind', 'recalls', recall.id);
    res.status(201).json(msg);
  });

  r.post('/messaging/run-reminders', requireAdmin, async (req, res) => {
    const sent = (await runReminders(db, messenger, { appUrl: config.appUrl })) + (await runRecallSequences(db, messenger, { appUrl: config.appUrl }))
      + (await runFormSends(db, messenger, { appUrl: config.appUrl }));
    await audit(db, req, 'messaging.run_reminders', null, null, { sent });
    res.json({ sent });
  });

  // ---- Review requests and patient feedback ----
  r.get('/reports/reviews', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    const to = DATE.test(req.query.to || '') ? req.query.to : new Date().toISOString().slice(0, 10);
    const from = DATE.test(req.query.from || '') ? req.query.from : `${to.slice(0, 7)}-01`;
    const rows = await db.all(
      `SELECT rf.id, rf.patient_id, rf.rating, rf.comment, rf.went_to_review, rf.sent_at, rf.responded_at, rf.task_id, p.first_name, p.last_name,
         t.status AS task_status, pv.name AS provider_name
       FROM review_feedback rf JOIN patients p ON p.id = rf.patient_id LEFT JOIN tasks t ON t.id = rf.task_id
       LEFT JOIN appointments a ON a.id = rf.appointment_id LEFT JOIN providers pv ON pv.id = a.provider_id
       WHERE rf.practice_id = ? AND substr(rf.sent_at, 1, 10) BETWEEN ? AND ?${Number(req.query.provider_id) ? ` AND a.provider_id = ${Number(req.query.provider_id)}` : ''} ORDER BY rf.id DESC`, pid, from, to,
    );
    const rated = rows.filter((x) => x.rating != null);
    const threshold = (await db.get('SELECT review_threshold FROM practices WHERE id = ?', pid)).review_threshold || 4;
    res.json({
      from, to, threshold, sent: rows.length, responded: rated.length,
      average: rated.length ? Math.round((rated.reduce((s, x) => s + x.rating, 0) / rated.length) * 10) / 10 : null,
      happy: rated.filter((x) => x.rating >= threshold).length, unhappy: rated.filter((x) => x.rating < threshold).length,
      went_to_review: rows.filter((x) => x.went_to_review).length,
      by_stars: [5, 4, 3, 2, 1].map((n) => ({ stars: n, count: rated.filter((x) => x.rating === n).length })),
      feedback: rows.filter((x) => x.rating != null && (x.rating < threshold || x.comment)),
      responses: rated,
    });
  });

  // ---- Online booking queue ----
  r.get('/booking-requests', requirePermission('schedule:read'), async (req, res) => {
    const status = req.query.status || 'pending';
    res.json(await mapSeq((await db.all(
      `SELECT b.*, pv.name AS provider_name FROM booking_requests b LEFT JOIN providers pv ON pv.id = b.provider_id
       WHERE b.practice_id = ? AND (? = 'all' OR b.status = ?) AND (b.deposit_status IS NULL OR b.deposit_status = 'paid') ORDER BY b.requested_start`,
      req.user.practice_id, status, status,
    )), async (b) => ({
      ...b,

      // Help the front desk spot an existing chart before creating a duplicate.
      matches: await db.all(
        `SELECT id, first_name, last_name, dob, phone FROM patients WHERE practice_id = ? AND status != 'archived'
         AND ((lower(first_name) = lower(?) AND lower(last_name) = lower(?)) OR (CAST(? AS TEXT) IS NOT NULL AND dob = ? AND lower(last_name) = lower(?)))
         LIMIT 5`,
        req.user.practice_id, b.first_name, b.last_name, b.dob, b.dob, b.last_name,
      )
    })));
  });

  r.post('/booking-requests/:bid/accept', requirePermission('schedule:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const b = await findOr404(db, 'booking_requests', req.params.bid, pid, 'Booking request');
    if (b.status !== 'pending') throw new HttpError(409, `Request already ${b.status}`);
    const start = req.body?.start_time || b.requested_start;
    const patientId = req.body?.patient_id ? (await findOr404(db, 'patients', req.body.patient_id, pid, 'Patient')).id : null;
    const apptId = await finishBooking(db, b, {
      providerId: req.body?.provider_id, start, duration: req.body?.duration, patientId, operatoryId: req.body?.operatory_id, userId: req.user.id,
    });
    await audit(db, req, 'booking.accept', 'booking_requests', b.id, { appointment_id: apptId });
    publish(pid, { type: 'schedule', dates: [start.slice(0, 10)], by: req.user.id });
    const message = await sendAppointmentReminder(db, messenger, { appointmentId: apptId, appUrl: config.appUrl, userId: req.user.id, kind: 'booking_confirmation' });
    res.json({ appointment_id: apptId, start_time: (await db.get('SELECT start_time FROM appointments WHERE id = ?', apptId)).start_time, message });
  });

  r.post('/booking-requests/:bid/decline', requirePermission('schedule:write'), async (req, res) => {
    const b = await findOr404(db, 'booking_requests', req.params.bid, req.user.practice_id, 'Booking request');
    if (b.status !== 'pending') throw new HttpError(409, `Request already ${b.status}`);
    await db.run("UPDATE booking_requests SET status = 'declined', handled_by = ?, handled_at = datetime('now') WHERE id = ?", req.user.id, b.id);
    await audit(db, req, 'booking.decline', 'booking_requests', b.id);
    let message = null;
    if (req.body?.notify !== false) {
      const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', req.user.practice_id);
      // A reply to their own request is fine to send — unless they're a patient who opted out of that channel.
      const known = await db.get(
        "SELECT sms_opt_in, email_opt_in, language FROM patients WHERE practice_id = ? AND ((phone IS NOT NULL AND phone = ?) OR (email IS NOT NULL AND lower(email) = lower(?))) ORDER BY id LIMIT 1",
        req.user.practice_id, b.phone || '', b.email || '',
      );
      const target = preferredChannel({ ...b, sms_opt_in: known ? known.sms_opt_in : 1, email_opt_in: known ? known.email_opt_in : 1 });
      const lang = b.language === 'es' ? 'es' : patientLang(known);
      if (target) {
        message = await sendMessage(db, messenger, {
          practiceId: req.user.practice_id, userId: req.user.id, kind: 'booking_declined', channel: target.channel, to: target.to,
          subject: subjectFor(lang, 'booking_declined', `Your appointment request at ${practice.name}`, practice.name),
          body: await messageText(db, req.user.practice_id, 'booking_declined', { first_name: b.first_name, when: friendlyDateTime(b.requested_start, lang), reason: req.body?.reason ? String(req.body.reason).slice(0, 300) : '' }, lang),
        });
      }
    }
    res.json({ ok: true, message });
  });

  // ---- Intake forms ----
  r.post('/patients/:id/form-requests', requirePermission('patients:write'), async (req, res) => {
    const patient = await patientOr404(req);
    const templateIds = Array.isArray(req.body?.template_ids) ? req.body.template_ids : [];
    const packet = await createPacket(db, messenger, {
      practiceId: req.user.practice_id, patient, history: req.body?.history !== false, templateIds, userId: req.user.id, send: req.body?.send || null, appUrl: config.appUrl,
    });
    await audit(db, req, 'form_request.create', 'form_requests', packet.id);
    res.status(201).json(packet);
  });

  r.get('/patients/:id/forms', requirePermission('clinical:read'), async (req, res) => {
    const patient = await patientOr404(req);
    res.json({
      requests: await db.all(
        `SELECT fr.id, fr.kind, fr.status, fr.expires_at, fr.completed_at, fr.created_at, fr.packet_id, fr.template_id, t.name AS template_name
         FROM form_requests fr LEFT JOIN form_templates t ON t.id = fr.template_id WHERE fr.practice_id = ? AND fr.patient_id = ? ORDER BY fr.id DESC`, req.user.practice_id, patient.id,
      ),
      submissions: (await db.all(
        `SELECT f.id, f.kind, f.data, f.signature_name, f.signature_image, f.signed_at, f.review_status, f.ip, f.template_id, f.template_version, f.document_id, t.name AS template_name
         FROM patient_forms f LEFT JOIN form_templates t ON t.id = f.template_id WHERE f.practice_id = ? AND f.patient_id = ? ORDER BY f.id DESC`, req.user.practice_id, patient.id,
      )).map((f) => ({ ...f, data: JSON.parse(f.data) })),
    });
  });

  return r;
}
