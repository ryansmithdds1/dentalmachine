// Practice mode: the training patient. Guided walkthroughs ("Show me", client/src/components/tours/) run on a
// pretend chart, "Tess Training", made per practice the first time someone asks for it. It is an ordinary patient
// row flagged `is_training = 1`, so every screen works on it exactly as on a real chart — but:
//
//  1. Nothing done to it leaves the office. Every outbound boundary refuses it: texts, email and calls (messaging),
//     claims, eligibility and attachments (clearinghouse), card charges and refunds (payments), e-prescriptions and
//     PDMP checks, lab and imaging-bridge orders, letters by mail, QuickBooks and deposits, reviews, webhooks and
//     the x-ray AI. Two layers: the call sites ask `refuseTraining()` (a clear message for the person), and the
//     adapters themselves (`guardAdapters`, `guardMessenger`) plus `loggedFetch` refuse anything that carries the
//     training patient — so a path someone forgets is still stopped at the wire.
//  2. Nothing done to it counts. Reports, totals, dashboards, metrics, predictions, audiences (recall, campaigns,
//     reminders, statements), exports and the day sheet read the `real_*` views (db.js), which leave it out; it
//     never uses up supplies or appears in a deposit.
//  3. Its contact details are always pretend ones (555-01xx numbers, .invalid / example addresses), so a message
//     addressed by number or address alone can be recognised as well.
//
// "Reset training patient" puts it back to a clean chart: everything recorded against it is removed and made again.
// That is the one place records are hard-deleted on purpose — training records are scratch data, never real care or
// money (their audit entries stay: the audit log is append-only). The reset itself is audited.
import { HttpError } from './auth.js';
import { insert, practiceNow, recorded, addMonths } from './util.js';
import { schemaInfo } from './db.js';
import { currentActor } from './actor.js';
import { log } from './monitoring.js';
import { accountPortion } from './autobill.js';
import { storeUpload } from './docfiles.js';

// A 16×16 grey gradient PNG: the training patient's practice x-rays.
const PRACTICE_XRAY = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAAAAAA6mKC9AAAAHUlEQVR42mNIycgpKKmoaWjp6JkwZcacBQwjWwAAwAyCAQIPaxIAAAAASUVORK5CYII=', 'base64');

export const TRAINING_MARK = 'DMTRAIN';
export const TRAINING_PATIENT = {
  first_name: 'Tess', last_name: 'Training', preferred_name: null, dob: '1990-06-15', gender: 'female',
  phone: '(555) 555-0100', email: 'tess.training@training.invalid', address: '100 Practice Lane', zip: '00000',
  allergies: null, medical_alerts: null, medications: null, office_alert: null,
  notes: 'Training patient for guided walkthroughs (Help → Show me). Nothing done here leaves the office or counts in reports.',
  sms_opt_in: 1, email_opt_in: 1, status: 'active',
};
const MEMBER_ID = `${TRAINING_MARK}0001`;

// Pretend contact details: the 555-0100…0199 numbers are reserved for fiction in every area code, and .invalid,
// .test, .example and example.com never deliver mail.
export const pretendPhone = (v) => /^\d{3}55501\d\d$/.test(String(v ?? '').replace(/\D/g, '').slice(-10));
export const pretendEmail = (v) => /@([\w-]+\.)*(invalid|test|example|localhost)$|@example\.(com|net|org)$/i.test(String(v ?? '').trim());

export async function isTrainingPatient(db, patientId) {
  if (patientId == null || patientId === '') return false;
  return !!(await db.get('SELECT is_training FROM patients WHERE id = ?', Number(patientId)))?.is_training;
}

// Refused because it would leave the office. 409 with `training: true`, which the app shows as a calm notice
// ("practice mode") rather than an error.
export class TrainingBlocked extends HttpError {
  constructor(what) {
    super(409, `Practice mode: ${what} — this is the training patient, so nothing is sent or charged. On a real patient it would happen now.`, { training: true });
    this.training = true;
  }
}
export async function refuseTraining(db, patientId, what) {
  if (await isTrainingPatient(db, patientId)) throw new TrainingBlocked(what);
}
// The same, for a record that belongs to a patient (a claim, an appointment, a ledger entry…).
export async function refuseTrainingFor(db, table, id, what) {
  if (id == null) return;
  const row = await db.get(`SELECT patient_id FROM ${table} WHERE id = ?`, Number(id));
  await refuseTraining(db, row?.patient_id, what);
}
// Several patients at once (a batch): the ones that are real, in order.
export async function realOnly(db, patientIds) {
  const ids = [...new Set(patientIds.filter((x) => x != null).map(Number))];
  if (!ids.length) return [];
  const training = new Set((await db.all(`SELECT id FROM patients WHERE is_training = 1 AND id IN (${ids.map(() => '?').join(',')})`, ...ids)).map((r) => r.id));
  return patientIds.filter((x) => x != null && !training.has(Number(x)));
}
// SQL for "this patient isn't a training patient", for queries that don't read a real_* view.
// A worklist's rows (recalls to call, the follow-up lists): the real patients only, except while someone practises a
// walkthrough (the X-Practice-Mode header), when the training patient is on it too, so the steps can be done on her.
export const worklist = (table) => (currentActor()?.practiceMode ? table : `real_${table}`);
export const NOT_TRAINING = (col = 'patient_id') => `(${col} IS NULL OR ${col} NOT IN (SELECT id FROM patients WHERE is_training = 1))`;

