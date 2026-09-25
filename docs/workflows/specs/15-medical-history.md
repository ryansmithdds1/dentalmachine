# 15 · Review and update the medical history

**Budget: 2 actions** for "reviewed today, no changes" (it takes 1: **R** on the chart). Changing one line takes
**3** (click the line → type → Ctrl/⌘+Enter), or keyboard only **3**: **A** (allergies) / **Shift+M** (medications) /
**M** (alerts) → type → Ctrl/⌘+Enter. Blood pressure and pulse: **3** (**V** → type "122/78 68" → Enter).
Tested by `e2e/workflows/14-15-images-medical.test.mjs`.

## Trigger and who does it
At check-in or when seating the patient, the assistant or hygienist asks "any changes to your health or
medications?" — at every recall, and whenever the history is out of date. The dentist looks at it before
treatment. A patient may also send an updated history through the intake form.

## Data needed
- The patient's medical alerts, allergies, medications, conditions checklist, ASA class, premedication flag
  and when the history was last reviewed (`medical_reviewed_at`).
- Clinical access: `clinical:read` to see it, `clinical:write` to review or change it.

## Today (from the audit)
"Reviewed today" was 1 click, but updating took 4–6 actions across two dialogs: alerts, allergies and
medications lived in **Edit patient**, conditions, ASA and premed in a separate **Edit health history** dialog.
Staleness was a small grey note; nothing on the chart header said the history was due.

## Target
- **One medical history block** on the chart overview (`client/src/components/patient/MedicalHistory.jsx`)
  shows all of it. **R** / "Reviewed today, no changes" marks it reviewed. **M** / "Update", or a click on any
  line, opens **one inline editor** with every field (alerts, allergies, medications, conditions, ASA,
  premed), focused on the line clicked with the cursor at the end. **Ctrl/⌘+Enter** saves, **Esc** cancels.
  Saving counts as today's review. The save toast offers Undo.
- **Due is obvious:** never reviewed or reviewed more than a year ago (the same year the morning huddle uses)
  puts an amber "Medical history review due / never reviewed" chip in the chart header (click → the history),
  outlines the history block and makes "Reviewed today" the primary button.
- **Edit patient no longer shows** alerts, allergies or medications on an existing chart (a note points to the
  medical history), so demographics edits never overwrite a history someone else just changed. New charts
  still take them.

## What gets automated
- `GET /patients/:id/card` (the active patient bar and hover card) now includes `medical_review_due`
  (clinical access only), so the bar can flag it without another request.
- The intake form flow is unchanged: "Review changes" still opens the comparison (patient reported vs on the
  chart) and saving it marks the history reviewed.

## Server
- `PUT /patients/:id/medical` — new, `clinical:write`: any of `medical_alerts`, `allergies`, `medications`,
  `medical_conditions`, `asa_class`, `premed_required`, validated like the patient record. Only fields that
  really change are written, through `update()` so the audit entry (`patient.medical_update`) carries
  before/after; `medical_reviewed_at` is set too unless `reviewed: false` (used by Undo, audited as
  `patient.medical_revert`). Returns the history, `changed` and `medical_review_due`.
- `POST /patients/:id/medical-reviewed` — now wrapped in `recorded()` (before/after of the review date),
  audited as `patient.medical_reviewed` with `no_changes`, returns the new date. Sending it twice is harmless.
- `PUT /patients/:id` refuses a change to any medical field without `clinical:write` (403); the same values
  sent back unchanged are accepted, so older screens still save demographics.

## Edge cases
- Someone without clinical access sees neither the history nor the due chip; the card leaves the flag out.
- Clearing a field stores nothing (not the word "null"); an empty conditions list equals none.
- Undo restores the old values but keeps today's review date (the history was looked at).
- The editor's R/M keys are off while it's open or a dialog is showing.
- A pending intake submission still shows its "Review changes" notice above the history.

## Acceptance
- A never-reviewed patient shows the header chip; R clears it in 1 action and the card's
  `medical_review_due` turns false (`e2e`).
- Clicking the allergies line, typing and Ctrl/⌘+Enter saves in 3 actions and marks it reviewed; M + Tab +
  type + Ctrl/⌘+Enter works keyboard-only; Ctrl/⌘+Z undoes (`e2e`).
- Server tests: before/after on audit rows for update, review and revert; front desk gets 403; another practice
  gets 404; bad ASA/conditions/premed/too-long text are 400 (`server/test/imagesmedical.test.js`).

## Not done here
- The patient bar showing `medical_review_due` (`PatientBar.jsx` belongs to the shared foundations) and a
  "medical history due" action from the schedule drawer (`calendar/*`).

## Phase 2 batch 1A
- **A** opens the editor on Allergies and **Shift+M** on Medications (the line people change most), so there's no
  Tab from the alerts line: 3 actions from the keyboard (A032).
- **Vitals (A033):** **V** (or "Record vitals") opens one box with the cursor in it; the reading is typed the way
  it's said — "122/78 68", "122/78", or "p 68" — and read back ("BP 122/78 mmHg · pulse 68 bpm") before Enter saves
  it. Anything else is refused on screen before it's sent; the server's range checks are unchanged. Each reading is
  its own record (who, when); a wrong one is corrected by recording again. `e2e/workflows/14-15-images-medical.test.mjs`.
