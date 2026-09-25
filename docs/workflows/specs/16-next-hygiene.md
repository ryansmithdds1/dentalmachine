# 16 · Schedule the next hygiene visit at checkout

**Trigger:** the patient is checking out and their recall (cleaning) is due or coming due. **Who:** front desk
(schedule:write). **Data:** recall type and due date, the patient's hygienist, the visit type's length, a chair.

**Today (audit):** 5–6 actions including leaving the schedule; the form opened at 09:00 with the first provider
and 60 minutes whatever the recall type; no suggested time.

**Budget:** 2 actions (**R** or click *Book … recall*, Enter to accept the first suggestion) — 1 when nothing is left
to pay: checkout then opens with the suggestions showing and the first one focused, so it's just Enter.

**Redesign:**
- **`GET /patients/:id/next-slots?appointment_type_id=&provider_id=&from=&count=3`** (`server/src/routes/nextslots.js`,
  mounted from `billing.js`): the first open time on each of the next three working days on or after `from` (never
  before now), with the type's length for that provider, skipping times the patient is already booked, reusing
  `openSlots` (hours, exceptions, blockouts, reserved blocks, pending online requests). Read-only.
- **Provider:** the patient's hygienist, else whoever saw them for their last hygiene visit, else the office's
  first hygienist, else their dentist. **Chair:** the one that provider used last, if it's free then.
- **Checkout** (`Checkout.jsx` + `components/NextVisitPicker.jsx`): *Book … recall* shows three choices from the
  recall due date; the first has focus, so Enter books it through `POST /appointments` (all its usual checks).
  *Other time…* opens the full booking form prefilled with the suggestion (date, time, hygienist, chair, type).

**Automated:** date, time, provider, length, chair.

**Edge cases:** the time was taken meanwhile → the booking is refused (409), the message shows and the list
refreshes; no open time in four months → says so and offers *Other time…*; recall due in the past → from today;
another practice's patient, provider or type → 404; a second Enter on the same slot is a double-booking the server
refuses (patient conflict).

**Acceptance:** `e2e/workflows/11-12-16-17-18-money.test.mjs` — at checkout, click then Enter books the first
suggestion with the hygienist in 2 actions. `server/test/moneyflows.test.js` — hygienist choice, type length,
patient conflicts skipped, booked slot no longer offered, never in the past, bad dates 400, other practice 404.

## Phase 2 batch 1A
- **R** on the checkout page (also from the amount box) opens the suggestions; they open by themselves when there is
  nothing to collect, and right after a payment is posted. Esc skips to "Mark checked out".
- **Same time of day:** checkout passes the time of today's visit (`near=HH:MM`); on each day the open time closest
  to it is offered instead of the first one of the day (`server/test/frontdesk-b1a.test.js`). Recall interval (from
  the due date) and the patient's hygienist are as before.
