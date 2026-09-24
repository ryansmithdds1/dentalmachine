# TF — Treatment follow-up cadence and the doctor's letter

**Trigger:** treatment is diagnosed (a plan with planned work) and isn't scheduled. Nobody has to start anything:
once an administrator turns it on (Recall autopilot → Treatment follow-up → Turn on, `/recall?type=treatment`), every
patient with unscheduled treatment gets a recommended sequence of texts, emails, team calls and — after a while — a
letter from their doctor, until the work is booked.
**Who:** patients (texts, emails, the plan page, the letter); the front desk for the calls on their list; the doctor
for the letters (`clinical:sign`, and only the doctor whose name and signature are on it); administrators for the
switch, the sequences and the letterhead. The board needs `schedule:read`; the $ figures also need `billing:read`.
**Backlog:** TF1–TF4 in `docs/workflows/backlog.md`. Built on the cadence engine (`RC-recall.md`).

## Target
| Who | Step | Actions |
|---|---|---|
| Team | A patient who books from a text or email | **0** |
| Team | A call on the list | 1 (the outcome, one key: `1`–`6`) |
| Doctor | Approve a doctor's letter from the Letters list | **≤ 2** (one click on "Approve & send", or `A` on the highlighted letter) — measured: 1 |
| Doctor | Approve a batch | 2 ("Tick all mine", "Approve and send N") |
| Doctor | Circle the problem on the x-ray | 1 drag (saved on its own) |
| Admin | Turn it on | 1 |

`e2e/workflows/TF-followup.test.mjs` fails if approving a letter takes more than 2 actions.

