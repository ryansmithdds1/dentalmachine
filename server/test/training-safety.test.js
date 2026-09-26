// The training patient never leaves the building (training.js). Each outbound boundary is tried with "Tess
// Training" and must refuse — texts, email, calls, review requests, claims, pre-authorizations, claim status,
// eligibility, attachments, card charges, refunds and card readers, e-prescriptions, PDMP, lab and imaging-bridge
// orders, mailed letters, webhooks, the cancellation-fill texts and any outside call carrying its mark — while the
// same thing for a real patient still goes. Then: its details stay pretend, its family is pretend, it never merges
// with a real chart, reset puts it back without touching anything real, and the lists that feed automatic messages
// and money (reminders, recall, campaigns, statements, eligibility batches, autopay) leave it out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { loggedFetch } from '../src/issues.js';
import { guardAdapter, TrainingBlocked, carriesTraining, pretendPhone, pretendEmail } from '../src/training.js';
import { trackedCharge } from '../src/billingauto.js';
import { mailable } from '../src/mail.js';
import { runReminders } from '../src/messaging.js';
import { emitEvent } from '../src/webhooks.js';
import { openSlot } from '../src/fill.js';
import { withActor } from '../src/actor.js';

// A clearinghouse that only records: anything reaching it is a failure for the training patient.
const reached = { batch: [], eligibility: [], status: [] };
const clearinghouse = {
  mode: 'sandbox', name: 'Test clearinghouse',
  batch: { transport: 'test', submit: async (f) => { reached.batch.push(f); return { reference: f.filename }; }, fetch: async () => [], done: async () => {} },
  realtime: { eligibility: async (x) => { reached.eligibility.push(x); throw new Error('not in this test'); }, claimStatus: async (x) => { reached.status.push(x); throw new Error('not in this test'); } },
};
const h = harness({ clearinghouse, config: { payments: 'sandbox' } });

async function setup() {
  const p = await h.practice();
  const tess = (await p.api.post('/training/patient')).data;
  return { ...p, tess };
}
const sentTo = (to) => h.sent.filter((m) => String(m.to).replace(/\D/g, '').endsWith(String(to).replace(/\D/g, '').slice(-10)));

