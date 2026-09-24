// Load test: builds a practice with tens of thousands of patients and years of history, then times the
// screens staff use all day. Run against a scratch database:
//   node scripts/loadtest.js                       (SQLite file in the temp folder, 50,000 patients)
//   DATABASE_URL=postgres://…/scratch node scripts/loadtest.js --patients 50000
//   node scripts/loadtest.js --reuse <db file> --email admin@middle-earth.dental --password demo-password-123
//     (times an existing database as that user — e.g. one loaded with `npm run seed:themed`)
// Screens used all day have a budget of 800 ms (--budget); reports that run now and then get 1.5 s
// (--report-budget). Anything slower is flagged and the exit code is 1. Nothing here touches a real
// database unless you point it at one — use an empty scratch database.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { seedPracticeDefaults } from '../src/defaults.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const PATIENTS = Number(arg('patients', 50000));
const BUDGET = Number(arg('budget', 800));
const REPORT_BUDGET = Number(arg('report-budget', 1500));
const REPORTS = new Set(['Outstanding claims', 'A/R aging', 'KPIs (90 days)', 'KPIs (12 months)', 'Day sheet', 'Production', 'Collections', 'Hygiene report', 'Treatment plans report', 'Metrics (month)', 'Metrics (year to date)']);
// --reuse <file>: time an already-built SQLite database again (after a code change) without rebuilding it.
const reuse = arg('reuse', null);
const EMAIL = arg('email', 'load@example.com');
const PASSWORD = arg('password', 'load-test-password');
const target = process.env.DATABASE_URL || reuse || join(mkdtempSync(join(tmpdir(), 'dm-load-')), 'load.db');

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];
const day = (offset) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const FIRST = ['Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Elijah', 'Sophia', 'James', 'Isabella', 'Lucas', 'Mia', 'Mason', 'Amelia', 'Ethan', 'Harper', 'Logan', 'Evelyn', 'Aiden', 'Abigail', 'Jackson'];
const LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White', 'Harris'];

