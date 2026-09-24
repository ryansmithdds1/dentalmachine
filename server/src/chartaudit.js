import { createHash } from 'node:crypto';
import { zonedToUtc } from './util.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { log } from './monitoring.js';

// Chart audit: protect the doctor (CA1-CA4, docs/workflows/specs/CA-chart-audit.md).
// Every completed visit is checked against what a defensible chart has: a signed note by the person who did the
// work that describes what was charted and billed (same teeth and surfaces), anesthetic details, x-ray readings,
// consent, a current medical history, BP where the office wants it, informed refusal, post-op instructions, perio
// charting and prescriptions. Each check is a small pure function over the visit's facts, so it can be tested on
// its own and run the same way nightly (every visit) and on demand ("Check my chart", one visit).
//
// Findings are derived rows (chart_audit_findings): recomputed, updated in place while the problem lasts, marked
// resolved (with resolved_at) once the chart is fixed, and never deleted. Nothing here edits or signs a note: the
// fix is always a person's (an addendum for a signed note, rule 3). The AI only reads (ai/notecompare.js).

// ---- What the office can tune (chart_audit_rules.settings is merged over this) ----
export const DEFAULT_RULES = {
  checks: {
    no_note: true, unsigned_note: true, signed_by_other: true, proc_not_in_note: true, work_not_charted: true, tooth_mismatch: true,
    anesthetic_details: true, xray_interpretation: true, consent_missing: true, medical_history: true, blood_pressure: true,
    informed_refusal: true, postop_missing: true, perio_overdue: true, rx_not_noted: true, scheduled_not_done: true,
  },
  unsigned_grace_days: 1, // a note may wait this many days for its signature before it's flagged
  unsigned_high_days: 7, // unsigned longer than this is high risk
  medical_history_days: 365, // medical history must have been reviewed within this many days of the visit
  perio_interval_days: 365, // full perio charting at least this often (adults, at exam/hygiene visits)
  consent_valid_days: 365, // a signed consent covers treatment this many days after it was signed
  lookback_days: 365, // how far back the nightly pass looks
  bp_required: 'anesthesia', // 'every_visit' | 'anesthesia' (visits with local anesthetic) | 'never'
  consent_categories: ['oral_surgery', 'endodontics', 'implants'],
  consent_codes: [],
  anesthetic_categories: ['restorative', 'endodontics', 'oral_surgery', 'implants'],
  anesthetic_codes: ['D4341', 'D4342'],
  anesthetic_exempt_codes: ['D2950', 'D2954', 'D2962'],
  postop_categories: ['oral_surgery', 'implants'],
  perio_codes: ['D0120', 'D0150', 'D0180', 'D1110', 'D4910'],
  ai_compare: true, // with AI on for the server, wording the keyword match can't place goes to the AI
};
export const CATEGORIES = ['diagnostic', 'preventive', 'restorative', 'endodontics', 'periodontics', 'prosthodontics', 'oral_surgery', 'orthodontics', 'implants', 'adjunctive'];
const BP_MODES = ['every_visit', 'anesthesia', 'never'];

// Validates and merges an office's settings over the defaults. Unknown keys are dropped; impossible values refused.
export function cleanRules(input = {}, base = DEFAULT_RULES) {
  const out = structuredClone(base);
  const bad = (msg) => { throw Object.assign(new Error(msg), { status: 400 }); };
  if (input.checks != null) {
    if (typeof input.checks !== 'object') bad('checks must be an object');
    for (const [k, v] of Object.entries(input.checks)) {
      if (!(k in DEFAULT_RULES.checks)) bad(`Unknown check: ${k}`);
      out.checks[k] = !!v;
    }
  }
  const days = (k, min, max) => {
    if (input[k] == null) return;
    const n = Number(input[k]);
    if (!Number.isInteger(n) || n < min || n > max) bad(`${k} must be a whole number from ${min} to ${max}`);
    out[k] = n;
  };
  days('unsigned_grace_days', 0, 30);
  days('unsigned_high_days', 1, 365);
  days('medical_history_days', 30, 1095);
  days('perio_interval_days', 90, 1095);
  days('consent_valid_days', 1, 1095);
  days('lookback_days', 7, 1095);
  if (input.bp_required != null) {
    if (!BP_MODES.includes(input.bp_required)) bad(`bp_required must be one of: ${BP_MODES.join(', ')}`);
    out.bp_required = input.bp_required;
  }
  for (const k of ['consent_categories', 'anesthetic_categories', 'postop_categories']) {
    if (input[k] == null) continue;
    if (!Array.isArray(input[k]) || input[k].some((c) => !CATEGORIES.includes(c))) bad(`${k} must be a list of: ${CATEGORIES.join(', ')}`);
    out[k] = [...new Set(input[k])];
  }
  for (const k of ['consent_codes', 'anesthetic_codes', 'anesthetic_exempt_codes', 'perio_codes']) {
    if (input[k] == null) continue;
    const list = Array.isArray(input[k]) ? input[k] : String(input[k]).split(/[\s,]+/);
    const codes = list.map((c) => String(c).trim().toUpperCase()).filter(Boolean);
    if (codes.some((c) => !/^D\d{4}$/.test(c))) bad(`${k} must be CDT codes like D7140`);
    out[k] = [...new Set(codes)].slice(0, 200);
  }
  if (input.ai_compare != null) out.ai_compare = !!input.ai_compare;
  if (out.unsigned_high_days < out.unsigned_grace_days) bad('unsigned_high_days must be at least unsigned_grace_days');
  return out;
}

export async function rulesFor(db, practiceId) {
  const row = await db.get('SELECT settings FROM chart_audit_rules WHERE practice_id = ?', practiceId);
  if (!row) return structuredClone(DEFAULT_RULES);
  try {
    return cleanRules(JSON.parse(row.settings));
  } catch {
    return structuredClone(DEFAULT_RULES);
  }
}

