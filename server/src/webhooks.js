import { createHmac, randomBytes } from 'node:crypto';
import { isTrainingPatient } from './training.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { insert } from './util.js';
import { assertPublicUrl } from './netguard.js';

// Outbound webhooks: other systems (reminder services, marketing tools, a practice's own website)
// hear about new and changed appointments, patients and payments. Each delivery is signed like
// Stripe's — header `DM-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the endpoint secret>` —
// and retried with backoff until it gets a 2xx.

export const EVENTS = ['appointment.created', 'appointment.updated', 'appointment.cancelled', 'patient.created', 'patient.updated', 'payment.created'];
const BACKOFF_MIN = [1, 5, 30, 120, 720, 1440];

// The shapes the public API and webhooks share (no internal-only fields).
export const apiPatient = (p) => p && ({
  id: p.id, first_name: p.first_name, last_name: p.last_name, preferred_name: p.preferred_name || null, dob: p.dob || null, gender: p.gender || null,
  phone: p.phone || null, email: p.email || null, address: p.address || null, city: p.city || null, state: p.state || null, zip: p.zip || null,
  status: p.status, sms_opt_in: !!p.sms_opt_in, email_opt_in: !!p.email_opt_in, primary_provider_id: p.primary_provider_id || null,
  guarantor_id: p.guarantor_id || null, created_at: p.created_at, updated_at: p.updated_at,
});
export const apiAppointment = (a) => a && ({
  id: a.id, patient_id: a.patient_id, provider_id: a.provider_id, operatory_id: a.operatory_id || null, appointment_type_id: a.appointment_type_id || null,
  start_time: a.start_time, end_time: a.end_time, status: a.status, reason: a.reason || null, confirmed_at: a.confirmed_at || null, created_at: a.created_at,
});
export const apiPayment = (l) => l && ({
  id: l.id, patient_id: l.patient_id, amount: -l.amount, method: l.method || null, description: l.description, date: l.entry_date,
  reference: l.method === 'credit_card' ? null : l.reference || null, voided: !!l.voided_at, created_at: l.created_at,
});

