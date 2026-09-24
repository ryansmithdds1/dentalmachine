import { Router } from 'express';
import { HttpError, requirePermission, can, rateLimit } from '../auth.js';
import { audit, findOr404, practiceNow, recorded, newToken } from '../util.js';
import { canSeePatient, patientScope } from '../officeaccess.js';
import { raiseIssue, resolveIssue } from '../issues.js';
import { publish } from '../events.js';
import { structured as defaultStructured } from '../ai.js';
import { ensureSequences, verifyLink, addDays, messageVars, cadenceType, daysBetween, OUTCOMES } from '../cadence.js';
import { TYPE, board, DEFAULT_TREATMENT_CADENCES } from '../txfollow.js';
import { planFacts, URGENCIES, URGENCY_LABELS } from '../txwords.js';
import {
  createLetterDraft, updateLetter, approveLetter, cancelLetter, letterModel, letterHtml, letterPdf, canApprove, aiWording, applyAiWording, letterForToken, LETTER_STATUS,
} from '../txletter.js';

// Treatment follow-up, staff side (TF1–TF4, docs/workflows/specs/TF-treatment-followup.md): the switch, the board,
// the calls to make, the doctor's letters (drafts to review, edit, mark up and approve — one or a batch), the
// letterhead and each doctor's signature. The sequences themselves are edited with the cadence routes
// (/cadence/sequences?type=treatment). Mounted on the signed-in API router; every route checks its permission,
// the practice and the office. txFollowPublicRoutes is the patient's link (mounted under /api/public).

const adminOnly = (req) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Only administrators can change this');
};
const IMG = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/;
const imageFrom = (dataUrl, maxBytes, what) => {
  const m = IMG.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, `${what} must be a PNG or JPEG image`);
  const data = Buffer.from(m[2], 'base64');
  if (data.length > maxBytes) throw new HttpError(400, `${what} is too big (up to ${Math.round(maxBytes / 1024)} KB)`);
  const png = data.length > 8 && data.readUInt32BE(0) === 0x89504e47;
  const jpg = data[0] === 0xff && data[1] === 0xd8;
  if ((m[1] === 'image/png' && !png) || (m[1] === 'image/jpeg' && !jpg)) throw new HttpError(400, `${what} isn’t a real PNG or JPEG`);
  return { mime: m[1], data };
};

