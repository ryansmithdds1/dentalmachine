# 19 — Cancellations and no-shows

**Trigger:** a patient calls to cancel, or doesn't come.
**Who:** front desk — `schedule:write`.
**Data:** `PATCH /appointments/:id/status` with new `broken_reason` (code) and `broken_note` (for "other");
new columns `appointments.broken_reason`, `broken_note` (`COLUMNS` in `db.js`); `GET /followups/broken` now
returns the reason, type, provider and length for rebooking; booking via workflow 9's suggestion.

## Today (audit row 19)
No-show 2 (no undo), cancel 3 (with a confirmation). No reason recorded, no fee, no "rebook now". The freed
slot is offered to the ASAP list automatically (good — kept).

## Target: 3 including the rebook
With the visit focused on the schedule (or open in the drawer):

| Step | Keys | Actions (measured) |
|---|---|---|
| Cancel, say why, rebook at the next open time | X, a number (1–7), Enter | **3** |
| No-show, say why (the rebook line waits on the schedule; nothing to close) | Shift+X, a number | **2** (+1 Enter to rebook) |
| From the drawer with the mouse | Cancel appointment / No-show, a reason, Book | 3 (+1 to open the drawer) |

Reasons: Sick · Work, school or a conflict · No ride · Cost or insurance · Forgot · We had to move it (cancel
only) · Didn't hear from them (no-show only) · Other… (a few words, required).

## What's automated / how it's safe
- **The reason picker is the confirmation.** A cancel or no-show gives back the visit's planned procedures and
  recalls, which Undo can't restore, so it stays a deliberate second step — but it records something useful
  instead of "Are you sure?". "Keep the visit" / Esc backs out.
- **Recorded**: the reason is validated on the server (known code; "other" needs a note; only with a cancel or
  no-show), written through `recorded()` (before/after in the change log) and in the `appointment.status` audit
  row (`broken_reason`, `broken_note`, and the audit `reason`). A series cancel ("this and later") gives the
  later visits the same reason. Putting a visit back on the schedule clears the reason (the log keeps it).
- **Rebook in one step**: "Book their next visit now" (on by default, remembered per person) puts a line on the
  schedule (phase 2, batch 2A — it used to open the booking form over the schedule): "Rebook Nova? Next opening
  Tue 10:00" for the same patient, visit type, provider and length, at the first opening after the broken time,
  with **Book it** focused — Enter books it, "Other time…" opens the full booking panel, Esc or "Not now" puts it
  away, and doing nothing leaves it (it blocks nothing). Tested by `e2e/workflows/09-10-13-19-schedule.test.mjs`. The Broken appointments list shows the reason and its button is "Rebook" with the same defaults.
- **Fill offer unchanged**: a cancellation still texts the ASAP / waitlist patients automatically (`fill.js`).
- **Broken-appointment fee: not added.** There is no existing fee setting or ledger flow for it, and the rules
  say not to invent money flows. If the practice later configures one, it should post through the ledger
  functions with an idempotency key tied to the appointment id.

## Edge cases
- Pressing X on a finished or already-cancelled visit says so and does nothing.
- A retried request (double click) finds the visit already cancelled with the same reason: no second change.
- Another practice: 404; no `schedule:write`: 403.
- A no-show in the past rebooks from now; a future cancellation rebooks after its own time (the freed time is
  left for the automatic fill offer).

## Acceptance
- `server/test/booking.test.js`: bad code / "other" without a note / reason with a non-cancel status → 400 and
  nothing changes; stored and trimmed; audit details, user and reason; broken list returns it; cleared when put
  back; no-show reason; 404 other practice; 403 billing.
- `e2e/workflows/09-10-13-19-schedule.test.mjs` (#19): X, 2, Enter = 3 → cancelled with "conflict", a new visit
  for the same patient, type and provider after the old time, reason in the history; Shift+X, 6 = 2 → no-show
  with "no_contact".
