import { HttpError } from './auth.js';
import { PdfDoc } from './pdf.js';
import { patientBalance } from './services.js';
import { placeholdersIn } from './campaigns.js';
import { mailable } from './mail.js';

// Letters from templates and mailing labels (docs/documents.md, “Letters and mailing labels”; actions A171, A177).
//
// A template is plain text with merge fields in braces: {first_name}, {balance}, {next_appointment}… Each field is
// filled from what the chart already holds. A letter can't be printed, saved or emailed while any field it uses has
// nothing to fill it with, or while a blank for the office is left in it ("[date]", "____") — the same rule as
// campaigns (placeholdersIn), so no patient ever gets "Dear ," or "your visit on [date]".

export const LETTER_FIELDS = {
  first_name: 'First name', last_name: 'Last name', full_name: 'Full name', preferred_name: 'Preferred name (or first name)', dob: 'Date of birth',
  patient_address: 'Mailing address (several lines)', today: 'Today’s date', practice: 'Practice name', practice_phone: 'Practice phone',
  practice_address: 'Practice address', provider: 'Their dentist', next_appointment: 'Next appointment', last_visit: 'Last visit',
  balance: 'Balance', treatment_plan: 'Planned treatment (list)', treatment_total: 'Planned treatment total',
};

export const STARTER_TEMPLATES = [
  ['Welcome to the practice', 'Welcome to {practice}', 'Dear {preferred_name},\n\nWelcome to {practice}! We are glad you chose us for your dental care. If you have any questions before your first visit, call us at {practice_phone}.\n\nWe look forward to seeing you.'],
  ['Appointment reminder', 'Your appointment at {practice}', 'Dear {preferred_name},\n\nThis is a reminder of your appointment on {next_appointment} with {provider}. If you need to change it, please call us at {practice_phone}.'],
  ['We missed you', 'We missed you', 'Dear {preferred_name},\n\nWe missed you at your recent appointment. Your dental health is important to us — please call {practice_phone} so we can find a time that works for you.'],
  ['Treatment reminder', 'Your recommended treatment', 'Dear {preferred_name},\n\n{provider} recommended the following treatment, which has not been scheduled yet:\n\n{treatment_plan}\n\nEstimated total: {treatment_total}. Waiting can let a small problem become a bigger one. Please call {practice_phone} to schedule, or with any questions about cost or insurance.'],
  ['Balance reminder', 'Your account balance', 'Dear {full_name},\n\nOur records show a balance of {balance} on your account. If you have already sent payment, thank you. Otherwise, please call {practice_phone} or pay online.'],
  ['Excuse note (work or school)', 'Dental appointment', 'To whom it may concern,\n\n{full_name} was seen at {practice} on {today}. Please excuse their absence for this appointment.\n\nIf you have questions, call {practice_phone}.'],
];

