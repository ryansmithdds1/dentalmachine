# RF · Recall types and frequencies, dialed in

**Budgets:** seeing a patient's recall status on the chart **0 actions** (it's on the patient page). Booking their
hygiene visit with the due bitewings / exam / fluoride attached **≤ 3 actions** — measured **2** (**Alt+B** →
**Book appointment**; the due items come ticked). Marking a recall contacted from the board **≤ 3** (type the name,
click the list, **C**). Logging a recall call on Follow-up → Recall **≤ 2** (Log call or **L** on the patient's row,
**Enter**; one row per patient, so one call covers exam, cleaning and x-rays). Tested by `e2e/workflows/RF-recall.test.mjs`; server rules by `server/test/recallfreq.test.js`.

## Who and where
- **Everyone** sees the Recall panel on the patient page (`RecallPanel`), and the booking form's "Also due" list.
- **Hygienists and dentists** (`clinical:write`) give a patient their own interval (with a reason), switch prophy ↔
  perio maintenance (with a reason), and enter x-rays taken at another office.
- **Front desk** (`schedule:write`) works the recall board: Follow-up → **Recall board** (book, text, contacted).
- **Administrators** set the "due soon" / "overdue" windows, each type's rules, and merge duplicate recalls.
  Exporting the list needs `reports:read` (phone numbers leave the building) and is audited.

## Data model (one way to represent it — `server/src/db.js`)
| Table / column | What it is |
|---|---|
| `recall_types` | Per practice: `key`, `name`, `interval_months`, `codes` (JSON prefixes that reset it; the first is the one booked), `appointment_type_id`, `active`. New: `age_until` + `adult_key` (a child type until that age, then the adult one), `retires` (JSON keys this type replaces), `bundle` (rides along with the hygiene visit: tracked and suggested at booking, no reminders of its own). |
| `recalls` | One per patient per type (**unique**). `due_date`, `status` due / contacted / scheduled / completed / inactive, `appointment_id`. New: `last_done_date`, `last_done_code`, `last_done_source` (here / outside), `last_done_location_id`, `interval_overridden` + `interval_reason`, `status_reason` (why it was retired). Never deleted. |
| `recall_resets` | Each time work done reset a recall: the procedure (or outside entry), code, date of service, office, the recall **as it was before**, the recalls it retired. `undone_at` when the procedure is voided / un-completed. |
| `recall_outside` | Work done at another office, `source = 'outside'`: code, date, office name, note, who entered it. Voided with who / why, never deleted. Once per code and date (partial unique index). |
| `practices.recall_due_soon_days` / `recall_overdue_days` | The status windows (default 30 / 30 days). |

## Default types (`DEFAULT_RECALL_TYPES`, `server/src/recalls.js`)
| Key | Codes | Every | Rules |
|---|---|---|---|
| prophy | D1110, D4346 | 6 mo | retires child prophy |
| child_prophy | D1120 | 6 mo | until 14, then prophy; retires prophy |
| perio_maint | D4910 | 3 mo | retires prophy and child prophy |
| exam | D0120, D0150, D0180 | 6 mo | bundled |
| bwx | D0274, D0272, D0270, D0273, D0277 | 12 mo | bundled |
| fmx | D0210, D0330 | 60 mo | bundled (matches the opportunity finder and the usual plan limit) |
| fluoride | D1206, D1208 | 6 mo | bundled; suggested until 19 |
| ortho_check · implant_maint · sleep_check | D8660/D8680 · D6080/D6081 · D9947/D9948 | 6 · 6 · 12 mo | office-defined starters, off until turned on |

A new practice gets them all. A practice set up earlier gets any missing one **switched off** — its own setup is
never changed behind its back.

