import { HttpError } from './auth.js';
import { coverageTier } from './defaults.js';
import { insert, addMonths, practiceNow, mapSeq } from './util.js';

export async function patientBalance(db, practiceId, patientId) {
  return (await db.get(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_entries WHERE practice_id = ? AND patient_id = ?',
    practiceId, patientId,
  )).balance;
}

// Benefits used this calendar year = insurance payments received against this policy's claims.
export async function benefitsUsed(db, policy, year = new Date().getUTCFullYear()) {
  return (await db.get(
    `SELECT COALESCE(SUM(paid_amount), 0) AS used FROM claims
     WHERE patient_insurance_id = ? AND status IN ('paid','partially_paid') AND substr(paid_at, 1, 4) = ?`,
    policy.id, String(year),
  )).used;
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
export async function estimateCoverage(db, policy, procedures) {
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
  let remainingMax = Math.max(0, policy.annual_max - (await benefitsUsed(db, policy)));
  let remainingDeductible = Math.max(0, policy.deductible - policy.deductible_met);
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
    insurance = Math.min(insurance, remainingMax);
    remainingMax -= insurance;
    return { procedure_id: p.id, fee: p.fee, allowed: contracted, write_off: p.fee - contracted, tier, pct, deductible, insurance, patient: contracted - insurance };
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
  { amount, writeOff = 0, final = true, method = 'check', reference = null, userId = null, date, payerClaimNumber = null }
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
    await db.run(
      "UPDATE claims SET paid_amount = paid_amount + ?, status = ?, paid_at = datetime('now'), payer_claim_number = COALESCE(?, payer_claim_number) WHERE id = ?",
      amount, final ? 'paid' : 'partially_paid', payerClaimNumber, claim.id,
    );
    // First payment on a claim satisfies the deductible it applied.
    if (claim.status === 'submitted' && claim.deductible_applied > 0) {
      await db.run('UPDATE patient_insurance SET deductible_met = CASE WHEN deductible_met + ? > deductible THEN deductible ELSE deductible_met + ? END WHERE id = ?', claim.deductible_applied, claim.deductible_applied, claim.patient_insurance_id);
    }
  });
}
