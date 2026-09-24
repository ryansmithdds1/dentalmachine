// Approved team bonuses on their way to payroll (BN3). Kept apart from bonus.js so the time clock's payroll export
// can ask for them without loading the bonus calculations (and without an import cycle).
//
// An approval names the pay period whose payroll file carries it (payroll_period_start). Only approvals still
// 'approved' count: a reopened period drops out of the next file. Amounts are integer cents, net of caps and
// clawbacks, one total per person.
export async function bonusesForPayroll(db, practiceId, periodStart) {
  const approvals = await db.all(
    "SELECT id, plan_id, period_start, period_end, total_cents FROM bonus_approvals WHERE practice_id = ? AND payroll_period_start = ? AND status = 'approved' ORDER BY id",
    practiceId, periodStart,
  );
  if (!approvals.length) return { people: [], approval_ids: [], total_cents: 0 };
  const ids = approvals.map((a) => a.id);
  const rows = await db.all(
    `SELECT l.user_id, u.name, s.payroll_id, SUM(l.net_cents) AS cents FROM bonus_payout_lines l JOIN users u ON u.id = l.user_id
     LEFT JOIN timeclock_staff s ON s.user_id = l.user_id
     WHERE l.practice_id = ? AND l.approval_id IN (${ids.map(() => '?').join(',')}) GROUP BY l.user_id, u.name, s.payroll_id ORDER BY u.name`,
    practiceId, ...ids,
  );
  const people = rows.map((r) => ({ user_id: r.user_id, name: r.name, payroll_id: r.payroll_id ?? null, cents: Number(r.cents) })).filter((p) => p.cents !== 0);
  return { people, approval_ids: ids, total_cents: people.reduce((t, p) => t + p.cents, 0) };
}

// Adds the bonuses to the people in a payroll file: bonus_cents on each person, and a line with no hours for
// someone who earned a bonus but has no approved hours (salaried staff, say). Returns the people list to export.
export function withBonuses(people, bonus) {
  const out = people.map((p) => ({ ...p }));
  for (const b of bonus.people) {
    let p = out.find((x) => x.user_id === b.user_id);
    if (!p) {
      p = { user_id: b.user_id, name: b.name, payroll_id: b.payroll_id, minutes: { regular: 0, overtime: 0, doubletime: 0, pto: 0, holiday: 0 }, days: [] };
      out.push(p);
    }
    p.bonus_cents = (p.bonus_cents || 0) + b.cents;
  }
  return out;
}
