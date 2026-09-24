// What an uploaded file really is, from its bytes — never from its name or the type the browser claims — and
// whether the chart may keep it. Documents can be any everyday office file (PDF, pictures incl. HEIC and
// multi-page TIFF, Word/Excel/PowerPoint, RTF, CSV, text), x-rays (DICOM), 3D scans and CBCT series, and
// audio/video; programs, scripts and web pages (HTML, SVG) are always refused, whatever they're called.
import { HttpError } from './auth.js';
import { sniffMime } from './routes/imaging.js';
import { sniffScanMime, readZip, isZip } from './volume.js';

const MB = 1024 * 1024;
// Largest file of each kind (the upload route reads at most the largest limit for the file's name first).
export const TYPES = {
  'image/jpeg': { kind: 'image', max: 50 * MB }, 'image/png': { kind: 'image', max: 50 * MB }, 'image/gif': { kind: 'image', max: 25 * MB },
  'image/webp': { kind: 'image', max: 50 * MB }, 'image/bmp': { kind: 'image', max: 50 * MB }, 'image/tiff': { kind: 'tiff', max: 100 * MB },
  'image/heic': { kind: 'heic', max: 50 * MB }, 'image/heif': { kind: 'heic', max: 50 * MB },
  'application/pdf': { kind: 'pdf', max: 100 * MB },
  'application/dicom': { kind: 'dicom', max: 100 * MB },
  'application/zip': { kind: 'volume', max: 1024 * MB },
  'model/stl': { kind: 'mesh', max: 200 * MB }, 'model/ply': { kind: 'mesh', max: 200 * MB }, 'model/obj': { kind: 'mesh', max: 200 * MB },
  'text/plain': { kind: 'text', max: 25 * MB }, 'text/csv': { kind: 'text', max: 25 * MB }, 'application/rtf': { kind: 'text', max: 25 * MB },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'office', max: 50 * MB, label: 'Word' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'office', max: 50 * MB, label: 'Excel' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'office', max: 50 * MB, label: 'PowerPoint' },
  'application/msword': { kind: 'office', max: 50 * MB, label: 'Word' }, 'application/vnd.ms-excel': { kind: 'office', max: 50 * MB, label: 'Excel' },
  'application/vnd.ms-powerpoint': { kind: 'office', max: 50 * MB, label: 'PowerPoint' },
  'audio/mpeg': { kind: 'audio', max: 200 * MB }, 'audio/mp4': { kind: 'audio', max: 200 * MB }, 'audio/wav': { kind: 'audio', max: 200 * MB },
  'audio/ogg': { kind: 'audio', max: 200 * MB }, 'audio/webm': { kind: 'audio', max: 200 * MB }, 'audio/flac': { kind: 'audio', max: 200 * MB },
  'video/mp4': { kind: 'video', max: 500 * MB }, 'video/quicktime': { kind: 'video', max: 500 * MB }, 'video/webm': { kind: 'video', max: 500 * MB },
  'video/x-msvideo': { kind: 'video', max: 500 * MB },
};
export const MAX_ANY = 1024 * MB;

