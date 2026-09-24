import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, findOr404, audit, practiceNow, paged, recorded } from '../util.js';
import { agingReport } from '../aging.js';
import { preferredChannel, sendMessage } from '../messaging.js';

// Collections: past-due accounts (families, by their guarantor), reminder letters at 30/60/90 days,
// monthly finance charges and late fees, referral to a collection agency, and bad-debt write-off.
export const STAGES = ['letter_30', 'letter_60', 'letter_90', 'agency', 'written_off'];
const LETTERS = {
  letter_30: { title: 'Friendly reminder', text: 'Our records show a balance of {amount} on your account with {practice} that is now past due. If you have already paid, thank you. Otherwise, please pay by phone at {phone} or through your patient portal.' },
  letter_60: { title: 'Second notice', text: 'Your balance of {amount} with {practice} is now more than 60 days past due. Please pay it or call us at {phone} to set up a payment plan.' },
  letter_90: { title: 'Final notice', text: 'Your balance of {amount} with {practice} is more than 90 days past due. Unless we hear from you within 10 days, your account may be sent to a collection agency. Please call {phone} to pay or make arrangements.' },
};
const dollars = (c) => `$${(c / 100).toFixed(2)}`;
export const letterText = (stage, vars) => LETTERS[stage].text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

// Past-due accounts with what's been done so far and the suggested next step.
export async function collectionsList(db, pid) {
  const today = (await practiceNow(db, pid)).slice(0, 10);
  const { rows } = await agingReport(db, pid, today, { family: true });
  const overdueOf = (r) => Math.min(r.patient_portion, r.d31_60 + r.d61_90 + r.d90_plus);
  // Looked up for every account at once (three grouped queries, however many accounts there are).
  const info = new Map((await db.all('SELECT id, guarantor_id, collection_status, email, address, city, state, zip FROM patients WHERE practice_id = ?', pid)).map((p) => [p.id, p]));
  const lastAction = new Map((await db.all(
    'SELECT patient_id, action, created_at FROM collection_actions WHERE id IN (SELECT MAX(id) FROM collection_actions WHERE practice_id = ? GROUP BY patient_id)', pid,
  )).map((a) => [a.patient_id, a]));
  // The latest payment by anyone in each household.
  const lastPaid = new Map();
  for (const x of await db.all("SELECT patient_id, MAX(entry_date) AS d FROM ledger_entries WHERE practice_id = ? AND type = 'payment' AND voided_at IS NULL GROUP BY patient_id", pid)) {
    const account = info.get(x.patient_id)?.guarantor_id ?? x.patient_id;
    if (!lastPaid.has(account) || x.d > lastPaid.get(account)) lastPaid.set(account, x.d);
  }
  const out = [];
  for (const r of rows) {
    // Only what the patient owes counts; money expected from insurance isn't past due from them.
    const overdue = overdueOf(r);
    const { id: _id, guarantor_id: _g, ...p } = info.get(r.id) || {};
    if (overdue <= 0 && !p.collection_status) continue;
    const last = lastAction.get(r.id);
    const paid = { d: lastPaid.get(r.id) ?? null };
    const age = r.d90_plus > 0 ? 90 : r.d61_90 > 0 ? 60 : r.d31_60 > 0 ? 30 : 0;
    const done = STAGES.indexOf(p.collection_status);
    const due = age >= 90 ? 'letter_90' : age >= 60 ? 'letter_60' : age >= 30 ? 'letter_30' : null;
    let next = due && STAGES.indexOf(due) > done ? due : null;
    if (!next && p.collection_status === 'letter_90' && age >= 90) next = 'agency';
    out.push({ ...r, ...p, overdue, age, last_action: last?.action ?? null, last_action_at: last?.created_at ?? null, last_payment: paid?.d ?? null, next });
  }
  return out.sort((a, b) => b.age - a.age || b.overdue - a.overdue);
}

