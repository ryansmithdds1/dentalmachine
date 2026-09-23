import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createApp, loadConfig } from './app.js';
import { createMessenger, runReminders } from './messaging.js';
import { initCluster, runExclusive } from './cluster.js';
import { pollClearinghouse } from './clearinghouse.js';
import { runRecallSequences } from './recalls.js';
import { runAutopay } from './payments.js';
import { runAutomaticBackups } from './backup.js';

let secret = process.env.JWT_SECRET;
if (!secret) {
  if (process.env.NODE_ENV === 'production') {
    console.error('JWT_SECRET must be set in production');
    process.exit(1);
  }
  secret = randomBytes(32).toString('hex');
  console.warn('JWT_SECRET not set; using a random secret (sessions reset on restart)');
}

const db = await openDb();
const cluster = await initCluster();
const config = loadConfig();
const messenger = createMessenger();
const app = createApp({ db, secret, config, messenger });

// Appointment reminders every 10 minutes. With Redis, only one server runs each pass (REMINDERS=off disables).
if (process.env.REMINDERS !== 'off') {
  const tick = () => runExclusive('reminders', 5 * 60 * 1000, async () => (await runReminders(db, messenger, { appUrl: config.appUrl })) + (await runRecallSequences(db, messenger, { appUrl: config.appUrl })))
    .then((n) => n && console.log(`Sent ${n} appointment reminder(s)`))
    .catch((err) => console.error('Reminder job failed:', err));
  setInterval(tick, 10 * 60 * 1000).unref();
  setTimeout(tick, 5000).unref();
}
// Clearinghouse mailbox: acknowledgments, claim status and ERAs are picked up and posted automatically.
const ch = app.locals.clearinghouse;
if (ch?.batch && process.env.CLEARINGHOUSE_POLL !== 'off') {
  const poll = () => runExclusive('clearinghouse-poll', 10 * 60 * 1000, () => pollClearinghouse(db, ch))
    .then((files) => files?.length && console.log(`Clearinghouse: processed ${files.length} file(s)`))
    .catch((err) => console.error('Clearinghouse poll failed:', err.message));
  setInterval(poll, ch.pollMinutes * 60 * 1000).unref();
  setTimeout(poll, 15_000).unref();
}
// Nightly backups of every practice to BACKUP_DIR (checked hourly; a day's file is only written once).
// Documents are included when they live on this server's disk, unless BACKUP_DOCUMENTS says otherwise.
if (config.backupDir) {
  const storage = app.locals.storage;
  const backup = () => runExclusive('backups', 60 * 60 * 1000, () => runAutomaticBackups(db, { dir: config.backupDir, keep: config.backupKeep, storage, documents: config.backupDocuments ?? storage.driver === 'disk' }))
    .then((made) => made?.length && console.log(`Backups written: ${made.join(', ')}`))
    .catch((err) => console.error('Backup failed:', err.message));
  setInterval(backup, 60 * 60 * 1000).unref();
  setTimeout(backup, 60_000).unref();
}
// Payment-plan autopay: due installments are charged once a day (checked hourly).
if (app.locals.payments.enabled && process.env.AUTOPAY !== 'off') {
  const charge = () => runExclusive('autopay', 30 * 60 * 1000, () => runAutopay(db, app.locals.payments, messenger))
    .then((r) => r?.length && console.log(`Autopay: ${r.filter((x) => x.ok).length} charged, ${r.filter((x) => !x.ok).length} declined`))
    .catch((err) => console.error('Autopay failed:', err.message));
  setInterval(charge, 60 * 60 * 1000).unref();
  setTimeout(charge, 30_000).unref();
}
console.log(`Clearinghouse: ${ch?.name || 'manual'}${ch?.realtime ? ' + real-time eligibility/status' : ''}`);
console.log(`Database: ${db.dialect} · cluster: ${cluster.mode}`);
console.log(`Messaging drivers: sms=${messenger.status.sms} email=${messenger.status.email}`);
const port = Number(process.env.PORT) || 4000;
app.listen(port, () => console.log(`Dental Machine API listening on http://localhost:${port}`));
