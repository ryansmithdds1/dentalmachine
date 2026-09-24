// The assistant's microphone can always be stopped, even when the browser's speech recognizer never answers
// stop() with an "end" event (seen with on-device recognition and mic errors): the mic button, the floating
// assistant button and Esc all end "Listening…" within a couple of seconds.
/* global window */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from './lib/server.mjs';

// A recognizer that starts, reports some speech, and then ignores stop() (never fires onend); abort() works.
const STUBBORN_RECOGNIZER = () => {
  class Stubborn {
    start() {
      window.__recStarts = (window.__recStarts || 0) + 1;
      setTimeout(() => this.onresult?.({ results: [Object.assign([{ transcript: 'hello there' }], { isFinal: false })] }), 50);
    }
    stop() { window.__recStops = (window.__recStops || 0) + 1; }
    abort() { window.__recAborts = (window.__recAborts || 0) + 1; }
  }
  window.SpeechRecognition = Stubborn;
  window.webkitSpeechRecognition = Stubborn;
};

let app; let browser; let s;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await s.ctx.addInitScript(STUBBORN_RECOGNIZER);
  // The assistant is on only with an AI key; show it as on so the mic can be used (no request is sent to AI).
  await s.page.route('**/api/assistant', (r) => r.fulfill({ json: { enabled: true, tools: [] } }));
  await s.page.reload();
  await s.page.waitForSelector('.sidebar');
});
after(async () => { await browser?.close(); await app?.stop(); });

const listening = () => s.page.locator('.assist-toast.live');

async function startListening() {
  const { page } = s;
  if (!(await page.locator('.assist-mic').count())) await page.click('.assist-fab');
  await page.click('.assist-mic');
  await listening().waitFor({ timeout: 5000 });
}

test('the mic button stops listening even when the browser never answers stop()', async () => {
  await startListening();
  await s.page.click('.assist-mic');
  await listening().waitFor({ state: 'detached', timeout: 3000 });
  assert.ok(await s.page.evaluate(() => window.__recAborts >= 1), 'the recognizer was cancelled after stop() went unanswered');
});

test('the floating assistant button stops listening, and so does Esc', async () => {
  await startListening();
  await s.page.click('.assist-fab');
  await listening().waitFor({ state: 'detached', timeout: 3000 });
  await startListening();
  await s.page.keyboard.press('Escape');
  await listening().waitFor({ state: 'detached', timeout: 3000 });
  // And it can start again afterwards.
  await startListening();
  await s.page.click('.assist-mic');
  await listening().waitFor({ state: 'detached', timeout: 3000 });
  assert.deepEqual(s.errors, []);
});
