import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, findOr404, audit, practiceNow } from '../util.js';
import { structured, aiClient } from '../ai.js';
import { canSeePatient } from '../officeaccess.js';
import { CONDITIONS } from './clinical.js';

// The ambient scribe: the chairside conversation (transcribed in the browser) plus what the chart already
// knows becomes a draft clinical note, with the procedures it describes as done or planned and anything a
// complete note usually has that wasn't said. The dentist edits and signs it; nothing is saved until then,
// and the transcript itself is never stored.
const SYSTEM = `You are the clinical scribe for a US dental office. From the conversation recorded in the operatory and the patient's chart, write the clinical note the dentist would write, in the office's own style when a note template is given.
- Record only what was said or is already in the chart; never invent findings, anesthetic amounts, materials, shades or vitals. When something a complete note normally has is missing (anesthetic type and amount, isolation, material, shade, BP, consent, post-op instructions), list it under "missing" instead of guessing.
- The conversation has the dentist, assistant and patient talking together without labels; tell who is speaking from context. Leave out small talk.
- Teeth use Universal numbering (1-32, A-T). Procedures use CDT codes (D0120, D2392 …) with tooth and surfaces.
- Write the note plainly, with short headed sections (e.g. Reason for visit, Medical history, Findings, Treatment, Post-op, Next visit), and keep it as short as the visit allows.
- patient_instructions is plain language the patient can read at home, only when home-care or post-op instructions were given.`;

const TOOL = {
  name: 'write_note',
  description: 'The draft clinical note and what it describes.',
  input_schema: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'The clinical note text.' },
      summary: { type: 'string', description: 'One line: what the visit was.' },
      completed: { type: 'array', description: 'Procedures done at this visit.', items: { $ref: '#/$defs/proc' } },
      planned: { type: 'array', description: 'Treatment recommended for later.', items: { $ref: '#/$defs/proc' } },
      conditions: {
        type: 'array', description: 'Findings to chart on teeth.',
        items: { type: 'object', properties: { tooth: { type: 'string' }, condition: { type: 'string', enum: CONDITIONS }, surfaces: { type: 'string' }, notes: { type: 'string' } }, required: ['tooth', 'condition'] },
      },
      missing: { type: 'array', items: { type: 'string' }, description: 'What a complete note would usually include but wasn’t said.' },
      patient_instructions: { type: 'string' },
      next_visit: { type: 'string', description: 'What the next visit is for, if one was discussed.' },
    },
    required: ['note', 'summary', 'completed', 'planned', 'conditions', 'missing'],
    $defs: {
      proc: { type: 'object', properties: { code: { type: 'string' }, tooth: { type: 'string' }, surfaces: { type: 'string' }, description: { type: 'string' } }, required: ['code'] },
    },
  },
};

const ageOf = (dob, today) => (dob ? Math.floor((Date.parse(today) - Date.parse(dob)) / (365.25 * 86400_000)) : null);

// What the chart already says, for the scribe to build on.
export async function chartContext(db, pid, patientId, appointmentId) {
  const p = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', patientId, pid);
  const today = (await practiceNow(db, pid)).slice(0, 10);
  const visit = appointmentId
    ? await db.get('SELECT a.*, t.name AS type_name FROM appointments a LEFT JOIN appointment_types t ON t.id = a.appointment_type_id WHERE a.id = ? AND a.patient_id = ?', appointmentId, patientId)
    : await db.get(`SELECT a.*, t.name AS type_name FROM appointments a LEFT JOIN appointment_types t ON t.id = a.appointment_type_id
       WHERE a.patient_id = ? AND a.start_time LIKE ? AND a.status NOT IN ('cancelled','no_show') ORDER BY a.start_time LIMIT 1`, patientId, `${today}%`);
  const onVisit = visit ? await db.all("SELECT code, description, tooth, surfaces FROM procedures WHERE appointment_id = ? AND status != 'cancelled'", visit.id) : [];
  const planned = await db.all("SELECT code, description, tooth, surfaces FROM procedures WHERE patient_id = ? AND status = 'planned' ORDER BY id LIMIT 30", patientId);
  const history = await db.all("SELECT code, description, tooth, surfaces, completed_at FROM procedures WHERE patient_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 12", patientId);
  const conditions = await db.all('SELECT tooth, condition, surfaces FROM tooth_conditions WHERE patient_id = ? AND resolved = 0 AND voided_at IS NULL LIMIT 60', patientId);
  const perio = await db.get('SELECT exam_date, readings FROM perio_exams WHERE patient_id = ? ORDER BY exam_date DESC LIMIT 1', patientId);
  let perioLine = null;
  if (perio) {
    const r = JSON.parse(perio.readings || '{}');
    const sites = Object.values(r).flatMap((t) => (t.pd || []).filter((v) => v != null));
    const bleed = Object.values(r).flatMap((t) => (t.bop || []).filter(Boolean)).length;
    perioLine = `${perio.exam_date}: ${sites.filter((v) => v >= 5).length} sites 5mm+, ${sites.filter((v) => v === 4).length} at 4mm, bleeding ${sites.length ? Math.round((100 * bleed) / sites.length) : 0}%`;
  }
  const templates = await db.all('SELECT name, body FROM note_templates WHERE practice_id = ? AND active = 1 ORDER BY id LIMIT 15', pid);
  return {
    today,
    patient: {
      name: `${p.preferred_name || p.first_name} ${p.last_name}`, age: ageOf(p.dob, today), sex: p.gender || null,
      medical_alerts: p.medical_alerts || null, allergies: p.allergies || null, medications: p.medications || null, premedication: !!p.premed_required,
    },
    visit: visit ? { id: visit.id, time: visit.start_time, type: visit.type_name || visit.reason, scheduled_procedures: onVisit } : null,
    planned_treatment: planned, recent_history: history, charted_conditions: conditions, last_perio: perioLine,
    note_templates: templates.map((t) => ({ name: t.name, body: String(t.body).slice(0, 1500) })),
  };
}

