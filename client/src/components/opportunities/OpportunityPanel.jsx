import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Plus, ShieldCheck, ShieldQuestion, ShieldX, Sparkles, Undo2 } from 'lucide-react';
import { api } from '../../api.js';
import { money, fmtDate } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import { announceOpportunities } from './OpportunityBadge.jsx';
import './opportunities.css';

// What this visit's patient is eligible for today (OF2–OF3): what, why, whether insurance covers it (or when it
// will), what the patient would pay, and one click — or one key — to plan it on the visit. "Not today" records
// that it was offered and turned down. Both undo from the toast (Ctrl/⌘+Z).
// Keys inside the list: ↑ ↓ (or J K) pick, Enter or A adds, N is "not today".
const COVER = {
  covered: ['ok', ShieldCheck], partly: ['warn', ShieldQuestion], not_yet: ['warn', ShieldQuestion], not_covered: ['bad', ShieldX], no_insurance: ['muted', ShieldX],
};
const targetKey = (t) => (t.procedure_id ? `p${t.procedure_id}` : t.tooth ? `t${t.tooth}` : t.area ? `q${t.area}` : t.code);
const targetLabel = (t) => (t.tooth ? `#${t.tooth}` : t.area ? t.area : t.procedure_id ? `${t.code}${t.tooth ? ` #${t.tooth}` : ''}` : t.code);

export default function OpportunityPanel({ appointmentId, canAdd = true, onChanged, autoFocus = false, title = 'Opportunities' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(null);
  const [picked, setPicked] = useState({}); // rule_id → Set of target keys left out
  const [showDeclined, setShowDeclined] = useState(false);
  const list = useRef(null);
  const base = `/appointments/${appointmentId}/opportunities`;

  const load = async () => {
    try {
      setData(await api.get(base));
      setError(null);
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    setData(null);
    setPicked({});
    setActive(0);
    load();
  }, [appointmentId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (autoFocus && data) list.current?.querySelector('.opp-item')?.focus(); }, [autoFocus, !!data]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = async () => {
    await load();
    announceOpportunities({ appointmentId });
    onChanged?.();
  };
  const undo = (o, what) => async () => {
    try {
      await api.post(`${base}/${o.rule_id}/undo`);
      toast(`${what} undone`);
      await changed();
    } catch (e) {
      toast(`Couldn’t undo: ${e.message}`, { tone: 'error' });
    }
  };
  const add = async (o) => {
    if (!canAdd || busy) return;
    const left = picked[o.rule_id];
    const only = left?.size ? o.targets.map(targetKey).filter((k) => !left.has(k)) : undefined;
    if (only && !only.length) return toast('Pick at least one tooth or item', { tone: 'error' });
    setBusy(o.rule_id);
    try {
      const out = await api.post(`${base}/${o.rule_id}/add`, only ? { only } : {});
      const n = out.procedures?.length || 0;
      toast(out.already ? `${o.name} was already added` : `Added to today: ${o.name}${n > 1 ? ` (${n})` : ''}`, { undo: out.already ? null : undo(o, 'Adding it') });
      await changed();
    } catch (e) {
      toast(e.message || 'That didn’t work', { tone: 'error' });
      await load();
    } finally {
      setBusy(null);
    }
  };
  const decline = async (o) => {
    if (!canAdd || busy) return;
    setBusy(o.rule_id);
    try {
      await api.post(`${base}/${o.rule_id}/decline`, {});
      toast(`Not today: ${o.name}`, { undo: undo(o, 'Not today') });
      await changed();
    } catch (e) {
      toast(e.message || 'That didn’t work', { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const toggleTarget = (o, t) => setPicked((p) => {
    const s = new Set(p[o.rule_id] || []);
    const k = targetKey(t);
    if (s.has(k)) s.delete(k); else s.add(k);
    return { ...p, [o.rule_id]: s };
  });

  const items = data?.opportunities || [];
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select') || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    const focusAt = (i) => {
      const next = Math.max(0, Math.min(items.length - 1, i));
      setActive(next);
      list.current?.querySelectorAll('.opp-item')[next]?.focus();
    };
    if (k === 'arrowdown' || k === 'j') { e.preventDefault(); focusAt(active + 1); } else if (k === 'arrowup' || k === 'k') { e.preventDefault(); focusAt(active - 1); } else if ((k === 'enter' && e.target.classList.contains('opp-item')) || k === 'a') { e.preventDefault(); if (items[active]) add(items[active]); } else if (k === 'n') { e.preventDefault(); if (items[active]) decline(items[active]); }
  };

  if (error) return <section className="opp-panel"><ErrorBox error={error} /></section>;
  if (!data) return <section className="opp-panel"><div className="opp-head"><h3><Sparkles size={15} /> {title}</h3></div><div className="muted opp-empty">Checking history, chart and insurance…</div></section>;
  const editable = canAdd && data.editable;
  return (
    <section className="opp-panel" aria-label={title} onKeyDown={onKey}>
      <div className="opp-head">
        <h3><Sparkles size={15} /> {title}</h3>
        {items.length > 0 && <span className="opp-head-total">{items.length} · {money(data.total.fee)}</span>}
      </div>
      {items.length === 0 && <div className="muted opp-empty">Nothing else {data.patient?.name?.split(' ')[0] || 'this patient'} is due for today.</div>}
      <ul className="opp-list" ref={list}>
        {items.map((o, i) => {
          const [tone, Icon] = COVER[o.coverage?.status] || ['muted', ShieldQuestion];
          const left = picked[o.rule_id];
          const n = o.targets.filter((t) => !left?.has(targetKey(t))).length;
          return (
            <li key={o.rule_id} className={`opp-item${i === active ? ' active' : ''}`} tabIndex={0} onFocus={() => setActive(i)}
              aria-label={`${o.name}, ${money(o.added_fee)}. ${o.coverage?.label || ''}`}>
              <div className="opp-row">
                <div className="opp-what">
                  <strong>{o.name}</strong>
                  <span className="opp-codes">{o.codes.join(' · ')}</span>
                </div>
                <span className="opp-fee">{o.added_fee !== o.fee ? '+' : ''}{money(o.added_fee)}</span>
              </div>
              <div className="opp-why">{o.reason}</div>
              {o.targets.length > 1 && (
                <div className="opp-targets" role="group" aria-label="Which ones">
                  {o.targets.map((t) => {
                    const on = !left?.has(targetKey(t));
                    return (
                      <button key={targetKey(t)} type="button" className={`opp-target${on ? ' on' : ''}`} aria-pressed={on} disabled={!editable}
                        onClick={() => toggleTarget(o, t)} title={`${t.code}${t.description ? ` — ${t.description}` : ''} · ${money(t.fee)}`}>
                        {targetLabel(t)}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="opp-foot">
                {o.coverage && (
                  <span className={`opp-cover ${tone}`} title={o.coverage.notes?.join('\n') || o.coverage.carrier || ''}>
                    <Icon size={13} /> {o.coverage.status === 'not_yet' ? <>Not covered yet — eligible {fmtDate(o.coverage.eligible_on)}</> : o.coverage.label}
                  </span>
                )}
                {editable && (
                  <span className="opp-actions">
                    <button className="small" onClick={() => decline(o)} disabled={busy === o.rule_id} title="Offered, but not today (N)">Not today</button>
                    <button className="small primary" onClick={() => add(o)} disabled={busy === o.rule_id || !n} title="Plan it on this visit (Enter or A)">
                      <Plus size={13} /> Add to today{o.targets.length > 1 && n !== o.targets.length ? ` (${n})` : ''}
                    </button>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {data.added.length > 0 && (
        <div className="opp-added">
          {data.added.map((a) => (
            <div key={a.rule_id} className="opp-added-row">
              <Check size={13} /> <span>{a.name}</span>
              <span className="muted">{a.procedures.map((p) => `${p.code}${p.tooth ? ` #${p.tooth}` : p.area ? ` ${p.area}` : ''}`).join(', ')} · {money(a.fee)}</span>
              {editable && <button className="link" onClick={undo(a, 'Adding it')} title="Take it back off this visit"><Undo2 size={12} /> Undo</button>}
            </div>
          ))}
        </div>
      )}
      {data.declined.length > 0 && (
        <div className="opp-declined">
          <button className="link" onClick={() => setShowDeclined((v) => !v)} aria-expanded={showDeclined}>
            {showDeclined ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Not today ({data.declined.length})
          </button>
          {showDeclined && data.declined.map((o) => (
            <div key={o.rule_id} className="opp-added-row muted">
              <span>{o.name} · {money(o.added_fee)}{o.decline_reason ? ` — ${o.decline_reason}` : ''}</span>
              {editable && <button className="link" onClick={undo(o, 'Not today')}>Offer again</button>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
