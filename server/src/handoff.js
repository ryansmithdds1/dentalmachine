import { newToken, hashToken } from './util.js';

// Handing the office tablet (or this screen) to the patient to sign a treatment plan or consent forms.
// A plan or form link normally asks for the patient's birth date, because anyone could be holding the link.
// When staff open it "on this screen", the patient is sitting right there: staff get a one-time pass that
// skips that step, but only
//   - for that one plan or packet (the purpose names it),
//   - on the same signed-in staff session that asked for it (a copied link on another device won't work),
//   - once, and within 15 minutes.
// Stored hashed in oauth_states, the app's table of one-time, browser-bound values.
export const HANDOFF_MINUTES = 15;
const KINDS = ['plan', 'forms'];
const sessionHash = (req) => hashToken(`handoff-session:${req.session_sid || `user:${req.user.id}`}`);

export async function mintHandoff(db, req, kind, id) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown handoff kind ${kind}`);
  const { token, hash } = newToken();
  await db.run(
    'INSERT INTO oauth_states (state_hash, browser_hash, purpose, user_id, practice_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    hash, sessionHash(req), `handoff:${kind}:${id}`, req.user.id, req.user.practice_id, new Date(Date.now() + HANDOFF_MINUTES * 60_000).toISOString(),
  );
  return token;
}

// { kind, id, user_id } for a good pass (and marks it used), or null.
export async function redeemHandoff(db, req, code) {
  if (!code || String(code).length > 100) return null;
  const row = await db.get('SELECT * FROM oauth_states WHERE state_hash = ?', hashToken(String(code)));
  if (!row || !String(row.purpose).startsWith('handoff:')) return null;
  if (row.used_at || row.expires_at < new Date().toISOString()) return null;
  if (Number(row.practice_id) !== Number(req.user.practice_id) || row.browser_hash !== sessionHash(req)) return null;
  // Single use, even with two tabs racing.
  if (!(await db.run("UPDATE oauth_states SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL", row.id)).changes) return null;
  const [, kind, id] = row.purpose.split(':');
  return { kind, id: Number(id), user_id: row.user_id };
}
