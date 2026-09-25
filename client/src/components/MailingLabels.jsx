import { useState } from 'react';
import { Tag } from 'lucide-react';
import { api, saveBlob } from '../api.js';
import { toast } from '../toast.js';
import '../pages/compliance.css';

// Mailing labels (A177, docs/documents.md, “Letters and mailing labels”) for any list on screen: the recall list, a report's results, a
// campaign's audience. One click makes an Avery 5160 sheet (30 per page) as a PDF in a new tab. The server leaves
// out anyone who asked not to be contacted, moved, died, or has no complete address, and prints one label per
// household; those left out and the addresses worth a second look are listed here.
const pdfBlob = (b64) => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'application/pdf' });

export async function printLabels(body, source) {
  const w = window.open('', '_blank'); // opened on the click so it isn't blocked as a pop-up
  try {
    const out = await api.post('/mailing-labels', { ...body, source });
    if (out.pdf) {
      const url = URL.createObjectURL(pdfBlob(out.pdf));
      if (w) w.location.href = url;
      else saveBlob(pdfBlob(out.pdf), 'mailing-labels.pdf');
    } else w?.close();
    const left = out.skipped.length;
    toast(out.count ? `${out.count} label${out.count === 1 ? '' : 's'} ready to print (Avery 5160)${left ? ` · ${left} left out` : ''}` : 'No one on this list has a mailing address to print', { tone: left || !out.count ? 'warn' : 'ok' });
    return out;
  } catch (e) {
    w?.close();
    toast(e.message || 'The labels didn’t print', { tone: 'error' });
    throw e;
  }
}

// ids: the patients shown (or chosen); or segment/params for a campaign's audience.
export default function MailingLabelsButton({ ids, segment, params, source, className = '', label = 'Mailing labels' }) {
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const empty = !segment && !ids?.length;
  const go = async () => {
    setBusy(true);
    try { setOut(await printLabels(segment ? { segment, params } : { patient_ids: ids }, source)); } catch { /* shown in the toast */ } finally { setBusy(false); }
  };
  const notes = out ? [...out.skipped, ...out.warnings] : [];
  return (
    <span className="labels-btn">
      <button type="button" className={className} disabled={busy || empty} onClick={go} title="Print address labels (Avery 5160) for this list">
        <Tag size={14} aria-hidden /> {label}
      </button>
      {notes.length > 0 && (
        <details className="labels-notes">
          <summary>{out.skipped.length ? `${out.skipped.length} left out` : ''}{out.skipped.length && out.warnings.length ? ' · ' : ''}{out.warnings.length ? `${out.warnings.length} to check` : ''}</summary>
          <ul>{notes.map((n) => <li key={`${n.id}-${n.reason}`}>{n.name}: {n.reason}</li>)}</ul>
        </details>
      )}
    </span>
  );
}
