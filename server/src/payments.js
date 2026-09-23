import { randomBytes } from 'node:crypto';
import { HttpError } from './auth.js';
import { insert, practiceNow } from './util.js';
import { planStatus } from './routes/family.js';
import { sendMessage, preferredChannel } from './messaging.js';
import { messageText, patientLang, subjectFor } from './templates.js';

// Card processing. Stripe when STRIPE_SECRET_KEY is set; PAYMENTS=sandbox simulates it for demos
// (test cards: 4242… approves, 4000 0000 0000 0002 declines, like Stripe's test mode).
// Card numbers never reach this server: with Stripe, cards are entered on Stripe's hosted pages.
export function createPayments({ config, fetchImpl = globalThis.fetch }) {
  if (config.stripeSecretKey) {
    const stripe = async (method, path, params, { idempotencyKey } = {}) => {
      const res = await fetchImpl(`https://api.stripe.com/v1/${path}${method === 'GET' && params ? `?${new URLSearchParams(params)}` : ''}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.stripeSecretKey}`, 'Content-Type': 'application/x-www-form-urlencoded',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: method === 'GET' ? undefined : new URLSearchParams(params || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new HttpError(502, `Stripe: ${data.error?.message || res.status}`), { stripe: data.error });
      return data;
    };
    return {
      mode: 'stripe', enabled: true, stripe,
      async ensureCustomer(db, patient) {
        if (patient.stripe_customer_id) return patient.stripe_customer_id;
        const c = await stripe('POST', 'customers', {
          name: `${patient.first_name} ${patient.last_name}`, ...(patient.email ? { email: patient.email } : {}), 'metadata[patient_id]': String(patient.id), 'metadata[practice_id]': String(patient.practice_id),
        });
        await db.run('UPDATE patients SET stripe_customer_id = ? WHERE id = ?', c.id, patient.id);
        return c.id;
      },
      // Hosted page where the patient (or front desk, on the patient's behalf) saves a card.
      async cardSetupUrl(db, patient, { successUrl, cancelUrl }) {
        const customer = await this.ensureCustomer(db, patient);
        const s = await stripe('POST', 'checkout/sessions', {
          mode: 'setup', customer, 'payment_method_types[0]': 'card', currency: 'usd',
          'metadata[purpose]': 'card_on_file', 'metadata[patient_id]': String(patient.id), 'metadata[practice_id]': String(patient.practice_id),
          success_url: successUrl, cancel_url: cancelUrl,
        });
        return s.url;
      },
      // After Checkout (setup mode) completes: the saved card's details.
      async cardFromSetupSession(session) {
        const si = await stripe('GET', `setup_intents/${session.setup_intent}`, { 'expand[]': 'payment_method' });
        const pm = si.payment_method;
        return { customer_id: session.customer, payment_method_id: pm.id, brand: pm.card?.brand, last4: pm.card?.last4, exp_month: pm.card?.exp_month, exp_year: pm.card?.exp_year };
      },
      // Refunds part or all of an earlier card payment (by its PaymentIntent) back to the card.
      async refund({ reference, amount, idempotencyKey }) {
        const pi = String(reference || '');
        if (!pi.startsWith('pi_')) throw new HttpError(400, "That payment wasn't made by card through Stripe — refund it by cash or check");
        const re = await stripe('POST', 'refunds', { payment_intent: pi, amount: String(amount) }, { idempotencyKey });
        return { reference: re.id, status: re.status };
      },
      async charge({ method, amount, description, idempotencyKey, metadata = {} }) {
        try {
          const pi = await stripe('POST', 'payment_intents', {
            amount: String(amount), currency: 'usd', customer: method.customer_id, payment_method: method.payment_method_id,
            off_session: 'true', confirm: 'true', description, ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`metadata[${k}]`, String(v)])),
          }, { idempotencyKey });
          if (pi.status === 'succeeded') return { ok: true, reference: pi.id };
          return { ok: false, reason: pi.status === 'requires_action' ? 'The bank needs the cardholder to approve this payment' : `Payment ${pi.status}` };
        } catch (err) {
          // No answer, or a Stripe-side error: the charge may or may not have happened. Retrying later
          // with the same idempotency key returns the original outcome instead of charging twice.
          if (!err.stripe || err.stripe.type === 'api_error' || err.stripe.type === 'idempotency_error') {
            return { ok: false, ambiguous: true, reason: `Couldn't confirm the charge (${err.message})` };
          }
          return { ok: false, reason: err.stripe?.decline_code ? `Card declined (${err.stripe.decline_code.replace(/_/g, ' ')})` : err.message };
        }
      },
    };
  }
  if (config.payments === 'sandbox') {
    return {
      mode: 'sandbox', enabled: true,
      async refund({ reference }) {
        if (!String(reference || '').startsWith('sbx_')) throw new HttpError(400, "That payment wasn't made by card — refund it by cash or check");
        return { reference: `sbx_re_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`, status: 'succeeded' };
      },
      async charge({ method, amount }) {
        if (method.last4 === '0002') return { ok: false, reason: 'Card declined (generic decline)' };
        if (amount < 50) return { ok: false, reason: 'Amount too small' };
        return { ok: true, reference: `sbx_pi_${Date.now().toString(36)}${randomBytes(4).toString('hex')}` };
      },
    };
  }
  return { mode: 'none', enabled: false };
}

