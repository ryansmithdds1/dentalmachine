# 54 · Month-end close

**Budget: 3 actions** (audit). **Measured: 4 to the month-end packet from any screen** (Ctrl/⌘K, "month-end close",
Enter, M — 3 once the command opens the month, see below) and **1 to close** (C, with Undo) —
`e2e/workflows/45-54-monthly.test.mjs` (#54).

## Measured path
Reports → Close, **Month** (M; `?type=month` opens on it). Last month is chosen.
- The **month-end packet** is on the same screen, printable in one go (P): the month-end summary, production &
  income by provider, collections by payment type, adjustments & write-offs by type, insurance aging by carrier, and
  patient A/R aging and credit balances as totals only (the packet goes to the accountant) — `GET /close/packet`,
  built from the report library so the numbers match the reports. The loose ends are listed above it.
- **C** (or the button) closes the books through the month's end **at once, with Undo** on the toast instead of a
  confirm box. Undo is `POST /close/:id/reopen`: only the latest close, only while nothing moved the lock date since,
  administrators only; the close stays in the history marked reopened with who and why. Close and reopen are both
  audited with the lock date before/after. (The same applies to an end-of-day close on this screen.)
Before: 5 + a confirm box, and each report opened separately (2–4 each).

## Shared-file line
`client/src/components/CommandPalette.jsx`: `['Month-end close', '/reports?tab=close&type=month']` makes it 3.

## Background
From day 5 of the month, the weekly/monthly pass raises **"The books for YYYY-MM aren't closed yet"** for an
administrator; it resolves when the month is closed.
