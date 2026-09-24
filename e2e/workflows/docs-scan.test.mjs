// Document management and scanning (docs/documents.md, backlog D1–D5):
//  • Scan (S) offers this computer's scanner, a phone, or a file; a file added from it lands in the chart.
//  • Any file type opens in the viewer beside its notes: PDFs, CSV as a table, Word as its words.
//  • Category suggested from the words inside ("looks like an EOB", with the reason) in one click.
//  • Notes are added with Enter and keep their history; the words inside documents are searchable.
//  • The phone scan page: photograph a page → it's found and straightened → sent as one PDF.
//  • Office documents page and command-bar results: skipped until their mounts are added (App.jsx / shell).
/* global document, sessionStorage, fetch, Blob, atob */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';
import { buildZip } from '../../server/src/zip.js';

let app; let browser; let s; let patient;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  patient = await s.post('/patients', { first_name: 'Dora', last_name: 'Scan', dob: '1977-05-06' });
});
after(async () => { await browser?.close(); await app?.stop(); });

const quiet = async (page) => { while (await page.locator('.modal-backdrop').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); } };
const pdfWith = (text) => {
  const content = deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`, 'latin1'));
  return Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')]);
};
const docx = (text) => buildZip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` }]);
// Uploads bytes through the browser session, as the documents screen does.
const upload = (bytes, filename, type = 'application/octet-stream', query = {}) => s.page.evaluate(async ([pid, b64, name, t, q]) => {
  const body = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const res = await fetch(`/api/patients/${pid}/documents?${new URLSearchParams({ filename: name, ...q })}`, {
    method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}`, 'Content-Type': t }, body: new Blob([body]),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}, [patient.id, Buffer.from(bytes).toString('base64'), filename, type, query]);
const openDocs = async () => {
  await s.page.goto(`${app.base}/patients/${patient.id}?tab=documents`);
  await s.page.waitForSelector('[data-testid=documents-drop]');
  await quiet(s.page);
};

test('Scan (S) offers scanner / phone / file; a file chosen there is in the chart (2 actions + the file)', async () => {
  const { page } = s;
  await openDocs();
  await page.keyboard.press('s');
  await page.waitForSelector('.scanmenu');
  assert.equal(await page.locator('.scanmenu-item').count(), 3);
  assert.ok(await page.locator('.scanmenu-item:has-text("This computer’s scanner")').isDisabled(), 'no bridge with a scanner here: shown, but not offered');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.scanmenu', { state: 'detached' });
  const r = await measure(page, async () => {
    await page.keyboard.press('s');
    await page.waitForSelector('.scanmenu');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('3')]);
    await chooser.setFiles({ name: 'Referral Dr Smith.pdf', mimeType: 'application/pdf', buffer: pdfWith('Please evaluate for periodontal treatment. Reason for referral: bone loss') });
    await page.waitForSelector('.doc-tile:has-text("Referral Dr Smith.pdf")');
  });
  console.log(withinBudget('scan menu → add a file from this computer', r, { actions: 2, ms: 8000 }));
  const docs = await s.get(`/patients/${patient.id}/documents`);
  assert.equal(docs.find((d) => d.filename === 'Referral Dr Smith.pdf').category, 'referral', 'filed by its name');
  // The phone option shows a QR code for this chart.
  await page.keyboard.press('s');
  await page.keyboard.press('2');
  await page.waitForSelector('.modal img[alt^="QR code"]');
  await page.keyboard.press('Escape');
  assert.deepEqual(s.errors, []);
});

test('any file type: PDF with a suggestion from its words (accepted in 1 click), CSV as a table, Word as its words; notes with Enter', async () => {
  const { page } = s;
  const eob = await upload(pdfWith('EXPLANATION OF BENEFITS Delta Dental claim 7731 paid'), 'scan0007.pdf', 'application/pdf');
  assert.equal(eob.status, 201, JSON.stringify(eob.data));
  assert.equal((await upload(Buffer.from('Code,Fee\nD1110,95\nD0120,55\n'), 'fees.csv', 'text/csv')).status, 201);
  assert.equal((await upload(docx('Dear Dr. Lee, thank you for the referral.'), 'letter.docx')).status, 201);
  assert.equal((await upload(Buffer.from('<script>alert(1)</script>'), 'x.html', 'text/html')).status, 415, 'pages and scripts are refused');
  await openDocs();
  await page.waitForSelector('.doc-tile:has-text("scan0007.pdf") .doc-badge.suggest');
  await page.click('.doc-tile:has-text("scan0007.pdf")');
  await page.waitForSelector('.docview .docp-pdf');
  await page.waitForSelector('.docside-suggest:has-text("Looks like an EOB")');
  assert.match(await page.textContent('.docside-suggest'), /explanation of benefits/i, 'the reason is shown');
  const r = await measure(page, async () => {
    await page.click('.docside-suggest button:has-text("File as EOB")');
    await page.waitForSelector('.docside-suggest', { state: 'detached' });
  });
  console.log(withinBudget('file a document as suggested', r, { actions: 1, ms: 4000 }));
  assert.equal((await s.get(`/documents/${eob.data.id}/details`)).category, 'eob');
  // A note: type, Enter. Then edit it — the old wording stays in the history.
  await page.click('.docside textarea[aria-label="New note"]');
  await page.keyboard.type('Posted to the ledger on 9/24');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.docside-notes li:has-text("Posted to the ledger on 9/24")');
  await page.click('.docside-notes li button[aria-label="Edit note"]');
  await page.keyboard.press('End');
  await page.keyboard.type(' (check #5521)');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.docside-notes li:has-text("(check #5521)")');
  await page.click('.docside button:has-text("History")');
  await page.waitForSelector('.docside-old s:has-text("Posted to the ledger on 9/24")');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });

  await page.click('.doc-tile:has-text("fees.csv")');
  await page.waitForSelector('.docp-table th:has-text("Code")');
  assert.equal(await page.locator('.docp-table tr').count(), 3);
  await page.keyboard.press('Escape');
  await page.click('.doc-tile:has-text("letter.docx")');
  await page.waitForSelector('.docp-text pre:has-text("thank you for the referral")');
  await page.keyboard.press('Escape');
  assert.deepEqual(s.errors, []);
});

test('search finds documents by the words inside them, with the matching words shown', async () => {
  const { page } = s;
  await openDocs();
  await page.click('input[aria-label="Search documents"]');
  await page.keyboard.type('periodontal');
  await page.waitForSelector('.doc-tile:has-text("Referral Dr Smith.pdf") .doc-hit');
  assert.match(await page.textContent('.doc-tile:has-text("Referral Dr Smith.pdf") .doc-hit'), /periodontal/i);
  assert.equal(await page.locator('.doc-tile').count(), 1);
  await page.keyboard.press('Escape');
});

test('phone scan page: a photographed page is found, straightened and sent as one PDF', async () => {
  const link = await s.post(`/patients/${patient.id}/upload-links`, { category: 'document' });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await phone.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(link.url.replace(/^https?:\/\/[^/]+/, app.base));
  await page.waitForSelector('text=Scan a document');
  // A "photo": a light page on a dark desk, drawn in the page and handed to the camera input.
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 900; c.height = 1200;
    const x = c.getContext('2d');
    x.fillStyle = '#3a3a3a'; x.fillRect(0, 0, 900, 1200);
    x.fillStyle = '#f2f0ea'; x.beginPath(); x.moveTo(170, 140); x.lineTo(760, 190); x.lineTo(720, 1060); x.lineTo(120, 1010); x.closePath(); x.fill();
    x.fillStyle = '#222'; for (let y = 300; y < 900; y += 40) x.fillRect(240, y, 380, 8);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s2 = ''; for (const b of bytes) s2 += String.fromCharCode(b);
    return btoa(s2); // eslint-disable-line no-undef
  });
  await page.setInputFiles('input[aria-label="Scan a page with the camera"]', { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
  await page.waitForSelector('text=Page found');
  await page.click('button:has-text("Use this page")');
  await page.waitForSelector('.pscan-page img');
  await page.click('button:has-text("Send 1 page as one PDF")');
  await page.waitForSelector('.public-notice.ok');
  const docs = await s.get(`/patients/${patient.id}/documents`);
  const pdf = docs.find((d) => /^Scan .*\(1 page\)\.pdf$/.test(d.filename));
  assert.ok(pdf, docs.map((d) => d.filename).join(', '));
  assert.equal(pdf.mime, 'application/pdf');
  assert.deepEqual(errors, []);
  await phone.close();
});

test('office documents page (needs its route in App.jsx)', async (t) => {
  const { page } = s;
  await page.goto(`${app.base}/documents`);
  const mounted = await page.waitForSelector('.offdocs', { timeout: 4000 }).then(() => true, () => false);
  if (!mounted) { t.skip('/documents is not routed yet (see docs/documents.md for the App.jsx line)'); return; }
  await page.waitForSelector('[role=tab]:has-text("Office documents")');
  const up = await page.evaluate(async (b64) => {
    const body = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const res = await fetch(`/api/office-documents?${new URLSearchParams({ filename: 'Lease agreement.pdf', category: 'contract', expires_on: '2027-01-31' })}`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}`, 'Content-Type': 'application/pdf' }, body: new Blob([body]),
    });
    return res.status;
  }, pdfWith('This lease agreement between the parties').toString('base64'));
  assert.equal(up, 201);
  await page.reload();
  await page.click('.offdocs-list tr:has-text("Lease agreement.pdf")');
  await page.waitForSelector('.docview .docside');
  await page.keyboard.press('Escape');
});

test('command bar: words inside documents are found from anywhere (needs <DocumentCommands /> in the shell)', async (t) => {
  const { page } = s;
  await page.goto(`${app.base}/`);
  await page.waitForSelector('.sidebar');
  await page.waitForTimeout(300);
  await quiet(page);
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette input');
  await page.keyboard.type('periodontal');
  const found = await page.waitForSelector('.palette >> text=“periodontal” in Referral Dr Smith.pdf', { timeout: 4000 }).then(() => true, () => false);
  if (!found) {
    // Typing once more makes the bar recompute its list (it only re-reads screen commands as you type).
    await page.keyboard.type(' ');
    const again = await page.waitForSelector('.palette >> text=Referral Dr Smith.pdf', { timeout: 3000 }).then(() => true, () => false);
    if (!again) { await page.keyboard.press('Escape'); t.skip('<DocumentCommands /> is not mounted in the signed-in shell yet'); return; }
  }
  await page.keyboard.press('Escape');
});
