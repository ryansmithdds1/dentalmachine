// A patient's copy of their record (HIPAA right of access): one ZIP with a readable summary (record.pdf),
import { raiseIssue } from './issues.js';
// everything on file as data (record.json), and their x-rays, photos and documents as the original files.
import { crc32, deflateRawSync } from 'node:zlib';
import { PdfDoc } from './pdf.js';
import { publicPractice } from './util.js';

// ---- A small ZIP writer (deflate; enough for a few hundred files) ----
export function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  const now = new Date();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const packed = deflateRawSync(raw);
    const [method, body] = packed.length < raw.length ? [8, packed] : [0, raw];
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime(now), 10); local.writeUInt16LE(dosDate(now), 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(method, 10);
    head.writeUInt16LE(dosTime(now), 12); head.writeUInt16LE(dosDate(now), 14); head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20); head.writeUInt32LE(raw.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(head, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// Tables about the patient, and what's left out of the copy: internal keys and tokens, not their information.
const TABLES = ['appointments', 'procedures', 'clinical_notes', 'tooth_conditions', 'perio_exams', 'treatment_plans', 'prescriptions', 'patient_insurance',
  'claims', 'ledger_entries', 'recalls', 'patient_forms', 'documents', 'payment_plans', 'referrals', 'vitals', 'lab_cases', 'ortho_cases', 'memberships', 'messages'];
const INTERNAL = /(_hash|_token|token_|secret|storage_key|thumb_key|^practice_id$|stripe|customer_id|payment_method_id)/;
const strip = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !INTERNAL.test(k)));
const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c || 0) / 100).toFixed(2)}`;
const safeName = (s) => String(s || 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 120);

export async function buildRecordExport(db, storage, practiceId, patientId) {
  const patient = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', patientId, practiceId);
  const practice = publicPractice(await db.get('SELECT * FROM practices WHERE id = ?', practiceId));
  const data = { patient: strip(patient), exported_at: new Date().toISOString(), practice: { name: practice.name, phone: practice.phone, address: [practice.address, practice.city, practice.state, practice.zip].filter(Boolean).join(', ') } };
  for (const t of TABLES) {
    let rows = await db.all(`SELECT * FROM ${t} WHERE patient_id = ? AND practice_id = ? ORDER BY id`, patientId, practiceId);
    if (t === 'clinical_notes') rows = rows.filter((n) => n.signed); // drafts aren't part of the record yet
    if (t === 'perio_exams' || t === 'documents') rows = rows.filter((r) => !r.deleted_at);
    data[t] = rows.map(strip);
  }
  const providers = new Map((await db.all('SELECT id, name FROM providers WHERE practice_id = ?', practiceId)).map((p) => [p.id, p.name]));
  const carriers = new Map((await db.all('SELECT id, name FROM insurance_carriers WHERE practice_id = ?', practiceId)).map((c) => [c.id, c.name]));

  // ---- The readable summary ----
  const name = `${patient.first_name} ${patient.last_name}`;
  const doc = new PdfDoc({ footer: `${practice.name} · health record of ${name} · ${data.exported_at.slice(0, 10)}` });
  const h = (t) => { doc.space(8); doc.text(t, { size: 12.5, bold: true, gap: 2 }); doc.rule(); };
  const line = (t) => doc.text(t, { size: 9.5, gap: 1.5 });
  doc.text(practice.name, { size: 15, bold: true, gap: 1 });
  doc.text(data.practice.address, { size: 9.5, gap: 1 });
  doc.space(6);
  doc.text(`Health record of ${name}`, { size: 14, bold: true });
  doc.text(`Prepared ${data.exported_at.slice(0, 10)} at the patient's request. The full record, including every entry below, is in record.json; images and documents are in the documents folder.`, { size: 9, color: [0.35, 0.38, 0.45] });
  h('Patient');
  for (const [k, v] of [['Date of birth', patient.dob], ['Phone', patient.phone], ['Email', patient.email], ['Address', [patient.address, patient.city, patient.state, patient.zip].filter(Boolean).join(', ')], ['Emergency contact', patient.emergency_contact]]) if (v) line(`${k}: ${v}`);
  h('Health');
  line(`Allergies: ${patient.allergies || 'none recorded'}`);
  line(`Medications: ${patient.medications || 'none recorded'}`);
  if (patient.medical_alerts) line(`Medical alerts: ${patient.medical_alerts}`);
  if (patient.medical_conditions) line(`Conditions: ${patient.medical_conditions}`);
  for (const v of data.vitals) line(`${String(v.recorded_at).slice(0, 10)}: blood pressure ${v.bp_systolic ?? '?'}/${v.bp_diastolic ?? '?'}, pulse ${v.pulse ?? '?'}`);
  if (data.patient_insurance.length) {
    h('Insurance');
    for (const i of data.patient_insurance) line(`${carriers.get(i.carrier_id) || 'Insurance'} (${i.priority}): member ${i.subscriber_id || '?'}, subscriber ${i.subscriber_name || ''}${i.active ? '' : ' (inactive)'}`);
  }
  h('Visits');
  if (!data.appointments.length) line('None.');
  for (const a of data.appointments) line(`${a.start_time}  ${a.reason || 'Visit'}  ${providers.get(a.provider_id) || ''}  (${a.status.replace('_', ' ')})`);
  h('Treatment done');
  const done = data.procedures.filter((p) => p.status === 'completed');
  if (!done.length) line('None.');
  const at = [0, 0.14, 0.24, 0.34, 0.86];
  for (const p of done) doc.row([String(p.completed_at || p.created_at).slice(0, 10), p.code, [p.tooth, p.surfaces].filter(Boolean).join(' '), p.description, money(p.fee)], { at, right: [4], size: 9 });
  const planned = data.procedures.filter((p) => p.status === 'planned');
  if (planned.length) {
    h('Treatment planned');
    for (const p of planned) doc.row(['', p.code, [p.tooth, p.surfaces].filter(Boolean).join(' '), p.description, money(p.fee)], { at, right: [4], size: 9 });
  }
  h('Clinical notes');
  if (!data.clinical_notes.length) line('None.');
  for (const n of data.clinical_notes) {
    doc.text(`${String(n.signed_at || n.created_at).slice(0, 16)}${n.provider_id ? ` · ${providers.get(n.provider_id) || ''}` : ''}${n.addendum_of ? ' · addendum' : ''}`, { size: 9, bold: true, gap: 1 });
    doc.text(n.body || '', { size: 9.5, gap: 5 });
  }
  if (data.perio_exams.length) {
    h('Periodontal charting');
    for (const e of data.perio_exams) {
      const readings = JSON.parse(e.readings || '{}');
      const deep = Object.entries(readings).flatMap(([tooth, r]) => (r.pd || []).filter((d) => d >= 4).map((d) => `#${tooth} ${d}mm`));
      line(`${e.exam_date}: ${Object.keys(readings).length} teeth charted; pockets 4 mm or deeper: ${deep.length ? deep.join(', ') : 'none'}`);
    }
  }
  if (data.prescriptions.length) {
    h('Prescriptions');
    for (const r of data.prescriptions) line(`${String(r.created_at).slice(0, 10)}  ${r.drug} ${r.strength || ''}: ${r.sig || ''} (qty ${r.quantity ?? '?'}, refills ${r.refills ?? 0})${providers.get(r.provider_id) ? ` · ${providers.get(r.provider_id)}` : ''}`);
  }
  if (data.treatment_plans.length) {
    h('Treatment plans');
    for (const t of data.treatment_plans) line(`${t.name}: ${t.status}${t.signed_at ? `, signed ${t.signed_at.slice(0, 10)}` : ''}`);
  }
  h('Account');
  let balance = 0;
  const lat = [0, 0.14, 0.3, 0.84];
  for (const l of data.ledger_entries) {
    balance += l.amount;
    doc.row([l.entry_date, { charge: 'Charge', payment: 'Payment', insurance_payment: 'Insurance', adjustment: 'Adjustment', refund: 'Refund' }[l.type] || l.type, l.description || '', money(l.amount)], { at: lat, right: [3], size: 9 });
  }
  doc.row(['', '', 'Balance', money(balance)], { at: lat, right: [3], size: 9.5, bold: true });

  // ---- Files ----
  const files = [{ name: 'record.pdf', data: doc.toBuffer() }, { name: 'record.json', data: JSON.stringify(data, null, 2) }];
  const used = new Set();
  let missing = 0;
  for (const d of data.documents) {
    const row = await db.get('SELECT storage_key, encrypted FROM documents WHERE id = ?', d.id);
    const bytes = storage ? await storage.read(row.storage_key, !!row.encrypted).catch(() => null) : null;
    if (!bytes) { missing++; continue; }
    let fname = `documents/${String(d.created_at).slice(0, 10)} ${safeName(d.filename)}`;
    while (used.has(fname)) fname = fname.replace(/(\.[^./]*)?$/, `-${d.id}$1`);
    used.add(fname);
    files.push({ name: fname, data: bytes });
  }
  if (missing) {
    await raiseIssue(db, {
      practiceId, kind: 'records', key: `record-export-missing:${patientId}`, role: 'admin', severity: 'high', entity: 'patients', entityId: patientId, patientId,
      title: `${missing} chart file${missing === 1 ? '' : 's'} couldn't be read from storage while exporting a patient's record`,
      detail: 'The files are listed in the record but their contents are missing — check storage and backups.',
    });
  }
  if (missing) files.push({ name: 'documents/MISSING.txt', data: `${missing} file(s) listed in record.json could not be read from storage. Ask the office for copies.\n` });
  return { zip: zip(files), filename: safeName(`Health record ${name} ${data.exported_at.slice(0, 10)}.zip`), files: files.length };
}
