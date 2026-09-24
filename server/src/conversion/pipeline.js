import { createHash } from 'node:crypto';
import { insert, update, validTooth, normalizeSurfaces } from '../util.js';
import { Importer, parseDate, parseTime, parseMoney, parseInterval, parseDuration, SOURCE_NAMES } from '../importer.js';
import { TABLES, fieldsFor, mapHeaders, recognize, defaultsFor, perioReadings, text, blank, truthy, norm } from './common.js';
import dentrix from './dentrix.js';
import eaglesoft from './eaglesoft.js';
import curve from './curve.js';

// Full conversion from Dentrix, Eaglesoft or Curve exports. The same steps for every system:
//   1. stage   — the browser unzips the export, reads each file and sends only the columns we use; each file is
//                matched to one of our standard tables (common.js) and its rows held in conversion_rows.
//   2. check   — the dry run: every row is read and mapped exactly as the import would, nothing is written. It
//                reports how many of each record would be new or updated, what would be left out and why, the
//                values we couldn't map (statuses, codes, providers, transaction types) and the accounts
//                receivable total. The office can map those values and check again.
//   3. run     — the import, a slice at a time (each call fits in a web request and picks up where it stopped).
//   4. reconcile — source counts against what was brought in and left out, and the source A/R against the
//                balance forward posted, checked against the database.
// History comes over as history: completed procedures without charges, signed notes. Money comes over as one
// "balance forward" per family equal to what the old system showed — ledger history is never re-posted.
// Every record remembers its old ID (external_ids), so a corrected re-import updates instead of duplicating.

export const VENDORS = { dentrix, eaglesoft, curve };

export const STEPS = ['providers', 'operatories', 'patients', 'guarantors', 'insurance', 'appointments', 'procedures', 'recalls', 'notes', 'perio', 'balances', 'cleanup'];
const STEP_TABLE = {
  providers: 'providers', operatories: 'operatories', patients: 'patients', guarantors: 'patients', insurance: 'insurance', appointments: 'appointments',
  procedures: 'procedures', recalls: 'recalls', notes: 'notes', perio: 'perio', balances: '_family',
};
const LABEL = {
  providers: 'Providers', operatories: 'Chairs', patients: 'Patients', guarantors: 'Families (guarantors)', insurance: 'Insurance policies', appointments: 'Appointments',
  procedures: 'Completed and planned treatment', recalls: 'Recall', notes: 'Clinical notes', perio: 'Perio charts', balances: 'Family balances', cleanup: 'Finishing', done: 'Done',
};
export const stepLabel = (s) => LABEL[s] || s;
// Which external_ids kind a step's records are remembered under (for "new" vs "update" and the database check).
const KIND = { providers: 'providers', operatories: 'operatories', patients: 'patients', appointments: 'appointments', procedures: 'procedures', notes: 'notes', perio: 'perio' };

// Values the office can map in the dry run, and the choices for each.
export const MAPPABLE = {
  provider: { label: 'Provider', choices: null },
  patient_status: { label: 'Patient status', choices: ['active', 'inactive', 'archived', 'skip'] },
  appointment_status: { label: 'Appointment status', choices: ['scheduled', 'confirmed', 'completed', 'no_show', 'cancelled', 'skip'] },
  procedure_status: { label: 'Procedure status', choices: ['planned', 'completed', 'skip'] },
  procedure_code: { label: 'Procedure code', choices: null },
  transaction_type: { label: 'Ledger transaction type', choices: ['charge', 'credit', 'signed', 'ignore'] },
  relationship: { label: 'Relationship to subscriber', choices: ['self', 'spouse', 'child', 'other'] },
  coverage: { label: 'Coverage (primary/secondary)', choices: ['primary', 'secondary', 'skip'] },
};
// What happens to an unmapped value until the office chooses.
const FALLBACK = {
  provider: "the patient's provider (or the first dentist)", patient_status: 'active', appointment_status: 'scheduled', procedure_status: 'left out',
  procedure_code: "kept as the old system's code", transaction_type: 'left out of the balance', relationship: 'other', coverage: 'primary',
};

class Skip {
  constructor(reason, detail) {
    this.reason = reason;
    this.detail = detail;
  }
}
const skip = (reason, detail) => new Skip(reason, detail);
const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const AREA = /^(UR|UL|LL|LR|U|L|UA|LA|FM|FMX)$/;

export function vendorFor(id) {
  const v = VENDORS[id];
  if (!v) throw Object.assign(new Error(`source must be one of: ${Object.keys(VENDORS).join(', ')}`), { status: 400 });
  return v;
}

// For the screen: each system's instructions and the tables we read.
export function vendorList() {
  return Object.values(VENDORS).map((v) => ({ id: v.id, name: v.name, accept: v.accept, howTo: v.howTo }));
}

// Which table each file is, and which of its columns we use (only those leave the office's computer).
export function planFiles(vendor, files) {
  return files.map((f) => {
    const headers = (f.headers || []).map((h) => String(h ?? '').slice(0, 200));
    const table = recognize(vendor, f.name, headers);
    if (!table) return { name: f.name, table: null, keep: [], dropped: headers };
    const m = mapHeaders(fieldsFor(vendor, table), headers);
    const keep = [...new Set(Object.values(m))].sort((a, b) => a - b);
    return { name: f.name, table, label: TABLES[table].label, keep, dropped: headers.filter((_, i) => !keep.includes(i)) };
  });
}

const refOf = (table, d) => {
  if (table === 'patients') return text(d.id) || null;
  if (table === 'perio') return text(d.exam_id) || `${text(d.patient)}|${text(d.date).slice(0, 10)}`;
  return null;
};

