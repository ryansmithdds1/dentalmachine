# FS · Fee schedules: increases, payer imports and history (backlog FS1–FS3)

**Budgets:** schedule a 5% increase for January 1 — **4 actions** (measured: **2**: `R` opens *Raise fees* with 5%,
nearest $1 and next January 1 filled in and the preview already showing → click *Schedule for Jan 1*). Approve a
payer's new schedule — **2 actions** (measured: **2**: click the draft under *Waiting* → *Approve and apply*).
Tested by `e2e/workflows/FS-fees.test.mjs` (UI) and `server/test/feeschedules.test.js` (rules).

## Trigger and who does it
- Once a year (usually January 1) the owner raises office fees by a few percent — on all codes, a category, or a
  list — and wants it done ahead of time so nobody forgets.
- A PPO sends a new fee schedule (PDF, spreadsheet) with an effective date. Billing uploads it or drops it in the
  schedule's inbox; someone with **fees:manage** (the owner/office manager; admins have it) approves it.
- Anyone with `billing:read` sees schedules, versions, comparisons and previews. Uploading a file needs
  `billing:write`. Scheduling, editing, cancelling and approving need `fees:manage`.

## Data needed
The schedules (standard fees on `procedure_codes`, office and PPO schedules in `fee_schedules` /
`fee_schedule_items`), how often each code was done in the last 12 months (for the impact estimate), the payer's
file, and the date it takes effect. Nothing is asked twice: the % and rounding default to the last used, the date
to next January 1, the schedule to the first PPO, the effective date to the one printed on the payer's document.

## Screen: Settings → Billing → Fee updates & history (`components/settings/FeeScheduleManager.jsx`)
- **List:** every schedule with its kind, number of codes, the version in effect ("v3 · since Jan 1, 2027"),
  **last updated** (date, who, how) and the next scheduled change or a draft to review.
- **Waiting:** drafts to approve and scheduled changes — each opens in the side panel (no stacked dialogs; Esc closes).
- **Raise fees (R):** which schedules (chips), %, rounding (to the cent, nearest $1, nearest $5, up to .00,
  up to .99), codes (all / categories / a list with prefixes like `D27*`), leave out, starting date, note. A live
  preview: old vs new per code, fees changing, procedures in the last 12 months, **estimated yearly effect**.
  The button reads *Apply now* for today or *Schedule for <date>*; the toast offers Undo (cancels what was scheduled).
- **Import payer schedule (I):** choose the schedule, drop a CSV / XLSX / PDF (or paste a table), or put it in the
  schedule's **inbox** to be read in the background. The draft opens straight away.
- **Review (draft):** totals (changed, new, missing, to check), filter chips, each line with now → new, $ and %
  change, your own fee, and flags: *over 3× your fee*, *under ⅓ of your fee*, *not one of your codes*. Untick lines
  to leave them out; choose whether codes missing from the new schedule are removed (kept by default); effective
  date; **Approve** (applies now, or on the date) or **Reject**. The AI's plain-language reason shows when AI read it.
- **History:** versions hidden until asked; every version with its date in effect, how it was made (baseline,
  hand edit, increase +5%, import, import (AI read)), who made and who approved it; view any version; pick A and B
  to **compare side by side**. PPO schedules also show **write-offs by version**.

## What gets automated
- `runFeeSchedules` (every 15 minutes): scheduled changes whose date has come **by the practice's local
  midnight** are applied once (the status flip is the claim, inside the transaction; a failure rolls back, is
  retried, and raises a *Needs attention* item `fee-change:<id>` that closes when it works or is cancelled).
- Inbox files are read into **drafts** (never applied) and raise a *Needs attention* item "ready to review"
  (`fee-import-review:<id>`), closed on approval or rejection; unreadable files raise `fee-inbox:<id>`.
- Every change — hand edits in Settings, group fee copies, increases, imports — makes a new **version**; the
  first one keeps the fees as they were as a baseline "from the beginning". Versions are never edited.

## Rules
- AI never changes fees: it reads a PDF into a draft (recorded as `source: ai` with its reason); a person approves.
  The assistant needs the on-screen OK (`X-Human-Approved`) to schedule, edit, cancel or approve (428 otherwise).
- Estimates and claims use `resolveFee` with the **date of service**: last year's work keeps last year's
  contracted fee; claims already created keep what they stored.
- Audit: scheduling, edits (before → after of the rule/date), approvals, rejections/cancellations and each applied
  version (before → after per code, who scheduled, who approved, whether it went live) — plus `fee_history` rows.
- An increase can't start in the past; an import can be back-dated (a payer's schedule effective last month) —
  work already on claims keeps its fees, new claims for dates after it use it.
- Repeats: the same file for the same schedule returns the same draft; requests carry an Idempotency-Key.

## Edge cases
Two changes on the same day → both kept as versions, the later one wins. A back-dated import older than the
current version only affects dates before that version (it doesn't touch today's fees). A fee edited by hand after
an increase was scheduled: the increase is worked out again on the day from the fees then (noted on the version).
Several schedules raised together share a `group_id`. Codes a payer sends that the office doesn't have are flagged
and can be left out. Old `.xls` files are refused with a plain message (save as .xlsx or CSV).

## Acceptance
`server/test/feeschedules.test.js`: rounding modes; preview scope and 12-month impact; scheduled increase applies
once at local midnight (Los Angeles), edit and cancel before; apply-now and idempotent repeat; CSV import diff
classification and approval needing `fees:manage` / the person's OK; XLSX and sandbox PDF reading; AI PDF read
into a draft; inbox job → drafts + Needs attention, never applied; failed application retried and surfaced;
versions never overwritten and compared; estimates and claims by date of service (historic claims unchanged) and
write-offs by version; office schedules through the resolver; permissions; practice isolation; the migration.
