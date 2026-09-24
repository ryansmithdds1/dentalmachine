import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { requireHuman } from '../aiguard.js';
import { findOr404, insert, audit, update, recorded } from '../util.js';
import { isManager } from '../deposits.js';
import { canSeePatient } from '../officeaccess.js';
import {
  setAppUrl, billingSettings, saveBillingSettings, passThroughFor, passThroughInfo, practiceState, surchargeCap, STATE_RULES, BRAND_MAX_BPS, PROCESSORS,
  activeList, accountActivity, setupPreview, startSetup, finishSetup, linkByToken, linkExpired, cardFromLink, sendUpdateCardLink, replaceCard, retryNow,
  stopDunning, openDunning, cleanFee, applyFee, waiveFee, feeAmount, collectible, FEE_OCCASIONS, reconcileDay, runExpiringCards, todayFor, addDays, dollars,
  TEST_CARDS, SOURCES,
} from '../billingauto.js';

// Billing autopilot (backlog BL1–BL5; spec docs/workflows/specs/BL-billing.md). Staff routes under /api and the
// patient's secure links under /api/public. The work is in billingauto.js; this file checks who may do what:
//   billing:read — see the lists; billing:write — set up payments, send links, retry, stop retries, add an offered fee;
//   manager (deposits:manage, or an administrator) — waive a fee; administrator — card surcharge rules and office fees.
// Every money action is refused to the AI without a person's OK (requireHuman here and in billingauto.js).

const adminOnly = (req, what) => {
  if (req.user.role !== 'admin') throw new HttpError(403, `Only an administrator can change ${what}`);
};
const managerOnly = (req, what) => {
  if (!isManager(req.user)) throw new HttpError(403, `${what} needs a manager (deposits:manage) or an administrator`, { manager_required: true });
};
const feeView = (f) => ({ ...f, waivable: !!f.waivable, active: !!f.active, occasion_label: FEE_OCCASIONS[f.occasion] });
const cardView = (m) => ({ id: m.id, brand: m.brand, last4: m.last4, exp_month: m.exp_month, exp_year: m.exp_year, funding: m.funding || null });

