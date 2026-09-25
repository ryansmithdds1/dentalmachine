# 11 · Set procedures complete

**Trigger:** the work of today's visit is done (chairside, or at the desk before checkout). **Who:** dentist,
hygienist or assistant (clinical:write); un-completing is billing (billing:write). **Data:** the planned procedures
on today's visit (or ticked rows), who did them, the charges they post.

**Today (audit):** 1 click per procedure in the chart, 2 from the schedule drawer. No "complete all of today's"
in the chart, and un-completing asked for its reason in a `window.prompt`.

**Budget:** 2 actions (Shift+C, Enter) for all of today's planned work.

**Redesign** (`patient/CompleteWork.jsx`, used by `ChartTab.jsx`'s procedure list):
- **Complete today's work (N)** above the procedure list: every planned procedure attached to today's visit.
  Tick rows (Tab to a checkbox, Space) to complete just those instead. Shift+C opens it from the keyboard.
- **One confirm step inside the chart** (not a dialog, not an undo toast — it posts charges): lists each code,
  fee and provider and the total to be charged; the Complete button has focus, so Enter posts; Escape backs out.
- **Provider from the server:** the procedure's provider, else the signed-in dentist/hygienist, else today's
  visit's provider, else the patient's dentist (`completeProcedure`). Work on today's visit is linked to it.
- **Afterwards:** "Completed N procedures; charges posted" with *Write the note* (the note composer drafted from
  them) — offered, not forced.
- **Un-complete** (Undo on a completed row): the reason is typed in the row, Enter reverses the charge on the
  ledger (voided with the reason, a reversing entry dated today) and puts the procedure back to planned.

**Automated:** choosing the provider; linking to today's visit; offering the note.

**Edge cases:** no visit today → the button says so and ticked rows can still be completed; a procedure already
completed elsewhere (another tab, a double press) is refused by the server (409) and the message names what
wasn't completed while the rest stay done; completing is one request per procedure, each with its own
Idempotency-Key; the AI can't complete work without a person (`requireHuman` in `completeProcedure`, and
`/procedures/:id/complete` is in `HIGH_RISK`); un-completing without billing access is 403, without a reason 400;
work already on a claim can't be un-completed until the claim is voided.

**Acceptance:** `e2e/workflows/11-12-16-17-18-money.test.mjs` — two planned procedures on today's visit completed
in 2 actions, both charged once with a provider; Undo with a typed reason reverses the charge, no browser dialog.
`server/test/moneyflows.test.js` — charges per procedure, a second complete is 409, un-complete needs billing
access and a reason, and the charge is reversed, not deleted.

## Checkout walk-out (A017, phase 2 batch 1A) — budget 4 actions, keyboard only
From the schedule: **O** on the finished visit opens its checkout; the amount is filled in with **what's due now**
and focused — **Enter** posts it; the next cleaning's first suggestion takes the focus — **Enter** books it; "Mark
checked out" takes the focus — **Enter** finishes. Each step can be skipped (Esc / Tab).
- **Due now** comes from the ledger (`SUM(amount)`, never a stored balance): balance − insurance still expected
  (payers' estimates on open claims + PPO write-offs, and for today's finished work not on a claim yet its estimated
  insurance share and write-off). The screen shows today's share, the earlier balance, what was paid today, due now,
  and the account balance with what insurance is expected to pay (`GET /appointments/:id/checkout` → `due`).
- The payment goes through `POST /patients/:id/payments` as before (Idempotency-Key, audited); a second Enter while
  it posts does nothing.
- Tested: `e2e/workflows/11-12-16-17-18-money.test.mjs` (walk-out: 4 keys, pays the older charge too, one payment,
  checked out, next visit booked); `server/test/frontdesk-b1a.test.js` (due now with a pending claim, today's
  unclaimed work, a payment today, and filing today's claim leaves it unchanged; no money without billing access).
