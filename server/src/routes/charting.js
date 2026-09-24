import express, { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, insert, update, findOr404, audit, practiceNow, localNow } from '../util.js';
import { quickFill, aiFill } from '../notedictation.js';
import { aiClient } from '../ai.js';
import { log } from '../monitoring.js';

// Charting support: note templates, vitals, the lab directory and the procedure code list tools.

const CATEGORIES = ['diagnostic', 'preventive', 'restorative', 'endodontics', 'periodontics', 'prosthodontics', 'oral_surgery', 'orthodontics', 'implants', 'adjunctive'];
const AREAS = ['tooth', 'quadrant', 'arch', 'mouth'];

// What a dentist says that general speech recognition gets wrong.
export const DENTAL_TERMS = ['articaine', 'lidocaine', 'mepivacaine', 'prilocaine', 'bupivacaine', 'Septocaine', 'carpule', 'carpules', 'IANB', 'PSA', 'infiltration',
  'rubber dam', 'Isolite', 'Vitrebond', 'Fuji', 'RelyX', 'TempBond', 'Durelon', 'composite', 'amalgam', 'zirconia', 'e.max', 'PFM', 'buildup', 'pulpotomy',
  'mesial', 'distal', 'occlusal', 'buccal', 'lingual', 'facial', 'incisal', 'MOD', 'periapical', 'bitewing', 'caries', 'recurrent decay', 'gingivitis',
  'periodontitis', 'bleeding on probing', 'furcation', 'mobility', 'abfraction', 'attrition', 'erosion', 'amoxicillin', 'clindamycin', 'ibuprofen', 'chlorhexidine',
  'Peridex', 'fluoride varnish', 'sealant', 'prophy', 'scaling and root planing', 'extraction', 'socket', 'sutures', 'chromic gut', 'Gelfoam', 'hemostasis', 'endo', 'apex'];

// Starter templates for a new practice. {field} merges; [[Label: a|b|c]] asks the writer to pick.
export const DEFAULT_TEMPLATES = [
  ['Comprehensive exam', 'D0150', 'Comprehensive oral exam for {patient} on {date}. Medical history reviewed; [[Medical history: no changes|updated — see chart]]. BP {bp}. Extraoral and intraoral exam [[Soft tissue: WNL|findings noted]]. Oral cancer screening negative. Periodontal status: [[Perio: healthy|gingivitis|periodontitis — perio charting done]]. Radiographs reviewed. Findings and treatment plan discussed with patient; questions answered.'],
  ['Periodic exam', 'D0120', 'Periodic exam for {patient}. Medical history reviewed, [[Medical history: no changes|updated]]. Soft tissue WNL. [[Findings: no new findings|findings charted and discussed]]. Next recall [[Recall: 6 months|3 months|4 months]].'],
  ['Adult prophy', 'D1110', 'Adult prophylaxis. Scaled and polished all quadrants. Home care: [[Oral hygiene: good|fair|poor]]; OHI given. Flossed. [[Fluoride: fluoride varnish applied|patient declined fluoride|no fluoride]].'],
  ['Composite restoration', 'D2330 D2331 D2332 D2335 D2391 D2392 D2393 D2394', 'Restored {procedures}. Anesthetic: [[Anesthetic: 2% lidocaine 1:100k epi|4% articaine 1:100k epi|3% mepivacaine plain|none]], [[Carpules: 1|2|3]] carpule(s), [[Injection: infiltration|IANB|PSA]]. Isolation with [[Isolation: rubber dam|Isolite|cotton rolls]]. Caries removed, [[Liner: no liner|Vitrebond liner]]. Etch, bond, composite shade [[Shade: A1|A2|A3|A3.5|B1]] placed incrementally and light cured. Occlusion adjusted and polished. Patient tolerated procedure well.'],
  ['Crown prep', 'D2740 D2750 D2790', 'Crown preparation {procedures}. Anesthetic: [[Anesthetic: 2% lidocaine 1:100k epi|4% articaine 1:100k epi]], [[Carpules: 1|2|3]] carpule(s). Tooth prepared, [[Buildup: no buildup needed|core buildup placed]]. Final impression [[Impression: digital scan|PVS]]. Shade [[Shade: A1|A2|A3|B1]]. Temporary fabricated and cemented with [[Temp cement: TempBond NE|Durelon]]. Occlusion checked. Post-op instructions given.'],
  ['Extraction', 'D7140 D7210', 'Extraction {procedures}. Consent signed. Anesthetic: [[Anesthetic: 2% lidocaine 1:100k epi|4% articaine 1:100k epi]], [[Carpules: 1|2|3|4]] carpule(s). Tooth elevated and delivered [[Delivery: intact|in sections]]. Socket curetted and irrigated. Hemostasis achieved with gauze pressure. [[Sutures: no sutures|sutures placed]]. Post-op instructions given verbally and in writing.'],
  ['Scaling and root planing', 'D4341 D4342', 'Scaling and root planing {procedures}. Anesthetic: [[Anesthetic: 2% lidocaine 1:100k epi|4% articaine 1:100k epi|topical only]]. Hand and ultrasonic instrumentation. [[Irrigation: chlorhexidine irrigation|no irrigation]]. OHI given. Re-evaluate in 4-6 weeks.'],
];

