# 20 · Verify insurance eligibility and benefits

**Trigger:** a visit tomorrow (the evening batch), a patient at the desk, or new insurance just entered.
**Who:** front desk / billing. **Data:** the patient's active policies, the payer's 271 (active, plan dates,
maximum and deductible with what's left, percentages, frequency limits and history), the plan on file.

**Today (audit):** 4 actions from the schedule for a real-time check, 9+ with a manual clearinghouse — and the
answer was never applied to the policy until someone pressed "Apply to policy". Nightly checks ran but their
results sat unused.

**Budget:** 1 action for the patient on screen (**E**); 0 for tomorrow's patients (the evening run); 1 per
exception (Keep what's on file / Apply anyway).

**Redesign:**
- Every response that comes back — real-time, sandbox, the evening batch, or a 271 imported by hand — is checked
  on the server (`settle` in `server/src/eligibility.js`). A **clean** one is applied to the policy at once: what
  "Apply to policy" always applied (annual max, deductible, deductible met this benefit year, percentages,
  frequency limits), and the plan is marked verified by eligibility. It is recorded as `integration` (a payer's
  answer) or `automation` (sandbox / the nightly job), with before and after, as `eligibility.auto_apply`.
- Anything else is an **exception** and changes nothing: coverage not active, a payer rejection (AAA, in plain
  words: "the member ID isn't right"), no active/inactive answer, coverage that starts later, or — once the plan
  has been verified — a maximum, deductible or percentage that disagrees with the plan on file. It becomes one
  Needs attention item per policy (`eligibility-review:<policy>`, front desk), and the reasons are kept on the
  check. A later clean check resolves the item by itself.
- Patient Insurance tab: **E** checks the primary policy (also in the command bar); the result says "Applied to the
  policy automatically" or "Needs a look: …" with **Keep what's on file** / **Apply anyway**.
- Billing → Eligibility (tomorrow by default): a **Needs a look** box on top; everything else is one line
  ("12 with insurance · 11 applied automatically"). **C** checks everyone.

**Edge cases:** manual mode still downloads the 270 and imports the 271 (then settles like the rest); a
patient with two visits that day is checked once; the same problem again counts up on the open item; "Apply
anyway" and "Keep" both close the item and are audited (Keep takes an optional reason).

**Acceptance:** `server/test/intakeinsurance.test.js` (#20 tests: clean → applied + audited as automation with no
issue; inactive / AAA → issue, nothing changed, resolved by a later clean check; mismatch against a verified plan;
permissions and other-practice 404; batch counts). `e2e/workflows/20-30-31-insurance.test.mjs`: **E** = 1 action,
an exception in the day's list = 1 action.
