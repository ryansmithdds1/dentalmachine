// NAV · The module bar (client/src/nav/): like Open Dental's, one click on a module goes straight to it —
// Schedule, the active patient's Family / Account / Treatment Plan / Chart / Images, Manage (today's dashboard) —
// and the rest of each module is in a dropdown (chevron, hover, or → on the focused module). With no active
// patient a patient module asks for one and then opens its tab. Badges roll up onto the modules, up to 3 pins
// follow the person, the phone menu lists the modules, and every page is still reachable by Ctrl/⌘K.
/* global document, window */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, launch, signIn, root } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser;
const people = {};
const as = async (who, email, opts) => { people[who] = await signIn(browser, app.base, { email, ...opts }); return people[who]; };

before(async () => {
  app = await startApp();
  browser = await launch();
});
after(async () => { await browser?.close(); await app?.stop(); });

const ALL = ['schedule', 'family', 'account', 'treatment', 'chart', 'images', 'manage'];
const mod = (key) => `.rail-mod[data-module="${key}"] .rail-mod-btn`;
const chev = (key) => `.rail-mod[data-module="${key}"] .rail-mod-chev`;
const modulesOf = (page) => page.locator('.rail-mod').evaluateAll((els) => els.map((e) => e.dataset.module));
const itemsOf = (page, key) => page.locator(`#rail-fly-${key} [data-page]`).evaluateAll((els) => els.map((e) => e.dataset.page).filter((p) => p !== 'pick'));
const sectionsOf = (page, key) => page.locator(`#rail-fly-${key} .rail-fly-sub`).evaluateAll((els) => els.map((e) => e.textContent));
const badgeOf = async (page, key) => {
  const b = page.locator(`${mod(key)} .nav-badge`);
  return (await b.count()) ? Number(await b.innerText()) : 0;
};
// The dropdown's own badges (in the page even while it's closed).
const itemBadges = (page, key) => page.locator(`#rail-fly-${key} .nav-badge`).evaluateAll((els) => els.reduce((s, e) => s + Number(e.textContent), 0));
// The highlighted module(s), once the menu has caught up with the address.
const activeModule = async (page, want) => {
  if (want) await page.locator(`${mod(want)}.active`).waitFor({ timeout: 5000 }).catch(() => {});
  return page.locator('.rail-mod-btn.active').evaluateAll((els) => els.map((e) => e.closest('.rail-mod').dataset.module));
};
const focusedModule = (page) => page.evaluate(() => document.activeElement.closest('.rail-mod')?.dataset.module);
const patientOf = async (s) => (await s.get('/patients?limit=5')).rows[0];

