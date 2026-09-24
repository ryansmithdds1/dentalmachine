import { lookup } from './common.js';

// Curve Dental (Curve Hero). Curve is cloud-hosted; its data export is a .zip with one file per entity —
// JSON (camelCase fields, nested address and perio arrays) or CSV. Nested fields are flattened in the browser
// ("address.line1" reads as addressline1) and a perio chart's teeth become one row per tooth. Amounts are dollars.
// Times are taken as the office's local time.
export default {
  id: 'curve',
  name: 'Curve',
  accept: '.zip',
  howTo: [
    'In Curve Hero, go to Settings → Practice → Data Export (an owner or administrator login is needed).',
    'Request a full export and choose JSON (CSV works too). Curve emails a link when it\'s ready — it can take a few hours for a large practice.',
    'Download the .zip (don\'t unzip it) and drop it here. Zips inside the zip are read too.',
  ],

  files: [
    ['perio', /perio/],
    ['codes', /^(procedurecodes?|codes|feeschedules?)$/],
    ['procedures', /^(procedures?|treatments?|treatmentplans?|visitprocedures?|chartentries)$/],
    ['ledger', /^(ledger|ledgerentries|transactions?)$/],
    ['balances', /^(accounts?|balances?|accountbalances?|aging)$/],
    ['carriers', /^(carriers?|insurancecarriers?|payers?)$/],
    ['plans', /^(plans?|insuranceplans?|groupplans?)$/],
    ['insurance', /^(insurance|insurancepolicies|policies|coverages?|patientinsurance)/],
    ['appointments', /^(appointments?|visits?)$/],
    ['recalls', /^(recalls?|recallschedules?|hygienerecalls?)$/],
    ['notes', /(clinicalnotes?|notes?|progressnotes?)/],
    ['providers', /^(providers?|staff|users)$/],
    ['operatories', /^(operatories|operatory|chairs?|rooms?)$/],
    ['patients', /^(patients?)$/],
  ],

  fields: {
    providers: { id: ['id', 'providerid'], type: ['providertype', 'role'], active: ['active', 'isactive'] },
    operatories: { id: ['id', 'operatoryid'], name: ['name'] },
    patients: {
      id: ['id', 'patientid'], dob: ['dateofbirth', 'birthdate'], guarantor: ['responsiblepartyid', 'guarantorid', 'guarantorpatientid'],
      provider: ['primaryproviderid', 'providerid'], hygienist: ['primaryhygienistid', 'hygienistid'],
      phone: ['mobilephone', 'phonesmobile', 'cellphone'], phone_home: ['homephone', 'phoneshome'], phone_work: ['workphone', 'phoneswork'],
      address: ['addressline1', 'addressstreet1', 'addressstreet'], address2: ['addressline2', 'addressstreet2'], city: ['addresscity', 'city'],
      state: ['addressstate', 'state'], zip: ['addresszip', 'addresspostalcode', 'zip'], medical_alerts: ['medicalalerts', 'alerts'],
      // Curve's balance is each patient's own; the family's is the sum.
      balance: ['balance', 'accountbalance', 'patientbalance'],
    },
    carriers: { id: ['id', 'carrierid'], name: ['name'], payer_id: ['payerid', 'electronicpayerid'] },
    plans: { id: ['id', 'planid'], plan_name: ['groupname', 'name', 'employer'], group_number: ['groupnumber'], carrier_id: ['carrierid'] },
    insurance: {
      patient: ['patientid'], carrier_id: ['carrierid'], plan_id: ['planid'], carrier: ['carriername', 'payername'], payer_id: ['payerid'],
      subscriber_id: ['memberid', 'subscribermemberid', 'subscriberid'], subscriber: ['subscriberpatientid', 'subscriberpatient'],
      relationship: ['relationshiptosubscriber', 'relationship'], priority: ['rank', 'priority', 'order', 'coverageorder'],
    },
    appointments: {
      id: ['id', 'appointmentid'], patient: ['patientid'], datetime: ['start', 'starttime', 'startdatetime', 'scheduledstart'], end: ['end', 'endtime'],
      duration: ['durationminutes', 'duration'], provider: ['providerid'], operatory: ['operatoryid', 'chairid', 'roomid'], reason: ['reason', 'title', 'appointmenttype'],
    },
    codes: { code: ['code'], description: ['description', 'name'] },
    procedures: {
      id: ['id', 'procedureid'], patient: ['patientid'], code: ['code', 'cdtcode', 'procedurecode'], date: ['servicedate', 'completeddate', 'dateofservice', 'date'],
      provider: ['providerid'], appointment: ['appointmentid'],
    },
    ledger: { id: ['id'], patient: ['patientid'], date: ['date', 'postedat', 'transactiondate'], type: ['type', 'transactiontype', 'category'] },
    balances: { patient: ['guarantorid', 'responsiblepartyid', 'patientid'], balance: ['balance', 'totalbalance'] },
    recalls: { patient: ['patientid'], type: ['type', 'recalltype', 'name'], interval: ['intervalmonths', 'interval'], due_date: ['duedate', 'nextduedate'] },
    notes: { id: ['id', 'noteid'], patient: ['patientid'], date: ['date', 'notedate', 'createdat', 'signedat'], note: ['text', 'body', 'note', 'content'], provider: ['providerid', 'authorid'] },
    perio: { exam_id: ['periochartid', 'examid', 'chartid', 'id'], patient: ['patientid'], date: ['examdate', 'date'], provider: ['providerid'], pd: ['pocketdepths', 'probingdepths'], gm: ['gingivalmargins', 'recession'], bop: ['bleeding'], sup: ['suppuration'], furc: ['furcation'] },
  },

  patientStatus: lookup([
    ['', 'active'], [/^(active|patient|new)$/, 'active'], [/^(inactive|nonpatient|non-patient|prospect|prospective)$/, 'inactive'],
    [/^(archived|deceased)$/, 'archived'], [/^(deleted|merged|duplicate)$/, 'skip'],
  ]),

  // Curve appointment states (camelCase in JSON, words in CSV).
  appointmentStatus: lookup([
    ['', 'scheduled'], [/^(scheduled|unconfirmed|booked|pending)$/, 'scheduled'], [/^(confirmed)$/, 'confirmed'],
    [/^(checked ?in|checkedin|arrived|in ?chair|inchair|seated|checked ?out|checkedout|completed|complete)$/, 'completed'],
    [/^(no ?show|noshow|broken|missed)$/, 'no_show'], [/^(cancell?ed)$/, 'cancelled'], [/^(deleted|unscheduled|pinned|pinboard|wait ?list)$/, 'skip'],
  ]),

  procedureStatus: lookup([
    [/^(planned|proposed|accepted|recommended|treatment ?plan|tp)$/, 'planned'],
    [/^(completed|complete|done|existing|existingother|existing ?other|existingcurrent|ec|eo|c)$/, 'completed'],
    [/^(declined|rejected|deleted|condition|referred ?out|referredout)$/, 'skip'],
  ]),

  transactionType: lookup([
    [/^(charge|procedure|production|fee|finance ?charge|late ?fee|refund|debit ?adjustment|debitadjustment)$/, 'charge'],
    [/^(payment|patient ?payment|patientpayment|insurance ?payment|insurancepayment|credit ?adjustment|creditadjustment|write ?off|writeoff|discount)$/, 'credit'],
    [/^(adjustment)$/, 'signed'], [/^(claim|estimate|note)$/, 'ignore'],
  ]),

  relationship: lookup([
    ['', undefined], [/^(self|subscriber)$/, 'self'], [/^(spouse|husband|wife|partner)$/, 'spouse'], [/^(child|dependent|son|daughter)$/, 'child'], [/^(other)$/, 'other'],
  ]),

  priority: lookup([['', 'primary'], [/^(1|primary)$/, 'primary'], [/^(2|secondary)$/, 'secondary'], [/^(3|tertiary|medical)$/, 'skip']]),

  providerType: lookup([[/hyg|rdh/, 'hygienist'], [/ortho|endo|perio|surgeon|pedo|specialist/, 'specialist'], [/.*/, 'dentist']]),
};
