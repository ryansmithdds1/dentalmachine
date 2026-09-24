# 37 · Recall and unscheduled treatment lists

**Budget: 3 per patient** reached by phone; 0 for patients who book from the text. Built and measured by the recall
and follow-up features — [RC-recall.md](RC-recall.md), [RF-recall-frequencies.md](RF-recall-frequencies.md) and
[TF-treatment-followup.md](TF-treatment-followup.md). Measured by `e2e/workflows/RF-recall.test.mjs` (book a
hygiene visit with the due items bundled: 3; mark a recall contacted: 3) and `TF-followup.test.mjs` (approve a
doctor's letter: 1–2). Not re-measured in the daily test.

## Measured path
- Recall board (Follow-ups → Board): type the name in "Find a patient on the board", pick the row, **C** marks them
  contacted (3, measured).
- Booking from a recall: the visit type, hygienist, length and first opening on or after the due date come from
  the recall (workflow 9's suggestion), with the due extras (x-rays, fluoride…) bundled onto the visit (3, measured).

## Defaults
Recall type → visit type and due date; the patient's hygienist; the next opening on or after the due date.

## Keyboard path
Type the name · pick the row · C; booking: Alt+B · Enter (workflow 9).

## Background automation
The recall autopilot (RC) texts, emails and calls on a schedule until the patient books, and stops the moment they
do; unscheduled treatment follows up the same way (TF). The team's list holds only the calls the autopilot couldn't
make.
