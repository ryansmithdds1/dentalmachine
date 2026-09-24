# RC — Recall on autopilot (and the cadence engine)

**Trigger:** a patient's recall comes due. Nobody has to start anything: once an administrator turns the
autopilot on (Recall → Turn on), every active patient with a recall due is reminded on a schedule until they book.
**Who:** patients (texts, emails, calls, the booking page); the front desk only for the calls on their list;
administrators for the switch and the sequences (`schedule:write` + admin). Results need `schedule:read`; the $ figures
also need `billing:read`.
**Backlog:** RC1–RC4 in `docs/workflows/backlog.md`. The engine is shared with treatment follow-up (TF1–TF2), below.

## Target
| Who | Step | Actions |
|---|---|---|
| Team | A patient due for recall who books from the text | **0** |
| Team | A patient the autopilot couldn't reach by text/email/AI call | 1 per call (the outcome, one key: `1`–`6`) |
| Patient | From the text to a booked visit | **≤ 2 taps** on the page (a time, then "Book it"); the confirmation arrives on its own |
| Patient (family) | Everyone due within 30 days, back-to-back | ≤ 2 taps, one link |
| Admin | Turn it on | 1 |

## What's automated (server/src/cadence.js, cadence-recall.js)
- **Enrolment:** every pass (every few minutes) enrols each active patient with an active recall type due inside the
  sequence's window (its earliest step, plus the family window, ahead; up to 2 years overdue). Skipped: a future visit
  already booked (pre-appointed at checkout counts as done), inactive/archived/merged charts, a hold (deceased, moved,
  asked not to be contacted), or opted out of every electronic channel (texts off or STOP, and email off or
  unsubscribed). One enrollment per recall and due date (`UNIQUE (sequence_id, source_type, source_id, anchor_date)`).
- **The sequence (RC1)** — one per recall type, starting from the recommended steps and editable: −30 text with the
  booking link · −14 text · due date text · +14 email · +30 AI call (falls back to a call task for the team) · +60 text
  · +90 postcard (falls back to email) · +180 text repeating every 90 days ×8 ("we miss you"). A patient who prefers
  email gets email for text steps (and the reverse). Starting late (found overdue) sends only the latest step; the
  missed ones are recorded as skipped.
- **Stops (RC3)**: checked on every pass **and again right before each send**: a visit booked (any active future
  visit, or the recall marked scheduled), the recall completed / switched off / its date changed, patient inactive,
  a hold, opted out, the sequence switched off. A booking is credited to the last step that reached them. Open call
  tasks for a stopped enrollment are closed ("not needed"), so nobody calls someone who already booked.
  `stopForBooking(db, practiceId, patientId, apptId)` is exported for booking code that wants the stop immediately.
- **Never twice:** each step run is claimed by inserting its `cadence_runs` row (`UNIQUE (enrollment_id, step_id,
  occurrence)`) before anything is sent, so restarts and concurrent passes can't double-send. A claim left by a crash
  is never retried (it may have gone): it becomes a failure in Needs attention.
- **Channels:** text and email through `sendMessage` (opt-outs, STOP, bounced/landline numbers all respected there),
  AI calls through the messenger's `call` (Twilio; `calls.source = 'ai'`, audit source `ai`), team calls as `tasks`,
  letters and postcards through the mail adapter (Lob, idempotency key per run). **Fallback:** a channel that can't
  reach them or fails tries the step's fallbacks in the same pass; a channel that needed a fallback last time goes to
  the back of the line next time.
- **Quiet hours:** texts, emails and AI calls wait for the practice's sending hours (not claimed until then); tasks
  and mail go any time.
- **Families:** members of a household (same guarantor) who'd hear from the same person and are due within the
  sequence's family window (30 days) get one message ("Jane and Mia's checkup… We can book everyone back-to-back"),
  one link that books everyone, and their own run of that step recorded as grouped (never sent again).
- **Failures:** every channel failing makes the step `failed` and raises `cadence:<enrollment>` in Needs attention; it
  is retried (up to 3 attempts, an hour apart) while it's still the latest step, and resolved when a later step
  reaches them. A whole pass failing raises `cadence-job:recall`, resolved on the next good pass.
- **Who did it:** everything the job does runs as the automation actor ("Recall autopilot"); AI calls are labelled
  `ai` ("AI recall call"); what a patient does on the page or the call is `patient`; call outcomes are the person.
- The older `recall_auto` messages (recalls.js) skip practices on the autopilot, so nobody gets both.

