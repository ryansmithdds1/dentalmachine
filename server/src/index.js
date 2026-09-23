import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createApp, loadConfig } from './app.js';
import { createMessenger, runReminders } from './messaging.js';
import { initCluster, runExclusive } from './cluster.js';

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
  const tick = () => runExclusive('reminders', 5 * 60 * 1000, () => runReminders(db, messenger, { appUrl: config.appUrl }))
    .then((n) => n && console.log(`Sent ${n} appointment reminder(s)`))
    .catch((err) => console.error('Reminder job failed:', err));
  setInterval(tick, 10 * 60 * 1000).unref();
  setTimeout(tick, 5000).unref();
}
console.log(`Database: ${db.dialect} · cluster: ${cluster.mode}`);
console.log(`Messaging drivers: sms=${messenger.status.sms} email=${messenger.status.email}`);
const port = Number(process.env.PORT) || 4000;
app.listen(port, () => console.log(`Dental Machine API listening on http://localhost:${port}`));