test('the training patient: made once per practice on first use, pretend details, a clean starting chart', async () => {
  const { api, tess, practiceId } = await setup();
  assert.equal(tess.first_name, 'Tess');
  assert.equal((await api.post('/training/patient')).status, 200, 'the second ask finds the same one');
  assert.equal((await api.post('/training/patient')).data.id, tess.id);
  const row = await h.db.get('SELECT * FROM patients WHERE id = ?', tess.id);
  assert.equal(row.is_training, 1);
  assert.ok(pretendPhone(row.phone) && pretendEmail(row.email), 'contact details are pretend');
  assert.ok((await h.db.get('SELECT COUNT(*) AS n FROM patient_insurance WHERE patient_id = ?', tess.id)).n >= 1, 'insured');
  assert.ok((await h.db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE patient_id = ?', tess.id)).n > 0, 'a balance to practise taking payments on');
  assert.ok(await h.db.get("SELECT id FROM recalls WHERE patient_id = ? AND status = 'due'", tess.id), 'a cleaning due');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE action = 'training.patient.create' AND entity_id = ?", String(tess.id)) || await h.db.get("SELECT id FROM audit_log WHERE action = 'training.patient.create'"), 'audited');
  // Another practice gets its own; neither sees the other's.
  const other = await setup();
  assert.notEqual(other.tess.id, tess.id);
  assert.equal((await other.api.get(`/patients/${tess.id}`)).status, 404);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM patients WHERE practice_id = ? AND is_training = 1', practiceId ?? row.practice_id)).n, 1);
});

test('texts, email, calls, review requests and reminders to the training patient never go out', async () => {
  const { api, tess, patient, provider } = await setup();
  const before = h.sent.length;
  const text = await api.post(`/patients/${tess.id}/messages`, { channel: 'sms', body: 'Practice text' });
  assert.ok(text.status < 300, JSON.stringify(text.data));
  const row = await h.db.get("SELECT * FROM messages WHERE patient_id = ? AND body = 'Practice text'", tess.id);
  assert.equal(row.status, 'blocked');
  assert.match(row.error, /Practice mode/);
  await api.post(`/patients/${tess.id}/messages`, { channel: 'email', subject: 'Hi', body: 'Practice email' });
  assert.equal((await h.db.get("SELECT status FROM messages WHERE patient_id = ? AND body = 'Practice email'", tess.id)).status, 'blocked');
  await api.post(`/patients/${tess.id}/review-request`, { source: 'chart' });
  assert.equal(h.sent.length, before, 'nothing reached the carrier');
  assert.deepEqual(sentTo('(555) 555-0100'), []);
  // The messenger itself refuses the training patient's number, whoever calls it.
  await assert.rejects(h.app.locals.messenger.send({ channel: 'sms', to: '(555) 555-0100', body: 'x' }), TrainingBlocked);
  await assert.rejects(h.app.locals.messenger.send({ channel: 'email', to: 'tess.training@training.invalid', subject: 'x', body: 'x' }), TrainingBlocked);
  // A real patient still gets theirs.
  await api.post(`/patients/${patient.id}/messages`, { channel: 'sms', body: 'Real text' });
  assert.equal(sentTo(patient.phone).length, 1);
  // Tomorrow's reminders: the real visit is reminded, the training visit isn't.
  const tomorrow = new Date(Date.now() + 26 * 3600_000).toISOString().slice(0, 10);
  for (const [pid, t] of [[patient.id, '10:00'], [tess.id, '11:00']]) {
    assert.equal((await api.post('/appointments', { patient_id: pid, provider_id: provider.id, start_time: `${tomorrow} ${t}`, end_time: `${tomorrow} ${t.slice(0, 2)}:30`, override_blockout: true })).status, 201);
  }
  await runReminders(h.db, h.app.locals.messenger, { appUrl: h.config.appUrl, now: new Date() });
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM messages WHERE patient_id = ? AND kind IN ('reminder','confirmation')", tess.id)).n, 0, 'no reminder for the training visit');
});

test('claims, pre-authorizations, claim status and eligibility never reach the clearinghouse', async () => {
  const { api, tess } = await setup();
  // A sent claim (as the tours set it up — marked sent here, nothing sent): no status request to the payer.
  const sent = (await api.post('/training/patient/prepare', { needs: ['claim_sent'] })).data;
  assert.ok(sent.claim, 'a sent training claim');
  const status = await api.post(`/claims/${sent.claim}/status-check`);
  assert.equal(status.status, 409);
  assert.equal(status.data.details?.training, true);
  await api.post('/training/patient/prepare', { needs: ['unbilled'] });
  const policy = await h.db.get('SELECT * FROM patient_insurance WHERE patient_id = ?', tess.id);
  const procs = await h.db.all("SELECT id FROM procedures WHERE patient_id = ? AND status = 'completed' AND id NOT IN (SELECT procedure_id FROM claim_items)", tess.id);
  const claim = await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: procs.map((x) => x.id) });
  assert.equal(claim.status, 201, 'claims are made and worked on as usual');
  const send = await api.post('/claims/submit', { claim_ids: [claim.data.id] });
  assert.equal(send.status, 409);
  assert.equal(send.data.details?.training, true);
  assert.match(send.data.error, /Practice mode/);
  assert.equal((await api.post('/claims/837', { claim_ids: [claim.data.id] })).status, 409, 'nor into a file for the payer');
  assert.equal((await h.db.get('SELECT status FROM claims WHERE id = ?', claim.data.id)).status, 'draft');
  // Pre-authorization.
  await api.post('/training/patient/prepare', { needs: ['planned'] });
  const plan = await h.db.get('SELECT id FROM treatment_plans WHERE patient_id = ?', tess.id);
  const pa = await api.post('/preauths', { patient_insurance_id: policy.id, treatment_plan_id: plan.id });
  assert.ok(pa.status < 300, JSON.stringify(pa.data));
  const paSend = await api.post(`/daily/preauths/${pa.data.id}/send`);
  assert.equal(paSend.status, 409);
  assert.equal(paSend.data.details?.training, true);
  // Eligibility is answered by the built-in simulated payer, even with a real-time connection.
  const elig = await api.post(`/insurance/${policy.id}/eligibility`);
  assert.ok(elig.status < 300, JSON.stringify(elig.data));
  assert.equal(elig.data.mode, 'sandbox');
  assert.deepEqual(reached, { batch: [], eligibility: [], status: [] }, 'nothing reached the clearinghouse');
  // The adapter refuses a file carrying the training member id, whoever builds it.
  await assert.rejects(h.app.locals.clearinghouse.batch.submit({ filename: 'x.837', content: 'NM1*IL*1*TRAINING*TESS****MI*DMTRAIN0001~' }), TrainingBlocked);
  assert.deepEqual(reached.batch, []);
});

