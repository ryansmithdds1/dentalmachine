import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, audit, practiceNow, toCents, utcRange, publicPractice } from '../util.js';
import { sendMessage, preferredChannel } from '../messaging.js';
import { renderTemplate, templatesFor, patientLang, fixedText, subjectFor } from '../templates.js';
import { mailable, statementHtml } from '../mail.js';
import { statementData } from './billing.js';
import { portalKey } from './portal.js';
import { pendingInsurance } from '../services.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

// Practice analytics (KPIs), statement batches, bulk recall and full data export.
export default function growthRoutes({ db, messenger, config, mailer = { enabled: false } }) {
  const r = Router();

  r.get('/analytics', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const from = req.query.from || addDays(today, -89);
    const to = req.query.to || today;
    if (!DATE.test(from) || !DATE.test(to)) throw new HttpError(400, 'from/to must be YYYY-MM-DD');
    const range = [pid, from, to];
    const [fromUtc, toUtc] = await utcRange(db, pid, from, to); // for UTC created_at columns
    const one = async (sql, ...p) => (await db.get(sql, ...p)).n;

    const production = await one("SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'charge' AND entry_date BETWEEN ? AND ?", ...range);
    const collections = -(await one("SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND type IN ('payment','insurance_payment') AND entry_date BETWEEN ? AND ?", ...range));
    const adjustments = -(await one("SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'adjustment' AND amount < 0 AND entry_date BETWEEN ? AND ?", ...range));
    const hygieneProduction = await one(
      `SELECT COALESCE(SUM(l.amount),0) AS n FROM ledger_entries l JOIN providers pv ON pv.id = l.provider_id
       WHERE l.practice_id = ? AND l.type = 'charge' AND pv.type = 'hygienist' AND l.entry_date BETWEEN ? AND ?`, ...range,
    );
    const appts = await db.all(
      `SELECT status, COUNT(*) AS n FROM appointments WHERE practice_id = ? AND start_time >= ? AND start_time < ? AND start_time < ? GROUP BY status`,
      pid, `${from} 00:00`, `${to} 24:00`, `${today} 24:00`,
    );
    const count = (s) => appts.filter((a) => s.includes(a.status)).reduce((x, a) => x + a.n, 0);
    const kept = count(['completed', 'checked_in', 'in_chair']);
    const broken = count(['no_show', 'cancelled']);
    const noShows = count(['no_show']);

    // Case acceptance: presented plan dollars that were accepted.
    const plans = await db.get(
      `SELECT COALESCE(SUM(pr.fee),0) AS presented, COALESCE(SUM(CASE WHEN tp.status IN ('accepted','completed') THEN pr.fee ELSE 0 END),0) AS accepted,
         COUNT(DISTINCT tp.id) AS plans, COUNT(DISTINCT CASE WHEN tp.status IN ('accepted','completed') THEN tp.id END) AS accepted_plans
       FROM treatment_plans tp JOIN procedures pr ON pr.treatment_plan_id = tp.id
       WHERE tp.practice_id = ? AND tp.created_at >= ? AND tp.created_at < ? AND pr.status != 'cancelled'`, pid, fromUtc, toUtc,
    );

    // Hygiene reappointment: hygiene visits completed in range whose patient left with their next visit
    // already booked (booked by the day of the visit — not an appointment made weeks later).
    const hyg = await db.get(
      `SELECT COUNT(*) AS visits, SUM(CASE WHEN EXISTS (SELECT 1 FROM appointments b WHERE b.patient_id = a.patient_id AND b.start_time > a.start_time
           AND b.status NOT IN ('cancelled','no_show') AND substr(b.created_at, 1, 10) <= substr(a.start_time, 1, 10)) THEN 1 ELSE 0 END) AS reappointed
       FROM appointments a JOIN providers pv ON pv.id = a.provider_id
       WHERE a.practice_id = ? AND pv.type = 'hygienist' AND a.status = 'completed' AND a.start_time >= ? AND a.start_time < ?`,
      pid, `${from} 00:00`, `${to} 24:00`,
    );

    const newPatients = await db.all(
      `SELECT COALESCE(NULLIF(referral_source, ''), 'Not recorded') AS source, COUNT(*) AS n FROM patients
       WHERE practice_id = ? AND created_at >= ? AND created_at < ? GROUP BY source ORDER BY n DESC`, pid, fromUtc, toUtc,
    );
    const active = await one(
      `SELECT COUNT(DISTINCT patient_id) AS n FROM appointments WHERE practice_id = ? AND status = 'completed' AND start_time >= ?`,
      pid, `${addDays(today, -547)} 00:00`,
    );
    const recallTotal = await one("SELECT COUNT(*) AS n FROM recalls r JOIN patients p ON p.id = r.patient_id WHERE r.practice_id = ? AND p.status = 'active' AND r.status != 'inactive'", pid);
    const recallCurrent = await one(
      `SELECT COUNT(*) AS n FROM recalls r JOIN patients p ON p.id = r.patient_id WHERE r.practice_id = ? AND p.status = 'active' AND r.status != 'inactive'
       AND (r.due_date >= ? OR r.status = 'scheduled')`, pid, today,
    );
    const byProvider = await db.all(
      `SELECT pv.id, pv.name, pv.type, COALESCE(SUM(l.amount),0) AS production, COUNT(DISTINCT l.patient_id) AS patients
       FROM providers pv LEFT JOIN ledger_entries l ON l.provider_id = pv.id AND l.type = 'charge' AND l.entry_date BETWEEN ? AND ?
       WHERE pv.practice_id = ? AND pv.active = 1 GROUP BY pv.id ORDER BY production DESC`, from, to, pid,
    );
    const days = Math.max(1, (Date.parse(to) - Date.parse(from)) / 86400_000 + 1);
    const monthly = await db.all(
      `SELECT substr(entry_date, 1, 7) AS month,
         SUM(CASE WHEN type = 'charge' THEN amount ELSE 0 END) AS production,
         -SUM(CASE WHEN type IN ('payment','insurance_payment') THEN amount ELSE 0 END) AS collections
       FROM ledger_entries WHERE practice_id = ? AND entry_date >= ? GROUP BY month ORDER BY month`, pid, `${addDays(today, -365).slice(0, 7)}-01`,
    );

    res.json({
      from, to,
      production, collections, adjustments, hygiene_production: hygieneProduction,
      net_production: production - adjustments,
      collection_rate: pct(collections, production - adjustments),
      avg_daily_production: Math.round(production / days),
      appointments: { kept, broken, no_shows: noShows, no_show_rate: pct(noShows, kept + broken) },
      case_acceptance: { presented: plans.presented, accepted: plans.accepted, rate: pct(plans.accepted, plans.presented), plans: plans.plans, accepted_plans: plans.accepted_plans },
      hygiene_reappointment: { visits: hyg.visits, reappointed: hyg.reappointed || 0, rate: pct(hyg.reappointed || 0, hyg.visits) },
      new_patients: { total: newPatients.reduce((s, x) => s + x.n, 0), by_source: newPatients },
      active_patients: active,
      recall_current_rate: pct(recallCurrent, recallTotal),
      by_provider: byProvider,
      monthly,
    });
  });

  // ---- Statement batches ----
  // Accounts (guarantors) with a family balance at or above the minimum, not statemented recently.
  const statementCandidates = async (pid, minBalance, sinceDays) => {
    const cutoff = addDays((await practiceNow(db, pid)).slice(0, 10), -sinceDays);
    const rows = (await db.all(
      `SELECT g.id, g.first_name, g.last_name, g.email, g.email_opt_in, g.address, g.city, g.state, g.zip, g.statement_sent_at,
         (SELECT COALESCE(SUM(l.amount),0) FROM ledger_entries l JOIN patients m ON m.id = l.patient_id WHERE m.id = g.id OR m.guarantor_id = g.id) AS balance
       FROM patients g WHERE g.practice_id = ? AND g.guarantor_id IS NULL AND g.status != 'archived'
         AND (g.statement_sent_at IS NULL OR g.statement_sent_at < ?)`, pid, cutoff,
    )).filter((x) => x.balance >= minBalance);
    // Same patient-portion rule as the ledger and portal: minus what insurance and in-network discounts will cover.
    const out = [];
    for (const x of rows) {
      const members = (await db.all('SELECT id FROM patients WHERE practice_id = ? AND (id = ? OR guarantor_id = ?)', pid, x.id, x.id)).map((m) => m.id);
      const pending = await pendingInsurance(db, pid, members);
      out.push({ ...x, pending_insurance: pending.insurance, pending_write_off: pending.write_off, patient_portion: x.balance - pending.total });
    }
    return out.filter((x) => x.patient_portion >= minBalance)
      .sort((a, b) => b.patient_portion - a.patient_portion);
  };

  r.get('/statements/candidates', requirePermission('billing:read'), async (req, res) => {
    res.json(await statementCandidates(req.user.practice_id, toCents(req.query.min_balance ?? 500), Number(req.query.since_days ?? 25)));
  });

  r.post('/statements/run', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const ids = new Set((req.body?.patient_ids || []).map(Number));
    const accounts = (await statementCandidates(pid, toCents(req.body?.min_balance ?? 500), Number(req.body?.since_days ?? 25))).filter((a) => !ids.size || ids.has(a.id));
    if (!accounts.length) throw new HttpError(400, 'No accounts to statement');
    const practice = publicPractice(await db.get('SELECT * FROM practices WHERE id = ?', pid));
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const useMail = req.body?.mail !== false && mailer.enabled && mailable(practice);
    const runId = await insert(db, 'statement_runs', {
      practice_id: pid, accounts: accounts.length, total: accounts.reduce((s, a) => s + a.patient_portion, 0),
      patient_ids: JSON.stringify(accounts.map((a) => a.id)), created_by: req.user.id,
    });
    const counts = { email: 0, mail: 0, print: 0 };
    const printIds = [];
    const portalUrl = `${config.appUrl}/portal/${portalKey(practice)}`;
    for (const a of accounts) {
      let method = 'print';
      let reference = null;
      let detail = null;
      if (req.body?.email !== false && a.email && a.email_opt_in) {
        const msg = await sendMessage(db, messenger, {
          practiceId: pid, patientId: a.id, userId: req.user.id, kind: 'statement', channel: 'email', to: a.email,
          subject: `Your statement from ${practice.name}`,
          body: `Hi ${a.first_name}, your account balance at ${practice.name} is $${(a.patient_portion / 100).toFixed(2)}. You can see the details and pay online at ${portalUrl}. Questions? Call ${practice.phone || 'the office'}.`,
        });
        if (msg.status === 'sent') {
          method = 'email';
          reference = String(msg.id);
        }
      }
      if (method === 'print' && useMail && mailable(a)) {
        // Mailed statements show the last 90 days (or since the last statement) with the balance carried forward.
        const since = a.statement_sent_at ? a.statement_sent_at.slice(0, 10) : addDays(today, -90);
        const data = await statementData(db, pid, a, { family: true, since });
        try {
          const letter = await mailer.sendLetter({
            description: `Statement ${today} #${a.id}`, idempotencyKey: `statement-${runId}-${a.id}`,
            to: { name: `${a.first_name} ${a.last_name}`, address: a.address, city: a.city, state: a.state, zip: a.zip },
            from: { name: practice.name, address: practice.address, city: practice.city, state: practice.state, zip: practice.zip },
            html: statementHtml({ practice, account: a, entries: data.entries, previousBalance: data.previous_balance, balance: data.balance, pendingInsurance: a.pending_insurance, pendingWriteOff: a.pending_write_off, portalUrl, statementDate: today, aging: data.aging, plans: data.plans }),
          });
          method = 'mail';
          reference = letter.reference;
          detail = letter.expected_delivery_date ? `Expected ${letter.expected_delivery_date}` : null;
        } catch (err) {
          detail = `Mail service: ${err.message}`;
        }
      }
      if (method === 'print') printIds.push(a.id);
      counts[method]++;
      await insert(db, 'statement_deliveries', { practice_id: pid, run_id: runId, patient_id: a.id, method, amount: a.patient_portion, reference, status: method === 'print' ? 'to_print' : 'sent', detail });
      await db.run("UPDATE patients SET statement_sent_at = datetime('now') WHERE id = ?", a.id);
    }
    await db.run('UPDATE statement_runs SET emailed = ?, mailed = ?, printed = ? WHERE id = ?', counts.email, counts.mail, counts.print, runId);
    await audit(db, req, 'statements.run', 'statement_runs', runId, { accounts: accounts.length, ...counts });
    res.status(201).json({ ...(await db.get('SELECT * FROM statement_runs WHERE id = ?', runId)), print_ids: printIds, mail: mailer.name });
  });

  r.get('/statements/runs', requirePermission('billing:read'), async (req, res) => {
    res.json(await db.all('SELECT s.*, u.name AS created_by_name FROM statement_runs s LEFT JOIN users u ON u.id = s.created_by WHERE s.practice_id = ? ORDER BY s.id DESC LIMIT 50', req.user.practice_id));
  });

  // ---- Bulk recall campaign ----
  r.post('/recalls/campaign', requirePermission('schedule:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const ids = (req.body?.recall_ids || []).map(Number);
    if (!ids.length) throw new HttpError(400, 'Choose at least one patient');
    const practice = publicPractice(await db.get('SELECT * FROM practices WHERE id = ?', pid));
    let sent = 0;
    let skipped = 0;
    for (const rid of ids.slice(0, 500)) {
      const recall = await db.get('SELECT * FROM recalls WHERE id = ? AND practice_id = ?', rid, pid);
      if (!recall) continue;
      const patient = await db.get('SELECT * FROM patients WHERE id = ?', recall.patient_id);
      const target = patient.status === 'active' && recall.status !== 'inactive' ? preferredChannel(patient) : null;
      if (!target) {
        skipped++;
        continue;
      }
      const lang = patientLang(patient);
      const body = renderTemplate(templatesFor(practice, lang).recall, {
        first_name: patient.first_name, practice: practice.name, phone: practice.phone || fixedText(lang).the_office,
        link: practice.online_booking && practice.slug ? `${config.appUrl}/book/${practice.slug}${lang === 'es' ? '?lang=es' : ''}` : '',
      });
      const subject = subjectFor(lang, 'recall', `Time for your next visit at ${practice.name}`, practice.name);
      const msg = await sendMessage(db, messenger, { practiceId: pid, patientId: patient.id, userId: req.user.id, kind: 'recall', channel: target.channel, to: target.to, subject, body });
      if (msg.status === 'sent') {
        sent++;
        await db.run("UPDATE recalls SET status = 'contacted', last_contacted_at = datetime('now') WHERE id = ?", recall.id);
        await insert(db, 'followups', { practice_id: pid, patient_id: patient.id, kind: 'recall', outcome: target.channel === 'sms' ? 'texted' : 'emailed', note: 'Recall campaign', created_by: req.user.id });
      } else skipped++;
    }
    await audit(db, req, 'recalls.campaign', null, null, { sent, skipped });
    res.json({ sent, skipped });
  });

  // ---- Full practice data export (data portability / backup) ----
  const EXPORT_TABLES = [
    'practices', 'providers', 'operatories', 'appointment_types', 'procedure_codes', 'fee_schedules', 'insurance_carriers', 'patients', 'patient_insurance',
    'appointments', 'blockouts', 'procedures', 'treatment_plans', 'tooth_conditions', 'perio_exams', 'clinical_notes', 'prescriptions', 'ledger_entries',
    'claims', 'preauths', 'payment_plans', 'recalls', 'patient_forms', 'documents', 'lab_cases', 'tasks', 'messages', 'followups', 'audit_log',
    'appointment_series', 'claim_events', 'edi_batches', 'eligibility_checks', 'era_imports', 'payment_methods', 'payment_requests',
    'statement_runs', 'statement_deliveries', 'form_requests', 'booking_requests',
  ];
  r.get('/export', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const out = { exported_at: new Date().toISOString(), format: 'dentalmachine-export-v1', tables: {} };
    for (const t of EXPORT_TABLES) {
      const col = t === 'practices' ? 'id' : 'practice_id';
      out.tables[t] = (await db.all(`SELECT * FROM ${t} WHERE ${col} = ?`, pid)).map((row) => {
        const { password_hash: _p, mfa_secret: _m, confirm_token_hash: _c, sign_token_hash: _s, token_hash: _t, sso_client_secret: _k, ...rest } = row;
        return rest;
      });
    }
    out.tables.claim_items = await db.all('SELECT ci.* FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE c.practice_id = ?', pid);
    out.tables.fee_schedule_items = await db.all('SELECT i.* FROM fee_schedule_items i JOIN fee_schedules f ON f.id = i.fee_schedule_id WHERE f.practice_id = ?', pid);
    out.tables.users = await db.all('SELECT id, email, name, role, active, created_at FROM users WHERE practice_id = ?', pid);
    await audit(db, req, 'practice.export', 'practices', pid);
    res.set({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="dentalmachine-export-${(await practiceNow(db, pid)).slice(0, 10)}.json"` });
    res.send(JSON.stringify(out));
  });

  return r;
}
