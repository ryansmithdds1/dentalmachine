import { HttpError } from './auth.js';
import { insert } from './util.js';
import { structured, aiClient } from './ai.js';
import { log } from './monitoring.js';

// AI findings on x-rays: caries, calculus, bone loss, periapical lesions and existing work, each with where it
// is on the image, for the dentist to accept (onto the chart) or reject. Which engine reads the images:
//  - XRAY_AI=vendor with XRAY_AI_URL (+ XRAY_AI_KEY): an FDA-cleared service (Pearl, Overjet, Videa) through
//    an adapter that returns findings in the shape below. Their APIs come with a partner agreement.
//  - XRAY_AI=claude: Claude looks at the image as a second pair of eyes. Not FDA-cleared, and labelled so.
//  - XRAY_AI=sandbox: made-up but plausible findings for demos.
export const KINDS = ['caries', 'calculus', 'bone_loss', 'periapical', 'restoration', 'crown', 'root_canal', 'implant', 'impacted', 'open_margin', 'other'];
export const LABELS = {
  caries: 'Caries', calculus: 'Calculus', bone_loss: 'Bone loss', periapical: 'Periapical radiolucency', restoration: 'Restoration', crown: 'Crown',
  root_canal: 'Root canal', implant: 'Implant', impacted: 'Impacted tooth', open_margin: 'Open margin', other: 'Other',
};

const FINDINGS_TOOL = {
  name: 'report_findings',
  description: 'What is visible on this dental radiograph.',
  input_schema: {
    type: 'object',
    properties: {
      image_type: { type: 'string', enum: ['bitewing', 'periapical', 'panoramic', 'cephalometric', 'occlusal', 'photo', 'not_a_radiograph', 'other'] },
      quality: { type: 'string', description: 'Anything limiting the read (cone cut, overlap, burnout, blur).' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: KINDS },
            tooth: { type: 'string', description: 'Universal number if it can be told from the image; empty if unsure.' },
            surfaces: { type: 'string' },
            confidence: { type: 'number', description: '0-1' },
            box: { type: 'array', items: { type: 'number' }, description: '[x, y, width, height] as fractions of the image (0-1), top-left origin.' },
            measurement_mm: { type: 'number', description: 'For bone loss: estimated mm from the CEJ, if scale allows.' },
            note: { type: 'string' },
          },
          required: ['kind', 'confidence', 'box'],
        },
      },
    },
    required: ['image_type', 'findings'],
  },
};

const CLAUDE_SYSTEM = `You are reviewing a dental radiograph as a second reader for a dentist. Report what is visible: suspected caries (with surfaces), calculus, horizontal or vertical bone loss, periapical radiolucencies, and existing restorations, crowns, root canals and implants.
- Mark each finding with a box around it as fractions of the image width and height.
- Only number teeth when the image type and anatomy make the number clear; otherwise leave tooth empty.
- Use confidence honestly; skip anything you can't see well. This is decision support for the dentist, who makes the diagnosis.`;

const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
export function normalize(f) {
  const box = Array.isArray(f.box) && f.box.length === 4 ? f.box.map(clamp) : null;
  return {
    kind: KINDS.includes(f.kind) ? f.kind : 'other', tooth: f.tooth ? String(f.tooth).toUpperCase().slice(0, 3) : null,
    surfaces: f.surfaces ? String(f.surfaces).toUpperCase().replace(/[^MODBFLI]/g, '').slice(0, 5) || null : null,
    confidence: Math.round(clamp(f.confidence) * 100) / 100, box: box && box[2] > 0 && box[3] > 0 ? box : null,
    measurement_mm: f.measurement_mm == null ? null : Math.round(Number(f.measurement_mm) * 10) / 10, note: f.note ? String(f.note).slice(0, 300) : null,
  };
}

