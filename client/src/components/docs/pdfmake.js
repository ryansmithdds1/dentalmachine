// One PDF from JPEG pages, made on the device (phone scans): each JPEG is embedded as it is (no re-compression),
// on a page as wide as US Letter (8.5 in) with the page's own proportions. Works on Uint8Arrays, so it runs in
// the browser and in Node tests.

export function jpegInfo(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) { p++; continue; }
    const m = b[p + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    const len = (b[p + 2] << 8) | b[p + 3];
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      return { height: (b[p + 5] << 8) | b[p + 6], width: (b[p + 7] << 8) | b[p + 8], components: b[p + 9] };
    }
    p += 2 + len;
  }
  return null;
}

const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

// pages: Uint8Array JPEGs → Uint8Array PDF.
export function jpegsToPdf(pages, { pageWidth = 612 } = {}) {
  const objs = [];
  const add = (parts) => { objs.push(parts); return objs.length; };
  const catalog = add(null);
  const tree = add(null);
  const kids = [];
  for (const jpg of pages) {
    const info = jpegInfo(jpg);
    if (!info) throw new Error('A page is not a JPEG picture');
    const w = pageWidth;
    const h = (info.height / info.width) * pageWidth;
    const space = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    const img = add([latin1(`<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`), jpg, latin1('\nendstream')]);
    const draw = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} 0 0 cm /Im0 Do Q`;
    const content = add([latin1(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`)]);
    kids.push(add([latin1(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${w.toFixed(2)} ${h.toFixed(2)}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`)]));
  }
  objs[catalog - 1] = [latin1(`<< /Type /Catalog /Pages ${tree} 0 R >>`)];
  objs[tree - 1] = [latin1(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`)];
  const chunks = [latin1('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let offset = chunks[0].length;
  const offsets = [];
  objs.forEach((parts, i) => {
    const all = [latin1(`${i + 1} 0 obj\n`), ...parts, latin1('\nendobj\n')];
    offsets.push(offset);
    for (const c of all) { chunks.push(c); offset += c.length; }
  });
  chunks.push(latin1(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
