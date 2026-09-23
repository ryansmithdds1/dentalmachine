# Business Continuity and Disaster Recovery Plan

**Owner:** [Engineering lead] · **Tested:** restore drill every quarter

- **Targets:** recovery time 4 hours; recovery point 24 hours (nightly backups) — tighter with a managed
  database's point-in-time recovery.
- **Backups:** nightly encrypted backups (`BACKUP_DIR`, `BACKUP_ENCRYPTION_KEY`), 14 kept, stored separately
  from the production database, including document files when `BACKUP_DOCUMENTS=on`.
- **Restore drill:** each quarter restore the latest backup into a scratch environment, check record counts
  and open a few charts and x-rays, and record the result and the time it took.
- **Offices keep working offline:** the app keeps today's schedule available when the internet drops.
- **Hosting failure:** redeploy to a second region/host from the repository with the latest backup; update
  DNS; post on the status page.
- **People:** at least two engineers can deploy and restore; runbooks live in the repository.
