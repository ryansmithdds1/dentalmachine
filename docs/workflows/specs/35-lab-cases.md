# 35 · Create and track lab cases

**Budget: 6 actions.** Measured: **3** (L → type the shade → Enter). Tested by `e2e/workflows/32-44-daily.test.mjs`
(#35). Checking cases back in is [LB-labcheckin.md](LB-labcheckin.md) (measured by `LB-labcheckin.test.mjs`: 3).

## Measured path
To-do & lab cases, with the patient active (or Ctrl/⌘K "lab" → *New lab case — name* from any screen): **L** opens
the case already filled in; the cursor is in Shade; type it; Enter logs it. "Log & print slip" does the same and
opens the lab slip.

## Before (audit row 35)
12–15 actions: patient searched again, lab, work, tooth and provider picked by hand, and a `confirm()` box to print
the slip after saving.

## Defaults
- Patient: the active patient.
- Lab: the one this person used last, else the practice's only active lab; due date from its turnaround.
- Work: the patient's most recent planned or in-progress lab procedure (crowns, bridges, dentures, implant
  restorations), with its description, tooth and provider.
- Sent date: today.

## Keyboard path
`L` · type · Enter. Undo (Ctrl/⌘Z or the toast) cancels the case.

## Background automation
Due and overdue cases are flagged on the huddle ("lab not back") and the lab check-in list (LB).

## Safety
Undo sets the case to **cancelled** through the normal update (audited); cases are never deleted.
