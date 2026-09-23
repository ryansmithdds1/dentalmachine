# Dental Machine roadmap

This is a working guide to what to build next. It compares Dental Machine with **Open Dental** (the most complete PMS feature set) and **Curve Dental** (the cloud-native benchmark). It comes from a code audit of every area, done September 2026.

E-prescribing is **out of scope**: what exists stays as it is, and nothing further is planned.

**Priority key**

| | Meaning |
|---|---|
| **P0** | Wrong numbers, lost data or security. Fix before anything else. |
| **P1** | An office can't switch from Open Dental or Curve without it. |
| **P2** | Expected by most offices, and a competitive gap. |
| **P3** | Nice to have, differentiator, or for larger groups only. |

Size: **S** is under a day, **M** is 1–3 days, **L** is a week or more.

---

## Part 1 — Fix first: bugs found in the audit (P0)

These are defects in features we already ship. Most are small, and they matter more than anything new, because an office judges a PMS on whether its numbers can be trusted.

### Money and insurance correctness
- [ ] **Secondary claims can't be created.** A procedure already on a primary claim is rejected (`insurance.js:129`). Allow one claim per coverage level. **S**, but it blocks item 2.1.
- [ ] **Deductible never resets.** `deductible_met` never resets for a new benefit year, while annual max used does. Needs a benefit-year start per plan and a reset. **S**
- [ ] **Statements overstate the PPO patient portion.** They ignore the expected write-off, so in-network patients are billed amounts they will never owe. Post the expected write-off when the claim is created, or show it as pending, and make the ledger, statements and portal agree. **M**
- [ ] **Two different "pending insurance" figures.** The ledger counts only `submitted` at the full estimate; the statement run uses estimate − paid over submitted and partially_paid. Use one shared function. **S**
- [ ] **No void or reversal for ledger entries,** and a completed procedure can't be un-completed. Add void-with-reason: the entry stays, a reversing entry is added, and it's audited. **M**
- [ ] **Backdating and period locks.** Payments and adjustments accept any date. Add a "lock date" before which nothing can be posted or changed (admin override). **S**
- [ ] **Refunds.** They aren't checked against a credit, never call a Stripe refund, and have no UI. **M**
- [ ] **Negative final installment.** Payment-plan rounding can make the last installment negative (`family.js:154`). **S**
- [ ] **Autopay caps at the wrong balance.** It uses the whole family's balance instead of the plan's own. **S**
- [ ] **Aging.** Refunds and debit adjustments are counted as charges, credits are ignored, and it runs one query per patient. Rewrite it as a single query. **M**
- [ ] **Day-sheet deposit doesn't subtract refunds.** **S**
- [ ] **Manual EOBs.** A $0 manual EOB can't be posted; write-offs aren't capped at the fee; paid claims can't be reopened or reversed. **M**
- [ ] **Deductible credit.** It is taken from our estimate instead of the payer's reported deductible (`PR-1` on the ERA). **S**
- [ ] **Benefits used.** Counted by the paid date instead of the date of service, and pending claims are ignored. **S**
- [ ] **Top procedures in the production report** sums fees by completion date while every other figure uses the ledger. Unify. **S**
- [ ] **Hygiene reappointment KPI is overstated.** It counts appointments booked later, not ones that existed when the patient left, and doesn't limit to hygiene visits. **S**

### Scheduling correctness
- [ ] **Cancelling from the Edit form** leaves planned procedures attached, so they fall off unscheduled treatment. **S**
- [ ] **Recall marked scheduled by any appointment.** Booking any appointment marks every recall "scheduled", even an emergency visit, and cancelling never reverts it. Only a hygiene or recall appointment should, and only that recall type. **S**
- [ ] **Texting "CANCEL" opts the patient out** instead of cancelling (or asking to cancel) the appointment. **S**
- [ ] **Office hours aren't enforced** when a provider has no hours of their own. **S**
- [ ] **Finished appointments can still be resized** (completed or cancelled). **S**
- [ ] **Practice timezone ignored in places.** Follow-up "Book", task overdue and "Book appointment" defaults use the UTC date. **S**
- [ ] **Phone search.** Searching `5551234567` doesn't find `(555) 123-4567` on the Patients page. **S**

