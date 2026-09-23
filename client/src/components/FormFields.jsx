import SignaturePad from './SignaturePad.jsx';
import { useT } from '../pages/public/i18n.js';

// Photos are shrunk in the browser before upload (phone cameras take 5–12 MB pictures).
async function shrink(file, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Renders a practice form's fields for the patient to fill in (also used for the preview in Settings).
export default function FormFields({ fields, answers, onChange, signatureName, onSignatureName, preview = false }) {
  const t = useT();
  const set = (k, v) => onChange({ ...answers, [k]: v });
  const req = (f) => (f.required ? <span style={{ color: 'var(--danger)' }}> *</span> : null);
  return (
    <div className="form-fields">
      {fields.map((f, i) => {
        const key = f.key || `static${i}`;
        switch (f.type) {
          case 'heading':
            return <h2 key={key} style={{ marginTop: 18 }}>{f.label}</h2>;
          case 'paragraph':
            return <p key={key} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{f.text}</p>;
          case 'checkbox':
            return (
              <label key={key} className="checkbox" style={{ color: 'var(--text)', fontSize: 14, margin: '8px 0', alignItems: 'flex-start' }}>
                <input type="checkbox" checked={!!answers[f.key]} onChange={(e) => set(f.key, e.target.checked)} style={{ marginTop: 3 }} /> <span>{f.label}{req(f)}</span>
              </label>
            );
          case 'yesno':
            return (
              <div key={key} style={{ margin: '10px 0' }}>
                <div style={{ fontSize: 14, marginBottom: 4 }}>{f.label}{req(f)}</div>
                <div className="inline" style={{ gap: 16 }}>
                  {['yes', 'no'].map((v) => (
                    <label key={v} className="checkbox" style={{ color: 'var(--text)' }}>
                      <input type="radio" name={`${key}-${preview ? 'p' : 'f'}`} checked={answers[f.key] === v} onChange={() => set(f.key, v)} /> {v === 'yes' ? t('Yes') : t('No')}
                    </label>
                  ))}
                </div>
              </div>
            );
          case 'select':
            return (
              <label key={key} style={{ margin: '10px 0' }}>
                <span>{f.label}{req(f)}</span>
                <select value={answers[f.key] || ''} onChange={(e) => set(f.key, e.target.value)}>
                  <option value="">{t('Choose…')}</option>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            );
          case 'initials':
            return (
              <div key={key} className="inline" style={{ margin: '10px 0', gap: 10, alignItems: 'center' }}>
                <input style={{ width: 70, textAlign: 'center', textTransform: 'uppercase' }} maxLength={4} aria-label={`${t('Initials')}: ${f.label}`} value={answers[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} placeholder={t('Initials')} />
                <span style={{ fontSize: 14 }}>{f.label}{req(f)}</span>
              </div>
            );
          case 'signature':
            return (
              <div key={key} style={{ margin: '14px 0' }}>
                <div style={{ fontSize: 14, marginBottom: 4 }}>{f.label}{req(f)}</div>
                {preview ? <div className="signature-pad" style={{ display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>{t('Signature')}</div> : <SignaturePad onChange={(v) => set(f.key, v)} />}
                {onSignatureName && (
                  <label style={{ marginTop: 10 }}>{t('Type your full legal name')}<input value={signatureName} onChange={(e) => onSignatureName(e.target.value)} autoComplete="name" /></label>
                )}
              </div>
            );
          case 'photo':
            return (
              <div key={key} style={{ margin: '12px 0' }}>
                <div style={{ fontSize: 14, marginBottom: 4 }}>{f.label}{req(f)}</div>
                {answers[f.key] && <img src={answers[f.key]} alt={f.label} style={{ maxWidth: 260, maxHeight: 170, borderRadius: 8, border: '1px solid var(--border)', display: 'block', marginBottom: 6 }} />}
                <input type="file" accept="image/*" capture="environment" disabled={preview}
                  onChange={async (e) => { const file = e.target.files?.[0]; if (file) set(f.key, await shrink(file)); }} />
              </div>
            );
          default:
            return (
              <label key={key} style={{ margin: '10px 0' }}>
                <span>{f.label}{req(f)}</span>
                {f.type === 'textarea'
                  ? <textarea rows={3} value={answers[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} />
                  : <input type={f.type === 'date' ? 'date' : 'text'} value={answers[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} />}
              </label>
            );
        }
      })}
    </div>
  );
}

// True when every required field has an answer.
export function formComplete(fields, answers, signatureName) {
  return fields.every((f) => !f.required || (answers[f.key] != null && answers[f.key] !== '' && answers[f.key] !== false))
    && (!fields.some((f) => f.type === 'signature' && f.required) || !!signatureName?.trim());
}
