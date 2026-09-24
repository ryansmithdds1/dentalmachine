# 28 · Staff-to-staff message or task

**Budget: 3 actions.** Measured: **3** (Ctrl/⌘K → type "task call the lab @jordan" → Enter) from any screen;
marking one done **1** (X on the To-do list), with Ctrl/⌘Z to undo. Tested by
`e2e/workflows/21-22-23-25-28.test.mjs`.

## Trigger and who does it
Anyone in the office handing something to a colleague: "call the lab about Jane's crown", "check her EOB",
"reorder gloves" — usually while looking at a patient.

## Data needed
What needs doing, who it's for, when (today unless said), and the patient it's about (the active one).

## Today (from the audit)
~9 actions (~7 from the chart): open To-do, + Task, type, pick the patient again, pick the assignee from a list,
set the date, Save. The assignee got no notice or badge.

## Target
- **Ctrl/⌘K**, type **"task <what> @<first name>"**, **Enter**. The command bar shows who it will go to before
  Enter ("New task for Jordan Lee · due today · about Tess Planwright"). Works on every screen
  (`components/QuickCommands.jsx`).
- The assignee gets a note ("New task from Morgan Reyes: …") and a **badge** on To-do & labs with their open count
  (red when something is due today or overdue).
- On To-do: **J/K** move, **X** marks the highlighted task done (Undo with Ctrl/⌘Z), **T** new task. The New task
  form starts due today and about the active patient.

## What gets automated
- `POST /tasks {text}`: the server parses the `@name` (first name, the start of it, or the whole name run
  together), refuses anything unclear ("More than one person matches @ann: …", "Nobody on the team is called
  @zed", two @names), defaults due to today (practice date). The patient must be in the practice.
- `GET /tasks/count`: my open tasks, how many are due, and the newest one someone else gave me.
- Live events (`publish`) on create/update carry only ids (task, assignee, who did it) — not the task text.
- `tasks.completed_by` (new column) records who ticked it off; reopening clears it. Every change is audited
  (`task.create` with assignee and patient, `task.update` with the status).

## Edge cases
An email address in the text is not a mention. Tasks from people without write access are refused (403). Names
only match people in your own practice.

## Acceptance
- e2e: 3 actions; saved for Jordan, due today, about the active patient; Jordan's screen shows the note and the
  badge; X marks it done in 1 action and Ctrl/⌘Z reopens it.
- `server/test/efficiency3.test.js`: parsing rules, count endpoint, completed_by set and cleared, audit trail,
  other practice refused.