export default function collectionRoutes({ db, messenger }) {
  const r = Router();
  const account = async (req) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    return p.guarantor_id ? await db.get('SELECT * FROM patients WHERE id = ?', p.guarantor_id) : p;
  };
  const record = async (req, patientId, action, extra = {}) => {
    const id = await insert(db, 'collection_actions', { practice_id: req.user.practice_id, patient_id: patientId, action, created_by: req.user.id, ...extra });
    await audit(db, req, `collections.${action}`, 'patients', patientId, extra.amount != null ? { amount: extra.amount } : undefined);
    return id;
  };

  r.get('/collections', requirePermission('billing:read'), async (req, res) => {
    const practice = await db.get('SELECT finance_charge_bps, finance_charge_min, late_fee, collection_agency FROM practices WHERE id = ?', req.user.practice_id);
    const accounts = await collectionsList(db, req.user.practice_id);
    // patient_id on each row: office-limited staff see only their offices' accounts (officeAccess filters by it).
    res.json({ settings: practice, accounts: paged(req, res, accounts).map((a) => ({ ...a, patient_id: a.id })), total_accounts: accounts.length, total_overdue: accounts.reduce((s, a) => s + a.overdue, 0) });
  });

  r.get('/collections/:id', requirePermission('billing:read'), async (req, res) => {
    const acct = await account(req);
    const row = (await collectionsList(db, req.user.practice_id)).find((x) => x.id === acct.id) || null;
    const practice = await db.get('SELECT name, address, city, state, zip, phone FROM practices WHERE id = ?', req.user.practice_id);
    const vars = { amount: dollars(row?.overdue || 0), practice: practice.name, phone: practice.phone || 'the office' };
    res.json({
      account: { id: acct.id, first_name: acct.first_name, last_name: acct.last_name, address: acct.address, city: acct.city, state: acct.state, zip: acct.zip, collection_status: acct.collection_status },
      aging: row,
      practice,
      letters: Object.fromEntries(Object.entries(LETTERS).map(([k, v]) => [k, { title: v.title, body: letterText(k, vars) }])),
      history: await db.all(
        'SELECT c.*, u.name AS by_name FROM collection_actions c LEFT JOIN users u ON u.id = c.created_by WHERE c.patient_id = ? ORDER BY c.id DESC', acct.id,
      ),
    });
  });

  // A reminder letter: recorded, and sent by email or text when the patient can get one (print it otherwise).
  r.post('/collections/:id/letter', requirePermission('billing:write'), async (req, res) => {
    const acct = await account(req);
    const stage = req.body?.stage;
    if (!LETTERS[stage]) throw new HttpError(400, 'stage must be letter_30, letter_60 or letter_90');
    const row = (await collectionsList(db, req.user.practice_id)).find((x) => x.id === acct.id);
    if (!row || row.overdue <= 0) throw new HttpError(409, 'This account has nothing past due');
    const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', req.user.practice_id);
    const body = letterText(stage, { amount: dollars(row.overdue), practice: practice.name, phone: practice.phone || 'the office' });
    let message = null;
    const target = req.body?.send === false ? null : preferredChannel(acct, req.body?.send === 'auto' || req.body?.send == null ? undefined : req.body.send);
    if (target) {
      message = await sendMessage(db, messenger, {
        practiceId: req.user.practice_id, patientId: acct.id, userId: req.user.id, kind: 'collections', channel: target.channel, to: target.to,
        subject: `${LETTERS[stage].title}: your account with ${practice.name}`, body: `Hi ${acct.first_name}, ${body.charAt(0).toLowerCase()}${body.slice(1)}`,
      });
    }
    await record(req, acct.id, stage, { amount: row.overdue, message_id: message?.id ?? null });
    await recorded(db, 'patients', acct.id, () => db.run('UPDATE patients SET collection_status = ? WHERE id = ?', stage, acct.id));
    res.status(201).json({ stage, amount: row.overdue, body, message });
  });

  // Hand the account to a collection agency (optionally writing the balance off as bad debt now).
  r.post('/collections/:id/agency', requirePermission('billing:write'), async (req, res) => {
    const acct = await account(req);
    const agency = String(req.body?.agency || (await db.get('SELECT collection_agency FROM practices WHERE id = ?', req.user.practice_id)).collection_agency || '').trim();
    if (!agency) throw new HttpError(400, 'Which agency? Set one in Collections settings or type it in');
    const row = (await collectionsList(db, req.user.practice_id)).find((x) => x.id === acct.id);
    await record(req, acct.id, 'agency', { amount: row?.overdue ?? null, note: agency.slice(0, 200) });
    await recorded(db, 'patients', acct.id, () => db.run("UPDATE patients SET collection_status = 'agency' WHERE id = ?", acct.id));
    if (req.body?.write_off) await writeOff(req, { ...acct, collection_status: 'agency' }, `Sent to ${agency}`);
    res.status(201).json({ ok: true });
  });

  // Bad-debt write-off: an adjustment for the patient's part of the balance (administrators).
  const writeOff = async (req, acct, note) => {
    const row = (await collectionsList(db, req.user.practice_id)).find((x) => x.id === acct.id);
    const amount = row?.patient_portion || 0;
    if (amount <= 0) throw new HttpError(409, 'Nothing to write off');
    await insert(db, 'ledger_entries', {
      practice_id: req.user.practice_id, location_id: req.location_id, patient_id: acct.id, type: 'adjustment', adjustment_type: 'Bad debt write-off', amount: -amount,
      description: `Bad debt write-off${note ? ` — ${note}` : ''}`.slice(0, 300), entry_date: (await practiceNow(db, req.user.practice_id)).slice(0, 10), created_by: req.user.id,
    });
    await record(req, acct.id, 'written_off', { amount, note: note || null });
    if (acct.collection_status !== 'agency') await recorded(db, 'patients', acct.id, () => db.run("UPDATE patients SET collection_status = 'written_off' WHERE id = ?", acct.id));
    return amount;
  };
  r.post('/collections/:id/write-off', requirePermission('billing:write'), async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can write off bad debt');
    const acct = await account(req);
    res.status(201).json({ amount: await writeOff(req, acct, String(req.body?.note || '').trim()) });
  });

  // Paid up, or on a payment plan: take the account out of collections.
  r.post('/collections/:id/clear', requirePermission('billing:write'), async (req, res) => {
    const acct = await account(req);
    await recorded(db, 'patients', acct.id, () => db.run('UPDATE patients SET collection_status = NULL WHERE id = ?', acct.id));
    await record(req, acct.id, 'cleared', { note: String(req.body?.note || '').trim().slice(0, 300) || null });
    res.json({ ok: true });
  });

  // Monthly finance charges and late fees on past-due patient balances. Preview first; each account is
  // charged at most once a calendar month, and accounts at an agency or written off are left alone.
  r.post('/collections/charges', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const s = await db.get('SELECT finance_charge_bps, finance_charge_min, late_fee FROM practices WHERE id = ?', pid);
    if (!s.finance_charge_bps && !s.late_fee) throw new HttpError(400, 'Set a finance charge or late fee first');
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const month = today.slice(0, 7);
    const out = [];
    for (const a of await collectionsList(db, pid)) {
      if (a.overdue <= 0 || ['agency', 'written_off'].includes(a.collection_status)) continue;
      const charged = await db.get("SELECT 1 AS x FROM collection_actions WHERE patient_id = ? AND action IN ('finance_charge','late_fee') AND substr(created_at, 1, 7) = ?", a.id, month);
      if (charged) continue;
      const finance = s.finance_charge_bps ? Math.max(Math.round((a.overdue * s.finance_charge_bps) / 10000), s.finance_charge_min || 0) : 0;
      // A late fee only when nothing's been paid in the last month.
      const recent = a.last_payment && a.last_payment >= new Date(Date.parse(`${today}T12:00:00Z`) - 30 * 86400_000).toISOString().slice(0, 10);
      const late = s.late_fee && !recent ? s.late_fee : 0;
      if (finance || late) out.push({ patient_id: a.id, first_name: a.first_name, last_name: a.last_name, overdue: a.overdue, finance_charge: finance, late_fee: late });
    }
    if (req.body?.post) {
      await db.tx(async () => {
        for (const c of out) {
          for (const [kind, amount, label] of [['finance_charge', c.finance_charge, 'Finance charge'], ['late_fee', c.late_fee, 'Late fee']]) {
            if (!amount) continue;
            await insert(db, 'ledger_entries', {
              practice_id: pid, patient_id: c.patient_id, type: 'adjustment', adjustment_type: label, amount,
              description: `${label} on past-due balance of ${dollars(c.overdue)}`, entry_date: today, created_by: req.user.id,
            });
            await record(req, c.patient_id, kind, { amount });
          }
        }
      });
    }
    res.json({ posted: !!req.body?.post, accounts: out, total: out.reduce((t, c) => t + c.finance_charge + c.late_fee, 0) });
  });

  return r;
}
