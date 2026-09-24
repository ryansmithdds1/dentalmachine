# Results: before and after

"Before" is the audit's count of what the code required (no timing was measured before the redesign, so the time
column shows the audit's estimate of steps only). "After" is measured by the Playwright workflow tests
(`e2e/workflows/`), which fail if a workflow goes over its budget. One action = a click, a key press, or typing
into one field.

| # | Workflow | Clicks/actions before | Actions after | Time before | Time after (test) | Budget | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Search/open a patient | 3 (exact spelling only; +1 to dismiss an office alert) | 3 (typos, any DOB format, phone, old chart #) | — | 0.3 s | 3 | First letter after Ctrl/⌘K no longer lost; office alert is a banner |
| 2 | Today's schedule / switch view | 2 to open + 1 click per view switch (no key) | 2 to open (G S); 1 key per switch (C, P, V one provider) | — | 0.5 s open, < 0.1 s switch | 2 | Provider choice remembered per person |
| 3 | Appointment status | 2 per step (open drawer + button), ~6 per visit | 1 per step (I, S, R, O keys or one card button) | — | < 0.1 s per step | 1 per step | New "Ready" (for doctor / checkout); Undo on every step. Completing with charges takes 2 (see below) |
| 4 | Patient summary | 0 on the schedule (mouse hover only); 3+ elsewhere | 0 on every screen (patient bar) | — | instant | 0 | Alt+C/N/B/T/L/P act on the patient |
| 5 | Identify an inbound caller | 1 click; unknown callers had no next step | 1 key (Alt+O); caller becomes the active patient with no action | — | < 0.1 s | 1 | Family pick 1; text back an unknown caller 2; attach inline 3 |
| 6 | Send/read texts | 4 to send | 3 (Alt+T, type, Enter); inbox reply 3 | — | 0.2 s | 3 | J/K move between threads; attach unknown numbers inline |
| 7 | Clinical notes | ~7 (template picked by hand, confirm dialog, visit linked after) | 3 (Alt+N, type, Ctrl+Enter) | — | 0.6 s | 4 | Drafted from today's visit and linked to it automatically |
| 8 | Chart conditions and findings | ~9+ per finding, one tooth at a time | 3 per entry, any number of teeth ("2-4 sealant plan") | — | 0.2 s | 4 | New anatomical chart; Undo instead of confirm/prompt |
| 9 | Book an appointment | 7–8 | 2 (Alt+B, Enter: next open time, type defaults); 3 from a drag; 4 with a name search | — | < 1 s | 3 | Search-then-book is 4: two of those are finding the patient (#1) |
| 10 | Reschedule | 3–4; no keyboard way | 3 (M, arrow, Enter); drag 1; pinned visit 2 | — | < 0.5 s | 3 | Blocked time asks inline (4) instead of a confirm() dialog |
| 13 | Confirm appointments | 2 per row | 1 per row (C); "text all unconfirmed" 1 click | — | < 0.1 s | 1 | "N unconfirmed" pill opens the list; undo on confirm |
| 19 | Cancel / no-show | 3, no rebook, no reason | 3 incl. reason + rebook (X, number, Enter); no-show 2 | — | < 0.5 s | 3 | Reason recorded and audited; no broken-appointment fee (no fee setting exists yet) |
| 20 | Check eligibility | 3+ per patient | 1 key for the patient on screen; overnight batch shows only exceptions | — | < 5 s | 1 | Result applied to the policy automatically |
| 21 | Build a treatment plan (3 procedures) | ~22 | 8 (N, "14 D2740" Enter per procedure, Ctrl+Enter); all unplanned work → new plan 1 | — | < 1 s | 10 | |
| 22 | Present / accept a plan | 3 staff, 6 patient | 2 staff, 3 patient | — | < 1 s | 2 / 3 | |
| 23 | Consent forms | 3 + DOB typing | 2 from the plan (in-office signing pass, no DOB) | — | < 1 s | 1–2 | From the command bar: 4 |
| 24 | Create and send claims | 4 from checkout; ~6 from the Insurance tab (tick, create, open, send; confirm() on resend) | 1 (B) on the Insurance tab or at checkout; 3 from any screen (Ctrl/⌘K "bill", Enter) | — | 0.1 s (tab), 0.5 s (command bar) | 1 | Made and sent in one step; everything finished is ticked; a claim failing the checks stays a draft and B sends it later (no second claim) |
| 25 | Claim attachments | ~7 per attachment | 2 | — | < 1 s | 2 | |
| 26 | Fill openings from the ASAP list | 6–7 by hand (offer form started at 09:00) | 2 (L, B book it now; or L, Enter to text the offer) | — | 0.2 s | 2 | ASAP first, then waitlist, then recall; Undo puts the visit back on the ASAP list; the offer form starts on the day's first opening |
| 27 | Update demographics / contact info | 6 (30-field Edit window) | 3 (E / click, type, Enter on the chart; Ctrl/⌘K "phone …" / "address …" from anywhere) | — | 0.1–0.5 s | 3 | Saved at once with Undo; the household at the old address moves too, each chart audited with before/after |
| 28 | Staff task | ~9 | 3 ("task … @name"); done 1 key with undo | — | < 0.5 s | 3 | Assignee sees a badge |
| 30 | Intake review | per-chart hunting | 1–2 per item on one list (/intake: J/K, A) | — | — | 2 | Browser test still to seed an item; server tests cover it |
| 31 | Insurance card → policy | ~12 typed fields | ≤ 4 (S, photo, read, confirm) | — | < 5 s | 4 | A person confirms; carrier added inline if missing |
| 32 | New patient + insurance | 16–20 over 2 modals and 2 screens | 5 (Ctrl/⌘K "new patient", Enter, one typed line, Enter) | — | ~1 s | 8 | Policy made from the same line; eligibility checked in the background |
| 33 | Post insurance payments | ERA automatic or 3; paper EOB ~5 + 2 per claim | ERA 0; exceptions 1 key (measured by A-eob-autopilot) | — | — | 0 / 3 + 1 per claim | Duplicate-check `confirm()` is now an inline choice |
| 34 | Prescription | 4–7 | 2 (favorite's number key, Enter) | — | < 0.1 s | 3 | Prescriber is the signed-in dentist / patient's dentist, not the first provider |
| 35 | Lab case | 12–15 | 3 (L, shade, Enter) | — | < 0.2 s | 6 | Patient, lab, work, tooth, provider filled in; Undo cancels (never deletes); no `confirm()` |
| 36 | Morning huddle | 0 to view; each fix on another screen | 0 to view; 1 key per fix on the row (C, V, B, P, M, L) | — | < 0.3 s | 1 per fix | J/K pick the row; confirm has Undo |
| 37 | Recall / unscheduled lists | 7–9 per patient | 3 (measured by RF-recall); 0 when the autopilot books them | — | — | 3 | |
| 38 | Pre-authorization | ~7 over 2 screens + manual 837 upload | 1 (Pre-authorize: made and sent to the clearinghouse) | — | < 0.2 s | 2 | File download only when no clearinghouse is connected |
| 39 | Financing application | 5–6 | 2 (Send an application, Enter) | — | < 0.2 s | 2 | Amount = plan's patient share, linked to the plan |
| 40 | Adjustment / write-off | 5 (dialog) | 3 (A, amount, Enter) inline | — | < 0.2 s | 3 | Last type remembered; reason required; Undo = void/reversal |
| 41 | Referral out | 6–10 | 2 routine, 3 critical (measured by RT-referrals) | — | — | 4 | |
| 42 | End-of-day deposit | 10–12 over 3 screens | 3 when it balances (Deposits & cash, bag #, Enter) | — | ~0.5 s | 4 | Bag # focused when it balances; closing the books is Undo, not `confirm()` (with #54) |
| 43 | Review request | 0 (automatic), no manual ask | 0; 1 by hand (measured by RV-reviews) | — | — | 0 | Reputation page now counts the requests (was always 0) |
| 44 | Clock in/out | In 1; out 3 (`window.prompt` for breaks) | 1 each way (I); user menu 1 click after opening it | — | < 0.1 s | 1 | Breaks are punched as they happen |
| 45 | Claim follow-up / insurance aging | 2 to reach; ~6 per claim in a modal; sorted by submit date | 4 for the first claim (L, 1–8, reference, Enter), 3 for each next; due calls first | — | 0.2 s per claim | 3/claim + 1 | Side panel moves on to the next claim; "N claims due a call" in Needs attention |
| 46 | Denied claim appeal | ~7–11; letter lost on leaving | 2 on the claim (D, Ctrl/⌘+Enter); 1 key (A) from the ERA worklist | — | 0.1 s | 4 | Filed on the chart as a PDF, in the claim history, follow-up in 30 days; template when AI is off |
| 47 | Patient statements | 3 + 2 per print-only account | 2 (Enter send, Enter print all as one PDF) | — | 0.1 s | 2 | One PDF for every paper statement of a run |
| 48 | Refunds | 6, from each ledger | 2 (R, Enter) from the Credits & refunds queue | — | < 0.1 s | 3 | No Undo (money out); audit has balance before/after |
| 49 | Production/collection reports | 4–6 for P&C | 1 from Reports, 3 from anywhere (Ctrl/⌘K); 1 per drill-down | — | 1 s | 1–2 | Feature spec PR-production |
| 50 | Schedule templates / provider hours | time off ~6 | day off 3 once the Settings.jsx line is in (test skips until then) | — | 0.1 s | 4 | Templates: S2-perfect-day test |
| 51 | Merge duplicate patients | 5–6; kept chart not chosen | 3 (Enter, type MERGE, Enter); side-by-side, the chart with history kept | — | < 0.1 s | 3 | Archived, never deleted; duplicates raised in Needs attention |
| 52 | Inventory ordering | 4 + ordering outside; receive 2–3 per item via prompt | order 2 (O, Enter) with Undo; receive 1 with Undo | — | < 0.1 s | 3 | "On order" state kept in the item history |
| 53 | Fee schedule updates | 4 + 1 per code | 2 (FS-fees test) | — | — | 4 | Feature spec FS-fees |
| 54 | Month-end close | 5 + confirm box; reports one by one | packet on screen (4 from anywhere, 3 with the palette line); close 1 key with Undo | — | 1 s | 3 | Reminder in Needs attention from day 5 |

## Couldn't hit the budget

- **#3, completing a visit that posts charges (O key): 2 actions.** Undo can't take back ledger charges, so O opens
  the drawer with "Complete visit & procedures" focused and Enter finishes it. Visits with nothing to charge
  complete in 1.
- **#3, no-show and cancel keep their current flow** (no-show releases procedures and recalls that Undo can't
  restore; cancel keeps its confirmation, since it offers the rebook/fill choices).
- **#9, booking with N and a name search: 4 actions** (budget 3). Two are the patient search itself; once the
  patient is active it's 2.
- **#10, moving into blocked time: 4** — the extra Enter on "Move it there" is the deliberate replacement for the old
  confirm() dialog.
- **#23, consent forms from the command bar: 4 actions** (Ctrl/⌘K, "consent", Enter, Enter). From the plan it's 2.
- **#45, the first claim is 4 actions** (L opens the call panel); every claim after it is 3, the budget per claim.
- **#50, a provider's day off can't be measured yet:** "To" doesn't follow "From" when a date is typed (Settings.jsx,
  a shared file — the line is in `specs/50-schedule-hours.md`). With it, 3 actions (checked on a copy).
- **#54, opening the packet from the command bar is 4** until "Month-end close" goes to `?tab=close&type=month`.
