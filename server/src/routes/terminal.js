import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, insert, audit, toCents, practiceNow } from '../util.js';
import { sendReceipt } from '../receipts.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));
const view = (t) => ({
  id: t.id, patient_id: t.patient_id, reader_id: t.reader_id, amount: t.amount, status: t.status, error: t.error,
  card_brand: t.card_brand, card_last4: t.card_last4, ledger_entry_id: t.ledger_entry_id, created_at: t.created_at,
});

// Checks a pending reader payment and, once the card is approved, posts it to the ledger exactly once.
export async function refreshTerminalPayment(db, payments, messenger, row) {
  if (row.status !== 'pending' || !row.intent_id) return row;
  const reader = await db.get('SELECT * FROM terminal_readers WHERE id = ?', row.reader_id);
  const s = await payments.terminal.status(row, reader.reader_id);
  if (s.status === 'succeeded') {
    const entryId = await db.tx(async () => {
      const flipped = await db.run("UPDATE terminal_payments SET status = 'succeeded', card_brand = ?, card_last4 = ? WHERE id = ? AND status = 'pending'", s.brand || null, s.last4 || null, row.id);
      if (!flipped.changes) return null; // another check (or the webhook) already posted it
      const card = s.last4 ? ` (${s.brand ? s.brand[0].toUpperCase() + s.brand.slice(1) : 'card'} •••• ${s.last4})` : '';
      const id = await insert(db, 'ledger_entries', {
        practice_id: row.practice_id, location_id: reader.location_id ?? null, patient_id: row.patient_id, type: 'payment', amount: -row.amount,
        description: `Card payment at the desk${card}`, method: 'credit_card', reference: row.intent_id,
        entry_date: (await practiceNow(db, row.practice_id)).slice(0, 10), created_by: row.created_by,
      });
      await db.run('UPDATE terminal_payments SET ledger_entry_id = ? WHERE id = ?', id, row.id);
      await audit(db, { user: { practice_id: row.practice_id, id: row.created_by } }, 'ledger.payment', 'ledger_entries', id, { amount: row.amount, terminal_payment_id: row.id });
      return id;
    });
    if (entryId && ['email', 'sms'].includes(row.receipt)) await sendReceipt(db, messenger, { entryId, practiceId: row.practice_id, channel: row.receipt, userId: row.created_by }).catch(() => null);
  } else if (s.status === 'failed' || s.status === 'canceled') {
    await db.run('UPDATE terminal_payments SET status = ?, error = ? WHERE id = ? AND status = ?', s.status, s.reason || null, row.id, 'pending');
  }
  return db.get('SELECT * FROM terminal_payments WHERE id = ?', row.id);
}

