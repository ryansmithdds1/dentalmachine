# 12 · Take a payment

**Trigger:** the patient is at the desk, on the phone, or at checkout. **Who:** front desk or billing
(billing:write). **Data:** amount (integer cents), method, reference, receipt.

**Today (audit):** from the chart 3 actions (Ledger tab, Take payment, Post) in a modal; the method always
defaulted to card; at checkout the card reader opened a modal inside the page's flow.

**Budget:** 2 actions with the patient active (Alt+P, Enter).

**Redesign:**
- **Alt+P from any screen** goes to the ledger with the payment form open (`?tab=ledger&pay=1`).
- **An inline panel, not a modal** (`LedgerTab.jsx`), at the top of the ledger. The amount has focus with the
  patient portion (balance less what insurance is expected to pay) filled in and selected, so typing replaces it.
- **Method = the one this person used last** (`useRemembered('payment.method')`, via `patient/lastMethod.js`),
  saved after each successful payment. If Enter is pressed before the remembered value has loaded, the post
  waits for it rather than using a stale default; a method picked by hand always wins.
- **Enter posts.** Escape cancels. The form is disabled while posting and a second press is ignored.
- **Checkout** (`Checkout.jsx` CollectForm) works the same way: amount focused with the suggested amount, the
  remembered method, Enter posts; the card reader opens in place under the form instead of a second dialog.

**Automated:** amount, method.

**Edge cases:** double Enter / network retry → one payment (client guard plus the Idempotency-Key that api.js
sends; the server replays the first answer); zero, negative or unknown methods refused (400); another practice's
patient is 404; backdating only into the open period; card-reader payments still post through the processor
flow (`ReaderPay`) and never through this form; payment is not "undoable" from a toast — a mistaken payment is
voided from its ledger row with a reason.

**Acceptance:** `e2e/workflows/11-12-16-17-18-money.test.mjs` — from another screen, Alt+P then Enter posts the
patient portion by the remembered method (cash), once, with no dialog. `server/test/moneyflows.test.js` — the same
Idempotency-Key twice posts once; bad amounts/methods refused; other practice 404.
