import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, recorded, audit, findOr404, isRealDate, practiceNow } from '../util.js';

// Staff licences & CPR (Documents → Staff licences): per person, what they hold and when it runs out — dental
// licence, CPR/BLS, DEA, radiology permit, CE deadline. A to-do goes to the person remind_days before a date
// (runCredentialReminders: hourly, and at once when one is added that's already inside the window), so nobody
// finds out from the board. Adding the same kind again for the same person is a renewal: the old row is kept as
// 'replaced' (and its to-do closed), never edited. Managers (officedocs:read / officedocs:write) see and change
// everyone's; the list is also what the office manual's "who's due" check reads.
export const KINDS = { license: 'Dental licence', cpr: 'CPR / BLS card', dea: 'DEA registration', radiology: 'Radiology permit', ce: 'CE deadline', other: 'Other' };
const DAY = 86400_000;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const nameOf = (c) => (c.kind === 'other' || c.label ? c.label || KINDS[c.kind] : KINDS[c.kind]);
const UNDO_MINUTES = 15;

export function stateOf(c, today) {
  if (c.expires_on < today) return 'expired';
  if (addDays(c.expires_on, -c.remind_days) <= today) return 'due';
  return 'ok';
}

// A to-do for each credential whose reminder date has come (once each: reminder_task_id).
export async function runCredentialReminders(db, practiceId = null) {
  let made = 0;
  const practices = practiceId ? [{ id: practiceId }] : await db.all("SELECT DISTINCT practice_id AS id FROM staff_credentials WHERE status = 'active' AND reminder_task_id IS NULL");
  for (const { id: pid } of practices) {
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const rows = await db.all(
      `SELECT c.*, u.name AS person FROM staff_credentials c JOIN users u ON u.id = c.user_id
       WHERE c.practice_id = ? AND c.status = 'active' AND c.reminder_task_id IS NULL AND u.active = 1 ORDER BY c.expires_on`, pid,
    );
    for (const c of rows) {
      if (stateOf(c, today) === 'ok') continue;
      await db.tx(async () => {
        const fresh = await db.get('SELECT reminder_task_id, status FROM staff_credentials WHERE id = ?', c.id);
        if (fresh.reminder_task_id || fresh.status !== 'active') return; // another pass got there first
        const late = c.expires_on < today;
        const taskId = await insert(db, 'tasks', {
          practice_id: pid, assigned_to: c.user_id, created_by: null, due_date: late ? today : c.expires_on, priority: late ? 'high' : 'normal',
          title: `${late ? 'Expired' : 'Renew'}: ${c.person}’s ${nameOf(c)} (${late ? 'expired' : 'expires'} ${c.expires_on})`.slice(0, 200),
          notes: 'When it’s renewed, add the new date under Documents → Staff licences (the old one is kept).',
        });
        await recorded(db, 'staff_credentials', c.id, () => db.run('UPDATE staff_credentials SET reminder_task_id = ? WHERE id = ? AND reminder_task_id IS NULL', taskId, c.id));
        await audit(db, { user: { practice_id: pid, id: null } }, 'staff_credential.reminder', 'staff_credentials', c.id, { task_id: taskId, expires_on: c.expires_on, user_id: c.user_id });
        made++;
      });
    }
  }
  return made;
}

