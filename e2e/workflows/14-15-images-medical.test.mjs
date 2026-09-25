// Workflow 14 — x-rays and photos: X opens the newest x-ray set on its first image, → goes to the next (budget 2);
// dropping files adds them with the type worked out from each file (1 action); removing is undoable, no confirm().
// Workflow 15 — medical history: "reviewed today, no changes" is one key (budget 2); changing one line of the
// history is click → type → Ctrl/⌘+Enter in the single inline editor (budget 3).
// Specs: docs/workflows/specs/14-xrays-photos.md, docs/workflows/specs/15-medical-history.md
/* global document, sessionStorage, DataTransfer, DragEvent, File */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget, MOD } from '../lib/budget.mjs';

let app; let browser; let s;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
});
after(async () => { await browser?.close(); await app?.stop(); });

// Pop-ups some pages show on load (office notes) would swallow plain-key shortcuts; start from a quiet screen.
const quiet = async (page) => { while (await page.locator('.modal-backdrop').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); } };
const newPatient = (first) => s.post('/patients', { first_name: first, last_name: 'Imaging', dob: '1980-02-03' });

// Makes a picture in the browser (grey like a radiograph, or colour like a camera photo) and uploads it.
const uploadImage = (patientId, name, { grey = true, category = 'xray' } = {}) => s.page.evaluate(async ([pid, n, g, cat]) => {
  const c = document.createElement('canvas');
  c.width = 160; c.height = 120;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 160, 120);
  grad.addColorStop(0, g ? '#111' : '#d33'); grad.addColorStop(1, g ? '#eee' : '#3a6');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 160, 120);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const res = await fetch(`/api/patients/${pid}/documents?${new URLSearchParams({ filename: n, category: cat })}`, {
    method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}`, 'Content-Type': 'image/png' }, body: blob,
  });
  return res.json();
}, [patientId, name, grey, category]);

// A synthetic drop of files made in the page (a person drags them from the desktop: one action).
const dropFiles = () => s.page.evaluate(async () => {
  const pic = async (grey, type) => {
    const c = document.createElement('canvas');
    c.width = 120; c.height = 90;
    const ctx = c.getContext('2d');
    for (let x = 0; x < 120; x += 10) { ctx.fillStyle = grey ? `rgb(${x * 2},${x * 2},${x * 2})` : `hsl(${x * 3},70%,50%)`; ctx.fillRect(x, 0, 10, 90); }
    return new Promise((r) => c.toBlob(r, type, 0.9));
  };
  const dt = new DataTransfer();
  dt.items.add(new File([await pic(false, 'image/jpeg')], 'IMG_2041.jpg', { type: 'image/jpeg' }));
  dt.items.add(new File([await pic(true, 'image/png')], 'scan-0412.png', { type: 'image/png' }));
  dt.items.add(new File(['%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'], 'letter.pdf', { type: 'application/pdf' }));
  const zone = document.querySelector('[data-testid=documents-drop]');
  for (const type of ['dragenter', 'dragover', 'drop']) zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
});

test('X opens the newest x-ray set on its first image and → goes to the next, in 2 actions; Esc closes', async () => {
  const { page } = s;
  const p = await newPatient('Xavier');
  const ids = [];
  for (const n of ['bw-rm.png', 'bw-rp.png', 'bw-lp.png']) ids.push((await uploadImage(p.id, n)).id);
  const mount = await s.post(`/patients/${p.id}/mounts`, { template: 'bw4' });
  await s.api('PUT', `/mounts/${mount.id}`, { slots: { 0: ids[0], 1: ids[1], 2: ids[2] } });
  await page.goto(`${app.base}/patients/${p.id}?tab=documents`);
  await page.waitForSelector('.mount-strip');
  await quiet(page);

  let first;
  const r = await measure(page, async () => {
    await page.keyboard.press('x');
    await page.waitForSelector('.studio-viewer-head strong');
    await page.waitForSelector('.studio .image-viewer canvas');
    first = await page.textContent('.studio-viewer-head strong');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((was) => document.querySelector('.studio-viewer-head strong')?.textContent !== was, first);
  });
  console.log(withinBudget('open the latest x-rays and go to the next', r, { actions: 2, ms: 6000 }));
  // A full view of the page area, not a modal dialog: the menu stays on screen and usable.
  assert.equal(await page.locator('[aria-modal="true"], .modal').count(), 0, 'no modal dialog');
  assert.ok(await page.locator('.sidebar').isVisible(), 'the menu is still there');
  const box = await page.locator('.studio').boundingBox();
  const rail = await page.locator('.sidebar').boundingBox();
  assert.ok(box.x >= rail.x + rail.width - 1, `the viewer starts right of the menu (${box.x} vs ${rail.x + rail.width})`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.studio', { state: 'detached' });
  assert.deepEqual(s.errors, [], 'no dialogs or page errors');
});

test('U opens the file picker (the keyboard way to add pictures, beside drag-and-drop): 2 actions', async () => {
  const { page } = s;
  const p = await newPatient('Keyed');
  await page.goto(`${app.base}/patients/${p.id}?tab=documents`);
  await page.waitForSelector('[data-testid=documents-drop] .empty');
  await quiet(page);
  assert.equal(await page.locator('button.docs-add-files:has-text("Add files")').count(), 1, 'a visible button says so, with its key');
  const pic = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const r = await measure(page, async () => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('u')]);
    await chooser.setFiles({ name: 'intraoral-1.png', mimeType: 'image/png', buffer: pic });
    await page.waitForFunction(() => document.querySelectorAll('.doc-tile').length === 1);
  });
  r.actions += 1; r.log.push('choose the file (type its name, Enter)');
  console.log(withinBudget('add a picture with the keyboard (U, pick the file)', r, { actions: 2, ms: 8000 }));
  assert.deepEqual(s.errors, []);
});

test('the front desk adds a scanned paper to a chart (S / U / drop), and cannot remove what clinical staff filed', async () => {
  const desk = await signIn(browser, app.base, { email: 'frontdesk@demo.dentalmachine.app' });
  await trackActions(desk.page);
  const p = await newPatient('Papers');
  const clinical = await uploadImage(p.id, 'bw-clinical.png');
  await desk.page.goto(`${app.base}/patients/${p.id}?tab=documents`);
  await desk.page.waitForSelector('[data-testid=documents-drop] .doc-tile');
  await quiet(desk.page);
  // The same ways in as everyone: the Scan button (S) and Add files (U).
  assert.equal(await desk.page.locator('button.scan-trigger').count(), 1, 'Scan is offered to the front desk');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const [chooser] = await Promise.all([desk.page.waitForEvent('filechooser'), desk.page.keyboard.press('u')]);
  await chooser.setFiles({ name: 'Referral Dr Smith.pdf', mimeType: 'application/pdf', buffer: pdf });
  await desk.page.waitForSelector('.doc-tile:has-text("Referral Dr Smith.pdf")');
  await desk.page.waitForSelector('.toast:has-text("Added Referral Dr Smith.pdf")');
  // What clinical staff filed has no Remove for them (and the server refuses it in words).
  await desk.page.click(`.doc-tile:has-text("bw-clinical.png")`);
  await desk.page.waitForSelector('.modal .image-viewer');
  assert.equal(await desk.page.locator('.modal button:has-text("Remove")').count(), 0);
  await desk.page.keyboard.press('Escape');
  const refused = await desk.page.evaluate(async (id) => {
    const res = await fetch(`/api/documents/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } });
    return { status: res.status, body: await res.json() };
  }, clinical.id);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /changing or removing them needs a clinical login/);
  assert.deepEqual(desk.errors.filter((e) => !/403/.test(e)), []);
  await desk.ctx.close();
});

