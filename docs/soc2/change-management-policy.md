# Change Management Policy

**Owner:** [Engineering lead] · **Reviewed:** yearly

- All code changes go through a pull request, reviewed and approved by someone other than the author.
- The main branch is protected: no direct pushes, required reviews, required passing checks.
- Automated checks run on every pull request: the full test suite on SQLite and PostgreSQL, lint and the
  client build. Security-relevant changes get a second reviewer.
- Database changes are additive and applied automatically at start-up (`db.js`), so a deploy never needs a
  manual migration step; destructive changes need a written plan and a backup first.
- Deploys happen from the main branch only; every deploy is traceable to a commit (shown on the status page).
- Emergency fixes may be merged with one reviewer after the fact within 1 business day, recorded in the
  incident record.
