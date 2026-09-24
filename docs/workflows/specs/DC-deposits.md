# DC · Close the day's deposit (and cash drawers)

**Budget: 4 actions when it balances.** Measured: **3** with verified drawers (Ctrl/⌘K → "deposit" → Enter opens
Today's deposit with every check ticked and the verified drawer cash filled in → type the bag number → Enter).
Counting the cash at the desk instead adds the count itself (one number per bill/coin, Tab between them), then the
same bag number + Enter. Tested by `server/test/deposits-cash.test.js` (server rules); the e2e click-budget test
is to be added under `e2e/workflows/` once the page is mounted.

## Trigger and who does it
End of day at each office: the person closing the desk (front desk or billing, `billing:write`) takes the checks
and cash to the bank. A second person — a manager (`deposits:manage`, or an administrator) who didn't prepare
it — verifies the bag. The owner reviews the Cash integrity report.

## Data needed
The day's cash and check payments at the office (from the ledger), the cash counted (by denomination, or the
verified drawer counts), the bag / deposit slip number, and — only when it doesn't balance — why.

## Today (before)
Billing → Deposits listed undeposited payments; a slip was made from ticked rows and could be undone by anyone
with billing access. No count, no second person, no lock, no cash drawer or receipt numbering, and the bank match
lived only in Finance.

## Target
- **Deposits and cash → Today's deposit** (`pages/Deposits.jsx`): checks listed one by one (payer, check #, date,
  amount; an insurance check paid across several claims is one line), cash expected from the ledger, a
  denomination counter (type counts, Tab through) or "Use the verified drawer count", big totals and a **green
  check when it balances**. Card batches and insurance EFTs are shown separately (they reach the bank on their own).
- Doesn't balance (cash short/over, or a payment held back): a reason is required, recorded on the deposit and
  flagged for the owner. **Submit and lock**: the deposit can't be edited; a manager can **reopen** it with a reason
  (the original is kept, voided, with its items) and a new deposit replaces it.
- After submitting: print the slip (PDF), add a photo of the stamped slip (camera on a tablet; stored encrypted).
- **History**: every deposit with a chip — Submitted → In the bank (matched from the bank feed) → Reconciled (and
  verified) — or **Needs attention** (late to the bank, short/over at the bank, a payment on it voided since).
- **Cash drawers**: open with a float (defaults to what the last close left), close with a **blind count** (the
  expected amount appears only after the count is submitted), a manager who didn't count verifies, recounts if
  needed, and records the over/short reason and the float left for tomorrow.
- **Cash integrity** (owner only): over/short by person and by week, cash voids and refunds (and who approved),
  adjustments and write-offs by person, deposits late to the bank, differences, voided receipts, reopened
  deposits, float changes, separation-of-duties warnings.

## What gets automated
- The server rebuilds the deposit from the ledger on submit (never trusts the screen's totals); `submit_key` makes a
  repeated submit return the first deposit; the payments are claimed with `deposit_id` in one transaction.
- Every cash payment (and cash paid out) gets the next **receipt number for its office** — unique, never skipped;
  a voided payment's receipt stays on the list marked voided.
- Bank matching is the existing Finance matching (a submitted deposit is a `deposits` row); the deposit watch moves
  deposits along and raises / resolves Needs attention items (`deposit-late:*`, `deposit-bank-diff:*`,
  `deposit-item-voided:*`).
- Cash voids, cash refunds, and a discount on an account the same person took cash from today need a manager
  (the guards in front of the ledger's routes), and each is recorded for the owner.

## Edge cases
Several offices: each office builds its own deposit (`location_id`), and someone limited to some offices only sees
theirs. A check from an earlier day not yet deposited is listed with an "earlier day" chip. A deposit already seen
by the bank can't be reopened — the difference is explained instead. A drawer must be verified before its cash can
go on a deposit. One open session per drawer.

## Acceptance
`server/test/deposits-cash.test.js`: deposit totals equal ledger payments (voided excluded); unbalanced submit
refused without a reason; verifier must differ; locked after submit; reopen audited and original kept; idempotent
submit (also two at once); blind count never leaks the expected amount; over/short math; receipt numbering unique and
sequential per office under concurrent requests; cash void/refund/discount need a manager; separation-of-duties
flag on the deposit and in the report; bank matching and exception raise/resolve; practice and office isolation;
permissions. Runs on SQLite and Postgres.
