# A — Insurance payments posted and billed on autopilot

**Trigger:** an insurance payment arrives — an ERA (835) from the clearinghouse mailbox or uploaded, or a paper EOB
scanned or photographed. Nobody has to start anything for a clean ERA once the owner turns auto-posting on.
**Who:** billing / front desk (`billing:write`) for the exceptions and the paper EOB's "looks right"; the owner
(administrator) for the two switches. The assistant can prepare but never post (high-risk: `X-Human-Approved`).
**Backlog:** A1–A5 in `docs/workflows/backlog.md`. Plain-words guide for the owner: `docs/eob-autopilot.md`.

## Target
| Who | Step | Actions |
|---|---|---|
| Team | A clean ERA (auto-posting on) | **0** — posted, claim closed, secondary drafted, patient billed |
| Team | A clean ERA (auto-posting off, the default) | 1 for all of them: **Post all** (`Shift`+`P`) |
| Team | A denial: bill the patient / appeal / correct & resend / set aside | **1 key** (`B` / `A` / `R` / `D` + a reason) — budget 3 |
| Team | Send a secondary claim with the primary's EOB | **1 key** (`S`) — budget 3 |
| Team | Underpayment, overpayment, partial, reversal, unmatched line | 1 key each (`P`, `F`, `V`, `M` + pick the claim) |
| Team | Paper EOB | choose/take the photo (1) → **Looks right — post** (`Enter`) |
| Owner | Turn on auto-posting after reading the 30-day preview | 1 |

Measured (e2e `e2e/workflows/A-eob-autopilot.test.mjs`): denial 1 action, secondary 1 action, turn on 1 click.

## Screen
**Insurance autopilot** (`/insurance-autopilot`, `pages/EobAutopilot.jsx`; also in Ctrl/⌘K):
- **Worklist** — one list of everything that needs a person, J/K to move, the selected item's details in a side panel
  (reason in plain words, CARC codes, billed / paid / written off / patient / PPO-allowed), one key per action (shown on
  each button). Clean payments waiting to post are a single banner with **Post all**.
- **Paper EOB** — drop a PDF, pick a file, or take a photo (phone/iPad camera); the read comes back claim by claim with
  ✓ adds up / the reason it doesn't; **Looks right — post N**. The EOB file opens from the worklist and the claim.
- **Billing patients** — balances being billed after insurance (what was owed, what's owed now, what went out, paper,
  why stopped) and the hold list.
- **Reconciliation** — day by day: from payers → posted → waiting → in the bank / not in the bank; claims closed →
  billed → paid → written off → patient part → billed to the patient; and every gap.
- **Settings** (administrator) — auto-posting (off by default) with the 30-day preview, automatic patient billing and
  its rules (minimum balance, days to wait, paper after N days).

## What's automated
- **The rule (A1, `eobauto.js` `classify`)**: a claim's lines from one remittance post only when paid + contractual
  write-off (CO-45/42/131/253) + patient responsibility = billed, the payer billed what we billed, service lines map to
  our procedures and add up, there's no denial, reversal, overpayment or non-contractual adjustment, and — when the
  policy has a PPO fee schedule — the payer allowed exactly what it says. Anything else is an exception with a kind:
  denied · underpaid · overpaid · unmatched · partial · reversal · review.
- **Who posts**: ERA clean lines post as the automation (`source: automation`, actor "Insurance autopilot") when
  auto-posting is on, as the person when a person imported the file, else they wait as *ready*. Paper EOBs never post
  without a person (AI read them). Every posting goes through `postClaimPayment` (ledger entries; write-offs are
  adjustments), closes the claim, drafts the secondary, and is audited with the claim's before/after.
- **Idempotent**: `remit_lines.dedupe_key` (source, payer, trace/check #, claim, line) — a line arrives once; the same
  ERA file is refused (409 / duplicate inbox file); posting flips the row ready/exception → posted in the posting's
  transaction, so double clicks and two people post once; the same paper file twice is one EOB.
- **Denials** set the claim to denied with the reason (as before); the ERA is a Needs attention item until its lines
  are decided; next steps come from the reason codes (PR-204 → bill the patient; CO-29 → appeal; CO-16/252 → resend).
- **Reversals** (CLP status 22) never post: "Reverse the payment" reverses the claim's payment and write-off entries
  (`reverses_id`) and reopens the claim.
- **Secondary**: drafted on the primary's posting; one key files the paper primary EOB on the patient's chart
  (category EOB), attaches it as "Other payer's EOB" (`claim_attachments` EB), and sends through the usual path
  (`/claims/submit` with a clearinghouse, else `/claims/:id/submit`). ERA primaries travel inside the 837.
- **Billing the patient (A4, `autobill.js`)**: when a claim closes (posted, or a denial sent to the patient) and no
  secondary is pending, the account (guarantor) owes at least the minimum, isn't held or on a payment plan, after the
  wait days a *balance bill* starts; the cadence engine (type `patient_balance`) texts/emails a pay link (preferred
  channel, quiet hours, fallbacks, opt-outs, claim-before-send), reminders at +7 and +14; a paper statement (Lob, the
  same statement as the monthly batch, idempotency key per bill) goes after `paper_days` if the link wasn't opened
  (link-preview robots don't count) — or at once for someone we can't text or email. One active bill per account; a
  later claim joins it. Stops when paid (ledger balance − pending insurance ≤ 0), held, or on a payment plan.
- **Reconciliation (A5, `eobrecon.js`)**: the 15-minute job raises a Needs attention item for each gap
  (`eobrecon:era:*` money in a remittance not posted, waiting or decided; `eobrecon:eft:*` an EFT not in the bank feed
  5 days after its date; `eobrecon:claim:*` a claim whose ledger doesn't match what the payer said) and resolves it
  when it closes.

## Edge cases
Split claims (several CLPs) post together; a claim paid across remittances stays *partially paid* until the payer has
answered for everything billed. Provider-level adjustments (PLB: interest, recoupments) and ERA totals that don't
match their claims are one check-level row for a person; the claims still post. A line whose claim was posted by hand
meanwhile becomes an exception instead of posting twice. Practices never see or match each other's claims.
Restricted users see only their offices' lines.

## Acceptance
`server/test/eobauto.test.js` (exact reconcile, every exception kind, idempotent re-import and double clicks,
reversal, split/partial, secondary, paper EOB 428 without approval, billing rules, reconciliation raise/resolve,
isolation, preview); `e2e/workflows/A-eob-autopilot.test.mjs` (budgets above).
