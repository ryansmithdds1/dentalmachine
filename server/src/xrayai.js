import { randomUUID } from 'node:crypto';
import { refuseTraining } from './training.js';
import { HttpError } from './auth.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { insert, audit, practiceNow } from './util.js';
import { withActor } from './actor.js';
import { log } from './monitoring.js';
import { VENDORS, vendorId, vendorAdapter, sandboxFetch, VendorError } from './xrayvendors.js';

// AI findings on x-rays (backlog XR1–XR3): caries by surface, calculus, periapical radiolucency, bone level, margin
// discrepancies and existing restorations, each with where it is on the image, as a second set of eyes for the
// dentist. The detection comes only from an FDA-cleared vendor behind an adapter (xrayvendors.js):
//  - XRAY_AI=pearl | overjet | videahealth, with XRAY_AI_KEY (and XRAY_AI_URL to override the vendor's address).
//    XRAY_AI=vendor with XRAY_AI_NAME naming one of them still works.
//  - XRAY_AI=sandbox: a vendor's API played locally with made-up findings (XRAY_AI_SANDBOX_VENDOR, default Pearl).
// A general-purpose model (XRAY_AI=claude) is not validated to detect disease and is refused.
//
// Every finding is an "AI suggestion — the dentist decides": stored as `suggested`, never charted on its own. The
// dentist accepts (charted, with the finding linked as the reason) or dismisses it; both are recorded.
export const DISCLAIMER = 'AI suggestion — the dentist decides';
export const KINDS = ['caries', 'calculus', 'bone_loss', 'periapical', 'restoration', 'crown', 'root_canal', 'implant', 'impacted', 'open_margin', 'other'];
export const LABELS = {
  caries: 'Caries', calculus: 'Calculus', bone_loss: 'Bone loss', periapical: 'Periapical radiolucency', restoration: 'Existing restoration', crown: 'Crown',
  root_canal: 'Root canal', implant: 'Implant', impacted: 'Impacted tooth', open_margin: 'Margin discrepancy', other: 'Other',
};
// The same, in words for a patient (chair screen, treatment presentation).
export const PATIENT_LABELS = {
  caries: 'A cavity (decay)', calculus: 'Tartar build-up', bone_loss: 'Bone loss around the tooth', periapical: 'A dark spot at the root tip (possible infection)',
  restoration: 'An existing filling', crown: 'An existing crown', root_canal: 'An existing root canal', implant: 'An implant', impacted: 'A tooth that hasn’t come in',
  open_margin: 'A gap at the edge of a filling or crown', other: 'Something the dentist wants to show you',
};
const SURFACE_WORDS = { M: 'front side', D: 'back side', O: 'chewing surface', I: 'biting edge', B: 'cheek side', F: 'front (lip) side', L: 'tongue side' };
export const surfaceWords = (s) => (s ? [...s].map((c) => SURFACE_WORDS[c]).filter(Boolean).join(', ') : '');
// Accepting a finding puts it on the tooth chart as one of these conditions (kinds with no condition of their
// own — calculus, bone loss, margins — go on as "watch", with what it was in the note).
export const TO_CONDITION = { caries: 'caries', periapical: 'abscess', impacted: 'impacted', restoration: 'filling', crown: 'crown', root_canal: 'root_canal', implant: 'implant' };

const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
export function normalize(f) {
  const box = Array.isArray(f.box) && f.box.length === 4 ? f.box.map(clamp) : null;
  return {
    kind: KINDS.includes(f.kind) ? f.kind : 'other', tooth: f.tooth ? String(f.tooth).toUpperCase().slice(0, 3) : null,
    surfaces: f.surfaces ? String(f.surfaces).toUpperCase().replace(/[^MODBFLI]/g, '').slice(0, 5) || null : null,
    confidence: Math.round(clamp(f.confidence) * 100) / 100, box: box && box[2] > 0 && box[3] > 0 ? box : null,
    measurement_mm: f.measurement_mm == null || !Number.isFinite(Number(f.measurement_mm)) ? null : Math.round(Number(f.measurement_mm) * 10) / 10,
    note: f.note ? String(f.note).slice(0, 300) : null, vendor_ref: f.vendor_ref ? String(f.vendor_ref).slice(0, 120) : null,
  };
}

