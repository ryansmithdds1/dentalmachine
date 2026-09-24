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

## Couldn't hit the budget

- **#3, completing a visit that posts charges (O key): 2 actions.** Undo can't take back ledger charges, so O opens
  the drawer with "Complete visit & procedures" focused and Enter finishes it. Visits with nothing to charge
  complete in 1.
- **#3, no-show and cancel keep their current flow** (no-show releases procedures and recalls that Undo can't
  restore; cancel keeps its confirmation, since it offers the rebook/fill choices).
