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
