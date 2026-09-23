import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { createDumpReader, parseValues } from '../../client/src/conversion/sqldump.js';

const h = harness();

// A small Open Dental backup, the way mysqldump writes it: table definitions, then one INSERT line per table
// without column names. A family of two (Maria is the guarantor), one insurance plan, history and plans.
const DUMP = `-- MySQL dump 10.13
DROP TABLE IF EXISTS \`adjustment\`;
CREATE TABLE \`adjustment\` (
  \`AdjNum\` bigint(20) NOT NULL AUTO_INCREMENT,
  \`AdjDate\` date NOT NULL,
  \`AdjAmt\` double NOT NULL,
  \`PatNum\` bigint(20) NOT NULL,
  \`AdjType\` bigint(20) NOT NULL,
  \`ProvNum\` bigint(20) NOT NULL,
  \`AdjNote\` text,
  PRIMARY KEY (\`AdjNum\`)
) ENGINE=MyISAM;
INSERT INTO \`adjustment\` VALUES (1,'2025-03-02',-15,10,201,1,'Senior discount');
CREATE TABLE \`appointment\` (
  \`AptNum\` bigint(20) NOT NULL,
  \`PatNum\` bigint(20) NOT NULL,
  \`AptStatus\` tinyint(4) NOT NULL,
  \`Pattern\` varchar(255) NOT NULL,
  \`Op\` bigint(20) NOT NULL,
  \`Note\` text,
  \`ProvNum\` bigint(20) NOT NULL,
  \`ProvHyg\` bigint(20) NOT NULL,
  \`AptDateTime\` datetime NOT NULL,
  \`ProcDescript\` text,
  \`IsHygiene\` tinyint(4) NOT NULL
);
INSERT INTO \`appointment\` VALUES (500,10,2,'XXXXXXXX',7,'Pt was nervous',1,2,'2025-03-01 09:00:00','PerEx, Pro',1),(501,10,1,'XXXXXXXXXXXX',7,'',1,0,'2031-06-02 10:00:00','Crn',0),(502,11,6,'XX',7,'',1,0,'0001-01-01 00:00:00','',0);
CREATE TABLE \`carrier\` (
  \`CarrierNum\` bigint(20) NOT NULL,
  \`CarrierName\` varchar(255),
  \`ElectID\` varchar(255)
);
INSERT INTO \`carrier\` VALUES (30,'Delta Dental of Texas','94276');
CREATE TABLE \`claimproc\` (
  \`ClaimProcNum\` bigint(20) NOT NULL,
  \`PatNum\` bigint(20) NOT NULL,
  \`ProvNum\` bigint(20) NOT NULL,
  \`InsPayAmt\` double NOT NULL,
  \`WriteOff\` double NOT NULL,
  \`Status\` tinyint(4) NOT NULL,
  \`DateCP\` date NOT NULL
);
INSERT INTO \`claimproc\` VALUES (900,10,1,72,18,1,'2025-03-20'),(901,10,1,500,0,6,'2025-03-20');
CREATE TABLE \`commlog\` (
  \`CommlogNum\` bigint(20) NOT NULL,
  \`PatNum\` bigint(20) NOT NULL,
  \`CommDateTime\` datetime NOT NULL,
  \`Note\` text
);
INSERT INTO \`commlog\` VALUES (40,10,'2025-02-20 14:05:00','Called to confirm; left voicemail\\nWill call back');
CREATE TABLE \`definition\` (
  \`DefNum\` bigint(20) NOT NULL,
  \`Category\` tinyint(4) NOT NULL,
  \`ItemName\` varchar(255)
);
INSERT INTO \`definition\` VALUES (101,10,'Check'),(102,10,'Credit Card'),(201,1,'Senior Discount');
CREATE TABLE \`inssub\` (
  \`InsSubNum\` bigint(20) NOT NULL,
  \`PlanNum\` bigint(20) NOT NULL,
  \`Subscriber\` bigint(20) NOT NULL,
  \`SubscriberID\` varchar(255)
);
INSERT INTO \`inssub\` VALUES (60,50,10,'DDX99812');
CREATE TABLE \`insplan\` (
  \`PlanNum\` bigint(20) NOT NULL,
  \`GroupName\` varchar(255),
  \`GroupNum\` varchar(255),
  \`CarrierNum\` bigint(20) NOT NULL
);
INSERT INTO \`insplan\` VALUES (50,'City of Austin','G-4411',30);
CREATE TABLE \`operatory\` (
  \`OperatoryNum\` bigint(20) NOT NULL,
  \`OpName\` varchar(255),
  \`Abbrev\` varchar(255),
  \`IsHidden\` tinyint(4) NOT NULL
);
INSERT INTO \`operatory\` VALUES (7,'Hygiene 2','H2',0);
CREATE TABLE \`patient\` (
  \`PatNum\` bigint(20) NOT NULL,
  \`LName\` varchar(100),
  \`FName\` varchar(100),
  \`Preferred\` varchar(100),
  \`PatStatus\` tinyint(4) NOT NULL,
  \`Gender\` tinyint(4) NOT NULL,
  \`Birthdate\` date NOT NULL,
  \`Address\` varchar(100),
  \`Address2\` varchar(100),
  \`City\` varchar(100),
  \`State\` varchar(100),
  \`Zip\` varchar(100),
  \`HmPhone\` varchar(30),
  \`WkPhone\` varchar(30),
  \`WirelessPhone\` varchar(30),
  \`Guarantor\` bigint(20) NOT NULL,
  \`Email\` varchar(100),
  \`PriProv\` bigint(20) NOT NULL,
  \`SecProv\` bigint(20) NOT NULL,
  \`MedUrgNote\` text,
  \`BalTotal\` double NOT NULL
);
INSERT INTO \`patient\` VALUES (10,'O\\'Brien','Maria','',0,1,'1970-04-02','12 Oak St','','Austin','TX','78704','512-555-0133','','512-555-0199',10,'maria@example.com',1,2,'Latex allergy',210),(11,'O\\'Brien','Sam','Sammy',0,0,'2015-08-09','12 Oak St','','Austin','TX','78704','512-555-0133','','',10,'',1,2,'',0),(12,'Gone','Old','',4,0,'1950-01-01','','','','','','','','',12,'',1,0,'',0);
CREATE TABLE \`patplan\` (
  \`PatPlanNum\` bigint(20) NOT NULL,
  \`PatNum\` bigint(20) NOT NULL,
  \`Ordinal\` tinyint(4) NOT NULL,
  \`Relationship\` tinyint(4) NOT NULL,
  \`InsSubNum\` bigint(20) NOT NULL
);
INSERT INTO \`patplan\` VALUES (70,10,1,0,60),(71,11,1,2,60);
CREATE TABLE \`payment\` (
  \`PayNum\` bigint(20) NOT NULL,
  \`PayType\` bigint(20) NOT NULL,
  \`PayDate\` date NOT NULL,
  \`PayAmt\` double NOT NULL,
  \`CheckNum\` varchar(25),
  \`PatNum\` bigint(20) NOT NULL
);
INSERT INTO \`payment\` VALUES (80,101,'2025-03-01',25,'1042',10);
CREATE TABLE \`paysplit\` (
  \`SplitNum\` bigint(20) NOT NULL,
  \`SplitAmt\` double NOT NULL,
  \`PatNum\` bigint(20) NOT NULL,
  \`PayNum\` bigint(20) NOT NULL,
  \`ProvNum\` bigint(20) NOT NULL,
  \`DatePay\` date NOT NULL
);
INSERT INTO \`paysplit\` VALUES (81,25,10,80,1,'2025-03-01');
CREATE TABLE \`perioexam\` (
  \`PerioExamNum\` bigint(20) NOT NULL,
  \`PatNum\` bigint(20) NOT NULL,
  \`ExamDate\` date NOT NULL,
  \`ProvNum\` bigint(20) NOT NULL
);
INSERT INTO \`perioexam\` VALUES (20,10,'2025-03-01',2);
CREATE TABLE \`periomeasure\` (
  \`PerioMeasureNum\` bigint(20) NOT NULL,
  \`PerioExamNum\` bigint(20) NOT NULL,
  \`SequenceType\` tinyint(4) NOT NULL,
  \`IntTooth\` tinyint(4) NOT NULL,
  \`ToothValue\` smallint(6) NOT NULL,
  \`MBvalue\` smallint(6) NOT NULL,
  \`Bvalue\` smallint(6) NOT NULL,
  \`DBvalue\` smallint(6) NOT NULL,
  \`MLvalue\` smallint(6) NOT NULL,
  \`Lvalue\` smallint(6) NOT NULL,
  \`DLvalue\` smallint(6) NOT NULL
);
INSERT INTO \`periomeasure\` VALUES (1,20,4,3,-1,3,2,5,4,3,3),(2,20,6,3,-1,1,0,0,0,0,1),(3,20,5,1,1,-1,-1,-1,-1,-1,-1);
CREATE TABLE \`procedurecode\` (
  \`CodeNum\` bigint(20) NOT NULL,
  \`ProcCode\` varchar(15),
  \`Descript\` varchar(255)
);
INSERT INTO \`procedurecode\` VALUES (1,'D0120','periodic oral evaluation'),(2,'D1110','prophylaxis - adult'),(3,'D2740','crown - porcelain/ceramic');
CREATE TABLE \`procedurelog\` (
  \`ProcNum\` bigint(20) NOT NULL,
  \`PatNum\` bigint(20) NOT NULL,
  \`AptNum\` bigint(20) NOT NULL,
  \`ProcDate\` date NOT NULL,
  \`ProcFee\` double NOT NULL,
  \`Surf\` varchar(10),
  \`ToothNum\` varchar(2),
  \`ProcStatus\` tinyint(4) NOT NULL,
  \`ProvNum\` bigint(20) NOT NULL,
  \`CodeNum\` bigint(20) NOT NULL,
  \`UnitQty\` int(11) NOT NULL
);
INSERT INTO \`procedurelog\` VALUES (600,10,500,'2025-03-01',60,'','',2,1,1,1),(601,10,500,'2025-03-01',120,'','',2,2,2,1),(602,10,501,'2031-06-02',1200,'','30',1,1,3,1),(603,10,0,'2019-05-01',0,'','3',4,1,3,1),(604,10,0,'2025-01-01',99,'','',6,1,1,1);
CREATE TABLE \`procnote\` (
  \`ProcNoteNum\` bigint(20) NOT NULL,
  \`PatNum\` bigint(20) NOT NULL,
  \`ProcNum\` bigint(20) NOT NULL,
  \`EntryDateTime\` datetime NOT NULL,
  \`Note\` text
);
INSERT INTO \`procnote\` VALUES (700,10,600,'2025-03-01 09:40:00','First draft'),(701,10,600,'2025-03-01 09:45:00','Exam WNL. Recommend crown #30.');
CREATE TABLE \`provider\` (
  \`ProvNum\` bigint(20) NOT NULL,
  \`Abbr\` varchar(255),
  \`LName\` varchar(100),
  \`FName\` varchar(100),
  \`Suffix\` varchar(100),
  \`IsSecondary\` tinyint(4) NOT NULL,
  \`IsHidden\` tinyint(4) NOT NULL,
  \`NationalProvID\` varchar(255)
);
INSERT INTO \`provider\` VALUES (1,'DOC1','Chen','Alex','DDS',0,0,'1234567893'),(2,'HYG1','Okafor','Sam','RDH',1,0,'');
CREATE TABLE \`recall\` (
  \`RecallNum\` bigint(20) NOT NULL,
  \`PatNum\` bigint(20) NOT NULL,
  \`DateDue\` date NOT NULL,
  \`RecallInterval\` int(11) NOT NULL,
  \`RecallTypeNum\` bigint(20) NOT NULL,
  \`IsDisabled\` tinyint(4) NOT NULL
);
INSERT INTO \`recall\` VALUES (800,10,'2025-09-01',393216,1,0);
CREATE TABLE \`recalltype\` (
  \`RecallTypeNum\` bigint(20) NOT NULL,
  \`Description\` varchar(255)
);
INSERT INTO \`recalltype\` VALUES (1,'Prophy');
CREATE TABLE \`securitylog\` (\`SecurityLogNum\` bigint(20) NOT NULL);
INSERT INTO \`securitylog\` VALUES (1),(2);
`;

