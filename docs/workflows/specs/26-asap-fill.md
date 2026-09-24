# 26 · Fill openings from the ASAP/short-call list

**Budget: 2 actions** from the schedule. Measured: **2** (L, B — book it now). Texting the offer instead is also 2
(L, Enter; counted from the code, not measured by the test). Tested by `e2e/workflows/24-26-27.test.mjs`.

## Trigger and who does it
The front desk sees open time on today's (or any day's) schedule — a cancellation, a no-show, a gap that was never
booked — and wants to fill it from patients already booked later who asked for anything sooner (the ASAP list),
the waitlist, or recall-due patients. Needs `schedule:read` to see the list and `schedule:write` to act.

## Data needed
The day's open time per provider and chair and the patients who'd fit it — the optimizer's fill opportunities
(`GET /optimizer/today?date=`, `server/src/optimizer.js`): ASAP visits (`appointments.asap = 1`), the waitlist, recall
due; each one's length, provider and the chair it fits. Acting goes through `POST /optimizer/:id/act` (text the
offer, or `move_up` / `book`), and `POST /optimizer/:id/undo`.

## Today (audit row 26, measured in the code)
- **Automatic** for a cancellation ≥ 2 hours ahead (`server/src/fill.js` texts the next few who fit).
- **By hand: 6–7** — open the Waitlist panel 1, type/pick the date, time, minutes and provider for "Offer an
  opening" 3–4 (it started at 09:00, not the gap), Send 1; or open an ASAP patient's visit, "Move…", then click the
  gap 3. No way to go from an opening to who fits it; placement was mouse-only.

## Target
| Start | Steps | Actions (measured) |
|---|---|---|
| Schedule, patient on the phone says yes | **L** (fill list opens on the best fit), **B** book it now | **2** |
| Schedule, offer it by text | **L**, **Enter** (their YES books it — fill.js) | **2** |
| Next candidate | **J**/**K** to move, then B or Enter | +1 each |
| Waitlist panel | "Fill this day's openings" button (or L) | 1 to open |

L opens a side panel (not a modal) — "Fill openings" — with only the openings the ASAP list, the waitlist and
recall-due patients could fill. The first card has the focus. B moves an ASAP visit into the opening (and off the
ASAP list) or books a waitlist patient; the toast has **Undo** (Ctrl/⌘Z) that puts the visit back where it was,
still on the ASAP list. Esc closes the panel. The command bar lists "Fill openings from the ASAP list / waitlist".

## Smart defaults
- **Order** — ASAP first (already booked, want sooner), then the waitlist, then recall; earliest opening first.
- **Who fits** — the optimizer only offers patients whose visit length, provider and chair fit the gap, who aren't
  already on the schedule that day, and who can be reached; ones that don't fit say why.
- **The manual offer form** in the Waitlist panel now starts on the day's first real opening (provider, time,
  minutes) instead of 09:00; whatever the person changes stays theirs.
- **Day** — the day on screen.

## Keyboard-only path
L, then J/K and B (book) or Enter (text) or D (not today), Esc to close. Ctrl/⌘Z undoes a booking.

## Background automation
- Cancellations ≥ 2 hours ahead still go out automatically (fill.js): the first YES books it, the rest hear it's
  gone; the panel lists those under "Waiting on a reply" and "Done today", so the person only handles openings the
  automation couldn't.
- Offers queue until sending hours and expire when the opening is too close.

## Safety (CLAUDE.md)
- Moves go through the normal appointment route (conflict checks, audit with before/after); the optimizer records
  each act and its undo. A text can't be unsent, so there's no Undo on texting and no confirm (it's not destructive).
- A second B on a card already acted on does nothing (the card is gone/busy); the server's act is tied to one
  opportunity id.

## Edge cases
- Nobody fits: "Nobody on the ASAP list or waitlist fits an opening this day." plus the open time per provider.
- Optimizer routes not available for the practice: L does nothing and the button is hidden.
- A patient already booked that day isn't offered a second visit.

## Acceptance
- e2e: L + B = 2 actions; the ASAP visit moves into the opening with that provider and comes off the ASAP list;
  Undo puts it back and back on the list; Esc closes; no dialogs.
- Server: `test/optimizer.test.js` covers the fill opportunities, `move_up`, and undo.