### Clinical correctness
- [ ] **Intake overwrites staff entries.** A submitted intake form replaces the medical alerts, allergies and medications staff typed in. Merge instead, and queue the changes for staff review. **M**
- [ ] **Signed treatment plans aren't frozen.** The signed view is rebuilt from live procedures. Snapshot the plan (lines, fees, estimates, PDF) when it's signed, and expire sign links. **M**
- [ ] **Clinical notes.** There's no `signed_by`, anyone with sign permission can sign another provider's note, and the promised addendum doesn't exist. **M**
- [ ] **Perio sites display backwards** on teeth 9–24; mesial should face the midline. **S**
- [ ] **Completed extractions** don't mark the tooth missing on the chart. **S**
- [ ] **Blank allergies display as "NKDA".** Show "Not recorded" until someone confirms. **S**
- [ ] **Note templates overwrite typed text**, and "Sign now" can create duplicate notes on retry. **S**
- [ ] **Browser DICOM uploads fail** with a 415 (the MIME type is empty). TIFF doesn't preview in Chrome. **S**

### Security and access
- [ ] **Sessions can't be revoked.** Password change, 2FA reset or "sign out everywhere" should end live sessions; add a session table or a token version. **M**
- [ ] **Account lockout.** Add a per-account lockout or slow-down alongside the per-IP limit. **S**
- [ ] **`GET /users` and `GET /practice` are open to every role**; limit them to what each role needs. Task routes have no permission check. **S**
- [ ] **Family unlink.** Removing a family member doesn't check that they belong to that family (`family.js:101`). **S**
- [ ] **Decline messages ignore opt-out.** Online-booking decline messages force `sms_opt_in`. **S**
- [ ] **Recall campaigns include inactive patients**, and a failed reminder is never retried. **S**
- [ ] **Forgot password / self-service reset.** It doesn't exist yet. **S**

---

## Part 2 — Features we don't have (prioritized)

The "OD / Curve" column shows which competitor has the feature: ✓ = has it, ~ = partial.

### 2.1 Insurance and billing: the biggest gap

