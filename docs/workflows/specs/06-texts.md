# 6 · Send and read patient texts

**Trigger:** a patient texts the office, or staff need to text a patient.
**Who:** front desk, office manager, anyone with `patients:write` (reading needs `patients:read`).
**Data needed:** the conversation (texts and portal messages), the patient's number and opt-in, quick replies.

## Today (audit row 6)
Read: 2 clicks (Messages, the thread). Send: 4 actions (open, click box, type, Send). Unknown numbers needed
"Attach to patient" in a modal. The chart's Comms tab used a different composer in a modal (click, choose,
type, click Send). No keyboard movement between conversations.

## Target budget
**3 actions to send, keyboard only**: Alt+T (or Enter in the inbox), type, Enter.

## What's automated / changed
- One reply box everywhere (`components/ReplyBox.jsx`): Enter sends, Shift+Enter new line; the text stays if
  sending fails; a message saved but not delivered (failed, blocked by opt-out) says so in a red notice.
- `/messages?patient=ID` (Alt+T and the command bar's "text <name>") opens that patient's conversation with
  the cursor in the reply box — also for a patient who has never texted.
- Inbox keyboard: **J/K or ↓/↑** move between conversations (and show them), **Enter** jumps to the reply box
  (on a focused button it still presses it), **Esc** goes back to the list. Registered in the `?` list.
- Opening a patient's conversation (click, J/K, a link) makes them the active patient. Just landing on
  Messages (first conversation shown by default) doesn't.
- Unknown number: "Attach to patient" opens an inline search row (no dialog), with "New patient with this
  number" beside it. Attaching moves their texts to the patient and lands in the reply box.
- The chart's Comms tab has the same reply box inline (Text or Email, subject for email) and a link to the
  full conversation.
- A number we texted first (a text-back after a call) can be replied to again from its conversation.

## Edge cases
- Patient opted out / no mobile: the server refuses with a plain reason, shown as a red notice.
- Portal replies: the "Reply by" choice follows how the patient wrote; 4000 characters for portal, 480 for text.
- Double Enter / retry: the app sends an Idempotency-Key, so the server returns the first message.
- Delivery failures become Needs attention items (existing `sendMessage` behaviour).
- Marking read failing shows a notice instead of failing silently.

## Acceptance
- [x] Alt+T, type, Enter sends to the active patient in 3 actions (e2e).
- [x] Inbox: Enter, type, Enter replies in 3 actions; J/K/↓ move; Esc returns to the list; the patient becomes active (e2e).
- [x] Unknown number attached inline in 3 actions, no dialog (e2e).
- [x] Comms tab: Shift+Enter new line, Enter sends (e2e).
- [x] Replying to a number we texted first works (server test).
