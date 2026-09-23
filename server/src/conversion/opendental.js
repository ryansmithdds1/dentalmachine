import { insert } from '../util.js';
import { Importer, parseDate } from '../importer.js';

// Full conversion from an Open Dental backup. The browser reads the backup and sends the rows of these
// tables; they wait in conversion_rows until the office starts the conversion, which then runs step by step
// (each call does a slice, so it fits in a web request and can pick up where it stopped). Every record made
// is remembered against its Open Dental number, so the batch can be undone and a re-run updates rather than
// duplicates. Ledger history comes across in full, and each family's balance is then brought to exactly
// what Open Dental showed with one "conversion balance" adjustment.
export const OD_TABLES = [
  'definition', 'provider', 'operatory', 'patient', 'carrier', 'insplan', 'inssub', 'patplan', 'procedurecode', 'appointment',
  'procedurelog', 'recalltype', 'recall', 'payment', 'paysplit', 'adjustment', 'claimproc', 'procnote', 'commlog', 'perioexam', 'periomeasure',
];
// Which column groups a table's rows for the steps that read them together.
export const REF = { periomeasure: 'perioexamnum', procnote: 'procnum', paysplit: 'paynum', payment: 'paynum', procedurelog: 'procnum' };
export const STEPS = ['providers', 'operatories', 'patients', 'guarantors', 'insurance', 'appointments', 'procedures', 'recalls', 'charges', 'payments', 'adjustments', 'insurance_payments', 'balances', 'notes', 'commlogs', 'perio', 'cleanup'];
const STEP_TABLE = {
  providers: 'provider', operatories: 'operatory', patients: 'patient', guarantors: 'patient', insurance: 'patplan', appointments: 'appointment',
  procedures: 'procedurelog', recalls: 'recall', charges: 'procedurelog', payments: 'paysplit', adjustments: 'adjustment', insurance_payments: 'claimproc',
  balances: 'patient', notes: 'procnote', commlogs: 'commlog', perio: 'perioexam',
};
const LABEL = {
  providers: 'Providers', operatories: 'Chairs', patients: 'Patients', guarantors: 'Families', insurance: 'Insurance', appointments: 'Appointments',
  procedures: 'Completed and planned work', recalls: 'Recalls', charges: 'Charges', payments: 'Payments', adjustments: 'Adjustments',
  insurance_payments: 'Insurance payments', balances: 'Family balances', notes: 'Clinical notes', commlogs: 'Communication history', perio: 'Perio charts', cleanup: 'Finishing',
};
export const stepLabel = (s) => LABEL[s] || s;

const num = (v) => (v == null || v === '' ? null : String(v));
const cents = (v) => Math.round(Number(v || 0) * 100);
const dateOf = (v) => {
  try {
    return parseDate(String(v || '').slice(0, 10));
  } catch {
    return null;
  }
};
const text = (v) => (v == null ? '' : String(v).trim());
// Open Dental payment and adjustment types are "definitions" the office named; the name says what it is.
const methodFrom = (name) => {
  const s = String(name || '').toLowerCase();
  if (/care ?credit/.test(s)) return 'care_credit';
  if (/cash/.test(s)) return 'cash';
  if (/check|chk|cheque/.test(s)) return 'check';
  if (/debit/.test(s)) return 'debit_card';
  if (/credit|card|visa|master|amex|discover|stripe|square/.test(s)) return 'credit_card';
  if (/ach|eft|bank/.test(s)) return 'ach';
  return 'other';
};

class Converter extends Importer {
  async load() {
    await this.lookups();
    const map = async (kind) => new Map((await this.db.all('SELECT external_id, local_id FROM external_ids WHERE practice_id = ? AND source = ? AND kind = ?', this.pid, 'opendental', kind)).map((r) => [r.external_id, r.local_id]));
    this.provMap = await map('providers');
    this.opMap = await map('operatories');
    this.patMap = await map('patients');
    this.defs = new Map((await this.staged('definition')).map((d) => [num(d.defnum), text(d.itemname)]));
    this.codes = new Map((await this.staged('procedurecode')).map((c) => [num(c.codenum), c]));
    const byKey = async (tbl, key) => new Map((await this.staged(tbl)).map((x) => [num(x[key]), x]));
    this.subs = await byKey('inssub', 'inssubnum');
    this.plans = await byKey('insplan', 'plannum');
    this.carriers = await byKey('carrier', 'carriernum');
    this.recallTypes = await byKey('recalltype', 'recalltypenum');
  }