| # | Feature | Why | OD / Curve | Pri | Size |
|---|---|---|---|---|---|
| 1 | **Secondary claims and coordination of benefits.** Estimates across primary and secondary; generate the secondary claim once primary pays, carrying the primary payment in the 837 (loops 2320/2330). | About 15–20% of patients have dual coverage. | ✓ / ✓ | P1 | L |
| 2 | **Insurance plan benefits.** Frequency limits (BWX 1/12 mo, FMX 1/60 mo, prophy 2/yr), waiting periods, downgrades (posterior composite → amalgam), per-code coverage overrides, ortho lifetime max, family deductible and max, benefit year start. | Estimates are wrong without these; it's the #1 front-desk complaint. | ✓ / ✓ | P1 | L |
| 3 | **Shared insurance plans (employer plans)** instead of free-text subscribers per patient. Edit a plan once and every subscriber updates. | Data quality; how every PMS models it. | ✓ / ✓ | P1 | M |
| 4 | **Bulk insurance payments / EOB batch posting.** One check spread across several claims, with procedure-level posting, plus insurance deposit batches. | Paper EOBs still happen daily. | ✓ / ✓ | P1 | M |
| 5 | **Procedure-level ERA posting.** Post service lines (`SVC`) per procedure, handle the check-level adjustments (`PLB`), and separate contractual (CO) from other (PI/OA) adjustments for review. | Accurate write-offs and provider collections. | ✓ / ✓ | P1 | M |
| 6 | **Claim attachments** (x-rays, perio charts, narratives) via NEA/Vyne or DentalXChange, with the attachment reference (`PWK`) in the 837. | Crowns, SRP and perio claims are denied without them. | ✓ / ✓ | P1 | L |
| 7 | **Corrected and void claims** (claim frequency codes 7 and 8), and the prior-auth reference (`REF*G1`) on the claim. | Fixing claims without phone calls. | ✓ / ✓ | P2 | S |
| 8 | **Payment allocation.** Split payments across procedures and providers; show unapplied credit. | Collections by provider, for associate pay. | ✓ / ✓ | P1 | M |
| 9 | **Adjustment types and write-off approval.** Configurable codes (courtesy, senior, bad debt, insurance write-off); optional manager approval above a threshold. | Reporting and loss control. | ✓ / ✓ | P2 | S |
| 10 | **In-house membership / discount plans.** Monthly or annual fee, discount fee schedule, included cleanings, auto-billing on the saved card. | Big revenue driver for uninsured patients; Curve and Open Dental both support it. | ~ / ✓ | P1 | M |
| 11 | **Multiple office fee schedules:** standard, cash, per provider, and fee history. | Associates and specialists often have different fees. | ✓ / ✓ | P2 | M |
| 12 | **Collections workflow.** Finance charges, late fees, collection letters (30/60/90), bad-debt write-off, sending to a collection agency. | Standard A/R control. | ✓ / ~ | P2 | M |
| 13 | **Balance transfers between family members,** and income transfers. | Common front-desk correction. | ✓ / ✓ | P2 | S |
| 14 | **Batch eligibility** for tomorrow's schedule, parsing frequency and history from the 271 response. | Saves 1–2 hours of front-desk work a day. | ✓ / ✓ | P2 | M |
| 15 | **Pre-auth expiry dates,** with approved amounts feeding estimates. | Accuracy. | ✓ / ✓ | P3 | S |
| 16 | **Deposit slips and bank reconciliation.** | Office manager close-out. | ✓ / ~ | P2 | S |

### 2.2 Platform and practice operations

| # | Feature | Why | OD / Curve | Pri | Size |
|---|---|---|---|---|---|
| 17 | **Data conversion importer.** Open Dental (MySQL dump / CSV), Dentrix, Eaglesoft and Curve CSV: patients, families, insurance, ledger balances, appointments, recalls, treatment plans, documents. | **No office switches without their data.** Probably the single most important item for adoption. | ✓ / ✓ | P1 | L |
| 18 | **Multi-location (clinics).** Location entity; users across locations; per-location chairs, hours, fees and reports; consolidated reporting. | DSOs and growing practices; Curve Enterprise's main selling point. | ✓ / ✓ | P2 | L |
| 19 | **Custom roles and per-user permission overrides.** For example, a hygienist who can see their own production. | Every office has a different org chart. | ✓ / ✓ | P2 | M |
| 20 | **Report exports** to CSV/Excel and PDF, on every report. | Accountants and consultants ask on day one. | ✓ / ✓ | P1 | S |
| 21 | **Report filters** by provider, location, payer and date on every report; **saved and scheduled reports** emailed on a schedule. | Owners want the Monday-morning email. | ✓ / ✓ | P2 | M |
| 22 | **Custom query / report builder** (read-only SQL for admins, or a guided builder). | Open Dental's "User Query" is heavily used. | ✓ / ~ | P3 | M |
| 23 | **Public API and outbound webhooks** (appointments, patients, payments), with API keys and scopes. | Third-party integrations: Weave, NexHealth, Dental Intelligence. | ✓ / ~ | P2 | L |
| 24 | **Automated backups and restore**, including documents; point-in-time recovery guidance for Postgres. | HIPAA contingency plan. | ✓ / ✓ | P1 | M |
| 25 | **Custom patient fields.** | Every office tracks something unique. | ✓ / ✓ | P2 | S |
| 26 | **Patient merge,** plus a duplicate check on create. | Duplicates appear within weeks. | ✓ / ✓ | P2 | M |
| 27 | **Time clock and simple payroll export.** | Open Dental has it; small offices use it. | ✓ / ✗ | P3 | M |
| 28 | **Supply inventory.** | Open Dental has basic inventory. | ✓ / ✗ | P3 | M |
| 29 | **Installable app (PWA)** with an offline read-only view of today's schedule. | Resilience when the internet drops. | ~ / ~ | P3 | M |
| 30 | **Accessibility pass** (WCAG AA: labels, focus, contrast). | Legal exposure and quality. | ~ / ~ | P2 | M |
| 31 | **Spanish (and other language) support** for patient-facing pages and messages. | A large share of US patients. | ~ / ✓ | P2 | M |

