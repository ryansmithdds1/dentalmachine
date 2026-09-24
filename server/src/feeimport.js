// Reading a payer's fee schedule file into { code, fee } lines — the adapter behind PPO schedule imports.
//  - CSV (or pasted text) and XLSX spreadsheets are read here, with no outside service and no extra library
//    (XLSX is a zip of XML: Node's zlib inflates it).
//  - PDFs (and images) go to Claude through ai.js (logged in Connection activity like every AI call). Without an
//    AI key, sandbox mode (EDI sandbox, or FEE_READER=sandbox) picks "D1234 … 45.00" lines out of the file's
//    text so demos and tests work offline.
// Whatever it reads becomes a DRAFT for a person to approve; the reader never changes a fee.
import { inflateRawSync } from 'node:zlib';
import { HttpError } from './auth.js';
import { aiClient, structured } from './ai.js';
import { runFeeJobs } from './feeversions.js';

const MAX_BYTES = 10_000_000;

// ---- CSV ----
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  const delim = (s.split('\n')[0].match(/\t/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? '\t' : s.split('\n')[0].includes(';') && !s.split('\n')[0].includes(',') ? ';' : ',';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// ---- XLSX ----
function unzip(buf) {
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new HttpError(400, 'That isn’t a valid .xlsx file');
  const count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new HttpError(400, 'That .xlsx file is damaged');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const data = buf.subarray(dataAt, dataAt + size);
    if (/^xl\/(sharedStrings\.xml|workbook\.xml|worksheets\/sheet\d+\.xml)$/.test(name)) {
      files.set(name, method === 8 ? inflateRawSync(data) : method === 0 ? data : null);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const texts = (xml) => [...String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');
const colIndex = (ref) => [...String(ref).replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export function parseXlsx(buf) {
  const files = unzip(buf);
  const strings = files.get('xl/sharedStrings.xml') ? [...files.get('xl/sharedStrings.xml').toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1])) : [];
  const sheetName = [...files.keys()].filter((n) => n.startsWith('xl/worksheets/')).sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]))[0];
  if (!sheetName || !files.get(sheetName)) throw new HttpError(400, 'No worksheet found in that .xlsx file');
  const xml = files.get(sheetName).toString('utf8');
  const rows = [];
  for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /t="(\w+)"/.exec(attrs)?.[1];
      const body = c[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const value = type === 's' ? strings[Number(v)] ?? '' : type === 'inlineStr' ? texts(body) : v != null ? unxml(v) : '';
      row[ref ? colIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// ---- Rows → lines ----
const CODE = /^D\d{4}$/i;
export const dollarsToCents = (v) => {
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
};

// Finds the code column and the fee column: by header ("Code", "CDT"; "Fee", "Allowed", "Max"...), else by content.
export function rowsToItems(rows) {
  const warnings = [];
  let header = -1;
  let codeCol = -1;
  let feeCol = -1;
  for (let i = 0; i < Math.min(rows.length, 15) && header < 0; i++) {
    const cells = rows[i].map((c) => String(c).trim().toLowerCase());
    const c = cells.findIndex((x) => /^(cdt|ada)?\s*(procedure\s*)?code$|^cdt|^proc/.test(x));
    const f = cells.findIndex((x, k) => k !== c && /fee|allow|amount|max|rate|price|ucr|contract/.test(x));
    if (c >= 0 && f >= 0) { header = i; codeCol = c; feeCol = f; }
  }
  if (header < 0) {
    const width = Math.max(...rows.map((r) => r.length), 0);
    const score = (k, test) => rows.filter((r) => test(String(r[k] ?? '').trim())).length;
    codeCol = [...Array(width).keys()].sort((a, b) => score(b, (x) => CODE.test(x)) - score(a, (x) => CODE.test(x)))[0] ?? -1;
    feeCol = [...Array(width).keys()].filter((k) => k !== codeCol).sort((a, b) => score(b, (x) => dollarsToCents(x) != null) - score(a, (x) => dollarsToCents(x) != null)).at(0) ?? -1;
    if (codeCol < 0 || feeCol < 0 || !score(codeCol, (x) => CODE.test(x))) return { items: [], warnings: ['No column of CDT codes (D1234) was found'] };
  }
  const items = [];
  for (const r of rows.slice(header + 1)) {
    const code = String(r[codeCol] ?? '').trim().toUpperCase();
    if (!CODE.test(code)) continue;
    const fee = dollarsToCents(r[feeCol]);
    if (fee == null) { warnings.push(`${code}: no fee on its row`); continue; }
    items.push({ code, fee });
  }
  return { items, warnings };
}

// ---- PDFs through the AI ----
const FEE_TOOL = {
  name: 'fee_schedule',
  description: 'The fee schedule in this document: every CDT code with its fee (allowed amount).',
  input_schema: {
    type: 'object',
    properties: {
      payer_name: { type: 'string' }, schedule_name: { type: 'string' },
      effective_date: { type: 'string', description: 'YYYY-MM-DD, only when the document states it' },
      items: { type: 'array', items: { type: 'object', properties: { code: { type: 'string', description: 'CDT code, e.g. D0120' }, fee: { type: 'number', description: 'Dollars' } }, required: ['code', 'fee'] } },
      unreadable: { type: 'array', items: { type: 'string' }, description: 'Codes or rows that couldn’t be read clearly' },
    },
    required: ['items'],
  },
};
const FEE_SYSTEM = `You read US dental PPO fee schedules (a payer's contracted maximum allowable fees) for a dental office's billing team.
Copy every CDT code (D0000-D9999) and its fee exactly as printed, in dollars. When a row shows several fees (e.g. by region or specialty), use the general dentist / office column and say so in unreadable. Don't guess values that aren't on the page.`;

const sandboxOn = (config) => config?.feeReader === 'sandbox' || process.env.FEE_READER === 'sandbox' || config?.ediMode === 'sandbox';

// Offline stand-in: lines like "D0120 Periodic oral evaluation $38.00" in the file's text.
export function sandboxRead(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const items = [];
  for (const m of text.matchAll(/\b(D\d{4})\b[^\n\r]*?\$?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2}))/g)) items.push({ code: m[1], fee: dollarsToCents(m[2]) });
  const eff = /effective[^\n\d]{0,20}(\d{4}-\d{2}-\d{2})/i.exec(text)?.[1] || null;
  return { items, effective_date: eff };
}

export function createFeeReader({ config = {} } = {}) {
  const mode = () => (aiClient(config) ? 'claude' : sandboxOn(config) ? 'sandbox' : 'off');
  return {
    get mode() { return mode(); },
    async read(file) {
      const name = String(file.name || '');
      const mime = String(file.mime || '');
      if (file.text != null && !file.base64) {
        const { items, warnings } = rowsToItems(parseCsv(file.text));
        return { items, warnings, reader: 'csv', reason: `Read ${items.length} codes from ${name || 'the pasted table'}` };
      }
      const data = String(file.base64 || '');
      if (!data) throw new HttpError(400, 'Attach the fee schedule (CSV, XLSX or PDF) or paste it');
      if (data.length * 0.75 > MAX_BYTES) throw new HttpError(400, 'That file is too large (10 MB at most)');
      const bytes = Buffer.from(data, 'base64');
      if (/csv|text\/plain/.test(mime) || /\.(csv|txt|tsv)$/i.test(name)) {
        const { items, warnings } = rowsToItems(parseCsv(bytes.toString('utf8')));
        return { items, warnings, reader: 'csv', reason: `Read ${items.length} codes from ${name || 'the CSV'}` };
      }
      if (/spreadsheetml|excel/.test(mime) || /\.xlsx$/i.test(name)) {
        const { items, warnings } = rowsToItems(parseXlsx(bytes));
        return { items, warnings, reader: 'xlsx', reason: `Read ${items.length} codes from ${name || 'the spreadsheet'}` };
      }
      if (/\.xls$/i.test(name)) throw new HttpError(400, 'Old .xls files can’t be read — save it as .xlsx or CSV');
      const block = mime === 'application/pdf' || /\.pdf$/i.test(name)
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
        : /^image\/(png|jpeg|gif|webp)$/.test(mime) ? { type: 'image', source: { type: 'base64', media_type: mime, data } } : null;
      if (!block) throw new HttpError(400, 'CSV, XLSX, PDF or an image (PNG, JPEG) only');
      const m = mode();
      if (m === 'claude') {
        const out = await structured(config, { system: FEE_SYSTEM, tool: FEE_TOOL, effort: 'medium', maxTokens: 32000, content: [block, { type: 'text', text: 'Read this fee schedule.' }] });
        if (!Array.isArray(out.items)) throw new HttpError(422, 'The AI couldn’t find a fee schedule in that document');
        const items = out.items.map((i) => ({ code: String(i.code || '').toUpperCase(), fee: Math.round(Number(i.fee) * 100) }));
        const warnings = (out.unreadable || []).slice(0, 20).map((u) => `Unclear in the document: ${String(u).slice(0, 80)}`);
        return {
          items, warnings, reader: 'ai', payer_name: out.payer_name || null, effective_date: out.effective_date || null,
          reason: `AI read ${items.length} codes from ${name || 'the PDF'}${out.payer_name ? ` (${out.payer_name})` : ''}${out.effective_date ? `, effective ${out.effective_date}` : ''}. A person checks the differences before anything changes.`,
        };
      }
      if (m === 'sandbox') {
        const out = sandboxRead(bytes);
        return { ...out, warnings: [], reader: 'sandbox', reason: `Sandbox reader found ${out.items.length} codes in ${name || 'the file'} (no AI key on this server)` };
      }
      throw new HttpError(503, 'Reading PDFs needs the AI (ANTHROPIC_API_KEY). Upload the schedule as CSV or XLSX instead.');
    },
  };
}

// The background job (index.js): scheduled fee changes at local midnight, and inbox files into drafts.
export const runFeeSchedules = (db, { config = {}, now = new Date() } = {}) => runFeeJobs(db, { reader: createFeeReader({ config }), now });