  async staged(tbl, where = '', ...args) {
    return (await this.db.all(`SELECT data FROM conversion_rows WHERE batch_id = ? AND tbl = ?${where} ORDER BY id`, this.batch.id, tbl, ...args)).map((r) => JSON.parse(r.data));
  }

  // Open Dental numbers (ProvNum, Op) → ours.
  provider(v) { return this.provMap?.get(num(v)) ?? null; }
  operatory(v) { return this.opMap?.get(num(v)) ?? null; }
  pat(v) { return this.patMap.get(num(v)) ?? null; }

  async provider_(r) {
    const name = [text(r.fname), text(r.lname)].filter(Boolean).join(' ') || text(r.abbr) || `Provider ${r.provnum}`;
    const full = `${name}${text(r.suffix) ? `, ${text(r.suffix)}` : ''}`;
    const npi = text(r.nationalprovid) || null;
    const existing = (npi && await this.db.get('SELECT id FROM providers WHERE practice_id = ? AND npi = ?', this.pid, npi))
      || await this.db.get('SELECT id FROM providers WHERE practice_id = ? AND lower(name) = lower(?)', this.pid, full);
    const id = existing?.id ?? await insert(this.db, 'providers', {
      practice_id: this.pid, name: full, type: Number(r.issecondary) ? 'hygienist' : 'dentist', npi, active: Number(r.ishidden) ? 0 : 1,
    });
    await this.remember('providers', num(r.provnum), id, !existing);
    return existing ? 'updated' : 'created';
  }

  async operatory_(r) {
    const name = text(r.opname) || text(r.abbrev) || `Op ${r.operatorynum}`;
    const existing = await this.db.get('SELECT id FROM operatories WHERE practice_id = ? AND lower(name) = lower(?)', this.pid, name);
    const id = existing?.id ?? await insert(this.db, 'operatories', { practice_id: this.pid, name, active: Number(r.ishidden) ? 0 : 1 });
    await this.remember('operatories', num(r.operatorynum), id, !existing);
    return existing ? 'updated' : 'created';
  }

  async patient(r) {
    const out = await this.patients({
      external_id: num(r.patnum), first_name: text(r.fname), last_name: text(r.lname), preferred_name: text(r.preferred), dob: text(r.birthdate),
      gender: r.gender == null ? '' : String(r.gender), phone: text(r.wirelessphone), phone_home: text(r.hmphone), phone_work: text(r.wkphone), email: text(r.email),
      address: text(r.address), address2: text(r.address2), city: text(r.city), state: text(r.state), zip: text(r.zip), status: r.patstatus == null ? '' : String(r.patstatus),
      provider: num(r.priprov), hygienist: Number(r.secprov) ? num(r.secprov) : '', medical_alerts: text(r.medurgnote), referral_source: '', allergies: '', medications: '', notes: '',
    });
    this.guarantors = [];
    const id = (await this.externalId('patients', num(r.patnum)))?.local_id;
    if (id) this.patMap.set(num(r.patnum), id);
    return out;
  }

  async guarantor(r) {
    const id = this.pat(r.patnum);
    const g = this.pat(r.guarantor);
    if (!id || !g || id === g) return 'skipped';
    await this.db.run('UPDATE patients SET guarantor_id = ? WHERE id = ? AND practice_id = ?', g, id, this.pid);
    return 'updated';
  }

