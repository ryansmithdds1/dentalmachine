# PP · DN · S8 · S6 — Patient preferences, doctor's notes, "we moved them", customizable cards

Four backlog items that all land on the schedule's appointment card, the visit panel (drawer), the patient bar and the
chart header: **PP1** preferences (urgent ones impossible to miss), **PP2** personal connection notes, **DN1** the
doctor's notes to the front desk on the schedule, **S8** office-caused moves ("strikes") and the *Provider out today*
tool, **S6** choosing what each card shows.

**Data:** `server/src/cards.js` (rules: starter preferences, strikes, provider-out planning, apology text, card layout
catalog and validation, the day's card data); routes `server/src/routes/cards.js` (PP1, PP2, S6),
`server/src/routes/doctornotes.js` (DN1), `server/src/routes/officemoves.js` (S8); hooks in `routes/schedule.js`
(whose reason on move/cancel, a booking closes the note it came from). Tables (all additive, in `db.js`):
`patient_pref_options`, `patient_prefs`, `personal_notes`, `schedule_notes`, `provider_out_runs`, `office_moves`,
`card_layouts`, `appointment_labels`; columns `appointments.moved_by / office_reason / office_note`. A person's own card
layout is a `user_prefs` row (`schedule.card_layout`).
**Client:** `client/src/components/cards/` — `CardBody.jsx` (the card face drawn from a layout), `cardData.js` (one
request per range of days, live refresh), `Connection.jsx` (chips for the bar / chart / panel), `DoctorNotes.jsx`,
`VisitExtras.jsx` (visit panel), `MoveWhy.jsx`, `ProviderOut.jsx`, `CardLayoutEditor.jsx`, `ScheduleCardSettings.jsx`.
Wired into `CalendarGrid.jsx`, `AppointmentDrawer.jsx`, `BrokenPicker.jsx`, `PatientBar.jsx`, `PatientDetail.jsx`.
**Tests:** `server/test/cards.test.js`, `e2e/workflows/CARDS.test.mjs` (served by `e2e/lib/cards-app.mjs` until
`app.js` mounts the routes).

## Click budgets
| Workflow | Steps | Actions | Pinned by |
|---|---|---|---|
| Add an urgent preference (from the visit panel, patient bar or chart) and see it on the card | "Preferences" chip → "Urgent" beside the preference | **2** | CARDS PP1 (2 actions, 5 s) |
| Leave a doctor's note on an empty slot | right-click the slot → pick a quick note ("Fit an emergency here") | **2** | CARDS DN1 (2 actions, 5 s) |
| Own words instead | right-click (or `Shift+N`) → type → `Enter` | 3 | |
| Note on a visit | right-click the card (or focus it, `Shift+N`) → pick / type | 2 | |
| Front desk: acknowledge / book / make a task | click the bubble → "Got it" / "Book it" / "Make a task" | 2 | CARDS DN1 |
| Customize cards | cards button in the schedule's corner → tick an item → "Save for everyone" (or "Save just for me") | **3** | CARDS S6 (3 actions, 5 s) |
| Cancel for our reason | `X` → "Ours" → number key of the reason | 3 | CARDS S8 |
| Say a drag-move was ours | the "Whose reason?" bar after the move → the reason | 1 (0 if it was the patient's) | server test |
| Provider out today | right-click the provider's column heading (or the corner button) → check the plan → "Do it" | 2 | server test |

Keyboard: every list above has a keyboard path (`Shift+N` note; `Tab`/`Enter` in the popovers; the editor's items move
with ← → ↑ ↓ and come off with `Delete`; `Esc` closes any of them). No stacked modals: all are popovers and side panels.

## PP1 — preferences
- The practice's list starts with a starter set (pillow behind the neck, blanket, headphones / music, sunglasses, no
  nitrous, tell me each step, gag reflex, anxious — go gently, needs extra time, mornings only, text don't call) added the
  first time the list is read. Administrators add their own (Settings → Appointment cards, or right in the picker) and
  retire them (kept, `retired_at`; patients who have one keep it).
- A patient's preference can be **urgent**. Urgent ones show as a heart-hand icon on the schedule card (hover lists all
  their preferences), in the patient bar and chart header (by name), and as a banner in the visit panel — larger once the
  patient is checked in or seated.
- Adding the same preference twice is one row (partial unique index); removing marks it `removed` with who, when and why.
  Everything is audited (`patient_preference.add/change/remove`, before → after). `patients:write` to change;
  `patients:read` to see.

## PP2 — personal connection notes
- A quick "Personal" chip on the patient bar, chart header and visit panel: type, Enter. The latest note always shows
  on the chart header and — once the patient is seated — on the schedule card (the `personal` item).
- Every note stays in a timeline with who and when; removing one keeps it (struck through, who removed it). Retry-safe
  with `client_key`. Audited (`personal_note.add/remove`).

## DN1 — the doctor's notes on the schedule
- On a visit ("book crown next", "needs 90 min") or on an empty slot ("I have time 2–3 pm — fit an emergency"): quick
  picks or own words. Anyone with `schedule:write` or `clinical:write` can leave one (the assistant too — its source is
  recorded). Who and when are on every note.
- Everyone else on the schedule gets it at once: live event (`doctor_note`), a soft chime and a toast. Slot notes are a
  dashed amber outline over the time with a bubble; visit notes a bubble icon on the card (amber until someone says
  "Got it").
- "Got it" acknowledges; "Book it" opens the booking form on that slot (a slot note) or for that patient (a visit
  note) — the booking made within two hours closes the note and links it (`result_kind = appointment`); "Make a task"
  creates the task and closes the note in one click (asking twice returns the same task); "Done"; the author (or an
  administrator) can "Take back" (withdrawn). Never deleted. Audited (`schedule_note.*`).

## S8 — "we moved them" strikes and Provider out today
- **Whose reason?** Cancelling asks "The patient's / Ours (we had to move it)". Ours lists the office's reasons:
  provider sick, emergency, double-booked, equipment down, other. After a drag or tap-to-place move, a small bar asks the
  same without blocking anything (ignore it = the patient's). API clients send `moved_by` / `office_reason` on
  `PUT /appointments/:id`.
- The visit records `moved_by`, `office_reason`, `office_note`; each office move or cancel is an `office_moves` row
  (idempotent on visit + kind + time it moved from; voided with a reason, never deleted).
- **Strikes:** office moves and cancels in the last 12 months. "Moved by us 2× in 12 mo" on the card (count icon),
  patient bar, chart header and provider-out list, dates and reasons on hover. Moving that patient again warns first:
  the drag ghost says "⚠ We moved Maria 5 weeks ago — try someone else?", the visit panel's Move asks "Move anyway?".
- **Provider out today** (corner button, or right-click a provider's column heading): pick the provider and day → each
  visit is planned as *keep with another provider* of the same kind who is free then (checked with `validateAppt`:
  hours, blocks, conflicts; no double use of the same provider within the plan) or *reschedule*. Patients with recent
  strikes are placed first, so the ones asked to move are those with none. Per visit the person can change the choice.
  "Do it": kept visits change provider (reassign, not a strike; a heads-up text); rescheduled ones are cancelled for the
  office's reason (a strike), get a warm apology text with the online booking link (or the office phone) and the
  optional goodwill note, and a high-priority "Rebook …" task so nobody is lost. Texts go through `sendMessage` (opt-outs,
  failures become Needs attention). One run per `client_key`: a retry returns the first result and texts nobody twice.
  **High-risk for the assistant:** without `X-Human-Approved` it gets 428 (enforced in the route; the line for
  `aiguard.js` is in the hand-off).
- **Report:** "Moves we caused" — by reason and by provider (moved / cancelled / handed over / patients), CSV export
  (audited). Needs `reports:read`.

## S6 — customize what each card shows
- An editor (cards button in the schedule's corner; Settings → Schedule → Appointment cards) with lines of items in
  order: name, preferred name, age, birthday cake (on their birthday), visit type, procedures & teeth, production,
  balance due (only for people with `billing:read`), insurance / eligibility, confirmation, medical alert, new patient
  star, forms & consents (`PaperworkBadgeFor`), readiness, opportunities, urgent preferences, moved by us, doctor's notes,
  personal note, visit notes, provider / chair, time, office labels, ready / ASAP / recurring / waiting / late.
- Lines show as the card has room (the first always; then at 28, 44, 60 px… as before) and are skipped when empty.
  A separate **short-visit** layout for visits up to N minutes; **colour by** type / provider / status (or the
  schedule's own setting); the office's own **labels** (VIP, bring x-rays…) put on a visit from the visit panel.
- Live preview of a regular and a short card. Saved for the whole office (administrators, audited before → after) or
  just for me (`user_prefs`); "Use the office's cards" / "Back to the standard cards" undo either.
- The default layout is exactly the card as it was: the refactor draws the same lines and elements.

## Safeguards (what if this is wrong?)
| Risk | Safeguard |
|---|---|
| A strike recorded by mistake | Void with a reason (kept, no longer counted); audited |
| A double click / retry | Unique keys: one active preference per patient and option, `client_key` on notes and provider-out runs, one office move per visit + kind + from-time |
| Moving a whole column wrongly | Plan shown first, per-visit override; each visit validated like a booking; per-visit results (kept / rescheduled / failed); rebook tasks; the assistant can't do it without a yes |
| A text that doesn't go | `sendMessage` → Needs attention; the rebook task is made anyway |
| Another practice's data | Every id checked against `practice_id` (and office restrictions via `canSeePatient` / `appointmentScope`) |
| Deleting history | Nothing is hard-deleted except a person's own layout override (a preference, like other remembered choices) |
