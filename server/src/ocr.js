// Reading the words in a document, so documents can be found by what they say and filed by what they are.
//  1. Files that carry their text are read here, with nothing sent anywhere: plain text, CSV, RTF, Word /
//     Excel / PowerPoint (.docx/.xlsx/.pptx), and PDFs that have a text layer (most computer-made PDFs).
//  2. Scans and photos (images, PDFs without text) go to the OCR adapter:
//       • 'ai'      — Claude's vision through ai.js, only when AI is on for this server (ANTHROPIC_API_KEY) and the
//                     practice hasn't turned document reading off (practices.document_ai). Recorded as source 'ai'.
//       • 'sandbox' — no-op (demo and test servers: nothing is read, nothing leaves the server);
//       • 'off'     — no AI configured.
//     Tests (and a future vendor) can pass their own adapter as config.ocrAdapter: { mode, read({ mime, data, filename, scope }) }.
// The category suggestion ("this looks like an EOB") comes from the file name and the words read, with a
// one-line reason a person can check; the AI's own suggestion is used when it read the document.
import { inflateSync } from 'node:zlib';
import { aiClient, structured } from './ai.js';
import { readZip } from './volume.js';

const MAX_TEXT = 200_000;

// ---- Local text extraction ----
const xmlDecode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

function officeText(buf, mime) {
  let entries;
  try { entries = readZip(buf); } catch { return ''; }
  const read = (e) => { try { return e.read().toString('utf8'); } catch { return ''; } };
  const pick = (re) => entries.filter((e) => re.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parts = [];
  if (/wordprocessing/.test(mime)) {
    for (const e of pick(/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/)) {
      parts.push(read(e).replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<(?!\/?w:t[\s>])[^>]+>/g, '').replace(/<\/?w:t[^>]*>/g, ''));
    }
  } else if (/spreadsheet/.test(mime)) {
    for (const e of pick(/^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/)) {
      const x = read(e);
      const cells = [...x.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]);
      parts.push(cells.join('\n'));
    }
  } else if (/presentation/.test(mime)) {
    for (const e of pick(/^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/)) {
      parts.push([...read(e).matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' '));
    }
  }
  return xmlDecode(parts.join('\n'));
}

function rtfText(s) {
  return s.replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^{}]*\}/g, '').replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
}

