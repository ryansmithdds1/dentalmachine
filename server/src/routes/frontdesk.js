import { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { pick, requireFields, insert, update, findOr404, audit, practiceNow, mapSeq, friendlyDateTime } from '../util.js';
import { sendMessage, preferredChannel } from '../messaging.js';
import { messageText, patientLang, subjectFor } from '../templates.js';
import { primaryPolicy, patientBalance, estimateCoverage, completeProcedure } from '../services.js';
import { recallTypes } from '../recalls.js';
import { historyChanges } from '../forms.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const OUTCOMES = ['left_voicemail', 'texted', 'emailed', 'spoke_scheduled', 'spoke_will_call', 'declined', 'wrong_number', 'note'];

// Front-office workflow: morning huddle, route slips, follow-up lists and quick search.
export default function frontDeskRoutes({ db, messenger }) {
  const r = Router();

  // ---- Check-out: everything for the end of a visit on one screen ----
  async function checkoutSummary(pid, apptId) {
    const a = await db.get(
      `SELECT a.*, p.first_name, p.last_name, p.email, p.phone, pv.name AS provider_name, o.name AS operatory_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id AND p.practice_id = a.practice_id JOIN providers pv ON pv.id = a.provider_id AND pv.practice_id = a.practice_id LEFT JOIN operatories o ON o.id = a.operatory_id
       WHERE a.id = ? AND a.practice_id = ?`, apptId, pid,
    );
    if (!a) throw new HttpError(404, 'Appointment not found');
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const procedures = await db.all(
      `SELECT pr.*, (SELECT ci.claim_id FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE ci.procedure_id = pr.id AND c.status != 'void' LIMIT 1) AS claim_id
       FROM procedures pr WHERE pr.appointment_id = ? AND pr.status != 'cancelled' ORDER BY pr.id`, a.id,
    );
    const done = procedures.filter((p) => p.status === 'completed');
    const policy = await primaryPolicy(db, pid, a.patient_id);
    const estimate = await estimateCoverage(db, policy, done);
    // Today's ledger for the patient: the visit's charges and any payments taken.
    const ledger = await db.all(
      `SELECT id, type, amount, description, method, entry_date FROM ledger_entries
       WHERE practice_id = ? AND patient_id = ? AND voided_at IS NULL AND reverses_id IS NULL AND (entry_date = ? OR procedure_id IN (SELECT id FROM procedures WHERE appointment_id = ?))
       ORDER BY id`, pid, a.patient_id, today, a.id,
    );
    const paidToday = -ledger.filter((e) => e.type === 'payment' && e.entry_date === today).reduce((s, e) => s + e.amount, 0);
    const balance = await patientBalance(db, pid, a.patient_id);
    // What to ask for now: today's estimated patient share, less what they've paid today, never more than they owe.
    const suggested = Math.max(0, Math.min(balance, estimate.total_patient - paidToday));
    const types = await recallTypes(db, pid);
    return {
      appointment: a, procedures, estimate, ledger, paid_today: paidToday, balance, suggested_payment: suggested,
      policy: policy ? { id: policy.id, carrier_name: policy.carrier_name } : null,
      unclaimed: policy ? done.filter((p) => !p.claim_id && p.fee > 0).map((p) => p.id) : [],
      recalls: (await db.all("SELECT * FROM recalls WHERE patient_id = ? AND practice_id = ? AND status != 'inactive' ORDER BY due_date", a.patient_id, pid))
        .map((r) => ({ ...r, type_name: types.find((t) => t.key === r.type)?.name || r.type, appointment_type_id: types.find((t) => t.key === r.type)?.appointment_type_id ?? null })),
      next_appointment: await db.get(
        "SELECT id, start_time, reason FROM appointments WHERE patient_id = ? AND practice_id = ? AND start_time > ? AND status IN ('scheduled','confirmed') ORDER BY start_time LIMIT 1",
        a.patient_id, pid, a.end_time,
      ),
      unscheduled: await db.all("SELECT id, code, description, tooth, surfaces, fee, treatment_plan_id FROM procedures WHERE patient_id = ? AND practice_id = ? AND status = 'planned' AND appointment_id IS NULL ORDER BY priority, id", a.patient_id, pid),
      practice: await db.get('SELECT name, address, city, state, zip, phone, npi, tax_id FROM practices WHERE id = ?', pid),
    };
  }

  r.get('/appointments/:id/checkout', requirePermission('schedule:read'), async (req, res) => {
    res.json(await checkoutSummary(req.user.practice_id, Number(req.params.id)));
  });

  // Finish the visit: complete its planned work (when allowed) and mark the patient checked out.
  r.post('/appointments/:id/checkout', requirePermission('schedule:write'), async (req, res) => {
    const a = await findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    if (['cancelled', 'no_show'].includes(a.status)) throw new HttpError(409, `This appointment is ${a.status.replace('_', ' ')}`);
    let completed = 0;
    if (req.body?.complete_procedures) {
      if (!can(req.user, 'clinical:write')) throw new HttpError(403, 'Completing procedures needs clinical access');
      for (const p of await db.all("SELECT * FROM procedures WHERE appointment_id = ? AND status = 'planned' ORDER BY id", a.id)) {
        await completeProcedure(db, req.user, p, { providerId: p.provider_id || a.provider_id, appointmentId: a.id, locationId: req.location_id });
        completed++;
      }
    }
    // finish: false completes the work without checking the patient out yet.
    if (req.body?.finish !== false) {
      const now = await practiceNow(db, req.user.practice_id);
      await db.run(
        "UPDATE appointments SET status = 'completed', dismissed_at = COALESCE(dismissed_at, ?), checked_out_at = ?, checked_out_by = ? WHERE id = ?",
        now, now, req.user.id, a.id,
      );
    }
    await audit(db, req, 'appointment.checkout', 'appointments', a.id, { completed_procedures: completed });
    res.json({ ...(await checkoutSummary(req.user.practice_id, a.id)), completed_procedures: completed });
  });

  // ---- Appointment history: every change, by whom and when ----
  r.get('/appointments/:id/history', requirePermission('schedule:read'), async (req, res) => {
    const a = await findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    res.json(await db.all(
      `SELECT l.action, l.details, l.created_at, u.name AS user_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.practice_id = ? AND l.entity = 'appointments' AND l.entity_id = ? ORDER BY l.id`, req.user.practice_id, a.id,
    ));
  });

  // ---- Waitlist: patients who want to come in (or sooner), and when they can ----
  const WL_FIELDS = ['patient_id', 'reason', 'duration', 'provider_id', 'days', 'times', 'notes', 'status'];
  const validateWaitlist = async (req, row) => {
    if (row.patient_id) await findOr404(db, 'patients', row.patient_id, req.user.practice_id, 'Patient');
    if (row.provider_id) await findOr404(db, 'providers', row.provider_id, req.user.practice_id, 'Provider');
    else if ('provider_id' in row) row.provider_id = null;
    if (row.duration != null) {
      row.duration = Number(row.duration);
      if (!Number.isInteger(row.duration) || row.duration < 10 || row.duration > 480) throw new HttpError(400, 'duration must be 10-480 minutes');
    }
    if (row.days != null) {
      const days = (Array.isArray(row.days) ? row.days : JSON.parse(row.days || '[]')).map(Number);
      if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HttpError(400, 'days are 0 (Sunday) to 6 (Saturday)');
      row.days = days.length ? JSON.stringify([...new Set(days)].sort()) : null;
    }
    if (row.times && !['any', 'morning', 'afternoon'].includes(row.times)) throw new HttpError(400, 'times must be any, morning or afternoon');
    if (row.status && !['waiting', 'booked', 'removed'].includes(row.status)) throw new HttpError(400, 'Invalid status');
  };
  const WL_SELECT = `SELECT w.*, p.first_name, p.last_name, p.phone, p.email, p.sms_opt_in, p.email_opt_in, pv.name AS provider_name
    FROM waitlist w JOIN patients p ON p.id = w.patient_id LEFT JOIN providers pv ON pv.id = w.provider_id`;
  // Who fits an opening: they can come that weekday and time of day, want that provider (or anyone), and the visit fits.
  const fits = (w, { date, time, minutes, providerId }) => {
    const days = w.days ? JSON.parse(w.days) : null;
    if (date && days && !days.includes(new Date(`${date}T12:00:00Z`).getUTCDay())) return false;
    if (time && w.times === 'morning' && time >= '12:00') return false;
    if (time && w.times === 'afternoon' && time < '12:00') return false;
    if (minutes && w.duration > minutes) return false;
    if (providerId && w.provider_id && w.provider_id !== providerId) return false;
    return true;
  };

  r.get('/waitlist', requirePermission('schedule:read'), async (req, res) => {
    const list = await db.all(`${WL_SELECT} WHERE w.practice_id = ? AND w.status = 'waiting' ORDER BY w.created_at, w.id`, req.user.practice_id);
    const q = req.query;
    const opening = q.date ? { date: q.date, time: q.time, minutes: q.minutes ? Number(q.minutes) : null, providerId: q.provider_id ? Number(q.provider_id) : null } : null;
    res.json(opening ? list.filter((w) => fits(w, opening)) : list);
  });
  r.post('/waitlist', requirePermission('schedule:write'), async (req, res) => {
    const row = pick(req.body, WL_FIELDS);
    requireFields(row, ['patient_id']);
    await validateWaitlist(req, row);
    if (await db.get("SELECT 1 AS x FROM waitlist WHERE practice_id = ? AND patient_id = ? AND status = 'waiting'", req.user.practice_id, row.patient_id)) throw new HttpError(409, 'That patient is already on the waitlist');
    const id = await insert(db, 'waitlist', { ...row, practice_id: req.user.practice_id, created_by: req.user.id });
    await audit(db, req, 'waitlist.add', 'waitlist', id);
    res.status(201).json(await db.get(`${WL_SELECT} WHERE w.id = ?`, id));
  });
  r.put('/waitlist/:wid', requirePermission('schedule:write'), async (req, res) => {
    const existing = await findOr404(db, 'waitlist', req.params.wid, req.user.practice_id, 'Waitlist entry');
    const row = pick(req.body, WL_FIELDS.filter((f) => f !== 'patient_id'));
    await validateWaitlist(req, row);
    await update(db, 'waitlist', existing.id, req.user.practice_id, row);
    await audit(db, req, 'waitlist.update', 'waitlist', existing.id, row.status ? { status: row.status } : undefined);
    res.json(await db.get(`${WL_SELECT} WHERE w.id = ?`, existing.id));
  });

  // Text an opening to the first few who fit; whoever calls or replies first gets it.
  r.post('/waitlist/offer', requirePermission('schedule:write'), async (req, res) => {
    const { date, time, minutes, provider_id: providerId } = req.body || {};
    if (!DATE.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) throw new HttpError(400, 'date and time are required');
    const limit = Math.min(Math.max(Number(req.body.limit) || 5, 1), 20);
    const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', req.user.practice_id);
    const list = (await db.all(`${WL_SELECT} WHERE w.practice_id = ? AND w.status = 'waiting' ORDER BY w.created_at, w.id`, req.user.practice_id))
      .filter((w) => fits(w, { date, time, minutes: minutes ? Number(minutes) : null, providerId: providerId ? Number(providerId) : null }));
    const when = friendlyDateTime(`${date} ${time}`);
    const sent = [];
    for (const w of list) {
      if (sent.length >= limit) break;
      const target = preferredChannel(w);
      if (!target) continue;
      const msg = await sendMessage(db, messenger, {
        practiceId: req.user.practice_id, patientId: w.patient_id, userId: req.user.id, kind: 'waitlist_offer', channel: target.channel, to: target.to,
        subject: subjectFor(patientLang(w), 'waitlist_offer', `An opening at ${practice.name}`, practice.name),
        body: await messageText(db, req.user.practice_id, 'waitlist_offer', { first_name: w.first_name, when: patientLang(w) === 'es' ? friendlyDateTime(`${date} ${time}`, 'es') : when }, patientLang(w)),
      });
      await db.run("UPDATE waitlist SET last_offered_at = datetime('now') WHERE id = ?", w.id);
      sent.push({ waitlist_id: w.id, patient_id: w.patient_id, name: `${w.first_name} ${w.last_name}`, status: msg.status });
    }
    await audit(db, req, 'waitlist.offer', 'waitlist', null, { date, time, sent: sent.length });
    res.json({ sent, matched: list.length });
  });

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
    // Everything about today's patients in one query per kind (not several per patient).
    const ids = [...new Set(appts.map((a) => a.patient_id))];
    const heads = [...new Set(appts.map((a) => a.guarantor_id || a.patient_id))];
    const IN = (list) => (list.length ? list.map(() => '?').join(',') : 'NULL');
    const byPatient = async (sql, list = ids) => (list.length ? db.all(sql.replace('%IN%', IN(list)), ...list) : []);
    const first = (rows, key) => rows.reduce((m, r) => (m.has(r[key]) ? m : m.set(r[key], r)), new Map());
    const balances = new Map((await byPatient('SELECT patient_id, COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE patient_id IN (%IN%) GROUP BY patient_id')).map((r) => [r.patient_id, r.n]));
    const families = new Map((await byPatient(
      'SELECT COALESCE(p.guarantor_id, p.id) AS g, COALESCE(SUM(l.amount),0) AS n FROM ledger_entries l JOIN patients p ON p.id = l.patient_id WHERE COALESCE(p.guarantor_id, p.id) IN (%IN%) GROUP BY COALESCE(p.guarantor_id, p.id)', heads,
    )).map((r) => [r.g, r.n]));
    const unscheduledBy = new Map((await byPatient("SELECT patient_id, COUNT(*) AS n, COALESCE(SUM(fee),0) AS amount FROM procedures WHERE patient_id IN (%IN%) AND status = 'planned' AND appointment_id IS NULL GROUP BY patient_id")).map((r) => [r.patient_id, r]));
    const recalls = first(await byPatient("SELECT patient_id, due_date, type FROM recalls WHERE patient_id IN (%IN%) AND status IN ('due','contacted') ORDER BY patient_id, due_date"), 'patient_id');
    // Same choice as primaryPolicy: the active primary, else the secondary.
    const policies = first(await byPatient(
      `SELECT pi.*, c.name AS carrier_name FROM patient_insurance pi JOIN insurance_carriers c ON c.id = pi.carrier_id
       WHERE pi.patient_id IN (%IN%) AND pi.active = 1 ORDER BY pi.patient_id, CASE pi.priority WHEN 'primary' THEN 0 ELSE 1 END, pi.id`,
    ), 'patient_id');
    const policyIds = [...policies.values()].map((x) => x.id);
    const eligibility = first(await byPatient('SELECT patient_insurance_id, status, created_at FROM eligibility_checks WHERE patient_insurance_id IN (%IN%) ORDER BY patient_insurance_id, id DESC', policyIds), 'patient_insurance_id');
    const forms = new Map((await byPatient("SELECT patient_id, COUNT(*) AS n FROM form_requests WHERE patient_id IN (%IN%) AND status = 'pending' GROUP BY patient_id")).map((r) => [r.patient_id, r.n]));
    const labsBy = (await byPatient("SELECT patient_id, description, status, due_date FROM lab_cases WHERE patient_id IN (%IN%) AND status IN ('sent','returned_for_adjustment')"))
      .reduce((m, r) => m.set(r.patient_id, [...(m.get(r.patient_id) || []), { description: r.description, status: r.status, due_date: r.due_date }]), new Map());
    const seenBefore = new Set((await byPatient("SELECT DISTINCT patient_id FROM procedures WHERE patient_id IN (%IN%) AND status = 'completed'")).map((r) => r.patient_id));
    const rows = appts.map((a) => {
      const balance = balances.get(a.patient_id) || 0;
      const familyBalance = families.get(a.guarantor_id || a.patient_id) || 0;
      const unscheduled = unscheduledBy.get(a.patient_id) || { n: 0, amount: 0 };
      const recall = recalls.get(a.patient_id);
      const policy = policies.get(a.patient_id);
      const e = policy ? eligibility.get(policy.id) : null;
      const lastElig = e ? { status: e.status, created_at: e.created_at } : null;
      const formsPending = forms.get(a.patient_id) || 0;
      const labs = labsBy.get(a.patient_id) || [];
      const flags = [];
      if (a.patient_since.slice(0, 10) >= addDays(date, -30) || !seenBefore.has(a.patient_id)) flags.push('new_patient');
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
    const patient = await findOr404(db, 'patients', a.patient_id, pid, 'Patient');
    await audit(db, req, 'route_slip.print', 'appointments', a.id);
    res.json({
      appointment: await db.get(
        `SELECT a.*, pv.name AS provider_name, o.name AS operatory_name, t.name AS type_name FROM appointments a JOIN providers pv ON pv.id = a.provider_id
         LEFT JOIN operatories o ON o.id = a.operatory_id LEFT JOIN appointment_types t ON t.id = a.appointment_type_id WHERE a.id = ?`, a.id,
      ),
      patient,
      practice: await db.get('SELECT name, phone FROM practices WHERE id = ?', pid),
      guarantor: patient.guarantor_id ? await db.get('SELECT id, first_name, last_name FROM patients WHERE id = ? AND practice_id = ?', patient.guarantor_id, pid) : null,
      policy: (await primaryPolicy(db, pid, patient.id)) || null,
      balance: (await db.get('SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE patient_id = ? AND practice_id = ?', patient.id, pid)).n,
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

  // Medical histories patients submitted that nobody has reviewed yet, with what would change on the chart.
  r.get('/patients/:id/history-review', requirePermission('clinical:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const form = await db.get("SELECT id, data, signed_at, signature_name FROM patient_forms WHERE patient_id = ? AND practice_id = ? AND kind = 'medical_history' AND review_status = 'pending' ORDER BY id DESC LIMIT 1", patient.id, req.user.practice_id);
    if (!form) return res.json(null);
    const answers = JSON.parse(form.data);
    res.json({ form_id: form.id, signed_at: form.signed_at, signature_name: form.signature_name, answers, changes: historyChanges(patient, answers) });
  });

  // A clinician accepts the reviewed values; the chart is updated and the history counts as reviewed.
  r.post('/patient-forms/:fid/review', requirePermission('clinical:write'), async (req, res) => {
    const form = await findOr404(db, 'patient_forms', req.params.fid, req.user.practice_id, 'Form');
    if (form.review_status !== 'pending') throw new HttpError(409, 'That form was already reviewed');
    const updates = {};
    for (const f of ['medical_alerts', 'allergies', 'medications']) {
      if (req.body?.[f] !== undefined) updates[f] = String(req.body[f] ?? '').trim().slice(0, 2000) || null;
    }
    await db.tx(async () => {
      if (Object.keys(updates).length) await update(db, 'patients', form.patient_id, req.user.practice_id, { ...updates, updated_at: new Date().toISOString() });
      await db.run("UPDATE patients SET medical_reviewed_at = datetime('now') WHERE id = ?", form.patient_id);
      // Older unreviewed submissions are superseded by this review.
      await db.run("UPDATE patient_forms SET review_status = CASE WHEN id = ? THEN 'reviewed' ELSE 'superseded' END, reviewed_by = ?, reviewed_at = datetime('now') WHERE patient_id = ? AND review_status = 'pending' AND id <= ?", form.id, req.user.id, form.patient_id, form.id);
    });
    await audit(db, req, 'medical_history.review', 'patients', form.patient_id, { form_id: form.id, fields: Object.keys(updates) });
    res.json(await db.get('SELECT id, medical_alerts, allergies, medications, medical_reviewed_at FROM patients WHERE id = ?', form.patient_id));
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
