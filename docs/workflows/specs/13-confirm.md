# 13 — Confirm appointments

**Trigger:** before a day's visits (usually the day before), or when the schedule shows "N unconfirmed".
**Who:** front desk — `schedule:write` to confirm or text; `schedule:read` to see the list.
**Data:** `GET /followups/unconfirmed` (new `?date=` for one day), new `POST /followups/unconfirmed/confirm`
(one or many, with `undo`), `POST /appointments/:id/remind` (existing, per visit), `appointments.status`,
`confirmed_at`, `confirmed_via`.

## Today (audit row 13)
2 per visit from the drawer. The schedule's "N unconfirmed" wasn't a link; no bulk confirm and no "remind
everyone who hasn't confirmed". Most confirmations already happen automatically (reminder texts and replies).

## Target: 1 action per row
| Step | Keys / clicks | Actions (measured) |
|---|---|---|
| Open the day's unconfirmed list from the schedule | click "N unconfirmed" (or the command bar: "Schedule: unconfirmed visits") | **1** |
| Confirm the row the keyboard is on (by phone) | C | **1** per row |
| Move between rows | J / K | 1 |
| Select rows, confirm them all | X on each, Shift+C (or "Confirm N selected") | 2 per row + 1 |
| Text a reminder to everyone unconfirmed (or the selection) | one click | **1** |

## What's automated / how it's safe
- **Undo instead of "Are you sure?"**: C / Confirmed hides the row at once and the toast offers Undo
  (Ctrl/⌘+Z). Undo goes through the same route with `undo: true`, putting the visit back to unconfirmed (and
  "Left a message" where the list showed it). Both steps are in the visit's history and the audit log
  (`appointment.status`, with `bulk: n` for several).
- **Idempotent**: only visits still waiting for a confirmation change; others come back as `skipped`, so a double
  click or a retry changes nothing twice.
- **Text all**: one reminder per visit through the existing reminder route (confirm link included). Visits with
  no phone or email, or reminded in the last 15 minutes, are skipped; the result says who got one, who didn't and
  why. A failed text also becomes a Needs attention item (`sendMessage` → `raiseIssue`).
- `?date=` narrows the list to the day the schedule showed (the week view links to the next 7 days).
- The list now respects office access (people limited to some offices see their offices' visits).

## Edge cases
- A patient confirms by text while the list is open: the row is skipped (already confirmed) and disappears on
  the next load.
- A visit that moved or was cancelled since loading: skipped, never changed.
- Another practice's ids: 404, nothing changes. Up to 200 visits per request.

## Acceptance
- `server/test/booking.test.js`: `?date` narrows; bulk confirm sets status, time and method, audited with the user
  and `bulk`; a second call is a no-op; undo restores "left a message"; 400 for bad input, 404 for another
  practice, 403 without `schedule:write`.
- `e2e/workflows/09-10-13-19-schedule.test.mjs` (#13): pill = 1 click to the day's list; text all = 1 click
  ("Reminder sent to 3"); C = 1 key per row; Ctrl+Z restores the last one on the server; X/J/Shift+C confirms the
  rest.
