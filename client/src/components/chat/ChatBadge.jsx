import { useEffect } from 'react';
import { MessagesSquare } from 'lucide-react';
import { useChat, loadBoot, toggleChat } from './chatStore.js';
import { comboLabel } from '../../shortcuts.js';

// The team chat button for the navigation rail: a red count for what's addressed to you (direct messages,
// @mentions, urgent), a dot when there's only channel chatter.
export default function ChatBadge() {
  const s = useChat();
  useEffect(() => { if (!s.boot && !s.error) loadBoot(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const n = s.unread.important;
  const keys = comboLabel('mod+j').join(' ');
  return (
    <button type="button" className={`rail-item chat-rail${s.open ? ' active' : ''}`} onClick={toggleChat} data-tip={`Team chat (${keys})`} aria-label={`Team chat${n ? `, ${n} unread for you` : ''}`} aria-pressed={s.open}>
      <MessagesSquare size={19} strokeWidth={1.9} aria-hidden />
      <span className="rail-label">Team chat <kbd>{keys}</kbd></span>
      {n > 0 ? <span className={`nav-badge${s.unread.urgent ? ' chat-urgent-badge' : ''}`}>{n > 99 ? '99+' : n}</span> : s.unread.total > 0 && <span className="chat-dot" aria-hidden />}
    </button>
  );
}
