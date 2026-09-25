# How the robot scores an action

Every action in [actions.md](actions.md) gets an **ease score from 0 to 100** and a **grade A–F**. The score starts at
100 and loses points for everything that makes the job slower or harder than it has to be. The points come from things
the robot counts while it does the job the way a staff member would, plus a few notes a reviewer adds after looking at
the screenshots. Every lost point is listed with its reason, so any score can be checked by hand.

The measuring robot is `e2e/actions/` (see [How to run it](#how-to-run-it)); the rules below are
`e2e/actions/lib/score.mjs`.

## What is counted

The robot signs in as the person who normally does the job (front desk, billing, dentist, hygienist or office manager),
starts where that person would be (usually the schedule), and does the job with real mouse clicks and key presses on a
fresh demo office. It uses the quickest way the app offers: the keyboard where there is a shortcut, the mouse where
there isn't.

| Signal | What exactly counts |
|---|---|
| **Clicks** | Every mouse press. A drag (moving a visit, dropping files) is one click. Choosing a file in the file picker is one click. Resting the mouse on something is free. |
| **Keys** | Every key press that isn’t a letter typed into a text box: Enter, Tab, Esc, arrows, shortcuts (I, Alt+P, Ctrl/⌘K…). A command typed as words — “new patient” in the command bar, MERGE in a confirmation box — counts as **one** key. |
| **Fields** | Every box the person had to type **information** into: a name, an amount, a note, a reference number, a search for the patient. One per box, however long the text: that information is part of the job, so the typing itself isn’t held against the software. (The number of characters is recorded as `textChars` but not scored.) |
| **Actions** | Clicks + keys + fields. This is the number the workflow budgets in `specs/` use. |
| **Screens** | How many times the screen changed: a new page, or a new tab of a page (`?tab=`). |
| **Dialogs** | Pop-up windows opened (`.modal`), and the most that were stacked on top of each other at once. |
| **“Are you sure?”** | The browser’s own confirm/prompt boxes, and app dialogs asking “are you sure / do you really want”. |
| **Form fields** | Every box shown in a form, dialog or side panel during the job: how many already had a value (a smart default) and which ones the person had to touch. Reported, used by the reviewer. |
| **Motion** | How far the mouse travelled between clicks, in pixels (1400×900 screen). |
| **Time** | Wall-clock time of the steps on a fast local server, excluding the robot’s own screenshots. It shows slowness in the app, not how fast a person reads. |
| **Keyboard only** | Whether the job was finished without the mouse. |
| **Errors** | Page crashes, console errors, failed requests and 4xx/5xx answers from the server during the job. |
| **Accessibility** | Boxes on screen without a label and buttons without a name (for screen readers and keyboard users). |
| **Review notes** | Added by a person (or the script, when it can tell) after looking at the screenshots: *asks-known* (asks for something the system already knows), *dead-end* (the screen can’t finish the job, or points somewhere that doesn’t exist), *wording* (unclear or technical words), *layout*, *bug*. |

## Points taken off

| Rule | Points | Why |
|---|---|---|
| Over target | **6 per action** over the target | The target is the budget in the workflow’s spec (`specs/`), or — for actions without one — what a well-designed screen would need (in `actions.json` as `target`). |
| Long task | 1 per action beyond 12 | Long jobs cost attention even when they are “on target”. |
| Screen changes | 3 per change beyond the first | Every new screen is a context switch. |
| Dialogs | 4 per dialog opened | CLAUDE.md: prefer inline editing and side panels. |
| Stacked dialogs | 8 per extra level | CLAUDE.md: no stacked modals. |
| “Are you sure?” | 10 per browser confirm/prompt box, 6 per in-app one | Allowed once, free, before something that can’t be undone (`destructive` in `actions.json`). |
| Slow | 2 per second over 3 s (max 20) | On a local server nothing should take seconds. |
| Mouse only | 15 | For the top-20 workflows (⌨ in actions.md), which must work from the keyboard alone. |
| Motion | 1 per 1,000 px of mouse travel over 2,000 (max 5) | Less hand movement. |
| Accessibility | 2 per unlabeled box or nameless button (max 10) | |
| Asks for known data | 5 each | CLAUDE.md: if the system knows it, never ask again. |
| Dead end | 8 each | |
| Unclear wording / layout | 3 each | |
| Bug | 10 each | |

The score never goes below 0.

**Hard fails** (grade F whatever the points): the robot could not finish the job (score 0), or anything went wrong
under the hood — a crash, a console error, a failed request or an error answer from the server (score capped at 50).

**Grades:** A 90–100 · B 80–89 · C 70–79 · D 60–69 · F below 60.

**Not scored:** *MISSING* (the app can’t do it), *BLOCKED* (the demo office isn’t set up for it — e.g. no card
processor or Google connection), *NOT MEASURABLE* (needs an x-ray sensor, camera or microphone) and *NOT YET MEASURED*
(no robot script yet).

### Example

“Check a patient out” (A017) as measured in the baseline: 7 actions (4 clicks, 2 keys, 1 typed amount) against a target
of 4 → 3 over × 6 = −18; 1 screen change (free); the payment amount was empty although the account has a balance
(asks-known −5). Score 100 − 18 − 5 = **77, grade C**.

## Which actions to fix first

The **improvement queue** in [scorecard.md](scorecard.md) ranks actions by

> **priority = how often per day × pain**, where pain = 100 − score (a missing feature counts as pain 100).

So a small annoyance in something done 30 times a day outranks a clumsy screen used once a month. The queue shows the
top 40, each with what the robot saw, a screenshot, and a proposed fix (from `e2e/actions/review.json`, written by the
reviewer after reading the screenshots).

## How to run it

```sh
cd client && npx vite build --outDir /tmp/dist-actions && cd ..   # once, or after client changes
CLIENT_DIST=/tmp/dist-actions npm run actions                      # every action that has a script (~15 min)
CLIENT_DIST=/tmp/dist-actions npm run actions -- A012 A013         # just these
CLIENT_DIST=/tmp/dist-actions npm run actions -- schedule          # one area (a file in e2e/actions/scripts/)
npm run actions -- --list                                          # what has a script
npm run actions:report                                             # rewrite actions.md and scorecard.md
```

Each run starts a fresh seeded demo server (never production), signs each role in once, and runs every action in its
own clean browser. `E2E_URL=http://localhost:4000` uses a server you started instead (faster while writing scripts).

Output goes to `e2e/actions/out/` (not committed):

- `out/<id>/NN-<step>.png` — a screenshot after every step, named after the step’s caption (`00-start.png` is where the
  job starts). These become the pictures in the user manual.
- `out/<id>/result.json` — the counts, the steps with their captions, what was clicked and typed, the problems and the
  score.
- `out/results.json` — every action’s latest result (a partial run only replaces what it measured).

## Writing a robot script

One entry per action in a file under `e2e/actions/scripts/` (grouped by area). `setup` prepares data through the API
(never counted); `run` opens the starting screen and performs the job in `t.step(caption, fn)` blocks — each step is
one screenshot and one line in the manual, so write the caption as the instruction a person would follow.

```js
A019: {
  role: 'frontdesk',
  async setup(t) { /* make a patient with a balance, make them the active patient */ },
  async run(t, { p }) {
    await t.open('/schedule', `.patient-bar:has-text("${p.last_name}")`);
    await t.step('Press Alt+P: the payment panel opens with the amount they owe', async () => {
      await t.key('Alt+p');
      await t.focusIs('Payment amount');
    });
    await t.step('Press Enter: posted', async () => { await t.key('Enter'); /* wait for it */ });
  },
},
```

Drive the page like a person: `t.key`, `t.type` (information), `t.cmd` (a command typed as words), `t.click`,
`t.pickFile`. Never `page.fill` in a measured step — it skips the keyboard and would count as nothing. When the script
notices a problem it can record it with `t.flag(kind, text)`; when the demo office can’t do the job,
`t.blocked(reason)`. Helpers for patients, visits, the active patient, the command bar and the menu are in
`e2e/actions/lib/fixtures.mjs`.

## What the numbers don’t capture

- **Reading and deciding.** The robot knows where everything is. A new employee doesn’t — wording and layout notes from
  the review stand in for that.
- **The best path only.** The robot takes the quickest route the app offers. If a shortcut exists but nobody knows about
  it, the score is better than the office’s experience (the ? list and the command bar are how people find them).
- **One patient, clean data.** Real charts have more history, more alerts and more pop-ups.
- **Time is the software’s time**, measured locally; network delay in the office adds to it.
