// Charting by typing, the way a dentist calls it out to the assistant:
//   "30 MO caries"        → caries on #30, mesial and occlusal
//   "14 D2740"            → a planned crown on #14 (any CDT code)
//   "2-4 sealant plan"    → planned sealants on #2, #3 and #4
//   "3 crown"             → an existing crown on #3 (other office)
//   "19 rct done"         → a root canal completed today
//   "1, 16, 17, 32 missing; 8 watch"
// Several entries can be separated by ";" or a new line. Primary teeth take a # ("#K O caries") so they don't
// read as surfaces.
import { isPosterior, baseTooth } from '../teeth.js';

// Findings that are always conditions.
const FINDINGS = {
  caries: 'caries', decay: 'caries', cavity: 'caries', dc: 'caries',
  missing: 'missing', mx: 'missing', fracture: 'fracture', fractured: 'fracture', fx: 'fracture', cracked: 'fracture', crack: 'fracture',
  abscess: 'abscess', pa: 'abscess', impacted: 'impacted', watch: 'watch', monitor: 'watch', mobility: 'mobility', mobile: 'mobility',
};
// Work that's a condition when it's already there ("existing") and a procedure when planned or done.
const WORK = {
  filling: 'filling', fill: 'filling', restoration: 'filling', composite: 'filling', amalgam: 'filling', resto: 'filling',
  crown: 'crown', cr: 'crown', rct: 'root_canal', endo: 'root_canal', root_canal: 'root_canal',
  implant: 'implant', pontic: 'bridge_pontic', bridge: 'bridge_pontic', sealant: 'sealant', sealants: 'sealant', veneer: 'veneer',
};
// Planned-only work (never a condition).
const ONLY_PROC = { ext: 'extraction', extraction: 'extraction', extract: 'extraction', xla: 'extraction', post: 'post', buildup: 'buildup', bu: 'buildup' };
const PLANNED = new Set(['plan', 'planned', 'tx', 'treat', 'needs', 'need']);
const DONE = new Set(['done', 'completed', 'complete', 'today', 'finished']);
const EXISTING = new Set(['existing', 'ex', 'old', 'previous']);

// The CDT code for planned or completed work, chosen from the tooth and surfaces.
export function codeFor(work, tooth, surfaces = '', { surgical = false } = {}) {
  const n = (surfaces || '').replace(/[^MODBLFI]/g, '').length;
  const posterior = tooth ? isPosterior(tooth) : true;
  const b = Number(baseTooth(tooth || ''));
  const molar = [1, 2, 3, 14, 15, 16, 17, 18, 19, 30, 31, 32].includes(b);
  switch (work) {
    case 'filling':
      if (posterior) return ['D2391', 'D2391', 'D2392', 'D2393', 'D2394'][Math.min(n, 4)];
      return ['D2330', 'D2330', 'D2331', 'D2332', 'D2335'][Math.min(n, 4)];
    case 'crown': return 'D2740';
    case 'root_canal': return molar ? 'D3330' : posterior ? 'D3320' : 'D3310';
    case 'implant': return 'D6010';
    case 'bridge_pontic': return 'D6240';
    case 'sealant': return 'D1351';
    case 'veneer': return 'D2962';
    case 'extraction': return surgical ? 'D7210' : 'D7140';
    case 'post': return 'D2954';
    case 'buildup': return 'D2950';
    default: return null;
  }
}

const TOOTH = /^#?(\d{1,2})$/;
const RANGE = /^#?(\d{1,2})-(\d{1,2})$/;
const PRIMARY = /^#([A-T])$/i;
const validPerm = (n) => (n >= 1 && n <= 32) || (n >= 51 && n <= 82);

function teethFrom(tokens) {
  const teeth = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    let m;
    if ((m = RANGE.exec(t))) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (!validPerm(a) || !validPerm(b)) throw new Error(`#${t} isn't a tooth`);
      // Ranges run along the arch the short way: 2-4, 19-21, and 30-28 backwards too.
      const step = a <= b ? 1 : -1;
      for (let n = a; n !== b + step; n += step) teeth.push(String(n));
    } else if ((m = TOOTH.exec(t))) {
      if (!validPerm(Number(m[1]))) throw new Error(`#${m[1]} isn't a tooth`);
      teeth.push(String(Number(m[1])));
    } else if ((m = PRIMARY.exec(t))) {
      teeth.push(m[1].toUpperCase());
    } else break;
  }
  return { teeth, rest: tokens.slice(i) };
}

// One entry → a list of things to chart: { type: 'condition', tooth, surfaces, condition } or
// { type: 'procedure', tooth, surfaces, code, complete }.
export function parseEntry(text) {
  const tokens = String(text).trim().replace(/root canal/gi, 'root_canal').split(/[\s,]+/).filter(Boolean);
  if (!tokens.length) return [];
  const { teeth, rest } = teethFrom(tokens);
  let surfaces = '';
  let code = null;
  let finding = null;
  let work = null;
  let mode = null;
  let surgical = false;
  const unknown = [];
  for (const raw of rest) {
    const w = raw.toLowerCase();
    if (/^d\d{4}$/.test(w)) code = w.toUpperCase();
    else if (FINDINGS[w]) finding = FINDINGS[w];
    else if (WORK[w]) work = WORK[w];
    else if (ONLY_PROC[w]) { work = ONLY_PROC[w]; mode = mode || 'planned'; }
    else if (w === 'surgical') surgical = true;
    else if (PLANNED.has(w)) mode = 'planned';
    else if (DONE.has(w)) mode = 'done';
    else if (EXISTING.has(w)) mode = 'existing';
    else if (/^[modblfi]{1,5}$/.test(w) && !surfaces) surfaces = w.toUpperCase();
    else unknown.push(raw);
  }
  if (unknown.length) throw new Error(`Didn't understand “${unknown.join(' ')}”`);
  if (!code && !finding && !work) throw new Error('Say what to chart: a finding (caries, missing…), work (crown, filling, rct…) or a code (D2740)');
  if (!teeth.length && !code) throw new Error('Start with the tooth number, e.g. “30 MO caries”');
  const out = [];
  for (const tooth of teeth.length ? teeth : [null]) {
    if (finding) out.push({ type: 'condition', tooth, surfaces: surfaces || null, condition: finding });
    else if (code || (work && mode && mode !== 'existing') || (work && ONLY_PROC[work])) {
      const c = code || codeFor(work, tooth, surfaces, { surgical });
      out.push({ type: 'procedure', tooth, surfaces: surfaces || null, code: c, complete: mode === 'done' });
    } else if (work && ['extraction', 'post', 'buildup'].includes(work)) {
      out.push({ type: 'procedure', tooth, surfaces: surfaces || null, code: codeFor(work, tooth, surfaces, { surgical }), complete: false });
    } else {
      // Work with no "plan"/"done": it's already in the mouth.
      out.push({ type: 'condition', tooth, surfaces: surfaces || null, condition: work });
    }
  }
  return out;
}

export function parseShorthand(text) {
  return String(text).split(/[;\n]+/).map((s) => s.trim()).filter(Boolean).flatMap(parseEntry);
}

// "#30 MO caries", "#14 D2740 planned" — for the confirmation toast.
export const describe = (item) => `${item.tooth ? `#${item.tooth} ` : ''}${item.surfaces ? `${item.surfaces} ` : ''}${item.type === 'condition' ? item.condition.replace('_', ' ') : `${item.code}${item.complete ? ' done' : ' planned'}`}`;
