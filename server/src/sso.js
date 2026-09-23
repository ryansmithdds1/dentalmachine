import { createHash, createPublicKey, createVerify, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { HttpError } from './auth.js';

// Staff single sign-on with OpenID Connect: Google Workspace, Microsoft 365 / Entra ID, Okta, or any
// standards-compliant identity provider. Authorization-code flow with PKCE; the ID token's signature
// is checked against the provider's published keys (JWKS), along with issuer, audience, expiry and nonce.
export const PROVIDERS = {
  google: { name: 'Google', issuer: () => 'https://accounts.google.com' },
  // A specific tenant is required: multi-tenant sign-in would let any Microsoft organization vouch for an email.
  microsoft: { name: 'Microsoft', issuer: (tenant) => (tenant ? `https://login.microsoftonline.com/${tenant}/v2.0` : null) },
  oidc: { name: 'Single sign-on', issuer: (_t, custom) => custom },
};

export function issuerFor(practice) {
  const p = PROVIDERS[practice.sso_provider];
  if (!p) return null;
  return String(p.issuer(practice.sso_tenant, practice.sso_issuer) || '').replace(/\/$/, '') || null;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const pkcePair = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
};

// Discovery documents and key sets are cached for an hour.
const cache = new Map();
async function cached(url, fetchImpl) {
  const hit = cache.get(url);
  if (hit && hit.until > Date.now()) return hit.value;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new HttpError(502, `Identity provider unavailable (${res.status})`);
  const value = await res.json();
  cache.set(url, { value, until: Date.now() + 3600_000 });
  return value;
}
export const discover = (issuer, fetchImpl) => cached(`${issuer}/.well-known/openid-configuration`, fetchImpl);

export async function exchangeCode({ config, code, redirectUri, verifier, clientId, clientSecret, fetchImpl }) {
  const res = await fetchImpl(config.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: verifier }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new HttpError(401, `Sign-in was not completed: ${data.error_description || data.error || res.status}`);
  return data;
}

export async function verifyIdToken(idToken, { config, clientId, nonce, fetchImpl, now = Date.now() }) {
  const [h, p, s] = String(idToken).split('.');
  if (!s) throw new HttpError(401, 'Malformed ID token');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  if (header.alg !== 'RS256') throw new HttpError(401, `Unsupported token algorithm ${header.alg}`);
  const { keys } = await cached(config.jwks_uri, fetchImpl);
  const jwk = keys.find((k) => k.kid === header.kid) || (keys.length === 1 ? keys[0] : null);
  if (!jwk) throw new HttpError(401, 'Unknown signing key');
  const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) throw new HttpError(401, 'ID token signature is invalid');
  if (claims.iss !== config.issuer) throw new HttpError(401, 'ID token issuer does not match');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new HttpError(401, 'ID token was issued for another application');
  if (!claims.exp || claims.exp * 1000 < now - 60_000) throw new HttpError(401, 'ID token has expired');
  if (claims.nonce !== nonce) throw new HttpError(401, 'Sign-in could not be verified (nonce)');
  return claims;
}

export const claimEmail = (claims) => String(claims.email || claims.preferred_username || claims.upn || '').toLowerCase();

// The client secret is stored encrypted with a key derived from the server's signing secret.
const keyFrom = (secret) => createHash('sha256').update(`sso:${secret}`).digest();
export function sealSecret(value, secret) {
  if (!value) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  return `v1.${b64url(iv)}.${b64url(c.getAuthTag())}.${b64url(body)}`;
}
export function openSecret(sealed, secret) {
  if (!sealed) return null;
  const [, iv, tag, body] = String(sealed).split('.');
  const d = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
}
