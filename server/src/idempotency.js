import { createHash, createHmac } from 'node:crypto';

// Doing the same thing twice by accident — a double click, a retried request after a dropped connection, an
// integration that resends — must not post two payments, two claims or two appointments. A change request can
// carry an Idempotency-Key (the app's own screens always send one; API clients should). The first request with
// a key does the work and its answer is kept for a day; a repeat gets that same answer back without doing the
// work again, and a repeat while the first is still running is told to wait. Reusing a key for a different
// request is refused.
const TTL_HOURS = 24;
const MAX_BODY = 256 * 1024;
const hash = (s) => createHash('sha256').update(s).digest('hex');
// Sign-in, passwords, codes and anything that hands out a token never go through here: a stored fingerprint
// of a password (even hashed) could be guessed offline, and a stored token could be replayed.
const SENSITIVE_PATH = /\/(auth|sso)\/|\/verify$|\/login$|\/mfa\b|password|\/reset/i;
const SENSITIVE_KEY = /password|passcode|^code$|otp|token|secret|pin$/i;
const hasSensitive = (body) => body && typeof body === 'object' && Object.keys(body).some((k) => SENSITIVE_KEY.test(k));
// Staff and portal sessions (JWTs) are checked here only after the session itself has been validated.
const isSession = (auth) => /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(auth || '');

// scopeOf(req): who the key belongs to. Default: the API key, else the address (public pages); signed-in
// routers pass the user and session so a revoked session can't replay an earlier answer.
export function idempotency(db, secret = 'dev', { scopeOf = null } = {}) {
  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (!key || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (SENSITIVE_PATH.test(req.originalUrl) || hasSensitive(req.body)) return next();
    if (!scopeOf && isSession(req.get('Authorization'))) return next();
    if (!/^[\w.:-]{8,120}$/.test(key)) return res.status(400).json({ error: 'Idempotency-Key must be 8-120 letters, digits, dashes, dots or colons' });
    const scope = hash(scopeOf ? scopeOf(req) : req.get('Authorization') || `ip:${req.ip}`).slice(0, 32);
    // Keyed with the server secret: the stored fingerprint says nothing about the body without it.
    const fingerprint = createHmac('sha256', `${secret}:idempotency`).update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? null)}`).digest('hex');
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
      // An answer carrying a token is never kept (it would be a live credential sitting in the table).
      const secretish = body !== null && /"(token|access_token|portal_token)"\s*:/.test(JSON.stringify(body));
      const done = res.statusCode < 500 && !secretish
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
