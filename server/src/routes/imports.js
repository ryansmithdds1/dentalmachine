import { Router } from 'express';
import { raiseIssue, resolveIssue } from '../issues.js';
import { setActor } from '../actor.js';
import { HttpError } from '../auth.js';
import { insert, audit } from '../util.js';
import { FIELDS, KINDS, SOURCES, SOURCE_NAMES, Importer, detectMapping, missingRequired, undoBatch } from '../importer.js';
import { OD_TABLES, stageRows, runConversion } from '../conversion/opendental.js';
import { VENDORS, MAPPABLE, vendorFor, vendorList, planFiles, stageFile, checkConversion, runFull, progressOf } from '../conversion/pipeline.js';

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

  // ---- Full conversion from an Open Dental backup ----
  // The browser reads the backup and sends the rows of the tables we convert (staged), then asks the server
  // to run the conversion a slice at a time until it's done.
  r.post('/imports/opendental', async (req, res) => {
    const id = await insert(db, 'import_batches', {
      practice_id: req.user.practice_id, source: 'opendental', kind: 'full', filename: String(req.body?.filename || '').slice(0, 200) || null, created_by: req.user.id,
    });
    await audit(db, req, 'import.start', 'import_batches', id, { kind: 'full', source: 'opendental' });
    res.status(201).json({ id, tables: OD_TABLES });
  });

  const fullBatch = async (req) => {
    const b = await openBatch(req);
    if (b.kind !== 'full') throw new HttpError(400, 'Not a full conversion');
    return b;
  };

  r.post('/imports/opendental/:bid/rows', async (req, res) => {
    const batch = await fullBatch(req);
    if (JSON.parse(batch.pending || '{}').step) throw new HttpError(409, 'The conversion has started — no more rows can be added');
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length > 2000) throw new HttpError(400, 'rows must be a list of up to 2000 rows');
    try {
      await db.tx(() => stageRows(db, batch, req.body?.table, rows));
    } catch (err) {
      if (err.status === 400) throw new HttpError(400, err.message);
      throw err;
    }
    res.json({ ok: true, staged: rows.length });
  });

  // Work done on the records during a conversion is the import's, started by this person (audit source "import").
  const asImport = (req, batch) => setActor({ source: 'import', actor: `${SOURCE_NAMES[batch.source] || batch.source} conversion #${batch.id} (started by ${req.user.name})` });

  r.post('/imports/opendental/:bid/run', async (req, res) => {
    const batch = await fullBatch(req);
    asImport(req, batch);
    const out = await runConversion(db, batch, { budgetMs: Math.min(Number(req.body?.budget_ms) || 15_000, 20_000) });
    if (out.done) await audit(db, req, 'import.finish', 'import_batches', batch.id, { kind: 'full', counts: out.counts });
    res.json(out);
  });

  // ---- Full conversion from Dentrix, Eaglesoft or Curve exports (conversion/pipeline.js) ----
  // The browser unzips the export and sends each file's headers; we say which table each file is and which
  // columns we use. It then sends those columns' rows, asks for the dry run (as often as the office changes a
  // mapping), and finally runs the import a slice at a time.
  r.get('/imports/convert/sources', (_req, res) => {
    res.json({ sources: vendorList(), mappable: MAPPABLE });
  });

  r.post('/imports/convert', async (req, res) => {
    const vendor = VENDORS[req.body?.source];
    if (!vendor) throw new HttpError(400, `source must be one of: ${Object.keys(VENDORS).join(', ')}`);
    const files = req.body?.files;
    if (!Array.isArray(files) || !files.length || files.length > 300) throw new HttpError(400, 'files must list up to 300 files from the export');
    for (const f of files) {
      if (typeof f?.name !== 'string' || !f.name || f.name.length > 300) throw new HttpError(400, 'Each file needs a name');
      if (!Array.isArray(f.headers) || f.headers.length > 300) throw new HttpError(400, `${f.name}: headers must be a list of up to 300 columns`);
    }
    const plan = planFiles(vendor, files);
    if (!plan.some((f) => f.table === 'patients')) throw new HttpError(400, `We couldn't find a patient list in this export. Check it's a ${vendor.name} export with the patients file included.`);
    const id = await insert(db, 'import_batches', {
      practice_id: req.user.practice_id, source: vendor.id, kind: 'full', filename: String(req.body?.filename || '').slice(0, 200) || null, created_by: req.user.id,
      pending: JSON.stringify({ files: plan.map((f) => ({ name: f.name, table: f.table, label: f.label || null, rows: 0, dropped: f.dropped.slice(0, 60) })) }),
    });
    await audit(db, req, 'import.start', 'import_batches', id, { kind: 'full', source: vendor.id, files: plan.map((f) => [f.name, f.table]) });
    res.status(201).json({ id, files: plan });
  });

  const convertBatch = async (req) => {
    const b = await openBatch(req);
    if (b.kind !== 'full' || !VENDORS[b.source]) throw new HttpError(400, 'Not a Dentrix, Eaglesoft or Curve conversion');
    return b;
  };

  r.post('/imports/convert/:bid/rows', async (req, res) => {
    const batch = await convertBatch(req);
    const { file, table, headers, rows } = req.body || {};
    if (!Array.isArray(rows) || rows.length > 2000) throw new HttpError(400, 'rows must be a list of up to 2000 rows');
    const state = JSON.parse(batch.pending || '{}');
    if (state.step) throw new HttpError(409, 'The import has started — no more rows can be added');
    const planned = (state.files || []).find((f) => f.name === file);
    if (!planned || planned.table !== table) throw new HttpError(400, `${file} isn't a file this conversion reads as ${table}`);
    try {
      await db.tx(async () => {
        await stageFile(db, batch, vendorFor(batch.source), { file, table, headers, rows });
        // Staging changes what the dry run would say: it has to be run again before importing.
        const cur = JSON.parse((await db.get('SELECT pending FROM import_batches WHERE id = ?', batch.id)).pending || '{}');
        const f = cur.files.find((x) => x.name === file);
        f.rows += rows.length;
        cur.checked = false;
        await db.run('UPDATE import_batches SET pending = ?, total_rows = total_rows + ? WHERE id = ?', JSON.stringify(cur), rows.length, batch.id);
      });
    } catch (err) {
      if (err.status === 400) throw new HttpError(400, err.message);
      throw err;
    }
    res.json({ ok: true, staged: rows.length });
  });

  // Office's choices for values we couldn't map: { kind: { old value: our value } }, checked here.
  const cleanChoices = async (req, raw) => {
    if (raw == null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'mapping must be an object');
    const out = {};
    let n = 0;
    for (const [kind, values] of Object.entries(raw)) {
      if (!MAPPABLE[kind]) throw new HttpError(400, `Unknown mapping ${kind}`);
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new HttpError(400, `mapping.${kind} must be an object`);
      for (const [from, to] of Object.entries(values)) {
        if (++n > 2000) throw new HttpError(400, 'Too many mappings');
        if (to == null || to === '') continue;
        const key = String(from).trim().toLowerCase().slice(0, 100);
        const val = String(to).trim();
        if (kind === 'provider') {
          if (val !== 'none' && !await db.get('SELECT id FROM providers WHERE id = ? AND practice_id = ?', Number(val), req.user.practice_id)) throw new HttpError(400, `Provider ${val} isn't one of this practice's providers`);
        } else if (kind === 'procedure_code') {
          if (val !== 'skip' && !/^D\d{4}$/.test(val.toUpperCase())) throw new HttpError(400, `${val} isn't a CDT code (D followed by four digits) — or choose to leave it out`);
        } else if (!MAPPABLE[kind].choices.includes(val)) throw new HttpError(400, `${val} isn't a choice for ${MAPPABLE[kind].label}`);
        (out[kind] ||= {})[key] = kind === 'procedure_code' && val !== 'skip' ? val.toUpperCase() : val;
      }
    }
    return out;
  };

  // The dry run: nothing is written except the office's choices and the summary.
  r.post('/imports/convert/:bid/check', async (req, res) => {
    const batch = await convertBatch(req);
    const state = JSON.parse(batch.pending || '{}');
    if (state.step) throw new HttpError(409, 'The import has already started');
    const choices = await cleanChoices(req, req.body?.mapping);
    if (choices) {
      await db.run('UPDATE import_batches SET mapping = ? WHERE id = ?', JSON.stringify(choices), batch.id);
      batch.mapping = JSON.stringify(choices);
    }
    let summary;
    try {
      summary = await checkConversion(db, batch, vendorFor(batch.source));
    } catch (err) {
      if (err.status === 400) throw new HttpError(400, err.message);
      throw err;
    }
    state.checked = true;
    state.summary = { checked_at: summary.checked_at, ar: summary.ar };
    await db.run('UPDATE import_batches SET pending = ? WHERE id = ?', JSON.stringify(state), batch.id);
    await audit(db, req, 'import.check', 'import_batches', batch.id, { source: batch.source, unmapped: summary.unmapped.length, ar: summary.ar.source });
    res.json({ ...summary, files: state.files || [] });
  });

  r.post('/imports/convert/:bid/run', async (req, res) => {
    const batch = await convertBatch(req);
    asImport(req, batch);
    let out;
    try {
      out = await runFull(db, batch, vendorFor(batch.source), { budgetMs: Math.min(Number(req.body?.budget_ms) || 15_000, 20_000) });
    } catch (err) {
      if (err.status === 409) throw new HttpError(409, err.message);
      throw err;
    }
    if (out.done) {
      const left = out.reconcile.rows.reduce((t, x) => t + x.left, 0);
      await audit(db, req, 'import.finish', 'import_batches', batch.id, { kind: 'full', source: batch.source, reconcile: out.reconcile.rows.map((x) => [x.step, x.source, x.brought, x.left]), ar: out.reconcile.ar });
      // Anything left out is a work item, not just a line on this screen.
      if (left || !out.reconcile.ar.matches) {
        await raiseIssue(db, {
          practiceId: req.user.practice_id, kind: 'import', key: `import:${batch.id}`, role: 'admin', entity: 'import_batches', entityId: batch.id,
          title: `${SOURCE_NAMES[batch.source]} conversion: ${left} record${left === 1 ? '' : 's'} couldn't be brought over${out.reconcile.ar.matches ? '' : ' and the balances don\'t match'}`,
          detail: 'Open Settings → Import from another system to see each one and why.',
        });
      } else await resolveIssue(db, req.user.practice_id, `import:${batch.id}`);
    }
    res.json(out);
  });

  // Status of a conversion (to show the result again after a reload).
  r.get('/imports/convert/:bid', async (req, res) => {
    const b = await db.get('SELECT * FROM import_batches WHERE id = ? AND practice_id = ?', Number(req.params.bid), req.user.practice_id);
    if (!b || b.kind !== 'full') throw new HttpError(404, 'Conversion not found');
    const state = JSON.parse(b.pending || '{}');
    res.json({ id: b.id, source: b.source, status: b.status, files: state.files || [], ...progressOf({ step: state.step || null, ...state }, JSON.parse(b.errors || '[]')) });
  });

  // Starting over before the import runs: the staged copy of the export is removed (scratch rows — a hard delete
  // is intended) and the batch closed. Nothing was imported, so there's nothing to undo.
  r.post('/imports/convert/:bid/cancel', async (req, res) => {
    const batch = await convertBatch(req);
    if (JSON.parse(batch.pending || '{}').step) throw new HttpError(409, 'The import has started — let it finish, then undo it from the history');
    await db.run('DELETE FROM conversion_rows WHERE batch_id = ?', batch.id);
    await db.run("UPDATE import_batches SET status = 'undone', finished_at = datetime('now') WHERE id = ?", batch.id);
    await audit(db, req, 'import.cancel', 'import_batches', batch.id, { source: batch.source });
    res.json({ ok: true });
  });

  r.post('/imports/:bid/rows', async (req, res) => {
    const batch = await openBatch(req);
    asImport(req, batch);
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
    asImport(req, batch);
    await db.tx(async () => {
      const importer = new Importer(db, req.user.practice_id, batch);
      importer.guarantors = JSON.parse(batch.pending || '[]');
      await importer.finish();
      await db.run("UPDATE import_batches SET status = 'done', pending = NULL, finished_at = datetime('now') WHERE id = ?", batch.id);
    });
    const b = await db.get('SELECT * FROM import_batches WHERE id = ?', batch.id);
    await audit(db, req, 'import.finish', 'import_batches', batch.id, { created: b.created_count, updated: b.updated_count, errors: b.error_count });
    if (b.error_count) {
      await raiseIssue(db, {
        practiceId: req.user.practice_id, kind: 'import', key: `import:${batch.id}`, role: 'admin', entity: 'import_batches', entityId: batch.id,
        title: `Import of ${b.kind}${b.filename ? ` (${b.filename})` : ''}: ${b.error_count} row${b.error_count === 1 ? '' : 's'} couldn't be brought in`, detail: 'Open Settings → Imports to see each row and why.',
      });
    }
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
