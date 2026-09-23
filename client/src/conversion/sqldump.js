// Reads a MySQL dump (an Open Dental backup: `mysqldump opendental > backup.sql`) a line at a time and hands
// back the rows of the tables we convert, as objects keyed by lower-case column name. mysqldump writes each
// INSERT on one line (newlines inside text are escaped), and the column order comes from the CREATE TABLE
// just before it when the INSERT doesn't list columns.

export function createDumpReader(wanted, onRows) {
  const want = new Set(wanted.map((t) => t.toLowerCase()));
  const columns = new Map();
  let creating = null;
  let rest = '';

  const line = (text) => {
    if (creating) {
      const col = /^\s*`([^`]+)`\s/.exec(text);
      if (col) columns.get(creating).push(col[1].toLowerCase());
      if (/^\)/.test(text.trim())) creating = null;
      return;
    }
    const create = /^CREATE TABLE `([^`]+)`/i.exec(text);
    if (create) {
      const t = create[1].toLowerCase();
      if (want.has(t)) {
        creating = t;
        columns.set(t, []);
      }
      return;
    }
    const ins = /^INSERT INTO `([^`]+)`\s*(\(([^)]*)\))?\s*VALUES\s*/i.exec(text);
    if (!ins) return;
    const t = ins[1].toLowerCase();
    if (!want.has(t)) return;
    const cols = ins[3] ? ins[3].split(',').map((c) => c.trim().replace(/`/g, '').toLowerCase()) : columns.get(t);
    if (!cols?.length) throw new Error(`The backup has rows for ${t} before its table definition`);
    const rows = parseValues(text, ins[0].length).map((vals) => Object.fromEntries(cols.map((c, i) => [c, vals[i] ?? null])));
    if (rows.length) onRows(t, rows);
  };

  return {
    // Feed text as it arrives; whole lines are processed, a partial last line waits for the next chunk.
    push(chunk) {
      const text = rest + chunk;
      const lines = text.split('\n');
      rest = lines.pop();
      for (const l of lines) line(l.replace(/\r$/, ''));
    },
    end() {
      if (rest) line(rest);
      rest = '';
    },
  };
}

const ESC = { 0: '\0', n: '\n', r: '\r', t: '\t', Z: '\x1a', b: '\b' };

// `(1,'O\'Brien',NULL,-2.50),(2,...);` → [[1, "O'Brien", null, -2.5], ...]
export function parseValues(text, start = 0) {
  const rows = [];
  let i = start;
  const n = text.length;
  while (i < n) {
    while (i < n && text[i] !== '(') {
      if (text[i] === ';') return rows;
      i++;
    }
    if (i >= n) break;
    i++;
    const row = [];
    for (;;) {
      while (text[i] === ' ') i++;
      if (text[i] === "'") {
        let s = '';
        i++;
        for (;;) {
          const c = text[i];
          if (c === undefined) throw new Error('A text value in the backup is cut off');
          if (c === '\\') {
            const e = text[i + 1];
            s += ESC[e] ?? e;
            i += 2;
          } else if (c === "'" && text[i + 1] === "'") {
            s += "'";
            i += 2;
          } else if (c === "'") {
            i++;
            break;
          } else {
            s += c;
            i++;
          }
        }
        row.push(s);
      } else {
        let j = i;
        while (j < n && text[j] !== ',' && text[j] !== ')') j++;
        const raw = text.slice(i, j).trim();
        row.push(raw === 'NULL' ? null : raw.startsWith('0x') ? raw : Number.isFinite(Number(raw)) && raw !== '' ? Number(raw) : raw);
        i = j;
      }
      while (text[i] === ' ') i++;
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ')') { i++; break; }
      throw new Error('The backup has a row it can’t read');
    }
    rows.push(row);
  }
  return rows;
}
