import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

// Letters from templates and mailing labels (docs/documents.md, “Letters and mailing labels”).
const h = harness();

test('letters: starter templates, merge fields filled from the chart, unfilled fields block, filed on the chart, emailed', async () => {
  const { api, patient, token } = await h.practice({ timezone: 'UTC' });
  const templates = (await api.get('/letter-templates')).data;
  assert.ok(templates.length >= 5, 'a new office starts with the everyday letters');
  const welcome = templates.find((t) => t.name === 'Welcome to the practice');
  const appt = templates.find((t) => t.name === 'Appointment reminder');

  // Unknown merge fields are refused when saving; only admins change templates.
  assert.equal((await api.post('/letter-templates', { name: 'Bad', body: 'Hi {firstname}' })).status, 400);
  const custom = (await api.post('/letter-templates', { name: 'Thanks', subject: 'Thank you', body: 'Dear {first_name},\n\nThank you for visiting {practice}. Your balance is {balance}.' })).data;
  assert.ok(custom.id);

  const pre = (await api.post(`/patients/${patient.id}/letters/preview`, { template_id: welcome.id })).data;
  assert.match(pre.body, /^Dear Jane,/);
  assert.match(pre.body, /Practice \d+/);
  assert.deepEqual(pre.missing, []);
  // No visit booked: {next_appointment} has nothing to fill it, so it can't be printed or sent.
  const blocked = await api.post(`/patients/${patient.id}/letters`, { template_id: appt.id });
  assert.equal(blocked.status, 400);
  assert.deepEqual(blocked.data.details.missing.map((m) => m.field), ['next_appointment']);
  // A blank left for the office blocks too (the campaigns rule).
  const blank = await api.post(`/patients/${patient.id}/letters`, { template_id: welcome.id, body: 'Dear {first_name}, see you on [date].' });
  assert.equal(blank.status, 400);
  assert.ok(blank.data.details.placeholders.includes('[date]'));

  // Printed: the PDF is filed in the patient's documents (Letters) and can be opened again.
  const made = await api.post(`/patients/${patient.id}/letters`, { template_id: welcome.id });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const docs = (await api.get(`/patients/${patient.id}/documents`)).data;
  const doc = docs.find((d) => d.id === made.data.letter.document_id);
  assert.equal(doc.folder, 'Letters');
  const pdf = await fetch(`${h.origin}/api/letters/${made.data.letter.id}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

  // Emailed with the PDF attached; the letter keeps the exact words sent.
  const sent = h.sent.length;
  const mail = await api.post(`/patients/${patient.id}/letters`, { template_id: welcome.id, delivery: 'email' });
  assert.equal(mail.status, 201, JSON.stringify(mail.data));
  assert.equal(mail.data.message.status, 'sent');
  assert.equal(h.sent.length, sent + 1);
  assert.equal(h.sent.at(-1).attachments[0].type, 'application/pdf');
  const letters = (await api.get(`/patients/${patient.id}/letters`)).data;
  assert.equal(letters.length, 2);
  assert.match(letters[0].body, /Welcome to Practice/);
  const actions = (await api.get('/audit-log?limit=40')).data.map((e) => e.action);
  assert.ok(actions.includes('letter.create') && actions.includes('letter.print'));

  // The same letter for a list: those it can't be filled for are named, the rest printed in one PDF.
  const noBalance = (await api.post('/patients', { first_name: 'Nobal', last_name: 'Ance', dob: '1990-01-01' })).data;
  const batch = (await api.post('/letters/batch', { template_id: custom.id, patient_ids: [patient.id, noBalance.id] })).data;
  assert.equal(batch.made, 0, 'neither owes anything, so {balance} is empty for both');
  assert.equal(batch.skipped.length, 2);
  const batch2 = (await api.post('/letters/batch', { template_id: welcome.id, patient_ids: [patient.id, noBalance.id] })).data;
  assert.equal(batch2.made, 2);
  assert.ok(Buffer.from(batch2.pdf, 'base64').toString('latin1').startsWith('%PDF-'));

  // Practice isolation and permissions.
  const b = await h.practice();
  assert.equal((await b.api.post(`/patients/${patient.id}/letters`, { template_id: welcome.id })).status, 404);
  assert.equal((await b.api.post(`/patients/${b.patient.id}/letters`, { template_id: welcome.id })).status, 404, 'another practice’s template');
  assert.equal((await b.api.get(`/letters/${made.data.letter.id}/pdf`)).status, 404);
  const email = `billing-${Date.now()}@example.com`;
  await api.post('/users', { email, name: 'Bill', role: 'billing', password: 'correct-horse-battery' });
  const billing = h.client((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token);
  assert.equal((await billing.post(`/patients/${patient.id}/letters`, { template_id: welcome.id })).status, 403, 'billing can read, not write patients');
  assert.equal((await billing.post('/letter-templates', { name: 'x', body: 'y' })).status, 403);
});

test('mailing labels: Avery 5160 PDF, one per household, do-not-mail and bad addresses left out and named', async () => {
  const { api, patient } = await h.practice({ timezone: 'UTC' });
  const mk = (extra) => api.post('/patients', { dob: '1980-01-01', ...extra }).then((r) => r.data);
  const spouse = await mk({ first_name: 'John', last_name: 'Doe', address: '9 Elm', city: 'Austin', state: 'TX', zip: '78704' });
  const noAddr = await mk({ first_name: 'No', last_name: 'Address' });
  const moved = await mk({ first_name: 'Moved', last_name: 'Away', address: '1 Oak St', city: 'Austin', state: 'TX', zip: '78701' });
  const optedOut = await mk({ first_name: 'Opted', last_name: 'Out', address: '2 Oak St', city: 'Austin', state: 'TX', zip: '78701' });
  const vague = await mk({ first_name: 'Vague', last_name: 'Place', address: 'Rural Route', city: 'Austin', state: 'Texas', zip: '78701' });
  const pid = (await h.db.get('SELECT practice_id FROM patients WHERE id = ?', moved.id)).practice_id;
  await h.db.run("INSERT INTO cadence_holds (practice_id, patient_id, reason) VALUES (?, ?, 'moved')", pid, moved.id);
  await h.db.run("INSERT INTO cadence_holds (practice_id, patient_id, reason) VALUES (?, ?, 'no_contact')", pid, optedOut.id);
  const other = await h.practice();

  const out = (await api.post('/mailing-labels', { patient_ids: [patient.id, spouse.id, noAddr.id, moved.id, optedOut.id, vague.id, other.patient.id], source: 'test' })).data;
  assert.equal(out.count, 2, 'Jane (John shares her address) and the vague one');
  const why = Object.fromEntries(out.skipped.map((s) => [s.name, s.reason]));
  assert.match(why['John Doe'], /same address/);
  assert.match(why['No Address'], /no complete mailing address/);
  assert.match(why['Moved Away'], /moved/);
  assert.match(why['Opted Out'], /do not mail/);
  assert.equal(out.warnings[0].name, 'Vague Place');
  const pdf = Buffer.from(out.pdf, 'base64').toString('latin1');
  assert.ok(pdf.startsWith('%PDF-'));
  assert.match(pdf, /\(Jane Doe\) Tj/);
  assert.match(pdf, /\(Austin, TX 78704\) Tj/);
  assert.doesNotMatch(pdf, /Page 1 of/, 'no footer on a label sheet');
  // 31 labels make two sheets.
  const many = [];
  for (let i = 0; i < 31; i++) many.push((await mk({ first_name: 'Label', last_name: `Person${String.fromCharCode(97 + (i % 26))}${i}`, address: `${i + 10} Pine St`, city: 'Austin', state: 'TX', zip: '78702' })).id);
  const two = (await api.post('/mailing-labels', { patient_ids: many })).data;
  assert.equal(two.count, 31);
  assert.equal((Buffer.from(two.pdf, 'base64').toString('latin1').match(/\/Type \/Page /g) || []).length, 2);
  assert.equal((await api.post('/mailing-labels', { patient_ids: [] })).status, 400);
  // A campaign's audience: the same people the campaign would reach (here: everyone active), mailable ones printed.
  const everyone = (await api.post('/mailing-labels', { segment: 'all_active' })).data;
  assert.ok(everyone.count >= 30, JSON.stringify({ count: everyone.count }));
  assert.ok((await api.get('/audit-log?limit=10')).data.some((e) => e.action === 'mailing_labels.print'));
  // Another practice's patients never print.
  assert.equal((await other.api.post('/mailing-labels', { patient_ids: [patient.id] })).data.count, 0);
});
