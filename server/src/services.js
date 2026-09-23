import { HttpError } from './auth.js';
import { coverageTier } from './defaults.js';
import { insert, addMonths, practiceNow } from './util.js';

export function patientBalance(db, practiceId, patientId) {
  return db.get(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_entries WHERE practice_id = ? AND patient_id = ?',
    practiceId, patientId,
  ).balance;
}

// Benefits used this calendar year = insurance payments received against this policy's claims.
export function benefitsUsed(db, policy, year = new Date().getUTCFullYear()) {
  return db.get(
    `SELECT COALESCE(SUM(paid_amount), 0) AS used FROM claims
     WHERE patient_insurance_id = ? AND status IN ('paid','partially_paid') AND strftime('%Y', paid_at) = ?`,
    policy.id, String(year),
  ).used;
}

export function primaryPolicy(db, practiceId, patientId) {
  return db.get(
    `SELECT pi.*, c.name AS carrier_name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id
     WHERE pi.practice_id = ? AND pi.patient_id = ? AND pi.active = 1
     ORDER BY CASE pi.priority WHEN 'primary' THEN 0 ELSE 1 END LIMIT 1`,
    practiceId, patientId,
  );
}

// Estimates insurance vs patient portion for a list of procedures, applying the
// remaining deductible (not to preventive) and the remaining annual maximum in order.
export function estimateCoverage(db, policy, procedures) {
  if (!policy) {
    return {
      policy: null,
      items: procedures.map((p) => ({ procedure_id: p.id, fee: p.fee, deductible: 0, insurance: 0, patient: p.fee })),
      total_fee: procedures.reduce((s, p) => s + p.fee, 0),
      total_deductible: 0,
      total_insurance: 0,
      total_patient: procedures.reduce((s, p) => s + p.fee, 0),
    };
  }
  let remainingMax = Math.max(0, policy.annual_max - benefitsUsed(db, policy));
  let remainingDeductible = Math.max(0, policy.deductible - policy.deductible_met);
  const items = procedures.map((p) => {
    const tier = coverageTier(p.category);
    const pct = policy[`pct_${tier}`] ?? 0;
    let allowed = p.fee;
    let deductible = 0;
    if (tier !== 'preventive' && remainingDeductible > 0) {
      deductible = Math.min(remainingDeductible, allowed);
      remainingDeductible -= deductible;
      allowed -= deductible;
    }
    let insurance = Math.round((allowed * pct) / 100);
    insurance = Math.min(insurance, remainingMax);
    remainingMax -= insurance;
    return { procedure_id: p.id, fee: p.fee, tier, pct, deductible, insurance, patient: p.fee - insurance };
  });
  const sum = (k) => items.reduce((s, i) => s + i[k], 0);
  return {
    policy: { id: policy.id, carrier_name: policy.carrier_name, annual_max: policy.annual_max },
    items,
    total_fee: sum('fee'),
    total_deductible: sum('deductible'),
    total_insurance: sum('insurance'),
    total_patient: sum('patient'),
  };
}

const RECALL_CODES = { D1110: 'prophy', D1120: 'prophy', D4910: 'perio_maint' };

export function completeProcedure(db, user, procedure, { providerId, appointmentId } = {}) {
  if (procedure.status === 'completed') throw new HttpError(409, 'Procedure already completed');
  if (procedure.status === 'cancelled') throw new HttpError(409, 'Cancelled procedures cannot be completed');
  const provider = providerId ?? procedure.provider_id;
  if (!provider) throw new HttpError(400, 'A provider is required to complete a procedure');
  const today = practiceNow(db, procedure.practice_id).slice(0, 10);

  db.tx(() => {
    db.run(
      `UPDATE procedures SET status = 'completed', completed_at = datetime('now'), provider_id = ?, appointment_id = COALESCE(?, appointment_id)
       WHERE id = ?`,
      provider, appointmentId ?? null, procedure.id,
    );
    insert(db, 'ledger_entries', {
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
      const existing = db.get('SELECT * FROM recalls WHERE practice_id = ? AND patient_id = ? AND type = ?', procedure.practice_id, procedure.patient_id, recallType);
      const interval = existing?.interval_months ?? (recallType === 'perio_maint' ? 3 : 6);
      const due = addMonths(today, interval);
      if (existing) {
        db.run("UPDATE recalls SET due_date = ?, status = 'due' WHERE id = ?", due, existing.id);
      } else {
        insert(db, 'recalls', { practice_id: procedure.practice_id, patient_id: procedure.patient_id, type: recallType, interval_months: interval, due_date: due });
      }
    }

    // Close out the treatment plan once nothing remains planned.
    if (procedure.treatment_plan_id) {
      const remaining = db.get("SELECT COUNT(*) AS n FROM procedures WHERE treatment_plan_id = ? AND status = 'planned'", procedure.treatment_plan_id).n;
      if (remaining === 0) db.run("UPDATE treatment_plans SET status = 'completed' WHERE id = ?", procedure.treatment_plan_id);
    }
  });
}
