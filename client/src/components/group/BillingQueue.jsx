import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, ExternalLink, UserCheck } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useShortcuts } from '../../shortcuts.js';
import { money, label } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';

// The group's central billing queue: one fast table across every practice. J/K move, X ticks, Enter opens the
// item in its practice (only where you're signed in — elsewhere it's read-only), M assigns to you.
export const QUEUE_ORDER = ['outstanding', 'denied', 'unsent', 'era', 'credits'];
const AGES = [[0, 'Any age'], [31, '31+ days'], [61, '61+ days'], [91, '91+ days']];
const ageClass = (d) => (d > 90 ? 'grp-age a90' : d > 60 ? 'grp-age a60' : 'grp-age');

export default function BillingQueue({ org, summary, onChanged, initialQueue = 'outstanding', initialPractice = '' }) {
  const navigate = useNavigate();
  const [queue, setQueue] = useState(initialQueue);
  const [practice, setPractice] = useState(initialPractice);
  const [assigned, setAssigned] = useState('all');
  const [minAge, setMinAge] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState(() => new Set());
  const [note, setNote] = useState(null);
  const [to, setTo] = useState('');
  useEffect(() => { setQueue(initialQueue); }, [initialQueue]);
  useEffect(() => { setPractice(initialPractice); }, [initialPractice]);
  const q = `/org/billing/queue?queue=${queue}&assigned=${assigned}&limit=2000${practice ? `&practice_id=${practice}` : ''}${minAge ? `&min_age=${minAge}` : ''}`;
  const { data, error, reload } = useApi(q);
  const { data: team } = useApi('/org/billing/team');
  const rows = useMemo(() => data?.rows || [], [data]);
  const body = useRef(null);
  useEffect(() => { setCursor(0); setPicked(new Set()); setNote(null); }, [q]);
  useEffect(() => {
    body.current?.querySelector('tr.cursor')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const assign = useSubmit(async (keys, userId) => {
    if (!keys.length) return;
    await api.post('/org/billing/assign', { keys, user_id: userId });
    setPicked(new Set());
    await reload();
    onChanged?.();
  });
  const open = (r) => {
    if (!r) return;
    if (r.link) navigate(r.link);
    else setNote(`${r.practice}: sign in at that practice to work this ${r.queue === 'credits' ? 'account' : 'item'} — from here it’s read-only.`);
  };
  const toggle = (key) => setPicked((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const current = rows[cursor];
  const selection = picked.size ? [...picked] : current ? [current.key] : [];
  useShortcuts([
    { combo: 'j', label: 'Next item', section: 'Billing queue', handler: () => setCursor((c) => Math.min(rows.length - 1, c + 1)) },
    { combo: 'k', label: 'Previous item', section: 'Billing queue', handler: () => setCursor((c) => Math.max(0, c - 1)) },
    { combo: 'enter', label: 'Open in its practice', section: 'Billing queue', handler: () => open(current), enabled: !!current },
    { combo: 'x', label: 'Tick / untick', section: 'Billing queue', handler: () => current && toggle(current.key), enabled: !!current },
    { combo: 'm', label: 'Assign ticked (or this) to me', section: 'Billing queue', handler: () => assign.submit(selection, org.me), enabled: !!current },
  ]);

  const count = (k) => summary?.totals?.queues?.[k]?.count;
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.key));
  return (
    <div>
      <div className="grp-toolbar">
        <div className="seg" role="tablist" aria-label="Queue">
          {QUEUE_ORDER.map((k) => (
            <button key={k} role="tab" aria-selected={queue === k} className={queue === k ? 'active' : ''} onClick={() => setQueue(k)}>
              {summary?.queues?.[k] || label(k)}{count(k) != null && <span className="grp-seg-count">{count(k)}</span>}
            </button>
          ))}
        </div>
        <select aria-label="Practice" value={practice} onChange={(e) => setPractice(e.target.value)}>
          <option value="">All practices</option>
          {org.practices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select aria-label="Assigned" value={assigned} onChange={(e) => setAssigned(e.target.value)}>
          <option value="all">Everyone’s</option><option value="me">Mine</option><option value="unassigned">Unassigned</option>
        </select>
        <select aria-label="Age" value={minAge} onChange={(e) => setMinAge(Number(e.target.value))}>
          {AGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span className="spacer" />
        {data && <span className="muted" style={{ fontSize: 13 }}>{data.total} item{data.total === 1 ? '' : 's'} · {money(data.amount)}</span>}
      </div>
      <ErrorBox error={error || assign.error} />
      {note && <div className="grp-note"><Lock size={13} /> {note}</div>}
      <div className="card" style={{ padding: 0 }}>
        {picked.size > 0 && (
          <div className="grp-bulk">
            <strong>{picked.size} ticked</strong>
            <button className="small" disabled={assign.busy} onClick={() => assign.submit([...picked], org.me)}><UserCheck size={14} /> Assign to me</button>
            <select aria-label="Teammate" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose a teammate…</option>
              {(team || []).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.practice}</option>)}
            </select>
            <button className="small" disabled={!to || assign.busy} onClick={() => assign.submit([...picked], Number(to))}>Assign</button>
            <button className="small" disabled={assign.busy} onClick={() => assign.submit([...picked], null)}>Unassign</button>
            <button className="small link" onClick={() => setPicked(new Set())}>Clear</button>
          </div>
        )}
        <div className="grp-queue table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 28 }}><input type="checkbox" aria-label="Tick all" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.key)))} /></th>
                <th>Practice</th><th>Patient</th><th className="num">Amount</th><th className="num">Age</th><th>Details</th><th>Working it</th><th />
              </tr>
            </thead>
            <tbody ref={body}>
              {!data && !error && <tr><td colSpan={8} className="muted">Loading…</td></tr>}
              {data && rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ padding: 24, textAlign: 'center' }}>Nothing here — this queue is clear.</td></tr>}
              {rows.map((r, i) => (
                <tr key={r.key} className={`${i === cursor ? 'cursor' : ''}${r.can_open ? '' : ' readonly'}`} onClick={() => setCursor(i)} onDoubleClick={() => open(r)} aria-selected={i === cursor}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Tick ${r.patient || r.key}`} checked={picked.has(r.key)} onChange={() => toggle(r.key)} /></td>
                  <td>{r.practice}</td>
                  <td>{r.patient || <span className="muted">Not matched</span>}</td>
                  <td className="num">{money(r.amount)}</td>
                  <td className="num"><span className={ageClass(r.age_days ?? 0)} title={r.since ? `Since ${r.since}` : ''}>{r.age_days ?? '—'}d</span></td>
                  <td className="muted" style={{ maxWidth: 340 }}>{r.detail}</td>
                  <td>{r.assigned_name || <span className="muted">—</span>}</td>
                  <td>
                    {r.can_open
                      ? <button className="small" onClick={(e) => { e.stopPropagation(); open(r); }} title="Open in this practice"><ExternalLink size={13} /> Open</button>
                      : <span className="muted" title={`Read-only: sign in at ${r.practice} to work this`}><Lock size={13} /></span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="grp-hint"><span><kbd>J</kbd>/<kbd>K</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>X</kbd> tick</span><span><kbd>M</kbd> assign to me</span><span><Lock size={11} /> read-only: at a practice you’re not signed in to</span></div>
    </div>
  );
}
