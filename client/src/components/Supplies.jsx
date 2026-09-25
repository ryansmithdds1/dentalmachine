import { useEffect, useRef, useState } from 'react';
import { api, downloadCsv, dollars } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fromCents, toCents, fmtUtcDateTime } from '../format.js';
import { ErrorBox, Modal, useSubmit, AskButton } from './ui.jsx';
import { useShortcuts } from '../shortcuts.js';
import { toast, undoable } from '../toast.js';
import '../pages/monthly.css';

// To-do & labs → Supplies: stock on hand, deliveries, what procedures use up, counts and the reorder list.
export default function Supplies() {
  const { can } = useAuth();
  const { data, reload: reloadItems } = useApi('/inventory');
  // What's on order (workflow 52): shown on each row, and received with one click.
  const { data: reorder, reload: reloadOrders } = useApi('/inventory/reorder');
  const reload = () => { reloadItems(); reloadOrders(); };
  const [modal, setModal] = useState(null);
  const [err, setErr] = useState(null);
  const w = can('schedule:write');
  useShortcuts([
    { combo: 'o', handler: () => setModal({ type: 'reorder' }), label: 'What to order (the reorder list)', section: 'Supplies', enabled: modal?.type !== 'reorder' },
    { combo: 'escape', handler: () => setModal(null), label: 'Close the reorder list', section: 'Supplies', enabled: modal?.type === 'reorder' },
  ]);
  if (!data) return <div className="card">Loading…</div>;
  const low = data.items.filter((i) => i.low);
  const onOrder = Object.fromEntries((reorder?.rows || []).filter((i) => i.on_order).map((i) => [i.id, i.on_order]));
  // The delivery came: what was ordered (or the usual order) goes on the shelf at once, with Undo.
  const receive = async (item) => {
    const qty = onOrder[item.id]?.qty || item.reorder_qty;
    if (!qty) return;
    setErr(null);
    try {
      await undoable(`Received ${qty} ${item.unit} of ${item.name}`, () => api.post(`/inventory/${item.id}/receive`, {}), (r) => api.post(`/inventory/moves/${r.move_id}/undo`, {}).then(reload));
      reload();
    } catch { /* the toast shows it */ }
  };
  // How many is typed beside the button (no browser box); Enter records it (a wrong count is fixed with a count).
  const move = async (item, reason, q) => {
    const n = Number(q);
    if (!(n > 0)) throw new Error('Type how many, e.g. 1');
    setErr(null);
    await api.post(`/inventory/${item.id}/moves`, { reason, quantity: n });
    toast(`${reason === 'received' ? 'Received' : 'Used'} ${n} ${item.unit} of ${item.name}`);
    reload();
  };
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>Supplies</h2>
          <div className="muted" style={{ fontSize: 13 }}>{data.items.filter((i) => i.active).length} items · {money(data.value)} on the shelf{low.length ? ` · ${low.length} to reorder` : ''}. Completed procedures use up the supplies set for their code.</div>
        </div>
        <div className="inline">
          <button onClick={() => setModal({ type: 'reorder' })} title="O">Reorder list{low.length ? ` (${low.length})` : ''}{reorder?.on_order ? ` · ${reorder.on_order} on order` : ''}</button>
          {w && <button onClick={() => setModal({ type: 'count' })}>Count…</button>}
          {w && <button className="primary" onClick={() => setModal({ type: 'item', item: { name: '', unit: 'each', on_hand: 0, reorder_at: 0, reorder_qty: 0, used_by: [] } })}>+ Item</button>}
        </div>
      </div>
      <ErrorBox error={err} />
      <div className="table-wrap">
        <table className="compact-table" style={{ marginTop: 10 }}>
          <thead><tr><th>Item</th><th className="num">On hand</th><th className="num">Reorder at</th><th>Supplier</th><th className="num">Cost</th><th>Used by</th><th /></tr></thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.id} style={{ opacity: i.active ? 1 : 0.5 }}>
                <td>{i.name}{i.category && <div className="muted" style={{ fontSize: 11 }}>{i.category}{i.sku ? ` · ${i.sku}` : ''}</div>}</td>
                <td className="num">{i.on_hand} {i.unit}{onOrder[i.id] ? <div><span className="badge info nocap">{onOrder[i.id].qty} on order</span></div> : i.low && <div><span className="badge warn">Reorder</span></div>}</td>
                <td className="num">{i.reorder_at || '—'}</td>
                <td>{i.supplier || '—'}</td>
                <td className="num">{i.cost != null ? money(i.cost) : '—'}</td>
                <td style={{ fontSize: 12 }}>{i.used_by.map((u) => `${u.code}${u.qty > 1 ? ` ×${u.qty}` : ''}`).join(', ') || '—'}</td>
                <td>
                  <div className="inline" style={{ gap: 4 }}>
                    {w && (onOrder[i.id]?.qty || i.reorder_qty
                      ? <button className="small" onClick={() => receive(i)} aria-label={`Receive ${i.name}`}>{onOrder[i.id] ? `Received ${onOrder[i.id].qty}` : 'Receive'}</button>
                      : <AskButton title={`Receive ${i.name}`} label={`How many received (${i.unit})?`} initial="1" required submit="Received" onSubmit={(q) => move(i, 'received', q)}>Receive</AskButton>)}
                    {w && <AskButton label={`How many used (${i.unit})?`} initial="1" required submit="Used" onSubmit={(q) => move(i, 'used', q)}>Use</AskButton>}
                    <button className="small" onClick={() => setModal({ type: 'history', item: i })}>History</button>
                    {w && <button className="small" onClick={() => setModal({ type: 'item', item: i })}>Edit</button>}
                  </div>
                </td>
              </tr>
            ))}
            {!data.items.length && <tr><td colSpan={7} className="muted">No supplies yet. Add the things you reorder regularly.</td></tr>}
          </tbody>
        </table>
      </div>
      {modal?.type === 'item' && <ItemForm item={modal.item} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal?.type === 'count' && <CountForm items={data.items.filter((i) => i.active)} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal?.type === 'history' && <History item={modal.item} onClose={() => setModal(null)} />}
      {modal?.type === 'reorder' && <Reorder data={reorder} canWrite={w} onReceive={receive} onClose={() => setModal(null)} onChanged={reload} />}
    </div>
  );
}

