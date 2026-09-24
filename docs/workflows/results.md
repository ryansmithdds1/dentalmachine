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
