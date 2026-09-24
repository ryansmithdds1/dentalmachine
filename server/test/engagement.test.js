import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOURS } from '../src/hours.js';
import { buildDicom } from '../src/dicom.js';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { runReminders } from '../src/messaging.js';
import { totp, timeStep } from '../src/totp.js';
import { localNow } from '../src/util.js';

const db = await openDb(':memory:');
after(() => db.close());
const uploadDir = mkdtempSync(join(tmpdir(), 'dm-uploads-'));
const sent = [];
const messenger = {
  status: { sms: 'test', email: 'test' },
  send: async (m) => {
    if (m.to === 'fail@example.com') throw new Error('mailbox unavailable');
    sent.push(m);
    return { provider_id: `test-${sent.length}` };
  },
};
const stripeCalls = [];
const terminalState = { paid: false };
const fakeFetch = async (url, init) => {
  stripeCalls.push({ url, method: init.method, body: Object.fromEntries(new URLSearchParams(init.body)) });
  const path = new URL(url).pathname.replace('/v1/', '');
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  if (path === 'terminal/locations') return json({ id: 'tml_1' });
  if (path === 'terminal/readers' && init.method === 'POST') return json({ id: 'tmr_1', label: 'Desk', device_type: 'bbpos_wisepos_e', serial_number: 'WSC-1' });
  if (path === 'payment_intents' && init.method === 'POST') return json({ id: `pi_term_${stripeCalls.length}`, status: 'requires_payment_method' });
  if (path.startsWith('payment_intents/pi_term_') && init.method === 'GET') {
    return json(terminalState.paid ? { id: path.split('/')[1], status: 'succeeded', latest_charge: { payment_method_details: { card_present: { brand: 'mastercard', last4: '4444' } } } } : { id: path.split('/')[1], status: 'requires_payment_method' });
  }
  if (path === 'terminal/readers/tmr_1' && init.method === 'GET') return json({ id: 'tmr_1', status: 'online', action: { status: 'in_progress' } });
  return new Response(JSON.stringify({ id: `cs_test_${stripeCalls.length}`, url: `https://checkout.stripe.test/${stripeCalls.length}` }), { status: 200 });
};
const config = {
  appUrl: 'https://app.example.com', uploadDir, documentKey: 'test-document-key',
  stripeSecretKey: 'sk_test_x', stripeWebhookSecret: 'whsec_test',
};

let server;
let origin;
before(async () => {
  const app = createApp({ db, secret: 'test-secret', config, fetchImpl: fakeFetch, messenger });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

function client(token) {
  const call = async (method, path, body, headers = {}) => {
    const isRaw = body instanceof Uint8Array || typeof body === 'string';
    const res = await fetch(`${origin}/api${path}`, {
      method,
      headers: { ...(isRaw ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b, h) => call('POST', p, b ?? {}, h),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
  };
}

let n = 0;
async function setup() {
  n++;
  const reg = await client().post('/auth/register', { practice_name: `Eng ${n}`, name: 'Admin', email: `eng${n}@example.com`, password: 'correct-horse-battery' });
  assert.equal(reg.status, 201);
  const api = client(reg.data.token);
  await api.put('/practice', { send_from: '00:00', send_until: '00:00', office_hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['00:00', '23:59']]])) }); // tests book at any hour
  const provider = (await api.post('/providers', { name: 'Dr. Who', type: 'dentist' })).data;
  const patient = (await api.post('/patients', { first_name: 'Pat', last_name: 'Smith', phone: '(512) 555-0100', email: 'pat@example.com' })).data;
  return { api, provider, patient, email: `eng${n}@example.com` };
}

const nextWeekday = () => {
  for (let i = 1; ; i++) {
    const day = localNow('America/New_York', new Date(Date.now() + i * 86400_000)).slice(0, 10);
    if (![0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) return day;
  }
};

const tomorrow = () => {
  const d = new Date(Date.now() + 86400_000);
  return localNow('America/New_York', d).slice(0, 10);
};

test('reminder job texts unconfirmed appointments once, and the link confirms', async () => {
  const { api, provider, patient } = await setup();
  const day = tomorrow();
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 23:00`, end_time: `${day} 23:30` })).data;
  const before = sent.length;
  await runReminders(db, messenger, { appUrl: config.appUrl });
  const mine = sent.slice(before).filter((m) => m.body.includes('Pat'));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].channel, 'sms');
  assert.equal(mine[0].to, '(512) 555-0100');
  await runReminders(db, messenger, { appUrl: config.appUrl });
  assert.equal(sent.slice(before).filter((m) => m.body.includes('Pat')).length, 1, 'not reminded twice');

  const token = mine[0].body.match(/\/c\/([\w-]+)/)[1];
  const pub = client();
  const view = await pub.get(`/public/confirm/${token}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.first_name, 'Pat');
  assert.equal(view.data.last_name, undefined, 'public view is minimal');
  const confirmed = await pub.post(`/public/confirm/${token}`, { action: 'confirm' });
  assert.equal(confirmed.data.status, 'confirmed');
  assert.equal((await api.get(`/appointments/${appt.id}`)).data.status, 'confirmed');
  assert.equal((await pub.get('/public/confirm/not-a-real-token')).status, 404);

  const log = (await api.get(`/messages?patient_id=${patient.id}`)).data;
  assert.equal(log[0].kind, 'reminder');
  assert.equal(log[0].status, 'sent');
});

test('patients can cancel from the link; opted-out patients are skipped', async () => {
  const { api, provider, patient } = await setup();
  const day = tomorrow();
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 22:00`, end_time: `${day} 22:30` })).data;
  const msg = (await api.post(`/appointments/${appt.id}/remind`, { channel: 'email' })).data;
  assert.equal(msg.channel, 'email');
  const token = msg.body.match(/\/c\/([\w-]+)/)[1];
  assert.equal((await client().post(`/public/confirm/${token}`, { action: 'cancel' })).data.status, 'cancelled');

  await api.put(`/patients/${patient.id}`, { sms_opt_in: false, email_opt_in: false });
  const appt2 = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 21:00`, end_time: `${day} 21:30` })).data;
  assert.equal((await api.post(`/appointments/${appt2.id}/remind`)).status, 400);
});

