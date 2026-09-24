// Patient portal 2.0 and "Pay my bill" (docs/workflows/specs/PT-portal.md): a patient clicks "Pay my bill" on the
// practice's website and pays their statement in at most 4 actions (sandbox card); the portal shows the account at a
// glance — what's owed now and why, the family, each visit — and takes a payment; checked on a phone-sized screen and
// in Spanish. Runs against e2e/lib/portal-app.mjs (the routers added until app.js mounts them) and a client build that
// has the /billpay/:slug route (CLIENT_DIST; see the spec for the build command until App.jsx has the route).
/* global document, window */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

let app; let browser; let staff; let slug; let provider;

before(async () => {
  app = await startApp({ entry: 'e2e/lib/portal-app.mjs' });
  browser = await launch();
  staff = await signIn(browser, app.base);
  const practice = await staff.get('/practice');
  slug = practice.slug || 'bright-smiles';
  if (!practice.slug || !practice.portal_enabled) await staff.api('PUT', '/practice', { slug, portal_enabled: true });
  provider = (await staff.get('/providers')).find((p) => p.type === 'dentist') || (await staff.get('/providers'))[0];
});
after(async () => { await browser?.close(); await app?.stop(); });

const uniq = () => Math.random().toString(36).slice(2, 7).replace(/\d/g, 'q');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
async function account({ kids = 0 } = {}) {
  const last = `Paytest${cap(uniq())}`;
  const phone = `(512) 555-${String(1000 + Math.floor(Math.random() * 8999))}`;
  const head = await staff.post('/patients', { first_name: 'Rosa', last_name: last, dob: '1980-02-03', phone, email: `${last.toLowerCase()}@example.com`, zip: '78704' });
  assert.ok(head.id, JSON.stringify(head));
  await staff.post(`/patients/${head.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id, complete: true });
  const members = [];
  for (let i = 0; i < kids; i++) {
    const kid = await staff.post('/patients', { first_name: `Kid${i}`, last_name: last, dob: '2014-05-06', guarantor_id: head.id });
    await staff.post(`/patients/${kid.id}/procedures`, { code: 'D1120', provider_id: provider.id, complete: true });
    members.push(kid);
  }
  return { head, members, last, phone };
}
async function phonePage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await trackActions(page);
  return { ctx, page, errors };
}

test('Pay my bill: from the practice website to paid in at most 4 actions, posted once to the ledger', async () => {
  const { head } = await account();
  const { code } = await staff.get(`/patients/${head.id}/billpay-code`);
  assert.match(code, /^[2-9A-Z]{5}-[2-9A-Z]{5}$/, 'the account has a statement code');
  const owed = (await staff.get(`/patients/${head.id}/ledger`)).balance;
  const { ctx, page, errors } = await phonePage();
  // The practice's own website, with the one-line button.
  // (served from another local port: Chromium won't let a public site's page load scripts from localhost)
  const site = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' })
    .end(`<html><head><meta name="viewport" content="width=device-width"></head><body><h1>Bright Smiles</h1><script src="${app.base}/billpay.js" data-practice="${slug}"></script></body></html>`));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  await page.goto(`http://127.0.0.1:${site.address().port}/`);
  await page.waitForSelector('a[data-dm-pay]');
  // One click on the website's button (counted by hand: the action counter lives in each site's own storage).
  const t0 = Date.now();
  await page.locator('a[data-dm-pay]').click();
  await page.waitForURL(new RegExp(`/billpay/${slug}`));
  const onSite = { clicks: 1, keys: 0, fields: 0, actions: 1, ms: Date.now() - t0, log: ['click Pay my bill (website)'] };
  await page.waitForSelector('.bp-find');
  const onPage = await measure(page, async () => {
    // The code box has the focus: type the code from the statement, Enter, then Pay.
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid=amount-due]');
    await page.locator('.bp-pay button.primary').click();
    await page.waitForSelector('.bp-paid');
  });
  const total = { ...onPage, clicks: onPage.clicks + onSite.clicks, keys: onPage.keys + onSite.keys, fields: onPage.fields + onSite.fields, actions: onPage.actions + onSite.actions, ms: onPage.ms + onSite.ms, log: [...onSite.log, ...onPage.log] };
  console.log(withinBudget('Pay my bill from the website', total, { actions: 4, ms: 15000 }));
  assert.match(await page.locator('.bp-paid').textContent(), /Thank you/);
  // Nothing about the account but the amount due was on the page before paying (no name, no visits).
  assert.equal(await page.locator('text=Rosa').count(), 0);
  const after = await staff.get(`/patients/${head.id}/ledger`);
  const pays = after.entries.filter((e) => e.type === 'payment');
  assert.equal(pays.length, 1, 'posted once');
  assert.equal(-pays[0].amount, owed);
  assert.match(pays[0].description, /Pay my bill/);
  assert.deepEqual(errors, []);
  await ctx.close();
  site.close();
});

test('Portal account view: what you owe and why, the family, each visit; pay another amount; in Spanish', async () => {
  const { head, members, phone } = await account({ kids: 1 });
  const { ctx, page, errors } = await phonePage();
  await page.goto(`${app.base}/portal/${slug}`);
  await page.locator('input[autocomplete=username]').fill(phone);
  await page.locator('input[type=date]').fill('1980-02-03');
  await page.locator('form button.primary').click();
  await page.waitForSelector('.code-input');
  let code = null;
  for (let i = 0; i < 40 && !code; i++) {
    const msgs = await staff.get(`/conversations/p${head.id}/messages`);
    code = (Array.isArray(msgs) ? msgs : []).map((m) => /\b(\d{6})\b/.exec(m.body)?.[1]).filter(Boolean).at(-1) || null;
    if (!code) await page.waitForTimeout(250);
  }
  assert.ok(code, 'the sign-in code was texted');
  await page.locator('.code-input').fill(code);
  await page.locator('form button.primary').click();
  await page.waitForSelector('.bp-balance');

  const ledger = (id) => staff.get(`/patients/${id}/ledger`);
  const family = (await ledger(head.id)).balance + (await ledger(members[0].id)).balance;
  const shown = await page.locator('[data-testid=amount-due]').textContent();
  assert.equal(shown.replace(/[^\d.]/g, ''), (family / 100).toFixed(2), 'the amount due is the ledger balance (no insurance pending)');
  assert.match(await page.locator('.bp-balance').textContent(), /left after insurance and your payments/);
  // The household (the account holder sees each member) and the visits.
  await page.waitForSelector('text=Your family');
  assert.ok(await page.locator('button.bp-row:has-text("Kid0")').count());
  assert.ok((await page.locator('text=Charges and payments by visit').count()) === 1);
  // No horizontal scrolling on a phone.
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  // Pay $5 with the sandbox test card.
  await page.locator('.bp-balance button.primary.big').click();
  await page.locator('label.bp-choice:has-text("Another amount") input').check();
  await page.locator('.bp-other').fill('5');
  await page.locator('.bp-pay button.primary').click();
  await page.waitForSelector('.bp-notice');
  assert.match(await page.locator('.bp-notice').textContent(), /\$5\.00/);
  const pays = (await ledger(head.id)).entries.filter((e) => e.type === 'payment');
  assert.deepEqual(pays.map((p) => p.amount), [-500]);

  // Spanish.
  await page.locator('.lang-toggle').click();
  await page.waitForSelector('text=Debe ahora');
  assert.ok(await page.locator('text=Su familia').count());
  assert.deepEqual(errors, []);
  await ctx.close();
});
