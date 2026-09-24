# T · Team chat and tasks (backlog T1–T5)

**Budgets.** Message a colleague: **3 actions** from any screen (Ctrl/⌘K → type "chat @maria running late" →
Enter), or **2** with the panel (Ctrl/⌘J → type, Enter). Message about the active patient: **3** (Ctrl/⌘⇧J → type
→ Enter; the patient chip is already attached). Turn a message into a task: **3** (hover → task icon → Enter; who,
when and the patient are pre-filled). Tick a task off: **1** (X in My tasks, Ctrl/⌘Z undoes). Acknowledge an
urgent message: **1** ("Got it").

## Trigger and who does it
Everyone in the office, all day: "Room 2 needs a turnover", "Dr. Chen, Mrs. Diaz is asking about her crown",
"Friday: order supplies", "power flicker — save your work".

## Today (before)
No internal chat: people walk over, shout, or text each other's phones (PHI on personal devices, no record).
Tasks exist (workflow 28) but can't come from a conversation, don't repeat, and have no checklist.

## Target (after)
- **Ctrl/⌘J** opens a slide-out panel from any screen; the screen underneath stays as it was. **Esc** closes,
  **Alt ↑/↓** switches conversation, **Alt ⇧↓** jumps to the next unread.
- Channels: Everyone, Front desk, Clinical, and one per office (multi-office). Direct messages and small groups
  (up to 9, private to their members). Threads, @mentions (@name, @front-desk, @clinical, @everyone) with
  autocomplete, emoji picker (built in) and reactions, images and files (encrypted like documents), GIFs (only
  if the practice turns them on), search.
- Composer: **Enter** sends, **Shift+Enter** new line, **↑** in an empty box edits your last message, paste an
  image to attach it, the active patient is one click away as a chip, the ⚠ button marks it urgent.
- Nobody misses a message: red rail badge for DMs, @mentions and urgent; per-channel counts; desktop notices
  with a soft chime (permission asked once, from a button); **urgent** messages float over every screen until
  that person says "Got it", and the sender sees who has and hasn't; quiet hours per person; an email digest
  (counts only, never the text) for anything addressed to you still unread after the practice's delay.
- Tasks: any message → task (assignee, due date, patient carried over, link back); **My tasks** shows Overdue /
  Today / Upcoming / Someday / done today, plus "I asked others" and repeating tasks. One-line add: "order gloves
  @maria fri", "sterilizer log every monday", "call lab tomorrow !". Checklists. **J/K** move, **X** done, **N** new.
- Command bar: "Open team chat", "My tasks", "Message about this patient", "@maria" / "chat maria" opens the DM,
  "chat @maria running late" sends it straight away.

## What gets automated
Default channels and memberships are created on first use; recurring tasks appear on their day (one per date,
missed dates skipped); the digest job emails once per message; mentions pull people into a channel.

## Safety
- Tenant: every query is scoped to `practice_id`; DMs/groups answer 404 to non-members (not 403).
- PHI: a patient link is validated (practice + office access), audited (`chat.message.patient_link`), and each
  read of a patient-linked message (list, thread, search, file) is a PHI view in the audit log (once a minute
  per person and patient). Someone limited to other offices sees "a message about a patient at another office".
  Live events carry ids only; notifications and digests never include patient names or message text in email.
- History: edits keep the earlier text (`chat_message_edits`, audited with before/after); deletes set
  `status = 'deleted'` (text hidden, row kept, audited) and can be undone by the person who deleted; an
  administrator removing someone else's message must give a reason.
- Idempotency: `client_key` (unique per author) plus the app's Idempotency-Key — a resend returns the first
  message. Reactions and acknowledgements are set-to-state and unique.
- GIFs: off by default, admin-only switch (audited); provider behind `server/src/gifs.js` (sandbox by default,
  Tenor/GIPHY with a key); only the typed words are sent, with digits, emails, @handles and patient names removed;
  calls go through `loggedFetch`; images are fetched through the server from the provider's media hosts only.
- Tasks: same write permission as the To-do list; every create/update/done/reopen is audited; recurring
  occurrences are unique per series and date.

## Acceptance
`server/test/chat.test.js`: practice isolation, DM privacy, patient office access + PHI read audit, edit/delete
history and undo, idempotent send, unread counts and read markers, @group mentions, urgent acknowledgements,
reactions, task from a message, recurring generation, GIFs off by default and never calling a provider, digest.
