# Dental Machine — rules for everyone working on this code (people and AI)

Dental practice management software: patient records, clinical charting, money and insurance. Reliability,
traceability and data integrity come before speed. Read `docs/architecture-and-data-rules.md` before adding a
table or a way of representing something — use the existing model, don't invent a second one.

## Before a feature involving clinical data, money, insurance or patient records is "done"
Ask "what happens if this is wrong?" and build the safeguard. The system must be able to answer:
who did it · what happened · when · what was there before · what is there now · why · can it be safely reversed.

## Non-negotiable rules
1. **Never silently change important data.** Clinical notes, treatment, diagnoses, fees, payments, adjustments,
   insurance, claims, balances, appointments, prescriptions, signed documents: record before/after, who, when,
   why (when a reason is required) and the source (human, AI, automation, API, import, integration).
2. **Everything important goes through `audit()`** (`server/src/util.js`) with before/after for edits. Audit
   rows are append-only: no route may update or delete them.
3. **Reverse, don't edit or delete, money and clinical records.** Ledger entries are voided or reversed
   (`voided_at`, `reverses_id`), never edited. Signed notes get addenda. Claims are corrected or voided.
4. **The ledger is the source of truth.** Balances are always `SUM(amount)` over ledger entries — never stored
   or taken from the UI. Amounts are integer cents. Posting must be idempotent.
5. **No hard deletes of important records.** Use status (inactive, cancelled, voided, archived). Hard deletes
   only for scratch/derived rows (reminder queues, drafts, sessions) — say so in a comment.
6. **Validate on the server** every id (and that it belongs to `req.user.practice_id`), date, amount, code,
   tooth and surface. Reject impossible data; never trust the client.
7. **Assume every request can arrive twice** (double clicks, retries, webhooks). Payments, claims, messages,
   appointments and postings need an idempotency key or a natural unique constraint.
8. **Permissions on every route** (`requirePermission` / admin). Sensitive actions — refunds, voids, fee
   changes, finalized-note changes, insurance payment changes, exports, permission changes — need the stronger
   permission and are audited.
9. **AI and automation never pose as a person.** Record the source on every action they take; a person who
   approves an AI draft is recorded as the approver.
10. **AI recommends; people approve high-risk changes** (money, write-offs, refunds, final notes, diagnoses,
    treatment, prescriptions, unusual claims, patient identity). Store a short plain-language reason with
    significant AI suggestions — never hidden reasoning.
11. **Multi-office:** records carry `practice_id` (tenant) and `location_id` (office) where it applies.
12. **Never fail silently.** A failed claim, payment, message, import, sync or AI job becomes a visible work
    item (task / needs-attention queue), not just a log line. No bare `.catch(() => {})` on anything important.
13. **Integrations:** behind an adapter in its own module (swappable vendor), each call logged (time,
    destination, result, external id, retries) without PHI. Sandbox mode for demos and tests.
14. **Reconcile** wherever money or data crosses a boundary (processor vs ledger, ERA vs ledger, claims
    created vs sent vs acknowledged, imports source vs imported).
15. **Data is exportable** in standard formats; patients can get their record.
16. **Schema changes** are additive and versioned in `server/src/db.js`; no manual production edits. Never run
    anything against production data from a coding session.
17. **Test the dangerous things first:** money, insurance payments, claims, patient identity, clinical
    changes, permissions, scheduling conflicts, imports, integrations, audit logging.
18. **Keep it simple:** clear tables, small modules, standard tech, comments that explain why.

## Conventions
- Server: Node/Express, async `db` (SQLite and Postgres — both must pass). Tables in the `SCHEMA` literal in
  `db.js` (no backticks inside; referenced tables first); new columns in `COLUMNS`. No `json_extract`; no
  bare `?` whose type Postgres can't infer (e.g. `? IS NULL`).
- Client: React + Vite, lucide icons. Plain, friendly wording for office staff.
- Tests: `cd server && npm test` (plus `TEST_DATABASE_URL=… npm test` for Postgres), `npm run lint`,
  `cd client && npx vite build`. Every feature ships with tests.
- Never commit secrets or API keys.
