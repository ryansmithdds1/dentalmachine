import { randomBytes } from 'node:crypto';
import { hashToken } from './util.js';

// Connecting an outside account (QuickBooks, Google Business): the "state" handed to the provider is a
// random, single-use value kept here, tied to the browser that started it with a cookie. Without that, an
// attacker could start "connect" in their own practice and trick another office's owner into approving it,
// landing that office's books or reviews in the attacker's practice.
const COOKIE = 'dm_connect';
const readCookie = (req) => (String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`)) || '').slice(COOKIE.length + 1);

export async function startConnect(db, req, res, { purpose, appUrl }) {
  const state = randomBytes(24).toString('base64url');
  const browser = randomBytes(24).toString('base64url');
  await db.run(
    'INSERT INTO oauth_states (state_hash, browser_hash, purpose, user_id, practice_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    hashToken(state), hashToken(browser), purpose, req.user.id, req.user.practice_id, new Date(Date.now() + 15 * 60_000).toISOString(),
  );
  res.append('Set-Cookie', `${COOKIE}=${browser}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=900${String(appUrl || '').startsWith('https://') ? '; Secure' : ''}`);
  return state;
}

// The connection being finished: same browser, not used before, not expired, and the person who started it
// is still an active administrator of that practice. Returns { sub, pid } or null.
export async function finishConnect(db, req, purpose) {
  const row = await db.get('SELECT * FROM oauth_states WHERE state_hash = ? AND purpose = ?', hashToken(String(req.query.state || '')), purpose);
  if (!row || row.used_at || row.expires_at < new Date().toISOString()) return null;
  const cookie = readCookie(req);
  if (!cookie || hashToken(cookie) !== row.browser_hash) return null;
  if (!(await db.run("UPDATE oauth_states SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL", row.id)).changes) return null;
  const user = await db.get("SELECT id FROM users WHERE id = ? AND practice_id = ? AND active = 1 AND role = 'admin'", row.user_id, row.practice_id);
  return user ? { sub: row.user_id, pid: row.practice_id } : null;
}
