# 34 · Write prescriptions

**Budget: 3 actions** from the chart's Rx tab. Measured: **2** (the favorite's number key → Enter). Tested by
`e2e/workflows/32-44-daily.test.mjs` (#34).

## Measured path
Chart → Rx tab (or Ctrl/⌘K "rx" for the active patient: *Write a prescription (Rx) — name*). Press **1–9** for a
favorite (the chip shows its number): drug, strength, sig, quantity and refills fill in and the focus moves to
**Send to <pharmacy>** (e-prescribing with a pharmacy on file) or **Save & print**. Enter finishes.

## Before (audit row 34)
4–7 actions (+ the code for controlled drugs). The prescriber defaulted to the first provider on the list.

## Defaults
- Prescriber: the dentist signed in, else the patient's own dentist, else the first dentist — never a hygienist.
- The favorite's whole prescription; the patient's preferred pharmacy.
- After saving, the form clears but keeps the prescriber.

## Keyboard path
`1`–`9` · Enter. Controlled drugs add the 6-digit signing code (EPCS), which the law requires.

## Background automation
The allergy check runs on the server before saving (a warning inline, overridable with a reason by the prescriber);
e-prescriptions are transmitted and their status comes back on the list ("Sent to pharmacy" / "Not sent" with why).

## Safety
Only `clinical:sign` sees the form and the number keys. Every prescription is audited with its prescriber.