// Holds a file's rows as standard fields. Cells are capped (a note can be long; nothing needs more).
export async function stageFile(db, batch, vendor, { file, table, headers, rows }) {
  if (!TABLES[table]) throw Object.assign(new Error(`${table} isn't a table we convert`), { status: 400 });
  if (!Array.isArray(headers) || !headers.length || headers.length > 300) throw Object.assign(new Error('headers are required'), { status: 400 });
  const m = mapHeaders(fieldsFor(vendor, table), headers.map((h) => String(h ?? '')));
  const need = TABLES[table].need.filter((f) => m[f] == null);
  if (need.length) throw Object.assign(new Error(`${file || 'This file'} has no column for ${need.join(', ')}`), { status: 400 });
  const defaults = defaultsFor(vendor, file || '');
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200).map((cells) => {
      if (!Array.isArray(cells)) throw Object.assign(new Error('Each row must be a list of cells'), { status: 400 });
      const d = { ...defaults };
      for (const [f, j] of Object.entries(m)) {
        const v = cells[j];
        if (!blank(v)) d[f] = String(v).slice(0, 20_000);
      }
      return [batch.id, table, refOf(table, d), JSON.stringify(d)];
    });
    if (part.length) await db.run(`INSERT INTO conversion_rows (batch_id, tbl, ref, data) VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}`, ...part.flat());
  }
  return rows.length;
}

// ---- Reading the rows (shared by the dry run and the import) ----
class Conversion extends Importer {
  constructor(db, practiceId, batch, vendor) {
    super(db, practiceId, batch);
    this.v = vendor;
    this.choices = JSON.parse(batch.mapping || '{}');
    this.unmapped = new Map();
  }

  async staged(tbl, where = '', ...args) {
    return (await this.db.all(`SELECT data FROM conversion_rows WHERE batch_id = ? AND tbl = ?${where} ORDER BY id`, this.batch.id, tbl, ...args)).map((r) => JSON.parse(r.data));
  }

  async load() {
    this.providers = null;
    await this.lookups();
    const map = async (kind) => new Map((await this.db.all('SELECT external_id, local_id FROM external_ids WHERE practice_id = ? AND source = ? AND kind = ?', this.pid, this.source, kind)).map((r) => [r.external_id, r.local_id]));
    this.provMap = await map('providers');
    this.opMap = await map('operatories');
    this.stagedProviders = new Set((await this.staged('providers')).map((p) => text(p.id)).filter(Boolean));
    // Every name the export uses for a patient (Dentrix: chart number and internal ID) → the ID we key on.
    this.alias = new Map();
    this.people = new Map();
    for (const p of await this.staged('patients')) {
      const id = text(p.id);
      if (!id) continue;
      this.people.set(id, p);
      this.alias.set(id, id);
      if (!blank(p.alt_id) && !this.alias.has(text(p.alt_id))) this.alias.set(text(p.alt_id), id);
    }
    this.coming = new Set([...this.people].filter(([, p]) => !(this.normalizePatient(p, { quiet: true }) instanceof Skip)).map(([id]) => id));
    this.codes = new Map((await this.staged('codes')).map((c) => [text(c.code).toUpperCase(), c]));
    this.carriers = new Map((await this.staged('carriers')).map((c) => [text(c.id), c]));
    this.plans = new Map((await this.staged('plans')).map((c) => [text(c.id), c]));
    this.unmapped = new Map();
  }

  // A value from the old system through the office's choice, then the vendor's table; unknown values are noted.
  valueOf(kind, raw, fn, blankValue) {
    if (blank(raw)) return blankValue;
    const key = text(raw).toLowerCase();
    const chosen = this.choices[kind]?.[key];
    if (chosen != null && chosen !== '') return chosen;
    const out = fn?.(raw);
    if (out === undefined) this.note(kind, text(raw));
    return out;
  }

  note(kind, value) {
    if (this.quiet) return;
    const k = `${kind}|${value.toLowerCase()}`;
    const u = this.unmapped.get(k) || { kind, value, count: 0 };
    u.count++;
    this.unmapped.set(k, u);
  }

  patKey(ref) {
    return blank(ref) ? null : this.alias.get(text(ref)) ?? null;
  }

  patientRef(ref) {
    const id = this.patKey(ref);
    if (!id) return skip("Patient isn't in the patient file", `patient ${text(ref) || '(blank)'}`);
    if (!this.coming.has(id)) return skip("The patient wasn't brought over", `patient ${id}`);
    return id;
  }

  // Old-system provider ID → ours: the office's choice, a provider this conversion made, or a name/NPI match.
  provider(v) {
    const s = text(v);
    if (!s) return null;
    const chosen = this.choices.provider?.[s.toLowerCase()];
    if (chosen) return chosen === 'none' ? null : Number(chosen);
    if (this.provMap?.has(s)) return this.provMap.get(s);
    const found = super.provider(s);
    if (!found && !this.stagedProviders?.has(s)) this.note('provider', s);
    return found;
  }

  operatory(v) {
    const s = text(v);
    if (!s) return null;
    return this.opMap?.get(s) ?? super.operatory(s);
  }

  // The family head: follow guarantor links (at most a few steps) to someone who is coming over.
  head(id) {
    let cur = id;
    for (let i = 0; i < 5; i++) {
      const g = this.patKey(this.people.get(cur)?.guarantor);
      if (!g || g === cur || !this.coming.has(g)) return cur;
      cur = g;
    }
    return cur;
  }

