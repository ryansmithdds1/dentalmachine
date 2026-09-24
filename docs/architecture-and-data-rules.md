# Architecture and data rules

How Dental Machine represents each core concept. There is **one** way to represent each thing; new features
use these models instead of adding parallel ones. If a model genuinely doesn't fit, change it here first.
Rules that apply to all of them are in `/CLAUDE.md`.

## Tenancy, offices and people

| Concept | Table(s) | Rules |
|---|---|---|
| Practice (tenant) | `practices` | Every tenant-owned row has `practice_id`; every query filters by it (`findOr404(db, table, id, practice_id)`). Data never crosses practices. |
| Office / location | `locations` | A practice's physical offices. Appointments, operatories, ledger entries, procedures, claims, clinical notes, messages, calls, documents, prescriptions and patients (home office) carry `location_id` — `insert()` fills it from the visit, the office being worked in, or the patient's home office. Users can be restricted to locations (`users.location_ids`). |
| Group of practices | `organizations`, `org_members`, `practices.organization_id` | Owners see **totals** across practices and copy setup. Only the group's central billing team (owners, and members an owner flags `org_members.billing`, who also hold `billing:read`) sees patient-level rows across practices — billing queues and a read-only lookup — and every such view is audited in the patient's own practice (`docs/dso.md`). Records are only opened and changed from within their own practice. |
| Staff user | `users`, `custom_roles` | Role + custom role permissions ± per-user adds/removes (`effectivePermissions`). MFA, SSO, idle timeout, `token_version` to revoke sessions. |
| Machine access | `api_keys` (scopes), MCP | Acts as `role: 'api'`, audited as `API: <key name>` / `MCP: <key name>`. |

## Patients and families
- `patients`: one row per person per practice. Families: `guarantor_id` points at the head of household (null =
  own guarantor). Never deleted: `status` = active / inactive / archived.
- Duplicates: `findDuplicates` (name + DOB, phone, email). Merging is always a person's decision, never automatic;
  the duplicate is archived with `merged_into_id` pointing at the kept chart, never deleted.
- Old-system ids live in `external_ids` so re-imports update instead of duplicating.
- Contact preferences and opt-outs: `sms_opt_in`, `email_opt_in`, `message_opt_outs`, `preferred_contact`.

## Scheduling
- `appointments`: `status` scheduled → confirmed → checked_in → in_chair → completed, or cancelled / no_show
  (never deleted). Flow times: `arrived_at`, `seated_at`, `dismissed_at`. Confirmation: `confirmed_at`, `confirmed_via`.
- Conflicts checked on the server by `validateAppt` (provider, chair, patient, blockouts, hours).
- Online requests: `booking_requests` (pending → accepted/declined) until staff or instant booking makes an appointment.
- Waitlist `waitlist`, cancellation offers `fill_offers` / `fill_offer_recipients`, reminders `appointment_reminders`.

## Clinical
- `procedures`: one row per procedure. `status` planned → completed (or cancelled). `code_id` → `procedure_codes`,
  `fee` in cents copied at the time, `tooth`/`surfaces`/`area`, `treatment_plan_id`, `appointment_id`, `provider_id`.
  **Completing a procedure posts exactly one `charge` ledger entry** (with `procedure_id`).
- `tooth_conditions`: charted findings (existing work, caries, missing…), `resolved` rather than deleted;
  `voided_at` when the charge that charted them is voided.
- `treatment_plans`: groups planned procedures; proposed → accepted/rejected/completed; e-signatures kept.
- `clinical_notes`: draft (`signed = 0`) → signed (immutable) → addenda (`addendum_of`). Only clinical roles sign.
- `perio_exams`, `prescriptions`, `documents` (encrypted files; `deleted_at`), `risk_assessments`, `lab_cases`.

## Money — the ledger
- `ledger_entries` is the single source of truth. `type`: charge, payment, insurance_payment, adjustment, refund.
  **Sign convention:** debits (charges) positive, credits (payments, write-offs, credit adjustments) negative,
  integer cents. A balance is always `SUM(amount)`; nothing stores a balance.
- Corrections: **void** (`voided_at`, `voided_by`, `void_reason`) or a **reversing entry** (`reverses_id`); refunds
  reference `refund_of_id`. Entries are never edited in amount or deleted. A practice **lock date** stops back-dating.
- Links: `procedure_id`, `claim_id`, `insurance_check_id`, `payment_plan_id`, `deposit_id`, `membership_id`,
  `ortho_case_id`, `location_id`, `provider_id`, `created_by`.
- Around it: `payment_plans`, `deposits` (bank deposit slips), `payment_methods` (cards on file), `financing_applications`.
- Automatic billing (`billingauto.js`, BL1–BL5): every automatic card charge goes through `trackedCharge`
  (`billing_attempts`) and posts once by the processor's id; a declined one is `billing_dunning` (retries, pause,
  Needs attention) — never a posting. The patient's OK is `billing_authorizations` (exact words + hash, never
  edited); `recurring_charges` is the only "any amount each month" schedule (plans stay `payment_plans`).
  Surcharges, convenience fees and office fees (`billing_fees` → `billing_fee_charges`) are their own ledger lines
  (`adjustment`), never inside a procedure fee; waivers are reversing entries. Disputes and processor refunds are
  `billing_disputes`, posted as reversing entries / refunds.

