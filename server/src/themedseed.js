// Loads the themed demo practice (Fellowship Dental Partners: Rivendell Family Dental and Stark Tower Smiles) to
// the end. Usage: npm run seed:themed   (THEMED_DEMO_SIZE=small|medium|large, default large)
// Safe to run again: it carries on from where it stopped and never adds a second copy.
import { openDb } from './db.js';
import { loadConfig } from './app.js';
import { createStorage } from './storage.js';
import { runThemedDemoBatch, themedSize, THEMED_ADMIN_EMAIL } from './themeddemo.js';
import { DEMO_PASSWORD } from './demo.js';

if (process.env.APP_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== '1') {
  console.error('Refusing to load demo data: APP_ENV=production. Seed a staging or demo database instead.');
  process.exit(1);
}
const db = await openDb();
const config = loadConfig();
const storage = createStorage({ dir: config.uploadDir, key: config.documentKey, previousKeys: config.documentKeysPrevious || [] });
const t0 = Date.now();
console.log(`Themed demo practice (${themedSize()}): loading…`);
let out;
do {
  out = await runThemedDemoBatch(db, { seconds: 5, storage });
  if (out.busy) { console.log('  another server is loading it; waiting…'); await new Promise((r) => setTimeout(r, 2000)); continue; }
  console.log(`  ${out.phase}${out.phase === 'done' ? '' : ` (${out.cursor})`} — ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} while (!out.done);
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s. Log in as ${THEMED_ADMIN_EMAIL} / ${DEMO_PASSWORD}`);
await db.close();
