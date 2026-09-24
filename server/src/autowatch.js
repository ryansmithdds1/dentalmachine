// The automation pass (W8, docs/workflows/automation-pass.md): lists somebody had to open and check turn into
// Needs attention items that appear only when something is actually waiting, and resolve on their own once
// it's done (Efficiency Principle 8). Hourly, per practice, as the automation:
//   - forgotten clock-outs (#44) — until now raised only when a manager opened the Today board;
//   - yesterday's loose ends from the end-of-day checklist (#42): completed work for insured patients not on a
//     claim (the item opens Billing → Ready to approve, where those claims are already prepared — claimprep.js),
//     claims made but never sent, visits left open, cash and checks not on a deposit;
//   - pre-authorizations with no answer after PREAUTH_FOLLOW_UP_DAYS (#38);
//   - credit balances held for CREDIT_DAYS with nothing booked (#48): the Credits & refunds queue is the
//     ready-to-approve list, a person refunds;
//   - office licences and contracts close to expiring get their renewal to-do (until now made only when the
//     office documents list was opened).
// It never changes a claim, the ledger, a chart, a punch or a visit: it raises and resolves Needs attention
// items (each newly raised or resolved one is also in the audit log) and makes renewal to-dos. Anything
// that moves money or touches the clinical record stays with a person.
import { practiceNow, audit } from './util.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { withActor } from './actor.js';
import { remindExpiringDocuments } from './routes/docmanage.js';

export const OPEN_PUNCH_HOURS = 14;
export const LOOSE_END_LOOKBACK_DAYS = 30; // older loose ends are the month-end packet's business, not a daily nag
export const PREAUTH_FOLLOW_UP_DAYS = 30;
export const CREDIT_DAYS = 30;
const ACTOR = 'Automation pass';

const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const count = async (db, sql, ...args) => Number((await db.get(sql, ...args))?.n || 0);

// Raises (or counts up) an item; a newly opened one is also written to the audit log.
async function raise(db, issue) {
  const had = await db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", issue.practiceId, issue.key);
  const id = await raiseIssue(db, issue);
  if (id && !had) await audit(db, null, 'automation.raise', 'issues', id, { key: issue.key, title: issue.title });
  return id;
}
// Resolves an open item (no-op when there is none); resolving is audited too.
async function settle(db, practiceId, key, note) {
  const open = await db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", practiceId, key);
  if (!open) return 0;
  const n = await resolveIssue(db, practiceId, key, note);
  if (n) await audit(db, null, 'automation.resolve', 'issues', open.id, { key, note });
  return n;
}
// One count-style item: raised while n > 0, resolved when it reaches 0.
async function tally(db, pid, n, { key, title, detail, role, kind, done, entity = null }) {
  if (n > 0) await raise(db, { practiceId: pid, key, kind, role, title, detail, entity });
  else await settle(db, pid, key, done);
}

// ---- Forgotten clock-outs (#44) ----
// The same rule and item as the manager's Today board (routes/timeclock.js), so the two never duplicate: a
// punch still open from an earlier day, or for more than OPEN_PUNCH_HOURS. Times are practice-local wall
// clock; a daylight-saving change can move the 14 hours by one, which is fine for a reminder.
export async function watchOpenPunches(db, pid, nowLocal) {
  const today = nowLocal.slice(0, 10);
  const nowMs = Date.parse(`${nowLocal.replace(' ', 'T')}:00Z`);
  const open = await db.all(
    `SELECT t.id, t.clock_in, t.eff_in, u.name FROM time_punches t JOIN users u ON u.id = t.user_id
     WHERE t.practice_id = ? AND t.deleted_at IS NULL AND COALESCE(t.eff_out, t.clock_out) IS NULL`, pid,
  );
  let raised = 0;
  const stillOpen = new Set();
  for (const p of open) {
    stillOpen.add(`timeclock-open:${p.id}`);
    const since = p.eff_in || p.clock_in;
    const hours = (nowMs - Date.parse(`${since.slice(0, 16).replace(' ', 'T')}:00Z`)) / 3600_000;
    if (since.slice(0, 10) < today || hours > OPEN_PUNCH_HOURS) {
      await raise(db, {
        practiceId: pid, kind: 'schedule', key: `timeclock-open:${p.id}`, role: 'admin', entity: 'time_punches', entityId: p.id,
        title: `${p.name} is still clocked in from ${since}`, detail: 'Probably a forgotten clock-out. Add the real clock-out time in Time clock → Corrections.',
      });
      raised++;
    }
  }
  // A punch closed some other way (clocked out on the kiosk, removed) takes its item with it.
  const items = await db.all("SELECT dedupe_key FROM issues WHERE practice_id = ? AND status = 'open' AND dedupe_key LIKE 'timeclock-open:%'", pid);
  for (const { dedupe_key: key } of items) if (!stillOpen.has(key)) await settle(db, pid, key, 'The punch is closed');
  return raised;
}

