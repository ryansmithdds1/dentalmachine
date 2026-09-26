import { HttpError } from './auth.js';
import { NOT_TRAINING } from './training.js';
import { insert, audit, localNow, recorded } from './util.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { pendingInsurance } from './services.js';
import { registerCadenceType, activeHold, skipReason, verifyLink, addDays, daysBetween } from './cadence.js';
import { mailable, statementHtml } from './mail.js';
import { statementData } from './routes/billing.js';
import { portalKey } from './routes/portal.js';
import { settingsOf } from './eobauto.js';
import { publish } from './events.js';

// ---- Bill the patient automatically once insurance has paid (backlog A4, docs/eob-autopilot.md) ----
// When a claim closes and the account still owes (and no secondary claim is still out), the account gets a
// "balance bill": the recall cadence engine (cadence.js, type 'patient_balance') sends the text/email with a
// pay link and the reminders — with its quiet hours, preferred channel, fallbacks, holds, opt-outs and
// claim-before-send — and this module adds what's particular to money:
//   - who is billed and when: the practice's minimum balance, days to wait after the claim closes, the hold
//     list (a 'patient_balance' hold on the patient page), and never while a payment plan is running (autopay
//     charges it as agreed) or an insurance payment is still expected;
//   - one bill at a time per account (a second claim closing joins the open one), so nobody gets two;
//   - a paper statement by mail (Lob) when the link hasn't been opened after `paper_days` — or straight away
//     for someone we can't text or email — built from the ledger like every other statement;
//   - it stops the moment the account is paid (the cadence checks right before every send too).
// The balance itself is never stored as truth: it's SUM(ledger) − what insurance still owes, every time.

export const BALANCE_CADENCE = [
  { offset_days: 0, channel: 'text', template: 'Hi {first_name}, {practice} here. Your insurance has paid its part for your recent visit. See what’s left and pay securely: {link} — questions? Call {phone}.' },
  {
    offset_days: 7, channel: 'email', subject: 'Your balance at {practice}', template:
      'Hi {first_name}, your insurance has finished with your recent visit at {practice}. You can see what’s left and pay online in a minute: {link}. If you’d like to set up a payment plan, just call us at {phone}.',
  },
  { offset_days: 14, channel: 'text', template: 'Reminder from {practice}: your balance after insurance is ready to pay here: {link} — or call {phone} if you have questions.' },
];

const PREVIEW_BOTS = /facebookexternalhit|whatsapp|slackbot|twitterbot|telegrambot|discordbot|linkedinbot|googlebot|bingbot|applebot|skypeuripreview|preview|crawler|spider|bot\b/i;

