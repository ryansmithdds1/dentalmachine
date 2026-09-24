import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, update, change, recorded, findOr404, audit, practiceNow, isRealDate, mapSeq } from '../util.js';
import { appointmentScope, restricted } from '../officeaccess.js';
import { STARTER_RULES, CONDITIONS, SCOPES, evaluate, practiceContext, validateRule, loadRules, ruleView } from '../opportunities.js';
import { officeFee } from '../fees.js';

// Opportunity finder routes (OF1–OF3; the engine is opportunities.js).
//   GET  /appointments/:id/opportunities                 what this visit's patient is eligible for (and what was added/declined)
//   POST /appointments/:id/opportunities/:ruleId/add     plan it on the visit (idempotent; body.only = target keys)
//   POST /appointments/:id/opportunities/:ruleId/decline "not today" (body.reason)
//   POST /appointments/:id/opportunities/:ruleId/undo    takes back an add or a decline
//   GET  /schedule/opportunities?date&location_id        per visit count + $, and totals by day, provider and chair
//   GET  /opportunities/capture?from&to&location_id      offered → accepted → done, per rule, with $
//   GET/POST/PUT /opportunity-rules…                      the rules (changes: administrators; retired, never deleted)
// Seeing needs clinical:read, adding or declining clinical:write. Visits outside someone's offices answer 404
// (officeAccess); the day view is held to their offices.
const INACTIVE = ['cancelled', 'no_show'];
const requireManager = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only an administrator can change opportunity rules')));
const targetKey = (t) => (t.procedure_id ? `p${t.procedure_id}` : t.tooth ? `t${t.tooth}` : t.area ? `q${t.area}` : t.code);
const ids = (v) => {
  try { return JSON.parse(v || '[]'); } catch { return []; }
};

