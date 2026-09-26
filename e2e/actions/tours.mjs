// The guided walkthroughs ("Show me"): one tour per office action, made from the measuring robot's real runs, so each
// step points at the control the robot actually used and expects the click, key or typing it actually did.
// `npm run tours` (after `npm run actions`, alongside `npm run manual`).
//
// Reads  e2e/actions/actions.json          the actions (who, where, how often)
//        e2e/actions/out/<id>/result.json  the robot's last run: per step what it acted on (a stable description of
//                                          each target), the keys and typing, the page it was on, what it changed
//        e2e/actions/manual-notes.json     the words: each step's instruction (the user manual's), and per action
//                                          an optional "tour": { needs, skip, text } (see below)
// Writes client/public/manual/tours.json   the tours (Help → Show me, the command bar, "Show me" on manual pages)
//        server/src/tourindex.json         which tours exist and the ready-made training sets (the server checks
//                                          assignments against it)
//
// The records the robot's run was about become placeholders: its patient is the training patient ({patient},
// {first}, {last}), its visit the training patient's visit ({appt}, {appt_date}), today {today}. A step whose target
// can only be named by some other record's id (claim #57) has no portable description; the tour is then left out,
// with the reason, unless the notes say how to reach it.
//
// manual-notes.json "tour" (all optional):
//   needs   set-up on the training patient before it starts: visit_today[:status], visit_future, unbilled, planned,
//           draft_note, claim_sent (server/src/training.js prepareTraining)
//   skip    why this action has no tour (hardware, a live phone call…)
//   office  true: it has no patient; doing it changes the office's real records (said before it starts)
//
//   npm run tours              regenerate
//   npm run tours -- --check   change nothing; fail if a frequent action has no tour and no reason, or the files are stale
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const OUT = process.env.ACTIONS_OUT || join(here, 'out');
const TOURS = join(root, 'client/public/manual/tours.json');
const INDEX = join(root, 'server/src/tourindex.json');
const args = process.argv.slice(2);

const actions = JSON.parse(readFileSync(join(here, 'actions.json'), 'utf8'));
const notes = JSON.parse(readFileSync(join(here, 'manual-notes.json'), 'utf8'));
const byId = Object.fromEntries(actions.map((a) => [a.id, a]));
const previous = existsSync(TOURS) ? JSON.parse(readFileSync(TOURS, 'utf8')) : { tours: [] };
const prevById = Object.fromEntries(previous.tours.map((t) => [t.id, t]));

// Every action in these bands needs a tour (or a written reason why not).
export const REQUIRED_BANDS = ['constant', 'very frequent', 'frequent', 'daily'];
const AREA_LABEL = {
  schedule: 'Schedule', 'front desk': 'Patients & front desk', communication: 'Messages & calls', clinical: 'Clinical',
  imaging: 'X-rays & documents', payments: 'Payments & the ledger', insurance: 'Insurance & claims', recall: 'Recall & follow-up',
  office: 'Office & team', 'lab & inventory': 'Labs & supplies', reports: 'Reports & numbers', 'HR & time clock': 'Time clock & HR',
  compliance: 'Compliance', admin: 'Settings', 'multi-office': 'Several offices',
};

// Ready-made training sets (Manage → Training assigns them; the first-login welcome plays the first three).
const SETS = [
  { key: 'front-desk-basics', title: 'Front desk basics', role: 'front desk', tours: ['A002', 'A003', 'A020', 'A010', 'A016', 'A029', 'A054', 'A008', 'A019', 'A017', 'A043', 'A055', 'A037'] },
  { key: 'billing-basics', title: 'Billing basics', role: 'billing', tours: ['A002', 'A024', 'A019', 'A064', 'A022', 'A026', 'A048', 'A067', 'A072', 'A075', 'A084', 'A085'] },
  { key: 'dentist-basics', title: 'Dentist basics', role: 'dentist', tours: ['A002', 'A006', 'A021', 'A038', 'A011', 'A023', 'A015', 'A062', 'A042', 'A089'] },
  { key: 'hygienist-basics', title: 'Hygienist basics', role: 'hygienist', tours: ['A002', 'A014', 'A033', 'A012', 'A045', 'A011', 'A018', 'A097', 'A032', 'A068'] },
  { key: 'assistant-basics', title: 'Assistant basics', role: 'assistant', tours: ['A002', 'A012', 'A014', 'A032', 'A007', 'A031', 'A018', 'A013', 'A073', 'A044'] },
  { key: 'office-manager-basics', title: 'Office manager basics', role: 'office manager', tours: ['A083', 'A049', 'A028', 'A034', 'A085', 'A084', 'A100', 'A079', 'A095'] },
];

