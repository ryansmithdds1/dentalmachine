import { HttpError } from './auth.js';
import { insert, practiceNow, recorded } from './util.js';
import { benefitYear, deductibleMet, estimateCoverage } from './benefits.js';
import { resetRecalls } from './recalls.js';
import { applyMemberBenefit } from './memberships.js';
import { useSupplies } from './inventory.js';

export { benefitYear, deductibleMet, benefitsUsed, estimateCoverage, withPlan, planFor } from './benefits.js';

export async function patientBalance(db, practiceId, patientId) {
  return (await db.get(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_entries WHERE practice_id = ? AND patient_id = ?',
    practiceId, patientId,
  )).balance;
}

// What an account still expects from insurance: the payers' remaining estimates on open claims, and the
// in-network (PPO) write-offs that will be posted when those claims pay. Balance minus both is what the
// patient owes; the ledger, statements and portal all use this so they agree.
export async function pendingInsurance(db, practiceId, patientIds) {
  const ids = [].concat(patientIds);
  if (!ids.length) return { insurance: 0, write_off: 0, total: 0 };
  const row = await db.get(
    `SELECT COALESCE(SUM(CASE WHEN estimated_amount > paid_amount THEN estimated_amount - paid_amount ELSE 0 END), 0) AS insurance,
       COALESCE(SUM(CASE WHEN status IN ('draft','submitted') THEN write_off_estimate ELSE 0 END), 0) AS write_off
     FROM claims WHERE practice_id = ? AND patient_id IN (${ids.map(() => '?').join(',')}) AND status IN ('draft','submitted','partially_paid')`,
    practiceId, ...ids,
  );
  return { insurance: row.insurance, write_off: row.write_off, total: row.insurance + row.write_off };
}

export async function primaryPolicy(db, practiceId, patientId) {
  return await db.get(
    `SELECT pi.*, c.name AS carrier_name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id
     WHERE pi.practice_id = ? AND pi.patient_id = ? AND pi.active = 1
     ORDER BY CASE pi.priority WHEN 'primary' THEN 0 ELSE 1 END LIMIT 1`,
    practiceId, patientId,
  );
}

// Extractions (D7111-D7250): the tooth is charted missing once the extraction is done.
export const isExtraction = (code) => /^D7(1[1-4]\d|2[0-5]\d)$/.test(String(code || ''));

