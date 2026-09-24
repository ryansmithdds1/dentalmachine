import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Paperclip, Smile, User, X, Send } from 'lucide-react';
import { useActivePatient } from '../../activePatient.jsx';
import { useApi } from '../../hooks.js';
import { toast } from '../../toast.js';
import { EmojiPicker, GifPicker } from './Pickers.jsx';
import { uploadFile, setChat } from './chatStore.js';

const GROUPS = [
  ['everyone', 'Everyone in this conversation'], ['front-desk', 'Front desk and billing'], ['clinical', 'Doctors, hygienists and assistants'],
  ['hygiene', 'Hygienists'], ['doctors', 'Dentists'], ['billing', 'Billing'],
];

// Where an @word is being typed (just before the caret), or null.
function mentionAt(text, caret) {
  const m = /(^|[\s(])@([\p{L}'.-]*)$/u.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, q: m[2].toLowerCase() } : null;
}

// The message box: Enter sends, Shift+Enter is a new line, ↑ in an empty box edits your last message,
// @ suggests people and groups, and the active patient can ride along as a chip.
export default function Composer({ channel, parentId = null, team, me, settings, onSend, onEditLast, draft, placeholder, autoFocus = true }) {
  const box = useRef(null);
  const file = useRef(null);
  const [text, setText] = useState('');
  const [patient, setPatient] = useState(null);
  const [urgent, setUrgent] = useState(false);
  const [files, setFiles] = useState([]);
  const [mentionIds, setMentionIds] = useState([]);
  const [pop, setPop] = useState(null); // 'emoji' | 'gif'
  const [sugg, setSugg] = useState(null);
  const [idx, setIdx] = useState(0);
  const { patientId } = useActivePatient();
  const { data: active } = useApi(patientId && !parentId ? `/patients/${patientId}/card` : null);

  // A draft handed over ("Message about this patient", "message @Maria …" from the command bar).
  useEffect(() => {
    if (!draft || parentId) return;
    if (draft.patient) setPatient(draft.patient);
    if (draft.text) setText(draft.text);
    setChat({ draft: null }); // used once: coming back to this conversation later starts clean
    setTimeout(() => box.current?.focus(), 30);
  }, [draft?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (autoFocus) setTimeout(() => box.current?.focus(), 30); }, [channel?.id, parentId, autoFocus]);

  const matches = useMemo(() => {
    if (!sugg) return [];
    const people = team.filter((u) => u.id !== me.id && u.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(sugg.q))).slice(0, 6)
      .map((u) => ({ key: `u${u.id}`, insert: u.name.split(' ')[0], label: u.name, sub: u.role.replace('_', ' '), id: u.id }));
    const groups = GROUPS.filter(([g]) => g.startsWith(sugg.q)).map(([g, sub]) => ({ key: g, insert: g, label: `@${g}`, sub }));
    return [...people, ...groups].slice(0, 8);
  }, [sugg, team, me.id]);

  const onChange = (e) => {
    setText(e.target.value);
    setSugg(mentionAt(e.target.value, e.target.selectionStart));
    setIdx(0);
  };
  const pickMention = (m) => {
    const before = text.slice(0, sugg.start);
    const after = text.slice(box.current.selectionStart);
    const next = `${before}@${m.insert} ${after}`;
    setText(next);
    if (m.id) setMentionIds((ids) => [...new Set([...ids, m.id])]);
    setSugg(null);
    setTimeout(() => { const at = before.length + m.insert.length + 2; box.current?.setSelectionRange(at, at); box.current?.focus(); }, 0);
  };
  const insertText = (s) => {
    const el = box.current;
    const at = el ? el.selectionStart : text.length;
    const next = text.slice(0, at) + s + text.slice(el ? el.selectionEnd : at);
    setText(next);
    setTimeout(() => { el?.focus(); el?.setSelectionRange(at + s.length, at + s.length); }, 0);
  };
  const addFiles = async (list) => {
    for (const f of [...list].slice(0, 10)) {
      const tmp = { tmp: `${Date.now()}${Math.random()}`, filename: f.name || 'pasted image', uploading: true };
      setFiles((fs) => [...fs, tmp]);
      try {
        const up = await uploadFile(f);
        setFiles((fs) => fs.map((x) => (x.tmp === tmp.tmp ? up : x)));
        box.current?.focus();
      } catch (err) {
        setFiles((fs) => fs.filter((x) => x.tmp !== tmp.tmp));
        toast(err.message, { tone: 'error' });
      }
    }
  };
  const send = (extra = {}) => {
    const body = text.trim();
    if ((!body && !files.length && !extra.gif) || files.some((f) => f.uploading)) return;
    onSend({ body, patient, urgent, attachment_ids: files.map((f) => f.id), attachments: files, mention_ids: mentionIds, ...extra });
    setText('');
    setFiles([]);
    setUrgent(false);
    setMentionIds([]);
    setPatient(null);
  };
  const onKey = (e) => {
    if (sugg && matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => (i + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(matches[idx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSugg(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); return; }
    if (e.key === 'ArrowUp' && !text && onEditLast) { e.preventDefault(); onEditLast(); }
  };
  const activeName = active && `${active.first_name} ${active.last_name}`;
  return (
    <div className={`chat-composer${urgent ? ' is-urgent' : ''}`}>
      {(patient || files.length > 0 || urgent) && (
        <div className="chat-attach-row">
          {urgent && <span className="chat-chip urgent"><AlertTriangle size={12} /> Urgent — stays on everyone’s screen until they say “Got it”</span>}
          {patient && <span className="chat-chip patient"><User size={12} /> About {patient.name}<button type="button" aria-label="Remove patient" onClick={() => setPatient(null)}><X size={12} /></button></span>}
          {files.map((f) => <span key={f.id || f.tmp} className="chat-chip">{f.uploading ? 'Uploading… ' : ''}{f.filename}{!f.uploading && <button type="button" aria-label={`Remove ${f.filename}`} onClick={() => setFiles((fs) => fs.filter((x) => x !== f))}><X size={12} /></button>}</span>)}
        </div>
      )}
      {sugg && matches.length > 0 && (
        <div className="chat-suggest" role="listbox">
          {matches.map((m, i) => (
            <button key={m.key} type="button" role="option" aria-selected={i === idx} className={i === idx ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}>
              <strong>{m.label}</strong> <span className="muted">{m.sub}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={box} rows={1} value={text} autoFocus={autoFocus} onChange={onChange} onKeyDown={onKey}
        onPaste={(e) => { const imgs = [...e.clipboardData.files]; if (imgs.length) { e.preventDefault(); addFiles(imgs); } }}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } }}
        placeholder={placeholder || `Message ${channel?.kind === 'channel' ? `#${channel.name}` : channel?.title || ''}`}
        aria-label="Message" style={{ height: `${Math.min(160, 22 + 20 * Math.max(1, text.split('\n').length))}px` }}
      />
      <div className="chat-tools">
        <button type="button" onClick={() => setPop(pop === 'emoji' ? null : 'emoji')} title="Emoji" aria-label="Emoji"><Smile size={17} /></button>
        {settings?.gifs_enabled && <button type="button" className="gif-btn" onClick={() => setPop(pop === 'gif' ? null : 'gif')} title="GIF" aria-label="GIF">GIF</button>}
        <button type="button" onClick={() => file.current?.click()} title="Attach a picture or file" aria-label="Attach"><Paperclip size={16} /></button>
        <input ref={file} type="file" hidden multiple accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        {!parentId && active && !patient && (
          <button type="button" onClick={() => { setPatient({ id: active.id, name: activeName }); box.current?.focus(); }} title="Link this message to the active patient" className="chat-link-patient"><User size={15} /> {active.first_name}</button>
        )}
        {!parentId && <button type="button" className={urgent ? 'on-urgent' : ''} onClick={() => { setUrgent(!urgent); box.current?.focus(); }} title="Urgent: stays on screen until each person says “Got it”" aria-pressed={urgent}><AlertTriangle size={16} /></button>}
        <span className="chat-hint muted">Enter to send · Shift+Enter new line</span>
        <button type="button" className="primary small chat-send" onClick={() => send()} aria-label="Send"><Send size={15} /></button>
        {pop === 'emoji' && <EmojiPicker onClose={() => { setPop(null); box.current?.focus(); }} onPick={(e) => { insertText(e); setPop(null); }} />}
        {pop === 'gif' && <GifPicker provider={settings?.gif_provider} onClose={() => setPop(null)} onPick={(g) => { setPop(null); send({ gif: g }); }} />}
      </div>
    </div>
  );
}
