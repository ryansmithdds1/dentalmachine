# CA · Chart audit: protect the doctor (CA1–CA4)

**Budgets:** fix a finding with an addendum **3 actions** from the audit list (J/K to the row → A → type →
"Save addendum"); "Check my chart" on a visit **1 action** (Alt+K on the notes tab) and each fix **1 click**;
"Ready for doctor" **1 click** when the chart is clean. Server: `server/src/chartaudit.js`, `server/src/chartcheck.js`,
`server/src/ai/notecompare.js`, `server/src/routes/chartaudit.js`. Screens: `client/src/pages/ChartAudit.jsx`,
`client/src/components/chartaudit/CheckMyChart.jsx` (on each unsigned, visit-linked note in Clinical notes).
Tests: `server/test/chartaudit.test.js`.

## Who and when
- **Nightly** (after 1am practice time) every completed visit in the office's look-back window (default 365 days) is
  checked; results are the Chart audit list. Managers can "Check now".
- **Before the doctor sees a chart** the assistant presses "Check my chart" (Alt+K) on the visit's note, fixes what's
  listed (or says why it's fine) and marks it **Ready for doctor**.
- **The doctor** works the review queue: charts checked clean first, then ones ready with notes, then open/unchecked.

## What is checked (each a small pure function in `chartaudit.js`, with a plain "why it matters")
| Check | Fires when |
|---|---|
| No note | a completed visit (or work completed without a visit) has no note |
| Note not signed | unsigned past the grace days (default 1); high risk past 7 days; says how long |
| Signed by someone else | the signer isn't the visit's or the work's provider |
| Charted work not in the note | a completed procedure's code or kind of work isn't described (keywords/CDT first; AI for the rest) |
| Work in the note not charted | a sentence says work was done (not planned/recommended) and nothing of that kind is charted |
| Tooth/surfaces differ | the sentence describing the work names another tooth, other surfaces, or no tooth at all |
| Anesthetic details | work that needs local anesthetic without type, amount (carpules) and site — or "none" |
| X-ray reading | images taken that day (or D02xx/D03xx) with no reading in the note or on the image |
| Consent | consent-category work (default oral surgery, endo, implants, plus listed codes) with no signed consent form, scanned consent or signed treatment plan within the valid days; notes that "consent signed" is claimed without a record |
| Medical history | not reviewed within the office's interval before the visit (review history from the audit log) |
| Blood pressure | office setting: every visit / visits with anesthetic / never; vitals that day or "BP 120/80" in the note |
| Informed refusal | a plan declined that day (not an option given up for another) without risks explained and understood |
| Post-op | surgery (default oral surgery, implants) without post-op instructions |
| Perio charting overdue | adult exam/hygiene visit and no full perio charting within the interval |
| Prescription not noted | a prescription written that day that the note doesn't name |
| Scheduled work not done | planned work attached to the visit, not completed, and the note doesn't say why |
"Check my chart" adds: dental-aware spelling (dental dictionary + the office's CDT descriptions and template words;
ordinary English is never flagged), repeated words (and an AI proofread when AI is on), template questions left
unanswered, and a same-day note not linked to the visit. Each has a one-click fix (replace the word, choose the
answer, add the missing sentence, link the note — through `PUT /notes/:id`, author only, unsigned only) or "Go there".

## Rules the office tunes (`chart_audit_rules`, managers, audited before → after)
Which checks are on; grace/high-risk days; medical history, perio and consent intervals; look-back; BP mode; which
categories/codes need consent, anesthetic details, post-op; whether the AI may read notes.

## AI (CA3)
Deterministic matching first. Only procedures the keywords can't place go to the AI adapter (`ai/notecompare.js`;
sandbox in tests), and only when AI is on for the server and in the office's rules. Its answer is used only when the
sentence it quotes is really in the note; findings it adds are labelled **AI read** with the quote. Reads are cached
per note version (`chart_audit_ai_reads`). It never edits or signs anything.

## Data and safety
- `chart_audit_findings` are derived rows: one live row per visit + check + subject, refreshed each pass; fixed ones
  get `status = resolved`, `resolved_at` and are kept. A problem that returns is a new row.
- Set aside (acknowledge) needs a reason, is audited, and is only for managers or the visit's own provider.
- Signed notes are never changed: the list's fix is **Add addendum** (`POST /notes/:id/addenda`, then sign).
- `chart_checks` keeps every "Check my chart" pass; `chart_ready` keeps who prepared a chart, when, and each remaining
  item's reason (withdrawn, never deleted). "Ready" is refused (409) while any item has neither a fix nor a reason.
- Visibility: own visits with `clinical:read`; everyone's findings, rules, run-now and assistant numbers for managers
  (administrators, `chartaudit:manage`, or `reports:read` + `clinical:sign`). Office-restricted users see their offices.
- Exports (CSV) are audited. Nightly pass: once per practice per day (`chart_audit_runs.run_key`), failures raise a
  Needs-attention item.

## Edge cases
| Case | Behaviour |
|---|---|
| Work completed without an appointment | grouped by patient and day as its own visit (`d<patient>-<date>`) |
| Note written that day but not linked | counted as the visit's note; "Check my chart" offers to link it |
| Addendum fixes the problem | addenda count as the note: the finding resolves on the next pass |
| Children | no perio-overdue flag under 18 |
| AI unreachable | keyword result stands; a Needs-attention item says so; resolved when the AI works again |
| Run now clicked twice | the second click gets "already running"; Idempotency-Key covers retries |
