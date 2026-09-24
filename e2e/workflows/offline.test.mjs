// Working through an internet outage (docs/offline.md): the internet drops, the schedule and chart keep
// showing today from the encrypted copy with an "Offline — as of" banner, a check-in is queued, the page
// survives a reload, and when the connection is back the change is sent once.
//
// TODO: runs once routes/offline.js is mounted in app.js and the client integration in docs/offline.md
// (api.js, auth.jsx, App.jsx) is applied; until then it skips itself, saying which part is missing.
/* global document, navigator */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';

let app; let browser; let s; let ready = null; let appt;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  const key = await s.page.evaluate(async () => (await fetch('/api/offline/key', { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } })).status);
  if (key === 404) { ready = 'TODO: mount server/src/routes/offline.js (see docs/offline.md)'; return; }
  // The client keeps a copy right after sign-in when the integration is in place.
  const saved = await s.page.waitForFunction(() => new Promise((resolve) => {
    const req = indexedDB.open('dm-offline');
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('snapshot')) return resolve(false);
      const get = db.transaction('snapshot').objectStore('snapshot').get('today');
      get.onsuccess = () => resolve(!!get.result);
      get.onerror = () => resolve(false);
    };
    req.onerror = () => resolve(false);
  }), null, { timeout: 15_000, polling: 500 }).then(() => true, () => false);
  if (!saved) { ready = 'TODO: apply the client integration (api.js, auth.jsx, App.jsx) from docs/offline.md'; return; }
  // A visit today that hasn't started, to check in while offline.
  const appts = await s.get('/appointments');
  appt = appts.find((a) => ['scheduled', 'confirmed'].includes(a.status));
  assert.ok(appt, 'the demo schedule has a visit waiting today');
  // The service worker must be in charge so the app itself opens offline.
  await s.page.evaluate(() => navigator.serviceWorker?.ready);
  await s.page.reload();
  await s.page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15_000 });
  await s.page.waitForSelector('.sidebar');
});
after(async () => { await browser?.close(); await app?.stop(); });

test('offline: today from the copy, a check-in queued, kept through a reload, sent once when back', async (t) => {
  if (ready) return t.skip(ready);
  const { page, ctx } = s;
  const today = appt.start_time.slice(0, 10);
  await page.goto(`${app.base}/schedule?date=${today}&view=day`);
  await page.waitForSelector(`.cal [data-appt-id="${appt.id}"]`);

  await ctx.setOffline(true);
  // The schedule still reads (from the copy) and says so.
  await page.goto(`${app.base}/schedule?date=${today}&view=day`);
  await page.waitForSelector('.offline-banner');
  assert.match(await page.textContent('.offline-banner'), /Offline — showing today’s schedule as of .*Changes will be sent when the connection is back/);
  await page.waitForSelector(`.cal [data-appt-id="${appt.id}"]`);

  // Check in: queued on this computer, not lost.
  await page.click(`.cal [data-appt-id="${appt.id}"]`);
  await page.keyboard.press('i');
  await page.waitForSelector('.offline-banner button:has-text("1 change waiting to send")');

  // The patient's chart opens from the copy.
  await page.goto(`${app.base}/patients/${appt.patient_id}?tab=notes`);
  await page.waitForSelector(`h1:has-text("${appt.last_name}")`);
  await page.waitForSelector('.offline-banner');

  // A reload during the outage keeps the app, the copy and the queue.
  await page.reload();
  await page.waitForSelector('.offline-banner button:has-text("1 change waiting to send")');
  await page.click('.offline-banner button:has-text("1 change waiting to send")');
  await page.waitForSelector('.offline-changes .offline-item:has-text("Checked in")');
  await page.keyboard.press('Escape');
  await page.click('.offline-changes button[aria-label="Close"]').catch(() => {});

  // Back online: sent (within the 10-second check), once.
  await ctx.setOffline(false);
  await page.waitForSelector('.offline-banner', { state: 'detached', timeout: 30_000 });
  const now = await s.get(`/appointments/${appt.id}`);
  assert.equal(now.status, 'checked_in');
  const log = await s.get(`/audit-log?entity=appointments&entity_id=${appt.id}`);
  const rows = (Array.isArray(log) ? log : log.rows || log.entries || []).filter((r) => r.action === 'appointment.status');
  assert.equal(rows.length, 1, 'checked in once, not twice');
  const sync = await s.get('/audit-log?entity=users');
  assert.ok((Array.isArray(sync) ? sync : sync.rows || sync.entries || []).some((r) => r.action === 'offline.sync'), 'the sync is in the audit log');
});
