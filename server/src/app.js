import prefsRoutes from './routes/prefs.js';
import express from 'express';
import { loggedFetch } from './issues.js';
import { idempotency } from './idempotency.js';
import { actorMiddleware, setActor } from './actor.js';
import { aiGuard } from './aiguard.js';
import { flushChanges } from './util.js';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAudit } from './accesslog.js';
import { authenticate, HttpError, rateLimit } from './auth.js';
import authRoutes from './routes/auth.js';
import patientRoutes from './routes/patients.js';
import scheduleRoutes from './routes/schedule.js';
import productionRoutes from './routes/production.js';
import dayTemplateRoutes from './routes/daytemplates.js';
import capacityRoutes from './routes/capacity.js';
import optimizerRoutes from './routes/optimizer.js';
import labCheckinRoutes from './routes/labcheckin.js';
import businessRoutes from './routes/business.js';
import clinicalRoutes from './routes/clinical.js';
import billingRoutes from './routes/billing.js';
import insuranceRoutes from './routes/insurance.js';
import verificationRoutes from './routes/verification.js';
import feeScheduleRoutes from './routes/feeschedules.js';
import marketingRoutes from './routes/marketing.js';
import bonusRoutes from './routes/bonus.js';
import cardRoutes from './routes/cards.js';
import doctorNoteRoutes from './routes/doctornotes.js';
import officeMoveRoutes from './routes/officemoves.js';
import txFollowRoutes, { txFollowPublicRoutes } from './routes/txfollow.js';
import recallFreqRoutes from './routes/recallfreq.js';
import settingsRoutes from './routes/settings.js';
import reportRoutes from './routes/reports.js';
import reportLibraryRoutes from './routes/reportlibrary.js';
import productionReportRoutes from './routes/productionreport.js';
import opportunityRoutes from './routes/opportunities.js';
import cadenceRoutes from './routes/cadence.js';
import journeyRoutes, { journeyPublicRoutes } from './routes/journeys.js';
import recallBookRoutes, { recallVoiceWebhooks } from './routes/recallbook.js';
import chatRoutes from './routes/chat.js';
import treatmentEntryRoutes from './routes/treatmententry.js';
import checklistRoutes from './routes/checklists.js';
import onlineSchedPublicRoutes, { onlineSchedRoutes, onlineSchedEmbedRoutes } from './routes/onlinesched.js';
import consentRoutes from './routes/consents.js';
import paperworkRoutes from './routes/paperwork.js';
import paperworkPublicRoutes from './routes/paperworkpublic.js';
import chartAuditRoutes from './routes/chartaudit.js';
import { docBridgeRoutes, docMediaRoutes } from './routes/docbridge.js';
import longRecordingRoutes from './routes/longrecording.js';
import metricRoutes from './routes/metrics.js';
import digestRoutes, { digestPublicRoutes } from './routes/digests.js';
import engagementRoutes from './routes/engagement.js';
import publicRoutes from './routes/public.js';
import documentRoutes from './routes/documents.js';
import volumeRoutes from './routes/volumes.js';
import intranetRoutes from './routes/intranet.js';
import paymentRoutes, { stripeWebhook } from './routes/payments.js';
import terminalRoutes from './routes/terminal.js';
import setupRoutes from './routes/setup.js';
import familyRoutes from './routes/family.js';
import conversationRoutes, { smsWebhook } from './routes/sms.js';
import { deliveryWebhooks } from './routes/delivery.js';
import { voiceWebhooks } from './routes/voice.js';
import phoneRoutes, { phoneWebhooks } from './routes/phones.js';
import phoneCoachRoutes, { phoneCoachWebhooks } from './routes/phonecoach.js';
import { createTranscriber } from './phones.js';
import financeRoutes, { financePublicRoutes } from './routes/finance.js';
import scribeRoutes from './routes/scribe.js';
import xrayAiRoutes from './routes/xrayai.js';
import insuranceAiRoutes from './routes/insuranceai.js';
import intakeReviewRoutes from './routes/intakereview.js';
import askRoutes, { mcpRoutes } from './routes/ask.js';
import orgRoutes from './routes/org.js';
import claimAiRoutes from './routes/claimai.js';
import issueRoutes from './routes/issues.js';
import reconciliationRoutes from './routes/reconciliation.js';
import labRxRoutes, { labPublicRoutes } from './routes/labrx.js';
import patientCareRoutes, { learnPublicRoutes } from './routes/patientcare.js';
import checkinRoutes, { checkinPublicRoutes } from './routes/checkin.js';
import lenderRoutes, { lenderWebhooks } from './routes/lenders.js';
import reputationRoutes, { reputationPublicRoutes } from './routes/reputation.js';
import statusRoutes from './routes/status.js';
import onboardingRoutes from './routes/onboarding.js';
import { createGoogleBusiness } from './reviews.js';
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
import timeclockRoutes, { timeclockKioskRoutes } from './routes/timeclock.js';
import cashDepositRoutes, { cashGuardRoutes } from './routes/cashdeposits.js';
import inventoryRoutes from './routes/inventory.js';
import queryBuilderRoutes from './routes/querybuilder.js';
import orthoRoutes from './routes/ortho.js';
import imagingRoutes, { bridgeAgentRoutes } from './routes/imaging.js';
import bridgePackageRoutes from './routes/bridgepackage.js';
import { portalPublicRoutes, portalRoutes } from './routes/portal.js';
import portalAccountRoutes from './routes/portalaccount.js';
import billpayPublicRoutes, { billpayStaffRoutes, billpayEmbedRoutes } from './routes/billpay.js';
import systemRoutes from './routes/system.js';
import offlineRoutes from './routes/offline.js';
import chartingRoutes from './routes/charting.js';
import referralRoutes from './routes/referrals.js';
import referralTrackerRoutes, { referralPublicRoutes } from './routes/referraltracker.js';
import reviewFunnelRoutes, { reviewPublicRoutes } from './routes/reviewfunnel.js';
import eobAutopilotRoutes, { eobAutopilotPublicRoutes } from './routes/eobauto.js';
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