// ---------------------------------------------------------------------------------------------------------------
// The outbound backstop: anything about to leave that carries the training patient is refused.

// Every training patient's id and contact details (a handful across the whole server; read fresh each time, so a
// patient made a moment ago by another server process is known too).
async function trainingContacts(db) {
  const rows = await db.all('SELECT id, phone, email FROM patients WHERE is_training = 1');
  return {
    ids: new Set(rows.map((r) => r.id)),
    phones: new Set(rows.map((r) => String(r.phone || '').replace(/\D/g, '').slice(-10)).filter((d) => d.length === 10)),
    emails: new Set(rows.map((r) => String(r.email || '').trim().toLowerCase()).filter(Boolean)),
  };
}

// Looks through what is being handed to an outside service (arguments of an adapter call) for the training
// patient: the mark on its member id, its phone number or email, a patient object flagged is_training, or a
// patient_id / patientId that is a training patient's. Plain objects and arrays only, a few levels deep.
function scan(value) {
  const found = { strings: [], ids: [], training: false };
  const seen = new WeakSet();
  const walk = (v, depth, key) => {
    if (v == null || depth > 5) return;
    if (typeof v === 'string') { if (v.length < 2_000_000) found.strings.push(v); return; }
    if (typeof v === 'number') { if (/^(patient_?id|patientId|recipient_id)$/i.test(key || '')) found.ids.push(v); return; }
    if (typeof v !== 'object' || seen.has(v)) return;
    if (Buffer.isBuffer(v) || ArrayBuffer.isView(v)) return;
    seen.add(v);
    if (v instanceof URLSearchParams) { found.strings.push(v.toString()); return; }
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return; // a db handle, a class instance
    if (v.is_training) found.training = true;
    // A patient row (has names and an id) passed as itself.
    if (typeof v.id === 'number' && 'first_name' in v && 'last_name' in v && 'dob' in v) found.ids.push(v.id);
    for (const [k, x] of Array.isArray(v) ? v.entries() : Object.entries(v)) walk(x, depth + 1, String(k));
  };
  walk(value, 0, '');
  found.marked = found.training || found.strings.some((s) => s.includes(TRAINING_MARK));
  return found;
}
export async function carriesTraining(db, value) {
  const found = scan(value);
  if (found.marked) return true;
  const c = await trainingContacts(db);
  if (found.ids.some((id) => c.ids.has(Number(id)))) return true;
  for (const s of found.strings) {
    const lower = s.toLowerCase();
    for (const e of c.emails) if (lower.includes(e)) return true;
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15 && c.phones.has(digits.slice(-10))) return true;
  }
  return false;
}

// Wraps an adapter (payments, clearinghouse, e-Rx, PDMP, mail, x-ray AI, QuickBooks…): the named methods — the ones
// that send something about a patient — first check what they're given. `methods` lists them; a nested object of
// methods is named { terminal: ['start'] }. Methods that answer at once (not a promise) are listed under `sync`:
// they get the check that needs no database (the training flag and mark), as they can't wait for one.
export function guardAdapter(db, adapter, service, methods, { sync = [] } = {}) {
  if (!adapter || typeof adapter !== 'object' || adapter.__trainingGuarded) return adapter;
  const wrapped = new Map();
  for (const m of methods) {
    if (typeof m === 'object') {
      for (const [k, list] of Object.entries(m)) wrapped.set(k, () => guardAdapter(db, adapter[k], service, list));
      continue;
    }
    wrapped.set(m, () => async (...args) => {
      if (await carriesTraining(db, args)) {
        log.warn('Refused an outbound call carrying the training patient', { service, what: m });
        throw new TrainingBlocked(`${service} (${m})`);
      }
      return adapter[m](...args);
    });
  }
  for (const m of sync) {
    wrapped.set(m, () => (...args) => {
      if (scan(args).marked) throw new TrainingBlocked(`${service} (${m})`);
      return adapter[m](...args);
    });
  }
  // A proxy, so the adapter's own values (mode, enabled…) and later changes to it read through as they are.
  const made = new Map();
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === '__trainingGuarded') return true;
      const v = Reflect.get(target, prop, receiver);
      if (!wrapped.has(prop) || v == null || (typeof v !== 'function' && typeof v !== 'object')) return v;
      if (!made.has(prop) || made.get(prop)[0] !== v) made.set(prop, [v, wrapped.get(prop)()]);
      return made.get(prop)[1];
    },
  });
}

