# PH · Phones: every call saved, linked and coached

**Trigger:** the office line rings (Twilio `voice/inbound` webhook → live `call` event); a recording is transcribed;
the provider's live transcription posts phrases; the missed-call check runs (every 15 minutes).
**Who:** front desk (the call screen, reasons for not booking), owners and office managers (`phones:coach`:
everyone's scores, coaching, protocols, missed-call analytics, alerts). Settings: administrators.
**Code:** `server/src/phonecoach.js` (rules and numbers), `server/src/routes/phonecoach.js` (routes + live
transcription webhook), `server/src/ai/callscore.js` (AI adapter, sandbox), `server/src/livecall.js` (real-time
transcription adapter, sandbox), `routes/phones.js` (disclosure, desk result, ring time, who answered).
Client: `components/phones/*` (NextOpenings in CallPop, NoBookReason, CallCoach, PatientCalls, PhoneSettings),
`pages/Phones.jsx`, `pages/Calls.jsx`.

## Target budget
- **Ring → booked visit: ≤ 3 actions.** With live transcription: **1** (the caller says "Thursday afternoon with
  Dr Chen", the list filters itself, one click books). Without it: tap a day chip, tap AM/PM, click the time (3).
  `e2e/workflows/PH-phones.test.mjs` measures both.
- Why they didn't book: **1 click** (the AI's suggestion is pre-marked; any other reason is one click too).
- Acknowledge an upset-caller alert: **1 click** (optional note).
- **Log an ordinary call on the chart (A053): ≤ 3 actions** — Alt+G from any screen with the patient active, type
  the note, Enter. Measured in `e2e/workflows/PH-phones.test.mjs`.

## What's automated
- **PH1** Every inbound call is linked to the patient by number (this practice, never archived charts); a number a
  family shares links to the account holder and the pop asks who's calling (`calls.linked_via`: number /
  family_number). Recording (practice setting) plays the office's own disclosure before the call rings through;
  recordings are transcribed, summarized, then reviewed (below). Playback and transcript reads are audited
  (`call.recording`, `call.view`). The chart's Comms tab lists the patient's (or household's) calls. Search by
  patient, staff member, date, kind of call, reason and topic (words in summaries and transcripts).
- **PH2** Five starter protocols (general, new patient, emergency, scheduling, billing) are created per practice;
  coaches edit them (steps with weight 1-5, required/optional, words that show it). An edit makes a new version;
  the old one is archived and past scores keep pointing at it.
- **PH3** After transcription, when AI is on and scoring is on: the call type is detected, the matching protocol
  is scored by the AI, each met step carries the transcript's own words (a quote not found in the transcript
  doesn't count). Labelled "AI review (…)". Never acted on automatically. Coaches can re-score, rate (0-100,
  replaces the AI's score in averages) and comment. Per person: answer rate, seconds to answer, missed and
  abandoned, new-patient calls → bookings %, average score. Leaderboard (coaches see the team; others see
  their own row).
- **PH4** A call that ended without a booking (not billing) gets an AI-suggested reason (cost, time, insurance,
  shopping, wants to think, other) with the caller's words; a person confirms it with one click (pop, Calls →
  Didn't book, the call). Counts, shares and a weekly trend in Phones → Why they didn't book, with drill-down.
- **PH5** Upset callers: a deterministic lexicon on live phrases and on the transcript (plus the AI's read, quote
  checked) → one alert per call: live event to the recipients' screens, a message in their private "Phone
  alerts" chat (patient, the words, a link to listen), an optional text with no patient details, and a Needs
  attention item until someone acknowledges it (who, when, note; audited).
- **PH6** The pop shows **Next openings** for the likely need (emergency → dentist 30 min; recall due → the recall's
  visit type with the hygienist, not before the due date; planned treatment; new patient exam), from the
  schedule's own `openSlots`. Live phrases are parsed (days, tomorrow, this/next week, morning/afternoon,
  after/before a time, a provider by name, "as soon as possible") and published as ids only; the list filters in
  the browser at once and the server widens the search. One click books through `validateAppt` (conflicts,
  hours, blocks), links recalls, stops recall autopilot, links the call, audited (`call.book` +
  `appointment.create`), Undo in the toast. Alt+B books the first opening.
- **PH7** Missed-call analytics by day, local hour, weekday × hour (heatmap), line (tracking source), position and
  person — attributed to whoever took the call, else the phone team clocked in (time clock) or scheduled
  (staff shifts) at that moment. Abandoned (hung up while ringing), voicemails, callbacks and median minutes to
  call back, text-backs. A day over the target (after a minimum number of calls) raises one alert per day.

## Edge cases
- AI off (no key, or `CALL_SCORE` unset without a key): nothing is scored; upset detection still runs (no AI).
- No live transcription: the chips work the same; `LIVE_TRANSCRIPTION=twilio` adds `<Start><Transcription>`.
- Unknown caller: openings show, booking asks to add or attach the patient first.
- Office-restricted staff: calls about other offices' patients are 404 everywhere (search, review, chart).
- A slot taken meanwhile: booking answers 409 with the reason, the list refreshes. Double click: the same visit.
- Live transcription webhook: signed; must name the call's own CallSid.
- Scoring failure → Needs attention (`call-score:<id>`), resolved by a later success.

## Log a call on the chart (A053, phase 2 batch 1A)
A call the phone line didn't see (a cell phone, a call back from home) is noted where the rest of the calls are: the
`calls` log (`purpose = 'logged'`), shown in the chart's call history (Messages & forms → Calls) and on the Calls page.
- **Where:** Alt+G (patient bar "Call") opens a side panel on any screen; the command bar has "Log a call — name";
  the chart's Calls card has "Log a call" inline. No dialog.
- **Defaults:** now (or 5 min … 2 hours ago), the signed-in person, the patient ("With" can be e.g. their mother),
  the direction this person used last, "Spoke with them". The cursor starts in the note: type, Enter.
- **No duplicates:** when the phone line logged a call with the patient in the last 15 minutes
  (`GET /patients/:id/calls/recent`), the panel offers to add the note to that call (the default) instead of logging
  the same conversation again. Adding the same note twice changes nothing; logging the same call twice within two
  minutes returns the first (plus the app's Idempotency-Key).
- **Server:** `POST /patients/:id/calls` (`patients:write`, the patient must be in this practice and visible to the
  user): direction inbound/outbound, outcome spoke / left_voicemail / no_answer / wrong_number, minutes_ago 0–1440,
  with_name, note ≤ 2000; or `call_id` + note to add to the phone line's call (409 if that call was with someone else).
  Audited as `call.log` / `call.note` with before/after and the patient. `server/test/frontdesk-b1a.test.js`.