### 2.3 Scheduling and front desk

| # | Feature | Why | OD / Curve | Pri | Size |
|---|---|---|---|---|---|
| 32 | **Waitlist** for patients without appointments, with preferred days and times, auto-matching when a slot opens, and a "text the first 5" blast. | Fills cancellations; high ROI. | ✓ / ✓ | P1 | M |
| 33 | **Schedule templates / block scheduling.** Reserve blocks by appointment type ("crowns 8–10"), with per-provider daily production goals. | How productive offices run. | ✓ / ✓ | P2 | M |
| 34 | **Pinboard / clipboard.** Drag an appointment off the schedule and drop it elsewhere or on another day. | Open Dental staff live on it. | ✓ / ~ | P2 | S |
| 35 | **Multi-step reminders** (e.g. 2 weeks, 2 days and same day; text and email) with confirmation levels. | No-show reduction. | ✓ / ✓ | P1 | M |
| 36 | **Recall types:** configurable (prophy, perio, BWX, FMX, pano, custom), with automated multi-touch recall sequences. | Hygiene revenue. | ✓ / ✓ | P1 | M |
| 37 | **Check-out workflow.** Collect payment, book the next visit or recall, print a walkout, all in one step. | Front-desk speed and reappointment rate. | ✓ / ✓ | P1 | M |
| 38 | **Patient flow timestamps** (arrived, seated, dismissed), with wait-time and running-late indicators. | Chair utilization. | ✓ / ✓ | P2 | S |
| 39 | **Complete appointment → complete its procedures** (and post charges) in one click. | The normal end-of-visit flow. | ✓ / ✓ | P1 | S |
| 40 | **Provider schedule exceptions:** date-specific hours, time off, alternating weeks. | Real provider schedules. | ✓ / ✓ | P1 | S |
| 41 | **Book the whole family** into back-to-back or side-by-side slots. | Common for kids. | ✓ / ✓ | P2 | M |
| 42 | **Instant online booking** into approved slots (optional), holding the slot while a request is pending; collect insurance and a deposit. | Curve and NexHealth-style self-scheduling. | ✓ / ✓ | P2 | M |
| 43 | **Referral tracking.** Referring doctors and referred-out, with referral letters and a report. | Specialists depend on it; GPs track sources. | ✓ / ✓ | P2 | M |
| 44 | **Texting inbox upgrades.** Unknown numbers (attach to patient), email threads, assignment, archiving, editable quick replies, MMS photos. | Front-desk communication hub. | ✓ / ✓ | P2 | M |
| 45 | **Custom forms builder:** consents (extraction, endo, sedation), HIPAA, financial policy, COVID/pre-op; auto-sent before visits; insurance card and ID photo upload. | Paperless office, Curve Forms. | ✓ / ✓ | P1 | L |
| 46 | **Patient appointment history** on the chart (past visits, no-shows, cancellations). | Basic context. | ✓ / ✓ | P1 | S |
| 47 | **Command palette actions** ("book for…", "text…", "take payment…"). | Speed. | ~ / ~ | P3 | S |

### 2.4 Clinical

