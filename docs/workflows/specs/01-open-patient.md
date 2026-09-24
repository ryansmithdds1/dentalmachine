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
