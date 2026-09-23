import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { harness } from './helpers.js';
import { decodePng, jpegExifThumb, imageSize, makeThumbnail } from '../src/thumbnails.js';
import { encodePng } from '../src/dicomimage.js';

const h = harness();

const crc = (() => {
  const t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  return (b) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
// An RGB PNG using every row filter (like real encoders do), to check the decoder undoes them.
function filteredPng(w, h, pixel) {
  const bpp = 3;
  const rows = [];
  const px = (x, y) => (x < 0 || y < 0 ? [0, 0, 0] : pixel(x, y));
  for (let y = 0; y < h; y++) {
    const f = y % 5;
    const line = [f];
    for (let x = 0; x < w; x++) {
      const cur = px(x, y); const a = px(x - 1, y); const b = px(x, y - 1); const c = px(x - 1, y - 1);
      for (let k = 0; k < bpp; k++) {
        const p = a[k] + b[k] - c[k];
        const pr = Math.abs(p - a[k]) <= Math.abs(p - b[k]) && Math.abs(p - a[k]) <= Math.abs(p - c[k]) ? a[k] : Math.abs(p - b[k]) <= Math.abs(p - c[k]) ? b[k] : c[k];
        const pred = [0, a[k], b[k], (a[k] + b[k]) >> 1, pr][f];
        line.push((cur[k] - pred) & 0xff);
      }
    }
    rows.push(Buffer.from(line));
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const pixel = (x, y) => [(x * 7) & 0xff, (y * 5) & 0xff, (x * y) & 0xff];

// A JPEG whose EXIF block carries a thumbnail (IFD1 → JPEGInterchangeFormat).
function jpegWithExif(thumb) {
  const tiff = Buffer.alloc(8 + 2 + 4 + 2 + 24 + 4);
  tiff.write('II', 0); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(0, 8); tiff.writeUInt32LE(14, 10); // IFD0: no entries, IFD1 at 14
  tiff.writeUInt16LE(2, 14);
  const dataAt = tiff.length;
  [[0x0201, dataAt], [0x0202, thumb.length]].forEach(([tag, v], i) => { const e = 16 + i * 12; tiff.writeUInt16LE(tag, e); tiff.writeUInt16LE(4, e + 2); tiff.writeUInt32LE(1, e + 4); tiff.writeUInt32LE(v, e + 8); });
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, thumb]);
  const app1 = Buffer.alloc(4); app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, body, Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9])]);
}
const tinyJpeg = (w, hgt) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, hgt >> 8, hgt & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0, 0xff, 0xd9]);

test('thumbnails: PNG decoding undoes every filter; EXIF thumbnails are found; big images shrink', () => {
  const png = filteredPng(30, 20, pixel);
  const img = decodePng(png);
  assert.deepEqual([img.width, img.height, img.channels], [30, 20, 3]);
  for (const [x, y] of [[0, 0], [29, 19], [13, 7], [5, 18]]) assert.deepEqual([...img.pixels.subarray((y * 30 + x) * 3, (y * 30 + x) * 3 + 3)], pixel(x, y));

  const small = tinyJpeg(160, 120);
  assert.deepEqual(jpegExifThumb(jpegWithExif(small)), small);
  assert.equal(jpegExifThumb(tinyJpeg(4000, 3000)), null);
  assert.deepEqual(imageSize(small), { mime: 'image/jpeg', width: 160, height: 120 });

  const big = encodePng(1200, 900, 1, Buffer.alloc(1200 * 900, 128));
  const t = makeThumbnail('image/png', big);
  assert.equal(t.mime, 'image/png');
  assert.deepEqual(imageSize(t.data), { mime: 'image/png', width: 240, height: 180 });
  assert.ok(t.data.length < big.length);
});

test('documents: server thumbnails, browser-made previews for the rest, and editing details after upload', async () => {
  const { api, patient, token } = await h.practice();
  const raw = (path, opts = {}) => fetch(`${h.origin}/api${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  const upload = async (name, body, type) => {
    const res = await raw(`/patients/${patient.id}/documents?category=xray&filename=${name}`, { method: 'POST', headers: { 'Content-Type': type }, body });
    assert.equal(res.status, 201);
    return res.json();
  };

  const pngDoc = await upload('pan.png', encodePng(1000, 500, 3, Buffer.alloc(1000 * 500 * 3, 200)), 'image/png');
  const thumb = await raw(`/documents/${pngDoc.id}/thumb`);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/png');
  assert.deepEqual(imageSize(Buffer.from(await thumb.arrayBuffer())), { mime: 'image/png', width: 240, height: 120 });
  assert.ok((await h.db.get('SELECT thumb_key FROM documents WHERE id = ?', pngDoc.id)).thumb_key, 'made once and kept');

  // A JPEG with no embedded thumbnail: the browser makes one and sends it back.
  const jpgDoc = await upload('photo.jpg', tinyJpeg(3000, 2000), 'image/jpeg');
  const miss = await raw(`/documents/${jpgDoc.id}/thumb`);
  assert.equal(miss.status, 202);
  assert.equal((await miss.json()).client, true);
  assert.equal((await raw(`/documents/${jpgDoc.id}/thumb`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: tinyJpeg(3000, 2000) })).status, 400, 'too big for a preview');
  assert.equal((await raw(`/documents/${jpgDoc.id}/thumb`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'hello' })).status, 400);
  assert.equal((await raw(`/documents/${jpgDoc.id}/thumb`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: tinyJpeg(240, 160) })).status, 200);
  const served = await raw(`/documents/${jpgDoc.id}/thumb`);
  assert.deepEqual(imageSize(Buffer.from(await served.arrayBuffer())), { mime: 'image/jpeg', width: 240, height: 160 });

  // A phone photo with EXIF: its own thumbnail is used.
  const exifDoc = await upload('phone.jpg', jpegWithExif(tinyJpeg(160, 120)), 'image/jpeg');
  assert.equal((await raw(`/documents/${exifDoc.id}/thumb`)).status, 200);

  // Editing what was recorded at upload.
  const upd = await api.put(`/documents/${pngDoc.id}`, { category: 'photo', tooth: '19', taken_at: '2026-01-05', filename: 'Pano Jan', notes: 'Pre-op' });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  assert.deepEqual([upd.data.category, upd.data.tooth, upd.data.taken_at, upd.data.filename, upd.data.notes], ['photo', '19', '2026-01-05', 'Pano Jan', 'Pre-op']);
  assert.equal((await api.put(`/documents/${pngDoc.id}`, { tooth: '99' })).status, 400);
  assert.equal((await api.put(`/documents/${pngDoc.id}`, { category: 'selfie' })).status, 400);
  assert.equal((await api.put(`/documents/${pngDoc.id}`, { taken_at: 'yesterday' })).status, 400);
  assert.equal((await api.put(`/documents/${pngDoc.id}`, { tooth: '' })).data.tooth, null);
});