## Insurance and claims
- `insurance_carriers` (payer) → `insurance_plans` (employer group: shared benefits, frequencies, fee schedule)
  → `patient_insurance` (a person's policy: priority primary/secondary, subscriber). Estimates: `estimateCoverage`.
- `fee_schedules` / `fee_schedule_items`: PPO allowed amounts; office fees on `procedure_codes`; changes in `fee_history`.
  Every change to a schedule (standard fees included) is also a never-edited **version** (`fee_schedule_versions` +
  items, `effective_from`, source, who made / approved it); the live tables are always the newest version. Planned
  changes — % increases and payer imports — are `fee_changes` (draft → scheduled → applied, or cancelled/rejected),
  applied once by the fee job at the practice's local midnight. **Fees for a date of service come from `resolveFee`
  (`feeversions.js`)** — estimates and claims use it; don't read `fee_schedule_items` directly for pricing.
- `claims` + `claim_items` (one per procedure): draft → submitted → paid / partially_paid / denied, or void.
  Corrections use frequency codes 7/8 and `corrected_from_id`; secondary claims link `primary_claim_id`.
- Payments: `insurance_checks` (one check/EFT across claims) post `insurance_payment` and write-off entries via
  `postClaimPayment`; ERAs (`era_imports`) do the same and can't be posted twice.
- Clearinghouse traffic: `edi_batches`, `edi_inbox`, `claim_events`; attachments `claim_attachments`.

## Communication, work and history
- `messages`: every text/email/portal message, with delivery status; `calls` for phone calls.
- `tasks`: the team's to-do list (follow-ups, lab shipments, low reviews).
- `issues`: **Needs attention** — everything that failed on its own (claim rejections, texts that didn't go,
  sync/import/AI failures, backup drills). One open item per problem (`dedupe_key`), counted up when it
  recurs, resolved automatically by a later success or by a person with a note. `raiseIssue` in `issues.js`.
- `audit_log`: who (`user_id`, `actor`), how (`source`: human, ai, automation, api, import, integration,
  patient), what (`action`, `entity`, `entity_id`, field-level `changes` before → after), why (`reason`),
  where (`ip`, `location_id`), which patient (`patient_id`), when. Append-only (database triggers).

## Integrations
Each vendor sits behind an adapter module with a sandbox mode (payments, clearinghouse, e-Rx, mail, Plaid,
QuickBooks, x-ray AI, transcription, Google Business, lenders). Routes call the adapter, never the vendor directly.
Every outside call goes through `loggedFetch` into `integration_log` (service, operation, status, time, their
reference, source — no bodies), shown in Settings → Connection activity. Repeated requests are made safe by
`Idempotency-Key` (`idempotency_keys`) and natural unique keys (one live charge per procedure, message and call
ids from the carrier).

## AI
All model calls go through `server/src/ai.js` (or the assistant/receptionist loops). AI output is a **draft or
suggestion** stored separately (scribe draft, `xray_findings` status suggested, claim narratives, review
replies, benefit/EOB reads) until a person accepts it. The AI receptionist is the exception, limited to booking
into open times, requests, moving/cancelling a caller's own visit and messages — each recorded on the call.
High-risk changes the assistant makes (money, claims, completing procedures, signing, prescriptions, merges,
insurance, removals) are refused unless the person approved them on screen (`aiguard.js`); `requireHuman()`
guards the same functions for AI that isn't a request. AI findings carry a short reason (`xray_findings.note`).
Predictions (no-show risk per visit, denial risk per claim line — `server/src/predict/`, `docs/predictions.md`) are
worked out when read, from the practice's own history, and are never stored on or acted on by themselves: they carry
a probability, a confidence and plain-language reasons, and go through one adapter (built-in model by default; a
vendor behind it falls back to the built-in model and raises a Needs attention item).

## Reconciliation, migrations, backups
- Reports → Reconciliation compares card processor vs ledger, insurance checks vs postings, claims created →
  sent → answered → paid (with stuck claims), and import file rows vs rows brought in (`reconcile.js`).
- Schema is additive (`db.js`); data changes are numbered steps in `migrations.js` recorded in
  `schema_migrations`. Environments, releases, rollback and restore drills: `docs/environments-and-releases.md`.
- Restore drills (`restore_drills`) prove stored backups come back whole every week.

## Remaining exceptions (deliberate)
- Undoing a data import removes the rows that import created (it's the undo of a mistake, before anyone
  works with them); it is audited.
- Configuration (saved reports, templates, blockouts, fee-schedule rows, finance rules, image mounts) can be
  deleted; every such delete is audited.
- EDI batches that failed before anything was sent are removed; nothing left the building.
