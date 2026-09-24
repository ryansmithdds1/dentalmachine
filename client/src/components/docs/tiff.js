// A small TIFF reader so multi-page TIFFs (fax, older scanners, some x-ray exports) can be previewed in any
// browser (only Safari shows TIFF natively). Handles the common scanner output: uncompressed, LZW, PackBits and
// Deflate; 1-bit black-and-white, 8/16-bit grey, palette and RGB(A); strips (not tiles). Fax compression
// (CCITT G3/G4) and JPEG-in-TIFF throw "unsupported" and the viewer offers the download instead.

export class UnsupportedTiff extends Error {}

function lzw(input, expected) {
  const out = new Uint8Array(expected);
  let op = 0;
  let bitPos = 0;
  let width = 9;
  let table = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < 256; i++) table.push([i]);
    table.push(null, null); // 256 clear, 257 end
    width = 9;
  };
  const read = () => {
    let v = 0;
    for (let i = 0; i < width; i++) {
      const byte = input[(bitPos + i) >> 3];
      if (byte === undefined) return 257;
      v = (v << 1) | ((byte >> (7 - ((bitPos + i) & 7))) & 1);
    }
    bitPos += width;
    return v;
  };
  reset();
  let prev = null;
  for (;;) {
    const code = read();
    if (code === 257) break;
    if (code === 256) { reset(); prev = null; continue; }
    let entry;
    if (code < table.length && table[code]) entry = table[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    for (const b of entry) { if (op < expected) out[op++] = b; }
    if (prev) table.push([...prev, entry[0]]);
    prev = entry;
    // TIFF's "early change": the code width grows one code early.
    if (table.length + 1 >= 1 << width && width < 12) width++;
    if (op >= expected) break;
  }
  return out;
}

function packbits(input, expected) {
  const out = new Uint8Array(expected);
  let i = 0;
  let o = 0;
  while (i < input.length && o < expected) {
    const n = (input[i++] << 24) >> 24;
    if (n >= 0) { for (let k = 0; k <= n && o < expected; k++) out[o++] = input[i++]; } else if (n !== -128) {
      const v = input[i++];
      for (let k = 0; k < 1 - n && o < expected; k++) out[o++] = v;
    }
  }
  return out;
}

async function inflate(input) {
  if (typeof DecompressionStream === 'undefined') throw new UnsupportedTiff('This browser can’t unpack this TIFF');
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// → [{ width, height, data: Uint8ClampedArray RGBA }] (one per page; at most `maxPages`).
export async function decodeTiff(buffer, { maxPages = 50 } = {}) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const le = bytes[0] === 0x49;
  if (!(le ? bytes[1] === 0x49 : bytes[0] === 0x4d && bytes[1] === 0x4d) || dv.getUint16(2, le) !== 42) throw new UnsupportedTiff('Not a TIFF file');
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 16: 8 };
  const pages = [];
  let ifd = u32(4);
  const seen = new Set();
  while (ifd && !seen.has(ifd) && pages.length < maxPages && ifd + 2 <= bytes.length) {
    seen.add(ifd);
    const count = u16(ifd);
    const tags = {};
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      const size = (TYPE_SIZE[type] || 1) * n;
      const at = size > 4 ? u32(e + 8) : e + 8;
      const vals = [];
      for (let k = 0; k < Math.min(n, 1 << 20); k++) vals.push(type === 3 ? u16(at + k * 2) : type === 4 ? u32(at + k * 4) : bytes[at + k]);
      tags[tag] = vals;
    }
    ifd = u32(ifd + 2 + count * 12);
    const width = tags[256]?.[0];
    const height = tags[257]?.[0];
    if (!width || !height) continue;
    if (tags[322]) throw new UnsupportedTiff('Tiled TIFFs can’t be previewed yet');
    const compression = tags[259]?.[0] || 1;
    if (![1, 5, 8, 32946, 32773].includes(compression)) throw new UnsupportedTiff(compression === 3 || compression === 4 ? 'Fax-compressed TIFF — download it to view' : 'This TIFF’s compression can’t be previewed');
    const bits = tags[258]?.[0] || 1;
    const spp = tags[277]?.[0] || 1;
    const photometric = tags[262]?.[0] ?? 1;
    if ((tags[284]?.[0] || 1) !== 1) throw new UnsupportedTiff('Planar TIFFs can’t be previewed');
    const rowsPerStrip = tags[278]?.[0] || height;
    const offsets = tags[273] || [];
    const counts = tags[279] || [];
    const rowBytes = Math.ceil((width * bits * spp) / 8);
    const raw = new Uint8Array(rowBytes * height);
    let at = 0;
    for (let s = 0; s < offsets.length; s++) {
      const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
      const want = rowBytes * rows;
      const chunk = bytes.subarray(offsets[s], offsets[s] + (counts[s] || want));
      let plain = chunk;
      if (compression === 5) plain = lzw(chunk, want);
      else if (compression === 32773) plain = packbits(chunk, want);
      else if (compression === 8 || compression === 32946) plain = await inflate(chunk);
      raw.set(plain.subarray(0, Math.min(want, raw.length - at)), at);
      at += want;
    }
    // Horizontal differencing (predictor 2), 8-bit samples.
    if ((tags[317]?.[0] || 1) === 2 && bits === 8) {
      for (let y = 0; y < height; y++) for (let x = spp; x < rowBytes; x++) raw[y * rowBytes + x] = (raw[y * rowBytes + x] + raw[y * rowBytes + x - spp]) & 255;
    }
    const data = new Uint8ClampedArray(width * height * 4);
    const map = tags[320];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        let r; let g; let b;
        if (bits === 1) {
          const bit = (raw[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          r = g = b = (photometric === 0 ? !bit : bit) ? 255 : 0;
        } else if (photometric === 3 && map) {
          const i = bits === 8 ? raw[y * rowBytes + x] : 0;
          const n = 1 << bits;
          [r, g, b] = [map[i] >> 8, map[n + i] >> 8, map[2 * n + i] >> 8];
        } else {
          const at8 = (c) => (bits === 16 ? raw[y * rowBytes + (x * spp + c) * 2 + (le ? 1 : 0)] : raw[y * rowBytes + x * spp + c]);
          if (spp >= 3) [r, g, b] = [at8(0), at8(1), at8(2)];
          else {
            const v = at8(0);
            r = g = b = photometric === 0 ? 255 - v : v;
          }
        }
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
    }
    pages.push({ width, height, data });
  }
  if (!pages.length) throw new UnsupportedTiff('No pages in this TIFF');
  return pages;
}
