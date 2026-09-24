# S5 — Production on the schedule

**Trigger:** all day. "Are we on track today?", "what does Dr. Chen have booked?", "how much hygiene is left to fill?"
**Who:** anyone who can see the schedule (`schedule:read`). The money needs `billing:read` (front desk, billing,
dentists, hygienists, admins); without it the schedule shows visit counts and blocks, never amounts.
**Data:** `GET /schedule/production?date=YYYY-MM-DD[&days=1-14][&kind=all|doctor|hygiene][&location_id=]`
(`server/src/routes/production.js`), calculated once in `server/src/production.js`. The person's choice of
Doctor / Hygiene / All is remembered on the server (`user_prefs` key `schedule.production_kind`).

## Definitions (one calculation, pinned by `server/test/production.test.js`)
- **Scheduled** — the fees of the procedures (not cancelled) on the day's visits that aren't cancelled or missed.
  The same number as each card's `$` and the huddle.
- **Completed** — the live ledger charges (`type = 'charge'`, not voided, not a reversal) posted for procedures on
  that day's visits. The ledger is the source of truth: a voided charge and its reversing entry both drop out, and
  a cancelled visit's work goes back to "still to book".
- **Goal** — per provider: their perfect-day template's goal for that date (the template's day goal, else its
  blocks' goals added up — see S2), else their own daily goal on a day they work (hours, time off). A kind
  (doctor / hygiene) where no provider has a goal uses the practice's: `daily_goal` for everyone, of which
  `hygiene_goal` is hygiene's part. Closed days have no goal.
- **Doctor / Hygiene** — a visit counts for its provider's type: hygienists are hygiene; dentists and specialists
  are doctor.
- **Still to book** — planned procedures on no visit, for active patients (the huddle's "unscheduled treatment").
- Office: with an office picked (sidebar), only visits at that office; people limited to some offices only ever
  see their offices' visits, and asking for another office is refused.

## Target: everything visible with no action; one key to switch
| Step | Keys | Actions |
|---|---|---|
| See the day's scheduled, completed, goal and % of goal | — (always at the top) | 0 |
| See each chair's / provider's numbers | — (column headings) | 0 |
| Breakdown (by provider, kind of work, blocks, still to book) | hover, or Tab to the number | 0 (1 by keyboard) |
| Doctor / Hygiene / All | `$` (cycles) | 1 |
| Each day's total for the week | W | 1 |

`$` is registered with a label, so it shows in the `?` list ("Schedule views"); the command bar offers
"Schedule: production for doctors / hygiene / everyone".

## What's on screen
- **The production bar** under the toolbar: Scheduled (large), Completed (green), Goal, % of goal with a slim
  meter (completed solid over scheduled tint; green once the goal is met, with a mark where the goal sits), what's
  left to go, the "$ to book" pill and the Doctor / Hygiene / All switch. With one provider picked (V) it shows
  that provider's numbers and goal. Week view adds up the week.
- **Column headings**: scheduled, completed so far (✓), % of goal (or visit count) and a hairline meter. Chairs
  follow the provider picked; a provider of the other kind shows just their visit count while Doctor or Hygiene is on.
- **Week view**: every day's heading shows that day's total and % of goal.
- **Breakdown** (hover or keyboard focus; tap on a tablet): totals, by provider (with each one's goal), by kind of
  work, the day's blocks with booked vs goal, and the treatment still to book.
- Works in dark mode (theme tokens) and wraps on tablet widths.

## What's automated
- Numbers refresh whenever the schedule's own data changes: booking, moving, completing (charges posted),
  cancelling — here or live from another workstation (the schedule's live events), a moment later so a burst is
  one request. Results are kept per day/kind/office so switching back is instant.
- If the production request fails the schedule simply shows what it always did (visit counts and the old total).

## Edge cases
- Money hidden (no `billing:read`): the server returns `null` for every amount; the bar isn't shown.
- A completed procedure whose charge was voided counts as scheduled (it's still on the visit) but not completed.
- The old per-provider summary (`GET /schedule/production?from&to`, schedule.js) still answers when no `date` is
  given; mount the new route before `scheduleRoutes` so `?date=` requests reach it.

## Acceptance
- `server/test/production.test.js`: money correctness (cancelled visits, voided charges, breakdowns), goals and
  the Doctor / Hygiene split, money hidden without billing access, office scoping.
- `e2e/workflows/S5-S2-production.test.mjs`: the bar with no action, `$` = 1 action (remembered after reload),
  breakdown on hover = 0 actions, live update from another screen, W shows each day's total.
