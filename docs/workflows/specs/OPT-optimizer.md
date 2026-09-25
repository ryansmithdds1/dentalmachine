# OPT1–OPT4 · Today's schedule optimizer

**Budget: from the huddle or the schedule, see the plan in 1 action (Shift+O) and do the top move in 1 more (Enter).**
Plain O is the patient flow's "Out" on the schedule (03-appointment-status.md), so the plan is Shift+O everywhere (it was O until
phase 2 batch 1A: the plan's listener swallowed O and a focused visit stayed in the chair — scorecard bug 1).
J / K (or ↓ ↑) move between cards, Enter does the card's action, D is "not today", Esc closes. Every action shows
at once with an Undo toast (Ctrl/⌘Z); texts and reminders can't be unsent, so they have no undo.

## Trigger and who does it
The morning huddle (office manager, front desk, doctor, hygienists): "what has to happen today for each of us to hit
goal?" During the day, the front desk whenever the schedule changes (a cancellation, a no-show, a visit running
short): the plan re-works itself live. The owner reads the plan in the morning huddle email.

## Data needed
Each provider's goal and scheduled production for the day (the same numbers as the schedule's production bar,
`production.js`), their hours (and time off), the day's visits (all offices: a provider or patient booked elsewhere
is busy), blockouts, reserved blocks and perfect-day blocks not yet released, chairs (default provider, hygiene
chairs), visit types (usual length per provider), procedure codes (time units), planned treatment (not on a live
visit, plan not rejected), the opportunity finder's items for each visit, households (`guarantor_id`), recalls due,
future visits, the ASAP list, the waitlist (days, mornings/afternoons, length, provider), no-show and cancellation
history (two years), insurance (the estimate everywhere else uses: fee less PPO write-off, frequency and waiting
periods).

## Target
- **Engine** (`server/src/optimizer.js`, pure where it matters):
  - **OPT1 goal gap** per provider: goal, scheduled, gap, %, open minutes (hours less visits and blocks, from now),
    perfect-day blocks still open.
  - **OPT2 opportunities**, each `{ key, kind, patient (first name + last initial), provider, slot/visit, fee
    (office fee), collectible (fee less write-off), minutes, fits / why_not, action, alt_actions }`:
    `treatment` (planned treatment of today's patients: in their visit when the visit has the time — its length less
    the minutes of its work, 5 minutes' tolerance — else by stretching it into the open time after it, else a visit of
    its own right after or before with the right kind of provider, same chair when free); `finder` (the opportunity
    finder's items: sealants, fluoride, x-rays, perio…, not those insurance won't cover yet); `family` (household
    members due for recall or with open treatment: back to back with the family member already booked, same chair,
    or at the same time with another provider); `fill` (ASAP-list, waitlist and recall-due patients who fit an open
    gap by length, provider, visit type and their day/time preferences — one suggestion per patient, their best gap);
    `shorten` (visits booked at least 10 minutes longer than their type's usual length when the work attached doesn't
    need the time; only before they start; with the best fill for the freed time); `confirm` (unconfirmed visits with
    no-show risk: missed visits ×2 + cancellations + a first visit ≥ 3 is high, 2 medium; confirmed visits never).
  - **OPT3 plan**: moves that reach each provider's goal — exactly (most providers at goal, then fewest moves, then
    most collected) when there are ≤ 14 candidates, else greedily by fee with conflict checks. Conflicts: provider,
    chair or patient time overlapping; a visit's spare minutes spent twice; the same planned procedure, the same
    patient booked twice, or two changes to one visit's end. "3 moves get Dr. Chen to 104% of goal".
- **Routes** (`server/src/routes/optimizer.js`): `GET /optimizer/today?date&location_id&explain=1`,
  `POST /optimizer/:id/act { alt }`, `/undo`, `/decline { reason }`, `/restore`, `GET /optimizer/captured`,
  `GET/PUT /optimizer/settings`.