test('failed deliveries are recorded, not thrown', async () => {
  const { api, patient } = await setup();
  await api.put(`/patients/${patient.id}`, { email: 'fail@example.com' });
  const msg = await api.post(`/patients/${patient.id}/messages`, { channel: 'email', body: 'Hello' });
  assert.equal(msg.status, 201);
  assert.equal(msg.data.status, 'failed');
  assert.match(msg.data.error, /mailbox/);
});

test('online booking: public request → front desk accepts → patient + appointment created', async () => {
  const { api, provider } = await setup();
  await api.put('/practice', { office_hours: DEFAULT_HOURS }); // slots come from real office hours
  const pub = client();
  assert.equal((await pub.get('/public/practices/eng-booking')).status, 404);
  assert.equal((await api.put('/practice', { online_booking: true })).status, 400, 'needs a slug first');
  assert.equal((await api.put('/practice', { slug: 'Bad Slug!' })).status, 400);
  await api.put('/practice', { slug: `eng-booking`, online_booking: true });

  const info = (await pub.get('/public/practices/eng-booking')).data;
  assert.equal(info.providers[0].name, 'Dr. Who');
  assert.equal(info.providers[0].npi, undefined);
  const day = nextWeekday();
  const avail = (await pub.get(`/public/practices/eng-booking/availability?date=${day}&reason=${encodeURIComponent('Checkup & cleaning')}`)).data;
  const slot = avail.slots.find((s) => s.start.endsWith('10:00'));
  assert.ok(slot);
  let weekend = day;
  while (![0, 6].includes(new Date(`${weekend}T12:00:00Z`).getUTCDay())) weekend = localNow('UTC', new Date(Date.parse(`${weekend}T12:00:00Z`) + 86400_000)).slice(0, 10);
  assert.equal((await pub.get(`/public/practices/eng-booking/availability?date=${weekend}`)).data.slots.length, 0, 'closed weekends');

  assert.equal((await pub.post('/public/practices/eng-booking/booking-requests', { first_name: 'New', last_name: 'Person', start: slot.start, provider_id: provider.id })).status, 400, 'needs contact');
  const reqd = await pub.post('/public/practices/eng-booking/booking-requests', {
    first_name: 'New', last_name: 'Person', phone: '512-555-0199', dob: '1990-02-03', reason: 'Checkup & cleaning', start: slot.start, provider_id: provider.id,
    referral_source: 'Friend or family',
  });
  assert.equal(reqd.status, 201);
  const bot = await pub.post('/public/practices/eng-booking/booking-requests', { website: 'spam', first_name: 'x' });
  assert.equal(bot.status, 201);

  const queue = (await api.get('/booking-requests')).data;
  assert.equal(queue.length, 1, 'honeypot submission was dropped');
  const before = sent.length;
  const accepted = (await api.post(`/booking-requests/${queue[0].id}/accept`)).data;
  assert.ok(accepted.appointment_id);
  assert.match(sent.slice(before)[0].body, /you're booked/);
  const appt = (await api.get(`/appointments/${accepted.appointment_id}`)).data;
  assert.equal(appt.first_name, 'New');
  assert.equal(appt.start_time, slot.start);
  assert.equal(queue[0].referral_source, 'Friend or family');
  assert.equal((await api.get(`/patients/${appt.patient_id}`)).data.referral_source, 'Friend or family', 'how they heard about us goes on the new chart');
  assert.equal((await api.post(`/booking-requests/${queue[0].id}/accept`)).status, 409);

  // The slot is now gone from public availability.
  const after = (await pub.get(`/public/practices/eng-booking/availability?date=${day}&reason=${encodeURIComponent('Checkup & cleaning')}`)).data;
  assert.ok(!after.slots.some((s) => s.start === slot.start && s.provider_id === provider.id));
});

test('intake form link updates the medical history with an e-signature', async () => {
  const { api, patient } = await setup();
  await api.put(`/patients/${patient.id}`, { allergies: 'Latex' });
  const created = (await api.post(`/patients/${patient.id}/form-requests`, { send: 'sms' })).data;
  assert.match(created.url, /^https:\/\/app\.example\.com\/f\//);
  assert.equal(created.message.kind, 'intake_form');
  const token = created.url.split('/f/')[1];
  const pub = client();
  const form = (await pub.get(`/public/forms/${token}`)).data;
  assert.equal(form.first_name, 'Pat');
  assert.ok(form.conditions.includes('Diabetes'));

  assert.equal((await pub.post(`/public/forms/${token}`, { answers: { consent_hipaa: true }, signature_name: 'Pat Smith' })).status, 400);
  const ok = await pub.post(`/public/forms/${token}`, {
    answers: {
      conditions: ['Diabetes', 'Not a real condition'], allergies: 'Penicillin', medications: 'Metformin', premedication: true,
      address: '1 New St', consent_hipaa: true, consent_treatment: true, referral_source: 'Google search',
    },
    signature_name: 'Pat Smith',
  });
  assert.equal(ok.status, 201);
  assert.equal((await pub.get(`/public/forms/${token}`)).status, 410, 'single use');

  // Contact details apply at once; medical changes wait for a clinician, merged with what's on the chart.
  let p = (await api.get(`/patients/${patient.id}`)).data;
  assert.equal(p.address, '1 New St');
  assert.equal(p.referral_source, 'Google search', 'fills in a blank referral source');
  assert.equal(p.allergies, 'Latex', 'staff-entered allergy untouched until review');
  assert.equal(p.history_review_pending, true);
  const review = (await api.get(`/patients/${patient.id}/history-review`)).data;
  assert.deepEqual(review.changes.allergies, { current: 'Latex', reported: 'Penicillin', proposed: 'Latex, Penicillin' });
  assert.equal(review.changes.medical_alerts.proposed, 'Diabetes, Requires antibiotic premedication');
  const done = await api.post(`/patient-forms/${review.form_id}/review`, { medical_alerts: review.changes.medical_alerts.proposed, allergies: review.changes.allergies.proposed, medications: 'Metformin' });
  assert.equal(done.status, 200);
  p = (await api.get(`/patients/${patient.id}`)).data;
  assert.equal(p.medical_alerts, 'Diabetes, Requires antibiotic premedication');
  assert.equal(p.allergies, 'Latex, Penicillin');
  assert.equal(p.history_review_pending, false);
  assert.ok(p.medical_reviewed_at);
  assert.equal((await api.post(`/patient-forms/${review.form_id}/review`, {})).status, 409);
  const forms = (await api.get(`/patients/${patient.id}/forms`)).data;
  assert.equal(forms.submissions[0].signature_name, 'Pat Smith');
  assert.deepEqual(forms.submissions[0].data.conditions, ['Diabetes']);
  assert.equal(forms.requests[0].status, 'completed');
});

test('documents are stored encrypted, served back intact, and practice-scoped', async () => {
  const { api, patient } = await setup();
  const other = await setup();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('fake image body '.repeat(100))]);
  const up = await api.post(`/patients/${patient.id}/documents?category=xray&tooth=19&filename=bitewing.png`, new Uint8Array(png), { 'Content-Type': 'image/png' });
  assert.equal(up.status, 201);
  assert.equal(up.data.category, 'xray');

  const practiceDir = join(uploadDir, readdirSync(uploadDir).find((d) => readdirSync(join(uploadDir, d)).length));
  const onDisk = readFileSync(join(practiceDir, readdirSync(practiceDir)[0]));
  assert.ok(!onDisk.includes(Buffer.from('fake image body')), 'encrypted at rest');

  const file = await api.get(`/documents/${up.data.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.compare(file.data, png) === 0);
  assert.equal((await other.api.get(`/documents/${up.data.id}/file`)).status, 404);

  const bad = await api.post(`/patients/${patient.id}/documents?filename=x.html`, '<script>alert(1)</script>', { 'Content-Type': 'text/html' });
  assert.equal(bad.status, 415);
  // The type comes from the contents: a DICOM file from a browser (sent as octet-stream) is accepted,
  // and HTML that claims to be a PNG is not.
  const dcm = await api.post(`/patients/${patient.id}/documents?category=xray&filename=pa.dcm`, new Uint8Array(buildDicom({ patientId: String(patient.id), studyDate: '20260101', modality: 'IO' })), { 'Content-Type': 'application/octet-stream' });
  assert.equal(dcm.status, 201, JSON.stringify(dcm.data));
  assert.equal(dcm.data.mime, 'application/dicom');
  assert.equal((await api.post(`/patients/${patient.id}/documents?filename=x.png`, '<html>hi</html>', { 'Content-Type': 'image/png' })).status, 415);
  assert.equal((await api.get(`/patients/${patient.id}/documents`)).data.length, 2);
  await api.del(`/documents/${up.data.id}`);
  assert.equal((await api.get(`/patients/${patient.id}/documents`)).data.length, 1);
});

test('text-to-pay: Stripe checkout link, then signed webhook posts the payment once', async () => {
  const { api, provider, patient } = await setup();
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D0150', provider_id: provider.id, complete: true });
  const reqd = (await api.post(`/patients/${patient.id}/payment-requests`, { send: 'sms' })).data;
  assert.equal(reqd.amount, 11000, 'defaults to the balance');
  assert.equal(reqd.url, `https://checkout.stripe.test/${stripeCalls.length}`);
  assert.equal(stripeCalls.at(-1).body['line_items[0][price_data][unit_amount]'], '11000');
  assert.match(reqd.message.body, /checkout\.stripe\.test/);

  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: reqd.session_id, payment_status: 'paid', amount_total: 11000, payment_intent: 'pi_123' } } });
  const post = (body, sig) => fetch(`${origin}/api/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body });
  const t = Math.floor(Date.now() / 1000);
  const sign = (body) => `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')}`;
  assert.equal((await post(event, `t=${t},v1=deadbeef`)).status, 400);
  assert.equal((await post(event, sign(event))).status, 200);
  assert.equal((await post(event, sign(event))).status, 200, 'retries are acknowledged');
  assert.equal(sent.filter((m) => /receipt/i.test(m.subject || '')).length, 1, 'one emailed receipt, not one per delivery');

  const ledger = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.equal(ledger.balance, 0);
  assert.equal(ledger.entries.filter((e) => e.type === 'payment').length, 1, 'applied exactly once');
  assert.equal((await api.get(`/patients/${patient.id}/payment-requests`)).data[0].status, 'paid');
});

