# 08 · Chart existing conditions and findings

**Trigger:** the exam, new-patient comprehensive exam, or reviewing x-rays. **Who:** dentist or assistant charting
as the dentist calls it out. **Data:** tooth, surfaces, finding or work, status (existing/planned/done).

**Today (audit):** ~9+ actions per finding: open the chart, Chart tab, click the tooth, switch to Condition mode,
click 1–3 surfaces, pick the condition, Save. No keyboard entry, notes through `window.prompt`, deletes through
`window.confirm`, one tooth at a time.

**Budget:** 4 actions per entry (3 measured), any number of teeth per entry.

**Redesign:**
- **Type it the way it's called out** (`ChartEntry.jsx`, `chartShorthand.js`): "30 MO caries", "14 D2740",
  "2-4 sealant plan", "19 rct done", "1, 16, 17, 32 missing; 8 watch". Any digit or E on the chart starts an entry;
  with a tooth selected the number can be left out; ↑ recalls the last entry; a live preview shows what will be
  charted before Enter. Work with no "plan"/"done" is existing work; codes are picked from tooth and surfaces
  (composite by surface count, RCT by tooth type, surgical extraction on request).
- **A new drawing** (`Odontogram.jsx`): anatomical teeth by type in side and top views, surfaces painted in both,
  crowns, root canals inside the roots, posts, implants, bridges, impactions, abscesses, fractures, sealants, veneers,
  mobility, missing teeth ghosted, planned extractions crossed; hover lift, glowing selection, a summary strip
  (planned $, to treat, watching, missing, done), light and dark themes. Arrow keys move between teeth.
- **Undo instead of dialogs:** Enter charts and shows an Undo toast (Ctrl/⌘Z). Removing a finding charted in error
  voids it (kept on record with who/when/why); removing planned work can be restored. Notes edit inline.
- **Completed work finds its provider:** the signed-in dentist, else today's visit, else the patient's dentist.

**Automated:** CDT code choice; provider for completed work.

**Edge cases:** primary teeth need "#K" (letters otherwise read as surfaces); supernumerary 51–82; an unknown word
is refused with what wasn't understood; out-of-range teeth refused; completed work isn't undone from the toast (its
charge must be reversed from the row, with a reason).

**Acceptance:** `e2e/workflows/01-04-08-chart.test.mjs` — "30 MO caries" in ≤ 4 actions, drawn on #30, undone with
Ctrl/⌘Z; three sealants in one entry; arrow keys move. `server/test/chartentry.test.js` — parser rules, void and
restore (isolated per practice, audited), provider defaults.