// Card-present payments at the front desk.
export default function terminalRoutes({ db, payments, messenger }) {
  const r = Router();
  const terminal = () => {
    if (!payments.terminal) throw new HttpError(501, 'Card readers need card payments set up (Settings → Integrations)');
    return payments.terminal;
  };

  r.get('/terminal/readers', requirePermission('billing:read'), async (req, res) => {
    res.json({
      enabled: !!payments.terminal, test_mode: !!payments.terminal?.simulate,
      readers: await db.all('SELECT id, reader_id, label, device_type, serial_number, location_id FROM terminal_readers WHERE practice_id = ? AND removed_at IS NULL ORDER BY label', req.user.practice_id),
    });
  });
  // Register a reader with the code it shows on screen (Stripe's "registration code"; any word in sandbox).
  r.post('/terminal/readers', requireAdmin, async (req, res) => {
    const code = String(req.body?.registration_code || '').trim();
    const label = String(req.body?.label || '').trim().slice(0, 60) || 'Front desk';
    if (!code) throw new HttpError(400, 'Enter the registration code shown on the reader');
    const location = req.body?.location_id ? await findOr404(db, 'locations', req.body.location_id, req.user.practice_id, 'Location') : null;
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    const reg = await terminal().register(db, practice, { registrationCode: code, label });
    const id = await insert(db, 'terminal_readers', { practice_id: req.user.practice_id, location_id: location?.id ?? null, ...reg });
    await audit(db, req, 'terminal_reader.add', 'terminal_readers', id, { label: reg.label });
    res.status(201).json(await db.get('SELECT * FROM terminal_readers WHERE id = ?', id));
  });
  r.delete('/terminal/readers/:rid', requireAdmin, async (req, res) => {
    const reader = await findOr404(db, 'terminal_readers', req.params.rid, req.user.practice_id, 'Card reader');
    await db.run("UPDATE terminal_readers SET removed_at = datetime('now') WHERE id = ?", reader.id);
    await audit(db, req, 'terminal_reader.remove', 'terminal_readers', reader.id);
    res.json({ ok: true });
  });

  // Send an amount to a reader; the patient taps, inserts or swipes. The screen polls for the result.
  r.post('/patients/:id/terminal-payments', requirePermission('billing:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const reader = await findOr404(db, 'terminal_readers', req.body?.reader_id, req.user.practice_id, 'Card reader');
    if (reader.removed_at) throw new HttpError(400, 'That reader was removed');
    const amount = toCents(req.body?.amount);
    if (amount < 50) throw new HttpError(400, 'Amount must be at least $0.50');
    const waiting = await db.get("SELECT * FROM terminal_payments WHERE reader_id = ? AND status = 'pending'", reader.id);
    if (waiting && (await refreshTerminalPayment(db, payments, messenger, waiting)).status === 'pending') {
      throw new HttpError(409, 'That reader is already waiting for a card — cancel that payment first', { terminal_payment_id: waiting.id });
    }
    const receipt = ['email', 'sms'].includes(req.body?.receipt) ? req.body.receipt : null;
    const id = await insert(db, 'terminal_payments', { practice_id: req.user.practice_id, patient_id: patient.id, reader_id: reader.id, amount, receipt, created_by: req.user.id });
    const practice = await db.get('SELECT name FROM practices WHERE id = ?', req.user.practice_id);
    try {
      const { intent_id } = await terminal().start({
        readerId: reader.reader_id, amount, description: `${practice.name} — payment`, idempotencyKey: `terminal-${req.user.practice_id}-${id}`,
        metadata: { terminal_payment_id: id, practice_id: req.user.practice_id, patient_id: patient.id },
      });
      await db.run('UPDATE terminal_payments SET intent_id = ? WHERE id = ?', intent_id, id);
    } catch (err) {
      await db.run("UPDATE terminal_payments SET status = 'failed', error = ? WHERE id = ?", String(err.message).slice(0, 300), id);
      throw err;
    }
    await audit(db, req, 'terminal_payment.start', 'terminal_payments', id, { amount, reader: reader.label });
    res.status(201).json(view(await db.get('SELECT * FROM terminal_payments WHERE id = ?', id)));
  });
  const paymentOr404 = (req) => findOr404(db, 'terminal_payments', req.params.tid, req.user.practice_id, 'Card payment');
  r.get('/terminal-payments/:tid', requirePermission('billing:read'), async (req, res) => {
    res.json(view(await refreshTerminalPayment(db, payments, messenger, await paymentOr404(req))));
  });
  r.post('/terminal-payments/:tid/cancel', requirePermission('billing:write'), async (req, res) => {
    let row = await paymentOr404(req);
    row = await refreshTerminalPayment(db, payments, messenger, row);
    if (row.status !== 'pending') return res.json(view(row)); // too late: it went through (or already ended)
    const reader = await db.get('SELECT * FROM terminal_readers WHERE id = ?', row.reader_id);
    await terminal().cancel(row, reader.reader_id);
    await db.run("UPDATE terminal_payments SET status = 'canceled' WHERE id = ? AND status = 'pending'", row.id);
    await audit(db, req, 'terminal_payment.cancel', 'terminal_payments', row.id);
    res.json(view(await db.get('SELECT * FROM terminal_payments WHERE id = ?', row.id)));
  });
  // Test mode and sandbox only: pretend a card was presented.
  r.post('/terminal-payments/:tid/simulate', requirePermission('billing:write'), async (req, res) => {
    if (!terminal().simulate) throw new HttpError(400, 'Only available with a test-mode reader');
    const row = await paymentOr404(req);
    if (row.status !== 'pending') throw new HttpError(409, 'This payment is no longer waiting for a card');
    const reader = await db.get('SELECT * FROM terminal_readers WHERE id = ?', row.reader_id);
    await terminal().simulate(row, reader.reader_id);
    await db.run('UPDATE terminal_payments SET presented = 1 WHERE id = ?', row.id);
    res.json(view(await refreshTerminalPayment(db, payments, messenger, await db.get('SELECT * FROM terminal_payments WHERE id = ?', row.id))));
  });
  return r;
}
