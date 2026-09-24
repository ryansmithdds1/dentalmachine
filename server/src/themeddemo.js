// A second, themed demo practice — "Fellowship Dental Partners", with Rivendell Family Dental and Stark Tower
// Smiles — sized like a real two-office practice (about 3,000 active patients, two years of history, six weeks
// booked ahead) so the product can be tried, and its speed checked, with lots of data. Characters only: every
// name is a fictional Middle-earth or Marvel character or an invented one; carriers and employers are made up.
//
// The data is planned in memory (themedplan.js, deterministic) and written in small steps, each one transaction
// that also moves a progress marker (demo_seed_state): a serverless function that is stopped mid-way leaves either
// a whole step or none, and the next call rebuilds the same plan and carries on. Running it again when it's done
// adds nothing. A lease keeps two servers from working on it at once, and each step re-checks the marker inside its
// transaction, so even a lost lease can't write a step twice.
//
// Rows are written with multi-row INSERTs, exactly as the app itself would have left them: balances are the sum
// of ledger entries, voids are a voided entry plus a reversing entry, refunds are their own entries, claims point
// at the procedures they bill. Each step writes one audit entry (source "import") saying what it loaded.
//
// Turned on with DEMO_THEMED=on (api/index.js and index.js advance it a batch at a time); `npm run seed:themed`
// runs it to the end locally. THEMED_DEMO_SIZE=small|medium|large (default large).
import { createHash, randomUUID } from 'node:crypto';
import { hashPassword } from './auth.js';
import { localNow } from './util.js';
import { seedPracticeDefaults } from './defaults.js';
import { recallTypes } from './recalls.js';
import { withActor } from './actor.js';
import { DEMO_PASSWORD } from './demo.js';
import * as D from './themeddata.js';
import { SAMPLE_IMAGES } from './themedimages.js';
import { SIZES, buildPlan, CODES, VISIT_KINDS, ppoFee, dn, ds, hhmm, rng, isWorkday } from './themedplan.js';

export { THEMED_ADMIN_EMAIL } from './themeddata.js';
export const THEMED_SIZES = SIZES;
const KEY = 'themed';
const ACTOR = 'Themed demo seed';
const PATIENT_CHUNK = 600;

export const themedSize = (s = process.env.THEMED_DEMO_SIZE) => (SIZES[s] ? s : 'large');

// ---- Small helpers ----
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const at = (n, minutes, sec = 0) => `${ds(n)} ${hhmm(minutes)}:${String(sec).padStart(2, '0')}`;
const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
// A valid NPI (Luhn check digit over the 80840 prefix) from the first nine digits of the given one.
export function npi(base) {
  const digits = `80840${String(base).slice(0, 9)}`.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits[digits.length - 1 - i];
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return `${String(base).slice(0, 9)}${(10 - (sum % 10)) % 10}`;
}

