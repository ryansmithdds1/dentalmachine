import { Router } from 'express';
import { jobRuns } from '../cluster.js';

// Public service status: whether the app, its database and file storage answer, whether texting and email
// are connected, and when the background jobs (reminders, syncs, backups) last ran. Nothing about any
// practice or patient.
const started = Date.now();
const JOBS = {
  reminders: 'Reminders, recalls, forms, campaigns and fill offers', 'finance-sync': 'Bank and QuickBooks sync', reviews: 'Review sync', surveys: 'Patient surveys', backups: 'Backups',
  autopay: 'Autopay', 'clearinghouse-poll': 'Claim responses', eligibility: 'Insurance checks', memberships: 'Membership billing', 'ortho-billing': 'Ortho billing',
  'plan-late-fees': 'Payment plan late fees', 'scheduled-reports': 'Scheduled reports', webhooks: 'Webhooks',
};

export default function statusRoutes({ db, storage, messenger }) {
  const r = Router();
  r.get('/status', async (_req, res) => {
    const checks = [];
    const time = async (name, fn) => {
      const t = Date.now();
      try {
        await fn();
        checks.push({ name, ok: true, ms: Date.now() - t });
      } catch {
        checks.push({ name, ok: false, ms: Date.now() - t });
      }
    };
    await time('Database', () => db.get('SELECT 1 AS ok'));
    await time('File storage', async () => { if (typeof storage?.health === 'function') await storage.health(); });
    const texting = messenger?.status?.sms;
    const email = messenger?.status?.email;
    checks.push({ name: 'Texting', ok: texting !== 'log', note: texting === 'log' ? 'Not connected (messages are logged only)' : 'Connected' });
    checks.push({ name: 'Email', ok: email !== 'log', note: email === 'log' ? 'Not connected (messages are logged only)' : 'Connected' });
    const jobs = jobRuns().map((j) => ({ name: JOBS[j.name] || j.name, ok: j.ok, last_run: j.finished }));
    const down = checks.some((c) => ['Database', 'File storage'].includes(c.name) && !c.ok);
    const degraded = !down && (checks.some((c) => !c.ok) || jobs.some((j) => !j.ok));
    res.set('Cache-Control', 'no-store').status(down ? 503 : 200).json({
      status: down ? 'down' : degraded ? 'degraded' : 'operational', checked_at: new Date().toISOString(), uptime_minutes: Math.round((Date.now() - started) / 60000),
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || process.env.RENDER_GIT_COMMIT?.slice(0, 7) || null,
      checks, jobs, background_jobs: process.env.VERCEL ? 'This deployment runs on serverless hosting, where background jobs only run when triggered.' : null,
    });
  });
  return r;
}
