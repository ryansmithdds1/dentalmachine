# Capacity meter

## Definitions (CAP1–CAP2)
One calculation, `server/src/capacity.js` (`computeCapacity` is pure; `loadCapacityInputs` gathers the rows),
pinned by `server/test/capacity.test.js`. Screen: `docs/workflows/specs/CAP-capacity.md`. Nothing here is money.

**Kinds.** Doctor = dentists and specialists; hygiene = hygienists (the same split as `production.js`). A visit
type belongs to the kind of its `provider_type`. If an office has no hygienist, hygiene visits count for the
doctors (and the other way round).

**Visit kinds.**
- *New patient* — the type chosen in the targets, else the active type with D0150, else one named "new patient".
- *Emergency* — the chosen type, else the one with D0140, else one named emergency / limited / toothache / urgent.
- *Recall* — the recall types' own visit types (`recall_types.appointment_type_id`, else a hygiene type sharing a
  recall code; x-ray-only recall types — all codes D02xx/D03xx — ride along with the cleaning).
- *Treatment* — every other active non-hygiene type, in lengths of 30, 60 and 90 minutes.

**Which office a provider is in on a date:** their perfect-day plan's office, else where most of that day's visits
are, else their home office (the office of their usual chair, else where most of their visits are). Rows without
an office count everywhere only when the practice has one office.

**Available minutes** (per provider per day in the office): their own hours (`providers.working_hours`, with
alternate weeks), else the office's hours (the office's own, else the practice's); a one-off exception
(`provider_exceptions`, e.g. a day off) replaces them; minus blocked time (their blockouts and whole-office ones —
holidays; a chair's own block doesn't take a provider's time). *Reserved* blocks and perfect-day blocks stay
available time (they're bookable, only by some visits).

**Booked %** = booked minutes ÷ available minutes, over the next 14 / 28 / 56 days from today (practice-local).
Booked minutes are the live visits (not cancelled / no-show) merged (a double booking counts once) and clipped to
available time. The meter's colour uses the 4-week figure.

**First opening** — the earliest start (10-minute grid, after "now" today) where the visit's length fits for any
provider of the kind in the office, around visits, blocked time, online requests holding their time (paid deposit,
open checkout, or two days), reserved blocks for other types, and perfect-day blocks kept for other types until
their release time. The type's per-provider length applies. Looked for up to 120 days; none = red. Days are
calendar days from today; emergencies are counted in **business days** (days the office is open after today).

**Demand.**
- *Recall* — active patients' recalls that are due / contacted and not on a visit, one visit per patient (the
  longest one they're due for, at the earliest date), in hours by the recall visit type's length:
  due in the next 4 weeks, the next 8 weeks, and overdue (the last 12 months; older is reactivation, not capacity).
- *Unscheduled treatment* — the same rows as the schedule's "still to book" (`production.js`): planned
  procedures on no visit, for active patients; hours from the code's time units (10 minutes each) or, when unset,
  by category (diagnostic 20, preventive 40, restorative 60, endodontics 90, periodontics 60, prosthodontics 90,
  oral surgery 60, orthodontics 30, implants 90, adjunctive 20 minutes). Kind by the procedure's provider, else
  preventive = hygiene.
- *ASAP list* — booked visits flagged ASAP (future, scheduled/confirmed) plus the waitlist (waiting).
- *Online requests* — pending booking requests, and how many days the oldest has waited.
  (ASAP and requests go to the kind of their provider, else hygiene when the reason mentions a cleaning/recall,
  else the new-patient visit's kind for a new patient, else doctor.)
- *New patients / emergencies* — visits of those types in the last 8 weeks (the rate new demand arrives at).

**Open vs needed (hours a week, next 8 weeks).** Open = (available − booked) ÷ 8. Needed = recall due in 8 weeks ÷ 8
+ overdue recall ÷ backlog weeks + unscheduled treatment ÷ backlog weeks + new-patient and emergency hours a week
(last 8 weeks). Gap = open − needed.

**Colours** (targets are the practice's, `practices.capacity_targets`):
- Wait: ≤ target green; up to half the target again (at least one day) amber; beyond, or none found, red.
- Booked %: inside the band green; below it amber (within 10 points), then red; above it amber, red from halfway
  between the top of the band and 100%.
- Open vs needed: enough open time green; short by less than half an average working day amber; more red.
- A kind's status is its worst meter.

**Recommendations** (fixed rules, red first, each with its numbers):
- *Add a hygiene day* — the recall wait is over target, or hygiene is booked over the band for 4 weeks: "Hygiene is
  booked N weeks out and H recall hours are due in the next month: add a hygiene day (about V more visits a week)".
  V = a hygiene day's hours ÷ the recall visit length; more days when the weekly shortfall covers them (up to 5).
- *Fill hygiene* — booked under the band with the recall wait on target: work the recall list and ASAP list.
- *Doctor time* — a doctor's first 60-minute treatment opening is over target: extend the working day that ends
  earliest (then the fullest, then the later in the week) by 1–2 hours (never past 7 pm); when the wait is red or
  the doctors are short more than 2 hours a week, also "or open a <first weekday they don't work>".
- *Fill a doctor's chair* — booked under the band: call the unscheduled treatment list.
- *Hold emergency slots* — the emergency wait is over target: hold ⌈emergencies a day (last 8 weeks)⌉ slots a day
  (1–4).
- *New-patient openings* — the new-patient wait is over target: keep ⌈new patients a week⌉ openings a week (2–20).
- *Answer online requests* — any pending a day or more (red from 3 days).
- *Short on hours* — open vs needed is red and no add-time advice was given for that kind.

**Trend.** `capacity_snapshots`: one row per practice, scope (`practice` / `location:<id>`), day and kind with the
booked % (tenths), first-opening days, open and needed hours a week (tenths), recall hours, unscheduled hours, ASAP
and request counts, written after 9 pm practice-local by `runCapacitySnapshots` (hourly job; a repeat does
nothing). Derived data: rows older than two years are hard-deleted.

**Metric emails.** `capacitySummary(db, practiceId, { locationId, limit })` → `{ status, lines, kinds,
recommendations }` for the huddle / weekly email.

**Not modelled (yet):** time patterns (assistant vs provider time) — a visit's whole length counts as booked, as in
booking's own slot search; chairs (operatory) availability; treatment that will come out of upcoming hygiene exams.
