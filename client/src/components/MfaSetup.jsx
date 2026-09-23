import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api.js';
import { ErrorBox, useSubmit } from './ui.jsx';

// Enrols the signed-in user in authenticator-app 2FA: scan QR, then confirm with a code.
export default function MfaSetup({ onDone }) {
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState(null);
  const [code, setCode] = useState('');
  const start = useSubmit(async () => {
    const s = await api.post('/auth/mfa/setup');
    setSetup(s);
    setQr(await QRCode.toDataURL(s.otpauth_url, { margin: 1, width: 200 }));
  });
  const confirm = useSubmit(async () => {
    await api.post('/auth/mfa/enable', { code });
    onDone?.();
  });
  const started = useRef(false);
  useEffect(() => {
    // Guard against StrictMode's double effect: each setup call issues a new secret.
    if (started.current) return;
    started.current = true;
    start.submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <ErrorBox error={start.error || confirm.error} />
      {setup && (
        <>
          <ol style={{ paddingLeft: 18, lineHeight: 1.6 }}>
            <li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</li>
            <li>Scan this QR code, or enter the key manually.</li>
            <li>Type the 6-digit code it shows.</li>
          </ol>
          <div style={{ textAlign: 'center' }}>
            {qr && <img src={qr} alt="Authenticator QR code" width={200} height={200} />}
            <div className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>Key: <code>{setup.secret.match(/.{1,4}/g).join(' ')}</code></div>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); confirm.submit(); }} className="inline" style={{ marginTop: 14 }}>
            <input inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} required style={{ width: 140 }} />
            <button className="primary" disabled={confirm.busy}>Verify & turn on</button>
          </form>
        </>
      )}
    </div>
  );
}