export const sign = (secret, body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

let deliverer = null; // set by startWebhooks; tests can deliver synchronously

// Queues an event for every endpoint that wants it, and sends right away in the background.
export async function emitEvent(db, practiceId, type, object) {
  // Nothing about the training patient goes to other systems (training.js).
  const patientId = type.startsWith('patient.') ? object?.id : object?.patient_id;
  if (patientId != null && await isTrainingPatient(db, patientId)) return [];
  const endpoints = await db.all('SELECT id, events FROM webhook_endpoints WHERE practice_id = ? AND active = 1', practiceId);
  const wanted = endpoints.filter((e) => { const ev = JSON.parse(e.events || '[]'); return ev.includes('*') || ev.includes(type); });
  if (!wanted.length) return [];
  const payload = JSON.stringify({ id: `evt_${randomBytes(12).toString('hex')}`, type, created: new Date().toISOString(), data: { object } });
  const ids = [];
  for (const e of wanted) ids.push(await insert(db, 'webhook_deliveries', { practice_id: practiceId, endpoint_id: e.id, event: type, payload, next_attempt_at: new Date().toISOString() }));
  if (deliverer) setImmediate(() => deliverer(ids).catch(() => {}));
  return ids;
}

// Sends due deliveries (or the given ones). Never throws for a failing endpoint.
export async function deliverWebhooks(db, { ids = null, fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const rows = await db.all(
    `SELECT d.*, e.url, e.secret FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.status = 'pending' AND e.active = 1 AND ${ids ? `d.id IN (${ids.map(() => '?').join(',')})` : 'd.next_attempt_at <= ?'} ORDER BY d.id LIMIT 200`,
    ...(ids || [now.toISOString()]),
  );
  let ok = 0;
  for (const d of rows) {
    // Claim the row so two servers don't send it twice.
    const took = await db.run("UPDATE webhook_deliveries SET status = 'sending' WHERE id = ? AND status = 'pending'", d.id);
    if (!took.changes) continue;
    let code = null;
    let error = null;
    try {
      await assertPublicUrl(d.url, { what: 'The webhook URL' });
      // Redirects aren't followed: a 3xx counts as a failed delivery, so a public URL can't bounce us inward.
      const res = await fetchImpl(d.url, {
        method: 'POST', body: d.payload, signal: AbortSignal.timeout(10_000), redirect: 'manual',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'DentalMachine-Webhooks/1', 'DM-Event': d.event, 'DM-Signature': sign(d.secret, d.payload) },
      });
      code = res.status;
      if (res.status >= 300) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err.name === 'TimeoutError' ? 'Timed out after 10s' : err.message;
    }
    const attempts = d.attempts + 1;
    if (!error) {
      ok++;
      await db.run("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, response_code = ?, delivered_at = datetime('now'), last_error = NULL WHERE id = ?", attempts, code, d.id);
      await db.run('UPDATE webhook_endpoints SET failures = 0 WHERE id = ?', d.endpoint_id);
      await resolveIssue(db, d.practice_id, `webhook:${d.endpoint_id}`, 'Resolved: a later delivery to this address worked');
    } else {
      const gaveUp = attempts >= BACKOFF_MIN.length + 1;
      const next = new Date(now.getTime() + (BACKOFF_MIN[attempts - 1] || 1440) * 60_000).toISOString();
      await db.run('UPDATE webhook_deliveries SET status = ?, attempts = ?, response_code = ?, last_error = ?, next_attempt_at = ? WHERE id = ?', gaveUp ? 'failed' : 'pending', attempts, code, String(error).slice(0, 300), next, d.id);
      // An endpoint that keeps failing is switched off, so it doesn't pile up work.
      await db.run('UPDATE webhook_endpoints SET failures = failures + 1 WHERE id = ?', d.endpoint_id);
      const { failures } = await db.get('SELECT failures FROM webhook_endpoints WHERE id = ?', d.endpoint_id);
      if (failures >= 50) await db.run('UPDATE webhook_endpoints SET active = 0 WHERE id = ?', d.endpoint_id);
      if (gaveUp || failures >= 50) {
        await raiseIssue(db, {
          practiceId: d.practice_id, kind: 'integration', key: `webhook:${d.endpoint_id}`, role: 'admin', entity: 'webhook_endpoints', entityId: d.endpoint_id,
          title: failures >= 50 ? `A webhook address kept failing and was switched off (${d.url.split('?')[0]})` : `A webhook couldn't be delivered to ${d.url.split('?')[0]} after every retry`,
          detail: `${d.event}: ${error}`,
        });
      }
    }
  }
  return ok;
}

// Payments come from many places (front desk, online, autopay, memberships, insurance posting is not
// included); rather than hooking each, new ledger payments are picked up here.
export async function scanPayments(db) {
  let n = 0;
  for (const e of await db.all("SELECT DISTINCT practice_id FROM webhook_endpoints WHERE active = 1 AND (events LIKE '%payment.created%' OR events LIKE '%*%')")) {
    const pid = e.practice_id;
    const mark = await db.get("SELECT value FROM webhook_state WHERE practice_id = ? AND key = 'last_payment_id'", pid);
    const last = mark ? Number(mark.value) : (await db.get("SELECT COALESCE(MAX(id), 0) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'payment'", pid)).n;
    // First look: start from now rather than announcing every past payment.
    const rows = mark ? await db.all("SELECT * FROM ledger_entries WHERE practice_id = ? AND type = 'payment' AND id > ? ORDER BY id LIMIT 500", pid, last) : [];
    for (const l of rows) { await emitEvent(db, pid, 'payment.created', apiPayment(l)); n++; }
    const top = rows.length ? rows.at(-1).id : last;
    if (mark) await db.run("UPDATE webhook_state SET value = ? WHERE practice_id = ? AND key = 'last_payment_id'", String(top), pid);
    else await db.run("INSERT INTO webhook_state (practice_id, key, value) VALUES (?, 'last_payment_id', ?)", pid, String(top));
  }
  return n;
}

export function startWebhooks(db, fetchImpl) {
  deliverer = (ids) => deliverWebhooks(db, { ids, fetchImpl });
}

// Called when an endpoint is added: payments from here on are announced, not the history.
export async function markPayments(db, practiceId) {
  if (await db.get("SELECT id FROM webhook_state WHERE practice_id = ? AND key = 'last_payment_id'", practiceId)) return;
  const { n } = await db.get("SELECT COALESCE(MAX(id), 0) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'payment'", practiceId);
  await db.run("INSERT INTO webhook_state (practice_id, key, value) VALUES (?, 'last_payment_id', ?)", practiceId, String(n));
}

// One-liners for routes: announce an appointment or patient after it changed.
export async function emitAppointment(db, id, type = null) {
  const a = await db.get('SELECT * FROM appointments WHERE id = ?', id);
  if (a) await emitEvent(db, a.practice_id, type || (a.status === 'cancelled' ? 'appointment.cancelled' : 'appointment.updated'), apiAppointment(a));
}
export async function emitPatient(db, id, type) {
  const p = await db.get('SELECT * FROM patients WHERE id = ?', id);
  if (p) await emitEvent(db, p.practice_id, type, apiPatient(p));
}
