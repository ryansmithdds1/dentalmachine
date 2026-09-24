# 21 · Build a treatment plan

**Budget: 3 actions per procedure + 1** (a 3-procedure plan in 10). Measured: **2 per procedure + 2**
(N → type "14 D2740" → Enter, per procedure → Ctrl/⌘+Enter). Tested by `e2e/workflows/21-22-23-25-28.test.mjs`.

## Trigger and who does it
After the exam, the dentist (or the assistant as the dentist calls it out) turns the planned work into a plan the
patient can see, price and sign. Several times a day; most visits with findings.

## Data needed
- The patient, the planned work (code, tooth, surfaces or quadrant), the provider, the fee (office fee schedule),
  the plan's name, and work already charted on the odontogram that isn't on a plan yet.

## Today (from the audit)
~5 per procedure + ~3 for the plan (~22 for three procedures). The builder had a dropdown of every code with no
search; "Add to plan" on the chart defaulted to "Not on a plan yet"; fee and discount changes went through
`window.prompt`; deleting a procedure through `confirm()`.

## Target
1. **N** on the Treatment tab opens the builder with the cursor in "Add work".
2. **Type it the way it's called out** — "14 D2740", "30 MO filling", "2-4 sealant", "19 rct", "D4341 UR" — and
   **Enter**. The same parser as "chart by typing" (`chartShorthand.js`); in a plan everything is planned work.
   Codes can also be found by name with the searchable code picker (`CodePicker` from the chart); picking one
   puts the cursor in its tooth/quadrant box.
3. **Ctrl/⌘+Enter** makes the plan. Charted work that isn't on a plan starts ticked.
- **A** (or "Plan all unplanned work (n)") puts every unplanned procedure on a new plan in one action.
- Fees and the plan discount are edited in place (click, type, Enter; Esc cancels) with an Undo toast.
- "Remove" (off the plan) and ✕ (off the chart) happen at once with Undo (Ctrl/⌘Z) instead of confirm boxes.

## What gets automated
- Plans are named "Treatment plan — YYYY-MM-DD" (practice date) unless a name is given (server default).
- CDT code from tooth and surfaces (composite by surface count, RCT by tooth type).
- `POST /patients/:id/treatment-plans {all_unplanned: true}` gathers every planned, unplanned procedure.

## Safety
- Undo goes through normal routes: fee back via `PUT /procedures/:id` (fee overrides still need the permission),
  a removed procedure back via `POST /treatment-plans/:tid/procedures {keep_order: true}` (same place and phase),
  a cancelled one via `POST /procedures/:id/restore`. Moving work on and off a plan is recorded with before/after
  (`recorded()`), and plan creation is audited with how much was added and gathered.
- Completed work can't be taken off a plan; findings typed into the builder are refused ("chart it on the Chart
  tab").

## Edge cases
- Nothing unplanned → "Plan all" answers 409 with a plain reason. A code not in the practice's list is refused
  with its code. Quadrant codes need UR/UL/LL/LR (typed or picked). Adding the same procedure again is a no-op.

## Acceptance
- e2e: a 3-procedure plan within 10 actions, named for today, no dialogs; fee edit and ✕ undone with Ctrl/⌘Z;
  all unplanned work onto a plan in 1 action.
- `server/test/efficiency3.test.js`: default name, all-unplanned (and 409), keep-order undo, audit, other
  practices refused (404), front desk refused (403).
