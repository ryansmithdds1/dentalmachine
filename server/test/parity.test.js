import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { parseX12 } from '../src/x12.js';
import { runReviewRequests } from '../src/messaging.js';
import { localNow } from '../src/util.js';

const db = await openDb(':memory:');
after(() => db.close());
const uploadDir = mkdtempSync(join(tmpdir(), 'dm-parity-'));
const sent = [];
const messenger = { status: { sms: 'test', email: 'test' }, send: async (m) => { sent.push(m); return { provider_id: 'test' }; } };
const config = { appUrl: 'https://app.example.com', uploadDir, ediMode: 'sandbox' };
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
  const call = async (method, path, body) => {
    const res = await fetch(`${origin}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch { /* text */ }
    return { status: res.status, data };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b) };
}

let n = 0;
async function setup() {
  n++;
  const reg = await client().post('/auth/register', { practice_name: `Parity ${n}`, name: 'Admin', email: `par${n}@example.com`, password: 'correct-horse-battery' });
  const api = client(reg.data.token);
  await api.put('/practice', { npi: '1234567893', tax_id: '74-1234567', address: '1 Main', city: 'Austin', state: 'TX', zip: '78701', phone: '512-555-0000' });
  const dentist = (await api.post('/providers', { name: 'Dr. Ann Lee', type: 'dentist', npi: '1987654321' })).data;
  const hygienist = (await api.post('/providers', { name: 'Sam RDH', type: 'hygienist' })).data;
  const patient = (await api.post('/patients', { first_name: 'Jane', last_name: 'Doe', dob: '1985-04-12', phone: '5125550100', email: 'jane@example.com', allergies: 'Penicillin', referral_source: 'Google' })).data;
  return { api, dentist, hygienist, patient };
}
const today = () => localNow('America/New_York').slice(0, 10);

test('PPO fee schedules drive allowed amounts, write-offs and claim estimates', async () => {
  const { api, dentist, patient } = await setup();
  const carrier = (await api.post('/carriers', { name: 'Delta PPO', payer_id: '94276' })).data;
  const fs = (await api.post('/fee-schedules', { name: 'Delta PPO 2026', percent_of_ucr: 80 })).data;
  assert.equal(fs.items.find((i) => i.code === 'D2392').fee, 18800);
  await api.put(`/fee-schedules/${fs.id}`, { items: [{ code: 'D2392', fee: 15000 }], carrier_ids: [carrier.id] });
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'X1', deductible: 0, pct_basic: 80 })).data;
  const plan = (await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Fillings', procedures: [{ code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: dentist.id }] })).data;
  const item = plan.estimate.items[0];
  assert.deepEqual([item.fee, item.allowed, item.write_off, item.insurance, item.patient], [23500, 15000, 8500, 12000, 3000]);
  assert.equal(plan.estimate.total_write_off, 8500);
  await api.post(`/procedures/${plan.procedures[0].id}/complete`);
  const claim = (await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: [plan.procedures[0].id] })).data;
  assert.equal(claim.estimated_amount, 12000);
  assert.equal((await db.get('SELECT write_off_estimate FROM claims WHERE id = ?', claim.id)).write_off_estimate, 8500);
});

test('pre-authorizations: create from a plan, export as 837 predetermination, record approval', async () => {
  const { api, dentist, patient } = await setup();
  const carrier = (await api.post('/carriers', { name: 'MetLife', payer_id: '65978' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'M1' })).data;
  const plan = (await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Crown', procedures: [{ code: 'D2740', tooth: '3', provider_id: dentist.id }] })).data;
  const pa = (await api.post('/preauths', { patient_insurance_id: policy.id, treatment_plan_id: plan.id })).data;
  assert.equal(pa.procedures[0].code, 'D2740');
  const file = await api.post(`/preauths/${pa.id}/837`);
  const clm = parseX12(file.data).find((s) => s.id === 'CLM');
  assert.equal(clm.e[1], `PD${pa.id}`);
  assert.equal(clm.e[19], 'PB');
  assert.ok(!parseX12(file.data).some((s) => s.id === 'DTP' && s.e[1] === '472'), 'no service dates on a predetermination');
  const approved = (await api.put(`/preauths/${pa.id}`, { status: 'approved', approved_amount: 67500, payer_reference: 'PA-9' })).data;
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approved_amount, 67500);
  assert.equal((await api.get(`/preauths?patient_id=${patient.id}`)).data.length, 1);
});

test('morning huddle flags, route slip and follow-up lists', async () => {
  const { api, dentist, hygienist, patient } = await setup();
  // Tomorrow's huddle, so the test doesn't depend on the time of day.
  const d = new Date(Date.parse(`${today()}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Tx', procedures: [{ code: 'D2392', tooth: '19', surfaces: 'MO', provider_id: dentist.id }] });
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D0150', provider_id: dentist.id, complete: true });
  await api.put(`/patients/${patient.id}`, { office_alert: 'Prefers morning appointments' });
  const appt = (await api.post('/appointments', { patient_id: patient.id, provider_id: hygienist.id, start_time: `${d} 23:00`, end_time: `${d} 23:50` })).data;
  const h = (await api.get(`/huddle?date=${d}`)).data;
  const row = h.rows.find((x) => x.id === appt.id);
  for (const f of ['unconfirmed', 'unscheduled_treatment', 'balance_due', 'update_medical_history']) assert.ok(row.flags.includes(f), f);
  assert.equal(row.office_alert, 'Prefers morning appointments');
  assert.equal(h.summary.unconfirmed, 1);

  await api.post(`/patients/${patient.id}/medical-reviewed`);
  assert.ok(!(await api.get(`/huddle?date=${d}`)).data.rows[0].flags.includes('update_medical_history'));

  const slip = (await api.get(`/appointments/${appt.id}/route-slip`)).data;
  assert.equal(slip.patient.first_name, 'Jane');
  assert.equal(slip.unscheduled[0].code, 'D2392');
  assert.equal(slip.balance, 11000);

  // She has a future appointment, so she's not on the unscheduled list; cancel it and she is.
  assert.equal((await api.get('/followups/unscheduled')).data.length, 0);
  await api.put(`/appointments/${appt.id}`, { status: 'no_show' });
  const unsched = (await api.get('/followups/unscheduled')).data;
  assert.equal(unsched[0].amount, 23500);
  const broken = (await api.get('/followups/broken')).data;
  assert.equal(broken[0].id, appt.id);
  await api.post(`/patients/${patient.id}/followups`, { kind: 'broken', outcome: 'left_voicemail', note: 'Called cell' });
  assert.equal((await api.get('/followups/broken')).data[0].last_contact.outcome, 'left_voicemail');
  assert.equal((await api.post(`/patients/${patient.id}/followups`, { kind: 'broken', outcome: 'nope' })).status, 400);
});