- **Tracking** (`optimizer_suggestions`): one row per practice, day and opportunity: shown → accepted (a text waiting
  on the reply) → done, or declined / failed / undone; fee and collectible; who acted and whether a person or the
  assistant. $ captured per day and per person.
- **Client** (`client/src/components/optimizer/`): `OptimizerPanel` (the side panel, and `OptimizerLauncher` — the
  schedule's Plan button with Shift+O), `HuddlePlanCard` (the huddle), `OptimizerMarkers` (open time and pills on
  the grid; a click opens the panel on that card), `useOptimizer` (one shared copy per day and office, re-fetched on
  the shared live event).
- **AI note** (`server/src/ai/optimizerExplain.js`): optional, off until an administrator turns it on
  (`practices.optimizer_ai`) and AI is on for the server; ranks and explains only what the engine found, labelled
  "Written by AI". `OPTIMIZER_AI=sandbox` for demos and tests, `off` to never.
- **Huddle email**: the plan's headline and each provider's moves (first name and last initial) — `huddlePlan()`.

## What gets automated
Everything is worked out when the plan is looked at (nothing to run); the plan re-works itself whenever the schedule
changes (the client re-fetches on the live `schedule` / `optimizer` events). A text offer to an ASAP or waitlist
patient is the cancellation fill's text: their YES books it through `fill.js` (an ASAP patient's visit moves up),
and the suggestion becomes done by itself. What's done, declined or waiting stays out of the plan.

## Safety
- Nothing is booked, moved, added or texted without a person's click. Each action is re-checked against the
  schedule as it is now (a 409 with the reason if it no longer fits), then done through the app's own endpoints as
  the signed-in person — `POST /appointments`, `PUT /appointments/:id`, `PUT /procedures/:id`,
  `POST /appointments/:id/opportunities/:rule/add`, `POST /appointments/:id/remind` — so the same validation
  (`validateAppt`: hours, visits, chair, patient, blockouts, reserved and perfect-day blocks), permissions (e.g.
  `clinical:write` to add a procedure), office limits, audit trail and live updates apply. Every placement shown is
  also checked by `validateAppt` before it's offered: it never double-books.
- Once: the tracking row is claimed before the work starts; a double click or retry answers with the first result.
- Planned work only: adding treatment never posts a charge (completing it still goes through the usual path).
- Undo goes back through the same endpoints (a booked visit is cancelled with reason "office", never deleted).
- Audited: `optimizer.act`, `optimizer.undo`, `optimizer.decline` (with the reason), `optimizer.restore`,
  `optimizer.settings`, each with the patient; the underlying changes carry their own before/after.
- The assistant can't act without the person's yes on screen: `POST /optimizer/:id/(act|undo)` is in `HIGH_RISK`
  (428 without `X-Human-Approved`); its requests are forwarded to the inner calls with the same headers.
- Practice- and office-scoped; `schedule:read` to see, `schedule:write` to act (plus `patients:write` to text);
  $ only with `billing:read` (as on the schedule). The AI sees only first name + last initial and the engine's
  numbers; its answer keeps only the engine's keys.
- A failed AI note is a Needs attention item (resolved by the next one that works).

## Acceptance
`server/test/optimizer.test.js`: each generator — fits / doesn't fit by hours, visits, blocks, kept perfect-day
blocks, chairs, the patient, the provider, waitlist preferences; $ math (fee vs collectible); family detection;
the shorten rule not triggered when the work justifies the length; no-show risk; the plan reaches goal with the
fewest moves and never double-books (exact and greedy); the database's own check refuses what the rows didn't know;
actions idempotent (two at once), undo, decline, text offer and its YES; $ hidden without billing access;
permissions; practice and office isolation; the AI note (off by default, admin-only switch, sandbox, no PHI beyond
first name + last initial); the assistant needs approval (once the HIGH_RISK line is in). Postgres too.
`e2e/workflows/OPT-optimizer.test.mjs`: Shift+O then Enter from the huddle does the top move (≤ 2 actions); J/K, D, Esc;
the schedule's Plan button and gap markers.
