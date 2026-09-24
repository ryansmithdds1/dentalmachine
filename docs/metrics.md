# Metrics: one definition per KPI

Every number on Reports → Metrics, Reports → Practice KPIs (`/analytics`), the metric emails and the
"areas to work on" comes from **one calculation**: `server/src/metrics.js`. Nothing else should compute these
numbers; a new screen or report calls `computeMetrics` / `compareMetrics` / `metricRows`. The tests in
`server/test/metrics.test.js` pin each definition below. Change a definition here, in `metrics.js` and in the tests
together.

## Ground rules
- **Money comes from the ledger** (`ledger_entries`), in integer cents, as `SUM(amount)`. Voided entries
  (`voided_at`) and their reversals (`reverses_id`) are **both left out**, so a voided charge disappears from the
  period it was posted in. (The day sheet and closed books still show the reversal on the day it was posted:
  books never change after the fact, metrics show the work as it stands.)
- **Dates are practice-local.** Ledger `entry_date` and appointment `start_time` are already local; `created_at`
  columns (UTC) are compared through the practice's time zone (`utcRange`).
- **Visits** come from `appointments`; **treatment** from `procedures` and `treatment_plans`.
- A **range** is inclusive `[from, to]`. Visits "up to today" never count the future as kept or broken.
- **Filters:** one provider and/or one office (`location_id`). A metric that doesn't make sense for a filter
  returns `null` ("not tracked for this filter") rather than a misleading number.
- Every number has a **drill-down** (`metricRows`, `GET /api/metrics/:key/rows`) listing the rows behind it; the
  rows add up to the number. Looking at them is audited (`metrics.drill_down`).

## The metrics

| Key | Name | Exactly what's counted |
|---|---|---|
| `production_gross` | Gross production | `SUM(amount)` of live `charge` entries dated in the range. Provider: charges with their `provider_id`. Office: the entry's `location_id`. |
| `adjustments` | Write-offs & discounts | Live `adjustment` entries with a negative amount (credits), as a positive total, split into **insurance write-offs** (type "Insurance write-off" or on a claim), **other write-offs** (type mentions write-off / bad debt / collection) and **discounts** (the rest). Positive adjustments (finance charges, late fees) are not write-offs. Provider: their share by payment allocation. |
| `production_net` | Net production | `production_gross − adjustments`. |
| `collections` | Collections | Live `payment` + `insurance_payment` entries received in the range, minus live `refund`s paid in the range. Provider: their share of each payment and insurance payment by allocation (`allocation.js`: insurance to the claim's procedures, the rest to the oldest charges first); refunds aren't split by provider. |
| `collection_rate` | Collection rate | `collections / production_net × 100`, one decimal. |
| `new_patients` | New patients | Patients whose **first completed visit** falls in the range: the earliest of a `completed` appointment's date or a live charge for a completed procedure. A chart made without a visit (an import, a phone enquiry) isn't a new patient; merged duplicates (`merged_into_id`) don't count. Office: the patient's home office. Not tracked per provider. Also split by `referral_source`. |
| `case_acceptance` | Case acceptance | For treatment plans **created** in the range: fees of their non-cancelled procedures on plans now `accepted` or `completed`, over fees of all their non-cancelled procedures. Provider/office: the procedure's. |
| `diagnosed` | Treatment diagnosed | The office fees of the treatment **diagnosed at exams** whose date is in the range — the exact rule is in *Diagnosis & conversion* below (`diagnosis.js`). Provider: the examining provider, or the hygienist of the visit. Office: the exam's. Also the PPO-expected amount and the number of exams. |
| `hygiene_reappointment` | Hygiene reappointment | `completed` visits with a hygienist in the range where the patient already had a later, live visit **booked by the day of the visit**; over all such visits. |
| `broken_appointments` | Broken appointments | Visits in the range (up to today) with status `no_show` or `cancelled`. |
| `broken_rate` | No-show & cancel rate | Broken over kept (`completed`, `checked_in`, `in_chair`) + broken. |
| `unscheduled_treatment` | Unscheduled treatment | Fees of `planned` procedures for active, unmerged patients that aren't on a live visit (no appointment, or one that was cancelled / missed), on no plan or a plan still `proposed` / `accepted`. |
| `ar_total` | Owed to the practice | Positive household balances (`agingReport`, family), as of the date. |
| `ar_over_90` | A/R over 90 days | The part of those balances older than 90 days (newest debits are paid last). |
| `claims_over_30` | Claims waiting over 30 days | Claims still `submitted`, sent more than 30 days before the date. Also the insurance still expected on them. |
| `recall_due` | Recall due | Recall (active patients, not `inactive`) with status `due`/`contacted` and a due date in the next 30 days. |
| `recall_overdue` | Recall overdue | The same, due before the date. |
| `recall_current_rate` | Current on recall | Recall not yet due, or already `scheduled`, over all recall for active patients (not `inactive`). Provider: patients whose primary hygienist or provider it is. |
| `visits` | Visits booked | Appointments in the range not `cancelled` / `no_show`. |
| `scheduled_production` | Scheduled production | Fees of non-cancelled procedures on those visits (the schedule screen's rule). |
| `unconfirmed` | Unconfirmed | Those visits still `scheduled` (not confirmed). |
| `insurance_to_verify` | Insurance to verify | Those visits whose patient's active primary (else secondary) policy has no eligibility check in the 30 days before the visit (the morning huddle's rule). |
| `balances_due` | Balances to collect | What the households of the booked patients owe, each household once. |
| `open_gaps` | Open gaps | Free stretches of **30 minutes or more** inside each active provider's hours on open office days from today on (past time can't be filled), not taken by a live visit or a `blocked` blockout (reserved blocks are still open time). Also the total minutes. |