export default function billingAutoRoutes({ db, payments, messenger, config = {} }) {
  setAppUrl(config.appUrl);
  const r = Router();
  const pid = (req) => req.user.practice_id;
  // A record about a patient at another office answers 404 to someone limited to some offices (officeaccess.js
  // covers /patients/:id… and other /<segment>/:id paths; these nested /billing/… ones are checked here).
  const visibleOr404 = async (req, table, id, label) => {
    const row = await findOr404(db, table, id, pid(req), label);
    if (!(await canSeePatient(db, req.user, table === 'patients' ? row.id : row.patient_id))) throw new HttpError(404, `${label} not found`);
    return row;
  };
  const guarantorOf = async (req, id) => {
    const p = await visibleOr404(req, 'patients', id, 'Patient');
    return p.guarantor_id ? db.get('SELECT * FROM patients WHERE id = ?', p.guarantor_id) : p;
  };

  // ---- BL1: every plan and what's next ----
  r.get('/billing/active', requirePermission('billing:read'), async (req, res) => {
    const out = await activeList(db, pid(req));
    const kind = req.query.kind;
    const status = req.query.status;
    res.json({ ...out, items: out.items.filter((i) => (!kind || i.kind === kind) && (!status || i.status === status)) });
  });

  // The account's billing story: charges tried, declines and retries, links sent, agreements, fees, disputes.
  r.get('/patients/:id/billing-activity', requirePermission('billing:read'), async (req, res) => {
    const g = await guarantorOf(req, req.params.id);
    res.json(await accountActivity(db, pid(req), g.id));
  });

  // ---- BL1: set up payments ----
  // The exact terms and schedule first (shown to the patient), then the set-up with the hash of what was shown.
  r.post('/billing/setup/preview', requirePermission('billing:write'), async (req, res) => {
    res.json(await setupPreview(db, pid(req), req.body || {}));
  });
  r.post('/billing/setup', requirePermission('billing:write'), async (req, res) => {
    requireHuman('setting up automatic payments');
    const out = await startSetup(db, payments, messenger, { user: req.user, input: req.body || {}, ip: req.ip, userAgent: req.get('User-Agent') });
    res.status(out.replay ? 200 : 201).json(out);
  });
  r.get('/billing/authorizations/:aid', requirePermission('billing:read'), async (req, res) => {
    const a = await visibleOr404(req, 'billing_authorizations', req.params.aid, 'Authorization');
    await audit(db, req, 'billing.authorization_view', 'billing_authorizations', a.id, null, { patientId: a.patient_id });
    res.json({ ...a, setup: JSON.parse(a.setup) });
  });
  // Stopping automatic payments at the patient's request: the authorization is revoked and the card comes off
  // the plan / recurring charge (what's owed stays owed).
  r.post('/billing/authorizations/:aid/revoke', requirePermission('billing:write'), async (req, res) => {
    requireHuman('stopping automatic payments');
    const a = await visibleOr404(req, 'billing_authorizations', req.params.aid, 'Authorization');
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw new HttpError(400, 'Say why automatic payments are stopping');
    const { changes } = await db.run("UPDATE billing_authorizations SET status = 'revoked', revoked_at = datetime('now'), revoked_by = ?, revoke_reason = ? WHERE id = ? AND status IN ('pending','signed')", req.user.id, reason.slice(0, 300), a.id);
    if (!changes) throw new HttpError(409, 'That authorization is already closed');
    if (a.status === 'signed' && a.source_id) {
      const s = SOURCES[a.kind];
      if (a.kind === 'recurring') await update(db, 'recurring_charges', a.source_id, pid(req), { status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: reason.slice(0, 300) });
      else if (a.kind === 'payment_plan') await update(db, 'payment_plans', a.source_id, pid(req), { autopay_method_id: null });
      else await update(db, s.table, a.source_id, pid(req), { autopay: 0 });
    }
    await db.run("UPDATE billing_links SET used_at = COALESCE(used_at, datetime('now')) WHERE authorization_id = ?", a.id);
    await audit(db, req, 'billing.authorization_revoke', 'billing_authorizations', a.id, { kind: a.kind, source_id: a.source_id }, { reason, patientId: a.patient_id });
    res.json({ ok: true });
  });

  // ---- Recurring charges ----
  r.post('/billing/recurring/:rid/charge-now', requirePermission('billing:write'), async (req, res) => {
    requireHuman('charging a card');
    const rc = await visibleOr404(req, 'recurring_charges', req.params.rid, 'Recurring payment');
    if (rc.status !== 'active') throw new HttpError(409, rc.status === 'paused' ? 'Automatic payments are paused — update the card or resume first' : 'That recurring payment has ended');
    const result = await retryNow(db, payments, messenger, 'recurring', rc.id);
    if (!result) throw new HttpError(409, 'Nothing could be charged right now');
    await audit(db, req, 'billing.recurring_charge_now', 'recurring_charges', rc.id, result, { patientId: rc.patient_id });
    res.json(result);
  });

  // ---- BL3: dunning ----
  r.get('/billing/dunning', requirePermission('billing:read'), async (req, res) => {
    const status = ['retrying', 'paused', 'recovered', 'stopped'].includes(req.query.status) ? req.query.status : null;
    const rows = await db.all(
      `SELECT d.*, p.first_name, p.last_name, p.phone, p.email, pm.brand, pm.last4 FROM billing_dunning d JOIN patients p ON p.id = d.patient_id LEFT JOIN payment_methods pm ON pm.id = d.payment_method_id
       WHERE d.practice_id = ? AND ${status ? 'd.status = ?' : 'd.live_key IS NOT NULL'} ORDER BY d.status = 'paused' DESC, d.next_retry_on, d.id LIMIT 500`,
      pid(req), ...(status ? [status] : []),
    );
    res.json(rows.map((d) => ({ ...d, label: SOURCES[d.source_type]?.label, patient: `${d.first_name} ${d.last_name}`, card: d.last4 ? `${d.brand || 'card'} •••• ${d.last4}` : null })));
  });
  const dunningOr404 = async (req) => {
    const d = await visibleOr404(req, 'billing_dunning', req.params.did, 'Declined payment');
    if (!d.live_key) throw new HttpError(409, 'That one is already closed');
    return d;
  };
  r.post('/billing/dunning/:did/retry', requirePermission('billing:write'), async (req, res) => {
    requireHuman('charging a card');
    const d = await dunningOr404(req);
    const result = await retryNow(db, payments, messenger, d.source_type, d.source_id);
    await audit(db, req, 'billing.dunning_retry', 'billing_dunning', d.id, { result: result ? { ok: !!(result.ok || result.charged), reason: result.reason ?? null } : null }, { patientId: d.patient_id });
    res.json({ result, dunning: await db.get('SELECT * FROM billing_dunning WHERE id = ?', d.id) });
  });
  r.post('/billing/dunning/:did/send-link', requirePermission('billing:write'), async (req, res) => {
    const d = await dunningOr404(req);
    const link = await sendUpdateCardLink(db, messenger, {
      practiceId: d.practice_id, patientId: d.patient_id, oldMethodId: d.payment_method_id, dunningId: d.id, userId: req.user.id,
      reason: { en: `Your ${SOURCES[d.source_type]?.label || 'automatic'} payment of ${dollars(d.amount)} didn’t go through.`, es: `Su pago de ${dollars(d.amount)} no se aprobó.` },
    });
    if (!link.message) throw new HttpError(400, 'The patient has no phone or email we can use (or has opted out) — call them');
    res.status(201).json({ sent: true, message_status: link.message.status });
  });
  // Start the retries again (e.g. the patient says the bank has lifted a hold).
  r.post('/billing/dunning/:did/resume', requirePermission('billing:write'), async (req, res) => {
    requireHuman('resuming automatic payments');
    const d = await dunningOr404(req);
    const today = await todayFor(db, d.practice_id);
    // A new round of retries. `resumes` goes into the retry's idempotency key (billingauto.js), so the retry
    // after a resume is a new charge attempt, not a replay of one the processor already declined; the earlier
    // attempts stay in billing_attempts under their own keys.
    await recorded(db, 'billing_dunning', d.id, () => db.run(
      "UPDATE billing_dunning SET status = 'retrying', failures = 1, resumes = resumes + 1, first_failed_on = ?, next_retry_on = ?, paused_at = NULL, team_notified_at = NULL WHERE id = ?", today, today, d.id,
    ));
    if (d.source_type === 'payment_plan') await update(db, 'payment_plans', d.source_id, pid(req), { autopay_paused: 0 });
    if (d.source_type === 'recurring') await update(db, 'recurring_charges', d.source_id, pid(req), { status: 'active' });
    const after = await db.get('SELECT status, failures, resumes, next_retry_on FROM billing_dunning WHERE id = ?', d.id);
    await audit(db, req, 'billing.dunning_resume', 'billing_dunning', d.id, null, {
      patientId: d.patient_id, before: { status: d.status, failures: d.failures, resumes: d.resumes, next_retry_on: d.next_retry_on }, after,
    });
    res.json(await db.get('SELECT * FROM billing_dunning WHERE id = ?', d.id));
  });
  // Stop retrying (statement instead, collections, the patient paid another way): needs a note.
  r.post('/billing/dunning/:did/stop', requirePermission('billing:write'), async (req, res) => {
    const d = await dunningOr404(req);
    await stopDunning(db, req, d, req.body?.note);
    res.json({ ok: true });
  });
  // Staff choose another card on file for everything that used the declined (or expiring) one.
  r.post('/billing/replace-card', requirePermission('billing:write'), async (req, res) => {
    requireHuman('changing the card for automatic payments');
    const oldM = await visibleOr404(req, 'payment_methods', req.body?.old_method_id, 'Card');
    const newM = await visibleOr404(req, 'payment_methods', req.body?.new_method_id, 'Card');
    if (newM.removed_at || newM.patient_id !== oldM.patient_id) throw new HttpError(400, 'Choose another card on file for the same account');
    const changed = await replaceCard(db, { practiceId: pid(req), patientId: oldM.patient_id, oldMethodId: oldM.id, newMethodId: newM.id, today: await todayFor(db, pid(req)), userId: req.user.id });
    const retried = [];
    for (const s of changed) if (await openDunning(db, s.type, s.id)) retried.push({ ...s, result: await retryNow(db, payments, messenger, s.type, s.id) });
    res.json({ changed, retried });
  });

  // ---- BL3: expiring cards ----
  r.get('/billing/expiring-cards', requirePermission('billing:read'), async (req, res) => {
    const s = await billingSettings(db, pid(req));
    const horizon = addDays(await todayFor(db, pid(req)), s.expiring_days);
    const used = Object.values(SOURCES).map((src) => `EXISTS (SELECT 1 FROM ${src.table} x WHERE x.${src.method} = pm.id AND x.${src.live})`).join(' OR ');
    const cards = await db.all(
      `SELECT pm.*, p.first_name, p.last_name, (SELECT MAX(n.created_at) FROM billing_notices n WHERE n.payment_method_id = pm.id) AS notified_at
       FROM payment_methods pm JOIN patients p ON p.id = pm.patient_id WHERE pm.practice_id = ? AND pm.removed_at IS NULL AND pm.exp_year IS NOT NULL AND (${used})`, pid(req),
    );
    const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    res.json(cards.filter((c) => lastDay(c.exp_year, c.exp_month) <= horizon).map((c) => ({ ...cardView(c), patient_id: c.patient_id, patient: `${c.first_name} ${c.last_name}`, expires: lastDay(c.exp_year, c.exp_month), notified_at: c.notified_at })));
  });
  r.post('/billing/expiring-cards/run', requirePermission('billing:write'), async (req, res) => {
    res.json({ sent: await runExpiringCards(db, messenger, pid(req)) });
  });
  r.post('/payment-methods/:mid/update-link', requirePermission('billing:write'), async (req, res) => {
    const m = await findOr404(db, 'payment_methods', req.params.mid, pid(req), 'Card');
    const link = await sendUpdateCardLink(db, messenger, {
      practiceId: pid(req), patientId: m.patient_id, oldMethodId: m.id, userId: req.user.id,
      reason: { en: `Please check the ${m.brand || 'card'} ending ${m.last4} we have on file for your automatic payments.`, es: `Revise la tarjeta que termina en ${m.last4} para sus pagos automáticos.` },
    });
    if (!link.message) throw new HttpError(400, 'The patient has no phone or email we can use (or has opted out)');
    res.status(201).json({ sent: true });
  });

  // ---- BL3: disputes and processor refunds ----
  r.get('/billing/disputes', requirePermission('billing:read'), async (req, res) => {
    res.json(await db.all(
      `SELECT d.*, p.first_name, p.last_name FROM billing_disputes d LEFT JOIN patients p ON p.id = d.patient_id WHERE d.practice_id = ? ORDER BY d.status = 'open' DESC, d.id DESC LIMIT 300`, pid(req),
    ));
  });

  // ---- BL2: daily check with the processor ----
  r.get('/billing/reconciliation', requirePermission('billing:read'), async (req, res) => {
    const rows = await db.all('SELECT * FROM billing_recon_days WHERE practice_id = ? ORDER BY day DESC LIMIT 60', pid(req));
    res.json({ available: !!payments?.listCharges, mode: payments?.mode || 'none', days: rows.map((r0) => ({ ...r0, detail: r0.detail ? JSON.parse(r0.detail) : null })) });
  });
  r.post('/billing/reconciliation/run', requirePermission('billing:write'), async (req, res) => {
    const day = String(req.body?.day || addDays(await todayFor(db, pid(req)), -1));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= await todayFor(db, pid(req))) throw new HttpError(400, 'Choose a day before today');
    const out = await reconcileDay(db, payments, pid(req), day);
    await audit(db, req, 'billing.reconcile', 'practices', pid(req), { day, exceptions: out.exceptions ?? null });
    res.json(out);
  });

  // ---- BL4 / BL5: the owner's settings ----
  r.get('/billing/settings', requirePermission('billing:read'), async (req, res) => {
    const s = await billingSettings(db, pid(req));
    const state = await practiceState(db, pid(req));
    const cap = surchargeCap(state, s.processing_cost_bps);
    res.json({
      settings: s, processors: PROCESSORS, mode: payments?.mode || 'none', state, state_rule: STATE_RULES[state] || null,
      surcharge_allowed: cap.max != null, surcharge_max_bps: cap.max, brand_max_bps: BRAND_MAX_BPS, disclosure: await passThroughInfo(db, pid(req)),
    });
  });
  r.put('/billing/settings', requirePermission('billing:read'), async (req, res) => {
    adminOnly(req, 'card surcharges and billing rules');
    res.json(await saveBillingSettings(db, req, req.body || {}));
  });
  // What passing card costs on would add to a payment (for the desk to say before charging).
  r.get('/billing/pass-through', requirePermission('billing:read'), async (req, res) => {
    const amount = Math.round(Number(req.query.amount));
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(400, 'amount (cents) is required');
    const channel = ['online', 'office', 'recurring'].includes(req.query.channel) ? req.query.channel : 'office';
    const funding = ['credit', 'debit', 'prepaid'].includes(req.query.funding) ? req.query.funding : null;
    res.json(await passThroughFor(db, pid(req), { amount, channel, funding, authorizedBps: channel === 'recurring' ? Number(req.query.authorized_bps) || 0 : null }));
  });

  // ---- BL5: office fees ----
  r.get('/billing/fees', requirePermission('billing:read'), async (req, res) => {
    res.json({ fees: (await db.all('SELECT * FROM billing_fees WHERE practice_id = ? ORDER BY active DESC, name', pid(req))).map(feeView), occasions: FEE_OCCASIONS });
  });
  r.post('/billing/fees', requirePermission('billing:read'), async (req, res) => {
    adminOnly(req, 'office fees');
    requireHuman('setting up office fees');
    const row = cleanFee(req.body || {});
    const id = await insert(db, 'billing_fees', { ...row, practice_id: pid(req), created_by: req.user.id });
    await audit(db, req, 'billing_fee.create', 'billing_fees', id, null, { after: row });
    res.status(201).json(feeView(await db.get('SELECT * FROM billing_fees WHERE id = ?', id)));
  });
  r.put('/billing/fees/:fid', requirePermission('billing:read'), async (req, res) => {
    adminOnly(req, 'office fees');
    requireHuman('changing office fees');
    const fee = await findOr404(db, 'billing_fees', req.params.fid, pid(req), 'Fee');
    const { id: _i, practice_id: _p, created_by: _c, created_at: _a, updated_at: _u, ...current } = fee;
    const row = cleanFee(req.body || {}, current);
    await update(db, 'billing_fees', fee.id, pid(req), { ...row, updated_at: new Date().toISOString() });
    await audit(db, req, 'billing_fee.change', 'billing_fees', fee.id, null, { before: current, after: row });
    res.json(feeView(await db.get('SELECT * FROM billing_fees WHERE id = ?', fee.id)));
  });
  // What an offered fee would come to on this account (shown before adding it).
  r.get('/billing/fees/:fid/preview', requirePermission('billing:read'), async (req, res) => {
    const fee = await findOr404(db, 'billing_fees', req.params.fid, pid(req), 'Fee');
    const g = await guarantorOf(req, req.query.patient_id);
    const basis = fee.kind === 'percent' ? await collectible(db, pid(req), g.id) : null;
    res.json({ fee: feeView(fee), basis, amount: feeAmount(fee, basis) });
  });
  // Add an offered (or manual) fee to an account, once per occasion key.
  r.post('/billing/fees/:fid/apply', requirePermission('billing:write'), async (req, res) => {
    requireHuman('adding a fee to an account');
    const fee = await findOr404(db, 'billing_fees', req.params.fid, pid(req), 'Fee');
    if (fee.applies === 'automatic' && fee.occasion !== 'manual') throw new HttpError(409, 'That fee is added automatically when it applies');
    const patient = await visibleOr404(req, 'patients', req.body?.patient_id, 'Patient');
    const note = String(req.body?.note || '').trim().slice(0, 120) || null;
    const key = req.body?.occasion_key ? `manual:${String(req.body.occasion_key).slice(0, 80)}` : `manual:${req.get('Idempotency-Key') || Date.now()}`;
    const charge = await applyFee(db, fee, { patientId: patient.id, sourceKey: key, userId: req.user.id, note });
    if (!charge) throw new HttpError(409, fee.max_per_year ? `Nothing added: this fee is at its limit of ${fee.max_per_year} a year for this patient, or comes to $0` : 'Nothing added: the fee comes to $0 (nothing is owed)');
    res.status(201).json(charge);
  });
  r.get('/patients/:id/fee-charges', requirePermission('billing:read'), async (req, res) => {
    const g = await guarantorOf(req, req.params.id);
    const rows = await db.all(
      `SELECT c.*, f.name, f.waivable FROM billing_fee_charges c JOIN billing_fees f ON f.id = c.fee_id JOIN patients p ON p.id = c.patient_id
       WHERE c.practice_id = ? AND (p.id = ? OR p.guarantor_id = ?) ORDER BY c.id DESC`, pid(req), g.id, g.id,
    );
    res.json(rows.map((c) => ({ ...c, waivable: !!c.waivable })));
  });
  r.post('/billing/fee-charges/:cid/waive', requirePermission('billing:write'), async (req, res) => {
    managerOnly(req, 'Waiving a fee');
    const charge = await visibleOr404(req, 'billing_fee_charges', req.params.cid, 'Fee');
    const reversal = await waiveFee(db, req, charge, req.body?.reason);
    res.json({ ok: true, reversal_entry_id: reversal });
  });

  return r;
}

