import { HttpError } from './auth.js';
import { insert, practiceNow } from './util.js';
import { savePolicy } from './benefits.js';

// Data conversion from another practice system. Offices export CSV files (Open Dental's query or table
// exports, Dentrix and Eaglesoft report exports, Curve's CSV export); each file is one kind of record.
// Column headers are recognized by name, so the same importer takes every system's spelling, and each
// imported record remembers its ID in the old system so re-running an import updates instead of duplicating.

export const SOURCES = ['opendental', 'dentrix', 'eaglesoft', 'curve', 'other'];
export const KINDS = ['patients', 'insurance', 'appointments', 'recalls', 'treatment', 'balances'];

const PATIENT_REF = ['patnum', 'patientid', 'patid', 'patientnumber', 'patientno', 'chartnumber', 'chartno', 'chart', 'patient'];

// Canonical field → header spellings (lowercase, letters and digits only), most specific first.
export const FIELDS = {
  patients: {
    external_id: ['patnum', 'patientid', 'patid', 'patientnumber', 'patientno', 'chartnumber', 'chartno', 'chart', 'id'],
    first_name: ['fname', 'firstname', 'patientfirstname', 'first', 'givenname'],
    last_name: ['lname', 'lastname', 'patientlastname', 'last', 'surname', 'familyname'],
    preferred_name: ['preferred', 'preferredname', 'nickname', 'goesby'],
    dob: ['birthdate', 'dob', 'dateofbirth', 'birthday', 'bdate'],
    gender: ['gender', 'sex'],
    phone: ['wirelessphone', 'cellphone', 'cell', 'mobile', 'mobilephone', 'phonecell', 'cellular'],
    phone_home: ['hmphone', 'homephone', 'phonehome', 'home', 'phone'],
    phone_work: ['wkphone', 'workphone', 'phonework', 'work', 'businessphone'],
    email: ['email', 'emailaddress', 'eMail'],
    address: ['address', 'address1', 'addressline1', 'street', 'streetaddress'],
    address2: ['address2', 'addressline2', 'apt', 'suite'],
    city: ['city', 'town'],
    state: ['state', 'st', 'province'],
    zip: ['zip', 'zipcode', 'postalcode', 'postcode'],
    status: ['patstatus', 'patientstatus', 'status', 'active'],
    guarantor: ['guarantor', 'guarantorid', 'guarantornum', 'responsibleparty', 'responsiblepartyid', 'responsibleid', 'headofhousehold'],
    provider: ['priprov', 'primaryprovider', 'provider', 'providerid', 'provnum', 'dentist', 'doctor'],
    hygienist: ['secprov', 'primaryhygienist', 'hygienist'],
    referral_source: ['referralsource', 'referredby', 'referral', 'source'],
    medical_alerts: ['medurgnote', 'medicalalert', 'medicalalerts', 'alerts', 'medicalnotes'],
    allergies: ['allergies', 'allergy'],
    medications: ['medications', 'meds', 'medication'],
    notes: ['notes', 'note', 'patnote', 'comments', 'comment'],
    balance: ['baltotal', 'balance', 'currentbalance', 'accountbalance', 'estbalance', 'totalbalance'],
  },
  insurance: {
    patient: PATIENT_REF,
    carrier: ['carriername', 'carrier', 'insurancecompany', 'insurancecarrier', 'insurance', 'payername', 'company', 'insco'],
    payer_id: ['electid', 'payerid', 'electronicid', 'ediid'],
    group_number: ['groupnum', 'groupnumber', 'group', 'groupno', 'groupid'],
    plan_name: ['groupname', 'planname', 'employer', 'employername', 'plan'],
    subscriber_id: ['subscriberid', 'memberid', 'subscriberidnumber', 'insuredid', 'insid', 'idnumber', 'policynumber'],
    subscriber_name: ['subscribername', 'subscriber', 'insuredname', 'insured', 'policyholder'],
    subscriber_dob: ['subscriberdob', 'subscriberbirthdate', 'insureddob', 'insuredbirthdate'],
    relationship: ['relationship', 'reltosub', 'relationshiptosubscriber', 'relation'],
    priority: ['ordinal', 'priority', 'coverageorder', 'primarysecondary', 'rank', 'coverage'],
    annual_max: ['annualmax', 'annualmaximum', 'yearlymax', 'maximum', 'max'],
    deductible: ['deductible', 'individualdeductible'],
    pct_preventive: ['preventive', 'preventivepct', 'pctpreventive'],
    pct_basic: ['basic', 'basicpct', 'pctbasic'],
    pct_major: ['major', 'majorpct', 'pctmajor'],
  },
  appointments: {
    external_id: ['aptnum', 'appointmentid', 'apptid', 'appointmentnumber'],
    patient: PATIENT_REF,
    datetime: ['aptdatetime', 'appointmentdatetime', 'datetime', 'start', 'starttime'],
    date: ['aptdate', 'appointmentdate', 'apptdate', 'date'],
    time: ['apttime', 'appointmenttime', 'appttime', 'time'],
    duration: ['length', 'duration', 'minutes', 'lengthminutes', 'pattern'],
    provider: ['provnum', 'provider', 'providerid', 'dentist', 'doctor'],
    operatory: ['op', 'operatory', 'chair', 'room', 'opnum'],
    status: ['aptstatus', 'status', 'appointmentstatus'],
    reason: ['procdescript', 'reason', 'procedures', 'description', 'appointmenttype', 'type'],
    notes: ['note', 'notes', 'comments'],
  },
  recalls: {
    patient: PATIENT_REF,
    type: ['recalltype', 'type', 'recalldescription', 'description'],
    interval: ['recallinterval', 'interval', 'intervalmonths', 'months', 'frequency'],
    due_date: ['datedue', 'duedate', 'nextdue', 'recalldate', 'due', 'date'],
  },
  treatment: {
    patient: PATIENT_REF,
    code: ['proccode', 'code', 'adacode', 'cdtcode', 'procedurecode', 'cdt'],
    description: ['descript', 'description', 'procdescription', 'procedure'],
    tooth: ['toothnum', 'tooth', 'toothnumber', 'th'],
    surfaces: ['surf', 'surface', 'surfaces'],
    fee: ['procfee', 'fee', 'amount', 'charge', 'amt'],
    status: ['procstatus', 'status'],
    date: ['procdate', 'date', 'servicedate', 'dateofservice', 'dos'],
    provider: ['provnum', 'provider', 'providerid', 'dentist'],
  },
  balances: {
    patient: PATIENT_REF,
    balance: ['baltotal', 'balance', 'currentbalance', 'accountbalance', 'amount', 'totalbalance'],
  },
};

