# 10 — Move / reschedule an appointment

**Trigger:** the patient asks for another time, a provider's day changes, or the office rearranges chairs.
**Who:** anyone with `schedule:write`.
**Data:** `PUT /appointments/:id` (start, end, provider or chair; `override_blockout` for a deliberate move into
blocked time). Unchanged server route: a moved visit gets a fresh reminder and confirmation, as before.

## Today (audit row 10)
Same day: 1 drag, with Undo. Another day: 3–4 (drawer, Move…, change day, tap). No keyboard move at all (cards
only took Enter), and moving onto a blockout asked with `window.confirm`.

## Target: 1 drag or 3 keys
With a visit focused (click, Tab, or F then arrows):

| Move | Keys | Actions (measured) |
|---|---|---|
| Later / earlier by one grid step | M, ↓ / ↑, Enter | **3** |
| Next / previous chair or provider | M, → / ←, Enter | 3 |
| Same time on the next / previous day | M, Shift+→ / ←, Enter | **3** |
| By an hour | M, Shift+↓ / ↑, Enter | 3 |
| Into blocked time or outside hours | … Enter, then Enter on "Move it there" | **4** (one deliberate answer) |
| Park it, place it on any day | M, B · go to the day · M, (arrows), Enter | M Enter = **2** to place |
| Drag with the mouse (unchanged) | drag | **1** |

Keys are in the `?` list under "Moving visits". Page Up / Page Down also change the day while carrying.

## What's automated / how it's safe
- **Nothing is saved until Enter.** While a visit is carried, a dashed ghost shows where it would go and a
  banner reads "Moving Jane Doe to Wed Mar 3 2:10 PM · Op 2". Esc leaves it where it was.
- **Undo instead of "Are you sure?"**: every move (key, drag, pinboard) shows the existing Undo toast
  (Ctrl/⌘+Z); undo moves it back through the same route, so the history shows both.
- **Blocked time / outside hours** no longer uses `window.confirm`: an inline bar asks "That time is blocked:
  Staff meeting. Move Jane there anyway?" with "Move it there" focused (Enter) and "Keep it where it was" (Esc).
- The drawer's Move… starts the same carry (and still lets a mouse or touch user tap a new time).
- M with nothing focused picks up the newest visit on the pinboard; B while carrying parks it there.

## Edge cases
- Completed, cancelled and no-show visits can't be picked up (a message says so).
- The carry follows the day: Shift+→ loads the next day and keeps the column and time.
- Keys while carrying belong to the move (they don't change status or views); Ctrl/⌘ combos still work.
- A conflict (someone else in that chair / with that provider) is refused by the server and shown in red; the
  visit stays where it was.

## Acceptance
- `e2e/workflows/09-10-13-19-schedule.test.mjs` (#10): M ↓ Enter = 3 (server shows the new time, length kept);
  Ctrl+Z puts it back; M Shift+→ Enter = 3 to the next day; Esc saves nothing; into a staff-meeting block =
  4 with no dialog; pinboard place = 2; drag = 1 with an Undo toast.
