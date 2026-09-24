import { useEffect, useMemo, useRef, useState } from 'react';
import { UserX, X, BarChart3 } from 'lucide-react';
import { api, download } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useLookup } from '../../hooks.js';
import { toast } from '../../toast.js';
import { fmtTime } from '../../format.js';
import { refreshCards } from './cardData.js';
import './cards.css';

// "Provider out today" (S8): a whole column at once. Each visit is kept with another provider who has room at that
// time (checked by the server like any booking) or rescheduled — patients we've already moved this year are kept
// first, so the ones asked to move are those with no recent strikes. Rescheduled patients get a warm apology text
// with a link to pick a new time (and the office's goodwill note), and a "Rebook" task so nobody is forgotten.
// Also the report of office-caused moves by reason and provider.
const REASONS = [['provider_sick', 'Provider sick'], ['emergency', 'Emergency'], ['double_booked', 'Double-booked'], ['equipment_down', 'Equipment down'], ['other', 'Other']];
const newKey = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function ProviderOut({ date: startDate, providerId: startProvider, onClose }) {
  const { can } = useAuth();
  const providers = useLookup('/providers?active=true');
  const [tab, setTab] = useState('out');
  const [providerId, setProviderId] = useState(startProvider ? String(startProvider) : '');
  const [date, setDate] = useState(startDate);
  const [reason, setReason] = useState('provider_sick');
  const [goodwill, setGoodwill] = useState('');
  const [texts, setTexts] = useState(true);
  const [plan, setPlan] = useState(null);
  const [choice, setChoice] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const box = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  useEffect(() => { if (!providerId && providers?.length) setProviderId(String(providers[0].id)); }, [providers, providerId]);
  useEffect(() => {
    setPlan(null);
    setResult(null);
    key.current = newKey();
    if (!providerId || !date) return;
    api.get(`/provider-out?provider_id=${providerId}&date=${date}`).then((p) => {
      setPlan(p);
      setChoice(Object.fromEntries(p.visits.map((v) => [v.appointment_id, v.suggestion === 'keep' ? `keep:${v.keep_with.id}` : 'reschedule'])));
    }).catch((err) => toast(err.message, { tone: 'error' }));
  }, [providerId, date]);
  const counts = useMemo(() => Object.values(choice).reduce((c, v) => ({ ...c, [v.split(':')[0]]: (c[v.split(':')[0]] || 0) + 1 }), {}), [choice]);
  const run = async () => {
    if (!plan || busy) return;
    setBusy(true);
    try {
      const visits = plan.visits.map((v) => {
        const [action, to] = (choice[v.appointment_id] || 'leave').split(':');
        return { appointment_id: v.appointment_id, action, ...(to ? { provider_id: Number(to) } : {}) };
      });
      const r = await api.post('/provider-out', { provider_id: Number(providerId), date, reason, goodwill_note: goodwill || null, send_texts: texts, client_key: key.current, visits });
      setResult(r);
      refreshCards();
      toast(`${r.kept} kept with another provider · ${r.rescheduled} to rebook${r.failed ? ` · ${r.failed} couldn’t be changed` : ''}`);
    } catch (err) { toast(err.message, { tone: 'error' }); } finally { setBusy(false); }
  };
  const w = can('schedule:write');
  return (
    <aside className="drawer po-panel" role="dialog" aria-label="Provider out today" ref={box}>
      <div className="drawer-head">
        <div className="seg">
          <button type="button" className={tab === 'out' ? 'active' : ''} onClick={() => setTab('out')}><UserX size={14} /> Provider out</button>
          {can('reports:read') && <button type="button" className={tab === 'report' ? 'active' : ''} onClick={() => setTab('report')}><BarChart3 size={14} /> Moves we caused</button>}
        </div>
        <button className="small" onClick={onClose} aria-label="Close"><X size={14} /></button>
      </div>
      <div className="drawer-body">
        {tab === 'out' ? (
          <>
            <div className="po-form">
              <label>Who’s out<select value={providerId} onChange={(e) => setProviderId(e.target.value)} aria-label="Provider">{(providers || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label>Day<input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Day" /></label>
              <label>Why<select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">{REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
              <label className="wide">Goodwill note (optional)<input value={goodwill} maxLength={200} onChange={(e) => setGoodwill(e.target.value)} placeholder="e.g. Your next cleaning is on us." aria-label="Goodwill note" /></label>
              <label className="checkbox wide"><input type="checkbox" checked={texts} onChange={(e) => setTexts(e.target.checked)} /> Text each patient (a warm apology with a link to pick a new time)</label>
            </div>
            {!plan && <div className="muted">Loading their visits…</div>}
            {plan && !plan.visits.length && <div className="empty">No visits booked with {plan.provider.name} that day.</div>}
            {plan?.visits.length > 0 && !result && (
              <>
                <p className="muted po-hint">Patients we’ve already moved this year are kept first; those with no recent moves are the ones asked to reschedule.</p>
                <ul className="po-list">
                  {plan.visits.map((v) => (
                    <li key={v.appointment_id} className={`po-visit ${(choice[v.appointment_id] || '').split(':')[0]}`}>
                      <span className="po-time">{fmtTime(v.start_time)}</span>
                      <span className="po-who"><strong>{v.name}</strong>{v.strikes ? <span className="cc-strike-badge" title={v.strike_list.map((m) => `${m.happened_on} · ${m.reason_label}`).join('\n')}>Moved by us {v.strikes}×</span> : null}<span className="muted"> {v.reason || ''}</span></span>
                      <select value={choice[v.appointment_id] || 'leave'} onChange={(e) => setChoice({ ...choice, [v.appointment_id]: e.target.value })} aria-label={`What happens to ${v.name}`}>
                        {v.options.map((o) => <option key={o.id} value={`keep:${o.id}`}>Keep with {o.name}</option>)}
                        <option value="reschedule">Reschedule (apology text)</option>
                        <option value="leave">Leave as is</option>
                      </select>
                    </li>
                  ))}
                </ul>
                <div className="drawer-actions">
                  <button type="button" className="primary" disabled={!w || busy} onClick={run}>{busy ? 'Working…' : `Do it — ${counts.keep || 0} kept, ${counts.reschedule || 0} rescheduled`}</button>
                </div>
              </>
            )}
            {result && (
              <div className="po-result" role="status">
                <strong>Done.</strong> {result.kept} kept · {result.rescheduled} to rebook{result.failed ? ` · ${result.failed} couldn’t be changed` : ''}
                <ul>
                  {result.results.map((r) => (
                    <li key={r.appointment_id}>{r.name || `Visit ${r.appointment_id}`}: {r.result === 'kept' ? `kept with ${r.provider}` : r.result === 'rescheduled' ? 'cancelled — rebook task added' : r.result}{r.message ? ` · text ${r.message.status}` : ''}{r.why ? ` (${r.why})` : ''}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : <MovesReport />}
      </div>
    </aside>
  );
}

function MovesReport() {
  const year = new Date().toISOString().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState(null);
  useEffect(() => { api.get(`/office-moves/report?from=${from}&to=${to}`).then(setData).catch((err) => toast(err.message, { tone: 'error' })); }, [from, to]);
  return (
    <div className="po-report">
      <div className="po-form">
        <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {!data ? <div className="muted">Loading…</div> : (
        <>
          <p><strong>{data.total}</strong> visit{data.total === 1 ? '' : 's'} moved, cancelled or handed over by the office.</p>
          {[['By reason', data.by_reason, (g) => g.label], ['By provider', data.by_provider, (g) => g.key]].map(([title, rows, name]) => (
            <table key={title} className="po-table">
              <thead><tr><th>{title}</th><th>Moved</th><th>Cancelled</th><th>Handed over</th><th>Patients</th></tr></thead>
              <tbody>{rows.map((g) => <tr key={g.key}><td>{name(g)}</td><td>{g.moves}</td><td>{g.cancels}</td><td>{g.reassigns}</td><td>{g.patients}</td></tr>)}</tbody>
            </table>
          ))}
          <button type="button" className="small" onClick={() => download(`/office-moves/report?from=${from}&to=${to}&format=csv`, `office-moves-${from}-to-${to}.csv`)}>Download CSV</button>
        </>
      )}
    </div>
  );
}
