// The weekly and monthly office work (workflows 45–54) that nobody should have to remember: a background pass
// turns what's due into Needs attention items (issues.js) and resolves them once the work is done.
//   - insurance claims due a follow-up call (workflow 45): the follow-up date has come, or a claim has been out
//     FOLLOW_UP_AFTER_DAYS with no call;
//   - last month's books not closed yet (workflow 54), from CLOSE_REMINDER_DAY of the month on;
//   - charts that look like the same person (workflow 51).
// It only reads and raises reminders: it never changes a claim, the ledger or a chart.
import { practiceNow } from './util.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { withActor } from './actor.js';

export const FOLLOW_UP_AFTER_DAYS = 30;
export const CLOSE_REMINDER_DAY = 5;

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
export const lastMonthOf = (today) => {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCDate(0);
  return { month: d.toISOString().slice(0, 7), end: d.toISOString().slice(0, 10) };
};

// Claims waiting on a payer that are due a call today (the same rule as GET /reports/outstanding-claims).
export async function claimsDue(db, practiceId, today) {
  const rows = await db.all("SELECT id, submitted_at, follow_up_date FROM claims WHERE practice_id = ? AND status IN ('submitted','partially_paid')", practiceId);
  return rows.filter((c) => (c.follow_up_date ? c.follow_up_date <= today : !!c.submitted_at && daysBetween(c.submitted_at.slice(0, 10), today) >= FOLLOW_UP_AFTER_DAYS)).length;
}

// Groups of charts with the same name and birthday (not archived or merged).
export async function duplicateGroups(db, practiceId) {
  const rows = await db.all(
    "SELECT lower(trim(first_name)) AS f, lower(trim(last_name)) AS l, dob, COUNT(*) AS n FROM patients WHERE practice_id = ? AND status != 'archived' AND merged_into_id IS NULL AND dob IS NOT NULL GROUP BY lower(trim(first_name)), lower(trim(last_name)), dob HAVING COUNT(*) > 1",
    practiceId,
  );
  return rows.length;
}

async function forPractice(db, practice) {
  const pid = practice.id;
  const today = (await practiceNow(db, pid)).slice(0, 10);
  const due = await claimsDue(db, pid, today);
  if (due) {
    await raiseIssue(db, {
      practiceId: pid, kind: 'claim', key: 'claims-follow-up', role: 'billing',
      title: `${due} insurance claim${due === 1 ? ' is' : 's are'} due a follow-up call`, detail: 'Billing → Insurance follow-up lists them, due calls first.',
    });
  } else await resolveIssue(db, pid, 'claims-follow-up', 'No claims are due a follow-up call');

  const { month, end } = lastMonthOf(today);
  const closed = !!practice.lock_date && practice.lock_date >= end;
  if (!closed && Number(today.slice(8, 10)) >= CLOSE_REMINDER_DAY) {
    await raiseIssue(db, {
      practiceId: pid, kind: 'records', key: `books-not-closed:${month}`, role: 'admin',
      title: `The books for ${month} aren’t closed yet`, detail: 'Reports → Close: check the month-end packet and close the month.',
    });
  }
  if (closed) await resolveIssue(db, pid, `books-not-closed:${month}`, `Closed through ${practice.lock_date}`);

  const dupes = await duplicateGroups(db, pid);
  if (dupes) {
    await raiseIssue(db, {
      practiceId: pid, kind: 'records', key: 'duplicate-charts', role: 'admin',
      title: `${dupes} patient${dupes === 1 ? '' : 's'} may have two charts`, detail: 'Settings → Duplicate charts: compare them side by side and merge.',
    });
  } else await resolveIssue(db, pid, 'duplicate-charts', 'No more possible duplicate charts');
  return { due, closed, dupes };
}

// One pass over every practice, as the automation (never as a person). Returns what it found, per practice id.
export async function runMonthlyWorkJobs(db) {
  const out = {};
  for (const p of await db.all('SELECT id, lock_date FROM practices')) {
    out[p.id] = await withActor({ source: 'automation', actor: 'Weekly & monthly work', practiceId: p.id }, () => forPractice(db, p));
  }
  return out;
}
