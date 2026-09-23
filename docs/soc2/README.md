# SOC 2 readiness

What Dental Machine already does toward a SOC 2 Type II report (Security, Availability and Confidentiality
criteria), what the company running it still has to put in place, and the evidence an auditor will ask for.
A SOC 2 report is about the **organization** operating the service, not just the code: the controls below
marked *Company* are policies and habits, and need to run for the audit period (usually 3–12 months) before a
Type II report.

Start here:
1. Adopt the policies in this folder (edit the bracketed parts, have leadership sign them).
2. Pick a compliance platform (Vanta, Drata, Secureframe) or a spreadsheet to track evidence.
3. Run a readiness assessment with an auditing firm, fix gaps, then start the observation period.

## Control map

| Area (TSC) | Control | Where / how | Owner |
|---|---|---|---|
| CC6.1 Logical access | Each user has their own login; roles and per-user permissions; location restrictions | Settings → Users & roles; `server/src/auth.js` | Product |
| CC6.1 | Multi-factor sign-in, required per practice; single sign-on (Google, Microsoft, OIDC) | Settings → Practice & security | Product |
| CC6.1 | Sessions time out when idle; tokens revoked on password change | `IdleLogout`, `token_version` | Product |
| CC6.1 | API keys scoped per purpose, revocable, last use recorded; MCP read-only | Settings → API & webhooks | Product |
| CC6.1 | Production access for engineers limited, reviewed quarterly | Access review (see Access Control policy) | Company |
| CC6.6 | HTTPS only (HSTS), strict Content-Security-Policy, no framing | `app.js`, `vercel.json` | Product |
| CC6.7 | Documents and x-rays encrypted at rest (AES-256-GCM) with key rotation; secrets sealed | `storage.js`, `npm run rotate-keys` | Product |
| CC6.7 | Database encrypted at rest; backups encrypted | Host settings; `BACKUP_ENCRYPTION_KEY` | Company |
| CC6.8 | Dependencies pinned; vulnerability scanning of dependencies | `package-lock.json`; enable Dependabot / `npm audit` in CI | Company |
| CC7.2 | Every access to patient records, exports and changes written to the audit log (who, what, when, from where) | Settings → Audit log; `audit()` | Product |
| CC7.2 | Structured logs without patient data; error reporting scrubbed | `monitoring.js` | Product |
| CC7.2 | Alerts on errors and downtime | `SENTRY_DSN`; an uptime monitor on `/api/public/status` | Company |
| CC7.3–7.5 | Incident response: triage, notify, breach assessment (HIPAA 60-day rule) | Incident Response policy | Company |
| CC8.1 | Changes through pull requests with review and automated tests on SQLite and Postgres | GitHub branch protection; CI | Company |
| A1.2 | Nightly encrypted backups, kept 14 days; restore tested | `BACKUP_DIR`; restore drill each quarter | Company |
| A1.2 | Status page with live checks | `/status` | Product |
| C1.1 | Data minimized to vendors (BAAs), AI features send only what the task needs | `docs/HIPAA-vendors.md` | Company |
| C1.2 | Patient record export (right of access) and deletion on request | Patient → Export | Product |
| CC9.2 | Vendors reviewed and BAAs signed before use | Vendor Management policy | Company |
| CC1.4 | Background checks and security training at hire and yearly | HR | Company |

## Evidence to collect (per period)

- User list and roles per system (production host, database, GitHub, email), with quarterly review sign-off.
- MFA enabled on every admin account (screenshots or exports).
- Pull requests merged with approvals and passing checks (GitHub export).
- Backup job success and the latest restore test record.
- Audit-log samples and the alerting setup; incident log (even if empty).
- Signed policies, training completion, background checks, vendor BAAs, risk assessment (yearly).
- Penetration test report (yearly, by an outside firm).

## Policies in this folder

- `information-security-policy.md`
- `access-control-policy.md`
- `incident-response-plan.md`
- `change-management-policy.md`
- `business-continuity-plan.md`
- `vendor-management-policy.md`
- `data-retention-policy.md`
