import express from 'express';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAudit } from './accesslog.js';
import { authenticate, HttpError, rateLimit } from './auth.js';
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
import terminalRoutes from './routes/terminal.js';
import setupRoutes from './routes/setup.js';
import familyRoutes from './routes/family.js';
import conversationRoutes, { smsWebhook } from './routes/sms.js';
import { deliveryWebhooks } from './routes/delivery.js';
import { voiceWebhooks } from './routes/voice.js';
import financeRoutes, { financePublicRoutes } from './routes/finance.js';
import scribeRoutes from './routes/scribe.js';
import xrayAiRoutes from './routes/xrayai.js';
import insuranceAiRoutes from './routes/insuranceai.js';
import askRoutes, { mcpRoutes } from './routes/ask.js';
import { createXrayAi, registerXrayAi } from './xrayai.js';
import { registerFill } from './fill.js';
import { createPlaid } from './finance/plaid.js';
import { createQuickBooks } from './finance/quickbooks.js';
import ediRoutes from './routes/edi.js';
import officeRoutes from './routes/office.js';
import ppoRoutes from './routes/ppo.js';
import frontDeskRoutes from './routes/frontdesk.js';
import casePresentationRoutes, { publicCasePresentation } from './routes/casepres.js';
import growthRoutes from './routes/growth.js';
import collectionRoutes from './routes/collections.js';
import depositRoutes from './routes/deposits.js';
import closeRoutes from './routes/close.js';
import savedReportRoutes from './routes/savedreports.js';
import timeclockRoutes from './routes/timeclock.js';
import inventoryRoutes from './routes/inventory.js';
import queryBuilderRoutes from './routes/querybuilder.js';
import orthoRoutes from './routes/ortho.js';
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
import surveyRoutes, { surveyPublicRoutes } from './routes/surveys.js';
import attachmentRoutes from './routes/attachments.js';
import apiV1Routes from './routes/apiv1.js';
import developerRoutes from './routes/developer.js';
import assistantRoutes, { assistantConfig } from './routes/assistant.js';
import { startWebhooks } from './webhooks.js';
import { createAttachmentSender, attachmentConfig } from './attachments.js';
import { createMessenger } from './messaging.js';
import { createStorage } from './storage.js';
import { createClearinghouse, clearinghouseConfig } from './clearinghouse.js';
import { createErx, erxConfig } from './erx.js';
import { createPayments } from './payments.js';
import { createMailer } from './mail.js';
import { createErrorReporter, requestLogger, routeOf, log } from './monitoring.js';
import { officeAccess } from './officeaccess.js';

// Runtime configuration, from the environment unless overridden (tests pass their own).
const listOf = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  return {
    // Render and similar hosts publish the public URL themselves.
    appUrl: (env.APP_URL || env.RENDER_EXTERNAL_URL || (env.VERCEL_PROJECT_PRODUCTION_URL && `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`) || `http://localhost:${env.PORT || 4000}`).replace(/\/$/, ''),
    uploadDir: env.UPLOAD_DIR || './data/uploads',
    documentKey: env.DOCUMENT_ENCRYPTION_KEY || null,
    // Keys used before a key change (comma-separated), kept only to read what they sealed: see npm run rotate-keys.
    documentKeysPrevious: listOf(env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS),
    stripeSecretKey: env.STRIPE_SECRET_KEY || null,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    payments: env.PAYMENTS || null,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || null,
    sendgridWebhookKey: env.SENDGRID_WEBHOOK_KEY || null,
    // The business's bank (Plaid) and books (QuickBooks Online); PLAID=sandbox / QBO=sandbox simulate them.
    plaidClientId: env.PLAID_CLIENT_ID || null, plaidSecret: env.PLAID_SECRET || null, plaidEnv: env.PLAID_ENV || 'sandbox', plaid: env.PLAID || null,
    // AI x-ray reading: XRAY_AI=vendor (with XRAY_AI_URL, XRAY_AI_KEY, XRAY_AI_NAME), claude or sandbox.
    xrayAi: env.XRAY_AI || null, xrayAiUrl: env.XRAY_AI_URL || null, xrayAiKey: env.XRAY_AI_KEY || null, xrayAiName: env.XRAY_AI_NAME || null,
    qboClientId: env.QBO_CLIENT_ID || null, qboClientSecret: env.QBO_CLIENT_SECRET || null, qboEnv: env.QBO_ENV || 'sandbox', qbo: env.QBO || null,
    ediMode: env.EDI_MODE || 'manual',
    ediSubmitterId: env.EDI_SUBMITTER_ID || null,
    ediReceiverId: env.EDI_RECEIVER_ID || null,
    // Automatic nightly backups to a folder (a mounted volume or a synced bucket); off when unset.
    backupDir: env.BACKUP_DIR || null,
    backupKeep: Number(env.BACKUP_KEEP) || 14,
    backupKey: env.BACKUP_ENCRYPTION_KEY || null,
    backupKeysPrevious: listOf(env.BACKUP_ENCRYPTION_KEY_PREVIOUS),
    backupDocuments: env.BACKUP_DOCUMENTS ? env.BACKUP_DOCUMENTS === 'on' : null,
    // Error monitoring: a Sentry (or compatible) DSN; off when unset.
    sentryDsn: env.SENTRY_DSN || null,
    // Who can create a practice: 'invite' (someone running the server hands out links with
    // `npm run invite`) or 'open' (anyone). Invite-only unless set otherwise in production.
    // The voice / text assistant (Claude): on when ANTHROPIC_API_KEY is set, unless ASSISTANT=off.
    assistant: assistantConfig(env),
    registration: env.REGISTRATION === 'open' || env.REGISTRATION === 'invite' ? env.REGISTRATION : env.NODE_ENV === 'production' ? 'invite' : 'open',
  };
}