## What's automated (server/src/txfollow.js, txletter.js, txwords.js)
- **Who (TF1):** every open treatment plan (proposed or accepted) with planned work not on the schedule, for an active
  patient, diagnosed on or after the practice's starting date (set when it's switched on: the last 180 days by
  default, so switching on doesn't write to everyone ever diagnosed). Options for the same work (Option A / B) count
  once: the accepted one, else the first open one. **Anchor:** the plan's diagnosis date (practice-local).
  **Source:** the treatment plan. Never: patients on hold (deceased, moved, don't contact), opted out of every
  channel, inactive or merged.
- **Urgency and sequences:** one sequence per urgency, worked out from the work (root canals and extractions →
  urgent; fillings, crowns, gum treatment, implants, bridges, dentures → soon; orthodontics, veneers, night guards,
  anything else → elective). The doctor can set a plan's urgency on the board; the patient moves to that sequence
  on the next pass (the old one stops as "urgency changed"). Each sequence is edited on the sequence editor
  (`/recall?type=treatment&tab=sequences`, the Recall editor with `type=treatment`); "Recommended" puts it back.
- **Stops, checked on every pass and right before every send:** the plan's work is on a visit, or the patient has an
  upcoming visit with a dentist (they'll be seen; the desk adds the work) → **booked**, credited to the last step that
  reached them; the work is done → **treatment done**; the plan is rejected, or an informed-refusal form (a consent
  template whose name says "refusal") is signed after the diagnosis → **declined in writing**; another option was
  accepted; "declined" on a call; opted out, held, inactive; the sequence switched off.
- **Texts carry no clinical detail (rule: minimal PHI):** only the office's name and a link. The link
  (`/api/public/txf/<token>`, signed and expiring) opens the plan page (`/tp/…`) behind the date-of-birth check: the
  work, the cost, payment options, accept and sign. Once accepted, it shows how to book (call, or online booking).
  **Emails and call scripts** name the work in plain words with the patient's estimated cost from the plan's
  insurance estimate (`{visit}` = "a crown (your estimated cost: $420.00)").
- **Calls (TF2):** a team-call step makes a task titled "Treatment follow-up call: …" with the script, and a row on
  the Calls tab with the script, the work, the cost and the history; each outcome is one click (reached, left
  message, will call back, booked, declined, wrong number — the engine's outcomes), and the next step follows on its
  own.
- **Engine rules apply unchanged:** quiet hours, preferred channel, fallback, never twice (the `cadence_runs` claim),
  failures in Needs attention, everything recorded as the automation (`Treatment follow-up autopilot`). Treatment is
  never grouped into a family message (family window 0 unless the office sets one).

## The doctor's letter (TF3)
- **When:** the sequence's letter step (soon: day 90; urgent: day 30; elective: none by default), or the doctor's own
  click ("Write a letter": `POST /txfollow/letters`). The step makes a **draft** and waits: the step's run stays a
  task until the letter is sent or cancelled, the engine never mails its generic letter for it, and a late start
  skips straight to the letter.
- **What it says:** practice letterhead (logo and color from Letter setup, else from Online scheduling), the date,
  "Dear Jane,", what the doctor found in plain words, the x-ray or photo with the area marked (the imaging viewer's
  own arrows/circles, or what the doctor draws on the letter), why it matters, what can happen if it waits, the
  recommended treatment with the fee, the insurance estimate and the patient's cost, how to schedule (the link and
  the phone), the closing, the doctor's signature image, name, credentials and title. The picture is chosen for
  them: the one the office picked for the plan's presentation, else an x-ray/photo of a tooth on the plan, else the
  latest x-ray.
- **Review and approve:** Letters to approve (the doctor's list; `A` approves the highlighted one, `X` ticks it, Enter
  opens it). The panel shows the letter exactly as the patient sees it, the four paragraphs to edit (saved as you
  leave each), the picture with Circle/Arrow tools, email / paper copy, the signing doctor, PDF, "Not needed" (with a
  reason). **AI** can draft the three paragraphs ("Draft wording with AI"): labelled on the list and in the panel
  with its one-line reason, recorded as the AI in the audit trail; it never sends. The assistant can't approve
  (428 without the on-screen yes).
- **Only the signing doctor approves** (when that doctor has a login; a doctor without one: anyone who can sign
  notes, recorded as the approver). Not even an administrator signs for a doctor.
- **On approval** (once — a double click, a retry or a batch that includes it again sends nothing more): re-checked
  first (booked since? done? on hold? → cancelled, not sent); **filed on the chart** as a PDF document (folder
  "Letters", linked to the plan); **emailed** (the letter as the email, the PDF with the marked picture attached);
  **paper copy** mailed through the mail adapter (Lob; idempotency key `txf-letter-<id>`), or — with no mail service
  or address — a task to print and mail it; when nothing electronic can go, the office prints it. Recorded as
  `treatment_plan.informed_notice` on the plan (who approved, how it went, the filed document).
- **Failures:** a channel that fails leaves the letter "Didn't go" with the reason, raises `txf-letter:<id>` in Needs
  attention and offers "Send again" (only what didn't go is redone). A send cut off by a crash is never retried on its
  own. Drafts waiting more than a week raise one reminder (`txf-letters-waiting`) for the clinical team.

## The board (TF4)
Tiles: being followed up (and the $ of that work), booked (and the booking rate of those who finished), $ scheduled,
letters to approve / sent / booked after a letter, calls to make, end of cadence. "Where everyone is" (patients by the
last step that reached them — click to filter), "What each step booked" (count and $ of the work on the booked
visits), by urgency, the patient list (urgency editable, last and next step, letter waiting), and **Reached the end
without booking**. `GET /api/txfollow/metrics?days=` returns the same numbers.

## Starter wording (the recommended sequences; every word is the office's to change)
Soon — day 2 text · day 7 email · day 14 team call · day 30 text · day 60 email · day 90 doctor's letter:
- **Text:** "Hi {first_name}, it's {practice}. The treatment we recommended at your visit still needs to be
  scheduled. See the details and your cost here: {link}"
- **Email** (*Your treatment at {practice}*): "Hi {first_name}, at your last visit we recommended {visit}. It's best not
  to leave it too long — small problems are simpler (and cost less) to fix. See your plan and choose a time here:
  {link} — or call us at {phone} with any questions."
- **Call script:** "Hi, this is {practice} calling for {first_name}. At your last visit the doctor recommended
  {visit}. Do you have any questions about it? Can we find a time that works for you?"
- **Text (day 30):** "Hi {first_name}, {practice} here — just checking in about the treatment we recommended. You can
  see it and pick a time here: {link} or call {phone}."
- **Email (day 60)** (*Still here to help with your treatment*): "Hi {first_name}, we haven't been able to schedule
  {visit} yet. If cost, timing or worry is holding you back, we're happy to talk it through and look at payment
  options. See your plan here: {link} or call {phone}."

Urgent — day 1 text ("…The treatment we recommended shouldn't wait long. See the details and pick a time: {link}") ·
day 3 call · day 7 email · day 14 text · day 21 call · day 30 doctor's letter · day 60 text.
Elective — day 7 email · day 30 text · day 60 call · day 120 email ("Still thinking it over?") · day 180 text.

**The doctor's letter** (first draft, from the work on the plan; the doctor edits):
> When I examined you on June 2, I found a tooth that is cracked or too weak to hold a filling. I recommended a crown
> on your lower right back tooth (#30), and I noticed it hasn't been scheduled yet — so I wanted to write to you myself.
> *[the x-ray, the area circled]* **Why it matters:** A crown covers and protects the tooth so it can't break any
> further. **If it waits:** A weak or cracked tooth can break, sometimes below the gum. It may then need a root canal
> as well, or it may not be possible to save it — which means more treatment and more cost. **What I recommend:** a
> crown… Treatment fee / estimated insurance / your estimated cost. **Scheduling:** the link and the phone. "If you
> have any questions, or if something is holding you back, please call — I'd be glad to talk it through."

Built-in wording exists for root canals, extractions, crowns, fillings, gum treatment, implants, bridges, dentures,
orthodontics, veneers and night guards (`KINDS` in `server/src/txwords.js`).

## Keyboard
Letters: `J`/`K` move · `A` approve and send · `X` tick for a batch · `Enter` open · `Esc` close. Calls: `J`/`K` ·
`1`–`6` outcomes. Command bar: "Treatment follow-up: letters to approve / calls to make / board".

## Open decisions for the owner
- Does any upcoming dentist visit count as "booked" (today: yes — the desk adds the work at that visit), or only a
  visit with the plan's work on it?
- Elective work gets no doctor's letter by default — add one?
- The paper copy prints in black and white (the mail adapter's `color: false`); color costs more per letter.
- The printed letter's picture is fetched by the mail service from a signed link (`/api/public/txf/l.<token>/image`)
  because Lob limits inline HTML to 10,000 characters; the mail adapter could instead upload the PDF itself (it's
  passed as `pdf` already) so the printout is byte-for-byte the filed PDF.
