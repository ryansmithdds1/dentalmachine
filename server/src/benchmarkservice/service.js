// The benchmark service (BM3–BM5): receives the monthly aggregate rows that opted-in practices send, and answers
// each practice with how it compares with practices like it. It is its own small module with its own tables so it
// can run as a separate deployment (server.js) on its own database; in sandbox mode the practice app calls
// handle() in-process on the practice database with synthetic peers (sandbox.js).
//
// What it holds: per participant (a random id, never the practice's name) its peer-group profile and public key;
// per month, provider (a random key) and metric, one number and its sample size. No patient data ever arrives —
// payloads with any field not on the list in catalog.js are refused outright.
//
// Privacy rules enforced here:
//  - a benchmark (percentiles, leaderboard) is shown only when at least `minPeers` practices (default 10) are in
//    the peer group, so nobody can be singled out;
//  - names appear only for providers who chose to be named; everyone else is "Dr. #4821" with region and type;
//  - a practice that leaves has its rows deleted at once, so they're gone from every later benchmark.
import { timingSafeEqual } from 'node:crypto';
import { toPostgres } from '../db.js';
import {
  METRICS, ROLES, RELATED, DIMENSIONS, RELAX_ORDER, PROFILE_KEYS, PRACTICE_TYPES, REGIONS, metricLabel,
  MONTH, PROVIDER_KEY, PARTICIPANT_ID, ANON_CODE, PAYLOAD_KEYS, MONTH_KEYS, ROW_KEYS, MAX_ROWS_PER_MONTH,
} from './catalog.js';
import { checkSignature, validPublicKey, HEADERS, sha256, nonce as newNonce } from './signing.js';

export const DEFAULT_MIN_PEERS = 10;
export const LEADERBOARD_SIZE = 10;
const MAX_BODY = 1024 * 1024;

export function serviceConfig(env = process.env) {
  const n = Number(env.BENCHMARK_MIN_PEERS);
  return {
    // Never fewer than 5 in the group, whatever is configured.
    minPeers: Number.isInteger(n) && n >= 5 ? n : DEFAULT_MIN_PEERS,
    enrollToken: env.BENCHMARK_ENROLL_TOKEN || null,
  };
}

