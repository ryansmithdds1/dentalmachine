# PR1 · Production & income on one screen

**Budget: 1 action to the report, 1 per drill-down.** Reports → *Production & income* (or Ctrl/⌘K → "Production &
income") opens on this month to date; any number opens the entries behind it in one click. Presets are one key
(1–4); CSV and print are one key each (E, P).

## Trigger and who does it
The owner or office manager, weekly and at month end ("how are we doing against the goal?"); the billing lead when
a number looks wrong. Like Curve's and Open Dental's Production & Income report.

## Data needed
Ledger entries in the dates (the source of truth, integer cents), the provider on each charge, which work each
payment and write-off paid for (allocation), planned procedures on this month's visits, and the monthly goal.

## Target
- **Tiles on top:** Gross production · Adjustments (PPO write-offs / other) · Net production · Collections
  (patient / insurance, refunds apart) · Collection % · Scheduled rest of month · Projected month with the goal
  bar (done so far, then still scheduled).
- **By provider** table with the office total; every money cell is a drill-down.
- **Daily rows** (collapsed; D) with running net and collections.
- **Drill-down** in a side panel (no modal): the entries themselves — patient, date, type, code/tooth, provider,
  voided/reversal flags — adding up to the number clicked; CSV of those entries. Esc closes.
- **CSV / print:** the server CSV (providers, office total, days, projection line); print shows everything on
  paper, days expanded, no controls.

## Definitions (server: `productionIncome` in `server/src/reportlibrary.js`)
- Gross = charges; adjustments = all adjustment entries, split into PPO write-offs (`adjustment_type = 'Insurance
  write-off'` or on a claim — the same split as *Adjustments & write-offs by type*) and other; net = gross +
  adjustments; collections = patient + insurance payments; collection % = collections ÷ net (as *Collection
  percentage* and the month-end summary). Voided entries and their reversals cancel out.
- By provider: gross by the charge's provider; payments and credit adjustments by the work they paid for
  (`allocation.js`, as *Collections by provider*). What can't be placed (unapplied credit, debit adjustments,
  refunds, corrections of other periods) is its own row, **so the provider rows always add up to the office total.**
- Projection (shown when the dates run through today): month-to-date gross + fees of *planned* procedures on this
  month's visits from today on that aren't cancelled or missed. Goal: the office's/practice's monthly gross
  production goal (`metric_goals`), else the practice daily goal × open days this month, else blank.

## Safety
- Read-only. Practice-scoped; someone limited to some offices sees only theirs (and can't pick another office).
- `reports:read` required. The CSV export and every drill-down (they name patients) are audited.
- Scheduled and projected amounts are labelled as planned fees, not money.

## Acceptance
`server/test/productionreport.test.js`: numbers equal the ledger and the other library reports; voided entries
excluded; write-offs split; projection = done so far + scheduled rest of month; provider rows sum to the office;
drill-downs add up to each number; office isolation; permissions.
