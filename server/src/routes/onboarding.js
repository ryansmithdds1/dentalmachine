import { Router } from 'express';
import { DEFAULT_HOURS } from '../hours.js';

// Getting a new office running: each step checks itself off from what's actually set up, with a link
// to where it's done. Shown on the Today page to administrators until it's finished or put away.
export default function onboardingRoutes({ db, messenger, payments }) {
  const r = Router();
  const steps = async (pid) => {
    const p = await db.get('SELECT * FROM practices WHERE id = ?', pid);
    const n = async (sql, ...args) => Number((await db.get(sql, ...args))?.n) || 0;
    const providers = await db.all('SELECT npi FROM providers WHERE practice_id = ? AND active = 1', pid);
    return [
      { key: 'practice', group: 'Your office', title: 'Practice details for claims (NPI, tax ID, address)', done: !!(p.npi && p.tax_id && p.address && p.zip), link: '/settings?tab=practice' },
      { key: 'hours', group: 'Your office', title: 'Office hours', done: !!p.office_hours && p.office_hours !== JSON.stringify(DEFAULT_HOURS), link: '/settings?tab=practice' },
      { key: 'providers', group: 'Your office', title: 'Providers, with their NPIs', done: providers.length > 0 && providers.every((x) => x.npi), link: '/settings?tab=providers' },
      { key: 'chairs', group: 'Your office', title: 'Operatories (chairs)', done: (await n('SELECT COUNT(*) AS n FROM operatories WHERE practice_id = ? AND active = 1', pid)) > 0, link: '/settings?tab=operatories' },
      { key: 'team', group: 'Your office', title: 'Invite your team', done: (await n('SELECT COUNT(*) AS n FROM users WHERE practice_id = ? AND active = 1', pid)) > 1, link: '/settings?tab=users' },
      { key: 'import', group: 'Your data', title: 'Bring over patients from your old system', done: (await n("SELECT COUNT(*) AS n FROM import_batches WHERE practice_id = ?", pid)) > 0 || (await n('SELECT COUNT(*) AS n FROM patients WHERE practice_id = ?', pid)) > 50, link: '/settings?tab=import' },
      { key: 'fees', group: 'Your data', title: 'Your fee schedule', done: (await n("SELECT COUNT(*) AS n FROM fee_history WHERE practice_id = ?", pid)) > 0, link: '/settings?tab=codes' },
      { key: 'carriers', group: 'Your data', title: 'Insurance carriers and PPO fee schedules', done: (await n('SELECT COUNT(*) AS n FROM insurance_carriers WHERE practice_id = ?', pid)) > 0, link: '/settings?tab=carriers' },
      { key: 'texting', group: 'Patients', title: 'Texting and email connected', done: messenger?.status?.sms !== 'log' && messenger?.status?.email !== 'log', link: '/settings?tab=integrations' },
      { key: 'reminders', group: 'Patients', title: 'Appointment reminders and confirmations', done: !!p.reminder_steps, link: '/settings?tab=messaging' },
      { key: 'forms', group: 'Patients', title: 'New-patient forms', done: (await n('SELECT COUNT(*) AS n FROM form_templates WHERE practice_id = ? AND active = 1', pid)) > 0, link: '/settings?tab=forms' },
      { key: 'booking', group: 'Patients', title: 'Online booking on your website and Google', done: !!(p.online_booking && p.slug), link: '/settings?tab=booking' },
      { key: 'payments', group: 'Money', title: 'Card payments', done: !!payments?.enabled, link: '/settings?tab=integrations' },
      { key: 'phone', group: 'Growth', title: 'Office phone line (screen pop, missed-call texts, AI receptionist)', done: !!(p.voice_number || p.forward_to), link: '/settings?tab=phone' },
      { key: 'reviews', group: 'Growth', title: 'Google reviews connected', done: (await n('SELECT COUNT(*) AS n FROM review_connections WHERE practice_id = ?', pid)) > 0, link: '/reputation' },
      { key: 'bank', group: 'Growth', title: 'Business bank account (true costs and deposit matching)', done: (await n('SELECT COUNT(*) AS n FROM bank_connections WHERE practice_id = ?', pid)) > 0, link: '/finance?tab=connections' },
    ];
  };
  r.get('/onboarding', async (req, res) => {
    const p = await db.get('SELECT onboarding_dismissed FROM practices WHERE id = ?', req.user.practice_id);
    const list = await steps(req.user.practice_id);
    res.json({ steps: list, done: list.filter((s) => s.done).length, total: list.length, dismissed: !!p.onboarding_dismissed });
  });
  r.post('/onboarding/dismiss', async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrators only' });
    await db.run('UPDATE practices SET onboarding_dismissed = ? WHERE id = ?', req.body?.dismissed === false ? 0 : 1, req.user.practice_id);
    res.json({ ok: true });
  });
  return r;
}
