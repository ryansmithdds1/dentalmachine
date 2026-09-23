import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { createGzip, gunzipSync } from 'node:zlib';
import { mkdir, readdir, rename, stat, unlink, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { schemaInfo } from './db.js';
import { HttpError } from './auth.js';
import { TABLE as IMPORT_TABLES } from './importer.js';

// Practice backups: every row the practice owns, in one JSON file, optionally with its documents.
// A backup restores as a new practice (on this server or a fresh one) with every ID remapped, so the
// same file works for disaster recovery, moving servers, and proving the backups actually restore.

export const FORMAT = 'dentalmachine-backup';
// Short-lived login and device state that has no business in a backup.
const SKIP = new Set(['portal_codes', 'password_resets', 'sso_logins', 'edi_sandbox_mailbox', 'bridge_agents', 'bridge_commands', 'staff_sessions']);

// Tables in the backup and how to find a practice's rows in each (directly, or through a parent row).
export function backupTables() {
  const info = schemaInfo();
  const out = [];
  for (const [table, cols] of info) {
    if (SKIP.has(table)) continue;
    if (table === 'practices') { out.push({ table, cols, where: 'id = ?' }); continue; }
    if (cols.some((c) => c.name === 'practice_id')) { out.push({ table, cols, where: 'practice_id = ?' }); continue; }
    const parent = cols.find((c) => c.notnull && c.ref && info.get(c.ref)?.some((x) => x.name === 'practice_id') && !SKIP.has(c.ref));
    if (parent) out.push({ table, cols, where: `${parent.name} IN (SELECT id FROM ${parent.ref} WHERE practice_id = ?)` });
  }
  return out;
}

// Streams the backup as JSON text, a table at a time, so big practices don't have to fit in memory.
// Without `secrets` (a download that leaves the server unencrypted), sign-in secrets are left out: staff
// re-enroll two-factor and webhook signing secrets are replaced after a restore.
const scrub = (table, row) => {
  if (table === 'users' && row.mfa_secret) return { ...row, mfa_secret: null, mfa_enabled: 0, mfa_last_step: null };
  if (table === 'webhook_endpoints') return { ...row, secret: `rotate-${randomBytes(16).toString('hex')}` };
  if (table === 'practices' && row.sso_client_secret) return { ...row, sso_client_secret: null };
  return row;
};

export async function* exportPractice(db, practiceId, { storage, documents = false, secrets = true } = {}) {
  yield `{"format":${JSON.stringify(FORMAT)},"version":1,"exported_at":${JSON.stringify(new Date().toISOString())},"practice_id":${Number(practiceId)},"tables":{`;
  let first = true;
  for (const { table, cols, where } of backupTables()) {
    const rows = await db.all(`SELECT * FROM ${table} WHERE ${where}${cols.some((c) => c.name === 'id') ? ' ORDER BY id' : ''}`, practiceId);
    yield `${first ? '' : ','}${JSON.stringify(table)}:[`;
    first = false;
    for (let i = 0; i < rows.length; i += 500) yield `${i ? ',' : ''}${rows.slice(i, i + 500).map((r) => JSON.stringify(secrets ? r : scrub(table, r))).join(',')}`;
    yield ']';
  }
  yield '}';
  if (documents && storage) {
    yield ',"documents":{';
    const docs = await db.all('SELECT id, storage_key, encrypted FROM documents WHERE practice_id = ? ORDER BY id', practiceId);
    let firstDoc = true;
    for (const d of docs) {
      let data = null;
      try {
        data = await storage.read(d.storage_key, !!d.encrypted);
      } catch {
        data = null; // missing file: the row is still restored, without its file
      }
      if (!data) continue;
      yield `${firstDoc ? '' : ','}${JSON.stringify(String(d.id))}:${JSON.stringify(Buffer.from(data).toString('base64'))}`;
      firstDoc = false;
    }
    yield '}';
  }
  yield '}\n';
}

export async function exportToObject(db, practiceId, opts) {
  let text = '';
  for await (const part of exportPractice(db, practiceId, opts)) text += part;
  return JSON.parse(text);
}

// Old-system ID → new ID, per table.
function remapper() {
  const maps = new Map();
  return {
    set(table, oldId, newId) {
      if (!maps.has(table)) maps.set(table, new Map());
      maps.get(table).set(Number(oldId), newId);
    },
    get(table, oldId) {
      return oldId == null ? null : maps.get(table)?.get(Number(oldId));
    },
    has: (table) => maps.has(table),
  };
}

// Restores a backup as a new practice and returns its ID. With `copy`, it can sit beside the original on
// the same server: staff emails get a +restored tag and one-time links are reset. Runs in one transaction.
export async function restorePractice(db, backup, { storage = null, copy = false, dryRun = false } = {}) {
  if (backup?.format !== FORMAT || !backup.tables?.practices?.length) throw new HttpError(400, 'This is not a Dental Machine backup file');
  const tables = backupTables();
  const byName = new Map(tables.map((t) => [t.table, t]));
  // Insert order: a table comes after every table it needs (NOT NULL references). Other references are
  // filled in afterwards, so cycles and self-references (guarantors, corrected claims) don't matter.
  const order = [];
  const seen = new Set();
  const visit = (name, stack = new Set()) => {
    if (seen.has(name) || !byName.has(name)) return;
    if (stack.has(name)) throw new Error(`Circular required reference at ${name}`);
    stack.add(name);
    for (const c of byName.get(name).cols) if (c.ref && c.notnull && c.ref !== name) visit(c.ref, stack);
    stack.delete(name);
    seen.add(name);
    order.push(name);
  };
  for (const t of tables) visit(t.table);

  const ids = remapper();
  const later = []; // [table, newId, column, targetTable, oldValue]
  const counts = {};
  let newPractice;
  const run = async () => {
    for (const table of order) {
      const rows = backup.tables[table] || [];
      const { cols } = byName.get(table);
      const known = new Map(cols.map((c) => [c.name, c]));
      for (const src of rows) {
        const row = {};
        const pending = [];
        for (const [k, v] of Object.entries(src)) {
          if (k === 'id' || !known.has(k)) continue; // columns this version doesn't have are dropped
          const col = known.get(k);
          if (col.ref && v != null) {
            const mapped = ids.get(col.ref, v);
            if (mapped != null) row[k] = mapped;
            else if (col.notnull) throw new Error(`${table} #${src.id}: ${k} points at a missing ${col.ref} row`);
            else { row[k] = null; pending.push([k, col.ref, v]); }
          } else row[k] = v;
        }
        if (table === 'practices') {
          row.slug = copy ? null : row.slug;
          if (copy) { row.name = `${row.name} (restored copy)`; row.sso_client_id = null; row.sso_client_secret = null; }
        }
        if (copy) {
          if (table === 'users') row.email = String(row.email).replace('@', `+restored${Date.now().toString(36)}@`);
          if (table === 'appointments') row.confirm_token_hash = null;
          if (table === 'treatment_plans') row.sign_token_hash = null;
          if (table === 'form_requests') row.token_hash = randomBytes(32).toString('hex');
          if (table === 'edi_inbox') row.hash = `${row.hash}:${randomBytes(4).toString('hex')}`;
        }
        const keys = Object.keys(row);
        const { id } = await db.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k]));
        ids.set(table, src.id, id);
        if (table === 'practices') newPractice = id;
        for (const [k, ref, v] of pending) later.push([table, id, k, ref, v]);
        counts[table] = (counts[table] || 0) + 1;
      }
    }
    // References that pointed forward (or at the same table).
    for (const [table, id, column, target, oldValue] of later) {
      const mapped = ids.get(target, oldValue);
      if (mapped != null) await db.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, mapped, id);
    }
    // IDs kept in text or keyed by a table name.
    for (const src of backup.tables.audit_log || []) {
      const mapped = src.entity && src.entity_id != null && ids.get(src.entity, src.entity_id);
      if (mapped) await db.run('UPDATE audit_log SET entity_id = ? WHERE id = ?', mapped, ids.get('audit_log', src.id));
    }
    for (const src of backup.tables.external_ids || []) {
      const mapped = ids.get(IMPORT_TABLES[src.kind], src.local_id);
      if (mapped) await db.run('UPDATE external_ids SET local_id = ? WHERE id = ?', mapped, ids.get('external_ids', src.id));
    }
    for (const src of backup.tables.conversation_state || []) {
      const m = /^p(\d+)$/.exec(src.thread || '');
      if (m && ids.get('patients', m[1])) await db.run('UPDATE conversation_state SET thread = ? WHERE id = ?', `p${ids.get('patients', m[1])}`, ids.get('conversation_state', src.id));
    }
    // Document files travel inside the backup; they're stored (and encrypted) again under the new practice.
    if (storage && !dryRun) {
      for (const [oldId, b64] of Object.entries(backup.documents || {})) {
        const docId = ids.get('documents', oldId);
        if (!docId) continue;
        const { storageKey, encrypted } = await storage.save(newPractice, Buffer.from(b64, 'base64'));
        await db.run('UPDATE documents SET storage_key = ?, encrypted = ? WHERE id = ?', storageKey, encrypted ? 1 : 0, docId);
      }
    }
  };
  const ROLLBACK = Symbol('rollback');
  try {
    await db.tx(async () => {
      await run();
      if (dryRun) throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) {
      if (/unique|duplicate key/i.test(err.message)) throw new HttpError(409, 'This practice (its web address or staff logins) already exists on this server. Restore it as a copy, or onto a new server.');
      throw err;
    }
  }
  return { practice_id: dryRun ? null : newPractice, counts, documents: Object.keys(backup.documents || {}).length };
}

