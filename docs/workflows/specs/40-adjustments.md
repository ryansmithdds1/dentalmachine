# 40 · Adjustments and write-offs

**Budget: 3 actions.** Measured: **3** (A → amount → Enter). Tested by `e2e/workflows/32-44-daily.test.mjs` (#40);
the rules by `server/test/daily.test.js`.

## Measured path
Chart → Ledger (or Ctrl/⌘K "adjust" → *Adjustment or write-off — name* from any screen). **A** opens the adjustment
right on the ledger (no dialog) with the cursor in Amount; type it; Enter posts. The toast says what was posted and
has **Undo**.

## Before (audit row 40)
5 actions in a dialog; nothing remembered.

## Defaults
- Type: the one this person used last (else "Courtesy discount"); its direction (reduces / adds to the balance).
- Reason: the type's name until the person writes their own. A reason is always required.
- Date: today (a date inside a closed period is refused).

## Keyboard path
`A` · type · Enter. Ctrl/⌘Z (or the toast) undoes.

## Safety (CLAUDE.md rules 1, 3, 8)
- `billing:write`; credits above the practice's approval limit need an administrator (403 with
  `approval_required`); a discount on an account you took cash from today needs a manager (cash controls).
- Undo **voids** the entry — a reversing entry with the reason "Undone right after posting" — never a delete. Both
  are audited (`ledger.adjustment`, `ledger.void`); the balance is always the ledger's sum.