test('reading a MySQL dump: escapes, NULLs, numbers, split across chunks', () => {
  assert.deepEqual(parseValues("(1,'O\\'Brien',NULL,-2.50,'a''b','line\\nnext'),(2,'',0,'x',NULL,'');", 0), [[1, "O'Brien", null, -2.5, "a'b", 'line\nnext'], [2, '', 0, 'x', null, '']]);
  const got = {};
  const reader = createDumpReader(['patient', 'provider'], (t, rows) => { (got[t] ||= []).push(...rows); });
  // Fed in awkward pieces, as a browser reads a large file.
  for (let i = 0; i < DUMP.length; i += 37) reader.push(DUMP.slice(i, i + 37));
  reader.end();
  assert.deepEqual(Object.keys(got).sort(), ['patient', 'provider'], 'only the tables asked for');
  assert.equal(got.patient[0].lname, "O'Brien");
  assert.equal(got.patient[0].baltotal, 210);
  assert.equal(got.provider[1].issecondary, 1);
});

test('Open Dental conversion: the whole practice, with ledger history balanced to Open Dental, then undone', async () => {
  const { api } = await h.practice();
  const staged = {};
  const reader = createDumpReader(['definition', 'provider', 'operatory', 'patient', 'carrier', 'insplan', 'inssub', 'patplan', 'procedurecode', 'appointment', 'procedurelog', 'recalltype', 'recall', 'payment', 'paysplit', 'adjustment', 'claimproc', 'procnote', 'commlog', 'perioexam', 'periomeasure'], (t, rows) => { (staged[t] ||= []).push(...rows); });
  reader.push(DUMP);
  reader.end();

  const batch = (await api.post('/imports/opendental', { filename: 'opendental.sql' })).data;
  assert.equal((await api.post(`/imports/opendental/${batch.id}/rows`, { table: 'securitylog', rows: [{ a: 1 }] })).status, 400);
  for (const [table, rows] of Object.entries(staged)) assert.equal((await api.post(`/imports/opendental/${batch.id}/rows`, { table, rows })).status, 200);
  let out;
  for (let i = 0; i < 20; i++) {
    out = (await api.post(`/imports/opendental/${batch.id}/run`, { budget_ms: 50 })).data;
    if (out.done) break;
  }
  assert.equal(out.done, true, JSON.stringify(out));
  assert.equal(out.counts.patients.skipped, 1, 'deleted patients are left behind');
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM conversion_rows WHERE batch_id = ?', batch.id)).n, 0, 'the staged rows are cleared');

  const pats = (await api.get('/patients?q=brien')).data;
  const list = Array.isArray(pats) ? pats : pats.patients || pats.rows;
  const maria = list.find((p) => p.first_name === 'Maria');
  const sam = list.find((p) => p.first_name === 'Sam');
  assert.equal(maria.last_name, "O'Brien");
  const full = (await api.get(`/patients/${sam.id}`)).data;
  assert.equal(full.guarantor_id, maria.id, 'the family comes across');
  assert.equal(full.preferred_name, 'Sammy');

  // Providers and the chair, matched by name.
  const provs = (await api.get('/providers')).data;
  assert.ok(provs.some((p) => p.name === 'Alex Chen, DDS' && p.npi === '1234567893'));
  assert.ok(provs.some((p) => p.name === 'Sam Okafor, RDH' && p.type === 'hygienist'));

  // Insurance for both, Sam as a child on Maria's plan.
  const ins = await h.db.all('SELECT pi.relationship, pi.subscriber_id, pi.subscriber_name, c.name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id WHERE pi.patient_id IN (?, ?) ORDER BY pi.patient_id', maria.id, sam.id);
  assert.deepEqual(ins.map((i) => [i.name, i.relationship, i.subscriber_id, i.subscriber_name]), [['Delta Dental of Texas', 'self', 'DDX99812', "Maria O'Brien"], ['Delta Dental of Texas', 'child', 'DDX99812', "Maria O'Brien"]]);

  // Appointments: the completed hygiene visit (with the hygienist, in Hygiene 2) and the future crown; planned-list rows are left.
  const appts = await h.db.all('SELECT a.status, a.start_time, a.end_time, pv.name AS prov, o.name AS op FROM appointments a JOIN providers pv ON pv.id = a.provider_id LEFT JOIN operatories o ON o.id = a.operatory_id WHERE a.patient_id = ? ORDER BY a.start_time', maria.id);
  assert.deepEqual(appts.map((a) => [a.status, a.start_time, a.end_time, a.prov, a.op]), [
    ['completed', '2025-03-01 09:00', '2025-03-01 09:40', 'Sam Okafor, RDH', 'Hygiene 2'],
    ['scheduled', '2031-06-02 10:00', '2031-06-02 11:00', 'Alex Chen, DDS', 'Hygiene 2'],
  ]);

  // Work: two completed, the crown planned on the future visit, the crown done elsewhere as history; deleted left out.
  const procs = await h.db.all('SELECT code, status, tooth, fee, appointment_id IS NOT NULL AS on_visit FROM procedures WHERE patient_id = ? ORDER BY id', maria.id);
  assert.deepEqual(procs.map((p) => [p.code, p.status, p.tooth, p.fee, Number(p.on_visit)]), [
    ['D0120', 'completed', null, 6000, 0], ['D1110', 'completed', null, 12000, 0], ['D2740', 'planned', '30', 120000, 1], ['D2740', 'completed', '3', 0, 0],
  ]);

  // Ledger: charges, the check, the discount, the insurance payment and write-off, then one entry bringing the family to Open Dental's $210.
  const ledger = await h.db.all('SELECT type, amount, method, adjustment_type FROM ledger_entries WHERE patient_id IN (?, ?) ORDER BY id', maria.id, sam.id);
  assert.deepEqual(ledger.map((l) => [l.type, l.amount]), [['charge', 6000], ['charge', 12000], ['payment', -2500], ['adjustment', -1500], ['insurance_payment', -7200], ['adjustment', -1800], ['adjustment', 16000]]);
  assert.equal(ledger[2].method, 'check');
  assert.equal(ledger[3].adjustment_type, 'Senior Discount');
  const family = (await h.db.get('SELECT SUM(amount) AS n FROM ledger_entries WHERE patient_id IN (?, ?)', maria.id, sam.id)).n;
  assert.equal(family, 21000);

  // The latest version of the note, signed; the call log; the perio exam in our site order; the recall every 6 months.
  const notes = await h.db.all('SELECT body, signed FROM clinical_notes WHERE patient_id = ?', maria.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /^D0120 periodic oral evaluation\nExam WNL\. Recommend crown #30\./);
  assert.equal(notes[0].signed, 1);
  assert.match((await h.db.get('SELECT note FROM followups WHERE patient_id = ?', maria.id)).note, /left voicemail\nWill call back/);
  const perio = JSON.parse((await h.db.get('SELECT readings FROM perio_exams WHERE patient_id = ?', maria.id)).readings);
  assert.deepEqual(perio['3'].pd, [5, 2, 3, 3, 3, 4]);
  assert.deepEqual(perio['3'].bop, [false, false, true, true, false, false]);
  assert.equal(perio['1'].missing, true);
  const recall = await h.db.get('SELECT type, interval_months, due_date FROM recalls WHERE patient_id = ?', maria.id);
  assert.deepEqual([recall.type, recall.interval_months, recall.due_date], ['prophy', 6, '2025-09-01']);

  // Undo takes it all back out.
  const undo = await api.post(`/imports/${batch.id}/undo`);
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM patients WHERE id IN (?, ?)', maria.id, sam.id)).n, 0);
});

test('Dentrix payment history and clinical notes from CSV exports', async () => {
  const { api } = await h.practice();
  const run = async (kind, csv) => {
    const [headers, ...rows] = csv.trim().split('\n').map((l) => l.split(','));
    const b = (await api.post('/imports', { kind, source: 'dentrix', headers, filename: `${kind}.csv` })).data;
    const out = (await api.post(`/imports/${b.id}/rows`, { rows, offset: 0 })).data;
    await api.post(`/imports/${b.id}/finish`);
    return out;
  };
  await run('patients', 'Chart Number,First Name,Last Name,Birthdate\nDX100,Lena,Park,1988-01-20');
  const pay = await run('payments', 'Chart Number,Date,Type,Payment Type,Amount,Check Number\nDX100,01/05/2026,Payment,Visa,150.00,\nDX100,01/06/2026,Insurance Payment,Check,82.40,5541\nDX100,01/07/2026,Adjustment - Courtesy,,-20.00,\nDX100,01/06/2026,Insurance Payment,Check,82.40,5541');
  assert.deepEqual([pay.created, pay.skipped, pay.errors.length], [3, 1, 0], 'the same payment twice comes in once');
  const notes = await run('notes', 'Chart Number,Note Date,Note\nDX100,01/05/2026 10:15 AM,Comp #3 MO. Pt tolerated well.');
  assert.equal(notes.created, 1);
  const lena = (await h.db.get("SELECT id FROM patients WHERE first_name = 'Lena'")).id;
  const ledger = await h.db.all('SELECT type, amount, method, reference FROM ledger_entries WHERE patient_id = ? ORDER BY entry_date, id', lena);
  assert.deepEqual(ledger.map((l) => [l.type, l.amount, l.method]), [['payment', -15000, 'credit_card'], ['insurance_payment', -8240, 'check'], ['adjustment', -2000, null]]);
  const note = await h.db.get('SELECT body, signed, created_at FROM clinical_notes WHERE patient_id = ?', lena);
  assert.match(note.body, /^Comp #3 MO\. Pt tolerated well\.\n\n\(From Dentrix\)$/);
  assert.equal(note.signed, 1);
  assert.match(String(note.created_at), /^2026-01-05 10:15/);
});
