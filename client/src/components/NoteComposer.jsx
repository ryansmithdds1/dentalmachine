import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Undo2 } from 'lucide-react';
import { api } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { ErrorBox, useSubmit } from './ui.jsx';
import useDictation from './useDictation.js';

// [[Label: a|b|c]] markers left in a note, each answered with a tap (or by dictating).
const PROMPT = /\[\[([^:\]]+):\s*([^\]]*)\]\]/g;
export const notePrompts = (body) => [...body.matchAll(PROMPT)].map((m) => ({ token: m[0], label: m[1].trim(), options: m[2].split('|').map((o) => o.trim()).filter(Boolean) }));

// Things said to the software rather than into the note.
const COMMAND = {
  undo: /^(undo( that)?|scratch that|take that out|delete that)[.!]?$/i,
  stop: /^(stop (dictating|dictation|listening)|that's it|that is all|done dictating)[.!]?$/i,
};

// Writes a clinical note, optionally from the practice's templates for the given procedures. The dentist can
// dictate at any point: the template's questions get answered and what else was said is written in where it
// belongs (see server/src/notedictation.js). They review, then save and sign as usual.
export default function NoteComposer({ patient, procedureIds = [], providerId: initialProvider, onSaved, autoDraft = false, autoListen = false }) {
  const { can } = useAuth();
  const templates = useLookup('/note-templates');
  const providers = useLookup('/providers?active=true');
  const [body, setBody] = useState('');
  const [providerId, setProviderId] = useState(initialProvider ? String(initialProvider) : '');
  const [signNow, setSignNow] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(0);
  const [last, setLast] = useState(null); // what the last dictation did
  const [history, setHistory] = useState([]);
  const [aiUsed, setAiUsed] = useState(false);
  const bodyRef = useRef('');
  bodyRef.current = body;
  const queue = useRef(Promise.resolve());
  const ids = procedureIds.join(',');

  const draft = async (templateId) => {
    setLoadErr(null);
    try {
      const q = new URLSearchParams({ ...(ids ? { procedure_ids: ids } : {}), ...(templateId ? { template_id: templateId } : {}) });
      const d = await api.get(`/patients/${patient.id}/note-draft?${q}`);
      if (!d.body) return;
      setBody((cur) => (cur.trim() ? `${cur.trim()}\n\n${d.body}` : d.body));
      if (d.provider_id && !providerId) setProviderId(String(d.provider_id));
    } catch (e) {
      setLoadErr(e);
    }
  };
  // Completing procedures opens the composer already drafted from the matching templates.
  useEffect(() => {
    if (autoDraft && ids) draft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDraft, ids]);

  const undo = () => setHistory((h) => {
    if (!h.length) return h;
    setBody(h[h.length - 1]);
    setLast({ undone: true });
    return h.slice(0, -1);
  });

  // One piece of dictation at a time, each against the note as it stands after the one before.
  const dictate = (text) => {
    const said = text.trim();
    if (!said) return;
    if (COMMAND.undo.test(said)) { undo(); return; }
    if (COMMAND.stop.test(said)) { mic.stop(); return; }
    setWorking((n) => n + 1);
    queue.current = queue.current.then(async () => {
      try {
        const before = bodyRef.current;
        const out = await api.post(`/patients/${patient.id}/note-dictate`, { body: before, dictation: said });
        setHistory((h) => [...h.slice(-19), before]);
        setBody(out.body);
        bodyRef.current = out.body;
        if (out.ai) setAiUsed(true);
        setLast({ said, ...out });
      } catch (e) {
        setLoadErr(e);
      } finally {
        setWorking((n) => n - 1);
      }
    });
  };
  // The office's speech service when there is one (medical vocabulary, under its BAA), else the browser's.
  const { data: hearing } = useApi(can('clinical:write') ? '/dictation' : null);
  const mic = useDictation(dictate, { mode: hearing?.mode });
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoListen && hearing && mic.supported && !autoStarted.current) { autoStarted.current = true; mic.start(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoListen, hearing]);
  // Alt+M starts and stops dictation from anywhere in the composer's screen.
  useEffect(() => {
    const onKey = (e) => { if (e.altKey && (e.key === 'm' || e.key === 'M' || e.code === 'KeyM')) { e.preventDefault(); mic.toggle(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mic]);

  const prompts = notePrompts(body);
  const answer = (token, value) => { setHistory((h) => [...h.slice(-19), body]); setBody(body.replace(token, value)); };

  const { submit, busy, error } = useSubmit(async () => {
    if (prompts.length && !window.confirm(`${prompts.length} template question${prompts.length > 1 ? 's are' : ' is'} still unanswered. Save anyway?`)) return;
    mic.stop();
    const note = await api.post(`/patients/${patient.id}/notes`, { body, provider_id: providerId ? Number(providerId) : null, ai_assisted: aiUsed });
    // The note is saved even if signing is refused (e.g. it's another provider's): clear the draft first
    // so a retry can't save it twice.
    setBody('');
    setHistory([]);
    setLast(null);
    if (signNow) {
      await api.post(`/notes/${note.id}/sign`).catch((e) => {
        onSaved?.(note);
        throw new Error(`Note saved but not signed: ${e.message}`);
      });
    }
    onSaved?.(note);
  });

  return (
    <div className="note-composer">
      <ErrorBox error={error || loadErr} />
      <div className="inline" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
        <select value="" onChange={(e) => e.target.value && draft(e.target.value)} style={{ maxWidth: 240 }} aria-label="Insert a template">
          <option value="">Insert template…</option>
          {templates.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {ids && <button type="button" className="small" onClick={() => draft()}>Draft from procedures</button>}
      </div>

      <div className={`dictate-bar${mic.listening ? ' live' : ''}`}>
        {mic.supported && (
          <button type="button" className={mic.listening ? 'dictate-btn live' : 'dictate-btn'} onClick={mic.toggle} title="Alt+M" aria-pressed={mic.listening}>
            {mic.listening ? <><MicOff size={18} aria-hidden /> Stop</> : <><Mic size={18} aria-hidden /> Dictate</>}
          </button>
        )}
        <form className="dictate-type" onSubmit={(e) => { e.preventDefault(); dictate(typed); setTyped(''); }}>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type what to add"
            placeholder={mic.listening ? (mic.interim || 'Listening… say it the way you’d tell your assistant') : mic.supported ? 'Or type it: “2 carpules articaine, rubber dam, shade A2”' : 'Type what to add: “2 carpules articaine, rubber dam, shade A2”'} />
        </form>
        {history.length > 0 && <button type="button" className="small" onClick={undo} title="Undo the last change (or say “undo that”)"><Undo2 size={15} aria-hidden /> Undo</button>}
      </div>
      {mic.error && <div className="error">{mic.error}</div>}
      {mic.listening && <div className="muted" style={{ fontSize: 11, margin: '-4px 0 6px' }}>{mic.server ? 'Heard by the office’s medical speech service.' : 'Heard by your browser’s speech recognition — avoid saying patient names.'}</div>}
      {working > 0 && <div className="muted dictate-status">Updating the note…</div>}
      {last && !working && (
        <div className="dictate-status">
          {last.undone ? <span className="muted">Undone.</span> : (
            <>
              {last.filled?.map((f) => <span key={`${f.label}-${f.value}`} className="dictate-chip filled">{f.label}: {f.value}</span>)}
              {last.added?.map((a) => <span key={a} className="dictate-chip added">+ {a}</span>)}
              {last.changed?.map((c) => <span key={c} className="dictate-chip changed" title="The dictation contradicted the template, so the wording was changed">Changed: {c}</span>)}
              {!last.filled?.length && !last.added?.length && !last.changed?.length && <span className="muted">Nothing to change from “{last.said}”.</span>}
              {last.warning && <div className="muted" style={{ fontSize: 12 }}>{last.warning}</div>}
            </>
          )}
        </div>
      )}

      {prompts.length > 0 && (
        <div className="note-questions">
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Still to answer — tap, or just say it:</div>
          {prompts.map((p, i) => (
            <div key={`${p.token}-${i}`} className="note-question">
              <span className="note-question-label">{p.label}</span>
              {p.options.map((o) => <button type="button" key={o} className="small" onClick={() => answer(p.token, o)}>{o}</button>)}
              {!p.options.length && <span className="muted" style={{ fontSize: 12 }}>say it (“number 30 MO”) or type it above</span>}
            </div>
          ))}
        </div>
      )}
      <textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Clinical note — pick a template, or just start dictating…" />
      <div className="form-grid" style={{ marginTop: 10 }}>
        <label>
          Provider
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">—</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {can('clinical:sign') && <label className="checkbox" style={{ alignSelf: 'end' }}><input type="checkbox" checked={signNow} onChange={(e) => setSignNow(e.target.checked)} /> Sign now</label>}
      </div>
      {aiUsed && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>AI helped write this from your dictation — read it over before you save. You’re recorded as the one who approved it.</div>}
      <div className="form-actions">
        <button className="primary" disabled={busy || !body.trim() || working > 0} onClick={submit}>{signNow ? 'Save & sign' : 'Save note'}</button>
      </div>
    </div>
  );
}
