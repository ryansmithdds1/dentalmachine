import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createApp, loadConfig } from './app.js';
import { createMessenger, runReminders } from './messaging.js';
import { runFinanceSync } from './routes/finance.js';
import { runFillOffers } from './fill.js';
import { runReviewSync } from './routes/reputation.js';
import { purgeIdempotencyKeys } from './idempotency.js';
import { initCluster, runExclusive } from './cluster.js';
import { pollClearinghouse } from './clearinghouse.js';
import { runRecallSequences } from './recalls.js';
import { runAutopay } from './payments.js';
import { runPlanLateFees } from './routes/family.js';
import { runAutomaticBackups } from './backup.js';
import { runFormSends } from './formtemplates.js';
import { runMembershipBilling } from './memberships.js';
import { runCampaigns } from './campaigns.js';
import { deliverWebhooks, scanPayments } from './webhooks.js';
import { createEligibility, runEligibilityBatches } from './eligibility.js';
import { runScheduledReports } from './savedreports.js';
import { runSurveys } from './surveys.js';
import { runOrthoBilling } from './ortho.js';
import { log } from './monitoring.js';
import { productionProblems } from './preflight.js';

let secret = process.env.JWT_SECRET;
if (process.env.NODE_ENV === 'production') {
  const problems = productionProblems();
  if (problems.length) {
    for (const p of problems) log.error(`Refusing to start: ${p}`);
    process.exit(1);
  }
}
if (!secret) {
  secret = randomBytes(32).toString('hex');
  log.warn('JWT_SECRET not set; using a random secret (sessions reset on restart)');
}

const db = await openDb();
const cluster = await initCluster();
const config = loadConfig();
const messenger = createMessenger();
const app = createApp({ db, secret, config, messenger });
// Background jobs: failures are logged and reported like request errors.
const jobFailed = (name) => (err) => {
  log.error(`${name} failed:`, err);
  app.locals.reporter.capture(err, { tags: { job: name } });
};
process.on('unhandledRejection', (err) => {
  log.error('Unhandled promise rejection:', err instanceof Error ? err : new Error(String(err)));
  app.locals.reporter.capture(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'unhandledRejection' } });
});

