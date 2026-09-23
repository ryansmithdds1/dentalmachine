// Moves everything encrypted onto the current keys after a key change.
//   1. Put the new key in DOCUMENT_ENCRYPTION_KEY (or JWT_SECRET) and the old one in
//      DOCUMENT_ENCRYPTION_KEY_PREVIOUS (or JWT_SECRET_PREVIOUS), and restart.
//   2. npm run rotate-keys   (safe to run again; files already on the new key are skipped)
//   3. Remove the _PREVIOUS setting once it reports nothing left on old keys.
// Backups made before the change stay under the old backup key: keep BACKUP_ENCRYPTION_KEY_PREVIOUS
// until they age out (BACKUP_KEEP days).
import { openDb } from './db.js';
import { loadConfig } from './app.js';
import { createStorage } from './storage.js';
import { rotateKeys } from './rotation.js';

const config = loadConfig();
const db = await openDb();
try {
  const storage = createStorage({ dir: config.uploadDir, key: config.documentKey, previousKeys: config.documentKeysPrevious });
  const r = await rotateKeys(db, { storage, secret: process.env.JWT_SECRET });
  console.log(`Files re-encrypted: ${r.files} (already current: ${r.filesCurrent}, missing: ${r.missing}, failed: ${r.failed.length})`);
  console.log(`Stored secrets re-sealed: ${r.secrets} (already current: ${r.secretsCurrent})`);
  for (const f of r.failed.slice(0, 20)) console.log(`  could not read ${f}`);
  if (r.failed.length) process.exitCode = 1;
  else console.log('Nothing is left on old keys: the _PREVIOUS settings can be removed.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
