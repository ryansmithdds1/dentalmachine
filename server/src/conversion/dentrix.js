import { lookup } from './common.js';

// Dentrix (Henry Schein One). Dentrix doesn't hand out its database, but every list in the Office Manager can be
// exported, and Henry Schein One's Data Extract gives a folder of CSV / tab-separated files, one per table.
// Offices zip that folder and upload it. Patients are keyed on Chart # (what staff know them by); files that
// point at a patient by Dentrix's internal Patient ID still find them, because the patient file carries both.
export default {
  id: 'dentrix',
  name: 'Dentrix',
  accept: '.zip',
  howTo: [
    'In Dentrix, open the Office Manager.',
    'Run Reports → Data Extract (Dentrix G6 and later; on older versions use Letters & Lists → export each list to a text file). Choose CSV or tab-delimited.',
    'Export these lists: Patients (with Chart #, Guarantor, Prim Prov, Sec Prov and the balance), Providers, Operatories, Appointments, Procedures (Treatment Plan and Completed, with ADA Code, Tooth, Surface, Proc Date, Amount), Insurance (Coverage, Carrier, Group #, Subscriber ID), Continuing Care, Clinical Notes, Perio, and the Aging report or Ledger.',
    'Put the files in one folder, right-click it → Send to → Compressed (zipped) folder, and drop the .zip here.',
  ],

  // File names in a Data Extract folder (letters and digits only, lower case) → our tables. Tried in order.
  files: [
    ['perio', /perio/],
    ['codes', /^(procedurecodes?|proccodes?|adacodes?|codelist|feeschedule)/],
    ['procedures', /^(proc|procedure|treatment|txplan|tx|chart|completed|history)/],
    ['ledger', /(ledger|transaction|^trans|accounthistory)/],
    ['balances', /(aging|^balance|guarantorbal|familybal)/],
    ['carriers', /^(carriers?|insurancecarriers?|inscarriers?)$/],
    ['plans', /^(employers?|groupplans?|insplans?)$/],
    ['insurance', /(insur|coverage|subscriber|benefit)/],
    ['appointments', /^(app(oin)?t|schedule)/],
    ['recalls', /(recall|continuingcare|^cc)/],
    ['notes', /(note|progress)/],
    ['providers', /^(prov|providers?|staff)/],
    ['operatories', /^(op|operator|chair)/],
    ['patients', /^(pat|patient|family|demographic)/],
  ],

  // Dentrix's column names, tried before the generic spellings.
  fields: {
    providers: { id: ['providerid', 'provid', 'rscid'], suffix: ['title'], inactive: ['inactive', 'nonperson'] },
    operatories: { id: ['opid', 'operatoryid'], name: ['title', 'operatoryname'] },
    patients: {
      id: ['chart', 'chartnumber', 'chartno'], alt_id: ['patientid', 'patid'], provider: ['primprov', 'primaryprovider'], hygienist: ['secprov', 'secondaryprovider'],
      guarantor: ['guarantorchart', 'guarantor', 'guarantorid'], family_balance: ['guarbalance', 'familybalance', 'balance'], medical_alerts: ['medicalalert', 'medalert'],
    },
    insurance: {
      carrier: ['carriername', 'insurancecarrier'], payer_id: ['payorid', 'payerid'], group_number: ['groupnumber', 'group'], plan_name: ['groupplanname', 'employer'],
      subscriber_id: ['subscriberid', 'subscriberidnumber'], subscriber: ['subscriberchart', 'subscriber'], relationship: ['relationtosubscriber', 'reltosubscriber'], priority: ['coverage', 'coverageorder'],
    },
    appointments: { id: ['apptid'], date: ['apptdate'], time: ['appttime', 'starttime'], duration: ['apptlength', 'length'], operatory: ['op', 'operatory'], reason: ['apptreason', 'reason'] },
    procedures: { code: ['adacode', 'proccode'], date: ['procdate'], fee: ['amount', 'fee'], surfaces: ['surface', 'surf'], status: ['status', 'proceduretype'] },
    ledger: { date: ['date', 'procdate'], type: ['type', 'transactiontype'] },
    balances: { patient: ['guarantorchart', 'guarantor', 'chart'], balance: ['totalbalance', 'balance', 'total'] },
    recalls: { type: ['continuingcaretype', 'recalltype', 'cctype'], interval: ['interval', 'recallinterval'], due_date: ['duedate', 'recalldue'] },
    notes: { note: ['clinicalnote', 'notetext', 'note'], date: ['notedate', 'date'] },
  },

  // Dentrix patient statuses (Family File → Status).
  patientStatus: lookup([
    ['', 'active'], [/^(patient|active|new patient|established)$/, 'active'], [/^(non-?patient|nonpatient|inactive|moved|dismissed)$/, 'inactive'],
    [/^(archived|deceased|expired)$/, 'archived'], [/^(duplicate|deleted|purged)$/, 'skip'],
  ]),

  // Dentrix's default appointment statuses (Appointment Book → Setup → Appointment Status); offices add their own,
  // and anything not listed comes up for mapping in the dry run.
  appointmentStatus: lookup([
    ['', 'scheduled'], [/^(none|<none>|unconfirmed|scheduled|left message|lm|msg left|no answer|firm)$/, 'scheduled'],
    [/^(confirmed|conf|confirmed by text|confirmed by email)$/, 'confirmed'],
    [/^(here|arrived|ready|in chair|seated|walk ?out|checked out|complete|completed|posted)$/, 'completed'],
    [/^(broken|failed|no ?show|missed)$/, 'no_show'], [/^(cancell?ed|canc)$/, 'cancelled'],
    [/^(deleted|unscheduled|pinboard|asap list|wait list|waitlist)$/, 'skip'],
  ]),

  // Chart status letters: TP treatment planned, C completed, EC existing (current office), EO existing (other office).
  // Conditions and referred-out work aren't procedures.
  procedureStatus: lookup([
    [/^(tp|tx|tx plan|treatment plan(ned)?|planned|proposed|accepted)$/, 'planned'],
    [/^(c|comp|complete|completed|posted|done)$/, 'completed'], [/^(ec|eo|e|existing|existing current|existing other)$/, 'completed'],
    [/^(cond|condition|r|ro|referred|referred out|deleted|d)$/, 'skip'],
  ]),

  // Ledger transaction types → which way they move the balance. Only used to add up a family's balance when the
  // export has no aging/balance file; nothing is posted per transaction.
  transactionType: lookup([
    [/^(procedure|proc|charge|production|finance charge|late charge|charge adjustment|debit adjustment|\+ ?adjustment|refund)$/, 'charge'],
    [/^(payment|pmt|patient payment|cash payment|check payment|credit card payment|insurance payment|ins payment|ins pmt|dental insurance payment|credit adjustment|- ?adjustment|write ?off|discount)$/, 'credit'],
    [/^(claim|insurance claim|pre-?determination|estimate|note|appointment)$/, 'ignore'],
  ]),

  relationship: lookup([
    ['', undefined], [/^(self|subscriber|s|0|18)$/, 'self'], [/^(spouse|wife|husband|partner|1|01)$/, 'spouse'],
    [/^(child|dependent|son|daughter|2|19)$/, 'child'], [/^(other|3|g8)$/, 'other'],
  ]),

  // "Coverage" on Dentrix insurance exports reads "Primary Dental", "Secondary Dental", "Primary Medical"…
  priority: lookup([
    ['', 'primary'], [/^(1|primary|primary dental|pri|dental primary)$/, 'primary'], [/^(2|secondary|secondary dental|sec|dental secondary)$/, 'secondary'],
    [/medical|tertiary|^3$/, 'skip'],
  ]),

  providerType: lookup([[/hyg|rdh/, 'hygienist'], [/ortho|endo|perio|oral surg|pedo|prosth|specialist/, 'specialist'], [/.*/, 'dentist']]),
};