export async function completeProcedure(db, user, procedure, { providerId, appointmentId, locationId = null } = {}) {
  if (procedure.status === 'completed') throw new HttpError(409, 'Procedure already completed');
  if (procedure.status === 'cancelled') throw new HttpError(409, 'Cancelled procedures cannot be completed');
  const provider = providerId ?? procedure.provider_id;
  if (!provider) throw new HttpError(400, 'A provider is required to complete a procedure');
  const today = (await practiceNow(db, procedure.practice_id)).slice(0, 10);
  // Production counts at the office of the visit, else where the procedure was entered.
  // A visit named by the caller must be this patient's, in this practice.
  if (appointmentId != null && !(await db.get('SELECT id FROM appointments WHERE id = ? AND practice_id = ? AND patient_id = ?', Number(appointmentId), procedure.practice_id, procedure.patient_id))) {
    throw new HttpError(404, 'Appointment not found');
  }
  const visit = appointmentId ?? procedure.appointment_id;
  const location = (visit && (await db.get('SELECT location_id FROM appointments WHERE id = ? AND practice_id = ?', visit, procedure.practice_id))?.location_id) || locationId;

  await db.tx(async () => {
    await recorded(db, 'procedures', procedure.id, () => db.run(
      `UPDATE procedures SET status = 'completed', completed_at = datetime('now'), provider_id = ?, appointment_id = COALESCE(?, appointment_id)
       WHERE id = ?`,
      provider, appointmentId ?? null, procedure.id,
    ));
    await insert(db, 'ledger_entries', {
      practice_id: procedure.practice_id,
      patient_id: procedure.patient_id,
      type: 'charge',
      amount: procedure.fee,
      description: `${procedure.code} ${procedure.description}${procedure.tooth ? ` #${procedure.tooth}` : ''}${procedure.surfaces ? ` ${procedure.surfaces}` : ''}${procedure.area ? ` ${procedure.area}` : ''}`,
      procedure_id: procedure.id,
      provider_id: provider,
      location_id: location ?? null,
      entry_date: today,
      created_by: user.id,
    });

    await useSupplies(db, procedure, { userId: user.id, today });

    if (isExtraction(procedure.code) && procedure.tooth) {
      await insert(db, 'tooth_conditions', {
        practice_id: procedure.practice_id, patient_id: procedure.patient_id, tooth: procedure.tooth, condition: 'missing',
        notes: `Extracted (${procedure.code})`, recorded_by: user.id, procedure_id: procedure.id,
      });
    }

    await resetRecalls(db, procedure, today);

    // Membership plan benefits (included services, or the member discount) come off the patient's share.
    // A treatment plan discount applies instead when there's no membership benefit; the two don't stack.
    const plan = procedure.treatment_plan_id ? await db.get('SELECT name, discount_pct FROM treatment_plans WHERE id = ?', procedure.treatment_plan_id) : null;
    const share = async () => (await estimateCoverage(db, await primaryPolicy(db, procedure.practice_id, procedure.patient_id), [procedure])).items[0].patient;
    const member = await applyMemberBenefit(db, procedure, await share(), { date: today, userId: user.id, providerId: provider });
    if (!member && plan?.discount_pct > 0) {
      const off = Math.round(((await share()) * plan.discount_pct) / 100);
      if (off > 0) {
        await insert(db, 'ledger_entries', {
          practice_id: procedure.practice_id, patient_id: procedure.patient_id, type: 'adjustment', adjustment_type: 'Treatment plan discount', amount: -off,
          description: `${plan.discount_pct}% treatment plan discount — ${procedure.code}${procedure.tooth ? ` #${procedure.tooth}` : ''}`,
          procedure_id: procedure.id, provider_id: provider, location_id: location ?? null, entry_date: today, created_by: user.id,
        });
      }
    }

    // Close out the treatment plan once nothing remains planned.
    if (procedure.treatment_plan_id) {
      const remaining = (await db.get("SELECT COUNT(*) AS n FROM procedures WHERE treatment_plan_id = ? AND status = 'planned'", procedure.treatment_plan_id)).n;
      if (remaining === 0) await recorded(db, 'treatment_plans', procedure.treatment_plan_id, () => db.run("UPDATE treatment_plans SET status = 'completed' WHERE id = ?", procedure.treatment_plan_id));
    }
  });
}

// Posts an insurance payment (and optional contractual write-off) against a claim.
export async function postClaimPayment(
  db,
  claim,
  { amount, writeOff = 0, final = true, method = 'check', reference = null, userId = null, date, payerClaimNumber = null, deductible = null, lines = null, checkId = null }
) {
  const carrier = await db.get('SELECT ic.name FROM patient_insurance pi JOIN insurance_carriers ic ON ic.id = pi.carrier_id WHERE pi.id = ?', claim.patient_insurance_id);
  await db.tx(async () => {
    if (amount > 0) {
      await insert(db, 'ledger_entries', {
        practice_id: claim.practice_id, patient_id: claim.patient_id, type: 'insurance_payment', amount: -amount,
        description: `Insurance payment - ${carrier.name} (claim #${claim.id})`, method, reference, claim_id: claim.id, entry_date: date, created_by: userId,
        insurance_check_id: checkId,
      });
    }
    if (writeOff > 0) {
      await insert(db, 'ledger_entries', {
        practice_id: claim.practice_id, patient_id: claim.patient_id, type: 'adjustment', amount: -writeOff, adjustment_type: 'Insurance write-off',
        description: `Insurance write-off - ${carrier.name} (claim #${claim.id})`, claim_id: claim.id, entry_date: date, created_by: userId,
        insurance_check_id: checkId,
      });
    }
    await postClaimLines(db, claim, { amount, writeOff, lines });
    // Only an open claim takes a payment; a concurrent post rolls this one back instead of doubling it.
    const updated = await recorded(db, 'claims', claim.id, () => db.run(
      "UPDATE claims SET paid_amount = paid_amount + ?, status = ?, paid_at = datetime('now'), denial_reason = NULL, payer_claim_number = COALESCE(?, payer_claim_number) WHERE id = ? AND status IN ('submitted','partially_paid','denied')",
      amount, final ? 'paid' : 'partially_paid', payerClaimNumber, claim.id,
    ));
    if (!updated.changes) throw new HttpError(409, `Claim #${claim.id} is no longer open for payment`);
    // The first payment on a claim counts toward the deductible: what the payer says it applied (835 PR-1),
    // or else what we estimated. It goes to the benefit year of the date of service.
    const applied = deductible ?? (claim.status === 'submitted' ? claim.deductible_applied : 0);
    if (claim.status === 'submitted' && applied > 0) {
      const policy = await db.get('SELECT * FROM patient_insurance WHERE id = ?', claim.patient_insurance_id);
      const dos = (await db.get('SELECT MIN(pr.completed_at) AS d FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ?', claim.id)).d?.slice(0, 10) || date;
      const { start } = benefitYear(policy, dos);
      const current = benefitYear(policy, date).start;
      // Only this benefit year's deductible is tracked; a late payment for last year's visit doesn't count.
      if (start === current) {
        const met = Math.min(policy.deductible, deductibleMet(policy, date) + applied);
        await recorded(db, 'patient_insurance', policy.id, () => db.run('UPDATE patient_insurance SET deductible_met = ?, deductible_year = ? WHERE id = ?', met, start, policy.id));
      }
    }
    await db.run('UPDATE claims SET paid_date = ? WHERE id = ?', date, claim.id);
  });
  if (final) await createSecondaryClaim(db, claim.id, { userId }).catch(() => null);
}

