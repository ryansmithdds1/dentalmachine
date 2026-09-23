import { Router } from 'express';
import { HttpError } from '../auth.js';
import { insert, audit } from '../util.js';
import { FIELDS, KINDS, SOURCES, SOURCE_NAMES, Importer, detectMapping, missingRequired, undoBatch } from '../importer.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only administrators can import data')));
const ROLLBACK = Symbol('rollback');
const MAX_ROWS = 1000;

// Converting from another practice system: preview a file, then send its rows in chunks.
export default function importRoutes({ db }) {
  const r = Router();
  r.use('/imports', requireAdmin);

  const checkMapping = (kind, headers, mapping) => {
    const m = mapping && typeof mapping === 'object' ? mapping : detectMapping(kind, headers);
    const clean = {};
    for (const [field, i] of Object.entries(m)) {
      if (!Object.hasOwn(FIELDS[kind], field)) throw new HttpError(400, `Unknown field ${field}`);
      if (i === null || i === '' || i === undefined) continue;
      if (!Number.isInteger(Number(i)) || Number(i) < 0 || Number(i) >= headers.length) throw new HttpError(400, `Column for ${field} is out of range`);
      clean[field] = Number(i);
    }
    return clean;
  };
  const validKind = (body) => {
    if (!KINDS.includes(body?.kind)) throw new HttpError(400, `kind must be one of: ${KINDS.join(', ')}`);
    if (!SOURCES.includes(body?.source)) throw new HttpError(400, `source must be one of: ${SOURCES.join(', ')}`);
    if (!Array.isArray(body.headers) || !body.headers.length) throw new HttpError(400, 'headers are required');
  };
  const validRows = (rows) => {
    if (!Array.isArray(rows) || rows.length > MAX_ROWS || rows.some((x) => !Array.isArray(x))) throw new HttpError(400, `rows must be a list of up to ${MAX_ROWS} rows`);
  };
  // Cells are capped (a note can be long; nothing needs more than this).
  const mapRow = (mapping, cells) => Object.fromEntries(Object.entries(mapping).map(([f, i]) => [f, cells[i] == null ? '' : String(cells[i]).slice(0, 20_000)]));

  // Runs rows, each in its own savepoint so one bad row doesn't stop the rest.
  const runRows = async (importer, kind, mapping, rows, offset) => {
    const results = [];
    for (const [i, cells] of rows.entries()) {
      const line = offset + i + 2; // +1 for the header row, +1 for 1-based lines
      try {
        results.push({ line, status: await db.savepoint(() => importer.row(kind, mapRow(mapping, cells))) });
      } catch (err) {
        if (err.status >= 500 || (!err.status && !(err instanceof Error))) throw err;
        results.push({ line, status: 'error', error: err.message });
      }
    }
    return results;
  };

  r.get('/imports/fields', (_req, res) => {
    res.json({ sources: SOURCES.map((s) => ({ id: s, name: SOURCE_NAMES[s] })), kinds: KINDS, fields: Object.fromEntries(KINDS.map((k) => [k, Object.keys(FIELDS[k])])) });
  });

  r.get('/imports', async (req, res) => {
    res.json(await db.all(
      `SELECT b.id, b.source, b.kind, b.filename, b.status, b.total_rows, b.created_count, b.updated_count, b.skipped_count, b.error_count, b.created_at, b.finished_at, u.name AS created_by_name
       FROM import_batches b LEFT JOIN users u ON u.id = b.created_by WHERE b.practice_id = ? ORDER BY b.id DESC LIMIT 100`, req.user.practice_id,
    ));
  });

  r.get('/imports/:bid', async (req, res) => {
    const b = await db.get('SELECT * FROM import_batches WHERE id = ? AND practice_id = ?', Number(req.params.bid), req.user.practice_id);
    if (!b) throw new HttpError(404, 'Import not found');
    res.json({ ...b, errors: JSON.parse(b.errors || '[]'), mapping: JSON.parse(b.mapping || '{}') });
  });

  // Dry run: which column feeds which field, and what the first rows would do. Nothing is saved.
  r.post('/imports/preview', async (req, res) => {
    validKind(req.body);
    const { kind, source, headers } = req.body;
    const rows = (req.body.rows || []).slice(0, 25);
    validRows(rows);
    const mapping = checkMapping(kind, headers, req.body.mapping);
    const missing = missingRequired(kind, mapping);
    let results = [];
    if (!missing.length) {
      try {
        await db.tx(async () => {
          const importer = new Importer(db, req.user.practice_id, { id: null, source, created_by: req.user.id });
          results = await runRows(importer, kind, mapping, rows, 0);
          throw ROLLBACK;
        });
      } catch (err) {
        if (err !== ROLLBACK) throw err;
      }
    }
    res.json({ mapping, missing, detected: detectMapping(kind, headers), results, sample: rows.slice(0, 10).map((cells) => mapRow(mapping, cells)) });
  });

  r.post('/imports', async (req, res) => {
    validKind(req.body);
    const { kind, source, headers } = req.body;
    const mapping = checkMapping(kind, headers, req.body.mapping);
    const missing = missingRequired(kind, mapping);
    if (missing.length) throw new HttpError(400, `Choose a column for: ${missing.join(', ')}`);
    const id = await insert(db, 'import_batches', {
      practice_id: req.user.practice_id, source, kind, filename: String(req.body.filename || '').slice(0, 200) || null,
      mapping: JSON.stringify(mapping), total_rows: Math.max(0, Number(req.body.total) || 0), created_by: req.user.id,
    });
    await audit(db, req, 'import.start', 'import_batches', id, { kind, source });
    res.status(201).json({ id, mapping });
  });

  const openBatch = async (req) => {
    const b = await db.get('SELECT * FROM import_batches WHERE id = ? AND practice_id = ?', Number(req.params.bid), req.user.practice_id);
    if (!b) throw new HttpError(404, 'Import not found');
    if (b.status !== 'running') throw new HttpError(409, 'This import is already finished');
    return b;
  };

  r.post('/imports/:bid/rows', async (req, res) => {
    const batch = await openBatch(req);
    validRows(req.body?.rows);
    const offset = Math.max(0, Number(req.body.offset) || 0);
    const mapping = JSON.parse(batch.mapping);
    const results = await db.tx(async () => {
      const importer = new Importer(db, req.user.practice_id, batch);
      const out = await runRows(importer, batch.kind, mapping, req.body.rows, offset);
      // Guarantors further down the file (or in a later chunk) are linked when the import finishes.
      if (importer.guarantors?.length) {
        const pending = JSON.parse((await db.get('SELECT pending FROM import_batches WHERE id = ?', batch.id)).pending || '[]');
        await db.run('UPDATE import_batches SET pending = ? WHERE id = ?', JSON.stringify(pending.concat(importer.guarantors)), batch.id);
      }
      const count = (s) => out.filter((x) => x.status === s).length;
      const errors = out.filter((x) => x.status === 'error').map(({ line, error }) => ({ line, error }));
      const prev = JSON.parse((await db.get('SELECT errors FROM import_batches WHERE id = ?', batch.id)).errors || '[]');
      await db.run(
        `UPDATE import_batches SET created_count = created_count + ?, updated_count = updated_count + ?, skipped_count = skipped_count + ?,
           error_count = error_count + ?, errors = ? WHERE id = ?`,
        count('created'), count('updated'), count('skipped'), errors.length, JSON.stringify(prev.concat(errors).slice(0, 500)), batch.id,
      );
      return out;
    });
    const count = (s) => results.filter((x) => x.status === s).length;
    res.json({ created: count('created'), updated: count('updated'), skipped: count('skipped'), errors: results.filter((x) => x.status === 'error') });
  });

  r.post('/imports/:bid/finish', async (req, res) => {
    const batch = await openBatch(req);
    await db.tx(async () => {
      const importer = new Importer(db, req.user.practice_id, batch);
      importer.guarantors = JSON.parse(batch.pending || '[]');
      await importer.finish();
      await db.run("UPDATE import_batches SET status = 'done', pending = NULL, finished_at = datetime('now') WHERE id = ?", batch.id);
    });
    const b = await db.get('SELECT * FROM import_batches WHERE id = ?', batch.id);
    await audit(db, req, 'import.finish', 'import_batches', batch.id, { created: b.created_count, updated: b.updated_count, errors: b.error_count });
    res.json({ ...b, errors: JSON.parse(b.errors || '[]'), mapping: JSON.parse(b.mapping || '{}') });
  });

  // Removes what an import created (not what it updated). Refused once the records are in use.
  r.post('/imports/:bid/undo', async (req, res) => {
    const b = await db.get('SELECT * FROM import_batches WHERE id = ? AND practice_id = ?', Number(req.params.bid), req.user.practice_id);
    if (!b) throw new HttpError(404, 'Import not found');
    if (b.status === 'undone') throw new HttpError(409, 'This import was already undone');
    let removed;
    try {
      removed = await undoBatch(db, req.user.practice_id, b.id);
    } catch (err) {
      if (/foreign key|violates/i.test(err.message)) throw new HttpError(409, 'Some imported records have been used since (visits, payments, claims or later imports point at them), so this import can no longer be undone.');
      throw err;
    }
    await audit(db, req, 'import.undo', 'import_batches', b.id, removed);
    res.json({ ok: true, removed });
  });

  return r;
}
