# Work queue (in order)

Picked from the audit, the competitor comparison and what's asked for. Each item ships with a spec (for workflow
items), tests and a before/after row where it applies.

## Now: finish the workflow batches in flight
1. Batch 2 (9–19) and the running part of batch 3 (20–23, 25, 28, 30, 31): review, full CI, commit.
2. Batch 3 remainder: 24 claims created at checkout and clean ones sent automatically; 26 offer a schedule gap to the
   ASAP list in one step; 27 inline demographic edits and household address changes.

## Asked for (comparison gaps)
3. Full conversions from Dentrix, Eaglesoft and Curve (their standard exports → patients, families, insurance,
   appointments, treatment, ledger balances, perio, notes), dry run and reconciled counts, like Open Dental's.
4. Ready-made report library: the ~40 reports office managers expect by name, on the existing query builder.
5. Imaging bridge: Windows installer/service and named presets for the common imaging programs, with a setup wizard.
6. CBCT and 3D scan viewer: DICOM series (slices + 3D) and STL/PLY intraoral scans in the chart.
7. DSO scale: central billing work queues across practices, cross-practice patient lookup, group-wide reports.
8. Keep working during an internet outage: today's schedule and charts readable offline, notes and payments queued.

## Scheduling efficiency (asked for; right after the six comparison items)
What exists to build on: time patterns per visit type (X = doctor, / = assistant, 10-minute slots, Open Dental
style) with double-booking only where assistant time lines up; "reserved" blocks limited to visit types; walkout
printing from the appointment drawer.
S1. **Assistant and doctor time on the schedule:** each card shows its doctor (X) and assistant (/) time as shaded
    segments; the pattern is editable on the card by dragging or typing ("//XXXX//"); the doctor's column shows only
    their X time so overlapping visits read clearly; booking finds slots where the doctor's X time is free even if
    the chair is double-booked; hygiene visits carry the doctor's exam window, and the doctor sees "exam ready" queue.
S2. **Perfect day / block scheduling:** named day templates per provider (e.g. "Dr. Chen Tuesday": 8–10 crowns,
    10–12 fillings, 2–3 new patients, emergency slot 11:00) with production goals; the week applies templates
    automatically; blocks show on the schedule as tinted lanes with their goal, only matching visit types book there
    until a release time (e.g. 24 h before, then open to anything); the day's scheduled vs goal production shows live.
S3. **Walkouts on the schedule:** one key from a visit (or a batch for the day) to print or text/email the walkout
    (what was done today, paid, insurance pending, next visit); auto-send after checkout if the practice turns it on.
S5. **Production on the schedule (asked for, high priority):** each chair/provider column header shows its scheduled
    production for the day (and completed so far), not just the visit count; the day's total production (scheduled,
    completed, goal and % of goal) always visible at the top; a Doctor / Hygiene / All toggle that splits the totals and
    column numbers by provider type (with per-provider goals), remembered per user; the week view shows each day's
    total; numbers update live as visits are booked, moved, completed or cancelled; hover shows the breakdown
    (by provider, by procedure category, unscheduled treatment still to book).
S6. **Customize what each appointment card shows (asked for):** an easy editor (Settings → Schedule, or right on the
    schedule: "Customize cards") to pick and order the lines on the face of an appointment — name, preferred name,
    age, birthday cake on their birthday, visit type, procedures/codes and teeth, scheduled production, balance due,
    insurance/eligibility status, confirmation status, medical alert icon, new patient star, forms/consent done,
    notes, provider/assistant, time, custom labels/flags the office defines — with a live preview; separate layouts
    for short and long visits (what shows when space is tight), color by type/provider/status, and saved per
    practice with an optional personal override per user.
S7. **Late is impossible to miss (asked for):** the current-time line (already there) made bolder with a time bubble
    in every column and the view kept near it; patient flow steps on every card (check in → seated → ready → out,
    already there) with the time of each; a practice setting for "late after N minutes" (default 5) and "very late
    after M" (default 10): a scheduled/confirmed visit not checked in by then pulses/flashes (a clear red outline and
    "Late 7 min" chip, respecting reduced-motion by using a strong static style instead), a "3 patients late" alert
    at the top of the schedule with one-click actions (text "are you on your way?", call, mark no-show, move); also
    running-behind warnings: a patient checked in but not seated after N minutes, or still in the chair past the
    visit's end with the next patient waiting in that column ("Op 2 running 12 min behind"). Visible to everyone on
    the schedule, optional sound for the front desk.
S8. **"We moved them" strikes (asked for):** when the office moves or cancels a patient's visit for its own reasons
    (provider sick, emergency, double-booked, equipment down), the move/cancel asks "Whose reason?" (patient / office)
    with office reasons listed (reuses the cancel-reason list from workflow 19); office moves are counted on the
    patient: a small badge "Moved by us 2× in 12 mo" on the schedule card, patient bar and booking/move dialogs, with
    the dates and reasons on hover. Moving that patient again warns first ("We moved Maria 5 weeks ago — try someone
    else"). A **"Provider out today" tool** moves or reassigns a whole column at once: keep patients with another
    provider where possible, and when some must be rescheduled, pick those with no recent strikes first; send a
    warm apology text with rebooking link (and an optional goodwill note the office sets); report on office-caused
    moves by reason and provider.
S4. **More ideas:** short-call/ASAP list matched to a gap (length, provider, type); "next available" that respects
    blocks and patterns; buffer and sterilisation time per chair; colour by type/provider/status toggle; utilisation
    heatmap by chair and hour; unscheduled-treatment and due-recall patients suggested for each open gap; drag a
    patient from any list onto the schedule; family appointments booked back to back in one step; recurring
    blocks (lunch, meetings) from templates; schedule notes/huddle notes per day.

## Metrics and automated emails (asked for)
Builds on scheduled saved reports (already emailed on a schedule) and the KPI screens.
K1. **Automated metric emails:** a morning huddle email (today's schedule, production scheduled vs goal, open gaps,
    unconfirmed, insurance to verify, balances due), an end-of-day email (production, collections, new patients,
    case acceptance, broken appointments), and weekly and monthly digests with trends (vs last week/month, same period
    last year, goal). Good-looking HTML that reads well on a phone, per-person subscriptions by role (owner, office
    manager, hygienist, billing), send time per practice time zone, one-click unsubscribe, a preview/test-send, and
    every send and failure visible (Connection activity / Needs attention).
K2. **Areas for improvement:** each digest highlights the 2–3 metrics furthest from goal or trending worst (e.g.
    hygiene reappointment down 8%, collections lagging production, unscheduled treatment up) with the concrete list
    behind them (the patients to call, the claims to chase) and a link to act; an optional plain-language summary
    written by AI, clearly labelled as AI and never including more patient detail than the email needs.
K3. **More robust metrics:** one definition per KPI (docs/metrics.md: exactly what's counted, from the ledger and
    visits), the same numbers on every screen, email and report (one shared calculation), goals per provider and
    per office, benchmarks where known, drill-down from every number to the rows behind it, and tests pinning each
    definition.
K4. **Email foundation:** reusable email templates and layout, a sending log with delivery/bounce status (SendGrid
    events already tracked), BAA-covered provider notes, and staff-facing emails (task assigned, lab case overdue,
    claim denied) using the same system.

## Team chat and tasks (asked for, high priority)
Builds on workflow 28 (tasks between staff, in progress) and the live-update events already used by the schedule.
T1. **Team chat:** channels (whole office, front desk, clinical, each office in a group), direct messages and small
    groups; threads and replies; @mentions (@name, @front-desk, @everyone); emoji picker and reactions; GIFs (a GIF
    search provider behind an adapter, off unless the practice turns it on, with no patient details ever sent to it);
    images and files (stored and encrypted like documents); edit/delete own messages (kept in history); search.
T2. **Nobody misses a message:** unread badges on the rail and per channel, desktop/browser notifications with sound,
    an "urgent" flag that stays on screen until acknowledged and shows who has seen it (read receipts), @mention and
    urgent pushes to the phone app (PWA push), quiet hours per person, and a digest email for anything unread after a
    set time.
T3. **Patient context without leaking it:** link a message to a patient (shows the patient chip; opens the chart);
    patient-linked messages follow office access rules and are audited like other PHI; the "Chat" key from the
    active patient bar starts a thread about that patient.
T4. **Tasks from chat and personal to-do lists:** turn any message into a task (assignee, due date, patient),
    assign tasks to each other or to yourself, a personal "My tasks" list with today/overdue/upcoming, checklists,
    recurring tasks (e.g. "Friday: order supplies"), notifications when assigned or due, and done in one key with undo.
T5. **Fast and keyboard-first:** Ctrl/⌘J opens chat from anywhere, a slide-out panel so the current screen stays,
    ↑ to edit the last message, Enter to send, Shift+Enter for a new line, and the command bar can "message @Maria …".

## Paperwork on autopilot (asked for, high priority)
Builds on intake forms, consents, form packets, automatic sends before visits, and the in-progress workflows 23
(in-office signing pass) and 30 (one review worklist).
P1. **The right forms, picked for you:** each visit knows what's due (new patient packet, yearly medical history
    update, HIPAA acknowledgement, financial policy, the consent for the procedures booked, COVID/other screening the
    office sets) and sends it automatically before the visit; one "Send forms" button (or key) for anything else.
