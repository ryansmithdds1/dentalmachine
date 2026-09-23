import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { pick, requireFields, requireOneOf, insert, update, findOr404, audit, practiceNow } from '../util.js';

const STATUSES = ['open', 'scheduled', 'seen', 'report_received', 'closed'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Referral tracking: who sends us patients (and what they're worth), and who we send patients to
// (and whether they were seen and the report came back).
export default function referralRoutes({ db }) {
  const r = Router();

  // ---- Referral contacts (dentists, specialists, other sources) ----
  const CONTACT_FIELDS = ['name', 'practice_name', 'specialty', 'phone', 'fax', 'email', 'address', 'npi', 'notes', 'active'];
  const cleanContact = (row) => {
    if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) throw new HttpError(400, 'Invalid email');
    if (row.npi && !/^\d{10}$/.test(row.npi)) throw new HttpError(400, 'NPI must be 10 digits');
    if (row.active != null) row.active = row.active ? 1 : 0;
    return row;
  };
  r.get('/referral-contacts', requirePermission('patients:read'), async (req, res) => {
    res.json(await db.all(
      `SELECT c.*,
         (SELECT COUNT(*) FROM referrals x WHERE x.contact_id = c.id AND x.direction = 'in') AS referred_in,
         (SELECT COUNT(*) FROM referrals x WHERE x.contact_id = c.id AND x.direction = 'out') AS referred_out
       FROM referral_contacts c WHERE c.practice_id = ? ORDER BY c.active DESC, c.name`, req.user.practice_id,
    ));
  });
  r.post('/referral-contacts', requirePermission('patients:write'), async (req, res) => {
    const row = cleanContact(pick(req.body, CONTACT_FIELDS));
    requireFields(row, ['name']);
    const id = await insert(db, 'referral_contacts', { ...row, practice_id: req.user.practice_id });
    await audit(db, req, 'referral_contact.create', 'referral_contacts', id);
    res.status(201).json(await db.get('SELECT * FROM referral_contacts WHERE id = ?', id));
  });
  r.put('/referral-contacts/:cid', requirePermission('patients:write'), async (req, res) => {
    const existing = await findOr404(db, 'referral_contacts', req.params.cid, req.user.practice_id, 'Referral contact');
    await update(db, 'referral_contacts', existing.id, req.user.practice_id, cleanContact(pick(req.body, CONTACT_FIELDS)));
    await audit(db, req, 'referral_contact.update', 'referral_contacts', existing.id);
    res.json(await db.get('SELECT * FROM referral_contacts WHERE id = ?', existing.id));
  });

  // ---- Referrals ----
  const SELECT = `SELECT x.*, c.name AS contact_name, c.practice_name AS contact_practice, c.specialty, c.phone AS contact_phone, c.fax AS contact_fax,
      p.first_name, p.last_name, pv.name AS provider_name
    FROM referrals x JOIN referral_contacts c ON c.id = x.contact_id JOIN patients p ON p.id = x.patient_id LEFT JOIN providers pv ON pv.id = x.provider_id`;
  const FIELDS = ['contact_id', 'direction', 'referral_date', 'reason', 'teeth', 'urgency', 'status', 'provider_id', 'notes'];
  const validate = async (req, row) => {
    requireOneOf(row.direction, ['in', 'out'], 'direction');
    requireOneOf(row.status, STATUSES, 'status');
    requireOneOf(row.urgency || undefined, ['routine', 'soon', 'urgent'], 'urgency');
    if (row.referral_date && !DATE.test(row.referral_date)) throw new HttpError(400, 'referral_date must be YYYY-MM-DD');
    if (row.contact_id) await findOr404(db, 'referral_contacts', row.contact_id, req.user.practice_id, 'Referral contact');
    if (row.provider_id) await findOr404(db, 'providers', row.provider_id, req.user.practice_id, 'Provider');
  };

  r.get('/patients/:id/referrals', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json(await db.all(`${SELECT} WHERE x.patient_id = ? AND x.practice_id = ? ORDER BY x.referral_date DESC, x.id DESC`, patient.id, req.user.practice_id));
  });

  r.post('/patients/:id/referrals', requirePermission('patients:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const row = pick(req.body, FIELDS);
    requireFields(row, ['contact_id', 'direction']);
    row.referral_date ??= (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    // Someone referred in is done with once they're here.
    row.status ??= row.direction === 'in' ? 'closed' : 'open';
    await validate(req, row);
    const id = await insert(db, 'referrals', { ...row, practice_id: req.user.practice_id, patient_id: patient.id, created_by: req.user.id });
    // The first referral in becomes the patient's "referred by".
    if (row.direction === 'in' && !patient.referred_by_id) {
      const c = await db.get('SELECT name FROM referral_contacts WHERE id = ?', row.contact_id);
      await db.run('UPDATE patients SET referred_by_id = ?, referral_source = COALESCE(referral_source, ?) WHERE id = ?', row.contact_id, c.name, patient.id);
    }
    await audit(db, req, 'referral.create', 'referrals', id, { direction: row.direction });
    res.status(201).json(await db.get(`${SELECT} WHERE x.id = ?`, id));
  });

  r.put('/referrals/:rid', requirePermission('patients:write'), async (req, res) => {
    const existing = await findOr404(db, 'referrals', req.params.rid, req.user.practice_id, 'Referral');
    const row = pick(req.body, FIELDS.filter((f) => f !== 'direction'));
    await validate(req, row);
    await update(db, 'referrals', existing.id, req.user.practice_id, row);
    await audit(db, req, 'referral.update', 'referrals', existing.id, row.status ? { status: row.status } : undefined);
    res.json(await db.get(`${SELECT} WHERE x.id = ?`, existing.id));
  });

  // Outgoing referrals still waiting on the specialist (not seen, or no report back yet).
  r.get('/referrals', requirePermission('patients:read'), async (req, res) => {
    const open = req.query.open === 'true';
    res.json(await db.all(
      `${SELECT} WHERE x.practice_id = ?${open ? " AND x.direction = 'out' AND x.status IN ('open','scheduled','seen')" : ''} ORDER BY x.referral_date DESC, x.id DESC LIMIT 500`,
      req.user.practice_id,
    ));
  });

  // Everything for a printed referral letter.
  r.get('/referrals/:rid/letter', requirePermission('patients:read'), async (req, res) => {
    const ref = await db.get(`${SELECT} WHERE x.id = ? AND x.practice_id = ?`, Number(req.params.rid), req.user.practice_id);
    if (!ref) throw new HttpError(404, 'Referral not found');
    await audit(db, req, 'referral.letter', 'referrals', ref.id);
    res.json({
      referral: ref,
      contact: await db.get('SELECT * FROM referral_contacts WHERE id = ?', ref.contact_id),
      patient: await db.get('SELECT id, first_name, last_name, dob, phone, email, medical_alerts, allergies, medications, premed_required FROM patients WHERE id = ?', ref.patient_id),
      provider: ref.provider_id ? await db.get('SELECT name, npi, license_number FROM providers WHERE id = ?', ref.provider_id) : null,
      practice: await db.get('SELECT name, address, city, state, zip, phone, email FROM practices WHERE id = ?', ref.practice_id),
      insurance: await db.get(
        `SELECT c.name AS carrier_name, pi.subscriber_id, pi.group_number FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id
         WHERE pi.patient_id = ? AND pi.active = 1 ORDER BY CASE pi.priority WHEN 'primary' THEN 0 ELSE 1 END LIMIT 1`, ref.patient_id,
      ),
    });
  });

  // Where new patients come from and what they've produced since.
  r.get('/reports/referrals', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const to = DATE.test(req.query.to || '') ? req.query.to : (await practiceNow(db, pid)).slice(0, 10);
    const from = DATE.test(req.query.from || '') ? req.query.from : `${to.slice(0, 4)}-01-01`;
    const sources = await db.all(
      `SELECT c.id, c.name, c.practice_name, c.specialty,
         COUNT(DISTINCT x.patient_id) AS patients,
         COALESCE(SUM((SELECT COALESCE(SUM(pr.fee), 0) FROM procedures pr WHERE pr.patient_id = x.patient_id AND pr.status = 'completed' AND pr.completed_at >= x.referral_date)), 0) AS production
       FROM referrals x JOIN referral_contacts c ON c.id = x.contact_id
       WHERE x.practice_id = ? AND x.direction = 'in' AND x.referral_date BETWEEN ? AND ?
       GROUP BY c.id, c.name, c.practice_name, c.specialty ORDER BY COUNT(DISTINCT x.patient_id) DESC`,
      pid, from, to,
    );
    // New patients whose source is only the free-text "referral source" (Google, a friend, …).
    const freeText = await db.all(
      `SELECT COALESCE(p.referral_source, 'Not recorded') AS source, COUNT(*) AS patients,
         COALESCE(SUM((SELECT COALESCE(SUM(pr.fee), 0) FROM procedures pr WHERE pr.patient_id = p.id AND pr.status = 'completed')), 0) AS production
       FROM patients p
       WHERE p.practice_id = ? AND p.referred_by_id IS NULL AND substr(p.created_at, 1, 10) BETWEEN ? AND ?
       GROUP BY COALESCE(p.referral_source, 'Not recorded') ORDER BY COUNT(*) DESC`,
      pid, from, to,
    );
    const outgoing = await db.all(
      `SELECT c.name, c.specialty, COUNT(*) AS referrals,
         SUM(CASE WHEN x.status IN ('seen','report_received','closed') THEN 1 ELSE 0 END) AS seen,
         SUM(CASE WHEN x.status = 'report_received' OR x.status = 'closed' THEN 1 ELSE 0 END) AS reports
       FROM referrals x JOIN referral_contacts c ON c.id = x.contact_id
       WHERE x.practice_id = ? AND x.direction = 'out' AND x.referral_date BETWEEN ? AND ?
       GROUP BY c.id, c.name, c.specialty ORDER BY COUNT(*) DESC`,
      pid, from, to,
    );
    res.json({ from, to, sources, free_text: freeText, outgoing });
  });

  return r;
}
