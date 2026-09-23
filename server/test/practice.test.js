import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { twilioSignature } from '../src/routes/sms.js';
import { parseX12, parse271, parse835 } from '../src/x12.js';
import { installmentDate } from '../src/routes/family.js';

const db = await openDb(':memory:');
after(() => db.close());
const uploadDir = mkdtempSync(join(tmpdir(), 'dm-practice-'));
const config = { appUrl: 'https://app.example.com', uploadDir, twilioAuthToken: 'twilio-secret', ediMode: 'sandbox' };
const messenger = { status: { sms: 'test', email: 'test' }, send: async () => ({ provider_id: 'test' }) };
let server;
let origin;
before(async () => {
  const app = createApp({ db, secret: 'test-secret', config, messenger });
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
    const raw = typeof body === 'string';
    const res = await fetch(`${origin}/api${path}`, {
      method,
      headers: { ...(raw ? { 'Content-Type': 'text/plain' } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch { /* plain text */ }
    return { status: res.status, data, headers: res.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b ?? {}, h), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function setup() {
  n++;
  const reg = await client().post('/auth/register', { practice_name: `Practice ${n}`, name: 'Admin', email: `p${n}@example.com`, password: 'correct-horse-battery' });
  const api = client(reg.data.token);
  await api.put('/practice', { npi: '1234567893', tax_id: '74-1234567', address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' });
  const provider = (await api.post('/providers', { name: 'Dr. Ann Lee, DDS', type: 'dentist', npi: '1987654321' })).data;
  const patient = (await api.post('/patients', { first_name: 'Jane', last_name: 'Doe', dob: '1985-04-12', phone: '(512) 555-0100', address: '9 Elm', city: 'Austin', state: 'TX', zip: '78704', gender: 'female' })).data;
  return { api, provider, patient };
}
const WED = '2030-03-06';
const SAT = '2030-03-09';

test('office hours, blockouts and appointment types drive the schedule', async () => {
  const { api, provider, patient } = await setup();
  const types = (await api.get('/appointment-types')).data;
  const recall = types.find((t) => t.name === 'Recall exam & cleaning');
  assert.equal(recall.duration, 60);

  // Type fills in the end time and pre-loads its procedures, so scheduled production is known.
  const appt = await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, appointment_type_id: recall.id, start_time: `${WED} 09:00` });
  assert.equal(appt.status, 201);
  assert.equal(appt.data.end_time, `${WED} 10:00`);
  assert.equal(appt.data.production, 6500 + 11000 + 7000);
  assert.match(appt.data.procedure_summary, /D1110/);

  // Lunch blockout every Wednesday for 2 weeks.
  const blocks = (await api.post('/blockouts', { start_time: `${WED} 12:00`, end_time: `${WED} 13:00`, reason: 'Lunch', repeat_weeks: 2 })).data;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].start_time, '2030-03-13 12:00');
  const other = (await api.post('/patients', { first_name: 'Sam', last_name: 'Roe' })).data;
  const blocked = await api.post('/appointments', { patient_id: other.id, provider_id: provider.id, start_time: `${WED} 12:30`, end_time: `${WED} 13:00` });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.details.can_override, true);
  assert.equal((await api.post('/appointments', { patient_id: other.id, provider_id: provider.id, start_time: `${WED} 12:30`, end_time: `${WED} 13:00`, override_blockout: true })).status, 201);

  // Hours: Wednesday closes at 14:00, Saturday opens 9-12.
  const hours = { 1: [['08:00', '17:00']], 2: [['08:00', '17:00']], 3: [['08:00', '14:00']], 4: [['08:00', '17:00']], 5: [['08:00', '17:00']], 6: [['09:00', '12:00']] };
  assert.equal((await api.put('/practice', { office_hours: { 3: [['09:00', '08:00']] } })).status, 400);
  await api.put('/practice', { office_hours: hours, daily_goal: 500000 });
  const slots = (await api.get(`/availability?date=${WED}&provider_id=${provider.id}&duration=60`)).data.slots;
  assert.ok(!slots.includes(`${WED} 09:00`), 'booked');
  assert.ok(!slots.includes(`${WED} 12:00`), 'lunch');
  assert.ok(!slots.includes(`${WED} 13:30`), 'after close');
  assert.ok(slots.includes(`${WED} 13:00`));
  assert.ok((await api.get(`/availability?date=${SAT}&provider_id=${provider.id}&duration=60`)).data.slots.includes(`${SAT} 09:00`));

  const sched = (await api.get(`/schedule?from=${WED}&to=2030-03-13`)).data;
  assert.equal(sched.daily_goal, 500000);
  assert.deepEqual(sched.hours[WED], [['08:00', '14:00']]);
  assert.equal(sched.production[WED], 24500);
  assert.equal(sched.blockouts.length, 2);
  assert.equal(sched.appointments.length, 2);

  // Drag-and-drop move to another provider re-homes the attached procedures.
  const p2 = (await api.post('/providers', { name: 'Hyg', type: 'hygienist' })).data;
  const moved = await api.put(`/appointments/${appt.data.id}`, { start_time: `${WED} 10:00`, end_time: `${WED} 11:00`, provider_id: p2.id });
  assert.equal(moved.status, 200);
  const procs = (await api.get(`/patients/${patient.id}/procedures?status=planned`)).data;
  assert.ok(procs.every((p) => p.provider_id === p2.id));

  // ASAP list.
  await api.put(`/appointments/${appt.data.id}`, { asap: true });
  assert.equal((await api.get('/asap')).data[0].id, appt.data.id);
});

test('live schedule events stream to other sessions', async () => {
  const { api, provider, patient } = await setup();
  const login = await client().post('/auth/login', { email: `p${n}@example.com`, password: 'correct-horse-battery' });
  const controller = new AbortController();
  const res = await fetch(`${origin}/api/events`, { headers: { Authorization: `Bearer ${login.data.token}` }, signal: controller.signal });
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const reader = res.body.getReader();
  const got = (async () => {
    let buf = '';
    for (;;) {
      const { value } = await reader.read();
      buf += new TextDecoder().decode(value);
      const m = buf.match(/data: (.+)\n\n/);
      if (m) return JSON.parse(m[1]);
    }
  })();
  await new Promise((r) => setTimeout(r, 50));
  await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${WED} 15:00`, end_time: `${WED} 15:30` });
  const event = await got;
  controller.abort();
  assert.equal(event.type, 'schedule');
  assert.deepEqual(event.dates, [WED]);
});

test('family accounts, family statements and payment plans', async () => {
  const { api, provider, patient: mom } = await setup();
  const kid = (await api.post(`/patients/${mom.id}/family`, { first_name: 'Kid', dob: '2015-01-01' })).data;
  assert.equal(kid.last_name, 'Doe');
  assert.equal(kid.guarantor_id, mom.id);
  assert.equal(kid.phone, mom.phone, 'inherits household contact info');
  const dad = (await api.post('/patients', { first_name: 'Dan', last_name: 'Doe' })).data;
  await api.post(`/patients/${kid.id}/family`, { patient_id: dad.id });

  await api.post(`/patients/${kid.id}/procedures`, { code: 'D1120', provider_id: provider.id, complete: true });
  await api.post(`/patients/${mom.id}/procedures`, { code: 'D0150', provider_id: provider.id, complete: true });
  const fam = (await api.get(`/patients/${kid.id}/family`)).data;
  assert.equal(fam.guarantor.id, mom.id);
  assert.equal(fam.members.length, 3);
  assert.equal(fam.family_balance, 8000 + 11000);
  const stmt = (await api.get(`/patients/${kid.id}/statement?family=1`)).data;
  assert.equal(stmt.patient.id, mom.id, 'addressed to the guarantor');
  assert.equal(stmt.balance, 19000);

  // Guarantor change moves the household.
  await api.post(`/patients/${dad.id}/family/guarantor`);
  assert.equal((await api.get(`/patients/${kid.id}`)).data.guarantor_id, dad.id);
  assert.equal((await api.get(`/patients/${mom.id}`)).data.guarantor_id, dad.id);

  // Payment plan: $1,000 total, $100 down, 3 monthly installments of $300.
  assert.equal((await api.post(`/patients/${kid.id}/payment-plans`, { total: 100000, down_payment: 100000, installments: 3, start_date: '2020-01-31' })).status, 400);
  const plan = (await api.post(`/patients/${kid.id}/payment-plans`, { total: 100000, down_payment: 10000, installments: 3, start_date: '2020-01-31' })).data;
  assert.equal(plan.patient_id, dad.id, 'plans belong to the guarantor');
  assert.equal(plan.installment_amount, 30000);
  assert.deepEqual(plan.schedule.map((s) => s.due_date), ['2020-01-31', '2020-02-29', '2020-03-31']);
  assert.equal(plan.past_due, 90000, 'all installments are in the past');
  await api.post(`/patients/${mom.id}/payments`, { amount: 30000, method: 'cash', payment_plan_id: plan.id });
  let plans = (await api.get('/payment-plans?overdue=true')).data;
  assert.equal(plans[0].past_due, 60000);
  assert.equal(plans[0].next_due_date, '2020-02-29');
  // The family statement shows the plan line, the balance's age, and where to pay online.
  const st2 = (await api.get(`/patients/${kid.id}/statement?family=1`)).data;
  assert.equal(st2.plans.length, 1);
  assert.deepEqual([st2.plans[0].past_due, st2.plans[0].next_due_date, st2.plans[0].remaining], [60000, '2020-02-29', 60000]);
  assert.equal(st2.aging.current + st2.aging.d31_60 + st2.aging.d61_90 + st2.aging.d90_plus, Math.max(0, st2.balance));
  assert.match(st2.pay_url, /^https:\/\/app\.example\.com\/portal\//);
  await api.post(`/patients/${dad.id}/payments`, { amount: 60000, method: 'check', payment_plan_id: plan.id });
  plans = (await api.get('/payment-plans?status=all')).data;
  assert.equal(plans[0].status, 'completed');
  assert.equal(installmentDate({ start_date: '2030-01-15', frequency: 'biweekly' }, 2), '2030-02-12');
});

test('two-way texting: signed inbound webhook, C to confirm, STOP opts out', async () => {
  const { api, provider, patient } = await setup();
  await api.put('/practice', { sms_number: '+15125559999' });
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: '2030-05-01 09:00', end_time: '2030-05-01 10:00' })).data;
  const send = (params, sig) => fetch(`${origin}/api/webhooks/twilio/sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig ?? twilioSignature('twilio-secret', 'https://app.example.com/api/webhooks/twilio/sms', params) },
    body: new URLSearchParams(params),
  });
  const base = { From: '+15125550100', To: '+15125559999', MessageSid: 'SM1' };
  assert.equal((await send({ ...base, Body: 'C' }, 'bogus')).status, 403);
  const confirm = await send({ ...base, Body: ' c ' });
  assert.match(await confirm.text(), /confirmed for Wed, May 1 at 9:00 AM/);
  assert.equal((await api.get(`/appointments/${appt.id}`)).data.status, 'confirmed');

  await send({ ...base, Body: 'Can I come in 30 minutes later?' });
  const inbox = (await api.get('/conversations')).data;
  assert.equal(inbox[0].patient_id, patient.id);
  assert.equal(inbox[0].unread, 2);
  const thread = (await api.get(`/patients/${patient.id}/conversation`)).data;
  assert.deepEqual(thread.map((m) => m.direction), ['inbound', 'outbound', 'inbound']);
  await api.post(`/patients/${patient.id}/conversation/read`);
  assert.equal((await api.get('/conversations/unread')).data.unread, 0);

  // "CANCEL" is a carrier opt-out word, but the patient usually means the appointment: the front desk gets a task.
  await send({ ...base, Body: 'Cancel' });
  assert.equal((await api.get(`/patients/${patient.id}`)).data.sms_opt_in, 0);
  const tasks = (await api.get('/tasks')).data;
  assert.ok((tasks.tasks || tasks).some((t) => t.patient_id === patient.id && /may want to cancel/.test(t.title)));
  await send({ ...base, Body: 'START' });
  await send({ ...base, Body: 'STOP' });
  assert.equal((await api.get(`/patients/${patient.id}`)).data.sms_opt_in, 0);
  await send({ ...base, Body: 'START' });
  assert.equal((await api.get(`/patients/${patient.id}`)).data.sms_opt_in, 1);
});