export default function credentialRoutes({ db }) {
  const r = Router();
  const pid = (req) => req.user.practice_id;
  const view = (c, today) => ({ ...c, name: nameOf(c), kind_label: KINDS[c.kind], state: stateOf(c, today), days_left: Math.round((Date.parse(`${c.expires_on}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY) });

  // Everyone active, with what they hold (people with nothing on file are listed too: that's a gap to see).
  r.get('/staff-credentials', requirePermission('officedocs:read'), async (req, res) => {
    const today = (await practiceNow(db, pid(req))).slice(0, 10);
    const people = await db.all('SELECT id, name, role FROM users WHERE practice_id = ? AND active = 1 ORDER BY name', pid(req));
    const creds = await db.all("SELECT * FROM staff_credentials WHERE practice_id = ? AND status = 'active' ORDER BY expires_on", pid(req));
    const out = people.map((u) => ({ user_id: u.id, name: u.name, role: u.role, credentials: creds.filter((c) => c.user_id === u.id).map((c) => view(c, today)) }));
    res.json({ today, kinds: KINDS, people: out, due: creds.filter((c) => stateOf(c, today) !== 'ok').length });
  });

  r.post('/staff-credentials', requirePermission('officedocs:write'), async (req, res) => {
    const b = req.body || {};
    const key = b.client_key ? String(b.client_key).slice(0, 80) : null;
    if (key) {
      const same = await db.get('SELECT * FROM staff_credentials WHERE practice_id = ? AND client_key = ?', pid(req), key);
      if (same) return res.json({ credential: same, replaced: null, repeat: true }); // the same Enter twice
    }
    const person = await findOr404(db, 'users', b.user_id, pid(req), 'Staff member');
    if (!person.active) throw new HttpError(400, `${person.name} no longer works here`);
    const kind = String(b.kind || '');
    if (!KINDS[kind]) throw new HttpError(400, `Choose one of: ${Object.values(KINDS).join(', ')}`);
    const expires = String(b.expires_on || '');
    if (!isRealDate(expires)) throw new HttpError(400, 'The expiry date must be a real date (like 10/30/2027)');
    const today = (await practiceNow(db, pid(req))).slice(0, 10);
    if (expires < addDays(today, -366 * 2) || expires > addDays(today, 366 * 12)) throw new HttpError(400, 'That expiry date looks wrong — check the year');
    const label = b.label ? String(b.label).trim().slice(0, 80) || null : null;
    if (kind === 'other' && !label) throw new HttpError(400, 'Say what it is (e.g. "Nitrous permit")');
    const number = b.number ? String(b.number).trim().slice(0, 40) || null : null;
    const remind = b.remind_days == null ? (kind === 'ce' ? 90 : 60) : Number(b.remind_days);
    if (!Number.isInteger(remind) || remind < 0 || remind > 365) throw new HttpError(400, 'Remind between 0 and 365 days before');
    let id;
    let replaced = null;
    await db.tx(async () => {
      // A renewal: the same person's current one of this kind (and label) is replaced, and its to-do closed.
      replaced = await db.get(`SELECT * FROM staff_credentials WHERE practice_id = ? AND user_id = ? AND kind = ? AND status = 'active' AND COALESCE(label, '') = ?`, pid(req), person.id, kind, label || '');
      id = await insert(db, 'staff_credentials', { practice_id: pid(req), user_id: person.id, kind, label, number, expires_on: expires, remind_days: remind, client_key: key, created_by: req.user.id });
      if (replaced) {
        await recorded(db, 'staff_credentials', replaced.id, () => db.run("UPDATE staff_credentials SET status = 'replaced', replaced_by_id = ? WHERE id = ? AND status = 'active'", id, replaced.id));
        if (replaced.reminder_task_id) await recorded(db, 'tasks', replaced.reminder_task_id, () => db.run("UPDATE tasks SET status = 'done', completed_at = datetime('now'), completed_by = ? WHERE id = ? AND status = 'open'", req.user.id, replaced.reminder_task_id));
      }
      await audit(db, req, replaced ? 'staff_credential.renew' : 'staff_credential.add', 'staff_credentials', id, { user_id: person.id, kind, label, expires_on: expires, remind_days: remind, replaced_id: replaced?.id || null },
        replaced ? { before: { expires_on: replaced.expires_on }, after: { expires_on: expires } } : {});
    });
    await runCredentialReminders(db, pid(req));
    const row = await db.get('SELECT * FROM staff_credentials WHERE id = ?', id);
    res.status(201).json({ credential: view(row, today), replaced: replaced ? { id: replaced.id, expires_on: replaced.expires_on } : null, person: person.name });
  });

  // Undo of an add (the toast's Undo, within 15 minutes, by the person who added it): the new row is archived,
  // the one it replaced comes back, and a to-do it made is closed. Kept, not deleted.
  r.post('/staff-credentials/:id/undo', requirePermission('officedocs:write'), async (req, res) => {
    const c = await findOr404(db, 'staff_credentials', req.params.id, pid(req), 'Licence');
    if (c.status === 'archived') return res.json({ ok: true, already: true });
    if (c.created_by !== req.user.id || Date.now() - Date.parse(`${c.created_at.replace(' ', 'T')}Z`) > UNDO_MINUTES * 60_000) throw new HttpError(409, 'Too late to undo — archive it instead');
    await db.tx(async () => {
      await recorded(db, 'staff_credentials', c.id, () => db.run("UPDATE staff_credentials SET status = 'archived', archived_at = datetime('now'), archived_by = ? WHERE id = ?", req.user.id, c.id));
      if (c.reminder_task_id) await recorded(db, 'tasks', c.reminder_task_id, () => db.run("UPDATE tasks SET status = 'done', completed_at = datetime('now'), completed_by = ? WHERE id = ? AND status = 'open'", req.user.id, c.reminder_task_id));
      const old = await db.get("SELECT * FROM staff_credentials WHERE replaced_by_id = ? AND status = 'replaced'", c.id);
      if (old) await recorded(db, 'staff_credentials', old.id, () => db.run("UPDATE staff_credentials SET status = 'active', replaced_by_id = NULL WHERE id = ?", old.id));
      await audit(db, req, 'staff_credential.undo', 'staff_credentials', c.id, { restored_id: old?.id || null });
    });
    res.json({ ok: true });
  });

  // No longer needed (they stopped doing radiology, a one-off CE deadline passed): archived, kept, with a reason.
  r.post('/staff-credentials/:id/archive', requirePermission('officedocs:write'), async (req, res) => {
    const c = await findOr404(db, 'staff_credentials', req.params.id, pid(req), 'Licence');
    const why = String(req.body?.reason || '').trim().slice(0, 200);
    if (!why) throw new HttpError(400, 'Say why it’s no longer needed');
    if (c.status !== 'active') return res.json({ ok: true, already: true });
    await recorded(db, 'staff_credentials', c.id, () => db.run("UPDATE staff_credentials SET status = 'archived', archived_at = datetime('now'), archived_by = ? WHERE id = ? AND status = 'active'", req.user.id, c.id));
    if (c.reminder_task_id) await recorded(db, 'tasks', c.reminder_task_id, () => db.run("UPDATE tasks SET status = 'done', completed_at = datetime('now'), completed_by = ? WHERE id = ? AND status = 'open'", req.user.id, c.reminder_task_id));
    await audit(db, req, 'staff_credential.archive', 'staff_credentials', c.id, { user_id: c.user_id, kind: c.kind }, { reason: why });
    res.json({ ok: true });
  });

  return r;
}
