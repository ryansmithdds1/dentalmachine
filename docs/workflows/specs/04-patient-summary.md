# 04 · Glance at the patient summary

**Trigger:** any question about the patient in front of you: alerts, balance, insurance, next visit.
**Who:** everyone, constantly. **Data:** `GET /patients/:id/card`.

**Today (audit):** 0 actions on the schedule, but only by hovering with a mouse; everywhere else the full chart
(3+ actions) and balance/insurance/next visit are further down.

**Budget:** 0 actions once the patient is active; 1 key to act on it.

**Redesign:** the active patient bar on every screen (`PatientBar.jsx`): name, age, chart #, the first alert (office,
medical, allergies, premed), balance (red when owed), insurance carrier with an eligibility dot, next visit, and
actions — Chart, Note, Book, Text, Ledger, Pay (Alt+C/N/B/T/L/P), Alt+X to clear. It hides on that patient's own
chart, which shows the same header.

**Automated:** the patient becomes active when opened, picked in the command bar, called in, or texted.

**Edge cases:** permissions (balance only with billing, alerts only with clinical access, per `/card`); archived or
deleted patient (bar disappears); narrow screens (action labels collapse to icons).

**Acceptance:** `e2e/workflows/01-04-08-chart.test.mjs` shows the bar with name, balance and next visit on the
billing screen with no actions; `foundations.test.mjs` opens the ledger with Alt+L in 1 action.
