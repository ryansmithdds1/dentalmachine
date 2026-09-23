// Vercel serverless entry: the whole API as one function. The app (database pool, migrations and,
// for trial deployments, the demo practice) is set up once per warm instance and reused.
import { openDb } from '../server/src/db.js';
import { createApp, loadConfig } from '../server/src/app.js';
import { createMessenger } from '../server/src/messaging.js';
import { seedDemo } from '../server/src/demo.js';

let ready = null;

async function boot() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET must be set');
  const db = await openDb();
  if (process.env.DEMO_SEED === 'on') await seedDemo(db);
  return createApp({ db, secret: process.env.JWT_SECRET, config: loadConfig(), messenger: createMessenger() });
}

export default async function handler(req, res) {
  ready ??= boot().catch((err) => {
    ready = null;
    throw err;
  });
  const app = await ready;
  return app(req, res);
}
