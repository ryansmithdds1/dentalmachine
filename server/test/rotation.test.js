import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createStorage } from '../src/storage.js';
import { rotateKeys } from '../src/rotation.js';
import { sealMfaSecret, openMfaSecret, sealSecret, openSecret } from '../src/sso.js';
import { writeBackupFile, readBackupFile } from '../src/backup.js';

test('key rotation: old files and secrets open with the previous key, then move to the new one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-rot-'));
  const db = await openDb(':memory:');
  try {
    // Files saved under the old key, one in the pre-key-id format, one never encrypted.
    const before = createStorage({ dir, key: 'old-document-key-old-document-key' });
    const a = await before.save(1, Buffer.from('x-ray A'));
    const plainStore = createStorage({ dir });
    const b = await plainStore.save(1, Buffer.from('scan B'));
    const pid = (await db.run("INSERT INTO practices (name) VALUES ('P')")).id;
    const pat = (await db.run("INSERT INTO patients (practice_id, first_name, last_name) VALUES (?, 'J', 'D')", pid)).id;
    for (const [s, enc] of [[a, 1], [b, 0]]) await db.run("INSERT INTO documents (practice_id, patient_id, category, filename, mime, size, storage_key, encrypted) VALUES (?, ?, 'xray', 'f', 'image/png', 1, ?, ?)", pid, pat, s.storageKey, enc);

    // New key: without the old one the file can't be read; with it as previous, it can.
    const noOld = createStorage({ dir, key: 'new-document-key-new-document-key' });
    await assert.rejects(noOld.read(a.storageKey, true), /no longer has|any configured key/);
    const after = createStorage({ dir, key: 'new-document-key-new-document-key', previousKeys: ['old-document-key-old-document-key'] });
    assert.equal((await after.read(a.storageKey, true)).toString(), 'x-ray A');

    // Stored secrets sealed with the old JWT secret.
    const uid = (await db.run("INSERT INTO users (practice_id, email, name, role, password_hash) VALUES (?, 'a@x.com', 'A', 'admin', 'x')", pid)).id;
    await db.run('UPDATE users SET mfa_secret = ? WHERE id = ?', sealMfaSecret('JBSWY3DPEHPK3PXP', 'old-jwt-secret'), uid);
    await db.run('UPDATE practices SET sso_client_secret = ? WHERE id = ?', sealSecret('client-shh', 'old-jwt-secret'), pid);
    process.env.JWT_SECRET_PREVIOUS = 'old-jwt-secret';
    const stored = (await db.get('SELECT mfa_secret FROM users WHERE id = ?', uid)).mfa_secret;
    assert.equal(openMfaSecret(stored, 'new-jwt-secret'), 'JBSWY3DPEHPK3PXP');

    const r = await rotateKeys(db, { storage: after, secret: 'new-jwt-secret' });
    assert.deepEqual([r.files, r.secrets, r.failed.length], [2, 2, 0]);
    assert.equal((await rotateKeys(db, { storage: after, secret: 'new-jwt-secret' })).files, 0, 'running again changes nothing');

    // The old keys can go now.
    delete process.env.JWT_SECRET_PREVIOUS;
    assert.equal((await noOld.read(a.storageKey, true)).toString(), 'x-ray A');
    assert.equal((await db.get('SELECT encrypted FROM documents WHERE storage_key = ?', b.storageKey)).encrypted, 1);
    assert.equal((await noOld.read(b.storageKey, true)).toString(), 'scan B');
    assert.ok(!readFileSync(join(dir, b.storageKey)).includes('scan B'), 'the plain file is encrypted now');
    assert.equal(openMfaSecret((await db.get('SELECT mfa_secret FROM users WHERE id = ?', uid)).mfa_secret, 'new-jwt-secret'), 'JBSWY3DPEHPK3PXP');
    assert.equal(openSecret((await db.get('SELECT sso_client_secret FROM practices WHERE id = ?', pid)).sso_client_secret, 'new-jwt-secret'), 'client-shh');

    // Backups made with the old backup key restore with it listed as a previous key.
    const file = join(dir, 'b.json.gz.enc');
    await writeBackupFile(file, (async function* () { yield '{"ok":true}'; })(), 'old-backup-key-old-backup-key-old');
    assert.throws(() => readBackupFile(readFileSync(file), 'new-backup-key-new-backup-key-new'), /could not be decrypted/);
    assert.equal(readBackupFile(readFileSync(file), ['new-backup-key-new-backup-key-new', 'old-backup-key-old-backup-key-old']), '{"ok":true}');
    assert.ok(readdirSync(dir).length);
  } finally {
    delete process.env.JWT_SECRET_PREVIOUS;
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
