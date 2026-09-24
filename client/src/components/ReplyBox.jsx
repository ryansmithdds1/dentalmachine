import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { toast } from '../toast.js';
import './comms.css';

// The one reply box for texts everywhere (Messages, the chart's Comms tab, the call pop): Enter sends,
// Shift+Enter starts a new line. The text stays in the box if sending fails, and a message the server saved
// but couldn't deliver (failed, or blocked by an opt-out) says so instead of looking sent.
const ReplyBox = forwardRef(function ReplyBox({ onSend, value, onChange, placeholder = 'Type a message…', maxLength = 480, autoFocus = false, rows = 2, label = 'Reply', sendLabel = 'Send', children, disabled = false }, ref) {
  const [own, setOwn] = useState('');
  const body = value ?? own;
  const setBody = onChange ?? setOwn;
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  useImperativeHandle(ref, () => ({ focus: () => box.current?.focus(), blur: () => box.current?.blur(), el: () => box.current }), []);

  const send = async () => {
    const text = body.trim();
    if (!text || busy || disabled) return;
    setBusy(true);
    try {
      const msg = await onSend(text);
      if (msg?.status === 'failed') toast(`Saved, but the text didn’t go: ${msg.error || 'the texting service refused it'}. It’s in Needs attention.`, { tone: 'error', ms: 8000 });
      else if (msg?.status === 'blocked') toast(`Not sent: ${msg.error || 'this number can’t be texted'}`, { tone: 'error', ms: 8000 });
      else toast('Sent');
      setBody('');
    } catch (e) {
      toast(e.message || 'That didn’t send — try again', { tone: 'error', ms: 8000 });
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };

  return (
    <form className="reply-box" onSubmit={(e) => { e.preventDefault(); send(); }}>
      {children}
      <textarea ref={box} rows={rows} value={body} maxLength={maxLength} placeholder={placeholder} aria-label={label} autoFocus={autoFocus} disabled={disabled}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
      <button className="primary" disabled={busy || disabled || !body.trim()} title="Send (Enter) · new line: Shift+Enter"><Send size={15} /> {sendLabel}</button>
    </form>
  );
});
export default ReplyBox;
