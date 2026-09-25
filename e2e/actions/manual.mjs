// The user manual: one "How do I…?" page per office action, built from the measuring robot's real runs so the
// pictures and the steps are always the app as it is now. `npm run manual` (after `npm run actions`).
//
// Reads  e2e/actions/actions.json          what the actions are (who, where, how often)
//        e2e/actions/out/<id>/result.json  the robot's last run: step captions, keys pressed, screenshots
//        e2e/actions/manual-notes.json     hand-written prose per action (intro, mouse way, tips, problems…)
// Writes client/public/manual/manual.json  the in-app manual (Help → How do I…; loaded only when opened)
//        client/public/manual/img/*.webp   the screenshots, shrunk (1000 px wide WebP) — the one copy of them
//        docs/manual/README.md + <id>-*.md the same pages as Markdown (their images point at the copy above)
//        docs/manual/out/manual.pdf        the whole manual as one PDF, only with --pdf (gitignored: it would grow
//                                          the history on every run; in the app, Help → How do I… → Print the
//                                          whole manual makes the same thing from the browser)
//
// An action the robot has no output for (not run on this machine, or it needs hardware) keeps the steps and
// pictures it already has in manual.json, so a fresh clone can regenerate the text without re-running the robot.
//
//   npm run manual                 regenerate everything
//   npm run manual -- --pdf        also write docs/manual/out/manual.pdf
//   npm run manual -- --check      change nothing; fail if any action has no page, no notes or no steps
//   ACTIONS_OUT=dir                read the robot's output from somewhere else
/* global Image, document */
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const OUT = process.env.ACTIONS_OUT || join(here, 'out');
const APP_DIR = join(root, 'client/public/manual');
const IMG_DIR = join(APP_DIR, 'img');
const DOCS = join(root, 'docs/manual');
const IMG_WIDTH = 1000;
const IMG_QUALITY = 0.72;
const PDF_IMG_WIDTH = 800;
const PDF_IMG_QUALITY = 0.6;
const args = process.argv.slice(2);

const actions = JSON.parse(readFileSync(join(here, 'actions.json'), 'utf8'));
const notes = JSON.parse(readFileSync(join(here, 'manual-notes.json'), 'utf8'));
const byId = Object.fromEntries(actions.map((a) => [a.id, a]));
const previous = existsSync(join(APP_DIR, 'manual.json')) ? JSON.parse(readFileSync(join(APP_DIR, 'manual.json'), 'utf8')) : { pages: [] };
const prevById = Object.fromEntries(previous.pages.map((p) => [p.id, p]));

