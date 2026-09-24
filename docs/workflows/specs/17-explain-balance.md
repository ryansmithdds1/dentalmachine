# 17 · Explain a balance

**Trigger:** "Why do I owe this?" — at the desk, on the phone, or before sending a statement. **Who:** anyone with
billing:read. **Data:** the ledger, open claims, what each payment paid for.

**Today (audit):** 2 actions to reach the ledger, then reading raw entries; nothing says in plain words what each
visit cost and who paid what.

**Budget:** 1 action (Alt+L with the patient active; the explanation is at the top of the ledger).

**Redesign:**
- **`GET /patients/:id/balance-explained`** (`billing.js`): worked out from the ledger every time — never a stored
  balance. Charges are grouped by visit (the appointment of the procedure, else the day); each shows what was
  charged, what insurance paid and wrote off, discounts, what the patient paid (using the same allocation as the
  ledger: insurance to its claim's lines, everything else oldest charge first), what's still waiting on insurance
  (open claims' estimates and expected write-offs) and what the patient owes now. Credit paid ahead and anything
  unexplained ("other") are listed, so the parts always add up to the ledger balance.
- **Ledger** (`patient/BalanceWhy.jsx` in `LedgerTab.jsx`): a "Why this balance" card with one plain sentence
  ("$X is open from 2 visits. $Y is waiting on insurance, so the patient owes $Z now.") and a line per open visit;
  paid-off visits are counted, not listed. W hides/shows it (remembered per person); *Print statement* is on it.

**Automated:** all of it.

**Edge cases:** voided entries and their reversals cancel out and aren't shown; credit balances read as credit;
insurance paid more or less than estimated → the difference stays with the visit; refunds larger than the credit
they came from appear under "Other" rather than silently disappearing; another practice → 404; no billing access → 403.

**Acceptance:** `e2e/workflows/11-12-16-17-18-money.test.mjs` — Alt+L from the schedule shows the explanation in
1 action; its parts add up to the balance; W toggles it. `server/test/moneyflows.test.js` — pending claim, patient
payment to the oldest charge, a voided payment ignored, insurance paid, overpayment as credit, parts = balance.
