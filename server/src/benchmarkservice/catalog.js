// What practices may share with the benchmark service, and nothing else (BM1–BM2). Both sides use this list: the
// practice builds its payload from it, and the service rejects any field or metric that isn't on it — so a coding
// mistake on either side can't leak something new (a patient name, a date) into the shared data.
//
// Every value is a provider-level (or practice-level) aggregate for one calendar month, computed on the practice's
// side by the one definition each KPI already has (docs/metrics.md): metrics.js, diagnosis.js, the business view,
// recallfreq.js. Money in whole-dollar cents, percentages with one decimal, counts as counts.

// role: which rows are compared with each other (dentists with dentists, hygienists with hygienists, whole practices
// with whole practices). better: which way is good. min_n: the least sample a value must rest on to be sent.
export const METRICS = {
  dx_per_exam_new_patient: { label: 'Treatment diagnosed per new-patient exam', unit: 'money', better: 'higher', roles: ['dentist'], badge: 'Eagle Eye', source: 'diagnosis.js diagnosisFunnel' },
  dx_per_exam_recall: { label: 'Treatment diagnosed per recall exam', unit: 'money', better: 'higher', roles: ['dentist', 'hygienist'], badge: 'Sharp Eye', source: 'diagnosis.js diagnosisFunnel' },
  dx_per_exam_emergency: { label: 'Treatment diagnosed per emergency exam', unit: 'money', better: 'higher', roles: ['dentist'], badge: 'First Responder', source: 'diagnosis.js diagnosisFunnel' },
  exam_value_1m: { label: 'Work completed within 1 month, per exam', unit: 'money', better: 'higher', roles: ['dentist'], badge: 'Quick Finisher', source: 'metrics.js examValues (1 month)' },
  exam_value_3m: { label: 'Work completed within 3 months, per exam', unit: 'money', better: 'higher', roles: ['dentist'], badge: 'Follow-through', source: 'metrics.js examValues (3 months)' },
  exam_value_5m: { label: 'Work completed within 5 months, per exam', unit: 'money', better: 'higher', roles: ['dentist'], badge: 'Long Game', source: 'metrics.js examValues (5 months)' },
  case_acceptance: { label: 'Case acceptance', unit: 'percent', better: 'higher', roles: ['dentist', 'practice'], badge: 'The Closer', source: 'metrics.js case_acceptance' },
  conv_presented: { label: 'Diagnosed work presented', unit: 'percent', better: 'higher', roles: ['dentist'], badge: 'Show & Tell', source: 'diagnosis.js funnel (of diagnosed)' },
  conv_accepted: { label: 'Diagnosed work accepted', unit: 'percent', better: 'higher', roles: ['dentist'], badge: 'Trusted Advisor', source: 'diagnosis.js funnel (of diagnosed)' },
  conv_scheduled: { label: 'Diagnosed work scheduled', unit: 'percent', better: 'higher', roles: ['dentist'], badge: 'Booked Solid', source: 'diagnosis.js funnel (of diagnosed)' },
  conv_completed: { label: 'Diagnosed work completed', unit: 'percent', better: 'higher', roles: ['dentist'], badge: 'The Finisher', source: 'diagnosis.js funnel (of diagnosed)' },
  production_per_hour: { label: 'Production per hour', labels: { dentist: 'Production per doctor-hour', hygienist: 'Production per hygiene-hour' }, unit: 'money', better: 'higher', roles: ['dentist', 'hygienist'], badge: 'Hour Hero', source: 'metrics.js production ÷ business.js visit time' },
  hygiene_reappointment: { label: 'Hygiene reappointment', unit: 'percent', better: 'higher', roles: ['hygienist'], badge: 'Boomerang', source: 'metrics.js hygiene_reappointment' },
  perio_pct: { label: 'Perio share of hygiene', unit: 'percent', better: 'higher', roles: ['hygienist'], badge: 'Gum Guardian', source: 'Hygiene report rule (perio ÷ perio + prophy)' },
  broken_rate: { label: 'No-show & cancel rate', unit: 'percent', better: 'lower', roles: ['dentist', 'hygienist', 'practice'], badge: 'Iron Schedule', source: 'metrics.js broken_rate' },
  schedule_fill: { label: 'Schedule fill', unit: 'percent', better: 'higher', roles: ['dentist', 'hygienist'], badge: 'Full House', source: 'report library schedule-utilization' },
  collection_rate: { label: 'Collection rate', unit: 'percent', better: 'higher', roles: ['practice'], badge: 'Money Magnet', source: 'metrics.js collection_rate' },
  new_patients: { label: 'New patients per month', unit: 'count', better: 'higher', roles: ['practice'], badge: 'Welcome Wagon', source: 'metrics.js new_patients' },
  reappointment_pct: { label: 'Patients leaving with their next cleaning booked', unit: 'percent', better: 'higher', roles: ['practice'], badge: 'See You Soon', source: 'recallfreq.js recallCounts' },
  recall_current: { label: 'Patients current on recall', unit: 'percent', better: 'higher', roles: ['practice'], badge: 'Right On Time', source: 'recallfreq.js recallCounts' },
  labor_pct: { label: 'Team wages as a share of production', unit: 'percent', better: 'lower', roles: ['practice'], badge: 'Lean Machine', optional: true, source: 'business view labor % of production' },
};
export const ROLES = { dentist: 'Dentists', hygienist: 'Hygienists', practice: 'Whole practice' };
export const metricLabel = (key, role) => METRICS[key]?.labels?.[role] || METRICS[key]?.label || key;