  async plan(r) {
    const patient = this.pat(r.patnum);
    if (!patient) return 'skipped';
    const sub = this.subs.get(num(r.inssubnum));
    if (!sub) return 'skipped';
    const plan = this.plans.get(num(sub.plannum));
    const carrier = plan && this.carriers.get(num(plan.carriernum));
    if (!carrier || !text(sub.subscriberid)) return 'skipped';
    const subscriber = this.pat(sub.subscriber) && await this.db.get('SELECT first_name, last_name, dob FROM patients WHERE id = ?', this.pat(sub.subscriber));
    // Open Dental relationship: 0 self, 1 spouse, 2 child, others → other.
    return this.insurance({
      patient: num(r.patnum), carrier: text(carrier.carriername), payer_id: text(carrier.electid), group_number: text(plan.groupnum), plan_name: text(plan.groupname),
      subscriber_id: text(sub.subscriberid), subscriber_name: subscriber ? `${subscriber.first_name} ${subscriber.last_name}` : '', subscriber_dob: subscriber?.dob || '',
      relationship: String(r.relationship ?? 0), priority: Number(r.ordinal) >= 2 ? 'secondary' : 'primary',
    });
  }

  async appointment(r) {
    return this.appointments({
      external_id: num(r.aptnum), patient: num(r.patnum), datetime: text(r.aptdatetime), time: text(r.aptdatetime), duration: text(r.pattern),
      provider: Number(r.ishygiene) && Number(r.provhyg) ? num(r.provhyg) : num(r.provnum), operatory: num(r.op), status: String(r.aptstatus ?? ''),
      reason: text(r.procdescript), notes: text(r.note),
    });
  }

  // 1 TP, 2 C, 3 EC, 4 EO, 8 TPi come across; referred out, deleted and conditions don't.
  async procedure(r) {
    const status = { 1: 'planned', 8: 'planned', 2: 'completed', 3: 'completed', 4: 'completed' }[Number(r.procstatus)];
    const patient = this.pat(r.patnum);
    const code = this.codes.get(num(r.codenum));
    if (!status || !patient || !code) return 'skipped';
    if (await this.externalId('procedures', num(r.procnum))) return 'skipped';
    const pc = await this.codeFor(text(code.proccode).toUpperCase(), text(code.descript), cents(r.procfee));
    const date = dateOf(r.procdate);
    let planId = null;
    if (status === 'planned') {
      const key = `${num(r.patnum)}|plan`;
      planId = (await this.externalId('plans', key))?.local_id;
      if (!planId) {
        planId = await insert(this.db, 'treatment_plans', { practice_id: this.pid, patient_id: patient, name: 'Treatment from Open Dental', status: 'proposed' });
        await this.remember('plans', key, planId, true);
      }
    }
    const apt = Number(r.aptnum) ? (await this.externalId('appointments', num(r.aptnum)))?.local_id ?? null : null;
    const id = await insert(this.db, 'procedures', {
      practice_id: this.pid, patient_id: patient, treatment_plan_id: planId, appointment_id: status === 'planned' ? apt : null,
      provider_id: this.provider(r.provnum) ?? this.defaultProvider({ primary_provider_id: null }), code_id: pc.id, code: pc.code, description: pc.description,
      category: pc.category, tooth: text(r.toothnum).toUpperCase() || null, surfaces: text(r.surf).toUpperCase().replace(/[^MODBFLIV5]/g, '') || null,
      fee: cents(r.procfee), status, completed_at: status === 'completed' ? (date || this.today) : null,
    });
    await this.remember('procedures', num(r.procnum), id, true);
    return 'created';
  }

  async recall(r) {
    if (Number(r.isdisabled) || !dateOf(r.datedue) || !this.pat(r.patnum)) return 'skipped';
    const type = this.recallTypes.get(num(r.recalltypenum));
    return this.recalls({ patient: num(r.patnum), type: text(type?.description) || 'Prophy', interval: String(r.recallinterval ?? ''), due_date: String(r.datedue).slice(0, 10) });
  }

  async ledger(key, row) {
    if (await this.externalId('ledger', key)) return 'skipped';
    const id = await insert(this.db, 'ledger_entries', { practice_id: this.pid, created_by: this.batch.created_by, ...row });
    await this.remember('ledger', key, id, true);
    return 'created';
  }

