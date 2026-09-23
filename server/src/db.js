import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS practices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT, city TEXT, state TEXT, zip TEXT, phone TEXT, email TEXT,
  tax_id TEXT, npi TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','dentist','hygienist','assistant','front_desk','billing')),
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'dentist' CHECK (type IN ('dentist','hygienist','specialist')),
  npi TEXT,
  license_number TEXT,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS operatories (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  preferred_name TEXT,
  dob TEXT,
  gender TEXT,
  email TEXT, phone TEXT,
  address TEXT, city TEXT, state TEXT, zip TEXT,
  emergency_contact TEXT,
  medical_alerts TEXT, allergies TEXT, medications TEXT,
  notes TEXT,
  primary_provider_id INTEGER REFERENCES providers(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(practice_id, last_name, first_name);

CREATE TABLE IF NOT EXISTS procedure_codes (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  code TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('diagnostic','preventive','restorative','endodontics','periodontics','prosthodontics','oral_surgery','orthodontics','implants','adjunctive')),
  fee INTEGER NOT NULL DEFAULT 0,
  requires_tooth INTEGER NOT NULL DEFAULT 0,
  requires_surface INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (practice_id, code)
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  operatory_id INTEGER REFERENCES operatories(id),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','confirmed','checked_in','in_chair','completed','cancelled','no_show')),
  reason TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_time ON appointments(practice_id, start_time);

CREATE TABLE IF NOT EXISTS tooth_conditions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  tooth TEXT NOT NULL,
  surfaces TEXT,
  condition TEXT NOT NULL,
  notes TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS perio_exams (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  provider_id INTEGER REFERENCES providers(id),
  exam_date TEXT NOT NULL,
  readings TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS treatment_plans (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected','completed')),
  notes TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS procedures (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  treatment_plan_id INTEGER REFERENCES treatment_plans(id),
  appointment_id INTEGER REFERENCES appointments(id),
  provider_id INTEGER REFERENCES providers(id),
  code_id INTEGER NOT NULL REFERENCES procedure_codes(id),
  code TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  tooth TEXT,
  surfaces TEXT,
  fee INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','completed','cancelled')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proc_patient ON procedures(practice_id, patient_id);

CREATE TABLE IF NOT EXISTS clinical_notes (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  appointment_id INTEGER REFERENCES appointments(id),
  provider_id INTEGER REFERENCES providers(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  signed INTEGER NOT NULL DEFAULT 0,
  signed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS insurance_carriers (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  payer_id TEXT,
  phone TEXT,
  address TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS patient_insurance (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  carrier_id INTEGER NOT NULL REFERENCES insurance_carriers(id),
  priority TEXT NOT NULL DEFAULT 'primary' CHECK (priority IN ('primary','secondary')),
  subscriber_name TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  subscriber_dob TEXT,
  relationship TEXT NOT NULL DEFAULT 'self',
  group_number TEXT,
  annual_max INTEGER NOT NULL DEFAULT 150000,
  deductible INTEGER NOT NULL DEFAULT 5000,
  deductible_met INTEGER NOT NULL DEFAULT 0,
  pct_preventive INTEGER NOT NULL DEFAULT 100,
  pct_basic INTEGER NOT NULL DEFAULT 80,
  pct_major INTEGER NOT NULL DEFAULT 50,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  patient_insurance_id INTEGER NOT NULL REFERENCES patient_insurance(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','paid','partially_paid','denied','void')),
  total_fee INTEGER NOT NULL DEFAULT 0,
  estimated_amount INTEGER NOT NULL DEFAULT 0,
  deductible_applied INTEGER NOT NULL DEFAULT 0,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  denial_reason TEXT,
  submitted_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS claim_items (
  id INTEGER PRIMARY KEY,
  claim_id INTEGER NOT NULL REFERENCES claims(id),
  procedure_id INTEGER NOT NULL REFERENCES procedures(id),
  fee INTEGER NOT NULL,
  estimated_amount INTEGER NOT NULL DEFAULT 0,
  UNIQUE (claim_id, procedure_id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  type TEXT NOT NULL CHECK (type IN ('charge','payment','insurance_payment','adjustment','refund')),
  amount INTEGER NOT NULL,
  description TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  procedure_id INTEGER REFERENCES procedures(id),
  claim_id INTEGER REFERENCES claims(id),
  provider_id INTEGER REFERENCES providers(id),
  entry_date TEXT NOT NULL DEFAULT (date('now')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_patient ON ledger_entries(practice_id, patient_id);

CREATE TABLE IF NOT EXISTS recalls (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  type TEXT NOT NULL DEFAULT 'prophy',
  interval_months INTEGER NOT NULL DEFAULT 6,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','scheduled','contacted','completed','inactive')),
  last_contacted_at TEXT,
  notes TEXT,
  UNIQUE (practice_id, patient_id, type)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit ON audit_log(practice_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER REFERENCES patients(id),
  appointment_id INTEGER REFERENCES appointments(id),
  channel TEXT NOT NULL CHECK (channel IN ('sms','email')),
  kind TEXT NOT NULL DEFAULT 'custom',
  to_address TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  provider_id TEXT,
  error TEXT,
  created_by INTEGER REFERENCES users(id),
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_patient ON messages(practice_id, patient_id);

CREATE TABLE IF NOT EXISTS booking_requests (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  dob TEXT,
  phone TEXT,
  email TEXT,
  reason TEXT,
  provider_id INTEGER REFERENCES providers(id),
  requested_start TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 60,
  new_patient INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  patient_id INTEGER REFERENCES patients(id),
  appointment_id INTEGER REFERENCES appointments(id),
  handled_by INTEGER REFERENCES users(id),
  handled_at TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS form_requests (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  kind TEXT NOT NULL DEFAULT 'medical_history',
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','expired')),
  expires_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS patient_forms (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  request_id INTEGER REFERENCES form_requests(id),
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  signature_name TEXT NOT NULL,
  signature_image TEXT,
  signed_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  category TEXT NOT NULL DEFAULT 'document' CHECK (category IN ('xray','photo','document','consent','insurance_card','referral','other')),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  tooth TEXT,
  notes TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_patient ON documents(practice_id, patient_id);

CREATE TABLE IF NOT EXISTS payment_requests (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  amount INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'stripe',
  session_id TEXT UNIQUE,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','cancelled')),
  ledger_entry_id INTEGER REFERENCES ledger_entries(id),
  created_by INTEGER REFERENCES users(id),
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointment_types (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 60,
  color TEXT NOT NULL DEFAULT '#0ea5e9',
  procedure_codes TEXT,
  provider_type TEXT,
  online_bookable INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blockouts (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  provider_id INTEGER REFERENCES providers(id),
  operatory_id INTEGER REFERENCES operatories(id),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_blockouts_time ON blockouts(practice_id, start_time);

CREATE TABLE IF NOT EXISTS payment_plans (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  total INTEGER NOT NULL,
  down_payment INTEGER NOT NULL DEFAULT 0,
  installment_amount INTEGER NOT NULL,
  installments INTEGER NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly','biweekly','monthly')),
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS eligibility_checks (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  patient_insurance_id INTEGER NOT NULL REFERENCES patient_insurance(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','inactive','error')),
  request_x12 TEXT,
  response_x12 TEXT,
  summary TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS era_imports (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  filename TEXT,
  payer_name TEXT,
  check_number TEXT,
  payment_date TEXT,
  total_paid INTEGER NOT NULL DEFAULT 0,
  claims_matched INTEGER NOT NULL DEFAULT 0,
  claims_unmatched INTEGER NOT NULL DEFAULT 0,
  details TEXT,
  raw TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lab_cases (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  provider_id INTEGER REFERENCES providers(id),
  appointment_id INTEGER REFERENCES appointments(id),
  lab_name TEXT NOT NULL,
  description TEXT NOT NULL,
  tooth TEXT,
  shade TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','received','returned_for_adjustment','delivered','cancelled')),
  sent_date TEXT,
  due_date TEXT,
  received_date TEXT,
  cost INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fee_schedules (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS fee_schedule_items (
  fee_schedule_id INTEGER NOT NULL REFERENCES fee_schedules(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  fee INTEGER NOT NULL,
  PRIMARY KEY (fee_schedule_id, code)
);

CREATE TABLE IF NOT EXISTS preauths (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  patient_insurance_id INTEGER NOT NULL REFERENCES patient_insurance(id),
  treatment_plan_id INTEGER REFERENCES treatment_plans(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','denied')),
  procedure_ids TEXT NOT NULL,
  total_fee INTEGER NOT NULL,
  estimated_amount INTEGER NOT NULL DEFAULT 0,
  approved_amount INTEGER,
  payer_reference TEXT,
  notes TEXT,
  submitted_at TEXT,
  responded_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prescriptions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  drug TEXT NOT NULL,
  strength TEXT,
  sig TEXT NOT NULL,
  quantity TEXT NOT NULL,
  refills INTEGER NOT NULL DEFAULT 0,
  dispense_as_written INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_followups ON followups(practice_id, patient_id, kind);

CREATE TABLE IF NOT EXISTS statement_runs (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  accounts INTEGER NOT NULL,
  emailed INTEGER NOT NULL DEFAULT 0,
  printed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  patient_ids TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointment_series (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  every INTEGER NOT NULL DEFAULT 1,
  unit TEXT NOT NULL CHECK (unit IN ('week','month')),
  count INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS edi_batches (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  kind TEXT NOT NULL DEFAULT '837D',
  control TEXT NOT NULL,
  filename TEXT,
  claim_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'sent',
  transport TEXT,
  message TEXT,
  x12 TEXT,
  created_by INTEGER REFERENCES users(id),
  acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_edi_batch_control ON edi_batches(control);

CREATE TABLE IF NOT EXISTS edi_inbox (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER REFERENCES practices(id),
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  type TEXT,
  content TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS claim_events (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  claim_id INTEGER NOT NULL REFERENCES claims(id),
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claim_events ON claim_events(claim_id);

CREATE TABLE IF NOT EXISTS edi_sandbox_mailbox (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  available_at TEXT NOT NULL,
  picked_up_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bridge_agents (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  apps TEXT NOT NULL DEFAULT '[]',
  hostname TEXT,
  version TEXT,
  last_seen_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bridge_commands (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  agent_id INTEGER NOT NULL REFERENCES bridge_agents(id),
  patient_id INTEGER REFERENCES patients(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_by INTEGER REFERENCES users(id),
  delivered_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bridge_commands ON bridge_commands(agent_id, status);

CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  provider TEXT NOT NULL,
  customer_id TEXT,
  payment_method_id TEXT,
  brand TEXT,
  last4 TEXT,
  exp_month INTEGER,
  exp_year INTEGER,
  created_by INTEGER REFERENCES users(id),
  removed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS statement_deliveries (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  run_id INTEGER NOT NULL REFERENCES statement_runs(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  method TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reference TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portal_codes (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER REFERENCES patients(id),
  contact TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_portal_codes ON portal_codes(practice_id, contact);

CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sso_logins (
  id INTEGER PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER REFERENCES patients(id),
  assigned_to INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  notes TEXT,
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS, so check first.
const COLUMNS = [
  ['practices', 'slug', 'TEXT'],
  ['practices', 'online_booking', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'reminder_hours', 'INTEGER NOT NULL DEFAULT 48'],
  ['practices', 'require_mfa', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'mfa_secret', 'TEXT'],
  ['users', 'mfa_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'mfa_last_step', 'INTEGER'],
  ['patients', 'sms_opt_in', 'INTEGER NOT NULL DEFAULT 1'],
  ['patients', 'email_opt_in', 'INTEGER NOT NULL DEFAULT 1'],
  ['appointments', 'confirm_token_hash', 'TEXT'],
  ['appointments', 'reminder_sent_at', 'TEXT'],
  ['appointments', 'confirmed_at', 'TEXT'],
  ['appointments', 'appointment_type_id', 'INTEGER REFERENCES appointment_types(id)'],
  ['appointments', 'asap', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'office_hours', 'TEXT'],
  ['practices', 'daily_goal', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'sms_number', 'TEXT'],
  ['practices', 'billing_provider_taxonomy', "TEXT NOT NULL DEFAULT '1223G0001X'"],
  ['patients', 'guarantor_id', 'INTEGER REFERENCES patients(id)'],
  ['messages', 'direction', "TEXT NOT NULL DEFAULT 'outbound'"],
  ['messages', 'from_address', 'TEXT'],
  ['messages', 'read_at', 'TEXT'],
  ['ledger_entries', 'payment_plan_id', 'INTEGER REFERENCES payment_plans(id)'],
  ['claims', 'control_number', 'TEXT'],
  ['claims', 'payer_claim_number', 'TEXT'],
  ['insurance_carriers', 'electronic', 'INTEGER NOT NULL DEFAULT 1'],
  ['insurance_carriers', 'fee_schedule_id', 'INTEGER REFERENCES fee_schedules(id)'],
  ['patients', 'referral_source', 'TEXT'],
  ['patients', 'office_alert', 'TEXT'],
  ['patients', 'statement_sent_at', 'TEXT'],
  ['patients', 'medical_reviewed_at', 'TEXT'],
  ['practices', 'review_url', 'TEXT'],
  ['practices', 'review_requests', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'idle_timeout_minutes', 'INTEGER NOT NULL DEFAULT 15'],
  ['practices', 'message_templates', 'TEXT'],
  ['practices', 'hygiene_goal', 'INTEGER NOT NULL DEFAULT 0'],
  ['providers', 'dea_number', 'TEXT'],
  ['treatment_plans', 'signature_name', 'TEXT'],
  ['treatment_plans', 'signature_image', 'TEXT'],
  ['treatment_plans', 'signed_at', 'TEXT'],
  ['treatment_plans', 'sign_token_hash', 'TEXT'],
  ['treatment_plans', 'presented_at', 'TEXT'],
  ['appointments', 'review_sent_at', 'TEXT'],
  ['claim_items', 'write_off', 'INTEGER NOT NULL DEFAULT 0'],
  ['claims', 'write_off_estimate', 'INTEGER NOT NULL DEFAULT 0'],
  ['providers', 'working_hours', 'TEXT'],
  ['claims', 'ch_status', 'TEXT'],
  ['claims', 'ch_message', 'TEXT'],
  ['claims', 'ch_updated_at', 'TEXT'],
  ['claims', 'batch_id', 'INTEGER'],
  ['patients', 'preferred_pharmacy', 'TEXT'],
  ['providers', 'erx_user_id', 'TEXT'],
  ['prescriptions', 'schedule', 'TEXT'],
  ['prescriptions', 'status', "TEXT NOT NULL DEFAULT 'printed'"],
  ['prescriptions', 'pharmacy', 'TEXT'],
  ['prescriptions', 'erx_reference', 'TEXT'],
  ['prescriptions', 'erx_error', 'TEXT'],
  ['prescriptions', 'signed_by', 'INTEGER'],
  ['prescriptions', 'signed_two_factor', 'INTEGER NOT NULL DEFAULT 0'],
  ['prescriptions', 'transmitted_at', 'TEXT'],
  ['documents', 'source_hash', 'TEXT'],
  ['documents', 'source', 'TEXT'],
  ['documents', 'taken_at', 'TEXT'],
  ['patients', 'stripe_customer_id', 'TEXT'],
  ['payment_plans', 'autopay_method_id', 'INTEGER REFERENCES payment_methods(id)'],
  ['payment_plans', 'autopay_paused', 'INTEGER NOT NULL DEFAULT 0'],
  ['payment_plans', 'autopay_failures', 'INTEGER NOT NULL DEFAULT 0'],
  ['payment_plans', 'autopay_last_attempt', 'TEXT'],
  ['payment_plans', 'autopay_message', 'TEXT'],
  ['payment_plans', 'autopay_lock', 'TEXT'],
  ['sso_logins', 'browser_hash', 'TEXT'],
  ['ledger_entries', 'voided_at', 'TEXT'],
  ['ledger_entries', 'voided_by', 'INTEGER'],
  ['ledger_entries', 'void_reason', 'TEXT'],
  ['ledger_entries', 'reverses_id', 'INTEGER'],
  ['ledger_entries', 'refund_of_id', 'INTEGER'],
  ['practices', 'lock_date', 'TEXT'],
  ['recalls', 'appointment_id', 'INTEGER'],
  ['patient_forms', 'review_status', 'TEXT'],
  ['treatment_plans', 'signed_snapshot', 'TEXT'],
  ['clinical_notes', 'signed_by', 'INTEGER'],
  ['tooth_conditions', 'procedure_id', 'INTEGER'],
  ['users', 'token_version', 'INTEGER NOT NULL DEFAULT 0'],
  ['appointments', 'reminder_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'failed_logins', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'locked_until', 'TEXT'],
  ['clinical_notes', 'addendum_of', 'INTEGER'],
  ['treatment_plans', 'sign_token_expires_at', 'TEXT'],
  ['patient_forms', 'reviewed_by', 'INTEGER'],
  ['patient_forms', 'reviewed_at', 'TEXT'],
  ['patient_insurance', 'benefit_month', 'INTEGER NOT NULL DEFAULT 1'],
  ['patient_insurance', 'deductible_year', 'TEXT'],
  ['sso_logins', 'user_id', 'INTEGER'],
  ['statement_runs', 'mailed', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'portal_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  ['practices', 'sso_provider', 'TEXT'],
  ['practices', 'sso_tenant', 'TEXT'],
  ['practices', 'sso_issuer', 'TEXT'],
  ['practices', 'sso_client_id', 'TEXT'],
  ['practices', 'sso_client_secret', 'TEXT'],
  ['practices', 'sso_domain', 'TEXT'],
  ['practices', 'sso_only', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'sso_subject', 'TEXT'],
  ['appointments', 'series_id', 'INTEGER REFERENCES appointment_series(id)'],
];

const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_practice_slug ON practices(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_token ON appointments(confirm_token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_ci ON users(lower(email));
`;

// ---------------------------------------------------------------------------
// Drivers. Route code uses one small async API on either database:
//   await db.get(sql, ...params)  -> first row or undefined
//   await db.all(sql, ...params)  -> rows
//   await db.run(sql, ...params)  -> { changes, id }
//   await db.tx(async () => ...)  -> runs the callback in a transaction
// SQL is written for SQLite; the Postgres driver translates the few differences.

// Tables whose primary key is an integer "id" (INSERTs return it).
const ID_TABLES = new Set([...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(\s*id INTEGER PRIMARY KEY/g)].map((m) => m[1]));

export async function openDb(target = process.env.DATABASE_URL || process.env.DATABASE_PATH || './data/dentalmachine.db') {
  if (target === ':memory:' && process.env.TEST_DATABASE_URL) return openPostgres(process.env.TEST_DATABASE_URL, { freshSchema: true });
  if (/^postgres(ql)?:\/\//.test(target)) return openPostgres(target);
  return openSqlite(target);
}

// ---- SQLite (node:sqlite) ----
function openSqlite(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  for (const [table, column, def] of COLUMNS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
  db.exec(INDEXES);

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const args = (params) => params.map((v) => (typeof v === 'boolean' ? Number(v) : v));
  const clean = (row) => (row ? { ...row } : row);
  const inTx = new AsyncLocalStorage();
  let queue = Promise.resolve();
  let open = false;
  // A query from outside the open transaction waits for it to finish: on one connection it would
  // otherwise see the transaction's uncommitted writes, or have its own writes rolled back with it.
  const outside = async () => {
    while (open && !inTx.getStore()) await queue;
  };
  return {
    dialect: 'sqlite',
    async all(sql, ...params) {
      await outside();
      return stmt(sql).all(...args(params)).map(clean);
    },
    async get(sql, ...params) {
      await outside();
      return clean(stmt(sql).get(...args(params)));
    },
    async run(sql, ...params) {
      await outside();
      const r = stmt(sql).run(...args(params));
      return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
    },
    // One connection, so transactions are queued. Keep network calls out of transactions.
    tx(fn) {
      if (inTx.getStore()) return fn();
      const run = async () => {
        db.exec('BEGIN');
        open = true;
        try {
          const out = await inTx.run(true, fn);
          db.exec('COMMIT');
          return out;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        } finally {
          open = false;
        }
      };
      const p = queue.then(run, run);
      queue = p.catch(() => {});
      return p;
    },
    async close() {
      db.close();
    },
  };
}

// ---- PostgreSQL ----
// Columns stay TEXT/INTEGER like SQLite so date strings compare the same way.
const PG_NOW = "to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')";
const PG_TODAY = "to_char(timezone('UTC', now()), 'YYYY-MM-DD')";

export function toPostgres(sql) {
  let i = 0;
  let out = '';
  // Walk the SQL so '?' inside string literals is left alone.
  for (let k = 0; k < sql.length; k++) {
    const ch = sql[k];
    if (ch === "'") {
      const end = sql.indexOf("'", k + 1);
      out += sql.slice(k, end + 1);
      k = end;
    } else if (ch === '?') out += `$${++i}`;
    else out += ch;
  }
  return out
    .replace(/datetime\('now'\)/g, PG_NOW)
    .replace(/date\('now'\)/g, PG_TODAY)
    .replace(/GROUP_CONCAT\(/gi, 'string_agg(')
    .replace(/ LIKE /g, ' ILIKE ');
}

function pgSchema(sql) {
  return toPostgres(sql)
    .replace(/id INTEGER PRIMARY KEY/g, 'id SERIAL PRIMARY KEY')
    .replace(/ COLLATE NOCASE/g, '');
}

async function openPostgres(url, { freshSchema = false } = {}) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v) => Number(v)); // int8 (COUNT, SUM) -> number
  pg.types.setTypeParser(1700, (v) => Number(v)); // numeric -> number
  pg.types.setTypeParser(16, (v) => (v === 't' ? 1 : 0)); // boolean -> 1/0 like SQLite
  let schema = null;
  if (freshSchema) {
    schema = `t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_SIZE) || 10,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  const setup = await pool.connect();
  try {
    await setup.query('SELECT pg_advisory_lock(424242)'); // one server migrates at a time
    await setup.query(pgSchema(SCHEMA));
    for (const [table, column, def] of COLUMNS) await setup.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${pgSchema(def)}`);
    await setup.query(pgSchema(INDEXES));
  } finally {
    await setup.query('SELECT pg_advisory_unlock(424242)');
    setup.release();
  }

  const inTx = new AsyncLocalStorage();
  const translated = new Map();
  const query = (sql, params) => {
    let text = translated.get(sql);
    if (!text) translated.set(sql, (text = toPostgres(sql)));
    const client = inTx.getStore() || pool;
    return client.query(text, params.map((v) => (typeof v === 'boolean' ? Number(v) : v === undefined ? null : v)));
  };
  return {
    dialect: 'postgres',
    async all(sql, ...params) {
      return (await query(sql, params)).rows;
    },
    async get(sql, ...params) {
      return (await query(sql, params)).rows[0];
    },
    async run(sql, ...params) {
      const m = /^\s*INSERT INTO (\w+)/i.exec(sql);
      if (m && ID_TABLES.has(m[1]) && !/RETURNING/i.test(sql)) {
        const r = await query(`${sql} RETURNING id`, params);
        return { changes: r.rowCount, id: r.rows[0]?.id };
      }
      const r = await query(sql, params);
      return { changes: r.rowCount, id: undefined };
    },
    async tx(fn) {
      if (inTx.getStore()) return fn();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await inTx.run(client, fn);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      if (schema) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