// Multi-row INSERT. Chunk sizes are powers of two below the cap, so SQLite's statement cache stays small.
// With `returning`, the new ids come back in row order (ids rise in insert order within one statement).
async function bulk(db, table, rows, { returning = false } = {}) {
  if (!rows.length) return [];
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const per = Math.max(1, Math.floor(4000 / cols.length));
  const ids = [];
  for (let i = 0; i < rows.length;) {
    const left = rows.length - i;
    const n = left >= per ? per : 2 ** Math.floor(Math.log2(left));
    const chunk = rows.slice(i, i + n);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}${returning ? ' RETURNING id' : ''}`;
    const out = await db.all(sql, ...chunk.flatMap((r) => cols.map((c) => (r[c] === undefined ? null : r[c]))));
    if (returning) ids.push(...out.map((o) => Number(o.id)).sort((a, b) => a - b));
    i += n;
  }
  return ids;
}

// ---- Progress marker ----
async function readState(db) {
  return db.get('SELECT * FROM demo_seed_state WHERE key = ?', KEY);
}

const plans = new Map();
function planFor(state) {
  const k = `${state.size}|${state.anchor}`;
  if (!plans.has(k)) { plans.clear(); plans.set(k, buildPlan(state.size, state.anchor)); }
  return plans.get(k);
}

// Status of the themed seed, for the CLI and tests.
export async function themedStatus(db) {
  const s = await readState(db);
  return s ? { phase: s.phase, cursor: s.cursor, size: s.size, anchor: s.anchor, practice_id: s.themed_practice_id, done: s.phase === 'done', started_at: s.started_at, finished_at: s.finished_at } : null;
}

let finished = false;
class Busy extends Error {}

// Advances the themed seed by up to `seconds` of work (always at least one step). Returns where it got to.
// `onStep` (tests) runs inside each step's transaction, after its rows and before the marker moves.
export async function runThemedDemoBatch(db, { seconds = 20, size, storage = null, onStep = null, owner = randomUUID() } = {}) {
  const t0 = Date.now();
  if (finished) return { done: true, phase: 'done', steps: 0, ms: 0 };
  let state = await readState(db);
  if (!state) {
    const sizeName = themedSize(size);
    const anchor = localNow(D.PRACTICE.timezone).slice(0, 10);
    // A themed practice made before the marker existed counts as done: never a second copy.
    const exists = await db.get('SELECT id, practice_id FROM users WHERE lower(email) = lower(?)', D.THEMED_ADMIN_EMAIL);
    await db.run(
      `INSERT INTO demo_seed_state (key, size, anchor, phase, cursor, data, themed_practice_id, started_at, updated_at, finished_at)
       VALUES (?, ?, ?, ?, 0, '{}', ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`,
      KEY, sizeName, anchor, exists ? 'done' : 'setup', exists?.practice_id ?? null, nowIso(), nowIso(), exists ? nowIso() : null,
    );
    state = await readState(db);
  }
  if (state.phase === 'done') { finished = true; return { done: true, phase: 'done', steps: 0, ms: Date.now() - t0, practiceId: state.themed_practice_id }; }
  const leaseMs = Math.max(60, seconds * 3) * 1000;
  const until = () => new Date(Date.now() + leaseMs).toISOString();
  const took = await db.run(
    "UPDATE demo_seed_state SET lease_owner = ?, lease_until = ? WHERE key = ? AND phase <> 'done' AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)",
    owner, until(), KEY, new Date().toISOString(), owner,
  );
  if (!took.changes) return { done: false, busy: true, phase: state.phase, cursor: state.cursor, steps: 0, ms: Date.now() - t0 };
  let steps = 0;
  try {
    for (;;) {
      state = await readState(db);
      if (state.phase === 'done') break;
      await withActor({ source: 'import', actor: ACTOR, practiceId: state.themed_practice_id ?? null }, () => step(db, state, { storage, onStep }));
      steps++;
      if (Date.now() - t0 >= seconds * 1000) break;
      await db.run('UPDATE demo_seed_state SET lease_until = ? WHERE key = ? AND lease_owner = ?', until(), KEY, owner);
    }
  } catch (err) {
    if (!(err instanceof Busy)) throw err;
  } finally {
    await db.run('UPDATE demo_seed_state SET lease_owner = NULL, lease_until = NULL WHERE key = ? AND lease_owner = ?', KEY, owner);
  }
  state = await readState(db);
  if (state.phase === 'done') finished = true;
  return { done: state.phase === 'done', phase: state.phase, cursor: state.cursor, steps, ms: Date.now() - t0, practiceId: state.themed_practice_id };
}

// Runs it to the end (the CLI, tests).
export async function seedThemedDemo(db, opts = {}) {
  let out;
  do {
    out = await runThemedDemoBatch(db, { seconds: 3600, ...opts });
    if (out.busy) await new Promise((r) => setTimeout(r, 1000));
  } while (!out.done);
  return out;
}

// For tests: forget the "already finished" memo (a new database in the same process).
export function resetThemedMemo() {
  finished = false;
}

async function step(db, state, env) {
  const plan = planFor(state);
  const data = JSON.parse(state.data || '{}');
  // Sample images are saved before the transaction (storage may be a network call); keys go in with the step.
  if (state.phase === 'images') data.images = await saveImages(env.storage, state.themed_practice_id);
  await db.tx(async () => {
    const lock = await db.run('UPDATE demo_seed_state SET updated_at = ? WHERE key = ? AND phase = ? AND cursor = ?', nowIso(), KEY, state.phase, state.cursor);
    if (!lock.changes) throw new Busy('Another server moved the themed seed on');
    const counts = {};
    const next = await PHASES[state.phase](db, plan, state, data, counts);
    await env.onStep?.(state.phase, state.cursor);
    const practiceId = next.practiceId ?? state.themed_practice_id;
    await db.run(
      'UPDATE demo_seed_state SET phase = ?, cursor = ?, data = ?, themed_practice_id = ?, updated_at = ?, finished_at = ? WHERE key = ?',
      next.phase, next.cursor ?? 0, JSON.stringify(data), practiceId, nowIso(), next.phase === 'done' ? nowIso() : null, KEY,
    );
    await db.run(
      `INSERT INTO audit_log (practice_id, user_id, action, entity, entity_id, details, source, actor, reason)
       VALUES (?, NULL, 'demo.seed', 'practices', ?, ?, 'import', ?, ?)`,
      practiceId, practiceId, JSON.stringify({ phase: state.phase, cursor: state.cursor, size: state.size, rows: counts }), ACTOR, 'Themed demo practice (sample data)',
    );
  });
}

async function saveImages(storage, practiceId) {
  if (!storage?.save || !practiceId) return null;
  const out = {};
  for (const [key, , filename, , make] of SAMPLE_IMAGES) {
    const buf = make();
    const saved = await storage.save(practiceId, buf);
    out[key] = { storageKey: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, size: buf.length, filename, hash: createHash('sha256').update(buf).digest('hex') };
  }
  return out;
}

// ---- What's already in the database, by name ----
async function context(db, pid) {
  const byKey = (rows, k, v = 'id') => Object.fromEntries(rows.map((r) => [r[k], r[v]]));
  const users = await db.all('SELECT id, email FROM users WHERE practice_id = ?', pid);
  const userOf = Object.fromEntries(D.STAFF.map((s) => [s.key, users.find((u) => u.email.toLowerCase() === s.email.toLowerCase())?.id]));
  const provRows = await db.all('SELECT id, name FROM providers WHERE practice_id = ?', pid);
  const provOf = Object.fromEntries(D.PROVIDERS.map((p) => [p.key, provRows.find((r) => r.name === p.name)?.id]));
  const opRows = await db.all('SELECT id, name FROM operatories WHERE practice_id = ?', pid);
  const ops = D.OPERATORIES.map((o) => opRows.find((r) => r.name === o.name)?.id);
  const locRows = await db.all('SELECT id, name FROM locations WHERE practice_id = ?', pid);
  const locOf = Object.fromEntries(D.OFFICES.map((o) => [o.key, locRows.find((r) => r.name === o.name)?.id]));
  const codes = byKey(await db.all('SELECT id, code FROM procedure_codes WHERE practice_id = ?', pid), 'code');
  const types = byKey(await db.all('SELECT id, name FROM appointment_types WHERE practice_id = ?', pid), 'name');
  const carrierRows = await db.all('SELECT id, name FROM insurance_carriers WHERE practice_id = ?', pid);
  const carrierOf = Object.fromEntries(D.CARRIERS.map((c) => [c.key, carrierRows.find((r) => r.name === c.name)?.id]));
  const planRows = await db.all('SELECT id, name FROM insurance_plans WHERE practice_id = ?', pid);
  const insPlanOf = Object.fromEntries(D.PLANS.map(([k, , name]) => [k, planRows.find((r) => r.name === name)?.id]));
  const mpRows = await db.all('SELECT id, name FROM membership_plans WHERE practice_id = ?', pid);
  const memberPlanOf = Object.fromEntries(D.MEMBERSHIP_PLANS.map((m) => [m.key, mpRows.find((r) => r.name === m.name)?.id]));
  const rcRows = await db.all('SELECT id, name FROM referral_contacts WHERE practice_id = ?', pid);
  const contactOf = Object.fromEntries(D.REFERRAL_CONTACTS.map((c) => [c.key, rcRows.find((r) => r.name === c.name)?.id]));
  const msRows = await db.all('SELECT id, name FROM marketing_sources WHERE practice_id = ?', pid);
  const sourceOf = Object.fromEntries(D.MARKETING_SOURCES.map((s) => [s.key, msRows.find((r) => r.name === s.name)?.id]));
  const campaigns = await db.all('SELECT id, name, promo_code, source_id FROM marketing_campaigns WHERE practice_id = ?', pid);
  const survey = (await db.get('SELECT id FROM surveys WHERE practice_id = ? ORDER BY id LIMIT 1', pid))?.id ?? null;
  const officeOfLoc = Object.fromEntries(Object.entries(locOf).map(([k, v]) => [v, k]));
  const deposits = Object.fromEntries((await db.all('SELECT id, location_id, deposit_date FROM deposits WHERE practice_id = ?', pid)).map((d) => [`${officeOfLoc[d.location_id]}|${dn(d.deposit_date)}`, d.id]));
  const checks = byKey(await db.all('SELECT id, check_number FROM insurance_checks WHERE practice_id = ?', pid), 'check_number');
  return { pid, userOf, provOf, ops, locOf, codes, types, carrierOf, insPlanOf, memberPlanOf, contactOf, sourceOf, campaigns, survey, deposits, checks };
}

// ---- Phases ----
const PHASES = {
  // The practice, its offices, people, fee schedules, carriers, plans and settings.
  async setup(db, plan, state, data, counts) {
    const P = D.PRACTICE;
    const anchor = plan.anchor;
    const pid = (await db.all(
      `INSERT INTO practices (name, address, city, state, zip, phone, email, npi, tax_id, timezone, slug, online_booking, reminder_hours, reminder_steps, daily_goal, hygiene_goal,
        review_url, review_requests, claim_prep, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 48, ?, ?, ?, ?, 1, 1, ?) RETURNING id`,
      P.name, P.address, P.city, P.state, P.zip, P.phone, P.email, npi(P.npi), P.tax_id, P.timezone, P.slug,
      JSON.stringify([{ hours: 168, channel: 'email', confirmed: false }, { hours: 48, channel: 'auto', confirmed: false }, { hours: 4, channel: 'sms', confirmed: true }]),
      1400000, 500000, 'https://reviews.example/fellowship-dental', `${ds(plan.histStart - 30)} 09:00:00`,
    ))[0].id;
    await seedPracticeDefaults(db, pid);
    await recallTypes(db, pid);
    // Offices, and the starter operatories renamed into Rivendell's.
    const locIds = await bulk(db, 'locations', D.OFFICES.map((o, i) => ({ practice_id: pid, name: o.name, address: o.address, city: o.city, state: o.state, zip: o.zip, phone: o.phone, npi: npi(P.npi), sort: i })), { returning: true });
    const locOf = Object.fromEntries(D.OFFICES.map((o, i) => [o.key, locIds[i]]));
    const starter = (await db.all('SELECT id FROM operatories WHERE practice_id = ? ORDER BY id', pid)).map((r) => r.id);
    const staffRows = D.STAFF.map((s) => ({ practice_id: pid, email: s.email, name: s.name, role: s.role, password_hash: hashPassword(DEMO_PASSWORD), created_at: `${ds(plan.histStart - 30)} 09:00:00` }));
    const userIds = await bulk(db, 'users', staffRows, { returning: true });
    const userOf = Object.fromEntries(D.STAFF.map((s, i) => [s.key, userIds[i]]));
    const hours = (days) => JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, days[d] ? [['08:00', '17:00']] : []])));
    const provIds = await bulk(db, 'providers', D.PROVIDERS.map((p) => ({
      practice_id: pid, user_id: userOf[p.user], name: p.name, type: p.type, npi: npi(p.npi), license_number: p.license ?? null, dea_number: p.dea ?? null, color: p.color, working_hours: hours(p.days),
    })), { returning: true });
    const provOf = Object.fromEntries(D.PROVIDERS.map((p, i) => [p.key, provIds[i]]));
    for (let i = 0; i < D.OPERATORIES.length; i++) {
      const o = D.OPERATORIES[i];
      const row = { name: o.name, location_id: locOf[o.office], is_hygiene: o.kind === 'hyg' ? 1 : 0, default_provider_id: o.hyg ? provOf[o.hyg] : null, sort: i };
      if (i < starter.length) await db.run('UPDATE operatories SET name = ?, location_id = ?, is_hygiene = ?, default_provider_id = ?, sort = ? WHERE id = ?', row.name, row.location_id, row.is_hygiene, row.default_provider_id, row.sort, starter[i]);
      else await bulk(db, 'operatories', [{ practice_id: pid, ...row }]);
    }
    // More kinds of visit than the starter set.
    const sort0 = Number((await db.get('SELECT COUNT(*) AS n FROM appointment_types WHERE practice_id = ?', pid)).n);
    await bulk(db, 'appointment_types', [
      { practice_id: pid, name: 'Scaling & root planing', duration: 90, color: '#0d9488', procedure_codes: JSON.stringify(['D4341']), provider_type: 'hygienist', online_bookable: 0, sort: sort0 },
      { practice_id: pid, name: 'Implant surgery', duration: 90, color: '#b45309', procedure_codes: JSON.stringify(['D6010']), provider_type: 'dentist', online_bookable: 0, sort: sort0 + 1 },
      { practice_id: pid, name: 'Implant crown', duration: 60, color: '#d97706', procedure_codes: JSON.stringify(['D6057', 'D6065']), provider_type: 'dentist', online_bookable: 0, sort: sort0 + 2 },
    ]);
    // PPO fee schedules, carriers, employer plans with their benefits.
    const codes = await db.all('SELECT code, fee FROM procedure_codes WHERE practice_id = ? AND active = 1', pid);
    const carrierIds = [];
    for (const c of D.CARRIERS) {
      let fs = null;
      if (c.ppo) {
        fs = (await bulk(db, 'fee_schedules', [{ practice_id: pid, name: `${c.name} — contracted fees`, kind: 'ppo', notes: `In-network: about ${c.ppo}% of office fees` }], { returning: true }))[0];
        await bulk(db, 'fee_schedule_items', codes.map((x) => ({ fee_schedule_id: fs, code: x.code, fee: ppoFee(x.fee, c.ppo) })));
      }
      carrierIds.push((await bulk(db, 'insurance_carriers', [{ practice_id: pid, name: c.name, payer_id: c.payer_id, phone: c.phone, address: 'PO Box 3019, Claims Department', electronic: c.electronic, fee_schedule_id: fs, timely_filing_days: 365 }], { returning: true }))[0]);
    }
    const carrierOf = Object.fromEntries(D.CARRIERS.map((c, i) => [c.key, carrierIds[i]]));
    await bulk(db, 'insurance_plans', plan.insurancePlans.map((p) => ({
      practice_id: pid, carrier_id: carrierOf[p.carrier], name: p.name, group_number: p.group, annual_max: p.max, deductible: p.ded, family_deductible: p.ded * 3, pct_preventive: p.prev, pct_basic: p.basic,
      pct_major: p.major, benefit_month: 1, ortho_max: p.max >= 200000 ? 150000 : 0, ortho_pct: 50, ortho_age_limit: 19, wait_basic_months: 0, wait_major_months: p.waitMajor, downgrade_composites: p.carrier === 'shire' ? 1 : 0,
      missing_tooth_clause: p.waitMajor ? 1 : 0, benefit_notes: `Calendar-year plan. Cleanings twice a year, bitewings yearly, full-mouth x-rays every 5 years.${p.waitMajor ? ` ${p.waitMajor}-month wait for major services.` : ''}`,
      verified_at: `${ds(anchor - 20 - (hash(p.key) % 60))} 10:00:00`, verified_source: 'phone', created_at: `${ds(plan.histStart - 30)} 09:00:00`,
    })));
    await bulk(db, 'membership_plans', D.MEMBERSHIP_PLANS.map((m) => ({
      practice_id: pid, name: m.name, description: m.description, price: m.price, interval: m.interval, discount_pct: m.discount_pct, included: JSON.stringify(m.included), min_age: m.min_age ?? null, max_age: m.max_age ?? null,
    })));
    for (const name of ['Courtesy', 'Senior discount', 'Bad debt write-off', 'Membership included', 'Membership discount', 'Insurance write-off']) {
      await db.run('INSERT INTO adjustment_types (practice_id, name, direction) VALUES (?, ?, ?) ON CONFLICT (practice_id, name) DO NOTHING', pid, name, 'credit');
    }
    await bulk(db, 'referral_contacts', D.REFERRAL_CONTACTS.map((c) => ({ practice_id: pid, name: c.name, practice_name: c.practice_name, specialty: c.specialty, phone: c.phone, fax: null, email: null, address: null, npi: null, notes: null })));
    const srcIds = await bulk(db, 'marketing_sources', D.MARKETING_SOURCES.map((s) => ({ practice_id: pid, channel: s.channel, name: s.name, created_by: userOf.hill, created_at: `${ds(plan.histStart - 20)} 09:00:00` })), { returning: true });
    const sourceOf = Object.fromEntries(D.MARKETING_SOURCES.map((s, i) => [s.key, srcIds[i]]));
    await bulk(db, 'marketing_campaigns', D.MARKETING_CAMPAIGNS.map((c, i) => ({
      practice_id: pid, source_id: sourceOf[c.source], name: c.name, utm_campaign: c.utm, promo_code: c.promo, starts_on: ds(plan.histStart + i * 60), ends_on: ds(plan.histStart + i * 60 + 90), active: 1, created_by: userOf.hill,
    })));
    await bulk(db, 'surveys', [{ practice_id: pid, name: 'After your visit', questions: JSON.stringify([
      { id: 'nps', type: 'nps', label: 'How likely are you to recommend us to a friend or family member?' }, { id: 'wait', type: 'rating', label: 'How was your wait time?' },
      { id: 'better', type: 'text', label: 'What could we do better?' }]), auto_after_visit: 1, active: 1, created_by: userOf.hill }]);
    // Time clock, the business view's costs, and bonuses (off).
    await bulk(db, 'timeclock_settings', [{ practice_id: pid, pay_period: 'biweekly', period_anchor: ds(anchor - ((anchor + 4) % 7) - 7), updated_by: userOf.hill }]);
    await bulk(db, 'timeclock_staff', D.STAFF.filter((s) => s.rate).map((s) => ({ practice_id: pid, user_id: userOf[s.key], on_clock: 1, payroll_id: `FDP-${1000 + hash(s.key) % 9000}`, pay_type: 'hourly', hourly_rate_cents: s.rate, updated_by: userOf.hill })));
    await bulk(db, 'business_settings', [{ practice_id: pid, basis: 'chair', overhead_mode: 'auto', fixed_costs_month_cents: 9500000, work_days_month: 21, updated_by: userOf.hill }]);
    await bulk(db, 'business_cost_profiles', [
      ['diagnostic', 300, 'none', 0], ['preventive', 600, 'none', 0], ['restorative', 1800, 'none', 0], ['endodontics', 3500, 'none', 0], ['periodontics', 900, 'none', 0],
      ['prosthodontics', 2500, 'fixed', 15500], ['implants', 32000, 'fixed', 26000], ['oral_surgery', 1200, 'none', 0], ['adjunctive', 800, 'fixed', 9000],
    ].map(([key, supplies, lab, labCents]) => ({ practice_id: pid, scope: 'category', scope_key: key, version_no: 1, effective_from: ds(plan.histStart - 30), supplies_cents: supplies, lab_mode: lab, lab_cents: labCents, source: 'manual', created_by: userOf.hill, actor_source: 'import' })));
    await bulk(db, 'business_provider_pay', [
      { practice_id: pid, provider_id: provOf.strange, version_no: 1, effective_from: ds(plan.histStart - 30), basis: 'none', pct_bp: 0, hourly_cents: null, lab_deducted: 0, note: 'Owner — paid from profit', created_by: userOf.hill, actor_source: 'import' },
      { practice_id: pid, provider_id: provOf.banner, version_no: 1, effective_from: ds(plan.histStart - 30), basis: 'production_pct', pct_bp: 3000, hourly_cents: null, lab_deducted: 1, note: 'Associate: 30% of production, lab deducted', created_by: userOf.hill, actor_source: 'import' },
      ...['galadriel', 'arwen', 'jane', 'wanda'].map((k) => ({ practice_id: pid, provider_id: provOf[k], version_no: 1, effective_from: ds(plan.histStart - 30), basis: 'hourly', pct_bp: 0, hourly_cents: D.STAFF.find((s) => s.key === k).rate, lab_deducted: 0, note: null, created_by: userOf.hill, actor_source: 'import' })),
    ]);
    await bulk(db, 'business_staff_roles', [
      ...['strange', 'banner'].map((k) => ({ practice_id: pid, user_id: userOf[k], kind: 'doctor', provider_ids: JSON.stringify([provOf[k]]), updated_by: userOf.hill })),
      ...['galadriel', 'arwen', 'jane', 'wanda'].map((k) => ({ practice_id: pid, user_id: userOf[k], kind: 'hygienist', provider_ids: JSON.stringify([provOf[k]]), updated_by: userOf.hill })),
      { practice_id: pid, user_id: userOf.sam, kind: 'assistant', provider_ids: JSON.stringify([provOf.strange, provOf.banner]), updated_by: userOf.hill },
      ...['pepper', 'bilbo', 'hill'].map((k) => ({ practice_id: pid, user_id: userOf[k], kind: 'admin', provider_ids: null, updated_by: userOf.hill })),
    ]);
    await bulk(db, 'bonus_settings', [{ practice_id: pid, enabled: 0, updated_by: userOf.hill }]);
    counts.practice = 1;
    counts.users = D.STAFF.length;
    return { phase: 'images', practiceId: pid };
  },

  async images(db, plan, state, data) {
    // (saved in step(), before the transaction)
    return { phase: 'patients', cursor: 0 };
  },

  // Patient charts, in chunks. The ids are kept in the marker so later steps find each planned patient.
  async patients(db, plan, state, data, counts) {
    const ctx = await context(db, state.themed_practice_id);
    const pids = data.pids || [];
    const from = state.cursor;
    const to = Math.min(plan.patients.length, from + PATIENT_CHUNK);
    const list = plan.patients.slice(from, to);
    const row = (p) => {
      const r = rng(hash(`prow|${p.idx}`));
      const home = p.office;
      const dentist = home === 'riv' ? 'banner' : 'strange';
      const hyg = home === 'riv' ? r.pick(['galadriel', 'arwen']) : r.pick(['jane', 'wanda']);
      return {
        practice_id: ctx.pid, first_name: p.first, last_name: p.last, preferred_name: p.preferred, dob: p.dob, gender: p.gender, email: p.email, phone: p.phone,
        address: p.address, city: p.city, state: p.state, zip: p.zip, emergency_contact: p.head != null ? `${plan.patients[p.head].first} ${plan.patients[p.head].last} (${p.relationship})` : null,
        medical_alerts: p.conditions.filter((c) => c !== 'Tobacco use').join(', ') || null, allergies: p.allergies, medications: p.medications,
        medical_conditions: p.conditions.length ? JSON.stringify(p.conditions) : null, asa_class: p.asa, premed_required: p.premed,
        primary_provider_id: ctx.provOf[dentist], primary_hygienist_id: ctx.provOf[hyg], status: p.inactive ? 'inactive' : 'active',
        created_at: at(p.createdDay, 600 + (p.idx % 300)), updated_at: at(Math.min(plan.anchor, p.createdDay + 30), 600),
        guarantor_id: p.head != null ? pids[p.head] : null, family_relationship: p.head != null ? p.relationship : null,
        referral_source: p.referral ? p.referral[0] : null, office_alert: p.officeAlert, location_id: ctx.locOf[home], language: p.language,
        medical_reviewed_at: r.chance(0.75) ? at(Math.min(plan.anchor, Math.max(p.createdDay, plan.anchor - r.int(0, 420))), 540) : null,
        preferred_contact: r.pick(['text', 'text', 'email', 'call']), sms_opt_in: 1, email_opt_in: r.chance(0.92) ? 1 : 0,
      };
    };
    // Heads of household first (their ids are needed by the others), then everyone else.
    const first = list.filter((p) => p.head == null || pids[p.head] != null);
    const firstIds = await bulk(db, 'patients', first.map(row), { returning: true });
    first.forEach((p, i) => { pids[p.idx] = firstIds[i]; });
    const rest = list.filter((p) => pids[p.idx] == null);
    const restIds = await bulk(db, 'patients', rest.map(row), { returning: true });
    rest.forEach((p, i) => { pids[p.idx] = restIds[i]; });
    data.pids = pids;
    counts.patients = list.length;
    return to >= plan.patients.length ? { phase: 'money', cursor: 0 } : { phase: 'patients', cursor: to };
  },

  // Bank deposits, then insurance checks and their ERAs: made before the ledger entries that point at them.
  async money(db, plan, state, data, counts) {
    const ctx = await context(db, state.themed_practice_id);
    const anchor = plan.anchor;
    const deps = [...plan.deposits.values()].sort((a, b) => a.day - b.day || a.office.localeCompare(b.office));
    const r = rng(hash(`deposits|${state.anchor}`));
    let discrepancy = false;
    const depRows = deps.map((d) => {
      const age = anchor - d.day;
      const off = !discrepancy && age > 8 && age < 30 && r.chance(0.05);
      if (off) discrepancy = true;
      return {
        practice_id: ctx.pid, location_id: ctx.locOf[d.office], deposit_date: ds(d.day), total: d.total, reference: `BAG-${d.office.toUpperCase()}-${ds(d.day).replace(/-/g, '')}`,
        notes: null, status: off ? 'discrepancy' : age > 4 ? 'reconciled' : 'open', bank_amount: off ? d.total - 2000 : age > 4 ? d.total : null, bank_date: age > 4 ? ds(d.day + 1) : null,
        reconciled_by: age > 4 ? ctx.userOf.bilbo : null, reconciled_at: age > 4 ? at(d.day + 2, 600) : null, created_by: ctx.userOf.pepper, created_at: at(d.day, 1020),
      };
    });
    const depIds = await bulk(db, 'deposits', depRows, { returning: true });
    const depOf = Object.fromEntries(deps.map((d, i) => [d.key, depIds[i]]));
    const checks = [...plan.checks.values()].sort((a, b) => a.day - b.day || a.carrier.localeCompare(b.carrier));
    const carrier = (k) => D.CARRIERS.find((c) => c.key === k.carrier);
    const eft = checks.filter((k) => k.electronic);
    const eraIds = await bulk(db, 'era_imports', eft.map((k) => ({
      practice_id: ctx.pid, filename: `${carrier(k).payer_id}_${ds(k.day).replace(/-/g, '')}.835`, payer_name: carrier(k).name, check_number: k.number, payment_date: ds(k.day), total_paid: k.amount,
      claims_matched: k.claims, claims_unmatched: 0, details: JSON.stringify({ claims: k.claims, note: 'Posted automatically' }),
      raw: `ISA*00*          *00*          *ZZ*${carrier(k).payer_id.padEnd(15)}*ZZ*FELLOWSHIP     *${ds(k.day).slice(2).replace(/-/g, '')}*0900*^*00501*000000001*0*P*:~ST*835*0001~BPR*I*${(k.amount / 100).toFixed(2)}*C*ACH*CCP~TRN*1*${k.number}*1${carrier(k).payer_id}~N1*PR*${carrier(k).name}~SE*5*0001~`,
      created_by: null, created_at: at(k.day, 480),
    })), { returning: true });
    const eraOf = Object.fromEntries(eft.map((k, i) => [k.key, eraIds[i]]));
    await bulk(db, 'insurance_checks', checks.map((k) => ({
      practice_id: ctx.pid, carrier_id: ctx.carrierOf[k.carrier], payer_name: carrier(k).name, check_number: k.number, check_date: ds(k.day), amount: k.amount, method: k.electronic ? 'eft' : 'check',
      era_import_id: eraOf[k.key] ?? null, deposit_id: k.deposit ? depOf[k.deposit] : null, created_by: k.electronic ? null : ctx.userOf.bilbo, created_at: at(k.day, 540),
    })));
    counts.deposits = depRows.length;
    counts.insurance_checks = checks.length;
    counts.era_imports = eft.length;
    return { phase: 'history', cursor: 0 };
  },

  async history(db, plan, state, data, counts) {
    const ctx = await context(db, state.themed_practice_id);
    const from = state.cursor;
    const to = Math.min(plan.patients.length, from + SIZES[state.size].batch);
    await writeHistory(db, plan, ctx, data, plan.patients.slice(from, to), counts);
    return to >= plan.patients.length ? { phase: 'extras', cursor: 0 } : { phase: 'history', cursor: to };
  },

  async extras(db, plan, state, data, counts) {
    const ctx = await context(db, state.themed_practice_id);
    if (state.cursor === 0) { await writeClaimBatches(db, plan, ctx, counts); await writeStatements(db, plan, ctx, data, counts); return { phase: 'extras', cursor: 1 }; }
    await writeOffice(db, plan, ctx, data, counts);
    return { phase: 'done', cursor: 0 };
  },
};

// ---- A chunk of patients: everything that happened to them ----
async function writeHistory(db, plan, ctx, data, list, counts) {
  const { anchor } = plan;
  const pids = data.pids;
  const images = data.images;
  const U = ctx.userOf;
  const provUser = Object.fromEntries(D.PROVIDERS.map((p) => [p.key, U[p.user]]));
  const add = (k, n) => { counts[k] = (counts[k] || 0) + n; };

  // Insurance policies.
  const pol = list.filter((p) => p.policy);
  const polIds = await bulk(db, 'patient_insurance', pol.map((p) => {
    const ip = plan.insurancePlans.find((x) => x.key === p.policy.plan);
    const sub = plan.patients[p.policy.subscriber];
    const yr = plan.anchorDate.slice(0, 4);
    const dedMet = Math.min(ip.ded, p.claims.filter((c) => ds(c.day).startsWith(yr)).reduce((s, c) => s + c.ded, 0));
    return {
      practice_id: ctx.pid, patient_id: pids[p.idx], carrier_id: ctx.carrierOf[p.policy.carrier], priority: 'primary', subscriber_name: `${sub.first} ${sub.last}`, subscriber_id: p.policy.subscriberId,
      subscriber_dob: sub.dob, relationship: p.policy.relationship, group_number: ip.group, annual_max: ip.max, deductible: ip.ded, deductible_met: dedMet, pct_preventive: ip.prev, pct_basic: ip.basic,
      pct_major: ip.major, active: 1, plan_id: ctx.insPlanOf[ip.key], effective_date: p.policy.effective, benefit_month: 1, deductible_year: `${yr}-01-01`,
    };
  }), { returning: true });
  const policyOf = new Map(pol.map((p, i) => [p.idx, polIds[i]]));
  add('patient_insurance', pol.length);

  // Memberships.
  const mem = list.filter((p) => p.membership);
  const memIds = await bulk(db, 'memberships', mem.map((p) => {
    const m = p.membership;
    return {
      practice_id: ctx.pid, patient_id: pids[p.idx], plan_id: ctx.memberPlanOf[m.plan], status: m.pastDue ? 'past_due' : 'active', start_date: ds(m.start), next_bill_date: ds(m.pastDue ? m.periods.at(-1) : m.nextBill),
      paid_through: ds((m.pastDue ? m.periods.at(-1) : m.nextBill) - 1), autopay: 1, billing_failures: m.pastDue ? 1 : 0, billing_message: m.pastDue ? 'Card declined — insufficient funds' : null,
      created_by: U.pepper, created_at: at(m.start, 600),
    };
  }), { returning: true });
  const membershipOf = new Map(mem.map((p, i) => [p.idx, memIds[i]]));
  add('memberships', mem.length);

  // Treatment plans and their phases.
  const tps = list.flatMap((p) => p.plans.map((tp) => ({ p, tp })));
  const tpStatus = ({ p, tp }) => (tp.status === 'accepted' && p.procs.filter((x) => x.plan === tp.idx).every((x) => x.status === 'completed') ? 'completed' : tp.status);
  const tpIds = await bulk(db, 'treatment_plans', tps.map(({ p, tp }) => {
    const signed = tp.signed && tp.acceptedDay != null;
    return {
      practice_id: ctx.pid, patient_id: pids[p.idx], name: tp.name, status: tpStatus({ p, tp }), notes: tp.status === 'rejected' ? p.r.pick(['Patient wants to wait until next benefit year', 'Cost concerns — will think about it', 'Wants a second opinion']) : null,
      accepted_at: tp.acceptedDay != null ? at(tp.acceptedDay, 900) : null, created_at: at(tp.day, 870), presented_at: at(tp.day, 880),
      signature_name: signed ? `${p.first} ${p.last}` : null, signed_at: signed ? at(tp.acceptedDay, 902) : null, followup_urgency: tp.status === 'proposed' ? 'soon' : null,
    };
  }), { returning: true });
  const planIdOf = new Map(tps.map((x, i) => [`${x.p.idx}|${x.tp.idx}`, tpIds[i]]));
  await bulk(db, 'treatment_plan_phases', tps.flatMap((x, i) => x.tp.phases.map((ph) => ({
    practice_id: ctx.pid, treatment_plan_id: tpIds[i], phase: ph.phase, name: ph.name, why: ph.why, visits: ph.visits, when_date: null, updated_by: U.strange, updated_at: at(x.tp.day, 880),
  }))));
  add('treatment_plans', tps.length);

  // Appointments.
  const visits = list.flatMap((p) => p.visits.map((v) => ({ p, v })));
  const apptRows = visits.map(({ p, v }) => {
    const r = rng(hash(`appt|${p.idx}|${v.idx}`));
    let status = v.status;
    if (status === 'future') status = v.day <= anchor + 2 ? (r.chance(0.65) ? 'confirmed' : 'scheduled') : r.chance(0.25) ? 'confirmed' : 'scheduled';
    const start = at(v.day, v.start, 0).slice(0, 16);
    const end = at(v.day, v.start + v.dur, 0).slice(0, 16);
    const done = status === 'completed';
    const here = ['completed', 'in_chair', 'checked_in'].includes(status);
    const recent = v.day >= anchor - 60;
    const confirmed = status === 'confirmed' || (done && r.chance(0.8)) || here;
    return {
      practice_id: ctx.pid, patient_id: pids[p.idx], provider_id: ctx.provOf[v.provider], operatory_id: ctx.ops[v.op], start_time: start, end_time: end, status,
      reason: VISIT_KINDS[v.kind][0], notes: v.broken && r.chance(0.5) ? `Called to cancel: ${v.broken.toLowerCase()}` : null, created_at: at(Math.min(v.day - r.int(1, 60), anchor), 600 + r.int(0, 400)),
      appointment_type_id: ctx.types[VISIT_KINDS[v.kind][0]], location_id: ctx.locOf[v.office], asap: status === 'scheduled' && v.day > anchor + 5 && r.chance(0.04) ? 1 : 0,
      confirmed_at: confirmed ? at(Math.min(anchor, v.day - 2), 540) : null, confirmed_via: confirmed ? r.pick(['sms', 'sms', 'email', 'phone']) : null,
      reminder_sent_at: recent || v.day > anchor ? (v.day - 2 <= anchor ? at(v.day - 2, 540) : null) : null,
      arrived_at: here ? at(v.day, v.start - r.int(2, 12)) : null, seated_at: here && status !== 'checked_in' ? at(v.day, v.start + r.int(0, 6)) : null,
      dismissed_at: done ? at(v.day, v.start + v.dur - 2) : null, checked_out_at: done ? at(v.day, v.start + v.dur + 3) : null, checked_out_by: done ? U.pepper : null,
      broken_reason: status === 'cancelled' ? v.broken || 'Other' : status === 'no_show' ? 'No show' : null,
      checked_in_via: here ? r.pick(['desk', 'desk', 'text', 'kiosk']) : null,
    };
  });
  const apptIds = await bulk(db, 'appointments', apptRows, { returning: true });
  const apptOf = new Map(visits.map((x, i) => [`${x.p.idx}|${x.v.idx}`, apptIds[i]]));
  add('appointments', apptRows.length);

  // Procedures.
  const procs = list.flatMap((p) => p.procs.map((pr) => ({ p, pr })));
  const procIds = await bulk(db, 'procedures', procs.map(({ p, pr }) => {
    const v = pr.visit != null ? p.visits[pr.visit] : null;
    return {
      practice_id: ctx.pid, patient_id: pids[p.idx], treatment_plan_id: pr.plan != null ? planIdOf.get(`${p.idx}|${pr.plan}`) : null, appointment_id: v ? apptOf.get(`${p.idx}|${v.idx}`) : null,
      provider_id: ctx.provOf[pr.provider], code_id: ctx.codes[pr.code], code: pr.code, description: pr.description, category: pr.category, tooth: pr.tooth, surfaces: pr.surfaces, area: pr.area,
      fee: pr.fee, priority: pr.phase || 1, status: pr.status, completed_at: pr.status === 'completed' ? at(pr.day, v ? v.start + v.dur - 5 : 720) : null,
      created_at: at(pr.plan != null ? p.plans[pr.plan].day : pr.day, v && pr.plan == null ? v.start : 870), phase: pr.phase || 1, location_id: ctx.locOf[pr.office],
    };
  }), { returning: true });
  const procOf = new Map(procs.map((x, i) => [`${x.p.idx}|${x.pr.idx}`, procIds[i]]));
  add('procedures', procs.length);

  // Claims, their lines and their electronic journey.
  const claims = list.flatMap((p) => p.claims.filter((c) => c.outcome !== 'unbilled').map((c) => ({ p, c })));
  const claimStatus = { draft: 'draft', submitted: 'submitted', rejected: 'submitted', paid: 'paid', partial: 'partially_paid', denied: 'denied' };
  const claimIds = await bulk(db, 'claims', claims.map(({ p, c }) => {
    const sent = c.outcome !== 'draft';
    const last = c.payDay ?? c.denyDay ?? (sent ? Math.min(anchor, c.submitDay + 1) : null);
    const ch = { draft: null, submitted: c.submitDay >= anchor - 1 ? 'sent' : 'accepted', rejected: 'rejected', paid: 'paid', partial: 'paid', denied: 'denied' }[c.outcome];
    return {
      practice_id: ctx.pid, patient_id: pids[p.idx], patient_insurance_id: policyOf.get(p.idx), status: claimStatus[c.outcome], total_fee: c.total, estimated_amount: c.est, deductible_applied: c.ded,
      paid_amount: c.paid, denial_reason: c.denial ?? null, submitted_at: sent ? at(c.submitDay, 1020) : null, paid_at: c.payDay ? at(c.payDay, 540) : null, paid_date: c.payDay ? ds(c.payDay) : null,
      created_at: at(c.day, 1000), write_off_estimate: c.writeOff, ch_status: ch, ch_message: c.outcome === 'rejected' ? 'Subscriber ID not found — check the member ID and resend' : c.denial ?? null,
      ch_updated_at: last != null ? at(last, 560) : null, location_id: ctx.locOf[c.office], follow_up_date: c.followUp ? ds(c.followUp) : null,
      payer_claim_number: c.payDay || c.denyDay ? `${c.carrierKey.toUpperCase()}${String(hash(`${p.idx}|${c.idx}`) % 1e8).padStart(8, '0')}` : null,
      remarks: c.outcome === 'submitted' && c.followUp ? 'No response from payer yet — call if nothing by the follow-up date' : null,
    };
  }), { returning: true });
  const claimOf = new Map(claims.map((x, i) => [`${x.p.idx}|${x.c.idx}`, claimIds[i]]));
  const items = [];
  const events = [];
  claims.forEach(({ p, c }, i) => {
    const id = claimIds[i];
    const final = c.outcome === 'paid';
    let left = c.paid;
    const weights = c.items.map((it) => it.ins || 1);
    const sumW = weights.reduce((s, w) => s + w, 0);
    c.items.forEach((it, k) => {
      const part = k === c.items.length - 1 ? left : Math.round((c.paid * weights[k]) / sumW);
      left -= part;
      items.push({ claim_id: id, procedure_id: procOf.get(`${p.idx}|${it.proc}`), fee: it.fee, estimated_amount: it.ins, write_off: it.writeOff, paid_amount: part, adjusted_amount: final ? it.writeOff : 0,
        patient_resp: final ? it.patient : 0, allowed_amount: it.allowed });
    });
    if (c.outcome === 'draft') return;
    const ev = (day, source, status, message) => events.push({ practice_id: ctx.pid, claim_id: id, source, status, message, created_at: at(day, 1030 + events.length % 20) });
    ev(c.submitDay, 'clearinghouse', 'sent', 'Sent in the daily claim batch');
    if (c.outcome === 'rejected') { ev(Math.min(anchor, c.submitDay + 1), 'clearinghouse', 'rejected', 'Subscriber ID not found — check the member ID and resend'); return; }
    if (c.submitDay + 1 <= anchor) ev(c.submitDay + 1, 'clearinghouse', 'accepted', `Accepted by ${c.carrierName}`);
    if (c.payDay) ev(c.payDay, 'era', 'paid', `Paid $${(c.paid / 100).toFixed(2)}${final ? '' : ' (partial — more expected)'}`);
    if (c.denyDay) ev(c.denyDay, 'era', 'denied', c.denial);
  });
  await bulk(db, 'claim_items', items);
  await bulk(db, 'claim_events', events);
  add('claims', claims.length);
  add('claim_items', items.length);

  // Payment plans.
  const pps = list.flatMap((p) => p.paymentPlans.map((pp) => ({ p, pp })));
  const ppIds = await bulk(db, 'payment_plans', pps.map(({ p, pp }) => ({
    practice_id: ctx.pid, patient_id: pids[p.idx], total: pp.total, down_payment: pp.down, installment_amount: pp.each, installments: pp.n, frequency: 'monthly', start_date: ds(pp.start),
    status: pp.status, notes: pp.note, created_by: U.bilbo, created_at: at(pp.day, 960),
  })), { returning: true });
  const ppOf = new Map(pps.map((x, i) => [`${x.p.idx}|${x.pp.idx}`, ppIds[i]]));
  add('payment_plans', pps.length);

  // The ledger. Entries that point at another entry (a reversal, a refund) go in a second pass.
  const checkNo = Object.fromEntries([...plan.checks.values()].map((k) => [k.key, k.number]));
  const entryRow = (p, e, idOf) => {
    const claimId = e.claim != null ? claimOf.get(`${p.idx}|${e.claim}`) : null;
    const time = 600 + ((e.idx * 7) % 480);
    const who = e.type === 'charge' && e.provider ? provUser[e.provider] : e.membership ? null : ['insurance_payment'].includes(e.type) || e.adj === 'Insurance write-off' ? (plan.checks.get(e.check)?.electronic ? null : U.bilbo) : e.type === 'adjustment' ? U.bilbo : U.pepper;
    return {
      practice_id: ctx.pid, patient_id: pids[p.idx], type: e.type, amount: e.amount, description: e.desc.replace('(claim)', claimId ? `(claim #${claimId})` : '(claim)'), method: e.method ?? null,
      reference: e.ref ?? (e.check ? checkNo[e.check] : null), procedure_id: e.proc != null ? procOf.get(`${p.idx}|${e.proc}`) : null, claim_id: claimId,
      provider_id: e.provider ? ctx.provOf[e.provider] : null, entry_date: ds(e.day), created_by: who, created_at: at(e.day, time),
      payment_plan_id: e.pplan != null ? ppOf.get(`${p.idx}|${e.pplan}`) : null,
      voided_at: e.voided ? at(e.voided.day, time + 5) : null, voided_by: e.voided ? U.pepper : null, void_reason: e.voided?.reason ?? null,
      reverses_id: e.reverses != null ? idOf.get(`${p.idx}|${e.reverses}`) : null, refund_of_id: e.refundOf != null ? idOf.get(`${p.idx}|${e.refundOf}`) : null,
      adjustment_type: e.adj ?? null, insurance_check_id: e.check ? ctx.checks[checkNo[e.check]] ?? null : null, membership_id: e.membership ? membershipOf.get(p.idx) ?? null : null,
      location_id: ctx.locOf[e.office || p.office], deposit_id: e.deposit ? ctx.deposits[e.deposit] ?? null : null,
    };
  };
  const firstPass = list.flatMap((p) => p.ledger.filter((e) => e.reverses == null && e.refundOf == null).map((e) => ({ p, e })));
  const idOf = new Map();
  const ledgerIds = await bulk(db, 'ledger_entries', firstPass.map(({ p, e }) => entryRow(p, e, idOf)), { returning: true });
  firstPass.forEach((x, i) => idOf.set(`${x.p.idx}|${x.e.idx}`, ledgerIds[i]));
  const second = list.flatMap((p) => p.ledger.filter((e) => e.reverses != null || e.refundOf != null).map((e) => ({ p, e })));
  await bulk(db, 'ledger_entries', second.map(({ p, e }) => entryRow(p, e, idOf)));
  add('ledger_entries', firstPass.length + second.length);

  // Clinical notes (signed), and today's visits still in the chair as drafts.
  const notes = [];
  for (const { p, v } of visits) {
    if (!['completed', 'in_chair'].includes(v.status)) continue;
    const r = rng(hash(`note|${p.idx}|${v.idx}`));
    const pool = { hyg: p.age < 14 ? D.CHILD_NOTES : D.HYGIENE_NOTES, perio: D.PERIO_NOTES, np: D.NP_NOTES, srp: D.PERIO_NOTES, filling: D.RESTORATIVE_NOTES, crownprep: D.CROWN_NOTES, seat: D.SEAT_NOTES,
      endo: D.ENDO_NOTES, ext: D.EXT_NOTES, emergency: D.EMERGENCY_NOTES, implant: D.IMPLANT_NOTES, implantcrown: D.IMPLANT_NOTES, consult: ['Consultation. Options, risks and fees reviewed; questions answered.'] }[v.kind];
    const codes = v.procs.map((i) => p.procs[i]).map((x) => `${x.code}${x.tooth ? ` #${x.tooth}` : ''}${x.area ? ` ${x.area}` : ''}`).join(', ');
    const draft = v.status === 'in_chair';
    notes.push({
      practice_id: ctx.pid, patient_id: pids[p.idx], appointment_id: apptOf.get(`${p.idx}|${v.idx}`), provider_id: ctx.provOf[v.provider], author_id: provUser[v.provider],
      body: `${r.pick(pool)}${codes ? `\nProcedures: ${codes}.` : ''}${p.conditions.length && r.chance(0.3) ? `\nMedical history reviewed: ${p.conditions.join(', ')}.` : ''}`,
      signed: draft ? 0 : 1, signed_at: draft ? null : at(v.day, v.start + v.dur + 4), signed_by: draft ? null : provUser[v.provider], created_at: at(v.day, v.start + v.dur - 3), location_id: ctx.locOf[v.office],
    });
  }
  await bulk(db, 'clinical_notes', notes);
  add('clinical_notes', notes.length);

  // The chart: existing work and findings, and teeth taken out here.
  const conds = [];
  for (const p of list) {
    for (const c of p.conds) conds.push({ practice_id: ctx.pid, patient_id: pids[p.idx], tooth: c.tooth, surfaces: c.surfaces ?? null, condition: c.condition, notes: null, resolved: 0, recorded_by: U[p.office === 'riv' ? 'banner' : 'strange'], recorded_at: at(Math.max(c.day, dn('2000-01-01')), 900), procedure_id: null });
    for (const pr of p.procs) {
      if (pr.status !== 'completed' || !['D7140', 'D7210'].includes(pr.code) || !pr.tooth) continue;
      conds.push({ practice_id: ctx.pid, patient_id: pids[p.idx], tooth: pr.tooth, surfaces: null, condition: 'missing', notes: `Extracted (${pr.code})`, resolved: 0, recorded_by: provUser[pr.provider], recorded_at: at(pr.day, 720), procedure_id: procOf.get(`${p.idx}|${pr.idx}`) });
    }
  }
  // A caries finding that has since been filled is resolved.
  for (const c of conds) {
    if (c.condition !== 'caries') continue;
    const p = list.find((x) => pids[x.idx] === c.patient_id);
    const done = p.procs.find((x) => x.tooth === c.tooth && x.status === 'completed' && x.category === 'restorative');
    if (done) { c.resolved = 1; c.resolved_at = at(done.day, 720); c.procedure_id = procOf.get(`${p.idx}|${done.idx}`); }
  }
  for (const c of conds) c.resolved_at ??= null;
  await bulk(db, 'tooth_conditions', conds);
  add('tooth_conditions', conds.length);

  // Perio charts: at the start of therapy and once a year at maintenance.
  const perio = [];
  for (const p of list) {
    if (!p.perio) continue;
    const days = new Set(p.perioExamDays || []);
    let last = -1e9;
    for (const v of p.visits) if (v.kind === 'perio' && v.status === 'completed' && v.day - last > 330) { days.add(v.day); last = v.day; }
    for (const day of [...days].sort()) {
      const r = rng(hash(`perio|${p.idx}|${day}`));
      const readings = {};
      const missing = new Set(p.conds.filter((c) => c.condition === 'missing').map((c) => c.tooth));
      for (let t = 1; t <= 32; t++) {
        const tooth = String(t);
        if (missing.has(tooth) || ['1', '16', '17', '32'].includes(tooth)) { readings[tooth] = { missing: true }; continue; }
        const deep = r.chance(0.18);
        const pd = Array.from({ length: 6 }, (_, k) => Math.max(1, Math.min(9, (k % 3 === 1 ? 2 : 3) + (deep ? r.int(1, 3) : r.int(-1, 1)))));
        readings[tooth] = { pd, gm: Array.from({ length: 6 }, () => (r.chance(0.2) ? r.int(1, 2) : 0)), bop: pd.map((d) => d >= 4 && r.chance(0.6)), plaque: pd.map(() => r.chance(0.2)), ...(deep && r.chance(0.2) ? { mob: 1 } : {}) };
      }
      perio.push({ practice_id: ctx.pid, patient_id: pids[p.idx], provider_id: ctx.provOf[p.office === 'riv' ? 'galadriel' : 'jane'], exam_date: ds(day), readings: JSON.stringify(readings), notes: 'Full-mouth probing', created_at: at(day, 700) });
    }
  }
  await bulk(db, 'perio_exams', perio);
  add('perio_exams', perio.length);

  // X-rays and photos, all pointing at the few shared sample images.
  if (images) {
    const docs = [];
    const doc = (p, v, key, extra = {}) => {
      const img = images[key];
      const meta = SAMPLE_IMAGES.find((x) => x[0] === key);
      docs.push({ practice_id: ctx.pid, patient_id: pids[p.idx], category: meta[1], filename: img.filename, mime: 'image/png', size: img.size, storage_key: img.storageKey, encrypted: img.encrypted,
        tooth: extra.tooth ?? null, notes: meta[3], uploaded_by: provUser[v.provider], created_at: at(v.day, v.start + 10), taken_at: at(v.day, v.start + 10), source: 'sample', location_id: ctx.locOf[v.office],
        appointment_id: apptOf.get(`${p.idx}|${v.idx}`), source_hash: img.hash });
    };
    for (const { p, v } of visits) {
      if (v.status !== 'completed') continue;
      const codes = v.procs.map((i) => p.procs[i]);
      for (const x of codes) {
        if (x.code === 'D0274') { doc(p, v, 'bw_right'); doc(p, v, 'bw_left'); }
        if (x.code === 'D0272') doc(p, v, 'bw_right');
        if (x.code === 'D0210' || x.code === 'D0330') doc(p, v, 'pano');
        if (x.code === 'D0220') doc(p, v, 'pa', { tooth: x.tooth });
      }
      if (v.kind === 'np' || v.kind === 'crownprep') doc(p, v, 'photo');
    }
    await bulk(db, 'documents', docs);
    add('documents', docs.length);
  }

  // Lab cases for crowns and implant crowns.
  const labs = [];
  for (const p of list) {
    for (const v of p.visits) {
      if (!v.lab || !['completed', 'in_chair', 'checked_in', 'future', 'confirmed', 'scheduled'].includes(v.status) || v.day > anchor) continue;
      const r = rng(hash(`lab|${p.idx}|${v.idx}`));
      const seat = v.seat != null ? p.visits[v.seat] : null;
      const due = (seat?.day ?? v.day + 14) - 2;
      const delivered = seat && seat.status === 'completed';
      const late = !delivered && due < anchor && r.chance(0.5);
      const received = delivered || (!late && due - 3 <= anchor);
      const crown = p.procs.find((x) => x.visit === v.idx && ['D2740', 'D6065'].includes(x.code));
      labs.push({
        practice_id: ctx.pid, patient_id: pids[p.idx], provider_id: ctx.provOf[v.provider], appointment_id: seat ? apptOf.get(`${p.idx}|${seat.idx}`) : null, lab_name: r.pick(D.LABS),
        description: `${v.lab.kind === 'implantcrown' ? 'Implant crown' : r.pick(['Zirconia crown', 'E.max crown', 'PFM crown'])} #${v.lab.tooth}`, tooth: v.lab.tooth, shade: r.pick(['A1', 'A2', 'A3', 'B1', 'B2']),
        status: delivered ? 'delivered' : received ? 'received' : 'sent', sent_date: ds(v.day), due_date: ds(due), received_date: received ? ds(Math.min(anchor, due - r.int(0, 2))) : null,
        cost: r.pick([12900, 14900, 16900, 18900]), notes: late ? 'Lab says it ships tomorrow' : null, procedure_id: crown ? procOf.get(`${p.idx}|${crown.idx}`) : null, created_at: at(v.day, v.start + v.dur),
        tracking_number: received ? null : `1Z${String(hash(`${p.idx}${v.idx}`)).padStart(10, '0')}`,
      });
    }
  }
  await bulk(db, 'lab_cases', labs);
  add('lab_cases', labs.length);

  // Prescriptions after extractions and root canals.
  const rx = [];
  for (const { p, v } of visits) {
    if (v.status !== 'completed' || !['ext', 'endo', 'implant'].includes(v.kind)) continue;
    const r = rng(hash(`rx|${p.idx}|${v.idx}`));
    const pen = String(p.allergies || '').includes('Penicillin');
    const base = { practice_id: ctx.pid, patient_id: pids[p.idx], provider_id: ctx.provOf[v.provider], created_by: provUser[v.provider], created_at: at(v.day, v.start + v.dur), status: 'printed', location_id: ctx.locOf[v.office], signed_by: provUser[v.provider] };
    if (!String(p.allergies || '').includes('Ibuprofen')) rx.push({ ...base, drug: 'Ibuprofen', strength: '600 mg', sig: 'Take 1 tablet by mouth every 6 hours as needed for pain, with food', quantity: '20', refills: 0 });
    if (v.kind !== 'endo' || r.chance(0.4)) rx.push(pen ? { ...base, drug: 'Clindamycin', strength: '300 mg', sig: 'Take 1 capsule by mouth every 6 hours for 7 days', quantity: '28', refills: 0 }
      : { ...base, drug: 'Amoxicillin', strength: '500 mg', sig: 'Take 1 capsule by mouth three times a day for 7 days', quantity: '21', refills: 0 });
  }
  await bulk(db, 'prescriptions', rx);
  add('prescriptions', rx.length);

  // Referrals out (and in, for patients another doctor sent us).
  const refs = [];
  for (const p of list) {
    const r = rng(hash(`ref|${p.idx}`));
    const rows = [...p.referrals];
    if (p.referral?.[1] === 'doctor_ref' && p.newPatient && p.joinDay <= anchor) rows.push({ direction: 'in', day: p.createdDay, contact: r.pick(['bree_gp', 'mcCoy_md']), reason: 'New patient — needs a dental home', teeth: null });
    for (const x of rows) {
      const age = anchor - x.day;
      const status = x.direction === 'in' ? 'closed' : age < 10 ? 'open' : age < 25 ? 'scheduled' : age < 45 ? 'seen' : r.chance(0.7) ? 'closed' : 'report_received';
      refs.push({
        practice_id: ctx.pid, patient_id: pids[p.idx], contact_id: ctx.contactOf[x.contact], direction: x.direction, referral_date: ds(x.day), reason: x.reason, teeth: x.teeth, urgency: r.chance(0.2) ? 'urgent' : 'routine',
        status, provider_id: ctx.provOf[p.office === 'riv' ? 'banner' : 'strange'], notes: null, created_by: U.pepper, created_at: at(x.day, 900), location_id: ctx.locOf[p.office],
        expected_by: ds(x.day + 30), scheduled_on: ['scheduled', 'seen', 'report_received', 'closed'].includes(status) ? ds(x.day + 7) : null, seen_on: ['seen', 'report_received', 'closed'].includes(status) ? ds(x.day + 20) : null,
        report_received_on: ['report_received', 'closed'].includes(status) && x.direction === 'out' ? ds(x.day + 30) : null, closed_at: status === 'closed' ? at(x.day + 32, 900) : null,
        close_reason: status === 'closed' ? (x.direction === 'in' ? 'Patient seen here' : 'Treatment completed') : null, letter_sent_at: x.direction === 'out' ? at(x.day, 930) : null, letter_sent_via: x.direction === 'out' ? 'fax' : null,
      });
    }
  }
  await bulk(db, 'referrals', refs);
  add('referrals', refs.length);

  // Recalls: when each patient is due next, and the visit that reset it.
  const recalls = [];
  const resets = [];
  for (const p of list) {
    if (!p.visits.some((v) => v.status === 'completed')) {
      if (!p.newPatient || p.inactive) continue;
    }
    const age = p.age;
    const mainKey = p.perio ? 'perio_maint' : age < 14 ? 'child_prophy' : 'prophy';
    const months = mainKey === 'perio_maint' ? 3 : 6;
    const mainCodes = { prophy: ['D1110'], child_prophy: ['D1120'], perio_maint: ['D4910', 'D4341'] }[mainKey];
    const lastOf = (codes) => {
      let best = null;
      for (const pr of p.procs) if (pr.status === 'completed' && codes.includes(pr.code) && (!best || pr.day > best.day)) best = pr;
      return best;
    };
    const nextVisit = (kinds) => p.visits.filter((v) => kinds.includes(v.kind) && v.day >= anchor && !['completed', 'cancelled', 'no_show'].includes(v.status)).sort((a, b) => a.day - b.day)[0];
    for (const [key, codes, interval, kinds] of [[mainKey, mainCodes, months, ['hyg', 'perio', 'np', 'srp']], ['exam', ['D0120', 'D0150', 'D0180'], 6, ['hyg', 'perio', 'np']], ['bwx', ['D0274', 'D0272'], 12, ['hyg', 'perio']]]) {
      const last = lastOf(codes);
      if (!last && key !== mainKey) continue;
      const lastDay = last ? last.day : p.joinDay - 200;
      const due = new Date(lastDay * 86400000);
      due.setUTCMonth(due.getUTCMonth() + interval);
      const dueDay = Math.floor(due.getTime() / 86400000);
      const booked = nextVisit(kinds);
      const status = p.inactive ? 'inactive' : booked && key === mainKey ? 'scheduled' : 'due';
      const row = {
        practice_id: ctx.pid, patient_id: pids[p.idx], type: key, interval_months: interval, due_date: ds(dueDay), status, last_contacted_at: null, notes: null,
        appointment_id: status === 'scheduled' ? apptOf.get(`${p.idx}|${booked.idx}`) : null, last_done_date: last ? ds(last.day) : null, last_done_code: last?.code ?? null,
        last_done_source: last ? 'here' : null, last_done_location_id: last ? ctx.locOf[last.office] : null, status_reason: p.inactive ? 'Patient left the practice' : null,
      };
      recalls.push({ row, p, last });
    }
  }
  const recallIds = await bulk(db, 'recalls', recalls.map((x) => x.row), { returning: true });
  recalls.forEach((x, i) => {
    if (!x.last) return;
    resets.push({ practice_id: ctx.pid, patient_id: pids[x.p.idx], recall_id: recallIds[i], procedure_id: procOf.get(`${x.p.idx}|${x.last.idx}`), code: x.last.code, done_date: ds(x.last.day), location_id: ctx.locOf[x.last.office], before_state: null, created_at: at(x.last.day, 720) });
  });
  await bulk(db, 'recall_resets', resets);
  add('recalls', recalls.length);

  // Follow-up calls: overdue recalls, unscheduled treatment, broken appointments.
  const fups = [];
  for (const x of recalls) {
    if (x.row.status !== 'due' || dn(x.row.due_date) > anchor - 14 || !['prophy', 'perio_maint', 'child_prophy'].includes(x.row.type)) continue;
    const r = rng(hash(`fup|${x.p.idx}`));
    if (!r.chance(0.45)) continue;
    fups.push({ practice_id: ctx.pid, patient_id: x.row.patient_id, kind: 'recall', outcome: r.pick(['left_voicemail', 'texted', 'emailed', 'spoke_will_call', 'wrong_number']), note: r.pick([null, 'Will call back after vacation', 'Busy season — asked us to try next month', 'Left VM on cell']), created_by: U.pepper, created_at: at(anchor - r.int(1, 40), 600 + r.int(0, 400)) });
  }
  for (const p of list) {
    const r = rng(hash(`fup2|${p.idx}`));
    if (p.procs.some((x) => x.status === 'planned' && x.visit == null && x.plan != null && p.plans[x.plan].status === 'accepted') && r.chance(0.4)) {
      fups.push({ practice_id: ctx.pid, patient_id: pids[p.idx], kind: 'unscheduled', outcome: r.pick(['left_voicemail', 'spoke_will_call', 'texted', 'declined']), note: r.pick([null, 'Checking work schedule', 'Waiting for insurance to renew in January']), created_by: U.pepper, created_at: at(anchor - r.int(1, 60), 700) });
    }
    for (const v of p.visits) if (v.status === 'no_show' && v.day > anchor - 90 && r.chance(0.6)) fups.push({ practice_id: ctx.pid, patient_id: pids[p.idx], kind: 'broken', outcome: r.pick(['left_voicemail', 'spoke_scheduled', 'texted']), note: null, created_by: U.pepper, created_at: at(v.day + 1, 600) });
  }
  await bulk(db, 'followups', fups);
  add('followups', fups.length);

  // Eligibility checks around today, from the payer (sandbox) — a few come back inactive.
  const elig = [];
  const issues = [];
  for (const { p, v } of visits) {
    if (!p.policy || v.day < anchor - 10 || v.day > anchor + 3 || ['cancelled', 'no_show'].includes(v.status)) continue;
    const r = rng(hash(`elig|${p.idx}|${v.idx}`));
    const ip = plan.insurancePlans.find((x) => x.key === p.policy.plan);
    const inactive = r.chance(0.03);
    const used = p.claims.filter((c) => ds(c.day).startsWith(plan.anchorDate.slice(0, 4))).reduce((s, c) => s + c.est, 0);
    const summary = {
      active: !inactive, plan_name: ip.name, plan_begin: `${plan.anchorDate.slice(0, 4)}-01-01`, deductible: ip.ded, deductible_remaining: Math.max(0, ip.ded - p.claims.reduce((s, c) => s + c.ded, 0)),
      annual_max: ip.max, max_remaining: Math.max(0, ip.max - used), coinsurance: { preventive: ip.prev, basic: ip.basic, major: ip.major },
      family_deductible: ip.ded * 3, family_deductible_remaining: null, ortho_max: null, ortho_remaining: null,
      out_of_network: { deductible: null, deductible_remaining: null, annual_max: null, max_remaining: null, coinsurance: {} },
      frequencies: [], history: [], messages: inactive ? ['Coverage terminated'] : [], errors: [], sandbox: true,
    };
    elig.push({ practice_id: ctx.pid, patient_id: pids[p.idx], patient_insurance_id: policyOf.get(p.idx), status: inactive ? 'inactive' : 'active', request_x12: null, response_x12: null, summary: JSON.stringify(summary), created_by: null, created_at: at(Math.min(anchor, v.day - 2), 360) });
    if (inactive && v.day >= anchor) {
      issues.push({ practice_id: ctx.pid, kind: 'eligibility', dedupe_key: `eligibility:${policyOf.get(p.idx)}`, title: `${p.first} ${p.last}'s insurance came back inactive before their visit on ${ds(v.day)}`,
        detail: `${ip.name}: coverage terminated. Ask for new insurance at check-in.`, severity: 'high', role: 'front_desk', entity: 'patient_insurance', entity_id: policyOf.get(p.idx), patient_id: pids[p.idx], status: 'open', source: 'automation', first_seen: at(Math.min(anchor, v.day - 2), 360), last_seen: at(Math.min(anchor, v.day - 2), 360) });
    }
  }
  await bulk(db, 'eligibility_checks', elig);
  add('eligibility_checks', elig.length);

  // Needs attention: recent denials, rejections, a declined membership card.
  for (const { p, c } of claims) {
    const id = claimOf.get(`${p.idx}|${c.idx}`);
    if ((c.outcome === 'denied' && c.denyDay > anchor - 60) || c.outcome === 'rejected') {
      const day = c.denyDay ?? Math.min(anchor, c.submitDay + 1);
      issues.push({ practice_id: ctx.pid, kind: 'claim', dedupe_key: `claim:${id}`, title: `Claim #${id} (${p.first} ${p.last}) ${c.outcome === 'rejected' ? 'was rejected' : 'was denied'}`, detail: c.denial ?? 'Subscriber ID not found — check the member ID and resend',
        severity: 'high', role: 'billing', entity: 'claims', entity_id: id, patient_id: pids[p.idx], status: 'open', source: 'integration', first_seen: at(day, 560), last_seen: at(day, 560) });
    }
  }
  for (const p of mem) {
    if (!p.membership.pastDue) continue;
    issues.push({ practice_id: ctx.pid, kind: 'payment', dedupe_key: `membership:${membershipOf.get(p.idx)}`, title: `${p.first} ${p.last}'s membership card was declined`, detail: 'Card declined — insufficient funds. Ask for a new card.',
      severity: 'normal', role: 'billing', entity: 'memberships', entity_id: membershipOf.get(p.idx), patient_id: pids[p.idx], status: 'open', source: 'automation', first_seen: at(p.membership.periods.at(-1), 480), last_seen: at(p.membership.periods.at(-1), 480) });
  }
  await bulk(db, 'issues', issues.map((x) => ({ ...x, occurrences: 1, assigned_to: null, resolved_at: null, resolved_by: null, resolution: null })));
  add('issues', issues.length);

  // Texts and emails: reminders and confirmations, recall notes, receipts, and replies from patients.
  const msgs = [];
  const office = (k) => D.OFFICES.find((o) => o.key === k);
  for (const { p, v } of visits) {
    if (v.day < anchor - 60 || v.day - 2 > anchor || !['completed', 'no_show', 'in_chair', 'checked_in', 'future', 'confirmed', 'scheduled', 'cancelled'].includes(v.status)) continue;
    const r = rng(hash(`msg|${p.idx}|${v.idx}`));
    const sms = !!p.phone && r.chance(0.8);
    const sent = at(v.day - 2, 540);
    const appt = apptOf.get(`${p.idx}|${v.idx}`);
    const fail = r.chance(0.004);
    msgs.push({ practice_id: ctx.pid, patient_id: pids[p.idx], appointment_id: appt, channel: sms || !p.email ? 'sms' : 'email', kind: 'reminder', to_address: sms || !p.email ? p.phone : p.email,
      subject: sms || !p.email ? null : `Your visit at ${office(v.office).name}`, body: `Hi ${p.preferred || p.first}, this is ${office(v.office).name} reminding you of your visit on ${ds(v.day)} at ${hhmm(v.start)}. Reply C to confirm.`,
      status: fail ? 'failed' : 'sent', provider_id: 'log', error: fail ? 'Undeliverable number' : null, created_by: null, sent_at: fail ? null : sent, created_at: sent, direction: 'outbound', from_address: null, read_at: null, location_id: ctx.locOf[v.office] });
    if (sms && r.chance(0.45)) {
      msgs.push({ practice_id: ctx.pid, patient_id: pids[p.idx], appointment_id: appt, channel: 'sms', kind: 'reply', to_address: office(v.office).phone, subject: null, body: r.chance(0.7) ? 'C' : r.pick(D.INBOUND_TEXTS),
        status: 'sent', provider_id: 'log', error: null, created_by: null, sent_at: at(v.day - 2, 560 + r.int(0, 300)), created_at: at(v.day - 2, 560 + r.int(0, 300)), direction: 'inbound', from_address: p.phone,
        read_at: v.day - 2 < anchor || r.chance(0.5) ? at(v.day - 2, 900) : null, location_id: ctx.locOf[v.office] });
    }
  }
  for (const x of recalls) {
    if (x.row.status !== 'due' || dn(x.row.due_date) > anchor + 14 || !['prophy', 'perio_maint', 'child_prophy'].includes(x.row.type) || !x.p.phone) continue;
    const r = rng(hash(`rmsg|${x.p.idx}`));
    if (!r.chance(0.7)) continue;
    const day = Math.min(anchor, dn(x.row.due_date) - 14 + r.int(0, 30));
    msgs.push({ practice_id: ctx.pid, patient_id: x.row.patient_id, appointment_id: null, channel: 'sms', kind: 'recall', to_address: x.p.phone, subject: null,
      body: `Hi ${x.p.preferred || x.p.first}, it's time for your next cleaning at ${office(x.p.office).name}. Book online or reply and we'll find a time.`, status: 'sent', provider_id: 'log', error: null, created_by: null,
      sent_at: at(day, 600), created_at: at(day, 600), direction: 'outbound', from_address: null, read_at: null, location_id: ctx.locOf[x.p.office] });
  }
  for (const p of list) {
    for (const e of p.ledger) {
      if (e.type !== 'payment' || e.day < anchor - 30 || !['credit_card', 'debit_card'].includes(e.method) || !p.email || e.voided) continue;
      msgs.push({ practice_id: ctx.pid, patient_id: pids[p.idx], appointment_id: null, channel: 'email', kind: 'receipt', to_address: p.email, subject: `Your receipt from ${office(e.office || p.office).name}`,
        body: `Thank you! We received your payment of $${(-e.amount / 100).toFixed(2)} on ${ds(e.day)}.`, status: 'sent', provider_id: 'log', error: null, created_by: null, sent_at: at(e.day, 1000), created_at: at(e.day, 1000),
        direction: 'outbound', from_address: null, read_at: null, location_id: ctx.locOf[e.office || p.office] });
    }
    const r = rng(hash(`inbound|${p.idx}`));
    if (p.phone && !p.inactive && r.chance(0.012)) {
      const day = anchor - r.int(0, 2);
      msgs.push({ practice_id: ctx.pid, patient_id: pids[p.idx], appointment_id: null, channel: 'sms', kind: 'reply', to_address: office(p.office).phone, subject: null, body: r.pick(D.INBOUND_TEXTS), status: 'sent', provider_id: 'log',
        error: null, created_by: null, sent_at: at(day, 480 + r.int(0, 200)), created_at: at(day, 480 + r.int(0, 200)), direction: 'inbound', from_address: p.phone, read_at: day < anchor ? at(day, 900) : null, location_id: ctx.locOf[p.office] });
    }
  }
  await bulk(db, 'messages', msgs);
  add('messages', msgs.length);
  const failed = msgs.filter((m) => m.status === 'failed' && m.created_at >= at(anchor - 14, 0));
  await bulk(db, 'issues', failed.map((m) => ({ practice_id: ctx.pid, kind: 'message', dedupe_key: `message:reminder:${m.patient_id}:${m.created_at.slice(0, 10)}`, title: 'An appointment reminder text could not be delivered', detail: 'Undeliverable number — check the phone number on file.',
    severity: 'normal', role: 'front_desk', entity: 'patients', entity_id: m.patient_id, patient_id: m.patient_id, status: 'open', occurrences: 1, source: 'integration', assigned_to: null, first_seen: m.created_at, last_seen: m.created_at, resolved_at: null, resolved_by: null, resolution: null })));

  // Phone calls in the last six weeks.
  const calls = [];
  for (const p of list) {
    const r = rng(hash(`calls|${p.idx}`));
    if (p.inactive || !r.chance(0.35)) continue;
    const n = r.int(1, 2);
    for (let k = 0; k < n; k++) {
      let day = anchor - r.int(0, 42);
      while (!isWorkday(day)) day--;
      const inbound = r.chance(0.7);
      const missed = inbound && r.chance(0.12);
      const o = office(p.office);
      const minute = 480 + r.int(0, 510);
      calls.push({
        practice_id: ctx.pid, patient_id: pids[p.idx], direction: inbound ? 'inbound' : 'outbound', purpose: inbound ? 'inbound' : 'call', from_number: inbound ? p.phone : o.phone, to_number: inbound ? o.phone : p.phone,
        provider_id: 'log', status: 'completed', answered_by: missed ? null : 'human', outcome: missed ? r.pick(['missed', 'voicemail']) : inbound ? r.pick(['answered', 'answered', 'booked']) : r.pick(['answered', 'voicemail']),
        duration: missed ? null : r.int(40, 420), summary: missed ? null : r.pick(['Asked about their balance', 'Rescheduled a cleaning', 'Insurance question', 'Booked a new visit', 'Asked for directions to the office', 'Tooth pain — booked an emergency visit']),
        user_id: missed ? null : U.pepper, created_at: at(day, minute), ended_at: at(day, minute + 3), location_id: ctx.locOf[p.office], caller_name: `${p.first} ${p.last}`, source: null, new_caller: 0,
        follow_up: missed && day >= anchor - 1 ? 1 : 0, handled_at: missed && day >= anchor - 1 ? null : missed ? at(day + 1, 540) : null, handled_by: missed && day < anchor - 1 ? U.pepper : null,
        answered_at: missed ? null : at(day, minute), ring_seconds: r.int(3, 25), desk_result: missed ? 'missed' : 'answered',
      });
    }
  }
  await bulk(db, 'calls', calls);
  add('calls', calls.length);

  // How new patients found us (the marketing report's first touch).
  const touches = [];
  for (const p of list) {
    if (!p.newPatient || !p.referral || p.createdDay > anchor) continue;
    const src = ctx.sourceOf[p.referral[1]];
    const r = rng(hash(`touch|${p.idx}`));
    const camp = ctx.campaigns.find((c) => c.source_id === src && c.promo_code) || null;
    const promo = camp && r.chance(0.4);
    touches.push({ practice_id: ctx.pid, patient_id: pids[p.idx], touch_key: `staff:themed:${pids[p.idx]}`, method: promo ? 'promo_code' : p.referral[1] === 'patient_ref' ? 'referral' : 'staff', source_id: src, campaign_id: promo ? camp.id : null,
      lead: 1, lead_kind: 'new_patient', entity: 'patients', entity_id: pids[p.idx], detail: promo ? `Promo code ${camp.promo_code}` : p.referral[0], occurred_at: at(p.createdDay, 600), created_by: U.pepper, created_at: at(p.createdDay, 600) });
  }
  const touchIds = await bulk(db, 'marketing_touches', touches, { returning: true });
  for (let i = 0; i < touches.length; i += 400) {
    const part = touches.slice(i, i + 400);
    const ids = touchIds.slice(i, i + 400);
    // First and last touch on the chart, as the app's attribution sets them (marketing.js refreshAttribution).
    await db.run(`UPDATE patients SET marketing_first_touch_id = CASE id ${part.map(() => 'WHEN ? THEN CAST(? AS INTEGER)').join(' ')} END, marketing_last_touch_id = marketing_first_touch_id
      WHERE id IN (${part.map(() => '?').join(', ')})`, ...part.flatMap((t, k) => [t.patient_id, ids[k]]), ...part.map((t) => t.patient_id));
  }
  await db.run(`UPDATE patients SET marketing_last_touch_id = marketing_first_touch_id WHERE practice_id = ? AND marketing_first_touch_id IS NOT NULL AND marketing_last_touch_id IS NULL`, ctx.pid);
  add('marketing_touches', touches.length);

  // After-visit surveys for some recent visits.
  if (ctx.survey) {
    const resp = [];
    for (const { p, v } of visits) {
      if (v.status !== 'completed' || v.day < anchor - 90 || v.day >= anchor) continue;
      const r = rng(hash(`survey|${p.idx}|${v.idx}`));
      if (!r.chance(0.12)) continue;
      const answered = r.chance(0.55);
      const nps = answered ? r.weighted([10, 9, 8, 7, 6, 5, 3], (x) => ({ 10: 40, 9: 25, 8: 12, 7: 8, 6: 5, 5: 4, 3: 2 }[x])) : null;
      resp.push({ practice_id: ctx.pid, survey_id: ctx.survey, patient_id: pids[p.idx], appointment_id: apptOf.get(`${p.idx}|${v.idx}`), token_hash: createHash('sha256').update(`themed-survey|${p.idx}|${v.idx}`).digest('hex'),
        answers: answered ? JSON.stringify({ nps, wait: nps >= 8 ? 5 : 3, better: nps >= 9 ? '' : r.pick(['Shorter wait on Mondays', 'More evening appointments', 'Nothing — keep it up!', 'Easier parking']) }) : null,
        nps, sent_at: at(v.day, v.start + v.dur + 60), answered_at: answered ? at(v.day + 1, 700) : null });
    }
    await bulk(db, 'survey_responses', resp);
    add('survey_responses', resp.length);
  }
}

// ---- Claim files: one 837D batch per day claims went out ----
async function writeClaimBatches(db, plan, ctx, counts) {
  const rows = await db.all("SELECT id, submitted_at FROM claims WHERE practice_id = ? AND submitted_at IS NOT NULL AND batch_id IS NULL ORDER BY id", ctx.pid);
  const byDay = new Map();
  for (const r of rows) { const d = String(r.submitted_at).slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r.id); }
  const days = [...byDay.keys()].sort();
  const ids = await bulk(db, 'edi_batches', days.map((d, i) => ({
    practice_id: ctx.pid, kind: '837D', control: String(100000 + i), filename: `FDP_${d.replace(/-/g, '')}.837`, claim_ids: JSON.stringify(byDay.get(d)), status: 'accepted', transport: 'sandbox',
    message: `${byDay.get(d).length} claims`, x12: null, created_by: ctx.userOf.bilbo, acknowledged_at: `${ds(dn(d) + 1)} 08:00:00`, created_at: `${d} 17:05:00`,
  })), { returning: true });
  // Each claim points at the file it went out in (as sending a batch does).
  for (let i = 0; i < days.length; i++) {
    const list = byDay.get(days[i]);
    for (let k = 0; k < list.length; k += 500) {
      const part = list.slice(k, k + 500);
      await db.run(`UPDATE claims SET batch_id = ? WHERE practice_id = ? AND id IN (${part.map(() => '?').join(', ')})`, ids[i], ctx.pid, ...part);
    }
  }
  counts.edi_batches = days.length;
}