test('two-way texting in Spanish: "Sí" confirms and the reply is in Spanish', async () => {
  const { api, provider, patient } = await setup();
  await api.put('/practice', { sms_number: '+15125559998' });
  await api.put(`/patients/${patient.id}`, { language: 'Spanish' });
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: '2030-05-01 14:30', end_time: '2030-05-01 15:00' })).data;
  const params = { From: '+15125550100', To: '+15125559998', MessageSid: 'SM9', Body: 'Sí' };
  const res = await fetch(`${origin}/api/webhooks/twilio/sms`, {
    method: 'POST', body: new URLSearchParams(params),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature('twilio-secret', 'https://app.example.com/api/webhooks/twilio/sms', params) },
  });
  assert.match(await res.text(), /Su cita quedó confirmada para el miércoles, 1 de mayo, a las 2:30 p\. m\./);
  assert.equal((await api.get(`/appointments/${appt.id}`)).data.status, 'confirmed');
});

test('EDI: 837D export, sandbox eligibility with 271 apply, and 835 ERA auto-posting', async () => {
  const { api, provider, patient } = await setup();
  const carrier = (await api.post('/carriers', { name: 'Delta Dental', payer_id: '94276' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'W123', group_number: 'G1', annual_max: 150000, deductible: 5000, pct_basic: 70 })).data;
  const proc = (await api.post(`/patients/${patient.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: provider.id, complete: true })).data;
  const claim = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [proc.id] })).data;

  const file = await api.post('/claims/837', { claim_ids: [claim.id] });
  assert.equal(file.status, 200);
  const segs = parseX12(file.data);
  assert.equal(file.data.indexOf('~'), 105, 'ISA is fixed-width');
  assert.ok(segs.find((s) => s.id === 'CLM' && s.e[1] === `DM${claim.id}` && s.e[2] === '235'));
  assert.ok(segs.find((s) => s.id === 'SV3' && s.e[1] === 'AD:D2392'));
  assert.ok(segs.find((s) => s.id === 'TOO' && s.e[2] === '30' && s.e[3] === 'M:O'));
  assert.ok(segs.find((s) => s.id === 'NM1' && s.e[1] === 'PR' && s.e[9] === '94276'));
  const se = segs.find((s) => s.id === 'SE');
  assert.equal(Number(se.e[1]), segs.findIndex((s) => s.id === 'SE') - segs.findIndex((s) => s.id === 'ST') + 1, 'SE count is correct');
  assert.equal((await api.get(`/claims/${claim.id}`)).data.status, 'submitted');

  // Eligibility (sandbox) → apply verified benefits to the policy.
  const elig = (await api.post(`/insurance/${policy.id}/eligibility`)).data;
  assert.equal(elig.status, 'active');
  assert.equal(elig.summary.annual_max, 150000);
  assert.equal(elig.summary.coinsurance.basic, 70);
  assert.equal(elig.summary.sandbox, true);
  assert.equal((await api.post(`/eligibility/${elig.id}/apply`)).status, 200);

  // A real-world style 271 with remaining values and co-insurance as patient share.
  const r271 = 'ISA*00*          *00*          *ZZ*PAYER          *ZZ*US             *240101*1200*^*00501*000000001*0*P*:~GS*HB*P*U*20240101*1200*1*X*005010X279A1~ST*271*0001*005010X279A1~EB*1*IND*35**PPO PLUS~EB*C*IND*35***23*50~EB*C*IND*35***29*0~EB*F*IND*35***23*2000~EB*F*IND*35***29*1250.50~EB*A*IND*25^26*****0.2~EB*A*IND*36*****.5~EB*A*IND*25*****0.5******N~SE*9*0001~GE*1*1~IEA*1*000000001~';
  const s = parse271(r271);
  assert.deepEqual([s.active, s.plan_name, s.deductible, s.deductible_remaining, s.annual_max, s.max_remaining], [true, 'PPO PLUS', 5000, 0, 200000, 125050]);
  assert.deepEqual(s.coinsurance, { basic: 80, major: 50 });

  // ERA: paid $150 with $50 contractual write-off.
  const era = `ISA*00*          *00*          *ZZ*DELTA          *ZZ*PRACTICE       *240101*1200*^*00501*000000002*0*P*:~GS*HP*D*P*20240101*1200*2*X*005010X221A1~ST*835*0001~BPR*I*150*C*ACH************20240115~TRN*1*EFT998877*1~N1*PR*DELTA DENTAL~N1*PE*PRACTICE*XX*1234567893~CLP*DM${claim.id}*1*235*150*35**ABC123~CAS*CO*45*50~SVC*AD:D2392*235*150~CAS*PR*2*35~CLP*DM99999*4*100*0*100~CAS*CO*29*100~SE*12*0001~GE*1*2~IEA*1*000000002~`;
  const parsed = parse835(era);
  assert.equal(parsed.claims[0].contractual, 5000);
  const imp = await api.post('/era/import?filename=delta.835', era);
  assert.equal(imp.status, 201);
  assert.equal(imp.data.claims[0].result, 'posted');
  assert.equal(imp.data.claims[1].result, 'unmatched');
  const c = (await api.get(`/claims/${claim.id}`)).data;
  assert.equal(c.status, 'paid');
  assert.equal(c.paid_amount, 15000);
  assert.equal(c.payer_claim_number, 'ABC123');
  assert.equal((await api.get(`/patients/${patient.id}/ledger`)).data.balance, 23500 - 15000 - 5000);
  assert.equal((await api.post('/era/import', era)).status, 409, 'same ERA cannot be posted twice');
});

test('lab cases and tasks', async () => {
  const { api, patient } = await setup();
  const seat = (await api.post('/appointments', { patient_id: patient.id, provider_id: (await api.get('/providers')).data[0].id, start_time: '2030-06-03 09:00', end_time: '2030-06-03 09:30' })).data;
  const lab = (await api.post('/lab-cases', { patient_id: patient.id, lab_name: 'Glidewell', description: 'Zirconia crown', tooth: '30', shade: 'A2', due_date: '2030-06-05', appointment_id: seat.id })).data;
  assert.equal(lab.status, 'sent');
  let open = (await api.get('/lab-cases?open=true')).data;
  assert.equal(open[0].at_risk, true, 'seat appointment is before the lab due date');
  await api.put(`/lab-cases/${lab.id}`, { status: 'received' });
  open = (await api.get(`/lab-cases?patient_id=${patient.id}`)).data;
  assert.ok(open[0].received_date);
  assert.equal((await api.get(`/patients/${patient.id}`)).data.open_lab_cases.length, 1);

  const task = (await api.post('/tasks', { title: 'Call Jane re: crown', patient_id: patient.id, priority: 'high' })).data;
  assert.equal((await api.get('/tasks?mine=true')).data[0].id, task.id);
  await api.put(`/tasks/${task.id}`, { status: 'done' });
  assert.equal((await api.get('/tasks')).data.length, 0);
});