function ItemForm({ item, onClose, onDone }) {
  const [f, setF] = useState({ ...item, cost: item.cost != null ? fromCents(item.cost) : '', used_by: (item.used_by || []).map((u) => `${u.code}${u.qty > 1 ? `x${u.qty}` : ''}`).join(', ') });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    const usedBy = String(f.used_by || '').split(/[\s,]+/).filter(Boolean).map((x) => { const [code, qty] = x.toUpperCase().split('X'); return { code, qty: Number(qty) || 1 }; });
    const body = { name: f.name, sku: f.sku, category: f.category, unit: f.unit, reorder_at: f.reorder_at, reorder_qty: f.reorder_qty, supplier: f.supplier, cost: f.cost === '' ? null : toCents(f.cost), notes: f.notes, active: f.active ?? true };
    const saved = item.id ? await api.put(`/inventory/${item.id}`, body) : await api.post('/inventory', { ...body, on_hand: Number(f.on_hand) || 0 });
    await api.put(`/inventory/${saved.id}`, { used_by: usedBy });
    onDone();
  });
  return (
    <Modal title={item.id ? `Edit ${item.name}` : 'New supply item'} onClose={onClose}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label className="full">Name<input value={f.name} onChange={set('name')} placeholder="e.g. Prophy angles" /></label>
        <label>Category<input value={f.category || ''} onChange={set('category')} placeholder="e.g. Hygiene" /></label>
        <label>SKU / item #<input value={f.sku || ''} onChange={set('sku')} /></label>
        <label>Unit<input value={f.unit || ''} onChange={set('unit')} placeholder="box, pack, each" /></label>
        {!item.id && <label>On hand now<input type="number" min="0" value={f.on_hand} onChange={set('on_hand')} /></label>}
        <label>Reorder when down to<input type="number" min="0" value={f.reorder_at} onChange={set('reorder_at')} /></label>
        <label>Order this many<input type="number" min="0" value={f.reorder_qty} onChange={set('reorder_qty')} /></label>
        <label>Supplier<input value={f.supplier || ''} onChange={set('supplier')} /></label>
        <label>Cost per unit ($)<input type="number" step="0.01" min="0" value={f.cost} onChange={set('cost')} /></label>
        <label className="full">Used by procedures (codes, e.g. D1110, D2740x2)<input value={f.used_by} onChange={set('used_by')} /></label>
        {item.id && <label className="checkbox"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> Active</label>}
      </div>
      <div className="form-actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !f.name} onClick={submit}>Save</button></div>
    </Modal>
  );
}