const REQUIRED = {
  patients: ['first_name', 'last_name'],
  insurance: ['patient', 'carrier', 'subscriber_id'],
  appointments: ['patient'],
  recalls: ['patient', 'due_date'],
  treatment: ['patient', 'code'],
  balances: ['patient', 'balance'],
};

const norm = (h) => String(h || '').replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Suggests which column feeds each field: { field: columnIndex }.
export function detectMapping(kind, headers) {
  const fields = FIELDS[kind];
  if (!fields) throw new HttpError(400, `kind must be one of: ${KINDS.join(', ')}`);
  const cols = headers.map(norm);
  const used = new Set();
  const mapping = {};
  // Exact spellings first (in the order fields are listed), so "phone" doesn't grab a column another field names better.
  for (const [field, aliases] of Object.entries(fields)) {
    for (const a of aliases.map(norm)) {
      const i = cols.findIndex((c, j) => c === a && !used.has(j));
      if (i >= 0) { mapping[field] = i; used.add(i); break; }
    }
  }
  if (kind === 'appointments' && mapping.datetime != null && mapping.date != null) delete mapping.date;
  // A lone "Phone" column is the number to text when there's no cell column.
  if (kind === 'patients' && mapping.phone == null && mapping.phone_home != null && cols[mapping.phone_home] === 'phone') {
    mapping.phone = mapping.phone_home;
    delete mapping.phone_home;
  }
  return mapping;
}

