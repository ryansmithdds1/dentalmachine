import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './auth.js';
import { verifyTotp } from './totp.js';

// Electronic prescribing.
//   ERX=none      (default) prescriptions are printed and signed by hand.
//   ERX=sandbox   built-in simulated pharmacy network, for demos and training.
//   ERX=dosespot  DoseSpot, a Surescripts-certified e-prescribing service with DEA-audited EPCS.
//                 Prescribers write and sign inside DoseSpot's screens (single sign-on from the chart),
//                 which is what makes controlled-substance e-prescribing legal: EPCS software must pass a
//                 third-party DEA audit, and identity proofing/two-factor signing happen in DoseSpot.
export function erxConfig(env = process.env) {
  return {
    mode: env.ERX || 'none',
    dosespot: {
      url: (env.ERX_DOSESPOT_URL || 'https://my.staging.dosespot.com').replace(/\/$/, ''),
      clinicId: env.ERX_DOSESPOT_CLINIC_ID || null,
      clinicKey: env.ERX_DOSESPOT_CLINIC_KEY || null,
    },
  };
}

export function createErx(config = erxConfig()) {
  const base = { mode: config.mode, electronic: config.mode !== 'none' };
  if (config.mode === 'sandbox') {
    return {
      ...base, name: 'Sandbox e-prescribing', inApp: true, epcs: true,
      async transmit(rx) {
        if (!rx.pharmacy_ncpdp) throw new HttpError(400, 'Choose the patient\'s pharmacy first');
        return { reference: `SBX-RX-${Date.now().toString(36).toUpperCase()}`, status: 'transmitted' };
      },
      searchPharmacies: (q) => SANDBOX_PHARMACIES.filter((p) => !q || `${p.name} ${p.city} ${p.zip}`.toLowerCase().includes(q.toLowerCase())),
    };
  }
  if (config.mode === 'dosespot') {
    const ds = config.dosespot;
    if (!ds.clinicId || !ds.clinicKey) throw new Error('ERX=dosespot needs ERX_DOSESPOT_CLINIC_ID and ERX_DOSESPOT_CLINIC_KEY');
    return {
      ...base, name: 'DoseSpot', inApp: false, epcs: true,
      ssoUrl: ({ userId, patient }) => doseSpotSsoUrl({ ...ds, userId, patient }),
    };
  }
  return { ...base, name: 'Printed prescriptions', inApp: false, epcs: false };
}

// DoseSpot single sign-on (legacy SSO page): the clinic key never leaves the server; the URL carries a
// one-time code derived from it, the prescriber's DoseSpot user id and the patient's demographics so the
// chart opens (and the patient is created/updated) in DoseSpot.
export function doseSpotSsoUrl({ url, clinicId, clinicKey, userId, patient, phrase = randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(32, 'x').slice(0, 32) }) {
  const hash = (s) => createHash('sha512').update(s, 'utf8').digest('base64').replace(/==$/, '');
  const params = new URLSearchParams({
    SingleSignOnClinicId: String(clinicId),
    SingleSignOnUserId: String(userId),
    SingleSignOnPhraseLength: '32',
    SingleSignOnCode: phrase + hash(phrase + clinicKey),
    SingleSignOnUserIdVerify: hash(phrase.slice(0, 22) + userId + clinicKey),
  });
  if (patient) {
    const phone = String(patient.phone || '').replace(/\D/g, '').slice(-10);
    for (const [k, v] of Object.entries({
      PatientId: patient.erx_patient_id || '', FirstName: patient.first_name, LastName: patient.last_name, DateOfBirth: patient.dob ? `${patient.dob.slice(5, 7)}/${patient.dob.slice(8, 10)}/${patient.dob.slice(0, 4)}` : '',
      Gender: { female: 'Female', male: 'Male' }[patient.gender] || 'Unknown', Address1: patient.address, City: patient.city, State: patient.state, ZipCode: patient.zip,
      PrimaryPhone: phone, PrimaryPhoneType: phone ? 'Cell' : '',
    })) if (v) params.set(k, v);
  }
  return `${url}/LoginSingleSignOn.aspx?${params}`;
}

// DEA 21 CFR 1311 for controlled substances, enforced for in-app e-prescribing (sandbox) and recorded for audits:
// only the prescriber can sign, they need a DEA number, and signing needs a fresh second-factor code.
export async function checkEpcs(db, { user, provider, schedule, refills, otp }) {
  if (!schedule) return null;
  if (!['II', 'III', 'IV', 'V'].includes(schedule)) throw new HttpError(400, 'schedule must be II, III, IV or V');
  if (!provider.dea_number) throw new HttpError(400, `${provider.name} needs a DEA number (Settings → Providers) to prescribe controlled substances`);
  if (provider.user_id !== user.id) throw new HttpError(403, 'Controlled substances must be signed by the prescriber themselves');
  if (schedule === 'II' && Number(refills) > 0) throw new HttpError(400, 'Schedule II prescriptions cannot have refills');
  const u = await db.get('SELECT mfa_enabled, mfa_secret, mfa_last_step FROM users WHERE id = ?', user.id);
  if (!u.mfa_enabled) throw new HttpError(403, 'Turn on two-factor authentication (Settings → My account) to sign controlled-substance prescriptions', { mfa_setup_required: true });
  if (!otp) throw new HttpError(403, 'Enter the 6-digit code from your authenticator app to sign', { otp_required: true });
  const step = verifyTotp(u.mfa_secret, otp, { lastStep: u.mfa_last_step });
  if (step == null) throw new HttpError(403, 'That code is not valid — wait for a new one and try again', { otp_required: true });
  await db.run('UPDATE users SET mfa_last_step = ? WHERE id = ?', step, user.id);
  return { signed_by: user.id, two_factor: true };
}

// Demo pharmacy directory (sandbox only). NCPDP IDs here are fictitious.
export const SANDBOX_PHARMACIES = [
  { ncpdp: '9900001', name: 'Main Street Pharmacy', address: '410 Main St', city: 'Austin', state: 'TX', zip: '78701', phone: '(512) 555-0180', fax: '(512) 555-0181' },
  { ncpdp: '9900002', name: 'Lamar Family Drug', address: '2200 S Lamar Blvd', city: 'Austin', state: 'TX', zip: '78704', phone: '(512) 555-0190', fax: '(512) 555-0191' },
  { ncpdp: '9900003', name: 'Riverside 24-Hour Pharmacy', address: '1800 E Riverside Dr', city: 'Austin', state: 'TX', zip: '78741', phone: '(512) 555-0170', fax: '(512) 555-0171' },
  { ncpdp: '9900004', name: 'North Loop Apothecary', address: '5300 N Loop Blvd', city: 'Austin', state: 'TX', zip: '78751', phone: '(512) 555-0160', fax: '(512) 555-0161' },
  { ncpdp: '9900005', name: 'Mail-order Rx Service', address: 'PO Box 100', city: 'Dallas', state: 'TX', zip: '75201', phone: '(800) 555-0150', fax: '(800) 555-0151' },
];
