import { useState } from 'react';
import { CalendarClock, ShieldCheck, Pencil, Upload, X } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { toast } from '../toast.js';
import { fmtDate } from '../format.js';
import './recallfreq.css';

// A patient's recalls at a glance (RF3, docs/workflows/specs/RF-recall-frequencies.md): each type's last visit
// (and where), due date, status — current / due soon / due / overdue / booked with the date — and when their
// insurance pays for it again ("BWX due Mar 3 · insurance pays from Apr 12"). Nothing to click to see it.
// Clinical staff can give a patient their own interval (with a reason), switch prophy ↔ perio maintenance, and
// enter x-rays taken at another office; each opens inline, never in a stacked dialog.
// <RecallPanel patientId={id} /> (heading={false} inside a card that already says "Recall").
const TONE = { current: 'ok', due_soon: 'warn', due: 'info', overdue: 'danger', scheduled: 'ok', none: '', retired: '' };
const XRAYS = [['bwx', 'Bitewings'], ['fmx', 'Full-mouth series or pano']];

export default function RecallPanel({ patientId, compact = false, heading = true }) {
  const { can } = useAuth();
  const { data, error, reload } = useApi(patientId ? `/patients/${patientId}/recall-status` : null);
  const [open, setOpen] = useState(null); // { kind: 'interval' | 'switch' | 'outside', item }
  const [showRetired, setShowRetired] = useState(false);
  if (error?.status === 404) return null;
  if (error) return <div className="rf-panel muted">Recall status couldn&apos;t load: {error.message}</div>;
  if (!data) return <div className="rf-panel muted">Loading recall…</div>;
  const clinical = can('clinical:write');
  const live = data.items.filter((i) => i.status !== 'retired');
  const retired = data.items.filter((i) => i.status === 'retired');
  const cleaning = live.find((i) => ['prophy', 'child_prophy', 'perio_maint'].includes(i.type) && i.recall_id);

  return (
    <div className="rf-panel" aria-label="Recall status">
      <div className="rf-head">
        {heading && <span className="rf-title"><CalendarClock size={16} /> Recall</span>}
        {data.insurance && <span className="muted rf-ins"><ShieldCheck size={13} /> {data.insurance.carrier}</span>}
        {data.next_visit && <span className="muted">Next visit {fmtDate(data.next_visit.start_time)}</span>}
      </div>
      {live.length === 0 && <div className="muted">Nothing on recall. Completing a cleaning starts one.</div>}
      <ul className="rf-list">
        {live.map((i) => (
          <li key={i.type} className={`rf-item rf-${i.status}`} data-type={i.type}>
            <div className="rf-line">
              <strong className="rf-name">{i.short}</strong>
              <span className={`badge ${TONE[i.status]}`}>{i.status === 'scheduled' && i.scheduled ? `Booked ${fmtDate(i.scheduled.start_time)}` : i.status_label}</span>
              {/* The badge already says "No record"; the due date only when there is one. */}
              {i.due_date && <span className="rf-due">{`${i.status === 'overdue' || i.status === 'due' ? 'was due' : 'due'} ${fmtDate(i.due_date)}`}</span>}
            </div>
            {!compact && (
              <div className="rf-sub muted">
                {i.last_done ? <>Last {fmtDate(i.last_done.date)} · {i.last_done.code}{i.last_done.source === 'outside' ? ` · at ${i.last_done.where}` : i.last_done.where && i.last_done.where !== 'here' ? ` · ${i.last_done.where}` : ''}</> : 'Not done here yet'}
                {' · every '}{i.interval_months} mo{i.interval_overridden && <span title={i.interval_reason || ''}> (own interval{i.interval_reason ? `: ${i.interval_reason}` : ''})</span>}
                {i.insurance?.rule && <> · <span title="The plan's frequency limit">{i.insurance.rule}</span></>}
                {i.insurance && (i.insurance.eligible_on > data.date || !i.insurance.pays) && <> · <span className="rf-ins-warn">{i.insurance.label}</span></>}
              </div>
            )}
            {clinical && !compact && i.recall_id && (
              <button type="button" className="link rf-act" onClick={() => setOpen({ kind: 'interval', item: i })} aria-label={`Change ${i.short} interval`}><Pencil size={12} /></button>
            )}
          </li>
        ))}
      </ul>
      {clinical && !compact && !open && (
        <div className="rf-actions">
          {cleaning && <button type="button" className="small" onClick={() => setOpen({ kind: 'switch', item: cleaning })}>{cleaning.type === 'perio_maint' ? 'Back to prophy' : 'Switch to perio maintenance'}</button>}
          <button type="button" className="small" onClick={() => setOpen({ kind: 'outside' })}><Upload size={12} /> X-rays taken elsewhere</button>
        </div>
      )}
      {open?.kind === 'interval' && <IntervalForm item={open.item} onDone={() => { setOpen(null); reload(); }} />}
      {open?.kind === 'switch' && <SwitchForm patientId={patientId} from={open.item} onDone={() => { setOpen(null); reload(); }} />}
      {open?.kind === 'outside' && <OutsideForm patientId={patientId} today={data.date} onDone={() => { setOpen(null); reload(); }} />}
      {retired.length > 0 && !compact && (
        <div className="rf-retired">
          <button type="button" className="link" onClick={() => setShowRetired(!showRetired)}>{showRetired ? 'Hide' : 'Show'} {retired.length} retired</button>
          {showRetired && retired.map((i) => <div key={i.type} className="muted">{i.short}: {i.status_reason || 'retired'}</div>)}
        </div>
      )}
    </div>
  );
}