// ---------- words ----------
const ROLE_ORDER = ['front desk', 'billing', 'dentist', 'hygienist', 'assistant', 'office manager', 'everyone'];
const AREA_LABEL = {
  schedule: 'Schedule', 'front desk': 'Patients & front desk', communication: 'Messages & calls', clinical: 'Clinical',
  imaging: 'X-rays & documents', payments: 'Payments & the ledger', insurance: 'Insurance & claims', recall: 'Recall & follow-up',
  office: 'Office & team', 'lab & inventory': 'Labs & supplies', reports: 'Reports & numbers', 'HR & time clock': 'Time clock & HR',
  compliance: 'Compliance', admin: 'Settings', 'multi-office': 'Several offices',
};
const BAND_LABEL = {
  constant: 'All day long', 'very frequent': 'Many times a day', frequent: 'Several times a day', daily: 'Every day',
  weekly: 'About weekly', monthly: 'About monthly', rare: 'A few times a year',
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const questionOf = (a) => notes[a.id]?.q || `How do I ${a.name.replace(/\s*\([^)]*\)\s*/g, ' ').trim().replace(/^./, (c) => c.toLowerCase())}?`;
const slug = (s) => s.toLowerCase().replace(/^how do i /, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const fileOf = (a) => `${a.id}-${slug(questionOf(a))}.md`;
// The screen to open ("/deposits" from "Deposits & cash (/deposits) — bag #, Enter"): only plain addresses.
const linkOf = (a) => {
  if (notes[a.id]?.to !== undefined) return notes[a.id].to;
  const m = a.route.match(/\((\/[^)\s]*)\)/);
  return m && !m[1].includes(':') ? m[1] : null;
};

// A key the robot pressed, as a person reads it ("key Ctrl+k" → "Ctrl/⌘ K"; "key C" is Shift+C).
const KEYNAME = { ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Space: 'Space', Backspace: 'Backspace', Delete: 'Delete' };
function keyLabel(combo) {
  const parts = combo.split('+');
  let key = parts.pop();
  const mods = parts.map((m) => ({ Ctrl: 'Ctrl/⌘', Meta: 'Ctrl/⌘', Alt: 'Alt', Shift: 'Shift' }[m] || m));
  if (/^[A-Z]$/.test(key) && !mods.includes('Shift')) mods.push('Shift');
  key = KEYNAME[key] || (key.length === 1 ? key.toUpperCase() : key);
  return [...mods, key].join(' ');
}
// What a step asks of the keyboard, from the robot's log: keys and typed commands (clicks are in the words).
function keysOf(did = []) {
  const out = [];
  for (const d of did) {
    if (d.startsWith('key ')) out.push({ k: keyLabel(d.slice(4)) });
    else if (d.startsWith('command ')) out.push({ t: d.slice(8).replace(/^"|"$/g, '') });
  }
  // A long run of the same key reads better once ("Enter ×3").
  const merged = [];
  for (const k of out) {
    const last = merged.at(-1);
    if (last && k.k && last.k === k.k) last.n = (last.n || 1) + 1;
    else merged.push({ ...k });
  }
  return merged.slice(0, 10);
}

// ---------- pictures ----------
let browser = null;
let encoder = null;
async function encode(src, dest) {
  if (existsSync(dest) && statSync(dest).mtimeMs >= statSync(src).mtimeMs) return;
  if (!encoder) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
    encoder = await browser.newPage();
  }
  const data = `data:image/png;base64,${readFileSync(src).toString('base64')}`;
  const url = await encoder.evaluate(async ([d, w, q]) => {
    const img = new Image();
    img.src = d;
    await img.decode();
    const c = document.createElement('canvas');
    const width = Math.min(w, img.width);
    c.width = width;
    c.height = Math.round((img.height * width) / img.width);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/webp', q);
  }, [data, IMG_WIDTH, IMG_QUALITY]);
  writeFileSync(dest, Buffer.from(url.split(',')[1], 'base64'));
}

