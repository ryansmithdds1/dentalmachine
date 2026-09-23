import { createHash } from 'node:crypto';

// Doing the same thing twice by accident — a double click, a retried request after a dropped connection, an
// integration that resends — must not post two payments, two claims or two appointments. A change request can
// carry an Idempotency-Key (the app's own screens always send one; API clients should). The first request with
// a key does the work and its answer is kept for a day; a repeat gets that same answer back without doing the
// work again, and a repeat while the first is still running is told to wait. Reusing a key for a different
// request is refused.
const TTL_HOURS = 24;
const MAX_BODY = 256 * 1024;
const hash = (s) => createHash('sha256').update(s).digest('hex');

export function idempotency(db) {
  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (!key || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (!/^[\w.:-]{8,120}$/.test(key)) return res.status(400).json({ error: 'Idempotency-Key must be 8-120 letters, digits, dashes, dots or colons' });
    // Keys belong to whoever sent them: the signed-in session or API key, else the address (public pages).
    const scope = hash(req.get('Authorization') || `ip:${req.ip}`).slice(0, 32);
    const fingerprint = hash(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? null)}`);
    try {
      await db.run('INSERT INTO idempotency_keys (scope, key, fingerprint, status) VALUES (?, ?, ?, ?)', scope, key, fingerprint, 'running');
    } catch (err) {
      if (!/unique|duplicate/i.test(String(err.message)) && err.code !== '23505') return next(err);
      const seen = await db.get('SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?', scope, key);
      if (!seen) return next();
      if (seen.fingerprint !== fingerprint) return res.status(422).json({ error: 'This Idempotency-Key was already used for a different request' });
      if (seen.status === 'running') return res.status(409).json({ error: 'The same request is already being processed — wait a moment and check before trying again' });
      res.set('Idempotent-Replay', 'true');
      return res.status(seen.response_status).type('application/json').send(seen.response_body ?? '{}');
    }
    // Keep the answer once it's known; a failure the client should retry (a server error) frees the key.
    let body = null;
    const json = res.json.bind(res);
    res.json = (data) => {
      body = data;
      return json(data);
    };
    res.on('finish', () => {
      const done = res.statusCode < 500
        ? db.run("UPDATE idempotency_keys SET status = 'done', response_status = ?, response_body = ? WHERE scope = ? AND key = ?",
          res.statusCode, body === null ? null : (JSON.stringify(body).length <= MAX_BODY ? JSON.stringify(body) : null), scope, key)
        : db.run('DELETE FROM idempotency_keys WHERE scope = ? AND key = ?', scope, key);
      done.catch((err) => console.error('Idempotency record failed:', err.message));
    });
    next();
  };
}

// Kept answers are only needed for a day (they can hold patient details, so they don't linger).
export const purgeIdempotencyKeys = (db) => db.run('DELETE FROM idempotency_keys WHERE created_at < ?', new Date(Date.now() - TTL_HOURS * 3600_000).toISOString().slice(0, 19).replace('T', ' '));