export function missingRequired(kind, mapping) {
  const need = [...REQUIRED[kind]];
  if (kind === 'appointments' && mapping.datetime == null) need.push('date');
  return need.filter((f) => mapping[f] == null);
}

// ---- Value parsing ----
const blank = (v) => v == null || String(v).trim() === '';

export function parseDate(v, { past = false } = {}) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let y; let mo; let d;
  if (m) [, y, mo, d] = m.map(Number);
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/.exec(s))) {
    [, mo, d, y] = m.map(Number);
    if (m[3].length === 2) {
      const now = new Date().getFullYear() % 100;
      y += past ? (y > now ? 1900 : 2000) : (y > now + 20 ? 1900 : 2000);
    }
  } else if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) [, y, mo, d] = m.map(Number);
  else throw new Error(`"${s}" isn't a date`);
  if (y < 1880) return null; // Open Dental's 0001-01-01 means "no date"
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) throw new Error(`"${s}" isn't a date`);
  return date.toISOString().slice(0, 10);
}

export function parseTime(v) {
  const s = String(v ?? '').trim();
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?m?\.?/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) {
    const pm = m[3].toLowerCase() === 'p';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  if (h > 23 || Number(m[2]) > 59) throw new Error(`"${s}" isn't a time`);
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

// "$1,234.50", "(45.00)", "-12" → cents.
export function parseMoney(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s) || /\bCR$/i.test(s);
  const n = Number(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || !/\d/.test(s)) throw new Error(`"${s}" isn't an amount`);
  return Math.round(n * 100) * (neg ? -1 : 1);
}

const pct = (v, name) => {
  if (blank(v)) return undefined;
  const n = Number(String(v).replace('%', ''));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${name} must be a percentage`);
  return Math.round(n);
};

function parseGender(v, source) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (source === 'opendental' && /^\d$/.test(s)) return { 0: 'male', 1: 'female' }[s] || 'other';
  if (/^(m|male|man)$/.test(s)) return 'male';
  if (/^(f|female|woman)$/.test(s)) return 'female';
  return 'other';
}

function parsePatientStatus(v, source) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 'active';
  if (source === 'opendental' && /^\d$/.test(s)) {
    if (s === '5') return 'skip'; // deleted
    return { 0: 'active', 1: 'active', 2: 'inactive', 3: 'archived', 4: 'archived' }[s] || 'active';
  }
  if (/^(deleted)$/.test(s)) return 'skip';
  if (/^(inactive|false|no|n|0|nonpatient|non-patient)$/.test(s)) return 'inactive';
  if (/^(archived|deceased)$/.test(s)) return 'archived';
  return 'active';
}

function parseApptStatus(v, source) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 'scheduled';
  if (source === 'opendental' && /^\d$/.test(s)) {
    // 1 scheduled, 2 complete, 3 unscheduled list, 5 broken, 6 planned, 7 patient note, 8 completed note
    return { 1: 'scheduled', 2: 'completed', 5: 'no_show' }[s] || 'skip';
  }
  if (/complete|done|checked ?out/.test(s)) return 'completed';
  if (/confirm/.test(s)) return 'confirmed';
  if (/broken|no.?show|missed|failed/.test(s)) return 'no_show';
  if (/cancel/.test(s)) return 'cancelled';
  if (/unsched|planned|pinboard|asap list/.test(s)) return 'skip';
  return 'scheduled';
}

function parseProcStatus(v, source) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 'planned';
  if (source === 'opendental' && /^\d$/.test(s)) {
    // 1 TP, 2 C, 3 EC, 4 EO, 5 R, 6 D, 7 Cn, 8 TPi
    return { 1: 'planned', 2: 'completed', 3: 'completed', 4: 'completed', 8: 'planned' }[s] || 'skip';
  }
  if (/^(tp|tpi|planned|treatment ?planned|proposed|pending|accepted)$/.test(s)) return 'planned';
  if (/^(c|ec|eo|complete|completed|done|existing|posted)/.test(s)) return 'completed';
  return 'skip';
}

function parseRelationship(v, source) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 'self';
  if (/^\d$/.test(s)) return { 0: 'self', 1: 'spouse', 2: 'child' }[s] || 'other';
  if (/^(self|subscriber|s|18)$/.test(s)) return 'self';
  if (/spouse|wife|husband|partner|^01$/.test(s)) return 'spouse';
  if (/child|son|daughter|dependent|^19$/.test(s)) return 'child';
  return 'other';
}

function parsePriority(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || /^(1|primary|pri|p|1st)$/.test(s)) return 'primary';
  if (/^(2|secondary|sec|s|2nd)$/.test(s)) return 'secondary';
  throw new Error(`"${v}" isn't primary or secondary`);
}