test('without a mount, X opens the newest x-ray in the viewer and ← → step through the x-rays', async () => {
  const { page } = s;
  const p = await newPatient('Loose');
  await uploadImage(p.id, 'pa-old.png');
  await uploadImage(p.id, 'pa-new.png');
  await uploadImage(p.id, 'smile.png', { grey: false, category: 'photo' });
  await page.goto(`${app.base}/patients/${p.id}?tab=documents`);
  await page.waitForSelector('.doc-tile');
  await quiet(page);
  const r = await measure(page, async () => {
    await page.keyboard.press('x');
    await page.waitForSelector('.modal .doc-position:has-text("1 of 2")');
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('.modal .doc-position:has-text("2 of 2")');
  });
  console.log(withinBudget('open loose x-rays and go to the next', r, { actions: 2, ms: 6000 }));
  assert.equal(await page.textContent('.modal-header h2'), 'pa-old.png');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });
});

test('dropping files adds them in 1 action with the type taken from each file; remove is undoable; details edit inline', async () => {
  const { page } = s;
  const p = await newPatient('Dropped');
  await page.goto(`${app.base}/patients/${p.id}?tab=documents`);
  await page.waitForSelector('[data-testid=documents-drop] .empty');

  const r = await measure(page, async () => {
    await dropFiles();
    await page.waitForFunction(() => document.querySelectorAll('.doc-tile').length === 3);
  });
  r.actions += 1; r.log.unshift('drop 3 files');
  console.log(withinBudget('attach x-ray, photo and letter by dropping them', r, { actions: 2, ms: 8000 }));
  const docs = await s.get(`/patients/${p.id}/documents`);
  const cat = Object.fromEntries(docs.map((d) => [d.filename, d.category]));
  assert.deepEqual(cat, { 'IMG_2041.jpg': 'photo', 'scan-0412.png': 'xray', 'letter.pdf': 'document' });

  // Remove: no "Are you sure?", and Ctrl/⌘+Z brings it back.
  await page.click('.doc-tile:has-text("IMG_2041.jpg")');
  await page.waitForSelector('.modal .image-viewer');
  // Edit details opens under the image, not as a second dialog; Esc closes only that panel.
  await page.click('.modal button:has-text("Edit details")');
  await page.waitForSelector('.doc-details');
  assert.equal(await page.locator('.modal').count(), 1, 'no stacked dialog');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.doc-details', { state: 'detached' });
  assert.equal(await page.locator('.modal').count(), 1, 'the viewer stays open');
  await page.click('.modal button:has-text("Remove")');
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('.doc-tile').length === 2);
  await page.waitForSelector('.toast:has-text("Removed IMG_2041.jpg")');
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForFunction(() => document.querySelectorAll('.doc-tile').length === 3);
  assert.equal((await s.get(`/patients/${p.id}/documents`)).length, 3);
  assert.deepEqual(s.errors, [], 'no confirm() dialogs or page errors');
});

