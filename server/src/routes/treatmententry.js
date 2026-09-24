import { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { insert, update, findOr404, audit, recorded, validTooth, codeArea, mapSeq, QUADRANTS, ARCHES } from '../util.js';
import { currentActor, setActor } from '../actor.js';
import { completeProcedure } from '../services.js';
import { officeFee } from '../fees.js';
import { buildProcedureRow, CONDITIONS } from './clinical.js';
import { estimateFor } from './insurance.js';
import {
  buildLookups, resolveEntry, checkBundle, itemProblem, chartWarnings, describe, STARTER_BUNDLES, STARTER_SHORTCUTS, SHORTCUT_ICONS,
  WORK_KINDS, FINDING_KINDS,
} from '../chartengine.js';

// Treatment entry (docs/workflows/specs/TE-treatment-entry.md): bundles ("Crown" = crown + optional buildup/post),
// the chart's quick buttons (Alt+1…9) and typed/spoken aliases, all resolved by one engine (chartengine.js) into
// the same preview — teeth, codes, fees, the insurance estimate and warnings — and charted in one step.
//
// Bundles and buttons belong to the office (user_id null; administrators change them) or to one person (their
// own; clinical:write). They are retired, never deleted, and every change is audited with before/after.
// Nothing here posts money except charting work as done, which goes through completeProcedure like the chart.

const MAX_ITEMS = 40;
const COLOR = /^#[0-9a-f]{6}$/i;
const SCOPES = ['office', 'mine'];
const ownerOf = (req, scope) => (scope === 'office' ? 'office' : `u${req.user.id}`);
const parseItems = (v) => { try { return JSON.parse(v || '[]'); } catch { return []; } };
const bundleOut = (b, req) => ({ ...b, items: parseItems(b.items), mine: b.user_id === req.user.id });

export default function treatmentEntryRoutes({ db }) {
  const r = Router();
  const admin = (req) => req.user.role === 'admin';

  // Office rows need an administrator; a person's own rows need clinical:write (checked by the route).
  const mayEdit = (req, row) => {
    if (row.user_id == null ? !admin(req) : row.user_id !== req.user.id) throw new HttpError(403, row.user_id == null ? 'Only an administrator can change the office’s shortcuts and bundles' : 'That belongs to someone else');
  };
  const scopeOf = (req, raw) => {
    const scope = raw || (admin(req) ? 'office' : 'mine');
    if (!SCOPES.includes(scope)) throw new HttpError(400, 'scope must be office or mine');
    if (scope === 'office' && !admin(req)) throw new HttpError(403, 'Only an administrator can change the office’s shortcuts and bundles; add it to your own instead');
    return scope;
  };
  // A bundle or button this person can see: the office's, or their own (someone else's is "not found").
  const visible = async (req, table, id, label) => {
    const row = await findOr404(db, table, id, req.user.practice_id, label);
    if (row.user_id != null && row.user_id !== req.user.id) throw new HttpError(404, `${label} not found`);
    return row;
  };

  // A new practice starts with the starter bundles and buttons (once: after that they are the office's own to
  // change or retire). Two first requests at once can't seed twice: (practice, owner, starter_key) is unique.
  async function seed(req) {
    const pid = req.user.practice_id;
    if (await db.get("SELECT id FROM procedure_bundles WHERE practice_id = ? AND owner = 'office' LIMIT 1", pid)) return;
    try {
      await db.tx(async () => {
        const ids = {};
        for (const s of STARTER_BUNDLES) {
          ids[s.key] = await insert(db, 'procedure_bundles', { practice_id: pid, owner: 'office', name: s.name, alias: s.alias, items: JSON.stringify(checkBundle(s).items), starter_key: s.key, created_by: req.user.id });
        }
        for (const [i, [label, kind, target, mode, color, icon]] of STARTER_SHORTCUTS.entries()) {
          await insert(db, 'chart_shortcuts', {
            practice_id: pid, owner: 'office', label, kind, target: kind === 'bundle' ? String(ids[target]) : target, bundle_id: kind === 'bundle' ? ids[target] : null,
            mode, color, icon, button: 1, position: i + 1, starter_key: `${kind}:${target}`, created_by: req.user.id,
          });
        }
      });
      await audit(db, req, 'chart_shortcuts.seed', 'practices', pid, { bundles: STARTER_BUNDLES.length, buttons: STARTER_SHORTCUTS.length });
    } catch (err) {
      if (!/unique|duplicate/i.test(String(err.message)) && err.code !== '23505') throw err;
    }
  }

  // Everything this person charts with: the office's and their own bundles and buttons (retired ones too with ?all=1).
  async function setupFor(req, { all = false } = {}) {
    await seed(req);
    const pid = req.user.practice_id;
    const live = all ? '' : ' AND active = 1';
    const bundles = (await db.all(`SELECT * FROM procedure_bundles WHERE practice_id = ? AND (user_id IS NULL OR user_id = ?)${live} ORDER BY user_id IS NOT NULL, name, id`, pid, req.user.id)).map((b) => bundleOut(b, req));
    const shortcuts = (await db.all(`SELECT * FROM chart_shortcuts WHERE practice_id = ? AND (user_id IS NULL OR user_id = ?)${live} ORDER BY user_id IS NOT NULL, position, id`, pid, req.user.id))
      .map((s) => ({ ...s, mine: s.user_id === req.user.id }));
    return { bundles, shortcuts };
  }

  r.get('/chart-shortcuts', requirePermission('clinical:read'), async (req, res) => {
    const setup = await setupFor(req, { all: req.query.all === '1' });
    const office = setup.bundles.filter((b) => b.user_id == null);
    res.json({
      ...setup,
      starters: STARTER_BUNDLES.map((s) => ({ ...s, office: office.some((b) => b.starter_key === s.key && b.active) })),
      icons: SHORTCUT_ICONS,
      can_edit_office: admin(req),
      can_edit_own: can(req.user, 'clinical:write'),
    });
  });

  // ---- Bundles ----
  // Checks a bundle: its shape (chartengine checkBundle), that its codes are on the practice's code list, and that
  // its alias isn't already taken by something this person (or anyone, for the office's) would type.
  async function cleanBundle(req, body, { owner, exceptId = null }) {
    let b;
    try {
      b = checkBundle(body);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    const pid = req.user.practice_id;
    for (const it of b.items) {
      if (it.code && !(await db.get('SELECT id FROM procedure_codes WHERE practice_id = ? AND code = ? AND active = 1', pid, it.code))) {
        throw new HttpError(400, `${it.code} isn’t on your code list: add it in Settings → Fee schedule first`);
      }
    }
    if (b.alias) await aliasFree(req, b.alias, { owner, exceptTable: 'procedure_bundles', exceptId });
    return b;
  }
  async function aliasFree(req, alias, { owner, exceptTable, exceptId }) {
    const pid = req.user.practice_id;
    // The office's aliases are seen by everyone, so they can't clash with anyone's; a person's can't clash with the office's or their own.
    const who = owner === 'office' ? '' : ' AND (user_id IS NULL OR user_id = ?)';
    const args = owner === 'office' ? [] : [req.user.id];
    for (const table of ['procedure_bundles', 'chart_shortcuts']) {
      const hit = await db.get(`SELECT id, ${table === 'procedure_bundles' ? 'name' : 'label'} AS name FROM ${table} WHERE practice_id = ? AND active = 1 AND lower(alias) = ?${who}`, pid, alias.toLowerCase(), ...args);
      if (hit && !(table === exceptTable && hit.id === Number(exceptId))) throw new HttpError(409, `“${alias}” is already the alias for ${hit.name}`);
    }
  }

  r.post('/procedure-bundles', requirePermission('clinical:write'), async (req, res) => {
    const scope = scopeOf(req, req.body?.scope);
    const owner = ownerOf(req, scope);
    const b = await cleanBundle(req, req.body || {}, { owner });
    const id = await insert(db, 'procedure_bundles', {
      practice_id: req.user.practice_id, user_id: scope === 'office' ? null : req.user.id, owner, name: b.name, alias: b.alias, items: JSON.stringify(b.items), created_by: req.user.id,
    });
    await audit(db, req, 'procedure_bundle.create', 'procedure_bundles', id, { name: b.name, scope });
    res.status(201).json(bundleOut(await db.get('SELECT * FROM procedure_bundles WHERE id = ?', id), req));
  });

  r.put('/procedure-bundles/:id', requirePermission('clinical:write'), async (req, res) => {
    const existing = await visible(req, 'procedure_bundles', req.params.id, 'Bundle');
    mayEdit(req, existing);
    const b = await cleanBundle(req, { name: existing.name, alias: existing.alias, items: parseItems(existing.items), ...req.body }, { owner: existing.owner, exceptId: existing.id });
    await update(db, 'procedure_bundles', existing.id, req.user.practice_id, { name: b.name, alias: b.alias, items: JSON.stringify(b.items), updated_at: new Date().toISOString() });
    await audit(db, req, 'procedure_bundle.update', 'procedure_bundles', existing.id, { name: b.name }, {
      before: { name: existing.name, alias: existing.alias, items: existing.items }, after: { name: b.name, alias: b.alias, items: JSON.stringify(b.items) },
    });
    res.json(bundleOut(await db.get('SELECT * FROM procedure_bundles WHERE id = ?', existing.id), req));
  });

  // Retired, not deleted: what was charted with it keeps its history, and it can be brought back.
  const retire = (table, label, action) => async (req, res) => {
    const existing = await visible(req, table, req.params.id, label);
    mayEdit(req, existing);
    const on = action === 'restore';
    if (!!existing.active === on) return res.json({ ...existing, already: true });
    if (on && existing.alias) await aliasFree(req, existing.alias, { owner: existing.owner, exceptTable: table, exceptId: existing.id });
    await recorded(db, table, existing.id, () => db.run(`UPDATE ${table} SET active = ?, retired_at = ?, retired_by = ? WHERE id = ?`, on ? 1 : 0, on ? null : new Date().toISOString(), on ? null : req.user.id, existing.id));
    await audit(db, req, `${table === 'procedure_bundles' ? 'procedure_bundle' : 'chart_shortcut'}.${action}`, table, existing.id, { name: existing.name || existing.label });
    res.json(await db.get(`SELECT * FROM ${table} WHERE id = ?`, existing.id));
  };
  r.post('/procedure-bundles/:id/retire', requirePermission('clinical:write'), retire('procedure_bundles', 'Bundle', 'retire'));
  r.post('/procedure-bundles/:id/restore', requirePermission('clinical:write'), retire('procedure_bundles', 'Bundle', 'restore'));

  // One click: a starter for the office (brought back if it was retired) or a copy of your own to adapt.
  r.post('/procedure-bundles/starters/:key', requirePermission('clinical:write'), async (req, res) => {
    const starter = STARTER_BUNDLES.find((s) => s.key === req.params.key);
    if (!starter) throw new HttpError(404, 'No such starter bundle');
    const scope = scopeOf(req, req.body?.scope);
    const owner = ownerOf(req, scope);
    await seed(req);
    const had = await db.get('SELECT * FROM procedure_bundles WHERE practice_id = ? AND owner = ? AND starter_key = ?', req.user.practice_id, owner, starter.key);
    if (had?.active) return res.json({ ...bundleOut(had, req), already: true });
    // A personal copy of a starter the office also has can't share its alias: it starts without one.
    let b;
    try {
      b = await cleanBundle(req, starter, { owner, exceptId: had?.id });
    } catch (e) {
      if (!(e.status === 409 && scope === 'mine')) throw e;
      b = await cleanBundle(req, { ...starter, alias: null }, { owner });
    }
    let id = had?.id;
    if (had) {
      await update(db, 'procedure_bundles', had.id, req.user.practice_id, { active: 1, retired_at: null, retired_by: null, updated_at: new Date().toISOString() });
    } else {
      id = await insert(db, 'procedure_bundles', { practice_id: req.user.practice_id, user_id: scope === 'office' ? null : req.user.id, owner, name: b.name, alias: b.alias, items: JSON.stringify(b.items), starter_key: starter.key, created_by: req.user.id });
    }
    await audit(db, req, had ? 'procedure_bundle.restore' : 'procedure_bundle.create', 'procedure_bundles', id, { name: b.name, starter: starter.key, scope });
    res.status(had ? 200 : 201).json(bundleOut(await db.get('SELECT * FROM procedure_bundles WHERE id = ?', id), req));
  });

  // ---- Quick buttons and aliases ----
  async function cleanShortcut(req, body, { owner, existing = null }) {
    const s = { ...(existing || {}), ...body };
    const out = {};
    out.label = String(s.label || '').trim().slice(0, 30);
    if (!out.label) throw new HttpError(400, 'Give the button a label');
    if (!['code', 'work', 'finding', 'bundle'].includes(s.kind)) throw new HttpError(400, 'kind must be code, work, finding or bundle');
    out.kind = s.kind;
    out.mode = s.mode || (s.kind === 'finding' ? 'existing' : 'plan');
    if (!['plan', 'done', 'existing'].includes(out.mode)) throw new HttpError(400, 'mode must be plan, done or existing');
    out.bundle_id = null;
    const target = String(s.kind === 'bundle' ? s.bundle_id ?? s.target ?? '' : s.target ?? '').trim();
    if (s.kind === 'code') {
      out.target = target.toUpperCase();
      if (!(await db.get('SELECT id FROM procedure_codes WHERE practice_id = ? AND code = ? AND active = 1', req.user.practice_id, out.target))) throw new HttpError(400, `${out.target || 'That code'} isn’t on your code list`);
      if (out.mode === 'existing') throw new HttpError(400, 'A code is planned or done; use a finding or kind of work for what’s already there');
    } else if (s.kind === 'work') {
      if (!WORK_KINDS.includes(target)) throw new HttpError(400, `Unknown kind of work “${target}”`);
      out.target = target;
    } else if (s.kind === 'finding') {
      if (!FINDING_KINDS.includes(target)) throw new HttpError(400, `Unknown finding “${target}”`);
      out.target = target;
      out.mode = 'existing';
    } else {
      const b = await visible(req, 'procedure_bundles', target, 'Bundle');
      // The office's buttons can only open the office's bundles (a person's own isn't theirs to share).
      if (owner === 'office' && b.user_id != null) throw new HttpError(400, 'An office button can only use an office bundle');
      if (out.mode === 'existing') throw new HttpError(400, 'A bundle is planned or done');
      out.target = String(b.id);
      out.bundle_id = b.id;
    }
    const surfaces = s.surfaces == null || s.surfaces === '' ? null : String(s.surfaces).toUpperCase();
    if (surfaces && !/^[MODBLFI]{1,5}$/.test(surfaces)) throw new HttpError(400, 'surfaces must be letters from M, O, D, B, L, F, I');
    out.surfaces = surfaces;
    out.color = s.color == null || s.color === '' ? null : String(s.color);
    if (out.color && !COLOR.test(out.color)) throw new HttpError(400, 'color must look like #2563eb');
    out.icon = s.icon == null || s.icon === '' ? null : String(s.icon);
    if (out.icon && !SHORTCUT_ICONS.includes(out.icon)) throw new HttpError(400, `icon must be one of ${SHORTCUT_ICONS.join(', ')}`);
    out.button = s.button === false || s.button === 0 ? 0 : 1;
    out.alias = s.alias == null || String(s.alias).trim() === '' ? null : String(s.alias).trim().toLowerCase();
    if (out.alias) {
      try {
        checkBundle({ name: 'x', alias: out.alias, items: [{ code: 'D0000' }] });
      } catch (e) {
        throw new HttpError(400, e.message);
      }
      await aliasFree(req, out.alias, { owner, exceptTable: 'chart_shortcuts', exceptId: existing?.id });
    }
    if (!out.button && !out.alias) throw new HttpError(400, 'Show it as a button, give it an alias, or both');
    return out;
  }

  r.post('/chart-shortcuts', requirePermission('clinical:write'), async (req, res) => {
    const scope = scopeOf(req, req.body?.scope);
    const owner = ownerOf(req, scope);
    await seed(req);
    const row = await cleanShortcut(req, req.body || {}, { owner });
    const last = await db.get('SELECT MAX(position) AS m FROM chart_shortcuts WHERE practice_id = ? AND owner = ?', req.user.practice_id, owner);
    const id = await insert(db, 'chart_shortcuts', { ...row, practice_id: req.user.practice_id, user_id: scope === 'office' ? null : req.user.id, owner, position: (last?.m || 0) + 1, created_by: req.user.id });
    await audit(db, req, 'chart_shortcut.create', 'chart_shortcuts', id, { label: row.label, kind: row.kind, target: row.target, scope });
    res.status(201).json(await db.get('SELECT * FROM chart_shortcuts WHERE id = ?', id));
  });

  // Order before :id, so "order" isn't read as an id.
  r.put('/chart-shortcuts/order', requirePermission('clinical:write'), async (req, res) => {
    const scope = scopeOf(req, req.body?.scope);
    const owner = ownerOf(req, scope);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    if (!ids.length || ids.length > MAX_ITEMS || new Set(ids).size !== ids.length) throw new HttpError(400, 'ids must list the buttons in their new order');
    const rows = await db.all('SELECT id, position FROM chart_shortcuts WHERE practice_id = ? AND owner = ?', req.user.practice_id, owner);
    const mine = new Set(rows.map((x) => x.id));
    if (ids.some((id) => !mine.has(id))) throw new HttpError(400, `Those aren’t all ${scope === 'office' ? 'the office’s' : 'your'} buttons`);
    const before = Object.fromEntries(rows.map((x) => [x.id, x.position]));
    await db.tx(async () => {
      for (const [i, id] of ids.entries()) if (before[id] !== i + 1) await recorded(db, 'chart_shortcuts', id, () => db.run('UPDATE chart_shortcuts SET position = ? WHERE id = ?', i + 1, id));
    });
    await audit(db, req, 'chart_shortcut.reorder', 'chart_shortcuts', ids[0], { scope, order: ids }, { before: { order: rows.sort((a, b) => a.position - b.position).map((x) => x.id).join(',') }, after: { order: ids.join(',') } });
    res.json((await setupFor(req)).shortcuts);
  });

  r.put('/chart-shortcuts/:id', requirePermission('clinical:write'), async (req, res) => {
    const existing = await visible(req, 'chart_shortcuts', req.params.id, 'Shortcut');
    mayEdit(req, existing);
    const row = await cleanShortcut(req, req.body || {}, { owner: existing.owner, existing });
    await update(db, 'chart_shortcuts', existing.id, req.user.practice_id, { ...row, updated_at: new Date().toISOString() });
    await audit(db, req, 'chart_shortcut.update', 'chart_shortcuts', existing.id, { label: row.label });
    res.json(await db.get('SELECT * FROM chart_shortcuts WHERE id = ?', existing.id));
  });
  r.post('/chart-shortcuts/:id/retire', requirePermission('clinical:write'), retire('chart_shortcuts', 'Shortcut', 'retire'));
  r.post('/chart-shortcuts/:id/restore', requirePermission('clinical:write'), retire('chart_shortcuts', 'Shortcut', 'restore'));

  // ---- One engine → one preview → chart ----
  const chartOf = async (patient) => ({
    conditions: await db.all('SELECT tooth, surfaces, condition, resolved, voided_at FROM tooth_conditions WHERE patient_id = ? AND practice_id = ? AND voided_at IS NULL', patient.id, patient.practice_id),
    procedures: await db.all("SELECT tooth, surfaces, area, code, status FROM procedures WHERE patient_id = ? AND practice_id = ? AND status != 'cancelled'", patient.id, patient.practice_id),
  });

  // Items sent back by the browser (it previewed them): taken field by field, never trusted.
  function takeItems(raw) {
    if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'Nothing to chart');
    if (raw.length > MAX_ITEMS) throw new HttpError(400, `Chart up to ${MAX_ITEMS} things at a time`);
    return raw.map((it) => {
      const type = it?.type === 'condition' ? 'condition' : it?.type === 'procedure' ? 'procedure' : null;
      if (!type) throw new HttpError(400, 'Each item is a procedure or a condition');
      const tooth = it.tooth == null || it.tooth === '' ? null : String(it.tooth).toUpperCase();
      const surfaces = it.surfaces == null || it.surfaces === '' ? null : String(it.surfaces).toUpperCase();
      const out = { type, tooth, surfaces };
      if (type === 'condition') out.condition = String(it.condition || '');
      else {
        out.code = String(it.code || '').toUpperCase();
        out.complete = it.complete === true;
        if (it.area != null && it.area !== '') out.area = String(it.area).toUpperCase();
        if (it.phase != null && it.phase !== '') out.phase = Number(it.phase);
      }
      if (it.bundle) out.bundle = String(it.bundle).slice(0, 60);
      return out;
    });
  }

  // Every item checked the way charting it one at a time would be, plus what the engine knows (surfaces for the
  // tooth, quadrant codes): returns items with their code's description and fee, and an error on any that can't go in.
  async function checkItems(req, patient, items) {
    const pid = req.user.practice_id;
    const codes = new Map();
    const out = [];
    for (const it of items) {
      const o = { ...it, text: describe(it) };
      let error = null;
      if (it.tooth && !validTooth(it.tooth)) error = `#${it.tooth} isn't a tooth`;
      else if (it.surfaces && !/^[MODBLFI]{1,5}$/.test(it.surfaces)) error = `${it.surfaces} aren't surfaces (M, O, D, B, L, F, I)`;
      else error = itemProblem(it);
      if (!error && it.type === 'condition') {
        if (!CONDITIONS.includes(it.condition)) error = `Unknown finding “${it.condition}”`;
        else if (!it.tooth) error = `${it.condition} needs a tooth`;
      }
      if (!error && it.type === 'procedure') {
        if (!codes.has(it.code)) codes.set(it.code, await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ? AND active = 1', pid, it.code));
        const code = codes.get(it.code);
        const kind = code && codeArea(code);
        if (!/^D\d{4}$/.test(it.code)) error = `${it.code || 'A blank code'} isn't a CDT code`;
        else if (!code) error = `${it.code} isn’t on your code list: add it in Settings → Fee schedule, or leave it out`;
        else if (code.requires_tooth && !it.tooth) error = `${it.code} (${code.description}) needs a tooth`;
        else if (code.requires_surface && !it.surfaces) error = `${it.code} needs surfaces, e.g. MO`;
        else if (kind === 'quadrant' && !QUADRANTS.includes(it.area)) error = `${it.code} is charted by quadrant: UR, UL, LL or LR`;
        else if (kind === 'arch' && !ARCHES.includes(it.area)) error = `${it.code} is charted by arch: upper or lower`;
        else if (!['quadrant', 'arch'].includes(kind) && it.area) error = `${it.code} isn't charted by quadrant or arch`;
        else if (it.phase != null && !(Number.isInteger(it.phase) && it.phase >= 1 && it.phase <= 9)) error = 'phase must be 1-9';
        if (code) {
          o.description = code.description;
          o.fee = await officeFee(db, pid, code, { patientId: patient?.id, locationId: req.location_id });
        }
      }
      if (error) o.error = error;
      out.push(o);
    }
    return out;
  }

  async function preview(req, patient, items, chart) {
    const checked = await checkItems(req, patient, items);
    const errors = checked.filter((it) => it.error).map((it) => `${it.text}: ${it.error}`);
    const warnings = chartWarnings(items, chart);
    let estimate = null;
    const priced = checked.filter((it) => it.type === 'procedure' && !it.error);
    if (patient && !errors.length && priced.length && can(req.user, 'billing:read')) {
      estimate = await estimateFor(db, req, patient, { items: priced.map((it) => ({ code: it.code, tooth: it.tooth, surfaces: it.surfaces, area: it.area || null })) });
      // Frequency limits, waiting periods and the like, said once each.
      for (const [i, line] of estimate.items.entries()) {
        for (const note of line.notes || []) warnings.push(`${priced[i].text}: ${note}`);
      }
    }
    return { items: checked, errors, warnings: [...new Set(warnings)], total_fee: priced.reduce((s, it) => s + (it.fee || 0), 0), estimate };
  }

  // What text or items would chart as — nothing is saved. { patient_id?, text | items, tooth? (the tooth selected
  // on the drawing, used when the entry names none) } → { items, errors, warnings, total_fee, estimate } or, for
  // "compare option one … option two …", { options: [{ label, summary, items, … }] }. The voice assistant's
  // chart_entry tool shows this before anything is charted.
  r.post('/charting/resolve', requirePermission('clinical:read'), async (req, res) => {
    const body = req.body || {};
    const patient = body.patient_id != null ? await findOr404(db, 'patients', body.patient_id, req.user.practice_id, 'Patient') : null;
    const chart = patient ? await chartOf(patient) : null;
    if (body.text == null) {
      const out = await preview(req, patient, takeItems(body.items), chart);
      return res.json({ ...out, options: null, bundles: [], ok: !out.errors.length });
    }
    const text = String(body.text).slice(0, 2000);
    if (!text.trim()) throw new HttpError(400, 'Type or say what to chart');
    const setup = await setupFor(req);
    const ctx = { lookups: buildLookups(setup), chart };
    let parsed;
    try {
      parsed = resolveEntry(text, ctx);
    } catch (e) {
      const tooth = body.tooth == null ? null : String(body.tooth).toUpperCase();
      if (!(tooth && validTooth(tooth) && /tooth number|which tooth/i.test(e.message))) throw new HttpError(400, e.message);
      try {
        parsed = resolveEntry(`${/^[A-T]S?$/.test(tooth) ? '#' : ''}${tooth} ${text}`, ctx);
      } catch (e2) {
        throw new HttpError(400, e2.message);
      }
    }
    if (parsed.options) {
      const options = [];
      for (const o of parsed.options) options.push({ label: o.label, summary: o.summary, ...(await preview(req, patient, o.items, chart)) });
      return res.json({ items: [], options, bundles: [], errors: options.flatMap((o) => o.errors), warnings: [], ok: options.every((o) => !o.errors.length) });
    }
    if (parsed.items.length > MAX_ITEMS) throw new HttpError(400, `Chart up to ${MAX_ITEMS} things at a time`);
    const out = await preview(req, patient, parsed.items, chart);
    res.json({ ...out, options: null, bundles: parsed.bundles, ok: !out.errors.length });
  });

  // Chart it: everything in one go (all or nothing), each item checked again here. Planned work and findings can be
  // taken back with Undo (cancel / void); work charted as done posts its charge like completing it on the chart.
  r.post('/patients/:id/chart-entry', requirePermission('clinical:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const body = req.body || {};
    let items;
    if (body.text != null) {
      const setup = await setupFor(req);
      try {
        const parsed = resolveEntry(String(body.text).slice(0, 2000), { lookups: buildLookups(setup), chart: await chartOf(patient) });
        if (parsed.options) throw new HttpError(400, 'That’s a comparison of options: it becomes treatment options, not chart entries');
        items = takeItems(parsed.items);
      } catch (e) {
        throw e instanceof HttpError ? e : new HttpError(400, e.message);
      }
    } else items = takeItems(body.items);
    const checked = await checkItems(req, patient, items);
    const bad = checked.filter((it) => it.error);
    if (bad.length) throw new HttpError(400, bad.map((it) => `${it.text}: ${it.error}`).join('; '));
    // Completing work posts charges: the assistant needs the person's yes on screen (as aiguard.js does for
    // POST /procedures with complete).
    if (items.some((it) => it.complete) && currentActor()?.source === 'ai') {
      if (req.get('X-Human-Approved') !== '1') throw new HttpError(428, 'The assistant can’t do this without your OK (completing procedures posts charges). Confirm it, or do it yourself.');
      setActor({ actor: `Assistant (for ${req.user.name}, approved by ${req.user.name})`, approvedBy: req.user.id });
    }
    const providerId = body.provider_id == null || body.provider_id === '' ? undefined : Number(body.provider_id);
    const planId = body.treatment_plan_id == null || body.treatment_plan_id === '' ? undefined : Number(body.treatment_plan_id);
    const made = await db.tx(async () => {
      const done = [];
      for (const it of items) {
        if (it.type === 'condition') {
          const id = await insert(db, 'tooth_conditions', { tooth: it.tooth, surfaces: it.surfaces, condition: it.condition, patient_id: patient.id, practice_id: req.user.practice_id, recorded_by: req.user.id });
          done.push({ kind: 'condition', id, it });
          continue;
        }
        const row = await buildProcedureRow(db, req, patient.id, {
          code: it.code, tooth: it.tooth, surfaces: it.surfaces, area: it.area ?? null, phase: it.phase ?? 1, provider_id: providerId, treatment_plan_id: it.complete ? undefined : planId,
        });
        const id = await insert(db, 'procedures', row);
        if (it.complete) await completeProcedure(db, req.user, await db.get('SELECT * FROM procedures WHERE id = ?', id), { locationId: req.location_id });
        done.push({ kind: it.complete ? 'completed' : 'planned', id, it });
      }
      return done;
    });
    const via = ['typing', 'button', 'voice', 'bundle'].includes(body.source) ? body.source : 'typing';
    for (const m of made) {
      if (m.kind === 'condition') await audit(db, req, 'condition.create', 'tooth_conditions', m.id, { via, bundle: m.it.bundle || undefined }, { patientId: patient.id });
      else await audit(db, req, 'procedure.create', 'procedures', m.id, { code: m.it.code, complete: m.it.complete, via, bundle: m.it.bundle || undefined }, { patientId: patient.id });
    }
    res.status(201).json({
      made: made.map(({ kind, id }) => ({ kind, id })),
      procedures: await mapSeq(made.filter((m) => m.kind !== 'condition'), (m) => db.get('SELECT * FROM procedures WHERE id = ?', m.id)),
      conditions: await mapSeq(made.filter((m) => m.kind === 'condition'), (m) => db.get('SELECT * FROM tooth_conditions WHERE id = ?', m.id)),
    });
  });

  return r;
}
