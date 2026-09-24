# S7 — Late is impossible to miss

**Trigger:** the patient due at 9:00 isn't here at 9:05; the 10:00 is in the waiting room while Op 2 runs over.
**Who:** everyone on the schedule sees it (`schedule:read`); texting needs `patients:write`, no-show and moving
need `schedule:write`. The soft sound is each person's own choice.
**Data:** the schedule's visits (status, `arrived_at`, times) and the practice's `late_minutes` (default 5) and
`very_late_minutes` (default 10), set in Settings → Perfect day → Late patients (`GET/PUT /schedule/late-settings`,
administrators, 1–60 minutes, very late not before late, audited). Per person: `user_prefs` `schedule.late_sound`.
The calculations are pure functions in `client/src/components/calendar/late.js` (tested in `server/test/late.test.js`).

## Definitions
- **Late** — a scheduled or confirmed visit today, not checked in, `late_minutes` or more after its start; **very
  late** from `very_late_minutes`. It stays late (even past its end) until someone checks them in, moves the visit or
  records a no-show. A past day's un-arrived visit is a no-show to record, not "late".
- **Running behind** (per column: chair or provider) — the worst of: a patient checked in but not seated
  `late_minutes` after their time (or after they arrived, if they came late); a patient still in the chair past the
  visit's end while the next patient in that column is checked in or already due.

## What's on screen (updates every 30 seconds, and live with every change)
- The card: a strong red outline and a "Late 7 min" chip (hours for long waits); very late visits pulse — with
  reduced motion, a thicker outline and a red wash instead of the animation.
- At the top: "3 patients late" with each one's wait, time and chair, and one-click **Text** ("are you on your
  way?", through the normal patient messaging, once per visit on this screen), **Call** (`tel:`), **No-show** (opens
  the reason picker, then rebook), **Move** (arrow keys and Enter, or tap a new time); "Show all" past three.
- The column heading: "Running 12 min behind", with the reason on hover.
- The current time: a bolder line with a time bubble in every column; on today the grid keeps it in view (unless
  someone scrolled in the last two minutes).
- Optional soft chime (made in the browser, no sound file) when someone newly becomes late — not for those already
  late when the screen opened.

## Budget
| Step | Actions |
|---|---|
| See who's late, by how much | 0 |
| Text a late patient "are you on your way?" | 1 |
| Call them | 1 |
| Mark a no-show with its reason | 2 (No-show, a number) |
| See a chair running behind | 0 |

## Acceptance
- `server/test/late.test.js`: late / very late thresholds and edges, the list order, running behind (waiting to be
  seated, over time with the next patient waiting, other days), settings validation, audit, permissions, isolation.
- `e2e/workflows/S5-S2-production.test.mjs` (S7): outline and "Late N min" on the card, text from the list in one
  click (message sent), very late after changing the practice's numbers, "Running N min behind" on the chair, the
  now-line bubble.