export async function familyIds(db, practiceId, guarantorId) {
  return (await db.all('SELECT id FROM patients WHERE practice_id = ? AND (id = ? OR guarantor_id = ?)', practiceId, guarantorId, guarantorId)).map((r) => r.id);
}
// What the account owes now: the ledger's balance less what insurance is still expected to pay or write off.
export async function accountPortion(db, practiceId, guarantorId) {
  const ids = await familyIds(db, practiceId, guarantorId);
  const bal = Number((await db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE practice_id = ? AND patient_id IN (${ids.map(() => '?').join(',')})`, practiceId, ...ids)).n);
  return bal - (await pendingInsurance(db, practiceId, ids)).total;
}
async function onPaymentPlan(db, practiceId, guarantorId) {
  const ids = await familyIds(db, practiceId, guarantorId);
  return db.get(`SELECT id FROM payment_plans WHERE practice_id = ? AND status = 'active' AND patient_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`, practiceId, ...ids);
}
// A secondary claim still to go out or to be answered, for this claim's work.
async function secondaryPending(db, claim) {
  if (await db.get("SELECT id FROM claims WHERE primary_claim_id = ? AND status IN ('draft','submitted','partially_paid')", claim.id)) return true;
  const policy = await db.get('SELECT priority FROM patient_insurance WHERE id = ?', claim.patient_insurance_id);
  if (policy?.priority !== 'primary') return false;
  const secondary = await db.get("SELECT id FROM patient_insurance WHERE patient_id = ? AND priority = 'secondary' AND active = 1", claim.patient_id);
  if (!secondary) return false;
  // Covered by a secondary policy but no secondary claim yet (it's being made, or couldn't be): wait for it.
  return !(await db.get("SELECT id FROM claims WHERE primary_claim_id = ? AND status IN ('paid','denied','void')", claim.id));
}

// ---- The cadence type ----
export const balanceCadence = {
  label: 'Patient balance',
  linkPath: 'api/public/pay-balance',
  messageKind: 'statement',
  enabled: (practice) => !!settingsOf(practice).billing,
  async defaultSequences() {
    return [{ subtype: 'after_insurance', name: 'Balance after insurance', steps: BALANCE_CADENCE }];
  },
  async candidates(db, practice, { windows }) {
    const w = windows.after_insurance;
    if (!w) return [];
    const rows = await db.all(
      "SELECT id, patient_id, anchor_date, location_id FROM balance_bills WHERE practice_id = ? AND status = 'active' AND anchor_date >= ? AND anchor_date <= ? ORDER BY anchor_date, id",
      practice.id, w.from, w.to,
    );
    return rows.map((b) => ({ patient_id: b.patient_id, subtype: 'after_insurance', source_type: 'balance_bill', source_id: b.id, anchor_date: b.anchor_date, location_id: b.location_id }));
  },
  async stopCheck(db, e) {
    const bill = await db.get('SELECT * FROM balance_bills WHERE id = ? AND practice_id = ?', e.source_id, e.practice_id);
    if (!bill) return { reason: 'other' };
    if (bill.status !== 'active') return { reason: bill.status === 'paid' ? 'paid' : bill.stop_reason || 'other' };
    if ((await accountPortion(db, e.practice_id, bill.patient_id)) <= 0) return { reason: 'paid' };
    if (await onPaymentPlan(db, e.practice_id, bill.patient_id)) return { reason: 'payment_plan' };
    return null;
  },
  async describe() {
    return { visit: 'balance' };
  },
  // The account was just sent a statement: the monthly statement batch leaves it alone for a while.
  async afterSend(db, enrollments) {
    for (const e of enrollments) {
      await db.run("UPDATE patients SET statement_sent_at = datetime('now') WHERE id = ?", e.patient_id);
      await db.run("UPDATE balance_bills SET last_sent_at = datetime('now') WHERE id = ?", e.source_id);
    }
  },
};
registerCadenceType('patient_balance', balanceCadence);

// ---- The job: start bills, stop paid ones, mail paper ----
// deps: { mailer, appUrl, now }. Runs as the automation actor (the caller sets it).
export async function runAutoBilling(db, practice, deps = {}) {
  const s = settingsOf(practice);
  const stats = { started: 0, merged: 0, skipped: 0, paid: 0, stopped: 0, paper: 0, done: 0 };
  if (!s.billing) return stats;
  const pid = practice.id;
  const today = localNow(practice.timezone || 'America/New_York', deps.now || new Date()).slice(0, 10);
  const since = s.billing_since || today;
  const lastClose = addDays(today, -Number(s.wait_days || 0));

  // 1. Claims that closed (paid, or denied and sent to the patient by a person) since billing was turned on,
  //    at least wait_days ago, not looked at yet. Closed = when the payment was posted (paid_at), not the
  //    payer's check date.
  const closed = await db.all(
    `SELECT c.*, substr(c.paid_at, 1, 10) AS closed_on FROM claims c WHERE c.practice_id = ? AND ${NOT_TRAINING('c.patient_id')} AND c.status = 'paid' AND substr(c.paid_at, 1, 10) >= ? AND substr(c.paid_at, 1, 10) <= ?
       AND NOT EXISTS (SELECT 1 FROM balance_bills b WHERE b.claim_id = c.id)
     UNION
     SELECT c.*, substr(MAX(r.resolved_at), 1, 10) AS closed_on FROM claims c JOIN remit_lines r ON r.claim_id = c.id AND r.resolution = 'bill_patient'
     WHERE c.practice_id = ? AND ${NOT_TRAINING('c.patient_id')} AND c.status = 'denied' AND substr(r.resolved_at, 1, 10) >= ? AND substr(r.resolved_at, 1, 10) <= ?
       AND NOT EXISTS (SELECT 1 FROM balance_bills b WHERE b.claim_id = c.id)
     GROUP BY c.id`,
    pid, since, lastClose, pid, since, lastClose,
  );
  closed.sort((a, b) => String(a.closed_on).localeCompare(String(b.closed_on)) || a.id - b.id);
  for (const claim of closed) {
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', claim.patient_id);
    const gid = patient.guarantor_id || patient.id;
    // Held (by a person) or waiting on a secondary: not now — looked at again on the next pass.
    if (await activeHold(db, gid, 'patient_balance') || await activeHold(db, patient.id, 'patient_balance')) continue;
    if (await secondaryPending(db, claim)) continue;
    const portion = await accountPortion(db, pid, gid);
    const row = { practice_id: pid, patient_id: gid, claim_id: claim.id, location_id: claim.location_id ?? patient.location_id ?? null, closed_on: claim.closed_on, anchor_date: today, amount: Math.max(0, portion) };
    let status = 'active';
    let stop = null;
    if (portion <= 0) [status, stop] = ['skipped', 'nothing_owed'];
    else if (portion < s.min_balance) [status, stop] = ['skipped', 'below_minimum'];
    else if (await onPaymentPlan(db, pid, gid)) [status, stop] = ['skipped', 'payment_plan'];
    const open = status === 'active' ? await db.get("SELECT id FROM balance_bills WHERE practice_id = ? AND patient_id = ? AND status = 'active'", pid, gid) : null;
    if (open) [status, stop] = ['merged', `joined bill #${open.id}`];
    const { changes, id } = await db.run(
      `INSERT INTO balance_bills (practice_id, patient_id, claim_id, location_id, closed_on, anchor_date, amount, status, stop_reason, merged_into_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      row.practice_id, row.patient_id, row.claim_id, row.location_id, row.closed_on, row.anchor_date, row.amount, status, stop, open?.id ?? null,
    );
    if (!changes) continue;
    const billId = id ?? (await db.get('SELECT id FROM balance_bills WHERE claim_id = ?', claim.id)).id;
    if (status === 'active') stats.started++;
    else if (status === 'merged') stats.merged++;
    else stats.skipped++;
    await audit(db, { user: { practice_id: pid, id: null } }, `balance_bill.${status === 'active' ? 'start' : status}`, 'balance_bills', billId, {
      claim_id: claim.id, amount: row.amount, reason: stop,
    }, { patientId: gid });
  }

  // 2. Open bills: stop when paid, held or on a plan; finish when every step has run and nothing more will go.
  for (const bill of await db.all("SELECT * FROM balance_bills WHERE practice_id = ? AND status = 'active' ORDER BY id", pid)) {
    const portion = await accountPortion(db, pid, bill.patient_id);
    let end = null;
    if (portion <= 0) end = ['paid', 'paid'];
    else if (await activeHold(db, bill.patient_id, 'patient_balance')) end = ['stopped', 'held'];
    else if (await onPaymentPlan(db, pid, bill.patient_id)) end = ['stopped', 'payment_plan'];
    if (end) {
      const { changes } = await recorded(db, 'balance_bills', bill.id, () => db.run("UPDATE balance_bills SET status = ?, stop_reason = ?, ended_at = datetime('now') WHERE id = ? AND status = 'active'", end[0], end[1], bill.id));
      if (changes) {
        stats[end[0] === 'paid' ? 'paid' : 'stopped']++;
        await audit(db, { user: { practice_id: pid, id: null } }, `balance_bill.${end[0]}`, 'balance_bills', bill.id, { reason: end[1] }, { patientId: bill.patient_id });
      }
      continue;
    }
    const guarantor = await db.get('SELECT * FROM patients WHERE id = ?', bill.patient_id);
    const electronic = !(await skipReason(db, guarantor, 'patient_balance')) && !!(guarantor.phone || guarantor.email);
    const paperDue = electronic ? addDays(bill.anchor_date, Number(s.paper_days)) : bill.anchor_date;
    if (!bill.paper_status && today >= paperDue && !bill.link_opened_at) {
      if (await mailPaper(db, practice, bill, guarantor, { ...deps, today })) stats.paper++;
    }
    const cadenceOver = !(await db.get("SELECT e.id FROM cadence_enrollments e JOIN cadence_sequences q ON q.id = e.sequence_id WHERE q.type = 'patient_balance' AND e.source_type = 'balance_bill' AND e.source_id = ? AND e.status = 'active'", bill.id));
    if (cadenceOver && (bill.paper_status || bill.link_opened_at) && daysBetween(bill.anchor_date, today) >= Math.max(30, Number(s.paper_days) + 7)) {
      const { changes } = await db.run("UPDATE balance_bills SET status = 'done', stop_reason = 'finished', ended_at = datetime('now') WHERE id = ? AND status = 'active'", bill.id);
      if (changes) stats.done++;
    }
  }
  if (Object.values(stats).some(Boolean)) publish(pid, { type: 'eob' });
  return stats;
}

// One paper statement per bill: claimed first (paper_status), sent with the mail service's idempotency key,
// so a retry or a second server never mails it twice. Without a mail service it's put on the print list.
async function mailPaper(db, practice, bill, guarantor, { mailer, appUrl, today }) {
  const { changes } = await db.run("UPDATE balance_bills SET paper_status = 'sending', paper_attempts = paper_attempts + 1 WHERE id = ? AND paper_status IS NULL", bill.id);
  if (!changes) return false;
  const pid = practice.id;
  const amount = Math.max(0, await accountPortion(db, pid, bill.patient_id));
  const ids = await familyIds(db, pid, bill.patient_id);
  const pending = await pendingInsurance(db, pid, ids);
  const runId = await insert(db, 'statement_runs', { practice_id: pid, accounts: 1, total: amount, patient_ids: JSON.stringify([bill.patient_id]), created_by: null });
  const portalUrl = `${appUrl || ''}/portal/${portalKey(practice)}`;
  const key = `autobill-paper:${bill.id}`;
  let method = 'print';
  let reference = null;
  let detail = null;
  if (mailer?.enabled && mailable(guarantor) && mailable(practice)) {
    try {
      const data = await statementData(db, pid, guarantor, { family: true, since: addDays(today, -90) });
      const letter = await mailer.sendLetter({
        description: `Statement after insurance #${bill.id}`, idempotencyKey: `balance-bill-${bill.id}`,
        to: { name: `${guarantor.first_name} ${guarantor.last_name}`, address: guarantor.address, city: guarantor.city, state: guarantor.state, zip: guarantor.zip },
        from: { name: practice.name, address: practice.address, city: practice.city, state: practice.state, zip: practice.zip },
        html: statementHtml({ practice, account: guarantor, entries: data.entries, previousBalance: data.previous_balance, balance: data.balance, pendingInsurance: pending.insurance, pendingWriteOff: pending.write_off, portalUrl, statementDate: today, aging: data.aging, plans: data.plans }),
      });
      method = 'mail';
      reference = letter.reference;
      detail = letter.expected_delivery_date ? `Expected ${letter.expected_delivery_date}` : null;
    } catch (err) {
      // Not sent: tried again on the next pass (the mail service's idempotency key makes a retry safe), and after
      // three tries it's a Needs attention item.
      const attempts = (await db.get('SELECT paper_attempts FROM balance_bills WHERE id = ?', bill.id)).paper_attempts;
      await db.run('UPDATE balance_bills SET paper_status = ?, paper_error = ? WHERE id = ?', attempts >= 3 ? 'failed' : null, String(err.message).slice(0, 300), bill.id);
      await db.run('UPDATE statement_runs SET accounts = 0, total = 0 WHERE id = ?', runId);
      if (attempts >= 3) {
        await raiseIssue(db, {
          practiceId: pid, kind: 'message', key, role: 'billing', entity: 'balance_bills', entityId: bill.id, patientId: bill.patient_id,
          title: `The paper statement to ${guarantor.first_name} ${guarantor.last_name} couldn’t be mailed`, detail: err.message,
        });
      }
      return false;
    }
  }
  await insert(db, 'statement_deliveries', { practice_id: pid, run_id: runId, patient_id: bill.patient_id, method, amount, reference, status: method === 'print' ? 'to_print' : 'sent', detail });
  await db.run(`UPDATE statement_runs SET ${method === 'mail' ? 'mailed' : 'printed'} = 1 WHERE id = ?`, runId);
  await db.run("UPDATE patients SET statement_sent_at = datetime('now') WHERE id = ?", bill.patient_id);
  await db.run("UPDATE balance_bills SET paper_status = ?, paper_reference = ?, paper_at = datetime('now'), statement_run_id = ?, paper_error = NULL WHERE id = ?", method === 'mail' ? 'sent' : 'to_print', reference, runId, bill.id);
  if (method === 'print') {
    // No mail service (or no address): the office prints it — a task, so it isn't forgotten.
    await insert(db, 'tasks', {
      practice_id: pid, patient_id: bill.patient_id, priority: 'normal', due_date: today,
      title: `Print and mail a statement to ${guarantor.first_name} ${guarantor.last_name}${mailable(guarantor) ? '' : ' (no mailing address on file)'}`.slice(0, 200),
      notes: 'Their balance after insurance hasn’t been paid and the pay link wasn’t opened. Print it from the patient’s Statement page.',
    });
  }
  await resolveIssue(db, pid, key, 'Resolved: the statement went');
  await audit(db, { user: { practice_id: pid, id: null } }, 'balance_bill.paper', 'balance_bills', bill.id, { method, amount, reference, statement_run_id: runId }, { patientId: bill.patient_id });
  return true;
}

