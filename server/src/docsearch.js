// Full-text search over documents without keeping their words readable in the database.
// A document's read text (ocr.js) is stored encrypted in file storage, like the file itself. For searching,
// the database keeps keyed hashes (HMAC-SHA256, practice-salted) of each word and of its first 3–6 letters,
// so "insur" finds "insurance". A search hashes the words typed the same way, finds the candidates, then opens
// the text of the best few to check the match and show a snippet. File names, tags, folders, notes and
// document notes (already plain text in the database) are searched directly.
// The key: DOCUMENT_SEARCH_KEY, else the document encryption key. Changing it needs a re-index
// (POST /api/documents/reindex, administrators).
import { createHmac } from 'node:crypto';

const MAX_TERMS = 6000;
const keyOf = (config = {}) => String(process.env.DOCUMENT_SEARCH_KEY || config.documentSearchKey || config.documentKey || 'dental-machine-dev-search-key');

export function words(text) {
  return [...new Set(String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && w.length <= 40))];
}

// Whole words ("w:") and their beginnings ("p:", 3 to 6 letters).
export function termsOf(text) {
  const out = new Set();
  for (const w of words(text)) {
    out.add(`w:${w}`);
    for (let n = 3; n <= Math.min(6, w.length - 1); n++) out.add(`p:${w.slice(0, n)}`);
    if (out.size >= MAX_TERMS) break;
  }
  return [...out];
}

export const hashTerm = (config, practiceId, term) => createHmac('sha256', keyOf(config)).update(`${practiceId}:${term}`).digest('base64url').slice(0, 22);

// What a typed word may match: the whole word, or (while still typing) the beginning of a longer one.
export function queryTerms(word) {
  const w = word.toLowerCase();
  const terms = [`w:${w}`];
  if (w.length >= 3) terms.push(`p:${w.slice(0, Math.min(6, w.length))}`);
  return terms;
}

// Replaces a document's index (derived data: the old rows are simply removed).
export async function indexDocument(db, config, doc, text) {
  await db.run('DELETE FROM document_terms WHERE document_id = ?', doc.id);
  const terms = termsOf(text).map((t) => hashTerm(config, doc.practice_id, t));
  for (let i = 0; i < terms.length; i += 200) {
    const chunk = [...new Set(terms.slice(i, i + 200))];
    await db.run(`INSERT INTO document_terms (practice_id, document_id, term) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')} ON CONFLICT DO NOTHING`,
      ...chunk.flatMap((t) => [doc.practice_id, doc.id, t]));
  }
  return terms.length;
}

// The stored text of a document (decrypted), or ''.
export async function readText(storage, doc) {
  if (!doc.ocr_key) return '';
  try {
    const buf = await storage.read(doc.ocr_key, !!doc.ocr_encrypted);
    return buf ? buf.toString('utf8') : '';
  } catch {
    return '';
  }
}

// A short piece of the text around the first word typed, for the result list.
export function snippet(text, qwords) {
  const lower = text.toLowerCase();
  let at = -1;
  let len = 0;
  for (const w of qwords) {
    const i = lower.search(new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'));
    if (i >= 0 && (at < 0 || i < at)) { at = i + (/[\p{L}\p{N}]/u.test(lower[i]) ? 0 : 1); len = w.length; }
  }
  if (at < 0) return null;
  const start = Math.max(0, at - 70);
  const end = Math.min(text.length, at + len + 90);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

// Searches documents. `where`/`args`: extra SQL on alias d (patient, office, permissions) supplied by the route.
// → [{ ...doc fields, matched: ['text'|'name'|'note'…], snippet }]
export async function searchDocuments(db, storage, config, { practiceId, q, where = '', args = [], limit = 50 }) {
  const qwords = words(q).slice(0, 8);
  if (!qwords.length) return [];
  const conds = [];
  const params = [];
  for (const w of qwords) {
    const like = `%${w.replace(/[%_\\]/g, '')}%`;
    const hashes = queryTerms(w).map((t) => hashTerm(config, practiceId, t));
    conds.push(`(lower(d.filename) LIKE ? OR lower(COALESCE(d.notes, '')) LIKE ? OR lower(COALESCE(d.tags, '')) LIKE ? OR lower(COALESCE(d.folder, '')) LIKE ?
      OR EXISTS (SELECT 1 FROM document_terms t WHERE t.practice_id = d.practice_id AND t.document_id = d.id AND t.term IN (${hashes.map(() => '?').join(', ')}))
      OR EXISTS (SELECT 1 FROM document_notes n WHERE n.document_id = d.id AND n.status = 'active' AND lower(n.body) LIKE ?))`);
    params.push(like, like, like, like, ...hashes, like);
  }
  const rows = await db.all(
    `SELECT d.id, d.patient_id, d.category, d.filename, d.mime, d.size, d.folder, d.notes, d.tags, d.created_at, d.taken_at, d.location_id,
       d.ocr_key, d.ocr_encrypted, d.review_status, d.expires_on, d.inbox, p.first_name, p.last_name
     FROM documents d LEFT JOIN patients p ON p.id = d.patient_id
     WHERE d.practice_id = ? AND d.deleted_at IS NULL AND ${conds.join(' AND ')}${where}
     ORDER BY d.id DESC LIMIT ?`,
    practiceId, ...params, ...args, Math.min(limit * 3, 300),
  );
  const out = [];
  for (const r of rows) {
    const plain = [r.filename, r.notes, r.tags, r.folder].join(' ').toLowerCase();
    const matched = [];
    if (qwords.every((w) => plain.includes(w))) matched.push('name');
    let snip = null;
    if (r.ocr_key && out.length < limit) {
      const text = await readText(storage, r);
      const tl = text.toLowerCase();
      // Hash matches on a word's first letters can be another word: check against the real text.
      if (qwords.every((w) => tl.includes(w) || plain.includes(w))) {
        snip = snippet(text, qwords);
        if (snip) matched.push('text');
      }
    }
    if (!matched.length) {
      const note = await db.get("SELECT body FROM document_notes WHERE document_id = ? AND status = 'active' AND lower(body) LIKE ? LIMIT 1", r.id, `%${qwords[0].replace(/[%_\\]/g, '')}%`);
      if (note) { matched.push('note'); snip = note.body.slice(0, 160); }
    }
    if (!matched.length && !qwords.every((w) => plain.includes(w))) {
      // Mixed: some words in the name, some in the text/notes — still a match if every word is somewhere.
      const text = r.ocr_key ? (await readText(storage, r)).toLowerCase() : '';
      const notes = (await db.all("SELECT body FROM document_notes WHERE document_id = ? AND status = 'active'", r.id)).map((n) => n.body.toLowerCase()).join(' ');
      if (!qwords.every((w) => plain.includes(w) || text.includes(w) || notes.includes(w))) continue;
      matched.push('mixed');
    }
    const { ocr_key: _k, ocr_encrypted: _e, ...rest } = r;
    out.push({ ...rest, patient_name: r.patient_id ? `${r.first_name} ${r.last_name}` : null, matched, snippet: snip });
    if (out.length >= limit) break;
  }
  return out;
}
