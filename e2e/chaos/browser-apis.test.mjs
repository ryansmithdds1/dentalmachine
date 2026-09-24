// Chaos: browser features that say no or do nothing — a file chooser the person cancels, printing, and a
// clipboard that refuses. Each time the screen stays usable and, where something didn't happen, says so.
/* global window */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { quiet } from '../lib/watch.mjs';
import { FAKE_CLIPBOARD_DENIED, FAKE_PRINT } from './fakes.mjs';

let app; let browser; let s; let patientId;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await s.ctx.addInitScript(FAKE_CLIPBOARD_DENIED);
  await s.ctx.addInitScript(FAKE_PRINT, 'count');
  patientId = (await s.get('/patients?limit=1')).rows[0].id;
});
after(async () => { await browser?.close(); await app?.stop(); });
const chaos = () => s.page.evaluate(() => window.__chaos);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('cancelling the file chooser leaves Documents ready (no stuck "Uploading…"), and an upload then works', async () => {
  await s.page.goto(`${app.base}/patients/${patientId}?tab=documents`);
  const input = s.page.locator('input[type=file][multiple]').first();
  await input.waitFor({ state: 'attached' });
  await quiet(s.page);
  const [chooser] = await Promise.all([s.page.waitForEvent('filechooser'), input.click({ force: true })]);
  await chooser.setFiles([]); // what the page sees when the person presses Cancel
  await s.page.waitForTimeout(1000);
  assert.equal(await s.page.locator('text=Uploading…').count(), 0, 'not stuck uploading');
  assert.equal(await s.page.locator('.toast.error').count(), 0, 'no error for a cancelled choice');
  await input.setInputFiles({ name: 'after-cancel.png', mimeType: 'image/png', buffer: PNG });
  await s.page.waitForSelector('.doc-tile:has-text("after-cancel.png")', { timeout: 10_000 });
  assert.deepEqual(s.errors, []);
});

test('printed documents ask the browser to print once, and the page stays usable', async () => {
  await s.page.goto(`${app.base}/patients/${patientId}/notes/print`);
  await s.page.waitForSelector('button:has-text("Print")');
  await s.page.waitForTimeout(1000);
  assert.equal((await chaos()).prints, 1, 'the print dialog is opened once, not in a loop');
  await s.page.click('button:has-text("Print")');
  assert.equal((await chaos()).prints, 2);
  await s.page.goto(`${app.base}/patients/${patientId}/statement`);
  await s.page.waitForSelector('button:has-text("Print")');
  await s.page.click('button:has-text("Print")');
  assert.equal((await chaos()).prints, 1);
  await s.page.goto(`${app.base}/patients/${patientId}`);
  await s.page.waitForSelector('.tabs');
  assert.deepEqual(s.errors, []);
});

test('a refused clipboard says to copy by hand, and nothing breaks', async () => {
  await s.page.goto(`${app.base}/settings?tab=booking`);
  await s.page.waitForSelector('button:has-text("Copy")');
  await quiet(s.page);
  await s.page.locator('button:has-text("Copy")').first().click();
  await s.page.waitForSelector('.toast:has-text("copy it")');
  assert.ok((await chaos()).clipboardTries >= 1, 'the clipboard was tried');
  assert.equal(await s.page.locator('.toast:has-text("Copied")').count(), 0, 'it does not claim it copied');
  assert.deepEqual(s.errors, []);
});