// Multi-row INSERTs, a few hundred rows at a time: fast on both databases.
async function bulk(db, table, cols, rows) {
  const per = Math.max(1, Math.floor(900 / cols.length));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    await db.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(',')}`, ...chunk.flat());
  }
}
const ids = async (db, sql, ...p) => (await db.all(sql, ...p)).map((r) => r.id);

async function build(db) {
  const t0 = Date.now();
  const pid = (await db.run("INSERT INTO practices (name, timezone, address, city, state, zip, phone, npi, tax_id) VALUES ('Load Test Dental', 'America/Chicago', '1 Main', 'Austin', 'TX', '78701', '(512) 555-0100', '1234567893', '74-1234567')")).id
    ?? (await db.get("SELECT id FROM practices WHERE name = 'Load Test Dental' ORDER BY id DESC")).id;
  await seedPracticeDefaults(db, pid);
  await db.run('INSERT INTO users (practice_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)', pid, 'load@example.com', 'Load Admin', 'admin', hashPassword('load-test-password'));
  for (const [name, type, npi] of [['Dr. A', 'dentist', '1111111111'], ['Dr. B', 'dentist', '2222222222'], ['Hyg C', 'hygienist', '3333333333'], ['Hyg D', 'hygienist', '4444444444']]) {
    await db.run('INSERT INTO providers (practice_id, name, type, npi) VALUES (?, ?, ?, ?)', pid, name, type, npi);
  }
  const providers = await ids(db, 'SELECT id FROM providers WHERE practice_id = ? ORDER BY id', pid);
  const ops = await ids(db, 'SELECT id FROM operatories WHERE practice_id = ? ORDER BY id', pid);
  for (const [n, payer] of [['Delta Dental', '94276'], ['MetLife', '65978'], ['Cigna', '62308'], ['Aetna', '60054']]) await db.run('INSERT INTO insurance_carriers (practice_id, name, payer_id) VALUES (?, ?, ?)', pid, n, payer);
  const carriers = await ids(db, 'SELECT id FROM insurance_carriers WHERE practice_id = ? ORDER BY id', pid);
  const codes = await db.all("SELECT id, code, description, category, fee FROM procedure_codes WHERE practice_id = ? AND code IN ('D0120','D1110','D0274','D2392','D2740','D0150','D4910')", pid);

  // Patients, a third of them in families.
  const rows = [];
  for (let i = 0; i < PATIENTS; i++) {
    const first = pick(FIRST); const last = pick(LAST);
    rows.push([pid, first, last, day(-Math.floor(3000 + rand() * 25000)), `(512) 555-${String(1000 + (i % 9000)).padStart(4, '0')}`, `${first}.${last}${i}@example.com`.toLowerCase(), rand() < 0.95 ? 'active' : 'inactive', providers[i % 2], day(-Math.floor(rand() * 1500))]);
  }
  await bulk(db, 'patients', ['practice_id', 'first_name', 'last_name', 'dob', 'phone', 'email', 'status', 'primary_provider_id', 'created_at'], rows);
  const pats = await ids(db, 'SELECT id FROM patients WHERE practice_id = ? ORDER BY id', pid);
  for (let i = 0; i < pats.length; i += 3) if (rand() < 0.35 && pats[i + 1]) await db.run('UPDATE patients SET guarantor_id = ? WHERE id IN (?, ?)', pats[i], pats[i + 1], pats[i + 2] ?? pats[i + 1]);
  console.log(`  ${pats.length} patients (${Date.now() - t0} ms)`);

  // Insurance for 60%, recall for everyone.
  const policies = pats.filter(() => rand() < 0.6).map((p) => [pid, p, pick(carriers), 'primary', 'Subscriber', `M${p}`, 'self', 150000, 5000, 1]);
  await bulk(db, 'patient_insurance', ['practice_id', 'patient_id', 'carrier_id', 'priority', 'subscriber_name', 'subscriber_id', 'relationship', 'annual_max', 'deductible', 'active'], policies);
  await bulk(db, 'recalls', ['practice_id', 'patient_id', 'type', 'interval_months', 'due_date', 'status'], pats.map((p) => [pid, p, 'prophy', 6, day(Math.floor(rand() * 400 - 200)), rand() < 0.2 ? 'scheduled' : 'due']));
  const policyOf = new Map((await db.all('SELECT id, patient_id FROM patient_insurance WHERE practice_id = ?', pid)).map((r) => [r.patient_id, r.id]));

  // Two and a half years of visits: ~3 per patient, most completed with charges and payments.
  const appts = [];
  for (const p of pats) {
    const n = 1 + Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) {
      const d = day(Math.floor(rand() * 900) - 870);
      const h = 8 + Math.floor(rand() * 9); const m = rand() < 0.5 ? '00' : '30';
      appts.push([pid, p, pick(providers), pick(ops), `${d} ${String(h).padStart(2, '0')}:${m}`, `${d} ${String(h).padStart(2, '0')}:${m === '00' ? '50' : '59'}`, d < day(0) ? (rand() < 0.07 ? 'no_show' : 'completed') : 'scheduled', 'Recall']);
    }
  }
  await bulk(db, 'appointments', ['practice_id', 'patient_id', 'provider_id', 'operatory_id', 'start_time', 'end_time', 'status', 'reason'], appts);
  console.log(`  ${appts.length} appointments (${Date.now() - t0} ms)`);

  const done = await db.all("SELECT id, patient_id, provider_id, substr(start_time, 1, 10) AS d FROM appointments WHERE practice_id = ? AND status = 'completed'", pid);
  const procs = [];
  for (const a of done) for (const c of [codes[0], codes[1], ...(rand() < 0.25 ? [pick(codes)] : [])]) if (c) procs.push([pid, a.patient_id, a.id, a.provider_id, c.id, c.code, c.description, c.category, c.fee, 'completed', `${a.d} 12:00:00`]);
  await bulk(db, 'procedures', ['practice_id', 'patient_id', 'appointment_id', 'provider_id', 'code_id', 'code', 'description', 'category', 'fee', 'status', 'completed_at'], procs);
  console.log(`  ${procs.length} procedures (${Date.now() - t0} ms)`);

  const pr = await db.all("SELECT id, patient_id, provider_id, fee, substr(completed_at, 1, 10) AS d FROM procedures WHERE practice_id = ? AND status = 'completed'", pid);
  const ledger = pr.map((p) => [pid, p.patient_id, 'charge', p.fee, 'Procedure', p.d, p.id, p.provider_id]);
  // Nine in ten charges are paid at the desk (the patient's share when insured); the rest are still owed.
  for (const p of pr) if (rand() < 0.9) ledger.push([pid, p.patient_id, 'payment', -Math.round(p.fee * (policyOf.has(p.patient_id) ? 0.2 : 1)), 'Patient payment', p.d, null, null]);
  await bulk(db, 'ledger_entries', ['practice_id', 'patient_id', 'type', 'amount', 'description', 'entry_date', 'procedure_id', 'provider_id'], ledger);
  console.log(`  ${ledger.length} ledger entries (${Date.now() - t0} ms)`);

  // A claim per insured visit; most paid, some still out.
  const byAppt = new Map();
  for (const p of await db.all("SELECT id, patient_id, appointment_id, fee FROM procedures WHERE practice_id = ? AND status = 'completed'", pid)) {
    if (!policyOf.has(p.patient_id)) continue;
    if (!byAppt.has(p.appointment_id)) byAppt.set(p.appointment_id, []);
    byAppt.get(p.appointment_id).push(p);
  }
  const claimRows = [];
  for (const [, ps] of byAppt) {
    const total = ps.reduce((s, p) => s + p.fee, 0);
    const status = rand() < 0.85 ? 'paid' : pick(['submitted', 'draft', 'denied']);
    claimRows.push([pid, ps[0].patient_id, policyOf.get(ps[0].patient_id), status, total, Math.round(total * 0.8), status === 'paid' ? Math.round(total * 0.8) : 0, day(-Math.floor(rand() * 800))]);
  }
  await bulk(db, 'claims', ['practice_id', 'patient_id', 'patient_insurance_id', 'status', 'total_fee', 'estimated_amount', 'paid_amount', 'submitted_at'], claimRows);
  const claimIds = await ids(db, 'SELECT id FROM claims WHERE practice_id = ? ORDER BY id', pid);
  const items = [];
  let ci = 0;
  for (const [, ps] of byAppt) { for (const p of ps) items.push([claimIds[ci], p.id, p.fee, Math.round(p.fee * 0.8)]); ci++; }
  await bulk(db, 'claim_items', ['claim_id', 'procedure_id', 'fee', 'estimated_amount'], items);
  // Insurance payments for the paid claims, so most accounts end up settled as in a real office.
  const paid = await db.all("SELECT id, patient_id, paid_amount, submitted_at FROM claims WHERE practice_id = ? AND status = 'paid'", pid);
  await bulk(db, 'ledger_entries', ['practice_id', 'patient_id', 'type', 'amount', 'description', 'entry_date', 'claim_id'], paid.map((c) => [pid, c.patient_id, 'insurance_payment', -c.paid_amount, 'Insurance payment', String(c.submitted_at).slice(0, 10), c.id]));
  console.log(`  ${claimRows.length} claims, ${items.length} lines, ${paid.length} insurance payments (${Date.now() - t0} ms)`);
  return pid;
}

async function main() {
  console.log(reuse ? `Timing ${target}…` : `Building ${PATIENTS} patients in ${/^postgres/.test(target) ? 'Postgres' : `SQLite (${target})`}…`);
  const db = await openDb(target);
  if (!reuse) await build(db);
  const app = createApp({ db, secret: 'load-test-secret', config: { appUrl: 'http://localhost', uploadDir: join(tmpdir(), 'dm-load-uploads') } });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const token = (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json()).token;
  const pid = (await db.get('SELECT practice_id FROM users WHERE lower(email) = lower(?)', EMAIL)).practice_id;
  // A patient with a long history (the chart and ledger are slowest for them).
  const aPatient = (await db.get('SELECT patient_id, COUNT(*) AS n FROM appointments WHERE practice_id = ? GROUP BY patient_id ORDER BY n DESC, patient_id LIMIT 1', pid)).patient_id;
  const today = day(0);
  const screens = [
    ['Patient search', `/patients?q=${arg('q', 'smi')}`], ['Patient list', '/patients'], ['Global search', `/search?q=${arg('q2', 'garc')}`], ['Patient chart', `/patients/${aPatient}`],
    ['Clinical chart', `/patients/${aPatient}/chart`],
    ['Ledger', `/patients/${aPatient}/ledger`], ['Family', `/patients/${aPatient}/family`], ['Schedule (day)', `/schedule?from=${today}&to=${today}`],
    ['Schedule (week)', `/schedule?from=${today}&to=${day(6)}`], ['Huddle', '/huddle'], ['Dashboard', '/dashboard'], ['Claims worklist', '/claims?attention=1'],
    ['Claims (all)', '/claims'], ['Outstanding claims', '/reports/outstanding-claims'], ['A/R aging', '/reports/aging'], ['KPIs (90 days)', `/analytics?from=${day(-89)}&to=${today}`],
    ['KPIs (12 months)', `/analytics?from=${day(-364)}&to=${today}`], ['Day sheet', `/reports/daysheet?date=${day(-1)}`], ['Production', `/reports/production?from=${day(-30)}&to=${today}`],
    ['Recall list', '/recalls'], ['Collections', '/collections'], ['Payment plans', '/payment-plans'], ['Eligibility (tomorrow)', `/eligibility/batch?date=${day(1)}`],
    ['Conversations', '/conversations'], ['Tasks', '/tasks'], ['Audit log', '/audit-log'], ['Hygiene report', `/reports/hygiene?from=${day(-89)}&to=${today}`],
    ['Treatment plans report', '/reports/treatment-plans'], ['Ready to approve', '/claim-queue'], ['Metrics (month)', '/metrics?period=month'],
    ['Metrics (year to date)', '/metrics?period=ytd'], ['Business (today)', '/business/today'],
  ];
  const results = [];
  for (const [name, path] of screens) {
    let best = Infinity; let status = 0; let bytes = 0;
    for (let i = 0; i < 2; i++) { // first run warms caches; keep the better
      const t = performance.now();
      const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.arrayBuffer();
      best = Math.min(best, performance.now() - t); status = res.status; bytes = body.byteLength;
    }
    results.push({ name, path, ms: Math.round(best), status, kb: Math.round(bytes / 1024), budget: REPORTS.has(name) ? REPORT_BUDGET : BUDGET });
  }
  console.log('\nScreen                       ms     KB  status');
  for (const r of results) console.log(`${r.name.padEnd(26)} ${String(r.ms).padStart(6)} ${String(r.kb).padStart(6)}  ${r.status}${r.ms > r.budget ? `  ⚠ over ${r.budget} ms` : ''}${r.status >= 400 ? '  ✗' : ''}`);
  const slow = results.filter((r) => r.ms > r.budget || r.status >= 400);
  server.close();
  await db.close();
  console.log(slow.length ? `\n${slow.length} screen(s) over budget or failing.` : `\nAll screens within budget (${BUDGET} ms; reports ${REPORT_BUDGET} ms).`);
  process.exitCode = slow.length ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
