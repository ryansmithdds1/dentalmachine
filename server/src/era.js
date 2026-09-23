import { HttpError } from './auth.js';
import { insert, practiceNow, mapSeq } from './util.js';
import { parse835, CARC } from './x12.js';
import { postClaimPayment } from './services.js';

// Finds our claim for an ERA/277 claim line: the patient control number we sent is "DM<claim id>".
export async function claimForControl(db, controlNumber, practiceId = null) {
  const idMatch = /^DM(\d+)$/i.exec(controlNumber || '');
  return db.get(
    `SELECT * FROM claims WHERE (control_number = ? OR id = ?)${practiceId ? ' AND practice_id = ?' : ''}`,
    controlNumber, idMatch ? Number(idMatch[1]) : -1, ...(practiceId ? [practiceId] : []),
  );
}

// Which practice an 835 belongs to (for files picked up automatically from a shared clearinghouse mailbox).
export async function practiceForEra(db, text) {
  const era = parse835(text);
  for (const c of era.claims) {
    const claim = await claimForControl(db, c.control_number);
    if (claim) return claim.practice_id;
  }
  return null;
}

// Posts an 835: payments, contractual write-offs and denials go to the matching claims and ledgers.
export async function postEra(db, practiceId, text, { userId = null, filename = null } = {}) {
  let era;
  try {
    era = parse835(text);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  if (era.check_number && (await db.get('SELECT id FROM era_imports WHERE practice_id = ? AND check_number = ? AND total_paid = ?', practiceId, era.check_number, era.total_paid))) {
    throw new HttpError(409, `ERA for check/EFT ${era.check_number} was already imported`);
  }
  const date = era.payment_date || (await practiceNow(db, practiceId)).slice(0, 10);
  const details = await db.tx(() => mapSeq(era.claims, async (c) => {
    const claim = await claimForControl(db, c.control_number, practiceId);
    const base = { control_number: c.control_number, billed: c.billed, paid: c.paid, patient_responsibility: c.patient_responsibility, write_off: c.contractual, reasons: c.reason_codes.map((code) => ({ code, text: CARC[code.split('-')[1]] || null })) };
    if (!claim) return { ...base, result: 'unmatched' };
    if (c.status === 'reversal' || c.status === 'not_our_claim') return { ...base, claim_id: claim.id, result: 'needs_review' };
    if (!['submitted', 'partially_paid'].includes(claim.status)) return { ...base, claim_id: claim.id, result: `skipped (claim is ${claim.status})` };
    if (c.status === 'denied' || (c.paid === 0 && c.status_code === '4')) {
      const reason = base.reasons.map((x) => `${x.code}${x.text ? ` ${x.text}` : ''}`).join(', ') || 'Denied by payer';
      await db.run("UPDATE claims SET status = 'denied', denial_reason = ?, payer_claim_number = COALESCE(?, payer_claim_number) WHERE id = ?", reason, c.payer_claim_number, claim.id);
      await claimEvent(db, claim, '835', 'denied', `Denied: ${reason}`);
      return { ...base, claim_id: claim.id, result: 'denied' };
    }
    await postClaimPayment(db, claim, {
      amount: c.paid, writeOff: c.contractual, final: true, method: 'eft', reference: era.check_number, userId, date, payerClaimNumber: c.payer_claim_number,
    });
    await claimEvent(db, claim, '835', 'paid', `Paid $${(c.paid / 100).toFixed(2)}${c.contractual ? `, $${(c.contractual / 100).toFixed(2)} written off` : ''} (EFT ${era.check_number || '—'})`);
    return { ...base, claim_id: claim.id, result: 'posted' };
  }));
  const matched = details.filter((d) => d.result === 'posted' || d.result === 'denied').length;
  const id = await insert(db, 'era_imports', {
    practice_id: practiceId, filename: filename ? String(filename).slice(0, 200) : null, payer_name: era.payer_name, check_number: era.check_number,
    payment_date: era.payment_date, total_paid: era.total_paid, claims_matched: matched, claims_unmatched: details.length - matched,
    details: JSON.stringify(details), raw: text, created_by: userId,
  });
  return { id, payer_name: era.payer_name, check_number: era.check_number, payment_date: era.payment_date, total_paid: era.total_paid, claims: details };
}

// Timeline entry for a claim's electronic journey, and its latest status on the claim itself.
export async function claimEvent(db, claim, source, status, message) {
  await insert(db, 'claim_events', { practice_id: claim.practice_id, claim_id: claim.id, source, status, message: message ? String(message).slice(0, 500) : null });
  await db.run("UPDATE claims SET ch_status = ?, ch_message = ?, ch_updated_at = datetime('now') WHERE id = ?", status, message ? String(message).slice(0, 500) : null, claim.id);
}
