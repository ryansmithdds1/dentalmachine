import express, { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { findOr404, audit, isRealDate, localNow } from '../util.js';
import { requireHuman } from '../aiguard.js';
import { canSeePatient, restricted } from '../officeaccess.js';
import { createEligibility } from '../eligibility.js';
import { storeUpload } from '../docfiles.js';
import { createVirusScanner } from '../virusscan.js';
import { classify } from '../filetypes.js';
import {
  upcoming, verificationSettings, validateSettings, runNow, requestInsurance, verifyByPhone, readBenefitDocument, readView, confirmRead,
  verificationMetrics, policyDetail, reviewList, patientStatus, addDays, EXCEPTION_LABELS,
} from '../verification.js';
import { decideReview } from '../planverify.js';

// Insurance verification center (IV1–IV4): docs/workflows/specs/IV-verification.md.
// Reading needs billing:read; changing benefits needs billing:write; texting a patient, patients:write or
// billing:write; the settings, an administrator. Plan-wide changes (a phone verification with benefits, a
// confirmed AI read, applying a reviewed change) are refused to the AI without a person's OK (aiguard.js).
const MAX_DOC = 10 * 1024 * 1024;
const RANGES = { today: [0, 0], tomorrow: [1, 1], week: [0, 6], '7': [0, 6], '14': [0, 13], two_weeks: [0, 13] };

export default function verificationRoutes({ db, config, clearinghouse, storage, messenger }) {
  const r = Router();
  const eligibility = createEligibility({ db, config, clearinghouse });
  const scanner = config.virusScanner || createVirusScanner();
  const anyOf = (...perms) => (req, _res, next) => (perms.some((p) => can(req.user, p)) ? next() : next(new HttpError(403, `Missing permission: ${perms.join(' or ')}`)));
  const admin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));

  const practiceOf = (req) => db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
  const today = async (req) => localNow((await practiceOf(req)).timezone || 'America/New_York').slice(0, 10);
  // The dates asked for: a named range from today, or from/to.
  async function range(req) {
    const t = await today(req);
    const q = req.query;
    if (q.from || q.to) {
      if (!isRealDate(q.from) || !isRealDate(q.to || q.from)) throw new HttpError(400, 'from and to must be real dates (YYYY-MM-DD)');
      const to = q.to || q.from;
      if (to < q.from) throw new HttpError(400, 'to must be on or after from');
      if ((Date.parse(to) - Date.parse(q.from)) / 86400_000 > 62) throw new HttpError(400, 'At most two months at a time');
      return { from: q.from, to, today: t };
    }
    const [a, b] = RANGES[q.range || 'week'] || RANGES.week;
    return { from: addDays(t, a), to: addDays(t, b), today: t, range: q.range || 'week' };
  }
  // An office the person may see, or none.
  async function office(req, value) {
    if (value == null || value === '') return null;
    const loc = await findOr404(db, 'locations', value, req.user.practice_id, 'Office');
    if (restricted(req.user) && !req.user.location_ids.includes(loc.id)) throw new HttpError(404, 'Office not found');
    return loc.id;
  }
  async function policyFor(req, id) {
    const policy = await findOr404(db, 'patient_insurance', id, req.user.practice_id, 'Policy');
    if (!(await canSeePatient(db, req.user, policy.patient_id))) throw new HttpError(404, 'Policy not found');
    return policy;
  }

  // ---- IV1: the list ----
  r.get('/verification/settings', requirePermission('billing:read'), async (req, res) => {
    res.json({ ...verificationSettings(await practiceOf(req)), automatic: eligibility.automatic });
  });
  r.put('/verification/settings', admin, async (req, res) => {
    const practice = await practiceOf(req);
    const before = verificationSettings(practice);
    const next = validateSettings(req.body || {}, before);
    await db.run('UPDATE practices SET verification_settings = ? WHERE id = ?', JSON.stringify(next), practice.id);
    await audit(db, req, 'verification.settings', 'practices', practice.id, null, { before, after: next });
    res.json({ ...next, automatic: eligibility.automatic });
  });

  r.get('/verification/upcoming', requirePermission('billing:read'), async (req, res) => {
    const { from, to, today: t } = await range(req);
    const locationId = await office(req, req.query.location_id);
    const { rows, settings } = await upcoming(db, req.user.practice_id, { from, to, locationId, user: req.user });
    const offices = await db.all('SELECT id, name FROM locations WHERE practice_id = ? AND active = 1 ORDER BY sort, id', req.user.practice_id);
    const insured = rows.filter((x) => x.policy);
    const count = (f) => insured.filter(f).length;
    res.json({
      from, to, today: t, automatic: eligibility.automatic, settings, rows,
      offices: restricted(req.user) ? offices.filter((o) => req.user.location_ids.includes(o.id)) : offices,
      summary: {
        visits: rows.length, insured: insured.length, eligibility_verified: count((x) => x.eligibility.state === 'verified'), breakdown_verified: count((x) => x.breakdown.state === 'verified'),
        exceptions: rows.filter((x) => x.exceptions.length && !x.waiting).length, waiting: rows.filter((x) => x.waiting).length,
      },
      exception_labels: EXCEPTION_LABELS,
    });
  });

  // Check everyone in the range now (each policy once; anyone checked in the last day is skipped).
  r.post('/verification/run', requirePermission('billing:read'), async (req, res) => {
    Object.assign(req.query, req.body || {});
    const { from, to } = await range(req);
    const locationId = await office(req, req.body?.location_id);
    const out = await runNow(db, eligibility, req.user, { from, to, locationId });
    await audit(db, req, 'verification.run', 'practices', req.user.practice_id, { from, to, location_id: locationId, checked: out.checked, applied: out.applied, needs_look: out.needs_look, failed: out.failed.length });
    res.json({ from, to, ...out });
  });

  r.get('/verification/metrics', requirePermission('billing:read'), async (req, res) => {
    const q = req.query;
    if ((q.from && !isRealDate(q.from)) || (q.to && !isRealDate(q.to))) throw new HttpError(400, 'from and to must be real dates (YYYY-MM-DD)');
    res.json(await verificationMetrics(db, req.user.practice_id, { from: q.from || null, to: q.to || null, locationId: await office(req, q.location_id) }));
  });

  // The badge on the chart and the patient bar (anyone who can see the patient, like the schedule's badge).
  r.get('/patients/:id/verification', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const s = await patientStatus(db, req.user.practice_id, patient.id);
    const brief = (x) => ({ state: x.state, label: x.label, at: x.at ?? null, how: x.how ?? null, by: x.by ?? null, via_group: x.via_group ?? false });
    res.json({
      patient_id: patient.id, next_visit: s.next_visit, carrier_name: s.policy?.carrier_name ?? null, policy_id: s.policy?.id ?? null,
      eligibility: brief(s.eligibility), breakdown: brief(s.breakdown), exceptions: s.exceptions.map((x) => ({ kind: x.kind, label: x.label })), waiting: s.waiting,
    });
  });

  // ---- One policy: everything for the side panel ----
  r.get('/verification/policies/:id', requirePermission('billing:read'), async (req, res) => {
    const policy = await policyFor(req, req.params.id);
    res.json(await policyDetail(db, policy, { user: req.user }));
  });
  r.post('/verification/policies/:id/check', requirePermission('billing:read'), async (req, res) => {
    const policy = await policyFor(req, req.params.id);
    const out = await eligibility.check(policy, { userId: req.user.id });
    await audit(db, req, 'eligibility.check', 'eligibility_checks', out.id, { mode: out.mode, patient_id: policy.patient_id, applied: !!out.applied, from: 'verification center' });
    res.status(201).json(out);
  });

  // ---- IV4: one-key actions ----
  r.post('/verification/policies/:id/phone', requirePermission('billing:write'), async (req, res) => {
    const policy = await policyFor(req, req.params.id);
    res.status(201).json(await verifyByPhone(db, { policy, user: req.user, body: req.body || {} }));
  });
  r.post('/patients/:id/request-insurance', anyOf('patients:write', 'billing:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const out = await requestInsurance(db, messenger, { practiceId: req.user.practice_id, patientId: patient.id, appUrl: config.appUrl, userId: req.user.id });
    res.status(out.already ? 200 : 201).json(out);
  });

  // ---- IV2: a portal page or fax → AI read → a person confirms field by field ----
  // The file is the raw request body (like chart uploads), filed in the chart; or document_id for one already there.
  r.post('/verification/policies/:id/read-document', requirePermission('billing:write'), express.raw({ type: () => true, limit: MAX_DOC }), async (req, res) => {
    const policy = await policyFor(req, req.params.id);
    let data;
    let mime;
    let documentId = null;
    if (req.query.document_id) {
      const doc = await findOr404(db, 'documents', req.query.document_id, req.user.practice_id, 'Document');
      if (doc.patient_id !== policy.patient_id || doc.deleted_at) throw new HttpError(404, 'Document not found');
      data = await storage.read(doc.storage_key, !!doc.encrypted);
      mime = doc.mime;
      documentId = doc.id;
    } else {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Attach the benefit summary (PDF or a photo of the page)');
      const filename = String(req.query.filename || 'benefit-breakdown').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
      mime = classify(req.body, filename, String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()).mime;
      if (!AI_MIME.test(mime)) throw new HttpError(415, 'A PDF, a photo (PNG or JPEG) or a text file of the benefit page');
      const saved = await storeUpload(db, storage, {
        req, practiceId: req.user.practice_id, patientId: policy.patient_id, scope: 'patient', body: req.body, filename, declared: mime, category: 'document',
        notes: 'Insurance benefit breakdown (payer portal or fax)', uploadedBy: req.user.id, scanner, extra: { folder: 'Insurance' },
      });
      data = req.body;
      documentId = saved.id;
    }
    const content = mime === 'application/pdf' ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } }]
      : /^image\//.test(mime) ? [{ type: 'image', source: { type: 'base64', media_type: mime, data: data.toString('base64') } }]
        : [{ type: 'text', text: data.toString('utf8').slice(0, 60_000) }];
    const sandbox = config.ediMode === 'sandbox' || config.benefitReader === 'sandbox' || process.env.BENEFIT_READER === 'sandbox';
    res.status(201).json(await readBenefitDocument(db, config, { policy, user: req.user, content, documentId, sandbox }));
  });
  const readFor = async (req) => {
    const read = await findOr404(db, 'benefit_reads', req.params.rid, req.user.practice_id, 'Benefit read');
    const policy = await policyFor(req, read.patient_insurance_id);
    return { read, policy };
  };
  r.get('/verification/reads/:rid', requirePermission('billing:read'), async (req, res) => {
    const { read } = await readFor(req);
    res.json(await readView(db, read.id));
  });
  r.post('/verification/reads/:rid/confirm', requirePermission('billing:write'), async (req, res) => {
    const { read, policy } = await readFor(req);
    res.json(await confirmRead(db, { read, policy, user: req.user, body: req.body || {} }));
  });
  r.post('/verification/reads/:rid/discard', requirePermission('billing:write'), async (req, res) => {
    const { read } = await readFor(req);
    const took = await db.run("UPDATE benefit_reads SET status = 'discarded', confirmed_by = ?, confirmed_at = datetime('now') WHERE id = ? AND status = 'draft'", req.user.id, read.id);
    if (!took.changes) throw new HttpError(409, 'That read was already applied or set aside');
    await audit(db, req, 'benefits.ai_read_discarded', 'benefit_reads', read.id, { patient_id: read.patient_id });
    res.json({ ok: true });
  });

  // ---- IV3: plan changes waiting for a person ----
  r.get('/verification/reviews', requirePermission('billing:read'), async (req, res) => {
    res.json(await reviewList(db, req.user.practice_id));
  });
  const reviewFor = async (req) => {
    const v = await findOr404(db, 'benefit_verifications', req.params.vid, req.user.practice_id, 'Review');
    await policyFor(req, v.patient_insurance_id);
    return v;
  };
  r.post('/verification/reviews/:vid/apply', requirePermission('billing:write'), async (req, res) => {
    requireHuman('changing a plan’s benefits for everyone on it');
    const v = await reviewFor(req);
    const planIds = Array.isArray(req.body?.plan_ids) ? req.body.plan_ids.map(Number) : [];
    for (const id of planIds) {
      const plan = await findOr404(db, 'insurance_plans', id, req.user.practice_id, 'Plan');
      const own = await db.get('SELECT carrier_id FROM insurance_plans WHERE id = ?', v.plan_id);
      if (plan.carrier_id !== own.carrier_id) throw new HttpError(400, 'Only plans with the same insurance company can be updated together');
    }
    res.json(await decideReview(db, v.id, { apply: true, planIds, userId: req.user.id, userName: req.user.name, note: req.body?.note }));
  });
  r.post('/verification/reviews/:vid/keep', requirePermission('billing:write'), async (req, res) => {
    const v = await reviewFor(req);
    res.json(await decideReview(db, v.id, { apply: false, userId: req.user.id, userName: req.user.name, note: req.body?.note }));
  });

  return r;
}
const AI_MIME = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/;