test('NAV the same seven modules for everyone, with only the pages each person can use', async () => {
  const expected = {
    admin: 'admin@demo.dentalmachine.app', front: 'frontdesk@demo.dentalmachine.app', dentist: 'dr.chen@demo.dentalmachine.app',
    hygienist: 'sam@demo.dentalmachine.app', billing: 'billing@demo.dentalmachine.app',
  };
  for (const [who, email] of Object.entries(expected)) {
    const { page, errors } = await as(who, email);
    await page.locator('.rail-mod').first().waitFor();
    assert.deepEqual(await modulesOf(page), ALL, `${who}: modules, in Open Dental's order`);
    assert.equal(await page.locator('.rail-foot a[href="/settings"]').count(), 1);
    assert.equal(await page.locator('.rail-foot a[href="/help"]').count(), 1);
    // The merged insurance pages are nowhere in the menu.
    assert.equal(await page.locator('.sidebar a[href="/verification"], .sidebar a[href="/insurance-autopilot"]').count(), 0);
    assert.deepEqual(errors, [], `${who}: page errors`);
  }
  const a = people.admin.page;
  assert.deepEqual(await itemsOf(a, 'schedule'), ['/requests', '/capacity', '/lab-checkin']);
  assert.deepEqual(await itemsOf(a, 'family'), ['/patients', '/followups', '/recall', '/referrals']);
  assert.deepEqual(await itemsOf(a, 'account'), ['/claims', '/claims?tab=approve', '/deposits']);
  assert.deepEqual(await itemsOf(a, 'treatment'), ['/recall?type=treatment']);
  assert.deepEqual(await itemsOf(a, 'chart'), ['tab:perio', '/chart-audit', '/xray-review']);
  assert.deepEqual(await itemsOf(a, 'images'), ['/documents']);
  assert.deepEqual(await itemsOf(a, 'manage'), ['/attention', '/messages', '/calls', '/phones', '/campaigns', '/reputation', '/reports', '/metrics', '/business',
    '/marketing', '/finance', '/ask', '/group', '/office', '/checklists', '/timeclock', '/intranet']);
  // Manage puts what a role uses most first.
  assert.deepEqual(await sectionsOf(a, 'manage'), ['Today', 'Messages & calls', 'Numbers', 'Office']);
  assert.deepEqual(await sectionsOf(people.billing.page, 'manage'), ['Numbers', 'Today', 'Messages & calls', 'Office']);
  assert.deepEqual(await sectionsOf(people.front.page, 'manage'), ['Messages & calls', 'Today', 'Office']);
  assert.deepEqual((await sectionsOf(people.dentist.page, 'manage'))[0], 'Today');
  // What a role can't use stays hidden: billing staff don't check in lab cases or run campaigns.
  assert.ok(!(await itemsOf(people.billing.page, 'schedule')).includes('/lab-checkin'));
  assert.ok(!(await itemsOf(people.billing.page, 'manage')).includes('/campaigns'));
  assert.ok((await itemsOf(people.front.page, 'schedule')).includes('/requests'));
  // A module with nothing this person can use is hidden: an assistant can't see ledgers, so no Account.
  const email = `nav-assistant-${Date.now()}@demo.dentalmachine.app`;
  const u = await people.admin.post('/users', { email, name: 'Nia Assistant', role: 'assistant', password: 'demo-password-123' });
  assert.ok(u.id, JSON.stringify(u));
  const asst = await signIn(browser, app.base, { email });
  await asst.page.locator('.rail-mod').first().waitFor();
  assert.deepEqual(await modulesOf(asst.page), ALL.filter((k) => k !== 'account'));
  assert.deepEqual(asst.errors, []);
  await asst.ctx.close();
});

test('NAV badges roll up onto the module, so nothing hides behind a closed dropdown', async () => {
  const s = people.admin;
  const { page } = s;
  const unread = (await s.get('/conversations/unread')).unread;
  const waiting = (await s.get('/claim-queue/count')).count;
  await page.goto(`${app.base}/`);
  await page.locator('.rail-mod').first().waitFor();
  await page.waitForTimeout(800);
  const mine = (await s.get('/issues?role=mine')).issues.length;
  for (const k of await modulesOf(page)) assert.equal(await badgeOf(page, k), await itemBadges(page, k), `${k}: the module shows the sum of its pages`);
  // Account shows the claims ready to approve; Manage shows Needs attention, unread texts and the office's to-dos.
  assert.equal(await badgeOf(page, 'account'), waiting, 'Account: claims ready to approve');
  assert.equal(Number(await page.locator('#rail-fly-account [data-page="/claims?tab=approve"] .nav-badge').innerText().catch(() => '0')), waiting);
  assert.equal(Number(await page.locator('#rail-fly-manage [data-page="/messages"] .nav-badge').innerText().catch(() => '0')), unread, 'Messages: unread texts');
  assert.equal(Number(await page.locator('#rail-fly-manage [data-page="/attention"] .nav-badge').innerText().catch(() => '0')), mine, 'Needs attention: my list');
  assert.ok(await badgeOf(page, 'manage') >= unread + mine, 'Manage rolls up Needs attention and Messages');
  assert.ok(unread + waiting > 0, 'the demo has something to count');
  assert.equal(await badgeOf(people.billing.page, 'account'), waiting);
  assert.deepEqual(s.errors, []);
});

