# PX — Patient experience: moments that make people feel cared for (patient journeys)

**Trigger:** things that happen anyway — a new patient books, a visit ends, a surgery day ends, a birthday, an
anniversary, a milestone, a friend referred, someone we haven't seen in a while. Nobody has to start anything once a
journey is on.
**Who:** patients (texts, emails, mailed cards, the welcome page); the team only for the moments that need a person
(a handwritten card, a call after a "3", a congratulations they choose to send); administrators for the switches and
the wording (Settings → Patient journeys). Moments on the huddle need `schedule:read`; NPS and the delight score need
`reports:read`; post-op answers need `clinical:read`.
**Backlog:** PX1–PX7 in `docs/workflows/backlog.md` (PX2 "during the visit" is not in this batch — see decisions).

## Target
| Who | Step | Actions |
|---|---|---|
| Team | A new patient's welcome, arrival text, birthday, thank-you, check-in, anniversary, "we miss you" | **0** |
| Team | A patient answers "3" after surgery | 1 (open the task, call) |
| Team | A handwritten card | 1 (tick "card sent" on the task) |
| Team | Print a milestone certificate from the huddle | 1 |
| Team | Celebrate a life event from the notes | 1 (card task) or 1 (dismiss) |
| Admin | Turn a journey on / off | 1 |
| Admin | Edit wording and see it on the phone preview | 2 (edit, save) |
| Patient | Answer the post-op check-in | 1 text ("1", "2" or "3") |
| Patient | Leave the newsletter | 1 tap |

## The journeys (server/src/journeys.js)
Each is on/off per practice. **Default on: happy birthday (text), new-patient welcome and its arrival text.**
Everything else starts off until the office turns it on. The journeys that send a message on a date run on the
**cadence engine** as one cadence type (`journey`), one sequence per journey (subtype = key) with a single step — so
enrolment is once per (source, anchor date), opt-outs/holds/quiet hours/fallback/claim-before-send/audit/Needs
attention all come from the engine (see `RC-recall.md`). Everything recorded as the automation actor
"Patient journeys autopilot"; messages are logged with `kind = 'journey'`.

| Key | When | Channel (default · allowed) | Once per |
|---|---|---|---|
| `welcome` (PX1) | a new patient's first visit is booked (after the journey was switched on), up to 120 days ahead | email · email/letter/text | appointment + date |
| `arrival` (PX1) | the day before that first visit | text · text/email | appointment + date |
| `thankyou` (PX3) | a visit completed today (replaced by the summary when both are on) | text · text/email | patient + day |
| `postop` (PX3) | procedures completed today whose code starts with D7, D33, D34, D42, D60 (editable), from 18:00 (editable) | text only (no fallback: the answer comes by text) | patient + day |
| `summary` (PX5 "you're all set") | a visit completed today | text · text/email | patient + day |
| `birthday` (PX4) | the birthday (29 Feb → 28 Feb), patients seen in the last 36 months | text · text/email | patient + year |
| `birthday_card` (PX4) | mailed 5 days ahead for children ≤ 12 and patients marked VIP | postcard · postcard/letter (Lob) | patient + year |
| `anniversary` (PX4) | the anniversary of the first completed visit, years 1, 5, 10, 15, 20, 25, 30 (editable) | text · text/email/postcard | patient + day |
| `milestone` (PX4) | a milestone detected in the last 7 days (below) | text · text/email | milestone |
| `reactivation` (PX5) | last visit 18+ months ago (editable, up to 5 years), nothing booked; again after 120 days, twice. **Patients with a recall due are left to recall autopilot when it's on.** Stops when they book. | text · text/email/letter/postcard | last visit |
| `referral_thanks` (PX5) | a patient's referred friend completes their first visit | text · text/email/letter | referral |

Not messages (the journey job, `runJourneyExtras`):
- **Handwritten thank-you card** (`card_task`): a task after a new patient's first visit and after a treatment day of
  $1,500 or more (editable; to a chosen person or the team). One per reason. Ticking the task = card sent.