test('text-to-pay asks for the patient portion, not what insurance is still expected to pay', async () => {
  const { api, provider, patient } = await setup();
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W1', annual_max: 150000, deductible: 0, pct_basic: 80 })).data;
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id, complete: true })).data;
  assert.equal((await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] })).status, 201);
  const ledger = (await api.get(`/patients/${patient.id}/ledger`)).data;
  assert.ok(ledger.pending_insurance > 0 && ledger.patient_portion < ledger.balance);
  const reqd = (await api.post(`/patients/${patient.id}/payment-requests`, {})).data;
  assert.equal(reqd.amount, ledger.patient_portion);
  // Staff can still ask for more.
  assert.equal((await api.post(`/patients/${patient.id}/payment-requests`, { amount: ledger.balance })).data.amount, ledger.balance);
});

test('card readers with Stripe Terminal: a location, the reader, a card-present PaymentIntent sent to the reader', async () => {
  const { api, patient } = await setup();
  const reader = (await api.post('/terminal/readers', { registration_code: 'quick-brown-fox', label: 'Desk' })).data;
  assert.equal(reader.reader_id, 'tmr_1');
  const reg = stripeCalls.slice(-2);
  assert.match(reg[0].url, /terminal\/locations$/);
  assert.deepEqual([reg[1].body.registration_code, reg[1].body.location], ['quick-brown-fox', 'tml_1']);
  const started = (await api.post(`/patients/${patient.id}/terminal-payments`, { reader_id: reader.id, amount: 7500 })).data;
  const [pi, processCall] = stripeCalls.slice(-2);
  assert.deepEqual([pi.body.amount, pi.body['payment_method_types[]'], pi.body['metadata[terminal_payment_id]']], ['7500', 'card_present', String(started.id)]);
  assert.match(processCall.url, /terminal\/readers\/tmr_1\/process_payment_intent$/);
  assert.equal((await api.get(`/terminal-payments/${started.id}`)).data.status, 'pending');
  terminalState.paid = true;
  const done = (await api.get(`/terminal-payments/${started.id}`)).data;
  assert.deepEqual([done.status, done.card_brand, done.card_last4], ['succeeded', 'mastercard', '4444']);
  const pay = (await api.get(`/patients/${patient.id}/ledger`)).data.entries.find((e) => e.type === 'payment');
  assert.equal(pay.amount, -7500);
  assert.match(pay.reference, /^pi_term_/);
  terminalState.paid = false;
});

