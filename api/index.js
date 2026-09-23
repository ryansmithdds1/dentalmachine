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
  let app;
  try {
    app = await ready;
  } catch (err) {
    // Start-up failed (usually the database): answer plainly and try again on the next request.
    console.error('Startup failed:', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'The server is starting up or cannot reach its database. Try again shortly.' }));
  }
  return app(req, res);
}
