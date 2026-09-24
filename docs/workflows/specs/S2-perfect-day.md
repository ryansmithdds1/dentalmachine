# S2 — Perfect day / block scheduling

**Trigger:** planning the ideal day ("Dr. Chen Tuesday: 8–10 crowns, 10–12 fillings, 11:00 emergency slot, 2–3 new
patients"), then booking into it all week without thinking about it.
**Who:** administrators set templates up (goals are money targets); anyone who books (`schedule:write`) can plan
one date differently; everyone on the schedule sees the blocks.
**Data:** `day_templates` (provider, name, weekdays, day goal, release hours, office, `active`),
`day_template_blocks` (label, `HH:MM` times, visit types kept for, goal, release override, color, `active`),
`day_template_dates` (one provider's date: another template, none, or back to usual). Routes in
`server/src/routes/daytemplates.js`; the plan and enforcement in `server/src/production.js`.

## How it works
- A template applies by itself on its weekdays (one template per provider per weekday — a clash is refused). A
  date can use another of the provider's templates, none ("staff training"), or go back to the usual ('auto').
- A block with visit types is **kept** for them until its release time (the block's own, else the template's,
  e.g. 24 hours before it starts); after that anything books there. A block with no types is a goal-only lane.
- Booking or moving a visit (not of those types) into a kept block is refused on the server with a clear 409 —
  "08:00–10:00 is Dr. Chen's Crowns time, kept for Crown prep until Mon, Jan 5 at 8:00 AM" — and
  `can_override`, so the booking form shows **Book it anyway** and a drag/keyboard move shows **Move it there**
  inline (Enter = yes, Esc = keep it). Going ahead is audited (`appointment.block_override`, with the block,
  template and a plain reason). Editing a visit already in a block without moving it is never refused.
- Checked everywhere visits are placed through `validateAppt` (single, family and recurring bookings, moves,
  "this and following"); recurring visits that land in a kept block are skipped and reported like any conflict.
- The schedule draws blocks as tinted lanes (block color, a lock while kept, dashed once released) with the
  label and booked vs goal; the breakdown lists them. The day's goal (template goal, else the blocks' goals)
  feeds S5's goal and % live.

## Target
| Step | Keys | Actions |
|---|---|---|
| See today's blocks and booked vs goal | — | 0 |
| Move a visit into a kept block anyway | M, ↑/↓…, Enter, Enter | 3 + the moves |
| Book into a kept block anyway (booking form) | Book it anyway | 1 more than a normal booking |
| Create a template (Settings → Perfect day) | New template, name/blocks, Create | per block: name, times, types, goal |
| Plan one date differently | provider, date, choice, Save | 4 |

## Safety
- Templates, blocks and date changes are configuration: never deleted. Templates are retired (`active = 0`,
  "Use again" brings one back, Undo on the toast); editing blocks retires the old rows and adds new ones;
  a date goes back to normal with mode `auto`. Every change is audited with before/after
  (`day_template.create / update / retire / date`); `reason` is kept when given.
- All ids are checked against the practice (providers, types, offices, templates); times, weekdays, goals and
  release hours are validated; overlapping blocks are refused. Offices: a template for an office is only used in
  that office's view, and people limited to some offices can't place templates elsewhere.

## Not yet (S4)
- "Next available" and the booking suggestions don't yet steer visits into matching blocks (they respect
  one-off reserved blockouts already).

## Acceptance
- `server/test/daytemplates.test.js`: templates (validation, admin only, one per weekday, tenant isolation),
  enforcement on booking and moving, the release time, audited override, per-date changes, retiring and editing
  (old blocks kept), goals feeding production.
- `e2e/workflows/S5-S2-production.test.mjs` (S2): lanes on the schedule with booked vs goal; moving into a kept
  block asks inline and "move it there" is recorded — M ↑ Enter Enter = 4 actions.
