# Environments, releases, migrations and restore drills

How Dental Machine is run so that a mistake in testing never touches a real practice, a release can be
rolled back, and backups are proven to restore. This is the working guide behind rules 16–20 in
`CLAUDE.md`.

## The four environments

| `APP_ENV` | Who uses it | Database | Integrations | Data |
| --- | --- | --- | --- | --- |
| `development` | a developer's machine | local SQLite or Postgres | sandbox / log | seeded demo (`npm run seed`) |
| `demo` | sales demos, the Render button | its own Postgres | all sandbox | seeded demo |
| `staging` | testing a release before it ships | its own Postgres, **never** a copy of production | sandbox, or vendor test accounts | seeded demo, or a *de-identified* practice |
| `production` | real practices | its own Postgres with provider backups and point-in-time recovery | real vendors only | real patients |

Rules:

- **Each environment has its own database, storage bucket, encryption keys and vendor credentials.** Never
  point staging or a laptop at the production `DATABASE_URL`, S3 bucket or keys.
- **Real patient data stays in production.** To reproduce a problem, restore a backup into staging
  only after removing identifiers, or rebuild the case with demo data.
- **`APP_ENV=production` refuses sandbox integrations.** The server will not start if any of
  `EDI_MODE`, `PAYMENTS`, `ERX`, `SMS_DRIVER`, `MAIL_DRIVER`, `PLAID`, `QBO`, `XRAY_AI`, `GOOGLE_BUSINESS`,
  `TRANSCRIBE` or `CLEARINGHOUSE` is `sandbox` or `log`. The check is in `server/src/preflight.js`, alongside
  the checks for the encryption keys, `JWT_SECRET` and https.
- **`npm run seed` refuses to run with `APP_ENV=production`**, so demo patients can't land in a real
  database by accident.
- **Staging and demo servers show a banner on every screen.** It comes from `/api/health`, which reports
  the environment, so nobody mistakes test data for the real schedule.

## Releasing

1. **CI is green on both databases.** `server` tests run against SQLite and Postgres, the client builds,
   and lint passes. Tests cover the dangerous paths: payments, refunds and voids; claims and ERA posting;
   duplicate protection; the audit trail; AI approval; no-silent-failure items; reconciliation; backups and
   restore drills.
2. **Deploy to staging first.** Schema changes apply on start, then pending data migrations run (see
   below). Check the Needs attention page, Reports → Reconciliation and Settings → Connection activity for
   anything new.
3. **Deploy to production.** Before a release that includes a data migration, take a fresh backup
   (Settings → Backups, or `node src/backupcli.js export …`) and confirm the provider's point-in-time
   recovery is on.
4. **Watch the first hour.** Needs attention collects failures from claims, messages, syncs, imports and
   AI steps; Connection activity shows outside calls failing.

## Migrations

There are two kinds, and both are versioned in the code. Nobody edits a production database by hand.

- **Schema:** additive only. New tables go in `SCHEMA`, new columns in `COLUMNS` and new indexes in
  `INDEXES` (`server/src/db.js`). They apply on every start and are safe to run again. Postgres records a
  hash of the schema in `schema_meta` so a start with nothing new skips the work. Columns are never dropped
  or renamed in place. Add a new column, move the data with a data migration, and stop using the old one.
- **Data:** numbered steps in `server/src/migrations.js`. Each step runs once, in order, inside a
  transaction (on Postgres, one server at a time under an advisory lock), and is recorded in
  `schema_migrations` with its id, name and time. Each step has a `down` to undo it, or says why it needs
  none; for example, a backfill that only fills blanks. A step that has shipped is never edited: fix
  forward with a new step.

**Rolling back a release:** deploy the previous version. Additive schema means the old code runs on the new
tables. If a data migration must be undone, `rollbackLast()` in `migrations.js` runs the newest step's
`down` and removes its record. A step without a `down` refuses; restore from the backup taken before the
release instead.

## Backups and restore drills

- **Automatic backups:** each practice every night to `BACKUP_DIR`, encrypted with `BACKUP_ENCRYPTION_KEY`
  and kept `BACKUP_KEEP` days (default 14). On SQLite a copy of the whole database is kept as well. On Postgres,
  also turn on the provider's daily backups and point-in-time recovery.
- **Weekly restore drill (automatic):** for each practice, the newest *stored* backup file is read back,
  decrypted with the current or a previous key, and restored into a copy that is rolled back. Every
  table's row count is then compared with the file. The result is kept in `restore_drills` and shown in
  Settings → Backups. A failure becomes a high-priority item in Needs attention. This proves that the
  files on disk, the keys and the restore code all work together, not just that a backup was written.
- **Test restore by hand:** Settings → Backups → Run a test restore does the same with a fresh backup.
- **Full restore drill (quarterly, by a person):** restore the newest backup onto a scratch server with
  `node src/backupcli.js restore <file>`. Sign in, open a few charts, ledgers and x-rays, then shut the
  server down. Record the date and result as the business continuity plan (`docs/soc2/business-continuity-plan.md`) asks.

## Exports

Everything a practice has entered can leave in open formats (Settings → Backups → Export your data). You
can download one JSON file with every table, or any table as a CSV spreadsheet. The list of tables comes
from the schema, so new data is included automatically. Sign-in secrets are left out, and each export is
written to the audit log. Patients get their own record from their chart (PDF + JSON + files).