| # | Feature | Why | OD / Curve | Pri | Size |
|---|---|---|---|---|---|
| 48 | **Primary and mixed dentition** on the chart (A–T), with supernumerary teeth. | Every pediatric and family patient. | ✓ / ✓ | P1 | M |
| 49 | **Graphical restorations:** crown, RCT, implant, bridge (pontic/abutment), veneer, sealant, extraction/missing graphics; quadrant and arch procedures (SRP D4341/4342, dentures). | Charting is the heart of the clinical side; SRP per quadrant is daily. | ✓ / ✓ | P1 | L |
| 50 | **Full perio chart:** recession, CAL (computed), mobility, furcation, plaque, suppuration, gingival margin; auto-advance entry; site-by-site exam comparison and graphs; touch-friendly bleeding entry. | Hygienists need a complete perio chart; perio claims need it as an attachment. | ✓ / ✓ | P1 | M |
| 51 | **Treatment plan editor.** Add or remove procedures, reorder, phases, alternative plans ("Option A implant / Option B bridge"), per-line fee override and discount, schedule straight from a phase. | Case acceptance workflow. | ✓ / ✓ | P1 | M |
| 52 | **Auto notes / procedure notes.** Completing a procedure pre-fills a note from a template with prompts (anesthetic, shade, materials); editable template library. | Documentation speed and compliance. | ✓ / ✓ | P1 | M |
| 53 | **Addenda on signed notes.** | Legal requirement. | ✓ / ✓ | P0 | S |
| 54 | **Structured medical history.** Coded allergies and medications, vitals and blood pressure, ASA class, premedication flag driving alerts, history versions with side-by-side review. | Safety. | ✓ / ✓ | P2 | M |
| 55 | **Image viewer.** Zoom, pan, brightness and contrast, rotate, measure, annotate; FMX mount templates; side-by-side comparison; DICOM rendering (dcmjs / cornerstone). | Curve ships integrated imaging; this is a visible gap. | ✓ / ✓ | P1 | L |
| 56 | **Direct sensor capture** (TWAIN bridge) as well as imaging-program bridges. | Offices without DEXIS or similar software. | ✓ / ✓ | P3 | L |
| 57 | **Procedure-specific informed consents** with signature, filed as a document. | Risk management. | ✓ / ✓ | P1 | M |
| 58 | **Lab directory and lab slips.** Link to a procedure, printable Rx slip, photo attachments. | Lab workflow. | ✓ / ~ | P3 | S |
| 59 | **Ortho module.** Ortho chart, contract billing (down payment plus monthly auto-billing), bracket and wire log, ortho lifetime max. | GP offices doing ortho or aligners. | ✓ / ~ | P3 | L |
| 60 | **Full CDT code set import** with treatment area, time units and auto-condition (extraction → missing). | Completeness. | ✓ / ✓ | P2 | S |
| 61 | **Voice perio entry.** | Hygienist productivity; Curve and newer PMSs advertise it. | ~ / ✓ | P3 | M |

### 2.5 Patient engagement and marketing

| # | Feature | Why | OD / Curve | Pri | Size |
|---|---|---|---|---|---|
| 62 | **Campaigns:** segmented mass text and email (reactivation, unscheduled treatment, birthdays, holiday closures) with templates, HTML email and scheduling. | Curve GRO-style marketing. | ~ / ✓ | P2 | M |
| 63 | **Editable message templates** for every automated message, with merge fields and a preview. | Offices want their own voice. | ✓ / ✓ | P2 | S |
| 64 | **Review routing.** Ask for satisfaction first, send happy patients to Google and route unhappy ones to the office. | Reputation. | ~ / ✓ | P2 | S |
| 65 | **Portal additions:** reschedule, request an appointment, secure messages, forms, statements/receipts download, and membership sign-up. | Patient self-service. | ✓ / ✓ | P2 | M |
| 66 | **Teledentistry** video visits (links only, via a partner). | Emergencies and consults. | ~ / ✓ | P3 | M |
| 67 | **Patient surveys / NPS.** | Quality tracking. | ~ / ✓ | P3 | S |

### 2.6 Reporting

