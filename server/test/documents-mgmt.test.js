// Document management and scanning (docs/documents.md): any file type (checked by content), virus scanning,
// range requests, reading text for search (OCR adapter), notes with history, "needs review", links, office
// documents, the scan inbox, and scanning through the imaging bridge.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { HttpError } from '../src/auth.js';
import { docBridgeRoutes, docMediaRoutes } from '../src/routes/docbridge.js';
import { classify } from '../src/filetypes.js';
import { createVirusScanner, clamdScan } from '../src/virusscan.js';
import { createOcr, extractText, pdfText, suggestCategory, findExpiry } from '../src/ocr.js';
import { termsOf, snippet } from '../src/docsearch.js';
import { readsIdle } from '../src/docfiles.js';
import { buildZip } from '../src/zip.js';
import { encodePng } from '../src/dicomimage.js';

const here = dirname(fileURLToPath(import.meta.url));
const agentPath = join(here, '../../bridge/dental-machine-bridge.mjs');
const SECRET = 'test-secret';

// ---- A test app with the new routes mounted the way app.js will (they're in their own files) ----
const h = {};
const uploadDir = mkdtempSync(join(tmpdir(), 'dm-docs-'));
let server;
// A virus scanner the tests can swap (sandbox by default, then a fake clamd).
const av = { current: createVirusScanner({ host: null }) };
const scanner = { get mode() { return av.current.mode; }, get name() { return av.current.name; }, scan: (b) => av.current.scan(b) };
// A stand-in OCR reader: "reads" images by returning the text hidden in their name, counting calls.
const ocrCalls = [];
const ocrAdapter = {
  mode: 'ai', name: 'Test reader',
  async read({ mime, filename, scope }) {
    ocrCalls.push({ mime, filename, scope });
    if (/fail/.test(filename)) throw new Error('reader down');
    if (/card/.test(filename)) return { text: 'DELTA DENTAL Member ID W123456 Group 7788', category: 'insurance_card', reason: 'Has a member ID and group number' };
    return { text: `Scanned page text for ${filename} periodontal referral`, category: null, reason: null };
  },
};
before(async () => {
  h.db = await openDb(':memory:');
  h.config = { appUrl: 'https://app.example.com', uploadDir, ediMode: 'sandbox', virusScanner: scanner, ocrAdapter };
  const inner = createApp({ db: h.db, secret: SECRET, config: h.config, messenger: { status: { sms: 'test', email: 'test' }, send: async () => ({ provider_id: 't' }) } });
  h.storage = inner.locals.storage;
  const app = express();
  app.use('/api/bridge', docBridgeRoutes({ db: h.db, storage: h.storage, config: h.config, scanner, reader: ocrAdapter }));
  app.use('/api/media', docMediaRoutes({ db: h.db, storage: h.storage, secret: SECRET }));
  app.use(inner);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message, details: err.details }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  h.origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.close();
  await h.db?.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

const call = async (token, method, path, body, headers = {}) => {
  const raw = Buffer.isBuffer(body) || typeof body === 'string';
  const res = await fetch(`${h.origin}/api${path}`, {
    method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: token.startsWith('dmb_') ? `Bridge ${token}` : `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = buf;
  if (/json/.test(res.headers.get('content-type') || '')) data = JSON.parse(buf.toString() || 'null');
  return { status: res.status, data, headers: res.headers };
};
const client = (token) => ({
  get: (p, hd) => call(token, 'GET', p, undefined, hd), post: (p, b = {}, hd) => call(token, 'POST', p, b, hd), put: (p, b, hd) => call(token, 'PUT', p, b, hd), del: (p) => call(token, 'DELETE', p),
});
let n = 0;
// Sign-ups and sign-ins are rate limited per address: each comes from its own (trusted-proxy) address here.
const fresh = () => ({ 'X-Forwarded-For': `10.77.${Math.floor(++n / 200)}.${n % 200}` });
async function practice() {
  n++;
  const email = `docs${n}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const reg = await client().post('/auth/register', { practice_name: `Docs ${n}`, name: 'Admin', email, password: 'correct-horse-battery' }, fresh());
  const api = client(reg.data.token);
  const patient = (await api.post('/patients', { first_name: 'Jane', last_name: 'Doe', dob: '1985-04-12' })).data;
  const other = (await api.post('/patients', { first_name: 'Sam', last_name: 'Roe', dob: '1990-01-01' })).data;
  return { api, token: reg.data.token, patient, other, practiceId: reg.data.user?.practice_id };
}
async function person(api, role, extra = {}) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = (await api.post('/users', { email, name: `${role} person`, role, password: 'correct-horse-battery', ...extra })).data;
  const token = (await client().post('/auth/login', { email, password: 'correct-horse-battery' }, fresh())).data.token;
  return { ...client(token), token, id: u.id ?? u.user?.id };
}
const upload = (api, patientId, bytes, filename, { type = 'application/octet-stream', query = {}, headers = {} } = {}) => api.post(`/patients/${patientId}/documents?${new URLSearchParams({ filename, ...query })}`, Buffer.from(bytes), { 'Content-Type': type, ...headers });

// ---- Fixtures: the smallest real files of each kind ----
const png = () => encodePng(4, 4, 1, Buffer.alloc(16, 90));
const jpeg = (w = 16, h = 12) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const ftyp = (brand, rest = 2048) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`, 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('isommp41', 'latin1'), Buffer.alloc(rest, 7)]);
const ooxml = (kind, text, extra = []) => {
  const files = [{ name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' }];
  if (kind === 'docx') files.push({ name: 'word/document.xml', data: `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` });
  if (kind === 'xlsx') files.push({ name: 'xl/sharedStrings.xml', data: `<sst><si><t>${text}</t></si></sst>` }, { name: 'xl/worksheets/sheet1.xml', data: '<worksheet/>' });
  if (kind === 'pptx') files.push({ name: 'ppt/slides/slide1.xml', data: `<p:sld><a:t>${text}</a:t></p:sld>` });
  return buildZip([...files, ...extra]);
};
// A PDF with a text layer (compressed or not).
const pdfWith = (text, { compress = false } = {}) => {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const stream = compress ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  return Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${stream.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream\nendobj\ntrailer\n<< >>\n%%EOF\n', 'latin1')]);
};
const scannedPdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /XObject /Subtype /Image /Length 4 /Filter /DCTDecode >>\nstream\n', 'latin1'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from('\nendstream\nendobj\n%%EOF\n')]);
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const waitFor = async (fn, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
};

// ---------------------------------------------------------------------------------------------------
test('file types: every everyday kind is recognised by its contents; programs, pages and scripts never are', () => {
  const ok = [
    [png(), 'x.png', 'image/png'], [jpeg(), 'photo.jpg', 'image/jpeg'], [ftyp('heic'), 'IMG_1.HEIC', 'image/heic'], [ftyp('mif1'), 'a.heif', 'image/heif'],
    [Buffer.concat([Buffer.from('II*\0'), Buffer.alloc(20)]), 'fax.tif', 'image/tiff'], [pdfWith('hi'), 'a.pdf', 'application/pdf'],
    [ooxml('docx', 'Hello'), 'letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    [ooxml('xlsx', 'Fees'), 'fees.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    [ooxml('pptx', 'Slide'), 'deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    [Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(500)]), 'old.doc', 'application/msword'],
    [Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(500)]), 'old.xls', 'application/vnd.ms-excel'],
    [Buffer.from('{\\rtf1\\ansi Hello}'), 'note.rtf', 'application/rtf'], [Buffer.from('a,b\n1,2\n'), 'list.csv', 'text/csv'], [Buffer.from('plain words'), 'n.txt', 'text/plain'],
    [Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100, 1)]), 'voice.mp3', 'audio/mpeg'], [ftyp('M4A '), 'memo.m4a', 'audio/mp4'],
    [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(40)]), 'a.wav', 'audio/wav'],
    [ftyp('isom'), 'clip.mp4', 'video/mp4'], [ftyp('qt  '), 'clip.mov', 'video/quicktime'], [Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(50)]), 'clip.webm', 'video/webm'],
    [Buffer.from('solid crown\nendsolid crown\n'), 'crown.stl', null],
  ];
  for (const [buf, name, mime] of ok) {
    const out = classify(buf, name, 'application/octet-stream');
    if (mime) assert.equal(out.mime, mime, name);
  }
  const refused = [
    [Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]), 'setup.exe'], [Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]), 'scan.pdf'],
    [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), 'tool'], [Buffer.from('#!/bin/sh\nrm -rf /\n'), 'run.txt'],
    [Buffer.from('<html><body>hi</body></html>'), 'page.html'], [Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.svg'],
    [Buffer.from('<svg onload="alert(1)"></svg>'), 'logo.txt'], [Buffer.from('alert(document.cookie)'), 'x.js'], [Buffer.from('Write-Host hi'), 'x.ps1'],
    [ooxml('docx', 'macro', [{ name: 'word/vbaProject.bin', data: 'x' }]), 'macro.docx'],
    [Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(500)]), 'setup.msi'],
    [Buffer.from([0xff, 0xfe, 0x00, 0x41]), 'bad.txt'],
  ];
  for (const [buf, name] of refused) assert.throws(() => classify(buf, name, 'text/plain'), (e) => e.status === 415, name);
  // Text only counts as text when it was sent as text: HTML-free words claiming to be a PNG are refused.
  assert.throws(() => classify(Buffer.from('hello'), 'x.png', 'image/png'), (e) => e.status === 415);
  // A harmless text file named like a page keeps working, renamed .txt (as before).
  assert.equal(classify(Buffer.from('hello there'), 'page.html', 'text/plain').filename, 'page.txt');
  // Size limits per kind (text: 25 MB).
  assert.throws(() => classify(Buffer.alloc(26 * 1024 * 1024, 0x61), 'big.txt', 'text/plain'), (e) => e.status === 413);
});

test('uploads: Office, audio, video, HEIC and multi-page TIFF are kept; executables and pages are refused (415) over HTTP', async () => {
  const { api, patient } = await practice();
  const cases = [
    [ooxml('docx', 'Referral letter'), 'Referral.docx', 201], [ftyp('isom', 4096), 'intraoral.mp4', 201], [ftyp('M4A '), 'voice.m4a', 201],
    [ftyp('heic'), 'IMG_2201.HEIC', 201], [Buffer.concat([Buffer.from('MM\0*'), Buffer.alloc(40)]), 'fax.tiff', 201], [Buffer.from('a,b\n'), 'list.csv', 201],
    [Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]), 'invoice.pdf', 415], [Buffer.from('<script>alert(1)</script>'), 'x.html', 415],
    [Buffer.from('<svg><script>1</script></svg>'), 'x.svg', 415],
  ];
  for (const [bytes, name, status] of cases) {
    const res = await upload(api, patient.id, bytes, name, { type: name.endsWith('.html') ? 'text/html' : name.endsWith('.csv') ? 'text/csv' : 'application/octet-stream' });
    assert.equal(res.status, status, `${name}: ${JSON.stringify(res.data)}`);
  }
  const list = (await api.get(`/patients/${patient.id}/documents`)).data;
  assert.deepEqual(list.map((d) => d.mime).sort(), ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'audio/mp4', 'image/heic', 'image/tiff', 'text/csv', 'video/mp4'].sort());
  assert.ok(list.every((d) => d.virus_status === 'not_scanned'), 'sandbox scanner: recorded as not scanned');
});

test('range requests: audio/video seek with 206 partial content; a viewing is audited once, not per piece', async () => {
  const { api, patient } = await practice();
  const video = ftyp('isom', 300_000);
  const up = (await upload(api, patient.id, video, 'clip.mp4')).data;
  const whole = await api.get(`/documents/${up.id}/file`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(whole.headers.get('content-disposition').startsWith('inline'), true);
  const first = await api.get(`/documents/${up.id}/file`, { Range: 'bytes=0-99' });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), `bytes 0-99/${video.length}`);
  assert.equal(first.data.length, 100);
  assert.ok(first.data.equals(video.subarray(0, 100)));
  const middle = await api.get(`/documents/${up.id}/file`, { Range: 'bytes=1000-' });
  assert.equal(middle.status, 206);
  assert.equal(middle.data.length, video.length - 1000);
  const tail = await api.get(`/documents/${up.id}/file`, { Range: 'bytes=-50' });
  assert.ok(tail.data.equals(video.subarray(video.length - 50)));
  const bad = await api.get(`/documents/${up.id}/file`, { Range: `bytes=${video.length + 5}-` });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), `bytes */${video.length}`);
  const views = await h.db.all("SELECT id FROM audit_log WHERE action = 'document.view' AND entity_id = ?", up.id);
  assert.equal(views.length, 2, 'the whole file and the range from byte 0 — not the middle or the tail');
  // Office files download rather than open in the browser.
  const docx = (await upload(api, patient.id, ooxml('docx', 'x'), 'a.docx')).data;
  assert.match((await api.get(`/documents/${docx.id}/file`)).headers.get('content-disposition'), /^attachment/);

  // The player's link (a <video> can't send the sign-in header): short-lived, for this document only.
  const link = await api.post(`/media/documents/${up.id}/link`);
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const streamed = await fetch(`${h.origin}${link.data.url}`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(streamed.status, 206);
  assert.ok(Buffer.from(await streamed.arrayBuffer()).equals(video.subarray(10, 20)));
  assert.equal((await fetch(`${h.origin}${link.data.url.replace(`/documents/${up.id}`, `/documents/${docx.id}`)}`)).status, 401, 'the link is for one document');
  const other = await practice();
  assert.equal((await other.api.post(`/media/documents/${up.id}/link`)).status, 404);
});

test('virus scanning: sandbox catches the EICAR test file; ClamAV (fake clamd) clean / FOUND / down', async () => {
  const { api, patient, practiceId } = await practice();
  const blocked = await upload(api, patient.id, Buffer.from(EICAR), 'eicar.txt', { type: 'text/plain' });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.data.details.virus, true);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'document.virus_blocked' AND patient_id = ?", patient.id));
  assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND kind = 'records' AND status = 'open' AND title LIKE '%virus%'", practiceId));
  assert.equal((await api.get(`/patients/${patient.id}/documents`)).data.length, 0, 'nothing was stored');

  // A fake clamd: INSTREAM chunks in, "stream: OK" or "... FOUND" out.
  const seen = [];
  const clamd = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!buf.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return;
      let p = 10;
      const body = [];
      for (;;) {
        if (buf.length < p + 4) return;
        const len = buf.readUInt32BE(p);
        if (len === 0) break;
        if (buf.length < p + 4 + len) return;
        body.push(buf.subarray(p + 4, p + 4 + len));
        p += 4 + len;
      }
      const data = Buffer.concat(body);
      seen.push(data.length);
      sock.end(data.includes('INFECTED') ? 'stream: Win.Test.Fake-1 FOUND\0' : 'stream: OK\0');
    });
  });
  await new Promise((r) => clamd.listen(0, '127.0.0.1', r));
  const port = clamd.address().port;
  try {
    assert.deepEqual(await clamdScan({ host: '127.0.0.1', port }, Buffer.alloc(200_000, 1)), { clean: true });
    assert.deepEqual(await clamdScan({ host: '127.0.0.1', port }, Buffer.from('xx INFECTED xx')), { clean: false, signature: 'Win.Test.Fake-1' });
    assert.ok(seen.includes(200_000), 'large files go in 64 KB chunks and arrive whole');
    av.current = createVirusScanner({ host: '127.0.0.1', port });
    const clean = await upload(api, patient.id, png(), 'clean.png', { type: 'image/png' });
    assert.equal(clean.status, 201);
    assert.equal((await h.db.get('SELECT virus_status FROM documents WHERE id = ?', clean.data.id)).virus_status, 'clean');
    const infected = await upload(api, patient.id, Buffer.from('plain text INFECTED here'), 'bad.txt', { type: 'text/plain' });
    assert.equal(infected.status, 422);
    assert.match(infected.data.error, /Win\.Test\.Fake-1/);
    assert.ok(await h.db.get("SELECT id FROM integration_log WHERE service = 'ClamAV' AND ok = 1"), 'scans show in Connection activity');
    // The scanner goes away: uploads are refused (503) and it's in Needs attention; the next good scan resolves it.
    av.current = createVirusScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 });
    assert.equal((await upload(api, patient.id, png(), 'later.png', { type: 'image/png' })).status, 503);
    assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = 'virusscan:down' AND status = 'open'", practiceId));
    av.current = createVirusScanner({ host: '127.0.0.1', port });
    assert.equal((await upload(api, patient.id, png(), 'later.png', { type: 'image/png' })).status, 201);
    assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = 'virusscan:down' AND status = 'resolved'", practiceId));
  } finally {
    av.current = createVirusScanner({ host: null });
    clamd.close();
  }
});

test('reading text: local extraction (PDF text layer, Word, RTF), the OCR adapter modes, suggestions and expiry dates', async () => {
  assert.match(pdfText(pdfWith('Explanation of Benefits paid')), /Explanation of Benefits paid/);
  assert.match(pdfText(pdfWith('Compressed words here', { compress: true })), /Compressed words here/);
  assert.equal(extractText('application/pdf', scannedPdf()).text, '', 'a scanned PDF has to be read as a picture');
  assert.match(extractText('application/vnd.openxmlformats-officedocument.wordprocessingml.document', ooxml('docx', 'Dear Dr. Lee &amp; team')).text, /Dear Dr\. Lee & team/);
  assert.match(extractText('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ooxml('xlsx', 'Invoice 42')).text, /Invoice 42/);
  assert.match(extractText('application/rtf', Buffer.from('{\\rtf1\\ansi\\b Bold\\b0  words\\par next}')).text, /Bold words\s*\n?next/);
  assert.equal(createOcr({ config: { ediMode: 'sandbox' } }).mode, 'sandbox');
  assert.deepEqual(await createOcr({ config: { ediMode: 'sandbox' } }).read({ mime: 'image/png', data: png() }), { text: '', category: null, reason: null });
  assert.equal(createOcr({ config: { ediMode: 'manual' } }).mode, 'off');
  assert.equal(suggestCategory({ filename: 'scan.pdf', text: 'EXPLANATION OF BENEFITS — Claim number 55 paid' }).category, 'eob');
  assert.match(suggestCategory({ filename: 'scan.pdf', text: 'Member ID: W1 Group No: 22' }).reason, /member ID/);
  assert.equal(suggestCategory({ filename: 'Lab_Rx_19.pdf' }).category, 'lab_rx');
  assert.equal(suggestCategory({ filename: 'x.pdf', text: 'This agreement between the parties', scope: 'office' }).category, 'contract');
  assert.equal(suggestCategory({ filename: 'x.pdf', text: 'This agreement between the parties', scope: 'patient' }), null, 'office kinds are never suggested for a chart');
  assert.equal(findExpiry('State dental licence No. 123 — Expires 03/31/2027'), '2027-03-31');
  assert.equal(findExpiry('Valid through: 2026-12-01'), '2026-12-01');
  assert.ok(termsOf('Insurance card').includes('p:insu'));
  assert.equal(snippet('The patient was referred by Dr Smith for evaluation', ['referred']), 'The patient was referred by Dr Smith for evaluation');
});

test('search: by the words inside (text layer, Word, OCR), notes and names — per patient, practice-wide, office-scoped, never across practices', async () => {
  const p = await practice();
  const { api, patient, other } = p;
  const eob = (await upload(api, patient.id, pdfWith('Explanation of Benefits Delta Dental claim 991 paid in full'), 'scan0001.pdf')).data;
  const letter = (await upload(api, other.id, ooxml('docx', 'Periodontal referral for Sam from Dr Smith'), 'letter.docx')).data;
  const card = (await upload(api, patient.id, png(), 'card-front.png', { type: 'image/png', query: { category: 'document' } })).data;
  const xray = (await upload(api, patient.id, png(), 'bw.png', { type: 'image/png', query: { category: 'xray' } })).data;
  await readsIdle();
  const d = (await api.get(`/documents/${eob.id}/details`)).data;
  assert.equal(d.ocr_status, 'done');
  assert.equal(d.ocr_source, 'pdf', 'read from the PDF itself, nothing sent anywhere');
  assert.equal(d.suggested_category, 'eob');
  assert.match(d.suggestion_reason, /explanation of benefits/i);
  const c = (await api.get(`/documents/${card.id}/details`)).data;
  assert.equal(c.ocr_source, 'ai');
  assert.equal(c.suggested_category, 'insurance_card');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'document.ai_read' AND entity_id = ? AND source = 'ai' AND reason LIKE '%member ID%'", card.id), 'the AI read is on record with its reason');
  assert.equal((await api.get(`/documents/${xray.id}/details`)).data.ocr_status, 'skipped', 'x-rays aren’t sent to be read');
  assert.ok(!ocrCalls.some((x) => x.filename === 'bw.png'));
  // The words are searchable, but not stored readable in the database.
  assert.equal(await h.db.get("SELECT id FROM document_terms WHERE term LIKE '%delta%'"), undefined);
  assert.equal((await h.db.get('SELECT ocr_key FROM documents WHERE id = ?', eob.id)).ocr_key.includes('/'), true);

  // Per patient.
  const mine = (await api.get(`/patients/${patient.id}/documents/search?q=delta benefits`)).data;
  assert.deepEqual(mine.map((x) => x.id), [eob.id]);
  assert.match(mine[0].snippet, /Delta Dental/);
  assert.deepEqual((await api.get(`/patients/${patient.id}/documents/search?q=periodontal`)).data, [], 'another patient’s letter isn’t in this chart’s results');
  assert.deepEqual((await api.get(`/patients/${patient.id}/documents/search?q=W1234`)).data.map((x) => x.id), [card.id], 'prefix of a word read by the OCR reader');
  // Practice-wide, with a link to open it.
  const all = (await api.get('/documents/search?q=periodontal')).data;
  assert.deepEqual(all.map((x) => x.id), [letter.id]);
  assert.equal(all[0].link, `/patients/${other.id}?tab=documents&doc=${letter.id}`);
  assert.equal(all[0].patient_name, 'Sam Roe');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'document.search' AND practice_id = ?", p.practiceId), 'searches are audited');
  // Notes are searched too.
  await api.post(`/documents/${xray.id}/notes`, { body: 'Compare with the 2024 bitewings' });
  assert.deepEqual((await api.get('/documents/search?q=bitewings')).data.map((x) => x.id), [xray.id]);
  // Another practice finds nothing.
  const stranger = await practice();
  assert.deepEqual((await stranger.api.get('/documents/search?q=periodontal')).data, []);
  assert.equal((await stranger.api.get(`/patients/${patient.id}/documents/search?q=delta`)).status, 404);
  // Someone limited to another office doesn't see this office's patients' documents.
  const north = (await api.post('/locations', { name: 'North' })).data;
  const south = (await api.post('/locations', { name: 'South' })).data;
  await h.db.run('UPDATE patients SET location_id = ? WHERE id IN (?, ?)', north.id, patient.id, other.id);
  const southDesk = await person(api, 'front_desk', { location_ids: [south.id] });
  assert.deepEqual((await southDesk.get('/documents/search?q=periodontal')).data, []);
  assert.equal((await southDesk.get(`/patients/${patient.id}/documents/search?q=delta`)).status, 404);
  assert.equal((await southDesk.get(`/documents/${eob.id}/details`)).status, 404);
  const northDesk = await person(api, 'front_desk', { location_ids: [north.id] });
  assert.deepEqual((await northDesk.get('/documents/search?q=periodontal')).data.map((x) => x.id), [letter.id]);
  // Office documents appear only for people with office-document access (administrators, for now).
  const contract = (await api.post(`/office-documents?${new URLSearchParams({ filename: 'Lease.pdf', category: 'contract' })}`, pdfWith('Lease agreement periodontal suite'), { 'Content-Type': 'application/pdf' })).data;
  await readsIdle();
  assert.deepEqual((await api.get('/documents/search?q=lease')).data.map((x) => x.id), [contract.id]);
  assert.deepEqual((await northDesk.get('/documents/search?q=lease')).data, []);
  assert.deepEqual((await api.get('/documents/search?q=periodontal&scope=patients')).data.map((x) => x.id), [letter.id]);
  // Reading again on request (e.g. after AI was switched on).
  const again = await api.post(`/documents/${card.id}/read`);
  assert.equal(again.data.status, 'done');
});

test('a failing reader becomes a Needs attention item, resolved when reading works again; AI reading can be switched off', async () => {
  const { api, patient, practiceId } = await practice();
  const bad = (await upload(api, patient.id, png(), 'fail-scan.png', { type: 'image/png', query: { category: 'document' } })).data;
  await readsIdle();
  assert.equal((await api.get(`/documents/${bad.id}/details`)).data.ocr_status, 'failed');
  assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND kind = 'ai' AND status = 'open'", practiceId));
  await upload(api, patient.id, png(), 'good-scan.png', { type: 'image/png', query: { category: 'document' } });
  await readsIdle();
  assert.ok(await h.db.get("SELECT id FROM issues WHERE practice_id = ? AND kind = 'ai' AND status = 'resolved'", practiceId));
  assert.equal((await api.put('/documents/settings', { document_ai: false })).data.document_ai, false);
  const before = ocrCalls.length;
  const off = (await upload(api, patient.id, png(), 'after-off.png', { type: 'image/png', query: { category: 'document' } })).data;
  await readsIdle();
  assert.equal(ocrCalls.length, before, 'nothing is sent to the AI once the practice turned it off');
  assert.equal((await api.get(`/documents/${off.id}/details`)).data.ocr_status, 'skipped');
  const dentist = await person(api, 'dentist');
  assert.equal((await dentist.put('/documents/settings', { document_ai: true })).status, 403);
});

test('notes on documents: sticky-note pins, edits keep history (a new row), removal is a status, undo restores; all audited', async () => {
  const { api, patient } = await practice();
  const doc = (await upload(api, patient.id, pdfWith('Consent'), 'consent.pdf')).data;
  assert.equal((await api.post(`/documents/${doc.id}/notes`, { body: '  ' })).status, 400);
  assert.equal((await api.post(`/documents/${doc.id}/notes`, { body: 'x', x: 1.5, y: 0.2 })).status, 400);
  const note = (await api.post(`/documents/${doc.id}/notes`, { body: 'Signed by mother (guardian)' })).data;
  assert.equal(note.author, 'Admin');
  const pin = (await api.post(`/documents/${doc.id}/notes`, { body: 'Initials missing here', x: 0.25, y: 0.8, page: 2 })).data;
  assert.deepEqual([pin.x, pin.y, pin.page, pin.pinned, pin.color], [0.25, 0.8, 2, true, 'yellow']);
  const edited = (await api.put(`/document-notes/${note.id}`, { body: 'Signed by mother (legal guardian)' })).data;
  assert.equal(edited.supersedes_id, note.id);
  assert.equal((await api.put(`/document-notes/${note.id}`, { body: 'stale edit' })).status, 409, 'an old version can’t be edited');
  const moved = (await api.put(`/document-notes/${pin.id}`, { x: 0.3, y: 0.7 })).data;
  assert.equal(moved.body, 'Initials missing here');
  assert.equal((await api.del(`/document-notes/${moved.id}`)).status, 200);
  let active = (await api.get(`/documents/${doc.id}/notes`)).data;
  assert.deepEqual(active.map((x) => x.body), ['Signed by mother (legal guardian)']);
  const history = (await api.get(`/documents/${doc.id}/notes?history=1`)).data;
  assert.deepEqual(history.map((x) => x.status), ['superseded', 'superseded', 'active', 'deleted']);
  assert.equal(await h.db.get('SELECT COUNT(*) AS n FROM document_notes WHERE document_id = ?', doc.id).then((r) => r.n), 4, 'nothing is overwritten or removed');
  await api.post(`/document-notes/${moved.id}/restore`);
  active = (await api.get(`/documents/${doc.id}/notes`)).data;
  assert.equal(active.length, 2);
  const audits = (await h.db.all("SELECT action FROM audit_log WHERE entity = 'documents' AND entity_id = ? AND action LIKE 'document.%' ORDER BY id", doc.id)).map((a) => a.action);
  for (const a of ['document.note', 'document.pin', 'document.note_edit', 'document.note_remove', 'document.note_restore']) assert.ok(audits.includes(a), a);
  const edit = await h.db.get("SELECT changes, details FROM audit_log WHERE action = 'document.note_edit' AND entity_id = ? ORDER BY id", doc.id);
  assert.match(String(edit.changes), /Signed by mother \(guardian\).*legal guardian/);
  // Notes come with the document's details and count on the list.
  assert.equal((await api.get(`/documents/${doc.id}/details`)).data.doc_notes.length, 2);
  assert.equal((await api.get(`/patients/${patient.id}/documents`)).data[0].note_count, 2);
  // Someone who can only read charts can't add notes; another practice can't see them.
  const billing = await person(api, 'billing');
  assert.equal((await billing.post(`/documents/${doc.id}/notes`, { body: 'hi' })).status, 403);
  assert.equal((await billing.get(`/documents/${doc.id}/notes`)).status, 200);
  const stranger = await practice();
  assert.equal((await stranger.api.get(`/documents/${doc.id}/notes`)).status, 404);
  assert.equal((await stranger.api.put(`/document-notes/${edited.id}`, { body: 'x' })).status, 404);
});

test('"needs review": routed to a person as a task on their to-do, listed for them, and cleared when reviewed', async () => {
  const { api, patient } = await practice();
  const dentist = await person(api, 'dentist');
  const billing = await person(api, 'billing');
  const doc = (await upload(api, patient.id, pdfWith('Outside CBCT report'), 'cbct report.pdf')).data;
  assert.equal((await api.put(`/documents/${doc.id}/review`, { assignee_id: 999999 })).status, 404);
  const flagged = await api.put(`/documents/${doc.id}/review`, { assignee_id: dentist.id, note: 'Please read the impression' });
  assert.equal(flagged.status, 200, JSON.stringify(flagged.data));
  const task = await h.db.get('SELECT * FROM tasks WHERE id = ?', flagged.data.task_id);
  assert.equal(task.assigned_to, dentist.id);
  assert.equal(task.patient_id, patient.id);
  assert.match(task.title, /Review document: cbct report\.pdf/);
  assert.equal(task.status, 'open');
  const mine = (await dentist.get('/documents/needs-review?mine=1')).data;
  assert.deepEqual(mine.map((x) => x.id), [doc.id]);
  assert.equal(mine[0].link, `/patients/${patient.id}?tab=documents&doc=${doc.id}`);
  assert.deepEqual((await billing.get('/documents/needs-review?mine=1')).data, []);
  assert.equal((await billing.post(`/documents/${doc.id}/review/done`)).status, 403, 'only the reviewer (or someone who can change it)');
  assert.equal((await dentist.post(`/documents/${doc.id}/review/done`, { note: 'Normal findings' })).status, 200);
  assert.equal((await h.db.get('SELECT status FROM tasks WHERE id = ?', task.id)).status, 'done');
  const d = (await api.get(`/documents/${doc.id}/details`)).data;
  assert.equal(d.review.status, 'reviewed');
  assert.equal(d.review.reviewed_by.id, dentist.id);
  assert.ok(d.doc_notes.some((x) => x.body === 'Reviewed: Normal findings'));
  for (const a of ['document.review_request', 'document.reviewed']) assert.ok(await h.db.get('SELECT id FROM audit_log WHERE action = ? AND entity_id = ?', a, doc.id), a);
  // Someone who can't open charts can't be asked to review one.
  const other = await practice();
  assert.equal((await api.put(`/documents/${doc.id}/review`, { assignee_id: (await h.db.get('SELECT id FROM users WHERE practice_id = ?', other.practiceId)).id })).status, 404);
});

test('links: a document belongs with a visit, claim or treatment plan of the same patient in the same practice', async () => {
  const { api, patient, other } = await practice();
  const provider = (await api.post('/providers', { name: 'Dr. Lee', type: 'dentist' })).data;
  const visit = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: '2030-01-02 09:00', end_time: '2030-01-02 10:00' })).data;
  const theirs = (await api.post('/appointments', { patient_id: other.id, provider_id: provider.id, start_time: '2030-01-03 09:00', end_time: '2030-01-03 10:00' })).data;
  const plan = (await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Crown #3' })).data;
  const doc = (await upload(api, patient.id, pdfWith('x'), 'pre-op.pdf', { query: { appointment_id: visit.id } })).data;
  assert.equal((await api.get(`/documents/${doc.id}/details`)).data.appointment_id, visit.id, 'linked at upload');
  assert.equal((await upload(api, patient.id, pdfWith('x'), 'bad.pdf', { query: { appointment_id: theirs.id } })).status, 400);
  assert.equal((await api.put(`/documents/${doc.id}/links`, { appointment_id: theirs.id })).status, 400);
  assert.equal((await api.put(`/documents/${doc.id}/links`, { claim_id: 424242 })).status, 404);
  const stranger = await practice();
  const theirPlan = (await stranger.api.post(`/patients/${stranger.patient.id}/treatment-plans`, { name: 'x' })).data;
  assert.ok(plan.id && theirPlan.id);
  assert.equal((await api.put(`/documents/${doc.id}/links`, { treatment_plan_id: theirPlan.id })).status, 404);
  {
    const linked = await api.put(`/documents/${doc.id}/links`, { treatment_plan_id: plan.id });
    assert.equal(linked.status, 200, JSON.stringify(linked.data));
    assert.equal(linked.data.treatment_plan_id, plan.id);
    assert.equal((await api.get(`/documents/${doc.id}/details`)).data.links.treatment_plan.name, 'Crown #3');
  }
  const opts = (await api.get(`/documents/${doc.id}/link-options`)).data;
  assert.deepEqual(opts.appointments.map((a) => a.id), [visit.id]);
  assert.equal((await api.put(`/documents/${doc.id}/links`, { appointment_id: null })).data.appointment_id, null);
  // Folders.
  await api.put(`/documents/${doc.id}`, { folder: 'Ortho records' });
  assert.deepEqual((await api.get(`/patients/${patient.id}/document-folders`)).data, [{ folder: 'Ortho records', n: 1 }]);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'document.link' AND entity_id = ?", doc.id));
});

test('office documents: their own permission, same viewer and notes, expiry reminders once, other practices never', async () => {
  const { api, practiceId } = await practice();
  const dentist = await person(api, 'dentist');
  const q = (o) => `/office-documents?${new URLSearchParams(o)}`;
  assert.equal((await dentist.post(q({ filename: 'x.pdf' }), pdfWith('x'), { 'Content-Type': 'application/pdf' })).status, 403);
  assert.equal((await dentist.get('/office-documents')).status, 403);
  assert.equal((await api.post(q({ filename: 'x.pdf', category: 'xray' }), pdfWith('x'), { 'Content-Type': 'application/pdf' })).status, 400, 'office kinds only');
  const soon = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
  const licence = (await api.post(q({ filename: 'DEA registration.pdf', category: 'license', expires_on: soon, folder: 'Licences' }), pdfWith('DEA registration certificate'), { 'Content-Type': 'application/pdf' })).data;
  assert.equal(licence.patient_id, null);
  const read = (await api.post(q({ filename: 'Board licence.pdf', category: 'license' }), pdfWith('Dental licence No. 5521 Expires 12/31/2030'), { 'Content-Type': 'application/pdf' })).data;
  await readsIdle();
  assert.equal((await api.get(`/documents/${read.id}/details`)).data.expires_on, '2030-12-31', 'expiry date read from the document');
  const list = (await api.get('/office-documents')).data;
  assert.deepEqual(list.map((d) => d.id).sort(), [licence.id, read.id].sort());
  await api.get('/office-documents');
  const tasks = await h.db.all('SELECT * FROM tasks WHERE practice_id = ? AND title LIKE ?', practiceId, '%DEA registration%');
  assert.equal(tasks.length, 1, 'one reminder, however often the list is opened');
  assert.equal(tasks[0].priority, 'high');
  // Renewed: a new date closes the old reminder.
  await api.put(`/documents/${licence.id}`, { expires_on: '2031-01-31' });
  assert.equal((await h.db.get('SELECT status FROM tasks WHERE id = ?', tasks[0].id)).status, 'done');
  // Same tools as patient documents: notes, the file, search, removal with undo.
  assert.equal((await api.post(`/documents/${licence.id}/notes`, { body: 'Renewal filed online' })).status, 201);
  assert.equal((await api.get(`/documents/${licence.id}/file`)).status, 200);
  assert.equal((await dentist.get(`/documents/${licence.id}/file`)).status, 404, 'no office-document access: as if it didn’t exist');
  assert.equal((await dentist.post(`/documents/${licence.id}/notes`, { body: 'x' })).status, 404);
  assert.equal((await dentist.del(`/documents/${licence.id}`)).status, 404);
  assert.equal((await api.del(`/documents/${licence.id}`)).status, 200);
  assert.equal((await api.get('/office-documents')).data.length, 1);
  assert.equal((await api.get('/office-documents?removed=1')).data.length, 1);
  await api.post(`/documents/${licence.id}/restore`);
  assert.deepEqual((await api.get('/office-documents/folders')).data, [{ folder: 'Licences', n: 1 }]);
  const stranger = await practice();
  assert.equal((await stranger.api.get(`/documents/${licence.id}/details`)).status, 404);
  assert.deepEqual((await stranger.api.get('/office-documents')).data, []);
  // Offices: an administrator limited to one office doesn't see another office's documents.
  const north = (await api.post('/locations', { name: 'North' })).data;
  const south = (await api.post('/locations', { name: 'South' })).data;
  await h.db.run('UPDATE documents SET location_id = ? WHERE id = ?', north.id, licence.id);
  const southAdmin = await person(api, 'admin', { location_ids: [south.id] });
  assert.equal((await southAdmin.get(`/documents/${licence.id}/details`)).status, 404);
  assert.ok(!(await southAdmin.get('/office-documents')).data.some((d) => d.id === licence.id));
});

test('scan job through the bridge API: scanner registered, "scan now" queued for the patient, the PDF filed to that chart', async () => {
  const { api, patient, other } = await practice();
  const agent = (await api.post('/imaging/agents', { name: 'Front desk' })).data;
  const bridge = client(agent.token);
  const first = await api.post(`/patients/${patient.id}/scan`, { agent_id: agent.id });
  assert.equal(first.status, 400, JSON.stringify(first.data));
  assert.equal((await bridge.post('/bridge/scanner', { name: 'Epson DS-530', driver: 'wia', feeder: true, duplex: true })).status, 200);
  const scanners = (await api.get('/scanners')).data;
  assert.equal(scanners[0].scanner, 'Epson DS-530');
  assert.equal(scanners[0].online, true);
  assert.equal((await api.post(`/patients/${patient.id}/scan`, { agent_id: agent.id, dpi: 123 })).status, 400);
  const job = await api.post(`/patients/${patient.id}/scan`, { agent_id: agent.id, source: 'feeder', duplex: true, color: 'gray', dpi: 300, category: 'referral' });
  assert.equal(job.status, 201, JSON.stringify(job.data));
  assert.equal((await api.post(`/patients/${patient.id}/scan`, { agent_id: agent.id })).status, 409, 'one scan at a time per scanner');
  const cmds = (await bridge.get('/bridge/commands?wait=1')).data;
  assert.equal(cmds[0].type, 'scan');
  assert.deepEqual(cmds[0].patient, { id: patient.id, first_name: 'Jane', last_name: 'Doe' });
  assert.deepEqual(cmds[0].options, { source: 'feeder', color: 'gray', format: 'pdf', dpi: 300, duplex: true });
  // A program is refused even from the bridge; the PDF is filed.
  assert.equal((await bridge.post(`/bridge/scans/${job.data.id}/file?filename=scan.pdf`, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]))).status, 415);
  const filed = await bridge.post(`/bridge/scans/${job.data.id}/file?filename=scan.pdf`, pdfWith('Referral to periodontist'));
  assert.equal(filed.status, 201, JSON.stringify(filed.data));
  assert.equal(filed.data.patient_id, patient.id);
  await bridge.post(`/bridge/commands/${job.data.id}/result`, { ok: true, message: 'Scanned 1 page' });
  const status = (await api.get(`/scans/${job.data.id}`)).data;
  assert.equal(status.status, 'done');
  assert.equal(status.documents.length, 1);
  const doc = await h.db.get('SELECT * FROM documents WHERE id = ?', filed.data.id);
  assert.equal(doc.category, 'referral');
  assert.equal(doc.source, `scan:${job.data.id}`);
  assert.match(doc.notes, /Scanned on Front desk \(Epson DS-530\)/);
  const a = await h.db.get("SELECT source, actor FROM audit_log WHERE action = 'document.scan' AND entity_id = ?", doc.id);
  assert.equal(a.source, 'integration', 'the bridge is recorded as the integration, not as a person');
  assert.equal((await bridge.post(`/bridge/scans/${job.data.id}/file?filename=scan.pdf`, pdfWith('late'))).status, 409, 'a finished scan takes no more files');
  // Scan-folder uploads: named for a chart → filed; otherwise → the scan inbox for staff to file.
  const named = (await bridge.post(`/bridge/scan-inbox?filename=P${other.id}_letter.pdf&patient_id=${other.id}`, pdfWith('Letter'))).data;
  assert.equal(named.patient_id, other.id);
  const loose = (await bridge.post('/bridge/scan-inbox?filename=Scan_0001.pdf', pdfWith('Unknown paperwork'))).data;
  assert.equal(loose.inbox, true);
  const stranger = await practice();
  const wrong = (await bridge.post(`/bridge/scan-inbox?filename=x.pdf&patient_id=${stranger.patient.id}`, pdfWith('Someone else'))).data;
  assert.equal(wrong.inbox, true, 'a chart number from another practice is never trusted');
  assert.match(wrong.reason, /No patient/);
  const inbox = (await api.get('/document-inbox')).data;
  assert.deepEqual(inbox.map((d) => d.id).sort(), [loose.id, wrong.id].sort());
  assert.equal((await api.get(`/documents/${loose.id}/file`)).status, 200);
  const dentistLimited = await person(api, 'billing');
  assert.equal((await dentistLimited.get('/document-inbox')).status, 403);
  const moved = await api.post(`/document-inbox/${loose.id}/file`, { patient_id: patient.id, category: 'correspondence' });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.patient_id, patient.id);
  assert.equal((await api.post(`/document-inbox/${loose.id}/file`, { patient_id: other.id })).status, 409, 'filed once');
  assert.equal((await api.post(`/document-inbox/${wrong.id}/file`, { patient_id: stranger.patient.id })).status, 404);
  assert.equal((await client('dmb_nope').post('/bridge/scan-inbox?filename=x.pdf', pdfWith('x'))).status, 401);
});

test('the bridge scans with a scanner command (fake scanner), builds one PDF from the pages and files it; scan folders too', async () => {
  const { api, patient, other } = await practice();
  const agent = (await api.post('/imaging/agents', { name: 'Op 1' })).data;
  const dir = mkdtempSync(join(tmpdir(), 'dm-bridge-scan-'));
  const scanFolder = join(dir, 'scans');
  mkdirSync(scanFolder);
  // A stand-in scanner: writes two JPEG pages into {dir} and records the options it was given.
  const fake = `const fs=require('fs');const [dir,dpi,color,source,duplex]=process.argv.slice(1);
const jpg=(w,h)=>Buffer.from([0xff,0xd8,0xff,0xc0,0,17,8,h>>8,h&255,w>>8,w&255,3,1,0x22,0,2,0x11,1,3,0x11,1,0xff,0xd9]);
fs.writeFileSync(dir+'/page-001.jpg',jpg(2550,3300));fs.writeFileSync(dir+'/page-002.jpg',jpg(2550,3300));
fs.writeFileSync(${JSON.stringify(join(dir, 'options.txt'))},[dpi,color,source,duplex].join('|'));`;
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    server: h.origin, token: agent.token, scanSeconds: 0.3,
    scanner: { driver: 'command', name: 'Test scanner', command: process.execPath, args: ['-e', fake, '{dir}', '{dpi}', '{color}', '{source}', '{duplex}'], duplex: true },
    scanFolders: [{ folder: scanFolder }],
  }));
  const proc = spawn(process.execPath, [agentPath, join(dir, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  try {
    const scanners = await waitFor(async () => {
      const list = (await api.get('/scanners')).data;
      return list[0]?.online ? list : null;
    });
    assert.equal(scanners[0].scanner, 'Test scanner');
    const job = (await api.post(`/patients/${patient.id}/scan`, { agent_id: agent.id, source: 'feeder', duplex: true, color: 'color', dpi: 300, name: 'Referral from Dr Smith' })).data;
    const done = await waitFor(async () => {
      const s = (await api.get(`/scans/${job.id}`)).data;
      return ['done', 'error'].includes(s.status) ? s : null;
    }, 20_000).catch((e) => { throw new Error(`${e.message}\n${out}`); });
    assert.equal(done.status, 'done', `${done.result}\n${out}`);
    assert.match(done.result, /Scanned 2 pages/);
    assert.equal(readFileSync(join(dir, 'options.txt'), 'utf8'), '300|color|feeder|1');
    assert.equal(done.documents.length, 1);
    assert.equal(done.documents[0].mime, 'application/pdf');
    assert.equal(done.documents[0].filename, 'Referral from Dr Smith.pdf');
    const pdf = (await api.get(`/documents/${done.documents[0].id}/file`)).data;
    assert.match(pdf.toString('latin1'), /\/Count 2/);
    assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 612\.00 792\.00\]/, 'a 300 dpi letter page is a letter page');
    // A scan folder: a named file goes to that chart, an unnamed one to the inbox; both leave the folder alone.
    writeFileSync(join(scanFolder, `P${other.id}_insurance card.pdf`), pdfWith('Member ID 9'));
    writeFileSync(join(scanFolder, 'Scan_20260924.pdf'), pdfWith('Loose page'));
    await waitFor(async () => (await api.get('/document-inbox')).data.length === 1 && (await api.get(`/patients/${other.id}/documents`)).data.length === 1);
    assert.ok(existsSync(join(scanFolder, 'Scan_20260924.pdf')));
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(readdirSync(tmpdir()).every((f) => !f.startsWith(`dm-scan-`) || true));
});

test('the WIA script embedded in the bridge is the same as installer/scan.ps1', () => {
  const src = readFileSync(agentPath, 'utf8');
  const embedded = /\/\/ BEGIN scan\.ps1\nfunction embeddedScanPs1\(\) \{\n {2}return String\.raw`([\s\S]*)`;\n\}\n\/\/ END scan\.ps1/.exec(src)?.[1];
  assert.ok(embedded, 'embedded copy found');
  assert.equal(embedded, readFileSync(join(here, '../../bridge/installer/scan.ps1'), 'utf8'));
  const presets = JSON.parse(readFileSync(join(here, '../../bridge/presets.json'), 'utf8')).scanPresets;
  assert.ok(presets.some((p) => p.id === 'scansnap' && p.type === 'folder'));
  for (const p of presets) assert.match(p.comment, /^Known: /, p.id);
});

// ---- The phone scanner's image processing and the browser-side PDF/TIFF code (plain modules, run here) ----
const clientDocs = join(here, '../../client/src/components/docs');
test('phone scanning: the page is found in a photo, straightened, de-skewed and cleaned up', async () => {
  const { findDocumentQuad, processPage, estimateSkew, rotate, rotate90 } = await import(join(clientDocs, 'docscan.js'));
  // A dark desk with a lighter, tilted page on it (text lines inside its margins).
  const W = 800; const H = 600;
  const img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const quad = [[180, 90], [640, 120], [610, 540], [150, 500]];
  const inside = (x, y) => quad.every((a, i) => { const b = quad[(i + 1) % 4]; return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= 0; });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const v = inside(x, y) ? (y > 150 && y < 460 && x > 230 && x < 560 && y % 18 < 4 && x % 40 < 34 ? 30 : 220 - (x / W) * 50) : 60 + ((x * 7 + y * 3) % 20);
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  const found = findDocumentQuad(img);
  assert.equal(found.found, true);
  found.quad.forEach(([x, y], i) => assert.ok(Math.hypot(x - quad[i][0], y - quad[i][1]) < 15, `corner ${i}: ${x},${y} vs ${quad[i]}`));
  const page = processPage(img, found.quad, { mode: 'gray' });
  assert.ok(page.width > 400 && page.height > 380, `${page.width}x${page.height}`);
  // The uneven lighting is evened out: the paper comes out near white across the page.
  const at = (x, y) => page.data[(y * page.width + x) * 4];
  assert.ok(at(10, 10) > 200 && at(page.width - 10, 10) > 200, `${at(10, 10)} ${at(page.width - 10, 10)}`);
  const bw = processPage(img, found.quad, { mode: 'bw' });
  assert.ok([0, 255].includes(bw.data[0]) && [0, 255].includes(bw.data[(bw.width * 200 + 200) * 4]));
  // A white page on a white desk: nothing found, and the corners start at the picture's edges for dragging.
  const blank = { width: 100, height: 80, data: new Uint8ClampedArray(100 * 80 * 4).fill(240) };
  assert.equal(findDocumentQuad(blank).found, false);
  // Tilted lines are straightened.
  const lines = { width: 400, height: 300, data: new Uint8ClampedArray(400 * 300 * 4).fill(255) };
  for (let y = 20; y < 300; y += 25) for (let yy = y; yy < y + 3; yy++) for (let x = 40; x < 360; x++) lines.data.fill(0, (yy * 400 + x) * 4, (yy * 400 + x) * 4 + 3);
  const tilted = rotate(lines, 3);
  assert.equal(Math.abs(estimateSkew(tilted)), 3);
  assert.equal(estimateSkew(rotate(tilted, estimateSkew(tilted))), 0);
  const turned = rotate90({ width: 2, height: 1, data: new Uint8ClampedArray([1, 1, 1, 255, 2, 2, 2, 255]) });
  assert.deepEqual([turned.width, turned.height, turned.data[0], turned.data[4]], [1, 2, 1, 2]);
});

test('browser-made PDFs (phone pages) and TIFF previews', async () => {
  const { jpegsToPdf, jpegInfo } = await import(join(clientDocs, 'pdfmake.js'));
  assert.deepEqual(jpegInfo(jpeg(640, 480)), { width: 640, height: 480, components: 3 });
  const pdf = Buffer.from(jpegsToPdf([jpeg(1700, 2200), jpeg(1700, 2200)]));
  assert.equal(classify(pdf, 'scan.pdf').mime, 'application/pdf');
  assert.match(pdf.toString('latin1'), /\/Count 2/);
  assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 612\.00 792\.00\]/);
  assert.throws(() => jpegsToPdf([png()]));
  const { decodeTiff, UnsupportedTiff } = await import(join(clientDocs, 'tiff.js'));
  // Two 4×2 grey pages, uncompressed then PackBits.
  const tiff = (pages) => {
    const parts = [Buffer.from('II*\0'), Buffer.alloc(4)];
    let offset = 8;
    const ifds = [];
    for (const [compression, data] of pages) {
      parts.push(data);
      const dataAt = offset;
      offset += data.length;
      ifds.push({ compression, dataAt, len: data.length });
    }
    let ifdAt = offset;
    parts[1].writeUInt32LE(ifdAt);
    ifds.forEach((f, i) => {
      const tags = [[256, 3, 4], [257, 3, 2], [258, 3, 8], [259, 3, f.compression], [262, 3, 1], [273, 4, f.dataAt], [277, 3, 1], [278, 3, 2], [279, 4, f.len]];
      const b = Buffer.alloc(2 + tags.length * 12 + 4);
      b.writeUInt16LE(tags.length);
      tags.forEach(([tag, type, v], j) => { b.writeUInt16LE(tag, 2 + j * 12); b.writeUInt16LE(type, 4 + j * 12); b.writeUInt32LE(1, 6 + j * 12); if (type === 3) b.writeUInt16LE(v, 10 + j * 12); else b.writeUInt32LE(v, 10 + j * 12); });
      const next = i < ifds.length - 1 ? ifdAt + b.length : 0;
      b.writeUInt32LE(next, 2 + tags.length * 12);
      parts.push(b);
      ifdAt += b.length;
    });
    const buf = Buffer.concat(parts);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  };
  const pages = await decodeTiff(tiff([[1, Buffer.from([0, 50, 100, 150, 200, 250, 255, 10])], [32773, Buffer.from([0xf9, 77])]]));
  assert.equal(pages.length, 2);
  assert.deepEqual([pages[0].width, pages[0].height, pages[0].data[4], pages[0].data[7]], [4, 2, 50, 255]);
  assert.ok(pages[1].data.every((v, i) => (i % 4 === 3 ? v === 255 : v === 77)), 'PackBits run of 8');
  await assert.rejects(decodeTiff(tiff([[4, Buffer.alloc(8)]])), UnsupportedTiff, 'fax (G4) TIFFs say so, and the viewer offers the download');
});
