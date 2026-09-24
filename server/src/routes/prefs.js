import { Router } from 'express';
import { HttpError } from '../auth.js';

// Smart defaults: the values each person used last ("payment.method", "note.template@provider:3"…).
// Per user, never shared, and only a convenience: nothing important depends on them.
const KEY = /^[a-z][\w.-]{0,60}(@[\w:.-]{1,40})?$/;
const MAX = 2000;

export default function prefsRoutes({ db }) {
  const r = Router();
  r.get('/me/prefs', async (req, res) => {
    const rows = await db.all('SELECT key, value FROM user_prefs WHERE user_id = ?', req.user.id);
    const out = {};
    for (const row of rows) {
      try { out[row.key] = JSON.parse(row.value); } catch { /* an unreadable value is just forgotten */ }
    }
    res.json(out);
  });
  r.put('/me/prefs/:key', async (req, res) => {
    const key = String(req.params.key);
    if (!KEY.test(key)) throw new HttpError(400, 'Not a preference name');
    const value = JSON.stringify(req.body?.value ?? null);
    if (value.length > MAX) throw new HttpError(400, 'Too long to remember');
    const count = (await db.get('SELECT COUNT(*) AS n FROM user_prefs WHERE user_id = ?', req.user.id)).n;
    if (Number(count) >= 500) await db.run('DELETE FROM user_prefs WHERE id IN (SELECT id FROM user_prefs WHERE user_id = ? ORDER BY updated_at LIMIT 50)', req.user.id); // scratch data: oldest dropped
    await db.run(
      "INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
      req.user.id, key, value,
    );
    res.json({ ok: true });
  });
  return r;
}
