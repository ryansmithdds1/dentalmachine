// Outbound requests to addresses a practice (or its identity provider) chose — webhook endpoints, a custom
// SSO issuer — must not reach the server's own network: localhost, cloud metadata (169.254.169.254),
// private ranges. Checked when the address is saved and again before each request (DNS can change).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpError } from './auth.js';

export function isPrivateAddress(ip) {
  let a = String(ip).toLowerCase();
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) a = mapped[1];
  if (isIP(a) === 4) {
    const [x, y] = a.split('.').map(Number);
    return x === 0 || x === 10 || x === 127 || x >= 224 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254)
      || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 192 && y === 0) || (x === 198 && (y === 18 || y === 19));
  }
  if (isIP(a) === 6) return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith('::ffff:');
  return true;
}

// Returns the parsed URL, or throws a 400 saying why it can't be used. `allowLocal` (development only)
// lets a test identity provider on localhost through.
// Local addresses are only for a developer's own machine: never on a deployed copy, whatever NODE_ENV says.
export const localUrlsAllowed = (env = process.env) => env.NODE_ENV !== 'production' && !['production', 'staging', 'demo'].includes(env.APP_ENV) && !env.VERCEL;

export async function assertPublicUrl(raw, { what = 'The address', allowLocal = false, resolve = (host) => lookup(host, { all: true }) } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new HttpError(400, `${what} is not a valid URL`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = /^(localhost|127\.0\.0\.1|::1)$/.test(host);
  if (allowLocal && local) return url;
  if (url.protocol !== 'https:') throw new HttpError(400, `${what} must start with https://`);
  if (url.username || url.password) throw new HttpError(400, `${what} can't contain a username or password`);
  if (url.port && url.port !== '443') throw new HttpError(400, `${what} must use the standard https port`);
  if (local || /(^|\.)(localhost|local|internal|localdomain)$/i.test(host)) throw new HttpError(400, `${what} must be a public internet address`);
  let addresses;
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await resolve(host)).map((r) => r.address);
    } catch {
      return url; // doesn't resolve here, so the request itself will fail
    }
  }
  if (addresses.some(isPrivateAddress)) throw new HttpError(400, `${what} must be a public internet address`);
  return url;
}
