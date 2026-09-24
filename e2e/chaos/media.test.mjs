// Chaos: the camera and microphone refused, or never answering (a permission prompt nobody clicks, a camera
// another program holds). The intraoral camera, office-speech-service dictation, the whole-visit recorder and
// the lab slip scanner must say what's wrong — no endless "Starting the camera…" — and let the person go on.
// Also the x-ray sensor: a capture its imaging bridge never picks up ends with a message, not a spinner.
/* global window */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { quiet } from '../lib/watch.mjs';
import { FAKE_MEDIA } from './fakes.mjs';

let app; let browser; let patientId;
before(async () => {
  app = await startApp();
  browser = await launch();
});
after(async () => { await browser?.close(); await app?.stop(); });

async function page(mode) {
  const s = await signIn(browser, app.base, { email: 'dr.chen@demo.dentalmachine.app' });
  await s.ctx.addInitScript(FAKE_MEDIA, mode);
  // Lab slips: a browser that can read QR codes (so the scanner asks for the camera).
  await s.ctx.addInitScript(() => { window.BarcodeDetector = class { async detect() { return []; } }; });
  // Dictation through the office's speech service, and the whole-visit recorder, shown as set up.
  await s.page.route('**/api/dictation', (r) => r.fulfill({ json: { mode: 'server', vendor: 'sandbox' } }));
  await s.page.route('**/api/long-recordings/status', (r) => r.fulfill({ json: { enabled: true } }));
  if (!patientId) {
    patientId = (await s.get('/patients?limit=1')).rows[0].id;
    await s.post(`/patients/${patientId}/mounts`, { template: 'bw4' });
  }
  s.chaos = () => s.page.evaluate(() => window.__chaos);
  return s;
}
const open = async (s, path, selector) => {
  await s.page.goto(`${app.base}${path}`);
  await s.page.waitForSelector(selector);
  await quiet(s.page);
};

for (const [mode, wait, cameraMsg, micMsg] of [
  ['denied', 4000, /Camera access was blocked/, /Allow the microphone/],
  ['hang', 14000, /camera didn’t start/, /microphone couldn’t start/],
]) {
  describe(`camera and microphone ${mode === 'denied' ? 'refused' : 'never answering'}`, () => {
    let s;
    before(async () => { s = await page(mode); });
    after(async () => { await s.ctx.close(); });

    test('intraoral camera says what is wrong instead of spinning, and the studio closes', async () => {
      await open(s, `/patients/${patientId}?tab=documents`, 'button:has-text("Intraoral camera")');
      await s.page.click('button:has-text("Intraoral camera")');
      await s.page.waitForSelector('.studio');
      await s.page.waitForSelector('.studio .error', { timeout: wait });
      assert.match(await s.page.textContent('.studio .error'), cameraMsg);
      assert.equal(await s.page.locator(':text("Starting the camera")').count(), 0, 'no endless "Starting the camera…"');
      await s.page.keyboard.press('Escape');
      await s.page.waitForSelector('.studio', { state: 'detached' });
    });

    test('dictation through the speech service says the microphone could not start; typing still works', async () => {
      await open(s, `/patients/${patientId}?tab=notes`, '.dictate-btn');
      await s.page.click('.dictate-btn');
      await s.page.waitForSelector('.dictate-bar ~ .error', { timeout: wait });
      assert.match(await s.page.textContent('.dictate-bar ~ .error'), micMsg);
      assert.equal(await s.page.getAttribute('.dictate-btn', 'aria-pressed'), 'false');
      await s.page.fill('[aria-label="Type what to add"]', 'shade A2');
      assert.equal(await s.page.inputValue('[aria-label="Type what to add"]'), 'shade A2');
    });

    test('whole-visit recorder says the microphone could not start (or is still asking) and records nothing', async () => {
      await open(s, `/patients/${patientId}?tab=notes`, '.lr-consent');
      await s.page.check('.lr-consent input');
      await s.page.click('button:has-text("Start recording")');
      if (mode === 'denied') {
        await s.page.waitForSelector('.card:has(.lr-consent) .error', { timeout: wait });
        assert.match(await s.page.textContent('.card:has(.lr-consent) .error'), micMsg);
      } else {
        await s.page.waitForTimeout(1500);
      }
      assert.equal(await s.page.locator('button:has-text("Stop and write the note")').count(), 0, 'not shown as recording');
      assert.deepEqual(s.errors, []);
    });

    test('lab slip scanner: the code can still be typed', async () => {
      await open(s, '/lab-checkin', 'button:has-text("Scan slip")');
      await s.page.click('button:has-text("Scan slip")');
      await s.page.waitForSelector('[aria-label="Slip code"]');
      await s.page.waitForTimeout(500);
      assert.equal(await s.page.locator('.lbc-scan video:not([hidden])').count(), 0, 'no dead video box');
      await s.page.fill('[aria-label="Slip code"]', 'DM-LAB-1');
      await s.page.click('.lbc-scan button[type=submit]');
      await s.page.waitForTimeout(500); // the code is looked up (unknown here); the scanner may close itself
      if (await s.page.locator('[aria-label="Close scanner"]').count()) await s.page.click('[aria-label="Close scanner"]');
      await s.page.waitForSelector('.lbc-scan', { state: 'detached' });
      assert.ok((await s.chaos()).mediaAsks >= 1, 'the scanner did ask for the camera');
    });
  });
}

test('x-ray sensor: a capture the imaging bridge never picks up ends with a message', async () => {
  const s = await signIn(browser, app.base, { email: 'dr.chen@demo.dentalmachine.app' });
  if (!patientId) patientId = (await s.get('/patients?limit=1')).rows[0].id;
  const mount = await s.post(`/patients/${patientId}/mounts`, { template: 'fmx18' });
  let polls = 0;
  // An operatory PC with a sensor that shows as online, but whose bridge never takes the capture.
  await s.page.route('**/api/imaging/agents', (r) => r.fulfill({ json: [{ id: 901, name: 'Op 3 PC', online: true, sensor: 'Chaos Sensor', apps: [], sensor_info: {} }] }));
  await s.page.route(`**/api/patients/${patientId}/imaging/capture`, (r) => r.fulfill({ json: { id: 9901, mount_id: mount.id, workstation: 'Op 3 PC', target: null } }));
  await s.page.route('**/api/imaging/commands/9901', (r) => r.fulfill({ json: { id: 9901, status: ++polls < 3 ? 'pending' : 'expired', filled: null } }));
  await open(s, `/patients/${patientId}?tab=documents`, '[aria-label="Imaging workstation"]');
  await s.page.selectOption('[aria-label="Imaging workstation"]', '901');
  await s.page.click('button:has-text("Capture from Chaos Sensor")');
  await s.page.waitForSelector('.studio .error', { timeout: 10_000 });
  assert.match(await s.page.textContent('.studio .error'), /didn't pick up the capture/);
  await s.page.keyboard.press('Escape');
  await s.page.waitForSelector('.studio', { state: 'detached' });
  assert.deepEqual(s.errors, []);
  await s.ctx.close();
});
