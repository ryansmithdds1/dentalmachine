import { createHash } from 'node:crypto';
import { raiseIssue, resolveIssue } from './issues.js';
import { withActor } from './actor.js';
import { audit } from './util.js';
import { structured, aiClient } from './ai.js';
import { log } from './monitoring.js';
import { quickFill } from './notedictation.js';
import { DENTAL_TERMS, mergeNote } from './routes/charting.js';
import { teethIn, surfacesIn, familyOf, FAMILIES } from './chartaudit.js';

// Long recordings (LR1-LR3, docs/workflows/specs/LR-long-recording.md): a whole exam or procedure, 60-90+ minutes,
// recorded in ~30-second chunks that upload as they go. Each chunk is a complete little audio file (the browser
// restarts its recorder every 30 seconds), stored encrypted like documents, transcribed on its own and merged by
// time — so a 90-minute visit never has to go to the speech service in one piece, a failure costs one chunk's
// retry, and a dropped connection loses nothing. The transcript (numbered lines, speakers) becomes a draft note in
// the office's template with each item pointing at the line it came from, plus suggested charting and codes.
// The clinician reviews, edits and signs; nothing is charted or signed from here (rule 10).

export const CHUNK_SECONDS = 30;
export const MAX_CHUNK_BYTES = 10 * 1024 * 1024;
export const MAX_ATTEMPTS = 5;

// ---- The speech service: separate speakers when it can ----
// TRANSCRIBE=deepgram (DEEPGRAM_API_KEY): the medical model with diarization, primed with dental words.
// TRANSCRIBE=sandbox: deterministic; a test chunk whose bytes are "SANDBOX\n<speaker>|<seconds>|<text>" lines is
// read back as those lines, anything else gives a short canned exchange. Otherwise, a server dictation adapter
// without speaker separation is used (speakers are then guessed and labelled as guesses); none → not available.
export function createExamTranscriber({ config = {}, fetchImpl = globalThis.fetch, transcriber = null } = {}) {
  const mode = config.examTranscribe || config.transcribe;
  if (mode === 'sandbox') {
    return {
      mode, diarizes: true,
      async transcribe(audio) {
        const text = Buffer.from(audio).toString('utf8');
        if (text.startsWith('SANDBOX-FAIL')) throw new Error('Sandbox transcription failure');
        if (text.startsWith('SANDBOX\n')) {
          const utterances = text.split('\n').slice(1).filter(Boolean).map((l) => {
            const [speaker, at, ...rest] = l.split('|');
            return { speaker: Number(speaker) || 0, start: Number(at) || 0, end: (Number(at) || 0) + 3, text: rest.join('|').trim() };
          });
          return { utterances, diarized: true };
        }
        return { utterances: [{ speaker: 0, start: 0, end: 4, text: 'Open a little wider for me.' }, { speaker: 1, start: 5, end: 7, text: 'Okay.' }], diarized: true };
      },
    };
  }
  if (mode === 'deepgram' && config.deepgramKey) {
    return {
      mode, diarizes: true,
      async transcribe(audio, { contentType = 'audio/webm', keyterms = [] } = {}) {
        const q = new URLSearchParams({ model: 'nova-3-medical', smart_format: 'true', numerals: 'true', diarize: 'true', utterances: 'true' });
        for (const k of keyterms.slice(0, 100)) q.append('keyterm', k);
        const res = await fetchImpl(`https://api.deepgram.com/v1/listen?${q}`, { method: 'POST', headers: { Authorization: `Token ${config.deepgramKey}`, 'Content-Type': contentType }, body: audio });
        if (!res.ok) throw new Error(`Deepgram error ${res.status}`);
        const data = await res.json();
        const utt = data.results?.utterances || [];
        if (utt.length) return { utterances: utt.map((u) => ({ speaker: u.speaker ?? 0, start: u.start, end: u.end, text: u.transcript })), diarized: true };
        const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
        return { utterances: text ? [{ speaker: null, start: 0, end: CHUNK_SECONDS, text }] : [], diarized: false };
      },
    };
  }
  if (transcriber?.dictation) {
    return {
      mode: transcriber.mode || 'dictation', diarizes: false,
      async transcribe(audio, opts) {
        const text = await transcriber.dictation(audio, opts);
        return { utterances: text ? [{ speaker: null, start: 0, end: CHUNK_SECONDS, text }] : [], diarized: false };
      },
    };
  }
  return null;
}

