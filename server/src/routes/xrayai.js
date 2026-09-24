import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, findOr404, audit, recorded, practiceNow, isRealDate } from '../util.js';
import { currentActor, setActor } from '../actor.js';
import {
  analyzeDocument, LABELS, TO_CONDITION, DISCLAIMER, engineStatus, findingView, reviewFor, compareWithChart, runSecondLook, acceptedForPatient, acceptedForPlan,
} from '../xrayai.js';
import { canSeePatient } from '../officeaccess.js';

// X-ray AI (backlog XR1–XR3, docs/workflows/specs/XR-xray-ai.md): reading an x-ray with the FDA-cleared vendor,
// the review list comparing what the AI saw with the chart (per patient and per day), the dentist's accept /
// dismiss, the pre-appointment second look, and the accepted-only view for the chair screen and treatment
// presentation. Nothing here charts on its own: a finding reaches the chart only when a person accepts it.

// The dentist's call on a finding is a diagnosis: the assistant may propose it, but only a person's on-screen yes
// makes it (CLAUDE.md rule 10). aiguard.js does this for the routes in HIGH_RISK; this route checks it itself so
// it holds whether or not the route is listed there.
function requireHumanDecision(req) {
  if (currentActor()?.source !== 'ai') return;
  if (req.get('X-Human-Approved') !== '1') {
    throw new HttpError(428, 'The assistant can’t chart or dismiss an x-ray finding without your OK. Confirm it, or do it yourself.', { needs_approval: true });
  }
  setActor({ actor: `Assistant (for ${req.user.name}, approved by ${req.user.name})`, approvedBy: req.user.id });
}
const STATUS = { accepted: 'accepted', accept: 'accepted', rejected: 'rejected', dismissed: 'rejected', dismiss: 'rejected', suggested: 'suggested', reopen: 'suggested' };