// ---------- one page ----------
async function pageFor(a, related) {
  const n = notes[a.id] || {};
  const resultFile = join(OUT, a.id, 'result.json');
  const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
  const prev = prevById[a.id];
  let steps;
  let start = null;
  let robot;
  // A run that got stuck part-way gives way to hand-written steps when the notes have them.
  const stuck = result?.steps?.some((s) => s.failed) && result.status !== 'blocked' && n.manualSteps?.length;
  if (!n.useManualSteps && !stuck && result && result.steps?.some((s) => !s.start && !s.failed)) {
    // The robot's run: its captions (or the notes' better wording), keys and pictures. A step where it got stuck
    // is left out; the steps before it are still right.
    const skip = new Set(n.skipSteps || []);
    const over = n.steps || {};
    let kept = result.steps.map((s, i) => ({ ...s, i })).filter((s) => !s.failed && !skip.has(s.i));
    // The start picture helps when the steps begin on that screen; not when the first step goes somewhere else
    // (through the menu, the command bar or a G-key jump) — then it is only the screen the robot happened to be on.
    const first = kept.find((s) => !s.start);
    const leaves = /^(In the menu|Press Ctrl\/⌘ ?K|Click Settings|Press G then)/i.test(over[first.i] ?? first.caption);
    if (!n.start && (leaves || n.skipStart)) kept = kept.filter((s) => !s.start);
    const names = new Set();
    steps = [];
    for (const s of kept) {
      const src = join(OUT, s.shot);
      const name = `${a.id}-${String(s.i).padStart(2, '0')}.webp`;
      let img = null;
      if (existsSync(src)) {
        await encode(src, join(IMG_DIR, name));
        names.add(name);
        img = `img/${name}`;
      }
      if (s.start) start = { text: over[s.i] ?? n.start ?? null, img };
      else steps.push({ text: over[s.i] ?? s.caption, keys: keysOf(s.did), img });
    }
    // Pictures from an older run of this action that this run no longer uses.
    for (const f of readdirSync(IMG_DIR).filter((x) => x.startsWith(`${a.id}-`) && !names.has(x))) rmSync(join(IMG_DIR, f));
    const failed = result.steps.some((s) => s.failed);
    robot = { status: failed ? (result.status === 'blocked' ? 'blocked' : 'partial') : 'ok', at: result.measuredAt || null, why: failed && result.status === 'blocked' ? result.error || null : null };
  } else if (!n.useManualSteps && prev?.steps?.length && prev.robot?.status !== 'notes') {
    // No run here: keep what the manual already has.
    ({ steps, start } = prev);
    robot = { ...prev.robot, kept: true };
  } else {
    // Never run by the robot (hardware, or the demo office can't do it): written steps from the notes, with any
    // picture they borrow from another action's run.
    steps = [];
    const names = new Set();
    // Borrowed pictures: another action's run, or (when the robot stopped at the first step) its start picture.
    const picture = async (shot, name) => {
      const src = join(OUT, shot);
      if (existsSync(src)) await encode(src, join(IMG_DIR, name));
      if (!existsSync(join(IMG_DIR, name))) return null;
      names.add(name);
      return `img/${name}`;
    };
    const first = !n.useManualSteps && result?.steps?.find((s) => s.start);
    if (first) start = { text: n.start || null, img: await picture(first.shot, `${a.id}-00.webp`) };
    for (const s of n.manualSteps || []) {
      const img = s.shot ? await picture(s.shot, `${a.id}-${s.shot.replace(/\.png$/, '').replace(/[^A-Za-z0-9]+/g, '-')}`.slice(0, 60) + '.webp') : null;
      steps.push({ text: s.text, keys: (s.keys || []).map((k) => ({ k })), img });
    }
    for (const f of readdirSync(IMG_DIR).filter((x) => x.startsWith(`${a.id}-`) && !names.has(x))) rmSync(join(IMG_DIR, f));
    robot = { status: 'notes', at: null, why: n.useManualSteps ? null : a.needs ? 'it needs hardware: a sensor, camera or microphone' : result?.status === 'blocked' ? result.error : null };
  }
  return {
    id: a.id,
    q: questionOf(a),
    name: a.name,
    roles: a.roles,
    area: a.area,
    areaLabel: AREA_LABEL[a.area] || cap(a.area),
    band: a.band,
    often: BAND_LABEL[a.band] || a.band,
    perDay: a.perDay,
    where: (n.where || a.route).replace(/\s*\((\/[^)]*)\)/g, ''),
    to: linkOf(a),
    keyboard: !!a.keyboard,
    destructive: !!a.destructive,
    what: n.what || '',
    start,
    steps,
    mouse: n.mouse || '',
    tips: n.tips || [],
    problems: (n.problems || []).map(([p, fix]) => ({ p, fix })),
    related: related.map((id) => ({ id, q: questionOf(byId[id]) })),
    keywords: n.keywords || '',
    robot,
  };
}

// Related: the notes' picks first, then the nearest actions in the same area by how often they happen.
function relatedOf(a) {
  const picked = (notes[a.id]?.related || []).filter((id) => byId[id] && id !== a.id);
  const same = actions.filter((b) => b.area === a.area && b.id !== a.id && !picked.includes(b.id))
    .sort((x, y) => Math.abs(Math.log((x.perDay || 0.001) / (a.perDay || 0.001))) - Math.abs(Math.log((y.perDay || 0.001) / (a.perDay || 0.001))));
  return [...picked, ...same.map((b) => b.id)].slice(0, 5);
}