// Merge fields for a note: patient, today, and the procedures being written up.
export function mergeNote(body, ctx) {
  const list = ctx.procedures.map((p) => `${p.code}${p.tooth ? ` #${p.tooth}` : ''}${p.surfaces ? ` ${p.surfaces}` : ''}${p.area ? ` ${p.area}` : ''}`);
  const fields = {
    patient: ctx.patient ? `${ctx.patient.first_name} ${ctx.patient.last_name}` : '',
    date: ctx.date,
    provider: ctx.provider || '',
    // No procedures picked yet: the teeth become a question the dentist answers (or dictates: "number 30 MO").
    procedures: list.join(', ') || '[[Teeth: ]]',
    teeth: [...new Set(ctx.procedures.map((p) => p.tooth).filter(Boolean))].map((t) => `#${t}`).join(', ') || '[[Teeth: ]]',
    codes: [...new Set(ctx.procedures.map((p) => p.code))].join(', '),
    bp: ctx.vitals?.bp_systolic ? `${ctx.vitals.bp_systolic}/${ctx.vitals.bp_diastolic}` : '[[BP: not taken]]',
    pulse: ctx.vitals?.pulse ? String(ctx.vitals.pulse) : '',
    allergies: ctx.patient?.allergies || 'NKDA',
    medications: ctx.patient?.medications || 'none reported',
  };
  return body.replace(/\{(\w+)\}/g, (m, k) => (k in fields ? fields[k] : m));
}

// [[Label: a|b|c]] → { label, options }; the client turns each into a picker.
export function notePrompts(body) {
  return [...body.matchAll(/\[\[([^:\]]+):\s*([^\]]*)\]\]/g)].map((m) => ({ token: m[0], label: m[1].trim(), options: m[2].split('|').map((o) => o.trim()) }));
}

const matchesCodes = (tpl, codes) => {
  const list = String(tpl.codes || '').toUpperCase().split(/[\s,]+/).filter(Boolean);
  return list.some((c) => codes.some((code) => code.startsWith(c)));
};

// Minimal CSV: quoted fields, commas and newlines inside quotes, "" escapes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));