P2. **Any way the patient likes:** text or email link to their own phone (no login, DOB check), a QR code at the
    desk, or the office iPad.
P3. **iPad kiosk mode:** a locked kiosk screen for a tablet at the front desk or in the operatory — staff hand it
    over with the patient's forms already loaded (no searching, no DOB typing via the in-office pass), big friendly
    screens in English/Spanish, signature, card photos, and it returns to the kiosk home and clears itself when done
    or idle; staff see live "Maria is on page 3 of 5".
P4. **Straight into the chart, no retyping:** contact details and insurance apply automatically (insurance card photos
    read and matched to the policy); medical history changes are merged with a one-screen "what changed" for the
    clinician to accept in one key; signed consents and forms are filed as PDFs on the chart; allergies and
    medications update the alerts everywhere; nothing is typed twice.
P5. **Status and follow-up:** each visit shows forms done / not done on the schedule and the huddle, automatic
    reminders to finish, and the few that need a person land in one worklist (from workflow 30).

## Treatment plans and financial options (asked for, high priority)
Builds on treatment plans and phases, case presentation / case acceptance pages, estimates, payment plans,
financing lenders (CareCredit etc.), memberships and the in-progress workflows 21/22. Goal: simple for the team to
build, simple and visual for the patient to choose — no clutter.
F1. **Build the plan fast:** add treatment from the chart or by typing (chart shorthand), drag procedures between
    phases (Phase 1 urgent, Phase 2…), name phases, reorder, mark alternatives ("Option A: implant / Option B:
    bridge"), and the estimate (insurance, write-off, patient portion, remaining annual max per phase and across a
    benefit-year split) updates live.
F2. **Present it visually:** a clean patient-facing view (chair screen, iPad or a link to their phone): the teeth
    involved on a small chart, each phase as a card with what, why (short plain words, optional photo/x-ray), how
    many visits, and their cost; alternatives side by side; nothing technical unless they tap for detail.
F3. **Financial options side by side:** for the whole plan or a phase, the patient sees and picks:
    pay in full with a prepay discount (percentage set by the office, only where allowed); in-office payment plan
    (down payment, number of months, interest/fees if any — monthly amount calculated automatically, autopay card on
    file); third-party financing (CareCredit, Sunbit, Cherry, Proceed… — monthly payment calculated from each lender's
    promo terms, e.g. 0% for 12 months or APR over 24/36/48/60, with the apply link); membership plan pricing for
    patients without insurance. PPO patients see "Your in-network savings: $X" (office fee − PPO fee) where it
    applies. Each option shows total, due today and monthly, in large simple numbers.
F4. **One tap to accept:** the patient picks phases + an option and signs; the choice creates the payment plan /
    financing application / prepay charge and discount (as ledger entries, reversible, audited), books the first
    visit, and sends the consent (see Consents). Staff can do the same from the desk in a few keys.
F5. **Office settings with guardrails:** discount limits, which options show, lender terms, minimum down payment,
    max months — set by the owner; the numbers shown to the patient are stored exactly as presented (with the
    fee schedule and estimate version) so the agreement can always be reproduced.

F6. **Compare options by voice, shown on the patient's screen (asked for):** the dentist says "the patient wants to
    compare: option one, extraction and bone graft; option two, root canal, buildup and crown on 19" → two alternative
    plans are created (through the same entry engine as TE, previewed and confirmed on screen), linked as alternatives
    for the same tooth/problem. A **comparison mode** shows them side by side on a second monitor or the chair screen
    (a patient-facing window the staff open with one click, no printing): for each option — what's done (small tooth
    picture), number of visits and total time, cost to the patient after insurance, monthly with financing, what
    comes later (e.g. extraction → implant or bridge later, with that future cost shown as "likely next step"),
    typical longevity and plain pros/cons the office can edit per procedure; the patient taps the option they choose,
    which flows into accept/sign (F4). Works with 2–3 options.
## Online scheduling that beats the others (asked for, high priority)
Builds on the booking widget (public booking requests), public availability, provider patterns/blocks, the recall
self-booking link (RC2) and intake forms. Parity target: Open Dental Web Sched (new patient, recall, ASAP, existing
patient), NexHealth, LocalMed, Zocdoc, Weave, Dentrix Ascend/Curve online booking — then better.
OS1. **On the practice website in minutes:** a script/iframe embed and a hosted page (practice-branded, fast,
     mobile-first, accessible), a "Book online" button for Google Business Profile ("Reserve with Google" where
     available) and social links; UTM/source tracking so the office sees which channel booked.
