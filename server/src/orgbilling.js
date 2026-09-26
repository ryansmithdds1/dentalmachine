// DSO / group central billing office: the work queues, patient lookup and side-by-side reports that span the
// practices of one organization. Everything here is read-only over the practices' own records — work on a
// claim, payment or account is done inside that practice, through its normal screens and permissions.
//
// Tenant rule: every query takes the list of member practice ids from groupAccess() (the server's view of
// the group), never from the client, and filters by `practice_id IN (…)`. Joins repeat the practice match so
// a row from one practice can never pick up a patient from another.
import { HttpError, can } from './auth.js';
import { toolByName } from './datatools.js';
import { computeMetrics } from './metrics.js';
import { agingReport } from './aging.js';
import { practiceNow, isRealDate } from './util.js';

export const QUEUES = {
  outstanding: 'Claims waiting on the payer',
  denied: 'Denied claims',
  unsent: 'Claims not sent',
  era: 'Insurance payments not matched',
  credits: 'Patient credit balances',
};

const list = (ids) => ids.map(() => '?').join(',');
const DAY = 86400_000;
export const daysBetween = (from, to) => (from ? Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`)) / DAY)) : null);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

// The person's group, their part in it, and its practices — or null when they aren't in one. A member whose
// own practice has since left the group has no access (org.js removes them too; this is the second lock).
export async function groupAccess(db, user) {
  const m = await db.get(
    'SELECT m.role, m.billing, o.id, o.name FROM org_members m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? ORDER BY m.id LIMIT 1', user.id,
  );
  if (!m) return null;
  const practices = await db.all('SELECT id, name, city, state, timezone FROM practices WHERE organization_id = ? ORDER BY name, id', m.id);
  if (!practices.some((p) => p.id === user.practice_id)) return null;
  return { id: m.id, name: m.name, role: m.role, billing: m.role === 'owner' || !!Number(m.billing), practices };
}

// Central billing needs a group billing role (or ownership) and billing access in the person's own practice.
// Someone held to some offices can't see across the whole group.
export async function requireGroupBilling(db, user) {
  const g = await groupAccess(db, user);
  if (!g) throw new HttpError(403, 'You aren’t part of a practice group');
  if (!g.billing) throw new HttpError(403, 'Ask a group owner to add you to the group’s billing team');
  if (!can(user, 'billing:read')) throw new HttpError(403, 'Missing permission: billing:read');
  if (Array.isArray(user.location_ids) && user.location_ids.length) throw new HttpError(403, 'Central billing covers every office; your account is limited to some offices');
  return g;
}

// A practice filter from the query string, checked against the group (an outside id is refused, not ignored).
export function pickPractices(group, practiceId) {
  if (practiceId == null || practiceId === '' || practiceId === 'all') return group.practices;
  const p = group.practices.find((x) => x.id === Number(practiceId));
  if (!p) throw new HttpError(404, 'Not a practice in this group');
  return [p];
}

// Work on an item happens inside its practice: the person must be signed in there with billing access.
// Everyone else sees the row read-only.
export const canOpen = (user, practiceId) => practiceId === user.practice_id && can(user, 'billing:read');

async function todays(db, practices) {
  const out = new Map();
  for (const p of practices) out.set(p.id, (await practiceNow(db, p.id)).slice(0, 10));
  return out;
}

const patientName = (r) => (r.first_name || r.last_name ? `${r.last_name || ''}, ${r.first_name || ''}`.replace(/^, |, $/g, '') : null);

// Every queue row across the chosen practices. Small per-queue SQL, each filtered by practice.
export async function queueRows(db, user, group, practices, { queues = Object.keys(QUEUES) } = {}) {
  const ids = practices.map((p) => p.id);
  if (!ids.length) return [];
  const names = new Map(group.practices.map((p) => [p.id, p.name]));
  const today = await todays(db, practices);
  const want = new Set(queues);
  const rows = [];
  const base = (practiceId) => ({ practice_id: practiceId, practice: names.get(practiceId), can_open: canOpen(user, practiceId) });

  if (want.has('outstanding') || want.has('denied') || want.has('unsent')) {
    const claims = await db.all(
      `SELECT c.id, c.practice_id, c.patient_id, c.status, c.total_fee, c.estimated_amount, c.paid_amount, c.submitted_at, c.created_at, c.ch_updated_at,
         c.denial_reason, c.follow_up_date, p.first_name, p.last_name, ic.name AS carrier
       FROM real_claims c JOIN real_patients p ON p.id = c.patient_id AND p.practice_id = c.practice_id
       LEFT JOIN real_patient_insurance pi ON pi.id = c.patient_insurance_id LEFT JOIN insurance_carriers ic ON ic.id = pi.carrier_id
       WHERE c.practice_id IN (${list(ids)}) AND c.status IN ('draft','submitted','partially_paid','denied')`, ...ids,
    );
    for (const c of claims) {
      const t = today.get(c.practice_id);
      const queue = c.status === 'draft' ? 'unsent' : c.status === 'denied' ? 'denied' : 'outstanding';
      if (!want.has(queue)) continue;
      const since = queue === 'unsent' ? c.created_at : queue === 'denied' ? (c.ch_updated_at || c.submitted_at || c.created_at) : (c.submitted_at || c.created_at);
      const owed = Math.max(0, (c.estimated_amount || 0) - (c.paid_amount || 0));
      rows.push({
        key: `claim:${c.id}`, queue, ...base(c.practice_id), patient_id: c.patient_id, patient: patientName(c), status: c.status,
        amount: queue === 'outstanding' ? owed : owed || c.total_fee, since: String(since || '').slice(0, 10) || null, age_days: daysBetween(since, t),
        detail: [c.carrier, queue === 'denied' ? c.denial_reason : null, c.follow_up_date ? `follow up ${c.follow_up_date}` : null].filter(Boolean).join(' · '),
        link: `/claims/${c.id}`,
      });
    }
  }

  if (want.has('era')) {
    // Remittance lines that couldn't be posted automatically, until the practice marks the ERA's
    // Needs attention item resolved (era.js raises it as `era:<id>`).
    const eras = await db.all(
      `SELECT e.id, e.practice_id, e.payer_name, e.check_number, e.payment_date, e.created_at, e.details FROM era_imports e
       WHERE e.practice_id IN (${list(ids)}) AND e.claims_unmatched > 0`, ...ids,
    );
    const done = new Set((await db.all(
      `SELECT practice_id, dedupe_key FROM issues WHERE practice_id IN (${list(ids)}) AND kind = 'era' AND status = 'resolved'`, ...ids,
    )).map((i) => `${i.practice_id}|${i.dedupe_key}`));
    const lines = [];
    for (const e of eras) {
      if (done.has(`${e.practice_id}|era:${e.id}`)) continue;
      let details = [];
      try { details = JSON.parse(e.details || '[]'); } catch { details = []; }
      details.forEach((d, i) => { if (d.result === 'unmatched' || d.result === 'needs_review') lines.push({ e, d, i }); });
    }
    // Lines matched to a claim but held for review name the patient (only if the claim is the same practice's).
    const claimIds = [...new Set(lines.map((l) => Number(l.d.claim_id)).filter(Number.isInteger))];
    const claimPatients = new Map(claimIds.length ? (await db.all(
      `SELECT c.id, c.practice_id, c.patient_id, p.first_name, p.last_name FROM real_claims c JOIN real_patients p ON p.id = c.patient_id AND p.practice_id = c.practice_id
       WHERE c.id IN (${list(claimIds)}) AND c.practice_id IN (${list(ids)})`, ...claimIds, ...ids,
    )).map((c) => [c.id, c]) : []);
    for (const { e, d, i } of lines) {
      const cp = claimPatients.get(Number(d.claim_id));
      const pt = cp && cp.practice_id === e.practice_id ? cp : null;
      const since = e.payment_date || e.created_at;
      rows.push({
        key: `era:${e.id}:${i}`, queue: 'era', ...base(e.practice_id), patient_id: pt?.patient_id ?? null, patient: pt ? patientName(pt) : null,
        status: d.result, amount: Number(d.paid) || 0, since: String(since || '').slice(0, 10) || null, age_days: daysBetween(since, today.get(e.practice_id)),
        detail: [e.payer_name, e.check_number ? `EFT/check ${e.check_number}` : null, d.control_number ? `claim # ${d.control_number}` : null, d.note || (d.result === 'unmatched' ? 'No matching claim' : null)].filter(Boolean).join(' · '),
        link: '/claims?tab=era',
      });
    }
  }

  if (want.has('credits')) {
    // Balances come from the ledger (SUM of every entry — voids and their reversals cancel out), never stored.
    const credits = await db.all(
      `SELECT l.practice_id, l.patient_id, SUM(l.amount) AS balance, MAX(l.entry_date) AS last_date FROM real_ledger_entries l
       WHERE l.practice_id IN (${list(ids)}) GROUP BY l.practice_id, l.patient_id HAVING SUM(l.amount) < 0`, ...ids,
    );
    const pids = credits.map((c) => c.patient_id);
    const people = new Map(pids.length ? (await db.all(
      `SELECT id, practice_id, first_name, last_name FROM real_patients patients WHERE id IN (${list(pids)}) AND practice_id IN (${list(ids)})`, ...pids, ...ids,
    )).map((p) => [`${p.practice_id}|${p.id}`, p]) : []);
    for (const c of credits) {
      const p = people.get(`${c.practice_id}|${c.patient_id}`);
      if (!p) continue;
      rows.push({
        key: `credit:${c.patient_id}`, queue: 'credits', ...base(c.practice_id), patient_id: c.patient_id, patient: patientName(p), status: 'credit',
        amount: -Number(c.balance), since: c.last_date, age_days: daysBetween(c.last_date, today.get(c.practice_id)),
        detail: 'Refund or apply to future work', link: `/patients/${c.patient_id}?tab=ledger`,
      });
    }
  }

  // Who's working each item.
  const assigned = new Map((await db.all(
    'SELECT a.item_key, a.practice_id, a.assigned_to, u.name FROM org_assignments a LEFT JOIN users u ON u.id = a.assigned_to WHERE a.organization_id = ? AND a.assigned_to IS NOT NULL', group.id,
  )).map((a) => [`${a.practice_id}|${a.item_key}`, a]));
  for (const r of rows) {
    const a = assigned.get(`${r.practice_id}|${r.key}`);
    r.assigned_to = a?.assigned_to ?? null;
    r.assigned_name = a?.name ?? null;
    // Deep links only for rows the person can work; the rest are read-only.
    if (!r.can_open) r.link = null;
  }
  return rows.sort((a, b) => (b.age_days ?? -1) - (a.age_days ?? -1) || b.amount - a.amount || a.key.localeCompare(b.key));
}

