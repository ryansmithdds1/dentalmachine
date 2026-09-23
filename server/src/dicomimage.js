import { deflateSync } from 'node:zlib';

// Turns a DICOM image (what intraoral sensors, pans and CBCT slices export) into something a browser
// can show: uncompressed 8/16-bit grayscale or RGB becomes a PNG (window/level and rescale applied,
// MONOCHROME1 inverted); baseline-JPEG DICOM is handed back as its JPEG. Also reports pixel spacing,
// so measurements can be in millimetres.

const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const TS = { implicit: '1.2.840.10008.1.2', explicit: '1.2.840.10008.1.2.1', jpegBaseline: '1.2.840.10008.1.2.4.50', jpegExtended: '1.2.840.10008.1.2.4.51' };
const tagOf = (g, e) => g.toString(16).padStart(4, '0') + e.toString(16).padStart(4, '0');
const UNDEFINED = 0xffffffff;

// Walks the dataset. Sequences (nested items, defined or undefined length) are skipped over properly.
export function parseDicom(buf) {
  if (!(buf.length > 132 && buf.toString('latin1', 128, 132) === 'DICM')) return null;
  const el = {};
  let transfer = TS.explicit;
  let pos = 132;
  let explicit = true;

  const readHeader = (p, useExplicit) => {
    const group = buf.readUInt16LE(p);
    const element = buf.readUInt16LE(p + 2);
    if (group === 0xfffe) return { group, element, vr: null, len: buf.readUInt32LE(p + 4), header: 8 };
    if (useExplicit) {
      const vr = buf.toString('latin1', p + 4, p + 6);
      if (LONG_VR.has(vr)) return { group, element, vr, len: buf.readUInt32LE(p + 8), header: 12 };
      return { group, element, vr, len: buf.readUInt16LE(p + 6), header: 8 };
    }
    return { group, element, vr: null, len: buf.readUInt32LE(p + 4), header: 8 };
  };
  // Returns the position just past an undefined-length sequence or item.
  const skipUndefined = (p, useExplicit, endElement) => {
    while (p + 8 <= buf.length) {
      const h = readHeader(p, useExplicit);
      p += h.header;
      if (h.group === 0xfffe && h.element === endElement) return p;
      if (h.group === 0xfffe && h.element === 0xe000) { // item
        p = h.len === UNDEFINED ? skipUndefined(p, useExplicit, 0xe00d) : p + h.len;
        continue;
      }
      if (h.len === UNDEFINED) p = skipUndefined(p, useExplicit, 0xe0dd);
      else p += h.len;
    }
    return p;
  };

  while (pos + 8 <= buf.length) {
    const group = buf.readUInt16LE(pos);
    const isMeta = group === 0x0002;
    const h = readHeader(pos, isMeta || explicit);
    const tag = tagOf(h.group, h.element);
    const start = pos + h.header;
    if (tag === '7fe00010') {
      if (h.len === UNDEFINED) {
        // Encapsulated (compressed): an offset table item, then one fragment per frame part.
        const frags = [];
        let p = start;
        while (p + 8 <= buf.length) {
          const ih = readHeader(p, false);
          p += 8;
          if (ih.element === 0xe0dd) break;
          frags.push(buf.subarray(p, p + ih.len));
          p += ih.len;
        }
        el.pixelFragments = frags.slice(1);
      } else {
        el.pixelData = buf.subarray(start, start + h.len);
      }
      break;
    }
    if (h.len === UNDEFINED) {
      pos = skipUndefined(start, isMeta || explicit, 0xe0dd);
    } else {
      if (h.vr !== 'SQ') el[tag] = buf.subarray(start, start + h.len);
      pos = start + h.len;
    }
    if (tag === '00020010') {
      transfer = buf.toString('latin1', start, start + h.len).replace(/\0/g, '').trim();
      explicit = transfer !== TS.implicit;
    }
  }
  const us = (t) => (el[t] && el[t].length >= 2 ? el[t].readUInt16LE(0) : null);
  const str = (t) => (el[t] ? el[t].toString('latin1').replace(/\0/g, '').trim() : null);
  const num = (t) => (str(t) ? Number(str(t).split('\\')[0]) : null);
  const spacing = str('00280030') || str('00181164');
  return {
    transfer,
    rows: us('00280010'), columns: us('00280011'), bitsAllocated: us('00280100') || 16, bitsStored: us('00280101'),
    signed: us('00280103') === 1, samples: us('00280002') || 1, planar: us('00280006') || 0,
    photometric: str('00280004') || 'MONOCHROME2',
    windowCenter: num('00281050'), windowWidth: num('00281051'),
    slope: num('00281053') ?? 1, intercept: num('00281052') ?? 0,
    // Row spacing \ column spacing, in mm.
    pixelSpacing: spacing ? spacing.split('\\').map(Number).filter((x) => x > 0) : null,
    pixelData: el.pixelData || null, pixelFragments: el.pixelFragments || null,
  };
}