OS2. **The visit types patients actually need:** new patient exam, emergency / tooth pain (same-day slots the office
     holds back, a few triage questions: pain level, swelling, trauma → urgent flag), hygiene/cleaning for existing
     patients (matched to their recall and hygienist), consults (implant, ortho, Invisalign, cosmetic), each with the
     right length, provider(s), offices and pre-visit questions; patients choose office → reason → time → details.
OS3. **Straight into the software, no double entry:** real-time availability from the schedule (patterns, blocks,
     buffers, provider hours — never a slot that isn't really free), the appointment is created directly (or held as
     "requested" if the office prefers approval per type), existing patients matched safely (name + DOB + phone,
     never merged automatically; possible duplicates flagged), new patients created with insurance captured (card
     photo, read and verified in the background), card on file / deposit option for new patients and no-show-prone
     slots, intake forms sent right after booking.
OS4. **The front desk is never blindsided:** an instant alert (in-app toast + sound, chat post to the front desk
     channel, optional text) with who booked, what for, when, new/existing, insurance status and anything that needs
     a person (urgent emergency, possible duplicate, insurance not verified); an "Online bookings" list for the day;
     the card shows an "Booked online" badge.
OS5. **Better than the others:** family booking in one go (back-to-back), waitlist/ASAP opt-in with instant offers
     when a slot opens, reschedule/cancel from the confirmation link, smart slot ordering that fills gaps and protects
     production blocks, language (English/Spanish), confirmation + calendar invite, conversion analytics (visits, drop
     off by step, bookings, $ scheduled) and A/B-safe copy. No PHI in analytics; spam/bot protection; rate limits.

## Recall on autopilot (asked for, high priority)
Builds on recall types/due dates, reminders, texting/email, the AI voice calls used for confirmations, online
booking and the ASAP list. Shares one "cadence engine" with treatment follow-up (TF).
RC1. **A complete sequence around the due date:** e.g. 30 days before: text/email with a link to pick a time;
     14 days before: reminder; due date: text; +14: email; +30: call (AI voice call or a task for the team, the office
     chooses); +60: text; +90: letter/postcard; then a quarterly "we miss you" until reactivated. Editable per recall
     type (hygiene, perio maintenance, ortho check, kids) and per patient preference; family members due together
     get one message offering back-to-back times.
RC2. **Self-scheduling in the message:** the link shows real open hygiene times that fit the recall type and the
     patient's provider (respecting blocks and patterns), books directly, and confirms — no call needed.
RC3. **Stops and adapts on its own:** stops the moment a visit is booked; skips patients with a future visit, inactive,
     deceased, moved or opted out; switches channel after failed deliveries; respects quiet hours; pre-appointing at
     checkout (next recall booked before they leave) counts as done.
RC4. **Exceptions and results only:** the team sees only the calls they need to make and replies needing a person;
     a recall dashboard shows due/overdue, booked from each step, reactivated patients and $ scheduled, per office.

## Treatment follow-up cadence and the doctor's letter (asked for, high priority)
Builds on unscheduled treatment lists (Follow-ups), texting/email/calls, treatment plans, x-rays/photos and
statements/mailing (Lob).
TF1. **A cadence the office sets:** a recommended default sequence for patients with diagnosed treatment not yet
     scheduled (e.g. day 2 text, day 7 email, day 14 call, day 30 text, day 60 email, day 90 doctor's letter), editable
     per practice and per treatment urgency (urgent / soon / elective) and paused automatically when the patient
     books, declines in writing, or asks not to be contacted; quiet hours and preferred channel respected.
TF2. **Automatic where reasonable:** texts and emails go out on their own (with a link to schedule or ask a question,
     treatment and cost shown, the office's own words), calls land as tasks on the right person's list with the
     script and the patient's details, each outcome (reached, left message, will call back, declined) logged in one
     click, and the next step scheduled.
TF3. **The doctor's letter:** when the cadence reaches the letter step (or the doctor chooses), a letter is generated
     from the doctor: a well-designed page with the practice letterhead, the patient's name, the diagnosis in plain
     words, why it matters and what can happen if it's left, the relevant x-ray or intraoral photo with the area
     marked, the treatment recommended and its estimated cost, how to schedule, and the doctor's signature. The doctor
     reviews and approves (one click, or in a batch) — AI can draft the wording but never sends it on its own (rule 10).
     Sent by email (PDF) and/or printed or mailed (Lob), filed on the chart as a document, and recorded as the
     informed-notice step (it also satisfies the chart audit's "informed refusal / patient notified" check).
TF4. **See it working:** a follow-up board by stage, what each step produced (booked, $ scheduled), and patients
     at the end of the cadence who still haven't responded.

## Insurance payments posted and billed on autopilot (asked for, high priority)
Builds on ERA (835) import and matching, paper EOB reading (AI), claims, statements, text-to-pay and autopay.
Goal: a person only touches the exceptions.
A1. **Electronic EOBs (ERA) post themselves:** each 835 is matched to its claims and procedures; payments,
    contractual write-offs (from the PPO fee schedule / CARC codes) and patient responsibility post automatically
    when everything reconciles (paid + write-off + patient portion = billed, per line); the claim closes;
    idempotent by ERA trace number + claim + line. The EFT/deposit is matched to the bank deposit (finance module).
A2. **Paper EOBs by scan or phone camera:** scan or photograph the EOB (desk scanner, phone, iPad); AI reads it into
    the same line-by-line structure as an ERA, and it follows the same path — clean ones need a single person's
    "looks right" (AI never posts money on its own: rule 10), with the EOB image filed on each claim.
A3. **Exceptions only:** denials (with the reason in plain words and the next step: correct and resend, appeal,
    bill patient), underpayments vs the expected fee schedule, overpayments/refund needed, unmatched claims, split
    or partial payments, and secondary claims to send — all in one worklist with one-key actions.
A4. **Then bill the patient automatically:** when the claim closes and a patient balance remains, the secondary
    claim goes out if there is one; otherwise the patient gets a text/email statement with a pay link (their
    preferred channel), autopay/payment plans charge as agreed, reminders follow a schedule, and a paper
    statement goes out if they don't open it. The practice sets the rules (minimum balance, wait days, which
    patients to hold); everything sent is logged, and failures show in Needs attention.
A5. **Reconciliation:** ERA totals vs posted vs deposited, and claims billed vs paid vs written off vs billed to
    patient — shown daily, with any gap as an exception.

## Deposits and cash handling (asked for)
Builds on the finance module (bank feed via Plaid, deposit matching, QuickBooks deposit push) and end-of-day.
DC1. **Daily deposit submission:** at close, the team builds the day's deposit from what was taken (checks listed
     one by one with patient and amount, cash counted by denomination), prints or photographs the deposit slip,
     and submits it; the deposit is locked with who prepared it, who verified it, the bag/slip number and the photo.
DC2. **Every deposit tracked to the bank:** each deposit (cash/check, card processor batches, insurance EFTs) is
     followed from "taken" to "submitted" to "in the bank" (matched automatically from the bank feed); anything not
     in the bank after N days, or short/over, becomes an exception in Needs attention.
DC3. **Cash log with anti-embezzlement practice:** a cash drawer per desk opened and closed with a starting float and
     a blind count (the counter doesn't see the expected amount), a second person verifies over/short, every cash
     payment gets a numbered receipt, voids/refunds/discounts on cash need a manager and are flagged, the person who
     takes payments can't also be the only one who posts adjustments and deposits (separation of duties, with a
     warning when one person does all three), and an owner report shows cash over/short, voids, adjustments and
     write-offs by person with trends.

## Production report on one screen (asked for; like Curve's and Open Dental's production & income)
PR1. One simple report for any date range (default: this month to date): gross production, adjustments, write-offs
     (PPO and other), adjusted/net production, collections (patient and insurance) and collection %, by provider and
     for the office, from the ledger. Run mid-month, it also shows the scheduled production for the rest of the
     month and the projected month total if everything scheduled is completed, next to the goal; daily rows with
     a running total; drill-down to the entries behind every number; print/CSV; in the report library and emails.

## Opportunity finder (asked for, high priority)
OF1. **Rules the office sets:** "opportunities" defined by codes and frequency (e.g. sealants D1351 on permanent
     molars under 16 not already sealed, fluoride D1206/D1208 every 6 months under 19 or for high caries risk, FMX
     D0210 every 5 years, bitewings D0274 yearly, perio maintenance vs prophy, SRP on 4 mm+ pockets, overdue
     recall, unscheduled treatment, arestin, night guard, whitening…), with sensible starter rules.
OF2. **Checked against each patient:** history (last done), insurance coverage and frequency limits (eligible now or
     not, and what it would cost the patient), the chart (unsealed molars, open treatment) and perio readings.
OF3. **On the schedule:** a small badge on the appointment card (e.g. "3 · $184") and a click/key that lists what the
     patient is eligible for today, covered or not, with one-click "add to today's visit"; the day and each column
     show the total opportunity; the morning huddle and huddle email list them; results tracked (offered, accepted,
     done) so the office sees what it captured.

## Chart audit: protect the doctor (asked for, high priority)
CA1. **Every past visit checked:** a report (and a nightly job) that looks at each completed visit and flags: no
     note, note not signed (and how long), note signed by someone other than the treating provider, procedures
     completed or attached to the appointment that the note doesn't mention (and the reverse: work described but not
     charted or billed), teeth/surfaces that differ between the note and the charting, missing anesthetic details
     (type, amount, carpules, site) when anesthesia-related work was done, x-rays taken with no interpretation,
     treatment done without a signed consent, medical history not reviewed within the office's interval, blood
     pressure not recorded where the office requires it, informed refusal not documented when recommended treatment
     was declined, post-op instructions missing after surgery, perio charting overdue, prescriptions not noted.