export default function chartingRoutes({ db, config = {}, transcriber = null }) {
  const r = Router();

  // ---- Note templates ----
  const templates = async (pid) => {
    let rows = await db.all('SELECT * FROM note_templates WHERE practice_id = ? ORDER BY name', pid);
    // Seeded once; a practice that deletes them all doesn't get them back. In a transaction so a request
    // racing the seeding waits for it rather than seeing an empty list.
    if (!rows.length) {
      await db.tx(async () => {
        if (!(await db.run('UPDATE practices SET templates_seeded = 1 WHERE id = ? AND templates_seeded = 0', pid)).changes) return;
        for (const [name, codes, body] of DEFAULT_TEMPLATES) await insert(db, 'note_templates', { practice_id: pid, name, codes, body });
      });
      rows = await db.all('SELECT * FROM note_templates WHERE practice_id = ? ORDER BY name', pid);
    }
    return rows;
  };
  const TEMPLATE_FIELDS = ['name', 'body', 'codes', 'active'];
  const cleanTemplate = (row) => {
    if (row.codes != null) row.codes = String(row.codes).toUpperCase().split(/[\s,]+/).filter(Boolean).join(' ') || null;
    if (row.body != null && String(row.body).length > 20000) throw new HttpError(400, 'Template is too long');
    if (row.active != null) row.active = row.active ? 1 : 0;
    return row;
  };
  r.get('/note-templates', requirePermission('clinical:read'), async (req, res) => {
    res.json((await templates(req.user.practice_id)).map((t) => ({ ...t, prompts: notePrompts(t.body) })));
  });
  r.post('/note-templates', requirePermission('clinical:write'), async (req, res) => {
    const row = cleanTemplate(pick(req.body, TEMPLATE_FIELDS));
    requireFields(row, ['name', 'body']);
    await templates(req.user.practice_id);
    const id = await insert(db, 'note_templates', { ...row, practice_id: req.user.practice_id });
    await audit(db, req, 'note_template.create', 'note_templates', id);
    res.status(201).json(await db.get('SELECT * FROM note_templates WHERE id = ?', id));
  });
  r.put('/note-templates/:tid', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'note_templates', req.params.tid, req.user.practice_id, 'Template');
    await update(db, 'note_templates', existing.id, req.user.practice_id, cleanTemplate(pick(req.body, TEMPLATE_FIELDS)));
    await audit(db, req, 'note_template.update', 'note_templates', existing.id);
    res.json(await db.get('SELECT * FROM note_templates WHERE id = ?', existing.id));
  });
  r.delete('/note-templates/:tid', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'note_templates', req.params.tid, req.user.practice_id, 'Template');
    await db.run('DELETE FROM note_templates WHERE id = ?', existing.id);
    await audit(db, req, 'note_template.delete', 'note_templates', existing.id);
    res.json({ ok: true });
  });

  // A note drafted from the templates for the given procedures (or one template by id), merged and
  // ready for the writer to answer its prompts.
  // How dictation is heard: by the server's speech service (covered by its BAA, primed with dental words) when
  // one is set up, else by the browser's own speech recognition.
  r.get('/dictation', requirePermission('clinical:write'), (_req, res) => res.json({ mode: transcriber?.dictation ? 'server' : 'browser', vendor: transcriber?.mode ?? null }));

  // One spoken piece (the audio between pauses) to text. The audio isn't kept.
  r.post('/dictation/transcribe', requirePermission('clinical:write'), express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '8mb' }), async (req, res) => {
    if (!transcriber?.dictation) throw new HttpError(409, 'Server dictation isn’t set up — the browser’s speech recognition is used instead');
    const audio = Buffer.isBuffer(req.body) ? req.body : null;
    if (!audio?.length) throw new HttpError(400, 'No audio');
    const contentType = String(req.get('Content-Type') || 'audio/webm').split(';')[0];
    const text = await transcriber.dictation(audio, { contentType, keyterms: await dictationTerms(req.user.practice_id) });
    res.json({ text });
  });

  // Words the speech service should expect: dental vocabulary plus every answer in this office's templates.
  const dictationTerms = async (pid) => {
    const fromTemplates = (await db.all('SELECT body FROM note_templates WHERE practice_id = ? AND active = 1', pid))
      .flatMap((t) => notePrompts(t.body).flatMap((q) => q.options))
      .flatMap((o) => o.split(/[\s,/]+/))
      .filter((w) => /[a-z]{4,}/i.test(w));
    return [...new Set([...DENTAL_TERMS, ...fromTemplates])].slice(0, 100);
  };

  // Dictation into the note being written: returns the note with the dictation worked in. Nothing is saved
  // here — the dentist sees what changed and saves (and signs) the note as usual.
  r.post('/patients/:id/note-dictate', requirePermission('clinical:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const body = String(req.body?.body ?? '');
    const dictation = String(req.body?.dictation ?? '').trim();
    if (!dictation) throw new HttpError(400, 'Nothing was dictated');
    if (dictation.length > 5000) throw new HttpError(400, 'That dictation is too long — dictate a section at a time');
    if (body.length > 20000) throw new HttpError(400, 'The note is too long');
    let result = null;
    let warning = null;
    if (aiClient(config)) {
      try {
        const filled = await aiFill(config, { body, dictation, patient: `${patient.first_name} ${patient.last_name}` });
        if (filled) result = { ...filled, ai: true };
        else warning = 'The AI returned nothing usable; the dictation was added as written.';
      } catch (err) {
        // Shown to the dentist (not swallowed): the quick fill below still does what it can.
        log.warn('Note dictation AI failed', { error: err.message });
        warning = `The AI couldn't help this time (${err.message}); the dictation was added as written.`;
      }
    }
    if (!result) {
      const quick = quickFill(body, dictation);
      // Without the AI, what the quick fill can't place goes at the end, as said — never lost.
      const placed = quick.filled.length && dictation.split(/\s+/).length <= 12;
      const text = `${dictation.charAt(0).toUpperCase()}${dictation.slice(1)}${/[.!?]$/.test(dictation) ? '' : '.'}`;
      result = { ...quick, body: placed ? quick.body : quick.body.trim() ? `${quick.body.trim()}\n${text}` : text, added: placed ? [] : [text], changed: [], ai: false };
    }
    await audit(db, req, 'note.dictate', 'patients', patient.id, { ai: result.ai, filled: result.filled.length }, { patientId: patient.id });
    res.json({ ...result, warning });
  });

  r.get('/patients/:id/note-draft', requirePermission('clinical:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const ids = String(req.query.procedure_ids || '').split(',').map(Number).filter(Boolean);
    const procedures = [];
    for (const id of ids) {
      const p = await findOr404(db, 'procedures', id, req.user.practice_id, 'Procedure');
      if (p.patient_id !== patient.id) throw new HttpError(400, 'Procedure belongs to another patient');
      procedures.push(p);
    }
    const all = (await templates(req.user.practice_id)).filter((t) => t.active);
    const chosen = req.query.template_id
      ? all.filter((t) => t.id === Number(req.query.template_id))
      : all.filter((t) => matchesCodes(t, procedures.map((p) => p.code)));
    const provider = procedures[0]?.provider_id ? (await db.get('SELECT name FROM providers WHERE id = ?', procedures[0].provider_id))?.name : null;
    const vitals = await db.get('SELECT * FROM vitals WHERE patient_id = ? AND practice_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1', patient.id, req.user.practice_id);
    const date = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    // recorded_at is UTC: compare the practice-local day it was taken on (evening vitals are still "today").
    const { timezone } = await db.get('SELECT timezone FROM practices WHERE id = ?', req.user.practice_id);
    const takenOn = vitals && localNow(timezone, new Date(`${String(vitals.recorded_at).replace(' ', 'T').slice(0, 19)}Z`)).slice(0, 10);
    const ctx = { patient, procedures, provider, vitals: takenOn === date ? vitals : null, date };
    // One template per procedure group, each written up for its own procedures.
    const parts = chosen.map((t) => {
      const mine = procedures.filter((p) => matchesCodes(t, [p.code]));
      return mergeNote(t.body, { ...ctx, procedures: mine.length ? mine : procedures });
    });
    const body = parts.join('\n\n');
    res.json({ body, prompts: notePrompts(body), templates: chosen.map((t) => ({ id: t.id, name: t.name })), provider_id: procedures[0]?.provider_id ?? null });
  });

  // ---- Vitals ----
  r.get('/patients/:id/vitals', requirePermission('clinical:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json(await db.all(
      'SELECT v.*, u.name AS recorded_by_name FROM vitals v LEFT JOIN users u ON u.id = v.recorded_by WHERE v.patient_id = ? AND v.practice_id = ? ORDER BY v.recorded_at DESC, v.id DESC LIMIT 50',
      patient.id, req.user.practice_id,
    ));
  });
  r.post('/patients/:id/vitals', requirePermission('clinical:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const row = pick(req.body, ['bp_systolic', 'bp_diastolic', 'pulse', 'notes']);
    const range = { bp_systolic: [50, 300], bp_diastolic: [20, 200], pulse: [20, 250] };
    for (const [k, [lo, hi]] of Object.entries(range)) {
      if (row[k] == null || row[k] === '') { row[k] = null; continue; }
      row[k] = Number(row[k]);
      if (!Number.isInteger(row[k]) || row[k] < lo || row[k] > hi) throw new HttpError(400, `${k} must be between ${lo} and ${hi}`);
    }
    if ((row.bp_systolic == null) !== (row.bp_diastolic == null)) throw new HttpError(400, 'Enter both blood pressure numbers');
    if (row.bp_systolic == null && row.pulse == null) throw new HttpError(400, 'Enter a blood pressure or pulse');
    const id = await insert(db, 'vitals', { ...row, practice_id: req.user.practice_id, patient_id: patient.id, recorded_by: req.user.id });
    await audit(db, req, 'vitals.create', 'vitals', id);
    const v = await db.get('SELECT * FROM vitals WHERE id = ?', id);
    // Stage 2 hypertension or a hypertensive crisis: worth a second look before elective treatment.
    res.status(201).json({ ...v, warning: v.bp_systolic >= 180 || v.bp_diastolic >= 110 ? 'Blood pressure is in the hypertensive crisis range — defer elective treatment and consider referral.' : v.bp_systolic >= 160 || v.bp_diastolic >= 100 ? 'Blood pressure is high — recheck before treatment.' : null });
  });

  // ---- Lab directory ----
  const LAB_FIELDS = ['name', 'phone', 'email', 'address', 'turnaround_days', 'account_number', 'active'];
  const cleanLab = (row) => {
    if (row.turnaround_days != null && row.turnaround_days !== '') {
      row.turnaround_days = Number(row.turnaround_days);
      if (!Number.isInteger(row.turnaround_days) || row.turnaround_days < 0 || row.turnaround_days > 120) throw new HttpError(400, 'turnaround_days must be 0-120');
    } else if ('turnaround_days' in row) row.turnaround_days = null;
    if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) throw new HttpError(400, 'Invalid email');
    if (row.active != null) row.active = row.active ? 1 : 0;
    return row;
  };
  r.get('/labs', requirePermission('clinical:read'), async (req, res) => {
    res.json(await db.all(
      `SELECT l.*, (SELECT COUNT(*) FROM lab_cases c WHERE c.lab_id = l.id AND c.status IN ('sent','returned_for_adjustment')) AS open_cases
       FROM labs l WHERE l.practice_id = ? ORDER BY l.active DESC, l.name`, req.user.practice_id,
    ));
  });
  r.post('/labs', requirePermission('clinical:write'), async (req, res) => {
    const row = cleanLab(pick(req.body, LAB_FIELDS));
    requireFields(row, ['name']);
    const id = await insert(db, 'labs', { ...row, practice_id: req.user.practice_id });
    await audit(db, req, 'lab.create', 'labs', id);
    res.status(201).json(await db.get('SELECT * FROM labs WHERE id = ?', id));
  });
  r.put('/labs/:lid', requirePermission('clinical:write'), async (req, res) => {
    const existing = await findOr404(db, 'labs', req.params.lid, req.user.practice_id, 'Lab');
    await update(db, 'labs', existing.id, req.user.practice_id, cleanLab(pick(req.body, LAB_FIELDS)));
    await audit(db, req, 'lab.update', 'labs', existing.id);
    res.json(await db.get('SELECT * FROM labs WHERE id = ?', existing.id));
  });

  // Everything for a printed lab slip.
  r.get('/lab-cases/:lid/slip', requirePermission('clinical:read'), async (req, res) => {
    const c = await findOr404(db, 'lab_cases', req.params.lid, req.user.practice_id, 'Lab case');
    res.json({
      case: c,
      patient: await db.get('SELECT id, first_name, last_name, dob, gender FROM patients WHERE id = ?', c.patient_id),
      provider: c.provider_id ? await db.get('SELECT name, npi, license_number FROM providers WHERE id = ?', c.provider_id) : null,
      lab: c.lab_id ? await db.get('SELECT * FROM labs WHERE id = ?', c.lab_id) : null,
      procedure: c.procedure_id ? await db.get('SELECT code, description, tooth, surfaces FROM procedures WHERE id = ?', c.procedure_id) : null,
      appointment: c.appointment_id ? await db.get('SELECT start_time FROM appointments WHERE id = ?', c.appointment_id) : null,
      practice: await db.get('SELECT name, phone, address, city, state, zip FROM practices WHERE id = ?', c.practice_id),
    });
  });

  // ---- Procedure codes ----
  // Most-used codes in the last year: the chart's quick-pick row.
  r.get('/procedure-codes/favorites', requirePermission('clinical:read'), async (req, res) => {
    const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const rows = await db.all(
      `SELECT pc.*, COUNT(pr.id) AS uses FROM procedures pr JOIN procedure_codes pc ON pc.id = pr.code_id
       WHERE pr.practice_id = ? AND pr.created_at >= ? AND pc.active = 1
       GROUP BY pc.id, pc.practice_id, pc.code, pc.description, pc.category, pc.fee, pc.requires_tooth, pc.requires_surface, pc.active, pc.area, pc.time_units
       ORDER BY COUNT(pr.id) DESC, pc.code LIMIT ?`,
      req.user.practice_id, since, Math.min(Number(req.query.limit) || 12, 40),
    );
    res.json(rows);
  });

  // Import or update the code list from CSV: code, description, category, fee (dollars), area, time units.
  // Existing codes are updated in place; the header row is optional.
  r.post('/procedure-codes/import', requireAdmin, async (req, res) => {
    const text = String(req.body?.csv || '');
    if (!text.trim()) throw new HttpError(400, 'Paste or upload a CSV of codes');
    if (text.length > 2_000_000) throw new HttpError(400, 'That file is too large');
    let rows = parseCsv(text);
    let cols = ['code', 'description', 'category', 'fee', 'area', 'time_units'];
    if (rows[0] && rows[0].some((c) => /^\s*(code|description)\s*$/i.test(c))) {
      cols = rows[0].map((c) => c.trim().toLowerCase().replace(/\s+/g, '_'));
      rows = rows.slice(1);
    }
    const errors = [];
    let created = 0;
    let updated = 0;
    const pid = req.user.practice_id;
    await db.tx(async () => {
      for (const [i, raw] of rows.entries()) {
        const rec = Object.fromEntries(cols.map((c, j) => [c, (raw[j] ?? '').trim()]));
        const line = i + 1;
        const code = rec.code.toUpperCase();
        if (!/^D\d{4}$/.test(code) && !/^[A-Z0-9.-]{2,12}$/.test(code)) { errors.push(`Row ${line}: "${rec.code}" isn't a procedure code`); continue; }
        const row = {};
        if (rec.description) row.description = rec.description.slice(0, 300);
        if (rec.category) {
          const cat = rec.category.toLowerCase().replace(/[\s-]+/g, '_');
          if (!CATEGORIES.includes(cat)) { errors.push(`Row ${line}: unknown category "${rec.category}"`); continue; }
          row.category = cat;
        }
        if (rec.fee) {
          const fee = Number(rec.fee.replace(/[$,]/g, ''));
          if (!Number.isFinite(fee) || fee < 0) { errors.push(`Row ${line}: fee "${rec.fee}" isn't a number`); continue; }
          row.fee = Math.round(fee * 100);
        }
        if (rec.area) {
          const area = rec.area.toLowerCase();
          if (!AREAS.includes(area)) { errors.push(`Row ${line}: area must be ${AREAS.join(', ')}`); continue; }
          row.area = area;
          row.requires_tooth = area === 'tooth' ? 1 : 0;
        }
        if (rec.time_units) {
          const n = Number(rec.time_units);
          if (!Number.isInteger(n) || n < 0 || n > 96) { errors.push(`Row ${line}: time units must be 0-96`); continue; }
          row.time_units = n;
        }
        const existing = await db.get('SELECT id FROM procedure_codes WHERE practice_id = ? AND code = ?', pid, code);
        if (existing) {
          if (Object.keys(row).length) await update(db, 'procedure_codes', existing.id, pid, row);
          updated++;
        } else {
          if (!row.description || !row.category) { errors.push(`Row ${line}: a new code needs a description and category`); continue; }
          await insert(db, 'procedure_codes', { requires_tooth: 0, requires_surface: 0, fee: 0, ...row, code, practice_id: pid });
          created++;
        }
      }
    });
    await audit(db, req, 'procedure_codes.import', 'procedure_codes', null, { created, updated, errors: errors.length });
    res.json({ created, updated, errors: errors.slice(0, 100) });
  });

  return r;
}