// ---- Storage (the service's own tables; created here so a separate deployment needs nothing else) ----
// bms_rows is a copy the practice sends and may withdraw: resending a month replaces that month's rows, and leaving
// deletes them (these are the practice's to take back, not records of ours).
export const SERVICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS bms_participants (
  id INTEGER PRIMARY KEY,
  participant_id TEXT NOT NULL UNIQUE,
  public_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','left')),
  practice_type TEXT,
  region TEXT,
  size_band TEXT,
  payer_mix TEXT,
  years_band TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  left_at TEXT,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS bms_rows (
  id INTEGER PRIMARY KEY,
  participant_id TEXT NOT NULL,
  month TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  role TEXT NOT NULL,
  anon_code TEXT NOT NULL,
  display_name TEXT,
  metric TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  n INTEGER,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bms_rows_key ON bms_rows(participant_id, month, provider_key, metric);
CREATE INDEX IF NOT EXISTS idx_bms_rows_month ON bms_rows(month, metric, role);
CREATE TABLE IF NOT EXISTS bms_nonces (
  id INTEGER PRIMARY KEY,
  participant_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bms_nonces ON bms_nonces(participant_id, nonce);
CREATE TABLE IF NOT EXISTS bms_receipts (
  id INTEGER PRIMARY KEY,
  receipt TEXT NOT NULL UNIQUE,
  participant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,
  body_sha256 TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bms_receipts_participant ON bms_receipts(participant_id, received_at);
`;

const ensured = new WeakSet();
export async function ensureServiceSchema(db) {
  if (ensured.has(db)) return;
  const sql = db.dialect === 'postgres' ? toPostgres(SERVICE_SCHEMA).replace(/id INTEGER PRIMARY KEY/g, 'id SERIAL PRIMARY KEY') : SERVICE_SCHEMA;
  for (const s of sql.split(';').map((x) => x.trim()).filter(Boolean)) await db.run(s);
  ensured.add(db);
}

// ---- Validation: only what catalog.js allows ----
class Refused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const refuse = (status, message) => { throw new Refused(status, message); };
const onlyKeys = (obj, allowed, where) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) refuse(400, `${where} must be an object`);
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) refuse(400, `${where} has fields that are not shared: ${extra.slice(0, 5).join(', ')}`);
};
const RANGE = { money: [0, 100_000_000], percent: [0, 1000], count: [0, 1_000_000] };

export function validProfile(p) {
  onlyKeys(p, PROFILE_KEYS, 'profile');
  for (const k of PROFILE_KEYS) if (typeof p[k] !== 'string' || !Object.hasOwn(DIMENSIONS[k], p[k])) refuse(400, `profile.${k} is not one of ${Object.keys(DIMENSIONS[k]).join(', ')}`);
  return Object.fromEntries(PROFILE_KEYS.map((k) => [k, p[k]]));
}

export function validRows(rows) {
  if (!Array.isArray(rows)) refuse(400, 'rows must be a list');
  if (rows.length > MAX_ROWS_PER_MONTH) refuse(400, 'Too many rows');
  const seen = new Set();
  return rows.map((r) => {
    onlyKeys(r, ROW_KEYS, 'row');
    const def = Object.hasOwn(METRICS, String(r.metric)) ? METRICS[r.metric] : null;
    if (!def) refuse(400, `Unknown metric: ${String(r.metric).slice(0, 40)}`);
    if (!def.roles.includes(r.role)) refuse(400, `${r.metric} is not compared for ${r.role}`);
    if (!PROVIDER_KEY.test(String(r.provider_key))) refuse(400, 'provider_key is not valid');
    if (!ANON_CODE.test(String(r.anon_code))) refuse(400, 'anon_code must be four digits');
    const [lo, hi] = RANGE[def.unit];
    if (typeof r.value !== 'number' || !Number.isFinite(r.value) || r.value < lo || r.value > hi) refuse(400, `${r.metric} value is out of range`);
    if (r.n != null && (!Number.isInteger(r.n) || r.n < 0 || r.n > 10_000_000)) refuse(400, 'n must be a whole number');
    let name = null;
    if (r.display_name != null) {
      // A name only for a provider who chose to show it; never for a whole practice.
      if (r.role === 'practice') refuse(400, 'Practices are never named');
      if (typeof r.display_name !== 'string' || !r.display_name.trim() || r.display_name.length > 80 || /[\d@]/.test(r.display_name)) refuse(400, 'display_name is not valid');
      name = r.display_name.trim();
    }
    const key = `${r.provider_key}|${r.metric}`;
    if (seen.has(key)) refuse(400, `A metric appears twice for one provider: ${r.metric}`);
    seen.add(key);
    return { provider_key: r.provider_key, role: r.role, anon_code: String(r.anon_code), display_name: name, metric: r.metric, value: r.value, n: r.n ?? null };
  });
}

// Months from two years ago up to next month (practices ahead of UTC are already in it).
function validMonth(m, now) {
  if (!MONTH.test(String(m))) refuse(400, 'month must be YYYY-MM');
  const d = new Date(now);
  const idx = (y, mo) => y * 12 + mo;
  const cur = idx(d.getUTCFullYear(), d.getUTCMonth());
  const [y, mo] = m.split('-').map(Number);
  const v = idx(y, mo - 1);
  if (v > cur + 1 || v < cur - 24) refuse(400, 'month is out of range');
  return m;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---- Requests ----
// One entry point for the HTTP router and the in-process sandbox: { path, headers (lower-case), body (the exact
// string that was signed) } → { status, body }.
export async function handle(db, { path, headers = {}, body, now = Date.now(), config = serviceConfig() }) {
  try {
    await ensureServiceSchema(db);
    if (typeof body !== 'string') refuse(415, 'Send the exact JSON text that was signed');
    if (body.length > MAX_BODY) refuse(413, 'The request is too large');
    let payload;
    try { payload = JSON.parse(body); } catch { refuse(400, 'The body is not JSON'); }
    onlyKeys(payload, PAYLOAD_KEYS, 'payload');
    const pid = headers[HEADERS.participant];
    if (!PARTICIPANT_ID.test(String(pid)) || payload.participant_id !== pid) refuse(400, 'participant_id is missing or does not match the signature header');
    if (typeof payload.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(payload.nonce)) refuse(400, 'nonce is missing');

    if (path === '/v1/join') return await join(db, { pid, payload, headers, body, now, config });
    const participant = await db.get("SELECT * FROM bms_participants WHERE participant_id = ? AND status = 'active'", pid);
    if (!participant?.public_key) refuse(401, 'This practice has not joined, or has left');
    const bad = checkSignature({ publicKey: participant.public_key, headers, body, now });
    if (bad) refuse(401, bad);
    await useNonce(db, pid, payload.nonce);
    await db.run('UPDATE bms_participants SET last_seen_at = datetime(\'now\') WHERE participant_id = ?', pid);
    if (path === '/v1/submit') return await submit(db, { pid, payload, body, now });
    if (path === '/v1/leave') return await leave(db, { pid, body });
    if (path === '/v1/benchmarks') {
      const month = validMonth(payload.month, now);
      return { status: 200, body: await benchmarksFor(db, pid, month, { minPeers: config.minPeers }) };
    }
    refuse(404, 'Unknown request');
  } catch (err) {
    if (err instanceof Refused) return { status: err.status, body: { error: err.message } };
    throw err;
  }
  return { status: 500, body: { error: 'unreachable' } };
}

async function useNonce(db, pid, n) {
  // Replays are refused; nonces older than two days are forgotten (the signature window is ten minutes).
  await db.run('DELETE FROM bms_nonces WHERE received_at < ?', new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 19).replace('T', ' '));
  try {
    await db.run('INSERT INTO bms_nonces (participant_id, nonce) VALUES (?, ?)', pid, n);
  } catch {
    refuse(409, 'This request was already received');
  }
}

async function receipt(db, { pid, kind, rows, body }) {
  const id = `r_${newNonce().slice(0, 20)}`;
  await db.run('INSERT INTO bms_receipts (receipt, participant_id, kind, rows, body_sha256) VALUES (?, ?, ?, ?, ?)', id, pid, kind, rows, sha256(body));
  return id;
}

async function join(db, { pid, payload, headers, body, now, config }) {
  if (config.enrollToken && !safeEqual(headers[HEADERS.enroll], config.enrollToken)) refuse(403, 'This benchmark service needs an enrolment token');
  if (!validPublicKey(payload.public_key)) refuse(400, 'public_key must be an Ed25519 public key');
  // Proof that the sender holds the private half of the key it registers.
  const bad = checkSignature({ publicKey: payload.public_key, headers, body, now });
  if (bad) refuse(401, bad);
  const profile = validProfile(payload.profile);
  const existing = await db.get('SELECT * FROM bms_participants WHERE participant_id = ?', pid);
  if (existing) {
    // The same join again (a retry) is fine; an id is never reused after leaving or with another key.
    if (existing.status === 'active' && existing.public_key === payload.public_key) return { status: 200, body: { ok: true, participant_id: pid, receipt: null, already: true } };
    refuse(409, 'This participant id is already taken');
  }
  await useNonce(db, pid, payload.nonce);
  await db.run(
    'INSERT INTO bms_participants (participant_id, public_key, practice_type, region, size_band, payer_mix, years_band, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))',
    pid, payload.public_key, profile.practice_type, profile.region, profile.size_band, profile.payer_mix, profile.years_band,
  );
  return { status: 201, body: { ok: true, participant_id: pid, receipt: await receipt(db, { pid, kind: 'join', rows: 0, body }) } };
}

async function submit(db, { pid, payload, body, now }) {
  const profile = validProfile(payload.profile);
  if (!Array.isArray(payload.months) || !payload.months.length || payload.months.length > 3) refuse(400, 'months must list one to three months');
  const months = payload.months.map((m) => {
    onlyKeys(m, MONTH_KEYS, 'month');
    return { month: validMonth(m.month, now), rows: validRows(m.rows) };
  });
  if (new Set(months.map((m) => m.month)).size !== months.length) refuse(400, 'A month appears twice');
  let accepted = 0;
  await db.tx(async () => {
    await db.run('UPDATE bms_participants SET practice_type = ?, region = ?, size_band = ?, payer_mix = ?, years_band = ? WHERE participant_id = ?',
      profile.practice_type, profile.region, profile.size_band, profile.payer_mix, profile.years_band, pid);
    for (const m of months) {
      // Sending a month again replaces it (late postings change last month's numbers): idempotent by design.
      await db.run('DELETE FROM bms_rows WHERE participant_id = ? AND month = ?', pid, m.month);
      for (const r of m.rows) {
        await db.run('INSERT INTO bms_rows (participant_id, month, provider_key, role, anon_code, display_name, metric, value, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          pid, m.month, r.provider_key, r.role, r.anon_code, r.display_name, r.metric, r.value, r.n);
        accepted++;
      }
    }
  });
  return { status: 200, body: { ok: true, accepted_rows: accepted, months: months.map((m) => m.month), receipt: await receipt(db, { pid, kind: 'submit', rows: accepted, body }) } };
}

// Leaving: every row the practice ever sent is deleted now, and its key forgotten, so nothing of it is in any
// later benchmark and the id can't be used again.
async function leave(db, { pid, body }) {
  let removed = 0;
  await db.tx(async () => {
    removed = (await db.run('DELETE FROM bms_rows WHERE participant_id = ?', pid)).changes;
    await db.run("UPDATE bms_participants SET status = 'left', public_key = NULL, left_at = datetime('now') WHERE participant_id = ?", pid);
  });
  return { status: 200, body: { ok: true, removed_rows: removed, receipt: await receipt(db, { pid, kind: 'leave', rows: removed, body }) } };
}

// ---- Benchmarks ----
export const prevMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};

export async function benchmarksFor(db, participantId, month, { minPeers = DEFAULT_MIN_PEERS } = {}) {
  const participants = await db.all("SELECT participant_id, practice_type, region, size_band, payer_mix, years_band, synthetic FROM bms_participants WHERE status = 'active'");
  const rows = await db.all(
    "SELECT r.participant_id, r.month, r.provider_key, r.role, r.anon_code, r.display_name, r.metric, r.value, r.n FROM bms_rows r JOIN bms_participants p ON p.participant_id = r.participant_id AND p.status = 'active' WHERE r.month IN (?, ?)",
    month, prevMonth(month),
  );
  return computeResults({ participants, rows: rows.filter((r) => r.month === month), prevRows: rows.filter((r) => r.month !== month), me: participantId, month, minPeers });
}

// Linear interpolation between closest ranks.
export function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const roundFor = (unit, x) => (x == null ? null : unit === 'percent' ? round1(x) : Math.round(x));

// The 25th/50th/75th/90th percentile of performance: p90 is the value 90% of the group does worse than. For a
// metric where lower is better (no-show rate, labor %) that is the low end of the values.
export function percentiles(values, better = 'higher', unit = 'percent') {
  const asc = [...values].sort((a, b) => a - b);
  const at = (q) => roundFor(unit, quantile(asc, better === 'lower' ? 1 - q : q));
  return { p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9) };
}

// Where a value stands: the share of the others it does better than (ties count half), 1–99.
export function standing(values, value, better = 'higher') {
  const others = [...values];
  const i = others.indexOf(value);
  if (i >= 0) others.splice(i, 1);
  if (!others.length) return null;
  const worse = others.filter((v) => (better === 'lower' ? v > value : v < value)).length;
  const ties = others.filter((v) => v === value).length;
  // Shown as 1st–99th: nobody is "0th" or "100th" among peers.
  return Math.min(99, Math.max(1, Math.round((100 * (worse + ties / 2)) / others.length)));
}

// The narrowest peer group with at least minPeers practices: every dimension first, then widened one dimension
// at a time (RELAX_ORDER). null when even all practices together are too few.
export function peerGroup(profile, byId, candidates, minPeers) {
  for (let drop = 0; drop <= RELAX_ORDER.length; drop++) {
    const dims = PROFILE_KEYS.filter((d) => !RELAX_ORDER.slice(0, drop).includes(d));
    const ids = [...candidates].filter((id) => dims.every((d) => byId.get(id)?.[d] === profile[d]));
    if (ids.length >= minPeers) return { dims, ids: new Set(ids), practices: ids.length };
  }
  return null;
}
export function groupLabel(profile, dims) {
  const parts = [dims.includes('practice_type') ? `${PRACTICE_TYPES[profile.practice_type]} practices` : 'All practices'];
  for (const d of ['region', 'size_band', 'payer_mix', 'years_band']) if (dims.includes(d)) parts.push(DIMENSIONS[d][profile[d]]);
  return parts.join(' · ');
}
const shownName = (r) => r.display_name || `${r.role === 'hygienist' ? 'RDH' : r.role === 'practice' ? 'Practice' : 'Dr.'} #${r.anon_code}`;
const median = (list) => (list.length ? quantile([...list].sort((a, b) => a - b), 0.5) : null);

export function computeResults({ participants, rows, prevRows = [], me, month, minPeers = DEFAULT_MIN_PEERS }) {
  const byId = new Map(participants.map((p) => [p.participant_id, p]));
  const mine = byId.get(me);
  if (!mine) return { month, min_peers: minPeers, metrics: [], leaderboards: [] };
  const profile = Object.fromEntries(PROFILE_KEYS.map((k) => [k, mine[k]]));
  // Values by metric and role.
  const index = (list) => {
    const out = new Map();
    for (const r of list) {
      if (!byId.has(r.participant_id)) continue;
      const k = `${r.metric}|${r.role}`;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push({ ...r, value: Number(r.value) });
    }
    return out;
  };
  const now = index(rows);
  const before = index(prevRows);
  const who = (r) => `${r.participant_id}|${r.provider_key}`;
  const metrics = [];
  const leaderboards = [];
  for (const [metric, def] of Object.entries(METRICS)) {
    for (const role of def.roles) {
      const list = now.get(`${metric}|${role}`) || [];
      const own = list.filter((r) => r.participant_id === me);
      const base = { metric, role, role_label: ROLES[role], label: metricLabel(metric, role), unit: def.unit, better: def.better };
      if (!list.length) continue;
      const group = peerGroup(profile, byId, new Set(list.map((r) => r.participant_id)), minPeers);
      if (!group) {
        metrics.push({ ...base, suppressed: true, reason: `Fewer than ${minPeers} practices share this number yet, so it isn't shown (nobody can be singled out).`, mine: own.map((r) => ({ provider_key: r.provider_key, value: r.value, n: r.n, standing: null })) });
        continue;
      }
      const peers = list.filter((r) => group.ids.has(r.participant_id));
      const values = peers.map((r) => r.value);
      const pct = percentiles(values, def.better, def.unit);
      const standingOf = new Map(peers.map((r) => [who(r), standing(values, r.value, def.better)]));
      // What the best quarter looks like on the related numbers (from the numbers only).
      const top = new Set(peers.filter((r) => standingOf.get(who(r)) >= 75).map(who));
      const topPerformers = [];
      for (const rel of RELATED[metric] || []) {
        if (!METRICS[rel]?.roles.includes(role)) continue;
        const relRows = (now.get(`${rel}|${role}`) || []).filter((r) => group.ids.has(r.participant_id));
        const topVals = relRows.filter((r) => top.has(who(r))).map((r) => r.value);
        if (topVals.length < 3) continue;
        topPerformers.push({ metric: rel, label: metricLabel(rel, role), unit: METRICS[rel].unit, better: METRICS[rel].better, top_median: roundFor(METRICS[rel].unit, median(topVals)), group_median: roundFor(METRICS[rel].unit, median(relRows.map((r) => r.value))) });
      }
      metrics.push({
        ...base, suppressed: false, group: { label: groupLabel(profile, group.dims), dims: group.dims, practices: group.practices, values: values.length }, percentiles: pct,
        mine: own.map((r) => ({ provider_key: r.provider_key, value: r.value, n: r.n, standing: standingOf.get(who(r)) })), top_performers: topPerformers,
      });

      // The leaderboard: best first, anonymous unless the provider chose to be named, region and type only.
      const sorted = [...peers].sort((a, b) => (def.better === 'lower' ? a.value - b.value : b.value - a.value));
      const entries = sorted.slice(0, LEADERBOARD_SIZE).map((r, i) => {
        const s = standingOf.get(who(r));
        const tier = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : s >= 90 ? 'top10' : null;
        const p = byId.get(r.participant_id);
        return {
          rank: i + 1, label: shownName(r), named: !!r.display_name, region: REGIONS[p.region] || null, practice_type: PRACTICE_TYPES[p.practice_type] || null, value: r.value,
          badge: tier ? { tier, text: tier === 'gold' ? def.badge : tier === 'top10' ? 'Top 10%' : tier === 'silver' ? 'Runner-up' : 'Third place' } : null,
          mine: r.participant_id === me, ...(r.participant_id === me ? { provider_key: r.provider_key } : {}), ...(p.synthetic ? { sample: true } : {}),
        };
      });
      for (const r of own) {
        if (entries.some((e) => e.mine && e.provider_key === r.provider_key)) continue;
        entries.push({ rank: sorted.findIndex((x) => who(x) === who(r)) + 1, label: shownName(r), named: !!r.display_name, region: REGIONS[mine.region] || null, practice_type: PRACTICE_TYPES[mine.practice_type] || null, value: r.value, badge: null, mine: true, provider_key: r.provider_key, outside_top: true });
      }
      // Rising star: the biggest climb in standing since last month, in the same group (10 points or more).
      const prev = (before.get(`${metric}|${role}`) || []).filter((r) => group.ids.has(r.participant_id));
      let rising = null;
      if (prev.length) {
        const prevValues = prev.map((r) => r.value);
        const prevStanding = new Map(prev.map((r) => [who(r), standing(prevValues, r.value, def.better)]));
        for (const r of peers) {
          const was = prevStanding.get(who(r));
          const is = standingOf.get(who(r));
          if (was == null || is == null) continue;
          const gain = is - was;
          if (gain >= 10 && (!rising || gain > rising.gain)) {
            const p = byId.get(r.participant_id);
            rising = { label: shownName(r), region: REGIONS[p.region] || null, practice_type: PRACTICE_TYPES[p.practice_type] || null, gain, badge: 'Rising star', mine: r.participant_id === me, ...(r.participant_id === me ? { provider_key: r.provider_key } : {}), ...(p.synthetic ? { sample: true } : {}) };
          }
        }
      }
      leaderboards.push({ metric, role, label: base.label, role_label: ROLES[role], unit: def.unit, better: def.better, group_label: groupLabel(profile, group.dims), practices: group.practices, entries, rising_star: rising });
    }
  }
  return { month, min_peers: minPeers, profile, metrics, leaderboards };
}