test('medical history: "reviewed today, no changes" in 1 key; one line changed in 3 actions; keyboard-only works too', async () => {
  const { page } = s;
  const p = await newPatient('Medina');
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.waitForSelector('#medical-history');
  // Never reviewed: it says so in the header and on the medical history itself.
  await page.waitForSelector('.med-due-chip');
  await page.waitForSelector('.med-status.due');
  assert.equal((await s.get(`/patients/${p.id}/card`)).medical_review_due, true);
  await quiet(page);

  const reviewed = await measure(page, async () => {
    await page.keyboard.press('r');
    await page.waitForSelector('.med-status:not(.due)');
  });
  console.log(withinBudget('medical history reviewed, no changes', reviewed, { actions: 2 }));
  assert.equal((await s.get(`/patients/${p.id}/card`)).medical_review_due, false);
  assert.equal(await page.locator('.med-due-chip').count(), 0);

  const changed = await measure(page, async () => {
    await page.click('.med-kv dd:nth-of-type(2) .med-value');
    await page.waitForFunction(() => document.activeElement?.name === 'allergies');
    await page.keyboard.type('Latex');
    await page.keyboard.press(`${MOD}+Enter`);
    await page.waitForSelector('.med-kv .med-value:has-text("Latex")');
  });
  console.log(withinBudget('add an allergy', changed, { actions: 3 }));
  const after1 = await s.get(`/patients/${p.id}`);
  assert.equal(after1.allergies, 'Latex');
  assert.ok(after1.medical_reviewed_at);

  // Keyboard only: Shift+M opens the same editor straight on the medications (A opens it on the allergies), type, save.
  const keys = await measure(page, async () => {
    await page.keyboard.press('Shift+M');
    await page.waitForFunction(() => document.activeElement?.name === 'medications');
    await page.keyboard.type('Metformin 500mg');
    await page.keyboard.press(`${MOD}+Enter`);
    await page.waitForSelector('.med-kv .med-value:has-text("Metformin 500mg")');
  });
  console.log(withinBudget('add a medication by keyboard', keys, { actions: 3 }));
  // Undo puts the old value back (the saved change and the undo are both in the audit trail).
  await page.waitForSelector('.toast:has-text("Medical history saved")');
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForFunction(() => !document.querySelector('.med-kv')?.textContent.includes('Metformin'));
  const after2 = await s.get(`/patients/${p.id}`);
  assert.equal(after2.medications, null);
  assert.equal(after2.allergies, 'Latex');
  // A: straight to the allergies line, the cursor after what's there.
  await page.waitForSelector('.med-kv');
  const allergy = await measure(page, async () => {
    await page.keyboard.press('a');
    await page.waitForFunction(() => document.activeElement?.name === 'allergies');
    await page.keyboard.type(', penicillin');
    await page.keyboard.press(`${MOD}+Enter`);
    await page.waitForSelector('.med-kv .med-value:has-text("Latex, penicillin")');
  });
  console.log(withinBudget('add an allergy by keyboard', allergy, { actions: 3 }));
  assert.equal((await s.get(`/patients/${p.id}`)).allergies, 'Latex, penicillin');
  assert.deepEqual(s.errors, [], 'no dialogs or page errors');
});

