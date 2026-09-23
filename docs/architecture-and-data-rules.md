# Architecture and data rules

How Dental Machine represents each core concept. There is **one** way to represent each thing; new features
use these models instead of adding parallel ones. If a model genuinely doesn't fit, change it here first.
Rules that apply to all of them are in `/CLAUDE.md`.

## Tenancy, offices and people

| Concept | Table(s) | Rules |
|---|---|---|
| Practice (tenant) | `practices` | Every tenant-owned row has `practice_id`; every query filters by it (`findOr404(db, table, id, practice_id)`). Data never crosses practices. |
| Office / location | `locations` | A practice's physical offices. Appointments, operatories, ledger entries, patients (home office) carry `location_id`. Users can be restricted to locations (`users.location_ids`). |
| Group of practices | `organizations`, `org_members`, `practices.organization_id` | Owners see **totals** across practices and copy setup; never another practice's patient records. |
| Staff user | `users`, `custom_roles` | Role + custom role permissions ± per-user adds/removes (`effectivePermissions`). MFA, SSO, idle timeout, `token_version` to revoke sessions. |
| Machine access | `api_keys` (scopes), MCP | Acts as `role: 'api'`, audited as `API: <key name>` / `MCP: <key name>`. |

## Patients and families
- `patients`: one row per person per practice. Families: `guarantor_id` points at the head of household (null =
  own guarantor). Never deleted: `status` = active / inactive / archived.
- Duplicates: `findDuplicates` (name + DOB, phone, email). Merging is always a person's decision, never automatic.
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
- `tooth_conditions`: charted findings (existing work, caries, missing…), `resolved` rather than deleted.
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

## Insurance and claims
- `insurance_carriers` (payer) → `insurance_plans` (employer group: shared benefits, frequencies, fee schedule)
  → `patient_insurance` (a person's policy: priority primary/secondary, subscriber). Estimates: `estimateCoverage`.
- `fee_schedules` / `fee_schedule_items`: PPO allowed amounts; office fees on `procedure_codes`; changes in `fee_history`.
- `claims` + `claim_items` (one per procedure): draft → submitted → paid / partially_paid / denied, or void.
  Corrections use frequency codes 7/8 and `corrected_from_id`; secondary claims link `primary_claim_id`.
- Payments: `insurance_checks` (one check/EFT across claims) post `insurance_payment` and write-off entries via
  `postClaimPayment`; ERAs (`era_imports`) do the same and can't be posted twice.
- Clearinghouse traffic: `edi_batches`, `edi_inbox`, `claim_events`; attachments `claim_attachments`.

## Communication, work and history
- `messages`: every text/email/portal message, with delivery status; `calls` for phone calls.
- `tasks`: **the work queue** — anything that needs a person (failures, follow-ups, AI findings to review).
- `audit_log`: who (`user_id`, or the API key/automation named in `details`), what (`action`, `entity`,
  `entity_id`), when, where (`ip`), details (before/after for edits). Append-only.

## Integrations
Each vendor sits behind an adapter module with a sandbox mode (payments, clearinghouse, e-Rx, mail, Plaid,
QuickBooks, x-ray AI, transcription, Google Business, lenders). Routes call the adapter, never the vendor directly.

## AI
All model calls go through `server/src/ai.js` (or the assistant/receptionist loops). AI output is a **draft or
suggestion** stored separately (scribe draft, `xray_findings` status suggested, claim narratives, review
replies, benefit/EOB reads) until a person accepts it. The AI receptionist is the exception, limited to booking
into open times, requests, moving/cancelling a caller's own visit and messages — each recorded on the call.

## Known gaps being closed
See the integrity plan in the conversation / issue tracker: field-level before/after and action source on every
audit row, idempotency keys, a failure work queue, an integration activity log, versioned migrations, patient
merges that archive instead of delete.