// Charges payment-plan installments that are due, once per plan per day. Declines are recorded,
// the office gets a task and the patient a note; autopay pauses after three declines in a row.
export async function runAutopay(db, payments, messenger, { planId = null, force = false } = {}) {
  if (!payments.enabled) return [];
  const plans = await db.all(
    `SELECT pp.*, pm.customer_id, pm.payment_method_id, pm.brand, pm.last4, pm.removed_at AS method_removed
     FROM payment_plans pp JOIN payment_methods pm ON pm.id = pp.autopay_method_id
     WHERE pp.status = 'active' AND pp.autopay_method_id IS NOT NULL AND (pp.autopay_paused = 0 OR ?)${planId ? ' AND pp.id = ?' : ''}`,
    force ? 1 : 0, ...(planId ? [planId] : []),
  );
  const results = [];
  for (const listed of plans) {
    const today = (await practiceNow(db, listed.practice_id)).slice(0, 10);
    if ((listed.autopay_last_attempt === today && !force) || listed.method_removed) continue;
    // Take the plan for this run, so two servers (or a scheduled run and a "charge now") can't both charge it.
    const lock = new Date(Date.now() + 10 * 60_000).toISOString();
    const took = await db.run(
      "UPDATE payment_plans SET autopay_lock = ? WHERE id = ? AND status = 'active' AND (autopay_lock IS NULL OR autopay_lock < ?) AND (autopay_last_attempt IS NULL OR autopay_last_attempt <> ? OR ? = 1)",
      lock, listed.id, new Date().toISOString(), today, force ? 1 : 0,
    );
    if (!took.changes) continue;
    try {
      const result = await autopayPlan(db, payments, messenger, { ...listed, ...(await db.get('SELECT * FROM payment_plans WHERE id = ?', listed.id)) }, today);
      if (result) results.push(result);
    } finally {
      await db.run('UPDATE payment_plans SET autopay_lock = NULL WHERE id = ? AND autopay_lock = ?', listed.id, lock);
    }
  }
  return results;
}

async function autopayPlan(db, payments, messenger, plan, today) {
  const status = await planStatus(db, plan, today);
  // Never charge more than the household actually owes (e.g. after insurance paid more than expected).
  const owed = (await db.get('SELECT COALESCE(SUM(l.amount), 0) AS n FROM ledger_entries l JOIN patients p ON p.id = l.patient_id WHERE p.id = ? OR p.guarantor_id = ?', plan.patient_id, plan.patient_id)).n;
  // What's due on the plan, never more than is left on the plan or than the household owes.
  const amount = Math.min(status.past_due, status.remaining, owed);
  if (amount <= 0) return null;
  const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', plan.practice_id);
  // One key per installment (what's been paid so far) and attempt: a retry after a lost answer reuses it,
  // so the processor returns the first outcome rather than charging again; a retry after a decline doesn't.
  const out = await payments.charge({
    method: plan, amount: amount, description: `${practice.name} payment plan #${plan.id}`,
    idempotencyKey: `autopay-${plan.id}-${status.paid}-${amount}-${plan.autopay_failures || 0}`, metadata: { payment_plan_id: plan.id, patient_id: plan.patient_id },
  });
  if (out.ambiguous) {
    // Leave the day's attempt open; the next run asks again with the same key.
    await db.run('UPDATE payment_plans SET autopay_message = ? WHERE id = ?', `${out.reason} — will check again (${today})`, plan.id);
    return { plan_id: plan.id, ok: false, reason: out.reason, pending: true };
  }
  await db.run('UPDATE payment_plans SET autopay_last_attempt = ? WHERE id = ?', today, plan.id);
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', plan.patient_id);
  if (out.ok && (await db.get('SELECT id FROM ledger_entries WHERE payment_plan_id = ? AND reference = ?', plan.id, out.reference))) {
    return { plan_id: plan.id, ok: true, amount, already_posted: true };
  }
  if (out.ok) {
    await insert(db, 'ledger_entries', {
      practice_id: plan.practice_id, patient_id: plan.patient_id, type: 'payment', amount: -amount,
      description: `Autopay — payment plan (${plan.brand || 'card'} •••• ${plan.last4})`, method: 'credit_card', reference: out.reference,
      payment_plan_id: plan.id, entry_date: today,
    });
    await db.run('UPDATE payment_plans SET autopay_failures = 0, autopay_message = ? WHERE id = ?', `Charged $${(amount / 100).toFixed(2)} on ${today}`, plan.id);
    const after = await planStatus(db, await db.get('SELECT * FROM payment_plans WHERE id = ?', plan.id), today);
    if (after.remaining <= 0) await db.run("UPDATE payment_plans SET status = 'completed' WHERE id = ?", plan.id);
    return { plan_id: plan.id, ok: true, amount };
  } else {
    const failures = (plan.autopay_failures || 0) + 1;
    const paused = failures >= 3 ? 1 : 0;
    await db.run('UPDATE payment_plans SET autopay_failures = ?, autopay_paused = ?, autopay_message = ? WHERE id = ?', failures, paused, `${out.reason} (${today})`, plan.id);
    await insert(db, 'tasks', {
      practice_id: plan.practice_id, patient_id: plan.patient_id, priority: 'high', due_date: today,
      title: `Autopay ${paused ? 'paused' : 'failed'}: ${patient.first_name} ${patient.last_name} — ${out.reason}`,
    });
    const target = preferredChannel(patient);
    if (target && messenger) {
      await sendMessage(db, messenger, {
        practiceId: plan.practice_id, patientId: patient.id, kind: 'payment_request', channel: target.channel, to: target.to,
        subject: subjectFor(patientLang(patient), 'card_declined', `Payment plan payment didn't go through — ${practice.name}`, practice.name),
        body: await messageText(db, plan.practice_id, 'card_declined', { first_name: patient.first_name, amount, reason: out.reason }, patientLang(patient)),
      }).catch(() => {});
    }
    return { plan_id: plan.id, ok: false, reason: out.reason, paused: !!paused };
  }
}
