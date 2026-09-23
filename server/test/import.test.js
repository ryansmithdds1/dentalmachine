import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { parseCsv } from '../src/routes/charting.js';
import { detectMapping, parseDate, parseMoney, parseTime } from '../src/importer.js';

const h = harness();

// Sends a CSV through the same steps the browser does: preview, start, rows in chunks, finish.
async function runImport(api, source, kind, csv, { chunk = 2, mapping } = {}) {
  const [headers, ...rows] = parseCsv(csv);
  const preview = (await api.post('/imports/preview', { source, kind, headers, rows, mapping })).data;
  const start = await api.post('/imports', { source, kind, headers, filename: `${kind}.csv`, total: rows.length, mapping });
  assert.equal(start.status, 201, JSON.stringify(start.data));
  for (let i = 0; i < rows.length; i += chunk) {
    const r = await api.post(`/imports/${start.data.id}/rows`, { rows: rows.slice(i, i + chunk), offset: i });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const done = (await api.post(`/imports/${start.data.id}/finish`)).data;
  return { preview, batch: done };
}

const OD_PATIENTS = `PatNum,LName,FName,Preferred,Birthdate,Gender,WirelessPhone,HmPhone,Email,Address,Address2,City,State,Zip,PatStatus,Guarantor,PriProv,MedUrgNote,EstBalance
101,Garcia,Maria,,1979-03-14,1,(512) 555-2001,,maria@example.com,12 Oak St,Apt 4,Austin,TX,78701,0,101,ALee,Latex allergy,125.50
102,Garcia,Tomas,Tommy,2012-07-01,0,,512-555-2002,,12 Oak St,,Austin,TX,78701,0,101,,,0
103,Nguyen,Linh,,0001-01-01,1,5125552003,,,,,,,,2,103,,,(20.00)
104,Deleted,Person,,1990-01-01,0,,,,,,,,,5,104,,,0
105,,NoLast,,1990-01-01,0,,,,,,,,,0,105,,,0`;

test('parsers: dates, times, money, header detection', () => {
  assert.equal(parseDate('3/4/1979'), '1979-03-04');
  assert.equal(parseDate('2026-10-01 09:30:00'), '2026-10-01');
  assert.equal(parseDate('0001-01-01'), null);
  assert.equal(parseDate('12/31/85', { past: true }), '1985-12-31');
  assert.throws(() => parseDate('2/30/2020'));
  assert.equal(parseTime('9:30 AM'), '09:30');
  assert.equal(parseTime('12:15 pm'), '12:15');
  assert.equal(parseTime('2026-10-01 14:05:00'), '14:05');
  assert.equal(parseMoney('$1,234.50'), 123450);
  assert.equal(parseMoney('(20.00)'), -2000);
  assert.equal(parseMoney('15.00 CR'), -1500);
  const dentrix = detectMapping('patients', ['Chart #', 'Last Name', 'First Name', 'Birth Date', 'Phone', 'E-Mail', 'Guarantor ID']);
  assert.deepEqual(dentrix, { external_id: 0, last_name: 1, first_name: 2, dob: 3, phone: 4, email: 5, guarantor: 6 });
});

test('Open Dental conversion: patients, families, balances, insurance, appointments, recalls, treatment', async () => {
  const { api, provider } = await h.practice();
  await api.put(`/providers/${provider.id}`, { name: 'Ann Lee' });
  await api.post('/operatories', { name: 'Op 2' });

  const { preview, batch } = await runImport(api, 'opendental', 'patients', OD_PATIENTS);
  assert.deepEqual(preview.missing, []);
  assert.equal(preview.mapping.external_id, 0);
  assert.equal(preview.results.find((x) => x.line === 6).status, 'error'); // no last name
  assert.deepEqual(preview.results.slice(0, 4).map((x) => x.status), ['created', 'created', 'created', 'skipped']);
  assert.equal(batch.created_count, 3);
  assert.equal(batch.skipped_count, 1); // deleted in Open Dental
  assert.equal(batch.error_count, 1);
  assert.equal(batch.errors[0].line, 6);

  const list = (await api.get('/patients?q=Garcia')).data.rows;
  const maria = list.find((p) => p.first_name === 'Maria');
  const tomas = list.find((p) => p.first_name === 'Tomas');
  const mariaFull = (await api.get(`/patients/${maria.id}`)).data;
  assert.equal(mariaFull.dob, '1979-03-14');
  assert.equal(mariaFull.gender, 'female');
  assert.equal(mariaFull.phone, '(512) 555-2001');
  assert.equal(mariaFull.address, '12 Oak St, Apt 4');
  assert.equal(mariaFull.primary_provider_id, provider.id);
  assert.equal(mariaFull.medical_alerts, 'Latex allergy');
  assert.equal(mariaFull.balance, 12550);
  const tomasFull = (await api.get(`/patients/${tomas.id}`)).data;
  assert.equal(tomasFull.guarantor_id, maria.id);
  assert.equal(tomasFull.preferred_name, 'Tommy');
  assert.equal(tomasFull.phone_home, '512-555-2002');
  const linh = (await api.get('/patients?q=Nguyen&status=all')).data.rows[0];
  assert.equal(linh.status, 'inactive');
  assert.equal(linh.dob, null);

  // Re-running the same file updates instead of duplicating, and the balance forward isn't doubled.
  const again = await runImport(api, 'opendental', 'patients', OD_PATIENTS.replace('Latex allergy', 'Latex'));
  assert.equal(again.batch.created_count, 0);
  assert.equal(again.batch.updated_count, 3);
  assert.equal((await api.get('/patients?q=Garcia')).data.rows.length, 2);
  const m2 = (await api.get(`/patients/${maria.id}`)).data;
  assert.equal(m2.medical_alerts, 'Latex');
  assert.equal(m2.balance, 12550);

  const ins = await runImport(api, 'opendental', 'insurance', `PatNum,CarrierName,ElectID,GroupNum,GroupName,SubscriberID,Relationship,Ordinal,AnnualMax,Deductible
101,Delta Dental of Texas,94276,G-100,Acme Corp,DD123,0,1,1500,50
102,Delta Dental of Texas,94276,G-100,Acme Corp,DD123,2,1,1500,50
999,Nobody,,,,X1,0,1,,`);
  assert.equal(ins.batch.created_count, 2);
  assert.equal(ins.batch.error_count, 1);
  assert.match(ins.batch.errors[0].error, /import the patient file first/);
  const pol = (await api.get(`/patients/${tomas.id}/insurance`)).data[0];
  assert.equal(pol.carrier_name, 'Delta Dental of Texas');
  assert.equal(pol.relationship, 'child');
  assert.equal(pol.subscriber_name, 'Unknown subscriber');
  assert.equal(pol.annual_max, 150000);
  const polMaria = (await api.get(`/patients/${maria.id}/insurance`)).data[0];
  assert.equal(polMaria.subscriber_name, 'Maria Garcia');
  assert.equal(polMaria.plan_id, pol.plan_id); // same carrier + group = one shared plan

  const appts = await runImport(api, 'opendental', 'appointments', `AptNum,PatNum,AptDateTime,Pattern,ProvNum,Op,AptStatus,ProcDescript,Note
5001,101,2030-02-03 09:00:00,XXXXXXXXXXXX,ALee,Op 2,1,"PerEx, Pro",Prefers mornings
5002,102,2020-01-02 13:30:00,//XXXX//,,,2,Pro,
5003,101,2030-02-04 10:00:00,XXXXXX,,,3,Unscheduled,`);
  assert.equal(appts.batch.created_count, 2);
  assert.equal(appts.batch.skipped_count, 1);
  const future = (await api.get('/appointments?from=2030-02-03&to=2030-02-04')).data;
  const a = future.find((x) => x.patient_id === maria.id);
  assert.equal(a.start_time, '2030-02-03 09:00');
  assert.equal(a.end_time, '2030-02-03 10:00');
  assert.equal(a.provider_id, provider.id);
  assert.equal(a.reason, 'PerEx, Pro');

  const recalls = await runImport(api, 'opendental', 'recalls', `PatNum,RecallType,RecallInterval,DateDue
101,Prophy,393216,2030-03-01
102,Perio,3m,2030-01-15`);
  assert.equal(recalls.batch.created_count, 2);
  const rc = (await api.get(`/patients/${maria.id}`)).data.recalls[0];
  assert.deepEqual([rc.type, rc.interval_months, rc.due_date], ['prophy', 6, '2030-03-01']);

  const tx = await runImport(api, 'opendental', 'treatment', `PatNum,ProcCode,ToothNum,Surf,ProcFee,ProcStatus,ProcDate,ProvNum
101,D2392,30,MO,185.00,1,2026-01-10,ALee
101,D0120,,,55,2,2025-06-01,ALee
101,D9999X,,,0,1,,
102,D1120,,,70,6,2025-06-01,`);
  assert.equal(tx.batch.created_count, 3);
  assert.equal(tx.batch.skipped_count, 1); // deleted procedure
  const procs = (await api.get(`/patients/${maria.id}/procedures`)).data;
  const planned = procs.find((p) => p.code === 'D2392');
  assert.equal(planned.status, 'planned');
  assert.equal(planned.fee, 18500);
  assert.equal(planned.surfaces, 'MO');
  assert.ok(planned.treatment_plan_id);
  const done = procs.find((p) => p.code === 'D0120');
  assert.equal(done.status, 'completed');
  assert.equal(done.completed_at.slice(0, 10), '2025-06-01');
  // Imported history doesn't add charges: the balance is still the balance forward.
  assert.equal((await api.get(`/patients/${maria.id}`)).data.balance, 12550);

  const history = (await api.get('/imports')).data;
  assert.equal(history.length, 6);
  assert.ok(history.every((b) => b.status === 'done'));
});

test('undo removes what an import created, and refuses once records are in use', async () => {
  const { api, provider } = await h.practice();
  const csv = `Chart #,Last Name,First Name,Birth Date,Phone,Balance
A1,Stone,Riley,04/05/1990,555-3001,$40.00
A2,Stone,Casey,11/12/1992,555-3002,`;
  const { batch } = await runImport(api, 'dentrix', 'patients', csv);
  assert.equal(batch.created_count, 2);
  let rows = (await api.get('/patients?q=Stone')).data.rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.find((p) => p.first_name === 'Riley').phone, '555-3001');

  const undo = await api.post(`/imports/${batch.id}/undo`);
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  assert.equal(undo.data.removed.patients, 2);
  assert.equal(undo.data.removed.balances, 1);
  assert.equal((await api.get('/patients?q=Stone')).data.rows.length, 0);
  assert.equal((await api.post(`/imports/${batch.id}/undo`)).status, 409);

  const second = (await runImport(api, 'dentrix', 'patients', csv)).batch;
  rows = (await api.get('/patients?q=Stone')).data.rows;
  await api.post('/appointments', { patient_id: rows[0].id, provider_id: provider.id, start_time: '2030-05-01 09:00', end_time: '2030-05-01 10:00' });
  const refused = await api.post(`/imports/${second.id}/undo`);
  assert.equal(refused.status, 409);
  assert.equal((await api.get('/patients?q=Stone')).data.rows.length, 2);
});

test('imports need an admin and a column for each required field', async () => {
  const { api } = await h.practice();
  const bad = await api.post('/imports', { source: 'curve', kind: 'patients', headers: ['Name', 'Phone'] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /first_name/);
  const mapped = await api.post('/imports/preview', { source: 'curve', kind: 'patients', headers: ['Given', 'Family'], rows: [['Al', 'Bee']], mapping: { first_name: 0, last_name: 1 } });
  assert.deepEqual(mapped.data.missing, []);
  assert.equal(mapped.data.results[0].status, 'created');
  assert.equal((await api.get('/patients?q=Bee')).data.rows.length, 0); // preview saves nothing
  assert.equal((await api.post('/imports/preview', { source: 'curve', kind: 'patients', headers: ['A'], rows: [], mapping: { first_name: 5 } })).status, 400);
  await api.post('/users', { name: 'Front', email: `fd${Date.now()}@example.com`, password: 'correct-horse-battery', role: 'front_desk' });
  const fd = await h.client().post('/auth/login', { email: (await api.get('/users')).data.find((u) => u.role === 'front_desk').email, password: 'correct-horse-battery' });
  const fdApi = h.client(fd.data.token);
  assert.equal((await fdApi.get('/imports')).status, 403);
});
