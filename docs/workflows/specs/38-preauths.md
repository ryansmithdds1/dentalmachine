# 38 · Pre-authorizations

**Budget: 2 actions.** Measured: **1** (Pre-authorize on the plan). Tested by `e2e/workflows/32-44-daily.test.mjs`
(#38); the server by `server/test/daily.test.js`.

## Measured path
Chart → Treatment → **Pre-authorize** on the plan: the pre-authorization is made from the plan's planned work and
sent to the clearinghouse as an 837D predetermination, like a claim. The payer's answer is recorded in Billing →
Pre-authorizations (**Record answer**), where drafts also have a one-click **Send**.

## Before (audit row 38)
~7 actions over 2 screens, then downloading the 837 file and uploading it to the clearinghouse by hand.

## Defaults
The primary policy; the plan's planned procedures with their fees and estimate.

## Keyboard path
Tab to Pre-authorize, Enter.

## Background automation
`POST /daily/preauths/:id/send` (`server/src/routes/daily.js`) builds the 837D and submits it through the
clearinghouse adapter. Without a clearinghouse connection the server answers 409 and the file downloads instead
(the old way, now only the fallback). The payer's acknowledgements come back through the clearinghouse mailbox.

## Safety
- `billing:write`, practice-scoped (another practice's id is 404). The **Pre-authorize** button on a treatment plan
  follows the same permission (it used to need clinical:write as well, so only administrators saw it): the billing
  team pre-authorizes; clinical staff present and change the plan.
- Sent once: the status moves to submitted before the file goes (a double click or retry answers "already sent");
  if the clearinghouse can't be reached it's put back, the call is logged in Connection activity, and a
  **Needs attention** item is raised (resolved by the next successful send). The error is 424 so the browser
  shows the reason rather than "offline".
- Audited (`preauth.submit`) with the file name; the status change is recorded before/after.
