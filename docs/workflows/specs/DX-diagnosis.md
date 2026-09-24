# DX — Diagnosis totals and conversion by provider (DX1–DX2, EX1–EX2)

**Trigger:** the doctor wants to know, during the day, whether they are diagnosing enough work to keep future
production up; the owner wants to see, for every provider and for new patient, recall, perio and emergency exams,
how much is diagnosed and how much of it is presented, accepted, scheduled and completed.
**Who:** doctors and hygienists (their own numbers: `reports:own` with their login linked to a provider, or
`reports:read`), owner / office manager (`reports:read`: everyone's). Goals and exam values: administrators.
**Data:** nothing new is stored for DX: exams and diagnosed work are `procedures` (exam codes, `created_at`,
`completed_at`, `status`), `treatment_plans` (status, `signed_at`, `option_group`), `appointments`;
goals are `metric_goals` (metric `diagnosed`). EX2 overrides: `exam_values` (see "Schema" below).
The definition is `server/src/diagnosis.js`; every rule is written out in `docs/metrics.md`
("Diagnosis & conversion", "The value of an exam").

## Target: always visible, one step to the detail
| Step | Keyboard | Clicks |
|---|---|---|
| See today / this week / this month diagnosed vs goal | — (the chip on the schedule header / dashboard) | 0 |
| Open the funnel | Ctrl/⌘K → "Metrics: Diagnosis & conversion" → Enter | 1 (the chip, or the tab) |
| Change dates / exam type / provider / office | Tab + Enter on the segmented buttons and selects | 1 each |
| See the patients behind a step | Enter on a funnel step, or the "Which patients" buttons | 1 |
| Open a patient | Enter on the name (the active patient follows) | 1 |
| Download CSV | Tab to "CSV", Enter | 1 |

## What's there
- **DiagnosisChip** (`client/src/components/DiagnosisChip.jsx`): "Diagnosed · Today $… · Week $… · Month $… / goal"
  with a small progress bar, coloured by standing (good / watch / behind). Refreshes every 5 minutes and on
  `dm:refresh`. Renders nothing for people without report access, so it can be mounted anywhere. Links to the tab.
  Props: `providerId` (a specific provider), `practice` (practice totals instead of the signed-in provider's).
- **Reports → Metrics → Diagnosis & conversion** (`?tab=diagnosis`,
  `client/src/components/metrics/DiagnosisConversion.jsx`): running totals (and a row per provider), the funnel
  (diagnosed → presented → accepted → scheduled → completed, % of diagnosed and of the step before, median days
  to book and to finish), the table by exam type, the comparison between providers ($ per exam, % scheduled,
  % completed, still open), the trend by month of the exam, and the patients with what is still open and the
  next step (present it, get a yes, book it). Dates: this month, last month, 3/6/12 months, year to date.
- **Practice numbers tab:** a `Treatment diagnosed` tile (goal, trend, drill-down to the exams behind it).
- **Report library:** "Diagnosis & conversion by provider" (Treatment) — rows per provider × exam type; can be
  saved and emailed like the other library reports (no patient names).
- **Emails:** end of day — diagnosed today / week / month per provider against their goal; weekly and monthly —
  the funnel by exam type and by provider. Owner, office manager and hygienist (her own) digests.
- **API:** `GET /api/diagnosis/running`, `GET /api/diagnosis/funnel` (`format=csv`), `GET /api/diagnosis/patients`,
  `GET /api/exam-values`, `PUT /api/exam-values`. Functions for other screens: `diagnosisFunnel`,
  `diagnosisPatients` (diagnosis.js), `diagnosisRunning`, `examValues`, `examsForDay` (metrics.js).

## How it's safe
- Read-only except goals and exam values, which go through the existing goal route / an admin-only route, both
  audited with before → after. Removing an exam value override is a configuration delete, audited.
- Every id is checked against the practice (404); `reports:own` users are forced to their own provider whatever
  they ask for; people limited to some offices only see their offices; practices never see each other's numbers.
- Patient lists (drill-down) are audited as `metrics.drill_down`; CSV exports as `diagnosis.export`.
- Emails carry totals only.
- Cohort rule: nothing is ever "moved" between months — later work is credited to the exam date — so the numbers
  for a past month only grow as its patients finish treatment, and never double count.

## Edge cases (all pinned in `server/test/diagnosis.test.js`)
- Two exam codes on one day (D0150 + D0140): one exam, the new-patient one.
- The same tooth/code charted again at the next recall while still open: one finding, credited to the first exam;
  if the later copy is the one that gets done, the first exam gets the credit. Charted again after it was done:
  new work.
- Treatment charted on a non-exam day, cancelled procedures, x-rays / cleanings / fluoride: not diagnosed.
- An exam whose charge is voided (un-completed): no exam, so nothing diagnosed at it.
- Treatment on a cancelled or missed visit: not scheduled. Done at the exam visit itself: scheduled and completed
  the same day (0 days).
- Alternative options: one option counts (the accepted one, else the first offered).
- Hygiene visit: credit to the examining doctor and to the hygienist; practice totals count the exam once.

## Open decisions for the owner (defaults in place)
1. **Same day only.** Treatment charted the day after an exam (charting catch-up) isn't counted. A 1–2 day window is
   a one-line change (`created_on` match in `loadDiagnoses`).
2. **D0150 = new patient always**, D0180 = its own "perio" type. Both can be "first exam" (new patient only for the
   patient's first routine exam here). Stored choices need a settings table — until then `examRules()` returns
   the defaults (see "Schema").
3. **Presented = on a treatment plan** (as case acceptance counts it). A stricter "presented" would use
   `treatment_plans.presented_at`, which is only set when the plan is sent for signature.
4. **Credit** goes to the provider on the exam procedure. Offices that post exam codes under the hygienist will see
   the hygienist as examiner; post exam codes under the doctor who did the exam.
5. **Expected after PPO** caps the fee at the in-network fee schedule only (no coverage percentages or maximums).
6. **Exam value** uses completed work within 1/3/5 months over a 12-month window ending H months ago; with fewer than
   10 exams it is flagged `low_sample` but still used unless overridden.

## Schema (to add to `server/src/db.js`)
`exam_values` (EX2 overrides; the code reads it and treats a missing table as "no overrides"; `PUT
/api/exam-values` answers 503 until it exists):

```sql
-- The owner's own value of an exam (EX2), per exam type and horizon; overrides the learned value. Configuration:
-- set, changed and removed by administrators, each audited (exam_value.set / change / clear).
CREATE TABLE IF NOT EXISTS exam_values (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  exam_type TEXT NOT NULL CHECK (exam_type IN ('new_patient','recall','perio','emergency')),
  horizon_months INTEGER NOT NULL CHECK (horizon_months IN (1,3,5)),
  value_cents INTEGER NOT NULL,
  set_by INTEGER REFERENCES users(id),
  set_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, exam_type, horizon_months)
);
```

Optional, for decision 2 (stored exam-type rules): `diagnosis_settings (practice_id INTEGER PRIMARY KEY REFERENCES
practices(id), d0150 TEXT NOT NULL DEFAULT 'new_patient', d0180 TEXT NOT NULL DEFAULT 'perio', updated_by, updated_at)`,
read by `examRules()` and validated by `cleanRules()`.

## Acceptance
- `server/test/diagnosis.test.js` (SQLite and Postgres): exam classification; diagnosed rule and exclusions;
  re-diagnosis not double counted; cohort crediting; presented / accepted / scheduled / completed incl. cancelled
  and missed visits; options; PPO expected; provider and hygienist attribution, office filter, report library;
  running totals vs goals and un-completing an exam; permissions (`reports:own` sees only their own, no report
  permission → 403), practice isolation, CSV audited, emails without names; exam values per horizon, overrides
  (audited, admin only); exams on a day.
