import { useState } from 'react';
import { EyeOff, Lock, Unlock, UserCheck, Plus, AlertTriangle } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDateTime, toCents, fromCents } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import DenominationCounter, { countTotal } from './DenominationCounter.jsx';

// Cash drawers: open with a float, close with a blind count (the expected amount only shows after the count is
// in), and a second person verifies the over/short with a reason.
export default function CashDrawers() {
  const { user } = useAuth();
  const { data, error, reload } = useApi('/cash/drawers');
  const [adding, setAdding] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="card muted">Loading drawers…</div>;
  return (
    <>
      {data.unassigned_cash_today > 0 && (
        <div className="dep-flag"><AlertTriangle size={16} />{data.unassigned_cash_today} cash payment{data.unassigned_cash_today === 1 ? ' was' : 's were'} taken today with no drawer open for {data.unassigned_cash_today === 1 ? 'it' : 'them'}. Open a drawer before taking cash.</div>
      )}
      <div className="drawers">
        {data.drawers.map((d) => <Drawer key={d.id} drawer={d} denominations={data.denominations} me={user} manager={data.manager} onChange={reload} />)}
        {!data.drawers.length && <div className="card muted">No cash drawers yet.{data.manager ? ' Add one for each desk that takes cash.' : ' Ask a manager to add one for your desk.'}</div>}
      </div>
      {data.manager && (adding ? <NewDrawer onDone={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />
        : <button type="button" style={{ marginTop: 16 }} onClick={() => setAdding(true)}><Plus size={16} /> Add a drawer</button>)}
    </>
  );
}

function NewDrawer({ onDone, onCancel }) {
  const [f, setF] = useState({ name: '', float: '100.00' });
  const [err, setErr] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    try {
      await api.post('/cash/drawers', { name: f.name, default_float: toCents(f.float) });
      toast('Drawer added');
      onDone();
    } catch (x) { setErr(x); }
  };
  return (
    <form className="card dep-form" style={{ maxWidth: 420, marginTop: 16 }} onSubmit={save}>
      <h3>New cash drawer</h3>
      <ErrorBox error={err} />
      <label>Name<input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Front desk 1" required /></label>
      <label>Usual starting float ($)<input inputMode="decimal" value={f.float} onChange={(e) => setF({ ...f, float: e.target.value })} /></label>
      <div className="dep-actions"><button className="primary" type="submit">Add drawer</button><button type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

function Drawer({ drawer, denominations, me, manager, onChange }) {
  const s = drawer.session;
  const [float, setFloat] = useState(fromCents(drawer.last?.float_kept ?? drawer.default_float));
  const [counts, setCounts] = useState({});
  const [counting, setCounting] = useState(false);
  const [v, setV] = useState({ reason: '', float_kept: '', recount: null });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn, msg) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      if (msg) toast(msg);
      onChange();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const open = () => run(() => api.post(`/cash/drawers/${drawer.id}/open`, { opening_float: toCents(float) }), `${drawer.name} opened with ${money(toCents(float))}`);
  const count = (e) => {
    e.preventDefault();
    run(async () => {
      const out = await api.post(`/cash/sessions/${s.id}/count`, { count: counts });
      setCounting(false);
      setCounts({});
      toast(out.over_short === 0 ? 'Count is in: the drawer is even' : `Count is in: the drawer is ${money(Math.abs(out.over_short))} ${out.over_short_label}`, { tone: out.over_short === 0 ? 'ok' : 'error' });
    });
  };
  const verify = (e) => {
    e.preventDefault();
    run(() => api.post(`/cash/sessions/${s.id}/verify`, {
      reason: v.reason || undefined, float_kept: v.float_kept === '' ? undefined : toCents(v.float_kept), recount: v.recount || undefined,
    }), 'Drawer verified and closed');
  };
  const diff = v.recount ? countTotal(denominations, v.recount) - (s?.expected_total ?? 0) : s?.over_short;

  return (
    <div className="card drawer-card">
      <h3>{drawer.name}<span className={`dep-chip ${!s ? '' : s.status === 'open' ? 'submitted' : 'warn'}`}>{!s ? 'Closed' : s.status === 'open' ? 'Open' : 'Waiting for verification'}</span></h3>
      <ErrorBox error={err} />
      {!s && (
        <>
          <div className="drawer-state">{drawer.last ? `Last closed ${fmtDateTime(drawer.last.closed_at?.slice(0, 16))} by ${drawer.last.verified_by_name}; ${money(drawer.last.float_kept)} left as the float.` : 'Not used yet.'}</div>
          <div className="dep-form">
            <label>Starting float ($)<input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} /></label>
            <button type="button" className="primary" disabled={busy} onClick={open}><Unlock size={16} /> Open drawer</button>
          </div>
        </>
      )}
      {s?.status === 'open' && (
        <>
          <div className="drawer-state">Opened {fmtDateTime(s.opened_at.slice(0, 16))} by {s.opened_by_name} with {money(s.opening_float)}.</div>
          {!counting ? <button type="button" className="primary" onClick={() => setCounting(true)}><Lock size={16} /> Close and count</button> : (
            <form onSubmit={count} className="dep-form">
              <div className="blind-note"><EyeOff size={16} />Blind count: count everything in the drawer, float included. You’ll see how it compares after you submit.</div>
              <DenominationCounter denominations={denominations} value={counts} onChange={setCounts} autoFocus idPrefix={`dr${drawer.id}`} />
              <div className="dep-big"><div className="line total"><span>Counted</span><strong>{money(countTotal(denominations, counts))}</strong></div></div>
              <div className="dep-actions"><button className="primary" type="submit" disabled={busy}>Submit count</button><button type="button" onClick={() => setCounting(false)}>Not yet</button></div>
            </form>
          )}
        </>
      )}
      {s?.status === 'counted' && (
        <>
          <div className="dep-big">
            <div className="line"><span>Counted by {s.counted_by_name}</span><strong>{money(s.counted_total)}</strong></div>
            <div className="line"><span>Expected (float + cash taken − paid out)</span><strong>{money(s.expected_total)}</strong></div>
            <div className="line"><span>{s.over_short === 0 ? 'Even' : s.over_short > 0 ? 'Over' : 'Short'}</span><strong className={s.over_short > 0 ? 'dep-over' : s.over_short < 0 ? 'dep-short' : ''}>{money(Math.abs(s.over_short))}</strong></div>
          </div>
          {!manager ? <p className="muted">A manager (not the person who counted) verifies the drawer.</p>
            : s.counted_by === me?.id ? <p className="muted">Someone other than you has to verify your count.</p> : (
              <form onSubmit={verify} className="dep-form" style={{ marginTop: 10 }}>
                {v.recount ? (
                  <>
                    <DenominationCounter denominations={denominations} value={v.recount} onChange={(r) => setV({ ...v, recount: r })} idPrefix={`rc${drawer.id}`} />
                    <div className="line">My count: <strong>{money(countTotal(denominations, v.recount))}</strong> ({diff === 0 ? 'even' : `${money(Math.abs(diff))} ${diff > 0 ? 'over' : 'short'}`})</div>
                  </>
                ) : <button type="button" onClick={() => setV({ ...v, recount: {} })}>I counted a different amount</button>}
                {diff !== 0 && <label>Why is it {diff > 0 ? 'over' : 'short'}?<input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} required /></label>}
                <label>Left in the drawer as tomorrow’s float ($)<input inputMode="decimal" placeholder={fromCents(Math.min(s.opening_float, v.recount ? countTotal(denominations, v.recount) : s.counted_total))} value={v.float_kept} onChange={(e) => setV({ ...v, float_kept: e.target.value })} /></label>
                <button className="primary" type="submit" disabled={busy}><UserCheck size={16} /> Verify and close</button>
              </form>
            )}
        </>
      )}
    </div>
  );
}