test('NAV one click on each module lands on its page; the patient modules open the active patient', async () => {
  const s = people.front;
  const { page } = s;
  await trackActions(page);
  const p = await patientOf(s);
  // Opening a chart makes them the active patient (activePatient.jsx).
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.locator('.pt-tabs').waitFor();
  await page.goto(`${app.base}/schedule`);
  await page.locator(mod('family')).waitFor();
  assert.match(await page.locator('.rail-patient').getAttribute('aria-label'), new RegExp(p.last_name), 'the menu names the active patient');
  const cases = [
    ['family', new RegExp(`/patients/${p.id}\\?tab=overview$`), 'Overview', 'Family'],
    ['account', new RegExp(`/patients/${p.id}\\?tab=ledger$`), 'Ledger', 'Account'],
    ['treatment', new RegExp(`/patients/${p.id}\\?tab=treatment$`), 'Treatment plans', 'Treatment Plan'],
    ['chart', new RegExp(`/patients/${p.id}\\?tab=chart$`), 'Chart', 'Chart'],
    ['images', new RegExp(`/patients/${p.id}\\?tab=documents$`), 'Documents & x-rays', 'Images'],
    ['manage', /\/$/, null, null],
    ['schedule', /\/schedule$/, null, null],
  ];
  for (const [key, url, tab, header] of cases) {
    const r = await measure(page, async () => {
      await page.click(mod(key));
      await page.waitForURL(url);
    });
    console.log(withinBudget(`NAV one click: ${key}`, r, { actions: 1, ms: 5000 }));
    assert.deepEqual(await activeModule(page, key), [key], `${key} is highlighted`);
    if (tab) {
      // The patient page shows the module you're in, over the name and on the tab strip, and the tab is open.
      await page.locator('.tabs button.active', { hasText: tab }).waitFor();
      assert.equal(await page.locator('.pt-module').innerText(), header.toUpperCase());
      assert.equal(await page.locator('.pt-tab-group.in').getAttribute('data-module'), key);
    }
  }
  // On the patient page, the modules just switch tabs in place, and a tab click moves the highlight too.
  await page.click(mod('chart'));
  await page.waitForURL(/tab=chart$/);
  await page.evaluate(() => { window.__stayed = true; });
  await page.click(mod('account'));
  await page.waitForURL(/tab=ledger$/);
  assert.equal(await page.evaluate(() => window.__stayed), true, 'no page reload');
  await page.click('.tabs button:has-text("Perio")');
  await page.waitForURL(/tab=perio$/);
  assert.deepEqual(await activeModule(page, 'chart'), ['chart'], 'Perio is part of Chart');
  await page.click('.tabs button:has-text("Insurance")');
  await page.waitForURL(/tab=insurance$/);
  assert.deepEqual(await activeModule(page, 'family'), ['family'], 'Insurance is part of Family');
  // Other screens of a module light it up too: a claim is Account, the chart audit is Chart.
  await page.goto(`${app.base}/claims?tab=approve`);
  await page.locator(mod('account')).waitFor();
  assert.deepEqual(await activeModule(page, 'account'), ['account']);
  assert.equal(await page.locator('#rail-fly-account [data-page="/claims?tab=approve"]').getAttribute('aria-current'), 'page');
  await page.goto(`${app.base}/recall?type=treatment`);
  await page.locator(mod('treatment')).waitFor();
  assert.deepEqual(await activeModule(page, 'treatment'), ['treatment']);
  assert.deepEqual(s.errors, []);
});

