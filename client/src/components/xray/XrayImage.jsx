import { useEffect, useState } from 'react';
import { getToken } from '../../api.js';
import { AI_COLOR, pct } from './kinds.js';
import './xray.css';

// An x-ray with AI finding boxes over it (boxes are fractions of the image, so they scale with it). Used by the
// review list's preview and the chair screen. `findings` are exactly what may be shown here — the chair screen
// passes only accepted ones. Suggestions are dashed, accepted solid.
export default function XrayImage({ documentId, findings = [], showConfidence = false, highlight = null, label = (f) => f.label, alt = 'X-ray' }) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let url = null;
    let alive = true;
    setSrc(null);
    setError(null);
    fetch(`/api/documents/${documentId}/image`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load the image');
        url = URL.createObjectURL(await res.blob());
        if (alive) setSrc(url);
      })
      .catch((e) => alive && setError(e));
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [documentId]);
  if (error) return <div className="xr-image"><div className="xr-loading">{error.message}</div></div>;
  if (!src) return <div className="xr-image"><div className="xr-loading">Loading image…</div></div>;
  const boxed = findings.filter((f) => Array.isArray(f.box));
  return (
    <div className="xr-image">
      <img src={src} alt={alt} />
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {boxed.map((f) => (
          <rect
            key={f.id ?? `${f.kind}-${f.tooth}`} x={f.box[0] * 100} y={f.box[1] * 100} width={f.box[2] * 100} height={f.box[3] * 100} fill="none"
            stroke={AI_COLOR[f.kind] || '#fff'} strokeWidth={highlight === f.id ? 3 : 1.6} vectorEffect="non-scaling-stroke"
            strokeDasharray={f.status && f.status !== 'accepted' ? '6 4' : undefined}
          />
        ))}
      </svg>
      {boxed.map((f) => (
        <span key={`t${f.id ?? `${f.kind}-${f.tooth}`}`} className="xr-tag" style={{ left: `${f.box[0] * 100}%`, top: `${f.box[1] * 100}%`, background: AI_COLOR[f.kind] || '#fff' }}>
          {label(f)}{showConfidence && f.confidence != null ? ` · ${pct(f.confidence)}` : ''}
        </span>
      ))}
    </div>
  );
}
