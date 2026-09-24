// The automation pass (W8, docs/workflows/automation-pass.md): lists a person had to check become Needs attention
// items only when something is waiting, and resolve themselves; background jobs that break become Needs attention
// items too. Everything runs as the automation, is idempotent and audited, and never changes money or charts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { insert, localNow } from '../src/util.js';
import { runAutoWatch, CREDIT_DAYS } from '../src/autowatch.js';
import { jobFailedIssue, jobSucceeded, jobReporter, jobKey, resetJobHealth } from '../src/jobhealth.js';
import { runExclusive, onJobRun } from '../src/cluster.js';

const h = harness();

const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const openIssue = (pid, key) => h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", pid, key);
const lastIssue = (pid, key) => h.db.get('SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = ? ORDER BY id DESC LIMIT 1', pid, key);
const money = async (pid) => ({
  ledger: Number((await h.db.get('SELECT COUNT(*) AS n FROM ledger_entries WHERE practice_id = ?', pid)).n),
  claims: (await h.db.all('SELECT id, status FROM claims WHERE practice_id = ? ORDER BY id', pid)).map((c) => `${c.id}:${c.status}`).join(','),
  procedures: (await h.db.all('SELECT id, status FROM procedures WHERE practice_id = ? ORDER BY id', pid)).map((p) => `${p.id}:${p.status}`).join(','),
});

async function insured(api, patient) {
  const carrier = (await api.post('/carriers', { name: `Payer ${Math.random().toString(36).slice(2, 6)}`, payer_id: '62308' })).data;
  return (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'C77' })).data;
}

test('forgotten clock-outs are raised in the background, once, and resolve when the punch is closed', async () => {
  const { practiceId } = await practice();
  const admin = await h.db.get('SELECT id, name FROM users WHERE practice_id = ?', practiceId);
  const now = localNow('UTC');
  const hourAgo = localNow('UTC', new Date(Date.now() - 3600_000));
  const old = await insert(h.db, 'time_punches', { practice_id: practiceId, user_id: admin.id, clock_in: `${daysAgo(1)} 08:00`, eff_in: `${daysAgo(1)} 08:00` });
  const fresh = await insert(h.db, 'time_punches', { practice_id: practiceId, user_id: admin.id, clock_in: hourAgo, eff_in: hourAgo });

  await runAutoWatch(h.db, { practiceId });
  await runAutoWatch(h.db, { practiceId });
  const item = await openIssue(practiceId, `timeclock-open:${old}`);
  assert.ok(item, 'raised without anyone opening the Today board');
  assert.match(item.title, new RegExp(`${admin.name} is still clocked in from ${daysAgo(1)} 08:00`));
  assert.equal(item.occurrences, 2, 'counted up, not duplicated');
  assert.equal(item.source, 'automation');
  assert.equal(await openIssue(practiceId, `timeclock-open:${fresh}`), undefined, 'an hour-old punch is fine');
  const raised = await h.db.all("SELECT source, actor FROM audit_log WHERE action = 'automation.raise' AND entity_id = ?", item.id);
  assert.deepEqual(raised, [{ source: 'automation', actor: 'Automation pass' }], 'audited once, as the automation');

  await h.db.run('UPDATE time_punches SET clock_out = ?, eff_out = ? WHERE id = ?', now, now, old);
  await runAutoWatch(h.db, { practiceId });
  assert.equal(await openIssue(practiceId, `timeclock-open:${old}`), undefined, 'resolved once the punch is closed');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'automation.resolve' AND entity_id = ?", item.id));
  assert.equal((await h.db.get('SELECT clock_out FROM time_punches WHERE id = ?', fresh)).clock_out, null, 'never touches a punch');
});

