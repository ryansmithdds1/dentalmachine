// Vercel serverless entry: the whole API as one function. The app (database pool, migrations and,
// for trial deployments, the demo practice) is set up once per warm instance and reused.
import { openDb } from '../server/src/db.js';
import { createApp, loadConfig } from '../server/src/app.js';
import { createMessenger } from '../server/src/messaging.js';
import { seedDemo } from '../server/src/demo.js';
import { runThemedDemoBatch } from '../server/src/themeddemo.js';
import { productionProblems } from '../server/src/preflight.js';

let ready = null;

async function boot() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET must be set');
  const problems = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production' ? productionProblems() : [];
  if (problems.length) throw new Error(`Refusing to start: ${problems.join('; ')}`);
  if (!process.env.REDIS_URL) console.warn('REDIS_URL is not set: sign-in and public-page limits are counted per server copy (acceptable for a demo; required with real patient data)');
  const db = await openDb();
  if (process.env.DEMO_SEED === 'on') await seedDemo(db);
  const app = createApp({ db, secret: process.env.JWT_SECRET, config: loadConfig(), messenger: createMessenger() });
  if (process.env.DEMO_THEMED === 'on') themed = { db, storage: app.locals.storage, done: false, nextTry: 0 };
  return app;
}

// The themed demo practice (DEMO_THEMED=on, server/src/themeddemo.js) is loaded a batch at a time, because a
// function call can't run long enough to load it all: a batch starts with the first request of each server copy and
// again with later requests until it's finished, one at a time here (a lease in the database keeps other copies out).
// Each batch is its own transactions, so one cut off by a time limit is simply carried on by the next.
let themed = null;
let themedRun = null;
function advanceThemed() {
  if (!themed || themed.done || themedRun || Date.now() < themed.nextTry) return;
  themedRun = runThemedDemoBatch(themed.db, { seconds: Number(process.env.THEMED_DEMO_BATCH_SECONDS) || 20, storage: themed.storage })
    .then((out) => {
      if (out.done) themed.done = true;
      if (out.busy) themed.nextTry = Date.now() + 15_000; // another server copy is on it
      if (out.steps) console.log(`Themed demo practice: ${out.done ? 'loaded' : `${out.phase} ${out.cursor}`} (${out.steps} steps, ${out.ms} ms)`);
    })
    .catch((err) => console.error('Themed demo practice: a batch failed; the next request carries on from the last finished step.', err))
    .finally(() => { themedRun = null; });
  // Keep the function alive until the batch ends (Vercel's waitUntil), without holding up this response.
  globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil?.(themedRun);
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
  advanceThemed();
  return app(req, res);
}