// Records what a payment paid per procedure: the payer's own lines (835 service lines or an EOB entered
// line by line), or else the amounts shared across the claim's procedures by their estimates.
async function postClaimLines(db, claim, { amount, writeOff, lines }) {
  const items = await db.all('SELECT ci.*, pr.code FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ? ORDER BY ci.id', claim.id);
  if (!items.length) return;
  const byItem = new Map();
  if (lines?.length) {
    const unused = [...items];
    for (const l of lines) {
      const i = l.claim_item_id ? unused.findIndex((x) => x.id === l.claim_item_id)
        : l.procedure_id ? unused.findIndex((x) => x.procedure_id === l.procedure_id)
          : Math.max(unused.findIndex((x) => x.code === l.code && x.fee === l.billed), unused.findIndex((x) => x.code === l.code));
      if (i < 0) continue;
      byItem.set(unused[i].id, l);
      unused.splice(i, 1);
    }
  }
  const share = (total, key) => {
    const weights = items.map((x) => (key === 'paid' ? x.estimated_amount || x.fee : x.write_off || x.fee));
    const sumW = weights.reduce((s, w) => s + w, 0) || 1;
    let left = total;
    return items.map((x, i) => {
      const part = i === items.length - 1 ? left : Math.round((total * weights[i]) / sumW);
      left -= part;
      return part;
    });
  };
  const paidParts = share(amount, 'paid');
  const woParts = share(writeOff, 'write_off');
  for (const [i, x] of items.entries()) {
    const l = byItem.get(x.id);
    const paid = l ? l.paid || 0 : byItem.size ? 0 : paidParts[i];
    const adjusted = l ? l.write_off || 0 : byItem.size ? 0 : woParts[i];
    await db.run(
      'UPDATE claim_items SET paid_amount = paid_amount + ?, adjusted_amount = adjusted_amount + ?, patient_resp = ?, allowed_amount = COALESCE(?, allowed_amount), adjustments = COALESCE(?, adjustments) WHERE id = ?',
      paid, adjusted, l?.patient_resp ?? x.patient_resp, l?.allowed ?? null, l?.adjustments ? JSON.stringify(l.adjustments) : null, x.id,
    );
  }
}