function CountForm({ items, onClose, onDone }) {
  const [counts, setCounts] = useState(() => Object.fromEntries(items.map((i) => [i.id, String(i.on_hand)])));
  const { submit, busy, error } = useSubmit(async () => {
    const r = await api.post('/inventory/count', { counts: Object.fromEntries(Object.entries(counts).filter(([, v]) => v !== '')) });
    toast(`${r.changed} item${r.changed === 1 ? '' : 's'} updated.`);
    onDone();
  });
  return (
    <Modal title="Count what's on the shelf" onClose={onClose}>
      <ErrorBox error={error} />
      <p className="muted" style={{ fontSize: 13 }}>Enter what you actually have; the difference is recorded in each item's history.</p>
      <table className="compact-table">
        <tbody>{items.map((i) => <tr key={i.id}><td>{i.name}</td><td className="num" style={{ width: 120 }}><input type="number" min="0" aria-label={`${i.name} count`} value={counts[i.id]} onChange={(e) => setCounts({ ...counts, [i.id]: e.target.value })} /></td><td>{i.unit}</td></tr>)}</tbody>
      </table>
      <div className="form-actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={submit}>Save count</button></div>
    </Modal>
  );
}

function History({ item, onClose }) {
  const { practice } = useAuth();
  const { data } = useApi(`/inventory/${item.id}/moves`);
  return (
    <Modal title={`${item.name} — history`} onClose={onClose}>
      <table className="compact-table">
        <tbody>
          {data?.map((m) => <tr key={m.id}><td>{fmtUtcDateTime(m.created_at, practice?.timezone)}</td><td>{m.reason}{m.note ? ` · ${m.note}` : ''}</td><td className="num">{m.change > 0 ? `+${m.change}` : m.change}</td><td className="muted">{m.by_name || ''}</td></tr>)}
          {data?.length === 0 && <tr><td className="muted">Nothing yet.</td></tr>}
        </tbody>
      </table>
    </Modal>
  );
}