test('cards: no charge, refund, saved card or card-reader payment for the training patient', async () => {
  const { api, tess, patient } = await setup();
  const payments = h.app.locals.payments;
  await assert.rejects(payments.charge({ method: { id: 1 }, amount: 500, description: 'x', idempotencyKey: 'k1', metadata: { patient_id: tess.id } }), TrainingBlocked);
  await assert.rejects(payments.refund({ reference: 'sbx_pi_1', amount: 100, idempotencyKey: 'r1', patient_id: tess.id }), TrainingBlocked);
  const ok = await payments.charge({ method: { id: 1, last4: '4242' }, amount: 500, description: 'x', idempotencyKey: 'k2', metadata: { patient_id: patient.id } });
  assert.ok(ok, 'a real patient’s charge goes to the (sandbox) processor');
  // Automatic charges: refused before an attempt is even recorded.
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', tess.id)).practice_id;
  await assert.rejects(withActor({ source: 'automation' }, () => trackedCharge(h.db, payments, { method: { id: 1 }, amount: 500, description: 'x', idempotencyKey: 'k3' }, { practiceId: pid, patientId: tess.id, sourceType: 'recurring_charge' })), TrainingBlocked);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM billing_attempts WHERE patient_id = ?', tess.id)).n, 0);
  const reader = await api.post(`/patients/${tess.id}/terminal-payments`, { reader_id: 1, amount: 1000 });
  assert.equal(reader.status, 409);
  assert.equal(reader.data.details?.training, true);
  // Cash and checks are fine: they stay in the office (and out of every total and deposit).
  assert.equal((await api.post(`/patients/${tess.id}/payments`, { amount: 2000, method: 'cash' })).status, 201);
  const waiting = (await api.get('/deposits/undeposited')).data;
  assert.ok(!waiting.some((e) => e.patient_id === tess.id), 'never in a bank deposit');
});

