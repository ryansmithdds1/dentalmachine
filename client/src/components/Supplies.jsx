import { useState } from 'react';
import { api, downloadCsv, dollars } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money, fromCents, toCents, fmtUtcDateTime } from '../format.js';
import { ErrorBox, Modal, useSubmit } from './ui.jsx';

// To-do & labs → Supplies: stock on hand, deliveries, what procedures use up, counts and the reorder list.
export default function Supplies() {
  const { can } = useAuth();
  const { data, reload } = useApi('/inventory');
  const [modal, setModal] = useState(null);
  const [err, setErr] = useState(null);
  if (!data) return <div className="card">Loading…</div>;
  const w = can('schedule:write');
  const low = data.items.filter((i) => i.low);
  const move = async (item, reason) => {
    const q = window.prompt(`${reason === 'received' ? 'How many received' : 'How many used'} (${item.unit})?`, reason === 'received' ? String(item.reorder_qty || 1) : '1');
    if (!q) return;
    setErr(null);
    try { await api.post(`/inventory/${item.id}/moves`, { reason, quantity: Number(q) }); reload(); } catch (e) { setErr(e); }
  };
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>Supplies</h2>
          <div className="muted" style={{ fontSize: 13 }}>{data.items.filter((i) => i.active).length} items · {money(data.value)} on the shelf{low.length ? ` · ${low.length} to reorder` : ''}. Completed procedures use up the supplies set for their code.</div>
        </div>
        <div className="inline">
          <button onClick={() => setModal({ type: 'reorder' })}>Reorder list{low.length ? ` (${low.length})` : ''}</button>
          {w && <button onClick={() => setModal({ type: 'count' })}>Count…</button>}
          {w && <button className="primary" onClick={() => setModal({ type: 'item', item: { name: '', unit: 'each', on_hand: 0, reorder_at: 0, reorder_qty: 0, used_by: [] } })}>+ Item</button>}
        </div>
      </div>
      <ErrorBox error={err} />
      <table className="compact-table" style={{ marginTop: 10 }}>
        <thead><tr><th>Item</th><th className="num">On hand</th><th className="num">Reorder at</th><th>Supplier</th><th className="num">Cost</th><th>Used by</th><th /></tr></thead>
        <tbody>
          {data.items.map((i) => (
            <tr key={i.id} style={{ opacity: i.active ? 1 : 0.5 }}>
              <td>{i.name}{i.category && <div className="muted" style={{ fontSize: 11 }}>{i.category}{i.sku ? ` · ${i.sku}` : ''}</div>}</td>
              <td className="num">{i.on_hand} {i.unit}{i.low && <div><span className="badge warn">Reorder</span></div>}</td>
              <td className="num">{i.reorder_at || '—'}</td>
              <td>{i.supplier || '—'}</td>
              <td className="num">{i.cost != null ? money(i.cost) : '—'}</td>
              <td style={{ fontSize: 12 }}>{i.used_by.map((u) => `${u.code}${u.qty > 1 ? ` ×${u.qty}` : ''}`).join(', ') || '—'}</td>
              <td>
                <div className="inline" style={{ gap: 4 }}>
                  {w && <button className="small" onClick={() => move(i, 'received')}>Receive</button>}
                  {w && <button className="small" onClick={() => move(i, 'used')}>Use</button>}
                  <button className="small" onClick={() => setModal({ type: 'history', item: i })}>History</button>
                  {w && <button className="small" onClick={() => setModal({ type: 'item', item: i })}>Edit</button>}
                </div>
              </td>
            </tr>
          ))}
          {!data.items.length && <tr><td colSpan={7} className="muted">No supplies yet. Add the things you reorder regularly.</td></tr>}
        </tbody>
      </table>
      {modal?.type === 'item' && <ItemForm item={modal.item} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal?.type === 'count' && <CountForm items={data.items.filter((i) => i.active)} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal?.type === 'history' && <History item={modal.item} onClose={() => setModal(null)} />}
      {modal?.type === 'reorder' && <Reorder onClose={() => setModal(null)} />}
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
    window.alert(`${r.changed} item${r.changed === 1 ? '' : 's'} updated.`);
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

function Reorder({ onClose }) {
  const { data } = useApi('/inventory/reorder');
  return (
    <Modal title="Reorder list" onClose={onClose}>
      {data && (
        <>
          <table className="compact-table">
            <thead><tr><th>Item</th><th>Supplier</th><th className="num">On hand</th><th className="num">Order</th><th className="num">Est. cost</th></tr></thead>
            <tbody>
              {data.rows.map((i) => <tr key={i.id}><td>{i.name}{i.sku ? <span className="muted"> · {i.sku}</span> : ''}</td><td>{i.supplier || '—'}</td><td className="num">{i.on_hand}</td><td className="num">{i.order_qty} {i.unit}</td><td className="num">{i.cost != null ? money(i.cost * i.order_qty) : '—'}</td></tr>)}
              {!data.rows.length && <tr><td colSpan={5} className="muted">Nothing needs reordering.</td></tr>}
            </tbody>
          </table>
          <div className="form-actions">
            <span className="muted">Estimated {money(data.total)}</span>
            <button disabled={!data.rows.length} onClick={() => downloadCsv('reorder-list', data.rows, [['Item', (i) => i.name], ['SKU', (i) => i.sku || ''], ['Supplier', (i) => i.supplier || ''], ['On hand', (i) => i.on_hand], ['Order', (i) => i.order_qty], ['Unit', (i) => i.unit], ['Est. cost', (i) => (i.cost != null ? dollars(i.cost * i.order_qty) : '')]])}>⬇ CSV</button>
          </div>
        </>
      )}
    </Modal>
  );
}
