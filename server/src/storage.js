import { mkdirSync, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes, createHash, createHmac } from 'node:crypto';

// Stores uploaded files on local disk, or in S3-compatible object storage (AWS S3, Cloudflare R2,
// Backblaze B2, MinIO…) so several servers can share them. With a key configured, files are
// AES-256-GCM encrypted before they leave the server: [12-byte IV][16-byte auth tag][ciphertext].
export function createStorage({ dir, key, s3 = s3FromEnv(), fetchImpl = globalThis.fetch }) {
  const aesKey = key ? createHash('sha256').update(String(key)).digest() : null;
  const backend = s3 ? s3Backend(s3, fetchImpl) : diskBackend(dir);
  const checkKey = (storageKey) => {
    if (!/^[0-9]+\/[0-9a-f-]{36}$/.test(storageKey)) throw new Error('Invalid storage key');
    return storageKey;
  };
  return {
    encrypted: !!aesKey,
    driver: s3 ? 's3' : 'disk',
    async save(practiceId, buffer) {
      const storageKey = `${Number(practiceId)}/${randomUUID()}`;
      let data = buffer;
      if (aesKey) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
        const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
        data = Buffer.concat([iv, cipher.getAuthTag(), body]);
      }
      await backend.put(checkKey(storageKey), data);
      return { storageKey, encrypted: !!aesKey };
    },
    async read(storageKey, encrypted) {
      const data = await backend.get(checkKey(storageKey));
      if (!data || !encrypted) return data;
      if (!aesKey) throw new Error('File is encrypted but no DOCUMENT_ENCRYPTION_KEY is configured');
      const decipher = createDecipheriv('aes-256-gcm', aesKey, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
    },
  };
}

function diskBackend(dir) {
  mkdirSync(dir, { recursive: true });
  return {
    async put(storageKey, data) {
      mkdirSync(join(dir, storageKey.split('/')[0]), { recursive: true });
      await writeFile(join(dir, storageKey), data, { mode: 0o600 });
    },
    async get(storageKey) {
      const path = join(dir, storageKey);
      return existsSync(path) ? readFile(path) : null;
    },
  };
}

export function s3FromEnv(env = process.env) {
  if (!env.S3_BUCKET) return null;
  return {
    bucket: env.S3_BUCKET,
    region: env.S3_REGION || 'us-east-1',
    endpoint: env.S3_ENDPOINT || null, // e.g. https://<account>.r2.cloudflarestorage.com
    accessKeyId: env.S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY,
    prefix: env.S3_PREFIX || 'documents/',
  };
}

function s3Backend(cfg, fetchImpl) {
  const base = cfg.endpoint ? `${cfg.endpoint.replace(/\/$/, '')}/${cfg.bucket}` : `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
  const request = async (method, storageKey, body) => {
    const url = new URL(`${base}/${cfg.prefix}${storageKey}`);
    const headers = signV4({ method, url, body: body || Buffer.alloc(0), region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
      headers: body ? { 'content-type': 'application/octet-stream', 'x-amz-server-side-encryption': 'AES256' } : {} });
    return fetchImpl(url, { method, headers, body });
  };
  return {
    async put(storageKey, data) {
      const res = await request('PUT', storageKey, data);
      if (!res.ok) throw new Error(`S3 upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    },
    async get(storageKey) {
      const res = await request('GET', storageKey);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S3 download failed (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

// AWS Signature Version 4 for a single S3 request. Returns the headers to send.
const sha256 = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
export function signV4({ method, url, body = Buffer.alloc(0), region, accessKeyId, secretAccessKey, headers = {}, now = new Date(), service = 's3', payloadHash }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const hashed = payloadHash || sha256(body);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: url.host, 'x-amz-content-sha256': hashed, 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const canonicalQuery = [...url.searchParams].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]).sort().map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalPath = url.pathname.split('/').map((s) => encodeURIComponent(decodeURIComponent(s))).join('/');
  const canonical = [method, canonicalPath, canonicalQuery, ...names.map((k) => `${k}:${all[k]}`), '', names.join(';'), hashed].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  const { host, ...rest } = all;
  return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}
