// The chart-entry engine: one place that turns what someone types, says, clicks or presses into the list of
// things to chart. Chart-by-typing ("30 MO caries", "14 crb", "np"), the quick buttons and their Alt+1…9
// hotkeys, bundles and the voice assistant ("crown bundle on 14 with buildup, plan it") all come through here,
// so the same words chart the same way whichever way they arrive.
//
// It runs in the browser (the instant preview; client/src/components/patient/chartShorthand.js re-exports it)
// and on the server (POST /charting/resolve for the assistant, and the chart call re-checks every item), so it
// has no imports and no side effects: plain data in, plain data out. Errors are plain Errors with a message
// written for office staff.
//
// An item is { type: 'condition', tooth, surfaces, condition } or { type: 'procedure', tooth, surfaces, code,
// complete }, plus area (quadrant/arch codes), phase and bundle when they apply.

// ---- Teeth (the same facts as client/src/components/teeth.js; server/test/treatmententry.test.js checks) ----
const POSTERIOR = new Set(['1', '2', '3', '4', '5', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '28', '29', '30', '31', '32', 'A', 'B', 'I', 'J', 'K', 'L', 'S', 'T']);
const MOLARS = new Set(['1', '2', '3', '14', '15', '16', '17', '18', '19', '30', '31', '32', 'A', 'B', 'I', 'J', 'K', 'L', 'S', 'T']);
export const baseTooth = (t) => {
  const s = String(t).toUpperCase();
  if (/^[A-T]S$/.test(s)) return s[0];
  const n = Number(s);
  return n >= 51 && n <= 82 ? String(n - 50) : s;
};
export const isPosterior = (t) => POSTERIOR.has(baseTooth(t));
export const isMolar = (t) => MOLARS.has(baseTooth(t));
// First and second permanent molars: the teeth sealants are for (wisdom teeth aren't sealed).
export const SEALABLE_MOLARS = ['2', '3', '14', '15', '18', '19', '30', '31'];

// Quadrant and arch codes: the same rule as codeArea() in util.js (the server also honours a code's own area).
export const QUADRANTS = ['UR', 'UL', 'LL', 'LR'];
export const ARCHES = ['U', 'L'];
const QUADRANT_CODES = /^D(434[12]|42[0-6]\d)$/;
const ARCH_CODES = /^D(51[1-4]0|52[1-2][1-4]|54[1-2][1-2]|57[3-6]\d|5863|5865)$/;
export const areaKind = (code) => (QUADRANT_CODES.test(code || '') ? 'quadrant' : ARCH_CODES.test(code || '') ? 'arch' : null);

