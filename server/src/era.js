import { HttpError } from './auth.js';
import { insert, practiceNow, recorded } from './util.js';
import { parse835All, CARC } from './x12.js';
import { postClaimPayment } from './services.js';

// Our patient control number is "DM<claim id>", or "DM<claim id>B<batch id>" when sent through the
// clearinghouse connection (so responses to an older submission can be told apart from the latest one).
export const parseControl = (controlNumber) => {
  const m = /^DM(\d+)(?:B(\d+))?$/i.exec(String(controlNumber || '').trim());
  return m ? { claimId: Number(m[1]), batchId: m[2] ? Number(m[2]) : null } : null;
};

// Finds our claim for an ERA/277 claim line — only within `practiceId` when one is given.
export async function claimForControl(db, controlNumber, practiceId = null) {
  const parsed = parseControl(controlNumber);
  return db.get(
    `SELECT * FROM claims WHERE (control_number = ? OR id = ?)${practiceId ? ' AND practice_id = ?' : ''}`,
    controlNumber, parsed ? parsed.claimId : -1, ...(practiceId ? [practiceId] : []),
  );
}

const reasonText = (codes) => codes.map((code) => ({ code, text: CARC[code.split('-')[1]] || null }));

// Posts every remittance in an 835 file. With `practiceId`, only that practice's claims are touched
// (manual uploads); without it (files from the clearinghouse mailbox), each claim line goes to the
// practice that owns the claim. Returns one result per remittance per practice.
export async function importEra(db, text, { practiceId = null, userId = null, filename = null } = {}) {
  const raw = text;
  let eras;
  try {
    eras = parse835All(text);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  const results = [];
  for (const era of eras) {
    // Route each claim line to its practice.
    const byPractice = new Map();
    const unmatched = [];
    for (const c of era.claims) {
      const claim = await claimForControl(db, c.control_number, practiceId);
      if (!claim) unmatched.push(c);
      else {
        if (!byPractice.has(claim.practice_id)) byPractice.set(claim.practice_id, []);
        byPractice.get(claim.practice_id).push(c);
      }
    }
    if (!byPractice.size && practiceId) byPractice.set(practiceId, []);
    let first = true;
    for (const [pid, claims] of byPractice) {
      // Lines we couldn't match are reported with the first practice's import (manual uploads: that practice).
      const lines = first ? [...claims, ...unmatched] : claims;
      first = false;
      try {
        results.push(await postEra(db, pid, { ...era, claims: lines }, { userId, filename, raw }));
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) results.push({ practice_id: pid, duplicate: true, check_number: era.check_number, error: err.message, claims: [] });
        else throw err;
      }
    }
    if (!byPractice.size) results.push({ practice_id: null, check_number: era.check_number, total_paid: era.total_paid, claims: unmatched.map((c) => ({ control_number: c.control_number, result: 'unmatched' })) });
  }
  return results;
}

