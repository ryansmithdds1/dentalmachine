# 33 · Post insurance payments (ERA / EOB)

**Budget: ERA 0; paper EOB 3 + 1 per claim.** Built and measured by the insurance autopilot —
see [A-eob-autopilot.md](A-eob-autopilot.md) and `e2e/workflows/A-eob-autopilot.test.mjs` (a clean ERA posts with
0 actions once auto-posting is on; each exception is 1 key; turning it on is 1 click). Not re-measured in the
daily test.

## Measured path
- ERA: nothing — clean remittances post as the automation; only exceptions reach the worklist (J/K, one key each).
- Paper EOB: Insurance autopilot → Paper EOB → photo or file (1) → **Looks right — post** (Enter).
- Manual check (Billing → Insurance payments): carrier, check #, amount, then paid / write-off per claim.

## Defaults
Paid and write-off per claim come from the ERA or the EOB read; the check date is today; the carrier is the one the
payer name matches.

## Keyboard path
Worklist: J/K, then `B` / `A` / `R` / `D` / `S` / `P`. Paper EOB: Enter posts once it adds up.

## Background automation
The clearinghouse mailbox is polled; clean lines post, claims close, secondaries are drafted and patients billed
(A1–A5). Reconciliation shows payer → posted → bank.

## Changed in this batch
The manual check form's "already posted" warning was a `confirm()` box; it is now an inline notice with
**The payer sent it twice — post it again** / **Don't post** (`client/src/pages/Claims.jsx`). Posting a
duplicate still needs that explicit choice, and the server still refuses it without `confirm_duplicate`.
