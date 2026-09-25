import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useCommands } from '../../shortcuts.js';

// Always mounted in the signed-in shell (renders nothing): documents in the command bar. Typing in Ctrl/⌘K
// also searches the words inside documents (scans read by OCR, PDFs, Word files, notes) — "delta eob" finds
// the EOB — and Enter opens it in the patient's chart (or Office documents). Plus "Office documents",
// "Scan inbox" and "Documents to review".
export default function DocumentCommands() {
  const nav = useNavigate();
  const { user, can } = useAuth();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState({ q: '', rows: [] });
  const ctrl = useRef(null);
  // Follow what's typed in the command bar (it lives in CommandPalette.jsx; we only listen).
  // Read a moment after typing stops (never during the keystroke, so the bar's own typing isn't disturbed).
  useEffect(() => {
    let timer = null;
    const later = (v) => { clearTimeout(timer); timer = setTimeout(() => setQ(v), 120); };
    const onInput = (e) => {
      if (!e.target?.closest?.('.palette')) return;
      later(String(e.target.value || '').trim());
    };
    const onKey = (e) => { if (e.key === 'Escape') later(''); };
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKey, true);
    return () => { clearTimeout(timer); document.removeEventListener('input', onInput, true); document.removeEventListener('keydown', onKey, true); };
  }, []);
  useEffect(() => {
    if (!user || q.length < 3 || /^\d+$/.test(q)) { setHits({ q: '', rows: [] }); return undefined; }
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    // Asked as soon as typing pauses, about when the command bar asks for its own (patient) results.
    api.get(`/documents/search?q=${encodeURIComponent(q)}&limit=6`).then((rows) => { if (!c.signal.aborted) setHits({ q, rows }); }).catch(() => { /* a convenience */ });
    return () => c.abort();
  }, [q, user]);

  const commands = useMemo(() => {
    if (!user) return [];
    const list = [];
    const office = can?.('officedocs:read');
    if (office) list.push({ id: 'docs-office', label: 'Office documents (contracts, licences, policies)', hint: 'Go to page', run: () => nav('/documents') });
    if (can?.('clinical:write')) list.push({ id: 'docs-inbox', label: 'Scan inbox (scans to file)', hint: 'Documents', run: () => nav('/documents?tab=inbox') });
    list.push({ id: 'docs-review', label: 'Documents to review', hint: 'Documents', run: () => nav('/documents?tab=review') });
    if (hits.q && hits.q === q && hits.rows.length) {
      // Labels carry what was typed, so the command bar keeps them while it filters. They arrive after the
      // command bar's own results, so they are `last`: listed at the bottom, never above what was already shown
      // (and "Search all documents" only when something was found).
      for (const d of hits.rows) {
        list.push({
          id: `doc-hit-${d.id}`,
          label: `“${hits.q}” in ${d.filename}${d.patient_name ? ` · ${d.patient_name}` : ' · office'}`,
          hint: d.snippet ? d.snippet.slice(0, 90) : 'Document',
          icon: '📄',
          last: true,
          run: () => nav(d.link),
        });
      }
      list.push({ id: 'doc-search-all', label: `Search all documents for “${hits.q}”`, hint: `${hits.rows.length} found`, icon: '📄', last: true, run: () => nav(`/documents?tab=search&q=${encodeURIComponent(hits.q)}`) });
    }
    return list;
  }, [user, can, hits, q, nav]);
  useCommands(commands);
  return null;
}
