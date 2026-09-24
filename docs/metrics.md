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
