# 51 · Merge duplicate patients

**Budget: 3 actions** (audit). **Measured: 3** (Enter, type MERGE, Enter) — `e2e/workflows/45-54-monthly.test.mjs` (#51).

## Measured path
Settings → Duplicate charts. People with the same name and birthday, J/K to move.
1. **Enter** (or "Compare & merge") opens the charts **side by side, inline** (no dialog): added, phone, email,
   visits and last visit, ledger entries and balance, notes, documents, insurance.
2. The chart to **keep is picked for you** — the one with the most history, the older one on a tie
   (`suggested_keep` from `GET /patients/duplicate-groups`); click the other to keep it instead. Type **MERGE**.
3. **Enter** merges.
Before: 5–6, and the first chart of the pair was always the one kept.

## Safety
- A merge can't be undone, so typing MERGE stays as the one deliberate step. The other chart is **archived** with
  `merged_into_id` (never deleted); records move to the kept chart; blank details are copied over; audited
  (`patient.merge`, with what moved). Administrators only. Merged charts drop out of the list.
- Matching ignores case and stray spaces in names.

## Background
The weekly/monthly pass raises **"N patients may have two charts"** in Needs attention for an administrator, and
resolves it when none are left.