// Recall interval in months. Open Dental stores intervals packed into an integer (years<<24 | months<<16 | weeks<<8 | days).
function parseInterval(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 6;
  const n = Number(s.replace(/\s*(m|mo|mos|months?)$/, ''));
  if (Number.isInteger(n) && n > 0 && n <= 60) return n;
  if (Number.isInteger(n) && n >= 65536) return ((n >> 24) & 0xff) * 12 + ((n >> 16) & 0xff) || 6;
  const y = /(\d+)\s*y/.exec(s);
  if (y) return Number(y[1]) * 12;
  throw new Error(`"${v}" isn't a recall interval`);
}

function parseDuration(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^[X/|]+$/i.test(s)) return s.length * 5; // Open Dental time pattern: one character per 5 minutes
  const n = Number(s.replace(/\s*(min|mins|minutes)$/i, ''));
  if (!Number.isFinite(n) || n <= 0 || n > 600) throw new Error(`"${s}" isn't a length in minutes`);
  return Math.round(n);
}

const CDT_CATEGORY = [
  [/^D0/, 'diagnostic'], [/^D1/, 'preventive'], [/^D2/, 'restorative'], [/^D3/, 'endodontics'], [/^D4/, 'periodontics'],
  [/^D60[0-9]/, 'implants'], [/^D[56]/, 'prosthodontics'], [/^D7/, 'oral_surgery'], [/^D8/, 'orthodontics'], [/^D9/, 'adjunctive'],
];

const TABLE = { patients: 'patients', insurance: 'patient_insurance', appointments: 'appointments', recalls: 'recalls', treatment: 'procedures', balances: 'ledger_entries', plans: 'treatment_plans' };

// ---- Import engine ----
export class Importer {
  constructor(db, practiceId, batch) {
    this.db = db;
    this.pid = practiceId;
    this.batch = batch;
    this.source = batch.source;
    this.cache = new Map();
  }

  async lookups() {
    if (this.providers) return;
    const { db, pid } = this;
    this.providers = await db.all('SELECT id, name, npi, type FROM providers WHERE practice_id = ? ORDER BY active DESC, id', pid);
    this.operatories = await db.all('SELECT id, name FROM operatories WHERE practice_id = ? ORDER BY active DESC, id', pid);
    this.today = (await practiceNow(db, pid)).slice(0, 10);
  }

  // Old-system provider (abbreviation, name, NPI or ID we've seen) → our provider.
  provider(v) {
    const s = String(v ?? '').trim().toLowerCase();
    if (!s) return null;
    const words = (n) => n.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    return (this.providers.find((p) => p.npi && p.npi === s)
      || this.providers.find((p) => p.name.toLowerCase() === s)
      || this.providers.find((p) => words(p.name).includes(s.replace(/^dr\.?\s*/, '')))
      || this.providers.find((p) => words(p.name).map((w) => w[0]).join('') === s.replace(/[^a-z]/g, ''))
      // Open Dental style abbreviations: "ALee" for Ann Lee.
      || this.providers.find((p) => {
        const w = words(p.name).filter((x) => !['dr', 'dds', 'dmd', 'rdh', 'md'].includes(x));
        return w.length >= 2 && w[0][0] + w[w.length - 1] === s.replace(/[^a-z]/g, '');
      }))?.id ?? null;
  }

