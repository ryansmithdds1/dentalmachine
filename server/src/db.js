import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
`;

export function openDb(path = process.env.DATABASE_PATH || './data/dentalmachine.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return wrap(db);
}

// Thin helpers over node:sqlite so route code stays terse.
function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const clean = (row) => (row ? { ...row } : row);
  let depth = 0;
  return {
    raw: db,
    all: (sql, ...params) => stmt(sql).all(...params).map(clean),
    get: (sql, ...params) => clean(stmt(sql).get(...params)),
    run: (sql, ...params) => {
      const r = stmt(sql).run(...params);
      return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
    },
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}
