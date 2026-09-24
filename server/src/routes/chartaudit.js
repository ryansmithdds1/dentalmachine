import { Router } from 'express';
import { requirePermission, can, HttpError } from '../auth.js';
import { audit, toCsv, isRealDate, practiceNow } from '../util.js';
import { canSeePatient, restricted } from '../officeaccess.js';
import {
  CHECKS, AUDIT_CHECKS, DEFAULT_RULES, CATEGORIES, cleanRules, rulesFor, checkVisit, saveFindings, runPracticeAudit, listVisits, parseVisitKey,
} from '../chartaudit.js';
import { chartCheckExtras, dictionaryFor } from '../chartcheck.js';
import { createNoteComparer } from '../ai/notecompare.js';

// Chart audit (CA1-CA4): the findings list, one visit's detail, the office's rules, "run now", and "Check my
// chart" with "ready for doctor", the doctor's review queue and the assistants' first-pass numbers.
//
// Who sees what: anyone with clinical:read sees findings on their own visits (the provider records linked to
// their login). Other providers' findings, the rules, run-now and coaching numbers are for managers: administrators,
// anyone given chartaudit:manage, or someone with practice reports who also signs notes (the owner dentist).
// People limited to some offices see those offices only.
export const canManage = (user) => user?.role === 'admin' || can(user, 'chartaudit:manage') || (can(user, 'reports:read') && can(user, 'clinical:sign'));
const SEVERITIES = ['high', 'medium', 'low'];
const STATUSES = ['open', 'acknowledged', 'resolved'];

