// Production on the schedule (S5): GET /schedule/production?date=YYYY-MM-DD[&days=7][&location_id=][&kind=all|doctor|hygiene].
// Anyone who can see the schedule gets visit counts and the day's blocks; the money needs billing:read
// (without it every amount comes back null and the schedule hides it). Calculation: production.js.
import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, isRealDate } from '../util.js';
import { checkOffice } from '../officeaccess.js';
import { scheduleProduction, KINDS } from '../production.js';

export default function productionRoutes({ db }) {
  const r = Router();

  r.get('/schedule/production', requirePermission('schedule:read'), async (req, res, next) => {
    // The older per-provider summary (?from&to, schedule.js) answers requests without a date.
    if (req.query.date == null && req.query.from != null) return next();
    const date = String(req.query.date ?? '');
    if (!isRealDate(date)) throw new HttpError(400, 'date must be a real date (YYYY-MM-DD)');
    const days = req.query.days == null ? 1 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 14) throw new HttpError(400, 'days must be 1-14');
    const kind = req.query.kind == null ? 'all' : String(req.query.kind);
    if (!KINDS.includes(kind)) throw new HttpError(400, `kind must be one of: ${KINDS.join(', ')}`);
    let locationId = null;
    if (req.query.location_id != null && req.query.location_id !== '') {
      locationId = (await findOr404(db, 'locations', req.query.location_id, req.user.practice_id, 'Location')).id;
      checkOffice(req.user, locationId);
    }
    res.json(await scheduleProduction(db, req.user, { from: date, days, locationId, kind }));
  });

  return r;
}
