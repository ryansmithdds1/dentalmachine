import { Router } from 'express';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { HttpError, rateLimit, signToken, verifyToken } from '../auth.js';
import { hit } from '../cluster.js';
import { insert, audit, practiceNow, newToken, pick, mapSeq, publicPractice } from '../util.js';
import { sendMessage } from '../messaging.js';
import { publish } from '../events.js';
import { planStatus } from './family.js';
import { estimateCoverage, primaryPolicy, pendingInsurance } from '../services.js';

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
      sendMessage(db, messenger, {
        practiceId: practice.id, patientId: patient.id, kind: 'portal_code', channel: isEmail ? 'email' : 'sms', to: isEmail ? patient.email : patient.phone,
        subject: `Your ${practice.name} sign-in code`,
        body: `${code} is your ${practice.name} patient portal code. It expires in ${CODE_TTL_MINUTES} minutes. If you didn't ask for it, you can ignore this message.`,
      }).catch(() => {});
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

export function portalRoutes({ db, secret, config, payments }) {
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
