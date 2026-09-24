import { lookup, text } from './common.js';

// Eaglesoft (Patterson Dental). Patterson's Data Export utility (or a Patterson-run export when an office
// leaves) writes one CSV per Eaglesoft table with the database's own column names: patient, responsible_party,
// appointment, transactions, planned_services, service_history, services, insurance_company, employer…
// Patients are keyed on patient_id; a family is everyone with the same responsible_party.
export default {
  id: 'eaglesoft',
  name: 'Eaglesoft',
  accept: '.zip',
  howTo: [
    'In Eaglesoft, open File → Export (the Patterson Data Export utility; on some versions it\'s under Utilities → Data Export). An administrator login is needed.',
    'Choose CSV and select: Patient, Responsible Party, Provider, Chair, Appointment, Service History, Planned Services, Services, Transactions, Insurance Company, Employer, Patient Insurance, Recall, Clinical Notes and Perio.',
    'If you don\'t see the utility, Patterson support can run the export for you — ask for "a full data export in CSV".',
    'Zip the export folder (right-click → Send to → Compressed (zipped) folder) and drop the .zip here.',
  ],

  files: [
    ['perio', /perio/],
    ['codes', /^(services?|servicecodes?|proccodes?|adacodes?)$/],
    ['procedures', /^(plannedservices?|servicehistory|completedservices?|treatmentplans?|txplans?|services?history)/],
    ['ledger', /^(transactions?|ledger|transactionhistory)/],
    ['balances', /^(responsibleparty|responsibleparties|aging|accounts?|balances?)/],
    ['carriers', /^(insurancecompany|insurancecompanies|inscompany|carriers?)/],
    ['plans', /^(employers?|insuranceplans?|plans?)$/],
    ['insurance', /(patientinsurance|insured|coverage|policies|policy|patientplans?)/],
    ['appointments', /^(appointments?|appt|schedule)/],
    ['recalls', /recall/],
    ['notes', /(clinicalnotes?|progressnotes?|notes?)/],
    ['providers', /^(providers?|prov)/],
    ['operatories', /^(chairs?|operator|locations?)/],
    ['patients', /^(patients?|pat)$/],
  ],

  fields: {
    providers: { id: ['providerid'], suffix: ['title', 'suffix'], type: ['position', 'providertype'], active: ['active'] },
    operatories: { id: ['chairnum', 'chairid', 'locationid'], name: ['description', 'chairname'] },
    patients: {
      id: ['patientid'], dob: ['birthdate'], gender: ['sex'], guarantor: ['responsibleparty', 'responsiblepartyid', 'resppartyid'],
      provider: ['preferreddentist', 'primproviderid', 'providerid'], hygienist: ['preferredhygienist'], phone: ['cellphone'], phone_home: ['homephone'],
      phone_work: ['workphone'], email: ['emailaddress'], address: ['address1'], address2: ['address2'], zip: ['zipcode'], medical_alerts: ['medicalalert', 'medalert'],
      // Eaglesoft keeps balances on the responsible party (see responsible_party.csv), not the patient.
      family_balance: ['currentbal'],
    },
    carriers: { id: ['insurancecompanyid'], name: ['name', 'companyname'], payer_id: ['payerid', 'payorid'] },
    plans: { id: ['employerid'], plan_name: ['name', 'employername'], group_number: ['groupnumber'], carrier_id: ['insurancecompanyid'], annual_max: ['maximumcoverage', 'annualmax'] },
    insurance: {
      patient: ['patientid'], carrier_id: ['insurancecompanyid'], plan_id: ['employerid'], carrier: ['insurancecompanyname'], plan_name: ['employername'],
      subscriber_id: ['memberid', 'subscriberid', 'policyholderidnumber'], subscriber: ['policyholderid', 'policyholder'], relationship: ['relationtopolicyholder', 'relationshiptopolicyholder'],
      priority: ['coverageorder', 'insorder', 'primarysecondary'],
    },
    appointments: {
      id: ['appointmentid'], patient: ['patientid'], datetime: ['starttime'], end: ['endtime'], provider: ['providerid'], operatory: ['locationid', 'chairnum', 'chairid'],
      status: ['appointmentstatus', 'status', 'arrivalstatus'], reason: ['description', 'classification'], notes: ['appointmentnotes', 'notes'],
    },
    codes: { code: ['servicecode'], ada_code: ['adacode'], description: ['description'] },
    procedures: {
      id: ['linenumber', 'servicehistoryid', 'plannedserviceid', 'trannum'], patient: ['patientid'], code: ['servicecode', 'adacode'], fee: ['fee', 'amount'],
      date: ['datecompleted', 'dateplanned', 'servicedate', 'trandate'], provider: ['providerid'], status: ['status'],
    },
    ledger: { id: ['trannum', 'transactionid'], patient: ['patientid'], date: ['trandate'], type: ['type', 'trantype'], amount: ['amount'] },
    balances: { patient: ['responsiblepartyid', 'responsibleparty', 'resppartyid'], balance: ['currentbal', 'currentbalance', 'totalbalance', 'balance'], bal_0_30: ['balance030'], bal_31_60: ['balance3160'], bal_61_90: ['balance6190'], bal_90: ['balanceover90'] },
    recalls: { patient: ['patientid'], type: ['recalltype', 'description'], interval: ['recallinterval', 'interval'], due_date: ['duedate', 'recalldate', 'nextrecalldate'] },
    notes: { id: ['clinicalnoteid', 'noteid'], patient: ['patientid'], date: ['dateentered', 'notedate'], note: ['notetext', 'description', 'note'], provider: ['providerid'] },
    perio: { exam_id: ['perioexamid', 'examid'], patient: ['patientid'], date: ['examdate'], type: ['measurementtype', 'type'] },
  },

  // Rows in these files are all one kind of work, whatever their own status column says (often none).
  fileDefaults: [
    [/^plannedservices?|^treatmentplans?|^txplans?/, { status: 'planned' }],
    [/^(servicehistory|completedservices?|serviceshistory)/, { status: 'completed' }],
  ],

  // Eaglesoft status: A active, I inactive, N non-patient, D deceased; words on newer exports.
  patientStatus: lookup([
    ['', 'active'], [/^(a|active|p|patient)$/, 'active'], [/^(i|inactive|n|non-?patient|nonpatient)$/, 'inactive'],
    [/^(d|deceased|archived|archive)$/, 'archived'], [/^(x|deleted|purged|duplicate)$/, 'skip'],
  ]),

  // Eaglesoft appointment and arrival statuses.
  appointmentStatus: lookup([
    ['', 'scheduled'], [/^(scheduled|unconfirmed|pending|left message|0)$/, 'scheduled'], [/^(confirmed|conf|1)$/, 'confirmed'],
    [/^(arrived|seated|in chair|checked out|dismissed|complete|completed|2|3|4)$/, 'completed'],
    [/^(broken|no ?show|failed|missed)$/, 'no_show'], [/^(cancell?ed)$/, 'cancelled'], [/^(deleted|unscheduled|list|wait list)$/, 'skip'],
  ]),

  procedureStatus: lookup([
    [/^(planned|proposed|accepted|p|tp|pending|recommended)$/, 'planned'],
    [/^(completed|complete|c|done|posted|existing|e|eo|ec)$/, 'completed'], [/^(rejected|declined|deleted|referred|condition)$/, 'skip'],
  ]),

  // transactions.type: S service, P payment, I insurance payment, A adjustment (carries its own sign),
  // C credit adjustment, D debit adjustment, R refund, F finance charge.
  transactionType: lookup([
    [/^(s|service|charge|d|debit adjustment|f|finance charge|late charge|r|refund)$/, 'charge'],
    [/^(p|payment|patient payment|i|ip|insurance payment|ins payment|c|credit adjustment|w|write ?off|writeoff)$/, 'credit'],
    [/^(a|adjustment)$/, 'signed'], [/^(n|note|claim|estimate)$/, 'ignore'],
  ]),

  relationship: lookup([
    ['', undefined], [/^(self|s|1|policy holder|subscriber)$/, 'self'], [/^(spouse|2|husband|wife)$/, 'spouse'],
    [/^(child|dependent|3|son|daughter)$/, 'child'], [/^(other|4|significant other|employee)$/, 'other'],
  ]),

  priority: lookup([['', 'primary'], [/^(1|p|primary|prim)$/, 'primary'], [/^(2|s|secondary|sec)$/, 'secondary'], [/^(3|tertiary|medical)$/, 'skip']]),

  providerType: lookup([[/hyg|rdh|^h$/, 'hygienist'], [/ortho|endo|perio|surgeon|pedo|specialist/, 'specialist'], [/.*/, 'dentist']]),

  // Older Eaglesoft service codes are ADA codes without the "D" ("01110" is D1110).
  code: (v) => {
    const s = text(v).toUpperCase();
    return /^0\d{4}$/.test(s) ? `D${s.slice(1)}` : s;
  },
};
