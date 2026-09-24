# IV · Insurance verification center (IV1–IV4)

**Trigger:** every booked visit. **Who:** front desk / billing (billing:read to see, billing:write to change
benefits; texting a patient needs patients:write or billing:write; settings are for administrators).
**Data:** the patient's primary policy and its plan (`insurance_plans`, shared by everyone on the employer group),
eligibility answers (`eligibility_checks`), verified breakdowns (`benefit_verifications`), AI reads of benefit
documents (`benefit_reads`), the automatic runs (`verification_runs`), settings (`practices.verification_settings`).

**Before:** eligibility ran each evening for tomorrow only and the full breakdown (percentages by kind of work,
waiting periods, what's used) was re-verified by hand per patient, even when the same plan had just been verified
for a coworker. Nothing showed at a glance whether a visit's breakdown was current.

**Budget:** 0 actions for the usual visit (checked automatically, applied automatically). Tomorrow's list: **1**
(**R** checks everyone in the range). An exception: **≤ 2** (select it, **T** texts the patient a secure link for a
photo of their new card). Verified by phone: **≤ 5** (**P**, reference number, Tab, representative, Enter).

## IV1 · The screen (Insurance verification, `/verification`)
- Upcoming visits for **Today / Tomorrow / Next 7 days / Next 14 days** (keys **1–4**; the last one used is
  remembered) and per **office**. Views: **Needs a person** (default), **Waiting on patient**, **Everyone** (**V**).
- Each visit shows two statuses, the same pills as the chart and patient bar (`VerifyBadge`):
  - **Eligibility** — the schedule's badge ($✓ verified in the last 30 days, $? old or never, $✗ inactive,
    $! the payer couldn't check); with when, how (Electronic 271, sandbox, phone call, portal…) and by whom.
  - **Full breakdown** — verified, out of date (older than the stale setting, 180 days by default, or from before
    the benefit year renewed), waiting for review, or never; with when, how, by whom, and "verified for another
    patient on the same plan" when it came from the group.
- What's missing: member ID, subscriber name, subscriber date of birth (when not the patient), date of birth,
  group number, payer ID.
- Tiles: visits, % eligibility verified, % breakdown verified, needs a person, **verified 48 h ahead** (last 30
  days), **stale breakdowns** (plans of patients booked in the next 14 days).
- **J / K** move; the side panel shows the current patient: both statuses, the payer's phone, the maximum left
  (the payer's figure when there is one, else from claims here), the exceptions, the actions, and the history of
  what was verified and what it changed (before → after, how many patients it updated).

## IV2 · Automatic
- **Eligibility N days before every visit** (`days_ahead`, 3 by default; anything booked later is checked as soon
  as it's inside the window) **and the morning of** (from `morning_hour`, 6am practice time). One pass every 30
  minutes; each (policy, visit day, window) is claimed by inserting its `verification_runs` row first (unique), so
  a second pass or a second server never checks it twice. Anyone checked in the last day (or today, for the
  morning run) is skipped. Failures retry on later passes (three tries, 30 minutes apart), then become one Needs
  attention item per visit ("verify by phone or the payer's portal"), resolved by a later success or a phone
  verification. Recorded as `automation`.
- **Clean answers are applied by themselves** (as #20). Where the 271 carries the breakdown, it's read service
  type by service type (`benefitdetail.js`): the three tiers, a per-code override for any kind of work paid
  differently from its tier (endodontics at 50% on an 80% basic plan → D3 50%), deductible and family deductible,
  maximum with the amount used and left, the orthodontic maximum, percentage and age limit, waiting periods (a
  later "benefit begin" date per service type, or a message), the missing-tooth clause, composite downgrades,
  frequency limits and service history. Plan-level results go to the plan (IV3); the patient's own amounts stay on
  their verification (and the deductible met on their policy).
- **No breakdown electronically:** **U** uploads the payer portal page or the fax (PDF, photo or text). It's filed
  in the chart (Documents → Insurance) and read by AI (sandbox reader on demo servers) into a **draft** shown next to
  what's on file. A person ticks each field they checked (and corrects any value); only ticked fields are applied.
  Never applied by itself; the AI can't confirm it (428).
- Optional (off by default): text the patient automatically when coverage comes back inactive.

## IV3 · The whole group at once
- A verified plan-level change (percentages, frequencies, maximum, deductible, waiting periods, clauses, ortho) is
  written to the patient's plan and so applies to **every patient on it**, recorded with who verified it, how and
  when; the screen says "N patients updated". Patient-specific data (maximum used and left, deductible met, history)
  stays with the patient.
- **Guard:** only when the plan's identity is certain — the policy and the plan have the same payer and the same
  group number, the source (271 `REF*6P`, the phone call, the document) doesn't name a different group, and a plan
  without a group number is only shared within one family. Otherwise the plan isn't changed: the change waits on
  **Plan changes waiting for you** (and Needs attention). A person applies it (optionally also to other plan records
  with the same group number, which are never changed on their own) or keeps what's on file; either is audited.
  For a 271 the guard is part of #20's check: an answer naming another group is an exception and changes nothing.

## IV4 · Exceptions only
Coverage inactive · coverage ends before the visit · the payer couldn't check it · plan changed (new insurance
sent, a new card photo, the payer names another group) · missing subscriber details · not verified by tomorrow ·
maximum nearly used (`max_nearly_used_pct`, 80%) · breakdown out of date. One-key actions on the current patient:
- **T** text for a new card: a 3-day secure upload link (`/scan/…`, category insurance card, no staff member on
  the link so the photo lands in Intake review for the card reader, #31). Once a day at most. The visit moves to
  **Waiting on patient** for three days or until a card comes in.
- **S** payer phone script with the payer's phone, the practice's NPI and tax ID, the patient's and subscriber's
  details, and the questions to ask (dates, maximum, deductible, percentages, frequencies, waiting periods,
  clauses, history, reference number).
- **P** verified by phone: active or not, **reference number and representative's name required**, coverage end
  date, and optionally the benefits read out (applied as IV3). Audited as `verification.phone`.
- **E** check now, **U** read a portal page or fax, **O** open the chart.

## Records and safety
Every change goes through `recorded()` (before → after in the audit log) with the actor: a person, the payer's
answer (`integration`), the automatic run (`automation`), or the AI read a person confirmed (`ai` for the read,
`human` for the confirmation). `benefits.verify` (with before/after), `benefits.verify_review`,
`benefits.review_apply` / `benefits.review_keep`, `benefits.ai_read` / `benefits.ai_read_confirmed`,
`verification.phone`, `verification.request_insurance`, `verification.run`, `verification.settings`.
High-risk endpoints for the assistant (`aiguard.js`): phone verification, confirming an AI read, applying a
reviewed plan change; each also calls `requireHuman()`.

**Metrics:** `GET /verification/metrics?from&to&location_id` → `pct_verified_48h` (visits whose 48-hour mark
has passed with a payer answer from within 30 days before it), `stale_breakdowns`, `never_verified_breakdowns`,
`exceptions`. `verificationMetrics()` in `verification.js` for the metrics module.

**Acceptance:** `server/test/verification.test.js` (271 parsing; days-ahead and morning-of timing, idempotent,
retries then an issue; the electronic breakdown applied to the group with the patient's amounts kept; phone
verification; the identity guard and the review list; the AI read confirmed field by field; exception rules;
the list, office filter and texting; metrics; practice/office isolation; permissions).
`e2e/workflows/IV-verification.test.mjs`: tomorrow's list = 1 key; an exception = 2 actions; phone = 5.