  // ---- Normalizers: a staged row → the record we'd write, or a Skip saying why not. Throwing = bad data. ----
  normalizeProvider(r) {
    const id = text(r.id);
    const name = text(r.name) || [text(r.first_name), text(r.last_name)].filter(Boolean).join(' ') || id;
    if (!name) return skip('No provider name');
    const suffix = text(r.suffix).replace(/^(dr\.?)$/i, '');
    const full = suffix && !name.toLowerCase().includes(suffix.toLowerCase()) ? `${name}, ${suffix}` : name;
    const npi = text(r.npi).replace(/\D/g, '');
    const inactive = truthy(r.inactive) || (!blank(r.active) && /^(n|no|false|0|inactive|f)$/i.test(text(r.active)));
    return { ext: id || full, name: full.slice(0, 120), type: this.v.providerType(`${text(r.type)} ${suffix}`) || 'dentist', npi: npi.length === 10 ? npi : null, active: inactive ? 0 : 1 };
  }

  normalizeOperatory(r) {
    const name = text(r.name) || text(r.id);
    if (!name) return skip('No chair name');
    const inactive = truthy(r.inactive) || (!blank(r.active) && /^(n|no|false|0)$/i.test(text(r.active)));
    return { ext: text(r.id) || name, name: name.slice(0, 60), active: inactive ? 0 : 1 };
  }

  normalizePatient(r, { quiet = false } = {}) {
    this.quiet = quiet;
    try {
      const id = text(r.id);
      if (!id) return skip('No patient ID');
      const status = this.valueOf('patient_status', r.status, this.v.patientStatus, 'active') ?? 'active';
      if (status === 'skip') return skip(`Patient status isn't brought over`, `"${text(r.status)}" — ${id}`);
      if (!text(r.first_name) || !text(r.last_name)) return skip('No first or last name', `patient ${id}`);
      const g = text(r.gender).toLowerCase();
      return {
        external_id: id, first_name: text(r.first_name), last_name: text(r.last_name), preferred_name: text(r.preferred_name), dob: text(r.dob),
        gender: /^(m|male|man)$/.test(g) ? 'male' : /^(f|female|woman)$/.test(g) ? 'female' : g ? 'other' : '', status,
        phone: text(r.phone), phone_home: text(r.phone_home), phone_work: text(r.phone_work), email: text(r.email),
        address: text(r.address), address2: text(r.address2), city: text(r.city), state: text(r.state), zip: text(r.zip),
        provider: text(r.provider), hygienist: text(r.hygienist), medical_alerts: text(r.medical_alerts),
      };
    } finally {
      this.quiet = false;
    }
  }

  normalizeGuarantor(r) {
    const id = text(r.id);
    if (blank(r.guarantor) || !this.coming.has(id)) return null;
    const g = this.patKey(r.guarantor);
    if (g === id) return null;
    if (!g) return skip("Guarantor isn't in the patient file (the patient stays their own guarantor)", `patient ${id} → ${text(r.guarantor)}`);
    if (!this.coming.has(g)) return skip("Guarantor wasn't brought over (the patient stays their own guarantor)", `patient ${id} → ${g}`);
    return { id, guarantor: this.head(id) };
  }

  normalizeInsurance(r) {
    const patient = this.patientRef(r.patient);
    if (patient instanceof Skip) return patient;
    const plan = this.plans.get(text(r.plan_id));
    const carrierRow = this.carriers.get(text(r.carrier_id)) || this.carriers.get(text(plan?.carrier_id));
    const carrier = text(r.carrier) || text(carrierRow?.name);
    if (!carrier) return skip('No insurance carrier', `patient ${patient}`);
    const subscriberId = text(r.subscriber_id);
    if (!subscriberId) return skip('No subscriber ID', `patient ${patient} — ${carrier}`);
    const priority = this.valueOf('coverage', r.priority, this.v.priority, 'primary') ?? 'primary';
    if (priority === 'skip') return skip('Only primary and secondary dental coverage come over', `patient ${patient} — ${text(r.priority)}`);
    const sub = this.patKey(r.subscriber);
    const person = sub && this.people.get(sub);
    let relationship = this.valueOf('relationship', r.relationship, this.v.relationship, undefined);
    if (relationship === undefined) relationship = !blank(r.relationship) ? 'other' : (!sub || sub === patient ? 'self' : 'other');
    return {
      patient, carrier, payer_id: text(r.payer_id) || text(carrierRow?.payer_id), group_number: text(r.group_number) || text(plan?.group_number),
      plan_name: text(r.plan_name) || text(plan?.plan_name), subscriber_id: subscriberId,
      subscriber_name: person ? `${text(person.first_name)} ${text(person.last_name)}` : (sub ? '' : text(r.subscriber_name) || (!blank(r.subscriber) && !/^\d+$/.test(text(r.subscriber)) ? text(r.subscriber) : '')),
      subscriber_dob: person ? text(person.dob) : text(r.subscriber_dob), relationship, priority,
      annual_max: text(r.annual_max) || text(plan?.annual_max), deductible: text(r.deductible) || text(plan?.deductible),
    };
  }