// ---------- Markdown ----------
const IMG_FROM_DOCS = '../../client/public/manual/';
// “(A086)” in the prose becomes a link to that page.
const mdLinks = (t) => String(t).replace(/\bA\d{3}\b/g, (id) => (byId[id] ? `[${id}](${fileOf(byId[id])})` : id));
const mdKeys = (keys) => keys.map((k) => (k.t ? `type “${k.t}”` : `<kbd>${k.k}</kbd>${k.n ? ` ×${k.n}` : ''}`)).join(' ');
function markdown(p) {
  const L = [];
  L.push(`# ${p.q}`, '');
  L.push(`**Who:** ${p.roles.join(', ')} · **Where:** ${p.where} · **How often:** ${p.often}${p.keyboard ? ' · ⌨ keyboard only' : ''}`, '');
  if (p.what) L.push(mdLinks(p.what), '');
  if (p.robot.status === 'partial') L.push('> The screenshots robot stopped part-way through this one, so the last steps may be missing.', '');
  if (p.robot.status === 'notes') L.push(p.robot.why ? `> The screenshots robot can’t do this one (${p.robot.why.replace(/[.:]$/, '')}), so these steps are written by hand.` : '> These steps are written by hand.', '');
  if (p.start?.img || p.start?.text) {
    L.push('## Where to start', '');
    if (p.start.text) L.push(p.start.text, '');
    if (p.start.img) L.push(`![Where to start](${IMG_FROM_DOCS}${p.start.img})`, '');
  }
  L.push('## Steps', '');
  p.steps.forEach((s, i) => {
    L.push(`${i + 1}. ${mdLinks(s.text)}${s.keys.length ? `  \n   Keys: ${mdKeys(s.keys)}` : ''}`);
    if (s.img) L.push('', `   ![Step ${i + 1}](${IMG_FROM_DOCS}${s.img})`);
    L.push('');
  });
  if (p.mouse) L.push('## With the mouse', '', mdLinks(p.mouse), '');
  if (p.tips.length) L.push('## Tips', '', ...p.tips.map((t) => `- ${mdLinks(t)}`), '');
  if (p.problems.length) L.push('## If something goes wrong', '', ...p.problems.map((x) => `- **${x.p}** — ${mdLinks(x.fix)}`), '');
  if (p.related.length) L.push('## Related', '', ...p.related.map((r) => `- [${r.q}](${fileOf(byId[r.id])})`), '');
  L.push('---', `[All how-tos](README.md) · Action ${p.id}${p.robot.at ? ` · screenshots from the robot run of ${p.robot.at.slice(0, 10)}` : ''}`, '');
  return L.join('\n');
}

function indexMarkdown(pages) {
  const L = ['# Dental Machine user manual — How do I…?', ''];
  L.push(`One page for each of the ${pages.length} things people do in the office, most frequent first. The steps and screenshots come from the measuring robot doing each one in the real app ([how it’s made](../testing.md#user-manual-npm-run-manual)); the same pages are in the app under **Help → How do I…**, where **Print the whole manual** prints all of them (or saves them as a PDF from the browser’s print box).`, '');
  L.push('Anywhere in the app: <kbd>?</kbd> lists the keyboard shortcuts for the screen you are on, <kbd>Ctrl/⌘ K</kbd> opens the command bar (type “how do I …” or “help …” to find a page here), and a green notice with **Undo** (or <kbd>Ctrl/⌘ Z</kbd>) takes back most changes for a few seconds.', '');
  L.push('If a screen says **“Missing permission: …”**, your role doesn’t include that job — ask the office manager (Settings → Users & roles).', '');
  const line = (p) => `- [${p.q}](${fileOf(byId[p.id])})${p.keyboard ? ' ⌨' : ''}`;
  L.push('⌨ marks the jobs that can be done from the keyboard alone. Each list is in order of how often the job comes up.', '');
  L.push('## By role', '');
  for (const role of ROLE_ORDER) {
    // Everyone’s jobs are in every role’s list too.
    const list = pages.filter((p) => p.roles.includes(role) || (role !== 'everyone' && p.roles.includes('everyone')));
    if (!list.length) continue;
    L.push(`### ${role === 'everyone' ? 'Everyone' : cap(role)}`, '', ...list.map(line), '');
  }
  L.push('## By area', '');
  const areas = [...new Set(pages.map((p) => p.area))];
  for (const area of areas) L.push(`### ${AREA_LABEL[area] || cap(area)}`, '', ...pages.filter((p) => p.area === area).map(line), '');
  return L.join('\n');
}

