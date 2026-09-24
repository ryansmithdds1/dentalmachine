import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { runMigrations } from './migrations.js';

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

-- Links in appointment messages. One link can cover several visits (a family's, on one day), and an
-- appointment keeps every link it was sent, so an older reminder still works.
CREATE TABLE IF NOT EXISTS confirm_links (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  token_hash TEXT NOT NULL,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  recipient_id INTEGER REFERENCES patients(id),
  channel TEXT,
  address TEXT,
  message_id INTEGER REFERENCES messages(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_confirm_links_token ON confirm_links(token_hash);
CREATE INDEX IF NOT EXISTS idx_confirm_links_appt ON confirm_links(appointment_id);

-- The business side: the practice's bank accounts (through Plaid) and its books (QuickBooks Online).
-- Tokens are sealed with the server secret. Amounts in cents; bank amounts are signed, money in positive.
CREATE TABLE IF NOT EXISTS bank_connections (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  provider TEXT NOT NULL DEFAULT 'plaid',
  item_id TEXT,
  access_token TEXT,
  institution TEXT,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  error TEXT,
  last_synced_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  connection_id INTEGER NOT NULL REFERENCES bank_connections(id),
  external_id TEXT NOT NULL,
  name TEXT,
  official_name TEXT,
  mask TEXT,
  type TEXT,
  subtype TEXT,
  current_balance INTEGER,
  available_balance INTEGER,
  deposits_here INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT,
  UNIQUE (connection_id, external_id)
);
CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  external_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  description TEXT,
  merchant TEXT,
  provider_category TEXT,
  category TEXT,
  category_source TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  match_kind TEXT,
  match_refs TEXT,
  match_amount INTEGER,
  match_fee INTEGER,
  match_status TEXT,
  matched_by INTEGER,
  matched_at TEXT,
  qbo_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_tx_date ON bank_transactions(practice_id, date);
CREATE TABLE IF NOT EXISTS finance_rules (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  pattern TEXT NOT NULL,
  category TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS qbo_connections (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL UNIQUE REFERENCES practices(id),
  realm_id TEXT NOT NULL,
  company_name TEXT,
  environment TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TEXT,
  refresh_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  error TEXT,
  settings TEXT,
  last_synced_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS qbo_accounts (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  qbo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT,
  type TEXT,
  subtype TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  category TEXT,
  category_source TEXT,
  UNIQUE (practice_id, qbo_id)
);
-- Monthly profit and loss from QuickBooks, one row per account per month.
CREATE TABLE IF NOT EXISTS qbo_pl (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  month TEXT NOT NULL,
  qbo_account_id TEXT,
  account_name TEXT NOT NULL,
  section TEXT NOT NULL,
  amount INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qbo_pl ON qbo_pl(practice_id, month);

-- The AI scribe's drafts (not the conversation, which is never kept): who, how long, and the note it became.
CREATE TABLE IF NOT EXISTS scribe_sessions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  user_id INTEGER REFERENCES users(id),
  appointment_id INTEGER REFERENCES appointments(id),
  minutes INTEGER,
  words INTEGER,
  ms INTEGER,
  note_id INTEGER REFERENCES clinical_notes(id),
  edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What an AI read of an x-ray found, where on the image (a box, as fractions of it), and the dentist's call.
CREATE TABLE IF NOT EXISTS xray_findings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  engine TEXT,
  kind TEXT NOT NULL,
  tooth TEXT,
  surfaces TEXT,
  confidence REAL,
  box TEXT,
  measurement_mm REAL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'suggested',
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  condition_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_xray_findings ON xray_findings(practice_id, patient_id, status);

-- Openings from cancellations, texted to ASAP and waitlist patients; the first YES books it.
CREATE TABLE IF NOT EXISTS fill_offers (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  source_appointment_id INTEGER REFERENCES appointments(id),
  cancelled_patient_id INTEGER,
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  operatory_id INTEGER,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  offered INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  filled_patient_id INTEGER,
  filled_appointment_id INTEGER,
  filled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fill_offer_recipients (
  id INTEGER PRIMARY KEY,
  offer_id INTEGER NOT NULL REFERENCES fill_offers(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  source TEXT NOT NULL,
  ref_id INTEGER,
  phone TEXT,
  message_id INTEGER,
  reply TEXT,
  replied_at TEXT,
  won INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fill_recipients ON fill_offer_recipients(message_id);

-- Phone calls: automated confirmation calls now; the office's own calls (with transcripts) too.
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER REFERENCES patients(id),
  direction TEXT NOT NULL DEFAULT 'outbound',
  purpose TEXT NOT NULL DEFAULT 'call',
  from_number TEXT,
  to_number TEXT,
  provider_id TEXT,
  token_hash TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  answered_by TEXT,
  outcome TEXT,
  duration INTEGER,
  recording_url TEXT,
  transcript TEXT,
  summary TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls ON calls(practice_id, created_at);

CREATE TABLE IF NOT EXISTS assistant_log (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER REFERENCES users(id),
  said TEXT,
  tools TEXT,
  ms INTEGER,
  outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assistant_log ON assistant_log(practice_id, id);

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
-- Every version of every fee schedule, never overwritten. fee_schedule_id NULL = the office's standard fees
-- (procedure_codes); schedule_key ('standard' or 'fs<id>') numbers the versions of one schedule.
CREATE TABLE IF NOT EXISTS fee_schedule_versions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  fee_schedule_id INTEGER REFERENCES fee_schedules(id),
  schedule_key TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  change_id INTEGER,
  item_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  actor_source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, schedule_key, version_no)
);
CREATE TABLE IF NOT EXISTS fee_schedule_version_items (
  version_id INTEGER NOT NULL REFERENCES fee_schedule_versions(id),
  code TEXT NOT NULL,
  fee INTEGER NOT NULL,
  PRIMARY KEY (version_id, code)
);
-- Planned fee changes: % increases (scheduled or applied now) and imported payer schedules (draft until approved).
CREATE TABLE IF NOT EXISTS fee_changes (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  fee_schedule_id INTEGER REFERENCES fee_schedules(id),
  schedule_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('increase','import')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','applied','cancelled','rejected')),
  effective_date TEXT,
  params TEXT,
  note TEXT,
  group_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  file_name TEXT,
  file_hash TEXT,
  reader TEXT,
  ai_reason TEXT,
  summary TEXT,
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancel_reason TEXT,
  applied_at TEXT,
  applied_version_id INTEGER REFERENCES fee_schedule_versions(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The lines of a planned change (derived rows: recomputed while the change is still editable).
CREATE TABLE IF NOT EXISTS fee_change_items (
  change_id INTEGER NOT NULL REFERENCES fee_changes(id),
  code TEXT NOT NULL,
  old_fee INTEGER,
  new_fee INTEGER,
  ucr INTEGER,
  flag TEXT,
  warn TEXT,
  skip INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (change_id, code)
);
-- A payer schedule's upload inbox: files dropped here are read into drafts by the fee job (never applied).
CREATE TABLE IF NOT EXISTS fee_import_inbox (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  fee_schedule_id INTEGER NOT NULL REFERENCES fee_schedules(id),
  file_name TEXT NOT NULL,
  mime TEXT,
  file_hash TEXT NOT NULL,
  content TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','processed','failed','duplicate')),
  change_id INTEGER REFERENCES fee_changes(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  UNIQUE (practice_id, fee_schedule_id, file_hash)
);
CREATE INDEX IF NOT EXISTS idx_fee_versions_eff ON fee_schedule_versions(practice_id, schedule_key, effective_from);
CREATE INDEX IF NOT EXISTS idx_fee_changes_status ON fee_changes(status, effective_date);

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

-- What each person used last (payment method, note template, booking length…), so forms start where they left off.
-- A convenience, not a record: overwritten freely.
CREATE TABLE IF NOT EXISTS user_prefs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, key)
);

-- Staff sign-in sessions: ended at sign-out, and refused after the practice's idle timeout.
CREATE TABLE IF NOT EXISTS staff_sessions (
  id INTEGER PRIMARY KEY,
  sid TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);

-- Invitations to create a practice on this server (when sign-up is invite-only). Made with
-- npm run invite; each works once.
CREATE TABLE IF NOT EXISTS signup_invites (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT,
  note TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  practice_id INTEGER,
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

-- Rows from another system's full backup, held while a conversion runs (then cleared). "ref" groups the rows
-- a step reads together (a perio exam's measurements, a payment's splits).
CREATE TABLE IF NOT EXISTS conversion_rows (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id),
  tbl TEXT NOT NULL,
  ref TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversion_rows ON conversion_rows(batch_id, tbl, id);
CREATE INDEX IF NOT EXISTS idx_conversion_ref ON conversion_rows(batch_id, tbl, ref);

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
CREATE TABLE IF NOT EXISTS risk_assessments (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  kind TEXT NOT NULL CHECK (kind IN ('caries','perio')),
  answers TEXT NOT NULL,
  level TEXT NOT NULL,
  result TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS education_articles (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  codes TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, slug)
);
-- Call tracking: a number per marketing source (Google Ads, a mailer, the website) that rings the office line.
CREATE TABLE IF NOT EXISTS tracking_numbers (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  number TEXT NOT NULL,
  source TEXT NOT NULL,
  monthly_cost INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Marketing ROI (MK1-MK2, docs/marketing.md): where patients come from. A source is a channel the practice pays or
-- hopes for (Google Ads, a mailer, patient referrals...); match_keys are the utm_source / ?src= / call-tracking line
-- names that mean it. Retired (active 0), never deleted.
CREATE TABLE IF NOT EXISTS marketing_sources (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  channel TEXT NOT NULL CHECK (channel IN ('google_ads','facebook','instagram','google_business','website_organic','referral_patient','referral_doctor','insurance_directory','mailer','event','walk_in','other')),
  name TEXT NOT NULL,
  match_keys TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, name)
);
-- A marketing campaign under a source (a spring mailer, a Google Ads campaign): matched by its utm_campaign tag,
-- promo code or call-tracking number while it runs. message_campaign_id links a campaign sent from the app.
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  source_id INTEGER NOT NULL REFERENCES marketing_sources(id),
  name TEXT NOT NULL,
  utm_campaign TEXT,
  promo_code TEXT,
  tracking_number_id INTEGER REFERENCES tracking_numbers(id),
  message_campaign_id INTEGER REFERENCES campaigns(id),
  starts_on TEXT,
  ends_on TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mk_campaign_utm ON marketing_campaigns(practice_id, utm_campaign) WHERE utm_campaign IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mk_campaign_promo ON marketing_campaigns(practice_id, promo_code) WHERE promo_code IS NOT NULL;
-- What marketing cost, for a date range (spread evenly over its days for monthly figures). Integer cents.
-- Corrected by voiding (voided_at) and entering again, never edited or deleted. client_key makes a resend safe.
CREATE TABLE IF NOT EXISTS marketing_costs (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  source_id INTEGER NOT NULL REFERENCES marketing_sources(id),
  campaign_id INTEGER REFERENCES marketing_campaigns(id),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  amount INTEGER NOT NULL,
  notes TEXT,
  client_key TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT,
  UNIQUE (practice_id, client_key)
);
-- Every piece of evidence of where a lead or patient came from (an online booking's UTM tags, a call to a tracking
-- number, a promo code, a referral, the front desk's "how did you hear about us"), once each (touch_key).
-- patients.marketing_first_touch_id / marketing_last_touch_id point at the ones that count (first and last touch).
CREATE TABLE IF NOT EXISTS marketing_touches (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER REFERENCES patients(id),
  touch_key TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('utm','tracking_number','promo_code','referral','staff','online_booking','call')),
  source_id INTEGER REFERENCES marketing_sources(id),
  campaign_id INTEGER REFERENCES marketing_campaigns(id),
  lead INTEGER NOT NULL DEFAULT 0,
  lead_kind TEXT,
  entity TEXT,
  entity_id INTEGER,
  detail TEXT,
  occurred_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, touch_key)
);
CREATE INDEX IF NOT EXISTS idx_mk_touches_patient ON marketing_touches(patient_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_mk_touches_lead ON marketing_touches(practice_id, lead, occurred_at);
-- A patient's own referral link code (?rp=CODE on the booking page). Codes are random, never personal details.
CREATE TABLE IF NOT EXISTS marketing_referral_codes (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, code)
);
-- How far the marketing capture job has read each kind of record (derived bookkeeping).
CREATE TABLE IF NOT EXISTS marketing_sync_state (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  last_id INTEGER NOT NULL DEFAULT 0,
  last_run_on TEXT,
  UNIQUE (practice_id, name)
);
CREATE TABLE IF NOT EXISTS financing_applications (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  lender TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  link TEXT,
  external_id TEXT,
  approved_amount INTEGER,
  plan TEXT,
  funded_amount INTEGER,
  funded_at TEXT,
  ledger_entry_id INTEGER REFERENCES ledger_entries(id),
  treatment_plan_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  source TEXT NOT NULL DEFAULT 'google',
  external_id TEXT,
  author TEXT,
  rating INTEGER,
  text TEXT,
  posted_at TEXT,
  reply TEXT,
  reply_status TEXT NOT NULL DEFAULT 'none',
  replied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS review_connections (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location TEXT NOT NULL,
  location_title TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TEXT,
  synced_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Requests already handled, by Idempotency-Key, so a repeat gets the same answer instead of a second payment.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  response_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scope, key)
);
-- "Needs attention": failures turned into work items (see issues.js).
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  severity TEXT NOT NULL DEFAULT 'normal',
  role TEXT NOT NULL DEFAULT 'admin',
  entity TEXT,
  entity_id INTEGER,
  patient_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  occurrences INTEGER NOT NULL DEFAULT 1,
  source TEXT,
  assigned_to INTEGER REFERENCES users(id),
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolution TEXT
);
-- Every call to an outside service (see issues.js): no bodies, no query strings.
-- Proof that backups restore: each drill reads a stored backup file, restores it into a rolled-back copy and
-- compares every table's row count.
CREATE TABLE IF NOT EXISTS restore_drills (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  file TEXT,
  ok INTEGER NOT NULL,
  rows_checked INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  source TEXT NOT NULL DEFAULT 'automation',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One-time, browser-bound states for connecting an outside account (see oauthstate.js).
CREATE TABLE IF NOT EXISTS oauth_states (
  id INTEGER PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  browser_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
-- Data migrations that have run (see migrations.js).
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_log (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER,
  service TEXT NOT NULL,
  operation TEXT NOT NULL,
  ok INTEGER NOT NULL,
  http_status INTEGER,
  duration_ms INTEGER,
  external_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  join_code_hash TEXT,
  join_code_expires TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS org_members (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','viewer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (organization_id, user_id)
);
-- DSO central billing office (orgbilling.js): who on the group's billing team is working which queue item.
-- item_key names the item ('claim:12', 'era:5:2' = remittance 5 line 2, 'credit:33' = patient 33's credit);
-- practice_id is looked up on the server from the item itself. Routing only — clearing an assignment is a
-- status change (assigned_to NULL), and every change is audited.
CREATE TABLE IF NOT EXISTS org_assignments (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  item_key TEXT NOT NULL,
  assigned_to INTEGER REFERENCES users(id),
  assigned_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (organization_id, item_key)
);
-- Group role templates ("Front desk", "Billing", "Dentist"): a built-in role plus a permission list that
-- owners apply to people across the group's practices at once. Each practice gets its own custom role
-- linked back here (custom_roles.org_template_id). Retired with active = 0, never deleted.
CREATE TABLE IF NOT EXISTS org_role_templates (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  base_role TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (organization_id, name)
);
-- Perfect day / block scheduling (S2, production.js). A named plan for one provider's day ("Dr. Chen Tuesday"):
-- lanes of time kept for some visit types, each with a production goal, and a goal for the whole day.
-- weekdays is a JSON list (0 = Sunday) of the days it applies to by itself. Configuration: retired with
-- active = 0, never deleted; editing a template retires its old blocks and adds the new ones.
CREATE TABLE IF NOT EXISTS day_templates (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  location_id INTEGER REFERENCES locations(id),
  name TEXT NOT NULL,
  weekdays TEXT NOT NULL DEFAULT '[]',
  day_goal INTEGER,
  release_hours INTEGER NOT NULL DEFAULT 24,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A block of a day template: 'HH:MM' times, the visit types it's kept for (JSON ids; empty = a goal-only
-- lane that takes anything) until release_hours (template's when null) before it starts, and its goal in cents.
CREATE TABLE IF NOT EXISTS day_template_blocks (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  template_id INTEGER NOT NULL REFERENCES day_templates(id),
  label TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  appointment_type_ids TEXT NOT NULL DEFAULT '[]',
  goal INTEGER NOT NULL DEFAULT 0,
  release_hours INTEGER,
  color TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One date for one provider planned differently from their weekday template: another template ('template'),
-- no template ('none'), or back to the usual ('auto' — how a date override is taken off, never by deleting it).
CREATE TABLE IF NOT EXISTS day_template_dates (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  date TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'template' CHECK (mode IN ('template','none','auto')),
  template_id INTEGER REFERENCES day_templates(id),
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider_id, date)
);
-- Office intranet (I1–I3, intranet.js): quick links, SOP/wiki pages with full version history, announcements
-- and new-hire onboarding checklists. location_ids / roles are JSON lists limiting who sees an item (NULL =
-- everyone). Nothing here is hard deleted: items are archived (status = 'archived', archived_at).
-- Quick links to the websites the team uses (insurance portals, labs, supplies, payroll). starter_key marks
-- one added from the suggested list, so adding it twice brings back the same row.
CREATE TABLE IF NOT EXISTS intranet_links (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('insurance','labs','supplies','payroll','other')),
  icon TEXT,
  location_ids TEXT,
  roles TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  starter_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  archived_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, starter_key)
);
-- Sections of the office manual ("Front desk", "Clinical", "Emergencies").
CREATE TABLE IF NOT EXISTS intranet_sections (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  archived_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A page (SOP, checklist, how-to). body is Markdown and always equals the newest intranet_page_versions row;
-- version is that row's number. ack_version: the version people must read and acknowledge (NULL = no
-- sign-off asked). review_every_days / review_due: when someone should check it's still right.
CREATE TABLE IF NOT EXISTS intranet_pages (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  section_id INTEGER REFERENCES intranet_sections(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  template_key TEXT,
  location_ids TEXT,
  roles TEXT,
  ack_version INTEGER,
  review_every_days INTEGER,
  review_due TEXT,
  last_reviewed_at TEXT,
  last_reviewed_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  archived_at TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, template_key)
);
-- Every save of a page, never changed or removed. Restoring an old version adds a new row (restored_from).
CREATE TABLE IF NOT EXISTS intranet_page_versions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  page_id INTEGER NOT NULL REFERENCES intranet_pages(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  change_note TEXT,
  restored_from INTEGER,
  source TEXT NOT NULL DEFAULT 'human',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (page_id, version)
);
-- Images and files on a page, stored like patient documents (encrypted, under the practice's folder).
CREATE TABLE IF NOT EXISTS intranet_attachments (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  page_id INTEGER NOT NULL REFERENCES intranet_pages(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Office announcements, pinned at the top of the intranet home until they expire or are archived.
CREATE TABLE IF NOT EXISTS intranet_announcements (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  title TEXT NOT NULL,
  body TEXT,
  pinned INTEGER NOT NULL DEFAULT 1,
  requires_ack INTEGER NOT NULL DEFAULT 0,
  location_ids TEXT,
  roles TEXT,
  expires_on TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  archived_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- "Read and acknowledged": one row per person per page version (or announcement). Never removed.
CREATE TABLE IF NOT EXISTS intranet_acks (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  kind TEXT NOT NULL CHECK (kind IN ('page','announcement')),
  item_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER NOT NULL REFERENCES users(id),
  acknowledged_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, item_id, version, user_id)
);
-- New-hire onboarding: a checklist (items can link to an SOP page) and the people it's given to.
CREATE TABLE IF NOT EXISTS intranet_checklists (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  archived_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS intranet_checklist_items (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  checklist_id INTEGER NOT NULL REFERENCES intranet_checklists(id),
  title TEXT NOT NULL,
  page_id INTEGER REFERENCES intranet_pages(id),
  sort INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS intranet_onboardings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  checklist_id INTEGER NOT NULL REFERENCES intranet_checklists(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  due_on TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  assigned_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One row per ticked item; unticking clears done_at (recorded in the audit log), the row stays.
CREATE TABLE IF NOT EXISTS intranet_onboarding_steps (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  onboarding_id INTEGER NOT NULL REFERENCES intranet_onboardings(id),
  item_id INTEGER NOT NULL REFERENCES intranet_checklist_items(id),
  done_at TEXT,
  done_by INTEGER REFERENCES users(id),
  UNIQUE (onboarding_id, item_id)
);
-- KPI goals (metrics.js, docs/metrics.md): one per metric and scope: the whole practice ('practice'), one office
-- ('location:3') or one provider ('provider:7'). Money in cents, percentages in tenths of a percent (905 = 90.5%),
-- counts as counts. Money and count goals are per month (scheduled production: per day). Configuration: a goal
-- that's taken away is deleted, and every change is audited.
CREATE TABLE IF NOT EXISTS metric_goals (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  metric TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'practice',
  location_id INTEGER REFERENCES locations(id),
  provider_id INTEGER REFERENCES providers(id),
  value INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, metric, scope_key)
);
-- Metric emails (digests.js): who gets which digest (morning huddle, end of day, weekly, monthly), written for
-- which audience (owner, office_manager, hygienist, billing), when (practice-local HH:MM) and for which office.
-- Only staff of the practice. Never deleted: status active / paused / unsubscribed (the email's own link).
CREATE TABLE IF NOT EXISTS digest_subscriptions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  digest TEXT NOT NULL CHECK (digest IN ('huddle','end_of_day','weekly','monthly')),
  audience TEXT NOT NULL DEFAULT 'owner' CHECK (audience IN ('owner','office_manager','hygienist','billing')),
  send_time TEXT NOT NULL DEFAULT '07:00',
  location_id INTEGER REFERENCES locations(id),
  provider_id INTEGER REFERENCES providers(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','unsubscribed')),
  unsubscribed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, user_id, digest)
);
-- Each digest that went (or tried to): one row per subscription and period ('huddle:2026-09-24', 'weekly:2026-09-14'),
-- claimed before sending, so a restart or a second server never sends the same digest twice. The email itself
-- is in messages (with SendGrid's delivery status). Test sends use a 'test:' period key.
CREATE TABLE IF NOT EXISTS digest_sends (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  subscription_id INTEGER NOT NULL REFERENCES digest_subscriptions(id),
  period_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  message_id INTEGER REFERENCES messages(id),
  error TEXT,
  ai_summary INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  UNIQUE (subscription_id, period_key)
);
-- End-of-day values of the metrics that are a count of "right now" (unscheduled treatment, recall, claims waiting),
-- so emails and the Metrics screen can show how they're trending. Derived data written once a day per practice
-- (scope_key 'practice') and office ('location:3') by the metric-email job; safe to rebuild.
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  snapshot_date TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'practice',
  metric TEXT NOT NULL,
  value INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, snapshot_date, scope_key, metric)
);
-- Team chat and tasks (routes/chat.js, chat.js). Channels are open to everyone in the practice; direct messages
-- and small groups only to their members. Messages are never removed: a delete sets status 'deleted' and hides
-- the text, and every edit keeps the earlier text in chat_message_edits. A message can be about a patient
-- (patient_id): office access rules apply and reading one is recorded like any other PHI view.
CREATE TABLE IF NOT EXISTS chat_channels (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  kind TEXT NOT NULL DEFAULT 'channel' CHECK (kind IN ('channel','dm','group')),
  name TEXT,
  slug TEXT,
  topic TEXT,
  audience TEXT,
  location_id INTEGER REFERENCES locations(id),
  dm_key TEXT,
  created_by INTEGER REFERENCES users(id),
  archived_at TEXT,
  archived_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, slug),
  UNIQUE (practice_id, dm_key)
);
-- Who is in a conversation, and how far they've read (last_read_id) and been emailed about (emailed_through_id).
CREATE TABLE IF NOT EXISTS chat_members (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  channel_id INTEGER NOT NULL REFERENCES chat_channels(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  last_read_id INTEGER NOT NULL DEFAULT 0,
  emailed_through_id INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  left_at TEXT,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel_id, user_id)
);
-- client_key: the sending screen's own id for the message, so a resend never posts it twice.
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  channel_id INTEGER NOT NULL REFERENCES chat_channels(id),
  parent_id INTEGER REFERENCES chat_messages(id),
  user_id INTEGER REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'human',
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','gif','system')),
  body TEXT,
  gif TEXT,
  patient_id INTEGER REFERENCES patients(id),
  location_id INTEGER REFERENCES locations(id),
  urgent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  client_key TEXT,
  edited_at TEXT,
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, user_id, client_key)
);
-- The text before and after each edit (and a patient link changed with it), oldest first.
CREATE TABLE IF NOT EXISTS chat_message_edits (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  message_id INTEGER NOT NULL REFERENCES chat_messages(id),
  user_id INTEGER REFERENCES users(id),
  body_before TEXT,
  body_after TEXT,
  patient_before INTEGER,
  patient_after INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Emoji reactions. Taking a reaction back removes its row: a reaction is not a record.
CREATE TABLE IF NOT EXISTS chat_reactions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  message_id INTEGER NOT NULL REFERENCES chat_messages(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (message_id, user_id, emoji)
);
-- Who a message called on (@name, @front-desk, @everyone), and when they saw it.
CREATE TABLE IF NOT EXISTS chat_mentions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  message_id INTEGER NOT NULL REFERENCES chat_messages(id),
  channel_id INTEGER NOT NULL REFERENCES chat_channels(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  via TEXT,
  seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (message_id, user_id)
);
-- "Got it" on an urgent message: who has seen it, and when.
CREATE TABLE IF NOT EXISTS chat_acks (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  message_id INTEGER NOT NULL REFERENCES chat_messages(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  acked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (message_id, user_id)
);
-- Images and files sent in chat, stored (and encrypted) like patient documents. Uploaded first, then
-- attached to the message that sends them (message_id stays empty until then).
CREATE TABLE IF NOT EXISTS chat_attachments (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  message_id INTEGER REFERENCES chat_messages(id),
  uploaded_by INTEGER REFERENCES users(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A practice's chat choices: GIF search (off unless turned on) and the unread-digest email delay (0 = none).
CREATE TABLE IF NOT EXISTS chat_settings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL UNIQUE REFERENCES practices(id),
  gifs_enabled INTEGER NOT NULL DEFAULT 0,
  digest_minutes INTEGER NOT NULL DEFAULT 240,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Recurring tasks ("every Friday: order supplies"). Each due date makes one task, once: task_occurrences is
-- unique per series and date, so a job running twice (or on two servers) can't double it. Stopped with
-- active = 0, never deleted.
CREATE TABLE IF NOT EXISTS task_series (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  title TEXT NOT NULL,
  notes TEXT,
  assigned_to INTEGER REFERENCES users(id),
  patient_id INTEGER REFERENCES patients(id),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  rule TEXT NOT NULL CHECK (rule IN ('daily','weekdays','weekly','biweekly','monthly')),
  weekday INTEGER,
  month_day INTEGER,
  checklist TEXT,
  next_due TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  ended_at TEXT,
  ended_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_occurrences (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  series_id INTEGER NOT NULL REFERENCES task_series(id),
  due_date TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (series_id, due_date)
);
-- A task's checklist. Ticked with who and when; an item taken off keeps its row (removed_at).
CREATE TABLE IF NOT EXISTS task_checklist_items (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  text TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  done_by INTEGER REFERENCES users(id),
  removed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Time clock, schedules and payroll (TC1-TC5, routes/timeclock.js, docs/workflows/specs/TC-timeclock.md). Punches are
-- time_punches (above). The punched times never change: manager fixes are rows in time_punch_corrections (reason, who,
-- when) and time_punches.eff_* holds the result. Approving a pay period locks it; every payroll file is recorded.
CREATE TABLE IF NOT EXISTS timeclock_settings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL UNIQUE REFERENCES practices(id),
  early_in_minutes INTEGER NOT NULL DEFAULT 7,
  late_grace_minutes INTEGER NOT NULL DEFAULT 5,
  early_out_minutes INTEGER NOT NULL DEFAULT 5,
  late_out_minutes INTEGER NOT NULL DEFAULT 10,
  outside_window TEXT NOT NULL DEFAULT 'flag' CHECK (outside_window IN ('flag','block')),
  block_unscheduled INTEGER NOT NULL DEFAULT 0,
  pay_period TEXT NOT NULL DEFAULT 'biweekly' CHECK (pay_period IN ('weekly','biweekly','semimonthly','monthly')),
  period_anchor TEXT,
  week_start_day INTEGER NOT NULL DEFAULT 0,
  ot_weekly INTEGER NOT NULL DEFAULT 1,
  ot_weekly_minutes INTEGER NOT NULL DEFAULT 2400,
  ot_daily INTEGER NOT NULL DEFAULT 0,
  ot_daily_minutes INTEGER NOT NULL DEFAULT 480,
  dt_daily INTEGER NOT NULL DEFAULT 0,
  dt_daily_minutes INTEGER NOT NULL DEFAULT 720,
  seventh_day INTEGER NOT NULL DEFAULT 0,
  rounding INTEGER NOT NULL DEFAULT 0 CHECK (rounding IN (0,5,6,15)),
  paid_break_max_minutes INTEGER NOT NULL DEFAULT 20,
  pto_mode TEXT NOT NULL DEFAULT 'none' CHECK (pto_mode IN ('none','per_hour','fixed')),
  pto_per_hour REAL NOT NULL DEFAULT 0,
  pto_fixed_minutes INTEGER NOT NULL DEFAULT 0,
  pto_cap_minutes INTEGER NOT NULL DEFAULT 0,
  adp_company_code TEXT,
  paychex_client_id TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Per person: on the clock or not, payroll id, pay type, hourly rate (cents; only timeclock:rates sees it), tablet PIN (hashed).
CREATE TABLE IF NOT EXISTS timeclock_staff (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  on_clock INTEGER NOT NULL DEFAULT 1,
  payroll_id TEXT,
  pay_type TEXT NOT NULL DEFAULT 'hourly' CHECK (pay_type IN ('hourly','salary')),
  overtime_exempt INTEGER NOT NULL DEFAULT 0,
  hourly_rate_cents INTEGER,
  pto_eligible INTEGER NOT NULL DEFAULT 1,
  holiday_eligible INTEGER NOT NULL DEFAULT 1,
  pin_hash TEXT,
  pin_set_at TEXT,
  pin_failures INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Shared time-clock tablets: only the token hash is kept; revoked, never deleted.
CREATE TABLE IF NOT EXISTS timeclock_kiosks (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  revoked_at TEXT,
  revoked_by INTEGER REFERENCES users(id)
);
-- Breaks and lunches inside a punch (short rest breaks are paid, lunches are not; see timeclock_settings).
CREATE TABLE IF NOT EXISTS time_breaks (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  punch_id INTEGER NOT NULL REFERENCES time_punches(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'break' CHECK (kind IN ('break','lunch')),
  start_at TEXT NOT NULL,
  start_utc TEXT,
  end_at TEXT,
  end_utc TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One row per person who is clocked in right now (scratch: removed at clock-out). The unique user_id is what
-- stops a double click or two tablets from opening two punches.
CREATE TABLE IF NOT EXISTS time_open_punches (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  punch_id INTEGER NOT NULL REFERENCES time_punches(id),
  break_id INTEGER REFERENCES time_breaks(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Manager fixes: add a missed shift, change times or the break, or remove a punch. Append-only; reason required.
CREATE TABLE IF NOT EXISTS time_punch_corrections (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  punch_id INTEGER NOT NULL REFERENCES time_punches(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('add','change','void')),
  before_in TEXT,
  before_out TEXT,
  before_break INTEGER,
  new_in TEXT,
  new_out TEXT,
  new_break INTEGER,
  reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The usual week (weekday 0 = Sunday) and per-date overrides (a different shift, a day off, or cleared = back to usual).
CREATE TABLE IF NOT EXISTS staff_shift_templates (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT,
  end_time TEXT,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  location_id INTEGER REFERENCES locations(id),
  active INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, weekday)
);
CREATE TABLE IF NOT EXISTS staff_shifts (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','off','cleared')),
  start_time TEXT,
  end_time TEXT,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  location_id INTEGER REFERENCES locations(id),
  note TEXT,
  source TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, date)
);
-- Time off: requests (pending, approved, denied, cancelled) and the balance as a ledger (balance = SUM(minutes);
-- accruals +, time used -, corrections by voiding). Accrual once per person per pay period; use once per request.
CREATE TABLE IF NOT EXISTS pto_requests (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'pto' CHECK (kind IN ('pto','unpaid')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  minutes_per_day INTEGER NOT NULL,
  total_minutes INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','cancelled')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pto_ledger (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  entry_date TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('accrual','used','adjustment')),
  period_start TEXT,
  request_id INTEGER REFERENCES pto_requests(id),
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT
);
CREATE TABLE IF NOT EXISTS timeclock_holidays (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  paid_minutes INTEGER NOT NULL DEFAULT 480,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, date)
);
-- A manager's approval of one person's hours for one pay period: the minutes by pay type and the day detail as
-- approved (what the payroll file is built from). Reopening sets status unlocked with a reason; one live approval each.
CREATE TABLE IF NOT EXISTS pay_period_approvals (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','unlocked')),
  regular_minutes INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  doubletime_minutes INTEGER NOT NULL DEFAULT 0,
  pto_minutes INTEGER NOT NULL DEFAULT 0,
  holiday_minutes INTEGER NOT NULL DEFAULT 0,
  total_minutes INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  detail_hash TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  unlocked_by INTEGER REFERENCES users(id),
  unlocked_at TEXT,
  unlock_reason TEXT
);
-- Every payroll file downloaded: format, period, who, when, a SHA-256 of the content, and minutes per person and type.
CREATE TABLE IF NOT EXISTS payroll_exports (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('gusto','adp','paychex','quickbooks','csv')),
  filename TEXT,
  content_hash TEXT NOT NULL,
  people INTEGER NOT NULL DEFAULT 0,
  total_minutes INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  partial INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Daily deposits and cash handling (DC1-DC3: deposits.js, routes/cashdeposits.js, docs/cash-handling.md).
-- A submitted cash-and-check deposit is a deposits row (so bank matching finds it) plus its locked slip here:
-- who prepared it, who verified it (a different person), the bag number, the cash by denomination, what the ledger
-- said, and any difference with its reason. Never edited: a manager reopens it with a reason (the deposit is voided
-- and kept) and a new one replaces it. The idempotency key makes a repeated submit return the first deposit.
CREATE TABLE IF NOT EXISTS deposit_slips (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  deposit_id INTEGER NOT NULL UNIQUE REFERENCES deposits(id),
  location_id INTEGER REFERENCES locations(id),
  business_date TEXT NOT NULL,
  submit_key TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'submitted' CHECK (stage IN ('submitted','in_bank','reconciled','reopened')),
  cash_total INTEGER NOT NULL DEFAULT 0,
  check_total INTEGER NOT NULL DEFAULT 0,
  cash_count TEXT,
  cash_source TEXT NOT NULL DEFAULT 'counted',
  ledger_total INTEGER NOT NULL DEFAULT 0,
  difference INTEGER NOT NULL DEFAULT 0,
  left_out_total INTEGER NOT NULL DEFAULT 0,
  difference_reason TEXT,
  bag_number TEXT,
  prepared_by INTEGER NOT NULL REFERENCES users(id),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  sod_flags TEXT,
  bank_note TEXT,
  bank_note_by INTEGER REFERENCES users(id),
  bank_note_at TEXT,
  reopened_by INTEGER REFERENCES users(id),
  reopened_at TEXT,
  reopen_reason TEXT,
  replaces_deposit_id INTEGER REFERENCES deposits(id),
  UNIQUE (practice_id, submit_key)
);
-- What was on the slip when it was submitted (kept when a deposit is reopened and its payments are released).
-- Amounts in cents: payments positive, cash refunds paid out of the day's cash negative.
CREATE TABLE IF NOT EXISTS deposit_slip_items (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  deposit_id INTEGER NOT NULL REFERENCES deposits(id),
  ledger_entry_id INTEGER NOT NULL REFERENCES ledger_entries(id),
  kind TEXT NOT NULL CHECK (kind IN ('cash','check','cash_refund')),
  amount INTEGER NOT NULL,
  check_number TEXT,
  payer TEXT,
  patient_id INTEGER REFERENCES patients(id),
  entry_date TEXT,
  taken_by INTEGER REFERENCES users(id),
  UNIQUE (deposit_id, ledger_entry_id)
);
-- Photos of the stamped slip (encrypted like documents). Evidence: added, never replaced or removed.
CREATE TABLE IF NOT EXISTS deposit_photos (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  deposit_id INTEGER NOT NULL REFERENCES deposits(id),
  storage_key TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Cash drawers (one per desk) and each day's session: opened with a float, closed with a blind count (the
-- expected amount is worked out only when the count is submitted), verified by a second person with the
-- over/short and its reason. One session open per drawer at a time.
CREATE TABLE IF NOT EXISTS cash_drawers (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  name TEXT NOT NULL,
  default_float INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, name)
);
CREATE TABLE IF NOT EXISTS cash_drawer_sessions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  drawer_id INTEGER NOT NULL REFERENCES cash_drawers(id),
  location_id INTEGER REFERENCES locations(id),
  business_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','counted','closed')),
  opening_float INTEGER NOT NULL DEFAULT 0,
  opened_by INTEGER NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  counted_by INTEGER REFERENCES users(id),
  counted_at TEXT,
  count_detail TEXT,
  counted_total INTEGER,
  expected_total INTEGER,
  over_short INTEGER,
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  verify_detail TEXT,
  verify_total INTEGER,
  over_short_reason TEXT,
  float_kept INTEGER,
  to_deposit INTEGER,
  deposit_id INTEGER REFERENCES deposits(id),
  closed_at TEXT
);
-- Numbered cash receipts: every cash payment (and cash paid out) gets the next number for its office. Numbers
-- are never reused or skipped; a voided payment's receipt stays, marked voided.
CREATE TABLE IF NOT EXISTS cash_receipts (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  office_key INTEGER NOT NULL DEFAULT 0,
  receipt_no INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','payout')),
  ledger_entry_id INTEGER NOT NULL UNIQUE REFERENCES ledger_entries(id),
  drawer_session_id INTEGER REFERENCES cash_drawer_sessions(id),
  patient_id INTEGER REFERENCES patients(id),
  amount INTEGER NOT NULL,
  taken_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','voided')),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, office_key, receipt_no)
);
-- Cash events the owner reviews (Cash integrity report): cash voids, refunds and discounts (with the manager who
-- approved them), a float that didn't match the last close, big over/shorts. One row per event (dedupe_key).
CREATE TABLE IF NOT EXISTS cash_flags (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  ledger_entry_id INTEGER REFERENCES ledger_entries(id),
  deposit_id INTEGER REFERENCES deposits(id),
  session_id INTEGER REFERENCES cash_drawer_sessions(id),
  patient_id INTEGER REFERENCES patients(id),
  amount INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, dedupe_key)
);
-- Per practice: business days a deposit may take to reach the bank, and the drawer over/short that is flagged.
CREATE TABLE IF NOT EXISTS cash_settings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL UNIQUE REFERENCES practices(id),
  late_business_days INTEGER NOT NULL DEFAULT 3,
  over_short_alert INTEGER NOT NULL DEFAULT 500,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Chart audit (CA1-CA4, chartaudit.js). The office's tuning of the checks: JSON over the defaults in chartaudit.js.
CREATE TABLE IF NOT EXISTS chart_audit_rules (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL UNIQUE REFERENCES practices(id),
  settings TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Derived rows: what each completed visit's chart is missing, recomputed nightly. One live row per visit + check +
-- subject (updated in place); when the chart is fixed the row is marked resolved (resolved_at) and kept as history.
CREATE TABLE IF NOT EXISTS chart_audit_findings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  appointment_id INTEGER REFERENCES appointments(id),
  visit_key TEXT NOT NULL,
  visit_date TEXT NOT NULL,
  provider_id INTEGER REFERENCES providers(id),
  note_id INTEGER REFERENCES clinical_notes(id),
  check_code TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL CHECK (severity IN ('high','medium','low')),
  risk INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  detail TEXT,
  why TEXT,
  evidence TEXT,
  source TEXT NOT NULL DEFAULT 'rule' CHECK (source IN ('rule','ai')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  ack_reason TEXT,
  ack_by INTEGER REFERENCES users(id),
  ack_at TEXT
);
-- Each audit pass (nightly, run now, one visit): run_key makes the nightly pass once per practice per day.
CREATE TABLE IF NOT EXISTS chart_audit_runs (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  run_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  visits INTEGER NOT NULL DEFAULT 0,
  opened INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  ai_checked INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_by INTEGER REFERENCES users(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  UNIQUE (practice_id, run_key)
);
-- The AI's reading of a visit's note against its charted work, kept per note version (input_hash) so an unchanged
-- note isn't sent again. Derived; source is always the AI.
CREATE TABLE IF NOT EXISTS chart_audit_ai_reads (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  visit_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  mismatches TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, visit_key, input_hash)
);
-- "Check my chart" (CA4): every check an assistant ran on a visit before the doctor sees it (history, never edited).
CREATE TABLE IF NOT EXISTS chart_checks (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  appointment_id INTEGER REFERENCES appointments(id),
  visit_key TEXT NOT NULL,
  checked_by INTEGER REFERENCES users(id),
  problems INTEGER NOT NULL DEFAULT 0,
  items TEXT,
  first_pass INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A chart the assistant marked "ready for doctor": who prepared it, when, and what was left open (with reasons).
CREATE TABLE IF NOT EXISTS chart_ready (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  appointment_id INTEGER REFERENCES appointments(id),
  visit_key TEXT NOT NULL,
  prepared_by INTEGER REFERENCES users(id),
  ready_at TEXT NOT NULL DEFAULT (datetime('now')),
  open_items INTEGER NOT NULL DEFAULT 0,
  acknowledged TEXT,
  first_pass_clean INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','withdrawn')),
  withdrawn_at TEXT,
  withdrawn_by INTEGER REFERENCES users(id)
);
-- Long recordings (LR1-LR3, longrecording.js): a whole exam recorded in ~30-second chunks. The browser names the
-- session (client_id) so a retried start doesn't make two. Audio and transcript live encrypted in storage.
CREATE TABLE IF NOT EXISTS recording_sessions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  appointment_id INTEGER REFERENCES appointments(id),
  provider_id INTEGER REFERENCES providers(id),
  user_id INTEGER REFERENCES users(id),
  client_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recording' CHECK (status IN ('recording','paused','uploaded','transcribing','transcribed','failed','discarded','purged')),
  consent INTEGER NOT NULL DEFAULT 0,
  consent_at TEXT,
  consent_by INTEGER REFERENCES users(id),
  mime TEXT,
  chunk_count INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  pauses TEXT,
  transcript_key TEXT,
  transcript_encrypted INTEGER NOT NULL DEFAULT 0,
  transcript_lines INTEGER,
  speakers TEXT,
  draft TEXT,
  note_id INTEGER REFERENCES clinical_notes(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  finished_at TEXT,
  transcribed_at TEXT,
  purged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, client_id)
);
CREATE TABLE IF NOT EXISTS recording_chunks (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  session_id INTEGER NOT NULL REFERENCES recording_sessions(id),
  seq INTEGER NOT NULL,
  start_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  mime TEXT,
  storage_key TEXT,
  encrypted INTEGER NOT NULL DEFAULT 0,
  transcript_key TEXT,
  transcript_encrypted INTEGER NOT NULL DEFAULT 0,
  purged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, seq)
);
-- Cadence engine (cadence.js, docs/workflows/specs/RC-recall.md): a sequence of steps around an anchor date (a recall's
-- due date; later a treatment plan's diagnosis date) that texts, emails, calls (AI or a person) and mails a patient
-- until a stop condition (a visit booked, declined, opted out) ends it. One sequence per practice, type and subtype
-- (recall type key, or treatment urgency). Configuration: sequences are switched off, not deleted; every edit audited.
CREATE TABLE IF NOT EXISTS cadence_sequences (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  type TEXT NOT NULL,
  subtype TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  family_window_days INTEGER NOT NULL DEFAULT 30,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, type, subtype)
);
-- A step: offset_days from the anchor (negative = before it), how (channel), what it says (template, subject), and
-- conditions (JSON: fallback channels, who a call task goes to). repeat_days makes the step recur (the quarterly
-- "we miss you") up to repeat_max times. A removed step is switched off (active 0): its runs still point at it.
CREATE TABLE IF NOT EXISTS cadence_steps (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  sequence_id INTEGER NOT NULL REFERENCES cadence_sequences(id),
  position INTEGER NOT NULL DEFAULT 0,
  offset_days INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('text','email','ai_call','task_call','letter','postcard')),
  template TEXT,
  subject TEXT,
  conditions TEXT,
  repeat_days INTEGER,
  repeat_max INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A patient on a sequence for one reason (source: the recall row, later the treatment plan) and one anchor date.
-- Unique per source and anchor, so enrolling twice (a restart, two servers) is a no-op. Never deleted: stopped
-- (booked, declined, opted out, recall done…) or completed; booked_* say which step brought the visit in.
CREATE TABLE IF NOT EXISTS cadence_enrollments (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  sequence_id INTEGER NOT NULL REFERENCES cadence_sequences(id),
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  anchor_date TEXT NOT NULL,
  location_id INTEGER REFERENCES locations(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped','completed')),
  stop_reason TEXT,
  stopped_at TEXT,
  stopped_by INTEGER REFERENCES users(id),
  current_step INTEGER,
  last_run_at TEXT,
  booked_appointment_id INTEGER REFERENCES appointments(id),
  booked_step_id INTEGER REFERENCES cadence_steps(id),
  booked_via TEXT,
  booked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sequence_id, source_type, source_id, anchor_date)
);
-- Each step run for an enrollment (occurrence counts a repeating step's repeats). The unique key is the claim:
-- the job inserts the row before sending, so a restart or a second job never sends a step twice. status: claimed
-- (sending), sent, failed, skipped (not needed: late start, grouped, unreachable), task (a call for the team, until
-- its outcome), done. Message, call, task and outside ids (Lob) link to what went out; outcome is the call result.
CREATE TABLE IF NOT EXISTS cadence_runs (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  enrollment_id INTEGER NOT NULL REFERENCES cadence_enrollments(id),
  step_id INTEGER NOT NULL REFERENCES cadence_steps(id),
  occurrence INTEGER NOT NULL DEFAULT 0,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','sent','failed','skipped','task','done')),
  channel TEXT,
  fallback_from TEXT,
  source TEXT NOT NULL DEFAULT 'automation',
  attempts INTEGER NOT NULL DEFAULT 1,
  message_id INTEGER REFERENCES messages(id),
  call_id INTEGER REFERENCES calls(id),
  task_id INTEGER REFERENCES tasks(id),
  external_id TEXT,
  grouped_with INTEGER REFERENCES cadence_runs(id),
  result TEXT,
  outcome TEXT,
  outcome_note TEXT,
  outcome_by INTEGER REFERENCES users(id),
  outcome_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  UNIQUE (enrollment_id, step_id, occurrence)
);
-- "Don't send recall to this person": deceased, moved away, asked not to be contacted. type NULL = every cadence.
-- Never deleted: lifting a hold sets released_at (who and when), so the history stays.
CREATE TABLE IF NOT EXISTS cadence_holds (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  type TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('deceased','moved','no_contact','other')),
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  released_at TEXT,
  released_by INTEGER REFERENCES users(id)
);
-- Self-scheduling links sent in cadence messages (RC2): which enrollments (a family's) the link books, for whom,
-- until when. The token in the message is this row's id plus an HMAC signature; only the signature's hash is kept.
CREATE TABLE IF NOT EXISTS cadence_links (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  recipient_id INTEGER NOT NULL REFERENCES patients(id),
  run_id INTEGER REFERENCES cadence_runs(id),
  enrollment_ids TEXT NOT NULL,
  sig_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  opened_at TEXT,
  booked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Self-scheduled bookings from a link: one per link and request key, so a double tap or a retry books once.
CREATE TABLE IF NOT EXISTS cadence_bookings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  link_id INTEGER NOT NULL REFERENCES cadence_links(id),
  request_key TEXT NOT NULL,
  appointment_ids TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (link_id, request_key)
);
-- Opportunity finder (OF1-OF3, opportunities.js): the office's rules for work a patient may be due for (codes as a
-- JSON list, whole mouth / per tooth / per quadrant, ages, months since any of the codes was last done, chart
-- conditions as a JSON list, codes it replaces on the visit). Configuration: retired with active = 0, never
-- deleted; every change audited. starter_key marks the starter rules so seeding them twice adds nothing.
CREATE TABLE IF NOT EXISTS opportunity_rules (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  codes TEXT NOT NULL DEFAULT '[]',
  scope TEXT NOT NULL DEFAULT 'mouth' CHECK (scope IN ('mouth','tooth','quadrant')),
  age_min INTEGER,
  age_max INTEGER,
  frequency_months INTEGER,
  conditions TEXT NOT NULL DEFAULT '[]',
  replaces TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  starter_key TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, starter_key)
);
-- What happened to each opportunity on a visit (one row per visit and rule): offered (shown on the visit),
-- accepted (added to it: procedure_ids planned or attached, replaced_ids set aside) or declined (with a reason).
-- "Done" is read from the procedures themselves. Status changes are recorded; rows are never deleted.
CREATE TABLE IF NOT EXISTS opportunity_events (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  rule_id INTEGER NOT NULL REFERENCES opportunity_rules(id),
  status TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','declined')),
  codes TEXT,
  fee INTEGER NOT NULL DEFAULT 0,
  patient_cost INTEGER,
  procedure_ids TEXT,
  attached_ids TEXT,
  replaced_ids TEXT,
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (appointment_id, rule_id)
);
-- Notes on a document (docs/documents.md): who wrote what, when. An edit is a new row that supersedes the old
-- one (status 'superseded', kept as history); a removal only sets status 'deleted'. A note with page/x/y is a
-- sticky-note pin on that spot (x and y as fractions of the page or image, pages counted from 1).
CREATE TABLE IF NOT EXISTS document_notes (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  patient_id INTEGER REFERENCES patients(id),
  body TEXT NOT NULL,
  page INTEGER,
  x REAL,
  y REAL,
  color TEXT,
  supersedes_id INTEGER REFERENCES document_notes(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deleted')),
  source TEXT NOT NULL DEFAULT 'human',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT
);
-- Full-text search over documents (docsearch.js): keyed hashes (HMAC) of the words in a document's read text,
-- never the words themselves; the text itself is kept encrypted in file storage like the file. Derived data:
-- rebuilt whenever a document is read again, so its rows are replaced (deleted and re-added) freely.
CREATE TABLE IF NOT EXISTS document_terms (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  term TEXT NOT NULL,
  UNIQUE (document_id, term)
);
-- Capacity meter trend (capacity.js): one row per practice/office, kind and night. Derived rows; pruned after
-- two years.
CREATE TABLE IF NOT EXISTS capacity_snapshots (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  snapshot_date TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'practice',
  location_id INTEGER REFERENCES locations(id),
  kind TEXT NOT NULL CHECK (kind IN ('doctor','hygiene')),
  status TEXT,
  booked_pct_2w INTEGER,
  booked_pct_4w INTEGER,
  booked_pct_8w INTEGER,
  first_new_patient_days INTEGER,
  first_emergency_days INTEGER,
  first_recall_days INTEGER,
  first_treatment_days INTEGER,
  open_hours_week INTEGER,
  demand_hours_week INTEGER,
  recall_hours_4w INTEGER,
  unscheduled_hours INTEGER,
  asap_count INTEGER,
  requests_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, snapshot_date, scope_key, kind)
);
-- Recurring checklists by position (RCL1–RCL3; checklists.js, routes/checklists.js, docs/workflows/specs/RCL-checklists.md).
-- A position is who a checklist is for ("Sterilization", "Front desk"). Its people are everyone with its built-in role
-- (role) or custom role (custom_role_id), plus people added by name (checklist_position_members). Archived, never deleted.
CREATE TABLE IF NOT EXISTS checklist_positions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  role TEXT,
  custom_role_id INTEGER REFERENCES custom_roles(id),
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, name)
);
-- People added to a position by name; taken off with removed_at (the row stays).
CREATE TABLE IF NOT EXISTS checklist_position_members (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  position_id INTEGER NOT NULL REFERENCES checklist_positions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  added_by INTEGER REFERENCES users(id),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (position_id, user_id)
);
-- A checklist the owner builds for a position. location_id NULL = every office (one set of items per office).
-- starter_key marks one added from the starter list, so adding it twice brings back the same checklist.
CREATE TABLE IF NOT EXISTS checklist_templates (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  position_id INTEGER NOT NULL REFERENCES checklist_positions(id),
  location_id INTEGER REFERENCES locations(id),
  name TEXT NOT NULL,
  description TEXT,
  starter_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  archived_at TEXT,
  archived_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, starter_key)
);
-- One line of a checklist and its schedule. cadence daily (weekdays '1,2,3,4,5', 0 = Sunday; NULL = the days
-- the office is open), weekly (weekday), monthly / quarterly / annually (month_day 1–31, clamped to the month's
-- end; -1 = the last day the office is open; month = the month for annually, the first month of the cycle for
-- quarterly). due_time is practice-local 'HH:MM'. Numbers (min_value, max_value) are decimals kept as text so
-- both databases keep them exactly. generated_through: the last date occurrences were made up to.
CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  template_id INTEGER NOT NULL REFERENCES checklist_templates(id),
  title TEXT NOT NULL,
  instructions TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly','monthly','quarterly','annually')),
  weekdays TEXT,
  weekday INTEGER,
  month_day INTEGER,
  month INTEGER,
  due_time TEXT NOT NULL DEFAULT '17:00',
  assign_rule TEXT NOT NULL DEFAULT 'position' CHECK (assign_rule IN ('position','person','on_shift')),
  assignee_id INTEGER REFERENCES users(id),
  result_type TEXT NOT NULL DEFAULT 'none' CHECK (result_type IN ('none','number','pass_fail','text')),
  min_value TEXT,
  max_value TEXT,
  unit TEXT,
  require_photo INTEGER NOT NULL DEFAULT 0,
  require_file INTEGER NOT NULL DEFAULT 0,
  require_note INTEGER NOT NULL DEFAULT 0,
  critical INTEGER NOT NULL DEFAULT 0,
  sop_page_id INTEGER REFERENCES intranet_pages(id),
  start_date TEXT NOT NULL,
  generated_through TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  archived_at TEXT,
  archived_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Each time an item is due, once per office: made by the checklist job, one per item + date + office
-- (location_key = the office id, 0 for none) whoever runs it and however often. open → done, or missed when its
-- window closes (closes_on: the day before the next one is due). cancelled = a future one the schedule no longer
-- has. critical is copied when made. completed_at is UTC; completed_local the practice's wall clock.
-- outcome: ok, fail (a failed pass/fail result) or out_of_range (a number outside the allowed range).
CREATE TABLE IF NOT EXISTS checklist_occurrences (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  item_id INTEGER NOT NULL REFERENCES checklist_items(id),
  template_id INTEGER NOT NULL REFERENCES checklist_templates(id),
  position_id INTEGER NOT NULL REFERENCES checklist_positions(id),
  location_id INTEGER REFERENCES locations(id),
  location_key INTEGER NOT NULL DEFAULT 0,
  due_date TEXT NOT NULL,
  due_at TEXT NOT NULL,
  closes_on TEXT NOT NULL,
  critical INTEGER NOT NULL DEFAULT 0,
  assigned_to INTEGER REFERENCES users(id),
  assigned_via TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','missed','cancelled')),
  result_number TEXT,
  result_pass INTEGER,
  result_text TEXT,
  note TEXT,
  outcome TEXT CHECK (outcome IN ('ok','fail','out_of_range')),
  completed_at TEXT,
  completed_local TEXT,
  completed_by INTEGER REFERENCES users(id),
  completed_source TEXT,
  completed_late INTEGER NOT NULL DEFAULT 0,
  late_reason TEXT,
  missed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, due_date, location_key)
);
-- Photos and files attached to an occurrence, stored (encrypted) like documents. The same file twice on one
-- occurrence is one row (sha256). Taken off with removed_at and a reason; the file stays.
CREATE TABLE IF NOT EXISTS checklist_evidence (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  occurrence_id INTEGER NOT NULL REFERENCES checklist_occurrences(id),
  kind TEXT NOT NULL CHECK (kind IN ('photo','file')),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  source TEXT,
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id),
  removed_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (occurrence_id, sha256)
);
-- What happened to an occurrence, oldest first (done, undone, corrected with before/after, evidence, flags).
-- Append-only: the compliance log's own history, next to the audit log.
CREATE TABLE IF NOT EXISTS checklist_events (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  occurrence_id INTEGER NOT NULL REFERENCES checklist_occurrences(id),
  kind TEXT NOT NULL,
  details TEXT,
  reason TEXT,
  user_id INTEGER REFERENCES users(id),
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A problem with an occurrence: a failed result, a number out of range, or a critical item not done by its due
-- time. One per occurrence and kind. Also a Needs attention item (issue_id); stays open until someone with
-- checklists:manage writes down what was done about it (corrective_action).
CREATE TABLE IF NOT EXISTS checklist_flags (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  occurrence_id INTEGER NOT NULL REFERENCES checklist_occurrences(id),
  item_id INTEGER NOT NULL REFERENCES checklist_items(id),
  location_id INTEGER REFERENCES locations(id),
  kind TEXT NOT NULL CHECK (kind IN ('fail','out_of_range','overdue')),
  critical INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  issue_id INTEGER REFERENCES issues(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  notified_at TEXT,
  notified_via TEXT,
  raised_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  corrective_action TEXT,
  UNIQUE (occurrence_id, kind)
);
-- Per practice: who hears about flags (alert_user_ids JSON; NULL = everyone with checklists:manage), texts for
-- critical ones (alert_phones JSON), chat posts, and how long a tick can be undone before it needs a correction.
CREATE TABLE IF NOT EXISTS checklist_settings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL UNIQUE REFERENCES practices(id),
  alert_user_ids TEXT,
  alert_phones TEXT,
  chat_alerts INTEGER NOT NULL DEFAULT 1,
  sms_alerts INTEGER NOT NULL DEFAULT 0,
  undo_minutes INTEGER NOT NULL DEFAULT 10,
  positions_seeded INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Consents and paperwork (consents.js, paperwork.js; docs/workflows/specs/C-consents.md).
-- Every wording of a form the office ever used: a signed form points at the exact version it was signed against.
-- Written when a template is created or edited and never changed afterwards.
CREATE TABLE IF NOT EXISTS form_template_versions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  template_id INTEGER NOT NULL REFERENCES form_templates(id),
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  fields TEXT NOT NULL,
  fields_es TEXT,
  content_hash TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (template_id, version)
);
-- One consent a patient needs for some treatment (a visit, a plan or chosen procedures): needed -> sent ->
-- signed or declined; superseded when a new version must be signed instead (the old row is kept). Once signed
-- or declined, the wording, signer, time, device and witness never change (database trigger in GUARDS).
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  template_id INTEGER NOT NULL REFERENCES form_templates(id),
  context_key TEXT NOT NULL,
  appointment_id INTEGER REFERENCES appointments(id),
  treatment_plan_id INTEGER REFERENCES treatment_plans(id),
  procedure_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'needed' CHECK (status IN ('needed','sent','signed','declined','superseded')),
  form_request_id INTEGER REFERENCES form_requests(id),
  version_id INTEGER REFERENCES form_template_versions(id),
  template_version INTEGER,
  lang TEXT,
  content TEXT,
  content_hash TEXT,
  patient_form_id INTEGER REFERENCES patient_forms(id),
  document_id INTEGER REFERENCES documents(id),
  signer_name TEXT,
  signer_relationship TEXT,
  signed_at TEXT,
  signed_via TEXT,
  ip TEXT,
  device TEXT,
  witness_user_id INTEGER REFERENCES users(id),
  witness_name TEXT,
  witness_signature TEXT,
  declined_at TEXT,
  declined_reason TEXT,
  declined_by INTEGER REFERENCES users(id),
  superseded_at TEXT,
  superseded_by INTEGER REFERENCES users(id),
  superseded_reason TEXT,
  replaced_by_id INTEGER,
  source TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Links to a packet of forms (a text, an email, a QR code at the desk, a hand-off on the office device). Each send
-- and each reminder is its own link; only the hash of the token is kept.
CREATE TABLE IF NOT EXISTS paperwork_links (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  packet_id INTEGER NOT NULL REFERENCES form_requests(id),
  appointment_id INTEGER REFERENCES appointments(id),
  token_hash TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK (channel IN ('sms','email','qr','handoff')),
  purpose TEXT NOT NULL DEFAULT 'send' CHECK (purpose IN ('send','auto','reminder','qr','handoff')),
  message_id INTEGER REFERENCES messages(id),
  expires_at TEXT NOT NULL,
  dob_failures INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- What the paperwork autopilot sent (or tried to), claimed before sending so a restart or a second server never
-- sends the same thing twice: 'appt:12:initial', 'packet:40:reminder:1'.
CREATE TABLE IF NOT EXISTS paperwork_sends (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  send_key TEXT NOT NULL,
  appointment_id INTEGER REFERENCES appointments(id),
  packet_id INTEGER REFERENCES form_requests(id),
  link_id INTEGER REFERENCES paperwork_links(id),
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','failed','skipped')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, send_key)
);
-- Office iPads in kiosk mode for forms (front desk or an operatory). Only the token hash is kept; revoked,
-- never deleted.
CREATE TABLE IF NOT EXISTS forms_kiosks (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  operatory_id INTEGER REFERENCES operatories(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  revoked_at TEXT,
  revoked_by INTEGER REFERENCES users(id)
);
-- A patient's turn on a kiosk iPad: the forms (or an education page) staff loaded for them. Ends when they
-- finish, go idle, or staff cancel it; the iPad then clears itself.
CREATE TABLE IF NOT EXISTS kiosk_sessions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  kiosk_id INTEGER NOT NULL REFERENCES forms_kiosks(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  appointment_id INTEGER REFERENCES appointments(id),
  packet_id INTEGER REFERENCES form_requests(id),
  mode TEXT NOT NULL DEFAULT 'forms' CHECK (mode IN ('forms','education')),
  education_delivery_id INTEGER,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','active','completed','cancelled','expired')),
  page INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  lang TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  last_activity_at TEXT,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  ended_reason TEXT
);
-- Each wording of an education page that was shown or sent (built-in or the office's own), so the record says
-- exactly what the patient saw.
CREATE TABLE IF NOT EXISTS education_versions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  video_url TEXT,
  postop TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, slug, version)
);
-- Proof education was given: who, what version, how (shown in the chair or on the iPad, emailed, texted), when,
-- and when the patient opened a take-home link. Appears in the consent record and the visit's note.
CREATE TABLE IF NOT EXISTS education_deliveries (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  appointment_id INTEGER REFERENCES appointments(id),
  consent_id INTEGER REFERENCES consents(id),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL,
  version_id INTEGER REFERENCES education_versions(id),
  how TEXT NOT NULL CHECK (how IN ('shown_chair','shown_ipad','emailed','texted')),
  postop INTEGER NOT NULL DEFAULT 0,
  operatory_id INTEGER REFERENCES operatories(id),
  kiosk_session_id INTEGER REFERENCES kiosk_sessions(id),
  token_hash TEXT UNIQUE,
  message_id INTEGER REFERENCES messages(id),
  opened_at TEXT,
  open_count INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Illustrations and short videos an office adds to an education page (general information, no patient data).
-- Removed ones are marked, not deleted.
CREATE TABLE IF NOT EXISTS education_media (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at TEXT
);
-- Online scheduling (OS1–OS5, onlinesched.js, docs/workflows/specs/OS-online-scheduling.md).
-- The practice's online scheduling page: branding, who hears about bookings, and which slots are "no-show prone".
-- Configuration: edited in place (audited), one row per practice.
CREATE TABLE IF NOT EXISTS online_sched_settings (
  practice_id INTEGER PRIMARY KEY REFERENCES practices(id),
  brand_color TEXT,
  logo_mime TEXT,
  logo TEXT,
  headline TEXT,
  headline_es TEXT,
  notify_chat INTEGER NOT NULL DEFAULT 1,
  notify_sms_to TEXT,
  family_max INTEGER NOT NULL DEFAULT 4,
  embed_origins TEXT,
  risky_weekdays TEXT,
  risky_before TEXT,
  risky_after TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- What patients can book online (new patient, emergency, hygiene, consults…): the rules the public page and the
-- slot search follow. Linked to an appointment type for the schedule. Retired (active = 0), never deleted.
CREATE TABLE IF NOT EXISTS online_visit_types (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('new_patient','emergency','hygiene','consult','other')),
  label TEXT NOT NULL,
  label_es TEXT,
  blurb TEXT,
  blurb_es TEXT,
  appointment_type_id INTEGER REFERENCES appointment_types(id),
  duration INTEGER NOT NULL DEFAULT 60,
  provider_ids TEXT NOT NULL DEFAULT '[]',
  location_ids TEXT NOT NULL DEFAULT '[]',
  lead_minutes INTEGER NOT NULL DEFAULT 120,
  max_days INTEGER NOT NULL DEFAULT 60,
  buffer_minutes INTEGER NOT NULL DEFAULT 0,
  booking_mode TEXT NOT NULL DEFAULT 'instant' CHECK (booking_mode IN ('instant','request')),
  who TEXT NOT NULL DEFAULT 'anyone' CHECK (who IN ('new','existing','anyone')),
  family INTEGER NOT NULL DEFAULT 0,
  questions TEXT NOT NULL DEFAULT '[]',
  deposit INTEGER NOT NULL DEFAULT 0,
  deposit_rule TEXT NOT NULL DEFAULT 'never' CHECK (deposit_rule IN ('never','new_patients','always','risky_slots')),
  card_rule TEXT NOT NULL DEFAULT 'never' CHECK (card_rule IN ('never','new_patients','always','risky_slots')),
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, label)
);
-- One online booking as submitted (one person, or a family back-to-back): its idempotency key, where it came
-- from (source / UTM — no personal details), what needs a person, and who at the office has seen it. The people
-- are booking_requests rows (online_booking_id); their visits carry appointments.online_booking_id.
CREATE TABLE IF NOT EXISTS online_bookings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  visit_type_id INTEGER REFERENCES online_visit_types(id),
  submit_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','booked','requested','awaiting_deposit','declined','cancelled')),
  people INTEGER NOT NULL DEFAULT 1,
  first_start TEXT,
  new_patients INTEGER NOT NULL DEFAULT 0,
  urgent INTEGER NOT NULL DEFAULT 0,
  flags TEXT NOT NULL DEFAULT '[]',
  triage TEXT,
  insurance_status TEXT,
  source TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  referrer_host TEXT,
  variant TEXT,
  language TEXT,
  asap INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  chat_message_id INTEGER REFERENCES chat_messages(id),
  seen_by INTEGER REFERENCES users(id),
  seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, submit_key)
);
-- Conversion analytics for the public page: one row per anonymous page session and step reached. No names,
-- contact details, IP addresses or free text — only the step, the kind of visit, the channel and the copy variant.
CREATE TABLE IF NOT EXISTS online_booking_events (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  session_key TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('view','office','reason','time','details','booked','requested','taken','bot')),
  visit_kind TEXT,
  source TEXT,
  variant TEXT,
  day TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, session_key, step)
);
-- Today's schedule optimizer (optimizer.js): each suggestion shown, and what was done with it.
CREATE TABLE IF NOT EXISTS optimizer_suggestions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  date TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  action TEXT,
  patient_id INTEGER REFERENCES patients(id),
  provider_id INTEGER REFERENCES providers(id),
  appointment_id INTEGER REFERENCES appointments(id),
  title TEXT,
  fee INTEGER NOT NULL DEFAULT 0,
  collectible INTEGER NOT NULL DEFAULT 0,
  minutes INTEGER NOT NULL DEFAULT 0,
  in_plan INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'shown' CHECK (status IN ('shown','accepted','done','declined','failed','undone')),
  times_shown INTEGER NOT NULL DEFAULT 1,
  result TEXT,
  reason TEXT,
  source TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, date, key)
);

-- Visit readiness (labcheck.js): lab cases and parts each visit needs, and every check-in.
CREATE TABLE IF NOT EXISTS visit_requirements (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  kind TEXT NOT NULL CHECK (kind IN ('lab_case','part')),
  link_key TEXT NOT NULL,
  lab_case_id INTEGER REFERENCES lab_cases(id),
  procedure_id INTEGER REFERENCES procedures(id),
  item_name TEXT,
  details TEXT,
  inventory_item_id INTEGER REFERENCES inventory_items(id),
  qty INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('needed','linked','to_order','ordered','arrived','checked','set_aside','problem','cancelled')),
  source TEXT NOT NULL DEFAULT 'manual',
  reason TEXT,
  ordered_at TEXT,
  arrived_at TEXT,
  checked_at TEXT,
  checked_by INTEGER REFERENCES users(id),
  photo_ids TEXT,
  task_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (appointment_id, link_key)
);
CREATE TABLE IF NOT EXISTS lab_checkins (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  lab_case_id INTEGER REFERENCES lab_cases(id),
  requirement_id INTEGER REFERENCES visit_requirements(id),
  appointment_id INTEGER REFERENCES appointments(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('ok','problem')),
  checklist TEXT NOT NULL,
  problem_kind TEXT,
  problem_note TEXT,
  photo_ids TEXT,
  via TEXT NOT NULL DEFAULT 'screen',
  transcript TEXT,
  lab_id INTEGER REFERENCES labs(id),
  lab_name TEXT,
  sent_date TEXT,
  promised_date TEXT,
  received_date TEXT,
  client_key TEXT,
  lab_message_at TEXT,
  lab_message_by INTEGER REFERENCES users(id),
  checked_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, client_key)
);
CREATE INDEX IF NOT EXISTS idx_visit_req_appt ON visit_requirements(practice_id, appointment_id);
CREATE INDEX IF NOT EXISTS idx_lab_checkins_case ON lab_checkins(practice_id, lab_case_id);
-- Statement codes for website bill pay (PT3, billpay.js): one live code per family, printed on statements;
-- replacing one sets revoked_at on the old code (never deleted).
CREATE TABLE IF NOT EXISTS billpay_codes (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  code TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, code)
);
CREATE INDEX IF NOT EXISTS idx_billpay_codes_patient ON billpay_codes(practice_id, patient_id);


-- Treatment plan phases (F1, routes/finoptions.js): the name, plain-words why, number of visits, planned month and
-- optional picture (a chart document) for each phase number on a plan (procedures.phase holds the number).
-- Part of the plan: edited in place (recorded before/after), never deleted.
CREATE TABLE IF NOT EXISTS treatment_plan_phases (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  treatment_plan_id INTEGER NOT NULL REFERENCES treatment_plans(id),
  phase INTEGER NOT NULL,
  name TEXT,
  why TEXT,
  visits INTEGER,
  when_date TEXT,
  document_id INTEGER REFERENCES documents(id),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (treatment_plan_id, phase)
);
-- A patient's accepted financial option for a plan (F4/F5): which phases, which option, and an immutable
-- snapshot of exactly what was shown (estimate, fee schedule, every option, the office's terms) with its hash,
-- so the agreement can be reproduced and printed. One live agreement per plan (live_key 'tp:<plan id>',
-- cleared when cancelled). What it created is linked: payment plan, financing application, and — only once the
-- prepayment is actually posted — the payment and prepay-discount ledger entries (discount_status pending →
-- posted, or reversed by a reversing entry). Never deleted; cancelled with a reason.
CREATE TABLE IF NOT EXISTS fin_agreements (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  treatment_plan_id INTEGER NOT NULL REFERENCES treatment_plans(id),
  phases TEXT NOT NULL,
  option_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('full','in_office','lender','membership')),
  total INTEGER NOT NULL,
  due_today INTEGER NOT NULL DEFAULT 0,
  monthly INTEGER,
  months INTEGER,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  discount_status TEXT NOT NULL DEFAULT 'none' CHECK (discount_status IN ('none','pending','posting','posted','reversed','void')),
  snapshot TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','cancelled','completed')),
  live_key TEXT UNIQUE,
  payment_plan_id INTEGER REFERENCES payment_plans(id),
  financing_application_id INTEGER REFERENCES financing_applications(id),
  prepay_entry_id INTEGER REFERENCES ledger_entries(id),
  discount_entry_id INTEGER REFERENCES ledger_entries(id),
  finance_charge_entry_id INTEGER REFERENCES ledger_entries(id),
  task_id INTEGER REFERENCES tasks(id),
  signature_name TEXT,
  signature_image TEXT,
  source TEXT NOT NULL DEFAULT 'human',
  accepted_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancel_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- What patients are told when options are compared (F6, routes/treatmentoptions.js), per procedure code or code
-- prefix: likely next steps (JSON [{label, codes}]), typical longevity, pros and cons (JSON lists). Built-in starter
-- wording applies until the office saves its own here. Configuration: edited in place by an administrator, audited.
CREATE TABLE IF NOT EXISTS procedure_insights (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  code TEXT NOT NULL,
  next_steps TEXT NOT NULL DEFAULT '[]',
  longevity TEXT,
  pros TEXT NOT NULL DEFAULT '[]',
  cons TEXT NOT NULL DEFAULT '[]',
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, code)
);
-- Phones: every call saved, linked and coached (PH1-PH7, phonecoach.js, routes/phonecoach.js, docs/phones.md).
-- The practice's phone rules: the recording disclosure callers hear, who answers the phones (user ids, JSON), who is
-- told about upset callers and missed-call days (user ids, JSON; optional text numbers that get no patient details),
-- the missed-call % target, live transcription and AI scoring on/off. Configuration: edited in place, audited.
CREATE TABLE IF NOT EXISTS phone_settings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL UNIQUE REFERENCES practices(id),
  recording_disclosure TEXT,
  answerer_ids TEXT,
  alert_user_ids TEXT,
  alert_sms_to TEXT,
  missed_target_pct INTEGER NOT NULL DEFAULT 15,
  missed_min_calls INTEGER NOT NULL DEFAULT 10,
  live_transcription INTEGER NOT NULL DEFAULT 0,
  scoring INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Phone protocols (PH2): the office's way of handling each kind of call, as weighted steps (JSON: key, label, weight,
-- required, hints). One active protocol per call type; an edit bumps the version and is audited, and each score keeps
-- the steps it was scored against. Retired protocols are archived, never deleted.
CREATE TABLE IF NOT EXISTS phone_protocols (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  call_type TEXT NOT NULL CHECK (call_type IN ('general','new_patient','emergency','scheduling','billing')),
  name TEXT NOT NULL,
  philosophy TEXT,
  steps TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- An AI read of a call against its protocol (PH3): labelled AI, with the transcript's own words as evidence for each
-- step. A re-score supersedes the earlier one (kept). Coaching only: never acted on automatically.
CREATE TABLE IF NOT EXISTS call_scores (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  call_id INTEGER NOT NULL REFERENCES calls(id),
  protocol_id INTEGER REFERENCES phone_protocols(id),
  protocol_version INTEGER,
  call_type TEXT NOT NULL,
  score INTEGER NOT NULL,
  steps TEXT NOT NULL,
  summary TEXT,
  model TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ai',
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','superseded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- An owner's or manager's own rating (0-100, used instead of the AI's in averages) and coaching comments.
-- Append-only: the newest rating counts, earlier ones stay.
CREATE TABLE IF NOT EXISTS call_reviews (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  call_id INTEGER NOT NULL REFERENCES calls(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Why a caller didn't book (PH4): the AI's suggestion (with the words it heard) and the reason a person confirmed.
-- One per call; a change of reason is recorded before/after.
CREATE TABLE IF NOT EXISTS call_no_book (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  call_id INTEGER NOT NULL UNIQUE REFERENCES calls(id),
  patient_id INTEGER REFERENCES patients(id),
  suggested_reason TEXT CHECK (suggested_reason IN ('cost','time','insurance','shopping','think','other')),
  suggested_quote TEXT,
  suggested_by TEXT,
  reason TEXT CHECK (reason IN ('cost','time','insurance','shopping','think','other')),
  note TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Phone alerts (PH5, PH7): an upset caller (with the moment heard) or a day over the missed-call target. One per
-- problem (dedupe_key); open until someone acknowledges it (who, when, a note). Never deleted.
CREATE TABLE IF NOT EXISTS phone_alerts (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  kind TEXT NOT NULL CHECK (kind IN ('upset','missed_rate')),
  dedupe_key TEXT NOT NULL,
  call_id INTEGER REFERENCES calls(id),
  patient_id INTEGER REFERENCES patients(id),
  quote TEXT,
  detail TEXT,
  source TEXT NOT NULL DEFAULT 'automation',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged')),
  notified TEXT,
  ack_by INTEGER REFERENCES users(id),
  ack_at TEXT,
  ack_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, dedupe_key)
);
-- Live transcription (PH6): the finished phrases heard during a call (caller or office), from the phone provider's
-- real-time transcription (or the sandbox). Only final phrases are kept; partial words are parsed and dropped.
CREATE TABLE IF NOT EXISTS call_segments (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  call_id INTEGER NOT NULL REFERENCES calls(id),
  track TEXT NOT NULL DEFAULT 'caller' CHECK (track IN ('caller','office')),
  text TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (call_id, track, seq)
);
-- Recall frequencies (RF1–RF4, recallsync.js / recallfreq.js, docs/workflows/specs/RF-recall-frequencies.md).
-- Work done at another office (x-rays taken elsewhere…), entered by hand so the recall resets from its date.
-- source is always 'outside'. Corrected by voiding (status 'voided', with who and why), never deleted.
CREATE TABLE IF NOT EXISTS recall_outside (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  location_id INTEGER REFERENCES locations(id),
  code TEXT NOT NULL,
  done_on TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'outside',
  office_name TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Each time something done (a completed procedure, or outside work) reset a recall, with the recall as it was
-- before and the recalls it retired (perio maintenance retires the prophy). A voided procedure marks its row
-- undone and the recall goes back to what the remaining rows say (or to the state before the first one).
CREATE TABLE IF NOT EXISTS recall_resets (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  recall_id INTEGER NOT NULL REFERENCES recalls(id),
  procedure_id INTEGER REFERENCES procedures(id),
  outside_id INTEGER REFERENCES recall_outside(id),
  code TEXT NOT NULL,
  done_date TEXT NOT NULL,
  location_id INTEGER REFERENCES locations(id),
  before_state TEXT,
  retired TEXT,
  undone_at TEXT,
  undone_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (recall_id, procedure_id),
  UNIQUE (recall_id, outside_id)
);
-- Referral tracker (RT1–RT5, referraltracker.js, docs/workflows/specs/RT-referrals.md). Settings per practice:
-- days until a referral is expected to be seen per urgency (only drive the past-due report unless nudges are on),
-- how often a critical referral re-alerts the team, and the letter/text wording.
CREATE TABLE IF NOT EXISTS referral_settings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  routine_days INTEGER NOT NULL DEFAULT 30,
  soon_days INTEGER NOT NULL DEFAULT 14,
  critical_days INTEGER NOT NULL DEFAULT 7,
  past_due_days INTEGER NOT NULL DEFAULT 30,
  critical_alert_days INTEGER NOT NULL DEFAULT 7,
  nudge_noncritical INTEGER NOT NULL DEFAULT 0,
  text_patient INTEGER NOT NULL DEFAULT 1,
  alert_user_ids TEXT,
  patient_text TEXT,
  thank_you_text TEXT,
  report_back_text TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT,
  UNIQUE (practice_id)
);
-- What a referral is for: procedure codes and teeth, with the office fee and the PPO allowed amount on the day it
-- was made (for the in-house opportunity report), and the planned procedure it came from.
CREATE TABLE IF NOT EXISTS referral_items (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  referral_id INTEGER NOT NULL REFERENCES referrals(id),
  code TEXT NOT NULL,
  category TEXT,
  tooth TEXT,
  surfaces TEXT,
  procedure_id INTEGER REFERENCES procedures(id),
  office_fee INTEGER,
  ppo_fee INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A referral's timeline: every status move, letter, text, alert, nudge, report and note, with who and when.
-- Append-only (never edited or removed).
CREATE TABLE IF NOT EXISTS referral_events (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  referral_id INTEGER NOT NULL REFERENCES referrals(id),
  kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  on_date TEXT,
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'human',
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Files that go with a referral (x-rays, notes sent along) and the specialist's report that came back.
CREATE TABLE IF NOT EXISTS referral_documents (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  referral_id INTEGER NOT NULL REFERENCES referrals(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  role TEXT NOT NULL CHECK (role IN ('attachment','report')),
  added_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (referral_id, document_id, role)
);
-- A filed document that looks like the report for an open referral (rules, or the AI when unsure): a person
-- confirms or dismisses it. One row per referral and document, so a dismissed match is never suggested again.
CREATE TABLE IF NOT EXISTS referral_report_matches (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  referral_id INTEGER NOT NULL REFERENCES referrals(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  score INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'rules',
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','confirmed','dismissed')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (referral_id, document_id)
);
-- Owner's business view (businessdata.js): procedure costs, provider pay, staff roles, exam targets.
-- Business view (PM1-PM4, BD1-BD4; business.js, businessdata.js, routes/business.js, docs/business-view.md).
-- The owner's settings: color thresholds, fixed costs, labor target. One row per practice; changes are audited.
CREATE TABLE IF NOT EXISTS business_settings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL UNIQUE REFERENCES practices(id),
  basis TEXT NOT NULL DEFAULT 'chair' CHECK (basis IN ('chair','doctor')),
  overhead_mode TEXT NOT NULL DEFAULT 'auto' CHECK (overhead_mode IN ('auto','manual')),
  overhead_per_hour_cents INTEGER,
  fixed_costs_month_cents INTEGER,
  work_days_month INTEGER NOT NULL DEFAULT 18,
  red_below_cents INTEGER,
  green_from_cents INTEGER,
  gold_from_cents INTEGER,
  labor_target_low_bp INTEGER NOT NULL DEFAULT 2500,
  labor_target_high_bp INTEGER NOT NULL DEFAULT 3000,
  patient_collect_bp INTEGER NOT NULL DEFAULT 10000,
  default_merchant_bp INTEGER NOT NULL DEFAULT 250,
  assistants_per_doctor_chair_bp INTEGER NOT NULL DEFAULT 10000,
  idle_gap_minutes INTEGER NOT NULL DEFAULT 20,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Direct costs of a procedure code or a whole category (supplies, lab, card fee, provider pay override). Never
-- edited or deleted: every change is a new version from a date; a version with active = 0 retires the profile.
CREATE TABLE IF NOT EXISTS business_cost_profiles (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  scope TEXT NOT NULL CHECK (scope IN ('code','category')),
  scope_key TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  supplies_cents INTEGER NOT NULL DEFAULT 0,
  lab_mode TEXT NOT NULL DEFAULT 'none' CHECK (lab_mode IN ('none','fixed','case')),
  lab_cents INTEGER NOT NULL DEFAULT 0,
  merchant_bp INTEGER,
  pay_pct_bp INTEGER,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_by INTEGER REFERENCES users(id),
  actor_source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, scope, scope_key, version_no)
);
-- How each provider is paid for their work (associates, hygienists), versioned the same way.
CREATE TABLE IF NOT EXISTS business_provider_pay (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  version_no INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('none','production_pct','collections_pct','hourly')),
  pct_bp INTEGER NOT NULL DEFAULT 0,
  hourly_cents INTEGER,
  lab_deducted INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  actor_source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, provider_id, version_no)
);
-- Who each person on the clock works with, for the staff lanes (doctor / hygienist = their own visits; assistant =
-- their providers' or chairs' visits, or the shared pool; admin = front office). Missing rows are worked out from roles.
CREATE TABLE IF NOT EXISTS business_staff_roles (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('doctor','hygienist','assistant','admin')),
  provider_ids TEXT,
  operatory_ids TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The owner's daily exam targets by type (EX1) and their own value per exam (EX2), used when the practice's history
-- can't say yet. Configuration: one row per type, changes audited.
CREATE TABLE IF NOT EXISTS business_exam_targets (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  exam_type TEXT NOT NULL,
  daily_target INTEGER,
  value_cents INTEGER,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, exam_type)
);
-- The owner's own value of an exam (EX2), per exam type and horizon; overrides the learned value. Configuration:
-- set, changed and removed by administrators, each audited (exam_value.set / change / clear).
CREATE TABLE IF NOT EXISTS exam_values (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  exam_type TEXT NOT NULL CHECK (exam_type IN ('new_patient','recall','perio','emergency')),
  horizon_months INTEGER NOT NULL CHECK (horizon_months IN (1,3,5)),
  value_cents INTEGER NOT NULL,
  set_by INTEGER REFERENCES users(id),
  set_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, exam_type, horizon_months)
);
-- Insurance autopilot (eobauto.js, docs/eob-autopilot.md). A paper EOB (scan, PDF or phone photo) as read by AI:
-- the file (encrypted in storage), what the AI read from it, and who approved posting it ("Looks right — post").
-- file_hash makes the same file uploaded twice one EOB. Never deleted: status read → posted, or void.
CREATE TABLE IF NOT EXISTS paper_eobs (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  filename TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  file_hash TEXT NOT NULL,
  payer_name TEXT,
  carrier_id INTEGER REFERENCES insurance_carriers(id),
  check_number TEXT,
  check_date TEXT,
  total_paid INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'check',
  provider_adjustments TEXT,
  totals_match INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'read' CHECK (status IN ('read','posted','void')),
  insurance_check_id INTEGER REFERENCES insurance_checks(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, file_hash)
);
-- One row per claim per remittance (an ERA's CLP lines for one claim, merged; a paper EOB's claim), and one per
-- line that matched no claim, with the autopilot's verdict: 'ready' (reconciles exactly, waiting to post),
-- 'posted', 'exception' (kind: denied, underpaid, overpaid, unmatched, partial, reversal, review — reason in
-- words) or 'resolved' (a person decided: resolution + note). Amounts in cents as the payer sent them.
-- dedupe_key (source, payer, trace/check number, claim or control number, line) makes each line arrive once.
-- line_no -1 is the check itself (provider-level adjustments, totals that don't match). Never deleted.
CREATE TABLE IF NOT EXISTS remit_lines (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  source TEXT NOT NULL CHECK (source IN ('era','paper')),
  era_import_id INTEGER REFERENCES era_imports(id),
  paper_eob_id INTEGER REFERENCES paper_eobs(id),
  insurance_check_id INTEGER REFERENCES insurance_checks(id),
  dedupe_key TEXT NOT NULL,
  trace TEXT,
  payer_name TEXT,
  line_no INTEGER NOT NULL DEFAULT 0,
  lines_count INTEGER NOT NULL DEFAULT 1,
  control_number TEXT,
  claim_id INTEGER REFERENCES claims(id),
  patient_id INTEGER REFERENCES patients(id),
  location_id INTEGER REFERENCES locations(id),
  status_code TEXT,
  billed INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  contractual INTEGER NOT NULL DEFAULT 0,
  patient_resp INTEGER NOT NULL DEFAULT 0,
  other_adjustments INTEGER NOT NULL DEFAULT 0,
  deductible INTEGER NOT NULL DEFAULT 0,
  expected_allowed INTEGER,
  payer_claim_number TEXT,
  reason_codes TEXT,
  services TEXT,
  state TEXT NOT NULL DEFAULT 'exception' CHECK (state IN ('ready','posted','exception','resolved')),
  kind TEXT,
  reason TEXT,
  posted_at TEXT,
  posted_by INTEGER REFERENCES users(id),
  posted_source TEXT,
  resolution TEXT,
  resolution_note TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  task_id INTEGER REFERENCES tasks(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, dedupe_key)
);
-- Billing the patient after insurance (autobill.js): one row per closed claim the autopilot looked at, for the
-- account (guarantor) that owes. 'active' bills are sent by the cadence engine (type patient_balance) with a pay
-- link; one active bill per account (a later claim is 'merged' into it); 'skipped' says why not (nothing owed,
-- below the minimum, on a payment plan). paper_status tracks the one mailed statement (claimed before sending).
-- amount is what the account owed when it started — the balance itself always comes from the ledger.
CREATE TABLE IF NOT EXISTS balance_bills (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  claim_id INTEGER NOT NULL REFERENCES claims(id),
  location_id INTEGER REFERENCES locations(id),
  closed_on TEXT NOT NULL,
  anchor_date TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid','stopped','done','skipped','merged')),
  stop_reason TEXT,
  merged_into_id INTEGER REFERENCES balance_bills(id),
  last_sent_at TEXT,
  link_opened_at TEXT,
  payment_request_id INTEGER REFERENCES payment_requests(id),
  paper_status TEXT CHECK (paper_status IN ('sending','sent','to_print','failed')),
  paper_attempts INTEGER NOT NULL DEFAULT 0,
  paper_reference TEXT,
  paper_error TEXT,
  paper_at TEXT,
  statement_run_id INTEGER REFERENCES statement_runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  UNIQUE (claim_id)
);
-- Insurance verification center (IV1–IV4, verification.js / planverify.js). One row per verified benefit
-- breakdown: how (method), by whom (verified_by, source, actor), what it changed on the plan and so for everyone
-- on it (plan_changes before/after, patients_updated), the patient's own amounts (patient_detail), and — when the
-- plan's identity wasn't certain — the plan-level changes waiting for a person (group_status 'review', proposed).
-- Rows are never deleted; only the review decision is filled in later.
CREATE TABLE IF NOT EXISTS benefit_verifications (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  patient_insurance_id INTEGER NOT NULL REFERENCES patient_insurance(id),
  plan_id INTEGER REFERENCES insurance_plans(id),
  location_id INTEGER REFERENCES locations(id),
  method TEXT NOT NULL,
  eligibility_check_id INTEGER REFERENCES eligibility_checks(id),
  document_id INTEGER REFERENCES documents(id),
  read_id INTEGER,
  complete INTEGER NOT NULL DEFAULT 0,
  plan_changes TEXT,
  proposed TEXT,
  patient_detail TEXT,
  evidence TEXT,
  review_reasons TEXT,
  group_status TEXT NOT NULL DEFAULT 'none' CHECK (group_status IN ('none','applied','review','applied_after_review','kept')),
  patients_updated INTEGER NOT NULL DEFAULT 0,
  reference TEXT,
  rep_name TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'human',
  actor TEXT,
  verified_by INTEGER REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A benefit document (payer portal page, fax) read by AI: a draft until a person confirms it field by field
-- (then it becomes a benefit_verifications row) or sets it aside. Never applied on its own.
CREATE TABLE IF NOT EXISTS benefit_reads (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  patient_insurance_id INTEGER NOT NULL REFERENCES patient_insurance(id),
  plan_id INTEGER REFERENCES insurance_plans(id),
  document_id INTEGER REFERENCES documents(id),
  proposed TEXT NOT NULL,
  reason TEXT,
  sandbox INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','discarded')),
  created_by INTEGER REFERENCES users(id),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  verification_id INTEGER REFERENCES benefit_verifications(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The automatic eligibility checks before each visit (days ahead, and the morning of): one row per policy,
-- visit day and window, claimed before the check runs so no pass (or second server) checks it twice. Job
-- bookkeeping: failed rows are retried (attempts) and then become a Needs attention item.
CREATE TABLE IF NOT EXISTS verification_runs (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  patient_insurance_id INTEGER NOT NULL REFERENCES patient_insurance(id),
  appointment_id INTEGER REFERENCES appointments(id),
  visit_date TEXT NOT NULL,
  run_window TEXT NOT NULL CHECK (run_window IN ('ahead','morning')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','skipped','failed')),
  eligibility_check_id INTEGER REFERENCES eligibility_checks(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE (patient_insurance_id, visit_date, run_window)
);
-- Reviews with a feedback screen and team shout-outs (RV1–RV3, reviewfunnel.js, shoutouts.js, docs/reviews.md).
-- Review-request settings, one row per practice. The happy threshold, the automatic-after-visit switch and the
-- Google review link stay on practices (review_threshold, review_requests, review_url). other_sites: JSON
-- [{name, url}] also offered to patients; notify_user_ids: JSON user ids told about private feedback (empty =
-- administrators and anyone with reviews:manage). There is deliberately no setting that hides the public review link.
CREATE TABLE IF NOT EXISTS review_settings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL UNIQUE REFERENCES practices(id),
  throttle_months INTEGER NOT NULL DEFAULT 6,
  channel TEXT NOT NULL DEFAULT 'auto' CHECK (channel IN ('auto','sms','email')),
  other_sites TEXT,
  notify_user_ids TEXT,
  followup_user_id INTEGER REFERENCES users(id),
  points_per_mention INTEGER NOT NULL DEFAULT 10,
  reward_note TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Nicknames staff go by ("Annie", "Dr. Bob") so shout-outs find the right person. Configuration: removing one
-- is a hard delete, audited.
CREATE TABLE IF NOT EXISTS staff_nicknames (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  nickname TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, nickname)
);
-- A staff member named in private feedback or an online review, with the quote. One row per person (match_key
-- 'u<user id>') or unclear name ('n<name>') per piece of feedback (source_key 'feedback:<id>' / 'review:<id>'),
-- so re-checking never double counts. points are fixed when found; positive = 0 for a low rating (kept for
-- coaching, no points). status: counted, needs_match (fits several people: candidate_ids), unlinked (the owner
-- said it wasn't them — kept, never deleted).
CREATE TABLE IF NOT EXISTS review_shoutouts (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  source TEXT NOT NULL CHECK (source IN ('feedback','review')),
  source_key TEXT NOT NULL,
  review_feedback_id INTEGER REFERENCES review_feedback(id),
  review_id INTEGER REFERENCES reviews(id),
  patient_id INTEGER REFERENCES patients(id),
  user_id INTEGER REFERENCES users(id),
  match_key TEXT NOT NULL,
  matched_name TEXT NOT NULL,
  candidate_ids TEXT,
  quote TEXT NOT NULL,
  rating INTEGER,
  positive INTEGER NOT NULL DEFAULT 1,
  points INTEGER NOT NULL DEFAULT 0,
  month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'counted' CHECK (status IN ('counted','needs_match','unlinked')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, source_key, match_key)
);
-- A reward noted for someone's shout-outs in a month ("$25 coffee card"): one per person per month.
CREATE TABLE IF NOT EXISTS review_rewards (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  month TEXT NOT NULL,
  note TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE (practice_id, user_id, month)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_parent ON chat_messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_patient ON chat_messages(patient_id);
CREATE INDEX IF NOT EXISTS idx_chat_mentions_user ON chat_mentions(user_id, seen_at);
CREATE INDEX IF NOT EXISTS idx_task_checklist ON task_checklist_items(task_id);
CREATE INDEX IF NOT EXISTS idx_time_breaks_punch ON time_breaks(punch_id);
CREATE INDEX IF NOT EXISTS idx_time_corrections_punch ON time_punch_corrections(punch_id);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_date ON staff_shifts(practice_id, date);
CREATE INDEX IF NOT EXISTS idx_checklist_items_template ON checklist_items(template_id);
CREATE INDEX IF NOT EXISTS idx_checklist_occ_day ON checklist_occurrences(practice_id, due_date);
CREATE INDEX IF NOT EXISTS idx_checklist_occ_open ON checklist_occurrences(practice_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_checklist_events_occ ON checklist_events(occurrence_id);
CREATE INDEX IF NOT EXISTS idx_pto_requests ON pto_requests(practice_id, user_id, start_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pto_accrual_once ON pto_ledger(user_id, period_start) WHERE kind = 'accrual' AND voided_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pto_used_once ON pto_ledger(request_id) WHERE kind = 'used' AND voided_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_period_approved_once ON pay_period_approvals(user_id, period_start) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_document_notes_doc ON document_notes(document_id, status);
CREATE INDEX IF NOT EXISTS idx_document_terms ON document_terms(practice_id, term);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_drawer_session ON cash_drawer_sessions(drawer_id) WHERE status <> 'closed';
CREATE UNIQUE INDEX IF NOT EXISTS idx_chart_audit_live ON chart_audit_findings(practice_id, visit_key, check_code, subject) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_chart_audit_list ON chart_audit_findings(practice_id, status, visit_date);
CREATE INDEX IF NOT EXISTS idx_chart_checks_visit ON chart_checks(practice_id, visit_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chart_ready_live ON chart_ready(practice_id, visit_key) WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS idx_cadence_steps_seq ON cadence_steps(sequence_id, position);
CREATE INDEX IF NOT EXISTS idx_cadence_enroll_status ON cadence_enrollments(practice_id, status);
CREATE INDEX IF NOT EXISTS idx_cadence_enroll_patient ON cadence_enrollments(patient_id);
CREATE INDEX IF NOT EXISTS idx_cadence_runs_status ON cadence_runs(practice_id, status);
CREATE INDEX IF NOT EXISTS idx_cadence_holds_patient ON cadence_holds(patient_id);
CREATE INDEX IF NOT EXISTS idx_opp_events_practice ON opportunity_events(practice_id, status);
CREATE INDEX IF NOT EXISTS idx_fin_agreements_patient ON fin_agreements(practice_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_consents_patient ON consents(practice_id, patient_id, status);
CREATE INDEX IF NOT EXISTS idx_consents_appt ON consents(appointment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_consents_live ON consents(practice_id, context_key, template_id) WHERE status <> 'superseded';
CREATE INDEX IF NOT EXISTS idx_paperwork_links_packet ON paperwork_links(packet_id);
CREATE INDEX IF NOT EXISTS idx_kiosk_sessions_kiosk ON kiosk_sessions(kiosk_id, status);
CREATE INDEX IF NOT EXISTS idx_edu_deliveries_patient ON education_deliveries(practice_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_online_bookings_created ON online_bookings(practice_id, created_at);
CREATE INDEX IF NOT EXISTS idx_online_booking_events_day ON online_booking_events(practice_id, day);
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_protocols_active ON phone_protocols(practice_id, call_type) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_scores_current ON call_scores(call_id) WHERE status = 'current';
CREATE INDEX IF NOT EXISTS idx_call_scores_practice ON call_scores(practice_id, created_at);
CREATE INDEX IF NOT EXISTS idx_call_reviews_call ON call_reviews(call_id, id);
CREATE INDEX IF NOT EXISTS idx_call_no_book ON call_no_book(practice_id, created_at);
CREATE INDEX IF NOT EXISTS idx_referral_items_ref ON referral_items(referral_id);
CREATE INDEX IF NOT EXISTS idx_referral_events_ref ON referral_events(referral_id, id);
CREATE INDEX IF NOT EXISTS idx_business_cost_profiles ON business_cost_profiles(practice_id, scope, scope_key);
CREATE INDEX IF NOT EXISTS idx_business_provider_pay ON business_provider_pay(practice_id, provider_id);
CREATE INDEX IF NOT EXISTS idx_remit_lines_state ON remit_lines(practice_id, state);
CREATE INDEX IF NOT EXISTS idx_remit_lines_claim ON remit_lines(claim_id);
CREATE INDEX IF NOT EXISTS idx_remit_lines_era ON remit_lines(era_import_id);
CREATE INDEX IF NOT EXISTS idx_remit_lines_paper ON remit_lines(paper_eob_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_bills_one_active ON balance_bills(practice_id, patient_id) WHERE status = 'active';
-- Treatment entry (routes/treatmententry.js, chartengine.js): named packages of procedures charted in one step
-- ("Crown" = crown + optional buildup/post), the office's (user_id null) or one person's own (owner 'u<id>').
-- items is the recipe as JSON: [{ code | work | finding, tooth: same|range|ends|between|none|unsealed_molars,
-- surfaces, area, optional, default_on, phase, label }]. Retired (active 0), never deleted.
CREATE TABLE IF NOT EXISTS procedure_bundles (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER REFERENCES users(id),
  owner TEXT NOT NULL DEFAULT 'office',
  name TEXT NOT NULL,
  alias TEXT,
  items TEXT NOT NULL,
  starter_key TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  retired_at TEXT,
  retired_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE (practice_id, owner, starter_key)
);
-- The chart's quick buttons and typed/spoken aliases ("bu" = D2950 planned): the office's and each person's own,
-- in order; the first nine buttons are Alt+1…9. kind code|work|finding|bundle; target is the code, kind of work
-- or finding (bundle_id for a bundle); mode plan|done|existing. Retired (active 0), never deleted.
CREATE TABLE IF NOT EXISTS chart_shortcuts (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  user_id INTEGER REFERENCES users(id),
  owner TEXT NOT NULL DEFAULT 'office',
  label TEXT NOT NULL,
  alias TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('code','work','finding','bundle')),
  target TEXT NOT NULL,
  bundle_id INTEGER REFERENCES procedure_bundles(id),
  mode TEXT NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan','done','existing')),
  surfaces TEXT,
  color TEXT,
  icon TEXT,
  button INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  starter_key TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  retired_at TEXT,
  retired_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE (practice_id, owner, starter_key)
);

-- Patient preferences (PP1): the practice's list of comfort / care / scheduling preferences (a starter set the
-- office adds to; retired, never deleted), and each patient's own, markable urgent. Removing one keeps the row.
CREATE TABLE IF NOT EXISTS patient_pref_options (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  label TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'comfort' CHECK (category IN ('comfort','care','scheduling','other')),
  starter_key TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  retired_at TEXT,
  retired_by INTEGER REFERENCES users(id),
  UNIQUE (practice_id, starter_key)
);
CREATE TABLE IF NOT EXISTS patient_prefs (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  option_id INTEGER NOT NULL REFERENCES patient_pref_options(id),
  urgent INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  source TEXT NOT NULL DEFAULT 'human',
  added_by INTEGER REFERENCES users(id),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT,
  removed_by INTEGER REFERENCES users(id),
  removed_at TEXT,
  remove_reason TEXT
);
-- Personal connection notes (PP2): "new dog", "went to Disneyland". A timeline; removed notes stay (removed_at).
CREATE TABLE IF NOT EXISTS personal_notes (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  location_id INTEGER REFERENCES locations(id),
  body TEXT NOT NULL,
  client_key TEXT,
  source TEXT NOT NULL DEFAULT 'human',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id),
  remove_reason TEXT
);
-- Doctor's notes to the front desk on the schedule (DN1): on a visit or on an empty slot. open -> acknowledged ->
-- done (turned into a booking or a task: result_kind/result_id), or withdrawn by its author. Never deleted.
CREATE TABLE IF NOT EXISTS schedule_notes (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  kind TEXT NOT NULL CHECK (kind IN ('visit','slot')),
  appointment_id INTEGER REFERENCES appointments(id),
  patient_id INTEGER REFERENCES patients(id),
  provider_id INTEGER REFERENCES providers(id),
  operatory_id INTEGER REFERENCES operatories(id),
  note_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','done','withdrawn')),
  client_key TEXT,
  source TEXT NOT NULL DEFAULT 'human',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acked_by INTEGER REFERENCES users(id),
  acked_at TEXT,
  booking_started_by INTEGER REFERENCES users(id),
  booking_started_at TEXT,
  done_by INTEGER REFERENCES users(id),
  done_at TEXT,
  result_kind TEXT,
  result_id INTEGER,
  withdrawn_by INTEGER REFERENCES users(id),
  withdrawn_at TEXT
);
-- "Provider out today" (S8): one run per click (client_key makes a retry return the same run).
CREATE TABLE IF NOT EXISTS provider_out_runs (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  out_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  goodwill_note TEXT,
  client_key TEXT NOT NULL,
  summary TEXT,
  source TEXT NOT NULL DEFAULT 'human',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, client_key)
);
-- Office-caused moves and cancellations ("we moved them" strikes, S8). A move or cancel counts against the office
-- for that patient; a reassign (same time, another provider) is kept for the report. Mistakes are voided.
CREATE TABLE IF NOT EXISTS office_moves (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  provider_id INTEGER REFERENCES providers(id),
  to_provider_id INTEGER REFERENCES providers(id),
  kind TEXT NOT NULL CHECK (kind IN ('move','cancel','reassign')),
  reason TEXT NOT NULL,
  note TEXT,
  from_time TEXT NOT NULL,
  to_time TEXT,
  happened_on TEXT NOT NULL,
  run_id INTEGER REFERENCES provider_out_runs(id),
  source TEXT NOT NULL DEFAULT 'human',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT,
  UNIQUE (appointment_id, kind, from_time)
);
-- What each appointment card shows (S6): the practice's layout (a person's own override is in user_prefs).
CREATE TABLE IF NOT EXISTS card_layouts (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  layout TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id)
);
-- The office's own labels on a visit ("VIP", "Bring x-rays"): taken off with removed_at, never deleted.
CREATE TABLE IF NOT EXISTS appointment_labels (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  label_key TEXT NOT NULL,
  added_by INTEGER REFERENCES users(id),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  removed_by INTEGER REFERENCES users(id),
  removed_at TEXT
);
-- Treatment follow-up (TF1–TF4, txfollow.js / txletter.js, docs/workflows/specs/TF-treatment-followup.md). The doctor's
-- letter about treatment that hasn't been scheduled: a draft (from the cadence's letter step, or the doctor's own click)
-- that the doctor reviews and approves; only then is it emailed and/or mailed, filed on the chart and recorded as the
-- informed notice. Never deleted: cancelled (no longer needed) or sent. live_key ('plan:<id>') is set while the letter
-- is open (draft, sending, failed) so one plan has one open letter; it is cleared once the letter is sent or cancelled.
CREATE TABLE IF NOT EXISTS txf_letters (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  treatment_plan_id INTEGER NOT NULL REFERENCES treatment_plans(id),
  enrollment_id INTEGER REFERENCES cadence_enrollments(id),
  run_id INTEGER UNIQUE REFERENCES cadence_runs(id),
  provider_id INTEGER REFERENCES providers(id),
  location_id INTEGER REFERENCES locations(id),
  live_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','failed','cancelled')),
  diagnosis TEXT,
  why TEXT,
  risk TEXT,
  treatment TEXT,
  closing TEXT,
  cost INTEGER,
  total_fee INTEGER,
  insurance INTEGER,
  document_id INTEGER REFERENCES documents(id),
  markup TEXT,
  send_email INTEGER NOT NULL DEFAULT 1,
  send_mail INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'automation',
  ai_drafted INTEGER NOT NULL DEFAULT 0,
  ai_reason TEXT,
  link_hash TEXT,
  link_expires_at TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  sent_at TEXT,
  email_status TEXT,
  email_message_id INTEGER REFERENCES messages(id),
  mail_status TEXT,
  mail_reference TEXT,
  mail_expected TEXT,
  print_task_id INTEGER REFERENCES tasks(id),
  filed_document_id INTEGER REFERENCES documents(id),
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancel_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txf_letters_status ON txf_letters(practice_id, status);
-- How a doctor signs the letter: credentials (DDS), a line under the name, the closing, and the signature image (an
-- encrypted file in document storage, like documents). Configuration: edited in place, every change audited.
CREATE TABLE IF NOT EXISTS txf_doctors (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  provider_id INTEGER NOT NULL UNIQUE REFERENCES providers(id),
  credentials TEXT,
  title TEXT,
  closing TEXT,
  signature_key TEXT,
  signature_mime TEXT,
  signature_encrypted INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The letterhead: the practice's color and logo (a stored file). Unset falls back to the online scheduling branding.
CREATE TABLE IF NOT EXISTS txf_settings (
  practice_id INTEGER PRIMARY KEY REFERENCES practices(id),
  brand_color TEXT,
  logo_key TEXT,
  logo_mime TEXT,
  logo_encrypted INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- X-ray AI (XR1-XR2): every time an image was sent to the detection vendor (Pearl, Overjet, VideaHealth or the
-- sandbox) and what came back: why (upload, by hand, the pre-appointment second look), whether it worked, how
-- many findings, the vendor's reference. Reconciles images sent vs read, and lets the second look back off
-- after a failure. No image data or patient details are kept here.
CREATE TABLE IF NOT EXISTS xray_ai_reads (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER REFERENCES patients(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  engine TEXT NOT NULL,
  read_for TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  findings INTEGER NOT NULL DEFAULT 0,
  vendor_ref TEXT,
  error TEXT,
  requested_by INTEGER REFERENCES users(id),
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_xray_ai_reads_doc ON xray_ai_reads(document_id, created_at);
CREATE INDEX IF NOT EXISTS idx_xray_ai_reads_practice ON xray_ai_reads(practice_id, created_at);
-- Team bonus module (BN1-BN3: bonus.js, routes/bonus.js, docs/workflows/specs/BN-bonus.md). Off until the owner
-- turns it on. Configuration: one row per practice, changes audited.
CREATE TABLE IF NOT EXISTS bonus_settings (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL UNIQUE REFERENCES practices(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  show_dashboard INTEGER NOT NULL DEFAULT 1,
  show_schedule INTEGER NOT NULL DEFAULT 1,
  pay_type_label TEXT NOT NULL DEFAULT 'Bonus',
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A bonus plan (one of the plan types). Never deleted: status active / off / archived. Its rules live in versions.
CREATE TABLE IF NOT EXISTS bonus_plans (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  type TEXT NOT NULL CHECK (type IN ('team_collections','daily_goal','spiff','provider_pct','scorecard','front_desk')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'off' CHECK (status IN ('active','off','archived')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Each change to a plan's rules is a new, never-edited version with the date it takes effect from. A period uses
-- the newest version in effect on its first day.
CREATE TABLE IF NOT EXISTS bonus_plan_versions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  plan_id INTEGER NOT NULL REFERENCES bonus_plans(id),
  version INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  config TEXT NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (plan_id, version)
);
-- The owner's approval of one plan's period: the whole calculation as it stood (detail + hash), the pay period
-- whose payroll export carries it, and who approved. Reopened (with a reason), never deleted; at most one live
-- approval per plan and period (partial unique index), so approving twice is harmless.
CREATE TABLE IF NOT EXISTS bonus_approvals (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  plan_id INTEGER NOT NULL REFERENCES bonus_plans(id),
  plan_version_id INTEGER NOT NULL REFERENCES bonus_plan_versions(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','reopened')),
  earned_cents INTEGER NOT NULL DEFAULT 0,
  cap_cut_cents INTEGER NOT NULL DEFAULT 0,
  clawback_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  people INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  detail_hash TEXT,
  payroll_period_start TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  reopened_by INTEGER REFERENCES users(id),
  reopened_at TEXT,
  reopen_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One person's line in an approval: earned, cut by a cap, taken back for earlier periods (clawbacks: JSON
-- [{ approval_id, cents }]) and what is paid. Never edited.
CREATE TABLE IF NOT EXISTS bonus_payout_lines (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  approval_id INTEGER NOT NULL REFERENCES bonus_approvals(id),
  plan_id INTEGER NOT NULL REFERENCES bonus_plans(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  period_start TEXT NOT NULL,
  earned_cents INTEGER NOT NULL DEFAULT 0,
  cap_cut_cents INTEGER NOT NULL DEFAULT 0,
  clawback_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER NOT NULL DEFAULT 0,
  clawbacks TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (approval_id, user_id)
);
-- Billing autopilot (backlog BL1-BL5, billingauto.js; spec docs/workflows/specs/BL-billing.md).
-- The practice's billing switches: the processor, passing card costs on (a surcharge on credit cards or a flat
-- convenience fee, in basis points / cents), the retry schedule for declined charges and the expiring-card notice.
CREATE TABLE IF NOT EXISTS billing_settings (
  practice_id INTEGER PRIMARY KEY REFERENCES practices(id),
  processor TEXT NOT NULL DEFAULT 'stripe',
  pass_through TEXT NOT NULL DEFAULT 'off' CHECK (pass_through IN ('off','surcharge','convenience_fee')),
  surcharge_bps INTEGER NOT NULL DEFAULT 0,
  processing_cost_bps INTEGER NOT NULL DEFAULT 0,
  convenience_fee INTEGER NOT NULL DEFAULT 0,
  processor_notified INTEGER NOT NULL DEFAULT 0,
  retry_days TEXT NOT NULL DEFAULT '[3,7,14]',
  expiring_days INTEGER NOT NULL DEFAULT 30,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Office fees the practice defines: a fixed amount or a % (basis points) of what's collectible, when it applies,
-- caps and whether staff may waive it. Configuration: never deleted (active = 0), every change audited.
CREATE TABLE IF NOT EXISTS billing_fees (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fixed','percent')),
  amount INTEGER NOT NULL DEFAULT 0,
  pct_bps INTEGER NOT NULL DEFAULT 0,
  occasion TEXT NOT NULL CHECK (occasion IN ('plan_setup','late_payment','returned_payment','missed_appointment','statement','manual')),
  applies TEXT NOT NULL DEFAULT 'offered' CHECK (applies IN ('automatic','offered')),
  min_amount INTEGER,
  max_amount INTEGER,
  max_per_year INTEGER,
  grace_days INTEGER NOT NULL DEFAULT 0,
  waivable INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Each fee put on an account: once per fee per occasion (source_key: the plan installment, the missed visit, the
-- statement, the returned payment), its own ledger line; a waiver is a reversing entry with a reason.
CREATE TABLE IF NOT EXISTS billing_fee_charges (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  fee_id INTEGER NOT NULL REFERENCES billing_fees(id),
  source_key TEXT NOT NULL,
  basis INTEGER,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','waived')),
  ledger_entry_id INTEGER REFERENCES ledger_entries(id),
  reversal_entry_id INTEGER REFERENCES ledger_entries(id),
  waived_by INTEGER REFERENCES users(id),
  waive_reason TEXT,
  waived_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (fee_id, source_key)
);
-- The patient's signed OK for automatic charges: the exact words shown (and their hash), who agreed, how, when.
-- Pending ones (sent by text link) carry the set-up to create once the patient agrees. Never edited once signed.
CREATE TABLE IF NOT EXISTS billing_authorizations (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  kind TEXT NOT NULL CHECK (kind IN ('payment_plan','recurring','membership','ortho_case')),
  source_id INTEGER,
  payment_method_id INTEGER REFERENCES payment_methods(id),
  setup TEXT NOT NULL,
  terms TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  surcharge_bps INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed','revoked','expired')),
  signer_name TEXT,
  signature_image TEXT,
  signed_via TEXT,
  signed_at TEXT,
  ip TEXT,
  user_agent TEXT,
  revoked_at TEXT,
  revoked_by INTEGER REFERENCES users(id),
  revoke_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (patient_id, terms_hash)
);
-- A recurring card charge of a set amount (never more than the account owes), on a day of the month.
CREATE TABLE IF NOT EXISTS recurring_charges (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  amount INTEGER NOT NULL,
  day_of_month INTEGER NOT NULL,
  next_charge_date TEXT NOT NULL,
  end_date TEXT,
  max_charges INTEGER,
  charges_made INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  payment_method_id INTEGER REFERENCES payment_methods(id),
  authorization_id INTEGER REFERENCES billing_authorizations(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','cancelled')),
  last_message TEXT,
  charge_lock TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Every automatic card charge attempt (plans, memberships, ortho, recurring, set-up down payments): what was tried,
-- the surcharge decided on the first try (a retry with the same key charges the same total), and the answer.
CREATE TABLE IF NOT EXISTS billing_attempts (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  source_type TEXT NOT NULL,
  source_id INTEGER,
  payment_method_id INTEGER REFERENCES payment_methods(id),
  amount INTEGER NOT NULL,
  surcharge INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','declined','unclear')),
  reason TEXT,
  reference TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Dunning: a declined automatic charge being retried on the schedule, then paused for the team. One open row per
-- plan / membership / ortho case / recurring charge (live_key), closed when a charge goes through or a person stops it.
CREATE TABLE IF NOT EXISTS billing_dunning (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  payment_method_id INTEGER REFERENCES payment_methods(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'retrying' CHECK (status IN ('retrying','paused','recovered','stopped')),
  failures INTEGER NOT NULL DEFAULT 1,
  first_failed_on TEXT NOT NULL,
  last_failed_on TEXT NOT NULL,
  next_retry_on TEXT,
  last_reason TEXT,
  patient_notified_at TEXT,
  team_notified_at TEXT,
  paused_at TEXT,
  closed_at TEXT,
  close_note TEXT,
  closed_by INTEGER REFERENCES users(id),
  live_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Secure links sent to a patient: update the card (after a decline, or before it expires) or agree to a set-up.
-- Only a hash of the token is kept. A derived convenience: expired links can be purged.
CREATE TABLE IF NOT EXISTS billing_links (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  kind TEXT NOT NULL CHECK (kind IN ('update_card','authorize')),
  token_hash TEXT NOT NULL UNIQUE,
  old_method_id INTEGER REFERENCES payment_methods(id),
  new_method_id INTEGER REFERENCES payment_methods(id),
  authorization_id INTEGER REFERENCES billing_authorizations(id),
  dunning_id INTEGER REFERENCES billing_dunning(id),
  message_id INTEGER REFERENCES messages(id),
  expires_at TEXT NOT NULL,
  opened_at TEXT,
  used_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- "Your card expires soon" requests: once per card per expiry date (notice_key).
CREATE TABLE IF NOT EXISTS billing_notices (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  payment_method_id INTEGER REFERENCES payment_methods(id),
  kind TEXT NOT NULL,
  notice_key TEXT NOT NULL UNIQUE,
  link_id INTEGER REFERENCES billing_links(id),
  message_id INTEGER REFERENCES messages(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Card disputes (chargebacks) and refunds made at the processor, each posted once (processor_id) as a reversal.
CREATE TABLE IF NOT EXISTS billing_disputes (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  patient_id INTEGER REFERENCES patients(id),
  kind TEXT NOT NULL CHECK (kind IN ('dispute','refund')),
  processor_id TEXT NOT NULL UNIQUE,
  payment_reference TEXT,
  payment_entry_id INTEGER REFERENCES ledger_entries(id),
  reversal_entry_id INTEGER REFERENCES ledger_entries(id),
  restored_entry_id INTEGER REFERENCES ledger_entries(id),
  amount INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','posted','unmatched')),
  respond_by TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The daily check of the processor against the ledger (charges and payouts) for one practice day.
CREATE TABLE IF NOT EXISTS billing_recon_days (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  day TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  processor_total INTEGER NOT NULL DEFAULT 0,
  ledger_total INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  exceptions INTEGER NOT NULL DEFAULT 0,
  payouts INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, day)
);
-- Benchmarks across practices (BM1-BM5; benchmarks.js). Off by default: the owner joins, and can leave at any time.
-- The participant id and keys are random (the service never learns the practice's name); the signing key is sealed
-- with the app secret. last_results is the latest answer from the service (derived; the monthly email reads it).
CREATE TABLE IF NOT EXISTS bm_settings (
  practice_id INTEGER PRIMARY KEY REFERENCES practices(id),
  status TEXT NOT NULL DEFAULT 'off' CHECK (status IN ('off','joined','leaving','left')),
  participant_id TEXT,
  practice_key TEXT,
  practice_code TEXT,
  public_key TEXT,
  signing_secret TEXT,
  practice_type TEXT NOT NULL DEFAULT 'general',
  founded_year INTEGER,
  share_labor INTEGER NOT NULL DEFAULT 0,
  terms_version TEXT,
  joined_at TEXT,
  joined_by INTEGER REFERENCES users(id),
  left_at TEXT,
  left_by INTEGER REFERENCES users(id),
  last_sent_at TEXT,
  last_results TEXT,
  last_results_month TEXT,
  last_results_at TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Per provider: the random key and "Dr. #4821" code sent instead of their name, and whether the doctor chose to be
-- named (only the doctor can turn that on; they or an administrator can turn it off).
CREATE TABLE IF NOT EXISTS bm_providers (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  provider_id INTEGER NOT NULL UNIQUE REFERENCES providers(id),
  provider_key TEXT NOT NULL,
  anon_code TEXT NOT NULL,
  show_name INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  name_set_by INTEGER REFERENCES users(id),
  name_set_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Everything that left the building for the benchmark service: the exact signed text, when, why, and what came back
-- (receipt, rows accepted: reconciled against rows sent). Kept so the owner can see exactly what was shared. Never
-- edited after it finishes, never deleted. The nightly send is claimed once per practice-local day.
CREATE TABLE IF NOT EXISTS bm_sends (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  kind TEXT NOT NULL CHECK (kind IN ('join','submit','leave')),
  cause TEXT NOT NULL DEFAULT 'nightly' CHECK (cause IN ('nightly','manual','join','leave')),
  send_date TEXT,
  months TEXT,
  rows INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  destination TEXT,
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','failed')),
  http_status INTEGER,
  receipt TEXT,
  accepted_rows INTEGER,
  error TEXT,
  source TEXT NOT NULL DEFAULT 'automation',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bm_sends_practice ON bm_sends(practice_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bm_sends_nightly ON bm_sends(practice_id, send_date) WHERE cause = 'nightly' AND status != 'failed';
`;

// Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS, so check first.
const COLUMNS = [
  // Billing autopilot (billingauto.js): a card's funding (credit / debit / prepaid — surcharges never on debit) and
  // the pass-through fee disclosed and added to an online payment.
  ['payment_methods', 'funding', 'TEXT'],
  ['payment_requests', 'fee_amount', 'INTEGER NOT NULL DEFAULT 0'],
  ['payment_requests', 'fee_kind', 'TEXT'],
  // Team bonus module (bonus.js): approved bonuses carried by a payroll file (a separate pay type, in cents).
  ['payroll_exports', 'bonus_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['payroll_exports', 'bonus_detail', 'TEXT'],
  // Treatment follow-up (txfollow.js): the practice's switch, the oldest diagnosis date it picks up, a plan's urgency.
  ['practices', 'treatment_cadence', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'treatment_cadence_from', 'TEXT'],
  ['treatment_plans', 'followup_urgency', 'TEXT'],
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
  ['perio_exams', 'deleted_at', 'TEXT'],
  ['patients', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['treatment_plans', 'sign_token_failures', 'INTEGER NOT NULL DEFAULT 0'],
  ['form_requests', 'dob_failures', 'INTEGER NOT NULL DEFAULT 0'],
  ['documents', 'adjust', 'TEXT'],
  ['documents', 'exposure', 'TEXT'],
  ['documents', 'retake_of', 'INTEGER'],
  ['bridge_agents', 'sensor_info', 'TEXT'],
  ['bridge_commands', 'progress', 'TEXT'],
  ['bridge_commands', 'result_key', 'TEXT'],
  ['documents', 'scale_source', 'TEXT'],
  ['bridge_agents', 'mm_per_px', 'REAL'],
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
  // The bridge's own self-check (programs, folders, sensor, uploads) from its last check-in.
  ['bridge_agents', 'checks', 'TEXT'],
  ['bridge_agents', 'checked_at', 'TEXT'],
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
  // Confirmations: a notice owed for a new or moved visit ('booked' | 'moved'), the missed-visit text,
  // delivery reports, contact details that stopped working, and each practice's sending rules.
  ['appointments', 'notice_due', 'TEXT'],
  ['appointments', 'no_show_msg_at', 'TEXT'],
  ['messages', 'delivery', 'TEXT'],
  ['messages', 'error_code', 'TEXT'],
  ['patients', 'sms_bad_at', 'TEXT'],
  ['patients', 'sms_bad_reason', 'TEXT'],
  ['patients', 'email_bad_at', 'TEXT'],
  ['patients', 'email_bad_reason', 'TEXT'],
  ['practices', 'send_from', "TEXT NOT NULL DEFAULT '08:00'"],
  ['practices', 'send_until', "TEXT NOT NULL DEFAULT '20:00'"],
  ['practices', 'booking_notices', 'INTEGER NOT NULL DEFAULT 1'],
  ['practices', 'no_show_texts', 'INTEGER NOT NULL DEFAULT 1'],
  ['documents', 'ai_read_at', 'TEXT'],
  ['documents', 'ai_image_type', 'TEXT'],
  ['documents', 'ai_quality', 'TEXT'],
  ['practices', 'xray_ai_auto', 'INTEGER NOT NULL DEFAULT 1'],
  ['practices', 'auto_fill', 'INTEGER NOT NULL DEFAULT 1'],
  ['practices', 'fill_batch', 'INTEGER NOT NULL DEFAULT 5'],
  ['practices', 'confirm_calls', 'INTEGER NOT NULL DEFAULT 0'],
  ['insurance_plans', 'missing_tooth_clause', 'INTEGER NOT NULL DEFAULT 0'],
  // The office phone line: the Twilio number calls come in on, the desk phone it rings, recording, the
  // missed-call text and when the AI receptionist answers ('off' | 'after_hours' | 'missed' | 'always').
  // A group of practices (a DSO or several offices under one owner): rollups and shared setup.
  ['practices', 'organization_id', 'INTEGER'],
  // DSO central billing: a group member who works the billing queues and cross-practice patient lookup
  // (owners always can). And the group role template a practice's custom role was made from.
  ['org_members', 'billing', 'INTEGER NOT NULL DEFAULT 0'],
  ['custom_roles', 'org_template_id', 'INTEGER'],
  ['practices', 'voice_number', 'TEXT'],
  ['practices', 'forward_to', 'TEXT'],
  ['practices', 'ring_seconds', 'INTEGER NOT NULL DEFAULT 20'],
  ['practices', 'record_calls', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'missed_call_text', 'INTEGER NOT NULL DEFAULT 1'],
  ['practices', 'ai_receptionist', "TEXT NOT NULL DEFAULT 'off'"],
  ['practices', 'voicemail_greeting', 'TEXT'],
  ['insurance_carriers', 'timely_filing_days', 'INTEGER'],
  // Digital lab Rx: the prescription, its files from the chart, and the lab's private link and updates.
  ['booking_requests', 'source', 'TEXT'],
  // The audit trail: who or what acted (a person, the AI, an automation, the API, an import, an integration,
  // a patient), for which patient and office, why, and each changed field's before and after.
  ['audit_log', 'source', 'TEXT'],
  ['audit_log', 'actor', 'TEXT'],
  ['audit_log', 'patient_id', 'INTEGER'],
  ['audit_log', 'location_id', 'INTEGER'],
  ['audit_log', 'reason', 'TEXT'],
  ['audit_log', 'changes', 'TEXT'],
  // Nothing important is hard-deleted: merged charts are archived and point at the kept one; removed rows keep who, when and why.
  ['patients', 'merged_into_id', 'INTEGER REFERENCES patients(id)'],
  ['tooth_conditions', 'voided_at', 'TEXT'],
  ['tooth_conditions', 'voided_by', 'INTEGER REFERENCES users(id)'],
  ['tooth_conditions', 'void_reason', 'TEXT'],
  ['claim_attachments', 'removed_at', 'TEXT'],
  ['claim_attachments', 'removed_by', 'INTEGER REFERENCES users(id)'],
  ['deposits', 'voided_at', 'TEXT'],
  ['deposits', 'voided_by', 'INTEGER REFERENCES users(id)'],
  ['deposits', 'void_reason', 'TEXT'],
  ['time_punches', 'deleted_at', 'TEXT'],
  ['time_punches', 'deleted_by', 'INTEGER REFERENCES users(id)'],
  ['time_punches', 'delete_reason', 'TEXT'],
  ['ortho_visits', 'deleted_at', 'TEXT'],
  ['ortho_visits', 'deleted_by', 'INTEGER REFERENCES users(id)'],
  ['webhook_endpoints', 'removed_at', 'TEXT'],
  // The AI receptionist only discusses a patient's visits after the caller proves who they are (caller ID can be spoofed).
  ['calls', 'ai_verified_patient_id', 'INTEGER REFERENCES patients(id)'],
  ['calls', 'ai_verify_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  // A password set by an administrator works once: the person chooses their own at the next sign-in.
  ['users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0'],
  // Portal sessions started before this (unix seconds) no longer work: set when the patient signs out.
  ['patients', 'portal_signed_out_at', 'INTEGER'],
  // When a prescriber's linked login or DEA number last changed: controlled substances wait 24 hours after.
  ['providers', 'epcs_changed_at', 'TEXT'],
  // The office each record belongs to (filled from the visit, the office being worked in, or the patient's home office).
  ['procedures', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['claims', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['clinical_notes', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['messages', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['calls', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['documents', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['prescriptions', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['practices', 'onboarding_dismissed', 'INTEGER NOT NULL DEFAULT 0'],
  ['appointments', 'checked_in_via', 'TEXT'],
  ['appointments', 'ready_texted_at', 'TEXT'],
  // "Ready" in the patient flow (arrived → seated → ready → out) without widening the status CHECK:
  // when the patient in the chair became ready, and for whom ('doctor' for the exam, or 'checkout').
  ['appointments', 'ready_at', 'TEXT'],
  ['appointments', 'ready_for', 'TEXT'],
  // Why a visit was cancelled or missed (workflow 19): a code from the short list (BROKEN_REASONS in
  // routes/schedule.js) and, for "other", a few words. Cleared if the visit is put back on the schedule.
  ['appointments', 'broken_reason', 'TEXT'],
  ['appointments', 'broken_note', 'TEXT'],
  ['lab_cases', 'rx', 'TEXT'],
  ['lab_cases', 'document_ids', 'TEXT'],
  ['lab_cases', 'lab_token_hash', 'TEXT'],
  ['lab_cases', 'lab_link_expires', 'TEXT'],
  ['lab_cases', 'rx_sent_at', 'TEXT'],
  ['lab_cases', 'lab_viewed_at', 'TEXT'],
  ['lab_cases', 'lab_status', 'TEXT'],
  ['lab_cases', 'lab_note', 'TEXT'],
  ['lab_cases', 'lab_updated_at', 'TEXT'],
  ['lab_cases', 'tracking_number', 'TEXT'],
  ['calls', 'caller_name', 'TEXT'],
  ['calls', 'source', 'TEXT'],
  ['calls', 'new_caller', 'INTEGER NOT NULL DEFAULT 0'],
  ['calls', 'ai_turns', 'TEXT'],
  ['calls', 'recording_key', 'TEXT'],
  ['calls', 'recording_encrypted', 'INTEGER NOT NULL DEFAULT 0'],
  ['calls', 'reason', 'TEXT'],
  ['calls', 'follow_up', 'INTEGER NOT NULL DEFAULT 0'],
  ['calls', 'handled_at', 'TEXT'],
  ['calls', 'handled_by', 'INTEGER REFERENCES users(id)'],
  ['calls', 'texted_back_at', 'TEXT'],
  ['calls', 'notes', 'TEXT'],
  ['insurance_plans', 'age_limits', 'TEXT'],
  ['insurance_plans', 'benefit_notes', 'TEXT'],
  ['insurance_plans', 'verified_at', 'TEXT'],
  ['insurance_plans', 'verified_source', 'TEXT'],
  // Who ticked a task off (workflow 28), next to completed_at; cleared again if it's reopened.
  ['tasks', 'completed_by', 'INTEGER REFERENCES users(id)'],
  ['practices', 'late_minutes', 'INTEGER NOT NULL DEFAULT 5'],
  ['practices', 'very_late_minutes', 'INTEGER NOT NULL DEFAULT 10'],
  ['practices', 'digest_settings', 'TEXT'],
  ['tasks', 'chat_message_id', 'INTEGER REFERENCES chat_messages(id)'],
  ['time_punches', 'clock_in_utc', 'TEXT'],
  ['time_punches', 'clock_out_utc', 'TEXT'],
  ['time_punches', 'eff_in', 'TEXT'],
  ['time_punches', 'eff_out', 'TEXT'],
  ['time_punches', 'eff_break', 'INTEGER'],
  ['time_punches', 'corrected', 'INTEGER NOT NULL DEFAULT 0'],
  ['time_punches', 'source', 'TEXT'],
  ['time_punches', 'kiosk_id', 'INTEGER REFERENCES timeclock_kiosks(id)'],
  ['time_punches', 'in_device', 'TEXT'],
  ['time_punches', 'in_ip', 'TEXT'],
  ['time_punches', 'out_device', 'TEXT'],
  ['time_punches', 'out_ip', 'TEXT'],
  ['time_punches', 'in_flag', 'TEXT'],
  ['time_punches', 'in_flag_minutes', 'INTEGER'],
  ['time_punches', 'out_flag', 'TEXT'],
  ['time_punches', 'out_flag_minutes', 'INTEGER'],
  ['time_punches', 'shift_start', 'TEXT'],
  ['time_punches', 'shift_end', 'TEXT'],
  ['practices', 'recording_retention_days', 'INTEGER NOT NULL DEFAULT 90'],
  ['practices', 'recall_cadence', 'INTEGER NOT NULL DEFAULT 0'],
  ['documents', 'folder', 'TEXT'],
  ['documents', 'appointment_id', 'INTEGER REFERENCES appointments(id)'],
  ['documents', 'claim_id', 'INTEGER REFERENCES claims(id)'],
  ['documents', 'treatment_plan_id', 'INTEGER REFERENCES treatment_plans(id)'],
  ['documents', 'ocr_status', 'TEXT'],
  ['documents', 'ocr_source', 'TEXT'],
  ['documents', 'ocr_key', 'TEXT'],
  ['documents', 'ocr_encrypted', 'INTEGER NOT NULL DEFAULT 0'],
  ['documents', 'ocr_chars', 'INTEGER'],
  ['documents', 'ocr_at', 'TEXT'],
  ['documents', 'ocr_error', 'TEXT'],
  ['documents', 'suggested_category', 'TEXT'],
  ['documents', 'suggestion_reason', 'TEXT'],
  ['documents', 'suggestion_source', 'TEXT'],
  ['documents', 'review_status', 'TEXT'],
  ['documents', 'review_assignee', 'INTEGER REFERENCES users(id)'],
  ['documents', 'review_task_id', 'INTEGER REFERENCES tasks(id)'],
  ['documents', 'review_note', 'TEXT'],
  ['documents', 'review_requested_by', 'INTEGER REFERENCES users(id)'],
  ['documents', 'review_requested_at', 'TEXT'],
  ['documents', 'reviewed_by', 'INTEGER REFERENCES users(id)'],
  ['documents', 'reviewed_at', 'TEXT'],
  ['documents', 'expires_on', 'TEXT'],
  ['documents', 'expiry_task_id', 'INTEGER REFERENCES tasks(id)'],
  ['documents', 'virus_status', 'TEXT'],
  ['documents', 'inbox', 'INTEGER NOT NULL DEFAULT 0'],
  ['bridge_agents', 'scanner', 'TEXT'],
  ['bridge_agents', 'scanner_info', 'TEXT'],
  ['practices', 'document_ai', 'INTEGER NOT NULL DEFAULT 1'],
  ['practices', 'capacity_targets', 'TEXT'],
  ['form_templates', 'library_key', 'TEXT'],
  ['form_templates', 'fields_es', 'TEXT'],
  ['form_templates', 'procedure_categories', 'TEXT'],
  ['form_templates', 'witness', 'INTEGER NOT NULL DEFAULT 0'],
  ['form_templates', 'due_rule', 'TEXT'],
  ['form_templates', 'legal_review', 'INTEGER NOT NULL DEFAULT 0'],
  ['form_templates', 'education_slugs', 'TEXT'],
  ['form_requests', 'consent_id', 'INTEGER REFERENCES consents(id)'],
  ['form_requests', 'kiosk_session_id', 'INTEGER REFERENCES kiosk_sessions(id)'],
  ['patient_forms', 'version_id', 'INTEGER REFERENCES form_template_versions(id)'],
  ['patient_forms', 'content_hash', 'TEXT'],
  ['patient_forms', 'lang', 'TEXT'],
  ['patient_forms', 'signer_relationship', 'TEXT'],
  ['patient_forms', 'witness_user_id', 'INTEGER REFERENCES users(id)'],
  ['patient_forms', 'witness_name', 'TEXT'],
  ['patient_forms', 'signed_via', 'TEXT'],
  ['patient_forms', 'device', 'TEXT'],
  ['patient_forms', 'appointment_id', 'INTEGER REFERENCES appointments(id)'],
  ['patient_forms', 'consent_id', 'INTEGER REFERENCES consents(id)'],
  ['patient_forms', 'kiosk_session_id', 'INTEGER REFERENCES kiosk_sessions(id)'],
  ['procedures', 'consent_id', 'INTEGER REFERENCES consents(id)'],
  ['procedures', 'consented_at', 'TEXT'],
  ['practices', 'paperwork_autopilot', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'paperwork_days', 'INTEGER NOT NULL DEFAULT 3'],
  ['practices', 'paperwork_reminders', 'INTEGER NOT NULL DEFAULT 2'],
  ['practices', 'paperwork_remind_hours', 'INTEGER NOT NULL DEFAULT 24'],
  ['practices', 'history_renew_months', 'INTEGER NOT NULL DEFAULT 12'],
  ['education_articles', 'topic', 'TEXT'],
  ['education_articles', 'video_url', 'TEXT'],
  ['education_articles', 'postop', 'TEXT'],
  ['booking_requests', 'online_booking_id', 'INTEGER REFERENCES online_bookings(id)'],
  ['booking_requests', 'visit_type_id', 'INTEGER REFERENCES online_visit_types(id)'],
  ['booking_requests', 'possible_duplicate_id', 'INTEGER REFERENCES patients(id)'],
  ['booking_requests', 'operatory_id', 'INTEGER REFERENCES operatories(id)'],
  ['booking_requests', 'urgent', 'INTEGER NOT NULL DEFAULT 0'],
  ['booking_requests', 'answers', 'TEXT'],
  ['booking_requests', 'card_files', 'TEXT'],
  ['booking_requests', 'asap', 'INTEGER NOT NULL DEFAULT 0'],
  // Marketing ROI (docs/marketing.md): promo code / referral link on an online booking; a patient's first and last
  // touch (marketing_touches ids) and whether a person pinned them.
  ['online_bookings', 'promo_code', 'TEXT'],
  ['online_bookings', 'referral_code', 'TEXT'],
  ['patients', 'marketing_first_touch_id', 'INTEGER'],
  ['patients', 'marketing_last_touch_id', 'INTEGER'],
  ['patients', 'marketing_pinned', 'INTEGER NOT NULL DEFAULT 0'],
  ['appointments', 'online_booking_id', 'INTEGER REFERENCES online_bookings(id)'],
  // Visit readiness and the schedule optimizer.
  ['lab_cases', 'check_status', 'TEXT'],
  ['lab_cases', 'checked_at', 'TEXT'],
  ['lab_cases', 'promised_date', 'TEXT'],
  ['practices', 'readiness_settings', 'TEXT'],
  ['practices', 'optimizer_ai', 'INTEGER NOT NULL DEFAULT 0'],
  ['practices', 'eob_autopilot', 'TEXT'],
  ['practices', 'fin_options', 'TEXT'],
  ['calls', 'agent_id', 'INTEGER REFERENCES users(id)'],
  ['calls', 'agent_source', 'TEXT'],
  ['calls', 'answered_at', 'TEXT'],
  ['calls', 'ring_seconds', 'INTEGER'],
  ['calls', 'call_type', 'TEXT'],
  ['calls', 'appointment_id', 'INTEGER REFERENCES appointments(id)'],
  ['calls', 'linked_via', 'TEXT'],
  ['calls', 'desk_result', 'TEXT'],
  ['recall_types', 'age_until', 'INTEGER'],
  ['recall_types', 'adult_key', 'TEXT'],
  ['recall_types', 'retires', 'TEXT'],
  ['recall_types', 'bundle', 'INTEGER NOT NULL DEFAULT 0'],
  ['recalls', 'last_done_date', 'TEXT'],
  ['recalls', 'last_done_code', 'TEXT'],
  ['recalls', 'last_done_source', 'TEXT'],
  ['recalls', 'last_done_location_id', 'INTEGER'],
  ['recalls', 'interval_overridden', 'INTEGER NOT NULL DEFAULT 0'],
  ['recalls', 'interval_reason', 'TEXT'],
  ['recalls', 'status_reason', 'TEXT'],
  ['practices', 'recall_due_soon_days', 'INTEGER NOT NULL DEFAULT 30'],
  ['practices', 'recall_overdue_days', 'INTEGER NOT NULL DEFAULT 30'],
  ['referrals', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['referrals', 'expected_by', 'TEXT'],
  ['referrals', 'scheduled_on', 'TEXT'],
  ['referrals', 'seen_on', 'TEXT'],
  ['referrals', 'report_received_on', 'TEXT'],
  ['referrals', 'closed_at', 'TEXT'],
  ['referrals', 'close_reason', 'TEXT'],
  ['referrals', 'close_note', 'TEXT'],
  ['referrals', 'closed_by', 'INTEGER REFERENCES users(id)'],
  ['referrals', 'report_document_id', 'INTEGER REFERENCES documents(id)'],
  ['referrals', 'report_reviewed_at', 'TEXT'],
  ['referrals', 'report_reviewed_by', 'INTEGER REFERENCES users(id)'],
  ['referrals', 'review_task_id', 'INTEGER REFERENCES tasks(id)'],
  ['referrals', 'critical_alerted_on', 'TEXT'],
  ['referrals', 'critical_alerts', 'INTEGER NOT NULL DEFAULT 0'],
  ['referrals', 'nudged_on', 'TEXT'],
  ['referrals', 'nudge_task_id', 'INTEGER REFERENCES tasks(id)'],
  ['referrals', 'owner_id', 'INTEGER REFERENCES users(id)'],
  ['referrals', 'client_key', 'TEXT'],
  ['referrals', 'letter_sent_at', 'TEXT'],
  ['referrals', 'letter_sent_via', 'TEXT'],
  ['referrals', 'link_token_hash', 'TEXT'],
  ['referrals', 'link_expires', 'TEXT'],
  ['referrals', 'patient_told_at', 'TEXT'],
  ['referrals', 'thank_you_sent_at', 'TEXT'],
  ['referrals', 'report_back_sent_at', 'TEXT'],
  ['practices', 'verification_settings', 'TEXT'],
  ['review_feedback', 'location_id', 'INTEGER REFERENCES locations(id)'],
  ['review_feedback', 'requested_by', 'INTEGER REFERENCES users(id)'],
  ['review_feedback', 'request_source', 'TEXT'],
  ['review_feedback', 'request_day', 'TEXT'],
  ['review_feedback', 'channel', 'TEXT'],
  ['review_feedback', 'message_id', 'INTEGER REFERENCES messages(id)'],
  ['review_feedback', 'send_status', 'TEXT'],
  ['review_feedback', 'send_error', 'TEXT'],
  ['review_feedback', 'opened_at', 'TEXT'],
  ['review_feedback', 'rated_at', 'TEXT'],
  ['review_feedback', 'posted_click_at', 'TEXT'],
  ['review_feedback', 'posted_site', 'TEXT'],
  ['review_feedback', 'feedback_at', 'TEXT'],
  ['review_feedback', 'callback_wanted', 'INTEGER NOT NULL DEFAULT 0'],
  ['review_feedback', 'callback_note', 'TEXT'],
  ['review_feedback', 'feedback_status', 'TEXT'],
  ['review_feedback', 'feedback_status_by', 'INTEGER REFERENCES users(id)'],
  ['review_feedback', 'feedback_status_at', 'TEXT'],
  ['review_feedback', 'resolution_note', 'TEXT'],
  ['review_feedback', 'notified_at', 'TEXT'],
  ['reviews', 'mentions_checked_at', 'TEXT'],
  // Who a move or cancel was down to (S8): 'patient' or 'office', and the office's reason.
  ['appointments', 'moved_by', 'TEXT'],
  ['appointments', 'office_reason', 'TEXT'],
  ['appointments', 'office_note', 'TEXT'],
  // X-ray AI (XR1-XR3): the vendor's own id for a finding, whether the engine that produced it is FDA-cleared,
  // the dentist's call (why a finding was dismissed, whether the assistant asked on their behalf), and on the
  // chart the finding that is the reason a condition was charted.
  ['xray_findings', 'vendor_ref', 'TEXT'],
  ['xray_findings', 'cleared', 'INTEGER NOT NULL DEFAULT 0'],
  ['xray_findings', 'review_reason', 'TEXT'],
  ['xray_findings', 'review_source', 'TEXT'],
  ['xray_findings', 'approved_by', 'INTEGER REFERENCES users(id)'],
  ['tooth_conditions', 'xray_finding_id', 'INTEGER REFERENCES xray_findings(id)'],
  ['documents', 'ai_engine', 'TEXT'],
  ['documents', 'ai_vendor_ref', 'TEXT'],
];

// CHECK constraints widened after release: [table, constraint name on Postgres, old text, new text].
const RELAXED = [
  ['messages', 'messages_channel_check', "CHECK (channel IN ('sms','email'))", "CHECK (channel IN ('sms','email','portal'))"],
  ['messages', 'messages_status_check', "CHECK (status IN ('queued','sent','failed'))", "CHECK (status IN ('queued','sent','failed','blocked'))"],
  // Document management: more kinds of patient paperwork, and office (non-patient) documents.
  ['documents', 'documents_category_check', "CHECK (category IN ('xray','photo','document','consent','insurance_card','referral','other'))",
    "CHECK (category IN ('xray','photo','document','consent','insurance_card','referral','other','eob','lab_rx','id_card','xray_report','medical_history','correspondence','contract','license','policy','invoice','certificate','hr'))"],
];

// NOT NULL constraints dropped after release: [table, column, old column text (SQLite), new column text].
// Office documents (contracts, licences, policies, invoices) are documents that belong to no patient.
const NULLABLE = [
  ['documents', 'patient_id', 'patient_id INTEGER NOT NULL REFERENCES patients(id),\n  category', 'patient_id INTEGER REFERENCES patients(id),\n  category'],
];

// Enforced by the database itself, whatever the code does: the audit log is append-only (only the id
// references can be re-pointed, as a backup restore does), and a ledger entry's amount and type never change
// (corrections are voids and reversing entries).
const GUARDS_SQLITE = `
CREATE TRIGGER IF NOT EXISTS audit_log_no_edit BEFORE UPDATE OF action, entity, details, ip, created_at, source, actor, reason, changes ON audit_log
BEGIN SELECT RAISE(ABORT, 'The audit log cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'The audit log cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS ledger_amount_fixed BEFORE UPDATE OF amount, type ON ledger_entries
WHEN OLD.amount IS NOT NEW.amount OR OLD.type IS NOT NEW.type
BEGIN SELECT RAISE(ABORT, 'Ledger amounts cannot be edited: void or reverse the entry'); END;
CREATE TRIGGER IF NOT EXISTS consent_record_fixed BEFORE UPDATE OF content, content_hash, template_version, lang, signer_name, signer_relationship, signed_at, signed_via, ip, device, witness_name, witness_signature, declined_at, declined_reason ON consents
WHEN (OLD.signed_at IS NOT NULL OR OLD.declined_at IS NOT NULL) AND (OLD.content IS NOT NEW.content OR OLD.content_hash IS NOT NEW.content_hash OR OLD.template_version IS NOT NEW.template_version OR OLD.lang IS NOT NEW.lang
  OR OLD.signer_name IS NOT NEW.signer_name OR OLD.signer_relationship IS NOT NEW.signer_relationship OR OLD.signed_at IS NOT NEW.signed_at OR OLD.signed_via IS NOT NEW.signed_via OR OLD.ip IS NOT NEW.ip
  OR OLD.device IS NOT NEW.device OR OLD.witness_name IS NOT NEW.witness_name OR OLD.witness_signature IS NOT NEW.witness_signature OR OLD.declined_at IS NOT NEW.declined_at OR OLD.declined_reason IS NOT NEW.declined_reason)
BEGIN SELECT RAISE(ABORT, 'A signed consent cannot be changed: a new version needs a new signature'); END;
CREATE TRIGGER IF NOT EXISTS patient_form_signed_fixed BEFORE UPDATE OF data, fields, signature_name, signature_image, signed_at, content_hash ON patient_forms
WHEN OLD.data IS NOT NEW.data OR OLD.fields IS NOT NEW.fields OR OLD.signature_name IS NOT NEW.signature_name OR OLD.signature_image IS NOT NEW.signature_image OR OLD.signed_at IS NOT NEW.signed_at OR OLD.content_hash IS NOT NEW.content_hash
BEGIN SELECT RAISE(ABORT, 'A signed form cannot be changed'); END;
`;
const GUARDS_PG = [
  `CREATE OR REPLACE FUNCTION dm_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'The audit log cannot be changed'; END $f$`,
  'DROP TRIGGER IF EXISTS audit_log_no_edit ON audit_log',
  'CREATE TRIGGER audit_log_no_edit BEFORE UPDATE OF action, entity, details, ip, created_at, source, actor, reason, changes ON audit_log FOR EACH ROW EXECUTE FUNCTION dm_audit_append_only()',
  'DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log',
  'CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION dm_audit_append_only()',
  `CREATE OR REPLACE FUNCTION dm_ledger_fixed() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'Ledger amounts cannot be edited: void or reverse the entry'; END $f$`,
  'DROP TRIGGER IF EXISTS ledger_amount_fixed ON ledger_entries',
  'CREATE TRIGGER ledger_amount_fixed BEFORE UPDATE OF amount, type ON ledger_entries FOR EACH ROW WHEN (OLD.amount IS DISTINCT FROM NEW.amount OR OLD.type IS DISTINCT FROM NEW.type) EXECUTE FUNCTION dm_ledger_fixed()',
  // Signed consents and signed forms keep their wording, signer, time and device (consents.js).
  `CREATE OR REPLACE FUNCTION dm_consent_fixed() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'A signed consent cannot be changed: a new version needs a new signature'; END $f$`,
  'DROP TRIGGER IF EXISTS consent_record_fixed ON consents',
  'CREATE TRIGGER consent_record_fixed BEFORE UPDATE ON consents FOR EACH ROW WHEN ((OLD.signed_at IS NOT NULL OR OLD.declined_at IS NOT NULL) AND (OLD.content IS DISTINCT FROM NEW.content OR OLD.content_hash IS DISTINCT FROM NEW.content_hash OR OLD.template_version IS DISTINCT FROM NEW.template_version OR OLD.lang IS DISTINCT FROM NEW.lang OR OLD.signer_name IS DISTINCT FROM NEW.signer_name OR OLD.signer_relationship IS DISTINCT FROM NEW.signer_relationship OR OLD.signed_at IS DISTINCT FROM NEW.signed_at OR OLD.signed_via IS DISTINCT FROM NEW.signed_via OR OLD.ip IS DISTINCT FROM NEW.ip OR OLD.device IS DISTINCT FROM NEW.device OR OLD.witness_name IS DISTINCT FROM NEW.witness_name OR OLD.witness_signature IS DISTINCT FROM NEW.witness_signature OR OLD.declined_at IS DISTINCT FROM NEW.declined_at OR OLD.declined_reason IS DISTINCT FROM NEW.declined_reason)) EXECUTE FUNCTION dm_consent_fixed()',
  `CREATE OR REPLACE FUNCTION dm_form_fixed() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'A signed form cannot be changed'; END $f$`,
  'DROP TRIGGER IF EXISTS patient_form_signed_fixed ON patient_forms',
  'CREATE TRIGGER patient_form_signed_fixed BEFORE UPDATE ON patient_forms FOR EACH ROW WHEN (OLD.data IS DISTINCT FROM NEW.data OR OLD.fields IS DISTINCT FROM NEW.fields OR OLD.signature_name IS DISTINCT FROM NEW.signature_name OR OLD.signature_image IS DISTINCT FROM NEW.signature_image OR OLD.signed_at IS DISTINCT FROM NEW.signed_at OR OLD.content_hash IS DISTINCT FROM NEW.content_hash) EXECUTE FUNCTION dm_form_fixed()',
];

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_billing_fees_practice ON billing_fees(practice_id, occasion, active);
CREATE INDEX IF NOT EXISTS idx_billing_fee_charges_patient ON billing_fee_charges(practice_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_billing_auth_patient ON billing_authorizations(practice_id, patient_id, status);
CREATE INDEX IF NOT EXISTS idx_billing_auth_source ON billing_authorizations(kind, source_id, status);
CREATE INDEX IF NOT EXISTS idx_recurring_charges_due ON recurring_charges(status, next_charge_date);
CREATE INDEX IF NOT EXISTS idx_billing_attempts_patient ON billing_attempts(practice_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_billing_attempts_source ON billing_attempts(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_billing_dunning_practice ON billing_dunning(practice_id, status);
CREATE INDEX IF NOT EXISTS idx_billing_dunning_source ON billing_dunning(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_billing_links_patient ON billing_links(practice_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_billing_disputes_practice ON billing_disputes(practice_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_practice_slug ON practices(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_token ON appointments(confirm_token_hash);
CREATE INDEX IF NOT EXISTS idx_campaign_unsub ON campaign_recipients(unsubscribe_hash);
CREATE INDEX IF NOT EXISTS idx_webhook_due ON webhook_deliveries(status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_ci ON users(lower(email));
-- For large practices (see scripts/loadtest.js): the lookups reports, worklists and charts make per patient.
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id, start_time);
CREATE INDEX IF NOT EXISTS idx_proc_appt ON procedures(appointment_id);
CREATE INDEX IF NOT EXISTS idx_proc_plan ON procedures(treatment_plan_id);
CREATE INDEX IF NOT EXISTS idx_proc_done ON procedures(practice_id, status, completed_at);
CREATE INDEX IF NOT EXISTS idx_ledger_date ON ledger_entries(practice_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_log(practice_id, patient_id, id);
CREATE INDEX IF NOT EXISTS idx_issues_open ON issues(practice_id, status, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_integration_log ON integration_log(practice_id, created_at);
-- A completed procedure is charged once: a second live charge for it is refused by the database.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_charge_per_procedure ON ledger_entries(procedure_id) WHERE type = 'charge' AND procedure_id IS NOT NULL AND voided_at IS NULL AND reverses_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(practice_id, user_id, id);
CREATE INDEX IF NOT EXISTS idx_ledger_proc ON ledger_entries(procedure_id);
CREATE INDEX IF NOT EXISTS idx_ledger_claim ON ledger_entries(claim_id);
CREATE INDEX IF NOT EXISTS idx_ledger_plan ON ledger_entries(payment_plan_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(practice_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_patient ON claims(patient_id);
CREATE INDEX IF NOT EXISTS idx_claim_items_claim ON claim_items(claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_items_proc ON claim_items(procedure_id);
CREATE INDEX IF NOT EXISTS idx_recalls_due ON recalls(practice_id, due_date);
CREATE INDEX IF NOT EXISTS idx_recalls_patient ON recalls(patient_id);
CREATE INDEX IF NOT EXISTS idx_policy_patient ON patient_insurance(patient_id);
CREATE INDEX IF NOT EXISTS idx_patients_guarantor ON patients(guarantor_id);
CREATE INDEX IF NOT EXISTS idx_elig_policy ON eligibility_checks(patient_insurance_id);
CREATE INDEX IF NOT EXISTS idx_tp_patient ON treatment_plans(patient_id);
CREATE INDEX IF NOT EXISTS idx_notes_patient ON clinical_notes(patient_id);
CREATE INDEX IF NOT EXISTS idx_conditions_patient ON tooth_conditions(patient_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(practice_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(practice_id, created_at);
CREATE INDEX IF NOT EXISTS idx_perio_patient ON perio_exams(patient_id);
CREATE INDEX IF NOT EXISTS idx_recall_contacts ON recall_contacts(recall_id);
CREATE INDEX IF NOT EXISTS idx_ledger_by_patient ON ledger_entries(patient_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_proc_by_patient ON procedures(patient_id, status);
CREATE INDEX IF NOT EXISTS idx_patients_status_name ON patients(practice_id, status, last_name, first_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recall_outside_once ON recall_outside(practice_id, patient_id, code, done_on) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_recall_resets_proc ON recall_resets(procedure_id);
CREATE INDEX IF NOT EXISTS idx_recall_resets_recall ON recall_resets(recall_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_client_key ON referrals(practice_id, client_key);
CREATE INDEX IF NOT EXISTS idx_referrals_board ON referrals(practice_id, direction, status);
CREATE INDEX IF NOT EXISTS idx_referrals_patient ON referrals(patient_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_link ON referrals(link_token_hash);
CREATE INDEX IF NOT EXISTS idx_benefit_verif_policy ON benefit_verifications(patient_insurance_id);
CREATE INDEX IF NOT EXISTS idx_benefit_verif_plan ON benefit_verifications(plan_id, group_status);
CREATE INDEX IF NOT EXISTS idx_verif_runs_day ON verification_runs(practice_id, visit_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_feedback_day ON review_feedback(practice_id, patient_id, request_day);
CREATE INDEX IF NOT EXISTS idx_review_feedback_status ON review_feedback(practice_id, feedback_status);
CREATE INDEX IF NOT EXISTS idx_review_shoutouts_month ON review_shoutouts(practice_id, month, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_prefs_active ON patient_prefs(patient_id, option_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_personal_notes_patient ON personal_notes(patient_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_notes_key ON personal_notes(practice_id, client_key);
CREATE INDEX IF NOT EXISTS idx_schedule_notes_day ON schedule_notes(practice_id, note_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_notes_key ON schedule_notes(practice_id, client_key);
CREATE INDEX IF NOT EXISTS idx_office_moves_patient ON office_moves(patient_id, happened_on);
CREATE INDEX IF NOT EXISTS idx_office_moves_day ON office_moves(practice_id, happened_on);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_labels_active ON appointment_labels(appointment_id, label_key) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bonus_approval_once ON bonus_approvals(plan_id, period_start) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_bonus_approvals_payroll ON bonus_approvals(practice_id, payroll_period_start, status);
CREATE INDEX IF NOT EXISTS idx_bonus_lines_user ON bonus_payout_lines(practice_id, user_id);
CREATE INDEX IF NOT EXISTS idx_bonus_versions_plan ON bonus_plan_versions(plan_id, effective_from);
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
  const db = target === ':memory:' && process.env.TEST_DATABASE_URL ? await openPostgres(process.env.TEST_DATABASE_URL, { freshSchema: true })
    : /^postgres(ql)?:\/\//.test(target) ? await openPostgres(target) : openSqlite(target);
  await runMigrations(db);
  return db;
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
  // The same for a NOT NULL that no longer applies (existing rows all have a value, so they still pass).
  for (const [table, , from, to] of NULLABLE) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql;
    if (!sql?.includes(from)) continue;
    const version = db.prepare('PRAGMA schema_version').get().schema_version;
    db.exec('PRAGMA writable_schema = ON');
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?").run(sql.replace(from, to), table);
    db.exec(`PRAGMA schema_version = ${version + 1}`);
    db.exec('PRAGMA writable_schema = OFF');
  }
  db.exec(INDEXES);
  db.exec(GUARDS_SQLITE);

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
  const version = createHash('sha256').update(JSON.stringify([SCHEMA, COLUMNS, INDEXES, RELAXED, NULLABLE, GUARDS_PG])).digest('hex').slice(0, 16);
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
      for (const [table, column] of NULLABLE) await setup.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL`);
      await setup.query(pgSchema(INDEXES));
      for (const q of GUARDS_PG) await setup.query(q);
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
