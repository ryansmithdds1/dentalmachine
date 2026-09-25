import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, recorded, audit, findOr404, isRealDate, practiceNow } from '../util.js';
import { canSeePatient } from '../officeaccess.js';
import { stopEnrollment } from '../cadence.js';
import { releaseAppointment, linkRecalls, validateAppt } from './schedule.js';
import { openSlotLater } from '../fill.js';
import { publish } from '../events.js';

// Mark a patient deceased — one step that does everything the office would otherwise do by hand in five places:
//   • the chart becomes inactive (so journeys, birthday wishes, recall lists and campaigns leave them out) and is
//     marked deceased (every text and email to them is then refused: messaging.js);
//   • recall stops (a "deceased" hold on the recall autopilot, and any sequence running is stopped);
//   • statements stop (the statement batch skips the account; balance texts running for it are ended);
//   • future visits are cancelled (the time goes back to the ASAP list; nobody is told — there is nobody to tell);
// and says what it did, plus what is left for a person to decide (a balance, a membership or payment plan still
// billing a card: money is never changed automatically). Everything is recorded (patient_deaths + the audit log +
// before/after of each row), and it can be undone: the chart, recall and balance texts come back, and each
// cancelled visit is put back if its time is still ahead and still free (otherwise it's listed, to rebook).
export default function deceasedRoutes({ db }) {
  const r = Router();

  const load = async (req) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    if (!(await canSeePatient(db, req.user, p.id))) throw new HttpError(404, 'Patient not found');
    if (p.merged_into_id) throw new HttpError(409, 'This chart was merged into another one — open that chart');
    return p;
  };
  const openRecord = (pid) => db.get('SELECT * FROM patient_deaths WHERE patient_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1', pid);

  // What a person still has to decide (never done automatically: it's money).
  const leftFor = async (pid, patient) => {
    const out = [];
    const bal = Number((await db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE patient_id = ?', patient.id)).n);
    if (bal > 0) out.push({ kind: 'balance', text: `A balance of $${(bal / 100).toFixed(2)} is still on the account (statements to them have stopped)` });
    if (bal < 0) out.push({ kind: 'credit', text: `A credit of $${(-bal / 100).toFixed(2)} is on the account — refund it to the estate or family` });
    const m = await db.get("SELECT id FROM memberships WHERE practice_id = ? AND patient_id = ? AND status IN ('active','past_due')", pid, patient.id);
    if (m) out.push({ kind: 'membership', text: 'Their membership plan is still active and billing — cancel it on the chart' });
    const plan = await db.get("SELECT id FROM payment_plans WHERE practice_id = ? AND patient_id = ? AND status = 'active'", pid, patient.id);
    if (plan) out.push({ kind: 'payment_plan', text: 'A payment plan is still active — decide what to do with it on the Account tab' });
    return out;
  };

  const summary = async (rec, patient) => {
    const cancelled = JSON.parse(rec.cancelled || '[]');
    return {
      id: rec.id, patient_id: patient.id, name: `${patient.first_name} ${patient.last_name}`, date_of_death: rec.date_of_death, marked_at: rec.created_at,
      chart: 'inactive', recall_stopped: !!rec.hold_id, stopped_enrollments: rec.stopped_enrollments,
      cancelled_visits: cancelled.map((c) => ({ id: c.id, start_time: c.start_time })),
      ended_balance_texts: JSON.parse(rec.ended_bill_ids || '[]').length,
      left_for_you: await leftFor(rec.practice_id, patient),
    };
  };

  r.get('/patients/:id/deceased', requirePermission('patients:read'), async (req, res) => {
    const p = await load(req);
    const rec = await openRecord(p.id);
    res.json(rec ? await summary(rec, p) : null);
  });

  r.post('/patients/:id/deceased', requirePermission('patients:write'), async (req, res) => {
    const p = await load(req);
    const pid = req.user.practice_id;
    const dod = req.body?.date_of_death ? String(req.body.date_of_death) : null;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    if (dod && (!isRealDate(dod) || dod > today)) throw new HttpError(400, 'The date of death must be a real date, not in the future');
    if (dod && p.dob && dod < p.dob) throw new HttpError(400, 'The date of death is before their birth date');
    // The same click twice (or a retry): the step already done, as it was.
    const already = await openRecord(p.id);
    if (already) return res.json({ ...(await summary(already, p)), already: true });
    const now = await practiceNow(db, pid);
    let recId;
    await db.tx(async () => {
      // 1. The chart: inactive and marked deceased.
      await recorded(db, 'patients', p.id, () => db.run("UPDATE patients SET status = 'inactive', deceased_at = datetime('now'), deceased_on = ? WHERE id = ?", dod, p.id));
      // 2. Recall: a deceased hold (unless there already is one), and whatever is running for them stopped.
      let holdId = (await db.get("SELECT id FROM cadence_holds WHERE patient_id = ? AND released_at IS NULL AND reason = 'deceased' AND type IS NULL", p.id))?.id || null;
      const newHold = !holdId;
      if (newHold) holdId = await insert(db, 'cadence_holds', { practice_id: pid, patient_id: p.id, type: null, reason: 'deceased', note: 'Marked deceased', created_by: req.user.id });
      let stopped = 0;
      for (const e of await db.all("SELECT * FROM cadence_enrollments WHERE patient_id = ? AND practice_id = ? AND status = 'active'", p.id, pid)) {
        await stopEnrollment(db, e, { reason: 'deceased', userId: req.user.id, req });
        stopped++;
      }
      // 3. Statements and balance texts: the statement batch skips deceased accounts; running balance texts end.
      const bills = [];
      for (const b of await db.all("SELECT id FROM balance_bills WHERE practice_id = ? AND patient_id = ? AND status = 'active'", pid, p.id)) {
        await recorded(db, 'balance_bills', b.id, () => db.run("UPDATE balance_bills SET status = 'stopped', stop_reason = 'deceased', ended_at = datetime('now') WHERE id = ? AND status = 'active'", b.id));
        bills.push(b.id);
      }
      // 4. Future visits cancelled, remembering the planned work each held so an undo can put it back.
      const cancelled = [];
      for (const a of await db.all("SELECT * FROM appointments WHERE practice_id = ? AND patient_id = ? AND status IN ('scheduled','confirmed') AND start_time >= ? ORDER BY start_time", pid, p.id, now.slice(0, 16))) {
        const procs = (await db.all("SELECT id FROM procedures WHERE appointment_id = ? AND status = 'planned'", a.id)).map((x) => x.id);
        await recorded(db, 'appointments', a.id, () => db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ?, broken_reason = 'other', broken_note = 'Patient deceased' WHERE id = ?", now, a.id));
        await releaseAppointment(db, a.id);
        cancelled.push({ id: a.id, start_time: a.start_time, status: a.status, procedure_ids: procs });
      }
      recId = await insert(db, 'patient_deaths', {
        practice_id: pid, patient_id: p.id, date_of_death: dod, prior_status: p.status, hold_id: newHold ? holdId : null,
        cancelled: JSON.stringify(cancelled), ended_bill_ids: JSON.stringify(bills), stopped_enrollments: stopped, created_by: req.user.id,
      });
      await audit(db, req, 'patient.deceased', 'patients', p.id, {
        date_of_death: dod, prior_status: p.status, cancelled_visits: cancelled.map((c) => c.id), ended_balance_texts: bills, stopped_recall_sequences: stopped, record_id: recId,
      }, { patientId: p.id, reason: dod ? `Deceased ${dod}` : 'Deceased' });
    });
    const rec = await db.get('SELECT * FROM patient_deaths WHERE id = ?', recId);
    const gone = JSON.parse(rec.cancelled);
    for (const c of gone) openSlotLater(db, c.id);
    if (gone.length) publish(pid, { type: 'schedule', dates: [...new Set(gone.map((c) => c.start_time.slice(0, 10)))], by: req.user.id });
    res.status(201).json(await summary(rec, await db.get('SELECT * FROM patients WHERE id = ?', p.id)));
  });

  // A mistake put right. The chart, recall and balance texts come back; each cancelled visit is put back when its
  // time is still ahead and still free, with the planned work it held; the others are listed to rebook.
  r.post('/patients/:id/deceased/undo', requirePermission('patients:write'), async (req, res) => {
    const p = await load(req);
    const pid = req.user.practice_id;
    const rec = await openRecord(p.id);
    if (!rec) return res.json({ undone: false, restored_visits: [], not_restored: [] }); // already undone (a second click)
    const now = (await practiceNow(db, pid)).slice(0, 16);
    const restored = [];
    const notRestored = [];
    await db.tx(async () => {
      const back = p.status === 'inactive' ? rec.prior_status : p.status;
      await recorded(db, 'patients', p.id, () => db.run('UPDATE patients SET status = ?, deceased_at = NULL, deceased_on = NULL WHERE id = ?', back, p.id));
      if (rec.hold_id) await recorded(db, 'cadence_holds', rec.hold_id, () => db.run("UPDATE cadence_holds SET released_at = datetime('now'), released_by = ? WHERE id = ? AND released_at IS NULL", req.user.id, rec.hold_id));
      for (const id of JSON.parse(rec.ended_bill_ids)) {
        await recorded(db, 'balance_bills', id, () => db.run("UPDATE balance_bills SET status = 'active', stop_reason = NULL, ended_at = NULL WHERE id = ? AND status = 'stopped' AND stop_reason = 'deceased'", id));
      }
      for (const c of JSON.parse(rec.cancelled)) {
        const a = await db.get('SELECT * FROM appointments WHERE id = ? AND practice_id = ?', c.id, pid);
        if (!a || a.status !== 'cancelled' || a.start_time < now) { notRestored.push({ id: c.id, start_time: c.start_time, why: a?.start_time < now ? 'its time has passed' : 'it was changed since' }); continue; }
        try {
          await validateAppt(db, pid, { ...a, status: c.status }, { overrideBlockout: true });
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          notRestored.push({ id: c.id, start_time: c.start_time, why: 'its time has been given to someone else' });
          continue;
        }
        await recorded(db, 'appointments', a.id, () => db.run('UPDATE appointments SET status = ?, cancelled_at = NULL, broken_reason = NULL, broken_note = NULL WHERE id = ?', c.status, a.id));
        for (const prId of c.procedure_ids || []) {
          await recorded(db, 'procedures', prId, () => db.run("UPDATE procedures SET appointment_id = ? WHERE id = ? AND status = 'planned' AND appointment_id IS NULL", a.id, prId));
        }
        await linkRecalls(db, pid, a.id);
        restored.push({ id: a.id, start_time: a.start_time });
      }
      const note = notRestored.length ? `${notRestored.length} visit(s) not put back` : null;
      await recorded(db, 'patient_deaths', rec.id, () => db.run("UPDATE patient_deaths SET undone_at = datetime('now'), undone_by = ?, undo_note = ? WHERE id = ? AND undone_at IS NULL", req.user.id, note, rec.id));
      await audit(db, req, 'patient.deceased_undo', 'patients', p.id, { record_id: rec.id, status: back, restored_visits: restored.map((x) => x.id), not_restored: notRestored.map((x) => x.id) }, { patientId: p.id });
    });
    if (restored.length) publish(pid, { type: 'schedule', dates: [...new Set(restored.map((v) => v.start_time.slice(0, 10)))], by: req.user.id });
    res.json({ undone: true, restored_visits: restored, not_restored: notRestored });
  });

  return r;
}
