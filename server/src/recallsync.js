// Keeping recalls current (RF1–RF2, docs/workflows/specs/RF-recall-frequencies.md).
//
// A recall's due date comes from the last time its work was done: completing any of a type's codes (or entering
// the same work done at another office) resets it from the date of service. Every reset is kept in recall_resets
// with the recall as it was before, so voiding the procedure puts the recall back: to what the remaining resets
// say, or — when none is left — to how it was before the first one. Nothing here deletes a recall: retired
// recalls (prophy after the switch to perio maintenance, a child prophy once the patient is old enough, a
// duplicate) are status 'inactive' with the reason in status_reason. Every change goes through recorded()/
// insert(), so the audit log has the before and after and who (or which automation) did it.
import { HttpError } from './auth.js';
import { insert, addMonths, recorded, localNow, isRealDate } from './util.js';
import { withActor } from './actor.js';
import { recallTypes, typesForCode } from './recalls.js';

const ACTIVE_VISIT = ['scheduled', 'confirmed', 'checked_in', 'in_chair'];
const STATE = ['status', 'due_date', 'appointment_id', 'last_done_date', 'last_done_code', 'last_done_source', 'last_done_location_id', 'status_reason'];
const snapshot = (r) => (r ? Object.fromEntries(STATE.map((k) => [k, r[k] ?? null])) : { missing: true });
const parse = (v, fallback) => {
  try {
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};

// Whole years on a date (null without a usable date of birth).
export function ageOn(dob, date) {
  if (!dob || !/^\d{4}-\d{2}-\d{2}/.test(dob) || !date) return null;
  let age = Number(date.slice(0, 4)) - Number(dob.slice(0, 4));
  if (date.slice(5, 10) < dob.slice(5, 10)) age--;
  return age;
}

// Which recall types a code resets for a patient of this age. A child type past its age resets the adult type
// instead; when both a child type and its adult type list the code, the patient's age picks one (unknown age:
// the child type, whose code it is).
export function typesFor(types, code, age) {
  const matched = typesForCode(types, code);
  const byKey = new Map(types.map((t) => [t.key, t]));
  const out = [];
  const add = (t) => { if (!out.includes(t)) out.push(t); };
  for (const t of matched) {
    if (t.age_until != null && t.adult_key && age != null && age >= t.age_until) {
      const adult = byKey.get(t.adult_key);
      if (adult?.active) { add(adult); continue; }
    }
    const child = matched.find((c) => c !== t && c.adult_key === t.key && c.age_until != null);
    if (child && (age == null || age < child.age_until)) continue;
    add(t);
  }
  return out;
}

async function recallOf(db, practiceId, patientId, key) {
  return db.get('SELECT * FROM recalls WHERE practice_id = ? AND patient_id = ? AND type = ?', practiceId, patientId, key);
}

async function setRecall(db, id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await recorded(db, 'recalls', id, () => db.run(`UPDATE recalls SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k]), id));
}

// Works out a recall from its resets: due = latest date of service + the recall's interval. A newer visit makes
// it due again (a later visit already booked stays booked); with no reset left it goes back to how it was.
export async function settle(db, recallId, { visitId = null } = {}) {
  const r = await db.get('SELECT * FROM recalls WHERE id = ?', recallId);
  if (!r) return;
  const rows = await db.all('SELECT * FROM recall_resets WHERE recall_id = ? ORDER BY done_date, id', recallId);
  const latest = rows.filter((x) => !x.undone_at).at(-1);
  const patch = {};
  if (latest) {
    const source = latest.outside_id ? 'outside' : 'here';
    Object.assign(patch, {
      due_date: addMonths(latest.done_date, r.interval_months), last_done_date: latest.done_date, last_done_code: latest.code,
      last_done_source: source, last_done_location_id: latest.location_id ?? null,
    });
    const newDone = r.last_done_date !== latest.done_date || r.last_done_code !== latest.code || r.last_done_source !== source;
    if (newDone || r.status === 'inactive') {
      const appt = r.appointment_id ? await db.get('SELECT id, start_time, status FROM appointments WHERE id = ?', r.appointment_id) : null;
      const keep = r.status === 'scheduled' && appt && appt.id !== visitId && ACTIVE_VISIT.includes(appt.status) && appt.start_time.slice(0, 10) > latest.done_date;
      if (!keep) Object.assign(patch, { status: 'due', appointment_id: null, status_reason: null });
    }
  } else {
    const base = parse(rows[0]?.before_state, { missing: true });
    if (base.missing) {
      Object.assign(patch, {
        status: 'inactive', appointment_id: null, status_reason: 'The procedure that started this recall was voided',
        last_done_date: null, last_done_code: null, last_done_source: null, last_done_location_id: null,
      });
    } else {
      for (const k of STATE) patch[k] = base[k] ?? null;
      if (patch.appointment_id) {
        const appt = await db.get('SELECT status FROM appointments WHERE id = ?', patch.appointment_id);
        if (!appt || !ACTIVE_VISIT.includes(appt.status)) Object.assign(patch, { appointment_id: null, status: patch.status === 'scheduled' ? 'due' : patch.status });
      }
    }
  }
  for (const k of Object.keys(patch)) if ((patch[k] ?? null) === (r[k] ?? null)) delete patch[k];
  await setRecall(db, r.id, patch);
}

// One piece of work done (a completed procedure, or outside work) resets one recall type for the patient.
// Idempotent: the same procedure (or outside entry) resets a recall once; completing it again after a void
// brings its reset back.
async function applyDone(db, { practiceId, patientId, type, code, date, procedureId = null, outsideId = null, locationId = null, visitId = null }) {
  let recall = await recallOf(db, practiceId, patientId, type.key);
  const before = snapshot(recall);
  if (!recall) {
    const id = await insert(db, 'recalls', {
      practice_id: practiceId, patient_id: patientId, type: type.key, interval_months: type.interval_months, due_date: addMonths(date, type.interval_months), status: 'due',
    });
    recall = await db.get('SELECT * FROM recalls WHERE id = ?', id);
  }
  const [col, val] = procedureId ? ['procedure_id', procedureId] : ['outside_id', outsideId];
  const had = await db.get(`SELECT * FROM recall_resets WHERE recall_id = ? AND ${col} = ?`, recall.id, val);
  let resetId;
  if (had) {
    if (!had.undone_at && had.done_date === date) return;
    await db.run('UPDATE recall_resets SET undone_at = NULL, undone_reason = NULL, done_date = ?, code = ?, location_id = ? WHERE id = ?', date, code, locationId, had.id);
    resetId = had.id;
  } else {
    resetId = await insert(db, 'recall_resets', {
      practice_id: practiceId, patient_id: patientId, recall_id: recall.id, procedure_id: procedureId, outside_id: outsideId,
      code, done_date: date, location_id: locationId, before_state: JSON.stringify(before),
    });
  }
  // The types this one replaces are retired (perio maintenance → prophy), unless they were done more recently.
  const retired = [];
  for (const key of type.retires || []) {
    const other = await db.get("SELECT * FROM recalls WHERE practice_id = ? AND patient_id = ? AND type = ? AND status != 'inactive'", practiceId, patientId, key);
    if (!other || (other.last_done_date && other.last_done_date > date)) continue;
    retired.push({ id: other.id, ...snapshot(other) });
    await setRecall(db, other.id, { status: 'inactive', appointment_id: null, status_reason: `Replaced by ${type.name} (${code} on ${date})` });
  }
  if (retired.length) await db.run('UPDATE recall_resets SET retired = ? WHERE id = ?', JSON.stringify(retired), resetId);
  await settle(db, recall.id, { visitId });
}

// Completing a procedure resets every recall type its code belongs to, from the date of service.
// (services.js completeProcedure calls this inside its transaction.)
export async function resetRecalls(db, procedure, dateOfService) {
  const p = (await db.get('SELECT * FROM procedures WHERE id = ?', procedure.id)) || procedure;
  const date = String(dateOfService || p.completed_at || '').slice(0, 10);
  if (!isRealDate(date)) return;
  const types = await recallTypes(db, p.practice_id);
  const patient = await db.get('SELECT dob FROM patients WHERE id = ?', p.patient_id);
  for (const type of typesFor(types, p.code, ageOn(patient?.dob, date))) {
    await applyDone(db, {
      practiceId: p.practice_id, patientId: p.patient_id, type, code: p.code, date, procedureId: p.id, locationId: p.location_id ?? null, visitId: p.appointment_id ?? null,
    });
  }
}

// A voided or un-completed procedure (or voided outside entry) takes its resets back: the recalls it retired
// return (unless someone changed them since) and each recall goes back to what's left.
export async function undoRecallResets(db, { procedureId = null, outsideId = null }, reason = null) {
  const [col, val] = procedureId ? ['procedure_id', procedureId] : ['outside_id', outsideId];
  if (!val) return 0;
  const rows = await db.all(`SELECT * FROM recall_resets WHERE ${col} = ? AND undone_at IS NULL`, val);
  for (const row of rows) {
    await db.run("UPDATE recall_resets SET undone_at = datetime('now'), undone_reason = ? WHERE id = ?", reason ? String(reason).slice(0, 300) : null, row.id);
    for (const x of parse(row.retired, [])) {
      const cur = await db.get('SELECT * FROM recalls WHERE id = ?', x.id);
      if (cur?.status !== 'inactive' || !String(cur.status_reason || '').startsWith('Replaced by')) continue;
      const appt = x.appointment_id ? await db.get('SELECT status FROM appointments WHERE id = ?', x.appointment_id) : null;
      const live = appt && ACTIVE_VISIT.includes(appt.status);
      await setRecall(db, x.id, { status: x.status === 'scheduled' && !live ? 'due' : x.status, appointment_id: live ? x.appointment_id : null, status_reason: x.status_reason ?? null });
    }
    await settle(db, row.recall_id);
  }
  return rows.length;
}

// Safety net for any path that takes a procedure back to planned without calling undoRecallResets: resets whose
// procedure is no longer completed are undone (run before a recall is shown, and nightly).
export async function healRecallResets(db, practiceId, { patientId = null } = {}) {
  const rows = await db.all(
    `SELECT DISTINCT rr.procedure_id FROM recall_resets rr JOIN procedures p ON p.id = rr.procedure_id
     WHERE rr.practice_id = ? AND rr.undone_at IS NULL AND p.status != 'completed'${patientId ? ' AND rr.patient_id = ?' : ''}`,
    practiceId, ...(patientId ? [patientId] : []),
  );
  for (const r of rows) await undoRecallResets(db, { procedureId: r.procedure_id }, 'The procedure is no longer completed');
  return rows.length;
}

// ---- Age rule ----
// A child type (child prophy) becomes the adult type (prophy) once the patient reaches its age: the adult recall
// takes over the due date, the last visit and any booking, and the child recall is retired. Idempotent.
export async function applyAgeRules(db, practiceId, today, { patientId = null } = {}) {
  const types = await recallTypes(db, practiceId);
  let switched = 0;
  for (const child of types.filter((t) => t.age_until != null && t.adult_key)) {
    const adult = types.find((t) => t.key === child.adult_key && t.active);
    if (!adult) continue;
    const rows = await db.all(
      `SELECT r.*, p.dob FROM recalls r JOIN patients p ON p.id = r.patient_id
       WHERE r.practice_id = ? AND r.type = ? AND r.status != 'inactive' AND p.dob IS NOT NULL${patientId ? ' AND r.patient_id = ?' : ''}`,
      practiceId, child.key, ...(patientId ? [patientId] : []),
    );
    for (const r of rows) {
      const age = ageOn(r.dob, today);
      if (age == null || age < child.age_until) continue;
      const carry = {
        due_date: r.due_date, status: r.status, appointment_id: r.appointment_id ?? null, last_done_date: r.last_done_date ?? null, last_done_code: r.last_done_code ?? null,
        last_done_source: r.last_done_source ?? null, last_done_location_id: r.last_done_location_id ?? null, status_reason: `${child.name} until ${child.age_until}: now ${adult.name}`,
      };
      const a = await recallOf(db, practiceId, r.patient_id, adult.key);
      if (!a) {
        await insert(db, 'recalls', { practice_id: practiceId, patient_id: r.patient_id, type: adult.key, interval_months: adult.interval_months, ...carry });
      } else if (a.status === 'inactive') {
        await setRecall(db, a.id, carry);
      }
      await setRecall(db, r.id, { status: 'inactive', appointment_id: null, status_reason: `Aged into ${adult.name} (age ${age})` });
      switched++;
    }
  }
  return switched;
}

// Nightly: the age rule for every practice, recorded as automation.
export async function runRecallAgeRules(db, { now = new Date() } = {}) {
  let n = 0;
  for (const p of await db.all('SELECT id, timezone FROM practices')) {
    const today = localNow(p.timezone, now).slice(0, 10);
    n += await withActor({ source: 'automation', actor: 'Recall age rule', practiceId: p.id }, async () => {
      await healRecallResets(db, p.id);
      return applyAgeRules(db, p.id, today);
    });
  }
  return n;
}

// ---- Per-patient changes (routes/recallfreq.js audits each with its reason) ----

// A different interval for this patient (perio every 3 or 4 months…), or null to go back to the type's own.
// The due date moves with it (from the last visit when known).
export async function setRecallInterval(db, recall, months, reason) {
  const types = await recallTypes(db, recall.practice_id);
  const type = types.find((t) => t.key === recall.type);
  const clear = months == null;
  const next = clear ? (type?.interval_months ?? recall.interval_months) : Number(months);
  if (!Number.isInteger(next) || next < 1 || next > 120) throw new HttpError(400, 'The interval must be 1 to 120 months');
  const patch = { interval_months: next, interval_overridden: clear ? 0 : 1, interval_reason: clear ? null : reason };
  if (recall.last_done_date) patch.due_date = addMonths(recall.last_done_date, next);
  else if (recall.due_date) patch.due_date = addMonths(recall.due_date, next - recall.interval_months);
  await setRecall(db, recall.id, patch);
  return db.get('SELECT * FROM recalls WHERE id = ?', recall.id);
}

// Moves a patient from one cleaning type to another (prophy → perio maintenance, or back): the new recall is due
// one interval after their latest cleaning or scaling (else from today); the ones it replaces are retired.
export async function switchRecallType(db, practiceId, patientId, toKey, reason, today) {
  const types = await recallTypes(db, practiceId);
  const to = types.find((t) => t.key === toKey && t.active && !t.bundle);
  if (!to) throw new HttpError(400, 'Choose an active cleaning recall type to switch to');
  const replaced = types.filter((t) => to.retires.includes(t.key) || t.retires.includes(to.key));
  const cleaningCodes = [...new Set([...replaced.flatMap((t) => t.codes), ...to.codes, 'D4341', 'D4342'])];
  const history = await db.all("SELECT code, completed_at FROM procedures WHERE practice_id = ? AND patient_id = ? AND status = 'completed' AND completed_at IS NOT NULL", practiceId, patientId);
  const last = history.filter((p) => cleaningCodes.some((c) => String(p.code).startsWith(c))).map((p) => p.completed_at.slice(0, 10)).sort().at(-1) || null;
  const due = addMonths(last || today, to.interval_months);
  const retired = [];
  for (const t of replaced) {
    const r = await recallOf(db, practiceId, patientId, t.key);
    if (!r || r.status === 'inactive') continue;
    await setRecall(db, r.id, { status: 'inactive', appointment_id: null, status_reason: `Switched to ${to.name}: ${reason}` });
    retired.push(r.id);
  }
  let recall = await recallOf(db, practiceId, patientId, to.key);
  if (!recall) {
    const id = await insert(db, 'recalls', { practice_id: practiceId, patient_id: patientId, type: to.key, interval_months: to.interval_months, due_date: due, status: 'due', status_reason: `Switched: ${reason}` });
    recall = await db.get('SELECT * FROM recalls WHERE id = ?', id);
  } else if (recall.status === 'inactive') {
    await setRecall(db, recall.id, { status: 'due', due_date: addMonths(last || today, recall.interval_months), appointment_id: null, status_reason: `Switched: ${reason}` });
  }
  return { recall: await db.get('SELECT * FROM recalls WHERE id = ?', recall.id), retired };
}

// Work done at another office (x-rays taken elsewhere…): recorded with source 'outside' and resets the recall
// from its date. The same code on the same date is entered once (a repeat answers with the first).
export async function addOutsideWork(db, { practiceId, patientId, code, date, officeName = null, note = null, userId = null, today }) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^D\d{4}$/.test(c)) throw new HttpError(400, 'code must be a procedure code like D0274');
  if (!isRealDate(date)) throw new HttpError(400, 'date must be a real date (YYYY-MM-DD)');
  if (date > today) throw new HttpError(400, 'The date can’t be in the future');
  const patient = await db.get('SELECT id, dob, location_id FROM patients WHERE id = ? AND practice_id = ?', patientId, practiceId);
  if (!patient) throw new HttpError(404, 'Patient not found');
  if (patient.dob && date < patient.dob.slice(0, 10)) throw new HttpError(400, 'The date is before the patient was born');
  const types = typesFor(await recallTypes(db, practiceId), c, ageOn(patient.dob, date));
  if (!types.length) throw new HttpError(400, `${c} doesn’t reset any active recall type`);
  const same = await db.get("SELECT * FROM recall_outside WHERE practice_id = ? AND patient_id = ? AND code = ? AND done_on = ? AND status = 'active'", practiceId, patientId, c, date);
  if (same) return { entry: same, already: true };
  const id = await db.tx(async () => {
    const newId = await insert(db, 'recall_outside', {
      practice_id: practiceId, patient_id: patientId, location_id: patient.location_id ?? null, code: c, done_on: date, source: 'outside',
      office_name: officeName ? String(officeName).trim().slice(0, 120) || null : null, note: note ? String(note).trim().slice(0, 500) || null : null, created_by: userId,
    });
    for (const type of types) await applyDone(db, { practiceId, patientId, type, code: c, date, outsideId: newId });
    return newId;
  });
  return { entry: await db.get('SELECT * FROM recall_outside WHERE id = ?', id), already: false };
}

export async function voidOutsideWork(db, entry, { userId, reason }) {
  if (entry.status === 'voided') throw new HttpError(409, 'That entry was already voided');
  await db.tx(async () => {
    await recorded(db, 'recall_outside', entry.id, () => db.run("UPDATE recall_outside SET status = 'voided', voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ? AND status = 'active'", userId ?? null, reason, entry.id));
    await undoRecallResets(db, { outsideId: entry.id }, reason);
  });
}

// ---- Duplicates ----
// "One recall per patient per type" is a database rule, but the same person can still be recalled twice: a
// merged duplicate chart kept its own recalls, or a patient has both a child and an adult cleaning, or both a
// prophy and perio maintenance. This finds them (preview) and, with apply, merges them: the kept recall takes
// the later visit, the other is retired (inactive, never deleted). Ambiguous cases are listed for a person.
export async function findDuplicateRecalls(db, practiceId, { today, apply = false } = {}) {
  const types = await recallTypes(db, practiceId);
  const byKey = new Map(types.map((t) => [t.key, t]));
  const actions = [];
  // 1. Recalls left on a chart that was merged into another.
  const moved = await db.all(
    `SELECT r.*, p.merged_into_id FROM recalls r JOIN patients p ON p.id = r.patient_id
     WHERE r.practice_id = ? AND p.merged_into_id IS NOT NULL AND r.status != 'inactive' ORDER BY r.id`, practiceId,
  );
  for (const r of moved) {
    const kept = await recallOf(db, practiceId, r.merged_into_id, r.type);
    if (!kept) {
      actions.push({ kind: 'move', recall_id: r.id, patient_id: r.patient_id, to_patient_id: r.merged_into_id, type: r.type, why: `Moved to the kept chart (#${r.merged_into_id})` });
      if (apply) await setRecall(db, r.id, { patient_id: r.merged_into_id });
      continue;
    }
    const laterHere = (r.last_done_date || '') > (kept.last_done_date || '');
    actions.push({ kind: 'merge', recall_id: r.id, keep_id: kept.id, patient_id: r.merged_into_id, type: r.type, why: `Duplicate chart #${r.patient_id} merged into #${r.merged_into_id}` });
    if (apply) {
      if (laterHere || kept.status === 'inactive') {
        await setRecall(db, kept.id, {
          due_date: r.due_date, last_done_date: r.last_done_date ?? null, last_done_code: r.last_done_code ?? null, last_done_source: r.last_done_source ?? null,
          last_done_location_id: r.last_done_location_id ?? null, ...(kept.status === 'inactive' ? { status: r.status === 'scheduled' ? 'scheduled' : 'due', appointment_id: r.appointment_id ?? null, status_reason: null } : {}),
        });
      }
      await setRecall(db, r.id, { status: 'inactive', appointment_id: null, status_reason: `Merged into recall #${kept.id} (patient #${r.merged_into_id})` });
    }
  }
  // 2. Two cleaning types live for one patient.
  const live = await db.all(
    `SELECT r.*, p.dob FROM recalls r JOIN patients p ON p.id = r.patient_id
     WHERE r.practice_id = ? AND r.status != 'inactive' AND p.merged_into_id IS NULL ORDER BY r.patient_id, r.id`, practiceId,
  );
  const byPatient = new Map();
  for (const r of live) {
    if (!byPatient.has(r.patient_id)) byPatient.set(r.patient_id, []);
    byPatient.get(r.patient_id).push(r);
  }
  for (const [patientId, rows] of byPatient) {
    const has = new Map(rows.map((r) => [r.type, r]));
    const done = new Set();
    for (const r of rows) {
      const t = byKey.get(r.type);
      if (!t || done.has(r.id)) continue;
      for (const otherKey of t.retires || []) {
        const o = has.get(otherKey);
        const ot = byKey.get(otherKey);
        if (!o || done.has(o.id) || done.has(r.id)) continue;
        let keep;
        let drop;
        let why;
        const pair = (t.adult_key === otherKey && t.age_until != null) ? [r, o, t] : (ot?.adult_key === t.key && ot.age_until != null) ? [o, r, ot] : null;
        if (pair) {
          const [childRow, adultRow, childType] = pair;
          const age = ageOn(r.dob, today);
          if (age == null) { actions.push({ kind: 'review', patient_id: patientId, recall_ids: [r.id, o.id], why: 'Both a child and an adult cleaning recall, and no date of birth' }); done.add(r.id); done.add(o.id); continue; }
          [keep, drop] = age < childType.age_until ? [childRow, adultRow] : [adultRow, childRow];
          why = `Age ${age}: ${byKey.get(keep.type).name}`;
        } else if ((r.last_done_date || '') >= (o.last_done_date || '') && r.last_done_date) {
          [keep, drop] = [r, o];
          why = `${t.name} is the more recent (${r.last_done_date})`;
        } else {
          actions.push({ kind: 'review', patient_id: patientId, recall_ids: [r.id, o.id], why: `Both ${t.name} and ${ot?.name || otherKey} are live and ${ot?.name || otherKey} was done more recently — decide which to keep` });
          done.add(r.id); done.add(o.id);
          continue;
        }
        actions.push({ kind: 'retire', patient_id: patientId, keep_id: keep.id, recall_id: drop.id, type: drop.type, why });
        done.add(drop.id);
        if (apply) await setRecall(db, drop.id, { status: 'inactive', appointment_id: null, status_reason: `Duplicate of recall #${keep.id}: ${why}` });
      }
    }
  }
  return actions;
}
