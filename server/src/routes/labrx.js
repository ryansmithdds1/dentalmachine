import { Router } from 'express';
import { setActor } from '../actor.js';
import { requirePermission, HttpError, rateLimit } from '../auth.js';
import { findOr404, audit, newToken, hashToken, insert, practiceNow } from '../util.js';
import { publish } from '../events.js';

// Digital lab prescriptions: the case's full Rx (restoration, material, shades, margins, contacts,
// occlusion, pontic design, impression) with x-rays, photos and scan files from the chart, sent to the lab
// as a private link. The lab opens it without an account, downloads the files, and marks the case
// received, in production or shipped (with tracking) — the office sees it on the case.
const RX_FIELDS = {
  restoration: 'Restoration', material: 'Material', shade: 'Shade', stump_shade: 'Stump shade', margin: 'Margin', occlusion: 'Occlusal contact',
  contacts: 'Proximal contacts', pontic: 'Pontic design', impression: 'Impression', scanner: 'Scanner / case ID', teeth: 'Teeth', instructions: 'Instructions',
};
const LAB_UPDATES = { received: 'Received by the lab', in_production: 'In production', shipped: 'Shipped', question: 'The lab has a question' };
const LINK_DAYS = 120;

const cleanRx = (rx) => Object.fromEntries(Object.keys(RX_FIELDS).filter((k) => rx?.[k] != null && String(rx[k]).trim()).map((k) => [k, String(rx[k]).trim().slice(0, k === 'instructions' ? 2000 : 200)]));

export default function labRxRoutes({ db, messenger, config }) {
  const r = Router();
  r.get('/lab-rx/fields', requirePermission('clinical:read'), (_req, res) => res.json({ fields: RX_FIELDS, updates: LAB_UPDATES }));

  // Save the Rx and send the lab its link (by email when the lab has one; the link is returned either way).
  r.post('/lab-cases/:lid/send', requirePermission('clinical:write'), async (req, res) => {
    const c = await findOr404(db, 'lab_cases', req.params.lid, req.user.practice_id, 'Lab case');
    const rx = cleanRx(req.body?.rx || {});
    const docs = [...new Set((Array.isArray(req.body?.document_ids) ? req.body.document_ids : []).map(Number).filter(Boolean))].slice(0, 20);
    for (const id of docs) {
      if (!(await db.get('SELECT id FROM documents WHERE id = ? AND patient_id = ? AND practice_id = ? AND deleted_at IS NULL', id, c.patient_id, req.user.practice_id))) throw new HttpError(400, 'Attach files from this patient’s chart only');
    }
    const lab = c.lab_id ? await db.get('SELECT * FROM labs WHERE id = ?', c.lab_id) : null;
    const email = String(req.body?.email || lab?.email || '').trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'That email address isn’t valid');
    const { token, hash } = newToken();
    const expires = new Date(Date.now() + LINK_DAYS * 86400_000).toISOString();
    await db.run(
      "UPDATE lab_cases SET rx = ?, document_ids = ?, lab_token_hash = ?, lab_link_expires = ?, rx_sent_at = datetime('now'), shade = COALESCE(?, shade), tooth = COALESCE(?, tooth) WHERE id = ?",
      JSON.stringify(rx), JSON.stringify(docs), hash, expires, rx.shade || null, rx.teeth || null, c.id,
    );
    const link = `${config.appUrl}/lab/${token}`;
    const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', req.user.practice_id);
    let emailed = false;
    if (email) {
      try {
        await messenger.send({
          channel: 'email', to: email, subject: `New case from ${practice.name}: ${c.description}${c.due_date ? ` (due ${c.due_date})` : ''}`,
          body: `${practice.name} sent you a case.\n\n${c.description}${rx.teeth ? ` · teeth ${rx.teeth}` : ''}${c.due_date ? `\nNeeded back by ${c.due_date}` : ''}\n\nOpen the prescription and files (and update the case status) here:\n${link}\n\nThis link is private to your lab and works for ${LINK_DAYS} days. Questions: ${practice.phone || 'reply to the office'}.`,
        });
        emailed = true;
      } catch { /* the link is still shown to staff to send another way */ }
    }
    await audit(db, req, 'lab_case.send_rx', 'lab_cases', c.id, { emailed, files: docs.length });
    res.json({ link, emailed, expires });
  });

  return r;
}

