// A balance spread over the charges that make it up, newest first, into age buckets.
function spread(balance, charges, todayMs) {
  const row = { current: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  let remaining = balance;
  for (const c of charges) {
    if (remaining <= 0) break;
    const part = Math.min(c.amount, remaining);
    remaining -= part;
    const age = Math.floor((todayMs - Date.parse(`${c.entry_date}T00:00:00Z`)) / 86400000);
    row[age <= 30 ? 'current' : age <= 60 ? 'd31_60' : age <= 90 ? 'd61_90' : 'd90_plus'] += part;
  }
  // Anything not explained by a debit still on file (e.g. a voided payment) is the oldest money owed.
  if (remaining > 0) row.d90_plus += remaining;
  return row;
}

// The same buckets for one account (a patient, or a household's members) — for statements.
export async function accountAging(db, pid, ids, today) {
  const L = ids.map(() => '?').join(',');
  const balance = (await db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE practice_id = ? AND patient_id IN (${L}) AND entry_date <= ?`, pid, ...ids, today)).n;
  if (balance <= 0) return { current: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const charges = await db.all(
    `SELECT amount, entry_date FROM ledger_entries WHERE practice_id = ? AND patient_id IN (${L}) AND amount > 0 AND voided_at IS NULL AND reverses_id IS NULL AND entry_date <= ?
     ORDER BY entry_date DESC, id DESC`, pid, ...ids, today,
  );
  return spread(balance, charges, Date.parse(`${today}T00:00:00Z`));
}

// Accounts receivable by age. Payments and credits pay off the oldest charges first, so what's still owed is the
// most recent debits. Voided entries and their reversals cancel out. Accounts in credit are listed separately.
// By family, each account is the head of household (guarantor) with everyone they're responsible for.
export async function agingReport(db, pid, today, { family = false } = {}) {
  const acct = family ? 'COALESCE(p.guarantor_id, p.id)' : 'p.id';
  // Three queries whatever the size of the practice: balances (with names), the debits that make them up,
  // and what insurance is still expected, all grouped by account.
  const patients = await db.all(
    `SELECT b.id, b.balance, a.first_name, a.last_name, a.phone FROM (
       SELECT ${acct} AS id, SUM(l.amount) AS balance FROM ledger_entries l JOIN patients p ON p.id = l.patient_id
       WHERE l.practice_id = ? AND l.entry_date <= ? GROUP BY ${acct} HAVING SUM(l.amount) <> 0
     ) b JOIN patients a ON a.id = b.id ORDER BY b.balance DESC, b.id`, pid, today,
  );
  const owing = patients.filter((p) => p.balance > 0);
  const buckets = ['current', 'd31_60', 'd61_90', 'd90_plus'];
  const totals = Object.fromEntries(buckets.map((b) => [b, 0]));
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  // Voided entries and reversals are left out: they cancel each other in the balance, and the balance is
  // what gets spread over the real charges.
  const debits = owing.length ? await db.all(
    `SELECT ${acct} AS patient_id, l.amount, l.entry_date FROM ledger_entries l JOIN patients p ON p.id = l.patient_id
     WHERE l.practice_id = ? AND l.amount > 0 AND l.voided_at IS NULL AND l.reverses_id IS NULL AND l.entry_date <= ?
     ORDER BY 1, l.entry_date DESC, l.id DESC`, pid, today,
  ) : [];
  const byPatient = new Map();
  for (const d of debits) {
    if (!byPatient.has(d.patient_id)) byPatient.set(d.patient_id, []);
    byPatient.get(d.patient_id).push(d);
  }
  // Open claims: insurance still expected plus the in-network write-off still to come.
  const pendingRows = owing.length ? await db.all(
    `SELECT ${acct} AS id,
       COALESCE(SUM(CASE WHEN c.estimated_amount > c.paid_amount THEN c.estimated_amount - c.paid_amount ELSE 0 END), 0)
       + COALESCE(SUM(CASE WHEN c.status IN ('draft','submitted') THEN c.write_off_estimate ELSE 0 END), 0) AS pending
     FROM claims c JOIN patients p ON p.id = c.patient_id
     WHERE c.practice_id = ? AND c.status IN ('draft','submitted','partially_paid') GROUP BY ${acct}`, pid,
  ) : [];
  const pending = new Map(pendingRows.map((x) => [x.id, x.pending]));
  const rows = owing.map((p) => {
    const row = { ...p, ...spread(p.balance, byPatient.get(p.id) || [], todayMs) };
    buckets.forEach((b) => (totals[b] += row[b]));
    // What insurance is still expected to cover vs what the patient owes (open claims today).
    row.insurance_pending = Math.min(row.balance, pending.get(p.id) || 0);
    row.patient_portion = row.balance - row.insurance_pending;
    return row;
  });
  totals.insurance_pending = rows.reduce((s, r) => s + r.insurance_pending, 0);
  totals.patient_portion = rows.reduce((s, r) => s + r.patient_portion, 0);
  const credits = patients.filter((p) => p.balance < 0).map((p) => ({ ...p, credit: -p.balance }));
  return {
    as_of: today, group: family ? 'family' : 'patient', totals: { ...totals, total: rows.reduce((s, r) => s + r.balance, 0), credits: credits.reduce((s, c) => s + c.credit, 0) }, rows, credits,
  };
}
