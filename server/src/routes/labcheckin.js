import express, { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { findOr404, audit, insert, change, recorded, practiceNow, isRealDate, newToken, hashToken, validTooth } from '../util.js';
import { currentActor, withActor } from '../actor.js';
import { publish } from '../events.js';
import { raiseIssue, resolveIssue } from '../issues.js';
import { appointmentScope, canSeePatient } from '../officeaccess.js';
import { storeUpload } from '../docfiles.js';
import { classify } from '../filetypes.js';
import { moveStock } from '../inventory.js';
import {
  readinessFor, visitItems, syncVisit, readSettings, cleanSettings, reserveOrOrder, stockFor, sweepPractice, parseUtterance, matchUtterance,
  cleanChecklist, labStats, labMessageDraft, insertRow, addDays, CHECKLIST, KIND_LABEL, STATE_LABEL, ROLLUP_LABEL, DEFAULT_TEMPLATES, labKind, parseTeeth,
} from '../labcheck.js';

// Visit readiness and lab / parts check-in (backlog LB1–LB5, docs/workflows/specs/LB-labcheckin.md).
//   GET  /visit-readiness?date=&to=            one state per visit for the schedule cards (links cases, adds template parts)
//   GET  /visit-readiness/huddle?date=         visits in the next N days that aren't ready (and the "call the lab" to-dos)
//   GET  /visit-readiness/appointments/:aid    one visit's items, with cases to choose from
//   GET/PUT /visit-readiness/settings          days ahead and the parts templates (administrators change them)
//   POST /visit-requirements                    link a case to a visit by hand, or add a part
//   PUT  /visit-requirements/:rid               ordered / arrived / not needed, stock item, details
//   GET  /visit-requirements/to-order           parts to order
//   GET  /lab-checkin/due                       cases and parts to check in (due this week, or arrived unchecked)
//   GET  /lab-checkin/lookup?code=              the lab slip's QR code (or the lab link) → the case
//   POST /lab-checkin/photos                    a photo of the case / slip / parts (encrypted, in the chart)
//   POST /lab-checkin/voice | /lab-checkin/parse  what was said → the case and a prefilled checklist (never saved)
//   POST /lab-checkin                           the check itself (a person's confirm)
//   POST /lab-checkin/:cid/lab-message          send the remake / adjust note to the lab
//   GET  /lab-checkin/stats                     turnaround, late % and remake % per lab
const DATE = (v, name) => {
  if (!isRealDate(v)) throw new HttpError(400, `${name} must be a real date (YYYY-MM-DD)`);
  return v;
};
const PROBLEM_KINDS = ['remake', 'adjust', 'missing_parts', 'wrong_case', 'other'];
const VIA = ['screen', 'voice', 'scan'];
const cleanDetails = (d) => {
  if (d == null) return null;
  if (typeof d !== 'object' || Array.isArray(d)) throw new HttpError(400, 'details must be an object');
  const out = {};
  for (const k of ['part', 'brand', 'platform', 'size', 'lot', 'note']) if (d[k] != null && String(d[k]).trim()) out[k] = String(d[k]).trim().slice(0, 80);
  for (const k of ['diameter', 'length']) {
    if (d[k] == null || d[k] === '') continue;
    const n = Number(d[k]);
    if (!(n > 0 && n < 30)) throw new HttpError(400, `${k} must be a size in mm`);
    out[k] = n;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
};

export default function labCheckinRoutes({ db, storage, config = {}, messenger = null, transcriber = null }) {
  const r = Router();
  const today = async (req) => (await practiceNow(db, req.user.practice_id)).slice(0, 10);
  const pname = (p) => `${p.preferred_name || p.first_name} ${p.last_name}`;
  // A person's confirm is what records a check; the assistant can prefill, not check in on its own.
  const needPerson = (req) => {
    if (currentActor()?.source === 'ai' && req.get('X-Human-Approved') !== '1') throw new HttpError(428, 'The assistant can’t check in lab work without your OK. Confirm it on screen.');
  };
  const seePatient = async (req, patientId, label = 'Not found') => {
    if (!(await canSeePatient(db, req.user, patientId))) throw new HttpError(404, label);
  };
  const loadAppt = async (req, id) => {
    const a = await findOr404(db, 'appointments', id, req.user.practice_id, 'Visit');
    const s = appointmentScope(req.user);
    if (s.sql && !(await db.get(`SELECT a.id FROM appointments a WHERE a.id = ?${s.sql}`, a.id, ...s.args))) throw new HttpError(404, 'Visit not found');
    await seePatient(req, a.patient_id, 'Visit not found');
    return a;
  };
  const loadCase = async (req, id) => {
    const c = await findOr404(db, 'lab_cases', id, req.user.practice_id, 'Lab case');
    await seePatient(req, c.patient_id, 'Lab case not found');
    return c;
  };
  const loadReq = async (req, id) => {
    const q = await findOr404(db, 'visit_requirements', id, req.user.practice_id, 'Item');
    await loadAppt(req, q.appointment_id);
    return q;
  };
  const settingsOf = async (pid) => readSettings(await db.get('SELECT readiness_settings FROM practices WHERE id = ?', pid));

  // ---- LB1/LB5: readiness on the schedule ----
  r.get('/visit-readiness', requirePermission('clinical:read'), async (req, res) => {
    const from = DATE(String(req.query.date || ''), 'date');
    const to = req.query.to ? DATE(String(req.query.to), 'to') : from;
    if (to < from || to > addDays(from, 13)) throw new HttpError(400, 'Up to two weeks at a time');
    const out = await readinessFor(db, { practiceId: req.user.practice_id, from, to, scope: appointmentScope(req.user), locationId: req.location_id || null });
    // byAppt is keyed by visit for the grid; the list (with patient_id) is what office limits filter.
    res.json({
      byAppt: Object.fromEntries(out.visits.map((v) => [v.appointment_id, { state: v.state, label: v.label, count: v.items.length, items: v.items.map((i) => ({ kind: i.kind, name: i.name, state: i.state, label: i.label })) }])),
      visits: out.visits, days_ahead: out.settings.days_ahead,
    });
  });

  r.get('/visit-readiness/appointments/:aid', requirePermission('clinical:read'), async (req, res) => {
    const a = await loadAppt(req, req.params.aid);
    const t = await today(req);
    if (a.start_time.slice(0, 10) >= t) await syncVisit(db, a, await settingsOf(a.practice_id), t);
    const v = await visitItems(db, a, t);
    const checks = await db.all('SELECT c.*, u.name AS checked_by_name FROM lab_checkins c LEFT JOIN users u ON u.id = c.checked_by WHERE c.practice_id = ? AND c.appointment_id = ? ORDER BY c.id DESC', a.practice_id, a.id);
    res.json({ ...v, start_time: a.start_time, checks: checks.map((c) => ({ ...c, checklist: JSON.parse(c.checklist), photo_ids: JSON.parse(c.photo_ids || '[]') })) });
  });

  // The huddle: visits in the next N days that aren't ready. Opening it (and the hourly job) makes the to-dos.
  r.get('/visit-readiness/huddle', requirePermission('clinical:read'), async (req, res) => {
    const t = await today(req);
    const date = req.query.date ? DATE(String(req.query.date), 'date') : t;
    const settings = await settingsOf(req.user.practice_id);
    if (date === t && can(req.user, 'clinical:write')) await sweepPractice(db, req.user.practice_id);
    const out = await readinessFor(db, { practiceId: req.user.practice_id, from: date, to: addDays(date, settings.days_ahead), scope: appointmentScope(req.user), locationId: req.location_id || null });
    const names = new Map((await db.all(`SELECT id, first_name, last_name, preferred_name FROM patients WHERE practice_id = ? AND id IN (${out.visits.map(() => '?').join(',') || 'NULL'})`, req.user.practice_id, ...out.visits.map((v) => v.patient_id))).map((p) => [p.id, p]));
    const rows = out.visits.filter((v) => v.state !== 'ready').map((v) => ({ ...v, patient_name: names.has(v.patient_id) ? pname(names.get(v.patient_id)) : null }));
    res.json({ date, days_ahead: settings.days_ahead, rows, ready: out.visits.length - rows.length, total: out.visits.length });
  });

  r.get('/visit-readiness/settings', requirePermission('clinical:read'), async (req, res) => {
    res.json({ ...(await settingsOf(req.user.practice_id)), defaults: DEFAULT_TEMPLATES, labels: { states: STATE_LABEL, rollup: ROLLUP_LABEL, checklist: CHECKLIST } });
  });
  r.put('/visit-readiness/settings', async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can change these settings');
    const next = cleanSettings({ ...(await settingsOf(req.user.practice_id)), ...(req.body || {}) });
    for (const items of Object.values(next.templates)) for (const it of items) if (it.inventory_item_id) await findOr404(db, 'inventory_items', it.inventory_item_id, req.user.practice_id, 'Stock item');
    const before = await db.get('SELECT readiness_settings FROM practices WHERE id = ?', req.user.practice_id);
    await db.run('UPDATE practices SET readiness_settings = ? WHERE id = ?', JSON.stringify(next), req.user.practice_id);
    await audit(db, req, 'visit_readiness.settings', 'practices', req.user.practice_id, null, { before: { readiness_settings: before?.readiness_settings ?? null }, after: { readiness_settings: JSON.stringify(next) } });
    res.json(next);
  });

  // ---- Linking a case by hand, adding a part ----
  r.post('/visit-requirements', requirePermission('clinical:write'), async (req, res) => {
    const b = req.body || {};
    const a = await loadAppt(req, b.appointment_id);
    if (['completed', 'cancelled', 'no_show'].includes(a.status)) throw new HttpError(409, 'That visit is over — link the case to the upcoming visit');
    let id;
    if (b.kind === 'lab_case' || b.lab_case_id) {
      const c = await loadCase(req, b.lab_case_id);
      if (c.patient_id !== a.patient_id) throw new HttpError(400, 'That lab case is another patient’s');
      if (c.status === 'cancelled') throw new HttpError(409, 'That lab case was cancelled');
      const other = await db.get(
        `SELECT r.appointment_id FROM visit_requirements r JOIN appointments x ON x.id = r.appointment_id WHERE r.lab_case_id = ? AND r.appointment_id != ? AND r.status != 'cancelled' AND x.status IN ('scheduled','confirmed','checked_in','in_chair')`, c.id, a.id,
      );
      if (other && !b.move) throw new HttpError(409, 'That case is linked to another upcoming visit — move it here?', { appointment_id: other.appointment_id });
      await db.tx(async () => {
        if (other) await db.run("UPDATE visit_requirements SET status = 'cancelled', reason = ? WHERE lab_case_id = ? AND appointment_id = ?", `Moved to visit #${a.id}`, c.id, other.appointment_id);
        // A "needs a case" line for this visit is filled in, else the case gets its own line.
        const slot = b.requirement_id ? await db.get("SELECT * FROM visit_requirements WHERE id = ? AND appointment_id = ? AND kind = 'lab_case' AND lab_case_id IS NULL", Number(b.requirement_id), a.id) : null;
        const existing = await db.get('SELECT * FROM visit_requirements WHERE appointment_id = ? AND lab_case_id = ?', a.id, c.id);
        if (existing) {
          id = existing.id;
          if (existing.status === 'cancelled') await change(db, 'visit_requirements', id, { status: 'linked', source: 'manual', reason: `Linked by ${req.user.name}` });
        } else if (slot) {
          id = slot.id;
          await change(db, 'visit_requirements', id, { lab_case_id: c.id, status: 'linked', source: 'manual', reason: `Linked by ${req.user.name}` });
        } else {
          id = await insertRow(db, 'visit_requirements', { practice_id: a.practice_id, location_id: a.location_id ?? null, appointment_id: a.id, patient_id: a.patient_id, kind: 'lab_case', link_key: `lab:${c.id}`, lab_case_id: c.id, procedure_id: c.procedure_id || null, status: 'linked', source: 'manual', reason: `Linked by ${req.user.name}`, created_by: req.user.id });
        }
        if (c.appointment_id !== a.id) await change(db, 'lab_cases', c.id, { appointment_id: a.id });
      });
      await audit(db, req, 'visit_requirement.link', 'visit_requirements', id, { appointment_id: a.id, lab_case_id: c.id }, { patientId: a.patient_id, locationId: a.location_id ?? null });
    } else {
      const name = String(b.item_name || '').trim().slice(0, 80);
      if (!name) throw new HttpError(400, 'Name the part (for example “Implant fixture”)');
      const qty = Math.round(Number(b.qty ?? 1));
      if (!(qty >= 1 && qty <= 50)) throw new HttpError(400, 'Quantity must be 1–50');
      if (b.inventory_item_id) await findOr404(db, 'inventory_items', b.inventory_item_id, req.user.practice_id, 'Stock item');
      const key = String(b.key || '').replace(/[^\w-]/g, '').slice(0, 60) || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const dup = await db.get('SELECT id FROM visit_requirements WHERE appointment_id = ? AND link_key = ?', a.id, `part:${key}`);
      if (dup) return res.json(await visitItems(db, a, await today(req))); // the same request twice
      id = await insertRow(db, 'visit_requirements', {
        practice_id: a.practice_id, location_id: a.location_id ?? null, appointment_id: a.id, patient_id: a.patient_id, kind: 'part', link_key: `part:${key}`,
        item_name: name, details: cleanDetails(b.details), qty, inventory_item_id: b.inventory_item_id ? Number(b.inventory_item_id) : null, status: 'to_order', source: 'manual', created_by: req.user.id,
      });
      if (b.inventory_item_id) await reserveOrOrder(db, id);
      await audit(db, req, 'visit_requirement.add', 'visit_requirements', id, { appointment_id: a.id, item: name, qty }, { patientId: a.patient_id, locationId: a.location_id ?? null });
    }
    publish(req.user.practice_id, { type: 'readiness', appointment_id: a.id });
    res.status(201).json(await visitItems(db, a, await today(req)));
  });

  r.put('/visit-requirements/:rid', requirePermission('clinical:write'), async (req, res) => {
    const q = await loadReq(req, req.params.rid);
    const b = req.body || {};
    const patch = {};
    if (b.status !== undefined) {
      const allowed = q.kind === 'part' ? ['to_order', 'ordered', 'arrived', 'cancelled'] : ['cancelled', 'linked'];
      if (!allowed.includes(b.status)) throw new HttpError(400, `status must be one of: ${allowed.join(', ')} (checking it in is done from the check-in screen)`);
      if (b.status === 'cancelled' && !String(b.reason || '').trim()) throw new HttpError(400, 'Say why it isn’t needed (for example “made in the office”)');
      if (b.status === 'linked' && !q.lab_case_id) throw new HttpError(400, 'Pick the lab case to link');
      patch.status = b.status;
      if (b.status === 'ordered') patch.ordered_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
      if (b.status === 'arrived') patch.arrived_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
      if (b.reason) patch.reason = String(b.reason).trim().slice(0, 200);
    }
    if (q.kind === 'part') {
      if (b.item_name !== undefined) patch.item_name = String(b.item_name).trim().slice(0, 80) || q.item_name;
      if (b.details !== undefined) patch.details = cleanDetails(b.details);
      if (b.qty !== undefined) {
        const qty = Math.round(Number(b.qty));
        if (!(qty >= 1 && qty <= 50)) throw new HttpError(400, 'Quantity must be 1–50');
        patch.qty = qty;
      }
      if (b.inventory_item_id !== undefined) {
        if (b.inventory_item_id) await findOr404(db, 'inventory_items', b.inventory_item_id, req.user.practice_id, 'Stock item');
        patch.inventory_item_id = b.inventory_item_id ? Number(b.inventory_item_id) : null;
        if (!patch.inventory_item_id && q.status === 'set_aside') patch.status = 'to_order';
      }
    }
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change');
    await change(db, 'visit_requirements', q.id, patch);
    if (q.kind === 'part' && (patch.inventory_item_id || patch.qty) && ['to_order', 'set_aside'].includes(patch.status || q.status)) await reserveOrOrder(db, q.id);
    // A to-do made for this item is closed once it's ordered, arrived or not needed.
    if (q.task_id > 0 && ['ordered', 'arrived', 'cancelled', 'linked'].includes(patch.status)) {
      await db.run("UPDATE tasks SET status = 'done', completed_at = datetime('now'), completed_by = ? WHERE id = ? AND status = 'open'", req.user.id, q.task_id);
      publish(req.user.practice_id, { type: 'tasks' });
    }
    await audit(db, req, 'visit_requirement.update', 'visit_requirements', q.id, { status: patch.status ?? null }, { patientId: q.patient_id, reason: b.status === 'cancelled' ? String(b.reason).trim() : undefined });
    publish(req.user.practice_id, { type: 'readiness', appointment_id: q.appointment_id });
    const a = await db.get('SELECT * FROM appointments WHERE id = ?', q.appointment_id);
    res.json(await visitItems(db, a, await today(req)));
  });

  r.get('/visit-requirements/to-order', requirePermission('clinical:read'), async (req, res) => {
    const s = appointmentScope(req.user);
    const t = await today(req);
    const rows = await db.all(
      `SELECT r.id, r.appointment_id, r.patient_id, r.item_name, r.details, r.qty, r.status, r.inventory_item_id, r.reason, a.start_time, p.first_name, p.last_name, p.preferred_name, i.name AS inventory_name, i.supplier
       FROM visit_requirements r JOIN appointments a ON a.id = r.appointment_id JOIN patients p ON p.id = r.patient_id LEFT JOIN inventory_items i ON i.id = r.inventory_item_id
       WHERE r.practice_id = ? AND r.kind = 'part' AND r.status IN ('to_order','ordered') AND a.status IN ('scheduled','confirmed','checked_in','in_chair') AND a.start_time >= ?${s.sql}
       ORDER BY a.start_time`, req.user.practice_id, `${t} 00:00`, ...s.args,
    );
    const out = [];
    for (const x of rows) out.push({ ...x, details: x.details ? JSON.parse(x.details) : null, stock: x.inventory_item_id ? await stockFor(db, x.inventory_item_id, x.id).then((st) => st && { on_hand: st.on_hand, reserved: st.reserved, available: st.available }) : null });
    res.json(out);
  });

  // ---- LB2: what to check in ----
  const dueSelect = `SELECT l.id, l.patient_id, l.lab_id, l.lab_name, l.description, l.tooth, l.shade, l.status, l.lab_status, l.check_status, l.due_date, l.sent_date, l.received_date, l.rx,
      l.appointment_id, l.procedure_id, p.first_name, p.last_name, p.preferred_name, p.dob, a.start_time AS appointment_time
    FROM lab_cases l JOIN patients p ON p.id = l.patient_id LEFT JOIN appointments a ON a.id = l.appointment_id`;
  const openCandidates = async (req, days = 14) => {
    const t = await today(req);
    // Visits coming up are linked to their cases first, so each case shows the visit it's for.
    await readinessFor(db, { practiceId: req.user.practice_id, from: t, to: addDays(t, Math.min(days, 13)), scope: appointmentScope(req.user) });
    const cases = await db.all(
      `${dueSelect} WHERE l.practice_id = ? AND (l.status IN ('sent','returned_for_adjustment') OR (l.status = 'received' AND (l.check_status IS NULL OR l.check_status = 'problem')))
         AND (l.due_date IS NULL OR l.due_date <= ? OR (a.start_time IS NOT NULL AND a.start_time < ?)) ORDER BY l.due_date IS NULL, l.due_date, l.id`,
      req.user.practice_id, addDays(t, days), `${addDays(t, days + 1)} 00:00`,
    );
    const s = appointmentScope(req.user);
    const parts = await db.all(
      `SELECT r.id, r.appointment_id, r.patient_id, r.item_name, r.details, r.qty, r.status, a.start_time AS appointment_time, p.first_name, p.last_name, p.preferred_name
       FROM visit_requirements r JOIN appointments a ON a.id = r.appointment_id JOIN patients p ON p.id = r.patient_id
       WHERE r.practice_id = ? AND r.kind = 'part' AND r.status IN ('ordered','arrived','to_order','problem') AND a.status IN ('scheduled','confirmed','checked_in','in_chair')
         AND a.start_time >= ? AND a.start_time < ?${s.sql} ORDER BY a.start_time`, req.user.practice_id, `${t} 00:00`, `${addDays(t, days + 1)} 00:00`, ...s.args,
    );
    const visible = [];
    for (const c of cases) if (await canSeePatient(db, req.user, c.patient_id)) visible.push(c);
    return {
      today: t,
      cases: visible.map((c) => ({ type: 'lab_case', ...c, rx: c.rx ? JSON.parse(c.rx) : null, kind: labKind(c.description?.slice(0, 5)) || null, late: !!c.due_date && c.due_date < t && c.status !== 'received' })),
      parts: parts.map((x) => ({ type: 'part', ...x, details: x.details ? JSON.parse(x.details) : null })),
    };
  };
  r.get('/lab-checkin/due', requirePermission('clinical:read'), async (req, res) => {
    const days = Math.min(30, Math.max(1, Math.round(Number(req.query.days) || 7)));
    res.json(await openCandidates(req, days));
  });

  // The slip's QR code says "DM-LAB-<case id>" (a reference, not a key: it only opens inside this practice). The
  // lab's own link (…/lab/<token>) scanned off their paperwork works too.
  r.get('/lab-checkin/lookup', requirePermission('clinical:read'), async (req, res) => {
    const code = String(req.query.code || '').trim().slice(0, 500);
    let c = null;
    const ref = /^DM-LAB-(\d{1,10})$/i.exec(code) || /^#?(\d{1,10})$/.exec(code);
    const link = /\/lab\/([A-Za-z0-9_-]{16,})\/?$/.exec(code);
    if (ref) c = await db.get('SELECT id FROM lab_cases WHERE id = ? AND practice_id = ?', Number(ref[1]), req.user.practice_id);
    else if (link) c = await db.get('SELECT id FROM lab_cases WHERE lab_token_hash = ? AND practice_id = ?', hashToken(link[1]), req.user.practice_id);
    if (!c) throw new HttpError(404, 'No lab case of ours matches that code — pick it from the list');
    await loadCase(req, c.id);
    const row = await db.get(`${dueSelect} WHERE l.id = ?`, c.id);
    res.json({ type: 'lab_case', ...row, rx: row.rx ? JSON.parse(row.rx) : null });
  });

  // A photo of the case, the slip or the parts: stored encrypted like every chart image, filed on the visit.
  r.post('/lab-checkin/photos', requirePermission('clinical:write'), express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
    const q = req.query;
    let patientId;
    let appointmentId = null;
    let tooth = null;
    let what;
    if (q.lab_case_id) {
      const c = await loadCase(req, q.lab_case_id);
      patientId = c.patient_id;
      appointmentId = c.appointment_id || null;
      const teeth = [...parseTeeth(c.tooth)];
      tooth = teeth.length === 1 && validTooth(teeth[0]) ? teeth[0] : null;
      what = `Lab case #${c.id} check-in: ${c.description}`;
    } else if (q.requirement_id) {
      const it = await loadReq(req, q.requirement_id);
      patientId = it.patient_id;
      appointmentId = it.appointment_id;
      what = `Parts check-in: ${it.item_name}`;
    } else throw new HttpError(400, 'Say which case or part the photo is of');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Empty photo');
    if (!String(classify(req.body, String(q.filename || 'photo.jpg'), '').mime).startsWith('image/')) throw new HttpError(415, 'Take a photo (JPEG, PNG or HEIC)');
    const out = await storeUpload(db, storage, {
      req, practiceId: req.user.practice_id, patientId, scope: 'patient', body: req.body, filename: String(q.filename || 'lab-check.jpg').slice(0, 120),
      declared: String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), category: 'photo', tooth, notes: what, uploadedBy: req.user.id,
      source: 'lab-checkin', extra: { tags: JSON.stringify(['lab check-in']), ...(appointmentId ? { appointment_id: appointmentId } : {}) },
    });
    res.status(201).json({ id: out.id, mime: out.mime });
  });

  // ---- LB3: by voice. Transcribe (the office's speech service), read it, find the case. Nothing is saved. ----
  const understand = async (req, text) => {
    const parsed = parseUtterance(text);
    const { cases, parts } = await openCandidates(req, 21);
    const candidates = [...cases.map((c) => ({ ...c, id: c.id, type: 'lab_case' })), ...parts.map((x) => ({ ...x, type: 'part', item_name: x.item_name }))];
    const m = matchUtterance(parsed, candidates);
    const best = m.best;
    // The checklist as heard; a shade that differs from the Rx is flagged, not taken on trust.
    const checklist = { ...parsed.checklist };
    const warnings = [];
    if (best?.type === 'lab_case' && parsed.shade && best.shade && parsed.shade !== String(best.shade).replace(/[\s-]/g, '').toUpperCase()) {
      checklist.shade = false;
      warnings.push(`You said shade ${parsed.shade}; the Rx says ${best.shade}`);
    }
    if (best && parsed.teeth.length && best.tooth && ![...parseTeeth(best.tooth)].some((x) => parsed.teeth.includes(x))) warnings.push(`You said #${parsed.teeth.join(', ')}; the case is for #${best.tooth}`);
    const trim = (c) => c && { type: c.type, id: c.id, patient_id: c.patient_id, patient: pname(c), description: c.description || c.item_name, tooth: c.tooth || null, shade: c.shade || null, due_date: c.due_date || null, appointment_time: c.appointment_time || null, lab_name: c.lab_name || null, score: c.score, why: c.why };
    return {
      text, parsed, match: trim(best), candidates: m.candidates.map(trim), ambiguous: m.ambiguous, confident: m.confident, needs_confirm: true,
      verdict: parsed.verdict, checklist, problem_kind: parsed.problem_kind, problem_note: parsed.problems.join('; ') || null, warnings,
      question: !best ? 'I couldn’t tell which case that is — pick it from the list' : m.ambiguous ? 'More than one case could fit — tap the right one' : !parsed.verdict ? 'Does it look good, or is there a problem?' : null,
    };
  };
  r.post('/lab-checkin/parse', requirePermission('clinical:write'), async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) throw new HttpError(400, 'Nothing was said');
    if (text.length > 1000) throw new HttpError(400, 'That’s too long — say it in a sentence or two');
    res.json(await understand(req, text));
  });
  r.post('/lab-checkin/voice', requirePermission('clinical:write'), express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '8mb' }), async (req, res) => {
    if (!transcriber?.dictation) throw new HttpError(409, 'Server speech isn’t set up — the browser’s speech recognition is used instead');
    const audio = Buffer.isBuffer(req.body) ? req.body : null;
    if (!audio?.length) throw new HttpError(400, 'No audio');
    let text;
    try {
      text = await transcriber.dictation(audio, { contentType: String(req.get('Content-Type') || 'audio/webm').split(';')[0], keyterms: ['crown', 'bridge', 'denture', 'night guard', 'shade', 'margin', 'abutment', 'scan body', 'Nobel', 'Straumann', 'looks good'] });
      await resolveIssue(db, req.user.practice_id, `labcheck-voice:${req.user.practice_id}`);
    } catch (err) {
      await raiseIssue(db, { practiceId: req.user.practice_id, kind: 'ai', key: `labcheck-voice:${req.user.practice_id}`, role: 'admin', title: 'Voice check-in couldn’t be transcribed', detail: `${err.message}. Staff can still check cases in by tapping.` });
      throw new HttpError(502, 'The speech service didn’t answer — tap through the checklist instead');
    }
    if (!String(text || '').trim()) throw new HttpError(422, 'Didn’t catch that — hold the button and try again');
    res.json(await understand(req, String(text).slice(0, 1000)));
  });

  // ---- LB2: the check ----
  r.post('/lab-checkin', requirePermission('clinical:write'), async (req, res) => {
    needPerson(req);
    const b = req.body || {};
    const verdict = b.verdict;
    if (!['ok', 'problem'].includes(verdict)) throw new HttpError(400, 'verdict must be ok or problem');
    const checklist = cleanChecklist(b.checklist, verdict);
    const note = String(b.problem_note || '').trim().slice(0, 1000) || null;
    const kind = b.problem_kind ?? (verdict === 'problem' ? 'other' : null);
    if (verdict === 'problem') {
      if (!note) throw new HttpError(400, 'Say what’s wrong, so the doctor and the lab know');
      if (!PROBLEM_KINDS.includes(kind)) throw new HttpError(400, `problem_kind must be one of: ${PROBLEM_KINDS.join(', ')}`);
    }
    const via = VIA.includes(b.via) ? b.via : 'screen';
    const key = b.key ? String(b.key).replace(/[^\w-]/g, '').slice(0, 80) : null;
    if (key) {
      const done = await db.get('SELECT id FROM lab_checkins WHERE practice_id = ? AND client_key = ?', req.user.practice_id, key);
      if (done) return res.json(await checkView(done.id, { repeat: true }));
    }
    let c = null;
    let item = null;
    let appt = null;
    if (b.lab_case_id) {
      c = await loadCase(req, b.lab_case_id);
      if (['cancelled', 'delivered'].includes(c.status)) throw new HttpError(409, c.status === 'cancelled' ? 'That case was cancelled' : 'That case was already seated');
    } else if (b.requirement_id) {
      item = await loadReq(req, b.requirement_id);
      if (item.kind !== 'part') throw new HttpError(400, 'Check a lab case in by its case');
      if (item.status === 'cancelled') throw new HttpError(409, 'That part is marked not needed');
    } else throw new HttpError(400, 'Pick the case or part you’re checking');
    const patientId = c?.patient_id ?? item.patient_id;
    // A case not yet tied to a visit: the patient's upcoming visits are linked first (the usual rules), so the
    // check lands on the right visit.
    if (c && !c.appointment_id && !b.appointment_id) {
      const t0 = await today(req);
      const settings = await settingsOf(req.user.practice_id);
      await withActor({ source: 'automation', actor: 'Visit readiness', practiceId: req.user.practice_id }, async () => {
        for (const a of await db.all("SELECT * FROM appointments WHERE practice_id = ? AND patient_id = ? AND start_time >= ? AND status IN ('scheduled','confirmed','checked_in','in_chair') ORDER BY start_time LIMIT 10", req.user.practice_id, patientId, `${t0} 00:00`)) await syncVisit(db, a, settings, t0);
      });
      c = await db.get('SELECT * FROM lab_cases WHERE id = ?', c.id);
    }
    const apptId = b.appointment_id ?? item?.appointment_id ?? c?.appointment_id ?? null;
    if (apptId) {
      appt = await loadAppt(req, apptId);
      if (appt.patient_id !== patientId) throw new HttpError(400, 'That visit is another patient’s');
    }
    const photos = [...new Set((Array.isArray(b.photo_ids) ? b.photo_ids : []).map(Number).filter(Boolean))].slice(0, 12);
    for (const id of photos) {
      if (!(await db.get("SELECT id FROM documents WHERE id = ? AND practice_id = ? AND patient_id = ? AND deleted_at IS NULL AND category = 'photo'", id, req.user.practice_id, patientId))) throw new HttpError(400, 'Photos must be of this patient’s case');
    }
    const t = await today(req);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    let checkId;
    await db.tx(async () => {
      const lab = c?.lab_id ? await db.get('SELECT id, name FROM labs WHERE id = ?', c.lab_id) : null;
      checkId = await insertRow(db, 'lab_checkins', {
        practice_id: req.user.practice_id, location_id: appt?.location_id ?? req.location_id ?? null, patient_id: patientId, lab_case_id: c?.id ?? null, requirement_id: item?.id ?? null,
        appointment_id: appt?.id ?? null, verdict, checklist: JSON.stringify(checklist), problem_kind: verdict === 'problem' ? kind : null, problem_note: note, photo_ids: JSON.stringify(photos),
        via, transcript: via === 'voice' && b.transcript ? String(b.transcript).slice(0, 1000) : null, lab_id: lab?.id ?? null, lab_name: c?.lab_name ?? null,
        sent_date: c?.sent_date ?? null, promised_date: c ? (c.promised_date || c.due_date || null) : null, received_date: c ? (c.received_date || t) : null, client_key: key, checked_by: req.user.id,
      });
      if (c) {
        await recorded(db, 'lab_cases', c.id, () => db.run(
          "UPDATE lab_cases SET status = 'received', received_date = COALESCE(received_date, ?), check_status = ?, checked_at = ?, promised_date = COALESCE(promised_date, due_date), appointment_id = COALESCE(appointment_id, ?) WHERE id = ?",
          t, verdict === 'ok' ? 'checked' : 'problem', now, appt?.id ?? null, c.id,
        ));
        // Photos of a problem go on the lab's link, so the lab sees what we saw.
        if (verdict === 'problem' && photos.length) {
          const docs = [...new Set([...JSON.parse(c.document_ids || '[]'), ...photos])].slice(0, 30);
          await change(db, 'lab_cases', c.id, { document_ids: JSON.stringify(docs) });
        }
        if (appt) {
          const linkedHere = await db.get("SELECT id FROM visit_requirements WHERE appointment_id = ? AND lab_case_id = ? AND status != 'cancelled'", appt.id, c.id);
          if (!linkedHere) await db.run("INSERT INTO visit_requirements (practice_id, location_id, appointment_id, patient_id, kind, link_key, lab_case_id, status, source, reason, created_by) VALUES (?, ?, ?, ?, 'lab_case', ?, ?, 'linked', 'manual', ?, ?) ON CONFLICT (appointment_id, link_key) DO NOTHING",
            req.user.practice_id, appt.location_id ?? null, appt.id, patientId, `lab:${c.id}`, c.id, 'Linked at check-in', req.user.id);
        }
      } else {
        const wasOrdered = ['to_order', 'ordered', 'arrived'].includes(item.status);
        await change(db, 'visit_requirements', item.id, { status: verdict === 'ok' ? 'checked' : 'problem', checked_at: now, checked_by: req.user.id, arrived_at: item.arrived_at || now, photo_ids: JSON.stringify(photos) });
        // An ordered part that arrives goes into stock (and stays set aside for this visit).
        if (verdict === 'ok' && wasOrdered && item.inventory_item_id) {
          const stock = await db.get('SELECT * FROM inventory_items WHERE id = ?', item.inventory_item_id);
          if (stock) await moveStock(db, stock, item.qty, { reason: 'received', note: `For visit #${item.appointment_id}`, userId: req.user.id, today: t });
        }
      }
      // Open "call the lab" / "order" to-dos for what just arrived are done.
      const reqRows = c ? await db.all("SELECT task_id FROM visit_requirements WHERE lab_case_id = ? AND task_id > 0", c.id) : [{ task_id: item.task_id }];
      for (const x of reqRows) if (x.task_id > 0) await db.run("UPDATE tasks SET status = 'done', completed_at = datetime('now'), completed_by = ? WHERE id = ? AND status = 'open'", req.user.id, x.task_id);
    });
    const patient = await db.get('SELECT first_name, last_name, preferred_name FROM patients WHERE id = ?', patientId);
    const what = c ? `${c.description}${c.tooth ? ` #${c.tooth}` : ''}` : item.item_name;
    await audit(db, req, verdict === 'ok' ? 'lab_checkin.ok' : 'lab_checkin.problem', c ? 'lab_cases' : 'visit_requirements', c?.id ?? item.id,
      { checkin_id: checkId, appointment_id: appt?.id ?? null, photos: photos.length, via, checklist, problem_kind: verdict === 'problem' ? kind : null },
      { patientId, locationId: appt?.location_id ?? null, reason: note || undefined });
    // LB4: a failed check goes to the doctor now (a high-priority to-do, and a live note on their screen).
    let notified = null;
    if (verdict === 'problem') {
      const providerId = c?.provider_id || appt?.provider_id || null;
      const doctor = providerId ? await db.get('SELECT p.name, p.user_id FROM providers p WHERE p.id = ? AND p.practice_id = ?', providerId, req.user.practice_id) : null;
      const when = appt ? new Date(`${appt.start_time.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : null;
      const taskId = await insert(db, 'tasks', {
        practice_id: req.user.practice_id, patient_id: patientId, assigned_to: doctor?.user_id || null, priority: 'high', due_date: t, created_by: req.user.id,
        title: `Lab ${c ? 'case' : 'parts'} problem — ${pname(patient)}, ${what}: ${note}${when ? ` (visit ${when})` : ''}. Remake, adjust or move the visit?`.slice(0, 300),
      });
      notified = { user_id: doctor?.user_id || null, name: doctor?.name || null, task_id: taskId };
      publish(req.user.practice_id, { type: 'tasks', event: 'created', task_id: taskId, assigned_to: doctor?.user_id || null, by: req.user.id });
      publish(req.user.practice_id, { type: 'lab_checkin', verdict: 'problem', checkin_id: checkId, lab_case_id: c?.id ?? null, appointment_id: appt?.id ?? null, notify_user_id: doctor?.user_id || null });
    }
    publish(req.user.practice_id, { type: 'readiness', appointment_id: appt?.id ?? null });
    publish(req.user.practice_id, { type: 'schedule', ...(appt ? { dates: [appt.start_time.slice(0, 10)] } : {}) });
    res.status(201).json(await checkView(checkId, { notified }));
  });

  // One check, with what to do next after a problem: the note for the lab and the visit to move.
  async function checkView(id, extra = {}) {
    const k = await db.get('SELECT * FROM lab_checkins WHERE id = ?', id);
    const c = k.lab_case_id ? await db.get('SELECT * FROM lab_cases WHERE id = ?', k.lab_case_id) : null;
    const p = await db.get('SELECT first_name, last_name, preferred_name FROM patients WHERE id = ?', k.patient_id);
    const appt = k.appointment_id ? await db.get('SELECT id, start_time, provider_id, status FROM appointments WHERE id = ?', k.appointment_id) : null;
    const next = k.verdict === 'problem' ? {
      lab_message: c ? labMessageDraft({ kind: k.problem_kind === 'adjust' ? 'adjust' : 'remake', patient: pname(p), labCase: c, problems: [], note: k.problem_note, visitDate: appt?.start_time.slice(0, 10) }) : null,
      lab_email: c?.lab_id ? (await db.get('SELECT email FROM labs WHERE id = ?', c.lab_id))?.email || null : null,
      move_visit: appt && ['scheduled', 'confirmed'].includes(appt.status) ? { appointment_id: appt.id, date: appt.start_time.slice(0, 10), after: c?.due_date || null } : null,
    } : null;
    return { ...k, checklist: JSON.parse(k.checklist), photo_ids: JSON.parse(k.photo_ids || '[]'), patient: pname(p), what: c ? `${c.description}${c.tooth ? ` #${c.tooth}` : ''}` : null, next, ...extra };
  }
  r.get('/lab-checkin/:cid', requirePermission('clinical:read'), async (req, res, next) => {
    if (!/^\d+$/.test(req.params.cid)) return next();
    const k = await findOr404(db, 'lab_checkins', req.params.cid, req.user.practice_id, 'Check-in');
    await seePatient(req, k.patient_id, 'Check-in not found');
    res.json(await checkView(k.id));
  });

  // LB4: the remake / adjust note to the lab — a person reads and sends it. A fresh private link goes with it (the
  // lab sees the photos), the case goes back to "returned for adjustment", and a failed email is a work item.
  r.post('/lab-checkin/:cid/lab-message', requirePermission('clinical:write'), async (req, res) => {
    needPerson(req);
    const k = await findOr404(db, 'lab_checkins', req.params.cid, req.user.practice_id, 'Check-in');
    await seePatient(req, k.patient_id, 'Check-in not found');
    if (k.verdict !== 'problem' || !k.lab_case_id) throw new HttpError(409, 'Only a lab case that failed its check goes back to the lab');
    if (k.lab_message_at) return res.json({ ok: true, repeat: true, sent_at: k.lab_message_at });
    const c = await db.get('SELECT * FROM lab_cases WHERE id = ?', k.lab_case_id);
    const kind = req.body?.kind === 'adjust' ? 'adjust' : 'remake';
    const message = String(req.body?.message || '').trim().slice(0, 4000);
    if (!message) throw new HttpError(400, 'Write the note to the lab');
    const due = req.body?.new_due_date ? DATE(String(req.body.new_due_date), 'new_due_date') : null;
    const lab = c.lab_id ? await db.get('SELECT * FROM labs WHERE id = ?', c.lab_id) : null;
    const { token, hash } = newToken();
    const expires = new Date(Date.now() + 120 * 86400_000).toISOString();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const claimed = await db.run('UPDATE lab_checkins SET lab_message_at = ?, lab_message_by = ? WHERE id = ? AND lab_message_at IS NULL', now, req.user.id, k.id);
    if (!claimed.changes) return res.json({ ok: true, repeat: true });
    await recorded(db, 'lab_cases', c.id, () => db.run(
      "UPDATE lab_cases SET status = 'returned_for_adjustment', lab_token_hash = ?, lab_link_expires = ?, lab_status = NULL, due_date = COALESCE(?, due_date), notes = ? WHERE id = ?",
      hash, expires, due, `${c.notes ? `${c.notes}\n` : ''}${now.slice(0, 10)} ${kind === 'adjust' ? 'Sent back to adjust' : 'Sent back for a remake'}: ${k.problem_note}`.slice(0, 2000), c.id,
    ));
    const link = `${config.appUrl || ''}/lab/${token}`;
    let emailed = false;
    if (lab?.email && messenger) {
      try {
        const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', req.user.practice_id);
        await messenger.send({ channel: 'email', to: lab.email, subject: `${kind === 'adjust' ? 'Adjustment' : 'Remake'} needed: case #${c.id} from ${practice.name}`, body: `${message}\n\nThe case, its Rx and our photos:\n${link}\n\n${practice.name}${practice.phone ? ` · ${practice.phone}` : ''}` });
        emailed = true;
        await resolveIssue(db, req.user.practice_id, `lab-remake-email:${c.id}`);
      } catch (err) {
        await raiseIssue(db, { practiceId: req.user.practice_id, kind: 'message', key: `lab-remake-email:${c.id}`, role: 'clinical', entity: 'lab_cases', entityId: c.id, patientId: c.patient_id, title: `The remake note to ${lab.name} didn't go — call or send the link another way`, detail: err.message });
      }
    }
    await audit(db, req, 'lab_case.return_to_lab', 'lab_cases', c.id, { checkin_id: k.id, kind, emailed, new_due_date: due }, { patientId: c.patient_id, reason: k.problem_note });
    res.json({ ok: true, emailed, link, lab_email: lab?.email || null });
  });

  // ---- LB4: lab stats ----
  r.get('/lab-checkin/stats', requirePermission('clinical:read'), async (req, res) => {
    const t = await today(req);
    const from = req.query.from ? DATE(String(req.query.from), 'from') : addDays(t, -180);
    const to = req.query.to ? DATE(String(req.query.to), 'to') : t;
    const rows = await db.all(
      `SELECT l.id, l.lab_id, COALESCE(lb.name, l.lab_name) AS lab_name, l.sent_date, l.promised_date, l.due_date, l.received_date, l.status,
         (SELECT COUNT(*) FROM lab_checkins k WHERE k.lab_case_id = l.id AND k.verdict = 'problem' AND k.problem_kind = 'remake') AS remakes,
         (SELECT COUNT(*) FROM lab_checkins k WHERE k.lab_case_id = l.id AND k.verdict = 'problem') AS problems
       FROM lab_cases l LEFT JOIN labs lb ON lb.id = l.lab_id
       WHERE l.practice_id = ? AND l.status != 'cancelled' AND l.sent_date >= ? AND l.sent_date <= ?`, req.user.practice_id, from, to,
    );
    res.json({ from, to, labs: labStats(rows.map((x) => ({ ...x, remade: Number(x.remakes) > 0, problem: Number(x.problems) > 0 })), t) });
  });

  return r;
}

// For the assistant (hand-off): a read-only tool that turns "the lab case is in for …" into the check-in screen
// prefilled — the person still confirms there. { name, description, input_schema } plus the reader.
export const LAB_CHECKIN_TOOL = {
  name: 'lab_checkin_prefill',
  description: 'When someone says a lab case or ordered parts arrived ("the crown for Maria Lopez #30 is in, shade A2, looks good"), find the case and prefill the check-in. Never records the check — the person confirms it on the check-in screen.',
  input_schema: { type: 'object', properties: { said: { type: 'string', description: 'What the person said, word for word' } }, required: ['said'] },
};
export const labCheckinReader = (call) => async ({ said }) => call('POST', '/lab-checkin/parse', { text: said });
export { KIND_LABEL };