// PDF text layer: content streams (inflated when compressed), text between BT and ET, from Tj/TJ/'/" strings.
// Custom-encoded fonts (common in scans' hidden OCR layers from some tools) read as gibberish and are dropped.
function pdfString(s, i) {
  // s[i] === '(' → [string, next index]
  let depth = 0;
  let out = '';
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      const n = s[j + 1];
      const map = { n: '\n', r: '\r', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' };
      if (n in map) { out += map[n]; j++; continue; }
      if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(s.slice(j + 1, j + 4))[0];
        out += String.fromCharCode(parseInt(oct, 8));
        j += oct.length;
        continue;
      }
      j++;
      continue;
    }
    if (c === '(') { if (depth++ > 0) out += c; continue; }
    if (c === ')') { if (--depth === 0) return [out, j + 1]; out += c; continue; }
    out += c;
  }
  return [out, s.length];
}
function contentText(s) {
  let out = '';
  let i = 0;
  let inText = false;
  while (i < s.length) {
    const c = s[i];
    if (c === '(' && inText) {
      const [str, next] = pdfString(s, i);
      out += str;
      i = next;
      continue;
    }
    if (c === '<' && inText && s[i + 1] !== '<') {
      const end = s.indexOf('>', i);
      const hex = s.slice(i + 1, end).replace(/\s+/g, '');
      if (hex.length % 4 === 0 && /^(00[0-9a-f]{2})+$/i.test(hex)) out += hex.match(/.{4}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join('');
      else if (hex.length % 2 === 0 && hex.length <= 400) out += (hex.match(/.{2}/g) || []).map((h) => String.fromCharCode(parseInt(h, 16))).join('');
      i = end + 1;
      continue;
    }
    if (c === '[' && inText) { i++; continue; }
    if (c === ']' && inText) { i++; continue; }
    // Operators: BT/ET open/close text; Td TD T* ' " move to a new line; large negative kerning in TJ is a space.
    const op = /^(BT|ET|Td|TD|T\*|Tm|'|")(?=[\s[\]()<>/]|$)/.exec(s.slice(i, i + 3));
    if (op && /[\s\]]/.test(s[i - 1] || ' ')) {
      if (op[1] === 'BT') inText = true;
      else if (op[1] === 'ET') { inText = false; out += '\n'; } else out += op[1] === 'Tm' ? ' ' : '\n';
      i += op[1].length;
      continue;
    }
    if (inText && /[-\d]/.test(c)) {
      const num = /^-?\d+(\.\d+)?/.exec(s.slice(i, i + 12));
      if (num) {
        if (Number(num[0]) < -180 && /[\d.]\s*[(<]|\d\s*\]|^-?\d+(\.\d+)?\s*[(<]/.test(s.slice(i, i + num[0].length + 2))) out += ' ';
        i += num[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}
export function pdfText(buf) {
  const s = buf.toString('latin1');
  const out = [];
  let at = 0;
  let streams = 0;
  let total = 0;
  while (streams < 3000) {
    const k = s.indexOf('stream', at);
    if (k < 0) break;
    if (s.slice(k - 3, k) === 'end') { at = k + 6; continue; }
    const dictStart = s.lastIndexOf('<<', k);
    const dict = dictStart >= 0 ? s.slice(dictStart, k) : '';
    let start = k + 6;
    if (s[start] === '\r') start++;
    if (s[start] === '\n') start++;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    at = end + 9;
    streams++;
    if (/\/Subtype\s*\/Image|\/Type\s*\/XObject|\/Type\s*\/(XRef|ObjStm|Metadata)|\/FontFile/.test(dict)) continue;
    let body = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try { body = inflateSync(body, { maxOutputLength: 20 * 1024 * 1024 }); } catch {
        try { body = inflateSync(buf.subarray(start, end - 1), { maxOutputLength: 20 * 1024 * 1024 }); } catch { continue; }
      }
    } else if (/\/Filter/.test(dict)) continue;
    const text = body.toString('latin1');
    if (!/\bBT\b/.test(text)) continue;
    const t = contentText(text);
    total += t.length;
    out.push(t);
    if (total > MAX_TEXT) break;
  }
  return out.join('\n');
}

// How much of a string looks like real words (letters, digits, spaces, punctuation), 0–1.
export function readable(text) {
  if (!text) return 0;
  const sample = text.slice(0, 5000);
  const good = sample.match(/[\p{L}\p{N}\s.,:;/()$%#&'"@-]/gu)?.length || 0;
  return good / sample.length;
}

const tidy = (t) => String(t || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim().slice(0, MAX_TEXT);

// → { text, source } from the file itself, or { text: '' } when it has to be read as a picture.
export function extractText(mime, buf) {
  try {
    if (mime === 'text/plain' || mime === 'text/csv') return { text: tidy(buf.toString('utf8')), source: 'text' };
    if (mime === 'application/rtf') return { text: tidy(rtfText(buf.toString('latin1'))), source: 'text' };
    if (/openxmlformats/.test(mime)) return { text: tidy(officeText(buf, mime)), source: 'office' };
    if (mime === 'application/pdf') {
      const t = tidy(pdfText(buf));
      // A scanned PDF has no text layer (or only a few stray characters): read it as a picture instead.
      return t.replace(/\s/g, '').length >= 20 && readable(t) > 0.85 ? { text: t, source: 'pdf' } : { text: '', source: null };
    }
  } catch {
    return { text: '', source: null };
  }
  return { text: '', source: null };
}

// Files the AI can look at: pictures it reads directly, and PDFs.
export const aiReadable = (mime, size) => (/^image\/(jpeg|png|gif|webp)$/.test(mime) && size <= 5 * 1024 * 1024) || (mime === 'application/pdf' && size <= 20 * 1024 * 1024);

// ---- Categories ----
export const PATIENT_CATEGORIES = ['xray', 'photo', 'document', 'consent', 'insurance_card', 'referral', 'eob', 'lab_rx', 'id_card', 'xray_report', 'medical_history', 'correspondence', 'other'];
export const OFFICE_CATEGORIES = ['document', 'contract', 'license', 'policy', 'invoice', 'certificate', 'hr', 'correspondence', 'other'];
export const CATEGORY_LABELS = {
  xray: 'X-ray', photo: 'Photo', document: 'Document', consent: 'Consent', insurance_card: 'Insurance card', referral: 'Referral', eob: 'EOB',
  lab_rx: 'Lab Rx', id_card: 'ID', xray_report: 'X-ray / imaging report', medical_history: 'Medical history', correspondence: 'Letter', other: 'Other',
  contract: 'Contract', license: 'Licence / permit', policy: 'Policy', invoice: 'Invoice', certificate: 'Certificate', hr: 'HR / staff',
};

// Words that say what a document is, strongest first. [category, pattern, what to tell the person]
const CLUES = [
  ['eob', /explanation of benefits|\bEOB\b|remittance advice|claim (number|#).{0,60}(paid|allowed)|patient responsibility/i, 'mentions an explanation of benefits / amounts paid'],
  ['insurance_card', /member (id|#|number)|subscriber id|group (no|number|#)|payer id|\bRxBIN\b/i, 'has a member ID and group number like an insurance card'],
  ['consent', /\bconsent\b|informed consent|i (hereby )?(authori[sz]e|agree)|risks? (and|&) (benefits|alternatives)/i, 'reads like a consent form (“I authorize / risks and benefits”)'],
  ['referral', /\breferr(al|ed|ing)\b|please (see|evaluate)|reason for referral/i, 'mentions a referral'],
  ['lab_rx', /lab(oratory)? (rx|prescription|slip|order)|\bshade\b.{0,40}\b(A[1-4]|B[1-4]|C[1-4]|D[2-4])\b|crown.{0,40}(zirconia|e\.?max|pfm)|return date/i, 'reads like a lab prescription (shade, material, return date)'],
  ['xray_report', /radiolog(y|ist)|\bCBCT\b.{0,80}(report|impression|findings)|impression:|findings:/i, 'reads like an imaging report (findings / impression)'],
  ['medical_history', /medical history|health history|medications?:|allerg(y|ies)/i, 'asks about medical history, medications or allergies'],
  ['id_card', /driver'?s? licen[cs]e|\bDL\s*(no|#)|date of birth.{0,40}(class|expires)|identification card|passport/i, 'looks like a photo ID'],
  ['invoice', /\binvoice\b|amount due|bill to|remit to|\bpo (number|#)/i, 'mentions an invoice / amount due'],
  ['contract', /\bagreement\b|\bcontract\b|hereinafter|terms and conditions|the parties/i, 'reads like a contract or agreement'],
  ['license', /\blicen[cs]e\b.{0,60}(number|no\.|#|expir)|\bpermit\b|registration certificate|\bDEA\b/i, 'mentions a licence/permit number or expiry'],
  ['certificate', /certificate of|certif(y|ies) that|continuing education|\bCE credits?\b|\bCPR\b|\bBLS\b/i, 'reads like a certificate'],
  ['policy', /\bpolicy\b.{0,40}(procedure|effective)|standard operating procedure|\bSOP\b|\bHIPAA\b.{0,40}policy/i, 'reads like an office policy'],
  ['hr', /\bW-?4\b|\bI-?9\b|offer letter|employee handbook|performance review|timesheet/i, 'reads like an HR/staff document'],
  ['correspondence', /^\s*dear\b|sincerely,|to whom it may concern/im, 'reads like a letter'],
];
const NAME_CLUES = [
  ['eob', /\beob\b|explanation.of.benefits|remit/i], ['insurance_card', /ins(urance)?[_ -]?card|member[_ -]?card/i], ['consent', /consent/i],
  ['referral', /referr/i], ['lab_rx', /lab[_ -]?(rx|slip|script)/i], ['id_card', /\b(id|license|licence|dl)\b[_ -]?(card|front|back)?/i],
  ['xray_report', /(cbct|radiology|x-?ray)[_ -]?report/i], ['medical_history', /med(ical)?[_ -]?hist|health[_ -]?hist/i], ['invoice', /invoice|inv[_ -]?\d/i],
  ['contract', /contract|agreement/i], ['license', /licen[cs]e|permit|\bdea\b/i], ['policy', /policy|sop\b/i], ['certificate', /cert(ificate)?\b|\bce\b/i],
];

// → { category, reason } or null. `scope`: 'patient' or 'office' (only that set's categories are suggested).
export function suggestCategory({ filename = '', text = '', mime = '', scope = 'patient' }) {
  const allowed = scope === 'office' ? OFFICE_CATEGORIES : PATIENT_CATEGORIES;
  const base = String(filename).replace(/\.[^.]*$/, '').replace(/[_]+/g, ' ');
  for (const [category, re] of NAME_CLUES) if (allowed.includes(category) && re.test(base)) return { category, reason: `The file name “${String(filename).slice(0, 60)}” says so` };
  const sample = String(text || '').slice(0, 20_000);
  if (sample) {
    for (const [category, re, why] of CLUES) {
      if (!allowed.includes(category)) continue;
      const m = re.exec(sample);
      if (m) return { category, reason: `It ${why} (“${m[0].replace(/\s+/g, ' ').trim().slice(0, 50)}”)` };
    }
  }
  if (scope === 'patient' && /^audio\/|^video\//.test(mime)) return null;
  return null;
}

// Dates like "expires 03/31/2027" or "expiration date: 2027-03-31" (licences, certificates, contracts).
export function findExpiry(text) {
  const m = /(expir\w*|valid (through|until|thru)|renewal date)\D{0,20}(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/i.exec(String(text || ''));
  if (!m) return null;
  const raw = m[3];
  let y; let mo; let d;
  if (/^\d{4}-/.test(raw)) [y, mo, d] = raw.split('-').map(Number);
  else {
    [mo, d, y] = raw.split(/[/.-]/).map(Number);
    if (y < 100) y += 2000;
  }
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(iso) && !Number.isNaN(Date.parse(iso)) ? iso : null;
}

// ---- The OCR adapter ----
const DOC_SYSTEM = `You read scanned paperwork for a dental office so staff can search it and file it. Copy the text you can read, in reading order, exactly as printed (names, numbers and dates character for character). Don't summarise, don't guess at unreadable parts (write [unclear]), and never add anything that isn't on the page. Then say what kind of document it is, with one short plain-language reason a person can check.`;
const docTool = (categories) => ({
  name: 'document_read',
  description: 'The text on the pages and what kind of document it is.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'All readable text, in reading order' },
      category: { type: 'string', enum: categories },
      reason: { type: 'string', description: 'One short sentence: why that category (e.g. “Has a member ID and group number”)' },
      document_date: { type: 'string', description: 'YYYY-MM-DD, the date on the document, when there is one' },
      expires_on: { type: 'string', description: 'YYYY-MM-DD, an expiry/renewal date, when there is one' },
    },
    required: ['text'],
  },
});

export function createOcr({ config = {} } = {}) {
  if (config.ocrAdapter) return config.ocrAdapter;
  const ai = aiClient(config);
  if (ai) {
    return {
      mode: 'ai', name: 'AI document reader',
      async read({ mime, data, scope = 'patient' }) {
        const b64 = data.toString('base64');
        const block = mime === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
          : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } };
        const categories = scope === 'office' ? OFFICE_CATEGORIES : PATIENT_CATEGORIES.filter((c) => c !== 'xray' && c !== 'photo');
        const out = await structured(config, { system: DOC_SYSTEM, tool: docTool(categories), effort: 'low', maxTokens: 16000, content: [block, { type: 'text', text: 'Read this document.' }] });
        return {
          text: tidy(out.text || ''), category: categories.includes(out.category) ? out.category : null, reason: out.reason ? String(out.reason).slice(0, 200) : null,
          document_date: /^\d{4}-\d{2}-\d{2}$/.test(out.document_date || '') ? out.document_date : null, expires_on: /^\d{4}-\d{2}-\d{2}$/.test(out.expires_on || '') ? out.expires_on : null,
        };
      },
    };
  }
  if (config.ediMode === 'sandbox' || config.ocr === 'sandbox' || process.env.OCR === 'sandbox') {
    return { mode: 'sandbox', name: 'Sandbox reader (reads nothing)', async read() { return { text: '', category: null, reason: null }; } };
  }
  return { mode: 'off', name: 'Off (AI isn’t set up)', async read() { return { text: '', category: null, reason: null }; } };
}
