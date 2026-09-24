# 46 · Denied claim appeals

**Budget: 4 actions** (audit). **Measured: 2 on the claim** (D, Ctrl/⌘+Enter), 3 counting the click that opens the
claim — `e2e/workflows/45-54-monthly.test.mjs` (#46). A denial on an ERA is 1 key (**A**) from the Insurance
autopilot worklist — see [A-eob-autopilot](A-eob-autopilot.md).

## Measured path
On a denied claim (`/claims/:id`) the Appeal card is already open with the payer's reason filled in.
1. **D** drafts the letter — by AI from the chart and the reason, or from a plain template when AI is off
   (`templateAppeal` in `routes/claimai.js`: practice, payer, claim, services, a bracket for the dentist's clinical
   reason). The cursor lands in the letter to finish it.
2. **Ctrl/⌘+Enter** ("Send appeal & print") files it and opens it to print on letterhead.

## What sending does (`POST /claims/:cid/appeal` with `letter`)
- The letter is saved on the chart as a PDF (Documents → Insurance, category `correspondence`).
- The claim's history gets an "Appeal sent" event (reason, follow-up date, who; "drafted by AI, approved by staff").
- The claim's follow-up date is set (default 30 days, `APPEAL_FOLLOW_UP_DAYS`; editable, never in the past), so it
  comes back on the follow-up list (#45) by itself.
- Idempotent: the same letter again returns the first appeal (`already: true`).
- Audited (`claim.appeal`, before/after follow-up date; `approved_by` the signed-in person). The AI only drafts; a
  person sends. Letters under 40 characters or over 20,000 are refused.