  // Only work done here (C) was charged; work done elsewhere (EC, EO) is history without a charge.
  async charge(r) {
    if (Number(r.procstatus) !== 2 || !Number(r.procfee)) return 'skipped';
    const patient = this.pat(r.patnum);
    const proc = (await this.externalId('procedures', num(r.procnum)))?.local_id;
    const code = this.codes.get(num(r.codenum));
    if (!patient) return 'skipped';
    return this.ledger(`charge|${num(r.procnum)}`, {
      patient_id: patient, type: 'charge', amount: cents(r.procfee) * (Number(r.unitqty) > 1 ? Number(r.unitqty) : 1), entry_date: dateOf(r.procdate) || this.today,
      description: `${text(code?.proccode)} ${text(code?.descript)}`.trim() || 'Procedure', procedure_id: proc ?? null, provider_id: this.provider(r.provnum),
    });
  }

  async split(r) {
    const patient = this.pat(r.patnum);
    if (!patient || !Number(r.splitamt)) return 'skipped';
    const [payment] = await this.staged('payment', ' AND ref = ?', num(r.paynum));
    const type = this.defs.get(num(payment?.paytype));
    const amount = cents(r.splitamt);
    return this.ledger(`split|${num(r.splitnum)}`, {
      patient_id: patient, type: amount > 0 ? 'payment' : 'refund', amount: -amount, entry_date: dateOf(r.datepay) || dateOf(payment?.paydate) || this.today,
      method: methodFrom(type), reference: text(payment?.checknum) || null, provider_id: this.provider(r.provnum),
      description: amount > 0 ? `Payment${type ? ` — ${type}` : ''}` : 'Refund',
    });
  }

  async adjustment(r) {
    const patient = this.pat(r.patnum);
    if (!patient || !Number(r.adjamt)) return 'skipped';
    const type = this.defs.get(num(r.adjtype)) || 'Adjustment';
    return this.ledger(`adj|${num(r.adjnum)}`, {
      patient_id: patient, type: 'adjustment', amount: cents(r.adjamt), entry_date: dateOf(r.adjdate) || this.today, adjustment_type: type,
      description: [type, text(r.adjnote)].filter(Boolean).join(' — ').slice(0, 200), provider_id: this.provider(r.provnum),
    });
  }

  // Received and supplemental insurance payments, and their contractual write-offs.
  async claimPayment(r) {
    if (![1, 4].includes(Number(r.status))) return 'skipped';
    const patient = this.pat(r.patnum);
    if (!patient) return 'skipped';
    let out = 'skipped';
    const date = dateOf(r.datecp) || this.today;
    if (Number(r.inspayamt)) {
      out = await this.ledger(`ins|${num(r.claimprocnum)}`, {
        patient_id: patient, type: 'insurance_payment', amount: -cents(r.inspayamt), entry_date: date, method: 'check', description: 'Insurance payment (from Open Dental)', provider_id: this.provider(r.provnum),
      });
    }
    if (Number(r.writeoff)) {
      await this.ledger(`wo|${num(r.claimprocnum)}`, {
        patient_id: patient, type: 'adjustment', amount: -cents(r.writeoff), entry_date: date, adjustment_type: 'Insurance write-off', description: 'Insurance write-off (from Open Dental)', provider_id: this.provider(r.provnum),
      });
      out = 'created';
    }
    return out;
  }

  // Each family ends at exactly Open Dental's balance (kept on the guarantor): the difference, if any, is one adjustment.
  async familyBalance(r) {
    if (num(r.guarantor) !== num(r.patnum) && Number(r.guarantor)) return 'skipped';
    const head = this.pat(r.patnum);
    if (!head || r.baltotal == null) return 'skipped';
    const members = (await this.db.all('SELECT id FROM patients WHERE practice_id = ? AND (id = ? OR guarantor_id = ?)', this.pid, head, head)).map((m) => m.id);
    const ours = (await this.db.get(`SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND voided_at IS NULL AND patient_id IN (${members.map(() => '?').join(',')})`, this.pid, ...members)).n;
    const diff = cents(r.baltotal) - Number(ours);
    if (!diff) return 'skipped';
    return this.ledger(`bal|${num(r.patnum)}`, {
      patient_id: head, type: 'adjustment', amount: diff, entry_date: this.today, adjustment_type: 'Balance forward', description: 'Conversion balance (to match Open Dental)',
    });
  }

