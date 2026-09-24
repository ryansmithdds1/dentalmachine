# 44 · Clock in/out

**Budget: 1 action each way.** Measured: **1** in, **1** out (I on Time clock). Tested by
`e2e/workflows/32-44-daily.test.mjs` (#44). The time clock itself is [TC-timeclock.md](TC-timeclock.md).

## Measured path
Time clock → **I** (or the big button). From the user menu on any screen: open it, one click on Clock in / Clock
out. The shared tablet: tap your name, type your PIN.

## Before (audit row 44)
In 1; out 3 — the sidebar button asked for break minutes in a `window.prompt`.

## Changed in this batch
- The user menu's clock button clocks out in one click (breaks are punched when they happen with Start break /
  I'm back; on a break, the button ends it) and says what it did in a toast (`components/TimeClock.jsx`).
- A manager removing a punch writes the why in the form instead of a `window.prompt`; the punch stays on record
  as removed.

## Defaults
The signed-in person, now, their shift for today.

## Keyboard path
`I` on Time clock.

## Background automation
A clock-in still open from yesterday (or over 14 hours) becomes a Needs attention item; late / missing people show
on the manager's Today board.
