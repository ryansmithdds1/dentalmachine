import express, { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, change, update, audit, practiceNow, requireDate, findOr404, toCents } from '../util.js';
import { restricted } from '../officeaccess.js';
import { PdfDoc } from '../pdf.js';
import { raiseIssue, resolveIssue } from '../issues.js';
import {
  DENOMINATIONS, countCash, reconcileDeposit, resolveOffice, waitingEntries, checkLines, dayLedger, electronicDeposits, syncCashReceipts,
  assignCashReceipt, drawerExpected, sessionView, userNames, cashSettings, flag, depositSeparation, slipExceptions, depositWatch, cashIntegrity,
  isManager, requireManager, requireOwner, overShortLabel, businessDaysAfter, parse,
} from '../deposits.js';

// Deposits and cash handling (DC1-DC3, docs/cash-handling.md): the day's deposit built from what was taken and
// checked against the ledger, locked once submitted, verified by a second person and followed to the bank; cash
// drawers with blind counts; numbered cash receipts; the owner's Cash integrity report.
// Permissions: taking and counting money = billing:write; verifying, reopening, approving = a manager (admin or
// deposits:manage); the Cash integrity report = the owner (administrator).
export default function cashDepositRoutes({ db, storage = null }) {
  const r = Router();
  const today = async (pid) => (await practiceNow(db, pid)).slice(0, 10);
  const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;
  const idOf = (v, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be an id`);
    return n;
  };
  const dateParam = async (req, v) => {
    const d = v ? requireDate(v, 'date') : await today(req.user.practice_id);
    if (d > await today(req.user.practice_id)) throw new HttpError(400, 'That date is in the future');
    return d;
  };
  // Records at an office the person isn't allowed at answer as if they didn't exist.
  const hideOtherOffice = (req, row, label) => {
    if (row.location_id != null && restricted(req.user) && !req.user.location_ids.includes(row.location_id)) throw new HttpError(404, `${label} not found`);
    return row;
  };
  const slipOr404 = async (req) => {
    const s = await db.get('SELECT * FROM deposit_slips WHERE deposit_id = ? AND practice_id = ?', idOf(req.params.id, 'Deposit'), req.user.practice_id);
    if (!s) throw new HttpError(404, 'Deposit not found');
    return hideOtherOffice(req, s, 'Deposit');
  };

  // The whole deposit as the screen and the slip show it.
  async function depositDetail(pid, depositId) {
    const slip = await db.get('SELECT * FROM deposit_slips WHERE deposit_id = ? AND practice_id = ?', depositId, pid);
    const d = await db.get('SELECT * FROM deposits WHERE id = ?', depositId);
    const names = await userNames(db, pid);
    const items = await db.all(
      `SELECT i.*, l.voided_at FROM deposit_slip_items i JOIN ledger_entries l ON l.id = i.ledger_entry_id WHERE i.deposit_id = ? ORDER BY i.kind, i.id`, depositId,
    );
    const { late_business_days: lateDays } = await cashSettings(db, pid);
    const exceptions = slipExceptions(slip, d, { today: await today(pid), lateDays, voidedItems: items.filter((i) => i.voided_at).length });
    const photos = await db.all('SELECT id, mime, size, uploaded_by, created_at FROM deposit_photos WHERE deposit_id = ? ORDER BY id', depositId);
    const location = slip.location_id ? await db.get('SELECT id, name FROM locations WHERE id = ?', slip.location_id) : null;
    return {
      id: depositId, deposit_id: depositId, business_date: slip.business_date, deposit_date: d.deposit_date, location, location_id: slip.location_id,
      stage: slip.stage, status: exceptions.length ? 'exception' : slip.stage, exceptions,
      total: d.total, cash_total: slip.cash_total, check_total: slip.check_total, cash_source: slip.cash_source, cash_count: parse(slip.cash_count, {}),
      ledger_total: slip.ledger_total, difference: slip.difference, left_out_total: slip.left_out_total, difference_reason: slip.difference_reason,
      bag_number: slip.bag_number, prepared_by: slip.prepared_by, prepared_by_name: names[slip.prepared_by] || null, submitted_at: slip.submitted_at,
      verified_by: slip.verified_by, verified_by_name: names[slip.verified_by] || null, verified_at: slip.verified_at,
      bank_amount: d.bank_amount, bank_date: d.bank_date, bank_status: d.status, bank_note: slip.bank_note,
      reopened_by_name: names[slip.reopened_by] || null, reopened_at: slip.reopened_at, reopen_reason: slip.reopen_reason, replaces_deposit_id: slip.replaces_deposit_id,
      replaced_by: slip.stage === 'reopened' ? (await db.get('SELECT deposit_id FROM deposit_slips WHERE replaces_deposit_id = ?', depositId))?.deposit_id ?? null : null,
      separation: await depositSeparation(db, slip, items, names),
      items: items.map((i) => ({ ...i, taken_by_name: names[i.taken_by] || null, voided: !!i.voided_at })),
      checks: checkLines(items.filter((i) => i.kind === 'check').map((i) => ({ ...i, id: i.ledger_entry_id, patient_name: i.payer, type: 'payment' }))),
      photos,
    };
  }

  // ---- DC1: the day's deposit ----

  // Everything needed to build the deposit for a day and office: checks one by one, the cash the ledger says was
  // taken, drawers closed that day, card batches and EFTs (separate, from the processor and ERAs), and the day's
  // ledger totals. Nothing here is saved.
  r.get('/daily-deposits/build', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const date = await dateParam(req, req.query.date);
    const office = await resolveOffice(db, req.user, req.query.location_id, req.location_id);
    await syncCashReceipts(db, pid);
    const entries = await waitingEntries(db, pid, office, date);
    const drawerWhere = office == null ? '' : ' AND (s.location_id = ? OR s.location_id IS NULL)';
    const drawers = (await db.all(
      `SELECT s.id, s.status, s.to_deposit, s.float_kept, s.counted_total, d.name FROM cash_drawer_sessions s JOIN cash_drawers d ON d.id = s.drawer_id
       WHERE s.practice_id = ? AND s.business_date = ? AND s.deposit_id IS NULL${drawerWhere} ORDER BY d.name`, pid, date, ...(office == null ? [] : [office]),
    )).map((s) => ({ id: s.id, name: s.name, status: s.status, to_deposit: s.status === 'closed' ? s.to_deposit : null }));
    const cash = entries.filter((e) => e.kind !== 'check');
    res.json({
      date, location_id: office, denominations: DENOMINATIONS.map(([key, cents, label]) => ({ key, cents, label })),
      checks: checkLines(entries), cash_entries: cash,
      cash_expected: cash.reduce((s, e) => s + e.amount, 0), entries: entries.map((e) => ({ id: e.id, kind: e.kind, amount: e.amount, earlier: e.earlier })),
      drawers, drawers_open: drawers.filter((d) => d.status !== 'closed').length,
      day_ledger: await dayLedger(db, pid, office, date),
      electronic: await electronicDeposits(db, pid, office, date),
      reopened: await db.all("SELECT deposit_id, business_date, reopen_reason FROM deposit_slips s WHERE practice_id = ? AND stage = 'reopened' AND NOT EXISTS (SELECT 1 FROM deposit_slips x WHERE x.replaces_deposit_id = s.deposit_id) ORDER BY deposit_id DESC LIMIT 5", pid),
    });
  });

  // Submit the deposit: the server works everything out again from the ledger, refuses a deposit that doesn't
  // balance unless a reason is given, and locks it. The same submit_key again returns the first deposit.
  r.post('/daily-deposits', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const b = req.body || {};
    const key = String(b.submit_key || '').trim();
    if (!/^[\w-]{8,80}$/.test(key)) throw new HttpError(400, 'submit_key is required (a random id made when the deposit screen opened)');
    const replay = async () => {
      const had = await db.get('SELECT deposit_id FROM deposit_slips WHERE practice_id = ? AND submit_key = ?', pid, key);
      return had ? res.status(200).json({ ...(await depositDetail(pid, had.deposit_id)), replayed: true }) : null;
    };
    if (await replay()) return;
    const date = await dateParam(req, b.business_date);
    const office = await resolveOffice(db, req.user, b.location_id, req.location_id);
    if (!Array.isArray(b.entry_ids)) throw new HttpError(400, 'entry_ids must be a list');
    const ids = [...new Set(b.entry_ids.map((v) => idOf(v, 'entry_ids')))];
    const bag = text(b.bag_number, 40);
    if (!bag) throw new HttpError(400, 'Enter the bag or deposit slip number');
    const reason = text(b.difference_reason, 500);
    const sessionIds = Array.isArray(b.drawer_session_ids) ? [...new Set(b.drawer_session_ids.map((v) => idOf(v, 'drawer_session_ids')))] : null;
    let replaces = null;
    if (b.replaces_deposit_id != null) {
      replaces = await db.get('SELECT * FROM deposit_slips WHERE deposit_id = ? AND practice_id = ?', idOf(b.replaces_deposit_id, 'replaces_deposit_id'), pid);
      if (!replaces || replaces.stage !== 'reopened') throw new HttpError(400, 'Only a reopened deposit can be replaced');
      if (await db.get('SELECT id FROM deposit_slips WHERE replaces_deposit_id = ?', replaces.deposit_id)) throw new HttpError(409, 'That reopened deposit was already replaced');
    }
    await syncCashReceipts(db, pid);
    let out;
    try {
      out = await db.tx(async () => {
        const entries = await waitingEntries(db, pid, office, date);
        const known = new Set(entries.map((e) => e.id));
        if (ids.some((id) => !known.has(id))) throw new HttpError(409, 'Some of those payments are already on a deposit, were voided, or belong to another day or office — refresh and try again');
        let cashCounted;
        let cashDetail = null;
        let sessions = [];
        if (sessionIds) {
          sessions = sessionIds.length ? await db.all(`SELECT * FROM cash_drawer_sessions WHERE practice_id = ? AND id IN (${sessionIds.map(() => '?').join(',')})`, pid, ...sessionIds) : [];
          if (sessions.length !== sessionIds.length) throw new HttpError(404, 'Drawer not found');
          for (const s of sessions) {
            if (s.status !== 'closed') throw new HttpError(409, 'A drawer on this deposit hasn’t been counted and verified yet');
            if (s.deposit_id) throw new HttpError(409, 'That drawer’s cash is already on a deposit');
            if (office != null && s.location_id != null && s.location_id !== office) throw new HttpError(400, 'That drawer is at another office');
          }
          cashCounted = sessions.reduce((s, x) => s + x.to_deposit, 0);
        } else {
          const c = countCash(b.cash_count || {});
          cashCounted = c.total;
          cashDetail = c.detail;
        }
        const rec = reconcileDeposit({ entries, included: ids, cashCounted });
        if (!ids.length && !cashCounted) throw new HttpError(400, 'There’s nothing on this deposit');
        if (!rec.balanced && !reason) throw new HttpError(400, 'This deposit doesn’t match the ledger — say why before submitting', { needs_reason: true, ...rec });
        const depositId = await insert(db, 'deposits', {
          practice_id: pid, location_id: office, deposit_date: await today(pid), total: rec.total, reference: bag, notes: reason, created_by: req.user.id,
        });
        if (ids.length) {
          const moved = await db.run(`UPDATE ledger_entries SET deposit_id = ? WHERE practice_id = ? AND deposit_id IS NULL AND id IN (${ids.map(() => '?').join(',')})`, depositId, pid, ...ids);
          if (moved.changes !== ids.length) throw new HttpError(409, 'Some of those payments were just put on another deposit — refresh and try again');
        }
        await insert(db, 'deposit_slips', {
          practice_id: pid, deposit_id: depositId, location_id: office, business_date: date, submit_key: key, cash_total: cashCounted, check_total: rec.check_total,
          cash_count: cashDetail ? JSON.stringify(cashDetail) : null, cash_source: sessionIds ? 'drawers' : 'counted', ledger_total: rec.ledger_total,
          difference: rec.difference, left_out_total: rec.left_out_total, difference_reason: rec.balanced ? null : reason, bag_number: bag, prepared_by: req.user.id,
          replaces_deposit_id: replaces?.deposit_id ?? null,
        });
        const byId = new Map(entries.map((e) => [e.id, e]));
        for (const id of ids) {
          const e = byId.get(id);
          await insert(db, 'deposit_slip_items', {
            practice_id: pid, deposit_id: depositId, ledger_entry_id: id, kind: e.kind, amount: e.amount, check_number: e.kind === 'check' ? text(e.check_number, 50) : null,
            payer: text(e.payer, 120), patient_id: e.patient_id, entry_date: e.entry_date, taken_by: e.taken_by ?? null,
          });
        }
        for (const s of sessions) await change(db, 'cash_drawer_sessions', s.id, { deposit_id: depositId });
        return { depositId, rec };
      });
    } catch (err) {
      // Two submits of the same deposit at once: the second finds the first's.
      if (await replay()) return;
      throw err;
    }
    const detail = await depositDetail(pid, out.depositId);
    await audit(db, req, 'deposit.submit', 'deposits', out.depositId, {
      business_date: date, total: out.rec.total, cash: out.rec.cash_counted, checks: out.rec.check_total, ledger_total: out.rec.ledger_total,
      difference: out.rec.difference, left_out: out.rec.left_out_total, bag_number: bag, items: ids.length, replaces: replaces?.deposit_id ?? null,
      separation: detail.separation.map((f) => f.kind),
    }, { reason: out.rec.balanced ? null : reason, locationId: office });
    if (!out.rec.balanced) {
      await flag(db, { practice_id: pid, location_id: office, kind: 'deposit_difference', dedupe_key: `deposit-difference:${out.depositId}`, user_id: req.user.id, deposit_id: out.depositId, amount: out.rec.difference, detail: reason });
    }
    res.status(201).json(detail);
  });

  // Deposits over a range (newest first), with where each stands and anything wrong, plus the card batches and
  // EFTs for the same days. Runs the bank check first so the chips are current.
  r.get('/daily-deposits', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const to = req.query.to ? requireDate(req.query.to, 'to') : await today(pid);
    const from = req.query.from ? requireDate(req.query.from, 'from') : new Date(Date.parse(`${to}T12:00:00Z`) - 30 * 86400_000).toISOString().slice(0, 10);
    await depositWatch(db, pid);
    const office = req.query.location_id ? await resolveOffice(db, req.user, req.query.location_id) : null;
    const rows = await db.all(
      `SELECT s.deposit_id FROM deposit_slips s WHERE s.practice_id = ? AND s.business_date BETWEEN ? AND ?${office ? ' AND s.location_id = ?' : ''}
       ORDER BY s.business_date DESC, s.deposit_id DESC LIMIT 400`, pid, from, to, ...(office ? [office] : []),
    );
    const deposits = [];
    for (const { deposit_id: id } of rows) {
      const d = await depositDetail(pid, id);
      if (d.location_id != null && restricted(req.user) && !req.user.location_ids.includes(d.location_id)) continue;
      const { items: _items, checks: _checks, ...summary } = d;
      deposits.push({ ...summary, items: d.items.length });
    }
    const electronic = [];
    const { late_business_days: lateDays } = await cashSettings(db, pid);
    const now = await today(pid);
    for (let t = Date.parse(`${to}T12:00:00Z`); t >= Date.parse(`${from}T12:00:00Z`) && electronic.length < 400; t -= 86400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      for (const e of await electronicDeposits(db, pid, office, day)) {
        electronic.push({ ...e, status: e.in_bank ? 'in_bank' : businessDaysAfter(day, now) > lateDays ? 'exception' : 'taken' });
      }
    }
    res.json({ from, to, deposits, electronic });
  });

  r.get('/daily-deposits/:id', requirePermission('billing:read'), async (req, res) => {
    const slip = await slipOr404(req);
    res.json(await depositDetail(req.user.practice_id, slip.deposit_id));
  });

  // Submitted deposits are locked: corrections are a manager's reopen (the original is kept), never an edit.
  r.patch('/daily-deposits/:id', requirePermission('billing:write'), async (req) => {
    await slipOr404(req);
    throw new HttpError(409, 'A submitted deposit is locked. A manager can reopen it with a reason, and a new deposit replaces it.');
  });

  // The second person: a manager who didn't prepare it confirms the bag matches the slip.
  r.post('/daily-deposits/:id/verify', requirePermission('billing:read'), requireManager, async (req, res) => {
    const slip = await slipOr404(req);
    if (slip.stage === 'reopened') throw new HttpError(409, 'This deposit was reopened');
    if (slip.verified_by) throw new HttpError(409, 'Already verified');
    if (slip.prepared_by === req.user.id) throw new HttpError(403, 'Someone other than the person who prepared the deposit has to verify it');
    await change(db, 'deposit_slips', slip.id, { verified_by: req.user.id, verified_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    await audit(db, req, 'deposit.verify', 'deposits', slip.deposit_id, { prepared_by: slip.prepared_by }, { locationId: slip.location_id });
    await depositWatch(db, req.user.practice_id);
    res.json(await depositDetail(req.user.practice_id, slip.deposit_id));
  });

  // A correction: the deposit is reopened (voided and kept, with who and why) and its payments go back to the
  // waiting list for a new deposit that replaces it. Not once the bank has it — undo the bank match first.
  r.post('/daily-deposits/:id/reopen', requirePermission('billing:read'), requireManager, async (req, res) => {
    const slip = await slipOr404(req);
    const reason = text(req.body?.reason, 300);
    if (!reason) throw new HttpError(400, 'Say why the deposit is being reopened');
    if (slip.stage === 'reopened') throw new HttpError(409, 'Already reopened');
    const d = await db.get('SELECT * FROM deposits WHERE id = ?', slip.deposit_id);
    if (d.status !== 'open') throw new HttpError(409, 'The bank already shows this deposit — undo the bank match in Finance first, or record the difference instead');
    const entries = (await db.all('SELECT id FROM ledger_entries WHERE deposit_id = ?', d.id)).map((e) => e.id);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await db.tx(async () => {
      await db.run('UPDATE ledger_entries SET deposit_id = NULL WHERE deposit_id = ?', d.id);
      await update(db, 'deposits', d.id, req.user.practice_id, { voided_at: now, voided_by: req.user.id, void_reason: `Reopened: ${reason}` });
      await change(db, 'deposit_slips', slip.id, { stage: 'reopened', reopened_by: req.user.id, reopened_at: now, reopen_reason: reason });
      for (const s of await db.all('SELECT id FROM cash_drawer_sessions WHERE deposit_id = ?', d.id)) await change(db, 'cash_drawer_sessions', s.id, { deposit_id: null });
    });
    await audit(db, req, 'deposit.reopen', 'deposits', d.id, { total: d.total, entries, bag_number: slip.bag_number }, { reason, locationId: slip.location_id });
    for (const k of [`deposit-late:deposit:${d.id}`, `deposit-bank-diff:${d.id}`, `deposit-item-voided:${d.id}`]) await resolveIssue(db, req.user.practice_id, k, 'Resolved: the deposit was reopened');
    res.json(await depositDetail(req.user.practice_id, d.id));
  });

  // The bank's figure differs from the slip: a manager records what happened (bank error, a returned check, a
  // miscount found). The difference stays on record; the exception is closed.
  r.post('/daily-deposits/:id/bank-note', requirePermission('billing:read'), requireManager, async (req, res) => {
    const slip = await slipOr404(req);
    const note = text(req.body?.reason, 500);
    if (!note) throw new HttpError(400, 'Say what explains the difference');
    const d = await db.get('SELECT * FROM deposits WHERE id = ?', slip.deposit_id);
    if (d.status !== 'discrepancy') throw new HttpError(409, 'The bank amount matches this deposit — nothing to explain');
    await change(db, 'deposit_slips', slip.id, { bank_note: note, bank_note_by: req.user.id, bank_note_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    await audit(db, req, 'deposit.bank_difference', 'deposits', d.id, { slip: d.total, bank: d.bank_amount, difference: d.bank_amount - d.total }, { reason: note, locationId: slip.location_id });
    await flag(db, { practice_id: req.user.practice_id, location_id: slip.location_id, kind: 'bank_difference', dedupe_key: `bank-difference:${d.id}`, user_id: slip.prepared_by, approved_by: req.user.id, deposit_id: d.id, amount: d.bank_amount - d.total, detail: note });
    await depositWatch(db, req.user.practice_id);
    res.json(await depositDetail(req.user.practice_id, d.id));
  });

  r.post('/daily-deposits/check', requirePermission('billing:write'), async (req, res) => res.json(await depositWatch(db, req.user.practice_id)));

  // A photo of the stamped slip (or the bank receipt), stored encrypted like documents. Added to the record,
  // never replaced — it's evidence, so it can be added after the deposit is locked.
  const PHOTO_TYPES = { 'image/jpeg': [0xff, 0xd8], 'image/png': [0x89, 0x50], 'image/webp': [0x52, 0x49], 'application/pdf': [0x25, 0x50] };
  r.post('/daily-deposits/:id/photos', requirePermission('billing:write'), express.raw({ type: () => true, limit: '12mb' }), async (req, res) => {
    const slip = await slipOr404(req);
    if (!storage) throw new HttpError(503, 'File storage isn’t set up on this server');
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const magic = PHOTO_TYPES[mime];
    if (!magic) throw new HttpError(415, 'Upload a JPEG, PNG, WebP or PDF');
    if (!Buffer.isBuffer(req.body) || req.body.length < 16) throw new HttpError(400, 'The file is empty');
    if (req.body[0] !== magic[0] || req.body[1] !== magic[1]) throw new HttpError(415, 'That file isn’t the kind it says it is');
    const saved = await storage.save(req.user.practice_id, req.body);
    const id = await insert(db, 'deposit_photos', { practice_id: req.user.practice_id, deposit_id: slip.deposit_id, storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, mime, size: req.body.length, uploaded_by: req.user.id });
    await audit(db, req, 'deposit.photo', 'deposits', slip.deposit_id, { photo_id: id, mime, size: req.body.length }, { locationId: slip.location_id });
    res.status(201).json({ id, mime, size: req.body.length });
  });

  r.get('/daily-deposits/:id/photos/:pid', requirePermission('billing:read'), async (req, res) => {
    const slip = await slipOr404(req);
    const p = await db.get('SELECT * FROM deposit_photos WHERE id = ? AND deposit_id = ? AND practice_id = ?', idOf(req.params.pid, 'Photo'), slip.deposit_id, req.user.practice_id);
    if (!p) throw new HttpError(404, 'Photo not found');
    const data = await storage?.read(p.storage_key, !!p.encrypted);
    if (!data) throw new HttpError(404, 'File missing from storage');
    res.set({ 'Content-Type': p.mime, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' }).send(data);
  });

  // The deposit slip to print (and keep with the bag).
  r.get('/daily-deposits/:id/slip.pdf', requirePermission('billing:read'), async (req, res) => {
    const slip = await slipOr404(req);
    const d = await depositDetail(req.user.practice_id, slip.deposit_id);
    const practice = await db.get('SELECT name, address, city, state, zip FROM practices WHERE id = ?', req.user.practice_id);
    const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const doc = new PdfDoc({ footer: `${practice.name} · deposit #${d.id}` });
    doc.text(practice.name, { size: 15, bold: true, gap: 1 });
    doc.text([d.location?.name, practice.address, practice.city, practice.state, practice.zip].filter(Boolean).join(', '), { size: 9.5 });
    doc.space(6);
    doc.text(`Deposit slip · ${d.business_date}${d.bag_number ? ` · bag/slip ${d.bag_number}` : ''}`, { size: 13, bold: true });
    if (d.stage === 'reopened') doc.text(`REOPENED — replaced by a corrected deposit. Reason: ${d.reopen_reason}`, { size: 11, bold: true, color: [0.7, 0.1, 0.1] });
    doc.space(4);
    const at = [0, 0.4, 0.62, 0.8];
    doc.row(['Check from', 'Check #', 'Date', 'Amount'], { at, right: [3], bold: true });
    for (const c of d.checks) doc.row([c.payer, c.check_number || '—', c.entry_date, money(c.amount)], { at, right: [3] });
    if (!d.checks.length) doc.row(['No checks', '', '', ''], { at });
    doc.rule();
    doc.row(['Checks', `${d.checks.length}`, '', money(d.check_total)], { at, right: [3], bold: true });
    doc.space(6);
    if (d.cash_source === 'drawers') doc.row(['Cash (from the verified drawer counts)', '', '', money(d.cash_total)], { at, right: [3] });
    for (const [key, cents, label] of DENOMINATIONS) {
      const n = d.cash_count?.[key];
      if (n) doc.row([label, `× ${n}`, '', money(n * cents)], { at, right: [3] });
    }
    doc.rule();
    doc.row(['Cash', '', '', money(d.cash_total)], { at, right: [3], bold: true });
    doc.row(['Total deposit', '', '', money(d.total)], { at, right: [3], bold: true, size: 12 });
    doc.space(8);
    doc.text(`Ledger for these payments: ${money(d.ledger_total)}${d.difference ? ` · difference ${money(d.difference)}` : ''}${d.left_out_total ? ` · ${money(d.left_out_total)} held back` : ''}`, { size: 9.5 });
    if (d.difference_reason) doc.text(`Why: ${d.difference_reason}`, { size: 9.5 });
    doc.space(10);
    doc.text(`Prepared by ${d.prepared_by_name || '—'} at ${d.submitted_at} UTC`, { size: 10 });
    doc.text(d.verified_by_name ? `Verified by ${d.verified_by_name} at ${d.verified_at} UTC` : 'Verified by: ______________________   (a second person)', { size: 10 });
    await audit(db, req, 'deposit.slip_print', 'deposits', d.id, null, { locationId: slip.location_id });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="deposit-${d.business_date}-${d.id}.pdf"` }).send(doc.toBuffer());
  });

  // ---- DC3: cash drawers ----

  r.get('/cash/settings', requirePermission('billing:read'), async (req, res) => res.json({ ...(await cashSettings(db, req.user.practice_id)), manager: isManager(req.user), owner: req.user.role === 'admin' }));
  r.put('/cash/settings', requirePermission('billing:read'), requireManager, async (req, res) => {
    const pid = req.user.practice_id;
    const before = await cashSettings(db, pid);
    const late = req.body?.late_business_days != null ? Number(req.body.late_business_days) : before.late_business_days;
    const alert = req.body?.over_short_alert != null ? toCents(req.body.over_short_alert, 'over_short_alert') : before.over_short_alert;
    if (!Number.isInteger(late) || late < 1 || late > 30) throw new HttpError(400, 'late_business_days must be 1 to 30');
    if (alert < 0) throw new HttpError(400, 'over_short_alert can’t be negative');
    await db.run(`INSERT INTO cash_settings (practice_id, late_business_days, over_short_alert, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (practice_id) DO UPDATE SET late_business_days = excluded.late_business_days, over_short_alert = excluded.over_short_alert, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    pid, late, alert, req.user.id);
    await audit(db, req, 'cash.settings', 'cash_settings', pid, null, { before, after: { late_business_days: late, over_short_alert: alert } });
    res.json(await cashSettings(db, pid));
  });

  // Drawers at an office with today's session (the count stays blind until it's submitted).
  r.get('/cash/drawers', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    await syncCashReceipts(db, pid);
    const office = await resolveOffice(db, req.user, req.query.location_id, req.location_id);
    const names = await userNames(db, pid);
    const drawers = await db.all(`SELECT * FROM cash_drawers WHERE practice_id = ? AND active = 1${office != null ? ' AND (location_id = ? OR location_id IS NULL)' : ''} ORDER BY name`, pid, ...(office != null ? [office] : []));
    const out = [];
    for (const dr of drawers) {
      const current = await db.get("SELECT * FROM cash_drawer_sessions WHERE drawer_id = ? AND status <> 'closed'", dr.id);
      const last = await db.get("SELECT * FROM cash_drawer_sessions WHERE drawer_id = ? AND status = 'closed' ORDER BY id DESC LIMIT 1", dr.id);
      out.push({ ...dr, session: current ? sessionView(current, names) : null, last: last ? sessionView(last, names) : null });
    }
    const date = await today(pid);
    const unassigned = Number((await db.get(
      `SELECT COUNT(*) AS n FROM cash_receipts r JOIN real_ledger_entries l ON l.id = r.ledger_entry_id WHERE r.practice_id = ? AND r.drawer_session_id IS NULL AND r.status = 'issued' AND l.entry_date = ?`, pid, date,
    )).n);
    res.json({ drawers: out, unassigned_cash_today: unassigned, denominations: DENOMINATIONS.map(([key, cents, label]) => ({ key, cents, label })), manager: isManager(req.user) });
  });

  r.post('/cash/drawers', requirePermission('billing:read'), requireManager, async (req, res) => {
    const pid = req.user.practice_id;
    const name = text(req.body?.name, 60);
    if (!name) throw new HttpError(400, 'Name the drawer (e.g. "Front desk 1")');
    const office = await resolveOffice(db, req.user, req.body?.location_id, req.location_id);
    const float = toCents(req.body?.default_float ?? 0, 'default_float');
    if (float < 0) throw new HttpError(400, 'The float can’t be negative');
    if (await db.get('SELECT id FROM cash_drawers WHERE practice_id = ? AND lower(name) = lower(?)', pid, name)) throw new HttpError(409, 'There’s already a drawer with that name');
    const id = await insert(db, 'cash_drawers', { practice_id: pid, location_id: office, name, default_float: float, created_by: req.user.id });
    await audit(db, req, 'cash.drawer_create', 'cash_drawers', id, { name, default_float: float }, { locationId: office });
    res.status(201).json(await db.get('SELECT * FROM cash_drawers WHERE id = ?', id));
  });

  r.put('/cash/drawers/:id', requirePermission('billing:read'), requireManager, async (req, res) => {
    const dr = hideOtherOffice(req, await findOr404(db, 'cash_drawers', req.params.id, req.user.practice_id, 'Drawer'), 'Drawer');
    const patch = {};
    if (req.body?.name != null) patch.name = text(req.body.name, 60) || dr.name;
    if (req.body?.default_float != null) {
      patch.default_float = toCents(req.body.default_float, 'default_float');
      if (patch.default_float < 0) throw new HttpError(400, 'The float can’t be negative');
    }
    if (req.body?.active != null) patch.active = req.body.active ? 1 : 0;
    await update(db, 'cash_drawers', dr.id, req.user.practice_id, patch);
    await audit(db, req, 'cash.drawer_change', 'cash_drawers', dr.id, null, { locationId: dr.location_id });
    res.json(await db.get('SELECT * FROM cash_drawers WHERE id = ?', dr.id));
  });

  // Open a drawer with its float. A float that differs from what the last close left in it is flagged.
  r.post('/cash/drawers/:id/open', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const dr = hideOtherOffice(req, await findOr404(db, 'cash_drawers', req.params.id, pid, 'Drawer'), 'Drawer');
    if (!dr.active) throw new HttpError(409, 'That drawer is retired');
    const float = req.body?.opening_float != null ? toCents(req.body.opening_float, 'opening_float') : req.body?.count ? countCash(req.body.count).total : dr.default_float;
    if (float < 0) throw new HttpError(400, 'The float can’t be negative');
    const openNow = await db.get("SELECT * FROM cash_drawer_sessions WHERE drawer_id = ? AND status <> 'closed'", dr.id);
    if (openNow) throw new HttpError(409, openNow.status === 'open' ? 'This drawer is already open' : 'This drawer’s count is waiting for a second person to verify it', { session_id: openNow.id });
    let id;
    try {
      id = await insert(db, 'cash_drawer_sessions', { practice_id: pid, drawer_id: dr.id, location_id: dr.location_id, business_date: await today(pid), opening_float: float, opened_by: req.user.id });
    } catch (err) {
      if (/unique|duplicate/i.test(err.message)) throw new HttpError(409, 'This drawer is already open');
      throw err;
    }
    const last = await db.get("SELECT id, float_kept FROM cash_drawer_sessions WHERE drawer_id = ? AND status = 'closed' ORDER BY id DESC LIMIT 1", dr.id);
    if (last && last.float_kept != null && last.float_kept !== float) {
      await flag(db, { practice_id: pid, location_id: dr.location_id, kind: 'float_mismatch', dedupe_key: `float:${id}`, user_id: req.user.id, session_id: id, amount: float - last.float_kept, detail: `${dr.name}: opened with ${float} cents; the last close left ${last.float_kept}` });
    }
    await audit(db, req, 'cash.drawer_open', 'cash_drawer_sessions', id, { drawer: dr.name, opening_float: float }, { locationId: dr.location_id });
    res.status(201).json(sessionView(await db.get('SELECT * FROM cash_drawer_sessions WHERE id = ?', id), await userNames(db, pid)));
  });

  const sessionOr404 = async (req) => hideOtherOffice(req, await findOr404(db, 'cash_drawer_sessions', req.params.id, req.user.practice_id, 'Drawer session'), 'Drawer session');

  r.get('/cash/sessions/:id', requirePermission('billing:read'), async (req, res) => {
    const s = await sessionOr404(req);
    const view = sessionView(s, await userNames(db, req.user.practice_id));
    // Once counted, the receipts that made up the expected amount can be looked at.
    if (s.status !== 'open') {
      view.receipts = await db.all('SELECT r.receipt_no, r.kind, r.amount, r.status, r.ledger_entry_id, r.patient_id FROM cash_receipts r WHERE r.drawer_session_id = ? ORDER BY r.receipt_no', s.id);
    }
    res.json(view);
  });

  // The blind count: the counter enters what's in the drawer; only then is the expected amount worked out and shown.
  r.post('/cash/sessions/:id/count', requirePermission('billing:write'), async (req, res) => {
    const s = await sessionOr404(req);
    if (s.status !== 'open') throw new HttpError(409, 'This drawer was already counted');
    const { detail, total } = countCash(req.body?.count);
    const exp = await drawerExpected(db, s);
    const diff = total - exp.expected;
    const done = await db.run(
      "UPDATE cash_drawer_sessions SET status = 'counted', counted_by = ?, counted_at = datetime('now'), count_detail = ?, counted_total = ?, expected_total = ?, over_short = ? WHERE id = ? AND status = 'open'",
      req.user.id, JSON.stringify(detail), total, exp.expected, diff, s.id,
    );
    if (!done.changes) throw new HttpError(409, 'This drawer was already counted');
    await audit(db, req, 'cash.drawer_count', 'cash_drawer_sessions', s.id, { counted: total, expected: exp.expected, over_short: diff }, { locationId: s.location_id, after: { status: 'counted', counted_total: total, over_short: diff } });
    const view = sessionView(await db.get('SELECT * FROM cash_drawer_sessions WHERE id = ?', s.id), await userNames(db, req.user.practice_id));
    res.json({ ...view, breakdown: exp });
  });

  // A second person verifies: agrees with the count, or recounts (their count is kept next to the first and
  // becomes the figure). Any over/short needs a reason. What's left in the drawer is the float for next time;
  // the rest goes on the deposit.
  r.post('/cash/sessions/:id/verify', requirePermission('billing:read'), requireManager, async (req, res) => {
    const pid = req.user.practice_id;
    const s = await sessionOr404(req);
    if (s.status === 'open') throw new HttpError(409, 'Count the drawer first');
    if (s.status === 'closed') throw new HttpError(409, 'Already verified');
    if (s.counted_by === req.user.id) throw new HttpError(403, 'Someone other than the person who counted has to verify the drawer');
    let finalTotal = s.counted_total;
    let recount = null;
    if (req.body?.recount) {
      recount = countCash(req.body.recount);
      finalTotal = recount.total;
    }
    const diff = finalTotal - s.expected_total;
    const reason = text(req.body?.reason, 300);
    if (diff !== 0 && !reason) throw new HttpError(400, `The drawer is ${overShortLabel(diff)} — say why`, { over_short: diff });
    const floatKept = req.body?.float_kept != null ? toCents(req.body.float_kept, 'float_kept') : Math.min(s.opening_float, finalTotal);
    if (floatKept < 0 || floatKept > finalTotal) throw new HttpError(400, 'The float left in the drawer must be between $0 and what was counted');
    const done = await db.run(
      `UPDATE cash_drawer_sessions SET status = 'closed', verified_by = ?, verified_at = datetime('now'), verify_detail = ?, verify_total = ?, over_short = ?, over_short_reason = ?,
         float_kept = ?, to_deposit = ?, closed_at = datetime('now') WHERE id = ? AND status = 'counted'`,
      req.user.id, recount ? JSON.stringify(recount.detail) : null, recount ? recount.total : null, diff, reason, floatKept, finalTotal - floatKept, s.id,
    );
    if (!done.changes) throw new HttpError(409, 'Already verified');
    await audit(db, req, 'cash.drawer_verify', 'cash_drawer_sessions', s.id, { counted: s.counted_total, recount: recount?.total ?? null, expected: s.expected_total, over_short: diff, to_deposit: finalTotal - floatKept },
      { reason, locationId: s.location_id, before: { status: s.status, over_short: s.over_short }, after: { status: 'closed', over_short: diff } });
    const { over_short_alert: alert } = await cashSettings(db, pid);
    if (diff !== 0 && Math.abs(diff) >= alert) {
      await flag(db, { practice_id: pid, location_id: s.location_id, kind: 'over_short', dedupe_key: `over-short:${s.id}`, user_id: s.counted_by, approved_by: req.user.id, session_id: s.id, amount: diff, detail: reason });
    }
    res.json(sessionView(await db.get('SELECT * FROM cash_drawer_sessions WHERE id = ?', s.id), await userNames(db, pid)));
  });

  // ---- Numbered cash receipts ----

  r.get('/cash/receipts', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    await syncCashReceipts(db, pid);
    const date = await dateParam(req, req.query.date);
    const office = await resolveOffice(db, req.user, req.query.location_id, req.location_id);
    const names = await userNames(db, pid);
    const rows = await db.all(
      `SELECT r.*, l.entry_date, p.first_name, p.last_name FROM cash_receipts r JOIN real_ledger_entries l ON l.id = r.ledger_entry_id JOIN real_patients p ON p.id = r.patient_id
       WHERE r.practice_id = ? AND l.entry_date = ?${office != null ? ' AND r.office_key IN (?, 0)' : ''} ORDER BY r.office_key, r.receipt_no`, pid, date, ...(office != null ? [office] : []),
    );
    res.json(rows.map((r) => ({ ...r, patient_name: `${r.first_name} ${r.last_name}`, taken_by_name: names[r.taken_by] || null, voided_by_name: names[r.voided_by] || null })));
  });

  // The receipt number for one cash payment (numbered now if it wasn't yet). Asking twice gives the same number.
  r.post('/cash/receipts', requirePermission('billing:write'), async (req, res) => {
    const e = await findOr404(db, 'ledger_entries', idOf(req.body?.ledger_entry_id, 'ledger_entry_id'), req.user.practice_id, 'Payment');
    hideOtherOffice(req, e, 'Payment');
    if (e.method !== 'cash') throw new HttpError(400, 'Only cash payments get a numbered cash receipt');
    const had = await db.get('SELECT id FROM cash_receipts WHERE ledger_entry_id = ?', e.id);
    const row = await assignCashReceipt(db, e);
    if (!row) throw new HttpError(400, 'That isn’t a cash payment or cash paid out');
    if (!had) await audit(db, req, 'cash.receipt', 'cash_receipts', row.id, { receipt_no: row.receipt_no, ledger_entry_id: e.id }, { patientId: e.patient_id, locationId: e.location_id });
    res.status(had ? 200 : 201).json(row);
  });

  // ---- The owner's report ----
  r.get('/cash/integrity', requirePermission('billing:read'), requireOwner, async (req, res) => {
    const pid = req.user.practice_id;
    const now = await today(pid);
    const to = req.query.to ? requireDate(req.query.to, 'to') : now;
    const from = req.query.from ? requireDate(req.query.from, 'from') : new Date(Date.parse(`${to}T12:00:00Z`) - 90 * 86400_000).toISOString().slice(0, 10);
    if (from > to) throw new HttpError(400, 'from must be before to');
    await syncCashReceipts(db, pid);
    const report = await cashIntegrity(db, pid, { from, to, today: now });
    await audit(db, req, 'report.cash_integrity', 'practices', pid, { from, to });
    res.json(report);
  });

  return r;
}