// The messenger (texts, email, calls): the destination itself is checked — a training patient's number or address
// never goes to the carrier. sendMessage (messaging.js) stops training patients before this, with a "blocked"
// message on the chart; this catches the paths that send by address alone.
export function guardMessenger(db, messenger) {
  if (!messenger || messenger.__trainingGuarded) return messenger;
  const check = async (args) => {
    if (await carriesTraining(db, args)) {
      log.warn('Refused a message to the training patient', {});
      throw new TrainingBlocked('a message to the training patient');
    }
  };
  const send = async (m) => { await check([{ to: m?.to, body: m?.body, subject: m?.subject }]); return messenger.send(m); };
  const call = async (to, ...rest) => { await check([to]); return messenger.call(to, ...rest); };
  return new Proxy(messenger, {
    get(target, prop, receiver) {
      if (prop === '__trainingGuarded') return true;
      if (prop === 'send') return send;
      if (prop === 'call' && target.call) return call;
      return Reflect.get(target, prop, receiver);
    },
  });
}

// For loggedFetch: a request whose address or body carries the training mark is never sent.
export function fetchCarriesTraining(url, opts = {}) {
  const parts = [String(url)];
  const b = opts.body;
  if (typeof b === 'string') parts.push(b);
  else if (b instanceof URLSearchParams) parts.push(b.toString());
  else if (Buffer.isBuffer(b)) parts.push(b.toString('latin1'));
  return parts.some((s) => s.includes(TRAINING_MARK));
}

// ---------------------------------------------------------------------------------------------------------------
// Making, finding and resetting the training patient.

const firstId = async (db, sql, ...args) => (await db.get(sql, ...args))?.id ?? null;

export async function trainingPatientOf(db, practiceId) {
  return await db.get('SELECT * FROM patients WHERE practice_id = ? AND is_training = 1 AND guarantor_id IS NULL ORDER BY id LIMIT 1', practiceId);
}

// The training patient for a practice, made (with its clean starting chart) if there isn't one yet.
export async function ensureTrainingPatient(db, practiceId, userId) {
  const existing = await trainingPatientOf(db, practiceId);
  if (existing) return existing;
  const practice = await db.get('SELECT city, state FROM practices WHERE id = ?', practiceId);
  const dentist = await firstId(db, "SELECT id FROM providers WHERE practice_id = ? AND active = 1 AND type = 'dentist' ORDER BY id LIMIT 1", practiceId);
  const hygienist = await firstId(db, "SELECT id FROM providers WHERE practice_id = ? AND active = 1 AND type = 'hygienist' ORDER BY id LIMIT 1", practiceId);
  const location = await firstId(db, 'SELECT id FROM locations WHERE practice_id = ? ORDER BY id LIMIT 1', practiceId);
  const id = await insert(db, 'patients', {
    ...TRAINING_PATIENT, practice_id: practiceId, city: practice?.city || 'Practiceville', state: practice?.state || 'TX',
    primary_provider_id: dentist, primary_hygienist_id: hygienist, location_id: location, is_training: 1,
  });
  await seedChart(db, practiceId, id, userId);
  return await db.get('SELECT * FROM patients WHERE id = ?', id);
}

// The clean starting chart: insurance, a finished visit three months ago (so there is a balance and history), and a
// cleaning that is due (recall). Everything else a walkthrough needs is made just before it by prepareTraining().
async function seedChart(db, practiceId, patientId, userId) {
  const now = await practiceNow(db, practiceId);
  const today = now.slice(0, 10);
  const carrier = await firstId(db, 'SELECT id FROM insurance_carriers WHERE practice_id = ? ORDER BY id LIMIT 1', practiceId)
    ?? await insert(db, 'insurance_carriers', { practice_id: practiceId, name: 'Delta Dental (training)', payer_id: TRAINING_MARK });
  await insert(db, 'patient_insurance', {
    practice_id: practiceId, patient_id: patientId, carrier_id: carrier, priority: 'primary', subscriber_name: 'Tess Training', subscriber_id: MEMBER_ID,
    subscriber_dob: TRAINING_PATIENT.dob, relationship: 'self', group_number: 'TRAINING', annual_max: 150000, deductible: 5000,
  });
  const past = addMonths(today, -3);
  const dentist = await firstId(db, "SELECT id FROM providers WHERE practice_id = ? AND active = 1 ORDER BY CASE type WHEN 'dentist' THEN 0 ELSE 1 END, id LIMIT 1", practiceId);
  if (dentist) {
    const chair = await firstId(db, 'SELECT id FROM operatories WHERE practice_id = ? AND active = 1 ORDER BY id LIMIT 1', practiceId);
    const visit = await insert(db, 'appointments', {
      practice_id: practiceId, patient_id: patientId, provider_id: dentist, operatory_id: chair, start_time: `${past} 09:00`, end_time: `${past} 10:00`,
      status: 'completed', reason: 'Exam and cleaning (training)',
    });
    for (const code of ['D0120', 'D1110']) await addProcedure(db, practiceId, patientId, code, { status: 'completed', date: past, appointmentId: visit, providerId: dentist, userId });
  }
  await insert(db, 'recalls', { practice_id: practiceId, patient_id: patientId, type: 'prophy', interval_months: 6, due_date: addMonths(today, -1).slice(0, 8) + '01', status: 'due' });
}

