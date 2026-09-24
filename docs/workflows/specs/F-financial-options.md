# F · Treatment plans with financial options (backlog F1–F5)

**Budgets:** present 2 staff actions (as #22) · patient picks a way to pay **and** signs in **≤ 4** (type name → tap
an option → tick → Accept & sign) · desk records a choice in **3** (`F` → Enter → Accept for <name>) · name a phase
in **3** (click the name → type → Enter) · drag work to another phase in **1** drag (Undo with Ctrl/⌘Z).
Tested by `e2e/workflows/F-financial-options.test.mjs`; money by `server/test/finoptions.test.js`.
Signing without choosing a way to pay still takes 3 (#22 unchanged).

## Trigger and who does it
The dentist or treatment coordinator builds the plan (workflow 21), presents it chairside / on the iPad / by link,
and the patient chooses what to do now and how to pay. The front desk can record the choice from the desk.

## F1 · Build and organise
- Phases are `procedures.phase` (1–9) plus `treatment_plan_phases` for the name, a plain-words "why", visits,
  planned date (`when_date`) and an optional x-ray/photo from the chart.
- Drag a row onto another row or phase heading (HTML5 drag and drop), or use ↑/↓ and the phase menu from the
  keyboard. Rename a phase by clicking its name. ⌃/⌄ move a whole phase earlier/later (`PUT …/phase-order`).
  "+ Phase" adds an empty phase to drag into.
- Each phase heading shows fee, in-network write-off, insurance, patient share and visits, from
  `GET /treatment-plans/:tid/quote`. Phases whose date falls in a later benefit year are estimated against that
  year's maximum (each year estimated on its own, `estimateCoverage(…, { asOf })`); a chip shows the year and a
  line under the table shows insurance and the maximum left per benefit year.
- Alternatives (Option A/B, `option_group`) are shown side by side above the plan.

## F2 · Present
The patient page (`/tp/:token`, `CaseAcceptance.jsx`) shows: a small tooth map with the teeth highlighted, the
estimated cost in large type, "Your in-network savings" when a PPO fee schedule applies, the options side by side
(tapping one re-prices it), a card per phase (what in plain words, why, visits, you pay, optional picture from
`GET /api/public/tp/:token/phase-image/:n`), with details (codes, fees, insurance) only on tap, and a toggle to
leave a phase for later (the options re-price for the chosen phases).

## F3 · Ways to pay (all math in `server/src/finoptions.js`, integer cents)
| Option | How it's computed |
|---|---|
| Pay in full | Patient share − prepay % (office setting), only if allowed (everyone / self-pay only / no one), above the minimum, never past the maximum total discount together with the plan's own discount, optionally capped in $. |
| Monthly with us | Down payment = max(min %, min $); the rest (+ set-up fee) amortized at the office APR (usually 0%) over each offered length. |
| Lenders | Per configured term: deferred interest ("no interest if paid in full in N months" — monthly that pays it off in time, with the standard-APR warning) or fixed equal payments at the promo APR. Shown only with an application link. |
| Membership | Patients without insurance and not members: the plan's included services and discount on this treatment + a year of membership; shown only when it saves money overall. |
| PPO savings | Office fee − PPO allowed (the contractual write-off), shown when > 0. |

Rounding: a regular payment rounds **up** to the cent (0%) or is the standard annuity payment rounded half-up;
monthly interest is balance × APR/12 rounded half-up; the **last payment absorbs the remainder** so the payments
always add up exactly. Percentages are in basis points, half-up.

## F4 · Accept
- Patient: `POST /api/public/tp/:token` with `choice { option_key, quote_hash, phases, plan_id }` signs the plan and
  records the choice in one transaction. Desk: `POST /treatment-plans/:tid/fin-accept` (billing:write).
- The server re-computes the quote; if its fingerprint differs from what was shown → 409 "the numbers have changed",
  nothing is signed or created.
- One live agreement per plan (`fin_agreements.live_key`); the same choice again returns the same agreement (200);
  a different one → 409 until the first is cancelled.
- What it creates: in-office → `payment_plans` row with the exact dated schedule (and, only with interest or a
  set-up fee, a "Payment plan finance charge" adjustment); lender → `financing_applications` row with the apply
  link (link out; no lender API); pay in full with a discount → a **pending** discount only. A task for the team to
  book the first phase and send the consent (membership: to enroll). The desk shows **Book first visit** (the
  usual booking form with the phase's work) and **Send consent** (consents for the plan's procedures).
- Prepayment: `POST /fin-agreements/:id/prepay {method}` posts the payment **and** the "Prepayment discount"
  adjustment together, once (claimed atomically). Reverse: `POST …/reverse-discount {reason}` (deposits:manage or
  admin) posts a reversing entry. Cancel: `POST …/cancel {reason}` (needs a posted discount reversed first; reverses
  a finance charge; closes an unused payment plan and an unanswered application; tells staff what's left).

## F5 · Settings and the record
`GET/PUT /fin-options/settings` (`practices.fin_options`; saving: administrator only; audited before/after):
options shown, maximum total discount %, maximum APR, prepay %, who gets it, minimum and cap, months offered,
longest plan, APR, set-up fee, minimum down payment (% and $), first payment delay, lender terms table. The server
refuses anything outside the guardrails. Each agreement stores an **immutable snapshot** (phases and lines, the
estimate with policy, fee schedule and estimate version, every option shown, the chosen one, the settings and
their hash, the quote fingerprint) and its SHA-256; `GET /fin-agreements/:id` reports `intact`, and
`GET /fin-agreements/:id/pdf` prints it from the snapshot only.

## Safety
Money routes call `requireHuman()`; the assistant gets 428 without on-screen approval. HIGH_RISK entries to add in
`server/src/aiguard.js`: `POST /treatment-plans/:id/fin-accept`, `POST /fin-agreements/:id/(prepay|reverse-discount|cancel)`,
`PUT /fin-options/settings`. Every id is checked against the practice; audit actions `fin_agreement.accept|prepay|
reverse_discount|cancel|print`, `fin_options.settings`, `treatment_plan.phase|phase_order`.

## F6 · Compare 2–3 options for one problem, on the patient's screen
**Budget:** staff 1 action (**Show patient**); patient taps an option, then signs as usual (choose + name + tick +
Accept). Tested by the F6 case in `e2e/workflows/F-financial-options.test.mjs` and `server/test/treatmentoptions.test.js`.
- **One call makes the options** (used by the voice/typed entry engine, `routes/treatmentoptions.js`):
  `POST /patients/:id/treatment-options` (clinical:write)
  `{ name?: "Tooth #19", key?: "<caller's idempotency key>", options: [{ label?: "Option 1", name?, items: [{ code: "D7140", tooth: "19", surfaces?, area? }] }] }`
  2–3 options, 1–20 items each; every code must be an active office code, teeth/surfaces/quadrants validated.
  → `201 { group, replay: false, plans: [{ id, label, name }], compare }`; the same `key` (or, without one, the same
  options the same day) → `200 { …, replay: true }` with the plans already made. Each option is an ordinary
  treatment plan in one `option_group`. Audited `treatment_plan.options_create`.
- **Compare:** `GET /treatment-plans/:tid/compare` (staff) and `GET /api/public/tp/:token/compare` (patient; no
  internal flags). Per option: work in plain words, teeth, visits, chair time, fee, insurance, patient cost,
  lowest monthly, **likely next steps with their future cost** (after an extraction both an implant and a bridge),
  longevity, pros and cons.
- **The office's wording:** `procedure_insights` per code or prefix; starter text built in (marked "Starter wording
  — review it" on the staff screen only) until an administrator saves their own: `GET /procedure-insights`,
  `PUT /procedure-insights/:code { next_steps: [{label, codes}], longevity, pros: [], cons: [] }` (audited).
- **Second screen on the same computer:** **Show patient** opens a patient window (`/tp/:token?compare=<plan id>`,
  with the one-time in-office hand-off, so no birth date). Where the browser has the Window Management API
  (`getScreenDetails`) it is moved to fill the other screen; otherwise a hint says drag it there and press F11 (the
  window also has a **Full screen** button). The two windows talk over a `BroadcastChannel` (same machine only):
  **Point to Option N** highlights it on the patient's window; the patient's tap and signature show on the staff
  screen. In compare mode the patient must choose an option before **Accept & sign**; signing another option of
  the group moves the link to that plan.