  // The latest version of each procedure's note (Open Dental keeps every edit), as a signed note.
  async procNote(r) {
    const patient = this.pat(r.patnum);
    if (!patient || !text(r.note)) return 'skipped';
    const all = await this.staged('procnote', ' AND ref = ?', num(r.procnum));
    if (num(all.at(-1)?.procnotenum) !== num(r.procnotenum)) return 'skipped';
    const [proc] = await this.staged('procedurelog', ' AND ref = ?', num(r.procnum));
    const code = proc && this.codes.get(num(proc.codenum));
    const when = text(r.entrydatetime).slice(0, 19) || null;
    if (await this.externalId('notes', num(r.procnotenum))) return 'skipped';
    const id = await insert(this.db, 'clinical_notes', {
      practice_id: this.pid, patient_id: patient, author_id: this.batch.created_by, provider_id: this.provider(proc?.provnum),
      body: `${code ? `${text(code.proccode)} ${text(code.descript)}${text(proc.toothnum) ? ` #${text(proc.toothnum)}` : ''}\n` : ''}${text(r.note)}\n\n(From Open Dental)`,
      signed: 1, signed_at: when, ...(when ? { created_at: when } : {}),
    });
    await this.remember('notes', num(r.procnotenum), id, true);
    return 'created';
  }

  async commlog(r) {
    const patient = this.pat(r.patnum);
    if (!patient || !text(r.note) || await this.externalId('commlogs', num(r.commlognum))) return 'skipped';
    const when = text(r.commdatetime).slice(0, 19);
    const id = await insert(this.db, 'followups', {
      practice_id: this.pid, patient_id: patient, kind: 'history', outcome: 'note', note: text(r.note).slice(0, 4000), created_by: this.batch.created_by, ...(when && !when.startsWith('0001') ? { created_at: when } : {}),
    });
    await this.remember('commlogs', num(r.commlognum), id, true);
    return 'created';
  }

  // Readings in our site order DB, B, MB, DL, L, ML. Sequence types: 0 mobility, 2 gingival margin,
  // 4 probing, 5 skipped (missing) tooth, 6 bleeding (a flag in each site).
  async perioExam(r) {
    const patient = this.pat(r.patnum);
    const date = dateOf(r.examdate);
    if (!patient || !date || await this.externalId('perio', num(r.perioexamnum))) return 'skipped';
    const readings = {};
    const site = (m) => ['dbvalue', 'bvalue', 'mbvalue', 'dlvalue', 'lvalue', 'mlvalue'].map((k) => (m[k] == null || Number(m[k]) < 0 ? null : Number(m[k])));
    for (const m of await this.staged('periomeasure', ' AND ref = ?', num(r.perioexamnum))) {
      const t = String(m.inttooth);
      const tooth = (readings[t] ||= {});
      const seq = Number(m.sequencetype);
      if (seq === 4) tooth.pd = site(m);
      else if (seq === 2) tooth.gm = site(m);
      else if (seq === 6) tooth.bop = site(m).map((v) => !!(v && (v & 1)));
      else if (seq === 0 && Number(m.toothvalue) >= 0) tooth.mob = Number(m.toothvalue);
      else if (seq === 5 && Number(m.toothvalue) === 1) tooth.missing = true;
    }
    if (!Object.keys(readings).length) return 'skipped';
    const id = await insert(this.db, 'perio_exams', { practice_id: this.pid, patient_id: patient, provider_id: this.provider(r.provnum), exam_date: date, readings: JSON.stringify(readings) });
    await this.remember('perio', num(r.perioexamnum), id, true);
    return 'created';
  }
}

