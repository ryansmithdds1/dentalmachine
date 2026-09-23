import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { harness } from './helpers.js';
import { buildDicom } from '../src/dicom.js';
import { dicomToImage, parseDicom } from '../src/dicomimage.js';

const h = harness();

// 4x2 16-bit ramp with 12 bits stored.
const pixels16 = () => { const b = Buffer.alloc(16); [0, 500, 1000, 1500, 2000, 2500, 3000, 4095].forEach((v, i) => b.writeUInt16LE(v, i * 2)); return b; };
const pngPixels = (png) => {
  // Single IDAT, filter byte 0 per row (what our encoder writes).
  const w = png.readUInt32BE(16); const hgt = png.readUInt32BE(20);
  const idat = png.indexOf('IDAT');
  const len = png.readUInt32BE(idat - 4);
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + len));
  const out = [];
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) out.push(raw[y * (w + 1) + 1 + x]);
  return { w, hgt, out };
};

test('DICOM decoding: 16-bit grayscale to PNG, window/level, MONOCHROME1, pixel spacing, sequences skipped', () => {
  const dcm = buildDicom({ patientId: 'P1', pixels: pixels16(), image: { rows: 2, columns: 4, spacing: 0.02 } });
  const d = parseDicom(dcm);
  assert.deepEqual([d.rows, d.columns, d.bitsAllocated, d.pixelSpacing[0]], [2, 4, 16, 0.02]);
  const img = dicomToImage(dcm);
  assert.equal(img.mime, 'image/png');
  const { w, hgt, out } = pngPixels(img.data);
  assert.deepEqual([w, hgt], [4, 2]);
  assert.equal(out[0], 0);
  assert.equal(out[7], 255);
  assert.ok(out[3] > out[2] && out[2] > out[1]);
  const inv = pngPixels(dicomToImage(buildDicom({ patientId: 'P1', pixels: pixels16(), image: { rows: 2, columns: 4, photometric: 'MONOCHROME1' } })).data).out;
  assert.equal(inv[0], 255);
  const win = pngPixels(dicomToImage(buildDicom({ patientId: 'P1', pixels: pixels16(), image: { rows: 2, columns: 4, window: [1000, 1000] } })).data).out;
  assert.deepEqual([win[0], win[1], win[5]], [0, 0, 255]); // below/above the window clip
  assert.equal(dicomToImage(Buffer.from('not dicom')), null);
});

test('viewer: DICOM served as an image, annotations saved, mounts hold the patient’s images', async () => {
  const { api, patient, token } = await h.practice();
  const other = (await api.post('/patients', { first_name: 'O', last_name: 'Ther' })).data;
  const up = async (pt, body, name) => (await (await fetch(`${h.origin}/api/patients/${pt}/documents?filename=${name}&category=xray`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/dicom' }, body })).json());
  const dcm = await up(patient.id, buildDicom({ patientId: 'P1', pixels: pixels16(), image: { rows: 2, columns: 4, spacing: 0.02 } }), 'bw.dcm');
  const theirs = await up(other.id, buildDicom({ patientId: 'P2', pixels: pixels16(), image: { rows: 2, columns: 4 } }), 'x.dcm');
  const img = await fetch(`${h.origin}/api/documents/${dcm.id}/image`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  let v = (await api.get(`/documents/${dcm.id}/viewer`)).data;
  assert.deepEqual([v.mm_per_px, v.scale_source, v.annotations.length], [0.02, 'dicom', 0]);

  assert.equal((await api.put(`/documents/${dcm.id}/annotations`, { annotations: [{ type: 'laser', points: [[0, 0]] }] })).status, 400);
  const saved = await api.put(`/documents/${dcm.id}/annotations`, { annotations: [{ type: 'measure', points: [[0, 0], [3, 1]] }, { type: 'text', points: [[1, 1]], text: 'Caries?' }], mm_per_px: 0.025 });
  assert.equal(saved.status, 200);
  v = (await api.get(`/documents/${dcm.id}/viewer`)).data;
  assert.deepEqual([v.annotations.length, v.mm_per_px, v.scale_source], [2, 0.025, 'calibrated']);
  assert.equal((await api.get(`/patients/${patient.id}/documents`)).data[0].annotated, 1);

  const m = (await api.post(`/patients/${patient.id}/mounts`, { template: 'bw4' })).data;
  assert.equal((await api.post(`/patients/${patient.id}/mounts`, { template: 'huge' })).status, 400);
  assert.equal((await api.put(`/mounts/${m.id}`, { slots: { 0: dcm.id } })).data.slots[0], dcm.id);
  assert.equal((await api.put(`/mounts/${m.id}`, { slots: { 1: theirs.id } })).status, 404);
  assert.equal((await api.put(`/mounts/${m.id}`, { slots: { 9: dcm.id } })).status, 400);
  assert.equal((await api.get(`/patients/${patient.id}/mounts`)).data.length, 1);
});
