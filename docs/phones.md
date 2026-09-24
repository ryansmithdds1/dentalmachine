# Phones: every call saved, linked and coached

A guide for the owner and office manager.

## What it does
- **Every call saved and linked.** Calls on the office line are recorded (when you turn recording on), turned into a
  transcript and a short summary, and filed under the patient automatically by their number. A number a family
  shares is filed under the account holder, and the screen asks who's calling. Anything unmatched is one click to
  attach. Each patient's calls (and their household's) are on the chart's **Comms** tab, with playback and the
  transcript. Every listen and every transcript opened is written to the audit log.
- **Your phone protocols.** Phones → Protocols has a starter protocol for general calls, new patients,
  emergencies, scheduling and billing. Adapt them: your philosophy in a sentence, then the steps (greeting, say
  your name, ask what brings them in, offer a time, close with a day and time, ask for referrals…), how much each
  counts, and which are required. Every change keeps the earlier version.
- **Each call scored — for coaching.** When AI is on, each recorded call is read against the matching protocol.
  You see which steps happened, with the exact words from the call as evidence, clearly labelled as the AI's read.
  You can listen, give your own rating (it replaces the AI's in the averages) and leave a coaching comment.
  **Scores are for coaching and training, never for discipline on their own.** Staff see their own scores;
  only people you give "Phones: coach" (owners, office managers) see everyone's.
- **Leaderboard and missed calls.** Phones → Team ranks the people who answer phones by average score and answer
  rate, with seconds to answer, missed and abandoned calls and new-patient calls that booked. Phones → Missed
  calls shows missed-call % by day, hour and weekday (a heatmap), by line and by the person or position who
  should have answered — the person who took the call, otherwise whoever answers phones and was clocked in (or
  scheduled) at that moment. It also shows voicemails, callers who hung up while it rang, callbacks and how fast
  they happened.
- **Why patients didn't book.** When a call ends without a booking, the AI suggests the reason from what the
  caller said (cost, timing, insurance, shopping around, wants to think, other) and staff confirm it with one
  click. Phones → Why they didn't book counts them over time.
- **Upset callers.** If a caller sounds upset (during the call when live transcription is on, or from the
  transcript), you and your office manager get it at once: a notice on screen, a message in your private
  "Phone alerts" chat with the patient, their words and a link to listen, and — if you add a mobile number — a
  text (with no patient details). It stays in Needs attention until someone acknowledges it.
- **A day with too many missed calls** (over your target, once there have been enough calls) alerts you the same way.
- **The call screen books while you talk.** When a call rings, the caller's account opens with **Next openings**
  for what they likely need (a cleaning that's due, planned treatment, an emergency, a new patient exam). With
  live transcription, as the caller says "Thursday afternoon" or "with Dr. Chen" the list narrows by itself; without
  it, tap a day, AM/PM or a provider. One click books (with Undo).

## Settings (Settings → Phone line → Calls and coaching)
The recording message callers hear, live transcription, AI scoring, who answers the phones, who is told about
alerts (and optional text numbers), and the missed-call target.

## Recording consent: check your state's rules
Federal law and most states allow recording when one person on the call (your office) agrees. **Several states
require everyone on the call to agree** — including California, Connecticut (civil), Delaware, Florida,
Illinois, Maryland, Massachusetts, Michigan (interpretations vary), Montana, Nevada, New Hampshire,
Pennsylvania, Oregon (in-person) and Washington. Callers from those states are covered by their state's rules
even when your office is elsewhere. The message played before the call ("This call may be recorded for quality
and training") is how callers are told; keep it on, keep it clear, and **check your state's rules with your
attorney or advisor** before turning recording on. Recordings contain health information: they're stored
encrypted with your other files, and your phone (Twilio) and transcription (Deepgram) vendors need a signed BAA
(see `docs/HIPAA-vendors.md`).

## Setting up the phone side
- Recording and transcripts: turn on recording; set `TRANSCRIBE=deepgram` with `DEEPGRAM_API_KEY` on the server.
- AI scoring: on when the server has an AI key (`ANTHROPIC_API_KEY`); `CALL_SCORE=sandbox` for demos.
- Live transcription: `LIVE_TRANSCRIPTION=twilio` (Twilio Real-Time Transcription posts to
  `/api/webhooks/twilio/voice/transcription`), then tick "Live transcription" in settings. `sandbox` for demos.
