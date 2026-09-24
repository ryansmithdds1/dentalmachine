import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './helpers.js';
import { seedDemo, DEMO_EMAIL } from '../src/demo.js';
import { exportToObject, restorePractice, runAutomaticBackups, backupTables, isEncryptedBackup, readBackupFile, runRestoreDrills } from '../src/backup.js';
import { productionProblems } from '../src/preflight.js';

const h = harness();

// Everything a practice owns, summarized so an original and its restored copy can be compared.
async function fingerprint(db, pid) {
  const patients = await db.all(
    `SELECT p.first_name, p.last_name, p.dob,
       (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries l WHERE l.patient_id = p.id) AS balance,
       (SELECT COUNT(*) FROM procedures x WHERE x.patient_id = p.id) AS procs,
       (SELECT COUNT(*) FROM appointments x WHERE x.patient_id = p.id) AS appts,
       (SELECT COUNT(*) FROM claims x WHERE x.patient_id = p.id) AS claims,
       g.first_name AS guarantor
     FROM patients p LEFT JOIN patients g ON g.id = p.guarantor_id WHERE p.practice_id = ? ORDER BY p.last_name, p.first_name, p.dob`, pid,
  );
  const claimItems = (await db.get('SELECT COUNT(*) AS n FROM claim_items ci JOIN claims c ON c.id = ci.claim_id WHERE c.practice_id = ?', pid)).n;
  // IDs from outside services (Twilio message IDs) are kept as they are.
  const messageIds = (await db.all('SELECT provider_id FROM messages WHERE practice_id = ? AND provider_id IS NOT NULL ORDER BY provider_id', pid)).map((m) => m.provider_id);
  return { patients, claimItems, messageIds };
}

test('a full practice backs up and restores as a copy with every link intact', async () => {
  await seedDemo(h.db);
  const pid = (await h.db.get('SELECT practice_id FROM users WHERE lower(email) = lower(?)', DEMO_EMAIL)).practice_id;
  const backup = await exportToObject(h.db, pid, {});
  assert.equal(backup.format, 'dentalmachine-backup');
  assert.ok(backup.tables.patients.length > 20);
  assert.ok(backup.tables.ledger_entries.length > 20);
  assert.ok(!('portal_codes' in backup.tables));

  const result = await restorePractice(h.db, backup, { copy: true });
  assert.ok(result.practice_id && result.practice_id !== pid);
  for (const [table, rows] of Object.entries(backup.tables)) assert.equal(result.counts[table] || 0, rows.length, table);

  const [a, b] = [await fingerprint(h.db, pid), await fingerprint(h.db, result.practice_id)];
  assert.deepEqual(b, a);
  assert.ok(a.patients.some((p) => p.guarantor));
  // Nothing in the copy points back at the original practice's rows.
  for (const { table, cols } of backupTables()) {
    if (!cols.some((c) => c.name === 'practice_id') || table === 'practices') continue;
    for (const c of cols.filter((x) => x.ref && x.ref !== 'practices' && backupTables().some((t) => t.table === x.ref && t.cols.some((y) => y.name === 'practice_id')))) {
      const stray = await h.db.get(
        `SELECT COUNT(*) AS n FROM ${table} t JOIN ${c.ref} r ON r.id = t.${c.name} WHERE t.practice_id = ? AND r.practice_id != ?`, result.practice_id, result.practice_id,
      );
      assert.equal(stray.n, 0, `${table}.${c.name}`);
    }
  }
  // The copy's staff can't collide with the original logins.
  const users = await h.db.all('SELECT email FROM users WHERE practice_id = ?', result.practice_id);
  assert.ok(users.every((u) => /\+restored/.test(u.email)));
  // Restoring onto the same server without --copy is refused, not half-done.
  await assert.rejects(restorePractice(h.db, backup), (err) => err.status === 409);
});