export default function chartAuditRoutes({ db, config = {}, comparer }) {
  const r = Router();
  // The AI reader: given (tests, sandbox), or Claude when AI is on for the server. Resolved per call so a key
  // added later is picked up.
  const reader = () => (comparer !== undefined ? comparer : createNoteComparer({ config }));
  const running = new Set();

  const ownProviders = async (user) => (await db.all('SELECT id FROM providers WHERE user_id = ? AND practice_id = ?', user.id, user.practice_id)).map((p) => p.id);
  const officeFilter = (user, alias = 'f') => (restricted(user) ? { sql: ` AND (${alias}.location_id IS NULL OR ${alias}.location_id IN (${user.location_ids.map(() => '?').join(',')}))`, args: user.location_ids } : { sql: '', args: [] });
  const requireManage = (req) => { if (!canManage(req.user)) throw new HttpError(403, 'Only a manager can do this'); };

  // A visit named in the address: in this practice, and a patient this person may see.
  async function visitOr404(req) {
    const parsed = parseVisitKey(req.params.key);
    if (!parsed) throw new HttpError(404, 'Visit not found');
    const pid = req.user.practice_id;
    const patientId = parsed.appointment_id
      ? (await db.get('SELECT patient_id FROM appointments WHERE id = ? AND practice_id = ?', parsed.appointment_id, pid))?.patient_id
      : (await db.get('SELECT id FROM patients WHERE id = ? AND practice_id = ?', parsed.patient_id, pid))?.id;
    if (!patientId || !(await canSeePatient(db, req.user, patientId))) throw new HttpError(404, 'Visit not found');
    if (parsed.date && !isRealDate(parsed.date)) throw new HttpError(404, 'Visit not found');
    return { key: req.params.key, patientId };
  }

  // Findings this person may see, with the list's filters.
  async function findingsFor(req, over = {}) {
    const pid = req.user.practice_id;
    const q = { ...req.query, ...over };
    const where = ['f.practice_id = ?'];
    const args = [pid];
    const status = q.status || 'open';
    if (status !== 'all') {
      const list = String(status).split(',');
      if (list.some((s) => !STATUSES.includes(s))) throw new HttpError(400, `status must be one of: ${[...STATUSES, 'all'].join(', ')}`);
      where.push(`f.status IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
    if (q.check) {
      if (!CHECKS[q.check]) throw new HttpError(400, 'Unknown check');
      where.push('f.check_code = ?');
      args.push(q.check);
    }
    if (q.severity) {
      if (!SEVERITIES.includes(q.severity)) throw new HttpError(400, 'severity must be high, medium or low');
      where.push('f.severity = ?');
      args.push(q.severity);
    }
    for (const [k, op] of [['from', '>='], ['to', '<=']]) {
      if (!q[k]) continue;
      if (!isRealDate(q[k])) throw new HttpError(400, `${k} must be a real date (YYYY-MM-DD)`);
      where.push(`f.visit_date ${op} ?`);
      args.push(q[k]);
    }
    if (q.patient_id) {
      where.push('f.patient_id = ?');
      args.push(Number(q.patient_id) || -1);
    }
    if (q.provider_id) {
      where.push('f.provider_id = ?');
      args.push(Number(q.provider_id) || -1);
    }
    if (!canManage(req.user)) {
      // Their own visits only.
      const mine = await ownProviders(req.user);
      if (!mine.length) return [];
      where.push(`f.provider_id IN (${mine.map(() => '?').join(',')})`);
      args.push(...mine);
    }
    const office = officeFilter(req.user);
    return db.all(
      `SELECT f.*, p.first_name, p.last_name, pv.name AS provider_name, u.name AS ack_by_name FROM chart_audit_findings f
       JOIN patients p ON p.id = f.patient_id LEFT JOIN providers pv ON pv.id = f.provider_id LEFT JOIN users u ON u.id = f.ack_by
       WHERE ${where.join(' AND ')}${office.sql} ORDER BY f.risk DESC, f.visit_date DESC, f.id LIMIT 5000`, ...args, ...office.args,
    );
  }
  const view = (f) => ({ ...f, patient_name: `${f.first_name} ${f.last_name}`, check_label: CHECKS[f.check_code]?.label || f.check_code });

  r.get('/chart-audit/findings', requirePermission('clinical:read'), async (req, res) => {
    const rows = (await findingsFor(req)).map(view);
    const groups = new Map();
    for (const f of rows) {
      const g = groups.get(f.provider_id ?? 0) || { provider_id: f.provider_id, provider_name: f.provider_name || 'No provider', total: 0, high: 0, medium: 0, low: 0, visits: new Set() };
      g.total++;
      g[f.severity]++;
      g.visits.add(f.visit_key);
      groups.set(f.provider_id ?? 0, g);
    }
    const lastRun = await db.get("SELECT kind, status, visits, opened, resolved, finished_at, started_at FROM chart_audit_runs WHERE practice_id = ? AND status <> 'running' ORDER BY id DESC LIMIT 1", req.user.practice_id);
    res.json({
      findings: rows,
      groups: [...groups.values()].map((g) => ({ ...g, visits: g.visits.size })).sort((a, b) => b.high - a.high || b.total - a.total),
      checks: Object.fromEntries(Object.entries(CHECKS).map(([k, v]) => [k, { label: v.label, severity: v.severity, why: v.why }])),
      can_manage: canManage(req.user), last_run: lastRun || null,
    });
  });

  // Spreadsheet of the list as filtered (an export, so it's audited).
  r.get('/chart-audit/findings.csv', requirePermission('clinical:read'), async (req, res) => {
    const rows = (await findingsFor(req)).map(view);
    const visible = [];
    for (const f of rows) if (await canSeePatient(db, req.user, f.patient_id)) visible.push(f);
    await audit(db, req, 'chart_audit.export', 'chart_audit_findings', null, { rows: visible.length, filters: req.query });
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="chart-audit.csv"');
    res.send(toCsv(visible, [
      ['Provider', (f) => f.provider_name], ['Visit date', (f) => f.visit_date], ['Patient', (f) => f.patient_name], ['Severity', (f) => f.severity],
      ['What’s missing', (f) => f.title], ['Detail', (f) => f.detail], ['Why it matters', (f) => f.why], ['Note says', (f) => f.evidence],
      ['Found by', (f) => (f.source === 'ai' ? 'AI (review)' : 'Rule')], ['Status', (f) => f.status], ['First found', (f) => f.first_seen_at], ['Resolved', (f) => f.resolved_at],
    ]));
  });

  // Trend by provider: findings on each week's visits, and how many have been fixed.
  r.get('/chart-audit/trend', requirePermission('clinical:read'), async (req, res) => {
    const weeks = Math.min(52, Math.max(1, Number(req.query.weeks) || 12));
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const from = new Date(Date.parse(`${today}T12:00:00Z`) - weeks * 7 * 86400_000).toISOString().slice(0, 10);
    const rows = await findingsFor(req, { status: 'all', from, to: today });
    const weekOf = (d) => {
      const t = new Date(`${d}T12:00:00Z`);
      t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
      return t.toISOString().slice(0, 10);
    };
    const by = new Map();
    for (const f of rows) {
      const key = f.provider_id ?? 0;
      const p = by.get(key) || { provider_id: f.provider_id, provider_name: f.provider_name || 'No provider', weeks: {} };
      const w = weekOf(f.visit_date);
      const cell = p.weeks[w] || { week: w, found: 0, fixed: 0, open: 0, high: 0 };
      cell.found++;
      if (f.status === 'resolved') cell.fixed++;
      else cell.open++;
      if (f.severity === 'high') cell.high++;
      p.weeks[w] = cell;
      by.set(key, p);
    }
    res.json([...by.values()].map((p) => ({ ...p, weeks: Object.values(p.weeks).sort((a, b) => a.week.localeCompare(b.week)) })));
  });

  // One visit: what was charted, the notes, and every finding (fixed ones too).
  r.get('/chart-audit/visits/:key', requirePermission('clinical:read'), async (req, res) => {
    const { key } = await visitOr404(req);
    const pid = req.user.practice_id;
    const out = await checkVisit(db, pid, key, { comparer: null });
    if (!out) throw new HttpError(404, 'Visit not found');
    const { ctx } = out;
    if (!canManage(req.user)) {
      const mine = await ownProviders(req.user);
      const theirs = [ctx.provider_id, ...ctx.procedures.map((p) => p.provider_id)].filter(Boolean);
      if (!theirs.some((id) => mine.includes(id))) throw new HttpError(403, 'Only managers can see other providers’ chart audits');
    }
    const patient = await db.get('SELECT id, first_name, last_name FROM patients WHERE id = ?', ctx.patient_id);
    const findings = (await db.all('SELECT f.*, u.name AS ack_by_name FROM chart_audit_findings f LEFT JOIN users u ON u.id = f.ack_by WHERE f.practice_id = ? AND f.visit_key = ? ORDER BY f.status, f.risk DESC, f.id', pid, key))
      .map((f) => ({ ...f, check_label: CHECKS[f.check_code]?.label || f.check_code }));
    res.json({
      visit: { key, appointment_id: ctx.appointment_id, date: ctx.date, patient_id: ctx.patient_id, patient_name: `${patient.first_name} ${patient.last_name}`, provider_id: ctx.provider_id, provider_names: ctx.providerNames },
      procedures: ctx.procedures.map((p) => ({ id: p.id, code: p.code, description: p.description, tooth: p.tooth, surfaces: p.surfaces, status: p.status, category: p.category })),
      notes: ctx.notes.map((n) => ({ id: n.id, body: n.body, signed: n.signed, signed_at: n.signed_at, signed_by_name: n.signed_by_name, created_at: n.created_at, addenda: ctx.addenda.filter((a) => a.addendum_of === n.id).map((a) => ({ id: a.id, body: a.body, signed: a.signed, created_at: a.created_at })) })),
      findings,
      ready: await db.get("SELECT cr.*, u.name AS prepared_by_name FROM chart_ready cr LEFT JOIN users u ON u.id = cr.prepared_by WHERE cr.practice_id = ? AND cr.visit_key = ? AND cr.status = 'ready'", pid, key) || null,
    });
  });

  // A manager (or the visit's own provider) can set a finding aside with a reason; it stays on the record.
  r.post('/chart-audit/findings/:id/acknowledge', requirePermission('clinical:read'), async (req, res) => {
    const f = await db.get('SELECT * FROM chart_audit_findings WHERE id = ? AND practice_id = ?', Number(req.params.id), req.user.practice_id);
    if (!f || !(await canSeePatient(db, req.user, f.patient_id))) throw new HttpError(404, 'Finding not found');
    if (!canManage(req.user) && !(await ownProviders(req.user)).includes(f.provider_id)) throw new HttpError(403, 'Only a manager or the visit’s provider can do this');
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) throw new HttpError(400, 'Say why (a few words)');
    if (f.status === 'resolved') throw new HttpError(409, 'This was already fixed');
    if (f.status === 'acknowledged' && f.ack_reason === reason.slice(0, 500)) return res.json(f);
    await db.run("UPDATE chart_audit_findings SET status = 'acknowledged', ack_reason = ?, ack_by = ?, ack_at = datetime('now') WHERE id = ?", reason.slice(0, 500), req.user.id, f.id);
    await audit(db, req, 'chart_audit.acknowledge', 'chart_audit_findings', f.id, { check: f.check_code, visit: f.visit_key }, { reason, patientId: f.patient_id, before: { status: f.status }, after: { status: 'acknowledged' } });
    res.json(await db.get('SELECT * FROM chart_audit_findings WHERE id = ?', f.id));
  });
  r.post('/chart-audit/findings/:id/reopen', requirePermission('clinical:read'), async (req, res) => {
    const f = await db.get('SELECT * FROM chart_audit_findings WHERE id = ? AND practice_id = ?', Number(req.params.id), req.user.practice_id);
    if (!f || !(await canSeePatient(db, req.user, f.patient_id))) throw new HttpError(404, 'Finding not found');
    requireManage(req);
    if (f.status !== 'acknowledged') throw new HttpError(409, 'Only a set-aside finding can be reopened');
    await db.run("UPDATE chart_audit_findings SET status = 'open' WHERE id = ?", f.id);
    await audit(db, req, 'chart_audit.reopen', 'chart_audit_findings', f.id, { check: f.check_code }, { patientId: f.patient_id, before: { status: 'acknowledged' }, after: { status: 'open' } });
    res.json(await db.get('SELECT * FROM chart_audit_findings WHERE id = ?', f.id));
  });

  // ---- The office's rules ----
  r.get('/chart-audit/rules', requirePermission('clinical:read'), async (req, res) => {
    res.json({ rules: await rulesFor(db, req.user.practice_id), defaults: DEFAULT_RULES, categories: CATEGORIES, checks: Object.fromEntries(AUDIT_CHECKS.map((k) => [k, { label: CHECKS[k].label, why: CHECKS[k].why }])), can_manage: canManage(req.user), ai: !!reader() });
  });
  r.put('/chart-audit/rules', requirePermission('clinical:read'), async (req, res) => {
    requireManage(req);
    const pid = req.user.practice_id;
    const before = await rulesFor(db, pid);
    let next;
    try {
      next = cleanRules(req.body || {}, before);
    } catch (err) {
      throw new HttpError(err.status || 400, err.message);
    }
    const flat = (o) => Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (k === 'checks' ? Object.entries(v).map(([c, on]) => [`check.${c}`, on ? 1 : 0]) : [[k, Array.isArray(v) ? v.join(' ') : v]])));
    const exists = await db.get('SELECT id FROM chart_audit_rules WHERE practice_id = ?', pid);
    if (exists) await db.run("UPDATE chart_audit_rules SET settings = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify(next), req.user.id, exists.id);
    else await db.run('INSERT INTO chart_audit_rules (practice_id, settings, updated_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', pid, JSON.stringify(next), req.user.id);
    await audit(db, req, 'chart_audit.rules', 'chart_audit_rules', exists?.id ?? null, null, { before: flat(before), after: flat(next) });
    res.json({ rules: next });
  });

  // Run now: the whole lookback window, once at a time per practice (a second click while it runs gets the same run).
  r.post('/chart-audit/run', requirePermission('clinical:read'), async (req, res) => {
    requireManage(req);
    const pid = req.user.practice_id;
    const busy = await db.get("SELECT * FROM chart_audit_runs WHERE practice_id = ? AND status = 'running' AND started_at > ? ORDER BY id DESC LIMIT 1", pid, new Date(Date.now() - 15 * 60_000).toISOString().replace('T', ' ').slice(0, 19));
    if (running.has(pid) || busy) return res.status(202).json({ running: true, run: busy || null });
    running.add(pid);
    try {
      const out = await runPracticeAudit(db, pid, { kind: 'manual', runKey: `manual:${Date.now()}`, comparer: reader(), userId: req.user.id });
      await audit(db, req, 'chart_audit.run', 'chart_audit_runs', out.run_id, { visits: out.visits, opened: out.opened, resolved: out.resolved });
      res.json(out);
    } finally {
      running.delete(pid);
    }
  });

  // ---- "Check my chart" (CA4) ----
  // Every chart-audit check on this visit right now (except signing, which is the doctor's), plus spelling and
  // grammar, template questions and the note's link to the visit; each with a fix the screen can apply.
  async function checkNow(req, key) {
    const pid = req.user.practice_id;
    const ai = reader();
    const out = await checkVisit(db, pid, key, { comparer: ai });
    if (!out) throw new HttpError(404, 'Visit not found');
    await saveFindings(db, out.ctx, out.findings);
    const extra = (await db.all('SELECT description FROM procedure_codes WHERE practice_id = ?', pid)).map((c) => c.description);
    const templates = (await db.all('SELECT body FROM note_templates WHERE practice_id = ? AND active = 1', pid)).map((t) => t.body.replace(/\[\[|\]\]|\{\w+\}/g, ' '));
    const extras = await chartCheckExtras(out.ctx, { dictionary: dictionaryFor([...extra, ...templates]), comparer: ai });
    const items = [...out.findings.filter((f) => f.check !== 'unsigned_note'), ...extras].map((f) => ({
      check: f.check, subject: f.subject, label: CHECKS[f.check]?.label, title: f.title, detail: f.detail, why: CHECKS[f.check]?.why, severity: f.severity, source: f.source, evidence: f.evidence, fix: f.fix,
    }));
    const order = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => order[a.severity] - order[b.severity]);
    return { ctx: out.ctx, items };
  }

  r.post('/chart-audit/visits/:key/check', requirePermission('clinical:write'), async (req, res) => {
    const { key, patientId } = await visitOr404(req);
    const pid = req.user.practice_id;
    const { ctx, items } = await checkNow(req, key);
    const first = !(await db.get('SELECT id FROM chart_checks WHERE practice_id = ? AND visit_key = ?', pid, key));
    const { id } = await db.run(
      'INSERT INTO chart_checks (practice_id, patient_id, appointment_id, visit_key, checked_by, problems, items, first_pass) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      pid, patientId, ctx.appointment_id, key, req.user.id, items.length, JSON.stringify(items.map((i) => ({ check: i.check, subject: i.subject, title: i.title }))), first ? 1 : 0,
    );
    const ready = await db.get("SELECT cr.*, u.name AS prepared_by_name FROM chart_ready cr LEFT JOIN users u ON u.id = cr.prepared_by WHERE cr.practice_id = ? AND cr.visit_key = ? AND cr.status = 'ready'", pid, key);
    // The note being checked, so the screen can apply a one-click fix through the normal note update.
    const note = ctx.notes.find((n) => !n.signed) || ctx.notes[0] || null;
    res.json({
      check_id: id, visit_key: key, appointment_id: ctx.appointment_id, patient_id: patientId, note: note ? { id: note.id, body: note.body, signed: !!note.signed, author_id: note.author_id } : null,
      first_pass: first, problems: items.length, items, ready: ready || null,
    });
  });

  // Ready for doctor: clean, or every remaining item set aside with a reason. Who prepared it and when is kept.
  r.post('/chart-audit/visits/:key/ready', requirePermission('clinical:write'), async (req, res) => {
    const { key, patientId } = await visitOr404(req);
    const pid = req.user.practice_id;
    const { ctx, items } = await checkNow(req, key);
    const acks = Array.isArray(req.body?.acknowledged) ? req.body.acknowledged : [];
    const reasonFor = (i) => acks.find((a) => a && a.check === i.check && String(a.subject ?? '') === String(i.subject ?? ''));
    const open = items.filter((i) => !reasonFor(i) || String(reasonFor(i).reason || '').trim().length < 3);
    if (open.length) throw new HttpError(409, `${open.length} item${open.length === 1 ? '' : 's'} still open — fix ${open.length === 1 ? 'it' : 'them'}, or say why ${open.length === 1 ? 'it’s' : 'they’re'} fine`, { open });
    const acknowledged = items.map((i) => ({ check: i.check, subject: i.subject, title: i.title, reason: String(reasonFor(i).reason).trim().slice(0, 300) }));
    const firstCheck = await db.get('SELECT problems FROM chart_checks WHERE practice_id = ? AND visit_key = ? ORDER BY id LIMIT 1', pid, key);
    const live = await db.get("SELECT * FROM chart_ready WHERE practice_id = ? AND visit_key = ? AND status = 'ready'", pid, key);
    if (live && live.prepared_by === req.user.id && live.open_items === items.length && live.acknowledged === JSON.stringify(acknowledged)) return res.json(live);
    const id = await db.tx(async () => {
      if (live) await db.run("UPDATE chart_ready SET status = 'withdrawn', withdrawn_at = datetime('now'), withdrawn_by = ? WHERE id = ?", req.user.id, live.id);
      const row = await db.run(
        'INSERT INTO chart_ready (practice_id, patient_id, appointment_id, visit_key, prepared_by, open_items, acknowledged, first_pass_clean) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        pid, patientId, ctx.appointment_id, key, req.user.id, items.length, JSON.stringify(acknowledged), firstCheck ? (firstCheck.problems === 0 ? 1 : 0) : (items.length ? 0 : 1),
      );
      // Items that are chart-audit findings are set aside on the report too, with the same reason.
      for (const a of acknowledged) {
        await db.run("UPDATE chart_audit_findings SET status = 'acknowledged', ack_reason = ?, ack_by = ?, ack_at = datetime('now') WHERE practice_id = ? AND visit_key = ? AND check_code = ? AND subject = ? AND status = 'open'", a.reason, req.user.id, pid, key, a.check, a.subject);
      }
      return row.id;
    });
    await audit(db, req, 'chart.ready_for_doctor', 'chart_ready', id, { visit: key, open_items: items.length, acknowledged: acknowledged.map((a) => `${a.title}: ${a.reason}`) }, { patientId });
    res.status(201).json(await db.get('SELECT * FROM chart_ready WHERE id = ?', id));
  });

  r.post('/chart-audit/visits/:key/ready/withdraw', requirePermission('clinical:write'), async (req, res) => {
    const { key, patientId } = await visitOr404(req);
    const live = await db.get("SELECT * FROM chart_ready WHERE practice_id = ? AND visit_key = ? AND status = 'ready'", req.user.practice_id, key);
    if (!live) return res.json({ ok: true });
    await db.run("UPDATE chart_ready SET status = 'withdrawn', withdrawn_at = datetime('now'), withdrawn_by = ? WHERE id = ?", req.user.id, live.id);
    await audit(db, req, 'chart.ready_withdrawn', 'chart_ready', live.id, { visit: key }, { patientId });
    res.json({ ok: true });
  });

  // The doctor's review queue: recent visits whose note still needs the doctor, and whether the assistant checked
  // them clean, left items open (with reasons) or didn't check them — and who prepared each.
  r.get('/chart-audit/doctor-queue', requirePermission('clinical:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const from = new Date(Date.parse(`${today}T12:00:00Z`) - days * 86400_000).toISOString().slice(0, 10);
    let providers = await ownProviders(req.user);
    if (req.query.provider_id) {
      const want = Number(req.query.provider_id);
      if (!canManage(req.user) && !providers.includes(want)) throw new HttpError(403, 'Only managers can see another provider’s queue');
      providers = [want];
    } else if (canManage(req.user) && req.query.all === '1') providers = null;
    if (providers && !providers.length) return res.json([]);
    const visits = new Map((await listVisits(db, pid, from, today)).map((v) => [v.key, v]));
    // Visits an assistant already checked (they may not be marked completed yet).
    for (const c of await db.all("SELECT DISTINCT visit_key FROM chart_checks WHERE practice_id = ? AND created_at >= ?", pid, `${from} 00:00:00`)) {
      if (visits.has(c.visit_key)) continue;
      const parsed = parseVisitKey(c.visit_key);
      if (parsed?.appointment_id) {
        const a = await db.get('SELECT id, patient_id, provider_id, location_id, start_time FROM appointments WHERE id = ? AND practice_id = ?', parsed.appointment_id, pid);
        if (a) visits.set(c.visit_key, { key: c.visit_key, appointment_id: a.id, patient_id: a.patient_id, provider_id: a.provider_id, location_id: a.location_id, date: a.start_time.slice(0, 10) });
      }
    }
    const rows = [];
    for (const v of visits.values()) {
      if (providers && !providers.includes(v.provider_id)) continue;
      if (restricted(req.user) && v.location_id && !req.user.location_ids.includes(v.location_id)) continue;
      const notes = v.appointment_id ? await db.all('SELECT id, signed FROM clinical_notes WHERE appointment_id = ? AND addendum_of IS NULL', v.appointment_id) : [];
      const signed = notes.length > 0 && notes.every((n) => n.signed);
      if (signed && req.query.include_signed !== '1') continue;
      const last = await db.get('SELECT c.problems, c.created_at, u.name AS checked_by_name FROM chart_checks c LEFT JOIN users u ON u.id = c.checked_by WHERE c.practice_id = ? AND c.visit_key = ? ORDER BY c.id DESC LIMIT 1', pid, v.key);
      const ready = await db.get("SELECT cr.ready_at, cr.open_items, cr.acknowledged, u.name AS prepared_by_name FROM chart_ready cr LEFT JOIN users u ON u.id = cr.prepared_by WHERE cr.practice_id = ? AND cr.visit_key = ? AND cr.status = 'ready'", pid, v.key);
      const patient = await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', v.patient_id);
      const state = ready ? (ready.open_items ? 'ready_with_notes' : 'clean') : last ? (last.problems ? 'open_items' : 'checked') : 'not_checked';
      rows.push({
        visit_key: v.key, appointment_id: v.appointment_id, patient_id: v.patient_id, patient_name: `${patient.first_name} ${patient.last_name}`, date: v.date, provider_id: v.provider_id,
        note_id: notes[0]?.id ?? null, note: notes.length ? (signed ? 'signed' : 'unsigned') : 'none', state,
        prepared_by: ready?.prepared_by_name || null, ready_at: ready?.ready_at || null, acknowledged: ready?.acknowledged ? JSON.parse(ready.acknowledged) : [],
        last_check: last ? { problems: last.problems, at: last.created_at, by: last.checked_by_name } : null,
      });
    }
    const order = { clean: 0, ready_with_notes: 1, checked: 2, open_items: 3, not_checked: 4 };
    rows.sort((a, b) => order[a.state] - order[b.state] || b.date.localeCompare(a.date));
    res.json(rows);
  });

  // Coaching (managers): each assistant's first-pass clean rate — of the visits they checked first, how many had
  // nothing to fix — by week.
  r.get('/chart-audit/coaching', requirePermission('clinical:read'), async (req, res) => {
    requireManage(req);
    const weeks = Math.min(52, Math.max(1, Number(req.query.weeks) || 12));
    const since = new Date(Date.now() - weeks * 7 * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
    const rows = await db.all(
      `SELECT c.checked_by, u.name, c.problems, c.created_at FROM chart_checks c LEFT JOIN users u ON u.id = c.checked_by
       WHERE c.practice_id = ? AND c.first_pass = 1 AND c.created_at >= ? ORDER BY c.created_at`, req.user.practice_id, since,
    );
    const weekOf = (d) => {
      const t = new Date(`${d.slice(0, 10)}T12:00:00Z`);
      t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
      return t.toISOString().slice(0, 10);
    };
    const people = new Map();
    for (const r0 of rows) {
      const p = people.get(r0.checked_by) || { user_id: r0.checked_by, name: r0.name || 'Unknown', checked: 0, clean: 0, problems: 0, weeks: {} };
      const w = p.weeks[weekOf(r0.created_at)] || { week: weekOf(r0.created_at), checked: 0, clean: 0 };
      p.checked++;
      w.checked++;
      p.problems += r0.problems;
      if (!r0.problems) { p.clean++; w.clean++; }
      p.weeks[w.week] = w;
      people.set(r0.checked_by, p);
    }
    res.json([...people.values()].map((p) => ({
      ...p, clean_rate: p.checked ? Math.round((100 * p.clean) / p.checked) : null, avg_problems: p.checked ? Math.round((10 * p.problems) / p.checked) / 10 : null,
      weeks: Object.values(p.weeks).sort((a, b) => a.week.localeCompare(b.week)).map((w) => ({ ...w, rate: Math.round((100 * w.clean) / w.checked) })),
    })).sort((a, b) => a.name.localeCompare(b.name)));
  });

  return r;
}