// ---- Speakers ----
// Who is who: the speech service separates voices (speaker 0, 1, 2) but can't name them, and without it there is
// only text. Roles come from what is said — the dentist names teeth, findings and treatment; the patient answers in
// the first person; the assistant hands things over and reads back numbers. Always labelled as a guess.
const DOCTOR_WORDS = /\b(caries|decay|recommend|crown|root canal|extraction|implant|periapical|fracture|restoration|composite|anesthetic|lidocaine|articaine|carpule|occlusal|mesial|distal|buccal|lingual|tooth|number \d|#\d|radiograph|x-?ray|diagnos\w*|prognosis|treatment|option|risk|we (should|could|need)|i('d| would) recommend|let'?s)\b/gi;
const PATIENT_WORDS = /\b(i('m| am| have| feel| think| don'?t| want| was)|my|it hurts|hurts|sore|yes|yeah|no|okay|ok|how much|does insurance|will it|can i|sounds good|thank you)\b/gi;
const ASSISTANT_WORDS = /\b(suction|here you go|cotton|rinse|shade|i'?ll get|charting|got it|recorded|reading|bite down|dr\.?|doctor|three[, ]+two|two[, ]+three)\b/gi;
const score = (text, re) => (String(text).match(re) || []).length;
export function roleOf(text) {
  const d = score(text, DOCTOR_WORDS);
  const p = score(text, PATIENT_WORDS);
  const a = score(text, ASSISTANT_WORDS);
  if (a > d && a >= p && a > 0) return 'Assistant';
  if (p > d && p > 0) return 'Patient';
  return d > 0 ? 'Doctor' : p > 0 ? 'Patient' : 'Doctor';
}
// Roles for the separated speakers of one chunk: the most clinical voice is the doctor, the most first-person the patient.
export function assignRoles(utterances) {
  const ids = [...new Set(utterances.map((u) => u.speaker).filter((s) => s != null))];
  const text = (id) => utterances.filter((u) => u.speaker === id).map((u) => u.text).join(' ');
  const roles = new Map();
  if (!ids.length) return roles;
  const byDoctor = [...ids].sort((a, b) => score(text(b), DOCTOR_WORDS) - score(text(a), DOCTOR_WORDS));
  roles.set(byDoctor[0], 'Doctor');
  const rest = ids.filter((i) => i !== byDoctor[0]).sort((a, b) => (score(text(b), PATIENT_WORDS) - score(text(b), ASSISTANT_WORDS)) - (score(text(a), PATIENT_WORDS) - score(text(a), ASSISTANT_WORDS)));
  if (rest.length) roles.set(rest[0], 'Patient');
  for (const i of rest.slice(1)) roles.set(i, 'Assistant');
  return roles;
}

// Chunks' transcripts → one transcript with numbered lines on the visit's clock. parts: [{ seq, start_ms, utterances, diarized }].
export function mergeTranscripts(parts) {
  const lines = [];
  let diarized = parts.length > 0;
  for (const part of [...parts].sort((a, b) => a.seq - b.seq)) {
    if (!part.diarized) diarized = false;
    const roles = part.diarized ? assignRoles(part.utterances) : null;
    // Speech without timing (a whole chunk as one piece of text) is split into sentences spread across the chunk.
    const pieces = part.utterances.flatMap((u) => {
      if (part.diarized || !/[.!?]\s/.test(u.text)) return [u];
      const s = u.text.match(/[^.!?]+[.!?]?/g).map((x) => x.trim()).filter(Boolean);
      return s.map((text, i) => ({ ...u, text, start: u.start + ((u.end - u.start) * i) / s.length }));
    });
    for (const u of pieces.sort((a, b) => a.start - b.start)) {
      const text = String(u.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const t = Math.round(part.start_ms + u.start * 1000);
      const prev = lines[lines.length - 1];
      // The same words twice across a chunk boundary (a recorder restart can repeat a syllable's worth) are one line.
      if (prev && prev.text === text && Math.abs(prev.t - t) < 3000) continue;
      lines.push({ n: lines.length + 1, t, speaker: roles?.get(u.speaker) || roleOf(text), guessed: true, separated: !!part.diarized, text });
    }
  }
  return { lines, speakers: diarized ? 'separated' : 'guessed' };
}
export const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

// ---- The draft note ----
// Sections of the office's note, each item with the transcript line(s) it came from.
export const SECTIONS = [
  ['findings', 'Findings by tooth'], ['perio', 'Periodontal readings'], ['treatment', 'Treatment discussed'], ['options', 'Options and patient’s decision'],
  ['consent', 'Consent / informed refusal'], ['anesthetic', 'Anesthetic'], ['materials', 'Materials'], ['postop', 'Post-op instructions'],
];
const FINDING = /\b(caries|carious|decay|cavity|fractur\w*|crack\w*|abscess|mobility|mobile|recession|missing|watch|lesion|sensitiv\w*|pain|periapical|bone loss|calculus|leak\w*|open margin|wear|abfraction|erosion|chipped|broken|failing|defective|impacted|inflamed|swelling)\b/i;
const PERIO = /\b(pockets?|probing|probe|perio(dontal)?|bleeding|bop|recession|furcation|mobility)\b/i;
const TREATMENT = /\b(recommend\w*|you need|you'?ll need|we should|we need|treatment|plan)\b/i;
const OPTIONS = /\b(options?|alternative\w*|or we could|either|instead)\b/i;
const DECISION = /\b(let'?s do|go ahead|i'?ll (do|go with|take)|i want|i'?d like|sounds good|not (right )?now|wait|think about it|i'?ll pass|no thanks|decline\w*|agree\w*|schedule it)\b/i;
const CONSENT = /\b(consent|risks?|benefits?|alternatives?|any questions|do you understand|understand\w*|declin\w*|refus\w*)\b/i;
const ANESTHETIC = /\b(lidocaine|articaine|septocaine|mepivacaine|carbocaine|prilocaine|citanest|bupivacaine|marcaine|carpules?|cartridges?|numb\w*|block|infiltrat\w*|topical|anesthe\w*)\b/i;
const MATERIALS = /\b(composite|shade [a-d]\d(\.5)?|amalgam|zirconia|e\.?max|bond\w*|etch\w*|liner|vitrebond|cement\w*|relyx|fuji|temp ?bond|temporary|gutta|sutures?|chromic|gelfoam|glass ionomer|flowable|impression|scan)\b/i;
const POSTOP = /\b(post-?\s?op\w*|ice|ibuprofen|tylenol|acetaminophen|don'?t (eat|chew|drink)|avoid|soft (food|diet)|gauze|bleeding|call (us|the office)|spit|straw|rinse|salt water|numb for)\b/i;
const PLANNING = /\b(recommend\w*|next (time|visit|appointment)|will need|you need|we should|plan|option|later|future|schedule|come back)\b/i;
const DONE = /\b(placed|placing|restor\w*|prepp?(ed|ing)|seat(ed|ing)|cement(ed|ing)|extract(ed|ing)|remov(ed|ing)|done|finished|complete\w*|scal(ed|ing)|polish\w*|appl(ied|ying)|fill(ed|ing)|took|taking|seal(ed|ing)|bond(ed|ing)|sutur\w*)\b/i;

// The office's default code for each kind of work (the clinician confirms each one; unknown codes are flagged).
function codeFor(family, { tooth, surfaces, text }) {
  const t = Number(tooth);
  const n = surfaces ? surfaces.length : 1;
  const anterior = (t >= 6 && t <= 11) || (t >= 22 && t <= 27);
  switch (family) {
    case 'restoration': return /amalgam|alloy/i.test(text) ? `D21${[4, 5, 6, 6, 6][n - 1] ?? 6}${n >= 4 ? 1 : 0}` : anterior ? `D233${Math.min(n, 3) - 1}` : `D239${Math.min(n, 4)}`;
    case 'crown': return 'D2740';
    case 'buildup': return 'D2950';
    case 'endo': return anterior ? 'D3310' : (t >= 4 && t <= 5) || (t >= 12 && t <= 13) || (t >= 20 && t <= 21) || (t >= 28 && t <= 29) ? 'D3320' : 'D3330';
    case 'extraction': return /bone|surgical|section/i.test(text) ? 'D7210' : 'D7140';
    case 'sealant': return 'D1351';
    case 'fluoride': return 'D1206';
    case 'prophy': return 'D1110';
    case 'srp': return 'D4341';
    case 'perio_maint': return 'D4910';
    case 'xray': return /bite ?wing|bwx?/i.test(text) ? 'D0274' : /pano/i.test(text) ? 'D0330' : /fmx|full (mouth|series)/i.test(text) ? 'D0210' : 'D0220';
    case 'exam': return /comprehensive|new patient/i.test(text) ? 'D0150' : /limited|emergency|problem/i.test(text) ? 'D0140' : 'D0120';
    case 'nitrous': return 'D9230';
    case 'guard': return 'D9944';
    case 'implant': return 'D6010';
    case 'veneer': return 'D2962';
    default: return null;
  }
}

// The rules draft: reads each line for what a complete note needs. Deterministic (tests, and when AI is off).
export function extractFromTranscript(lines) {
  const sections = Object.fromEntries(SECTIONS.map(([k]) => [k, []]));
  const suggested = [];
  const add = (key, line, extra = {}) => {
    const text = line.text;
    const had = sections[key].find((i) => i.text === text);
    if (had) return;
    sections[key].push({ text, lines: [line.n], speaker: line.speaker, ...extra });
  };
  for (const line of lines) {
    const text = line.text;
    const teeth = [...teethIn(text.replace(/\bnumber\s+(\d+)/gi, '#$1'))];
    // "No caries", "without mobility": a negative isn't a finding (the rest of that clause is dropped).
    const positive = text.replace(/\b(no|not|without|negative for|free of|denies)\b[^.,;]*/gi, '');
    if (teeth.length && FINDING.test(positive) && line.speaker !== 'Patient') add('findings', line, { teeth });
    const readings = [...text.matchAll(/\b(\d{1,2})(?:[\s,]+(\d{1,2})){2,5}\b/g)].map((m) => m[0].split(/[\s,]+/).map(Number)).filter((r) => r.every((v) => v <= 15));
    if (PERIO.test(text) || (readings.length && lines.some((l) => Math.abs(l.n - line.n) <= 3 && PERIO.test(l.text)))) {
      if (readings.length || PERIO.test(text)) add('perio', line, { teeth, readings });
    }
    if (TREATMENT.test(text) && line.speaker !== 'Patient') add('treatment', line, { teeth });
    if (OPTIONS.test(text)) add('options', line);
    if (DECISION.test(text) && line.speaker === 'Patient') add('options', line, { decision: true });
    if (CONSENT.test(text)) add('consent', line);
    if (ANESTHETIC.test(text)) add('anesthetic', line);
    if (MATERIALS.test(text)) add('materials', line);
    if (POSTOP.test(text) && line.speaker !== 'Patient') add('postop', line);
    // Suggested charting: work named with a tooth (or a whole-mouth service), done now or planned.
    if (line.speaker === 'Patient') continue;
    for (const f of FAMILIES) {
      if (!f.words.test(text)) continue;
      const planned = PLANNING.test(text) && !DONE.test(text);
      if (!planned && !DONE.test(text) && !['exam', 'xray', 'prophy', 'fluoride'].includes(f.key)) continue;
      const surfaces = surfacesIn(text).find((s) => s.length > 1 || /[MODBLFI]/.test(s)) || null;
      const targets = teeth.length ? teeth : [null];
      for (const tooth of targets) {
        const code = codeFor(f.key, { tooth, surfaces, text });
        if (!code || (familyOf(code)?.key !== f.key && f.key !== 'restoration')) continue;
        const status = planned ? 'planned' : 'completed';
        const same = suggested.find((s) => s.code === code && s.tooth === tooth && s.status === status);
        if (same) { if (!same.lines.includes(line.n)) same.lines.push(line.n); continue; }
        suggested.push({ code, tooth, surfaces: tooth ? surfaces : null, status, lines: [line.n], why: text.slice(0, 160) });
      }
      break;
    }
  }
  return { sections, suggested };
}

// With AI on: each window of the transcript is read for the same sections (with line numbers), then merged.
const DRAFT_TOOL = {
  name: 'exam_note',
  description: 'What a complete dental note needs, from the transcript, each with the line numbers it came from.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            section: { type: 'string', enum: SECTIONS.map(([k]) => k) },
            text: { type: 'string', description: 'Clinical wording for the note (short).' },
            lines: { type: 'array', items: { type: 'integer' } },
            teeth: { type: 'array', items: { type: 'string' } },
          },
          required: ['section', 'text', 'lines'],
        },
      },
      suggested: {
        type: 'array',
        items: {
          type: 'object',
          properties: { code: { type: 'string' }, tooth: { type: 'string' }, surfaces: { type: 'string' }, status: { type: 'string', enum: ['completed', 'planned'] }, lines: { type: 'array', items: { type: 'integer' } } },
          required: ['code', 'status', 'lines'],
        },
      },
    },
    required: ['items', 'suggested'],
  },
};
const DRAFT_SYSTEM = `You turn part of a transcript of a whole dental exam or procedure into the items of a clinical note. Lines look like "L12 [03:40] Doctor: …" (speaker names are guesses).
- Use only what was said. Never invent findings, amounts, materials or shades.
- For each item give the line numbers it came from. Sections: findings (by tooth), perio (readings), treatment (what was recommended), options (alternatives and the patient's decision), consent (risks/benefits explained, consent or refusal), anesthetic (type, amount, site), materials, postop (instructions given).
- suggested: CDT codes for work done in this part (status completed) or recommended (status planned), with tooth and surfaces, and the lines. Universal tooth numbering.`;

