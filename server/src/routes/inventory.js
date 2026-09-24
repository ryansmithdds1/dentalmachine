import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { insert, findOr404, audit, practiceNow } from '../util.js';
import { moveStock } from '../inventory.js';

const FIELDS = ['name', 'sku', 'category', 'unit', 'reorder_at', 'reorder_qty', 'supplier', 'cost', 'active', 'notes', 'location_id'];
const REASONS = ['received', 'used', 'adjusted', 'expired'];

// Supply inventory: items on hand, receiving and using stock, physical counts, and the reorder list.
export default function inventoryRoutes({ db }) {
  const r = Router();
  const today = async (req) => (await practiceNow(db, req.user.practice_id)).slice(0, 10);
  const clean = async (req, b, creating) => {
    const row = {};
    for (const k of FIELDS) if (b[k] !== undefined) row[k] = b[k];
    if (creating && !String(row.name || '').trim()) throw new HttpError(400, 'Name the item');
    if (row.name !== undefined) row.name = String(row.name).trim().slice(0, 120);
    for (const k of ['reorder_at', 'reorder_qty']) if (row[k] !== undefined) row[k] = Math.max(0, Math.round(Number(row[k]) || 0));
    if (row.cost !== undefined) row.cost = row.cost === null || row.cost === '' ? null : Math.max(0, Math.round(Number(row.cost) || 0));
    if (row.active !== undefined) row.active = row.active ? 1 : 0;
    if (row.location_id) await findOr404(db, 'locations', row.location_id, req.user.practice_id, 'Location');
    else if ('location_id' in row) row.location_id = null;
    for (const k of ['sku', 'category', 'unit', 'supplier', 'notes']) if (typeof row[k] === 'string') row[k] = row[k].trim().slice(0, 200) || (k === 'unit' ? 'each' : null);
    return row;
  };
  const view = async (item) => ({
    ...item, low: item.active && item.reorder_at > 0 && item.on_hand <= item.reorder_at,
    used_by: (await db.all('SELECT code, qty FROM inventory_usage WHERE item_id = ? ORDER BY code', item.id)),
  });

  r.get('/inventory', requirePermission('schedule:read'), async (req, res) => {
    const office = req.location_id;
    const items = await db.all(`SELECT * FROM inventory_items WHERE practice_id = ?${office ? ' AND (location_id IS NULL OR location_id = ?)' : ''} ORDER BY active DESC, category, name`, req.user.practice_id, ...(office ? [office] : []));
    const out = [];
    for (const i of items) out.push(await view(i));
    res.json({ items: out, value: out.filter((i) => i.active).reduce((t, i) => t + (i.cost || 0) * Math.max(0, i.on_hand), 0) });
  });

  r.post('/inventory', requirePermission('schedule:write'), async (req, res) => {
    const row = await clean(req, req.body || {}, true);
    const start = Math.round(Number(req.body?.on_hand) || 0);
    const id = await insert(db, 'inventory_items', { ...row, practice_id: req.user.practice_id, on_hand: 0 });
    const item = await db.get('SELECT * FROM inventory_items WHERE id = ?', id);
    if (start) await moveStock(db, item, start, { reason: 'adjusted', note: 'Starting count', userId: req.user.id });
    await audit(db, req, 'inventory.create', 'inventory_items', id);
    res.status(201).json(await view(await db.get('SELECT * FROM inventory_items WHERE id = ?', id)));
  });

  r.put('/inventory/:iid', requirePermission('schedule:write'), async (req, res) => {
    const item = await findOr404(db, 'inventory_items', req.params.iid, req.user.practice_id, 'Item');
    const row = await clean(req, req.body || {}, false);
    if (Object.keys(row).length) await db.run(`UPDATE inventory_items SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), item.id);
    // Which procedure codes use this item up, and how many each time.
    if (Array.isArray(req.body?.used_by)) {
      await db.tx(async () => {
        await db.run('DELETE FROM inventory_usage WHERE item_id = ?', item.id);
        for (const u of req.body.used_by) {
          const code = String(u.code || '').toUpperCase().trim();
          if (!/^D\d{4}$/.test(code)) throw new HttpError(400, `${u.code} isn't a procedure code`);
          await insert(db, 'inventory_usage', { practice_id: req.user.practice_id, code, item_id: item.id, qty: Math.max(1, Math.round(Number(u.qty) || 1)) });
        }
      });
    }
    res.json(await view(await db.get('SELECT * FROM inventory_items WHERE id = ?', item.id)));
  });

  // Received a delivery, used some, or wrote some off.
  r.post('/inventory/:iid/moves', requirePermission('schedule:write'), async (req, res) => {
    const item = await findOr404(db, 'inventory_items', req.params.iid, req.user.practice_id, 'Item');
    const reason = req.body?.reason;
    if (!REASONS.includes(reason)) throw new HttpError(400, `reason must be ${REASONS.join(', ')}`);
    let change = Math.round(Number(req.body?.quantity));
    if (!change) throw new HttpError(400, 'How many?');
    if (['used', 'expired'].includes(reason)) change = -Math.abs(change);
    if (reason === 'received') change = Math.abs(change);
    const on_hand = await moveStock(db, item, change, { reason, note: req.body?.note ? String(req.body.note).slice(0, 200) : null, userId: req.user.id, today: await today(req) });
    res.status(201).json({ on_hand });
  });
  r.get('/inventory/:iid/moves', requirePermission('schedule:read'), async (req, res) => {
    const item = await findOr404(db, 'inventory_items', req.params.iid, req.user.practice_id, 'Item');
    res.json(await db.all('SELECT m.*, u.name AS by_name FROM inventory_moves m LEFT JOIN users u ON u.id = m.created_by WHERE m.item_id = ? ORDER BY m.id DESC LIMIT 200', item.id));
  });

  // A physical count: each item set to what's actually on the shelf; the difference is recorded.
  r.post('/inventory/count', requirePermission('schedule:write'), async (req, res) => {
    const counts = req.body?.counts || {};
    let changed = 0;
    await db.tx(async () => {
      for (const [id, qty] of Object.entries(counts)) {
        const item = await findOr404(db, 'inventory_items', id, req.user.practice_id, 'Item');
        const n = Math.round(Number(qty));
        if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `Count for ${item.name} must be 0 or more`);
        if (n !== item.on_hand) { await moveStock(db, item, n - item.on_hand, { reason: 'count', note: `Counted ${n}`, userId: req.user.id }); changed++; }
      }
    });
    await audit(db, req, 'inventory.count', 'practices', req.user.practice_id, { changed });
    res.json({ changed });
  });

  // What to order: items at or below their reorder point, by supplier — and what's already on order (workflow 52).
  r.get('/inventory/reorder', requirePermission('schedule:read'), async (req, res) => {
    const rows = [];
    for (const i of await db.all("SELECT * FROM inventory_items WHERE practice_id = ? AND active = 1 ORDER BY COALESCE(supplier, ''), name", req.user.practice_id)) {
      const on_order = await openOrder(i.id);
      const low = i.reorder_at > 0 && i.on_hand <= i.reorder_at;
      if (low || on_order) rows.push({ ...i, low, on_order, order_qty: on_order?.qty ?? Math.max(i.reorder_qty || 0, i.reorder_at - i.on_hand + 1) });
    }
    const toOrder = rows.filter((i) => !i.on_order);
    res.json({ rows, total: toOrder.reduce((t, i) => t + (i.cost || 0) * i.order_qty, 0), on_order: rows.length - toOrder.length });
  });

  // ---- Orders (workflow 52) ----
  // An order is kept in the item's history (inventory_moves, change 0): 'ordered' with "Ordered N" in the note,
  // 'order_cancelled', and the delivery ('received'). A receipt taken back ('receive_undone') reopens the order.
  const openOrder = async (itemId) => {
    let open = null;
    let closed = null;
    for (const m of await db.all("SELECT id, reason, note, created_at FROM inventory_moves WHERE item_id = ? AND reason IN ('ordered','order_cancelled','received','receive_undone') ORDER BY id", itemId)) {
      if (m.reason === 'ordered') open = { qty: Number(/^Ordered (\d+)/.exec(m.note || '')?.[1]) || 0, at: m.created_at, move_id: m.id };
      else if (m.reason === 'order_cancelled') open = null;
      else if (m.reason === 'received') { closed = open; open = null; } else if (m.reason === 'receive_undone') open = closed;
    }
    return open;
  };

  // Mark items ordered (from the reorder list). An item already on order is left as it is, so a double click
  // or a second person doesn't order twice.
  r.post('/inventory/orders', requirePermission('schedule:write'), async (req, res) => {
    const list = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!list.length || list.length > 500) throw new HttpError(400, 'Choose what to order');
    const done = [];
    await db.tx(async () => {
      for (const it of list) {
        const item = await findOr404(db, 'inventory_items', it.id, req.user.practice_id, 'Item');
        const qty = Math.round(Number(it.qty));
        if (!Number.isFinite(qty) || qty < 1 || qty > 100000) throw new HttpError(400, `How many ${item.name}?`);
        if (await openOrder(item.id)) continue;
        await insert(db, 'inventory_moves', { practice_id: item.practice_id, item_id: item.id, change: 0, reason: 'ordered', note: `Ordered ${qty} ${item.unit}${item.supplier ? ` from ${item.supplier}` : ''}`.slice(0, 200), created_by: req.user.id });
        done.push({ id: item.id, qty });
      }
    });
    await audit(db, req, 'inventory.order', 'practices', req.user.practice_id, { items: done });
    res.status(201).json({ ordered: done });
  });

  // Take orders back (the Undo on "Marked ordered", or an order that won't come).
  r.post('/inventory/orders/cancel', requirePermission('schedule:write'), async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).slice(0, 500);
    const done = [];
    for (const id of ids) {
      const item = await findOr404(db, 'inventory_items', id, req.user.practice_id, 'Item');
      if (!(await openOrder(item.id))) continue;
      await insert(db, 'inventory_moves', { practice_id: item.practice_id, item_id: item.id, change: 0, reason: 'order_cancelled', note: req.body?.note ? String(req.body.note).slice(0, 200) : null, created_by: req.user.id });
      done.push(item.id);
    }
    await audit(db, req, 'inventory.order_cancel', 'practices', req.user.practice_id, { items: done });
    res.json({ cancelled: done });
  });

  // The delivery came: add what was ordered (or the quantity given) to the shelf.
  r.post('/inventory/:iid/receive', requirePermission('schedule:write'), async (req, res) => {
    const item = await findOr404(db, 'inventory_items', req.params.iid, req.user.practice_id, 'Item');
    const order = await openOrder(item.id);
    const qty = req.body?.quantity != null ? Math.round(Number(req.body.quantity)) : order?.qty || item.reorder_qty || 0;
    if (!Number.isFinite(qty) || qty < 1 || qty > 100000) throw new HttpError(400, 'How many came?');
    const on_hand = await moveStock(db, item, qty, { reason: 'received', note: order ? 'Order received' : null, userId: req.user.id, today: await today(req) });
    const move = await db.get("SELECT id FROM inventory_moves WHERE item_id = ? AND reason = 'received' ORDER BY id DESC LIMIT 1", item.id);
    await audit(db, req, 'inventory.receive', 'inventory_items', item.id, { quantity: qty, on_order: order?.qty ?? null, before: item.on_hand, after: on_hand });
    res.status(201).json({ on_hand, quantity: qty, move_id: move.id });
  });

  // Undo a receipt entered by mistake: a counter-move (the history keeps both), and the order is open again.
  r.post('/inventory/moves/:mid/undo', requirePermission('schedule:write'), async (req, res) => {
    const move = await findOr404(db, 'inventory_moves', req.params.mid, req.user.practice_id, 'Stock move');
    if (move.reason !== 'received') throw new HttpError(400, 'Only a delivery can be taken back here');
    const later = await db.get("SELECT id FROM inventory_moves WHERE item_id = ? AND id > ? AND reason IN ('received','receive_undone')", move.item_id, move.id);
    if (later) throw new HttpError(409, 'Something else was received since — correct it with a count instead');
    const item = await db.get('SELECT * FROM inventory_items WHERE id = ?', move.item_id);
    const on_hand = await moveStock(db, item, -move.change, { reason: 'receive_undone', note: `Undo of delivery #${move.id}`, userId: req.user.id });
    await audit(db, req, 'inventory.receive_undone', 'inventory_items', item.id, { move_id: move.id, quantity: move.change, before: item.on_hand, after: on_hand });
    res.json({ on_hand });
  });
  return r;
}
