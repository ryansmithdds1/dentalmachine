import { structured } from './ai.js';

// Dictating into a note template. The dentist talks ("two carpules of articaine, rubber dam, shade A2, small
// ulcer on the left buccal mucosa") and the template fills itself: each [[Label: a|b|c]] question the dictation
// answers is replaced, and anything else that was said is written into the note where it belongs. Nothing is
// invented: questions the dictation doesn't answer stay as questions.
//
// Two layers. quickFill() needs no AI and handles the common answers instantly (an option named outright, a
// number next to its label, "shade B2"). With AI on, aiFill() does the rest: free answers, extra findings in
// the right sentence, corrections where the dictation contradicts the template's default wording.

const PROMPT = /\[\[([^:\]]+):\s*([^\]]*)\]\]/g;
export const prompts = (body) => [...String(body).matchAll(PROMPT)].map((m) => ({ token: m[0], label: m[1].trim(), options: m[2].split('|').map((o) => o.trim()).filter(Boolean) }));

const NUMBERS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5 };
// Words that say nothing about which option was meant.
const WEAK = new Set(['no', 'not', 'none', 'the', 'a', 'an', 'of', 'and', 'or', 'with', 'to', 'for', 'in', 'on', 'at', 'is', 'was', 'placed', 'given', 'applied', 'done', 'needed', 'noted', 'patient', 'see', 'chart', 'only', 'all', 'mm', 'epi']);
const norm = (s) => ` ${String(s).toLowerCase()
  .replace(/%/g, ' percent ')
  .replace(/[^a-z0-9.#/:\s-]/g, ' ')
  .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|half)\b/g, (w) => String(NUMBERS[w]))
  .replace(/\s+/g, ' ')
  .trim()} `;
const words = (s) => norm(s).trim().split(' ').filter(Boolean);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One question answered from the dictation, or null.
function answerOne(p, said) {
  // An option said outright ("rubber dam", "4% articaine") — the longest match wins ("no sutures" over "sutures").
  const whole = p.options.filter((o) => said.includes(norm(o))).sort((a, b) => b.length - a.length)[0];
  if (whole) return whole;
  const label = words(p.label).filter((w) => !WEAK.has(w));
  // A number with its label: "2 carpules", "carpules 2".
  const numeric = p.options.length && p.options.every((o) => /^\d+(\.\d+)?$/.test(o));
  if (numeric || /carpule|number|count|minutes|units|mm/i.test(p.label)) {
    for (const l of label) {
      const stem = escape(l.replace(/s$/, ''));
      const m = new RegExp(` (\\d+(?:\\.\\d+)?) (?:\\w+ ){0,2}${stem}s? `).exec(said) || new RegExp(` ${stem}s? (?:of |is |was )?(\\d+(?:\\.\\d+)?) `).exec(said);
      if (m) return m[1];
    }
  }
  // A word only one option has ("articaine", "isolite", "a2") — distinctive enough to pick it.
  const hits = p.options.filter((o) => {
    const mine = words(o).filter((w) => !WEAK.has(w) && ((w.length >= 4 && /^[a-z]+$/.test(w)) || /^[a-z]\d/.test(w)));
    const others = new Set(p.options.filter((x) => x !== o).flatMap(words));
    return mine.some((w) => !others.has(w) && said.includes(` ${w} `));
  });
  if (hits.length === 1) return hits[0];
  // Teeth: "number 30 MO", "tooth 3", "#14 DO" (several: "30 and 31").
  if (/tooth|teeth/i.test(p.label)) {
    const found = [...said.matchAll(/ (?:#|number |tooth |teeth )(\d{1,2}|[a-t])(?: ([mobdfil]{1,5}))?(?= )/g)]
      .filter((m) => /^[a-t]$/.test(m[1]) || (+m[1] >= 1 && +m[1] <= 32))
      .map((m) => `#${m[1].toUpperCase()}${m[2] ? ` ${m[2].toUpperCase()}` : ''}`);
    if (found.length) return [...new Set(found)].join(', ');
  }
  // "shade B2" when B2 isn't one of the options: the word after the label.
  if (label.length === 1 && /shade|material|cement|bur|size|suture/i.test(p.label)) {
    const m = new RegExp(` ${escape(label[0])} (?:is |of |was )?([a-z]?\\d[a-z0-9.]*|[a-z]\\d) `).exec(said);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

export function quickFill(body, dictation) {
  const said = norm(dictation);
  let out = String(body);
  const filled = [];
  for (const p of prompts(out)) {
    const value = answerOne(p, said);
    if (value == null) continue;
    out = out.replace(p.token, value);
    filled.push({ label: p.label, value });
  }
  return { body: out, filled, unanswered: prompts(out).map((p) => p.label) };
}

const SYSTEM = `You update a dental clinical note from the dentist's dictation. The note is usually one of the office's templates; questions in it look like [[Label: option 1|option 2|option 3]].
- Replace a question with the option the dictation chose, word for word. If the dictation answers it with something that isn't an option (a different shade, "3 carpules", a material), write what was said, in the note's style.
- Leave a question exactly as it is when the dictation doesn't answer it. Never guess an answer.
- Put everything else that was dictated (findings, what was done, complications, what the patient was told, the next visit) into the sentence or section where it belongs, written the way the rest of the note is written. Keep it clinical and brief.
- If the dictation contradicts something the template already says (e.g. the template says "Soft tissue WNL" but the dentist describes a lesion), change that text to match the dictation and list the change.
- Never add anything that wasn't dictated. Don't remove or reword anything else.
- The dictation is speech-to-text: fix obvious mis-hearings of dental terms, drug names and tooth numbers ("articane" → articaine, "number thirty" → #30, "M O D" → MOD). Ignore filler and anything said to the software itself ("okay", "new line", "that's it").
- Teeth use Universal numbering (#1-32, A-T).`;

const TOOL = {
  name: 'update_note',
  description: 'The note with the dictation worked in.',
  input_schema: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'The full updated note, including any [[...]] questions left unanswered.' },
      filled: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'] }, description: 'Questions answered.' },
      added: { type: 'array', items: { type: 'string' }, description: 'Short phrases for what was added from the dictation.' },
      changed: { type: 'array', items: { type: 'string' }, description: 'Template wording changed because the dictation contradicted it (before → after).' },
    },
    required: ['note', 'filled', 'added', 'changed'],
  },
};

export async function aiFill(config, { body, dictation, patient }) {
  const out = await structured(config, {
    system: SYSTEM, tool: TOOL, effort: 'low', maxTokens: 6000,
    content: `Patient: ${patient}\n\nCurrent note:\n"""\n${body}\n"""\n\nDictation:\n"""\n${dictation}\n"""`,
  });
  const note = String(out.note ?? out.text ?? '').trim();
  if (!note) return null;
  return {
    body: note.slice(0, 20000),
    filled: (out.filled || []).slice(0, 50).map((f) => ({ label: String(f.label).slice(0, 80), value: String(f.value).slice(0, 200) })),
    added: (out.added || []).slice(0, 30).map((a) => String(a).slice(0, 200)),
    changed: (out.changed || []).slice(0, 30).map((c) => String(c).slice(0, 300)),
    unanswered: prompts(note).map((p) => p.label),
  };
}