test('NAV with no active patient, a patient module asks for one and opens its tab', async () => {
  const s = await signIn(browser, app.base, { email: 'dr.chen@demo.dentalmachine.app' });
  const { page } = s;
  await trackActions(page);
  const p = await patientOf(s);
  await page.locator(mod('chart')).waitFor();
  assert.equal(await page.locator('.rail-patient.none').count(), 1, 'no patient yet');
  const r = await measure(page, async () => {
    await page.click(mod('chart'));
    await page.locator('.palette-pick', { hasText: 'Chart' }).waitFor();
    await page.keyboard.type(p.last_name);
    await page.locator('.palette-item', { hasText: p.first_name }).first().waitFor();
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/patients/\\d+\\?tab=chart$`));
  });
  console.log(withinBudget('NAV patient module with no patient: pick → chart', r, { actions: 3, ms: 6000 }));
  assert.deepEqual(await activeModule(page, 'chart'), ['chart']);
  await page.locator('.tabs button.active', { hasText: 'Chart' }).waitFor();
  // Now they're the active patient: Account is one click from anywhere.
  await page.goto(`${app.base}/schedule`);
  await page.locator('.rail-patient:not(.none)').waitFor();
  await page.click(mod('account'));
  await page.waitForURL(/\/patients\/\d+\?tab=ledger$/);
  // "Another patient…" in a patient module's dropdown switches, straight to that module's tab.
  await page.click(chev('images'));
  await page.locator('#rail-fly-images [data-page="pick"]').click();
  await page.locator('.palette-pick', { hasText: 'Images' }).waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(s.errors, []);
  await s.ctx.close();
});

test('NAV the chevron and resting on a module open its dropdown; a click on the module always navigates', async () => {
  const s = people.admin;
  const { page } = s;
  await trackActions(page);
  await page.goto(`${app.base}/`);
  const fly = page.locator('#rail-fly-schedule');
  assert.equal(await fly.isVisible(), false);
  // The chevron: a click opens it, another closes it.
  await page.click(chev('schedule'));
  await fly.waitFor({ state: 'visible' });
  assert.equal(await page.locator(chev('schedule')).getAttribute('aria-expanded'), 'true');
  assert.match(await fly.innerText(), /Online requests[\s\S]*Capacity[\s\S]*Lab check-in/);
  await page.click(chev('schedule'));
  await fly.waitFor({ state: 'hidden' });
  // Resting the pointer on the module opens it; one click on a page in it opens the page.
  await page.mouse.move(700, 400);
  const r = await measure(page, async () => {
    await page.hover(mod('schedule'));
    await fly.waitFor({ state: 'visible' });
    await fly.locator('a[data-page="/capacity"]').click();
    await page.waitForURL(/\/capacity$/);
  });
  console.log(withinBudget('NAV open a page from a module’s dropdown (hover + click)', r, { actions: 1, ms: 5000 }));
  await fly.waitFor({ state: 'hidden' });
  assert.deepEqual(await activeModule(page, 'schedule'), ['schedule'], 'Capacity is part of Schedule');
  // The module itself goes to the Schedule — never "the last page used".
  await page.click(mod('schedule'));
  await page.waitForURL(/\/schedule$/);
  // A patient tab in a dropdown: Perio for the active patient.
  const p = await patientOf(s);
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.locator('.pt-tabs').waitFor();
  await page.click(chev('chart'));
  assert.match(await page.locator('#rail-fly-chart .rail-fly-who').innerText(), new RegExp(p.last_name));
  await page.locator('#rail-fly-chart [data-page="tab:perio"]').click();
  await page.waitForURL(new RegExp(`/patients/${p.id}\\?tab=perio$`));
  assert.deepEqual(await activeModule(page, 'chart'), ['chart']);
  assert.deepEqual(s.errors, []);
});

test('NAV keyboard: Tab between modules, Enter opens one, → or ↓ opens its dropdown, Esc closes; G then a letter', async () => {
  const s = people.admin;
  const { page } = s;
  const p = await patientOf(s);
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.locator('.pt-tabs').waitFor();
  await page.goto(`${app.base}/`);
  await page.locator(mod('family')).focus();
  await page.keyboard.press('Tab'); // the chevron isn't a Tab stop: straight to the next module
  assert.equal(await focusedModule(page), 'account');
  assert.equal(await page.locator('#rail-fly-account').isVisible(), false, 'focus alone opens nothing');
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`/patients/${p.id}\\?tab=ledger$`));
  // → opens the dropdown on its first entry; arrows move; Esc closes and goes back to the module.
  await page.goto(`${app.base}/`);
  await page.locator(mod('schedule')).focus();
  await page.keyboard.press('ArrowRight');
  await page.locator('#rail-fly-schedule').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.activeElement?.dataset?.page === '/requests');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.page), '/capacity');
  await page.keyboard.press('Escape');
  await page.locator('#rail-fly-schedule').waitFor({ state: 'hidden' });
  assert.equal(await focusedModule(page), 'schedule', 'focus goes back to the module');
  // ↓ works too, and Enter opens the page.
  await page.locator(mod('manage')).focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.activeElement?.dataset?.page === '/attention');
  await page.keyboard.press('ArrowUp'); // wraps to the last page
  assert.equal(await page.evaluate(() => document.activeElement.dataset.page), '/intranet');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/intranet/);
  await page.locator('#rail-fly-manage').waitFor({ state: 'hidden' });
  // "G then a letter": the old ones still jump, and A / C / I open the active patient's Account, Chart, Images.
  await page.goto(`${app.base}/`);
  await page.locator(mod('schedule')).waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  for (const [key, url] of [['b', /\/claims$/], ['c', /tab=chart$/], ['a', /tab=ledger$/], ['i', /tab=documents$/], ['s', /\/schedule$/]]) {
    await page.keyboard.press('g');
    await page.keyboard.press(key);
    await page.waitForURL(url);
    await page.evaluate(() => document.activeElement?.blur());
  }
  await page.keyboard.press('?');
  await page.locator('.shortcut-row', { hasText: 'Go to Chart' }).waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(s.errors, []);
});

test('NAV pins: up to 3, from a dropdown (click or P), kept on the server for the person', async () => {
  const s = people.front;
  const { page } = s;
  await page.goto(`${app.base}/`);
  await page.click(chev('family'));
  const row = page.locator('#rail-fly-family .rail-fly-row', { has: page.locator('a[data-page="/referrals"]') });
  await row.hover();
  await row.locator('.rail-pin').click();
  await page.locator('.rail-pins a[href="/referrals"]').waitFor();
  // P on a focused page pins it too.
  await page.locator(mod('schedule')).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.dataset?.page === '/requests');
  await page.keyboard.press('p');
  await page.locator('.rail-pins a[href="/requests"]').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('p'); // Capacity: the third
  await page.locator('.rail-pins a[href="/capacity"]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator(mod('account')).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.dataset?.page === 'pick');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('p'); // a fourth is refused, with the reason
  await page.locator('.toast', { hasText: 'up to 3 pages' }).waitFor();
  // A page that's a tab of another (Ready to approve) has no pin.
  assert.equal(await page.locator('#rail-fly-account .rail-fly-row', { has: page.locator('[data-page="/claims?tab=approve"]') }).locator('.rail-pin').count(), 0);
  await page.keyboard.press('Escape');
  assert.deepEqual((await s.get('/me/prefs'))['nav.pins'], ['/referrals', '/requests', '/capacity']);
  // They follow the person: a new sign-in on another "computer".
  const again = await signIn(browser, app.base, { email: 'frontdesk@demo.dentalmachine.app' });
  await again.page.locator('.rail-pins a[href="/capacity"]').waitFor();
  assert.deepEqual(await again.page.locator('.rail-pins a').evaluateAll((els) => els.map((e) => e.getAttribute('href'))), ['/referrals', '/requests', '/capacity']);
  // One click on a pin opens its page; unpinning from the dropdown takes it off.
  await again.page.click('.rail-pins a[href="/requests"]');
  await again.page.waitForURL(/\/requests$/);
  await again.page.click(chev('schedule'));
  const cap = again.page.locator('#rail-fly-schedule .rail-fly-row', { has: again.page.locator('a[data-page="/capacity"]') });
  await cap.hover();
  await cap.locator('.rail-pin.on').click();
  await again.page.locator('.rail-pins a[href="/capacity"]').waitFor({ state: 'detached' });
  assert.deepEqual((await again.get('/me/prefs'))['nav.pins'], ['/referrals', '/requests']);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(again.errors, []);
  await again.ctx.close();
});

test('NAV the old insurance addresses open their Billing tabs, query string kept', async () => {
  const s = people.billing;
  const { page } = s;
  await page.goto(`${app.base}/verification?range=tomorrow&view=all`);
  await page.waitForURL(/\/claims\?tab=verification&range=tomorrow&view=all$/);
  await page.locator('.vf-page').waitFor();
  assert.equal(await page.locator('.tabs button.active', { hasText: 'Verification' }).count(), 1);
  assert.equal(await page.locator('h1', { hasText: 'Billing' }).count(), 1);
  // The verification keys still work inside the tab: 1 → today.
  await page.locator('.vf-controls').waitFor();
  await page.keyboard.press('1');
  await page.waitForURL(/range=today/);
  await page.goto(`${app.base}/insurance-autopilot?tab=settings`);
  await page.waitForURL(/\/claims\?tab=autopilot&sub=settings$/);
  await page.locator('.eob-settings').waitFor();
  await page.goto(`${app.base}/insurance-autopilot`);
  await page.waitForURL(/\/claims\?tab=autopilot$/);
  await page.locator('.eob-work').waitFor();
  // The command bar knows where they live now.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('insurance verification');
  await page.locator('.palette-item.active', { hasText: 'Insurance verification' }).waitFor();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/claims\?tab=verification$/);
  assert.deepEqual(s.errors, []);
});

test('NAV command bar: what is shown first stays first for a person who pauses before Enter (bug 2, A067)', async () => {
  const s = people.billing;
  const { page } = s;
  await page.goto(`${app.base}/schedule`);
  await page.locator('.cal-col-head').first().waitFor();
  const rows = () => page.locator('.palette-item').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  const open = async (words) => {
    await page.keyboard.press('Control+k');
    await page.locator('.palette input').waitFor();
    await page.keyboard.type(words);
    // A person reads the list before pressing Enter: every late answer (patients, documents) has arrived by now.
    await page.waitForTimeout(1500);
    return rows();
  };
  // Pages typed by name: that page is first, and no empty "Search all documents … 0 found" row ever appears.
  for (const [words, url] of [['day sheet', /\/reports\?tab=ops$/], ['new patient', /\/patients\?new=1$/], ['month-end close', null]]) {
    await page.goto(`${app.base}/schedule`);
    await page.locator('.cal-col-head').first().waitFor();
    const list = await open(words);
    assert.match(list[0], new RegExp(words, 'i'), `"${words}": first row is ${list[0]}`);
    assert.ok(!list.some((r) => /Search all documents/.test(r) && /\b0 found/.test(r)), `"${words}": no empty document search (${list.join(' | ')})`);
    if (!url) { await page.keyboard.press('Escape'); continue; }
    await page.keyboard.press('Enter');
    await page.waitForURL(url);
  }
  // A claim by number: "#N" and "claim N" put the claim first, whatever patients' phone numbers contain.
  const claims = await s.get('/claims');
  const claim = (Array.isArray(claims) ? claims : claims.rows || [])[0];
  assert.ok(claim?.id, 'the demo office has a claim');
  for (const words of [`#${claim.id}`, `claim ${claim.id}`]) {
    await page.goto(`${app.base}/schedule`);
    await page.locator('.cal-col-head').first().waitFor();
    const list = await open(words);
    assert.match(list[0], new RegExp(`Claim #${claim.id}\\b`), `"${words}": ${list.slice(0, 3).join(' | ')}`);
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/claims/${claim.id}$`));
  }
  assert.deepEqual(s.errors, []);
});

test('NAV every page in the menu is in the command bar', async () => {
  const { page } = people.admin;
  await page.goto(`${app.base}/`);
  await page.locator('.rail-mod').first().waitFor();
  const source = readFileSync(join(root, 'client/src/components/CommandPalette.jsx'), 'utf8');
  const pages = await page.locator('.sidebar a[data-page^="/"], .rail-foot a[href]').evaluateAll((els) => els.map((e) => e.dataset.page || e.getAttribute('href')));
  assert.ok(pages.length >= 30, `found ${pages.length} pages`);
  for (const to of [...pages, '/schedule', '/']) assert.ok(source.includes(`'${to}']`), `${to} is in the command bar's page list`);
});

test('NAV kept open: modules still go in one click; the chevron folds their pages out underneath', async () => {
  const s = people.dentist;
  const { page } = s;
  await page.goto(`${app.base}/patients`);
  await page.click('button[aria-label="Expand menu"]');
  const items = page.locator('.rail-mod[data-module="manage"] .rail-mod-items');
  await page.locator('.app.rail-open').waitFor();
  assert.equal(await page.locator('.rail-fly').count(), 0, 'no flyouts when kept open');
  assert.equal(await items.isVisible(), false, 'folded by default');
  assert.deepEqual(await activeModule(page, 'family'), ['family'], 'the patients list is part of Family');
  // A click on the module goes there; it doesn't just fold.
  await page.click(mod('manage'));
  await page.waitForURL(/\/$/);
  assert.equal(await items.isVisible(), false);
  await page.click(chev('manage'));
  await items.waitFor({ state: 'visible' });
  await items.locator('a[data-page="/timeclock"]').click();
  await page.waitForURL(/\/timeclock$/);
  await page.reload();
  await items.waitFor({ state: 'visible' }); // remembered on this computer
  await page.click(chev('manage'));
  await items.waitFor({ state: 'hidden' });
  await page.click('button[aria-label="Collapse menu"]');
  await page.locator('.app:not(.rail-open)').waitFor();
  assert.deepEqual(s.errors, []);
});

test('NAV phone: a Menu button opens the modules, then their extras, in a bottom sheet', async () => {
  const s = await signIn(browser, app.base, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const { page } = s;
  const menu = page.locator('.rail-menu-btn');
  await menu.waitFor();
  assert.equal(await page.locator('.rail-mod').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling');
  await menu.click();
  const sheet = page.locator('.rail-sheet');
  await sheet.waitFor();
  assert.deepEqual(await sheet.locator('.rail-sheet-group').evaluateAll((els) => els.map((e) => e.dataset.module)), ALL);
  // The module itself, then its extras.
  await sheet.locator('.rail-sheet-group[data-module="family"] a[data-page="/patients"]').click();
  await page.waitForURL(/\/patients$/);
  await sheet.waitFor({ state: 'detached' });
  assert.match(await menu.innerText(), /Patients list/);
  await menu.click();
  await sheet.locator('.rail-sheet-group[data-module="schedule"] .rail-sheet-mod').click();
  await page.waitForURL(/\/schedule$/);
  await sheet.waitFor({ state: 'detached' });
  // A patient module with no patient asks for one.
  await menu.click();
  await sheet.locator('.rail-sheet-group[data-module="chart"] .rail-sheet-mod').click();
  await page.locator('.palette-pick').waitFor();
  await page.keyboard.press('Escape');
  await menu.click();
  await sheet.waitFor();
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });
  assert.deepEqual(s.errors, []);
  await s.ctx.close();
});
