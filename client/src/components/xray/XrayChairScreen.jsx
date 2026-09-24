import { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../../api.js';
import { fmtDate } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import XrayImage from './XrayImage.jsx';
import { AI_COLOR } from './kinds.js';
import './xray.css';

// XR3: the chair screen turned to the patient. Their x-rays with only what the dentist confirmed — never the AI's
// suggestions, dismissed findings or scores — in plain words. ← → change image, Esc gives the screen back.
// Opening it is recorded on the server (xray_ai.chair_view).
export default function XrayChairScreen({ patientId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [i, setI] = useState(0);
  useEffect(() => { api.get(`/patients/${patientId}/xray-chair`).then(setData).catch(setError); }, [patientId]);
  const count = data?.images.length || 0;
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && count) setI((n) => (n + 1) % count);
      if (e.key === 'ArrowLeft' && count) setI((n) => (n - 1 + count) % count);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, count]);
  const img = data?.images[i];
  return (
    <div className="xr-chair" role="dialog" aria-label="Your x-rays">
      <button type="button" className="small xr-chair-close" onClick={onClose} aria-label="Close (Esc)"><X size={18} /> <kbd>Esc</kbd></button>
      <div>
        <h1>{data?.first_name ? `${data.first_name}, here’s what your x-rays show` : 'Your x-rays'}</h1>
        <p>{data?.note || ''}</p>
      </div>
      <ErrorBox error={error} />
      {data && !count && <p>There’s nothing marked on your x-rays yet.</p>}
      {img && (
        <div className="xr-chair-main">
          <div>
            <XrayImage documentId={img.document_id} findings={img.findings} label={(f) => (f.tooth ? `Tooth ${f.tooth}` : f.label)} alt={`X-ray from ${fmtDate(img.image_date)}`} />
            {count > 1 && (
              <div className="xr-chair-nav" style={{ marginTop: 8 }}>
                <button type="button" className="small" onClick={() => setI((i - 1 + count) % count)} aria-label="Previous image"><ChevronLeft size={16} /></button>
                Image {i + 1} of {count}
                <button type="button" className="small" onClick={() => setI((i + 1) % count)} aria-label="Next image"><ChevronRight size={16} /></button>
              </div>
            )}
          </div>
          <div>
            <p style={{ fontSize: 14, marginBottom: 8 }}>X-ray from {fmtDate(img.image_date)}</p>
            <ul className="xr-chair-list">
              {img.findings.map((f) => (
                <li key={f.id}><i style={{ background: AI_COLOR[f.kind] }} /><span>{f.label}{f.where && <small>{f.where}{f.measurement_mm ? ` · ${f.measurement_mm} mm` : ''}</small>}</span></li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
