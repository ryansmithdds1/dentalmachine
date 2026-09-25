# 09 — Book an appointment

**Trigger:** a patient calls or is at the desk and needs a visit; someone drags out a time on the schedule;
the command bar's "book <name>"; Alt+B for the active patient from any screen.
**Who:** front desk, assistants, hygienists — `schedule:write` to book; the suggestion itself only needs
`schedule:read`.
**Data:** `GET /appointments/suggest` (new, `routes/schedule.js` → `suggestBooking`), `POST /appointments`,
`openSlots`, `patients.primary_provider_id` / `primary_hygienist_id`, `operatories.default_provider_id`,
recalls + `recall_types.appointment_type_id`, `appointment_types.duration` / `provider_durations`, the person's
last chair per provider (`user_prefs` key `book.chair@provider:<id>`).

## Today (audit row 9)
Drag a slot 1 + patient 1–2 + type 1 + Book 1 = 4–5; from N / + about 7–8 (date, time and length too). The
type didn't set the length after a drag, N / + defaulted to 09:00 / 60 min, the provider fell back to the first
provider, the open-time finder showed only :00 / :30, and a new booking showed a Status field.

## Target: 3 actions once the patient is known
| Start | Steps | Actions (measured) |
|---|---|---|
| Active patient, from any screen | Alt+B, Enter | **2** |
| Drag a time on the schedule | drag, "Book for <active patient>" (or Alt+B), Book | **3** |
| N, then find the patient | N, type the name, Enter, Enter | **4** — 2 of them are finding the patient (workflow 1) |
| Command bar | Ctrl/⌘K, "book jane", Enter, Enter | 4 (same: 3 of them are the search) |

## What's automated (smart defaults)
Once the patient is known the form asks the server for everything else. Only what the person chose is sent,
and whatever they change keeps its value (the rest follows the next suggestion):
- **Provider** — the patient's own dentist, or their hygienist when the type is a hygiene type; otherwise the
  provider they saw last; otherwise the first provider of the right kind (or, for a slot dragged into a chair,
  that chair's usual provider). A provider column or the V filter still decides it when dragging.
- **Visit type** — a due recall's visit type (and the search then starts on the recall's due date).
- **Length** — the type's length for that provider; a dragged range keeps its own length.
- **Chair** — the provider's usual chair, else the one this person last booked them in, else where the provider
  worked most in the last 90 days.
- **Time** — the first opening from now (or from the day on screen, if later) that's free for the provider
  (hours, visits, blocks, online requests on hold), the chair (visits and chair blocks) and the patient. A dragged
  or clicked time is kept. "Another time" finds the next one; Find open times lists every 10-minute start.
- The form says what it filled in and why ("Next opening: Tue Sep 29 9:10 AM with Dr. Lee in Op 2 (Jane's
  dentist · Dr. Lee's usual chair)"). Book is disabled until that arrives, then has the focus.
- Status is hidden on new bookings (always "scheduled").
- **Shorter form (phase 2 batch 1A, A020):** a new booking shows only what decides the visit — patient, the suggestion,
  type, date, time, length, provider, chair. Reason, notes, video, ASAP, "let the patient know" (on) and repeat sit under
  one "More options" line that says what they're set to; editing an existing visit shows everything. The form still
  opens in a dialog (the booking tests and the schedule rely on it); moving it into the visit side panel is left for a
  later batch.

## Edge cases
- No opening in the next 60 days: the form says so and leaves the time as it was.
- Alt+B while a dragged slot's form is open with no patient yet fills in the patient and keeps the slot.
- The first time can't be in the past; a patient who already has a visit at a time is never offered it.
- Double submit: the api's Idempotency-Key, plus the patient-conflict check (409) on the server.
- Office access: a person limited to some offices gets 404 for patients they can't see.

## Acceptance
- `server/test/booking.test.js`: own dentist vs hygienist by type; type length; usual chair; given values kept;
  fixed start not searched; skips provider, chair, block and patient conflicts; recall picks the type and due
  date; validation (400), other practice (404), signed out (401).
- `e2e/workflows/09-10-13-19-schedule.test.mjs` (#9): Alt+B + Enter = 2 and books the server's suggestion with
  the patient's own dentist and chair; N + search = 4; drag + chip + Book = 3 with the dragged time and length.
