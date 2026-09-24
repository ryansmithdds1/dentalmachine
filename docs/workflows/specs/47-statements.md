# 47 · Patient statements

**Budget: 2 actions** (audit; 0 once scheduled). **Measured: 2** (Enter sends, Enter prints every paper statement as
one PDF) — `e2e/workflows/45-54-monthly.test.mjs` (#47).

## Measured path
Billing → Statements (Ctrl/⌘K "Statements"). The accounts to statement are listed with the defaults (balance ≥ $5,
not statemented in the last 25 days).
1. **Enter** — "Send statements" has the focus once the list is in. Email for those who opted in; the mail service
   for mailable addresses when it's set up; the rest are for the office to print.
2. **Enter** — "Print all N (one PDF)" has the focus: every print-at-the-office statement of the run in one PDF
   (`GET /statements/runs/:rid/print`), one page per account. Those deliveries are marked printed; printing again
   (jammed printer) is allowed and audited. Older runs keep their "Print" button.
Before: one statement page per account (+2 each).

## Defaults and safety
- A "preview" link per row opens the account's statement. Sending is one run at a time (the button is disabled while
  it's going out); accounts statemented in the last N days are skipped, so a second run doesn't repeat them.
- Office-limited staff only print their offices' accounts.

## Background
Balances left after insurance are billed automatically when the owner turns on automatic patient billing in the
Insurance autopilot ([A-eob-autopilot](A-eob-autopilot.md)). A scheduled monthly run is not built yet (backlog).
