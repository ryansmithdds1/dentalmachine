import { deflateSync, inflateSync } from 'node:zlib';

// A small PDF writer for signed forms: Helvetica text that wraps and flows across Letter pages,
// rules, and JPEG/PNG images (signatures, ID cards). No dependencies.

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;

// Glyph widths (per 1000 em) for ASCII 32–126, from the standard Helvetica metrics.
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Text → WinAnsi bytes (what the standard fonts understand). Anything else becomes "?".
const WIN = { '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97, '•': 0x95, '…': 0x85, '€': 0x80, '™': 0x99 };
function winAnsi(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    if (c === 9) out += ' ';
    else if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) out += String.fromCharCode(c);
    else if (WIN[ch]) out += String.fromCharCode(WIN[ch]);
    else if (c === 0x2713 || c === 0x2714) out += 'x';
    else out += '?';
  }
  return out;
}
const width = (s, size, bold) => {
  const w = bold ? W_BOLD : W_REG;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c >= 32 && c <= 126 ? w[c - 32] : 556;
  }
  return (n * size) / 1000;
};
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function wrap(text, size, bold, maxW) {
  const lines = [];
  for (const para of winAnsi(text).split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const next = line ? `${line} ${word}` : word;
      if (width(next, size, bold) <= maxW) { line = next; continue; }
      if (line) lines.push(line);
      line = '';
      // A single word longer than the line is broken by characters.
      for (const ch of word) {
        if (line && width(line + ch, size, bold) > maxW) { lines.push(line); line = ''; }
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

// ---- Images ----
export function dataUrlImage(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  try {
    return m[1] === 'image/png' ? pngImage(buf) : jpegImage(buf);
  } catch {
    return null;
  }
}

function jpegImage(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('Not a JPEG');
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const comps = buf[i + 9];
      return { filter: 'DCTDecode', data: buf, h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), colorSpace: comps === 1 ? 'DeviceGray' : comps === 4 ? 'DeviceCMYK' : 'DeviceRGB' };
    }
    i += 2 + len;
  }
  throw new Error('JPEG size not found');
}

