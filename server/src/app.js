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
import engagementRoutes from './routes/engagement.js';
import publicRoutes from './routes/public.js';
import documentRoutes from './routes/documents.js';
import paymentRoutes, { stripeWebhook } from './routes/payments.js';
import familyRoutes from './routes/family.js';
import conversationRoutes, { smsWebhook } from './routes/sms.js';
import ediRoutes from './routes/edi.js';
import officeRoutes from './routes/office.js';
import ppoRoutes from './routes/ppo.js';
import frontDeskRoutes from './routes/frontdesk.js';
import casePresentationRoutes, { publicCasePresentation } from './routes/casepres.js';
import growthRoutes from './routes/growth.js';
import imagingRoutes, { bridgeAgentRoutes } from './routes/imaging.js';
import { portalPublicRoutes, portalRoutes } from './routes/portal.js';
import systemRoutes from './routes/system.js';
import chartingRoutes from './routes/charting.js';
import referralRoutes from './routes/referrals.js';
import importRoutes from './routes/imports.js';
import backupRoutes from './routes/backup.js';
import formRoutes from './routes/forms.js';
import membershipRoutes from './routes/memberships.js';
import campaignRoutes, { campaignPublicRoutes } from './routes/campaigns.js';
import { createMessenger } from './messaging.js';
import { createStorage } from './storage.js';
import { createClearinghouse, clearinghouseConfig } from './clearinghouse.js';
import { createErx, erxConfig } from './erx.js';
import { createPayments } from './payments.js';
import { createMailer } from './mail.js';

// Runtime configuration, from the environment unless overridden (tests pass their own).
export function loadConfig(env = process.env) {
  return {
    // Render and similar hosts publish the public URL themselves.
    appUrl: (env.APP_URL || env.RENDER_EXTERNAL_URL || (env.VERCEL_PROJECT_PRODUCTION_URL && `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`) || `http://localhost:${env.PORT || 4000}`).replace(/\/$/, ''),
    uploadDir: env.UPLOAD_DIR || './data/uploads',
    documentKey: env.DOCUMENT_ENCRYPTION_KEY || null,
    stripeSecretKey: env.STRIPE_SECRET_KEY || null,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    payments: env.PAYMENTS || null,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || null,
    ediMode: env.EDI_MODE || 'manual',
    ediSubmitterId: env.EDI_SUBMITTER_ID || null,
    ediReceiverId: env.EDI_RECEIVER_ID || null,
    // Automatic nightly backups to a folder (a mounted volume or a synced bucket); off when unset.
    backupDir: env.BACKUP_DIR || null,
    backupKeep: Number(env.BACKUP_KEEP) || 14,
    backupDocuments: env.BACKUP_DOCUMENTS ? env.BACKUP_DOCUMENTS === 'on' : null,
  };
}

export function createApp({ db, secret, config: overrides = {}, fetchImpl = globalThis.fetch, messenger, storage, clearinghouse, erx, payments, mailer }) {
  if (!secret) throw new Error('JWT secret is required');
  const config = { ...loadConfig(), ...overrides };
  messenger ??= createMessenger({ fetchImpl });
  storage ??= createStorage({ dir: config.uploadDir, key: config.documentKey });
  erx ??= createErx(overrides.erx || erxConfig());
  payments ??= createPayments({ config, fetchImpl });
  mailer ??= overrides.mailer || createMailer({ fetchImpl });
  clearinghouse ??= createClearinghouse({ db, fetchImpl, config: { ...clearinghouseConfig(), ...(config.ediMode === 'sandbox' && !process.env.CLEARINGHOUSE ? { mode: 'sandbox' } : {}) } });
  const app = express();
  app.locals.clearinghouse = clearinghouse;
  app.locals.payments = payments;
  app.locals.messenger = messenger;
  app.locals.storage = storage;
  // Client IPs (rate limits, audit log) come from X-Forwarded-For only when set by a proxy we trust:
  // by default one on a private network (a load balancer in the same VPC). Set TRUST_PROXY for others.
  app.set('trust proxy', process.env.TRUST_PROXY ? (/^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY) : 'loopback, linklocal, uniquelocal');
  app.disable('x-powered-by');
  app.use(stripeWebhook({ db, config, payments })); // needs the raw body, so before express.json
  app.use(smsWebhook({ db, config }));
  // Signed forms can carry photos (insurance cards, ID), so that one route takes larger bodies.
  const jsonBody = express.json({ limit: '1mb' });
  const formBody = express.json({ limit: '15mb' });
  app.use((req, res, next) => (/^\/api\/public\/forms\/[^/]+\/\d+$/.test(req.path) ? formBody : jsonBody)(req, res, next));
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
  app.use('/api/auth', authRoutes({ db, secret, config, fetchImpl, messenger }));
  app.use('/api/public', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, publicRoutes({ db, storage }), publicCasePresentation({ db }), portalPublicRoutes({ db, secret, messenger }), campaignPublicRoutes({ db }));
  app.use('/api/portal', portalRoutes({ db, secret, config, payments }));

  app.use('/api/bridge', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, bridgeAgentRoutes({ db, storage }));

  const api = express.Router();
  api.use(authenticate(db, secret));
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store'); // PHI must not be cached by intermediaries
    next();
  });
  api.use(patientRoutes({ db }));
  api.use(scheduleRoutes({ db }));
  api.use(clinicalRoutes({ db }));
  api.use(chartingRoutes({ db }));
  api.use(referralRoutes({ db }));
  api.use(importRoutes({ db }));
  api.use(backupRoutes({ db, storage, config }));
  api.use(formRoutes({ db, messenger, config }));
  api.use(membershipRoutes({ db, payments, messenger }));
  api.use(campaignRoutes({ db, messenger, config }));
  api.use(billingRoutes({ db, payments }));
  api.use(insuranceRoutes({ db }));
  api.use(settingsRoutes({ db, secret, config }));
  api.use(reportRoutes({ db }));
  api.use(engagementRoutes({ db, messenger, config }));
  api.use(documentRoutes({ db, storage }));
  api.use(paymentRoutes({ db, config, messenger, payments, mailer }));
  api.use(familyRoutes({ db }));
  api.use(conversationRoutes({ db, messenger }));
  api.use(ediRoutes({ db, config, clearinghouse }));
  api.use(officeRoutes({ db }));
  api.use(ppoRoutes({ db, config }));
  api.use(frontDeskRoutes({ db, messenger }));
  api.use(casePresentationRoutes({ db, messenger, config, erx }));
  api.use(growthRoutes({ db, messenger, config, mailer }));
  api.use(imagingRoutes({ db }));
  api.use(systemRoutes({ db, config, messenger, storage, payments, clearinghouse, erx, mailer }));
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
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large' });
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
