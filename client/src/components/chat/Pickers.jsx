import { useEffect, useRef, useState } from 'react';
import { EMOJI_GROUPS, findEmoji } from './emoji.js';
import { api } from '../../api.js';
import { useBlobUrl } from './chatStore.js';
import { useRemembered } from '../../prefs.js';

// Closes a popover on Escape or a click outside it.
function useDismiss(ref, onClose) {
  useEffect(() => {
    const down = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); };
  }, [ref, onClose]);
}

// Emoji picker: search by word, recently used first, arrow keys + Enter to pick.
export function EmojiPicker({ onPick, onClose, align = 'left' }) {
  const ref = useRef(null);
  const [q, setQ] = useState('');
  const [recent, remember] = useRemembered('chat.emoji.recent', []);
  useDismiss(ref, onClose);
  const hits = q ? findEmoji(q) : null;
  const pick = (e) => {
    remember([e, ...recent.filter((x) => x !== e)].slice(0, 16));
    onPick(e);
  };
  return (
    <div className={`chat-pop emoji-pop ${align}`} ref={ref} role="dialog" aria-label="Pick an emoji">
      <input autoFocus placeholder="Find an emoji…" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (hits || [])[0]) { e.preventDefault(); pick(hits[0][0]); } }} />
      <div className="emoji-scroll">
        {hits ? (
          <div className="emoji-grid">{hits.map(([e, w]) => <button key={e} type="button" title={w.split(' ')[0]} onClick={() => pick(e)}>{e}</button>)}{!hits.length && <div className="muted small-pad">No emoji match “{q}”.</div>}</div>
        ) : (
          <>
            {recent.length > 0 && <><div className="emoji-head">Recent</div><div className="emoji-grid">{recent.map((e) => <button key={e} type="button" onClick={() => pick(e)}>{e}</button>)}</div></>}
            {EMOJI_GROUPS.map(([name, list]) => (
              <div key={name}>
                <div className="emoji-head">{name}</div>
                <div className="emoji-grid">{list.map(([e, w]) => <button key={e} type="button" title={w.split(' ')[0]} onClick={() => pick(e)}>{e}</button>)}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// A GIF as the chat shows it: the built-in (sandbox) ones are animated emoji; real ones load through the server.
export function GifView({ gif, small }) {
  const src = useBlobUrl(gif?.url ? `/chat/gifs/media?u=${encodeURIComponent(small ? gif.preview || gif.url : gif.url)}` : null);
  if (!gif) return null;
  if (!gif.url) return <span className={`gif-emoji${small ? ' small' : ''}`} role="img" aria-label={gif.title}>{gif.emoji}</span>;
  if (src === false) return <span className="muted">GIF unavailable</span>;
  return src ? <img className={`gif-img${small ? ' small' : ''}`} src={src} alt={gif.title || 'GIF'} /> : <span className={`gif-loading${small ? ' small' : ''}`} />;
}

// GIF search (only when the practice has turned GIFs on). Only the words typed here are sent, and the server
// strips numbers and patient names first.
export function GifPicker({ onPick, onClose, provider }) {
  const ref = useRef(null);
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  useDismiss(ref, onClose);
  useEffect(() => {
    const t = setTimeout(() => {
      api.get(`/chat/gifs?q=${encodeURIComponent(q)}`).then((r) => { setRes(r); setError(null); }).catch(setError);
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="chat-pop gif-pop" ref={ref} role="dialog" aria-label="Pick a GIF">
      <input autoFocus placeholder="Search GIFs…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="gif-note muted">Only the words you type are searched{provider && provider !== 'sandbox' ? ` (${provider === 'tenor' ? 'Tenor' : 'GIPHY'})` : ''} — never type patient details here.</div>
      {error && <div className="error">{error.message}</div>}
      <div className="gif-grid">
        {(res?.results || []).map((g) => (
          <button key={g.id} type="button" className="gif-tile" title={g.title} onClick={() => onPick(g)}><GifView gif={g} small /></button>
        ))}
      </div>
    </div>
  );
}