test('two-factor authentication: enrol, required at login, replay blocked, enforceable per practice', async () => {
  const first = await setup();
  const { email } = first;
  let { api } = first;
  const setupRes = (await api.post('/auth/mfa/setup')).data;
  assert.match(setupRes.otpauth_url, /^otpauth:\/\/totp\//);
  assert.equal((await api.post('/auth/mfa/enable', { code: '000000' })).status, 400);
  // Use the previous step so the login below (current step) isn't treated as a replay.
  const enabled = await api.post('/auth/mfa/enable', { code: totp(setupRes.secret, timeStep() - 1) });
  assert.equal(enabled.status, 200);
  // Turning 2FA on ends the sessions from before; this device carries on with the fresh one.
  assert.equal((await api.get('/auth/me')).status, 401);
  api = client(enabled.data.token);

  const noCode = await client().post('/auth/login', { email, password: 'correct-horse-battery' });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.data.details.mfa_required, true);
  const code = totp(setupRes.secret);
  const ok = await client().post('/auth/login', { email, password: 'correct-horse-battery', mfa_code: code });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.mfa_enabled, true);
  assert.equal((await client().post('/auth/login', { email, password: 'correct-horse-battery', mfa_code: code })).status, 401, 'code cannot be reused');

  // Practice-wide requirement locks out staff without 2FA until they enrol.
  await api.put('/practice', { require_mfa: true });
  await api.post('/users', { email: `staff-${email}`, name: 'Staff', role: 'front_desk', password: 'front-desk-password' });
  const staff = await client().post('/auth/login', { email: `staff-${email}`, password: 'front-desk-password' });
  assert.equal(staff.data.user.mfa_setup_required, true);
  const staffApi = client(staff.data.token);
  assert.equal((await staffApi.get('/patients')).status, 403);
  assert.equal((await staffApi.post('/auth/mfa/setup')).status, 200);
});

test('day sheet summarises production and the deposit by payment method', async () => {
  const { api, provider, patient } = await setup();
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: provider.id, complete: true });
  await api.post(`/patients/${patient.id}/payments`, { amount: 5000, method: 'cash' });
  await api.post(`/patients/${patient.id}/payments`, { amount: 2000, method: 'credit_card' });
  await api.post(`/patients/${patient.id}/payments`, { amount: 1000, method: 'credit_card' });
  const sheet = (await api.get('/reports/daysheet')).data;
  assert.equal(sheet.totals.production, 11000);
  assert.equal(sheet.totals.patient_payments, 8000);
  assert.deepEqual(sheet.deposit, { cash: 5000, credit_card: 3000 });
});
