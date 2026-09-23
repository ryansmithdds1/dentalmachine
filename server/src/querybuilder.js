import { HttpError } from './auth.js';

// Guided report builder. Staff choose a dataset, columns, filters, grouping and sort; the SQL is built here
// from these whitelisted pieces only and is always limited to the practice. Values are always bound
// parameters, never pasted into the SQL.
const c = (label, sql, type = 'text') => ({ label, sql, type });
export const DATASETS = {
  patients: {
    label: 'Patients', from: 'patients t LEFT JOIN providers pv ON pv.id = t.primary_provider_id',
    columns: {
      id: c('Patient #', 't.id', 'number'), first_name: c('First name', 't.first_name'), last_name: c('Last name', 't.last_name'), dob: c('Date of birth', 't.dob', 'date'),
      gender: c('Gender', 't.gender'), city: c('City', 't.city'), state: c('State', 't.state'), zip: c('ZIP', 't.zip'), status: c('Status', 't.status'),
      referral_source: c('Referral source', 't.referral_source'), language: c('Language', 't.language'), phone: c('Phone', 't.phone'), email: c('Email', 't.email'),
      provider: c('Primary provider', 'pv.name'), created: c('Added on', 'substr(t.created_at, 1, 10)', 'date'),
      sms_opt_in: c('Texts OK', 't.sms_opt_in', 'number'), email_opt_in: c('Email OK', 't.email_opt_in', 'number'),
    },
  },
  appointments: {
    label: 'Appointments', from: 'appointments t JOIN patients p ON p.id = t.patient_id JOIN providers pv ON pv.id = t.provider_id LEFT JOIN operatories o ON o.id = t.operatory_id LEFT JOIN appointment_types at ON at.id = t.appointment_type_id',
    columns: {
      date: c('Date', 'substr(t.start_time, 1, 10)', 'date'), time: c('Time', 'substr(t.start_time, 12, 5)'), status: c('Status', 't.status'), reason: c('Reason', 't.reason'),
      type: c('Visit type', 'at.name'), provider: c('Provider', 'pv.name'), chair: c('Chair', 'o.name'), patient: c('Patient', "p.first_name || ' ' || p.last_name"),
      patient_id: c('Patient #', 't.patient_id', 'number'), confirmed: c('Confirmed via', 't.confirmed_via'), booked_on: c('Booked on', 'substr(t.created_at, 1, 10)', 'date'),
    },
  },
  procedures: {
    label: 'Procedures', from: 'procedures t JOIN patients p ON p.id = t.patient_id LEFT JOIN providers pv ON pv.id = t.provider_id',
    columns: {
      code: c('Code', 't.code'), description: c('Description', 't.description'), category: c('Category', 't.category'), tooth: c('Tooth', 't.tooth'),
      status: c('Status', 't.status'), fee: c('Fee', 't.fee', 'money'), provider: c('Provider', 'pv.name'), patient: c('Patient', "p.first_name || ' ' || p.last_name"),
      patient_id: c('Patient #', 't.patient_id', 'number'), completed: c('Completed on', 'substr(t.completed_at, 1, 10)', 'date'), added: c('Added on', 'substr(t.created_at, 1, 10)', 'date'),
    },
  },
  ledger: {
    label: 'Ledger (charges, payments, adjustments)', from: 'ledger_entries t JOIN patients p ON p.id = t.patient_id LEFT JOIN providers pv ON pv.id = t.provider_id',
    columns: {
      date: c('Date', 't.entry_date', 'date'), type: c('Type', 't.type'), amount: c('Amount', 't.amount', 'money'), method: c('Method', 't.method'),
      adjustment_type: c('Adjustment type', 't.adjustment_type'), description: c('Description', 't.description'), provider: c('Provider', 'pv.name'),
      patient: c('Patient', "p.first_name || ' ' || p.last_name"), patient_id: c('Patient #', 't.patient_id', 'number'), voided: c('Voided', "CASE WHEN t.voided_at IS NULL THEN 'no' ELSE 'yes' END"),
    },
  },
  claims: {
    label: 'Insurance claims', from: 'claims t JOIN patients p ON p.id = t.patient_id JOIN patient_insurance pi ON pi.id = t.patient_insurance_id JOIN insurance_carriers ic ON ic.id = pi.carrier_id',
    columns: {
      claim: c('Claim #', 't.id', 'number'), status: c('Status', 't.status'), carrier: c('Carrier', 'ic.name'), billed: c('Billed', 't.total_fee', 'money'),
      expected: c('Expected', 't.estimated_amount', 'money'), paid: c('Paid', 't.paid_amount', 'money'), submitted: c('Submitted on', 'substr(t.submitted_at, 1, 10)', 'date'),
      created: c('Created on', 'substr(t.created_at, 1, 10)', 'date'), patient: c('Patient', "p.first_name || ' ' || p.last_name"), patient_id: c('Patient #', 't.patient_id', 'number'),
    },
  },
};
const OPS = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', contains: 'contains', empty: 'is empty', not_empty: 'is not empty' };
const AGG = { count: 'Count', sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest' };
export const QUERY_META = { datasets: Object.fromEntries(Object.entries(DATASETS).map(([k, d]) => [k, { label: d.label, columns: Object.fromEntries(Object.entries(d.columns).map(([ck, v]) => [ck, { label: v.label, type: v.type }])) }])), ops: OPS, aggregates: AGG };

// Turns a spec into { sql, args, headers }.
export function buildQuery(spec, practiceId) {
  const ds = DATASETS[spec?.dataset];
  if (!ds) throw new HttpError(400, 'Choose what to report on');
  const col = (k) => {
    const x = ds.columns[k];
    if (!x) throw new HttpError(400, `Unknown column ${k}`);
    return x;
  };
  const where = ['t.practice_id = ?'];
  const args = [practiceId];
  for (const f of (spec.filters || []).slice(0, 12)) {
    const x = col(f.column);
    if (!OPS[f.op]) throw new HttpError(400, `Unknown comparison ${f.op}`);
    if (f.op === 'empty') where.push(`(${x.sql} IS NULL OR ${x.sql} = '')`);
    else if (f.op === 'not_empty') where.push(`(${x.sql} IS NOT NULL AND ${x.sql} != '')`);
    else if (f.op === 'contains') { where.push(`lower(${x.sql}) LIKE ?`); args.push(`%${String(f.value ?? '').toLowerCase()}%`); }
    else {
      let v = f.value ?? '';
      if (x.type === 'money') v = Math.round(Number(v) * 100);
      else if (x.type === 'number') v = Number(v);
      if ((x.type === 'money' || x.type === 'number') && !Number.isFinite(v)) throw new HttpError(400, `${x.label} needs a number`);
      where.push(`${x.sql} ${OPS[f.op]} ?`);
      args.push(v);
    }
  }
  const group = spec.group_by ? col(spec.group_by) : null;
  const aggs = (spec.aggregates || []).slice(0, 5).map((a) => {
    if (!AGG[a.fn]) throw new HttpError(400, `Unknown total ${a.fn}`);
    if (a.fn === 'count') return { sql: 'COUNT(*)', label: 'Count', type: 'number' };
    const x = col(a.column);
    if (!['money', 'number'].includes(x.type)) throw new HttpError(400, `${AGG[a.fn]} needs a number column`);
    return { sql: `${a.fn.toUpperCase()}(${x.sql})`, label: `${AGG[a.fn]} ${x.label.toLowerCase()}`, type: a.fn === 'avg' && x.type === 'number' ? 'number' : x.type };
  });
  let select;
  let headers;
  if (group) {
    const list = aggs.length ? aggs : [{ sql: 'COUNT(*)', label: 'Count', type: 'number' }];
    select = [`${group.sql} AS c0`, ...list.map((a, i) => `${a.sql} AS c${i + 1}`)];
    headers = [{ label: group.label, type: group.type }, ...list.map((a) => ({ label: a.label, type: a.type }))];
  } else {
    const cols = (spec.columns?.length ? spec.columns : Object.keys(ds.columns).slice(0, 6)).slice(0, 20).map(col);
    select = cols.map((x, i) => `${x.sql} AS c${i}`);
    headers = cols.map((x) => ({ label: x.label, type: x.type }));
  }
  let order = '';
  if (spec.sort) {
    const dir = spec.sort.dir === 'desc' ? 'DESC' : 'ASC';
    if (group && /^agg\d$/.test(spec.sort.column)) order = ` ORDER BY c${Number(spec.sort.column.slice(3)) + 1} ${dir}`;
    else order = ` ORDER BY ${col(spec.sort.column).sql} ${dir}`;
  }
  const limit = Math.min(5000, Math.max(1, Number(spec.limit) || 1000));
  const sql = `SELECT ${select.join(', ')} FROM ${ds.from} WHERE ${where.join(' AND ')}${group ? ` GROUP BY ${group.sql}` : ''}${order} LIMIT ${limit + 1}`;
  return { sql, args, headers, limit };
}