// The reorder list, beside the supplies (no dialog): what's low with the quantity to order already filled in, and
// what's on order. "Mark N ordered" (focused: O, Enter) records the order once (a second click orders nothing twice)
// with Undo; the CSV is what goes to the supplier. A delivery is one click on "Received".
function Reorder({ data, canWrite, onReceive, onClose, onChanged }) {
  const [qty, setQty] = useState({});
  const [skip, setSkip] = useState({});
  const [busy, setBusy] = useState(false);
  const go = useRef(null);
  const toOrder = (data?.rows || []).filter((i) => !i.on_order);
  const ordered = (data?.rows || []).filter((i) => i.on_order);
  const picked = toOrder.filter((i) => !skip[i.id]);
  const ready = !!data;
  useEffect(() => { if (ready) go.current?.focus(); }, [ready]);
  const qtyOf = (i) => Number(qty[i.id] ?? i.order_qty);
  const markOrdered = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    try {
      await undoable(
        `Marked ${picked.length} item${picked.length === 1 ? '' : 's'} ordered`,
        () => api.post('/inventory/orders', { items: picked.map((i) => ({ id: i.id, qty: qtyOf(i) })) }),
        (r) => api.post('/inventory/orders/cancel', { ids: r.ordered.map((o) => o.id), note: 'Undo' }).then(onChanged),
      );
      onChanged();
    } catch { /* the toast shows it */ } finally { setBusy(false); }
  };
  const cancel = async (i) => {
    try {
      await undoable(`Order for ${i.name} cancelled`, () => api.post('/inventory/orders/cancel', { ids: [i.id] }), () => api.post('/inventory/orders', { items: [{ id: i.id, qty: i.on_order.qty }] }).then(onChanged));
      onChanged();
    } catch { /* the toast shows it */ }
  };
  const csv = (rows) => downloadCsv('reorder-list', rows, [['Item', (i) => i.name], ['SKU', (i) => i.sku || ''], ['Supplier', (i) => i.supplier || ''], ['On hand', (i) => i.on_hand], ['Order', (i) => qtyOf(i)], ['Unit', (i) => i.unit], ['Est. cost', (i) => (i.cost != null ? dollars(i.cost * qtyOf(i)) : '')]]);
  return (
    <aside className="drawer wl-drawer" role="dialog" aria-label="Reorder list">
      <div className="drawer-head">
        <div>
          <strong>Reorder list</strong>
          <div className="muted" style={{ fontSize: 13 }}>{toOrder.length} to order · {ordered.length} on order</div>
        </div>
        <button className="small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="drawer-body">
        {!data ? 'Loading…' : (
          <>
            <h3 style={{ marginTop: 0 }}>To order</h3>
            <table className="compact-table">
              <thead><tr><th /><th>Item</th><th className="num">On hand</th><th className="num">Order</th><th className="num">Est.</th></tr></thead>
              <tbody>
                {toOrder.map((i) => (
                  <tr key={i.id} style={{ opacity: skip[i.id] ? 0.5 : 1 }}>
                    <td><input type="checkbox" aria-label={`Order ${i.name}`} checked={!skip[i.id]} onChange={(e) => setSkip({ ...skip, [i.id]: !e.target.checked })} /></td>
                    <td>{i.name}<div className="muted" style={{ fontSize: 11 }}>{i.supplier || 'no supplier'}{i.sku ? ` · ${i.sku}` : ''}</div></td>
                    <td className="num">{i.on_hand}</td>
                    <td className="num"><input type="number" min="1" style={{ width: 64 }} aria-label={`How many ${i.name}`} value={qty[i.id] ?? i.order_qty} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} /> {i.unit}</td>
                    <td className="num">{i.cost != null ? money(i.cost * qtyOf(i)) : '—'}</td>
                  </tr>
                ))}
                {!toOrder.length && <tr><td colSpan={5} className="muted">Nothing needs reordering.</td></tr>}
              </tbody>
            </table>
            <div className="form-actions">
              <span className="muted">Estimated {money(picked.reduce((t, i) => t + (i.cost || 0) * qtyOf(i), 0))}</span>
              <button disabled={!picked.length} onClick={() => csv(picked)}>⬇ CSV for the supplier</button>
              {canWrite && <button ref={go} className="primary" disabled={!picked.length || busy} onClick={markOrdered}>{busy ? 'Saving…' : `Mark ${picked.length} ordered`}</button>}
            </div>
            {ordered.length > 0 && (
              <>
                <h3>On order</h3>
                <table className="compact-table">
                  <tbody>
                    {ordered.map((i) => (
                      <tr key={i.id}>
                        <td>{i.name}<div className="muted" style={{ fontSize: 11 }}>{i.on_order.qty} {i.unit}{i.supplier ? ` from ${i.supplier}` : ''}</div></td>
                        <td className="num" style={{ whiteSpace: 'nowrap' }}>
                          {canWrite && <button className="small primary" onClick={() => onReceive(i)} aria-label={`${i.name} received`}>Received</button>}{' '}
                          {canWrite && <button className="small" onClick={() => cancel(i)}>Cancel</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
