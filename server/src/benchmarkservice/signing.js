// Signing between a practice and the benchmark service (BM5). Each participating practice holds an Ed25519 key
// pair it made itself when the owner joined; the service keeps only the public half. Every request is signed over
// `<unix seconds>.<exact body>`, so the service can prove who sent it and that nothing changed on the way, and it
// refuses old or replayed requests (timestamp window + one-time nonce). No shared secrets travel anywhere.
import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey, createHash, randomBytes } from 'node:crypto';

export const SKEW_SECONDS = 10 * 60; // requests older or newer than this are refused
export const HEADERS = { participant: 'x-dm-participant', timestamp: 'x-dm-timestamp', signature: 'x-dm-signature', enroll: 'x-dm-enroll' };

export function generateKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export const nonce = () => randomBytes(16).toString('hex');
export const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');

// Headers for a signed request with this exact body.
export function signedHeaders({ participantId, privateKey, body, now = Date.now() }) {
  const ts = String(Math.floor(now / 1000));
  const sig = sign(null, Buffer.from(`${ts}.${body}`), createPrivateKey(privateKey)).toString('base64');
  return { [HEADERS.participant]: participantId, [HEADERS.timestamp]: ts, [HEADERS.signature]: sig };
}

// Whether the body was signed by the holder of publicKey within the time window. Returns null when it checks out,
// else the reason (never throws on bad input: the caller answers 401 either way).
export function checkSignature({ publicKey, headers, body, now = Date.now() }) {
  const ts = headers[HEADERS.timestamp];
  const sig = headers[HEADERS.signature];
  if (!ts || !sig) return 'The request is not signed';
  if (!/^\d{9,11}$/.test(String(ts))) return 'The signature time is not valid';
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > SKEW_SECONDS) return 'The signature is too old or from the future (check the server clock)';
  try {
    const ok = verify(null, Buffer.from(`${ts}.${body}`), createPublicKey(publicKey), Buffer.from(String(sig), 'base64'));
    return ok ? null : 'The signature does not match';
  } catch {
    return 'The signature could not be checked';
  }
}

// A public key in PEM form that really is an Ed25519 key (what a practice registers when it joins).
export function validPublicKey(pem) {
  if (typeof pem !== 'string' || pem.length > 500 || !pem.includes('BEGIN PUBLIC KEY')) return false;
  try {
    return createPublicKey(pem).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}