// ---- Encryption ----
// With BACKUP_ENCRYPTION_KEY set, backup files are AES-256-GCM encrypted: "DMBK1" · 12-byte IV · ciphertext
// of the gzipped JSON · 16-byte tag. Files are written readable by the server's user only (0600).
const MAGIC = Buffer.from('DMBK1');
const aesKey = (key) => createHash('sha256').update(String(key)).digest();
export const isEncryptedBackup = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, MAGIC.length).equals(MAGIC);

// Gzips (and, with a key, encrypts) a stream of text into a file.
export async function writeBackupFile(path, source, key = null) {
  const gz = Readable.from(source).pipe(createGzip());
  if (!key) return pipeline(gz, createWriteStream(path, { mode: 0o600 }));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey(key), iv);
  async function* sealed() {
    yield MAGIC;
    yield iv;
    for await (const chunk of gz) yield cipher.update(chunk);
    yield cipher.final();
    yield cipher.getAuthTag();
  }
  return pipeline(Readable.from(sealed()), createWriteStream(path, { mode: 0o600 }));
}

// A backup file's JSON text: decrypted (with the key) and unzipped as needed.
// `key` may be a list: the current key and earlier ones (BACKUP_ENCRYPTION_KEY_PREVIOUS), so backups made
// before a key change can still be restored.
export function readBackupFile(buf, key = null) {
  let data = buf;
  if (isEncryptedBackup(buf)) {
    const keys = (Array.isArray(key) ? key : [key]).filter(Boolean);
    if (!keys.length) throw new HttpError(400, 'This backup is encrypted — set BACKUP_ENCRYPTION_KEY to the key it was made with');
    const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
    data = null;
    for (const k of keys) {
      const decipher = createDecipheriv('aes-256-gcm', aesKey(k), iv);
      decipher.setAuthTag(buf.subarray(buf.length - 16));
      try {
        data = Buffer.concat([decipher.update(buf.subarray(MAGIC.length + 12, buf.length - 16)), decipher.final()]);
        break;
      } catch { /* try the next key */ }
    }
    if (!data) throw new HttpError(400, 'This backup could not be decrypted — wrong BACKUP_ENCRYPTION_KEY (or _PREVIOUS), or the file is damaged');
  }
  return (data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data).toString('utf8');
}

