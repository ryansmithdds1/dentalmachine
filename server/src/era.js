import { HttpError } from './auth.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { insert, practiceNow } from './util.js';
import { parse835All } from './x12.js';
import { stageRemittance, stageCheckLevel, eraLine, raiseImportIssue } from './eobauto.js';

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

// Posts one remittance for one practice. Each claim in it is judged by the autopilot rule (eobauto.js): a
// claim that reconciles exactly posts at once when a person imported the file (as that person) or the practice
// turned auto-posting on (as the automation); otherwise it waits as ready to post. Anything else — denials,
// under- and overpayments, reversals, lines matching no claim — becomes an exception on the insurance worklist.
export async function postEra(db, practiceId, era, { userId = null, filename = null, raw = null } = {}) {
  if (era.check_number && (await db.get('SELECT id FROM era_imports WHERE practice_id = ? AND check_number = ? AND total_paid = ?', practiceId, era.check_number, era.total_paid))) {
    throw new HttpError(409, `ERA for check/EFT ${era.check_number} was already imported`);
  }
  const date = era.payment_date || (await practiceNow(db, practiceId)).slice(0, 10);
  const id = await db.tx(async () => {
    // The check (or EFT) itself, so the deposit and each claim's payment can be traced to it.
    const checkId = await insert(db, 'insurance_checks', {
      practice_id: practiceId, payer_name: era.payer_name, check_number: era.check_number, check_date: era.payment_date || date,
      amount: era.total_paid, method: 'eft', provider_adjustments: era.provider_adjustments?.length ? JSON.stringify(era.provider_adjustments) : null, created_by: userId,
    });
    // The import record is written in the same transaction as the postings, so a failure can't leave payments
    // posted without the record that stops the same ERA being posted again.
    const importId = await insert(db, 'era_imports', {
      practice_id: practiceId, filename: filename ? String(filename).slice(0, 200) : null, payer_name: era.payer_name, check_number: era.check_number,
      payment_date: era.payment_date, total_paid: era.total_paid, claims_matched: 0, claims_unmatched: 0, details: '[]', raw, created_by: userId,
      provider_adjustments: era.provider_adjustments?.length ? JSON.stringify(era.provider_adjustments) : null,
    });
    await db.run('UPDATE insurance_checks SET era_import_id = ? WHERE id = ?', importId, checkId);
    const details = await stageRemittance(db, practiceId, {
      source: 'era', lines: era.claims.map(eraLine), trace: era.check_number, payerName: era.payer_name, eraImportId: importId, checkId, date, userId,
      claimFor: (l) => claimForControl(db, l.control_number, practiceId),
    });
    await stageCheckLevel(db, practiceId, {
      source: 'era', trace: era.check_number, payerName: era.payer_name, total: era.total_paid, paidLines: era.claims.reduce((s, c) => s + c.paid, 0),
      adjustments: era.provider_adjustments || [], eraImportId: importId, checkId,
    });
    const matched = details.filter((d) => d.result === 'posted' || d.result === 'denied').length;
    await db.run('UPDATE era_imports SET details = ?, claims_matched = ?, claims_unmatched = ? WHERE id = ?', JSON.stringify(details), matched, details.length - matched, importId);
    const review = Number((await db.get("SELECT COUNT(*) AS n FROM remit_lines WHERE era_import_id = ? AND state = 'exception'", importId)).n);
    await raiseImportIssue(db, practiceId, { key: `era:${importId}`, entity: 'era_imports', entityId: importId, title: `ERA ${era.check_number || ''} from ${era.payer_name || 'the payer'}`, count: review });
    return { importId, details };
  });
  return { id: id.importId, practice_id: practiceId, payer_name: era.payer_name, check_number: era.check_number, payment_date: era.payment_date, total_paid: era.total_paid, claims: id.details, provider_adjustments: era.provider_adjustments || [] };
}

// Timeline entry for a claim's electronic journey, and its latest status on the claim itself.
export async function claimEvent(db, claim, source, status, message) {
  await insert(db, 'claim_events', { practice_id: claim.practice_id, claim_id: claim.id, source, status, message: message ? String(message).slice(0, 500) : null });
  // A rejection, denial or payer question needs someone in billing; it's closed when the claim moves on.
  const key = `claim:${claim.id}`;
  if (['rejected', 'denied', 'request'].includes(status)) {
    const who = await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', claim.patient_id);
    await raiseIssue(db, {
      practiceId: claim.practice_id, kind: 'claim', key, role: 'billing', severity: status === 'request' ? 'normal' : 'high', entity: 'claims', entityId: claim.id, patientId: claim.patient_id,
      title: `Claim #${claim.id}${who ? ` (${who.first_name} ${who.last_name})` : ''} ${status === 'rejected' ? 'was rejected' : status === 'denied' ? 'was denied' : 'needs a look'}`, detail: message,
    });
  } else if (['sent', 'accepted', 'paid'].includes(status)) await resolveIssue(db, claim.practice_id, key, `Resolved: claim ${status}`);
  await db.run("UPDATE claims SET ch_status = ?, ch_message = ?, ch_updated_at = datetime('now') WHERE id = ?", status, message ? String(message).slice(0, 500) : null, claim.id);
}
