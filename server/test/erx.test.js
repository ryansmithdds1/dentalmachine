import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { harness } from './helpers.js';
import { totp, timeStep } from '../src/totp.js';
import { doseSpotSsoUrl, createErx } from '../src/erx.js';

const h = harness({ config: { erx: { mode: 'sandbox' } } });

test('e-prescribing: pharmacy, electronic send, and EPCS rules for controlled substances', async () => {
  const { api, provider, patient } = await h.practice();
  const me = (await api.get('/auth/me')).data.user;
  assert.equal((await api.get('/erx')).data.in_app, true);

  // No pharmacy yet.
  const base = { provider_id: provider.id, drug: 'Ibuprofen', strength: '600 mg tablet', sig: 'Take 1 tablet every 6 hours as needed', quantity: '20', send: true };
  assert.equal((await api.post(`/patients/${patient.id}/prescriptions`, base)).status, 400);
  const [pharmacy] = (await api.get('/pharmacies?q=lamar')).data;
  assert.equal(pharmacy.name, 'Lamar Family Drug');
  await api.put(`/patients/${patient.id}/pharmacy`, { pharmacy });
  assert.equal(JSON.parse((await api.get(`/patients/${patient.id}`)).data.preferred_pharmacy).ncpdp, pharmacy.ncpdp);

  const sent = (await api.post(`/patients/${patient.id}/prescriptions`, base)).data;
  assert.equal(sent.status, 'transmitted');
  assert.match(sent.erx_reference, /^SBX-RX-/);
  assert.equal(sent.pharmacy.name, 'Lamar Family Drug');

  // Controlled substance: needs DEA, the prescriber's own login, and a fresh 2FA code.
  const hydro = { ...base, drug: 'Hydrocodone/acetaminophen', strength: '5/325', quantity: '12', schedule: 'II' };
  let r = await api.post(`/patients/${patient.id}/prescriptions`, hydro);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /DEA number/);
  await api.put(`/providers/${provider.id}`, { dea_number: 'BL1234563' });
  r = await api.post(`/patients/${patient.id}/prescriptions`, hydro);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /prescriber themselves/);
  await api.put(`/providers/${provider.id}`, { user_id: me.id });
  r = await api.post(`/patients/${patient.id}/prescriptions`, hydro);
  assert.equal(r.status, 403);
  assert.ok(r.data.details.mfa_setup_required);

  const { secret } = (await api.post('/auth/mfa/setup')).data;
  assert.equal((await api.post('/auth/mfa/enable', { code: totp(secret) })).status, 200);
  r = await api.post(`/patients/${patient.id}/prescriptions`, hydro);
  assert.ok(r.data.details.otp_required);
  assert.equal((await api.post(`/patients/${patient.id}/prescriptions`, { ...hydro, otp: '000000' })).status, 403);
  assert.equal((await api.post(`/patients/${patient.id}/prescriptions`, { ...hydro, refills: 2, otp: totp(secret, timeStep() + 1) })).status, 400, 'no refills on Schedule II');
  const signed = await api.post(`/patients/${patient.id}/prescriptions`, { ...hydro, otp: totp(secret, timeStep() + 1) });
  assert.equal(signed.status, 201, JSON.stringify(signed.data));
  assert.equal(signed.data.status, 'transmitted');
  assert.equal(signed.data.signed_two_factor, 1);
  assert.equal(signed.data.signed_by, me.id);
  // The same code can't be used twice.
  assert.equal((await api.post(`/patients/${patient.id}/prescriptions`, { ...hydro, otp: totp(secret, timeStep() + 1) })).status, 403);

  // Printed prescriptions still work and are marked as printed.
  const printed = (await api.post(`/patients/${patient.id}/prescriptions`, { ...base, send: false })).data;
  assert.equal(printed.status, 'printed');
  const log = (await api.get('/audit-log?limit=50')).data;
  assert.ok(log.some((e) => e.action === 'prescription.sign' && JSON.parse(e.details).two_factor === true));
});

test('DoseSpot single sign-on URL carries a verifiable one-time code and the patient', () => {
  const phrase = 'A'.repeat(32);
  const url = new URL(doseSpotSsoUrl({ url: 'https://my.staging.dosespot.com', clinicId: 123, clinicKey: 'KEY', userId: 456, phrase, patient: { first_name: 'Jane', last_name: 'Doe', dob: '1985-04-12', phone: '(512) 555-0100', gender: 'female', state: 'TX', zip: '78704' } }));
  const hash = (s) => createHash('sha512').update(s).digest('base64').replace(/==$/, '');
  assert.equal(url.pathname, '/LoginSingleSignOn.aspx');
  assert.equal(url.searchParams.get('SingleSignOnCode'), phrase + hash(`${phrase}KEY`));
  assert.equal(url.searchParams.get('SingleSignOnUserIdVerify'), hash(`${phrase.slice(0, 22)}456KEY`));
  assert.equal(url.searchParams.get('DateOfBirth'), '04/12/1985');
  assert.equal(url.searchParams.get('PrimaryPhone'), '5125550100');
  assert.ok(!url.toString().includes('KEY'), 'clinic key never appears in the URL');
  assert.throws(() => createErx({ mode: 'dosespot', dosespot: {} }), /CLINIC_ID/);
});