// ---- Yesterday's loose ends (#42) ----
// The end-of-day checklist (routes/close.js) is a list someone has to open; these are its items once they're
// a day old, as counts that resolve themselves when the list is worked.
export async function watchLooseEnds(db, pid, today) {
  const yesterday = addDays(today, -1);
  const from = addDays(today, -LOOSE_END_LOOKBACK_DAYS);
  const out = {};

  // Completed (charged) work for a patient with active insurance, on no live claim, done before yesterday.
  // Work a person skipped with a reason (Billing → Ready to approve) has been looked at, so it isn't counted.
  out.unbilled = await count(db,
    `SELECT COUNT(*) AS n FROM procedures pr WHERE pr.practice_id = ? AND pr.status = 'completed' AND pr.fee > 0
       AND substr(pr.completed_at, 1, 10) >= ? AND substr(pr.completed_at, 1, 10) < ?
       AND EXISTS (SELECT 1 FROM patient_insurance pi WHERE pi.patient_id = pr.patient_id AND pi.active = 1)
       AND NOT EXISTS (SELECT 1 FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE ci.procedure_id = pr.id AND c.status != 'void')
       AND NOT EXISTS (SELECT 1 FROM claim_prep_skips s WHERE s.procedure_id = pr.id AND s.restored_at IS NULL)`,
    pid, from, yesterday);
  // With claims prepared for approval (the default), the item opens that list: each patient's claim is already
  // made up and checked there, and waits for a person's A.
  const prepared = !!(await db.get('SELECT claim_prep FROM practices WHERE id = ?', pid))?.claim_prep;
  await tally(db, pid, out.unbilled, {
    key: 'unbilled-work', kind: 'claim', role: 'billing',
    title: `${plural(out.unbilled, 'completed procedure', 'completed procedures')} for insured patients ${out.unbilled === 1 ? 'is' : 'are'} not on a claim`,
    detail: prepared
      ? 'Billing → Ready to approve: the claims are prepared and checked — approve each one (A), fix what it says, or skip it with a reason.'
      : 'Billing → Claims: bill them (B at checkout or on the Insurance tab), or note why they aren’t billed.',
    ...(prepared ? { entity: 'claim_queue' } : {}),
    done: 'All recent completed work is on a claim',
  });

  // Approved claims that couldn't be sent (routes/claimprep.js) clear themselves once the claim has gone out
  // some other way (Ready to send) or was voided.
  const notSent = await db.all(
    `SELECT i.dedupe_key FROM issues i JOIN claims c ON c.id = i.entity_id AND i.entity = 'claims'
     WHERE i.practice_id = ? AND i.status = 'open' AND i.dedupe_key LIKE 'claim-not-sent:%' AND c.status NOT IN ('draft','denied')`, pid);
  for (const { dedupe_key: key } of notSent) await settle(db, pid, key, 'The claim was sent (or voided)');

  out.unsent = await count(db, "SELECT COUNT(*) AS n FROM claims WHERE practice_id = ? AND status = 'draft' AND substr(created_at, 1, 10) < ?", pid, yesterday);
  await tally(db, pid, out.unsent, {
    key: 'claims-not-sent', kind: 'claim', role: 'billing',
    title: `${plural(out.unsent, 'claim was', 'claims were')} made but not sent`,
    detail: 'Billing → Claims → Ready to send: fix what the checks found and send (B).',
    done: 'No claims are waiting to be sent',
  });

  out.open_visits = await count(db,
    `SELECT COUNT(*) AS n FROM appointments WHERE practice_id = ? AND start_time >= ? AND start_time < ?
       AND status IN ('scheduled','confirmed','checked_in','in_chair')`, pid, `${from} 00:00`, `${today} 00:00`);
  await tally(db, pid, out.open_visits, {
    key: 'visits-left-open', kind: 'schedule', role: 'front_desk',
    title: `${plural(out.open_visits, 'past visit is', 'past visits are')} still open (not completed, cancelled or no-show)`,
    detail: 'Schedule: complete each one, or mark it cancelled or a no-show.',
    done: 'Every past visit is closed',
  });

  // Only for offices that record deposits at all (otherwise every check would sit here forever).
  const usesDeposits = await db.get('SELECT id FROM deposits WHERE practice_id = ? LIMIT 1', pid);
  out.undeposited = usesDeposits ? await count(db,
    `SELECT COUNT(*) AS n FROM ledger_entries WHERE practice_id = ? AND type IN ('payment','insurance_payment') AND amount < 0 AND voided_at IS NULL
       AND reverses_id IS NULL AND deposit_id IS NULL AND COALESCE(method, 'check') IN ('cash','check') AND entry_date >= ? AND entry_date < ?`,
    pid, from, today) : 0;
  await tally(db, pid, out.undeposited, {
    key: 'payments-not-deposited', kind: 'payment', role: 'billing',
    title: `${plural(out.undeposited, 'cash or check payment', 'cash and check payments')} from before today ${out.undeposited === 1 ? 'is' : 'are'} not on a deposit`,
    detail: 'Deposits & cash: put them on a deposit (or find out where they went).',
    done: 'Every cash and check payment is on a deposit',
  });
  return out;
}