// ---- The patient's secure links (/api/public) ----
// No sign-in: the link's token is the key (192 random bits, only its hash is kept; 30 days for card updates,
// 14 for agreeing to a set-up). Card numbers never reach this server with Stripe (its hosted page); in sandbox only
// the published test numbers are taken.
export function billingPublicRoutes({ db, payments, messenger, config = {} }) {
  setAppUrl(config.appUrl);
  const r = Router();
  const open = async (req) => {
    const link = await linkByToken(db, req.params.token);
    const practice = await db.get('SELECT id, name, phone FROM practices WHERE id = ?', link.practice_id);
    const patient = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', link.patient_id, link.practice_id);
    if (!patient) throw new HttpError(404, 'This link isn’t valid — please call the office');
    return { link, practice, patient };
  };
  const pAudit = (req, practiceId, action, entity, id, details, patientId) => audit(db, { ip: req.ip, user: { practice_id: practiceId, id: null } }, action, entity, id, details, { actor: 'Patient (billing link)', patientId });
  // A test card in sandbox, or nothing (Stripe: the card is saved on Stripe's page and arrives by webhook).
  const sandboxCard = async (link, number) => {
    const n = String(number || '').replace(/\D/g, '');
    const t = TEST_CARDS[n];
    if (!t) throw new HttpError(400, 'Sandbox accepts test cards only: 4242 4242 4242 4242, 5555 5555 5555 4444, 4000 0566 5566 5556 (debit), 4000 0000 0000 0002 (declines)');
    return insert(db, 'payment_methods', {
      practice_id: link.practice_id, patient_id: link.patient_id, provider: 'sandbox', brand: t.brand, last4: n.slice(-4), funding: t.funding, exp_month: 12, exp_year: new Date().getUTCFullYear() + 3,
    });
  };

  r.get('/billing-link/:token', async (req, res) => {
    const { link, practice, patient } = await open(req);
    const expired = linkExpired(link);
    if (!link.opened_at) await db.run("UPDATE billing_links SET opened_at = datetime('now') WHERE id = ?", link.id);
    const auth = link.authorization_id ? await db.get('SELECT * FROM billing_authorizations WHERE id = ?', link.authorization_id) : null;
    const oldCard = link.old_method_id ? await db.get('SELECT * FROM payment_methods WHERE id = ?', link.old_method_id) : null;
    const newCard = link.new_method_id ? await db.get('SELECT * FROM payment_methods WHERE id = ?', link.new_method_id) : null;
    const done = link.kind === 'authorize' ? auth?.status === 'signed' : !!link.used_at;
    await pAudit(req, practice.id, 'billing.link_open', 'billing_links', link.id, { kind: link.kind }, patient.id);
    res.json({
      kind: link.kind, status: done ? 'done' : expired || (auth && auth.status !== 'pending') ? 'expired' : 'open',
      practice: { name: practice.name, phone: practice.phone }, first_name: patient.first_name, language: patient.language || 'en',
      mode: payments?.mode || 'none', old_card: oldCard ? cardView(oldCard) : null, new_card: newCard ? cardView(newCard) : null,
      terms: auth?.terms || null, terms_hash: auth?.terms_hash || null,
      pass_through: link.kind === 'authorize' && auth?.surcharge_bps ? await passThroughInfo(db, practice.id) : null,
    });
  });

  // Add a card: sandbox takes a test number now; Stripe returns its secure page (the card arrives by webhook).
  r.post('/billing-link/:token/card', async (req, res) => {
    const { link, practice, patient } = await open(req);
    if (linkExpired(link) || (link.kind === 'update_card' && link.used_at)) throw new HttpError(410, `This link has expired — please call ${practice.phone || 'the office'}`);
    if (!payments?.enabled) throw new HttpError(409, `Cards can’t be saved online right now — please call ${practice.phone || 'the office'}`);
    if (payments.mode === 'sandbox') {
      const methodId = await sandboxCard(link, req.body?.card_number);
      await pAudit(req, practice.id, 'card.saved', 'payment_methods', methodId, { via: 'billing_link' }, patient.id);
      const out = await cardFromLink(db, payments, messenger, link, methodId);
      return res.status(201).json({ saved: true, updated: out.updated ?? 0, retried: (out.retried || []).map((x) => ({ ok: !!(x.result?.ok || x.result?.charged) })) });
    }
    const back = `${config.appUrl || ''}/billing-link/${encodeURIComponent(req.params.token)}`;
    const url = await payments.cardSetupUrl(db, patient, { successUrl: `${back}?saved=1`, cancelUrl: back, metadata: { billing_link: link.id } });
    res.json({ url });
  });

  // Agree to a set-up (the terms shown, by hash) with the card just added (or a test card in sandbox).
  r.post('/billing-link/:token/agree', async (req, res) => {
    const { link, practice, patient } = await open(req);
    if (link.kind !== 'authorize') throw new HttpError(404, 'Nothing to agree to here');
    if (linkExpired(link)) throw new HttpError(410, `This link has expired — please call ${practice.phone || 'the office'}`);
    const auth = await db.get('SELECT * FROM billing_authorizations WHERE id = ? AND practice_id = ?', link.authorization_id, practice.id);
    if (auth.status === 'signed') return res.json({ done: true, replay: true });
    if (req.body?.terms_hash !== auth.terms_hash) throw new HttpError(409, 'These terms have changed — please reload the page');
    const signer = String(req.body?.signer_name || '').trim().slice(0, 120);
    if (!signer || req.body?.agree !== true) throw new HttpError(400, 'Type your name and tick the box to agree');
    let methodId = link.new_method_id;
    if (!methodId && payments?.mode === 'sandbox' && req.body?.card_number) {
      methodId = await sandboxCard(link, req.body.card_number);
      await db.run('UPDATE billing_links SET new_method_id = ? WHERE id = ?', methodId, link.id);
    }
    methodId ||= auth.payment_method_id;
    if (!methodId) throw new HttpError(400, 'Add your card first');
    const out = await finishSetup(db, payments, messenger, auth, { methodId, signer, via: 'link', ip: req.ip, userAgent: req.get('User-Agent') });
    await db.run("UPDATE billing_links SET used_at = COALESCE(used_at, datetime('now')) WHERE id = ?", link.id);
    await pAudit(req, practice.id, 'billing.link_agree', 'billing_authorizations', auth.id, { signer }, patient.id);
    res.status(201).json({ done: true, down_payment: out.down_payment || null });
  });
  return r;
}

