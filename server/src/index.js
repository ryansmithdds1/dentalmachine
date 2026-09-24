import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createApp, loadConfig } from './app.js';
import { createMessenger, runReminders } from './messaging.js';
import { runFinanceSync } from './routes/finance.js';
import { runFillOffers } from './fill.js';
import { runReviewSync } from './routes/reputation.js';
import { purgeIdempotencyKeys } from './idempotency.js';
import { purgeIntegrationLog } from './issues.js';
import { initCluster, runExclusive } from './cluster.js';
import { pollClearinghouse } from './clearinghouse.js';
import { runRecallSequences } from './recalls.js';
import { runAutopay } from './payments.js';
import { runPlanLateFees } from './routes/family.js';
import { runAutomaticBackups, runRestoreDrills } from './backup.js';
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
import { runCadences } from './cadence.js';
import { createMailer } from './mail.js';
import { runChatJobs } from './chat.js';
import { runDigests } from './digests.js';
import { depositWatchAll } from './deposits.js';
import { runCapacitySnapshots } from './capacity.js';
import { runChecklistJobs } from './checklists.js';
import { runReadinessJob } from './labcheck.js';
import { runPaperworkSafely } from './paperwork.js';
import { loggedFetch } from './issues.js';
import { runChartAudits } from './chartaudit.js';
import { createNoteComparer } from './ai/notecompare.js';
import { runRecordingJobs, createExamTranscriber } from './longrecording.js';
import { createTranscriber } from './phones.js';

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
  const tick = () => runExclusive('reminders', 5 * 60 * 1000, async () => (await runReminders(db, messenger, { appUrl: config.appUrl })) + (await runRecallSequences(db, messenger, { appUrl: config.appUrl })) + (await runFormSends(db, messenger, { appUrl: config.appUrl })) + ((await runPaperworkSafely(db, messenger, { appUrl: config.appUrl })).sent || 0) + (await runCampaigns(db, messenger, { appUrl: config.appUrl })) + (await runFillOffers(db, messenger)))
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
// Recall autopilot (and later treatment follow-up): due steps every 5 minutes; each step claimed once.
if (process.env.CADENCES !== 'off') {
  const cadenceMailer = createMailer();
  const cadence = () => runExclusive('cadence', 4 * 60 * 1000, () => runCadences(db, { messenger, mailer: cadenceMailer, appUrl: config.appUrl, secret }))
    .catch(jobFailed('Recall autopilot'));
  setInterval(cadence, 5 * 60 * 1000).unref();
  setTimeout(cadence, 50_000).unref();
}
// Team chat: repeating tasks and the unread-message digest email.
if (process.env.CHAT_JOBS !== 'off') {
  const chat = () => runExclusive('chat', 10 * 60 * 1000, () => runChatJobs(db, messenger, { appUrl: config.appUrl }))
    .catch(jobFailed('Team chat jobs'));
  setInterval(chat, 15 * 60 * 1000).unref();
  setTimeout(chat, 70_000).unref();
}
// Metric emails (huddle, end of day, weekly, monthly) at each practice's local time; once per period.
if (process.env.DIGESTS !== 'off') {
  const digests = () => runExclusive('digests', 4 * 60 * 1000, () => runDigests(db, messenger, { config, secret }))
    .then((n) => n && log.info(`Metric emails: ${n} sent`)).catch(jobFailed('Metric emails'));
  setInterval(digests, 5 * 60 * 1000).unref();
  setTimeout(digests, 40_000).unref();
}
// Deposits: submitted deposits followed to the bank; late or short ones become Needs attention items (hourly).
if (process.env.DEPOSIT_WATCH !== 'off') {
  const watch = () => runExclusive('deposit-watch', 30 * 60 * 1000, () => depositWatchAll(db)).catch(jobFailed('Deposit watch'));
  setInterval(watch, 60 * 60 * 1000).unref();
  setTimeout(watch, 90_000).unref();
}
// Capacity meter trend: each practice's snapshot once its evening comes (checked hourly; once a day).
if (process.env.CAPACITY_SNAPSHOTS !== 'off') {
  const capacity = () => runExclusive('capacity-snapshots', 30 * 60 * 1000, () => runCapacitySnapshots(db)).catch(jobFailed('Capacity snapshots'));
  setInterval(capacity, 60 * 60 * 1000).unref();
  setTimeout(capacity, 100_000).unref();
}
// Checklists by position: today's items made, on-shift items assigned, critical items past their time flagged,
// missed ones closed. Every 5 minutes; idempotent.
if (process.env.CHECKLISTS !== 'off') {
  const checklists = () => runExclusive('checklists', 4 * 60 * 1000, () => runChecklistJobs(db, messenger)).catch(jobFailed('Checklists'));
  setInterval(checklists, 5 * 60 * 1000).unref();
  setTimeout(checklists, 55_000).unref();
}
// Visit readiness (lab cases and parts): late ones flagged for the huddle with one to-do each (hourly).
if (process.env.READINESS_JOBS !== 'off') {
  const readiness = () => runExclusive('readiness', 30 * 60 * 1000, () => runReadinessJob(db)).catch(jobFailed('Visit readiness'));
  setInterval(readiness, 60 * 60 * 1000).unref();
  setTimeout(readiness, 100_000).unref();
}
// Chart audit: each practice's completed visits checked once a day after 1am practice time.
if (process.env.CHART_AUDIT !== 'off') {
  const audit = () => runExclusive('chart-audit', 60 * 60 * 1000, () => runChartAudits(db, { comparer: createNoteComparer({ config: { ...config, aiFetch: loggedFetch(db) } }) }))
    .then((r) => r?.length && log.info(`Chart audit: ${r.length} practice(s) checked`)).catch(jobFailed('Chart audit'));
  setInterval(audit, 60 * 60 * 1000).unref();
  setTimeout(audit, 180_000).unref();
}
// Long exam recordings: transcription retries, stuck uploads and the retention clean-up.
{
  const examTranscriber = createExamTranscriber({ config, fetchImpl: loggedFetch(db), transcriber: createTranscriber({ config, fetchImpl: loggedFetch(db) }) });
  const recordings = () => runExclusive('long-recordings', 9 * 60 * 1000, () => runRecordingJobs(db, { storage: app.locals.storage, examTranscriber, config }))
    .catch(jobFailed('Long recordings'));
  setInterval(recordings, 10 * 60 * 1000).unref();
  setTimeout(recordings, 200_000).unref();
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
  // Weekly restore drill of each practice's newest stored backup (checked every six hours).
  const drill = () => runExclusive('restore-drills', 60 * 60 * 1000, () => runRestoreDrills(db, { dir: config.backupDir, keys: [config.backupKey, ...config.backupKeysPrevious].filter(Boolean) }))
    .then((r) => r?.length && log.info(`Restore drills: ${r.filter((x) => x.ok).length} passed, ${r.filter((x) => !x.ok).length} failed`))
    .catch(jobFailed('Restore drill'));
  setInterval(drill, 6 * 60 * 60 * 1000).unref();
  setTimeout(drill, 15 * 60_000).unref();
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
// Outside-service activity is kept for 90 days.
{
  const run = () => runExclusive('integration-log-purge', 10 * 60 * 1000, () => purgeIntegrationLog(db)).catch(jobFailed('Integration log purge'));
  setInterval(run, 24 * 60 * 60 * 1000).unref();
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
