import { PdfDoc } from './pdf.js';
import { messageText, patientLang, subjectFor } from './templates.js';
import { sendMessage, preferredChannel } from './messaging.js';

// Payment receipts: a PDF to print or download, and a short message by email or text.
const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const methodName = (m) => String(m || 'other').replace(/_/g, ' ');

export async function receiptData(db, entryId, practiceId) {
  const entry = await db.get("SELECT * FROM ledger_entries WHERE id = ? AND practice_id = ? AND type = 'payment' AND amount < 0", entryId, practiceId);
  if (!entry) return null;
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', entry.patient_id);
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  // The account balance straight after this payment (later activity isn't the receipt's business).
  const after = (await db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE patient_id = ? AND practice_id = ? AND id <= ?', entry.patient_id, practiceId, entry.id)).n;
  const staff = entry.created_by ? await db.get('SELECT name FROM users WHERE id = ?', entry.created_by) : null;
  // A card surcharge or convenience fee charged with this payment (its own ledger line, same processor id).
  const fees = entry.reference ? await db.all("SELECT adjustment_type, amount FROM ledger_entries WHERE practice_id = ? AND reference = ? AND type = 'adjustment' AND adjustment_type IN ('Card surcharge', 'Convenience fee') AND voided_at IS NULL", practiceId, entry.reference) : [];
  return { entry, patient, practice, balance_after: after, received_by: staff?.name || null, voided: !!entry.voided_at, fees };
}

export function receiptPdf({ entry, patient, practice, balance_after, received_by, voided, fees = [] }) {
  const doc = new PdfDoc({ footer: `${practice.name} · receipt #${entry.id}` });
  doc.text(practice.name, { size: 15, bold: true, gap: 1 });
  doc.text([practice.address, practice.city, practice.state, practice.zip].filter(Boolean).join(', '), { size: 9.5, gap: 1 });
  if (practice.phone) doc.text(practice.phone, { size: 9.5 });
  if (practice.tax_id) doc.text(`Tax ID ${practice.tax_id}`, { size: 9.5 });
  doc.space(8);
  doc.text(`Payment receipt #${entry.id}`, { size: 13, bold: true });
  if (voided) doc.text('VOIDED — this payment was reversed', { size: 11, bold: true, color: [0.7, 0.1, 0.1] });
  doc.space(4);
  const at = [0, 0.35];
  const rows = [
    ['Date', entry.entry_date],
    ['Received from', `${patient.first_name} ${patient.last_name}`],
    ['Amount', money(-entry.amount)],
    ...fees.map((f) => [`Includes ${f.adjustment_type.toLowerCase()}`, money(f.amount)]),
    ['Method', methodName(entry.method)],
    ...(entry.reference && !/^(pi_|sbx_|ch_)/.test(entry.reference) ? [['Reference', entry.reference]] : []),
    ['For', entry.description],
    ['Account balance after this payment', money(balance_after)],
    ...(received_by ? [['Received by', received_by]] : []),
  ];
  for (const [k, v] of rows) doc.row([k, v], { at });
  doc.space(12);
  doc.text('Thank you.', { size: 10.5 });
  return doc.toBuffer();
}

// Emails or texts the receipt to the patient (or whoever is responsible for their account).
export async function sendReceipt(db, messenger, { entryId, practiceId, channel, userId = null }) {
  const data = await receiptData(db, entryId, practiceId);
  if (!data) return null;
  const { entry, patient, practice, balance_after, fees } = data;
  let target = preferredChannel(patient, channel);
  if (!target && patient.guarantor_id) target = preferredChannel(await db.get('SELECT * FROM patients WHERE id = ?', patient.guarantor_id), channel);
  if (!target) return null;
  const lang = patientLang(patient);
  const text = await messageText(db, practiceId, 'receipt', {
    first_name: patient.first_name, amount: -entry.amount, date: entry.entry_date, method: methodName(entry.method), balance: money(Math.max(0, balance_after)), receipt: `#${entry.id}`,
  }, lang);
  const body = fees?.length ? `${text}\n${fees.map((f) => (lang === 'es' ? `Incluye ${f.adjustment_type === 'Card surcharge' ? 'recargo por tarjeta' : 'cargo por conveniencia'}: ${money(f.amount)}` : `Includes ${f.adjustment_type.toLowerCase()}: ${money(f.amount)}`)).join('\n')}` : text;
  return sendMessage(db, messenger, {
    practiceId, patientId: patient.id, userId, kind: 'receipt', channel: target.channel, to: target.to,
    subject: subjectFor(lang, 'receipt', `Your receipt from ${practice.name}`, practice.name), body,
  });
}

// Payments nobody at the desk handed over (online, autopay): email a receipt when the practice has it on.
export async function autoReceipt(db, messenger, entryId) {
  if (!messenger) return null;
  const e = await db.get('SELECT practice_id FROM ledger_entries WHERE id = ?', entryId);
  const p = e && await db.get('SELECT auto_receipts FROM practices WHERE id = ?', e.practice_id);
  if (!p?.auto_receipts) return null;
  return sendReceipt(db, messenger, { entryId, practiceId: e.practice_id, channel: 'email' }).catch(() => null);
}
