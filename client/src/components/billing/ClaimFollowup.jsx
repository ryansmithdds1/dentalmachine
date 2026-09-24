import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadCsv, dollars } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, fmtUtcDate } from '../../format.js';
import { Badge, ErrorBox, MoreRows } from '../ui.jsx';
import { CALL_OUTCOMES } from '../ClaimEdi.jsx';
import { useShortcuts } from '../../shortcuts.js';
import { toast } from '../../toast.js';
import '../../pages/monthly.css';

// When to call again after each answer, in days (the person can change it).
export const NEXT_CALL_DAYS = { in_process: 14, paid: 10, denied: 3, need_info: 7, not_on_file: 3, resubmit: 7, pending_patient: 14, other: 14 };
const OUTCOMES = Object.entries(CALL_OUTCOMES);
const inDays = (n) => new Date(Date.now() + n * 86400_000).toLocaleDateString('en-CA');
const lastContact = (carrierName) => { try { return localStorage.getItem(`dm.followup.contact:${carrierName}`) || ''; } catch { return ''; } };
const rememberContact = (carrierName, v) => { try { if (v) localStorage.setItem(`dm.followup.contact:${carrierName}`, v); } catch { /* per-viewer convenience only */ } };

// Billing → Insurance follow-up (workflow 45, docs/workflows/specs/45-claim-follow-up.md): the claims due a
// call come first; J/K move, L (or Enter) opens the call panel beside the list, a digit picks what the payer
// said, the cursor lands in the reference box and Enter saves and moves on to the next claim.
export default function ClaimFollowup() {
  const { can, practice } = useAuth();
  const [carrier, setCarrier] = useState('');
  const [limit, setLimit] = useState(500);
  const [only, setOnly] = useState(null); // null until the first load decides: due calls when there are any.
  const [at, setAt] = useState(0);
  const [panel, setPanel] = useState(false);
  const [checking, setChecking] = useState(null);
  const { data, reload } = useApi(`/reports/outstanding-claims?limit=${limit}${carrier ? `&carrier_id=${carrier}` : ''}`);
  const carriers = useLookup('/carriers');
  const rowRefs = useRef([]);
  const dueOnly = only ?? (data ? data.due_count > 0 : true);
  const rows = (data?.rows || []).filter((c) => !dueOnly || c.due);
  const cur = rows[Math.min(at, rows.length - 1)] || null;
  const w = can('billing:write');
  useEffect(() => { rowRefs.current[at]?.scrollIntoView?.({ block: 'nearest' }); }, [at]);

  const move = (d) => setAt((i) => Math.max(0, Math.min(rows.length - 1, i + d)));
  const statusCheck = async (c) => {
    if (!c) return;
    setChecking(c.id);
    try {
      const r = await api.post(`/claims/${c.id}/status-check`, {});
      toast(`Claim #${c.id}: ${r.text || r.status}${r.sandbox ? ' (sandbox)' : ''}`);
      reload();
    } catch (e) {
      toast(`Couldn’t check claim #${c.id}: ${e.message}`, { tone: 'error' });
    } finally {
      setChecking(null);
    }
  };
  useShortcuts([
    { combo: 'j', handler: () => move(1), label: 'Next claim', section: 'Insurance follow-up' },
    { combo: 'k', handler: () => move(-1), label: 'Previous claim', section: 'Insurance follow-up' },
    { combo: 'l', handler: () => setPanel(true), label: 'Log a call about the claim', section: 'Insurance follow-up', enabled: w && !!cur },
    { combo: 'enter', handler: () => setPanel(true), label: 'Log a call about the claim', section: 'Insurance follow-up', enabled: w && !!cur && !panel },
    { combo: 's', handler: () => statusCheck(cur), label: 'Check the claim’s status with the payer', section: 'Insurance follow-up', enabled: !!cur && !panel },
    { combo: 'escape', handler: () => setPanel(false), label: 'Close the call panel', section: 'Insurance follow-up', enabled: panel, inInputs: true },
  ]);

  if (!data) return <div className="empty">Loading…</div>;
  const B = [['d0_30', '0–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['d90_plus', '90+ days']];
  const saved = (claim, next) => {
    toast(`Call logged for claim #${claim.id}${next ? ` · follow up ${fmtDate(next)}` : ''}`);
    reload();
    // The list reloads without this claim among the due ones, so the same position is the next claim.
    if (!dueOnly) move(1);
  };
  return (
    <div className={panel && cur ? 'wl-with-panel' : ''}>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {B.map(([k, l]) => <div key={k} className={`card stat${k === 'd90_plus' && data.totals[k] ? ' stat-danger' : k === 'd61_90' && data.totals[k] ? ' stat-warn' : ''}`}><div className="label">{l}</div><div className="value">{money(data.totals[k])}</div><div className="sub">expected from insurance</div></div>)}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="inline no-print" style={{ justifyContent: 'space-between', padding: '10px 16px 0', flexWrap: 'wrap', gap: 8 }}>
          <div className="seg" role="tablist" aria-label="Which claims">
            <button role="tab" aria-selected={dueOnly} className={dueOnly ? 'active' : ''} onClick={() => { setOnly(true); setAt(0); }}>Due for a call ({data.due_count})</button>
            <button role="tab" aria-selected={!dueOnly} className={!dueOnly ? 'active' : ''} onClick={() => { setOnly(false); setAt(0); }}>All waiting ({data.total_rows})</button>
          </div>
          <div className="inline">
            <span className="muted" style={{ fontSize: 12 }}><kbd>J</kbd>/<kbd>K</kbd> move · <kbd>L</kbd> log a call · <kbd>S</kbd> check status</span>
            <select value={carrier} onChange={(e) => { setCarrier(e.target.value); setAt(0); }} aria-label="Payer">
              <option value="">All payers</option>
              {carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="small" disabled={!rows.length} onClick={() => downloadCsv('outstanding-claims', rows, [['Claim #', (c) => c.id], ['Patient', (c) => `${c.first_name} ${c.last_name}`], ['Carrier', (c) => c.carrier_name], ['Carrier phone', (c) => c.carrier_phone || ''], ['Submitted', (c) => c.submitted_at || ''], ['Days out', (c) => c.days_out], ['Expected', (c) => dollars(c.estimated_amount - c.paid_amount)], ['Status', (c) => c.status], ['Follow up', (c) => c.follow_up_date || '']])}>⬇ CSV</button>
            <button className="small" onClick={() => window.print()}>Print / PDF</button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Claim</th><th>Patient</th><th>Carrier</th><th>Submitted</th><th className="num">Days out</th><th className="num">Expected</th><th>Status</th><th>Last call</th><th className="no-print" /></tr></thead>
            <tbody>
              {rows.map((c, i) => (
                <tr key={c.id} ref={(el) => { rowRefs.current[i] = el; }} aria-selected={c === cur} className={`wl-row${c === cur ? ' current' : ''}`} onClick={() => setAt(i)}>
                  <td><Link to={`/claims/${c.id}`}>#{c.id}</Link></td>
                  <td><Link to={`/patients/${c.patient_id}`}>{c.first_name} {c.last_name}</Link></td>
                  <td>{c.carrier_name}{c.carrier_phone ? <div className="muted"><a href={`tel:${c.carrier_phone}`}>{c.carrier_phone}</a></div> : null}</td>
                  <td>{fmtUtcDate(c.submitted_at, practice?.timezone)}</td>
                  <td className="num" style={{ color: c.days_out > 60 ? 'var(--danger)' : c.days_out > 30 ? 'var(--warn)' : undefined, fontWeight: c.days_out > 30 ? 700 : 400 }}>{c.days_out}</td>
                  <td className="num">{money(c.estimated_amount - c.paid_amount)}</td>
                  <td><Badge value={c.status} /></td>
                  <td style={{ fontSize: 13 }}>
                    {c.last_call_at ? <>{CALL_OUTCOMES[c.last_call_outcome] || c.last_call_outcome} <span className="muted">· {fmtUtcDate(c.last_call_at, practice?.timezone)}</span></> : <span className="muted">—</span>}
                    {c.follow_up_date && <div className={c.due ? 'text-danger' : 'muted'}>Follow up {fmtDate(c.follow_up_date)}</div>}
                  </td>
                  <td className="no-print" style={{ whiteSpace: 'nowrap' }}>
                    {w && <button className="small" onClick={(e) => { e.stopPropagation(); setAt(i); setPanel(true); }}>Log call</button>}{' '}
                    <button className="small" disabled={checking === c.id} onClick={(e) => { e.stopPropagation(); statusCheck(c); }}>{checking === c.id ? 'Asking…' : 'Status'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty">{dueOnly ? 'No calls due today. 🎉' : 'No outstanding claims. 🎉'}</div>}
          <MoreRows shown={data.rows.length} total={data.total_rows} step={500} onMore={(n) => setLimit(limit + n)} />
        </div>
      </div>
      {panel && cur && <CallPanel key={cur.id} claim={cur} left={rows.length} onClose={() => setPanel(false)} onSaved={saved} />}
    </div>
  );
}

// The call, beside the list (no dialog): what they said (a digit), who and the reference (remembered per payer),
// and when to call again (set by the answer). Enter saves.
function CallPanel({ claim, left, onClose, onSaved }) {
  const [form, setForm] = useState({ outcome: '', contact: lastContact(claim.carrier_name), reference: '', note: '', follow_up_date: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const refBox = useRef(null);
  const panelRef = useRef(null);
  useEffect(() => { panelRef.current?.focus(); }, []);
  const pick = (outcome) => {
    setForm((f) => ({ ...f, outcome, follow_up_date: inDays(NEXT_CALL_DAYS[outcome] ?? 14) }));
    setTimeout(() => refBox.current?.focus(), 0);
  };
  useShortcuts(OUTCOMES.map(([k, l], i) => ({ combo: String(i + 1), handler: () => pick(k), label: `Payer said: ${l}`, section: 'Insurance follow-up' })));
  const save = async (e) => {
    e?.preventDefault();
    if (!form.outcome) { setErr(new Error('Pick what the payer said (1–8)')); return; }
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/claims/${claim.id}/calls`, form);
      rememberContact(claim.carrier_name, form.contact.trim());
      onSaved(claim, form.follow_up_date);
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="drawer wl-drawer" role="dialog" aria-label={`Call about claim #${claim.id}`} tabIndex={-1} ref={panelRef}>
      <div className="drawer-head">
        <div>
          <strong>Call about claim #{claim.id}</strong>
          <div className="muted" style={{ fontSize: 13 }}>{claim.first_name} {claim.last_name} · {claim.carrier_name}{claim.carrier_phone ? <> · <a href={`tel:${claim.carrier_phone}`}>{claim.carrier_phone}</a></> : null}</div>
          <div className="muted" style={{ fontSize: 13 }}>{money(claim.estimated_amount - claim.paid_amount)} expected · out {claim.days_out} days{left > 1 ? ` · ${left - 1} more after this` : ''}</div>
        </div>
        <button className="small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <form className="drawer-body" onSubmit={save}>
        <ErrorBox error={err} />
        <div className="wl-outcomes" role="radiogroup" aria-label="What the payer said">
          {OUTCOMES.map(([k, l], i) => (
            <button type="button" key={k} role="radio" aria-checked={form.outcome === k} className={form.outcome === k ? 'active' : ''} onClick={() => pick(k)}>
              <kbd>{i + 1}</kbd> {l}
            </button>
          ))}
        </div>
        <label>Call reference #<input ref={refBox} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} aria-label="Call reference #" /></label>
        <label>Spoke with<input value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} placeholder="Rep's name" /></label>
        <label>Notes<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. needs x-ray and narrative; reprocessing in 10 days" /></label>
        <label>Call again on<input type="date" value={form.follow_up_date} onChange={(e) => setForm({ ...form, follow_up_date: e.target.value })} /></label>
        <div className="form-actions">
          <button type="button" onClick={onClose}>Close</button>
          <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save call ↵'}</button>
        </div>
      </form>
    </aside>
  );
}
