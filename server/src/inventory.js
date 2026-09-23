import { insert } from './util.js';

// Changes stock and keeps the history. When it falls to the reorder point, the office gets a to-do.
export async function moveStock(db, item, change, { reason, note = null, procedureId = null, userId = null, today = null }) {
  await db.run('UPDATE inventory_items SET on_hand = on_hand + ? WHERE id = ?', change, item.id);
  await insert(db, 'inventory_moves', { practice_id: item.practice_id, item_id: item.id, change, reason, note, procedure_id: procedureId, created_by: userId });
  const after = item.on_hand + change;
  if (item.reorder_at > 0 && item.on_hand > item.reorder_at && after <= item.reorder_at && today) {
    await insert(db, 'tasks', { practice_id: item.practice_id, priority: 'normal', due_date: today, title: `Reorder ${item.name}${item.supplier ? ` from ${item.supplier}` : ''}: ${after} ${item.unit} left` });
  }
  return after;
}

// A completed procedure uses up the supplies set for its code (Settings → Supplies → "Used by").
export async function useSupplies(db, procedure, { userId = null, today = null } = {}) {
  const uses = await db.all(
    'SELECT u.qty, i.* FROM inventory_usage u JOIN inventory_items i ON i.id = u.item_id WHERE u.practice_id = ? AND u.code = ? AND i.active = 1',
    procedure.practice_id, procedure.code,
  );
  for (const u of uses) await moveStock(db, u, -u.qty, { reason: 'used', note: procedure.code, procedureId: procedure.id, userId, today });
}
