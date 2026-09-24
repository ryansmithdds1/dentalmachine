// Capacity meter (CAP1–CAP2): is there enough doctor and hygiene time? See capacity.js and docs/capacity.md.
// Viewing needs schedule:read — the numbers are hours, days and counts, never money or patients. The targets are
// practice configuration: only an administrator changes them, and every change is audited with before and after.
import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { audit, findOr404, recorded } from '../util.js';
import { checkOffice, restricted } from '../officeaccess.js';
import { capacityFor, capacityTrend, parseTargets, validateTargets, DEFAULT_TARGETS } from '../capacity.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only an administrator can change the capacity targets')));

export default function capacityRoutes({ db }) {
  const r = Router();

  // The office asked for (?location_id=, 'all' for the whole practice), else the office this screen works in.
  // Someone limited to some offices always sees one of theirs.
  const officeFor = async (req) => {
    const q = req.query.location_id;
    let id = q === undefined ? req.location_id ?? null : q === '' || q === 'all' ? null : Number(q);
    if (id != null && (!Number.isInteger(id) || id <= 0)) throw new HttpError(400, 'location_id must be an office id');
    if (id == null && restricted(req.user)) id = req.user.location_ids[0];
    if (id != null) {
      await findOr404(db, 'locations', id, req.user.practice_id, 'Office');
      checkOffice(req.user, id);
    }
    return id;
  };

  r.get('/capacity', requirePermission('schedule:read'), async (req, res) => {
    const locationId = await officeFor(req);
    res.json(await capacityFor(db, req.user.practice_id, { locationId }));
  });

  r.get('/capacity/trend', requirePermission('schedule:read'), async (req, res) => {
    const locationId = await officeFor(req);
    const days = req.query.days == null ? 90 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 7 || days > 731) throw new HttpError(400, 'days must be 7 to 731');
    const c = await capacityFor(db, req.user.practice_id, { locationId });
    res.json({ location_id: locationId, ...(await capacityTrend(db, req.user.practice_id, { locationId, days, today: c.today })) });
  });

  r.get('/capacity/targets', requirePermission('schedule:read'), async (req, res) => {
    const p = await db.get('SELECT capacity_targets FROM practices WHERE id = ?', req.user.practice_id);
    res.json({ targets: parseTargets(p?.capacity_targets), defaults: DEFAULT_TARGETS, can_edit: req.user.role === 'admin' });
  });

  // Change some targets (only the fields sent); an optional reason goes on the audit entry.
  r.put('/capacity/targets', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const body = { ...(req.body || {}) };
    const reason = body.reason ? String(body.reason).trim().slice(0, 500) : null;
    delete body.reason;
    const p = await db.get('SELECT capacity_targets FROM practices WHERE id = ?', pid);
    const before = parseTargets(p?.capacity_targets);
    const next = validateTargets(body, before);
    for (const k of ['new_patient_type_id', 'emergency_type_id']) {
      if (next[k] == null || next[k] === before[k]) continue;
      const t = await findOr404(db, 'appointment_types', next[k], pid, 'Visit type');
      if (!t.active) throw new HttpError(400, `${t.name} is switched off — choose a visit type the office uses`);
    }
    const stored = JSON.stringify(next);
    await recorded(db, 'practices', pid, () => db.run('UPDATE practices SET capacity_targets = ? WHERE id = ?', stored, pid));
    const changed = Object.fromEntries(Object.keys(next).filter((k) => before[k] !== next[k]).map((k) => [k, true]));
    await audit(db, req, 'capacity.targets.update', 'practices', pid, { fields: Object.keys(changed) }, {
      before: Object.fromEntries(Object.keys(changed).map((k) => [k, before[k]])),
      after: Object.fromEntries(Object.keys(changed).map((k) => [k, next[k]])),
      reason,
    });
    res.json({ targets: next, defaults: DEFAULT_TARGETS, can_edit: true });
  });

  return r;
}
