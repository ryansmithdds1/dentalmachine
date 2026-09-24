# 01 · Search/open a patient

**Trigger:** a patient calls, walks up, or is next on the schedule. **Who:** everyone, 100+ times a day.
**Data needed:** anything the person has in hand: part of a name (maybe misspelled), a phone number, a birth date in
any format, our chart number or the old system's.

**Today (audit):** Ctrl/⌘K, type, Enter = 3 actions — but exact-substring search only (no typos, DOB only as
YYYY-MM-DD, no old chart numbers), no recent patients, the first letter typed after Ctrl/⌘K was lost, and a chart
with an office alert opened a dialog that had to be dismissed.

**Budget:** 3 actions, 4 s.

**Redesign:** `patientsearch.js` forgives typos and swapped letters, accepts first/last in either order, any usual
DOB format, mobile/home/work phones, our #id and the old system's chart number (letters too). The command bar shows
recent patients when empty and focuses as it opens. Picking a patient makes them the active patient. The office alert
is a banner on the chart, not a dialog.

**Automated:** nothing to automate; the search does the work.

**Edge cases:** two patients with the same name (both listed with age, DOB and phone); archived patients (never
shown); office-restricted users (only their offices' patients); a number that's both a chart # and part of a phone
(both matched); fewer than 2 characters (nothing searched).

**Acceptance:** `e2e/workflows/01-04-08-chart.test.mjs` and `foundations.test.mjs` open a patient by a misspelled
name and by phone digits in ≤ 3 actions; `server/test/patientsearch.test.js` covers the matching rules and isolation.

## From the schedule (the visit panel)
**Trigger:** the patient is on the schedule and someone needs their chart, insurance or profile.
**Today (before):** click the visit, scroll to the bottom, "Open chart" (3 actions, overview only); insurance was a
small link in the details; the rest meant opening the chart and then picking a tab (4+ actions). Back from the chart
lost the open visit.
**Budget:** 2 actions — click the visit (or Enter on the focused one), then one click or one number key.
**Redesign:** a row of six buttons under the name and time: 1 Chart, 2 Insurance, 3 Profile, 4 Balance (ledger),
5 Notes, 6 X-rays (documents), each opening `/patients/:id?tab=…`; the number keys work while the panel is open and
are listed under "Visit panel" in `?` (not while the cancel / no-show reasons are up — their numbers pick a reason).
Buttons follow the tabs' permissions (clinical:read for chart, notes and x-rays; billing:read for balance). The
name is a link to the profile. Just under: eligibility (the existing badge), balance and the office alert / allergy,
from the same cached `/patients/:id/card` the hover card uses. Opening a visit makes its patient the active one.
Leaving from the panel writes `date`, `view` and `appt` into the schedule's address first, so Back returns to the
same day and view with the panel open again.
**Acceptance:** `e2e/workflows/schedule-drawer.test.mjs`.
