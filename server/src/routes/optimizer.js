import { Router } from 'express';
import { createServer } from 'node:http';
import { requirePermission, HttpError, can } from '../auth.js';
import { findOr404, audit, practiceNow, isRealDate, insert, change, friendlyDateTime, localNow } from '../util.js';
import { restricted, canSeePatient } from '../officeaccess.js';
import { publish } from '../events.js';
import { sendMessage, recipientFor, withinSendHours } from '../messaging.js';
import { templatesFor, renderTemplate, patientLang, fixedText } from '../templates.js';
import { raiseIssue, resolveIssue } from '../issues.js';
import { loadDay, generate, verifyPlacements, solve, goalGaps, track, settleOffers, captured, at } from '../optimizer.js';
import { explainPlan, explainMode } from '../ai/optimizerExplain.js';
import { logShown } from '../predict/log.js';

// Today's schedule optimizer (OPT1–OPT4; the engine is optimizer.js, the spec docs/workflows/specs/OPT-optimizer.md).
//   GET  /optimizer/today?date&location_id&explain=1  each provider's goal gap, every opportunity priced, and the plan
//   POST /optimizer/:id/act     { alt: index }          do it (the opportunity's own action, or one of its alternatives)
//   POST /optimizer/:id/undo                            take it back (not texts: a message can't be unsent)
//   POST /optimizer/:id/decline { reason }              "not today" (tracked; hidden from the plan)
//   GET  /optimizer/captured?from&to&location_id        shown → accepted → done, $ captured per day and per person
//   GET/PUT /optimizer/settings  { ai }                 the optional AI note (administrators turn it on)
// :id is the tracking row (optimizer_suggestions) the GET returned for the opportunity. Every action is re-checked
// against the schedule as it is now, then done through the app's own endpoints as the signed-in person (the same
// permissions, validation, audit trail and live updates as doing it by hand), once: a row is claimed before the work
// starts, so a double click or a retry answers with the first result. Seeing needs schedule:read, acting
// schedule:write (plus whatever the underlying endpoint needs, e.g. clinical:write to add a procedure); $ are shown
// only to people with billing:read, as on the schedule.
const parse = (v, d = {}) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);