const HANDLER = {
  providers: 'provider_', operatories: 'operatory_', patients: 'patient', guarantors: 'guarantor', insurance: 'plan', appointments: 'appointment',
  procedures: 'procedure', recalls: 'recall', charges: 'charge', payments: 'split', adjustments: 'adjustment', insurance_payments: 'claimPayment',
  balances: 'familyBalance', notes: 'procNote', commlogs: 'commlog', perio: 'perioExam',
};

// Runs the conversion for about `budgetMs`, then reports where it got to. Call again until done.
export async function runConversion(db, batch, { budgetMs = 15_000, page = 250 } = {}) {
  const state = JSON.parse(batch.pending || '{}');
  state.step ||= STEPS[0];
  state.after ||= 0;
  state.counts ||= {};
  const conv = new Converter(db, batch.practice_id, batch);
  await conv.load();
  const errors = JSON.parse(batch.errors || '[]');
  const started = Date.now();
  while (state.step !== 'done' && Date.now() - started < budgetMs) {
    if (state.step === 'cleanup') {
      await db.run('DELETE FROM conversion_rows WHERE batch_id = ?', batch.id);
      state.step = 'done';
      break;
    }
    const rows = await db.all('SELECT id, data FROM conversion_rows WHERE batch_id = ? AND tbl = ? AND id > ? ORDER BY id LIMIT ?', batch.id, STEP_TABLE[state.step], state.after, page);
    if (!rows.length) {
      state.step = STEPS[STEPS.indexOf(state.step) + 1];
      state.after = 0;
      if (state.step === 'insurance' || state.step === 'appointments') await conv.load();
      continue;
    }
    const c = (state.counts[state.step] ||= { created: 0, updated: 0, skipped: 0, errors: 0 });
    for (const row of rows) {
      try {
        const out = await db.savepoint(() => conv[HANDLER[state.step]](JSON.parse(row.data)));
        c[out] = (c[out] || 0) + 1;
      } catch (err) {
        if (err.status >= 500) throw err;
        c.errors++;
        if (errors.length < 500) errors.push({ step: state.step, error: err.message });
      }
      state.after = row.id;
    }
  }
  const totals = Object.values(state.counts).reduce((t, x) => ({ created: t.created + (x.created || 0), updated: t.updated + (x.updated || 0), skipped: t.skipped + (x.skipped || 0), errors: t.errors + (x.errors || 0) }), { created: 0, updated: 0, skipped: 0, errors: 0 });
  await db.run(
    `UPDATE import_batches SET pending = ?, errors = ?, created_count = ?, updated_count = ?, skipped_count = ?, error_count = ?, status = ?, finished_at = ${state.step === 'done' ? "datetime('now')" : 'finished_at'} WHERE id = ?`,
    JSON.stringify(state), JSON.stringify(errors), totals.created, totals.updated, totals.skipped, totals.errors, state.step === 'done' ? 'done' : 'running', batch.id,
  );
  return { step: state.step, label: stepLabel(state.step), done: state.step === 'done', counts: state.counts, errors: errors.slice(-20), progress: Math.round((100 * Math.max(0, STEPS.indexOf(state.step))) / (STEPS.length - 1)) };
}

export async function stageRows(db, batch, table, rows) {
  const tbl = String(table).toLowerCase();
  if (!OD_TABLES.includes(tbl)) throw Object.assign(new Error(`${table} isn't a table we convert`), { status: 400 });
  // Many rows per statement: backups run to millions of rows.
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200).map((r) => {
      const data = Object.fromEntries(Object.entries(r || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
      return [batch.id, tbl, REF[tbl] ? num(data[REF[tbl]]) : null, JSON.stringify(data)];
    });
    await db.run(`INSERT INTO conversion_rows (batch_id, tbl, ref, data) VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}`, ...part.flat());
  }
  await db.run('UPDATE import_batches SET total_rows = total_rows + ? WHERE id = ?', rows.length, batch.id);
}
