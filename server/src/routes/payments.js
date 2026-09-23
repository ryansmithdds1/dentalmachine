import express, { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, insert, audit, toCents, practiceNow } from '../util.js';
import { patientBalance } from '../services.js';
import { sendMessage, preferredChannel } from '../messaging.js';

// Online card payments via Stripe Checkout. Enabled when STRIPE_SECRET_KEY is configured.
export default function paymentRoutes({ db, config, fetchImpl, messenger }) {
  const r = Router();
  const enabled = () => !!config.stripeSecretKey;

  async function stripe(path, params) {
    const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.stripeSecretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `Stripe: ${data.error?.message || res.status}`);
    return data;
  }

  r.get('/payments/config', (_req, res) => res.json({ enabled: enabled() }));

  r.get('/patients/:id/payment-requests', requirePermission('billing:read'), (req, res) => {
    const patient = findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json(db.all('SELECT * FROM payment_requests WHERE practice_id = ? AND patient_id = ? ORDER BY id DESC', req.user.practice_id, patient.id));
  });

  // Creates a hosted card-payment page for the patient and optionally texts/emails the link ("text-to-pay").
  r.post('/patients/:id/payment-requests', requirePermission('billing:write'), async (req, res) => {
    if (!enabled()) throw new HttpError(501, 'Card payments are not configured. Set STRIPE_SECRET_KEY on the server.');
    const patient = findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const practice = db.get('SELECT name FROM practices WHERE id = ?', req.user.practice_id);
    const amount = toCents(req.body?.amount ?? patientBalance(db, req.user.practice_id, patient.id));
    if (amount < 50) throw new HttpError(400, 'Amount must be at least $0.50');
    const id = insert(db, 'payment_requests', { practice_id: req.user.practice_id, patient_id: patient.id, amount, created_by: req.user.id });
    const session = await stripe('checkout/sessions', {
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(amount),
      'line_items[0][price_data][product_data][name]': `${practice.name} - account payment`,
      client_reference_id: String(id),
      'metadata[payment_request_id]': String(id),
      'metadata[practice_id]': String(req.user.practice_id),
      success_url: `${config.appUrl}/pay/success`,
      cancel_url: `${config.appUrl}/pay/cancelled`,
      ...(patient.email ? { customer_email: patient.email } : {}),
    });
    db.run('UPDATE payment_requests SET session_id = ?, url = ? WHERE id = ?', session.id, session.url, id);
    let message = null;
    if (req.body?.send) {
      const target = preferredChannel(patient, req.body.send === 'auto' ? undefined : req.body.send);
      if (target) {
        message = await sendMessage(db, messenger, {
          practiceId: req.user.practice_id, patientId: patient.id, userId: req.user.id, kind: 'payment_request', channel: target.channel, to: target.to,
          subject: `Payment request from ${practice.name}`,
          body: `Hi ${patient.first_name}, you can pay your ${practice.name} balance of $${(amount / 100).toFixed(2)} securely online: ${session.url}`,
        });
      }
    }
    audit(db, req, 'payment_request.create', 'payment_requests', id, { amount });
    res.status(201).json({ ...db.get('SELECT * FROM payment_requests WHERE id = ?', id), message });
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
export function stripeWebhook({ db, config }) {
  const r = Router();
  r.post('/api/webhooks/stripe', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    if (!config.stripeWebhookSecret) return res.status(501).json({ error: 'Webhook secret not configured' });
    const raw = req.body.toString('utf8');
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], config.stripeWebhookSecret)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    const event = JSON.parse(raw);
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        db.tx(() => {
          const pr = db.get('SELECT * FROM payment_requests WHERE session_id = ?', session.id);
          if (!pr || pr.status === 'paid') return; // unknown or already applied (Stripe retries webhooks)
          const entryId = insert(db, 'ledger_entries', {
            practice_id: pr.practice_id, patient_id: pr.patient_id, type: 'payment', amount: -session.amount_total,
            description: 'Online card payment', method: 'credit_card', reference: session.payment_intent || session.id,
            entry_date: practiceNow(db, pr.practice_id).slice(0, 10),
          });
          db.run("UPDATE payment_requests SET status = 'paid', paid_at = datetime('now'), ledger_entry_id = ? WHERE id = ?", entryId, pr.id);
          audit(db, { ip: req.ip, user: { practice_id: pr.practice_id, id: null } }, 'payment.online', 'ledger_entries', entryId, { amount: session.amount_total });
        });
      }
    } else if (event.type === 'checkout.session.expired') {
      db.run("UPDATE payment_requests SET status = 'expired' WHERE session_id = ? AND status = 'pending'", event.data.object.id);
    }
    res.json({ received: true });
  });
  return r;
}
