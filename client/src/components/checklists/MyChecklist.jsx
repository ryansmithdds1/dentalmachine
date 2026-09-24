import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, X, Camera, Paperclip, BookOpen, PartyPopper, Undo2, ListChecks, MapPin } from 'lucide-react';
import { api } from '../../api.js';
import { fmtDate, fmtTime } from '../../format.js';
import { toast } from '../../toast.js';
import { useShortcuts } from '../../shortcuts.js';
import { useLiveEvents } from '../../live.js';
import { ErrorBox } from '../ui.jsx';
import { OccurrenceDrawer, CriticalChip, StateChip, reqIcons, resultText, rangeText, outOfRange, uploadEvidence, time12 } from './shared.jsx';
import './checklists.css';

const MISSING = { number: 'the reading', pass_fail: 'pass or fail', text: 'the answer', note: 'a note', photo: 'a photo', file: 'the file' };

// "My checklist today": the items for my positions (and those given to me), big enough to tick on a tablet.
// One tap ticks a plain item; a spore test is photo → Pass. Keyboard: J/K move, Space or X ticks (Pass),
// F fails, P adds a photo, Enter opens the details, U undoes a tick. Ticks save at once with an Undo toast.
//
// compact: the small card for other screens (To-do, Today) — no keyboard shortcuts of its own, and only
// what's due now. Mount it with <MyChecklist compact />.
export default function MyChecklist({ compact = false }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(0);
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(null);
  const rows = useRef(new Map());
  const load = useCallback(() => api.get('/checklists/mine').then((d) => { setData(d); setError(null); }).catch(setError), []);
  useEffect(() => { load(); }, [load]);
  const timer = useRef(null);
  useLiveEvents((e) => {
    if (e.type !== 'checklists') return;
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 400);
  });

  const today = data?.today;
  const groups = useMemo(() => {
    const items = data?.items || [];
    const due = items.filter((i) => i.status === 'open' && i.due_date <= today).sort((a, b) => (a.state === 'overdue') === (b.state === 'overdue') ? a.due_at.localeCompare(b.due_at) : a.state === 'overdue' ? -1 : 1);
    const coming = items.filter((i) => i.status === 'open' && i.due_date > today);
    const done = items.filter((i) => i.status === 'done');
    return compact ? [['Due now', due]] : [['To do', due], ['Coming up', coming], ['Done today', done]];
  }, [data, today, compact]);
  const flat = groups.flatMap(([, list]) => list);
  const at = Math.min(sel, Math.max(0, flat.length - 1));
  const current = flat[at];
  useEffect(() => { rows.current.get(current?.id)?.el?.scrollIntoView?.({ block: 'nearest' }); }, [current?.id]);

  const complete = async (o, patch = {}) => {
    setBusy(o.id);
    try {
      await api.post(`/checklists/occurrences/${o.id}/complete`, patch);
      const failed = patch.result_pass === 0 || (patch.result_number != null && outOfRange(o, patch.result_number));
      toast(failed ? `Recorded: ${o.title} — ${o.critical ? 'the office manager has been alerted' : 'flagged for the office manager'}` : `Done: ${o.title}`, {
        tone: failed ? 'error' : 'ok',
        undo: failed ? null : async () => {
          try { await api.post(`/checklists/occurrences/${o.id}/undo`, {}); toast('Undone'); } catch (e) { toast(`Couldn’t undo: ${e.message}`, { tone: 'error' }); }
          load();
        },
      });
    } catch (e) {
      const missing = e.details?.missing;
      if (missing) {
        // Keep what was entered (the Pass, the reading) and say what's left: usually "a photo".
        if (Object.keys(patch).length) await api.post(`/checklists/occurrences/${o.id}/progress`, patch).catch(() => {});
        toast(`Almost: add ${missing.map((m) => MISSING[m]).join(' and ')} to finish`, { tone: 'error' });
      } else toast(e.message, { tone: 'error' });
    } finally {
      setBusy(null);
      load();
    }
  };
  const undo = async (o) => {
    try { await api.post(`/checklists/occurrences/${o.id}/undo`, {}); toast(`Undone: ${o.title}`); } catch (e) { toast(e.message, { tone: 'error' }); }
    load();
  };
  const addFile = async (o, file, kind) => {
    if (!file) return;
    setBusy(o.id);
    try {
      await uploadEvidence(o.id, file, kind);
      // Everything else already there (a Pass saved earlier, or nothing else asked for): tick it now.
      const rest = o.result_type === 'none' || (o.result_type === 'pass_fail' && o.result_pass != null) || (o.result_type === 'number' && o.result_number != null) || (o.result_type === 'text' && o.result_text);
      if (o.status === 'open' && rest && (!o.require_note || o.note)) await complete(o);
      else toast(kind === 'photo' ? 'Photo added' : 'File added');
    } catch (e) { toast(e.message, { tone: 'error' }); } finally { setBusy(null); load(); }
  };

  // The main action for the highlighted row (Space / X).
  const primary = (o) => {
    if (!o) return;
    if (o.status === 'done') return;
    if (o.result_type === 'pass_fail') return complete(o, { result_pass: 1 });
    if (o.result_type === 'none' && !o.require_note) return complete(o);
    rows.current.get(o.id)?.focus?.();
  };
  const quiet = !compact && !openId;
  useShortcuts([
    { combo: 'j', handler: () => setSel(Math.min(at + 1, flat.length - 1)), label: 'Next checklist item', section: 'My checklist', enabled: quiet && flat.length > 1 },
    { combo: 'k', handler: () => setSel(Math.max(at - 1, 0)), label: 'Previous checklist item', section: 'My checklist', enabled: quiet && flat.length > 1 },
    { combo: 'x', handler: () => primary(current), label: 'Tick the highlighted item (Pass for a pass/fail item)', section: 'My checklist', enabled: quiet && !!current },
    { combo: ' ', handler: () => primary(current), label: 'Space: tick the highlighted item', section: 'My checklist', enabled: quiet && !!current },
    { combo: 'f', handler: () => current?.result_type === 'pass_fail' && current.status === 'open' && complete(current, { result_pass: 0 }), label: 'Record a fail on the highlighted item', section: 'My checklist', enabled: quiet && current?.result_type === 'pass_fail' },
    { combo: 'p', handler: () => rows.current.get(current?.id)?.photo?.(), label: 'Add a photo to the highlighted item', section: 'My checklist', enabled: quiet && !!current },
    { combo: 'u', handler: () => current?.status === 'done' && undo(current), label: 'Undo the highlighted tick', section: 'My checklist', enabled: quiet && current?.status === 'done' },
    { combo: 'enter', handler: () => current && !document.activeElement?.closest?.('button, a') && setOpenId(current.id), label: 'Open the highlighted item', section: 'My checklist', enabled: quiet && !!current },
  ]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return compact ? null : <p className="muted">Loading your checklist…</p>;
  const due = data.counts.due;
  const doneToday = data.counts.done_today;
  const total = due + doneToday;
  const pct = total ? Math.round((doneToday / total) * 100) : 100;
  if (compact && !data.items.length) return null;

  const body = (
    <>
      {groups.map(([title, list]) => (list.length > 0 || (title === 'To do' && !compact)) && (
        <section key={title}>
          {!compact && <div className="cl-section">{title} <span className="count">{list.length || ''}</span></div>}
          {title === 'To do' && !list.length && (
            <div className="card cl-empty"><PartyPopper size={28} aria-hidden /><p>All done for now. Nice work.</p></div>
          )}
          <div className="cl-list">
            {list.map((o) => (
              <Row key={o.id} o={o} today={today} sel={!compact && flat[at]?.id === o.id} busy={busy === o.id} compact={compact}
                register={(api2) => (api2 ? rows.current.set(o.id, api2) : rows.current.delete(o.id))}
                onPick={() => setSel(flat.findIndex((x) => x.id === o.id))} onOpen={() => setOpenId(o.id)}
                complete={complete} undo={undo} addFile={addFile} />
            ))}
          </div>
        </section>
      ))}
      {openId && <OccurrenceDrawer id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </>
  );
  if (compact) {
    return (
      <div className="card cl-compact" style={{ marginBottom: 16 }}>
        <div className="page-header" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><ListChecks size={18} aria-hidden /> My checklist</h2>
          <Link to="/checklists" className="small">{doneToday}/{total} done · open</Link>
        </div>
        {body}
      </div>
    );
  }
  return (
    <div className="cl-mine">
      <div className="cl-head">
        <div className="cl-ring" style={{ '--pct': pct }} aria-label={`${doneToday} of ${total} done`}><span>{doneToday}/{total}</span></div>
        <div>
          <h1>My checklist</h1>
          <div className="sub">{fmtDate(data.today)} · {data.positions.map((p) => p.name).join(', ') || 'No position yet — ask the office manager to add you to one'}
            {data.counts.overdue ? <> · <strong style={{ color: 'var(--danger)' }}>{data.counts.overdue} overdue</strong></> : null}</div>
        </div>
      </div>
      {body}
      <div className="cl-keys"><kbd>J</kbd>/<kbd>K</kbd> move · <kbd>Space</kbd> or <kbd>X</kbd> tick (pass) · <kbd>F</kbd> fail · <kbd>P</kbd> photo · <kbd>Enter</kbd> details · <kbd>U</kbd> undo</div>
    </div>
  );
}

function Row({ o, today, sel, busy, compact, register, onPick, onOpen, complete, undo, addFile }) {
  const [num, setNum] = useState(o.result_number ?? '');
  const [text, setText] = useState(o.result_text ?? '');
  const [note, setNote] = useState(o.note ?? '');
  const el = useRef(null);
  const input = useRef(null);
  const photo = useRef(null);
  const file = useRef(null);
  useEffect(() => {
    register({ el: el.current, focus: () => input.current?.focus(), photo: () => photo.current?.click() });
    return () => register(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const done = o.status === 'done';
  const values = () => ({
    ...(o.result_type === 'number' ? { result_number: num === '' ? null : num } : {}),
    ...(o.result_type === 'text' ? { result_text: text } : {}),
    ...(o.require_note || note ? { note } : {}),
  });
  const tick = () => {
    if (done) return undo(o);
    if (o.result_type === 'pass_fail') return complete(o, { ...values(), result_pass: 1 });
    return complete(o, values());
  };
  const enter = (e) => { if (e.key === 'Enter') { e.preventDefault(); tick(); } };
  const warn = o.result_type === 'number' && outOfRange(o, num);
  const canUndo = done && o.undo_until && Date.parse(o.undo_until) > Date.now();
  return (
    <div ref={el} className={`cl-row ${o.state}${o.critical ? ' critical' : ''}${o.open_flags ? ' flagged' : ''}${sel ? ' sel' : ''}`} onClick={onPick}>
      <button type="button" className={`cl-check${done ? (o.outcome && o.outcome !== 'ok' ? ' fail' : ' on') : ''}`} disabled={busy || (done && !canUndo)}
        aria-label={done ? `Undo: ${o.title}` : `Tick off: ${o.title}`} title={done ? (canUndo ? 'Undo' : 'Done') : o.result_type === 'pass_fail' ? 'Pass' : 'Done'} onClick={(e) => { e.stopPropagation(); tick(); }}>
        {done && o.outcome && o.outcome !== 'ok' ? <X size={22} /> : <Check size={22} strokeWidth={3} />}
      </button>
      <div style={{ minWidth: 0 }}>
        <button type="button" className="cl-title" onClick={(e) => { e.stopPropagation(); onOpen(); }}>{o.title}</button>
        <div className="cl-meta">
          {o.critical ? <CriticalChip /> : null}
          {o.state !== 'open' && o.state !== 'done' && <StateChip state={o.state} />}
          <span>{o.due_date !== today ? `${fmtDate(o.due_date)} ` : ''}by {time12(o.due_at.slice(11))}</span>
          {!compact && <span>{o.position_name}</span>}
          {o.location_name && <span><MapPin size={12} aria-hidden /> {o.location_name}</span>}
          {reqIcons(o)}
          {o.sop_page_id && <Link to={`/intranet/pages/${o.sop_page_id}`} onClick={(e) => e.stopPropagation()}><BookOpen size={12} aria-hidden /> How to</Link>}
        </div>
        {done ? (
          <div className="cl-done-line">
            {resultText(o) && <strong style={{ color: o.outcome && o.outcome !== 'ok' ? 'var(--danger)' : 'var(--text-2)' }}>{resultText(o)}</strong>}
            <span>{o.completed_by_name} · {fmtTime(o.completed_local)}{o.completed_late ? ' (late)' : ''}</span>
            {o.open_flags ? <span className="cl-warn">Flag open — manager told</span> : null}
            {canUndo && <button className="small" onClick={(e) => { e.stopPropagation(); undo(o); }}><Undo2 size={12} aria-hidden /> Undo</button>}
          </div>
        ) : !compact || o.result_type !== 'none' || o.require_photo || o.require_file || o.require_note ? (
          <div className="cl-controls" onClick={(e) => e.stopPropagation()}>
            {o.result_type === 'pass_fail' && (
              <>
                <button type="button" className={`cl-big pass${o.result_pass === 1 ? ' on' : ''}`} disabled={busy} onClick={() => complete(o, { ...values(), result_pass: 1 })}><Check size={16} aria-hidden /> Pass</button>
                <button type="button" className="cl-big failbtn" disabled={busy} onClick={() => complete(o, { ...values(), result_pass: 0 })}><X size={16} aria-hidden /> Fail</button>
              </>
            )}
            {o.result_type === 'number' && (
              <>
                <input ref={input} className="num" inputMode="decimal" type="text" aria-label={`${o.title} reading`} placeholder={o.unit || 'Reading'} value={num} onChange={(e) => setNum(e.target.value)} onKeyDown={enter} />
                {o.unit && <span className="cl-hint">{o.unit}</span>}
                {rangeText(o) && <span className={warn ? 'cl-warn' : 'cl-hint'}>{warn ? `Outside ${rangeText(o)} — saving flags it` : `Allowed ${rangeText(o)}`}</span>}
              </>
            )}
            {o.result_type === 'text' && <input ref={input} type="text" className="note" aria-label={o.title} placeholder="Answer" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={enter} />}
            {(!!o.require_note || o.result_type !== 'none') && !compact && (
              <input ref={o.result_type === 'none' ? input : undefined} type="text" className="note" aria-label="Note" placeholder={o.require_note ? 'Note (required)' : 'Note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={enter} />
            )}
            {!!o.require_note && compact && <input ref={input} type="text" className="note" aria-label="Note" placeholder="Note (required)" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={enter} />}
            <button type="button" className="cl-big" disabled={busy} onClick={() => photo.current?.click()} title="P"><Camera size={16} aria-hidden /> {o.photos ? `Photo (${o.photos})` : o.require_photo ? 'Take photo' : 'Photo'}</button>
            {!!o.require_file && <button type="button" className="cl-big" disabled={busy} onClick={() => file.current?.click()}><Paperclip size={16} aria-hidden /> {o.files ? `File (${o.files})` : 'Attach file'}</button>}
            {(o.result_type === 'number' || o.result_type === 'text' || (o.result_type === 'none' && o.require_note)) && <button type="button" className="cl-big primary" disabled={busy} onClick={tick}><Check size={16} aria-hidden /> Save</button>}
          </div>
        ) : null}
        {/* capture: the phone or tablet opens its camera straight away. */}
        <input ref={photo} type="file" accept="image/*" capture="environment" hidden data-occurrence={o.id} onChange={(e) => { addFile(o, e.target.files?.[0], 'photo'); e.target.value = ''; }} />
        <input ref={file} type="file" accept="image/*,application/pdf" hidden onChange={(e) => { addFile(o, e.target.files?.[0], 'file'); e.target.value = ''; }} />
      </div>
    </div>
  );
}