// ---------- PDF ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function printHtml(pages, jpegDir) {
  const img = (src, alt) => (src ? `<img src="${pathToFileURL(join(jpegDir, src.replace(/^img\//, '').replace(/\.webp$/, '.jpg'))).href}" alt="${esc(alt)}">` : '');
  const keys = (ks) => ks.map((k) => (k.t ? `type “${esc(k.t)}”` : `<kbd>${esc(k.k)}</kbd>${k.n ? ` ×${k.n}` : ''}`)).join(' ');
  const toc = pages.map((p, i) => `<li><a href="#${p.id}">${esc(p.q)}</a> <span class="pg">${i + 1}</span></li>`).join('');
  const body = pages.map((p) => `
  <section id="${p.id}">
    <h1>${esc(p.q)}</h1>
    <p class="meta"><b>Who:</b> ${esc(p.roles.join(', '))} · <b>Where:</b> ${esc(p.where)} · <b>How often:</b> ${esc(p.often)}</p>
    ${p.what ? `<p>${esc(p.what)}</p>` : ''}
    ${p.start?.img ? `<figure class="start">${img(p.start.img, 'Where to start')}<figcaption>Where to start${p.start.text ? ` — ${esc(p.start.text)}` : ''}</figcaption></figure>` : ''}
    <ol>${p.steps.map((s, i) => `<li><p>${esc(s.text)}${s.keys.length ? `<br><span class="keys">Keys: ${keys(s.keys)}</span>` : ''}</p>${img(s.img, `Step ${i + 1}`)}</li>`).join('')}</ol>
    ${p.mouse ? `<h2>With the mouse</h2><p>${esc(p.mouse)}</p>` : ''}
    ${p.tips.length ? `<h2>Tips</h2><ul>${p.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    ${p.problems.length ? `<h2>If something goes wrong</h2><ul>${p.problems.map((x) => `<li><b>${esc(x.p)}</b> — ${esc(x.fix)}</li>`).join('')}</ul>` : ''}
  </section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Dental Machine user manual</title><style>
  body { font: 11pt/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; }
  section { break-before: page; }
  h1 { font-size: 17pt; margin: 0 0 4px; } h2 { font-size: 12pt; margin: 14px 0 4px; }
  .meta { color: #555; font-size: 9.5pt; margin: 0 0 8px; }
  img { width: 15cm; border: 1px solid #ccc; border-radius: 4px; display: block; margin: 4px 0 10px; }
  figure { margin: 0; } figcaption { font-size: 9pt; color: #555; }
  li { break-inside: avoid; } ol > li p { margin: 4px 0; }
  kbd { border: 1px solid #bbb; border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; font: 9pt monospace; }
  .keys { color: #444; font-size: 9.5pt; }
  .cover h1 { font-size: 26pt; margin-top: 30%; } .toc { columns: 2; column-gap: 36px; font-size: 9pt; padding-left: 0; list-style-position: inside; } .toc li { text-indent: -1.6em; padding-left: 1.6em; } .toc a { color: #111; text-decoration: none; } .pg { display: none; }
  </style></head><body>
  <div class="cover"><h1>Dental Machine — How do I…?</h1><p>The office user manual: ${pages.length} tasks, most frequent first, with the keys and the screenshots of each step. Generated ${new Date().toISOString().slice(0, 10)} from the app itself.</p></div>
  <section><h1>Contents</h1><ol class="toc">${toc}</ol></section>
  ${body}</body></html>`;
}

// ---------- run ----------
async function main() {
  if (args.includes('--check')) {
    const have = new Set(previous.pages.filter((p) => p.steps?.length).map((p) => p.id));
    const problems = [];
    for (const a of actions) {
      if (!have.has(a.id)) problems.push(`${a.id} ${a.name}: no page with steps in client/public/manual/manual.json`);
      if (!notes[a.id]?.what) problems.push(`${a.id} ${a.name}: no notes in e2e/actions/manual-notes.json`);
      if (!existsSync(join(DOCS, fileOf(a)))) problems.push(`${a.id} ${a.name}: no docs/manual/${fileOf(a)}`);
    }
    for (const id of Object.keys(notes)) if (!id.startsWith('_') && !byId[id]) problems.push(`manual-notes.json has ${id}, which is not in actions.json`);
    if (problems.length) { console.error(`The manual is out of date (run npm run manual):\n  ${problems.join('\n  ')}`); process.exit(1); }
    console.log(`The manual has a page for all ${actions.length} actions.`);
    return;
  }
  mkdirSync(IMG_DIR, { recursive: true });
  mkdirSync(DOCS, { recursive: true });
  const order = [...actions].sort((x, y) => (y.perDay || 0) - (x.perDay || 0) || x.id.localeCompare(y.id));
  const pages = [];
  try {
    for (const a of order) pages.push(await pageFor(a, relatedOf(a)));
  } finally {
    await browser?.close();
  }
  // Pictures of actions that no longer exist.
  const ids = new Set(actions.map((a) => a.id));
  for (const f of readdirSync(IMG_DIR)) if (!ids.has(f.slice(0, 4))) rmSync(join(IMG_DIR, f));
  // Markdown pages: one per action (old files for renamed questions are removed).
  const want = new Set(order.map(fileOf));
  for (const f of readdirSync(DOCS)) if (/^A\d{3}-.*\.md$/.test(f) && !want.has(f)) rmSync(join(DOCS, f));
  for (const p of pages) writeFileSync(join(DOCS, fileOf(byId[p.id])), markdown(p));
  writeFileSync(join(DOCS, 'README.md'), indexMarkdown(pages));
  const generated = pages.map((p) => p.robot.at).filter(Boolean).sort().at(-1) || null;
  // One page per line, so a regeneration's diff shows which pages changed.
  writeFileSync(join(APP_DIR, 'manual.json'), `{"generated":${JSON.stringify(generated)},"pages":[\n${pages.map((p) => JSON.stringify(p)).join(',\n')}\n]}\n`);
  if (args.includes('--pdf')) {
    mkdirSync(join(DOCS, 'out'), { recursive: true });
    // Chrome keeps JPEGs as they are inside a PDF but stores other pictures uncompressed (113 MB), so the PDF
    // gets its own smaller JPEG copies, made in a temporary folder.
    const { chromium } = await import('playwright');
    const b = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
    const jpegDir = mkdtempSync(join(tmpdir(), 'dm-manual-'));
    try {
      const page = await b.newPage();
      for (const f of readdirSync(IMG_DIR)) {
        const data = `data:image/webp;base64,${readFileSync(join(IMG_DIR, f)).toString('base64')}`;
        const url = await page.evaluate(async ([d, w, q]) => {
          const im = new Image();
          im.src = d;
          await im.decode();
          const c = document.createElement('canvas');
          c.width = Math.min(w, im.width);
          c.height = Math.round((im.height * c.width) / im.width);
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          return c.toDataURL('image/jpeg', q);
        }, [data, PDF_IMG_WIDTH, PDF_IMG_QUALITY]);
        writeFileSync(join(jpegDir, f.replace(/\.webp$/, '.jpg')), Buffer.from(url.split(',')[1], 'base64'));
      }
      const html = join(jpegDir, 'manual.html');
      writeFileSync(html, printHtml(pages, jpegDir));
      await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
      await page.pdf({ path: join(DOCS, 'out/manual.pdf'), format: 'Letter', margin: { top: '14mm', bottom: '14mm', left: '14mm', right: '14mm' }, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#777">Dental Machine — How do I…? · <span class="pageNumber"></span>/<span class="totalPages"></span></div>' });
    } finally {
      await b.close();
      rmSync(jpegDir, { recursive: true, force: true });
    }
  }
  const imgs = readdirSync(IMG_DIR);
  const bytes = imgs.reduce((s, f) => s + statSync(join(IMG_DIR, f)).size, 0);
  const pdf = args.includes('--pdf') && existsSync(join(DOCS, 'out/manual.pdf')) ? statSync(join(DOCS, 'out/manual.pdf')).size : 0;
  const by = (s) => pages.filter((p) => p.robot.status === s);
  console.log(`${pages.length} pages · ${imgs.length} pictures (${(bytes / 1e6).toFixed(1)} MB)${pdf ? ` · docs/manual/out/manual.pdf ${(pdf / 1e6).toFixed(1)} MB` : ''}`);
  for (const [s, what] of [['partial', 'the robot got stuck part-way (steps up to there are shown)'], ['blocked', 'the demo office can’t do it (steps up to there are shown)'], ['notes', 'written by hand (no complete robot run, or notes ask for it)']]) {
    if (by(s).length) console.log(`  ${by(s).length} ${what}: ${by(s).map((p) => p.id).join(' ')}`);
  }
  const kept = pages.filter((p) => p.robot.kept);
  if (kept.length) console.log(`  ${kept.length} kept from the last manual (no robot output here): ${kept.map((p) => p.id).join(' ')}`);
  const missing = actions.filter((a) => !notes[a.id]?.what);
  if (missing.length) console.log(`  ${missing.length} without notes in manual-notes.json: ${missing.map((a) => a.id).join(' ')}`);
  console.log(`→ client/public/manual/ (in the app: Help → How do I…) and docs/manual/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
