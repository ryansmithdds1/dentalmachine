// The user manual's data: client/public/manual/manual.json, written by `npm run manual` (e2e/actions/manual.mjs)
// from the measuring robot's runs. Fetched only when someone opens Help → How do I… or asks the command bar,
// so it never weighs on the app's own bundle. The screenshots are served beside it (/manual/img/…).

let cached = null;
export function loadManual() {
  if (!cached) {
    cached = fetch('/manual/manual.json', { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error(`The manual couldn’t be loaded (${r.status})`); return r.json(); })
      .catch((e) => { cached = null; throw e; });
  }
  return cached;
}

export const ROLES = [
  ['front desk', 'Front desk'], ['billing', 'Billing'], ['dentist', 'Dentist'], ['hygienist', 'Hygienist'],
  ['assistant', 'Assistant'], ['office manager', 'Office manager'], ['everyone', 'Everyone'],
];
export const roleLabel = (r) => ROLES.find(([k]) => k === r)?.[1] || r;

// "how do I post a deposit", "help deposit", "deposit?" → the words that matter: deposit (+ post).
const FILLER = new Set(['how', 'do', 'i', 'to', 'a', 'an', 'the', 'help', 'can', 'my', 'me', 'we', 'you', 'what', 'is', 'of', 'for', 'on', 'in', 'with', 'and', 'or', 'where', 'please', 'manual', 'guide', 'does', 'it', 'at', 'up']);
export const HELP_WORDS = /^\s*(how\s+(do|can|to|should)\b|how\s+i\b|help\b|\?|manual\b|guide\b)/i;
const stem = (w) => w.replace(/’/g, "'").replace(/'s$/, '').replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '');
export function wordsOf(q) {
  return String(q || '').toLowerCase().replace(/[^a-z0-9/'’ -]+/g, ' ').split(/\s+/).filter((w) => w && !FILLER.has(w)).map(stem).filter((w) => w.length > 1);
}

// Best pages for what was typed: words in the question count most, then the keywords, then everything else.
export function searchManual(pages, q, limit = 50) {
  const words = wordsOf(q);
  if (!words.length) return [];
  const scored = [];
  for (const p of pages) {
    const title = `${p.q} ${p.name}`.toLowerCase();
    const keys = `${p.keywords} ${p.where} ${p.areaLabel}`.toLowerCase();
    const body = `${p.what} ${p.steps.map((s) => s.text).join(' ')} ${p.tips.join(' ')}`.toLowerCase();
    let score = 0;
    let found = 0;
    let strong = 0;
    for (const w of words) {
      const s = title.includes(w) ? 5 : keys.includes(w) ? 3 : body.includes(w) ? 1 : 0;
      if (s) found++;
      if (s > 1) strong++;
      score += s;
    }
    // A page only mentioned in passing in another page's text isn't what was asked for.
    if (!strong) continue;
    // Every word should be somewhere; one miss is forgiven in a long question ("how do I post a bank deposit").
    if (found < words.length - (words.length > 2 ? 1 : 0)) continue;
    scored.push({ p, score: score + Math.log10(1 + (p.perDay || 0)) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.p);
}
