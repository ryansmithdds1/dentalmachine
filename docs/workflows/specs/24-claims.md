# 24 · Create and send claims

**Budget: 1 action** once the patient's chart (Insurance tab) or checkout is open; **3** from any other screen for
the active patient. Measured: **1** (B) on the Insurance tab, **3** (Ctrl/⌘K, "bill", Enter) from the schedule.
Tested by `e2e/workflows/24-26-27.test.mjs`.
**Ready to approve (24b): 2 actions** from the Billing page (the "Ready to approve" tab, then Approve — or A).
Measured: **2** (tab 1, Approve 1). Tested by `e2e/workflows/24b-claims-approve.test.mjs`.

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

## Ready to approve (24b): prepared by itself, approved by a person
Owner's decision: claims are prepared automatically, but nothing goes to a payer without a person's approval.

**Preparing (background, nothing made or sent).** `GET /claim-queue` works the list out when it's read
(`server/src/claimprep.js`; no job and no stored copy, so it can't go stale or duplicate): completed, unbilled
work (fee > 0, the last 365 days) for patients with an active policy — the policy billing would use, primary
first — grouped by patient, policy and office (claims are billed per office). Work from a visit still checked in
or in the chair waits until the visit ends. Each group gets every check a claim gets before it's sent:
`claimProblems` (routes/edi.js — what clearinghouses reject), the subscriber ID/name, `attachmentHints` (x-rays
and perio charts payers want) and the scrubber (`scrubWork`, the unsaved-work form of `scrubClaim`: payer rules,
filing limits, duplicates, missing tooth/surface, narratives). It shows as:
- **Ready** — clean.
- **Needs a fix** — in plain words, with the fix inline: the chart's x-ray or perio chart of those teeth already
  suggested (**Attach** it — `POST /claim-queue/fixes`), a narrative box, or a link to where the missing detail
  lives (practice NPI → Settings, payer ID → Insurance carriers, subscriber ID → the patient's Insurance tab).
  Missing attachments, narratives and likely denials can be approved anyway with a reason (kept on the audit
  row); what the clearinghouse would reject (NPI, payer ID, date of birth, subscriber ID) can't.
Nothing here writes to the ledger or makes a claim.

**Approving (a person).** Billing → **Ready to approve** (badge = how many are waiting): J/K move, **A** or
Enter approves the selected claim, **S** skips it for now with a reason (Skipped → Put back). Approving makes the
claim (`createClaim`), moves the picked x-rays/narratives onto it and sends them, then sends the claim — through
the clearinghouse, or saved as an 837 file (downloaded, and kept to download again) with no clearinghouse
connection. **Approve all n ready…** shows one line — "Send 12 claims for $2,340.00 to the payers? A sent claim
can't be unsent." — and Enter sends them in one batch. That confirmation is the only one, because sending can't
be undone; the server re-checks the count and total the person confirmed (409 if the list changed).

**Safety.**
- *Idempotent*: each group key (policy, office, procedure ids) is unique in `claim_approvals`, so a double
  click, a retry or two people at once make one claim (a repeat gets the first claim back); `createClaim` still
  refuses work already on a claim (409), and a key whose work changed since the list loaded is refused (409 with
  the group as it is now).
- *A person approves*: approve, approve all and skip go through `requireHuman`; the assistant gets 428.
  `billing:write` to approve, skip or fix; `billing:read` to see the list. Audited as that person:
  `claim_queue.approve` (with the procedures, total and any "approve anyway" reason), `claim.create`,
  `claims.submit` / `claims.export_837`, `claim_queue.skip` (with the reason), `claim_queue.unskip`,
  `claim_queue.attach` / `detach`, `practice.claim_prep`.
- *Never silent*: a claim approved but not sent stays a draft under Claims → Ready to send and becomes a Needs
  attention item (`claim-not-sent:<id>`), resolved when it's sent.
- *Practice and office*: every id is checked against the practice; people limited to some offices see and approve
  only their patients (and the list follows the office they're working in).
- *Setting*: "Prepare claims for approval automatically" (`practices.claim_prep`, on by default — it only
  prepares; administrators switch it at the foot of the tab). There is no automatic sending.
- *Automation pass*: its "completed procedures not on a claim" item links to this tab and doesn't count skipped
  work.

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
- 24b: `server/test/claims-approve.test.js` — groups prepared with no claim, nothing sent and the ledger untouched;
  approve makes and sends exactly once; double/concurrent approve is harmless; approve all with the confirmed
  count/total; needs-fix blocked until fixed (x-ray, narrative) or approved anyway with a reason, hard problems
  never; skip with a reason audited and put back; the assistant gets 428; permissions; practice isolation and
  office restriction; the 837 file without a clearinghouse. `e2e/workflows/24b-claims-approve.test.mjs` — 2
  actions from the Billing page, and J/K + A.
- e2e: Insurance tab B = 1 action, one submitted claim with every finished procedure, a second B makes no second
  claim; command bar = 3 actions; a failing claim stays a draft and a second B sends the same draft (no new claim);
  no dialogs.
- `server/test/efficiency-w3.test.js`: unbilled list, create + send, the same work can't be claimed twice (409),
  a resend is refused (409), a failing claim stays a draft listed as ready to send with its problems, an assistant
  gets 403.