  operatory(v) {
    const s = String(v ?? '').trim().toLowerCase();
    if (!s) return null;
    return (this.operatories.find((o) => o.name.toLowerCase() === s)
      || this.operatories.find((o) => o.name.toLowerCase().replace(/\D/g, '') === s.replace(/\D/g, '') && /\d/.test(s)))?.id ?? null;
  }

  async externalId(kind, externalId) {
    return await this.db.get('SELECT * FROM external_ids WHERE practice_id = ? AND source = ? AND kind = ? AND external_id = ?', this.pid, this.source, kind, String(externalId));
  }

  async remember(kind, externalId, localId, created) {
    const existing = await this.externalId(kind, externalId);
    if (existing) await this.db.run('UPDATE external_ids SET local_id = ? WHERE id = ?', localId, existing.id);
    else await insert(this.db, 'external_ids', { practice_id: this.pid, source: this.source, kind, external_id: String(externalId), local_id: localId, batch_id: this.batch.id, created: created ? 1 : 0 });
  }

  async patientFor(ref) {
    if (blank(ref)) throw new Error('No patient ID');
    const key = String(ref).trim();
    if (this.cache.has(key)) return this.cache.get(key);
    const x = await this.externalId('patients', key);
    const p = x && await this.db.get('SELECT id, first_name, last_name, dob, primary_provider_id FROM patients WHERE id = ? AND practice_id = ?', x.local_id, this.pid);
    if (!p) throw new Error(`Patient ${key} isn't in the imported patients — import the patient file first`);
    this.cache.set(key, p);
    return p;
  }

  defaultProvider(patient) {
    return patient?.primary_provider_id || this.providers.find((p) => p.type === 'dentist')?.id || this.providers[0]?.id;
  }

  // Applies one mapped row; returns 'created', 'updated' or 'skipped'.
  async row(kind, r) {
    await this.lookups();
    return this[kind](r);
  }

