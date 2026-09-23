import { Router } from 'express';
import { hashPassword, verifyPassword, signToken, authenticate, rateLimit, HttpError, PERMISSIONS } from '../auth.js';
import { pick, requireFields, insert, audit } from '../util.js';
import { seedPracticeDefaults } from '../defaults.js';

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) {
    throw new HttpError(400, 'Password must be at least 10 characters');
  }
}

function session(user, secret) {
  const { id, practice_id, email, name, role } = user;
  return {
    token: signToken({ sub: id, pid: practice_id, role }, secret),
    user: { id, practice_id, email, name, role, permissions: role === 'admin' ? ['*'] : PERMISSIONS[role] || [] },
  };
}

export default function authRoutes({ db, secret }) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

  // Creates a new practice (tenant) along with its first admin user.
  r.post('/register', limiter, (req, res) => {
    const body = pick(req.body, ['practice_name', 'name', 'email', 'password', 'phone', 'timezone']);
    requireFields(body, ['practice_name', 'name', 'email', 'password']);
    validatePassword(req.body.password);
    if (db.get('SELECT id FROM users WHERE email = ?', body.email)) throw new HttpError(409, 'Email already registered');

    const user = db.tx(() => {
      const practiceId = insert(db, 'practices', {
        name: body.practice_name, phone: body.phone ?? null, email: body.email, timezone: body.timezone || 'America/New_York',
      });
      const userId = insert(db, 'users', {
        practice_id: practiceId, email: body.email, name: body.name, role: 'admin', password_hash: hashPassword(req.body.password),
      });
      seedPracticeDefaults(db, practiceId);
      return db.get('SELECT * FROM users WHERE id = ?', userId);
    });
    req.user = user;
    audit(db, req, 'practice.register', 'practices', user.practice_id);
    res.status(201).json(session(user, secret));
  });

  r.post('/login', limiter, (req, res) => {
    const { email, password } = req.body || {};
    const user = email && db.get('SELECT * FROM users WHERE email = ?', String(email).trim());
    if (!user || !user.active || !verifyPassword(String(password || ''), user.password_hash)) {
      audit(db, { ip: req.ip, user: user ? { id: user.id, practice_id: user.practice_id } : null }, 'auth.login_failed', 'users', user?.id, { email });
      throw new HttpError(401, 'Invalid email or password');
    }
    db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", user.id);
    req.user = user;
    audit(db, req, 'auth.login', 'users', user.id);
    res.json(session(user, secret));
  });

  r.get('/me', authenticate(db, secret), (req, res) => {
    const practice = db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    res.json({ ...session(req.user, secret), practice });
  });

  r.post('/change-password', authenticate(db, secret), (req, res) => {
    const { current_password, new_password } = req.body || {};
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(String(current_password || ''), row.password_hash)) throw new HttpError(400, 'Current password is incorrect');
    validatePassword(new_password);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(new_password), req.user.id);
    audit(db, req, 'auth.password_changed', 'users', req.user.id);
    res.json({ ok: true });
  });

  return r;
}
