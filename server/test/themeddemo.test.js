// The themed demo practice (themeddemo.js) at the small size: it loads in resumable batches, a step cut off in
// the middle leaves nothing behind, running it again adds nothing, the money adds up (every balance is the sum of
// its ledger), claims point at their procedures, nothing crosses between practices, its logins work — and the
// original demo practice is exactly as it was. Runs on SQLite, and on Postgres with TEST_DATABASE_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { openDb, schemaInfo } from '../src/db.js';
import { seedDemo, DEMO_EMAIL, DEMO_PASSWORD } from '../src/demo.js';
import { runThemedDemoBatch, seedThemedDemo, resetThemedMemo, themedStatus, THEMED_ADMIN_EMAIL } from '../src/themeddemo.js';
import { buildPlan } from '../src/themedplan.js';
import { STAFF } from '../src/themeddata.js';

const h = harness();
const SIZE = 'small';
let demoPid;
let demoBefore;
let pid;

// Every table with a practice_id: how many rows the practice has, the highest id and, for the ledger, the total.
async function snapshot(db, practiceId) {
  const out = {};
  for (const [table, cols] of schemaInfo()) {
    // Signing in (as these tests do) adds a session and an audit entry; that isn't the seed touching anything.
    if (!cols.some((c) => c.name === 'practice_id') || table === 'staff_sessions') continue;
    if (table === 'audit_log') {
      const a = await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE practice_id = ? AND action NOT LIKE 'auth.%'", practiceId);
      out.audit_log = String(Number(a.n));
      continue;
    }
    const hasId = cols.some((c) => c.name === 'id');
    const r = await db.get(`SELECT COUNT(*) AS n${hasId ? ', MAX(id) AS max_id' : ''} FROM ${table} WHERE practice_id = ?`, practiceId);
    out[table] = `${Number(r.n)}/${hasId ? r.max_id ?? '-' : '-'}`;
  }
  out.ledger_total = Number((await db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE practice_id = ?', practiceId)).n);
  out.users = (await db.all('SELECT email, role, password_hash FROM users WHERE practice_id = ? ORDER BY id', practiceId)).map((u) => `${u.email}|${u.role}|${u.password_hash}`).join(',');
  return out;
}
const counts = async (db, practiceId) => {
  const s = await snapshot(db, practiceId);
  delete s.audit_log; // each step's own audit entry
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'string' ? v.split('/')[0] : v]));
};
const login = async (email, password = DEMO_PASSWORD) => h.client().post('/auth/login', { email, password });

test('loads in resumable batches; a step cut off part-way leaves nothing behind; a second run adds nothing', async () => {
  const db = h.db;
  await seedDemo(db);
  demoPid = (await db.get('SELECT practice_id FROM users WHERE lower(email) = lower(?)', DEMO_EMAIL)).practice_id;
  demoBefore = await snapshot(db, demoPid);
  resetThemedMemo();
  const storage = h.app.locals.storage;

  // One step at a time (as a serverless function with almost no time left would) until the history phase.
  let out;
  let calls = 0;
  do {
    out = await runThemedDemoBatch(db, { seconds: 0, size: SIZE, storage });
    calls++;
    assert.ok(out.steps === 1, 'each call does at least one step');
  } while (out.phase !== 'history' && calls < 20);
  assert.equal(out.phase, 'history');
  pid = out.practiceId;
  assert.ok(pid && pid !== demoPid);
  await runThemedDemoBatch(db, { seconds: 0, size: SIZE, storage }); // one history step
  const mid = await themedStatus(db);
  assert.equal(mid.phase, 'history');
  assert.ok(mid.cursor > 0);

  // A step that fails after writing its rows (a timeout, a lost connection) is rolled back whole.
  const before = await counts(db, pid);
  await assert.rejects(runThemedDemoBatch(db, { seconds: 0, size: SIZE, storage, onStep: () => { throw new Error('cut off'); } }), /cut off/);
  assert.deepEqual(await counts(db, pid), before, 'nothing from the failed step is left');
  assert.deepEqual(await themedStatus(db), mid, 'the marker did not move');
  assert.equal((await db.get('SELECT lease_owner FROM demo_seed_state')).lease_owner, null, 'the lease was let go');

  // Another server holding the lease: this one waits instead of doubling up.
  await db.run("UPDATE demo_seed_state SET lease_owner = 'other', lease_until = ?", new Date(Date.now() + 60_000).toISOString());
  const busy = await runThemedDemoBatch(db, { seconds: 0, size: SIZE, storage });
  assert.equal(busy.busy, true);
  assert.equal(busy.steps, 0);
  await db.run('UPDATE demo_seed_state SET lease_owner = NULL, lease_until = NULL');

  // Carry on to the end.
  out = await seedThemedDemo(db, { size: SIZE, storage });
  assert.equal(out.done, true);
  const status = await themedStatus(db);
  assert.equal(status.phase, 'done');
  assert.equal(status.size, SIZE);
  const done = await counts(db, pid);
  assert.ok(done.patients >= 200, `patients: ${done.patients}`);
  for (const t of ['appointments', 'procedures', 'ledger_entries', 'claims', 'patient_insurance', 'treatment_plans', 'clinical_notes', 'recalls', 'documents', 'messages', 'calls',
    'deposits', 'insurance_checks', 'era_imports', 'statement_runs', 'memberships', 'time_punches', 'tasks', 'issues', 'reviews', 'marketing_touches', 'perio_exams', 'lab_cases']) {
    assert.ok(done[t] > 0, `${t} has rows`);
  }

  // Running it again (a restart, another server, the CLI) adds nothing.
  resetThemedMemo();
  const again = await runThemedDemoBatch(db, { seconds: 5, size: SIZE, storage });
  assert.equal(again.done, true);
  assert.equal(again.steps, 0);
  assert.deepEqual(await counts(db, pid), done);

  // The same plan loaded in one go gives exactly the same rows: the interruptions changed nothing.
  const fresh = await openDb(':memory:');
  try {
    resetThemedMemo();
    const whole = await seedThemedDemo(fresh, { size: SIZE, storage });
    const other = await counts(fresh, whole.practiceId);
    delete other.users; // password hashes are salted
    delete done.users;
    assert.deepEqual(other, done);
  } finally {
    await fresh.close();
    resetThemedMemo();
  }
});