"Right now" metrics (`unscheduled_treatment`, `ar_*`, `claims_over_30`, `recall_*`) show today's value. Their trend
is against the value stored one period-length ago: the metric-email job saves each practice's and office's values
every evening (`metric_snapshots`, derived data). A/R is recalculated exactly for any past date.

> **Scheduled production** is calculated here with the same rule as the schedule screen. The perfect-day /
> block scheduling work (`production.js`, day templates with goals) computes production per schedule column; when
> it lands, both should call one function (move the rule into one module and have the other import it).

## Diagnosis & conversion (DX1–DX2)
One definition, in `server/src/diagnosis.js`; the `diagnosed` KPI, the running totals (`diagnosisRunning` in
`metrics.js`), Reports → Metrics → *Diagnosis & conversion*, the report library's *Diagnosis & conversion by
provider*, and the emails all call it. `server/test/diagnosis.test.js` pins each rule.

**Exams.** A completed procedure (`status = 'completed'`, dated by its practice-local `completed_at`) with an exam
code, for a patient who isn't a merged duplicate. **One exam per patient per day**; when a day has several exam
codes the type is the first of: new patient, perio, recall, emergency. The exam's provider is the procedure's
`provider_id` (else the visit's), its office the procedure's `location_id` (else the visit's, else the patient's
home office). An exam whose charge is voided goes back to planned, so it is no longer an exam.

| Code | Exam type |
|---|---|
| D0150 comprehensive | **new patient** (configurable: or recall, or "first exam" — new patient only when it is the patient's first D0150/D0180/D0120/D0145 here) |
| D0120 periodic, D0145 under 3 | **recall** |
| D0180 comprehensive periodontal | **perio** (configurable: new patient, recall or "first exam") |
| D0140 limited, D0160 detailed problem-focused, D0170 re-evaluation, D9110 palliative | **emergency** |

The configurable choices are read through `examRules()` (defaults for now; see the spec for the settings table).

**Diagnosed.** A procedure is diagnosed at an exam when it is **treatment** — any category except `diagnostic`
and `preventive` (so not exams, x-rays, cleanings, fluoride or sealants) — charted for the patient on the exam's
practice-local date (`created_at`, converted from UTC), and not `cancelled`. Treatment charted on a day without a
completed exam is not "from an exam" and is not counted.
- **No double counting.** Procedures with the same patient, code, tooth, surfaces (in any order) and area are one
  *finding*. A later copy joins the earlier finding unless the earlier one had already been completed before the
  copy was charted (then the tooth needs the work again: a new finding). A finding counts once, for the exam where
  it was **first** charted, at the first copy's fee; if any copy is booked or done, the finding is.
- **Alternative options** (treatment plans sharing an `option_group`): only one option is diagnosed work — the
  accepted (or signed) one, else the first option offered. Declined options' work is cancelled on acceptance.
- **Money** is the office fee on the procedure (integer cents). **Expected after PPO** caps each fee at the
  patient's active primary policy's fee schedule (the plan's, else the carrier's) via `resolveFee` on the day the
  work was done (else the day it was diagnosed) — an estimate, labelled as one; no insurance percentages.

**The funnel** — each step for a finding, *as it stands now*. Each later step implies the earlier ones (work
that was booked was accepted and presented), so the steps never go up:
1. **Presented**: on a treatment plan (the same rule as case acceptance, where making a plan is presenting it).
2. **Accepted**: its plan is `accepted` or `completed`, or was signed (`signed_at`).
3. **Scheduled**: on a visit that isn't cancelled or a no-show, or already completed.
4. **Completed**: `status = 'completed'` (its charge is live; voiding the charge un-completes it).

**Cohorts.** Everything is by **exam date**: work finished months later is credited to the exam where it was
diagnosed, never to the month it was done, so a recent month's conversion keeps rising. Conversion % is shown both
as a share of the step before (`step_pct`) and of everything diagnosed (`of_diagnosed_pct`). **Days to schedule**:
from the diagnosis date to the day the visit was booked (the appointment's `created_at`, local; not before the
diagnosis), or to the completion day for work done without a booked visit; **days to complete**: diagnosis to
completion. Both are medians over the findings that got there.

**Who gets the credit.** The examining provider; and when the exam happened at a **hygiene visit** (the visit's
provider is a hygienist other than the examiner), the hygienist too ("hygiene-generated treatment", shown
separately as `at_hygiene_visits`). Provider rows can therefore add up to more than the practice total, which
counts each exam once. A provider filter keeps the exams they examined or hosted. `reports:own` users only ever
see their own provider's numbers.

**Running totals (DX1).** Today, this week (from Monday) and this month so far, against the `diagnosed` goal
(`metric_goals`, per month, prorated by open office days like every monthly goal; a provider never borrows the
practice's goal). `GET /api/diagnosis/running` (the signed-in provider's own numbers when their login is linked,
`scope=practice` for the practice, `per_provider=1` for a row per provider with `reports:read`).

**Endpoints.** `GET /api/diagnosis/funnel` (`period` = the usual ones or `last_3_months` / `last_6_months` /
`last_12_months`, or `from`/`to`; `provider_id`, `location_id`, `exam_type`; `format=csv` downloads it and is
audited as `diagnosis.export`); `GET /api/diagnosis/patients` (one row per patient exam with what is still open;
`stage` = open, all, or the step the work stopped at; audited as a drill-down).

**Emails.** End of day: diagnosed today / this week / this month, per provider with their goal. Weekly and monthly:
the funnel for the period's exams, by exam type and by provider. Totals only — no patient names. Owner, office
manager and hygienist audiences (a hygienist's is her own); not the billing digest.

## The value of an exam (EX1–EX2)
**Learned value** (`examValues(db, practiceId, { providerId, horizon })` in `metrics.js`) — per exam type, for a
horizon of **1, 3 or 5 months** (default 5): take the exams (as above) from the **12 months that ended H months
ago** — for 5 months, exams from 17 to 5 months before today; for 3 months, 15 to 3; for 1 month, 13 to 1 — so
every exam has had its full H months. Value = the office fees of the treatment diagnosed at those exams **and
completed within H months of the exam date**, divided by the number of exams (an exam with nothing diagnosed counts
as $0). Also returned: diagnosed per exam, the number of exams, the window, and `low_sample` (fewer than 10 exams).
With a provider: the exams they examined or hosted (as in the funnel). **Override:** the owner may set their own
value per exam type and horizon (`exam_values`, `PUT /api/exam-values`, administrators, audited as
`exam_value.set/change/clear`); `used` = the override when set, else the learned value. `GET /api/exam-values`
shows all three for each horizon.

**Exams on a day** (`examsForDay(db, practiceId, date, { locationId })`): the day's visits that aren't cancelled
or missed; each patient's exam codes from the procedures on those visits (planned or done), or — for a visit with
none — its visit type's codes, plus exams charted done that day without a visit. One exam per patient, typed as
above. Returns the count per type and how many are already done.

## Goals and benchmarks
Goals live in `metric_goals`, one per metric and scope: the whole practice, one office, or one provider
(`scope_key`). Money in cents, percentages in tenths of a percent, counts as counts. Money and count goals are
**per month** (scheduled production: **per day**), and a range gets the share for its open office days (a week of
5 open days out of March's 22 gets 5/22 of March's goal). Where there's no goal:
1. production and scheduled production use the practice's (or the provider's) **daily goal** from Settings ×
   open days;
2. percentages use the practice's own KPI targets (`practices.kpi_targets`, set on Practice KPIs);
3. else the industry **benchmark**: collection rate 98%, case acceptance 60%, hygiene reappointment 90%,
   no-show & cancel rate ≤ 10%, current on recall 70%.

A provider or an office never borrows the practice's goal. Standing: **good** (at or past goal), **watch**
(within 10%), **behind**. Goals are set by administrators (`PUT /api/metric-goals`), audited, and removable.

## Comparisons
Each metric is compared with the **period before** (a whole month with the previous month; month-to-date with the
same days last month; a single day in a digest with the same weekday a week earlier) and the **same dates last
year**. Before the practice's first ledger entry there is nothing to compare with, so no comparison is shown.

## Areas to work on
`areasForImprovement` (in `digests.js`) scores each metric by how far it is from its goal (as a share of the goal)
or how much it moved the wrong way since the period before (counts under 5 aren't trended — one patient is not a
trend), and picks the worst **two or three**. Each comes with the list behind it — the patients to call, the
claims to chase, the open times — and a link to the drill-down in the app. On the morning huddle, unconfirmed
visits and insurance to check (as a share of the day's visits) and open gaps are the candidates.

## Emails (K1, K4)
- **Digests** (`digests.js`): the morning huddle (today's schedule), end of day (the day's numbers, plus tomorrow),
  weekly (last Monday–Sunday) and monthly (last month). Each person's version depends on their **audience**
  (owner, office manager, hygienist, billing) — see `CONTENT`. A hygienist's digest is their own numbers when their
  login is linked to a provider.
- **Who gets what** (`digest_subscriptions`): staff only, one row per person and digest, with a send time in the
  practice's time zone and optionally one office. Never deleted: `active` / `paused` / `unsubscribed`.
- **When:** `runDigests` runs every few minutes. A digest is due on its day (huddle and end of day only on open
  office days; weekly on Mondays; monthly on the 1st) once the local time passes its send time — never the next
  day. Before sending it **claims** `(subscription, period)` in `digest_sends` (unique), so a restart or a second
  server can't send it twice. A failed send is retried up to three times that day.
- **Failures** raise a Needs attention item (`digest:<subscription>`), resolved by the next successful send; a
  bounce reported by SendGrid raises `digest-bounce:<subscription>`, resolved when a later one is delivered.
- **Sending log:** every email is a `messages` row (kind `digest` / `digest_test`, no patient) — the same log whose
  delivery / bounce status SendGrid's event webhook fills in; the provider call goes through `loggedFetch`
  (Connection activity). In development and tests the email driver is `log` (nothing is sent).
- **Unsubscribe:** a signed link (HMAC of the subscription id with the app secret) at the bottom of every email and
  in the `List-Unsubscribe` / `List-Unsubscribe-Post` headers (one click in mail programs). Opening the link shows a
  page with one button (so link scanners can't unsubscribe anyone); only the person can turn it back on.
- **Patient detail:** first name and last initial, counts and days waiting — never full names, contact details,
  dates of birth or clinical detail. The app holds the rest behind sign-in.
- **AI summary** (optional, off by default, Settings → Metric emails): two or three plain sentences written from
  the **aggregate numbers only** (`aiInput` — labels, totals, goals, the names of the flagged metrics), clearly
  labelled "Written by AI", recorded in the audit log with source `ai`. `DIGEST_AI=sandbox` gives fixed text for
  demos and tests; if the AI fails the email goes without it and a Needs attention item says so.
- **Staff emails** (`email/templates.js`): the same layout for "task assigned", "lab case overdue" and "claim
  denied", sent with `sendStaffEmail` (`email/send.js`).
- **BAA:** even first names with an initial are patient information. Before turning on names in emails, confirm the
  practice's email provider is covered by a business associate agreement. Settings → Metric emails has a switch
  that leaves names out entirely (the lists become counts with a link into the app).
