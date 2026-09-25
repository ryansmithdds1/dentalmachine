// Turns the robot's results into the two documents people read (npm run actions:report):
//   docs/workflows/actions.md    — the master list of office actions, most frequent first
//   docs/workflows/scorecard.md  — scores, the improvement queue and every action's numbers. Only the parts between
//                                  <!-- robot:… --> markers are rewritten; everything else in that file is written by
//                                  people (bugs, the review) and kept.
// Inputs: e2e/actions/actions.json (the list), e2e/actions/out/results.json (the last measurements; ACTIONS_OUT to
// read another folder), e2e/actions/review.json (a reviewer's notes and proposed fix per action).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreOf, priority, BANDS } from './lib/score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const OUT = process.env.ACTIONS_OUT || join(here, 'out');
const actions = JSON.parse(readFileSync(join(here, 'actions.json'), 'utf8'));
const results = existsSync(join(OUT, 'results.json')) ? JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8')) : {};
const review = existsSync(join(here, 'review.json')) ? JSON.parse(readFileSync(join(here, 'review.json'), 'utf8')) : {};
const scripted = new Set(Object.keys(results));

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const link = (p, text) => (p ? `[${text}](../../${p})` : '');
const band = (b) => BANDS.find(([k]) => k === b)?.[2] || b;
const perDay = (n) => (n >= 1 ? String(n) : n >= 0.15 ? `${Math.round(n * 5 * 10) / 10}/wk` : n >= 0.03 ? `${Math.round(n * 21 * 10) / 10}/mo` : `${Math.round(n * 250 * 10) / 10}/yr`);

// Each action's status and (re)computed score: re-scoring here means a change to the rubric shows without re-running.
const rows = actions.map((a) => {
  const r = results[a.id];
  if (a.route === 'MISSING') return { a, status: 'MISSING' };
  if (!r) return { a, status: a.needs ? 'NOT MEASURABLE' : 'NOT YET MEASURED' };
  if (r.status === 'blocked') return { a, r, status: 'BLOCKED' };
  return { a, r, status: 'measured', ...scoreOf(r, a) };
});

const problemsOf = (x) => {
  if (x.status === 'BLOCKED') return x.r.error;
  const out = [];
  if (x.hardFail) out.push(x.hardFail);
  for (const f of x.r.flags || []) out.push(f.text);
  for (const [name, , why] of x.penalties || []) if (!name.startsWith('review') && name !== 'over target') out.push(why);
  const over = (x.penalties || []).find(([n]) => n === 'over target');
  if (over) out.unshift(over[2]);
  return [...new Set(out)];
};

