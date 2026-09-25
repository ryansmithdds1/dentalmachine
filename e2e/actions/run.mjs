// The measuring robot's runner: `npm run actions` measures every action that has a script; `npm run actions -- A012 A013`
// just those (ids, or area names such as `schedule`). Starts a fresh demo server (e2e/lib/server.mjs), signs in each
// role once, and runs each action in its own clean browser as the right person.
//
// Output (gitignored): e2e/actions/out/<id>/NN-step.png + result.json, and e2e/actions/out/results.json (all results,
// merged with earlier runs so a partial run only replaces what it measured). Then `npm run actions:report` rewrites
// docs/workflows/actions.md and the tables in docs/workflows/scorecard.md.
//
// Env: CLIENT_DIST=/path/to/built/client (default client/dist), ACTIONS_OUT=dir, E2E_URL=http://… to use a running
// server, ACTIONS_TIMEOUT=ms per action (default 60000), ACTIONS_HEADED=1 to watch.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startApp } from '../lib/server.mjs';
import { ROLES, tokenFor, contextAs } from '../lib/watch.mjs';
import { robot, apiAs, INSTRUMENT } from './lib/robot.mjs';
import { scoreOf } from './lib/score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.ACTIONS_OUT || join(here, 'out');
const TIMEOUT = Number(process.env.ACTIONS_TIMEOUT) || 60_000;
// Calls and texts come in as signed Twilio webhooks (scripts/comms.mjs); the local server needs to know the test token.
process.env.TWILIO_AUTH_TOKEN ||= 'robot-twilio-token';

const actions = JSON.parse(readFileSync(join(here, 'actions.json'), 'utf8'));
const byId = Object.fromEntries(actions.map((a) => [a.id, a]));

// Every script file exports { A012: { role, area?, run(t, setup), setup?(t) } }.
async function loadScripts() {
  const scripts = {};
  const dir = join(here, 'scripts');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort()) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    for (const [id, def] of Object.entries(mod.default || {})) {
      if (!byId[id]) throw new Error(`${f}: ${id} is not in actions.json`);
      if (scripts[id]) throw new Error(`${id} has two scripts (${scripts[id].file} and ${f})`);
      scripts[id] = { ...def, file: f, area: f.replace(/\.mjs$/, '') };
    }
  }
  return scripts;
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took longer than ${ms / 1000} s`)), ms))]);

async function main() {
  const args = process.argv.slice(2);
  const scripts = await loadScripts();
  let ids = Object.keys(scripts).sort();
  if (args.includes('--list')) {
    for (const id of ids) console.log(`${id}  ${scripts[id].area.padEnd(10)} ${byId[id].name}`);
    return;
  }
  const picks = args.filter((a) => !a.startsWith('--'));
  if (picks.length) {
    const want = new Set();
    for (const p of picks) {
      const id = p.toUpperCase();
      if (scripts[id]) want.add(id);
      else if (Object.values(scripts).some((s) => s.area === p)) ids.filter((i) => scripts[i].area === p).forEach((i) => want.add(i));
      else console.warn(`No script for ${p}${byId[id] ? ` (${byId[id].name}: ${byId[id].route === 'MISSING' ? 'missing from the app' : 'not written yet'})` : ''}`);
    }
    ids = ids.filter((i) => want.has(i));
  }
  if (!ids.length) { console.log('Nothing to run.'); return; }
  if (!process.env.CLIENT_DIST && !existsSync(join(here, '../../client/dist/index.html'))) {
    console.error('Build the client first: cd client && npx vite build --outDir /tmp/dist-actions, then CLIENT_DIST=/tmp/dist-actions npm run actions');
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const app = await startApp();
  const browser = await chromium.launch({ headless: !process.env.ACTIONS_HEADED, ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}) });
  // One sign-in per role that's needed (sign-ins are rate limited per address). Against a server you started
  // (E2E_URL) the tokens are kept in the output folder and reused while they still work.
  const tokens = {};
  const apis = {};
  const cacheFile = join(OUT, '.tokens.json');
  const cache = process.env.E2E_URL && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
  const roles = new Set(['admin', ...ids.map((id) => scripts[id].role || 'admin')]);
  for (const role of roles) {
    const cached = cache[app.base]?.[role];
    if (cached && (await fetch(`${app.base}/api/auth/me`, { headers: { Authorization: `Bearer ${cached}` } }).then((r) => r.ok, () => false))) tokens[role] = cached;
    else tokens[role] = await tokenFor(app.base, ROLES[role]);
  }
  // Scripts may ask for any role's API (set-up as another person): signed in lazily.
  for (const role of Object.keys(ROLES)) {
    let api = tokens[role] ? apiAs(app.base, tokens[role]) : null;
    const lazy = async () => { if (!api) { tokens[role] = await tokenFor(app.base, ROLES[role]); api = apiAs(app.base, tokens[role]); } return api; };
    apis[role] = new Proxy({}, { get: (_, k) => async (...a) => (await lazy())[k](...a) });
  }
  if (process.env.E2E_URL) writeFileSync(cacheFile, JSON.stringify({ [app.base]: tokens }));
  const today = (await apis.admin.get('/dashboard')).today;
  const file = join(OUT, 'results.json');
  const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  let n = 0;
  try {
    for (const id of ids) {
      const def = scripts[id];
      const action = byId[id];
      const role = def.role || 'admin';
      rmSync(join(OUT, id), { recursive: true, force: true });
      // A role whose session ended (e.g. an action changed that person's role) signs in again.
      if (!(await fetch(`${app.base}/api/auth/me`, { headers: { Authorization: `Bearer ${tokens[role]}` } }).then((r) => r.ok, () => false))) tokens[role] = await tokenFor(app.base, ROLES[role]);
      const ctx = await contextAs(browser, { token: tokens[role] });
      await ctx.addInitScript(INSTRUMENT);
      const page = await ctx.newPage();
      page.setDefaultTimeout(15_000);
      const t = robot({ page, ctx, base: app.base, api: apis[role], action, outDir: OUT, today });
      t.role = role;
      t.as = (r) => apis[r];
      t.browser = browser;
      t.tokens = tokens;
      let result;
      try {
        const setup = def.setup ? await withTimeout(def.setup(t), TIMEOUT, 'set-up') : undefined;
        await withTimeout(def.run(t, setup), TIMEOUT, 'the action');
        result = await t.finish();
        for (const fn of t.afters) await fn().catch(() => {});
      } catch (error) {
        result = await t.finish({ error });
      }
      await ctx.close().catch(() => {});
      const s = scoreOf(result, action);
      Object.assign(result, s, { area: def.area, measuredAt: new Date().toISOString() });
      writeFileSync(join(OUT, id, 'result.json'), JSON.stringify(result, null, 2));
      all[id] = result;
      writeFileSync(file, JSON.stringify(all, null, 2));
      n++;
      const why = result.hardFail ? `  ✗ ${result.hardFail}` : '';
      console.log(`${id} ${String(result.score).padStart(3)} ${result.grade}  ${String(result.actions).padStart(2)} actions (${result.clicks}c ${result.keys}k ${result.fields}f) ${result.screens} screens ${(result.ms / 1000).toFixed(1)}s  ${action.name}${why}`);
    }
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${n} actions measured → ${file}\nScreenshots: ${OUT}/<id>/\nNext: npm run actions:report`);
}

main().catch((e) => { console.error(e); process.exit(1); });