// ---- Words ----
// Findings that are always conditions.
const FINDINGS = {
  caries: 'caries', decay: 'caries', cavity: 'caries', dc: 'caries',
  missing: 'missing', mx: 'missing', fracture: 'fracture', fractured: 'fracture', fx: 'fracture', cracked: 'fracture', crack: 'fracture',
  abscess: 'abscess', pa: 'abscess', impacted: 'impacted', watch: 'watch', monitor: 'watch', mobility: 'mobility', mobile: 'mobility',
};
// Work that's a condition when it's already there ("existing") and a procedure when planned or done.
const WORK = {
  filling: 'filling', fillings: 'filling', fill: 'filling', restoration: 'filling', composite: 'filling', amalgam: 'filling', resto: 'filling',
  crown: 'crown', crowns: 'crown', cr: 'crown', rct: 'root_canal', endo: 'root_canal', root_canal: 'root_canal',
  implant: 'implant', implants: 'implant', pontic: 'bridge_pontic', bridge: 'bridge_pontic', sealant: 'sealant', sealants: 'sealant', veneer: 'veneer', veneers: 'veneer',
};
// Planned-only work (never a condition).
const ONLY_PROC = {
  ext: 'extraction', extraction: 'extraction', extractions: 'extraction', extract: 'extraction', xla: 'extraction', post: 'post', buildup: 'buildup', bu: 'buildup',
  bone_graft: 'bone_graft', graft: 'bone_graft', abutment: 'implant_abutment', implant_crown: 'implant_crown', retainer: 'bridge_retainer',
};
const PLANNED = new Set(['plan', 'planned', 'tx', 'treat', 'needs', 'need']);
const DONE = new Set(['done', 'completed', 'complete', 'today', 'finished']);
const EXISTING = new Set(['existing', 'ex', 'old', 'previous']);
// Said aloud (or typed by habit) around the words that matter: "crown bundle on tooth 14, plan it".
const FILLER = new Set(['on', 'it', 'the', 'a', 'an', 'please', 'for', 'and', 'plus', 'also', 'then', 'of', 'at', 'in', 'to', 'patient’s', 'patients', 'let’s', 'lets', 'go', 'ahead']);
const NEGATE = new Set(['no', 'without', 'skip', 'minus', 'except']);
const AREA_WORDS = { ur: 'UR', ul: 'UL', ll: 'LL', lr: 'LR', upper: 'U', lower: 'L', maxillary: 'U', mandibular: 'L' };
const PHRASES = [
  [/\broot canals?\b/gi, 'root_canal'],
  [/\bbone grafts?\b/gi, 'bone_graft'],
  [/\bimplant crowns?\b/gi, 'implant_crown'],
  [/\b(?:core )?build[ -]?ups?\b/gi, 'buildup'],
  [/\b(\d{1,2})\s+(?:to|through|thru)\s+(\d{1,2})\b/gi, '$1-$2'],
  [/\b(?:tooth|teeth|number|numbers|num)\s+(?=#?\d|#[a-t]\b)/gi, ''],
];

// Everything the engine can make, for checking bundles and buttons.
export const WORK_KINDS = ['filling', 'crown', 'root_canal', 'implant', 'bridge_pontic', 'bridge_retainer', 'sealant', 'veneer', 'extraction', 'post', 'buildup', 'bone_graft', 'implant_abutment', 'implant_crown'];
export const FINDING_KINDS = ['caries', 'missing', 'filling', 'crown', 'root_canal', 'implant', 'bridge_pontic', 'fracture', 'sealant', 'veneer', 'impacted', 'watch', 'abscess', 'mobility'];
const CONDITION_OF_WORK = new Set(['filling', 'crown', 'root_canal', 'implant', 'bridge_pontic', 'sealant', 'veneer']);
export const TOOTH_RULES = ['same', 'range', 'ends', 'between', 'none', 'unsealed_molars'];

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
    case 'bridge_retainer': return 'D6750';
    case 'implant_abutment': return 'D6057';
    case 'implant_crown': return 'D6065';
    case 'bone_graft': return 'D7953';
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
const REF = '\u0001';

// A tooth token → teeth, or null when it isn't one.
function toothToken(t) {
  let m;
  if ((m = RANGE.exec(t))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (!validPerm(a) || !validPerm(b)) throw new Error(`#${t} isn't a tooth`);
    // Ranges run along the arch the short way: 2-4, 19-21, and 30-28 backwards too.
    const step = a <= b ? 1 : -1;
    const out = [];
    for (let n = a; n !== b + step; n += step) out.push(String(n));
    return out;
  }
  if ((m = TOOTH.exec(t))) {
    if (!validPerm(Number(m[1]))) throw new Error(`#${m[1]} isn't a tooth`);
    return [String(Number(m[1]))];
  }
  if ((m = PRIMARY.exec(t))) return [m[1].toUpperCase()];
  return null;
}

function teethFrom(tokens) {
  const teeth = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = toothToken(tokens[i]);
    if (!t) break;
    teeth.push(...t);
  }
  return { teeth, rest: tokens.slice(i) };
}

// ---- Aliases and bundle names ----
const clean = (s) => String(s || '').replace(/[‘’]/g, '’').trim();
const wordsOf = (s) => {
  let t = clean(s);
  for (const [re, to] of PHRASES) t = t.replace(re, to);
  return t.split(/[\s,.:!?]+/).filter(Boolean).map((w) => w.toLowerCase()).filter((w) => !FILLER.has(w));
};
const builtinWord = (w) => w in FINDINGS || w in WORK || w in ONLY_PROC || PLANNED.has(w) || DONE.has(w) || EXISTING.has(w) || w in AREA_WORDS || w === 'surgical' || /^[modblfi]{1,5}$/.test(w);

// What the practice and this person have set up: { bundles, shortcuts } (as GET /chart-shortcuts returns
// them) → the phrases the parser recognises. A person's own alias beats the office's, and an alias beats a
// bundle's name. Built once per set-up and reused (pass it back as ctx.lookups).
export function buildLookups({ bundles = [], shortcuts = [] } = {}) {
  const phrases = new Map();
  const put = (text, ref) => {
    const words = wordsOf(text);
    if (words.length) phrases.set(words.join(' '), { ...ref, words });
  };
  const live = (bundles || []).filter((b) => b && b.active !== 0 && b.active !== false);
  for (const b of live) {
    const words = wordsOf(b.name);
    // "crown" stays the word for a crown; the Crown bundle is "crown bundle" (the word bundle is filler), its alias or its button.
    if (words.length > 1 || (words.length === 1 && !builtinWord(words[0]))) put(b.name, { kind: 'bundle', bundle: b });
    put(`${b.name} bundle`, { kind: 'bundle', bundle: b });
    put(`bundle ${b.name}`, { kind: 'bundle', bundle: b });
  }
  for (const b of live) if (b.alias) put(b.alias, { kind: 'bundle', bundle: b });
  const byId = new Map(live.map((b) => [Number(b.id), b]));
  const sorted = [...(shortcuts || [])].filter((s) => s && s.alias && s.active !== 0 && s.active !== false).sort((a, b) => (a.user_id ? 1 : 0) - (b.user_id ? 1 : 0));
  for (const s of sorted) {
    const ref = shortcutRef(s, byId);
    if (ref) put(s.alias, ref);
  }
  return { phrases: [...phrases.values()].sort((a, b) => b.words.length - a.words.length), refs: [] };
}

// A quick button or alias → what it stands for.
export function shortcutRef(s, bundlesById) {
  const mode = { plan: 'planned', done: 'done', existing: 'existing' }[s.mode] || null;
  if (s.kind === 'bundle') {
    const bundle = bundlesById instanceof Map ? bundlesById.get(Number(s.target)) : null;
    return bundle ? { kind: 'bundle', bundle, mode } : null;
  }
  if (s.kind === 'code') return { kind: 'code', code: String(s.target).toUpperCase(), mode, surfaces: s.surfaces || null };
  if (s.kind === 'work') return { kind: 'work', work: s.target, mode, surfaces: s.surfaces || null };
  if (s.kind === 'finding') return { kind: 'finding', finding: s.target, surfaces: s.surfaces || null };
  return null;
}

function tokenize(text, lookups) {
  let s = clean(text);
  for (const [re, to] of PHRASES) s = s.replace(re, to);
  const raw = s.split(/[\s,.:!?]+/).filter(Boolean).filter((w) => !FILLER.has(w.toLowerCase()));
  if (!lookups?.phrases?.length) return raw;
  const out = [];
  for (let i = 0; i < raw.length;) {
    const hit = lookups.phrases.find((p) => p.words.every((w, j) => raw[i + j]?.toLowerCase() === w));
    if (hit) {
      lookups.refs.push(hit);
      out.push(`${REF}${lookups.refs.length - 1}`);
      i += hit.words.length;
    } else out.push(raw[i++]);
  }
  return out;
}

// ---- Surfaces and areas ----
// Posterior teeth have an occlusal surface and anterior teeth an incisal edge; one can't have the other.
export function surfaceProblem(tooth, surfaces) {
  if (!tooth || !surfaces) return null;
  const s = String(surfaces).toUpperCase();
  if (isPosterior(tooth) && s.includes('I')) return `#${tooth} is a back tooth: it has an occlusal (O) surface, not incisal (I)`;
  if (!isPosterior(tooth) && s.includes('O')) return `#${tooth} is a front tooth: it has an incisal (I) edge, not occlusal (O)`;
  return null;
}

// A bridge from its end teeth: retainers on the ends, pontics between, along one arch.
function bridgeSpan(teeth) {
  const nums = teeth.map(Number);
  if (teeth.length < 2 || nums.some((n) => !(n >= 1 && n <= 32))) throw new Error('A bridge runs between two permanent teeth on one arch, e.g. “3-5 bridge plan”');
  const [a, b] = [nums[0], nums.at(-1)];
  if ((a <= 16) !== (b <= 16)) throw new Error('A bridge runs along one arch: both ends upper (1-16) or both lower (17-32)');
  const step = a <= b ? 1 : -1;
  const out = [];
  for (let n = a; n !== b + step; n += step) out.push(String(n));
  if (out.length < 3) throw new Error('A bridge needs at least 3 teeth (two retainers and a pontic), e.g. “3-5 bridge plan”');
  return out;
}

// First and second permanent molars with nothing on them yet (no sealant, restoration, or planned work).
export function unsealedMolars(chart) {
  if (!chart) throw new Error('Name the teeth for sealants, e.g. “3, 14 sealant plan”');
  const blocked = new Set();
  for (const c of chart.conditions || []) {
    if (!c.resolved && !c.voided_at && ['missing', 'sealant', 'filling', 'crown', 'implant', 'root_canal', 'bridge_pontic', 'impacted', 'caries', 'fracture'].includes(c.condition)) blocked.add(String(c.tooth));
  }
  for (const p of chart.procedures || []) {
    if (p.status !== 'cancelled' && p.tooth && /^D(135|2|3|6|7)/.test(p.code || '')) blocked.add(String(p.tooth));
  }
  const teeth = SEALABLE_MOLARS.filter((t) => !blocked.has(t));
  if (!teeth.length) throw new Error('No unsealed permanent molars on this chart');
  return teeth;
}

// ---- Bundles ----
const itemLabel = (it) => it.label || it.area || (it.work ? it.work.replace(/_/g, ' ') : it.finding || it.code || '');
// The optional parts of a bundle and whether each is on: [{ index, label, on }].
export function bundleOptions(bundle, options = new Map()) {
  return (bundle.items || []).map((it, index) => ({ index, label: itemLabel(it), on: !it.optional || (options.has(index) ? options.get(index) : !!it.default_on), optional: !!it.optional }))
    .filter((o) => o.optional);
}

// A word said about a bundle ("with buildup", "no post", "UR") → which of its items it means.
function bundleItemFor(bundle, w) {
  const word = w.toLowerCase();
  const work = WORK[word] || ONLY_PROC[word] || word;
  return (bundle.items || []).findIndex((it) => (it.label && it.label.toLowerCase() === word) || (it.work && it.work === work) || (it.code && it.code.toLowerCase() === word) || (it.area && it.area.toLowerCase() === word));
}

// One bundle → the items to chart. teeth: what was typed or selected; options: Map(index → on/off) for the
// optional parts; mode: 'planned' | 'done'; chart: the patient's chart (for rules like unsealed molars).
export function expandBundle(bundle, { teeth = [], surfaces = '', options = new Map(), mode = 'planned', chart = null } = {}) {
  const items = bundle.items || [];
  const on = (it, i) => !it.optional || (options.has(i) ? options.get(i) : !!it.default_on);
  const live = items.map((it, i) => [it, i]).filter(([it, i]) => on(it, i));
  if (!live.length) throw new Error(`Everything in ${bundle.name} is switched off`);
  const needsTeeth = live.some(([it]) => ['same', 'range', 'ends', 'between'].includes(it.tooth || 'same') && !it.area);
  const call = bundle.alias || String(bundle.name || '').toLowerCase();
  if (needsTeeth && !teeth.length) throw new Error(`Say which tooth for ${bundle.name}, e.g. “14 ${call}”`);
  if (teeth.length && !live.some(([it]) => !it.area && (it.tooth || 'same') !== 'none')) throw new Error(`${bundle.name} isn't charted on a tooth: leave the tooth number out`);
  const span = live.some(([it]) => ['ends', 'between'].includes(it.tooth)) ? bridgeSpan(teeth) : null;
  const phased = new Set(live.map(([it]) => Number(it.phase) || 1)).size > 1;
  const out = [];
  for (const [it] of live) {
    const rule = it.area ? 'none' : it.tooth || 'same';
    const where = rule === 'none' ? [null]
      : rule === 'ends' ? [span[0], span.at(-1)]
        : rule === 'between' ? span.slice(1, -1)
          : rule === 'unsealed_molars' ? (teeth.length ? teeth : unsealedMolars(chart))
            : teeth;
    for (const tooth of where) {
      const surf = it.surfaces === 'same' ? surfaces || null : it.surfaces && it.surfaces !== 'none' ? String(it.surfaces).toUpperCase() : null;
      if (it.finding) {
        out.push({ type: 'condition', tooth, surfaces: surf, condition: it.finding, bundle: bundle.name });
        continue;
      }
      const item = { type: 'procedure', tooth, surfaces: surf, code: it.code ? String(it.code).toUpperCase() : codeFor(it.work, tooth, surf || ''), complete: mode === 'done' };
      if (it.area) item.area = it.area;
      if (phased) item.phase = Number(it.phase) || 1;
      item.bundle = bundle.name;
      if (it.optional) item.optional = true;
      out.push(item);
    }
  }
  return out;
}

// Checks a bundle as someone saves it; returns it cleaned up, or throws with what's wrong.
export function checkBundle(input) {
  const name = String(input?.name || '').trim().slice(0, 60);
  if (!name) throw new Error('Give the bundle a name');
  const alias = input?.alias == null || String(input.alias).trim() === '' ? null : String(input.alias).trim().toLowerCase();
  if (alias && !/^[a-z][a-z0-9]{0,11}$/.test(alias)) throw new Error('An alias is one short word: letters and digits, starting with a letter (e.g. np, crb)');
  if (alias && builtinWord(alias)) throw new Error(`“${alias}” already means something when charting; pick another alias`);
  const raw = typeof input?.items === 'string' ? JSON.parse(input.items) : input?.items;
  if (!Array.isArray(raw) || !raw.length) throw new Error('A bundle needs at least one procedure');
  if (raw.length > 20) throw new Error('A bundle can have up to 20 items');
  const items = raw.map((it, i) => {
    const n = i + 1;
    const out = {};
    const kinds = ['code', 'work', 'finding'].filter((k) => it?.[k]);
    if (kinds.length !== 1) throw new Error(`Item ${n}: choose a code, a kind of work or a finding`);
    if (it.code) {
      out.code = String(it.code).trim().toUpperCase();
      if (!/^D\d{4}$/.test(out.code)) throw new Error(`Item ${n}: ${out.code} isn't a CDT code (D followed by 4 digits)`);
    }
    if (it.work) {
      if (!WORK_KINDS.includes(it.work)) throw new Error(`Item ${n}: unknown kind of work “${it.work}”`);
      out.work = it.work;
    }
    if (it.finding) {
      if (!FINDING_KINDS.includes(it.finding)) throw new Error(`Item ${n}: unknown finding “${it.finding}”`);
      out.finding = it.finding;
    }
    const kind = out.code ? areaKind(out.code) : null;
    const area = it.area == null || it.area === '' ? null : String(it.area).toUpperCase();
    if (area && !(kind === 'arch' ? ARCHES : kind === 'quadrant' ? QUADRANTS : [...QUADRANTS, ...ARCHES]).includes(area)) throw new Error(`Item ${n}: ${area} isn't a ${kind || 'quadrant or arch'}`);
    if (kind && !area) throw new Error(`Item ${n}: ${out.code} is charted by ${kind}; choose which`);
    if (area) out.area = area;
    out.tooth = area ? 'none' : it.tooth || 'same';
    if (!TOOTH_RULES.includes(out.tooth)) throw new Error(`Item ${n}: tooth must be one of ${TOOTH_RULES.join(', ')}`);
    if (out.finding && out.tooth === 'none') throw new Error(`Item ${n}: a finding needs a tooth`);
    const surf = it.surfaces == null || it.surfaces === '' ? 'none' : String(it.surfaces);
    if (surf !== 'none' && surf !== 'same' && !/^[MODBLFI]{1,5}$/i.test(surf)) throw new Error(`Item ${n}: surfaces must be none, same, or letters from M O D B L F I`);
    if (surf !== 'none') out.surfaces = surf === 'same' ? 'same' : surf.toUpperCase();
    if (it.optional) {
      out.optional = true;
      out.default_on = !!it.default_on;
    }
    const phase = it.phase == null || it.phase === '' ? 1 : Number(it.phase);
    if (!Number.isInteger(phase) || phase < 1 || phase > 9) throw new Error(`Item ${n}: phase must be 1-9`);
    if (phase > 1) out.phase = phase;
    if (it.label) out.label = String(it.label).trim().toLowerCase().slice(0, 30);
    return out;
  });
  const hasEnds = items.some((it) => it.tooth === 'ends');
  if (hasEnds !== items.some((it) => it.tooth === 'between')) throw new Error('A bridge-style bundle needs both an “ends” item (retainers) and a “between” item (pontics)');
  return { name, alias, items };
}

// ---- Parsing ----
// One entry → a list of things to chart. ctx (all optional): lookups from buildLookups (aliases and bundles),
// chart (the patient's conditions and procedures), defaultMode ('planned' when comparing options).
export function parseEntry(text, ctx = {}) {
  return readEntry(text, ctx).items;
}

function readEntry(text, ctx = {}) {
  const lookups = ctx.lookups ? { ...ctx.lookups, refs: [] } : null;
  const tokens = tokenize(text, lookups);
  if (!tokens.length) return { items: [] };
  const { teeth, rest } = teethFrom(tokens);
  const refOf = (t) => (t.startsWith(REF) ? lookups.refs[Number(t.slice(1))] : null);
  const bundleRefs = rest.map(refOf).filter((r) => r?.kind === 'bundle');
  if (new Set(bundleRefs.map((r) => r.bundle)).size > 1) throw new Error('One bundle per entry: separate them with ;');
  const bundle = bundleRefs[0]?.bundle || null;
  let surfaces = '';
  const codes = [];
  const findings = [];
  const works = [];
  const areas = [];
  let mode = null;
  let impliedPlan = false;
  let aliasMode = null;
  let aliasSurfaces = null;
  let surgical = false;
  let bridgeWord = false;
  let negate = false;
  const options = new Map();
  const unknown = [];
  for (const raw of rest) {
    const ref = refOf(raw);
    if (ref) {
      if (ref.kind === 'code') codes.push(ref.code);
      if (ref.kind === 'work') works.push(ref.work);
      if (ref.kind === 'finding') findings.push(ref.finding);
      if (ref.mode) aliasMode = aliasMode || ref.mode;
      if (ref.surfaces) aliasSurfaces = aliasSurfaces || ref.surfaces;
      negate = false;
      continue;
    }
    const w = raw.toLowerCase();
    if (w === 'with' || (w === 'bundle' && bundle)) { negate = false; continue; }
    if (NEGATE.has(w)) { negate = true; continue; }
    if (bundle) {
      const i = bundleItemFor(bundle, w);
      if (i >= 0) {
        if (bundle.items[i].optional) options.set(i, !negate);
        negate = false;
        continue;
      }
    }
    if (negate) throw new Error(bundle ? `${bundle.name} has no “${raw}” to leave out` : `Didn't understand “no ${raw}”`);
    const t = toothToken(raw);
    if (t) teeth.push(...t);
    else if (/^d\d{4}$/.test(w)) codes.push(w.toUpperCase());
    else if (FINDINGS[w]) findings.push(FINDINGS[w]);
    else if (WORK[w]) { works.push(WORK[w]); if (w === 'bridge') bridgeWord = true; }
    else if (ONLY_PROC[w]) { works.push(ONLY_PROC[w]); impliedPlan = true; }
    else if (w === 'surgical') surgical = true;
    else if (PLANNED.has(w)) mode = 'planned';
    else if (DONE.has(w)) mode = 'done';
    else if (EXISTING.has(w)) mode = 'existing';
    else if (AREA_WORDS[w] && (w !== 'll' || codes.some(areaKind) || bundle)) areas.push(AREA_WORDS[w]);
    else if (/^[modblfi]{1,5}$/.test(w) && !surfaces) surfaces = w.toUpperCase();
    else unknown.push(raw);
  }
  if (unknown.length) throw new Error(`Didn't understand “${unknown.join(' ')}”`);
  surfaces = surfaces || (aliasSurfaces ? String(aliasSurfaces).toUpperCase() : '');
  // Said in the entry beats an alias's own mode ("bu" = plan it); planned-only work (ext, buildup) is planned.
  mode = mode || aliasMode || (impliedPlan ? 'planned' : null) || ctx.defaultMode || null;
  const out = [];
  if (bundle) {
    if (mode === 'existing') throw new Error(`${bundle.name} can be planned or done, not charted as existing`);
    mode = mode || 'planned';
    out.push(...expandBundle(bundle, { teeth, surfaces, options, mode, chart: ctx.chart }));
    if (!findings.length && !works.length && !codes.length) return { items: out, bundle: { bundle, options } };
  }
  if (!codes.length && !findings.length && !works.length) throw new Error('Say what to chart: a finding (caries, missing…), work (crown, filling, rct…) or a code (D2740)');
  const areaCodes = codes.filter((c) => areaKind(c));
  if (areaCodes.length && !areas.length) throw new Error(`${areaCodes[0]} is charted by ${areaKind(areaCodes[0])}: add ${areaKind(areaCodes[0]) === 'arch' ? 'upper or lower' : 'UR, UL, LL or LR'}`);
  if (areas.length && !codes.length) throw new Error(`${areas.join(', ')} goes with a quadrant or arch code, e.g. “D4341 UR”`);
  const toothCodes = codes.filter((c) => !(areas.length && (areaKind(c) || !teeth.length)));
  if (!teeth.length && !codes.length) throw new Error('Start with the tooth number, e.g. “30 MO caries”');
  // A bridge said as "3-5 bridge": retainers on the ends, pontics between (a lone "pontic" is just pontics).
  const bridge = bridgeWord && works.includes('bridge_pontic') && mode && mode !== 'existing' && teeth.length > 1;
  const span = bridge ? bridgeSpan(teeth) : null;
  const complete = mode === 'done';
  for (const area of areas) {
    for (const code of codes.filter((c) => areaKind(c) || !teeth.length)) out.push({ type: 'procedure', tooth: null, surfaces: null, code, complete, area });
  }
  for (const tooth of span || (teeth.length ? teeth : toothCodes.length ? [null] : [])) {
    for (const finding of findings) out.push({ type: 'condition', tooth, surfaces: surfaces || null, condition: finding });
    for (const work of works) {
      if (bridge && work === 'bridge_pontic') {
        const end = tooth === span[0] || tooth === span.at(-1);
        out.push({ type: 'procedure', tooth, surfaces: null, code: codeFor(end ? 'bridge_retainer' : 'bridge_pontic', tooth), complete });
      } else if (mode === 'existing' || (!mode && CONDITION_OF_WORK.has(work))) {
        // Work with no "plan"/"done": it's already in the mouth.
        if (!CONDITION_OF_WORK.has(work)) throw new Error(`${work.replace(/_/g, ' ')} can be planned or done, not charted as existing`);
        out.push({ type: 'condition', tooth, surfaces: surfaces || null, condition: work });
      } else {
        out.push({ type: 'procedure', tooth, surfaces: surfaces || null, code: codeFor(work, tooth, surfaces, { surgical }), complete });
      }
    }
    for (const code of toothCodes) out.push({ type: 'procedure', tooth, surfaces: surfaces || null, code, complete });
  }
  return { items: out, bundle: bundle ? { bundle, options } : null };
}

export function parseShorthand(text, ctx = {}) {
  return String(text).split(/[;\n]+/).map((s) => s.trim()).filter(Boolean).flatMap((s) => parseEntry(s, ctx));
}

// ---- Comparing options ("option one, extraction and bone graft on 19; option two, root canal, buildup and crown") ----
const OPTION_MARK = /\b(?:option|opt|choice|alternative)\s*#?\s*(one|two|three|four|1|2|3|4|a|b|c|d)\b\s*[:,-]?/gi;
export const isComparison = (text) => {
  const s = String(text || '');
  const marks = s.match(OPTION_MARK) || [];
  return marks.length >= 2 || /\b(compare|comparing|versus|vs)\b/i.test(s);
};

export function parseOptions(text, ctx = {}) {
  const s = String(text || '');
  let segments;
  if ((s.match(OPTION_MARK) || []).length >= 1) {
    segments = s.split(OPTION_MARK).filter((_, i) => i % 2 === 0).slice(1);
  } else {
    const body = s.replace(/^[\s\S]*?\b(?:compare|comparing)\b\s*:?/i, '');
    segments = body.split(/\bor\b|;|\bversus\b|\bvs\.?(?=\s)/i);
  }
  segments = segments.map((x) => x.replace(/[;\n]+/g, ' ').trim()).filter((x) => x && wordsOf(x).length);
  if (segments.length < 2) throw new Error('Name at least two options to compare, e.g. “option one, extraction; option two, root canal and crown on 19”');
  if (segments.length > 3) throw new Error('Compare up to three options at a time');
  const sub = { ...ctx, defaultMode: 'planned' };
  const tries = segments.map((seg) => { try { return { items: parseEntry(seg, sub) }; } catch (e) { return { error: e }; } });
  // The tooth carries across: "extraction and bone graft; or root canal, buildup and crown on 19".
  const shared = [...new Set(tries.flatMap((t) => (t.items || []).map((it) => it.tooth).filter(Boolean)))];
  return segments.map((seg, i) => {
    let items = tries[i].items;
    if (!items) {
      if (!shared.length || !/tooth number|which tooth/i.test(tries[i].error.message)) throw tries[i].error;
      items = parseEntry(`${shared.join(' ')} ${seg}`, sub);
    }
    if (items.some((it) => it.type === 'procedure' && it.complete)) throw new Error('Options being compared are planned, not done');
    return { label: `Option ${'ABC'[i]}`, summary: summarize(items), items };
  });
}

const summarize = (items) => {
  const teeth = [...new Set(items.map((it) => it.tooth).filter(Boolean))];
  const what = items.map((it) => (it.type === 'condition' ? it.condition.replace(/_/g, ' ') : it.code));
  return `${[...new Set(what)].join(' + ')}${teeth.length ? ` on #${teeth.join(', #')}` : ''}`;
};

// Everything at once, for a preview: { items, options (a comparison) or null, bundles (with their optional parts) }.
export function resolveEntry(text, ctx = {}) {
  const lookups = ctx.lookups || (ctx.bundles || ctx.shortcuts ? buildLookups(ctx) : null);
  const c = { ...ctx, lookups };
  if (isComparison(text)) return { items: [], options: parseOptions(text, c), bundles: [] };
  const items = [];
  const bundles = [];
  for (const entry of String(text).split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const r = readEntry(entry, c);
    items.push(...r.items);
    if (r.bundle) bundles.push({ name: r.bundle.bundle.name, alias: r.bundle.bundle.alias || null, options: bundleOptions(r.bundle.bundle, r.bundle.options) });
  }
  return { items, options: null, bundles };
}

// ---- Checks on the result ----
// A problem that stops an item being charted (the server says the same, and more: codes, fees, permissions).
export function itemProblem(it) {
  if (it.type === 'procedure' && it.surfaces) {
    const s = surfaceProblem(it.tooth, it.surfaces);
    if (s) return s;
  }
  if (it.type === 'condition' && it.surfaces) {
    const s = surfaceProblem(it.tooth, it.surfaces);
    if (s) return s;
  }
  if (it.type === 'procedure' && areaKind(it.code) && !it.area) return `${it.code} is charted by ${areaKind(it.code)}`;
  return null;
}

// Things worth a second look before charting: already planned, on a missing tooth, charted twice.
export function chartWarnings(items, chart) {
  if (!chart) return [];
  const out = [];
  const missing = new Set((chart.conditions || []).filter((c) => c.condition === 'missing' && !c.resolved && !c.voided_at).map((c) => String(c.tooth)));
  const replaces = /^D(6\d{3}|5\d{3}|7953)$/;
  const seen = new Set();
  for (const it of items) {
    const where = it.tooth ? `#${it.tooth}` : it.area || '';
    if (it.type === 'procedure') {
      const key = `${it.code}|${it.tooth || ''}|${it.area || ''}`;
      if (seen.has(key)) out.push(`${it.code}${where ? ` on ${where}` : ''} is in this entry twice`);
      seen.add(key);
      if ((chart.procedures || []).some((p) => p.status === 'planned' && p.code === it.code && String(p.tooth || '') === String(it.tooth || '') && String(p.area || '') === String(it.area || ''))) {
        out.push(`${it.code}${where ? ` on ${where}` : ''} is already planned`);
      }
      if (it.tooth && missing.has(String(it.tooth)) && !replaces.test(it.code)) out.push(`#${it.tooth} is charted as missing`);
    } else if ((chart.conditions || []).some((c) => !c.resolved && !c.voided_at && c.condition === it.condition && String(c.tooth) === String(it.tooth) && (c.surfaces || '') === (it.surfaces || ''))) {
      out.push(`${it.condition.replace(/_/g, ' ')} on #${it.tooth} is already charted`);
    }
  }
  return [...new Set(out)];
}

// "#30 MO caries", "#14 D2740 planned", "UR D4341 planned" — for the preview and the confirmation toast.
export const describe = (item) => `${item.tooth ? `#${item.tooth} ` : ''}${item.area ? `${item.area} ` : ''}${item.surfaces ? `${item.surfaces} ` : ''}${item.type === 'condition' ? item.condition.replace('_', ' ') : `${item.code}${item.complete ? ' done' : ' planned'}`}`;

// A quick button as the words it stands for, so pressing it goes through the same engine and preview as typing:
// its alias if it has one, else "crb", "Night guard bundle", "D2950 plan", "extraction plan", "caries".
const WORK_WORD = { bridge_retainer: 'retainer', implant_abutment: 'abutment', bridge_pontic: 'pontic' };
export function shortcutText(s, bundles = []) {
  const mode = { plan: 'plan', done: 'done', existing: 'existing' }[s.mode] || '';
  if (s.alias) return s.alias;
  if (s.kind === 'bundle') {
    const b = bundles.find((x) => Number(x.id) === Number(s.bundle_id ?? s.target));
    return b ? `${b.alias || `${b.name} bundle`}${s.mode === 'done' ? ' done' : ''}` : null;
  }
  const surf = s.surfaces ? ` ${s.surfaces}` : '';
  if (s.kind === 'code') return `${s.target}${surf} ${mode === 'existing' ? 'plan' : mode}`.trim();
  if (s.kind === 'work') return `${WORK_WORD[s.target] || s.target}${surf} ${mode}`.trim();
  if (s.kind === 'finding') return `${surf.trim()} ${s.target}`.trim();
  return null;
}

// ---- Starters ----
// Bundles a practice starts with (added once; each can be changed or retired, and added again from the list).
export const STARTER_BUNDLES = [
  { key: 'crown', name: 'Crown', alias: 'crb', items: [{ work: 'crown' }, { work: 'buildup', optional: true, default_on: false }, { work: 'post', optional: true, default_on: false }] },
  { key: 'implant', name: 'Implant', alias: 'imp', items: [{ code: 'D6010', label: 'fixture' }, { code: 'D6057', label: 'abutment', optional: true, default_on: true, phase: 2 }, { code: 'D6065', label: 'crown', phase: 3 }] },
  { key: 'new_patient', name: 'New patient', alias: 'np', items: [{ code: 'D0150', tooth: 'none', label: 'exam' }, { code: 'D0210', tooth: 'none', label: 'fmx' }, { code: 'D1110', tooth: 'none', label: 'prophy' }] },
  { key: 'new_patient_child', name: 'New patient (child)', alias: 'npc', items: [{ code: 'D0150', tooth: 'none', label: 'exam' }, { code: 'D0272', tooth: 'none', label: 'bitewings', optional: true, default_on: true }, { code: 'D1120', tooth: 'none', label: 'prophy' }, { code: 'D1206', tooth: 'none', label: 'fluoride', optional: true, default_on: true }] },
  { key: 'srp', name: 'SRP 4 quads', alias: 'srp', items: QUADRANTS.map((area) => ({ code: 'D4341', area, optional: true, default_on: true })) },
  { key: 'bridge', name: 'Bridge', alias: 'brg', items: [{ work: 'bridge_retainer', tooth: 'ends', label: 'retainers' }, { work: 'bridge_pontic', tooth: 'between', label: 'pontics' }] },
  { key: 'denture_upper', name: 'Denture upper', alias: 'cdu', items: [{ code: 'D5110', area: 'U' }] },
  { key: 'denture_lower', name: 'Denture lower', alias: 'cdl', items: [{ code: 'D5120', area: 'L' }] },
  { key: 'night_guard', name: 'Night guard', alias: 'ng', items: [{ code: 'D9944', tooth: 'none' }] },
  { key: 'sealants', name: 'Sealants', alias: 'seal', items: [{ code: 'D1351', tooth: 'unsealed_molars' }] },
];
// Quick buttons an office starts with: [label, kind, target (a starter bundle's key for bundles), mode, color, icon].
export const STARTER_SHORTCUTS = [
  ['Crown', 'bundle', 'crown', 'plan', '#7c3aed', 'crown'],
  ['Buildup', 'code', 'D2950', 'plan', '#0891b2', 'layers'],
  ['Caries', 'finding', 'caries', 'existing', '#c2410c', 'circle-dot'],
  ['Missing', 'finding', 'missing', 'existing', '#64748b', 'circle-slash'],
  ['Extraction', 'work', 'extraction', 'plan', '#dc2626', 'scissors'],
  ['Implant', 'bundle', 'implant', 'plan', '#0f766e', 'anchor'],
  ['New patient', 'bundle', 'new_patient', 'plan', '#2563eb', 'user-plus'],
  ['SRP', 'bundle', 'srp', 'plan', '#be185d', 'waves'],
  ['Sealants', 'bundle', 'sealants', 'plan', '#16a34a', 'shield'],
];
// Icons a button can have (lucide names; the chart draws these).
export const SHORTCUT_ICONS = ['crown', 'layers', 'circle-dot', 'circle-slash', 'scissors', 'anchor', 'user-plus', 'waves', 'shield', 'sparkles', 'star', 'zap', 'smile', 'pill', 'bone', 'moon', 'package', 'plus', 'check', 'eye', 'syringe', 'hammer', 'baby'];
