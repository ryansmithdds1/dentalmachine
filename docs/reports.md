# Report library

The ready-made reports under **Reports → Report library**. Each is declared once in `server/src/reportlibrary.js`
(its filters, columns, totals and SQL), runs only over the signed-in practice and the offices the person may see,
and is served by `GET /api/report-library` (list) and `GET /api/report-library/:id` (run; `?format=csv` downloads
a spreadsheet and is audited as `report.export`).

Rules every report follows:

- Production, collections, adjustments and balances come from the ledger only (`SUM(amount)`, integer cents,
  voided entries excluded) — the same numbers as the ledger and statements.
- Filters are validated on the server: a bad date or id is a 400, another practice's id a 404, an office the
  person can't see a 403.
- At most 5,000 rows are returned; the totals row always covers every matching row.
- Reports that list patients (marked PHI below) need the same permissions as the screens they come from; when
  one is saved and emailed on a schedule, the email carries totals only.
- Every report (except admin-only ones) can be saved and scheduled from the Saved & scheduled tab (`lib.<id>`).

Known approximations: **Schedule utilization** counts open time from office and provider hours without
subtracting days off or blockouts; **Eligibility not verified** means the primary policy has had no successful
check in the last 30 days.

| Category | Report | Id | Notes |
|---|---|---|---|
| Production | Production by provider | `production-by-provider` |  |
| Production | Production by procedure code | `production-by-code` |  |
| Production | Production by category | `production-by-category` |  |
| Production | Production by day | `production-by-day` |  |
| Production | Gross vs. net production | `gross-vs-net-production` |  |
| Production | Scheduled production | `scheduled-production` |  |
| Production | Hygiene production & reappointment | `hygiene-production` |  |
| Collections | Collections by provider | `collections-by-provider` |  |
| Collections | Collections by payment type | `collections-by-payment-type` |  |
| Collections | Insurance vs. patient collections | `insurance-vs-patient-collections` |  |
| Collections | Collection percentage | `collection-percentage` |  |
| Collections | Payments journal | `daily-payments` | PHI |
| Collections | Adjustments & write-offs by type | `adjustments-by-type` |  |
| Collections | Refunds | `refunds` | PHI |
| Accounts receivable | A/R aging by family | `aging-by-family` | PHI |
| Accounts receivable | Insurance aging by carrier | `aging-by-carrier` |  |
| Accounts receivable | Credit balances | `credit-balances` | PHI |
| Accounts receivable | Outstanding claims by age | `outstanding-claims` | PHI |
| Accounts receivable | Claims not sent | `claims-not-sent` | PHI |
| Accounts receivable | Denied claims | `denied-claims` | PHI |
| Patients | New patients by referral source | `new-patients-by-source` |  |
| Patients | Active patient count | `active-patients` |  |
| Patients | Patients without a next visit | `patients-without-next-visit` | PHI |
| Patients | Patient birthdays | `birthdays` | PHI |
| Patients | Patients by insurance plan | `patients-by-insurance-plan` |  |
| Patients | No-show & cancellation rate | `no-show-cancel-rate` |  |
| Treatment | Unscheduled treatment | `unscheduled-treatment` | PHI |
| Treatment | Treatment plan acceptance rate | `treatment-acceptance` |  |
| Treatment | Case acceptance by provider | `case-acceptance-by-provider` |  |
| Treatment | Pending pre-authorizations | `pending-preauths` | PHI |
| Scheduling | Appointment list | `appointments-by-day` | PHI |
| Scheduling | Broken appointments | `broken-appointments` | PHI |
| Scheduling | Schedule utilization | `schedule-utilization` |  |
| Scheduling | ASAP list | `asap-list` | PHI |
| Insurance | Fee schedule comparison | `fee-schedule-comparison` |  |
| Insurance | PPO write-offs by carrier | `ppo-writeoffs-by-carrier` |  |
| Insurance | Insurance payments by carrier | `insurance-payments-by-carrier` |  |
| Insurance | Eligibility not verified | `eligibility-not-verified` | PHI |
| Office | Referrals out | `referrals-out` | PHI |
| Office | Lab cases outstanding | `lab-cases-outstanding` | PHI |
| Office | Inventory to reorder | `inventory-reorder` |  |
| Office | Audit summary | `audit-summary` | admin only; not for office-limited staff |
| Office | End-of-day summary | `end-of-day` |  |
| Office | Month-end summary | `month-end` |  |