// ---- Pre-authorizations with no answer (#38) ----
export async function watchPreauths(db, pid, today) {
  const n = await count(db, "SELECT COUNT(*) AS n FROM preauths WHERE practice_id = ? AND status = 'submitted' AND substr(submitted_at, 1, 10) <= ?", pid, addDays(today, -PREAUTH_FOLLOW_UP_DAYS));
  await tally(db, pid, n, {
    key: 'preauths-no-answer', kind: 'claim', role: 'billing',
    title: `${plural(n, 'pre-authorization has', 'pre-authorizations have')} had no answer for ${PREAUTH_FOLLOW_UP_DAYS}+ days`,
    detail: 'Call the payer, then record the answer on the pre-authorization.',
    done: 'Every pre-authorization has an answer or is recent',
  });
  return n;
}

// ---- Credit balances waiting for a refund (#48) ----
// Only credits that have sat CREDIT_DAYS with no visit booked (a credit before a booked visit is a prepayment).
// The refund itself is a person's decision in Billing → Credits & refunds; nothing is refunded here.
export async function watchCredits(db, pid, nowLocal) {
  const cutoff = addDays(nowLocal.slice(0, 10), -CREDIT_DAYS);
  const rows = await db.all(
    `SELECT l.patient_id FROM ledger_entries l WHERE l.practice_id = ? GROUP BY l.patient_id
     HAVING SUM(l.amount) < 0 AND MAX(CASE WHEN l.amount < 0 THEN l.entry_date END) <= ?`, pid, cutoff,
  );
  let n = 0;
  for (const r of rows) {
    const booked = await db.get("SELECT id FROM appointments WHERE practice_id = ? AND patient_id = ? AND start_time >= ? AND status IN ('scheduled','confirmed') LIMIT 1", pid, r.patient_id, nowLocal);
    if (!booked) n++;
  }
  await tally(db, pid, n, {
    key: 'credit-balances', kind: 'payment', role: 'billing',
    title: `${plural(n, 'account has', 'accounts have')} held a credit for ${CREDIT_DAYS}+ days with nothing booked`,
    detail: 'Billing → Credits & refunds: refund it (R) or keep it on account.',
    done: 'No old credit balances are waiting',
  });
  return n;
}

async function forPractice(db, pid) {
  const now = await practiceNow(db, pid);
  const today = now.slice(0, 10);
  return {
    open_punches: await watchOpenPunches(db, pid, now),
    ...(await watchLooseEnds(db, pid, today)),
    preauths: await watchPreauths(db, pid, today),
    credits: await watchCredits(db, pid, now),
    renewals: await remindExpiringDocuments(db, pid),
  };
}

// One pass over every practice, each as the automation. A practice whose pass breaks gets its own Needs
// attention item (resolved by the next pass that works) and the others carry on.
export async function runAutoWatch(db, { practiceId = null } = {}) {
  const out = {};
  const practices = practiceId ? [{ id: practiceId }] : await db.all('SELECT id FROM practices');
  for (const p of practices) {
    await withActor({ source: 'automation', actor: ACTOR, userId: null, practiceId: p.id }, async () => {
      try {
        out[p.id] = await forPractice(db, p.id);
        await settle(db, p.id, 'autowatch-failed', 'The automation pass worked on its next run');
      } catch (err) {
        out[p.id] = { error: err.message };
        await raiseIssue(db, {
          practiceId: p.id, kind: 'jobs', key: 'autowatch-failed', role: 'admin',
          title: 'The hourly check for loose ends stopped with an error', detail: err.message,
        });
      }
    });
  }
  return out;
}