test('e-prescriptions, PDMP, lab and imaging orders, mailed letters, webhooks and outside calls stop at the door', async () => {
  const { api, tess, patient, provider } = await setup();
  // e-prescribing: refused before anything is sent.
  const rx = await api.post(`/patients/${tess.id}/prescriptions`, { drug: 'Ibuprofen 600 mg', sig: '1 tab q6h prn pain', quantity: '20', provider_id: provider.id, send: true });
  assert.equal(rx.status, 409, JSON.stringify(rx.data));
  assert.equal(rx.data.details?.training, true, rx.data.error);
  // PDMP and e-Rx adapters refuse a training patient handed to them directly.
  const pdmp = guardAdapter(h.db, { query: async () => 'queried' }, 'PDMP', ['query']);
  const tessRow = await h.db.get('SELECT * FROM patients WHERE id = ?', tess.id);
  await assert.rejects(pdmp.query({ patient: tessRow }), TrainingBlocked);
  assert.equal(await pdmp.query({ patient: await h.db.get('SELECT * FROM patients WHERE id = ?', patient.id) }), 'queried');
  const erx = guardAdapter(h.db, { transmit: async () => 'sent', ssoUrl: () => 'url' }, 'e-Prescribing', ['transmit'], { sync: ['ssoUrl'] });
  await assert.rejects(erx.transmit({ patient: tessRow }), TrainingBlocked);
  assert.throws(() => erx.ssoUrl({ patient: tessRow }), TrainingBlocked);
  // Lab: the case is made, the prescription never goes to the lab.
  const lab = await api.post('/labs', { name: 'Acme Lab', email: 'lab@example.com' });
  const kase = await api.post('/lab-cases', { patient_id: tess.id, provider_id: provider.id, ...(lab.data?.id ? { lab_id: lab.data.id } : {}), description: 'Crown #14', due_date: '2031-01-10' });
  assert.ok(kase.status < 300, JSON.stringify(kase.data));
  const before = h.sent.length;
  const labSend = await api.post(`/lab-cases/${kase.data.id}/send`, { email: 'lab@example.com' });
  assert.equal(labSend.status, 409);
  assert.equal(labSend.data.details?.training, true);
  assert.equal(h.sent.length, before);
  // Imaging bridge orders.
  const agent = await api.post('/imaging/agents', { name: 'Op 1' });
  for (const kind of ['launch', 'capture']) {
    const order = await api.post(`/patients/${tess.id}/imaging/${kind}`, { agent_id: agent.data.id, app: 'dexis' });
    assert.equal(order.status, 409);
    assert.equal(order.data.details?.training, true);
  }
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM bridge_commands WHERE patient_id = ?', tess.id)).n, 0);
  // Letters: the training patient has no address a letter could go to.
  assert.equal(mailable({ ...tessRow }), false);
  assert.equal(mailable({ address: '1 Main', city: 'Austin', state: 'TX', zip: '78701' }), true);
  // Webhooks: nothing about the training patient is announced; a real patient still is.
  const pid = tessRow.practice_id;
  await h.db.run("INSERT INTO webhook_endpoints (practice_id, url, secret, events, active) VALUES (?, 'https://hooks.example.com/x', 's', '[\"*\"]', 1)", pid);
  assert.deepEqual(await emitEvent(h.db, pid, 'patient.updated', { ...tessRow }), []);
  assert.deepEqual(await emitEvent(h.db, pid, 'appointment.created', { id: 1, patient_id: tess.id }), []);
  assert.equal((await emitEvent(h.db, pid, 'patient.updated', { id: patient.id, first_name: 'Jane' })).length, 1);
  // Any outside call whose address or body carries the training mark is never made (and is logged as refused).
  let called = 0;
  const fetch = loggedFetch(h.db, async () => { called++; return new Response('{}'); });
  await assert.rejects(fetch('https://api.example.com/v1/x', { method: 'POST', body: JSON.stringify({ member: 'DMTRAIN0001' }) }), TrainingBlocked);
  await assert.rejects(fetch('https://api.example.com/v1/x', { method: 'POST', body: new URLSearchParams({ To: '5555550100', Body: 'hi DMTRAIN' }) }), TrainingBlocked);
  assert.equal(called, 0);
  assert.ok(await h.db.get("SELECT id FROM integration_log WHERE operation LIKE '%refused: training patient%'"));
  await fetch('https://api.example.com/v1/x', { method: 'POST', body: '{"member":"W123"}' });
  assert.equal(called, 1);
  assert.equal(await carriesTraining(h.db, [{ to: '(555) 555-0100' }]), true);
  assert.equal(await carriesTraining(h.db, [{ to: patient.phone, patient_id: patient.id }]), false);
});