- **Referral gift card** (`referral_gift`): a task to send the referrer a gift ("$25 gift card", editable).
- **Milestones:** braces off (the ortho case's debond date) and a child's (under 18) **first** cavity-free checkup
  (a periodic/comprehensive exam, no open caries charted, no restorative planned or done that day). Shown on the
  huddle with a **printable certificate** (PDF).
- **Life events** (`life_events`, on): a new baby, wedding/engagement, graduation, retirement, new job, new home read
  from the chart's notes and office alert for patients coming in this week — **suggested to the team, never sent**.
  (Hook: `personalNotes()` — when personal-connection notes (PP2) exist, read them there.)
- **One-question survey** (`survey`): turning it on creates the practice survey "Quick check-in (after visits)" (NPS +
  an optional comment) with `auto_after_visit`, sent by the existing survey job (at most every 90 days, not in a week
  with a review request). Comments become a task for the owner (the first administrator, or who they pick); scores of
  6 or less mark a **hard visit** on the huddle.
- **Holiday cards and newsletter:** written by the office (starters below), sent once to a snapshot of recipients by
  the job, 200 at a time inside sending hours. Holiday cards go to one person per household seen in the last two
  years (email, or a mailed postcard via Lob). **The newsletter goes only to patients who asked for it**
  (`journey_prefs.newsletter`, on the patient) with an unsubscribe link (and `List-Unsubscribe`) in every one; the
  link stops only the newsletter.

## Rules
- **Minimum PHI:** messages say "your visit today" and no more. Wording is checked on save (and again before sending)
  against clinical words (D-codes, extraction, root canal, surgery, implant, crown, filling, cavity, x-ray, braces…);
  the post-op check-in never names the procedure; the referral thank-you never names the friend; the summary puts the
  visit details and balance behind the portal sign-in. The welcome page shows first name, visit time and the office.
- **Opt-outs and quiet hours** come from the engine (`sendMessage` refuses opted-out addresses; texts/emails wait for
  sending hours). A patient can be marked **no celebrations** (birthday, card, anniversary, holiday cards skip them).
- **Idempotent:** engine enrolment is unique per (sequence, source, anchor) and each step is claimed before sending;
  cards, milestones and moments have unique keys; a broadcast's send is a one-way status change (a double click finds
  it already sending) and each recipient is claimed before sending.
