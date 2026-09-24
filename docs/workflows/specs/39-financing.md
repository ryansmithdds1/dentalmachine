# 39 · Patient financing application

**Budget: 2 actions.** Measured: **2** (Send an application → Enter). Tested by
`e2e/workflows/32-44-daily.test.mjs` (#39). Choosing a lender while the plan is presented is
[F-financial-options.md](F-financial-options.md) (measured by `F-financial-options.test.mjs`).

## Measured path
Chart → Ledger → **Send an application** (or Ctrl/⌘K "financ" → *Send a financing application — name* from any
screen). The form opens filled in with Send focused; Enter texts the lender's link to the patient.

## Before (audit row 39)
5–6 actions: the amount was blank although the plan's patient portion was known.

## Defaults
- Amount: the patient's share of their open treatment plan after insurance and any discount; the application is
  linked to that plan.
- Lender: the first one the practice has a link for. Channel: text if there's a mobile number, else email.

## Keyboard path
Enter (Send is focused). Esc cancels.

## Background automation
Lender webhooks move the application along (started → approved → funded) and funding posts the payment to the
ledger once; staff update by hand only when a lender has no webhook.
