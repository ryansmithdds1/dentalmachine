# 18 · Estimate the patient's portion

**Trigger:** "What would this cost me?" while charting or presenting work. **Who:** anyone with billing:read
(dentists, hygienists, front desk, billing). **Data:** codes, teeth, surfaces, the patient's fee schedule and
primary insurance (coverage %, deductible, maximums, frequencies, downgrades).

**Today (audit):** 3+ actions and a treatment plan required; `POST /patients/:id/estimate` existed but nothing
called it.

**Budget:** 2 actions (a digit starts the chart entry, type the rest: "14 D2740").
**Front desk and billing (can't chart):** the same box is an estimate only — **Alt+E** from any screen (the patient
bar's "Estimate") opens the chart with the cursor in it, "14 D2740" shows the fee and the insurance and patient
shares, and Enter charts nothing ("Estimate only"). 2 actions, `e2e/workflows/18b-estimate-frontdesk.test.mjs`;
the server already allowed the preview (`POST /charting/resolve`, clinical:read) and still refuses charting.

**Redesign:**
- **`POST /patients/:id/estimate`** (`insurance.js`) now also takes `items: [{ code, tooth, surfaces }]` for work
  not charted yet, priced as charting would price it (the patient's, else the office's fee schedule), and uses the
  patient's primary policy unless `patient_insurance_id` is given (`null` = no insurance). Read-only: nothing is
  charted, charged or stored. Every code, tooth and surface is validated; up to 50 lines.
- **Chart-by-typing preview** (`ChartEntry.jsx`): beside the preview chips, "Est. patient $X · Delta $Y" appears
  (debounced 300 ms) for any procedure typed; the tooltip has the fee, write-off and plan notes (frequency,
  waiting period, downgrade). Enter still charts; Escape clears.

**Automated:** fee, coverage, deductible, maximum and frequency rules.

**Edge cases:** no insurance → the full fee; unknown code, impossible tooth or surfaces → 400 (the preview just
hides the estimate and charting reports the problem on Enter); no billing access → no estimate shown (403 on the
server); another practice's patient, policy or procedures → 404; conditions ("30 MO caries") aren't priced.

**Acceptance:** `e2e/workflows/11-12-16-17-18-money.test.mjs` — typing "14 D2740" shows the server's patient
portion in 2 actions and charts nothing. `server/test/moneyflows.test.js` — priced with the primary policy,
read-only, no-insurance option, validation, other-practice 404, permissions.