CA2. **Clear, fixable list:** each flag says what's missing and why it matters (liability, insurance audit,
     standard of care) in plain words, sorted by risk, grouped by provider, with one click to open the visit and
     add an addendum (signed notes are never changed, rule 3); flags clear themselves when fixed; trend by provider.
CA3. **AI reads the notes, people decide:** a structured check compares note text with the charted/billed work
     (AI where wording varies, clearly labelled, with the quoted sentence it relied on); it only recommends — it never
     edits a note (rule 10). Rules the office can tune (which checks, intervals, which procedures need consent).

CA4. **"Check my chart" before the doctor sees it (asked for):** a button (and key) on the visit/note for the
     assistant: it runs every chart-audit check on this visit right now plus spelling and grammar, missing template
     fields, tooth/surface mismatches, codes vs note, missing anesthetic/consent/x-ray interpretation, and lists
     each problem with a one-click fix or a jump to the field. The assistant fixes them and marks the chart "ready
     for doctor"; the doctor's queue shows which charts were checked clean, which still have open items, and who
     prepared them — so the doctor reviews and signs instead of correcting. Per-assistant quality trends
     (first-pass clean rate) for coaching, visible to managers.
## Long recordings: a whole exam into the note (asked for)
Builds on the ambient AI scribe and dictation transcription.
LR1. Record an entire exam or procedure (60–90+ minutes) on a computer, phone or iPad: recorded in short chunks that
     upload as they go (nothing lost if the browser closes or the connection drops; resumes), a clear recording
     indicator, pause/resume, patient consent to recording noted.
LR2. The recording is transcribed (dental vocabulary, speakers separated: doctor, assistant, patient) and turned into
     a complete draft note in the office's template — findings by tooth, perio readings, treatment discussed,
     options and patient's decision, consent/informed refusal, anesthetic, materials, post-op instructions — plus
     suggested charting and codes, each with the transcript line it came from; the clinician reviews, edits and
     signs (AI never signs or charts on its own).
LR3. Audio and transcript stored encrypted with the visit, kept per the office's retention setting, audited on every
     play/download; failed transcriptions show in Needs attention and retry.

## Consents, start to finish (asked for, high priority)
Builds on consent templates, e-signature, form packets, workflow 23 (in-office signing) and the paperwork items above.
C1. **Consent library:** ready-made consents by procedure (extraction, RCT, crown/bridge, implant, perio/SRP, sedation,
    ortho, whitening, refusal of treatment, financial) that the office can edit; each version is kept, and a signed
    consent always shows the exact version and wording the patient saw.
C2. **Picked from the treatment:** booking or planning a procedure attaches the right consent automatically, with the
    patient's name, teeth, procedures, fees, risks and alternatives filled in (nothing typed twice).
C3. **Ahead of time or at the chair:** sent by text/email days before (with reminders until signed), or at the chair
    in one step: show a QR code / send to the patient's phone, or hand over the operatory iPad in kiosk mode. The
    schedule and the chair show "consent signed / not signed" live, and the clinician sees it before starting.
C4. **Signed = in the chart:** the signed PDF (signature, time, device, IP, who witnessed) files to the chart and the
    visit, the treatment row is marked consented, and nothing can change it afterwards (a new version needs a new
    signature). Guardian signatures for minors, a witness signature option, Spanish versions, and a "patient declined"
    record that's just as traceable.

## Patient education (asked for)
E1. **Education in the operatory:** an education library by topic and procedure (short illustrated explanations,
    and videos where the office has them — the library supports adding video links/files now; a licensed video set
    can come later), shown on the chair screen or the iPad with one key from the chart or the treatment plan.
