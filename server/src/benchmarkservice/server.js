// Runs the benchmark service on its own (BM5), separate from any practice's data:
//   BENCHMARK_DATABASE_URL=postgres://… PORT=4100 node src/benchmarkservice/server.js
// Put it behind TLS (the practice app refuses a plain-http BENCHMARK_URL). Settings:
//   BENCHMARK_MIN_PEERS     practices needed in a peer group before anything is shown (default 10, never under 5)
//   BENCHMARK_ENROLL_TOKEN  if set, a practice must present it to join (hand it out with the terms)
// It keeps only its own bms_* tables in its database (openDb also lays down the app's schema, unused here).
import express from 'express';
import { openDb } from '../db.js';
import { requestLogger, log } from '../monitoring.js';
import benchmarkServiceRoutes from './index.js';
import { ensureServiceSchema, serviceConfig } from './service.js';

const db = await openDb(process.env.BENCHMARK_DATABASE_URL || process.env.DATABASE_URL || './data/benchmarks.db');
await ensureServiceSchema(db);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.use(requestLogger());
app.use(benchmarkServiceRoutes({ db, config: serviceConfig() }));
const port = Number(process.env.PORT) || 4100;
app.listen(port, () => log.info(`Benchmark service listening on http://localhost:${port}`));
