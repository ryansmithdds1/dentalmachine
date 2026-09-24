import { useEffect, useMemo, useState } from 'react';
import { typingIn } from '../../shortcuts.js';
import DocPreview from './DocPreview.jsx';
import DocSidePanel from './DocSidePanel.jsx';
import './docs.css';

// A document open for reading: the file on the left (or whatever viewer the caller supplies — the x-ray
// viewer, the 3D viewer), its details, notes, pins, review and links on the right. P pins a sticky note.
export default function DocView({ doc, office = false, renderViewer = null, onChanged, footer = null }) {
  const [pinMode, setPinMode] = useState(false); // false | true (pick a spot) | { x, y, page } (spot picked)
  const [notes, setNotes] = useState([]);
  const [page, setPage] = useState(1);
  const [focusNote, setFocusNote] = useState(null);
  useEffect(() => { setPinMode(false); setFocusNote(null); setNotes([]); }, [doc.id]);
  useEffect(() => {
    const onKey = (e) => {
      if (typingIn(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() === 'p' && !renderViewer && doc.mime !== 'application/pdf') { e.preventDefault(); setPinMode((m) => (m ? false : true)); }
      if (e.key === 'Escape' && pinMode) { e.stopPropagation(); setPinMode(false); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pinMode, renderViewer, doc.mime]);
  const pins = useMemo(() => {
    const list = notes.filter((n) => n.pinned);
    return pinMode && pinMode !== true ? [...list, { id: 'new', ...pinMode, body: 'New note', color: 'blue' }] : list;
  }, [notes, pinMode]);
  return (
    <div className="docview">
      <div className="docview-main">
        {renderViewer ? renderViewer() : (
          <DocPreview doc={doc} pins={pins} pinMode={pinMode === true} onPin={(p) => setPinMode(p)} onPinClick={(n) => setFocusNote(n.id)} onPage={setPage} />
        )}
        {pinMode === true && <div className="docview-hint" role="status">Click the spot for the sticky note · Esc cancels</div>}
        {footer}
      </div>
      <DocSidePanel doc={doc} office={office} pinMode={renderViewer ? undefined : pinMode} setPinMode={renderViewer ? undefined : setPinMode} page={page}
        onChanged={onChanged} onNotes={setNotes} focusNote={focusNote} />
    </div>
  );
}