E2. **Proof it was given:** sending or showing an item records it on the chart ("Crown education shown in Op 2 by
    Maria, 10:42; emailed to patient") — who, what version, how (shown / emailed / texted), and when the patient
    opened it; this appears in the consent record and the clinical note so informed consent is documented.
E3. **Take-home:** one click emails/texts the same material (and post-op instructions) to the patient, logged the
    same way.

## Time clock and staff schedules (asked for; replaces workflow 44's small scope)
TC1. **Clock in and out in the app:** one screen/key per person (PIN or their sign-in), breaks and lunches, the
     office they clocked in at, and the device/IP; missed punches fixed by a manager with a reason (audited, the
     original kept).
TC2. **Staff schedules:** weekly shifts per person built from templates, with the window when they may clock in
     (e.g. no earlier than 7 minutes before the shift); early/late clock-ins and outs are flagged, and a manager can
     see at a glance who's late, missing, on break or in overtime today.
TC3. **Rules that make payroll easy:** overtime (daily/weekly, state rules), rounding rules, paid time off requests
     and approvals, holidays, and a pay-period review screen where the manager approves each person's hours.
TC4. **Export to payroll:** one click for Gusto, ADP, Paychex, QuickBooks Payroll and a plain CSV, with totals by
     person and pay type (regular, overtime, PTO, holiday), and a reconciliation check (approved hours = exported).
TC5. **Reports:** hours by person/office/period, tardiness, overtime trends and labor cost as a percent of production.

## Office intranet (asked for)
I1. **Quick links:** an office "Links" page and a shortcut in the command bar for the websites the team uses daily
    (insurance portals, lab sites, supply ordering, payroll…), per office and per role, with icons.
I2. **SOPs and documents:** a simple internal wiki — pages with headings, checklists, images and attachments
    (office manual, SOPs, emergency procedures, how-tos), organized in sections, searchable from the command bar,
    with version history, "last reviewed" dates and optional "read and acknowledged" sign-off per person.
I3. **Office announcements** pinned at the top (ties into team chat), and new-hire onboarding checklists that link
    to the SOPs.

## Document management and scanning (asked for)
Builds on patient Documents (encrypted storage, categories, restore) and the imaging bridge (which can watch folders).
D1. **Scan straight in:** scan from any desk scanner — TWAIN/WIA on Windows through the bridge (Fujitsu/Ricoh
    ScanSnap, Epson, Canon, Brother, HP), network scanners that save to a folder or email, and phone/iPad camera
    capture with edge detection, de-skew and multi-page — into the patient's chart in one step; the active patient
    is filled in so nothing is searched twice.
D2. **Any file type:** PDF, images (JPG, PNG, HEIC, TIFF incl. multi-page), Word/Excel, text, DICOM and STL (to the 3D
    viewer), audio/video; previews for everything that can be previewed, download for the rest; size limits and
    virus/type checks on upload.
D3. **Easy to store and find:** drag-and-drop anywhere on the chart, automatic category suggestion (insurance card,
    EOB, referral, consent, lab Rx, ID, x-ray report) with a reason shown, folders/tags, dates, linked to the visit,
    claim or treatment, and full-text search (OCR on scans) from the command bar.
D4. **Notes on documents:** notes and comments on each document (who, when; kept with history), highlights or
    sticky notes on a page, and a "needs review" flag that routes it to a person.
D5. **Office documents too:** non-patient documents (contracts, licences, policies, vendor invoices) with the same
    tools, tied into the office intranet.

## Patient preferences and personal connection (asked for)
PP1. **Preferences on the chart:** a customizable list (comfort: pillow behind the neck, blanket, headphones, prefers
     no nitrous, likes to be told each step; scheduling: mornings only, text not call; the office adds its own), each
     markable **urgent**; urgent ones show as an icon on the schedule card, in the patient bar and when the patient is
     seated, so the team can't miss them.
PP2. **Personal connection notes:** a quick "Personal" note (went to Disneyland, new dog, daughter's wedding) that shows
     every time the chart opens and on the seated card; adding a new one keeps the history as a timeline (who, when),
     so the team can pick up the conversation next visit.

## Recurring checklists by position (asked for, big feature)
Builds on tasks (workflow 28), task_series/recurring tasks from team chat, the time clock (who's on shift) and the
intranet (SOP links).
RCL1. **Owner-built checklists per role/position** (front desk, hygiene, assisting, sterilization, office manager):
      daily, weekly, monthly, quarterly and annual items (e.g. "spore test weekly", "check AED monthly", "OSHA training
      annually", "run end-of-day"), assigned to a position, a person or whoever is on shift, with due times.
RCL2. **Fully featured items:** required evidence (photo, file, a number such as a temperature or a pass/fail result),
      notes, sign-off, and a link to the SOP; critical items (spore test, emergency kit, autoclave log) marked
      critical: a failed result or a missed due time raises a big flag and notifies the owner/office manager
      instantly (in-app, chat, text), stays open until resolved with a documented action.
RCL3. **Owner dashboard:** today/this week by position and person, done/late/missed, streaks and trends, the evidence
      behind each item (e.g. spore-test photos for an inspection), exportable compliance log.

## Phones: every call saved, linked and coached (asked for, big feature)
Builds on the phone system (call log, recordings/transcripts, screen pop, AI receptionist, call tracking).
PH1. **Every call saved and linked:** all calls recorded (with the required disclosure), transcribed, and linked to the
     patient automatically by number (family-aware), or attached in one click; searchable by patient, staff, date,
     topic; playback and transcript from the chart.
PH2. **Phone protocols:** the office defines its phone philosophy and scripts (general, new patient, emergency,
     scheduling, billing): the key steps (greeting, name, offer an appointment, ask for referrals, close with a time…).
PH3. **Each call scored against the protocol** (AI reads the transcript, labelled as AI, with the quoted moments it
     used), per call and per person; answer rate and speed, missed and abandoned calls, new-patient calls converted to
     bookings; a team leaderboard and coaching view; owners can listen and add their own rating.
PH4. **Why patients didn't book:** from calls that ended without an appointment, the reason (cost, time, insurance,
     just shopping, wants to think…) collected and counted over time, to understand and meet patients' needs.
PH5. **Upset caller alert:** sentiment detection during/after a call; an upset patient instantly flags and notifies the
     owner/office manager with the patient, the moment and a link to listen.
PH6. **The call screen that books while you talk:** when a call rings, the patient's account opens with a simple panel
     of the next available times for what they likely need (recall due, planned treatment, emergency); as the caller
     speaks, live transcription picks up requests ("Thursday afternoon", "with Dr. Chen") and the panel filters to
     match instantly; one click books. As close to real time as the phone provider allows.

## Reviews with a feedback screen, and team shout-outs (asked for)
Builds on reputation (review requests, Google Business Profile sync) and surveys.
RV1. **Send from anywhere:** a "Request review" button/command on the chart, checkout, schedule and patient bar; text
     (or email) with a link; not more than once per N months per patient; automatic after checkout if the office wants.
RV2. **Screened routing:** the patient first rates the visit; happy patients are invited to post on Google (and other
     sites the office picks); less-than-happy patients are asked what went wrong and that goes privately to the owner
     and office manager as feedback, with a follow-up task. (Compliance note: Google's policy discourages "review
     gating"; offer the Google link to everyone but lead with the private feedback path when the rating is low — the
     office chooses, and the default follows the platform's current policy.)
RV3. **Team shout-outs:** names of team members mentioned in reviews and feedback are matched to staff and counted
     (points, a leaderboard, optional rewards), with the quote.

## Marketing ROI, end to end (asked for)
MK1. Every lead and new patient tied to a source and campaign (UTM from the website/online booking, call tracking
     numbers, referral source, promo codes, campaigns sent from the app), with the first touch and last touch kept.
MK2. Follow each patient's lifetime value from that source: production, collections, visits, treatment accepted — by
     campaign, channel and month; cost per campaign entered (or pulled from ad platforms later) → cost per new
     patient, ROI and payback time; one clear marketing dashboard and a report in the library.

## Insurance verification center (asked for, high priority)
Builds on eligibility checks (270/271, batch), benefit breakdowns, insurance card read, employer plans/groups.
IV1. **Its own area:** every upcoming patient's status at a glance — eligibility verified (date, how), full breakdown
     verified (date), what's missing — with clear badges on the schedule and chart.
IV2. **As automatic as possible:** eligibility runs ahead of every visit (days before + morning of); full breakdowns
     fetched electronically where the payer supports it, else AI-read from portal/fax documents with a person's
     confirmation; results applied to the plan (frequencies, percentages, maximums, waiting periods, history).
IV3. **Update the whole group at once:** a benefit change verified for one patient updates every patient on the same
     employer group/plan (with a record of who verified and when), so the team never re-verifies the same plan twice.
IV4. **Exceptions only:** inactive coverage, missing subscriber info, plan changes, maximums nearly used — a short
     worklist with one-key actions (text the patient for new insurance, call the payer script).

## Doctor's notes to the front desk on the schedule (asked for)
DN1. A clean, good-looking way for the dentist to leave instructions on the schedule: a note bubble on a visit ("book a
     crown here next", "needs 90 minutes"), or on an empty slot ("I have time here — fit in an emergency or a quick
     filling"), with who/when; the front desk sees it instantly (live update + chime), acknowledges it, and it turns
     into a booking or a task; also from the chair via voice or the phone.

## Diagnosis totals and conversion by provider (asked for, high priority)
DX1. **Running diagnosed totals:** for each doctor and hygienist, treatment diagnosed today, this week and this month
     (from exams), next to goals, always visible to the doctor (dashboard + a chip on the schedule).
DX2. **Conversion funnel by exam type:** for new patient exams, recall/periodic exams and emergency/limited exams — per
     provider: number of exams, $ diagnosed, $ presented, $ accepted, $ scheduled, $ completed, with conversion %
     at each step and time to schedule; drill-down to patients; comparison between doctors and over time; in the
     metrics emails and report library. One definition, documented in docs/metrics.md.

## Capacity meter: when to add a hygiene day or doctor time (asked for)
CAP1. For each provider type (doctor, hygiene) and office: how far out the first opening is for each visit kind (new
      patient exam, emergency, recall/hygiene, treatment of each length), % booked for the next 2/4/8 weeks, open
      production blocks, and demand (recalls coming due, unscheduled treatment in hours, ASAP list, online requests).
CAP2. A customizable meter with the office's own targets (e.g. new patients within 7 days, emergencies same/next day,
      hygiene within 3 weeks, treatment within 2 weeks) — green/amber/red — and plain recommendations: "Hygiene is
      booked 5 weeks out and 140 recall hours are due in the next month: add a hygiene day (about 8 more visits a
      week)"; "Dr. Chen's treatment is 4 weeks out: extend Thursday to 6 pm or open a Friday". Trends over time, in
      the huddle/metrics emails.

## Phone answering: missed-call patterns (asked for; part of phone coaching)
PH7. Total calls, answered, missed and missed-call % by day, hour of day and day of week (heatmap), by line and by the
     person/position that should have answered (from who was on shift and ring groups), abandoned-in-queue and
     voicemail, callbacks made and how fast; alerts when missed % goes over a target; in the phone leaderboard.

## Fee schedules: updates, increases and PPO imports (asked for)
FS1. **Office fee increases made easy:** raise all fees (or a category/code list) by a %, rounded the way the office
     wants, preview old vs new, and apply now or **schedule** for a date (e.g. January 1) so nobody forgets.
FS2. **PPO fee schedule updates by AI:** upload the payer's PDF/spreadsheet (or schedule a recurring import from a
     folder/email); AI reads codes and fees into a draft; a person reviews differences vs the current schedule (new,
     changed, missing codes) and approves; effective date respected.
FS3. **History kept:** every version of every fee schedule is kept (hidden by default, viewable and comparable any
     time), with who changed it, when and why, and "last updated" shown on each schedule; estimates and claims always
     use the version effective on the date of service; reports compare write-offs by version.

## Profitability on the schedule: contribution margin per appointment (asked for, high priority)
Builds on the finance module (true cost per hour, overhead), PPO profitability, fee schedules (FS), production
(server/src/production.js) and the schedule production bar.
PM1. **Cost per procedure:** for each code (or category) the owner enters the direct costs: supplies/materials, lab fee
     (or pulled from the lab case), associate/hygienist pay for it (% of production or collections, or per hour from
     the time clock rates), merchant/financing fees; defaults suggested from categories and the finance module's
     supply spend; kept with history like fee schedules.
PM2. **Contribution margin of every visit:** expected collection (fee after PPO write-off and expected insurance/patient
     payment) minus direct costs = contribution margin, and per chair-hour and per doctor-hour (using the visit's
     doctor (X) and assistant (/) time); compared with the office's overhead per hour → profit per hour.
PM3. **Business view on the schedule (owner-only toggle):** each appointment colored by contribution margin per hour
     against thresholds the owner sets (e.g. red below overhead, amber, green, gold), with a hover breakdown (fee,
     write-off, lab, supplies, associate pay, margin, per hour); column and day totals of margin and profit; hidden
     from staff who don't have the permission.
PM4. **Know what's not profitable:** reports by procedure, provider, payer (PPO) and appointment type — margin per
     hour, the least profitable procedures under each PPO, and "what if" (raise a fee, drop a plan, change a lab):
     so the dentist can see in real time what actually pays and what doesn't.

## The business of today: labor vs production, live (asked for, dig deep)
Builds on the time clock (punches, shifts, pay rates in cents — timeclock:rates), production (server/src/production.js),
contribution margin (PM), the schedule, finance overhead and metrics. Owner/manager only (money + pay).
BD1. **Today's P&L strip (owner toggle on the schedule and a "Today" business page):** scheduled production, completed
     so far, expected collections (after PPO write-offs), direct costs (lab, supplies), labor cost so far and projected
     for the day (from who is clocked in and scheduled shifts × pay rates, incl. overtime), labor % of production and of
     collections vs target (e.g. 25–30%), overhead per hour, and projected contribution/profit for the day — updating
     live as people clock in/out and visits complete.
BD2. **Productive vs idle time on the schedule:** a staff lane per person (from shifts and punches) under the chair
     columns, shaded by what they're doing: in a visit (their chair/provider has a patient), assisting, admin, on break,
     idle/unassigned time (clocked in with nothing scheduled); per person: hours paid, hours productive, productivity %,
     production supported per labor hour; idle gaps highlighted (with suggestions: fill from the ASAP list, send
     someone home early, move lunch).
BD3. **Staffing vs demand:** people scheduled per chair/hour vs visits booked (overstaffed/understaffed hours), clocked in
     early/late and overtime risk for today; recommendations ("2 assistants for 1 doctor chair from 2–4 pm").
BD4. **Daily, weekly, monthly trends:** labor %, production per labor hour, productivity % by person/role, idle hours
     and cost, overtime cost — in metrics (one definition each, docs/metrics.md), the end-of-day email and the
     capacity meter; drill-down to the shifts and visits behind every number. Pay details visible only with
     timeclock:rates; staff never see each other's pay.

## Team bonus module (asked for; off unless the owner turns it on)
Builds on metrics (one definition per KPI), production/collections from the ledger, time clock (hours, payroll
exports), reviews shout-outs, recurring checklists and the business view.
BN1. **The common bonus plans, ready to switch on and configure** (each with plain-language rules and a worked example):
     1) Team production/collections bonus: when monthly collections exceed a target (often labor cost ÷ target labor %),
        a share of the excess is split by hours worked or by role weights;
     2) Daily/weekly goal bonus: hit the day's production or collections goal → a set amount per person on shift;
     3) Per-procedure spiffs: a set amount (or %) to the provider/assistant/scheduler for specific codes (e.g. sealants,
        fluoride, whitening, perio maintenance, same-day crowns) — attributed from the visit;
     4) Hygiene/associate % of production or collections above a base (per provider);
     5) KPI scorecard bonus: points for hitting targets (reappointment %, case acceptance, collections %, unscheduled
        treatment scheduled, new patients, reviews/shout-outs, checklist completion) → payout tiers;
     6) Front desk bonuses: scheduling/confirming (schedule fill %, broken-appointment rate), collections at time of
        service, treatment scheduled from the follow-up list.
