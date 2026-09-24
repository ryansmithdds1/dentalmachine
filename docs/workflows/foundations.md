# Shared foundations

The pieces every workflow redesign builds on. Use these instead of writing a new version in a screen.

| Piece | Where | How to use it |
|---|---|---|
| Command bar (Ctrl/⌘K or `/`) | `client/src/components/CommandPalette.jsx`, search in `server/src/patientsearch.js` | Finds patients by name (typos forgiven, either order), phone, birth date in any format, our chart # or the old system's. Empty: the active patient's actions and recent patients. Verbs: book, text, pay, note, chart, perio, ledger, x-rays, insurance + a name. Screens add their own commands with `useCommands([{ id, label, hint, run }])`. |
| Active patient | `client/src/activePatient.jsx`, `components/PatientBar.jsx` | Opening a chart (or picking a patient in the command bar) makes them active; the bar shows alerts, balance, insurance, next visit and actions on every screen. Alt+C/N/B/T/L/P act on them, Alt+X clears. Screens that show a patient call `useMakeActive(patient)`. |
| Shortcuts | `client/src/shortcuts.js`, `components/KeyboardHelp.jsx` | `useShortcut('c', fn, { label, section })` or `useShortcuts([...])`. Registered shortcuts appear in the `?` list automatically. Plain keys never fire while typing in a box or with a dialog open. |
| Undo instead of "Are you sure?" | `client/src/toast.js`, `components/Toasts.jsx` | `await undoable('Marked no-show', () => api.post(...), () => api.post(...reverse))`. The toast offers Undo (and Ctrl/⌘+Z). Undo goes through normal routes, so the audit trail shows both. Keep a real confirmation only for what can't be undone. |
| Smart defaults | `client/src/prefs.js`, `server/src/routes/prefs.js` (`user_prefs` table) | `const [method, remember] = useRemembered('payment.method', 'card')`; scope with a suffix: `note.template@provider:3`. Per user, on the server, so it follows them between computers. |
| Action budgets | `e2e/lib/budget.mjs`, `e2e/lib/server.mjs` | `trackActions(page)`, then `withinBudget(name, await measure(page, steps), { actions, ms })`. One action = a click, a key press, or typing into one field. Drive the page with click/keyboard (never `fill`) inside `measure`. Tests live in `e2e/workflows/`. |

## Decisions made

- **Recent patients and the active patient are kept per browser tab** (sessionStorage), not on the server or in
  localStorage, so a shared front-desk computer doesn't show the last person's patients after the tab closes.
  Signing out clears both.
- **Alt+letter for patient actions** (Chart, Note, Book, Text, Ledger, Pay, X to clear): plain letters are
  taken by screens (the schedule's T/D/W/A/N), and Ctrl/⌘ combos collide with the browser. Letters match by key
  position, so Alt on a Mac (which types symbols) still works.
- **The patient bar hides on that patient's own chart**, which already has the same header.
- **Remembered values are a convenience**, stored without audit (they aren't patient or money data) and capped
  at 500 per person.
- **Found and fixed while testing:** the first letter typed right after Ctrl/⌘K was lost (the box focused a
  moment after it opened).