// Keep in step with the headers in vercel.json (where the app's static files are served by the CDN).
// Plaid Link (connecting the practice's bank) runs from Plaid's own script and frame.
export const CSP = "default-src 'self'; script-src 'self' https://cdn.plaid.com/link/v2/stable/link-initialize.js; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://production.plaid.com https://sandbox.plaid.com; frame-src 'self' blob: https://cdn.plaid.com; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

export function createApp({ db, secret, config: overrides = {}, fetchImpl = globalThis.fetch, messenger, storage, clearinghouse, erx, payments, mailer, attachmentSender, plaid, qbo, xrayAi }) {
  if (!secret) throw new Error('JWT secret is required');
  const config = { ...loadConfig(), ...overrides };
  messenger ??= createMessenger({ fetchImpl });
  storage ??= createStorage({ dir: config.uploadDir, key: config.documentKey, previousKeys: config.documentKeysPrevious });
  erx ??= createErx(overrides.erx || erxConfig());
  payments ??= createPayments({ config, fetchImpl });
  plaid ??= createPlaid({ config, fetchImpl });
  qbo ??= createQuickBooks({ config, fetchImpl });
  xrayAi ??= createXrayAi({ config, fetchImpl });
  registerXrayAi(db, { storage, xrayAi });
  registerFill(db, messenger);
  mailer ??= overrides.mailer || createMailer({ fetchImpl });
  clearinghouse ??= createClearinghouse({ db, fetchImpl, config: { ...clearinghouseConfig(), ...(config.ediMode === 'sandbox' && !process.env.CLEARINGHOUSE ? { mode: 'sandbox' } : {}) } });
  startWebhooks(db, fetchImpl);
  const reporter = overrides.reporter || createErrorReporter({ dsn: config.sentryDsn, fetchImpl });
  const app = express();
  app.locals.reporter = reporter;
  app.locals.clearinghouse = clearinghouse;
  app.locals.payments = payments;
  app.locals.plaid = plaid;
  app.locals.qbo = qbo;
  app.locals.messenger = messenger;
  app.locals.storage = storage;
  // Client IPs (rate limits, audit log) come from X-Forwarded-For only when set by a proxy we trust:
  // by default one on a private network (a load balancer in the same VPC). On Vercel it is Vercel's edge,
  // one hop, which replaces any X-Forwarded-For the client sent. Set TRUST_PROXY for other hosts.
  const trust = process.env.TRUST_PROXY || (process.env.VERCEL ? '1' : 'loopback, linklocal, uniquelocal');
  app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust);
  app.disable('x-powered-by');
  app.use(requestLogger());
  app.use(stripeWebhook({ db, config, payments, messenger })); // needs the raw body, so before express.json
  app.use(smsWebhook({ db, config }));
  app.use(deliveryWebhooks({ db, config }));
  app.use(voiceWebhooks({ db, config }));
  app.use(financePublicRoutes({ db, config, secret, plaid, qbo }));
  // Signed forms can carry photos (insurance cards, ID), and documents sent to be read (benefit summaries, EOBs), so those routes take larger bodies.
  const jsonBody = express.json({ limit: '1mb' });
  const formBody = express.json({ limit: '15mb' });
  app.use((req, res, next) => (/^\/api\/public\/forms\/[^/]+\/\d+$|^\/api\/insurance-plans\/\d+\/read-benefits$|^\/api\/eobs\/read$/.test(req.path) ? formBody : jsonBody)(req, res, next));
  app.use((req, res, next) => {
    // Patient data isn't left in the browser's or a proxy's disk cache.
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    // The app loads only its own scripts, so injected markup can't run code or send data elsewhere.
    else res.set('Content-Security-Policy', CSP);
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    });
    next();
  });

  app.use(readAudit(db));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes({ db, secret, config, fetchImpl, messenger }));
  app.use('/api/public', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, publicRoutes({ db, storage, payments, messenger, config, secret }), publicCasePresentation({ db, storage, secret }), portalPublicRoutes({ db, secret, messenger }), campaignPublicRoutes({ db }), surveyPublicRoutes({ db }));
  app.use('/api/portal', portalRoutes({ db, secret, config, payments, messenger, storage }));
  app.use('/api/v1', apiV1Routes({ db }));
  app.use('/api/mcp', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, mcpRoutes({ db }));

  app.use('/api/bridge', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, bridgeAgentRoutes({ db, storage }));

  // Errors in the browser app, passed on to error monitoring (the DSN stays on the server). Only the
  // message, stack and page route are kept — nothing typed into the page.
  const clientErrorLimit = rateLimit({ windowMs: 60_000, max: 20, name: 'client-errors' });
  app.post('/api/client-errors', clientErrorLimit, (req, res) => {
    const b = req.body || {};
    const message = String(b.message || '').slice(0, 500);
    if (!message) return res.status(400).json({ error: 'message is required' });
    const page = String(b.path || '').split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/:token').slice(0, 200);
    const err = Object.assign(new Error(message), { name: String(b.name || 'Error').slice(0, 60), stack: `${b.name || 'Error'}: ${message}\n${String(b.stack || '').split('\n').filter((l) => /^\s*at |@/.test(l)).slice(0, 30).join('\n')}` });
    log.warn('Browser error', { message, page, request_id: req.id });
    const id = reporter.capture(err, { platform: 'javascript', tags: { source: 'browser', route: page, release: b.release || null } });
    res.status(202).json({ ok: true, reported: !!id });
  });

  const api = express.Router();
  api.use(authenticate(db, secret));
  api.use(officeAccess(db));
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
  api.use(developerRoutes({ db, fetchImpl }));
  api.use(assistantRoutes({ db, config, secret, app: () => app }));
  api.use(financeRoutes({ db, config, secret, plaid, qbo }));
  api.use(scribeRoutes({ db, config }));
  api.use(xrayAiRoutes({ db, xrayAi }));
  api.use(insuranceAiRoutes({ db, config }));
  api.use(askRoutes({ db, config }));
  api.use(attachmentRoutes({ db, storage, sender: attachmentSender ?? createAttachmentSender(attachmentConfig(process.env, config.ediMode), fetchImpl) }));
  api.use(billingRoutes({ db, payments, config, messenger }));
  api.use(insuranceRoutes({ db }));
  api.use(settingsRoutes({ db, secret, config }));
  api.use(reportRoutes({ db }));
  api.use(engagementRoutes({ db, messenger, config }));
  api.use(documentRoutes({ db, storage, config }));
  api.use(paymentRoutes({ db, config, messenger, payments, mailer }));
  api.use(terminalRoutes({ db, payments, messenger }));
  api.use(setupRoutes({ db, config }));
  api.use(familyRoutes({ db }));
  api.use(conversationRoutes({ db, messenger }));
  api.use(ediRoutes({ db, config, clearinghouse }));
  api.use(officeRoutes({ db }));
  api.use(ppoRoutes({ db, config }));
  api.use(frontDeskRoutes({ db, messenger }));
  api.use(casePresentationRoutes({ db, messenger, config, erx, secret }));
  api.use(growthRoutes({ db, messenger, config, mailer }));
  api.use(collectionRoutes({ db, messenger }));
  api.use(depositRoutes({ db }));
  api.use(closeRoutes({ db }));
  api.use(savedReportRoutes({ db, messenger }));
  api.use(surveyRoutes({ db, messenger, config }));
  api.use(timeclockRoutes({ db }));
  api.use(inventoryRoutes({ db }));
  api.use(queryBuilderRoutes({ db }));
  api.use(orthoRoutes({ db, payments }));
  api.use(imagingRoutes({ db, storage }));
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
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large' });
    // Constraint errors, worded differently by SQLite and Postgres.
    const msg = String(err?.message);
    if (/foreign key/i.test(msg)) return res.status(400).json({ error: 'Referenced record does not exist' });
    if (/unique constraint|UNIQUE/i.test(msg)) return res.status(409).json({ error: 'Record already exists' });
    if (/check constraint/i.test(msg)) return res.status(400).json({ error: 'Invalid value' });
    if (/not[- ]null constraint/i.test(msg)) {
      const field = err.column || (msg.match(/column "([^"]+)"/)?.[1] ?? msg.split('.').pop());
      return res.status(400).json({ error: `${field} is required` });
    }
    // Unexpected: logged with the request id (shown to the user so they can quote it) and reported.
    const where = { method: req.method, route: routeOf(req), request_id: req.id, ...(req.user ? { user_id: req.user.id, practice_id: req.user.practice_id } : {}) };
    log.error('Unhandled error', err, where);
    reporter.capture(err, { tags: where, user: req.user ? { id: String(req.user.id) } : null, request: { method: req.method, url: routeOf(req) } });
    res.status(500).json({ error: 'Internal server error', request_id: req.id });
  });

  return app;
}