const questionOf = (a) => notes[a.id]?.q || `How do I ${a.name.replace(/\s*\([^)]*\)\s*/g, ' ').trim().replace(/^./, (c) => c.toLowerCase())}?`;
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- placeholders ----------
const WORDS = new Set(['Card', 'Complete', 'Ready', 'Seated', 'Outgoing', 'Parent', 'Member', 'Dropped', 'Noted', 'Asap', 'Dual', 'Checkin', 'Checky', 'Stat', 'Oops', 'Glance', 'Printa', 'Formy', 'Linky', 'Plany', 'Tasky', 'Scanny', 'Signy', 'Crowny', 'Riska', 'Referra', 'Consenta', 'Provy', 'Dicta', 'Sensa', 'Elig', 'Fixie', 'Voida', 'Appro', 'Slippy', 'Fol']);
// Records the tours set up on the training patient (server/src/training.js prepareTraining), by the attribute that
// names them on screen: <… data-plan="25"> is the training patient's plan when the tour asks for one.
const RECORD_ATTRS = [[/(data-plan(?:-id)?=")\d+(")/g, '$1{plan}$2', 'plan'], [/(data-claim(?:-id)?=")\d+(")/g, '$1{claim}$2', 'claim'], [/(data-note(?:-id)?=")\d+(")/g, '$1{note}$2', 'note'],
  [/(lbc-lab_case-)\d+/g, '$1{lab_case}', 'lab_case'], [/\/claims\/\d+/g, '/claims/{claim}', 'claim'], [/\/treatment-plans\/\d+/g, '/treatment-plans/{plan}', 'plan']];
// The run's own records → names the tour fills in at the time (the training patient's).
function placeholders(result, today, needs) {
  const subs = result.tour?.subjects || [];
  const pats = subs.filter((s) => s.kind === 'patient');
  const appts = subs.filter((s) => s.kind === 'appt');
  const rules = [];
  // The main patient: the one the start page or the first steps are about; others (a duplicate, a family member
  // made by the set-up) can't become the training patient, so they make the tour not portable.
  const main = pats.find((p) => JSON.stringify(result.steps).includes(`/patients/${p.id}`) || JSON.stringify(result.steps).includes(p.last)) || pats[0];
  if (main) {
    rules.push([new RegExp(`/patients/${main.id}(?=\\b|/|\\?|$)`, 'g'), '/patients/{patient}']);
    rules.push([new RegExp(`(["=:/])${main.id}(?=["&/\\]?]|$)`, 'g'), '$1{patient}']);
    rules.push([new RegExp(`patient=${main.id}\\b`, 'g'), 'patient={patient}']);
    rules.push([new RegExp(`#${main.id}\\b`, 'g'), '#{patient}']);
    if (main.last) rules.push([new RegExp(escRe(main.last), 'g'), '{last}']);
    // The first name alone only when it can't be one of the screen's own words (the robot names some patients
    // "Complete", "Ready", "Card"… so their step reads well: "Complete today's work" is a button, not a name).
    if (main.first && !WORDS.has(main.first)) rules.push([new RegExp(`\\b${escRe(main.first)}\\b`, 'g'), '{first}']);
    if (main.phone) {
      const d = main.phone.replace(/\D/g, '');
      rules.push([new RegExp(escRe(main.phone), 'g'), '{phone}']);
      rules.push([new RegExp(`\\b${d.slice(-4)}\\b`, 'g'), '{phone4}']);
    }
  }
  const appt = appts[0];
  if (appt) {
    rules.push([new RegExp(`(["=:/])${appt.id}(?=["&/\\]?]|$)`, 'g'), '$1{appt}']);
    rules.push([new RegExp(`/appointments/${appt.id}\\b`, 'g'), '/appointments/{appt}']);
    if (appt.date && appt.date !== today) rules.push([new RegExp(appt.date, 'g'), '{appt_date}']);
  }
  if (today) rules.push([new RegExp(today, 'g'), '{today}']);
  const others = [...pats.filter((p) => p !== main), ...appts.slice(1)];
  const records = (needs || []).map((n) => ({ planned: 'plan', claim_sent: 'claim', draft_note: 'note', lab_case: 'lab_case' }[n.split(':')[0]])).filter(Boolean);
  for (const [re, to, kind] of RECORD_ATTRS) if (records.includes(kind)) rules.push([re, to]);
  return {
    main, appt, others,
    apply: (v) => (v == null ? v : rules.reduce((s, [re, to]) => s.replace(re, to), String(v))),
  };
}