export default function txFollowRoutes({ db, messenger, mailer = null, config = {}, storage = null, structured = defaultStructured }) {
  const r = Router();
  const deps = () => ({ messenger, mailer, storage, appUrl: config.appUrl });
  const loadLetter = async (req, id = req.params.id) => {
    const l = await findOr404(db, 'txf_letters', id, req.user.practice_id, 'Letter');
    if (!(await canSeePatient(db, req.user, l.patient_id))) throw new HttpError(404, 'Letter not found');
    return l;
  };

  // ---- The switch ----
  r.get('/txfollow/settings', requirePermission('schedule:read'), async (req, res) => {
    const p = await db.get('SELECT treatment_cadence, treatment_cadence_from, send_from, send_until, timezone FROM practices WHERE id = ?', req.user.practice_id);
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    res.json({
      enabled: !!p.treatment_cadence, from_date: p.treatment_cadence_from || null, default_from: addDays(today, -180), send_from: p.send_from || '08:00', send_until: p.send_until || '20:00',
      texting: messenger?.status?.sms || 'log', email: messenger?.status?.email || 'log', mail: mailer?.enabled ? mailer.name : null,
      urgencies: URGENCIES.map((u) => ({ key: u, label: URGENCY_LABELS[u] })),
    });
  });
  r.put('/txfollow/settings', requirePermission('schedule:write'), async (req, res) => {
    adminOnly(req);
    const pid = req.user.practice_id;
    const b = req.body || {};
    if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    if (b.from_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.from_date))) throw new HttpError(400, 'from_date must be a date (YYYY-MM-DD)');
    const before = await db.get('SELECT treatment_cadence, treatment_cadence_from FROM practices WHERE id = ?', pid);
    const today = (await practiceNow(db, pid)).slice(0, 10);
    if (b.from_date && b.from_date > today) throw new HttpError(400, 'The starting date can’t be in the future');
    const from = b.from_date || before.treatment_cadence_from || addDays(today, -180);
    await recorded(db, 'practices', pid, () => db.run('UPDATE practices SET treatment_cadence = ?, treatment_cadence_from = ? WHERE id = ?', b.enabled ? 1 : 0, from, pid));
    if (b.enabled) {
      await ensureSequences(db, pid, TYPE);
      await db.run('UPDATE cadence_sequences SET family_window_days = 0 WHERE practice_id = ? AND type = ? AND updated_by IS NULL', pid, TYPE);
    }
    await audit(db, req, b.enabled ? 'cadence.treatment.on' : 'cadence.treatment.off', 'practices', pid, null, {
      before: { treatment_cadence: before.treatment_cadence, treatment_cadence_from: before.treatment_cadence_from }, after: { treatment_cadence: b.enabled ? 1 : 0, treatment_cadence_from: from },
    });
    res.json({ enabled: b.enabled, from_date: from });
  });
  r.get('/txfollow/recommended', requirePermission('schedule:read'), (_req, res) => res.json(DEFAULT_TREATMENT_CADENCES));

  // A plan's urgency (which sequence it follows): the doctor's call; unset = worked out from the procedures.
  r.put('/txfollow/plans/:tid/urgency', requirePermission('clinical:write'), async (req, res) => {
    const plan = await findOr404(db, 'treatment_plans', req.params.tid, req.user.practice_id, 'Treatment plan');
    if (!(await canSeePatient(db, req.user, plan.patient_id))) throw new HttpError(404, 'Treatment plan not found');
    const u = req.body?.urgency ?? null;
    if (u !== null && !URGENCIES.includes(u)) throw new HttpError(400, 'Urgency is urgent, soon or elective');
    await recorded(db, 'treatment_plans', plan.id, () => db.run('UPDATE treatment_plans SET followup_urgency = ? WHERE id = ?', u, plan.id));
    await audit(db, req, 'treatment_plan.followup_urgency', 'treatment_plans', plan.id, { urgency: u }, { patientId: plan.patient_id, before: { followup_urgency: plan.followup_urgency }, after: { followup_urgency: u } });
    const facts = await planFacts(db, { ...plan, followup_urgency: u });
    res.json({ id: plan.id, urgency: facts.urgency, chosen: u, derived: facts.derived_urgency });
  });

  // ---- The board and the numbers (TF4) ----
  const scoped = (req) => {
    const s = patientScope(req.user, 'p');
    const want = req.query.location_id ? Number(req.query.location_id) : null;
    if (want && Number.isInteger(want)) {
      if (Array.isArray(req.user.location_ids) && req.user.location_ids.length && !req.user.location_ids.includes(want)) throw new HttpError(403, "That office isn't one of yours");
      return { officeSql: `${s.sql} AND e.location_id = ?`, officeArgs: [...s.args, want] };
    }
    return { officeSql: s.sql, officeArgs: s.args };
  };
  const period = (req) => Math.min(Math.max(Number(req.query.days) || 90, 7), 730);
  r.get('/txfollow/board', requirePermission('schedule:read'), async (req, res) => {
    res.json(await board(db, req.user.practice_id, { days: period(req), ...scoped(req), showMoney: can(req.user, 'billing:read') }));
  });
  r.get('/txfollow/metrics', requirePermission('schedule:read'), async (req, res) => {
    const b = await board(db, req.user.practice_id, { days: period(req), ...scoped(req), showMoney: can(req.user, 'billing:read') });
    res.json({
      days: b.days, enabled: b.enabled, active: b.totals.active, booked: b.totals.booked, booking_rate: b.totals.booking_rate, scheduled: b.totals.scheduled,
      open_amount: b.totals.open_amount, declined: b.totals.declined, done: b.totals.done, end_of_cadence: b.totals.completed_no_booking,
      letters_waiting: b.letters.waiting, letters_sent: b.letters.sent, letters_failed: b.letters.failed, booked_after_letter: b.letters.booked_after,
      open_calls: b.open_calls, by_step: b.by_step, by_urgency: b.by_urgency, stages: b.stages.map(({ key, label, count, amount }) => ({ key, label, count, amount })),
    });
  });

  // ---- Calls to make: the script names the work and the cost; outcomes go to POST /cadence/runs/:id/outcome ----
  r.get('/txfollow/calls', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const s = patientScope(req.user, 'p');
    const mine = req.query.mine === '1';
    const rows = await db.all(
      `SELECT r.id, r.patient_id, r.enrollment_id, r.due_date, r.task_id, st.template, e.anchor_date, s.subtype, p.first_name, p.last_name, p.preferred_name, p.phone, p.phone_home, p.phone_work,
         t.assigned_to, u.name AS assigned_name
       FROM cadence_runs r JOIN cadence_enrollments e ON e.id = r.enrollment_id JOIN cadence_sequences s ON s.id = e.sequence_id JOIN cadence_steps st ON st.id = r.step_id
         JOIN patients p ON p.id = r.patient_id LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN users u ON u.id = t.assigned_to
       WHERE r.practice_id = ? AND s.type = ? AND r.status = 'task' AND r.channel = 'task_call' AND e.status = 'active'${s.sql}${mine ? ' AND (t.assigned_to IS NULL OR t.assigned_to = ?)' : ''}
       ORDER BY r.due_date, r.id LIMIT 300`, pid, TYPE, ...s.args, ...(mine ? [req.user.id] : []),
    );
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', pid);
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const money_ = can(req.user, 'billing:read');
    const out = [];
    for (const row of rows) {
      const e = await db.get('SELECT * FROM cadence_enrollments WHERE id = ?', row.enrollment_id);
      const plan = await db.get('SELECT * FROM treatment_plans WHERE id = ?', e.source_id);
      const facts = plan ? await planFacts(db, plan) : null;
      const { visit } = await cadenceType(TYPE).describe(db, [e]);
      const recipient = { id: row.patient_id, first_name: row.first_name, preferred_name: row.preferred_name };
      const vars = messageVars({ practice, recipient, patients: [recipient], anchor: row.anchor_date, visit, link: 'the link in our text' });
      const history = await db.all("SELECT r.due_date, r.status, r.channel, r.outcome FROM cadence_runs r WHERE r.enrollment_id = ? AND r.id <> ? AND r.status <> 'skipped' ORDER BY r.due_date DESC, r.id DESC LIMIT 5", row.enrollment_id, row.id);
      out.push({
        id: row.id, patient_id: row.patient_id, name: `${row.preferred_name || row.first_name} ${row.last_name}`, phone: row.phone || row.phone_home || row.phone_work,
        urgency: row.subtype, treatment: facts?.words || '', cost: money_ && facts ? facts.cost : null, diagnosed: row.anchor_date, days: daysBetween(row.anchor_date, today),
        assigned_name: row.assigned_name, script: String(row.template || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''), history, treatment_plan_id: plan?.id ?? null,
      });
    }
    res.json({ calls: out, outcomes: Object.entries(OUTCOMES).map(([key, label]) => ({ key, label })) });
  });

  // ---- The doctor's letters ----
  const letterRow = async (l, user) => {
    const p = await db.get('SELECT first_name, last_name, preferred_name FROM patients WHERE id = ?', l.patient_id);
    const pv = l.provider_id ? await db.get('SELECT name FROM providers WHERE id = ?', l.provider_id) : null;
    const plan = await db.get('SELECT name FROM treatment_plans WHERE id = ?', l.treatment_plan_id);
    return {
      id: l.id, status: l.status, status_label: LETTER_STATUS[l.status], patient_id: l.patient_id, patient_name: p ? `${p.preferred_name || p.first_name} ${p.last_name}` : '',
      treatment_plan_id: l.treatment_plan_id, plan_name: plan?.name || '', treatment: l.treatment, diagnosis: l.diagnosis, cost: can(user, 'billing:read') ? l.cost : null,
      doctor: pv?.name || null, provider_id: l.provider_id, has_image: !!l.document_id, source: l.source, ai_drafted: !!l.ai_drafted, created_at: l.created_at, sent_at: l.sent_at,
      send_email: !!l.send_email, send_mail: !!l.send_mail, email_status: l.email_status, mail_status: l.mail_status, error: l.error, cancel_reason: l.cancel_reason,
      can_approve: ['draft', 'failed'].includes(l.status) && await canApprove(db, user, l),
    };
  };
  r.get('/txfollow/letters', requirePermission('clinical:read'), async (req, res) => {
    const status = String(req.query.status || 'open');
    const where = status === 'open' ? "l.status IN ('draft','failed','sending')" : status === 'all' ? '1 = 1' : 'l.status = ?';
    const s = patientScope(req.user, 'p');
    const rows = await db.all(
      `SELECT l.* FROM txf_letters l JOIN patients p ON p.id = l.patient_id WHERE l.practice_id = ? AND ${where}${s.sql} ORDER BY CASE WHEN l.status = 'failed' THEN 0 ELSE 1 END, l.created_at, l.id LIMIT 300`,
      req.user.practice_id, ...(['open', 'all'].includes(status) ? [] : [status]), ...s.args,
    );
    const out = [];
    for (const l of rows) out.push(await letterRow(l, req.user));
    res.json({ letters: out, mine: out.filter((l) => l.can_approve).length });
  });
  // The doctor writes one now (without waiting for the cadence), from the plan.
  r.post('/txfollow/letters', requirePermission('clinical:write'), async (req, res) => {
    const plan = await findOr404(db, 'treatment_plans', req.body?.treatment_plan_id, req.user.practice_id, 'Treatment plan');
    if (!(await canSeePatient(db, req.user, plan.patient_id))) throw new HttpError(404, 'Treatment plan not found');
    if (!['proposed', 'accepted'].includes(plan.status)) throw new HttpError(409, 'This plan is not open any more');
    const facts = await planFacts(db, plan);
    if (!facts.procedures.length) throw new HttpError(409, 'Everything on this plan is already scheduled or done');
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    const e = await db.get("SELECT e.id FROM cadence_enrollments e JOIN cadence_sequences s ON s.id = e.sequence_id WHERE e.source_type = 'treatment_plan' AND e.source_id = ? AND e.status = 'active' AND s.type = ?", plan.id, TYPE);
    const { letter, created } = await createLetterDraft(db, { practice, plan, enrollmentId: e?.id ?? null, source: 'human', userId: req.user.id });
    res.status(created ? 201 : 200).json({ ...(await letterRow(letter, req.user)), existing: !created });
  });
  r.get('/txfollow/letters/:id', requirePermission('clinical:read'), async (req, res) => {
    const l = await loadLetter(req);
    const m = await letterModel(db, l, { storage, link: l.status === 'sent' ? null : `${config.appUrl || ''}/…` });
    const images = await db.all(
      "SELECT id, category, tooth, filename, mime, taken_at, created_at FROM documents WHERE patient_id = ? AND practice_id = ? AND deleted_at IS NULL AND category IN ('xray','photo') ORDER BY id DESC LIMIT 60",
      l.patient_id, l.practice_id,
    );
    const doctors = await db.all("SELECT p.id, p.name, (SELECT COUNT(*) FROM txf_doctors d WHERE d.provider_id = p.id AND d.signature_key IS NOT NULL) AS signed FROM providers p WHERE p.practice_id = ? AND p.active = 1 AND p.type IN ('dentist','specialist') ORDER BY p.name", l.practice_id);
    const warnings = [];
    const signer = doctors.find((d) => d.id === l.provider_id);
    if (!signer) warnings.push('Choose the doctor who signs this letter.');
    else if (!Number(signer.signed)) warnings.push(`No signature on file for ${signer.name} — add it in Letter setup (the letter goes out with the typed name until then).`);
    if (!l.document_id) warnings.push('No x-ray or photo chosen — the letter reads well without one, but a picture helps.');
    else if (!m.image) warnings.push('The chosen picture can’t be shown in a letter (it needs to be a PNG, JPEG or uncompressed DICOM).');
    if (!l.send_email && !l.send_mail) warnings.push('Neither email nor a paper copy is chosen — the office will be asked to print it.');
    if (l.send_mail && !mailer?.enabled) warnings.push('No mail service is set up: the paper copy becomes a task to print and mail at the office.');
    await audit(db, req, 'txf_letter.view', 'txf_letters', l.id, null, { patientId: l.patient_id });
    res.json({
      letter: { ...(await letterRow(l, req.user)), why: l.why, risk: l.risk, closing: l.closing, markup: l.markup ? JSON.parse(l.markup) : null, document_id: l.document_id, ai_reason: l.ai_reason, total_fee: l.total_fee, insurance: l.insurance, cost: l.cost },
      effective_markup: m.markup, image: m.image ? { width: m.image.width, height: m.image.height } : null,
      html: letterHtml(m, { mode: 'preview' }), images, doctors: doctors.map((d) => ({ id: d.id, name: d.name, has_signature: !!Number(d.signed) })), warnings,
    });
  });
  r.put('/txfollow/letters/:id', requirePermission('clinical:write'), async (req, res) => {
    const l = await loadLetter(req);
    const out = await updateLetter(db, req, l, req.body || {});
    publish(req.user.practice_id, { type: 'txfollow', patient_id: l.patient_id });
    res.json(await letterRow(out, req.user));
  });
  r.get('/txfollow/letters/:id/pdf', requirePermission('clinical:read'), async (req, res) => {
    const l = await loadLetter(req);
    const m = await letterModel(db, l, { storage });
    await audit(db, req, 'txf_letter.pdf', 'txf_letters', l.id, null, { patientId: l.patient_id });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="letter-${l.id}.pdf"`, 'Cache-Control': 'no-store' }).send(letterPdf(m));
  });
  r.post('/txfollow/letters/:id/approve', requirePermission('clinical:sign'), async (req, res) => {
    const l = await loadLetter(req);
    const out = await approveLetter(db, req, l, deps());
    res.json({ ...out, letter: await letterRow(out.letter, req.user) });
  });
  // Batch: every letter the doctor ticked. Each one is checked and sent on its own; one failing doesn't stop the rest.
  r.post('/txfollow/letters/approve', requirePermission('clinical:sign'), async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(Number.isInteger))] : [];
    if (!ids.length || ids.length > 100) throw new HttpError(400, 'Choose 1 to 100 letters to approve');
    const results = [];
    for (const id of ids) {
      try {
        const l = await loadLetter(req, id);
        const out = await approveLetter(db, req, l, deps());
        results.push({ id, status: out.letter.status, already: !!out.already, cancelled: !!out.cancelled, reason: out.reason || null, error: out.letter.error || null });
      } catch (err) {
        results.push({ id, status: 'error', error: err.message });
      }
    }
    res.json({ results, sent: results.filter((x) => x.status === 'sent').length });
  });
  r.post('/txfollow/letters/:id/cancel', requirePermission('clinical:write'), async (req, res) => {
    const l = await loadLetter(req);
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (!reason) throw new HttpError(400, 'Say why it isn’t being sent');
    if (!(await cancelLetter(db, req, l, reason))) throw new HttpError(409, 'Only a letter that hasn’t gone can be cancelled');
    res.json(await letterRow(await db.get('SELECT * FROM txf_letters WHERE id = ?', l.id), req.user));
  });
  // AI wording (optional, labelled on screen, never sent on its own: the doctor still approves).
  r.post('/txfollow/letters/:id/ai-draft', requirePermission('clinical:write'), async (req, res) => {
    const l = await loadLetter(req);
    if (l.status !== 'draft') throw new HttpError(409, 'Only a draft can be reworded');
    const plan = await db.get('SELECT * FROM treatment_plans WHERE id = ?', l.treatment_plan_id);
    let words;
    try {
      words = await aiWording(config, await planFacts(db, plan), l, structured);
      await resolveIssue(db, req.user.practice_id, `txf-ai:${l.id}`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 503) throw err; // AI is off: nothing to look at
      await raiseIssue(db, { practiceId: req.user.practice_id, kind: 'ai', key: `txf-ai:${l.id}`, role: 'clinical', entity: 'txf_letters', entityId: l.id, patientId: l.patient_id, title: 'The AI couldn’t draft a doctor’s letter — write it yourself or try again', detail: err.message });
      throw err;
    }
    const out = await applyAiWording(db, req, l, words);
    res.json({ ...(await letterRow(out, req.user)), why: out.why, risk: out.risk, ai_reason: out.ai_reason });
  });

  // ---- Letterhead and signatures ----
  r.get('/txfollow/letter-setup', requirePermission('clinical:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const s = await db.get('SELECT brand_color, logo_key FROM txf_settings WHERE practice_id = ?', pid);
    const os = await db.get('SELECT brand_color, logo FROM online_sched_settings WHERE practice_id = ?', pid);
    const doctors = await db.all(
      `SELECT p.id, p.name, p.user_id, d.credentials, d.title, d.closing, d.signature_key, d.updated_at FROM providers p LEFT JOIN txf_doctors d ON d.provider_id = p.id
       WHERE p.practice_id = ? AND p.active = 1 AND p.type IN ('dentist','specialist') ORDER BY p.name`, pid,
    );
    res.json({
      brand_color: s?.brand_color || null, fallback_color: os?.brand_color || '#0f766e', has_logo: !!s?.logo_key, fallback_logo: !s?.logo_key && !!os?.logo,
      doctors: doctors.map((d) => ({ id: d.id, name: d.name, credentials: d.credentials || '', title: d.title || '', closing: d.closing || '', has_signature: !!d.signature_key, is_me: d.user_id === req.user.id, updated_at: d.updated_at })),
    });
  });
  r.put('/txfollow/letter-setup', requirePermission('schedule:write'), async (req, res) => {
    adminOnly(req);
    const pid = req.user.practice_id;
    const b = req.body || {};
    const before = (await db.get('SELECT * FROM txf_settings WHERE practice_id = ?', pid)) || {};
    const row = {};
    if (b.brand_color !== undefined) {
      if (b.brand_color && !/^#[0-9a-f]{6}$/i.test(b.brand_color)) throw new HttpError(400, 'The color must look like #0f766e');
      row.brand_color = b.brand_color || null;
    }
    if (b.logo !== undefined) {
      if (!b.logo) Object.assign(row, { logo_key: null, logo_mime: null, logo_encrypted: 0 });
      else {
        if (!storage) throw new HttpError(503, 'File storage is not set up');
        const img = imageFrom(b.logo, 500 * 1024, 'The logo');
        const saved = await storage.save(pid, img.data);
        Object.assign(row, { logo_key: saved.storageKey, logo_mime: img.mime, logo_encrypted: saved.encrypted ? 1 : 0 });
      }
    }
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    await db.run('INSERT INTO txf_settings (practice_id, updated_by) VALUES (?, ?) ON CONFLICT (practice_id) DO NOTHING', pid, req.user.id);
    await db.run(`UPDATE txf_settings SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE practice_id = ?`, ...Object.values(row), req.user.id, pid);
    await audit(db, req, 'txf.letterhead', 'txf_settings', pid, null, {
      before: { brand_color: before.brand_color ?? null, logo: before.logo_key ? 'set' : null }, after: { brand_color: row.brand_color ?? before.brand_color ?? null, logo: (row.logo_key ?? before.logo_key) ? (row.logo_key ? 'new' : 'set') : null },
    });
    res.json({ ok: true });
  });
  // A doctor's signature block. The doctor themself, or an administrator, sets it; the image is a stored file.
  r.put('/txfollow/doctors/:pid', requirePermission('clinical:read'), async (req, res) => {
    const pv = await findOr404(db, 'providers', req.params.pid, req.user.practice_id, 'Doctor');
    if (!['dentist', 'specialist'].includes(pv.type)) throw new HttpError(400, 'Letters are signed by a dentist');
    if (req.user.role !== 'admin' && pv.user_id !== req.user.id) throw new HttpError(403, 'Only the doctor or an administrator can change a signature');
    const b = req.body || {};
    const row = {};
    for (const [k, max] of [['credentials', 40], ['title', 80], ['closing', 60]]) if (b[k] !== undefined) row[k] = String(b[k] || '').trim().slice(0, max) || null;
    if (b.signature !== undefined) {
      if (!b.signature) Object.assign(row, { signature_key: null, signature_mime: null, signature_encrypted: 0 });
      else {
        if (!storage) throw new HttpError(503, 'File storage is not set up');
        const img = imageFrom(b.signature, 300 * 1024, 'The signature');
        const saved = await storage.save(req.user.practice_id, img.data);
        Object.assign(row, { signature_key: saved.storageKey, signature_mime: img.mime, signature_encrypted: saved.encrypted ? 1 : 0 });
      }
    }
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    const before = (await db.get('SELECT * FROM txf_doctors WHERE provider_id = ?', pv.id)) || {};
    await db.run('INSERT INTO txf_doctors (practice_id, provider_id, updated_by) VALUES (?, ?, ?) ON CONFLICT (provider_id) DO NOTHING', req.user.practice_id, pv.id, req.user.id);
    await db.run(`UPDATE txf_doctors SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE provider_id = ? AND practice_id = ?`, ...Object.values(row), req.user.id, pv.id, req.user.practice_id);
    const shown = (x) => ({ credentials: x.credentials ?? null, title: x.title ?? null, closing: x.closing ?? null, signature: x.signature_key ? 'on file' : null });
    await audit(db, req, 'txf.doctor_signature', 'providers', pv.id, { signature_changed: b.signature !== undefined }, { before: shown(before), after: shown({ ...before, ...row, signature_key: row.signature_key !== undefined ? row.signature_key : before.signature_key }) });
    res.json({ ok: true });
  });
  r.get('/txfollow/doctors/:pid/signature', requirePermission('clinical:read'), async (req, res) => {
    const pv = await findOr404(db, 'providers', req.params.pid, req.user.practice_id, 'Doctor');
    const d = await db.get('SELECT * FROM txf_doctors WHERE provider_id = ? AND practice_id = ?', pv.id, req.user.practice_id);
    const data = d?.signature_key && storage ? await storage.read(d.signature_key, !!d.signature_encrypted) : null;
    if (!data) throw new HttpError(404, 'No signature on file');
    res.set({ 'Content-Type': d.signature_mime, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(data);
  });

  return r;
}

// ---- The patient's link (public, under /api/public): /txf/<token> ----
// From a text or email (a cadence link, "<id>.<signature>") or the doctor's letter ("l.<token>"). It opens the plan
// page (/tp/…, where the patient confirms their date of birth, sees the work, the cost and payment options, and can
// accept) — or, once the plan is accepted or the work is booked, a short page with how to schedule.
const PREVIEW_BOTS = /facebookexternalhit|whatsapp|slackbot|twitterbot|telegrambot|discordbot|linkedinbot|googlebot|bingbot|applebot|skypeuripreview|preview|crawler|spider|bot\b/i;
const SIGN_LINK_DAYS = 14;
const MAX_DOB_TRIES = 5;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function page(practice, title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(practice.name)}</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f7f6;margin:0;padding:24px;color:#111">
<main style="max-width:440px;margin:0 auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)"><p style="color:#0f766e;font-weight:600;margin:0 0 6px">${esc(practice.name)}</p>
<h2 style="margin:0 0 10px">${esc(title)}</h2>${body}</main></body></html>`;
}
const callLine = (p) => (p.phone ? `<p><a href="tel:${esc(p.phone)}" style="display:block;text-align:center;padding:12px 18px;border-radius:10px;background:#0d9488;color:#fff;font-size:17px;font-weight:600;text-decoration:none">Call ${esc(p.phone)}</a></p>` : '<p>Call the office and we’ll find you a time.</p>');

export function txFollowPublicRoutes({ db, config = {}, secret, storage = null }) {
  const r = Router();
  const limit = rateLimit({ windowMs: 60_000, max: 30, name: 'txf-link' });
  const who = (plan) => ({ user: { practice_id: plan.practice_id, id: null } });

  // Which plan a token is about (and the letter, for a letter's link).
  const resolve = async (token) => {
    if (String(token).startsWith('l.')) {
      const letter = await letterForToken(db, String(token).slice(2));
      if (!letter) throw new HttpError(404, 'This link is not valid');
      return { plan: await db.get('SELECT * FROM treatment_plans WHERE id = ? AND practice_id = ?', letter.treatment_plan_id, letter.practice_id), letter, link: null };
    }
    const link = await verifyLink(db, secret, token);
    const e = await db.get('SELECT * FROM cadence_enrollments WHERE id = ? AND practice_id = ?', link.enrollment_ids[0], link.practice_id);
    if (!e || e.source_type !== 'treatment_plan') throw new HttpError(404, 'This link is not valid');
    return { plan: await db.get('SELECT * FROM treatment_plans WHERE id = ? AND practice_id = ?', e.source_id, e.practice_id), letter: null, link };
  };

  r.get('/txf/:token', limit, async (req, res) => {
    let got;
    try {
      got = await resolve(req.params.token);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      return res.status(err.status).type('html').send(page({ name: 'Your dental office' }, err.status === 410 ? 'This link has expired' : 'This link isn’t valid', `<p>${esc(err.message)}</p>`));
    }
    const { plan, letter, link } = got;
    if (!plan) return res.status(404).type('html').send(page({ name: 'Your dental office' }, 'This link isn’t valid', '<p>Please call the office.</p>'));
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', plan.practice_id);
    const bot = PREVIEW_BOTS.test(String(req.get('user-agent') || ''));
    if (link && !bot) await db.run("UPDATE cadence_links SET opened_at = COALESCE(opened_at, datetime('now')) WHERE id = ?", link.id);
    if (!bot) await audit(db, { ...who(plan), ip: req.ip }, 'treatment_plan.followup_link', 'treatment_plans', plan.id, { patient_id: plan.patient_id, via: letter ? 'letter' : 'message', letter_id: letter?.id ?? null });
    const booking = practice.online_booking && practice.slug ? `${config.appUrl || ''}/book/${encodeURIComponent(practice.slug)}` : null;
    const bookLine = booking ? `<p><a href="${esc(booking)}" style="display:block;text-align:center;padding:12px 18px;border-radius:10px;border:1px solid #0d9488;color:#0d9488;font-size:17px;font-weight:600;text-decoration:none">Choose a time online</a></p>` : '';
    const onVisit = await db.get("SELECT a.start_time FROM procedures pr JOIN appointments a ON a.id = pr.appointment_id WHERE pr.treatment_plan_id = ? AND pr.status = 'planned' AND a.status IN ('scheduled','confirmed') ORDER BY a.start_time LIMIT 1", plan.id);
    if (onVisit) return res.type('html').send(page(practice, 'You’re all set', `<p>Your treatment is booked for ${esc(onVisit.start_time.slice(0, 10))}. See you then! Questions?</p>${callLine(practice)}`));
    if (plan.status === 'completed' || plan.status === 'rejected') return res.type('html').send(page(practice, 'Thanks for checking', `<p>There’s nothing waiting on this plan. If anything has changed, give us a call.</p>${callLine(practice)}`));
    // Accepted (or signed) already: what's left is choosing a time.
    if (plan.signed_at || (plan.sign_token_failures || 0) >= MAX_DOB_TRIES) {
      return res.type('html').send(page(practice, 'Let’s find you a time', `<p>Your treatment plan is ready. Call us and we’ll find a time that suits you${booking ? ', or choose one online' : ''}.</p>${callLine(practice)}${bookLine}`));
    }
    // The plan page: a fresh link each time (the old one stops). Wrong birth dates are not forgiven by a new link.
    const { token, hash } = newToken();
    await db.run("UPDATE treatment_plans SET sign_token_hash = ?, sign_token_expires_at = ?, presented_at = COALESCE(presented_at, datetime('now')) WHERE id = ?",
      hash, new Date(Date.now() + SIGN_LINK_DAYS * 86400_000).toISOString(), plan.id);
    res.redirect(302, `${config.appUrl || ''}/tp/${token}`);
  });

  // The picture on a mailed letter (the mail service fetches it while printing).
  r.get('/txf/:token/image', limit, async (req, res) => {
    const letter = String(req.params.token).startsWith('l.') ? await letterForToken(db, String(req.params.token).slice(2)) : null;
    if (!letter || !letter.document_id || !storage) throw new HttpError(404, 'Not found');
    const m = await letterModel(db, letter, { storage });
    if (!m.image) throw new HttpError(404, 'Not found');
    await audit(db, { user: { practice_id: letter.practice_id, id: null }, ip: req.ip }, 'txf_letter.image_fetch', 'txf_letters', letter.id, { patient_id: letter.patient_id });
    res.set({ 'Content-Type': m.image.mime, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(m.image.data);
  });
  return r;
}

