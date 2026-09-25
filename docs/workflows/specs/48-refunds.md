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
- **Permission (owner decision):** refunds need a manager (`deposits:manage`) or an administrator, on the server
  and on this screen. Billing staff without it see "R ask a manager to refund": R (or the row's **Ask a manager**)
  makes a to-do with the patient, amount and where it goes back to — once per account — and no money moves.
  (e2e: `45-54-monthly`, "#48 billing without a manager's rights".)

## Background
The month-end packet (#54) shows the credit total and links to this queue.
