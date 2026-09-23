import { Router } from 'express';
import { hashPassword, verifyPassword, signToken, authenticate, rateLimit, HttpError, PERMISSIONS } from '../auth.js';
import { pick, requireFields, insert, audit } from '../util.js';
import { seedPracticeDefaults } from '../defaults.js';
import { generateSecret, verifyTotp, otpauthUrl } from '../totp.js';

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) {
    throw new HttpError(400, 'Password must be at least 10 characters');
  }
}

async function session(user, secret, db) {
  const { id, practice_id, email, name, role } = user;
  const mfaEnabled = !!(await db.get('SELECT mfa_enabled FROM users WHERE id = ?', id))?.mfa_enabled;
  const requireMfa = !!(await db.get('SELECT require_mfa FROM practices WHERE id = ?', practice_id))?.require_mfa;
  return {
    token: signToken({ sub: id, pid: practice_id, role, aud: 'staff' }, secret),
    user: {
      id, practice_id, email, name, role, permissions: role === 'admin' ? ['*'] : PERMISSIONS[role] || [],
      mfa_enabled: mfaEnabled, mfa_setup_required: requireMfa && !mfaEnabled,
    },
  };
}

export default function authRoutes({ db, secret }) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

  // Creates a new practice (tenant) along with its first admin user.
  r.post('/register', limiter, async (req, res) => {
    const body = pick(req.body, ['practice_name', 'name', 'email', 'password', 'phone', 'timezone']);
    requireFields(body, ['practice_name', 'name', 'email', 'password']);
    validatePassword(req.body.password);
    if (await db.get('SELECT id FROM users WHERE lower(email) = lower(?)', body.email)) throw new HttpError(409, 'Email already registered');

    const user = await db.tx(async () => {
      const practiceId = await insert(db, 'practices', {
        name: body.practice_name, phone: body.phone ?? null, email: body.email, timezone: body.timezone || 'America/New_York',
      });
      const userId = await insert(db, 'users', {
        practice_id: practiceId, email: body.email, name: body.name, role: 'admin', password_hash: hashPassword(req.body.password),
      });
      await seedPracticeDefaults(db, practiceId);
      return await db.get('SELECT * FROM users WHERE id = ?', userId);
    });
    req.user = user;
    await audit(db, req, 'practice.register', 'practices', user.practice_id);
    res.status(201).json(await session(user, secret, db));
  });

  r.post('/login', limiter, async (req, res) => {
    const { email, password } = req.body || {};
    const user = email && (await db.get('SELECT * FROM users WHERE lower(email) = lower(?)', String(email).trim()));
    if (!user || !user.active || !verifyPassword(String(password || ''), user.password_hash)) {
      await audit(db, { ip: req.ip, user: user ? { id: user.id, practice_id: user.practice_id } : null }, 'auth.login_failed', 'users', user?.id, { email });
      throw new HttpError(401, 'Invalid email or password');
    }
    if (user.mfa_enabled) {
      if (!req.body.mfa_code) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app', { mfa_required: true });
      const step = verifyTotp(user.mfa_secret, req.body.mfa_code, { lastStep: user.mfa_last_step });
      if (step == null) {
        await audit(db, { ip: req.ip, user: { id: user.id, practice_id: user.practice_id } }, 'auth.mfa_failed', 'users', user.id);
        throw new HttpError(401, 'Invalid authentication code', { mfa_required: true });
      }
      await db.run('UPDATE users SET mfa_last_step = ? WHERE id = ?', step, user.id);
    }
    await db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", user.id);
    req.user = user;
    await audit(db, req, 'auth.login', 'users', user.id);
    res.json(await session(user, secret, db));
  });

  r.get('/me', authenticate(db, secret, { allowMfaSetup: true }), async (req, res) => {
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    res.json({ ...(await session(req.user, secret, db)), practice });
  });

  r.post('/change-password', authenticate(db, secret, { allowMfaSetup: true }), async (req, res) => {
    const { current_password, new_password } = req.body || {};
    const row = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(String(current_password || ''), row.password_hash)) throw new HttpError(400, 'Current password is incorrect');
    validatePassword(new_password);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(new_password), req.user.id);
    await audit(db, req, 'auth.password_changed', 'users', req.user.id);
    res.json({ ok: true });
  });

  // ---- Two-factor authentication (TOTP) ----
  const authed = authenticate(db, secret, { allowMfaSetup: true });

  r.post('/mfa/setup', authed, async (req, res) => {
    const row = await db.get('SELECT mfa_enabled FROM users WHERE id = ?', req.user.id);
    if (row.mfa_enabled) throw new HttpError(409, 'Two-factor authentication is already enabled');
    const mfaSecret = generateSecret();
    await db.run('UPDATE users SET mfa_secret = ? WHERE id = ?', mfaSecret, req.user.id);
    res.json({ secret: mfaSecret, otpauth_url: otpauthUrl(mfaSecret, req.user.email) });
  });

  r.post('/mfa/enable', authed, async (req, res) => {
    const row = await db.get('SELECT mfa_secret, mfa_enabled FROM users WHERE id = ?', req.user.id);
    if (!row.mfa_secret) throw new HttpError(400, 'Start setup first');
    const step = verifyTotp(row.mfa_secret, req.body?.code);
    if (step == null) throw new HttpError(400, 'That code did not match. Check your phone clock and try again.');
    await db.run('UPDATE users SET mfa_enabled = 1, mfa_last_step = ? WHERE id = ?', step, req.user.id);
    await audit(db, req, 'auth.mfa_enabled', 'users', req.user.id);
    res.json(await session(req.user, secret, db));
  });

  r.post('/mfa/disable', authed, async (req, res) => {
    const row = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(String(req.body?.password || ''), row.password_hash)) throw new HttpError(400, 'Password is incorrect');
    const practice = await db.get('SELECT require_mfa FROM practices WHERE id = ?', req.user.practice_id);
    if (practice.require_mfa) throw new HttpError(409, 'Your practice requires two-factor authentication');
    await db.run('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_last_step = NULL WHERE id = ?', req.user.id);
    await audit(db, req, 'auth.mfa_disabled', 'users', req.user.id);
    res.json({ ok: true });
  });

  return r;
}
