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
  const buckets = ['current', 'd31_60', 'd61_90', 'd90_plus'];
  const totals = Object.fromEntries(buckets.map((b) => [b, 0]));
  // One pass over the ledger, grouped by patient: the balance, and the debits (not voided or reversed)
  // dated in each 30-day band. Spreading a balance over the newest debits first is the same as filling the
  // newest band, then the next — so the per-charge detail never has to leave the database.
  const back = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  const [b30, b60, b90] = [back(30), back(60), back(90)];
  const debit = (cond) => `SUM(CASE WHEN l.amount > 0 AND l.voided_at IS NULL AND l.reverses_id IS NULL AND ${cond} THEN l.amount ELSE 0 END)`;
  const perPatient = await db.all(
    `SELECT l.patient_id, SUM(l.amount) AS balance, ${debit('l.entry_date >= ?')} AS s0, ${debit('l.entry_date >= ? AND l.entry_date < ?')} AS s1, ${debit('l.entry_date >= ? AND l.entry_date < ?')} AS s2
     FROM real_ledger_entries l WHERE l.practice_id = ? AND l.entry_date <= ? GROUP BY l.patient_id`,
    b30, b60, b30, b90, b60, pid, today,
  );
  const people = new Map((await db.all('SELECT id, guarantor_id, first_name, last_name, phone FROM real_patients patients WHERE practice_id = ?', pid)).map((p) => [p.id, p]));
  const accounts = new Map();
  for (const r of perPatient) {
    const id = family ? (people.get(r.patient_id)?.guarantor_id ?? r.patient_id) : r.patient_id;
    const a = accounts.get(id) || { balance: 0, s0: 0, s1: 0, s2: 0 };
    a.balance += Number(r.balance); a.s0 += Number(r.s0); a.s1 += Number(r.s1); a.s2 += Number(r.s2);
    accounts.set(id, a);
  }
  const patients = [...accounts].filter(([, a]) => a.balance !== 0)
    .map(([id, a]) => { const p = people.get(id) || {}; return { id, balance: a.balance, first_name: p.first_name, last_name: p.last_name, phone: p.phone, bands: a }; })
    .sort((x, y) => y.balance - x.balance || x.id - y.id);
  const owing = patients.filter((p) => p.balance > 0);
  const spreadBands = (balance, a) => {
    const current = Math.min(balance, a.s0);
    const d31_60 = Math.min(balance - current, a.s1);
    const d61_90 = Math.min(balance - current - d31_60, a.s2);
    // Older debits, and anything not explained by a debit still on file (e.g. a voided payment).
    return { current, d31_60, d61_90, d90_plus: balance - current - d31_60 - d61_90 };
  };
  // Open claims: insurance still expected plus the in-network write-off still to come.
  const pendingRows = owing.length ? await db.all(
    `SELECT ${acct} AS id,
       COALESCE(SUM(CASE WHEN c.estimated_amount > c.paid_amount THEN c.estimated_amount - c.paid_amount ELSE 0 END), 0)
       + COALESCE(SUM(CASE WHEN c.status IN ('draft','submitted') THEN c.write_off_estimate ELSE 0 END), 0) AS pending
     FROM real_claims c JOIN real_patients p ON p.id = c.patient_id
     WHERE c.practice_id = ? AND c.status IN ('draft','submitted','partially_paid') GROUP BY ${acct}`, pid,
  ) : [];
  const pending = new Map(pendingRows.map((x) => [x.id, x.pending]));
  const rows = owing.map(({ bands, ...p }) => {
    const row = { ...p, ...spreadBands(p.balance, bands) };
    buckets.forEach((b) => (totals[b] += row[b]));
    // What insurance is still expected to cover vs what the patient owes (open claims today).
    row.insurance_pending = Math.min(row.balance, pending.get(p.id) || 0);
    row.patient_portion = row.balance - row.insurance_pending;
    return row;
  });
  totals.insurance_pending = rows.reduce((s, r) => s + r.insurance_pending, 0);
  totals.patient_portion = rows.reduce((s, r) => s + r.patient_portion, 0);
  const credits = patients.filter((p) => p.balance < 0).map(({ bands: _b, ...p }) => ({ ...p, credit: -p.balance }));
  return {
    as_of: today, group: family ? 'family' : 'patient', totals: { ...totals, total: rows.reduce((s, r) => s + r.balance, 0), credits: credits.reduce((s, c) => s + c.credit, 0) }, rows, credits,
  };
}
