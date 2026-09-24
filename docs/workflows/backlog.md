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
