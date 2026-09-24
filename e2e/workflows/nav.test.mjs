// NAV · The grouped sidebar (client/src/nav/): seven groups plus Settings, per-role order and visibility, badges
// rolled up onto the group icons, flyouts by hover and by keyboard, up to 3 pins that follow the person, the old
// insurance addresses landing on their Billing tabs, the phone menu — and every page still reachable by Ctrl/⌘K.
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

const groupsOf = (page) => page.locator('.rail-group').evaluateAll((els) => els.map((e) => e.dataset.group));
const pagesOf = (page, group) => page.locator(`#rail-fly-${group} a[data-page]`).evaluateAll((els) => els.map((e) => e.dataset.page));
const badgeOf = async (page, group) => {
  const b = page.locator(`.rail-group[data-group="${group}"] .rail-group-btn .nav-badge`);
  return (await b.count()) ? Number(await b.innerText()) : 0;
};
// Each page's own badge in a group's flyout (in the page even while the flyout is closed).
const pageBadges = (page, group) => page.locator(`#rail-fly-${group} .nav-badge`).evaluateAll((els) => els.reduce((s, e) => s + Number(e.textContent), 0));

test('NAV each role sees its groups, in its order, with only the pages it can use', async () => {
  const expected = {
    admin: ['admin@demo.dentalmachine.app', ['today', 'schedule', 'patients', 'messages', 'billing', 'numbers', 'office']],
    front: ['frontdesk@demo.dentalmachine.app', ['schedule', 'patients', 'messages', 'today', 'billing', 'office']],
    dentist: ['dr.chen@demo.dentalmachine.app', ['schedule', 'patients', 'today', 'messages', 'office', 'billing', 'numbers']],
    hygienist: ['sam@demo.dentalmachine.app', ['schedule', 'patients', 'today', 'messages', 'office', 'billing']],
    billing: ['billing@demo.dentalmachine.app', ['billing', 'numbers', 'today', 'patients', 'schedule', 'messages', 'office']],
  };
  for (const [who, [email, groups]] of Object.entries(expected)) {
    const { page, errors } = await as(who, email);
    await page.locator('.rail-group').first().waitFor();
    assert.deepEqual(await groupsOf(page), groups, `${who}: groups`);
    // Settings and Help at the bottom for everyone.
    assert.equal(await page.locator('.rail-foot a[href="/settings"]').count(), 1);
    assert.equal(await page.locator('.rail-foot a[href="/help"]').count(), 1);
    // The merged insurance pages are nowhere in the sidebar now.
    assert.equal(await page.locator('.sidebar a[href="/verification"], .sidebar a[href="/insurance-autopilot"]').count(), 0);
    assert.deepEqual(errors, [], `${who}: page errors`);
  }
  const a = people.admin.page;
  assert.deepEqual(await pagesOf(a, 'billing'), ['/claims', '/deposits']);
  assert.deepEqual(await pagesOf(a, 'patients'), ['/patients', '/followups', '/recall', '/referrals', '/chart-audit']);
  assert.deepEqual(await pagesOf(a, 'numbers'), ['/metrics', '/reports', '/business', '/marketing', '/finance', '/ask', '/group']);
  // Clinical people get Chart audit right after Patients.
  assert.deepEqual((await pagesOf(people.dentist.page, 'patients')).slice(0, 2), ['/patients', '/chart-audit']);
  assert.deepEqual((await pagesOf(people.hygienist.page, 'patients')).slice(0, 2), ['/patients', '/chart-audit']);
  // What a role can't use stays hidden: billing staff don't check in lab cases or run campaigns.
  assert.ok(!(await pagesOf(people.billing.page, 'schedule')).includes('/lab-checkin'));
  assert.ok(!(await pagesOf(people.billing.page, 'messages')).includes('/campaigns'));
  assert.ok((await pagesOf(people.front.page, 'schedule')).includes('/requests'));
});

