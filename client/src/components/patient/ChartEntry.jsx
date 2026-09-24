import { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { api } from '../../api.js';
import { undoable } from '../../toast.js';
import { useShortcuts } from '../../shortcuts.js';
import { parseShorthand, describe } from './chartShorthand.js';
import { useAuth } from '../../auth.jsx';
import { money } from '../../format.js';
import './moneyflows.css';

// Chart by typing: "30 MO caries", "14 D2740", "2-4 sealant plan", "19 rct done". With a tooth selected on the
// drawing, the number can be left out ("MO caries"). Enter charts it all at once; Undo takes it back.
export default function ChartEntry({ patient, tooth, onDone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const history = useRef([]);
  const back = useRef(0);
  const input = useRef(null);

  const parsed = useMemo(() => {
    if (!text.trim()) return { items: [] };
    const attempt = (t) => { try { return { items: parseShorthand(t) }; } catch (e) { return { error: e.message }; } };
    const first = attempt(text);
    // No tooth typed: use the one selected on the drawing.
    if (first.error && tooth && /tooth number/.test(first.error)) return attempt(`${tooth} ${text}`);
    return first;
  }, [text, tooth]);

  // #18: what the typed work would cost the patient, with their insurance. Read-only (nothing is charted until
  // Enter), debounced while typing, and only for people who can see billing.
  const { can } = useAuth();
  const [estimate, setEstimate] = useState(null);
  const work = (parsed.items || []).filter((it) => it.type === 'procedure' && it.code);
  const workKey = JSON.stringify(work.map((it) => [it.code, it.tooth, it.surfaces]));
  useEffect(() => {
    setEstimate(null);
    if (!work.length || !can('billing:read')) return undefined;
    let live = true;
    const t = setTimeout(() => {
      api.post(`/patients/${patient.id}/estimate`, { items: work.map((it) => ({ code: it.code, tooth: it.tooth || null, surfaces: it.surfaces || null })) })
        .then((est) => { if (live) setEstimate(est); })
        // A preview only: if it can't be priced (say, a code this office doesn't use), charting still works
        // and the server says why on Enter.
        .catch(() => { if (live) setEstimate(null); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [workKey, patient.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Any digit (or E) on the chart starts an entry, so charting never needs the mouse.
  useShortcuts([
    { combo: 'e', handler: () => input.current?.focus(), label: 'Chart by typing (e.g. 30 MO caries)', section: 'Chart' },
    ...'0123456789'.split('').map((d) => ({ combo: d, handler: () => { input.current?.focus(); setText((t) => t + d); } })),
  ]);

  const submit = async () => {
    if (!parsed.items?.length || busy) return;
    setBusy(true);
    setErr(null);
    const items = parsed.items;
    try {
      await undoable(
        `Charted ${items.map(describe).join(' · ')}`,
        async () => {
          const made = [];
          for (const it of items) {
            if (it.type === 'condition') {
              const c = await api.post(`/patients/${patient.id}/conditions`, { tooth: it.tooth, surfaces: it.surfaces, condition: it.condition });
              made.push({ kind: 'condition', id: c.id });
            } else {
              const p = await api.post(`/patients/${patient.id}/procedures`, { code: it.code, tooth: it.tooth, surfaces: it.surfaces, complete: it.complete });
              made.push({ kind: p.status === 'planned' ? 'planned' : 'completed', id: p.id });
            }
          }
          onDone?.();
          return made;
        },
        // Undo takes findings and planned work back off the chart (completed work is reversed from its row,
        // since that also reverses the charge).
        async (made) => {
          for (const m of [...made].reverse()) {
            if (m.kind === 'condition') await api.post(`/conditions/${m.id}/void`, { reason: 'Undone right after charting' });
            if (m.kind === 'planned') await api.post(`/procedures/${m.id}/cancel`);
          }
          onDone?.();
        },
      );
      history.current = [text, ...history.current.filter((h) => h !== text)].slice(0, 20);
      back.current = 0;
      setText('');
    } catch (e) {
      setErr(e.message);
      onDone?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="chart-entry no-print" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Keyboard size={18} className="muted" aria-hidden />
      <input
        ref={input} value={text} onChange={(e) => { setText(e.target.value); setErr(null); }} disabled={busy}
        aria-label="Chart by typing" autoComplete="off" spellCheck={false}
        placeholder={tooth ? `#${tooth}: MO caries · D2740 · crown plan · missing…  (Enter to chart)` : 'Type to chart: 30 MO caries · 14 D2740 · 2-4 sealant plan · 19 missing  (press E)'}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setText(''); e.currentTarget.blur(); }
          if (e.key === 'ArrowUp' && history.current.length) { e.preventDefault(); setText(history.current[Math.min(back.current, history.current.length - 1)]); back.current = Math.min(back.current + 1, history.current.length - 1); }
        }}
      />
      <button className="small primary" disabled={busy || !parsed.items?.length}>Chart</button>
      {(text.trim() || err) && (
        <div className="preview" role="status">
          {err ? <span className="bad">{err}</span>
            : parsed.error ? <span className="bad">{parsed.error}</span>
              : parsed.items.map((it, i) => <span key={i} className="chip">{describe(it)}</span>)}
          {!err && !parsed.error && estimate && (
            <span className="est" title={`Fee ${money(estimate.total_fee)}${estimate.total_write_off ? ` · write-off ${money(estimate.total_write_off)}` : ''}${estimate.items.flatMap((i) => i.notes || []).length ? ` · ${estimate.items.flatMap((i) => i.notes || []).join('; ')}` : ''}`}>
              Est. patient {money(estimate.total_patient)}{estimate.policy ? ` · ${estimate.policy.carrier_name} ${money(estimate.total_insurance)}` : ' · no insurance'}
            </span>
          )}
        </div>
      )}
    </form>
  );
}