// ---- The pay link (public: the patient's own link from the text or email) ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dollars = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export async function billForToken(db, secret, token) {
  const link = await verifyLink(db, secret, token);
  const e = await db.get('SELECT * FROM cadence_enrollments WHERE id = ? AND practice_id = ?', link.enrollment_ids[0], link.practice_id);
  if (!e || e.source_type !== 'balance_bill') throw new HttpError(404, 'This link is not valid');
  const bill = await db.get('SELECT * FROM balance_bills WHERE id = ? AND practice_id = ?', e.source_id, link.practice_id);
  if (!bill) throw new HttpError(404, 'This link is not valid');
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', bill.practice_id);
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', bill.patient_id);
  return { link, bill, practice, patient, amount: Math.max(0, await accountPortion(db, bill.practice_id, bill.patient_id)) };
}
export async function markOpened(db, { link, bill }, userAgent) {
  if (PREVIEW_BOTS.test(String(userAgent || ''))) return false; // a messaging app fetching a preview isn't the patient
  await db.run("UPDATE cadence_links SET opened_at = COALESCE(opened_at, datetime('now')) WHERE id = ?", link.id);
  const { changes } = await db.run("UPDATE balance_bills SET link_opened_at = datetime('now') WHERE id = ? AND link_opened_at IS NULL", bill.id);
  return !!changes;
}
export function payPage({ practice, patient, amount, canPay, portalUrl }) {
  const body = amount <= 0
    ? `<h2>You’re all paid up</h2><p>Thank you, ${esc(patient.first_name)} — there’s nothing to pay on your account at ${esc(practice.name)}.</p>`
    : `<h2>Your balance after insurance</h2><p>${esc(patient.first_name)}, your insurance has paid its part. What’s left on your account at ${esc(practice.name)}:</p>
<p style="font-size:34px;font-weight:700;margin:10px 0 18px">${dollars(amount)}</p>
${canPay ? `<form method="post"><button type="submit" style="padding:12px 18px;border:0;border-radius:10px;background:#0d9488;color:#fff;font-size:17px;font-weight:600;cursor:pointer;width:100%">Pay ${dollars(amount)} securely</button></form>`
    : `<p><a href="${esc(portalUrl)}" style="display:block;text-align:center;padding:12px 18px;border-radius:10px;background:#0d9488;color:#fff;font-size:17px;font-weight:600;text-decoration:none">Pay in your patient portal</a></p>`}
<p style="color:#555">Questions, or rather pay over time? Call us${practice.phone ? ` at <a href="tel:${esc(practice.phone)}">${esc(practice.phone)}</a>` : ''} — we’re happy to help.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(practice.name)} — your balance</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f7f6;margin:0;padding:24px;color:#111">
<main style="max-width:440px;margin:0 auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)"><p style="color:#0f766e;font-weight:600;margin:0 0 6px">${esc(practice.name)}</p>${body}</main></body></html>`;
}