// Creates a claim for completed procedures on one policy, with the estimate. For a secondary policy the
// estimate covers what the primary leaves (from the primary claim's payment when it has paid).
export async function createClaim(db, { practiceId, policyId, procedureIds, userId = null, extra = {} }) {
  const policy = await db.get('SELECT * FROM patient_insurance WHERE id = ? AND practice_id = ?', policyId, practiceId);
  if (!policy) throw new HttpError(404, 'Policy not found');
  if (!Array.isArray(procedureIds) || !procedureIds.length) throw new HttpError(400, 'procedure_ids is required');
  const procs = [];
  for (const id of procedureIds) {
    const p = await db.get('SELECT * FROM procedures WHERE id = ? AND practice_id = ?', Number(id), practiceId);
    if (!p) throw new HttpError(404, 'Procedure not found');
    if (p.patient_id !== policy.patient_id) throw new HttpError(400, `Procedure ${p.id} belongs to another patient`);
    if (p.status !== 'completed') throw new HttpError(400, `Procedure ${p.id} is not completed`);
    const onClaim = await db.get("SELECT c.id FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE ci.procedure_id = ? AND c.status != 'void' AND c.patient_insurance_id = ?", p.id, policy.id);
    if (onClaim) throw new HttpError(409, `Procedure ${p.id} is already on claim ${onClaim.id} for this insurance`);
    procs.push(p);
  }
  let primary = null;
  let primaryClaimId = null;
  if (policy.priority === 'secondary') {
    primary = new Map();
    for (const p of procs) {
      const line = await db.get(
        `SELECT ci.*, c.id AS claim_id, c.status AS claim_status, c.paid_amount AS claim_paid, c.estimated_amount AS claim_estimated, c.total_fee AS claim_fee
         FROM claim_items ci JOIN claims c ON c.id = ci.claim_id JOIN patient_insurance pi ON pi.id = c.patient_insurance_id
         WHERE ci.procedure_id = ? AND c.status != 'void' AND pi.priority = 'primary' ORDER BY c.id DESC LIMIT 1`, p.id,
      );
      if (!line) continue;
      primaryClaimId ??= line.claim_id;
      const paidClaim = ['paid', 'partially_paid'].includes(line.claim_status);
      // Prefer what the payer paid on this line; otherwise share the claim payment by estimate.
      const lineKnown = paidClaim && (line.paid_amount > 0 || line.adjusted_amount > 0);
      const share = line.claim_estimated > 0 ? line.estimated_amount / line.claim_estimated : line.fee / (line.claim_fee || 1);
      primary.set(p.id, {
        covered: lineKnown ? line.paid_amount : paidClaim ? Math.round(line.claim_paid * share) : line.estimated_amount,
        write_off: lineKnown ? line.adjusted_amount : line.write_off,
      });
    }
  }
  const carrier = await db.get('SELECT name FROM insurance_carriers WHERE id = ?', policy.carrier_id);
  const est = await estimateCoverage(db, { ...policy, carrier_name: carrier.name }, procs, { primary });
  return db.tx(async () => {
    const claimId = await insert(db, 'claims', {
      practice_id: practiceId, patient_id: policy.patient_id, patient_insurance_id: policy.id,
      total_fee: est.total_fee, estimated_amount: est.total_insurance, deductible_applied: est.total_deductible, write_off_estimate: est.total_write_off,
      primary_claim_id: primaryClaimId, ...extra,
    });
    for (const item of est.items) {
      await insert(db, 'claim_items', { claim_id: claimId, procedure_id: item.procedure_id, fee: item.fee, estimated_amount: item.insurance, write_off: item.write_off });
    }
    return claimId;
  });
}

// Once the primary has paid, the secondary claim for the same work is drafted automatically.
export async function createSecondaryClaim(db, primaryClaimId, { userId = null } = {}) {
  const claim = await db.get('SELECT c.*, pi.priority FROM claims c JOIN patient_insurance pi ON pi.id = c.patient_insurance_id WHERE c.id = ?', primaryClaimId);
  if (!claim || claim.priority !== 'primary' || !['paid', 'partially_paid'].includes(claim.status)) return null;
  const secondary = await db.get("SELECT * FROM patient_insurance WHERE patient_id = ? AND priority = 'secondary' AND active = 1 ORDER BY id LIMIT 1", claim.patient_id);
  if (!secondary) return null;
  const procIds = (await db.all(
    `SELECT ci.procedure_id FROM claim_items ci WHERE ci.claim_id = ?
     AND NOT EXISTS (SELECT 1 FROM claim_items x JOIN claims c2 ON c2.id = x.claim_id WHERE x.procedure_id = ci.procedure_id AND c2.patient_insurance_id = ? AND c2.status != 'void')`,
    claim.id, secondary.id,
  )).map((r) => r.procedure_id);
  if (!procIds.length) return null;
  return createClaim(db, { practiceId: claim.practice_id, policyId: secondary.id, procedureIds: procIds, userId });
}

