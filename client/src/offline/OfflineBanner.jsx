import { useState } from 'react';
import { WifiOff, UploadCloud, AlertTriangle, X, RotateCw, Trash2 } from 'lucide-react';
import { useOffline } from './useOffline.js';
import { asOf } from './snapshot.js';
import { sync, retry, discard } from './index.js';
import './offline.css';

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The line across the top while the internet is down, or while changes made offline are waiting, being sent,
// or couldn't be sent. Opens the list of those changes.
export default function OfflineBanner() {
  const s = useOffline();
  const [open, setOpen] = useState(false);
  const live = s.queue.filter((i) => i.state !== 'discarded');
  const waiting = live.filter((i) => i.state === 'waiting').length;
  const stuck = live.filter((i) => i.state === 'failed' || i.state === 'check').length;
  if (s.online && !live.length && !s.needsSignIn) return null;

  const copy = s.snapshotAt ? `showing today’s schedule as of ${asOf({ generated_at: s.snapshotAt })}` : 'no copy of today’s schedule is kept on this computer';
  let tone = 'warn';
  let icon = <WifiOff size={16} aria-hidden="true" />;
  let text;
  if (!s.online) {
    text = `Offline — ${copy}. ${waiting || !stuck ? 'Changes will be sent when the connection is back.' : ''}`;
  } else if (s.needsSignIn) {
    text = 'Sign in again to send the changes made offline.';
  } else if (stuck) {
    tone = 'danger';
    icon = <AlertTriangle size={16} aria-hidden="true" />;
    text = `${plural(stuck, 'change')} made offline couldn’t be sent.`;
  } else {
    tone = 'info';
    icon = <UploadCloud size={16} aria-hidden="true" />;
    text = s.syncing ? `Sending ${plural(waiting, 'change')} made offline…` : `${plural(waiting, 'change')} made offline waiting to send.`;
  }

  return (
    <>
      <div className={`offline-banner ${tone} no-print`} role="status" aria-live="polite">
        {icon}
        <span className="offline-banner-text">{text}</span>
        {live.length > 0 && (
          <button className="small" onClick={() => setOpen(true)}>
            {waiting ? `${plural(waiting, 'change')} waiting to send` : `${plural(live.length, 'change')} to review`}
          </button>
        )}
        {s.online && waiting > 0 && !s.syncing && <button className="small" onClick={() => sync()}>Send now</button>}
      </div>
      {open && <OfflineChanges s={s} items={live} onClose={() => setOpen(false)} />}
    </>
  );
}

const STATE = { waiting: 'Waiting to send', failed: 'Couldn’t be sent', check: 'Check first' };

function OfflineChanges({ s, items, onClose }) {
  const [confirm, setConfirm] = useState(null);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal offline-changes" role="dialog" aria-label="Changes made offline">
        <div className="modal-header">
          <h2>Changes made offline</h2>
          <button className="link" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ marginTop: 0 }}>
            Kept (encrypted) on this computer and sent in this order when the connection is back. Each one is sent with the same
            tag it got when you made it, so it can’t be recorded twice.
            {s.lastSync?.at && ` Last tried ${time(s.lastSync.at)}.`}
          </p>
          {!items.length && <div className="empty">Nothing waiting.</div>}
          <ol className="offline-list">
            {items.map((i) => (
              <li key={i.key} className={`offline-item ${i.state}`}>
                <div className="offline-item-main">
                  <strong>{i.label}</strong>{i.who ? ` · ${i.who}` : ''}
                  <div className="muted small">Made at {time(i.queued_at)} · {STATE[i.state] || i.state}{i.attempts > 1 ? ` · tried ${i.attempts} times` : ''}</div>
                  {i.error && <div className={i.state === 'waiting' ? 'muted small' : 'offline-item-error'}>{i.error}</div>}
                </div>
                <div className="offline-item-actions">
                  {i.state === 'failed' && <button className="small" disabled={!s.online} title={s.online ? '' : 'Needs the internet'} onClick={() => retry(i.key)}><RotateCw size={13} /> Try again</button>}
                  {i.state === 'check' && <button className="small" disabled={!s.online} title="Only after checking it isn’t already there" onClick={() => retry(i.key)}>I checked — send it</button>}
                  {confirm === i.key
                    ? <button className="small danger" onClick={() => { setConfirm(null); discard(i.key); }}>Discard for good</button>
                    : <button className="small" onClick={() => setConfirm(i.key)} aria-label={`Discard ${i.label}`}><Trash2 size={13} /> Discard</button>}
                </div>
              </li>
            ))}
          </ol>
          {s.others > 0 && <p className="muted small">{plural(s.others, 'change')} saved offline by someone else on this computer will be sent when they sign in.</p>}
          {s.snapshotError && <p className="muted small">{s.snapshotError}</p>}
        </div>
      </div>
    </div>
  );
}
