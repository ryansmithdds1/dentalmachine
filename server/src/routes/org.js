import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { HttpError, rateLimit } from '../auth.js';
import { insert, audit, hashToken, practiceNow, recorded } from '../util.js';
import { toolByName } from '../datatools.js';
import { agingReport } from '../aging.js';
import { financeOverview } from '../finance/metrics.js';
import { recordFeeChange } from '../fees.js';

// Groups of practices (a DSO, or one owner with several offices, each its own practice): the owners see the
// offices side by side and keep their setup in step. A practice joins with a one-time code from an owner,
// entered by that practice's own administrator, so both sides agree. Patient records never cross over:
// the group sees totals only.
const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only administrators can do this')));

// What can be pushed from one practice to the others.
export const PUSHABLE = {
  note_templates: 'Clinical note templates',
  form_templates: 'Forms and consents',
  appointment_types: 'Appointment types',
  messaging: 'Reminder schedule, sending hours and message wording',
  fees: 'Office fees (by procedure code)',
};

async function copyInto(db, kind, from, to, userId) {
  let n = 0;
  if (kind === 'note_templates' || kind === 'form_templates' || kind === 'appointment_types') {
    const cols = {
      note_templates: ['body', 'codes', 'active'],
      form_templates: ['kind', 'description', 'fields', 'procedure_codes', 'auto_send', 'renew_months', 'active'],
      appointment_types: ['duration', 'color', 'procedure_codes', 'provider_type', 'online_bookable', 'active', 'sort', 'name_es', 'pattern', 'is_video', 'deposit'],
    }[kind];
    for (const row of await db.all(`SELECT * FROM ${kind} WHERE practice_id = ? AND active = 1`, from)) {
      const have = await db.get(`SELECT id FROM ${kind} WHERE practice_id = ? AND lower(name) = lower(?)`, to, row.name);
      const values = Object.fromEntries(cols.map((c) => [c, row[c]]));
      if (have) {
        await db.run(`UPDATE ${kind} SET ${cols.map((c) => `${c} = ?`).join(', ')}${kind === 'form_templates' ? ", version = version + 1, updated_at = datetime('now')" : ''} WHERE id = ?`, ...cols.map((c) => values[c]), have.id);
      } else {
        await insert(db, kind, { ...values, name: row.name, practice_id: to });
      }
      n++;
    }
  } else if (kind === 'messaging') {
    const src = await db.get('SELECT message_templates, reminder_steps, recall_steps, recall_auto, send_from, send_until, booking_notices, no_show_texts, auto_fill, fill_batch, review_requests, review_threshold FROM practices WHERE id = ?', from);
    const keys = Object.keys(src);
    await db.run(`UPDATE practices SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => src[k]), to);
    n = 1;
  } else if (kind === 'fees') {
    for (const c of await db.all('SELECT code, description, category, fee, requires_tooth, requires_surface FROM procedure_codes WHERE practice_id = ?', from)) {
      const have = await db.get('SELECT id, fee FROM procedure_codes WHERE practice_id = ? AND code = ?', to, c.code);
      if (have) {
        if (have.fee !== c.fee) {
          await recorded(db, 'procedure_codes', have.id, () => db.run('UPDATE procedure_codes SET fee = ? WHERE id = ?', c.fee, have.id));
          await recordFeeChange(db, { practiceId: to, code: c.code, oldFee: have.fee, newFee: c.fee, userId });
          n++;
        }
      } else {
        await insert(db, 'procedure_codes', { practice_id: to, code: c.code, description: c.description, category: c.category, fee: c.fee, requires_tooth: c.requires_tooth, requires_surface: c.requires_surface });
        await recordFeeChange(db, { practiceId: to, code: c.code, oldFee: null, newFee: c.fee, userId });
        n++;
      }
    }
  }
  return n;
}

export default function orgRoutes({ db }) {
  const r = Router();
  const membership = (req) => db.get(
    'SELECT m.role, o.* FROM org_members m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? ORDER BY m.id LIMIT 1', req.user.id,
  );
  const requireOrg = (owner) => async (req, _res, next) => {
    try {
      const m = await membership(req);
      if (!m) throw new HttpError(403, 'You aren’t part of a practice group');
      if (owner && m.role !== 'owner') throw new HttpError(403, 'Only the group’s owners can do this');
      req.org = m;
      next();
    } catch (err) {
      next(err);
    }
  };
  const practicesOf = (orgId) => db.all('SELECT id, name, city, state, timezone FROM practices WHERE organization_id = ? ORDER BY name', orgId);

  // Where this person and practice stand.
  r.get('/org', async (req, res) => {
    const m = await membership(req);
    const mine = await db.get('SELECT organization_id FROM practices WHERE id = ?', req.user.practice_id);
    const orgId = m?.id ?? mine.organization_id;
    if (!orgId) return res.json({ org: null, pushable: PUSHABLE });
    const org = await db.get('SELECT id, name, created_at FROM organizations WHERE id = ?', orgId);
    res.json({
      org, role: m?.role ?? null, practice_in_group: mine.organization_id === orgId, pushable: PUSHABLE,
      practices: m ? await practicesOf(orgId) : [],
      members: m ? await db.all('SELECT u.id, u.name, u.email, m.role, p.name AS practice FROM org_members m JOIN users u ON u.id = m.user_id JOIN practices p ON p.id = u.practice_id WHERE m.organization_id = ? ORDER BY u.name', orgId) : [],
    });
  });

  r.post('/org', requireAdmin, async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Name the group');
    if ((await db.get('SELECT organization_id FROM practices WHERE id = ?', req.user.practice_id)).organization_id) throw new HttpError(409, 'This practice is already in a group');
    if (await membership(req)) throw new HttpError(409, 'You’re already in a group');
    const id = await db.tx(async () => {
      const orgId = await insert(db, 'organizations', { name, created_by: req.user.id });
      await db.run('UPDATE practices SET organization_id = ? WHERE id = ?', orgId, req.user.practice_id);
      await insert(db, 'org_members', { organization_id: orgId, user_id: req.user.id, role: 'owner' });
      return orgId;
    });
    await audit(db, req, 'org.create', 'organizations', id, { name });
    res.status(201).json({ id, name });
  });

  // A one-time code (valid a week) that another practice's administrator enters to join.
  r.post('/org/join-code', requireOrg(true), async (req, res) => {
    const code = randomBytes(6).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 8);
    const expires = new Date(Date.now() + 7 * 86400_000).toISOString();
    await db.run('UPDATE organizations SET join_code_hash = ?, join_code_expires = ? WHERE id = ?', hashToken(code), expires, req.org.id);
    await audit(db, req, 'org.join_code', 'organizations', req.org.id);
    res.json({ code, expires });
  });
  // Codes are short enough to read aloud, so guesses are limited.
  r.post('/org/join', rateLimit({ windowMs: 15 * 60_000, max: 10, name: 'org-join' }), requireAdmin, async (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    const org = code ? await db.get('SELECT * FROM organizations WHERE join_code_hash = ?', hashToken(code)) : null;
    if (!org || !org.join_code_expires || org.join_code_expires < new Date().toISOString()) throw new HttpError(400, 'That code isn’t valid or has expired — ask the group’s owner for a new one');
    if ((await db.get('SELECT organization_id FROM practices WHERE id = ?', req.user.practice_id)).organization_id) throw new HttpError(409, 'This practice is already in a group');
    await db.run('UPDATE practices SET organization_id = ? WHERE id = ?', org.id, req.user.practice_id);
    await db.run('UPDATE organizations SET join_code_hash = NULL, join_code_expires = NULL WHERE id = ?', org.id);
    await audit(db, req, 'org.join', 'organizations', org.id);
    res.json({ ok: true, org: { id: org.id, name: org.name } });
  });
  // A practice's administrator can always take it out of the group; an owner can remove a practice.
  r.post('/org/leave', requireAdmin, async (req, res) => {
    const p = await db.get('SELECT organization_id FROM practices WHERE id = ?', req.user.practice_id);
    if (!p.organization_id) throw new HttpError(400, 'This practice isn’t in a group');
    await db.run('UPDATE practices SET organization_id = NULL WHERE id = ?', req.user.practice_id);
    await db.run('DELETE FROM org_members WHERE organization_id = ? AND user_id IN (SELECT id FROM users WHERE practice_id = ?)', p.organization_id, req.user.practice_id);
    await audit(db, req, 'org.leave', 'organizations', p.organization_id);
    res.json({ ok: true });
  });
  r.delete('/org/practices/:pid', requireOrg(true), async (req, res) => {
    const pid = Number(req.params.pid);
    if (!(await db.get('SELECT id FROM practices WHERE id = ? AND organization_id = ?', pid, req.org.id))) throw new HttpError(404, 'Not a practice in this group');
    await db.run('UPDATE practices SET organization_id = NULL WHERE id = ?', pid);
    await db.run('DELETE FROM org_members WHERE organization_id = ? AND user_id IN (SELECT id FROM users WHERE practice_id = ?)', req.org.id, pid);
    await audit(db, req, 'org.remove_practice', 'organizations', req.org.id, { practice_id: pid });
    res.json({ ok: true });
  });

  // Owners add people (from the group's practices) as owners or viewers of the group's numbers.
  r.post('/org/members', requireOrg(true), async (req, res) => {
    const role = req.body?.role === 'owner' ? 'owner' : 'viewer';
    const u = await db.get('SELECT u.id, u.practice_id FROM users u JOIN practices p ON p.id = u.practice_id WHERE lower(u.email) = lower(?) AND p.organization_id = ? AND u.active = 1', String(req.body?.email || ''), req.org.id);
    if (!u) throw new HttpError(404, 'No active user with that email at a practice in this group');
    const have = await db.get('SELECT id FROM org_members WHERE user_id = ?', u.id);
    if (have) await db.run('UPDATE org_members SET role = ?, organization_id = ? WHERE id = ?', role, req.org.id, have.id);
    else await insert(db, 'org_members', { organization_id: req.org.id, user_id: u.id, role });
    await audit(db, req, 'org.member', 'organizations', req.org.id, { user_id: u.id, role });
    res.json({ ok: true });
  });
  r.delete('/org/members/:uid', requireOrg(true), async (req, res) => {
    const uid = Number(req.params.uid);
    const owners = await db.all("SELECT user_id FROM org_members WHERE organization_id = ? AND role = 'owner'", req.org.id);
    if (owners.length === 1 && owners[0].user_id === uid) throw new HttpError(400, 'A group needs at least one owner');
    await db.run('DELETE FROM org_members WHERE organization_id = ? AND user_id = ?', req.org.id, uid);
    await audit(db, req, 'org.member_remove', 'organizations', req.org.id, { user_id: uid });
    res.json({ ok: true });
  });

  // Each office's numbers side by side, and the group's totals.
  r.get('/org/rollup', requireOrg(false), async (req, res) => {
    const numbers = toolByName('practice_numbers');
    const rows = [];
    for (const p of await practicesOf(req.org.id)) {
      const today = (await practiceNow(db, p.id)).slice(0, 10);
      const n = await numbers.run(db, p.id, { from: req.query.from, to: req.query.to });
      const ar = (await agingReport(db, p.id, today)).totals;
      const fin = await financeOverview(db, p.id, { months: 3, today }).catch(() => null);
      const s = fin?.summary?.months ? fin.summary : null;
      rows.push({
        practice_id: p.id, name: p.name, city: p.city, ...n,
        acceptance_pct: n.treatment_presented ? Math.round((n.treatment_accepted / n.treatment_presented) * 1000) / 10 : null,
        production_per_visit: n.completed_visits ? Math.round(n.production / n.completed_visits) : null,
        ar_total: ar.total, ar_over_90: ar.d90_plus, ar_over_90_pct: ar.total ? Math.round((ar.d90_plus / ar.total) * 1000) / 10 : null,
        overhead_pct: s?.overhead_pct ?? null, profit_pct: s?.profit_pct ?? null,
      });
    }
    const sum = (k) => rows.reduce((t, x) => t + (Number(x[k]) || 0), 0);
    const totals = {
      production: sum('production'), collections: sum('collections'), completed_visits: sum('completed_visits'), new_patients: sum('new_patients'), no_shows: sum('no_shows'),
      treatment_presented: sum('treatment_presented'), treatment_accepted: sum('treatment_accepted'), ar_total: sum('ar_total'), ar_over_90: sum('ar_over_90'),
    };
    totals.acceptance_pct = totals.treatment_presented ? Math.round((totals.treatment_accepted / totals.treatment_presented) * 1000) / 10 : null;
    totals.no_show_rate_pct = totals.completed_visits + totals.no_shows ? Math.round((totals.no_shows / (totals.completed_visits + totals.no_shows)) * 1000) / 10 : null;
    res.json({ from: rows[0]?.from ?? null, to: rows[0]?.to ?? null, practices: rows, totals });
  });

  // Copy setup from one office to others in the group.
  r.post('/org/push', requireOrg(true), async (req, res) => {
    const kinds = (Array.isArray(req.body?.kinds) ? req.body.kinds : []).filter((k) => Object.hasOwn(PUSHABLE, k));
    if (!kinds.length) throw new HttpError(400, `Choose what to copy: ${Object.keys(PUSHABLE).join(', ')}`);
    const group = (await practicesOf(req.org.id)).map((p) => p.id);
    const from = Number(req.body.from_practice_id || req.user.practice_id);
    if (!group.includes(from)) throw new HttpError(400, 'Copy from a practice in this group');
    const targets = (Array.isArray(req.body.to_practice_ids) && req.body.to_practice_ids.length ? req.body.to_practice_ids.map(Number) : group).filter((id) => id !== from);
    if (targets.some((id) => !group.includes(id))) throw new HttpError(400, 'Every practice copied to must be in this group');
    const results = [];
    for (const to of targets) {
      const counts = {};
      await db.tx(async () => { for (const k of kinds) counts[k] = await copyInto(db, k, from, to, req.user.id); });
      await audit(db, { user: { id: req.user.id, practice_id: to }, ip: req.ip }, 'org.push', 'practices', to, { from, counts });
      results.push({ practice_id: to, counts });
    }
    res.json({ results });
  });
  return r;
}
