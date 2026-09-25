// The ease score: 100 minus points for everything that made an action harder than it needs to be.
// Plain rules an office owner can check by hand — docs/workflows/scoring.md explains each one.

export const BANDS = [
  ['constant', 100, 'Constant (100+/day)'],
  ['very frequent', 30, 'Very frequent (30–100/day)'],
  ['frequent', 10, 'Frequent (10–30/day)'],
  ['daily', 1, 'Daily (1–10/day)'],
  ['weekly', 0.15, 'Weekly (about 1–5 a week)'],
  ['monthly', 0.03, 'Monthly'],
  ['rare', 0, 'Rare (a few times a year)'],
];
export const bandOf = (perDay) => BANDS.find(([, min]) => perDay >= min)[0];

// Points taken off, and why. Each rule is [name, points, reason].
export function penalties(r, a) {
  const out = [];
  const add = (name, pts, why) => { if (pts > 0) out.push([name, Math.round(pts * 10) / 10, why]); };
  const actions = r.clicks + r.keys + r.fields;
  const target = a.target ?? 3;
  add('over target', 6 * Math.max(0, actions - target), `${actions} actions; a good design needs about ${target}`);
  add('long task', Math.max(0, actions - 12), `${actions} actions is a long task in itself`);
  add('screens', 3 * Math.max(0, r.screens - (a.screensOk ?? 1)), `${r.screens} screen changes`);
  add('dialogs', 4 * r.modals, `${r.modals} dialog${r.modals === 1 ? '' : 's'} opened`);
  add('stacked dialogs', 8 * Math.max(0, r.maxModals - 1), `dialogs stacked ${r.maxModals} deep`);
  const native = r.dialogs?.length || 0;
  const asks = native + (r.confirms || 0);
  const free = a.destructive ? 1 : 0; // one confirmation is fine before something that can't be undone
  add('are-you-sure', native > 0 ? 10 * Math.max(0, native - free) + 6 * (r.confirms || 0) : 6 * Math.max(0, (r.confirms || 0) - free), `${asks} "are you sure?"/browser box${asks === 1 ? '' : 'es'}`);
  add('slow', Math.min(20, 2 * Math.floor(Math.max(0, r.ms - (a.slowAfterMs ?? 3000)) / 1000)), `took ${(r.ms / 1000).toFixed(1)} s on a fast local server`);
  add('mouse only', a.keyboard && !r.keyboardOnly ? 15 : 0, 'a top-20 job that the robot could not finish with the keyboard alone');
  add('motion', Math.min(5, Math.floor(Math.max(0, (r.mouseTravel || 0) - 2000) / 1000)), `the mouse travelled ${r.mouseTravel}px between clicks`);
  add('accessibility', Math.min(10, 2 * (r.a11y?.length || 0)), `${r.a11y?.length} unlabeled box/button${r.a11y?.length === 1 ? '' : 's'}`);
  const FLAG = { 'asks-known': 5, 'dead-end': 8, wording: 3, layout: 3, bug: 10, missing: 5 };
  for (const f of r.flags || []) add(`review: ${f.kind}`, FLAG[f.kind] || 0, f.text);
  return out;
}

export function grade(score) {
  return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
}

// { score, grade, penalties, hardFail } for one measured result.
export function scoreOf(r, a) {
  if (r.status === 'blocked') return { score: null, grade: '—', penalties: [], hardFail: null };
  const p = penalties(r, a);
  let score = Math.max(0, Math.round(100 - p.reduce((t, [, n]) => t + n, 0)));
  const hardFail = r.status === 'failed' ? 'could not be finished' : r.errors?.length ? `errors: ${r.errors.slice(0, 2).join('; ')}` : null;
  if (r.status === 'failed') score = 0;
  else if (hardFail) score = Math.min(score, 50);
  return { score, grade: hardFail ? 'F' : grade(score), penalties: p, hardFail };
}

// How much it matters to fix: how often × how painful. Missing features count as fully painful.
export const priority = (perDay, score) => Math.round(perDay * (100 - (score ?? 0)) * 10) / 10;