  async patients(r) {
    const { db, pid } = this;
    const status = parsePatientStatus(r.status, this.source);
    if (status === 'skip') return 'skipped';
    if (blank(r.first_name) || blank(r.last_name)) throw new Error('First and last name are required');
    const row = {
      first_name: r.first_name.trim(), last_name: r.last_name.trim(), status,
      preferred_name: r.preferred_name, dob: parseDate(r.dob, { past: true }), gender: parseGender(r.gender, this.source),
      phone: r.phone, phone_home: r.phone_home, phone_work: r.phone_work,
      email: blank(r.email) ? null : (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email.trim()) ? r.email.trim() : null),
      address: [r.address, r.address2].filter((x) => !blank(x)).map((x) => x.trim()).join(', ') || null,
      city: r.city, state: blank(r.state) ? null : r.state.trim().slice(0, 2).toUpperCase(), zip: r.zip,
      referral_source: r.referral_source, medical_alerts: r.medical_alerts, allergies: r.allergies, medications: r.medications, notes: r.notes,
      primary_provider_id: this.provider(r.provider), primary_hygienist_id: this.provider(r.hygienist),
    };
    for (const k of Object.keys(row)) if (blank(row[k])) delete row[k];
    const ext = blank(r.external_id) ? null : String(r.external_id).trim();
    const known = ext && await this.externalId('patients', ext);
    const current = known && await db.get('SELECT id FROM patients WHERE id = ? AND practice_id = ?', known.local_id, pid);
    let id;
    let result;
    if (current) {
      id = current.id;
      await db.run(`UPDATE patients SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...Object.values(row), id);
      result = 'updated';
    } else {
      id = await insert(db, 'patients', { ...row, practice_id: pid });
      result = 'created';
    }
    if (ext) await this.remember('patients', ext, id, !current);
    if (ext) this.cache.set(ext, { id, ...row });
    // Guarantors are linked once the whole file is in (the guarantor may be further down).
    if (!blank(r.guarantor) && String(r.guarantor).trim() !== ext) (this.guarantors ||= []).push([id, String(r.guarantor).trim()]);
    if (!blank(r.balance)) await this.balanceForward(id, parseMoney(r.balance), ext || `p${id}`);
    return result;
  }

  async linkGuarantors() {
    for (const [id, ref] of this.guarantors || []) {
      const x = await this.externalId('patients', ref);
      if (x && x.local_id !== id) await this.db.run('UPDATE patients SET guarantor_id = ? WHERE id = ? AND practice_id = ?', x.local_id, id, this.pid);
    }
    this.guarantors = [];
  }

  async balanceForward(patientId, cents, key) {
    const known = await this.externalId('balances', key);
    const entry = known && await this.db.get('SELECT id, voided_at FROM ledger_entries WHERE id = ? AND practice_id = ?', known.local_id, this.pid);
    if (entry && !entry.voided_at) {
      await this.db.run('UPDATE ledger_entries SET amount = ? WHERE id = ?', cents, entry.id);
      return 'updated';
    }
    if (!cents) return 'skipped';
    const id = await insert(this.db, 'ledger_entries', {
      practice_id: this.pid, patient_id: patientId, type: 'adjustment', amount: cents, entry_date: this.today,
      description: `Balance forward from ${SOURCE_NAMES[this.source]}`, adjustment_type: 'Balance forward', created_by: this.batch.created_by,
    });
    await this.remember('balances', key, id, true);
    return 'created';
  }

  async balances(r) {
    const p = await this.patientFor(r.patient);
    return this.balanceForward(p.id, parseMoney(r.balance), String(r.patient).trim());
  }

  async insurance(r) {
    const { db, pid } = this;
    const p = await this.patientFor(r.patient);
    const carrierName = String(r.carrier || '').trim();
    if (!carrierName) throw new Error('Carrier is required');
    if (blank(r.subscriber_id)) throw new Error('Subscriber ID is required');
    let carrier = await db.get('SELECT id FROM insurance_carriers WHERE practice_id = ? AND lower(name) = lower(?)', pid, carrierName);
    if (!carrier && !blank(r.payer_id)) carrier = await db.get('SELECT id FROM insurance_carriers WHERE practice_id = ? AND payer_id = ?', pid, String(r.payer_id).trim());
    const carrierId = carrier?.id ?? await insert(db, 'insurance_carriers', { practice_id: pid, name: carrierName, payer_id: blank(r.payer_id) ? null : String(r.payer_id).trim() });
    const priority = parsePriority(r.priority);
    const relationship = parseRelationship(r.relationship, this.source);
    const row = {
      carrier_id: carrierId, priority, relationship, patient_id: p.id,
      subscriber_id: String(r.subscriber_id).trim(),
      subscriber_name: blank(r.subscriber_name) ? (relationship === 'self' ? `${p.first_name} ${p.last_name}` : 'Unknown subscriber') : String(r.subscriber_name).trim(),
      subscriber_dob: parseDate(r.subscriber_dob, { past: true }) ?? (relationship === 'self' ? p.dob : null),
      group_number: blank(r.group_number) ? null : String(r.group_number).trim(),
      annual_max: blank(r.annual_max) ? undefined : parseMoney(r.annual_max),
      deductible: blank(r.deductible) ? undefined : parseMoney(r.deductible),
      pct_preventive: pct(r.pct_preventive, 'Preventive %'), pct_basic: pct(r.pct_basic, 'Basic %'), pct_major: pct(r.pct_major, 'Major %'),
    };
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
    const existing = await db.get('SELECT id FROM patient_insurance WHERE practice_id = ? AND patient_id = ? AND carrier_id = ? AND subscriber_id = ?', pid, p.id, carrierId, row.subscriber_id);
    const id = await savePolicy(db, pid, existing?.id ?? null, row);
    if (!blank(r.plan_name)) await db.run('UPDATE insurance_plans SET name = COALESCE(name, ?) WHERE id = (SELECT plan_id FROM patient_insurance WHERE id = ?)', String(r.plan_name).trim(), id);
    await this.remember('insurance', `${String(r.patient).trim()}|${carrierId}|${row.subscriber_id}`, id, !existing);
    return existing ? 'updated' : 'created';
  }

  async appointments(r) {
    const { db, pid } = this;
    const status = parseApptStatus(r.status, this.source);
    if (status === 'skip') return 'skipped';
    const p = await this.patientFor(r.patient);
    const date = parseDate(r.datetime ?? r.date);
    const time = parseTime(r.time) ?? parseTime(r.datetime ?? r.date);
    if (!date || !time) throw new Error('Needs a date and time');
    const minutes = parseDuration(r.duration) ?? 60;
    const start = new Date(`${date}T${time}:00Z`);
    const end = new Date(start.getTime() + minutes * 60000).toISOString().replace('T', ' ').slice(0, 16);
    const row = {
      patient_id: p.id, provider_id: this.provider(r.provider) ?? this.defaultProvider(p), operatory_id: this.operatory(r.operatory),
      start_time: `${date} ${time}`, end_time: end, status: status === 'scheduled' && date < this.today ? 'completed' : status,
      reason: blank(r.reason) ? null : String(r.reason).trim().slice(0, 200), notes: blank(r.notes) ? null : String(r.notes).trim(),
    };
    if (!row.provider_id) throw new Error('Add a provider in Settings first');
    const key = blank(r.external_id) ? `${String(r.patient).trim()}|${row.start_time}` : String(r.external_id).trim();
    const known = await this.externalId('appointments', key);
    const current = known && await db.get('SELECT id FROM appointments WHERE id = ? AND practice_id = ?', known.local_id, pid);
    if (current) {
      await db.run(`UPDATE appointments SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), current.id);
      return 'updated';
    }
    const id = await insert(db, 'appointments', { ...row, practice_id: pid });
    await this.remember('appointments', key, id, true);
    return 'created';
  }

  async recalls(r) {
    const { db, pid } = this;
    const p = await this.patientFor(r.patient);
    const due = parseDate(r.due_date);
    if (!due) throw new Error('Due date is required');
    const t = String(r.type || '').toLowerCase();
    const type = /perio|4910/.test(t) ? 'perio' : /fmx|pano|bitewing|bwx|x-?ray/.test(t) ? 'xrays' : /exam/.test(t) && !/prophy|clean/.test(t) ? 'exam' : 'prophy';
    const interval = parseInterval(r.interval);
    const existing = await db.get('SELECT id FROM recalls WHERE practice_id = ? AND patient_id = ? AND type = ?', pid, p.id, type);
    if (existing) {
      await db.run('UPDATE recalls SET due_date = ?, interval_months = ? WHERE id = ?', due, interval, existing.id);
      return 'updated';
    }
    const id = await insert(db, 'recalls', { practice_id: pid, patient_id: p.id, type, interval_months: interval, due_date: due, status: 'due' });
    await this.remember('recalls', `${String(r.patient).trim()}|${type}`, id, true);
    return 'created';
  }

  async codeFor(code, description, fee) {
    const { db, pid } = this;
    const found = await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', pid, code);
    if (found) return found;
    const category = CDT_CATEGORY.find(([re]) => re.test(code))?.[1] || 'adjunctive';
    const id = await insert(db, 'procedure_codes', { practice_id: pid, code, description: description || code, category, fee: fee ?? 0, active: /^D\d{4}$/.test(code) ? 1 : 0 });
    return await db.get('SELECT * FROM procedure_codes WHERE id = ?', id);
  }

  async treatment(r) {
    const { db, pid } = this;
    const status = parseProcStatus(r.status, this.source);
    if (status === 'skip') return 'skipped';
    const p = await this.patientFor(r.patient);
    const codeText = String(r.code || '').trim().toUpperCase();
    if (!codeText) throw new Error('Procedure code is required');
    const fee = blank(r.fee) ? null : parseMoney(r.fee);
    const pc = await this.codeFor(codeText, blank(r.description) ? null : String(r.description).trim(), fee);
    const date = parseDate(r.date);
    const tooth = blank(r.tooth) ? null : String(r.tooth).trim().toUpperCase();
    const surfaces = blank(r.surfaces) ? null : String(r.surfaces).trim().toUpperCase().replace(/[^MODBFLIV5]/g, '');
    const key = `${String(r.patient).trim()}|${codeText}|${tooth || ''}|${surfaces || ''}|${date || ''}|${status}`;
    const known = await this.externalId('treatment', key);
    if (known && await db.get('SELECT id FROM procedures WHERE id = ? AND practice_id = ?', known.local_id, pid)) return 'skipped';
    let planId = null;
    if (status === 'planned') {
      const planKey = `${String(r.patient).trim()}|plan|${this.batch.id}`;
      planId = (await this.externalId('plans', planKey))?.local_id;
      if (!planId) {
        planId = await insert(db, 'treatment_plans', { practice_id: pid, patient_id: p.id, name: `Treatment from ${SOURCE_NAMES[this.source]}`, status: 'proposed' });
        await this.remember('plans', planKey, planId, true);
      }
    }
    // History comes in without ledger charges: the balance forward already carries what's owed.
    const id = await insert(db, 'procedures', {
      practice_id: pid, patient_id: p.id, treatment_plan_id: planId, provider_id: this.provider(r.provider) ?? this.defaultProvider(p),
      code_id: pc.id, code: pc.code, description: blank(r.description) ? pc.description : String(r.description).trim(), category: pc.category,
      tooth, surfaces: surfaces || null, fee: fee ?? pc.fee, status, completed_at: status === 'completed' ? (date || this.today) : null,
      ...(status === 'planned' && date ? { created_at: `${date} 00:00:00` } : {}),
    });
    await this.remember('treatment', key, id, true);
    return 'created';
  }

  async finish() {
    await this.linkGuarantors();
  }
}

