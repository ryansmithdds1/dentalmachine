import { sealSecret, openSecret, sealedWithCurrent } from './sso.js';

// Re-encrypts every stored file under the current document key and re-seals stored secrets (staff 2FA
// keys, SSO client secrets) under the current JWT_SECRET. See rotatekeys.js.
export async function rotateKeys(db, { storage, secret }) {
  const out = { files: 0, filesCurrent: 0, missing: 0, failed: [], secrets: 0, secretsCurrent: 0 };
  if (storage.encrypted) {
    const places = [
      ['documents', 'storage_key', 'encrypted'],
      ['documents', 'thumb_key', 'thumb_encrypted'],
      ['unfiled_images', 'storage_key', 'encrypted'],
      ['deposit_photos', 'storage_key', 'encrypted'],
      ['intranet_attachments', 'storage_key', 'encrypted'],
      ['chat_attachments', 'storage_key', 'encrypted'],
    ];
    for (const [table, keyCol, flagCol] of places) {
      for (const row of await db.all(`SELECT id, ${keyCol} AS k, ${flagCol} AS enc FROM ${table} WHERE ${keyCol} IS NOT NULL ORDER BY id`)) {
        try {
          const result = await storage.reencrypt(row.k, !!row.enc);
          if (result === 'changed') {
            out.files++;
            if (!row.enc) await db.run(`UPDATE ${table} SET ${flagCol} = 1 WHERE id = ?`, row.id);
          } else if (result === 'current') out.filesCurrent++;
          else out.missing++;
        } catch {
          out.failed.push(`${table} #${row.id}`);
        }
      }
    }
  }
  if (secret) {
    const reseal = async (table, col, purpose) => {
      for (const row of await db.all(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`)) {
        if (!String(row.v).startsWith('v1.')) continue; // not sealed yet (older 2FA keys are sealed at sign-in)
        if (sealedWithCurrent(row.v, secret, purpose)) { out.secretsCurrent++; continue; }
        try {
          await db.run(`UPDATE ${table} SET ${col} = ? WHERE id = ?`, sealSecret(openSecret(row.v, secret, purpose), secret, purpose), row.id);
          out.secrets++;
        } catch {
          out.failed.push(`${table} #${row.id} ${col}`);
        }
      }
    };
    await reseal('users', 'mfa_secret', 'mfa');
    await reseal('practices', 'sso_client_secret', 'sso');
    await reseal('bank_connections', 'access_token', 'bank');
    await reseal('qbo_connections', 'access_token', 'qbo');
    await reseal('qbo_connections', 'refresh_token', 'qbo');
  }
  return out;
}