  normalizeAppointment(r) {
    const patient = this.patientRef(r.patient);
    if (patient instanceof Skip) return patient;
    const status = truthy(r.broken) ? 'no_show' : (this.valueOf('appointment_status', r.status, this.v.appointmentStatus, 'scheduled') ?? 'scheduled');
    if (status === 'skip') return skip("Appointments that aren't on the schedule (deleted, unscheduled or pinboard) aren't brought over", `patient ${patient} — "${text(r.status)}"`);
    const when = text(r.datetime) || text(r.date);
    const date = parseDate(when);
    const time = parseTime(r.time) ?? parseTime(text(r.datetime));
    if (!date || !time) throw new Error('No date and time');
    let minutes = parseDuration(r.duration);
    if (!minutes && !blank(r.end)) {
      const endTime = parseTime(r.end);
      const endDate = parseDate(/\d{4}-|\//.test(text(r.end)) ? r.end : date) || date;
      if (endTime) {
        const diff = (new Date(`${endDate}T${endTime}:00Z`) - new Date(`${date}T${time}:00Z`)) / 60000;
        if (diff > 0 && diff <= 600) minutes = diff;
      }
    }
    return {
      external_id: text(r.id) || `${patient}|${date} ${time}`, patient, datetime: `${date} ${time}`, duration: String(minutes || 60),
      provider: text(r.provider), operatory: text(r.operatory), status, reason: text(r.reason), notes: text(r.notes),
    };
  }

  normalizeProcedure(r) {
    const patient = this.patientRef(r.patient);
    if (patient instanceof Skip) return patient;
    const status = this.valueOf('procedure_status', r.status, this.v.procedureStatus, 'completed');
    if (!status) return skip("Procedure status isn't one we know (map it to bring these over)", `patient ${patient} — "${text(r.status)}"`);
    if (status === 'skip') return skip("Conditions, declined, deleted and referred-out work aren't brought over", `patient ${patient} — "${text(r.status)}"`);
    const raw = text(r.code).toUpperCase();
    if (!raw) throw new Error('No procedure code');
    const listed = this.codes.get(raw);
    const choice = this.choices.procedure_code?.[raw.toLowerCase()];
    if (choice === 'skip') return skip('Procedure code left out (your choice)', `${raw} — patient ${patient}`);
    let code = choice || (this.v.code ? this.v.code(text(listed?.ada_code) || raw) : text(listed?.ada_code).toUpperCase() || raw);
    code = code.toUpperCase();
    if (!/^D\d{4}$/.test(code)) this.note('procedure_code', raw);
    let tooth = text(r.tooth).toUpperCase().replace(/^#/, '');
    if (AREA.test(tooth)) tooth = '';
    if (tooth && !validTooth(tooth)) throw new Error(`Tooth "${text(r.tooth)}" isn't a tooth number`);
    const fee = blank(r.fee) ? null : Math.abs(parseMoney(r.fee));
    const date = parseDate(r.date);
    return {
      ext: text(r.id) || `${patient}|${raw}|${tooth}|${text(r.surfaces)}|${date || ''}|${status}`, patient, code: code.slice(0, 20),
      description: (text(r.description) || text(listed?.description) || code).slice(0, 200), tooth: tooth || null, surfaces: normalizeSurfaces(r.surfaces),
      fee, date, status, provider: text(r.provider), appointment: text(r.appointment),
    };
  }

  normalizeRecall(r) {
    const patient = this.patientRef(r.patient);
    if (patient instanceof Skip) return patient;
    const due = parseDate(r.due_date);
    if (!due) return skip('No recall due date', `patient ${patient}`);
    parseInterval(r.interval);
    return { patient, type: text(r.type) || 'Prophy', interval: text(r.interval), due_date: due };
  }

  normalizeNote(r) {
    const patient = this.patientRef(r.patient);
    if (patient instanceof Skip) return patient;
    const body = text(r.note);
    if (!body) return skip('Empty note', `patient ${patient}`);
    const date = parseDate(r.date);
    const time = parseTime(r.date);
    return { ext: text(r.id) || `${patient}|${date || ''}|${hash(body)}`, patient, body, at: date ? `${date} ${time || '00:00'}:00` : null, provider: text(r.provider) };
  }

  normalizePerio(rows) {
    const first = rows[0];
    const patient = this.patientRef(first.patient);
    if (patient instanceof Skip) return patient;
    const date = parseDate(first.date);
    if (!date) return skip('Perio exam has no date', `patient ${patient}`);
    const { readings, problems } = perioReadings(rows, { validTooth });
    if (!Object.keys(readings).length) return skip('Perio exam has no readings we could read', `patient ${patient} — ${problems.slice(0, 3).join('; ')}`);
    return { ext: text(first.exam_id) || `${patient}|${date}`, patient, date, provider: text(first.provider), readings, problems };
  }

  // ---- Balances: one per family, what the old system showed ----
  // From the aging / responsible-party file or the patients' balance columns when there are any; otherwise
  // added up from the ledger export by transaction type. Returns families (head → cents) and what couldn't be placed.
  async familyBalances() {
    const family = new Map();
    const unplaced = [];
    const add = (map, head, cents) => map.set(head, (map.get(head) || 0) + cents);
    const place = (ref, cents, what) => {
      const id = this.patKey(ref);
      if (!id || !this.coming.has(id)) {
        unplaced.push({ ref: text(ref), cents, reason: id ? "The account's patient wasn't brought over" : "The account isn't in the patient file", what });
        return null;
      }
      return this.head(id);
    };
    const famLevel = new Map();
    const patLevel = new Map();
    for (const b of await this.staged('balances')) {
      const cents = !blank(b.balance) ? parseMoney(b.balance) : ['bal_0_30', 'bal_31_60', 'bal_61_90', 'bal_90'].reduce((t, k) => t + (blank(b[k]) ? 0 : parseMoney(b[k])), 0);
      if (!cents) continue;
      const head = place(b.patient, cents, 'balance');
      if (head) add(famLevel, head, cents);
    }
    for (const [id, p] of this.people) {
      if (!blank(p.family_balance) && !famLevel.size && this.head(id) === id) {
        const cents = parseMoney(p.family_balance);
        if (cents && this.coming.has(id)) famLevel.set(id, (famLevel.get(id) || 0) + cents);
        else if (cents) unplaced.push({ ref: id, cents, reason: "The account's patient wasn't brought over", what: 'balance' });
      }
      if (!blank(p.balance)) {
        const cents = parseMoney(p.balance);
        if (!cents) continue;
        if (!this.coming.has(id)) unplaced.push({ ref: id, cents, reason: "The patient wasn't brought over", what: 'balance' });
        else add(patLevel, this.head(id), cents);
      }
    }
    let basis = 'none';
    if (famLevel.size || patLevel.size) {
      basis = 'balances';
      for (const [h, c] of patLevel) if (!famLevel.has(h)) family.set(h, c);
      for (const [h, c] of famLevel) family.set(h, c);
    } else {
      let ledgerRows = 0;
      for (const t of await this.staged('ledger')) {
        ledgerRows++;
        const how = this.valueOf('transaction_type', t.type, this.v.transactionType, undefined);
        if (!how || how === 'ignore') continue;
        const amount = parseMoney(t.amount) || 0;
        const cents = how === 'charge' ? Math.abs(amount) : how === 'credit' ? -Math.abs(amount) : amount;
        const head = place(t.patient, cents, 'ledger');
        if (head) add(family, head, cents);
      }
      if (ledgerRows) basis = 'ledger';
    }
    return { family, unplaced, basis };
  }

  // ---- Writers (the import) ----
  async writeProvider(rec) {
    const known = this.provMap.get(rec.ext);
    const existing = (known && await this.db.get('SELECT id, name, npi, type, active FROM providers WHERE id = ? AND practice_id = ?', known, this.pid))
      || (rec.npi && await this.db.get('SELECT id, name, npi, type, active FROM providers WHERE practice_id = ? AND npi = ?', this.pid, rec.npi))
      || await this.db.get('SELECT id, name, npi, type, active FROM providers WHERE practice_id = ? AND lower(name) = lower(?)', this.pid, rec.name);
    let out = 'unchanged';
    let id = existing?.id;
    if (!existing) {
      id = await insert(this.db, 'providers', { practice_id: this.pid, name: rec.name, type: rec.type, npi: rec.npi, active: rec.active });
      out = 'created';
    } else if (known && (existing.name !== rec.name || (rec.npi && existing.npi !== rec.npi) || existing.active !== rec.active)) {
      await update(this.db, 'providers', id, this.pid, { name: rec.name, npi: rec.npi || existing.npi, active: rec.active });
      out = 'updated';
    }
    await this.remember('providers', rec.ext, id, !existing);
    this.provMap.set(rec.ext, id);
    return out;
  }

  async writeOperatory(rec) {
    const known = this.opMap.get(rec.ext);
    const existing = (known && await this.db.get('SELECT id, name FROM operatories WHERE id = ? AND practice_id = ?', known, this.pid))
      || await this.db.get('SELECT id, name FROM operatories WHERE practice_id = ? AND lower(name) = lower(?)', this.pid, rec.name);
    const id = existing?.id ?? await insert(this.db, 'operatories', { practice_id: this.pid, name: rec.name, active: rec.active });
    let out = existing ? 'unchanged' : 'created';
    if (existing && known && existing.name !== rec.name) {
      await update(this.db, 'operatories', id, this.pid, { name: rec.name });
      out = 'updated';
    }
    await this.remember('operatories', rec.ext, id, !existing);
    this.opMap.set(rec.ext, id);
    return out;
  }

  async writeGuarantor(rec) {
    const me = (await this.externalId('patients', rec.id))?.local_id;
    const g = (await this.externalId('patients', rec.guarantor))?.local_id;
    if (!me || !g) return skip("The patient wasn't brought over", `patient ${rec.id}`);
    const cur = await this.db.get('SELECT guarantor_id FROM patients WHERE id = ? AND practice_id = ?', me, this.pid);
    if (cur?.guarantor_id === g) return 'unchanged';
    await update(this.db, 'patients', me, this.pid, { guarantor_id: g });
    return 'updated';
  }

  async writeProcedure(rec) {
    const p = await this.patientFor(rec.patient);
    const known = await this.externalId('procedures', rec.ext);
    const current = known && await this.db.get('SELECT id, status, fee, tooth, surfaces FROM procedures WHERE id = ? AND practice_id = ?', known.local_id, this.pid);
    const provider = this.provider(rec.provider) ?? this.defaultProvider(p);
    if (current) {
      // Completed history is left as it is; planned work follows the corrected export (or moves to completed).
      if (current.status !== 'planned') return 'unchanged';
      const row = rec.status === 'completed'
        ? { status: 'completed', completed_at: rec.date || this.today }
        : { fee: rec.fee ?? current.fee, tooth: rec.tooth, surfaces: rec.surfaces };
      const changed = Object.entries(row).some(([k, v]) => String(current[k] ?? '') !== String(v ?? ''));
      if (!changed) return 'unchanged';
      await update(this.db, 'procedures', current.id, this.pid, row);
      return 'updated';
    }
    const pc = await this.codeFor(rec.code, rec.description, rec.fee);
    let planId = null;
    if (rec.status === 'planned') {
      const key = `${rec.patient}|plan`;
      planId = (await this.externalId('plans', key))?.local_id;
      if (!planId || !await this.db.get('SELECT id FROM treatment_plans WHERE id = ? AND practice_id = ?', planId, this.pid)) {
        planId = await insert(this.db, 'treatment_plans', { practice_id: this.pid, patient_id: p.id, name: `Treatment from ${SOURCE_NAMES[this.source]}`, status: 'proposed' });
        await this.remember('plans', key, planId, true);
      }
    }
    const apt = rec.status === 'planned' && rec.appointment ? (await this.externalId('appointments', rec.appointment))?.local_id ?? null : null;
    // History without charges: the family's balance forward already carries what's owed.
    const id = await insert(this.db, 'procedures', {
      practice_id: this.pid, patient_id: p.id, treatment_plan_id: planId, appointment_id: apt, provider_id: provider, code_id: pc.id, code: pc.code,
      description: rec.description || pc.description, category: pc.category, tooth: rec.tooth, surfaces: rec.surfaces, fee: rec.fee ?? pc.fee, status: rec.status,
      completed_at: rec.status === 'completed' ? (rec.date || this.today) : null, ...(rec.status === 'planned' && rec.date ? { created_at: `${rec.date} 00:00:00` } : {}),
    });
    await this.remember('procedures', rec.ext, id, true);
    return 'created';
  }

  async writeNote(rec) {
    if (await this.externalId('notes', rec.ext)) return 'unchanged';
    const p = await this.patientFor(rec.patient);
    const id = await insert(this.db, 'clinical_notes', {
      practice_id: this.pid, patient_id: p.id, author_id: this.batch.created_by, provider_id: this.provider(rec.provider),
      body: `${rec.body}\n\n(From ${SOURCE_NAMES[this.source]})`, signed: 1, signed_at: rec.at, ...(rec.at ? { created_at: rec.at } : {}),
    });
    await this.remember('notes', rec.ext, id, true);
    return 'created';
  }

  async writePerio(rec) {
    const p = await this.patientFor(rec.patient);
    const known = await this.externalId('perio', rec.ext);
    const current = known && await this.db.get('SELECT id, readings FROM perio_exams WHERE id = ? AND practice_id = ? AND deleted_at IS NULL', known.local_id, this.pid);
    const readings = JSON.stringify(rec.readings);
    if (current) {
      if (current.readings === readings) return 'unchanged';
      await update(this.db, 'perio_exams', current.id, this.pid, { readings });
      return 'updated';
    }
    const id = await insert(this.db, 'perio_exams', { practice_id: this.pid, patient_id: p.id, provider_id: this.provider(rec.provider), exam_date: rec.date, readings });
    await this.remember('perio', rec.ext, id, true);
    return 'created';
  }

  async writeBalance({ head, cents }) {
    const p = await this.patientFor(head);
    const out = await this.balanceForward(p.id, cents, `fam|${head}`);
    return out === 'skipped' ? null : out;
  }
}

// ---- One step's rows → normalized records, the same for the dry run and the import ----
async function* records(conv, step, { page = 500, after = 0 } = {}) {
  const db = conv.db;
  let last = after;
  for (;;) {
    const rows = await db.all('SELECT id, ref, data FROM conversion_rows WHERE batch_id = ? AND tbl = ? AND id > ? ORDER BY id LIMIT ?', conv.batch.id, STEP_TABLE[step], last, page);
    if (!rows.length) return;
    for (const row of rows) {
      last = row.id;
      const d = JSON.parse(row.data);
      let rec;
      try {
        if (step === 'perio') {
          // A perio exam is many rows (one per tooth or reading); it's read once, at its first row.
          const firstId = (await db.get('SELECT MIN(id) AS id FROM conversion_rows WHERE batch_id = ? AND tbl = ? AND ref = ?', conv.batch.id, 'perio', row.ref)).id;
          if (Number(firstId) !== Number(row.id)) continue;
          rec = conv.normalizePerio(await conv.staged('perio', ' AND ref = ?', row.ref));
        } else if (step === 'balances') rec = d;
        else rec = conv[NORMALIZE[step]](d);
      } catch (err) {
        rec = { error: err.message };
      }
      if (rec === null) continue;
      yield { id: row.id, rec };
    }
  }
}
const NORMALIZE = {
  providers: 'normalizeProvider', operatories: 'normalizeOperatory', patients: 'normalizePatient', guarantors: 'normalizeGuarantor', insurance: 'normalizeInsurance',
  appointments: 'normalizeAppointment', procedures: 'normalizeProcedure', recalls: 'normalizeRecall', notes: 'normalizeNote',
};
const WRITE = {
  providers: 'writeProvider', operatories: 'writeOperatory', patients: 'patients', guarantors: 'writeGuarantor', insurance: 'insurance', appointments: 'appointments',
  procedures: 'writeProcedure', recalls: 'recalls', notes: 'writeNote', perio: 'writePerio', balances: 'writeBalance',
};
const extOf = (step, rec) => (step === 'patients' || step === 'appointments' ? rec.external_id : rec.ext);

const blankCount = () => ({ source: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0, reasons: {} });
function tally(c, status, reason, detail) {
  c[status] = (c[status] || 0) + 1;
  if (reason) {
    const r = (c.reasons[reason] ||= { count: 0, examples: [] });
    r.count++;
    if (detail && r.examples.length < 5) r.examples.push(detail);
  }
}

function mergeUnmapped(into, conv) {
  for (const u of conv.unmapped.values()) {
    const k = `${u.kind}|${u.value.toLowerCase()}`;
    const had = into[k] || { kind: u.kind, value: u.value, count: 0 };
    had.count += u.count;
    into[k] = had;
  }
}

async function familyRows(db, conv) {
  const { family, unplaced, basis } = await conv.familyBalances();
  const before = new Set((await db.all("SELECT external_id FROM external_ids WHERE practice_id = ? AND source = ? AND kind = 'balances' AND external_id LIKE 'fam|%'", conv.pid, conv.source)).map((r) => r.external_id.slice(4)));
  // Families with nothing owed are only looked at when an earlier import posted a balance for them (to take it back).
  const rows = [...family].filter(([head, cents]) => cents || before.has(head)).map(([head, cents]) => ({ head, cents }));
  for (const head of before) if (!family.has(head) && conv.coming.has(head)) rows.push({ head, cents: 0 });
  const ar = [...family.values()].reduce((t, c) => t + c, 0) + unplaced.reduce((t, u) => t + u.cents, 0);
  return { rows, unplaced, basis, ar, placed: [...family.values()].reduce((t, c) => t + c, 0) };
}

// ---- The dry run ----
export async function checkConversion(db, batch, vendor) {
  const conv = new Conversion(db, batch.practice_id, batch, vendor);
  await conv.load();
  if (!conv.people.size) throw Object.assign(new Error('No patient file was found in this export — check that the patients list is in the zip'), { status: 400 });
  const known = new Map();
  for (const r of await db.all('SELECT kind, external_id FROM external_ids WHERE practice_id = ? AND source = ?', batch.practice_id, vendor.id)) {
    if (!known.has(r.kind)) known.set(r.kind, new Set());
    known.get(r.kind).add(r.external_id);
  }
  const steps = {};
  const unmapped = {};
  const seen = new Map(); // providers/operatories this run would make (so a second row for one isn't "new" again)
  for (const step of STEPS.filter((s) => s !== 'cleanup' && s !== 'balances')) {
    const c = (steps[step] = blankCount());
    for await (const { rec } of records(conv, step)) {
      c.source++;
      if (rec instanceof Skip) {
        tally(c, 'skipped', rec.reason, rec.detail || '');
      } else if (rec.error) {
        tally(c, 'errors', rec.error, '');
      } else {
        if (step === 'patients' || step === 'appointments') {
          conv.provider(rec.provider);
          if (step === 'patients') conv.provider(rec.hygienist);
        } else if (['procedures', 'notes', 'perio'].includes(step)) conv.provider(rec.provider);
        if (step === 'perio' && rec.problems.length) {
          const r = (c.reasons["Some perio readings couldn't be read (the rest of the exam comes over)"] ||= { count: 0, examples: [] });
          r.count++;
          if (r.examples.length < 5) r.examples.push(`patient ${rec.patient} ${rec.date}: ${rec.problems.slice(0, 2).join('; ')}`);
        }
        const kind = KIND[step];
        const ext = kind && extOf(step, rec);
        const k = `${step}|${ext}`;
        if (step === 'guarantors' || (kind && (known.get(kind)?.has(String(ext)) || seen.has(k)))) c.updated++;
        else c.created++;
        if (kind) seen.set(k, true);
      }
    }
  }
  mergeUnmapped(unmapped, conv);
  conv.unmapped = new Map();
  const fam = await familyRows(db, conv);
  mergeUnmapped(unmapped, conv);
  const c = (steps.balances = blankCount());
  const posted = new Set([...(known.get('balances') || [])]);
  for (const f of fam.rows) {
    c.source++;
    if (posted.has(`fam|${f.head}`)) c.updated++;
    else c.created++;
  }
  for (const u of fam.unplaced) {
    c.source++;
    tally(c, 'skipped', u.reason, `${u.ref || '(blank)'} ${fmt(u.cents)}`);
  }
  const providers = await db.all('SELECT id, name FROM providers WHERE practice_id = ? AND active = 1 ORDER BY name', batch.practice_id);
  const summary = {
    checked_at: new Date().toISOString(),
    steps: STEPS.filter((s) => s !== 'cleanup').map((s) => ({ step: s, label: stepLabel(s), ...steps[s], reasons: reasonList(steps[s].reasons) })),
    unmapped: Object.values(unmapped).sort((a, b) => a.kind.localeCompare(b.kind) || b.count - a.count).map((u) => ({
      ...u, label: MAPPABLE[u.kind]?.label || u.kind, choices: u.kind === 'provider' ? [...providers.map((p) => ({ value: String(p.id), label: p.name })), { value: 'none', label: 'No provider' }] : MAPPABLE[u.kind]?.choices?.map((x) => ({ value: x, label: x.replace(/_/g, ' ') })) || null,
      chosen: conv.choices[u.kind]?.[u.value.toLowerCase()] ?? null, fallback: FALLBACK[u.kind],
    })),
    ar: { source: fam.ar, placed: fam.placed, families: fam.rows.filter((f) => f.cents).length, basis: fam.basis, unplaced: fam.unplaced.slice(0, 50) },
  };
  return summary;
}

const fmt = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;
const reasonList = (reasons) => Object.entries(reasons).map(([reason, r]) => ({ reason, count: r.count, examples: r.examples })).sort((a, b) => b.count - a.count);

// ---- The import, a slice at a time ----
export async function runFull(db, batch, vendor, { budgetMs = 15_000, page = 250 } = {}) {
  const state = JSON.parse(batch.pending || '{}');
  if (!state.checked) throw Object.assign(new Error('Run the check (dry run) first'), { status: 409 });
  state.step ||= STEPS[0];
  state.after ||= 0;
  state.counts ||= {};
  state.unmapped ||= {};
  const conv = new Conversion(db, batch.practice_id, batch, vendor);
  await conv.load();
  const problems = JSON.parse(batch.errors || '[]');
  const started = Date.now();
  while (state.step !== 'done' && Date.now() - started < budgetMs) {
    const step = state.step;
    if (step === 'cleanup') {
      state.reconcile = await reconcile(db, batch, vendor, state);
      // Staged rows are scratch copies of the export; once converted they're removed (hard delete is intended).
      await db.run('DELETE FROM conversion_rows WHERE batch_id = ?', batch.id);
      state.step = 'done';
      break;
    }
    const c = (state.counts[step] ||= blankCount());
    if (step === 'balances' && !state.familiesStaged) {
      const fam = await familyRows(db, conv);
      state.ar = { source: fam.ar, placed: fam.placed, basis: fam.basis, unplaced: fam.unplaced.slice(0, 50) };
      for (let i = 0; i < fam.rows.length; i += 200) {
        const part = fam.rows.slice(i, i + 200);
        await db.run(`INSERT INTO conversion_rows (batch_id, tbl, ref, data) VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}`, ...part.flatMap((f) => [batch.id, '_family', f.head, JSON.stringify(f)]));
      }
      for (const u of fam.unplaced) {
        c.source++;
        tally(c, 'skipped', u.reason, `${u.ref || '(blank)'} ${fmt(u.cents)}`);
        if (problems.length < 500) problems.push({ step, error: `${u.reason}: ${u.ref || '(blank)'} ${fmt(u.cents)}` });
      }
      state.familiesStaged = true;
    }
    let n = 0;
    let finished = true;
    for await (const { id, rec } of records(conv, step, { page, after: state.after })) {
      c.source++;
      if (rec instanceof Skip) {
        tally(c, 'skipped', rec.reason, rec.detail || '');
        if (problems.length < 500) problems.push({ step, error: `${rec.reason}${rec.detail ? `: ${rec.detail}` : ''}` });
      } else if (rec.error) {
        tally(c, 'errors', rec.error, '');
        if (problems.length < 500) problems.push({ step, error: rec.error });
      } else {
        try {
          const out = await db.savepoint(() => conv[WRITE[step]](rec));
          if (out instanceof Skip) {
            tally(c, 'skipped', out.reason, out.detail || '');
          } else if (out === null) c.source--;
          else tally(c, out === 'skipped' ? 'unchanged' : out);
        } catch (err) {
          if (err.status >= 500) throw err;
          tally(c, 'errors', err.message, '');
          if (problems.length < 500) problems.push({ step, error: err.message });
        }
      }
      state.after = id;
      if (++n >= page || Date.now() - started >= budgetMs) {
        finished = false;
        break;
      }
    }
    if (finished) {
      state.step = STEPS[STEPS.indexOf(step) + 1];
      state.after = 0;
      // Later steps look providers, chairs and patients up by their old IDs.
      if (['operatories', 'patients', 'guarantors'].includes(state.step)) await conv.load();
    }
  }
  mergeUnmapped(state.unmapped, conv);
  const t = Object.values(state.counts).reduce((a, x) => ({ created: a.created + x.created, updated: a.updated + x.updated + x.unchanged, skipped: a.skipped + x.skipped, errors: a.errors + x.errors }), { created: 0, updated: 0, skipped: 0, errors: 0 });
  const done = state.step === 'done';
  await db.run(
    `UPDATE import_batches SET pending = ?, errors = ?, created_count = ?, updated_count = ?, skipped_count = ?, error_count = ?, status = ?, finished_at = ${done ? "datetime('now')" : 'finished_at'} WHERE id = ?`,
    JSON.stringify(state), JSON.stringify(problems), t.created, t.updated, t.skipped, t.errors, done ? 'done' : 'running', batch.id,
  );
  return progressOf(state, problems);
}

export function progressOf(state, problems = []) {
  const i = state.step === 'done' ? STEPS.length : Math.max(0, STEPS.indexOf(state.step));
  return {
    step: state.step, label: stepLabel(state.step), done: state.step === 'done', progress: Math.round((100 * i) / STEPS.length),
    counts: Object.fromEntries(Object.entries(state.counts || {}).map(([k, c]) => [k, { ...c, reasons: reasonList(c.reasons || {}) }])),
    reconcile: state.reconcile || null, problems: problems.slice(-20),
  };
}

// Source against result, per step, and checked against the database: how many records from this system are
// there now, and does the balance forward posted add up to the old system's accounts receivable?
async function reconcile(db, batch, vendor, state) {
  const pid = batch.practice_id;
  const rows = [];
  const TABLE_OF = { providers: 'providers', operatories: 'operatories', patients: 'patients', appointments: 'appointments', procedures: 'procedures', notes: 'clinical_notes', perio: 'perio_exams' };
  for (const step of STEPS.filter((s) => s !== 'cleanup')) {
    const c = state.counts[step] || blankCount();
    const brought = c.created + c.updated + c.unchanged;
    const left = c.skipped + c.errors;
    const kind = KIND[step];
    let inSystem = null;
    if (kind) {
      inSystem = Number((await db.get(
        `SELECT COUNT(*) AS n FROM external_ids e JOIN ${TABLE_OF[step]} t ON t.id = e.local_id AND t.practice_id = e.practice_id WHERE e.practice_id = ? AND e.source = ? AND e.kind = ?`,
        pid, vendor.id, kind,
      )).n);
    }
    rows.push({ step, label: stepLabel(step), source: c.source, brought, created: c.created, updated: c.updated + c.unchanged, left, balanced: c.source === brought + left, in_system: inSystem });
  }
  const posted = Number((await db.get(
    `SELECT COALESCE(SUM(l.amount), 0) AS n FROM external_ids e JOIN ledger_entries l ON l.id = e.local_id AND l.practice_id = e.practice_id
     WHERE e.practice_id = ? AND e.source = ? AND e.kind = 'balances' AND e.external_id LIKE 'fam|%' AND l.voided_at IS NULL`,
    pid, vendor.id,
  )).n);
  const ar = state.ar || { source: 0, placed: 0, unplaced: [] };
  return { rows, ar: { source: ar.source, placed: ar.placed, posted, unplaced: ar.unplaced, basis: ar.basis, matches: posted === ar.placed, left: ar.source - ar.placed } };
}

export { norm };
