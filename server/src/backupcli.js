// Backups from the command line.
//   node src/backupcli.js export <practice id> <file.json.gz> [--documents]
//   node src/backupcli.js restore <file.json[.gz]> [--copy]
// Restore creates a new practice from the file (onto a fresh server, or with --copy beside the original).
import { createReadStream, createWriteStream } from 'node:fs';
import { createGunzip, createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openDb } from './db.js';
import { loadConfig } from './app.js';
import { createStorage } from './storage.js';
import { exportPractice, restorePractice } from './backup.js';

const [cmd, arg, file] = process.argv.slice(2);
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const config = loadConfig();
const storage = createStorage({ dir: config.uploadDir, key: config.documentKey });
const db = await openDb();
try {
  if (cmd === 'export' && Number(arg) && file) {
    await pipeline(Readable.from(exportPractice(db, Number(arg), { storage, documents: flags.has('--documents') })), createGzip(), createWriteStream(file));
    console.log(`Practice ${arg} backed up to ${file}`);
  } else if (cmd === 'restore' && arg) {
    const chunks = [];
    const input = createReadStream(arg);
    for await (const c of arg.endsWith('.gz') ? input.pipe(createGunzip()) : input) chunks.push(c);
    const result = await restorePractice(db, JSON.parse(Buffer.concat(chunks).toString('utf8')), { storage, copy: flags.has('--copy') });
    const rows = Object.values(result.counts).reduce((a, b) => a + b, 0);
    console.log(`Restored as practice ${result.practice_id}: ${rows} rows, ${result.documents} document file(s).`);
  } else {
    console.log('Usage:\n  node src/backupcli.js export <practice id> <file.json.gz> [--documents]\n  node src/backupcli.js restore <file.json[.gz]> [--copy]');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err.status ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.close();
}
