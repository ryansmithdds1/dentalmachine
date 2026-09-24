import { structured, aiClient } from '../ai.js';

// The AI's read of a clinical note against the work charted and billed for the visit (chart audit, CA3), and an
// optional proofread for "Check my chart" (CA4). It only reports: every mismatch comes with the sentence of the
// note it relied on (the caller drops any quote that isn't really in the note), and it never edits a note.
//   NOTE_COMPARE=sandbox (or config.noteCompare = 'sandbox'): a deterministic stand-in for demos and tests.
//   Otherwise Claude, when AI is on for the server (ANTHROPIC_API_KEY); off when it isn't.
const SYSTEM = `You check a dental clinical note against the procedures charted and billed for the same visit, for a practice's chart audit.
- For each procedure you are asked about, say whether the note describes that work (any wording: "restored #14 MO with composite" describes D2392 #14 MO). If it does, quote the sentence from the note exactly, word for word.
- Also report real mismatches: work the note says was done at this visit that isn't in the charted list, and a tooth or surfaces in the note that differ from the charted ones. Quote the note's sentence exactly for each.
- Treatment that was only recommended, planned, discussed or done at an earlier visit is not a mismatch.
- Only report what the note text supports. Never guess. Keep each "why" to one plain sentence for office staff.`;

const TOOL = {
  name: 'compare_note',
  description: 'Which charted procedures the note describes, and mismatches between the note and the chart.',
  input_schema: {
    type: 'object',
    properties: {
      procedures: {
        type: 'array',
        items: { type: 'object', properties: { procedure_id: { type: 'integer' }, mentioned: { type: 'boolean' }, quote: { type: 'string', description: 'The sentence from the note, exactly as written. Empty if not mentioned.' } }, required: ['procedure_id', 'mentioned'] },
      },
      mismatches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['not_charted', 'tooth'] },
            procedure_id: { type: 'integer', description: 'For a tooth mismatch: the charted procedure it concerns.' },
            what: { type: 'string', description: 'Short name of the work, e.g. "sealant #3".' },
            title: { type: 'string', description: 'One line for the audit list.' },
            why: { type: 'string' },
            quote: { type: 'string', description: 'The sentence from the note, exactly as written.' },
          },
          required: ['kind', 'title', 'quote'],
        },
      },
    },
    required: ['procedures', 'mismatches'],
  },
};

const PROOF_SYSTEM = `You proofread a dental clinical note for a dental assistant before the dentist reviews it. Report only clear spelling or grammar problems (not style, not abbreviations dentists normally use such as "pt", "tx", "MOD", "#14"). For each, quote the exact words from the note and give the corrected words. Never change clinical meaning.`;
const PROOF_TOOL = {
  name: 'proofread',
  description: 'Clear spelling and grammar problems in the note.',
  input_schema: {
    type: 'object',
    properties: { issues: { type: 'array', items: { type: 'object', properties: { quote: { type: 'string' }, suggestion: { type: 'string' }, why: { type: 'string' } }, required: ['quote', 'suggestion'] } } },
    required: ['issues'],
  },
};

// The sandbox: decides "mentioned" from the words of the procedure's own description, and reports a tooth mismatch
// when that sentence names a different tooth — enough to exercise every path deterministically.
const sentencesOf = (text) => (String(text).match(/[^.!?\n]+[.!?]?/g) || []).map((s) => s.trim()).filter(Boolean);
const STOP = new Set(['surface', 'surfaces', 'posterior', 'anterior', 'primary', 'permanent', 'first', 'image', 'images', 'tooth', 'teeth', 'including', 'based', 'arch', 'full', 'hard', 'each', 'additional']);
function sandboxCompare({ note, procedures, ask = [] }) {
  const all = sentencesOf(note);
  const out = { procedures: [], mismatches: [] };
  for (const p of procedures) {
    if (ask.length && !ask.includes(p.procedure_id)) continue;
    const words = String(p.description || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5 && !STOP.has(w));
    const hit = all.find((s) => words.some((w) => s.toLowerCase().includes(w.slice(0, 6))));
    out.procedures.push({ procedure_id: p.procedure_id, mentioned: !!hit, quote: hit || '' });
    const teeth = hit ? [...hit.matchAll(/#\s?(\d{1,2}|[A-T])\b/g)].map((m) => m[1]) : [];
    if (hit && p.tooth && teeth.length && !teeth.includes(String(p.tooth))) {
      out.mismatches.push({ kind: 'tooth', procedure_id: p.procedure_id, what: `${p.code} #${p.tooth}`, title: `Tooth differs: chart says #${p.tooth}, note says #${teeth.join(', #')}`, why: 'The note and the chart name different teeth for this work.', quote: hit });
    }
  }
  return out;
}
function sandboxProofread({ text }) {
  const issues = [];
  for (const [re, fix] of [[/\bcould of\b/i, 'could have'], [/\bshould of\b/i, 'should have'], [/\bwould of\b/i, 'would have'], [/\bpatient were\b/i, 'patient was']]) {
    const m = re.exec(text);
    if (m) issues.push({ quote: m[0], suggestion: fix, why: 'Grammar' });
  }
  return { issues };
}

export function createNoteComparer({ config = {}, mode } = {}) {
  mode ??= config.noteCompare || process.env.NOTE_COMPARE || (aiClient(config) ? 'claude' : null);
  if (mode === 'sandbox') {
    return { mode, label: 'AI (sandbox)', compare: async (input) => sandboxCompare(input), proofread: async (input) => sandboxProofread(input) };
  }
  if (mode === 'claude' && aiClient(config)) {
    return {
      mode,
      label: 'Claude',
      async compare({ note, procedures, ask = [] }) {
        const out = await structured(config, {
          system: SYSTEM, tool: TOOL, effort: 'low', maxTokens: 4000,
          content: `Charted and billed at this visit:\n${JSON.stringify(procedures)}\n\nAsk about these procedure_ids: ${JSON.stringify(ask)}\n\nThe note:\n"""\n${String(note).slice(0, 40_000)}\n"""`,
        });
        return { procedures: out.procedures || [], mismatches: out.mismatches || [] };
      },
      async proofread({ text }) {
        const out = await structured(config, { system: PROOF_SYSTEM, tool: PROOF_TOOL, effort: 'low', maxTokens: 2000, content: `"""\n${String(text).slice(0, 20_000)}\n"""` });
        return { issues: out.issues || [] };
      },
    };
  }
  return null;
}
