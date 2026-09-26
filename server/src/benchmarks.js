// Benchmarks across practices, the practice's side (BM1–BM5; docs/workflows/specs/BM-benchmarks.md).
//
// Off by default. When the owner joins, a nightly job works out this practice's provider-level numbers for the
// month so far and the month before — each one with the definition the rest of the app already uses (metrics.js,
// diagnosis.js, the business view, recallfreq.js), never a new formula — and sends them, signed, to the benchmark
// service. Only aggregates travel (rates, $ per exam, counts, sample sizes): no patient, no date, no name unless a
// doctor chose to be named. Every payload is kept here exactly as sent, so the owner can see what left.
//
// The service sits behind an adapter (createBenchmarkClient): 'http' (BENCHMARK_URL, https only, every call through
// loggedFetch into Connection activity), 'sandbox' (the service in-process with made-up peers, for demos and tests)
// or 'off'. Failures become a Needs attention item that the next success resolves.
import { randomBytes, randomInt } from 'node:crypto';
import { HttpError } from './auth.js';
import { computeMetrics, examValues, addDays } from './metrics.js';
import { diagnosisFunnel } from './diagnosis.js';
import { recallCounts } from './recallfreq.js';
import { visitMinutes } from './business.js';
import { businessTrends } from './businessdata.js';
import { runReport } from './reportlibrary.js';
import { practiceNow, addMonths } from './util.js';
import { raiseIssue, resolveIssue, loggedFetch, logIntegration } from './issues.js';
import { withActor } from './actor.js';
import { sealSecret, openSecret } from './sso.js';
import { METRICS, PRACTICE_TYPES, regionFor, sizeBandFor, yearsBandFor, payerMixFor, metricLabel, ROW_KEYS } from './benchmarkservice/catalog.js';
import { generateKeys, signedHeaders, nonce, sha256 } from './benchmarkservice/signing.js';
import { handle, serviceConfig } from './benchmarkservice/service.js';
import { ensureSandboxPeers } from './benchmarkservice/sandbox.js';
import { CONTENT_TYPE } from './benchmarkservice/index.js';

export const TERMS_VERSION = '2026-09-draft'; // the wording the owner agreed to (needs legal review before launch)
export const SEND_AFTER_HOUR = 1; // the nightly send goes after 1am practice time
const SEAL = 'benchmark';
const ISSUE = { send: 'benchmark-send', leave: 'benchmark-leave', reconcile: 'benchmark-reconcile', results: 'benchmark-results' };

// Least sample a number must rest on before it's shared (fewer is noise, and small counts say too much).
export const MIN_SAMPLE = { exams: 5, findings: 5, plans: 3, visits: 10, hours: 8, examValue: 10, recall: 20 };
// Perio share of hygiene: the Hygiene report's rule (routes/reports.js) — perio maintenance, SRP and debridement over
// those plus adult/child prophies, completed procedures. Keep the two lists in step.
export const PERIO_CODES = ['D4341', 'D4342', 'D4346', 'D4355', 'D4910'];
export const PROPHY_CODES = ['D1110', 'D1120'];

// ---- The adapter ----
export function benchmarkConfig(env = process.env) {
  const url = env.BENCHMARK_URL ? String(env.BENCHMARK_URL).replace(/\/$/, '') : null;
  const production = env.NODE_ENV === 'production' || env.APP_ENV === 'production';
  const mode = env.BENCHMARKS === 'off' ? 'off' : env.BENCHMARKS === 'sandbox' ? 'sandbox' : url ? 'http' : production ? 'off' : 'sandbox';
  return { mode, url, enrollToken: env.BENCHMARK_ENROLL_TOKEN || null, allowHttp: env.BENCHMARK_ALLOW_HTTP === '1' };
}

