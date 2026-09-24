import { Router } from 'express';
import { HttpError, can } from '../auth.js';
import { audit, findOr404, update, practiceNow } from '../util.js';
import { currentActor, setActor } from '../actor.js';
import { checkOffice } from '../officeaccess.js';
import { publish } from '../events.js';
import { utcToLocal } from '../timeclock.js';
import {
  CATEGORIES, CATEGORY_DEFAULTS, LAB_MODES, PAY_BASES, PAY_BASIS_LABELS, DEFAULT_SETTINGS, BAND_LABELS, STATE_LABELS, EXAM_TYPE_LABELS, versionOn,
} from '../business.js';
import {
  ensureBusinessSchema, insertId, loadSettings, loadCosts, overheadFor, scheduleBusiness, todayBusiness, staffDay, staffRoles, businessTrends, trendRows,
  marginReport, whatIf, suggestions, examsBusiness,
} from '../businessdata.js';
import { staffList, practiceRules } from './timeclock.js';

// The business view (PM1–PM4, BD1–BD4, EX1–EX3; docs/business-view.md, docs/workflows/specs/BV-business-view.md).
// Mounted with the signed-in API: api.use(businessRoutes({ db })).
//
// Who sees what (the server never sends what a person may not see):
//  - business:view (the owner; administrators always) — margins, costs, bands, today's P&L, reports, trends;
//  - business:manage — change procedure costs, provider pay plans, thresholds and staff roles;
//  - timeclock:rates — anything that is pay: labor cost, labor %, provider pay lines and plans, idle cost;
//  - timeclock:manage (office managers) — the staff lanes (hours and productivity, no money) without business:view;
//  - everyone else: 403. The exam counts vs target (huddle card) are for anyone who sees the schedule; their dollar
//    value only with business:view.
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
const reqDate = (v, name) => {
  if (!isDate(v)) throw new HttpError(400, `${name} must be a real date (YYYY-MM-DD)`);
  return v;
};
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const intIn = (v, name, min, max, { nullable = false } = {}) => {
  if (v == null || v === '') {
    if (nullable) return null;
    throw new HttpError(400, `${name} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
  return n;
};
const cents = (v, name, opts) => intIn(v, name, 0, 100_000_000, opts);
const bps = (v, name, opts) => intIn(v, name, 0, 10000, opts);
const clean = (v, max = 300) => (v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) || null);
const ids = (v, name) => {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, `${name} must be a list`);
  return [...new Set(v.map((x) => intIn(x, name, 1, 2 ** 31 - 1)))];
};

export default function businessRoutes({ db }) {
  const r = Router();
  const view = (req) => can(req.user, 'business:view');
  const manage = (req) => can(req.user, 'business:manage');
  const rates = (req) => can(req.user, 'timeclock:rates');
  const lanes = (req) => view(req) || can(req.user, 'timeclock:manage');
  const need = (ok, perm) => {
    if (!ok) throw new HttpError(403, `Missing permission: ${perm}`);
  };
  const nowMs = (req) => req.app?.locals?.businessNow?.() ?? req.app?.locals?.timeclockNow?.() ?? Date.now();
  const todayOf = async (req) => {
    const { tz } = await practiceRules(db, req.user.practice_id);
    return utcToLocal(tz, nowMs(req)).slice(0, 10);
  };
  // The office: ?location_id=, else the one the screen works in; it must be the practice's and one of the person's.
  const officeOf = async (req) => {
    const raw = req.query.location_id ?? req.location_id ?? null;
    if (raw == null || raw === '') return null;
    const id = intIn(raw, 'location_id', 1, 2 ** 31 - 1);
    await findOr404(db, 'locations', id, req.user.practice_id, 'Office');
    checkOffice(req.user, id);
    return id;
  };

  r.use('/business', async (req, res, next) => {
    try {
      await ensureBusinessSchema(db);
      // Costs, pay and thresholds change what the owner sees about money: the assistant may suggest, a person says yes.
      const ctx = currentActor();
      if (ctx?.source === 'ai' && req.method !== 'GET') {
        if (req.get('X-Human-Approved') !== '1') return res.status(428).json({ error: 'The assistant can’t change costs, pay plans or thresholds without your OK. Confirm it, or do it yourself.', needs_approval: true });
        setActor({ approvedBy: req.user.id });
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  r.get('/business/access', (req, res) => res.json({ view: view(req), manage: manage(req), rates: rates(req), lanes: lanes(req), exams: can(req.user, 'schedule:read') }));

  // ---------------- Settings ----------------
  r.get('/business/settings', async (req, res) => {
    need(view(req), 'business:view');
    const s = await loadSettings(db, req.user.practice_id);
    const overhead = await overheadFor(db, req.user.practice_id, await todayOf(req), s);
    res.json({ settings: s, defaults: DEFAULT_SETTINGS, overhead, bands: BAND_LABELS, can_manage: manage(req) });
  });
  r.put('/business/settings', async (req, res) => {
    need(manage(req), 'business:manage');
    const b = req.body || {};
    const row = {};
    if (b.basis !== undefined) {
      if (!['chair', 'doctor'].includes(b.basis)) throw new HttpError(400, 'basis must be chair or doctor');
      row.basis = b.basis;
    }
    if (b.overhead_mode !== undefined) {
      if (!['auto', 'manual'].includes(b.overhead_mode)) throw new HttpError(400, 'overhead_mode must be auto or manual');
      row.overhead_mode = b.overhead_mode;
    }
    for (const k of ['overhead_per_hour_cents', 'fixed_costs_month_cents', 'red_below_cents', 'green_from_cents', 'gold_from_cents']) if (b[k] !== undefined) row[k] = cents(b[k], k, { nullable: true });
    for (const k of ['labor_target_low_bp', 'labor_target_high_bp', 'patient_collect_bp', 'default_merchant_bp']) if (b[k] !== undefined) row[k] = bps(b[k], k);
    if (b.assistants_per_doctor_chair_bp !== undefined) row.assistants_per_doctor_chair_bp = intIn(b.assistants_per_doctor_chair_bp, 'assistants_per_doctor_chair_bp', 0, 40000);
    if (b.work_days_month !== undefined) row.work_days_month = intIn(b.work_days_month, 'work_days_month', 1, 31);
    if (b.idle_gap_minutes !== undefined) row.idle_gap_minutes = intIn(b.idle_gap_minutes, 'idle_gap_minutes', 5, 240);
    const before = await loadSettings(db, req.user.practice_id);
    const next = { ...before, ...row };
    if (next.labor_target_low_bp > next.labor_target_high_bp) throw new HttpError(400, 'The low end of the labor target must be below the high end');
    const bands = [next.red_below_cents, next.green_from_cents, next.gold_from_cents].filter((x) => x != null);
    if (bands.some((x, i) => i && x < bands[i - 1])) throw new HttpError(400, 'The color thresholds must go up: red below ≤ green from ≤ gold from');
    if (next.overhead_mode === 'manual' && next.overhead_per_hour_cents == null && next.fixed_costs_month_cents == null) throw new HttpError(400, 'Enter your fixed cost per chair-hour or your monthly fixed costs, or use the finance numbers');
    if (!Object.keys(row).length) throw new HttpError(400, 'Nothing to change');
    const stamp = { updated_by: req.user.id, updated_at: new Date().toISOString() };
    let id = before.id;
    if (id) await update(db, 'business_settings', id, req.user.practice_id, { ...row, ...stamp });
    else {
      try {
        id = await insertId(db, `INSERT INTO business_settings (practice_id, ${Object.keys(row).join(', ')}, updated_by, updated_at) VALUES (?, ${Object.keys(row).map(() => '?').join(', ')}, ?, ?)`,
          req.user.practice_id, ...Object.values(row), stamp.updated_by, stamp.updated_at);
      } catch (err) {
        if (!/unique|duplicate/i.test(String(err?.message))) throw err;
        id = (await db.get('SELECT id FROM business_settings WHERE practice_id = ?', req.user.practice_id)).id;
        await update(db, 'business_settings', id, req.user.practice_id, { ...row, ...stamp });
      }
    }
    const beforeSubset = Object.fromEntries(Object.keys(row).map((k) => [k, before[k]]));
    await audit(db, req, 'business.settings', 'business_settings', id, null, { before: beforeSubset, after: row, reason: clean(b.reason) });
    publish(req.user.practice_id, { type: 'business' });
    res.json(await loadSettings(db, req.user.practice_id));
  });

  // ---------------- PM1: cost profiles (versions, never overwritten) ----------------
  const profileView = (p, req) => {
    const out = { ...p };
    if (!rates(req)) delete out.pay_pct_bp;
    return out;
  };
  r.get('/business/cost-profiles', async (req, res) => {
    need(view(req), 'business:view');
    const today = await todayOf(req);
    const { profiles } = await loadCosts(db, req.user.practice_id);
    const users = new Map((await db.all('SELECT id, name FROM users WHERE practice_id = ?', req.user.practice_id)).map((u) => [u.id, u.name]));
    const keys = [...new Set(profiles.map((p) => `${p.scope}|${p.scope_key}`))];
    const current = keys.map((k) => {
      const [scope, key] = k.split('|');
      const list = profiles.filter((p) => p.scope === scope && p.scope_key === key);
      const now = versionOn(list, today);
      const upcoming = list.filter((p) => p.effective_from > today).sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
      return { scope, scope_key: key, current: now ? profileView(now, req) : null, upcoming: upcoming.map((p) => profileView(p, req)), versions: list.length };
    });
    const codes = await db.all('SELECT code, description, category, fee FROM procedure_codes WHERE practice_id = ? AND active = 1 ORDER BY code', req.user.practice_id);
    res.json({
      today, profiles: current, history: profiles.map((p) => ({ ...profileView(p, req), created_by_name: users.get(p.created_by) || null })).reverse(),
      categories: CATEGORIES, defaults: CATEGORY_DEFAULTS, lab_modes: LAB_MODES, codes, can_manage: manage(req), rates: rates(req),
    });
  });
  const profileRow = async (req, b, today) => {
    const scope = b.scope;
    if (!['code', 'category'].includes(scope)) throw new HttpError(400, 'scope must be code or category');
    const key = clean(b.scope_key ?? b.key, 20);
    if (!key) throw new HttpError(400, 'Say which code or category');
    if (scope === 'category' && !CATEGORIES.includes(key)) throw new HttpError(400, `category must be one of: ${CATEGORIES.join(', ')}`);
    if (scope === 'code' && !(await db.get('SELECT id FROM procedure_codes WHERE practice_id = ? AND code = ?', req.user.practice_id, key))) throw new HttpError(404, `Procedure code ${key} isn’t in this practice’s codes`);
    const labMode = b.lab_mode ?? 'none';
    if (!LAB_MODES.includes(labMode)) throw new HttpError(400, 'lab_mode must be none, fixed or case');
    if (b.pay_pct_bp != null && b.pay_pct_bp !== '' && !rates(req)) throw new HttpError(403, 'Missing permission: timeclock:rates (provider pay)');
    const from = b.effective_from ? reqDate(b.effective_from, 'effective_from') : today;
    if (from < '2000-01-01' || from > addDays(today, 730)) throw new HttpError(400, 'effective_from must be within two years from today');
    return {
      scope, scope_key: key, effective_from: from, active: b.active === false || b.active === 0 ? 0 : 1,
      supplies_cents: cents(b.supplies_cents ?? 0, 'supplies_cents'), lab_mode: labMode, lab_cents: cents(b.lab_cents ?? 0, 'lab_cents'),
      merchant_bp: bps(b.merchant_bp, 'merchant_bp', { nullable: true }), pay_pct_bp: bps(b.pay_pct_bp, 'pay_pct_bp', { nullable: true }),
      note: clean(b.note), source: ['manual', 'suggested'].includes(b.source) ? b.source : 'manual',
    };
  };
  const addProfile = async (req, row) => {
    const pid = req.user.practice_id;
    const prev = await db.get('SELECT * FROM business_cost_profiles WHERE practice_id = ? AND scope = ? AND scope_key = ? ORDER BY version_no DESC LIMIT 1', pid, row.scope, row.scope_key);
    // Asking again for exactly what's already the latest version (a double click, a retry) changes nothing.
    const same = prev && ['effective_from', 'active', 'supplies_cents', 'lab_mode', 'lab_cents', 'merchant_bp', 'pay_pct_bp'].every((k) => (prev[k] ?? null) === (row[k] ?? null));
    if (same) return { id: prev.id, version_no: prev.version_no, unchanged: true };
    const version = (prev?.version_no || 0) + 1;
    let id;
    try {
      id = await insertId(db,
        `INSERT INTO business_cost_profiles (practice_id, scope, scope_key, version_no, effective_from, active, supplies_cents, lab_mode, lab_cents, merchant_bp, pay_pct_bp, note, source, created_by, actor_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        pid, row.scope, row.scope_key, version, row.effective_from, row.active, row.supplies_cents, row.lab_mode, row.lab_cents, row.merchant_bp, row.pay_pct_bp, row.note, row.source, req.user.id, currentActor()?.source || 'human');
    } catch (err) {
      if (/unique|duplicate/i.test(String(err?.message))) throw new HttpError(409, 'Someone saved a new version of this cost at the same moment — reload and try again');
      throw err;
    }
    const pick = (x) => (x ? { effective_from: x.effective_from, active: x.active, supplies_cents: x.supplies_cents, lab_mode: x.lab_mode, lab_cents: x.lab_cents, merchant_bp: x.merchant_bp, pay_pct_bp: x.pay_pct_bp } : null);
    await audit(db, req, 'business.cost_profile', 'business_cost_profiles', id, { scope: row.scope, key: row.scope_key, version_no: version }, { before: pick(prev) || undefined, after: pick(row), reason: row.note });
    return { id, version_no: version };
  };
  r.post('/business/cost-profiles', async (req, res) => {
    need(manage(req), 'business:manage');
    const row = await profileRow(req, req.body || {}, await todayOf(req));
    const out = await db.tx(() => addProfile(req, row));
    publish(req.user.practice_id, { type: 'business' });
    res.status(out.unchanged ? 200 : 201).json(out);
  });
  // Several at once (accepting the suggestions): all or nothing.
  r.post('/business/cost-profiles/bulk', async (req, res) => {
    need(manage(req), 'business:manage');
    const items = req.body?.items;
    if (!Array.isArray(items) || !items.length || items.length > 500) throw new HttpError(400, 'items must be a list of 1 to 500 costs');
    const today = await todayOf(req);
    const rows = [];
    for (const it of items) rows.push(await profileRow(req, it, today));
    const out = await db.tx(async () => {
      const done = [];
      for (const row of rows) done.push({ scope: row.scope, scope_key: row.scope_key, ...(await addProfile(req, row)) });
      return done;
    });
    publish(req.user.practice_id, { type: 'business' });
    res.status(201).json({ saved: out.filter((x) => !x.unchanged).length, items: out });
  });
  r.get('/business/cost-profiles/suggestions', async (req, res) => {
    need(view(req), 'business:view');
    res.json(await suggestions(db, req.user.practice_id, await todayOf(req)));
  });

  // ---------------- Provider pay plans (pay: timeclock:rates) ----------------
  r.get('/business/provider-pay', async (req, res) => {
    need(view(req), 'business:view');
    need(rates(req), 'timeclock:rates');
    const today = await todayOf(req);
    const { pay, rates: hourly } = await loadCosts(db, req.user.practice_id);
    const providers = await db.all('SELECT id, name, type, user_id FROM providers WHERE practice_id = ? AND active = 1 ORDER BY name', req.user.practice_id);
    res.json({
      today, bases: PAY_BASIS_LABELS,
      providers: providers.map((p) => {
        const list = pay.filter((x) => x.provider_id === p.id);
        return { ...p, current: versionOn(list, today), upcoming: list.filter((x) => x.effective_from > today), history: [...list].reverse(), clock_rate_cents: hourly.get(p.id) ?? null };
      }),
      can_manage: manage(req),
    });
  });
  r.post('/business/provider-pay', async (req, res) => {
    need(manage(req), 'business:manage');
    need(rates(req), 'timeclock:rates');
    const b = req.body || {};
    const pid = req.user.practice_id;
    const provider = await findOr404(db, 'providers', intIn(b.provider_id, 'provider_id', 1, 2 ** 31 - 1), pid, 'Provider');
    if (!PAY_BASES.includes(b.basis)) throw new HttpError(400, `basis must be one of: ${PAY_BASES.join(', ')}`);
    const today = await todayOf(req);
    const row = {
      basis: b.basis, pct_bp: ['production_pct', 'collections_pct'].includes(b.basis) ? bps(b.pct_bp, 'pct_bp') : 0,
      hourly_cents: b.basis === 'hourly' ? intIn(b.hourly_cents, 'hourly_cents', 0, 100_000, { nullable: true }) : null,
      lab_deducted: b.lab_deducted ? 1 : 0, effective_from: b.effective_from ? reqDate(b.effective_from, 'effective_from') : today, note: clean(b.note),
    };
    const out = await db.tx(async () => {
      const prev = await db.get('SELECT * FROM business_provider_pay WHERE practice_id = ? AND provider_id = ? ORDER BY version_no DESC LIMIT 1', pid, provider.id);
      if (prev && ['basis', 'pct_bp', 'hourly_cents', 'lab_deducted', 'effective_from'].every((k) => (prev[k] ?? null) === (row[k] ?? null))) return { id: prev.id, version_no: prev.version_no, unchanged: true };
      const version = (prev?.version_no || 0) + 1;
      const id = await insertId(db,
        `INSERT INTO business_provider_pay (practice_id, provider_id, version_no, effective_from, basis, pct_bp, hourly_cents, lab_deducted, note, created_by, actor_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, pid, provider.id, version, row.effective_from, row.basis, row.pct_bp, row.hourly_cents, row.lab_deducted, row.note, req.user.id, currentActor()?.source || 'human');
      const pick = (x) => (x ? { basis: x.basis, pct_bp: x.pct_bp, hourly_cents: x.hourly_cents, lab_deducted: x.lab_deducted, effective_from: x.effective_from } : null);
      await audit(db, req, 'business.provider_pay', 'business_provider_pay', id, { provider_id: provider.id, version_no: version }, { before: pick(prev) || undefined, after: pick(row), reason: row.note });
      return { id, version_no: version };
    });
    publish(pid, { type: 'business' });
    res.status(out.unchanged ? 200 : 201).json(out);
  });

  // ---------------- Staff roles for the lanes ----------------
  r.get('/business/staff-roles', async (req, res) => {
    need(lanes(req), 'business:view or timeclock:manage');
    const staff = (await staffList(db, req.user.practice_id)).filter((u) => u.active && u.on_clock !== 0 && u.role !== 'api');
    const roles = await staffRoles(db, req.user.practice_id, staff);
    const providers = await db.all('SELECT id, name, type FROM providers WHERE practice_id = ? AND active = 1 ORDER BY name', req.user.practice_id);
    const chairs = await db.all('SELECT id, name FROM operatories WHERE practice_id = ? AND active = 1 ORDER BY sort, name', req.user.practice_id);
    res.json({ people: staff.map((u) => ({ user_id: u.id, name: u.name, role: u.role, ...roles.get(u.id) })), providers, chairs, can_manage: manage(req) || can(req.user, 'timeclock:manage') });
  });
  r.put('/business/staff-roles/:uid', async (req, res) => {
    need(manage(req) || can(req.user, 'timeclock:manage'), 'business:manage or timeclock:manage');
    const pid = req.user.practice_id;
    const user = await findOr404(db, 'users', intIn(req.params.uid, 'user id', 1, 2 ** 31 - 1), pid, 'Person');
    const b = req.body || {};
    if (!['doctor', 'hygienist', 'assistant', 'admin'].includes(b.kind)) throw new HttpError(400, 'kind must be doctor, hygienist, assistant or admin');
    const providerIds = ids(b.provider_ids, 'provider_ids');
    const chairIds = ids(b.operatory_ids, 'operatory_ids');
    for (const id of providerIds) await findOr404(db, 'providers', id, pid, 'Provider');
    for (const id of chairIds) await findOr404(db, 'operatories', id, pid, 'Chair');
    const row = { kind: b.kind, provider_ids: JSON.stringify(providerIds), operatory_ids: JSON.stringify(chairIds), updated_by: req.user.id, updated_at: new Date().toISOString() };
    const prev = await db.get('SELECT * FROM business_staff_roles WHERE user_id = ? AND practice_id = ?', user.id, pid);
    let id = prev?.id;
    if (prev) await update(db, 'business_staff_roles', prev.id, pid, row);
    else {
      try {
        id = await insertId(db, 'INSERT INTO business_staff_roles (practice_id, user_id, kind, provider_ids, operatory_ids, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', pid, user.id, row.kind, row.provider_ids, row.operatory_ids, row.updated_by, row.updated_at);
      } catch (err) {
        if (!/unique|duplicate/i.test(String(err?.message))) throw err;
        id = (await db.get('SELECT id FROM business_staff_roles WHERE user_id = ?', user.id)).id;
        await update(db, 'business_staff_roles', id, pid, row);
      }
    }
    await audit(db, req, 'business.staff_role', 'business_staff_roles', id, { user_id: user.id }, { before: prev ? { kind: prev.kind, provider_ids: prev.provider_ids, operatory_ids: prev.operatory_ids } : undefined, after: { kind: row.kind, provider_ids: row.provider_ids, operatory_ids: row.operatory_ids } });
    publish(pid, { type: 'business' });
    res.json({ id, user_id: user.id, kind: row.kind, provider_ids: providerIds, operatory_ids: chairIds });
  });

  // ---------------- PM2/PM3: the schedule by margin ----------------
  r.get('/business/schedule', async (req, res) => {
    need(view(req), 'business:view');
    const date = reqDate(req.query.date, 'date');
    const days = req.query.days ? intIn(req.query.days, 'days', 1, 7) : 1;
    res.json(await scheduleBusiness(db, req.user, { from: date, days, locationId: await officeOf(req), rates: rates(req), today: await todayOf(req) }));
  });

  // ---------------- BD1: today ----------------
  r.get('/business/today', async (req, res) => {
    need(view(req), 'business:view');
    const today = await todayOf(req);
    const date = req.query.date ? reqDate(req.query.date, 'date') : today;
    res.json(await todayBusiness(db, req.user, { date, locationId: await officeOf(req), nowMs: nowMs(req), rates: rates(req), today }));
  });

  // ---------------- BD2/BD3: staff lanes, staffing vs demand, overtime ----------------
  r.get('/business/staff', async (req, res) => {
    need(lanes(req), 'business:view or timeclock:manage');
    const today = await todayOf(req);
    const date = req.query.date ? reqDate(req.query.date, 'date') : today;
    const out = await staffDay(db, req.user, { date, locationId: await officeOf(req), nowMs: nowMs(req), rates: rates(req) });
    // Without business:view the lanes still show who was busy; the dollar value of the work supported stays hidden.
    if (!view(req)) for (const p of out.people) for (const t of [p.so_far, p.day]) { delete t.production_supported; delete t.production_per_labor_hour; }
    res.json({ ...out, states: STATE_LABELS });
  });

  // ---------------- BD4: trends and their drill-down ----------------
  const range = (req, max) => {
    const to = req.query.to ? reqDate(req.query.to, 'to') : null;
    const from = req.query.from ? reqDate(req.query.from, 'from') : null;
    if (!from || !to) throw new HttpError(400, 'from and to are required');
    if (from > to) throw new HttpError(400, 'from must be on or before to');
    if ((Date.parse(to) - Date.parse(from)) / 86400_000 > max) throw new HttpError(400, `Pick at most ${max + 1} days`);
    return [from, to];
  };
  r.get('/business/trends', async (req, res) => {
    need(view(req), 'business:view');
    const [from, to] = range(req, 400);
    const group = req.query.group || 'day';
    if (!['day', 'week', 'month'].includes(group)) throw new HttpError(400, 'group must be day, week or month');
    res.json(await businessTrends(db, req.user, { from, to, group, locationId: await officeOf(req), rates: rates(req), nowMs: nowMs(req), today: await todayOf(req) }));
  });
  r.get('/business/trends/rows', async (req, res) => {
    need(view(req), 'business:view');
    const [from, to] = range(req, 92);
    const metric = req.query.metric || 'labor';
    if (!['labor', 'overtime', 'production'].includes(metric)) throw new HttpError(400, 'metric must be labor, overtime or production');
    const rows = await trendRows(db, req.user, { metric, from, to, locationId: await officeOf(req), rates: rates(req), nowMs: nowMs(req) });
    await audit(db, req, 'business.drill_down', 'business', null, { metric, from, to, rows: rows.length });
    res.json(rows);
  });

  // ---------------- PM4: reports and what-if ----------------
  r.get('/business/reports/margins', async (req, res) => {
    need(view(req), 'business:view');
    const [from, to] = range(req, 400);
    const by = req.query.by || 'procedure';
    if (!['procedure', 'provider', 'payer', 'type', 'category'].includes(by)) throw new HttpError(400, 'by must be procedure, provider, payer, type or category');
    res.json(await marginReport(db, req.user, { from, to, by, locationId: await officeOf(req), rates: rates(req), today: await todayOf(req) }));
  });
  r.get('/business/reports/what-if', async (req, res) => {
    need(view(req), 'business:view');
    const [from, to] = range(req, 400);
    const q = req.query;
    const kind = q.kind;
    const code = q.code ? clean(q.code, 20) : null;
    const opts = { from, to, kind, code, locationId: await officeOf(req), today: await todayOf(req) };
    if (kind === 'fee') opts.pctBp = intIn(q.pct_bp, 'pct_bp', -9000, 20000);
    else if (kind === 'lab') {
      if (!code) throw new HttpError(400, 'Say which procedure code’s lab fee changes');
      opts.labCents = cents(q.lab_cents, 'lab_cents');
    } else if (kind === 'drop_plan') {
      opts.carrierId = (await findOr404(db, 'insurance_carriers', intIn(q.carrier_id, 'carrier_id', 1, 2 ** 31 - 1), req.user.practice_id, 'Insurance carrier')).id;
      opts.retention = q.retention != null ? intIn(q.retention, 'retention', 0, 100) : 70;
      opts.refill = q.refill != null ? intIn(q.refill, 'refill', 0, 100) : 50;
    } else throw new HttpError(400, 'kind must be fee, lab or drop_plan');
    res.json(await whatIf(db, req.user, opts));
  });

  // ---------------- EX1–EX3: exams today and the production they support ----------------
  r.get('/business/exams', async (req, res) => {
    need(can(req.user, 'schedule:read'), 'schedule:read');
    const today = await todayOf(req);
    const date = req.query.date ? reqDate(req.query.date, 'date') : today;
    const horizon = req.query.horizon ? intIn(req.query.horizon, 'horizon', 1, 5) : 5;
    if (![1, 3, 5].includes(horizon)) throw new HttpError(400, 'horizon must be 1, 3 or 5 (months)');
    res.json({ ...(await examsBusiness(db, req.user, { date, locationId: await officeOf(req), money: view(req), horizon })), types: EXAM_TYPE_LABELS, can_manage: manage(req) });
  });
  r.put('/business/exam-targets', async (req, res) => {
    need(manage(req), 'business:manage');
    const items = req.body?.items;
    if (!Array.isArray(items) || !items.length || items.length > 20) throw new HttpError(400, 'items must be a list of exam types');
    const pid = req.user.practice_id;
    const rows = items.map((it) => {
      const t = clean(it.exam_type, 40);
      if (!t || !/^[a-z_]+$/.test(t)) throw new HttpError(400, 'exam_type must be a type like new_patient');
      return { exam_type: t, daily_target: intIn(it.daily_target, 'daily_target', 0, 200, { nullable: true }), value_cents: cents(it.value_cents, 'value_cents', { nullable: true }) };
    });
    await db.tx(async () => {
      for (const row of rows) {
        const prev = await db.get('SELECT * FROM business_exam_targets WHERE practice_id = ? AND exam_type = ?', pid, row.exam_type);
        const stamp = { updated_by: req.user.id, updated_at: new Date().toISOString() };
        let id = prev?.id;
        if (prev) await update(db, 'business_exam_targets', prev.id, pid, { daily_target: row.daily_target, value_cents: row.value_cents, ...stamp });
        else id = await insertId(db, 'INSERT INTO business_exam_targets (practice_id, exam_type, daily_target, value_cents, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)', pid, row.exam_type, row.daily_target, row.value_cents, stamp.updated_by, stamp.updated_at);
        await audit(db, req, 'business.exam_target', 'business_exam_targets', id, { exam_type: row.exam_type }, { before: prev ? { daily_target: prev.daily_target, value_cents: prev.value_cents } : undefined, after: { daily_target: row.daily_target, value_cents: row.value_cents } });
      }
    });
    publish(pid, { type: 'business' });
    res.json({ saved: rows.length });
  });

  return r;
}

// For the command bar and the digest: is this person the owner audience of the business view?
export const canSeeBusiness = (user) => can(user, 'business:view');
export { practiceNow };