// PNG → RGB composited on white (signatures are transparent), re-compressed for the PDF.
function pngImage(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let i = 8;
  let w; let h; let depth; let type; let interlace;
  const idat = [];
  let palette = null;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const kind = buf.toString('ascii', i + 4, i + 8);
    const body = buf.subarray(i + 8, i + 8 + len);
    if (kind === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
    if (kind === 'PLTE') palette = body;
    if (kind === 'IDAT') idat.push(body);
    if (kind === 'IEND') break;
    i += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error('Unsupported PNG');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error('Unsupported PNG');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = y && x >= channels ? px[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  const rgb = Buffer.alloc(w * h * 3);
  for (let p = 0; p < w * h; p++) {
    let r; let g; let bl; let al = 255;
    const o = p * channels;
    if (type === 0) r = g = bl = px[o];
    else if (type === 4) { r = g = bl = px[o]; al = px[o + 1]; } else if (type === 3) { r = palette[px[o] * 3]; g = palette[px[o] * 3 + 1]; bl = palette[px[o] * 3 + 2]; } else { r = px[o]; g = px[o + 1]; bl = px[o + 2]; if (type === 6) al = px[o + 3]; }
    const mix = (v) => Math.round((v * al + 255 * (255 - al)) / 255);
    rgb[p * 3] = mix(r); rgb[p * 3 + 1] = mix(g); rgb[p * 3 + 2] = mix(bl);
  }
  return { filter: 'FlateDecode', data: deflateSync(rgb), w, h, colorSpace: 'DeviceRGB' };
}

// ---- Document ----
export class PdfDoc {
  constructor({ footer = '' } = {}) {
    this.pages = [];
    this.images = [];
    this.footer = footer;
    this.newPage();
  }

  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = PAGE_H - MARGIN;
  }

  need(h) {
    if (this.y - h < MARGIN + 20) this.newPage();
  }

  space(n = 8) {
    this.y -= n;
  }

  text(str, { size = 10.5, bold = false, color = [0.07, 0.09, 0.15], indent = 0, gap = 3 } = {}) {
    const lead = size * 1.32;
    for (const line of wrap(str, size, bold, PAGE_W - 2 * MARGIN - indent)) {
      this.need(lead);
      this.y -= lead;
      this.ops.push(`BT ${color.join(' ')} rg /F${bold ? 2 : 1} ${size} Tf ${MARGIN + indent} ${this.y.toFixed(2)} Td (${esc(line)}) Tj ET`);
    }
    this.y -= gap;
  }

  // One table row: cells at fractions of the page width ([0, .2, .75]), right-aligned where asked. Long cells are cut.
  row(cells, { at, right = [], size = 10, bold = false, color = [0.07, 0.09, 0.15] } = {}) {
    const lead = size * 1.4;
    const inner = PAGE_W - 2 * MARGIN;
    this.need(lead);
    this.y -= lead;
    cells.forEach((cell, i) => {
      const start = MARGIN + inner * at[i];
      const end = MARGIN + inner * (at[i + 1] ?? 1) - 6;
      let str = winAnsi(String(cell ?? ''));
      while (str.length > 1 && width(str, size, bold) > end - start) str = str.slice(0, -1);
      const x = right.includes(i) ? end - width(str, size, bold) + 6 : start;
      this.ops.push(`BT ${color.join(' ')} rg /F${bold ? 2 : 1} ${size} Tf ${x.toFixed(2)} ${this.y.toFixed(2)} Td (${esc(str)}) Tj ET`);
    });
  }

  rule() {
    this.need(10);
    this.y -= 6;
    this.ops.push(`0.8 0.82 0.86 RG 0.6 w ${MARGIN} ${this.y} m ${PAGE_W - MARGIN} ${this.y} l S`);
    this.y -= 6;
  }

  image(img, { maxW = 220, maxH = 90, indent = 0, border = false } = {}) {
    if (!img) return;
    const scale = Math.min(maxW / img.w, maxH / img.h, 1);
    const w = img.w * scale;
    const h = img.h * scale;
    this.need(h + 4);
    this.y -= h;
    this.images.push(img);
    const name = `Im${this.images.length}`;
    this.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${MARGIN + indent} ${this.y.toFixed(2)} cm /${name} Do Q`);
    if (border) this.ops.push(`0.8 0.82 0.86 RG 0.5 w ${MARGIN + indent} ${this.y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
    this.y -= 4;
  }

  toBuffer() {
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; };
    const catalog = add(null);
    const pagesObj = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const imgIds = this.images.map((img) => add({
      dict: `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /${img.colorSpace} /BitsPerComponent 8 /Filter /${img.filter} /Length ${img.data.length} >>`,
      stream: img.data,
    }));
    const xobjects = imgIds.length ? `/XObject << ${imgIds.map((id, i) => `/Im${i + 1} ${id} 0 R`).join(' ')} >>` : '';
    const kids = [];
    this.pages.forEach((ops, n) => {
      const foot = winAnsi(`${this.footer}${this.footer ? '  ·  ' : ''}Page ${n + 1} of ${this.pages.length}`);
      const all = [...ops, `BT 0.45 0.48 0.55 rg /F1 8 Tf ${MARGIN} ${MARGIN - 18} Td (${esc(foot)}) Tj ET`].join('\n');
      const content = add({ dict: `<< /Length ${Buffer.byteLength(all, 'latin1')} >>`, stream: Buffer.from(all, 'latin1') });
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> ${xobjects} >> /Contents ${content} 0 R >>`));
    });
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(offset);
      const parts = typeof o === 'string'
        ? [Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')]
        : [Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')];
      for (const p of parts) { chunks.push(p); offset += p.length; }
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(chunks);
  }
}
