import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';

// Opened from the QR code in the office: photos taken here go straight into the patient's chart.
export default function PhoneUpload() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/public/upload/${token}`).then(setInfo).catch(setError); }, [token]);
  const upload = async (files) => {
    setBusy(true);
    setError(null);
    for (const f of files) {
      try {
        const res = await fetch(`/api/public/upload/${token}?filename=${encodeURIComponent(f.name || 'photo.jpg')}`, { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
        setSent((s) => [...s, f.name || 'photo']);
      } catch (e) { setError(e); }
    }
    setBusy(false);
  };
  if (!info) return <PublicLayout title="Add to chart">{error ? <ErrorBox error={error} /> : <div className="empty">Loading…</div>}</PublicLayout>;
  return (
    <PublicLayout title={`Add to ${info.patient}'s chart`} practice={{ name: info.practice }}>
      <div className="card" style={{ textAlign: 'center' }}>
        <p>Photos and scans go straight into the chart at {info.practice}.</p>
        <label className="phone-upload primary">
          📷 Take a photo
          <input type="file" accept="image/*" capture="environment" disabled={busy} onChange={(e) => upload([...e.target.files])} />
        </label>
        <label className="phone-upload">
          Choose files
          <input type="file" accept="image/*,application/pdf" multiple disabled={busy} onChange={(e) => upload([...e.target.files])} />
        </label>
        {busy && <p className="muted">Sending…</p>}
        <ErrorBox error={error} />
        {sent.length > 0 && <div className="public-notice ok">✓ {sent.length} added: {sent.join(', ')}</div>}
      </div>
    </PublicLayout>
  );
}