## Rules
- **Reset from the date of service.** Completing any of a type's codes (`completeProcedure` → `resetRecalls`,
  `server/src/recallsync.js`) sets due = date of service + the recall's interval, records the last visit, and makes
  it due again (a later visit that's already booked stays booked). An older visit entered later never pulls the due
  date back. The same procedure resets a recall once (idempotent).
- **Age picks the type.** D1120 on a 9-year-old resets child prophy; on a 15-year-old, prophy. The nightly age rule
  (`runRecallAgeRules`) moves a child recall to the adult one on the birthday (due date, last visit and booking
  carried over; child recall retired). The patient panel applies it for that patient too.
- **Perio switch.** Completing D4910 (or "Switch to perio maintenance" with a reason) retires the prophy recall
  (status inactive + reason, not deleted). Going back works the same way.
- **Voids un-reset.** Voiding the charge / un-completing the procedure marks its reset undone: the recall goes back
  to what the remaining visits say, or exactly how it was before (status, due date, booking). Recalls it retired
  come back. A recall that only existed because of that procedure is retired. A safety net re-checks this whenever
  a patient's recalls or the board are shown, and nightly.
- **Own interval** (e.g. perio every 4 months) needs a reason; the audit log has before → after and the reason. The
  next visit resets on the patient's interval. "Back to standard" clears it.
- **Outside x-rays** (date + type, where) reset the recall like work done here, show "at <office>", count toward the
  insurance frequency (the plan probably paid for them), and can be voided with a reason.
- **One recall per patient per type** is a database rule. The board's duplicate check (preview, then merge,
  administrators) handles merged charts (the kept chart takes the later visit; the duplicate's recall is retired or
  moved) and two live cleaning types (age decides child vs adult; the more recent of prophy / perio maintenance is
  kept; anything unclear is listed for a person, never merged).
- **Status** on a day: *scheduled* (a booked visit covers it, with the date) · *current* (due after the due-soon
  window) · *due soon* (within it) · *due* (up to `overdue_days` past) · *overdue* · *no record* · *retired*.
- **Insurance-eligible date** uses the patient's primary plan's frequency limits (`insurance_plans.frequencies`,
  the same `{ codes, count, months | per: 'benefit_year' }` rules `estimateCoverage` uses; `DEFAULT_FREQUENCIES`
  when none): "N per M months" opens when the Nth most recent ages out; "N per calendar/benefit year" when fewer
  than N were done this year, else the next year's start. Age limits on the plan say when it stops paying. Shown as
  "BWX 1 per 12 months · insurance pays from Apr 12".
- **Bundling.** For a hygiene visit (hygienist, a hygiene visit type, or a type with a cleaning code) the bundled
  types due by that day (or within the due-soon window after it) are offered: ticked when due and insurance pays
  that day, unticked otherwise with the reason. Code picked to fit: bitewings D0272 under 10, else D0274; exam D0150
  when none is on record, else D0120. Booking adds them as planned procedures (no charge until completed) and links
  the recalls; a repeat adds nothing twice.
- **Reminders.** Bundled types never send a message or run a cadence sequence of their own; they ride along with
  the cleaning's message (`runRecallSequences`, `cadence-recall.js`). The capacity meter doesn't count them as
  separate visits.
- **Board.** Filters by type, status, provider (the patient's hygienist, else dentist), office and name. % current
  per type = (current + due soon + booked) / live recalls. Reappointment = of patients with a cleaning in the last
  90 days, how many had their next visit booked by the end of that day. **J/K** move · **B** book (booking form,
  with the bundle) · **T** text (the existing recall message) · **C** contacted (Undo on the toast; a line in the
  call log). `recallCounts()` gives the same numbers to the capacity meter and metrics.

## API (`server/src/routes/recallfreq.js`)
`GET /patients/:id/recall-status` · `GET /patients/:id/recall-bundle?date&provider_id&appointment_type_id` ·
`POST /appointments/:id/recall-bundle {codes}` · `PUT /recalls/:id/interval {interval_months|null, reason}` ·
`POST /patients/:id/recalls/switch {to, reason}` · `GET|POST /patients/:id/outside-procedures` ·
`POST /outside-procedures/:id/void {reason}` · `POST /recalls/:id/contacted` · `GET /recall-board` ·
`GET /recall-board/export.csv` · `GET /recall-board/duplicates` · `POST /recall-board/duplicates/merge` ·
`GET|PUT /recall-settings` · `PUT /recall-types/:id/rules`.

## Recall list, one row per patient (A051, phase 2 batch 1A)
Follow-up → Recall lists each patient once, with the recalls they're due for as chips (× stops recalling one of them).
J / K move, **L** (or Log call) opens the call log right under the row — not a dialog — with "Left voicemail" picked
and Save focused: Enter saves, 1–8 pick another outcome, Esc closes. **B** books. The call is one follow-up entry and
marks every recall of theirs that was still due as contacted (`POST /patients/:id/followups` with `kind: 'recall'`,
optional `recall_ids`; a note or a wrong number doesn't count as contact; audited with the recalls it covered). The
unscheduled-treatment and broken-appointment lists log calls the same inline way. Tests: `e2e/workflows/RF-recall.test.mjs`
(A051: 2 keys), `server/test/frontdesk-b1a.test.js`.