const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
// client.call(path, body, headers, { practiceId, today }) → { status, body }
export function createBenchmarkClient({ db, config = benchmarkConfig(), fetchImpl = globalThis.fetch, service = {} } = {}) {
  const off = (why) => ({ mode: 'off', label: 'Not set up', destination: null, why, async call() { throw new HttpError(503, why); } });
  if (config.mode === 'off') return off('Benchmarks aren’t set up on this server yet (BENCHMARK_URL).');
  if (config.mode === 'http') {
    if (!/^https:\/\//i.test(config.url || '') && !config.allowHttp) return off('BENCHMARK_URL must start with https:// — numbers are only sent over TLS.');
    const send = loggedFetch(db, fetchImpl);
    return {
      mode: 'http', label: 'Benchmark service', destination: new URL(config.url).host,
      async call(path, body, headers) {
        const res = await send(`${config.url}${path}`, {
          method: 'POST', body, signal: AbortSignal.timeout(20_000),
          headers: { 'Content-Type': CONTENT_TYPE, ...headers, ...(config.enrollToken && path === '/v1/join' ? { 'X-DM-Enroll': config.enrollToken } : {}) },
        });
        let data;
        try { data = await res.json(); } catch { data = { error: `The benchmark service answered ${res.status}` }; }
        return { status: res.status, body: data };
      },
    };
  }
  return {
    mode: 'sandbox', label: 'Sandbox (made-up peer practices)', destination: 'sandbox',
    async call(path, body, headers, { practiceId = null, today } = {}) {
      const started = Date.now();
      await ensureSandboxPeers(db, today || new Date().toISOString().slice(0, 10));
      const out = await handle(db, { path, headers: lower(headers), body, config: { ...serviceConfig(), ...service } });
      await logIntegration(db, { practiceId, service: 'Benchmarks (sandbox)', operation: `POST ${path}`, ok: out.status < 400, httpStatus: out.status, ms: Date.now() - started, externalId: out.body?.receipt || null });
      return out;
    },
  };
}

// ---- Settings and identities ----
const hexId = (bytes) => randomBytes(bytes).toString('hex');
const code4 = () => String(randomInt(1000, 10000));
export async function settingsOf(db, pid) {
  const s = await db.get('SELECT * FROM bm_settings WHERE practice_id = ?', pid);
  return s || { practice_id: pid, status: 'off', practice_type: 'general', founded_year: null, share_labor: 0, participant_id: null };
}
async function ensureSettingsRow(db, pid) {
  if (!(await db.get('SELECT practice_id FROM bm_settings WHERE practice_id = ?', pid))) {
    try { await db.run('INSERT INTO bm_settings (practice_id) VALUES (?)', pid); } catch { /* made by a parallel request */ }
  }
}

// Each active provider's random key and anonymous code (made the first time; new ones on every re-join).
export async function providerIdentities(db, pid) {
  const provs = await db.all('SELECT id, name, type, user_id, active FROM providers WHERE practice_id = ? ORDER BY id', pid);
  const have = new Map((await db.all('SELECT * FROM bm_providers WHERE practice_id = ?', pid)).map((r) => [r.provider_id, r]));
  for (const p of provs) {
    if (have.has(p.id)) continue;
    try {
      await db.run('INSERT INTO bm_providers (practice_id, provider_id, provider_key, anon_code) VALUES (?, ?, ?, ?)', pid, p.id, `k_${hexId(8)}`, code4());
    } catch { /* made by a parallel request */ }
  }
  const rows = new Map((await db.all('SELECT * FROM bm_providers WHERE practice_id = ?', pid)).map((r) => [r.provider_id, r]));
  return provs.map((p) => ({ ...p, role: roleOf(p), ...pickIdentity(rows.get(p.id)) }));
}
const pickIdentity = (r) => ({ provider_key: r.provider_key, anon_code: r.anon_code, show_name: !!Number(r.show_name), display_name: r.display_name });
export const roleOf = (p) => (p.type === 'hygienist' ? 'hygienist' : 'dentist');
// The name a doctor may choose to show: their provider name without credentials ("Dr. Ann Lee, DDS" → "Dr. Ann Lee").
export const publicName = (name) => {
  const n = String(name || '').split(',')[0].trim().slice(0, 80);
  return n && !/[\d@]/.test(n) ? n : null;
};
export const anonLabel = (role, code) => `${role === 'hygienist' ? 'RDH' : role === 'practice' ? 'Practice' : 'Dr.'} #${code}`;

// The peer-group profile: type and founding year from the owner; region, size and payer mix worked out here.
export async function practiceProfile(db, pid, s, today) {
  const practice = await db.get('SELECT state FROM practices WHERE id = ?', pid);
  const dentists = await db.get("SELECT COUNT(*) AS n FROM providers WHERE practice_id = ? AND active = 1 AND type IN ('dentist','specialist')", pid);
  // Payer mix: the insurance share of the last 12 months' payments received (the ledger; credits are negative).
  const pay = await db.get(
    `SELECT COALESCE(SUM(CASE WHEN type = 'insurance_payment' THEN -amount ELSE 0 END), 0) AS ins, COALESCE(SUM(-amount), 0) AS total
     FROM real_ledger_entries ledger_entries WHERE practice_id = ? AND type IN ('payment','insurance_payment') AND voided_at IS NULL AND reverses_id IS NULL AND entry_date >= ? AND entry_date <= ?`,
    pid, addMonths(today, -12), today,
  );
  const insurancePct = Number(pay.total) > 0 ? (Number(pay.ins) / Number(pay.total)) * 100 : null;
  return {
    practice_type: Object.hasOwn(PRACTICE_TYPES, String(s.practice_type)) ? s.practice_type : 'general',
    region: regionFor(practice?.state),
    size_band: sizeBandFor(Number(dentists.n) || 1),
    payer_mix: payerMixFor(insurancePct),
    years_band: yearsBandFor(s.founded_year ? Number(s.founded_year) : null, Number(today.slice(0, 4))),
  };
}

// ---- The numbers (BM2): one definition each, from the modules that own them ----
const systemUser = (pid) => ({ id: null, practice_id: pid, role: 'admin', name: 'Benchmark sender', location_ids: null });
const roundFor = (metric, v) => (METRICS[metric].unit === 'money' ? Math.round(v / 100) * 100 : METRICS[metric].unit === 'percent' ? Math.round(v * 10) / 10 : Math.round(v));
export const monthRange = (month, today) => {
  const from = `${month}-01`;
  const end = addDays(addMonths(from, 1), -1);
  return { from, to: end < today ? end : today, complete: end < today };
};

// Rows for one month: [{ provider_id (null for the whole practice), role, metric, value, n }].
export async function computeAggregates(db, pid, { month, today, shareLabor = false }) {
  const { from, to } = monthRange(month, today);
  if (from > today) return [];
  const out = [];
  const add = (providerId, role, metric, value, n, min = 0) => {
    if (value == null || !Number.isFinite(Number(value))) return;
    if (!METRICS[metric]?.roles.includes(role)) return;
    if (min && (n == null || n < min)) return;
    out.push({ provider_id: providerId, role, metric, value: roundFor(metric, Number(value)), n: n == null ? null : Math.round(n) });
  };
  const providers = (await db.all('SELECT id, name, type FROM providers WHERE practice_id = ? AND active = 1 ORDER BY id', pid));

  const funnel = await diagnosisFunnel(db, pid, { from, to });
  const byFunnel = new Map(funnel.providers.map((p) => [p.provider_id, p]));
  const util = await runReport(db, systemUser(pid), 'schedule-utilization', { from, to, group: 'provider' });
  const byUtil = new Map(util.rows.map((r) => [r.id, r]));
  // Time in completed visits: the business view's visit minutes (doctor time for a dentist, chair time for hygiene).
  const minutes = new Map();
  for (const a of await db.all(
    `SELECT a.provider_id, a.start_time, a.end_time, a.pattern, t.pattern AS type_pattern, pv.type AS provider_type
     FROM real_appointments a JOIN providers pv ON pv.id = a.provider_id LEFT JOIN appointment_types t ON t.id = a.appointment_type_id
     WHERE a.practice_id = ? AND a.status = 'completed' AND a.start_time >= ? AND a.start_time < ?`, pid, `${from} 00:00`, `${addDays(to, 1)} 00:00`,
  )) {
    const m = visitMinutes({ start_time: a.start_time, end_time: a.end_time, pattern: a.pattern || a.type_pattern, provider_type: a.provider_type });
    minutes.set(a.provider_id, (minutes.get(a.provider_id) || 0) + m.provider);
  }
  const hygieneMix = await db.all(
    `SELECT provider_id, code, COUNT(*) AS n FROM real_procedures procedures WHERE practice_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?
       AND code IN (${[...PERIO_CODES, ...PROPHY_CODES].map(() => '?').join(',')}) GROUP BY provider_id, code`,
    pid, from, addDays(to, 1), ...PERIO_CODES, ...PROPHY_CODES,
  );

  for (const p of providers) {
    const role = roleOf(p);
    const f = byFunnel.get(p.id);
    if (f) {
      for (const t of f.by_exam_type) add(p.id, role, `dx_per_exam_${t.exam_type}`, t.per_exam, t.exams, MIN_SAMPLE.exams);
      for (const step of ['presented', 'accepted', 'scheduled', 'completed']) add(p.id, role, `conv_${step}`, f.total.of_diagnosed_pct[step], f.total.procedures, MIN_SAMPLE.findings);
    }
    const { values, parts } = await computeMetrics(db, pid, { from, to, today, providerId: p.id, keys: ['production_gross', 'case_acceptance', 'broken_rate', 'hygiene_reappointment'] });
    add(p.id, role, 'case_acceptance', values.case_acceptance, parts.case_acceptance?.plans, MIN_SAMPLE.plans);
    add(p.id, role, 'broken_rate', values.broken_rate, (parts.broken_rate?.kept || 0) + (parts.broken_rate?.broken || 0), MIN_SAMPLE.visits);
    add(p.id, role, 'hygiene_reappointment', values.hygiene_reappointment, parts.hygiene_reappointment?.visits, MIN_SAMPLE.visits);
    const mins = minutes.get(p.id) || 0;
    if (mins > 0 && values.production_gross != null) add(p.id, role, 'production_per_hour', (values.production_gross * 60) / mins, mins / 60, MIN_SAMPLE.hours);
    const u = byUtil.get(p.id);
    if (u) add(p.id, role, 'schedule_fill', u.utilization, u.open_hours, MIN_SAMPLE.hours);
    if (role === 'hygienist') {
      const mine = hygieneMix.filter((x) => x.provider_id === p.id);
      const perio = mine.filter((x) => PERIO_CODES.includes(x.code)).reduce((s, x) => s + Number(x.n), 0);
      const all = mine.reduce((s, x) => s + Number(x.n), 0);
      if (all) add(p.id, role, 'perio_pct', (perio / all) * 100, all, MIN_SAMPLE.visits);
    }
    if (role === 'dentist') {
      // Work completed within 1 / 3 / 5 months per exam (metrics.js examValues), all exam types together.
      for (const h of [1, 3, 5]) {
        const ev = await examValues(db, pid, { providerId: p.id, horizon: h, today: to });
        let exams = 0;
        let cents = 0;
        for (const x of Object.values(ev)) if (x.learned != null) { exams += x.exams; cents += x.learned * x.exams; }
        if (exams) add(p.id, role, `exam_value_${h}m`, cents / exams, exams, MIN_SAMPLE.examValue);
      }
    }
  }

  // The whole practice.
  const { values: pv, parts: pp } = await computeMetrics(db, pid, { from, to, today, keys: ['new_patients', 'collection_rate', 'case_acceptance', 'broken_rate'] });
  add(null, 'practice', 'new_patients', pv.new_patients, pv.new_patients);
  if ((pp.collection_rate?.net_production || 0) > 0) add(null, 'practice', 'collection_rate', pv.collection_rate, null);
  add(null, 'practice', 'case_acceptance', pv.case_acceptance, pp.case_acceptance?.plans, MIN_SAMPLE.plans);
  add(null, 'practice', 'broken_rate', pv.broken_rate, (pp.broken_rate?.kept || 0) + (pp.broken_rate?.broken || 0), MIN_SAMPLE.visits);
  const rc = await recallCounts(db, pid, { today: to });
  add(null, 'practice', 'reappointment_pct', rc.reappointment?.pct, rc.reappointment?.seen, MIN_SAMPLE.visits);
  add(null, 'practice', 'recall_current', rc.pct_current, rc.total, MIN_SAMPLE.recall);
  if (shareLabor) {
    const bt = await businessTrends(db, systemUser(pid), { from, to, group: 'month', rates: true, today, withProductivity: false });
    add(null, 'practice', 'labor_pct', bt.total.labor_pct_production, null);
  }
  return out;
}

// The payload: this month so far and last month (late postings still change it), in the only shape the service
// accepts (catalog.js). Names only for doctors who chose to be named.
export async function buildSubmission(db, pid, { today, settings = null }) {
  const s = settings || await settingsOf(db, pid);
  const ids = new Map((await providerIdentities(db, pid)).map((p) => [p.id, p]));
  const months = [];
  for (const month of [addMonths(`${today.slice(0, 7)}-01`, -1).slice(0, 7), today.slice(0, 7)]) {
    const rows = [];
    for (const r of await computeAggregates(db, pid, { month, today, shareLabor: !!Number(s.share_labor) })) {
      const who = r.provider_id ? ids.get(r.provider_id) : { provider_key: s.practice_key, anon_code: s.practice_code, show_name: false };
      if (!who?.provider_key) continue;
      const name = r.provider_id && who.show_name ? publicName(who.display_name || who.name) : null;
      rows.push({ provider_key: who.provider_key, role: r.role, anon_code: who.anon_code, ...(name ? { display_name: name } : {}), metric: r.metric, value: r.value, n: r.n });
    }
    months.push({ month, complete: monthRange(month, today).complete, rows });
  }
  return {
    v: 1, kind: 'submit', participant_id: s.participant_id, nonce: nonce(), sent_at: new Date().toISOString(),
    profile: await practiceProfile(db, pid, s, today), months,
  };
}

// Every key anywhere in a payload that isn't one of the shared fields (the test's and the send's own guard).
export function unexpectedKeys(payload) {
  const allowed = new Set(['v', 'kind', 'participant_id', 'nonce', 'sent_at', 'profile', 'months', 'public_key', 'month', 'complete', 'rows', ...ROW_KEYS, 'practice_type', 'region', 'size_band', 'payer_mix', 'years_band']);
  const bad = [];
  const walk = (x) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (!allowed.has(k)) bad.push(k); walk(v); }
  };
  walk(payload);
  return bad;
}