// ---- The checks: what's wrong, how serious, and why it matters (in plain words for the office) ----
export const CHECKS = {
  no_note: { label: 'No clinical note', severity: 'high', why: 'With no note there is no record of what was done or why. In a complaint, a board review or an insurance audit, undocumented treatment is treated as treatment that wasn’t done.' },
  unsigned_note: { label: 'Note not signed', severity: 'medium', why: 'An unsigned note isn’t a finished legal record. Boards and payers expect notes signed promptly; signing weeks later weakens the record.' },
  signed_by_other: { label: 'Signed by someone other than the treating provider', severity: 'high', why: 'The person who did the work should attest to it. A note signed by someone else can be challenged and may not support the claim.' },
  proc_not_in_note: { label: 'Charted work the note doesn’t describe', severity: 'high', why: 'Billed work that the note doesn’t describe is the most common insurance audit finding; payers can take the payment back.' },
  work_not_charted: { label: 'Work in the note that isn’t charted or billed', severity: 'medium', why: 'The note says it was done but the chart and bill don’t show it. The chart, the bill and the note should tell the same story.' },
  tooth_mismatch: { label: 'Tooth or surfaces differ between the note and the chart', severity: 'high', why: 'A different tooth or surface in the note than on the claim looks like an error to an auditor, and wrong-site questions are hard to defend.' },
  anesthetic_details: { label: 'Anesthetic details missing', severity: 'medium', why: 'Standard of care is to record the anesthetic, how much (carpules) and where it was given. It matters for reactions, numbness complaints and maximum-dose questions.' },
  xray_interpretation: { label: 'X-rays with no reading recorded', severity: 'medium', why: 'Images that were taken must be read and the findings written down. An unread image is a missed-diagnosis risk, and payers can deny it.' },
  consent_missing: { label: 'No signed consent on file', severity: 'high', why: 'Informed consent should be signed before this kind of treatment. Without it the practice is exposed if there’s a complication.' },
  medical_history: { label: 'Medical history not reviewed', severity: 'high', why: 'Treating without a current medical history review (medications, allergies, conditions) is a standard-of-care issue and a patient-safety risk.' },
  blood_pressure: { label: 'Blood pressure not recorded', severity: 'medium', why: 'Your office asks for BP at this kind of visit. It shows the patient was safe to treat, especially with anesthetic that contains epinephrine.' },
  informed_refusal: { label: 'Declined treatment without informed refusal', severity: 'high', why: 'When a patient declines recommended treatment, the note should say what was recommended, the risks of waiting, and that the patient understood. It is the main defence if the problem gets worse.' },
  postop_missing: { label: 'Post-op instructions not documented', severity: 'medium', why: 'After surgery the note should show post-op instructions were given. It matters if there’s a complication such as bleeding or dry socket.' },
  perio_overdue: { label: 'Periodontal charting overdue', severity: 'medium', why: 'Full perio charting at least yearly is the standard of care. Missed periodontal disease is one of the most common malpractice claims in dentistry.' },
  rx_not_noted: { label: 'Prescription not mentioned in the note', severity: 'medium', why: 'Every prescription should be in the note with the reason. It matters for drug interactions, opioid reviews and pharmacy questions.' },
  scheduled_not_done: { label: 'Scheduled work not done or explained', severity: 'low', why: 'Work booked for this visit wasn’t completed and the note doesn’t say why. Recording the reason keeps the plan accurate and shows nothing was overlooked.' },
  // "Check my chart" only (CA4): the assistant's first pass on a visit before the doctor reviews it.
  spelling: { label: 'Possible spelling mistake', severity: 'low', why: 'Misspelled drug names, materials and anatomy make a note harder to rely on and look careless in a record request.' },
  grammar: { label: 'Wording to check', severity: 'low', why: 'Clear sentences make the note easy to defend and to read later.' },
  template_field: { label: 'Template question not answered', severity: 'medium', why: 'A question left in the note ([[…]]) means that part of the visit wasn’t documented.' },
  note_not_linked: { label: 'Note not linked to the visit', severity: 'low', why: 'A note linked to its visit is found with the visit’s procedures and claim; an unlinked one can look missing in an audit.' },
};
export const AUDIT_CHECKS = Object.keys(DEFAULT_RULES.checks);
const SEVERITY_RISK = { high: 300, medium: 200, low: 100 };