// ---- Automatic backups to a folder (a mounted volume or synced bucket) ----
const stamp = (d = new Date()) => d.toISOString().slice(0, 10);
export const BACKUP_FILE = /^practice-(\d+)-(\d{4}-\d{2}-\d{2})\.json\.gz(\.enc)?$/;

export async function runAutomaticBackups(db, { dir, keep = 14, storage, documents = false, now = new Date(), key = null }) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const existing = new Set(await readdir(dir));
  const made = [];
  const ext = key ? '.json.gz.enc' : '.json.gz';
  const practices = await db.all('SELECT id FROM practices ORDER BY id');
  for (const { id } of practices) {
    const name = `practice-${id}-${stamp(now)}${ext}`;
    if (existing.has(name)) continue;
    const tmp = join(dir, `.${name}.tmp`);
    await writeBackupFile(tmp, exportPractice(db, id, { storage, documents }), key);
    await rename(tmp, join(dir, name));
    made.push(name);
  }
  // SQLite: a copy of the whole database file too (encrypted the same way when there's a key).
  const snap = `database-${stamp(now)}.sqlite${key ? '.enc' : ''}`;
  if (db.dialect === 'sqlite' && db.snapshot && !existing.has(snap)) {
    const raw = join(dir, `.database-${stamp(now)}.tmp`);
    await db.snapshot(raw);
    if (key) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', aesKey(key), iv);
      const body = Buffer.concat([cipher.update(await readFile(raw)), cipher.final()]);
      await writeFile(join(dir, snap), Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]), { mode: 0o600 });
      await unlink(raw);
    } else {
      await rename(raw, join(dir, snap));
    }
    made.push(snap);
  }
  // Keep the newest `keep` days of each series.
  const cutoff = stamp(new Date(now.getTime() - keep * 86400000));
  for (const f of await readdir(dir)) {
    const m = /-(\d{4}-\d{2}-\d{2})\.(json\.gz|sqlite)(\.enc)?$/.exec(f);
    if (m && m[1] < cutoff) await unlink(join(dir, f)).catch(() => {});
  }
  return made;
}

export async function listBackups(dir, practiceId) {
  if (!dir) return [];
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const mine = files.filter((f) => BACKUP_FILE.test(f) && Number(BACKUP_FILE.exec(f)[1]) === Number(practiceId)).sort().reverse();
  return Promise.all(mine.map(async (f) => ({ name: f, date: /(\d{4}-\d{2}-\d{2})/.exec(f)[1], size: (await stat(join(dir, f))).size })));
}
