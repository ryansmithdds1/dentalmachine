import { useEffect, useRef, useState } from 'react';
import { useRemembered } from '../../prefs.js';
import { fmtTime } from '../../format.js';
import './workflow.css';

// Why a visit was cancelled or missed (workflow 19). The codes match BROKEN_REASONS in server/src/routes/schedule.js.
export const BROKEN_REASONS = [
  ['sick', 'Sick'],
  ['conflict', 'Work, school or a conflict'],
  ['transportation', 'No ride'],
  ['cost', 'Cost or insurance'],
  ['forgot', 'Forgot'],
  ['office', 'We had to move it', 'cancelled'],
  ['no_contact', 'Didn’t hear from them', 'no_show'],
  ['other', 'Other…'],
];
export const brokenLabel = (code) => BROKEN_REASONS.find(([k]) => k === code)?.[1].replace('…', '') || code;

// The reason picker that stands in for "Are you sure?" on Cancel and No-show: choosing a reason is the
// deliberate second step (a cancel releases the visit's procedures and recalls, which Undo can't restore).
// Number keys pick a reason; "Book their next visit now" (remembered) opens the booking form right after.
export default function BrokenPicker({ appt: a, kind, series, onDone, onClose }) {
  const reasons = BROKEN_REASONS.filter(([, , only]) => !only || only === kind);
  const [other, setOther] = useState(false);
  const [note, setNote] = useState('');
  const [scope, setScope] = useState('this');
  const [rebook, setRebook] = useRemembered('broken.rebook', true);
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  useEffect(() => { box.current?.querySelector('button.reason')?.focus(); }, [kind]);
  const choose = async (code) => {
    if (code === 'other' && !note.trim()) return setOther(true);
    if (busy) return;
    setBusy(true);
    try {
      await onDone({ reason: code, note: code === 'other' ? note.trim() : null, scope, rebook: !!rebook });
    } finally {
      setBusy(false);
    }
  };
  const name = a.preferred_name || a.first_name;
  return (
    <div className="confirm-box broken-picker" ref={box} role="group" aria-label={kind === 'no_show' ? 'No-show reason' : 'Cancel reason'}
      onKeyDown={(e) => {
        if (e.target.closest('input, textarea')) return;
        const n = Number(e.key);
        if (n >= 1 && n <= reasons.length && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          choose(reasons[n - 1][0]);
        }
      }}>
      <strong>{kind === 'no_show' ? `${name} didn’t come to the ${fmtTime(a.start_time)} visit — why?` : `Cancel ${name}’s ${fmtTime(a.start_time)} visit — why?`}</strong>
      <div className="broken-reasons">
        {reasons.map(([code, text], i) => (
          <button key={code} type="button" className="reason" disabled={busy} onClick={() => choose(code)}>
            <kbd>{i + 1}</kbd> {text}
          </button>
        ))}
      </div>
      {other && (
        <form className="inline" onSubmit={(e) => { e.preventDefault(); choose('other'); }}>
          <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened? (a few words)" aria-label="What happened" maxLength={300} />
          <button className="small danger" disabled={!note.trim() || busy}>Save</button>
        </form>
      )}
      {kind === 'cancelled' && series?.remaining > 0 && (
        <div className="seg" style={{ marginTop: 8 }}>
          <button type="button" className={scope === 'this' ? 'active' : ''} onClick={() => setScope('this')}>Only this visit</button>
          <button type="button" className={scope === 'following' ? 'active' : ''} onClick={() => setScope('following')}>This and {series.remaining} later visit{series.remaining === 1 ? '' : 's'}</button>
        </div>
      )}
      <label className="checkbox" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={!!rebook} onChange={(e) => setRebook(e.target.checked)} /> Book their next visit now
      </label>
      <div className="drawer-actions" style={{ marginTop: 6 }}>
        <button type="button" onClick={onClose}>Keep the visit</button>
      </div>
    </div>
  );
}