test('backup download, test restore, and document files', async () => {
  const { api, patient, token } = await h.practice();
  const up = await fetch(`${h.origin}/api/patients/${patient.id}/documents?filename=note.txt`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'scanned-letter-text',
  });
  assert.ok([200, 201].includes(up.status), await up.text());

  const res = await fetch(`${h.origin}/api/backup?documents=true`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /dental-machine-backup-.*\.json\.gz/);
  const backup = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'));
  assert.equal(backup.tables.patients.length, 1);
  assert.equal(Object.keys(backup.documents).length, 1);

  const check = await api.post('/backup/test');
  assert.equal(check.status, 200, JSON.stringify(check.data));
  assert.equal(check.data.ok, true);
  assert.ok(check.data.tables.find((t) => t.table === 'patients').restored === 1);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM practices WHERE name LIKE '%(restored copy)'")).n, 1); // only the first test's copy

  const storage = h.app.locals.storage;
  const restored = await restorePractice(h.db, backup, { copy: true, storage });
  const doc = await h.db.get('SELECT * FROM documents WHERE practice_id = ?', restored.practice_id);
  assert.ok(doc.storage_key.startsWith(`${restored.practice_id}/`));
  assert.equal((await storage.read(doc.storage_key, !!doc.encrypted)).toString(), 'scanned-letter-text');

  const status = await api.get('/backup/status');
  assert.equal(status.data.automatic, false);
});

test('automatic backups write one file per practice per day and prune old ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-backups-'));
  try {
    writeFileSync(join(dir, 'practice-1-2000-01-01.json.gz'), 'old');
    const made = await runAutomaticBackups(h.db, { dir, keep: 14, storage: h.app.locals.storage, now: new Date('2031-05-06T03:00:00Z') });
    const practices = (await h.db.all('SELECT id FROM practices')).length;
    assert.equal(made.filter((f) => f.endsWith('.json.gz')).length, practices);
    assert.ok(!readdirSync(dir).includes('practice-1-2000-01-01.json.gz'));
    const again = await runAutomaticBackups(h.db, { dir, keep: 14, now: new Date('2031-05-06T09:00:00Z') });
    assert.equal(again.length, 0);
    const one = readdirSync(dir).find((f) => f.endsWith('.json.gz'));
    assert.equal(JSON.parse(gunzipSync(readFileSync(join(dir, one))).toString()).format, 'dentalmachine-backup');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only administrators can back up', async () => {
  const { api } = await h.practice();
  const email = `hyg${Date.now()}@example.com`;
  await api.post('/users', { name: 'Hy', email, password: 'correct-horse-battery', role: 'hygienist' });
  const login = await h.client().post('/auth/login', { email, password: 'correct-horse-battery' });
  const hyg = h.client(login.data.token);
  assert.equal((await hyg.get('/backup/status')).status, 403);
  assert.equal((await hyg.post('/backup/test')).status, 403);
});