BN2. **Visible to the team:** a progress card on the dashboard and a slim bar on the schedule ("Team goal: $18,400 of
     $22,000 this month — $3,600 to go · on pace"; "Today: 92% of goal"), each person's own qualified/not-yet status
     and what they've earned so far; never shows other people's pay unless the owner chooses a team-visible plan.
BN3. **Owner control and payroll:** plans are off by default, versioned, with effective dates, caps, eligibility
     (hours minimum, active status), clawbacks for refunds/voids (computed from the ledger), an approval step at the end
     of each period, audited; approved bonuses flow into the time-clock payroll export as a separate pay type.

## Today's schedule optimizer (asked for, the most important one)
Approach: a deterministic engine finds and prices every opportunity (fast, explainable, testable); AI only ranks and
explains them in plain words and never changes the schedule itself. It runs each morning for the huddle and again
whenever the schedule changes (live), so advice is always current.
OPT1. **Goal gap per provider:** for each doctor/hygienist today: scheduled vs goal, the gap in $, open time and blocks.
OPT2. **Opportunities found and priced**, each with the $ it adds and one-click action:
      - patients already on today's schedule with unscheduled/planned treatment that fits in their visit or an
        adjacent gap ("Maria's #30 crown prep fits after her cleaning with Dr. Chen at 10:40 — $1,150");
      - opportunity-finder items for today's patients (sealants, fluoride, x-rays due, perio maintenance, SRP…);
      - family members due for recall or with open treatment who could come with the patient already scheduled;
      - ASAP-list and recall-due patients who fit an open gap (length, provider, type), with a one-tap text offer;
      - appointments longer than the type's usual time that could be shortened to open room (and what fits in the
        freed time); visits that could be combined; doctor exam timing clashes to fix;
      - no-show-risk visits to double-confirm, and late-cancel gaps to fill instantly (fill offers).
