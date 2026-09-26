# 22 · Present treatment and get it accepted

**Budget: 1 staff + 2 patient actions.** Measured: 1 staff (**Present here for <name> to sign** on the plan, or P on
the Treatment tab — no dialog in between) and 2 patient
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
1. **Present here for <name> to sign** on the plan card (or **P** on the Treatment tab for the newest unsigned plan).
   Phase 2 (batch 2A): the Present dialog is gone — there was nothing to choose in it; **Send to sign at home** is
   its own button beside it and says on the tab how it was sent.
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
- e2e: 1 staff action, no new tab, code gone from the URL; 2 patient actions (name prefilled); back link lands on the Treatment
  tab showing "Signed by"; a second redeem of the same code is refused.
- `server/test/efficiency3.test.js`: single use, other session/practice/anonymous refused, expired refused, pass
  bound to its plan, text/email links get no pass, audit rows with who handed over, front desk can't present (403).

## On a computer screen, and printed (TP)
The plan page is laid out for a monitor across the desk, not a narrow print column: the patient's mouth with the
plan drawn on it on the left (`PlanChart.jsx`, the chart's own tooth drawings — crowns, root canals, implants,
bridges, filled surfaces, ✕ for a tooth coming out; each phase its own colour, work already in the mouth green; it
stays in view while scrolling), the estimate (fees − in-network savings − insurance = your portion) and each phase
with its procedures (a small tooth beside each) on the right; ways to pay and "Accept your plan" underneath. One
column below 900px (tablet portrait, phone). Pointing at (or tabbing to) a tooth lights up its procedures and vice
versa. **Print** (top right) prints a compact letter-size document — the drawing, every procedure by phase with fee,
insurance estimate and your share, totals, a signature line — from a print stylesheet; **Download PDF** is the
office's PDF. Patient pages stay light (theme.js), whatever the computer's setting.

## Where the plan stands, and the office's notes (TP)
`server/src/planprogress.js`, `routes/plannotes.js`. Status is worked out, never stored: Not presented yet →
Presented → Thinking it over → Accepted (signed or accepted verbally) → Scheduled (its work is on a visit; "1 of 2
booked") → In progress (some done) → Completed (balance $X) → Completed & paid (the plan's done work has nothing open
by the ledger's allocation — allocation.js), or Declined / Expired (not accepted within 365 days). Staff set only the
human states, with a note: "Thinking it over" and Declined (clinical:write) / Reopen. Shown on the plan card (with
"Balance $X" / "Paid in full"), the patient header chip, the printable plan's staff bar (not printed), and
**Follow-up → Plans in process** (by status, latest note, follow-up date; `GET /followups/plans`).

Notes: `POST /treatment-plans/:tid/notes` (patients:write) — a chip (Going home to discuss, Waiting on insurance /
pre-auth, Wants financing options, Will call back, Price concern, Second opinion) and/or text, an optional follow-up
date (makes the plan's follow-up task, or moves it while it's open), optional stage. Kept as unscheduled-treatment
follow-ups (`followups` with `treatment_plan_id`), so the Unscheduled treatment list's last contact shows them.
Append-only (a database trigger refuses edits; "Correct" adds a new note pointing at the old one), audited
(`treatment_plan.note` with the status before/after). Staff-only: no patient page, portal, printout or PDF reads them.

| Who | Step | Actions |
|---|---|---|
| Team | "Going home to discuss" + thinking it over + follow-up in a week | **≤ 3** (open notes, chip, Save — the chip ticks "Thinking it over" and suggests +7 days) |

`e2e/workflows/TP-plan-status.test.mjs` fails over budget; `server/test/plannotes.test.js` covers the status rules,
the ledger, leaks, permissions, isolation and audit.
