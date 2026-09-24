import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, findOr404, audit } from '../util.js';
import { analyzeDocument, LABELS } from '../xrayai.js';
import { canSeePatient } from '../officeaccess.js';

// Accepting a finding can put it on the tooth chart; these are the chart conditions each kind becomes.
const TO_CONDITION = { caries: 'caries', periapical: 'abscess', impacted: 'impacted', restoration: 'filling', crown: 'crown', root_canal: 'root_canal', implant: 'implant' };
const view = (f) => ({ ...f, box: f.box ? JSON.parse(f.box) : null, label: LABELS[f.kind] || f.kind });

export default function xrayAiRoutes({ db, xrayAi }) {
  const r = Router();
  const docFor = async (req) => {
    const doc = await findOr404(db, 'documents', req.params.did, req.user.practice_id, 'Document');
    if (doc.deleted_at || !(await canSeePatient(db, req.user, doc.patient_id))) throw new HttpError(404, 'Document not found');
    return doc;
  };

  r.get('/xray-ai', requirePermission('clinical:read'), (_req, res) => res.json({ enabled: !!xrayAi.enabled, mode: xrayAi.mode, label: xrayAi.label || null, cleared: !!xrayAi.cleared }));

  r.post('/documents/:did/ai-read', requirePermission('clinical:write'), async (req, res) => {
    const doc = await docFor(req);
    const out = await analyzeDocument(db, doc);
    await audit(db, req, 'xray_ai.read', 'documents', doc.id, { findings: out.findings.length, engine: xrayAi.mode });
    res.json({ image_type: out.image_type, quality: out.quality, findings: (await db.all('SELECT * FROM xray_findings WHERE document_id = ? ORDER BY id', doc.id)).map(view) });
  });

  r.get('/documents/:did/ai-findings', requirePermission('clinical:read'), async (req, res) => {
    const doc = await docFor(req);
    res.json({ read_at: doc.ai_read_at, image_type: doc.ai_image_type, quality: doc.ai_quality, findings: (await db.all('SELECT * FROM xray_findings WHERE document_id = ? ORDER BY id', doc.id)).map(view) });
  });

  // Findings waiting for the dentist on a patient's x-rays (the chart shows the count).
  r.get('/patients/:id/ai-findings', requirePermission('clinical:read'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, p.id))) throw new HttpError(404, 'Patient not found');
    const status = ['suggested', 'accepted', 'rejected'].includes(req.query.status) ? req.query.status : 'suggested';
    res.json((await db.all('SELECT * FROM xray_findings WHERE patient_id = ? AND practice_id = ? AND status = ? ORDER BY document_id DESC, id', p.id, req.user.practice_id, status)).map(view));
  });

  // The dentist's call. Accepting with chart: true puts it on the tooth (and plan: true adds the treatment code given).
  r.patch('/ai-findings/:fid', requirePermission('clinical:write'), async (req, res) => {
    const f = await findOr404(db, 'xray_findings', req.params.fid, req.user.practice_id, 'Finding');
    const status = req.body?.status;
    if (!['accepted', 'rejected', 'suggested'].includes(status)) throw new HttpError(400, 'status must be accepted, rejected or suggested');
    let conditionId = null;
    if (status === 'accepted' && req.body?.chart && f.tooth && !f.condition_id) {
      const condition = TO_CONDITION[f.kind] || 'watch';
      conditionId = await insert(db, 'tooth_conditions', {
        practice_id: f.practice_id, patient_id: f.patient_id, tooth: f.tooth, surfaces: f.surfaces, condition, recorded_by: req.user.id,
        notes: `${LABELS[f.kind]} seen on x-ray (AI finding, confirmed)${f.measurement_mm ? ` · ${f.measurement_mm} mm` : ''}${f.note ? ` — ${f.note}` : ''}`.slice(0, 500),
      });
    }
    await db.run("UPDATE xray_findings SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), condition_id = COALESCE(?, condition_id) WHERE id = ?", status, req.user.id, conditionId, f.id);
    await audit(db, req, `xray_ai.${status}`, 'xray_findings', f.id, { kind: f.kind, tooth: f.tooth });
    res.json(view(await db.get('SELECT * FROM xray_findings WHERE id = ?', f.id)));
  });

  // How often the dentists agree with the AI, by kind of finding.
  r.get('/xray-ai/stats', requirePermission('clinical:read'), async (req, res) => {
    res.json(await db.all(
      `SELECT kind, SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted, SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
         SUM(CASE WHEN status = 'suggested' THEN 1 ELSE 0 END) AS waiting FROM xray_findings WHERE practice_id = ? GROUP BY kind ORDER BY kind`, req.user.practice_id,
    ));
  });
  return r;
}