// ---- Monthly statements to accounts with a balance ----
async function writeStatements(db, plan, ctx, data, counts) {
  const { anchor } = plan;
  const pids = data.pids;
  const runs = [];
  for (let m = 5; m >= 0; m--) {
    const d = new Date(anchor * 86400000);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - m);
    let day = Math.floor(d.getTime() / 86400000);
    while (!isWorkday(day)) day++;
    if (day > anchor || day < plan.histStart) continue;
    const who = [];
    for (const p of plan.patients) {
      if (p.inactive) continue;
      const bal = p.ledger.reduce((s, e) => (e.day <= day ? s + e.amount : s), 0);
      const oldest = p.ledger.find((e) => e.amount > 0 && e.day <= day - 25);
      if (bal >= 2500 && oldest) who.push({ p, bal });
    }
    if (who.length) runs.push({ day, who });
  }
  const email = (x) => !!x.p.email;
  const runIds = await bulk(db, 'statement_runs', runs.map((r) => ({
    practice_id: ctx.pid, accounts: r.who.length, emailed: r.who.filter(email).length, printed: 0, mailed: r.who.filter((x) => !email(x)).length, total: r.who.reduce((s, x) => s + x.bal, 0),
    patient_ids: JSON.stringify(r.who.map((x) => pids[x.p.idx])), created_by: ctx.userOf.bilbo, created_at: `${ds(r.day)} 09:00:00`,
  })), { returning: true });
  const deliveries = runs.flatMap((r, i) => r.who.map((x) => ({
    practice_id: ctx.pid, run_id: runIds[i], patient_id: pids[x.p.idx], method: email(x) ? 'email' : 'mail', amount: x.bal, reference: email(x) ? null : `LTR-${runIds[i]}-${pids[x.p.idx]}`, status: 'sent', detail: null, created_at: `${ds(r.day)} 09:05:00`,
  })));
  await bulk(db, 'statement_deliveries', deliveries);
  // When each account last got a statement.
  const last = new Map();
  runs.forEach((r) => r.who.forEach((x) => last.set(pids[x.p.idx], `${ds(r.day)} 09:05:00`)));
  const byDate = new Map();
  for (const [id, when] of last) { if (!byDate.has(when)) byDate.set(when, []); byDate.get(when).push(id); }
  for (const [when, list] of byDate) {
    for (let k = 0; k < list.length; k += 500) {
      const part = list.slice(k, k + 500);
      await db.run(`UPDATE patients SET statement_sent_at = ? WHERE practice_id = ? AND id IN (${part.map(() => '?').join(', ')})`, when, ctx.pid, ...part);
    }
  }
  counts.statement_runs = runs.length;
  counts.statement_deliveries = deliveries.length;
}