// A procedure on the training chart. Completed ones post their charge like any other (the ledger is the source of
// truth for the training balance too) — straight here rather than through completeProcedure, which would also use up
// supplies and reset recalls.
async function addProcedure(db, practiceId, patientId, code, { status = 'planned', date, appointmentId = null, providerId = null, userId = null, tooth = null, surfaces = null, planId = null } = {}) {
  const c = await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ?', practiceId, code);
  if (!c) return null;
  const fee = Number(c.fee ?? c.default_fee ?? 0) || 0;
  const id = await insert(db, 'procedures', {
    practice_id: practiceId, patient_id: patientId, code_id: c.id, code: c.code, description: c.description, category: c.category || 'other', fee,
    status, tooth, surfaces, appointment_id: appointmentId, provider_id: providerId, treatment_plan_id: planId, ...(status === 'completed' ? { completed_at: `${date} 10:00:00` } : {}),
  });
  if (status === 'completed') {
    await insert(db, 'ledger_entries', {
      practice_id: practiceId, patient_id: patientId, type: 'charge', amount: fee, description: `${c.code} ${c.description}${tooth ? ` #${tooth}` : ''}`,
      procedure_id: id, provider_id: providerId, entry_date: date, created_by: userId,
    });
  }
  return id;
}

// Everything recorded against the training patients (Tess, her family, patients made in walkthroughs), found by following the schema's
// references outward from it: rows that point at the patient, rows that point at those rows, and so on. Parents
// (providers, carriers, deposits, the practice…) are never included, and the audit log is left alone.
const KEEP = new Set(['audit_log', 'tour_runs', 'practices', 'users']);
export async function trainingFootprint(db, practiceId, patientId) {
  const info = schemaInfo();
  const byRef = new Map(); // table referenced -> [[table, column]]
  for (const [table, cols] of info) {
    if (KEEP.has(table)) continue;
    for (const c of cols) if (c.ref) (byRef.get(c.ref) || byRef.set(c.ref, []).get(c.ref)).push([table, c.name]);
  }
  const hasId = (t) => info.get(t)?.some((c) => c.name === 'id');
  const hasPractice = (t) => info.get(t)?.some((c) => c.name === 'practice_id');
  // Every training patient in the practice: Tess, her pretend family, and patients made during walkthroughs.
  const family = (await db.all('SELECT id FROM patients WHERE practice_id = ? AND is_training = 1', practiceId)).map((r) => r.id);
  const found = new Map([['patients', new Set(family)]]);
  const links = []; // [table, column, ids] for tables without an id of their own
  const queue = ['patients'];
  while (queue.length) {
    const parent = queue.shift();
    const ids = [...found.get(parent)];
    if (!ids.length) continue;
    for (const [table, col] of byRef.get(parent) || []) {
      if (table === 'patients') continue; // other patients are never swept up (training family members are found above)
      const scope = hasPractice(table) ? ' AND practice_id = ?' : '';
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const where = `${col} IN (${chunk.map(() => '?').join(',')})${scope}`;
        const args = [...chunk, ...(scope ? [practiceId] : [])];
        if (!hasId(table)) { links.push([table, col, chunk]); continue; }
        const rows = await db.all(`SELECT id FROM ${table} WHERE ${where}`, ...args);
        if (!rows.length) continue;
        const set = found.get(table) || found.set(table, new Set()).get(table);
        let added = false;
        for (const r of rows) if (!set.has(r.id)) { set.add(r.id); added = true; }
        if (added) queue.push(table);
      }
    }
  }
  // The training patient's own row stays (it is reset in place, keeping its id and chart number).
  found.get('patients').delete(Number(patientId));
  return { found, links };
}

