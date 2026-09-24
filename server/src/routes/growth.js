import { Router } from 'express';
import { restricted, canSeePatient, requireVisiblePatients } from '../officeaccess.js';
import { requirePermission, HttpError } from '../auth.js';
import { insert, audit, practiceNow, toCents, publicPractice, toCsv } from '../util.js';
import { backupTables } from '../backup.js';
import { sendMessage, preferredChannel } from '../messaging.js';
import { renderTemplate, templatesFor, patientLang, fixedText, subjectFor, messageText } from '../templates.js';
import { mailable, statementHtml } from '../mail.js';
import { statementData } from './billing.js';
import { portalKey } from './portal.js';
import { pendingInsurance } from '../services.js';
import { allocationsForRange } from '../allocation.js';
import { computeMetrics, adjustmentKind } from '../metrics.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

// Practice analytics (KPIs), statement batches, bulk recall and full data export.
// Which kind of credit adjustment an entry is, for the KPI split (defined with the KPIs in metrics.js).
export { adjustmentKind };

export default function growthRoutes({ db, messenger, config, mailer = { enabled: false } }) {
  const r = Router();

  r.get('/analytics', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const from = req.query.from || addDays(today, -89);
    const to = req.query.to || today;
    if (!DATE.test(from) || !DATE.test(to)) throw new HttpError(400, 'from/to must be YYYY-MM-DD');
    const range = [pid, from, to];
    const one = async (sql, ...p) => (await db.get(sql, ...p)).n;
    // One provider's numbers: their production, visits and plans; payments and write-offs credited to
    // their work (the same allocation as Collections by provider).
    const prov = Number(req.query.provider_id) || null;
    const byProv = (col = 'provider_id') => (prov ? ` AND ${col} = ${prov}` : '');

    // The headline numbers come from the one set of KPI definitions (metrics.js, docs/metrics.md), so this screen,
    // Reports → Metrics and the metric emails always show the same number. New patients and recall are counted for
    // the whole practice even when one provider is picked (as before).
    const K = ['production_gross', 'adjustments', 'collections', 'collection_rate', 'case_acceptance', 'hygiene_reappointment', 'broken_appointments', 'broken_rate'];
    const { values: v, parts: pt } = await computeMetrics(db, pid, { from, to, today, providerId: prov, keys: K });
    const whole = await computeMetrics(db, pid, { from, to, today, keys: ['new_patients', 'recall_current_rate'] });
    const production = v.production_gross;
    const collections = v.collections;
    const split = pt.adjustments;
    const adjustments = v.adjustments;
    const hygieneProduction = await one(
      `SELECT COALESCE(SUM(l.amount),0) AS n FROM ledger_entries l JOIN providers pv ON pv.id = l.provider_id
       WHERE l.practice_id = ? AND l.type = 'charge' AND pv.type = 'hygienist' AND l.entry_date BETWEEN ? AND ?${byProv('l.provider_id')}`, ...range,
    );
    const kept = pt.broken_rate.kept;
    const broken = pt.broken_rate.broken;
    const noShows = pt.broken_appointments.no_shows;
    const plans = pt.case_acceptance;
    const hyg = pt.hygiene_reappointment;
    const newPatients = whole.parts.new_patients.by_source;
    const active = await one(
      `SELECT COUNT(DISTINCT patient_id) AS n FROM appointments WHERE practice_id = ? AND status = 'completed' AND start_time >= ?`,
      pid, `${addDays(today, -547)} 00:00`,
    );
    const byProvider = await db.all(
      `SELECT pv.id, pv.name, pv.type, COALESCE(SUM(l.amount),0) AS production, COUNT(DISTINCT l.patient_id) AS patients
       FROM providers pv LEFT JOIN ledger_entries l ON l.provider_id = pv.id AND l.type = 'charge' AND l.entry_date BETWEEN ? AND ?
       WHERE pv.practice_id = ? AND pv.active = 1${byProv('pv.id')} GROUP BY pv.id ORDER BY production DESC`, from, to, pid,
    );
    const days = Math.max(1, (Date.parse(to) - Date.parse(from)) / 86400_000 + 1);
    const monthly = await db.all(
      `SELECT substr(entry_date, 1, 7) AS month,
         SUM(CASE WHEN type = 'charge' THEN amount ELSE 0 END) AS production,
         -SUM(CASE WHEN type IN ('payment','insurance_payment') THEN amount ELSE 0 END) AS collections
       FROM ledger_entries WHERE practice_id = ? AND entry_date >= ? GROUP BY month ORDER BY month`, pid, `${addDays(today, -365).slice(0, 7)}-01`,
    );
    if (prov) {
      // For one provider: their production each month, and the payments credited to their work.
      const start = `${addDays(today, -365).slice(0, 7)}-01`;
      const prodRows = await db.all(`SELECT substr(entry_date, 1, 7) AS month, SUM(amount) AS n FROM ledger_entries WHERE practice_id = ? AND type = 'charge' AND entry_date >= ?${byProv()} GROUP BY month`, pid, start);
      const alloc = (await allocationsForRange(db, pid, start, today)).filter((a) => a.provider_id === prov && ['payment', 'insurance_payment'].includes(a.credit_type));
      const months = new Map(monthly.map((m) => [m.month, { month: m.month, production: 0, collections: 0 }]));
      for (const p of prodRows) (months.get(p.month) || months.set(p.month, { month: p.month, production: 0, collections: 0 }).get(p.month)).production = p.n;
      for (const a of alloc) { const k = a.credit_date.slice(0, 7); (months.get(k) || months.set(k, { month: k, production: 0, collections: 0 }).get(k)).collections += a.amount; }
      monthly.splice(0, monthly.length, ...[...months.values()].sort((a, b) => a.month.localeCompare(b.month)));
    }

    res.json({
      from, to, provider_id: prov,
      production, collections, adjustments, ...split, hygiene_production: hygieneProduction,
      net_production: production - adjustments,
      collection_rate: v.collection_rate,
      avg_daily_production: Math.round(production / days),
      appointments: { kept, broken, no_shows: noShows, no_show_rate: pct(noShows, kept + broken) },
      case_acceptance: { presented: plans.presented, accepted: plans.accepted, rate: pct(plans.accepted, plans.presented), plans: plans.plans, accepted_plans: plans.accepted_plans },
      hygiene_reappointment: { visits: hyg.visits, reappointed: hyg.reappointed || 0, rate: pct(hyg.reappointed || 0, hyg.visits) },
      new_patients: { total: newPatients.reduce((s, x) => s + x.n, 0), by_source: newPatients },
      active_patients: active,
      recall_current_rate: whole.values.recall_current_rate,
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
    res.json((await statementCandidates(req.user.practice_id, toCents(req.query.min_balance ?? 500), Number(req.query.since_days ?? 25))).map((a) => ({ ...a, patient_id: a.id })));
  });

  r.post('/statements/run', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const ids = new Set((req.body?.patient_ids || []).map(Number));
    let accounts = (await statementCandidates(pid, toCents(req.body?.min_balance ?? 500), Number(req.body?.since_days ?? 25))).filter((a) => !ids.size || ids.has(a.id));
    // Someone limited to some offices statements only their offices' accounts.
    if (restricted(req.user)) {
      const mine = [];
      for (const a of accounts) if (await canSeePatient(db, req.user, a.id)) mine.push(a);
      accounts = mine;
    }
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
          subject: subjectFor(patientLang(a), 'statement', `Your statement from ${practice.name}`, practice.name),
          body: await messageText(db, pid, 'statement', { first_name: a.first_name, amount: a.patient_portion, link: portalUrl }, patientLang(a)),
        });
        if (msg.status === 'sent') {
          method = 'email';
          reference = String(msg.id);
        }
      }
      if (method === 'print' && useMail && mailable(a)) {
        // Mailed statements show the last 90 days (or since the last statement) with the balance carried forward.
        const since = a.statement_sent_at ? a.statement_sent_at.slice(0, 10) : addDays(today, -90);
        const data = await statementData(db, pid, a, { family: true, since, appUrl: config.appUrl });
        try {
          const letter = await mailer.sendLetter({
            description: `Statement ${today} #${a.id}`, idempotencyKey: `statement-${runId}-${a.id}`,
            to: { name: `${a.first_name} ${a.last_name}`, address: a.address, city: a.city, state: a.state, zip: a.zip },
            from: { name: practice.name, address: practice.address, city: practice.city, state: practice.state, zip: practice.zip },
            html: statementHtml({ practice, account: a, entries: data.entries, previousBalance: data.previous_balance, balance: data.balance, pendingInsurance: a.pending_insurance, pendingWriteOff: a.pending_write_off, portalUrl, statementDate: today, aging: data.aging, plans: data.plans, payCode: data.pay_code, billpayPage: data.billpay_page }),
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
    if (restricted(req.user)) {
      const owners = await db.all(`SELECT patient_id FROM recalls WHERE practice_id = ? AND id IN (${ids.map(() => '?').join(',')})`, pid, ...ids);
      await requireVisiblePatients(db, req.user, owners.map((o) => o.patient_id));
    }
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

  // ---- Full practice data export (data portability) ----
  // Every table that holds this practice's data (the same list backups use, so a new table is included
  // automatically), without sign-in secrets or internal storage keys: one JSON file, or any table as CSV.
  const SECRET = /(_hash$|^mfa_secret$|secret|_token$|^token$|^storage_key$|^thumb_key$|^recording_key$|^api_key)/;
  const scrubRow = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !SECRET.test(k)));
  const exportRows = (t, pid) => db.all(`SELECT * FROM ${t.table} WHERE ${t.where}${t.cols.some((c) => c.name === 'id') ? ' ORDER BY id' : ''}`, pid).then((rows) => rows.map(scrubRow));
  r.get('/export', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const out = { exported_at: new Date().toISOString(), format: 'dentalmachine-export-v2', tables: {} };
    for (const t of backupTables()) out.tables[t.table] = await exportRows(t, pid);
    await audit(db, req, 'practice.export', 'practices', pid);
    res.set({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="dentalmachine-export-${(await practiceNow(db, pid)).slice(0, 10)}.json"` });
    res.send(JSON.stringify(out));
  });
  r.get('/export/tables', requireAdmin, async (req, res) => {
    const list = [];
    for (const t of backupTables()) list.push({ table: t.table, rows: Number((await db.get(`SELECT COUNT(*) AS n FROM ${t.table} WHERE ${t.where}`, req.user.practice_id)).n) });
    res.json(list.filter((t) => t.rows > 0));
  });
  r.get('/export/:table.csv', requireAdmin, async (req, res) => {
    const t = backupTables().find((x) => x.table === req.params.table);
    if (!t) throw new HttpError(404, 'No such dataset');
    const rows = await exportRows(t, req.user.practice_id);
    const cols = t.cols.map((c) => c.name).filter((k) => !SECRET.test(k));
    await audit(db, req, 'practice.export_table', 'practices', req.user.practice_id, { table: t.table, rows: rows.length });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${t.table}.csv"`, 'Cache-Control': 'no-store' });
    res.send(toCsv(rows, cols.map((k) => [k, (row) => row[k]])));
  });

  return r;
}
