# 45 · Claim follow-up / insurance aging

**Budget: 3 actions per claim, +1 to open the call panel** (audit: 2 to reach + 3 per claim). **Measured: 4 for the
first claim (L, digit, reference, Enter), 3 for each one after** — `e2e/workflows/45-54-monthly.test.mjs` (#45).

## Trigger and who
Weekly (or daily in a busy office), billing calls payers about claims that were sent and not paid. `billing:read` to
see the list, `billing:write` to log a call.

## Measured path
Billing → Insurance follow-up (`/claims?tab=followup`; Billing reopens on the tab you last used; Ctrl/⌘K
"Insurance follow-up"). The list opens on **Due for a call**, the first claim selected:
1. **L** (or Enter, or "Log call") opens the call panel beside the list — no dialog.
2. **1–8** picks what the payer said (In process, Paid, Denied, Need info…). The cursor jumps to the reference box.
3. Type the call reference. 4. **Enter** saves. The panel moves straight on to the next due claim.

## Defaults
- "Call again on" follows the answer (in process 14 days, denied 3, need info 7…; `NEXT_CALL_DAYS`), editable.
- "Spoke with" remembers the last rep per payer (this browser only). Payer phone is on the row and in the panel.
- Due first: `GET /reports/outstanding-claims` puts claims due a call first (follow-up date reached, or 30+ days out
  with no date — `FOLLOW_UP_AFTER_DAYS` in `server/src/monthlywork.js`), then the rest by age; `due_count`, `?due=1`;
  `?order=submitted` keeps the old order for the CSV/report.

## Keyboard
J/K move · L/Enter log a call · 1–8 the answer · Enter save · S ask the payer for status (276/277) · Esc close.

## Background
The weekly/monthly pass (`runMonthlyWorkJobs`) raises **"N insurance claims are due a follow-up call"** in Needs
attention for billing and resolves it once none are due. An appeal (#46) sets the claim's follow-up date itself.

## Safety
A call is `POST /claims/:id/calls` (unchanged: validated, practice-scoped, recorded in the claim's history).
