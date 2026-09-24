// Denial risk per claim line (and per claim: its riskiest line), from this practice's own claim outcomes plus the
// scrubber's rule checks (see builtin.js for the model; scrubber.js for the rules, whose messages stay as they are).
//
// What counts as a denied line: its claim was denied (now or at some point — a denial later won on appeal still
// counts, since the question is "will it be denied when we send it"), or the payer paid the claim but nothing on
// this line although we expected something. Secondary claims are left out (their $0 lines are usually the primary
// having paid it all). Claims still waiting on the payer don't count either way.
import { practiceNow } from '../util.js';
import { cachedStats, getPredictor, forScreen } from './index.js';
import { predictDenial } from './builtin.js';
import { addDays, calibrate } from './noshow.js';
import { scrubWork } from '../scrubber.js';

const LOOKBACK_DAYS = 3 * 365;
const HISTORY_ROWS = `SELECT pi.carrier_id AS carrier_id, pr.code AS code, c.created_at AS created_at,
    CASE WHEN (c.remarks IS NOT NULL AND c.remarks != '') OR EXISTS (SELECT 1 FROM claim_attachments ca WHERE ca.claim_id = c.id AND ca.removed_at IS NULL
      AND ca.status != 'rejected' AND (ca.narrative IS NOT NULL OR ca.report_type = 'OZ')) THEN 1 ELSE 0 END AS narrative,
    CASE WHEN c.status = 'denied' OR EXISTS (SELECT 1 FROM claim_events e WHERE e.claim_id = c.id AND e.status = 'denied')
      OR (ci.paid_amount = 0 AND ci.estimated_amount > 0) THEN 1 ELSE 0 END AS denied
  FROM claim_items ci JOIN claims c ON c.id = ci.claim_id JOIN procedures pr ON pr.id = ci.procedure_id JOIN patient_insurance pi ON pi.id = c.patient_insurance_id
  WHERE c.practice_id = ? AND c.status IN ('paid','partially_paid','denied') AND c.primary_claim_id IS NULL AND c.created_at >= ? AND c.created_at < ?`;

// rows: { carrier_id, code, narrative, n, denied } (grouped) → rates by payer × code (× narrative), code, payer, all.
export function buildDenialStats(rows) {
  const s = { practice: { n: 0, hits: 0 }, payer: {}, code: {}, pc: {}, pcn: {} };
  const bump = (bag, key, n, d) => { const b = (bag[key] ??= { n: 0, hits: 0 }); b.n += n; b.hits += d; };
  for (const r of rows) {
    const n = Number(r.n ?? 1) || 0;
    const d = Number(r.denied) || 0;
    s.practice.n += n; s.practice.hits += d;
    bump(s.payer, r.carrier_id, n, d);
    bump(s.code, r.code, n, d);
    bump(s.pc, `${r.carrier_id}|${r.code}`, n, d);
    bump(s.pcn, `${r.carrier_id}|${r.code}|${Number(r.narrative) ? 1 : 0}`, n, d);
  }
  return s;
}

export async function practiceDenialStats(db, pid, today) {
  return cachedStats(`denial:${pid}`, today, async () => buildDenialStats(await db.all(
    `SELECT carrier_id, code, narrative, COUNT(*) AS n, SUM(denied) AS denied FROM (${HISTORY_ROWS}) t GROUP BY carrier_id, code, narrative`,
    pid, `${addDays(today, -LOOKBACK_DAYS)} 00:00:00`, `${addDays(today, 1)} 00:00:00`,
  )));
}

const HISTORY_MESSAGE = / has denied D\w+ \d+ times? before/;
// The features of one line (counts and categories; the scrubber's messages stay in `labels`, which never leave).
export function lineFeatures(stats, { carrierId, carrierName, code, narrative, risks = [] }) {
  const deny = risks.filter((r) => r.level === 'deny');
  const narr = risks.filter((r) => r.fix === 'narrative');
  const warn = risks.filter((r) => r.level === 'warn' && r.fix !== 'narrative' && !HISTORY_MESSAGE.test(r.message));
  return {
    code, practice: stats.practice, payer_stats: stats.payer[carrierId] || null, code_stats: stats.code[code] || null,
    payer_code_stats: stats.pc[`${carrierId}|${code}`] || null, narrative: narrative == null ? null : !!narrative,
    payer_code_narr_stats: narrative == null ? null : stats.pcn[`${carrierId}|${code}|${narrative ? 1 : 0}`] || null,
    rules: { deny: deny.length, narrative: narr.length, warn: warn.length },
    labels: { payer: carrierName || null, first_rule: deny[0]?.message || (narr.length ? 'no narrative attached yet' : null) },
  };
}