## Self-scheduling (RC2) — `/rb/:token` (client/src/pages/public/RecallBook.jsx, server/src/routes/recallbook.js)
- The link is `<cadence_links.id>.<HMAC signature>` (server secret; only the signature's hash is stored), one family's
  enrollments, valid 60 days (then 410). Altered/unknown links are 404.
- Open times come from `openSlots` (office and provider hours, visits, blocks, held online requests), for the recall
  type's appointment type (its length per provider, its kind of provider — hygienists by default), with **the
  patient's own hygienist only** unless they have nothing in the next 60 days (or the patient taps "See other
  hygienists"). Not before the due date (insurance frequency). Families: the next person starts when the one before
  finishes (same hygienist when free).
- Booking re-checks the time is open, validates provider/patient/practice (`validateAppt`), and is idempotent by the
  page's key (`cadence_bookings UNIQUE (link_id, request_key)`); an already-booked person answers 409. Audited as
  `recall.self_book`, source `patient`, with the new visit's fields. The recall becomes scheduled, the cadence stops
  (`booked_via = 'self_schedule'`), and the confirmation goes by text/email (`sendVisitsMessage`), or a Needs-attention
  item if they can't be reached. Rate limited like the other public routes.
- The AI call offers: 1 → text the same link; 2 → a call-back task; 3 → stop reminders (declined). Voicemail gets a
  short message.

## The screen (client/src/pages/Recall.jsx) — exceptions and results only (RC4)
- **Calls to make:** only the team-call steps, with the phone, how overdue, the script, what was already tried, and
  one-click outcomes — Reached · Left message · Will call back · Booked · Declined (stops) · Wrong number (stops
  texting that number). `J`/`K` move, `1`–`6` log. "Just mine" shows calls assigned to me or anyone.
- **Results:** due in 30 days, overdue, booked (and how many booked themselves), reactivated (booked 90+ days after
  due), $ scheduled (the work on the booked visits, else the recall type's usual fee), calls to make, what each step
  booked, how each channel went, why others stopped, per office (office filter; people limited to offices see theirs).
- **Sequences:** a timeline (the due date in the middle, each step where it falls, repeats faded) and the steps:
  day, channel, who calls, repeat, wording with a live preview, subject for email/mail. Edited steps keep their id;
  removed steps are switched off, not deleted. "Recommended" restores the defaults. Every save is audited before/after.
- **Patient page:** `<RecallStatus patientId={id} />` shows where they are, why it stopped, and "Don't recall…"
  (deceased / moved / asked not to be contacted — a hold, lifted with Undo).
- Replies to recall texts land in the Inbox like any other reply (a person handles those).

## Data
`cadence_sequences` (practice, type, subtype, name, active, family_window_days) → `cadence_steps` (offset_days,
channel, template, subject, conditions JSON {fallback, assign_to}, repeat_days/max, active) · `cadence_enrollments`
(patient, sequence, source_type/source_id, anchor_date, location, status active/stopped/completed, stop_reason,
booked_*) · `cadence_runs` (one per step occurrence: status claimed/sent/failed/skipped/task/done, channel,
fallback_from, source, message/call/task/external ids, outcome) · `cadence_holds` · `cadence_links` ·
`cadence_bookings`; `practices.recall_cadence`. Nothing is deleted: enrollments stop, steps switch off, holds release.

## Adding treatment follow-up (TF1–TF2) to the engine
1. Write `server/src/cadence-treatment.js` exporting a type object (the contract is at the top of `cadence.js`):
   - `label: 'Treatment follow-up'`, `linkPath` (a scheduling/question page, or `null`), `enabled(practice)` (a new
     `practices.treatment_cadence` column),
   - `defaultSequences(db, pid)` → one per urgency: `[{ subtype: 'urgent'|'soon'|'elective', name, steps }]` with the
     TF1 example (day 2 text, 7 email, 14 `task_call`, 30 text, 60 email, 90 `letter`),
   - `candidates(db, practice, { today, windows })` → `{ patient_id, subtype: urgency, source_type: 'treatment_plan',
     source_id: plan id, anchor_date: diagnosis/presentation date, location_id }` for plans with planned procedures
     not on any visit,
   - `stopCheck(db, enrollment, ctx)` → `{ reason: 'booked', appointment_id }` when the plan's procedures are on a visit,
     `{ reason: 'declined' }` when declined in writing, `null` otherwise (holds, inactive and opt-outs are generic),
   - `describe(db, enrollments)` → `{ visit: 'treatment' }` (and any extra words the templates use), optional
     `afterSend`.
2. `registerCadenceType('treatment', treatmentCadence)` in `cadence.js` next to recall. The job, claims, fallback,
   quiet hours, families, failures, call list, outcomes, dashboard (`?type=treatment`), sequence editor
   (`/cadence/sequences?type=treatment`) and patient status all work unchanged.
3. The doctor's letter (TF3) plugs in as the `letter` channel's renderer for that type (needs approval before
   sending — rule 10 — so a TF letter step should create a draft for the doctor rather than mail directly).

## Acceptance
- `server/test/cadence.test.js`: due-step math (negative offsets, repeats, practice time zones), one send across
  restarts and racing passes, a crash's claim not re-sent, stop checked right before sending, skip rules, quiet hours
  and STOP → email, fallback on failure, Needs attention raised then resolved, family grouping, AI call labelled `ai`,
  team calls with one-click outcomes and permissions, sequence editing audited, dashboard counts, practice isolation.
- `server/test/recallbook.test.js`: signed/expiring links, times fitting the visit length and the patient's own
  hygienist from the due date on, idempotent booking audited as the patient with confirmation, families back-to-back,
  practice isolation.
