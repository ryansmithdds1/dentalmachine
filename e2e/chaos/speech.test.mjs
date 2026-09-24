// Chaos: speech recognition that misbehaves. Every place that listens (note dictation, perio voice charting,
// lab check-in "hold to talk", the AI scribe) must recover when the browser's recognizer
//  - ignores stop() and keeps hearing words (seen with on-device recognition): listening ends, and nothing
//    heard after the person pressed Stop lands in the chart;
//  - fails to start (no microphone / network): it says so and stops, instead of restarting for ever while
//    still showing "Listening";
//  - is denied the microphone: it says to allow it, and stops.
// The person can always carry on by typing. (The assistant's mic is covered by e2e/assistant-mic.test.mjs.
// Phone-call live transcription runs on the server, not in the browser, so it has no browser recognizer.)
/* global window, document */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { quiet } from '../lib/watch.mjs';
import { FAKE_SPEECH } from './fakes.mjs';

let app; let browser; let patientId;
before(async () => {
  app = await startApp();
  browser = await launch();
});
after(async () => { await browser?.close(); await app?.stop(); });

// A dentist's page with the given recognizer installed. The AI scribe is shown as switched on (it needs an AI
// key; nothing is sent to AI in these tests).
async function page(mode, errorName) {
  const s = await signIn(browser, app.base, { email: 'dr.chen@demo.dentalmachine.app' });
  await s.ctx.addInitScript(FAKE_SPEECH, [mode, errorName]);
  await s.page.route('**/api/scribe', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { enabled: true } }) : r.continue()));
  if (!patientId) patientId = (await s.get('/patients?limit=1')).rows[0].id;
  s.calls = [];
  s.page.on('request', (r) => { if (r.method() === 'POST') s.calls.push({ path: new URL(r.url()).pathname, at: Date.now() }); });
  s.chaos = () => s.page.evaluate(() => window.__chaos);
  return s;
}
const open = async (s, path, selector) => {
  await s.page.goto(`${app.base}${path}`);
  await s.page.waitForSelector(selector);
  await quiet(s.page);
};
const postsSince = (s, at, re) => s.calls.filter((c) => c.at > at && re.test(c.path)).length;

describe('a recognizer that ignores stop() and keeps hearing', () => {
  let s;
  before(async () => { s = await page('stubborn'); });
  after(async () => { await s.ctx.close(); });

  test('note dictation: Stop ends listening, and nothing heard afterwards is written into the note', async () => {
    await open(s, `/patients/${patientId}?tab=notes`, '.dictate-btn');
    await s.page.click('.dictate-btn');
    await s.page.waitForSelector('.dictate-btn[aria-pressed=true]');
    await s.page.waitForFunction(() => window.__chaos.recResults >= 3);
    await s.page.click('.dictate-btn');
    await s.page.waitForSelector('.dictate-btn[aria-pressed=false]', { timeout: 3000 });
    const stopped = Date.now() + 400; // what was already heard is still written in, once
    await s.page.waitForTimeout(2500);
    assert.equal(postsSince(s, stopped, /note-dictate$/), 0, 'no dictation arrives after Stop');
    assert.ok((await s.chaos()).recAborts >= 1, 'the recognizer that ignored stop() was cancelled');
    assert.equal(await s.page.locator('.dictate-btn[aria-pressed=true]').count(), 0);
  });

  test('perio voice: Stop voice ends listening and no more readings are taken', async () => {
    await open(s, `/patients/${patientId}?tab=perio`, '.perio-table');
    await s.page.click('.chart-toolbar button:has-text("Voice")');
    await s.page.waitForSelector('.chart-toolbar button:has-text("Stop voice")');
    await s.page.waitForFunction(() => window.__chaos.recResults >= 3);
    await s.page.click('.chart-toolbar button:has-text("Stop voice")');
    await s.page.waitForSelector('.chart-toolbar button:has-text("Voice"):not(:has-text("Stop"))', { timeout: 3000 });
    await s.page.waitForTimeout(1200); // the app gives the browser a second to end by itself, then cancels it
    const before = (await s.chaos()).recResults;
    await s.page.waitForTimeout(1500);
    assert.equal((await s.chaos()).recResults, before, 'the recognizer stopped hearing (it was cancelled)');
  });

  test('lab check-in: letting go of "Hold to talk" ends listening and the words stop coming', async () => {
    await open(s, '/lab-checkin', '.lbc-talk');
    const btn = s.page.locator('.lbc-talk');
    await btn.hover();
    await s.page.mouse.down();
    await s.page.waitForSelector('.lbc-talk.on');
    await s.page.waitForFunction(() => window.__chaos.recResults >= 3);
    await s.page.mouse.up();
    await s.page.waitForSelector('.lbc-talk:not(.on)', { timeout: 3000 });
    await s.page.waitForTimeout(1200); // the app gives the browser a second to end by itself, then cancels it
    const before = (await s.chaos()).recResults;
    await s.page.waitForTimeout(1500);
    assert.equal((await s.chaos()).recResults, before, 'the recognizer stopped hearing (it was cancelled)');
    assert.match(await btn.textContent(), /Hold to talk/);
  });

  test('AI scribe: Pause stops the transcript growing', async () => {
    await open(s, `/patients/${patientId}?tab=notes`, '.scribe');
    await s.page.click('.scribe button:has-text("Record visit")');
    await s.page.waitForSelector('.scribe-live');
    await s.page.waitForFunction(() => window.__chaos.recResults >= 3);
    await s.page.click('.scribe button:has-text("Pause")');
    await s.page.waitForSelector('.scribe button:has-text("Resume")');
    await s.page.waitForTimeout(300);
    const text = await s.page.inputValue('.scribe-transcript');
    await s.page.waitForTimeout(1500);
    assert.equal(await s.page.inputValue('.scribe-transcript'), text, 'nothing is added while paused');
    await s.page.click('.scribe button:has-text("Discard")');
    assert.deepEqual(s.errors, []);
  });
});

