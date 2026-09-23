import express from 'express';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate, HttpError } from './auth.js';
import authRoutes from './routes/auth.js';
import patientRoutes from './routes/patients.js';
import scheduleRoutes from './routes/schedule.js';
import clinicalRoutes from './routes/clinical.js';
import billingRoutes from './routes/billing.js';
import insuranceRoutes from './routes/insurance.js';
import settingsRoutes from './routes/settings.js';
import reportRoutes from './routes/reports.js';

export function createApp({ db, secret }) {
  if (!secret) throw new Error('JWT secret is required');
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    });
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes({ db, secret }));

  const api = express.Router();
  api.use(authenticate(db, secret));
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store'); // PHI must not be cached by intermediaries
    next();
  });
  api.use(patientRoutes({ db }));
  api.use(scheduleRoutes({ db }));
  api.use(clinicalRoutes({ db }));
  api.use(billingRoutes({ db }));
  api.use(insuranceRoutes({ db }));
  api.use(settingsRoutes({ db }));
  api.use(reportRoutes({ db }));
  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // Serve the built SPA in production.
  const dist = join(dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => res.sendFile(join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (String(err?.message).includes('FOREIGN KEY')) return res.status(400).json({ error: 'Referenced record does not exist' });
    if (String(err?.message).includes('UNIQUE')) return res.status(409).json({ error: 'Record already exists' });
    if (String(err?.message).includes('CHECK constraint')) return res.status(400).json({ error: 'Invalid value' });
    if (String(err?.message).includes('NOT NULL constraint')) {
      const field = String(err.message).split('.').pop();
      return res.status(400).json({ error: `${field} is required` });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
