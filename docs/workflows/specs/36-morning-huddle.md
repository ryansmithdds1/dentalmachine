# 36 · Morning huddle report

**Budget: 0 to read it, 1 per fix.** Measured: **1** (confirming an unconfirmed visit from its row). Tested by
`e2e/workflows/32-44-daily.test.mjs` (#36). The schedule optimizer's huddle plan is
[OPT-optimizer.md](OPT-optimizer.md).

## Measured path
Home ("Today") lists every patient on the schedule with their flags. **J/K** pick a row (or click it); each flag
on the row is a button with its key:

| Flag | Key | What happens |
|---|---|---|
| Unconfirmed | C | Confirmed (by phone) at once, with Undo |
| Verify insurance | V | Eligibility checked now; the answer is a toast and the flag goes |
| Unscheduled treatment / recall due | B | Booking opens for that patient (workflow 9) |
| Balance due | P | The ledger's payment form, amount filled in (workflow 12) |
| Update medical history | M | The chart's summary with the history |
| Lab not back | L | Lab check-in (LB) |

## Before (audit row 36)
Flags were read-only badges; each fix was a trip to another screen and a new patient search.

## Defaults
The patient on the row becomes the active patient, so the screen a fix opens already has them.

## Keyboard path
J/K · the key. Ctrl/⌘Z undoes a confirm.

## Background automation
Confirmations, reminders and overnight eligibility (workflows 13 and 20) clear most flags before the huddle;
the list shows only what's left.

## Safety
Keys are shown only to people with the permission for them. Confirm/undo use the normal status route (audited,
`undo: true` on the way back).
