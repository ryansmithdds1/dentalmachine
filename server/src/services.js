import { HttpError } from './auth.js';
import { coverageTier } from './defaults.js';
import { insert, addMonths, practiceNow, mapSeq } from './util.js';

export async function patientBalance(db, practiceId, patientId) {
  return (await db.get(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_entries WHERE practice_id = ? AND patient_id = ?',
    practiceId, patientId,
  )).balance;
}

// A plan's benefit year starts on the first of `benefit_month` (1 = calendar year).
export function benefitYear(policy, date) {
  const month = Math.min(12, Math.max(1, Number(policy?.benefit_month) || 1));
  let year = Number(date.slice(0, 4));
  if (Number(date.slice(5, 7)) < month) year -= 1;
  const mm = String(month).padStart(2, '0');
  return { start: `${year}-${mm}-01`, end: `${year + 1}-${mm}-01` };
}

// Deductible met in the benefit year containing `date`: it starts again at zero each new benefit year.
export const deductibleMet = (policy, date) => {
  const { start } = benefitYear(policy, date);
  return !policy.deductible_year || policy.deductible_year === start ? policy.deductible_met || 0 : 0;
};

// Benefits used in the benefit year containing `date`, counted by date of service: what paid claims
// paid, plus what open claims are expected to pay (so two claims can't both spend the same maximum).
export async function benefitsUsed(db, policy, date) {
  const today = date || (await practiceNow(db, policy.practice_id)).slice(0, 10);
  const { start, end } = benefitYear(policy, today);
  return (await db.get(
    `SELECT COALESCE(SUM(CASE WHEN c.status = 'paid' THEN c.paid_amount
         WHEN c.paid_amount > c.estimated_amount THEN c.paid_amount ELSE c.estimated_amount END), 0) AS used
     FROM claims c
     WHERE c.patient_insurance_id = ? AND c.status IN ('draft','submitted','partially_paid','paid')
       AND (SELECT MIN(pr.completed_at) FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = c.id) >= ?
       AND (SELECT MIN(pr.completed_at) FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = c.id) < ?`,
    policy.id, start, end,
  )).used;
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

// Estimates insurance vs patient portion for a list of procedures, applying the
// remaining deductible (not to preventive) and the remaining annual maximum in order.
// For a secondary policy, pass `primary`: procedure id → { covered, write_off } from the primary claim.
// The secondary then pays at most what's left after the primary, and nothing is written off twice.
export async function estimateCoverage(db, policy, procedures, { primary = null } = {}) {
  if (!policy) {
    return {
      policy: null,
      items: procedures.map((p) => ({ procedure_id: p.id, fee: p.fee, allowed: p.fee, write_off: 0, deductible: 0, insurance: 0, patient: p.fee })),
      total_fee: procedures.reduce((s, p) => s + p.fee, 0),
      total_write_off: 0,
      total_deductible: 0,
      total_insurance: 0,
      total_patient: procedures.reduce((s, p) => s + p.fee, 0),
    };
  }
  // In-network (PPO) carriers pay from their fee schedule; the difference is written off.
  const scheduleId = policy.fee_schedule_id ?? (await db.get('SELECT fee_schedule_id FROM insurance_carriers WHERE id = ?', policy.carrier_id))?.fee_schedule_id;
  const allowedFor = async (p) => {
    if (!scheduleId) return p.fee;
    const row = await db.get('SELECT fee FROM fee_schedule_items WHERE fee_schedule_id = ? AND code = ?', scheduleId, p.code);
    return row ? Math.min(row.fee, p.fee) : p.fee;
  };
  const today = (await practiceNow(db, policy.practice_id)).slice(0, 10);
  let remainingMax = Math.max(0, policy.annual_max - (await benefitsUsed(db, policy, today)));
  let remainingDeductible = Math.max(0, policy.deductible - deductibleMet(policy, today));
  const items = await mapSeq(procedures, async (p) => {
    const tier = coverageTier(p.category);
    const pct = policy[`pct_${tier}`] ?? 0;
    const contracted = await allowedFor(p);
    let allowed = contracted;
    let deductible = 0;
    if (tier !== 'preventive' && remainingDeductible > 0) {
      deductible = Math.min(remainingDeductible, allowed);
      remainingDeductible -= deductible;
      allowed -= deductible;
    }
    let insurance = Math.round((allowed * pct) / 100);
    let writeOff = p.fee - contracted;
    let owed = contracted;
    const prior = primary?.get(p.id);
    if (prior) {
      // Coordination of benefits: the primary's allowed amount stands and its write-off isn't repeated.
      owed = Math.max(0, p.fee - prior.write_off - prior.covered);
      writeOff = 0;
      insurance = Math.min(insurance, owed);
    }
    insurance = Math.min(insurance, remainingMax);
    remainingMax -= insurance;
    return { procedure_id: p.id, fee: p.fee, allowed: prior ? p.fee - prior.write_off : contracted, write_off: writeOff, tier, pct, deductible, insurance, primary_covered: prior?.covered ?? 0, patient: owed - insurance };
  });
  const sum = (k) => items.reduce((s, i) => s + i[k], 0);
  return {
    policy: { id: policy.id, carrier_name: policy.carrier_name, annual_max: policy.annual_max },
    items,
    total_fee: sum('fee'),
    total_write_off: sum('write_off'),
    total_deductible: sum('deductible'),
    total_insurance: sum('insurance'),
    total_patient: sum('patient'),
  };
}

const RECALL_CODES = { D1110: 'prophy', D1120: 'prophy', D4910: 'perio_maint' };
// Extractions (D7111-D7250): the tooth is charted missing once the extraction is done.
export const isExtraction = (code) => /^D7(1[1-4]\d|2[0-5]\d)$/.test(String(code || ''));

export async function completeProcedure(db, user, procedure, { providerId, appointmentId } = {}) {
  if (procedure.status === 'completed') throw new HttpError(409, 'Procedure already completed');
  if (procedure.status === 'cancelled') throw new HttpError(409, 'Cancelled procedures cannot be completed');
  const provider = providerId ?? procedure.provider_id;
  if (!provider) throw new HttpError(400, 'A provider is required to complete a procedure');
  const today = (await practiceNow(db, procedure.practice_id)).slice(0, 10);

  await db.tx(async () => {
    await db.run(
      `UPDATE procedures SET status = 'completed', completed_at = datetime('now'), provider_id = ?, appointment_id = COALESCE(?, appointment_id)
       WHERE id = ?`,
      provider, appointmentId ?? null, procedure.id,
    );
    await insert(db, 'ledger_entries', {
      practice_id: procedure.practice_id,
      patient_id: procedure.patient_id,
      type: 'charge',
      amount: procedure.fee,
      description: `${procedure.code} ${procedure.description}${procedure.tooth ? ` #${procedure.tooth}` : ''}${procedure.surfaces ? ` ${procedure.surfaces}` : ''}`,
      procedure_id: procedure.id,
      provider_id: provider,
      entry_date: today,
      created_by: user.id,
    });

    if (isExtraction(procedure.code) && procedure.tooth) {
      await insert(db, 'tooth_conditions', {
        practice_id: procedure.practice_id, patient_id: procedure.patient_id, tooth: procedure.tooth, condition: 'missing',
        notes: `Extracted (${procedure.code})`, recorded_by: user.id, procedure_id: procedure.id,
      });
    }

    const recallType = RECALL_CODES[procedure.code];
    if (recallType) {
      const existing = await db.get('SELECT * FROM recalls WHERE practice_id = ? AND patient_id = ? AND type = ?', procedure.practice_id, procedure.patient_id, recallType);
      const interval = existing?.interval_months ?? (recallType === 'perio_maint' ? 3 : 6);
      const due = addMonths(today, interval);
      if (existing) {
        await db.run("UPDATE recalls SET due_date = ?, status = 'due' WHERE id = ?", due, existing.id);
      } else {
        await insert(db, 'recalls', { practice_id: procedure.practice_id, patient_id: procedure.patient_id, type: recallType, interval_months: interval, due_date: due });
      }
    }

    // Close out the treatment plan once nothing remains planned.
    if (procedure.treatment_plan_id) {
      const remaining = (await db.get("SELECT COUNT(*) AS n FROM procedures WHERE treatment_plan_id = ? AND status = 'planned'", procedure.treatment_plan_id)).n;
      if (remaining === 0) await db.run("UPDATE treatment_plans SET status = 'completed' WHERE id = ?", procedure.treatment_plan_id);
    }
  });
}

// Posts an insurance payment (and optional contractual write-off) against a claim.
export async function postClaimPayment(
  db,
  claim,
  { amount, writeOff = 0, final = true, method = 'check', reference = null, userId = null, date, payerClaimNumber = null, deductible = null }
) {
  const carrier = await db.get('SELECT ic.name FROM patient_insurance pi JOIN insurance_carriers ic ON ic.id = pi.carrier_id WHERE pi.id = ?', claim.patient_insurance_id);
  await db.tx(async () => {
    if (amount > 0) {
      await insert(db, 'ledger_entries', {
        practice_id: claim.practice_id, patient_id: claim.patient_id, type: 'insurance_payment', amount: -amount,
        description: `Insurance payment - ${carrier.name} (claim #${claim.id})`, method, reference, claim_id: claim.id, entry_date: date, created_by: userId,
      });
    }
    if (writeOff > 0) {
      await insert(db, 'ledger_entries', {
        practice_id: claim.practice_id, patient_id: claim.patient_id, type: 'adjustment', amount: -writeOff,
        description: `Insurance write-off - ${carrier.name} (claim #${claim.id})`, claim_id: claim.id, entry_date: date, created_by: userId,
      });
    }
    // Only an open claim takes a payment; a concurrent post rolls this one back instead of doubling it.
    const updated = await db.run(
      "UPDATE claims SET paid_amount = paid_amount + ?, status = ?, paid_at = datetime('now'), denial_reason = NULL, payer_claim_number = COALESCE(?, payer_claim_number) WHERE id = ? AND status IN ('submitted','partially_paid','denied')",
      amount, final ? 'paid' : 'partially_paid', payerClaimNumber, claim.id,
    );
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
        await db.run('UPDATE patient_insurance SET deductible_met = ?, deductible_year = ? WHERE id = ?', met, start, policy.id);
      }
    }
  });
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
  const marked = await db.run("UPDATE ledger_entries SET voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL", userId ?? null, reason, entry.id);
  if (!marked.changes) throw new HttpError(409, 'That entry was already voided');
  return insert(db, 'ledger_entries', {
    practice_id: entry.practice_id, patient_id: entry.patient_id, type: entry.type, amount: -entry.amount,
    description: `Void: ${entry.description}`.slice(0, 300), method: entry.method, reference: entry.reference,
    procedure_id: entry.procedure_id, claim_id: entry.claim_id, provider_id: entry.provider_id, payment_plan_id: entry.payment_plan_id,
    entry_date: date, created_by: userId ?? null, reverses_id: entry.id,
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
      await db.run("UPDATE procedures SET status = 'planned', completed_at = NULL WHERE id = ? AND status = 'completed'", entry.procedure_id);
      await db.run('DELETE FROM tooth_conditions WHERE procedure_id = ?', entry.procedure_id);
    }
    return reverseEntry(db, entry, { userId, reason: String(reason).trim().slice(0, 300), date });
  });
}