export default function xrayAiRoutes({ db, xrayAi }) {
  const r = Router();
  const docFor = async (req) => {
    const doc = await findOr404(db, 'documents', req.params.did, req.user.practice_id, 'Document');
    if (doc.deleted_at || !(await canSeePatient(db, req.user, doc.patient_id))) throw new HttpError(404, 'Document not found');
    return doc;
  };
  const patientFor = async (req, id = req.params.id) => {
    const p = await findOr404(db, 'patients', id, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, p.id))) throw new HttpError(404, 'Patient not found');
    return p;
  };
  const findingsOf = async (docId) => (await db.all('SELECT * FROM xray_findings WHERE document_id = ? ORDER BY id', docId)).map(findingView);

  r.get('/xray-ai', requirePermission('clinical:read'), (_req, res) => res.json(engineStatus(xrayAi)));

  r.post('/documents/:did/ai-read', requirePermission('clinical:write'), async (req, res) => {
    const doc = await docFor(req);
    const out = await analyzeDocument(db, doc, { readFor: 'manual', req });
    res.json({ image_type: out.image_type || null, quality: out.quality || null, disclaimer: DISCLAIMER, engine: engineStatus(xrayAi).label, findings: await findingsOf(doc.id) });
  });

  r.get('/documents/:did/ai-findings', requirePermission('clinical:read'), async (req, res) => {
    const doc = await docFor(req);
    res.json({ read_at: doc.ai_read_at, image_type: doc.ai_image_type, quality: doc.ai_quality, engine: doc.ai_engine || null, disclaimer: DISCLAIMER, findings: await findingsOf(doc.id) });
  });

  // A patient's findings by status (suggested unless asked): the chart shows the count.
  r.get('/patients/:id/ai-findings', requirePermission('clinical:read'), async (req, res) => {
    const p = await patientFor(req);
    const status = STATUS[req.query.status] || 'suggested';
    res.json((await db.all('SELECT * FROM xray_findings WHERE patient_id = ? AND practice_id = ? AND status = ? ORDER BY document_id DESC, id', p.id, req.user.practice_id, status)).map(findingView));
  });

  // XR2 per patient: "AI saw possible caries on #19 D; not charted", with what's already on the chart set apart.
  r.get('/patients/:id/xray-review', requirePermission('clinical:read'), async (req, res) => {
    const p = await patientFor(req);
    const items = await reviewFor(db, req.user.practice_id, [p.id]);
    const unread = await db.get(
      "SELECT COUNT(*) AS n FROM documents WHERE practice_id = ? AND patient_id = ? AND category = 'xray' AND deleted_at IS NULL AND ai_read_at IS NULL AND mime LIKE 'image/%'", req.user.practice_id, p.id,
    );
    res.json({ disclaimer: DISCLAIMER, engine: engineStatus(xrayAi), items, unread: Number(unread.n), counts: countsOf(items) });
  });

  // XR2 per day: the patients on the schedule that day (default today) with findings waiting, and x-rays of theirs
  // the AI hasn't read yet.
  r.get('/xray-review', requirePermission('clinical:read'), async (req, res) => {
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const date = req.query.date ?? today;
    if (!isRealDate(date)) throw new HttpError(400, 'date must be a real date (YYYY-MM-DD)');
    const appts = await db.all(
      `SELECT a.patient_id, MIN(a.start_time) AS start_time, p.first_name, p.last_name FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time <= ? AND a.status NOT IN ('cancelled','no_show') GROUP BY a.patient_id, p.first_name, p.last_name ORDER BY MIN(a.start_time)`,
      req.user.practice_id, `${date} 00:00`, `${date} 23:59`,
    );
    const visible = [];
    for (const a of appts) if (await canSeePatient(db, req.user, a.patient_id)) visible.push(a);
    const items = await reviewFor(db, req.user.practice_id, visible.map((a) => a.patient_id));
    const unread = visible.length ? await db.all(
      `SELECT patient_id, COUNT(*) AS n FROM documents WHERE practice_id = ? AND category = 'xray' AND deleted_at IS NULL AND ai_read_at IS NULL AND mime LIKE 'image/%'
       AND patient_id IN (${visible.map(() => '?').join(', ')}) GROUP BY patient_id`, req.user.practice_id, ...visible.map((a) => a.patient_id),
    ) : [];
    const patients = visible.map((a) => {
      const mine = items.filter((i) => i.patient_id === a.patient_id);
      return { patient_id: a.patient_id, name: `${a.first_name} ${a.last_name}`, start_time: a.start_time, items: mine, counts: countsOf(mine), unread: Number(unread.find((u) => u.patient_id === a.patient_id)?.n || 0) };
    }).filter((p) => p.items.length || p.unread);
    res.json({ date, disclaimer: DISCLAIMER, engine: engineStatus(xrayAi), patients, counts: countsOf(items) });
  });

  // The second look, now (the job runs it on its own each hour): today's patients' unread x-rays.
  r.post('/xray-review/second-look', requirePermission('clinical:write'), async (req, res) => {
    if (!xrayAi?.enabled) throw new HttpError(503, 'AI x-ray reading is not set up on this server');
    const out = await runSecondLook(db, { practiceId: req.user.practice_id });
    await audit(db, req, 'xray_ai.second_look', 'practices', req.user.practice_id, out);
    res.json(out);
  });

  // The dentist's call. accepted → on the chart (a condition with the finding linked as its reason; if the chart
  // already has it, the finding is linked to that instead of charting it twice). rejected (dismissed) → kept with
  // who and why. suggested → undo: an accept's own condition is voided (not deleted) with the reason.
  r.patch('/ai-findings/:fid', requirePermission('clinical:sign'), async (req, res) => {
    const f = await findOr404(db, 'xray_findings', req.params.fid, req.user.practice_id, 'Finding');
    if (!(await canSeePatient(db, req.user, f.patient_id))) throw new HttpError(404, 'Finding not found');
    const status = STATUS[req.body?.status];
    if (!status) throw new HttpError(400, 'status must be accepted, dismissed (rejected) or suggested');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) || null : null;
    requireHumanDecision(req);
    const approvedBy = currentActor()?.approvedBy ?? null;
    if (status === f.status) return res.json(findingView(f)); // a repeat (double click, retry): nothing to do
    let conditionId = null;
    let linked = null;
    let voided = null;
    let created = false;
    const done = await db.tx(async () => {
      // Only from the state we read: a second request racing this one finds nothing to change.
      const n = await recorded(db, 'xray_findings', f.id, () => db.run(
        `UPDATE xray_findings SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_reason = ?, review_source = ?, approved_by = ?${status === 'suggested' ? ', condition_id = NULL' : ''}
         WHERE id = ? AND status = ?`, status, req.user.id, reason, currentActor()?.source || 'human', approvedBy, f.id, f.status,
      ));
      if (!n.changes) return false;
      if (status === 'accepted' && f.tooth && req.body?.chart !== false) {
        const chart = {
          conditions: await db.all('SELECT * FROM tooth_conditions WHERE practice_id = ? AND patient_id = ? AND voided_at IS NULL', f.practice_id, f.patient_id),
          procedures: await db.all("SELECT id, code, tooth, surfaces, status, completed_at FROM procedures WHERE practice_id = ? AND patient_id = ? AND status != 'cancelled'", f.practice_id, f.patient_id),
        };
        const doc = await db.get('SELECT COALESCE(taken_at, created_at) AS d FROM documents WHERE id = ?', f.document_id);
        const cmp = compareWithChart(f, chart, String(doc?.d || '').slice(0, 10));
        if (cmp.status === 'charted' && cmp.matched.type === 'condition') {
          linked = cmp.matched;
          conditionId = cmp.matched.id;
        } else {
          if (cmp.status === 'charted') linked = cmp.matched;
          created = true;
          conditionId = await insert(db, 'tooth_conditions', {
            practice_id: f.practice_id, patient_id: f.patient_id, tooth: f.tooth, surfaces: f.surfaces, condition: TO_CONDITION[f.kind] || 'watch', recorded_by: req.user.id, xray_finding_id: f.id,
            notes: `${LABELS[f.kind]} seen on x-ray — AI finding (${f.engine}) confirmed by ${req.user.name}${f.measurement_mm ? ` · ${f.measurement_mm} mm` : ''}${f.note ? ` — ${f.note}` : ''}`.slice(0, 500),
          });
        }
        await db.run('UPDATE xray_findings SET condition_id = ? WHERE id = ?', conditionId, f.id);
      }
      if (status === 'suggested' && f.status === 'accepted' && f.condition_id) {
        // Undo of an accept: only the condition this finding put on the chart comes off (voided, kept).
        const own = await db.get('SELECT id FROM tooth_conditions WHERE id = ? AND xray_finding_id = ? AND voided_at IS NULL', f.condition_id, f.id);
        if (own) {
          voided = own.id;
          await recorded(db, 'tooth_conditions', own.id, () => db.run(
            "UPDATE tooth_conditions SET voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ?", req.user.id, 'AI x-ray finding reopened (undo of accept)', own.id,
          ));
        }
      }
      return true;
    });
    if (!done) return res.json(findingView(await db.get('SELECT * FROM xray_findings WHERE id = ?', f.id)));
    const verb = { accepted: 'accepted', rejected: 'dismissed', suggested: 'reopened' }[status];
    await audit(db, req, `xray_ai.${verb}`, 'xray_findings', f.id, {
      kind: f.kind, tooth: f.tooth, surfaces: f.surfaces, confidence: f.confidence, engine: f.engine, ai_reason: f.note, from: f.status,
      condition_id: conditionId, linked_to_existing: linked, voided_condition_id: voided, approved_by: approvedBy,
    }, { patientId: f.patient_id, reason: reason || (status === 'accepted' ? `Dentist confirmed the AI x-ray finding (${LABELS[f.kind]}${f.tooth ? ` #${f.tooth}` : ''})` : null) });
    if (created) {
      await audit(db, req, 'condition.create', 'tooth_conditions', conditionId, { from_xray_finding: f.id }, { patientId: f.patient_id, reason: `AI x-ray finding #${f.id} confirmed by ${req.user.name}` });
    }
    res.json(findingView(await db.get('SELECT * FROM xray_findings WHERE id = ?', f.id)));
  });

  // XR3: the chair screen — the patient's x-rays with only the dentist-accepted findings. Showing them is recorded.
  r.get('/patients/:id/xray-chair', requirePermission('clinical:read'), async (req, res) => {
    const p = await patientFor(req);
    const findings = await acceptedForPatient(db, req.user.practice_id, p.id);
    const images = [];
    for (const f of findings) {
      let img = images.find((i) => i.document_id === f.document_id);
      if (!img) images.push((img = { document_id: f.document_id, image_date: f.image_date, image_type: f.image_type, findings: [] }));
      img.findings.push(f);
    }
    await audit(db, req, 'xray_ai.chair_view', 'patients', p.id, { images: images.length, findings: findings.length });
    res.json({ first_name: p.first_name, images, note: 'Your dentist reviewed these x-rays and confirmed what’s marked.' });
  });

  // XR3 for the plan screens: accepted findings on the teeth in the plan.
  r.get('/treatment-plans/:tid/xray-findings', requirePermission('clinical:read'), async (req, res) => {
    const plan = await findOr404(db, 'treatment_plans', req.params.tid, req.user.practice_id, 'Treatment plan');
    if (!(await canSeePatient(db, req.user, plan.patient_id))) throw new HttpError(404, 'Treatment plan not found');
    const procedures = await db.all("SELECT tooth FROM procedures WHERE treatment_plan_id = ? AND status != 'cancelled'", plan.id);
    res.json(await acceptedForPlan(db, plan, procedures));
  });

  // How often the dentists agree with the AI, by kind of finding.
  r.get('/xray-ai/stats', requirePermission('clinical:read'), async (req, res) => {
    res.json(await db.all(
      `SELECT kind, SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted, SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
         SUM(CASE WHEN status = 'suggested' THEN 1 ELSE 0 END) AS waiting FROM xray_findings WHERE practice_id = ? GROUP BY kind ORDER BY kind`, req.user.practice_id,
    ));
  });

  // Reconciliation (rule 14): x-rays sent to the vendor vs read vs failed, the last 30 days.
  r.get('/xray-ai/reads', requirePermission('clinical:read'), async (req, res) => {
    const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const row = await db.get(
      `SELECT COUNT(*) AS sent, SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS read_ok, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed, COUNT(DISTINCT document_id) AS images
       FROM xray_ai_reads WHERE practice_id = ? AND created_at >= ?`, req.user.practice_id, since,
    );
    res.json({ since: since.slice(0, 10), sent: Number(row.sent || 0), read: Number(row.read_ok || 0), failed: Number(row.failed || 0), images: Number(row.images || 0) });
  });
  return r;
}

const countsOf = (items) => ({
  not_charted: items.filter((i) => i.chart.status === 'not_charted').length,
  charted: items.filter((i) => i.chart.status === 'charted').length,
  no_tooth: items.filter((i) => i.chart.status === 'no_tooth').length,
});
