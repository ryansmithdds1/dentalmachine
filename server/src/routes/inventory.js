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

  // What to order: items at or below their reorder point, by supplier.
  r.get('/inventory/reorder', requirePermission('schedule:read'), async (req, res) => {
    const rows = (await db.all('SELECT * FROM inventory_items WHERE practice_id = ? AND active = 1 AND reorder_at > 0 AND on_hand <= reorder_at ORDER BY supplier, name', req.user.practice_id))
      .map((i) => ({ ...i, order_qty: Math.max(i.reorder_qty || 0, i.reorder_at - i.on_hand + 1) }));
    res.json({ rows, total: rows.reduce((t, i) => t + (i.cost || 0) * i.order_qty, 0) });
  });
  return r;
}
