import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { requireFields, insert, findOr404, audit, practiceNow, mapSeq } from '../util.js';
import { primaryPolicy } from '../services.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const OUTCOMES = ['left_voicemail', 'texted', 'emailed', 'spoke_scheduled', 'spoke_will_call', 'declined', 'wrong_number', 'note'];

// Front-office workflow: morning huddle, route slips, follow-up lists and quick search.
export default function frontDeskRoutes({ db }) {
  const r = Router();

  // Everything the team reviews in the morning huddle, per patient on today's schedule.
  r.get('/huddle', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const date = req.query.date || (await practiceNow(db, pid)).slice(0, 10);
    if (!DATE.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    const practice = await db.get('SELECT daily_goal FROM practices WHERE id = ?', pid);
    const appts = await db.all(
      `SELECT a.*, p.first_name, p.last_name, p.dob, p.phone, p.medical_alerts, p.allergies, p.office_alert, p.created_at AS patient_since,
         p.guarantor_id, p.medical_reviewed_at, pv.name AS provider_name, pv.color AS provider_color, t.name AS type_name, t.color AS type_color,
         (SELECT COALESCE(SUM(fee),0) FROM procedures x WHERE x.appointment_id = a.id AND x.status != 'cancelled') AS production
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN providers pv ON pv.id = a.provider_id
       LEFT JOIN appointment_types t ON t.id = a.appointment_type_id
       WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ('cancelled','no_show')
       ORDER BY a.start_time`, pid, `${date} 00:00`, `${date} 24:00`,
    );
    const mmdd = date.slice(5);
    const soon = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(date, n).slice(5));
    const rows = await mapSeq(appts, async (a) => {
      const balance = (await db.get('SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE patient_id = ?', a.patient_id)).n;
      const gid = a.guarantor_id || a.patient_id;
      const familyBalance = (await db.get('SELECT COALESCE(SUM(l.amount),0) AS n FROM ledger_entries l JOIN patients p ON p.id = l.patient_id WHERE p.id = ? OR p.guarantor_id = ?', gid, gid)).n;
      const unscheduled = await db.get(
        `SELECT COUNT(*) AS n, COALESCE(SUM(fee),0) AS amount FROM procedures WHERE patient_id = ? AND status = 'planned' AND appointment_id IS NULL`, a.patient_id,
      );
      const recall = await db.get("SELECT due_date, type FROM recalls WHERE patient_id = ? AND status IN ('due','contacted') ORDER BY due_date LIMIT 1", a.patient_id);
      const policy = await primaryPolicy(db, pid, a.patient_id);
      const lastElig = policy ? await db.get('SELECT status, created_at FROM eligibility_checks WHERE patient_insurance_id = ? ORDER BY id DESC LIMIT 1', policy.id) : null;
      const formsPending = (await db.get("SELECT COUNT(*) AS n FROM form_requests WHERE patient_id = ? AND status = 'pending'", a.patient_id)).n;
      const labs = await db.all("SELECT description, status, due_date FROM lab_cases WHERE patient_id = ? AND status IN ('sent','returned_for_adjustment')", a.patient_id);
      const flags = [];
      if (a.patient_since.slice(0, 10) >= addDays(date, -30) || !(await db.get("SELECT 1 FROM procedures WHERE patient_id = ? AND status = 'completed' LIMIT 1", a.patient_id))) flags.push('new_patient');
      if (a.dob && soon.includes(a.dob.slice(5))) flags.push(a.dob.slice(5) === mmdd ? 'birthday_today' : 'birthday_this_week');
      if (a.status === 'scheduled') flags.push('unconfirmed');
      if (policy && (!lastElig || lastElig.created_at.slice(0, 10) < addDays(date, -30))) flags.push('verify_insurance');
      if (!a.medical_reviewed_at || a.medical_reviewed_at.slice(0, 10) < addDays(date, -365)) flags.push('update_medical_history');
      if (formsPending) flags.push('forms_pending');
      if (labs.length) flags.push('lab_not_back');
      if (recall && recall.due_date <= addDays(date, 30)) flags.push('recall_due');
      if (unscheduled.n) flags.push('unscheduled_treatment');
      if (familyBalance > 0) flags.push('balance_due');
      return {
        id: a.id, patient_id: a.patient_id, start_time: a.start_time, end_time: a.end_time, status: a.status, first_name: a.first_name, last_name: a.last_name,
        phone: a.phone, provider_name: a.provider_name, provider_color: a.provider_color, type_name: a.type_name || a.reason, type_color: a.type_color,
        production: a.production, medical_alerts: a.medical_alerts, allergies: a.allergies, office_alert: a.office_alert,
        balance, family_balance: familyBalance, unscheduled_count: unscheduled.n, unscheduled_amount: unscheduled.amount,
        recall_due: recall?.due_date ?? null, carrier: policy?.carrier_name ?? null, eligibility: lastElig, labs, flags,
      };
    });
    const production = rows.reduce((s, x) => s + x.production, 0);
    res.json({
      date, daily_goal: practice.daily_goal, production,
      summary: {
        appointments: rows.length,
        new_patients: rows.filter((x) => x.flags.includes('new_patient')).length,
        unconfirmed: rows.filter((x) => x.flags.includes('unconfirmed')).length,
        balances_to_collect: rows.reduce((s, x) => s + Math.max(0, x.family_balance), 0),
        unscheduled_treatment: rows.reduce((s, x) => s + x.unscheduled_amount, 0),
        verify_insurance: rows.filter((x) => x.flags.includes('verify_insurance')).length,
        medical_alerts: rows.filter((x) => x.medical_alerts).length,
      },
      rows,
    });
  });

  // Printable route slip for one visit.
  r.get('/appointments/:aid/route-slip', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const a = await findOr404(db, 'appointments', req.params.aid, pid, 'Appointment');
    const patient = await db.get('SELECT * FROM patients WHERE id = ?', a.patient_id);
    await audit(db, req, 'route_slip.print', 'appointments', a.id);
    res.json({
      appointment: await db.get(
        `SELECT a.*, pv.name AS provider_name, o.name AS operatory_name, t.name AS type_name FROM appointments a JOIN providers pv ON pv.id = a.provider_id
         LEFT JOIN operatories o ON o.id = a.operatory_id LEFT JOIN appointment_types t ON t.id = a.appointment_type_id WHERE a.id = ?`, a.id,
      ),
      patient,
      practice: await db.get('SELECT name, phone FROM practices WHERE id = ?', pid),
      guarantor: patient.guarantor_id ? await db.get('SELECT id, first_name, last_name FROM patients WHERE id = ?', patient.guarantor_id) : null,
      policy: (await primaryPolicy(db, pid, patient.id)) || null,
      balance: (await db.get('SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE patient_id = ?', patient.id)).n,
      todays_procedures: await db.all("SELECT code, description, tooth, surfaces, fee FROM procedures WHERE appointment_id = ? AND status != 'cancelled'", a.id),
      unscheduled: await db.all("SELECT code, description, tooth, surfaces, fee FROM procedures WHERE patient_id = ? AND status = 'planned' AND appointment_id IS NULL ORDER BY priority", patient.id),
      recall: await db.all("SELECT type, due_date FROM recalls WHERE patient_id = ? AND status != 'inactive'", patient.id),
      last_visit: (await db.get("SELECT MAX(start_time) AS t FROM appointments WHERE patient_id = ? AND status = 'completed' AND start_time < ?", patient.id, a.start_time)).t,
      last_note: (await db.get('SELECT body, created_at FROM clinical_notes WHERE patient_id = ? ORDER BY id DESC LIMIT 1', patient.id)) || null,
    });
  });

  // ---- Follow-up lists (the "unscheduled" and "broken appointment" lists) ----
  const lastContact = async (patientId, kind) => (await db.get('SELECT outcome, note, created_at FROM followups WHERE patient_id = ? AND kind = ? ORDER BY id DESC LIMIT 1', patientId, kind)) || null;

  r.get('/followups/unscheduled', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const rows = await mapSeq((await db.all(
      `SELECT p.id AS patient_id, p.first_name, p.last_name, p.phone, p.email, COUNT(pr.id) AS procedures, SUM(pr.fee) AS amount,
         MIN(COALESCE(tp.accepted_at, tp.created_at)) AS planned_since, MAX(CASE WHEN tp.status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
         GROUP_CONCAT(pr.code || COALESCE(' #' || pr.tooth, ''), ', ') AS summary
       FROM procedures pr JOIN patients p ON p.id = pr.patient_id LEFT JOIN treatment_plans tp ON tp.id = pr.treatment_plan_id
       WHERE pr.practice_id = ? AND pr.status = 'planned' AND pr.appointment_id IS NULL AND p.status = 'active'
         AND (tp.id IS NULL OR tp.status IN ('proposed','accepted'))
         AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.start_time > ? AND a.status NOT IN ('cancelled','no_show','completed'))
       GROUP BY p.id ORDER BY accepted DESC, amount DESC`, pid, await practiceNow(db, pid),
    )), async (x) => ({
      ...x,
      last_contact: await lastContact(x.patient_id, 'unscheduled')
    }));
    // Patients who declined drop off the list (until something new is planned or they're asked for).
    res.json(req.query.all ? rows : rows.filter((x) => x.last_contact?.outcome !== 'declined' || x.planned_since > x.last_contact.created_at));
  });

  r.get('/followups/broken', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const now = await practiceNow(db, pid);
    const since = addDays(now.slice(0, 10), -Number(req.query.days || 90));
    const rows = await mapSeq((await db.all(
      `SELECT a.id, a.patient_id, a.start_time, a.status, a.reason, p.first_name, p.last_name, p.phone, p.email, pv.name AS provider_name,
         (SELECT COALESCE(SUM(fee),0) FROM procedures x WHERE x.patient_id = a.patient_id AND x.status = 'planned') AS planned_amount
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN providers pv ON pv.id = a.provider_id
       WHERE a.practice_id = ? AND a.status IN ('no_show','cancelled') AND a.start_time >= ? AND p.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM appointments b WHERE b.patient_id = a.patient_id AND b.start_time > ? AND b.status NOT IN ('cancelled','no_show','completed'))
         AND a.id = (SELECT MAX(c.id) FROM appointments c WHERE c.patient_id = a.patient_id AND c.status IN ('no_show','cancelled'))
       ORDER BY a.start_time DESC`, pid, `${since} 00:00`, now,
    )), async (x) => ({
      ...x,
      last_contact: await lastContact(x.patient_id, 'broken')
    }));
    res.json(req.query.all ? rows : rows.filter((x) => x.last_contact?.outcome !== 'declined' || x.start_time > x.last_contact.created_at));
  });

  r.get('/patients/:id/followups', requirePermission('patients:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json(await db.all(
      'SELECT f.*, u.name AS created_by_name FROM followups f LEFT JOIN users u ON u.id = f.created_by WHERE f.practice_id = ? AND f.patient_id = ? ORDER BY f.id DESC LIMIT 50',
      req.user.practice_id, patient.id,
    ));
  });

  r.post('/patients/:id/followups', requirePermission('patients:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const { kind, outcome, note } = req.body || {};
    requireFields({ kind, outcome }, ['kind', 'outcome']);
    if (!['unscheduled', 'broken', 'recall', 'collections', 'claim', 'general'].includes(kind)) throw new HttpError(400, 'Invalid follow-up kind');
    if (!OUTCOMES.includes(outcome)) throw new HttpError(400, `outcome must be one of: ${OUTCOMES.join(', ')}`);
    const id = await insert(db, 'followups', { practice_id: req.user.practice_id, patient_id: patient.id, kind, outcome, note: note ? String(note).slice(0, 1000) : null, created_by: req.user.id });
    await audit(db, req, 'followup.create', 'followups', id, { kind, outcome });
    res.status(201).json(await db.get('SELECT * FROM followups WHERE id = ?', id));
  });

  r.post('/patients/:id/medical-reviewed', requirePermission('clinical:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    await db.run("UPDATE patients SET medical_reviewed_at = datetime('now') WHERE id = ?", patient.id);
    await audit(db, req, 'patient.medical_reviewed', 'patients', patient.id);
    res.json({ ok: true });
  });

  // Global quick search (command palette): patients by name/phone/DOB/ID, plus claims by number.
  r.get('/search', requirePermission('patients:read'), async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ patients: [], claims: [] });
    const pid = req.user.practice_id;
    const like = `%${q}%`;
    const digits = q.replace(/\D/g, '');
    const patients = await db.all(
      `SELECT id, first_name, last_name, preferred_name, dob, phone, status, medical_alerts FROM patients
       WHERE practice_id = ? AND status != 'archived' AND (
         (first_name || ' ' || last_name) LIKE ? OR (last_name || ', ' || first_name) LIKE ? OR preferred_name LIKE ? OR email LIKE ?
         OR (? != '' AND length(?) >= 4 AND replace(replace(replace(replace(phone,'(',''),')',''),'-',''),' ','') LIKE ?)
         OR dob = ? OR CAST(id AS TEXT) = ?)
       ORDER BY last_name, first_name LIMIT 8`,
      pid, like, like, like, like, digits, digits, `%${digits}%`, q, q.replace(/^#/, ''),
    );
    const claims = /^#?\d+$/.test(q)
      ? await db.all('SELECT c.id, c.status, p.first_name, p.last_name FROM claims c JOIN patients p ON p.id = c.patient_id WHERE c.practice_id = ? AND c.id = ?', pid, Number(q.replace('#', '')))
      : [];
    res.json({ patients, claims });
  });

  return r;
}
