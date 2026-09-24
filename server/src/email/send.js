import { insert } from '../util.js';
import { isOptedOutAddress } from '../messaging.js';

// Sends one email to a member of staff (metric digests, "task assigned", "claim denied"…) through the practice's
// email adapter (SendGrid, or the log driver in development and tests — nothing leaves the building then), and
// records it in `messages`: the one sending log, whose delivery / bounce status SendGrid's event webhook fills in
// (it finds the row by the message id sent along). The adapter's outside call goes through loggedFetch, so it
// also shows in Settings → Connection activity. Never throws for a delivery failure: returns { ok, message }.
// The caller decides what a failure means (a digest raises a Needs attention item, a test send shows the error).
export async function sendStaffEmail(db, messenger, { practiceId, to, subject, html, text, kind, headers = null, createdBy = null }) {
  const blocked = (await isOptedOutAddress(db, practiceId, 'email', to)) ? 'This address unsubscribed from email or reported it as spam' : null;
  const id = await insert(db, 'messages', {
    practice_id: practiceId, patient_id: null, channel: 'email', to_address: to, subject, body: text, kind, created_by: createdBy,
    ...(blocked ? { status: 'blocked', error: blocked } : {}),
  });
  if (blocked) return { ok: false, blocked: true, error: blocked, message: await db.get('SELECT * FROM messages WHERE id = ?', id) };
  try {
    const { provider_id } = await messenger.send({ channel: 'email', to, subject, body: text, html, headers, messageId: id });
    await db.run("UPDATE messages SET status = 'sent', provider_id = ?, sent_at = datetime('now') WHERE id = ?", provider_id ?? null, id);
    return { ok: true, message: await db.get('SELECT * FROM messages WHERE id = ?', id) };
  } catch (err) {
    const error = String(err?.message || err).slice(0, 500);
    await db.run("UPDATE messages SET status = 'failed', error = ?, error_code = ? WHERE id = ?", error, err?.code ? String(err.code) : null, id);
    return { ok: false, error, message: await db.get('SELECT * FROM messages WHERE id = ?', id) };
  }
}
