# 23 · Sign consent forms

**Budget: 1–2 actions.** Measured: **2** from the plan (Consent… → Enter on "Sign here on this device"); **4** from
any screen through the command bar (Ctrl/⌘K → "consent" → Enter → Enter). Tested by
`e2e/workflows/21-22-23-25-28.test.mjs`.

## Trigger and who does it
Before extractions, root canals, implants and similar work, the assistant or front desk has the patient sign the
consent for that procedure — almost always in the office, on a tablet or the front-desk screen.

## Data needed
The patient, their planned procedures (to pick the right consents: `form_templates.procedure_codes`), the
provider and teeth to fill into the wording, the patient's signature.

## Today (from the audit)
Staff 3 + patient DOB and sign; only from the Treatment tab; opened in a new tab where the patient had to type
their birth date.

## Target
- From a plan: **Consent…** → the matching consents are ticked and **Sign here on this device** has focus →
  **Enter** → the forms open in the same tab with no birth-date step; "back to the chart" at the end.
- From anywhere, for the active patient: the command bar lists **"Consent forms for <patient>"** (registered
  app-wide by `components/QuickCommands.jsx`), which picks the consents for all their planned work.
- Sending by text/email is unchanged (the birth date is asked).

## What gets automated
Consent choice from the procedures; filling in procedures/teeth/provider; the in-office pass (same mechanism as
workflow 22: `POST /patients/:id/form-packets {here: true}` → one-time code bound to the packet, the staff
session and the practice, single use, 15 minutes; audited `form_request.handoff` and
`form_request.handoff_opened`).

## Edge cases
No planned work → the dialog opens with the health history ticked. Pass expired/used → birth-date step.
A packet for another practice's patient → 404.

## Acceptance
- e2e: 2 actions from the plan and 4 from the command bar, ending on the consent form with no date-of-birth box.
- `server/test/efficiency3.test.js`: pass works once, only on the same session, audit rows, sent links get none.
