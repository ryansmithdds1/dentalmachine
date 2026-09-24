# RCL · Recurring checklists by position

**Budgets:** ticking one of today's items **1 action** (tap the circle, or **X**/**Space** on the highlighted row).
A spore test with its photo **≤ 3 actions** — measured **2** (Take photo → the camera → **Pass**). Tested by
`e2e/workflows/RCL-checklists.test.mjs`; server rules by `server/test/checklists.test.js`.

## Trigger and who does it
- **Owner / office manager** (`checklists:manage`; administrators always) sets up what each position does and
  when, watches the dashboard, and resolves flags.
- **Everyone** works their own list: "My checklist" (sidebar → Checklists, **Ctrl/⌘K → "my checklist"**, or the
  small card on To-do & labs).

## Data model (one way to represent it — `server/src/db.js`)
| Table | What it is |
|---|---|
| `checklist_positions` (+ `checklist_position_members`) | Who a checklist is for: everyone with a built-in role or custom role, plus people added by name. Archived, never deleted. Six defaults are made the first time Set up is opened (Front desk, Hygiene, Assisting, Sterilization, Doctors, Office manager). |
| `checklist_templates` | A checklist for a position; `location_id` NULL = every office (one occurrence per office). `starter_key` for starters. |
| `checklist_items` | A line and its schedule: `cadence` daily (on `weekdays`, or the days the office is open), weekly (`weekday`), monthly / quarterly / annually (`month_day` 1–31 clamped to month end, **-1 = last business day**; `month`), `due_time`; `assign_rule` position / person / on_shift; evidence: `result_type` none / number (`min_value`, `max_value`, `unit`) / pass_fail / text, `require_photo`, `require_file`, `require_note`; `critical`; `sop_page_id` → intranet page. |
| `checklist_occurrences` | Each time an item is due, per office. **Unique (item, due date, office)** — generation is idempotent. open → done, or missed when its window closes (`closes_on` = the day before the next one is due); cancelled = a future one a schedule change dropped. Result, `outcome` (ok / fail / out_of_range), who/when (`completed_*`, `completed_late`, `late_reason`). |
| `checklist_evidence` | Photos and files, stored through `storage.js` (AES-256-GCM when `DOCUMENT_ENCRYPTION_KEY` is set). Unique per occurrence + sha256 (a resend is the same photo). Removed with a reason, never deleted. |
| `checklist_events` | Append-only history of each occurrence: done, undone, corrected (before/after + reason), evidence, flagged, flag resolved, missed. Everything is also in `audit_log`. |
| `checklist_flags` | A failed result, a number out of range, or a critical item not done by its due time. One per occurrence + kind; linked Needs attention item (`issue_id`); open until `corrective_action` is written. |
| `checklist_settings` | Alert recipients (default: everyone with `checklists:manage`), chat posts on/off, text numbers for critical alerts, undo window (default 10 min). |

Why not the team chat's `task_series`? A task series skips dates nobody did and a task disappears when ticked;
a compliance checklist has to keep every due date, record misses, carry a result and evidence, and print as a log.

## Target flow
1. **Owner:** Checklists → Set up → **Add** a starter (sterilization with the weekly spore test, front desk open
   and close, hygiene room setup, monthly AED / emergency kit / oxygen, annual OSHA / HIPAA training, waterline
   testing). Each says "adapt to your office and state rules"; every line can be edited. Or New checklist → items.
2. **Job** (`runChecklistJobs`, every 5 minutes, also run on opening My checklist and the dashboard): makes today's
   occurrences (plus a lead time: monthly 3 days, quarterly 7, annual 30 ahead), fills in dates it missed (35 days
   back), gives "on shift" items to the position's person who is clocked in (else scheduled that day), flags
   critical items past their due time, marks closed windows missed (one Needs attention summary a day for
   ordinary misses), and closes flags someone resolved on the Needs attention page.
3. **Staff:** My checklist — To do (overdue first), Coming up, Done today. One tap ticks a plain item. A pass/fail
   item has **Pass** / **Fail**; a number has its box (Enter saves; outside the range it says so before saving); a
   photo button opens the phone/tablet camera (`capture="environment"`), shrinks the picture to ≤ 2000 px and
   uploads it; when everything the item needs is there it ticks itself. A tick shows an Undo toast.
   Keys: **J/K** move · **Space/X** tick (Pass) · **F** fail · **P** photo · **Enter** details · **U** undo.
4. **Critical flag:** a fail, a number out of range or a missed due time → flag → **Needs attention item (high)**,
   a live banner on the owner/manager's screen, an urgent post in team chat's Everyone channel calling on them,
   and (if turned on) a text to the numbers in settings. It stays open until someone with `checklists:manage`
   writes down the corrective action (dashboard or the item's panel), which also closes the Needs attention item.
5. **Owner dashboard:** today / this week / 30 days — on-time %, done, late, missed, overdue; by position and by
   person with streaks (days in a row with everything on time); 8-week on-time trend; today's board by position;
   click any row for its result, photos and history.
6. **Compliance log:** filter by item (one click: "Spore tests, last 12 months"), dates, critical only, text →
   **CSV** or a **printable page** (photos included; the browser's Print → Save as PDF). Exports are audited.

## Rules
- Completing needs everything the item requires (reading, pass/fail, answer, note, photo, file). **A failure is
  never held up for its photo** — a failed spore test is on record and flagged the moment it's known.
- A second tick is harmless (idempotent: the update only applies to an open occurrence).
- **Undo** within the undo window, by whoever ticked it or a manager. After that, a change is a **correction with
  a reason**; before and after stay in the history. A tick that raised a flag can't be undone — a manager
  resolves the flag and a wrong entry is corrected with a reason.
- A missed occurrence can still be recorded, with a reason (it counts as late).
- Evidence: only real photos (JPEG, PNG, HEIC, WebP, GIF) or PDFs (checked by content), up to 15 MB. Only people
  who may work the item (its position, its assignee, whoever ticked it, managers) can open it; other practices and
  offices get 404. A ticked item keeps its required evidence.
- Schedule changes: future open occurrences are cancelled and made again; today's follow the new time; done and
  missed ones never change. Archiving an item, checklist or position cancels its open ones from today.
- Everything is scoped to the practice; people limited to some offices only see those offices' items.
- Actor: the job runs as automation ("Checklists"); ticks record `completed_source` (human, or ai when the
  assistant acts). Resolving a flag and correcting a result are high-risk for AI (to be listed in
  `aiguard.js` HIGH_RISK).

## Edge cases
Month-end (31 → Feb 28/29; "last business day" uses the office's open days), weekday-only items, offices closed
on some days (daily items follow the office's hours), a server down for days (backfilled and counted missed),
two job runs at once (unique key), a position with nobody on shift (whole position sees it until someone clocks
in), an item edited mid-day, a photo sent twice, an alert text that fails (its own Needs attention item).

## Acceptance
- `server/test/checklists.test.js`: cadence math incl. month-end, leap years, last business day and weekdays;
  idempotent generation under concurrent runs; multi-office; assignment by person, schedule and clock-in;
  evidence enforcement; encryption on disk and evidence scope; critical fail → high issue + chat + text; out of
  range; overdue → issue; missed; resolve with action (and from Needs attention); undo window; corrections with
  reason and before/after audit; permissions; practice and office isolation; starters.
- e2e: tick = 1 action each; spore test with photo = 2 actions; a failed critical item shows on the dashboard.