// items: procedures ({ id, code, tooth }); risks: the scrubber's list for them. Returns { claim, lines }: claim is the
// riskiest line's answer (with its procedure), lines one per item.
export async function denialFor(db, pid, { carrierId, carrierName, items, risks = [], hasNarrative = null, today = null }) {
  if (!items.length) return null;
  today ??= (await practiceNow(db, pid)).slice(0, 10);
  const stats = await practiceDenialStats(db, pid, today);
  const features = items.map((i) => lineFeatures(stats, { carrierId, carrierName, code: i.code, narrative: hasNarrative, risks: risks.filter((r) => r.procedure_id === i.id) }));
  const results = await getPredictor().predictMany('denial', features, { practiceId: pid });
  const lines = items.map((i, k) => ({ procedure_id: i.id, code: i.code, tooth: i.tooth ?? null, ...forScreen(results[k]) }));
  const top = lines.reduce((a, b) => (b.probability > a.probability ? b : a), lines[0]);
  return { claim: { ...top }, lines };
}

export const narrativeOf = (attachments, remarks) => attachments.some((a) => a.narrative || a.report_type === 'OZ') || !!remarks;

// A saved claim (the claim screen): its lines, the scrubber's risks for it (passed in when already worked out).
export async function claimDenial(db, claimId, risks) {
  const claim = await db.get('SELECT c.*, pi.carrier_id, ic.name AS carrier_name FROM claims c JOIN patient_insurance pi ON pi.id = c.patient_insurance_id JOIN insurance_carriers ic ON ic.id = pi.carrier_id WHERE c.id = ?', claimId);
  if (!claim) return null;
  const items = await db.all('SELECT pr.id, pr.code, pr.tooth FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ? ORDER BY pr.id', claimId);
  const attachments = await db.all("SELECT report_type, narrative FROM claim_attachments WHERE claim_id = ? AND status != 'rejected' AND removed_at IS NULL", claimId);
  return denialFor(db, claim.practice_id, { carrierId: claim.carrier_id, carrierName: claim.carrier_name, items, risks, hasNarrative: narrativeOf(attachments, claim.remarks) });
}

// Planned (or finished, unbilled) procedures of one patient, against their primary insurance: for the treatment
// plan. Null when they have no active insurance.
export async function procedureDenial(db, pid, patientId, procedureIds) {
  const policy = await db.get(
    "SELECT * FROM patient_insurance WHERE practice_id = ? AND patient_id = ? AND active = 1 ORDER BY CASE priority WHEN 'primary' THEN 0 ELSE 1 END, id LIMIT 1", pid, patientId,
  );
  if (!policy || !procedureIds.length) return null;
  const carrier = await db.get('SELECT id, name FROM insurance_carriers WHERE id = ?', policy.carrier_id);
  const items = await db.all(
    `SELECT pr.*, pc.requires_tooth, pc.requires_surface FROM procedures pr LEFT JOIN procedure_codes pc ON pc.id = pr.code_id
     WHERE pr.practice_id = ? AND pr.patient_id = ? AND pr.status != 'cancelled' AND pr.id IN (${procedureIds.map(() => '?').join(',')}) ORDER BY pr.id`,
    pid, patientId, ...procedureIds,
  );
  if (!items.length) return null;
  const risks = await scrubWork(db, { practiceId: pid, policy, items });
  // Not sent yet, so no narrative is attached yet.
  return { carrier_name: carrier?.name || null, ...(await denialFor(db, pid, { carrierId: policy.carrier_id, carrierName: carrier?.name, items, risks, hasNarrative: false })) };
}

// ---- How well it does (calibration) ----
// Claims made in the last `months` months, answered by the payer; rates learned only from claims made before that
// window. History only: the scrubber's rules can't be re-run as they stood back then, so the live answer (which adds
// them) is usually sharper than this test shows.
export async function denialAccuracy(db, pid, { months = 6, today = null } = {}) {
  today ??= (await practiceNow(db, pid)).slice(0, 10);
  const start = addDays(today, -Math.round(months * 30.44));
  const rows = await db.all(`${HISTORY_ROWS} ORDER BY c.created_at`, pid, `${addDays(start, -LOOKBACK_DAYS)} 00:00:00`, `${addDays(today, 1)} 00:00:00`);
  const before = rows.filter((r) => String(r.created_at) < `${start} 00:00:00`);
  const stats = buildDenialStats(before);
  const pairs = rows.filter((r) => String(r.created_at) >= `${start} 00:00:00`).map((r) => ({
    p: predictDenial(lineFeatures(stats, { carrierId: r.carrier_id, code: r.code, narrative: !!Number(r.narrative) })).probability,
    y: Number(r.denied) ? 1 : 0,
  }));
  return { kind: 'denial', months, from: start, to: today, trained_on: stats.practice.n, ...calibrate(pairs) };
}
