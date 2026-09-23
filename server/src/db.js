import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

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
  channel TEXT NOT NULL CHECK (channel IN ('sms','email','portal')),
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

-- Patients without an appointment who want one (or an earlier one), and when they can come.
-- Public API keys (only a hash is kept) and outbound webhook endpoints with their deliveries.
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER REFERENCES users(id),
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  secret TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  endpoint_id INTEGER NOT NULL REFERENCES webhook_endpoints(id),
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  last_error TEXT,
  next_attempt_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhook_state (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  key TEXT NOT NULL,
  value TEXT,
  UNIQUE (practice_id, key)
);
-- Practice-defined roles: a name and a set of permissions (see PERMISSION_CATALOG).
CREATE TABLE IF NOT EXISTS custom_roles (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Claim attachments and the control numbers that tie them to the claim (837 PWK).
CREATE TABLE IF NOT EXISTS claim_attachments (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  claim_id INTEGER NOT NULL REFERENCES claims(id),
  document_id INTEGER REFERENCES documents(id),
  report_type TEXT NOT NULL,
  narrative TEXT,
  transmission TEXT NOT NULL DEFAULT 'EL',
  control_number TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','accepted','rejected')),
  vendor_ref TEXT,
  error TEXT,
  sent_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Images arranged in a layout (FMX, bitewings): slot number → document.
CREATE TABLE IF NOT EXISTS image_mounts (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  template TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  slots TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Marketing campaigns to a segment of patients, and who each one went to.
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  segment TEXT NOT NULL,
  params TEXT,
  channel TEXT NOT NULL DEFAULT 'auto',
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','cancelled')),
  send_at TEXT,
  send_lock TEXT,
  started_at TEXT,
  finished_at TEXT,
  recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  channel TEXT NOT NULL,
  to_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  message_id INTEGER REFERENCES messages(id),
  unsubscribe_hash TEXT,
  unsubscribed_at TEXT,
  UNIQUE (campaign_id, channel, to_address)
);
-- After-visit "how did we do?" answers (review routing): happy patients go on to the public review page.
CREATE TABLE IF NOT EXISTS fee_history (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  fee_schedule_id INTEGER,
  code TEXT NOT NULL,
  old_fee INTEGER,
  new_fee INTEGER,
  changed_by INTEGER,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fee_history ON fee_history(practice_id, code);

-- Orthodontics: the treatment contract (billed monthly, optionally by card) and the adjustment log.
CREATE TABLE IF NOT EXISTS ortho_cases (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  provider_id INTEGER REFERENCES providers(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retention','completed','cancelled')),
  appliance TEXT NOT NULL DEFAULT 'brackets',
  start_date TEXT NOT NULL,
  est_months INTEGER,
  total_fee INTEGER NOT NULL,
  insurance_estimate INTEGER NOT NULL DEFAULT 0,
  down_payment INTEGER NOT NULL DEFAULT 0,
  months INTEGER NOT NULL,
  monthly_amount INTEGER NOT NULL,
  next_bill_date TEXT,
  billed_months INTEGER NOT NULL DEFAULT 0,
  payment_method_id INTEGER,
  autopay INTEGER NOT NULL DEFAULT 0,
  billing_failures INTEGER NOT NULL DEFAULT 0,
  billing_message TEXT,
  billing_lock TEXT,
  debond_date TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ortho_visits (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  case_id INTEGER NOT NULL REFERENCES ortho_cases(id),
  visit_date TEXT NOT NULL,
  upper_wire TEXT,
  lower_wire TEXT,
  elastics TEXT,
  aligner TEXT,
  notes TEXT,
  next_weeks INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Addresses that asked not to be contacted on a channel (STOP texts, email unsubscribes), even when
-- they don't match a patient. Every send checks this list and the patient's own preferences.
CREATE TABLE IF NOT EXISTS message_opt_outs (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  channel TEXT NOT NULL,
  address TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, channel, address)
);

-- Images from imaging bridges that couldn't be matched to a patient, waiting for someone to file them.
CREATE TABLE IF NOT EXISTS unfiled_images (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  agent_id INTEGER REFERENCES bridge_agents(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT,
  reason TEXT,
  claimed TEXT,
  opened_patient_id INTEGER,
  taken_at TEXT,
  modality TEXT,
  category TEXT,
  filed_at TEXT,
  discarded_at TEXT,
  filed_by INTEGER,
  document_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Short-lived links for adding photos or scans to a chart from a phone (shown as a QR code).
CREATE TABLE IF NOT EXISTS upload_links (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  token_hash TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'document',
  created_by INTEGER REFERENCES users(id),
  expires_at TEXT NOT NULL,
  uploads INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- New insurance sent in from the patient portal (with card photos), for the office to check and enter.
CREATE TABLE IF NOT EXISTS insurance_updates (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  carrier_name TEXT,
  member_id TEXT,
  group_number TEXT,
  subscriber_name TEXT,
  subscriber_dob TEXT,
  relationship TEXT,
  note TEXT,
  document_ids TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Late fees charged on payment-plan installments (one per installment at most).
CREATE TABLE IF NOT EXISTS payment_plan_late_fees (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES payment_plans(id),
  installment INTEGER NOT NULL,
  ledger_entry_id INTEGER REFERENCES ledger_entries(id),
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (plan_id, installment)
);

-- Card readers at the front desk (Stripe Terminal) and the in-person payments taken on them.
CREATE TABLE IF NOT EXISTS terminal_readers (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER,
  reader_id TEXT NOT NULL,
  label TEXT NOT NULL,
  device_type TEXT,
  serial_number TEXT,
  removed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, reader_id)
);
CREATE TABLE IF NOT EXISTS terminal_payments (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  reader_id INTEGER NOT NULL REFERENCES terminal_readers(id),
  intent_id TEXT,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  ledger_entry_id INTEGER REFERENCES ledger_entries(id),
  receipt TEXT,
  presented INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_terminal_payments_intent ON terminal_payments(intent_id);

-- Saved custom queries from the report builder (a JSON description, never SQL).
CREATE TABLE IF NOT EXISTS custom_queries (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Supplies: what's on the shelf, every change to it, and what each procedure uses up.
CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER,
  name TEXT NOT NULL,
  sku TEXT,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'each',
  on_hand INTEGER NOT NULL DEFAULT 0,
  reorder_at INTEGER NOT NULL DEFAULT 0,
  reorder_qty INTEGER NOT NULL DEFAULT 0,
  supplier TEXT,
  cost INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inventory_moves (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  change INTEGER NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  procedure_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inventory_moves ON inventory_moves(item_id, id);
CREATE TABLE IF NOT EXISTS inventory_usage (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  code TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  qty INTEGER NOT NULL DEFAULT 1
);

-- Time clock: staff punch in and out; managers fix punches and export hours for payroll.
CREATE TABLE IF NOT EXISTS time_punches (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  location_id INTEGER,
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  edited_by INTEGER,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_time_punches ON time_punches(practice_id, user_id, clock_in);

-- Patient surveys (NPS and other questions), sent after visits or to a list; one response row per patient asked.
CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  questions TEXT NOT NULL,
  auto_after_visit INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS survey_responses (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  survey_id INTEGER NOT NULL REFERENCES surveys(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  appointment_id INTEGER,
  token_hash TEXT NOT NULL,
  answers TEXT,
  nps INTEGER,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_survey_responses ON survey_responses(survey_id, answered_at);

-- Saved reports, optionally emailed on a schedule (the owner's Monday-morning numbers).
CREATE TABLE IF NOT EXISTS saved_reports (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  report TEXT NOT NULL,
  params TEXT,
  schedule TEXT CHECK (schedule IS NULL OR schedule IN ('daily','weekly','monthly')),
  recipients TEXT,
  last_sent_at TEXT,
  last_sent_for TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Day and month closes: the totals when the books were closed (the lock date moves up to the period end).
CREATE TABLE IF NOT EXISTS period_closes (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  period_type TEXT NOT NULL CHECK (period_type IN ('day','month')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  totals TEXT NOT NULL,
  closed_by INTEGER,
  closed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bank deposits: the checks and cash (or card batches) taken to the bank together, and the bank's figure for reconciling.
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER,
  deposit_date TEXT NOT NULL,
  total INTEGER NOT NULL,
  reference TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reconciled','discrepancy')),
  bank_amount INTEGER,
  bank_date TEXT,
  reconciled_by INTEGER,
  reconciled_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Collections: letters, finance charges, agency referrals and bad-debt write-offs on an account (the guarantor).
CREATE TABLE IF NOT EXISTS collection_actions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  action TEXT NOT NULL,
  amount INTEGER,
  note TEXT,
  message_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_collection_actions ON collection_actions(practice_id, patient_id);

-- Offices of a multi-location practice. A practice with none works as one office.
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  phone TEXT,
  npi TEXT,
  office_hours TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS review_feedback (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  appointment_id INTEGER REFERENCES appointments(id),
  token_hash TEXT NOT NULL UNIQUE,
  rating INTEGER,
  comment TEXT,
  went_to_review INTEGER NOT NULL DEFAULT 0,
  task_id INTEGER,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT
);
-- In-house membership plans and the patients enrolled in them.
CREATE TABLE IF NOT EXISTS membership_plans (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  interval TEXT NOT NULL DEFAULT 'month' CHECK (interval IN ('month','year')),
  discount_pct INTEGER NOT NULL DEFAULT 0,
  included TEXT NOT NULL DEFAULT '[]',
  min_age INTEGER,
  max_age INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  plan_id INTEGER NOT NULL REFERENCES membership_plans(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','past_due','cancelled')),
  start_date TEXT NOT NULL,
  next_bill_date TEXT NOT NULL,
  paid_through TEXT,
  payment_method_id INTEGER REFERENCES payment_methods(id),
  autopay INTEGER NOT NULL DEFAULT 1,
  billing_failures INTEGER NOT NULL DEFAULT 0,
  billing_message TEXT,
  billing_lock TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Practice-defined forms (consents, policies, intake): a list of fields, versioned when edited.
CREATE TABLE IF NOT EXISTS form_templates (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'consent',
  description TEXT,
  fields TEXT NOT NULL,
  procedure_codes TEXT,
  auto_send INTEGER NOT NULL DEFAULT 0,
  renew_months INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Data conversion from another practice system: one batch per imported file.
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT,
  mapping TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','undone')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  errors TEXT,
  pending TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
-- What each imported record was called in the old system, so a re-import updates instead of duplicating.
CREATE TABLE IF NOT EXISTS external_ids (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  batch_id INTEGER REFERENCES import_batches(id),
  created INTEGER NOT NULL DEFAULT 0,
  UNIQUE (practice_id, source, kind, external_id)
);

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  reason TEXT,
  duration INTEGER NOT NULL DEFAULT 60,
  provider_id INTEGER REFERENCES providers(id),
  days TEXT,
  times TEXT NOT NULL DEFAULT 'any',
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','booked','removed')),
  last_offered_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Inbox state per conversation ('p<patient id>' or 'n<10-digit number>'): who's handling it, and archiving.
CREATE TABLE IF NOT EXISTS conversation_state (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  thread TEXT NOT NULL,
  assigned_to INTEGER REFERENCES users(id),
  archived_at TEXT,
  UNIQUE (practice_id, thread)
);

-- Referral sources and destinations: other dentists and specialists, and people who send patients.
CREATE TABLE IF NOT EXISTS referral_contacts (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  practice_name TEXT,
  specialty TEXT,
  phone TEXT,
  fax TEXT,
  email TEXT,
  address TEXT,
  npi TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- A patient referred in (by a contact) or out (to a specialist), and where it stands.
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  contact_id INTEGER NOT NULL REFERENCES referral_contacts(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  referral_date TEXT NOT NULL,
  reason TEXT,
  teeth TEXT,
  urgency TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','scheduled','seen','report_received','closed')),
  provider_id INTEGER REFERENCES providers(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Recall types (prophy, perio maintenance, bitewings…): which codes reset them and how often they come due.
CREATE TABLE IF NOT EXISTS recall_types (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  interval_months INTEGER NOT NULL DEFAULT 6,
  codes TEXT NOT NULL DEFAULT '[]',
  appointment_type_id INTEGER REFERENCES appointment_types(id),
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (practice_id, key)
);

-- Each automated recall message sent (one per recall per sequence step).
CREATE TABLE IF NOT EXISTS recall_contacts (
  id INTEGER PRIMARY KEY,
  recall_id INTEGER NOT NULL REFERENCES recalls(id),
  step INTEGER NOT NULL,
  message_id INTEGER,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (recall_id, step)
);

-- Each appointment reminder step sent (e.g. 2 weeks, 2 days, same day).
CREATE TABLE IF NOT EXISTS appointment_reminders (
  id INTEGER PRIMARY KEY,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  step INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  attempts INTEGER NOT NULL DEFAULT 1,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (appointment_id, step)
);

-- Note templates: text with merge fields ({tooth}, {code}...) and prompts ([[Anesthetic: Lidocaine|Articaine]]),
-- offered when the listed procedures are completed.
CREATE TABLE IF NOT EXISTS note_templates (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  codes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vitals (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  bp_systolic INTEGER,
  bp_diastolic INTEGER,
  pulse INTEGER,
  notes TEXT,
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS labs (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  turnaround_days INTEGER,
  account_number TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- One insurance check or EFT and the claims it paid (from an ERA, or posted by hand from a paper EOB).
CREATE TABLE IF NOT EXISTS insurance_checks (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  carrier_id INTEGER REFERENCES insurance_carriers(id),
  payer_name TEXT,
  check_number TEXT,
  check_date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'check',
  provider_adjustments TEXT,
  era_import_id INTEGER,
  deposit_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Kinds of ledger adjustment (courtesy discount, bad debt, NSF fee...), for reporting and approval.
CREATE TABLE IF NOT EXISTS adjustment_types (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'credit' CHECK (direction IN ('credit','debit')),
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (practice_id, name)
);

-- An employer group's dental coverage, shared by everyone enrolled in it.
CREATE TABLE IF NOT EXISTS insurance_plans (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  carrier_id INTEGER NOT NULL REFERENCES insurance_carriers(id),
  name TEXT,
  group_number TEXT,
  annual_max INTEGER NOT NULL DEFAULT 150000,
  deductible INTEGER NOT NULL DEFAULT 5000,
  family_deductible INTEGER NOT NULL DEFAULT 0,
  pct_preventive INTEGER NOT NULL DEFAULT 100,
  pct_basic INTEGER NOT NULL DEFAULT 80,
  pct_major INTEGER NOT NULL DEFAULT 50,
  benefit_month INTEGER NOT NULL DEFAULT 1,
  ortho_max INTEGER NOT NULL DEFAULT 0,
  ortho_pct INTEGER NOT NULL DEFAULT 50,
  ortho_age_limit INTEGER,
  wait_basic_months INTEGER NOT NULL DEFAULT 0,
  wait_major_months INTEGER NOT NULL DEFAULT 0,
  downgrade_composites INTEGER NOT NULL DEFAULT 0,
  frequencies TEXT,
  coverage_overrides TEXT,
  fee_schedule_id INTEGER,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-off changes to a provider schedule: a day off, vacation, or different hours on a date.
CREATE TABLE IF NOT EXISTS provider_exceptions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  date TEXT NOT NULL,
  hours TEXT NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider_id, date)
);

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
  ['patient_insurance', 'plan_id', 'INTEGER'],
  ['claim_items', 'paid_amount', 'INTEGER NOT NULL DEFAULT 0'],
  ['claim_items', 'adjusted_amount', 'INTEGER NOT NULL DEFAULT 0'],
  ['claim_items', 'patient_resp', 'INTEGER NOT NULL DEFAULT 0'],
  ['claim_items', 'allowed_amount', 'INTEGER'],
  ['claim_items', 'adjustments', 'TEXT'],
  ['claims', 'primary_claim_id', 'INTEGER'],
  ['claims', 'frequency_code', "TEXT NOT NULL DEFAULT '1'"],
  ['claims', 'original_reference', 'TEXT'],
  ['claims', 'corrected_from_id', 'INTEGER'],
  ['claims', 'preauth_number', 'TEXT'],
  ['claims', 'paid_date', 'TEXT'],
  ['ledger_entries', 'adjustment_type', 'TEXT'],
  ['ledger_entries', 'insurance_check_id', 'INTEGER'],
  ['ledger_entries', 'transfer_id', 'TEXT'],
  ['practices', 'adjustment_approval_limit', 'INTEGER'],
  ['preauths', 'expires_at', 'TEXT'],
  ['preauths', 'reference_number', 'TEXT'],
  ['era_imports', 'provider_adjustments', 'TEXT'],
  ['tooth_conditions', 'resolved_at', 'TEXT'],
  ['practices', 'reminder_steps', 'TEXT'],
  ['practices', 'custom_fields', 'TEXT'],
  ['patients', 'custom', 'TEXT'],
  ['ledger_entries', 'membership_id', 'INTEGER REFERENCES memberships(id)'],
  ['practices', 'review_threshold', 'INTEGER NOT NULL DEFAULT 4'],
  ['practices', 'instant_booking', 'INTEGER NOT NULL DEFAULT 0'],
  ['documents', 'annotations', 'TEXT'],
  ['blockouts', 'kind', "TEXT NOT NULL DEFAULT 'blocked'"],
  ['blockouts', 'appointment_type_ids', 'TEXT'],
  ['providers', 'daily_goal', 'INTEGER'],
  ['booking_requests', 'language', 'TEXT'],
  ['appointment_types', 'name_es', 'TEXT'],
  ['operatories', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['appointments', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['ledger_entries', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['booking_requests', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['users', 'location_ids', 'TEXT'],
  ['fee_schedules', 'kind', "TEXT NOT NULL DEFAULT 'ppo'"],
  ['patients', 'fee_schedule_id', 'INTEGER REFERENCES fee_schedules(id)'],
  ['providers', 'fee_schedule_id', 'INTEGER REFERENCES fee_schedules(id)'],
  ['locations', 'fee_schedule_id', 'INTEGER REFERENCES fee_schedules(id)'],
  ['patients', 'collection_status', 'TEXT'],
  ['practices', 'finance_charge_bps', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'finance_charge_min', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'late_fee', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'collection_agency', 'TEXT'],
  ['practices', 'eligibility_batch_date', 'TEXT'],
  ['ledger_entries', 'deposit_id', 'INTEGER REFERENCES deposits(id)'],
  ['appointments', 'video_url', 'TEXT'],
  ['ledger_entries', 'ortho_case_id', 'INTEGER REFERENCES ortho_cases(id)'],
  ['bridge_agents', 'sensor', 'TEXT'],
  ['claims', 'remarks', 'TEXT'],
  ['booking_requests', 'referral_source', 'TEXT'],
  ['patients', 'family_relationship', 'TEXT'],
  ['practices', 'financing', 'TEXT'],
  ['practices', 'auto_receipts', 'INTEGER NOT NULL DEFAULT 1'],
  ['practices', 'kpi_targets', 'TEXT'],
  ['practices', 'setup_status', "TEXT NOT NULL DEFAULT 'done'"],
  ['practices', 'setup_fees_reviewed', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'stripe_terminal_location', 'TEXT'],
  ['payment_plans', 'schedule', 'TEXT'],
  ['claims', 'follow_up_date', 'TEXT'],
  ['claims', 'last_call_at', 'TEXT'],
  ['claims', 'last_call_outcome', 'TEXT'],
  ['payment_plans', 'late_fee', 'INTEGER NOT NULL DEFAULT 0'],
  ['payment_plans', 'late_fee_days', 'INTEGER NOT NULL DEFAULT 10'],
  ['documents', 'tags', 'TEXT'],
  ['patients', 'second_responsible_id', 'INTEGER REFERENCES patients(id)'],
  ['appointment_types', 'pattern', 'TEXT'],
  ['appointment_types', 'provider_durations', 'TEXT'],
  ['appointments', 'pattern', 'TEXT'],
  ['claim_events', 'details', 'TEXT'],
  ['claim_events', 'user_id', 'INTEGER'],
  ['documents', 'thumb_key', 'TEXT'],
  ['documents', 'thumb_mime', 'TEXT'],
  ['documents', 'thumb_encrypted', 'INTEGER NOT NULL DEFAULT 0'],
  ['appointment_types', 'is_video', 'INTEGER NOT NULL DEFAULT 0'],
  ['providers', 'video_room_url', 'TEXT'],
  ['users', 'custom_role_id', 'INTEGER REFERENCES custom_roles(id)'],
  ['users', 'permissions_add', 'TEXT'],
  ['users', 'permissions_remove', 'TEXT'],
  ['documents', 'mm_per_px', 'REAL'],
  ['appointment_types', 'deposit', 'INTEGER NOT NULL DEFAULT 0'],
  ['booking_requests', 'insurance_carrier', 'TEXT'],
  ['booking_requests', 'insurance_member_id', 'TEXT'],
  ['booking_requests', 'insurance_subscriber', 'TEXT'],
  ['booking_requests', 'deposit_amount', 'INTEGER'],
  ['booking_requests', 'deposit_status', 'TEXT'],
  ['booking_requests', 'deposit_session_id', 'TEXT'],
  ['booking_requests', 'deposit_reference', 'TEXT'],
  ['booking_requests', 'deposit_entry_id', 'INTEGER REFERENCES ledger_entries(id)'],
  ['booking_requests', 'hold_until', 'TEXT'],
  ['form_requests', 'template_id', 'INTEGER REFERENCES form_templates(id)'],
  ['form_requests', 'appointment_id', 'INTEGER REFERENCES appointments(id)'],
  ['form_requests', 'packet_id', 'INTEGER'],
  ['form_requests', 'context', 'TEXT'],
  ['patient_forms', 'template_id', 'INTEGER REFERENCES form_templates(id)'],
  ['patient_forms', 'template_version', 'INTEGER'],
  ['patient_forms', 'fields', 'TEXT'],
  ['patient_forms', 'document_id', 'INTEGER REFERENCES documents(id)'],
  ['appointment_series', 'monthly_by', 'TEXT'],
  ['appointment_series', 'until_date', 'TEXT'],
  ['blockouts', 'series_key', 'TEXT'],
  ['operatories', 'default_provider_id', 'INTEGER'],
  ['operatories', 'is_hygiene', 'INTEGER NOT NULL DEFAULT 0'],
  ['operatories', 'sort', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'quick_replies', 'TEXT'],
  ['patients', 'phone_home', 'TEXT'],
  ['patients', 'phone_work', 'TEXT'],
  ['patients', 'preferred_contact', 'TEXT'],
  ['patients', 'language', 'TEXT'],
  ['patients', 'primary_hygienist_id', 'INTEGER'],
  ['patients', 'photo', 'TEXT'],
  ['patients', 'referred_by_id', 'INTEGER'],
  ['practices', 'recall_steps', 'TEXT'],
  ['practices', 'recall_auto', 'INTEGER NOT NULL DEFAULT 0'],
  ['appointments', 'arrived_at', 'TEXT'],
  ['appointments', 'seated_at', 'TEXT'],
  ['appointments', 'dismissed_at', 'TEXT'],
  ['appointments', 'confirmed_via', 'TEXT'],
  ['appointments', 'checked_out_at', 'TEXT'],
  ['appointments', 'checked_out_by', 'INTEGER'],
  ['practices', 'templates_seeded', 'INTEGER NOT NULL DEFAULT 0'],
  ['patients', 'medical_conditions', 'TEXT'],
  ['procedure_codes', 'area', 'TEXT'],
  ['procedure_codes', 'time_units', 'INTEGER'],
  ['procedures', 'area', 'TEXT'],
  ['procedures', 'phase', 'INTEGER NOT NULL DEFAULT 1'],
  ['treatment_plans', 'option_group', 'TEXT'],
  ['treatment_plans', 'option_label', 'TEXT'],
  ['treatment_plans', 'discount_pct', 'INTEGER NOT NULL DEFAULT 0'],
  ['patients', 'asa_class', 'TEXT'],
  ['patients', 'premed_required', 'INTEGER NOT NULL DEFAULT 0'],
  ['lab_cases', 'lab_id', 'INTEGER'],
  ['lab_cases', 'procedure_id', 'INTEGER'],
  ['patient_insurance', 'effective_date', 'TEXT'],
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

// CHECK constraints widened after release: [table, constraint name on Postgres, old text, new text].
const RELAXED = [
  ['messages', 'messages_channel_check', "CHECK (channel IN ('sms','email'))", "CHECK (channel IN ('sms','email','portal'))"],
  ['messages', 'messages_status_check', "CHECK (status IN ('queued','sent','failed'))", "CHECK (status IN ('queued','sent','failed','blocked'))"],
];

const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_practice_slug ON practices(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_token ON appointments(confirm_token_hash);
CREATE INDEX IF NOT EXISTS idx_campaign_unsub ON campaign_recipients(unsubscribe_hash);
CREATE INDEX IF NOT EXISTS idx_webhook_due ON webhook_deliveries(status, next_attempt_at);
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

// Every table and column, and which columns point at which table — read from the schema itself so
// patient merge and backup restore always cover new tables. Columns named <table>_id without a
// declared reference (added later as plain INTEGERs) are matched to their table by name.
export function schemaInfo() {
  const tables = new Map();
  for (const m of SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    const cols = [];
    for (const line of m[2].split('\n')) {
      const c = /^\s+(\w+)\s+(INTEGER|TEXT|REAL|BLOB)\b(.*)$/.exec(line);
      if (!c || ['UNIQUE', 'PRIMARY', 'FOREIGN', 'CHECK'].includes(c[1])) continue;
      const ref = /REFERENCES (\w+)\(id\)/.exec(c[3]);
      cols.push({ name: c[1], type: c[2], ref: ref ? ref[1] : null, notnull: /^[^,]*NOT NULL/.test(c[3]) });
      // "email TEXT, phone TEXT" style lines declare several columns.
      for (const extra of c[3].matchAll(/,\s*(\w+)\s+(INTEGER|TEXT|REAL)/g)) cols.push({ name: extra[1], type: extra[2], ref: null, notnull: false });
    }
    tables.set(m[1], cols);
  }
  for (const [table, column, def] of COLUMNS) {
    const ref = /REFERENCES (\w+)\(id\)/.exec(def);
    if (tables.has(table) && !tables.get(table).some((c) => c.name === column)) tables.get(table).push({ name: column, type: def.split(' ')[0], ref: ref ? ref[1] : null, notnull: /NOT NULL/.test(def) });
  }
  const aliases = { guarantor_id: 'patients', referred_by_id: 'referral_contacts', primary_provider_id: 'providers', primary_hygienist_id: 'providers', default_provider_id: 'providers', created_by: 'users', handled_by: 'users', recorded_by: 'users', reviewed_by: 'users', signed_by: 'users', voided_by: 'users', checked_out_by: 'users', assigned_to: 'users', author_id: 'users',
    addendum_of: 'clinical_notes', plan_id: 'insurance_plans', batch_id: 'edi_batches', primary_claim_id: 'claims', corrected_from_id: 'claims', reverses_id: 'ledger_entries', refund_of_id: 'ledger_entries', packet_id: 'form_requests' };
  for (const [table, cols] of tables) {
    for (const c of cols) {
      if (c.ref || c.name === 'id' || c.type !== 'INTEGER') continue; // text IDs belong to outside services (Twilio, Stripe)
      if (aliases[c.name]) c.ref = aliases[c.name];
      else {
        const base = c.name.replace(/_id$/, '');
        if (base !== c.name && tables.has(`${base}s`)) c.ref = `${base}s`;
      }
    }
  }
  return tables;
}

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
  // SQLite can't alter a CHECK; a wider one is swapped into the stored table definition (safe: existing rows still pass).
  for (const [table, , from, to] of RELAXED) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql;
    if (!sql?.includes(from)) continue;
    const version = db.prepare('PRAGMA schema_version').get().schema_version;
    db.exec('PRAGMA writable_schema = ON');
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?").run(sql.replace(from, to), table);
    db.exec(`PRAGMA schema_version = ${version + 1}`);
    db.exec('PRAGMA writable_schema = OFF');
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
    // A consistent copy of the whole database file (for automatic backups).
    async snapshot(path) {
      await outside();
      db.exec(`VACUUM INTO '${String(path).replace(/'/g, "''")}'`);
    },
    // Inside a transaction: undo just this part if it fails, and keep the transaction going.
    async savepoint(fn) {
      if (!inTx.getStore()) return fn();
      db.exec('SAVEPOINT sp');
      try {
        const out = await fn();
        db.exec('RELEASE sp');
        return out;
      } catch (err) {
        db.exec('ROLLBACK TO sp');
        db.exec('RELEASE sp');
        throw err;
      }
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
    if (ch === '-' && sql[k + 1] === '-') {
      // Line comments are copied as they are (an apostrophe in one isn't a string).
      const eol = sql.indexOf('\n', k);
      out += eol === -1 ? sql.slice(k) : sql.slice(k, eol);
      if (eol === -1) break;
      k = eol - 1;
    } else if (ch === "'") {
      const end = sql.indexOf("'", k + 1);
      // An unterminated string runs to the end instead of looping forever.
      if (end === -1) {
        out += sql.slice(k);
        break;
      }
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
  // Skip the migration when this exact schema is already in place (serverless cold starts would
  // otherwise re-run hundreds of statements each time).
  const version = createHash('sha256').update(JSON.stringify([SCHEMA, COLUMNS, INDEXES, RELAXED])).digest('hex').slice(0, 16);
  const current = await setup.query('SELECT version FROM schema_meta').then((r) => r.rows[0]?.version, () => null);
  if (current === version && !freshSchema) setup.release();
  else {
    // One server migrates at a time. The lock is transaction-scoped so it also works behind a
    // transaction-mode connection pooler (Supabase/PgBouncer), where session locks can leak.
    try {
      await setup.query('BEGIN');
      await setup.query('SELECT pg_advisory_xact_lock(424242)');
      await setup.query(pgSchema(SCHEMA));
      for (const [table, column, def] of COLUMNS) await setup.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${pgSchema(def)}`);
      for (const [table, name, , to] of RELAXED) await setup.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}; ALTER TABLE ${table} ADD CONSTRAINT ${name} ${to}`);
      await setup.query(pgSchema(INDEXES));
      await setup.query('CREATE TABLE IF NOT EXISTS schema_meta (version TEXT NOT NULL)');
      await setup.query('DELETE FROM schema_meta');
      await setup.query('INSERT INTO schema_meta (version) VALUES ($1)', [version]);
      await setup.query('COMMIT');
    } catch (err) {
      await setup.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      setup.release();
    }
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
    async savepoint(fn) {
      const client = inTx.getStore();
      if (!client) return fn();
      await client.query('SAVEPOINT sp');
      try {
        const out = await fn();
        await client.query('RELEASE SAVEPOINT sp');
        return out;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT sp');
        await client.query('RELEASE SAVEPOINT sp');
        throw err;
      }
    },
    async close() {
      if (schema) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