export function windows(lines, maxChars = 20_000) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const l of lines) {
    const s = `L${l.n} [${clock(l.t)}] ${l.speaker}: ${l.text}`;
    if (size + s.length > maxChars && cur.length) { out.push(cur); cur = []; size = 0; }
    cur.push(s);
    size += s.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function aiExtract(config, lines) {
  const sections = Object.fromEntries(SECTIONS.map(([k]) => [k, []]));
  const suggested = [];
  const valid = new Set(lines.map((l) => l.n));
  for (const w of windows(lines)) {
    const out = await structured(config, { system: DRAFT_SYSTEM, tool: DRAFT_TOOL, effort: 'medium', maxTokens: 8000, content: w.join('\n') });
    for (const i of out.items || []) {
      const refs = (i.lines || []).map(Number).filter((n) => valid.has(n));
      if (!sections[i.section] || !refs.length || !i.text) continue;
      if (!sections[i.section].some((x) => x.text.toLowerCase() === String(i.text).toLowerCase())) sections[i.section].push({ text: String(i.text).slice(0, 400), lines: refs, teeth: i.teeth || [] });
    }
    for (const s of out.suggested || []) {
      const refs = (s.lines || []).map(Number).filter((n) => valid.has(n));
      if (!refs.length || !/^D\d{4}$/i.test(s.code || '')) continue;
      const tooth = s.tooth ? String(s.tooth).toUpperCase() : null;
      const status = s.status === 'planned' ? 'planned' : 'completed';
      if (suggested.some((x) => x.code === s.code.toUpperCase() && x.tooth === tooth && x.status === status)) continue;
      suggested.push({ code: s.code.toUpperCase(), tooth, surfaces: s.surfaces ? String(s.surfaces).toUpperCase() : null, status, lines: refs });
    }
  }
  return { sections, suggested };
}

// The draft: the office's template for the work (answers filled from what was said), then each section.
export async function buildDraft(db, config, session, transcript, { useAi = true } = {}) {
  const pid = session.practice_id;
  const lines = transcript.lines;
  let extracted;
  let by = 'rules';
  if (useAi && aiClient(config) && config.examTranscribe !== 'sandbox' && config.transcribe !== 'sandbox') {
    try {
      extracted = await aiExtract(config, lines);
      by = 'ai';
    } catch (err) {
      log.warn('Long recording AI draft failed; using the rules draft', err);
    }
  }
  extracted ??= extractFromTranscript(lines);
  // Codes the office uses, with descriptions; anything else is flagged, not added.
  const known = async (s) => {
    const pc = await db.get('SELECT code, description, fee, category FROM procedure_codes WHERE practice_id = ? AND code = ? AND active = 1', pid, s.code);
    return { ...s, description: pc?.description || s.code, fee: pc?.fee ?? null, known: !!pc };
  };
  const suggested = [];
  for (const s of extracted.suggested) suggested.push(await known(s));
  // The office's template(s) for the visit's work: its scheduled procedures and the work heard.
  const visitProcs = session.appointment_id ? await db.all("SELECT code, tooth, surfaces, area FROM procedures WHERE appointment_id = ? AND status != 'cancelled'", session.appointment_id) : [];
  const procs = [...visitProcs, ...suggested.filter((s) => s.status === 'completed').map((s) => ({ code: s.code, tooth: s.tooth, surfaces: s.surfaces }))];
  const codes = [...new Set(procs.map((p) => p.code))];
  const templates = (await db.all('SELECT name, codes, body FROM note_templates WHERE practice_id = ? AND active = 1 ORDER BY id', pid))
    .filter((t) => String(t.codes || '').toUpperCase().split(/[\s,]+/).filter(Boolean).some((c) => codes.some((code) => code.startsWith(c))));
  const patient = await db.get('SELECT first_name, last_name, allergies, medications FROM patients WHERE id = ?', session.patient_id);
  const date = String(session.created_at || new Date().toISOString()).slice(0, 10);
  const said = lines.map((l) => l.text).join(' ');
  const filled = templates.map((t) => quickFill(mergeNote(t.body, { patient, date, procedures: procs, vitals: null }), said));
  const parts = filled.map((f) => f.body);
  const sections = SECTIONS.map(([key, title]) => ({ key, title, items: extracted.sections[key] || [] }));
  for (const s of sections) {
    if (!s.items.length) continue;
    parts.push(`${s.title}:\n${s.items.map((i) => `- ${i.speaker === 'Patient' ? `Patient: “${i.text}”` : i.text}`).join('\n')}`);
  }
  // What a complete note usually has that wasn't heard (listed, never guessed).
  const missing = [];
  const needsAnesthetic = procs.some((p) => /^D(2[1-4]|3|7|6[0-1])/.test(p.code));
  if (needsAnesthetic && !sections.find((s) => s.key === 'anesthetic').items.length) missing.push('Anesthetic type, amount and site');
  if (procs.some((p) => /^D(7|60)/.test(p.code)) && !sections.find((s) => s.key === 'postop').items.length) missing.push('Post-op instructions');
  if (sections.find((s) => s.key === 'treatment').items.length && !sections.find((s) => s.key === 'consent').items.length) missing.push('Consent or informed refusal for the treatment discussed');
  for (const f of filled) missing.push(...f.unanswered.map((u) => `Template: ${u}`));
  return {
    note: parts.join('\n\n').trim() || 'Nothing in the recording could be turned into a note — write it from the transcript.',
    sections, suggested, templates: templates.map((t) => t.name), missing: [...new Set(missing)], by, speakers: transcript.speakers, lines: lines.length,
  };
}

// ---- Storage helpers ----
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = async (storage, key, encrypted) => JSON.parse(Buffer.from(await storage.read(key, !!encrypted)).toString('utf8'));
export async function readTranscript(storage, session) {
  if (!session.transcript_key) return null;
  return readJson(storage, session.transcript_key, session.transcript_encrypted);
}
async function keyterms(db, pid) {
  const words = (await db.all('SELECT description FROM procedure_codes WHERE practice_id = ? AND active = 1', pid)).flatMap((c) => c.description.split(/[\s,/]+/)).filter((w) => /^[a-z]{5,}$/i.test(w));
  return [...new Set([...DENTAL_TERMS, ...words])].slice(0, 100);
}
const backoffMinutes = (attempts) => Math.min(24 * 60, 5 * 3 ** Math.max(0, attempts - 1)); // 5, 15, 45, 135 … minutes
const utcText = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

// ---- Transcribing a finished recording ----
// Claims the session (so two workers can't both run it), transcribes the chunks not yet done (a retry picks up
// where the last attempt stopped), merges, saves the transcript encrypted and builds the draft. A failure marks the
// session failed with the next retry time and puts it in Needs attention; success clears that item.
export async function processRecording(db, { storage, examTranscriber, config = {} }, sessionId) {
  const claimed = await db.run("UPDATE recording_sessions SET status = 'transcribing' WHERE id = ? AND status IN ('uploaded','failed')", sessionId);
  if (!claimed.changes) return null;
  const session = await db.get('SELECT * FROM recording_sessions WHERE id = ?', sessionId);
  const issueKey = `recording-transcribe:${session.id}`;
  return withActor({ source: 'automation', actor: 'Long recording transcription', practiceId: session.practice_id, userId: null }, async () => {
    try {
      if (!examTranscriber) throw new Error('No transcription service is set up (TRANSCRIBE)');
      const terms = await keyterms(db, session.practice_id);
      const chunks = await db.all('SELECT * FROM recording_chunks WHERE session_id = ? ORDER BY seq', session.id);
      for (const c of chunks) {
        if (c.transcript_key) continue;
        const audio = await storage.read(c.storage_key, !!c.encrypted);
        if (!audio) throw new Error(`Audio for part ${c.seq + 1} is missing`);
        const out = await examTranscriber.transcribe(audio, { contentType: c.mime || session.mime || 'audio/webm', keyterms: terms });
        const saved = await storage.save(session.practice_id, Buffer.from(JSON.stringify(out)));
        await db.run('UPDATE recording_chunks SET transcript_key = ?, transcript_encrypted = ? WHERE id = ?', saved.storageKey, saved.encrypted ? 1 : 0, c.id);
      }
      const parts = [];
      for (const c of await db.all('SELECT * FROM recording_chunks WHERE session_id = ? ORDER BY seq', session.id)) {
        const out = await readJson(storage, c.transcript_key, c.transcript_encrypted);
        parts.push({ seq: c.seq, start_ms: c.start_ms, utterances: out.utterances || [], diarized: !!out.diarized });
      }
      const transcript = mergeTranscripts(parts);
      const saved = await storage.save(session.practice_id, Buffer.from(JSON.stringify(transcript)));
      const draft = await buildDraft(db, config, session, transcript);
      await db.run(
        "UPDATE recording_sessions SET status = 'transcribed', transcript_key = ?, transcript_encrypted = ?, transcript_lines = ?, speakers = ?, draft = ?, transcribed_at = datetime('now'), last_error = NULL, next_attempt_at = NULL WHERE id = ?",
        saved.storageKey, saved.encrypted ? 1 : 0, transcript.lines.length, transcript.speakers, JSON.stringify(draft), session.id,
      );
      await audit(db, null, 'recording.transcribed', 'recording_sessions', session.id, { lines: transcript.lines.length, chunks: parts.length, speakers: transcript.speakers, draft_by: draft.by }, { patientId: session.patient_id });
      await resolveIssue(db, session.practice_id, issueKey, 'Transcribed on a later attempt');
      return { lines: transcript.lines.length };
    } catch (err) {
      const attempts = session.attempts + 1;
      const next = attempts < MAX_ATTEMPTS ? utcText(new Date(Date.now() + backoffMinutes(attempts) * 60_000)) : null;
      await db.run("UPDATE recording_sessions SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?", attempts, String(err.message).slice(0, 500), next, session.id);
      await raiseIssue(db, {
        practiceId: session.practice_id, kind: 'ai', key: issueKey, role: 'clinical', entity: 'recording_sessions', entityId: session.id, patientId: session.patient_id,
        title: next ? 'A long visit recording couldn’t be transcribed yet — it will try again' : 'A long visit recording couldn’t be transcribed — retry it from the patient’s notes',
        detail: err.message, severity: next ? 'normal' : 'high',
      });
      return { error: err.message };
    }
  });
}

// ---- Scheduled work: retries, stuck recordings and retention ----
export async function runRecordingJobs(db, deps, { now = new Date() } = {}) {
  const due = await db.all(
    `SELECT id FROM recording_sessions WHERE (status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
       OR (status = 'uploaded' AND finished_at <= ?) ORDER BY id LIMIT 20`, utcText(now), utcText(new Date(now.getTime() - 10 * 60_000)),
  );
  const done = [];
  for (const s of due) done.push({ id: s.id, ...(await processRecording(db, deps, s.id)) });
  const purged = await runRecordingRetention(db, deps, { now });
  return { transcribed: done, purged };
}

// Removes a recording's audio and transcript for good: the source recording (and what was heard) isn't part of
// the legal record — the clinician's signed note is, and it stays. The blobs are deleted when the storage can
// delete; the rows stay (without keys) as the record that a recording existed and was removed, and why.
export async function purgeRecording(db, storage, session, reason) {
  const chunks = await db.all('SELECT id, storage_key, transcript_key FROM recording_chunks WHERE session_id = ?', session.id);
  let removed = 0;
  for (const key of [...chunks.flatMap((c) => [c.storage_key, c.transcript_key]), session.transcript_key].filter(Boolean)) {
    if (typeof storage?.remove === 'function') {
      await storage.remove(key);
      removed++;
    }
  }
  await db.run("UPDATE recording_chunks SET storage_key = NULL, transcript_key = NULL, purged_at = datetime('now') WHERE session_id = ?", session.id);
  // Scratch/derived: the draft built from the transcript goes with it (the note the clinician saved is untouched).
  await db.run("UPDATE recording_sessions SET transcript_key = NULL, draft = NULL, purged_at = datetime('now') WHERE id = ?", session.id);
  return { chunks: chunks.length, files_removed: removed, reason };
}

export async function runRecordingRetention(db, { storage }, { now = new Date() } = {}) {
  const out = [];
  for (const p of await db.all('SELECT id, recording_retention_days FROM practices')) {
    const days = Math.max(1, p.recording_retention_days || 90);
    const cutoff = utcText(new Date(now.getTime() - days * 86400_000));
    // Kept past the retention date while the note made from it is still unsigned: the doctor may still need it.
    const due = await db.all(
      `SELECT s.* FROM recording_sessions s LEFT JOIN clinical_notes n ON n.id = s.note_id
       WHERE s.practice_id = ? AND s.purged_at IS NULL AND s.status NOT IN ('recording','paused','transcribing') AND COALESCE(s.finished_at, s.created_at) < ? AND (s.note_id IS NULL OR n.signed = 1)`,
      p.id, cutoff,
    );
    // Recordings left unfinished (the browser never came back) go after the same time.
    due.push(...await db.all("SELECT * FROM recording_sessions WHERE practice_id = ? AND purged_at IS NULL AND status IN ('recording','paused') AND created_at < ?", p.id, cutoff));
    for (const s of due) {
      await withActor({ source: 'automation', actor: 'Recording retention', practiceId: p.id, userId: null }, async () => {
        const r = await purgeRecording(db, storage, s, `Kept ${days} days (the office’s retention setting)`);
        await db.run("UPDATE recording_sessions SET status = 'purged' WHERE id = ?", s.id);
        await audit(db, null, 'recording.purged', 'recording_sessions', s.id, { ...r, retention_days: days }, { patientId: s.patient_id, reason: r.reason, source: 'automation', before: { status: s.status }, after: { status: 'purged' } });
      });
      out.push(s.id);
    }
  }
  return out;
}
