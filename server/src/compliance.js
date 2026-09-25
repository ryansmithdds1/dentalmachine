import { HttpError, can } from './auth.js';
import { insert, audit, isRealDate } from './util.js';

// Compliance logs (README.md, “Compliance log”): complaints and incidents, staff exposure incidents (OSHA) and the HIPAA
// accounting of disclosures. Shared pieces live here so other screens that disclose a record (the record export)
// can add to the disclosure log themselves.

// Why PHI left the practice, for the accounting of disclosures (45 CFR 164.528). Only disclosures outside
// treatment, payment and operations, to someone other than the patient and without their written authorization,
// have to be accounted for — so these are the reasons that do.
export const DISCLOSURE_PURPOSES = {
  required_by_law: 'Required by law (subpoena, court order, statute)',
  public_health: 'Public health reporting',
  abuse_report: 'Report of abuse, neglect or domestic violence',
  health_oversight: 'Health oversight (dental board, auditor, investigator)',
  judicial: 'Court or legal proceeding',
  law_enforcement: 'Law enforcement',
  coroner: 'Coroner, medical examiner or funeral director',
  research: 'Research (without the patient’s authorization)',
  threat: 'To prevent a serious threat to health or safety',
  workers_comp: 'Workers’ compensation',
  unauthorized: 'Sent in error / unauthorized disclosure',
  other: 'Other (describe)',
};
// The accounting covers the six years before the request.
export const ACCOUNTING_YEARS = 6;

export const isManager = (user) => can(user, 'compliance:manage');

// Records one disclosure on a patient's chart. Used by the Disclosures screen and, automatically, by any screen
// that hands a record to someone outside the practice (the record export with a recipient). Audited.
export async function recordDisclosure(db, req, patient, input, { source = 'manual', today }) {
  const recipient = String(input.recipient ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const description = String(input.description ?? '').trim().slice(0, 1000);
  const purpose = String(input.purpose ?? '').trim();
  if (!recipient) throw new HttpError(400, 'Who was it given to? Fill in “Recipient”', { missing: ['recipient'] });
  if (!DISCLOSURE_PURPOSES[purpose]) throw new HttpError(400, `Choose why it was disclosed: ${Object.keys(DISCLOSURE_PURPOSES).join(', ')}`);
  if (!description) throw new HttpError(400, 'Say what was disclosed (e.g. “x-rays and treatment notes 2024–2026”)', { missing: ['description'] });
  const detail = String(input.purpose_detail ?? '').trim().slice(0, 500) || null;
  if (purpose === 'other' && !detail) throw new HttpError(400, 'Describe the purpose');
  const on = input.disclosed_on || today;
  if (!isRealDate(on)) throw new HttpError(400, 'Date must be a real date (YYYY-MM-DD)');
  if (on > today) throw new HttpError(400, "A disclosure can't be dated in the future");
  const id = await insert(db, 'phi_disclosures', {
    practice_id: patient.practice_id, patient_id: patient.id, disclosed_on: on, recipient,
    recipient_address: String(input.recipient_address ?? '').trim().slice(0, 300) || null, purpose, purpose_detail: detail, description,
    source, recorded_by: req.user.id,
  });
  await audit(db, req, 'disclosure.record', 'phi_disclosures', id, { patient_id: patient.id, purpose, recipient, source }, { patientId: patient.id });
  return id;
}

// Post-exposure follow-up (OSHA 1910.1030(f)(3)), in the order it happens. Each is ticked with the date it was done.
export const EXPOSURE_STEPS = [
  ['washed', 'Wound washed / eyes or mouth flushed'],
  ['reported', 'Reported to the office manager'],
  ['evaluated', 'Sent for medical evaluation (ideally within 2 hours)'],
  ['source_tested', 'Source patient asked to consent to testing'],
  ['baseline_tested', 'Employee offered baseline blood testing'],
  ['pep_offered', 'Post-exposure treatment (PEP) offered'],
  ['counseling', 'Employee counseled'],
  ['opinion_received', 'Written opinion from the healthcare professional (within 15 days)'],
  ['sharps_logged', 'Entered in the sharps injury log'],
];
