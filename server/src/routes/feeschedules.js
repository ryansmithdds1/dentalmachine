import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { audit, mapSeq } from '../util.js';
import { currentActor, setActor } from '../actor.js';
import {
  ensureFeeSchema, scheduleFor, scheduleKey, currentVersion, versionItems, liveItems, resolveFee, localToday, increaseParams, previewIncrease,
  scheduleIncrease, editChange, approveImport, cancelChange, changeView, createImportDraft, checkEffectiveDate, requireDay, fileHash, newGroupId, ROUNDING,
} from '../feeversions.js';
import { createFeeReader } from '../feeimport.js';

// Fee schedules: % increases (now or on a date), payer schedule imports (AI or spreadsheet → draft → a person
// approves), and the version history of every schedule. Changing fees is sensitive: fees:manage (admins have
// it) and, when the assistant asks, the person's on-screen OK — the same rule aiguard.js applies to HIGH_RISK
// paths, repeated here so it holds even before these paths are listed there.
const FEES = 'fees:manage';

function humanApproved(req, res, next) {
  const ctx = currentActor();
  if (ctx?.source !== 'ai' || ctx.approvedBy) return next();
  if (req.get('X-Human-Approved') !== '1') {
    return res.status(428).json({ error: 'The assistant can’t change fees without your OK (fee changes). Confirm it, or do it yourself.', needs_approval: true });
  }
  setActor({ actor: `Assistant (for ${req.user.name}, approved by ${req.user.name})`, approvedBy: req.user.id });
  next();
}