// ---- Sending ----
const countRows = (p) => (p.months || []).reduce((s, m) => s + m.rows.length, 0);
async function finish(db, id, patch) {
  const keys = Object.keys(patch);
  await db.run(`UPDATE bm_sends SET ${keys.map((k) => `${k} = ?`).join(', ')}, finished_at = datetime('now') WHERE id = ?`, ...keys.map((k) => patch[k]), id);
}

// Signs, records and sends one payload. Returns the service's answer; throws (after recording) when it fails.
async function transmit(db, pid, { client, secret, payload, cause, sendDate = null, userId = null, source = 'automation', today, privateKey = null }) {
  if (unexpectedKeys(payload).length) throw new Error(`Refusing to send fields that aren't shared: ${unexpectedKeys(payload).join(', ')}`);
  const s = await settingsOf(db, pid);
  const key = privateKey || openSecret(s.signing_secret, secret, SEAL);
  const body = JSON.stringify(payload);
  const rows = countRows(payload);
  let id;
  try {
    id = (await db.run(
      `INSERT INTO bm_sends (practice_id, kind, cause, send_date, months, rows, payload, payload_sha256, destination, status, source, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
      pid, payload.kind, cause, sendDate, payload.months ? payload.months.map((m) => m.month).join(',') : null, rows, body, sha256(body), client.destination, source, userId,
    )).id;
  } catch (err) {
    if (cause === 'nightly' && /unique|duplicate/i.test(String(err.message))) return { skipped: true }; // already sent today
    throw err;
  }
  let out;
  try {
    out = await client.call(`/v1/${payload.kind}`, body, signedHeaders({ participantId: payload.participant_id, privateKey: key, body }), { practiceId: pid, today });
  } catch (err) {
    await finish(db, id, { status: 'failed', error: String(err.message || err).slice(0, 500) });
    throw err;
  }
  if (out.status >= 400) {
    const why = out.body?.error || `The benchmark service answered ${out.status}`;
    await finish(db, id, { status: 'failed', http_status: out.status, error: String(why).slice(0, 500) });
    const err = new Error(why);
    err.status = out.status;
    throw err;
  }
  await finish(db, id, { status: 'sent', http_status: out.status, receipt: out.body?.receipt || null, accepted_rows: out.body?.accepted_rows ?? null });
  // Reconcile: every row sent was stored.
  if (payload.kind === 'submit') {
    if (Number(out.body?.accepted_rows) !== rows) {
      await raiseIssue(db, { practiceId: pid, kind: 'integration', key: ISSUE.reconcile, title: 'Benchmarks: the service stored a different number of rows than were sent', detail: `Sent ${rows}, stored ${out.body?.accepted_rows ?? 'none'} (send #${id}).`, role: 'admin', entity: 'bm_sends', entityId: id });
    } else await resolveIssue(db, pid, ISSUE.reconcile);
  }
  return { ...out.body, send_id: id };
}

// This practice's numbers, now (the nightly job, "Send now", and the first send on joining). Any failure — working
// the numbers out or sending them — becomes a Needs attention item, resolved by the next send that works.
export async function sendNow(db, pid, { client, secret, cause = 'manual', userId = null, source = 'automation' }) {
  const today = (await practiceNow(db, pid)).slice(0, 10);
  const s = await settingsOf(db, pid);
  if (s.status !== 'joined') return { skipped: true, reason: 'not joined' };
  try {
    const payload = await buildSubmission(db, pid, { today, settings: s });
    const out = await transmit(db, pid, { client, secret, payload, cause, sendDate: cause === 'nightly' ? today : null, userId, source, today });
    if (out.skipped) return out;
    await db.run("UPDATE bm_settings SET last_sent_at = datetime('now') WHERE practice_id = ?", pid);
    await resolveIssue(db, pid, ISSUE.send);
    // Keep last month's answer for the monthly email (which mustn't wait on the network).
    const last = addMonths(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
    try {
      await benchmarkResults(db, pid, { client, secret, month: last, today });
      await resolveIssue(db, pid, ISSUE.results);
    } catch (err) {
      await raiseIssue(db, { practiceId: pid, kind: 'integration', key: ISSUE.results, title: 'Benchmarks: could not fetch this month’s comparison', detail: err.message, role: 'admin' });
    }
    return out;
  } catch (err) {
    await raiseIssue(db, {
      practiceId: pid, kind: 'integration', key: ISSUE.send, title: 'Benchmark numbers could not be sent', role: 'admin',
      detail: `${err.message || err}. Nothing is lost: the next nightly send tries again, or use Send now in Settings → Benchmarks.`,
    });
    throw err;
  }
}

// ---- Joining and leaving (owner only; the routes audit them) ----
export async function joinBenchmarks(db, pid, { client, secret, userId, practiceType, foundedYear, shareLabor }) {
  if (client.mode === 'off') throw new HttpError(503, client.why);
  await ensureSettingsRow(db, pid);
  const before = await settingsOf(db, pid);
  if (before.status === 'joined') return { already: true };
  if (before.status === 'leaving') throw new HttpError(409, 'Leaving is still being confirmed with the benchmark service. Try again once that’s done.');
  const today = (await practiceNow(db, pid)).slice(0, 10);
  // Fresh random identities every time a practice joins, so a returning practice can't be linked to its old rows.
  const keys = generateKeys();
  const participantId = `bp_${hexId(12)}`;
  await db.tx(async () => {
    await db.run(
      `UPDATE bm_settings SET participant_id = ?, practice_key = ?, practice_code = ?, public_key = ?, signing_secret = ?, practice_type = ?, founded_year = ?, share_labor = ?,
         updated_by = ?, updated_at = datetime('now') WHERE practice_id = ?`,
      participantId, `k_${hexId(8)}`, code4(), keys.publicKey, sealSecret(keys.privateKey, secret, SEAL),
      practiceType ?? before.practice_type ?? 'general', foundedYear === undefined ? before.founded_year ?? null : foundedYear, shareLabor === undefined ? Number(before.share_labor || 0) : shareLabor ? 1 : 0, userId, pid,
    );
    for (const r of await db.all('SELECT id FROM bm_providers WHERE practice_id = ?', pid)) {
      await db.run('UPDATE bm_providers SET provider_key = ?, anon_code = ? WHERE id = ?', `k_${hexId(8)}`, code4(), r.id);
    }
  });
  const s = await settingsOf(db, pid);
  const payload = { v: 1, kind: 'join', participant_id: participantId, nonce: nonce(), sent_at: new Date().toISOString(), public_key: keys.publicKey, profile: await practiceProfile(db, pid, s, today) };
  await transmit(db, pid, { client, secret, payload, cause: 'join', userId, source: 'human', today, privateKey: keys.privateKey });
  await db.run("UPDATE bm_settings SET status = 'joined', terms_version = ?, joined_at = datetime('now'), joined_by = ?, left_at = NULL, left_by = NULL WHERE practice_id = ?", TERMS_VERSION, userId, pid);
  let first = null;
  try {
    first = await sendNow(db, pid, { client, secret, cause: 'join', userId, source: 'human' });
  } catch (err) {
    first = { error: err.message }; // already a Needs attention item; joining itself worked
  }
  return { joined: true, participant_id: participantId, first_send: first };
}

// Leaving stops sending at once; the service is told to delete every row this practice sent. If it can't be reached
// the practice stays "leaving" (nothing more is sent) and the job keeps asking until it's confirmed.
export async function leaveBenchmarks(db, pid, { client, secret, userId = null, source = 'human' }) {
  const s = await settingsOf(db, pid);
  if (!['joined', 'leaving'].includes(s.status)) return { already: true };
  if (s.status === 'joined') await db.run("UPDATE bm_settings SET status = 'leaving', left_at = datetime('now'), left_by = ? WHERE practice_id = ?", userId, pid);
  const today = (await practiceNow(db, pid)).slice(0, 10);
  try {
    const out = await transmit(db, pid, { client, secret, payload: { v: 1, kind: 'leave', participant_id: s.participant_id, nonce: nonce(), sent_at: new Date().toISOString() }, cause: 'leave', userId, source, today });
    await db.run("UPDATE bm_settings SET status = 'left', signing_secret = NULL, public_key = NULL, last_results = NULL, last_results_month = NULL, last_results_at = NULL WHERE practice_id = ?", pid);
    await resolveIssue(db, pid, ISSUE.leave, 'Resolved automatically: the benchmark service confirmed the practice’s rows were removed');
    await resolveIssue(db, pid, ISSUE.send, 'Resolved: the practice left benchmarks');
    return { left: true, removed_rows: out.removed_rows ?? null };
  } catch (err) {
    await raiseIssue(db, { practiceId: pid, kind: 'integration', key: ISSUE.leave, title: 'Leaving benchmarks isn’t confirmed yet', detail: `${err.message || err}. Nothing more is being sent; we’ll keep asking the service to remove your rows.`, role: 'admin' });
    return { left: false, pending: true, error: err.message };
  }
}

// ---- The nightly job ----
export async function runBenchmarkSends(db, { client, secret }) {
  let sent = 0;
  const list = await db.all("SELECT practice_id, status FROM bm_settings WHERE status IN ('joined','leaving')");
  for (const row of list) {
    await withActor({ source: 'automation', actor: 'Benchmark sender', practiceId: row.practice_id, userId: null }, async () => {
      if (row.status === 'leaving') {
        await leaveBenchmarks(db, row.practice_id, { client, secret, source: 'automation' });
        return;
      }
      const local = await practiceNow(db, row.practice_id);
      if (Number(local.slice(11, 13)) < SEND_AFTER_HOUR) return;
      const done = await db.get("SELECT id FROM bm_sends WHERE practice_id = ? AND cause = 'nightly' AND send_date = ? AND status != 'failed'", row.practice_id, local.slice(0, 10));
      if (done) return;
      try {
        const out = await sendNow(db, row.practice_id, { client, secret, cause: 'nightly' });
        if (!out.skipped) sent++;
      } catch { /* recorded in bm_sends and raised in Needs attention by sendNow */ }
    });
  }
  return sent;
}

// ---- Results for the screens ----
const ordinal = (n) => {
  const v = n % 100;
  return `${n}${v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
};
const moneyText = (c) => `$${Math.round(Number(c) / 100).toLocaleString('en-US')}`;
export const valueText = (unit, v) => (v == null ? '—' : unit === 'money' ? moneyText(v) : unit === 'percent' ? `${Math.round(v * 10) / 10}%` : String(Math.round(v)));

// Each provider's (and the practice's) card: where they stand overall, their 2–3 biggest opportunities with what
// the best quarter of the peer group does on the related numbers, and their strengths. From the numbers only.
export function coachingCards(results, people) {
  const cards = [];
  for (const who of people) {
    const mine = [];
    for (const m of results.metrics) {
      const x = m.mine.find((r) => r.provider_key === who.provider_key);
      if (x) mine.push({ ...m, own: x });
    }
    if (!mine.length) continue;
    const shown = mine.filter((m) => !m.suppressed && m.own.standing != null);
    const valueOf = (metric) => mine.find((m) => m.metric === metric)?.own.value ?? null;
    const opportunities = shown.filter((m) => m.own.standing < 50).sort((a, b) => a.own.standing - b.own.standing).slice(0, 3).map((m) => {
      const target = m.percentiles.p75;
      let impact = null;
      if (m.unit === 'money' && m.metric.startsWith('dx_per_exam') && m.own.n) impact = `About ${moneyText(Math.max(0, target - m.own.value) * m.own.n)} more diagnosed a month at the 75th percentile (${valueText(m.unit, target)} per exam × ${m.own.n} exams).`;
      else if (m.metric === 'production_per_hour' && m.own.n) impact = `About ${moneyText(Math.max(0, target - m.own.value) * m.own.n)} more a month at the 75th percentile (${valueText(m.unit, target)} an hour × ${m.own.n} hours).`;
      const differently = (m.top_performers || []).map((t) => {
        const yours = valueOf(t.metric);
        return { metric: t.metric, label: t.label, unit: t.unit, top: t.top_median, group: t.group_median, yours, text: `Top performers: ${t.label.toLowerCase()} ${valueText(t.unit, t.top_median)} (peer median ${valueText(t.unit, t.group_median)}${yours != null ? `, yours ${valueText(t.unit, yours)}` : ''}).` };
      }).filter((d) => d.top !== d.group).slice(0, 2);
      return {
        metric: m.metric, label: m.label, unit: m.unit, value: m.own.value, standing: m.own.standing, median: m.percentiles.p50, target,
        text: `${ordinal(m.own.standing)} percentile for ${m.label.toLowerCase()}: ${valueText(m.unit, m.own.value)} against a peer median of ${valueText(m.unit, m.percentiles.p50)}.`,
        impact, differently,
      };
    });
    const strengths = shown.filter((m) => m.own.standing >= 75).sort((a, b) => b.own.standing - a.own.standing).slice(0, 2)
      .map((m) => ({ metric: m.metric, label: m.label, standing: m.own.standing, text: `${ordinal(m.own.standing)} percentile for ${m.label.toLowerCase()} (${valueText(m.unit, m.own.value)}).` }));
    const above = shown.filter((m) => m.own.standing >= 50).length;
    cards.push({
      provider_id: who.provider_id ?? null, provider_key: who.provider_key, name: who.name, role: who.role,
      compared: shown.length, above, below: shown.length - above, hidden: mine.length - shown.length,
      summary: shown.length ? `Above the peer median on ${above} of ${shown.length} number${shown.length === 1 ? '' : 's'}.` : 'Not enough practices like yours share these numbers yet.',
      headline: shown.length ? (() => { const best = [...shown].sort((a, b) => b.own.standing - a.own.standing)[0]; return `You are at the ${ordinal(best.own.standing)} percentile for ${best.label.toLowerCase()}.`; })() : null,
      opportunities, strengths,
    });
  }
  return cards;
}

// Asks the service how this practice compares for a month, and puts the practice's own names back on its rows
// (they never left; only the random keys did). Also kept as last_results for the monthly email.
export async function benchmarkResults(db, pid, { client, secret, month, today = null }) {
  const s = await settingsOf(db, pid);
  if (s.status !== 'joined') return { joined: false, status: s.status };
  const day = today || (await practiceNow(db, pid)).slice(0, 10);
  const payload = { v: 1, kind: 'benchmarks', participant_id: s.participant_id, nonce: nonce(), sent_at: new Date().toISOString(), month };
  const body = JSON.stringify(payload);
  const out = await client.call('/v1/benchmarks', body, signedHeaders({ participantId: s.participant_id, privateKey: openSecret(s.signing_secret, secret, SEAL), body }), { practiceId: pid, today: day });
  if (out.status >= 400) throw new HttpError(502, `The benchmark service couldn’t answer: ${out.body?.error || out.status}`);
  const ids = await providerIdentities(db, pid);
  const people = [
    { provider_id: null, provider_key: s.practice_key, name: 'Your practice', role: 'practice' },
    ...ids.map((p) => ({ provider_id: p.id, provider_key: p.provider_key, name: p.name, role: p.role })),
  ];
  const byKey = new Map(people.map((p) => [p.provider_key, p]));
  const r = out.body;
  for (const m of r.metrics) for (const x of m.mine) Object.assign(x, { provider_id: byKey.get(x.provider_key)?.provider_id ?? null, name: byKey.get(x.provider_key)?.name || 'Former provider' });
  for (const b of r.leaderboards) {
    for (const e of b.entries) if (e.mine) Object.assign(e, { you: byKey.get(e.provider_key)?.name || e.label });
    if (b.rising_star?.mine) b.rising_star.you = byKey.get(b.rising_star.provider_key)?.name;
  }
  const result = { joined: true, month, mode: client.mode, sample: client.mode === 'sandbox', ...r, cards: coachingCards(r, people) };
  if (month < day.slice(0, 7)) {
    await db.run("UPDATE bm_settings SET last_results = ?, last_results_month = ?, last_results_at = datetime('now') WHERE practice_id = ?", JSON.stringify({ month, cards: result.cards, sample: result.sample }), month, pid);
  }
  return result;
}

// What's shared, in plain words (Settings → Benchmarks).
export const sharedList = () => Object.entries(METRICS).map(([key, m]) => ({ key, label: m.roles.map((r) => metricLabel(key, r)).filter((x, i, a) => a.indexOf(x) === i).join(' / '), roles: m.roles, unit: m.unit, optional: !!m.optional, source: m.source }));
