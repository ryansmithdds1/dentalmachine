import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import { harness } from './helpers.js';
import { signToken } from '../src/auth.js';
import { verifiedEmail } from '../src/sso.js';

const signPortal = () => signToken({ sub: 1, pid: 1, aud: 'portal' }, 'test-secret');
const unscoped = () => signToken({ sub: 1, pid: 1 }, 'test-secret');

const h = harness();

// A minimal OpenID Connect provider: discovery, JWKS, authorize (auto-approves as `loginAs`) and token (checks PKCE).
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
let idp;
let base;
const idpState = { loginAs: null, pending: new Map(), tamper: false, emailVerified: true };
const sign = (claims) => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc(claims)}`;
  let sig = createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url');
  if (idpState.tamper) sig = `${sig.slice(0, -4)}AAAA`;
  return `${data}.${sig}`;
};
before(async () => {
  idp = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const json = (o, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/.well-known/openid-configuration') return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks` });
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      const p = Object.fromEntries(url.searchParams);
      const code = `code-${Math.random()}`;
      idpState.pending.set(code, p);
      res.writeHead(302, { Location: `${p.redirect_uri}?code=${code}&state=${encodeURIComponent(p.state)}` });
      return res.end();
    }
    if (url.pathname === '/token') {
      let body = '';
      for await (const c of req) body += c;
      const f = Object.fromEntries(new URLSearchParams(body));
      const p = idpState.pending.get(f.code);
      const challenge = createHash('sha256').update(f.code_verifier || '').digest('base64url');
      if (!p || challenge !== p.code_challenge || f.client_secret !== 'shh' || f.client_id !== 'dm-client') return json({ error: 'invalid_grant' }, 400);
      return json({ id_token: sign({ iss: base, aud: 'dm-client', sub: `user-${idpState.loginAs}`, email: idpState.loginAs, email_verified: idpState.emailVerified, nonce: p.nonce, exp: Math.floor(Date.now() / 1000) + 300 }) });
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => idp.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${idp.address().port}`;
});
after(() => idp.close());

// Follows the browser redirects: app → IdP → app callback → app with #sso=… or #sso_error=…
async function ssoLogin(email, { as = email, link = null, browser = true } = {}) {
  idpState.loginAs = as;
  let res = await fetch(link ? link.replace('https://app.example.com', h.origin) : `${h.origin}/api/auth/sso/start?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  let location = res.headers.get('location');
  if (location.startsWith('https://app.example.com/#')) return new URLSearchParams(location.split('#')[1]);
  res = await fetch(location, { redirect: 'manual' });
  location = res.headers.get('location').replace('https://app.example.com', h.origin);
  res = await fetch(location, { redirect: 'manual', headers: browser ? { Cookie: cookie } : {} });
  return new URLSearchParams(res.headers.get('location').split('#')[1]);
}

test('staff single sign-on with OpenID Connect (PKCE, signed ID token, SSO-only mode)', async () => {
  const { api, email } = await h.practice();
  const staff = (await api.post('/users', { email: `desk-${Date.now()}@example.com`, name: 'Desk', role: 'front_desk', password: 'correct-horse-battery' })).data;
  assert.equal((await api.put('/practice/sso', { provider: 'oidc', issuer: 'ftp://nope', client_id: 'x', client_secret: 'y' })).status, 400);
  const saved = (await api.put('/practice/sso', { provider: 'oidc', issuer: base, client_id: 'dm-client', client_secret: 'shh', domain: 'example.com' })).data;
  assert.equal(saved.has_secret, true);
  assert.equal(saved.client_secret, undefined);
  assert.match(saved.redirect_uri, /\/api\/auth\/sso\/callback$/);
  assert.equal((await api.get('/practice')).data.sso_client_secret, undefined, 'secret never leaves the server');
  assert.deepEqual((await h.client().get(`/auth/sso/lookup?email=${staff.email}`)).data, { sso: true, provider: 'oidc', name: 'Single sign-on', required: false });

  const ok = await ssoLogin(staff.email);
  assert.ok(ok.get('sso'), ok.get('sso_error'));
  const me = (await h.client(ok.get('sso')).get('/auth/me')).data;
  assert.equal(me.user.email, staff.email);

  // Unknown user, tampered signature and unverified email are all refused.
  assert.match((await ssoLogin('stranger@example.com')).get('sso_error'), /Single sign-on is not set up|doesn't have an account/);
  idpState.tamper = true;
  assert.match((await ssoLogin(staff.email)).get('sso_error'), /signature/);
  idpState.tamper = false;
  idpState.emailVerified = false;
  assert.match((await ssoLogin(staff.email)).get('sso_error'), /not verified/);
  idpState.emailVerified = true;
  // A sign-in finished in a different browser from the one that started it (login CSRF) is refused.
  assert.match((await ssoLogin(staff.email, { browser: false })).get('sso_error'), /different browser/);

  // Administrators aren't linked by email alone; they link while signed in with their password.
  assert.match((await ssoLogin(email)).get('sso_error'), /Administrators link single sign-on first/);
  assert.equal((await api.get('/practice/sso')).data.linked, false);
  const { url } = (await api.post('/auth/sso/link')).data;
  assert.match((await ssoLogin(email, { link: url, as: staff.email })).get('sso_error'), /sign in there as yourself/);
  const linked = await ssoLogin(email, { link: (await api.post('/auth/sso/link')).data.url });
  assert.ok(linked.get('sso'), linked.get('sso_error'));
  assert.equal((await api.get('/practice/sso')).data.linked, true);
  assert.ok((await ssoLogin(email)).get('sso'), 'linked admin signs in with SSO');
  // A portal (patient) token is never accepted by staff routes.
  assert.equal((await h.client(signPortal()).get('/patients')).status, 401);

  // SSO-only: staff can't use passwords any more; admins still can (so nobody is locked out).
  await api.put('/practice/sso', { provider: 'oidc', issuer: base, client_id: 'dm-client', domain: 'example.com', sso_only: true });
  const pw = await h.client().post('/auth/login', { email: staff.email, password: 'correct-horse-battery' });
  assert.equal(pw.status, 403);
  assert.ok(pw.data.details.sso_required);
  assert.equal((await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).status, 200);
});

test('only verified emails are trusted from identity providers', () => {
  assert.equal(verifiedEmail('google', { email: 'A@x.com', email_verified: true }), 'a@x.com');
  assert.throws(() => verifiedEmail('oidc', { email: 'a@x.com' }), /not verified/);
  assert.throws(() => verifiedEmail('google', { email: 'a@x.com', email_verified: false }), /not verified/);
  // Microsoft: the email claim only with a verified domain; otherwise the tenant-managed UPN.
  assert.equal(verifiedEmail('microsoft', { email: 'boss@other.com', upn: 'ann@clinic.com' }), 'ann@clinic.com');
  assert.equal(verifiedEmail('microsoft', { email: 'ann@clinic.com', xms_edov: true }), 'ann@clinic.com');
  assert.throws(() => verifiedEmail('microsoft', { email: 'x@y.com' }), /no verified email/);
});

test('staff routes need a staff token', async () => {
  const res = await fetch(`${h.origin}/api/patients`, { headers: { Authorization: `Bearer ${unscoped()}` } });
  assert.equal(res.status, 401);
});