// A description still naming some record by its number (claim 57, an issue id…) won't find anything elsewhere.
const pinned = (s) => /(\/\d{2,}(\/|\?|$)|[=:"]\d{3,}(["&\]]|$))/.test(String(s || ''));
// In words on the screen, "#57" is a record's number too (not in a CSS description: "e.g. RCT #19" in a placeholder).
const pinnedText = (s) => pinned(s) || /#\d{2,}\b/.test(String(s || ''));
// Dates the robot worked on (a quiet Tuesday months ahead) other than the visit's own: also pinned.
const dated = (s) => /\b20\d\d-\d\d-\d\d\b/.test(String(s || ''));

// The most lasting of the robot's descriptions of one target: a data-tour name first, then one naming the training
// patient's own record ({appt}, {patient}), then words without numbers in them (a card's "6p to 6:40p, scheduled"
// won't read the same on another day), unique before merely-first.
function rank(c, css, text) {
  // A data-tour name is the most lasting; the first of several (a list's rows) is what the robot meant too. Narrowed
  // by an ancestor, only when that ancestor is the training patient's own record.
  if (/\[data-tour=/.test(css)) {
    if (/ /.test(css) && !/\{\w+\}/.test(css)) return 2;
    return c.weak ? 1 : 0;
  }
  let r = 3;
  if (/\{(appt|patient|note|plan|claim|lab_case)\}/.test(css)) r = 1;
  else if (/\[data-testid=/.test(css)) r = 1;
  else if (!/\d/.test(`${css} ${text ?? ''}`.replace(/\{\w+\}/g, ''))) r = 2;
  if (/\d/.test(`${text ?? ''}`.replace(/\{\w+\}/g, '')) || /\[aria-label="[^"]*\d[^"]*"\]/.test(css.replace(/\{\w+\}/g, ''))) r += /[ .]/.test(css) ? 4 : 6;
  return r + (c.weak ? 3 : 0);
}
function pickTarget(t, ph, { list = false } = {}) {
  if (!t) return null;
  const options = [];
  for (const c of [t, ...(t.alts || [])]) {
    const css = ph.apply(c.css);
    const text = c.text == null ? undefined : ph.apply(c.text);
    const lab = c.lab == null ? undefined : ph.apply(c.lab);
    if (pinned(css) || pinnedText(text) || dated(css) || dated(text) || pinnedText(lab)) continue;
    options.push({ c, css, text, lab, r: rank(c, css, text ?? lab) });
  }
  if (!options.length) return { unportable: ph.apply(t.css) };
  const best = options.sort((a, b) => a.r - b.r)[0];
  // A count at the end of a label ("Ready to approve 4", "Send 1") changes with the office's day: the words before it
  // are enough (a target's words match from their start).
  if (best.text != null && /^\D*\D\s+\d+$/.test(best.text)) best.text = best.text.replace(/\s+\d+$/, '');
  // Words that change from day to day ("Oct 7, 2026 6:00 AM") on something picked out by its place (a list of
  // times): the first one in that place is what the step means.
  if (best.text != null && /\d/.test(best.text.replace(/\{\w+\}/g, '')) && /[ .]/.test(best.css)) delete best.text;
  // A form field is called by its label ("Carrier"), not the words inside it (a list's every choice).
  const label = ph.apply(best.lab || (list || /^(select|textarea)\b/.test(best.css) ? '' : t.label) || best.text || '');
  return {
    css: best.css, ...(best.text != null ? { text: best.text } : {}), ...(best.lab != null ? { lab: best.lab } : {}), ...(best.c.weak ? { weak: true } : {}),
    // The words people see on it, unless they're the robot's details (a card's time and status).
    ...(label && !/\d/.test(label.replace(/\{\w+\}/g, '')) ? { label } : {}),
  };
}

// The robot's "the page is ready" selector (Playwright's) as a target: plain CSS, or CSS:has-text("…").
function readyTarget(sel, ph) {
  if (!sel || /(>>|^text=|:text\(|:nth-match|:visible|:has\()/.test(sel)) return null;
  const m = /^(.*?):has-text\("([^"]*)"\)$/.exec(sel);
  let t = m ? { css: ph.apply(m[1]), has: ph.apply(m[2]) } : sel.includes(':has-text(') ? null : { css: ph.apply(sel) };
  // Words naming the robot's own set-up (its test insurer, amounts, dates) won't be on another screen.
  if (t?.has != null && /Robot|\d/.test(t.has.replace(/\{\w+\}/g, ''))) t = { css: t.css };
  if (!t || pinned(t.css) || pinned(t.has) || dated(t.css)) return null;
  return t;
}

// A page address without the robot's own days and record numbers in its query (/schedule?date=2027-02-09&view=day →
// /schedule?view=day); null when the path itself names one (/claims/57).
function portableUrl(u) {
  if (!u) return null;
  const [path, query = ''] = u.split('?');
  if (pinned(path) || dated(path)) return null;
  const params = new URLSearchParams(query);
  for (const [k, v] of [...params]) if (pinned(`=${v}`) || dated(v) || /^\d{2,}$/.test(v)) params.delete(k);
  const q = params.toString().replace(/%7B/g, '{').replace(/%7D/g, '}');
  return q ? `${path}?${q}` : path;
}

// ---------- one tour ----------
// Pages outside the signed-in app (client/src/App.jsx: the patient's and the public pages), where the overlay isn't.
const OUTSIDE = /^\/(book|c|lab|learn|checkin|status|f|r|s|welcome|unsubscribe-news|u|pay|billpay|tp|scan|portal|timeclock\/kiosk|rb|billing-link|p|kiosk|e)(\/|$)/;
function tourFor(a, result, today) {
  const n = notes[a.id] || {};
  const cfg = n.tour || {};
  if (cfg.skip) return { skip: cfg.skip };
  if (!result) return { skip: 'the robot has no run of it here' };
  if (result.status !== 'measured') return { skip: result.status === 'blocked' ? `the demo office can’t do it (${String(result.error || '').slice(0, 80)})` : `the robot’s run didn’t finish (${String(result.error || '').slice(0, 80)})` };
  const steps = result.steps.map((s, i) => ({ ...s, i })).filter((s) => !s.start && !s.failed);
  if (!steps.length) return { skip: 'no steps' };
  if (!steps.some((s) => s.ev)) return { skip: 'the robot’s run is from before walkthroughs were recorded (run npm run actions)' };
  const ph = placeholders(result, today, cfg.needs);
  const problems = [];
  const over = n.steps || {};
  const out = [];
  for (const s of steps) {
    if (out.at(-1)?.leaves) break;
    const expect = [];
    for (const e of s.ev || []) {
      const target = pickTarget(e.t, ph, { list: e.k === 'select' });
      if (target?.unportable) { problems.push(`step ${out.length + 1} acts on ${target.unportable}`); continue; }
      // A click on nothing the robot could describe can't be shown or checked: the step's words say what to do.
      if (e.k === 'click') { if (target) expect.push({ k: 'click', t: target }); }
      else if (e.k === 'key') expect.push({ k: 'key', key: e.key, ...(target ? { t: target } : {}) });
      else if (e.k === 'type' && !e.cmd && String(e.text).length === 1) {
        // One character "typed" into a box is a key the screen answers (R books the recall; perio digits move on).
        expect.push({ k: 'key', key: e.text, ...(target ? { t: target } : {}) });
      } else if (e.k === 'type') {
        // The notes can give better example words than the robot's (its made-up names and test insurers).
        const typed = cfg.typed?.[s.i];
        expect.push({ k: 'type', text: typed != null && !e.cmd ? typed : ph.apply(e.text), ...(e.cmd ? { cmd: true } : {}), ...(target ? { t: target } : {}) });
      }
      else if (e.k === 'select') {
        // A choice that is the robot's own record (its test insurer) or names the run's other records: any choice
        // in that list does.
        const own = /Robot/.test(String(e.text)) || ph.others.some((o) => o.last && String(e.text).includes(o.last));
        expect.push({ k: 'select', ...(own ? { any: true } : { value: ph.apply(e.value), text: ph.apply(e.text) }), ...(target ? { t: target } : {}) });
      }
    }
    const url = portableUrl(ph.apply(s.url0));
    out.push({
      text: ph.apply(over[s.i] ?? s.caption),
      ...(url ? { url } : {}),
      expect,
      ...(s.writes?.length ? { writes: s.writes.length } : {}),
      // It ends on a screen outside the signed-in app (the patient's own signing page): the walkthrough ends there.
      ...(OUTSIDE.test(String(s.url1 || '')) ? { leaves: true } : {}),
    });
  }
  // Only the first step (and a step the robot reached by a fresh page load) opens a page itself; the others follow
  // from what the person did.
  for (let i = 1; i < out.length; i++) if (out[i].url && portableUrl(ph.apply(steps[i - 1].url1)) === out[i].url) delete out[i].url;
  // Other records the set-up made only matter if the steps use them (a second patient picked by name, a second visit).
  const used = JSON.stringify(out) + JSON.stringify(result.tour?.start || {});
  const extra = ph.others.filter((o) => (o.kind === 'patient' ? used.includes(o.last) || new RegExp(`\\b${o.id}\\b`).test(used) : new RegExp(`["=/]${o.id}\\b`).test(used)));
  if (extra.length) problems.push(`it is about ${extra.length} more record${extra.length > 1 ? 's' : ''} than the training patient has`);
  if (problems.length && !cfg.force) return { skip: `its steps name records only the robot’s run had (${problems[0]})` };
  const startUrl = ph.apply(result.tour?.start?.url);
  // Where it starts has to be somewhere the training patient (or anyone) can go.
  if (!portableUrl(startUrl) && !out[0].url) return { skip: `it starts on a page about a record only the robot’s run had (${startUrl})` };
  const focus = pickTarget(result.tour?.start?.focus, ph);
  const patient = ph.main || cfg.practice ? 'training' : null;
  const writes = steps.some((s) => s.writes?.length);
  let needs = cfg.needs;
  if (!needs && ph.appt) needs = [ph.appt.date === today ? 'visit_today' : 'visit_future'];
  return {
    tour: {
      id: a.id, title: a.name, q: questionOf(a), roles: a.roles, area: a.area, areaLabel: AREA_LABEL[a.area] || a.area, band: a.band, perDay: a.perDay,
      // Who the robot was (the replay check signs in as them: the steps need that person's permissions).
      role: result.role || 'admin',
      what: n.what || '', keyboard: !!a.keyboard,
      patient, ...(needs?.length ? { needs } : {}),
      // What doing it for real changes: nothing, the (training) patient's chart, or the office's own records.
      effects: !writes ? 'none' : patient ? 'patient' : cfg.office === false ? 'none' : 'office',
      start: {
        url: portableUrl(startUrl) || out[0].url || null, ...(focus && !focus.unportable ? { focus } : {}),
        ...(readyTarget(result.tour?.start?.ready, ph) ? { ready: readyTarget(result.tour.start.ready, ph) } : {}),
      },
      steps: out,
      robotAt: result.measuredAt || null,
    },
  };
}

function main() {
  const today = (() => {
    // The day the robot ran (dates in its URLs are that day): from any result's measuredAt.
    for (const a of actions) {
      const f = join(OUT, a.id, 'result.json');
      if (existsSync(f)) { const r = JSON.parse(readFileSync(f, 'utf8')); if (r.today) return r.today; }
    }
    return null;
  })();
  const tours = [];
  const skipped = [];
  const order = [...actions].sort((x, y) => (y.perDay || 0) - (x.perDay || 0) || x.id.localeCompare(y.id));
  for (const a of order) {
    const f = join(OUT, a.id, 'result.json');
    const result = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    const made = tourFor(a, result, result?.today || today);
    if (made.tour) tours.push(made.tour);
    else if (!result && prevById[a.id] && !notes[a.id]?.tour?.skip) tours.push({ ...prevById[a.id], kept: true }); // no run here: keep it
    else skipped.push({ id: a.id, name: a.name, band: a.band, why: made.skip });
  }
  const have = new Set(tours.map((t) => t.id));
  const sets = SETS.map((s) => ({ ...s, tours: s.tours.filter((id) => have.has(id)) })).filter((s) => s.tours.length);
  const doc = { generated: tours.map((t) => t.robotAt).filter(Boolean).sort().at(-1) || null, sets, skipped, tours };
  return { doc, tours, skipped, sets };
}

function write({ doc, tours, sets }) {
  // One tour per line, so a regeneration's diff shows which tours changed.
  const { tours: list, ...head } = doc;
  writeFileSync(TOURS, `${JSON.stringify(head).slice(0, -1)},"tours":[\n${list.map((t) => JSON.stringify(t)).join(',\n')}\n]}\n`);
  const index = { tours: Object.fromEntries(tours.map((t) => [t.id, { title: t.title, roles: t.roles, area: t.area }])), sets };
  writeFileSync(INDEX, `${JSON.stringify(index)}\n`);
}

const made = main();
if (args.includes('--check')) {
  // From the committed files: every frequent action has a tour or a reason; the server's index matches.
  const committed = existsSync(TOURS) ? JSON.parse(readFileSync(TOURS, 'utf8')) : null;
  const problems = [];
  if (!committed) problems.push('client/public/manual/tours.json is missing');
  else {
    const have = new Set(committed.tours.map((t) => t.id));
    const why = new Map((committed.skipped || []).map((s) => [s.id, s.why]));
    for (const a of actions.filter((x) => REQUIRED_BANDS.includes(x.band))) {
      if (!have.has(a.id) && !why.get(a.id)) problems.push(`${a.id} ${a.name} (${a.band}): no tour and no reason`);
    }
    for (const t of committed.tours) {
      if (!byId[t.id]) problems.push(`${t.id} is not in actions.json`);
      if (!t.steps?.length) problems.push(`${t.id} has no steps`);
    }
    const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : { tours: {} };
    const idx = new Set(Object.keys(index.tours || {}));
    if ([...have].some((id) => !idx.has(id)) || [...idx].some((id) => !have.has(id))) problems.push('server/src/tourindex.json doesn’t match tours.json (run npm run tours)');
  }
  if (problems.length) { console.error(`The walkthroughs are out of date (npm run tours):\n  ${problems.join('\n  ')}`); process.exit(1); }
  console.log(`${committed.tours.length} walkthroughs; every constant, very frequent, frequent and daily action has one or a reason.`);
} else {
  write(made);
  const req = actions.filter((a) => REQUIRED_BANDS.includes(a.band));
  const covered = req.filter((a) => made.tours.some((t) => t.id === a.id));
  console.log(`${made.tours.length} tours (${covered.length} of the ${req.length} constant/very frequent/frequent/daily actions) · ${made.sets.length} sets → client/public/manual/tours.json`);
  for (const s of made.skipped.filter((x) => REQUIRED_BANDS.includes(x.band))) console.log(`  skipped ${s.id} ${s.name}: ${s.why}`);
  const other = made.skipped.filter((x) => !REQUIRED_BANDS.includes(x.band));
  if (other.length) console.log(`  (${other.length} less frequent actions without a tour: ${other.map((s) => s.id).join(' ')})`);
}
