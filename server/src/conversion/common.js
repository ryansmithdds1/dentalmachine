// Shared pieces of the Dentrix, Eaglesoft and Curve conversions.
//
// Each system's export is a folder of files (CSV, tab-separated or JSON), one per kind of record, with that
// system's own column names. Every file is read into one of the standard tables below — the intermediate shape
// the conversion works from — by matching its column headers against the spellings each vendor module lists.
// The vendor modules add their own spellings and value mappings (statuses, transaction types, relationships);
// everything after that (pipeline.js) is the same for every system.

export const norm = (h) => String(h ?? '').replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const text = (v) => (v == null ? '' : String(v).trim());
export const blank = (v) => v == null || String(v).trim() === '';

// Standard tables: what each is for, the columns it can carry (generic header spellings; vendors add theirs
// in front), and what a file must have to be read as that table.
export const TABLES = {
  providers: {
    label: 'Providers',
    need: ['id'],
    fields: {
      id: ['providerid', 'provid', 'providercode', 'id', 'code', 'abbr', 'abbreviation'],
      name: ['providername', 'fullname', 'name'],
      first_name: ['firstname', 'first', 'fname'],
      last_name: ['lastname', 'last', 'lname'],
      suffix: ['suffix', 'title', 'credentials', 'degree'],
      npi: ['npi', 'npinumber', 'nationalproviderid', 'nationalprovid', 'typetwonpi'],
      type: ['providertype', 'type', 'specialty', 'position', 'role'],
      active: ['active', 'isactive', 'status'],
      inactive: ['inactive', 'isinactive', 'hidden', 'ishidden'],
    },
  },
  operatories: {
    label: 'Chairs (operatories)',
    need: ['name'],
    fields: {
      id: ['operatoryid', 'opid', 'opnum', 'chairid', 'chairnum', 'id'],
      name: ['operatoryname', 'opname', 'chairname', 'title', 'description', 'name'],
      active: ['active', 'isactive'],
      inactive: ['inactive', 'hidden', 'ishidden'],
    },
  },
  patients: {
    label: 'Patients',
    need: ['id', 'first_name', 'last_name'],
    fields: {
      id: ['chart', 'chartnumber', 'chartno', 'patientchart', 'patientid', 'patid', 'id'],
      alt_id: ['patientid', 'patid', 'patientnumber', 'accountnumber', 'id'],
      first_name: ['firstname', 'first', 'fname', 'patientfirstname', 'givenname'],
      last_name: ['lastname', 'last', 'lname', 'patientlastname', 'surname', 'familyname'],
      preferred_name: ['preferredname', 'preferred', 'nickname', 'goesby'],
      dob: ['birthdate', 'birthday', 'dob', 'dateofbirth', 'bdate'],
      gender: ['gender', 'sex'],
      status: ['status', 'patientstatus', 'patstatus'],
      guarantor: ['guarantor', 'guarantorid', 'guarantorchart', 'guarantorchartnumber', 'responsibleparty', 'responsiblepartyid', 'guar'],
      provider: ['primprov', 'primaryprovider', 'primaryproviderid', 'provider', 'providerid', 'prov1', 'dentist'],
      hygienist: ['secprov', 'secondaryprovider', 'hygienist', 'hygienistid', 'prov2'],
      phone: ['cellphone', 'mobilephone', 'cell', 'mobile', 'wirelessphone'],
      phone_home: ['homephone', 'phone', 'home', 'hmphone'],
      phone_work: ['workphone', 'work', 'businessphone', 'wkphone'],
      email: ['email', 'emailaddress'],
      address: ['address1', 'address', 'street', 'streetaddress', 'addressline1'],
      address2: ['address2', 'addressline2', 'apt', 'suite'],
      city: ['city', 'town'],
      state: ['state', 'st', 'province'],
      zip: ['zip', 'zipcode', 'postalcode', 'postcode'],
      medical_alerts: ['medicalalert', 'medicalalerts', 'medalert', 'alert', 'alerts'],
      // What this patient owes on their own, and what the whole family owes (only read from the guarantor's row).
      balance: ['patientbalance', 'patbalance'],
      family_balance: ['familybalance', 'guarbalance', 'guarantorbalance', 'accountbalance', 'totalbalance', 'balance'],
    },
  },
  carriers: {
    label: 'Insurance carriers',
    need: ['id', 'name'],
    fields: {
      id: ['carrierid', 'insurancecompanyid', 'insurancecarrierid', 'id'],
      name: ['carriername', 'companyname', 'insurancecompanyname', 'name'],
      payer_id: ['payerid', 'payorid', 'electronicid', 'electid', 'ediid'],
    },
  },
  plans: {
    label: 'Insurance plans',
    need: ['id'],
    fields: {
      id: ['planid', 'employerid', 'insplanid', 'groupplanid', 'id'],
      plan_name: ['planname', 'groupname', 'employername', 'employer', 'name'],
      group_number: ['groupnumber', 'groupnum', 'groupno', 'group'],
      carrier_id: ['carrierid', 'insurancecompanyid'],
      annual_max: ['annualmax', 'annualmaximum', 'yearlymax'],
      deductible: ['deductible', 'individualdeductible'],
    },
  },
  insurance: {
    label: 'Insurance policies',
    need: ['patient'],
    fields: {
      patient: ['chart', 'chartnumber', 'patientchart', 'patientid', 'patid', 'patient'],
      carrier: ['carriername', 'carrier', 'insurancecarrier', 'insurancecompany', 'insurancecompanyname', 'insname', 'payername'],
      carrier_id: ['carrierid', 'insurancecompanyid'],
      plan_id: ['planid', 'employerid', 'insplanid'],
      payer_id: ['payerid', 'payorid', 'electronicid', 'electid'],
      group_number: ['groupnumber', 'groupnum', 'group', 'groupno'],
      plan_name: ['groupplanname', 'groupname', 'planname', 'employername', 'employer', 'plan'],
      subscriber_id: ['subscriberid', 'subscriberidnumber', 'memberid', 'insuredid', 'subid', 'policynumber'],
      subscriber: ['subscriberchart', 'subscriberchartnumber', 'subscriberpatientid', 'policyholderid', 'policyholder', 'subscriber'],
      subscriber_name: ['subscribername', 'insuredname', 'policyholdername'],
      subscriber_dob: ['subscriberbirthdate', 'subscriberdob', 'insureddob'],
      relationship: ['relationtosubscriber', 'reltosubscriber', 'relationshiptosubscriber', 'relationship', 'relation'],
      priority: ['coverageorder', 'coverage', 'priority', 'rank', 'order', 'insurancetype', 'ordinal'],
      annual_max: ['annualmax', 'annualmaximum', 'yearlymax', 'maxbenefit'],
      deductible: ['deductible', 'individualdeductible'],
    },
  },
  appointments: {
    label: 'Appointments',
    need: ['patient'],
    fields: {
      id: ['apptid', 'appointmentid', 'appointmentnumber', 'aptnum', 'id'],
      patient: ['chart', 'chartnumber', 'patientchart', 'patientid', 'patid', 'patient'],
      datetime: ['apptdatetime', 'appointmentdatetime', 'datetime', 'startdatetime', 'start'],
      date: ['apptdate', 'appointmentdate', 'date'],
      time: ['appttime', 'appointmenttime', 'starttime', 'time'],
      end: ['enddatetime', 'endtime', 'end'],
      duration: ['length', 'apptlength', 'duration', 'durationminutes', 'minutes', 'lengthminutes'],
      provider: ['provider', 'providerid', 'provid', 'prov', 'dentist'],
      operatory: ['operatory', 'operatoryid', 'op', 'opid', 'chair', 'chairid', 'room'],
      status: ['status', 'apptstatus', 'appointmentstatus'],
      broken: ['broken', 'isbroken'],
      reason: ['reason', 'apptreason', 'procedures', 'description', 'title'],
      notes: ['note', 'notes', 'apptnote', 'appointmentnote'],
    },
  },
  codes: {
    label: 'Procedure codes',
    need: ['code'],
    fields: {
      code: ['servicecode', 'proccode', 'procedurecode', 'code'],
      ada_code: ['adacode', 'cdtcode', 'ada', 'cdt'],
      description: ['description', 'descript', 'desc', 'name'],
    },
  },
  procedures: {
    label: 'Completed and planned treatment',
    need: ['patient', 'code'],
    fields: {
      id: ['procid', 'procedureid', 'procnum', 'id'],
      patient: ['chart', 'chartnumber', 'patientchart', 'patientid', 'patid', 'patient'],
      code: ['adacode', 'ada', 'cdtcode', 'proccode', 'procedurecode', 'servicecode', 'code'],
      description: ['description', 'procdescription', 'desc'],
      tooth: ['tooth', 'toothnumber', 'toothnum', 'th'],
      surfaces: ['surface', 'surfaces', 'surf'],
      fee: ['amount', 'fee', 'procfee', 'charge'],
      date: ['procdate', 'proceduredate', 'servicedate', 'dateofservice', 'dos', 'date'],
      status: ['status', 'procstatus', 'proceduretype'],
      provider: ['provider', 'providerid', 'provid', 'prov'],
      appointment: ['apptid', 'appointmentid'],
    },
  },
  ledger: {
    label: 'Ledger transactions',
    need: ['patient', 'amount', 'type'],
    fields: {
      id: ['transactionid', 'transid', 'trannum', 'ledgerid', 'id'],
      patient: ['chart', 'chartnumber', 'patientchart', 'patientid', 'patid', 'patient'],
      date: ['transactiondate', 'transdate', 'trandate', 'postdate', 'date'],
      type: ['transactiontype', 'transtype', 'trantype', 'type', 'category'],
      amount: ['amount', 'amt'],
      description: ['description', 'desc', 'note'],
    },
  },
  balances: {
    label: 'Account balances',
    need: ['patient'],
    fields: {
      patient: ['guarantor', 'guarantorchart', 'guarantorid', 'responsibleparty', 'responsiblepartyid', 'accountid', 'chart', 'chartnumber', 'patientid'],
      balance: ['balance', 'totalbalance', 'accountbalance', 'familybalance', 'total', 'totalbal', 'guarbalance'],
      // Aging buckets: added up when there's no total.
      bal_0_30: ['0to30', '030', 'current', 'balance030', 'bal030'],
      bal_31_60: ['31to60', '3160', 'balance3160', 'bal3160'],
      bal_61_90: ['61to90', '6190', 'balance6190', 'bal6190'],
      bal_90: ['over90', '91', '90', '91plus', 'balanceover90', 'balover90'],
    },
  },
  recalls: {
    label: 'Recall',
    need: ['patient', 'due_date'],
    fields: {
      patient: ['chart', 'chartnumber', 'patientchart', 'patientid', 'patid', 'patient'],
      type: ['recalltype', 'continuingcaretype', 'cctype', 'type', 'description'],
      interval: ['recallinterval', 'interval', 'ccinterval', 'intervalmonths'],
      due_date: ['duedate', 'recalldue', 'recallduedate', 'nextdue', 'nextduedate', 'due'],
    },
  },
  notes: {
    label: 'Clinical notes',
    need: ['patient', 'note'],
    fields: {
      id: ['noteid', 'clinicalnoteid', 'id'],
      patient: ['chart', 'chartnumber', 'patientchart', 'patientid', 'patid', 'patient'],
      date: ['notedate', 'dateentered', 'entrydate', 'datetime', 'created', 'date'],
      note: ['clinicalnote', 'notetext', 'note', 'text', 'body', 'notes'],
      provider: ['provider', 'providerid', 'provid', 'prov', 'author'],
    },
  },
  perio: {
    label: 'Perio charts',
    need: ['patient', 'tooth'],
    fields: {
      exam_id: ['perioexamid', 'examid', 'exam', 'periochartid', 'chartid'],
      patient: ['chart', 'chartnumber', 'patientchart', 'patientid', 'patid', 'patient'],
      date: ['examdate', 'periodate', 'date'],
      provider: ['provider', 'providerid', 'provid', 'prov', 'examiner'],
      tooth: ['tooth', 'toothnumber', 'toothnum', 'th'],
      // One reading per row (a type and six sites)…
      type: ['measurement', 'measurementtype', 'measuretype', 'reading', 'type', 'category'],
      db: ['db', 'distobuccal', 'fdistal', 'facialdistal', 'bdistal'],
      b: ['b', 'buccal', 'fmid', 'facialmid', 'bmid', 'facial'],
      mb: ['mb', 'mesiobuccal', 'fmesial', 'facialmesial', 'bmesial'],
      dl: ['dl', 'distolingual', 'ldistal', 'lingualdistal'],
      l: ['l', 'lingual', 'lmid', 'lingualmid'],
      ml: ['ml', 'mesiolingual', 'lmesial', 'lingualmesial'],
      // …or one row per tooth, with six values in a cell.
      pd: ['pocketdepths', 'pocketdepth', 'probingdepths', 'pd'],
      gm: ['gingivalmargins', 'gingivalmargin', 'recession', 'gm'],
      bop: ['bleeding', 'bleedingonprobing', 'bop'],
      sup: ['suppuration', 'sup'],
      furc: ['furcation', 'furcations', 'furc'],
      mobility: ['mobility', 'mob'],
      missing: ['missing', 'ismissing'],
    },
  },
};