test('case presentation: send plan, patient reviews estimate and e-signs', async () => {
  const { api, dentist, patient } = await setup();
  const plan = (await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'Phase 1', procedures: [{ code: 'D2740', tooth: '3', provider_id: dentist.id }] })).data;
  const pres = (await api.post(`/treatment-plans/${plan.id}/present`, { send: 'sms' })).data;
  assert.match(pres.message.body, /Review and sign here: https:\/\/app\.example\.com\/tp\//);
  const token = pres.url.split('/tp/')[1];
  const pub = client();
  const view = (await pub.get(`/public/tp/${token}`)).data;
  assert.equal(view.first_name, 'Jane');
  assert.equal(view.procedures[0].code, 'D2740');
  assert.equal(view.estimate.total_patient, 135000);
  assert.equal(view.last_name, undefined);
  assert.equal((await pub.post(`/public/tp/${token}`, { signature_name: 'Jane Doe' })).status, 400, 'consent required');
  const signed = (await pub.post(`/public/tp/${token}`, { signature_name: 'Jane Doe', consent: true })).data;
  assert.equal(signed.status, 'accepted');
  assert.ok(signed.signed_at);
  assert.equal((await pub.post(`/public/tp/${token}`, { signature_name: 'Jane Doe', consent: true })).status, 409);
  const plans = (await api.get(`/patients/${patient.id}/treatment-plans`)).data;
  assert.equal(plans[0].signature_name, 'Jane Doe');
});

test('prescriptions: favorites, allergy warnings, hygienists cannot prescribe', async () => {
  const { api, dentist, hygienist, patient } = await setup();
  const fav = (await api.get('/rx/favorites')).data;
  const amox = fav.find((f) => f.drug === 'Amoxicillin');
  assert.equal((await api.post(`/patients/${patient.id}/prescriptions`, { ...amox, provider_id: hygienist.id })).status, 400);
  const warn = await api.post(`/patients/${patient.id}/prescriptions`, { ...amox, provider_id: dentist.id });
  assert.equal(warn.status, 409);
  assert.equal(warn.data.details.allergy_warning, true);
  const clinda = fav.find((f) => f.drug === 'Clindamycin');
  const rx = (await api.post(`/patients/${patient.id}/prescriptions`, { ...clinda, provider_id: dentist.id })).data;
  assert.equal(rx.provider_npi, '1987654321');
  const printable = (await api.get(`/prescriptions/${rx.id}`)).data;
  assert.equal(printable.patient.last_name, 'Doe');
});