test('NAV badges roll up onto the group icon, so nothing hides behind a closed group', async () => {
  const s = people.admin;
  const { page } = s;
  // What the demo has waiting: unread texts, claims ready to approve, items in my Needs attention list.
  const unread = (await s.get('/conversations/unread')).unread;
  const waiting = (await s.get('/claim-queue/count')).count;
  await page.goto(`${app.base}/`);
  await page.locator('.rail-group').first().waitFor();
  await page.waitForTimeout(800);
  const mine = (await s.get('/issues?role=mine')).issues.length;
  for (const g of await groupsOf(page)) assert.equal(await badgeOf(page, g), await pageBadges(page, g), `${g}: the icon shows the sum of its pages`);
  assert.equal(await badgeOf(page, 'messages'), unread, 'Messages: unread texts');
  assert.equal(await badgeOf(page, 'billing'), waiting, 'Billing: claims ready to approve');
  assert.equal(Number(await page.locator('#rail-fly-today a[data-page="/attention"] .nav-badge').innerText().catch(() => '0')), mine, 'Needs attention: my list');
  assert.ok(unread + waiting > 0, 'the demo has something to count');
  // Billing staff see the same claims count on their first group.
  assert.equal(await badgeOf(people.billing.page, 'billing'), waiting);
  assert.deepEqual(s.errors, []);
});

test('NAV hover opens a flyout; one click opens a page; the group icon goes back to the last page used', async () => {
  const s = people.admin;
  const { page } = s;
  await trackActions(page);
  await page.goto(`${app.base}/`);
  const fly = page.locator('#rail-fly-schedule');
  assert.equal(await fly.isVisible(), false);
  const r = await measure(page, async () => {
    await page.hover('.rail-group[data-group="schedule"] .rail-group-btn');
    await fly.waitFor({ state: 'visible' });
    assert.match(await fly.innerText(), /Online requests[\s\S]*Capacity[\s\S]*Lab check-in/);
    await fly.locator('a[data-page="/capacity"]').click();
    await page.waitForURL(/\/capacity$/);
  });
  console.log(withinBudget('NAV open a page from its group (hover + click)', r, { actions: 1, ms: 5000 }));
  await fly.waitFor({ state: 'hidden' });
  assert.ok(await page.locator('.rail-group[data-group="schedule"] .rail-group-btn.active').count(), 'the group shows where you are');
  // Somewhere else, then the Schedule icon: back to Capacity, the page last used in the group.
  await page.hover('.rail-group[data-group="patients"] .rail-group-btn');
  await page.locator('#rail-fly-patients a[data-page="/referrals"]').click();
  await page.waitForURL(/\/referrals$/);
  await page.click('.rail-group[data-group="schedule"] .rail-group-btn');
  await page.waitForURL(/\/capacity$/);
  // A group never used opens its first page.
  await page.evaluate(() => localStorage.removeItem('dm_nav_last'));
  await page.reload();
  await page.click('.rail-group[data-group="numbers"] .rail-group-btn');
  await page.waitForURL(/\/metrics$/);
  assert.deepEqual(s.errors, []);
});

test('NAV keyboard: Tab reaches a flyout, arrows move, Enter opens, Esc closes', async () => {
  const s = people.admin;
  const { page } = s;
  await page.goto(`${app.base}/`);
  const today = page.locator('.rail-group[data-group="today"] .rail-group-btn');
  await today.focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab'); // the next group icon: its flyout opens
  assert.equal(await page.evaluate(() => document.activeElement.closest('.rail-group')?.dataset.group), 'schedule');
  await page.locator('#rail-fly-schedule').waitFor({ state: 'visible' });
  await page.keyboard.press('Tab'); // into the flyout
  assert.equal(await page.evaluate(() => document.activeElement.dataset.page), '/schedule');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.page), '/capacity');
  await page.keyboard.press('Escape');
  await page.locator('#rail-fly-schedule').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement.closest('.rail-group')?.dataset.group), 'schedule', 'focus goes back to the icon');
  // → opens it straight onto its first page; Enter opens the page.
  const msgs = page.locator('.rail-group[data-group="messages"] .rail-group-btn');
  await msgs.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.dataset?.page === '/messages');
  await page.keyboard.press('ArrowUp'); // wraps to the last page
  assert.equal(await page.evaluate(() => document.activeElement.dataset.page), '/reputation');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/reputation$/);
  await page.locator('#rail-fly-messages').waitFor({ state: 'hidden' });
  // "G then a letter" still jumps, and the ? list names the new labels.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('g');
  await page.keyboard.press('b');
  await page.waitForURL(/\/claims/);
  await page.keyboard.press('?');
  await page.locator('.shortcut-row', { hasText: 'Go to Billing & claims' }).waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(s.errors, []);
});