// The app's own API as the person making this request, over a private loopback listener (one per app).
const loopbacks = new WeakMap();
function internal(app, req) {
  return async (method, path, body) => {
    let port = loopbacks.get(app);
    if (!port) {
      port = new Promise((resolve, reject) => {
        const server = createServer(app);
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        server.unref();
      });
      loopbacks.set(app, port);
    }
    const res = await fetch(`http://127.0.0.1:${await port}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json', Authorization: req.headers.authorization || '', 'X-Forwarded-For': req.ip || '',
        // The office, and — when the assistant is acting — that it is, and whether the person approved it on screen.
        ...Object.fromEntries(['x-location-id', 'x-acting-for', 'x-human-approved'].filter((h) => req.headers[h]).map((h) => [h, req.headers[h]])),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status, data.error || `HTTP ${res.status}`, data.details);
    return data;
  };
}

// A text offer for one open time. ASAP and waitlist patients get the same text as a cancellation fill (fill.js):
// their YES books it (an ASAP patient's visit moves up). Anyone else (recall due, a family member) gets a plain
// offer to reply or call — the front desk books them from the panel.
export async function offerGap(db, messenger, { practiceId, userId, source, refId, patientId, providerId, operatoryId, start, end, reason = null }) {
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  if (!withinSendHours(practice, localNow(practice.timezone || 'America/New_York'))) throw new HttpError(409, 'Texts go out only in sending hours — call them instead');
  const patient = await db.get('SELECT * FROM patients WHERE id = ? AND practice_id = ?', patientId, practiceId);
  if (!patient) throw new HttpError(404, 'Patient not found');
  const to = await recipientFor(db, patient);
  if (!to.phone || !to.sms_opt_in || to.sms_bad_at) throw new HttpError(409, `${patient.first_name} can’t be texted (no mobile number, or they opted out) — call them instead`);
  const provider = await db.get('SELECT name FROM providers WHERE id = ? AND practice_id = ?', providerId, practiceId);
  const lang = patientLang(to);
  const when = friendlyDateTime(start, lang);
  if (source === 'asap' || source === 'waitlist') {
    const offerId = await insert(db, 'fill_offers', {
      practice_id: practiceId, provider_id: providerId, operatory_id: operatoryId ?? null, start_time: start, end_time: end, status: 'open', offered: 1, sent_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
    const body = `${renderTemplate(templatesFor(practice, lang).fill_offer, { first_name: to.first_name, practice: practice.name, when, provider: provider?.name || '', phone: practice.phone || fixedText(lang).the_office })}${fixedText(lang).sms_stop}`;
    const msg = await sendMessage(db, messenger, { practiceId, patientId: patient.id, kind: 'fill_offer', channel: 'sms', to: to.phone, body, userId });
    if (msg.status !== 'sent') {
      await db.run("UPDATE fill_offers SET status = 'no_takers' WHERE id = ?", offerId);
      throw new HttpError(502, `The text didn’t go${msg.error ? `: ${msg.error}` : ''}`);
    }
    await insert(db, 'fill_offer_recipients', { offer_id: offerId, patient_id: patient.id, source, ref_id: refId ?? null, phone: digits(to.phone), message_id: msg.id });
    if (source === 'waitlist' && refId) await db.run("UPDATE waitlist SET last_offered_at = datetime('now') WHERE id = ? AND practice_id = ?", refId, practiceId);
    return { fill_offer_id: offerId, message_id: msg.id };
  }
  const body = lang === 'es'
    ? `Hola ${to.first_name}, ${practice.name} tiene un espacio ${when} con ${provider?.name || ''}${to.id !== patient.id ? ` para ${patient.first_name}` : ''}. Responda o llame al ${practice.phone || 'consultorio'} para tomarlo.${fixedText(lang).sms_stop}`
    : `Hi ${to.first_name}, ${practice.name} has an opening ${when} with ${provider?.name || 'us'}${to.id !== patient.id ? ` for ${patient.first_name}` : ''}${reason ? ` (${reason.replace(/\s*\(due [^)]*\)/, '').toLowerCase()})` : ''}. Reply or call ${practice.phone || 'the office'} to take it.${fixedText(lang).sms_stop}`;
  const msg = await sendMessage(db, messenger, { practiceId, patientId: patient.id, kind: source === 'recall' ? 'recall' : 'custom', channel: 'sms', to: to.phone, body, userId });
  if (msg.status !== 'sent') throw new HttpError(502, `The text didn’t go${msg.error ? `: ${msg.error}` : ''}`);
  if (source === 'recall' && refId) await db.run("UPDATE recalls SET status = 'contacted', last_contacted_at = datetime('now') WHERE id = ? AND practice_id = ? AND status = 'due'", refId, practiceId);
  return { message_id: msg.id };
}

export default function optimizerRoutes({ db, config = {}, messenger, app }) {
  const r = Router();

  const officeOf = async (req) => {
    const id = req.query.location_id ? Number(req.query.location_id) : req.location_id ?? null;
    if (id == null) return null;
    await findOr404(db, 'locations', id, req.user.practice_id, 'Office');
    if (restricted(req.user) && !req.user.location_ids.includes(id)) throw new HttpError(403, "That office isn't one of yours");
    return id;
  };
  const clockOf = (date, m) => (m == null ? null : at(date, m));
  // Times as the rest of the app shows them; the patient's id at the top so office limits filter rows.
  const present = (date, o, row) => ({
    id: row?.id ?? null, status: row?.status ?? 'shown', key: o.key, kind: o.kind, source: o.source ?? null, title: o.title, detail: o.detail, fits: o.fits, why_not: o.why_not,
    patient_id: o.patient?.id ?? null, patient: o.patient?.name ?? null, provider_id: o.provider_id, provider: o.provider_name, appointment_id: o.appointment_id ?? null,
    start_time: clockOf(date, o.slot?.start ?? o.visit?.start), end_time: clockOf(date, o.slot?.end ?? o.visit?.end), operatory_id: o.slot?.operatory_id ?? null,
    visit: o.visit ? { id: o.visit.id, start_time: clockOf(date, o.visit.start), end_time: clockOf(date, o.visit.end) } : null,
    fee: o.fee, collectible: o.collectible, per_minute: o.per_minute, minutes: o.minutes, at_risk: o.at_risk ?? null, risk: o.risk ?? null,
    in_plan: !!o.in_plan, needs_reply: !!o.needs_reply, then: o.then ? { title: o.then.title, fee: o.then.fee } : null,
    action: o.action?.type ?? null, alt_actions: (o.alt_actions || []).map((a) => a.type),
  });

  // The day, computed: generate → check each placement in the database → plan around what's been declined or done.
  async function compute(req, { date, locationId }) {
    const pid = req.user.practice_id;
    await settleOffers(db, pid, date);
    const day = await loadDay(db, req.user, { date, locationId, withFinder: can(req.user, 'clinical:read') });
    const all = await verifyPlacements(db, pid, day, generate(day));
    const prior = new Map((await db.all('SELECT key, status FROM optimizer_suggestions WHERE practice_id = ? AND date = ?', pid, date)).map((x) => [x.key, x.status]));
    const open = all.filter((o) => !['declined', 'accepted', 'done'].includes(prior.get(o.key)));
    const plan = solve(day, open);
    const inPlan = new Set(plan.keys);
    for (const o of all) o.in_plan = inPlan.has(o.key);
    return { day, all, plan };
  }

  r.get('/optimizer/today', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const date = req.query.date ? String(req.query.date) : (await practiceNow(db, pid)).slice(0, 10);
    if (!isRealDate(date)) throw new HttpError(400, 'date must be a real date (YYYY-MM-DD)');
    const locationId = await officeOf(req);
    const { day, all, plan } = await compute(req, { date, locationId });
    const rows = await track(db, req.user, { date, locationId, opps: all });
    const byKey = new Map(all.map((o) => [o.key, o]));
    const shown = all.map((o) => present(date, o, rows.get(o.key)));
    const gaps = goalGaps(day);
    const planBy = new Map(plan.providers.map((p) => [p.provider_id, p]));
    const money = can(req.user, 'billing:read');
    let ai = null;
    let aiError = null;
    const aiOn = !!day.practice.optimizer_ai && !!explainMode(config);
    if (req.query.explain === '1' && aiOn) {
      try {
        const out = await explainPlan(config, { providers: plan.providers, opportunities: all });
        ai = out && { label: out.label, sandbox: out.sandbox, summary: out.summary, ranked: out.ranked.map((x) => ({ ...x, id: rows.get(x.key)?.id ?? null, title: byKey.get(x.key)?.title })) };
        await resolveIssue(db, pid, 'optimizer-ai', 'Resolved: the AI note worked on a later try');
      } catch (err) {
        aiError = err.message;
        await raiseIssue(db, { practiceId: pid, kind: 'ai', key: 'optimizer-ai', role: 'admin', title: 'The schedule optimizer’s AI note didn’t work', detail: err.message });
      }
    }
    const tracked = [...rows.values()];
    const body = {
      date, now: day.now, location_id: locationId, money, ai_available: aiOn,
      providers: gaps.map((g) => ({
        ...g, gaps: g.gaps.map((x) => ({ start_time: at(date, x.start), end_time: at(date, x.end), minutes: x.minutes })),
        blocks: g.blocks.map((b) => ({ label: b.label, start_time: at(date, b.start), end_time: at(date, b.end), open_minutes: b.open })),
        plan: planBy.get(g.provider_id) || null,
      })),
      plan: { headline: plan.headline, moves: plan.moves, added: plan.added, collectible: plan.collectible, ids: plan.keys.map((k) => rows.get(k)?.id).filter(Boolean) },
      opportunities: shown.filter((o) => o.kind !== 'confirm' && !['declined', 'done', 'accepted'].includes(o.status)),
      protect: shown.filter((o) => o.kind === 'confirm' && !['declined', 'done'].includes(o.status)),
      working: tracked.filter((t) => t.status === 'accepted').map((t) => ({ id: t.id, key: t.key, kind: t.kind, title: t.title, fee: t.fee, action: t.action, status: t.status, patient_id: t.patient_id })),
      done: tracked.filter((t) => t.status === 'done').map((t) => ({ id: t.id, key: t.key, kind: t.kind, title: t.title, fee: t.fee, collectible: t.collectible, action: t.action, status: t.status, patient_id: t.patient_id, undoable: !['confirm', 'text_offer', 'text'].includes(t.action) })),
      declined: tracked.filter((t) => t.status === 'declined').map((t) => ({ id: t.id, key: t.key, kind: t.kind, title: t.title, reason: t.reason, patient_id: t.patient_id })),
      captured: tracked.filter((t) => t.status === 'done').reduce((n, t) => n + (t.fee || 0), 0),
      ai, ai_error: aiError,
    };
    res.json(money ? body : hideMoney(body));
    // The no-show percentages in the Double-confirm suggestions (predict/log.js), after the response.
    logShown(db, req, body.protect.filter((o) => day.noShow?.[o.appointment_id]).map((o) => ({
      kind: 'no_show', subject_type: 'appointment', subject_id: o.appointment_id, location_id: locationId ?? null, prediction: day.noShow[o.appointment_id],
    })), 'optimizer');
  });

  // What a person without billing access sees: the moves and the time, never the $.
  function hideMoney(b) {
    const strip = (o) => ({ ...o, fee: null, collectible: null, per_minute: null, at_risk: null, then: o.then ? { ...o.then, fee: null } : null });
    return {
      ...b, captured: null,
      providers: b.providers.map((p) => ({ ...p, goal: null, scheduled: null, gap: null, pct: null, plan: p.plan && { ...p.plan, goal: null, scheduled: null, added: null, projected: null, pct_now: null, pct: null, headline: `${p.plan.moves.length} suggested ${p.plan.moves.length === 1 ? 'move' : 'moves'} for ${p.name}` } })),
      plan: { ...b.plan, added: null, collectible: null, headline: `${b.plan.moves} suggested ${b.plan.moves === 1 ? 'move' : 'moves'} today` },
      opportunities: b.opportunities.map(strip), protect: b.protect.map(strip), working: b.working.map(strip), done: b.done.map(strip),
      ai: b.ai && { ...b.ai, summary: null },
    };
  }

  const rowOf = async (req) => {
    if (!/^\d+$/.test(String(req.params.id))) throw new HttpError(400, 'id must be a number');
    const row = await findOr404(db, 'optimizer_suggestions', req.params.id, req.user.practice_id, 'Suggestion');
    if (restricted(req.user) && row.location_id != null && !req.user.location_ids.includes(row.location_id)) throw new HttpError(404, 'Suggestion not found');
    if (row.patient_id && !(await canSeePatient(db, req.user, row.patient_id))) throw new HttpError(404, 'Suggestion not found');
    return row;
  };
  const fresh = (id) => db.get('SELECT * FROM optimizer_suggestions WHERE id = ?', id);
  const changed = (req, date) => publish(req.user.practice_id, { type: 'optimizer', dates: [date], by: req.user.id });

  // Doing it: re-checked against the schedule as it is now, claimed once, then through the app's own endpoints.
  r.post('/optimizer/:id/act', requirePermission('schedule:write'), async (req, res) => {
    const row = await rowOf(req);
    const alt = req.body?.alt == null ? null : Number(req.body.alt);
    if (alt != null && (!Number.isInteger(alt) || alt < 0 || alt > 3)) throw new HttpError(400, 'alt must be the number of one of the other actions');
    if (row.status === 'done' || (row.status === 'accepted' && alt == null)) return res.json({ already: true, suggestion: row });
    const { day, all } = await compute(req, { date: row.date, locationId: row.location_id });
    const o = all.find((x) => x.key === row.key);
    if (!o) throw new HttpError(409, 'This isn’t an opportunity any more — the schedule changed. The list has been refreshed.');
    if (!o.fits) throw new HttpError(409, `This doesn’t fit any more: ${o.why_not}`);
    const a = alt == null ? o.action : o.alt_actions[alt];
    if (!a) throw new HttpError(400, 'That action isn’t available for this suggestion');
    // Claim: only one request moves it on (an offer already texted can still be booked by hand).
    const claim = await db.run(
      `UPDATE optimizer_suggestions SET status = 'accepted', action = ?, updated_by = ?, source = ?, reason = NULL, updated_at = datetime('now')
       WHERE id = ? AND (status IN ('shown','declined','failed','undone') OR (status = 'accepted' AND action IN ('text_offer','text') AND ? NOT IN ('text_offer','text')))`,
      a.type, req.user.id, req.get('X-Acting-For') === 'assistant' ? 'ai' : 'human', row.id, a.type,
    );
    if (!claim.changes) return res.json({ already: true, suggestion: await fresh(row.id) });
    const call = internal(app(), req);
    const time = (m) => at(row.date, m);
    const visit = (id) => day.visits.find((v) => v.id === id);
    let result;
    try {
      switch (a.type) {
        case 'attach': {
          const v = visit(a.appointment_id);
          if (a.end) await call('PUT', `/appointments/${a.appointment_id}`, { end_time: time(a.end) });
          await call('PUT', `/procedures/${a.procedure_id}`, { appointment_id: a.appointment_id });
          result = { procedure_id: a.procedure_id, appointment_id: a.appointment_id, was_end: a.end ? v.end_time : null };
          break;
        }
        case 'finder_add': {
          const v = visit(a.appointment_id);
          if (a.end) await call('PUT', `/appointments/${a.appointment_id}`, { end_time: time(a.end) });
          const added = await call('POST', `/appointments/${a.appointment_id}/opportunities/${a.rule_id}/add`, {});
          result = { appointment_id: a.appointment_id, rule_id: a.rule_id, event_id: added.event?.id ?? null, was_end: a.end ? v.end_time : null };
          break;
        }
        case 'book': {
          const appt = await call('POST', '/appointments', {
            patient_id: a.patient_id, provider_id: a.provider_id, operatory_id: a.operatory_id ?? null, start_time: time(a.start), end_time: time(a.end),
            appointment_type_id: a.appointment_type_id ?? null, reason: a.reason ? String(a.reason).slice(0, 200) : null,
            procedure_ids: a.procedure_ids || [], add_type_procedures: !(a.procedure_ids || []).length,
          });
          result = { appointment_id: appt.id };
          break;
        }
        case 'move_up': {
          const was = await findOr404(db, 'appointments', a.appointment_id, req.user.practice_id, 'Appointment');
          await call('PUT', `/appointments/${a.appointment_id}`, { start_time: time(a.start), end_time: time(a.end), provider_id: a.provider_id, operatory_id: a.operatory_id ?? null, asap: 0 });
          result = { appointment_id: a.appointment_id, was: { start_time: was.start_time, end_time: was.end_time, provider_id: was.provider_id, operatory_id: was.operatory_id, asap: was.asap } };
          break;
        }
        case 'shorten': {
          const v = visit(a.appointment_id);
          await call('PUT', `/appointments/${a.appointment_id}`, { end_time: time(a.end) });
          result = { appointment_id: a.appointment_id, was_end: v.end_time };
          break;
        }
        case 'confirm': {
          const m = await call('POST', `/appointments/${a.appointment_id}/remind`, {});
          result = { appointment_id: a.appointment_id, message_id: m.id, status: m.status };
          break;
        }
        case 'text_offer':
        case 'text': {
          if (!can(req.user, 'patients:write')) throw new HttpError(403, 'Missing permission: patients:write');
          result = await offerGap(db, messenger, {
            practiceId: req.user.practice_id, userId: req.user.id, source: a.type === 'text' ? 'family' : a.source, refId: a.ref_id, patientId: a.patient_id,
            providerId: a.provider_id, operatoryId: a.operatory_id, start: time(a.start), end: time(a.end), reason: a.reason,
          });
          break;
        }
        default: throw new HttpError(400, 'Unknown action');
      }
    } catch (err) {
      await db.run("UPDATE optimizer_suggestions SET status = 'failed', reason = ?, updated_at = datetime('now') WHERE id = ?", String(err.message).slice(0, 300), row.id);
      throw err;
    }
    // A text waits for the patient's answer (done when they take it); everything else is done now.
    const waiting = a.type === 'text_offer' || a.type === 'text';
    await db.run(
      `UPDATE optimizer_suggestions SET status = ?, result = ?, done_at = ${waiting ? 'NULL' : "datetime('now')"}, updated_at = datetime('now') WHERE id = ?`,
      waiting ? 'accepted' : 'done', JSON.stringify(result), row.id,
    );
    await audit(db, req, 'optimizer.act', 'optimizer_suggestions', row.id, {
      key: row.key, kind: row.kind, action: a.type, title: row.title, fee: o.fee, collectible: o.collectible, date: row.date, result,
    }, { patientId: row.patient_id, locationId: row.location_id });
    changed(req, row.date);
    res.status(201).json({ already: false, suggestion: await fresh(row.id), result });
  });

  // Undo: the same endpoints, the other way. Messages can't be unsent.
  r.post('/optimizer/:id/undo', requirePermission('schedule:write'), async (req, res) => {
    const row = await rowOf(req);
    if (row.status === 'undone') return res.json({ already: true, suggestion: row });
    if (row.status !== 'done') throw new HttpError(409, 'Only something that was done can be undone');
    const x = parse(row.result);
    const call = internal(app(), req);
    switch (row.action) {
      case 'attach':
        await call('PUT', `/procedures/${x.procedure_id}`, { appointment_id: null });
        if (x.was_end) await call('PUT', `/appointments/${x.appointment_id}`, { end_time: x.was_end });
        break;
      case 'finder_add':
        await call('POST', `/appointments/${x.appointment_id}/opportunities/${x.rule_id}/undo`, {});
        if (x.was_end) await call('PUT', `/appointments/${x.appointment_id}`, { end_time: x.was_end });
        break;
      case 'book':
        await call('PATCH', `/appointments/${x.appointment_id}/status`, { status: 'cancelled', broken_reason: 'office', undo: true });
        break;
      case 'move_up':
        await call('PUT', `/appointments/${x.appointment_id}`, { ...x.was, asap: x.was.asap ? 1 : 0 });
        break;
      case 'shorten':
        await call('PUT', `/appointments/${x.appointment_id}`, { end_time: x.was_end });
        break;
      default:
        throw new HttpError(409, 'A message that was sent can’t be taken back');
    }
    await db.run("UPDATE optimizer_suggestions SET status = 'undone', updated_by = ?, done_at = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'done'", req.user.id, row.id);
    await audit(db, req, 'optimizer.undo', 'optimizer_suggestions', row.id, { key: row.key, kind: row.kind, action: row.action, title: row.title, date: row.date }, { patientId: row.patient_id, locationId: row.location_id });
    changed(req, row.date);
    res.json({ already: false, suggestion: await fresh(row.id) });
  });

  r.post('/optimizer/:id/decline', requirePermission('schedule:write'), async (req, res) => {
    const row = await rowOf(req);
    if (['accepted', 'done'].includes(row.status)) throw new HttpError(409, 'It was already acted on — undo that first');
    const reason = String(req.body?.reason || '').trim().slice(0, 300) || null;
    if (row.status !== 'declined' || (row.reason || null) !== reason) {
      await db.run("UPDATE optimizer_suggestions SET status = 'declined', reason = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?", reason, req.user.id, row.id);
      await audit(db, req, 'optimizer.decline', 'optimizer_suggestions', row.id, { key: row.key, kind: row.kind, title: row.title, date: row.date, reason }, { patientId: row.patient_id, reason, locationId: row.location_id });
      changed(req, row.date);
    }
    res.json(await fresh(row.id));
  });

  // Back on the list after "not today".
  r.post('/optimizer/:id/restore', requirePermission('schedule:write'), async (req, res) => {
    const row = await rowOf(req);
    if (row.status !== 'declined') return res.json(row);
    await db.run("UPDATE optimizer_suggestions SET status = 'shown', reason = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND status = 'declined'", req.user.id, row.id);
    await audit(db, req, 'optimizer.restore', 'optimizer_suggestions', row.id, { key: row.key, title: row.title, date: row.date }, { patientId: row.patient_id });
    changed(req, row.date);
    res.json(await fresh(row.id));
  });

  r.get('/optimizer/captured', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const from = String(req.query.from || `${today.slice(0, 7)}-01`);
    const to = String(req.query.to || today);
    if (!isRealDate(from) || !isRealDate(to) || to < from) throw new HttpError(400, 'from and to must be real dates (YYYY-MM-DD), from first');
    const out = await captured(db, pid, { from, to, locationId: await officeOf(req) });
    if (!can(req.user, 'billing:read')) {
      for (const d of out.by_day) { d.fee = null; d.collectible = null; }
      for (const p of out.by_person) p.fee = null;
    }
    res.json({ from, to, ...out });
  });

  r.get('/optimizer/settings', requirePermission('schedule:read'), async (req, res) => {
    const p = await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    res.json({ ai: !!p.optimizer_ai, ai_available: !!explainMode(config) });
  });
  r.put('/optimizer/settings', async (req, res) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can change this');
    if (typeof req.body?.ai !== 'boolean') throw new HttpError(400, 'ai must be true or false');
    await change(db, 'practices', req.user.practice_id, { optimizer_ai: req.body.ai ? 1 : 0 });
    await audit(db, req, 'optimizer.settings', 'practices', req.user.practice_id, { ai: req.body.ai });
    res.json({ ai: req.body.ai, ai_available: !!explainMode(config) });
  });

  return r;
}
