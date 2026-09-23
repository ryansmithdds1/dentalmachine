import { useEffect, useState } from 'react';
import { useAuth, takeSsoError } from '../auth.jsx';
import { api } from '../api.js';
import { ErrorBox, useSubmit } from '../components/ui.jsx';

export default function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', practice_name: '', mfa_code: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const [needsCode, setNeedsCode] = useState(false);
  const [sso, setSso] = useState(null);
  const [ssoError] = useState(takeSsoError);
  // Offer single sign-on as soon as we know the email belongs to a practice that uses it.
  useEffect(() => {
    if (mode !== 'login' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) return setSso(null);
    const t = setTimeout(() => api.get(`/auth/sso/lookup?email=${encodeURIComponent(form.email)}`).then((r) => setSso(r.sso ? r : null)).catch(() => setSso(null)), 350);
    return () => clearTimeout(t);
  }, [form.email, mode]);
  const startSso = () => { window.location.href = `/api/auth/sso/start?email=${encodeURIComponent(form.email)}`; };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    if (mode !== 'login') return register(form);
    try {
      await login(form.email, form.password, form.mfa_code);
    } catch (e) {
      if (e.details?.mfa_required) {
        // First prompt for the code is expected, not an error.
        if (!needsCode) return setNeedsCode(true);
      }
      throw e;
    }
  });

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <h1>🦷 Dental Machine</h1>
        <div className="muted">{mode === 'login' ? 'Sign in to your practice' : 'Create your practice account'}</div>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <ErrorBox error={error || (ssoError ? new Error(ssoError) : null)} />
          {mode === 'register' && (
            <>
              <label>Practice name<input required value={form.practice_name} onChange={set('practice_name')} /></label>
              <label>Your name<input required value={form.name} onChange={set('name')} /></label>
            </>
          )}
          <label>Email<input type="email" required autoComplete="username" value={form.email} onChange={set('email')} /></label>
          {sso && (
            <button type="button" className="primary sso-button" onClick={startSso}>
              {{ google: 'G', microsoft: '⊞' }[sso.provider] || '🔑'} Sign in with {sso.name}
            </button>
          )}
          {sso?.required ? <p className="muted" style={{ fontSize: 13, margin: 0 }}>Your practice signs in with {sso.name}.</p> : (
            <label>
              Password
              <input type="password" required minLength={mode === 'register' ? 10 : undefined} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={set('password')} />
            </label>
          )}
          {needsCode && mode === 'login' && (
            <label>
              Authentication code
              <input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" placeholder="123 456" required value={form.mfa_code} onChange={set('mfa_code')} />
            </label>
          )}
          {!sso?.required && (
            <button className={sso ? '' : 'primary'} disabled={busy} style={{ justifyContent: 'center' }}>
              {busy ? 'Please wait…' : mode === 'login' ? (sso ? 'Sign in with password' : 'Sign in') : 'Create practice'}
            </button>
          )}
        </form>
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          {mode === 'login' ? (
            <button className="link" onClick={() => setMode('register')}>New practice? Create an account</button>
          ) : (
            <button className="link" onClick={() => setMode('login')}>Already have an account? Sign in</button>
          )}
        </div>
      </div>
    </div>
  );
}
