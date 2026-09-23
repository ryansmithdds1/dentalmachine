import express, { Router } from 'express';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { HttpError, rateLimit, signToken, verifyToken } from '../auth.js';
import { hit } from '../cluster.js';
import { insert, audit, practiceNow, newToken, pick, mapSeq, publicPractice } from '../util.js';
import { sendMessage } from '../messaging.js';
import { publish } from '../events.js';
import { planStatus } from './family.js';
import { estimateCoverage, primaryPolicy, pendingInsurance } from '../services.js';
import { patientLang, messageText, subjectFor } from '../templates.js';
import { openSlots, validateAppt } from './schedule.js';
import { emitAppointment } from '../webhooks.js';
import { PdfDoc } from '../pdf.js';
import { receiptData, receiptPdf } from '../receipts.js';
import { sniffMime } from './imaging.js';
import { MAX_UPLOAD_BYTES } from './documents.js';
import { runMembershipBilling } from '../memberships.js';

const CODE_TTL_MINUTES = 10;
const SESSION_HOURS = 2;
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const hashCode = (code) => createHash('sha256').update(String(code)).digest();
export const portalKey = (practice) => practice.slug || String(practice.id);
const addHours = (dt, h) => new Date(Date.parse(`${dt.replace(' ', 'T')}:00Z`) + h * 3600_000).toISOString().slice(0, 16).replace('T', ' ');

// Patient portal: patients sign in with a one-time code sent to the email or mobile number on file
// (plus their date of birth) and see their household's visits, balance, forms and treatment plans.
export function portalPublicRoutes({ db, secret, messenger }) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 15 * 60_000, max: 20, name: 'portal-login' });
  const practiceFor = async (key) => {
    const p = await db.get('SELECT * FROM practices WHERE (slug = ? OR id = ?) AND portal_enabled = 1', String(key), /^\d+$/.test(key) ? Number(key) : -1);
    if (!p) throw new HttpError(404, 'Patient portal not found');
    return p;
  };

  r.get('/portal/:key', async (req, res) => {
    const p = await practiceFor(req.params.key);
    res.json({ name: p.name, phone: p.phone, city: p.city, state: p.state });
  });

  // Always answers the same way, so the portal can't be used to find out who is a patient.
  r.post('/portal/:key/code', limiter, async (req, res) => {
    const practice = await practiceFor(req.params.key);
    const contact = String(req.body?.contact || '').trim().toLowerCase();
    const dob = String(req.body?.dob || '').trim();
    const isEmail = contact.includes('@');
    if (!contact || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new HttpError(400, 'Enter your email or mobile number and your date of birth');
    const key = isEmail ? contact : digits(contact);
    // Limited per address and device, so someone else asking for codes can't lock a patient out.
    if ((await hit(`portal-code:${practice.id}:${key}:${req.ip}`, 15 * 60_000)) > 3) throw new HttpError(429, 'Too many codes requested — wait a few minutes and try again');
    // And a quiet overall cap per address, so the portal can't be used to flood someone with texts.
    const flood = (await hit(`portal-code:${practice.id}:${key}`, 60 * 60_000)) > 10;
    const candidates = (await db.all("SELECT * FROM patients WHERE practice_id = ? AND dob = ? AND status != 'archived'", practice.id, dob))
      .filter((p) => (isEmail ? String(p.email || '').toLowerCase() === key : digits(p.phone) === key && key.length === 10))
      .sort((a, b) => (a.guarantor_id ? 1 : 0) - (b.guarantor_id ? 1 : 0));
    const patient = candidates[0];
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await insert(db, 'portal_codes', {
      practice_id: practice.id, patient_id: patient?.id ?? null, contact: key, code_hash: hashCode(code).toString('hex'),
      expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString().slice(0, 19).replace('T', ' '),
    });
    // Sent in the background: the answer takes the same time whether or not the patient exists.
    if (patient && !flood) {
      (async () => sendMessage(db, messenger, {
        practiceId: practice.id, patientId: patient.id, kind: 'portal_code', channel: isEmail ? 'email' : 'sms', to: isEmail ? patient.email : patient.phone,
        subject: subjectFor(patientLang(patient), 'portal_code', `Your ${practice.name} sign-in code`, practice.name),
        body: await messageText(db, practice.id, 'portal_code', { code, minutes: String(CODE_TTL_MINUTES) }, patientLang(patient)),
      }))().catch(() => {});
    }
    res.json({ sent: true, channel: isEmail ? 'email' : 'sms' });
  });

  r.post('/portal/:key/verify', limiter, async (req, res) => {
    const practice = await practiceFor(req.params.key);
    const contact = String(req.body?.contact || '').trim().toLowerCase();
    const key = contact.includes('@') ? contact : digits(contact);
    const given = hashCode(String(req.body?.code || '').replace(/\D/g, ''));
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    // Any live code for this address can be used (a later request with a mistyped birth date doesn't
    // hide the real one). Each guess uses up one of a code's five attempts before it is compared.
    const live = await db.all(
      'SELECT * FROM portal_codes WHERE practice_id = ? AND contact = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 3', practice.id, key, now,
    );
    let row = null;
    for (const c of live) {
      if (!(await db.run('UPDATE portal_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < 5', c.id)).changes) continue;
      if (c.patient_id && timingSafeEqual(Buffer.from(c.code_hash, 'hex'), given)) row = c;
    }
    if (!row || !(await db.run("UPDATE portal_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL", row.id)).changes) {
      const expired = !live.length && (await db.get('SELECT id FROM portal_codes WHERE practice_id = ? AND contact = ? AND used_at IS NULL LIMIT 1', practice.id, key));
      throw new HttpError(403, expired ? 'That code has expired — request a new one' : "That code isn't right — check it and try again");
    }
    const patient = await db.get('SELECT id, first_name FROM patients WHERE id = ?', row.patient_id);
    await audit(db, { ip: req.ip, user: { practice_id: practice.id, id: null } }, 'portal.login', 'patients', patient.id);
    res.json({ token: signToken({ sub: patient.id, pid: practice.id, aud: 'portal' }, secret, SESSION_HOURS * 3600), first_name: patient.first_name });
  });
  return r;
}

