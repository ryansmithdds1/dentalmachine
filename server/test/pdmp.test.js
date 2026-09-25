import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { createPdmp } from '../src/pdmp.js';

// PDMP checks before controlled substances (README.md, “PDMP”): sandbox, the vendor adapter through loggedFetch without
// patient details in the log, failures in Needs attention, and the prescription gate (a check or a reason).
let vendorUp = true;
const calls = [];
const fetchImpl = async (url, opts = {}) => {
  if (String(url).startsWith('https://pmp.example.org')) {
    calls.push({ url: String(url), body: opts.body });
    if (!vendorUp) return new Response(JSON.stringify({ error: 'Service unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ report_id: 'RPT-77', summary: { prescriptions: 3, prescribers: 3, pharmacies: 2, flags: ['Multiple prescribers'] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return globalThis.fetch(url, opts);
};
const gateway = harness({ config: { pdmp: { mode: 'gateway', url: 'https://pmp.example.org', clientId: 'cid', secret: 'shh', state: 'TX' } }, fetchImpl });

test('PDMP via the vendor adapter: summary kept, call logged without PHI, failures raise Needs attention and clear', async () => {
  const { api, patient, provider } = await gateway.practice({ timezone: 'UTC' });
  const me = (await api.get('/auth/me')).data.user;
  await api.put(`/providers/${provider.id}`, { user_id: me.id, dea_number: 'BL1234563' });
  assert.equal((await api.get('/pdmp')).data.automatic, true);
  const ok = await api.post(`/patients/${patient.id}/pdmp-checks`, {});
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.flagged, 1);
  assert.match(ok.data.summary, /3 controlled-substance prescriptions .* 3 prescribers and 2 pharmacies\. Flag: Multiple prescribers/);
  assert.equal(ok.data.external_ref, 'RPT-77');
  assert.equal(ok.data.provider_id, provider.id);
  // The request carried the demographics in its body; the connection log has only host, path and result.
  assert.match(calls.at(-1).body, /"last_name":"Doe"/);
  const log = await gateway.db.all("SELECT * FROM integration_log WHERE service = 'PDMP'");
  assert.equal(log.length, 1);
  assert.equal(log[0].operation, 'POST /v1/patient-reports');
  assert.doesNotMatch(JSON.stringify(log), /Doe|1985-04-12/);

  vendorUp = false;
  const bad = await api.post(`/patients/${patient.id}/pdmp-checks`, {});
  assert.equal(bad.status, 502);
  assert.match(bad.data.error, /state PDMP website/);
  let issue = await gateway.db.get("SELECT * FROM issues WHERE dedupe_key = 'pdmp-failed'");
  assert.equal(issue.status, 'open');
  assert.equal((await gateway.db.get("SELECT status FROM pdmp_checks WHERE id = ?", bad.data.details.check_id)).status, 'failed');
  vendorUp = true;
  assert.equal((await api.post(`/patients/${patient.id}/pdmp-checks`, {})).status, 201);
  issue = await gateway.db.get("SELECT * FROM issues WHERE dedupe_key = 'pdmp-failed'");
  assert.equal(issue.status, 'resolved', 'a later check that works clears it');
  const acts = (await api.get('/audit-log?limit=30')).data.map((e) => e.action);
  assert.ok(acts.includes('pdmp.check') && acts.includes('pdmp.check_failed'));
});

test('PDMP gate on controlled prescriptions: a recent check is used, otherwise a reason is needed; non-controlled unaffected', async () => {
  const { api, patient, provider } = await gateway.practice({ timezone: 'UTC' });
  await api.put(`/providers/${provider.id}`, { dea_number: 'BL1234563' });
  const hydro = { provider_id: provider.id, drug: 'Hydrocodone/acetaminophen', strength: '5/325', sig: 'Take 1 every 6 hours as needed', quantity: '12' };
  // Printed (not sent), so the EPCS signing rules don't apply here; the PDMP rule does.
  const r = await api.post(`/patients/${patient.id}/prescriptions`, hydro);
  assert.equal(r.status, 409);
  assert.equal(r.data.details.pdmp_required, true);
  assert.equal((await api.post(`/patients/${patient.id}/prescriptions`, { ...hydro, pdmp_override_reason: 'no' })).status, 409, 'a real reason');
  const skipped = await api.post(`/patients/${patient.id}/prescriptions`, { ...hydro, pdmp_override_reason: 'State PDMP website down; one-time 3-day supply' });
  assert.equal(skipped.status, 201, JSON.stringify(skipped.data));
  assert.equal(skipped.data.pdmp_override_reason, 'State PDMP website down; one-time 3-day supply');
  assert.equal(skipped.data.pdmp_check_id, null);
  // With a check in the last day, it's used without being asked for.
  const check = (await api.post(`/patients/${patient.id}/pdmp-checks`, {})).data;
  const withCheck = (await api.post(`/patients/${patient.id}/prescriptions`, hydro)).data;
  assert.equal(withCheck.pdmp_check_id, check.id);
  assert.match(withCheck.pdmp_summary, /controlled-substance prescriptions/);
  // An old check doesn't count; another patient's check can't be borrowed.
  await gateway.db.run("UPDATE pdmp_checks SET created_at = '2020-01-01 00:00:00' WHERE patient_id = ?", patient.id);
  assert.equal((await api.post(`/patients/${patient.id}/prescriptions`, hydro)).status, 409);
  assert.equal((await api.post(`/patients/${patient.id}/prescriptions`, { ...hydro, pdmp_check_id: check.id })).status, 409);
  const other = (await api.post('/patients', { first_name: 'Other', last_name: 'Person', dob: '1990-01-01' })).data;
  const otherCheck = (await api.post(`/patients/${other.id}/pdmp-checks`, {})).data;
  assert.equal((await api.post(`/patients/${patient.id}/prescriptions`, { ...hydro, pdmp_check_id: otherCheck.id })).status, 400);
  // A prescriber's own look at the state website counts when recorded.
  assert.equal((await api.post(`/patients/${patient.id}/pdmp-checks`, { manual: true })).status, 400);
  const manual = (await api.post(`/patients/${patient.id}/pdmp-checks`, { manual: true, summary: 'No controlled prescriptions in 12 months' })).data;
  assert.equal(manual.mode, 'manual');
  assert.equal((await api.post(`/patients/${patient.id}/prescriptions`, hydro)).data.pdmp_check_id, manual.id);
  // Amoxicillin needs no PDMP.
  assert.equal((await api.post(`/patients/${patient.id}/prescriptions`, { ...hydro, drug: 'Amoxicillin', strength: '500 mg' })).status, 201);
  // Permissions and isolation: the front desk can't run checks; another practice can't see or use them.
  const email = `desk-${Date.now()}@example.com`;
  await api.post('/users', { email, name: 'Desk', role: 'front_desk', password: 'correct-horse-battery' });
  const desk = gateway.client((await gateway.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);
  assert.equal((await desk.post(`/patients/${patient.id}/pdmp-checks`, {})).status, 403);
  const b = await gateway.practice();
  assert.equal((await b.api.get(`/patients/${patient.id}/pdmp-checks`)).status, 404);
  assert.equal((await b.api.post(`/patients/${b.patient.id}/prescriptions`, { ...hydro, provider_id: b.provider.id, pdmp_check_id: manual.id })).status, 400);
});

test('PDMP sandbox and no-connection modes', async () => {
  const logged = [];
  const fakeDb = { run: async (...a) => { logged.push(a); return {}; } };
  const sbx = createPdmp({ config: { mode: 'sandbox' }, db: fakeDb });
  const out = await sbx.query({ patient: { id: 3, first_name: 'A', last_name: 'B' }, practiceId: 1 });
  assert.equal(out.prescriptions, 1);
  assert.match(out.external_ref, /^SBX-PDMP-/);
  assert.equal(logged.length, 1, 'even the sandbox shows in Connection activity');
  assert.doesNotMatch(JSON.stringify(logged), /"A"|"B"/);
  assert.equal(createPdmp({ config: { mode: 'none' } }).automatic, false);
  assert.throws(() => createPdmp({ config: { mode: 'gateway' } }), /PDMP_URL/);
  assert.throws(() => createPdmp({ config: { mode: 'nope' } }), /none, sandbox or gateway/);
});
