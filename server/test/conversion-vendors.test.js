import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { zip } from '../src/recordexport.js';
import { readExport, chunkRows, parseDelimited, jsonRecords } from '../../client/src/conversion/exportzip.js';
import { recognize } from '../src/conversion/common.js';
import { VENDORS } from '../src/conversion/pipeline.js';

const h = harness();

// Sends an export the way the browser does: zip → read → which file is which → only the columns we use, in
// small chunks → dry run (with the office's mapping choices) → import a slice at a time.
async function upload(api, source, files, { filename = 'export.zip', nested } = {}) {
  let entries = Object.entries(files).map(([name, data]) => ({ name, data: typeof data === 'string' ? data : JSON.stringify(data) }));
  if (nested) {
    const inner = entries.filter((e) => nested.includes(e.name));
    entries = entries.filter((e) => !nested.includes(e.name)).concat({ name: 'more/inner.zip', data: zip(inner) });
  }
  const { files: read } = await readExport(zip(entries));
  const start = await api.post('/imports/convert', { source, filename, files: read.map((f) => ({ name: f.name, headers: f.headers })) });
  assert.equal(start.status, 201, JSON.stringify(start.data));
  for (const plan of start.data.files) {
    if (!plan.table) continue;
    const f = read.find((x) => x.name === plan.name);
    const headers = plan.keep.map((i) => f.headers[i]);
    for (const part of chunkRows(f.rows.map((r) => plan.keep.map((i) => r[i] ?? '')), { maxRows: 3 })) {
      const r = await api.post(`/imports/convert/${start.data.id}/rows`, { file: plan.name, table: plan.table, headers, rows: part });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
  }
  return start.data;
}
const check = async (api, id, mapping) => {
  const r = await api.post(`/imports/convert/${id}/check`, mapping ? { mapping } : {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
async function run(api, id) {
  let out;
  for (let i = 0; i < 200; i++) {
    const r = await api.post(`/imports/convert/${id}/run`, { budget_ms: 40, pass: i });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    out = r.data;
    if (out.done) return out;
  }
  throw new Error(`Conversion didn't finish: ${JSON.stringify(out)}`);
}
const step = (summary, s) => summary.steps.find((x) => x.step === s);
const rec = (out, s) => out.reconcile.rows.find((x) => x.step === s);
const idOf = async (practiceId, first) => (await h.db.get('SELECT id FROM patients WHERE practice_id = ? AND first_name = ?', practiceId, first))?.id;

// ---- Dentrix: Office Manager / Data Extract lists with Dentrix's column names ----
const DENTRIX = {
  'Providers.csv': 'Provider ID,Last Name,First Name,Title,NPI,Provider Type,Inactive\nDDS1,Chen,Alex,DDS,1234567893,Dentist,N\nHYG1,Okafor,Sam,RDH,,Hygienist,N\n',
  'Operatories.csv': 'Op ID,Title\nOP1,Op 1\nHYG2,Hygiene 2\n',
  'Patients.csv': `Chart #,Patient ID,Last Name,First Name,MI,Preferred Name,Birthdate,Gender,Status,Guarantor,Prim Prov,Sec Prov,Address 1,Address 2,City,State,Zip,Home Phone,Cell Phone,Email,Medical Alert,Guar Balance,SSN
OBR001,1001,O'Brien,Maria,J,,04/02/1970,F,Patient,OBR001,DDS1,HYG1,12 Oak St,,Austin,TX,78704,512-555-0133,512-555-0199,maria@example.com,Latex allergy,210.00,123-45-6789
OBR002,1002,O'Brien,Sam,,Sammy,08/09/2015,M,Patient,1001,DDS1,HYG1,12 Oak St,,Austin,TX,78704,512-555-0133,,,,,987-65-4321
LEE001,1003,Lee,Dana,,,1/5/1988,F,VIP,LEE001,DDS9,,,,,,,,,,,0.00,
DUP001,1004,O'Brien,Maria,,,04/02/1970,F,Duplicate,DUP001,DDS1,,,,,,,,,,,,
`,
  'Insurance.csv': `Chart #,Coverage,Carrier Name,Payor ID,Group Plan Name,Group #,Subscriber ID,Subscriber Chart #,Relation to Subscriber,Annual Max,Deductible
OBR001,Primary Dental,Delta Dental of Texas,94276,City of Austin,G-4411,DDX99812,OBR001,Self,1500.00,50.00
OBR002,Primary Dental,Delta Dental of Texas,94276,City of Austin,G-4411,DDX99812,OBR001,Child,1500.00,50.00
OBR001,Primary Medical,BCBS Texas,,,,M123,OBR001,Self,,
`,
  'Appointments.csv': `Appt ID,Chart #,Appt Date,Appt Time,Appt Length,Provider,Op,Status,Appt Reason,Broken
A1,OBR001,03/01/2025,9:00 AM,40,HYG1,HYG2,Complete,PerEx Pro,N
A2,OBR001,06/02/2031,10:00 AM,60,DDS1,OP1,Confirmed,Crown #30,N
A3,OBR002,06/02/2031,11:00 AM,30,DDS1,OP1,Hold,Sealants,N
A4,OBR002,02/10/2025,2:00 PM,30,HYG1,HYG2,,Prophy,Y
A5,OBR001,,,30,DDS1,OP1,Pinboard,Bridge,N
`,
  'Procedures.csv': `Proc ID,Chart #,Proc Date,ADA Code,Description,Tooth,Surface,Amount,Status,Provider
P1,OBR001,03/01/2025,D0120,Periodic oral evaluation,,,60.00,C,DDS1
P2,OBR001,03/01/2025,D1110,Prophylaxis - adult,,,120.00,C,HYG1
P3,OBR001,,D2740,Crown - porcelain/ceramic,30,,1200.00,TP,DDS1
P4,OBR001,05/01/2019,D2740,Crown - porcelain/ceramic,3,,0,EO,DDS1
P5,OBR001,01/01/2025,D0140,Limited evaluation,,,0,Cond,DDS1
P6,OBR002,02/10/2025,PERIOMAINT,Perio maintenance,,,95.00,C,DDS9
P7,OBR002,02/10/2025,D2391,Resin one surface,45,MO,150.00,C,DDS1
`,
  'Aging.csv': `Guarantor Chart #,Guarantor Name,0-30,31-60,61-90,91+,Total Balance
OBR001,"O'Brien, Maria",60.00,150.00,0.00,0.00,210.00
ZZZ999,"Gone, Old",15.00,0.00,0.00,0.00,15.00
`,
  'ContinuingCare.csv': 'Chart #,Continuing Care Type,Interval,Due Date\nOBR001,PROPHY,6 M,09/01/2025\nOBR002,BITEWING,1 Y,\n',
  'ClinicalNotes.csv': 'Note ID,Chart #,Note Date,Provider,Clinical Note\nN1,OBR001,03/01/2025 09:45 AM,DDS1,"Exam WNL. Recommend crown #30.\nPt agrees."\nN2,OBR002,02/10/2025,HYG1,Pt did not show.\n',
  'Perio.csv': `Exam ID,Chart #,Exam Date,Provider,Tooth,Measurement,DB,B,MB,DL,L,ML
E1,OBR001,03/01/2025,HYG1,3,Pocket Depth,5,2,3,3,3,4
E1,OBR001,03/01/2025,HYG1,3,Bleeding,Y,N,N,N,N,N
E1,OBR001,03/01/2025,HYG1,1,Missing,,,,,,
E1,OBR001,03/01/2025,HYG1,99,Pocket Depth,1,1,1,1,1,1
`,
  'Readme.pdf': 'not a data file',
};

test('reading exports: zip entries, nested zips, delimiters, JSON flattening, file recognition', async () => {
  const { files, skipped } = await readExport(zip([{ name: 'x/Patients.txt', data: 'Chart #\tLast Name\tFirst Name\nA1\tDoe\tJo\n' }, { name: 'inner.zip', data: zip([{ name: 'a.json', data: '[{"id":1,"address":{"line1":"5 Pine"},"teeth":[{"tooth":3,"pd":[1,2,3,4,5,6]}]}]' }]) }, { name: 'logo.png', data: 'x' }]));
  assert.deepEqual(files.map((f) => f.name), ['x/Patients.txt', 'inner.zip/a.json']);
  assert.deepEqual(skipped, ['logo.png']);
  assert.deepEqual(files[0].rows, [['A1', 'Doe', 'Jo']]);
  assert.deepEqual(files[1].headers, ['id', 'address.line1', 'tooth', 'pd']);
  assert.deepEqual(files[1].rows, [['1', '5 Pine', '3', '1,2,3,4,5,6']]);
  assert.deepEqual(parseDelimited('a|b\n"x|y"|2'), [['a', 'b'], ['x|y', '2']]);
  assert.equal(jsonRecords('{"data":[{"a":1},{"a":2}]}').length, 2);
  // By name, then by columns when the name says nothing.
  assert.equal(recognize(VENDORS.dentrix, 'export/Patients.csv', ['Chart #', 'Last Name', 'First Name']), 'patients');
  assert.equal(recognize(VENDORS.dentrix, 'table7.csv', ['Chart #', 'ADA Code', 'Tooth', 'Surface', 'Proc Date', 'Amount']), 'procedures');
  assert.equal(recognize(VENDORS.eaglesoft, 'planned_services.csv', ['patient_id', 'service_code', 'tooth']), 'procedures');
  assert.equal(recognize(VENDORS.curve, 'insurancePolicies.json', ['patientId', 'carrierId', 'memberId']), 'insurance');
  assert.equal(recognize(VENDORS.dentrix, 'stuff.csv', ['Foo', 'Bar']), null);
});

test('Dentrix: dry run reports counts, A/R and unmapped values; mapping them; import; reconciliation; corrected re-import', async () => {
  const { api, provider, practiceId } = await h.practice();
  const batch = await upload(api, 'dentrix', DENTRIX, { filename: 'dentrix-export.zip' });
  const plan = Object.fromEntries(batch.files.map((f) => [f.name, f]));
  assert.equal(plan['Patients.csv'].table, 'patients');
  assert.equal(plan['Aging.csv'].table, 'balances');
  assert.equal(plan['ContinuingCare.csv'].table, 'recalls');
  assert.ok(plan['Patients.csv'].dropped.includes('SSN'), 'Social Security numbers are never sent');
  assert.ok(!batch.files.some((f) => f.name === 'Readme.pdf'));

  // Running before the dry run is refused.
  assert.equal((await api.post(`/imports/convert/${batch.id}/run`, {})).status, 409);

  let dry = await check(api, batch.id);
  assert.deepEqual([step(dry, 'patients').source, step(dry, 'patients').created, step(dry, 'patients').skipped], [4, 3, 1], 'the duplicate chart is left out');
  assert.equal(step(dry, 'patients').reasons[0].reason, "Patient status isn't brought over");
  assert.equal(step(dry, 'guarantors').updated, 1);
  assert.deepEqual([step(dry, 'insurance').created, step(dry, 'insurance').skipped], [2, 1], 'medical coverage is left out');
  assert.deepEqual([step(dry, 'appointments').created, step(dry, 'appointments').skipped], [4, 1]);
  assert.deepEqual([step(dry, 'procedures').source, step(dry, 'procedures').created, step(dry, 'procedures').skipped, step(dry, 'procedures').errors], [7, 5, 1, 1]);
  assert.match(step(dry, 'procedures').reasons.find((r) => r.reason.startsWith('Tooth')).reason, /Tooth "45" isn't a tooth number/);
  assert.deepEqual([step(dry, 'recalls').created, step(dry, 'recalls').skipped], [1, 1]);
  assert.equal(step(dry, 'perio').created, 1);
  assert.equal(dry.ar.source, 22500, 'the A/R total includes accounts we can\'t place');
  assert.equal(dry.ar.placed, 21000);
  assert.equal(dry.ar.basis, 'balances');
  assert.equal(dry.ar.unplaced[0].ref, 'ZZZ999');
  const unmapped = Object.fromEntries(dry.unmapped.map((u) => [`${u.kind}:${u.value}`, u]));
  assert.ok(unmapped['provider:DDS9'], 'a provider not in the provider list');
  assert.ok(unmapped['appointment_status:Hold']);
  assert.ok(unmapped['procedure_code:PERIOMAINT']);
  assert.ok(unmapped['patient_status:VIP']);
  assert.ok(unmapped['provider:DDS9'].choices.some((c) => c.value === String(provider.id)));
  // Nothing was written by the dry run.
  assert.equal(await idOf(practiceId, 'Dana'), undefined);

  // Choices are checked: a CDT code, a real provider of this practice, a known status.
  assert.equal((await api.post(`/imports/convert/${batch.id}/check`, { mapping: { procedure_code: { PERIOMAINT: 'perio' } } })).status, 400);
  assert.equal((await api.post(`/imports/convert/${batch.id}/check`, { mapping: { provider: { DDS9: 999999 } } })).status, 400);
  assert.equal((await api.post(`/imports/convert/${batch.id}/check`, { mapping: { appointment_status: { Hold: 'maybe' } } })).status, 400);
  dry = await check(api, batch.id, { procedure_code: { PERIOMAINT: 'd4910' }, provider: { DDS9: String(provider.id) }, appointment_status: { Hold: 'confirmed' }, patient_status: { VIP: 'active' } });
  assert.ok(dry.unmapped.every((u) => u.kind !== 'procedure_code' || u.chosen === 'D4910'));

  const out = await run(api, batch.id);
  assert.equal(out.done, true);
  const maria = await idOf(practiceId, 'Maria');
  const sam = await idOf(practiceId, 'Sam');
  const dana = await idOf(practiceId, 'Dana');
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM patients WHERE practice_id = ? AND first_name = ?', practiceId, 'Maria')).n, 1);
  const full = (await api.get(`/patients/${sam}`)).data;
  assert.equal(full.guarantor_id, maria, 'Sam\'s guarantor (given by internal Patient ID) is Maria');
  assert.equal(full.preferred_name, 'Sammy');
  assert.equal((await h.db.get('SELECT primary_provider_id FROM patients WHERE id = ?', dana)).primary_provider_id, provider.id, 'the unmapped provider went where the office said');
  const m = await h.db.get('SELECT dob, gender, phone, phone_home, medical_alerts, primary_provider_id, primary_hygienist_id FROM patients WHERE id = ?', maria);
  assert.deepEqual([m.dob, m.gender, m.phone, m.phone_home, m.medical_alerts], ['1970-04-02', 'female', '512-555-0199', '512-555-0133', 'Latex allergy']);
  const provs = await h.db.all('SELECT id, name, type, npi FROM providers WHERE practice_id = ?', practiceId);
  assert.ok(provs.some((p) => p.name === 'Alex Chen, DDS' && p.npi === '1234567893' && p.id === m.primary_provider_id));
  assert.ok(provs.some((p) => p.name === 'Sam Okafor, RDH' && p.type === 'hygienist' && p.id === m.primary_hygienist_id));

  const ins = await h.db.all('SELECT pi.patient_id, pi.relationship, pi.subscriber_id, pi.subscriber_name, pi.priority, c.name, c.payer_id FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id WHERE pi.practice_id = ? ORDER BY pi.patient_id', practiceId);
  assert.deepEqual(ins.map((i) => [i.patient_id, i.name, i.payer_id, i.relationship, i.subscriber_id, i.subscriber_name, i.priority]), [
    [maria, 'Delta Dental of Texas', '94276', 'self', 'DDX99812', "Maria O'Brien", 'primary'], [sam, 'Delta Dental of Texas', '94276', 'child', 'DDX99812', "Maria O'Brien", 'primary'],
  ]);

  const appts = await h.db.all('SELECT a.patient_id, a.status, a.start_time, a.end_time, o.name AS op, pv.name AS prov FROM appointments a LEFT JOIN operatories o ON o.id = a.operatory_id JOIN providers pv ON pv.id = a.provider_id WHERE a.practice_id = ? AND a.patient_id IN (?, ?) ORDER BY a.start_time', practiceId, maria, sam);
  assert.deepEqual(appts.map((a) => [a.status, a.start_time, a.end_time, a.op, a.prov]), [
    ['no_show', '2025-02-10 14:00', '2025-02-10 14:30', 'Hygiene 2', 'Sam Okafor, RDH'],
    ['completed', '2025-03-01 09:00', '2025-03-01 09:40', 'Hygiene 2', 'Sam Okafor, RDH'],
    ['confirmed', '2031-06-02 10:00', '2031-06-02 11:00', 'Op 1', 'Alex Chen, DDS'],
    ['confirmed', '2031-06-02 11:00', '2031-06-02 11:30', 'Op 1', 'Alex Chen, DDS'],
  ]);

  // Procedure history without charges; planned work on a treatment plan; the office's code for PERIOMAINT.
  const procs = await h.db.all('SELECT patient_id, code, status, tooth, fee, treatment_plan_id IS NOT NULL AS planned, completed_at FROM procedures WHERE practice_id = ? ORDER BY id', practiceId);
  assert.deepEqual(procs.map((p) => [p.code, p.status, p.tooth, p.fee, Number(p.planned)]), [
    ['D0120', 'completed', null, 6000, 0], ['D1110', 'completed', null, 12000, 0], ['D2740', 'planned', '30', 120000, 1], ['D2740', 'completed', '3', 0, 0], ['D4910', 'completed', null, 9500, 0],
  ]);
  assert.equal(procs[0].completed_at.slice(0, 10), '2025-03-01');
  const ledger = await h.db.all('SELECT patient_id, type, amount, adjustment_type FROM ledger_entries WHERE practice_id = ? AND voided_at IS NULL', practiceId);
  assert.deepEqual(ledger.map((l) => [l.patient_id, l.type, l.amount, l.adjustment_type]), [[maria, 'adjustment', 21000, 'Balance forward']], 'one balance forward for the family; no history re-posted');

  const note = await h.db.get('SELECT body, signed, created_at FROM clinical_notes WHERE patient_id = ? ORDER BY id LIMIT 1', maria);
  assert.match(note.body, /^Exam WNL\. Recommend crown #30\.\nPt agrees\.\n\n\(From Dentrix\)$/);
  assert.equal(note.signed, 1);
  assert.match(String(note.created_at), /^2025-03-01 09:45/);
  const perio = JSON.parse((await h.db.get('SELECT readings FROM perio_exams WHERE patient_id = ?', maria)).readings);
  assert.deepEqual(perio['3'].pd, [5, 2, 3, 3, 3, 4]);
  assert.deepEqual(perio['3'].bop, [true, false, false, false, false, false]);
  assert.equal(perio['1'].missing, true);
  assert.equal(perio['99'], undefined);
  const recall = await h.db.get('SELECT type, interval_months, due_date FROM recalls WHERE patient_id = ?', maria);
  assert.deepEqual([recall.type, recall.interval_months, recall.due_date], ['prophy', 6, '2025-09-01']);

  // Reconciliation: every source row is either brought in or listed; the database agrees; A/R matches.
  assert.ok(out.reconcile.rows.every((r) => r.balanced), JSON.stringify(out.reconcile.rows));
  assert.deepEqual([rec(out, 'patients').source, rec(out, 'patients').brought, rec(out, 'patients').left, rec(out, 'patients').in_system], [4, 3, 1, 3]);
  assert.deepEqual([rec(out, 'procedures').brought, rec(out, 'procedures').left, rec(out, 'procedures').in_system], [5, 2, 5]);
  assert.deepEqual([out.reconcile.ar.source, out.reconcile.ar.placed, out.reconcile.ar.posted, out.reconcile.ar.matches], [22500, 21000, 21000, true]);
  assert.ok(out.counts.balances.reasons.some((r) => r.reason === "The account isn't in the patient file" && r.examples[0].includes('ZZZ999')));
  // What was left out is a work item in Needs attention.
  const issue = await h.db.get("SELECT title FROM issues WHERE practice_id = ? AND dedupe_key = ? AND status = 'open'", practiceId, `import:${batch.id}`);
  assert.match(issue.title, /Dentrix conversion: \d+ records couldn't be brought over/);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM conversion_rows WHERE batch_id = ?', batch.id)).n, 0);

  // The import is the actor on what it made; starting it was the person.
  const made = await h.db.get("SELECT source, actor, user_id FROM audit_log WHERE practice_id = ? AND action = 'patient.create' AND entity_id = ?", practiceId, maria);
  assert.equal(made.source, 'import');
  assert.match(made.actor, new RegExp(`^Dentrix conversion #${batch.id} \\(started by Admin\\)$`));
  const started = await h.db.get("SELECT source FROM audit_log WHERE action = 'import.start' AND entity_id = ?", batch.id);
  assert.equal(started.source, 'human');

  // ---- A corrected export: Maria's phone and the family balance changed, a new visit, one more note. ----
  const fixed = {
    ...DENTRIX,
    'Patients.csv': DENTRIX['Patients.csv'].replace('512-555-0199', '512-555-0777'),
    'Aging.csv': DENTRIX['Aging.csv'].replace('60.00,150.00,0.00,0.00,210.00', '100.00,150.00,0.00,0.00,250.00'),
    'Appointments.csv': `${DENTRIX['Appointments.csv']}A6,OBR001,07/01/2031,8:00 AM,60,DDS1,OP1,Confirmed,Crown seat,N\n`,
    'Procedures.csv': DENTRIX['Procedures.csv'].replace('P3,OBR001,,D2740,Crown - porcelain/ceramic,30,,1200.00,TP', 'P3,OBR001,,D2740,Crown - porcelain/ceramic,30,,1150.00,TP'),
  };
  const again = await upload(api, 'dentrix', fixed);
  const dry2 = await check(api, again.id, { procedure_code: { PERIOMAINT: 'D4910' }, provider: { DDS9: String(provider.id) }, appointment_status: { Hold: 'confirmed' }, patient_status: { VIP: 'active' } });
  assert.deepEqual([step(dry2, 'patients').created, step(dry2, 'patients').updated], [0, 3], 'known charts are updates');
  assert.deepEqual([step(dry2, 'appointments').created, step(dry2, 'appointments').updated], [1, 4]);
  assert.equal(step(dry2, 'balances').updated, 1);
  const out2 = await run(api, again.id);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM patients WHERE practice_id = ?', practiceId)).n, 4, 'Jane (already here) + three from Dentrix — no duplicates');
  assert.equal((await h.db.get('SELECT phone FROM patients WHERE id = ?', maria)).phone, '512-555-0777');
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM procedures WHERE practice_id = ?', practiceId)).n, 5);
  assert.equal((await h.db.get("SELECT fee FROM procedures WHERE practice_id = ? AND status = 'planned'", practiceId)).fee, 115000, 'planned work follows the corrected export');
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM clinical_notes WHERE practice_id = ?', practiceId)).n, 2);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM appointments WHERE practice_id = ? AND patient_id IN (?, ?)', practiceId, maria, sam)).n, 5);
  // The old balance forward is voided (not edited) and the corrected one posted: the family owes exactly $250.
  const bal = await h.db.all('SELECT amount, voided_at IS NOT NULL AS voided FROM ledger_entries WHERE patient_id = ? ORDER BY id', maria);
  assert.deepEqual(bal.map((b) => [b.amount, Number(b.voided)]), [[21000, 1], [25000, 0]]);
  assert.deepEqual([out2.reconcile.ar.posted, out2.reconcile.ar.matches], [25000, true]);
  const phoneChange = await h.db.get("SELECT changes, source FROM audit_log WHERE practice_id = ? AND action = 'patient.change' AND entity_id = ? ORDER BY id DESC", practiceId, maria);
  assert.equal(phoneChange.source, 'import');
  assert.deepEqual(JSON.parse(phoneChange.changes).phone, ['512-555-0199', '512-555-0777'], 'before and after are recorded');
});

// ---- Eaglesoft: Patterson Data Export CSVs with the database's column names ----
const EAGLESOFT = {
  'provider.csv': 'provider_id,first_name,last_name,title,npi,position,active\nDR1,Alex,Chen,DDS,1234567893,Dentist,Y\nHY1,Sam,Okafor,RDH,,Hygienist,Y\nOLD,Retired,Doc,DDS,,Dentist,N\n',
  'chairs.csv': 'chair_num,description\n1,Chair 1\n2,Hygiene 2\n',
  'patient.csv': `patient_id,first_name,last_name,birth_date,sex,status,responsible_party,preferred_dentist,preferred_hygienist,address_1,city,state,zipcode,home_phone,cell_phone,email_address,medical_alert
1001,Maria,Garcia,1979-03-14 00:00:00,F,A,1001,DR1,HY1,12 Oak St,Austin,TX,78701,5125552001,5125552002,maria@example.com,
1002,Tomas,Garcia,2012-07-01 00:00:00,M,A,1001,DR1,HY1,12 Oak St,Austin,TX,78701,5125552001,,,
1003,Linh,Nguyen,1990-01-01 00:00:00,F,I,1003,DR1,,,,,,,,,
`,
  'responsible_party.csv': 'responsible_party_id,balance_0_30,balance_31_60,balance_61_90,balance_over_90\n1001,100.00,25.50,0,0\n1003,-20.00,0,0,0\n',
  'appointment.csv': `appointment_id,patient_id,start_time,end_time,provider_id,location_id,appointment_status,description
501,1001,2025-03-01 09:00:00,2025-03-01 09:50:00,HY1,2,Completed,Prophy
502,1002,2031-06-02 15:00:00,2031-06-02 15:30:00,DR1,1,Scheduled,Sealants
503,1001,2025-02-01 08:00:00,2025-02-01 09:00:00,DR1,1,Deleted,x
`,
  'services.csv': 'service_code,ada_code,description\n01110,,Prophylaxis - adult\n00120,D0120,Periodic oral evaluation\n01351,,Sealant\nBLEACH,,Take-home whitening\n',
  'service_history.csv': 'line_number,patient_id,service_code,tooth,surface,fee,date_completed,provider_id\n9001,1001,00120,,,55.00,2025-03-01,DR1\n9002,1001,01110,,,110.00,2025-03-01,HY1\n9003,1002,BLEACH,,,300.00,2024-11-11,DR1\n',
  'planned_services.csv': 'line_number,patient_id,service_code,tooth,surface,fee,date_planned,provider_id\n7001,1002,01351,3,O,45.00,2025-03-01,DR1\n',
  'transactions.csv': 'tran_num,patient_id,tran_date,type,amount\n1,1001,2025-03-01,S,165.00\n2,1001,2025-03-01,P,39.50\n',
  'insurance_company.csv': 'insurance_company_id,name,payer_id\n30,Delta Dental of Texas,94276\n',
  'employer.csv': 'employer_id,name,group_number,insurance_company_id\n50,City of Austin,G-4411,30\n',
  'patient_insurance.csv': 'patient_id,employer_id,member_id,policy_holder_id,relation_to_policy_holder,coverage_order\n1001,50,DDX1,1001,Self,1\n1002,50,DDX1,1001,Child,1\n',
  'recall.csv': 'patient_id,recall_type,recall_interval,due_date\n1001,Prophy,6,2025-09-01\n1003,Perio,3,2025-06-01\n',
  'clinical_notes.csv': 'clinical_note_id,patient_id,date_entered,note_text,provider_id\n77,1001,2025-03-01 10:15:00,"Prophy, light calculus.",HY1\n',
  'perio.csv': 'perio_exam_id,patient_id,exam_date,tooth,measurement_type,db,b,mb,dl,l,ml\n5,1001,2025-03-01,14,PD,4,3,4,3,2,3\n5,1001,2025-03-01,14,Mobility,1,,,,,\n',
};

test('Eaglesoft: families by responsible party, balances from aging buckets, service codes to CDT, insurance via employer and carrier', async () => {
  const { api, practiceId } = await h.practice();
  const batch = await upload(api, 'eaglesoft', EAGLESOFT);
  const tables = Object.fromEntries(batch.files.map((f) => [f.name, f.table]));
  assert.deepEqual(tables, {
    'provider.csv': 'providers', 'chairs.csv': 'operatories', 'patient.csv': 'patients', 'responsible_party.csv': 'balances', 'appointment.csv': 'appointments', 'services.csv': 'codes',
    'service_history.csv': 'procedures', 'planned_services.csv': 'procedures', 'transactions.csv': 'ledger', 'insurance_company.csv': 'carriers', 'employer.csv': 'plans',
    'patient_insurance.csv': 'insurance', 'recall.csv': 'recalls', 'clinical_notes.csv': 'notes', 'perio.csv': 'perio',
  });
  const dry = await check(api, batch.id);
  assert.deepEqual([dry.ar.source, dry.ar.basis, dry.ar.families], [10550, 'balances', 2], 'buckets added up; the credit balance counts too');
  assert.deepEqual(dry.unmapped.map((u) => `${u.kind}:${u.value}`), ['procedure_code:BLEACH']);
  const out = await run(api, batch.id);

  const maria = await idOf(practiceId, 'Maria');
  const tomas = await idOf(practiceId, 'Tomas');
  const linh = await idOf(practiceId, 'Linh');
  assert.equal((await h.db.get('SELECT guarantor_id FROM patients WHERE id = ?', tomas)).guarantor_id, maria);
  assert.equal((await h.db.get('SELECT status FROM patients WHERE id = ?', linh)).status, 'inactive');
  assert.equal((await h.db.get("SELECT active FROM providers WHERE practice_id = ? AND name = 'Retired Doc, DDS'", practiceId)).active, 0);
  const procs = await h.db.all('SELECT patient_id, code, status, tooth, surfaces, fee FROM procedures WHERE practice_id = ? ORDER BY id', practiceId);
  assert.deepEqual(procs.map((p) => [p.code, p.status, p.tooth, p.surfaces, p.fee]), [
    ['D0120', 'completed', null, null, 5500], ['D1110', 'completed', null, null, 11000], ['BLEACH', 'completed', null, null, 30000], ['D1351', 'planned', '3', 'O', 4500],
  ]);
  assert.equal((await h.db.get("SELECT active FROM procedure_codes WHERE practice_id = ? AND code = 'BLEACH'", practiceId)).active, 0, 'a non-CDT code is kept, not offered for new work');
  const ins = await h.db.all('SELECT pi.relationship, pi.group_number, c.name, pi.subscriber_name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id WHERE pi.practice_id = ? ORDER BY pi.patient_id', practiceId);
  assert.deepEqual(ins.map((i) => [i.name, i.group_number, i.relationship, i.subscriber_name]), [['Delta Dental of Texas', 'G-4411', 'self', 'Maria Garcia'], ['Delta Dental of Texas', 'G-4411', 'child', 'Maria Garcia']]);
  const appt = await h.db.get('SELECT a.status, a.end_time, o.name FROM appointments a JOIN operatories o ON o.id = a.operatory_id WHERE a.patient_id = ?', maria);
  assert.deepEqual([appt.status, appt.end_time, appt.name], ['completed', '2025-03-01 09:50', 'Hygiene 2']);
  const ledger = await h.db.all('SELECT patient_id, amount FROM ledger_entries WHERE practice_id = ? ORDER BY patient_id', practiceId);
  assert.deepEqual(ledger.map((l) => [l.patient_id, l.amount]), [[maria, 12550], [linh, -2000]], 'the transactions file isn\'t re-posted');
  assert.deepEqual([out.reconcile.ar.source, out.reconcile.ar.posted, out.reconcile.ar.matches], [10550, 10550, true]);
  const perio = JSON.parse((await h.db.get('SELECT readings FROM perio_exams WHERE patient_id = ?', maria)).readings);
  assert.deepEqual(perio['14'], { pd: [4, 3, 4, 3, 2, 3], mob: 1 });
  assert.equal((await h.db.get('SELECT type FROM recalls WHERE patient_id = ?', linh)).type, 'perio');
  assert.ok(out.reconcile.rows.every((r) => r.balanced));
});

// ---- Curve: JSON per entity, camelCase, nested address and perio teeth, a zip inside the zip ----
const CURVE = {
  'providers.json': [{ id: 'prov_1', firstName: 'Alex', lastName: 'Chen', suffix: 'DDS', npi: '1234567893', providerType: 'dentist', active: true }],
  'operatories.json': [{ id: 'op_1', name: 'Room 1', active: true }],
  'patients.json': [
    { id: 'pat_1', firstName: 'Priya', lastName: 'Shah', dateOfBirth: '1985-06-15', gender: 'female', email: 'priya@example.com', mobilePhone: '512-555-0111', address: { line1: '5 Pine', city: 'Austin', state: 'TX', zip: '78702' }, status: 'active', responsiblePartyId: 'pat_1', primaryProviderId: 'prov_1', balance: 80.25 },
    { id: 'pat_2', firstName: 'Ravi', lastName: 'Shah', dateOfBirth: '2014-02-03', gender: 'male', status: 'active', responsiblePartyId: 'pat_1', balance: 19.75 },
    { id: 'pat_3', firstName: 'Gone', lastName: 'Person', status: 'deleted', balance: 5 },
  ],
  'appointments.json': { data: [
    { id: 'apt_1', patientId: 'pat_1', start: '2025-04-01T10:00:00', end: '2025-04-01T11:00:00', providerId: 'prov_1', operatoryId: 'op_1', status: 'completed', reason: 'Crown prep' },
    { id: 'apt_2', patientId: 'pat_2', start: '2031-01-05T08:30:00', durationMinutes: 45, providerId: 'prov_1', operatoryId: 'op_1', status: 'confirmed', reason: 'Sealants' },
    { id: 'apt_3', patientId: 'pat_2', start: '2025-01-06T08:30:00', durationMinutes: 30, providerId: 'prov_1', status: 'noShow' },
  ] },
  'procedures.json': [
    { id: 'tx_1', patientId: 'pat_1', code: 'D2740', description: 'Crown', tooth: '19', fee: 1100, status: 'completed', serviceDate: '2025-04-01', providerId: 'prov_1' },
    { id: 'tx_2', patientId: 'pat_2', code: 'D1351', tooth: '3', surfaces: 'O', fee: 45, status: 'planned', providerId: 'prov_1', appointmentId: 'apt_2' },
    { id: 'tx_3', patientId: 'pat_1', code: 'D6010', tooth: '30', fee: 2200, status: 'declined', providerId: 'prov_1' },
  ],
  'carriers.json': [{ id: 'car_1', name: 'MetLife', payerId: '65978' }],
  'insurancePolicies.json': [
    { id: 'pol_1', patientId: 'pat_1', carrierId: 'car_1', groupNumber: 'MLX-1', groupName: 'Acme Corp', memberId: 'ML123', subscriberPatientId: 'pat_1', relationship: 'self', rank: 'primary' },
    { id: 'pol_2', patientId: 'pat_2', carrierId: 'car_1', groupNumber: 'MLX-1', memberId: 'ML123', subscriberPatientId: 'pat_1', relationship: 'child', rank: 'primary' },
  ],
  'recalls.json': [{ patientId: 'pat_1', type: 'Prophy', intervalMonths: 6, dueDate: '2025-10-01' }],
  'clinicalNotes.json': [{ id: 'note_1', patientId: 'pat_1', date: '2025-04-01T11:05:00', text: 'Crown prep #19, temp placed.', providerId: 'prov_1' }],
  'perioCharts.json': [{ id: 'perio_1', patientId: 'pat_1', examDate: '2025-04-01', providerId: 'prov_1', teeth: [{ tooth: 19, pocketDepths: [3, 2, 3, 4, 2, 3], bleeding: [false, false, true, false, false, false], mobility: 1 }, { tooth: 18, missing: true }] }],
};

test('Curve: JSON export with a nested zip; per-patient balances summed per family; practice isolation', async () => {
  const a = await h.practice();
  const batch = await upload(a.api, 'curve', CURVE, { nested: ['appointments.json', 'recalls.json'] });
  assert.ok(batch.files.some((f) => f.name === 'more/inner.zip/appointments.json' && f.table === 'appointments'));
  const dry = await check(a.api, batch.id);
  assert.deepEqual([dry.ar.source, dry.ar.placed, dry.ar.families], [10500, 10000, 1]);
  assert.equal(dry.ar.unplaced[0].reason, "The patient wasn't brought over");
  assert.deepEqual(dry.unmapped, []);

  // Another practice can't see, feed or run this conversion.
  const b = await h.practice();
  assert.equal((await b.api.get(`/imports/convert/${batch.id}`)).status, 404);
  assert.equal((await b.api.post(`/imports/convert/${batch.id}/check`, {})).status, 404);
  assert.equal((await b.api.post(`/imports/convert/${batch.id}/run`, {})).status, 404);
  assert.equal((await b.api.post(`/imports/convert/${batch.id}/rows`, { file: 'patients.json', table: 'patients', headers: ['id', 'firstName', 'lastName'], rows: [['x', 'Evil', 'Row']] })).status, 404);
  // Mapping to a provider from another practice is refused.
  assert.equal((await a.api.post(`/imports/convert/${batch.id}/check`, { mapping: { provider: { prov_9: String(b.provider.id) } } })).status, 400);

  const out = await run(a.api, batch.id);
  const priya = await idOf(a.practiceId, 'Priya');
  const ravi = await idOf(a.practiceId, 'Ravi');
  assert.equal((await h.db.get('SELECT guarantor_id FROM patients WHERE id = ?', ravi)).guarantor_id, priya);
  assert.equal((await h.db.get('SELECT address, city, zip FROM patients WHERE id = ?', priya)).address, '5 Pine');
  const appts = await h.db.all('SELECT patient_id, status, start_time, end_time FROM appointments WHERE practice_id = ? AND patient_id IN (?, ?) ORDER BY start_time', a.practiceId, priya, ravi);
  assert.deepEqual(appts.map((x) => [x.status, x.start_time, x.end_time]), [['no_show', '2025-01-06 08:30', '2025-01-06 09:00'], ['completed', '2025-04-01 10:00', '2025-04-01 11:00'], ['confirmed', '2031-01-05 08:30', '2031-01-05 09:15']]);
  const planned = await h.db.get("SELECT appointment_id FROM procedures WHERE patient_id = ? AND status = 'planned'", ravi);
  assert.ok(planned.appointment_id, 'planned work stays on its visit');
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM procedures WHERE practice_id = ?', a.practiceId)).n, 2, 'declined work is left out');
  const perio = JSON.parse((await h.db.get('SELECT readings FROM perio_exams WHERE patient_id = ?', priya)).readings);
  assert.deepEqual(perio, { 19: { pd: [3, 2, 3, 4, 2, 3], bop: [false, false, true, false, false, false], mob: 1 }, 18: { missing: true } });
  assert.equal((await h.db.get('SELECT subscriber_id FROM patient_insurance WHERE patient_id = ?', ravi)).subscriber_id, 'ML123');
  assert.deepEqual([out.reconcile.ar.source, out.reconcile.ar.placed, out.reconcile.ar.posted, out.reconcile.ar.matches], [10500, 10000, 10000, true]);

  // The same export in the other practice makes that practice's own records.
  const other = await upload(b.api, 'curve', CURVE);
  await check(b.api, other.id);
  await run(b.api, other.id);
  const both = await h.db.all("SELECT practice_id FROM patients WHERE first_name = 'Priya' AND last_name = 'Shah' AND practice_id IN (?, ?)", a.practiceId, b.practiceId);
  assert.equal(both.length, 2);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM patients WHERE practice_id = ?', a.practiceId)).n, 3, 'practice A is untouched');
});

test('Curve: balances added up from the ledger when there are none; an unknown transaction type is reported, then mapped', async () => {
  const { api, practiceId } = await h.practice();
  const files = {
    'patients.json': [{ id: 'p1', firstName: 'Ana', lastName: 'Ruiz', status: 'active' }, { id: 'p2', firstName: 'Leo', lastName: 'Ruiz', responsiblePartyId: 'p1' }],
    'ledger.json': [
      { id: 't1', patientId: 'p1', date: '2025-01-02', type: 'charge', amount: 200 },
      { id: 't2', patientId: 'p2', date: '2025-01-03', type: 'charge', amount: 90 },
      { id: 't3', patientId: 'p1', date: '2025-01-04', type: 'payment', amount: 50 },
      { id: 't4', patientId: 'p1', date: '2025-01-05', type: 'insurancePayment', amount: -30 },
      { id: 't5', patientId: 'p2', date: '2025-01-06', type: 'Membership Fee', amount: 25 },
      { id: 't6', patientId: 'p1', date: '2025-01-07', type: 'claim', amount: 400 },
    ],
  };
  const batch = await upload(api, 'curve', files);
  let dry = await check(api, batch.id);
  assert.deepEqual([dry.ar.basis, dry.ar.source], ['ledger', 21000]);
  assert.equal(dry.unmapped[0].kind, 'transaction_type');
  assert.equal(dry.unmapped[0].value, 'Membership Fee');
  assert.equal(dry.unmapped[0].fallback, 'left out of the balance');
  dry = await check(api, batch.id, { transaction_type: { 'Membership Fee': 'charge' } });
  assert.equal(dry.ar.source, 23500);
  // Staging more rows after a check means checking again before importing.
  assert.equal((await api.post(`/imports/convert/${batch.id}/rows`, { file: 'ledger.json', table: 'ledger', headers: ['id', 'patientId', 'date', 'type', 'amount'], rows: [['t7', 'p1', '2025-01-08', 'payment', '10']] })).status, 200);
  assert.equal((await api.post(`/imports/convert/${batch.id}/run`, {})).status, 409);
  assert.equal((await check(api, batch.id)).ar.source, 22500, 'the office\'s mapping is kept');
  const out = await run(api, batch.id);
  const ana = await idOf(practiceId, 'Ana');
  const entries = await h.db.all('SELECT patient_id, amount, type FROM ledger_entries WHERE practice_id = ?', practiceId);
  assert.deepEqual(entries.map((e) => [e.patient_id, e.amount, e.type]), [[ana, 22500, 'adjustment']], 'one balance forward for the family, on the guarantor');
  assert.equal(out.reconcile.ar.matches, true);
});

test('conversions: admin only, validation, cancel removes the staged copy', async () => {
  const { api } = await h.practice();
  assert.equal((await api.post('/imports/convert', { source: 'softdent', files: [{ name: 'a.csv', headers: ['x'] }] })).status, 400);
  assert.equal((await api.post('/imports/convert', { source: 'dentrix', files: [{ name: 'Notes.csv', headers: ['Chart #', 'Note'] }] })).status, 400, 'no patient list');
  const sources = (await api.get('/imports/convert/sources')).data;
  assert.deepEqual(sources.sources.map((s) => s.id), ['dentrix', 'eaglesoft', 'curve']);
  assert.ok(sources.sources.every((s) => s.howTo.length >= 3));
  const batch = await upload(api, 'dentrix', { 'Patients.csv': DENTRIX['Patients.csv'] });
  // Rows for a file the plan didn't read as that table are refused.
  assert.equal((await api.post(`/imports/convert/${batch.id}/rows`, { file: 'Patients.csv', table: 'procedures', headers: ['Chart #', 'ADA Code'], rows: [['OBR001', 'D0120']] })).status, 400);
  assert.equal((await api.post(`/imports/convert/${batch.id}/rows`, { file: 'Other.csv', table: 'patients', headers: ['Chart #'], rows: [] })).status, 400);
  // A front-desk user can't import.
  const email = `front${Date.now()}@example.com`;
  assert.equal((await api.post('/users', { name: 'Front', email, password: 'correct-horse-battery', role: 'front_desk' })).status, 201);
  const login = await h.client().post('/auth/login', { email, password: 'correct-horse-battery' });
  assert.equal((await h.client(login.data.token).post(`/imports/convert/${batch.id}/check`, {})).status, 403);
  assert.ok((await h.db.get('SELECT COUNT(*) AS n FROM conversion_rows WHERE batch_id = ?', batch.id)).n > 0);
  assert.equal((await api.post(`/imports/convert/${batch.id}/cancel`)).status, 200);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM conversion_rows WHERE batch_id = ?', batch.id)).n, 0);
  assert.equal((await api.post(`/imports/convert/${batch.id}/check`, {})).status, 409);
});