export function createXrayAi({ config, fetchImpl = globalThis.fetch }) {
  const mode = config.xrayAi || (config.xrayAiUrl ? 'vendor' : null);
  if (mode === 'vendor' && config.xrayAiUrl) {
    return {
      mode, enabled: true, label: config.xrayAiName || 'AI', cleared: true,
      async analyze({ data, mime }) {
        const res = await fetchImpl(config.xrayAiUrl, {
          method: 'POST', headers: { 'Content-Type': mime, ...(config.xrayAiKey ? { Authorization: `Bearer ${config.xrayAiKey}` } : {}) }, body: data,
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new HttpError(502, `${config.xrayAiName || 'AI'}: ${out.error || res.status}`);
        return { image_type: out.image_type || null, quality: out.quality || null, findings: (out.findings || []).map(normalize) };
      },
    };
  }
  if (mode === 'claude') {
    return {
      mode, enabled: !!aiClient(config), label: 'Claude (second look, not FDA-cleared)', cleared: false,
      async analyze({ data, mime }) {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) throw new HttpError(400, 'This image type can’t be read by the AI (PNG or JPEG only)');
        if (data.length > 4_500_000) throw new HttpError(400, 'The image is too large for the AI to read');
        const out = await structured(config, {
          system: CLAUDE_SYSTEM, tool: FINDINGS_TOOL, effort: 'medium',
          content: [{ type: 'image', source: { type: 'base64', media_type: mime, data: Buffer.from(data).toString('base64') } }, { type: 'text', text: 'Report the findings on this radiograph.' }],
        });
        return { image_type: out.image_type || null, quality: out.quality || null, findings: (out.findings || []).map(normalize) };
      },
    };
  }
  if (mode === 'sandbox') {
    return {
      mode, enabled: true, label: 'AI (sandbox)', cleared: false,
      // Findings that look the part, the same every time for the same image.
      async analyze({ docId, tooth }) {
        const seed = (n) => ((docId * 9301 + n * 49297) % 233280) / 233280;
        const t = Number(tooth) || 3 + Math.floor(seed(1) * 12);
        const findings = [
          { kind: 'caries', tooth: String(t), surfaces: seed(2) > 0.5 ? 'MO' : 'DO', confidence: 0.82, box: [0.22 + seed(3) * 0.2, 0.34, 0.09, 0.08] },
          { kind: 'calculus', tooth: String(t + 1), confidence: 0.71, box: [0.55, 0.52 + seed(4) * 0.1, 0.07, 0.05] },
          { kind: 'restoration', tooth: String(t + 2), surfaces: 'O', confidence: 0.95, box: [0.7, 0.3, 0.12, 0.1] },
        ];
        if (seed(5) > 0.4) findings.push({ kind: 'bone_loss', tooth: String(t), confidence: 0.64, box: [0.3, 0.6, 0.18, 0.12], measurement_mm: 3.5 });
        return { image_type: 'bitewing', quality: null, findings: findings.map(normalize) };
      },
    };
  }
  return { mode: 'off', enabled: false };
}

// Deps per database, so each app (and each test's app) analyses with its own storage and engine.
const deps = new WeakMap();
export const registerXrayAi = (db, d) => deps.set(db, d);

// Reads a document and stores what the engine found (replacing earlier suggestions nobody acted on).
export async function analyzeDocument(db, doc) {
  const d = deps.get(db);
  if (!d?.xrayAi?.enabled) throw new HttpError(503, 'AI x-ray reading is not set up on this server');
  if (doc.category !== 'xray' || !/^image\//.test(doc.mime)) throw new HttpError(400, 'Only x-ray images can be read');
  const data = await d.storage.read(doc.storage_key, !!doc.encrypted);
  const out = await d.xrayAi.analyze({ data, mime: doc.mime, docId: doc.id, tooth: doc.tooth });
  await db.tx(async () => {
    await db.run("DELETE FROM xray_findings WHERE document_id = ? AND status = 'suggested'", doc.id);
    for (const f of out.findings) {
      await insert(db, 'xray_findings', {
        practice_id: doc.practice_id, patient_id: doc.patient_id, document_id: doc.id, engine: d.xrayAi.mode, kind: f.kind, tooth: f.tooth, surfaces: f.surfaces,
        confidence: f.confidence, box: f.box ? JSON.stringify(f.box) : null, measurement_mm: f.measurement_mm, note: f.note,
      });
    }
    await db.run("UPDATE documents SET ai_read_at = datetime('now'), ai_image_type = ?, ai_quality = ? WHERE id = ?", out.image_type, out.quality, doc.id);
  });
  return out;
}

// New x-rays are read in the background when the practice has it turned on.
export function autoAnalyze(db, docId) {
  const d = deps.get(db);
  if (!d?.xrayAi?.enabled) return;
  (async () => {
    const doc = await db.get('SELECT d.*, p.xray_ai_auto FROM documents d JOIN practices p ON p.id = d.practice_id WHERE d.id = ?', docId);
    if (!doc?.xray_ai_auto || doc.category !== 'xray' || !/^image\//.test(doc.mime)) return;
    await analyzeDocument(db, doc);
  })().catch((err) => log.warn('x-ray AI read failed', { document: docId, error: err.message }));
}