export default function opportunityRoutes({ db }) {
  const r = Router();

  const visitOf = async (req) => {
    const appt = await findOr404(db, 'appointments', req.params.id, req.user.practice_id, 'Appointment');
    return { appt, date: String(appt.start_time).slice(0, 10) };
  };
  const ruleOf = async (req) => {
    if (!/^\d+$/.test(String(req.params.ruleId))) throw new HttpError(400, 'ruleId must be a number');
    return findOr404(db, 'opportunity_rules', req.params.ruleId, req.user.practice_id, 'Opportunity rule');
  };
  const eventFor = (appt, ruleId) => db.get('SELECT * FROM opportunity_events WHERE appointment_id = ? AND rule_id = ?', appt.id, ruleId);
  // One row per visit and rule, made the first time it's shown or acted on (a tracking row: not audited).
  const ensureEvent = async (req, appt, opp) => {
    await db.run(
      `INSERT INTO opportunity_events (practice_id, location_id, patient_id, appointment_id, rule_id, status, codes, fee, patient_cost, created_by)
       VALUES (?, ?, ?, ?, ?, 'offered', ?, ?, ?, ?) ON CONFLICT (appointment_id, rule_id) DO NOTHING`,
      req.user.practice_id, appt.location_id ?? null, appt.patient_id, appt.id, opp.rule_id, JSON.stringify(opp.codes), opp.added_fee ?? opp.fee, opp.coverage?.patient ?? null, req.user.id,
    );
    return eventFor(appt, opp.rule_id);
  };

  async function visitOpportunities(req, appt, date) {
    const pc = await practiceContext(db, req.user.practice_id);
    return evaluate(db, pc, { patientId: appt.patient_id, appointment: appt, date, estimate: true });
  }

  r.get('/appointments/:id/opportunities', requirePermission('clinical:read'), async (req, res) => {
    const { appt, date } = await visitOf(req);
    const result = await visitOpportunities(req, appt, date);
    const events = new Map((await db.all(
      'SELECT e.*, r.name AS rule_name FROM opportunity_events e JOIN opportunity_rules r ON r.id = e.rule_id WHERE e.appointment_id = ? AND e.practice_id = ?', appt.id, req.user.practice_id,
    )).map((e) => [e.rule_id, e]));
    const live = !INACTIVE.includes(appt.status);
    const open = [];
    const declined = [];
    for (const o of result.opportunities) {
      let e = events.get(o.rule_id);
      // Shown on the visit counts as offered (unless the screen only peeks: ?track=0).
      if (!e && live && req.query.track !== '0') e = await ensureEvent(req, appt, o);
      o.status = e?.status || 'offered';
      if (o.status === 'declined') declined.push({ ...o, decline_reason: e.reason });
      else open.push(o);
    }
    const procs = new Map((await db.all('SELECT id, code, tooth, area, fee, status FROM procedures WHERE patient_id = ? AND practice_id = ?', appt.patient_id, req.user.practice_id)).map((p) => [p.id, p]));
    const added = [...events.values()].filter((e) => e.status === 'accepted').map((e) => ({
      rule_id: e.rule_id, name: e.rule_name, fee: e.fee, patient_cost: e.patient_cost,
      procedures: [...ids(e.procedure_ids), ...ids(e.attached_ids)].map((id) => procs.get(id)).filter(Boolean),
    }));
    res.json({
      appointment_id: appt.id, patient: result.patient, date, editable: live,
      opportunities: open, declined, added,
      total: { count: open.length, fee: open.reduce((s, o) => s + o.added_fee, 0), patient: open.reduce((s, o) => s + (o.coverage?.patient || 0), 0) },
    });
  });

  // Adds the opportunity to the visit as planned work: new procedures at the office's fee, or (unscheduled
  // treatment) the planned procedures moved onto this visit, and any code it replaces set aside. The first add
  // wins; a repeat (double click, retry) answers with what the first one added.
  r.post('/appointments/:id/opportunities/:ruleId/add', requirePermission('clinical:write'), async (req, res) => {
    const { appt, date } = await visitOf(req);
    const rule = await ruleOf(req);
    if (INACTIVE.includes(appt.status)) throw new HttpError(409, 'This visit was cancelled or missed — add it to another visit');
    const done = async () => {
      const e = await eventFor(appt, rule.id);
      const list = [...ids(e.procedure_ids), ...ids(e.attached_ids)];
      return { already: true, event: e, procedures: list.length ? await db.all(`SELECT * FROM procedures WHERE id IN (${list.map(() => '?').join(',')}) AND practice_id = ?`, ...list, req.user.practice_id) : [] };
    };
    const existing = await eventFor(appt, rule.id);
    if (existing?.status === 'accepted') return res.json(await done());
    const result = await visitOpportunities(req, appt, date);
    const opp = result.opportunities.find((o) => o.rule_id === rule.id);
    if (!opp) throw new HttpError(409, 'This isn’t an opportunity for this visit any more (already planned, done, or not due)');
    const only = Array.isArray(req.body?.only) ? new Set(req.body.only.map(String)) : null;
    const targets = only ? opp.targets.filter((t) => only.has(targetKey(t))) : opp.targets;
    if (!targets.length) throw new HttpError(400, 'Choose at least one of the teeth or items listed');
    const pid = req.user.practice_id;
    const out = await db.tx(async () => {
      const event = await ensureEvent(req, appt, opp);
      // Claim it: only one request moves offered/declined → accepted.
      const claimed = await db.run("UPDATE opportunity_events SET status = 'accepted', updated_by = ?, updated_at = datetime('now') WHERE id = ? AND status != 'accepted'", req.user.id, event.id);
      if (!claimed.changes) return null;
      const created = [];
      const attached = [];
      for (const t of targets) {
        if (t.procedure_id) {
          const n = await recorded(db, 'procedures', t.procedure_id, () => db.run(
            "UPDATE procedures SET appointment_id = ?, provider_id = COALESCE(provider_id, ?) WHERE id = ? AND practice_id = ? AND patient_id = ? AND status = 'planned'",
            appt.id, appt.provider_id, t.procedure_id, pid, appt.patient_id,
          ));
          if (n.changes) attached.push(t.procedure_id);
          continue;
        }
        const code = await db.get('SELECT * FROM procedure_codes WHERE practice_id = ? AND code = ? AND active = 1', pid, t.code);
        if (!code) throw new HttpError(400, `${t.code} isn't in your procedure codes`);
        created.push(await insert(db, 'procedures', {
          practice_id: pid, patient_id: appt.patient_id, appointment_id: appt.id, provider_id: appt.provider_id, location_id: appt.location_id ?? null,
          code_id: code.id, code: code.code, description: code.description, category: code.category, tooth: t.tooth ?? null, area: t.area ?? null,
          fee: await officeFee(db, pid, code, { patientId: appt.patient_id, providerId: appt.provider_id, locationId: appt.location_id }),
        }));
      }
      const replaced = [];
      for (const p of opp.replaces) {
        const n = await recorded(db, 'procedures', p.procedure_id, () => db.run("UPDATE procedures SET status = 'cancelled' WHERE id = ? AND practice_id = ? AND status = 'planned'", p.procedure_id, pid));
        if (n.changes) replaced.push(p.procedure_id);
      }
      const fee = targets.reduce((s, t) => s + t.fee, 0) - opp.replaces.filter((p) => replaced.includes(p.procedure_id)).reduce((s, p) => s + p.fee, 0);
      await change(db, 'opportunity_events', event.id, {
        codes: JSON.stringify([...new Set(targets.map((t) => t.code))]), fee, patient_cost: opp.coverage?.patient ?? null,
        procedure_ids: JSON.stringify(created), attached_ids: JSON.stringify(attached), replaced_ids: JSON.stringify(replaced), reason: null,
      });
      return { event: event.id, created, attached, replaced, fee };
    });
    if (!out) return res.json(await done());
    await audit(db, req, 'opportunity.add', 'appointments', appt.id, {
      rule_id: rule.id, rule: rule.name, codes: targets.map((t) => `${t.code}${t.tooth ? ` #${t.tooth}` : t.area ? ` ${t.area}` : ''}`), fee: out.fee, reason: opp.reason, replaced: out.replaced,
    }, { patientId: appt.patient_id });
    const list = [...out.created, ...out.attached];
    res.status(201).json({
      already: false, event: await db.get('SELECT * FROM opportunity_events WHERE id = ?', out.event),
      procedures: list.length ? await db.all(`SELECT * FROM procedures WHERE id IN (${list.map(() => '?').join(',')})`, ...list) : [],
    });
  });

  r.post('/appointments/:id/opportunities/:ruleId/decline', requirePermission('clinical:write'), async (req, res) => {
    const { appt, date } = await visitOf(req);
    const rule = await ruleOf(req);
    let event = await eventFor(appt, rule.id);
    if (!event) {
      const opp = (await visitOpportunities(req, appt, date)).opportunities.find((o) => o.rule_id === rule.id);
      if (!opp) throw new HttpError(409, 'This isn’t an opportunity for this visit any more');
      event = await ensureEvent(req, appt, opp);
    }
    if (event.status === 'accepted') throw new HttpError(409, 'It was added to the visit — undo that first');
    const reason = String(req.body?.reason || '').trim().slice(0, 300) || null;
    if (event.status !== 'declined' || event.reason !== reason) {
      await change(db, 'opportunity_events', event.id, { status: 'declined', reason, updated_by: req.user.id });
      await audit(db, req, 'opportunity.decline', 'appointments', appt.id, { rule_id: rule.id, rule: rule.name, reason }, { patientId: appt.patient_id, reason });
    }
    res.json(await eventFor(appt, rule.id));
  });

  // Undo: an add takes its planned procedures back off (cancelled, or moved back off the visit) and puts back
  // what it replaced; a decline goes back to offered. Work already completed can't be undone here.
  r.post('/appointments/:id/opportunities/:ruleId/undo', requirePermission('clinical:write'), async (req, res) => {
    const { appt } = await visitOf(req);
    const rule = await ruleOf(req);
    const event = await eventFor(appt, rule.id);
    if (!event || event.status === 'offered') return res.json({ ok: true, already: true });
    const pid = req.user.practice_id;
    if (event.status === 'accepted') {
      const all = [...ids(event.procedure_ids), ...ids(event.attached_ids)];
      if (all.length && (await db.get(`SELECT id FROM procedures WHERE id IN (${all.map(() => '?').join(',')}) AND status = 'completed'`, ...all))) {
        throw new HttpError(409, 'Some of it has been completed — un-complete it from the chart instead');
      }
      await db.tx(async () => {
        for (const id of ids(event.procedure_ids)) await recorded(db, 'procedures', id, () => db.run("UPDATE procedures SET status = 'cancelled' WHERE id = ? AND practice_id = ? AND status = 'planned'", id, pid));
        for (const id of ids(event.attached_ids)) await recorded(db, 'procedures', id, () => db.run("UPDATE procedures SET appointment_id = NULL WHERE id = ? AND practice_id = ? AND appointment_id = ? AND status = 'planned'", id, pid, appt.id));
        for (const id of ids(event.replaced_ids)) await recorded(db, 'procedures', id, () => db.run("UPDATE procedures SET status = 'planned' WHERE id = ? AND practice_id = ? AND status = 'cancelled'", id, pid));
        await change(db, 'opportunity_events', event.id, { status: 'offered', procedure_ids: null, attached_ids: null, replaced_ids: null, updated_by: req.user.id });
      });
    } else {
      await change(db, 'opportunity_events', event.id, { status: 'offered', reason: null, updated_by: req.user.id });
    }
    await audit(db, req, 'opportunity.undo', 'appointments', appt.id, { rule_id: rule.id, rule: rule.name, was: event.status }, { patientId: appt.patient_id });
    res.json({ ok: true, event: await eventFor(appt, rule.id) });
  });

  // The day: each visit's count and $ (fees of what would be added), and totals by day, provider and chair.
  r.get('/schedule/opportunities', requirePermission('clinical:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const date = req.query.date ? String(req.query.date) : (await practiceNow(db, pid)).slice(0, 10);
    if (!isRealDate(date)) throw new HttpError(400, 'date must be a real date (YYYY-MM-DD)');
    const location = req.query.location_id ? await findOr404(db, 'locations', req.query.location_id, pid, 'Office') : null;
    if (location && restricted(req.user) && !req.user.location_ids.includes(location.id)) throw new HttpError(403, "That office isn't one of yours");
    const scope = appointmentScope(req.user, 'a');
    const appts = await db.all(
      `SELECT a.id, a.patient_id, a.provider_id, a.operatory_id, a.location_id, a.start_time, a.status, p.first_name, p.last_name, pv.name AS provider_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN providers pv ON pv.id = a.provider_id
       WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ('cancelled','no_show')${location ? ' AND a.location_id = ?' : ''}${scope.sql}
       ORDER BY a.start_time, a.id`, pid, `${date} 00:00`, `${date} 24:00`, ...(location ? [location.id] : []), ...scope.args,
    );
    const pc = await practiceContext(db, pid);
    const declined = new Set((await db.all(
      `SELECT e.appointment_id, e.rule_id FROM opportunity_events e JOIN appointments a ON a.id = e.appointment_id
       WHERE e.practice_id = ? AND e.status = 'declined' AND a.start_time >= ? AND a.start_time < ?`, pid, `${date} 00:00`, `${date} 24:00`,
    )).map((e) => `${e.appointment_id}:${e.rule_id}`));
    const visits = await mapSeq(appts, async (a) => {
      const { opportunities } = await evaluate(db, pc, { patientId: a.patient_id, appointment: a, date, estimate: false });
      const items = opportunities.filter((o) => !declined.has(`${a.id}:${o.rule_id}`)).map((o) => ({ rule_id: o.rule_id, name: o.name, codes: o.codes, fee: o.added_fee, reason: o.reason }));
      return {
        appointment_id: a.id, patient_id: a.patient_id, patient: `${a.first_name} ${a.last_name}`, provider_id: a.provider_id, provider: a.provider_name, operatory_id: a.operatory_id,
        start_time: a.start_time, count: items.length, fee: items.reduce((s, i) => s + i.fee, 0), items,
      };
    });
    const group = (key) => {
      const m = {};
      for (const v of visits) {
        const k = v[key] ?? 'none';
        m[k] ||= { count: 0, fee: 0, visits: 0 };
        m[k].count += v.count;
        m[k].fee += v.fee;
        if (v.count) m[k].visits++;
      }
      return m;
    };
    const byRule = {};
    for (const v of visits) for (const i of v.items) {
      byRule[i.rule_id] ||= { rule_id: i.rule_id, name: i.name, count: 0, fee: 0 };
      byRule[i.rule_id].count++;
      byRule[i.rule_id].fee += i.fee;
    }
    res.json({
      date, location_id: location?.id ?? null, visits,
      totals: { count: visits.reduce((s, v) => s + v.count, 0), fee: visits.reduce((s, v) => s + v.fee, 0), visits: visits.filter((v) => v.count).length },
      by_provider: group('provider_id'), by_operatory: group('operatory_id'), by_rule: Object.values(byRule).sort((a, b) => b.fee - a.fee),
    });
  });

  // Capture: of what was offered on visits in the dates, how much was added and how much has been done.
  r.get('/opportunities/capture', requirePermission('clinical:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const from = req.query.from ? String(req.query.from) : `${today.slice(0, 7)}-01`;
    const to = req.query.to ? String(req.query.to) : today;
    if (!isRealDate(from) || !isRealDate(to) || from > to) throw new HttpError(400, 'from and to must be real dates (YYYY-MM-DD), from first');
    const location = req.query.location_id ? await findOr404(db, 'locations', req.query.location_id, pid, 'Office') : null;
    if (location && restricted(req.user) && !req.user.location_ids.includes(location.id)) throw new HttpError(403, "That office isn't one of yours");
    const scope = appointmentScope(req.user, 'a');
    const rows = await db.all(
      `SELECT e.*, r.name AS rule_name FROM opportunity_events e JOIN appointments a ON a.id = e.appointment_id JOIN opportunity_rules r ON r.id = e.rule_id
       WHERE e.practice_id = ? AND a.start_time >= ? AND a.start_time < ?${location ? ' AND a.location_id = ?' : ''}${scope.sql}`,
      pid, `${from} 00:00`, `${to} 24:00`, ...(location ? [location.id] : []), ...scope.args,
    );
    const procIds = [...new Set(rows.flatMap((e) => [...ids(e.procedure_ids), ...ids(e.attached_ids)]))];
    const procs = new Map();
    for (let i = 0; i < procIds.length; i += 500) {
      const chunk = procIds.slice(i, i + 500);
      for (const p of await db.all(`SELECT id, status, fee FROM procedures WHERE practice_id = ? AND id IN (${chunk.map(() => '?').join(',')})`, pid, ...chunk)) procs.set(p.id, p);
    }
    const by = new Map();
    const blank = (e) => ({ rule_id: e.rule_id, name: e.rule_name, offered: 0, accepted: 0, declined: 0, done: 0, offered_fee: 0, accepted_fee: 0, done_fee: 0 });
    const total = blank({ rule_id: null, rule_name: 'All opportunities' });
    for (const e of rows) {
      const r2 = by.get(e.rule_id) || blank(e);
      by.set(e.rule_id, r2);
      const list = [...ids(e.procedure_ids), ...ids(e.attached_ids)].map((id) => procs.get(id)).filter(Boolean);
      const completed = list.filter((p) => p.status === 'completed');
      for (const t of [r2, total]) {
        t.offered++;
        t.offered_fee += Number(e.fee || 0);
        if (e.status === 'declined') t.declined++;
        if (e.status === 'accepted') {
          t.accepted++;
          t.accepted_fee += Number(e.fee || 0);
          if (list.length && completed.length === list.length) t.done++;
          t.done_fee += completed.reduce((s, p) => s + Number(p.fee || 0), 0);
        }
      }
    }
    const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
    const out = [...by.values()].sort((a, b) => b.offered_fee - a.offered_fee).map((x) => ({ ...x, acceptance: rate(x.accepted, x.offered) }));
    res.json({ from, to, location_id: location?.id ?? null, rules: out, totals: { ...total, acceptance: rate(total.accepted, total.offered) }, note: 'Offered: shown on a visit. Done: every procedure it added has been completed. $ are office fees (production), not money collected.' });
  });

  // ---- Rules ----
  r.get('/opportunity-rules', requirePermission('clinical:read'), async (req, res) => {
    const rules = await loadRules(db, req.user.practice_id, { all: true });
    const have = new Set(rules.map((x) => x.starter_key).filter(Boolean));
    res.json({ rules, conditions: CONDITIONS, scopes: SCOPES, starters_missing: STARTER_RULES.filter((s) => !have.has(s.starter_key)).map((s) => s.name) });
  });

  // The starter set: adds the ones this practice doesn't have yet (safe to press twice).
  r.post('/opportunity-rules/starter', requirePermission('clinical:read'), requireManager, async (req, res) => {
    const pid = req.user.practice_id;
    const known = new Set((await db.all('SELECT code FROM procedure_codes WHERE practice_id = ?', pid)).map((c) => c.code));
    const added = [];
    await db.tx(async () => {
      for (const [i, s] of STARTER_RULES.entries()) {
        if (await db.get('SELECT id FROM opportunity_rules WHERE practice_id = ? AND starter_key = ?', pid, s.starter_key)) continue;
        // Codes the office doesn't have (e.g. D4381 Arestin) are kept: the rule stays quiet until the code is added.
        const row = {
          practice_id: pid, starter_key: s.starter_key, name: s.name, codes: JSON.stringify(s.codes), replaces: JSON.stringify(s.replaces || []), scope: s.scope,
          age_min: s.age_min, age_max: s.age_max, frequency_months: s.frequency_months, conditions: JSON.stringify(s.conditions), note: s.note || null, sort: (i + 1) * 10, created_by: req.user.id,
        };
        const id = await insert(db, 'opportunity_rules', row);
        added.push({ id, name: s.name, missing_codes: s.codes.filter((c) => !known.has(c)) });
      }
    });
    if (added.length) await audit(db, req, 'opportunity_rule.starter', 'opportunity_rules', null, { added: added.map((a) => a.name) });
    res.status(added.length ? 201 : 200).json({ added, rules: await loadRules(db, pid, { all: true }) });
  });

  r.post('/opportunity-rules', requirePermission('clinical:read'), requireManager, async (req, res) => {
    const row = await validateRule(db, req.user.practice_id, req.body || {});
    const id = await insert(db, 'opportunity_rules', { ...row, practice_id: req.user.practice_id, created_by: req.user.id });
    const saved = await db.get('SELECT * FROM opportunity_rules WHERE id = ?', id);
    await audit(db, req, 'opportunity_rule.create', 'opportunity_rules', id, null, { after: ruleView(saved) });
    res.status(201).json(ruleView(saved));
  });

  r.put('/opportunity-rules/:rid', requirePermission('clinical:read'), requireManager, async (req, res) => {
    const existing = await findOr404(db, 'opportunity_rules', req.params.rid, req.user.practice_id, 'Opportunity rule');
    const row = await validateRule(db, req.user.practice_id, req.body || {}, existing);
    await update(db, 'opportunity_rules', existing.id, req.user.practice_id, { ...row, updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
    const saved = await db.get('SELECT * FROM opportunity_rules WHERE id = ?', existing.id);
    await audit(db, req, 'opportunity_rule.update', 'opportunity_rules', existing.id, null, { before: ruleView(existing), after: ruleView(saved) });
    res.json(ruleView(saved));
  });

  // Retire (active = 0) or bring back. Rules are never deleted: past visits' offers point at them.
  for (const [path, active] of [['retire', 0], ['restore', 1]]) {
    r.post(`/opportunity-rules/:rid/${path}`, requirePermission('clinical:read'), requireManager, async (req, res) => {
      const existing = await findOr404(db, 'opportunity_rules', req.params.rid, req.user.practice_id, 'Opportunity rule');
      if (existing.active !== active) {
        await update(db, 'opportunity_rules', existing.id, req.user.practice_id, { active });
        await audit(db, req, `opportunity_rule.${path}`, 'opportunity_rules', existing.id, { name: existing.name }, { before: { active: existing.active }, after: { active } });
      }
      res.json(ruleView(await db.get('SELECT * FROM opportunity_rules WHERE id = ?', existing.id)));
    });
  }

  return r;
}
