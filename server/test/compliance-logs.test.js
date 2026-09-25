import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

// Complaint & incident log, staff exposure log (OSHA) and the HIPAA accounting of disclosures
// (README.md, “Compliance log”): permissions, practice isolation, audit, no hard deletes.
const h = harness();

const staff = async (api, role, tag) => {
  const email = `${role}-${tag}-${Date.now()}@example.com`;
  const u = (await api.post('/users', { email, name: `${role} ${tag}`, role, password: 'correct-horse-battery' })).data;
  return { api: h.client((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token), id: u.id ?? u.user?.id };
};

test('complaints and incidents: anyone records one, the follow-up becomes a task, resolved or voided — never deleted', async () => {
  const { api, patient } = await h.practice({ timezone: 'UTC' });
  const me = (await api.get('/auth/me')).data.user;
  const desk = await staff(api, 'front_desk', 'inc');
  assert.equal((await desk.api.post('/incidents', {})).status, 400);
  assert.equal((await desk.api.post('/incidents', { summary: 'x', severity: 'catastrophic' })).status, 400);
  assert.equal((await desk.api.post('/incidents', { summary: 'x', occurred_at: '2999-01-01 10:00' })).status, 400);
  const made = await desk.api.post('/incidents', { summary: 'Upset about the wait time', patient_id: patient.id, severity: 'medium', follow_up_user_id: me.id, follow_up_due: '2030-01-10', people: 'Mrs Doe' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const inc = made.data;
  assert.equal(inc.kind, 'complaint');
  assert.equal(inc.status, 'open');
  assert.ok(inc.task_id, 'follow-up made a task');
  const tasks = (await api.get('/tasks')).data;
  const task = (tasks.tasks || tasks).find((t) => t.id === inc.task_id);
  assert.equal(task.assigned_to, me.id);
  assert.equal(task.due_date, '2030-01-10');
  assert.match(task.title, /Upset about the wait time/);

  // The front desk sees what they reported; another staff member sees nothing; the manager sees everything.
  const other = await staff(api, 'hygienist', 'inc');
  assert.equal((await desk.api.get('/incidents')).data.rows.length, 1);
  assert.equal((await other.api.get('/incidents')).data.rows.length, 0);
  assert.equal((await other.api.post(`/incidents/${inc.id}/resolve`, { resolution: 'x' })).status, 404);
  assert.equal((await api.get('/incidents')).data.manager, true);
  // Corrections keep before → after.
  assert.equal((await desk.api.put(`/incidents/${inc.id}`, { severity: 'high' })).data.severity, 'high');
  const change = (await api.get('/audit-log?limit=30')).data.find((e) => e.action === 'incident.change');
  assert.deepEqual(JSON.parse(change.changes).severity, ['medium', 'high']);
  // Report and CSV are for managers.
  assert.equal((await desk.api.get('/incidents/report')).status, 403);
  const report = (await api.get('/incidents/report')).data;
  assert.equal(report.total, 1);
  assert.equal(report.by_severity.high, 1);
  assert.match((await api.get('/incidents/report?format=csv')).data, /Upset about the wait time/);

  // Resolved with what was done; the task closes with it.
  assert.equal((await desk.api.post(`/incidents/${inc.id}/resolve`, {})).status, 400);
  const res = (await desk.api.post(`/incidents/${inc.id}/resolve`, { resolution: 'Called and apologised; waived the fee' })).data;
  assert.equal(res.status, 'resolved');
  assert.equal(res.task_status, 'done');
  assert.equal((await desk.api.put(`/incidents/${inc.id}`, { severity: 'low' })).status, 409);
  // Voiding is for managers and keeps the row.
  const oops = (await desk.api.post('/incidents', { summary: 'Entered by mistake', kind: 'incident' })).data;
  assert.equal((await desk.api.post(`/incidents/${oops.id}/void`, { reason: 'dup' })).status, 403);
  assert.equal((await api.post(`/incidents/${oops.id}/void`, {})).status, 400);
  assert.equal((await api.post(`/incidents/${oops.id}/void`, { reason: 'Duplicate' })).data.status, 'voided');
  assert.equal((await api.get('/incidents?status=all')).data.rows.length, 2, 'nothing deleted');
  assert.equal((await api.del(`/incidents/${oops.id}`)).status, 404, 'no delete route');
  const actions = (await api.get('/audit-log?limit=50')).data.map((e) => e.action);
  for (const a of ['incident.create', 'incident.resolve', 'incident.void']) assert.ok(actions.includes(a), a);

  // Another practice can't see or touch it, or pin it on its own patient.
  const b = await h.practice();
  assert.equal((await b.api.get('/incidents?status=all')).data.rows.length, 0);
  assert.equal((await b.api.post(`/incidents/${inc.id}/reopen`)).status, 404);
  assert.equal((await b.api.post('/incidents', { summary: 'x', patient_id: patient.id })).status, 404);
});

test('exposure incidents: confidential (their own permission), checklist dated, sharps log export without names', async () => {
  const { api, patient } = await h.practice({ timezone: 'UTC' });
  const hyg = await staff(api, 'hygienist', 'exp');
  const desk = await staff(api, 'front_desk', 'exp');
  assert.equal((await desk.api.get('/exposures')).status, 403);
  assert.equal((await desk.api.post('/exposures', { description: 'x' })).status, 403);
  assert.equal((await api.post('/exposures', { employee_user_id: hyg.id })).status, 400, 'how it happened is required');
  const x = await api.post('/exposures', {
    employee_user_id: hyg.id, description: 'Stuck with a used scaler while cleaning instruments', device: 'Hu-Friedy H6/H7 scaler', procedure_name: 'Instrument processing',
    work_area: 'Sterilization', body_part: 'Left index finger', source_patient_id: patient.id, immediate_actions: 'Washed with soap and water',
  });
  assert.equal(x.status, 201, JSON.stringify(x.data));
  assert.equal(x.data.employee_name, 'hygienist exp');
  assert.ok(x.data.followup.reported, 'reporting it is the first step, done now');
  assert.equal(x.data.steps.length, 9);
  const upd = await api.put(`/exposures/${x.data.id}`, { followup: { washed: '2026-01-02', evaluated: '2026-01-02', bogus: '2026-01-02' } });
  assert.equal(upd.data.followup.washed, '2026-01-02');
  assert.ok(!('bogus' in upd.data.followup));
  assert.equal((await api.put(`/exposures/${x.data.id}`, { followup: { washed: 'yesterday' } })).status, 400);
  const csv = (await api.get('/exposures/export.csv')).data;
  assert.match(csv, /Hu-Friedy H6\/H7 scaler/);
  assert.doesNotMatch(csv, /hygienist exp/, 'the sharps log keeps the employee anonymous');
  assert.match((await api.get('/exposures/export.csv?names=1')).data, /hygienist exp/);
  // The audit trail names the record, not the medical details.
  const created = (await api.get('/audit-log?limit=30')).data.find((e) => e.action === 'exposure.create');
  assert.doesNotMatch(created.details, /scaler|finger/);
  assert.equal((await api.post(`/exposures/${x.data.id}/close`)).data.status, 'closed');
  assert.equal((await api.post(`/exposures/${x.data.id}/void`, { reason: 'Test entry' })).data.status, 'voided');
  assert.equal((await api.get('/exposures?status=all')).data.length, 1);
  const b = await h.practice();
  assert.equal((await b.api.put(`/exposures/${x.data.id}`, { device: 'x' })).status, 404);
  assert.equal((await b.api.get('/exposures')).data.length, 0);
});

test('HIPAA accounting of disclosures: recorded, auto-recorded by a record export to a third party, 6-year report', async () => {
  const { api, patient, token } = await h.practice({ timezone: 'UTC' });
  const desk = await staff(api, 'front_desk', 'disc');
  assert.equal((await desk.api.post(`/patients/${patient.id}/disclosures`, { recipient: 'Travis County Court', description: 'Records 2024-2026' })).status, 400, 'purpose required');
  assert.equal((await desk.api.post(`/patients/${patient.id}/disclosures`, { recipient: 'x', purpose: 'required_by_law', description: 'y', disclosed_on: '2999-01-01' })).status, 400);
  const d = await desk.api.post(`/patients/${patient.id}/disclosures`, { recipient: 'Travis County District Court', recipient_address: '1000 Guadalupe St, Austin TX', purpose: 'required_by_law', purpose_detail: 'Subpoena 24-1234', description: 'Treatment records and x-rays 2024–2026' });
  assert.equal(d.status, 201, JSON.stringify(d.data));
  // Seven years ago: outside the six-year accounting.
  const old = (await desk.api.post(`/patients/${patient.id}/disclosures`, { recipient: 'Old Insurer Audit', purpose: 'health_oversight', description: 'Chart copy', disclosed_on: `${new Date().getUTCFullYear() - 7}-01-15` })).data;
  assert.ok(old.id);
  // Exporting the record for someone else records the disclosure itself.
  const exp = await api.get(`/patients/${patient.id}/record-export?recipient=${encodeURIComponent('Texas State Board of Dental Examiners')}&purpose=health_oversight`);
  assert.equal(exp.status, 200);
  assert.equal((await api.get(`/patients/${patient.id}/record-export?recipient=x&purpose=treatment`)).status, 400, 'TPO is not an accountable purpose');
  const list = (await desk.api.get(`/patients/${patient.id}/disclosures`)).data;
  assert.equal(list.length, 3);
  assert.equal(list.find((x) => x.source === 'record_export').recipient, 'Texas State Board of Dental Examiners');

  // The patient's accounting (manager): PDF and CSV, six years back, voided entries left out, and it's audited.
  assert.equal((await desk.api.get(`/patients/${patient.id}/disclosures/accounting`)).status, 403);
  await api.post(`/disclosures/${list.find((x) => x.source === 'record_export').id}/void`, { reason: 'Sent to the board under a signed authorization' });
  const csv = (await api.get(`/patients/${patient.id}/disclosures/accounting?format=csv`)).data;
  assert.match(csv, /Travis County District Court/);
  assert.doesNotMatch(csv, /Old Insurer Audit/, 'older than six years');
  assert.doesNotMatch(csv, /State Board/, 'voided');
  const pdf = await fetch(`${h.origin}/api/patients/${patient.id}/disclosures/accounting`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal((await pdf.arrayBuffer()).byteLength > 500, true);
  const actions = (await api.get('/audit-log?limit=50')).data.map((e) => e.action);
  for (const a of ['disclosure.record', 'disclosure.void', 'disclosure.accounting', 'patient.record_export']) assert.ok(actions.includes(a), a);
  assert.equal((await desk.api.post(`/disclosures/${d.data.id}/void`, { reason: 'x' })).status, 403);

  // Practice isolation.
  const b = await h.practice();
  assert.equal((await b.api.get(`/patients/${patient.id}/disclosures`)).status, 404);
  assert.equal((await b.api.post(`/disclosures/${d.data.id}/void`, { reason: 'x' })).status, 404);
  assert.equal((await b.api.get('/disclosures')).data.rows.length, 0);
});
