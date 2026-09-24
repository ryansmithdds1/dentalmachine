// CBCT and 3D scans: a DICOM series uploaded as one zip opens in the multiplanar viewer (axial,
// coronal, sagittal + 3D); an upper/lower scan pair opens in the scan viewer. Spec: docs/imaging-3d.md
//
// Needs the 3D routes mounted (server/src/routes/volumes.js) and uploads accepting zip/scan files; until
// then the tests skip with a note rather than fail.
/* global document, sessionStorage, fetch, Blob */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { makeSeries, zipSeries, phantom, archStl } from '../../server/test/volumefixtures.js';
import { zip } from '../../server/src/recordexport.js';

let app; let browser; let s; let patient; let ready = null;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  patient = await s.post('/patients', { first_name: 'Cora', last_name: 'Beam', dob: '1979-06-01' });
});
after(async () => { await browser?.close(); await app?.stop(); });

// Uploads bytes from the test through the browser session, as the documents screen would.
const upload = (bytes, filename, category) => s.page.evaluate(async ([pid, b64, name, cat]) => {
  const body = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const res = await fetch(`/api/patients/${pid}/documents?${new URLSearchParams({ filename: name, category: cat })}`, {
    method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}`, 'Content-Type': 'application/octet-stream' }, body: new Blob([body]),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}, [patient.id, Buffer.from(bytes).toString('base64'), filename, category]);

async function wired(t) {
  ready ??= (async () => {
    const probe = await s.get('/documents/999999999/view3d');
    return !/^Not found$/.test(probe?.error || ''); // the app's catch-all answers "Not found" for unknown routes
  })();
  if (!(await ready)) { t.skip('3D routes not mounted yet (see docs/imaging-3d.md)'); return false; }
  return true;
}

test('a CBCT zip opens in the viewer: three slice views with crosshairs and a 3D view', async (t) => {
  if (!(await wired(t))) return;
  const nx = 64; const ny = 60; const nz = 48;
  const up = await upload(zipSeries(makeSeries({ nx, ny, nz, spacing: [0.4, 0.4, 0.4], density: phantom(nx, ny, nz) })), 'CBCT.zip', 'xray');
  if (up.status === 415) { t.skip('uploads don’t accept zip files yet (see docs/imaging-3d.md)'); return; }
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const info = await s.get(`/documents/${up.data.id}/view3d`);
  assert.equal(info.kind, 'volume');
  assert.deepEqual(info.dims, [nx, ny, nz]);
  assert.deepEqual(info.spacing, [0.4, 0.4, 0.4]);

  const { page } = s;
  await page.goto(`${app.base}/patients/${patient.id}?tab=documents`);
  await page.waitForSelector(`text=CBCT.zip`);
  await page.click(`text=CBCT.zip`);
  await page.waitForSelector('.vv-grid canvas', { timeout: 30_000 });
  assert.equal(await page.locator('.vv-grid .vv-pane canvas').count() >= 3, true);
  // Scrolling the axial view moves one slice.
  const axial = page.locator('.vv-pane').first().locator('canvas');
  const before = await axial.getAttribute('aria-label');
  await axial.hover();
  await page.mouse.wheel(0, -100);
  await page.waitForFunction((b) => document.querySelector('.vv-pane canvas')?.getAttribute('aria-label') !== b, before);
  await page.keyboard.press('Escape');
});

test('an upper/lower scan pair opens in the scan viewer with a toggle for each jaw', async (t) => {
  if (!(await wired(t))) return;
  const up = await upload(zip([{ name: 'UpperJaw.stl', data: archStl({ upper: true }) }, { name: 'LowerJaw.stl', data: archStl() }]), 'Scan.zip', 'photo');
  if (up.status === 415) { t.skip('uploads don’t accept zip files yet'); return; }
  const info = await s.get(`/documents/${up.data.id}/view3d`);
  assert.equal(info.kind, 'mesh');
  assert.deepEqual(info.parts.map((p) => p.jaw), ['upper', 'lower']);
  const { page } = s;
  await page.goto(`${app.base}/patients/${patient.id}?tab=documents`);
  await page.click('text=Scan.zip');
  await page.waitForSelector('.mv-canvas canvas', { timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('.mv-overlay'), null, { timeout: 30_000 });
  await page.click('.vv-chip[title="UpperJaw.stl"]');
  assert.equal(await page.locator('.vv-chip[title="UpperJaw.stl"]').getAttribute('aria-pressed'), 'false');
});