// ---- PNG writer (8-bit gray or RGB) ----
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(width, height, channels, pixels) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 3 ? 2 : 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// → { mime, data, width, height, pixelSpacing } or null when this kind of DICOM can't be shown.
export function dicomToImage(buf) {
  const d = parseDicom(buf);
  if (!d) return null;
  const meta = { width: d.columns, height: d.rows, pixelSpacing: d.pixelSpacing };
  if ([TS.jpegBaseline, TS.jpegExtended].includes(d.transfer) && d.pixelFragments?.length) {
    return { ...meta, mime: 'image/jpeg', data: Buffer.concat(d.pixelFragments) };
  }
  if (![TS.implicit, TS.explicit].includes(d.transfer) || !d.pixelData || !d.rows || !d.columns) return null;
  const n = d.rows * d.columns;
  if (d.samples === 3 && d.bitsAllocated === 8) {
    const rgb = Buffer.alloc(n * 3);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = d.planar ? d.pixelData[c * n + i] : d.pixelData[i * 3 + c];
    }
    return { ...meta, mime: 'image/png', data: encodePng(d.columns, d.rows, 3, rgb) };
  }
  if (d.samples !== 1 || ![8, 16].includes(d.bitsAllocated)) return null;
  const values = new Float64Array(n);
  const mask = d.bitsStored && d.bitsStored < d.bitsAllocated ? (1 << d.bitsStored) - 1 : null;
  for (let i = 0; i < n; i++) {
    let v;
    if (d.bitsAllocated === 8) v = d.pixelData[i];
    else if (i * 2 + 1 < d.pixelData.length) {
      v = d.signed ? d.pixelData.readInt16LE(i * 2) : d.pixelData.readUInt16LE(i * 2);
      if (mask && !d.signed) v &= mask;
    } else v = 0;
    values[i] = v * d.slope + d.intercept;
  }
  let lo;
  let hi;
  if (d.windowWidth > 1 && d.windowCenter != null) {
    lo = d.windowCenter - d.windowWidth / 2;
    hi = d.windowCenter + d.windowWidth / 2;
  } else {
    // No window given: stretch between the 0.5th and 99.5th percentiles, so a few hot pixels don't wash it out.
    const sorted = Float64Array.from(values).sort();
    lo = sorted[Math.floor(n * 0.005)];
    hi = sorted[Math.min(n - 1, Math.ceil(n * 0.995))];
    if (hi <= lo) { lo = sorted[0]; hi = sorted[n - 1] || lo + 1; }
  }
  const invert = d.photometric === 'MONOCHROME1';
  const gray = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(1, (values[i] - lo) / (hi - lo || 1)));
    gray[i] = Math.round((invert ? 1 - t : t) * 255);
  }
  return { ...meta, mime: 'image/png', data: encodePng(d.columns, d.rows, 1, gray) };
}