// Cash controls on the ledger's own routes (billing.js): mounted BEFORE billingRoutes, these run first and let
// the request through, or stop it. Cash voids, cash refunds and a discount on an account the same person just
// took cash from need a manager; each one that goes through is recorded for the owner's report. A payment on a
// submitted deposit can't be voided except by a manager (the deposit then shows an exception).
export function cashGuardRoutes({ db }) {
  const r = Router();
  const afterSuccess = (req, res, fn) => res.on('finish', () => {
    if (res.statusCode < 400) {
      fn().catch((err) => raiseIssue(db, { practiceId: req.user.practice_id, kind: 'payment', key: `cash-control-record:${req.path}`, title: 'A cash control couldn’t be recorded for the owner’s report', detail: err.message, role: 'admin' }));
    }
  });
  const managerOnly = (req, what) => {
    if (!isManager(req.user)) throw new HttpError(403, `${what} needs a manager — ask one to do it (cash controls)`, { manager_required: true });
  };

  r.post('/ledger/:eid/void', async (req, res, next) => {
    try {
      const e = await db.get('SELECT * FROM ledger_entries WHERE id = ? AND practice_id = ?', Number(req.params.eid), req.user.practice_id);
      if (!e) return next();
      const cash = e.method === 'cash' && ['payment', 'refund'].includes(e.type);
      const locked = e.deposit_id && await db.get("SELECT id FROM deposit_slips WHERE deposit_id = ? AND stage <> 'reopened'", e.deposit_id);
      if (!cash && !locked) return next();
      managerOnly(req, locked ? 'Voiding a payment that’s on a submitted deposit' : 'Voiding a cash payment');
      afterSuccess(req, res, async () => {
        await flag(db, { practice_id: e.practice_id, location_id: e.location_id, kind: 'cash_void', dedupe_key: `cash-void:${e.id}`, user_id: e.created_by, approved_by: req.user.id, ledger_entry_id: e.id, deposit_id: e.deposit_id, patient_id: e.patient_id, amount: Math.abs(e.amount), detail: req.body?.reason });
        await syncCashReceipts(db, e.practice_id);
      });
      next();
    } catch (err) {
      next(err);
    }
  });

  r.post('/patients/:id/refunds', async (req, res, next) => {
    try {
      let method = req.body?.method;
      if (req.body?.payment_id) method = (await db.get('SELECT method FROM ledger_entries WHERE id = ? AND practice_id = ?', Number(req.body.payment_id), req.user.practice_id))?.method ?? method;
      if (method !== 'cash') return next();
      managerOnly(req, 'A cash refund');
      afterSuccess(req, res, async () => {
        const e = await db.get("SELECT * FROM ledger_entries WHERE practice_id = ? AND patient_id = ? AND type = 'refund' AND method = 'cash' AND created_by = ? ORDER BY id DESC LIMIT 1", req.user.practice_id, Number(req.params.id), req.user.id);
        if (!e) return;
        await flag(db, { practice_id: e.practice_id, location_id: e.location_id, kind: 'cash_refund', dedupe_key: `cash-refund:${e.id}`, user_id: e.created_by, approved_by: req.user.id, ledger_entry_id: e.id, patient_id: e.patient_id, amount: e.amount });
        await assignCashReceipt(db, e);
      });
      next();
    } catch (err) {
      next(err);
    }
  });

  // A credit adjustment on an account the same person took cash from today is a cash discount.
  r.post('/patients/:id/adjustments', async (req, res, next) => {
    try {
      const amount = Number(req.body?.amount);
      if (!(amount < 0)) return next();
      const date = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
      const tookCash = await db.get(
        "SELECT id FROM ledger_entries WHERE practice_id = ? AND patient_id = ? AND type = 'payment' AND method = 'cash' AND created_by = ? AND entry_date = ? AND voided_at IS NULL AND reverses_id IS NULL",
        req.user.practice_id, Number(req.params.id), req.user.id, date,
      );
      if (!tookCash) return next();
      managerOnly(req, 'A discount on an account you took cash from today');
      afterSuccess(req, res, async () => {
        const e = await db.get("SELECT * FROM ledger_entries WHERE practice_id = ? AND patient_id = ? AND type = 'adjustment' AND created_by = ? ORDER BY id DESC LIMIT 1", req.user.practice_id, Number(req.params.id), req.user.id);
        if (e) await flag(db, { practice_id: e.practice_id, location_id: e.location_id, kind: 'cash_discount', dedupe_key: `cash-discount:${e.id}`, user_id: req.user.id, approved_by: req.user.id, ledger_entry_id: e.id, patient_id: e.patient_id, amount: -e.amount });
      });
      next();
    } catch (err) {
      next(err);
    }
  });
  return r;
}
