import { HttpError } from './auth.js';

export const MEDICAL_CONDITIONS = [
  'Heart disease', 'High blood pressure', 'Artificial heart valve', 'Pacemaker', 'Stroke', 'Diabetes', 'Asthma',
  'COPD / emphysema', 'Hepatitis', 'HIV / AIDS', 'Kidney disease', 'Liver disease', 'Bleeding disorder',
  'Anemia', 'Epilepsy / seizures', 'Thyroid disease', 'Osteoporosis (on bisphosphonates)', 'Artificial joint',
  'Cancer / chemotherapy', 'Radiation to head or neck', 'Sleep apnea', 'Anxiety / depression', 'Tuberculosis',
];

const TEXT_FIELDS = [
  'allergies', 'medications', 'other_conditions', 'physician_name', 'physician_phone', 'last_dental_visit',
  'chief_concern', 'phone', 'email', 'address', 'city', 'state', 'zip', 'emergency_contact',
];

// Validates and normalizes a medical-history submission from the public intake form.
export function parseMedicalHistory(body) {
  const answers = body?.answers || {};
  const out = {};
  for (const f of TEXT_FIELDS) {
    const v = answers[f];
    if (v != null && typeof v !== 'string') throw new HttpError(400, `${f} must be text`);
    out[f] = v?.trim().slice(0, 2000) || null;
  }
  out.conditions = Array.isArray(answers.conditions) ? answers.conditions.filter((c) => MEDICAL_CONDITIONS.includes(c)) : [];
  for (const f of ['pregnant', 'tobacco', 'premedication']) out[f] = !!answers[f];
  if (!answers.consent_hipaa || !answers.consent_treatment) throw new HttpError(400, 'Please acknowledge the privacy notice and consent to treatment');
  out.consent_hipaa = true;
  out.consent_treatment = true;
  const signatureName = String(body?.signature_name || '').trim();
  if (signatureName.length < 2) throw new HttpError(400, 'Type your full name to sign');
  const signatureImage = body?.signature_image;
  if (signatureImage != null && (typeof signatureImage !== 'string' || !signatureImage.startsWith('data:image/png;base64,') || signatureImage.length > 300_000)) {
    throw new HttpError(400, 'Invalid signature image');
  }
  return { answers: out, signatureName, signatureImage: signatureImage || null };
}

// Fields on the patient record that a completed medical history refreshes.
export function patientUpdatesFromHistory(a) {
  const alerts = [...a.conditions];
  if (a.other_conditions) alerts.push(a.other_conditions);
  if (a.pregnant) alerts.push('Pregnant');
  if (a.premedication) alerts.push('Requires antibiotic premedication');
  const updates = {
    medical_alerts: alerts.join(', ') || null,
    allergies: a.allergies,
    medications: a.medications,
  };
  for (const f of ['phone', 'email', 'address', 'city', 'state', 'zip', 'emergency_contact']) if (a[f]) updates[f] = a[f];
  return updates;
}
