# 52 · Inventory ordering

**Budget: 3 actions** (audit). **Measured: 2 to order everything low** (O, Enter) and **1 per delivery** ("Received N")
— `e2e/workflows/45-54-monthly.test.mjs` (#52).

## Measured path
To-do & labs → Supplies (Ctrl/⌘K "Supplies").
1. **O** (or "Reorder list (n)") opens the list **beside** the supplies (no dialog): what's at or below its reorder
   point, the quantity to order filled in (the item's usual order, or enough to get above the reorder point), cost,
   supplier. Untick or change a quantity if needed; "CSV for the supplier" for the order itself.
2. **Enter** — "Mark N ordered" has the focus. Undo on the toast (Ctrl/⌘Z) takes the order back.
- When it arrives: **"Received N"** on the item's row (or in the list's "On order") puts what was ordered on the
  shelf at once, with Undo. Rows show "N on order".
Before: 4 + ordering outside the app; receiving 2–3 per item through `window.prompt`.

## Server (`routes/inventory.js`)
- An order lives in the item's history (`inventory_moves`: `ordered` "Ordered N…", `order_cancelled`, `received`,
  `receive_undone`) — no new table. `GET /inventory/reorder` returns low items and what's on order.
- `POST /inventory/orders` skips items already on order (double click, two people). `POST /inventory/orders/cancel`.
- `POST /inventory/:iid/receive` (ordered quantity by default); `POST /inventory/moves/:mid/undo` adds a counter-move
  (both stay in the history) and reopens the order; only the latest delivery. All audited; practice-scoped.
- The shelf count ("Count…") now confirms with a toast instead of an alert box.
