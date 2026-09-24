# 7 · Write clinical/progress notes

**Budget: 4 actions** from anywhere with the patient active (Alt+N → type or dictate once → Ctrl/⌘+Enter).
Tested by `e2e/workflows/07-notes.test.mjs`.

## Trigger and who does it
After (or during) a visit, the dentist, hygienist or assistant writes the progress note for what was done.
Every visit, every provider — the most frequent clinical write in the office.

## Data needed
- The patient (already active), today's visit (appointment) and its procedures (planned or completed).
- The office's note templates, matched to the procedure codes; the template this person used last for the
  visit's type when no code matches.
- The provider the note is for: the signed-in person's own provider record, else the visit's provider.
- The note text (typed or dictated); whether to sign now (only people with `clinical:sign`).

## Today (from the audit)
~7 actions: open the patient (3), Notes tab (1), pick a template from a select (1), type (1), Save (1). A
`window.confirm` blocks the save when template questions are unanswered, and the visit link is chosen from a
separate select on the saved note afterwards. Provider starts as the patient's primary provider, not the person
writing.

## Target (4 actions)
1. **Alt+N** (patient bar) opens the Notes tab with the composer already drafted and the cursor in the
   "type what to add" box.
2. **Type or dictate** once (Alt+M toggles dictation). Tapping answers to template questions is optional.
3. **Ctrl/⌘+Enter** saves; **Ctrl/⌘+Shift+Enter** saves and signs (when the user can sign).

## What gets automated
- `GET /patients/:id/note-draft` with no procedure ids drafts from **today's visit** for the patient: its
  procedures' templates, merged with the patient, date and today's vitals. It returns `appointment_id`,
  `appointment_type_id`, today's visits (for the picker) and `user_provider_id`. With procedure ids (the chart's
  "write a note" after completing work), the visit is the one those procedures belong to, else today's visit.
- When no template matches the visit's procedures, the composer uses the template this user last inserted for
  that appointment type (`note.template@type:<id>`, remembered with `useRemembered`/`setPref`).
- The note is **linked to the visit when it's saved** (`appointment_id` on `POST /patients/:id/notes`); the
  composer shows the visit and it can be changed or cleared before saving. The note also takes the visit's
  office (`location_id`).
- Provider defaults to the signed-in user's provider, else the visit's provider, else the procedure's provider.
- Text still in the "type what to add" box when saving is added to the end of the note as written (not through
  the AI, so nothing unseen is rewritten).
- Unanswered template questions are an inline note under the questions, not a dialog; saving stays possible.

## Unchanged clinical rules
Notes go through the existing create and sign endpoints; signed notes can't be edited (addenda); `note.create`,
`note.sign` and `note.ai_draft_approved` (when dictation used the AI) are still audited; signing someone else's
note is still refused by the server — the note is kept and the error says it wasn't signed.

## Edge cases
| Case | Behaviour |
|---|---|
| No visit today | No draft, composer empty with "No visit today" in the visit picker; notes save unlinked. |
| Two visits today | The one in the chair (in chair → checked in → the one under way now → the next one → the last one). The picker lists every visit today. |
| Visit's procedures match no template, nothing remembered | Empty composer, still linked to the visit. |
| No templates at all | Same as above; typing or dictating is the note. |
| User without a provider record (admin, front desk) | Provider = the visit's provider. |
| Can't sign (`clinical:sign` missing) | No "Save & sign" button; Ctrl/⌘+Shift+Enter just saves. |
| Signing refused (another provider's note) | Note is saved, the error says it wasn't signed. |
| Double Ctrl+Enter | Button is busy while saving; the request carries an Idempotency-Key; the draft clears after the first save. |
| Visit id of another patient or practice | 400 / 404 from the server, as before. |

## Acceptance criteria
- From another screen with the patient active: Alt+N, type a sentence, Ctrl+Enter — ≤ 4 actions, no dialog;
  the saved note has `appointment_id` = today's visit.
- `note-draft` with no ids returns today's visit, its templates and the user's own provider (server tests).
- `?` lists "Save the note", "Save and sign the note" and "Start or stop dictation".