const money = (c) => `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }) : '');
const when = (dt) => {
  if (!dt) return '';
  const d = new Date(`${dt.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
  const [h, m] = dt.slice(11, 16).split(':').map(Number);
  return `${d} at ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

// Unknown fields are refused when a template is saved (a typo would print as-is).
export function checkTemplate(body, subject = '') {
  const unknown = [...`${subject} ${body}`.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((f) => !LETTER_FIELDS[f]);
  if (unknown.length) throw new HttpError(400, `Unknown merge field {${unknown[0]}} — use ${Object.keys(LETTER_FIELDS).map((f) => `{${f}}`).join(' ')}`, { unknown });
}

// Everything the fields can say about one patient, from the chart.
export async function letterVars(db, practiceId, patientId, today) {
  const p = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', patientId, practiceId);
  if (!p) throw new HttpError(404, 'Patient not found');
  const pr = await db.get('SELECT name, phone, address, city, state, zip FROM practices WHERE id = ?', practiceId);
  const provider = p.primary_provider_id ? await db.get('SELECT name FROM providers WHERE id = ?', p.primary_provider_id) : null;
  const next = await db.get("SELECT a.start_time, pv.name AS provider FROM appointments a JOIN providers pv ON pv.id = a.provider_id WHERE a.patient_id = ? AND a.practice_id = ? AND a.status IN ('scheduled','confirmed') AND a.start_time >= ? ORDER BY a.start_time LIMIT 1", p.id, practiceId, today);
  const last = await db.get("SELECT MAX(start_time) AS t FROM appointments WHERE patient_id = ? AND practice_id = ? AND status = 'completed'", p.id, practiceId);
  // Their dentist: the one on the chart, else who they're booked with or last saw, else the office's only dentist.
  const seen = !provider && !next ? await db.get("SELECT pv.name FROM appointments a JOIN providers pv ON pv.id = a.provider_id WHERE a.patient_id = ? AND a.practice_id = ? AND a.status = 'completed' ORDER BY a.start_time DESC LIMIT 1", p.id, practiceId) : null;
  const dentists = !provider && !next && !seen ? await db.all("SELECT name FROM providers WHERE practice_id = ? AND active = 1 AND type = 'dentist' LIMIT 2", practiceId) : [];
  const dentist = provider?.name || next?.provider || seen?.name || (dentists.length === 1 ? dentists[0].name : '');
  const planned = await db.all("SELECT code, description, tooth, fee FROM procedures WHERE patient_id = ? AND practice_id = ? AND status = 'planned' ORDER BY priority, id", p.id, practiceId);
  const balance = Number(await patientBalance(db, practiceId, p.id));
  const cityLine = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return {
    patient: p,
    vars: {
      first_name: p.first_name, last_name: p.last_name, full_name: `${p.first_name} ${p.last_name}`, preferred_name: p.preferred_name || p.first_name, dob: p.dob ? longDate(p.dob) : '',
      patient_address: mailable(p) ? `${p.address}\n${cityLine}` : '', today: longDate(today), practice: pr.name, practice_phone: pr.phone || '',
      practice_address: [pr.address, [pr.city, [pr.state, pr.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', '),
      provider: dentist, next_appointment: next ? when(next.start_time) : '', last_visit: last?.t ? longDate(last.t) : '',
      balance: balance > 0 ? money(balance) : '', treatment_plan: planned.map((x) => `• ${x.description}${x.tooth ? ` (tooth ${x.tooth})` : ''} — ${money(x.fee)}`).join('\n'),
      treatment_total: planned.length ? money(planned.reduce((s, x) => s + x.fee, 0)) : '',
    },
  };
}

// Fills a template. `missing` lists the fields this patient has nothing for, and `blanks` the "[…]" left in it.
export function renderLetter({ subject = '', body }, vars) {
  const missing = new Set();
  const fill = (t) => String(t || '').replace(/\{(\w+)\}/g, (all, f) => {
    if (!(f in LETTER_FIELDS)) return all;
    const v = vars[f];
    if (v == null || v === '') { missing.add(f); return `{${f}}`; }
    return v;
  });
  const out = { subject: fill(subject), body: fill(body) };
  return { ...out, missing: [...missing].map((f) => ({ field: f, label: LETTER_FIELDS[f] })), blanks: placeholdersIn(out.body, out.subject) };
}

export function assertComplete(r, who = 'this patient') {
  if (r.missing.length) throw new HttpError(400, `Nothing to fill ${r.missing.map((m) => `{${m.field}}`).join(', ')} for ${who} — change the letter or the chart first`, { missing: r.missing });
  if (r.blanks.length) throw new HttpError(400, `The letter still says ${r.blanks.map((b) => `“${b}”`).join(', ')} — fill it in first`, { placeholders: r.blanks });
}

// One letter per page: letterhead, date, the patient's address (for a window envelope), the body, sign-off.
export function lettersPdf(letters, practice) {
  const doc = new PdfDoc({ footer: practice.name, pageNumbers: letters.length === 1 });
  letters.forEach((l, i) => {
    if (i) doc.newPage();
    doc.text(practice.name, { size: 15, bold: true, gap: 1 });
    doc.text([practice.address, [practice.city, [practice.state, practice.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), practice.phone].filter(Boolean).join(' · '), { size: 9, color: [0.35, 0.38, 0.45] });
    doc.space(18);
    doc.text(l.date);
    doc.space(10);
    if (l.address) doc.text(`${l.name}\n${l.address}`);
    doc.space(16);
    if (l.subject) { doc.text(l.subject, { bold: true }); doc.space(6); }
    doc.text(l.body, { size: 11, gap: 6 });
    doc.space(16);
    doc.text(`Sincerely,\n\n${practice.name}`);
  });
  return doc.toBuffer();
}

// ---- Mailing labels: Avery 5160 / 8160 (30 per sheet, 3 across × 10 down, 2 5/8" × 1") ----
const IN = 72;
const AVERY_5160 = { cols: 3, rows: 10, top: 0.5 * IN, left: 0.1875 * IN, w: 2.625 * IN, h: 1 * IN, gap: 0.125 * IN };

// Who gets a label: one per address (a household gets one), and nobody who asked not to be contacted, moved away,
// died, or has no complete address. Returns the labels and, for the screen, who was left out and why.
export async function labelList(db, practiceId, patientIds) {
  const ids = [...new Set(patientIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 5000);
  if (!ids.length) throw new HttpError(400, 'Choose who the labels are for');
  const rows = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    rows.push(...await db.all(
      `SELECT p.id, p.first_name, p.last_name, p.address, p.city, p.state, p.zip, p.status, p.guarantor_id,
         (SELECT h.reason FROM cadence_holds h WHERE h.patient_id = p.id AND h.released_at IS NULL AND h.type IS NULL AND h.reason IN ('deceased','moved','no_contact') ORDER BY h.id DESC LIMIT 1) AS hold
       FROM patients p WHERE p.practice_id = ? AND p.id IN (${chunk.map(() => '?').join(',')})`, practiceId, ...chunk,
    ));
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const labels = [];
  const skipped = [];
  const warnings = [];
  const seen = new Set();
  const HOLD = { deceased: 'deceased', moved: 'moved away', no_contact: 'asked not to be contacted (do not mail)' };
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue; // another practice's id: silently not theirs to print
    const name = `${p.first_name} ${p.last_name}`;
    if (p.status === 'archived') { skipped.push({ id, name, reason: 'archived chart' }); continue; }
    if (p.hold) { skipped.push({ id, name, reason: HOLD[p.hold] }); continue; }
    if (!mailable(p)) { skipped.push({ id, name, reason: 'no complete mailing address' }); continue; }
    const key = `${p.address}|${p.zip}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
    if (seen.has(key)) { skipped.push({ id, name, reason: 'same address as someone above (one label per household)' }); continue; }
    seen.add(key);
    // Looks deliverable but worth a glance: no house number, a PO box without a number, a state that isn't two letters.
    if (!/\d/.test(p.address) || !/^[A-Za-z]{2}$/.test(String(p.state).trim())) warnings.push({ id, name, reason: 'address may be incomplete — check it before mailing' });
    labels.push({ id, lines: [name, p.address, `${p.city}, ${String(p.state).toUpperCase()} ${p.zip}`] });
  }
  return { labels, skipped, warnings };
}

export function labelsPdf(labels, { skip = 0 } = {}) {
  const L = AVERY_5160;
  const doc = new PdfDoc({ pageNumbers: false });
  const perPage = L.cols * L.rows;
  // `skip` leaves the first few labels of a partly used sheet empty.
  labels.forEach((label, n) => {
    const i = n + skip;
    if (i > 0 && i % perPage === 0) doc.newPage();
    const slot = i % perPage;
    const col = slot % L.cols;
    const row = Math.floor(slot / L.cols);
    const x = L.left + col * (L.w + L.gap) + 12;
    const top = 792 - L.top - row * L.h;
    label.lines.forEach((line, k) => doc.textAt(line, x, top - 20 - k * 12.5, { size: 10, bold: k === 0, maxW: L.w - 20 }));
  });
  return doc.toBuffer();
}
