import { estimateCoverage } from './benefits.js';
import { practiceNow } from './util.js';

// Denial risks on a claim before it goes out: the payer rules this office knows about (frequencies, waiting
// periods, age limits, the missing tooth clause), filing deadlines, duplicates, missing tooth or surface,
// codes that get denied without a narrative, and what this payer has denied for these codes before.
// 'deny' is likely to be denied as it stands; 'warn' is worth a look.
const NARRATIVE = [
  [/^D2950$/, 'Build-ups are often denied without a narrative saying how much tooth structure is missing'],
  [/^D9110$/, 'Palliative treatment needs a note describing the emergency'],
  [/^D72(10|20|30|40|50)$/, 'Surgical extractions usually need a narrative (why it was surgical)'],
  [/^D434[12]$/, 'Scaling and root planing needs pocket depths (4 mm+) and a narrative'],
  [/^D0140$|^D0170$/, 'Limited exams are often denied without the chief complaint'],
  [/^D4355$/, 'Full-mouth debridement needs a narrative on why a diagnosis couldn’t be made'],
];
const REPLACEMENT = /^D27|^D62|^D67|^D5[12]|^D60/;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);

export async function scrubClaim(db, claimId) {
  const claim = await db.get('SELECT * FROM claims WHERE id = ?', claimId);
  const policy = await db.get('SELECT * FROM patient_insurance WHERE id = ?', claim.patient_insurance_id);
  const carrier = await db.get('SELECT * FROM insurance_carriers WHERE id = ?', policy.carrier_id);
  const items = await db.all(
    `SELECT ci.id AS item_id, pr.*, pc.requires_tooth, pc.requires_surface FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id
     LEFT JOIN procedure_codes pc ON pc.id = pr.code_id WHERE ci.claim_id = ? ORDER BY pr.id`, claim.id,
  );
  const attachments = await db.all("SELECT report_type, narrative FROM claim_attachments WHERE claim_id = ? AND status != 'rejected' AND removed_at IS NULL", claim.id);
  const hasNarrative = attachments.some((a) => a.narrative || a.report_type === 'OZ') || !!claim.remarks;
  const today = (await practiceNow(db, claim.practice_id)).slice(0, 10);
  const out = [];
  const add = (level, item, message) => out.push({ level, procedure_id: item?.id ?? null, code: item?.code ?? null, tooth: item?.tooth ?? null, message });

  // The payer's rules, as the estimate sees them (only the procedures on this claim, as of their dates).
  if (policy.priority === 'primary') {
    const est = await estimateCoverage(db, policy, items, { asOf: today });
    for (const e of est.items) {
      const item = items.find((i) => i.id === e.procedure_id);
      for (const note of e.notes) {
        if (/Frequency|Waiting period|Covered only|Missing tooth clause|not covered|^0% for/i.test(note)) add('deny', item, note);
      }
    }
  }
  const limit = carrier.timely_filing_days || 365;
  for (const i of items) {
    const dos = (i.completed_at || '').slice(0, 10);
    if (dos && days(dos, today) > limit) add('deny', i, `Service date ${dos} is past this payer’s ${limit}-day filing limit`);
    else if (dos && days(dos, today) > limit - 30) add('warn', i, `Only ${limit - days(dos, today)} days left to file (${limit}-day limit)`);
    if (i.requires_tooth && !i.tooth) add('deny', i, 'Tooth number is missing');
    if (i.requires_surface && !i.surfaces) add('deny', i, 'Surfaces are missing');
    for (const [re, why] of NARRATIVE) if (re.test(i.code) && !hasNarrative) add('warn', i, why);
    // A replacement within five years is usually denied without the reason.
    if (REPLACEMENT.test(i.code) && i.tooth) {
      const prior = await db.get(
        "SELECT completed_at FROM procedures WHERE patient_id = ? AND tooth = ? AND status = 'completed' AND id != ? AND code LIKE ? AND completed_at >= ? ORDER BY completed_at DESC LIMIT 1",
        i.patient_id, i.tooth, i.id, `${i.code.slice(0, 3)}%`, new Date(Date.parse(today) - 5 * 365 * 86400_000).toISOString().slice(0, 10),
      );
      if (prior && !hasNarrative) add('warn', i, `Replaces work on #${i.tooth} from ${prior.completed_at.slice(0, 10)} — payers usually need the reason (fracture, decay) and date of the original`);
    }
    // The same service already billed on another live claim.
    const dup = await db.get(
      `SELECT c.id FROM claim_items ci JOIN claims c ON c.id = ci.claim_id JOIN procedures pr ON pr.id = ci.procedure_id
       WHERE c.patient_insurance_id = ? AND c.id != ? AND c.status NOT IN ('void','denied') AND pr.code = ? AND COALESCE(pr.tooth, '') = COALESCE(?, '') AND substr(pr.completed_at, 1, 10) = ?`,
      claim.patient_insurance_id, claim.id, i.code, i.tooth, dos,
    );
    if (dup) add('deny', i, `Already billed on claim #${dup.id} — a duplicate will be denied`);
    // This payer's history with this code.
    const denied = await db.all(
      `SELECT c.denial_reason FROM claim_items ci JOIN claims c ON c.id = ci.claim_id JOIN procedures pr ON pr.id = ci.procedure_id JOIN patient_insurance pi ON pi.id = c.patient_insurance_id
       WHERE c.practice_id = ? AND pi.carrier_id = ? AND pr.code = ? AND c.status = 'denied' AND c.id != ? ORDER BY c.id DESC LIMIT 5`,
      claim.practice_id, carrier.id, i.code, claim.id,
    );
    if (denied.length) add('warn', i, `${carrier.name} has denied ${i.code} ${denied.length} time${denied.length === 1 ? '' : 's'} before${denied[0].denial_reason ? ` (last: ${denied[0].denial_reason})` : ''}`);
  }
  const seen = new Set();
  return out.filter((r) => { const k = `${r.procedure_id}|${r.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
