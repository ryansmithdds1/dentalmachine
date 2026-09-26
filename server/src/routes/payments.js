import express, { Router } from 'express';
import { refuseTraining } from '../training.js';
import { messageText, patientLang, subjectFor } from '../templates.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, insert, audit, toCents, practiceNow } from '../util.js';
import { patientBalance, pendingInsurance } from '../services.js';
import { runAutopay } from '../payments.js';
import { autoReceipt } from '../receipts.js';
import { refreshTerminalPayment } from './terminal.js';
import { finishBooking } from '../onlinebooking.js';
import { postOnlinePayment, afterOnlinePayment, paymentFailed, payCodeFor } from '../billpay.js';
import { sendMessage, preferredChannel, sendAppointmentReminder } from '../messaging.js';
import { handleBillingEvent, cardFromLink, returnedPaymentFee, TEST_CARDS } from '../billingauto.js';

// Online card payments via Stripe Checkout, cards on file and payment-plan autopay.
export default function paymentRoutes({ db, config, messenger, payments, mailer }) {
  const r = Router();
  const enabled = () => payments.mode === 'stripe';
  const stripe = (path, params) => payments.stripe('POST', path, params);

  // links: text-to-pay links can be sent — through Stripe Checkout, or in sandbox through the practice's own "Pay my
  // bill" page, which takes the published test cards only (so the whole flow can be tried without a processor).
  r.get('/payments/config', (_req, res) => res.json({ enabled: enabled(), links: enabled() || payments.mode === 'sandbox', mode: payments.mode, cards_on_file: payments.enabled, mail: { enabled: !!mailer?.enabled, name: mailer?.name } }));

  // ---- Cards on file (belong to the guarantor) ----
  const guarantorOf = async (patient) => (patient.guarantor_id ? db.get('SELECT * FROM patients WHERE id = ?', patient.guarantor_id) : patient);
  const methodView = (m) => ({ id: m.id, brand: m.brand, last4: m.last4, exp_month: m.exp_month, exp_year: m.exp_year, provider: m.provider, created_at: m.created_at });

  r.get('/patients/:id/payment-methods', requirePermission('billing:read'), async (req, res) => {
    const g = await guarantorOf(await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient'));
    res.json((await db.all('SELECT * FROM payment_methods WHERE practice_id = ? AND patient_id = ? AND removed_at IS NULL ORDER BY id DESC', req.user.practice_id, g.id)).map(methodView));
  });

  // Stripe: a secure page (hosted by Stripe) where the card is entered — sent to the patient or opened at the front desk.
  r.post('/patients/:id/card-setup', requirePermission('billing:write'), async (req, res) => {
    if (!enabled()) throw new HttpError(409, payments.mode === 'sandbox' ? 'Sandbox: add a test card directly' : 'Card payments are not configured. Set STRIPE_SECRET_KEY on the server.');
    const g = await guarantorOf(await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient'));
    await refuseTraining(db, g.id, 'saving a card with the card processor');
    const url = await payments.cardSetupUrl(db, g, { successUrl: `${config.appUrl}/pay/card-saved`, cancelUrl: `${config.appUrl}/pay/cancelled` });
    let message = null;
    if (req.body?.send) {
      const target = preferredChannel(g, req.body.send === 'auto' ? undefined : req.body.send);
      if (!target) throw new HttpError(400, 'Patient has no reachable phone or email (or has opted out)');
      const practice = await db.get('SELECT name FROM practices WHERE id = ?', req.user.practice_id);
      message = await sendMessage(db, messenger, {
        practiceId: req.user.practice_id, patientId: g.id, userId: req.user.id, kind: 'payment_request', channel: target.channel, to: target.to,
        subject: subjectFor(patientLang(g), 'card_setup', `Save a card for your payment plan — ${practice.name}`, practice.name),
        body: await messageText(db, req.user.practice_id, 'card_setup', { first_name: g.first_name, link: url }, patientLang(g)),
      });
    }
    await audit(db, req, 'card.setup_link', 'patients', g.id);
    res.status(201).json({ url, message });
  });

  // Sandbox only: save one of the test cards (never a real card number).
  r.post('/patients/:id/payment-methods', requirePermission('billing:write'), async (req, res) => {
    if (payments.mode !== 'sandbox') throw new HttpError(409, 'Cards are saved on the secure card page');
    const number = String(req.body?.number || '').replace(/\D/g, '');
    if (!TEST_CARDS[number]) throw new HttpError(400, 'Sandbox accepts test cards only: 4242 4242 4242 4242 (approves), 4000 0000 0000 0002 (declines), 5555 5555 5555 4444, 4000 0566 5566 5556 (debit)');
    const g = await guarantorOf(await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient'));
    const id = await insert(db, 'payment_methods', {
      practice_id: req.user.practice_id, patient_id: g.id, provider: 'sandbox', brand: TEST_CARDS[number].brand, last4: number.slice(-4), funding: TEST_CARDS[number].funding,
      exp_month: 12, exp_year: new Date().getUTCFullYear() + 3, created_by: req.user.id,
    });
    await audit(db, req, 'card.saved', 'payment_methods', id);
    res.status(201).json(methodView(await db.get('SELECT * FROM payment_methods WHERE id = ?', id)));
  });

  r.delete('/payment-methods/:mid', requirePermission('billing:write'), async (req, res) => {
    const m = await findOr404(db, 'payment_methods', req.params.mid, req.user.practice_id, 'Card');
    await db.run("UPDATE payment_methods SET removed_at = datetime('now') WHERE id = ?", m.id);
    await db.run('UPDATE payment_plans SET autopay_method_id = NULL WHERE autopay_method_id = ?', m.id);
    if (m.payment_method_id && enabled()) await payments.stripe('POST', `payment_methods/${m.payment_method_id}/detach`, {}).catch(() => {});
    await audit(db, req, 'card.removed', 'payment_methods', m.id);
    res.json({ ok: true });
  });

  // Take the amount that's due now (instead of waiting for the next autopay run).
  r.post('/payment-plans/:planId/charge-now', requirePermission('billing:write'), async (req, res) => {
    const plan = await findOr404(db, 'payment_plans', req.params.planId, req.user.practice_id, 'Payment plan');
    if (!plan.autopay_method_id) throw new HttpError(409, 'Choose a card on file for this plan first');
    const [result] = await runAutopay(db, payments, messenger, { planId: plan.id, force: true });
    if (!result) throw new HttpError(409, 'Nothing is due on this plan right now');
    await audit(db, req, 'payment_plan.charge', 'payment_plans', plan.id, result);
    res.json(result);
  });

  r.get('/patients/:id/payment-requests', requirePermission('billing:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json(await db.all('SELECT * FROM payment_requests WHERE practice_id = ? AND patient_id = ? ORDER BY id DESC', req.user.practice_id, patient.id));
  });

  // Creates a hosted card-payment page for the patient and optionally texts/emails the link ("text-to-pay").
  r.post('/patients/:id/payment-requests', requirePermission('billing:write'), async (req, res) => {
    const sandbox = !enabled() && payments.mode === 'sandbox';
    if (!enabled() && !sandbox) throw new HttpError(501, 'Card payments are not configured. Set STRIPE_SECRET_KEY on the server.');
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const practice = await db.get('SELECT name, slug, portal_enabled FROM practices WHERE id = ?', req.user.practice_id);
    if (sandbox && (!practice.slug || practice.portal_enabled === 0)) throw new HttpError(409, 'Sandbox payment links open the practice’s “Pay my bill” page: set the practice’s web address name and turn on the patient portal in Settings');
    // No amount given: ask for what the patient owes, not what insurance is still expected to pay.
    const portion = async () => (await patientBalance(db, req.user.practice_id, patient.id)) - (await pendingInsurance(db, req.user.practice_id, patient.id)).total;
    const amount = toCents(req.body?.amount ?? (await portion()));
    if (amount < 50) throw new HttpError(400, 'Amount must be at least $0.50');
    const id = await insert(db, 'payment_requests', { practice_id: req.user.practice_id, patient_id: patient.id, amount, created_by: req.user.id });
    // Sandbox: this account's "Pay my bill" page (its statement code filled in), which posts a test-card payment to
    // the ledger like a real one; the request is marked with a sandbox session id so it's never mistaken for Stripe's.
    const session = sandbox ? {
      id: `sbx_cs_${id}`,
      url: `${config.appUrl}/billpay/${encodeURIComponent(practice.slug)}?code=${await payCodeFor(db, req.user.practice_id, patient.guarantor_id || patient.id)}`,
    } : await stripe('checkout/sessions', {
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(amount),
      'line_items[0][price_data][product_data][name]': `${practice.name} - account payment`,
      client_reference_id: String(id),
      'metadata[payment_request_id]': String(id),
      'metadata[practice_id]': String(req.user.practice_id),
      // On the payment itself too, so reconciliation can find this practice's charges at the processor.
      'payment_intent_data[metadata][practice_id]': String(req.user.practice_id),
      success_url: `${config.appUrl}/pay/success`,
      cancel_url: `${config.appUrl}/pay/cancelled`,
      ...(patient.email ? { customer_email: patient.email } : {}),
    });
    await db.run('UPDATE payment_requests SET session_id = ?, url = ? WHERE id = ?', session.id, session.url, id);
    let message = null;
    if (req.body?.send) {
      const target = preferredChannel(patient, req.body.send === 'auto' ? undefined : req.body.send);
      if (target) {
        message = await sendMessage(db, messenger, {
          practiceId: req.user.practice_id, patientId: patient.id, userId: req.user.id, kind: 'payment_request', channel: target.channel, to: target.to,
          subject: subjectFor(patientLang(patient), 'payment_link', `Payment request from ${practice.name}`, practice.name),
          body: await messageText(db, req.user.practice_id, 'payment_link', { first_name: patient.first_name, amount, link: session.url }, patientLang(patient)),
        });
      }
    }
    await audit(db, req, 'payment_request.create', 'payment_requests', id, { amount });
    res.status(201).json({ ...(await db.get('SELECT * FROM payment_requests WHERE id = ?', id)), message });
  });

  return r;
}

// Verifies the Stripe-Signature header (HMAC-SHA256 over "<t>.<raw body>", 5 minute tolerance).
export function verifyStripeSignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(String(header || '').split(',').map((kv) => kv.split('=')));
  const sigs = String(header || '').split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(nowSec - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => {
    const given = Buffer.from(s, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// Mounted before the JSON body parser: signature verification needs the exact raw bytes.
export function stripeWebhook({ db, config, payments, messenger }) {
  const r = Router();
  r.post('/api/webhooks/stripe', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    if (!config.stripeWebhookSecret) return res.status(501).json({ error: 'Webhook secret not configured' });
    const raw = req.body.toString('utf8');
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], config.stripeWebhookSecret)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    const event = JSON.parse(raw);
    if (event.type === 'checkout.session.completed' && event.data.object.mode === 'setup' && event.data.object.metadata?.purpose === 'card_on_file') {
      const session = event.data.object;
      const patientId = Number(session.metadata.patient_id);
      const practiceId = Number(session.metadata.practice_id);
      const card = await payments.cardFromSetupSession(session);
      const exists = await db.get('SELECT id FROM payment_methods WHERE payment_method_id = ? AND removed_at IS NULL', card.payment_method_id);
      let methodId = exists?.id ?? null;
      if (!exists && (await db.get('SELECT id FROM patients WHERE id = ? AND practice_id = ?', patientId, practiceId))) {
        methodId = await insert(db, 'payment_methods', { practice_id: practiceId, patient_id: patientId, provider: 'stripe', ...card });
        await audit(db, { ip: req.ip, user: { practice_id: practiceId, id: null } }, 'card.saved', 'payment_methods', methodId);
      }
      // Saved from a patient's billing link (update the card after a decline, or agree to a set-up): billingauto.js
      // puts it on their automatic payments and retries what was declined.
      const linkId = Number(session.metadata?.billing_link);
      if (linkId && methodId) {
        const link = await db.get('SELECT * FROM billing_links WHERE id = ? AND practice_id = ? AND patient_id = ?', linkId, practiceId, patientId);
        if (link) await cardFromLink(db, payments, messenger, link, methodId);
      }
    } else if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && event.data.object.metadata?.booking_request_id) {
      // An online booking deposit: mark it paid (once), then book it if the practice books instantly.
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        const flipped = await db.run(
          "UPDATE booking_requests SET deposit_status = 'paid', deposit_reference = ?, deposit_amount = ? WHERE deposit_session_id = ? AND deposit_status = 'awaiting'",
          session.payment_intent || session.id, session.amount_total, session.id,
        );
        const b = await db.get('SELECT * FROM booking_requests WHERE deposit_session_id = ?', session.id);
        if (flipped.changes && b) {
          await audit(db, { ip: req.ip, user: { practice_id: b.practice_id, id: null } }, 'booking.deposit_paid', 'booking_requests', b.id, { amount: session.amount_total });
          const practice = await db.get('SELECT instant_booking FROM practices WHERE id = ?', b.practice_id);
          if (practice.instant_booking && b.status === 'pending') {
            try {
              const apptId = await finishBooking(db, b);
              if (messenger) await sendAppointmentReminder(db, messenger, { appointmentId: apptId, appUrl: config.appUrl, kind: 'booking_confirmation' });
            } catch (err) {
              if (!err.status || err.status >= 500) throw err;
              // The slot went after all: the paid request waits for the office, flagged.
              await insert(db, 'tasks', { practice_id: b.practice_id, priority: 'high', due_date: (await practiceNow(db, b.practice_id)).slice(0, 10), title: `Online booking with paid deposit needs a new time: ${b.first_name} ${b.last_name} (${err.message})` });
            }
          }
        }
      }
    } else if (event.type === 'checkout.session.expired' && event.data.object.metadata?.booking_request_id) {
      // Never paid: the held slot is released.
      await db.run("UPDATE booking_requests SET deposit_status = 'expired', status = 'declined' WHERE deposit_session_id = ? AND deposit_status = 'awaiting'", event.data.object.id);
    } else if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        // Marked paid first, conditionally: of two deliveries of the same event (Stripe retries, and sends
        // completed + async_payment_succeeded) — or the patient coming back first — only one posts it (billpay.js).
        const posted = await postOnlinePayment(db, session);
        if (session.metadata?.source === 'portal' || session.metadata?.source === 'billpay') await afterOnlinePayment(db, payments, messenger, session, posted);
        else if (posted) await autoReceipt(db, messenger, posted);
      }
    } else if (event.type === 'checkout.session.async_payment_failed') {
      // A bank (ACH) payment that bounced after the patient finished: nothing was posted; billing hears about it.
      const session = event.data.object;
      const pr = await db.get("SELECT * FROM payment_requests WHERE session_id = ? AND status = 'pending'", session.id);
      if (pr) {
        await db.run("UPDATE payment_requests SET status = 'cancelled' WHERE id = ?", pr.id);
        const payer = await db.get('SELECT * FROM patients WHERE id = ?', pr.patient_id);
        await paymentFailed(db, { practiceId: pr.practice_id, payer, amount: pr.amount, reason: 'The bank payment didn’t clear', source: session.metadata?.source });
        // The office's returned-payment fee, when it has one set to apply automatically (once per payment).
        await returnedPaymentFee(db, { practiceId: pr.practice_id, patientId: payer.id, amount: pr.amount, key: session.id });
      }
    } else if (event.type === 'payment_intent.succeeded' && event.data.object.metadata?.terminal_payment_id) {
      // A card-reader payment: post it even if nobody's screen is still checking.
      const row = await db.get('SELECT * FROM terminal_payments WHERE id = ? AND intent_id = ?', Number(event.data.object.metadata.terminal_payment_id), event.data.object.id);
      if (row) await refreshTerminalPayment(db, payments, messenger, row);
    } else if (event.type === 'checkout.session.expired') {
      await db.run("UPDATE payment_requests SET status = 'expired' WHERE session_id = ? AND status = 'pending'", event.data.object.id);
    } else if (['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.refunded'].includes(event.type)) {
      // Disputes (chargebacks) and refunds made at the processor: posted once each as reversals (billingauto.js).
      await handleBillingEvent(db, { messenger }, event);
    }
    res.json({ received: true });
  });
  return r;
}
