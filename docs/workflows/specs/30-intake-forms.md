# 30 · Collect and import online intake forms

**Trigger:** a patient submits forms before a visit (health history, practice forms with card photos) or sends new
insurance from the portal. Sending is already automatic (`runFormSends`).
**Who:** clinical staff for health histories; front desk / billing for insurance. **Data:** `patient_forms`
(medical history, `review_status = 'pending'`), `insurance_updates` (pending), `documents` with category
`insurance_card` that a patient sent (no `uploaded_by`).

**Today (audit):** 2 actions per review once found — but pending reviews were only per-chart banners and a
huddle flag, and card photos were filed as documents with no prompt to enter the policy.

**Budget:** 1 action per item from the worklist (**A**), plus J/K to move.

**Redesign:** one worklist across patients, oldest first — `components/IntakeReview.jsx` over
`GET /intake/pending` (`server/src/routes/intakereview.js`, scoped to the practice and the person's offices via
`patientScope`, and to what they may see: histories need clinical:read, insurance billing:read).
- **Health history:** shows the suggested merge (what's on the chart plus what's new — "none" never erases an
  allergy). **A** accepts it through the usual review route (`POST /patient-forms/:id/review`, clinical:write).
- **New insurance from the portal:** **A** enters it (`POST /insurance-updates/:id/apply`, #31): carrier matched
  or added, policy created, update marked done. When they already have primary insurance the row says it will be
  replaced (the old one is kept, inactive).
- **Card photos from a form:** **A** opens the Insurance tab and reads the photos into the policy form (#31).
  **X** sets them aside ("nothing to enter", audited as `intake.card_done`). Photos drop off by themselves once a
  policy is entered or changed for that patient.
- **J/K** move, **Enter** opens the chart.

**Automated:** the list builds itself; nothing to file or search for.

**Edge cases:** several pending histories → only the newest is listed (reviewing it supersedes older ones);
front and back photos are one item; an unreadable history still appears ("open the chart to review it");
a portal update without a member ID is read from its photos instead.

**Acceptance:** `server/test/intakeinsurance.test.js` (#30: all three kinds listed, other practice sees nothing and
gets 404, an assistant sees only histories and can't set cards aside, accepted items leave the list).
The e2e budget test is written but skipped until the route is mounted and the list is placed on a page.