export const environmentName = (env = process.env) => (['development', 'demo', 'staging', 'production'].includes(env.APP_ENV) ? env.APP_ENV : env.NODE_ENV === 'production' ? 'production' : 'development');

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
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || null, twilioAccountSid: env.TWILIO_ACCOUNT_SID || null,
    // Online reviews: GOOGLE_BUSINESS=sandbox, or an OAuth client with the Business Profile API.
    googleBusiness: env.GOOGLE_BUSINESS || null, googleClientId: env.GOOGLE_CLIENT_ID || null, googleClientSecret: env.GOOGLE_CLIENT_SECRET || null,
    // Call recordings to text: TRANSCRIBE=deepgram (with DEEPGRAM_API_KEY) or sandbox.
    transcribe: env.TRANSCRIBE || null, deepgramKey: env.DEEPGRAM_API_KEY || null,
    // Bot check on public booking (Cloudflare Turnstile): both keys, or neither.
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null, turnstileSecret: env.TURNSTILE_SECRET_KEY || null,
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
export const CSP = "default-src 'self'; script-src 'self' https://cdn.plaid.com/link/v2/stable/link-initialize.js https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://production.plaid.com https://sandbox.plaid.com; frame-src 'self' blob: https://cdn.plaid.com https://challenges.cloudflare.com; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

