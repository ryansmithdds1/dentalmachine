import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { practiceNow } from '../util.js';
import { reconcileCards, reconcileInsuranceChecks, reconcileClaims, reconcileImports } from '../reconcile.js';

// One screen that compares each side of every boundary for a date range (default: this month so far).
export default function reconciliationRoutes({ db, payments }) {
  const r = Router();
  r.get('/reports/reconciliation', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const from = String(req.query.from || `${today.slice(0, 8)}01`);
    const to = String(req.query.to || today);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new HttpError(400, 'Give from and to as dates, from first');
    let cards;
    try {
      cards = await reconcileCards(db, payments, pid, from, to);
    } catch (err) {
      cards = { available: false, note: `Couldn’t reach the card processor: ${err.message}` };
    }
    res.json({
      from, to, cards,
      insurance: await reconcileInsuranceChecks(db, pid, from, to),
      claims: await reconcileClaims(db, pid, from, to),
      imports: await reconcileImports(db, pid, from, to),
    });
  });
  return r;
}
