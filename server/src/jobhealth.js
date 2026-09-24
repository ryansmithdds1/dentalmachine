// Background jobs that break (CLAUDE.md rule 12): until now a job that threw was only logged and sent to error
// reporting, so an office could go days without reminders, ERA posting or backups and nobody on the team would
// know. cluster.js reports each run here: a failure becomes a Needs attention item for the administrator of every
// practice on this server (a server-wide job is everyone's problem) and the next run that works resolves it.
// The item never carries the error text: it can name another practice's data. The details stay in the server log.
import { raiseIssue, resolveIssue } from './issues.js';
import { audit } from './util.js';
import { withActor } from './actor.js';
import { log } from './monitoring.js';

// runExclusive names → what the office calls them.
export const JOB_LABELS = {
  reminders: 'Appointment reminders, recall texts, forms and fill offers', 'clearinghouse-poll': 'Clearinghouse mailbox (acknowledgments, claim status, ERAs)',
  webhooks: 'Webhook deliveries', memberships: 'Membership billing', cadence: 'Recall and treatment follow-up autopilot', chat: 'Team chat jobs',
  digests: 'Metric emails', 'deposit-watch': 'Deposit watch', 'capacity-snapshots': 'Capacity snapshots', checklists: 'Checklists',
  readiness: 'Visit readiness (lab cases and parts)', referrals: 'Referral follow-up', 'eob-autopilot': 'Insurance autopilot', journeys: 'Patient journeys',
  'chart-audit': 'Chart audit', 'long-recordings': 'Exam recordings', backups: 'Nightly backups', 'restore-drills': 'Backup restore drills',
  autopay: 'Payment-plan autopay', eligibility: 'Overnight eligibility checks', verification: 'Insurance verification', 'recall-age': 'Recall age rule',
  'missed-calls': 'Missed-call check', marketing: 'Marketing attribution', 'fee-changes': 'Fee schedule changes', 'xray-second-look': 'X-ray AI second look',
  benchmarks: 'Benchmarks', 'billing-autopilot': 'Billing autopilot', 'monthly-work': 'Weekly & monthly work', 'plan-late-fees': 'Payment-plan late fees',
  'ortho-billing': 'Ortho billing', 'finance-sync': 'Bank and QuickBooks sync', 'idempotency-purge': 'Clean-up of repeated-request answers',
  'integration-log-purge': 'Clean-up of connection activity', reviews: 'Online reviews sync', surveys: 'Patient surveys', 'scheduled-reports': 'Scheduled reports',
  'auto-watch': 'Hourly check for loose ends',
};
export const jobKey = (name) => `job-failed:${name}`;
const RAISE_EVERY_MS = 10 * 60 * 1000; // a job failing every minute counts up at most every 10 minutes

const lastRaised = new Map();
const failing = new Set();
const checkedSinceBoot = new Set();

export async function jobFailedIssue(db, name, { now = Date.now() } = {}) {
  failing.add(name);
  if (now - (lastRaised.get(name) || 0) < RAISE_EVERY_MS) return 0;
  lastRaised.set(name, now);
  const label = JOB_LABELS[name] || name;
  let n = 0;
  for (const { id } of await db.all('SELECT id FROM practices')) {
    await withActor({ source: 'automation', actor: 'Job monitor', userId: null, practiceId: id }, async () => {
      const had = await db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", id, jobKey(name));
      const issueId = await raiseIssue(db, {
        practiceId: id, kind: 'jobs', key: jobKey(name), role: 'admin', severity: 'high',
        title: `Background work stopped with an error: ${label}`,
        detail: 'It tries again at its next run and this item closes by itself when it works. If it stays open, tell whoever looks after your Dental Machine server (the details are in its log).',
      });
      if (issueId && !had) await audit(db, null, 'job.failed', 'issues', issueId, { job: name });
      n++;
    });
  }
  return n;
}

// A run that worked: close its item wherever it's open. Only looks when this job has failed since the server
// started, or on its first good run after a restart (an item may be left from before).
export async function jobSucceeded(db, name) {
  if (!failing.has(name) && checkedSinceBoot.has(name)) return 0;
  checkedSinceBoot.add(name);
  failing.delete(name);
  lastRaised.delete(name);
  let n = 0;
  for (const { practice_id: pid, id } of await db.all("SELECT practice_id, id FROM issues WHERE dedupe_key = ? AND status = 'open'", jobKey(name))) {
    await withActor({ source: 'automation', actor: 'Job monitor', userId: null, practiceId: pid }, async () => {
      if (await resolveIssue(db, pid, jobKey(name), 'Resolved automatically: the next run worked')) {
        await audit(db, null, 'job.recovered', 'issues', id, { job: name });
        n++;
      }
    });
  }
  return n;
}

// Wired to cluster.js's job runner by index.js. Never throws into the job.
export const jobReporter = (db) => (name, ok) => (ok ? jobSucceeded(db, name) : jobFailedIssue(db, name))
  .catch((err) => log.error(`Could not record the result of job ${name}`, err));

// Test hook: forget what this process remembers.
export function resetJobHealth() {
  lastRaised.clear();
  failing.clear();
  checkedSinceBoot.clear();
}