// Counts and amounts per practice per queue, plus the outstanding-claims age bands, for the overview tiles.
export function summarize(rows, practices) {
  const empty = () => Object.fromEntries(Object.keys(QUEUES).map((q) => [q, { count: 0, amount: 0 }]));
  const by = new Map(practices.map((p) => [p.id, { practice_id: p.id, name: p.name, city: p.city, queues: empty(), claim_age: { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 } }]));
  const totals = { queues: empty(), claim_age: { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 } };
  for (const r of rows) {
    const p = by.get(r.practice_id);
    if (!p) continue;
    for (const t of [p, totals]) {
      t.queues[r.queue].count++;
      t.queues[r.queue].amount += r.amount;
      if (r.queue === 'outstanding') {
        const d = r.age_days ?? 0;
        t.claim_age[d <= 30 ? 'd0_30' : d <= 60 ? 'd31_60' : d <= 90 ? 'd61_90' : 'd90_plus'] += r.amount;
      }
    }
  }
  return { practices: [...by.values()], totals };
}

// Which practice an item belongs to, from the database — never from the client.
export async function itemPractice(db, key) {
  const m = /^(claim|credit):(\d+)$|^era:(\d+):(\d+)$/.exec(String(key || ''));
  if (!m) return null;
  if (m[1] === 'claim') return (await db.get('SELECT practice_id FROM claims WHERE id = ?', Number(m[2])))?.practice_id ?? null;
  if (m[1] === 'credit') return (await db.get('SELECT practice_id FROM patients WHERE id = ?', Number(m[2])))?.practice_id ?? null;
  const e = await db.get('SELECT practice_id, details FROM era_imports WHERE id = ?', Number(m[3]));
  if (!e) return null;
  let details = [];
  try { details = JSON.parse(e.details || '[]'); } catch { details = []; }
  return Number(m[4]) < details.length ? e.practice_id : null;
}