test('analytics KPIs, statement batch, recall campaign, review requests and templates', async () => {
  const { api, dentist, hygienist, patient } = await setup();
  const d = today();
  const past = localNow('America/New_York', new Date(Date.now() - 3 * 86400_000)).slice(0, 10);
  const visit = (await api.post('/appointments', { patient_id: patient.id, provider_id: hygienist.id, start_time: `${past} 09:00`, end_time: `${past} 10:00` })).data;
  await api.put(`/appointments/${visit.id}`, { status: 'completed' });
  await api.post('/appointments', { patient_id: patient.id, provider_id: hygienist.id, start_time: '2031-01-05 09:00', end_time: '2031-01-05 10:00' });
  await api.post(`/patients/${patient.id}/procedures`, { code: 'D1110', provider_id: hygienist.id, complete: true });
  const plan = (await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'A', procedures: [{ code: 'D2740', tooth: '3', provider_id: dentist.id }] })).data;
  await api.put(`/treatment-plans/${plan.id}`, { status: 'accepted' });
  await api.post(`/patients/${patient.id}/treatment-plans`, { name: 'B', procedures: [{ code: 'D2392', tooth: '30', surfaces: 'MO', provider_id: dentist.id }] });

  const k = (await api.get('/analytics')).data;
  assert.equal(k.production, 11000);
  assert.equal(k.hygiene_production, 11000);
  assert.equal(k.case_acceptance.presented, 135000 + 23500);
  assert.equal(k.case_acceptance.rate, Math.round((135000 / 158500) * 1000) / 10);
  assert.equal(k.hygiene_reappointment.rate, 100);
  assert.deepEqual(k.new_patients.by_source[0], { source: 'Google', n: 1 });

  // Statements: $110 balance qualifies at $5 minimum; emails go out and the account is stamped.
  const cands = (await api.get('/statements/candidates?min_balance=500')).data;
  assert.equal(cands[0].patient_portion, 11000);
  const run = (await api.post('/statements/run', { min_balance: 500 })).data;
  assert.equal(run.emailed, 1);
  assert.equal((await api.get('/statements/candidates?min_balance=500')).data.length, 0, 'not re-statemented within 25 days');

  // Bulk recall campaign.
  const recalls = (await api.get('/recalls?before=2099-01-01')).data;
  const before = sent.length;
  const camp = (await api.post('/recalls/campaign', { recall_ids: recalls.map((r) => r.id) })).data;
  assert.equal(camp.sent, recalls.length);
  assert.match(sent.at(-1).body, /time for your next checkup/);

  // Custom templates are validated and used.
  assert.equal((await api.put('/practice', { message_templates: { reminder: 'No link here' } })).status, 400);
  await api.put('/practice', { message_templates: { recall: 'Hey {first_name}! {practice} misses you.' } });
  await api.post('/recalls/campaign', { recall_ids: recalls.map((r) => r.id) });
  assert.equal(sent.at(-1).body, `Hey Jane! Parity ${n} misses you.`);
  assert.ok(sent.length > before);

  // Review requests after today's completed visit, once.
  await api.put('/practice', { review_url: 'https://g.page/r/example/review', review_requests: true });
  const early = (await api.post('/appointments', { patient_id: patient.id, provider_id: dentist.id, start_time: `${d} 00:10`, end_time: `${d} 00:20` })).data;
  await api.put(`/appointments/${early.id}`, { status: 'completed' });
  assert.equal(await runReviewRequests(db, messenger), 1);
  assert.match(sent.at(-1).body, /g\.page\/r\/example\/review/);
  assert.equal(await runReviewRequests(db, messenger), 0);
});

test('quick search and full data export (without secrets)', async () => {
  const { api, patient } = await setup();
  const s = (await api.get('/search?q=555-0100')).data;
  assert.equal(s.patients[0].id, patient.id);
  assert.equal((await api.get('/search?q=doe, ja')).data.patients[0].id, patient.id);
  const exp = (await api.get('/export')).data;
  assert.equal(exp.format, 'dentalmachine-export-v1');
  assert.equal(exp.tables.patients[0].first_name, 'Jane');
  const text = JSON.stringify(exp);
  assert.ok(!text.includes('password_hash') && !text.includes('scrypt$'), 'no password hashes');
  assert.ok(exp.tables.audit_log.length > 0);
});
