import { useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { fmtUtcDateTime } from '../../format.js';
import { useAuth } from '../../auth.jsx';
import { ErrorBox, useSubmit } from '../ui.jsx';
import '../../pages/compliance.css';

// The prescription monitoring program (PDMP) step before a controlled substance (A178, README.md, “PDMP”). One key:
// "Check the PDMP" asks the state's program through the practice's connection (or the sandbox) and shows what it
// found; the check is saved with the prescription. With no connection, the prescriber records what the state website
// showed. Skipping needs a reason, which is kept on the prescription. A failed check is a Needs attention item.
export default function PdmpCheck({ patient, providerId, current, skip, onSkip, onChecked, buttonRef }) {
  const { practice } = useAuth();
  const { data: info } = useApi('/pdmp');
  const [mode, setMode] = useState(null); // null | 'manual' | 'skip'
  const [said, setSaid] = useState('');
  const run = useSubmit(async (manual) => {
    await api.post(`/patients/${patient.id}/pdmp-checks`, manual ? { manual: true, summary: said, provider_id: providerId } : { provider_id: providerId });
    setMode(null);
    onChecked();
  });
  if (current) {
    return (
      <div className={`pdmp-box ${current.flagged ? 'flag' : 'ok'}`} role="status" aria-label="PDMP check">
        <div><strong>{current.flagged ? '⚠ PDMP checked — review before prescribing' : '✓ PDMP checked'}</strong> <span className="muted">{fmtUtcDateTime(current.created_at, practice?.timezone)}{current.checked_by_name ? ` · ${current.checked_by_name}` : ''}</span></div>
        <div>{current.summary}</div>
      </div>
    );
  }
  const automatic = info?.automatic !== false;
  return (
    <div className="pdmp-box" aria-label="PDMP check">
      <div><strong>Controlled substance: check the prescription monitoring program (PDMP) first.</strong> <span className="muted">{info ? info.name : ''}</span></div>
      <ErrorBox error={run.error} />
      {mode === null && (
        <div className="pdmp-actions">
          {automatic
            ? <button ref={buttonRef} type="button" className="primary" disabled={run.busy} onClick={() => run.submit(false)}>{run.busy ? 'Checking…' : 'Check the PDMP'}</button>
            : <button ref={buttonRef} type="button" className="primary" onClick={() => setMode('manual')}>I checked the state PDMP website</button>}
          {automatic && <button type="button" className="link" onClick={() => setMode('manual')}>I checked the state website myself</button>}
          <button type="button" className="link" onClick={() => setMode('skip')}>Skip — give a reason</button>
        </div>
      )}
      {mode === 'manual' && (
        <div className="pdmp-actions">
          <input autoFocus aria-label="What the state PDMP showed" placeholder="What it showed, e.g. no controlled prescriptions in 12 months" value={said} onChange={(e) => setSaid(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (said.trim()) run.submit(true); } if (e.key === 'Escape') { e.preventDefault(); setMode(null); } }} style={{ flex: 1, minWidth: 240 }} />
          <button type="button" className="primary" disabled={!said.trim() || run.busy} onClick={() => run.submit(true)}>Save</button>
          <button type="button" className="small" onClick={() => setMode(null)}>Back</button>
        </div>
      )}
      {mode === 'skip' && (
        <div className="pdmp-actions">
          <input autoFocus aria-label="Why the PDMP check is skipped" placeholder="Why, e.g. state PDMP down; 3-day supply" value={skip} onChange={(e) => onSkip(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onSkip(''); setMode(null); } }} style={{ flex: 1, minWidth: 240 }} />
          <span className="muted" style={{ fontSize: 12 }}>{skip.trim().length >= 5 ? 'Kept with the prescription.' : 'A few words, kept with the prescription.'}</span>
        </div>
      )}
    </div>
  );
}