test('vitals: V, type "122/78 68", Enter — 3 actions, the cursor starts in the box; nonsense is refused on screen', async () => {
  const { page } = s;
  const p = await newPatient('Vitalia');
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.waitForSelector('#medical-history');
  await quiet(page);
  const r = await measure(page, async () => {
    await page.keyboard.press('v');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Blood pressure and pulse');
    await page.keyboard.type('122/78 68');
    await page.waitForSelector('text=BP 122/78 mmHg · pulse 68 bpm');
    await page.keyboard.press('Enter');
    await page.waitForSelector('input[aria-label="Blood pressure and pulse"]', { state: 'detached' });
  });
  console.log(withinBudget('record blood pressure and pulse', r, { actions: 3 }));
  const [v] = await s.get(`/patients/${p.id}/vitals`);
  assert.deepEqual([v.bp_systolic, v.bp_diastolic, v.pulse], [122, 78, 68]);
  // Something that isn't a reading: nothing is saved, the box says what it wants.
  await page.keyboard.press('v');
  await page.keyboard.type('high');
  await page.keyboard.press('Enter');
  await page.waitForSelector('text=Type the blood pressure and pulse like 122/78 68');
  await page.keyboard.press('Escape');
  assert.equal((await s.get(`/patients/${p.id}/vitals`)).length, 1);
  assert.deepEqual(s.errors, [], 'no dialogs or page errors');
});

test('? lists the documents and medical history shortcuts', async () => {
  const { page } = s;
  const p = await newPatient('Keys');
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.waitForSelector('#medical-history');
  await page.keyboard.press('?');
  await page.waitForSelector('.shortcuts');
  assert.match(await page.textContent('.shortcuts'), /Medical history reviewed today, no changes/);
  await page.keyboard.press('Escape');
  await page.goto(`${app.base}/patients/${p.id}?tab=documents`);
  await page.waitForSelector('[data-testid=documents-drop]');
  await page.keyboard.press('?');
  await page.waitForSelector('.shortcuts');
  assert.match(await page.textContent('.shortcuts'), /Open the latest x-rays/);
  await page.keyboard.press('Escape');
});
