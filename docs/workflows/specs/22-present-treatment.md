# 22 · Present treatment and get it accepted

**Budget: 2 staff + 2 patient actions.** Measured: 2 staff (Present & e-sign → Enter on "Open here") and 2 patient
(tick "I have reviewed" → Accept & sign; their name is already on the signing line when the office hands the device
over — they can correct it, and a link sent home still asks them to type it). Tested by `e2e/workflows/21-22-23-25-28.test.mjs`.

## Trigger and who does it
The dentist or treatment coordinator goes over the plan chairside and hands the tablet (or turns the screen) to
the patient to sign; or sends it home to review.

## Data needed
The plan, its estimate (insurance, patient share, financing), the patient's typed name and optional drawn
signature, and consent to the plan.

## Today (from the audit)
Staff 3 + patient 6: the plan opened in a new browser tab and even on the office tablet the patient had to type
their date of birth before seeing the plan.

## Target
1. **Present & e-sign…** → the dialog's first button, **Open here for <name> to sign**, has focus → **Enter**.
2. The plan opens **in the same tab**, without the birth-date step, with the cursor in the name box.
3. The patient's name is already on the signing line (from the hand-off: `POST /signing-passes/redeem` answers
   `signer_name` to the signed-in device only), so they tick the box and tap **Accept & sign**. "Please hand the device back" shows,
   and **"← Staff: back to the chart"** returns to the Treatment tab (the staff session never left the tab).
- **Text or email** is unchanged: those links still ask for the birth date.

## The in-office signing pass (security)
`server/src/handoff.js`. `POST /treatment-plans/:tid/present {here: true}` (clinical:write) returns the plan link
plus a **one-time hand-off code**, which rides in the link's `#fragment` (browsers never send it to servers; the
page removes it from the address bar at once). The page trades it with `POST /signing-passes/redeem` for the usual
viewing pass. The code:
- is **bound to that plan** (`purpose = handoff:plan:<id>`; the viewing pass is for that plan only),
- is **bound to the signed-in staff session that asked for it** (hash of the session id) and the practice — a
  copied link on another device, another login or another practice gets 410 and falls back to the birth date,
- is **single use** (an atomic `used_at` update) and **expires in 15 minutes**,
- is stored only as a hash, in `oauth_states` (the app's table of one-time, browser-bound values).
Audited: `treatment_plan.handoff` (who handed the device over) and `treatment_plan.handoff_opened` (with
`handed_over_by`). The signature itself is recorded as before (`treatment_plan.patient_signed`, snapshot, PDF
filed in the chart).

## Edge cases
- Pass expired or used (a reload after signing, a second tab) → the birth-date step, as for any link.
- Plan already signed → 409 as before. Nothing about the plan changes when a pass is redeemed.

## Acceptance
- e2e: 2 staff actions, no new tab, code gone from the URL; 2 patient actions (name prefilled); back link lands on the Treatment
  tab showing "Signed by"; a second redeem of the same code is refused.
- `server/test/efficiency3.test.js`: single use, other session/practice/anonymous refused, expired refused, pass
  bound to its plan, text/email links get no pass, audit rows with who handed over, front desk can't present (403).