// For exports (the practice's data export, report CSVs): a test for "this row is the training patient's" — the
// patient itself, training family members, everything recorded against them, and any row naming them in patient_id.
export async function trainingRowFilter(db, practiceId) {
  const ids = new Map();
  const links = [];
  const patientIds = new Set((await db.all('SELECT id FROM patients WHERE practice_id = ? AND is_training = 1', practiceId)).map((r) => r.id));
  if (patientIds.size) {
    const fp = await trainingFootprint(db, practiceId, [...patientIds][0]);
    for (const [t, set] of fp.found) for (const id of set) (ids.get(t) || ids.set(t, new Set()).get(t)).add(id);
    links.push(...fp.links.map(([t, col, list]) => [t, col, new Set(list)]));
  }
  (ids.get('patients') || ids.set('patients', new Set()).get('patients')).clear();
  for (const id of patientIds) ids.get('patients').add(id);
  // Its own insurance plan (no real patient on it) and the pretend carrier made when the practice had none.
  const plans = await db.all(
    `SELECT DISTINCT pi.plan_id AS id FROM patient_insurance pi JOIN patients p ON p.id = pi.patient_id WHERE pi.practice_id = ? AND p.is_training = 1 AND pi.plan_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM patient_insurance r JOIN patients rp ON rp.id = r.patient_id WHERE r.plan_id = pi.plan_id AND rp.is_training = 0)`, practiceId,
  );
  ids.set('insurance_plans', new Set(plans.map((r) => r.id)));
  ids.set('insurance_carriers', new Set((await db.all('SELECT id FROM insurance_carriers WHERE practice_id = ? AND payer_id = ?', practiceId, TRAINING_MARK)).map((r) => r.id)));
  return (table, row) => {
    if (ids.get(table)?.has(row.id)) return true;
    if (patientIds.has(row.patient_id)) return true;
    return links.some(([t, col, list]) => t === table && list.has(row[col]));
  };
}