// Order used when guessing a file's table from its columns (most specific first).
const GUESS_ORDER = ['perio', 'procedures', 'ledger', 'insurance', 'appointments', 'notes', 'recalls', 'patients', 'balances', 'plans', 'carriers', 'codes', 'providers', 'operatories'];

// A table's columns, with the vendor's own spellings tried first.
export function fieldsFor(vendor, table) {
  const base = TABLES[table].fields;
  const extra = vendor.fields?.[table] || {};
  return Object.fromEntries(Object.keys({ ...base, ...extra }).map((f) => [f, [...(extra[f] || []), ...(base[f] || [])].map(norm)]));
}

// Which column feeds each field: { field: columnIndex }. Exact spellings, each column used once, fields in order.
export function mapHeaders(fields, headers) {
  const cols = headers.map(norm);
  const used = new Set();
  const out = {};
  for (const [field, aliases] of Object.entries(fields)) {
    for (const a of aliases) {
      const i = cols.findIndex((c, j) => c === a && !used.has(j));
      if (i >= 0) {
        out[field] = i;
        used.add(i);
        break;
      }
    }
  }
  return out;
}

const baseName = (name) => norm(String(name).split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, ''));

// Which standard table a file is: by its name first (the vendor's file names), then by its columns.
export function recognize(vendor, name, headers) {
  const base = baseName(name);
  const fits = (table) => {
    const m = mapHeaders(fieldsFor(vendor, table), headers);
    return TABLES[table].need.every((f) => m[f] != null) ? m : null;
  };
  for (const [table, re] of vendor.files || []) {
    if (re.test(base) && fits(table)) return table;
  }
  let best = null;
  for (const table of GUESS_ORDER) {
    const m = fits(table);
    if (!m) continue;
    const score = Object.keys(m).length;
    if (!best || score > best.score) best = { table, score };
  }
  return best && best.score >= 3 ? best.table : null;
}

