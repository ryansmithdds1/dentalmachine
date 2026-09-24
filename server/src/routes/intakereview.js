import { Router } from 'express';
import { requirePermission, HttpError, can as allowed } from '../auth.js';
import { findOr404, audit } from '../util.js';
import { patientScope, canSeePatient } from '../officeaccess.js';
import { historyChanges } from '../forms.js';
import { paperworkExceptions } from '../paperwork.js';

// Intake worklist: what patients sent in online that a person still has to look at, across every patient —
// health histories waiting for review, new insurance sent from the portal, and insurance card photos from
// forms that nobody has entered as a policy yet. Accepting reuses the usual routes (history review,
// insurance-update apply); this list only gathers them, plus "nothing to enter" for a card photo.
const CARD_DAYS = 90;

export default function intakeReviewRoutes({ db }) {
  const r = Router();

  r.get('/intake/pending', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const s = patientScope(req.user, 'p');
    const can = (perm) => allowed(req.user, perm);
    const items = [];

    if (can('clinical:read')) {
      const forms = await db.all(
        `SELECT f.id, f.patient_id, f.data, f.signed_at, f.signature_name, p.first_name, p.last_name, p.dob, p.medical_alerts, p.allergies, p.medications
         FROM patient_forms f JOIN patients p ON p.id = f.patient_id
         WHERE f.practice_id = ? AND f.kind = 'medical_history' AND f.review_status = 'pending'${s.sql}
           AND f.id = (SELECT MAX(x.id) FROM patient_forms x WHERE x.patient_id = f.patient_id AND x.kind = 'medical_history' AND x.review_status = 'pending')
         ORDER BY f.signed_at`, pid, ...s.args,
      );
      for (const f of forms) {
        let changes = null;
        try {
          const answers = JSON.parse(f.data);
          changes = historyChanges(f, { conditions: [], ...answers });
        } catch { /* an unreadable form still needs a look; the chart's review shows it as submitted */ }
        items.push({
          key: `history:${f.id}`, kind: 'history', id: f.id, patient_id: f.patient_id, first_name: f.first_name, last_name: f.last_name, dob: f.dob,
          at: f.signed_at, signature_name: f.signature_name, changes,
        });
      }
    }

    if (can('billing:read')) {
      const updates = await db.all(
        `SELECT u.*, p.first_name, p.last_name, p.dob,
           (SELECT c.name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id WHERE pi.patient_id = u.patient_id AND pi.active = 1 AND pi.priority = 'primary' ORDER BY pi.id LIMIT 1) AS current_primary
         FROM insurance_updates u JOIN patients p ON p.id = u.patient_id
         WHERE u.practice_id = ? AND u.status = 'pending'${s.sql} ORDER BY u.created_at`, pid, ...s.args,
      );
      for (const u of updates) {
        items.push({
          key: `insurance:${u.id}`, kind: 'insurance_update', id: u.id, patient_id: u.patient_id, first_name: u.first_name, last_name: u.last_name, dob: u.dob, at: u.created_at,
          carrier_name: u.carrier_name, member_id: u.member_id, group_number: u.group_number, subscriber_name: u.subscriber_name, subscriber_dob: u.subscriber_dob,
          relationship: u.relationship, note: u.note, document_ids: JSON.parse(u.document_ids || '[]'), current_primary: u.current_primary, ready: !!(u.carrier_name && u.member_id),
        });
      }

      // Card photos patients sent (forms or portal; uploaded_by is empty) that are still waiting: not part of
      // a portal update, and no policy entered or changed for that patient since, and not set aside.
      const since = new Date(Date.now() - CARD_DAYS * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
      const cards = await db.all(
        `SELECT d.id, d.patient_id, d.filename, d.notes, d.created_at, p.first_name, p.last_name, p.dob
         FROM documents d JOIN patients p ON p.id = d.patient_id
         WHERE d.practice_id = ? AND d.category = 'insurance_card' AND d.uploaded_by IS NULL AND d.deleted_at IS NULL AND d.created_at >= ?${s.sql}
           AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.practice_id = d.practice_id AND a.patient_id = d.patient_id AND a.created_at >= d.created_at
             AND a.action IN ('insurance.create', 'insurance.update', 'insurance_update.apply', 'insurance.ai_card_confirmed'))
           AND NOT EXISTS (SELECT 1 FROM audit_log b WHERE b.practice_id = d.practice_id AND b.action = 'intake.card_done' AND b.entity = 'documents' AND b.entity_id = d.id)
         ORDER BY d.created_at`, pid, since, ...s.args,
      );
      const inUpdates = new Set((await db.all('SELECT document_ids FROM insurance_updates WHERE practice_id = ?', pid)).flatMap((u) => JSON.parse(u.document_ids || '[]')));
      // One item per patient's set of card photos (front and back arrive together).
      const byPatient = new Map();
      for (const d of cards.filter((c) => !inUpdates.has(c.id))) {
        const it = byPatient.get(d.patient_id) || { key: `card:${d.id}`, kind: 'card', id: d.id, patient_id: d.patient_id, first_name: d.first_name, last_name: d.last_name, dob: d.dob, at: d.created_at, document_ids: [] };
        it.document_ids.push(d.id);
        byPatient.set(d.patient_id, it);
      }
      items.push(...byPatient.values());
    }

    // Paperwork that needs a person (P5): declined consents, forms that couldn't be sent, visits soon with forms still not done.
    items.push(...await paperworkExceptions(db, req.user, { scopeSql: s.sql, scopeArgs: s.args }));

    items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    res.json({ items, counts: { history: items.filter((i) => i.kind === 'history').length, insurance_update: items.filter((i) => i.kind === 'insurance_update').length, card: items.filter((i) => i.kind === 'card').length, paperwork: items.filter((i) => /^(consent_declined|paperwork_)/.test(i.kind)).length } });
  });

  // "Nothing to enter" for card photos (a duplicate, or the policy is already right): off the list, on the record.
  r.post('/intake/cards/done', requirePermission('billing:write'), async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.document_ids) ? req.body.document_ids : []).map(Number))].filter(Number.isInteger).slice(0, 10);
    if (!ids.length) throw new HttpError(400, 'document_ids is required');
    for (const id of ids) {
      const d = await findOr404(db, 'documents', id, req.user.practice_id, 'Card photo');
      if (d.category !== 'insurance_card') throw new HttpError(400, 'That document isn’t an insurance card');
      if (!(await canSeePatient(db, req.user, d.patient_id))) throw new HttpError(404, 'Card photo not found');
      await audit(db, req, 'intake.card_done', 'documents', d.id, { patient_id: d.patient_id }, { reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : 'Nothing to enter' });
    }
    res.json({ ok: true, done: ids.length });
  });

  // A paperwork item handled another way (talked it through, called the patient): off the list, on the record.
  r.post('/intake/paperwork/done', requirePermission('patients:write'), async (req, res) => {
    const entity = req.body?.entity;
    const id = Number(req.body?.id);
    if (!['consents', 'paperwork_sends'].includes(entity) || !Number.isInteger(id)) throw new HttpError(400, 'entity and id are required');
    const row = await findOr404(db, entity, id, req.user.practice_id, 'Item');
    const patientId = row.patient_id ?? (await db.get('SELECT patient_id FROM appointments WHERE id = ?', row.appointment_id))?.patient_id;
    if (!(await canSeePatient(db, req.user, patientId))) throw new HttpError(404, 'Item not found');
    await audit(db, req, 'intake.paperwork_done', entity, id, { patient_id: patientId }, { reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : 'Handled' });
    res.json({ ok: true });
  });

  return r;
}