test("yesterday's loose ends: unbilled work, unsent claims and open visits are raised, then resolve as they're worked — nothing is billed for them", async () => {
  const { api, practiceId, patient, provider } = await practice();
  const policy = await insured(api, patient);
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2740', tooth: '19', provider_id: provider.id, complete: true })).data;
  await h.db.run('UPDATE procedures SET completed_at = ? WHERE id = ?', `${daysAgo(3)} 10:00:00`, proc.id);
  const today = await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true });
  assert.equal(today.status, 201, 'work done today is not a loose end yet');
  const visit = await insert(h.db, 'appointments', { practice_id: practiceId, patient_id: patient.id, provider_id: provider.id, start_time: `${daysAgo(2)} 09:00`, end_time: `${daysAgo(2)} 10:00`, status: 'confirmed' });

  const before = await money(practiceId);
  const r = (await runAutoWatch(h.db, { practiceId }))[practiceId];
  assert.equal(r.unbilled, 1);
  assert.equal(r.open_visits, 1);
  assert.match((await openIssue(practiceId, 'unbilled-work')).title, /^1 completed procedure for insured patients is not on a claim/);
  assert.equal((await openIssue(practiceId, 'unbilled-work')).role, 'billing');
  assert.equal((await openIssue(practiceId, 'visits-left-open')).role, 'front_desk');
  assert.deepEqual(await money(practiceId), before, 'no claim made, nothing posted, no procedure changed');

  // A person bills it; the claim sits unsent for days.
  const made = await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  await h.db.run('UPDATE claims SET created_at = ? WHERE id = ?', `${daysAgo(3)} 10:00:00`, made.data.id);
  await h.db.run("UPDATE appointments SET status = 'completed' WHERE id = ?", visit);
  const r2 = (await runAutoWatch(h.db, { practiceId }))[practiceId];
  assert.equal(r2.unbilled, 0);
  assert.equal(r2.unsent, 1);
  assert.equal(await openIssue(practiceId, 'unbilled-work'), undefined);
  assert.equal(await openIssue(practiceId, 'visits-left-open'), undefined);
  assert.match((await lastIssue(practiceId, 'unbilled-work')).resolution, /on a claim/);
  assert.ok(await openIssue(practiceId, 'claims-not-sent'));
  assert.equal((await h.db.get('SELECT status FROM claims WHERE id = ?', made.data.id)).status, 'draft', 'the pass never sends a claim');

  await h.db.run("UPDATE claims SET status = 'submitted', submitted_at = ? WHERE id = ?", `${daysAgo(1)} 10:00:00`, made.data.id);
  await runAutoWatch(h.db, { practiceId });
  assert.equal(await openIssue(practiceId, 'claims-not-sent'), undefined);
});

test('cash and checks not on a deposit are raised only for offices that record deposits', async () => {
  const { api, practiceId, patient } = await practice();
  const paid = await api.post(`/patients/${patient.id}/payments`, { amount: 40, method: 'check', reference: '1001' });
  assert.equal(paid.status, 201, JSON.stringify(paid.data));
  await h.db.run('UPDATE ledger_entries SET entry_date = ? WHERE practice_id = ? AND type = ?', daysAgo(2), practiceId, 'payment');
  assert.equal((await runAutoWatch(h.db, { practiceId }))[practiceId].undeposited, 0, 'no deposits recorded here: not nagged');
  await insert(h.db, 'deposits', { practice_id: practiceId, deposit_date: daysAgo(10), total: 0 });
  assert.equal((await runAutoWatch(h.db, { practiceId }))[practiceId].undeposited, 1);
  assert.ok(await openIssue(practiceId, 'payments-not-deposited'));
});

test('pre-authorizations with no answer after 30 days are raised and resolve when answered', async () => {
  const { api, practiceId, patient } = await practice();
  const policy = await insured(api, patient);
  const pa = await insert(h.db, 'preauths', { practice_id: practiceId, patient_id: patient.id, patient_insurance_id: policy.id, status: 'submitted', procedure_ids: '[]', total_fee: 120000, submitted_at: `${daysAgo(40)}T10:00:00.000Z` });
  await insert(h.db, 'preauths', { practice_id: practiceId, patient_id: patient.id, patient_insurance_id: policy.id, status: 'submitted', procedure_ids: '[]', total_fee: 50000, submitted_at: `${daysAgo(5)}T10:00:00.000Z` });
  assert.equal((await runAutoWatch(h.db, { practiceId }))[practiceId].preauths, 1);
  assert.match((await openIssue(practiceId, 'preauths-no-answer')).title, /^1 pre-authorization has had no answer/);
  await h.db.run("UPDATE preauths SET status = 'approved' WHERE id = ?", pa);
  await runAutoWatch(h.db, { practiceId });
  assert.equal(await openIssue(practiceId, 'preauths-no-answer'), undefined);
});

test('old credit balances go to the refund queue as one item — nothing is refunded; a booked visit makes it a prepayment', async () => {
  const { api, practiceId, patient, provider } = await practice();
  assert.equal((await api.post(`/patients/${patient.id}/payments`, { amount: 75, method: 'cash' })).status, 201);
  await h.db.run('UPDATE ledger_entries SET entry_date = ? WHERE practice_id = ?', daysAgo(CREDIT_DAYS + 5), practiceId);
  const before = await money(practiceId);
  assert.equal((await runAutoWatch(h.db, { practiceId }))[practiceId].credits, 1);
  assert.match((await openIssue(practiceId, 'credit-balances')).detail, /Credits & refunds/);
  assert.deepEqual(await money(practiceId), before, 'no refund posted');
  await insert(h.db, 'appointments', { practice_id: practiceId, patient_id: patient.id, provider_id: provider.id, start_time: `${inDays(7)} 09:00`, end_time: `${inDays(7)} 10:00`, status: 'scheduled' });
  assert.equal((await runAutoWatch(h.db, { practiceId }))[practiceId].credits, 0);
  assert.equal(await openIssue(practiceId, 'credit-balances'), undefined);
});

