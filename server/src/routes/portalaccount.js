import { Router } from 'express';
import { HttpError } from '../auth.js';
import { idempotency } from '../idempotency.js';
import { portalSession, portalKey } from './portal.js';
import { explainBalance } from './billing.js';
import { planStatus } from './family.js';
import { audit, practiceNow, mapSeq, insert, change } from '../util.js';
import { estimateCoverage, primaryPolicy } from '../services.js';
import { patientLang } from '../templates.js';
import { sendReceipt } from '../receipts.js';
import {
  accountSummary, takePayment, settleReturn, achEnabled, planRules, planChoices, addDays, paymentFailed, kindError, checkAmount,
  postOnlinePayment, afterOnlinePayment, oneAtATime,
} from '../billpay.js';
import { passThroughInfo } from '../billingauto.js';

// Patient portal 2.0 (PT1, PT2): the household account at a glance and paying it. Mounted under /api/portal next to
// routes/portal.js (same sign-in: portalSession). Everything here is the patient acting (source 'patient'), audited.
//
// Who sees what: a guarantor (head of household) sees every member's balance and visits and manages the cards and
// payment plans; anyone else signed in sees only their own. Payments always go to the guarantor's account, which is
// where the household's balance lives.
export default function portalAccountRoutes({ db, secret, config = {}, payments = { enabled: false, mode: 'none' }, messenger = null }) {
  const r = Router();
  const auth = portalSession(db, secret);
  // Repeats of the same payment/card/plan request (double taps, retries) return the first answer.
  const once = idempotency(db, secret, { scopeOf: (req) => `portal-acct${req.portal.patient.id}` });
  const pAudit = (req, action, entity, id, details) => audit(db, { ip: req.ip, user: { practice_id: req.portal.practice.id, id: null } }, action, entity, id,
    { portal_patient_id: req.portal.patient.id, ...details }, { actor: `Patient portal (${req.portal.patient.first_name} ${req.portal.patient.last_name})` });
  const isGuarantor = (req) => !req.portal.patient.guarantor_id;
  const guarantorOnly = (req) => {
    if (!isGuarantor(req)) throw new HttpError(403, 'Only the account holder for your family can do this');
  };
  const payerOf = async (req) => (req.portal.patient.guarantor_id
    ? db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', req.portal.patient.guarantor_id, req.portal.practice.id)
    : req.portal.patient);
  const inList = (ids) => ids.map(() => '?').join(',');
  const cardView = (m) => ({ id: m.id, brand: m.brand, last4: m.last4, exp_month: m.exp_month, exp_year: m.exp_year });
  const returnUrls = (req, extra = '') => {
    const base = `${config.appUrl}/portal/${encodeURIComponent(portalKey(req.portal.practice))}`;
    return { successUrl: `${base}?paid=1&session_id={CHECKOUT_SESSION_ID}${extra}`, cancelUrl: `${base}?pay=cancelled` };
  };

  // One member's account: the balance explained visit by visit (billing.js explainBalance — the same numbers the
  // office sees), and their visits.
  async function memberAccount(req, m, today) {
    const pid = req.portal.practice.id;
    const why = await explainBalance(db, pid, m.id);
    const next = await db.get("SELECT start_time FROM appointments WHERE patient_id = ? AND practice_id = ? AND start_time >= ? AND status IN ('scheduled','confirmed','checked_in') ORDER BY start_time LIMIT 1", m.id, pid, today);
    const last = await db.get("SELECT start_time FROM appointments WHERE patient_id = ? AND practice_id = ? AND start_time < ? AND status = 'completed' ORDER BY start_time DESC LIMIT 1", m.id, pid, today);
    return {
      id: m.id, first_name: m.first_name, last_name: m.last_name, is_you: m.id === req.portal.patient.id,
      balance: why.balance, pending_insurance: why.pending_insurance + why.pending_write_off, your_portion: Math.max(0, why.patient_portion),
      next_visit: next?.start_time ?? null, last_visit: last?.start_time ?? null,
      explained: why,
    };
  }

  // ---- PT1: the account at a glance ----
  r.get('/account', auth, async (req, res) => {
    const { patient, practice, household, ids } = req.portal;
    const now = await practiceNow(db, practice.id);
    const today = now.slice(0, 10);
    const L = inList(ids);
    const summary = await accountSummary(db, practice.id, ids);
    const members = await mapSeq(household, (m) => memberAccount(req, m, today));
    // Itemized activity, grouped by visit, across the people this person may see.
    const visits = members.flatMap((m) => m.explained.visits.map((v) => ({ ...v, patient_id: m.id, patient_name: m.first_name })))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 60);
    const credits = members.reduce((s, m) => s + m.explained.unapplied_credit, 0);
    const other = members.reduce((s, m) => s + m.explained.other, 0);
    const payer = await payerOf(req);
    const guarantor = isGuarantor(req);
    const plans = guarantor ? await mapSeq(await db.all("SELECT * FROM payment_plans WHERE practice_id = ? AND patient_id = ? AND status = 'active' ORDER BY id", practice.id, patient.id), (p) => planStatus(db, p, today)) : [];
    const cards = guarantor ? await db.all('SELECT * FROM payment_methods WHERE practice_id = ? AND patient_id = ? AND removed_at IS NULL ORDER BY id DESC', practice.id, patient.id) : [];
    const rules = guarantor && !plans.length ? await planRules(db, practice.id) : null;
    const tps = await db.all(
      `SELECT tp.* FROM treatment_plans tp WHERE tp.practice_id = ? AND tp.patient_id IN (${L}) AND tp.status IN ('proposed','accepted')
       AND EXISTS (SELECT 1 FROM procedures p WHERE p.treatment_plan_id = tp.id AND p.status = 'planned') ORDER BY tp.id DESC LIMIT 10`, practice.id, ...ids,
    );
    const byId = Object.fromEntries(household.map((h) => [h.id, h]));
    await pAudit(req, 'portal.account_view', 'patients', patient.id);
    res.json({
      is_guarantor: guarantor,
      language: patientLang(patient),
      payer_name: payer ? `${payer.first_name} ${payer.last_name}` : null,
      summary: { ...summary, unapplied_credit: credits, other },
      // The household view is the guarantor's; anyone else sees only themselves.
      members: guarantor ? members.map(({ explained, ...m }) => m) : [],
      visits,
      upcoming: (await db.all(
        `SELECT a.id, a.patient_id, a.start_time, a.status, a.reason, pv.name AS provider_name FROM appointments a JOIN providers pv ON pv.id = a.provider_id
         WHERE a.practice_id = ? AND a.patient_id IN (${L}) AND a.start_time >= ? AND a.status IN ('scheduled','confirmed','checked_in') ORDER BY a.start_time LIMIT 20`, practice.id, ...ids, now,
      )).map((a) => ({ ...a, patient_name: byId[a.patient_id]?.first_name })),
      treatment_plans: await mapSeq(tps, async (tp) => {
        const procs = await db.all("SELECT * FROM procedures WHERE treatment_plan_id = ? AND status = 'planned' ORDER BY id", tp.id);
        const est = await estimateCoverage(db, await primaryPolicy(db, practice.id, tp.patient_id), procs);
        return {
          id: tp.id, name: tp.name, status: tp.status, signed: !!tp.signed_at, patient_id: tp.patient_id, patient_name: byId[tp.patient_id]?.first_name,
          total_fee: est.total_fee, insurance_estimate: est.total_insurance ?? 0, write_off: est.total_write_off ?? 0, your_estimate: est.total_patient,
          procedures: procs.map((p) => {
            const e = est.items.find((i) => i.procedure_id === p.id) || {};
            return { id: p.id, code: p.code, description: p.description, tooth: p.tooth, surfaces: p.surfaces, fee: p.fee, insurance: e.insurance ?? 0, your_part: e.patient ?? p.fee };
          }),
        };
      }),
      statements: await db.all(
        `SELECT sd.id, sd.created_at AS date, sd.amount, sd.method FROM statement_deliveries sd WHERE sd.practice_id = ? AND sd.patient_id IN (${L}) ORDER BY sd.id DESC LIMIT 24`, practice.id, ...ids,
      ),
      receipts: await db.all(
        `SELECT l.id, l.entry_date, l.amount, l.method, l.description, p.first_name AS patient_name FROM ledger_entries l JOIN patients p ON p.id = l.patient_id
         WHERE l.practice_id = ? AND l.patient_id IN (${L}) AND l.type = 'payment' AND l.amount < 0 AND l.voided_at IS NULL ORDER BY l.entry_date DESC, l.id DESC LIMIT 50`, practice.id, ...ids,
      ),
      payment: {
        enabled: !!payments.enabled, mode: payments.mode, ach: achEnabled(payments), wallets: payments.mode === 'stripe', can_save_card: guarantor && !!payments.enabled,
        suggested: summary.your_portion, max: payer ? (await accountSummary(db, practice.id, (await db.all("SELECT id FROM patients WHERE practice_id = ? AND (id = ? OR guarantor_id = ?) AND status != 'archived'", practice.id, payer.id, payer.id)).map((x) => x.id))).max_payment : 0,
        email_on_file: !!payer?.email,
        // Card costs passed on, in words, shown before paying (billingauto.js).
        pass_through: await passThroughInfo(db, practice.id),
      },
      cards: cards.map(cardView),
      plans: plans.map((p) => ({
        id: p.id, total: p.total, paid: p.paid, remaining: p.remaining, past_due: p.past_due, next_due_date: p.next_due_date, next_due_amount: p.next_due_amount,
        installments: p.installments, installment_amount: p.installment_amount, autopay_card_id: p.autopay_method_id && !p.autopay_paused ? p.autopay_method_id : null,
        autopay_message: p.autopay_message || null,
      })),
      plan_choices: rules ? planChoices(summary.your_portion, rules) : [],
      plan_first_payment_days: rules?.first_payment_days ?? null,
    });
  });

  // One family member's account and visits: the guarantor for anyone in the household, others only for themselves.
  r.get('/account/members/:mid', auth, async (req, res) => {
    const mid = Number(req.params.mid);
    const m = req.portal.household.find((h) => h.id === mid);
    if (!m || (!isGuarantor(req) && mid !== req.portal.patient.id)) throw new HttpError(404, 'Family member not found');
    const today = (await practiceNow(db, req.portal.practice.id)).slice(0, 10);
    const acct = await memberAccount(req, m, today);
    const visits = await db.all(
      `SELECT a.id, a.start_time, a.status, a.reason, pv.name AS provider_name FROM appointments a JOIN providers pv ON pv.id = a.provider_id
       WHERE a.practice_id = ? AND a.patient_id = ? AND a.status IN ('scheduled','confirmed','checked_in','completed') ORDER BY a.start_time DESC LIMIT 20`, req.portal.practice.id, m.id,
    );
    await pAudit(req, 'portal.member_view', 'patients', m.id);
    res.json({ ...acct, visits });
  });

  // ---- PT2: paying ----
  // how 'saved' (a card on file) or 'new'; method 'card' (Apple Pay / Google Pay live on Stripe's card page) or 'ach'.
  r.post('/billing/pay', auth, once, async (req, res) => {
    const { practice, patient } = req.portal;
    const payer = await payerOf(req);
    if (!payer) throw new HttpError(404, 'Account not found');
    const b = req.body || {};
    const how = b.how === 'saved' ? 'saved' : 'new';
    if (how === 'saved') guarantorOnly(req);
    const out = await takePayment(db, payments, messenger, {
      practice, payer, amount: Math.round(Number(b.amount)), how, method: b.method === 'ach' ? 'ach' : 'card', cardId: b.card_id,
      saveCard: !!b.save_card && isGuarantor(req), receipt: b.receipt !== false, source: 'portal', lang: patientLang(patient),
      sandbox: { card_number: b.card_number, account_number: b.account_number }, requestKey: req.get('Idempotency-Key') ? `p${patient.id}-${req.get('Idempotency-Key')}` : null,
      feeAck: b.fee_ack ?? null, // the surcharge / convenience fee the page showed (billingauto.js)
      ...returnUrls(req),
    });
    await pAudit(req, out.paid ? 'portal.payment' : 'portal.payment_start', 'payment_requests', out.payment_request_id, { amount: Math.round(Number(b.amount)), how, method: b.method || 'card', patient_id: payer.id });
    res.status(201).json(out);
  });

  // Back from Stripe's page: post it now if the webhook hasn't yet (either way it posts once).
  r.get('/billing/return', auth, async (req, res) => {
    const payer = await payerOf(req);
    res.json(await settleReturn(db, payments, messenger, { practiceId: req.portal.practice.id, payerIds: [payer.id], sessionId: req.query.session_id }));
  });

  r.post('/billing/receipts/:lid/email', auth, once, async (req, res) => {
    const { practice, ids } = req.portal;
    const e = await db.get("SELECT * FROM ledger_entries WHERE id = ? AND practice_id = ? AND type = 'payment' AND amount < 0", Number(req.params.lid), practice.id);
    if (!e || !ids.includes(e.patient_id)) throw new HttpError(404, 'Payment not found');
    const sent = messenger ? await sendReceipt(db, messenger, { entryId: e.id, practiceId: practice.id, channel: 'email' }) : null;
    if (!sent) throw new HttpError(409, 'We don’t have an email address for you — add one under Your details');
    await pAudit(req, 'portal.receipt_email', 'ledger_entries', e.id);
    res.json({ sent: true });
  });

  // ---- Saved cards (the guarantor's; card numbers stay with the processor) ----
  r.post('/billing/cards', auth, once, async (req, res) => {
    guarantorOnly(req);
    const { patient, practice } = req.portal;
    if (!payments.enabled) throw new HttpError(409, `Cards can’t be saved online — please call ${practice.phone || 'the office'}`);
    if (payments.mode === 'sandbox') {
      const test = payments.sandboxPay({ method: 'card', number: req.body?.card_number, amount: 100 });
      if (!test.ok) throw kindError(test, practice, patientLang(patient));
      const id = await insert(db, 'payment_methods', { practice_id: practice.id, patient_id: patient.id, provider: 'sandbox', brand: test.brand, last4: test.last4, exp_month: 12, exp_year: new Date().getUTCFullYear() + 3 });
      await pAudit(req, 'card.saved', 'payment_methods', id, { patient_id: patient.id });
      return res.status(201).json({ card: cardView(await db.get('SELECT * FROM payment_methods WHERE id = ?', id)) });
    }
    const base = `${config.appUrl}/portal/${encodeURIComponent(portalKey(practice))}`;
    const url = await payments.cardSetupUrl(db, patient, { successUrl: `${base}?card=saved`, cancelUrl: base });
    await pAudit(req, 'card.setup_link', 'patients', patient.id);
    res.status(201).json({ url });
  });

  r.delete('/billing/cards/:cid', auth, once, async (req, res) => {
    guarantorOnly(req);
    const { patient, practice } = req.portal;
    const card = await db.get('SELECT * FROM payment_methods WHERE id = ? AND practice_id = ? AND patient_id = ? AND removed_at IS NULL', Number(req.params.cid), practice.id, patient.id);
    if (!card) throw new HttpError(404, 'Card not found');
    // Cards are marked removed (never deleted); autopay that used it stops, and the office is told.
    await change(db, 'payment_methods', card.id, { removed_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    const plans = await db.all("SELECT id FROM payment_plans WHERE autopay_method_id = ? AND status = 'active'", card.id);
    for (const p of plans) await change(db, 'payment_plans', p.id, { autopay_method_id: null });
    if (plans.length) {
      await insert(db, 'tasks', {
        practice_id: practice.id, patient_id: patient.id, priority: 'normal', due_date: (await practiceNow(db, practice.id)).slice(0, 10),
        title: `${patient.first_name} ${patient.last_name} removed the card used for payment plan autopay (online) — autopay is off until a card is chosen`,
      });
    }
    if (card.payment_method_id && payments.detach) {
      await payments.detach(card.payment_method_id).catch((err) => paymentFailed(db, { practiceId: practice.id, payer: patient, amount: 0, reason: `A removed card couldn’t be detached at the processor: ${err.message}`, source: 'portal' }));
    }
    await pAudit(req, 'card.removed', 'payment_methods', card.id, { autopay_stopped: plans.length });
    res.json({ ok: true, autopay_stopped: plans.length });
  });

  // ---- Payment plans and autopay, within the owner's allowed options ----
  r.post('/billing/plans', auth, once, async (req, res) => {
    guarantorOnly(req);
    const { patient, practice, ids } = req.portal;
    const lang = patientLang(patient);
    await oneAtATime(db, patient.id);
    if (await db.get("SELECT id FROM payment_plans WHERE practice_id = ? AND patient_id = ? AND status = 'active'", practice.id, patient.id)) {
      throw new HttpError(409, 'You already have a payment plan — call the office to change it');
    }
    const card = await db.get('SELECT * FROM payment_methods WHERE id = ? AND practice_id = ? AND patient_id = ? AND removed_at IS NULL', Number(req.body?.card_id), practice.id, patient.id);
    if (!card) throw new HttpError(400, 'Choose a saved card for the monthly payments');
    const { your_portion: amount } = await accountSummary(db, practice.id, ids);
    const choice = planChoices(amount, await planRules(db, practice.id)).find((c) => c.months === Number(req.body?.months));
    if (!choice) throw new HttpError(400, 'That payment plan isn’t available online for this balance — call the office and we’ll work something out');
    const today = (await practiceNow(db, practice.id)).slice(0, 10);
    // The down payment is charged now (a decline sets up nothing); the plan covers the rest with autopay.
    if (choice.down_payment > 0) {
      await checkAmount(db, practice.id, patient, choice.down_payment);
      const sessionId = `off_cs_plan${patient.id}_${Date.now().toString(36)}`;
      const prId = await insert(db, 'payment_requests', { practice_id: practice.id, patient_id: patient.id, amount: choice.down_payment, provider: payments.mode, session_id: sessionId });
      const out = await payments.charge({
        method: card, amount: choice.down_payment, description: `${practice.name} payment plan down payment`,
        idempotencyKey: `portal-plan-${patient.id}-${amount}-${choice.months}-${card.id}-${today}`, metadata: { payment_request_id: prId, source: 'portal', patient_id: patient.id },
      });
      if (!out.ok) {
        if (!out.ambiguous) await db.run("UPDATE payment_requests SET status = 'cancelled' WHERE id = ?", prId);
        await paymentFailed(db, { practiceId: practice.id, payer: patient, amount: choice.down_payment, reason: `Payment plan down payment: ${out.reason}`, source: 'portal' });
        throw kindError(out, practice, lang);
      }
      const session = { id: sessionId, payment_status: 'paid', amount_total: choice.down_payment, payment_intent: out.reference, metadata: { source: 'portal', card_label: `${card.brand || 'card'} •••• ${card.last4}`, receipt: '1' } };
      await afterOnlinePayment(db, payments, messenger, session, await postOnlinePayment(db, session));
    }
    const id = await insert(db, 'payment_plans', {
      practice_id: practice.id, patient_id: patient.id, total: amount, down_payment: choice.down_payment, installments: choice.months,
      installment_amount: choice.monthly, frequency: 'monthly', start_date: addDays(today, (await planRules(db, practice.id)).first_payment_days || 30),
      autopay_method_id: card.id, notes: 'Set up by the patient in the patient portal',
    });
    await pAudit(req, 'portal.payment_plan', 'payment_plans', id, { total: amount, months: choice.months, down_payment: choice.down_payment });
    const plan = await planStatus(db, await db.get('SELECT * FROM payment_plans WHERE id = ?', id), today);
    res.status(201).json({ id, total: plan.total, down_payment: plan.down_payment, installments: plan.installments, next_due_date: plan.next_due_date, next_due_amount: plan.next_due_amount });
  });

  // Turn autopay on (with one of your saved cards) or off for your payment plan.
  r.put('/billing/plans/:planId/autopay', auth, once, async (req, res) => {
    guarantorOnly(req);
    const { patient, practice } = req.portal;
    const plan = await db.get("SELECT * FROM payment_plans WHERE id = ? AND practice_id = ? AND patient_id = ? AND status = 'active'", Number(req.params.planId), practice.id, patient.id);
    if (!plan) throw new HttpError(404, 'Payment plan not found');
    let cardId = null;
    if (req.body?.card_id != null) {
      const card = await db.get('SELECT id FROM payment_methods WHERE id = ? AND practice_id = ? AND patient_id = ? AND removed_at IS NULL', Number(req.body.card_id), practice.id, patient.id);
      if (!card) throw new HttpError(400, 'That card isn’t on file');
      cardId = card.id;
    }
    await change(db, 'payment_plans', plan.id, cardId ? { autopay_method_id: cardId, autopay_paused: 0, autopay_failures: 0, autopay_last_attempt: null } : { autopay_method_id: null });
    await pAudit(req, cardId ? 'portal.autopay_on' : 'portal.autopay_off', 'payment_plans', plan.id, { card_id: cardId });
    res.json({ ok: true, autopay_card_id: cardId });
  });

  return r;
}