// Appointment reminders every 10 minutes. With Redis, only one server runs each pass (REMINDERS=off disables).
if (process.env.REMINDERS !== 'off') {
  const tick = () => runExclusive('reminders', 5 * 60 * 1000, async () => (await runReminders(db, messenger, { appUrl: config.appUrl })) + (await runRecallSequences(db, messenger, { appUrl: config.appUrl })) + (await runFormSends(db, messenger, { appUrl: config.appUrl })) + (await runCampaigns(db, messenger, { appUrl: config.appUrl })) + (await runFillOffers(db, messenger)))
    .then((n) => n && log.info(`Sent ${n} appointment reminder(s)`))
    .catch(jobFailed('Reminder job'));
  setInterval(tick, 10 * 60 * 1000).unref();
  setTimeout(tick, 5000).unref();
}
// Clearinghouse mailbox: acknowledgments, claim status and ERAs are picked up and posted automatically.
const ch = app.locals.clearinghouse;
if (ch?.batch && process.env.CLEARINGHOUSE_POLL !== 'off') {
  const poll = () => runExclusive('clearinghouse-poll', 10 * 60 * 1000, () => pollClearinghouse(db, ch))
    .then((files) => files?.length && log.info(`Clearinghouse: processed ${files.length} file(s)`))
    .catch(jobFailed('Clearinghouse poll'));
  setInterval(poll, ch.pollMinutes * 60 * 1000).unref();
  setTimeout(poll, 15_000).unref();
}
// Webhooks: retry failed deliveries and announce new payments, every minute.
if (process.env.WEBHOOKS !== 'off') {
  const hooks = () => runExclusive('webhooks', 55 * 1000, async () => (await scanPayments(db)) + (await deliverWebhooks(db)))
    .catch(jobFailed('Webhooks'));
  setInterval(hooks, 60 * 1000).unref();
}
// Membership fees: each period is posted (and the card on file charged) on its billing date; checked hourly.
if (process.env.MEMBERSHIP_BILLING !== 'off') {
  const bill = () => runExclusive('memberships', 30 * 60 * 1000, () => runMembershipBilling(db, app.locals.payments, { messenger }))
    .then((r) => r?.length && log.info(`Memberships: ${r.filter((x) => x.charged).length} charged, ${r.filter((x) => x.declined).length} declined, ${r.length} billed`))
    .catch(jobFailed('Membership billing'));
  setInterval(bill, 60 * 60 * 1000).unref();
  setTimeout(bill, 45_000).unref();
}
// Nightly backups of every practice to BACKUP_DIR (checked hourly; a day's file is only written once).
// Documents are included when they live on this server's disk, unless BACKUP_DOCUMENTS says otherwise.
if (config.backupDir) {
  const storage = app.locals.storage;
  const backup = () => runExclusive('backups', 60 * 60 * 1000, () => runAutomaticBackups(db, { dir: config.backupDir, keep: config.backupKeep, storage, documents: config.backupDocuments ?? storage.driver === 'disk', key: config.backupKey }))
    .then((made) => made?.length && log.info(`Backups written: ${made.join(', ')}`))
    .catch(jobFailed('Backup'));
  setInterval(backup, 60 * 60 * 1000).unref();
  setTimeout(backup, 60_000).unref();
}
// Payment-plan autopay: due installments are charged once a day (checked hourly).
if (app.locals.payments.enabled && process.env.AUTOPAY !== 'off') {
  const charge = () => runExclusive('autopay', 30 * 60 * 1000, () => runAutopay(db, app.locals.payments, messenger))
    .then((r) => r?.length && log.info(`Autopay: ${r.filter((x) => x.ok).length} charged, ${r.filter((x) => !x.ok).length} declined`))
    .catch(jobFailed('Autopay'));
  setInterval(charge, 60 * 60 * 1000).unref();
  setTimeout(charge, 30_000).unref();
}
// Tomorrow's patients' insurance is checked each evening when a real-time (or sandbox) clearinghouse is connected.
{
  const eligibility = createEligibility({ db, config, clearinghouse: ch });
  if (eligibility.automatic && process.env.ELIGIBILITY_BATCH !== 'off') {
    const run = () => runExclusive('eligibility', 30 * 60 * 1000, () => runEligibilityBatches(db, eligibility))
      .then((r) => r?.length && log.info(`Eligibility: ${r.map((x) => `${x.checked} checked for ${x.date}`).join(', ')}`))
      .catch(jobFailed('Eligibility batch'));
    setInterval(run, 60 * 60 * 1000).unref();
    setTimeout(run, 90_000).unref();
  }
}
// Payment-plan late fees: an installment still unpaid after the plan's grace days gets its fee once.
if (process.env.PLAN_LATE_FEES !== 'off') {
  const run = () => runExclusive('plan-late-fees', 30 * 60 * 1000, () => runPlanLateFees(db))
    .then((r) => r?.length && log.info(`Payment plans: ${r.length} late fees charged`))
    .catch(jobFailed('Plan late fees'));
  setInterval(run, 60 * 60 * 1000).unref();
  setTimeout(run, 100_000).unref();
}
// Ortho contracts: each month's charge (and card payment, with autopay) once a day.
if (process.env.ORTHO_BILLING !== 'off') {
  const run = () => runExclusive('ortho-billing', 30 * 60 * 1000, () => runOrthoBilling(db, app.locals.payments))
    .then((r) => r?.length && log.info(`Ortho billing: ${r.length} months billed`))
    .catch(jobFailed('Ortho billing'));
  setInterval(run, 60 * 60 * 1000).unref();
  setTimeout(run, 50_000).unref();
}
// The business's bank lines and QuickBooks books, every four hours (Plaid's webhook also brings new lines sooner).
if (process.env.FINANCE_SYNC !== 'off') {
  const run = () => runExclusive('finance-sync', 30 * 60 * 1000, () => runFinanceSync(db, { plaid: app.locals.plaid, qbo: app.locals.qbo, secret }))
    .catch(jobFailed('Finance sync'));
  setInterval(run, 4 * 60 * 60 * 1000).unref();
  setTimeout(run, 70_000).unref();
}
// Answers kept for repeated requests are dropped after a day.
{
  const run = () => runExclusive('idempotency-purge', 10 * 60 * 1000, () => purgeIdempotencyKeys(db)).catch(jobFailed('Idempotency purge'));
  setInterval(run, 60 * 60 * 1000).unref();
}
// Online reviews, every two hours (low ratings become a task to reply).
{
  const run = () => runExclusive('reviews', 20 * 60 * 1000, () => runReviewSync(db, { gbp: app.locals.gbp, secret }))
    .catch(jobFailed('Review sync'));
  setInterval(run, 2 * 60 * 60 * 1000).unref();
  setTimeout(run, 90_000).unref();
}
// After-visit patient surveys (the day after, from 10am practice time).
{
  const run = () => runExclusive('surveys', 30 * 60 * 1000, () => runSurveys(db, messenger, { appUrl: config.appUrl }))
    .then((n) => n && log.info(`Surveys: ${n} sent`))
    .catch(jobFailed('Surveys'));
  setInterval(run, 60 * 60 * 1000).unref();
  setTimeout(run, 150_000).unref();
}
// Saved reports emailed on their schedule (checked hourly; each goes out once a day at most, after 7am).
{
  const run = () => runExclusive('scheduled-reports', 30 * 60 * 1000, () => runScheduledReports(db, messenger))
    .then((n) => n && log.info(`Scheduled reports: ${n} emailed`))
    .catch(jobFailed('Scheduled reports'));
  setInterval(run, 60 * 60 * 1000).unref();
  setTimeout(run, 120_000).unref();
}
log.info(`Clearinghouse: ${ch?.name || 'manual'}${ch?.realtime ? ' + real-time eligibility/status' : ''}`);
log.info(`Database: ${db.dialect} · cluster: ${cluster.mode}`);
log.info(`Messaging drivers: sms=${messenger.status.sms} email=${messenger.status.email}`);
const port = Number(process.env.PORT) || 4000;
app.listen(port, () => log.info(`Dental Machine API listening on http://localhost:${port}`));
