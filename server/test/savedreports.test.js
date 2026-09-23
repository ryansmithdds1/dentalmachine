import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { runScheduledReports, rangeFor, isDue } from '../src/savedreports.js';

const h = harness();

test('report periods and schedules', () => {
  assert.deepEqual(rangeFor('last_month', '2031-03-15'), { from: '2031-02-01', to: '2031-02-28' });
  assert.deepEqual(rangeFor('yesterday', '2031-03-01'), { from: '2031-02-28', to: '2031-02-28' });
  assert.deepEqual(rangeFor('mtd', '2031-03-15'), { from: '2031-03-01', to: '2031-03-15' });
  const weekly = { schedule: 'weekly', last_sent_for: null };
  assert.equal(isDue(weekly, '2031-03-17 08:00'), true, 'Monday morning');
  assert.equal(isDue(weekly, '2031-03-17 06:00'), false, 'before 7am');
  assert.equal(isDue(weekly, '2031-03-18 08:00'), false, 'Tuesday');
  assert.equal(isDue({ ...weekly, last_sent_for: '2031-03-17' }, '2031-03-17 09:00'), false, 'already sent');
  assert.equal(isDue({ schedule: 'monthly' }, '2031-04-01 07:30'), true);
});

test('saved reports: filters, preview, send now, and the scheduled email', async () => {
  const { api, patient, provider } = await h.practice({ timezone: 'UTC' });
  const other = (await api.post('/providers', { name: 'Dr. Two', type: 'dentist' })).data;
  const pid = (await api.get('/practice')).data.id;
  const today = new Date().toISOString().slice(0, 10);
  for (const [prov, amt] of [[provider.id, 30000], [other.id, 12000]]) {
    await h.db.run("INSERT INTO ledger_entries (practice_id, patient_id, provider_id, type, amount, description, entry_date) VALUES (?, ?, ?, 'charge', ?, 'Work', ?)", pid, patient.id, prov, amt, today);
  }
  // Provider filter on the production report.
  assert.equal((await api.get(`/reports/production?from=${today}&to=${today}&provider_id=${other.id}`)).data.by_provider.map((p) => p.production).join(), '12000');

  assert.equal((await api.post('/saved-reports', { name: 'Weekly', report: 'production', schedule: 'weekly' })).status, 400, 'needs recipients');
  assert.equal((await api.post('/saved-reports', { name: 'Weekly', report: 'production', recipients: 'not-an-email' })).status, 400);
  const saved = (await api.post('/saved-reports', { name: 'Owner numbers', report: 'production', params: { period: 'mtd' }, schedule: 'daily', recipients: 'owner@example.com, cfo@example.com' })).data;
  const preview = (await api.get(`/saved-reports/${saved.id}/preview`)).data;
  assert.match(preview.subject, /^Owner numbers — Practice \d+$/);
  assert.match(preview.body, /Production\s+\$420\.00/);
  assert.match(preview.body, /Dr\. Ann Lee, DDS\s+\$300\.00/);

  let before = h.sent.length;
  assert.equal((await api.post(`/saved-reports/${saved.id}/send`)).data.sent, 2);
  assert.deepEqual(h.sent.slice(before).map((m) => m.to).sort(), ['cfo@example.com', 'owner@example.com']);

  // Scheduled: sent today already (by "send now"), so the job waits until tomorrow.
  const tomorrow = new Date(Date.now() + 86400_000);
  tomorrow.setUTCHours(8, 0, 0, 0);
  before = h.sent.length;
  assert.equal(await runScheduledReports(h.db, h.messenger, new Date(`${today}T09:00:00Z`)), 0);
  assert.ok(await runScheduledReports(h.db, h.messenger, tomorrow) >= 2);
  assert.ok(h.sent.slice(before).some((m) => m.to === 'owner@example.com' && /Owner numbers/.test(m.subject)));
  assert.equal((await api.get('/saved-reports')).data.saved[0].recipients.length, 2);
});