test('expiring office licences get their renewal to-do from the background job, once, audited', async () => {
  const { practiceId } = await practice();
  const doc = await insert(h.db, 'documents', { practice_id: practiceId, patient_id: null, category: 'license', filename: 'State licence.pdf', mime: 'application/pdf', size: 10, storage_key: 'k', inbox: 0, expires_on: inDays(20) });
  await runAutoWatch(h.db, { practiceId });
  await runAutoWatch(h.db, { practiceId });
  const tasks = await h.db.all('SELECT * FROM tasks WHERE practice_id = ? AND title LIKE ?', practiceId, '%State licence%');
  assert.equal(tasks.length, 1, 'one to-do however often it runs');
  assert.equal((await h.db.get('SELECT expiry_task_id FROM documents WHERE id = ?', doc)).expiry_task_id, tasks[0].id);
  const a = await h.db.get("SELECT source, practice_id FROM audit_log WHERE action = 'document.expiry_reminder' AND entity_id = ?", doc);
  assert.deepEqual({ ...a }, { source: 'automation', practice_id: practiceId });
});

test("one practice's broken pass becomes its own Needs attention item; the others carry on and a later pass resolves it", async () => {
  const a = await practice();
  const b = await practice();
  // A database that fails on one practice's punches only.
  const broken = {
    dialect: h.db.dialect, get: (...x) => h.db.get(...x), run: (...x) => h.db.run(...x), tx: (fn) => h.db.tx(fn),
    all: (sql, ...args) => (sql.includes('FROM time_punches') && args[0] === a.practiceId ? Promise.reject(new Error('disk on fire')) : h.db.all(sql, ...args)),
  };
  const out = await runAutoWatch(broken, {});
  assert.equal(out[a.practiceId].error, 'disk on fire');
  assert.ok(!out[b.practiceId].error, 'the other practice was still checked');
  const item = await openIssue(a.practiceId, 'autowatch-failed');
  assert.equal(item.kind, 'jobs');
  assert.equal(await openIssue(b.practiceId, 'autowatch-failed'), undefined);
  await runAutoWatch(h.db, { practiceId: a.practiceId });
  assert.equal(await openIssue(a.practiceId, 'autowatch-failed'), undefined);
});

test('a background job that fails becomes a Needs attention item for every practice (no error text), throttled, and the next good run resolves it', async () => {
  resetJobHealth();
  const a = await practice();
  const b = await practice();
  onJobRun(jobReporter(h.db));
  try {
    await assert.rejects(runExclusive('eob-autopilot', 1000, async () => { throw new Error('patient Jane Doe 555-0100 broke it'); }));
    for (const p of [a, b]) {
      const item = await openIssue(p.practiceId, jobKey('eob-autopilot'));
      assert.ok(item, 'raised for each practice');
      assert.equal(item.kind, 'jobs');
      assert.equal(item.role, 'admin');
      assert.match(item.title, /Insurance autopilot/);
      assert.doesNotMatch(`${item.title} ${item.detail}`, /Jane|555/, 'the error text (which can name a patient) is not copied');
    }
    // Failing again at once only counts up after the throttle window.
    assert.equal(await jobFailedIssue(h.db, 'eob-autopilot'), 0);
    assert.ok(await jobFailedIssue(h.db, 'eob-autopilot', { now: Date.now() + 11 * 60_000 }) >= 2);
    assert.equal((await openIssue(a.practiceId, jobKey('eob-autopilot'))).occurrences, 2);
    assert.equal(Number((await h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'job.failed' AND practice_id = ?", a.practiceId)).n), 1, 'audited when opened');

    assert.equal(await runExclusive('eob-autopilot', 1000, async () => 'ok'), 'ok');
    assert.equal(await openIssue(a.practiceId, jobKey('eob-autopilot')), undefined);
    assert.equal(await openIssue(b.practiceId, jobKey('eob-autopilot')), undefined);
    assert.match((await lastIssue(b.practiceId, jobKey('eob-autopilot'))).resolution, /next run worked/);
    assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'job.recovered' AND practice_id = ? AND source = 'automation'", a.practiceId));
    // A healthy job doesn't look again once it has checked after start-up.
    assert.equal(await jobSucceeded(h.db, 'eob-autopilot'), 0);
  } finally {
    onJobRun(null);
    resetJobHealth();
  }
});

async function practice() {
  return h.practice({ timezone: 'UTC' });
}
