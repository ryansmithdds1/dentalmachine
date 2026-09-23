import { useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../api.js';
import { ErrorBox } from './ui.jsx';

// Sends a PDF or picture to be read by AI and hands back what came out. Nothing is saved until a person does.
export const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

export default function AiFileRead({ path, label, hint, onRead }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      onRead(await api.post(path, { file_base64: await toBase64(file), mime: file.type }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" style={{ marginBottom: 12, background: 'var(--surface-2, transparent)' }}>
      <ErrorBox error={error} />
      <div className="inline" style={{ justifyContent: 'space-between', gap: 12 }}>
        <span className="muted" style={{ fontSize: 13 }}>{hint}</span>
        <button type="button" className="small" disabled={busy} onClick={() => input.current?.click()}>
          <Sparkles size={14} /> {busy ? 'Reading…' : label}
        </button>
      </div>
      <input ref={input} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" hidden onChange={pick} />
    </div>
  );
}
