# 31 · Enter or scan a new insurance card

**Trigger:** a new patient, or a patient with new insurance, at the desk or through a form/the portal.
**Who:** front desk. **Data:** card front (and back): carrier, member ID, group, subscriber name and date of
birth, payer ID; the patient's chart; the practice's carriers and plans.

**Today (audit):** ~11 actions retyping the card, +4 to scan it from a phone, +2 to verify. A carrier that
isn't set up was a dead end (go to Settings).

**Budget:** 4 actions (photo → read → confirm); measured at 3: **S**, choose the photo, **Enter**.

**Redesign:**
- Insurance tab: **Scan card** (**S**, or the command bar) takes or picks a photo — the front, and the back if
  both are picked. The browser shrinks it; `POST /patients/:id/insurance-card/read` has the AI read it
  (`server/src/routes/insuranceai.js`) and the policy form opens filled in: carrier matched by payer ID or name,
  member ID, group, subscriber, relationship (self when the name matches the patient; otherwise a suggestion),
  the patient's date of birth when it's them. A banner says it was read by AI, why, and what was hard to read.
  Save has focus: **Enter** saves.
- **AI recommends, a person approves:** nothing is saved by the read. The read is audited with source `ai` and a
  plain reason; saving calls `/insurance-card/confirm`, which records the person as approver and which fields
  they corrected.
- A **missing carrier** is offered as "+ New: <name>" (with its payer ID) in the form and added on save.
- After saving: the photos are filed in Documents (when the person may), and the new policy is checked with the
  payer straight away (#20) — the +2 verify steps are gone.
- **Portal-submitted insurance:** **Apply** enters it in one click (`POST /insurance-updates/:id/apply`): carrier
  matched or added, policy created, update marked done, then checked. If they already have primary insurance
  the button becomes "Replace <carrier> with this" (old policy kept, inactive). Without a typed member ID it reads
  the card photos instead.
- **Sandbox:** without an AI key on a sandbox server (EDI_MODE=sandbox or CARD_READER=sandbox), a deterministic
  reader makes up the same card for the same picture — labelled as made up, never read from the image.

**Edge cases:** blurry card → the AI lists unclear fields, and a card it can't read at all is a clear error;
PDFs work; the assistant can't apply portal insurance without a person (428); a double click on Apply
enters it once (409 the second time); a person without billing:write can't add carriers inline.

**Acceptance:** `e2e/workflows/20-30-31-insurance.test.mjs` — scan → save in ≤ 4 actions, policy saved with the
read member ID and the chart's DOB, checked with the payer, photo filed. `server/test/intakeinsurance.test.js`
(#31: sandbox read, carrier matching, AI + approver audit rows with corrections, validation, permissions,
other-practice 404; portal apply: new carrier, once only, replace only when asked, 428 for the assistant).
