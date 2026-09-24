// CBCT volumes and 3D scans: series reading (slice order, spacing), the binary volume, meshes, and the
// routes' tenant isolation, permissions and audit trail. The router is mounted on a small app of its own
// here (with the real sign-in check), on the shared test database.
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import express from 'express';
import { harness } from './helpers.js';
import { authenticate, HttpError } from '../src/auth.js';
import { createStorage } from '../src/storage.js';
import { insert } from '../src/util.js';
import { encodePng } from '../src/dicomimage.js';
import { zip } from '../src/recordexport.js';
import volumeRoutes from '../src/routes/volumes.js';
import {
  analyzeSeries, seriesFiles, decodeVolume, encodeVolume, decodeVolumeBuffer, readZip, readGeometry, meshFormat, meshParts,
  sniffScanMime, inspectUpload, jawOf,
} from '../src/volume.js';
import { makeSeries, zipSeries, makeMultiframe, tetraStl, archStl, asciiStl, plyText, objText } from './volumefixtures.js';

const h = harness();
let storage;
let server;
let origin;
const dir = mkdtempSync(join(tmpdir(), 'dm-volume-'));
// Started on first use, once the shared harness (database, sign-in) is up.
let started = null;
const ready = () => (started ??= (async () => {
  storage = createStorage({ dir, key: 'volume-test-key', s3: null });
  const app = express();
  app.use('/api', authenticate(h.db, 'test-secret'), volumeRoutes({ db: h.db, storage }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
})());
after(() => { server?.close(); rmSync(dir, { recursive: true, force: true }); });

const call = async (token, method, path, body, headers = {}) => {
  const res = await fetch(`${origin}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, headers: res.headers, buf, json };
};
// Documents are put in place directly (the upload route belongs to documents.js), stored encrypted.
async function addDoc(p, data, { mime, filename, category = 'xray' }) {
  const saved = await storage.save(p.practiceId, data);
  return insert(h.db, 'documents', { practice_id: p.practiceId, patient_id: p.patient.id, category, filename, mime, size: data.length, storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0 });
}

// ---- Series reading ----
test('a shuffled series is put in order by ImagePositionPatient, not file order or instance number', () => {
  const files = makeSeries();
  const m = analyzeSeries(files.map((f) => ({ name: f.name, read: () => f.data })));
  assert.deepEqual(m.dims, [32, 32, 24]);
  // Pixel Spacing is row\column: x is the column spacing.
  assert.deepEqual(m.spacing, [0.25, 0.3, 0.5]);
  assert.equal(m.units, 'HU');
  assert.equal(m.slices.length, 24);
  const zs = m.slices.map((s) => s.z);
  assert.deepEqual(zs, [...zs].sort((a, b) => a - b));
  assert.equal(zs[0], -10);
  assert.equal(m.slices[0].name, files.find((f) => f.z === 0).name);
  assert.deepEqual(m.warnings, []);
});

test('the volume decodes to HU in slice order; the binary form round-trips', async () => {
  const data = zipSeries(makeSeries());
  const m = analyzeSeries(seriesFiles(data));
  const v = await decodeVolume(data, m);
  const [nx, ny, nz] = v.header.dims;
  assert.deepEqual([nx, ny, nz], [32, 32, 24]);
  assert.equal(v.data.length, nx * ny * nz);
  for (let z = 0; z < nz; z++) assert.equal(v.data[z * nx * ny], z * 10, `slice ${z} is in place`);
  assert.equal(v.data[12 * nx * ny + 16 * nx + 16], 1000); // inside the sphere
  assert.equal(v.data[12 * nx * ny + 2 * nx + 30], -1000); // air
  assert.equal(v.header.stats.min, -1000);
  assert.equal(v.header.stats.max, 1000);
  const round = decodeVolumeBuffer(encodeVolume(v));
  assert.deepEqual(round.header.dims, [32, 32, 24]);
  assert.deepEqual(Array.from(round.data.subarray(0, 64)), Array.from(v.data.subarray(0, 64)));
  const raw = encodeVolume(v);
  assert.equal(raw.toString('latin1', 0, 6), 'DMVOL1');
  assert.equal(raw.readUInt32LE(8) % 8, 0);
  assert.equal(raw.length, raw.readUInt32LE(8) + 32 * 32 * 24 * 2);
});

test('large volumes are box-averaged down and the spacing grows to match', async () => {
  const data = zipSeries(makeSeries());
  const v = await decodeVolume(data, analyzeSeries(seriesFiles(data)), { max: 16 });
  assert.deepEqual(v.header.dims, [16, 16, 12]);
  assert.deepEqual(v.header.spacing, [0.5, 0.6, 1]);
  assert.equal(v.header.step, 2);
  assert.equal(v.data[6 * 256 + 8 * 16 + 8], 1000);
});

test('without positions, slices fall back to instance number, with a warning', () => {
  const files = makeSeries({ positions: false });
  const m = analyzeSeries(files.map((f) => ({ name: f.name, read: () => f.data })));
  assert.match(m.warnings.join(' '), /instance number/);
  // Instance numbers run backwards in the fixture, so the first slice is the top one.
  assert.equal(m.slices[0].name, files.find((f) => f.z === 23).name);
  assert.equal(m.spacing[2], 0.5); // from Slice Thickness
});

test('duplicates are dropped, a gap is flagged, mixed patients and non-DICOM zips are refused', () => {
  const files = makeSeries();
  const dup = [...files, { ...files[3], name: 'copy.dcm' }].map((f) => ({ name: f.name, read: () => f.data }));
  assert.match(analyzeSeries(dup).warnings.join(' '), /duplicate/);
  const gap = files.filter((f) => f.z !== 10).map((f) => ({ name: f.name, read: () => f.data }));
  assert.match(analyzeSeries(gap).warnings.join(' '), /not evenly spaced/);
  const other = makeSeries({ patientId: 'SOMEONE-ELSE' })[0];
  assert.throws(() => analyzeSeries([...files, { ...other, name: 'x.dcm' }].map((f) => ({ name: f.name, read: () => f.data }))), (e) => e.status === 422);
  assert.throws(() => analyzeSeries(seriesFiles(zip([{ name: 'readme.md', data: 'hello' }]))), (e) => e.status === 415);
});

test('a multi-frame DICOM is a volume too, spaced by Spacing Between Slices', async () => {
  const buf = makeMultiframe();
  assert.equal(readGeometry(buf).frames, 6);
  const m = analyzeSeries(seriesFiles(buf));
  assert.deepEqual(m.dims, [16, 16, 6]);
  assert.deepEqual(m.spacing, [0.4, 0.4, 0.4]);
  const v = await decodeVolume(buf, m);
  assert.equal(v.data[5 * 256], 500); // frame 5: stored 1000 + 500, intercept -1000
});

test('zip reader: rejects a lying size (zip bomb) and a damaged file', () => {
  const good = zip([{ name: 'a.dcm', data: Buffer.alloc(100000, 7) }]);
  const e = readZip(good)[0];
  assert.equal(e.read().length, 100000);
  const lying = Buffer.from(good);
  const cd = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lying.writeUInt32LE(10, cd + 24); // central directory claims 10 bytes
  assert.throws(() => readZip(lying)[0].read(), (err) => err.status === 415);
  assert.throws(() => readZip(good.subarray(0, 40)), (err) => err.status === 415);
});

// ---- Meshes ----
test('scan formats are recognised from their contents', () => {
  assert.equal(meshFormat(tetraStl()), 'stl');
  assert.equal(meshFormat(Buffer.from(asciiStl())), 'stl');
  assert.equal(meshFormat(Buffer.from(plyText())), 'ply');
  assert.equal(meshFormat(Buffer.from(objText()), 'scan.obj'), 'obj');
  assert.equal(meshFormat(Buffer.from(objText()), 'notes.txt'), null);
  assert.equal(meshFormat(Buffer.from('just some text, nothing 3D here')), null);
  assert.equal(sniffScanMime(tetraStl(), 'x.stl'), 'model/stl');
  assert.equal(sniffScanMime(zipSeries(makeSeries({ nz: 2 }))), 'application/zip');
  assert.equal(jawOf('UpperJaw.stl'), 'upper');
  assert.equal(jawOf('mandibular_scan.ply'), 'lower');
  const pair = zip([{ name: 'export/UpperJaw.stl', data: archStl({ upper: true }) }, { name: 'export/LowerJaw.stl', data: archStl() }]);
  const parts = meshParts(pair);
  assert.deepEqual(parts.map((p) => [p.name, p.format, p.jaw]), [['UpperJaw.stl', 'stl', 'upper'], ['LowerJaw.stl', 'stl', 'lower']]);
  assert.equal(inspectUpload(pair).kind, 'mesh');
  const cbct = inspectUpload(zipSeries(makeSeries()));
  assert.equal(cbct.kind, 'volume');
  assert.deepEqual(cbct.manifest.dims, [32, 32, 24]);
  assert.equal(inspectUpload(Buffer.from('%PDF-1.4')), null);
});

// ---- Routes ----
test('volume routes: practice-scoped, need clinical:read, audited as an image view', async () => {
  await ready();
  const a = await h.practice();
  const b = await h.practice();
  const cbct = await addDoc(a, zipSeries(makeSeries()), { mime: 'application/zip', filename: 'cbct.zip' });

  const kind = await call(a.token, 'GET', `/documents/${cbct}/view3d`);
  assert.equal(kind.status, 200);
  assert.equal(kind.json.kind, 'volume');
  assert.deepEqual(kind.json.dims, [32, 32, 24]);
  assert.equal(kind.json.slices, 24);

  const vol = await call(a.token, 'GET', `/documents/${cbct}/volume`);
  assert.equal(vol.status, 200);
  assert.equal(vol.headers.get('content-type'), 'application/octet-stream');
  assert.equal(vol.headers.get('cache-control'), 'no-store');
  const v = decodeVolumeBuffer(vol.buf); // fetch has already undone the gzip
  assert.deepEqual(v.header.dims, [32, 32, 24]);
  assert.deepEqual(v.header.spacing, [0.25, 0.3, 0.5]);
  assert.equal(v.data.length, 32 * 32 * 24);
  assert.equal(v.data[12 * 1024 + 16 * 32 + 16], 1000);

  assert.equal((await call(a.token, 'GET', `/documents/${cbct}/volume?max=5`)).status, 400);

  const log = await h.db.all("SELECT * FROM audit_log WHERE action = 'document.view' AND entity_id = ?", cbct);
  assert.ok(log.length >= 1);
  assert.equal(JSON.parse(log[0].details).view, 'volume');
  assert.equal(log[0].patient_id, a.patient.id);

  // Another practice can't see it; a person without clinical:read can't either.
  assert.equal((await call(b.token, 'GET', `/documents/${cbct}/volume`)).status, 404);
  assert.equal((await call(b.token, 'GET', `/documents/${cbct}/view3d`)).status, 404);
  const staff = (await a.api.post('/users', { email: `nc-${Date.now()}@example.com`, name: 'No Clinical', role: 'billing', password: 'correct-horse-battery' })).data;
  await a.api.put(`/users/${staff.id}`, { permissions_remove: ['clinical:read'] });
  const login = await h.client().post('/auth/login', { email: staff.email, password: 'correct-horse-battery' });
  assert.equal((await call(login.data.token, 'GET', `/documents/${cbct}/volume`)).status, 403);
  assert.equal((await call('not-a-token', 'GET', `/documents/${cbct}/volume`)).status, 401);

  // Removed documents are gone; a single-frame DICOM is not a volume.
  await h.db.run("UPDATE documents SET deleted_at = datetime('now') WHERE id = ?", cbct);
  assert.equal((await call(a.token, 'GET', `/documents/${cbct}/volume`)).status, 404);
  const single = await addDoc(a, makeSeries({ nz: 1 })[0].data, { mime: 'application/dicom', filename: 'pa.dcm' });
  assert.equal((await call(a.token, 'GET', `/documents/${single}/volume`)).status, 415);
  const pdf = await addDoc(a, Buffer.from('%PDF-1.4'), { mime: 'application/pdf', filename: 'x.pdf', category: 'document' });
  assert.equal((await call(a.token, 'GET', `/documents/${pdf}/view3d`)).status, 415);
});

test('mesh routes: parts of an upper/lower zip, bytes of each, snapshot saved as a new document', async () => {
  await ready();
  const a = await h.practice();
  const b = await h.practice();
  const pair = zip([{ name: 'UpperJaw.stl', data: archStl({ upper: true }) }, { name: 'LowerJaw.stl', data: tetraStl() }]);
  const scan = await addDoc(a, pair, { mime: 'application/zip', filename: 'scan.zip', category: 'photo' });
  const kind = await call(a.token, 'GET', `/documents/${scan}/view3d`);
  assert.equal(kind.json.kind, 'mesh');
  assert.deepEqual(kind.json.parts.map((p) => p.jaw), ['upper', 'lower']);
  const lower = await call(a.token, 'GET', `/documents/${scan}/mesh?part=1`);
  assert.equal(lower.status, 200);
  assert.equal(lower.headers.get('x-mesh-format'), 'stl');
  assert.ok(lower.buf.equals(tetraStl()));
  assert.equal((await call(a.token, 'GET', `/documents/${scan}/mesh?part=7`)).status, 404);
  assert.equal((await call(b.token, 'GET', `/documents/${scan}/mesh`)).status, 404);
  // An ASCII STL stored as text (how uploads keep them today) opens too.
  const text = await addDoc(a, Buffer.from(asciiStl()), { mime: 'text/plain', filename: 'model.stl', category: 'document' });
  assert.equal((await call(a.token, 'GET', `/documents/${text}/mesh/parts`)).json.parts[0].format, 'stl');
  // Big files go gzipped on the wire (fetch unpacks them); the bytes are the scan's own.
  const upper = await call(a.token, 'GET', `/documents/${scan}/mesh?part=0`, undefined, { 'Accept-Encoding': 'gzip' });
  assert.equal(upper.headers.get('content-encoding'), 'gzip');
  assert.ok(upper.buf.equals(archStl({ upper: true })));

  const png = encodePng(4, 4, 1, Buffer.alloc(16, 200));
  const snap = await call(a.token, 'POST', `/documents/${scan}/snapshot?view=Occlusal`, png, { 'Content-Type': 'image/png' });
  assert.equal(snap.status, 201);
  assert.equal(snap.json.mime, 'image/png');
  assert.equal(snap.json.category, 'photo');
  assert.match(snap.json.notes, /Snapshot from scan\.zip \(Occlusal\)/);
  const row = await h.db.get('SELECT * FROM documents WHERE id = ?', snap.json.id);
  assert.equal(row.patient_id, a.patient.id);
  assert.ok(row.encrypted);
  assert.ok((await storage.read(row.storage_key, true)).equals(png));
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'document.snapshot' AND entity_id = ?", snap.json.id));
  assert.equal((await call(a.token, 'POST', `/documents/${scan}/snapshot`, Buffer.from('not a png'), { 'Content-Type': 'image/png' })).status, 400);
  assert.equal((await call(b.token, 'POST', `/documents/${scan}/snapshot`, png, { 'Content-Type': 'image/png' })).status, 404);
  // Saving needs clinical:write (front desk can look, not add).
  const desk = (await a.api.post('/users', { email: `fd-${Date.now()}@example.com`, name: 'Desk', role: 'front_desk', password: 'correct-horse-battery' })).data;
  const login = await h.client().post('/auth/login', { email: desk.email, password: 'correct-horse-battery' });
  assert.equal((await call(login.data.token, 'GET', `/documents/${scan}/mesh`)).status, 200);
  assert.equal((await call(login.data.token, 'POST', `/documents/${scan}/snapshot`, png, { 'Content-Type': 'image/png' })).status, 403);
});
