import { Router } from 'express';
import { HttpError } from '../auth.js';
import { insert, audit, recorded } from '../util.js';

// The first-run checklist for a new office: practice details → providers → chairs → fees → insurance →
// messaging → go live. Each step uses the ordinary settings screens; this tracks what's done.
const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));

// Common dental payers and their usual electronic payer IDs (the clearinghouse may list others).
export const COMMON_CARRIERS = [
  ['Delta Dental', '94276'], ['MetLife', '65978'], ['Cigna Dental', '62308'], ['Aetna Dental', '60054'], ['Guardian', '64246'],
  ['UnitedHealthcare Dental', '52133'], ['Humana Dental', '73288'], ['Ameritas', '47009'], ['Principal Financial', '61271'], ['Sun Life', '80314'],
  ['United Concordia', 'CX014'], ['Blue Cross Blue Shield Dental', null],
];

export default function setupRoutes({ db, config = {} }) {
  const r = Router();

  r.get('/setup', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const p = await db.get('SELECT * FROM practices WHERE id = ?', pid);
    const count = async (sql) => Number((await db.get(sql, pid)).n);
    const providers = await db.all('SELECT id, name, type, npi FROM providers WHERE practice_id = ? AND active = 1 ORDER BY id', pid);
    const missing = ['address', 'city', 'state', 'zip', 'phone', 'npi', 'tax_id'].filter((k) => !p[k]);
    const steps = {
      practice: { done: !missing.length, missing },
      providers: { done: providers.length > 0 && providers.every((pv) => pv.npi), count: providers.length, without_npi: providers.filter((pv) => !pv.npi).map((pv) => pv.name) },
      chairs: { done: (await count('SELECT COUNT(*) AS n FROM operatories WHERE practice_id = ? AND active = 1')) > 0, count: await count('SELECT COUNT(*) AS n FROM operatories WHERE practice_id = ? AND active = 1') },
      fees: { done: !!p.setup_fees_reviewed, codes: await count('SELECT COUNT(*) AS n FROM procedure_codes WHERE practice_id = ? AND active = 1') },
      insurance: { done: (await count('SELECT COUNT(*) AS n FROM insurance_carriers WHERE practice_id = ? AND active = 1')) > 0, count: await count('SELECT COUNT(*) AS n FROM insurance_carriers WHERE practice_id = ? AND active = 1') },
      messaging: { done: !!(p.reminder_steps || p.reminder_hours > 0), reminders: !!(p.reminder_steps || p.reminder_hours > 0), texting: !!p.sms_number, booking: !!p.online_booking },
    };
    res.json({ status: p.setup_status, steps, common_carriers: COMMON_CARRIERS.map(([name, payer_id]) => ({ name, payer_id })), sandbox: config.ediMode === 'sandbox' });
  });

  // Fees: keep the starting fee list, or move every fee up or down by a percentage (rounded to the dollar).
  r.post('/setup/fees', requireAdmin, async (req, res) => {
    const pct = Number(req.body?.percent || 0);
    if (!Number.isFinite(pct) || pct < -50 || pct > 200) throw new HttpError(400, 'Choose a change between -50% and +200%');
    if (pct) {
      const codes = await db.all('SELECT id, fee FROM procedure_codes WHERE practice_id = ?', req.user.practice_id);
      await db.tx(async () => {
        for (const c of codes) await recorded(db, 'procedure_codes', c.id, () => db.run('UPDATE procedure_codes SET fee = ? WHERE id = ?', Math.round((c.fee * (100 + pct)) / 100 / 100) * 100, c.id));
      });
    }
    await db.run('UPDATE practices SET setup_fees_reviewed = 1 WHERE id = ?', req.user.practice_id);
    await audit(db, req, 'setup.fees', 'practices', req.user.practice_id, { percent: pct });
    res.json({ ok: true, percent: pct });
  });

  // Insurance: add the payers the office sees most, by name, skipping any already there.
  r.post('/setup/carriers', requireAdmin, async (req, res) => {
    const wanted = (Array.isArray(req.body?.names) ? req.body.names : []).map(String);
    const have = new Set((await db.all('SELECT lower(name) AS n FROM insurance_carriers WHERE practice_id = ?', req.user.practice_id)).map((c) => c.n));
    const added = [];
    for (const [name, payerId] of COMMON_CARRIERS) {
      if (!wanted.includes(name) || have.has(name.toLowerCase())) continue;
      await insert(db, 'insurance_carriers', { practice_id: req.user.practice_id, name, payer_id: payerId });
      added.push(name);
    }
    await audit(db, req, 'setup.carriers', 'practices', req.user.practice_id, { added });
    res.status(201).json({ added });
  });

  r.post('/setup/complete', requireAdmin, async (req, res) => {
    await db.run("UPDATE practices SET setup_status = 'done' WHERE id = ?", req.user.practice_id);
    await audit(db, req, 'setup.complete', 'practices', req.user.practice_id);
    res.json({ ok: true });
  });
  return r;
}