// "What top performers do differently": for each metric, the numbers worth comparing among the people who are best
// at it. Statements are made from these numbers only (never guesses about why).
export const RELATED = {
  dx_per_exam_new_patient: ['conv_presented', 'case_acceptance', 'exam_value_5m'],
  dx_per_exam_recall: ['conv_presented', 'case_acceptance', 'schedule_fill'],
  dx_per_exam_emergency: ['conv_scheduled', 'conv_completed'],
  exam_value_1m: ['conv_scheduled', 'conv_accepted', 'schedule_fill'],
  exam_value_3m: ['conv_scheduled', 'conv_accepted', 'dx_per_exam_recall'],
  exam_value_5m: ['conv_completed', 'conv_accepted', 'dx_per_exam_recall'],
  case_acceptance: ['conv_presented', 'conv_scheduled', 'dx_per_exam_new_patient'],
  conv_presented: ['case_acceptance', 'dx_per_exam_recall'],
  conv_accepted: ['conv_presented', 'conv_scheduled'],
  conv_scheduled: ['conv_accepted', 'schedule_fill', 'broken_rate'],
  conv_completed: ['conv_scheduled', 'broken_rate', 'schedule_fill'],
  production_per_hour: ['schedule_fill', 'broken_rate', 'dx_per_exam_recall', 'perio_pct'],
  hygiene_reappointment: ['broken_rate', 'schedule_fill', 'perio_pct'],
  perio_pct: ['dx_per_exam_recall', 'production_per_hour'],
  broken_rate: ['schedule_fill', 'hygiene_reappointment'],
  schedule_fill: ['broken_rate', 'hygiene_reappointment'],
  collection_rate: ['broken_rate', 'case_acceptance'],
  new_patients: ['case_acceptance', 'reappointment_pct'],
  reappointment_pct: ['recall_current', 'broken_rate'],
  recall_current: ['reappointment_pct', 'broken_rate'],
  labor_pct: ['collection_rate', 'broken_rate'],
};

// ---- Peer groups (BM3) ----
export const PRACTICE_TYPES = { general: 'General', pediatric: 'Pediatric', perio: 'Periodontics', ortho: 'Orthodontics', endo: 'Endodontics', oral_surgery: 'Oral surgery', prosth: 'Prosthodontics', multi: 'Multi-specialty' };
export const REGIONS = { northeast: 'Northeast', midwest: 'Midwest', south: 'South', west: 'West', other: 'Outside the 50 states' };
export const SIZE_BANDS = { solo: '1 dentist', small: '2–3 dentists', medium: '4–6 dentists', large: '7+ dentists' };
export const PAYER_MIX = { insurance_heavy: 'Mostly insurance', mixed: 'Mixed insurance and self-pay', fee_for_service: 'Mostly fee-for-service' };
export const YEARS_BANDS = { new: 'Under 5 years', established: '5–15 years', mature: '15+ years', unknown: 'Not given' };
export const DIMENSIONS = { practice_type: PRACTICE_TYPES, region: REGIONS, size_band: SIZE_BANDS, payer_mix: PAYER_MIX, years_band: YEARS_BANDS };
// The order in which a peer group is widened when it's too small: the least telling difference goes first.
export const RELAX_ORDER = ['years_band', 'payer_mix', 'size_band', 'region', 'practice_type'];

const STATE_REGION = {
  northeast: ['CT', 'ME', 'MA', 'NH', 'RI', 'VT', 'NJ', 'NY', 'PA'],
  midwest: ['IL', 'IN', 'MI', 'OH', 'WI', 'IA', 'KS', 'MN', 'MO', 'NE', 'ND', 'SD'],
  south: ['DE', 'FL', 'GA', 'MD', 'NC', 'SC', 'VA', 'DC', 'WV', 'AL', 'KY', 'MS', 'TN', 'AR', 'LA', 'OK', 'TX'],
  west: ['AZ', 'CO', 'ID', 'MT', 'NV', 'NM', 'UT', 'WY', 'AK', 'CA', 'HI', 'OR', 'WA'],
};
export const regionFor = (state) => Object.entries(STATE_REGION).find(([, list]) => list.includes(String(state || '').trim().toUpperCase()))?.[0] || 'other';
export const sizeBandFor = (dentists) => (dentists <= 1 ? 'solo' : dentists <= 3 ? 'small' : dentists <= 6 ? 'medium' : 'large');
export const yearsBandFor = (foundedYear, thisYear) => (!foundedYear ? 'unknown' : thisYear - foundedYear < 5 ? 'new' : thisYear - foundedYear <= 15 ? 'established' : 'mature');
// Insurance share of the last 12 months' collections (insurance payments ÷ all payments received).
export const payerMixFor = (insurancePct) => (insurancePct == null ? 'mixed' : insurancePct >= 50 ? 'insurance_heavy' : insurancePct <= 20 ? 'fee_for_service' : 'mixed');

// ---- The payload (the only shape accepted) ----
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const PROVIDER_KEY = /^k_[a-f0-9]{16}$/;
export const PARTICIPANT_ID = /^bp_[a-f0-9]{24}$/;
export const ANON_CODE = /^\d{4}$/;
export const PAYLOAD_KEYS = ['v', 'kind', 'participant_id', 'nonce', 'sent_at', 'profile', 'months', 'public_key', 'month'];
export const MONTH_KEYS = ['month', 'complete', 'rows'];
export const ROW_KEYS = ['provider_key', 'role', 'anon_code', 'display_name', 'metric', 'value', 'n'];
export const PROFILE_KEYS = Object.keys(DIMENSIONS);
export const MAX_ROWS_PER_MONTH = 4000;
