import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { fmtDateTime } from '../format.js';
import { Badge, ErrorBox, Modal, useSubmit } from './ui.jsx';

// Settings → API & webhooks.
export default function Developer() {
  const { data: keys, reload: reloadKeys } = useApi('/api-keys');
  const { data: hooks, reload: reloadHooks } = useApi('/webhooks');
  const [newKey, setNewKey] = useState(null);
  const [shown, setShown] = useState(null);
  const [newHook, setNewHook] = useState(null);
  const [err, setErr] = useState(null);
  const run = async (fn) => { setErr(null); try { await fn(); } catch (e) { setErr(e); } };
  if (!keys || !hooks) return <div className="card">Loading…</div>;
  return (
    <>
      <div className="card">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>API keys</h2>
            <div className="muted" style={{ fontSize: 13 }}>For your website, reminder or marketing service, or your own tools. Requests go to <code>{window.location.origin}/api/v1</code> with <code>Authorization: Bearer &lt;key&gt;</code>. Give each key only the access it needs.</div>
          </div>
          <button className="primary" onClick={() => setNewKey({ name: '', scopes: ['appointments:read'] })}>+ Key</button>
        </div>
        <ErrorBox error={err} />
        {shown && (
          <div className="public-notice ok" style={{ marginTop: 10 }}>
            Copy this key now — it won’t be shown again:<div style={{ fontFamily: 'monospace', wordBreak: 'break-all', marginTop: 4 }}>{shown}</div>
          </div>
        )}
        <table style={{ marginTop: 10 }}>
          <thead><tr><th>Name</th><th>Key</th><th>Access</th><th>Last used</th><th /></tr></thead>
          <tbody>
            {keys.keys.map((k) => (
              <tr key={k.id} style={{ opacity: k.revoked_at ? 0.5 : 1 }}>
                <td>{k.name}</td><td><code>{k.prefix}…</code></td>
                <td style={{ fontSize: 12 }}>{k.scopes.map((s) => keys.scopes[s]).join(', ')}</td>
                <td>{k.revoked_at ? 'Revoked' : k.last_used_at ? fmtDateTime(k.last_used_at) : 'Never'}</td>
                <td>{!k.revoked_at && <button className="small danger" onClick={() => window.confirm(`Revoke “${k.name}”? Anything using it stops working.`) && run(async () => { await api.del(`/api-keys/${k.id}`); reloadKeys(); })}>Revoke</button>}</td>
              </tr>
            ))}
            {!keys.keys.length && <tr><td colSpan={5} className="muted">No keys yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>Webhooks</h2>
            <div className="muted" style={{ fontSize: 13 }}>We POST a JSON event to your URL when something happens, signed in the <code>DM-Signature</code> header (<code>t=…,v1=</code>HMAC-SHA256 of <code>t.body</code> with the endpoint’s secret). Failed deliveries are retried for about a day.</div>
          </div>
          <button className="primary" onClick={() => setNewHook({ url: 'https://', events: ['appointment.created', 'appointment.cancelled'] })}>+ Endpoint</button>
        </div>
        {hooks.endpoints.map((e) => (
          <div key={e.id} className="inline" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
            <div>
              <strong style={{ wordBreak: 'break-all' }}>{e.url}</strong> {!e.active && <Badge value="paused" />}
              <div className="muted" style={{ fontSize: 12 }}>{e.events.join(', ')} · secret {e.secret_hint}{e.failures ? ` · ${e.failures} recent failures` : ''}</div>
            </div>
            <div className="inline" style={{ gap: 6 }}>
              <button className="small" onClick={() => run(async () => { const r = await api.post(`/webhooks/${e.id}/test`); window.alert(r.status === 'delivered' ? `Delivered (HTTP ${r.response_code})` : `Failed: ${r.last_error}`); reloadHooks(); })}>Send test</button>
              <button className="small" onClick={() => run(async () => { await api.put(`/webhooks/${e.id}`, { active: !e.active }); reloadHooks(); })}>{e.active ? 'Pause' : 'Resume'}</button>
              <button className="small danger" onClick={() => window.confirm('Delete this endpoint?') && run(async () => { await api.del(`/webhooks/${e.id}`); reloadHooks(); })}>Delete</button>
            </div>
          </div>
        ))}
        {!hooks.endpoints.length && <div className="muted" style={{ marginTop: 8 }}>No endpoints yet.</div>}
        {hooks.deliveries.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary>Recent deliveries</summary>
            <table className="compact-table">
              <thead><tr><th>When</th><th>Event</th><th>Status</th><th>Tries</th><th>Result</th></tr></thead>
              <tbody>{hooks.deliveries.map((d) => <tr key={d.id}><td>{fmtDateTime(d.created_at)}</td><td>{d.event}</td><td><Badge value={d.status} /></td><td>{d.attempts}</td><td>{d.response_code || ''} {d.last_error || ''}</td></tr>)}</tbody>
            </table>
          </details>
        )}
      </div>

      {newKey && <KeyForm meta={keys} init={newKey} onClose={() => setNewKey(null)} onDone={(k) => { setNewKey(null); setShown(k.key); reloadKeys(); }} />}
      {newHook && <HookForm events={hooks.events} init={newHook} onClose={() => setNewHook(null)} onDone={(h) => { setNewHook(null); setShown(null); window.alert(`Endpoint added. Its signing secret (shown once):\n\n${h.secret}`); reloadHooks(); }} />}
    </>
  );
}

function KeyForm({ meta, init, onClose, onDone }) {
  const [f, setF] = useState(init);
  const { submit, busy, error } = useSubmit(async () => onDone(await api.post('/api-keys', f)));
  return (
    <Modal title="New API key" onClose={onClose}>
      <ErrorBox error={error} />
      <label>What it’s for<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Practice website" /></label>
      {Object.entries(meta.scopes).map(([k, l]) => (
        <label key={k} className="checkbox" style={{ margin: '4px 0' }}><input type="checkbox" checked={f.scopes.includes(k)} onChange={(e) => setF({ ...f, scopes: e.target.checked ? [...f.scopes, k] : f.scopes.filter((x) => x !== k) })} /> {l}</label>
      ))}
      <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !f.name || !f.scopes.length} onClick={submit}>Create key</button></div>
    </Modal>
  );
}

function HookForm({ events, init, onClose, onDone }) {
  const [f, setF] = useState(init);
  const { submit, busy, error } = useSubmit(async () => onDone(await api.post('/webhooks', f)));
  return (
    <Modal title="New webhook endpoint" onClose={onClose}>
      <ErrorBox error={error} />
      <label>URL (https)<input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></label>
      {events.map((ev) => (
        <label key={ev} className="checkbox" style={{ margin: '4px 0' }}><input type="checkbox" checked={f.events.includes(ev)} onChange={(e) => setF({ ...f, events: e.target.checked ? [...f.events, ev] : f.events.filter((x) => x !== ev) })} /> <code>{ev}</code></label>
      ))}
      <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !f.events.length} onClick={submit}>Add endpoint</button></div>
    </Modal>
  );
}