for (const [mode, errorName, message] of [['error', 'audio-capture', /microphone/i], ['error', 'network', /speech|recogni|microphone|connection/i], ['denied', null, /Allow the microphone/i]]) {
  describe(`a recognizer that fails to start (${errorName || 'not-allowed'})`, () => {
    let s;
    before(async () => { s = await page(mode, errorName); });
    after(async () => { await s.ctx.close(); });

    test('note dictation says why, stops listening, and typing still works', async () => {
      await open(s, `/patients/${patientId}?tab=notes`, '.dictate-btn');
      await s.page.click('.dictate-btn');
      await s.page.waitForSelector('.dictate-btn[aria-pressed=false]', { timeout: 3000 });
      await s.page.waitForSelector('.dictate-bar ~ .error');
      assert.match(await s.page.textContent('.dictate-bar ~ .error'), message);
      await s.page.waitForTimeout(1500);
      assert.ok((await s.chaos()).recStarts <= 3, `no endless restart loop (started ${(await s.chaos()).recStarts} times)`);
      await s.page.fill('[aria-label="Type what to add"]', 'shade A2');
      await s.page.keyboard.press('Enter');
      await s.page.waitForFunction(() => !document.querySelector('.dictate-status')?.textContent.includes('Updating'));
    });

    test('perio voice says why and goes back to the Voice button', async () => {
      await open(s, `/patients/${patientId}?tab=perio`, '.perio-table');
      await s.page.click('.chart-toolbar button:has-text("Voice")');
      await s.page.waitForSelector('.chart-toolbar + .error, .error.no-print', { timeout: 3000 });
      await s.page.waitForSelector('.chart-toolbar button:has-text("Stop voice")', { state: 'detached', timeout: 3000 });
      assert.match(await s.page.textContent('.error.no-print'), message);
      await s.page.waitForTimeout(1000);
      assert.ok((await s.chaos()).recStarts <= 3, 'no endless restart loop');
    });

    test('lab check-in says why and stops listening', async () => {
      await open(s, '/lab-checkin', '.lbc-talk');
      await s.page.locator('.lbc-talk').hover();
      await s.page.mouse.down();
      await s.page.waitForSelector('.lbc .error', { timeout: 3000 });
      await s.page.waitForSelector('.lbc-talk:not(.on)', { timeout: 3000 });
      await s.page.mouse.up();
      assert.match(await s.page.textContent('.lbc .error'), message);
      await s.page.waitForTimeout(1000);
      assert.ok((await s.chaos()).recStarts <= 3, 'no endless restart loop');
    });

    test('AI scribe says why and stops recording; the visit can still be typed', async () => {
      await open(s, `/patients/${patientId}?tab=notes`, '.scribe');
      await s.page.click('.scribe button:has-text("Record visit")');
      await s.page.waitForSelector('.scribe .error', { timeout: 3000 });
      await s.page.waitForSelector('.scribe-live', { state: 'detached', timeout: 3000 });
      assert.match(await s.page.textContent('.scribe .error'), message);
      await s.page.waitForTimeout(1000);
      assert.ok((await s.chaos()).recStarts <= 3, 'no endless restart loop');
      assert.deepEqual(s.errors, []);
    });
  });
}
