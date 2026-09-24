import { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Mic, AlertTriangle } from 'lucide-react';
import { api } from '../../api.js';
import { undoable, toast } from '../../toast.js';
import { useShortcuts } from '../../shortcuts.js';
import { resolveEntry, describe, itemProblem } from './chartShorthand.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money } from '../../format.js';
import useDictation from '../useDictation.js';
import './moneyflows.css';
import './treatmententry.css';

// Chart by typing: "30 MO caries", "14 D2740", "2-4 sealant plan", "19 rct done" — and the office's bundles and
// aliases ("14 crb bu", "np", "srp no LL", "3-5 brg"), the quick buttons (which fill this box) and speech (the mic).
// Everything goes through one engine (chartShorthand.js = server/src/chartengine.js) and one preview: the chips
// right away, then the server's check (codes, teeth, surfaces), fees, the insurance estimate and anything to look
// at twice (already planned, missing tooth, frequency limits). Enter charts it all at once; Undo takes it back.
// "Option one … option two …" previews treatment options side by side instead; Enter creates them.
//
// setup: GET /chart-shortcuts ({ bundles, shortcuts }); chart: the patient's conditions and procedures;
// request: { text, auto, n } from a quick button — auto charts at once when there's nothing to check.
const toothWord = (t) => (/^[A-T]S?$/.test(String(t)) ? `#${t}` : String(t));
const SAY_ENTER = /[\s,.]*(chart it|enter|go ahead|that's it|save it)[.!]?$/i;

export default function ChartEntry({ patient, tooth, onDone, setup, lookups, chart, request }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const history = useRef([]);
  const back = useRef(0);
  const input = useRef(null);
  const { can } = useAuth();

  const parsed = useMemo(() => {
    if (!text.trim()) return { items: [] };
    const ctx = { lookups, chart };
    const attempt = (t) => { try { return resolveEntry(t, ctx); } catch (e) { return { error: e.message }; } };
    const first = attempt(text);
    // No tooth typed: use the one selected on the drawing.
    if (first.error && tooth && /tooth number|which tooth/.test(first.error)) return { ...attempt(`${toothWord(tooth)} ${text}`), usedTooth: tooth };
    return first;
  }, [text, tooth, lookups, chart]);

  // The server's look at the same words: its checks, fees, estimate and warnings. Read-only, debounced while typing.
  const [check, setCheck] = useState(null);
  const checkKey = JSON.stringify([text.trim(), parsed.usedTooth || null, parsed.error ? 'x' : 'ok']);
  const resolveNow = (t, usedTooth) => api.post('/charting/resolve', { patient_id: patient.id, text: t, ...(usedTooth ? { tooth: usedTooth } : {}) });
  useEffect(() => {
    setCheck(null);
    if (!text.trim() || parsed.error) return undefined;
    let live = true;
    const t = setTimeout(() => {
      resolveNow(text, parsed.usedTooth)
        .then((r) => { if (live) setCheck({ text, ...r }); })
        // A preview only: if it can't be checked now, charting still re-checks everything and says why.
        .catch((e) => { if (live) setCheck({ text, failed: e.message }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [checkKey, patient.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = check && check.text === text && !check.failed ? check : null;

  // Any digit (or E) on the chart starts an entry, so charting never needs the mouse.
  useShortcuts([
    { combo: 'e', handler: () => input.current?.focus(), label: 'Chart by typing (e.g. 30 MO caries, 14 crb, np)', section: 'Chart' },
    ...'0123456789'.split('').map((d) => ({ combo: d, handler: () => { input.current?.focus(); setText((t) => t + d); } })),
  ]);

  const chartItems = async (items, source) => {
    const out = await undoable(
      `Charted ${items.map(describe).join(' · ')}`,
      async () => {
        const r = await api.post(`/patients/${patient.id}/chart-entry`, { items, source });
        onDone?.();
        return r.made;
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
    return out;
  };

  const submit = async ({ source = 'typing' } = {}) => {
    const words = text;
    if (busy || parsed.error || (!parsed.items?.length && !parsed.options) || (current && !current.ok)) return;
    setBusy(true);
    setErr(null);
    try {
      if (parsed.options) {
        const options = (current?.options || parsed.options).map((o) => ({ label: o.label, items: o.items.map((it) => ({ code: it.code, tooth: it.tooth, surfaces: it.surfaces, area: it.area || null, phase: it.phase || null })) }));
        await api.post(`/patients/${patient.id}/treatment-options`, { options, source });
        toast(`Treatment options ready to compare: ${options.map((o) => o.label).join(', ')}`);
        onDone?.();
      } else {
        // Exactly what was previewed (the server's items when its check is in; it checks them again either way).
        await chartItems(current?.items || parsed.items, source);
      }
      history.current = [words, ...history.current.filter((h) => h !== words)].slice(0, 20);
      back.current = 0;
      setText('');
    } catch (e) {
      setErr(e.status === 404 && parsed.options ? 'Comparing options needs the treatment options screen, which isn’t switched on here yet' : e.message);
      onDone?.();
    } finally {
      setBusy(false);
      // Stay in the box: the next entry is just typing and Enter.
      input.current?.focus();
    }
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // A quick button (or its Alt+digit): its words go in the box. With nothing to check — no errors, no warnings —
  // it charts at once (Undo on the toast); otherwise the preview waits for Enter.
  useEffect(() => {
    if (!request?.text) return;
    const words = request.text;
    setText(words);
    setErr(null);
    if (!request.auto) { setTimeout(() => { input.current?.focus(); input.current?.setSelectionRange(words.length, words.length); }, 0); return; }
    let t = words;
    let local;
    try { local = resolveEntry(t, { lookups, chart }); } catch (e) {
      if (tooth && /tooth number|which tooth/.test(e.message)) {
        t = `${toothWord(tooth)} ${words}`;
        try { local = resolveEntry(t, { lookups, chart }); } catch { local = null; }
      }
    }
    // Needs a tooth (none selected) or something else: leave it in the box with the cursor at the end — "crb 14".
    if (!local?.items?.length || local.items.some(itemProblem)) {
      setText(`${words} `);
      setTimeout(() => input.current?.focus(), 0);
      return;
    }
    setText(t);
    resolveNow(t).then((r) => {
      if (!r.ok || r.warnings.length || r.options) { setCheck({ text: t, ...r }); input.current?.focus(); return; }
      setBusy(true);
      chartItems(r.items, 'button').then(() => setText('')).catch((e) => setErr(e.message)).finally(() => setBusy(false));
    }).catch((e) => { setErr(e.message); input.current?.focus(); });
  }, [request?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // Speak instead of typing: each phrase replaces the box; "…, chart it" (or "enter") charts it.
  const { data: hearing } = useApi(can('clinical:write') ? '/dictation' : null);
  const mic = useDictation((said) => {
    const go = SAY_ENTER.test(said);
    setText(said.replace(SAY_ENTER, '').trim());
    setErr(null);
    if (go) setTimeout(() => submitRef.current({ source: 'voice' }), 400);
  }, { mode: hearing?.mode });

  const issues = current ? [...current.errors, ...current.warnings] : [];
  const est = current?.estimate;
  const toggleOption = (bundleIndex, label, on) => {
    // "with post" / "no post" added to the words, so the box always says what will be charted.
    const word = String(label).split(' ')[0];
    const clean = text.replace(new RegExp(`\\s+(with|no)\\s+${word}\\b`, 'i'), '');
    setText(`${clean} ${on ? 'no' : 'with'} ${word}`.replace(/\s+/g, ' '));
    input.current?.focus();
  };

  return (
    <form className="chart-entry no-print" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Keyboard size={18} className="muted" aria-hidden />
      <input
        ref={input} value={text} onChange={(e) => { setText(e.target.value); setErr(null); }} readOnly={busy}
        aria-label="Chart by typing" autoComplete="off" spellCheck={false}
        placeholder={tooth ? `#${tooth}: MO caries · D2740 · crb bu · crown plan · missing…  (Enter to chart)` : 'Type to chart: 30 MO caries · 14 crb bu · np · srp · 2-4 sealant plan  (press E)'}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setText(''); e.currentTarget.blur(); }
          if (e.key === 'ArrowUp' && history.current.length) { e.preventDefault(); setText(history.current[Math.min(back.current, history.current.length - 1)]); back.current = Math.min(back.current + 1, history.current.length - 1); }
        }}
      />
      {mic.supported && (
        <button type="button" className={`small te-mic${mic.listening ? ' live' : ''}`} onClick={() => mic.toggle()} title={mic.listening ? 'Stop listening' : 'Add treatment by voice: “crown bundle on 14 with buildup, chart it”'} aria-label={mic.listening ? 'Stop listening' : 'Add treatment by voice'}>
          {mic.listening ? <><span className="te-rec" aria-hidden /> Listening… tap to stop</> : <><Mic size={14} aria-hidden /> Say treatment</>}
        </button>
      )}
      <button className="small primary" disabled={busy || !!parsed.error || (!parsed.items?.length && !parsed.options) || (current && !current.ok)}>{parsed.options ? 'Compare' : 'Chart'}</button>
      {(text.trim() || err || mic.interim || mic.listening) && (
        <div className="preview" role="status">
          {mic.listening && !mic.interim && !text.trim() && <span className="muted">Say the tooth and the treatment, e.g. “14 crown with buildup” or “30 MO composite”. Say “chart it” to add it, or tap Chart.</span>}
          {mic.interim && <span className="muted">“{mic.interim}”</span>}
          {err ? <span className="bad">{err}</span>
            : parsed.error ? <span className="bad">{parsed.error}</span>
              : parsed.options ? (
                <div className="te-options">
                  {(current?.options || parsed.options).map((o) => (
                    <div key={o.label} className="te-option">
                      <b>{o.label}</b>
                      <div>{o.items.map((it, i) => <span key={i} className={`chip${it.error ? ' bad' : ''}`} title={it.error || it.description || ''}>{describe(it)}</span>)}</div>
                      {o.total_fee != null && <div className="muted">{money(o.total_fee)}{o.estimate ? ` · est. patient ${money(o.estimate.total_patient)}` : ''}</div>}
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  {(current?.items || parsed.items).map((it, i) => (
                    <span key={i} className={`chip${it.error ? ' bad' : ''}${it.phase ? ' phased' : ''}`} title={[it.description, it.error, it.bundle && `from ${it.bundle}`].filter(Boolean).join(' · ')}>
                      {it.phase ? <small>P{it.phase}</small> : null}{describe(it)}{it.fee != null ? <small> {money(it.fee)}</small> : null}
                    </span>
                  ))}
                  {(current?.bundles || parsed.bundles || []).flatMap((b, bi) => b.options.map((o) => (
                    <button type="button" key={`${bi}-${o.index}`} className={`te-opt${o.on ? ' on' : ''}`} onClick={() => toggleOption(bi, o.label, o.on)} title={o.on ? `Leave out ${o.label}` : `Add ${o.label}`}>
                      {o.on ? '−' : '+'} {o.label}
                    </button>
                  )))}
                </>
              )}
          {!err && !parsed.error && current && !parsed.options && (current.items.length > 1 || est) && (
            <span className="est" title={est ? `Fee ${money(est.total_fee)}${est.total_write_off ? ` · write-off ${money(est.total_write_off)}` : ''}` : ''}>
              {current.items.length > 1 ? `Total ${money(current.total_fee)}` : ''}{current.items.length > 1 && est ? ' · ' : ''}
              {est ? <>Est. patient {money(est.total_patient)}{est.policy ? ` · ${est.policy.carrier_name} ${money(est.total_insurance)}` : ' · no insurance'}</> : null}
            </span>
          )}
          {!err && !parsed.error && issues.length > 0 && (
            <ul className="te-issues">
              {current.errors.map((m) => <li key={m} className="bad">{m}</li>)}
              {current.warnings.map((m) => <li key={m}><AlertTriangle size={12} aria-hidden /> {m}</li>)}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
