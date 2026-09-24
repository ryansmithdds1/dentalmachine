# 03 — Appointment status: arrived → seated → ready → out

**Trigger:** the patient walks in, is taken back, is ready for the doctor's exam or for checkout, and leaves.
**Who:** front desk (check in, out), assistants and hygienists (seat, ready) — `schedule:write`.
**Data:** the appointment (`status`, `arrived_at`, `seated_at`, `dismissed_at`, new `ready_at` / `ready_for`),
`PATCH /appointments/:id/status`, new `PUT /appointments/:id/ready`.

## Today (audit row 3)
Every step opened the drawer and clicked a button: 2 clicks per step, ~6–8 per visit. No keys. No "Ready" —
only a "Text we're ready" button for patients waiting in the car.

## Target: 1 action per step, keyboard only
With a visit focused on the grid (click it, Tab to it, or **F** = jump to the visit happening now, then
↑ ↓ ← → between visits) or open in the drawer:

| Step | Key | One click |
|---|---|---|
| Check in | I | next-step button on the card / drawer header |
| Seat | S | same |
| Ready for the doctor (again to clear) | R | same, or the drawer's toggle |
| Ready for checkout (again to clear) | Shift+R | drawer toggle |
| Out — visit complete | O | same |

Keys are in the `?` list under "Patient flow". Focusing or opening a visit makes its patient the active patient.

## What's automated / how it's safe
- **Ready is a flag, not a status**: nullable `appointments.ready_at` / `ready_for` ('doctor' | 'checkout'),
  added in `COLUMNS`; the status CHECK is unchanged. `PUT /appointments/:id/ready { ready_for | null }` needs
  `schedule:write`, checks the practice (404 otherwise), only works on a seated patient (409), writes through
  `recorded()` and `audit('appointment.ready')` with before/after. Sending the same value again changes nothing.
- **Undo instead of "Are you sure?"**: each step is optimistic and shows an Undo toast (also Ctrl/⌘+Z). Undo goes
  back through the same routes with `undo: true`, which the audit row records ("in chair → checked in (undo)").
- **Stepping back clears the undone step's times** (e.g. undoing a check-in clears `arrived_at`, back to the
  waiting room clears `seated_at` and Ready) so the next real check-in records the right time; the change log
  keeps the old values. Completing keeps Ready, so undoing "out" restores it.
- A Ready badge shows on the card, in the list view and in the drawer. "Text we're ready" is unchanged.

## Edge cases
- **Completing a visit that posts charges** (planned procedures, person has `clinical:write`): Undo can't take
  back the charges, so O / the card button opens the drawer with "Complete visit & procedures" focused —
  Enter finishes it (2 actions). "Visit only" stays beside it.
- A step that doesn't apply (seating someone already out, Ready before seating) shows a plain message and does
  nothing. A second press of the same key is refused once the first shows.
- Each step is its own request (`step_at`): the api reuses an idempotency key for identical requests within
  8 s, which would otherwise turn seat → undo → seat into a no-op. The steps are idempotent on the server.
- Cancel keeps its confirmation; No-show is unchanged (it releases procedures and recalls, which Undo can't
  restore).

## Acceptance
- `server/test/ready.test.js`: set / switch / clear, idempotent, audited with the user; 403 without
  `schedule:write`; 404 for another practice; stepping back clears times; undo is marked.
- `e2e/workflows/02-03-schedule.test.mjs` (#3): I, S, R, O = 1 action each; Ctrl+Z puts the visit back in
  the chair (server state checked); card button and drawer header = 1 click per step.
