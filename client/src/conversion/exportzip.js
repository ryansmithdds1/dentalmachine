// Reads another system's data export in the browser: a .zip of CSV, tab-separated or JSON files (zips inside the
// zip too). Nothing leaves the computer here — the conversion screen then sends only the columns we use.
// No libraries: the zip's directory is read by hand and entries are inflated with the browser's own
// DecompressionStream (also in Node 18+, so the server tests read fixtures with this same code).

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Entries of a zip: [{ name, data: Uint8Array }]. Folders are skipped; nested zips are opened ("inner.zip/file.csv").
export async function readZip(input, prefix = '') {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) {
    if (u32(b, i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("This isn't a .zip file (or it's damaged). Zip the export folder and try again.");
  const count = u16(b, end + 10);
  let p = u32(b, end + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('This zip is too large to read here (over 4 GB). Split the export into two zips.');
  const out = [];
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) throw new Error('The zip file is damaged');
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const size = u32(b, p + 20);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const local = u32(b, p + 42);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || /(^|\/)(__MACOSX|\.DS_Store)/.test(name)) continue;
    if (flags & 1) throw new Error(`${name} is password-protected. Export again without a password.`);
    const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    const raw = b.subarray(start, start + size);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflate(raw);
    else throw new Error(`${name} uses a compression we can't read. Re-zip the folder with Windows (Send to → Compressed folder) or macOS (Compress).`);
    if (/\.zip$/i.test(name)) out.push(...await readZip(data, `${prefix}${name}/`));
    else out.push({ name: `${prefix}${name}`, data });
  }
  return out;
}

// Text of a file: UTF-8, UTF-16 (Windows exports sometimes are), or Windows-1252 as a last resort.
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// CSV, tab, pipe or semicolon separated text → rows of cells. Quotes, doubled quotes and newlines in quotes.
export function parseDelimited(input) {
  const text = String(input);
  const firstLine = text.slice(0, (text.search(/\r?\n/) + 1 || text.length + 1) - 1);
  const count = (ch) => firstLine.split(ch).length - 1;
  const sep = ['\t', ',', '|', ';'].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ',');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// JSON records → flat rows. Nested objects become "address.line1"; lists of values are joined with commas;
// the first list of objects (a perio chart's teeth) becomes one row per item, with the parent's fields.
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else if (Array.isArray(v)) {
      if (v.some((x) => x && typeof x === 'object')) out[key] = { list: v };
      else out[key] = v.map((x) => (x == null ? '' : String(x))).join(',');
    } else out[key] = v == null ? '' : v;
  }
  return out;
}

export function jsonRecords(text) {
  const s = String(text).trim();
  let data;
  try {
    data = JSON.parse(s);
  } catch {
    // Newline-delimited JSON.
    data = s.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  if (!Array.isArray(data)) data = data?.data || data?.items || data?.results || data?.records || Object.values(data || {}).find(Array.isArray) || [data];
  const rows = [];
  for (const rec of data) {
    if (!rec || typeof rec !== 'object') continue;
    const flat = flatten(rec);
    const listKey = Object.keys(flat).find((k) => flat[k]?.list);
    if (!listKey) {
      rows.push(flat);
      continue;
    }
    const parent = Object.fromEntries(Object.entries(flat).filter(([, v]) => !v?.list));
    for (const item of flat[listKey].list) {
      const child = flatten(item);
      const row = { ...parent };
      for (const [k, v] of Object.entries(child)) {
        if (v?.list) continue;
        row[k in parent ? `${listKey}.${k}` : k] = v;
      }
      rows.push(row);
    }
  }
  return rows;
}

// A table from records: headers in order of first appearance, rows of cells.
export function toTable(records) {
  const headers = [];
  const seen = new Set();
  for (const r of records) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
  return { headers, rows: records.map((r) => headers.map((h) => (r[h] == null ? '' : String(r[h])))) };
}

// Every readable file in the export → { name, headers, rows }. Others (PDFs, images) are listed as skipped.
export async function readExport(input) {
  const entries = await readZip(input);
  const files = [];
  const skipped = [];
  for (const e of entries) {
    const base = e.name.split('/').pop();
    if (/\.(csv|txt|tsv|tab)$/i.test(base)) {
      const [headers = [], ...rows] = parseDelimited(decodeText(e.data));
      files.push({ name: e.name, headers: headers.map((h) => h.trim()), rows });
    } else if (/\.(json|ndjson|jsonl)$/i.test(base)) {
      files.push({ name: e.name, ...toTable(jsonRecords(decodeText(e.data))) });
    } else skipped.push(e.name);
  }
  return { files, skipped };
}

// Splits rows into requests that stay well under the server's 1 MB limit.
export function chunkRows(rows, { maxRows = 2000, maxChars = 600_000 } = {}) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const r of rows) {
    const n = JSON.stringify(r).length;
    if (cur.length && (cur.length >= maxRows || size + n > maxChars)) { out.push(cur); cur = []; size = 0; }
    cur.push(r);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
