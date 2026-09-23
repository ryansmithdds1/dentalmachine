import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

// Stores uploaded files on disk. With a key configured, files are AES-256-GCM encrypted at rest:
// [12-byte IV][16-byte auth tag][ciphertext].
export function createStorage({ dir, key }) {
  const aesKey = key ? createHash('sha256').update(String(key)).digest() : null;
  mkdirSync(dir, { recursive: true });
  const pathFor = (storageKey) => {
    if (!/^[0-9]+\/[0-9a-f-]{36}$/.test(storageKey)) throw new Error('Invalid storage key');
    return join(dir, storageKey);
  };

  return {
    encrypted: !!aesKey,
    save(practiceId, buffer) {
      const storageKey = `${Number(practiceId)}/${randomUUID()}`;
      mkdirSync(join(dir, String(Number(practiceId))), { recursive: true });
      let data = buffer;
      if (aesKey) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
        const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
        data = Buffer.concat([iv, cipher.getAuthTag(), body]);
      }
      writeFileSync(pathFor(storageKey), data, { mode: 0o600 });
      return { storageKey, encrypted: !!aesKey };
    },
    read(storageKey, encrypted) {
      const path = pathFor(storageKey);
      if (!existsSync(path)) return null;
      const data = readFileSync(path);
      if (!encrypted) return data;
      if (!aesKey) throw new Error('File is encrypted but no DOCUMENT_ENCRYPTION_KEY is configured');
      const decipher = createDecipheriv('aes-256-gcm', aesKey, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
    },
  };
}
