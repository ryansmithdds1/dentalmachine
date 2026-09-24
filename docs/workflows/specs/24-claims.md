# 24 · Create and send claims

**Budget: 1 action** once the patient's chart (Insurance tab) or checkout is open; **3** from any other screen for
the active patient. Measured: **1** (B) on the Insurance tab, **3** (Ctrl/⌘K, "bill", Enter) from the schedule.
Tested by `e2e/workflows/24-26-27.test.mjs`.

## Trigger and who does it
The billing coordinator or front desk after a visit's work is set complete — at checkout, from the patient's
Insurance tab, or later from anywhere while the patient is active. Needs `billing:write`; assistants and
dentists without billing access see no button and get 403 from the server.

## Data needed
The patient's active policies (`GET /patients/:id/insurance`), what's finished and not yet on a claim to that
policy (`GET /patients/:id/unclaimed-procedures?patient_insurance_id=`), any draft claim to the same policy
(`GET /claims?patient_id=&status=draft`), the clearinghouse connection (`GET /clearinghouse`), then
`POST /claims` and `POST /claims/submit`.

## Today (audit row 24, measured in the code)
- **Insurance tab: ~6** — tick each procedure (or "Select all") 1–3, "Create primary claim" 1, open the claim 1,
  "Send" 1 (plus a `confirm()` on a resend).
- **Checkout: 4** — "Create claim" 1, then go to Billing / the claim 1, find it 1, Send 1.
- Claims were made but never sent from where they were made; nothing was ticked for you.

## Target
| Start | Steps | Actions (measured) |
|---|---|---|
| Patient's Insurance tab | **B** (or the "Send primary claim to …" button) | **1** |
| Checkout | **B** (or "Send claim to …") | **1** |
| Any screen, active patient | Ctrl/⌘K, "bill", Enter | **3** |
| A draft that failed the checks, after fixing it | B on the Insurance tab ("Send claim #n") | **1** |

One action makes the claim for what's ticked **and sends it** when it passes the checks — through the
clearinghouse, or as an 837 file to upload when there's no clearinghouse. A toast says what happened
("Claim #41 ($182.00) sent to Delta Dental through Sandbox"). No window, no confirm.

## Smart defaults
- **What's billed** — every finished, unbilled procedure with a fee is ticked by default (zero-fee lines are
  listed but not ticked); unticking any keeps the person's choice.
- **Who's billed** — the primary policy; with two policies the tab's "Bill primary / secondary" switch picks, and
  the secondary claim is drafted by itself when the primary pays (`services.js createSecondaryClaim`).
- **How it's sent** — the office's clearinghouse connection; otherwise the 837 file.
- **An unsent draft** — when nothing new is unbilled, B sends that draft instead of making another claim.

## Keyboard-only path
B on the Insurance tab or checkout; from anywhere, Ctrl/⌘K "bill" (also "send claim", "file claim") for the active
patient — the command bar lists "Bill insurance for <name>". The active patient stays in context: nobody has to
search for them again.

## Background automation
- Checks run before anything is sent (`POST /claims/submit` validates the claim); secondary claims are drafted on
  the primary's payment; the clearinghouse's acknowledgments and rejections come back on their own; a
  rejected claim returns to draft with the payer's message and shows on Billing → Claims → Needs attention.
- Claims left as drafts are listed under Billing → Ready to send, so nothing made is lost.

## Safety (CLAUDE.md)
- **Never deleted** — a claim that fails the checks stays a draft with the reason shown; a sent claim is corrected
  or voided on its claim screen, never deleted. There's no Undo on sending (a claim that reached the payer can't be
  unsent); it isn't destructive either, so there's no "Are you sure?".
- **Idempotent** — the same procedure can't be on two claims to the same payer (409); a second submit of a sent
  claim is refused (409, `already_sent`) unless it's a deliberate resend; the button/key ignores a second press
  while the first is in flight, and a second B with nothing left to bill makes nothing.
- **Validated on the server** — policy and procedures belong to the patient and the practice; `billing:write`.

## Edge cases
- No insurance on file: "has no insurance on file — nothing to bill".
- Everything already billed and no draft: "Nothing to bill … every finished procedure is already on a claim".
- Payer with no payer ID (can't go electronically): the claim is made, stays a draft, and the toast says
  "was made but not sent: … It's waiting under Billing → Ready to send"; the tab then offers "Send claim #n".

## Acceptance
- e2e: Insurance tab B = 1 action, one submitted claim with every finished procedure, a second B makes no second
  claim; command bar = 3 actions; a failing claim stays a draft and a second B sends the same draft (no new claim);
  no dialogs.
- `server/test/efficiency-w3.test.js`: unbilled list, create + send, the same work can't be claimed twice (409),
  a resend is refused (409), a failing claim stays a draft listed as ready to send with its problems, an assistant
  gets 403.
