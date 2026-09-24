import { autoReceipt } from './receipts.js';
import { raiseIssue, resolveIssue, failed } from './issues.js';
import { randomBytes } from 'node:crypto';
import { HttpError } from './auth.js';
import { insert, practiceNow } from './util.js';
import { planStatus } from './routes/family.js';
import { trackedCharge, mayCharge, chargeDeclined, chargeSucceeded, TEST_CARDS } from './billingauto.js';

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
      // metadata: extra keys for the webhook (e.g. billing_link: a patient's update-card link, billingauto.js).
      async cardSetupUrl(db, patient, { successUrl, cancelUrl, metadata = {} }) {
        const customer = await this.ensureCustomer(db, patient);
        const s = await stripe('POST', 'checkout/sessions', {
          mode: 'setup', customer, 'payment_method_types[0]': 'card', currency: 'usd',
          'metadata[purpose]': 'card_on_file', 'metadata[patient_id]': String(patient.id), 'metadata[practice_id]': String(patient.practice_id),
          ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`metadata[${k}]`, String(v)])),
          success_url: successUrl, cancel_url: cancelUrl,
        });
        return s.url;
      },
      // After Checkout (setup mode) completes: the saved card's details.
      async cardFromSetupSession(session) {
        const si = await stripe('GET', `setup_intents/${session.setup_intent}`, { 'expand[]': 'payment_method' });
        const pm = si.payment_method;
        // funding (credit / debit / prepaid): a surcharge is never added to a debit or prepaid card (billingauto.js).
        return { customer_id: session.customer, payment_method_id: pm.id, brand: pm.card?.brand, last4: pm.card?.last4, exp_month: pm.card?.exp_month, exp_year: pm.card?.exp_year, funding: pm.card?.funding || null };
      },
      // Refunds part or all of an earlier card payment (by its PaymentIntent) back to the card.
      async refund({ reference, amount, idempotencyKey }) {
        const pi = String(reference || '');
        if (!pi.startsWith('pi_')) throw new HttpError(400, "That payment wasn't made by card through Stripe — refund it by cash or check");
        // Marked as ours, so the charge.refunded webhook doesn't post it a second time (billingauto.js posts only outside refunds).
        const re = await stripe('POST', 'refunds', { payment_intent: pi, amount: String(amount), 'metadata[source]': 'dentalmachine' }, { idempotencyKey });
        return { reference: re.id, status: re.status };
      },
      // Card readers (Stripe Terminal, server-driven): the reader shows the amount and the patient taps or inserts.
      terminal: {
        async register(db, practice, { registrationCode, label }) {
          let location = practice.stripe_terminal_location;
          if (!location) {
            const loc = await stripe('POST', 'terminal/locations', {
              display_name: practice.name.slice(0, 100), 'address[line1]': practice.address || 'Address not set', 'address[city]': practice.city || '',
              'address[state]': practice.state || '', 'address[postal_code]': practice.zip || '', 'address[country]': 'US',
            });
            location = loc.id;
            await db.run('UPDATE practices SET stripe_terminal_location = ? WHERE id = ?', location, practice.id);
          }
          const r = await stripe('POST', 'terminal/readers', { registration_code: registrationCode, label, location });
          return { reader_id: r.id, label: r.label || label, device_type: r.device_type || null, serial_number: r.serial_number || null };
        },
        async start({ readerId, amount, description, metadata, idempotencyKey }) {
          const pi = await stripe('POST', 'payment_intents', {
            amount: String(amount), currency: 'usd', 'payment_method_types[]': 'card_present', capture_method: 'automatic', description,
            ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`metadata[${k}]`, String(v)])),
          }, { idempotencyKey });
          await stripe('POST', `terminal/readers/${readerId}/process_payment_intent`, { payment_intent: pi.id });
          return { intent_id: pi.id };
        },
        async status(row, readerId) {
          const pi = await stripe('GET', `payment_intents/${row.intent_id}`, { 'expand[]': 'latest_charge' });
          const card = pi.latest_charge?.payment_method_details?.card_present;
          if (pi.status === 'succeeded') return { status: 'succeeded', brand: card?.brand || null, last4: card?.last4 || null };
          if (pi.status === 'canceled') return { status: 'canceled' };
          const reader = await stripe('GET', `terminal/readers/${readerId}`);
          if (reader.action?.status === 'failed') return { status: 'failed', reason: reader.action.failure_message || 'The reader could not take the payment' };
          return { status: 'pending', reader: reader.status };
        },
        async cancel(row, readerId) {
          await stripe('POST', `terminal/readers/${readerId}/cancel_action`, {}).catch(() => {});
          await stripe('POST', `payment_intents/${row.intent_id}/cancel`, {}).catch(() => {});
        },
        // Test mode only: acts as if a card was tapped on the (simulated) reader.
        simulate: config.stripeSecretKey.startsWith('sk_test_') ? async (row, readerId) => { await stripe('POST', `test_helpers/terminal/readers/${readerId}/present_payment_method`, {}); } : null,
      },
      // This practice's successful card payments at Stripe between two instants (for reconciliation).
      async listCharges({ practiceId, fromTs, toTs }) {
        const out = [];
        let page = null;
        for (let i = 0; i < 50; i++) {
          const res = await stripe('GET', 'payment_intents/search', {
            query: `metadata['practice_id']:'${Number(practiceId)}' AND status:'succeeded' AND created>=${fromTs} AND created<${toTs}`, limit: '100', ...(page ? { page } : {}),
          });
          for (const pi of res.data || []) out.push({ id: pi.id, amount: pi.amount_received ?? pi.amount, created: pi.created, description: pi.description || null });
          if (!res.has_more || !res.next_page) break;
          page = res.next_page;
        }
        return out;
      },
      // Payouts that arrived between two instants, each with what it paid out (charges, refunds, disputes, fees),
      // for the daily payout check (billingauto.js reconcileDay).
      async listPayouts({ fromTs, toTs }) {
        const out = [];
        let after = null;
        for (let i = 0; i < 20; i++) {
          const res = await stripe('GET', 'payouts', { 'arrival_date[gte]': String(fromTs), 'arrival_date[lt]': String(toTs), limit: '100', ...(after ? { starting_after: after } : {}) });
          for (const po of res.data || []) {
            if (po.status === 'failed' || po.status === 'canceled') continue;
            const items = [];
            let next = null;
            for (let j = 0; j < 50; j++) {
              const bt = await stripe('GET', 'balance_transactions', { payout: po.id, limit: '100', 'expand[]': 'data.source', ...(next ? { starting_after: next } : {}) });
              for (const t of bt.data || []) {
                const src = t.source && typeof t.source === 'object' ? t.source : {};
                items.push({ id: t.id, type: t.type, amount: t.amount, fee: t.fee, net: t.net, payment_intent: src.payment_intent || null, practice_id: src.metadata?.practice_id ?? null });
              }
              if (!bt.has_more || !bt.data?.length) break;
              next = bt.data[bt.data.length - 1].id;
            }
            out.push({ id: po.id, amount: po.amount, arrival_date: po.arrival_date, items });
          }
          if (!res.has_more || !res.data?.length) break;
          after = res.data[res.data.length - 1].id;
        }
        return out;
      },
      // Online payments from the patient portal and "Pay my bill" (billpay.js): Stripe's hosted page, one payment
      // type per page — 'card' (Apple Pay / Google Pay / Link show there too, on devices that have them) or 'ach'
      // (a US bank account, which clears in a few days). saveCard keeps the card on the customer for next time.
      ach: config.stripeAch ?? process.env.PAYMENTS_ACH === 'on',
      async checkout({ customerId, amount, description, method = 'card', saveCard = false, metadata = {}, successUrl, cancelUrl, idempotencyKey }) {
        const md = (prefix) => Object.fromEntries(Object.entries(metadata).filter(([, v]) => v != null).map(([k, v]) => [`${prefix}[${k}]`, String(v)]));
        const s = await stripe('POST', 'checkout/sessions', {
          mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(amount),
          'line_items[0][price_data][product_data][name]': description, 'payment_method_types[0]': method === 'ach' ? 'us_bank_account' : 'card',
          ...(customerId ? { customer: customerId } : {}), ...(saveCard ? { 'payment_intent_data[setup_future_usage]': 'off_session' } : {}),
          ...md('metadata'), ...md('payment_intent_data[metadata]'), client_reference_id: String(metadata.payment_request_id || ''),
          success_url: successUrl, cancel_url: cancelUrl,
        }, { idempotencyKey });
        return { id: s.id, url: s.url };
      },
      checkoutSession: (id) => stripe('GET', `checkout/sessions/${encodeURIComponent(id)}`),
      // The card or bank account a payment used (to save it for next time).
      async paymentMethodOf(paymentIntentId) {
        const pi = await stripe('GET', `payment_intents/${encodeURIComponent(paymentIntentId)}`, { 'expand[]': 'payment_method' });
        const pm = pi.payment_method;
        if (!pm || typeof pm !== 'object') return null;
        return { id: pm.id, type: pm.type, customer: pi.customer || pm.customer || null, brand: pm.card?.brand || pm.us_bank_account?.bank_name || null, last4: pm.card?.last4 || pm.us_bank_account?.last4 || null, exp_month: pm.card?.exp_month ?? null, exp_year: pm.card?.exp_year ?? null, funding: pm.card?.funding || null };
      },
      detach: (paymentMethodId) => stripe('POST', `payment_methods/${encodeURIComponent(paymentMethodId)}/detach`, {}),
      async charge({ method, amount, description, idempotencyKey, metadata: extra = {} }) {
        // Every charge names its practice, so reconciliation can list a practice's charges at Stripe.
        const metadata = { practice_id: method.practice_id, ...extra };
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
    const sbx = (p) => `${p}${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
    return {
      mode: 'sandbox', enabled: true,
      // A pretend reader: the payment waits until someone "taps" (simulate); amounts ending in 02 cents decline.
      terminal: {
        async register(_db, _practice, { label }) { return { reader_id: sbx('sbx_tmr_'), label, device_type: 'simulated_wisepos_e', serial_number: null }; },
        async start() { return { intent_id: sbx('sbx_pi_') }; },
        async status(row) {
          if (!row.presented) return { status: 'pending', reader: 'online' };
          return row.amount % 100 === 2 ? { status: 'failed', reason: 'Card declined (generic decline)' } : { status: 'succeeded', brand: 'visa', last4: '4242' };
        },
        async cancel() {},
        simulate: async () => {},
      },
      async refund({ reference }) {
        if (!String(reference || '').startsWith('sbx_')) throw new HttpError(400, "That payment wasn't made by card — refund it by cash or check");
        return { reference: `sbx_re_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`, status: 'succeeded' };
      },
      // The portal and "Pay my bill" in sandbox: the published test numbers only (never a real card or account).
      ach: true,
      sandboxPay({ method, number, amount }) {
        const n = String(number || '').replace(/\D/g, '');
        if (method === 'ach') {
          if (!['000123456789', '000111111116'].includes(n)) throw new HttpError(400, 'Sandbox accepts test bank accounts only: 000123456789 (clears), 000111111116 (refused)');
          if (n === '000111111116') return { ok: false, reason: 'Bank account refused (insufficient funds)' };
          return { ok: true, reference: sbx('sbx_pi_'), brand: 'bank', last4: n.slice(-4) };
        }
        if (!TEST_CARDS[n]) throw new HttpError(400, 'Sandbox accepts test cards only: 4242 4242 4242 4242 (approves), 4000 0000 0000 0002 (declines), 5555 5555 5555 4444, 4000 0566 5566 5556 (debit)');
        if (n.endsWith('0002')) return { ok: false, reason: 'Card declined (generic decline)' };
        if (amount < 50) return { ok: false, reason: 'Amount too small' };
        return { ok: true, reference: sbx('sbx_pi_'), brand: TEST_CARDS[n].brand, last4: n.slice(-4), funding: TEST_CARDS[n].funding };
      },
      async detach() {},
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
    `SELECT pp.*, pm.customer_id, pm.payment_method_id, pm.brand, pm.last4, pm.funding, pm.removed_at AS method_removed
     FROM payment_plans pp JOIN payment_methods pm ON pm.id = pp.autopay_method_id
     WHERE pp.status = 'active' AND pp.autopay_method_id IS NOT NULL AND (pp.autopay_paused = 0 OR ?)${planId ? ' AND pp.id = ?' : ''}`,
    force ? 1 : 0, ...(planId ? [planId] : []),
  );
  const results = [];
  for (const listed of plans) {
    const today = (await practiceNow(db, listed.practice_id)).slice(0, 10);
    if ((listed.autopay_last_attempt === today && !force) || listed.method_removed) continue;
    // A declined installment waits for its retry day (day 3 / 7 / 14 — billingauto.js), unless the card was changed.
    if (!force && !(await mayCharge(db, 'payment_plan', listed.id, listed.autopay_method_id, today))) continue;
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
  if (amount <= 0) {
    // Paid another way since a decline: the retries (and their work item) are over.
    await chargeSucceeded(db, { practiceId: plan.practice_id, sourceType: 'payment_plan', sourceId: plan.id, today, note: 'nothing is due on the plan any more' });
    return null;
  }
  const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', plan.practice_id);
  // One key per installment (what's been paid so far) and attempt: a retry after a lost answer reuses it,
  // so the processor returns the first outcome rather than charging again; a retry after a decline doesn't.
  // Tracked (visible on the account) and with the surcharge the patient agreed to, if any (billingauto.js).
  const out = await trackedCharge(db, payments, {
    method: { ...plan, id: plan.autopay_method_id }, amount: amount, description: `${practice.name} payment plan #${plan.id}`,
    idempotencyKey: `autopay-${plan.id}-${status.paid}-${amount}-${plan.autopay_failures || 0}`, metadata: { payment_plan_id: plan.id, patient_id: plan.patient_id },
  }, { practiceId: plan.practice_id, patientId: plan.patient_id, sourceType: 'payment_plan', sourceId: plan.id });
  if (out.ambiguous) {
    // Leave the day's attempt open; the next run asks again with the same key.
    await db.run('UPDATE payment_plans SET autopay_message = ? WHERE id = ?', `${out.reason} — will check again (${today})`, plan.id);
    return { plan_id: plan.id, ok: false, reason: out.reason, pending: true };
  }
  await db.run('UPDATE payment_plans SET autopay_last_attempt = ? WHERE id = ?', today, plan.id);
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', plan.patient_id);
  if (out.ok && (await db.get("SELECT id FROM ledger_entries WHERE payment_plan_id = ? AND reference = ? AND type = 'payment'", plan.id, out.reference))) {
    return { plan_id: plan.id, ok: true, amount, already_posted: true };
  }
  if (out.ok) {
    // The whole charge (a surcharge is its own ledger line, also on the plan, so the plan counts only the installment).
    const entryId = await insert(db, 'ledger_entries', {
      practice_id: plan.practice_id, patient_id: plan.patient_id, type: 'payment', amount: -out.total,
      description: `Autopay — payment plan (${plan.brand || 'card'} •••• ${plan.last4})`, method: 'credit_card', reference: out.reference,
      payment_plan_id: plan.id, entry_date: today,
    });
    await db.run('UPDATE payment_plans SET autopay_failures = 0, autopay_message = ? WHERE id = ?', `Charged $${(out.total / 100).toFixed(2)} on ${today}`, plan.id);
    await chargeSucceeded(db, { practiceId: plan.practice_id, sourceType: 'payment_plan', sourceId: plan.id, today });
    const after = await planStatus(db, await db.get('SELECT * FROM payment_plans WHERE id = ?', plan.id), today);
    if (after.remaining <= 0) await db.run("UPDATE payment_plans SET status = 'completed' WHERE id = ?", plan.id);
    await autoReceipt(db, messenger, entryId);
    return { plan_id: plan.id, ok: true, amount };
  } else {
    // Nothing posted. Dunning (billingauto.js): Needs attention, the patient's update-card link, retries on the
    // practice's schedule, then paused with next steps for the team.
    const failures = (plan.autopay_failures || 0) + 1;
    const d = await chargeDeclined(db, messenger, {
      practiceId: plan.practice_id, patientId: patient.id, sourceType: 'payment_plan', sourceId: plan.id, methodId: plan.autopay_method_id, amount, reason: out.reason, today,
    });
    const paused = d.paused ? 1 : 0;
    await db.run('UPDATE payment_plans SET autopay_failures = ?, autopay_paused = ?, autopay_message = ? WHERE id = ?', failures, paused, `${out.reason} (${today})${paused ? '' : ` — next try ${d.next_retry_on}`}`, plan.id);
    return { plan_id: plan.id, ok: false, reason: out.reason, paused: !!paused };
  }
}
