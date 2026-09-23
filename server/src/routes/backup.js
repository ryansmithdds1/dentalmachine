import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { HttpError } from '../auth.js';
import { audit } from '../util.js';
import { exportPractice, exportToObject, restorePractice, listBackups, BACKUP_FILE } from '../backup.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only administrators can manage backups')));

// Practice backups: download one now, see the automatic ones, and prove a backup restores.
export default function backupRoutes({ db, storage, config }) {
  const r = Router();
  r.use('/backup', requireAdmin);

  r.get('/backup', async (req, res) => {
    const documents = req.query.documents === 'true';
    await audit(db, req, 'backup.download', 'practices', req.user.practice_id, { documents });
    const day = new Date().toISOString().slice(0, 10);
    res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="dental-machine-backup-${day}.json.gz"`, 'Cache-Control': 'no-store' });
    // A download leaves the server unencrypted, so two-factor and signing secrets stay behind.
    Readable.from(exportPractice(db, req.user.practice_id, { storage, documents, secrets: false })).pipe(createGzip()).pipe(res);
  });

  r.get('/backup/status', async (req, res) => {
    res.json({
      automatic: !!config.backupDir, keep_days: config.backupKeep, documents: config.backupDocuments,
      database: db.dialect, file_storage: storage.driver, encrypted_files: storage.encrypted, encrypted_backups: !!config.backupKey,
      files: await listBackups(config.backupDir, req.user.practice_id),
    });
  });

  r.get('/backup/files/:name', async (req, res) => {
    const name = String(req.params.name);
    const m = BACKUP_FILE.exec(name);
    if (!config.backupDir || !m || Number(m[1]) !== req.user.practice_id) throw new HttpError(404, 'Backup not found');
    const files = await listBackups(config.backupDir, req.user.practice_id);
    if (!files.some((f) => f.name === name)) throw new HttpError(404, 'Backup not found');
    await audit(db, req, 'backup.download', 'practices', req.user.practice_id, { file: name });
    res.set({ 'Content-Type': m[3] ? 'application/octet-stream' : 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    createReadStream(join(config.backupDir, name)).pipe(res);
  });

  // Takes a fresh backup and restores it into a throwaway copy that is rolled back: every table must come back whole.
  r.post('/backup/test', async (req, res) => {
    const backup = await exportToObject(db, req.user.practice_id, {});
    const result = await restorePractice(db, backup, { copy: true, dryRun: true });
    const tables = Object.entries(backup.tables).map(([table, rows]) => ({ table, exported: rows.length, restored: result.counts[table] || 0 })).filter((t) => t.exported);
    const ok = tables.every((t) => t.exported === t.restored);
    await audit(db, req, 'backup.test', 'practices', req.user.practice_id, { ok });
    res.json({ ok, tables, rows: tables.reduce((s, t) => s + t.exported, 0) });
  });

  return r;
}