// Removes what trainingFootprint found. Rows that other rows still point at go on a later pass; references inside
// the set that point both ways (a ledger entry and its reversal) are cleared first.
async function sweep(db, { found, links }) {
  let removed = 0;
  for (const [table, col, ids] of links) removed += (await db.run(`DELETE FROM ${table} WHERE ${col} IN (${ids.map(() => '?').join(',')})`, ...ids)).changes;
  const info = schemaInfo();
  for (const [table, ids] of found) {
    for (const c of info.get(table) || []) {
      if (!c.ref || c.notnull || !found.has(c.ref)) continue;
      const list = [...ids];
      for (let i = 0; i < list.length; i += 500) {
        const chunk = list.slice(i, i + 500);
        await db.run(`UPDATE ${table} SET ${c.name} = NULL WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk).catch(() => { /* a later pass removes the row anyway */ });
      }
    }
  }
  const left = new Map([...found].map(([t, s]) => [t, new Set(s)]));
  for (let pass = 0; pass < 12 && [...left.values()].some((s) => s.size); pass++) {
    for (const [table, ids] of left) {
      for (const id of [...ids]) {
        try {
          const r = await db.run(`DELETE FROM ${table} WHERE id = ?`, id);
          removed += r.changes;
          ids.delete(id);
        } catch { /* still referenced by another row being removed: next pass */ }
      }
    }
  }
  const stuck = [...left].filter(([, s]) => s.size).map(([t, s]) => `${t} (${s.size})`);
  if (stuck.length) throw new Error(`The training patient could not be fully reset: ${stuck.join(', ')} still referenced`);
  return removed;
}

// Back to a clean chart. Returns what was removed, by table (for the audit entry).
export async function resetTrainingPatient(db, practiceId, patientId, userId, { storage = null } = {}) {
  const p = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', Number(patientId), practiceId);
  if (!p?.is_training) throw new HttpError(404, 'Training patient not found');
  const footprint = await trainingFootprint(db, practiceId, p.id);
  const counts = Object.fromEntries([...footprint.found].filter(([, s]) => s.size).map(([t, s]) => [t, s.size]));
  // The files behind the training documents (practice x-rays, scans made in walkthroughs) go with their rows.
  const docIds = [...(footprint.found.get('documents') || [])];
  const files = [];
  for (let i = 0; i < docIds.length; i += 500) {
    const chunk = docIds.slice(i, i + 500);
    files.push(...(await db.all(`SELECT storage_key FROM documents WHERE id IN (${chunk.map(() => '?').join(',')}) AND storage_key IS NOT NULL`, ...chunk)).map((r) => r.storage_key));
  }
  const removed = await sweep(db, footprint);
  for (const key of storage ? files : []) {
    // A file left behind is only disk space (its row is gone); said in the log, never silently dropped.
    await storage.remove(key).catch((e) => log.warn('A training file couldn’t be removed on reset', { error: e.message }));
  }
  const restore = Object.fromEntries(Object.keys(TRAINING_PATIENT).map((k) => [k, TRAINING_PATIENT[k]]));
  const cols = new Set((schemaInfo().get('patients') || []).map((c) => c.name));
  // Everything else a tour may have filled in (referral source, office alert, photo, card on file…) goes blank.
  const blank = ['referral_source', 'referred_by_id', 'photo', 'stripe_customer_id', 'deceased_at', 'preferred_contact', 'language', 'medical_conditions', 'asa_class',
    'medical_reviewed_at', 'guarantor_id', 'second_responsible_id', 'emergency_contact', 'premed_required', 'phone_home', 'phone_work', 'custom_fields']
    .filter((k) => cols.has(k));
  await recorded(db, 'patients', p.id, () => db.run(
    `UPDATE patients SET ${[...Object.keys(restore), ...blank].map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    ...Object.values(restore), ...blank.map((k) => (k === 'premed_required' ? 0 : null)), p.id,
  ));
  await seedChart(db, practiceId, p.id, userId);
  return { removed, counts };
}

// ---------------------------------------------------------------------------------------------------------------
// Getting the training chart ready for one walkthrough. `needs` come from the tour (tours.json):
//   visit_today[:status]  a visit today (scheduled, confirmed, checked_in, in_chair or completed) in a free evening
//                         time — kept to one, moved to the status asked for
//   visit_future          a visit booked a week or so ahead
//   visit_planned         today's visit, in the chair, with work planned on it (to set complete)
//   unbilled              finished work today that isn't on a claim yet
//   planned               a proposed treatment plan with a crown on #14
//   draft_note            an unsigned clinical note today
//   claim_sent            a claim that went out (marked sent here — nothing is sent)
//   paid_up / owes        nothing / something due now at checkout (a training payment or charge on her ledger)
//   recall_open           the next cleaning still to book (future training visits cancelled, the recall due)
//   lab_case              a case at the lab, due back today
//   xrays                 a set of four practice bitewings (grey pictures) to open
// Returns the ids the tour's steps refer to: { patient, appt, appt_date, note, plan, claim }.
export const NEEDS = ['visit_today', 'visit_future', 'visit_planned', 'unbilled', 'planned', 'draft_note', 'claim_sent', 'paid_up', 'owes', 'recall_open', 'lab_case', 'xrays'];
const STATUSES = ['scheduled', 'confirmed', 'checked_in', 'in_chair', 'completed'];

export function parseNeeds(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 10) throw new HttpError(400, 'needs must be a short list');
  return list.map((n) => {
    const [kind, arg] = String(n).split(':');
    if (!NEEDS.includes(kind)) throw new HttpError(400, `Unknown training set-up: ${kind}`);
    if (kind === 'visit_today' && arg && !STATUSES.includes(arg)) throw new HttpError(400, `Unknown visit status: ${arg}`);
    if (kind === 'visit_future' && arg && !/^([1-9]|[1-5]\d|60)$/.test(arg)) throw new HttpError(400, 'visit_future takes a number of days (1-60)');
    return { kind, arg: arg || null };
  });
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// A time that day with nobody else in the chair (evenings first, so the practice's real day is never crowded).
async function freeSlot(db, practiceId, date, chair, length = 40) {
  const taken = await db.all("SELECT start_time, end_time FROM appointments WHERE practice_id = ? AND operatory_id = ? AND substr(start_time, 1, 10) = ? AND status NOT IN ('cancelled','no_show')", practiceId, chair, date);
  const busy = (a, b) => taken.some((t) => t.start_time.slice(11, 16) < b && t.end_time.slice(11, 16) > a);
  for (const start of [19 * 60, 19 * 60 + 45, 20 * 60 + 30, 21 * 60 + 15, 18 * 60, 17 * 60 + 15, 22 * 60, 7 * 60, 6 * 60]) {
    const a = hhmm(start); const b = hhmm(start + length);
    if (!busy(a, b)) return [a, b];
  }
  return ['22:45', '23:25'];
}

export async function prepareTraining(db, practiceId, patientId, needs, userId, { storage = null, req = null } = {}) {
  const p = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ? AND is_training = 1', Number(patientId), practiceId);
  if (!p) throw new HttpError(404, 'Training patient not found');
  const now = await practiceNow(db, practiceId);
  const today = now.slice(0, 10);
  const out = { patient: p.id, first: p.first_name, last: p.last_name, today };
  const dentist = p.primary_provider_id || await firstId(db, "SELECT id FROM providers WHERE practice_id = ? AND active = 1 ORDER BY CASE type WHEN 'dentist' THEN 0 ELSE 1 END, id LIMIT 1", practiceId);
  const chair = await firstId(db, 'SELECT id FROM operatories WHERE practice_id = ? AND active = 1 ORDER BY id LIMIT 1', practiceId);
  const visitOn = async (date, status, reason) => {
    let a = await db.get("SELECT * FROM appointments WHERE practice_id = ? AND patient_id = ? AND substr(start_time, 1, 10) = ? AND status NOT IN ('cancelled','no_show') ORDER BY CASE WHEN provider_id = ? THEN 0 ELSE 1 END, id DESC LIMIT 1", practiceId, p.id, date, dentist ?? 0);
    if (!a) {
      if (!dentist) throw new HttpError(400, 'Add a provider before practising scheduling tours');
      const [start, end] = await freeSlot(db, practiceId, date, chair);
      const id = await insert(db, 'appointments', { practice_id: practiceId, patient_id: p.id, provider_id: dentist, operatory_id: chair, start_time: `${date} ${start}`, end_time: `${date} ${end}`, status: 'scheduled', reason });
      a = await db.get('SELECT * FROM appointments WHERE id = ?', id);
    }
    if (status && a.status !== status) {
      const flow = { checked_in: 'arrived_at', in_chair: 'seated_at', completed: 'dismissed_at' };
      await recorded(db, 'appointments', a.id, () => db.run(`UPDATE appointments SET status = ?${flow[status] ? `, ${flow[status]} = COALESCE(${flow[status]}, ?)` : ''} WHERE id = ?`, status, ...(flow[status] ? [now] : []), a.id));
    }
    return a;
  };
  for (const { kind, arg } of parseNeeds(needs)) {
    if (kind === 'visit_today') {
      const a = await visitOn(today, arg || 'scheduled', 'Exam and cleaning (training)');
      out.appt = a.id; out.appt_date = today;
    } else if (kind === 'visit_future' && arg) {
      // visit_future:N — a visit N days ahead (tomorrow's verification list).
      const d = addDays(today, Number(arg));
      const a = await visitOn(d, 'scheduled', 'Cleaning (training)');
      out.appt = a.id; out.appt_date = d;
    } else if (kind === 'visit_future') {
      // With the practice's usual dentist, so the schedule shows it whichever provider filter is on.
      let d = addDays(today, 7);
      const a = await db.get("SELECT * FROM appointments WHERE practice_id = ? AND patient_id = ? AND provider_id = ? AND start_time > ? AND status IN ('scheduled','confirmed') ORDER BY start_time LIMIT 1", practiceId, p.id, dentist, `${today} 24:00`);
      if (a) { out.appt = a.id; out.appt_date = a.start_time.slice(0, 10); continue; }
      if (new Date(`${d}T12:00:00Z`).getUTCDay() === 0) d = addDays(d, 1);
      const made = await visitOn(d, 'scheduled', 'Cleaning (training)');
      out.appt = made.id; out.appt_date = d;
    } else if (kind === 'visit_planned') {
      const a = await visitOn(today, 'in_chair', 'Exam and x-rays (training)');
      if (!(await db.get("SELECT id FROM procedures WHERE appointment_id = ? AND status = 'planned'", a.id))) {
        for (const code of ['D0120', 'D0274']) await addProcedure(db, practiceId, p.id, code, { status: 'planned', appointmentId: a.id, providerId: dentist });
      }
      out.appt = a.id; out.appt_date = today;
    } else if (kind === 'unbilled') {
      const open = await db.get("SELECT id FROM procedures WHERE patient_id = ? AND status = 'completed' AND substr(completed_at, 1, 10) = ? AND id NOT IN (SELECT procedure_id FROM claim_items WHERE procedure_id IS NOT NULL)", p.id, today);
      if (!open) {
        const a = await visitOn(today, 'completed', 'Exam and cleaning (training)');
        for (const code of ['D0120', 'D1110', 'D0274']) await addProcedure(db, practiceId, p.id, code, { status: 'completed', date: today, appointmentId: a.id, providerId: dentist, userId });
        out.appt = a.id; out.appt_date = today;
      } else {
        const a = await db.get('SELECT a.id FROM procedures x JOIN appointments a ON a.id = x.appointment_id WHERE x.id = ?', open.id);
        const v = a || await visitOn(today, 'completed', 'Exam and cleaning (training)');
        out.appt = v.id; out.appt_date = today;
      }
    } else if (kind === 'paid_up' || kind === 'owes') {
      // Checkout goes a different way when something is due now (the amount first) than when nothing is (straight
      // to the next visit): the walkthrough gets the one it shows. A training payment or charge, on the training
      // ledger only (excluded from every total), like any other entry.
      const portion = await accountPortion(db, practiceId, p.guarantor_id || p.id);
      if (kind === 'paid_up' && portion > 0) {
        await insert(db, 'ledger_entries', { practice_id: practiceId, patient_id: p.id, type: 'payment', amount: -portion, method: 'cash', description: 'Payment (training: settles the practice balance for a walkthrough)', entry_date: today, created_by: userId });
      } else if (kind === 'owes' && portion <= 0) {
        await insert(db, 'ledger_entries', { practice_id: practiceId, patient_id: p.id, type: 'charge', amount: 4500 - portion, description: 'Training balance (for a walkthrough)', entry_date: today, created_by: userId });
      }
    } else if (kind === 'xrays') {
      // A set of four bitewings to open (pictures made up for practice: plain grey gradients).
      if (!(await db.get("SELECT id FROM image_mounts WHERE patient_id = ? AND slots != '{}' LIMIT 1", p.id))) {
        if (!storage) throw new HttpError(400, 'X-rays can’t be set up here');
        const slots = {};
        for (const [i, tooth] of [[0, '3'], [1, '14'], [2, '19'], [3, '30']]) {
          const doc = await storeUpload(db, storage, { body: PRACTICE_XRAY, filename: `training-bitewing-${i + 1}.png`, declared: 'image/png', category: 'xray', tooth, practiceId, patientId: p.id, uploadedBy: userId, source: 'training', req, notes: 'Training x-ray (a plain grey gradient)' });
          slots[i] = doc.id;
        }
        await insert(db, 'image_mounts', { practice_id: practiceId, patient_id: p.id, template: 'bw4', taken_at: today, slots: JSON.stringify(slots), created_by: userId });
      }
    } else if (kind === 'lab_case') {
      // A case at the lab, due back today (Lab check-in lists it).
      let c = await db.get("SELECT id FROM lab_cases WHERE practice_id = ? AND patient_id = ? AND status IN ('sent','returned_for_adjustment') ORDER BY id DESC LIMIT 1", practiceId, p.id);
      if (!c) c = { id: await insert(db, 'lab_cases', { practice_id: practiceId, patient_id: p.id, provider_id: dentist, lab_name: 'Training Lab', description: 'Crown #14 (training)', tooth: '14', status: 'sent', sent_date: addDays(today, -7), due_date: today }) };
      out.lab_case = c.id;
    } else if (kind === 'recall_open') {
      // The next hygiene visit is still to book: no visit booked after today, the recall due.
      for (const a of await db.all("SELECT id FROM appointments WHERE practice_id = ? AND patient_id = ? AND start_time > ? AND status IN ('scheduled','confirmed')", practiceId, p.id, `${today} 24:00`)) {
        await recorded(db, 'appointments', a.id, () => db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", a.id));
      }
      const r = await db.get('SELECT id, status FROM recalls WHERE practice_id = ? AND patient_id = ? ORDER BY id LIMIT 1', practiceId, p.id);
      if (r && !['due', 'contacted'].includes(r.status)) await recorded(db, 'recalls', r.id, () => db.run("UPDATE recalls SET status = 'due', appointment_id = NULL WHERE id = ?", r.id));
      if (!r) await insert(db, 'recalls', { practice_id: practiceId, patient_id: p.id, type: 'prophy', interval_months: 6, due_date: today, status: 'due' });
    } else if (kind === 'planned') {
      // A proposed plan with work still planned on it (one a walkthrough emptied or had signed doesn't count).
      let plan = await db.get("SELECT tp.id FROM treatment_plans tp WHERE tp.patient_id = ? AND tp.status = 'proposed' AND tp.signed_at IS NULL AND EXISTS (SELECT 1 FROM procedures x WHERE x.treatment_plan_id = tp.id AND x.status = 'planned') ORDER BY tp.id DESC LIMIT 1", p.id);
      if (!plan) {
        const id = await insert(db, 'treatment_plans', { practice_id: practiceId, patient_id: p.id, name: 'Crown #14 (training)', status: 'proposed' });
        await addProcedure(db, practiceId, p.id, 'D2740', { status: 'planned', tooth: '14', planId: id, providerId: dentist });
        plan = { id };
      }
      out.plan = plan.id;
    } else if (kind === 'draft_note') {
      let note = await db.get('SELECT id FROM clinical_notes WHERE patient_id = ? AND signed = 0 ORDER BY id DESC LIMIT 1', p.id);
      if (!note) {
        const author = userId || (await firstId(db, "SELECT id FROM users WHERE practice_id = ? AND role = 'admin' ORDER BY id LIMIT 1", practiceId));
        note = { id: await insert(db, 'clinical_notes', { practice_id: practiceId, patient_id: p.id, provider_id: dentist, author_id: author, body: 'Periodic exam. No new findings. Home care reviewed. (Training note)' }) };
      }
      out.note = note.id;
    } else if (kind === 'claim_sent') {
      let claim = await db.get("SELECT id FROM claims WHERE patient_id = ? AND status = 'submitted' ORDER BY id DESC LIMIT 1", p.id);
      if (!claim) {
        const policy = await db.get("SELECT id FROM patient_insurance WHERE patient_id = ? AND active = 1 ORDER BY CASE priority WHEN 'primary' THEN 0 ELSE 1 END LIMIT 1", p.id);
        const procs = await db.all("SELECT * FROM procedures WHERE patient_id = ? AND status = 'completed' AND id NOT IN (SELECT procedure_id FROM claim_items WHERE procedure_id IS NOT NULL) ORDER BY id", p.id);
        if (policy && procs.length) {
          const total = procs.reduce((s, x) => s + Number(x.fee || 0), 0);
          const id = await insert(db, 'claims', { practice_id: practiceId, patient_id: p.id, patient_insurance_id: policy.id, status: 'submitted', total_fee: total, submitted_at: now });
          for (const x of procs) await insert(db, 'claim_items', { claim_id: id, procedure_id: x.id, fee: x.fee });
          claim = { id };
        }
      }
      out.claim = claim?.id ?? null;
    }
  }
  return out;
}

const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

// Who is doing training set-up, for the audit trail (a person started a tour; the set-up is automation for them).
export const trainingActor = (user) => ({ source: 'automation', actor: `Training set-up (for ${user.name})`, userId: user.id, practiceId: user.practice_id, ...(currentActor()?.ip ? { ip: currentActor().ip } : {}) });
