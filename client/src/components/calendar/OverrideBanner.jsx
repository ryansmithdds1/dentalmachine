import { useEffect, useRef } from 'react';
import './workflow.css';

// A move onto blocked time or outside someone's hours: asked inline instead of with a blocking dialog.
// "Move it there" has the focus, so Enter answers yes; Esc (handled by the schedule) or "Keep it" answers no.
export default function OverrideBanner({ message, name, onAnswer }) {
  const yes = useRef(null);
  useEffect(() => { yes.current?.focus(); }, [message]);
  return (
    <div className="placing-banner override-banner" role="alert">
      <span><strong>{message}.</strong> Move {name} there anyway?</span>
      <span className="inline">
        <button ref={yes} className="small primary" onClick={() => onAnswer(true)}>Move it there</button>
        <button className="small" onClick={() => onAnswer(false)}>Keep it where it was</button>
      </span>
    </div>
  );
}
