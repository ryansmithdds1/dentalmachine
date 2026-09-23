import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, findOr404, audit, friendlyDateTime, mapSeq, publicPractice } from '../util.js';
import { sendMessage, sendAppointmentReminder, runReminders, preferredChannel } from '../messaging.js';
import { runRecallSequences } from '../recalls.js';
import { validateAppt } from './schedule.js';
import { publish } from '../events.js';
import { templatesFor, renderTemplate } from '../templates.js';
import { createPacket, runFormSends } from '../formtemplates.js';

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
    requireOneOf(row.channel, ['sms', 'email'], 'channel');
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
    const bookLink = practice.online_booking && practice.slug ? `Book online: ${config.appUrl}/book/${practice.slug}` : '';
    const msg = await sendMessage(db, messenger, {
      practiceId: req.user.practice_id, patientId: patient.id, userId: req.user.id, kind: 'recall', channel: target.channel, to: target.to,
      subject: `Time for your next visit at ${practice.name}`,
      body: renderTemplate(templatesFor(practice).recall, { first_name: patient.first_name, practice: practice.name, phone: practice.phone || 'the office', link: bookLink }),
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

  // ---- Online booking queue ----
  r.get('/booking-requests', requirePermission('schedule:read'), async (req, res) => {
    const status = req.query.status || 'pending';
    res.json(await mapSeq((await db.all(
      `SELECT b.*, pv.name AS provider_name FROM booking_requests b LEFT JOIN providers pv ON pv.id = b.provider_id
       WHERE b.practice_id = ? AND (? = 'all' OR b.status = ?) ORDER BY b.requested_start`,
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
    const providerId = Number(req.body?.provider_id || b.provider_id);
    if (!providerId) throw new HttpError(400, 'Choose a provider');
    const start = req.body?.start_time || b.requested_start;
    const duration = Number(req.body?.duration || b.duration);

    const apptId = await db.tx(async () => {
      let patientId = req.body?.patient_id ? (await findOr404(db, 'patients', req.body.patient_id, pid, 'Patient')).id : null;
      if (!patientId) {
        patientId = await insert(db, 'patients', {
          practice_id: pid, first_name: b.first_name, last_name: b.last_name, dob: b.dob, phone: b.phone, email: b.email,
          notes: b.notes ? `Online booking note: ${b.notes}` : null,
        });
      }
      const [h, m] = start.slice(11, 16).split(':').map(Number);
      const endMin = h * 60 + m + duration;
      const row = {
        patient_id: patientId, provider_id: providerId, operatory_id: req.body?.operatory_id ? Number(req.body.operatory_id) : null,
        start_time: start, end_time: `${start.slice(0, 10)} ${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`,
        status: 'scheduled', reason: b.reason, notes: b.notes,
        appointment_type_id: (await db.get('SELECT id FROM appointment_types WHERE practice_id = ? AND name = ?', pid, b.reason))?.id ?? null,
      };
      await validateAppt(db, pid, row);
      const id = await insert(db, 'appointments', { ...row, practice_id: pid });
      await db.run("UPDATE booking_requests SET status = 'accepted', patient_id = ?, appointment_id = ?, handled_by = ?, handled_at = datetime('now') WHERE id = ?", patientId, id, req.user.id, b.id);
      return id;
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
        "SELECT sms_opt_in, email_opt_in FROM patients WHERE practice_id = ? AND ((phone IS NOT NULL AND phone = ?) OR (email IS NOT NULL AND lower(email) = lower(?))) ORDER BY id LIMIT 1",
        req.user.practice_id, b.phone || '', b.email || '',
      );
      const target = preferredChannel({ ...b, sms_opt_in: known ? known.sms_opt_in : 1, email_opt_in: known ? known.email_opt_in : 1 });
      if (target) {
        message = await sendMessage(db, messenger, {
          practiceId: req.user.practice_id, userId: req.user.id, kind: 'booking_declined', channel: target.channel, to: target.to,
          subject: `Your appointment request at ${practice.name}`,
          body: `Hi ${b.first_name}, we couldn't confirm your requested time (${friendlyDateTime(b.requested_start)}) at ${practice.name}. ${req.body?.reason ? `${req.body.reason} ` : ''}Please call us at ${practice.phone || 'the office'} to find another time.`,
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