| # | Report | Pri | Size |
|---|---|---|---|
| 68 | **Collections by provider** (needs item 8) and **production by provider with adjustments**; associate compensation basis. | P1 | M |
| 69 | **Aging by guarantor**, split into insurance and patient, "as of" any date; credit-balance report. | P1 | M |
| 70 | **Referral sources and referring-doctor report**, with production per source. | P2 | S |
| 71 | **Hygiene report:** production, reappointment, perio vs prophy ratio, recall effectiveness. | P2 | S |
| 72 | **Treatment plan report:** presented vs accepted vs scheduled vs completed, by provider. | P2 | S |
| 73 | **Write-off and adjustment report** by type. | P2 | S |
| 74 | **Audit log search** (date range, patient, user, action) with CSV export, beyond the current 500-row cap. | P1 | S |
| 75 | **End-of-day / month-end close** with locking (pairs with the lock date in Part 1). | P2 | S |

---

## Part 3 — Improving what we have

Each area lists what works, then the improvements, in priority order.

### Schedule / calendar
Works well: drag, resize and create; undo; live updates; conflict checks; open-time finder; production vs goal.
1. **P1** Week view with provider or chair columns (or a condensed multi-column week).
2. **P1** Configurable time grid: 5, 10 or 15 minutes.
3. **P1** Chair settings: default provider, hygiene flag, display order.
4. **P2** Appointment types with provider/assistant time patterns (e.g. `X//XX//`) and per-provider durations.
5. **P2** Blockouts: linked repeats (edit or delete the series), date ranges (holiday week), drag and resize, and rules like "only crown seats here" instead of hard blocks.
6. **P2** Per-appointment history (moved, rescheduled, who changed it) in the drawer.
7. **P2** Recurring series: "every 2nd Tuesday", an end date, and adding visits to an existing series.
8. **P3** Colour by provider, type or status as a toggle; print the day's schedule per provider.

### Front desk: huddle, route slip, follow-ups, requests
1. **P1** Follow-ups "Book" should carry the patient and their planned procedures into the booking form.
2. **P1** Recall tab gets a Book action, with the recall's due window pre-selected.
3. **P1** Online-booking Accept can change the time and chair; a pending request holds the slot.
4. **P2** Huddle performance: batch its queries (it runs about 8 per patient now).
5. **P2** Declined/hidden follow-ups should be stored on the server, not just hidden in the browser.
6. **P2** Referral source captured on online requests and on intake.

### Patients and families
1. **P1** Multiple phones (cell, home, work) with a preferred contact method and language.
2. **P1** Primary provider and primary hygienist on the patient.
3. **P2** Patient photo.
4. **P2** Relationship types in the family (spouse, child, dependent) and a second responsible party.
5. **P2** Unlinking a member moves or warns about their payment plans and cards.

