// Regression for the nightly sweep's narrow tables and Help → Show me titles.
// Real screens, fresh synthetic demo data, both themes; no sweep allowlist applies here.
/* global document, window */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch } from './lib/server.mjs';
import { ROLES, tokenFor, contextAs, watch, quiet, settle, screenProblems, shoot } from './lib/watch.mjs';
import { idsFor } from './lib/routes.mjs';

let app; let browser; let token; let checkout;
before(async () => {
  app = await startApp();
  browser = await launch();
  token = await tokenFor(app.base, ROLES.admin);
  checkout = (await idsFor(app.base, token)).checkout;
  assert.ok(checkout, 'the synthetic practice has a visit to check out');
});
after(async () => { await browser?.close(); await app?.stop(); });

const screens = [
  { name: 'Phones reasons', route: () => '/phones', tab: /Why they didn’t book/, ready: '.phones-grid table' },
  { name: 'Help walkthroughs', route: () => '/help?tab=showme', ready: '.showme-list button.link' },
  { name: 'Checkout work', route: () => `/checkout/${checkout}`, ready: '.checkout-steps table' },
  { name: 'Settings users', route: () => '/settings?tab=users', ready: '.settings-body table' },
  { name: 'Settings forms', route: () => '/settings?tab=forms', ready: '.form-template-list' },
  { name: 'Timeclock reports', route: () => '/timeclock?tab=reports', ready: '.tc-table' },
];

for (const theme of ['light', 'dark']) {
  for (const width of [375, 390, 414, 768, 1024, 1400]) {
    for (const screen of screens) {
      test(`${screen.name} fits ${width}px (${theme})`, async () => {
        const ctx = await contextAs(browser, { token, theme, viewport: { width, height: 900 } });
        try {
          const page = await ctx.newPage();
          const w = watch(page, { base: app.base });
          await page.goto(`${app.base}${screen.route()}`);
          await quiet(page);
          if (screen.tab) await page.getByRole('tab', { name: screen.tab }).click();
          await page.locator(screen.ready).first().waitFor();
          assert.ok(await settle(page, w), 'the screen finished loading');
          await shoot(page, `responsive-${screen.name}-${width}-${theme}`);
          assert.deepEqual(await screenProblems(page), [], 'the whole page fits without masking overflow');
          assert.deepEqual(w.pageErrors, []);
          assert.deepEqual(w.console, []);
          assert.deepEqual(w.failed, []);
          assert.deepEqual(w.responses, []);
          assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
          // Long titles stay readable; clipping the page or the button would hide the regression.
          if (screen.name === 'Help walkthroughs') {
            const clipped = await page.locator('.showme-list button.link:visible').evaluateAll((buttons) => buttons
              .filter((b) => b.scrollWidth > b.clientWidth + 2 || b.getBoundingClientRect().right > window.innerWidth + 2)
              .map((b) => b.textContent));
            assert.deepEqual(clipped, [], 'every walkthrough title is readable');
          }
        } finally { await ctx.close(); }
      });
    }
  }
}