function Inline({ title, children, onClose, onSubmit, busy }) {
  return (
    <form className="rf-inline" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <div className="rf-inline-head"><strong>{title}</strong><button type="button" className="link" aria-label="Close" onClick={onClose}><X size={14} /></button></div>
      {children}
      <div className="form-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form>
  );
}

function useSave(fn, onDone) {
  const [busy, setBusy] = useState(false);
  return [busy, async () => {
    setBusy(true);
    try {
      const msg = await fn();
      toast(msg);
      onDone();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }];
}

// The usual intervals and reasons are one click each (A097): pick the months, then the reason — that saves.
// Another number or reason can still be typed (Save).
const MONTHS = [3, 4, 6, 12];
const REASONS = ['Perio history', 'High caries risk', 'Stable — longer is fine', 'Alternates with periodontist', 'Patient’s request'];
function IntervalForm({ item, onDone }) {
  const [months, setMonths] = useState(String(item.interval_months));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const saveWith = async (m, why) => {
    if (!(Number(m) >= 1 && Number(m) <= 120)) { toast('Choose 1–120 months', { tone: 'error' }); return; }
    if (String(why || '').trim().length < 3) { toast('Say why (e.g. perio history)', { tone: 'error' }); return; }
    setBusy(true);
    try {
      const back = Number(m) === item.type_interval_months;
      await api.put(`/recalls/${item.recall_id}/interval`, { interval_months: back ? null : Number(m), reason: why });
      toast(`${item.short} every ${m} months`);
      onDone();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Inline title={`${item.short}: this patient's interval`} onClose={onDone} onSubmit={() => saveWith(months, reason)} busy={busy}>
      <div className="chips" role="radiogroup" aria-label="Every">
        {MONTHS.map((m) => (
          <button type="button" key={m} role="radio" aria-checked={Number(months) === m} className={`chip${Number(months) === m ? ' active' : ''}`} onClick={() => setMonths(String(m))}>
            {m} mo{m === item.type_interval_months ? ' (standard)' : ''}
          </button>
        ))}
        <label className="inline" style={{ gap: 4 }}>other <input type="number" min="1" max="120" value={months} onChange={(e) => setMonths(e.target.value)} style={{ width: 64 }} aria-label="Every how many months" /></label>
      </div>
      <div className="chips" aria-label="Why">
        {REASONS.map((r) => <button type="button" key={r} className="chip" disabled={busy} onClick={() => saveWith(months, r)} title="Saves with this reason">{r}</button>)}
      </div>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Or type why — e.g. stable perio, alternates with periodontist" aria-label="Reason" minLength={3} />
    </Inline>
  );
}

function SwitchForm({ patientId, from, onDone }) {
  const to = from.type === 'perio_maint' ? 'prophy' : 'perio_maint';
  const [reason, setReason] = useState('');
  const [busy, save] = useSave(async () => {
    await api.post(`/patients/${patientId}/recalls/switch`, { to, reason });
    return to === 'perio_maint' ? 'Switched to perio maintenance; the prophy recall is retired' : 'Back to prophy';
  }, onDone);
  return (
    <Inline title={to === 'perio_maint' ? 'Switch to perio maintenance' : 'Back to prophy'} onClose={onDone} onSubmit={save} busy={busy}>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (required) — e.g. SRP completed, 5 mm pockets" aria-label="Reason" required minLength={3} autoFocus />
    </Inline>
  );
}

function OutsideForm({ patientId, today, onDone }) {
  const [type, setType] = useState('bwx');
  const [date, setDate] = useState(today);
  const [office, setOffice] = useState('');
  const [busy, save] = useSave(async () => {
    await api.post(`/patients/${patientId}/outside-procedures`, { type, date, office_name: office || null });
    return 'Outside x-rays recorded; the recall now counts from that date';
  }, onDone);
  return (
    <Inline title="X-rays taken at another office" onClose={onDone} onSubmit={save} busy={busy}>
      <div className="inline">
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Which x-rays" autoFocus>{XRAYS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} aria-label="Taken on" required />
      </div>
      <input value={office} onChange={(e) => setOffice(e.target.value)} placeholder="Where (optional) — e.g. previous dentist" aria-label="Office" />
    </Inline>
  );
}
