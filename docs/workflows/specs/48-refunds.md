# 48 · Refunds

**Budget: 3 actions** (audit). **Measured: 2** (R, Enter) — `e2e/workflows/45-54-monthly.test.mjs` (#48).

## Measured path
Billing → **Credits & refunds** (`/claims?tab=refunds`): every account the practice owes money to, largest credit
first (`GET /billing/credit-balances`, ledger sums — never stored).
1. **R** (or Enter, or "Refund…") opens the refund beside the list with the amount (the whole credit, or what's left
   on the card) and where it goes (the card used, when it was taken through the processor; otherwise check) filled in.
2. **Enter** — the button reads "Refund $X.XX".

## Safety
- Money goes out, so there is **no Undo** and the amount is on the button: that's the one deliberate step, not an
  "Are you sure?" box. A mistake is corrected with a new ledger entry.
- `POST /patients/:id/refunds` (unchanged rules: never more than the credit; card refunds through the processor).
  The audit now records the method, card or not, and the **balance before and after**.
- **Permission (for the owner to decide):** refunding needs only `billing:write`, the same as posting a payment.
  CLAUDE.md lists refunds among the sensitive actions that need the stronger permission. Not changed here.

## Background
The month-end packet (#54) shows the credit total and links to this queue.
