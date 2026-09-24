import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react';
import { api } from '../../api.js';
import { toast } from '../../toast.js';
import { useChat, setChat, loadUrgent, openChat, refreshUnread, chime } from './chatStore.js';
import { RichText } from './Message.jsx';

// Urgent team messages stay across the top of every screen until this person says "Got it" (which the sender
// sees as "seen by"). It can't be dismissed any other way.
export default function UrgentBanner() {
  const { urgent, boot } = useChat();
  const [i, setI] = useState(0);
  const heard = useRef(new Set());
  useEffect(() => { loadUrgent(); }, []);
  useEffect(() => {
    const fresh = urgent.filter((u) => !heard.current.has(u.id));
    fresh.forEach((u) => heard.current.add(u.id));
    if (fresh.length && heard.current.size > fresh.length) chime(true);
    if (i >= urgent.length) setI(Math.max(0, urgent.length - 1));
  }, [urgent]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!urgent.length) return null;
  const u = urgent[Math.min(i, urgent.length - 1)];
  const ack = async () => {
    try {
      await api.post(`/chat/messages/${u.id}/ack`);
      setChat((s) => ({ urgent: s.urgent.filter((x) => x.id !== u.id) }));
      refreshUnread();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };
  return (
    <div className="urgent-banner no-print" role="alert">
      <AlertTriangle size={18} className="urgent-icon" aria-hidden />
      <div className="urgent-text">
        <strong>Urgent from {u.author_name || 'the team'}</strong>
        <span className="muted-light">{u.kind === 'channel' ? ` in #${u.channel_name}` : ''}</span>
        <div className="urgent-body">{u.hidden ? 'About a patient at another office' : <RichText text={u.body || ''} meName={boot?.me?.name} />}</div>
      </div>
      {urgent.length > 1 && (
        <span className="urgent-nav">
          <button type="button" onClick={() => setI((i - 1 + urgent.length) % urgent.length)} aria-label="Previous urgent message"><ChevronLeft size={15} /></button>
          {Math.min(i, urgent.length - 1) + 1} of {urgent.length}
          <button type="button" onClick={() => setI((i + 1) % urgent.length)} aria-label="Next urgent message"><ChevronRight size={15} /></button>
        </span>
      )}
      <button type="button" className="urgent-open" onClick={() => openChat({ channelId: u.channel_id })}><MessageSquare size={14} /> Open</button>
      <button type="button" className="urgent-ack" onClick={ack}><Check size={15} /> Got it</button>
    </div>
  );
}
