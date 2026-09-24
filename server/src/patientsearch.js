// Finding a patient from whatever the front desk types: part of a name (typos forgiven), a phone number,
// a birth date in any usual format, or a chart number (ours, or the one from the practice's old system).

// Birth dates as people type them: 1982-04-12, 4/12/1982, 4-12-82, 04121982.
export function parseDob(q) {
  const s = String(q).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y; let mo; let d;
  if (m) [, y, mo, d] = m;
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s))) [, mo, d, y] = m;
  else if ((m = /^(\d{2})(\d{2})(\d{4})$/.exec(s))) [, mo, d, y] = m;
  else return null;
  if (y.length === 2) y = String(Number(y) > (new Date().getFullYear() % 100) ? 1900 + Number(y) : 2000 + Number(y));
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? null : iso;
}

// Edit distance with swaps counted once ("jonh" → "john" is 1).
export function distance(a, b) {
  const m = a.length; const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

const clean = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9' -]/g, ' ');

// How well one typed word matches one part of a name (0 = not at all).
function wordScore(word, part) {
  if (!part) return 0;
  if (part === word) return 4;
  if (part.startsWith(word)) return 3;
  if (word.length >= 3 && part.includes(word)) return 2;
  if (word.length >= 3) {
    const allowed = word.length >= 7 ? 2 : 1;
    // Compare with the whole part and with the part cut to the typed length ("jonh" vs "johnson" → "john").
    const d = Math.min(distance(word, part), distance(word, part.slice(0, word.length)));
    if (d <= allowed) return 1.5 - d * 0.25;
  }
  return 0;
}

// Scores a patient against the typed name words; every word has to match some part of the name.
export function nameScore(words, p) {
  const parts = [p.first_name, p.last_name, p.preferred_name].flatMap((x) => clean(x).split(/[\s-]+/)).filter(Boolean);
  let total = 0;
  for (const w of words) {
    const best = Math.max(0, ...parts.map((part) => wordScore(w, part)));
    if (!best) return 0;
    total += best;
  }
  // "smith john" and "john smith" both work, but typed order that matches first-last reads best.
  if (words.length >= 2 && clean(p.first_name).startsWith(words[0]) && clean(p.last_name).startsWith(words[words.length - 1])) total += 1;
  return total;
}

const COLS = 'p.id, p.first_name, p.last_name, p.preferred_name, p.dob, p.phone, p.status, p.medical_alerts';

export async function searchPatients(db, practiceId, q, { scope = { sql: '', args: [] }, limit = 8 } = {}) {
  const text = String(q || '').trim();
  if (text.length < 2) return [];
  const base = `FROM patients p WHERE p.practice_id = ? AND p.status != 'archived'${scope.sql}`;
  const args = [practiceId, ...scope.args];
  const dob = parseDob(text);
  if (dob) return db.all(`SELECT ${COLS} ${base} AND p.dob = ? ORDER BY p.last_name, p.first_name LIMIT ?`, ...args, dob, limit);
  const digits = text.replace(/\D/g, '');
  if (/^[#\d\s()+.-]+$/.test(text) && digits) {
    // Chart numbers are short; phone numbers match on any 4+ digits.
    const byChart = await db.all(
      `SELECT ${COLS} ${base} AND (CAST(p.id AS TEXT) = ? OR p.id IN (SELECT local_id FROM external_ids WHERE practice_id = ? AND kind = 'patient' AND external_id = ?))`,
      ...args, digits, practiceId, text.replace(/^#/, ''),
    );
    const byPhone = digits.length >= 4
      ? await db.all(
        `SELECT ${COLS} ${base} AND (${['p.phone', 'p.phone_home', 'p.phone_work'].map((c) => `replace(replace(replace(replace(replace(COALESCE(${c}, ''),'(',''),')',''),'-',''),' ',''),'.','') LIKE ?`).join(' OR ')})
         ORDER BY p.last_name, p.first_name LIMIT ?`, ...args, `%${digits}%`, `%${digits}%`, `%${digits}%`, limit,
      )
      : [];
    const seen = new Set();
    return [...byChart, ...byPhone].filter((p) => !seen.has(p.id) && seen.add(p.id)).slice(0, limit);
  }
  // Chart numbers from the old system can have letters ("DX-4411").
  if (/\d/.test(text) && !/\s/.test(text)) {
    const byOld = await db.all(`SELECT ${COLS} ${base} AND p.id IN (SELECT local_id FROM external_ids WHERE practice_id = ? AND kind = 'patient' AND lower(external_id) = ?)`, ...args, practiceId, text.toLowerCase());
    if (byOld.length) return byOld.slice(0, limit);
  }
  if (text.includes('@')) return db.all(`SELECT ${COLS} ${base} AND lower(p.email) LIKE ? LIMIT ?`, ...args, `%${text.toLowerCase()}%`, limit);
  const words = clean(text).split(/[\s,]+/).filter(Boolean);
  if (!words.length) return [];
  // Candidates: names starting with the same two letters as a typed word, or the same first letter and a similar
  // length (for typos after the first letter). Scored in code, so near misses still come up.
  const conds = [];
  const cargs = [];
  for (const w of words) {
    for (const col of ['p.first_name', 'p.last_name', 'p.preferred_name']) {
      conds.push(`lower(${col}) LIKE ?`);
      cargs.push(`${w.slice(0, 2)}%`);
      if (w.length >= 3) {
        conds.push(`(lower(${col}) LIKE ? AND length(${col}) BETWEEN ? AND ?)`);
        cargs.push(`${w[0]}%`, w.length - 2, w.length + 12);
      }
    }
    if (w.length >= 3) { conds.push('(lower(p.last_name) LIKE ? OR lower(p.first_name) LIKE ?)'); cargs.push(`%${w}%`, `%${w}%`); }
  }
  const rows = await db.all(`SELECT ${COLS} ${base} AND (${conds.join(' OR ')}) LIMIT 2000`, ...args, ...cargs);
  return rows
    .map((p) => ({ p, s: nameScore(words, p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.p.status === 'active' ? -1 : 0) - (b.p.status === 'active' ? -1 : 0) || a.p.last_name.localeCompare(b.p.last_name) || a.p.first_name.localeCompare(b.p.first_name))
    .slice(0, limit)
    .map((x) => x.p);
}