- **Failures** go to Needs attention (the engine's own, plus `journey-job`, `journey-broadcast:<id>`, `postop:<id>`).
- **Everything logged:** `messages` (kind `journey`, `newsletter`, `holiday_card`, `journey_test`), `cadence_runs`,
  and `audit_log` (settings before/after, moments, cards, referrals, prefs, certificate prints, post-op replies with
  source `patient`, unsubscribes with source `patient`).
- **Post-op answers** (parsed in the inbound text handler, `routes/sms.js`): `1` → a kind reply (and, only if the
  office turned on "ask for a review after a good check-in", the review funnel's `requestReview` with its own
  throttle); `2` or `3` → a high-priority task for the provider who did the work (their user) and an item in Needs
  attention (severity high for 3), and a reply: "We've let Dr. … know and someone will call you shortly. If this is
  an emergency, call 911." A later, worse answer still reaches the doctor.

## Merge fields
`{first_name}` (the patient's preferred or first name) · `{doctor}` ("Dr. Ann Lee" — the visit's provider, else the
patient's, else the first dentist) · `{practice}` · `{date}` ("Tuesday, March 3") · `{time}` ("2:30 PM") ·
`{address}` (the office's) · `{parking}` · `{link}` · `{phone}`. Some journeys add: `{what_to_bring}` (welcome, arrival),
`{next_visit}` (summary), `{years}` ("5 years", anniversary). Email subjects use `{first_name}` and `{practice}`.
Parking, what to bring, what to expect, a team note and the doctor's photo are set once (Settings → Patient journeys →
"About your office").

## Starter wording (the office edits these)
- **Welcome (email, from the doctor)** — subject "Welcome to {practice}, {first_name}!":
  "Hi {first_name}, I'm so glad you chose {practice}, and our whole team is looking forward to meeting you on {date}
  at {time}. Your first visit is all about getting to know you: we'll listen to what matters to you, take a careful
  look, and answer every question — plan on about an hour. We're at {address}. {parking} Please bring
  {what_to_bring}. You can fill in your forms ahead of time and meet the team here: {link} See you soon! — {doctor}"
- **Arrival (text, day before):** "Hi {first_name}! We can't wait to meet you tomorrow at {time} at {practice},
  {address}. {parking} Please bring {what_to_bring}. Questions? Just reply to this text."
- **Thank-you (text):** "Thank you for coming in today, {first_name}! It was a pleasure to see you. — {doctor} and the
  team at {practice}"
- **Post-op check-in (text):** "Hi {first_name}, it's {practice} checking in after your visit today. How are you
  feeling? Reply 1 if you're doing well, 2 if you have some discomfort, or 3 if you'd like to talk with us."
- **You're all set (text):** "You're all set, {first_name}! Thanks for coming in today. {next_visit} Your visit
  summary, forms and any balance are in your patient portal: {link}"
- **Happy birthday (text):** "Happy birthday, {first_name}! Everyone at {practice} is wishing you a wonderful day and a
  year full of smiles."
- **Birthday card (mailed):** "Happy birthday, {first_name}! Everyone at {practice} is sending big smiles and warm
  wishes for your special day. We hope it's a great one!"
- **Anniversary (text):** "Happy anniversary, {first_name}! It's been {years} since your first visit to {practice}.
  Thank you for trusting us with your smile — it means the world to our whole team."
- **Milestone (text):** "Congratulations, {first_name}! The whole team at {practice} is so proud of you. What a day to
  celebrate!"
- **We miss you (text):** "Hi {first_name}, it's been a while and we miss you at {practice}! Whenever you're ready,
  we'd love to see you — book here: {link} or just reply and we'll find a time that works for you."
- **Referral thank-you (text):** "Thank you so much, {first_name}! A friend of yours came to see us at {practice}, and
  a referral is the nicest compliment we can get. We're so grateful for you."
- **Holiday cards:** Winter holidays ("Wishing you and your family a season full of warmth, laughter and time
  together. Thank you for being part of our practice family this year — it's a joy to care for you."), Thanksgiving
  ("This Thanksgiving, we're especially grateful for you…"), New Year ("Here's to a bright, healthy and happy new
  year!…"), Spring ("Longer days, blooming flowers and a fresh start…").
- **Newsletter:** "Hi {first_name}! A quick hello from all of us at {practice}. Here's what's new at the office this
  season: … Thank you for being part of our practice family — we love seeing you."

## The huddle's moments (PX7)
`GET /api/journeys/moments?date=` — today's birthdays (on the schedule, plus others to text or call), first visits
("greet by name"), milestones (with the certificate), patients who had a **hard last visit** (survey ≤ 6, a review
rating ≤ 3, a "2" or "3" after surgery — last 180/60 days), personal notes to mention, life-event suggestions, and how
many cards are waiting to be written. The schedule card reads `first_visit` from `markFirstVisits()`.

## Measures (PX6)
`GET /api/journeys/feedback/nps?from&to&by=provider|location` — NPS by month and by provider or office.
`GET /api/journeys/delight?from&to` — the **patient delight score** (0–100): the average of NPS mapped to 0–100, visit
ratings as a share of 5★, and the share of post-op answers that were "1"; each part is returned with its count, plus
the number of unhappy signals. For the metrics page.

## API
Staff (`routes/journeys.js`): `GET /journeys` · `PUT /journeys/:key` (admin) · `POST /journeys/:key/preview` ·
`POST /journeys/:key/test` (admin; to your email or a number you type; a pretend patient "Alex") · `GET|PUT
/journeys/profile` · `GET /journeys/moments` · `POST /journeys/moments/:id/done|dismiss|card` · `GET
/journeys/moments/:id/certificate` · `GET /journeys/cards` · `POST /journeys/cards/:id/sent` · `POST /journeys/referrals`
· `GET|PUT /journeys/patients/:id/prefs` · `GET /journeys/checkins` · `GET /journeys/feedback/nps` · `GET
/journeys/delight` · `GET|POST /journeys/broadcasts` · `PUT /journeys/broadcasts/:id` · `GET
/journeys/broadcasts/:id/audience` · `POST /journeys/broadcasts/:id/send|cancel` (admin) · `POST /journeys/run-now` (admin).
Public (`/api/public`): `GET /journeys/welcome/:token` · `GET|POST /journeys/unsubscribe/:token`.

## Data
`journey_settings`, `journey_profile`, `journey_prefs`, `journey_links`, `journey_checkins`, `journey_moments`,
`journey_referrals`, `journey_cards`, `journey_broadcasts`, `journey_broadcast_recipients` (`JOURNEY_SCHEMA` in
`journeys.js`, created on first use until the tables are added to `SCHEMA` in `db.js` — the text is ready to paste,
after `cadence_*` since it references them). Messages, tasks, surveys, cadence tables and issues are the existing ones.

## Tests
`server/test/journeys.test.js`: defaults and permissions; welcome + arrival (once, moved visits, not before the switch);
birthday once a year, quiet hours, opt-outs, "no celebrations"; mailed kids' card and anniversary; post-op evening
timing, no clinical words, replies 1/2/3 through the real webhook, alert task and Needs attention; thank-you vs
summary; card threshold and "card sent"; milestones, certificate, huddle moments; reactivation hand-off to recall and
stop on booking; referral thank-you without the friend's name and the gift task; survey reuse, owner comments, NPS and
delight; newsletter opt-in, unsubscribe, double-click send; practice isolation; no clinical detail in any message.