test('NAV pins: up to 3, from the flyout (click or P), kept on the server for the person', async () => {
  const s = people.front;
  const { page } = s;
  await page.goto(`${app.base}/`);
  await page.hover('.rail-group[data-group="patients"] .rail-group-btn');
  const row = page.locator('#rail-fly-patients .rail-fly-row', { has: page.locator('a[data-page="/referrals"]') });
  await row.hover();
  await row.locator('.rail-pin').click();
  await page.locator('.rail-pins a[href="/referrals"]').waitFor();
  // P on a focused page pins it too.
  const sched = page.locator('.rail-group[data-group="schedule"] .rail-group-btn');
  await sched.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.dataset?.page === '/schedule');
  await page.keyboard.press('ArrowDown'); // Online requests
  await page.keyboard.press('p');
  await page.locator('.rail-pins a[href="/requests"]').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('p'); // Capacity: the third
  await page.locator('.rail-pins a[href="/capacity"]').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('p'); // a fourth is refused, with the reason
  await page.locator('.toast', { hasText: 'up to 3 pages' }).waitFor();
  assert.deepEqual((await s.get('/me/prefs'))['nav.pins'], ['/referrals', '/requests', '/capacity']);
  // They follow the person: a new sign-in on another "computer".
  const again = await signIn(browser, app.base, { email: 'frontdesk@demo.dentalmachine.app' });
  await again.page.locator('.rail-pins a[href="/capacity"]').waitFor();
  assert.deepEqual(await again.page.locator('.rail-pins a').evaluateAll((els) => els.map((e) => e.getAttribute('href'))), ['/referrals', '/requests', '/capacity']);
  // One click on a pin opens its page; unpinning from the flyout takes it off.
  await again.page.click('.rail-pins a[href="/requests"]');
  await again.page.waitForURL(/\/requests$/);
  await again.page.hover('.rail-group[data-group="schedule"] .rail-group-btn');
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

test('NAV every sidebar page is in the command bar', async () => {
  const { page } = people.admin;
  const source = readFileSync(join(root, 'client/src/components/CommandPalette.jsx'), 'utf8');
  const pages = await page.locator('.sidebar a[data-page], .rail-foot a[href]').evaluateAll((els) => els.map((e) => e.dataset.page || e.getAttribute('href')));
  assert.ok(pages.length >= 30, `found ${pages.length} pages`);
  for (const to of pages) assert.ok(source.includes(`'${to}']`), `${to} is in the command bar's page list`);
});

test('NAV kept open: groups are collapsible sections', async () => {
  const s = people.dentist;
  const { page } = s;
  await page.goto(`${app.base}/patients`);
  await page.click('button[aria-label="Expand menu"]');
  await page.locator('.rail-section').first().waitFor();
  assert.equal(await page.locator('.rail-group').count(), 0);
  // The current page's group is open; others open and close on click and stay that way.
  assert.equal(await page.locator('.rail-section[data-group="patients"] .rail-section-head').getAttribute('aria-expanded'), 'true');
  const office = page.locator('.rail-section[data-group="office"] .rail-section-head');
  assert.equal(await office.getAttribute('aria-expanded'), 'false');
  await office.click();
  await page.locator('.rail-section[data-group="office"] a[data-page="/timeclock"]').click();
  await page.waitForURL(/\/timeclock$/);
  await page.reload();
  assert.equal(await page.locator('.rail-section[data-group="office"] .rail-section-head').getAttribute('aria-expanded'), 'true');
  await page.click('button[aria-label="Collapse menu"]');
  await page.locator('.rail-group').first().waitFor();
  assert.deepEqual(s.errors, []);
});

test('NAV phone: a Menu button opens the groups in a bottom sheet', async () => {
  const s = await signIn(browser, app.base, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const { page } = s;
  const menu = page.locator('.rail-menu-btn');
  await menu.waitFor();
  assert.equal(await page.locator('.rail-group').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling');
  await menu.click();
  const sheet = page.locator('.rail-sheet');
  await sheet.waitFor();
  assert.deepEqual(await sheet.locator('.rail-sheet-group').evaluateAll((els) => els.map((e) => e.dataset.group)), ['today', 'schedule', 'patients', 'messages', 'billing', 'numbers', 'office']);
  await sheet.locator('a[data-page="/patients"]').click();
  await page.waitForURL(/\/patients$/);
  await sheet.waitFor({ state: 'detached' });
  assert.match(await menu.innerText(), /Patients/);
  await menu.click();
  await sheet.waitFor();
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });
  assert.deepEqual(s.errors, []);
  await s.ctx.close();
});