OPT3. **A clear plan to hit goal:** "3 moves get Dr. Chen to 104% of goal": ranked, non-conflicting combination of
      opportunities, shown in the huddle, on the schedule (a slim optimizer panel and markers on the gaps/visits) and
      in the morning huddle email; each accepted/declined/done is tracked, with $ captured per day and per person.
OPT4. **Rules:** never double-books against patterns/blocks, respects patient preferences and insurance frequency,
      nothing is booked or texted without a person's click (AI recommends; people approve), every action audited.

## Lab case check-in, by photo and voice (asked for)
Builds on lab cases (lab Rx, lab slips, lab portal page, outstanding lab cases report), the schedule, voice
assistant/dictation and documents.
LB1. **Never seat a patient without the case:** every visit that needs a lab case (crown seat, bridge, denture,
     night guard, implant crown…) is linked to its case; the schedule card shows the case status (sent, in production,
     due back, **arrived + checked**, problem); visits within N days whose case hasn't arrived are flagged in the
     huddle and a to-do is created to call the lab.
LB2. **Super simple check-in:** scan the lab slip/box or pick from "due this week"; take a photo (phone/iPad/webcam) of
     the case and slip; a short quality checklist (right patient and tooth, matches the Rx, shade, margins/contacts
     look right, no cracks, all parts/models present) — one tap "Looks good" or note a problem; it attaches to the
     case and the appointment, and the card turns green.
LB3. **By voice:** "Lab case is in for Maria Lopez — crown for number 30, shade A2, looks good" → matched to the case
     and visit (confirm on screen with the photo), checklist filled from what was said, recorded who/when.
LB4. **Problems handled:** a failed check notifies the doctor, drafts a note to the lab (remake/adjust) and offers to
     move the visit; late cases and remakes are tracked per lab (turnaround and remake rate report).

LB5. **Special materials and parts, not just lab cases (asked for):** a visit can need parts that must be ordered and
     on hand — implant fixtures (brand, platform, diameter × length), abutments/screws/healing caps, scan bodies, bone
     graft and membranes, aligners/retainers arriving from the ortho lab, sedation supplies, special burs or kits. Each
     is a "needed for this visit" item with status (to order → ordered → arrived → checked/set aside), linked to the
     inventory module (stock reserved if on the shelf, reorder if not), shown on the schedule card with the lab status
     in one "ready / not ready" badge, flagged in the huddle days ahead, checked in by photo/voice like lab cases.
     Templates per procedure (e.g. implant placement → fixture + healing abutment + graft) prefill what's needed.
## X-ray AI as a second set of eyes (asked for)
Builds on the AI x-ray findings framework (provider adapters for Pearl/Overjet, overlay on the viewer).
XR1. **Use FDA-cleared detection, not a home-grown model:** finish/verify the Pearl (Second Opinion) and Overjet adapters
     and add VideaHealth; findings (caries by surface, calculus, periapical radiolucency, bone level, margin
     discrepancies, existing restorations) shown as a toggleable overlay with confidence, clearly labelled "AI
     suggestion — the dentist decides". A general-purpose AI model is not validated for this and is not used to
     detect disease.
XR2. **Don't miss things:** each AI finding is compared with the chart — "AI saw possible caries on #19 D; not charted"
     — as a short review list for the dentist (accept → chart it with the finding linked as the reason, or dismiss
     with one tap); pre-appointment "second look" on today's patients' new x-rays; all accept/dismiss recorded (rule
     10), never charted automatically.