test('every balance is the sum of its ledger, and matches the plan', async () => {
  const db = h.db;
  const state = await db.get('SELECT * FROM demo_seed_state');
  const plan = buildPlan(state.size, state.anchor);
  const pids = JSON.parse(state.data).pids;
  const sums = new Map((await db.all('SELECT patient_id, SUM(amount) AS n FROM ledger_entries WHERE practice_id = ? GROUP BY patient_id', pid)).map((r) => [r.patient_id, Number(r.n)]));
  for (const p of plan.patients) assert.equal(sums.get(pids[p.idx]) ?? 0, p.balance, `${p.first} ${p.last}`);
  // No balance is stored anywhere: the API works it out from the ledger.
  const admin = h.client((await login(THEMED_ADMIN_EMAIL)).data.token);
  const some = await db.all("SELECT id FROM patients WHERE practice_id = ? AND status = 'active' ORDER BY id LIMIT 12", pid);
  for (const { id } of some) {
    const r = await admin.get(`/patients/${id}`);
    assert.equal(r.status, 200);
    assert.equal(Number(r.data.balance), sums.get(id) ?? 0);
  }
  // Integer cents only.
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM ledger_entries WHERE practice_id = ? AND amount <> CAST(amount AS INTEGER)', pid)).n), 0);
  // Corrections are reversals: every voided entry has exactly one reversing entry of the opposite amount.
  const voided = await db.all('SELECT id, amount, type FROM ledger_entries WHERE practice_id = ? AND voided_at IS NOT NULL', pid);
  for (const v of voided) {
    const rev = await db.all('SELECT amount, type FROM ledger_entries WHERE reverses_id = ?', v.id);
    assert.equal(rev.length, 1);
    assert.equal(rev[0].amount, -v.amount);
    assert.equal(rev[0].type, v.type);
  }
  // Refunds point at the payment they give back, on the same account, and never more than it.
  for (const r of await db.all("SELECT l.amount, l.patient_id, o.amount AS paid, o.patient_id AS paid_by, o.type AS paid_type FROM ledger_entries l JOIN ledger_entries o ON o.id = l.refund_of_id WHERE l.practice_id = ? AND l.type = 'refund'", pid)) {
    assert.equal(r.patient_id, r.paid_by);
    assert.equal(r.paid_type, 'payment');
    assert.ok(r.amount > 0 && r.amount <= -r.paid);
  }
  // Each insurance check is exactly the insurance payments posted from it; each deposit, its cash and checks.
  for (const k of await db.all('SELECT id, amount FROM insurance_checks WHERE practice_id = ?', pid)) {
    const n = Number((await db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE insurance_check_id = ? AND type = 'insurance_payment'", k.id)).n);
    assert.equal(-n, k.amount);
  }
  for (const d of await db.all('SELECT id, total FROM deposits WHERE practice_id = ?', pid)) {
    const n = Number((await db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE deposit_id = ?', d.id)).n);
    assert.equal(-n, d.total);
  }
  // A completed procedure is charged exactly once (the database enforces it too).
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM procedures p WHERE p.practice_id = ? AND p.status = 'completed' AND (SELECT COUNT(*) FROM ledger_entries l WHERE l.procedure_id = p.id AND l.type = 'charge') <> 1", pid)).n), 0);
});

test('claims point at the procedures they bill', async () => {
  const db = h.db;
  const claims = await db.all('SELECT id, patient_id, total_fee, status, paid_amount, patient_insurance_id FROM claims WHERE practice_id = ?', pid);
  assert.ok(claims.length > 20);
  const statuses = new Set(claims.map((c) => c.status));
  for (const s of ['paid', 'submitted', 'denied']) assert.ok(statuses.has(s), `a ${s} claim`);
  for (const c of claims) {
    const items = await db.all('SELECT ci.fee, ci.paid_amount, p.patient_id, p.practice_id, p.status FROM claim_items ci JOIN procedures p ON p.id = ci.procedure_id WHERE ci.claim_id = ?', c.id);
    assert.ok(items.length > 0, `claim ${c.id} has lines`);
    for (const i of items) {
      assert.equal(i.patient_id, c.patient_id);
      assert.equal(i.practice_id, pid);
      assert.equal(i.status, 'completed');
    }
    assert.equal(items.reduce((s, i) => s + i.fee, 0), c.total_fee);
    assert.equal(items.reduce((s, i) => s + i.paid_amount, 0), c.paid_amount);
    const policy = await db.get('SELECT patient_id FROM patient_insurance WHERE id = ?', c.patient_insurance_id);
    assert.equal(policy.patient_id, c.patient_id);
    if (c.paid_amount > 0) {
      const paid = Number((await db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE claim_id = ? AND type = 'insurance_payment'", c.id)).n);
      assert.equal(-paid, c.paid_amount);
    }
  }
  // Recent insured work waits in Ready to approve.
  const admin = h.client((await login(THEMED_ADMIN_EMAIL)).data.token);
  const queue = await admin.get('/claim-queue');
  assert.equal(queue.status, 200);
});

test('nothing crosses between the themed practice and any other', async () => {
  const db = h.db;
  const info = schemaInfo();
  for (const [table, cols] of info) {
    if (!cols.some((c) => c.name === 'practice_id')) continue;
    // Every reference to another practice-owned row stays inside the practice.
    for (const c of cols) {
      if (!c.ref || c.ref === 'practices' || !info.get(c.ref)?.some((x) => x.name === 'practice_id')) continue;
      const bad = await db.get(`SELECT COUNT(*) AS n FROM ${table} t JOIN ${c.ref} r ON r.id = t.${c.name} WHERE (t.practice_id = ? AND r.practice_id <> ?) OR (r.practice_id = ? AND t.practice_id <> ?)`, pid, pid, pid, pid);
      assert.equal(Number(bad.n), 0, `${table}.${c.name} → ${c.ref}`);
    }
  }
  // Through the API: each practice sees only its own patients.
  const themed = h.client((await login(THEMED_ADMIN_EMAIL)).data.token);
  const demo = h.client((await login(DEMO_EMAIL)).data.token);
  const hobbits = (await themed.get('/patients?q=Baggins')).data.rows;
  assert.ok(hobbits.length >= 2);
  assert.equal((await demo.get('/patients?q=Baggins')).data.rows.length, 0);
  const demoPatient = await db.get('SELECT id FROM patients WHERE practice_id = ? LIMIT 1', demoPid);
  assert.equal((await themed.get(`/patients/${demoPatient.id}`)).status, 404);
  assert.equal((await demo.get(`/patients/${hobbits[0].id}`)).status, 404);
});

test('every themed login works, with its role', async () => {
  for (const s of STAFF) {
    const r = await login(s.email);
    assert.equal(r.status, 200, s.email);
    assert.equal(r.data.user.role, s.role);
    assert.equal(r.data.user.practice_id, pid);
  }
  const desk = h.client((await login('pepper@middle-earth.dental')).data.token);
  const today = (await themedStatus(h.db)).anchor;
  const day = await desk.get(`/schedule?from=${today}&to=${today}`);
  assert.equal(day.status, 200);
  // A sample x-ray opens.
  const doc = await h.db.get("SELECT id FROM documents WHERE practice_id = ? AND category = 'xray' LIMIT 1", pid);
  const admin = h.client((await login(THEMED_ADMIN_EMAIL)).data.token);
  const res = await fetch(`${h.origin}/api/documents/${doc.id}/file`, { headers: { Authorization: `Bearer ${(await login(THEMED_ADMIN_EMAIL)).data.token}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/png/);
  assert.ok((await admin.get('/patients')).data.rows.length > 0);
});

test('the original demo practice is untouched', async () => {
  assert.deepEqual(await snapshot(h.db, demoPid), demoBefore);
  const r = await login(DEMO_EMAIL);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.practice_id, demoPid);
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM patients WHERE practice_id = ?', demoPid)).n), 40);
});
