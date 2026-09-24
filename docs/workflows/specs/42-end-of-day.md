# 42 · End-of-day close, deposit, reconciliation

**Budget: 4 actions when it balances.** Measured: **3** (Deposits & cash → type the bag number → Enter). Tested by
`e2e/workflows/32-44-daily.test.mjs` (#42). The deposit and cash rules are [DC-deposits.md](DC-deposits.md)
(`server/test/deposits-cash.test.js`).

## Measured path
**Deposits & cash** (sidebar, or Ctrl/⌘K "deposit"). Today's deposit opens with every check ticked and the
verified drawer cash filled in. When it balances, the cursor is already in **Bag or deposit slip number**: type it,
Enter submits and locks the deposit.

## Before (audit row 42)
10–12 actions over 3 screens; `confirm()` on closing the books; the bank amount typed by hand.

## Defaults
Every undeposited check and cash payment for today at this office; the verified drawer counts; today's date.

## Keyboard path
Type the bag number · Enter (Ctrl/⌘+Enter from anywhere in the form). Counting cash here: one number per
denomination, Tab between them.

## Background automation
Bank feed lines match the deposit (Submitted → In the bank → Reconciled); late or short deposits become **Needs
attention**. Card batches and insurance EFTs reconcile on their own.

## Safety
The server rebuilds the deposit from the ledger (never the screen's totals), `submit_key` makes a repeated submit
return the first deposit, a mismatch needs a reason, and only a manager can reopen (with a reason; the original is
kept).

## Closing the books
Reports → Close (`CloseBooks.jsx`) closes the day without a `confirm()` box: it happens at once with Undo on the toast
(`POST /close/:id/reopen` puts the lock date back; both audited). That change is part of the month-end work
(workflow 54, [54-month-end-close.md](54-month-end-close.md)), which shares the component.
