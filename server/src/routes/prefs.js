import { Router } from 'express';
import { HttpError } from '../auth.js';
import { audit } from '../util.js';

// Smart defaults: the values each person used last ("payment.method", "note.template@provider:3"…).
// Per user, never shared, and only a convenience: nothing important depends on them.
const KEY = /^[a-z][\w.-]{0,60}(@[\w:.-]{1,40})?$/;
const MAX = 2000;
// Pinned sidebar pages (up to 3): saved through their own route below, which checks them and records the change.
const PINS_KEY = 'nav.pins';
const MAX_PINS = 3;
const PAGE = /^\/[a-z0-9-]{0,40}$/;

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
    if (key === PINS_KEY) throw new HttpError(400, 'Pinned pages are saved with PUT /me/nav-pins');
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

  // The pages this person pinned to the top of the sidebar. Only a convenience, but a person's own setup
  // changing is recorded like their card layout (who, when, before → after).
  r.put('/me/nav-pins', async (req, res) => {
    const pins = req.body?.pins;
    if (!Array.isArray(pins)) throw new HttpError(400, 'Send the pinned pages as a list');
    if (pins.length > MAX_PINS) throw new HttpError(400, `Pin up to ${MAX_PINS} pages`);
    if (!pins.every((p) => typeof p === 'string' && PAGE.test(p))) throw new HttpError(400, 'Not a page that can be pinned');
    if (new Set(pins).size !== pins.length) throw new HttpError(400, 'That page is already pinned');
    const row = await db.get('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?', req.user.id, PINS_KEY);
    let before = [];
    try { before = row ? JSON.parse(row.value) : []; } catch { /* unreadable: treated as none */ }
    if (JSON.stringify(before) !== JSON.stringify(pins)) {
      await db.run(
        "INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        req.user.id, PINS_KEY, JSON.stringify(pins),
      );
      await audit(db, req, 'nav.pins', 'users', req.user.id, { pins: pins.length }, { before: { pins: before.join(', ') }, after: { pins: pins.join(', ') } });
    }
    res.json({ pins });
  });
  return r;
}