export default function scribeRoutes({ db, config }) {
  const r = Router();

  r.get('/scribe', requirePermission('clinical:write'), (_req, res) => res.json({ enabled: !!aiClient(config) }));

  r.post('/scribe/draft', requirePermission('clinical:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const patient = await findOr404(db, 'patients', req.body?.patient_id, pid, 'Patient');
    if (!(await canSeePatient(db, req.user, patient.id))) throw new HttpError(404, 'Patient not found');
    const transcript = String(req.body?.transcript || '').trim();
    if (transcript.length < 20) throw new HttpError(400, 'There’s not enough of the conversation to write a note from');
    if (transcript.length > 80_000) throw new HttpError(400, 'That recording is too long — write a note for each part of the visit');
    const context = await chartContext(db, pid, patient.id, req.body?.appointment_id ? Number(req.body.appointment_id) : null);
    const author = await db.get('SELECT name FROM users WHERE id = ?', req.user.id);
    const started = Date.now();
    const out = await structured(config, {
      system: SYSTEM, tool: TOOL, effort: 'medium',
      content: `Dentist writing the note: ${author?.name || 'the dentist'}.\n\nChart:\n${JSON.stringify(context, null, 1)}\n\nConversation (speech-to-text, unlabeled):\n"""\n${transcript}\n"""`,
    });
    if (out.text !== undefined && !out.note) {
      out.note = out.text;
      Object.assign(out, { summary: '', completed: [], planned: [], conditions: [], missing: [] });
    }
    // Codes the office uses, with its fees; anything else is flagged rather than added.
    const known = async (p) => {
      const code = String(p.code || '').trim().toUpperCase();
      const pc = await db.get('SELECT id, code, description, fee FROM procedure_codes WHERE practice_id = ? AND code = ? AND active = 1', pid, code);
      return { code, tooth: p.tooth ? String(p.tooth).toUpperCase() : null, surfaces: p.surfaces ? String(p.surfaces).toUpperCase() : null, description: pc?.description || p.description || code, fee: pc?.fee ?? null, known: !!pc };
    };
    const draft = {
      note: String(out.note || '').trim(), summary: out.summary || '', missing: out.missing || [], patient_instructions: out.patient_instructions || '',
      next_visit: out.next_visit || '', conditions: (out.conditions || []).map((c) => ({ ...c, tooth: String(c.tooth).toUpperCase() })),
      completed: await Promise.all((out.completed || []).map(known)), planned: await Promise.all((out.planned || []).map(known)),
      appointment_id: context.visit?.id ?? null,
    };
    const minutes = Math.max(0, Math.min(600, Math.round(Number(req.body?.minutes) || 0)));
    const sid = await insert(db, 'scribe_sessions', {
      practice_id: pid, patient_id: patient.id, user_id: req.user.id, appointment_id: draft.appointment_id, minutes, words: transcript.split(/\s+/).length, ms: Date.now() - started,
    });
    await audit(db, req, 'scribe.draft', 'patients', patient.id, { session: sid, minutes });
    res.json({ session_id: sid, ...draft });
  });

  // The note that came of it (for the scribe's own numbers: how many drafts become notes).
  r.post('/scribe/:sid/saved', requirePermission('clinical:write'), async (req, res) => {
    const s = await findOr404(db, 'scribe_sessions', req.params.sid, req.user.practice_id, 'Session');
    const note = req.body?.note_id ? await findOr404(db, 'clinical_notes', req.body.note_id, req.user.practice_id, 'Note') : null;
    await db.run('UPDATE scribe_sessions SET note_id = ?, edited = ? WHERE id = ?', note?.id ?? null, req.body?.edited ? 1 : 0, s.id);
    // The chain for the record: the AI scribe drafted it, this person reviewed (and maybe edited) and saved it.
    if (note) await audit(db, req, 'note.ai_draft_approved', 'clinical_notes', note.id, { drafted_by: 'AI scribe', approved_by: req.user.name, edited_before_saving: !!req.body?.edited, scribe_session: s.id }, { patientId: note.patient_id });
    res.json({ ok: true });
  });

  return r;
}