// ---- actions.md ----
function actionsDoc() {
  const counts = Object.fromEntries(BANDS.map(([k]) => [k, actions.filter((a) => a.band === k).length]));
  const missing = actions.filter((a) => a.route === 'MISSING').length;
  const lines = [
    '# Office actions, most frequent first',
    '',
    `The ${actions.length} things people do in a typical 2–4 chair general practice (1–3 dentists, 2–4 hygienists, ~30 visits a`,
    'day), ordered by how often the whole office does them. Frequencies are estimates for that office, not measurements;',
    'change `perDay` in `e2e/actions/actions.json` (the machine-readable copy the robot uses) and run',
    '`npm run actions:report` to regenerate this page. Ids are stable: new actions get the next free id, whatever their',
    'frequency.',
    '',
    `Bands: ${BANDS.map(([k, , l]) => `**${l}** ${counts[k]}`).join(' · ')}. **${missing} MISSING** — the app has no way to do them.`,
    '',
    '“Task list #” is the workflow number in [task-list.md](task-list.md) (its 54 workflows are all here, some split into',
    'more than one action). “Robot” is the latest score from the measuring robot ([scoring.md](scoring.md),',
    '[scorecard.md](scorecard.md)); ⌨ marks the top-20 workflows that must work from the keyboard alone.',
    '',
    '| Id | Action | Who | How often | ~/day | Where in the app | Task list # | Spec | E2E test | Robot |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const x of rows) {
    const { a } = x;
    const robot = x.status === 'measured' ? `${x.score} ${x.grade}` : x.status === 'MISSING' ? '—' : x.status.toLowerCase();
    lines.push(`| ${a.id} | ${esc(a.name)}${a.keyboard ? ' ⌨' : ''} | ${a.roles.join(', ')} | ${a.band} | ${perDay(a.perDay)} | ${a.route === 'MISSING' ? `**MISSING**${a.note ? ` — ${esc(a.note)}` : ''}` : esc(a.route)} | ${(a.workflow || []).join(', ')} | ${link(a.spec, a.spec?.split('/').pop().replace(/\.md$/, ''))} | ${link(a.e2e, a.e2e?.split('/').pop().replace(/\.test\.mjs$/, ''))} | ${robot} |`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---- scorecard.md (robot parts) ----
function summary() {
  const measured = rows.filter((x) => x.status === 'measured');
  const by = (s) => rows.filter((x) => x.status === s).length;
  const grades = ['A', 'B', 'C', 'D', 'F'].map((g) => `${g} ${measured.filter((x) => x.grade === g).length}`).join(' · ');
  const perBand = BANDS.map(([k, , l]) => {
    const inBand = rows.filter((x) => x.a.band === k);
    const m = inBand.filter((x) => x.status === 'measured');
    const avg = m.length ? Math.round(m.reduce((t, x) => t + x.score, 0) / m.length) : '—';
    return `| ${l} | ${inBand.length} | ${m.length} | ${inBand.filter((x) => x.status === 'MISSING').length} | ${inBand.filter((x) => !['measured', 'MISSING'].includes(x.status)).length} | ${avg} |`;
  });
  const top20 = measured.filter((x) => x.a.keyboard);
  const lastRun = measured.map((x) => x.r.measuredAt).filter(Boolean).sort().at(-1);
  return [
    `Last robot run: ${lastRun ? lastRun.slice(0, 16).replace('T', ' ') : '—'} UTC, on a fresh local demo server.`,
    '',
    `**${actions.length} actions** · **${measured.length} measured** · ${by('MISSING')} missing from the app · ${by('BLOCKED')} blocked (the demo office can’t do them) · ${by('NOT MEASURABLE')} need hardware · ${by('NOT YET MEASURED')} not yet measured.`,
    '',
    `Grades: ${grades}. Keyboard-only top-20 jobs: ${top20.filter((x) => x.r.keyboardOnly).length} of ${top20.length} measured ones done without the mouse.`,
    '',
    '| Band | Actions | Measured | Missing | Not measured | Average score |',
    '|---|---|---|---|---|---|',
    ...perBand,
  ].join('\n');
}

function queue() {
  const list = rows
    .filter((x) => x.status === 'measured' || x.status === 'MISSING')
    .map((x) => ({ ...x, pr: priority(x.a.perDay, x.status === 'MISSING' ? 0 : x.score) }))
    .filter((x) => x.pr > 0)
    .sort((p, q) => q.pr - p.pr)
    .slice(0, 40);
  const out = ['| # | Id | Action | ~/day | Score | Priority | What the robot saw | Proposed fix |', '|---|---|---|---|---|---|---|---|'];
  list.forEach((x, i) => {
    const rv = review[x.a.id] || {};
    const seen = x.status === 'MISSING' ? `Not in the app. ${x.a.note || ''}` : [...(rv.problems || []), ...problemsOf(x)].slice(0, 4).join('; ');
    const shots = (rv.shots || []).map((s) => `\`${s}\``).join(', ');
    out.push(`| ${i + 1} | ${x.a.id} | ${esc(x.a.name)} | ${perDay(x.a.perDay)} | ${x.status === 'MISSING' ? 'MISSING' : `${x.score} ${x.grade}`} | ${x.pr} | ${esc(seen)}${shots ? ` (${shots})` : ''} | ${esc(rv.fix || '—')} |`);
  });
  return out.join('\n');
}

function table() {
  const out = ['| Id | Action | Band | Score | Grade | Clicks | Keys | Fields | Screens | Dialogs | Time | Kbd only | Key problems |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const x of rows) {
    const { a, r } = x;
    if (x.status !== 'measured') {
      out.push(`| ${a.id} | ${esc(a.name)} | ${a.band} | ${x.status} |  |  |  |  |  |  |  |  | ${esc(x.status === 'MISSING' ? a.note || 'Not in the app' : x.status === 'BLOCKED' ? r.error : a.needs || 'No robot script yet')} |`);
      continue;
    }
    const problems = problemsOf(x).slice(0, 3).join('; ');
    out.push(`| ${a.id} | ${esc(a.name)} | ${a.band} | ${x.score} | ${x.grade} | ${r.clicks} | ${r.keys} | ${r.fields} | ${r.screens} | ${r.modals}${r.maxModals > 1 ? ` (${r.maxModals} stacked)` : ''}${r.dialogs?.length ? ` +${r.dialogs.length} browser box` : ''} | ${(r.ms / 1000).toFixed(1)} s | ${r.keyboardOnly ? 'yes' : 'no'} | ${esc(problems) || '—'} |`);
  }
  return out.join('\n');
}

const SKELETON = `# Scorecard: how easy each office action is today

<!-- robot:summary -->
<!-- /robot:summary -->

## Improvement queue (top 40: how often × how painful)

<!-- robot:queue -->
<!-- /robot:queue -->

## Every action

<!-- robot:table -->
<!-- /robot:table -->
`;

function fill(doc, name, body) {
  const re = new RegExp(`(<!-- robot:${name} -->)[\\s\\S]*?(<!-- /robot:${name} -->)`);
  if (!re.test(doc)) throw new Error(`scorecard.md has no <!-- robot:${name} --> section`);
  return doc.replace(re, `$1\n${body}\n$2`);
}

writeFileSync(join(root, 'docs/workflows/actions.md'), actionsDoc());
const file = join(root, 'docs/workflows/scorecard.md');
let doc = existsSync(file) ? readFileSync(file, 'utf8') : SKELETON;
doc = fill(doc, 'summary', summary());
doc = fill(doc, 'queue', queue());
doc = fill(doc, 'table', table());
writeFileSync(file, doc);
console.log(`Wrote docs/workflows/actions.md (${actions.length} actions) and docs/workflows/scorecard.md (${Object.keys(results).length} results; ${[...scripted].length} scripted).`);
