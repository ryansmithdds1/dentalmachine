import { mkdirSync, existsSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes, createHash, createHmac } from 'node:crypto';

// Stores uploaded files on local disk, or in S3-compatible object storage (AWS S3, Cloudflare R2,
// Backblaze B2, MinIO…) so several servers can share them. With a key configured, files are
// AES-256-GCM encrypted before they leave the server:
//   "DMK2" [8-byte key id][12-byte IV][16-byte auth tag][ciphertext]
// (files written before key ids have no header: [IV][tag][ciphertext]). The key id says which key sealed
// the file, so after a key change the old keys (`previousKeys`, from DOCUMENT_ENCRYPTION_KEY_PREVIOUS)
// still open old files until `npm run rotate-keys` has re-encrypted them.
const MAGIC = Buffer.from('DMK2');
const keyOf = (k) => {
  const aes = createHash('sha256').update(String(k)).digest();
  return { aes, id: createHash('sha256').update(aes).digest().subarray(0, 8) };
};
export function createStorage({ dir, key, previousKeys = [], s3 = s3FromEnv(), fetchImpl = globalThis.fetch }) {
  const current = key ? keyOf(key) : null;
  const aesKey = current?.aes ?? null;
  const ring = [current, ...previousKeys.filter(Boolean).map(keyOf)].filter(Boolean);
  const open = (k, iv, tag, body) => {
    const decipher = createDecipheriv('aes-256-gcm', k.aes, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  };
  const decrypt = (data) => {
    if (!ring.length) throw new Error('File is encrypted but no DOCUMENT_ENCRYPTION_KEY is configured');
    if (data.subarray(0, 4).equals(MAGIC)) {
      const k = ring.find((x) => x.id.equals(data.subarray(4, 12)));
      if (!k) throw new Error('File was encrypted with a key this server no longer has (add it to DOCUMENT_ENCRYPTION_KEY_PREVIOUS)');
      return { data: open(k, data.subarray(12, 24), data.subarray(24, 40), data.subarray(40)), current: k === current };
    }
    for (const k of ring) {
      try {
        return { data: open(k, data.subarray(0, 12), data.subarray(12, 28), data.subarray(28)), current: false };
      } catch { /* try the next key */ }
    }
    throw new Error('File could not be decrypted with any configured key');
  };
  const encrypt = (buffer) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return Buffer.concat([MAGIC, current.id, iv, cipher.getAuthTag(), body]);
  };
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
      await backend.put(checkKey(storageKey), aesKey ? encrypt(buffer) : buffer);
      return { storageKey, encrypted: !!aesKey };
    },
    async read(storageKey, encrypted) {
      const data = await backend.get(checkKey(storageKey));
      if (!data || !encrypted) return data;
      return decrypt(data).data;
    },
    // Key rotation: rewrites one file in place under the current key (encrypting it if it wasn't).
    // Returns 'changed', 'current' (already under the current key, left alone) or 'missing'.
    async reencrypt(storageKey, encrypted) {
      if (!aesKey) throw new Error('Set DOCUMENT_ENCRYPTION_KEY first');
      const data = await backend.get(checkKey(storageKey));
      if (!data) return 'missing';
      let plain = data;
      if (encrypted) {
        const out = decrypt(data);
        if (out.current) return 'current';
        plain = out.data;
      }
      await backend.put(storageKey, encrypt(plain));
      return 'changed';
    },
    // Deletes a stored file. Only for source files whose retention has ended (e.g. exam recordings after the
    // practice's retention period); records that matter are never removed this way. Missing files are fine.
    async remove(storageKey) {
      await backend.remove(checkKey(storageKey));
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
    async remove(storageKey) {
      await unlink(join(dir, storageKey)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
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
    async remove(storageKey) {
      const res = await request('DELETE', storageKey);
      if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed (${res.status})`);
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