// Posts one remittance for one practice.
export async function postEra(db, practiceId, era, { userId = null, filename = null, raw = null } = {}) {
  if (era.check_number && (await db.get('SELECT id FROM era_imports WHERE practice_id = ? AND check_number = ? AND total_paid = ?', practiceId, era.check_number, era.total_paid))) {
    throw new HttpError(409, `ERA for check/EFT ${era.check_number} was already imported`);
  }
  const date = era.payment_date || (await practiceNow(db, practiceId)).slice(0, 10);
  // A payer can split one claim into several lines; they're posted together.
  const groups = new Map();
  const details = [];
  for (const [order, c] of era.claims.entries()) {
    const claim = await claimForControl(db, c.control_number, practiceId);
    const base = { order, control_number: c.control_number, billed: c.billed, paid: c.paid, patient_responsibility: c.patient_responsibility, write_off: c.contractual, reasons: reasonText(c.reason_codes) };
    if (!claim) details.push({ ...base, result: 'unmatched' });
    else {
      if (!groups.has(claim.id)) groups.set(claim.id, { claim, lines: [] });
      groups.get(claim.id).lines.push({ c, base });
    }
  }
  const id = await db.tx(async () => {
    // The check (or EFT) itself, so the deposit and each claim's payment can be traced to it.
    const checkId = await insert(db, 'insurance_checks', {
      practice_id: practiceId, payer_name: era.payer_name, check_number: era.check_number, check_date: era.payment_date || date,
      amount: era.total_paid, method: 'eft', provider_adjustments: era.provider_adjustments?.length ? JSON.stringify(era.provider_adjustments) : null, created_by: userId,
    });
    for (const { claim: found, lines } of groups.values()) {
      const merged = {
        order: lines[0].base.order, control_number: found.control_number, claim_id: found.id,
        billed: lines.reduce((s, l) => s + l.c.billed, 0), paid: lines.reduce((s, l) => s + l.c.paid, 0),
        patient_responsibility: lines.reduce((s, l) => s + l.c.patient_responsibility, 0),
        reasons: reasonText([...new Set(lines.flatMap((l) => l.c.reason_codes))]),
      };
      // Everything the payer didn't pay and the patient doesn't owe is written off (CO, PI and OA alike).
      merged.write_off = Math.max(0, merged.billed - merged.paid - merged.patient_responsibility);
      if (lines.some((l) => l.c.status === 'reversal' || l.c.status === 'not_our_claim')) {
        details.push({ ...merged, result: 'needs_review', note: 'Reversal or claim the payer says isn\'t ours' });
        continue;
      }
      // Lock the claim row (Postgres) and make sure it's still open, so two imports can't both post it.
      const open = await db.run("UPDATE claims SET status = status WHERE id = ? AND status IN ('submitted','partially_paid','denied')", found.id);
      if (!open.changes) {
        details.push({ ...merged, result: `skipped (claim is ${(await db.get('SELECT status FROM claims WHERE id = ?', found.id)).status})` });
        continue;
      }
      const claim = await db.get('SELECT * FROM claims WHERE id = ?', found.id);
      const denied = lines.every((l) => l.c.status === 'denied' || (l.c.paid === 0 && l.c.status_code === '4'));
      if (denied) {
        const reason = merged.reasons.map((x) => `${x.code}${x.text ? ` ${x.text}` : ''}`).join(', ') || 'Denied by payer';
        // "Duplicate claim" usually means the payer is still working on the original — don't close it.
        if (merged.reasons.some((x) => x.code.endsWith('-18'))) {
          details.push({ ...merged, result: 'needs_review', note: 'Payer reports a duplicate claim; the original may still pay' });
          await claimEvent(db, claim, '835', 'request', `Payer says duplicate claim (${reason}) — check before resending`);
          continue;
        }
        await recorded(db, 'claims', claim.id, () => db.run("UPDATE claims SET status = 'denied', denial_reason = ?, payer_claim_number = COALESCE(?, payer_claim_number) WHERE id = ?", reason, lines[0].c.payer_claim_number, claim.id));
        await claimEvent(db, claim, '835', 'denied', `Denied: ${reason}`);
        details.push({ ...merged, result: 'denied' });
        continue;
      }
      await postClaimPayment(db, claim, {
        amount: merged.paid, writeOff: merged.write_off, final: true, method: 'eft', reference: era.check_number, userId, date, payerClaimNumber: lines[0].c.payer_claim_number,
        deductible: lines.reduce((s, l) => s + (l.c.deductible || 0), 0), checkId,
        // Service lines, when the payer sent them, so each procedure's payment is known.
        lines: lines.flatMap((l) => l.c.services).map((sv) => ({ code: sv.code, billed: sv.billed, paid: sv.paid, patient_resp: sv.patient_resp, write_off: sv.write_off, adjustments: sv.adjustments })),
      });
      const splitNote = lines.length > 1 ? ` across ${lines.length} lines` : '';
      await claimEvent(db, claim, '835', 'paid', `Paid $${(merged.paid / 100).toFixed(2)}${merged.write_off ? `, $${(merged.write_off / 100).toFixed(2)} written off` : ''}${splitNote} (EFT ${era.check_number || '—'})`);
      details.push({ ...merged, result: 'posted' });
    }
    // Report lines in file order. The import record is written with the postings, so a failure can't
    // leave payments posted without the record that stops the same ERA being posted again.
    details.sort((a, b) => a.order - b.order);
    for (const d of details) delete d.order;
    const matched = details.filter((d) => d.result === 'posted' || d.result === 'denied').length;
    const importId = await insert(db, 'era_imports', {
      practice_id: practiceId, filename: filename ? String(filename).slice(0, 200) : null, payer_name: era.payer_name, check_number: era.check_number,
      payment_date: era.payment_date, total_paid: era.total_paid, claims_matched: matched, claims_unmatched: details.length - matched,
      details: JSON.stringify(details), raw, created_by: userId,
      provider_adjustments: era.provider_adjustments?.length ? JSON.stringify(era.provider_adjustments) : null,
    });
    await db.run('UPDATE insurance_checks SET era_import_id = ? WHERE id = ?', importId, checkId);
    return importId;
  });
  return { id, practice_id: practiceId, payer_name: era.payer_name, check_number: era.check_number, payment_date: era.payment_date, total_paid: era.total_paid, claims: details, provider_adjustments: era.provider_adjustments || [] };
}

// Timeline entry for a claim's electronic journey, and its latest status on the claim itself.
export async function claimEvent(db, claim, source, status, message) {
  await insert(db, 'claim_events', { practice_id: claim.practice_id, claim_id: claim.id, source, status, message: message ? String(message).slice(0, 500) : null });
  await db.run("UPDATE claims SET ch_status = ?, ch_message = ?, ch_updated_at = datetime('now') WHERE id = ?", status, message ? String(message).slice(0, 500) : null, claim.id);
}
