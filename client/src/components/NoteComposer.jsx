import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Undo2 } from 'lucide-react';
import { api } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtTime } from '../format.js';
import { comboLabel, typingIn, useShortcuts } from '../shortcuts.js';
import { getPref, loadPrefs, setPref } from '../prefs.js';
import { ErrorBox, useSubmit } from './ui.jsx';
import useDictation from './useDictation.js';
import './notes.css';

// [[Label: a|b|c]] markers left in a note, each answered with a tap (or by dictating).
const PROMPT = /\[\[([^:\]]+):\s*([^\]]*)\]\]/g;
export const notePrompts = (body) => [...body.matchAll(PROMPT)].map((m) => ({ token: m[0], label: m[1].trim(), options: m[2].split('|').map((o) => o.trim()).filter(Boolean) }));

// Things said to the software rather than into the note.
const COMMAND = {
  undo: /^(undo( that)?|scratch that|take that out|delete that)[.!]?$/i,
  stop: /^(stop (dictating|dictation|listening)|that's it|that is all|done dictating)[.!]?$/i,
};

// The template this person last picked by hand for a kind of visit, used when nothing on the visit matches one.
const templateKey = (typeId) => (typeId ? `note.template@type:${typeId}` : null);
const sentence = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}`;

// Writes a clinical note. It opens already drafted: from the procedures it was opened for, else from today's
// visit (its procedures' templates, or the template used last for that kind of visit), and linked to that visit.
// The dentist can dictate at any point: the template's questions get answered and what else was said is written
// in where it belongs (see server/src/notedictation.js). They review, then save (Ctrl/⌘+Enter) or save and sign.
export default function NoteComposer({
  patient, procedureIds = [], providerId: initialProvider, appointmentId: initialVisit, onSaved,
  autoDraft = false, draftToday = false, autoFocus = false, autoListen = false,
}) {
  const { can } = useAuth();
  const canSign = can('clinical:sign');
  const templates = useLookup('/note-templates');
  const providers = useLookup('/providers?active=true');
  const [body, setBody] = useState('');
  const [providerId, setProviderId] = useState(initialProvider ? String(initialProvider) : '');
  // null until the draft says which visit this is; '' means not linked to a visit.
  const [visitId, setVisitId] = useState(initialVisit ? String(initialVisit) : null);
  const [visits, setVisits] = useState([]);
  const [draftType, setDraftType] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(0);
  const [last, setLast] = useState(null); // what the last dictation did
  const [history, setHistory] = useState([]);
  const [aiUsed, setAiUsed] = useState(false);
  const bodyRef = useRef('');
  bodyRef.current = body;
  const typedRef = useRef('');
  typedRef.current = typed;
  // Read when saving, after the opening draft may have filled them in.
  const linkRef = useRef({});
  linkRef.current = { visitId, providerId };
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const queue = useRef(Promise.resolve());
  const ids = procedureIds.join(',');
  const visitTypeId = visits.find((v) => String(v.id) === visitId)?.appointment_type_id ?? draftType;

  const draft = async ({ templateId, visit, first = false } = {}) => {
    setLoadErr(null);
    try {
      const q = new URLSearchParams({
        ...(ids ? { procedure_ids: ids } : {}), ...(templateId ? { template_id: templateId } : {}), ...(visit ? { appointment_id: visit } : {}),
      });
      const d = await api.get(`/patients/${patient.id}/note-draft?${q}`);
      if (first) {
        setVisits(d.visits || []);
        setDraftType(d.appointment_type_id ?? null);
        const visitNow = d.appointment_id ? String(d.appointment_id) : '';
        setVisitId((cur) => cur ?? visitNow);
        linkRef.current.visitId ??= visitNow; // a save waiting on this draft reads it before the next render
      }
      // Who it's for: whoever the screen asked for, else the person writing (if a provider), the visit's
      // provider, or the patient's own.
      const who = d.provider_id || patient.primary_provider_id;
      if (who) {
        setProviderId((cur) => cur || String(who));
        linkRef.current.providerId ||= String(who);
      }
      if (d.body) {
        setBody((cur) => (cur.trim() ? `${cur.trim()}\n\n${d.body}` : d.body));
      } else if (first && !templateId && d.appointment_type_id) {
        // Nothing on the visit matches a template: use the one this person picked last for this kind of visit.
        await loadPrefs();
        const remembered = getPref(templateKey(d.appointment_type_id), null);
        if (remembered) await draft({ templateId: remembered, visit: d.appointment_id });
      }
    } catch (e) {
      setLoadErr(e);
    }
  };
  // Opens drafted: from the procedures just completed (the chart), or from today's visit (the Notes tab).
  const drafting = useRef(Promise.resolve());
  useEffect(() => {
    if ((autoDraft && ids) || draftToday) drafting.current = draft({ first: true, visit: initialVisit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDraft, draftToday, ids, patient.id]);
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  const insertTemplate = (id) => {
    if (!id) return;
    // Remembered per kind of visit, so next time a visit like this one opens with it.
    if (visitTypeId) setPref(templateKey(visitTypeId), Number(id));
    draft({ templateId: id, visit: visitId || undefined });
  };
  const changeVisit = (value) => {
    setVisitId(value);
    // A different visit with nothing written yet: draft that visit instead.
    if (value && !bodyRef.current.trim() && !ids) draft({ visit: value });
  };

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

  const prompts = notePrompts(body);
  const answer = (token, value) => { setHistory((h) => [...h.slice(-19), body]); setBody(body.replace(token, value)); };

  const saving = useRef(false);
  const { submit, busy, error } = useSubmit(async (sign) => {
    if (saving.current) return;
    saving.current = true;
    try {
      mic.stop();
      // Let the opening draft (which says which visit this is) and dictation still being worked in land first.
      await drafting.current;
      await queue.current;
      // Words still in the typing box go in as written (not through the AI, so nothing unseen is rewritten).
      const extra = typedRef.current.trim();
      const text = extra ? (bodyRef.current.trim() ? `${bodyRef.current.trim()}\n${sentence(extra)}` : sentence(extra)) : bodyRef.current;
      if (!text.trim()) return;
      const link = linkRef.current;
      const note = await api.post(`/patients/${patient.id}/notes`, {
        body: text, provider_id: link.providerId ? Number(link.providerId) : null, appointment_id: link.visitId ? Number(link.visitId) : null, ai_assisted: aiUsed,
      });
      // The note is saved even if signing is refused (e.g. it's another provider's): clear the draft first
      // so a retry can't save it twice.
      setBody('');
      bodyRef.current = '';
      setTyped('');
      setHistory([]);
      setLast(null);
      setAiUsed(false);
      if (sign) {
        await api.post(`/notes/${note.id}/sign`).catch((e) => {
          onSaved?.(note);
          throw new Error(`Note saved but not signed: ${e.message}`);
        });
      }
      onSaved?.(note);
    } finally {
      saving.current = false;
    }
  });
  const hasText = !!(body.trim() || typed.trim());

  // Keys work from anywhere on the screen, but not from another box (say, editing an older note).
  const mine = (e) => !typingIn(e.target) || rootRef.current?.contains(e.target);
  useShortcuts([
    // Shift isn't told apart for Enter by the shortcut matcher, so one handler reads it.
    { combo: 'mod+enter', label: 'Save the note', section: 'Notes', inInputs: true, handler: (e) => mine(e) && submit(canSign && e.shiftKey) },
    { combo: 'mod+shift+enter', label: 'Save and sign the note', section: 'Notes', inInputs: true, enabled: canSign, handler: (e) => mine(e) && submit(true) },
    { combo: 'alt+m', label: 'Start or stop dictation', section: 'Notes', handler: () => mic.toggle() },
  ]);

  // The draft lists today's visits only.
  const visitLabel = (v) => `Today ${fmtTime(v.start_time)} · ${v.type_name || 'Visit'}${v.provider_name ? ` · ${v.provider_name}` : ''}`;

  return (
    <div className="note-composer" ref={rootRef}>
      <ErrorBox error={error || loadErr} />
      <div className="inline" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
        <select value="" onChange={(e) => insertTemplate(e.target.value)} style={{ maxWidth: 240 }} aria-label="Insert a template">
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
          <input ref={inputRef} value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type what to add"
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
          <div className="note-open-warning" role="status">
            {prompts.length} question{prompts.length > 1 ? 's are' : ' is'} still open. You can still save — the open {prompts.length > 1 ? 'ones stay' : 'one stays'} in the note as written.
          </div>
        </div>
      )}
      <textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Clinical note" placeholder="Clinical note — pick a template, or just start dictating…" />
      <div className="form-grid" style={{ marginTop: 10 }}>
        <label>
          Provider
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">—</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>
          Visit
          <select value={visitId ?? ''} onChange={(e) => changeVisit(e.target.value)} aria-label="Visit">
            <option value="">{visits.length ? 'Not linked to a visit' : 'No visit today'}</option>
            {visits.map((v) => <option key={v.id} value={v.id}>{visitLabel(v)}</option>)}
            {visitId && !visits.some((v) => String(v.id) === visitId) && <option value={visitId}>The visit these procedures were done at</option>}
          </select>
        </label>
      </div>
      {aiUsed && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>AI helped write this from your dictation — read it over before you save. You’re recorded as the one who approved it.</div>}
      <div className="form-actions">
        <button type="button" className={canSign ? '' : 'primary'} disabled={busy || !hasText} onClick={() => submit(false)} title={comboLabel('mod+enter').join('+')}>
          Save note <kbd>{comboLabel('mod+enter').join('+')}</kbd>
        </button>
        {canSign && (
          <button type="button" className="primary" disabled={busy || !hasText} onClick={() => submit(true)} title={comboLabel('mod+shift+enter').join('+')}>
            Save &amp; sign <kbd>{comboLabel('mod+shift+enter').join('+')}</kbd>
          </button>
        )}
      </div>
    </div>
  );
}