// Posting dates: nothing on or before the practice's lock date (closed books), nothing in the future.
export async function checkPostingDate(db, practiceId, date) {
  const today = (await practiceNow(db, practiceId)).slice(0, 10);
  if (!date) return today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new HttpError(400, 'entry_date must be YYYY-MM-DD');
  if (date > today) throw new HttpError(400, "Entries can't be dated in the future");
  const lock = (await db.get('SELECT lock_date FROM practices WHERE id = ?', practiceId))?.lock_date;
  if (lock && date <= lock) throw new HttpError(400, `The books are closed through ${lock} — date it after that, or ask an administrator to move the lock date`);
  return date;
}

// Reverses a ledger entry. The original stays (marked void) and an equal and opposite entry of the same
// type is posted today, so past day sheets and closed periods never change.
export async function reverseEntry(db, entry, { userId, reason, date }) {
  if (entry.reverses_id) throw new HttpError(409, "A reversal can't itself be voided");
  const marked = await recorded(db, 'ledger_entries', entry.id, () => db.run("UPDATE ledger_entries SET voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL", userId ?? null, reason, entry.id));
  if (!marked.changes) throw new HttpError(409, 'That entry was already voided');
  return insert(db, 'ledger_entries', {
    practice_id: entry.practice_id, patient_id: entry.patient_id, type: entry.type, amount: -entry.amount,
    description: `Void: ${entry.description}`.slice(0, 300), method: entry.method, reference: entry.reference,
    procedure_id: entry.procedure_id, claim_id: entry.claim_id, provider_id: entry.provider_id, payment_plan_id: entry.payment_plan_id, location_id: entry.location_id,
    adjustment_type: entry.adjustment_type ?? null, entry_date: date, created_by: userId ?? null, reverses_id: entry.id,
  });
}

// Voids a patient-side ledger entry. Voiding a procedure's charge un-completes the procedure (back to
// planned, off production); insurance entries are undone by reopening their claim instead.
export async function voidLedgerEntry(db, entry, { userId, reason }) {
  if (!String(reason || '').trim()) throw new HttpError(400, 'Give a reason for the void');
  if (entry.voided_at) throw new HttpError(409, 'That entry was already voided');
  if (entry.reverses_id) throw new HttpError(409, "A reversal can't itself be voided");
  if (entry.claim_id) throw new HttpError(409, `This came from insurance claim #${entry.claim_id} — reopen the claim to undo it`);
  const date = (await practiceNow(db, entry.practice_id)).slice(0, 10);
  return db.tx(async () => {
    if (entry.type === 'charge' && entry.procedure_id) {
      const claim = await db.get("SELECT c.id FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE ci.procedure_id = ? AND c.status != 'void'", entry.procedure_id);
      if (claim) throw new HttpError(409, `The procedure is on claim #${claim.id} — void that claim first`);
      await recorded(db, 'procedures', entry.procedure_id, () => db.run("UPDATE procedures SET status = 'planned', completed_at = NULL WHERE id = ? AND status = 'completed'", entry.procedure_id));
      await db.run('DELETE FROM tooth_conditions WHERE procedure_id = ?', entry.procedure_id);
      // The plan discount given for it goes too.
      const discounts = await db.all("SELECT * FROM ledger_entries WHERE procedure_id = ? AND adjustment_type = 'Treatment plan discount' AND voided_at IS NULL AND reverses_id IS NULL", entry.procedure_id);
      for (const d of discounts) await reverseEntry(db, d, { userId, reason: 'Procedure charge voided', date });
    }
    return reverseEntry(db, entry, { userId, reason: String(reason).trim().slice(0, 300), date });
  });
}