// The lab's side (no account: the private link is the key).
export function labPublicRoutes({ db, storage }) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 60_000, max: 60, name: 'lab-link' });
  const caseFor = async (token) => {
    const c = await db.get('SELECT * FROM lab_cases WHERE lab_token_hash = ?', hashToken(token));
    if (!c || !c.lab_link_expires || c.lab_link_expires < new Date().toISOString() || c.status === 'cancelled') throw new HttpError(404, 'This link has expired or the case was cancelled — ask the office to send it again');
    return c;
  };
  r.get('/lab/:token', limiter, async (req, res) => {
    const c = await caseFor(req.params.token);
    const docs = JSON.parse(c.document_ids || '[]');
    const p = await db.get('SELECT first_name, last_name, dob, gender FROM patients WHERE id = ?', c.patient_id);
    const age = p.dob ? Math.floor((Date.now() - Date.parse(p.dob)) / (365.25 * 86400_000)) : null;
    await db.run("UPDATE lab_cases SET lab_viewed_at = COALESCE(lab_viewed_at, datetime('now')) WHERE id = ?", c.id);
    res.json({
      case: { id: c.id, description: c.description, tooth: c.tooth, shade: c.shade, sent_date: c.sent_date, due_date: c.due_date, status: c.status, lab_status: c.lab_status, tracking_number: c.tracking_number, notes: c.notes },
      rx: JSON.parse(c.rx || '{}'), fields: RX_FIELDS, updates: LAB_UPDATES,
      // What a lab slip carries: the patient's name, age and sex — nothing more from the chart.
      patient: { name: `${p.first_name} ${p.last_name}`, age, gender: p.gender || null },
      practice: await db.get('SELECT name, phone, address, city, state, zip FROM practices WHERE id = ?', c.practice_id),
      provider: c.provider_id ? await db.get('SELECT name, npi, license_number FROM providers WHERE id = ?', c.provider_id) : null,
      appointment: c.appointment_id ? (await db.get('SELECT substr(start_time, 1, 10) AS date FROM appointments WHERE id = ?', c.appointment_id))?.date : null,
      files: docs.length ? await db.all(`SELECT id, filename, mime, category FROM documents WHERE id IN (${docs.map(() => '?').join(',')}) AND deleted_at IS NULL`, ...docs) : [],
    });
  });
  r.get('/lab/:token/files/:did', limiter, async (req, res) => {
    const c = await caseFor(req.params.token);
    const did = Number(req.params.did);
    if (!JSON.parse(c.document_ids || '[]').includes(did)) throw new HttpError(404, 'File not found');
    const doc = await db.get('SELECT * FROM documents WHERE id = ? AND patient_id = ? AND deleted_at IS NULL', did, c.patient_id);
    if (!doc) throw new HttpError(404, 'File not found');
    const data = await storage.read(doc.storage_key, !!doc.encrypted);
    await audit(db, { ip: req.ip, user: { practice_id: c.practice_id, id: null } }, 'lab_link.download', 'documents', doc.id, { lab_case: c.id }, { source: 'integration', actor: `Lab: ${c.lab_name}`, patientId: c.patient_id });
    res.set({ 'Content-Type': doc.mime || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${String(doc.filename).replace(/["\r\n]/g, '')}"`, 'Cache-Control': 'no-store' }).send(data);
  });
  r.post('/lab/:token/status', limiter, async (req, res) => {
    const c = await caseFor(req.params.token);
    setActor({ source: 'integration', actor: `Lab: ${c.lab_name}`, practiceId: c.practice_id });
    const status = String(req.body?.status || '');
    if (!Object.hasOwn(LAB_UPDATES, status)) throw new HttpError(400, `status must be one of: ${Object.keys(LAB_UPDATES).join(', ')}`);
    const note = String(req.body?.note || '').trim().slice(0, 1000) || null;
    const tracking = String(req.body?.tracking_number || '').trim().slice(0, 80) || null;
    const due = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.due_date || '') ? req.body.due_date : null;
    await db.run("UPDATE lab_cases SET lab_status = ?, lab_note = ?, tracking_number = COALESCE(?, tracking_number), due_date = COALESCE(?, due_date), lab_updated_at = datetime('now') WHERE id = ?", status, note, tracking, due, c.id);
    // Shipped cases and questions need someone at the office.
    // The same update sent twice (a double click, a resend) doesn't make a second task.
    const repeat = c.lab_status === status && (c.lab_note ?? null) === note && (!tracking || c.tracking_number === tracking) && (!due || c.due_date === due);
    if (!repeat && (status === 'question' || status === 'shipped' || due)) {
      const p = await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', c.patient_id);
      const today = (await practiceNow(db, c.practice_id)).slice(0, 10);
      await insert(db, 'tasks', {
        practice_id: c.practice_id, patient_id: c.patient_id, priority: status === 'question' ? 'high' : 'normal', due_date: today,
        title: `Lab (${c.lab_name}) — ${p.first_name} ${p.last_name}, ${c.description}: ${LAB_UPDATES[status]}${tracking ? `, tracking ${tracking}` : ''}${due ? `, new due date ${due}` : ''}${note ? ` — “${note}”` : ''}`.slice(0, 300),
      });
      publish(c.practice_id, { type: 'tasks' });
    }
    res.json({ ok: true });
  });
  return r;
}