const off = (reason) => ({ mode: 'off', enabled: false, reason });
export function createXrayAi({ config, fetchImpl = globalThis.fetch }) {
  const mode = String(config.xrayAi || (config.xrayAiUrl ? 'vendor' : '')).toLowerCase();
  if (!mode || mode === 'off') return off('Not set up on this server.');
  if (mode === 'claude') return off('A general-purpose AI model is not validated to find disease on x-rays, so it isn’t used. Choose Pearl, Overjet or VideaHealth (XRAY_AI=pearl, overjet or videahealth).');
  const tuning = { pollMs: config.xrayAiPollMs ?? 2000, maxPolls: config.xrayAiMaxPolls ?? 45 };
  if (mode === 'sandbox') {
    const v = VENDORS[vendorId(config.xrayAiSandboxVendor || process.env.XRAY_AI_SANDBOX_VENDOR) || 'pearl'];
    return vendorAdapter(v, { base: v.defaultBase, key: 'sandbox', fetchImpl: sandboxFetch(v), sandbox: true, ...tuning, pollMs: 0 });
  }
  const id = vendorId(mode === 'vendor' ? config.xrayAiName : mode);
  if (!id) return off(`“${mode === 'vendor' ? config.xrayAiName || 'vendor' : mode}” isn’t a supported x-ray AI vendor. Use Pearl, Overjet or VideaHealth.`);
  if (!config.xrayAiKey) return { ...off(`${VENDORS[id].name} needs its key (XRAY_AI_KEY) — it comes with the vendor contract and BAA.`), vendor: id };
  return vendorAdapter(VENDORS[id], { base: config.xrayAiUrl, key: config.xrayAiKey, fetchImpl, ...tuning });
}

// What the screens show about the engine.
export const engineStatus = (x) => ({
  enabled: !!x?.enabled, mode: x?.mode || 'off', vendor: x?.vendor || null, label: x?.label || null, cleared: !!x?.cleared, sandbox: !!x?.sandbox,
  reason: x?.enabled ? null : x?.reason || 'Not set up on this server.', disclaimer: DISCLAIMER,
});

// Deps per database, so each app (and each test's app) analyses with its own storage and engine.
const deps = new WeakMap();
export const registerXrayAi = (db, d) => deps.set(db, d);
export const xrayAiFor = (db) => deps.get(db)?.xrayAi || null;

const READ_FOR = { upload: 'the new x-ray', manual: 'asked for by hand', second_look: 'second look before today’s visit' };
// Needs attention: an image the vendor refused is that image's problem; a vendor that's down or refusing the
// key is one problem for the whole practice (not one per image). Both close on the next read that works.
const docKey = (docId) => `xray-ai:${docId}`;
const vendorKey = 'xray-ai:vendor';