// Defaults a file's name implies (Eaglesoft's planned_services.csv is all planned work, for example).
export function defaultsFor(vendor, name) {
  const base = baseName(name);
  return (vendor.fileDefaults || []).find(([re]) => re.test(base))?.[1] || {};
}

// A value-mapping table: [pattern, result] pairs, first match wins; undefined when nothing matches (unmapped).
export function lookup(pairs) {
  return (v) => {
    const s = text(v).toLowerCase().replace(/\s+/g, ' ');
    for (const [re, out] of pairs) if (typeof re === 'string' ? re === s : re.test(s)) return out;
    return undefined;
  };
}

export const truthy = (v) => /^(y|yes|true|t|1|x|-1|on)$/i.test(text(v));

// ---- Perio ----
// Readings are kept per tooth in our site order DB, B, MB, DL, L, ML: pd (probing depth), gm (gingival margin),
// bop / sup (flags), furc, mob (0-3) and missing. Returns { readings, problems }.
const PERIO_KIND = lookup([
  [/pocket|probing|depth|^pd$|^pk$/, 'pd'], [/gingival|margin|recession|^gm$|^rec|^gr$/, 'gm'], [/bleed|^bop$|^bl$/, 'bop'],
  [/supp|pus|^sup$|^su$/, 'sup'], [/furc/, 'furc'], [/mobil|^mob$|^mo$/, 'mob'], [/plaque|^pl$/, 'plaque'], [/missing/, 'missing'],
]);
const SITES = ['db', 'b', 'mb', 'dl', 'l', 'ml'];
const LIMITS = { pd: [0, 15], gm: [-10, 15], furc: [0, 3] };

