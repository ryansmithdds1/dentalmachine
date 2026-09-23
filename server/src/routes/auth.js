import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, signToken, verifyToken, authenticate, rateLimit, HttpError, PERMISSIONS } from '../auth.js';
import { pick, requireFields, insert, audit, newToken, hashToken } from '../util.js';
import { seedPracticeDefaults } from '../defaults.js';
import { generateSecret, verifyTotp, otpauthUrl } from '../totp.js';
import { PROVIDERS, issuerFor, pkcePair, discover, exchangeCode, verifyIdToken, verifiedEmail, openSecret } from '../sso.js';

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

export default function authRoutes({ db, secret, config = {}, fetchImpl = globalThis.fetch }) {
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
    if (user?.active && user.role !== 'admin') {
      const p = await db.get('SELECT sso_only, sso_provider FROM practices WHERE id = ?', user.practice_id);
      if (p.sso_only && p.sso_provider) throw new HttpError(403, `Your practice signs in with ${PROVIDERS[p.sso_provider].name} — use the single sign-on button`, { sso_required: true });
    }
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

  // ---- Single sign-on (OpenID Connect) ----
  const redirectUri = () => `${config.appUrl}/api/auth/sso/callback`;
  const back = (res, params) => res.redirect(302, `${config.appUrl}/#${new URLSearchParams(params)}`);
  const ssoPractice = async (practiceId) => {
    const p = await db.get('SELECT * FROM practices WHERE id = ?', practiceId);
    const issuer = p && issuerFor(p);
    if (!issuer || !p.sso_client_id || !p.sso_client_secret) return null;
    return { practice: p, issuer, clientSecret: openSecret(p.sso_client_secret, secret) };
  };

  // Which button to show on the sign-in page for this email (no secrets, and the same answer for unknown emails).
  r.get('/sso/lookup', limiter, async (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    const user = email && (await db.get('SELECT practice_id FROM users WHERE lower(email) = ? AND active = 1', email));
    const p = user && (await db.get('SELECT sso_provider, sso_only FROM practices WHERE id = ?', user.practice_id));
    res.json(p?.sso_provider ? { sso: true, provider: p.sso_provider, name: PROVIDERS[p.sso_provider].name, required: !!p.sso_only } : { sso: false });
  });

  // The sign-in state is tied to this browser with a cookie, so a sign-in someone else started (login CSRF)
  // can't be finished in your browser.
  const COOKIE = 'dm_sso';
  const secure = () => String(config.appUrl || '').startsWith('https://');
  const readCookie = (req) => (String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`)) || '').slice(COOKIE.length + 1);
  const setCookie = (res, value, maxAge) => res.append('Set-Cookie', `${COOKIE}=${value}; Path=/api/auth/sso; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure() ? '; Secure' : ''}`);

  // Signed-in staff link their own identity-provider account (required for administrators).
  r.post('/sso/link', authenticate(db, secret), async (req, res) => {
    if (!(await ssoPractice(req.user.practice_id))) throw new HttpError(409, 'Single sign-on is not set up');
    const link = signToken({ sub: req.user.id, aud: 'sso-link' }, secret, 300);
    res.json({ url: `${config.appUrl}/api/auth/sso/start?${new URLSearchParams({ email: req.user.email, link })}` });
  });

  r.get('/sso/start', limiter, async (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    const user = email && (await db.get('SELECT * FROM users WHERE lower(email) = ? AND active = 1', email));
    const link = req.query.link ? verifyToken(String(req.query.link), secret) : null;
    if (req.query.link && (!link || link.aud !== 'sso-link' || link.sub !== user?.id)) return back(res, { sso_error: 'That link has expired — start again from Settings' });
    const cfg = user && (await ssoPractice(user.practice_id));
    if (!cfg) return back(res, { sso_error: 'Single sign-on is not set up for that email' });
    const oidc = await discover(cfg.issuer, fetchImpl);
    const { verifier, challenge } = pkcePair();
    const nonce = randomBytes(16).toString('base64url');
    // One-time state; the PKCE verifier and nonce stay on the server.
    const { token: state, hash } = newToken();
    const browser = newToken();
    setCookie(res, browser.token, 600);
    await insert(db, 'sso_logins', { state_hash: hash, browser_hash: browser.hash, user_id: link ? user.id : null, practice_id: cfg.practice.id, nonce, verifier, expires_at: new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 19).replace('T', ' ') });
    const url = new URL(oidc.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: 'code', client_id: cfg.practice.sso_client_id, redirect_uri: redirectUri(), scope: 'openid email profile', state, nonce,
      code_challenge: challenge, code_challenge_method: 'S256', login_hint: email, ...(cfg.practice.sso_provider === 'google' && cfg.practice.sso_domain ? { hd: cfg.practice.sso_domain } : {}),
    })) url.searchParams.set(k, v);
    res.redirect(302, url.toString());
  });

  r.get('/sso/callback', async (req, res) => {
    try {
      if (req.query.error) throw new HttpError(401, String(req.query.error_description || req.query.error));
      const login = await db.get('SELECT * FROM sso_logins WHERE state_hash = ? AND used_at IS NULL', hashToken(String(req.query.state || '')));
      if (!login || login.expires_at < new Date().toISOString().slice(0, 19).replace('T', ' ')) throw new HttpError(401, 'Sign-in link expired — please try again');
      const cookie = readCookie(req);
      if (!cookie || hashToken(cookie) !== login.browser_hash) throw new HttpError(401, 'Sign-in was started in a different browser — please try again here');
      setCookie(res, '', 0);
      if (!(await db.run("UPDATE sso_logins SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL", login.id)).changes) throw new HttpError(401, 'Sign-in link already used — please try again');
      const state = { pid: login.practice_id, nonce: login.nonce, verifier: login.verifier };
      const cfg = await ssoPractice(state.pid);
      if (!cfg) throw new HttpError(401, 'Single sign-on is not set up');
      const oidc = await discover(cfg.issuer, fetchImpl);
      const tokens = await exchangeCode({ config: oidc, code: String(req.query.code || ''), redirectUri: redirectUri(), verifier: state.verifier, clientId: cfg.practice.sso_client_id, clientSecret: cfg.clientSecret, fetchImpl });
      const claims = await verifyIdToken(tokens.id_token, { config: oidc, clientId: cfg.practice.sso_client_id, nonce: state.nonce, fetchImpl });
      const email = verifiedEmail(cfg.practice.sso_provider, claims);
      const domain = cfg.practice.sso_domain?.toLowerCase();
      if (domain && !email.endsWith(`@${domain}`) && claims.hd !== domain) throw new HttpError(403, `Only @${domain} accounts can sign in`);
      const user = await db.get('SELECT * FROM users WHERE practice_id = ? AND lower(email) = ? AND active = 1', cfg.practice.id, email);
      if (!user) throw new HttpError(403, `${email} doesn't have an account at this practice — ask your administrator to add you`);
      const subject = `${claims.iss}|${claims.sub}`;
      if (login.user_id && login.user_id !== user.id) throw new HttpError(403, `You signed in to your identity provider as ${email} — sign in there as yourself to link your account`);
      if (user.sso_subject && user.sso_subject !== subject) throw new HttpError(403, 'This account is linked to a different sign-in identity');
      // Staff are linked on first sign-in; administrators link deliberately while signed in, so an
      // identity-provider account can never take over an administrator by email alone.
      if (!user.sso_subject && user.role === 'admin' && !login.user_id) throw new HttpError(403, 'Administrators link single sign-on first: sign in with your password, then Settings → Single sign-on → Link my account');
      await db.run("UPDATE users SET sso_subject = ?, last_login_at = datetime('now') WHERE id = ?", subject, user.id);
      await audit(db, { ip: req.ip, user }, 'auth.sso_login', 'users', user.id, { provider: cfg.practice.sso_provider });
      back(res, { sso: (await session(user, secret, db)).token });
    } catch (err) {
      await audit(db, { ip: req.ip, user: null }, 'auth.sso_failed', null, null, { error: err.message }).catch(() => {});
      back(res, { sso_error: err instanceof HttpError ? err.message : 'Single sign-on failed' });
    }
  });

  r.get('/me', authenticate(db, secret, { allowMfaSetup: true }), async (req, res) => {
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    res.json({ ...(await session(req.user, secret, db)), practice: { ...practice, sso_client_secret: undefined } });
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