// Sends the image to the vendor and stores what it found as suggestions (replacing earlier suggestions nobody
// acted on for this image). opts: { readFor: upload | manual | second_look, req }.
export async function analyzeDocument(db, doc, { readFor = 'manual', req = null } = {}) {
  const d = deps.get(db);
  if (!d?.xrayAi?.enabled) throw new HttpError(503, 'AI x-ray reading is not set up on this server');
  if (doc.category !== 'xray' || !/^image\//.test(doc.mime)) throw new HttpError(400, 'Only x-ray images can be read');
  const engine = d.xrayAi;
  // The training patient's images never go to an outside reader (training.js); the built-in sandbox reads them here.
  if (engine.mode !== 'sandbox') await refuseTraining(db, doc.patient_id, 'sending an x-ray to the AI reader');
  const data = await d.storage.read(doc.storage_key, !!doc.encrypted);
  const started = Date.now();
  const ref = randomUUID();
  let out;
  try {
    const raw = await engine.analyze({ data, mime: doc.mime, ref, tooth: doc.tooth });
    out = { ...raw, findings: (raw.findings || []).map(normalize) };
  } catch (err) {
    await insert(db, 'xray_ai_reads', {
      practice_id: doc.practice_id, patient_id: doc.patient_id, document_id: doc.id, engine: engine.mode, read_for: readFor, ok: 0, error: String(err.message).slice(0, 500),
      requested_by: req?.user?.id ?? null, duration_ms: Date.now() - started,
    });
    const image = err instanceof VendorError && err.kind === 'image';
    await raiseIssue(db, image
      ? { practiceId: doc.practice_id, kind: 'ai', key: docKey(doc.id), role: 'clinical', entity: 'documents', entityId: doc.id, patientId: doc.patient_id, title: `${engine.label} couldn’t read an x-ray — look at it without the AI, or retake it`, detail: err.message }
      : { practiceId: doc.practice_id, kind: 'ai', key: vendorKey, role: err.kind === 'auth' ? 'admin' : 'clinical', severity: err.kind === 'auth' ? 'high' : 'normal', title: `The x-ray AI (${engine.label}) isn’t working — x-rays are waiting for their AI read`, detail: err.message });
    if (err instanceof HttpError) throw err;
    throw Object.assign(new HttpError(502, `The x-ray AI couldn’t read this image: ${err.message}`), { vendorKind: err.kind || 'down' });
  }
  let kept = 0;
  await db.tx(async () => {
    // Lock the image (Postgres) so two reads finishing together (automatic and by hand) don't both keep their findings.
    await db.run('UPDATE documents SET ai_read_at = ai_read_at WHERE id = ?', doc.id);
    // Suggestions nobody acted on are derived rows: replaced by the new read (scratch, so a hard delete).
    await db.run("DELETE FROM xray_findings WHERE document_id = ? AND status = 'suggested'", doc.id);
    // Don't ask again about something the dentist already decided on this image.
    const decided = new Set((await db.all("SELECT kind, tooth, surfaces FROM xray_findings WHERE document_id = ? AND status != 'suggested'", doc.id)).map((f) => `${f.kind}|${f.tooth || ''}|${f.surfaces || ''}`));
    for (const f of out.findings) {
      if (decided.has(`${f.kind}|${f.tooth || ''}|${f.surfaces || ''}`)) continue;
      kept++;
      await insert(db, 'xray_findings', {
        practice_id: doc.practice_id, patient_id: doc.patient_id, document_id: doc.id, engine: engine.mode, cleared: engine.cleared ? 1 : 0, kind: f.kind, tooth: f.tooth, surfaces: f.surfaces,
        confidence: f.confidence, box: f.box ? JSON.stringify(f.box) : null, measurement_mm: f.measurement_mm, note: f.note, vendor_ref: f.vendor_ref,
      });
    }
    await db.run("UPDATE documents SET ai_read_at = datetime('now'), ai_image_type = ?, ai_quality = ?, ai_engine = ?, ai_vendor_ref = ? WHERE id = ?",
      out.image_type || null, out.quality || null, engine.mode, out.vendor_ref ? String(out.vendor_ref).slice(0, 120) : null, doc.id);
    await insert(db, 'xray_ai_reads', {
      practice_id: doc.practice_id, patient_id: doc.patient_id, document_id: doc.id, engine: engine.mode, read_for: readFor, ok: 1, findings: out.findings.length,
      vendor_ref: out.vendor_ref ? String(out.vendor_ref).slice(0, 120) : null, requested_by: req?.user?.id ?? null, duration_ms: Date.now() - started,
    });
  });
  await resolveIssue(db, doc.practice_id, docKey(doc.id), 'Resolved automatically: the x-ray was read on a later attempt');
  await resolveIssue(db, doc.practice_id, vendorKey, 'Resolved automatically: the x-ray AI answered again');
  // The AI's part, on the record as the AI (with who asked, when a person did).
  await withActor({ practiceId: doc.practice_id }, () => audit(db, req, 'xray_ai.read', 'documents', doc.id, {
    engine: engine.mode, cleared: !!engine.cleared, findings: out.findings.length, new_suggestions: kept, read_for: readFor, vendor_ref: out.vendor_ref || null,
  }, {
    source: 'ai', actor: `${engine.label}${req?.user ? ` (asked by ${req.user.name})` : ''}`, patientId: doc.patient_id,
    reason: `X-ray AI read: ${READ_FOR[readFor] || readFor}. Findings are suggestions for the dentist.`,
  }));
  return out;
}

// New x-rays are read in the background when the practice has it turned on. A failure is a Needs attention
// item (analyzeDocument raises it), never only a log line.
export function autoAnalyze(db, docId) {
  const d = deps.get(db);
  if (!d?.xrayAi?.enabled) return;
  (async () => {
    const doc = await db.get('SELECT d.*, p.xray_ai_auto FROM documents d JOIN practices p ON p.id = d.practice_id WHERE d.id = ?', docId);
    if (!doc?.xray_ai_auto || doc.category !== 'xray' || !/^image\//.test(doc.mime)) return;
    await analyzeDocument(db, doc, { readFor: 'upload' });
  })().catch((err) => log.warn('x-ray AI read failed', { document: docId, error: err.message }));
}

// ---------------------------------------------------------------------------------------------------------
// XR2: the chart comparison. Is what the AI saw already on the chart? One pure function, so the rules are in one
// place: a condition on the tooth (surfaces overlapping), planned work that treats it, or work completed on or
// after the x-ray. A finding without a tooth number can't be compared — the dentist looks at the image.
const overlaps = (a, b) => !a || !b || [...a].some((c) => b.includes(c));
const codeIs = {
  restorative: (c) => /^D2(1|3|4|5|6|7)\d\d/.test(c) || /^D29(3|4)\d/.test(c),
  crown: (c) => /^D27\d\d/.test(c) || /^D6(0[5-9]|[1-9]\d)\d/.test(c),
  endo: (c) => /^D3(3|4)\d\d/.test(c),
  extraction: (c) => /^D7(1|2)\d\d/.test(c),
  perio: (c) => /^D4\d{3}/.test(c) || c === 'D1110',
  implant: (c) => /^D60\d\d/.test(c),
};
const RULES = {
  caries: { conditions: ['caries', 'watch'], treats: (c) => codeIs.restorative(c) || codeIs.crown(c) || codeIs.extraction(c), surfaces: true },
  periapical: { conditions: ['abscess', 'watch'], treats: (c) => codeIs.endo(c) || codeIs.extraction(c) },
  open_margin: { conditions: ['watch', 'fracture'], treats: (c) => codeIs.restorative(c) || codeIs.crown(c) },
  impacted: { conditions: ['impacted', 'watch'], treats: codeIs.extraction },
  calculus: { conditions: ['watch'], treats: codeIs.perio, anyTooth: true },
  bone_loss: { conditions: ['watch'], treats: codeIs.perio, anyTooth: true },
  // Existing work: on the chart as that condition, or as the completed procedure (whenever it was done).
  restoration: { conditions: ['filling', 'crown'], done: codeIs.restorative, surfaces: true },
  crown: { conditions: ['crown', 'bridge_pontic'], done: codeIs.crown },
  root_canal: { conditions: ['root_canal'], done: codeIs.endo },
  implant: { conditions: ['implant'], done: codeIs.implant },
  other: { conditions: [] },
};
const where = (f) => `#${f.tooth}${f.surfaces ? ` ${f.surfaces}` : ''}`;
export function sentenceFor(f, status) {
  const what = ['restoration', 'crown', 'root_canal', 'implant'].includes(f.kind) ? `an existing ${LABELS[f.kind].replace(/^Existing /, '').toLowerCase()}` : `possible ${LABELS[f.kind].toLowerCase()}`;
  const mm = f.measurement_mm ? ` (${f.measurement_mm} mm)` : '';
  if (status === 'no_tooth') return `AI saw ${what}${mm}; tooth not identified — check the image`;
  return `AI saw ${what} on ${where(f)}${mm}; ${status === 'charted' ? 'already on the chart' : 'not charted'}`;
}
// chart: { conditions: [...not voided], procedures: [...not cancelled] } for the patient; imageDate 'YYYY-MM-DD'.
export function compareWithChart(f, chart, imageDate = null) {
  if (!f.tooth) return { status: 'no_tooth', matched: null, sentence: sentenceFor(f, 'no_tooth') };
  const rule = RULES[f.kind] || RULES.other;
  const t = String(f.tooth).toUpperCase();
  const cond = chart.conditions.find((c) => String(c.tooth).toUpperCase() === t && !c.resolved && rule.conditions.includes(c.condition) && (!rule.surfaces || c.condition === 'watch' || c.condition === 'crown' || overlaps(f.surfaces, c.surfaces)));
  if (cond) return { status: 'charted', matched: { type: 'condition', id: cond.id, text: `${cond.condition.replace(/_/g, ' ')} on #${cond.tooth}${cond.surfaces ? ` ${cond.surfaces}` : ''}` }, sentence: sentenceFor(f, 'charted') };
  const since = imageDate ? `${imageDate}` : '';
  const proc = chart.procedures.find((p) => {
    const code = String(p.code || '').toUpperCase();
    const onTooth = String(p.tooth || '').toUpperCase() === t || (rule.anyTooth && !p.tooth);
    if (!onTooth || p.status === 'cancelled') return false;
    const surf = !rule.surfaces || codeIs.crown(code) || overlaps(f.surfaces, p.surfaces);
    if (rule.done) return p.status === 'completed' && rule.done(code) && surf;
    if (!rule.treats?.(code) || !surf) return false;
    return p.status === 'planned' || String(p.completed_at || '').slice(0, 10) >= since;
  });
  if (proc) return { status: 'charted', matched: { type: 'procedure', id: proc.id, text: `${proc.code}${proc.tooth ? ` #${proc.tooth}` : ''}${proc.surfaces ? ` ${proc.surfaces}` : ''} (${proc.status})` }, sentence: sentenceFor(f, 'charted') };
  return { status: 'not_charted', matched: null, sentence: sentenceFor(f, 'not_charted') };
}

export const findingView = (f) => ({ ...f, box: f.box ? JSON.parse(f.box) : null, label: LABELS[f.kind] || f.kind, disclaimer: DISCLAIMER });

// The review list for some patients: their suggested findings, each compared with the chart.
export async function reviewFor(db, practiceId, patientIds) {
  if (!patientIds.length) return [];
  const ids = patientIds.map(Number);
  const marks = ids.map(() => '?').join(', ');
  const findings = await db.all(
    `SELECT f.*, COALESCE(d.taken_at, d.created_at) AS image_date, d.filename, d.ai_image_type FROM xray_findings f JOIN documents d ON d.id = f.document_id
     WHERE f.practice_id = ? AND f.patient_id IN (${marks}) AND f.status = 'suggested' AND d.deleted_at IS NULL ORDER BY f.patient_id, f.document_id DESC, f.id`, practiceId, ...ids,
  );
  if (!findings.length) return [];
  const conditions = await db.all(`SELECT * FROM tooth_conditions WHERE practice_id = ? AND patient_id IN (${marks}) AND voided_at IS NULL`, practiceId, ...ids);
  const procedures = await db.all(`SELECT id, patient_id, code, tooth, surfaces, status, completed_at FROM procedures WHERE practice_id = ? AND patient_id IN (${marks}) AND status != 'cancelled'`, practiceId, ...ids);
  return findings.map((f) => {
    const chart = { conditions: conditions.filter((c) => c.patient_id === f.patient_id), procedures: procedures.filter((p) => p.patient_id === f.patient_id) };
    const cmp = compareWithChart(f, chart, String(f.image_date || '').slice(0, 10));
    return { ...findingView(f), image_date: String(f.image_date || '').slice(0, 10), chart: { status: cmp.status, matched: cmp.matched }, sentence: cmp.sentence };
  });
}

// ---------------------------------------------------------------------------------------------------------
// XR2: the pre-appointment second look. Today's patients' x-rays that the AI hasn't read yet (taken in the last
// year) are read before the visit, so the dentist's review list is ready. Runs as automation; the reads are the
// AI's. A read that failed in the last hour is left for the next run (the failure is already in Needs attention).
export async function runSecondLook(db, { practiceId = null, limit = 200 } = {}) {
  const d = deps.get(db);
  if (!d?.xrayAi?.enabled) return { read: 0, failed: 0, skipped: 'off' };
  const practices = practiceId
    ? await db.all('SELECT id FROM practices WHERE id = ?', practiceId)
    : await db.all('SELECT id FROM practices WHERE xray_ai_auto = 1');
  let read = 0;
  let failed = 0;
  for (const p of practices) {
    await withActor({ source: 'automation', actor: 'X-ray AI second look', practiceId: p.id, userId: null, locationId: null, reason: null }, async () => {
      const today = (await practiceNow(db, p.id)).slice(0, 10);
      const yearAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 366 * 86400_000).toISOString().slice(0, 10);
      const hourAgo = new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ');
      const docs = await db.all(
        `SELECT d.* FROM documents d WHERE d.practice_id = ? AND d.category = 'xray' AND d.deleted_at IS NULL AND d.ai_read_at IS NULL AND d.mime LIKE 'image/%'
           AND COALESCE(d.taken_at, d.created_at) >= ?
           AND d.patient_id IN (SELECT a.patient_id FROM appointments a WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time <= ? AND a.status NOT IN ('cancelled','no_show'))
           AND NOT EXISTS (SELECT 1 FROM xray_ai_reads r WHERE r.document_id = d.id AND r.ok = 0 AND r.created_at > ?)
         ORDER BY d.id LIMIT ${Number(limit)}`,
        p.id, yearAgo, p.id, `${today} 00:00`, `${today} 23:59`, hourAgo,
      );
      for (const doc of docs) {
        try {
          await analyzeDocument(db, doc, { readFor: 'second_look' });
          read++;
        } catch (err) {
          failed++;
          log.warn('x-ray AI second look failed', { document: doc.id, error: err.message });
          // A vendor that's down (or refusing the key) fails every image the same way: stop for this practice
          // until the next run rather than sending the rest of today's images into the same failure.
          if (err.vendorKind && err.vendorKind !== 'image') break;
        }
      }
    });
  }
  return { read, failed };
}

// ---------------------------------------------------------------------------------------------------------
// XR3: what a patient may be shown. Only findings the dentist accepted — never suggestions or dismissed ones —
// in plain words, with the image they're on.
export async function acceptedForPatient(db, practiceId, patientId, { teeth = null } = {}) {
  const rows = await db.all(
    `SELECT f.id, f.document_id, f.kind, f.tooth, f.surfaces, f.box, f.measurement_mm, f.confidence, f.reviewed_at, COALESCE(d.taken_at, d.created_at) AS image_date, d.ai_image_type
     FROM xray_findings f JOIN documents d ON d.id = f.document_id
     WHERE f.practice_id = ? AND f.patient_id = ? AND f.status = 'accepted' AND d.deleted_at IS NULL ORDER BY f.document_id DESC, f.id`, practiceId, patientId,
  );
  const want = teeth ? new Set(teeth.map((t) => String(t).toUpperCase())) : null;
  return rows.filter((f) => !want || (f.tooth && want.has(String(f.tooth).toUpperCase()))).map((f) => ({
    id: f.id, document_id: f.document_id, kind: f.kind, tooth: f.tooth, surfaces: f.surfaces, box: f.box ? JSON.parse(f.box) : null, measurement_mm: f.measurement_mm,
    image_date: String(f.image_date || '').slice(0, 10), image_type: f.ai_image_type || null,
    label: PATIENT_LABELS[f.kind] || PATIENT_LABELS.other, where: f.tooth ? `Tooth ${f.tooth}${f.surfaces ? ` — ${surfaceWords(f.surfaces)}` : ''}` : null,
  }));
}
// For the treatment presentation: accepted findings on the teeth in the plan (no image ids on a public link).
export async function acceptedForPlan(db, plan, procedures) {
  const teeth = [...new Set((procedures || []).map((p) => p.tooth).filter(Boolean))];
  if (!teeth.length) return [];
  return (await acceptedForPatient(db, plan.practice_id, plan.patient_id, { teeth })).map(({ kind, tooth, surfaces, label, where: w, image_date }) => ({ kind, tooth, surfaces, label, where: w, image_date }));
}