export function perioKind(type) {
  return PERIO_KIND(type);
}

export function perioReadings(rows, { validTooth, kindOf = perioKind }) {
  const readings = {};
  const problems = [];
  const six = (vals, kind, tooth) => {
    const list = Array.isArray(vals) ? vals : String(vals).trim().split(/[\s,;/|]+/);
    if (list.length !== 6) {
      problems.push(`Tooth ${tooth}: ${kind} needs 6 readings`);
      return null;
    }
    if (['bop', 'sup', 'plaque'].includes(kind)) return list.map((x) => truthy(x) || /^b$/i.test(text(x)));
    const [lo, hi] = LIMITS[kind];
    return list.map((x) => {
      if (blank(x) || (Number(x) < 0 && kind !== 'gm')) return null;
      const n = Number(x);
      if (!Number.isInteger(n) || n < lo || n > hi) {
        problems.push(`Tooth ${tooth}: ${kind} reading "${x}" is out of range`);
        return null;
      }
      return n;
    });
  };
  for (const m of rows) {
    const tooth = text(m.tooth).toUpperCase().replace(/^#/, '');
    if (!tooth || !validTooth(tooth)) {
      problems.push(`"${text(m.tooth)}" isn't a tooth number`);
      continue;
    }
    const t = (readings[tooth] ||= {});
    const sites = SITES.map((s) => m[s]);
    if (!blank(m.type) || sites.some((x) => !blank(x))) {
      const kind = kindOf(m.type);
      if (!kind) problems.push(`Reading type "${text(m.type)}" isn't one we know`);
      else if (kind === 'mob') {
        const v = Number(sites.find((x) => !blank(x)) ?? m.mobility);
        if (Number.isInteger(v) && v >= 0 && v <= 3) t.mob = v;
      } else if (kind === 'missing') {
        if (sites.some(truthy) || truthy(m.missing) || sites.every(blank)) t.missing = true;
      } else {
        const v = six(sites.map((x) => (blank(x) ? '' : x)), kind, tooth);
        if (v) t[kind] = v;
      }
    }
    for (const k of ['pd', 'gm', 'bop', 'sup', 'furc']) {
      if (!blank(m[k])) {
        const v = six(m[k], k, tooth);
        if (v) t[k] = v;
      }
    }
    if (!blank(m.mobility)) {
      const v = Number(m.mobility);
      if (Number.isInteger(v) && v >= 0 && v <= 3) t.mob = v;
      else problems.push(`Tooth ${tooth}: mobility "${m.mobility}" isn't 0-3`);
    }
    if (truthy(m.missing)) t.missing = true;
    if (!Object.keys(t).length) delete readings[tooth];
  }
  return { readings, problems };
}