// ---- The office itself: reviews, marketing spend, time clock, tasks, requests ----
async function writeOffice(db, plan, ctx, data, counts) {
  const { anchor, histStart } = plan;
  const U = ctx.userOf;
  const pids = data.pids;
  const r = rng(hash(`office|${plan.anchorDate}|${plan.size}`));
  const completed = plan.patients.flatMap((p) => p.visits.filter((v) => v.status === 'completed').map((v) => ({ p, v })));
  // Online reviews.
  const reviews = [];
  for (const { p, v } of completed) {
    if (!r.chance(1 / 45)) continue;
    const [rating, text] = r.pick(D.REVIEW_TEXTS);
    const posted = Math.min(anchor, v.day + r.int(0, 3));
    const replied = r.chance(0.7) || rating <= 3;
    reviews.push({ practice_id: ctx.pid, source: 'google', external_id: `themed-${pids[p.idx]}-${v.idx}`, author: `${p.first} ${p.last[0]}.`, rating, text, posted_at: at(posted, 1100),
      reply: replied ? (rating <= 3 ? D.REVIEW_REPLIES[2] : r.pick(D.REVIEW_REPLIES.slice(0, 2))) : null, reply_status: replied ? 'posted' : 'none', replied_at: replied ? at(Math.min(anchor, posted + 1), 600) : null, created_at: at(posted, 1100) });
  }
  await bulk(db, 'reviews', reviews);
  counts.reviews = reviews.length;
  // Marketing spend per month for the paid sources.
  const costs = [];
  for (let d = new Date(histStart * 86400000); Math.floor(d.getTime() / 86400000) <= anchor; d.setUTCMonth(d.getUTCMonth() + 1)) {
    d.setUTCDate(1);
    const start = Math.floor(d.getTime() / 86400000);
    const e = new Date(d); e.setUTCMonth(e.getUTCMonth() + 1); e.setUTCDate(0);
    for (const s of D.MARKETING_SOURCES.filter((x) => x.monthly)) {
      costs.push({ practice_id: ctx.pid, source_id: ctx.sourceOf[s.key], campaign_id: null, starts_on: ds(start), ends_on: e.toISOString().slice(0, 10), amount: Math.round(s.monthly * (0.85 + r() * 0.3) / 100) * 100,
        notes: null, client_key: `themed-${s.key}-${ds(start)}`, created_by: U.hill, created_at: at(start, 540) });
    }
  }
  await bulk(db, 'marketing_costs', costs);
  counts.marketing_costs = costs.length;
  // Time clock: the last eight weeks for everyone on the clock; today's shifts still open.
  const punches = [];
  const tz = D.PRACTICE.timezone;
  const utc = (day, minute) => new Date(Date.parse(`${ds(day)}T${hhmm(minute)}:00Z`) + tzOffset(tz, day) * 60000).toISOString();
  const onClock = D.STAFF.filter((s) => s.rate);
  const worksAt = (s, day) => {
    const prov = D.PROVIDERS.find((p) => p.user === s.key);
    if (prov) return prov.days[(day + 4) % 7] || null;
    return s.key === 'pepper' || s.key === 'sam' ? ((day + 4) % 7 === 5 ? 'riv' : 'stk') : 'riv';
  };
  for (let day = anchor - 56; day <= anchor; day++) {
    if (!isWorkday(day)) continue;
    for (const s of onClock) {
      const where = worksAt(s, day);
      if (!where || r.chance(0.04)) continue;
      const inM = 450 + r.int(-8, 12);
      const open = day === anchor;
      const outM = 1020 + r.int(-10, 25);
      punches.push({ s, row: { practice_id: ctx.pid, user_id: U[s.key], location_id: ctx.locOf[where], clock_in: `${ds(day)} ${hhmm(inM)}`, clock_out: open ? null : `${ds(day)} ${hhmm(outM)}`, break_minutes: open ? 0 : 30,
        note: null, created_at: utc(day, inM).replace('T', ' ').slice(0, 19), clock_in_utc: utc(day, inM), clock_out_utc: open ? null : utc(day, outM), eff_in: `${ds(day)} ${hhmm(inM)}`, eff_out: open ? null : `${ds(day)} ${hhmm(outM)}`,
        eff_break: open ? null : 30, corrected: 0, source: r.chance(0.7) ? 'kiosk' : 'web', in_flag: inM > 465 ? 'late' : null, in_flag_minutes: inM > 465 ? inM - 460 : null, shift_start: '07:30', shift_end: '17:00' } });
    }
  }
  const punchIds = await bulk(db, 'time_punches', punches.map((x) => x.row), { returning: true });
  await bulk(db, 'time_open_punches', punches.map((x, i) => ({ x, id: punchIds[i] })).filter(({ x }) => x.row.clock_out == null).map(({ x, id }) => ({ practice_id: ctx.pid, user_id: x.row.user_id, punch_id: id, created_at: x.row.created_at })));
  counts.time_punches = punches.length;
  // Tasks: open ones for the team, and a history of done ones.
  const tasks = [];
  for (const [title, priority, who] of D.TASKS) tasks.push({ practice_id: ctx.pid, patient_id: null, assigned_to: U[who], title, notes: null, due_date: ds(anchor + r.int(-3, 10)), priority, status: 'open', created_by: U.hill, completed_at: null, completed_by: null, created_at: at(anchor - r.int(1, 20), 600) });
  const active = plan.patients.filter((p) => !p.inactive);
  for (let k = 0; k < Math.max(10, Math.round(active.length / 60)); k++) {
    const p = r.pick(active);
    const done = r.chance(0.7);
    const day = anchor - r.int(0, 120);
    tasks.push({ practice_id: ctx.pid, patient_id: pids[p.idx], assigned_to: U[r.pick(['pepper', 'bilbo', 'sam'])], title: r.pick([`Call ${p.first} about their balance`, `Send ${p.first} ${p.last}'s x-rays to the specialist`, `Pre-authorization for ${p.first} ${p.last}`, `Update ${p.first}'s insurance card`, `Confirm ${p.first}'s next visit`]),
      notes: null, due_date: ds(day + 3), priority: r.pick(['normal', 'normal', 'high', 'low']), status: done ? 'done' : 'open', created_by: U.hill, completed_at: done ? at(day + 2, 700) : null, completed_by: done ? U.pepper : null, created_at: at(day, 600) });
  }
  await bulk(db, 'tasks', tasks);
  counts.tasks = tasks.length;
  // Online booking requests waiting for the front desk.
  const reqs = [['Eomund', 'Westfold', '1990-02-11', 'New patient exam & cleaning', 'Moving from the Westfold; last cleaning about a year ago.'], ['Darcy', 'Lewis', '1992-12-01', 'Emergency / limited exam', 'Chipped a front tooth on a coffee mug.'],
    ['Hilda', 'Bracegirdle', '1958-07-19', 'New patient exam & cleaning', 'Friend of Lobelia recommended you.']];
  await bulk(db, 'booking_requests', reqs.map(([first_name, last_name, dob, reason, notes], i) => {
    let day = anchor + 2 + i;
    while (!isWorkday(day)) day++;
    return { practice_id: ctx.pid, first_name, last_name, dob, phone: `(970) 555-01${60 + i}`, email: `${first_name.toLowerCase()}@shire.example`, reason, duration: reason.startsWith('New') ? 90 : 30, provider_id: ctx.provOf[i % 2 ? 'strange' : 'banner'], requested_start: `${ds(day)} ${['09:00', '14:00', '10:30'][i]}`, notes, ip: '203.0.113.9' };
  }));
  // A deposit the bank recorded short is a Needs attention item.
  const short = await db.get("SELECT id, deposit_date, total, bank_amount FROM deposits WHERE practice_id = ? AND status = 'discrepancy' ORDER BY id LIMIT 1", ctx.pid);
  if (short) {
    await bulk(db, 'issues', [{ practice_id: ctx.pid, kind: 'payment', dedupe_key: `deposit-bank-diff:${short.id}`, title: `Deposit from ${short.deposit_date}: the bank shows $${((short.total - short.bank_amount) / 100).toFixed(2)} short`,
      detail: 'Find out why and record it on the deposit.', severity: 'high', role: 'billing', entity: 'deposits', entity_id: short.id, patient_id: null, status: 'open', occurrences: 1, source: 'automation', assigned_to: null,
      first_seen: `${ds(dn(short.deposit_date) + 2)} 08:00:00`, last_seen: `${ds(dn(short.deposit_date) + 2)} 08:00:00`, resolved_at: null, resolved_by: null, resolution: null }]);
  }
}

// Minutes to add to local wall time to get UTC, for the practice's time zone on that day.
function tzOffset(tz, day) {
  const d = new Date(`${ds(day)}T12:00:00Z`);
  const local = new Date(d.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((utc - local) / 60000);
}

// Expose for tests.
export { CODES as THEMED_CODES };