export const SOURCE_NAMES = { opendental: 'Open Dental', dentrix: 'Dentrix', eaglesoft: 'Eaglesoft', curve: 'Curve', other: 'previous system' };

// Deletes what an import created, newest first. Anything that has been used since (a payment against
// an imported patient, a claim on an imported procedure) makes the delete fail, and nothing is removed.
export async function undoBatch(db, practiceId, batchId) {
  const order = ['balances', 'treatment', 'plans', 'appointments', 'recalls', 'insurance', 'patients'];
  const removed = {};
  await db.tx(async () => {
    const rows = await db.all('SELECT kind, local_id FROM external_ids WHERE practice_id = ? AND batch_id = ? AND created = 1', practiceId, batchId);
    const pats = rows.filter((x) => x.kind === 'patients').map((x) => x.local_id);
    for (const id of pats) await db.run('UPDATE patients SET guarantor_id = NULL WHERE practice_id = ? AND guarantor_id = ?', practiceId, id);
    for (const kind of order) {
      for (const x of rows.filter((y) => y.kind === kind)) {
        if (kind === 'patients') {
          // Only what the import itself put on the chart may go with it.
          await db.run('DELETE FROM recalls WHERE patient_id = ? AND practice_id = ?', x.local_id, practiceId);
        }
        const r = await db.run(`DELETE FROM ${TABLE[kind]} WHERE id = ? AND practice_id = ?`, x.local_id, practiceId);
        removed[kind] = (removed[kind] || 0) + r.changes;
      }
    }
    await db.run('DELETE FROM external_ids WHERE practice_id = ? AND batch_id = ?', practiceId, batchId);
    await db.run("UPDATE import_batches SET status = 'undone' WHERE id = ?", batchId);
  });
  return removed;
}