// How much the upload route will read before it knows what the file is, by the name it was sent with.
export function readLimitFor(filename = '') {
  const ext = extOf(filename);
  if (ext === 'zip') return 1024 * MB;
  if (['mp4', 'mov', 'm4v', 'webm', 'avi', 'qt'].includes(ext)) return 500 * MB;
  if (['mp3', 'm4a', 'wav', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba'].includes(ext)) return 200 * MB;
  if (['stl', 'ply', 'obj'].includes(ext)) return 200 * MB;
  if (['pdf', 'tif', 'tiff', 'dcm'].includes(ext)) return 100 * MB;
  if (['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'bmp'].includes(ext)) return 50 * MB;
  return 25 * MB;
}

export const extOf = (name) => (/\.([a-z0-9]{1,6})$/i.exec(String(name || ''))?.[1] || '').toLowerCase();

// Never kept, whatever they contain: programs, installers, scripts and shortcuts.
const BLOCKED_EXT = new Set(['exe', 'dll', 'com', 'scr', 'msi', 'msp', 'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'wsf', 'wsh', 'hta',
  'jar', 'sh', 'bash', 'zsh', 'csh', 'app', 'lnk', 'reg', 'cpl', 'msc', 'apk', 'dmg', 'pkg', 'iso', 'py', 'pl', 'rb', 'php', 'asp', 'aspx', 'jsp', 'svg', 'svgz',
  'xhtml', 'htm', 'html', 'shtml', 'mht', 'mhtml', 'xml', 'xsl', 'swf', 'gadget', 'inf', 'scf', 'url', 'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'potm']);
// Page/script markup inside something claiming to be text.
const MARKUP = /<\s*(script|html|svg|iframe|object|embed|body|head|meta|link|style|form|img[^>]+on\w+\s*=)|<!doctype\s+html|<\?xml[^>]*>\s*<svg|javascript:/i;

const refuse = (msg) => new HttpError(415, msg);

// Executables and scripts by their first bytes (Windows PE, Linux ELF, macOS Mach-O, Java class, shell scripts).
export function isExecutable(buf) {
  if (buf.length < 4) return false;
  const b = buf;
  if (b[0] === 0x4d && b[1] === 0x5a) return true; // MZ
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return true; // ELF
  const m = b.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(m)) return true;
  if (b[0] === 0x23 && b[1] === 0x21) return true; // #!
  return false;
}

// ISO base media (MP4, MOV, M4A, HEIC): the "ftyp" box's brand says which.
function sniffFtyp(buf, ext) {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') return null;
  const brand = buf.toString('latin1', 8, 12);
  const compatible = buf.toString('latin1', 16, Math.min(buf.length, buf.readUInt32BE(0), 64));
  if (/^(heic|heix|hevc|hevx|heim|heis)$/.test(brand)) return 'image/heic';
  if (/^(mif1|msf1)$/.test(brand)) return /heic|heix/.test(compatible) ? 'image/heic' : 'image/heif';
  if (/^(avif|avis)$/.test(brand)) return null; // not supported yet
  if (/^M4[AB] $/.test(brand) || (ext === 'm4a' && /^(isom|mp42|mp41|iso2)$/.test(brand))) return 'audio/mp4';
  if (brand === 'qt  ') return 'video/quicktime';
  if (/^(isom|iso2|iso4|iso5|iso6|mp41|mp42|avc1|dash|M4V |M4VP|3gp4|3gp5|3gp6|3g2a|mmp4|MSNV|f4v )$/.test(brand)) return 'video/mp4';
  return null;
}

// A zip that is really an Office document (Word, Excel, PowerPoint). Macro-enabled ones are refused.
function sniffOoxml(buf) {
  let entries;
  try { entries = readZip(buf); } catch { return null; }
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('[Content_Types].xml')) return null;
  if ([...names].some((n) => /vbaProject\.bin$|\/activeX\//i.test(n))) throw refuse('Office files with macros can’t be added — save it as a regular .docx/.xlsx/.pptx');
  if ([...names].some((n) => n.startsWith('word/'))) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if ([...names].some((n) => n.startsWith('xl/'))) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if ([...names].some((n) => n.startsWith('ppt/'))) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  return null;
}

// Plain UTF-8 text without NULs.
function isText(buf) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

// → { mime, kind, filename } for a file the chart may keep, or throws 415 saying why not.
// `declared` is the Content-Type the sender used: only consulted for plain text (text has no magic bytes).
export function classify(buf, filename = 'upload', declared = '') {
  let name = String(filename || 'upload').replace(/[^\w.\- ()]/g, '_').slice(0, 200) || 'upload';
  const ext = extOf(name);
  if (isExecutable(buf)) throw refuse('Programs and scripts can’t be added to the chart');
  const head = buf.subarray(0, 64 * 1024);
  let mime = sniffMime(buf, name);
  if (!mime) {
    if (isZip(buf)) mime = sniffOoxml(buf) || 'application/zip';
    else if (buf.length > 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1) {
      // Old-style Office file (the same container as .msi installers): only by an Office name.
      mime = { doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint' }[ext];
      if (!mime) throw refuse('That file isn’t a document the chart can keep (old Office files need a .doc, .xls or .ppt name)');
    } else if (head.toString('latin1', 0, 5) === '{\\rtf') mime = 'application/rtf';
    else if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') mime = 'audio/wav';
    else if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'AVI ') mime = 'video/x-msvideo';
    else if (head.toString('latin1', 0, 4) === 'OggS') mime = 'audio/ogg';
    else if (head.toString('latin1', 0, 4) === 'fLaC') mime = 'audio/flac';
    else if (head.toString('latin1', 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && ['mp3', 'mpga'].includes(ext))) mime = 'audio/mpeg';
    else if (head.length > 4 && head.readUInt32BE(0) === 0x1a45dfa3) mime = ['weba'].includes(ext) || /^audio\//.test(declared) ? 'audio/webm' : 'video/webm';
    else mime = sniffFtyp(head, ext) || sniffScanMime(buf, name);
  }
  if (!mime && isText(buf)) {
    const text = buf.toString('utf8', 0, Math.min(buf.length, 64 * 1024));
    if (MARKUP.test(text)) throw refuse('Web pages, SVG and scripts can’t be added to the chart');
    if (BLOCKED_EXT.has(ext) && !['html', 'htm', 'xml', 'svg'].includes(ext)) throw refuse('Scripts can’t be added to the chart');
    // Text has no signature: only taken as text when it was sent as text (or as an unknown file).
    const d = String(declared || '').toLowerCase();
    if (!(d.startsWith('text/') || d === 'application/octet-stream' || d === '' || d === 'application/csv' || d === 'application/vnd.ms-excel')) {
      throw refuse(`That file isn’t the ${d.split('/')[1] || 'kind of file'} it says it is`);
    }
    mime = ext === 'csv' ? 'text/csv' : 'text/plain';
    // Text-format scans (ASCII STL/OBJ/PLY), CSVs, notes keep their names; anything else (.html, .svg) becomes .txt.
    if (!/\.(txt|stl|obj|ply|csv|md|log)$/i.test(name)) name = `${name.replace(/\.[^.]*$/, '')}.txt`;
  }
  if (!mime) {
    if (/^text\//.test(declared) || ['txt', 'csv'].includes(ext)) throw refuse('That text file isn’t plain text');
    throw refuse('That kind of file can’t be added. Documents, pictures, PDFs, Office files, x-rays (DICOM), 3D scans, audio and video can.');
  }
  if (BLOCKED_EXT.has(ext) && !mime.startsWith('text/')) throw refuse('That file’s name says it’s a program or web page — rename it to what it really is');
  const type = TYPES[mime];
  if (!type) throw refuse('That kind of file can’t be added');
  if (buf.length > type.max) throw new HttpError(413, `That ${type.label || type.kind} file is too large (${Math.round(type.max / MB)} MB at most)`);
  return { mime, kind: type.kind, filename: name };
}

// Everyday word for a file type, for screens and messages.
export function kindOf(mime) {
  return TYPES[mime]?.kind || 'file';
}