// ---- Reading a note ----
const ANESTHETIC_DRUG = /\b(lidocaine|lido|xylocaine|articaine|septocaine|ubistesin|orabloc|mepivacaine|mepi|carbocaine|polocaine|scandonest|prilocaine|citanest|bupivacaine|marcaine|vivacaine|oraqix|kovanaze)\b/i;
const ANESTHETIC_WORD = /\b(an(a)?esthe\w*|local|numb(ed|ing)?|carpules?|cartridges?|carps?)\b/i;
const ANESTHETIC_NONE = /\b(no|without|declined|refused|did not need|didn'?t need|not needed)\s+(local\s+)?(an(a)?esthe\w*|numbing|la)\b|\ban(a)?esthe\w*\s*[:-]?\s*(none|n\/a|not needed|declined)\b/i;
const ANESTHETIC_AMOUNT = /\b(\d+(\.\d+)?|one|two|three|four|five|six|half)\s*(x\s*)?(carps?|carpules?|cartridges?|carts?|ml|cc|mg)\b|\b(carpules?|cartridges?|carps?)\s*[:x]?\s*\d/i;
const ANESTHETIC_SITE = /\b(ianb|ian|inferior alveolar|blocks?|infiltrat\w*|infil|psa|msa|asa|gp|greater palatine|np|nasopalatine|pdl|intraligamentary|intraosseous|mental|long buccal|buccal|lingual|palatal|gow-?gates|vazirani|akinosi|site)\b/i;
const XRAY_WORD = /\b(x-?rays?|radiographs?|radiographic|bitewings?|bwx?|bws|pa'?s|periapicals?|fmx|pano(ramic)?|cbct|images?)\b/i;
const XRAY_READ = /\b(reviewed|read|interpret\w*|findings?|shows?|showed|revealed?|reveals|noted|wnl|within normal limits|no (caries|decay|pathology|lesions?)|caries|decay|bone loss|radiolucen\w*|radiopaque|periapical (lesion|pathology)|impression|normal)\b/i;
const POSTOP = /\b(post-?\s?op(erative)?\w*|poi|after-?care|home care instructions|instructions (were |was )?(given|reviewed|provided)|written instructions|verbal instructions)\b/i;
const REFUSAL = /\b(declin\w*|refus\w*|does not want|doesn'?t want|elected not|chose not|deferred|defers|wishes to wait|wants to wait|not ready)\b/i;
const REFUSAL_INFORMED = /\b(risks?|consequences?|understands?|understood|explained|informed|advised|aware)\b/i;
const BP_IN_NOTE = /\b(bp|b\/p|blood pressure)\b\s*(was|of|:)?\s*\d{2,3}\s*\/\s*\d{2,3}/i;
const PLANNING = /\b(recommend\w*|plan(ned|s)?|discuss\w*|next (visit|appt|appointment)|will need|needs?|consider\w*|options?|refer\w*|declin\w*|future|tx plan|treatment plan|return|rtc|schedul\w*|watch|monitor\w*|previous\w*|existing|history of|hx|pending|estimate)\b/i;
const DONE = /\b(placed|restored|prepp?ed|prepared|seated|cemented|extracted|removed|completed|done|performed|delivered|scaled|polished|applied|obturated|filled|took|taken|exposed|sealed|fabricated|bonded|sutured|pulped|accessed|debrided|irrigated)\b/i;

// Procedure families: which codes, and the words a note uses for them.
export const FAMILIES = [
  { key: 'exam', label: 'exam', code: /^D01[2-8]\d$/, words: /\b(exam\w*|evaluation|eval|assessment)\b/i, reverse: false },
  { key: 'xray', label: 'x-rays', code: /^D0[23]\d\d$/, words: XRAY_WORD, reverse: false },
  { key: 'prophy', label: 'cleaning', code: /^D11[12]\d$/, words: /\b(prophy\w*|cleaning|scaled|scaling|polish\w*|debride\w*)\b/i },
  { key: 'fluoride', label: 'fluoride', code: /^D120\d$/, words: /\b(fluoride|varnish|fl)\b/i },
  { key: 'sealant', label: 'sealant', code: /^D135\d$/, words: /\bseal(ant|ants|ed)\b/i },
  { key: 'veneer', label: 'veneer', code: /^D296\d$/, words: /\bveneers?\b/i },
  { key: 'buildup', label: 'buildup', code: /^D295[0-7]$/, words: /\b(build-?ups?|core|post)\b/i },
  { key: 'inlay', label: 'inlay/onlay', code: /^D2[56]\d\d$/, words: /\b(inlays?|onlays?)\b/i },
  { key: 'restoration', label: 'filling', code: /^D2[1-4]\d\d$/, words: /\b(restor\w*|fillings?|composite|resin|amalgam|alloy|bonded|class [ivx]+)\b/i },
  { key: 'crown', label: 'crown', code: /^(D27\d\d|D29[3-9]\d|D6065|D67\d\d)$/, words: /\b(crowns?|prepp?(ed)?|preparation|seat(ed)?|cement(ed)?|zirconia|e\.?max|pfm)\b/i },
  { key: 'endo', label: 'root canal', code: /^D3\d{3}$/, words: /\b(root canals?|rct|endo\w*|pulpotomy|pulpectomy|obturat\w*|pulp\w*|canals?)\b/i },
  { key: 'srp', label: 'scaling and root planing', code: /^D434\d$/, words: /\b(srp|scaling and root planing|root planing|scaling|scaled)\b/i },
  { key: 'perio_maint', label: 'perio maintenance', code: /^D4910$/, words: /\b(perio(dontal)? maint\w*|pm|maintenance)\b/i },
  { key: 'perio_surgery', label: 'perio surgery', code: /^D4[2-3]\d\d$/, words: /\b(gingivectomy|osseous|flap|graft\w*|crown lengthening)\b/i },
  { key: 'denture', label: 'denture', code: /^D5\d{3}$/, words: /\b(dentures?|partials?|reline\w*)\b/i },
  { key: 'implant', label: 'implant', code: /^D60[0-5]\d$/, words: /\b(implants?|fixture|osteotomy)\b/i },
  { key: 'bridge', label: 'bridge', code: /^D6[2-7]\d\d$/, words: /\b(bridge|pontic|abutment|retainer)\b/i },
  { key: 'extraction', label: 'extraction', code: /^D7[12]\d\d$/, words: /\b(extract\w*|ext|exo|removed|removal|elevated|delivered|luxated)\b/i },
  { key: 'oral_surgery', label: 'oral surgery', code: /^D7[3-9]\d\d$/, words: /\b(incision|drainage|biopsy|alveoloplasty|frenectomy|excision)\b/i },
  { key: 'ortho', label: 'ortho', code: /^D8\d{3}$/, words: /\b(ortho\w*|brackets?|aligners?|braces|wires?)\b/i },
  { key: 'palliative', label: 'palliative treatment', code: /^D9110$/, words: /\b(palliative|pain relief|emergency|sedative)\b/i, reverse: false },
  { key: 'nitrous', label: 'nitrous oxide', code: /^D9230$/, words: /\b(nitrous|n2o|laughing gas)\b/i },
  { key: 'guard', label: 'occlusal guard', code: /^D994\d$/, words: /\b(night ?guard|occlusal guard|bite guard|nightguard)\b/i },
];
export const familyOf = (code) => FAMILIES.find((f) => f.code.test(String(code || '').toUpperCase())) || null;

// Sentences with where they start, for quoting.
export function sentences(text) {
  const out = [];
  const re = /[^.!?\n]+[.!?]?/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const s = m[0].trim();
    if (s.length > 1) out.push(s);
  }
  return out;
}

const TOOTH = /^([1-9]|[12]\d|3[0-2]|[A-Ta-t])$/;
// Teeth named in text: "#14", "#14 MO", "tooth 3", "teeth 3, 14 and 30", "number 30".
export function teethIn(text) {
  const found = new Set();
  const s = String(text || '');
  for (const m of s.matchAll(/#\s?(3[0-2]|[12]\d|[1-9]|[A-T])(?![\dA-Za-z])/g)) found.add(m[1].toUpperCase());
  for (const m of s.matchAll(/\b(?:tooth|teeth|number|nos?\.?)\s+((?:(?:3[0-2]|[12]\d|[1-9]|[A-T])(?![\dA-Za-z])(?:\s*(?:,|and|&|-)\s*)?)+)/gi)) {
    for (const t of m[1].split(/\s*(?:,|and|&|-)\s*/)) if (TOOTH.test(t.trim())) found.add(t.trim().toUpperCase());
  }
  return found;
}
// Surfaces written the charting way ("MO", "DO", "MOD", "B") — upper case only, so ordinary words aren't read as surfaces.
export function surfacesIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/(?:^|[\s,(#\d])([MODBLFI]{1,5})(?=$|[\s,.;)])/g)) {
    const tok = m[1];
    if (tok === 'I' || (tok === 'DO' && /\bDO\s+(not|NOT)\b/.test(text))) continue;
    if (new Set(tok).size !== tok.length) continue;
    out.push(tok);
  }
  return out;
}
const sameSurfaces = (a, b) => [...String(a || '')].sort().join('') === [...String(b || '')].sort().join('');

// Where a procedure is described in the note, by code or by the words used for its kind of work.
export function findProcedure(noteText, proc) {
  const all = sentences(noteText);
  const code = String(proc.code || '').toUpperCase();
  const byCode = all.filter((s) => new RegExp(`\\b${code}\\b`, 'i').test(s));
  const fam = familyOf(code);
  let words = fam?.words;
  if (!words) {
    // A code without a family: its own description's distinctive words.
    const key = String(proc.description || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5).slice(0, 3);
    words = key.length ? new RegExp(`\\b(${key.map((w) => w.slice(0, 6)).join('|')})`, 'i') : null;
  }
  const byWords = words ? all.filter((s) => words.test(s)) : [];
  const hits = [...new Set([...byCode, ...byWords])];
  return { found: hits.length > 0, sentences: hits, family: fam };
}

// ---- Dates ----
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b.slice(0, 10)}T12:00:00Z`) - Date.parse(`${a.slice(0, 10)}T12:00:00Z`)) / 86400_000);
export const visitKeyOf = (v) => (v.appointment_id ? `a${v.appointment_id}` : `d${v.patient_id}-${v.date}`);
export function parseVisitKey(key) {
  const a = /^a(\d+)$/.exec(String(key));
  if (a) return { appointment_id: Number(a[1]) };
  const d = /^d(\d+)-(\d{4}-\d{2}-\d{2})$/.exec(String(key));
  if (d) return { patient_id: Number(d[1]), date: d[2] };
  return null;
}

// ---- The pure checks. Each takes the visit's facts (ctx) and the office's rules, returns findings. ----
const finding = (check, subject, title, detail, extra = {}) => ({ check, subject: String(subject ?? ''), title, detail, severity: extra.severity || CHECKS[check].severity, evidence: extra.evidence || null, source: extra.source || 'rule', fix: extra.fix || null });
const done = (ctx) => ctx.procedures.filter((p) => p.status === 'completed');
const describe = (p) => `${p.code}${p.tooth ? ` #${p.tooth}` : ''}${p.surfaces ? ` ${p.surfaces}` : ''}${p.area ? ` ${p.area}` : ''} ${p.description}`.trim();
const needsAnesthetic = (ctx, rules) => done(ctx).some((p) => !rules.anesthetic_exempt_codes.includes(p.code) && (rules.anesthetic_categories.includes(p.category) || rules.anesthetic_codes.includes(p.code)));

export const checks = {
  no_note(ctx) {
    if (ctx.notes.length) return [];
    return [finding('no_note', '', 'No clinical note for this visit', `${done(ctx).length ? `${done(ctx).length} procedure(s) completed` : 'Visit completed'} with no note written.`, { fix: { type: 'write_note' } })];
  },
  unsigned_note(ctx, rules) {
    const age = daysBetween(ctx.date, ctx.today);
    return ctx.notes.filter((n) => !n.signed && age > rules.unsigned_grace_days).map((n) => finding('unsigned_note', n.id, 'Note not signed', `Unsigned for ${age} day${age === 1 ? '' : 's'} since the visit.`, { severity: age > rules.unsigned_high_days ? 'high' : 'medium', fix: { type: 'sign', note_id: n.id } }));
  },
  signed_by_other(ctx) {
    if (!ctx.treatingUsers.length) return [];
    return ctx.notes.filter((n) => n.signed && n.signed_by && !ctx.treatingUsers.includes(n.signed_by))
      .map((n) => finding('signed_by_other', n.id, 'Signed by someone other than the treating provider', `Signed by ${n.signed_by_name || 'another user'}; the work was done by ${ctx.providerNames.join(' / ') || 'another provider'}.`));
  },
  proc_not_in_note(ctx) {
    if (!ctx.notes.length) return [];
    return ctx.procedures.filter((p) => p.status === 'completed' && !findProcedure(ctx.noteText, p).found)
      .map((p) => finding('proc_not_in_note', p.id, `${p.code}${p.tooth ? ` #${p.tooth}` : ''} isn’t described in the note`, `Charted and billed: ${describe(p)}. The note doesn’t mention this work.`, { fix: { type: 'append_text', note_id: ctx.editableNoteId, text: `Completed: ${describe(p)}.` } }));
  },
  tooth_mismatch(ctx) {
    if (!ctx.notes.length) return [];
    const out = [];
    const anyTeeth = teethIn(ctx.noteText);
    for (const p of done(ctx)) {
      if (!p.tooth) continue;
      const hit = findProcedure(ctx.noteText, p);
      if (!hit.found) continue;
      const withTeeth = hit.sentences.filter((s) => teethIn(s).size);
      const tooth = String(p.tooth).toUpperCase();
      if (withTeeth.length && !withTeeth.some((s) => teethIn(s).has(tooth))) {
        const s = withTeeth[0];
        out.push(finding('tooth_mismatch', `${p.id}:tooth`, `Tooth differs: chart says #${tooth}, note says #${[...teethIn(s)].join(', #')}`, `Charted ${describe(p)}.`, { evidence: s, fix: { type: 'jump', note_id: ctx.editableNoteId, quote: s } }));
        continue;
      }
      if (!withTeeth.length && !anyTeeth.has(tooth)) {
        out.push(finding('tooth_mismatch', `${p.id}:tooth`, `The note doesn’t say which tooth (#${tooth})`, `Charted ${describe(p)}; the note describes the work without the tooth number.`, { severity: 'medium', evidence: hit.sentences[0], fix: { type: 'append_text', note_id: ctx.editableNoteId, text: `Tooth #${tooth}${p.surfaces ? ` ${p.surfaces}` : ''}: ${p.description}.` } }));
        continue;
      }
      if (p.surfaces) {
        const own = withTeeth.filter((s) => teethIn(s).has(tooth));
        const written = own.flatMap((s) => surfacesIn(s));
        if (written.length && !written.some((x) => sameSurfaces(x, p.surfaces))) {
          out.push(finding('tooth_mismatch', `${p.id}:surfaces`, `Surfaces differ on #${tooth}: chart says ${p.surfaces}, note says ${written.join('/')}`, `Charted ${describe(p)}.`, { evidence: own[0], fix: { type: 'jump', note_id: ctx.editableNoteId, quote: own[0] } }));
        }
      }
    }
    return out;
  },
  work_not_charted(ctx) {
    if (!ctx.notes.length) return [];
    const out = [];
    const charted = new Set(ctx.procedures.filter((p) => p.status === 'completed').map((p) => familyOf(p.code)?.key).filter(Boolean));
    // A filling charted as a buildup or crown work and so on is still "charted": related kinds count together.
    const related = { restoration: ['buildup', 'inlay'], buildup: ['restoration', 'crown'], crown: ['buildup', 'bridge'], prophy: ['srp', 'perio_maint'], srp: ['prophy', 'perio_maint'], perio_maint: ['prophy', 'srp'], extraction: ['oral_surgery'], bridge: ['crown'] };
    for (const s of sentences(ctx.noteText)) {
      if (PLANNING.test(s) || !DONE.test(s)) continue;
      for (const f of FAMILIES) {
        if (f.reverse === false || !f.words.test(s)) continue;
        if (charted.has(f.key) || (related[f.key] || []).some((k) => charted.has(k))) continue;
        const teeth = [...teethIn(s)];
        const subject = `${f.key}${teeth.length ? `:${teeth.join(',')}` : ''}`;
        if (out.some((x) => x.subject === subject)) continue;
        out.push(finding('work_not_charted', subject, `The note describes ${f.label}${teeth.length ? ` on #${teeth.join(', #')}` : ''} that isn’t charted`, 'Nothing of this kind is charted or billed for the visit.', { evidence: s, fix: { type: 'chart', family: f.key, teeth } }));
        break;
      }
    }
    return out;
  },
  anesthetic_details(ctx, rules) {
    if (!ctx.notes.length || !needsAnesthetic(ctx, rules)) return [];
    const t = ctx.noteText;
    if (ANESTHETIC_NONE.test(t)) return [];
    const drug = ANESTHETIC_DRUG.test(t);
    if (!drug && !ANESTHETIC_WORD.test(t)) {
      return [finding('anesthetic_details', '', 'No anesthetic recorded', `Work that usually needs local anesthetic was done (${done(ctx).filter((p) => rules.anesthetic_categories.includes(p.category) || rules.anesthetic_codes.includes(p.code)).map((p) => p.code).join(', ')}); the note doesn’t say what was used, or that none was.`, { fix: { type: 'append_text', note_id: ctx.editableNoteId, text: 'Anesthetic: [[Anesthetic: 2% lidocaine 1:100k epi|4% articaine 1:100k epi|3% mepivacaine plain|none]], [[Carpules: 1|2|3]] carpule(s), [[Injection: infiltration|IANB|PSA]].' } })];
    }
    const missing = [!drug && 'type (which anesthetic)', !ANESTHETIC_AMOUNT.test(t) && 'amount (carpules)', !ANESTHETIC_SITE.test(t) && 'injection site'].filter(Boolean);
    if (!missing.length) return [];
    return [finding('anesthetic_details', '', `Anesthetic ${missing.map((m) => m.split(' ')[0]).join(', ')} missing`, `The note mentions anesthetic but not the ${missing.join(', ')}.`, { fix: { type: 'jump', note_id: ctx.editableNoteId, quote: sentences(t).find((s) => ANESTHETIC_WORD.test(s) || ANESTHETIC_DRUG.test(s)) } })];
  },
  xray_interpretation(ctx) {
    const taken = ctx.xrays.length || done(ctx).some((p) => /^D0[23]\d\d$/.test(p.code));
    if (!taken) return [];
    if (ctx.xrays.some((d) => String(d.notes || '').trim().length > 10)) return [];
    if (sentences(ctx.noteText).some((s) => XRAY_WORD.test(s) && XRAY_READ.test(s))) return [];
    const what = ctx.xrays.length ? `${ctx.xrays.length} image${ctx.xrays.length === 1 ? '' : 's'} taken` : done(ctx).filter((p) => /^D0[23]/.test(p.code)).map((p) => `${p.code} ${p.description}`).join(', ');
    return [finding('xray_interpretation', '', 'X-rays taken with no reading recorded', `${what}; neither the note nor the images say what they showed.`, { fix: { type: 'append_text', note_id: ctx.editableNoteId, text: 'Radiographs reviewed: [[Radiographic findings: no caries or pathology noted|findings charted and discussed]].' } })];
  },
  consent_missing(ctx, rules) {
    const need = done(ctx).filter((p) => rules.consent_categories.includes(p.category) || rules.consent_codes.includes(p.code));
    if (!need.length || ctx.consent.forms > 0) return [];
    const out = [];
    for (const p of need) {
      if (p.treatment_plan_id && ctx.consent.signedPlans.includes(p.treatment_plan_id)) continue;
      const claims = /consent (form )?(was )?(signed|obtained)|signed consent|informed consent/i.test(ctx.noteText);
      out.push(finding('consent_missing', p.id, `No signed consent for ${p.code}${p.tooth ? ` #${p.tooth}` : ''}`, claims ? `${describe(p)}. The note says consent was given, but no signed consent is on file.` : `${describe(p)} was done with no signed consent or signed treatment plan on file.`, { fix: { type: 'consent', procedure_id: p.id } }));
    }
    return out;
  },
  medical_history(ctx, rules) {
    const from = addDays(ctx.date, -rules.medical_history_days);
    const ok = ctx.medicalReviews.some((d) => d.slice(0, 10) >= from && d.slice(0, 10) <= addDays(ctx.date, 1));
    if (ok) return [];
    const last = ctx.medicalReviews.filter((d) => d.slice(0, 10) <= addDays(ctx.date, 1)).sort().pop();
    return [finding('medical_history', '', 'Medical history not reviewed', last ? `Last reviewed ${last.slice(0, 10)}, more than ${rules.medical_history_days} days before this visit.` : 'No medical history review is on file before this visit.', { fix: { type: 'medical' } })];
  },
  blood_pressure(ctx, rules) {
    if (rules.bp_required === 'never') return [];
    if (rules.bp_required === 'anesthesia' && !needsAnesthetic(ctx, rules) && !(ANESTHETIC_DRUG.test(ctx.noteText) && !ANESTHETIC_NONE.test(ctx.noteText))) return [];
    if (ctx.vitals.some((v) => v.bp_systolic && v.bp_diastolic) || BP_IN_NOTE.test(ctx.noteText)) return [];
    return [finding('blood_pressure', '', 'Blood pressure not recorded', rules.bp_required === 'every_visit' ? 'Your office records BP at every visit; none was recorded.' : 'Local anesthetic was used and no BP was recorded.', { fix: { type: 'vitals' } })];
  },
  informed_refusal(ctx) {
    if (!ctx.declined.length) return [];
    const documented = sentences(ctx.noteText).some((s) => REFUSAL.test(s)) && REFUSAL_INFORMED.test(ctx.noteText);
    if (documented || ctx.consent.refusalForms > 0) return [];
    return ctx.declined.map((p) => finding('informed_refusal', `plan:${p.id}`, `Declined “${p.name}” without informed refusal`, 'The patient declined recommended treatment at this visit; the note doesn’t record the risks explained or that the patient understood.', { fix: { type: 'append_text', note_id: ctx.editableNoteId, text: `Informed refusal: recommended ${p.name}. Risks of not treating explained, including [[Risks: worsening decay and pain|infection or abscess|tooth loss|bone loss]]. Patient understands and declines at this time.` } }));
  },
  postop_missing(ctx, rules) {
    const surgery = done(ctx).filter((p) => rules.postop_categories.includes(p.category));
    if (!surgery.length || !ctx.notes.length || POSTOP.test(ctx.noteText)) return [];
    return [finding('postop_missing', '', 'Post-op instructions not documented', `After ${surgery.map((p) => `${p.code}${p.tooth ? ` #${p.tooth}` : ''}`).join(', ')}, the note doesn’t say post-op instructions were given.`, { fix: { type: 'append_text', note_id: ctx.editableNoteId, text: 'Post-op instructions given verbally and in writing.' } })];
  },
  perio_overdue(ctx, rules) {
    if (!done(ctx).some((p) => rules.perio_codes.includes(p.code))) return [];
    if (ctx.patientAge != null && ctx.patientAge < 18) return [];
    const last = ctx.lastPerio;
    if (last && daysBetween(last, ctx.date) <= rules.perio_interval_days) return [];
    return [finding('perio_overdue', '', 'Periodontal charting overdue', last ? `Last full perio charting ${last}, ${daysBetween(last, ctx.date)} days before this visit.` : 'No perio charting on file for this adult patient.', { fix: { type: 'perio' } })];
  },
  rx_not_noted(ctx) {
    if (!ctx.prescriptions.length) return [];
    const t = ctx.noteText.toLowerCase();
    return ctx.prescriptions.filter((rx) => {
      const name = String(rx.drug || '').toLowerCase().split(/[^a-z]+/).find((w) => w.length >= 4);
      return !name || !t.includes(name);
    }).map((rx) => finding('rx_not_noted', rx.id, `Prescription for ${rx.drug} isn’t in the note`, `${rx.drug}${rx.strength ? ` ${rx.strength}` : ''} was prescribed at this visit; the note doesn’t mention it or why.`, { fix: { type: 'append_text', note_id: ctx.editableNoteId, text: `Rx: ${rx.drug}${rx.strength ? ` ${rx.strength}` : ''}, ${rx.sig}, #${rx.quantity}. Reason: [[Reason: pain|infection|prophylaxis]].` } }));
  },
  scheduled_not_done(ctx) {
    if (!ctx.appointment_id) return [];
    const left = ctx.procedures.filter((p) => p.status === 'planned' && p.appointment_id === ctx.appointment_id);
    if (!left.length) return [];
    if (/\b(declin\w*|defer\w*|postpon\w*|not completed|ran out of time|reschedul\w*|did not|didn'?t|next visit|not done)\b/i.test(ctx.noteText)) return [];
    return left.map((p) => finding('scheduled_not_done', p.id, `${p.code}${p.tooth ? ` #${p.tooth}` : ''} was booked but not done`, `${describe(p)} is attached to this visit, still planned, and the note doesn’t say why.`, { fix: { type: 'jump', procedure_id: p.id } }));
  },
};

// All enabled checks on one visit, deterministic first; wording they can't place goes to the AI when it's on.
export async function auditVisit(ctx, rules, { comparer = null } = {}) {
  const out = [];
  for (const code of AUDIT_CHECKS) {
    if (!rules.checks[code] || !checks[code]) continue;
    out.push(...checks[code](ctx, rules));
  }
  let aiUsed = false;
  const unresolved = out.filter((f) => f.check === 'proc_not_in_note');
  if (comparer && rules.ai_compare && ctx.notes.length && unresolved.length) {
    const read = await compareWithAi(ctx, unresolved, comparer);
    aiUsed = !!read;
    if (read) {
      const keep = [];
      for (const f of out) {
        if (f.check !== 'proc_not_in_note') { keep.push(f); continue; }
        const r = read.procedures.find((x) => String(x.procedure_id) === f.subject);
        if (r?.mentioned && r.quote) continue; // the AI found where the note describes it, in the note's own words
        keep.push({ ...f, source: 'ai', detail: `${f.detail} The AI read the note too and found no description of it.` });
      }
      for (const m of read.mismatches) {
        const check = m.kind === 'tooth' ? 'tooth_mismatch' : 'work_not_charted';
        if (!rules.checks[check]) continue;
        const subject = `ai:${m.procedure_id || m.what}`.slice(0, 120);
        if (keep.some((f) => f.check === check && (f.subject === subject || (m.procedure_id && f.subject.startsWith(`${m.procedure_id}:`))))) continue;
        keep.push(finding(check, subject, m.title, m.why, { source: 'ai', evidence: m.quote, severity: check === 'tooth_mismatch' ? 'high' : 'medium', fix: { type: 'jump', note_id: ctx.editableNoteId, quote: m.quote } }));
      }
      out.length = 0;
      out.push(...keep);
    }
  }
  return { findings: out, aiUsed };
}

// The AI reads the note against the charted work. Its answer is kept per note version, and nothing it says is
// used unless the sentence it quotes is really in the note.
async function compareWithAi(ctx, unresolved, comparer) {
  const input = { note: ctx.noteText, procedures: done(ctx).map((p) => ({ procedure_id: p.id, code: p.code, description: p.description, tooth: p.tooth, surfaces: p.surfaces })), ask: unresolved.map((f) => Number(f.subject)) };
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32);
  if (ctx.db) {
    const cached = await ctx.db.get('SELECT mismatches FROM chart_audit_ai_reads WHERE practice_id = ? AND visit_key = ? AND input_hash = ?', ctx.practice_id, ctx.key, hash);
    if (cached) return JSON.parse(cached.mismatches);
  }
  let raw;
  try {
    raw = await comparer.compare(input);
  } catch (err) {
    log.warn('Chart audit AI read failed', err);
    if (ctx.db) await raiseIssue(ctx.db, { practiceId: ctx.practice_id, kind: 'ai', key: 'chart-audit-ai', role: 'clinical', title: 'The AI couldn’t read notes for the chart audit — keyword checks were used instead', detail: err.message });
    return null;
  }
  if (ctx.db) await resolveIssue(ctx.db, ctx.practice_id, 'chart-audit-ai');
  const inNote = (q) => q && ctx.noteText.replace(/\s+/g, ' ').toLowerCase().includes(String(q).replace(/\s+/g, ' ').trim().toLowerCase());
  const read = {
    procedures: (raw?.procedures || []).map((p) => ({ procedure_id: Number(p.procedure_id), mentioned: !!p.mentioned && inNote(p.quote), quote: inNote(p.quote) ? String(p.quote).slice(0, 400) : null })),
    mismatches: (raw?.mismatches || []).filter((m) => inNote(m.quote)).slice(0, 20).map((m) => ({
      kind: m.kind === 'tooth' ? 'tooth' : 'not_charted', procedure_id: m.procedure_id ? Number(m.procedure_id) : null, what: String(m.what || '').slice(0, 80),
      title: String(m.title || (m.kind === 'tooth' ? 'Tooth differs between the note and the chart' : 'The note describes work that isn’t charted')).slice(0, 200),
      why: String(m.why || '').slice(0, 400), quote: String(m.quote).slice(0, 400),
    })),
  };
  if (ctx.db) await ctx.db.run('INSERT INTO chart_audit_ai_reads (practice_id, visit_key, input_hash, mismatches) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', ctx.practice_id, ctx.key, hash, JSON.stringify(read));
  return read;
}

// ---- The facts about a visit, from the database ----
async function practiceTz(db, pid) {
  return (await db.get('SELECT timezone FROM practices WHERE id = ?', pid))?.timezone || 'America/New_York';
}

// Completed visits in [from, to] (practice-local dates): appointments that were completed or had work completed,
// plus work completed without an appointment (grouped by patient and day).
export async function listVisits(db, pid, from, to) {
  const tz = await practiceTz(db, pid);
  const appts = await db.all(
    `SELECT a.id AS appointment_id, a.patient_id, a.provider_id, a.location_id, substr(a.start_time, 1, 10) AS date FROM appointments a
     WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ('cancelled','no_show')
       AND (a.status = 'completed' OR EXISTS (SELECT 1 FROM procedures p WHERE p.appointment_id = a.id AND p.status = 'completed'))
     ORDER BY a.start_time, a.id`, pid, `${from} 00:00`, `${addDays(to, 1)} 00:00`,
  );
  const loose = await db.all(
    `SELECT patient_id, completed_at, provider_id, location_id FROM procedures
     WHERE practice_id = ? AND status = 'completed' AND appointment_id IS NULL AND completed_at >= ? AND completed_at < ? ORDER BY completed_at`,
    pid, zonedToUtc(tz, from), zonedToUtc(tz, addDays(to, 1)),
  );
  const seen = new Map();
  for (const p of loose) {
    const date = localDate(tz, p.completed_at);
    const key = `d${p.patient_id}-${date}`;
    if (!seen.has(key)) seen.set(key, { appointment_id: null, patient_id: p.patient_id, provider_id: p.provider_id, location_id: p.location_id, date });
  }
  return [...appts, ...seen.values()].map((v) => ({ ...v, key: visitKeyOf(v) }));
}
const localDate = (tz, utc) => {
  const d = new Date(`${String(utc).replace(' ', 'T').slice(0, 19)}Z`);
  if (Number.isNaN(d.getTime())) return String(utc).slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};

// Everything the checks need to know about one visit.
export async function visitContext(db, pid, key, { today } = {}) {
  const parsed = parseVisitKey(key);
  if (!parsed) return null;
  const tz = await practiceTz(db, pid);
  let visit;
  if (parsed.appointment_id) {
    const a = await db.get('SELECT id, patient_id, provider_id, location_id, start_time, status FROM appointments WHERE id = ? AND practice_id = ?', parsed.appointment_id, pid);
    if (!a) return null;
    visit = { appointment_id: a.id, patient_id: a.patient_id, provider_id: a.provider_id, location_id: a.location_id, date: a.start_time.slice(0, 10), status: a.status };
  } else {
    const p = await db.get('SELECT id, location_id FROM patients WHERE id = ? AND practice_id = ?', parsed.patient_id, pid);
    if (!p) return null;
    visit = { appointment_id: null, patient_id: p.id, provider_id: null, location_id: p.location_id, date: parsed.date, status: 'completed' };
  }
  const [dayStart, dayEnd] = [zonedToUtc(tz, visit.date), zonedToUtc(tz, addDays(visit.date, 1))];
  const procedures = visit.appointment_id
    ? await db.all("SELECT * FROM procedures WHERE appointment_id = ? AND practice_id = ? AND status != 'cancelled' ORDER BY id", visit.appointment_id, pid)
    : await db.all("SELECT * FROM procedures WHERE patient_id = ? AND practice_id = ? AND status = 'completed' AND appointment_id IS NULL AND completed_at >= ? AND completed_at < ? ORDER BY id", visit.patient_id, pid, dayStart, dayEnd);
  if (!visit.provider_id) visit.provider_id = procedures.find((p) => p.provider_id)?.provider_id ?? null;
  if (!visit.location_id) visit.location_id = procedures.find((p) => p.location_id)?.location_id ?? null;
  // The visit's notes: linked to it, or written that day for the patient without a link. Addenda count as the note.
  const linked = visit.appointment_id ? await db.all('SELECT n.*, u.name AS signed_by_name FROM clinical_notes n LEFT JOIN users u ON u.id = n.signed_by WHERE n.appointment_id = ? AND n.practice_id = ? ORDER BY n.id', visit.appointment_id, pid) : [];
  const unlinked = await db.all('SELECT n.*, u.name AS signed_by_name FROM clinical_notes n LEFT JOIN users u ON u.id = n.signed_by WHERE n.patient_id = ? AND n.practice_id = ? AND n.appointment_id IS NULL AND n.created_at >= ? AND n.created_at < ? ORDER BY n.id', visit.patient_id, pid, dayStart, dayEnd);
  const addenda = [...linked, ...unlinked].filter((n) => n.addendum_of);
  const mainIds = new Set([...linked, ...unlinked].filter((n) => !n.addendum_of).map((n) => n.id));
  const extraAddenda = mainIds.size ? await db.all(`SELECT * FROM clinical_notes WHERE addendum_of IN (${[...mainIds].map(() => '?').join(',')}) ORDER BY id`, ...mainIds) : [];
  const notes = [...linked, ...unlinked].filter((n) => !n.addendum_of);
  const allAddenda = [...new Map([...addenda, ...extraAddenda].map((a) => [a.id, a])).values()];
  const noteText = [...notes, ...allAddenda].map((n) => n.body).join('\n');
  const providerIds = [...new Set([visit.provider_id, ...procedures.filter((p) => p.status === 'completed').map((p) => p.provider_id)].filter(Boolean))];
  const providers = providerIds.length ? await db.all(`SELECT id, name, user_id FROM providers WHERE id IN (${providerIds.map(() => '?').join(',')})`, ...providerIds) : [];
  const patient = await db.get('SELECT id, dob, medical_reviewed_at FROM patients WHERE id = ?', visit.patient_id);
  const reviews = (await db.all("SELECT created_at, changes FROM audit_log WHERE practice_id = ? AND entity = 'patients' AND entity_id = ? AND changes LIKE ?", pid, visit.patient_id, '%medical_reviewed_at%'))
    .map((r) => r.created_at);
  if (patient?.medical_reviewed_at) reviews.push(patient.medical_reviewed_at);
  const xrays = await db.all("SELECT id, notes FROM documents WHERE patient_id = ? AND practice_id = ? AND category = 'xray' AND deleted_at IS NULL AND ((taken_at IS NOT NULL AND substr(taken_at, 1, 10) = ?) OR (taken_at IS NULL AND created_at >= ? AND created_at < ?))", visit.patient_id, pid, visit.date, dayStart, dayEnd);
  const vitals = await db.all('SELECT bp_systolic, bp_diastolic FROM vitals WHERE patient_id = ? AND practice_id = ? AND recorded_at >= ? AND recorded_at < ?', visit.patient_id, pid, dayStart, dayEnd);
  const prescriptions = await db.all('SELECT id, drug, strength, sig, quantity FROM prescriptions WHERE patient_id = ? AND practice_id = ? AND created_at >= ? AND created_at < ?', visit.patient_id, pid, dayStart, dayEnd);
  const consentFrom = zonedToUtc(tz, addDays(visit.date, -365 * 3));
  const forms = await db.all(
    `SELECT pf.signed_at, t.name FROM patient_forms pf JOIN form_templates t ON t.id = pf.template_id
     WHERE pf.patient_id = ? AND pf.practice_id = ? AND t.kind = 'consent' AND pf.signed_at >= ? AND pf.signed_at < ?`, visit.patient_id, pid, consentFrom, dayEnd,
  );
  const consentDocs = await db.all("SELECT created_at FROM documents WHERE patient_id = ? AND practice_id = ? AND category = 'consent' AND deleted_at IS NULL AND created_at >= ? AND created_at < ?", visit.patient_id, pid, consentFrom, dayEnd);
  const signedPlans = (await db.all('SELECT id FROM treatment_plans WHERE patient_id = ? AND practice_id = ? AND signed_at IS NOT NULL AND signed_at < ?', visit.patient_id, pid, dayEnd)).map((r) => r.id);
  // Declined at this visit: a plan turned down that day (not an option given up for another the patient chose).
  const rejectedToday = await db.all("SELECT DISTINCT entity_id FROM audit_log WHERE practice_id = ? AND entity = 'treatment_plans' AND patient_id = ? AND changes LIKE ? AND created_at >= ? AND created_at < ?", pid, visit.patient_id, '%rejected%', dayStart, dayEnd);
  const declined = [];
  for (const r of rejectedToday) {
    const plan = await db.get("SELECT id, name, option_group FROM treatment_plans WHERE id = ? AND practice_id = ? AND status = 'rejected'", r.entity_id, pid);
    if (!plan) continue;
    if (plan.option_group && await db.get("SELECT id FROM treatment_plans WHERE practice_id = ? AND option_group = ? AND status IN ('accepted','completed')", pid, plan.option_group)) continue;
    declined.push(plan);
  }
  const perio = await db.get('SELECT MAX(exam_date) AS d FROM perio_exams WHERE patient_id = ? AND practice_id = ? AND deleted_at IS NULL AND exam_date <= ?', visit.patient_id, pid, visit.date);
  const windowFrom = (days) => zonedToUtc(tz, addDays(visit.date, -days));
  const since = (rows, days) => rows.filter((r) => r >= windowFrom(days));
  const editable = notes.find((n) => !n.signed) || null;
  return {
    db, practice_id: pid, key: visitKeyOf(visit), ...visit, today: today || localDate(tz, new Date().toISOString()),
    procedures, notes, addenda: allAddenda, noteText, editableNoteId: editable?.id ?? null,
    mainNote: notes[0] || null,
    treatingUsers: providers.map((p) => p.user_id).filter(Boolean), providerNames: providers.map((p) => p.name),
    patientAge: patient?.dob ? Math.floor(daysBetween(patient.dob, visit.date) / 365.25) : null,
    medicalReviews: reviews, xrays, vitals, prescriptions, declined,
    consent: { forms: forms.length + consentDocs.length, signedPlans, refusalForms: forms.filter((f) => /refus/i.test(f.name)).length, since, formDates: [...forms.map((f) => f.signed_at), ...consentDocs.map((d) => d.created_at)] },
    lastPerio: perio?.d || null,
  };
}

// Consent is valid for the office's window: drop forms signed too long before the visit.
function applyConsentWindow(ctx, rules) {
  const valid = ctx.consent.since(ctx.consent.formDates, rules.consent_valid_days);
  ctx.consent.forms = valid.length;
  return ctx;
}

export async function checkVisit(db, pid, key, { rules, comparer, today } = {}) {
  const ctx = await visitContext(db, pid, key, { today });
  if (!ctx) return null;
  rules ??= await rulesFor(db, pid);
  applyConsentWindow(ctx, rules);
  const { findings, aiUsed } = await auditVisit(ctx, rules, { comparer });
  return { ctx, findings, aiUsed };
}

// ---- Saving findings (derived rows) ----
const riskOf = (f, ctx) => SEVERITY_RISK[f.severity] + Math.min(90, Math.max(0, daysBetween(ctx.date, ctx.today))) - (f.source === 'ai' ? 20 : 0);

// Upserts this visit's findings: live ones are refreshed, new ones added, ones no longer found are resolved
// (kept, with resolved_at). Returns { opened, resolved }.
export async function saveFindings(db, ctx, findings) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const live = await db.all("SELECT * FROM chart_audit_findings WHERE practice_id = ? AND visit_key = ? AND status <> 'resolved'", ctx.practice_id, ctx.key);
  const key = (f) => `${f.check_code ?? f.check}|${f.subject}`;
  const byKey = new Map(live.map((r) => [key(r), r]));
  const fresh = new Set();
  let opened = 0;
  for (const f of findings) {
    if (!CHECKS[f.check] || !AUDIT_CHECKS.includes(f.check)) continue; // "Check my chart" extras (spelling…) aren't kept
    const k = key(f);
    if (fresh.has(k)) continue;
    fresh.add(k);
    const row = {
      severity: f.severity, risk: riskOf(f, ctx), title: String(f.title).slice(0, 300), detail: f.detail ? String(f.detail).slice(0, 1000) : null, why: CHECKS[f.check].why,
      evidence: f.evidence ? String(f.evidence).slice(0, 500) : null, source: f.source === 'ai' ? 'ai' : 'rule', note_id: ctx.mainNote?.id ?? null, provider_id: ctx.provider_id, location_id: ctx.location_id,
    };
    const had = byKey.get(k);
    if (had) {
      await db.run(
        'UPDATE chart_audit_findings SET severity = ?, risk = ?, title = ?, detail = ?, why = ?, evidence = ?, source = ?, note_id = ?, provider_id = ?, location_id = ?, last_seen_at = ? WHERE id = ?',
        row.severity, row.risk, row.title, row.detail, row.why, row.evidence, row.source, row.note_id, row.provider_id, row.location_id, now, had.id,
      );
    } else {
      await db.run(
        `INSERT INTO chart_audit_findings (practice_id, location_id, patient_id, appointment_id, visit_key, visit_date, provider_id, note_id, check_code, subject, severity, risk, title, detail, why, evidence, source, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.practice_id, row.location_id, ctx.patient_id, ctx.appointment_id, ctx.key, ctx.date, row.provider_id, row.note_id, f.check, f.subject, row.severity, row.risk, row.title, row.detail, row.why, row.evidence, row.source, now, now,
      );
      opened++;
    }
  }
  let resolved = 0;
  for (const r of live) {
    if (fresh.has(key(r))) continue;
    // Fixed (or the check was switched off): resolved, never deleted.
    resolved += (await db.run("UPDATE chart_audit_findings SET status = 'resolved', resolved_at = ? WHERE id = ? AND status <> 'resolved'", now, r.id)).changes;
  }
  return { opened, resolved };
}

// ---- The nightly pass ----
// One pass per practice per local day (run_key), over the office's lookback window up to yesterday. Running it
// again the same day does nothing; "run now" uses its own key and recomputes (the same rows are refreshed).
export async function runPracticeAudit(db, pid, { kind = 'nightly', runKey, today, comparer = null, userId = null, from, to } = {}) {
  const rules = await rulesFor(db, pid);
  const tz = await practiceTz(db, pid);
  today ??= localDate(tz, new Date().toISOString());
  runKey ??= `${kind}:${today}`;
  const claim = await db.run('INSERT INTO chart_audit_runs (practice_id, run_key, kind, created_by) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', pid, runKey, kind, userId);
  if (!claim.changes) return { skipped: true, run: await db.get('SELECT * FROM chart_audit_runs WHERE practice_id = ? AND run_key = ?', pid, runKey) };
  const run = await db.get('SELECT id FROM chart_audit_runs WHERE practice_id = ? AND run_key = ?', pid, runKey);
  const totals = { visits: 0, opened: 0, resolved: 0, ai_checked: 0 };
  try {
    const visits = await listVisits(db, pid, from || addDays(today, -rules.lookback_days), to || addDays(today, -1));
    for (const v of visits) {
      const out = await checkVisit(db, pid, v.key, { rules, comparer, today });
      if (!out) continue;
      const saved = await saveFindings(db, out.ctx, out.findings);
      totals.visits++;
      totals.opened += saved.opened;
      totals.resolved += saved.resolved;
      if (out.aiUsed) totals.ai_checked++;
    }
    await db.run("UPDATE chart_audit_runs SET status = 'done', visits = ?, opened = ?, resolved = ?, ai_checked = ?, finished_at = datetime('now') WHERE id = ?", totals.visits, totals.opened, totals.resolved, totals.ai_checked, run.id);
    await resolveIssue(db, pid, 'chart-audit-run');
  } catch (err) {
    await db.run("UPDATE chart_audit_runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?", String(err.message).slice(0, 500), run.id);
    await raiseIssue(db, { practiceId: pid, kind: 'records', key: 'chart-audit-run', role: 'clinical', title: 'The nightly chart audit didn’t finish', detail: err.message });
    throw err;
  }
  return { skipped: false, run_id: run.id, ...totals };
}

// For the scheduler: every practice's nightly pass, after 1am practice time (checked hourly).
export async function runChartAudits(db, { comparer = null, now = new Date() } = {}) {
  const out = [];
  for (const p of await db.all('SELECT id, timezone FROM practices')) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: p.timezone || 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(now));
    if (hour < 1) continue;
    try {
      const r = await runPracticeAudit(db, p.id, { comparer });
      if (!r.skipped) out.push({ practice_id: p.id, ...r });
    } catch (err) {
      log.error('Chart audit failed', err, { practice_id: p.id });
    }
  }
  return out;
}