export function portalRoutes({ db, secret, config, payments, messenger, storage }) {
  const r = Router();
  r.use(async (req, _res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const payload = verifyToken(token, secret);
    if (!payload || payload.aud !== 'portal') return next(new HttpError(401, 'Please sign in again'));
    const patient = await db.get("SELECT * FROM patients WHERE id = ? AND practice_id = ? AND status != 'archived'", payload.sub, payload.pid);
    if (!patient) return next(new HttpError(401, 'Please sign in again'));
    const practice = publicPractice(await db.get('SELECT * FROM practices WHERE id = ?', payload.pid));
    // A guarantor sees their whole household; anyone else sees just themselves.
    const household = patient.guarantor_id
      ? [patient]
      : await db.all("SELECT * FROM patients WHERE practice_id = ? AND (id = ? OR guarantor_id = ?) AND status != 'archived' ORDER BY guarantor_id IS NOT NULL, dob", practice.id, patient.id, patient.id);
    req.portal = { patient, practice, household, ids: household.map((h) => h.id) };
    _res.set('Cache-Control', 'no-store');
    next();
  });
  const inList = (ids) => ids.map(() => '?').join(',');
  const pAudit = (req, action, entity, id, details) => audit(db, { ip: req.ip, user: { practice_id: req.portal.practice.id, id: null } }, action, entity, id, { portal_patient_id: req.portal.patient.id, ...details });
  const ownAppt = async (req) => {
    const a = await db.get(`SELECT * FROM appointments WHERE id = ? AND practice_id = ? AND patient_id IN (${inList(req.portal.ids)})`, Number(req.params.aid), req.portal.practice.id, ...req.portal.ids);
    if (!a) throw new HttpError(404, 'Appointment not found');
    return a;
  };

  r.get('/me', async (req, res) => {
    const { patient, practice, household, ids } = req.portal;
    const now = await practiceNow(db, practice.id);
    const L = inList(ids);
    const balance = (await db.get(`SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE patient_id IN (${L})`, ...ids)).n;
    const pending = (await pendingInsurance(db, practice.id, ids)).total;
    const plans = await db.all(`SELECT tp.* FROM treatment_plans tp WHERE tp.patient_id IN (${L}) AND tp.status = 'proposed' AND tp.signed_at IS NULL
      AND EXISTS (SELECT 1 FROM procedures p WHERE p.treatment_plan_id = tp.id AND p.status = 'planned') ORDER BY tp.id DESC`, ...ids);
    const byId = Object.fromEntries(household.map((h) => [h.id, h]));
    await pAudit(req, 'portal.view', 'patients', patient.id);
    res.json({
      practice: {
        name: practice.name, phone: practice.phone, email: practice.email, address: practice.address, city: practice.city, state: practice.state, zip: practice.zip,
        booking_url: practice.online_booking && practice.slug ? `${config.appUrl}/book/${practice.slug}` : null,
      },
      patient: pick(patient, ['id', 'first_name', 'last_name', 'preferred_name', 'email', 'phone', 'address', 'city', 'state', 'zip', 'sms_opt_in', 'email_opt_in']),
      household: household.map((h) => ({ id: h.id, first_name: h.first_name, last_name: h.last_name, dob: h.dob, is_you: h.id === patient.id })),
      is_guarantor: !patient.guarantor_id,
      language: patientLang(patient),
      balance, pending_insurance: pending, amount_due: Math.max(0, balance - pending),
      appointments: (await db.all(
        `SELECT a.id, a.patient_id, a.start_time, a.end_time, a.status, a.reason, pv.name AS provider_name FROM appointments a JOIN providers pv ON pv.id = a.provider_id
         WHERE a.patient_id IN (${L}) AND a.start_time >= ? AND a.status IN ('scheduled','confirmed','checked_in') ORDER BY a.start_time LIMIT 20`, ...ids, now,
      )).map((a) => ({ ...a, patient_name: byId[a.patient_id]?.first_name, can_cancel: a.start_time > addHours(now, 24) })),
      forms: (await db.all(
        `SELECT id, patient_id, kind, created_at FROM form_requests WHERE patient_id IN (${L}) AND completed_at IS NULL AND expires_at > ? ORDER BY id DESC`, ...ids, new Date().toISOString(),
      )).map((f) => ({ ...f, patient_name: byId[f.patient_id]?.first_name })),
      treatment_plans: await mapSeq(plans, async (tp) => {
        const procs = await db.all("SELECT * FROM procedures WHERE treatment_plan_id = ? AND status = 'planned'", tp.id);
        const est = await estimateCoverage(db, await primaryPolicy(db, practice.id, tp.patient_id), procs);
        return { id: tp.id, name: tp.name, patient_name: byId[tp.patient_id]?.first_name, procedures: procs.length, total_fee: est.total_fee, your_estimate: est.total_patient };
      }),
      payment_plans: patient.guarantor_id ? [] : (await mapSeq(await db.all("SELECT * FROM payment_plans WHERE patient_id = ? AND status = 'active'", patient.id), (p) => planStatus(db, p, now.slice(0, 10))))
        .map((p) => ({ id: p.id, total: p.total, paid: p.paid, remaining: p.remaining, next_due_date: p.next_due_date, next_due_amount: p.next_due_amount, past_due: p.past_due, autopay: !!p.autopay_method_id && !p.autopay_paused })),
      cards: patient.guarantor_id ? [] : (await db.all('SELECT brand, last4, exp_month, exp_year FROM payment_methods WHERE patient_id = ? AND removed_at IS NULL', patient.id)),
      activity: await db.all(
        `SELECT l.entry_date, l.type, l.description, l.amount, p.first_name AS patient_name FROM ledger_entries l JOIN patients p ON p.id = l.patient_id
         WHERE l.patient_id IN (${L}) ORDER BY l.entry_date DESC, l.id DESC LIMIT 15`, ...ids,
      ),
      payments_enabled: payments.enabled,
    });
  });

  r.put('/contact', async (req, res) => {
    const { patient } = req.portal;
    const row = pick(req.body, ['email', 'phone', 'address', 'city', 'state', 'zip', 'sms_opt_in', 'email_opt_in']);
    if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) throw new HttpError(400, 'Enter a valid email address');
    if (row.phone && digits(row.phone).length !== 10) throw new HttpError(400, 'Enter a 10-digit phone number');
    const keys = Object.keys(row);
    if (keys.length) await db.run(`UPDATE patients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => row[k]), patient.id);
    await pAudit(req, 'portal.contact_update', 'patients', patient.id, { fields: keys });
    res.json({ ok: true });
  });

  r.post('/appointments/:aid/confirm', async (req, res) => {
    const a = await ownAppt(req);
    if (a.status === 'scheduled') await db.run("UPDATE appointments SET status = 'confirmed', confirmed_at = datetime('now'), confirmed_via = 'portal' WHERE id = ?", a.id);
    publish(req.portal.practice.id, { type: 'schedule', dates: [a.start_time.slice(0, 10)], source: 'portal' });
    await pAudit(req, 'portal.confirm', 'appointments', a.id);
    res.json({ ok: true });
  });

  r.post('/appointments/:aid/cancel', async (req, res) => {
    const a = await ownAppt(req);
    const now = await practiceNow(db, req.portal.practice.id);
    if (a.start_time <= addHours(now, 24)) throw new HttpError(409, `Visits within 24 hours can't be cancelled online — please call ${req.portal.practice.phone || 'the office'}`);
    await db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", a.id);
    await db.run("UPDATE procedures SET appointment_id = NULL WHERE appointment_id = ? AND status = 'planned'", a.id);
    const p = req.portal.household.find((h) => h.id === a.patient_id);
    await insert(db, 'tasks', {
      practice_id: req.portal.practice.id, patient_id: a.patient_id, priority: 'normal', due_date: now.slice(0, 10),
      title: `${p.first_name} ${p.last_name} cancelled ${a.start_time} online — offer a new time${req.body?.reason ? ` (${String(req.body.reason).slice(0, 120)})` : ''}`,
    });
    publish(req.portal.practice.id, { type: 'schedule', dates: [a.start_time.slice(0, 10)], source: 'portal' });
    await pAudit(req, 'portal.cancel', 'appointments', a.id);
    res.json({ ok: true });
  });

  // Move a visit (more than 24 hours away) to another open time with the same provider.
  const openFor = async (req, a, date) => {
    const now = await practiceNow(db, req.portal.practice.id);
    const duration = (Date.parse(`${a.end_time.replace(' ', 'T')}:00Z`) - Date.parse(`${a.start_time.replace(' ', 'T')}:00Z`)) / 60000;
    return openSlots(db, req.portal.practice.id, a.provider_id, date, { duration, step: 30, after: addHours(now, 24), typeId: a.appointment_type_id, locationId: a.location_id });
  };
  r.get('/appointments/:aid/slots', async (req, res) => {
    const a = await ownAppt(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')) throw new HttpError(400, 'date must be YYYY-MM-DD');
    res.json({ date: req.query.date, slots: await openFor(req, a, req.query.date) });
  });
  r.post('/appointments/:aid/reschedule', async (req, res) => {
    const a = await ownAppt(req);
    const { practice } = req.portal;
    const now = await practiceNow(db, practice.id);
    if (!['scheduled', 'confirmed'].includes(a.status)) throw new HttpError(409, 'This visit can’t be moved online');
    if (a.start_time <= addHours(now, 24)) throw new HttpError(409, `Visits within 24 hours can't be moved online — please call ${practice.phone || 'the office'}`);
    const start = String(req.body?.start || '');
    if (!(await openFor(req, a, start.slice(0, 10))).includes(start)) throw new HttpError(409, 'That time was just taken. Please pick another.');
    const minutes = (Date.parse(`${a.end_time.replace(' ', 'T')}:00Z`) - Date.parse(`${a.start_time.replace(' ', 'T')}:00Z`)) / 60000;
    const end = new Date(Date.parse(`${start.replace(' ', 'T')}:00Z`) + minutes * 60000).toISOString().slice(0, 16).replace('T', ' ');
    // Keep the chair if it's free then; otherwise the office picks one.
    let row = { ...a, start_time: start, end_time: end };
    try {
      await validateAppt(db, practice.id, row);
    } catch (err) {
      if (err.status !== 409 || !a.operatory_id) throw err;
      row = { ...row, operatory_id: null };
      await validateAppt(db, practice.id, row);
    }
    await db.run('UPDATE appointments SET start_time = ?, end_time = ?, operatory_id = ?, status = ?, confirmed_at = NULL, reminder_sent_at = NULL WHERE id = ?', start, end, row.operatory_id, 'scheduled', a.id);
    const p = req.portal.household.find((h) => h.id === a.patient_id);
    await insert(db, 'tasks', {
      practice_id: practice.id, patient_id: a.patient_id, priority: 'normal', due_date: now.slice(0, 10),
      title: `${p.first_name} ${p.last_name} moved their visit online: ${a.start_time} → ${start}${row.operatory_id ? '' : ' (needs a chair)'}`,
    });
    publish(practice.id, { type: 'schedule', dates: [...new Set([a.start_time.slice(0, 10), start.slice(0, 10)])], source: 'portal' });
    await emitAppointment(db, a.id);
    await pAudit(req, 'portal.reschedule', 'appointments', a.id, { from: a.start_time, to: start });
    res.json({ ok: true, start_time: start });
  });

  // Secure messages with the office (they show in the staff inbox; replies come back here).
  r.get('/messages', async (req, res) => {
    const { patient } = req.portal;
    const list = await db.all(
      "SELECT id, direction, body, created_at FROM messages WHERE patient_id = ? AND channel = 'portal' ORDER BY id DESC LIMIT 100", patient.id,
    );
    await db.run("UPDATE messages SET read_at = datetime('now') WHERE patient_id = ? AND channel = 'portal' AND direction = 'outbound' AND read_at IS NULL", patient.id);
    res.json(list.reverse());
  });
  r.post('/messages', async (req, res) => {
    const { patient, practice } = req.portal;
    const body = String(req.body?.body || '').trim().slice(0, 2000);
    if (!body) throw new HttpError(400, 'Write a message first');
    const recent = await db.get("SELECT COUNT(*) AS n FROM messages WHERE patient_id = ? AND channel = 'portal' AND direction = 'inbound' AND created_at > ?", patient.id, new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' '));
    if (recent.n >= 10) throw new HttpError(429, 'That’s a lot of messages — please call the office');
    const id = await insert(db, 'messages', {
      practice_id: practice.id, patient_id: patient.id, channel: 'portal', direction: 'inbound', kind: 'reply', to_address: 'office', from_address: 'portal', body, status: 'sent', sent_at: new Date().toISOString(),
    });
    publish(practice.id, { type: 'message', patient_id: patient.id });
    await pAudit(req, 'portal.message', 'messages', id);
    res.status(201).json({ id });
  });

  // Statement of account and payment receipts as PDFs.
  const pdfOut = (res, doc, name) => res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"` }).send(doc.toBuffer());
  const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const head = (doc, practice, title) => {
    doc.text(practice.name, { size: 15, bold: true, gap: 1 });
    doc.text([practice.address, practice.city, practice.state, practice.zip].filter(Boolean).join(', '), { size: 9.5, gap: 1 });
    if (practice.phone) doc.text(practice.phone, { size: 9.5 });
    doc.space(8);
    doc.text(title, { size: 13, bold: true });
  };
  // ---- Insurance: what's on file, and sending in new coverage with photos of the card ----
  const member = (req, id) => {
    const m = req.portal.household.find((h) => h.id === Number(id));
    if (!m) throw new HttpError(404, 'Family member not found');
    return m;
  };
  r.get('/insurance', async (req, res) => {
    const { household, ids } = req.portal;
    const policies = await db.all(
      `SELECT pi.patient_id, pi.priority, pi.subscriber_name, pi.subscriber_id, pi.group_number, ic.name AS carrier_name FROM patient_insurance pi JOIN insurance_carriers ic ON ic.id = pi.carrier_id
       WHERE pi.active = 1 AND pi.patient_id IN (${inList(ids)}) ORDER BY pi.patient_id, CASE pi.priority WHEN 'primary' THEN 0 ELSE 1 END`, ...ids,
    );
    const pending = await db.all(`SELECT id, patient_id, carrier_name, member_id, created_at FROM insurance_updates WHERE status = 'pending' AND patient_id IN (${inList(ids)}) ORDER BY id DESC`, ...ids);
    res.json(household.map((h) => ({ id: h.id, first_name: h.first_name, policies: policies.filter((p) => p.patient_id === h.id), pending: pending.filter((u) => u.patient_id === h.id) })));
  });
  r.post('/insurance/cards', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    const m = member(req, req.query.patient_id);
    const data = req.body;
    if (!Buffer.isBuffer(data) || !data.length) throw new HttpError(400, 'Empty upload');
    const side = req.query.side === 'back' ? 'back' : 'front';
    const mime = sniffMime(data, String(req.query.filename || ''));
    if (!mime || !/^(image\/|application\/pdf)/.test(mime)) throw new HttpError(415, 'Photos or PDFs only');
    const saved = await storage.save(req.portal.practice.id, data);
    const id = await insert(db, 'documents', {
      practice_id: req.portal.practice.id, patient_id: m.id, category: 'insurance_card', filename: `insurance-card-${side}.${mime === 'application/pdf' ? 'pdf' : mime.split('/')[1].replace('jpeg', 'jpg')}`,
      mime, size: data.length, storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, notes: `Insurance card (${side}) sent from the patient portal`,
    });
    await pAudit(req, 'portal.insurance_card', 'documents', id, { patient_id: m.id, side });
    publish(req.portal.practice.id, { type: 'documents', patient_id: m.id });
    res.status(201).json({ id, side });
  });
  r.post('/insurance/update', async (req, res) => {
    const m = member(req, req.body?.patient_id);
    const clean = (v, n) => String(v ?? '').trim().slice(0, n) || null;
    const row = {
      carrier_name: clean(req.body.carrier_name, 100), member_id: clean(req.body.member_id, 60), group_number: clean(req.body.group_number, 60),
      subscriber_name: clean(req.body.subscriber_name, 100), subscriber_dob: clean(req.body.subscriber_dob, 10), relationship: clean(req.body.relationship, 20), note: clean(req.body.note, 1000),
    };
    if (!row.carrier_name && !row.member_id) throw new HttpError(400, 'Enter the insurance company and member ID (or add photos of the card)');
    if (row.subscriber_dob && !/^\d{4}-\d{2}-\d{2}$/.test(row.subscriber_dob)) throw new HttpError(400, 'Date of birth must be YYYY-MM-DD');
    if (row.relationship && !['self', 'spouse', 'child', 'other'].includes(row.relationship)) row.relationship = 'other';
    // Only card photos this patient just sent from the portal.
    const docIds = [...new Set((Array.isArray(req.body.document_ids) ? req.body.document_ids : []).map(Number))].slice(0, 4);
    const docs = docIds.length ? await db.all(`SELECT id FROM documents WHERE patient_id = ? AND category = 'insurance_card' AND uploaded_by IS NULL AND id IN (${inList(docIds)})`, m.id, ...docIds) : [];
    const id = await insert(db, 'insurance_updates', { practice_id: req.portal.practice.id, patient_id: m.id, ...row, document_ids: JSON.stringify(docs.map((d) => d.id)) });
    const today = (await practiceNow(db, req.portal.practice.id)).slice(0, 10);
    await insert(db, 'tasks', { practice_id: req.portal.practice.id, patient_id: m.id, title: `Insurance update from the portal: ${m.first_name} ${m.last_name}${row.carrier_name ? ` — ${row.carrier_name}` : ''}`, due_date: today, priority: 'normal' });
    await pAudit(req, 'portal.insurance_update', 'insurance_updates', id, { patient_id: m.id });
    publish(req.portal.practice.id, { type: 'message', patient_id: m.id });
    res.status(201).json({ id, status: 'pending' });
  });

  r.get('/statement.pdf', async (req, res) => {
    const { patient, practice, ids, household } = req.portal;
    const today = (await practiceNow(db, practice.id)).slice(0, 10);
    const from = new Date(Date.parse(`${today}T12:00:00Z`) - 365 * 86400_000).toISOString().slice(0, 10);
    const L = inList(ids);
    const opening = (await db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE patient_id IN (${L}) AND entry_date < ?`, ...ids, from)).n;
    const rows = await db.all(`SELECT l.entry_date, l.description, l.amount, p.first_name FROM ledger_entries l JOIN patients p ON p.id = l.patient_id WHERE l.patient_id IN (${L}) AND l.entry_date >= ? ORDER BY l.entry_date, l.id`, ...ids, from);
    const pending = (await pendingInsurance(db, practice.id, ids)).total;
    const doc = new PdfDoc({ footer: `${practice.name} · statement for ${patient.first_name} ${patient.last_name}` });
    head(doc, practice, `Statement of account · ${today}`);
    doc.text(`${patient.first_name} ${patient.last_name}${household.length > 1 ? ' and family' : ''}`, { size: 10.5 });
    doc.space(6);
    const at = [0, 0.16, 0.34, 0.8];
    doc.row(['Date', 'Patient', 'Description', 'Amount'], { at, right: [3], bold: true });
    doc.rule();
    doc.row([from, '', 'Balance brought forward', money(opening)], { at, right: [3] });
    let bal = opening;
    for (const x of rows) { bal += x.amount; doc.row([x.entry_date, x.first_name, x.description, money(x.amount)], { at, right: [3] }); }
    doc.rule();
    doc.row(['', '', 'Balance', money(bal)], { at, right: [3], bold: true });
    if (pending > 0) doc.row(['', '', 'Expected from insurance', money(-Math.min(pending, Math.max(bal, 0)))], { at, right: [3] });
    doc.row(['', '', 'You owe', money(Math.max(0, bal - pending))], { at, right: [3], bold: true });
    await pAudit(req, 'portal.statement', 'patients', patient.id);
    pdfOut(res, doc, `statement-${today}.pdf`);
  });
  r.get('/payments', async (req, res) => {
    const { ids } = req.portal;
    res.json(await db.all(
      `SELECT l.id, l.entry_date, l.amount, l.method, p.first_name FROM ledger_entries l JOIN patients p ON p.id = l.patient_id
       WHERE l.patient_id IN (${inList(ids)}) AND l.type = 'payment' AND l.amount < 0 AND l.voided_at IS NULL ORDER BY l.entry_date DESC, l.id DESC LIMIT 50`, ...ids,
    ));
  });
  r.get('/receipts/:lid.pdf', async (req, res) => {
    const { practice, ids } = req.portal;
    const data = await receiptData(db, Number(req.params.lid), practice.id);
    if (!data || !ids.includes(data.entry.patient_id)) throw new HttpError(404, 'Payment not found');
    await pAudit(req, 'portal.receipt', 'ledger_entries', data.entry.id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="receipt-${data.entry.id}.pdf"` }).send(receiptPdf(data));
  });

  // Membership plans: join with the card on file (charged now), or ask the office if there's no card yet.
  r.get('/membership-plans', async (req, res) => {
    const { practice, ids } = req.portal;
    res.json({
      plans: await db.all('SELECT id, name, description, price, interval, discount_pct, min_age, max_age FROM membership_plans WHERE practice_id = ? AND active = 1 ORDER BY price', practice.id),
      members: await db.all(`SELECT m.patient_id, m.status, mp.name FROM memberships m JOIN membership_plans mp ON mp.id = m.plan_id WHERE m.patient_id IN (${inList(ids)}) AND m.status IN ('active','past_due')`, ...ids),
    });
  });
  r.post('/memberships', async (req, res) => {
    const { practice, household, patient: me } = req.portal;
    const who = household.find((h) => h.id === Number(req.body?.patient_id || me.id));
    if (!who) throw new HttpError(404, 'Patient not found');
    const plan = await db.get('SELECT * FROM membership_plans WHERE id = ? AND practice_id = ? AND active = 1', Number(req.body?.plan_id), practice.id);
    if (!plan) throw new HttpError(404, 'Plan not found');
    const today = (await practiceNow(db, practice.id)).slice(0, 10);
    const years = who.dob ? Math.floor((new Date(today) - new Date(who.dob)) / (365.25 * 86400_000)) : null;
    if ((plan.min_age != null && (years == null || years < plan.min_age)) || (plan.max_age != null && (years == null || years > plan.max_age))) throw new HttpError(400, `${plan.name} isn't available for ${who.first_name}'s age`);
    if (await db.get("SELECT id FROM memberships WHERE patient_id = ? AND status IN ('active','past_due')", who.id)) throw new HttpError(409, `${who.first_name} already has a membership`);
    const payer = who.guarantor_id || who.id;
    const card = await db.get('SELECT id FROM payment_methods WHERE patient_id = ? AND practice_id = ? AND removed_at IS NULL ORDER BY id DESC LIMIT 1', payer, practice.id);
    if (!card || !payments.enabled) {
      await insert(db, 'tasks', { practice_id: practice.id, patient_id: who.id, priority: 'normal', due_date: today, title: `${who.first_name} ${who.last_name} asked to join ${plan.name} online — set up their card and enroll them` });
      await pAudit(req, 'portal.membership_request', 'patients', who.id, { plan: plan.name });
      return res.status(202).json({ requested: true });
    }
    const id = await insert(db, 'memberships', {
      practice_id: practice.id, patient_id: who.id, plan_id: plan.id, start_date: today, next_bill_date: today, paid_through: today, payment_method_id: card.id, autopay: 1,
    });
    const billing = await runMembershipBilling(db, payments, { membershipId: id, messenger });
    await pAudit(req, 'portal.membership', 'memberships', id, { plan: plan.name });
    res.status(201).json({ id, charged: billing.some((b) => b.ok !== false) });
  });

  // Fresh links for forms and treatment plans (links are single-purpose tokens; only hashes are stored).
  r.post('/forms/:fid/open', async (req, res) => {
    const f = await db.get(`SELECT * FROM form_requests WHERE id = ? AND patient_id IN (${inList(req.portal.ids)}) AND completed_at IS NULL`, Number(req.params.fid), ...req.portal.ids);
    if (!f) throw new HttpError(404, 'Form not found');
    const { token, hash } = newToken();
    await db.run('UPDATE form_requests SET token_hash = ? WHERE id = ?', hash, f.id);
    res.json({ url: `/f/${token}` });
  });

  r.post('/treatment-plans/:tid/open', async (req, res) => {
    const tp = await db.get(`SELECT * FROM treatment_plans WHERE id = ? AND patient_id IN (${inList(req.portal.ids)}) AND signed_at IS NULL`, Number(req.params.tid), ...req.portal.ids);
    if (!tp) throw new HttpError(404, 'Treatment plan not found');
    const { token, hash } = newToken();
    await db.run("UPDATE treatment_plans SET sign_token_hash = ?, presented_at = COALESCE(presented_at, datetime('now')) WHERE id = ?", hash, tp.id);
    await pAudit(req, 'portal.plan_open', 'treatment_plans', tp.id);
    res.json({ url: `/tp/${token}` });
  });

  // Pay the balance: Stripe's hosted page, or an immediate simulated payment in sandbox mode.
  r.post('/pay', async (req, res) => {
    const { patient, practice } = req.portal;
    const payer = patient.guarantor_id ? await db.get('SELECT * FROM patients WHERE id = ?', patient.guarantor_id) : patient;
    const amount = Math.round(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount < 50) throw new HttpError(400, 'Enter an amount of at least $0.50');
    if (!payments.enabled) throw new HttpError(409, `Online payments aren't available — please call ${practice.phone || 'the office'}`);
    const today = (await practiceNow(db, practice.id)).slice(0, 10);
    if (payments.mode === 'sandbox') {
      // Simulated payments can't exceed what the account owes (no credit balances from the demo).
      const owed = (await db.get('SELECT COALESCE(SUM(l.amount), 0) AS n FROM ledger_entries l JOIN patients p ON p.id = l.patient_id WHERE p.id = ? OR p.guarantor_id = ?', payer.id, payer.id)).n;
      if (amount > owed) throw new HttpError(400, owed > 0 ? `The most you can pay is $${(owed / 100).toFixed(2)}` : 'There is nothing to pay right now');
      await insert(db, 'ledger_entries', { practice_id: practice.id, patient_id: payer.id, type: 'payment', amount: -amount, description: 'Online payment (patient portal, sandbox)', method: 'credit_card', reference: `sbx_portal_${Date.now().toString(36)}`, entry_date: today });
      await pAudit(req, 'portal.payment', 'patients', payer.id, { amount, sandbox: true });
      return res.status(201).json({ paid: true });
    }
    const id = await insert(db, 'payment_requests', { practice_id: practice.id, patient_id: payer.id, amount });
    const session = await payments.stripe('POST', 'checkout/sessions', {
      mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(amount),
      'line_items[0][price_data][product_data][name]': `${practice.name} - account payment`, client_reference_id: String(id),
      'metadata[payment_request_id]': String(id), 'metadata[practice_id]': String(practice.id),
      success_url: `${config.appUrl}/portal/${portalKey(practice)}?paid=1`, cancel_url: `${config.appUrl}/portal/${portalKey(practice)}`,
      ...(payer.email ? { customer_email: payer.email } : {}),
    });
    await db.run('UPDATE payment_requests SET session_id = ?, url = ? WHERE id = ?', session.id, session.url, id);
    await pAudit(req, 'portal.payment_start', 'payment_requests', id, { amount });
    res.status(201).json({ url: session.url });
  });

  return r;
}