### Chart
1. **P1** Chart larger and touch-first: bigger teeth, and a searchable procedure picker with favourites / "quick buttons" (Open Dental's most used feature).
2. **P1** Complete, edit or delete procedures from the chart; condition notes and editing.
3. **P1** Distinct colours per status (existing, treatment planned, completed today, existing-other) with a full legend; tooth-specific surface labels.
4. **P2** "Chart as of date" timeline slider.
5. **P2** Tooth history panel (everything that ever happened to #30).

### Perio
Beyond item 50: editable exams, provider and notes, missing teeth greyed out, and a printable perio chart suitable as a claim attachment.

### Treatment plans and case acceptance
1. **P1** Build a plan by selecting planned procedures on the chart ("add to plan").
2. **P1** Signed-plan snapshot and PDF (see Part 1).
3. **P2** Show insurance-remaining-this-year vs next year, and suggest splitting across benefit years.
4. **P2** Financing options on the plan (in-house plan, CareCredit/Sunbit link).
5. **P2** Don't offer "Accepted verbally" on a plan that was declined.

### Clinical notes
1. **P1** Editable template library, merge fields and prompts (pairs with item 52).
2. **P2** Link notes to an appointment; search and filter notes.
3. **P2** Signature shows the signer's name, credentials and time on printouts.

### Documents and imaging
1. **P1** Edit category, tooth and date after upload.
2. **P1** Thumbnails generated on the server (not full downloads).
3. **P2** A server-side queue of images that couldn't be matched to a patient, where staff can file them in bulk.
4. **P2** Document search; tags; scan-to-chart from a phone (QR upload link).

### Ledger and payments
1. **P1** Ledger UI: filter by type or provider; show the procedure, tooth and claim link on each line; see Part 1 for void.
2. **P1** Statement layout: pending insurance, estimated patient portion, aging, a payment plan line, a remittance stub, and a QR code to pay online.
3. **P2** Pay-link amount defaults to the patient's portion, not the full balance.
4. **P2** Receipts (print or email) for every payment.
5. **P2** Card-present payments (Stripe Terminal) at the front desk.
6. **P2** Payment plans: editable schedule, late fees, and the amount due shown on statements.

### Claims and EDI
1. **P1** Claims worklist: filters by payer, age and status; bulk actions; "needs attention" first.
2. **P1** Claim edit after rejection, with a diff of what changed; resubmit as a corrected claim.
3. **P2** Record insurance follow-up calls on the claim (like follow-up lists).
4. **P2** Print an ADA 2024 claim form (paper fallback).

### Eligibility
1. **P2** Show 271 frequency and history, remaining benefits and out-of-network values.
2. **P2** An eligibility badge on appointments ("verified 2 days ago").

### Messaging and portal
1. **P1** Opt-out rules everywhere (see Part 1).
2. **P2** Every automated message editable (item 63), with a preview on a phone mock-up.
3. **P2** Portal: download statements and receipts; update insurance with card photos.

### Reports and dashboard
1. **P1** CSV/PDF export and provider filter on every report (items 20–21).
2. **P1** Load only the selected tab; aging as one query.
3. **P2** Configurable KPI targets (currently hard-coded).
4. **P2** Separate insurance write-offs from discounts in the KPIs.

### Settings and admin
1. **P1** Settings search box.
2. **P2** Practice setup wizard for new offices (practice info → providers → chairs → fees → insurance → messaging → go live).
3. **P2** Audit log: date range, patient filter, export (item 74).
4. **P2** Admin-only visibility of SSO and integration settings.

### Platform quality
1. **P1** Error monitoring (Sentry-compatible) and structured logs.
2. **P1** End-to-end browser tests in CI for the core flows: book → check in → chart → complete → claim → ERA → statement.
3. **P2** Load test with a 50,000-patient database; add indexes; add pagination everywhere.
4. **P2** Keyboard shortcuts help sheet (`?`).

---

## Suggested build order

Each milestone is roughly 1–2 weeks and ends with tests on SQLite and Postgres and a browser walkthrough.

1. **Trustworthy numbers.** All of Part 1 (P0 fixes). This makes the software safe to use with real money.
2. **Insurance core.** Shared plans and benefits (items 2, 3), frequency limits, secondary claims and COB (1), procedure-level ERA and bulk EOB posting (4, 5), payment allocation (8), aging by guarantor and collections by provider (68, 69).
3. **Clinical core.** Primary teeth and graphic charting (48, 49), full perio (50), treatment plan editor (51), auto notes and templates (52, 53), chart polish.
4. **Front-desk core.** Complete-appointment flow and check-out (37, 39), recall types and sequences (36), multi-step reminders (35), waitlist (32), provider exceptions (40), appointment history (46).
5. **Switching.** Open Dental / Dentrix / Eaglesoft importer (17), report exports (20), backups (24), forms builder and consents (45, 57).
6. **Differentiators.** Membership plans (10), image viewer (55), claim attachments (6), campaigns and review routing (62–64), instant online booking (42).
7. **Growth.** Multi-location (18), custom roles (19), API and webhooks (23), schedule templates (33), pinboard (34), Spanish (31).

Later: ortho (59), time clock (27), inventory (28), teledentistry (66), voice perio (61), sensor capture (56), report builder (22).
