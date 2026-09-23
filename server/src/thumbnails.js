import { inflateSync } from 'node:zlib';
import { dicomToImage, encodePng } from './dicomimage.js';

// Small previews for the documents grid, so the chart doesn't download every full-size x-ray and photo.
// PNG, BMP and uncompressed DICOM are decoded and scaled here; a JPEG uses the thumbnail its camera
// embedded (EXIF). Anything else (JPEGs without one, GIF, WebP) is thumbnailed by the first browser that
// shows it, and handed back once (see PUT /documents/:id/thumb).
export const THUMB_PX = 240;

// ---- PNG decoding (8-bit, non-interlaced; what scanners, sensors and screenshots produce) ----
export function decodePng(buf) {
  if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8;
  let w; let h; let depth; let type; let interlace; let palette = null; let trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') [w, h, depth, type, interlace] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8], data[9], data[12]];
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  if (!w || !h || interlace || ![8, 16].includes(depth) || (type === 3 && depth !== 8) || w * h > 60_000_000) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) return null;
  const bpp = channels * (depth / 8);
  const stride = w * bpp;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  if (raw.length < (stride + 1) * h) return null;
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y ? out[o - stride + x] : 0;
      const c = x >= bpp && y ? out[o - stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[o + x] = v & 0xff;
    }
  }
  // → 8-bit gray or RGB (alpha flattened onto white).
  const gray = type === 0 || type === 4;
  const oc = gray ? 1 : 3;
  const px = Buffer.alloc(w * h * oc);
  const step = depth / 8; // 16-bit: take the high byte
  for (let i = 0; i < w * h; i++) {
    const s = i * bpp;
    let rgb;
    let alpha = 255;
    if (type === 3) {
      const idx = out[s];
      rgb = [palette?.[idx * 3] ?? 0, palette?.[idx * 3 + 1] ?? 0, palette?.[idx * 3 + 2] ?? 0];
      if (trns && idx < trns.length) alpha = trns[idx];
    } else if (gray) {
      rgb = [out[s]];
      if (type === 4) alpha = out[s + step];
    } else {
      rgb = [out[s], out[s + step], out[s + 2 * step]];
      if (type === 6) alpha = out[s + 3 * step];
    }
    for (let k = 0; k < oc; k++) px[i * oc + k] = Math.round((rgb[k] * alpha + 255 * (255 - alpha)) / 255);
  }
  return { width: w, height: h, channels: oc, pixels: px };
}

// ---- BMP (uncompressed 24/32-bit; some older sensors and scanners) ----
function decodeBmp(buf) {
  if (buf.length < 54 || buf.toString('latin1', 0, 2) !== 'BM') return null;
  const offset = buf.readUInt32LE(10);
  const w = buf.readInt32LE(18);
  const hRaw = buf.readInt32LE(22);
  const bits = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  const h = Math.abs(hRaw);
  if (w <= 0 || !h || ![24, 32].includes(bits) || ![0, 3].includes(compression) || w * h > 60_000_000) return null;
  const bpp = bits / 8;
  const stride = Math.ceil((w * bpp) / 4) * 4;
  if (offset + stride * h > buf.length) return null;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = offset + (hRaw > 0 ? h - 1 - y : y) * stride;
    for (let x = 0; x < w; x++) {
      const s = row + x * bpp;
      const d = (y * w + x) * 3;
      px[d] = buf[s + 2]; px[d + 1] = buf[s + 1]; px[d + 2] = buf[s];
    }
  }
  return { width: w, height: h, channels: 3, pixels: px };
}

// ---- The EXIF thumbnail inside a JPEG (phones and most cameras include one) ----
export function jpegExifThumb(buf) {
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return null;
  let pos = 2;
  while (pos + 4 < buf.length && buf[pos] === 0xff) {
    const marker = buf[pos + 1];
    const len = buf.readUInt16BE(pos + 2);
    if (marker === 0xe1 && buf.toString('latin1', pos + 4, pos + 10) === 'Exif\0\0') {
      const t = pos + 10; // TIFF header
      const le = buf.toString('latin1', t, t + 2) === 'II';
      const u16 = (o) => (le ? buf.readUInt16LE(t + o) : buf.readUInt16BE(t + o));
      const u32 = (o) => (le ? buf.readUInt32LE(t + o) : buf.readUInt32BE(t + o));
      try {
        const ifd0 = u32(4);
        const ifd1 = u32(ifd0 + 2 + u16(ifd0) * 12);
        if (!ifd1) return null;
        let start = 0; let size = 0;
        for (let i = 0; i < u16(ifd1); i++) {
          const e = ifd1 + 2 + i * 12;
          if (u16(e) === 0x0201) start = u32(e + 8);
          if (u16(e) === 0x0202) size = u32(e + 8);
        }
        if (!start || !size || t + start + size > buf.length) return null;
        const thumb = buf.subarray(t + start, t + start + size);
        return thumb[0] === 0xff && thumb[1] === 0xd8 ? Buffer.from(thumb) : null;
      } catch {
        return null;
      }
    }
    if (marker === 0xda) break; // image data starts; no EXIF
    pos += 2 + len;
  }
  return null;
}

// Box-filter downscale so the longest side is at most `max` pixels.
export function scaleDown({ width, height, channels, pixels }, max = THUMB_PX) {
  const f = Math.max(width, height) / max;
  if (f <= 1) return { width, height, channels, pixels };
  const w = Math.max(1, Math.round(width / f));
  const h = Math.max(1, Math.round(height / f));
  const out = Buffer.alloc(w * h * channels);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * f); const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * f)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * f); const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * f)));
      for (let k = 0; k < channels; k++) {
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += pixels[(yy * width + xx) * channels + k];
        out[(y * w + x) * channels + k] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
  }
  return { width: w, height: h, channels, pixels: out };
}

// → { mime, data } or null when the browser should make it.
export function makeThumbnail(mime, data) {
  let img = null;
  if (mime === 'image/png') img = decodePng(data);
  else if (mime === 'image/bmp') img = decodeBmp(data);
  else if (mime === 'application/dicom') {
    const view = dicomToImage(data);
    if (view?.mime === 'image/png') img = decodePng(view.data);
    else if (view?.mime === 'image/jpeg') {
      const exif = jpegExifThumb(view.data);
      return exif ? { mime: 'image/jpeg', data: exif } : null;
    }
  } else if (mime === 'image/jpeg') {
    const exif = jpegExifThumb(data);
    return exif ? { mime: 'image/jpeg', data: exif } : null;
  }
  if (!img) return null;
  const small = scaleDown(img);
  return { mime: 'image/png', data: encodePng(small.width, small.height, small.channels, small.pixels) };
}

// Dimensions of a thumbnail a browser sends back (checked so only small images are stored).
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let pos = 2;
    while (pos + 9 < buf.length && buf[pos] === 0xff) {
      const marker = buf[pos + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mime: 'image/jpeg', height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
      pos += 2 + buf.readUInt16BE(pos + 2);
    }
  }
  return null;
}
