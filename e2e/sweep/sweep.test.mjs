// Every-screen sweep: opens every page of the staff app as each demo role, in light and dark mode, on a desktop,
// a tablet and a phone, and fails on anything that looks broken — a crash, a console error, a failed request,
// the page scrolling sideways, "undefined"/"NaN"/"Invalid Date"/"[object Object]" on screen, or a "Loading…"
// that never finishes. On a desktop in light mode and on a phone in dark mode it also clicks through each
// page's tabs, every Settings section and every tab of a patient's chart.
//
// Pages come from the source (the router and the menu, see lib/routes.mjs), so a new screen is swept without
// editing this file. Runs against a fresh, seeded local server (never the live site).
//   npm run build && npm run e2e:sweep
//   SWEEP_ROLES=admin,billing SWEEP_VIEWPORTS=phone SWEEP_THEMES=dark npm run e2e:sweep   (a slice)
//   SWEEP_DEEP=all (tabs everywhere) · SWEEP_WORKERS=6 · SWEEP_LOADING_SECONDS=8 · E2E_SHOTS=dir (screenshots)
/* global document, window */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startApp, launch, root } from '../lib/server.mjs';
import { ROLES, watch, settle, screenProblems, tokenFor, contextAs, quiet, shoot, writeReport, pool } from '../lib/watch.mjs';
import { sourceRoutes, idsFor, expand } from '../lib/routes.mjs';

const VIEWPORTS = { desktop: { width: 1400, height: 900 }, tablet: { width: 1024, height: 1366 }, phone: { width: 390, height: 844 } };
const pick = (env, all) => (process.env[env] ? process.env[env].split(',').map((s) => s.trim()).filter((s) => all.includes(s)) : all);
const roles = pick('SWEEP_ROLES', Object.keys(ROLES));
const viewports = pick('SWEEP_VIEWPORTS', Object.keys(VIEWPORTS));
const themes = pick('SWEEP_THEMES', ['light', 'dark']);
const WORKERS = Number(process.env.SWEEP_WORKERS) || 4;
const LOADING_MS = (Number(process.env.SWEEP_LOADING_SECONDS) || 8) * 1000;
const deepFor = (theme, vp) => process.env.SWEEP_DEEP === 'all' || (theme === 'light' && vp === 'desktop') || (theme === 'dark' && vp === 'phone');