// ---- Cross-practice patient lookup ----
// For a caller on the phone ("I was seen at your other office"): name, birth date and/or phone. At least two
// of them, or a first and last name, or a full phone number — enough to find one person, not to browse.
export function lookupCriteria(q) {
  const name = String(q.name || '').trim().toLowerCase().replace(/[^a-z' -]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const words = name ? name.split(' ').filter((w) => w.length >= 1) : [];
  const dob = q.dob ? String(q.dob).trim() : '';
  if (dob && !isRealDate(dob)) throw new HttpError(400, 'Birth date must be YYYY-MM-DD');
  const phone = String(q.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '').slice(0, 15);
  if (phone && phone.length < 7) throw new HttpError(400, 'Enter at least 7 digits of the phone number');
  const given = [words.length ? 1 : 0, dob ? 1 : 0, phone ? 1 : 0].reduce((a, b) => a + b, 0);
  if (!(given >= 2 || words.length >= 2 || phone.length >= 10)) {
    throw new HttpError(400, 'Enter two of name, birth date and phone — or a first and last name, or a full phone number');
  }
  return { words, dob: dob || null, phone: phone || null };
}

export async function lookupPatients(db, user, group, { words, dob, phone }, { limit = 25 } = {}) {
  const ids = group.practices.map((p) => p.id);
  const names = new Map(group.practices.map((p) => [p.id, p.name]));
  const conds = [];
  const args = [];
  for (const w of words.slice(0, 4)) {
    conds.push('(lower(p.first_name) LIKE ? OR lower(p.last_name) LIKE ? OR lower(COALESCE(p.preferred_name, \'\')) LIKE ?)');
    args.push(`${w}%`, `${w}%`, `${w}%`);
  }
  if (dob) { conds.push('p.dob = ?'); args.push(dob); }
  if (phone) {
    const digits = (c) => `replace(replace(replace(replace(replace(COALESCE(${c}, ''),'(',''),')',''),'-',''),' ',''),'.','')`;
    conds.push(`(${['p.phone', 'p.phone_home', 'p.phone_work'].map((c) => `${digits(c)} LIKE ?`).join(' OR ')})`);
    args.push(`%${phone}%`, `%${phone}%`, `%${phone}%`);
  }
  const found = await db.all(
    `SELECT p.id, p.practice_id, p.first_name, p.last_name, p.preferred_name, p.dob, p.phone, p.status FROM real_patients p
     WHERE p.practice_id IN (${list(ids)}) AND p.status != 'archived' AND ${conds.join(' AND ')}
     ORDER BY p.last_name, p.first_name, p.id LIMIT ?`, ...ids, ...args, limit,
  );
  if (!found.length) return [];
  const pids = found.map((p) => p.id);
  const bal = new Map((await db.all(
    `SELECT patient_id, SUM(amount) AS balance FROM real_ledger_entries ledger_entries WHERE practice_id IN (${list(ids)}) AND patient_id IN (${list(pids)}) GROUP BY patient_id`, ...ids, ...pids,
  )).map((b) => [b.patient_id, Number(b.balance)]));
  const claims = new Map((await db.all(
    `SELECT patient_id, COUNT(*) AS n FROM real_claims claims WHERE practice_id IN (${list(ids)}) AND patient_id IN (${list(pids)}) AND status IN ('draft','submitted','partially_paid','denied') GROUP BY patient_id`, ...ids, ...pids,
  )).map((c) => [c.patient_id, Number(c.n)]));
  const visits = new Map((await db.all(
    `SELECT patient_id, MAX(start_time) AS last_visit FROM real_appointments appointments WHERE practice_id IN (${list(ids)}) AND patient_id IN (${list(pids)}) AND status = 'completed' GROUP BY patient_id`, ...ids, ...pids,
  )).map((v) => [v.patient_id, v.last_visit]));
  return found.map((p) => ({
    practice_id: p.practice_id, practice: names.get(p.practice_id), patient_id: p.id, name: `${p.first_name}${p.preferred_name ? ` “${p.preferred_name}”` : ''} ${p.last_name}`,
    dob: p.dob, phone: p.phone, status: p.status, balance: bal.get(p.id) ?? 0, open_claims: claims.get(p.id) ?? 0, last_visit: String(visits.get(p.id) || '').slice(0, 10) || null,
    can_open: p.practice_id === user.practice_id && can(user, 'patients:read'), link: p.practice_id === user.practice_id && can(user, 'patients:read') ? `/patients/${p.id}` : null,
  }));
}

// ---- Group reports ----
export function reportRange(q, today) {
  const to = q.to || today;
  const from = q.from || `${to.slice(0, 7)}-01`;
  if (!isRealDate(from) || !isRealDate(to)) throw new HttpError(400, 'Dates must be YYYY-MM-DD');
  if (from > to) throw new HttpError(400, 'The start date is after the end date');
  if (Date.parse(to) - Date.parse(from) > 3 * 366 * DAY) throw new HttpError(400, 'Choose a range of three years or less');
  return { from, to };
}

// Hygiene reappointment: completed hygiene visits whose patient left with the next visit already booked
// (booked by the day of the visit) — the same rule as the practice's own KPI screen (routes/growth.js).
async function hygieneReappointment(db, pid, from, to) {
  const r = await db.get(
    `SELECT COUNT(*) AS visits, SUM(CASE WHEN EXISTS (SELECT 1 FROM real_appointments b WHERE b.patient_id = a.patient_id AND b.practice_id = a.practice_id AND b.start_time > a.start_time
         AND b.status NOT IN ('cancelled','no_show') AND substr(b.created_at, 1, 10) <= substr(a.start_time, 1, 10)) THEN 1 ELSE 0 END) AS reappointed
     FROM real_appointments a JOIN providers pv ON pv.id = a.provider_id
     WHERE a.practice_id = ? AND pv.type = 'hygienist' AND a.status = 'completed' AND a.start_time >= ? AND a.start_time < ?`,
    pid, `${from} 00:00`, `${to} 24:00`,
  );
  return { visits: Number(r?.visits) || 0, reappointed: Number(r?.reappointed) || 0 };
}

export const REPORT_COLUMNS = [
  ['production', 'Production', 'money'], ['collections', 'Collections', 'money'], ['collection_pct', 'Collection %', 'pct'],
  ['ar_current', 'A/R current', 'money'], ['ar_31_60', 'A/R 31–60', 'money'], ['ar_61_90', 'A/R 61–90', 'money'], ['ar_90_plus', 'A/R 90+', 'money'], ['ar_total', 'A/R total', 'money'],
  ['new_patients', 'New patients', 'count'], ['treatment_presented', 'Treatment presented', 'money'], ['treatment_accepted', 'Treatment accepted', 'money'],
  ['case_acceptance_pct', 'Case acceptance %', 'pct'], ['hygiene_visits', 'Hygiene visits', 'count'], ['hygiene_reappointed', 'Reappointed', 'count'],
  ['hygiene_reappointment_pct', 'Hygiene reappointment %', 'pct'],
];

// Each practice's numbers with the practice's own report code, then group totals summed from them (rates
// recomputed from the summed parts, never averaged).
export async function groupReport(db, practices, { from, to }) {
  const numbers = toolByName('practice_numbers');
  const rows = [];
  for (const p of practices) {
    const today = (await practiceNow(db, p.id)).slice(0, 10);
    const n = await numbers.run(db, p.id, { from, to });
    // New patients as Metrics counts them (first completed visit), so every screen shows the same number.
    n.new_patients = (await computeMetrics(db, p.id, { from: n.from, to: n.to, today, keys: ['new_patients'] })).values.new_patients ?? n.new_patients;
    const ar = (await agingReport(db, p.id, to < today ? to : today)).totals;
    const hyg = await hygieneReappointment(db, p.id, from, to);
    rows.push({
      practice_id: p.id, name: p.name, city: p.city,
      production: n.production, collections: n.collections, collection_pct: pct(n.collections, n.production),
      ar_current: ar.current, ar_31_60: ar.d31_60, ar_61_90: ar.d61_90, ar_90_plus: ar.d90_plus, ar_total: ar.total,
      new_patients: n.new_patients, treatment_presented: n.treatment_presented, treatment_accepted: n.treatment_accepted,
      case_acceptance_pct: pct(n.treatment_accepted, n.treatment_presented),
      hygiene_visits: hyg.visits, hygiene_reappointed: hyg.reappointed, hygiene_reappointment_pct: pct(hyg.reappointed, hyg.visits),
    });
  }
  const totals = {};
  for (const [k, , kind] of REPORT_COLUMNS) if (kind !== 'pct') totals[k] = rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  totals.collection_pct = pct(totals.collections, totals.production);
  totals.case_acceptance_pct = pct(totals.treatment_accepted, totals.treatment_presented);
  totals.hygiene_reappointment_pct = pct(totals.hygiene_reappointed, totals.hygiene_visits);
  return { from, to, practices: rows, totals };
}