test('encrypted automatic backups: sealed with the key, owner-only, and restorable only with the right key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-backups-enc-'));
  const key = 'k'.repeat(40);
  try {
    const made = await runAutomaticBackups(h.db, { dir, keep: 14, storage: h.app.locals.storage, now: new Date('2031-06-01T03:00:00Z'), key });
    const one = made.find((f) => f.endsWith('.json.gz.enc'));
    assert.ok(one);
    const buf = readFileSync(join(dir, one));
    assert.ok(isEncryptedBackup(buf));
    assert.equal(buf.includes(Buffer.from('dentalmachine-backup')), false, 'no plaintext inside');
    assert.equal(statSync(join(dir, one)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readBackupFile(buf, key)).format, 'dentalmachine-backup');
    assert.throws(() => readBackupFile(buf, 'x'.repeat(40)), /could not be decrypted/);
    assert.throws(() => readBackupFile(buf, null), /encrypted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a backup downloaded from the browser leaves two-factor secrets behind', async () => {
  const { api, token } = await h.practice();
  const me = (await api.get('/auth/me')).data.user;
  await h.db.run("UPDATE users SET mfa_secret = 'JBSWY3DPEHPK3PXP', mfa_enabled = 1 WHERE id = ?", me.id);
  const res = await fetch(`${h.origin}/api/backup`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const text = gunzipSync(Buffer.from(await res.arrayBuffer())).toString();
  assert.equal(text.includes('JBSWY3DPEHPK3PXP'), false);
  // Nor password hashes, which could be cracked offline if the file were lost.
  assert.equal(text.includes('scrypt$'), false);
  assert.match(text, /"password_hash":"reset-required"/);
  await h.db.run('UPDATE users SET mfa_secret = NULL, mfa_enabled = 0 WHERE id = ?', me.id);
});

test('production refuses to start without its security settings', () => {
  const ok = { JWT_SECRET: 'a'.repeat(64), DOCUMENT_ENCRYPTION_KEY: 'b'.repeat(64), APP_URL: 'https://app.example.com' };
  assert.deepEqual(productionProblems(ok), []);
  assert.match(productionProblems({ ...ok, JWT_SECRET: 'dev' }).join(), /JWT_SECRET/);
  assert.match(productionProblems({ ...ok, DOCUMENT_ENCRYPTION_KEY: '' }).join(), /DOCUMENT_ENCRYPTION_KEY/);
  assert.deepEqual(productionProblems({ ...ok, DOCUMENT_ENCRYPTION_KEY: '', ALLOW_UNENCRYPTED_FILES: '1' }), []);
  assert.match(productionProblems({ ...ok, APP_URL: 'http://dental.example.com' }).join(), /https/);
  assert.deepEqual(productionProblems({ ...ok, APP_URL: 'http://localhost:4000' }), [], 'local testing is fine');
  assert.match(productionProblems({ ...ok, BACKUP_DIR: '/backups' }).join(), /BACKUP_ENCRYPTION_KEY/);
  // A server that says it's production can't run pretend payers or card processing; staging and demo can.
  assert.match(productionProblems({ ...ok, APP_ENV: 'production', PAYMENTS: 'sandbox', EDI_MODE: 'sandbox' }).join(), /sandbox.*PAYMENTS/);
  assert.deepEqual(productionProblems({ ...ok, APP_ENV: 'demo', PAYMENTS: 'sandbox' }), []);
});

test('restore drills: the newest stored backup is read back and restored weekly; a bad file raises an item', async () => {
  const { practiceId } = await h.practice();
  const dir = mkdtempSync(join(tmpdir(), 'dm-drills-'));
  try {
    const now = new Date();
    await runAutomaticBackups(h.db, { dir, keep: 14, now, key: 'drill-key' });
    const done = await runRestoreDrills(h.db, { dir, keys: ['drill-key'], now });
    const mine = done.find((d) => d.practice_id === practiceId);
    assert.equal(mine.ok, true, mine.detail);
    assert.ok(mine.rows > 0);
    assert.equal((await runRestoreDrills(h.db, { dir, keys: ['drill-key'], now })).length, 0, 'once a week');

    // A damaged file fails loudly.
    const name = readdirSync(dir).find((f) => f.startsWith(`practice-${practiceId}-`));
    writeFileSync(join(dir, name), Buffer.from('DMBK1 not really a backup'));
    await h.db.run('DELETE FROM restore_drills WHERE practice_id = ?', practiceId);
    const [bad] = (await runRestoreDrills(h.db, { dir, keys: ['drill-key'], now })).filter((d) => d.practice_id === practiceId);
    assert.equal(bad.ok, false);
    const issue = await h.db.get("SELECT * FROM issues WHERE practice_id = ? AND dedupe_key = 'restore-drill' AND status = 'open'", practiceId);
    assert.ok(issue, 'a failed drill is a Needs-attention item');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