export function createApp({ db, secret, config: overrides = {}, fetchImpl = globalThis.fetch, messenger, storage, clearinghouse, erx, payments, mailer, attachmentSender, plaid, qbo, xrayAi, transcriber, gbp }) {
  if (!secret) throw new Error('JWT secret is required');
  const config = { ...loadConfig(), ...overrides };
  // Every call to an outside service is logged (Settings → Connections activity), Claude's included.
  fetchImpl = loggedFetch(db, fetchImpl);
  config.aiFetch ??= loggedFetch(db, globalThis.fetch);
  messenger ??= createMessenger({ fetchImpl });
  storage ??= createStorage({ dir: config.uploadDir, key: config.documentKey, previousKeys: config.documentKeysPrevious });
  erx ??= createErx(overrides.erx || erxConfig());
  payments ??= createPayments({ config, fetchImpl });
  plaid ??= createPlaid({ config, fetchImpl });
  qbo ??= createQuickBooks({ config, fetchImpl });
  xrayAi ??= createXrayAi({ config, fetchImpl });
  registerXrayAi(db, { storage, xrayAi });
  registerFill(db, messenger);
  transcriber ??= createTranscriber({ config, fetchImpl });
  gbp ??= createGoogleBusiness({ config, fetchImpl });
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
  app.locals.gbp = gbp;
  // Client IPs (rate limits, audit log) come from X-Forwarded-For only when set by a proxy we trust:
  // by default one on a private network (a load balancer in the same VPC). On Vercel it is Vercel's edge,
  // one hop, which replaces any X-Forwarded-For the client sent. Set TRUST_PROXY for other hosts.
  const trust = process.env.TRUST_PROXY || (process.env.VERCEL ? '1' : 'loopback, linklocal, uniquelocal');
  app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust);
  app.disable('x-powered-by');
  app.use(requestLogger());
  app.use(actorMiddleware(db, flushChanges));
  app.use(stripeWebhook({ db, config, payments, messenger })); // needs the raw body, so before express.json
  app.use(smsWebhook({ db, config }));
  app.use(deliveryWebhooks({ db, config }));
  app.use(voiceWebhooks({ db, config }));
  app.use(recallVoiceWebhooks({ db, config, messenger, secret }));
  app.use(phoneWebhooks({ db, config, messenger, storage, transcriber, fetchImpl }));
  app.use(phoneCoachWebhooks({ db, config, messenger }));
  app.use(lenderWebhooks({ db }));
  app.use(reputationPublicRoutes({ db, secret, gbp, config }));
  app.use(financePublicRoutes({ db, config, secret, plaid, qbo }));
  // Signed forms can carry photos (insurance cards, ID), and documents sent to be read (benefit summaries, EOBs), so those routes take larger bodies.
  const jsonBody = express.json({ limit: '1mb' });
  const formBody = express.json({ limit: '15mb' });
  // (after the body is read, below) repeats of a request with the same Idempotency-Key aren't done twice
  // Large bodies from the public form page are rate-limited before they're read (no sign-in there).
  const bigPublicBody = rateLimit({ windowMs: 60_000, max: 12, name: 'public-big-body' });
  app.use((req, res, next) => (/^\/api\/public\/forms\/[^/]+\/\d+$|^\/api\/public\/(papers\/[^/]+|forms-kiosk\/sessions\/\d+)\/(history|forms\/\d+)$/.test(req.path) ? bigPublicBody(req, res, next) : next()));
  app.use((req, res, next) => (/^\/api\/public\/forms\/[^/]+\/\d+$|^\/api\/insurance-plans\/\d+\/read-benefits$|^\/api\/eobs\/read$|^\/api\/patients\/\d+\/insurance-card\/read$|^\/api\/public\/(papers\/[^/]+|forms-kiosk\/sessions\/\d+)\/(history|forms\/\d+)$|^\/api\/public\/os\/[^/]+\/book$|^\/api\/fees\/(imports|inbox\/\d+)$/.test(req.path) ? formBody : jsonBody)(req, res, next));
  app.use('/api', idempotency(db, secret));
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
      // Microphone (dictation, the assistant) and camera (photos, mobile check-in) for this site only; nothing else.
      'Permissions-Policy': 'microphone=(self), camera=(self), geolocation=(), payment=(), usb=(), interest-cohort=()',
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    });
    next();
  });

  app.use(readAudit(db));

  // Which environment this is (APP_ENV: development, demo, staging, production), so screens can say so.
  app.get('/api/health', (_req, res) => res.json({ ok: true, environment: environmentName() }));
  app.use('/api/public', statusRoutes({ db, storage, messenger }));
  app.use('/api/public', recallBookRoutes({ db, messenger, config, secret }), digestPublicRoutes({ db, secret }), journeyPublicRoutes({ db }));
  app.use('/api/public', txFollowPublicRoutes({ db, config, secret, storage }));
  app.use('/api/public', reviewPublicRoutes({ db }), referralPublicRoutes({ db, storage, config }), eobAutopilotPublicRoutes({ db, config, secret, payments }));
  app.use('/api/auth', authRoutes({ db, secret, config, fetchImpl, messenger }));
  app.use('/api/public', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, publicRoutes({ db, storage, payments, messenger, config, secret, fetchImpl }), publicCasePresentation({ db, storage, secret }), portalPublicRoutes({ db, secret, messenger }), campaignPublicRoutes({ db }), surveyPublicRoutes({ db }), labPublicRoutes({ db, storage }), learnPublicRoutes({ db }), checkinPublicRoutes({ db }), paperworkPublicRoutes({ db, storage, secret }));
  app.use('/api/public', billpayPublicRoutes({ db, secret, payments, messenger, config, fetchImpl }));
  app.use('/api/public', onlineSchedPublicRoutes({ db, messenger, payments, storage, config, fetchImpl }));
  app.use('/api/portal', portalAccountRoutes({ db, secret, config, payments, messenger }));
  app.use('/api/portal', portalRoutes({ db, secret, config, payments, messenger, storage }));
  app.use('/api/v1', apiV1Routes({ db }));
  app.use('/api/mcp', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, mcpRoutes({ db }));

  app.use('/api/bridge', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, bridgeAgentRoutes({ db, storage }));
  // Desk scanners through the bridge (scan jobs and results) and streamed audio/video with Range support.
  app.use('/api/bridge', docBridgeRoutes({ db, storage, config }));
  app.use('/api/media', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, docMediaRoutes({ db, storage, secret }));

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

  // The shared time-clock tablet signs in with its own kiosk token, not a staff session.
  app.use('/api/kiosk', timeclockKioskRoutes({ db }));
  const api = express.Router();
  api.use(authenticate(db, secret));
  // The signed-in person — or the assistant acting for them (its requests say so) — for the audit trail.
  api.use((req, _res, next) => {
    const ai = req.get('X-Acting-For') === 'assistant';
    setActor({
      source: ai ? 'ai' : 'human', userId: req.user.id, practiceId: req.user.practice_id, actor: ai ? `Assistant (for ${req.user.name})` : req.user.name,
      locationId: req.location_id ?? null,
      // A reason typed for a change ("why?") travels with it into the audit log.
      reason: typeof req.body?.change_reason === 'string' ? req.body.change_reason.trim().slice(0, 500) || null : null,
    });
    next();
  });
  api.use(aiGuard());
  // Repeated requests (double clicks, retries): after sign-in is checked, keyed to this user's session.
  api.use(idempotency(db, secret, { scopeOf: (req) => `u${req.user.id}:${req.session_id ?? ''}` }));
  api.use(officeAccess(db));
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store'); // PHI must not be cached by intermediaries
    next();
  });
  api.use(prefsRoutes({ db }));
  api.use(offlineRoutes({ db, secret, app: () => app }));
  api.use(patientRoutes({ db }));
  // Before scheduleRoutes: /schedule/production?date= is answered here (?from= requests pass through to schedule.js).
  api.use(productionRoutes({ db }));
  api.use(scheduleRoutes({ db }));
  api.use(recallFreqRoutes({ db }));
  api.use(cardRoutes({ db }));
  api.use(doctorNoteRoutes({ db }));
  api.use(officeMoveRoutes({ db, messenger, config }));
  api.use(marketingRoutes({ db, config }));
  api.use(dayTemplateRoutes({ db }));
  api.use(capacityRoutes({ db }));
  api.use(clinicalRoutes({ db }));
  api.use(chartingRoutes({ db, config, transcriber }));
  api.use(treatmentEntryRoutes({ db }));
  api.use(referralRoutes({ db }));
  api.use(referralTrackerRoutes({ db, storage, config, messenger }));
  api.use(importRoutes({ db }));
  api.use(backupRoutes({ db, storage, config }));
  api.use(formRoutes({ db, messenger, config }));
  api.use(consentRoutes({ db, storage }));
  api.use(paperworkRoutes({ db, messenger, storage, config }));
  api.use(onlineSchedRoutes({ db, config }));
  api.use(membershipRoutes({ db, payments, messenger }));
  api.use(campaignRoutes({ db, messenger, config }));
  api.use(developerRoutes({ db, fetchImpl }));
  api.use(assistantRoutes({ db, config, secret, app: () => app }));
  api.use(financeRoutes({ db, config, secret, plaid, qbo }));
  api.use(scribeRoutes({ db, config }));
  api.use(xrayAiRoutes({ db, xrayAi }));
  api.use(insuranceAiRoutes({ db, config }));
  api.use(eobAutopilotRoutes({ db, config, storage, mailer, clearinghouse }));
  api.use(intakeReviewRoutes({ db }));
  api.use(askRoutes({ db, config }));
  api.use(phoneRoutes({ db, storage }));
  api.use(phoneCoachRoutes({ db, config, messenger }));
  api.use(orgRoutes({ db }));
  api.use(claimAiRoutes({ db, config }));
  api.use(labRxRoutes({ db, messenger, config }));
  api.use(issueRoutes({ db }));
  api.use(reconciliationRoutes({ db, payments }));
  api.use(patientCareRoutes({ db, messenger, config }));
  api.use(checkinRoutes({ db, messenger }));
  api.use(lenderRoutes({ db, messenger }));
  api.use(reputationRoutes({ db, config, secret, gbp }));
  api.use(reviewFunnelRoutes({ db, messenger, config }));
  api.use(onboardingRoutes({ db, messenger, payments }));
  api.use(attachmentRoutes({ db, storage, sender: attachmentSender ?? createAttachmentSender(attachmentConfig(process.env, config.ediMode), fetchImpl) }));
  // Cash voids, refunds and same-day discounts need a manager: checked before billing handles them.
  api.use(cashGuardRoutes({ db }));
  api.use(billingRoutes({ db, payments, config, messenger }));
  api.use(cashDepositRoutes({ db, storage }));
  api.use(insuranceRoutes({ db }));
  api.use(verificationRoutes({ db, config, clearinghouse, storage, messenger }));
  api.use(settingsRoutes({ db, secret, config, messenger }));
  api.use(reportRoutes({ db }));
  api.use(reportLibraryRoutes({ db }));
  api.use(productionReportRoutes({ db }));
  api.use(opportunityRoutes({ db }));
  api.use(optimizerRoutes({ db, config, messenger, app: () => app }));
  api.use(labCheckinRoutes({ db, storage, config, messenger, transcriber }));
  api.use(cadenceRoutes({ db, messenger, mailer, config, secret }));
  api.use(txFollowRoutes({ db, messenger, mailer, config, storage }));
  api.use(journeyRoutes({ db, messenger, mailer, config, secret }));
  api.use(metricRoutes({ db }));
  api.use(digestRoutes({ db, messenger, config, secret }));
  api.use(engagementRoutes({ db, messenger, config }));
  api.use(documentRoutes({ db, storage, config }));
  api.use(chartAuditRoutes({ db, config }));
  api.use(longRecordingRoutes({ db, config, storage, transcriber, fetchImpl }));
  api.use(volumeRoutes({ db, storage }));
  api.use(intranetRoutes({ db, storage }));
  api.use(paymentRoutes({ db, config, messenger, payments, mailer }));
  api.use(terminalRoutes({ db, payments, messenger }));
  api.use(setupRoutes({ db, config }));
  api.use(familyRoutes({ db }));
  api.use(conversationRoutes({ db, messenger }));
  api.use(ediRoutes({ db, config, clearinghouse }));
  api.use(officeRoutes({ db }));
  api.use(chatRoutes({ db, storage, fetchImpl }));
  api.use(checklistRoutes({ db, storage, messenger }));
  api.use(ppoRoutes({ db, config }));
  api.use(feeScheduleRoutes({ db, config }));
  api.use(frontDeskRoutes({ db, messenger }));
  api.use(casePresentationRoutes({ db, messenger, config, erx, secret }));
  api.use(growthRoutes({ db, messenger, config, mailer }));
  api.use(collectionRoutes({ db, messenger }));
  api.use(depositRoutes({ db }));
  api.use(closeRoutes({ db }));
  api.use(savedReportRoutes({ db, messenger }));
  api.use(surveyRoutes({ db, messenger, config }));
  api.use(timeclockRoutes({ db }));
  api.use(bonusRoutes({ db }));
  api.use(businessRoutes({ db }));
  api.use(inventoryRoutes({ db }));
  api.use(queryBuilderRoutes({ db }));
  api.use(orthoRoutes({ db, payments }));
  api.use(imagingRoutes({ db, storage }));
  api.use(bridgePackageRoutes({ db, config }));
  api.use(billpayStaffRoutes({ db, config, payments }));
  api.use(systemRoutes({ db, config, messenger, storage, payments, clearinghouse, erx, mailer }));
  // The website booking embed (/embed.js) and the embeddable booking page's framing rules.
  app.use(onlineSchedEmbedRoutes({ db }));
  app.use(billpayEmbedRoutes());
  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // Serve the built SPA in production.
  // CLIENT_DIST lets tests serve a build made elsewhere (parallel test runs each build their own).
  const dist = process.env.CLIENT_DIST || join(dirname(fileURLToPath(import.meta.url)), '../../client/dist');
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
    // A malformed id or number in the address ("/patients/abc"): Postgres refuses it; SQLite simply finds nothing.
    if (err?.code === '22P02' || /invalid input syntax for type (integer|bigint|numeric)/i.test(msg)) return res.status(404).json({ error: 'Not found' });
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