const idOf = (v, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label} must be an id`);
  return n;
};

export default function feeScheduleRoutes({ db, config = {} }) {
  const r = Router();
  const reader = createFeeReader({ config });
  const ready = ensureFeeSchema(db);
  r.use('/fees', async (_req, _res, next) => {
    try { await ready; next(); } catch (err) { next(err); }
  });

  const userNames = async (pid) => new Map((await db.all('SELECT id, name FROM users WHERE practice_id = ?', pid)).map((u) => [u.id, u.name]));
  const findChange = async (req) => {
    const ch = await db.get('SELECT * FROM fee_changes WHERE id = ? AND practice_id = ?', idOf(req.params.cid, 'change'), req.user.practice_id);
    if (!ch) throw new HttpError(404, 'Fee change not found');
    return ch;
  };

  // Every schedule (the standard fees first) with its current version, when it was last updated and by whom,
  // and what's waiting (scheduled changes, drafts to approve).
  r.get('/fees/schedules', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const names = await userNames(pid);
    const list = [{ id: null, name: 'Standard office fees', kind: 'standard', active: 1 }, ...await db.all('SELECT id, name, kind, active FROM fee_schedules WHERE practice_id = ? ORDER BY active DESC, name', pid)];
    res.json(await mapSeq(list, async (fs) => {
      const key = scheduleKey(fs.id);
      const cur = await currentVersion(db, pid, fs.id);
      const lastVersion = await db.get("SELECT created_at, created_by, source FROM fee_schedule_versions WHERE practice_id = ? AND schedule_key = ? AND source != 'baseline' ORDER BY created_at DESC, id DESC LIMIT 1", pid, key);
      const lastHist = fs.id
        ? await db.get('SELECT changed_at, changed_by FROM fee_history WHERE practice_id = ? AND fee_schedule_id = ? ORDER BY id DESC LIMIT 1', pid, fs.id)
        : await db.get('SELECT changed_at, changed_by FROM fee_history WHERE practice_id = ? AND fee_schedule_id IS NULL ORDER BY id DESC LIMIT 1', pid);
      const last = [lastVersion && { at: lastVersion.created_at, by: lastVersion.created_by, how: lastVersion.source }, lastHist && { at: lastHist.changed_at, by: lastHist.changed_by, how: 'edited' }]
        .filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
      const pending = await db.all("SELECT status, COUNT(*) AS n FROM fee_changes WHERE practice_id = ? AND schedule_key = ? AND status IN ('draft','scheduled') GROUP BY status", pid, key);
      const next = await db.get("SELECT id, kind, effective_date FROM fee_changes WHERE practice_id = ? AND schedule_key = ? AND status = 'scheduled' ORDER BY effective_date, id LIMIT 1", pid, key);
      return {
        ...fs, key,
        code_count: (await liveItems(db, pid, fs.id)).size,
        carriers: fs.id ? await db.all('SELECT id, name FROM insurance_carriers WHERE fee_schedule_id = ? AND practice_id = ?', fs.id, pid) : [],
        current_version: cur ? { id: cur.id, version_no: cur.version_no, effective_from: cur.effective_from, source: cur.source } : null,
        versions: Number((await db.get('SELECT COUNT(*) AS n FROM fee_schedule_versions WHERE practice_id = ? AND schedule_key = ?', pid, key)).n),
        last_updated_at: last?.at || null, last_updated_by: last?.by ? names.get(last.by) || null : null, last_updated_how: last?.how || null,
        drafts: Number(pending.find((p) => p.status === 'draft')?.n || 0), scheduled: Number(pending.find((p) => p.status === 'scheduled')?.n || 0),
        next_change: next || null,
      };
    }));
  });

  // One schedule's versions, newest first (the screen hides them until asked).
  r.get('/fees/schedules/:key/versions', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const fs = await scheduleFor(db, pid, req.params.key === 'standard' ? null : idOf(req.params.key, 'schedule'));
    const names = await userNames(pid);
    const rows = await db.all('SELECT * FROM fee_schedule_versions WHERE practice_id = ? AND schedule_key = ? ORDER BY effective_from DESC, version_no DESC', pid, fs.key);
    const cur = rows[0]?.id;
    res.json({
      schedule: { id: fs.id, key: fs.key, name: fs.name, kind: fs.kind },
      versions: rows.map((v) => ({ ...v, current: v.id === cur, created_by_name: names.get(v.created_by) || null, approved_by_name: names.get(v.approved_by) || null })),
    });
  });

  r.get('/fees/versions/:vid', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const v = await db.get('SELECT * FROM fee_schedule_versions WHERE id = ? AND practice_id = ?', idOf(req.params.vid, 'version'), pid);
    if (!v) throw new HttpError(404, 'Version not found');
    const desc = new Map((await db.all('SELECT code, description FROM procedure_codes WHERE practice_id = ?', pid)).map((x) => [x.code, x.description]));
    const items = [...await versionItems(db, v.id)].map(([code, fee]) => ({ code, fee, description: desc.get(code) || null }));
    res.json({ ...v, items });
  });

  // Side by side: any two versions (of one schedule, or two schedules), code by code.
  r.get('/fees/compare', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const load = async (id) => {
      const v = await db.get('SELECT * FROM fee_schedule_versions WHERE id = ? AND practice_id = ?', idOf(id, 'version'), pid);
      if (!v) throw new HttpError(404, 'Version not found');
      return { v, items: await versionItems(db, v.id) };
    };
    const a = await load(req.query.a);
    const b = await load(req.query.b);
    const desc = new Map((await db.all('SELECT code, description FROM procedure_codes WHERE practice_id = ?', pid)).map((x) => [x.code, x.description]));
    const codes = [...new Set([...a.items.keys(), ...b.items.keys()])].sort();
    const rows = codes.map((code) => {
      const fa = a.items.get(code) ?? null;
      const fb = b.items.get(code) ?? null;
      const status = fa == null ? 'added' : fb == null ? 'removed' : fa === fb ? 'same' : 'changed';
      return { code, description: desc.get(code) || null, a: fa, b: fb, change: fa != null && fb != null ? fb - fa : null, pct: fa && fb != null ? Math.round(((fb - fa) / fa) * 1000) / 10 : null, status };
    });
    const count = (s) => rows.filter((x) => x.status === s).length;
    res.json({ a: a.v, b: b.v, rows, summary: { changed: count('changed'), added: count('added'), removed: count('removed'), same: count('same') } });
  });

  // What a code cost on a schedule on a date (the same resolver estimates and claims use).
  r.get('/fees/resolve', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const fs = await scheduleFor(db, pid, req.query.fee_schedule_id || null);
    const code = String(req.query.code || '').toUpperCase();
    if (!/^D\d{4}$/.test(code)) throw new HttpError(400, 'code must be a CDT code');
    const date = req.query.date ? requireDay(String(req.query.date)) : await localToday(db, pid);
    res.json({ fee_schedule_id: fs.id, code, date, fee: await resolveFee(db, pid, fs.id, code, date) });
  });

  // ---- % increases ----
  const schedulesOf = async (pid, body) => {
    const ids = Array.isArray(body.fee_schedule_ids) ? body.fee_schedule_ids : [body.fee_schedule_id ?? null];
    if (!ids.length || ids.length > 30) throw new HttpError(400, 'Choose between 1 and 30 fee schedules');
    return mapSeq([...new Set(ids.map((x) => (x == null || x === 'standard' ? 'standard' : idOf(x, 'fee_schedule_id'))))], (x) => scheduleFor(db, pid, x === 'standard' ? null : x));
  };

  r.post('/fees/increase/preview', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const params = increaseParams(req.body);
    const today = await localToday(db, pid);
    const date = req.body.effective_date ? checkEffectiveDate(req.body.effective_date, today, { allowPast: false }) : today;
    const schedules = await schedulesOf(pid, req.body);
    const previews = await mapSeq(schedules, (s) => previewIncrease(db, pid, s, params, { date }));
    const total = (k) => previews.reduce((s, p) => s + p.summary[k], 0);
    res.json({ params, effective_date: date, rounding_options: ROUNDING, previews, totals: { changed: total('changed'), procedures_12m: total('procedures_12m'), production_12m: total('production_12m'), impact_12m: total('impact_12m') } });
  });

  // Schedule (or apply today) a % increase on one or more schedules. Approved by the person doing it.
  r.post('/fees/increases', requirePermission(FEES), humanApproved, async (req, res) => {
    const pid = req.user.practice_id;
    const params = increaseParams(req.body);
    const today = await localToday(db, pid);
    const effectiveDate = checkEffectiveDate(req.body.effective_date, today, { allowPast: false });
    const note = req.body.note ? String(req.body.note).slice(0, 500) : null;
    const schedules = await schedulesOf(pid, req.body);
    const groupId = schedules.length > 1 ? newGroupId() : null;
    const made = await mapSeq(schedules, (schedule) => scheduleIncrease(db, { practiceId: pid, schedule, params, effectiveDate, note, userId: req.user.id, groupId }));
    const changes = await mapSeq(made, async (m) => changeView(db, await db.get('SELECT * FROM fee_changes WHERE id = ?', m.id), { items: false }));
    res.status(201).json({ changes, applied: effectiveDate <= today });
  });

  // ---- Planned changes ----
  r.get('/fees/changes', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const status = req.query.status ? String(req.query.status).split(',').filter((s) => ['draft', 'scheduled', 'applied', 'cancelled', 'rejected'].includes(s)) : ['draft', 'scheduled'];
    if (!status.length) throw new HttpError(400, 'Unknown status');
    const rows = await db.all(`SELECT * FROM fee_changes WHERE practice_id = ? AND status IN (${status.map(() => '?').join(', ')}) ORDER BY CASE status WHEN 'draft' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, COALESCE(effective_date, '9999') , id DESC LIMIT 200`, pid, ...status);
    res.json(await mapSeq(rows, (c) => changeView(db, c, { items: false })));
  });

  r.get('/fees/changes/:cid', requirePermission('billing:read'), async (req, res) => {
    res.json(await changeView(db, await findChange(req)));
  });

  r.put('/fees/changes/:cid', requirePermission(FEES), humanApproved, async (req, res) => {
    const ch = await findChange(req);
    await editChange(db, ch, req.body || {}, req.user.id);
    res.json(await changeView(db, await db.get('SELECT * FROM fee_changes WHERE id = ?', ch.id)));
  });

  r.post('/fees/changes/:cid/approve', requirePermission(FEES), humanApproved, async (req, res) => {
    const ch = await findChange(req);
    const out = await approveImport(db, ch, req.body || {}, req.user.id);
    res.json({ ...(await changeView(db, await db.get('SELECT * FROM fee_changes WHERE id = ?', ch.id))), applied_now: !!out.applied });
  });

  r.post('/fees/changes/:cid/cancel', requirePermission(FEES), humanApproved, async (req, res) => {
    const ch = await findChange(req);
    await cancelChange(db, ch, { reason: req.body?.reason, userId: req.user.id });
    res.json(await changeView(db, await db.get('SELECT * FROM fee_changes WHERE id = ?', ch.id), { items: false }));
  });

  // ---- Imports ----
  const fileOf = (body) => ({ name: body.file_name ? String(body.file_name).slice(0, 200) : null, mime: body.mime ? String(body.mime) : null, ...(body.file_base64 ? { base64: String(body.file_base64) } : { text: body.text != null ? String(body.text).slice(0, 5_000_000) : undefined }) });

  // Upload a payer's schedule: read now into a draft with its differences (nothing changes until approved).
  r.post('/fees/imports', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const body = req.body || {};
    const schedule = await scheduleFor(db, pid, idOf(body.fee_schedule_id, 'fee_schedule_id'));
    const file = fileOf(body);
    if (!file.base64 && !file.text) throw new HttpError(400, 'Attach the fee schedule (CSV, XLSX or PDF) or paste it');
    const eff = body.effective_date ? checkEffectiveDate(body.effective_date, await localToday(db, pid)) : null;
    const out = await createImportDraft(db, { practiceId: pid, schedule, file, reader, source: 'upload', userId: req.user.id, effectiveDate: eff });
    res.status(out.duplicate ? 200 : 201).json({ ...(await changeView(db, await db.get('SELECT * FROM fee_changes WHERE id = ?', out.id))), duplicate: out.duplicate });
  });

  // A schedule's inbox: drop the payer's file (when it arrives) and the fee job reads it into a draft.
  r.post('/fees/inbox/:fid', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const schedule = await scheduleFor(db, pid, idOf(req.params.fid, 'fee schedule'));
    const file = fileOf(req.body || {});
    if (!file.base64 && !file.text) throw new HttpError(400, 'Attach the fee schedule file');
    if (!file.name) throw new HttpError(400, 'file_name is required');
    const content = file.base64 || Buffer.from(file.text, 'utf8').toString('base64');
    if (content.length * 0.75 > 10_000_000) throw new HttpError(400, 'That file is too large (10 MB at most)');
    const hash = fileHash(file.text ?? file.base64);
    const have = await db.get('SELECT * FROM fee_import_inbox WHERE practice_id = ? AND fee_schedule_id = ? AND file_hash = ?', pid, schedule.id, hash);
    if (have) return res.json({ ...have, content: undefined, duplicate: true });
    const row = await db.get(
      `INSERT INTO fee_import_inbox (practice_id, fee_schedule_id, file_name, mime, file_hash, content, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (practice_id, fee_schedule_id, file_hash) DO NOTHING RETURNING id`,
      pid, schedule.id, file.name, file.mime || (file.text != null ? 'text/csv' : null), hash, content, req.user.id);
    if (!row) return res.json({ ...(await db.get('SELECT * FROM fee_import_inbox WHERE practice_id = ? AND fee_schedule_id = ? AND file_hash = ?', pid, schedule.id, hash)), content: undefined, duplicate: true });
    await audit(db, req, 'fee_import.inbox', 'fee_import_inbox', row.id, { schedule: schedule.name, file: file.name });
    res.status(201).json({ ...(await db.get('SELECT id, fee_schedule_id, file_name, mime, status, created_at FROM fee_import_inbox WHERE id = ?', row.id)), duplicate: false });
  });

  r.get('/fees/inbox', requirePermission('billing:read'), async (req, res) => {
    res.json(await db.all(
      `SELECT i.id, i.fee_schedule_id, f.name AS schedule_name, i.file_name, i.status, i.change_id, i.error, i.attempts, i.created_at, i.processed_at
       FROM fee_import_inbox i JOIN fee_schedules f ON f.id = i.fee_schedule_id WHERE i.practice_id = ? ORDER BY i.id DESC LIMIT 100`, req.user.practice_id));
  });

  // ---- Reports ----
  // Write-offs on a PPO schedule grouped by the version in effect on each date of service: what each
  // contract (or fee increase) did to what the office writes off.
  r.get('/fees/reports/write-offs', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const fs = await scheduleFor(db, pid, idOf(req.query.fee_schedule_id, 'fee_schedule_id'));
    const today = await localToday(db, pid);
    const from = req.query.from ? requireDay(String(req.query.from), 'from') : `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`;
    const to = req.query.to ? requireDay(String(req.query.to), 'to') : today;
    const lines = await db.all(
      `SELECT ci.fee, ci.write_off, ci.adjusted_amount, ci.paid_amount, pr.completed_at FROM claim_items ci JOIN claims c ON c.id = ci.claim_id JOIN procedures pr ON pr.id = ci.procedure_id
       JOIN patient_insurance pi ON pi.id = c.patient_insurance_id LEFT JOIN insurance_plans ip ON ip.id = pi.plan_id LEFT JOIN insurance_carriers ic ON ic.id = pi.carrier_id
       WHERE c.practice_id = ? AND c.status != 'void' AND COALESCE(ip.fee_schedule_id, ic.fee_schedule_id) = ? AND pr.completed_at >= ? AND pr.completed_at < ?`,
      pid, fs.id, from, `${to} 99`);
    const versions = await db.all('SELECT id, version_no, effective_from, source, note FROM fee_schedule_versions WHERE practice_id = ? AND schedule_key = ? ORDER BY effective_from, version_no', pid, fs.key);
    const bucketOf = (dos) => {
      let pickV = versions[0] || null;
      for (const v of versions) if (v.effective_from <= dos) pickV = v;
      return pickV;
    };
    const groups = new Map();
    for (const l of lines) {
      const v = bucketOf(String(l.completed_at).slice(0, 10));
      const k = v?.id ?? 0;
      if (!groups.has(k)) groups.set(k, { version_id: v?.id ?? null, version_no: v?.version_no ?? null, effective_from: v?.effective_from ?? null, source: v?.source ?? 'current', procedures: 0, billed: 0, write_off_estimated: 0, write_off_posted: 0, paid: 0 });
      const g = groups.get(k);
      g.procedures++;
      g.billed += l.fee || 0;
      g.write_off_estimated += l.write_off || 0;
      g.write_off_posted += l.adjusted_amount || 0;
      g.paid += l.paid_amount || 0;
    }
    const rows = [...groups.values()].sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)))
      .map((g) => ({ ...g, write_off_pct: g.billed ? Math.round(((g.write_off_posted || g.write_off_estimated) / g.billed) * 1000) / 10 : null }));
    res.json({ schedule: { id: fs.id, name: fs.name }, from, to, rows });
  });

  return r;
}
