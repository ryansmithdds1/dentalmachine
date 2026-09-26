// Keeps the guided walkthroughs true to the app: every tour in client/public/manual/tours.json is played from start
// to end, on the training patient, as the person the robot measured it as — each step done for real through the
// overlay (the lit-up control clicked, the key pressed, the words typed). It fails when a step's target can't be
// found any more, or the overlay doesn't notice the step being done, so a change to a screen can't silently break
// a tour. Fix by re-running the robot and `npm run tours`, or by giving the control a stable data-tour name.
//
// TOURS=A010,A012 plays just those. TOUR_SHOTS=dir saves a picture where each one fails.
/* global window */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, launch, signIn, root } from '../lib/server.mjs';
import { ROLES } from '../lib/watch.mjs';
import { startTour, playTour } from '../lib/tours.mjs';

const data = JSON.parse(readFileSync(join(root, 'client/public/manual/tours.json'), 'utf8'));
// The demo office's outside services in their sandbox modes, as the robot has them (e2e/actions/run.mjs).
process.env.TWILIO_AUTH_TOKEN ||= 'robot-twilio-token';
process.env.GOOGLE_BUSINESS ||= 'sandbox';
// A step that opens the file picker (add x-rays, scan an insurance card, a document) is given a small file, as a
// person would pick one.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
async function pickFile(chooser) {
  const accept = (await chooser.element().getAttribute('accept').catch(() => '')) || '';
  const pdf = /pdf/.test(accept) && !/image/.test(accept);
  await chooser.setFiles(pdf ? { name: 'practice.pdf', mimeType: 'application/pdf', buffer: PDF } : { name: 'practice.png', mimeType: 'image/png', buffer: PNG }).catch(() => {});
}
const only = process.env.TOURS ? new Set(process.env.TOURS.split(',').map((x) => x.trim().toUpperCase())) : null;
const tours = data.tours.filter((t) => !only || only.has(t.id));
const SHOTS = process.env.TOUR_SHOTS;

let app; let browser;
before(async () => {
  app = await startApp();
  browser = await launch();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); await app?.stop(); });

test(`TOURS every walkthrough plays to the end on the training patient (${tours.length})`, { timeout: 60 * 60_000 }, async () => {
  assert.ok(tours.length, 'there are walkthroughs to play');
  const failures = [];
  const byRole = new Map();
  for (const t of tours) (byRole.get(t.role) || byRole.set(t.role, []).get(t.role)).push(t);
  for (const [role, list] of byRole) {
    const email = ROLES[role] || ROLES.admin;
    const s = await signIn(browser, app.base, { email });
    s.page.on('filechooser', pickFile);
    // The first-login welcome is its own test (tours.test.mjs); here the pages as people use them every day.
    await s.page.evaluate(() => fetch('/api/me/prefs/tour.welcome', { method: 'PUT', headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'seen' }) })); // eslint-disable-line no-undef
    for (const t of list) {
      const errors = [];
      const onError = (e) => errors.push(e.message);
      s.page.on('pageerror', onError);
      try {
        await s.page.goto(`${app.base}/`);
        await s.page.locator('.rail-mod').first().waitFor();
        await startTour(s.page, t.id);
        const end = await playTour(s.page);
        if (end.gone) {
          // Only a last step that opens a screen outside the app (the patient's signing page) ends it that way.
          const at = end.last?.step ?? -1;
          if (!(t.steps[at]?.leaves && at === t.steps.length - 1)) throw new Error(`the walkthrough stopped by itself at step ${at + 1}`);
        } else if (end.phase !== 'done') throw new Error(`ended in ${end.phase}`);
        if (errors.length) throw new Error(`the page crashed: ${errors[0]}`);
        if (!end.gone) await s.page.locator('.tour-callout button.primary').click(); // Close
      } catch (err) {
        failures.push(`${t.id} ${t.title} (as ${role}): ${String(err.message).split('\n')[0]}`);
        if (SHOTS) await s.page.screenshot({ path: join(SHOTS, `${t.id}.png`) }).catch(() => {});
        await s.page.keyboard.press('Escape').catch(() => {});
      } finally {
        s.page.off('pageerror', onError);
      }
    }
    await s.ctx.close();
  }
  assert.deepEqual(failures, [], `walkthroughs that no longer match the app:\n  ${failures.join('\n  ')}`);
});