XR3. **Patient education:** the overlay (with the dentist's accepted findings only) can be shown on the chair screen
     to explain treatment, and feeds the treatment presentation.

## Exams today and the production they predict (asked for; business view)
EX1. The business view and huddle show today's exams by type: new patient, recall/periodic, emergency/limited, perio
     (from the codes on today's visits), vs a daily target per type.
EX2. **Value of an exam, learned from the practice's own history:** for each exam type (and provider), the average
     production diagnosed and actually completed within 1, 3 and 5 months after the exam (from the diagnosis &
     conversion funnel, DX) — e.g. "a new patient exam is worth $1,840 within 5 months; recall $610; emergency $1,120".
     The owner can override with their own values.
EX3. **Enough exams to support production:** today's (and this week's/month's) exams × value = the future production
     they're likely to generate, compared with the production goal for the coming months — "This month's exams
     support about $96k of the $110k goal: add ~9 new patient exams or ~25 recall exams"; trends in metrics and the
     monthly email.

## Benchmarks and a leaderboard across practices (asked for)
Needs care: it shares numbers between practices, so it's opt-in, aggregate-only and de-identified.
BM1. **Opt-in per practice (owner), and per doctor for being named:** off by default; practices that join share only
     provider-level aggregates (rates, $ per exam, counts) — never patient data; names hidden (e.g. "Dr. #4821",
     region and practice type only) unless a doctor chooses to show their name.
BM2. **What's compared (one definition each, from docs/metrics.md, so everyone is measured the same way):**
     diagnosis $ per new-patient / recall / emergency exam, case acceptance and conversion at each funnel step,
     production per doctor-hour and per hygiene-hour, hygiene reappointment %, perio %, new patients per month,
     collections %, broken-appointment %, schedule fill %, labor % (optional).
BM3. **Fair comparisons:** peer groups by practice type (general, pediatric, perio, ortho…), size, region, payer mix
     (PPO-heavy vs fee-for-service) and years in practice; a benchmark is shown only when at least N practices
     (e.g. 10) are in the group, so nobody can be singled out; percentiles (25th/50th/75th/90th) with "you are at the
     68th percentile for recall exam diagnosis".
BM4. **Leaderboard and coaching:** monthly leaderboards per metric and peer group (anonymous by default, fun badges),
     each doctor's own "above/below average" card with the 2–3 biggest opportunities and what top performers do
     differently (from the numbers, not guesses), in the metrics page and monthly email.
BM5. **Plumbing:** a separate benchmark service receives only the nightly aggregate rows from opted-in practices (signed,
     over TLS, logged in Connection activity), with the practice able to see exactly what was sent and to leave at any
     time (its rows removed from future benchmarks). Terms/BAA language reviewed before launch.

## Treatment entry: shortcuts, custom buttons and bundles (asked for, big deal)
Builds on chart-by-typing (chartShorthand.js: "30 MO caries", "14 D2740", "2-4 sealant plan"), the most-used codes
row, voice charting (voice assistant + dictation) and treatment plans/phases.
TE1. **Bundles:** named packages of procedures entered in one step, with tooth/surface rules and options — e.g. "Crown"
     (crown + optional buildup + optional post), "Implant" (fixture + abutment + implant crown, as phases), "New patient"
     (comp exam + FMX + prophy), "SRP 4 quads", "Bridge 3–5" (retainers + pontic from the range), "Denture upper",
     "Night guard"; fees and insurance estimate for the whole bundle; office bundles plus each dentist's own; starter
     set to adapt.
TE2. **Custom shortcuts everywhere:** customizable quick buttons on the chart (office and per user, ordered, colored,
     with icons), keyboard hotkeys for them (e.g. Alt+1…9) and typed aliases for chart-by-typing ("bu" = buildup,
     "cr" = crown, "imp" = implant bundle, "np" = new patient bundle); the same aliases work by voice ("crown bundle on
     14 with buildup, plan it"); a small editor with a live preview and a cheat sheet in the ? help.
TE3. **Fast, safe entry:** everything goes through one engine (typing, buttons, bundles, voice) → the same preview
     (teeth, codes, fees, estimate) → Enter/confirm to chart, Undo afterwards; validation (tooth/surface valid for the
     code, duplicates, frequency limits warned); phases/alternatives chosen as part of the bundle when relevant.

## Billing that runs itself, and never goes silent (asked for)
Builds on payments (processor adapter, currently Stripe; terminal payments), payment plans + autopay, memberships
billing, ortho billing, statements (text-to-pay, Lob), the patient-balance cadence from A4, Needs attention.
BL1. **Simple setup:** one "Set up payments" step from the ledger, checkout, treatment acceptance (F4) or the portal:
     pick a payment plan (down payment, months, day of month) or a recurring charge (membership, ortho monthly, any
     amount), save the card/bank account (tokenized at the processor — never stored by us), patient agrees on screen
     or by text link (signed authorization kept); one clear list of every active plan and what's next.
BL2. **Automatic and posted:** each charge runs on its date, posts to the ledger idempotently (processor charge id),
     sends a receipt, and reconciles with the processor's payouts (daily; mismatches become exceptions).
BL3. **Never silent (dunning):** a declined or failed charge immediately: posts nothing, creates a Needs attention item
     for billing, texts/emails the patient a secure "update your card" link, retries on a smart schedule (e.g. day 3,
     day 7, day 14), pauses the plan after the last try and notifies the team with next steps (call script, send
     statement, move to collections); expiring cards are caught a month ahead with an update-card request; disputes/
     chargebacks and refunds are tracked and posted as reversals; every step visible on the patient's account.
BL4. **Merchant services:** processors behind one adapter (Stripe today; others dental offices commonly use can be
     added, e.g. Rectangle Health, Global Payments/OpenEdge, Worldpay, Square, Payrix) — surcharge/convenience-fee
     rules by state, card-present terminals, text-to-pay and online payments through the same adapter; the owner
     picks the processor in Settings; sandbox mode for demos and tests.

## Then: remaining workflow batches
9. Batch 4 (32–44): new patient setup, ERA/EOB posting, prescriptions, lab cases, huddle actions, recall lists,
   pre-auths, financing, adjustments, referrals, end-of-day, review requests (fix the count bug), clock in/out.
10. Batch 5 (45–54): claim follow-up, appeals, statements, refunds, KPI reports, schedule templates, merges,
    inventory, fee schedules, month-end.
11. Automation pass (prompt 8): eligibility overnight, ERA auto-posting with a mismatch queue, confirmations,
    ASAP fill, claim attachments, review requests, huddle report — each with an exceptions view.
12. Final skeptical review (prompt 9): all specs, principles, data safety; fix high-severity findings.

## If time remains
13. Replace the remaining `window.confirm` / `window.prompt` calls (44 at the audit) with inline steps or undo.
14. Office switching without a full page reload.
15. Accessibility pass on the new chart and perio (labels, focus order, contrast in dark mode).
