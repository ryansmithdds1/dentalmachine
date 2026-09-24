# 5 · Identify an inbound caller

**Trigger:** the office line rings (Twilio `voice/inbound` webhook → live `call` event on every open screen).
**Who:** front desk, office manager — anyone with `patients:read`; next steps for unknown callers need `patients:write`.
**Data needed:** caller ID number, the patient(s) on file with that number, their balance, next and last visit.

## Today (audit row 5)
0 actions to see the pop, 1 click on the name to open the chart. The pop vanished after a fixed 90 s. An
unknown caller showed "Not a patient on file" with no next step. No key opened the popped caller. A family
sharing one number showed only the account holder.

## Target budget
**1 action** from the ring to the caller's chart (Alt+O). 0 to make them the active patient.

## What's automated
- A caller matched to exactly one patient becomes the **active patient** when the call pops, so the patient bar
  and Alt+C/N/B/T/L/P already act on them. Not when the user is working in another patient's chart (a
  hygienist mid-note must not have the context switched under them) and not for a shared family number.
- The pop stays until it's **dismissed or the call ends** ("Call ended", then gone after 8 s). A missed call
  stays until someone deals with it. A pop whose end event never arrives (lost webhook) clears after an hour.

## Screen
- Known caller: name (link), `Alt O` hint, number and caller name, balance, next visit, last seen.
- Family on one number: "Shares this number — who's calling?" with one button per person (account holder
  first); a click makes that person active and Alt+O opens their chart. Facts shown are the account's.
- Unknown caller, inline (no dialog):
  - **New patient with this number** → `/patients?new=1&phone=…` (the new-patient form).
  - **Text back** → an inline reply box with a suggested message already in it; Enter sends
    (`POST /calls/:cid/text`). Replies land in Messages under the number's conversation.
  - **Attach to a patient** → inline patient search; picking one files the call under them
    (`PATCH /calls/:cid`), saves the number on their chart if they had none, and makes them active.

## Edge cases
- No `patients:read`: the pop shows the number only.
- Several patients share the number: listed, account holder first; nobody is auto-activated.
- International or malformed caller ID: no Text back (server refuses too — caller ID can be faked).
- Number replied STOP: text back refused with a plain message (409).
- A text that fails to deliver is saved as failed, shows a red notice, and becomes a Needs attention item.
- Double click / retry on Text back: the app's Idempotency-Key makes the repeat return the first message.
- Up to three pops at once; the newest is the one Alt+O acts on.

## Safeguards
Attaching a call is recorded before/after (`recorded`) and audited (`call.attach`); the saved phone number
is recorded on the patient. Text-backs are audited (`call.text`) and go through `sendMessage`.

## Acceptance
- [x] Known caller: active patient without a click; Alt+O opens the chart in 1 action (e2e).
- [x] Pop remains while the call is on; "Call ended" then gone (e2e).
- [x] Family number lists both; one click picks (e2e, server test).
- [x] Unknown caller: text back in 2 actions; attach inline in 3; new patient opens the form (e2e).
- [x] Attach audited, number saved, cross-practice patient refused; text-back idempotent; non-US numbers refused (server tests).
- [ ] New-patient form arrives with the phone filled in — needs `PatientForm` to accept `defaults` (see report).