test('a cancelled training visit is never offered to the waitlist; the training patient is never offered a real opening', async () => {
  const { api, tess, patient, provider } = await setup();
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', tess.id)).practice_id;
  await h.db.run('UPDATE practices SET auto_fill = 1 WHERE id = ?', pid);
  const day = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
  const mine = (await api.post('/appointments', { patient_id: tess.id, provider_id: provider.id, start_time: `${day} 09:00`, end_time: `${day} 09:30`, override_blockout: true })).data;
  assert.equal(await openSlot(h.db, h.app.locals.messenger, mine.id), null, 'no opening made from a training visit');
  // Tess on the waitlist: a real cancellation isn't offered to her.
  await api.post('/waitlist', { patient_id: tess.id, notes: 'practice' });
  const real = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 10:00`, end_time: `${day} 10:30`, override_blockout: true })).data;
  const offer = await openSlot(h.db, h.app.locals.messenger, real.id);
  if (offer) assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM fill_offer_recipients WHERE patient_id = ?', tess.id)).n, 0);
});

test('the lists that drive automatic messages and money leave the training patient out', async () => {
  const { api, tess, provider } = await setup();
  const today = (await api.get('/dashboard')).data.today;
  await api.post('/appointments', { patient_id: tess.id, provider_id: provider.id, start_time: `${today} 08:00`, end_time: `${today} 08:30`, override_blockout: true });
  assert.ok(!(await api.get('/recalls')).data.some((r) => r.patient_id === tess.id), 'recall list');
  assert.ok(!(await api.get('/recall-board')).data.rows.some((r) => (r.patient_id ?? r.id) === tess.id), 'recall board');
  assert.ok(!(await api.get('/statements/candidates?min_balance=1&since_days=0')).data.some((a) => a.id === tess.id), 'statements');
  assert.ok(!(await api.get(`/eligibility/batch?date=${today}`)).data.rows.some((r) => r.patient_id === tess.id), 'eligibility batch');
  const unconfirmed = (await api.get('/followups/unconfirmed')).data;
  assert.ok(!JSON.stringify(unconfirmed).includes('"Training"'), 'unconfirmed calls');
  const seg = (await api.post('/campaigns/preview', { segment: 'all_active', channel: 'auto', body: 'Hi {first_name}' })).data;
  const allActive = (await h.db.get("SELECT COUNT(*) AS n FROM patients WHERE practice_id = ? AND status = 'active' AND is_training = 0", (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', tess.id)).practice_id)).n;
  assert.equal(seg.patients, allActive, 'campaign audience');
  assert.ok(!JSON.stringify((await api.get('/huddle')).data).includes('"Training"'), 'morning huddle');
  assert.ok(!JSON.stringify((await api.get('/dashboard')).data).includes('Training'), 'dashboard');
});

test('its contact details stay pretend; its family is pretend; it never merges with a real chart', async () => {
  const { api, tess, patient } = await setup();
  assert.equal((await api.put(`/patients/${tess.id}`, { phone: '(512) 867-5309' })).status, 400, 'no real-looking number');
  assert.equal((await api.put(`/patients/${tess.id}`, { email: 'someone@gmail.com' })).status, 400, 'no real address');
  assert.equal((await api.put(`/patients/${tess.id}`, { phone: '512.555.0142' })).status, 200, 'a pretend one is fine');
  const kid = await api.post('/patients', { first_name: 'Tim', last_name: 'Training', dob: '2015-05-05', guarantor_id: tess.id, phone: '(555) 555-0101' });
  assert.equal(kid.status, 201);
  assert.equal(kid.data.is_training, 1, 'added to the pretend household: pretend too');
  assert.equal((await api.post('/patients', { first_name: 'Real', last_name: 'Kid', guarantor_id: tess.id, phone: '(512) 867-5309' })).status, 400);
  assert.equal((await api.put(`/patients/${patient.id}`, { guarantor_id: tess.id })).status, 400, 'a real patient can’t join it');
  const token = (await h.db.get("SELECT id FROM users WHERE role = 'admin' ORDER BY id DESC LIMIT 1")).id;
  assert.ok(token);
  assert.equal((await api.post(`/patients/${patient.id}/merge`, { from_id: tess.id })).status, 400);
  assert.equal((await api.post(`/patients/${tess.id}/merge`, { from_id: patient.id })).status, 400);
});

test('reset puts the training patient back to a clean chart, touches nothing real, and is audited', async () => {
  const { api, tess, patient, provider } = await setup();
  await api.post('/training/patient/prepare', { needs: ['visit_today:checked_in', 'unbilled', 'planned', 'draft_note', 'claim_sent'] });
  await api.post(`/patients/${tess.id}/payments`, { amount: 1500, method: 'cash' });
  await api.post(`/patients/${tess.id}/notes`, { body: 'practice' });
  await api.post('/tasks', { text: 'practice task', patient_id: tess.id });
  await api.put(`/patients/${tess.id}`, { office_alert: 'practice alert', phone: '(555) 555-0142' });
  const kid = (await api.post('/patients', { first_name: 'Tim', last_name: 'Training', guarantor_id: tess.id })).data;
  // Real work alongside.
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D0120', provider_id: provider.id, complete: true });
  await api.post(`/patients/${patient.id}/payments`, { amount: 700, method: 'cash' });
  const realLedger = await h.db.all('SELECT id, amount FROM ledger_entries WHERE patient_id = ? ORDER BY id', patient.id);
  const auditBefore = (await h.db.get('SELECT COUNT(*) AS n FROM audit_log WHERE patient_id = ?', tess.id)).n;
  const r = await api.post('/training/patient/reset');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.removed > 5);
  const t = await h.db.get('SELECT * FROM patients WHERE id = ?', tess.id);
  assert.equal(t.office_alert, null);
  assert.equal(t.phone, '(555) 555-0100');
  assert.equal(await h.db.get('SELECT id FROM patients WHERE id = ?', kid.id), undefined, 'the pretend family member is gone');
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM clinical_notes WHERE patient_id = ?', tess.id)).n, 0);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM claims WHERE patient_id = ?', tess.id)).n, 0);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM tasks WHERE patient_id = ?', tess.id)).n, 0);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM appointments WHERE patient_id = ? AND status != 'completed'", tess.id)).n, 0);
  assert.ok((await h.db.get("SELECT COUNT(*) AS n FROM ledger_entries WHERE patient_id = ? AND type = 'payment'", tess.id)).n === 0, 'practice payments cleared');
  assert.ok((await h.db.get('SELECT COUNT(*) AS n FROM patient_insurance WHERE patient_id = ?', tess.id)).n === 1, 'the starting chart again');
  assert.deepEqual(await h.db.all('SELECT id, amount FROM ledger_entries WHERE patient_id = ? ORDER BY id', patient.id), realLedger, 'real records untouched');
  assert.ok((await h.db.get('SELECT COUNT(*) AS n FROM audit_log WHERE patient_id = ?', tess.id)).n >= auditBefore, 'the audit trail stays');
  const entry = await h.db.get("SELECT * FROM audit_log WHERE action = 'training.patient.reset' ORDER BY id DESC LIMIT 1");
  assert.ok(entry, 'the reset is audited');
  assert.match(entry.details, /removed/);
  // Asked twice: fine (nothing left to remove but the starting chart).
  assert.equal((await api.post('/training/patient/reset')).status, 200);
});

test('patient lists show the training patient only when searched for, flagged', async () => {
  const { api, tess } = await setup();
  assert.ok(!(await api.get('/patients')).data.rows.some((p) => p.id === tess.id), 'not in the default list');
  const found = (await api.get('/patients?q=training')).data.rows.find((p) => p.id === tess.id);
  assert.equal(found?.is_training, 1);
  const s = (await api.get('/search?q=tess training')).data.patients.find((p) => p.id === tess.id);
  assert.equal(s?.is_training, 1);
  assert.equal((await api.get(`/patients/${tess.id}/card`)).data.is_training, 1);
});

test('a referral letter for the training patient is never emailed to the specialist', async () => {
  const { api, tess } = await setup();
  const kim = (await api.post('/referral-contacts', { name: 'Dr. Kim', practice_name: 'Real Endo', specialty: 'Endodontics', email: 'kim@real-endo.example.org' })).data;
  const before = h.sent.length;
  const made = await api.post(`/referral-tracker/patients/${tess.id}/referrals`, { contact_id: kim.id, reason: 'RCT #19 (practice)', send: 'email', client_key: 'training-ref-0001' });
  assert.ok(made.status < 300, JSON.stringify(made.data));
  assert.equal(h.sent.length, before, 'nothing went out');
  assert.equal(h.sent.filter((m) => /real-endo/.test(String(m.to))).length, 0);
  assert.equal(made.data.letter?.status, 'blocked');
  assert.equal(made.data.letter?.training, true);
});