// Known, acceptable findings. Keep this short; every entry says why it is fine. `route`, `role` and `viewport`
// narrow where an entry applies; `status`+`api` match a failed request, `screen` matches an on-screen problem.
export const ALLOW = [
  { status: 403, api: /^\/api\/diagnosis\/running/, why: 'The "Diagnosed" chip on Today asks and hides itself when the person has no numbers of their own (by design, see DiagnosisChip.jsx)' },
  { status: 403, api: /^\/api\/phones\/alerts/, why: 'Phones → Alerts is open to everyone; whether you receive phone alerts is a practice setting the server checks, and the tab then says you don’t' },
  { route: /^\/timeclock\/kiosk$/, status: 401, api: /^\/api\/kiosk\//, why: 'The time-clock kiosk runs on a registered kiosk device; opened in a staff browser it shows how to set one up' },
  // KNOWN BUGS — real layout problems at phone/tablet width found by the first sweep (Sept 2026), listed so the
  // job guards everything else while they wait for a fix. Remove each entry when its page is fixed.
  { known: true, route: /^\/(claims|insurance-autopilot)$/, viewport: /phone/, screen: /scrolls sideways/, why: 'KNOWN BUG: Billing → Eligibility: the row of buttons doesn’t wrap on a phone (components/EligibilityBatch.jsx)' },
  { known: true, route: /^\/ask$/, viewport: /phone/, screen: /scrolls sideways/, why: 'KNOWN BUG: Ask your data: the suggested-question buttons don’t wrap on a phone (pages/Ask.jsx)' },
  { known: true, route: /^\/business$/, viewport: /tablet/, screen: /scrolls sideways/, why: 'KNOWN BUG: Business: the status chips overflow by ~20px at 1024px (components/business/BusinessView.jsx)' },
  { known: true, route: /^\/timeclock$/, viewport: /phone/, screen: /scrolls sideways/, why: 'KNOWN BUG: Time clock manager tabs (settings, reports, pay period, export, corrections) are wider than a phone' },
  { known: true, route: /^\/reviews$/, viewport: /phone/, screen: /scrolls sideways/, why: 'KNOWN BUG: Reviews → Settings form is wider than a phone' },
  { known: true, route: /^\/phones$/, viewport: /phone/, screen: /scrolls sideways/, why: 'KNOWN BUG: Phones → Why they didn’t book: the reason buttons don’t wrap on a phone' },
  { route: /\/(print|ada|slip|letter|walkout|route-slip)$|\/attachments\/print$|^\/checklists\/log\/print$/, viewport: /phone|tablet/, screen: /scrolls sideways/, why: 'Printable documents are laid out on a fixed-width sheet of paper (letter / ADA form), not for a phone screen' },
];
// A page the role's menu offers, or a screen under one (a patient's chart is under /patients).
const isOffered = (role, route) => offered[role].has(route) || [...offered[role]].some((to) => to !== '/' && route.startsWith(`${to}/`));
const allowed = (ctx, kind, value) => ALLOW.find((a) => (!a.route || a.route.test(ctx.route)) && (!a.role || a.role === ctx.role) && (!a.viewport || a.viewport.test(ctx.viewport))
  && (kind === 'response' ? a.status === value.status && a.api?.test(value.path) : kind === 'screen' && a.screen?.test(value)));

let app;
let browser;
let routes = [];
let skipped = [];
const offered = {}; // role -> Set of pages the role's menu offers
const results = {}; // `${role} ${theme} ${viewport}` -> problems[]
const tolerated = [];
const checked = {}; // `${role} ${theme} ${viewport}` -> screens looked at

// The pages a role's menu offers. From the menu definition when there is one (client/src/nav/navConfig.js),
// else from the links drawn in the menu. On an offered page a 403 is a bug; on others it is the expected answer.
async function menuFor(role, token) {
  const me = await fetch(`${app.base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  const set = new Set(['/', '/settings', '/help']);
  const config = join(root, 'client/src/nav/navConfig.js');
  if (existsSync(config)) {
    try {
      const { navFor } = await import(pathToFileURL(config).href);
      const can = (perm) => me.user.role === 'admin' || me.user.permissions.includes(perm);
      for (const g of navFor({ can, user: me.user, practice: me.practice })) for (const p of g.pages) set.add(p.to);
      return set;
    } catch { /* fall back to the links on screen */ }
  }
  const ctx = await contextAs(browser, { token });
  const page = await ctx.newPage();
  await page.goto(app.base);
  await page.waitForSelector('aside, nav');
  for (const href of await page.$$eval('aside a[href^="/"], nav a[href^="/"]', (as) => as.map((a) => a.getAttribute('href')))) set.add(href.split('?')[0]);
  await ctx.close();
  return set;
}

before(async () => {
  app = await startApp();
  browser = await launch();
  const tokens = {};
  for (const r of roles) tokens[r] = await tokenFor(app.base, ROLES[r]);
  const adminToken = tokens.admin || await tokenFor(app.base, ROLES.admin);
  ({ visit: routes, skipped } = expand(sourceRoutes(), await idsFor(app.base, adminToken)));
  assert.ok(routes.length > 30, `found only ${routes.length} routes — did the router move? (lib/routes.mjs)`);
  for (const r of roles) offered[r] = await menuFor(r, tokens[r]);

  const jobs = roles.flatMap((role) => themes.flatMap((theme) => viewports.map((vp) => ({ role, theme, vp }))));
  await pool(jobs, WORKERS, async ({ role, theme, vp }) => {
    const key = `${role} ${theme} ${vp}`;
    const problems = (results[key] = []);
    const ctx = await contextAs(browser, { token: tokens[role], theme, viewport: VIEWPORTS[vp] });
    await ctx.addInitScript(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
    const page = await ctx.newPage();
    page.setDefaultTimeout(10_000);
    const w = watch(page, { base: app.base });
    const where = (route, step) => ({ role, theme, viewport: vp, route, step });

    const check = async (at) => {
      checked[key] = (checked[key] || 0) + 1;
      const settled = await settle(page, w, { timeout: LOADING_MS });
      const found = [];
      for (const p of await screenProblems(page)) {
        if (allowed(at, 'screen', p)) tolerated.push({ ...at, problem: p });
        else found.push(p);
      }
      if (!settled && !found.some((p) => p.startsWith('still loading'))) found.push(`requests still running after ${LOADING_MS / 1000}s: ${w.stillRunning()}`);
      found.push(...w.pageErrors.map((e) => `page error: ${e}`), ...w.console.map((e) => `console error: ${e}`), ...w.dialogs.map((d) => `unexpected dialog: ${d}`), ...w.failed.map((f) => `request failed: ${f}`));
      for (const r of w.responses) {
        const line = `${r.status} ${r.method} ${r.path}`;
        if (allowed(at, 'response', r)) tolerated.push({ ...at, problem: line });
        else if ((r.status === 403 || r.status === 404) && role !== 'admin' && !isOffered(role, at.route)) tolerated.push({ ...at, problem: `${line} (page not in ${role}'s menu)` });
        else found.push(`HTTP ${line}`);
      }
      w.reset();
      if (found.length) {
        const shot = await shoot(page, `sweep-${role}-${theme}-${vp}-${at.route}-${at.step || ''}`);
        problems.push({ ...at, problems: found, ...(shot ? { shot } : {}) });
        if (process.env.SWEEP_VERBOSE) console.log(`# ${role} ${theme} ${vp} ${at.route}${at.step ? ` ${at.step}` : ''}: ${found.join(' | ')}`);
      }
    };

    for (const route of routes) {
      w.reset();
      await page.goto(`${app.base}${route}`).catch((e) => w.pageErrors.push(`navigation: ${e.message}`));
      await quiet(page);
      await check(where(route));
      if (!deepFor(theme, vp)) continue;
      // Settings sections, then any page's tab strip (a patient's chart, Billing, Reports…).
      const tabSets = route === '/settings'
        ? [['.settings-nav button', await page.$$eval('.settings-nav button', (b) => b.map((x) => x.textContent.trim()))]]
        : [['.tabs >> nth=0 >> button', await page.locator('.tabs').first().locator('button').allTextContents().catch(() => [])]];
      for (const [sel, labels] of tabSets) {
        for (const [i, label] of labels.slice(0, 25).entries()) {
          const btn = page.locator(sel).nth(i);
          if (!(await btn.isVisible().catch(() => false))) continue;
          await btn.click({ timeout: 5000 }).catch((e) => w.pageErrors.push(`could not open tab "${label}": ${e.message.split('\n')[0]}`));
          await quiet(page);
          await check(where(route, `tab "${label.replace(/\s+/g, ' ').slice(0, 40)}"`));
          if (!page.url().startsWith(`${app.base}${route.split('?')[0]}`)) await page.goto(`${app.base}${route}`).catch(() => {});
        }
      }
    }
    // The theme really applied (a dark sweep that silently ran light would miss dark-only bugs).
    const applied = await page.evaluate(() => document.documentElement.dataset.theme).catch(() => null);
    if (applied && applied !== theme) problems.push({ ...where('/'), problems: [`theme is ${applied}, expected ${theme}`] });
    await ctx.close();
    writeReport('sweep-report.json', { checked, routes, skipped, results, tolerated }); // as it goes, for long runs
  });
  writeReport('sweep-report.json', { checked, routes, skipped, offered: Object.fromEntries(Object.entries(offered).map(([k, v]) => [k, [...v]])), results, tolerated });
});

after(async () => { await browser?.close(); await app?.stop(); });

test('the sweep found the app\'s pages', () => {
  assert.ok(routes.includes('/schedule') && routes.includes('/settings') && routes.some((r) => /^\/patients\/\d+$/.test(r)), `routes: ${routes.join(' ')}`);
  if (skipped.length) console.log(`# not swept (needs an id the demo data doesn't have): ${skipped.join(', ')}`);
  if (tolerated.length) console.log(`# tolerated (allowlisted or not in that role's menu): ${tolerated.length}`);
});

for (const role of roles) {
  for (const theme of themes) {
    for (const vp of viewports) {
      test(`${role} · ${theme} · ${vp}: every page draws cleanly`, () => {
        const found = results[`${role} ${theme} ${vp}`] || [];
        assert.ok(checked[`${role} ${theme} ${vp}`] >= routes.length, 'every page was looked at');
        assert.deepEqual(found.map((f) => `${f.route}${f.step ? ` ${f.step}` : ''}: ${f.problems.join(' | ')}`), []);
      });
    }
  }
}
